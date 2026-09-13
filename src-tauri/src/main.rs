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
use windows::Win32::UI::WindowsAndMessaging::{
    GetSystemMetrics, SetWindowPos, SM_CXSCREEN, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
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
        *PENDING_REMINDER.lock().unwrap() = Some(payload);
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
        Some(p) => show_reminder_win(&win, p, true),
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
#[tauri::command]
fn fetch_favicon(url: String) -> Result<String, String> {
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

            // 嵌入桌面 WorkerW（成为桌面本身），再显示
            if let Some(win) = app.get_webview_window("main") {
                if let Ok(hwnd) = win.hwnd() {
                    desktop_inject::embed_in_desktop(hwnd);
                }
                let _ = win.show();
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![quit_app, show_reminder, hide_reminder, reminder_ready, read_text_file, export_text_file, run_wasm_backend, install_plugin_package, build_wasm_backend, http_get, http_post, fetch_favicon, load_state, save_state, backup_data, restore_data, list_desktop_files, image_thumbnail, open_file, open_path, pick_folder, pick_file, reveal_file, delete_file, rename_file, reveal_path, delete_path, rename_path, show_lock, hide_lock, file_index::index_status, file_index::search_files, file_index::rebuild_index, sys_bridge::start_system_sampling, sys_bridge::stop_system_sampling, sys_bridge::check_media_playing, sys_bridge::set_lock_monitor_enabled, sedentary::set_sedentary_config])
        .run(tauri::generate_context!())
        .expect("DeskOverlay 运行失败");
}
