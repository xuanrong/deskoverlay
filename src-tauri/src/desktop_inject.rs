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
use std::time::Duration;
use windows::Win32::Foundation::*;
use windows::Win32::UI::WindowsAndMessaging::*;
use windows_core::{w, BOOL, PCWSTR};

const FALSE: BOOL = BOOL(0);
const TRUE: BOOL = BOOL(1);

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

        // 样式：去 WS_POPUP、加 WS_CHILD
        let style = GetWindowLongPtrW(hwnd, GWL_STYLE);
        SetWindowLongPtrW(hwnd, GWL_STYLE, style & !(WS_POPUP.0 as isize) | WS_CHILD.0 as isize);

        // 扩展样式：WS_EX_TOOLWINDOW（脱离任务栏/Alt-Tab）。
        // ⚠️ 不加 WS_EX_LAYERED：WS_CHILD + LAYERED 在桌面层级合成不可靠 → 不可见。
        //    也不加 WS_EX_NOACTIVATE：工作台即桌面，点击激活无碍，且保证面板输入焦点正常。
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex | WS_EX_TOOLWINDOW.0 as isize);

        match SetParent(hwnd, Some(target)) {
            Ok(old) => eprintln!("[deskoverlay] SetParent 成功，旧父句柄={:p}", old.0),
            Err(e) => eprintln!("[deskoverlay] SetParent 失败：{e}"),
        }

        // 子窗口坐标相对父工作区 (0,0) + 虚拟屏宽高铺满；HWND_TOP 置于 DefView 之上盖住图标
        let vw = GetSystemMetrics(SM_CXVIRTUALSCREEN);
        let vh = GetSystemMetrics(SM_CYVIRTUALSCREEN);
        let _ = SetWindowPos(
            hwnd,
            Some(HWND_TOP),
            0,
            0,
            vw,
            vh,
            SWP_NOACTIVATE | SWP_SHOWWINDOW,
        );
        // 触发重绘（SetParent 后 WebView2 可能需要刷新才渲染）
        let _ = ShowWindow(hwnd, SW_SHOW);

        // 不隐藏 DefView：工作台以 HWND_TOP 置于 DefView 之上，直接盖住图标层。
        // hide_native_icons();
        // 暂不启用自愈看门狗：GetParent 与 SetParent 目标比较存在误判（疑似 GetParent
        // 对该 WS_CHILD 返回 Err 或重定向父），每 2s 误触发重新挂回 → 窗口反复重置无法
        // 稳定显示。Explorer 重启自愈后续以更可靠检测（IsWindow + 类名校验）重新实现。
        // start_explorer_watcher(hwnd, target);

        let mut rect = RECT::default();
        let _ = GetWindowRect(hwnd, &mut rect);
        eprintln!(
            "[deskoverlay] 已注入桌面 WorkerW（窗口矩形 L{}/T{}/R{}/B{}，{}x{}）",
            rect.left, rect.top, rect.right, rect.bottom,
            rect.right - rect.left, rect.bottom - rect.top
        );
    }
}

/// 隐藏 Explorer 桌面图标层（SHELLDLL_DefView）。当前未启用（改用 HWND_TOP 盖住）。
#[allow(dead_code)]
fn hide_native_icons() {
    unsafe {
        let mut def = HWND::default();
        let _ = EnumWindows(
            Some(find_defview_proc),
            LPARAM((&mut def as *mut HWND) as isize),
        );
        if !def.is_invalid() {
            let _ = ShowWindow(def, SW_HIDE);
            eprintln!("[deskoverlay] 已隐藏原生图标层（SHELLDLL_DefView）");
        } else {
            eprintln!("[deskoverlay] 未找到 SHELLDLL_DefView（图标可能已隐藏）");
        }
    }
}

#[allow(dead_code)]
extern "system" fn find_defview_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
    unsafe {
        let def = find_defview_recursive(hwnd);
        if !def.is_invalid() {
            let ptr = lparam.0 as *mut HWND;
            *ptr = def;
            return FALSE;
        }
        TRUE
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
            std::thread::sleep(Duration::from_secs(2));
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
