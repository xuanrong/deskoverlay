//! 桌面注入与自愈 —— 把工作台窗口嵌入 Explorer 桌面 WorkerW，
//! 使其成为「桌面本身」：Win+D 回到工作台，任务栏自然浮于其上（z-order 高于 WorkerW）。
//!
//! 关键修正（对比早期失败版本，那次窗口矩形正确但不可见）：
//! - **不加 WS_EX_LAYERED**：WS_CHILD + WS_EX_LAYERED 在桌面子窗口层级合成不可靠，
//!   会导致窗口矩形正确但视觉不可见。改用 transparent:false + WebView 自绘不透明背景。
//! - 注入后 `ShowWindow(SW_SHOW)` + `UpdateWindow` 触发重绘（SetParent 后 WebView2 需刷新）。
//! - DefView 递归查找（孙级），确保隐藏原生图标层。
//!
//! 不实现点击穿透（用户已明确不需要）；窗口默认拦截点击，面板外点击由工作台处理。

use std::ffi::c_void;
use windows::Win32::Foundation::*;
use windows::Win32::Graphics::Gdi::{CreateRectRgn, SetWindowRgn};
use windows::Win32::UI::WindowsAndMessaging::*;
use windows_core::{w, BOOL, PCWSTR};

const FALSE: BOOL = BOOL(0);
const TRUE: BOOL = BOOL(1);

// 手动声明 DwmSetWindowAttribute（绕过 windows-rs 包装，避免参数类型问题导致 E_INVALIDARG）。
#[link(name = "dwmapi")]
extern "system" {
    fn DwmSetWindowAttribute(hwnd: *mut c_void, attribute: u32, pvattr: *const c_void, cbattr: u32) -> i32;
}

/// 设置窗口圆角偏好为直角：DWMWA_WINDOW_CORNER_PREFERENCE(33) = DWMWCP_DONOTROUND(1)。
/// 返回 0 表示成功（S_OK）；Win10 不支持时返回错误码（窗口本就直角，可忽略）。
fn set_rect_corners(hwnd: HWND) -> i32 {
    let pref: u32 = 1; // DWMWCP_DONOTROUND
    unsafe {
        DwmSetWindowAttribute(
            hwnd.0,
            33, // DWMWA_WINDOW_CORNER_PREFERENCE
            &pref as *const u32 as *const c_void,
            std::mem::size_of::<u32>() as u32,
        )
    }
}

fn null_name() -> PCWSTR {
    PCWSTR(std::ptr::null::<u16>())
}

/// 递归查找：以 `hwnd` 为根的子树中是否含 SHELLDLL_DefView。
/// DefView 是 WorkerW 的孙级（WorkerW → WorkerW → DefView），必须递归后代。
unsafe fn find_defview_recursive(hwnd: HWND) -> HWND {
    let mut buf = [0u16; 256];
    let len = GetClassNameW(hwnd, &mut buf);
    if len > 0 {
        let class = String::from_utf16_lossy(&buf[..len as usize]);
        if class == "SHELLDLL_DefView" {
            return hwnd;
        }
    }
    let null = null_name();
    let mut child = HWND::default();
    loop {
        child = match FindWindowExW(Some(hwnd), Some(child), null, null) {
            Ok(c) => c,
            Err(_) => HWND::default(),
        };
        if child.is_invalid() {
            break;
        }
        let found = find_defview_recursive(child);
        if !found.is_invalid() {
            return found;
        }
    }
    HWND::default()
}

/// 发送 0x052C 给 Progman 生成新 WorkerW，枚举找到「后代不含 DefView」的背景层 WorkerW。
pub fn get_desktop_target() -> HWND {
    unsafe {
        let progman = match FindWindowW(w!("Progman"), null_name()) {
            Ok(h) => h,
            Err(_) => return HWND::default(),
        };
        if progman.is_invalid() {
            return HWND::default();
        }
        let mut result: usize = 0;
        let _ = SendMessageTimeoutW(
            progman,
            0x052C,
            WPARAM(0),
            LPARAM(0),
            SEND_MESSAGE_TIMEOUT_FLAGS(0),
            1000,
            Some(&mut result as *mut usize),
        );
        let mut workerw = HWND::default();
        let _ = EnumWindows(
            Some(enum_desktop_proc),
            LPARAM((&mut workerw as *mut HWND) as isize),
        );
        eprintln!("[deskoverlay] 目标背景 WorkerW 句柄={:p}", workerw.0);
        workerw
    }
}

extern "system" fn enum_desktop_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
    unsafe {
        let mut buf = [0u16; 256];
        let len = GetClassNameW(hwnd, &mut buf);
        if len > 0 {
            let class = String::from_utf16_lossy(&buf[..len as usize]);
            if class == "WorkerW" {
                // 图标层 WorkerW：后代含 SHELLDLL_DefView。
                // 工作台挂到此层（DefView 之父），用 HWND_TOP 置于 DefView 之上盖住图标，
                // 且图标层可交互（不穿透），Win+D 回到此层。
                let def = find_defview_recursive(hwnd);
                if !def.is_invalid() {
                    let ptr = lparam.0 as *mut HWND;
                    *ptr = hwnd;
                    return FALSE;
                }
            }
        }
        TRUE
    }
}

/// 将工作台窗口嵌入桌面 WorkerW：WS_CHILD + WS_EX_TOOLWINDOW，覆盖虚拟屏，
/// 隐藏原生图标层，并启 Explorer 自愈看门狗。
pub fn embed_in_desktop(hwnd: HWND) {
    if hwnd.is_invalid() {
        return;
    }
    unsafe {
        let target = get_desktop_target();
        if target.is_invalid() {
            eprintln!("[deskoverlay] 未找到桌面 WorkerW 目标，放弃注入");
            return;
        }

        // 样式：去 WS_POPUP 与 WS_OVERLAPPEDWINDOW（顶层圆角来源），加 WS_CHILD
        let style = GetWindowLongPtrW(hwnd, GWL_STYLE);
        SetWindowLongPtrW(
            hwnd,
            GWL_STYLE,
            (style & !(WS_POPUP.0 as isize) & !(WS_OVERLAPPEDWINDOW.0 as isize))
                | WS_CHILD.0 as isize
                | WS_VISIBLE.0 as isize,
        );

        // 扩展样式：WS_EX_TOOLWINDOW（脱离任务栏/Alt-Tab）。
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex | WS_EX_TOOLWINDOW.0 as isize);

        // 虚拟屏尺寸（子窗口覆盖范围）
        let vw = GetSystemMetrics(SM_CXVIRTUALSCREEN);
        let vh = GetSystemMetrics(SM_CYVIRTUALSCREEN);

        // 关键：在 SetParent 之前（窗口还是顶层时）先设置直角圆角偏好 + 矩形形状。
        // DWM 合成层在窗口转为子窗口后可能缓存旧圆角，此时设置最可靠。
        let corner0 = set_rect_corners(hwnd);
        let mut rc0 = RECT::default();
        let _ = GetWindowRect(hwnd, &mut rc0);
        let rgn0 = CreateRectRgn(0, 0, rc0.right - rc0.left, rc0.bottom - rc0.top);
        SetWindowRgn(hwnd, Some(rgn0), true);
        let _ = SetWindowPos(
            hwnd,
            None,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED,
        );

        match SetParent(hwnd, Some(target)) {
            Ok(old) => eprintln!("[deskoverlay] SetParent 成功，旧父句柄={:p}", old.0),
            Err(e) => eprintln!("[deskoverlay] SetParent 失败：{e}"),
        }

        // 子窗口坐标相对父工作区；故意放大并偏移到屏幕外：
        // DWM 圆角若残留在窗口四角，则落在屏幕外，屏幕内四角即为直角。
        let _ = SetWindowPos(
            hwnd,
            Some(HWND_TOP),
            -2,
            -2,
            vw + 4,
            vh + 4,
            SWP_NOACTIVATE | SWP_SHOWWINDOW,
        );
        // 触发重绘（SetParent 后 WebView2 可能需要刷新才渲染）
        let _ = ShowWindow(hwnd, SW_SHOW);

        // 子窗口状态下再次设置直角 + 用窗口实际尺寸强制矩形区域。
        let corner1 = set_rect_corners(hwnd);
        let mut rc = RECT::default();
        let _ = GetWindowRect(hwnd, &mut rc);
        let rgn = CreateRectRgn(0, 0, rc.right - rc.left, rc.bottom - rc.top);
        let rgn_res = SetWindowRgn(hwnd, Some(rgn), true);
        let _ = SetWindowPos(
            hwnd,
            None,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED,
        );
        // 诊断：确认 WS_CHILD 生效 + SetWindowRgn 成功与否 + DWM 圆角偏好设置结果
        let st_after = GetWindowLongPtrW(hwnd, GWL_STYLE);
        eprintln!(
            "[deskoverlay] 直角诊断：corner0={} corner1={} Rgn={} WS_CHILD={}",
            corner0,
            corner1,
            rgn_res,
            (st_after & WS_CHILD.0 as isize) != 0
        );

        let mut rect = RECT::default();
        let _ = GetWindowRect(hwnd, &mut rect);
        eprintln!(
            "[deskoverlay] 已注入桌面 WorkerW（窗口矩形 L{}/T{}/R{}/B{}，{}x{}）",
            rect.left, rect.top, rect.right, rect.bottom,
            rect.right - rect.left, rect.bottom - rect.top
        );
    }
}

/// Explorer 崩溃/重启自愈：每 2s 检测父窗口是否仍为桌面目标，若被拆离则重新挂回。
/// 当前暂未启用（GetParent 误判导致循环），后续用 IsWindow + 类名校验重新实现。
#[allow(dead_code)]
pub fn start_explorer_watcher(hwnd: HWND, initial_target: HWND) {
    let hwnd_raw = hwnd.0 as isize;
    let target_raw = initial_target.0 as isize;
    std::thread::spawn(move || {
        let hwnd = HWND(hwnd_raw as *mut c_void);
        let mut last_target = HWND(target_raw as *mut c_void);
        loop {
            std::thread::sleep(std::time::Duration::from_secs(2));
            unsafe {
                if hwnd.is_invalid() {
                    break;
                }
                let current_parent = GetParent(hwnd).unwrap_or_default();
                if last_target.is_invalid() || current_parent != last_target {
                    let t = get_desktop_target();
                    if !t.is_invalid() {
                        let _ = SetParent(hwnd, Some(t));
                        let vw = GetSystemMetrics(SM_CXVIRTUALSCREEN);
                        let vh = GetSystemMetrics(SM_CYVIRTUALSCREEN);
                        let _ = SetWindowPos(hwnd, None, 0, 0, vw, vh, SWP_NOACTIVATE | SWP_SHOWWINDOW);
                        let _ = ShowWindow(hwnd, SW_SHOW);
                        last_target = t;
                        eprintln!("[deskoverlay] 自愈：重新嵌入桌面");
                    }
                }
            }
        }
    });
}
