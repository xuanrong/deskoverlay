//! 定时任务调度器（「定时任务」模块的后端）。
//!
//! ## 职责边界
//! - **任务定义**由前端持有并写入 state.json（`scheduler.tasks`），Rust 每轮 tick 直接读该文件，
//!   任务表只有一份真相。
//! - **运行历史 / 下次触发时刻**由 Rust 独占写入 `scheduler-store.json`。历史含完整输出，
//!   体量与 state.json（前端整份重写）差异太大，混在一起会让前端每次保存都搬运历史。
//!
//! ## 双引擎（用户可选）
//! 1. **面板内调度**：本文件的后台线程，20s 一轮 tick。要求 deskoverlay 正在运行。
//! 2. **系统计划任务**：`scheduler_export_task` 用 schtasks 把任务注册进 Windows 计划任务，
//!    app 关着也能触发。注意其触发**不经过本进程**，因此不会写进面板历史 —— UI 需明确标注。
//!
//! ## 执行约定
//! - 命令类任务统一经 `cmd /C` 执行（用户可直接粘贴 `python a.py` 这类命令行），
//!   并置 `CREATE_NO_WINDOW`，否则每跑一次脚本都会闪出黑色控制台窗口。
//! - 超时/取消走 `taskkill /PID <pid> /T /F` 整棵进程树终止：只 kill 直接子进程会留下
//!   仍在运行的 python/node 孙进程（cmd /C 会再套一层）。
//! - 命令行**必须用 `raw_arg` 原样拼接**（见 `spawn_shell`）：`Command::arg()` 会按 MSVCRT
//!   规则把内部引号转义成 `\"`，而 cmd.exe 不认这种转义。
//! - 子进程输出**不能假定是 UTF-8**（见 `OutDecoder`）：cmd 自身报错与 python 默认输出
//!   在简中 Windows 上都是 GBK。

use std::collections::HashMap;
use std::io::Read;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

/// tick 间隔。cron 最小粒度是分钟，20s 足以在分钟内命中且开销可忽略。
const TICK: Duration = Duration::from_secs(20);
/// 历史保留条数上限（全局，非每任务），避免无限增长。
const MAX_RUNS: usize = 300;
/// 单次运行输出落盘上限（字符）。
const MAX_OUTPUT: usize = 60_000;
/// 运行期间内存累积上限（落盘上限的 2 倍）。
const OUT_CAP: usize = MAX_OUTPUT * 2;
/// 输出超限后追加的提示。
const OUT_CLIPPED: &str = "\n…（输出超过上限，后续内容已丢弃）";
/// 单条实时日志事件的分片上限。
const CHUNK: usize = 8_000;
/// 错过执行的补跑窗口：超过该时长不再补跑（避免开机后突然涌出一堆过期任务）。
const CATCHUP_WINDOW_MS: i64 = 6 * 60 * 60 * 1000;
/// Windows CREATE_NO_WINDOW：GUI 子系统进程里跑控制台程序不弹窗。
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

// ============================ 任务模型 ============================

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskDef {
    pub id: String,
    #[serde(default)]
    pub name: String,
    /// 总开关：关闭后既不参与调度，也不能在面板里手动运行（UI 会置灰）。
    #[serde(default = "yes")]
    pub enabled: bool,
    /// 是否参与「面板内调度」。与「系统计划任务」相互独立：
    /// 由系统计划任务触发的任务应关掉此项，否则同一时刻会被两个引擎各触发一次。
    #[serde(default = "yes")]
    pub schedule_enabled: bool,
    #[serde(default)]
    pub cron: String,
    /// "command" | "http"
    #[serde(default)]
    pub kind: String,
    /// 命令类：整条命令行，经 cmd /C 执行。
    #[serde(default)]
    pub command: String,
    #[serde(default)]
    pub cwd: String,
    /// HTTP 类
    #[serde(default = "get")]
    pub method: String,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    #[serde(default)]
    pub body: String,
    /// 响应体需包含的关键字（空则只看状态码），用于校验接口是否真的签到成功。
    #[serde(default)]
    pub expect: String,
    #[serde(default = "default_timeout")]
    pub timeout_sec: u64,
    /// 失败重试次数（不含首次）。
    #[serde(default)]
    pub retry: u32,
    /// 子进程输出编码："auto" | "utf8" | "gbk"。默认 auto（自动判定）。
    /// GBK 与 UTF-8 在字节层面**存在真歧义**（见 OutDecoder 注释），
    /// 自动判定不可能 100% 正确，故留一个可显式指定的开关。
    #[serde(default = "default_out_enc")]
    pub output_encoding: String,
}

fn default_out_enc() -> String {
    "auto".into()
}

fn yes() -> bool {
    true
}
fn get() -> String {
    "GET".to_string()
}
fn default_timeout() -> u64 {
    300
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunRecord {
    pub run_id: String,
    pub task_id: String,
    pub name: String,
    /// "manual" | "cron" | "catchup"
    pub trigger: String,
    pub started_at: i64,
    pub duration_ms: i64,
    /// "success" | "failed" | "timeout" | "canceled"
    pub status: String,
    pub exit_code: Option<i32>,
    pub output: String,
}

/// 单日聚合：一天里跑了几次、各是什么结果。
///
/// `MAX_RUNS = 300` 是**全局**上限，一个月就会被写满，月初记录会被挤掉；
/// 按天聚合只存计数，容量与 `runs` 完全无关。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DayAgg {
    #[serde(default)]
    pub ok: u32,
    #[serde(default)]
    pub bad: u32,
    #[serde(default)]
    pub warn: u32,
    #[serde(default)]
    pub stop: u32,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Store {
    /// taskId -> 下次应触发时刻（ms）。持久化后可跨重启判断「错过了没有」。
    #[serde(default)]
    next_due: HashMap<String, i64>,
    /// 新→旧排列
    #[serde(default)]
    runs: Vec<RunRecord>,
    /// taskId -> "YYYY-MM-DD" -> 当日聚合。每个任务只保留最近 `DAY_KEEP` 天。
    #[serde(default)]
    daily: HashMap<String, HashMap<String, DayAgg>>,
}

struct RunCtl {
    task_id: String,
    name: String,
    trigger: String,
    started: Instant,
    started_at: i64,
    cancel: Arc<AtomicBool>,
    /// 子进程 pid：超时/取消时用于整棵树终止。
    pid: Mutex<Option<u32>>,
}

pub struct SchedulerState {
    runs: Mutex<HashMap<String, Arc<RunCtl>>>,
    store: Mutex<Store>,
    seq: AtomicU64,
}

impl SchedulerState {
    pub fn new() -> Self {
        Self {
            runs: Mutex::new(HashMap::new()),
            store: Mutex::new(Store::default()),
            seq: AtomicU64::new(1),
        }
    }
}

impl Default for SchedulerState {
    fn default() -> Self {
        Self::new()
    }
}

// ============================ 路径与读写 ============================

fn app_dir(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok()
}

fn store_path(app: &AppHandle) -> Option<PathBuf> {
    app_dir(app).map(|d| d.join("scheduler-store.json"))
}

fn state_path(app: &AppHandle) -> Option<PathBuf> {
    app_dir(app).map(|d| d.join("state.json"))
}

fn read_store(app: &AppHandle) -> Store {
    store_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str::<Store>(&t).ok())
        .unwrap_or_default()
}

fn write_store(app: &AppHandle, st: &Store) {
    let Some(p) = store_path(app) else { return };
    if let Some(dir) = p.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(txt) = serde_json::to_string(st) {
        let _ = std::fs::write(p, txt);
    }
}

/// 读 state.json 里的 `scheduler.tasks`。读不到就当作「没有任务」，不报错
/// （首次启动、前端尚未落盘、或用户清空任务都属于正常情况）。
fn read_tasks(app: &AppHandle) -> Vec<TaskDef> {
    read_tasks_raw(app)
        .into_iter()
        // 单条任务结构不合法只跳过它，不让整份任务表失效
        .filter_map(|it| serde_json::from_value::<TaskDef>(it).ok())
        .collect()
}

/// 取 `scheduler.tasks` 的原始 JSON（导出模块需要保留完整字段，而不是被 TaskDef 裁剪过的）。
pub fn read_tasks_raw(app: &AppHandle) -> Vec<Value> {
    let Some(p) = state_path(app) else { return vec![] };
    let Ok(txt) = std::fs::read_to_string(p) else { return vec![] };
    let Ok(v) = serde_json::from_str::<Value>(&txt) else { return vec![] };
    v.get("scheduler")
        .and_then(|s| s.get("tasks"))
        .and_then(|t| t.as_array())
        .cloned()
        .unwrap_or_default()
}

/// 调度设置的默认值与合法区间。
const DEFAULT_MAX_CONCURRENT: usize = 2;
const MAX_CONCURRENT_RANGE: (usize, usize) = (1, 8);
const DEFAULT_CATCHUP: bool = true;

/// 读盘失败或字段缺失时的兜底设置。
fn default_settings() -> (usize, bool) {
    (DEFAULT_MAX_CONCURRENT, DEFAULT_CATCHUP)
}

/// 从已解析的 state.json 取调度设置。
fn settings_from(v: &Value) -> (usize, bool) {
    let s = v.get("scheduler");
    let max = s
        .and_then(|x| x.get("maxConcurrent"))
        .and_then(|x| x.as_u64())
        .unwrap_or(DEFAULT_MAX_CONCURRENT as u64)
        .clamp(MAX_CONCURRENT_RANGE.0 as u64, MAX_CONCURRENT_RANGE.1 as u64) as usize;
    let catchup = s
        .and_then(|x| x.get("catchUp"))
        .and_then(|x| x.as_bool())
        .unwrap_or(DEFAULT_CATCHUP);
    (max, catchup)
}

/// 一轮 tick 需要的全部配置：任务表 + 设置。读盘一次、解析一次。
fn read_tick_config(app: &AppHandle) -> (Vec<TaskDef>, (usize, bool)) {
    let Some(p) = state_path(app) else { return (vec![], default_settings()) };
    let Ok(txt) = std::fs::read_to_string(p) else { return (vec![], default_settings()) };
    let Ok(v) = serde_json::from_str::<Value>(&txt) else { return (vec![], default_settings()) };
    let tasks = v
        .get("scheduler")
        .and_then(|s| s.get("tasks"))
        .and_then(|t| t.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|it| serde_json::from_value::<TaskDef>(it.clone()).ok())
                .collect()
        })
        .unwrap_or_default();
    (tasks, settings_from(&v))
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ============================ 按天聚合（热力图数据源） ============================

/// 每个任务保留的日历天数上限。整月热力图只需 ~40 天，留 120 天够跨月查看，
/// 单项数据量约 30 字节/天，长期运行也不会把 scheduler-store.json 撑大。
const DAY_KEEP: usize = 120;

/// 本地时区的「年-月-日」键。
/// 必须用**本地**日期：热力图的格子和用户看到的日历一致；用 UTC 会让东八区 08:00
/// 之前跑出来的记录落到前一天。
fn day_key(ms: i64) -> String {
    use chrono::{Local, TimeZone};
    match Local.timestamp_millis_opt(ms).single() {
        Some(d) => d.format("%Y-%m-%d").to_string(),
        None => String::new(),
    }
}

/// 把一次运行计入当日聚合。状态口径与前端 `STATUS_META` 一致：
/// success / failed / timeout，其余（canceled）归入 stop。
fn bump_daily(daily: &mut HashMap<String, HashMap<String, DayAgg>>, rec: &RunRecord) {
    let key = day_key(rec.started_at);
    if key.is_empty() {
        return;
    }
    let e = daily
        .entry(rec.task_id.clone())
        .or_default()
        .entry(key)
        .or_default();
    match rec.status.as_str() {
        "success" => e.ok += 1,
        "failed" => e.bad += 1,
        "timeout" => e.warn += 1,
        _ => e.stop += 1,
    }
}

/// 每个任务只保留最近 `DAY_KEEP` 天。日期键的字典序即时间序，故升序排序后掐头。
fn prune_daily(daily: &mut HashMap<String, HashMap<String, DayAgg>>) {
    for map in daily.values_mut() {
        if map.len() <= DAY_KEEP {
            continue;
        }
        let mut keys: Vec<String> = map.keys().cloned().collect();
        keys.sort();
        for k in &keys[..keys.len() - DAY_KEEP] {
            map.remove(k);
        }
    }
}

/// 截断到字符边界，避免把多字节 UTF-8 切坏。
fn clip(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut end = max;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n…（输出过长已截断，共 {} 字符）", &s[..end], s.len())
}

// ============================ cron 求值 ============================

// 本模块对外（state.json / 前端 UI / 导出）统一使用 **Unix 5 段** cron：
//
//     分 时 日 月 周        例：0 10 * * *   每天 10:00
//
// 与 crontab、青龙面板的习惯一致，也是用户唯一需要理解的形式。
//
// 但底层 `cron` crate 用的不是这套语法，两处差异必须由这里抹平：
//
//   1) 段数：crate 的 longhand 是「秒 分 时 日 月 周 [年]」，年可选 ⇒ **最少 6 段**。
//      （见 crate 自带用例 test_nom_invalid_schedule："* * * *" 非法、"* * * * * *" 合法。）
//      5 段因此永远解析失败 —— 这正是「0 10 * * * 显示表达式无效」的根因。
//   2) 星期序号：crate 按 chrono 的 `number_from_sunday()` 比较（schedule.rs），
//      取值范围 1~7 且 **1=周日 … 7=周六**；Unix 是 0=周日 … 6=周六（7 也作周日）。
//      直接补一段秒是不行的：`0 0 10 * * 1` 在两套口径里一个是周日一个是周一。
//
// 所以 5 段输入要「补 0 秒 + 星期序号重映射」；6/7 段输入视为用户刻意使用 crate 原生语法，原样透传。
// 两边的星期**名字**（sun/mon/…）指向同一天，故名字不做映射。

/// Unix 星期序号（0=周日…6=周六，7 亦作周日）→ cron crate 序号（1=周日…7=周六）。
fn unix_dow_to_crate(n: u32) -> u32 {
    n % 7 + 1
}

fn parse_dow_num(s: &str, whole: &str, what: &str) -> Result<u32, String> {
    let s = s.trim();
    if s.is_empty() || !s.chars().all(|c| c.is_ascii_digit()) {
        return Err(format!("星期字段「{whole}」的{what}「{s}」不是数字"));
    }
    let n: u32 = s.parse().map_err(|_| format!("星期字段「{whole}」的{what}「{s}」超出范围"))?;
    if n > 7 {
        return Err(format!(
            "星期字段「{whole}」的{what}「{n}」超出范围（0~7，其中 0 与 7 都表示周日）"
        ));
    }
    Ok(n)
}

/// 把 Unix 口径的「周」字段改写成 cron crate 口径。
///
/// - `*` / `?`：两套口径的隐含起点都是周日，`*/n` 结果一致 ⇒ 原样保留。
/// - 名字（sun/mon/monday…）：两边指向同一天 ⇒ 原样保留。
/// - 数字与数字区间：逐个重映射；区间一律**展开成逗号列表**，因为 Unix 允许 `5-7`
///   （周五~周日，跨越周末边界）而 crate 的区间要求左端点不大于右端点。
fn translate_dow(field: &str) -> Result<String, String> {
    let field = field.trim();
    if field.is_empty() {
        return Err("星期字段为空".to_string());
    }
    if field == "*" || field == "?" {
        return Ok(field.to_string());
    }
    let mut out: Vec<String> = Vec::new();
    let push = |v: String, out: &mut Vec<String>| {
        if !out.contains(&v) {
            out.push(v);
        }
    };
    for item in field.split(',') {
        let item = item.trim();
        if item.is_empty() {
            return Err("星期字段里有多余的逗号".to_string());
        }
        let (base, step) = match item.split_once('/') {
            Some((b, s)) => (b.trim(), Some(parse_dow_num(s, item, "步长")?)),
            None => (item, None),
        };
        if step == Some(0) {
            return Err(format!("星期字段「{item}」的步长不能为 0"));
        }
        // `*` / `?` / 名字：原样（必要时带上步长）
        if base == "*" || base == "?" || base.chars().all(|c| c.is_ascii_alphabetic()) {
            push(match step {
                Some(n) => format!("{base}/{n}"),
                None => base.to_string(),
            }, &mut out);
            continue;
        }
        if let Some((a, b)) = base.split_once('-') {
            let (na, nb) = (a.trim(), b.trim());
            // 名字区间（sun-fri）：两套口径的名字指向同一天，交给 crate
            let both_alpha = !na.is_empty()
                && !nb.is_empty()
                && na.chars().all(|c| c.is_ascii_alphabetic())
                && nb.chars().all(|c| c.is_ascii_alphabetic());
            if both_alpha {
                push(
                    match step {
                        Some(n) => format!("{na}-{nb}/{n}"),
                        None => format!("{na}-{nb}"),
                    },
                    &mut out,
                );
                continue;
            }
            let a = parse_dow_num(a, item, "区间起点")?;
            let b = parse_dow_num(b, item, "区间终点")?;
            let sv = step.unwrap_or(1);
            // b < a 视为回绕（如 6-1 = 周六、周日、周一）
            let end = if b < a { b + 7 } else { b };
            let mut cur = a;
            while cur <= end {
                push(unix_dow_to_crate(cur % 7).to_string(), &mut out);
                cur += sv;
            }
            continue;
        }
        let n = parse_dow_num(base, item, "值")?;
        push(match step {
            Some(sv) => format!("{}/{}", unix_dow_to_crate(n), sv),
            None => unix_dow_to_crate(n).to_string(),
        }, &mut out);
    }
    Ok(out.join(","))
}

/// 解析表达式为可求值的 `cron::Schedule`，失败时给出能直接照做的中文原因。
pub fn parse_schedule(expr: &str) -> Result<cron::Schedule, String> {
    let raw = expr.trim();
    if raw.is_empty() {
        return Err("表达式为空".to_string());
    }
    if raw.starts_with('@') {
        return raw.parse::<cron::Schedule>().map_err(|_| {
            format!("不支持的简写「{raw}」，可用：@hourly / @daily / @weekly / @monthly / @yearly")
        });
    }
    let f: Vec<&str> = raw.split_whitespace().collect();
    let normalized = match f.len() {
        5 => {
            let dow = translate_dow(f[4])?;
            format!("0 {} {} {} {} {}", f[0], f[1], f[2], f[3], dow)
        }
        // 秒开头的 crate 原生语法（星期 1=周日…7=周六），刻意支持以便写「每 30 秒」这类面板调不了的计划
        6 | 7 => raw.to_string(),
        n => {
            return Err(format!(
                "字段数应为 5（分 时 日 月 周），当前为 {n} 段；\
                 如需按秒调度可写 6 段（秒 分 时 日 月 周）"
            ))
        }
    };
    normalized.parse::<cron::Schedule>().map_err(|_| {
        format!(
            "解析失败「{raw}」；5 段含义为「分 时 日 月 周」，取值 分 0~59、时 0~23、日 1~31、月 1~12、周 0~7（0 与 7 均为周日）\
             ，支持 , 列表、- 区间、*/n 间隔与 sun…sat 名字"
        )
    })
}

/// 校验 cron 并返回下次触发时刻（ms），失败时返回可直接展示的原因。
pub fn next_due_after_checked(expr: &str, after_ms: i64) -> Result<i64, String> {
    use chrono::{Local, TimeZone};
    let sched = parse_schedule(expr)?;
    let after = Local
        .timestamp_millis_opt(after_ms)
        .single()
        .ok_or_else(|| "基准时间无法解析".to_string())?;
    sched
        .after(&after)
        .next()
        .map(|d| d.timestamp_millis())
        .ok_or_else(|| "表达式合法，但已没有未来的触发时刻（是否限定了过去的年份？）".to_string())
}

/// 校验 cron 并返回下次触发时刻（ms）。表达式非法时返回 None。
pub fn next_due_after(expr: &str, after_ms: i64) -> Option<i64> {
    next_due_after_checked(expr, after_ms).ok()
}

// 到期判定口径：「每分钟最多触发一次」。tick 为 20s，同一分钟不会重复触发——
// 触发后会把 next_due 推进到下一个未来时刻；而并发满时**不**推进，下轮继续尝试（触发不丢）。

// ============================ 输出解码 ============================
//
// 命令行工具的 stdout 编码在 Windows 上不可控，三种情况都会碰到：
//   1. cmd 自身的报错与内置命令（echo/dir/…）按**控制台输出代码页**编码，简中 = GBK(936)；
//   2. python 未设 PYTHONUTF8/PYTHONIOENCODING 时按 locale 编码输出（同样是 GBK）；
//   3. git / node / cargo / ripgrep 这类工具直接吐 UTF-8。
//
// ⚠️ **GBK 与 UTF-8 在字节层面存在真歧义**，不能靠「是不是合法 UTF-8」区分：
//   GBK 汉字里 lead 落在 C2–DF、trail 落在 80–BF 的那些字，字节本身就是合法 UTF-8 ——
//   例如「一」的 GBK 是 D2 BB，按 UTF-8 解得到 U+04BB（西里尔字母 һ），不报错、也不产生替换符。
// 策略：
//   - 只在**首个含非 ASCII 的块**上判定一次（此后黏住，避免同一流中途换编码）；
//   - 判定用「GBK 被误当 UTF-8 的落点特征」：合法 UTF-8 但字符全落在希腊/西里尔/希伯来/
//     常用标点等区段、且不含 CJK → 判为 GBK 误判；
//   - 任务可显式指定 `outputEncoding`，绕开启发式。

#[cfg(windows)]
#[link(name = "kernel32")]
extern "system" {
    /// 系统 OEM 代码页（控制台默认代码页）。简中 = 936。
    fn GetOEMCP() -> u32;
}

/// 把代码页映射到 encoding_rs 编码。
fn cp_to_encoding(cp: u32) -> &'static encoding_rs::Encoding {
    match cp {
        936 | 54936 => encoding_rs::GBK,
        950 => encoding_rs::BIG5,
        932 => encoding_rs::SHIFT_JIS,
        949 => encoding_rs::EUC_KR,
        65001 => encoding_rs::UTF_8,
        // 西文单字节代码页（437/850/1252…）：用单字节表兜底，至少不丢字节
        _ => encoding_rs::WINDOWS_1252,
    }
}

/// 系统 OEM 编码。非 Windows 平台没有「GBK 控制台」这回事，返回 UTF-8。
pub(crate) fn oem_encoding() -> &'static encoding_rs::Encoding {
    #[cfg(windows)]
    {
        let cp = unsafe { GetOEMCP() };
        cp_to_encoding(cp)
    }
    #[cfg(not(windows))]
    {
        encoding_rs::UTF_8
    }
}

/// 输出编码模式。`Auto` 走启发式，另两个是给用户绕开歧义的确定性出口。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum OutEncMode {
    Auto,
    Utf8,
    Oem,
}

/// 解析任务里的 `outputEncoding` 字段（未知值一律按 auto）。
pub(crate) fn parse_out_enc(s: &str) -> OutEncMode {
    match s.trim().to_ascii_lowercase().as_str() {
        "utf8" | "utf-8" => OutEncMode::Utf8,
        "gbk" | "oem" | "ansi" | "ansi-oem" => OutEncMode::Oem,
        _ => OutEncMode::Auto,
    }
}

/// GBK 汉字字节被误当 UTF-8 解时，落点集中在这些区段；中英工具正常输出里几乎不会出现。
fn has_gbk_misread_marks(s: &str) -> bool {
    let (mut susp, mut cjk) = (false, false);
    for c in s.chars() {
        match c as u32 {
            0x0370..=0x06FF
            | 0x2000..=0x206F
            | 0x20A0..=0x20BF
            | 0x2100..=0x214F
            | 0x2190..=0x22FF => susp = true,
            // 出现真正的汉字/假名/全角标点 → 更像真的 UTF-8（GBK 误判几乎不会落在这里）
            0x3000..=0x9FFF | 0xF900..=0xFAFF | 0xFF00..=0xFFEF => cjk = true,
            _ => {}
        }
    }
    susp && !cjk
}

/// 判定一段字节是 UTF-8 还是系统 OEM 编码（仅用于 Auto）。
fn sniff_is_utf8(bytes: &[u8]) -> bool {
    // 带 UTF-8 BOM 是最强信号（解码器会自行吃掉 BOM）
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return true;
    }
    match std::str::from_utf8(bytes) {
        // 不是合法 UTF-8 → 只能是 OEM
        Err(_) => false,
        // 合法但带「GBK 被误判」的特征 → 判为 OEM
        Ok(s) => !has_gbk_misread_marks(s),
    }
}

/// 按编码模式取编码。
fn enc_for(mode: OutEncMode, probe: &[u8]) -> &'static encoding_rs::Encoding {
    match mode {
        OutEncMode::Utf8 => encoding_rs::UTF_8,
        OutEncMode::Oem => oem_encoding(),
        OutEncMode::Auto => {
            if sniff_is_utf8(probe) {
                encoding_rs::UTF_8
            } else {
                oem_encoding()
            }
        }
    }
}

/// 把 src 全部喂进解码器并追加到 out。
/// `decode_to_string` 在目标容量不足时会返回 OutputFull 且只消费一部分，必须循环 + 扩容。
/// （返回三元组是 (结果, 已消费字节数, 是否发生过替换)，注意不是四元组。）
fn decode_into(d: &mut encoding_rs::Decoder, src: &[u8], out: &mut String, last: bool) {
    let mut off = 0usize;
    let mut guard = 0u32;
    while off < src.len() {
        let before = out.len();
        let (res, read, _replaced) = d.decode_to_string(&src[off..], out, last);
        off += read;
        if res == encoding_rs::CoderResult::InputEmpty {
            break;
        }
        // OutputFull：dst 无剩余容量 → 扩容后重试
        if out.len() == before {
            out.reserve(src.len() * 3 + 32);
        }
        guard += 1;
        if guard > 64 {
            break; // 理论不可达，纯防死循环
        }
    }
}

/// 一次性解码整块字节（读日志文件、schtasks 输出等）。规则同 `OutDecoder`。
pub(crate) fn decode_bytes(bytes: &[u8], mode: OutEncMode) -> String {
    if bytes.is_empty() {
        return String::new();
    }
    let enc = enc_for(mode, bytes);
    let mut d = enc.new_decoder();
    let mut out = String::with_capacity(bytes.len() * 2 + 16);
    decode_into(&mut d, bytes, &mut out, true);
    out
}

/// 流式解码器：管道是分块读的，必须处理「多字节字符被切在两块之间」。
pub(crate) struct OutDecoder {
    mode: OutEncMode,
    /// 已判定/已指定的编码。None = 尚未判定（Auto 且还没见到非 ASCII）
    enc: Option<&'static encoding_rs::Encoding>,
    dec: Option<encoding_rs::Decoder>,
    /// 判定前缓存的探测字节；判定后仅用于暂存「结尾被切断的半个字符」
    probe: Vec<u8>,
}

/// probe 一直无法判定时的兜底上限（理论上一块里只要有非法字节就能立刻判定）。
const MAX_PROBE: usize = 64 * 1024;

impl OutDecoder {
    pub fn new(mode: OutEncMode) -> Self {
        let mut me = Self { mode, enc: None, dec: None, probe: Vec::new() };
        if mode != OutEncMode::Auto {
            let enc = enc_for(mode, &[]);
            me.enc = Some(enc);
            me.dec = Some(enc.new_decoder());
        }
        me
    }

    /// 喂入一块字节，返回当前可安全输出的文本（可能为空：结尾不完整时需等下一块）。
    pub fn push(&mut self, bytes: &[u8]) -> String {
        if self.enc.is_some() {
            return self.feed(bytes);
        }
        self.probe.extend_from_slice(bytes);
        // 全 ASCII：任何编码下结果一致，直接用，不必等判定
        if self.probe.is_ascii() {
            let s = String::from_utf8_lossy(&self.probe).into_owned();
            self.probe.clear();
            return s;
        }
        // 结尾可能是被切断的多字节序列：先留着，下一块拼齐再判（否则会把 UTF-8 误判成 OEM）
        let head = match std::str::from_utf8(&self.probe) {
            Ok(_) => self.probe.len(),
            Err(e) if e.error_len().is_none() => e.valid_up_to(),
            Err(_) => self.probe.len(),
        };
        if head == 0 && self.probe.len() < MAX_PROBE {
            return String::new(); // 等更多字节
        }
        let head_bytes: Vec<u8> = self.probe.drain(..head).collect(); // 剩余尾巴留在 probe
        let enc = enc_for(self.mode, &head_bytes);
        self.enc = Some(enc);
        let mut d = enc.new_decoder();
        let mut out = String::with_capacity(head_bytes.len() * 2 + 16);
        decode_into(&mut d, &head_bytes, &mut out, false);
        self.dec = Some(d);
        out
    }

    /// 流结束：把残留字节按已定编码解出来（Auto 且从未判定的残留，按 OEM 解）。
    pub fn finish(&mut self) -> String {
        let mut out = String::new();
        match (self.enc, self.dec.as_mut()) {
            (Some(_), Some(d)) => {
                let tail = std::mem::take(&mut self.probe);
                if !tail.is_empty() {
                    decode_into(d, &tail, &mut out, true);
                }
            }
            _ => {
                if !self.probe.is_empty() {
                    let tail = std::mem::take(&mut self.probe);
                    out.push_str(&decode_bytes(&tail, self.mode));
                }
            }
        }
        out
    }

    /// 已判定后的常规喂入：先把上一块留下的半个字符补上，再接新块。
    fn feed(&mut self, bytes: &[u8]) -> String {
        let mut out = String::new();
        let leftover = std::mem::take(&mut self.probe);
        if let Some(d) = self.dec.as_mut() {
            if !leftover.is_empty() {
                decode_into(d, &leftover, &mut out, false);
            }
            decode_into(d, bytes, &mut out, false);
        }
        out
    }
}

// ============================ 执行 ============================

/// 启动一棵可整体终止的进程树（cmd /C + 无窗口 + 管道），返回子进程。
#[cfg(windows)]
fn spawn_shell(cmdline: &str, cwd: &str) -> Result<Child, String> {
    use std::os::windows::process::CommandExt;
    let mut c = Command::new("cmd");
    // 这里**必须** raw_arg：`Command::arg()` 会在拼接命令行时按 MSVCRT 规则
    // 把参数里的 `"` 转义成 `\"`，而 cmd.exe 不认这种转义 —— 结果第一个 token 变成
    // `\"C:\path\x.exe\"`（带字面反斜杠），cmd 直接报「不是内部或外部命令」。
    // raw_arg 原样追加；再套一层 `/S /C "…"`：/S 让 cmd 只剥掉这最后一对外层引号、
    // 其余原样交给自己解析，从而与命令内部自带的引号互不干扰（python subprocess shell=True 同款写法）。
    c.raw_arg(format!("/S /C \"{cmdline}\""));
    if !cwd.trim().is_empty() {
        c.current_dir(cwd);
    }
    c.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(CREATE_NO_WINDOW);
    c.spawn().map_err(|e| format!("启动失败：{e}"))
}

#[cfg(not(windows))]
fn spawn_shell(cmdline: &str, cwd: &str) -> Result<Child, String> {
    let mut c = Command::new("sh");
    c.arg("-c").arg(cmdline);
    if !cwd.trim().is_empty() {
        c.current_dir(cwd);
    }
    c.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    c.spawn().map_err(|e| format!("启动失败：{e}"))
}

/// 整棵进程树终止。只 kill 直接子进程会留下仍在跑的孙进程（cmd /C 会再套一层 python/node）。
fn kill_tree(pid: u32, child: &mut Child) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(CREATE_NO_WINDOW)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    let _ = child.kill();
}

/// HTTP 任务：走 ureq（与 http_get 同一条通道）。返回 (是否成功, 输出文本)。
fn run_http(t: &TaskDef) -> (bool, String) {
    let url = t.url.trim();
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return (false, format!("URL 非法：{url}（仅支持 http/https）"));
    }
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(t.timeout_sec.clamp(1, 3600)))
        .build();
    let mut req = match t.method.to_uppercase().as_str() {
        "POST" => agent.post(url),
        "PUT" => agent.put(url),
        "DELETE" => agent.delete(url),
        "HEAD" => agent.head(url),
        _ => agent.get(url),
    };
    for (k, v) in &t.headers {
        // accept-encoding 交给 ureq 自行协商：手动透传 gzip 时它不做透明解压，
        // 响应会保持压缩字节导致后续按 UTF-8 解失败。
        if k.eq_ignore_ascii_case("accept-encoding") {
            continue;
        }
        req = req.set(k, v);
    }
    let resp = if t.body.trim().is_empty() {
        req.call()
    } else {
        req.send_string(&t.body)
    };
    // ureq 把 4xx/5xx 也当作 Err 返回，这里要拆出来看状态码，而不是一律当「请求失败」
    let resp = match resp {
        Ok(r) => r,
        Err(ureq::Error::Status(code, r)) => {
            let body = r.into_string().unwrap_or_default();
            let head = format!("HTTP {code}\n{}", clip(body.trim(), 2000));
            return (false, head);
        }
        Err(e) => return (false, format!("请求失败：{e}")),
    };
    let status = resp.status();
    let body = resp.into_string().unwrap_or_default();
    let mut out = format!("HTTP {status}\n{}", clip(body.trim(), 4000));
    if status >= 400 {
        return (false, out);
    }
    let expect = t.expect.trim();
    if !expect.is_empty() && !body.contains(expect) {
        out.push_str(&format!("\n\n✗ 响应未包含预期关键字「{expect}」"));
        return (false, out);
    }
    (true, out)
}

/// 执行一次任务，返回 (状态, 退出码, 输出)。输出增量经 emit 实时回推。
fn execute(app: &AppHandle, run_id: &str, t: &TaskDef, ctl: &Arc<RunCtl>) -> (String, Option<i32>, String) {
    let emit_log = |stream: &str, text: &str| {
        for part in split_chunks(text, CHUNK) {
            let _ = app.emit(
                "scheduler://log",
                json!({ "runId": run_id, "taskId": t.id, "stream": stream, "text": part }),
            );
        }
    };

    // ---- HTTP 类：无流式输出，一次性给结果 ----
    if t.kind == "http" {
        let (ok, out) = run_http(t);
        emit_log("stdout", &out);
        return (
            if ok { "success".into() } else { "failed".into() },
            if ok { Some(0) } else { Some(1) },
            out,
        );
    }

    // ---- 命令类 ----
    let mut child = match spawn_shell(&t.command, &t.cwd) {
        Ok(c) => c,
        Err(e) => {
            emit_log("stderr", &e);
            return ("failed".into(), None, e);
        }
    };
    let pid = child.id();
    *ctl.pid.lock().expect("pid lock") = Some(pid);
    let out_enc = parse_out_enc(&t.output_encoding);

    // stdout / stderr 用各自的缓冲与读取线程：单线程顺序读两路会在其中一路阻塞时丢掉另一路
    let out_buf = Arc::new(Mutex::new(String::new()));
    let err_buf = Arc::new(Mutex::new(String::new()));
    let mut readers = Vec::new();
    if let Some(o) = child.stdout.take() {
        readers.push(spawn_reader(app, o, "stdout", &t.id, run_id, out_buf.clone(), out_enc));
    }
    if let Some(e) = child.stderr.take() {
        readers.push(spawn_reader(app, e, "stderr", &t.id, run_id, err_buf.clone(), out_enc));
    }

    let deadline = Instant::now() + Duration::from_secs(t.timeout_sec.clamp(1, 24 * 3600));
    let (mut status, mut code) = ("success".to_string(), None);
    loop {
        if ctl.cancel.load(Ordering::Relaxed) {
            kill_tree(pid, &mut child);
            status = "canceled".into();
            break;
        }
        if Instant::now() >= deadline {
            kill_tree(pid, &mut child);
            status = "timeout".into();
            break;
        }
        match child.try_wait() {
            Ok(Some(s)) => {
                code = s.code();
                // 被信号终止（Windows 上多为强杀）且非取消/超时路径 → 归为失败
                if !s.success() && code.is_none() {
                    status = "failed".into();
                } else if !s.success() {
                    status = "failed".into();
                }
                break;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(150)),
            Err(e) => {
                status = "failed".into();
                let _ = app.emit(
                    "scheduler://log",
                    json!({ "runId": run_id, "taskId": t.id, "stream": "stderr", "text": format!("等待进程失败：{e}") }),
                );
                break;
            }
        }
    }

    for r in readers {
        let _ = r.join();
    }
    let out = {
        // reader 已 join，直接取走缓冲内容，不再复制
        let a = std::mem::take(&mut *out_buf.lock().expect("out lock"));
        let b = std::mem::take(&mut *err_buf.lock().expect("err lock"));
        match (a.trim().is_empty(), b.trim().is_empty()) {
            (false, true) => a,
            (true, false) => b,
            (false, false) => format!("{a}\n{b}"),
            (true, true) => String::new(),
        }
    };
    if status == "timeout" {
        let _ = app.emit(
            "scheduler://log",
            json!({ "runId": run_id, "taskId": t.id, "stream": "stderr",
                    "text": format!("✗ 超过 {} 秒未结束，已终止进程树", t.timeout_sec) }),
        );
    }
    (status, code, out)
}

/// 按字符边界把文本切成若干片，供 emit。
fn split_chunks(s: &str, max: usize) -> Vec<String> {
    if s.is_empty() {
        return vec![];
    }
    let mut out = Vec::new();
    let mut cur = String::new();
    for ch in s.chars() {
        cur.push(ch);
        if cur.len() >= max {
            out.push(std::mem::take(&mut cur));
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

/// 读一路管道：边读边 emit 增量，同时累积进共享缓冲。
fn spawn_reader<R: Read + Send + 'static>(
    app: &AppHandle,
    mut r: R,
    stream: &'static str,
    task_id: &str,
    run_id: &str,
    sink: Arc<Mutex<String>>,
    mode: OutEncMode,
) -> std::thread::JoinHandle<()> {
    let app = app.clone();
    let task_id = task_id.to_string();
    let run_id = run_id.to_string();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        let mut dec = OutDecoder::new(mode);
        loop {
            match r.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let text = dec.push(&buf[..n]);
                    sink_and_emit(&app, &text, stream, &task_id, &run_id, &sink);
                }
            }
        }
        // 流末尾可能残留不足以判定编码的几个字节，冲出来别丢
        let tail = dec.finish();
        sink_and_emit(&app, &tail, stream, &task_id, &run_id, &sink);
    })
}

/// 已解码文本 → 累积进 sink + 分片 emit 实时事件。
fn sink_and_emit(
    app: &AppHandle,
    text: &str,
    stream: &'static str,
    task_id: &str,
    run_id: &str,
    sink: &Arc<Mutex<String>>,
) {
    if text.is_empty() {
        return;
    }
    if let Ok(mut s) = sink.lock() {
        if append_bounded(&mut s, text) {
            return; // 已截断，不再发事件
        }
    }
    for part in split_chunks(text, CHUNK) {
        let _ = app.emit(
            "scheduler://log",
            json!({ "runId": run_id, "taskId": task_id, "stream": stream, "text": part }),
        );
    }
}

/// 有界累积运行输出。返回 `true` 表示已截断（本次未写入，调用方应跳过这次事件）。
/// 封顶时把缓冲裁到一个 CHUNK 以内再追加 `OUT_CLIPPED`，此后以提示结尾判定已封顶。
fn append_bounded(sink: &mut String, text: &str) -> bool {
    if sink.ends_with(OUT_CLIPPED) {
        return true;
    }
    if sink.len() + text.len() <= OUT_CAP {
        sink.push_str(text);
        return false;
    }
    let keep = sink.len().saturating_sub(CHUNK);
    sink.truncate(sink.floor_char_boundary(keep));
    sink.push_str(OUT_CLIPPED);
    true
}

// ============================ 运行编排 ============================

/// 起一次运行（在独立线程里跑），立即返回 runId。
fn start_run(app: &AppHandle, st: &SchedulerState, t: &TaskDef, trigger: &str) -> String {
    let run_id = format!("run{}", st.seq.fetch_add(1, Ordering::Relaxed));
    let ctl = Arc::new(RunCtl {
        task_id: t.id.clone(),
        name: t.name.clone(),
        trigger: trigger.to_string(),
        started: Instant::now(),
        started_at: now_ms(),
        cancel: Arc::new(AtomicBool::new(false)),
        pid: Mutex::new(None),
    });
    st.runs.lock().expect("runs lock").insert(run_id.clone(), ctl.clone());

    let _ = app.emit(
        "scheduler://started",
        json!({
            "runId": run_id, "taskId": t.id, "name": t.name,
            "trigger": trigger, "startedAt": ctl.started_at,
        }),
    );

    let app2 = app.clone();
    let t2 = t.clone();
    let rid = run_id.clone();
    let ctl2 = ctl.clone();
    std::thread::spawn(move || {
        let handle: State<SchedulerState> = app2.state();
        let state: &SchedulerState = handle.inner();

        let mut attempt = 0u32;
        let (status, code, out) = loop {
            let (s, c, o) = execute(&app2, &rid, &t2, &ctl2);
            // 仅「失败」重试；超时/取消不重试（重试几乎必然再次超时，且用户已明确要停）
            if s == "failed" && attempt < t2.retry && !ctl2.cancel.load(Ordering::Relaxed) {
                attempt += 1;
                let _ = app2.emit(
                    "scheduler://log",
                    json!({ "runId": rid, "taskId": t2.id, "stream": "stderr",
                            "text": format!("— 第 {attempt}/{} 次重试 —", t2.retry) }),
                );
                continue;
            }
            break (s, c, o);
        };

        let dur = ctl2.started.elapsed().as_millis() as i64;
        let rec = RunRecord {
            run_id: rid.clone(),
            task_id: t2.id.clone(),
            name: t2.name.clone(),
            trigger: ctl2.trigger.clone(),
            started_at: ctl2.started_at,
            duration_ms: dur,
            status: status.clone(),
            exit_code: code,
            output: clip(&out, MAX_OUTPUT),
        };
        {
            let mut store = state.store.lock().expect("store lock");
            // 先累加再 move 进 runs（顺序不能反）
            bump_daily(&mut store.daily, &rec);
            store.runs.insert(0, rec);
            if store.runs.len() > MAX_RUNS {
                store.runs.truncate(MAX_RUNS);
            }
            prune_daily(&mut store.daily);
            write_store(&app2, &store);
        }
        state.runs.lock().expect("runs lock").remove(&rid);
        let _ = app2.emit(
            "scheduler://done",
            json!({
                "runId": rid, "taskId": t2.id, "name": t2.name,
                "status": status, "exitCode": code, "durationMs": dur,
            }),
        );
    });
    run_id
}

// ============================ tick 线程 ============================

pub fn start_scheduler(app: AppHandle) {
    {
        let st: State<SchedulerState> = app.state();
        let mut store = read_store(&app);
        // 老版本没有 `daily` 字段（升级上来的用户）→ 从现有 runs 回填一次，
        // 否则热力图要等好几天才画得出来。
        // ⚠ 回填只能覆盖 runs 还在的范围；更早的日子会显示成「无数据（斜纹）」——
        //   这是诚实的，**不要**用「未运行」冒充，那等于把残缺当完整。
        if store.daily.is_empty() && !store.runs.is_empty() {
            let hist = store.runs.clone();
            for rec in &hist {
                bump_daily(&mut store.daily, rec);
            }
            prune_daily(&mut store.daily);
            write_store(&app, &store);
        }
        *st.store.lock().expect("store lock") = store;
    }
    std::thread::spawn(move || {
        // 首轮允许补跑：上次运行期间错过的任务在这里被捡回来
        let mut first = true;
        loop {
            tick(&app, first);
            first = false;
            std::thread::sleep(TICK);
        }
    });
}

/// 记录下次触发时刻并落盘。
/// 必须在触发**之前**写入：若触发瞬间进程崩溃，重启后会因 next_due 仍指向过去而重复触发。
fn set_due(app: &AppHandle, st: &SchedulerState, task_id: &str, due: i64) {
    let mut s = st.store.lock().expect("store lock");
    s.next_due.insert(task_id.to_string(), due);
    write_store(app, &s);
}

fn tick(app: &AppHandle, allow_catchup: bool) {
    let (tasks, (max_conc, catchup_on)) = read_tick_config(app);
    if tasks.is_empty() {
        return;
    }
    let st: State<SchedulerState> = app.state();
    let state: &SchedulerState = st.inner();
    let now = now_ms();
    let tick_ms = TICK.as_millis() as i64;

    for t in &tasks {
        if !t.enabled || !t.schedule_enabled {
            continue;
        }
        let expr = t.cron.trim();
        if expr.is_empty() || next_due_after(expr, now).is_none() {
            continue; // 表达式非法：静默跳过，UI 侧做格式校验并给出提示
        }

        let due = {
            let s = state.store.lock().expect("store lock");
            s.next_due.get(&t.id).copied().unwrap_or(0)
        };

        // 首次见到该任务（或刚被重新启用）→ 只登记下次触发时刻，本轮不触发
        if due <= 0 {
            if let Some(n) = next_due_after(expr, now) {
                set_due(app, state, &t.id, n);
            }
            continue;
        }
        if now < due {
            continue;
        }

        // 迟到超过一个 tick 视为「错过」：只有启动首轮 + 全局开启补跑 + 未超出补跑窗口才执行
        let late = now - due;
        let catchup = late > tick_ms;
        if catchup && !(allow_catchup && catchup_on && late <= CATCHUP_WINDOW_MS) {
            // 不补跑也要把 next_due 推向未来，否则后续每轮都会判定为「已到期」
            if let Some(n) = next_due_after(expr, now) {
                set_due(app, state, &t.id, n);
            }
            continue;
        }

        // 并发已满：不推进 next_due，留到有空位的那一轮再触发（触发不丢）
        if state.runs.lock().expect("runs lock").len() >= max_conc {
            continue;
        }

        // 正常触发：从「本次应触发时刻」往后推；补跑则从当前时刻往后推，
        // 避免补跑瞬间又把历史积压的若干次全补出来。
        let anchor = if catchup { now } else { due };
        if let Some(n) = next_due_after(expr, anchor) {
            set_due(app, state, &t.id, n);
        }
        start_run(app, state, t, if catchup { "catchup" } else { "cron" });
    }
}

// ============================ 前端命令 ============================

#[tauri::command]
pub fn scheduler_runs(
    st: State<SchedulerState>,
    task_id: Option<String>,
    limit: Option<usize>,
) -> Vec<RunRecord> {
    let lim = limit.unwrap_or(50).min(MAX_RUNS);
    let s = st.store.lock().expect("store lock");
    // store 里已是新→旧排列，直接按序截取
    match task_id.as_deref() {
        Some(id) if !id.is_empty() => s.runs.iter().filter(|r| r.task_id == id).take(lim).cloned().collect(),
        _ => s.runs.iter().take(lim).cloned().collect(),
    }
}

/// 按天聚合的热力图数据：taskId -> "YYYY-MM-DD" -> 当日计数。
///
/// **不返回 `output`**：整月热力图只需要「哪天跑了几次、结果如何」，
/// 拼上每条最长 60KB 的输出会撑爆 IPC。
#[tauri::command]
pub fn scheduler_heat(st: State<SchedulerState>) -> HashMap<String, HashMap<String, DayAgg>> {
    let s = st.store.lock().expect("store lock");
    s.daily.clone()
}

#[tauri::command]
pub fn scheduler_run_now(app: AppHandle, st: State<SchedulerState>, task_id: String) -> Result<String, String> {
    let t = read_tasks(&app)
        .into_iter()
        .find(|x| x.id == task_id)
        .ok_or_else(|| format!("任务不存在：{task_id}"))?;
    if !t.enabled {
        return Err("该任务已停用，先启用再运行".to_string());
    }
    if t.kind == "command" && t.command.trim().is_empty() {
        return Err("命令为空".to_string());
    }
    if t.kind == "http" && t.url.trim().is_empty() {
        return Err("URL 为空".to_string());
    }
    Ok(start_run(&app, &st, &t, "manual"))
}

#[tauri::command]
pub fn scheduler_cancel(st: State<SchedulerState>, run_id: String) -> Result<bool, String> {
    let runs = st.runs.lock().expect("runs lock");
    let Some(ctl) = runs.get(&run_id) else {
        return Ok(false);
    };
    ctl.cancel.store(true, Ordering::Relaxed);
    // 取消后立刻把整棵进程树打掉，不必等下一轮 150ms 轮询（20s tick 更等不起）
    if let Some(pid) = *ctl.pid.lock().expect("pid lock") {
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            let _ = Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .creation_flags(CREATE_NO_WINDOW)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
        #[cfg(not(windows))]
        let _ = pid;
    }
    Ok(true)
}

#[tauri::command]
pub fn scheduler_clear_runs(app: AppHandle, st: State<SchedulerState>, task_id: Option<String>) -> Result<(), String> {
    let mut s = st.store.lock().expect("store lock");
    // 按天聚合必须与 runs 一起清，否则会留下点开无记录的颜色块
    match task_id.as_deref() {
        Some(id) if !id.is_empty() => {
            s.runs.retain(|r| r.task_id != id);
            s.daily.remove(id);
        }
        _ => {
            s.runs.clear();
            s.daily.clear();
        }
    }
    write_store(&app, &s);
    Ok(())
}

/// 从磁盘重新读一次 `scheduler-store.json`，覆盖内存副本。
///
/// ⛔ `SchedulerState.store` 是**常驻内存**的：`read_store()` 只在 `start_scheduler`
/// 启动时调用一次，此后 `write_store()` 会把**整份内存副本**回写磁盘（触发点：
/// `set_due()`、每次运行结束、`scheduler_clear_runs`）。
/// 故「备份与恢复」覆盖 `scheduler-store.json` 后，**必须在写完盘之后调用本命令** ——
/// 否则下一次 tick 会用内存里的数据把它静默写回（恢复看起来成功、实际被回滚）。
///
/// 返回 (运行记录条数, 有热力图数据的任务数)，便于前端提示恢复结果。
#[tauri::command]
pub fn scheduler_reload_store(app: AppHandle, st: State<SchedulerState>) -> Result<(usize, usize), String> {
    let fresh = read_store(&app);
    let runs = fresh.runs.len();
    let tasks = fresh.daily.len();
    {
        let mut s = st.store.lock().expect("store lock");
        *s = fresh;
    }
    Ok((runs, tasks))
}

#[tauri::command]
pub fn scheduler_status(app: AppHandle, st: State<SchedulerState>) -> Value {
    let running: Vec<Value> = st
        .runs
        .lock()
        .expect("runs lock")
        .iter()
        .map(|(rid, c)| {
            json!({
                "runId": rid, "taskId": c.task_id, "name": c.name,
                "trigger": c.trigger, "startedAt": c.started_at,
                "elapsedMs": c.started.elapsed().as_millis() as i64,
            })
        })
        .collect();
    let (tasks, (max_conc, catchup)) = read_tick_config(&app);
    let now = now_ms();
    // next_due 以 store 记录的为准（它就是调度真正依赖的值），
    // 尚未登记过的任务才现算一个，保证 UI 显示与后端行为一致。
    let recorded = st.store.lock().expect("store lock").next_due.clone();
    let next: HashMap<String, i64> = tasks
        .into_iter()
        .map(|t| {
            let n = recorded.get(&t.id).copied().filter(|v| *v > 0).unwrap_or_else(|| {
                if t.cron.trim().is_empty() {
                    0
                } else {
                    next_due_after(t.cron.trim(), now).unwrap_or(0)
                }
            });
            (t.id, n)
        })
        .collect();
    json!({ "running": running, "maxConcurrent": max_conc, "catchUp": catchup, "nextDue": next })
}

/// 校验 cron 并给出下次触发时刻（前端编辑器实时校验用）。
/// 失败时把真实原因原样回传。
#[tauri::command]
pub fn scheduler_check_cron(expr: String) -> Value {
    let now = now_ms();
    match next_due_after_checked(expr.trim(), now) {
        Ok(n) => json!({ "ok": true, "nextAt": n, "preview": preview_times(&expr, now, 3) }),
        Err(e) => json!({ "ok": false, "error": e }),
    }
}

/// 连续给出未来 n 个触发时刻，供 UI 预览「接下来会在什么时候跑」。
fn preview_times(expr: &str, from_ms: i64, n: usize) -> Vec<i64> {
    let mut out = Vec::new();
    let mut cur = from_ms;
    for _ in 0..n {
        match next_due_after(expr, cur) {
            Some(t) => {
                out.push(t);
                cur = t;
            }
            None => break,
        }
    }
    out
}

// ============================ 单测 ============================
//
// 用**真实 GBK 字节**（由 CPython 的 gbk 编码器产出，等同 cmd 在简中 Windows 上吐的字节）
// 验证解码判定。字节级歧义的样本见 `歧义样本_一_判为GBK`。
#[cfg(test)]
mod tests {
    // 用例名刻意用中文（读起来就是断言在说什么），故在本模块放行 non_snake_case
    #![allow(non_snake_case)]

    use super::*;

    /// cmd 的中文报错原文
    const TEXT: &str = r#""C:\x\pythonw.exe" 不是内部或外部命令，也不是可运行的程序"#;
    /// 上面那句的 GBK 字节（cmd / 简中 Windows 的实际输出）
    const TEXT_GBK: &[u8] = &[
        34, 67, 58, 92, 120, 92, 112, 121, 116, 104, 111, 110, 119, 46, 101, 120, 101, 34, 32, 178,
        187, 202, 199, 196, 218, 178, 191, 187, 242, 205, 226, 178, 191, 195, 252, 193, 238, 163,
        172, 210, 178, 178, 187, 202, 199, 191, 201, 212, 203, 208, 208, 181, 196, 179, 204, 208,
        242,
    ];
    /// 同一句的 UTF-8 字节（git / node 这类工具的实际输出）
    const TEXT_UTF8: &[u8] = &[
        34, 67, 58, 92, 120, 92, 112, 121, 116, 104, 111, 110, 119, 46, 101, 120, 101, 34, 32, 228,
        184, 141, 230, 152, 175, 229, 134, 133, 233, 131, 168, 230, 136, 150, 229, 164, 150, 233,
        131, 168, 229, 145, 189, 228, 187, 164, 239, 188, 140, 228, 185, 159, 228, 184, 141, 230,
        152, 175, 229, 143, 175, 232, 191, 144, 232, 161, 140, 231, 154, 132, 231, 168, 139, 229,
        186, 143,
    ];
    /// 歧义样本：「中文测试」的 GBK 字节（此样本在 UTF-8 下非法，属好判的一类）
    const HAN_GBK: &[u8] = &[214, 208, 206, 196, 178, 226, 202, 212];
    /// 「中文测试」的 UTF-8 字节
    const HAN_UTF8: &[u8] = &[228, 184, 173, 230, 150, 135, 230, 181, 139, 232, 175, 149];

    /// 只有简中环境的 OEM 代码页才是 GBK，其它语言环境下这些用例没有意义（跳过）
    fn zh_cn() -> bool {
        oem_encoding() == encoding_rs::GBK
    }

    #[test]
    fn gbk_整块解码() {
        if !zh_cn() {
            return;
        }
        assert_eq!(decode_bytes(TEXT_GBK, OutEncMode::Auto), TEXT);
        assert_eq!(decode_bytes(TEXT_GBK, OutEncMode::Oem), TEXT);
    }

    #[test]
    fn utf8_原样通过() {
        assert_eq!(decode_bytes(TEXT_UTF8, OutEncMode::Auto), TEXT);
        assert_eq!(decode_bytes(TEXT_UTF8, OutEncMode::Utf8), TEXT);
    }

    #[test]
    fn 歧义样本_一_判为GBK() {
        // 「一」的 GBK 字节 D2 BB 同时是合法 UTF-8（解出 U+04BB 西里尔字母 һ）——
        // 这就是「只看 from_utf8 成不成功」判不出来的那种情况。
        const AMB_GBK: &[u8] = &[210, 187];
        const AMB_UTF8: &[u8] = &[228, 184, 128];
        let as_utf8 = std::str::from_utf8(AMB_GBK).expect("前提：这 2 字节是合法 UTF-8");
        assert_eq!(as_utf8, "\u{04bb}");
        if !zh_cn() {
            return;
        }
        // 靠「落点特征」（西里尔区段且无 CJK）把判定救回 GBK
        assert_eq!(decode_bytes(AMB_GBK, OutEncMode::Auto), "一");
        // 真 UTF-8 的「一」不能被反向误判
        assert_eq!(decode_bytes(AMB_UTF8, OutEncMode::Auto), "一");
        // 多字也一样
        let amb2: Vec<u8> = [210, 187, 210, 187].to_vec();
        assert_eq!(decode_bytes(&amb2, OutEncMode::Auto), "一一");
    }

    #[test]
    fn 普通汉字样本_中文测试() {
        if !zh_cn() {
            return;
        }
        // 这个样本在两种编码下文本本身不冲突（GBK 字节在 UTF-8 下非法），
        // 是对「cmd 报错整句」这种真实负载的基本覆盖
        assert_eq!(decode_bytes(HAN_GBK, OutEncMode::Auto), "中文测试");
        assert_eq!(decode_bytes(HAN_UTF8, OutEncMode::Auto), "中文测试");
    }

    #[test]
    fn 逐字节分块_gbk_与_utf8_都不丢字() {
        if zh_cn() {
            let mut d = OutDecoder::new(OutEncMode::Auto);
            let mut got = String::new();
            for b in TEXT_GBK {
                got.push_str(&d.push(&[*b]));
            }
            got.push_str(&d.finish());
            assert_eq!(got, TEXT);
        }
        let mut d = OutDecoder::new(OutEncMode::Auto);
        let mut got = String::new();
        for b in TEXT_UTF8 {
            got.push_str(&d.push(&[*b]));
        }
        got.push_str(&d.finish());
        assert_eq!(got, TEXT);
    }

    #[test]
    fn 分块边界切在多字节字符中间() {
        if !zh_cn() {
            return;
        }
        // 逐个「2 字节」切：故意让 GBK 汉字与 UTF-8 汉字都被切开
        let mut d = OutDecoder::new(OutEncMode::Auto);
        let mut got = String::new();
        for chunk in HAN_GBK.chunks(2) {
            got.push_str(&d.push(chunk));
        }
        got.push_str(&d.finish());
        assert_eq!(got, "中文测试");

        let mut d = OutDecoder::new(OutEncMode::Auto);
        let mut got = String::new();
        for chunk in HAN_UTF8.chunks(2) {
            got.push_str(&d.push(chunk));
        }
        got.push_str(&d.finish());
        assert_eq!(got, "中文测试");
    }

    #[test]
    fn 纯ASCII_掺GBK() {
        if !zh_cn() {
            return;
        }
        let mut mix: Vec<u8> = b"plain-ascii ".to_vec();
        mix.extend_from_slice(HAN_GBK);
        assert_eq!(decode_bytes(&mix, OutEncMode::Auto), "plain-ascii 中文测试");
    }

    #[test]
    fn 显式指定可以绕开启发式() {
        // 用户显式说「我的程序输出 UTF-8」→ 即使字节看起来像 GBK 也按 UTF-8 解
        assert_eq!(decode_bytes(HAN_UTF8, OutEncMode::Utf8), "中文测试");
        // 用户显式说 GBK → 拿 UTF-8 字节去解必然乱（证明这个开关真的生效，不是摆设）
        if zh_cn() {
            assert_ne!(decode_bytes(HAN_UTF8, OutEncMode::Oem), "中文测试");
        }
    }

    #[test]
    fn 流末残留会被finish冲出来() {
        // 只喂一个 3 字节 UTF-8 字符的前 2 字节：此时无法判定，push 应为空
        let partial = &HAN_UTF8[..2];
        let mut d = OutDecoder::new(OutEncMode::Auto);
        assert_eq!(d.push(partial), "");
        // finish 必须把这半个字符也吐出来（不丢字节），而不是静默丢弃
        assert!(!d.finish().is_empty());
    }

    #[test]
    fn 编码模式解析() {
        assert!(matches!(parse_out_enc("auto"), OutEncMode::Auto));
        assert!(matches!(parse_out_enc(" UTF-8 "), OutEncMode::Utf8));
        assert!(matches!(parse_out_enc("gbk"), OutEncMode::Oem));
        assert!(matches!(parse_out_enc("ansi"), OutEncMode::Oem));
        assert!(matches!(parse_out_enc("随便填的"), OutEncMode::Auto));
    }

    #[test]
    fn 空输入不炸() {
        assert_eq!(decode_bytes(&[], OutEncMode::Auto), "");
        let mut d = OutDecoder::new(OutEncMode::Auto);
        assert_eq!(d.push(&[]), "");
        assert_eq!(d.finish(), "");
    }

    // ---- cron 段数与星期口径（本模块对外的协议是 Unix 5 段，crate 要 6 段）----

    #[test]
    fn unix_5段能解析() {
        // 就是这条被误报「表达式无效」的表达式
        assert!(parse_schedule("0 10 * * *").is_ok(), "5 段每天 10:00 必须可解析");
        assert!(parse_schedule("*/30 * * * *").is_ok());
        assert!(parse_schedule("0 */2 * * *").is_ok());
        assert!(parse_schedule("30 8 1 * *").is_ok());
        assert!(parse_schedule("0 9 * * 1,3,5").is_ok());
        assert!(parse_schedule("0 9 * * mon-fri").is_ok());
    }

    #[test]
    fn crate原生语法仍然可用() {
        // 6/7 段按 crate 原生（秒开头）透传，便于写「每 30 秒」这类面板调不了的计划
        assert!(parse_schedule("*/30 * * * * *").is_ok());
        assert!(parse_schedule("0 0 10 * * *").is_ok());
        assert!(parse_schedule("0 0 10 * * * 2030").is_ok());
    }

    #[test]
    fn 简写可用() {
        assert!(parse_schedule("@daily").is_ok());
        assert!(parse_schedule("@hourly").is_ok());
        // crate 不认的简写要给明确提示，而不是笼统的「无效」
        let e = parse_schedule("@every 1h").unwrap_err();
        assert!(e.contains("@every"), "应指明是哪个简写不支持：{e}");
    }

    #[test]
    fn 段数不对时提示段数() {
        let e = parse_schedule("10 * * *").unwrap_err();
        assert!(e.contains("5"), "应提示需要 5 段：{e}");
        let e = parse_schedule("* * * * * * * *").unwrap_err();
        assert!(e.contains("8"), "应报出实际段数：{e}");
    }

    #[test]
    fn 星期数字映射到crate口径() {
        // Unix 0=周日…6=周六（7 也作周日） → crate 1=周日…7=周六
        assert_eq!(translate_dow("0").unwrap(), "1"); // 周日
        assert_eq!(translate_dow("1").unwrap(), "2"); // 周一
        assert_eq!(translate_dow("6").unwrap(), "7"); // 周六
        assert_eq!(translate_dow("7").unwrap(), "1"); // 7 也是周日
        assert_eq!(translate_dow("*").unwrap(), "*");
        assert_eq!(translate_dow("?").unwrap(), "?");
    }

    #[test]
    fn 星期区间展开且能回绕() {
        // 1-5 = 周一到周五 → crate 2-6（展开成列表）
        assert_eq!(translate_dow("1-5").unwrap(), "2,3,4,5,6");
        // 5-7 = 周五、周六、周日：跨越周末边界，crate 的区间要求左≤右，故必须展开
        assert_eq!(translate_dow("5-7").unwrap(), "6,7,1");
        // 6-1 回绕 = 周六、周日、周一
        assert_eq!(translate_dow("6-1").unwrap(), "7,1,2");
        // 去重：0,7 是同一天
        assert_eq!(translate_dow("0,7").unwrap(), "1");
    }

    #[test]
    fn 星期名字原样保留() {
        // 两套口径的名字指向同一天，不动
        assert_eq!(translate_dow("sun").unwrap(), "sun");
        assert_eq!(translate_dow("mon-fri").unwrap(), "mon-fri");
        assert_eq!(translate_dow("mon,wed").unwrap(), "mon,wed");
        assert_eq!(translate_dow("*/2").unwrap(), "*/2");
    }

    #[test]
    fn 星期超范围或写错时给明确原因() {
        let e = translate_dow("8").unwrap_err();
        assert!(e.contains("8") && e.contains("7"), "应说明范围：{e}");
        let e = translate_dow("3-THURS").unwrap_err();
        assert!(e.contains("THURS"), "应指出写错的部分：{e}");
        let e = translate_dow("1,,2").unwrap_err();
        assert!(e.contains("逗号"), "应提示多余逗号：{e}");
        let e = translate_dow("*/0").unwrap_err();
        assert!(e.contains("0"), "步长 0 应报错：{e}");
    }

    #[test]
    fn 表达式_周一10点_真的落在周一() {
        // 这条是星期映射的反向证明：若不做重映射，crate 会把「1」当周日。
        use chrono::{Datelike, Local, TimeZone, Timelike};
        let now = Local::now().timestamp_millis();
        let t = next_due_after_checked("0 10 * * 1", now).expect("应能解析");
        let d = Local.timestamp_millis_opt(t).single().unwrap();
        assert_eq!(d.weekday().num_days_from_monday(), 0, "0 10 * * 1 必须落在周一，实际 {d}");
        assert_eq!((d.hour(), d.minute()), (10, 0), "时间应为 10:00，实际 {d}");
    }

    #[test]
    fn 表达式_周日10点_真的落在周日() {
        use chrono::{Datelike, Local, TimeZone};
        let now = Local::now().timestamp_millis();
        for expr in ["0 10 * * 0", "0 10 * * 7"] {
            let t = next_due_after_checked(expr, now).expect("应能解析");
            let d = Local.timestamp_millis_opt(t).single().unwrap();
            assert_eq!(d.weekday().num_days_from_sunday(), 0, "{expr} 必须落在周日，实际 {d}");
        }
    }

    #[test]
    fn 每天10点的下次时刻是10点整() {
        use chrono::{Local, TimeZone, Timelike};
        let now = Local::now().timestamp_millis();
        // 面板里三条签到任务实际在用的表达式，逐一确认真算出对应时刻
        for (expr, hh, mm) in [("0 10 * * *", 10, 0), ("5 10 * * *", 10, 5), ("10 10 * * *", 10, 10)] {
            let t = next_due_after_checked(expr, now).expect("应能解析");
            let d = Local.timestamp_millis_opt(t).single().unwrap();
            assert_eq!((d.hour(), d.minute()), (hh, mm), "{expr} 应算出 {hh:02}:{mm:02}，实际 {d}");
            assert!(t > now, "下次触发时刻必须在未来");
        }
    }

    // ---------- 按天聚合（热力图数据源） ----------

    /// 构造一条 RunRecord，只关心聚合用到的字段。
    fn rec(task: &str, ms: i64, status: &str) -> RunRecord {
        RunRecord {
            run_id: "r".into(),
            task_id: task.into(),
            name: "n".into(),
            trigger: "cron".into(),
            started_at: ms,
            duration_ms: 1,
            status: status.into(),
            exit_code: None,
            output: String::new(),
        }
    }

    /// 本地某天的 0 点时刻（用 chrono 而不是减固定毫秒数，避免跨 DST 出错）
    fn local_midnight(y: i32, m: u32, d: u32) -> i64 {
        use chrono::{Local, TimeZone};
        Local
            .with_ymd_and_hms(y, m, d, 0, 0, 0)
            .single()
            .expect("合法本地时刻")
            .timestamp_millis()
    }

    #[test]
    fn 日期键用本地日期() {
        use chrono::{Datelike, Local, TimeZone};
        // 本地当天任意时刻都应归到同一个「今天」
        let day = local_midnight(2026, 10, 6);
        for h in [0i64, 6, 12, 23] {
            let ms = day + h * 3600_000;
            let k = day_key(ms);
            let d = Local.timestamp_millis_opt(ms).single().unwrap();
            assert_eq!(k, format!("{:04}-{:02}-{:02}", d.year(), d.month(), d.day()));
            assert_eq!(k, "2026-10-06", "本地时刻 {h} 点必须归到当天，实际 {k}");
        }
    }

    #[test]
    fn 各状态分别累加且取消归入stop() {
        let mut daily: HashMap<String, HashMap<String, DayAgg>> = HashMap::new();
        let t0 = local_midnight(2026, 10, 6) + 10 * 3600_000;
        bump_daily(&mut daily, &rec("a", t0, "success"));
        bump_daily(&mut daily, &rec("a", t0 + 60_000, "success"));
        bump_daily(&mut daily, &rec("a", t0, "failed"));
        bump_daily(&mut daily, &rec("a", t0, "timeout"));
        bump_daily(&mut daily, &rec("a", t0, "canceled"));
        bump_daily(&mut daily, &rec("b", t0, "failed"));
        let a = daily.get("a").expect("a 应有数据").get("2026-10-06").expect("当天");
        assert_eq!((a.ok, a.bad, a.warn, a.stop), (2, 1, 1, 1), "五种结果必须各归各的桶（canceled → stop）");
        // 任务之间不能串台
        let b = daily.get("b").expect("b 应有数据").get("2026-10-06").expect("当天");
        assert_eq!((b.ok, b.bad), (0, 1));
    }

    #[test]
    fn 跨天分桶而不是累加到同一天() {
        let mut daily: HashMap<String, HashMap<String, DayAgg>> = HashMap::new();
        bump_daily(&mut daily, &rec("a", local_midnight(2026, 10, 5) + 3600_000, "success"));
        bump_daily(&mut daily, &rec("a", local_midnight(2026, 10, 6) + 3600_000, "failed"));
        bump_daily(&mut daily, &rec("a", local_midnight(2026, 10, 7) + 3600_000, "success"));
        let m = daily.get("a").unwrap();
        assert_eq!(m.len(), 3, "三天必须三个键，实际 {:?}", m.keys().collect::<Vec<_>>());
        assert_eq!(m["2026-10-05"].ok, 1);
        assert_eq!(m["2026-10-06"].bad, 1);
        assert_eq!(m["2026-10-07"].ok, 1);
    }

    #[test]
    fn 超过保留天数时掐掉最旧的() {
        let mut daily: HashMap<String, HashMap<String, DayAgg>> = HashMap::new();
        // 造 DAY_KEEP + 5 天，最早的 5 天应被掐掉
        let base = local_midnight(2026, 1, 1);
        for i in 0..(DAY_KEEP as i64 + 5) {
            bump_daily(&mut daily, &rec("a", base + i * 86_400_000, "success"));
        }
        prune_daily(&mut daily);
        let m = daily.get("a").unwrap();
        assert_eq!(m.len(), DAY_KEEP, "应恰好保留 DAY_KEEP 天");
        assert!(!m.contains_key(&day_key(base)), "最早的一天应被掐掉");
        // 保留下来的是**最近**的：最后一天必须在
        let last = day_key(base + (DAY_KEEP as i64 + 4) * 86_400_000);
        assert!(m.contains_key(&last), "最近一天 {last} 不能被掐掉");
    }

    #[test]
    fn 从runs回填与逐条累加等价() {
        // start_scheduler 的回填路径：对同一批记录，先全量回填 vs 逐条累加，结果必须一致
        let base = local_midnight(2026, 10, 6);
        let rs = [
            rec("a", base + 3600_000, "success"),
            rec("a", base + 7200_000, "failed"),
            rec("b", base + 3600_000, "timeout"),
        ];
        let mut backfill: HashMap<String, HashMap<String, DayAgg>> = HashMap::new();
        for r in &rs {
            bump_daily(&mut backfill, r);
        }
        let mut incremental: HashMap<String, HashMap<String, DayAgg>> = HashMap::new();
        for r in rs.iter().rev() {
            // runs 是新→旧的插入顺序，回填与实时累加的先后不影响计数
            bump_daily(&mut incremental, r);
        }
        assert_eq!(backfill["a"]["2026-10-06"].ok, incremental["a"]["2026-10-06"].ok);
        assert_eq!(backfill["a"]["2026-10-06"].bad, incremental["a"]["2026-10-06"].bad);
        assert_eq!(backfill["b"]["2026-10-06"].warn, 1);
    }

    /// 运行输出缓冲有上界，且截断后不再增长。
    #[test]
    fn 输出缓冲有上界() {
        let mut sink = String::new();
        let big = "x".repeat(CHUNK);
        // 灌到远超上限：模拟 reader 线程持续 push
        let mut clipped_times = 0;
        for _ in 0..40 {
            if append_bounded(&mut sink, &big) {
                clipped_times += 1;
            }
        }
        assert!(sink.len() <= OUT_CAP + OUT_CLIPPED.len(), "缓冲越界：{} 字节", sink.len());
        assert!(
            sink.ends_with(OUT_CLIPPED),
            "超限后应留下截断提示；实际 len={}, tail={:?}",
            sink.len(),
            &sink[sink.len().saturating_sub(40)..]
        );
        // 前 15 轮正常累积（第 15 轮起触发截断），此后每轮都回报「已截断」且长度不再增长
        assert_eq!(clipped_times, 25, "封顶后应持续回报「已截断」");
        assert_eq!(sink.len(), OUT_CAP - CHUNK + OUT_CLIPPED.len(), "封顶长度应固定不再增长");
        // 未越界时原样累积（行为不能被上界改坏）
        let mut small = String::new();
        assert!(!append_bounded(&mut small, "hello"));
        assert!(!append_bounded(&mut small, " world"));
        assert_eq!(small, "hello world");
    }

    /// 设置解析：缺省、合法区间与类型错误。
    #[test]
    fn 设置解析() {
        assert_eq!(settings_from(&serde_json::json!({})), (2, true));
        assert_eq!(settings_from(&serde_json::json!({ "scheduler": {} })), (2, true));
        assert_eq!(
            settings_from(&serde_json::json!({ "scheduler": { "maxConcurrent": 5, "catchUp": false } })),
            (5, false)
        );
        // 越界值收敛到 1..=8，类型不对则回退默认
        assert_eq!(settings_from(&serde_json::json!({ "scheduler": { "maxConcurrent": 99 } })).0, 8);
        assert_eq!(settings_from(&serde_json::json!({ "scheduler": { "maxConcurrent": 0 } })).0, 1);
        assert_eq!(settings_from(&serde_json::json!({ "scheduler": { "maxConcurrent": "x" } })).0, 2);
    }
}
