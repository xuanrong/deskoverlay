//! 久坐提醒 —— 后端活动检测。
//!
//! 不同于前端「提醒设置」里按墙钟计时的每日/间隔提醒，久坐提醒需要感知用户
//! 是否真在电脑前：通过 Windows `GetLastInputInfo` 取得「距上次键鼠输入」的空闲
//! 时长，累计「连续使用」时间，达到设定间隔后复用系统级置顶提醒窗口弹出提示。
//!
//! 离开 ≥3 分钟视为一次休息，重置连续计时；继续连续使用到下一间隔再次提醒。

use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};
use windows::Win32::System::SystemInformation::GetTickCount64;
use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};

/// 久坐配置（由前端经 set_sedentary_config 写入）。
#[derive(Clone, Copy, Debug)]
pub struct SedentaryConfig {
    pub enabled: bool,
    pub interval_min: u32,
}

impl Default for SedentaryConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            interval_min: 45,
        }
    }
}

/// 共享状态：Arc<Mutex<...>> 由 app.manage 托管，监控线程与命令共享同一份。
pub type SedentaryState = Arc<Mutex<SedentaryConfig>>;

/// 构造共享状态（Arc<Mutex<>> 不能在此 crate 实现 Default，故提供构造器）。
pub fn new_sedentary_state() -> SedentaryState {
    Arc::new(Mutex::new(SedentaryConfig::default()))
}

/// 前端写入久坐配置：开关 + 连续使用间隔（分钟）。
/// 注意：前端侧参数名必须用 camelCase（intervalMin），Tauri v2 默认将 Rust 的
/// snake_case 参数转为 camelCase 暴露给 JS，传 interval_min 会报 missing required key。
#[tauri::command]
pub fn set_sedentary_config(state: State<SedentaryState>, enabled: bool, interval_min: u32) {
    let mut c = state.lock().expect("sedentary config lock");
    c.enabled = enabled;
    c.interval_min = interval_min.max(1);
}

/// 取当前「距上次键鼠输入」的空闲毫秒数；失败返回 None。
fn last_input_idle_ms() -> Option<u64> {
    let mut info = LASTINPUTINFO {
        cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
        dwTime: 0,
    };
    // SAFETY: 已按约定填好 cbSize，info 生命周期覆盖本次调用。
    // windows-rs 的 GetLastInputInfo 返回 BOOL（成功为 TRUE）。
    if !unsafe { GetLastInputInfo(&mut info) }.as_bool() {
        return None;
    }
    // 关键：dwTime 是 32 位 tick 计数，若直接与 64 位的 GetTickCount64 相减，
    // 会因为 2^32 回绕得到「差了若干个 49.7 天」的巨量空闲值，导致每秒都被判为
    // 离开、累计永远清零、久坐提醒永不触发（开机超过约 49.7 天必现）。
    // 正确做法：在 32 位回绕空间内用 wrapping_sub 计算 idle（idle 恒 < 49.7 天）。
    let now32 = (unsafe { GetTickCount64() } & 0xFFFF_FFFF) as u32;
    let idle = now32.wrapping_sub(info.dwTime);
    Some(idle as u64)
}

/// 拉伸/起身图标（线性 SVG，currentColor），用于提醒弹卡。
const STRETCH_ICON: &str = r#"<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="4.5" r="2"/><path d="M12 7.5v4"/><path d="M8.5 9.5 12 7.5l3.5 2"/><path d="M12 11.5 8.5 16"/><path d="M12 11.5 15.5 15"/></svg>"#;

/// 启动久坐监控线程（在 app setup 阶段调用一次）。
///
/// 每秒采样空闲时长：空闲 < 重置阈值则累加 1s（视为连续使用）；否则视为离开/休息，
/// 重置累计。累计达到间隔且开启时弹提醒并归零（继续连续使用会再次计时）。
pub fn start_sedentary_monitor(app: AppHandle, state: SedentaryState) {
    std::thread::spawn(move || {
        // 离开超过该阈值视为「休息」，重置连续计时（避免短暂停顿误判为中断）。
        const IDLE_RESET_MS: u64 = 180_000; // 3 分钟
        const POLL: Duration = Duration::from_secs(1);
        let mut active_ms: u64 = 0;
        loop {
            std::thread::sleep(POLL);
            let (enabled, interval_min) = {
                let c = state.lock().expect("sedentary config lock");
                (c.enabled, c.interval_min.max(1))
            };
            if !enabled {
                active_ms = 0;
                continue;
            }
            match last_input_idle_ms() {
                Some(idle) if idle < IDLE_RESET_MS => {
                    active_ms += POLL.as_millis() as u64;
                }
                _ => {
                    // 空闲过久（离开/锁屏）→ 视为休息，重置累计
                    active_ms = 0;
                }
            }
            let threshold = (interval_min as u64) * 60_000;
            if active_ms >= threshold {
                active_ms = 0;
                let _ = app.emit(
                    "sedentary-fire",
                    serde_json::json!({ "intervalMin": interval_min }),
                );
                let msg = format!(
                    "你已连续使用电脑约 {} 分钟，起身活动一下、远眺放松吧。",
                    interval_min
                );
                crate::present_reminder(&app, STRETCH_ICON, "久坐提醒", &msg);
            }
        }
    });
}
