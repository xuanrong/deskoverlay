//! 扁平索引内存实测（按需手动跑）：
//!
//! ```bash
//! cd src-tauri && cargo run --release --example index_mem
//! ```
//!
//! 用合成路径（默认 867,408 条）对比「逐条 String」与「扁平 arena + 偏移表」两种表示的占用。
//! 读数口径：① / ③ 是进程私有提交（受分配器缓存影响），② 是按容器容量算出的结构体占用。

use std::mem::size_of;

/// 复制 `file_index.rs` 的 Hit 形状（示例不能访问 bin crate 的私有模块）。
struct Hit {
    path: String,
    is_dir: bool,
}

/// 与本机 %APPDATA%\com.deskovery.desktop\fileindex.txt 同规模的合成路径：
/// 867,408 条、平均全路径 116.8 字节。
///
/// 关键的分布特征（决定两种表示的差距）：**文件名很短、目录前缀很长** ——
/// 真实快照里文件名平均约 17 字节，剩下 ~100 字节都是各条共享的目录前缀。
/// 小写名缓冲的大小只由文件名决定，所以名字必须按真实长度生成，否则会低估扁平化的收益。
fn build_synth(count: usize, avg_len: usize) -> Vec<Hit> {
    let mut out = Vec::with_capacity(count);
    let mut dirs = 0usize;
    let mut i = 0usize;
    // 目录前缀长度按 avg_len 反推：平均文件名 17 字节，其余留给目录
    let prefix_len = avg_len.saturating_sub(17);
    while out.len() < count {
        let mut dir = format!(r"C:\TraeProjects\deskoverlay\data\batch{dirs:05}\nested\deeper\leaf");
        while dir.len() < prefix_len {
            dir.push('d');
        }
        if out.len() < count {
            out.push(Hit { path: dir.clone(), is_dir: true });
        }
        dirs += 1;
        for k in 0..109 {
            if out.len() >= count {
                break;
            }
            // 短文件名：约 14~18 字节，与真实快照一致
            let name = format!("f{i:06}_{k:03}.json");
            out.push(Hit { path: format!("{dir}\\{name}"), is_dir: false });
            i += 1;
        }
    }
    out
}

fn rss_mb() -> f64 {
    // Windows 上读 PrivateUsage（私有提交），比 WorkingSet 更贴近「这个进程自己的内存」
    #[cfg(windows)]
    {
        use std::mem::MaybeUninit;
        #[repr(C)]
        struct ProcessMemoryCountersEx {
            cb: u32,
            page_fault_count: u32,
            peak_working_set_size: usize,
            working_set_size: usize,
            quota_peak_paged_pool_usage: usize,
            quota_paged_pool_usage: usize,
            quota_peak_non_paged_pool_usage: usize,
            quota_non_paged_pool_usage: usize,
            pagefile_usage: usize,
            peak_pagefile_usage: usize,
            private_usage: usize,
        }
        extern "system" {
            fn GetCurrentProcess() -> isize;
            fn K32GetProcessMemoryInfo(h: isize, c: *mut ProcessMemoryCountersEx, cb: u32) -> i32;
        }
        unsafe {
            let mut c = MaybeUninit::<ProcessMemoryCountersEx>::zeroed();
            let p = c.as_mut_ptr();
            (*p).cb = size_of::<ProcessMemoryCountersEx>() as u32;
            if K32GetProcessMemoryInfo(GetCurrentProcess(), p, (*p).cb) != 0 {
                return (*p).private_usage as f64 / 1024.0 / 1024.0;
            }
        }
    }
    0.0
}

fn main() {
    let count: usize = std::env::args()
        .nth(1)
        .and_then(|a| a.parse().ok())
        .unwrap_or(867_408);
    let avg_len: usize = std::env::args()
        .nth(2)
        .and_then(|a| a.parse().ok())
        .unwrap_or(117);

    println!("=== 扁平索引内存实测 ===");
    println!("条目数 {count}，目标平均路径长度 {avg_len} 字节");

    let base = rss_mb();
    let mut hits = build_synth(count, avg_len);
    let after_hits = rss_mb();
    let total_chars: usize = hits.iter().map(|h| h.path.len()).sum();
    let avg = total_chars as f64 / hits.len() as f64;
    println!(
        "① Vec<Hit>（逐条 String）: +{:.1} MB（{:.1} MB/条）  平均路径 {:.1} 字节",
        after_hits - base,
        (after_hits - base) * 1024.0 * 1024.0 / hits.len() as f64,
        avg
    );

    // 与 file_index::build_flat_index 相同的布局：arena + offs + dirs + 小写名缓冲
    hits.sort_unstable_by(|a, b| a.path.cmp(&b.path));
    let mut arena: Vec<u8> = Vec::with_capacity(total_chars);
    let mut offs: Vec<u32> = Vec::with_capacity(hits.len() + 1);
    offs.push(0);
    let mut dirs = vec![0u64; hits.len().div_ceil(64)];
    let mut nbuf: Vec<u8> = Vec::new();
    let mut noffs: Vec<u32> = Vec::with_capacity(hits.len() + 1);
    noffs.push(0);
    for (i, h) in hits.iter().enumerate() {
        let b = h.path.as_bytes();
        arena.extend_from_slice(b);
        offs.push(arena.len() as u32);
        if h.is_dir {
            dirs[i >> 6] |= 1u64 << (i & 63);
        }
        let name = match b.iter().rposition(|&c| c == b'\\' || c == b'/') {
            Some(p) => &b[p + 1..],
            None => b,
        };
        nbuf.extend(name.iter().map(|c| c.to_ascii_lowercase()));
        noffs.push(nbuf.len() as u32);
    }
    let flat_bytes = arena.capacity() + offs.capacity() * 4 + dirs.capacity() * 8 + nbuf.capacity() + noffs.capacity() * 4;
    println!(
        "② 扁平表示（arena+offs+dirs+名索引）: {:.1} MB = {:.1} MB/条  [arena {:.1} + offs {:.1} + dirs {:.1} + name {:.1} + noffs {:.1}]",
        flat_bytes as f64 / 1024.0 / 1024.0,
        flat_bytes as f64 / hits.len() as f64,
        arena.capacity() as f64 / 1048576.0,
        offs.capacity() as f64 * 4.0 / 1048576.0,
        dirs.capacity() as f64 * 8.0 / 1048576.0,
        nbuf.capacity() as f64 / 1048576.0,
        noffs.capacity() as f64 * 4.0 / 1048576.0,
    );

    // 释放逐条 String，观察真实回收量
    drop(hits);
    let after_flat = rss_mb();
    println!(
        "③ 释放 Vec<Hit> 后进程私有内存: {:.1} MB（相对基线 {:+.1} MB）",
        after_flat,
        after_flat - base
    );

    // ④ 快照兼容性：新版写入 `#<条数>` 头部，读取端按 D|/F| 前缀解析，
    //    必须能同时读回「新快照」与「旧快照（无头部）」，且条数一致。
    let dir = std::env::temp_dir().join("deskoverlay-index-mem");
    std::fs::create_dir_all(&dir).unwrap();
    let snap = dir.join("fileindex.txt");
    let sample: Vec<Hit> = build_synth(500, avg_len)
        .into_iter()
        .map(|h| Hit { path: h.path, is_dir: h.is_dir })
        .collect();
    {
        use std::io::Write;
        let mut w = std::io::BufWriter::new(std::fs::File::create(&snap).unwrap());
        writeln!(w, "#{}", sample.len()).unwrap();
        for h in &sample {
            writeln!(w, "{}{}", if h.is_dir { "D|" } else { "F|" }, h.path).unwrap();
        }
        w.flush().unwrap();
    }
    let read_new = count_snapshot_lines(&snap);
    // 旧格式：去掉头部行
    let lines: Vec<String> = std::fs::read_to_string(&snap).unwrap().lines().map(|s| s.to_string()).collect();
    std::fs::write(&snap, lines[1..].join("\r\n")).unwrap();
    let read_old = count_snapshot_lines(&snap);
    println!(
        "④ 快照往返：写入 {} 条 → 新格式读回 {} 条、旧格式读回 {} 条（应三者相等）",
        sample.len(),
        read_new,
        read_old
    );
    assert_eq!(read_new, sample.len(), "新格式（含 # 头部）读取条数不符");
    assert_eq!(read_old, sample.len(), "旧格式（无头部）读取条数不符");
    let _ = std::fs::remove_dir_all(&dir);

    println!("保留引用防止优化掉: arena[0]={} nbuf[0]={}", arena[0], nbuf[0]);
}

/// 复制 `file_index::load_snapshot` 的解析规则：只认 `D|` / `F|` 前缀，其余行（含新头部）跳过。
fn count_snapshot_lines(path: &std::path::Path) -> usize {
    use std::io::BufRead;
    let f = std::fs::File::open(path).unwrap();
    std::io::BufReader::new(f)
        .lines()
        .flatten()
        .filter(|l| l.starts_with("D|") || l.starts_with("F|"))
        .count()
}
