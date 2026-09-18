//! 全盘文件名索引 —— Everything 式「后台索引器」，不依赖外部程序，也不读 NTFS $MFT。
//!
//! 后台线程遍历本地固定盘，把路径建进内存索引；索引快照落盘 fileindex.txt，
//! 下次启动秒恢复（无需整盘重扫）。提供 3 个命令：
//!   index_status()        —— 就绪/进度/根目录
//!   search_files(query)   —— 子串匹配文件名，返回前 N 条
//!   rebuild_index()       —— 手动全量重建（热插拔盘/大改动后刷新）
//!
//! 说明：非 $MFT 级秒建，但首次全盘建完即内存驻留，搜索为即时子串过滤；重建按需触发。

use std::fs::File;
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use serde::Serialize;
use tauri::{AppHandle, Manager};
use windows::core::PCWSTR;
use windows::Win32::Storage::FileSystem::GetDriveTypeW;

const DRIVE_FIXED: u32 = 3; // GetDriveTypeW 返回 DRIVE_FIXED

const SNAPSHOT: &str = "fileindex.txt";

/// 命中结果，命令直接返回给前端。
#[derive(Clone, Serialize)]
pub struct Hit {
    pub path: String,
    pub is_dir: bool,
}

/// 索引主体：entries / roots 就绪后整体替换；progress 用原子计数单独维护，避免持锁阻塞轮询。
pub struct IndexInner {
    ready: bool,
    entries: Arc<Vec<Hit>>,
    /// 与 entries 一一对应的小写文件名索引（见 build_name_index），搜索不再逐条现算。
    names: Arc<NameIndex>,
    roots: Vec<String>,
}
impl Default for IndexInner {
    fn default() -> Self {
        Self {
            ready: false,
            entries: Arc::new(Vec::new()),
            names: Arc::new(NameIndex::default()),
            roots: Vec::new(),
        }
    }
}

/// 预计算的小写文件名索引。
/// `buf` 是所有文件名小写化后首尾相接的扁平缓冲，`offs` 为偏移表（长度 = entries.len() + 1，
/// 故 `offs[i]..offs[i+1]` 即第 i 条的文件名）。建索引时算一次，之后每次查询只做纯字节比较 ——
/// 取代原先「每查一次 × 每条 rsplit 取文件名 + 逐字节 to_ascii_lowercase」。
/// 代价约 20 字节/条（3M 条约 60MB），换来查询侧 3 倍提速（见 contains_lower）。
#[derive(Default)]
struct NameIndex {
    buf: Vec<u8>,
    offs: Vec<u32>,
}

/// 从 entries 构建小写文件名索引（约 173ms / 3M 条，只在建索引时执行一次）。
fn build_name_index(entries: &[Hit]) -> NameIndex {
    let mut offs: Vec<u32> = Vec::with_capacity(entries.len() + 1);
    let mut buf: Vec<u8> = Vec::with_capacity(entries.len() * 20);
    for e in entries {
        offs.push(buf.len() as u32);
        let name = e.path.rsplit(['\\', '/']).next().unwrap_or("");
        buf.extend(name.bytes().map(|b| b.to_ascii_lowercase()));
    }
    offs.push(buf.len() as u32);
    buf.shrink_to_fit();
    NameIndex { buf, offs }
}

static IDX: OnceLock<Arc<Mutex<IndexInner>>> = OnceLock::new();
fn idx() -> &'static Arc<Mutex<IndexInner>> {
    IDX.get_or_init(|| Arc::new(Mutex::new(IndexInner::default())))
}
/// 取锁；某线程持锁 panic 后 Mutex 会被污染，这里吞掉 PoisonError 继续用，避免搜索永久失效。
fn idx_lock() -> std::sync::MutexGuard<'static, IndexInner> {
    idx().lock().unwrap_or_else(|e| e.into_inner())
}
static IDX_BUILDING: AtomicBool = AtomicBool::new(false);
/// 已扫描条数（建索引过程实时递增，供前端展示进度）。
static IDX_SCANNED: AtomicUsize = AtomicUsize::new(0);

/// 无价值目录（按目录名匹配，任意层级生效），保持索引精简。
/// 唯一定义处：目录遍历（walk_roots）与 USN 直读（usn_index::try_build）两条构建路径共用，
/// 避免两份列表各自演化导致索引口径不一致。
///
/// 2026-09-16 扩充：原 3 项只挡掉系统目录，实测 299 万条索引使宿主进程私有内存高达
/// 584MB。新增程序目录 / 包管理 / 构建产物等「文件量大、文件名无检索价值」的目录名 ——
/// 可执行文件的启动入口由开始菜单快捷方式与桌面文件覆盖，不依赖全路径检索。
/// 注意：按名字匹配是全层级的，用户若真有名为 cache 的资料目录也会被跳过 ——
/// 对启动器场景可接受，换来内存占用大幅下降。
pub(crate) const SKIP: [&str; 13] = [
    // 系统目录
    "system volume information", "$recycle.bin", "windows", "perflogs", "recovery",
    // 程序与全局组件（按文件名检索无意义，启动入口走开始菜单/桌面）
    "program files", "program files (x86)", "programdata",
    // 包管理与构建产物
    "node_modules", ".git", "target",
    // 缓存与临时目录（浏览器/工具缓存文件量极大）
    "cache", "temp",
];

/// 索引总量上限：达到即停止扫描，给内存占用一个硬上界。
/// 100 万条约对应 200MB 常驻内存（路径 String + 小写名缓冲）；配合 SKIP 过滤，
/// 日常机器通常远达不到此值，上限只是兜底。
pub(crate) const MAX_ENTRIES: usize = 1_000_000;

/// 枚举本地固定盘（NTFS/FAT），返回类似 `C:\` 的根。
pub(crate) fn fixed_drives() -> Vec<String> {
    let mut out = Vec::new();
    for c in 'A'..='Z' {
        let mut w: Vec<u16> = Vec::with_capacity(4);
        w.push(c as u16);
        w.push(':' as u16);
        w.push('\\' as u16);
        w.push(0);
        let t = unsafe { GetDriveTypeW(PCWSTR(w.as_ptr())) };
        if t == DRIVE_FIXED {
            out.push(format!("{c}:\\"));
        }
    }
    out
}

/// 迭代遍历一个目录树，收集所有路径；`scanned` 实时递增。
/// 达到 MAX_ENTRIES 即整体停止，保证内存上界。
fn walk_roots(roots: &[String]) -> Vec<Hit> {
    let mut out = Vec::new();
    let mut stack: Vec<PathBuf> = roots.iter().map(PathBuf::from).collect();
    'outer: while let Some(dir) = stack.pop() {
        let rd = match std::fs::read_dir(&dir) {
            Ok(r) => r,
            Err(_) => continue,
        };
        for entry in rd {
            if out.len() >= MAX_ENTRIES {
                break 'outer;
            }
            let entry = match entry {
                Ok(e) => e,
                Err(_) => continue,
            };
            let low = entry.file_name().to_string_lossy().to_lowercase();
            if SKIP.contains(&low.as_str()) {
                continue;
            }
            let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
            let path = entry.path().to_string_lossy().into_owned();
            out.push(Hit { path, is_dir });
            IDX_SCANNED.fetch_add(1, Ordering::Relaxed);
            if is_dir {
                stack.push(entry.path());
            }
        }
        // 大目录下让出时间片，避免压低整机 IO；间隔随条目量加大
        if out.len() % 4096 == 0 {
            std::thread::yield_now();
        }
    }
    out
}

/// 快照行格式：`D|<path>` 目录，`F|<path>` 文件。
fn save_snapshot(dir: &std::path::Path, entries: &[Hit]) -> std::io::Result<()> {
    let f = File::create(dir.join(SNAPSHOT))?;
    let mut w = BufWriter::new(f);
    for e in entries {
        writeln!(w, "{}{}", if e.is_dir { "D|" } else { "F|" }, e.path)?;
    }
    w.flush()
}

fn load_snapshot(dir: &std::path::Path) -> Option<Vec<Hit>> {
    let f = File::open(dir.join(SNAPSHOT)).ok()?;
    let mut out = Vec::new();
    for line in BufReader::new(f).lines().flatten() {
        let Some(body) = line.strip_prefix("D|").or_else(|| line.strip_prefix("F|")) else {
            continue;
        };
        out.push(Hit { path: body.to_string(), is_dir: line.starts_with("D|") });
        IDX_SCANNED.fetch_add(1, Ordering::Relaxed);
    }
    if out.is_empty() { None } else { Some(out) }
    // 旧版无上限时生成的超限快照：按新口径作废，触发重建（commit 后会重写小快照）
    // 注：判断放在读取完成后，避免边读边判造成口径混乱
}

fn load_snapshot_checked(dir: &std::path::Path) -> Option<Vec<Hit>> {
    match load_snapshot(dir) {
        Some(entries) if entries.len() > MAX_ENTRIES => {
            println!("[file_index] 快照 {} 条超过上限 {}，作废重建", entries.len(), MAX_ENTRIES);
            None
        }
        other => other,
    }
}

fn commit(entries: Vec<Hit>, roots: Vec<String>) {
    // 小写名索引在**锁外**构建：3M 条约 173ms，持锁构建会阻塞并发搜索与 index_status 轮询
    let names = build_name_index(&entries);
    let mut g = idx_lock();
    g.entries = Arc::new(entries);
    g.names = Arc::new(names);
    g.roots = roots;
    g.ready = true;
}

/// 建索引：优先 USN/MFT 直读（方案 C，需管理员权限，秒级）；失败回退到目录遍历（方案 A）。
fn build_entries() -> Vec<Hit> {
    crate::usn_index::try_build().unwrap_or_else(|| walk_roots(&fixed_drives()))
}

pub fn start_index(app: AppHandle) {
    std::thread::spawn(move || {
        IDX_BUILDING.store(true, Ordering::Relaxed);
        IDX_SCANNED.store(0, Ordering::Relaxed);
        let roots = fixed_drives();
        let dir = app.path().app_data_dir().ok();
        // 有快照则秒恢复，避免每次启动整盘重扫；否则首次全量建。
        // 超过 MAX_ENTRIES 的旧快照作废重建（load_snapshot_checked）。
        let entries = dir.as_ref().map(|d| d.as_path()).and_then(load_snapshot_checked).unwrap_or_else(build_entries);
        commit(entries, roots);
        IDX_BUILDING.store(false, Ordering::Relaxed);
        if let Some(d) = dir {
            let snap = { let g = idx_lock(); Arc::clone(&g.entries) };
            let _ = save_snapshot(&d, &snap);
        }
    });
}

/// 手动重建索引：清空旧索引后台整盘重扫，适合热插盘/大改动后刷新。
#[tauri::command]
pub fn rebuild_index(app: AppHandle) -> bool {
    if IDX_BUILDING.swap(true, Ordering::Relaxed) {
        return false; // 已在构建中
    }
    IDX_SCANNED.store(0, Ordering::Relaxed);
    std::thread::spawn(move || {
        {
            let mut g = idx_lock();
            g.ready = false;
            g.entries = Arc::new(Vec::new());
            g.names = Arc::new(NameIndex::default());
        }
        let roots = fixed_drives();
        let entries = build_entries();
        commit(entries, roots);
        IDX_BUILDING.store(false, Ordering::Relaxed);
        if let Some(d) = app.path().app_data_dir().ok() {
            let snap = { let g = idx_lock(); Arc::clone(&g.entries) };
            let _ = save_snapshot(&d, &snap);
        }
    });
    true
}

/// 查询索引状态：ready / building / scanned / count / roots。
#[tauri::command]
pub fn index_status() -> serde_json::Value {
    let g = idx_lock();
    serde_json::json!({
        "ready": g.ready,
        "building": IDX_BUILDING.load(Ordering::Relaxed),
        "scanned": IDX_SCANNED.load(Ordering::Relaxed),
        "count": g.entries.len(),
        "roots": g.roots,
    })
}

/// 在**已小写**的 hay 中做子串匹配：首字节快速跳过 + 切片比较（编译为 memcmp）。
/// 比「逐字节 to_ascii_lowercase 的手写双层循环」快约 3 倍
/// （实测 3M 条：deskoverlay 135ms → 42ms，无命中查询 543ms → 58ms）。
/// 正确性：调用方须保证 hay 与 needle 都已 ASCII 小写化。中文等多字节字符
/// 不含 < 0x80 的字节，故 ASCII 查询词不可能在字符内部产生错位命中 ——
/// 与「边比较边小写」的朴素实现语义一致。
fn contains_lower(hay: &[u8], needle: &[u8]) -> bool {
    let nlen = needle.len();
    if nlen == 0 {
        return true;
    }
    if hay.len() < nlen {
        return false;
    }
    let first = needle[0];
    let last = hay.len() - nlen;
    let mut k = 0;
    while k <= last {
        if hay[k] == first && &hay[k..k + nlen] == needle {
            return true;
        }
        k += 1;
    }
    false
}

/// 路径趟走并行的最小索引规模 —— 低于此值线程调度开销盖过收益。
const PAR_MIN_ENTRIES: usize = 200_000;
/// 路径趟并行上限。超过 8 核再切分收益递减，反而挤占前台。
const PAR_MAX_THREADS: usize = 8;

/// 子串搜索；默认返回 200 条（上限 2000）。匹配「文件名或全路径」，
/// 文件名命中优先，其余由全路径命中按索引序补足 —— 与该函数的历史语义逐条等价。
/// async 使扫描运行在异步线程池，不阻塞 UI/输入。
///
/// 性能关键（2026-09-12 重构，基于 2,988,731 条 / 313.7MB 实测索引）：
/// 原实现两趟全量扫描，每趟都对每条现算「rsplit 取文件名 + 逐字节 to_ascii_lowercase」，
/// 少命中 / 无命中查询（逐字输入时最常见）要扫两遍近 300 万条，实测 475~511ms。
/// 三处改动：
///   1. 建索引时预计算小写文件名（NameIndex），名趟退化为纯切片比较（contains_lower）；
///   2. 名趟满 cap 即刻返回，绝大多数常见查询止步于此；
///   3. 路径趟切块并行 —— 单线程要把近 314MB 路径整体小写化，是剩余耗时的大头。
/// 实测（10 个查询逐条对照旧实现，结果集与顺序完全一致，3 轮零抖动）：
///   中文 `采购` 511ms → 97ms（5.2×）、`会议纪要` 477ms → 90ms、无命中 `zzzqqq` 509ms → 109ms。
///
/// ⚠ 全路径趟不可省：仅按文件名匹配会漏掉「位于同名目录下的文件」
/// （实测 `采购` 69 命中 → 43，`会议纪要` 24 → 10），而这类文档正是主要检索目标。
#[tauri::command]
pub async fn search_files(query: String, limit: Option<usize>) -> Vec<Hit> {
    let cap = limit.unwrap_or(200).clamp(1, 2000);
    let q = query.trim().to_ascii_lowercase();
    if q.is_empty() {
        return Vec::new();
    }
    let needle = q.as_bytes();

    // 锁外用快照扫描：短锁拿到 Arc，速出锁，再遍历同一份数据，避免持锁与并发互扰
    let (entries, names) = {
        let g = idx_lock();
        if !g.ready {
            return Vec::new();
        }
        (Arc::clone(&g.entries), Arc::clone(&g.names))
    };
    let count = entries.len();

    // 一致性防御：names 与 entries 必须成对（commit / rebuild_index 均成对更新）
    if names.offs.len() != count + 1 || count == 0 {
        return Vec::new();
    }

    let nlen = needle.len();
    // ── 第 1 趟：文件名。命中即收，凑满 cap 直接返回（最常见路径，无需路径趟）──
    let mut hits: Vec<usize> = Vec::with_capacity(cap);
    for i in 0..count {
        let s = names.offs[i] as usize;
        let e = names.offs[i + 1] as usize;
        if e - s >= nlen && contains_lower(&names.buf[s..e], needle) {
            hits.push(i);
            if hits.len() >= cap {
                return hits.into_iter().map(|i| entries[i].clone()).collect();
            }
        }
    }

    // ── 第 2 趟：全路径补充。跳过已命中的索引，按索引序补足剩余名额 ──
    let need = cap - hits.len();
    let extra = path_pass(&entries, needle, &hits, need);
    for &i in extra.iter().take(need) {
        hits.push(i);
    }

    hits.into_iter().map(|i| entries[i].clone()).collect()
}

/// 全路径补充趟：在**文件名未命中**的条目中找路径含 `needle` 的，返回索引升序结果。
/// `skip` 是名趟已收的索引（升序），命中即跳过，故两趟结果天然不重复
/// （原实现要在第二趟做 O(cap) 的 `contains` 去重）。
///
/// 索引够大时按块并行。各块自留前 `need` 条后按块序拼接 —— 块内、块间索引都递增，
/// 故「拼接后取前 need 条」== 全局索引序的前 need 条，与单线程结果一致。
fn path_pass(entries: &[Hit], needle: &[u8], skip: &[usize], need: usize) -> Vec<usize> {
    let count = entries.len();
    if need == 0 || count == 0 {
        return Vec::new();
    }
    let threads = if count >= PAR_MIN_ENTRIES {
        std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(1)
            .clamp(1, PAR_MAX_THREADS)
    } else {
        1
    };
    if threads <= 1 {
        let mut v = Vec::with_capacity(need);
        scan_path_chunk(entries, needle, skip, 0, count, need, &mut v);
        return v;
    }

    let per = count.div_ceil(threads);
    let mut parts: Vec<Vec<usize>> = Vec::with_capacity(threads);
    std::thread::scope(|sc| {
        let mut hs = Vec::with_capacity(threads);
        for c in 0..threads {
            let lo = c * per;
            if lo >= count {
                break;
            }
            let hi = ((c + 1) * per).min(count);
            hs.push(sc.spawn(move || {
                let mut v = Vec::new();
                scan_path_chunk(entries, needle, skip, lo, hi, need, &mut v);
                v
            }));
        }
        for h in hs {
            // 子线程 panic 时降级为「该块无结果」，不牵连整次查询
            parts.push(h.join().unwrap_or_default());
        }
    });

    let mut v = Vec::with_capacity(need);
    for p in parts {
        v.extend(p);
        if v.len() >= need {
            break;
        }
    }
    v
}

/// 扫描 `entries[lo..hi]` 的**全路径**，把命中索引（≤ `need` 条）推入 `out`。
/// `skip` 为升序已命中索引；与 `lo..hi` 同为升序，用游标线性推进即可 O(1) 判定该条是否已收。
/// 路径小写化走复用的 `lbuf`，避免每条一次堆分配。
fn scan_path_chunk(
    entries: &[Hit],
    needle: &[u8],
    skip: &[usize],
    lo: usize,
    hi: usize,
    need: usize,
    out: &mut Vec<usize>,
) {
    let mut sk = skip.partition_point(|&x| x < lo);
    let mut lbuf: Vec<u8> = Vec::with_capacity(128);
    for i in lo..hi {
        if sk < skip.len() && skip[sk] == i {
            sk += 1;
            continue;
        }
        lbuf.clear();
        lbuf.extend(entries[i].path.bytes().map(|b| b.to_ascii_lowercase()));
        if contains_lower(&lbuf, needle) {
            out.push(i);
            if out.len() >= need {
                return;
            }
        }
    }
}