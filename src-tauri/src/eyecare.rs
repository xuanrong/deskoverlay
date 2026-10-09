//! 全局护眼 —— 显卡 Gamma 查找表调节。
//!
//! 唯一对**整机所有输出**生效的路径是改写显卡 Gamma LUT —— 它位于「帧缓冲 → 显示器」
//! 之间，不经过任何窗口层级；CSS/覆盖窗方案对独占全屏、锁屏、UAC 一律无效。
//!
//! 官方限制（Microsoft Learn: SetDeviceGammaRamp）：
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

use std::fs;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};
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

/// 原始 ramp 快照：**真实启用护眼前**保存，关闭/恢复原色时精确还原。
///
/// * **持久化到磁盘**（`eyecare_baseline.json`）而非进程内 static —— 进程重启后
///   基准仍在，不会把已调暗态误存为基准。
/// * **只在真实用户启用时保存**（`prev.enabled=false → true`）；启动自动恢复
///   （`prev.enabled` 已为 true）直接复用磁盘基准。
/// * `None` = 磁盘上尚无基准（从未真实启用过护眼），此时还原不写任何 ramp。
static ORIGINAL_RAMP: Mutex<Option<Ramp>> = Mutex::new(None);

/// 基准文件名：与 state.json / music.json 并列放在 app_data_dir 下。
/// 独立成文件而非写进 state.json —— state.json 由前端整体覆盖写（save_state），
/// 独立文件由后端全权读写，互不干扰。
const BASELINE_FILE: &str = "eyecare_baseline.json";

/// 基准文件完整路径。
fn baseline_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|d| d.join(BASELINE_FILE))
}

/// 从 JSON Value 解码 ramp（纯函数，便于单测）。
/// 结构异常（非数组/长度不对/含非数字）一律返回 None —— 不信任磁盘脏数据。
fn decode_ramp_from_value(v: &serde_json::Value) -> Option<Ramp> {
    let arr = v.get("ramp")?.as_array()?;
    if arr.len() != 768 {
        return None;
    }
    let mut ramp = [0u16; 768];
    for (i, item) in arr.iter().enumerate() {
        ramp[i] = item.as_u64()? as u16;
    }
    Some(ramp)
}

/// 把 ramp 编码为 JSON Value（纯函数，便于单测）。
fn encode_ramp_to_value(ramp: &Ramp) -> serde_json::Value {
    let arr: Vec<u64> = ramp.iter().map(|&x| x as u64).collect();
    serde_json::json!({ "ramp": arr })
}

/// 启动时从磁盘加载基准到内存缓存。缺失/损坏一律视为 None，不阻塞启动。
fn load_baseline_from_disk(app: &AppHandle) {
    let path = match baseline_path(app) {
        Some(p) => p,
        None => return,
    };
    let Ok(data) = fs::read_to_string(&path) else {
        return;
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&data) else {
        return;
    };
    let Some(ramp) = decode_ramp_from_value(&v) else {
        return;
    };
    let mut guard = ORIGINAL_RAMP.lock().expect("original ramp lock");
    if guard.is_none() {
        *guard = Some(ramp);
    }
}

/// 惰性加载：首次需要基准时从磁盘读一次（幂等，内存已有则跳过）。
/// 由 `set_eyecare_config` / `restore_native_color` 调用，确保命令先于
/// 守护线程也拿得到持久化基准。
fn ensure_baseline_loaded(app: &AppHandle) {
    let already = ORIGINAL_RAMP.lock().expect("original ramp lock").is_some();
    if !already {
        load_baseline_from_disk(app);
    }
}

/// 把当前内存基准落盘（幂等：无基准时不写）。
fn persist_baseline(app: &AppHandle) {
    let Some(path) = baseline_path(app) else {
        return;
    };
    let guard = ORIGINAL_RAMP.lock().expect("original ramp lock");
    let Some(ref ramp) = *guard else {
        return;
    };
    let body = encode_ramp_to_value(ramp);
    if let Some(dir) = path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    if let Ok(s) = serde_json::to_string_pretty(&body) {
        let _ = fs::write(&path, s);
    }
}

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
/// 超限会被 SetDeviceGammaRamp **静默拒绝**（返回 TRUE 但不生效），故主动夹取。
///
/// 实现要点：
///   1. **先量化（& 0xFF00）再夹取** —— 若先夹后截，截断向下最多 255，
///      会把已贴边界的值挤出安全区间。
///   2. **夹取边界本身也要对齐到 8 位网格** —— 边界 `id ± 32768` 在 id 为奇数时
///      低字节非零，直接作为结果会违反「值须存于最高有效位」。故边界向内取整到 256 的倍数。
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
/// `to_switch` 恒为「**距下一个**切换点的倒计时」（≥ 0），而不是「距最近切换点的距离」——
/// 后者会让切换点两侧都落在过渡窗口内，同一段过渡被执行两次且方向相反。
///
/// `entering_night` 表示下一个切换点的方向（进入夜间 / 离开夜间），
/// 插值方向由它决定，而不是由「当前是否夜间」推断 —— 后者在切换点两侧会取反。
///
/// 跨午夜时段（如 22:00–07:00，from > to）与同日时段（如 13:00–14:00）都要正确 ——
/// 跨午夜不能简单比较大小。
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
/// 过渡逻辑：在**到达切换点之前**的 `transition_min` 分钟内做线性过渡。
///
/// 只在前侧过渡：后侧再过渡会让同一段过渡执行两遍且第二遍方向相反。
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
/// 关闭护眼时必须还原 `ORIGINAL_RAMP` 快照，而不是写这个恒等值，
/// 否则会抹掉用户既有的 ICC 校色配置。
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

/// 保存原始 ramp：读取当前屏幕 gamma 作为基准，写内存缓存并落盘。
///
/// 调用方必须保证**这是真实用户启用**（`prev.enabled=false → true`）——
/// 否则会把已被护眼调暗的 gamma 误存为基准。
fn save_original_ramp(app: &AppHandle) {
    let mut guard = ORIGINAL_RAMP.lock().expect("original ramp lock");
    if guard.is_some() {
        return; // 基准已存在（本次会话或磁盘上）：真实启用不覆盖已有基准
    }
    if let Some(cur) = get_device_ramp() {
        *guard = Some(cur);
    }
    drop(guard);
    persist_baseline(app);
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

/// 判定「本次是否为真实用户启用」（纯函数，便于单测）。
///
/// 只有**上一状态关闭、新状态开启**才算真实启用，此时才允许保存/刷新原始基准。
/// 启动自动恢复时 `prev_enabled` 已为 true（状态从磁盘读回），不会被误判。
#[inline]
pub fn is_real_user_enable(prev_enabled: bool, enabled: bool) -> bool {
    !prev_enabled && enabled
}

/// 前端写入护眼配置。
///
/// 参数名经 Tauri v2 自动转 camelCase 暴露给 JS：前端必须传 `brightness` / `contrast`
/// 等同名 camelCase 键；snake_case 会报 missing required key（sedentary 同坑）。
#[tauri::command]
pub fn set_eyecare_config(
    app: AppHandle,
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
    // 启动/首次调用时确保基准已从磁盘载入（幂等）
    ensure_baseline_loaded(&app);
    // 范围夹取：与 build_ramp 内部约束保持一致，避免 UI 传出越界值
    let prev = *state.lock().map_err(|e| e.to_string())?;
    // 是否「真实用户启用」：上一状态为关闭、新状态为开启。
    // 启动自动恢复时 prev.enabled 已为 true，不会判为真实启用 → 不保存基准。
    let real_user_enable = is_real_user_enable(prev.enabled, enabled);
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
        // 只在真实用户从关闭切到开启时保存基准；启动自动恢复复用已有基准，
        // 绝不把已被护眼调暗的 gamma 误存为「原始色彩」。
        if real_user_enable {
            save_original_ramp(&app);
        }
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
/// 不信任前端传入的字符串 —— 手改 state.json 也可能带脏值。
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
/// 语义是「本次护眼结束」：把 enabled 置 false 并还原原始 ramp；
/// 若此时基准尚未保存过，顺手持久化一次，确保下次进程重启后仍能还原。
#[tauri::command]
pub fn restore_native_color(app: AppHandle, state: State<EyeCareState>) -> Result<bool, String> {
    ensure_baseline_loaded(&app);
    {
        let mut c = state.lock().map_err(|e| e.to_string())?;
        c.enabled = false;
    }
    persist_baseline(&app);
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
/// 只能轮询：Windows 没有「gamma ramp 被外部修改」的通知机制，且多数显示事件会重置 ramp。
///
/// 2 秒间隔：单次 SetDeviceGammaRamp 在某些硬件上需 200ms，因此**只在
/// 目标值变化或检测到被覆盖时才写入**，稳态下每轮仅一次回读（廉价）。
pub fn start_eyecare_guardian(app: AppHandle, state: EyeCareState) {
    std::thread::spawn(move || {
        const POLL: Duration = Duration::from_secs(2);
        // 已成功写入的目标 ramp 缓存：与当前配置比对，避免重复写
        let mut last_written: Option<Ramp> = None;

        // 启动即载入持久化基准：守护线程可能是首个需要还原 ramp 的地方
        // （命令尚未到达时），先载入保证关闭态能还原到正确基准。
        ensure_baseline_loaded(&app);

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
                // 写入失败（驱动屏蔽 / HDR）：清缓存，下一轮继续尝试，并通知前端
                last_written = None;
                let _ = app.emit("eyecare-failed", ());
            }
        }
    });
}

// ────────────────────────── 单元测试 ──────────────────────────
// 时段曲线边界情况（跨午夜、过渡方向、切换点归属）固化为测试。
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

    /// 回归测试：过渡只在前侧应用一次，切换点后侧不再落入过渡窗口。
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

    /// 核心回归：只有「真实用户启用」才允许保存基准（启动自动恢复 prev=true 必须被排除）。
    #[test]
    fn only_real_user_enable_may_save_baseline() {
        // 真实启用：上一状态关闭 → 开启。允许保存。
        assert!(is_real_user_enable(false, true), "关闭→开启 应判为真实启用");
        // 启动自动恢复：上一状态已开启 → 再推开启。禁止保存（关键！）。
        assert!(!is_real_user_enable(true, true), "开启→开启（启动恢复）不应判为真实启用");
        // 关闭护眼：两种都禁止。
        assert!(!is_real_user_enable(false, false));
        assert!(!is_real_user_enable(true, false));
    }

    /// 基准 JSON 编解码往返一致：落盘后重读应还原出完全相同的 ramp。
    #[test]
    fn baseline_ramp_roundtrip() {
        let mut ramp = [0u16; 768];
        for (i, x) in ramp.iter_mut().enumerate() {
            // 用 build_ramp 的真实取值，避免全是 0 的假阳性
            *x = ((i as f64 / 255.0) * 65535.0).round() as u16 & 0xFF00;
        }
        let v = encode_ramp_to_value(&ramp);
        let decoded = decode_ramp_from_value(&v).expect("应能解码自身编码结果");
        assert_eq!(decoded, ramp, "往返后 ramp 必须完全一致");
    }

    /// 磁盘脏数据防护：长度不足 / 非数组 / 非数字都不能被当成基准。
    #[test]
    fn baseline_rejects_corrupt_data() {
        // 长度不足 768
        let short = serde_json::json!({ "ramp": [1u64, 2, 3] });
        assert!(decode_ramp_from_value(&short).is_none(), "长度不对应拒绝");
        // 缺 ramp 键
        let missing = serde_json::json!({});
        assert!(decode_ramp_from_value(&missing).is_none(), "缺键应拒绝");
        // ramp 不是数组
        let not_arr = serde_json::json!({ "ramp": "garbage" });
        assert!(decode_ramp_from_value(&not_arr).is_none(), "非数组应拒绝");
        // 含非数字元素
        let mut bad = serde_json::json!({ "ramp": vec![0u64; 768] });
        if let Some(a) = bad.get_mut("ramp").and_then(|r| r.as_array_mut()) {
            a[5] = serde_json::json!("x");
        }
        assert!(decode_ramp_from_value(&bad).is_none(), "含非数字应拒绝");
    }
}
