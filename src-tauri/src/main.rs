//! DeskOverlay 入口编排。
//!
//! 运行模式：嵌入 Explorer 桌面 WorkerW，使工作台成为「桌面本身」。
//! - Win+D 回到工作台（桌面级窗口，不被最小化）；
//! - 全屏覆盖虚拟屏，任务栏 z-order 高于 WorkerW → 任务栏自然可见；
//! - 不实现点击穿透（用户已明确不需要），面板外点击由窗口处理；
//! - Explorer 重启自愈（2s 轮询重新挂回）。
//!
//! setup 仅启动系统 Provider 数据桥（CPU + 内存 → provider-emit），
//! 并注册前端可调用的命令：quit_app（退出应用，避免无边框下无法关闭）。

mod desktop_inject;
mod sys_bridge;

use tauri::Manager;

/// 退出应用。无边框窗口无系统关闭按钮，需此命令供前端 Esc 调用。
#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            // 启动系统指标 Provider 数据桥（CPU + 内存 → provider-emit）
            sys_bridge::start_system_provider(app.handle().clone());

            // 嵌入桌面 WorkerW（成为桌面本身），再显示
            if let Some(win) = app.get_webview_window("main") {
                if let Ok(hwnd) = win.hwnd() {
                    desktop_inject::embed_in_desktop(hwnd);
                }
                let _ = win.show();
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![quit_app])
        .run(tauri::generate_context!())
        .expect("DeskOverlay 运行失败");
}
