//! 音乐下载：流式落盘 + 进度事件 + 取消（设计见 .raccoon/music-download-design.md）。
//!
//! 关键约束（已核实）：
//! - http_get 走 read_to_string 文本通道，二进制会损坏 → 下载必须独立流式实现；
//! - ureq 阻塞式 I/O，任务在 spawn_blocking 线程执行，进度经 emit 回推；
//! - 下载目录 app_data_dir/music/（asset scope 开放 music/*），完成后 rename。

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use tauri::{AppHandle, Emitter, Manager};

/// 下载目录名（app_data_dir/music）
const MUSIC_DIR: &str = "music";
/// 下载中临时文件目录
const PART_DIR: &str = ".part";
/// 单文件大小上限（200MB 兜底，防异常直链写爆磁盘）
const MAX_SIZE: u64 = 200 * 1024 * 1024;
/// 进度事件节流：字节增量 ≥256KB 或时间 ≥200ms 才 emit
const PROGRESS_BYTES: u64 = 256 * 1024;
const PROGRESS_MS: u128 = 200;

/// 任务取消标志表：id → cancel flag（download_cancel 置位，任务线程轮询）
static TASKS: OnceLock<Mutex<HashMap<u64, Arc<AtomicBool>>>> = OnceLock::new();
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

fn tasks() -> &'static Mutex<HashMap<u64, Arc<AtomicBool>>> {
    TASKS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 下载根目录：app_data_dir/music
fn music_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("获取数据目录失败：{e}"))?
        .join(MUSIC_DIR);
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建下载目录失败：{e}"))?;
    Ok(dir)
}

/// 供跨模块使用（阿里云盘上传按文件名读取本地已下载歌曲）
pub fn music_dir_path(app: &AppHandle) -> Result<PathBuf, String> {
    music_dir(app)
}

/// 文件名安全化：剔除 Windows 非法字符与控制符，截断 120 字符，空名回退。
/// Rust 侧二次校验（前端已做一层），防路径穿越。
fn sanitize(name: &str) -> String {
    let mut s: String = name
        .chars()
        .filter(|c| {
            !matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
                && (*c as u32) >= 0x20
        })
        .collect();
    s = s.trim().trim_end_matches('.').to_string();
    if s.chars().count() > 120 {
        s = s.chars().take(120).collect();
    }
    if s.is_empty() {
        s = format!("download-{}", NEXT_ID.load(Ordering::Relaxed));
    }
    s
}

/// 从 URL path 尾部推断扩展名（.mp3/.flac/.m4a…），无则默认 .mp3。
fn ext_from_url(url: &str) -> String {
    let path = url.split(['?', '#']).next().unwrap_or("");
    let name = path.rsplit('/').next().unwrap_or("");
    match name.rsplit('.').next() {
        Some(e)
            if !e.is_empty()
                && e.len() <= 5
                && e.chars().all(|c| c.is_ascii_alphanumeric())
                && name.contains('.') =>
        {
            format!(".{}", e.to_ascii_lowercase())
        }
        _ => ".mp3".to_string(),
    }
}

/// 目标文件不存在则用原名；存在则追加 (1)、(2)…（不覆盖用户已有文件）。
fn dedupe(path: &Path) -> PathBuf {
    if !path.exists() {
        return path.to_path_buf();
    }
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "download".to_string());
    let ext = path
        .extension()
        .map(|s| format!(".{}", s.to_string_lossy()))
        .unwrap_or_default();
    for i in 1..1000u32 {
        let cand = path.with_file_name(format!("{stem} ({i}){ext}"));
        if !cand.exists() {
            return cand;
        }
    }
    path.with_file_name(format!("{stem} (dup){ext}"))
}

/// 下载任务主体（阻塞线程内执行）。lyric 非空时，下载成功后写同名 .lrc；
/// artwork_url 非空时抓取封面图存同名 .jpg/.png/.webp（离线播放有封面）。
fn run_download(app: AppHandle, id: u64, url: String, filename: String, headers: Option<serde_json::Value>, lyric: Option<String>, artwork_url: Option<String>) {
    let cancel = tasks().lock().ok().and_then(|m| m.get(&id).cloned());
    let cancel = match cancel {
        Some(c) => c,
        None => return,
    };

    let result = (|| -> Result<PathBuf, String> {
        let dir = music_dir(&app)?;
        let part_dir = dir.join(PART_DIR);
        let _ = std::fs::create_dir_all(&part_dir);
        let part_path = part_dir.join(format!("{id}.part"));
        let safe = sanitize(&filename);
        let ext = ext_from_url(&url);
        let target = dedupe(&dir.join(format!("{safe}{ext}")));

        // 请求（headers 透传：部分直链需 Referer/UA）
        let agent = ureq::AgentBuilder::new()
            .timeout_connect(std::time::Duration::from_secs(10))
            .build();
        let mut req = agent.get(url.trim());
        if let Some(obj) = headers.as_ref().and_then(|h| h.as_object()) {
            for (k, v) in obj {
                if let Some(vs) = v.as_str() {
                    req = req.set(k, vs);
                }
            }
        } else {
            req = req.set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
        }
        let resp = req
            .timeout(std::time::Duration::from_secs(30))
            .call()
            .map_err(|e| format!("请求失败：{e}"))?;

        let total = resp
            .header("Content-Length")
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(0);
        if total > MAX_SIZE {
            return Err(format!("文件过大（{}MB），已取消", total / 1024 / 1024));
        }

        let mut reader = resp.into_reader().take(MAX_SIZE);
        let mut file =
            std::fs::File::create(&part_path).map_err(|e| format!("创建临时文件失败：{e}"))?;
        let mut buf = [0u8; 65536];
        let mut received: u64 = 0;
        let mut last_emit = std::time::Instant::now();
        let mut last_bytes: u64 = 0;
        let started = std::time::Instant::now();
        loop {
            // 取消检查：置位则删 .part 退出
            if cancel.load(Ordering::Relaxed) {
                drop(file);
                let _ = std::fs::remove_file(&part_path);
                return Err("已取消".to_string());
            }
            let n = reader.read(&mut buf).map_err(|e| format!("读取失败：{e}"))?;
            if n == 0 {
                break;
            }
            file.write_all(&buf[..n]).map_err(|e| format!("写入失败：{e}"))?;
            received += n as u64;
            // 进度节流 emit
            if received - last_bytes >= PROGRESS_BYTES
                || last_emit.elapsed().as_millis() >= PROGRESS_MS
            {
                let _ = app.emit(
                    "download-progress",
                    serde_json::json!({ "id": id, "received": received, "total": total }),
                );
                last_bytes = received;
                last_emit = std::time::Instant::now();
            }
            // 总时长兜底（10 分钟）
            if started.elapsed().as_secs() > 600 {
                let _ = std::fs::remove_file(&part_path);
                return Err("下载超时（>10 分钟）".to_string());
            }
        }
        drop(file);

        // 校验：至少 1KB（防空文件/错误页）
        let size = std::fs::metadata(&part_path).map_err(|e| format!("读取临时文件失败：{e}"))?.len();
        if size < 1024 {
            let _ = std::fs::remove_file(&part_path);
            return Err("下载内容异常（<1KB），可能链接已失效".to_string());
        }
        // 完成：.part → 目标名（dedupe 已保证不覆盖）
        std::fs::rename(&part_path, &target).map_err(|e| format!("保存文件失败：{e}"))?;
        // 歌词同步落盘：与音频同名 .lrc（写入失败不影响下载成功，仅日志级忽略）
        if let Some(lrc) = lyric.as_deref() {
            if !lrc.trim().is_empty() {
                let lrc_stem = target.file_stem().map(|s| s.to_string_lossy().to_string());
                if let Some(stem) = lrc_stem {
                    let lrc_path = target.with_file_name(format!("{stem}.lrc"));
                    let _ = std::fs::write(&lrc_path, lrc);
                }
            }
        }
        // 封面同步落盘：抓 artwork_url 存同名 .jpg/.png/.webp（按魔数定扩展名），
        // 失败不影响下载成功（离线只是没封面）。部分 CDN 需浏览器 UA。
        if let Some(au) = artwork_url.as_deref() {
            if au.starts_with("http://") || au.starts_with("https://") {
                let cover_fetch = (|| -> Option<Vec<u8>> {
                    let resp = agent
                        .get(au)
                        .set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)")
                        .timeout(std::time::Duration::from_secs(10))
                        .call()
                        .ok()?;
                    let mut data = Vec::new();
                    resp.into_reader()
                        .take(5 * 1024 * 1024)
                        .read_to_end(&mut data)
                        .ok()?;
                    Some(data)
                })();
                if let Some(data) = cover_fetch {
                    let ext = if data.len() > 3 && data[0] == 0xff && data[1] == 0xd8 && data[2] == 0xff {
                        "jpg"
                    } else if data.len() > 8 && data[0..4] == [0x89, 0x50, 0x4e, 0x47] {
                        "png"
                    } else if data.len() > 12 && &data[0..4] == b"RIFF" && &data[8..12] == b"WEBP" {
                        "webp"
                    } else {
                        "" // 未知格式不落盘
                    };
                    if !ext.is_empty() {
                        if let Some(stem) = target.file_stem().map(|s| s.to_string_lossy().to_string()) {
                            let cover_path = target.with_file_name(format!("{stem}.{ext}"));
                            let _ = std::fs::write(&cover_path, &data);
                        }
                    }
                }
            }
        }
        Ok(target)
    })();

    // 清理任务表
    if let Ok(mut m) = tasks().lock() {
        m.remove(&id);
    }

    match result {
        Ok(path) => {
            let filename = path
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default();
            let _ = app.emit(
                "download-done",
                serde_json::json!({ "id": id, "path": path.to_string_lossy(), "filename": filename }),
            );
        }
        Err(e) => {
            let _ = app.emit("download-failed", serde_json::json!({ "id": id, "error": e }));
        }
    }
}

/// 启动下载任务。返回任务 id。
#[tauri::command]
pub async fn download_start(
    app: AppHandle,
    url: String,
    filename: String,
    headers: Option<serde_json::Value>,
    lyric: Option<String>,
    artwork_url: Option<String>,
) -> Result<u64, String> {
    let u = url.trim();
    if !(u.starts_with("http://") || u.starts_with("https://")) {
        return Err("仅支持 http/https 地址".to_string());
    }
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    tasks()
        .lock()
        .map_err(|e| e.to_string())?
        .insert(id, Arc::new(AtomicBool::new(false)));
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || run_download(app2, id, url, filename, headers, lyric, artwork_url));
    Ok(id)
}

/// 读取本地歌曲的同名附属文件：歌词（.lrc 文本）与封面（data URL）。
/// 供离线播放使用：playDownloaded 先取资产再 loadMeta，封面/歌词一步到位。
#[tauri::command]
pub fn local_track_assets(app: AppHandle, filename: String) -> Result<serde_json::Value, String> {
    use base64::Engine as _;
    let dir = music_dir(&app)?;
    let safe = sanitize(&filename);
    let stem = PathBuf::from(&safe)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    if stem.is_empty() {
        return Ok(serde_json::json!({ "lrc": null, "cover": null }));
    }
    // 歌词：同名 .lrc
    let mut lrc = None;
    let lrc_path = dir.join(format!("{stem}.lrc"));
    if lrc_path.parent() == Some(dir.as_path()) {
        if let Ok(s) = std::fs::read_to_string(&lrc_path) {
            if !s.trim().is_empty() {
                lrc = Some(s);
            }
        }
    }
    // 封面：同名 .jpg/.png/.webp → data URL（封面小图，≤3MB）
    let mut cover = None;
    for (ext, mime) in [("jpg", "image/jpeg"), ("png", "image/png"), ("webp", "image/webp")] {
        let p = dir.join(format!("{stem}.{ext}"));
        if p.parent() != Some(dir.as_path()) {
            continue;
        }
        if let Ok(data) = std::fs::read(&p) {
            if data.is_empty() || data.len() > 3 * 1024 * 1024 {
                continue;
            }
            cover = Some(format!(
                "data:{mime};base64,{}",
                base64::engine::general_purpose::STANDARD.encode(data)
            ));
            break;
        }
    }
    Ok(serde_json::json!({ "lrc": lrc, "cover": cover }))
}

/// 取消下载任务：置位取消标志，任务线程发现后清理 .part 并 emit failed(已取消)。
#[tauri::command]
pub fn download_cancel(id: u64) -> Result<(), String> {
    if let Ok(m) = tasks().lock() {
        if let Some(c) = m.get(&id) {
            c.store(true, Ordering::Relaxed);
        }
    }
    Ok(())
}

/// 列出已下载文件：[{filename, size, mtimeSec}]；顺带清理超 24h 的 .part 残留。
#[tauri::command]
pub fn downloaded_list(app: AppHandle) -> Result<Vec<serde_json::Value>, String> {
    let dir = music_dir(&app)?;
    let part_dir = dir.join(PART_DIR);
    if let Ok(rd) = std::fs::read_dir(&part_dir) {
        for e in rd.flatten() {
            let stale = e
                .metadata()
                .ok()
                .and_then(|md| md.modified().ok())
                .and_then(|m| m.elapsed().ok())
                .map(|d| d.as_secs() > 86400)
                .unwrap_or(false);
            if stale {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
    let mut out = Vec::new();
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for e in rd.flatten() {
            let md = match e.metadata() {
                Ok(m) if m.is_file() => m,
                _ => continue,
            };
            let name = e.file_name().to_string_lossy().to_string();
            // 隐藏文件与歌词文件不上榜（.lrc 随音频存在，删除音频时连带删除）
            if name.starts_with('.') || name.to_ascii_lowercase().ends_with(".lrc") {
                continue;
            }
            let mtime = md
                .modified()
                .ok()
                .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            out.push(serde_json::json!({
                "filename": name,
                "size": md.len(),
                "mtime": mtime,
            }));
        }
    }
    out.sort_by(|a, b| b["mtime"].as_u64().cmp(&a["mtime"].as_u64()));
    Ok(out)
}

/// 删除已下载文件（防路径穿越：sanitize 后必须仍位于 music/ 目录内）。
/// 音频删除成功时连带删除同名 .lrc（存在则删，失败忽略）。
#[tauri::command]
pub fn downloaded_delete(app: AppHandle, filename: String) -> Result<(), String> {
    let dir = music_dir(&app)?;
    let safe = sanitize(&filename);
    if safe.is_empty() {
        return Err("非法文件名".to_string());
    }
    let path = dir.join(&safe);
    if path.parent() != Some(dir.as_path()) {
        return Err("非法路径".to_string());
    }
    std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    if let Some(stem) = path.file_stem().map(|s| s.to_string_lossy().to_string()) {
        let lrc_path = path.with_file_name(format!("{stem}.lrc"));
        if lrc_path.parent() == Some(dir.as_path()) {
            let _ = std::fs::remove_file(&lrc_path);
        }
    }
    Ok(())
}
