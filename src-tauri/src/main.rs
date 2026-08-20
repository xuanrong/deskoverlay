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
use tauri::{Emitter, Manager};
use windows::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_CXSCREEN};

/// 退出应用。
/// 先销毁所有 WebView 窗口，避免 Chromium 在进程退出注销
/// Chrome_WidgetWin_0 窗口类时仍有存活 HWND（如隐藏的 reminder 窗口），
/// 从而消除 "Failed to unregister class Chrome_WidgetWin_0. Error = 1412" 日志。
/// 销毁是异步的，延迟 200ms 再真正退出，确保 HWND 已被回收。
#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    for label in ["main", "reminder"] {
        if let Some(win) = app.get_webview_window(label) {
            let _ = win.destroy();
        }
    }
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(200));
        app.exit(0);
    });
}

/// 显示置顶提醒窗口（系统级：盖住浏览器等其他应用）。
/// 定位到主屏右上角、置顶并显示，再向 reminder 窗口推送内容。
/// pub：久坐监控线程复用该逻辑弹出提醒（见 sedentary.rs）。
pub fn present_reminder(app: &tauri::AppHandle, icon: &str, title: &str, message: &str) {
    if let Some(win) = app.get_webview_window("reminder") {
        // 主屏右上角（预留 24px 边距）
        let size = win.outer_size().unwrap_or(tauri::PhysicalSize::new(380, 150));
        let screen_w = unsafe { GetSystemMetrics(SM_CXSCREEN) };
        let x = screen_w - size.width as i32 - 24;
        let _ = win.set_position(tauri::PhysicalPosition::new(x, 16));
        let _ = win.set_always_on_top(true);
        let _ = win.show();
        let _ = win.emit(
            "show-reminder",
            serde_json::json!({ "icon": icon, "title": title, "message": message }),
        );
    }
}

/// 显示置顶提醒命令（前端可调用；参数与 present_reminder 对应）。
#[tauri::command]
fn show_reminder(app: tauri::AppHandle, icon: String, title: String, message: String) {
    present_reminder(&app, &icon, &title, &message);
}

/// 隐藏置顶提醒窗口（reminder 页点"知道了"或 8s 超时后调用）。
#[tauri::command]
fn hide_reminder(app: tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("reminder") {
        let _ = win.hide();
    }
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
    let resp = build_headers(ureq::get(u), &headers)
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
    let resp = build_headers(ureq::post(u), &headers)
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

/// 读取持久化状态。
/// state.json 存业务数据；musicSources（音源插件脚本，大字段）独立存 sources.json；
/// workLogs（工作记录，持续增长的用户数据）独立存 worklogs.json。
/// 老数据迁移：state.json 中残留的 musicSources / workLogs 会保留返回，下次保存自动分流到独立文件。
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
    // 音源独立文件（存在则覆盖合并）
    let sources_file = dir.join("sources.json");
    if sources_file.exists() {
        if let Ok(sv) = read_json(&sources_file) {
            state["musicSources"] = sv;
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

/// 写入持久化状态：musicSources 分流到 sources.json、workLogs 分流到 worklogs.json，其余写 state.json。
#[tauri::command]
fn save_state(app: tauri::AppHandle, state: serde_json::Value) -> Result<(), String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let mut state = state;
    let (sources, logs) = if let Some(obj) = state.as_object_mut() {
        (obj.remove("musicSources"), obj.remove("workLogs"))
    } else {
        (None, None)
    };

    // 业务数据
    let file = dir.join("state.json");
    let data = serde_json::to_string_pretty(&state).map_err(|e| e.to_string())?;
    fs::write(&file, data).map_err(|e| e.to_string())?;

    // 音源脚本（大字段独立文件，避免每次全量重写）
    let sources_file = dir.join("sources.json");
    let sdata = serde_json::to_string_pretty(&sources.unwrap_or_else(|| serde_json::json!([])))
        .map_err(|e| e.to_string())?;
    fs::write(&sources_file, sdata).map_err(|e| e.to_string())?;

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

/// 显示系统级锁屏窗口：全屏置顶（盖住其它应用与任务栏），并通知锁屏页开始动画。
#[tauri::command]
fn show_lock(app: tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("lock") {
        let _ = win.set_always_on_top(true);
        let _ = win.set_fullscreen(true);
        let _ = win.show();
        let _ = win.set_focus();
    }
    let _ = app.emit("lock-init", ());
}

/// 隐藏系统级锁屏窗口。
#[tauri::command]
fn hide_lock(app: tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("lock") {
        let _ = win.hide();
        let _ = win.set_always_on_top(false);
    }
    let _ = app.emit("lock-hide", ());
}

fn main() {
    tauri::Builder::default()
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
        .invoke_handler(tauri::generate_handler![quit_app, show_reminder, hide_reminder, http_get, http_post, load_state, save_state, list_desktop_files, open_file, reveal_file, delete_file, rename_file, show_lock, hide_lock, sedentary::set_sedentary_config])
        .run(tauri::generate_context!())
        .expect("DeskOverlay 运行失败");
}
