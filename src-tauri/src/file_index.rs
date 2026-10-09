//! 全盘文件名索引：后台遍历本地固定盘建内存索引，快照落盘 fileindex.txt 供下次秒恢复。
//!
//! 命令：
//!   index_status()        —— 就绪/进度/根目录（同时触发懒加载）
//!   search_files(query)   —— 子串匹配文件名或全路径，返回前 N 条
//!   rebuild_index()       —— 手动全量重建
//!
//! 两条结构约定：
//!   1. 懒加载：setup 只登记数据目录，读快照 / 建索引推迟到首次全盘搜索。
//!   2. 扁平存储：路径存在一个字节 arena + u32 偏移表里，不是每条一个 String。
//!
//! 首次全盘建完即内存驻留，搜索为即时子串过滤。

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

/// 命中结果，命令返回给前端。
#[derive(Clone, Serialize)]
pub struct Hit {
    pub path: String,
    pub is_dir: bool,
}

/// 扁平路径索引：所有路径首尾相接存在一个 `Vec<u8>` 里，`offs` 是偏移表
/// （长度 = 条数 + 1，故 `offs[i]..offs[i+1]` 即第 i 条路径），目录标记存 bitset。
struct FlatIndex {
    arena: Vec<u8>,
    offs: Vec<u32>,
    /// 第 i 位为 1 表示 entries[i] 是目录。
    dirs: Vec<u64>,
}
impl Default for FlatIndex {
    fn default() -> Self {
        Self { arena: Vec::new(), offs: vec![0], dirs: Vec::new() }
    }
}
impl FlatIndex {
    fn len(&self) -> usize {
        self.offs.len() - 1
    }
    /// 第 i 条路径的原始字节（UTF-8）。
    fn path_bytes(&self, i: usize) -> &[u8] {
        &self.arena[self.offs[i] as usize..self.offs[i + 1] as usize]
    }
    /// 第 i 条路径，仅在确实需要拥有所有权的字符串时用（构建搜索结果 / 快照）。
    fn path_string(&self, i: usize) -> String {
        String::from_utf8_lossy(self.path_bytes(i)).into_owned()
    }
    fn is_dir(&self, i: usize) -> bool {
        self.dirs[i >> 6] >> (i & 63) & 1 == 1
    }
}

/// 索引主体：`paths` / `names` / `roots` 就绪后整体替换。
/// `paths` 与 `names` 必须成对更新（见 search_files 的一致性防御）。
pub struct IndexInner {
    ready: bool,
    paths: Arc<FlatIndex>,
    /// 与 `paths` 一一对应的小写文件名索引。
    names: Arc<NameIndex>,
    roots: Vec<String>,
}
impl Default for IndexInner {
    fn default() -> Self {
        Self {
            ready: false,
            paths: Arc::new(FlatIndex::default()),
            names: Arc::new(NameIndex::default()),
            roots: Vec::new(),
        }
    }
}

/// 预计算的小写文件名索引：`buf` 是所有文件名小写化后首尾相接的缓冲，
/// `offs` 为偏移表（长度 = 条数 + 1，故 `offs[i]..offs[i+1]` 即第 i 条的文件名）。
/// 建索引时算一次，查询时只做纯字节比较。
#[derive(Default)]
struct NameIndex {
    buf: Vec<u8>,
    offs: Vec<u32>,
}
impl NameIndex {
    fn len(&self) -> usize {
        self.offs.len().saturating_sub(1)
    }
}

/// 一次构建的产物：扁平路径索引 + 小写名索引。
struct BuiltIndex {
    paths: FlatIndex,
    names: NameIndex,
}

/// 从 `Vec<Hit>` 构建扁平索引与小写名索引。
/// 路径先按全路径字典序排序：同目录条目相邻，搜索结果顺序即字典序。
/// 名字索引与路径索引在同一轮构建，保证两者一一对应。
fn build_flat_index(entries: &mut Vec<Hit>) -> BuiltIndex {
    entries.sort_unstable_by(|a, b| a.path.cmp(&b.path));

    let count = entries.len();
    let path_bytes: usize = entries.iter().map(|e| e.path.len()).sum();
    let name_bytes: usize = entries
        .iter()
        .map(|e| e.path.rsplit(['\\', '/']).next().map(|n| n.len()).unwrap_or(0))
        .sum();

    let mut paths = FlatIndex {
        arena: Vec::with_capacity(path_bytes),
        offs: vec![0],
        dirs: vec![0u64; count.div_ceil(64)],
    };
    let mut names = NameIndex {
        buf: Vec::with_capacity(name_bytes),
        offs: vec![0],
    };

    for (i, e) in entries.iter().enumerate() {
        let b = e.path.as_bytes();
        // 每写入一条就追加一个收尾偏移，于是 offs[i]..offs[i+1] 即第 i 条
        paths.arena.extend_from_slice(b);
        paths.offs.push(paths.arena.len() as u32);
        if e.is_dir {
            paths.dirs[i >> 6] |= 1u64 << (i & 63);
        }
        let name = match b.iter().rposition(|&c| c == b'\\' || c == b'/') {
            Some(pos) => &b[pos + 1..],
            None => b,
        };
        names.buf.extend(name.iter().map(|c| c.to_ascii_lowercase()));
        names.offs.push(names.buf.len() as u32);
    }
    paths.arena.shrink_to_fit();
    names.buf.shrink_to_fit();

    BuiltIndex { paths, names }
}

static IDX: OnceLock<Arc<Mutex<IndexInner>>> = OnceLock::new();
fn idx() -> &'static Arc<Mutex<IndexInner>> {
    IDX.get_or_init(|| Arc::new(Mutex::new(IndexInner::default())))
}
/// 取锁；锁被 panic 污染时也继续用，避免搜索永久失效。
fn idx_lock() -> std::sync::MutexGuard<'static, IndexInner> {
    idx().lock().unwrap_or_else(|e| e.into_inner())
}
static IDX_BUILDING: AtomicBool = AtomicBool::new(false);
/// 已扫描条数（建索引过程实时递增，供前端展示进度）。
static IDX_SCANNED: AtomicUsize = AtomicUsize::new(0);
/// 应用数据目录（setup 时登记一次），供懒加载线程落盘 / 读取快照。
static IDX_DIR: OnceLock<PathBuf> = OnceLock::new();
/// 懒加载闸门：确保「加载快照 / 全量重建」只启动一次。
static IDX_STARTED: AtomicBool = AtomicBool::new(false);

/// 登记应用数据目录，不加载任何数据。
pub fn prime(app: &AppHandle) {
    if let Ok(d) = app.path().app_data_dir() {
        let _ = IDX_DIR.set(d);
    }
}

/// 懒加载入口：首次调用时启动后台线程，有快照则读快照，否则全盘重建。幂等。
fn ensure_started() {
    if IDX_STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || {
        IDX_BUILDING.store(true, Ordering::Relaxed);
        IDX_SCANNED.store(0, Ordering::Relaxed);
        let dir = IDX_DIR.get();
        let roots = fixed_drives();
        // 超限的快照会被 load_snapshot_checked 判为 None，转而全盘重建
        match dir.and_then(|d| load_snapshot_checked(d)) {
            Some(entries) => commit_entries(entries, roots),
            None => rebuild_and_commit(roots),
        }
    });
}

/// 把一批条目转成扁平索引并提交。
fn commit_entries(mut hits: Vec<Hit>, roots: Vec<String>) {
    let built = build_flat_index(&mut hits);
    drop(hits); // 路径数据已转进 arena，逐条 String 可以释放
    {
        let mut g = idx_lock();
        g.paths = Arc::new(built.paths);
        g.names = Arc::new(built.names);
        g.roots = roots;
        g.ready = true;
    }
    IDX_BUILDING.store(false, Ordering::Relaxed);
}

/// 不建索引的目录名（按名字匹配，任意层级生效）。目录遍历与 USN 直读两条构建路径共用。
pub(crate) const SKIP: [&str; 13] = [
    // 系统目录
    "system volume information", "$recycle.bin", "windows", "perflogs", "recovery",
    // 程序与全局组件
    "program files", "program files (x86)", "programdata",
    // 包管理与构建产物
    "node_modules", ".git", "target",
    // 缓存与临时目录
    "cache", "temp",
];

/// 索引条数上限：达到即停止扫描。
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

/// 快照行格式：`D|<path>` 目录，`F|<path>` 文件，首行为 `#<条数>`。
/// 读取只认 `D|` / `F|` 前缀，头部行会被跳过。
fn save_snapshot(dir: &std::path::Path, entries: &[Hit]) -> std::io::Result<()> {
    let f = File::create(dir.join(SNAPSHOT))?;
    let mut w = BufWriter::new(f);
    writeln!(w, "#{}", entries.len())?;
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
}

/// 读快照并校验条数上限；超限视为不可用（返回 None 触发全盘重建）。
fn load_snapshot_checked(dir: &std::path::Path) -> Option<Vec<Hit>> {
    match load_snapshot(dir) {
        Some(entries) if entries.len() > MAX_ENTRIES => {
            // eprintln 而非 println：GUI 子系统下 stdout 句柄无效，println 会 panic
            eprintln!("[file_index] 快照 {} 条超过上限 {}，作废重建", entries.len(), MAX_ENTRIES);
            None
        }
        other => other,
    }
}

/// 建索引：优先 USN/MFT 直读（需管理员权限），失败回退到目录遍历。
fn build_entries() -> Vec<Hit> {
    crate::usn_index::try_build().unwrap_or_else(|| walk_roots(&fixed_drives()))
}

/// 手动重建索引：清空旧索引后台整盘重扫。
#[tauri::command]
pub fn rebuild_index() -> bool {
    if IDX_BUILDING.swap(true, Ordering::Relaxed) {
        return false; // 已在构建中
    }
    // 一并压住懒加载闸门，避免与懒加载线程同时构建
    IDX_STARTED.store(true, Ordering::SeqCst);
    IDX_SCANNED.store(0, Ordering::Relaxed);
    std::thread::spawn(move || {
        // 先置为未就绪：重建期间前端不应把未完成结果当可用
        {
            let mut g = idx_lock();
            g.ready = false;
            g.paths = Arc::new(FlatIndex::default());
            g.names = Arc::new(NameIndex::default());
        }
        rebuild_and_commit(fixed_drives());
    });
    true
}

/// 全量重建：扫描 → 落快照 → 转扁平 → 提交。懒加载与手动重建共用。
/// 调用前须已置位 `IDX_BUILDING`；本函数负责在结束时清掉它。
fn rebuild_and_commit(roots: Vec<String>) {
    let dir = IDX_DIR.get();
    let hits = build_entries();
    // 趁 Vec<Hit> 还在手里落盘，省去从扁平表示重建快照
    if let Some(d) = dir {
        if let Err(e) = save_snapshot(d, &hits) {
            eprintln!("[file_index] 快照落盘失败：{e}");
        }
    }
    commit_entries(hits, roots);
}

/// 索引状态：ready / building / scanned / count / roots。同时触发懒加载。
#[tauri::command]
pub fn index_status() -> serde_json::Value {
    ensure_started();
    let g = idx_lock();
    serde_json::json!({
        "ready": g.ready,
        "building": IDX_BUILDING.load(Ordering::Relaxed),
        "scanned": IDX_SCANNED.load(Ordering::Relaxed),
        "count": g.paths.len(),
        "roots": g.roots,
    })
}

/// 在已小写的 hay 中查子串：首字节快速跳过 + 切片比较（memcmp）。
/// 要求 `hay` 与 `needle` 都已 ASCII 小写化。中文等多字节字符不含 < 0x80 的字节，
/// 故 ASCII 查询词不会在字符内部错位命中。
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
/// 路径趟并行上限。超过 8 核再切分收益递减。
const PAR_MAX_THREADS: usize = 8;

/// 子串搜索；默认返回 200 条（上限 2000）。文件名命中优先，其余由全路径命中按索引序补足。
/// 结果顺序为索引序（即全路径字典序）。
/// 两趟：名趟用预计算的小写文件名做纯切片比较，凑满 cap 即返回；
/// 不够再走路径趟，在文件名未命中的条目里按全路径补足 —— 只按文件名匹配会漏掉
/// 「位于同名目录下的文件」。async 使扫描不阻塞 UI 线程。
#[tauri::command]
pub async fn search_files(query: String, limit: Option<usize>) -> Vec<Hit> {
    ensure_started(); // 懒加载：首次搜索才开始读快照 / 建索引
    let cap = limit.unwrap_or(200).clamp(1, 2000);
    let q = query.trim().to_ascii_lowercase();
    if q.is_empty() {
        return Vec::new();
    }
    let needle = q.as_bytes();

    // 锁内只取 Arc 快照，扫描在锁外进行
    let (paths, names) = {
        let g = idx_lock();
        if !g.ready {
            return Vec::new();
        }
        (Arc::clone(&g.paths), Arc::clone(&g.names))
    };
    let count = paths.len();

    // names 与 paths 必须等长且成对更新
    if names.len() != count || count == 0 {
        return Vec::new();
    }

    let nlen = needle.len();
    // 第 1 趟：文件名
    let mut hits: Vec<usize> = Vec::with_capacity(cap);
    for i in 0..count {
        let s = names.offs[i] as usize;
        let e = names.offs[i + 1] as usize;
        if e - s >= nlen && contains_lower(&names.buf[s..e], needle) {
            hits.push(i);
            if hits.len() >= cap {
                return hits_to_hits(&paths, &hits);
            }
        }
    }

    // 第 2 趟：全路径补充（跳过第 1 趟已收的索引）
    let need = cap - hits.len();
    let extra = path_pass(&paths, needle, &hits, need);
    for &i in extra.iter().take(need) {
        hits.push(i);
    }

    hits_to_hits(&paths, &hits)
}

/// 索引序 → 返回结果。只在最终命中集（≤ cap）上构造字符串。
fn hits_to_hits(paths: &FlatIndex, idxs: &[usize]) -> Vec<Hit> {
    idxs.iter()
        .map(|&i| Hit { path: paths.path_string(i), is_dir: paths.is_dir(i) })
        .collect()
}

/// 全路径补充趟：在文件名未命中的条目中找路径含 `needle` 的，返回索引升序结果。
/// `skip` 为名趟已收的索引（升序），命中即跳过，故两趟结果不重复。
/// 索引够大时按块并行；各块自留前 `need` 条后按块序拼接，结果等同全局索引序的前 need 条。
fn path_pass(paths: &FlatIndex, needle: &[u8], skip: &[usize], need: usize) -> Vec<usize> {
    let count = paths.len();
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
        scan_path_chunk(paths, needle, skip, 0, count, need, &mut v);
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
                scan_path_chunk(paths, needle, skip, lo, hi, need, &mut v);
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

/// 扫描 `paths[lo..hi]` 的全路径，把命中索引（最多 `need` 条）推入 `out`。
/// `skip` 为升序的已命中索引，用游标线性推进判重。小写化走复用的 `lbuf`。
fn scan_path_chunk(
    paths: &FlatIndex,
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
        lbuf.extend(paths.path_bytes(i).iter().map(|b| b.to_ascii_lowercase()));
        if contains_lower(&lbuf, needle) {
            out.push(i);
            if out.len() >= need {
                return;
            }
        }
    }
}

// ============================ 单测 ============================
// 扁平索引是有损转换（Vec<Hit> → arena/offs/dirs），故钉住不变量。
#[cfg(test)]
mod tests {
    use super::*;

    fn hits(items: &[(&str, bool)]) -> Vec<Hit> {
        items.iter().map(|(p, d)| Hit { path: p.to_string(), is_dir: *d }).collect()
    }

    /// 排序、偏移表、位图、名索引四者一致。
    #[test]
    fn flat_index_round_trip() {
        let mut src = hits(&[
            (r"C:\Users\me\notes.md", false),
            (r"C:\Users\me\Projects", true),
            (r"C:\Users\me\Projects\a.txt", false),
            (r"D:\Media\Photos", true),
            (r"C:\BOOT.INI", false),
        ]);
        let mut sorted: Vec<String> = src.iter().map(|h| h.path.clone()).collect();
        sorted.sort();
        let built = build_flat_index(&mut src);

        assert_eq!(built.paths.len(), 5);
        assert_eq!(built.names.len(), 5);
        // 偏移表长度 = 条数 + 1，且首项为 0、末项为 arena 长度
        assert_eq!(built.paths.offs.len(), 6);
        assert_eq!(built.paths.offs[0], 0);
        assert_eq!(*built.paths.offs.last().unwrap() as usize, built.paths.arena.len());
        // 按字典序排列；路径逐条可无损取回；目录标记跟着路径走（不被排序打乱）
        for (i, want) in sorted.iter().enumerate() {
            assert_eq!(&built.paths.path_string(i), want, "第 {i} 条路径");
            let is_dir = want == r"C:\Users\me\Projects" || want == r"D:\Media\Photos";
            assert_eq!(built.paths.is_dir(i), is_dir, "第 {i} 条目录标记：{want}");
        }
        // 小写名索引与路径一一对应，且取的是最后一段
        assert_eq!(built.names.len(), built.paths.len());
        for i in 0..built.paths.len() {
            let s = built.names.offs[i] as usize;
            let e = built.names.offs[i + 1] as usize;
            let name = std::str::from_utf8(&built.names.buf[s..e]).unwrap();
            let full = built.paths.path_string(i);
            let want = full.rsplit(['\\', '/']).next().unwrap().to_ascii_lowercase();
            assert_eq!(name, want, "第 {i} 条名索引");
        }
    }

    /// 空输入与单条输入的边界。
    #[test]
    fn flat_index_edge_sizes() {
        let mut empty: Vec<Hit> = Vec::new();
        let built = build_flat_index(&mut empty);
        assert_eq!(built.paths.len(), 0);
        assert_eq!(built.paths.offs, vec![0]);
        assert_eq!(built.names.offs, vec![0]);
        assert!(path_pass(&built.paths, b"x", &[], 10).is_empty());

        // 无目录分隔符的相对路径（理论输入）：名索引退化为整串
        let mut one = hits(&[("README", false)]);
        let built = build_flat_index(&mut one);
        assert_eq!(built.paths.len(), 1);
        assert_eq!(&built.names.buf[..], b"readme");
        assert!(!built.paths.is_dir(0));
    }

    /// 多字节路径：偏移落在 UTF-8 字符边界上，小写化只作用于 ASCII 字节。
    #[test]
    fn flat_index_multibyte_paths() {
        let mut src = hits(&[
            (r"C:\用户\文档\会议纪要.md", false),
            (r"C:\用户\文档\Report Final.PDF", false),
            (r"C:\用户\图片", true),
        ]);
        let built = build_flat_index(&mut src);
        assert_eq!(built.paths.len(), 3);
        // 逐条取回必须无损（from_utf8_lossy 若切错边界会插入 U+FFFD）
        let mut got: Vec<(String, bool)> = (0..built.paths.len())
            .map(|i| (built.paths.path_string(i), built.paths.is_dir(i)))
            .collect();
        got.sort();
        let mut want: Vec<(String, bool)> =
            src.iter().map(|h| (h.path.clone(), h.is_dir)).collect();
        want.sort();
        assert_eq!(got, want);
        for (path, _) in &got {
            assert!(!path.contains('\u{FFFD}'), "路径被截断在字符中间：{path}");
        }
        // ASCII 大小写被抹平，中文原样保留
        let names = String::from_utf8(built.names.buf.clone()).unwrap();
        assert!(names.contains("会议纪要.md"));
        assert!(names.contains("report final.pdf"));
        assert!(names.contains("图片"));
    }

    /// 两趟扫描：名趟先收，路径趟跳过已收索引并按索引序补足。
    #[test]
    fn search_two_passes_dedupe() {
        let mut src = hits(&[
            (r"C:\work\采购清单.xlsx", false),
            (r"C:\work\采购\report.pdf", false),
            (r"C:\work\random.txt", false),
        ]);
        let built = build_flat_index(&mut src);
        let needle = "采购".as_bytes();

        // 名趟：只有第 1 条文件名含「采购」
        let mut named: Vec<usize> = Vec::new();
        for i in 0..built.paths.len() {
            let s = built.names.offs[i] as usize;
            let e = built.names.offs[i + 1] as usize;
            if contains_lower(&built.names.buf[s..e], needle) {
                named.push(i);
            }
        }
        // 路径趟：补上「目录名命中、文件名不含查询词」的那一条
        let extra = path_pass(&built.paths, needle, &named, 10);
        assert_eq!(extra.len(), 1, "路径趟应补齐名趟漏掉的一条：{extra:?}");
        for &i in &extra {
            assert!(!named.contains(&i), "路径趟不该重复名趟已收的条目");
            assert!(built.paths.path_string(i).contains("采购"));
            // 名趟漏掉的原因必须是「文件名不含查询词」，而不是扫描漏读
            let s = built.names.offs[i] as usize;
            let e = built.names.offs[i + 1] as usize;
            assert!(!contains_lower(&built.names.buf[s..e], needle));
        }
        // 名趟全部是文件名命中；加上路径趟后恰好命中两条（`random.txt` 不含查询词）
        assert_eq!(named.len(), 1);
        assert!(built.paths.path_string(named[0]).contains("采购清单"));
    }
}