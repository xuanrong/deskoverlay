//! 桌面注入与自愈 —— 把工作台窗口嵌入 Explorer 桌面 WorkerW，
//! 使其成为「桌面本身」：Win+D 回到工作台，任务栏自然浮于其上（z-order 高于 WorkerW）。
//!
//! 关键约束：
//! - **不加 WS_EX_LAYERED**：WS_CHILD + WS_EX_LAYERED 在桌面子窗口层级合成不可靠，
//!   会导致窗口矩形正确但视觉不可见。用 transparent:false + WebView 自绘不透明背景。
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
        let _ = set_rect_corners(hwnd);
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

        let _ = SetParent(hwnd, Some(target));

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
        let _ = set_rect_corners(hwnd);
        let mut rc = RECT::default();
        let _ = GetWindowRect(hwnd, &mut rc);
        let rgn = CreateRectRgn(0, 0, rc.right - rc.left, rc.bottom - rc.top);
        let _ = SetWindowRgn(hwnd, Some(rgn), true);
        let _ = SetWindowPos(
            hwnd,
            None,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED,
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
                    }
                }
            }
        }
    });
}

/// 原生任务栏在当前显示器底部遮住了多少**逻辑像素**。
///
/// 为什么需要：工作台窗口被注入桌面后撑满**整块虚拟屏**（SM_CYVIRTUALSCREEN），
/// 而 Windows 任务栏的 z-order 高于 WorkerW，会盖住窗口最底下一条。
/// 前端若把内容按 100vh 铺到底，底部任务栏/最后一行卡片就被原生任务栏压住。
///
/// 实现：工作区（work area）就是「屏幕减去任务栏等 AppBar」的可用矩形，
/// 虚拟屏高度减工作区高度即为遮挡量。任务栏在顶部/左侧时同样成立
/// （对应返回 top/left 值，前端按需留边）。
///
/// 单位换算：GetSystemMetrics 返回**物理像素**，前端 CSS 用逻辑像素，
/// 故按主显示器 scale_factor 折算。多显示器混合 DPI 时以主屏为准 ——
/// 桌面窗口本就以虚拟屏为坐标系，取主屏比例是这里唯一可解释的近似。
#[derive(serde::Serialize)]
pub struct TaskbarInset {
    /// 底部被遮挡的逻辑像素（任务栏在下方时的常见值）
    pub bottom: f64,
    /// 顶部被遮挡的逻辑像素（任务栏置于顶部时）
    pub top: f64,
    /// 左侧被遮挡的逻辑像素（任务栏竖排在左侧时）
    pub left: f64,
    /// 右侧被遮挡的逻辑像素（任务栏竖排在右侧时）
    pub right: f64,
    /// 折算用的缩放比例，便于前端排查
    pub scale: f64,
}

/// 计算原生任务栏遮挡量（逻辑像素）。取不到时各项返回 0（即不额外留边）。
pub fn taskbar_inset(scale: f64) -> TaskbarInset {
    let s = if scale > 0.0 { scale } else { 1.0 };
    unsafe {
        let vx = GetSystemMetrics(SM_XVIRTUALSCREEN);
        let vy = GetSystemMetrics(SM_YVIRTUALSCREEN);
        let vw = GetSystemMetrics(SM_CXVIRTUALSCREEN);
        let vh = GetSystemMetrics(SM_CYVIRTUALSCREEN);

        let mut wa = RECT::default();
        // SPI_GETWORKAREA 返回主显示器工作区（物理像素）
        if SystemParametersInfoW(
            SPI_GETWORKAREA,
            0,
            Some(&mut wa as *mut RECT as *mut c_void),
            SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
        )
        .is_err()
        {
            return TaskbarInset { bottom: 0.0, top: 0.0, left: 0.0, right: 0.0, scale: s };
        }

        // 虚拟屏与工作区的差集：负值钳到 0
        // （工作区可能因多屏而「大于」单屏虚拟矩形，此时该方向无需留边）
        //
        // 注：embed_in_desktop 把窗口放在 (-2,-2)、尺寸 (vw+4, vh+4)，
        // 视口确实比虚拟屏每边大 2px。但那是**故意的**溢出（让 DWM 圆角落到屏幕外），
        // 属于窗口自身几何，不是「被任务栏遮挡」的部分 —— 不该折算进安全区，
        // 否则四个方向都会凭空多出 2px 内缩，UI 反而变小、和屏幕边留缝。
        let bottom = (vy + vh - wa.bottom).max(0) as f64 / s;
        let top = (wa.top - vy).max(0) as f64 / s;
        let left = (wa.left - vx).max(0) as f64 / s;
        let right = (vx + vw - wa.right).max(0) as f64 / s;

        TaskbarInset { bottom, top, left, right, scale: s }
    }
}

#[cfg(test)]
mod tests {
    /// 把遮挡量公式抽出来做纯函数，便于脱离 Win32 验证几何关系。
    /// 与 `taskbar_inset` 的实现保持逐字一致（只是把 GetSystemMetrics 的取值变成入参）。
    fn inset_from_metrics(
        vx: i32, vy: i32, vw: i32, vh: i32,
        wa: (i32, i32, i32, i32),
        scale: f64,
    ) -> (f64, f64, f64, f64) {
        let s = if scale > 0.0 { scale } else { 1.0 };
        let (wl, wt, wr, wb) = wa;
        (
            (vy + vh - wb).max(0) as f64 / s,
            (wt - vy).max(0) as f64 / s,
            (wl - vx).max(0) as f64 / s,
            (vx + vw - wr).max(0) as f64 / s,
        )
    }

    #[test]
    fn taskbar_at_bottom_leaves_bottom_inset() {
        // 1440x900 虚拟屏 + 870 高工作区（Win11 任务栏 30px），100% 缩放
        let (bottom, top, left, right) =
            inset_from_metrics(0, 0, 1440, 900, (0, 0, 1440, 870), 1.0);
        assert_eq!(bottom, 30.0, "任务栏占 30px");
        assert_eq!(top, 0.0);
        assert_eq!(left, 0.0);
        assert_eq!(right, 0.0);
    }

    #[test]
    fn taskbar_at_top_leaves_top_inset() {
        let (bottom, top, _, _) =
            inset_from_metrics(0, 0, 1920, 1080, (0, 48, 1920, 1080), 1.0);
        assert_eq!(top, 48.0, "顶部任务栏 48px");
        assert_eq!(bottom, 0.0);
    }

    #[test]
    fn hi_dpi_scales_to_logical_pixels() {
        // 125% 缩放：物理 32 → 逻辑 25.6
        let (bottom, _, _, _) =
            inset_from_metrics(0, 0, 2560, 1600, (0, 0, 2560, 1568), 1.25);
        assert!((bottom - 25.6).abs() < 0.01, "got {bottom}");
    }

    #[test]
    fn no_inset_when_work_area_equals_virtual_screen() {
        // 自动隐藏任务栏 / 全屏应用：工作区 == 虚拟屏 → 不额外留边
        let (bottom, top, left, right) =
            inset_from_metrics(0, 0, 1920, 1080, (0, 0, 1920, 1080), 1.0);
        assert_eq!(bottom, 0.0);
        assert_eq!(top, 0.0);
        assert_eq!(left, 0.0);
        assert_eq!(right, 0.0);
    }

    #[test]
    fn never_negative_when_work_area_exceeds_virtual() {
        // 多显示器：工作区矩形可能超出单屏虚拟矩形 → 钳到 0，不留负边距
        let (bottom, top, left, right) =
            inset_from_metrics(0, 0, 1920, 1080, (-100, -100, 2020, 1180), 1.0);
        assert_eq!(bottom, 0.0);
        assert_eq!(top, 0.0);
        assert_eq!(left, 0.0);
        assert_eq!(right, 0.0);
    }
}

