//! 全局护眼 —— 显卡 Gamma 查找表调节。
//!
//! 为什么不是「盖一层滤镜」：桌面应用加 CSS/覆盖窗只能影响自己或视觉遮挡，
//! 独占全屏（游戏/全屏视频）、锁屏、UAC 一律盖不住，且全屏置顶窗会吞鼠标事件
//! （见 reminder.html 注释里踩过的坑）。真正对**整机所有输出**生效的唯一路径是
//! 改写显卡 Gamma LUT —— 它位于「帧缓冲 → 显示器」之间，不经过任何窗口层级。
//!
//! 官方限制（Microsoft Learn: SetDeviceGammaRamp）已逐条纳入设计：
//!   1. **静默失败**：ramp 若违反内部启发式会返回 TRUE 但不生效
//!      → 写后必须 GetDeviceGammaRamp 回读比对，不能信返回值。
//!   2. **偏差限制**：每项与恒等值偏差不得超过 32768（防屏幕变全黑无法恢复）
//!      → 生成后主动校验，超限自动回退安全值。
//!   3. **全局性**：任何应用随时可覆盖
//!      → 守护线程定期校验并夺回。
//!   4. **显示事件重置**：插拔显示器/改分辨率会重置 ramp
//!      → 守护线程重放。
//!   5. **HDR 下行为未定义**：HDR 开启时可能完全无效 → 由前端提示，此处不静默。
//!
//! 安全底线：启用前用 GetDeviceGammaRamp 保存原始 ramp，关闭时**精确还原那一份**
//! 而不是写恒等值 —— 用户机器上可能已装 ICC 校色配置，写恒等值会破坏它。

use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};
use windows::Win32::Graphics::Gdi::{GetDC, ReleaseDC, HDC};
use windows::Win32::UI::ColorSystem::{GetDeviceGammaRamp, SetDeviceGammaRamp};

/// Gamma ramp：R/G/B 各 256 项 WORD。
pub type Ramp = [u16; 768];

/// 护眼模式：固定色温 / 时段自动切换。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EyeMode {
    /// 固定：始终使用 `kelvin`
    Manual,
    /// 时段：在夜间时段内用 `night_kelvin`，时段外用 `day_kelvin`，
    /// 切换点前后 `transition_min` 分钟内线性插值过渡
    Schedule,
}

impl EyeMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            EyeMode::Manual => "manual",
            EyeMode::Schedule => "schedule",
        }
    }
    pub fn from_str(s: &str) -> Self {
        match s {
            "schedule" => EyeMode::Schedule,
            _ => EyeMode::Manual,
        }
    }
}

/// 护眼配置（由前端经 set_eyecare_config 写入）。
#[derive(Clone, Copy, Debug)]
pub struct EyeCareConfig {
    pub enabled: bool,
    /// 目标色温 K（2000–6500）—— Manual 模式使用
    pub kelvin: f64,
    /// 整体亮度系数（0.5–1.0）
    pub brightness: f64,
    /// 对比度收敛（0.8–1.0）
    pub contrast: f64,
    /// 模式
    pub mode: EyeMode,
    /// Schedule 模式：日间色温
    pub day_kelvin: f64,
    /// Schedule 模式：夜间色温
    pub night_kelvin: f64,
    /// Schedule 模式：夜间时段起（时, 分）
    pub from: (u8, u8),
    /// Schedule 模式：夜间时段止（时, 分）
    pub to: (u8, u8),
    /// Schedule 模式：切换点前后的过渡时长（分钟）
    pub transition_min: u32,
}

impl Default for EyeCareConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            kelvin: 4500.0,
            brightness: 0.9,
            contrast: 0.95,
            mode: EyeMode::Manual,
            day_kelvin: 5500.0,
            night_kelvin: 3400.0,
            from: (22, 0),
            to: (7, 0),
            transition_min: 30,
        }
    }
}

/// 共享状态：Arc<Mutex<...>> 由 app.manage 托管，守护线程与命令共享同一份。
pub type EyeCareState = Arc<Mutex<EyeCareConfig>>;

/// 构造共享状态（Arc<Mutex<>> 不能在此 crate 实现 Default，故提供构造器）。
pub fn new_eyecare_state() -> EyeCareState {
    Arc::new(Mutex::new(EyeCareConfig::default()))
}

/// 原始 ramp 快照：首次启用护眼前保存，关闭时精确还原。
/// None = 尚未保存（从未启用过护眼）。
static ORIGINAL_RAMP: Mutex<Option<Ramp>> = Mutex::new(None);

// ────────────────────────── 纯函数：色温 → Gamma ramp ──────────────────────────

/// 色温 K（1000–40000）→ 归一化 RGB 增益（0.0–1.0）。
///
/// 采用 Tanner Helland 的近似算法（f.lux / Redshift 同源思路）：
/// 以黑体辐射为参照，低色温偏暖（蓝通道衰减），高色温偏冷。
pub fn kelvin_to_rgb(kelvin: f64) -> (f64, f64, f64) {
    let t = kelvin.clamp(1000.0, 40000.0) / 100.0;
    // 红色通道：t<=66 时饱和在 255，之后随温度升高略降
    let r = if t <= 66.0 {
        255.0
    } else {
        (329.698_727_446 * (t - 60.0).powf(-0.133_204_759_2)).clamp(0.0, 255.0)
    };
    // 绿色通道：对数增长（低温段），幂衰减（高温段）
    let g = if t <= 66.0 {
        (99.470_802_586_1 * t.ln() - 161.119_568_166_1).clamp(0.0, 255.0)
    } else {
        (288.122_169_528_3 * (t - 60.0).powf(-0.075_514_849_2)).clamp(0.0, 255.0)
    };
    // 蓝色通道：t>=66 饱和在 255；t<=19 完全无蓝（极暖）
    let b = if t >= 66.0 {
        255.0
    } else if t <= 19.0 {
        0.0
    } else {
        (138.517_731_223_1 * (t - 10.0).ln() - 305.044_792_730_7).clamp(0.0, 255.0)
    };
    (r / 255.0, g / 255.0, b / 255.0)
}

/// 恒等 ramp 的第 i 项值（不做任何调节时的基准）。
#[inline]
fn identity_value(i: usize) -> u16 {
    ((i as f64 / 255.0) * 65535.0).round() as u16
}

/// 生成 256×3 项 gamma ramp。
///
/// 注意两点（都来自官方文档）：
///   * 值必须存放在每个 WORD 的**最高有效位** → 故最后 `& 0xFF00`。
///   * 每项与恒等值偏差不得超过 32768 → 由 `clamp_to_safe_deviation` 保证。
pub fn build_ramp(kelvin: f64, brightness: f64, contrast: f64) -> Ramp {
    let (kr, kg, kb) = kelvin_to_rgb(kelvin);
    let brightness = brightness.clamp(0.5, 1.0);
    let contrast = contrast.clamp(0.8, 1.0);
    let mut ramp = [0u16; 768];
    for ch in 0..3 {
        let gain = match ch {
            0 => kr,
            1 => kg,
            _ => kb,
        } * brightness;
        for i in 0..256usize {
            let x = i as f64 / 255.0;
            // 对比度收敛：以 0.5 为中心向中间压缩（不是简单地乘系数）
            let x = 0.5 + (x - 0.5) * contrast;
            let v = (x.clamp(0.0, 1.0) * gain * 65535.0).clamp(0.0, 65535.0);
            ramp[ch * 256 + i] = clamp_to_safe_deviation(i, v);
        }
    }
    ramp
}

/// 把值量化到 WORD 最高有效位，并夹到「与恒等值偏差 ≤ 32768」的安全区间内。
///
/// 这条硬限制来自 SetDeviceGammaRamp 的启发式校验：超限会被**静默拒绝**
/// （返回 TRUE 但不生效）。主动夹取可让「参数越界」表现为「色温略淡」，
/// 而不是「UI 显示已开启但屏幕毫无变化」这种最难排查的故障。
///
/// 实现要点（两处都是实测踩出来的）：
///   1. **先量化（& 0xFF00）再夹取**。若先夹后截，截断向下最多 255，
///      会把已贴边界的值推出安全区间 —— 实测在 i=255 处产生 33023 偏差。
///   2. **夹取边界本身也要对齐到 8 位网格**。边界 `id ± 32768` 在 id 为奇数时
///      低字节非零（如 32769），直接作为结果会违反「值须存于最高有效位」。
///      故边界向内取整到 256 的倍数，保证既满足偏差限制又是合法量化值。
#[inline]
fn clamp_to_safe_deviation(i: usize, v: f64) -> u16 {
    const MAX_DEV: i32 = 32768;
    // 1. 先量化到 WORD 高字节（低 8 位对 DAC 无效，必须清零）
    let quantized = ((v.clamp(0.0, 65535.0) as u16) & 0xFF00) as i32;
    // 2. 计算对齐后的安全边界（向内取整到 256 的倍数）
    let id = identity_value(i) as i32;
    let lo = ((id - MAX_DEV).max(0) + 255) & !255;
    let hi = ((id + MAX_DEV).min(65535)) & !255;
    // 3. 夹取（lo 可能因对齐超过 hi，此时取 hi —— 仍保证合法且尽量接近恒等值）
    quantized.clamp(lo.min(hi), hi) as u16
}

// ────────────────────────── 纯函数：时段曲线 ──────────────────────────

/// 把「时:分」转为当天分钟数（0–1439）。
#[inline]
pub fn minutes_of_day(h: u8, m: u8) -> i32 {
    (h.min(23) as i32) * 60 + (m.min(59) as i32)
}

/// 时段状态：`(是否夜间, 距下一个切换点还有多少分钟, 该切换点是否为"进入夜间")`。
///
/// 关键语义：`to_switch` 恒为「**距下一个**切换点的倒计时」（≥ 0），
/// 而不是「距最近切换点的距离」。这个区别决定了过渡只被应用一次 ——
/// 若用「距最近切换点」，切换点两侧都会落在过渡窗口内，
/// 同一段过渡会被执行两次且方向相反（实测：07:00 正确取 5500K，
/// 但 07:10 又退回 4800K，07:30 再跳回 5500K）。
///
/// `entering_night` 表示下一个切换点的方向（进入夜间 / 离开夜间），
/// 插值方向由它决定，而不是由「当前是否夜间」推断 —— 后者在切换点两侧会取反。
///
/// 跨午夜时段（如 22:00–07:00，from > to）与同日时段（如 13:00–14:00）都要正确 ——
/// 跨午夜不能简单比较大小，这是时段功能最常见的 bug 来源。
pub fn schedule_state(now_min: i32, from: i32, to: i32) -> (bool, i32, bool) {
    // 时段长度（跨午夜时用 1440 补齐）
    let span = if from <= to { to - from } else { to + 1440 - from };
    // 把 now 归一化到「以 from 为 0 点」的坐标系
    let rel = (now_min - from).rem_euclid(1440);
    let is_night = rel < span;

    if is_night {
        // 夜间内：下一个切换点是「离开夜间」，还有 span - rel 分钟
        (true, span - rel, false)
    } else {
        // 白天内：下一个切换点是「进入夜间」，还有 1440 - rel 分钟
        (false, 1440 - rel, true)
    }
}

/// 计算某时刻的目标色温（含过渡区间线性插值）。
///
/// 过渡逻辑：在**到达切换点之前**的 `transition_min` 分钟内做线性过渡，
/// 避免「到点突然变黄」的突兀感（f.lux 的 slow 档同思路）。
///
/// 只在前侧过渡（不在切换点后侧再过渡一次）：后者会让同一段过渡执行两遍，
/// 且第二遍方向相反 —— 表现为「到点正确变暖，过一会儿又弹回去再跳回来」。
pub fn target_kelvin_at(cfg: &EyeCareConfig, now_min: i32) -> f64 {
    if cfg.mode == EyeMode::Manual {
        return cfg.kelvin;
    }
    let from = minutes_of_day(cfg.from.0, cfg.from.1);
    let to = minutes_of_day(cfg.to.0, cfg.to.1);
    let (is_night, to_switch, entering_night) = schedule_state(now_min, from, to);
    let trans = cfg.transition_min.max(0) as i32;

    let (day, night) = (cfg.day_kelvin, cfg.night_kelvin);

    // 不在过渡窗口内：直接取当前状态的稳态值
    if trans == 0 || to_switch >= trans {
        return if is_night { night } else { day };
    }

    // 过渡窗口内：t=0 完全处于切换前状态，t=1 完全处于切换后状态
    let t = 1.0 - (to_switch as f64 / trans as f64);
    if entering_night {
        // 即将进入夜间：day 渐变到 night
        day + (night - day) * t
    } else {
        // 即将离开夜间：night 渐变到 day
        night + (day - night) * t
    }
}

// ────────────────────────── 恒等 ramp ──────────────────────────

/// 恒等 ramp（不做任何调节的基准）。
/// 保留为公开 API 而非删除：它是「写恒等值」这一**错误做法**的对照物 ——
/// 关闭护眼时必须还原 `ORIGINAL_RAMP` 快照，而不是写这个恒等值，
/// 否则会抹掉用户既有的 ICC 校色配置。留给后续 P1 的单元测试使用。
#[allow(dead_code)]
pub fn identity_ramp() -> Ramp {
    let mut r = [0u16; 768];
    for ch in 0..3 {
        for i in 0..256usize {
            r[ch * 256 + i] = identity_value(i) & 0xFF00;
        }
    }
    r
}

/// 判断两组 ramp 是否等价（容差 256，即 1 个 8 位色阶）。
///
/// 用容差而非严格相等：硬件 LUT 精度通常低于 WORD，回读值可能与写入值
/// 有微小差异，严格比对会误判为「被覆盖」并触发无谓的重写（每次 200ms）。
pub fn ramp_close(a: &Ramp, b: &Ramp) -> bool {
    a.iter().zip(b.iter()).all(|(x, y)| x.abs_diff(*y) <= 256)
}

// ────────────────────────── Win32 调用 ──────────────────────────

/// 取主显示器 DC 并执行闭包。DC 必须成对释放（ReleaseDC），故集中在此处管理。
fn with_primary_dc<T>(f: impl FnOnce(HDC) -> T) -> Option<T> {
    unsafe {
        let hdc = GetDC(None);
        if hdc.is_invalid() {
            return None;
        }
        let out = f(hdc);
        let _ = ReleaseDC(None, hdc);
        Some(out)
    }
}

/// 读当前主显示器 ramp。
pub fn get_device_ramp() -> Option<Ramp> {
    with_primary_dc(|hdc| {
        let mut ramp = [0u16; 768];
        let ok = unsafe {
            GetDeviceGammaRamp(hdc, ramp.as_mut_ptr() as *mut core::ffi::c_void)
        };
        if ok.as_bool() {
            Some(ramp)
        } else {
            None
        }
    })
    .flatten()
}

/// 写 ramp 到主显示器。返回**回读校验**结果而非 API 返回值 —— 官方明确
/// 「违反启发式会返回 TRUE 但不生效」，只有回读才能确认真实生效。
pub fn set_device_ramp(ramp: &Ramp) -> bool {
    let applied = with_primary_dc(|hdc| {
        let ok = unsafe {
            SetDeviceGammaRamp(hdc, ramp.as_ptr() as *const core::ffi::c_void)
        };
        ok.as_bool()
    })
    .unwrap_or(false);
    if !applied {
        return false;
    }
    // 回读校验：防止「静默失败」
    match get_device_ramp() {
        Some(cur) => ramp_close(&cur, ramp),
        None => false,
    }
}

/// 保存原始 ramp（只在首次启用护眼前调用一次）。
fn save_original_ramp() {
    let mut guard = ORIGINAL_RAMP.lock().expect("original ramp lock");
    if guard.is_some() {
        return; // 已保存：重复启用不应覆盖基准
    }
    if let Some(cur) = get_device_ramp() {
        *guard = Some(cur);
    }
}

/// 精确还原到启用护眼前的原始 ramp。
///
/// 刻意**不写恒等值**：用户机器上可能已有 ICC 校色配置或显卡驱动预设，
/// 写恒等值会抹掉它们，表现为「关掉护眼后屏幕颜色反而变奇怪了」。
pub fn restore_original_ramp() -> bool {
    let guard = ORIGINAL_RAMP.lock().expect("original ramp lock");
    match *guard {
        Some(ref orig) => set_device_ramp(orig),
        // 从未启用过：无需还原（也不该写入，避免破坏用户既有配置）
        None => true,
    }
}

// ────────────────────────── 命令 ──────────────────────────

/// 前端写入护眼配置。
///
/// 参数名经 Tauri v2 自动转 camelCase 暴露给 JS：前端必须传 `brightness` / `contrast`
/// 等同名 camelCase 键；snake_case 会报 missing required key（sedentary 同坑）。
#[tauri::command]
pub fn set_eyecare_config(
    state: State<EyeCareState>,
    enabled: bool,
    kelvin: f64,
    brightness: f64,
    contrast: f64,
    mode: Option<String>,
    day_kelvin: Option<f64>,
    night_kelvin: Option<f64>,
    from: Option<String>,
    to: Option<String>,
    transition_min: Option<u32>,
) -> Result<bool, String> {
    // 范围夹取：与 build_ramp 内部约束保持一致，避免 UI 传出越界值
    let prev = *state.lock().map_err(|e| e.to_string())?;
    let cfg = EyeCareConfig {
        enabled,
        kelvin: kelvin.clamp(2000.0, 6500.0),
        brightness: brightness.clamp(0.5, 1.0),
        contrast: contrast.clamp(0.8, 1.0),
        mode: mode.as_deref().map(EyeMode::from_str).unwrap_or(prev.mode),
        day_kelvin: day_kelvin.unwrap_or(prev.day_kelvin).clamp(2000.0, 6500.0),
        night_kelvin: night_kelvin.unwrap_or(prev.night_kelvin).clamp(2000.0, 6500.0),
        from: from.as_deref().map(parse_hhmm).unwrap_or(prev.from),
        to: to.as_deref().map(parse_hhmm).unwrap_or(prev.to),
        transition_min: transition_min.unwrap_or(prev.transition_min).min(180),
    };
    {
        let mut c = state.lock().map_err(|e| e.to_string())?;
        *c = cfg;
    }
    // 立即应用一次（不等守护线程的下一轮轮询，保证 UI 操作即时反馈）
    if cfg.enabled {
        save_original_ramp();
        let k = target_kelvin_at(&cfg, now_minutes());
        let ramp = build_ramp(k, cfg.brightness, cfg.contrast);
        if !set_device_ramp(&ramp) {
            return Err("Gamma 调节未生效（可能被显卡驱动屏蔽，或当前处于 HDR 模式）".into());
        }
    } else {
        restore_original_ramp();
    }
    Ok(cfg.enabled)
}

/// 解析 "HH:MM" → (时, 分)；非法值回落到 22:00（夜间默认起点）。
/// 不信任前端传入的字符串 —— 手改 state.json 或旧数据都可能带脏值。
fn parse_hhmm(s: &str) -> (u8, u8) {
    let parts: Vec<&str> = s.split(':').collect();
    if parts.len() != 2 {
        return (22, 0);
    }
    match (parts[0].trim().parse::<u8>(), parts[1].trim().parse::<u8>()) {
        (Ok(h), Ok(m)) if h < 24 && m < 60 => (h, m),
        _ => (22, 0),
    }
}

/// 当前本地时间的「当天分钟数」。
fn now_minutes() -> i32 {
    use std::time::{SystemTime, UNIX_EPOCH};
    // 用系统本地时间：直接读 UNIX 时间戳再按本地时区偏移换算。
    // 不用 chrono 等新依赖 —— 项目现有代码（pomodoro 前端）也是这个思路。
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let day_secs = secs.rem_euclid(86400);
    // 本地时区偏移（秒）：东八区 = 28800
    let offset = local_utc_offset_secs();
    let local = (day_secs + offset as i64).rem_euclid(86400);
    ((local / 60) % 1440) as i32
}

/// 取本地时区相对 UTC 的偏移秒数。
/// 用 GetTimeZoneInformation 读取，避免引入 chrono。
fn local_utc_offset_secs() -> i32 {
    use windows::Win32::System::Time::{GetTimeZoneInformation, TIME_ZONE_INFORMATION};
    unsafe {
        let mut tz = TIME_ZONE_INFORMATION::default();
        let ret = GetTimeZoneInformation(&mut tz);
        // TIME_ZONE_ID_INVALID = 0xFFFFFFFF；Bias 单位是分钟，且方向为「UTC = local + bias」
        if ret == windows::Win32::System::Time::TIME_ZONE_ID_INVALID {
            return 0;
        }
        let bias_min = tz.Bias + tz.DaylightBias;
        -bias_min * 60
    }
}

/// 立即恢复显示器原始色彩（用于修图/调色等需要准确色彩的场合）。
/// 只还原 ramp，**不改配置里的 enabled** —— 守护线程会在下一轮重新应用，
/// 故此处同步把 enabled 置 false，语义为「本次护眼结束」。
#[tauri::command]
pub fn restore_native_color(state: State<EyeCareState>) -> Result<bool, String> {
    {
        let mut c = state.lock().map_err(|e| e.to_string())?;
        c.enabled = false;
    }
    Ok(restore_original_ramp())
}

/// 查询当前状态：配置 + 是否真的生效（回读比对）。
/// 前端据此显示「已开启但未生效」这类真实状态，而不是只反映配置开关。
#[tauri::command]
pub fn eyecare_status(state: State<EyeCareState>) -> Result<serde_json::Value, String> {
    let cfg = *state.lock().map_err(|e| e.to_string())?;
    // 当前时刻的实际目标色温（Schedule 模式下随时段变化）
    let effective_kelvin = target_kelvin_at(&cfg, now_minutes());
    let active = if cfg.enabled {
        let want = build_ramp(effective_kelvin, cfg.brightness, cfg.contrast);
        match get_device_ramp() {
            Some(cur) => ramp_close(&cur, &want),
            None => false,
        }
    } else {
        false
    };
    Ok(serde_json::json!({
        "enabled": cfg.enabled,
        "kelvin": cfg.kelvin,
        "brightness": cfg.brightness,
        "contrast": cfg.contrast,
        "mode": cfg.mode.as_str(),
        "dayKelvin": cfg.day_kelvin,
        "nightKelvin": cfg.night_kelvin,
        "from": format!("{:02}:{:02}", cfg.from.0, cfg.from.1),
        "to": format!("{:02}:{:02}", cfg.to.0, cfg.to.1),
        "transitionMin": cfg.transition_min,
        // 当前生效色温：Schedule 模式下与 kelvin 不同，UI 应显示这个值
        "effectiveKelvin": effective_kelvin.round() as i64,
        "active": active,
    }))
}

// ────────────────────────── 守护线程 ──────────────────────────

/// 启动护眼守护线程（在 app setup 阶段调用一次）。
///
/// 为什么需要轮询而不是事件驱动：Windows 没有「gamma ramp 被外部修改」的通知机制，
/// 而官方明确「任何应用随时可覆盖」+「多数显示事件会重置 ramp」。轮询是
/// f.lux / LightBulb 等工具的通行做法。
///
/// 2 秒间隔的取舍：单次 SetDeviceGammaRamp 在某些硬件上需 200ms，因此**只在
/// 目标值变化或检测到被覆盖时才写入**，稳态下每轮仅一次回读（廉价）。
pub fn start_eyecare_guardian(app: AppHandle, state: EyeCareState) {
    std::thread::spawn(move || {
        const POLL: Duration = Duration::from_secs(2);
        // 已成功写入的目标 ramp 缓存：与当前配置比对，避免重复写
        let mut last_written: Option<Ramp> = None;

        loop {
            std::thread::sleep(POLL);
            let cfg = match state.lock() {
                Ok(c) => *c,
                Err(_) => continue, // 锁中毒：跳过本轮，不让线程死掉
            };

            if !cfg.enabled {
                // 关闭态：若我们之前写过东西，确保已还原；然后清缓存
                if last_written.is_some() {
                    restore_original_ramp();
                    last_written = None;
                }
                continue;
            }

            let want = build_ramp(
                target_kelvin_at(&cfg, now_minutes()),
                cfg.brightness,
                cfg.contrast,
            );

            // 目标未变 且 屏幕上的值仍是我们要的 → 无事可做
            let target_changed = match last_written {
                Some(ref prev) => !ramp_close(prev, &want),
                None => true,
            };
            if !target_changed {
                let still_ours = match get_device_ramp() {
                    Some(cur) => ramp_close(&cur, &want),
                    None => false,
                };
                if still_ours {
                    continue;
                }
                // 被外部应用覆盖（或显示事件重置）→ 夺回，并通知前端刷新状态
                let _ = app.emit("eyecare-overridden", ());
            }

            if set_device_ramp(&want) {
                last_written = Some(want);
            } else {
                // 写入失败（驱动屏蔽 / HDR）：清缓存，下一轮继续尝试；
                // 同时通知前端，让 UI 能显示真实状态而非假装成功
                last_written = None;
                let _ = app.emit("eyecare-failed", ());
            }
        }
    });
}

// ────────────────────────── 单元测试 ──────────────────────────
// 时段曲线的边界情况（跨午夜、过渡方向、切换点归属）单靠人工验证极易漏，
// 这里固化成测试，防止后续改动让算法悄悄漂移。
#[cfg(test)]
mod tests {
    use super::*;

    fn sched_cfg() -> EyeCareConfig {
        EyeCareConfig {
            mode: EyeMode::Schedule,
            day_kelvin: 5500.0,
            night_kelvin: 3400.0,
            from: (22, 0),
            to: (7, 0),
            transition_min: 30,
            ..Default::default()
        }
    }

    fn at(h: u8, m: u8) -> i32 {
        minutes_of_day(h, m)
    }

    #[test]
    fn cross_midnight_night_detection() {
        let cfg = sched_cfg();
        let from = minutes_of_day(cfg.from.0, cfg.from.1);
        let to = minutes_of_day(cfg.to.0, cfg.to.1);
        // 夜间：22:00–07:00 覆盖午夜
        for (h, m) in [(23, 0), (0, 30), (3, 0), (6, 30)] {
            let (is_night, _, _) = schedule_state(at(h, m), from, to);
            assert!(is_night, "{h:02}:{m:02} 应为夜间");
        }
        // 白天
        for (h, m) in [(8, 0), (12, 0), (21, 0)] {
            let (is_night, _, _) = schedule_state(at(h, m), from, to);
            assert!(!is_night, "{h:02}:{m:02} 应为白天");
        }
    }

    #[test]
    fn same_day_window() {
        // 同日时段 13:00–14:00（from < to，不跨午夜）
        let from = minutes_of_day(13, 0);
        let to = minutes_of_day(14, 0);
        assert!(schedule_state(at(13, 30), from, to).0);
        assert!(!schedule_state(at(12, 59), from, to).0);
        assert!(!schedule_state(at(14, 1), from, to).0);
        assert!(!schedule_state(at(0, 0), from, to).0);
    }

    #[test]
    fn steady_state_kelvin() {
        let cfg = sched_cfg();
        assert!((target_kelvin_at(&cfg, at(14, 0)) - 5500.0).abs() < 1.0);
        assert!((target_kelvin_at(&cfg, at(23, 0)) - 3400.0).abs() < 1.0);
        assert!((target_kelvin_at(&cfg, at(3, 0)) - 3400.0).abs() < 1.0);
    }

    #[test]
    fn transition_into_night_is_monotonic() {
        let cfg = sched_cfg();
        let t30 = target_kelvin_at(&cfg, at(21, 30)); // 过渡起点
        let t45 = target_kelvin_at(&cfg, at(21, 45)); // 过渡中点
        let t00 = target_kelvin_at(&cfg, at(22, 0)); // 过渡终点
        assert!((t30 - 5500.0).abs() < 5.0, "起点应接近 dayKelvin，实为 {t30}");
        assert!((t45 - 4450.0).abs() < 5.0, "中点应约在日夜间中值，实为 {t45}");
        assert!((t00 - 3400.0).abs() < 5.0, "终点应等于 nightKelvin，实为 {t00}");
        assert!(t30 > t45 && t45 > t00, "应单调递减（渐暖）");
    }

    #[test]
    fn transition_out_of_night_is_monotonic() {
        let cfg = sched_cfg();
        let t30 = target_kelvin_at(&cfg, at(6, 30));
        let t45 = target_kelvin_at(&cfg, at(6, 45));
        let t00 = target_kelvin_at(&cfg, at(7, 0));
        assert!((t30 - 3400.0).abs() < 5.0, "起点应等于 nightKelvin，实为 {t30}");
        assert!(t30 < t45 && t45 < t00, "应单调递增（渐冷）");
        assert!((t00 - 5500.0).abs() < 5.0, "终点应接近 dayKelvin，实为 {t00}");
    }

    /// 回归测试：过渡只在前侧应用一次。
    /// 曾经用「距最近切换点」的语义，导致切换点后侧再次落入过渡窗口，
    /// 表现为 07:00 正确 5500K，但 07:10 退回 4800K、07:30 又跳回 5500K。
    #[test]
    fn transition_not_applied_twice_after_switch() {
        let cfg = sched_cfg();
        for (h, m) in [(7, 10), (7, 20), (7, 30), (8, 0)] {
            let k = target_kelvin_at(&cfg, at(h, m));
            assert!(
                (k - 5500.0).abs() < 1.0,
                "离开夜间后应稳定在 dayKelvin，但 {h:02}:{m:02} 得到 {k}"
            );
        }
    }

    #[test]
    fn zero_transition_has_no_ramp() {
        let mut cfg = sched_cfg();
        cfg.transition_min = 0;
        assert!((target_kelvin_at(&cfg, at(23, 0)) - 3400.0).abs() < 0.01);
        assert!((target_kelvin_at(&cfg, at(12, 0)) - 5500.0).abs() < 0.01);
        // 21:59 仍是白天稳态值（无过渡区）
        assert!((target_kelvin_at(&cfg, at(21, 59)) - 5500.0).abs() < 0.01);
    }

    #[test]
    fn manual_mode_ignores_schedule() {
        let mut cfg = sched_cfg();
        cfg.mode = EyeMode::Manual;
        cfg.kelvin = 5000.0;
        assert!((target_kelvin_at(&cfg, at(3, 0)) - 5000.0).abs() < 0.01);
        assert!((target_kelvin_at(&cfg, at(14, 0)) - 5000.0).abs() < 0.01);
    }

    /// 全天扫描：验证无突变。过渡 30 分钟跨 2100K，每 10 分钟理论变化 700K。
    #[test]
    fn no_discontinuity_over_full_day() {
        let cfg = sched_cfg();
        let mut prev = target_kelvin_at(&cfg, 0);
        let mut max_jump = 0.0f64;
        let mut m = 10;
        while m < 1440 {
            let cur = target_kelvin_at(&cfg, m);
            max_jump = max_jump.max((cur - prev).abs());
            prev = cur;
            m += 10;
        }
        assert!(max_jump < 800.0, "存在突变：最大单步跳变 {max_jump}K");
    }

    #[test]
    fn hhmm_parsing_falls_back_on_garbage() {
        assert_eq!(parse_hhmm("22:30"), (22, 30));
        assert_eq!(parse_hhmm("07:00"), (7, 0));
        // 非法值回落默认夜间起点，不 panic
        assert_eq!(parse_hhmm(""), (22, 0));
        assert_eq!(parse_hhmm("abc"), (22, 0));
        assert_eq!(parse_hhmm("25:00"), (22, 0));
        assert_eq!(parse_hhmm("12:99"), (22, 0));
    }
}
