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

mod autostart;
mod aliyundrive;
mod desktop_inject;
mod downloader;
mod file_index;
mod plugin_pkg;
mod sedentary;
mod sys_bridge;
mod usn_index;
mod wasm_plugin;

use std::fs;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;
use serde::Serialize;
use windows::core::w;
use windows::Win32::Foundation::{GetLastError, ERROR_ALREADY_EXISTS};
use windows::Win32::System::Threading::CreateMutexW;
use windows::Win32::UI::WindowsAndMessaging::{
    GetSystemMetrics, SetWindowPos, SM_CXSCREEN, SM_CYSCREEN, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
};

/// 通用 Wasm 插件命令：读取外部 .wasm 后端文件并在宿主内沙箱执行（返回插件结果串）。
#[tauri::command]
fn run_wasm_backend(path: String, input: String) -> Result<String, String> {
    let p = path.trim();
    if p.is_empty() {
        return Err("路径不能为空".to_string());
    }
    let bytes = std::fs::read(p).map_err(|e| format!("读取 wasm 失败：{e}"))?;
    wasm_plugin::run_backend(&bytes, &input)
}

/// 安装外部插件包(zip)：解压到 app_data/plugins/<id>，返回 manifest 与各文件绝对路径。
#[tauri::command]
fn install_plugin_package(app: tauri::AppHandle, zip_path: String) -> Result<serde_json::Value, String> {
    plugin_pkg::install(&app, zip_path.trim())
}

/// 编译插件包的后端源码为 .wasm（调用本机 cargo），返回 .wasm 绝对路径。
#[tauri::command]
fn build_wasm_backend(backend_dir: String) -> Result<String, String> {
    plugin_pkg::build_backend(backend_dir.trim())
}

/// 退出应用。
/// 先销毁所有 WebView 窗口，避免 Chromium 在进程退出注销
/// Chrome_WidgetWin_0 窗口类时仍有存活 HWND（如隐藏的 reminder 窗口），
/// 从而消除 "Failed to unregister class Chrome_WidgetWin_0. Error = 1412" 日志。
/// 销毁是异步的，延迟 200ms 再真正退出，确保 HWND 已被回收。
#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    REMINDER_PAGE_READY.store(false, Ordering::SeqCst);
    *PENDING_REMINDER.lock().unwrap() = None;
    LYRIC_PAGE_READY.store(false, Ordering::SeqCst);
    *PENDING_LYRIC.lock().unwrap() = None;
    for label in ["main", "reminder", "lock", "lyric"] {
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

/// 提醒窗口硬超时（ms）：窗口一旦显示，最迟此时限内必须被销毁。
/// 取 15s = 前端自动关闭 10s（reminder.js AUTO_CLOSE_MS）+ 5s 余量。
const REMINDER_HARD_TTL_MS: u64 = 15_000;

/// 提醒「世代」计数：每次展示自增。上一轮的兜底计时器发现世代已变即退出，
/// 避免它误杀新一轮的提醒窗口。
static REMINDER_GEN: AtomicU64 = AtomicU64::new(0);

/// 当前 reminder 页面的事件监听器是否已注册完成（`reminder_ready` 置 true，窗口销毁时置 false）。
///
/// 为什么需要它：`present_reminder` 的**复用分支**曾无条件 `emit`。若两次提醒间隔极短
/// （≤ 页面加载耗时，约 200ms~1s），第二次到达时窗口对象已存在、但页面 JS 尚未注册
/// listener → emit 的 `show-reminder` 无人接收而永久丢失；而复用分支已顺手清空
/// PENDING，随后页面就绪时 `reminder_ready` 取到 `None` → 直接销毁窗口。
/// 净结果：**两次提醒一起静默丢失**（既没弹窗，也没有残留窗口可供暴露问题）。
///
/// 不变量：**不存在提醒窗口 ⟹ 本标志为 false**。因此「窗口存在但标志为 false」
/// 唯一对应「页面尚在加载」这一种状态，此时应写回 PENDING 交给页面自取，而非 emit。
/// 所有销毁路径（`hide_reminder` / `reminder_ready` 空内容分支 / 看门狗超时）都必须置 false。
static REMINDER_PAGE_READY: AtomicBool = AtomicBool::new(false);

/// 非 panic 的诊断日志。
/// release 构建为 Windows GUI 子系统（无控制台 stdout），`println!` 在句柄无效时
/// 会直接 panic；故统一走 stderr 且忽略写入失败。
fn log_diag(scope: &str, msg: &str) {
    let _ = writeln!(std::io::stderr(), "[{scope}] {msg}");
}

/// 兜底看门狗：窗口显示后 TTL 到点强制销毁。
///
/// 存在意义：窗口以 `transparent(true)` + 卡片 `opacity: 0` 起步，一旦落入
/// 「已显示但无内容」状态，视觉上等同于「没有弹窗」，但它仍占据右上角矩形
/// 并吞掉该区域所有鼠标消息（含右键呼出桌面菜单），且前端 autoHideTimer
/// 未启动（只在收到 show-reminder 时才启动）→ 会永久残留，只能重启应用。
/// 触发路径有两条：前端 hide_reminder 的 invoke 失败（被 .catch 静默吞掉）、
/// 或提醒页重载后再次显示但已无待推送内容。
fn spawn_reminder_watchdog(win: &tauri::WebviewWindow) {
    let gen = REMINDER_GEN.fetch_add(1, Ordering::SeqCst) + 1;
    let app = win.app_handle().clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(REMINDER_HARD_TTL_MS));
        if REMINDER_GEN.load(Ordering::SeqCst) != gen {
            return; // 已被新一轮提醒取代，交由新看门狗负责
        }
        let app_inner = app.clone();
        let _ = app.run_on_main_thread(move || {
            if let Some(w) = app_inner.get_webview_window("reminder") {
                log_diag("reminder", "硬超时兜底：强制销毁提醒窗口（前端未回调 hide_reminder？）");
                // 与 hide_reminder 一样复位就绪标志，维持「无窗口 ⟹ 标志为 false」不变量
                REMINDER_PAGE_READY.store(false, Ordering::SeqCst);
                let _ = w.hide();
                let _ = w.destroy();
            }
        });
    });
}

/// 锁屏窗口正在显示时，把提醒窗口插到它**下面**（z-order）。
/// 两者同为 `always_on_top` → 同属 WS_EX_TOPMOST 层，同层内由 z-order 决定前后；
/// 故用 `SetWindowPos(hWndInsertAfter = 锁屏 HWND)` 即可把提醒压到锁屏之下，
/// 保证隐私锁屏的遮挡语义不被久坐/喝水提醒破坏。
///
/// 仅在锁屏**确实可见**时才调整：把可见窗口插到隐藏窗口之后，可能连带改变其可见性表现。
fn sink_reminder_below_lock(win: &tauri::WebviewWindow) {
    let lock = match win.app_handle().get_webview_window("lock") {
        Some(l) => l,
        None => return, // 锁屏窗口尚未创建
    };
    if !lock.is_visible().unwrap_or(false) {
        return; // 锁屏未显示：提醒保持正常置顶
    }
    let (reminder_hwnd, lock_hwnd) = match (win.hwnd(), lock.hwnd()) {
        (Ok(r), Ok(l)) => (r, l),
        _ => return,
    };
    unsafe {
        let _ = SetWindowPos(
            reminder_hwnd,
            Some(lock_hwnd),
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
        );
    }
}

/// 将提醒定位到主屏右上角（预留 24px 边距）、置顶并显示。
/// emit=true 时向 reminder 窗口推送内容（仅用于"复用已就绪窗口"的场景）；
/// 新建窗口时 emit=false，改由提醒页 listener 就绪后经 reminder_ready 命令取用 PENDING 再推送，
/// 消除"emit 早于前端 listener 注册完成"的竞态（事件偶发丢失 → 卡片不渲染 → 透明窗口常驻拦截）。
fn show_reminder_win(win: &tauri::WebviewWindow, payload: serde_json::Value, emit: bool) {
    let size = win.outer_size().unwrap_or(tauri::PhysicalSize::new(340, 130));
    let screen_w = unsafe { GetSystemMetrics(SM_CXSCREEN) };
    let x = screen_w - size.width as i32 - 24;
    let _ = win.set_position(tauri::PhysicalPosition::new(x, 16));
    let _ = win.set_always_on_top(true);
    let _ = win.show();
    // 锁屏可见时压到锁屏之下，避免提醒盖住隐私锁屏
    sink_reminder_below_lock(win);
    // 展示即武装硬超时兜底（旧看门狗因世代变更自动退出）
    spawn_reminder_watchdog(win);
    if emit {
        let _ = win.emit("show-reminder", payload.clone());
    }
    // 展示确认：前端（reminders.js）据此才写「当日已触发」标记——
    // 之前是标记先行、弹窗失败即当天静默丢失（用户反馈：到点没弹提醒）。
    let _ = win.emit("reminder-shown", payload);
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
        // 窗口已存在（如用户尚未点击关闭）→ 直接复用展示，避免重复创建。
        if let Some(win) = app.get_webview_window("reminder") {
            if REMINDER_PAGE_READY.load(Ordering::SeqCst) {
                // 页面 listener 已就绪：可安全直接 emit。
                // 复用路径无需暂存，顺手清掉可能残留的 PENDING，防陈旧内容被后续 reminder_ready 取走。
                *PENDING_REMINDER.lock().unwrap() = None;
                show_reminder_win(&win, payload, true);
            } else {
                // 窗口对象在、但页面还在加载（两次提醒间隔极短）：此刻 emit 必然丢事件。
                // 改为写入 PENDING、保持窗口隐藏，由页面 listener 就绪后的 reminder_ready 取用并展示。
                // 注意**不清空** PENDING 之外的状态，也**不** show —— 维持「窗口可见 ⟺ 有内容」。
                *PENDING_REMINDER.lock().unwrap() = Some(payload);
                log_diag("reminder", "页面未就绪，内容已暂存待 reminder_ready 取用");
            }
            return;
        }

        // 首次触发才创建：暂存内容，窗口保持 `visible(false)`。
        // 注意：此处**不能**在 on_page_load 里 show —— 那会造出"已显示但无内容"的
        // 透明窗口（卡片 opacity:0，视觉上等同没有弹窗），却在右上角持续拦截鼠标消息。
        // 显示时机统一收敛到 reminder_ready（拿到内容后 show + emit），
        // 使"窗口可见"与"有内容"永远同时发生。
        *PENDING_REMINDER.lock().unwrap() = Some(payload.clone());
        let result = WebviewWindowBuilder::new(&app, "reminder", WebviewUrl::App("reminder.html".into()))
            .title("提醒")
            .inner_size(340.0, 130.0)
            .decorations(false)
            .transparent(true)
            .resizable(false)
            .shadow(false)
            .always_on_top(true)
            .skip_taskbar(true)
            // 提醒窗口抢焦点会打断用户正在进行的输入，故设置为不可聚焦：
            // 显示时不会激活窗口，主窗口保持键盘/输入焦点。
            .focusable(false)
            .visible(false)
            .build();
        if result.is_err() {
            // 极端并发下窗口已被另一侧建成：保留 PENDING，交由该窗口的
            // reminder_ready 取用（内容以最后写入者为准），避免两边都推空。
            log_diag("reminder", "窗口创建失败（疑似并发已存在），保留暂存内容待复用");
        } else {
            // 建窗成功：等待页面就绪握手（reminder_ready）后展示并 emit reminder-shown。
            // 若页面加载失败（reminder_ready 永不到来），15s 看门狗销毁窗口并 emit reminder-failed，
            // 前端据此撤销「当日已触发」标记，下一分钟重试。
            let app2 = app.clone();
            let payload2 = payload.clone();
            std::thread::spawn(move || {
                for _ in 0..30 {
                    std::thread::sleep(std::time::Duration::from_millis(500));
                    if REMINDER_PAGE_READY.load(Ordering::SeqCst) {
                        let _ = app2.emit("reminder-shown", payload2);
                        return;
                    }
                }
                log_diag("reminder", "页面 15s 未就绪，emit reminder-failed");
                let _ = app2.emit("reminder-failed", payload2);
            });
        }
    });
}

/// 置顶提醒页 listener 就绪后调用：取用暂存的待推送内容并 emit。
/// 规避"窗口 on_page_load 后立即 emit，但前端 listener 尚未注册完成"的事件丢竞争态。
///
/// 本命令返回即代表页面的 `show-reminder` 监听器已注册 → 置位 `REMINDER_PAGE_READY`，
/// 此后 `present_reminder` 的复用分支才允许直接 emit。
#[tauri::command]
fn reminder_ready(app: tauri::AppHandle) {
    REMINDER_PAGE_READY.store(true, Ordering::SeqCst);
    let win = match app.get_webview_window("reminder") {
        Some(w) => w,
        None => {
            REMINDER_PAGE_READY.store(false, Ordering::SeqCst);
            *PENDING_REMINDER.lock().unwrap() = None;
            return;
        }
    };
    match PENDING_REMINDER.lock().unwrap().take() {
        // 有内容：先定位显示再推送（show_reminder_win 内部会武装硬超时兜底）
        Some(p) => {
            show_reminder_win(&win, p, true);
        }
        // 无内容：本页没有可展示的东西（提醒页被重载，或内容已被并发路径消费）。
        // 绝不能留一个"已显示但无内容"的窗口 —— 它会静默拦截右上角的鼠标（含右键）。
        None => {
            REMINDER_PAGE_READY.store(false, Ordering::SeqCst);
            let _ = win.hide();
            let _ = win.destroy();
        }
    }
}

/// 显示置顶提醒命令（前端可调用；参数与 present_reminder 对应）。
#[tauri::command]
fn show_reminder(app: tauri::AppHandle, icon: String, title: String, message: String) {
    present_reminder(&app, &icon, &title, &message);
}

/// 隐藏置顶提醒窗口（reminder 页点"知道了"后调用）。
/// 隐藏后即销毁，释放对应 WebView2 实例（窗口按需创建，非常驻）；
/// 同时清空暂存内容，避免残留内容被下一次窗口的 reminder_ready 误取。
#[tauri::command]
fn hide_reminder(app: tauri::AppHandle) {
    REMINDER_PAGE_READY.store(false, Ordering::SeqCst);
    *PENDING_REMINDER.lock().unwrap() = None;
    if let Some(win) = app.get_webview_window("reminder") {
        let _ = win.hide();
        let _ = win.destroy();
    }
}

// ══════════════════════ 桌面歌词窗口（常驻浮层） ══════════════════════
//
// 与 reminder / lock 的关键差异：歌词窗口在**播放期间常驻**，故绝不能复用
// `REMINDER_HARD_TTL_MS` 那套「显示后必被销毁」的看门狗 —— 那会在 15s 后把歌词条强杀。
// 复用的只是它的两条工程经验：
//   1. `focusable(false)`：不抢键盘焦点，避免打断用户正在进行的输入；
//   2. 「窗口可见 ⟺ 有内容」+ listener 先注册再由页面取内容的 ready 握手
//      （消除「emit 早于前端 listen 注册」的丢事件竞态）。
//
// 另注：`desktop_inject.rs` 顶部「不实现点击穿透」的注释仅约束**主工作台窗口**
// （面板外点击交给工作台处理），不适用于歌词浮层 —— 它是独立窗口，穿透是其核心能力。

/// 歌词窗口页面就绪标志（对齐 REMINDER_PAGE_READY）。
static LYRIC_PAGE_READY: AtomicBool = AtomicBool::new(false);
/// 设置弹窗（lyric_menu 独立窗口）的就绪 / 待显示标记。
/// 弹窗创建是异步的（WebView 初始化），toggle 时未就绪就先记下，就绪后补显示。
static LYRIC_MENU_READY: AtomicBool = AtomicBool::new(false);
static LYRIC_MENU_PENDING: AtomicBool = AtomicBool::new(false);
/// 弹窗当前是否可见（供探测线程做「光标移出弹窗 → 自动收起」判定）。
static LYRIC_MENU_VISIBLE: AtomicBool = AtomicBool::new(false);
/// 页面未就绪时暂存的歌词 payload（对齐 PENDING_REMINDER）。
static PENDING_LYRIC: Mutex<Option<serde_json::Value>> = Mutex::new(None);
/// 当前**真实**锁定态（穿透中 = true）。
///
/// 必须由 Rust 记录而不是让页面自己算：OS 级 `set_ignore_cursor_events` 的状态只有
/// Rust 侧知道，页面在握手时需要拿到它才能正确渲染初始工具条可见性。
/// 所有改动穿透的路径都要同步更新这个值（否则页面显示的状态会与真实穿透不一致）。
static LYRIC_LOCKED: AtomicBool = AtomicBool::new(false);

/// 歌词条尺寸（物理像素）：宽 760；歌词区单行高 56 / 双行高 88；工具条高 34。
/// 高度**紧贴可见区域**，不留透明内边距 —— 透明区域在 WebView2 里仍会吞掉鼠标消息，
/// 只有窗口矩形足够紧凑，穿透行为才可预期。故单双行切换必须真的改窗口高度，
/// 不能靠「留一块透明区」——那会让条下方的桌面图标点不到。
///
/// 工具条放在歌词**上方**（网易云样式）：放右侧会在 flex 流里占宽、把歌词压到 ~478px，
/// 悬浮又会在悬停时盖住长句句尾。放上方则歌词区永远全宽、永不遮挡。
const LYRIC_W: i32 = 760;
const LYRIC_H: i32 = 56;
const LYRIC_H_DOUBLE: i32 = 88;
/// 工具条高度：按钮 28px + 上下留白 6px。
const LYRIC_TOOLS_H: i32 = 34;
/// 默认位置：主显示器工作区底部居中，距底 80px（工作区已扣掉任务栏）。
const LYRIC_MARGIN_BOTTOM: i32 = 80;

/// 读取 state.json 的 `lyric` 对象（缺失/损坏一律返回空对象，不阻塞窗口创建）。
fn read_lyric_state(app: &tauri::AppHandle) -> serde_json::Value {
    app.path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("state.json"))
        .filter(|f| f.exists())
        .and_then(|f| read_json(&f).ok())
        .and_then(|s| s.get("lyric").cloned())
        .filter(|v| v.is_object())
        .unwrap_or_else(|| serde_json::json!({}))
}

/// 显示形态 → 窗口高度（物理像素）= 歌词区高 + 顶部工具条高。
fn lyric_height_for(form: &str) -> i32 {
    let lyrics = if form == "double" { LYRIC_H_DOUBLE } else { LYRIC_H };
    lyrics + LYRIC_TOOLS_H
}

/// 歌词窗口的**物理**尺寸 = 逻辑设计值 × 窗口 DPI 缩放。
///
/// 尺寸常量（LYRIC_W / lyric_height_for）是**逻辑像素**（CSS px），而 set_size /
/// outer_size / 位置换算全是物理像素。不乘 scale 的话，高分屏（125%/150%）上
/// `set_size(物理 760×90)` 会把 CSS 视口压到 506×60 —— 工具条吃掉一大半，
/// 歌词只剩一条缝被裁在条底边（真机已复现）。建窗用的 `inner_size` 恰好是逻辑像素，
/// 所以两套单位混用还会导致「刚建好是对的、一切换形态就缩小」。
fn lyric_physical_size(scale: f64, form: &str) -> (i32, i32) {
    let (w, h) = (LYRIC_W as f64, lyric_height_for(form) as f64);
    ((w * scale).round() as i32, (h * scale).round() as i32)
}

/// 取显示器工作区（物理像素）：`(x, y, w, h)`。
/// `idx` 为 `available_monitors()` 的下标；越界或取不到时回落主显示器。
fn monitor_work_area(app: &tauri::AppHandle, idx: Option<i64>) -> Option<(i32, i32, i32, i32)> {
    let monitors = app.available_monitors().ok()?;
    let m = idx
        .and_then(|i| usize::try_from(i).ok())
        .and_then(|i| monitors.get(i))
        .or_else(|| monitors.first())?;
    let wa = m.work_area();
    Some((
        wa.position.x,
        wa.position.y,
        wa.size.width as i32,
        wa.size.height as i32,
    ))
}

/// 计算歌词窗口应放置的物理坐标。
///
/// 位置以**比例**（相对工作区可用空间）存储而非绝对像素：换分辨率或接/拔外接显示器后，
/// 绝对像素会让歌词条落到屏幕外「消失」。存储值还要再校验一次是否仍落在该工作区内，
/// 不满足则回落默认位置 —— 这是拔掉副屏后能自动找回歌词条的兜底。
fn lyric_geometry(app: &tauri::AppHandle, win_w: i32, win_h: i32) -> (i32, i32) {
    let saved = app
        .path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("state.json"))
        .filter(|f| f.exists())
        .and_then(|f| read_json(&f).ok())
        .and_then(|s| s.get("lyric").and_then(|l| l.get("pos")).cloned())
        .filter(|p| p.is_object());

    if let Some(p) = saved {
        let xr = p.get("xRatio").and_then(|v| v.as_f64()).unwrap_or(0.5).clamp(0.0, 1.0);
        let yr = p.get("yRatio").and_then(|v| v.as_f64()).unwrap_or(0.92).clamp(0.0, 1.0);
        let midx = p.get("monitorIndex").and_then(|v| v.as_i64());
        if let Some((wx, wy, ww, wh)) = monitor_work_area(app, midx) {
            let x = wx + ((ww - win_w).max(0) as f64 * xr).round() as i32;
            let y = wy + ((wh - win_h).max(0) as f64 * yr).round() as i32;
            if x >= wx - 4 && x + win_w <= wx + ww + 4 && y >= wy - 4 && y + win_h <= wy + wh + 4 {
                return (x, y);
            }
            log_diag("lyric", "存储位置已越界（分辨率变化 / 副屏移除？），回落默认位置");
        }
    }
    match monitor_work_area(app, None) {
        Some((wx, wy, ww, wh)) => (
            wx + (ww - win_w) / 2,
            wy + wh - win_h - LYRIC_MARGIN_BOTTOM,
        ),
        None => (120, LYRIC_MARGIN_BOTTOM),
    }
}

/// 按需获取歌词窗口：已存在则复用；否则创建（置顶、透明、不可聚焦、隐藏起步）。
/// `h` 为初始窗口高度（单行 56 / 双行 88）——由调用方按 state.lyric.form 传入。
fn ensure_lyric(app: &tauri::AppHandle, h: i32) -> Option<tauri::WebviewWindow> {
    if let Some(win) = app.get_webview_window("lyric") {
        return Some(win);
    }
    WebviewWindowBuilder::new(app, "lyric", WebviewUrl::App("lyric.html".into()))
        .title("桌面歌词")
        .inner_size(LYRIC_W as f64, h as f64)
        .decorations(false)
        .transparent(true)
        .resizable(false)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        // 不可聚焦：歌词条常驻显示，若可聚焦则点它会夺走当前应用的键盘焦点，
        // 打断用户正在进行的输入（与 reminder 窗口同一考量）。
        .focusable(false)
        // 起步隐藏：显示时机收敛到 lyric_ready（拿到内容后 show），
        // 维持「窗口可见 ⟺ 有内容」不变量，避免造出透明却吞鼠标的空窗。
        .visible(false)
        .build()
        .ok()
}

/// 显示/创建桌面歌词窗口。
/// `locked` 为 None 时读 state.json 的 `lyric.locked`（默认 true = 穿透）。
///
/// 建窗与展示必须在后台异步执行：在 Tauri 命令（主线程）里同步 `build()` 会因
/// 「建窗需事件循环而自身又占着主线程」死锁（与 present_reminder 同一坑）。
#[tauri::command]
fn show_lyric(app: tauri::AppHandle) {
    // 悬停解锁 / 自动锁定延时：从 state.json 读取并同步到探测线程
    let (hover_unlock, auto_lock_ms) = read_lyric_cfg(&app);
    LYRIC_HOVER_UNLOCK.store(hover_unlock, Ordering::SeqCst);
    LYRIC_AUTO_LOCK_MS.store(auto_lock_ms, Ordering::SeqCst);
    // 手动锁定标记复位：重新显示歌词条应回到「悬停可解锁」的默认交互
    LYRIC_MANUAL_LOCK.store(false, Ordering::SeqCst);
    // sticky 解锁也复位：重新显示时回到默认的「穿透 + 悬停解锁」，而不是上次的常驻解锁
    LYRIC_STICKY_UNLOCK.store(false, Ordering::SeqCst);
    // 悬停探测线程（幂等）：锁定态下窗口收不到鼠标事件，只能靠 Rust 侧轮询命中测试
    start_lyric_hover_watch(&app);
    let st = read_lyric_state(&app);
    // 初始锁定态在 Rust 侧**统一推导**，不接受调用方传入：
    //   1. 两个入口（音乐页按钮 / 设置页开关）各传各的会让行为不一致；
    //   2. 「悬停解锁」关闭时必须起步可交互 —— 否则一旦锁定，窗口收不到鼠标事件，
    //      用户无法从歌词条自身解锁（只能回设置页），等于把自己卡死。
    let locked = st.get("locked").and_then(|v| v.as_bool()).unwrap_or(true) && hover_unlock;
    // 记录真实锁定态：页面在握手时据此渲染工具条可见性，避免「页面以为可交互、
    // OS 层面其实在穿透」的不一致。
    LYRIC_LOCKED.store(locked, Ordering::SeqCst);
    // 单双行决定窗口高度：切换形态必须真的改高度，不能留透明区（会挡住下方图标点击）
    let form = st.get("form").and_then(|v| v.as_str()).unwrap_or("single").to_string();
    let h = lyric_height_for(&form);
    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        // 已存在 → 复用：复位尺寸/位置/置顶/穿透后显示，不重复建窗。
        if let Some(win) = app2.get_webview_window("lyric") {
            let scale = win.scale_factor().unwrap_or(1.0);
            let (w_phys, h_phys) = lyric_physical_size(scale, &form);
            let _ = win.set_size(tauri::PhysicalSize::new(w_phys as u32, h_phys as u32));
            let (x, y) = lyric_geometry(&app2, w_phys, h_phys);
            let _ = win.set_position(tauri::PhysicalPosition::new(x, y));
            let _ = win.set_always_on_top(true);
            let _ = win.set_ignore_cursor_events(locked);
            let _ = win.show();
            return;
        }
        match ensure_lyric(&app2, h) {
            Some(win) => {
                // ensure_lyric 的 inner_size 是逻辑像素；这里按真实 DPI 换算成物理像素
                // 再校准一次，保证窗口尺寸与后续 set_size / 位置计算同一单位。
                let scale = win.scale_factor().unwrap_or(1.0);
                let (w_phys, h_phys) = lyric_physical_size(scale, &form);
                let _ = win.set_size(tauri::PhysicalSize::new(w_phys as u32, h_phys as u32));
                let (x, y) = lyric_geometry(&app2, w_phys, h_phys);
                let _ = win.set_position(tauri::PhysicalPosition::new(x, y));
                let _ = win.set_always_on_top(true);
                // 穿透开关：锁定态下鼠标完全穿过歌词条，可点到底下的桌面图标/窗口。
                let _ = win.set_ignore_cursor_events(locked);
                // 显示交给 lyric_ready（页面 listener 就绪后 show + emit），
                // 保证「可见」与「有内容」同时发生。
            }
            None => {
                log_diag("lyric", "歌词窗口创建失败");
                let _ = app2.emit("lyric-failed", ());
            }
        }
    });
}

/// 校验歌词自定义颜色：空串 = 跟随默认；否则只接受 #RGB / #RRGGBB。
/// 颜色值最终会进 CSS 变量，宽松接受会注入垃圾到样式表，故在落盘/下发前拦一道。
fn is_lyric_color(v: &str) -> bool {
    let b = v.as_bytes();
    if b.is_empty() {
        return true; // 空 = 跟随默认
    }
    (b.len() == 4 || b.len() == 7) && b[0] == b'#' && b[1..].iter().all(|c| c.is_ascii_hexdigit())
}

/// 设置弹窗（独立窗口 lyric_menu）的尺寸（逻辑像素）：内容 = 菜单卡片本体。
const LYRIC_MENU_W: i32 = 410;
const LYRIC_MENU_H: i32 = 162;

/// 显示/隐藏设置弹窗。歌词条窗口自身**不做任何尺寸变化** —— 菜单是独立置顶窗口，
/// 出现在工具条正上方（底边贴工具条顶边），从机制上杜绝「点设置闪一下」。
#[tauri::command]
fn lyric_menu_toggle(app: tauri::AppHandle) {
    let Some(bar) = app.get_webview_window("lyric") else { return };
    match app.get_webview_window("lyric_menu") {
        Some(menu) => {
            if menu.is_visible().unwrap_or(false) {
                let _ = menu.hide();
                LYRIC_MENU_VISIBLE.store(false, Ordering::SeqCst);
                return;
            }
            position_lyric_menu(&bar, &menu);
            if LYRIC_MENU_READY.load(Ordering::SeqCst) {
                let _ = menu.show();
                LYRIC_MENU_VISIBLE.store(true, Ordering::SeqCst);
            } else {
                // 弹窗页面尚未就绪（首次创建中）：就绪握手后补显示
                LYRIC_MENU_PENDING.store(true, Ordering::SeqCst);
            }
        }
        None => {
            // 首次使用：创建隐藏弹窗（位置在 ready 握手时按歌词条当前位置设置）
            LYRIC_MENU_PENDING.store(true, Ordering::SeqCst);
            let app2 = app.clone();
            tauri::async_runtime::spawn(async move {
                let r = ensure_lyric_menu(&app2);
                if r.is_err() {
                    LYRIC_MENU_PENDING.store(false, Ordering::SeqCst);
                }
            });
        }
    }
}

/// 弹窗创建（隐藏起步，位置按歌词条当前位置换算）。显示交给 lyric_menu_ready 握手
/// （页面 listener 就绪后 show），维持「可见 ⟺ 有内容」不变量。
fn ensure_lyric_menu(app: &tauri::AppHandle) -> Result<(), tauri::Error> {
    let scale = app
        .get_webview_window("lyric")
        .and_then(|w| w.scale_factor().ok())
        .unwrap_or(1.0);
    // 位置：弹窗底边贴工具条顶边，主列中心（左缘 + 95 逻辑 px）对齐按钮组中心。
    // builder.position 取逻辑像素，按 scale 换算。
    let (mut px, mut py) = (100.0, 100.0);
    if let Some(bar) = app.get_webview_window("lyric") {
        if let (Ok(bp), Ok(bs)) = (bar.outer_position(), bar.outer_size()) {
            let group_cx = bp.x as f64 + bs.width as f64 / 2.0;
            px = (group_cx - 95.0 * scale) / scale;
            py = (bp.y as f64 - LYRIC_MENU_H as f64 * scale) / scale;
        }
    }
    WebviewWindowBuilder::new(
        app,
        "lyric_menu",
        WebviewUrl::App("lyric-menu.html".into()),
    )
    .title("桌面歌词设置")
    .inner_size(LYRIC_MENU_W as f64, LYRIC_MENU_H as f64)
    .position(px, py)
    .decorations(false)
    .transparent(true)
    .resizable(false)
    .shadow(false)
    .always_on_top(true)
    .skip_taskbar(true)
    // 不可激活：点击弹窗绝不抢键盘焦点（与歌词条同一考量）
    .focusable(false)
    .visible(false)
    .build()
    .map(|_| ())
}

/// 把弹窗摆到歌词条正上方：底边贴工具条顶边，主列中心对齐按钮组中心。
fn position_lyric_menu(bar: &tauri::WebviewWindow, menu: &tauri::WebviewWindow) {
    let scale = bar.scale_factor().unwrap_or(1.0);
    let (Ok(bp), Ok(bs)) = (bar.outer_position(), bar.outer_size()) else {
        return;
    };
    let group_cx = bp.x as f64 + bs.width as f64 / 2.0;   // 按钮组中心（按钮组在窗口内居中）
    let mx = group_cx - 95.0 * scale;                      // 主列中心 = 弹窗左缘 + 95 逻辑 px
    let my = bp.y as f64 - LYRIC_MENU_H as f64 * scale;    // 底边贴工具条顶边
    let _ = menu.set_size(tauri::PhysicalSize::new(
        (LYRIC_MENU_W as f64 * scale).round() as u32,
        (LYRIC_MENU_H as f64 * scale).round() as u32,
    ));
    let _ = menu.set_position(tauri::PhysicalPosition::new(mx.round() as i32, my.round() as i32));
}

/// 隐藏设置弹窗（歌词条被拖动 / 手动锁定 / 隐藏时调用）。
fn hide_lyric_menu(app: &tauri::AppHandle) {
    LYRIC_MENU_PENDING.store(false, Ordering::SeqCst);
    if let Some(menu) = app.get_webview_window("lyric_menu") {
        if menu.is_visible().unwrap_or(false) {
            let _ = menu.hide();
        }
    }
    LYRIC_MENU_VISIBLE.store(false, Ordering::SeqCst);
}

/// 弹窗页 listener 就绪握手：下发当前配置 + 按需补显示。
#[tauri::command]
fn lyric_menu_ready(app: tauri::AppHandle) {
    LYRIC_MENU_READY.store(true, Ordering::SeqCst);
    let st = read_lyric_state(&app);
    let form = st.get("form").and_then(|v| v.as_str()).unwrap_or("single");
    let style = st.get("style").and_then(|v| v.as_str()).unwrap_or("stroke");
    let align = st.get("align").and_then(|v| v.as_str()).unwrap_or("center");
    let font_size = st.get("fontSize").and_then(|v| v.as_u64()).unwrap_or(22).clamp(12, 28);
    let color_text = st.get("colorText").and_then(|v| v.as_str()).filter(|v| is_lyric_color(v)).unwrap_or("");
    let color_fill = st.get("colorFill").and_then(|v| v.as_str()).filter(|v| is_lyric_color(v)).unwrap_or("");
    let offset = st.get("offset").and_then(|v| v.as_f64()).unwrap_or(0.0);
    let _ = app.emit_to(
        "lyric_menu",
        "lyric://display",
        serde_json::json!({
            "form": form, "style": style, "align": align, "fontSize": font_size,
            "colorText": color_text, "colorFill": color_fill, "offset": offset,
        }),
    );
    if LYRIC_MENU_PENDING.swap(false, Ordering::SeqCst) {
        if let (Some(bar), Some(menu)) = (app.get_webview_window("lyric"), app.get_webview_window("lyric_menu")) {
            position_lyric_menu(&bar, &menu);
            let _ = menu.show();
            LYRIC_MENU_VISIBLE.store(true, Ordering::SeqCst);
        }
    }
}

/// 提交歌词条显示配置（形态 / 视觉模式 / 字号 / 自定义颜色）。设置页与歌词页按钮共用。
///
/// 为什么要绕经 Rust，而不是页面自己搞定：
/// 1. 单双行必须真的改**窗口高度**（90 → 122）。留一块透明区来「假装双行」会让条下方
///    那段区域继续吞鼠标，破坏穿透 —— 这正是本功能最容易踩的坑。
/// 2. 歌词页不能自己写 state.json（整体覆盖写 + 它只有启动时的旧快照），
///    故配置统一广播出去，由**主窗口**落盘（唯一写者原则）。
///
/// 广播用全局 `emit` 而非 `emit_to("lyric")`：主窗口也要收到才能持久化。
#[tauri::command]
fn lyric_commit_display(
    app: tauri::AppHandle,
    form: Option<String>,
    style: Option<String>,
    align: Option<String>,
    font_size: Option<u32>,
    color_text: Option<String>,
    color_fill: Option<String>,
    offset: Option<f64>,
) {
    let st = read_lyric_state(&app);
    // 非法值一律回落 state / 默认，不信任调用方传入的枚举
    let form = form
        .filter(|f| f == "single" || f == "double")
        .unwrap_or_else(|| st.get("form").and_then(|v| v.as_str()).unwrap_or("single").to_string());
    let style = style
        .filter(|s| matches!(s.as_str(), "stroke" | "capsule" | "bold"))
        .unwrap_or_else(|| st.get("style").and_then(|v| v.as_str()).unwrap_or("stroke").to_string());
    // 对齐方式：left | center | right（参考网易云桌面歌词）。非法值回落 state / 默认居中。
    let align = align
        .filter(|a| matches!(a.as_str(), "left" | "center" | "right"))
        .unwrap_or_else(|| st.get("align").and_then(|v| v.as_str()).unwrap_or("center").to_string());
    let font_size = font_size
        .map(|n| n.clamp(12, 28))
        .or_else(|| st.get("fontSize").and_then(|v| v.as_u64()).map(|n| (n as u32).clamp(12, 28)))
        .unwrap_or(22);
    // 自定义颜色：调用方显式给了合法值（含空串=重置）就用它；给了脏值或没给则回落 state。
    let color_text = color_text
        .map(|v| v.trim().to_string())
        .filter(|v| is_lyric_color(v))
        .or_else(|| st.get("colorText").and_then(|v| v.as_str()).map(str::to_string).filter(|v| is_lyric_color(v)))
        .unwrap_or_default();
    let color_fill = color_fill
        .map(|v| v.trim().to_string())
        .filter(|v| is_lyric_color(v))
        .or_else(|| st.get("colorFill").and_then(|v| v.as_str()).map(str::to_string).filter(|v| is_lyric_color(v)))
        .unwrap_or_default();
    // 时间偏移：半秒步进，clamp ±5（前端工具条点「同步」按钮循环档位）
    let offset = offset
        .map(|v| ((v.max(-5.0).min(5.0) * 2.0).round()) / 2.0)
        .or_else(|| st.get("offset").and_then(|v| v.as_f64()).map(|v| ((v.max(-5.0).min(5.0) * 2.0).round()) / 2.0))
        .unwrap_or(0.0);
    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Some(win) = app2.get_webview_window("lyric") {
            let scale = win.scale_factor().unwrap_or(1.0);
            let (w_phys, h_phys) = lyric_physical_size(scale, &form);
            let cur = win.outer_size().ok();
            let cur_w = cur.map(|s| s.width as i32).unwrap_or(w_phys);
            let cur_h = cur.map(|s| s.height as i32).unwrap_or(h_phys);
            if cur_w != w_phys || cur_h != h_phys {
                // **底边锚定**：歌词区贴在窗口底部，高度变化时把顶边反向平移同样的量，
                // 歌词在屏幕上的位置就完全不动 —— 否则单双行切换会让歌词条上下跳。
                // 也刻意**不读** state.json 的 pos：那是以旧窗口高度换算的比例，直接套用
                // 会把歌词条挪到别处，看起来像「拖好的位置丢了、回到了原来的地方」。
                let old = win.outer_position().ok();
                let _ = win.set_size(tauri::PhysicalSize::new(w_phys as u32, h_phys as u32));
                if let Some(op) = old {
                    let _ = win.set_position(tauri::PhysicalPosition::new(
                        op.x,
                        op.y + (cur_h - h_phys),
                    ));
                }
            }
        }
        let _ = app.emit(
            "lyric://display",
            serde_json::json!({
                "form": form, "style": style, "align": align, "fontSize": font_size,
                "colorText": color_text, "colorFill": color_fill, "offset": offset,
            }),
        );
    });
}

/// 隐藏并销毁桌面歌词窗口（释放 WebView2 实例）。
#[tauri::command]
fn hide_lyric(app: tauri::AppHandle) {
    LYRIC_PAGE_READY.store(false, Ordering::SeqCst);
    *PENDING_LYRIC.lock().unwrap() = None;
    hide_lyric_menu(&app);
    if let Some(win) = app.get_webview_window("lyric") {
        let _ = win.hide();
        let _ = win.destroy();
    }
    let _ = app.emit("lyric-hidden", ());
}

/// 歌词页 listener 就绪后调用：置位标志、显示窗口、取用暂存内容。
/// 无暂存内容时仍显示占位行（歌词条有固定语义内容，不存在「空窗」）。
#[tauri::command]
fn lyric_ready(app: tauri::AppHandle) {
    LYRIC_PAGE_READY.store(true, Ordering::SeqCst);
    let win = match app.get_webview_window("lyric") {
        Some(w) => w,
        None => {
            LYRIC_PAGE_READY.store(false, Ordering::SeqCst);
            return;
        }
    };
    // 先下发显示配置：新建窗口的页面默认是 single+stroke+center+22+默认配色，
    // 若 state 里存的是别的值，不推一次就会出现「窗口高 88 但只画一行」「自定义配色丢失」。
    // 这里下发**完整**配置（含颜色/对齐）—— 旧版只推 form/style/fontSize，
    // 重开歌词窗口后自定义配色会被页面默认值覆盖（实测丢失），故一并修复。
    let st = read_lyric_state(&app);
    let form = st.get("form").and_then(|v| v.as_str()).unwrap_or("single");
    let style = st.get("style").and_then(|v| v.as_str()).unwrap_or("stroke");
    let align = st.get("align").and_then(|v| v.as_str()).unwrap_or("center");
    let font_size = st.get("fontSize").and_then(|v| v.as_u64()).unwrap_or(22).clamp(12, 28);
    let color_text = st.get("colorText").and_then(|v| v.as_str()).filter(|v| is_lyric_color(v)).unwrap_or("");
    let color_fill = st.get("colorFill").and_then(|v| v.as_str()).filter(|v| is_lyric_color(v)).unwrap_or("");
    let _ = app.emit_to(
        "lyric",
        "lyric://display",
        serde_json::json!({
            "form": form, "style": style, "align": align, "fontSize": font_size,
            "colorText": color_text, "colorFill": color_fill,
        }),
    );
    // 下发**真实**锁定态：OS 级穿透状态只有 Rust 知道。缺了这一步，页面会停在
    // HTML 里的 data-locked="true" 默认值，出现「页面显示锁定、实际可交互」的错位。
    let _ = app.emit_to("lyric", "lyric://locked", locked_payload());
    if let Some(p) = PENDING_LYRIC.lock().unwrap().take() {
        let _ = app.emit_to("lyric", "lyric://line", p);
    }
    let _ = win.show();
}

/// 主窗口推送歌词行 → 转发给 lyric 窗口（页面未就绪则暂存）。
#[tauri::command]
fn lyric_sync(app: tauri::AppHandle, payload: serde_json::Value) {
    if LYRIC_PAGE_READY.load(Ordering::SeqCst) {
        let _ = app.emit_to("lyric", "lyric://line", payload);
    } else {
        *PENDING_LYRIC.lock().unwrap() = Some(payload);
    }
}

/// 构造 `lyric://locked` 的下发载荷。
///
/// 集中一处，避免各调用点漏字段：页面要同时知道
/// ① OS 级穿透态（locked）② 是否「保持解锁」（sticky）③ 悬停解锁开关（hoverUnlock，
/// 关掉时锁定按钮必须置灰 —— 否则锁上就再没有回到可交互的途径）。
fn locked_payload() -> serde_json::Value {
    serde_json::json!({
        "locked": LYRIC_LOCKED.load(Ordering::SeqCst),
        "sticky": LYRIC_STICKY_UNLOCK.load(Ordering::SeqCst),
        "hoverUnlock": LYRIC_HOVER_UNLOCK.load(Ordering::SeqCst),
    })
}

/// 切换穿透（锁定/解锁）。由歌词页工具条或悬停探测线程调用。
///
/// `locked = false` 表示用户**显式解锁**（点了「解锁」按钮）→ 置 sticky，
/// 探测线程不再自动锁回；`locked = true` 表示立即穿透（并清掉 sticky）。
#[tauri::command]
fn lyric_set_locked(app: tauri::AppHandle, locked: bool) {
    LYRIC_STICKY_UNLOCK.store(!locked, Ordering::SeqCst);
    // 手动锁定：悬停**不**自动解锁 —— 只有把鼠标移到顶部工具条区域才会临时放行
    // （见探测线程 manual 分支）。否则锁定后鼠标一划过歌词条就又解锁了，锁定形同虚设。
    LYRIC_MANUAL_LOCK.store(locked, Ordering::SeqCst);
    // 手动锁定时收起设置弹窗（锁定语义 = 歌词条让位给桌面，弹窗不该悬着）
    if locked {
        hide_lyric_menu(&app);
    }
    if let Some(win) = app.get_webview_window("lyric") {
        let _ = win.set_ignore_cursor_events(locked);
        LYRIC_LOCKED.store(locked, Ordering::SeqCst);
        // 重置悬停标记，让探测线程从干净的状态开始：
        // 锁定时鼠标多半停在工具条上（在窗口内），置 true 可避免下一轮误判「刚移入」而立刻解锁。
        LYRIC_HOVERED.store(locked, Ordering::SeqCst);
        // 回发确认：让页面与 OS 真实状态保持一致。
        // 页面自身点击触发的回声是幂等的；这条主要服务于「外部发起」的场景
        // （设置页 / 未来的全局热键），否则页面会停在旧的锁定态显示。
        let _ = app.emit_to("lyric", "lyric://locked", locked_payload());
    }
}

/// 拖动歌词条：由歌词页在 pointermove 时**按 rAF 节流**调用，避免高频 IPC + SetWindowPos 卡顿。
/// 拖动开始（第一次移动）即收起设置弹窗 —— 弹窗位置固定于旧位置，跟随拖动会错位。
#[tauri::command]
fn lyric_move(app: tauri::AppHandle, x: i32, y: i32) {
    hide_lyric_menu(&app);
    if let Some(win) = app.get_webview_window("lyric") {
        let _ = win.set_position(tauri::PhysicalPosition::new(x, y));
    }
}

/// 拖动结束：把新位置交回**主窗口**落盘。
///
/// 歌词窗口不能自己调 save_state —— save_state 是整体覆盖写，而歌词窗口手里只有启动时的
/// 旧快照，落盘会抹掉主窗口刚写的任务/笔记改动。故维持「主窗口是 state.json 唯一写者」，
/// 位置变更经事件交给它（与 state.js「避免多份快照互相覆盖」的原则一致）。
#[tauri::command]
fn lyric_pos_commit(app: tauri::AppHandle, x_ratio: f64, y_ratio: f64, monitor_index: i64) {
    let payload = serde_json::json!({
        "xRatio": x_ratio.clamp(0.0, 1.0),
        "yRatio": y_ratio.clamp(0.0, 1.0),
        "monitorIndex": monitor_index,
    });
    let _ = app.emit("lyric://moved", payload);
}

// ────────────────── 悬停探测（P3：悬停自动解锁 / 离开自动锁定） ──────────────────
//
// 为什么必须在 Rust 侧做：**锁定态下窗口对鼠标完全透明**（WS_EX_TRANSPARENT），
// 鼠标事件根本到不了页面 —— 所以 CSS `:hover`、`pointerenter` 在锁定态**永远不会触发**。
// 而「悬停解锁」恰恰要从锁定态开始，靠页面事件是逻辑死循环。
//
// 解法：后台线程轮询光标位置，与歌词窗口矩形做命中测试，命中/离开时切换锁定态。
// 用 120ms 轮询（约 8Hz）而非更高频：肉眼可感的响应延迟在 100ms 上下，
// 再快只是徒增 CPU 唤醒，且解锁本身需要一次 set_ignore_cursor_events 的系统调用。
//
// 关键：**只在「锁定态 ↔ 命中」的组合下才动作**，避免与用户手动锁定打架 ——
// 用户主动锁定后若鼠标恰好停在条上，不应立刻被自动解锁（那会让手动锁定形同虚设）。

/// 悬停探测线程是否已启动（只启动一次）。
static LYRIC_HOVER_WATCH: AtomicBool = AtomicBool::new(false);
/// 用户是否**手动**锁定（手动锁定后，悬停不再自动解锁；移出后清空）。
static LYRIC_MANUAL_LOCK: AtomicBool = AtomicBool::new(false);
/// 用户是否显式要求「解锁并保持可交互」（对应歌词条上的「解锁」按钮）。
///
/// 为什么需要它：悬停解锁只是**临时**的 —— 鼠标一移开，自动锁定计时到点就把窗口锁回。
/// 用户点「解锁」的语义是「我要反复拖动 / 调样式，别锁回去」，故需要这个持久标记；
/// 否则解锁按钮点完几乎立刻失效，等于没用。
static LYRIC_STICKY_UNLOCK: AtomicBool = AtomicBool::new(false);
/// 当前是否处于「光标命中歌词条」状态（供前端查询与去重）。
static LYRIC_HOVERED: AtomicBool = AtomicBool::new(false);
/// 悬停自动解锁是否启用（对应 state.lyric.hoverUnlock）。
static LYRIC_HOVER_UNLOCK: AtomicBool = AtomicBool::new(true);
/// 自动锁定延时（毫秒）：鼠标移出后多久锁回。对应 state.lyric.autoLockMs。
static LYRIC_AUTO_LOCK_MS: AtomicU64 = AtomicU64::new(3000);

/// 读取 `state.json` 里的歌词配置（悬停解锁开关 + 自动锁定延时）。
/// 容错：文件缺失/字段缺失一律用默认值，不阻塞窗口创建。
fn read_lyric_cfg(app: &tauri::AppHandle) -> (bool, u64) {
    let v = app
        .path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("state.json"))
        .filter(|f| f.exists())
        .and_then(|f| read_json(&f).ok())
        .and_then(|s| s.get("lyric").cloned());
    let hover = v
        .as_ref()
        .and_then(|l| l.get("hoverUnlock"))
        .and_then(|b| b.as_bool())
        .unwrap_or(true);
    // autoLockMs 允许 0（表示移出后立即锁定），故用 as_u64 而非带默认的 unwrap
    let ms = v
        .as_ref()
        .and_then(|l| l.get("autoLockMs"))
        .and_then(|n| n.as_u64())
        .unwrap_or(3000)
        .min(60_000);
    (hover, ms)
}

/// 启动歌词条悬停探测线程（幂等；在 show_lyric 首次建窗时调用）。
fn start_lyric_hover_watch(app: &tauri::AppHandle) {
    if LYRIC_HOVER_WATCH.swap(true, Ordering::SeqCst) {
        return; // 已启动
    }
    let app = app.clone();
    std::thread::spawn(move || {
        const POLL_MS: u64 = 120;
        // 移出后的锁定倒计时（毫秒累计）
        let mut leave_acc: u64 = 0;
        // 上一轮「光标是否在工具条区域」——手动锁定模式下据此切换穿透开关（见下）
        let mut tools_prev = false;
        // 设置弹窗：光标移出（弹窗+歌词条之外）的轮询累计（≥4 轮 ≈ 480ms → 收起）
        let mut menu_out_acc: u32 = 0;
        loop {
            std::thread::sleep(std::time::Duration::from_millis(POLL_MS));
            // 窗口不存在 → 重置全部状态，线程继续等（不退出，避免反复创建线程）
            let win = match app.get_webview_window("lyric") {
                Some(w) => w,
                None => {
                    LYRIC_HOVERED.store(false, Ordering::SeqCst);
                    LYRIC_MANUAL_LOCK.store(false, Ordering::SeqCst);
                    LYRIC_STICKY_UNLOCK.store(false, Ordering::SeqCst);
                    leave_acc = 0;
                    continue;
                }
            };
            // 窗口不可见时不做任何判定（隐藏/销毁中）
            if !win.is_visible().unwrap_or(false) {
                leave_acc = 0;
                continue;
            }
            // 命中测试（物理像素，避免 DPI 换算误差）：
            //   hit       —— 光标是否在窗口矩形内
            //   hit_tools —— 光标是否在**顶部工具条区域**内（窗口顶部 LYRIC_TOOLS_H 像素）
            //   in_menu   —— 光标是否在设置弹窗内（弹窗打开期间视为「仍在操作」）
            let (hit, hit_tools, _in_menu) = {
                let (c, p, s) = match (app.cursor_position(), win.outer_position(), win.outer_size()) {
                    (Ok(c), Ok(p), Ok(s)) => (c, p, s),
                    _ => {
                        leave_acc = 0;
                        continue;
                    }
                };
                let inside = c.x >= p.x as f64
                    && c.x <= (p.x + s.width as i32) as f64
                    && c.y >= p.y as f64
                    && c.y <= (p.y + s.height as i32) as f64;
                let in_tools = inside && (c.y - p.y as f64) < LYRIC_TOOLS_H as f64;
                // 设置弹窗：独立窗口，命中其矩形即视为「正在操作设置」
                let mut in_menu = false;
                if LYRIC_MENU_VISIBLE.load(Ordering::SeqCst) {
                    if let Some(menu) = app.get_webview_window("lyric_menu") {
                        if menu.is_visible().unwrap_or(false) {
                            if let (Ok(mp), Ok(ms)) = (menu.outer_position(), menu.outer_size()) {
                                in_menu = c.x >= mp.x as f64
                                    && c.x <= (mp.x + ms.width as i32) as f64
                                    && c.y >= mp.y as f64
                                    && c.y <= (mp.y + ms.height as i32) as f64;
                            }
                            // 光标在弹窗外（且不在歌词条上）累计 4 轮（≈480ms）→ 自动收起
                            if !in_menu && !inside {
                                menu_out_acc += 1;
                                if menu_out_acc >= 4 {
                                    menu_out_acc = 0;
                                    let _ = menu.hide();
                                    LYRIC_MENU_VISIBLE.store(false, Ordering::SeqCst);
                                }
                            } else {
                                menu_out_acc = 0;
                            }
                        }
                    } else {
                        LYRIC_MENU_VISIBLE.store(false, Ordering::SeqCst);
                    }
                } else {
                    menu_out_acc = 0;
                }
                (inside || in_menu, in_tools, in_menu)
            };
            let was_hit = LYRIC_HOVERED.swap(hit, Ordering::SeqCst);
            let manual = LYRIC_MANUAL_LOCK.load(Ordering::SeqCst);
            let enabled = LYRIC_HOVER_UNLOCK.load(Ordering::SeqCst);
            let sticky = LYRIC_STICKY_UNLOCK.load(Ordering::SeqCst);

            if manual {
                // 手动锁定：歌词区域**完全穿透**（点得到底下的窗口/图标），
                // 只有顶部工具条例外 —— 鼠标移到那里才临时放行，让用户能点到「解锁」。
                // 网易云同款交互：锁定后操作条只在鼠标靠到顶部时出现。
                // 注意此处**不改 LYRIC_LOCKED / 不发事件**：逻辑上仍是锁定态，
                // 页面 data-locked 保持 true，工具条里只显示「解锁」一个按钮。
                if hit_tools && !tools_prev {
                    let _ = win.set_ignore_cursor_events(false);
                } else if !hit_tools && tools_prev {
                    let _ = win.set_ignore_cursor_events(true);
                }
                tools_prev = hit_tools;
                leave_acc = 0;
            } else if hit {
                leave_acc = 0;
                // 命中：解锁以便交互。手动锁定期间不解锁（否则手动锁定形同虚设）。
                if (enabled || sticky) && !manual && !was_hit {
                    let _ = win.set_ignore_cursor_events(false);
                    LYRIC_LOCKED.store(false, Ordering::SeqCst);
                    let _ = app.emit_to("lyric", "lyric://locked", locked_payload());
                }
            } else {
                // 移出：累计延时，到点锁回（仅当此前命中过，避免启动即锁）。
                // sticky 解锁期间不锁回 —— 用户显式要求保持可交互。
                if was_hit && !sticky {
                    let auto_ms = LYRIC_AUTO_LOCK_MS.load(Ordering::SeqCst);
                    leave_acc += POLL_MS;
                    if leave_acc >= auto_ms {
                        leave_acc = 0;
                        let _ = win.set_ignore_cursor_events(true);
                        LYRIC_LOCKED.store(true, Ordering::SeqCst);
                        let _ = app.emit_to("lyric", "lyric://locked", locked_payload());
                    }
                }
            }
        }
    });
}

/// 同步歌词配置到探测线程（前端改设置后调用）。
#[tauri::command]
fn lyric_apply_cfg(hover_unlock: Option<bool>, auto_lock_ms: Option<u64>) {
    if let Some(h) = hover_unlock {
        LYRIC_HOVER_UNLOCK.store(h, Ordering::SeqCst);
    }
    if let Some(ms) = auto_lock_ms {
        LYRIC_AUTO_LOCK_MS.store(ms.min(60_000), Ordering::SeqCst);
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
                // accept-encoding 必须剥离：插件手动透传 gzip 时 ureq 不做透明解压
                //（只解压自己协商的头），响应保持压缩字节 → read_to_string 报
                // "stream did not contain valid UTF-8"。剥掉后由 ureq（gzip feature）
                // 自动协商并解压，文本通道始终拿到明文。
                if k.eq_ignore_ascii_case("accept-encoding") {
                    continue;
                }
                r = r.set(k, s);
            }
        }
    }
    r
}

/// 响应字节 → 文本（http_get / http_post 共用）。
/// 1) gzip 魔数(1f 8b)强制解压——部分服务器无视协商头硬性返回压缩字节；
/// 2) 严格 UTF-8 优先；失败时按 Content-Type charset 解码，未声明则回退 GBK
///    （中文站点非 UTF-8 响应的常态），避免 "stream did not contain valid UTF-8"。
fn decode_response(resp: ureq::Response) -> Result<String, String> {
    let content_type = resp.header("Content-Type").unwrap_or("").to_string();
    let mut bytes = Vec::new();
    resp.into_reader()
        .take(5 * 1024 * 1024)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() > 2 && bytes[0] == 0x1f && bytes[1] == 0x8b {
        let mut gz = flate2::read::GzDecoder::new(&bytes[..]);
        let mut raw = Vec::new();
        gz.read_to_end(&mut raw)
            .map_err(|e| format!("gzip 解压失败：{e}"))?;
        bytes = raw;
    }
    if let Ok(s) = std::str::from_utf8(&bytes) {
        return Ok(s.to_string());
    }
    let charset = content_type
        .split(';')
        .find_map(|p| p.trim().strip_prefix("charset=").map(|c| c.trim_matches('"').trim().to_string()))
        .unwrap_or_default();
    let enc = encoding_rs::Encoding::for_label(charset.as_bytes())
        .or_else(|| encoding_rs::Encoding::for_label(b"gbk"))
        .unwrap_or(encoding_rs::UTF_8);
    let (text, _encoding, _had_errors) = enc.decode(&bytes);
    Ok(text.into_owned())
}

/// HTTP GET 代理：绕过 WebView 跨域限制，供音乐音源插件请求第三方接口。
/// headers 为可选 JSON 对象（键值均为字符串）。
/// 注意：ureq 为阻塞式 I/O，禁止在主线程命令里直接调用，否则整个应用（含 WebView 事件循环）
/// 会在请求期间冻结（最长 15s 超时）。因此命令声明为 async，把阻塞逻辑放进 spawn_blocking。
fn http_get_blocking(url: String, headers: Option<serde_json::Value>) -> Result<String, String> {
    let u = url.trim();
    if !(u.starts_with("http://") || u.starts_with("https://")) {
        return Err("仅支持 http/https 地址".to_string());
    }
    let resp = build_headers(agent().get(u), &headers)
        .timeout(std::time::Duration::from_secs(15))
        .call()
        .map_err(|e| e.to_string())?;
    decode_response(resp)
}

#[tauri::command]
async fn http_get(url: String, headers: Option<serde_json::Value>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || http_get_blocking(url, headers))
        .await
        .map_err(|e| format!("网络任务执行失败: {e}"))?
}

/// HTTP POST 代理：同 http_get，支持发送请求体（JSON/表单字符串）。
fn http_post_blocking(url: String, body: String, headers: Option<serde_json::Value>) -> Result<String, String> {
    let u = url.trim();
    if !(u.starts_with("http://") || u.starts_with("https://")) {
        return Err("仅支持 http/https 地址".to_string());
    }
    let resp = build_headers(agent().post(u), &headers)
        .timeout(std::time::Duration::from_secs(15))
        .send_string(&body)
        .map_err(|e| e.to_string())?;
    decode_response(resp)
}

#[tauri::command]
async fn http_post(url: String, body: String, headers: Option<serde_json::Value>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || http_post_blocking(url, body, headers))
        .await
        .map_err(|e| format!("网络任务执行失败: {e}"))?
}

/// HTTP GET 二进制代理：返回 base64 编码的响应体。
/// 供音源插件 `responseType: "arraybuffer"` 请求使用（如咪咕 VIP 加密取流），
/// 二进制不能走 http_get 文本通道（UTF-8 解码会损坏/报错）。
#[tauri::command]
async fn http_get_bytes(url: String, headers: Option<serde_json::Value>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let u = url.trim();
        if !(u.starts_with("http://") || u.starts_with("https://")) {
            return Err("仅支持 http/https 地址".to_string());
        }
        let resp = build_headers(agent().get(u), &headers)
            .timeout(std::time::Duration::from_secs(15))
            .call()
            .map_err(|e| e.to_string())?;
        let mut bytes = Vec::new();
        resp.into_reader()
            .take(5 * 1024 * 1024)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        use base64::Engine as _;
        Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
    })
    .await
    .map_err(|e| format!("网络任务执行失败: {e}"))?
}

/// 抓取指定 http(s) 地址响应的原始字节（上限 2MB）。供 favicon 图标读取。
fn fetch_bytes(url: &str) -> Result<Vec<u8>, String> {
    let resp = build_headers(agent().get(url), &None)
        .timeout(std::time::Duration::from_secs(10))
        .call()
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    resp.into_reader()
        .take(2 * 1024 * 1024)
        .read_to_end(&mut out)
        .map_err(|e| e.to_string())?;
    Ok(out)
}

/// 从首页 HTML 中提取第一个 `<link ... rel=...icon ... href=...>` 的 href 值。
/// 返回原始 href（可能为绝对或相对路径）。找不到返回 None。
fn icon_href_from_html(html: &str) -> Option<String> {
    let low = html.to_ascii_lowercase();
    let mut from = 0;
    while let Some(start) = low[from..].find("<link") {
        let s = from + start;
        let rest = &low[s + 5..];
        let e = rest.find('>').map(|i| s + 5 + i).unwrap_or(low.len());
        let tag = &html[s..e.min(html.len())]; // 原大小写，便于取属性值
        // 仅关注 rel 中带 icon 的 link
        if tag.to_ascii_lowercase().contains("icon") {
            if let Some(v) = take_href_attr(&tag[5..]) {
                return Some(v);
            }
        }
        from = e + 1;
    }
    None
}

/// 取标签内 `href=` 的值（支持单双引号与 `href = "…"` 间隔）。
fn take_href_attr(tag_inner: &str) -> Option<String> {
    let low = tag_inner.to_ascii_lowercase();
    let pos = low.find("href=")?;
    let after = tag_inner[pos + 5..].trim_start();
    let quote = after.chars().next()?;
    if quote != '"' && quote != '\'' {
        return None;
    }
    let end = after[1..].find(quote)?;
    Some(after[1..1 + end].to_string())
}

/// 把可能为相对路径的 href 解析为绝对 URL（基于站点 origin）。
fn resolve_url(href: &str, origin: &str) -> String {
    if href.starts_with("http://") || href.starts_with("https://") {
        return href.to_string();
    }
    if href.starts_with("//") {
        let scheme = origin.split(':').next().unwrap_or("http");
        return format!("{scheme}:{href}");
    }
    if href.starts_with('/') {
        return format!("{origin}{href}");
    }
    format!("{origin}/{href}")
}

/// 图标字节 → 可内联 data URL：SVG 原样返回；位图解码后重编码为 ≤32px PNG；否则 None。
fn encode_icon(bin: &[u8]) -> Option<String> {
    use base64::engine::general_purpose::STANDARD;
    use base64::Engine;
    let head = String::from_utf8_lossy(&bin[..bin.len().min(1024)]);
    // SVG：文本以 `<…<svg` 开头，浏览器可在 <img> 直接渲染
    if head.trim_start().starts_with('<') && head.contains("<svg") {
        return Some(format!("data:image/svg+xml;base64,{}", STANDARD.encode(bin)));
    }
    let img = image::load_from_memory(bin).ok()?;
    let thumb = img.thumbnail(32, 32);
    let mut buf = Vec::new();
    thumb
        .write_to(&mut std::io::Cursor::new(&mut buf), image::ImageFormat::Png)
        .ok()?;
    Some(format!("data:image/png;base64,{}", STANDARD.encode(buf)))
}

/// 快捷访问：添加网址时自动获取站点图标（favicon）。
/// 优先解析站点首页 `<link rel="icon">` 的图标地址，再兜底常见路径；
/// 取首个能识别的图标，SVG 原样、位图统一重编码为 ≤32px，返回 base64 data URL；
/// 全部失败返回 Err（前端回退到默认地球图标）。
/// ureq + 图片解码均为阻塞操作，走 spawn_blocking 后台线程（同 http_get/http_post）。
fn fetch_favicon_blocking(url: String) -> Result<String, String> {
    let u = url.trim();
    let scheme_end = u.find("://").ok_or("仅支持 http/https 地址".to_string())?;
    let (scheme, rest) = (&u[..scheme_end], &u[scheme_end + 3..]);
    if scheme != "http" && scheme != "https" {
        return Err("仅支持 http/https 地址".to_string());
    }
    let host_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let origin = format!("{}://{}", scheme, &rest[..host_end]);

    // 优先从首页 <link rel="icon"> 解析真实图标地址（不少站点对未知路径回退首页 HTML，导致固定路径探测失败）
    let mut candidates: Vec<String> = Vec::new();
    if let Ok(html_bytes) = fetch_bytes(&format!("{origin}/")) {
        let html = String::from_utf8_lossy(&html_bytes);
        if let Some(h) = icon_href_from_html(&html) {
            candidates.push(resolve_url(&h, &origin));
        }
    }
    candidates.extend([
        format!("{origin}/favicon.ico"),
        format!("{origin}/favicon.png"),
        format!("{origin}/favicon-32x32.png"),
        format!("{origin}/apple-touch-icon.png"),
    ]);

    for cu in candidates {
        if let Ok(bin) = fetch_bytes(&cu) {
            if let Some(data) = encode_icon(&bin) {
                return Ok(data);
            }
        }
    }
    Err("未找到站点图标".to_string())
}

#[tauri::command]
async fn fetch_favicon(url: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || fetch_favicon_blocking(url))
        .await
        .map_err(|e| format!("图标任务执行失败: {e}"))?
}

/// 启动系统指标读取 JSON 文件为 Value。
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

/// 导出文本文件：弹出系统「另存为」对话框，把内容写入用户选择的路径。
/// 返回保存后的绝对路径；用户取消返回 None。
/// 供「笔记列表 → 导出 Markdown」等场景复用；extensions 为空时不注册类型过滤。
#[tauri::command]
fn export_text_file(
    app: tauri::AppHandle,
    default_name: String,
    content: String,
    filter_name: Option<String>,
    extensions: Option<Vec<String>>,
) -> Result<Option<String>, String> {
    let mut dialog = app.dialog().file().set_file_name(default_name.trim());
    if let (Some(name), Some(exts)) = (filter_name.as_deref(), extensions.as_deref()) {
        if !name.trim().is_empty() && !exts.is_empty() {
            let refs: Vec<&str> = exts.iter().map(|s| s.as_str()).collect();
            dialog = dialog.add_filter(name.trim(), &refs);
        }
    }
    let Some(path) = dialog.blocking_save_file().map(|p| p.to_string()) else {
        return Ok(None);
    };
    fs::write(&path, content).map_err(|e| format!("写入文件失败：{e}"))?;
    Ok(Some(path))
}

/// 读取持久化状态。
/// state.json 存业务数据；音乐相关（音源插件脚本 musicSources / 收藏 favorites / 播放状态 playback）
/// 统一独立存 music.json；workLogs（工作记录）独立存 worklogs.json；notes（笔记列表）独立存 notes.json。
/// 老数据迁移：state.json 中残留的这几个字段会保留返回，下次保存自动分流；旧版 sources.json 作兜底。
#[tauri::command]
fn load_state(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let file = dir.join("state.json");
    let mut state = if !file.exists() {
        serde_json::json!({
            "currentModule": "dashboard",
            "tasks": [],
            "notes": []
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
    // 笔记列表独立文件（存在则覆盖合并）
    let notes_file = dir.join("notes.json");
    if notes_file.exists() {
        if let Ok(nv) = read_json(&notes_file) {
            state["notes"] = nv;
        }
    }
    // 旧版迁移：state.notes 为 string 时自动包装为数组
    if let Some(n) = state.get("notes") {
        if n.is_string() {
            let now = 0;
            state["notes"] = serde_json::json!([{
                "id": "migrated",
                "title": "未命名",
                "content": n,
                "pinned": false,
                "createdAt": now,
                "updatedAt": now
            }]);
        }
    }
    Ok(state)
}

/// 写入持久化状态：音乐字段分流到 music.json、workLogs 分流到 worklogs.json、notes 分流到 notes.json，其余写 state.json。
#[tauri::command]
fn save_state(app: tauri::AppHandle, state: serde_json::Value) -> Result<(), String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let mut state = state;
    let (music_file_val, logs, notes_val) = if let Some(obj) = state.as_object_mut() {
        let music = serde_json::json!({
            "musicSources": obj.remove("musicSources").unwrap_or(serde_json::json!([])),
            "favorites": obj.remove("favorites").unwrap_or(serde_json::json!([])),
            "playback": obj.remove("playback").unwrap_or(serde_json::json!({})),
        });
        (Some(music), obj.remove("workLogs"), obj.remove("notes"))
    } else {
        (None, None, None)
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
    fs::write(&logs_file, ldata).map_err(|e| e.to_string())?;

    // 笔记列表（持续增长的用户数据独立文件，便于单独备份；单篇导出走 export_text_file）
    let notes_file = dir.join("notes.json");
    let ndata = serde_json::to_string_pretty(&notes_val.unwrap_or_else(|| serde_json::json!([])))
        .map_err(|e| e.to_string())?;
    fs::write(&notes_file, ndata).map_err(|e| e.to_string())
}

/// 读取主题配置快照（轻量只读）：锁屏/提醒窗口启动时拉取，避免整份 state 进内存。
/// 无 theme 字段（升级前老数据）返回 null，由前端归一化为默认深色。
#[tauri::command]
fn get_theme(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let file = dir.join("state.json");
    if !file.exists() {
        return Ok(serde_json::Value::Null);
    }
    let state = read_json(&file)?;
    Ok(state.get("theme").cloned().unwrap_or(serde_json::Value::Null))
}

/// 主题变更广播：向所有窗口（main/lock/reminder）推送 theme://updated。
/// 接收方幂等应用，主窗口对回声自行去重（theme.js 比对 JSON）。
#[tauri::command]
fn broadcast_theme(app: tauri::AppHandle, theme: serde_json::Value) -> Result<(), String> {
    app.emit("theme://updated", theme).map_err(|e| e.to_string())
}

/// 背景图读取为 data URL（theme-backdrop 渲染用）。
/// 限制 ≤12MB 与常见位图格式，避免超大文件拖垮 WebView 内存。
#[tauri::command]
fn read_bg_data_url(path: String) -> Result<Option<String>, String> {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Ok(None);
    }
    let meta = fs::metadata(&p).map_err(|e| e.to_string())?;
    if meta.len() > 12 * 1024 * 1024 {
        return Err("背景图片过大（超过 12MB），请选择更小的图片".into());
    }
    let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
    let mime = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "gif" => "image/gif",
        _ => return Err("不支持的图片格式".into()),
    };
    let data = fs::read(&p).map_err(|e| e.to_string())?;
    use base64::engine::general_purpose::STANDARD;
    use base64::Engine;
    Ok(Some(format!("data:{};base64,{}", mime, STANDARD.encode(data))))
}

// ─── 壁纸内存优化（2026-09-16）───
// 旧链路：原图整读 → base64（×1.33）→ IPC 传给前端 → JS 常驻持有 → 解码为全尺寸位图。
// 一张 4K 图占用 ~50MB（16MB 字符串 + 33MB 位图），且主窗/锁屏/提醒窗各来一份。
// 新链路：prepare_wallpaper 预缩放到屏幕尺寸的 JPEG 副本（磁盘缓存，改图/失效即重建），
// 前端经 asset:// 协议直接引用副本 —— JS 零常驻字符串，位图仅屏幕尺寸（~8MB）。

/// 壁纸副本信息：asset_url 供 CSS 直接使用。
#[derive(Serialize)]
struct WallpaperPrepared {
    ok: bool,
    #[serde(rename = "assetUrl")]
    asset_url: String,
    #[serde(rename = "sourceMtime")]
    source_mtime: u64,
}

/// 壁纸缓存目录：app_data_dir/wallpaper_cache/。
fn wallpaper_cache_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("wallpaper_cache");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// 把源图预缩放为屏幕尺寸 JPEG 副本，返回 asset:// URL。
/// 缓存命中（源文件 mtime 未变）则跳过重编码，启动零开销。
#[tauri::command]
fn prepare_wallpaper(app: tauri::AppHandle, path: String) -> Result<WallpaperPrepared, String> {
    let src = PathBuf::from(&path);
    if !src.is_file() {
        return Err("背景图不存在".into());
    }
    let meta = fs::metadata(&src).map_err(|e| e.to_string())?;
    if meta.len() > 64 * 1024 * 1024 {
        return Err("背景图片过大（超过 64MB），请选择更小的图片".into());
    }
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let cache_dir = wallpaper_cache_dir(&app)?;
    let cached = cache_dir.join("bg.jpg");
    let stamp_file = cache_dir.join("bg.stamp");

    // 缓存命中：副本存在且记录的源 mtime 一致 → 直接复用
    if cached.is_file() && stamp_file.is_file() {
        if let Ok(stamp) = fs::read_to_string(&stamp_file) {
            if stamp.trim() == mtime.to_string() {
                return Ok(WallpaperPrepared {
                    ok: true,
                    asset_url: convert_file_src(&cached),
                    source_mtime: mtime,
                });
            }
        }
    }

    // 未命中：解码 → 等比缩放至「覆盖屏幕」的最小尺寸 → JPEG 保存
    let data = fs::read(&src).map_err(|e| e.to_string())?;
    let img = image::load_from_memory(&data).map_err(|e| format!("图片解码失败：{e}"))?;
    let (sw, sh) = (
        unsafe { GetSystemMetrics(SM_CXSCREEN).max(1) },
        unsafe { GetSystemMetrics(SM_CYSCREEN).max(1) },
    );
    let (iw, ih) = (img.width().max(1), img.height().max(1));
    // cover 语义：缩放系数取「恰好盖住屏幕」的较大者；源图小于屏幕则不放大（避免无效放大）
    let scale = ((sw as f32 / iw as f32).max(sh as f32 / ih as f32)).max(1.0);
    let tw = ((iw as f32 * scale) as u32).max(1);
    let th = ((ih as f32 * scale) as u32).max(1);
    let scaled = if (tw, th) != (iw, ih) { img.resize_exact(tw, th, image::imageops::FilterType::Triangle) } else { img };
    scaled
        .to_rgb8()
        .save_with_format(&cached, image::ImageFormat::Jpeg)
        .map_err(|e| format!("壁纸副本保存失败：{e}"))?;
    fs::write(&stamp_file, mtime.to_string()).map_err(|e| e.to_string())?;

    Ok(WallpaperPrepared { ok: true, asset_url: convert_file_src(&cached), source_mtime: mtime })
}

/// 本地文件路径 → asset 协议 URL（需 tauri.conf.json 开启 assetProtocol 并放行目录）。
fn convert_file_src(p: &std::path::Path) -> String {
    let s = p.to_string_lossy().replace('\\', "/");
    let mut enc = String::with_capacity(s.len() + 16);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => enc.push(b as char),
            b':' => enc.push(':'), // 盘符冒号保留（asset 协议路径格式 http://asset.localhost/<drive>/path）
            _ => enc.push_str(&format!("%{:02X}", b)),
        }
    }
    format!("http://asset.localhost/{}", enc.trim_start_matches('/'))
}

/// 备份所有数据文件到 zip。
#[tauri::command]
fn backup_data(app: tauri::AppHandle, zip_path: String) -> Result<(), String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let files = ["state.json", "music.json", "worklogs.json", "notes.json"];

    let zip_file = fs::File::create(&zip_path).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipWriter::new(zip_file);
    let options = zip::write::SimpleFileOptions::default();

    for name in &files {
        let path = dir.join(name);
        if path.exists() {
            let data = fs::read(&path).map_err(|e| e.to_string())?;
            zip.start_file(name, options).map_err(|e| e.to_string())?;
            zip.write_all(&data).map_err(|e| e.to_string())?;
        }
    }

    zip.finish().map_err(|e| e.to_string())?;
    Ok(())
}

/// 从 zip 恢复数据文件（覆盖现有数据）。
#[tauri::command]
fn restore_data(app: tauri::AppHandle, zip_path: String) -> Result<(), String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let zip_file = fs::File::open(&zip_path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(zip_file).map_err(|e| e.to_string())?;

    let allowed = ["state.json", "music.json", "worklogs.json", "notes.json"];

    for i in 0..archive.len() {
        let mut file = archive.by_index(i).map_err(|e| e.to_string())?;
        let name = file.name().to_string();
        if !allowed.contains(&name.as_str()) {
            continue;
        }
        let out_path = dir.join(&name);
        let mut out = fs::File::create(&out_path).map_err(|e| e.to_string())?;
        std::io::copy(&mut file, &mut out).map_err(|e| e.to_string())?;
    }

    Ok(())
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

/// 用默认程序打开任意目标：http(s) 链接 → 默认浏览器；本地路径 → 默认程序。
#[tauri::command]
fn open_path(target: String) -> Result<(), String> {
    let t = target.trim();
    if t.is_empty() {
        return Err("目标不能为空".to_string());
    }
    std::process::Command::new("cmd")
        .args(["/C", "start", "", t])
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 弹出系统文件夹选择对话框，返回所选目录路径（取消则返回 None）。
#[tauri::command]
fn pick_folder(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let picked = app
        .dialog()
        .file()
        .blocking_pick_folder()
        .map(|p| p.to_string());
    Ok(picked)
}

/// 弹出系统文件选择对话框，返回所选文件路径（取消则返回 None）。
#[tauri::command]
fn pick_file(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let picked = app
        .dialog()
        .file()
        .blocking_pick_file()
        .map(|p| p.to_string());
    Ok(picked)
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

/// 删除桌面文件到回收站（经 PowerShell VisualBasic API，保证进回收站可恢复）。
/// 具体逻辑与全盘版共用 recycle_path，避免两处实现漂移。
#[tauri::command]
fn delete_file(name: String) -> Result<(), String> {
    recycle_path(&desktop_dir()?.join(&name))
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

// -------------------- 全盘路径作用域的文件操作 --------------------
// 文件中心的**搜索结果**是全盘绝对路径（file_index::Hit.path），可能位于任意盘符。
// 上方 open_file / reveal_file / rename_file / delete_file 均为 desktop_dir 作用域
// （后端把入参当文件名 join 到桌面目录），作用于搜索结果会「找不到」或误改桌面上的同名文件，
// 因此搜索结果必须走这一组按绝对路径操作的命令。

/// 在资源管理器中定位任意路径。
#[tauri::command]
fn reveal_path(target: String) -> Result<(), String> {
    let p = target.trim();
    if p.is_empty() {
        return Err("目标不能为空".to_string());
    }
    std::process::Command::new("explorer.exe")
        .args(["/select,", p])
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 重命名任意路径：只改同一目录内的文件名。
/// 拒绝含路径分隔符的新名称——否则等同于把文件搬到别的目录，而 UI 只呈现为「重命名」。
#[tauri::command]
fn rename_path(target: String, new_name: String) -> Result<(), String> {
    let p = target.trim();
    let new_name = new_name.trim();
    if p.is_empty() {
        return Err("目标不能为空".to_string());
    }
    if new_name.is_empty() {
        return Err("新名称不能为空".to_string());
    }
    if new_name.contains('\\') || new_name.contains('/') || new_name == "." || new_name == ".." {
        return Err("新名称不能包含路径分隔符".to_string());
    }
    let from = PathBuf::from(p);
    if !from.exists() {
        return Err("原文件不存在".to_string());
    }
    let parent = from.parent().ok_or_else(|| "无法确定所在目录".to_string())?;
    let to = parent.join(new_name);
    if to.exists() {
        return Err("目标名称已存在".to_string());
    }
    fs::rename(&from, &to).map_err(|e| e.to_string())
}

/// 删除任意路径到回收站。
#[tauri::command]
fn delete_path(target: String) -> Result<(), String> {
    let p = target.trim();
    if p.is_empty() {
        return Err("目标不能为空".to_string());
    }
    recycle_path(&PathBuf::from(p))
}

/// 把指定路径移入回收站（PowerShell VisualBasic API，保证可恢复）。
/// 守则：拒绝盘符根目录（`parent()` 为空）——如 `C:\`，删除后果不可逆。
fn recycle_path(path: &std::path::Path) -> Result<(), String> {
    if !path.exists() {
        return Err("文件不存在".to_string());
    }
    if path.parent().is_none() {
        return Err("拒绝对磁盘根目录执行删除".to_string());
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

/// 读取桌面图片文件为缩略图 base64 data URL，供文件中心显示。
/// 位图统一解码后等比缩放到最长边 128px、编码 PNG —— 网格仅 ~40px，
/// 传原图（可达数 MB，base64 再膨胀 1/3）的传输与解码开销过大；
/// SVG 为矢量、任意尺寸渲染，原样返回。超过 10MB 的图片不读取，前端回退到图标。
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
    use base64::engine::general_purpose::STANDARD;
    use base64::Engine;
    // SVG 矢量图无需缩放，直接返回
    if ext == "svg" {
        return Ok(format!("data:image/svg+xml;base64,{}", STANDARD.encode(data)));
    }
    // 位图：解码 → 等比缩放（最长边 128px，小于此尺寸保持原样）→ PNG 编码
    let img = image::load_from_memory(&data).map_err(|e| format!("图片解码失败：{e}"))?;
    let thumb = img.thumbnail(128, 128);
    let mut buf = Vec::new();
    thumb
        .write_to(&mut std::io::Cursor::new(&mut buf), image::ImageFormat::Png)
        .map_err(|e| format!("缩略图编码失败：{e}"))?;
    Ok(format!("data:image/png;base64,{}", STANDARD.encode(buf)))
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
///
/// 契约说明（2026-09-12 修正）：本命令**无返回值**——建窗是异步的，命令无法用返回值
/// 报告成败。成败只能经事件回传：成功发 `lock-init`，彻底失败发 `lock-failed`。
/// 原实现首次建窗失败即静默放弃且只发 `lock-init`，而 `lock.js` 又按本命令的布尔返回值
/// 判断成功（返回值实为 `null`，`null !== false` 恒真）→ 隐私锁定会静默失效。
#[tauri::command]
fn show_lock(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        // WebView2 实例初始化、与销毁操作撞车等会让建窗偶发失败，退避重试后再判失败。
        // 注：此处 sleep 会占用一个 runtime worker，但仅在罕见失败路径触发，可接受。
        let mut win = None;
        for attempt in 0..3u32 {
            if attempt > 0 {
                std::thread::sleep(std::time::Duration::from_millis(200));
            }
            if let Some(w) = ensure_lock(&app) {
                win = Some(w);
                break;
            }
            log_diag("lock", &format!("锁屏窗口创建失败，准备第 {} 次重试", attempt + 1));
        }

        match win {
            Some(win) => {
                let _ = win.set_always_on_top(true);
                let _ = win.set_fullscreen(true);
                let _ = win.show();
                let _ = win.set_focus();
                // 锁屏晚于提醒出现时，把已在显示的提醒压回锁屏之下（同层 z-order）
                if let Some(rem) = app.get_webview_window("reminder") {
                    sink_reminder_below_lock(&rem);
                }
                let _ = app.emit("lock-init", ());
            }
            None => {
                log_diag("lock", "锁屏窗口创建失败：已重试 3 次，通知前端重置锁定状态");
                let _ = app.emit("lock-failed", ());
            }
        }
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
    // 单实例互斥（必须最先执行，在任何建窗之前）：
    // 「开机自启 + 用户手动双击」会拉起第二实例，主窗口直接嵌入 WorkerW，
    // 双实例会双重注入桌面互相干扰。命中已有实例 → 静默退出（无窗口闪烁）。
    // 互斥句柄随 main 作用域存活到进程退出，无需手动释放。
    let _instance_mutex = unsafe { CreateMutexW(None, false, w!("DeskOverlay.SingleInstance")) };
    if _instance_mutex.is_ok() && unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
        std::process::exit(0);
    }

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

            // 全盘文件名索引：后台线程建索引，快照秒恢复，供文件中心全盘搜索
            file_index::start_index(app.handle().clone());

            // 嵌入桌面 WorkerW（成为桌面本身），再显示。
            // 开机自启（--autostart）：登录瞬间桌面可能尚未就绪，延迟后再嵌入，
            // 避免嵌入失败——这是自启相对手动启动唯一的差异化路径；其余初始化照常。
            if autostart::launched_by_autostart() {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    std::thread::sleep(std::time::Duration::from_millis(1200));
                    if let Some(win) = handle.get_webview_window("main") {
                        if let Ok(hwnd) = win.hwnd() {
                            desktop_inject::embed_in_desktop(hwnd);
                        }
                        let _ = win.show();
                    }
                });
            } else if let Some(win) = app.get_webview_window("main") {
                if let Ok(hwnd) = win.hwnd() {
                    desktop_inject::embed_in_desktop(hwnd);
                }
                let _ = win.show();
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![quit_app, autostart::autostart_status, autostart::set_autostart, downloader::download_start, downloader::download_cancel, downloader::downloaded_list, downloader::downloaded_delete, downloader::local_track_assets, aliyundrive::ad_auth_bind, aliyundrive::ad_auth_status, aliyundrive::ad_unbind, aliyundrive::ad_drive_info, aliyundrive::ad_list, aliyundrive::ad_search, aliyundrive::ad_play_url, aliyundrive::ad_upload_start, aliyundrive::ad_upload_cancel, aliyundrive::ad_upload_list, aliyundrive::ad_track_meta, show_reminder, hide_reminder, reminder_ready, show_lyric, hide_lyric, lyric_ready, lyric_sync, lyric_set_locked, lyric_move, lyric_pos_commit, lyric_apply_cfg, lyric_commit_display, lyric_menu_toggle, lyric_menu_ready, read_text_file, export_text_file, run_wasm_backend, install_plugin_package, build_wasm_backend, http_get, http_get_bytes, http_post, fetch_favicon, load_state, save_state, backup_data, restore_data, get_theme, broadcast_theme, read_bg_data_url, prepare_wallpaper, list_desktop_files, image_thumbnail, open_file, open_path, pick_folder, pick_file, reveal_file, delete_file, rename_file, reveal_path, delete_path, rename_path, show_lock, hide_lock, file_index::index_status, file_index::search_files, file_index::rebuild_index, sys_bridge::start_system_sampling, sys_bridge::stop_system_sampling, sys_bridge::check_media_playing, sys_bridge::set_lock_monitor_enabled, sedentary::set_sedentary_config])
        .run(tauri::generate_context!())
        .expect("DeskOverlay 运行失败");
}
