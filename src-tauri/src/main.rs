//! DeskOverlay 入口编排。
//!
//! 运行模式：嵌入 Explorer 桌面 WorkerW，使工作台成为「桌面本身」。
//! - Win+D 回到工作台；任务栏 z-order 高于 WorkerW → 任务栏可见；
//! - 不实现点击穿透；Explorer 重启自愈（后续用可靠检测重新实现）。
//!
//! 持久化：state.json 写入 app_data_dir（跨 WebView 重装不丢失）。
//! 前端经 load_state / save_state 命令读写，不再用 localStorage。

// 发布版使用 Windows GUI 子系统，避免安装后弹出命令窗口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod desktop_inject;
mod sedentary;
mod sys_bridge;

use std::fs;
use std::io::Read;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use tauri::webview::PageLoadEvent;
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use windows::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_CXSCREEN};

/// 退出应用。
/// 先销毁所有 WebView 窗口，避免 Chromium 在进程退出注销
/// Chrome_WidgetWin_0 窗口类时仍有存活 HWND（如隐藏的 reminder 窗口），
/// 从而消除 "Failed to unregister class Chrome_WidgetWin_0. Error = 1412" 日志。
/// 销毁是异步的，延迟 200ms 再真正退出，确保 HWND 已被回收。
#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    for label in ["main", "reminder", "lock"] {
        if let Some(win) = app.get_webview_window(label) {
            let _ = win.destroy();
        }
    }
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(200));
        app.exit(0);
    });
}

/// 待推送的提醒内容：按需创建 reminder 窗口时暂存，待页面加载完成后取用推送。
static PENDING_REMINDER: Mutex<Option<serde_json::Value>> = Mutex::new(None);

/// 将提醒定位到主屏右上角（预留 24px 边距）、置顶并显示。
/// emit=true 时向 reminder 窗口推送内容（仅用于"复用已就绪窗口"的场景）；
/// 新建窗口时 emit=false，改由提醒页 listener 就绪后经 reminder_ready 命令取用 PENDING 再推送，
/// 消除"emit 早于前端 listener 注册完成"的竞态（事件偶发丢失 → 卡片不渲染 → 透明窗口常驻拦截）。
fn show_reminder_win(win: &tauri::WebviewWindow, payload: serde_json::Value, emit: bool) {
    let size = win.outer_size().unwrap_or(tauri::PhysicalSize::new(380, 150));
    let screen_w = unsafe { GetSystemMetrics(SM_CXSCREEN) };
    let x = screen_w - size.width as i32 - 24;
    let _ = win.set_position(tauri::PhysicalPosition::new(x, 16));
    let _ = win.set_always_on_top(true);
    let _ = win.show();
    if emit {
        let _ = win.emit("show-reminder", payload);
    }
}

/// 显示置顶提醒窗口（系统级：盖住浏览器等其他应用）。
/// 窗口非常驻：已存在则直接复用展示；否则按需创建（reminder.html 页面就绪后再展示）。
/// 注意：窗口的创建/展示都挪到后台异步线程执行——若在 Tauri 命令（主线程）里同步
/// `WebviewWindowBuilder::build()`，会发现建窗需事件循环而自身又占着主线程 → 死锁。
/// pub：久坐监控线程复用该逻辑弹出提醒（见 sedentary.rs）。
pub fn present_reminder(app: &tauri::AppHandle, icon: &str, title: &str, message: &str) {
    let payload = serde_json::json!({ "icon": icon, "title": title, "message": message });
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        // 窗口已存在（如用户尚未点击关闭）→ 直接复用展示，避免重复创建
        if let Some(win) = app.get_webview_window("reminder") {
            show_reminder_win(&win, payload, true);
            return;
        }

        // 首次触发才创建，暂存内容并等页面加载完成后展示
        *PENDING_REMINDER.lock().unwrap() = Some(payload);
        let result = WebviewWindowBuilder::new(&app, "reminder", WebviewUrl::App("reminder.html".into()))
            .title("提醒")
            .inner_size(380.0, 150.0)
            .decorations(false)
            .transparent(true)
            .resizable(false)
            .shadow(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .visible(false)
            // 首建窗口：页面加载完只负责定位+显示（不 emit），内容由前端 listener 就绪后经
            // reminder_ready 取用 PENDING 再推送，规避事件先于监听注册的竞态。
            .on_page_load(|win, page| {
                if page.event() == PageLoadEvent::Finished {
                    show_reminder_win(&win, serde_json::Value::Null, false);
                }
            })
            .build();
        // 创建失败（如极端并发下窗口已存在）：清空暂存，等待下次触发
        if result.is_err() {
            *PENDING_REMINDER.lock().unwrap() = None;
        }
    });
}

/// 置顶提醒页 listener 就绪后调用：取用暂存的待推送内容并 emit。
/// 规避"窗口 on_page_load 后立即 emit，但前端 listener 尚未注册完成"的事件丢竞争态。
#[tauri::command]
fn reminder_ready(app: tauri::AppHandle) {
    if let Some(p) = PENDING_REMINDER.lock().unwrap().take() {
        if let Some(win) = app.get_webview_window("reminder") {
            let _ = win.emit("show-reminder", p);
        }
    }
}

/// 显示置顶提醒命令（前端可调用；参数与 present_reminder 对应）。
#[tauri::command]
fn show_reminder(app: tauri::AppHandle, icon: String, title: String, message: String) {
    present_reminder(&app, &icon, &title, &message);
}

/// 隐藏置顶提醒窗口（reminder 页点"知道了"后调用）。
/// 隐藏后即销毁，释放对应 WebView2 实例（窗口按需创建，非常驻）。
#[tauri::command]
fn hide_reminder(app: tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("reminder") {
        let _ = win.hide();
        let _ = win.destroy();
    }
}

/// 共享 HTTP Agent：复用连接池（keep-alive + TLS 会话），避免每次请求重建。
/// 音源插件频繁请求第三方接口时显著减少握手开销。
static AGENT: OnceLock<ureq::Agent> = OnceLock::new();
fn agent() -> &'static ureq::Agent {
    AGENT.get_or_init(|| ureq::AgentBuilder::new().build())
}

/// 构建请求：注入默认 UA + 可选自定义 headers。
fn build_headers(req: ureq::Request, headers: &Option<serde_json::Value>) -> ureq::Request {
    let mut r = req.set(
        "User-Agent",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) DeskOverlay/0.3.0",
    );
    if let Some(h) = headers.as_ref().and_then(|v| v.as_object()) {
        for (k, v) in h {
            if let Some(s) = v.as_str() {
                r = r.set(k, s);
            }
        }
    }
    r
}

/// HTTP GET 代理：绕过 WebView 跨域限制，供音乐音源插件请求第三方接口。
/// headers 为可选 JSON 对象（键值均为字符串）。
#[tauri::command]
fn http_get(url: String, headers: Option<serde_json::Value>) -> Result<String, String> {
    let u = url.trim();
    if !(u.starts_with("http://") || u.starts_with("https://")) {
        return Err("仅支持 http/https 地址".to_string());
    }
    let resp = build_headers(agent().get(u), &headers)
        .timeout(std::time::Duration::from_secs(15))
        .call()
        .map_err(|e| e.to_string())?;
    let mut body = String::new();
    resp.into_reader()
        .take(5 * 1024 * 1024)
        .read_to_string(&mut body)
        .map_err(|e| e.to_string())?;
    Ok(body)
}

/// HTTP POST 代理：同 http_get，支持发送请求体（JSON/表单字符串）。
#[tauri::command]
fn http_post(url: String, body: String, headers: Option<serde_json::Value>) -> Result<String, String> {
    let u = url.trim();
    if !(u.starts_with("http://") || u.starts_with("https://")) {
        return Err("仅支持 http/https 地址".to_string());
    }
    let resp = build_headers(agent().post(u), &headers)
        .timeout(std::time::Duration::from_secs(15))
        .send_string(&body)
        .map_err(|e| e.to_string())?;
    let mut out = String::new();
    resp.into_reader()
        .take(5 * 1024 * 1024)
        .read_to_string(&mut out)
        .map_err(|e| e.to_string())?;
    Ok(out)
}

/// 读取 JSON 文件为 Value。
fn read_json(file: &std::path::Path) -> Result<serde_json::Value, String> {
    let data = fs::read_to_string(file).map_err(|e| e.to_string())?;
    serde_json::from_str(&data).map_err(|e| e.to_string())
}

/// 通用插件机制：读取外部插件模块文件的原始文本（UTF-8）。
/// 前端用 Blob + import() 动态执行并注册为工作台模块，实现「工作台不含插件业务代码」。
#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    let p = path.trim();
    if p.is_empty() {
        return Err("路径不能为空".to_string());
    }
    let data = fs::read_to_string(p).map_err(|e| e.to_string())?;
    Ok(data)
}

/// 读取持久化状态。
/// state.json 存业务数据；音乐相关（音源插件脚本 musicSources / 收藏 favorites / 播放状态 playback）
/// 统一独立存 music.json；workLogs（工作记录，持续增长的用户数据）独立存 worklogs.json。
/// 老数据迁移：state.json 中残留的这几个字段会保留返回，下次保存自动分流；旧版 sources.json 作兜底。
#[tauri::command]
fn load_state(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let file = dir.join("state.json");
    let mut state = if !file.exists() {
        serde_json::json!({
            "currentModule": "dashboard",
            "tasks": [],
            "notes": ""
        })
    } else {
        read_json(&file)?
    };

    // 音乐数据统一文件（存在则覆盖合并）
    let music_file = dir.join("music.json");
    if music_file.exists() {
        if let Ok(mv) = read_json(&music_file) {
            if let Some(m) = mv.as_object() {
                if let Some(s) = m.get("musicSources") { state["musicSources"] = s.clone(); }
                if let Some(f) = m.get("favorites") { state["favorites"] = f.clone(); }
                if let Some(p) = m.get("playback") { state["playback"] = p.clone(); }
            }
        }
    }
    // 旧版音源独立文件迁移兜底：music.json 未提供 musicSources 时，读 sources.json 保留旧数据
    if state.get("musicSources").is_none() {
        let sources_file = dir.join("sources.json");
        if sources_file.exists() {
            if let Ok(sv) = read_json(&sources_file) {
                state["musicSources"] = sv;
            }
        }
    }
    // 工作记录独立文件（存在则覆盖合并）
    let logs_file = dir.join("worklogs.json");
    if logs_file.exists() {
        if let Ok(lv) = read_json(&logs_file) {
            state["workLogs"] = lv;
        }
    }
    Ok(state)
}

/// 写入持久化状态：音乐字段分流到 music.json、workLogs 分流到 worklogs.json，其余写 state.json。
#[tauri::command]
fn save_state(app: tauri::AppHandle, state: serde_json::Value) -> Result<(), String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let mut state = state;
    let (music_file_val, logs) = if let Some(obj) = state.as_object_mut() {
        let music = serde_json::json!({
            "musicSources": obj.remove("musicSources").unwrap_or(serde_json::json!([])),
            "favorites": obj.remove("favorites").unwrap_or(serde_json::json!([])),
            "playback": obj.remove("playback").unwrap_or(serde_json::json!({})),
        });
        (Some(music), obj.remove("workLogs"))
    } else {
        (None, None)
    };

    // 业务数据
    let file = dir.join("state.json");
    let data = serde_json::to_string_pretty(&state).map_err(|e| e.to_string())?;
    fs::write(&file, data).map_err(|e| e.to_string())?;

    // 音乐数据（统一文件，避免频繁收藏/播放变化重写 state.json）
    if let Some(music) = music_file_val {
        let music_file = dir.join("music.json");
        let mdata = serde_json::to_string_pretty(&music).map_err(|e| e.to_string())?;
        fs::write(&music_file, mdata).map_err(|e| e.to_string())?;
    }

    // 工作记录（持续增长的用户数据独立文件，便于单独备份/导出）
    let logs_file = dir.join("worklogs.json");
    let ldata = serde_json::to_string_pretty(&logs.unwrap_or_else(|| serde_json::json!([])))
        .map_err(|e| e.to_string())?;
    fs::write(&logs_file, ldata).map_err(|e| e.to_string())
}

/// 桌面文件项。
#[derive(serde::Serialize)]
struct DesktopFile {
    name: String,
    ext: String,
    is_dir: bool,
}

/// 用户桌面目录。
fn desktop_dir() -> Result<PathBuf, String> {
    let home = std::env::var("USERPROFILE").map_err(|_| "无法获取 USERPROFILE".to_string())?;
    Ok(PathBuf::from(home).join("Desktop"))
}

/// 列出用户桌面目录的文件（按类型分类供前端整理展示）。
#[tauri::command]
fn list_desktop_files() -> Result<Vec<DesktopFile>, String> {
    let desktop = desktop_dir()?;
    if !desktop.exists() {
        return Ok(vec![]);
    }
    let mut files = vec![];
    for entry in fs::read_dir(&desktop).map_err(|e| e.to_string())? {
        let Ok(entry) = entry else { continue };
        let name = entry.file_name().to_string_lossy().to_string();
        // 跳过隐藏文件与系统配置
        if name.starts_with('.') || name.eq_ignore_ascii_case("desktop.ini") {
            continue;
        }
        let path = entry.path();
        let is_dir = path.is_dir();
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|s| s.to_lowercase())
            .unwrap_or_default();
        files.push(DesktopFile { name, ext, is_dir });
    }
    Ok(files)
}

/// 用默认程序打开文件。
#[tauri::command]
fn open_file(name: String) -> Result<(), String> {
    let path = desktop_dir()?.join(&name);
    std::process::Command::new("cmd")
        .args(["/C", "start", "", &path.to_string_lossy()])
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 在资源管理器中定位文件。
#[tauri::command]
fn reveal_file(name: String) -> Result<(), String> {
    let path = desktop_dir()?.join(&name);
    std::process::Command::new("explorer.exe")
        .args(["/select,", &path.to_string_lossy()])
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 删除文件到回收站（经 PowerShell VisualBasic API，保证进回收站可恢复）。
#[tauri::command]
fn delete_file(name: String) -> Result<(), String> {
    let path = desktop_dir()?.join(&name);
    if !path.exists() {
        return Err("文件不存在".to_string());
    }
    let path_str = path.to_string_lossy().replace('\'', "''");
    let method = if path.is_dir() { "DeleteDirectory" } else { "DeleteFile" };
    let script = format!(
        "Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::{}('{}','OnlyErrorDialogs','SendToRecycleBin')",
        method, path_str
    );
    let status = std::process::Command::new("powershell")
        .args(["-NoProfile", "-Command", &script])
        .status()
        .map_err(|e| e.to_string())?;
    if !status.success() {
        return Err("删除失败".to_string());
    }
    Ok(())
}

/// 重命名文件。
#[tauri::command]
fn rename_file(name: String, new_name: String) -> Result<(), String> {
    let dir = desktop_dir()?;
    let from = dir.join(&name);
    let to = dir.join(&new_name);
    if !from.exists() {
        return Err("原文件不存在".to_string());
    }
    if to.exists() {
        return Err("目标名称已存在".to_string());
    }
    fs::rename(&from, &to).map_err(|e| e.to_string())
}

/// 读取桌面图片文件为 base64 data URL，供文件中心显示缩略图。
/// 超过 10MB 的图片不读取（太大，避免 base64 膨胀与解码内存开销），前端回退到图标。
#[tauri::command]
fn image_thumbnail(name: String) -> Result<String, String> {
    let path = desktop_dir()?.join(&name);
    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    if !meta.is_file() || meta.len() > 10 * 1024 * 1024 {
        return Err("不是可预览的图片".to_string());
    }
    let data = fs::read(&path).map_err(|e| e.to_string())?;
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    let mime = match ext.as_str() {
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        _ => "image/jpeg", // jpg / jpeg
    };
    use base64::engine::general_purpose::STANDARD;
    use base64::Engine;
    Ok(format!("data:{};base64,{}", mime, STANDARD.encode(data)))
}

/// 按需获取锁屏窗口：已存在则直接复用；否则创建（全屏置顶、隐藏起步，非常驻）。
fn ensure_lock(app: &tauri::AppHandle) -> Option<tauri::WebviewWindow> {
    if let Some(win) = app.get_webview_window("lock") {
        return Some(win);
    }
    WebviewWindowBuilder::new(app, "lock", WebviewUrl::App("lock.html".into()))
        .title("")
        .fullscreen(true)
        .decorations(false)
        .resizable(false)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(false)
        .visible(false)
        .build()
        .ok()
}

/// 显示系统级锁屏窗口：全屏置顶（盖住其它应用与任务栏），并通知锁屏页开始动画。
/// 注意：创建/展示在后台异步线程执行，命令立即返回——避免主线程命令里同步建窗死锁。
#[tauri::command]
fn show_lock(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        if let Some(win) = ensure_lock(&app) {
            let _ = win.set_always_on_top(true);
            let _ = win.set_fullscreen(true);
            let _ = win.show();
            let _ = win.set_focus();
        }
        let _ = app.emit("lock-init", ());
    });
}

/// 隐藏系统级锁屏窗口。隐藏后即销毁，释放 WebView2 实例（窗口按需创建，非常驻）。
#[tauri::command]
fn hide_lock(app: tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("lock") {
        let _ = win.hide();
        let _ = win.destroy();
    }
    let _ = app.emit("lock-hide", ());
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(sedentary::new_sedentary_state())
        .setup(|app| {
            // 启动系统指标 Provider 数据桥（CPU + 内存 → provider-emit）
            sys_bridge::start_system_provider(app.handle().clone());

            // 全局空闲监控（供隐私锁屏判断）
            sys_bridge::start_lock_idle_monitor(app.handle().clone());

            // 久坐提醒：启动后端键鼠活动监控线程（配置经 set_sedentary_config 下发）
            sedentary::start_sedentary_monitor(
                app.handle().clone(),
                app.state::<sedentary::SedentaryState>().inner().clone(),
            );

            // 嵌入桌面 WorkerW（成为桌面本身），再显示
            if let Some(win) = app.get_webview_window("main") {
                if let Ok(hwnd) = win.hwnd() {
                    desktop_inject::embed_in_desktop(hwnd);
                }
                let _ = win.show();
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![quit_app, show_reminder, hide_reminder, reminder_ready, read_text_file, http_get, http_post, load_state, save_state, list_desktop_files, image_thumbnail, open_file, reveal_file, delete_file, rename_file, show_lock, hide_lock, sys_bridge::start_system_sampling, sys_bridge::stop_system_sampling, sedentary::set_sedentary_config])
        .run(tauri::generate_context!())
        .expect("DeskOverlay 运行失败");
}
