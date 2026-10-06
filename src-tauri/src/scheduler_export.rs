//! 「定时任务」的系统计划任务（schtasks）导出。
//!
//! ## 为什么用 .cmd 包装脚本而不是把命令行塞进 schtasks
//! schtasks 的 `/TR` 只有一个字符串参数，命令里再出现引号（JSON body、带空格路径、
//! `python "C:\a b\x.py"`）就会陷入 Windows 多层转义的泥潭，且出错时现象极难定位。
//! 因此每个任务生成一个 `.cmd` 包装脚本，`/TR` 只指向该脚本路径，转义问题一次性消失。
//!
//! 附带好处：包装脚本把输出重定向到 `scheduler-logs/<taskId>.log`，
//! 于是**由系统计划任务触发的运行也能在面板里看到日志**（否则这部分是黑盒）。
//!
//! ## 已知限制（UI 需如实标注）
//! - schtasks 的 `/SC` 只支持 MINUTE/HOURLY/DAILY/WEEKLY/MONTHLY/ONCE，
//!   无法表达任意 cron（如 `*/7 9-18 * * 1-5`）。此类表达式导出会明确报错而非静默降级。
//! - HTTP 任务导出依赖系统自带 `curl.exe`（Windows 10 1803+ 内置）。
//!
//! ## cron 口径
//! 与面板内调度完全一致：**Unix 5 段**（分 时 日 月 周），星期 **0=周日…6=周六**（7 也作周日）。
//! 注意这与底层 `cron` crate 的口径不同（它要 6 段且 1=周日），差异只在 `scheduler.rs`
//! 的 `parse_schedule` / `translate_dow` 里抹平一次；本模块拿到的始终是 Unix 口径，
//! 所以 `day_abbr` 直接按 0→SUN、1→MON…6→SAT 映射即可。
//!
//! ## 编码约定（踩过的坑）
//! 中文 Windows 上 schtasks / cmd 的输出是 **GBK**，不是 UTF-8；包装脚本被 cmd 读取时也是
//! 按控制台代码页解析。所以：
//! - 所有外部命令输出统一走 `decode_bytes`（先 UTF-8，失败再按 OEM 代码页）；
//! - 包装脚本**按 OEM 代码页写盘**，且**不在脚本里 `chcp 65001`**：chcp 只改 cmd 内置命令与
//!   native 程序的控制台 CP，**python 这类按 locale 编码输出的程序并不受影响**，
//!   结果同一个日志文件里前半段 UTF-8、后半段 GBK，怎么解都会错一半。
//!   让整份文件统一为系统 OEM 编码，才是可读的那个选择。

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::{Command, Stdio};

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::scheduler::{
    decode_bytes, oem_encoding, parse_out_enc, parse_schedule, read_tasks_raw, OutEncMode,
};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn no_window(c: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(CREATE_NO_WINDOW);
    }
}

/// 计划任务名前缀。沿用扁平命名（不建文件夹）：schtasks 建子文件夹的行为在不同
/// Windows 版本上不一致，扁平名最稳，且便于用户用 `schtasks /Query` 一眼看到。
const PREFIX: &str = "DeskOverlay_";

fn task_name(id: &str) -> String {
    // 任务 id 由前端 uid() 生成，只含字母数字与下划线；再做一次兜底清洗，
    // 避免任何意外字符进入 schtasks 参数。
    let safe: String = id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' })
        .collect();
    format!("{PREFIX}{safe}")
}

// ============================ 调度计划推导 ============================

/// schtasks 的时间参数（/SC + 配套开关）。
#[derive(Debug, PartialEq, Eq)]
pub struct SchPlan {
    /// /SC 的值
    pub sc: String,
    /// 附加参数（如 /ST 10:00 /D MON）
    pub extra: Vec<String>,
    /// 人话描述，用于 UI 预览
    pub human: String,
}

fn digits(s: &str) -> Option<u32> {
    if s.is_empty() || !s.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    s.parse().ok()
}

/// 每周几的 cron 名 → schtasks 的 /D 缩写。
fn day_abbr(n: u32) -> Option<&'static str> {
    Some(match n {
        0 | 7 => "SUN",
        1 => "MON",
        2 => "TUE",
        3 => "WED",
        4 => "THU",
        5 => "FRI",
        6 => "SAT",
        _ => return None,
    })
}

/// 把 5 段 cron 推导成 schtasks 计划。仅支持 schtasks 能表达的形态，
/// 其余一律返回 Err（宁可明确报错，也不静默换一个意思相近但不等价的时间）。
pub fn cron_to_schtasks(cron: &str) -> Result<SchPlan, String> {
    let f: Vec<&str> = cron.split_whitespace().collect();
    if f.len() != 5 {
        return Err(format!(
            "系统计划任务导出只认 5 段表达式（分 时 日 月 周），当前为 {} 段",
            f.len()
        ));
    }
    // 表达式本身先要能被调度器接受，避免导出与面板内调度口径不一致
    if let Err(e) = parse_schedule(cron) {
        return Err(format!("cron 表达式无效：{e}"));
    }
    let (min, hour, dom, mon, dow) = (f[0], f[1], f[2], f[3], f[4]);
    if !mon.eq_ignore_ascii_case("*") && mon != "?" {
        return Err("系统计划任务不支持「限定月份」，请改用面板内调度".to_string());
    }
    if !dom.eq_ignore_ascii_case("*") && dom != "?" {
        return Err("系统计划任务不支持「限定日期」，请改用面板内调度".to_string());
    }

    // 形态一：*/N * * * *  → 每 N 分钟
    if let Some(rest) = min.strip_prefix("*/") {
        if hour == "*" && dow == "*" {
            let n = digits(rest).ok_or("分钟间隔写法无效")?;
            if n == 0 || n > 59 {
                return Err("分钟间隔需在 1~59 之间".to_string());
            }
            return Ok(SchPlan {
                sc: "MINUTE".into(),
                extra: vec!["/MO".into(), n.to_string()],
                human: format!("每 {n} 分钟"),
            });
        }
    }
    // 形态二：M */N * * *  → 每 N 小时
    if let Some(rest) = hour.strip_prefix("*/") {
        if dow == "*" {
            let m = digits(min).ok_or("分钟字段写法无效")?;
            let n = digits(rest).ok_or("小时间隔写法无效")?;
            if m > 59 {
                return Err("分钟需在 0~59 之间".to_string());
            }
            if n == 0 || n > 23 {
                return Err("小时间隔需在 1~23 之间".to_string());
            }
            return Ok(SchPlan {
                sc: "HOURLY".into(),
                extra: vec!["/MO".into(), n.to_string(), "/ST".into(), format!("00:{m:02}")],
                human: format!("每 {n} 小时（第 {m} 分）"),
            });
        }
    }

    // 形态三：* * * * * → 每分钟
    if min == "*" && hour == "*" && dow == "*" {
        return Ok(SchPlan {
            sc: "MINUTE".into(),
            extra: vec!["/MO".into(), "1".into()],
            human: "每分钟".into(),
        });
    }
    // 小时为 * 但还限定了星期，schtasks 没有「每周几的每小时」这种组合，明确拒绝
    if hour == "*" && dow != "*" && dow != "?" {
        return Err("不支持「限定星期 + 每小时」，请给出具体小时".to_string());
    }

    let m = digits(min).ok_or("分钟字段需为具体数字（0~59）")?;
    if m > 59 {
        return Err("分钟需在 0~59 之间".to_string());
    }
    // 形态四：M * * * * → 每小时的第 M 分
    if hour == "*" {
        return Ok(SchPlan {
            sc: "HOURLY".into(),
            extra: vec!["/MO".into(), "1".into(), "/ST".into(), format!("00:{m:02}")],
            human: format!("每小时（第 {m} 分）"),
        });
    }
    let h = digits(hour).ok_or("小时字段需为具体数字（0~23）")?;
    if h > 23 {
        return Err("小时需在 0~23 之间".to_string());
    }
    let st = format!("{h:02}:{m:02}");

    // 形态五：M H * * *  → 每天
    if dow == "*" || dow == "?" {
        return Ok(SchPlan {
            sc: "DAILY".into(),
            extra: vec!["/ST".into(), st.clone()],
            human: format!("每天 {st}"),
        });
    }
    // 形态六：M H * * D[,D…]  → 每周指定日
    let mut days: Vec<&'static str> = Vec::new();
    let add = |d: &'static str, days: &mut Vec<&'static str>| {
        if !days.contains(&d) {
            days.push(d);
        }
    };
    for part in dow.split(',') {
        let part = part.trim();
        if part.is_empty() {
            return Err("星期字段里有多余的逗号".to_string());
        }
        // cron 允许「1-5」区间，schtasks /D 也接受逗号列表，这里展开区间
        if let Some((a, b)) = part.split_once('-') {
            let (Some(a), Some(b)) = (digits(a), digits(b)) else {
                return Err(format!(
                    "星期字段「{part}」无法识别（区间端点需为数字，系统计划任务不接受 sun-fri 这类名字）"
                ));
            };
            if a > 7 || b > 7 {
                return Err(format!("星期字段「{part}」超出范围（0~7，0 与 7 均为周日）"));
            }
            // b < a 视为回绕：6-1 = 周六、周日、周一（不要交换端点，那会变成完全不同的日子）
            let end = if b < a { b + 7 } else { b };
            for n in a..=end {
                let d = day_abbr(n % 7).ok_or_else(|| format!("星期「{n}」超出范围"))?;
                add(d, &mut days);
            }
        } else {
            let n = digits(part).ok_or_else(|| format!("星期字段「{part}」无法识别"))?;
            let d =
                day_abbr(n).ok_or_else(|| format!("星期「{n}」超出范围（0~7，0 与 7 均为周日）"))?;
            add(d, &mut days);
        }
    }
    Ok(SchPlan {
        sc: "WEEKLY".into(),
        extra: vec!["/ST".into(), st.clone(), "/D".into(), days.join(",")],
        human: format!("每周 {} {st}", days.join("、")),
    })
}

// ============================ 包装脚本 ============================

fn app_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|e| e.to_string())
}

fn wrapper_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let d = app_dir(app)?.join("scheduler-logs");
    std::fs::create_dir_all(&d).map_err(|e| format!("创建目录失败：{e}"))?;
    Ok(d)
}

/// 生成任务的 .cmd 包装脚本内容。
/// `log` 为输出重定向目标：由系统计划任务触发时面板拿不到实时流，
/// 因此把输出落盘，面板再读该文件展示。
fn wrapper_body(t: &Value, log: &std::path::Path, body_file: Option<&std::path::Path>) -> String {
    let mut s = String::from("@echo off\r\n");
    s.push_str("echo [%date% %time%] 开始\r\n");
    if t.get("kind").and_then(|v| v.as_str()) == Some("http") {
        let url = t.get("url").and_then(|v| v.as_str()).unwrap_or("");
        let method = t.get("method").and_then(|v| v.as_str()).unwrap_or("GET");
        let mut c = format!("curl.exe -sS -X {method} --max-time {}", timeout_of(t));
        if let Some(hs) = t.get("headers").and_then(|v| v.as_object()) {
            for (k, v) in hs {
                if let Some(v) = v.as_str() {
                    c.push_str(&format!(" -H \"{k}: {v}\""));
                }
            }
        }
        if let Some(bf) = body_file {
            c.push_str(&format!(" --data-binary \"@{}\"", bf.display()));
        }
        c.push_str(&format!(" \"{url}\""));
        s.push_str(&format!("{c} >> \"{}\" 2>&1\r\n", log.display()));
    } else {
        let command = t.get("command").and_then(|v| v.as_str()).unwrap_or("");
        if let Some(cwd) = t.get("cwd").and_then(|v| v.as_str()).filter(|c| !c.trim().is_empty()) {
            s.push_str(&format!("cd /d \"{cwd}\"\r\n"));
        }
        s.push_str(&format!("{command} >> \"{}\" 2>&1\r\n", log.display()));
    }
    s.push_str(&format!("echo [%date% %time%] 结束 exit=%ERRORLEVEL%\r\n"));
    s
}

fn timeout_of(t: &Value) -> u64 {
    t.get("timeoutSec").and_then(|v| v.as_u64()).unwrap_or(300).clamp(1, 3600)
}

/// 写包装脚本（HTTP 任务的请求体单独落文件，避开 cmd 引号转义）。
fn write_wrapper(app: &AppHandle, t: &Value, id: &str) -> Result<PathBuf, String> {
    let dir = wrapper_dir(app)?;
    let log = dir.join(format!("{id}.log"));
    let body_file = if t.get("kind").and_then(|v| v.as_str()) == Some("http") {
        let b = t.get("body").and_then(|v| v.as_str()).unwrap_or("");
        if b.trim().is_empty() {
            None
        } else {
            let p = dir.join(format!("{id}.body.txt"));
            // 请求体保持 UTF-8（服务器按 JSON 解析），与 .cmd 的 OEM 编码不同，别混
            std::fs::write(&p, b).map_err(|e| format!("写请求体失败：{e}"))?;
            Some(p)
        }
    } else {
        None
    };
    let path = dir.join(format!("{id}.cmd"));
    // 按系统 OEM 代码页写盘：cmd 读 .cmd 文件用的是控制台代码页，UTF-8 写盘会让
    // 脚本里的中文（「开始」「结束」）在 cmd 眼里变成乱码字节，连带污染日志文件。
    let body = wrapper_body(t, &log, body_file.as_deref());
    let (bytes, _, _) = oem_encoding().encode(&body);
    std::fs::write(&path, bytes.as_ref()).map_err(|e| format!("写包装脚本失败：{e}"))?;
    Ok(path)
}

// ============================ schtasks 调用 ============================

fn run_schtasks(args: &[String]) -> Result<String, String> {
    let mut c = Command::new("schtasks");
    c.args(args).stdin(Stdio::null());
    no_window(&mut c);
    let out = c
        .output()
        .map_err(|e| format!("无法调用 schtasks：{e}（系统自带，若缺失请检查 PATH）"))?;
    let stdout = decode_bytes(&out.stdout, OutEncMode::Auto).trim().to_string();
    let stderr = decode_bytes(&out.stderr, OutEncMode::Auto).trim().to_string();
    if out.status.success() {
        Ok(stdout)
    } else {
        let code = out.status.code().unwrap_or(-1);
        Err(format!(
            "schtasks 退出码 {code}\n{}\n{}",
            clip(&stdout),
            clip(&stderr)
        ))
    }
}

fn clip(s: &str) -> String {
    s.chars().take(600).collect()
}

/// 组装创建命令（纯函数，便于单测与 UI 预览）。
pub fn build_create_args(name: &str, plan: &SchPlan, wrapper: &std::path::Path) -> Vec<String> {
    let mut a: Vec<String> = vec![
        "/Create".into(),
        "/TN".into(),
        name.into(),
        "/TR".into(),
        // schtasks 参数里嵌套引号：传给 CreateProcess 的字符串需再包一层反斜杠引号
        format!("\"\\\"{}\\\"\"", wrapper.display()),
        "/SC".into(),
        plan.sc.clone(),
    ];
    a.extend(plan.extra.iter().cloned());
    // /F 覆盖同名；/RL LIMITED 用当前用户权限（无需管理员），且默认仅登录时运行 ——
    // 与现有签到计划任务的行为一致，也能拿到用户环境里的 python/node。
    a.push("/F".into());
    a.push("/RL".into());
    a.push("LIMITED".into());
    a
}

/// 供 UI 预览的完整命令行文本。
pub fn preview_command_line(name: &str, plan: &SchPlan, wrapper: &std::path::Path) -> String {
    let args = build_create_args(name, plan, wrapper);
    format!("schtasks {}", args.join(" "))
}

// ============================ 对外命令 ============================

/// 从 state.json 里按 id 取任务原始 JSON（导出需要完整字段）。
fn find_task(app: &AppHandle, id: &str) -> Result<Value, String> {
    read_tasks_raw(app)
        .into_iter()
        .find(|t| t.get("id").and_then(|v| v.as_str()) == Some(id))
        .ok_or_else(|| format!("任务不存在：{id}"))
}

/// 生成导出预览：不改动系统，仅告诉用户「会执行什么、会在什么时间跑」。
#[tauri::command]
pub fn scheduler_export_preview(app: AppHandle, task_id: String) -> Result<Value, String> {
    let t = find_task(&app, &task_id)?;
    let cron = t.get("cron").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    let plan = cron_to_schtasks(&cron)?;
    let name = task_name(&task_id);
    let wrapper = wrapper_dir(&app)?.join(format!("{task_id}.cmd"));
    Ok(json!({
        "name": name,
        "human": plan.human,
        "commandLine": preview_command_line(&name, &plan, &wrapper),
        "wrapper": wrapper.display().to_string(),
        "logFile": wrapper_dir(&app)?.join(format!("{task_id}.log")).display().to_string(),
    }))
}

/// 注册到 Windows 计划任务：先落包装脚本，再 schtasks /Create。
#[tauri::command]
pub fn scheduler_export_task(app: AppHandle, task_id: String) -> Result<Value, String> {
    let t = find_task(&app, &task_id)?;
    if t.get("enabled").and_then(|v| v.as_bool()) == Some(false) {
        return Err("任务已停用，先启用再导出".to_string());
    }
    if t.get("kind").and_then(|v| v.as_str()) == Some("command")
        && t.get("command").and_then(|v| v.as_str()).unwrap_or("").trim().is_empty()
    {
        return Err("命令为空".to_string());
    }
    let cron = t.get("cron").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    let plan = cron_to_schtasks(&cron)?;
    let wrapper = write_wrapper(&app, &t, &task_id)?;
    let name = task_name(&task_id);
    let args = build_create_args(&name, &plan, &wrapper);
    let out = run_schtasks(&args)?;
    Ok(json!({
        "name": name,
        "human": plan.human,
        "commandLine": preview_command_line(&name, &plan, &wrapper),
        "wrapper": wrapper.display().to_string(),
        "logFile": wrapper_dir(&app)?.join(format!("{task_id}.log")).display().to_string(),
        "output": clip(&out),
    }))
}

/// 注销系统计划任务（同时清理包装脚本与日志）。
#[tauri::command]
pub fn scheduler_unexport_task(app: AppHandle, task_id: String) -> Result<Value, String> {
    let name = task_name(&task_id);
    let out = run_schtasks(&[
        "/Delete".into(),
        "/TN".into(),
        name.clone(),
        "/F".into(),
    ])?;
    if let Ok(d) = wrapper_dir(&app) {
        let _ = std::fs::remove_file(d.join(format!("{task_id}.cmd")));
        let _ = std::fs::remove_file(d.join(format!("{task_id}.body.txt")));
        // 日志保留：它是执行证据，不该因为注销调度就删掉
    }
    Ok(json!({ "name": name, "output": clip(&out) }))
}

/// 批量查询各任务在系统计划任务里是否已注册。
#[tauri::command]
pub fn scheduler_export_status(task_ids: Vec<String>) -> HashMap<String, bool> {
    task_ids
        .into_iter()
        .map(|id| {
            let name = task_name(&id);
            let ok = run_schtasks(&["/Query".into(), "/TN".into(), name]).is_ok();
            (id, ok)
        })
        .collect()
}

/// 读取「由系统计划任务触发那一次」落盘的输出。
#[tauri::command]
pub fn scheduler_read_os_log(app: AppHandle, task_id: String, max_chars: Option<usize>) -> Value {
    let Ok(d) = wrapper_dir(&app) else {
        return json!({ "exists": false, "text": "" });
    };
    let p = d.join(format!("{task_id}.log"));
    // 读字节再解码：日志是 cmd/python 按 OEM 代码页写的，用 read_to_string（要求 UTF-8）
    // 会直接失败 —— 现象是「明明跑过，面板却显示没有记录」。编码跟随该任务的 outputEncoding。
    let mode = read_tasks_raw(&app)
        .iter()
        .find(|t| t.get("id").and_then(|v| v.as_str()) == Some(task_id.as_str()))
        .map(|t| parse_out_enc(t.get("outputEncoding").and_then(|v| v.as_str()).unwrap_or("auto")))
        .unwrap_or(OutEncMode::Auto);
    match std::fs::read(&p) {
        Ok(raw) => {
            let t = decode_bytes(&raw, mode);
            let cap = max_chars.unwrap_or(20_000);
            let text = if t.len() > cap {
                let mut end = t.len() - cap;
                while end < t.len() && !t.is_char_boundary(end) {
                    end += 1;
                }
                format!("…（仅显示末尾 {cap} 字符）\n{}", &t[end..])
            } else {
                t
            };
            json!({ "exists": true, "path": p.display().to_string(), "text": text })
        }
        Err(_) => json!({ "exists": false, "path": p.display().to_string(), "text": "" }),
    }
}

/// 清空系统计划任务那一路的日志文件。
#[tauri::command]
pub fn scheduler_clear_os_log(app: AppHandle, task_id: String) -> Result<(), String> {
    let d = wrapper_dir(&app)?;
    let p = d.join(format!("{task_id}.log"));
    if p.exists() {
        std::fs::write(&p, "").map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    #![allow(non_snake_case)]

    use super::*;

    fn plan(cron: &str) -> SchPlan {
        cron_to_schtasks(cron).unwrap_or_else(|e| panic!("{cron} 应能导出：{e}"))
    }

    /// `/D` 的值（extra 的最后一项），用于断言星期
    fn dow_of(cron: &str) -> String {
        plan(cron).extra.last().cloned().unwrap_or_default()
    }

    fn strs(v: &[String]) -> Vec<&str> {
        v.iter().map(|s| s.as_str()).collect()
    }

    #[test]
    fn 每天十点导出为daily() {
        let p = plan("0 10 * * *");
        assert_eq!(p.sc, "DAILY");
        assert_eq!(strs(&p.extra), vec!["/ST", "10:00"]);
        assert_eq!(p.human, "每天 10:00");
    }

    #[test]
    fn 星期数字按unix口径映射到schtasks缩写() {
        // 这条口径错了会「周一的任务周日跑」，且不会有任何报错
        assert_eq!(dow_of("0 10 * * 1"), "MON");
        assert_eq!(dow_of("0 10 * * 0"), "SUN");
        assert_eq!(dow_of("0 10 * * 7"), "SUN");
        assert_eq!(dow_of("0 10 * * 6"), "SAT");
        assert_eq!(dow_of("0 10 * * 2"), "TUE");
    }

    #[test]
    fn 星期区间展开为逗号列表() {
        assert_eq!(plan("0 10 * * 1-5").sc, "WEEKLY");
        assert_eq!(dow_of("0 10 * * 1-5"), "MON,TUE,WED,THU,FRI");
        // 回绕区间不能靠交换端点蒙混过去
        assert_eq!(dow_of("0 10 * * 5-7"), "FRI,SAT,SUN");
        assert_eq!(dow_of("0 10 * * 6-1"), "SAT,SUN,MON");
        // 去重：1,1,2 与 1,2 等价
        assert_eq!(dow_of("0 10 * * 1,1,2"), "MON,TUE");
    }

    #[test]
    fn 间隔形态() {
        let p = plan("*/15 * * * *");
        assert_eq!(p.sc, "MINUTE");
        assert_eq!(strs(&p.extra), vec!["/MO", "15"]);
        assert_eq!(strs(&plan("* * * * *").extra), vec!["/MO", "1"]);
        assert_eq!(plan("0 */2 * * *").sc, "HOURLY");
        assert_eq!(strs(&plan("30 * * * *").extra), vec!["/MO", "1", "/ST", "00:30"]);
    }

    #[test]
    fn 不支持的时间形态要明确报错而不是近似替换() {
        // 限定月份/日期：schtasks 的单条计划表达不了
        assert!(cron_to_schtasks("0 10 1 * *").unwrap_err().contains("限定日期"));
        assert!(cron_to_schtasks("0 10 * 6 *").unwrap_err().contains("限定月份"));
        // 每小时 × 限定星期：没有等价组合，必须拒绝
        assert!(cron_to_schtasks("0 * * * 1").unwrap_err().contains("每小时"));
        // 名字类的星期在 schtasks /D 里没有对应写法
        assert!(cron_to_schtasks("0 10 * * mon").unwrap_err().contains("无法识别"));
        // 段数不对要说清是几段
        let e = cron_to_schtasks("0 0 10 * * *").unwrap_err();
        assert!(e.contains("6"), "应报出实际段数：{e}");
        // 非法表达式要带出真实原因
        let e = cron_to_schtasks("0 10 * * 9").unwrap_err();
        assert!(e.contains("cron 表达式无效"), "应标明表达式无效：{e}");
    }

    #[test]
    fn 周内每天与面板调度口径一致() {
        // 面板调度用的是 Unix 5 段（分 时 日 月 周），导出必须认同一套
        for c in ["0 10 * * *", "*/15 * * * *", "0 */2 * * *", "0 10 * * 1-5"] {
            assert!(parse_schedule(c).is_ok(), "{c} 面板可解析，导出也必须可用");
            assert!(cron_to_schtasks(c).is_ok(), "{c} 应能导出");
        }
    }
}
