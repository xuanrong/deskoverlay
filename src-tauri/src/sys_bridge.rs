//! 系统数据 Provider 桥 —— 对齐文档 §5.5「Provider 模型」(移植自 Zebar)。
//!
//! 后端起线程周期采集（CPU + 内存 + 网络速率），经 Tauri 事件把
//! `{ "config_hash": "system", "output": {...} }` 推给前端；
//! 前端按 config_hash 路由并消费 output 字段（时钟块系统状态卡 / 面板）。
//!
//! 网络速率：sysinfo `Networks` 独立类型取累计收发字节，两次采样差值 / 间隔 = 速率(byte/s)。

use std::time::{Duration, Instant};
use std::sync::atomic::{AtomicBool, Ordering};
use sysinfo::{CpuRefreshKind, Disks, Networks, System};
use tauri::{AppHandle, Emitter};
use windows::Win32::System::SystemInformation::GetTickCount64;
use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
use windows::Win32::System::Power::SYSTEM_POWER_STATUS;
use windows::Win32::System::Power::GetSystemPowerStatus;
use windows::Win32::Media::Audio::{
    IAudioSessionEnumerator, IAudioSessionManager2, IMMDevice,
    IMMDeviceEnumerator, MMDeviceEnumerator, AudioSessionStateActive, eMultimedia, eRender,
};
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_MULTITHREADED};

/// 系统健康页是否处于打开状态。仅打开时才采集并 emit，空闲时停止，避免后台空转。
static SYSTEM_SAMPLING_ON: AtomicBool = AtomicBool::new(false);

/// 打开系统健康页时调用：开启采样。
#[tauri::command]
pub fn start_system_sampling() {
    SYSTEM_SAMPLING_ON.store(true, Ordering::Relaxed);
}

/// 离开系统健康页时调用：关闭采样，恢复正常空闲。
#[tauri::command]
pub fn stop_system_sampling() {
    SYSTEM_SAMPLING_ON.store(false, Ordering::Relaxed);
}

/// 读取真实电源状态，返回 (电池百分比, 电源标签)。
/// 电源标签：AC（插电）/ BATTERY（使用电池）/ CHARGING（充电中）。
/// 桌面台式机无电池时返回 (0, "AC")。
fn power_status() -> (u8, String) {
    let mut sps: SYSTEM_POWER_STATUS = unsafe { std::mem::zeroed() };
    let ok = unsafe { GetSystemPowerStatus(&mut sps) }.is_ok();
    if !ok {
        return (0, "AC".to_string());
    }
    // ACLineStatus：0=使用电池，1=插电，255=未知
    // BatteryFlag：8 位值为充电中（0x08），128=无电池，255=未知；LifePercent 255=未知
    let pct = if sps.BatteryLifePercent == 255 { 0 } else { sps.BatteryLifePercent };
    let power = if sps.ACLineStatus == 0 {
        if sps.BatteryFlag & 0x08 != 0 { "CHARGING".to_string() } else { "BATTERY".to_string() }
    } else {
        "AC".to_string()
    };
    (pct, power)
}

/// 启动系统指标 Provider 线程：动态指标（CPU/内存/网络/电源）每秒采集，
/// 静态信息（CPU 型号/OS/主机名/磁盘）每 5 秒更新一次，避免无谓的重复采集与序列化。
pub fn start_system_provider(app: AppHandle) {
    std::thread::spawn(move || {
        let mut sys = System::new();
        let mut networks = Networks::new();
        let mut disks = Disks::new();
        let mut prev_rx: u64 = 0;
        let mut prev_tx: u64 = 0;
        let mut prev_net_time = Instant::now();
        let mut was_sampling = false;
        // 静态信息缓存（每 5 秒刷新一次），与每秒的动态字段合并后推送
        let mut static_fields = serde_json::json!({
            "cpuName": "", "cpuCores": 0, "logicalCores": 0,
            "osName": "", "osVersion": "", "hostName": "", "uptime": 0, "disks": []
        });
        let mut sample_no: u32 = 0;
        loop {
            let sampling = SYSTEM_SAMPLING_ON.load(Ordering::Relaxed);
            if sampling {
                // 重新开启采样时重置网络速率基准，避免把离线时段的累计量算进瞬时速率
                if !was_sampling {
                    networks.refresh_list();
                    prev_rx = networks.iter().map(|(_, n)| n.received()).sum();
                    prev_tx = networks.iter().map(|(_, n)| n.transmitted()).sum();
                    prev_net_time = Instant::now();
                    was_sampling = true;
                }

                // —— 动态字段：每秒刷新 ——
                sys.refresh_cpu_specifics(CpuRefreshKind::everything());
                sys.refresh_memory();
                networks.refresh_list();
                let cpu: f32 = sys.global_cpu_usage();

                let total = sys.total_memory() as f32;
                let used = sys.used_memory() as f32;
                let ram_pct = if total > 0.0 { (used / total) * 100.0 } else { 0.0 };
                // 字节 → GB
                let ram_total_gb = total / 1024.0 / 1024.0 / 1024.0;
                let ram_used_gb = used / 1024.0 / 1024.0 / 1024.0;

                let (batt_pct, power) = power_status();

                // 网络速率（byte/s）：累计收发字节的两次采样差值 / 间隔
                let rx: u64 = networks.iter().map(|(_, n)| n.received()).sum();
                let tx: u64 = networks.iter().map(|(_, n)| n.transmitted()).sum();
                let now = Instant::now();
                let dt = now.duration_since(prev_net_time).as_secs_f64();
                let net_down = if prev_rx > 0 && dt > 0.0 { (rx.saturating_sub(prev_rx)) as f64 / dt } else { 0.0 };
                let net_up = if prev_tx > 0 && dt > 0.0 { (tx.saturating_sub(prev_tx)) as f64 / dt } else { 0.0 };
                prev_rx = rx;
                prev_tx = tx;
                prev_net_time = now;

                // —— 静态字段：每 5 秒刷新一次 ——
                if sample_no % 5 == 0 {
                    disks.refresh_list();
                    // 磁盘：名称 / 挂载点 / 总量 / 已用 / 使用率
                    let disks_arr: Vec<serde_json::Value> = disks
                        .iter()
                        .filter(|d| d.total_space() > 0)
                        .map(|d| {
                            let total = d.total_space();
                            let used = total.saturating_sub(d.available_space());
                            let pct = if total > 0 { (used as f64 / total as f64) * 100.0 } else { 0.0 };
                            let gb = 1024.0 * 1024.0 * 1024.0;
                            serde_json::json!({
                                "name": d.name().to_string_lossy(),
                                "mount": d.mount_point().to_string_lossy(),
                                "totalGb": total as f64 / gb,
                                "usedGb": used as f64 / gb,
                                "pct": pct
                            })
                        })
                        .collect();
                    static_fields = serde_json::json!({
                        "cpuName": sys.cpus().first().map(|c| c.brand().to_string()).unwrap_or_default(),
                        "cpuCores": sys.physical_core_count().unwrap_or(0) as u32,
                        "logicalCores": sys.cpus().len() as u32,
                        "osName": System::name().unwrap_or_default(),
                        "osVersion": System::long_os_version().unwrap_or_default(),
                        "hostName": System::host_name().unwrap_or_default(),
                        "uptime": System::uptime(),
                        "disks": disks_arr,
                    });
                }
                sample_no = sample_no.wrapping_add(1);

                // 合并动态 + 静态后推送
                let mut output = serde_json::json!({
                    "cpu": cpu,
                    "ram": ram_pct,
                    "ramUsedGb": ram_used_gb,
                    "ramTotalGb": ram_total_gb,
                    // 网络速率 byte/s；电池/电源来自真实读取
                    "netUp": net_up,
                    "netDown": net_down,
                    "battery": batt_pct,
                    "power": power,
                });
                if let serde_json::Value::Object(stat) = static_fields.clone() {
                    if let serde_json::Value::Object(o) = &mut output {
                        o.extend(stat);
                    }
                }

                let _ = app.emit("provider-emit", serde_json::json!({
                    "config_hash": "system",
                    "output": output,
                }));
            } else {
                was_sampling = false;
            }

            std::thread::sleep(Duration::from_secs(1));
        }
    });
}

/// 取当前距最后一次键鼠输入的空闲毫秒数（全局，跨所有应用）；失败返回 0。
fn last_input_idle_ms() -> u64 {
    let mut info = LASTINPUTINFO { cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32, dwTime: 0 };
    if !unsafe { GetLastInputInfo(&mut info) }.as_bool() {
        return 0;
    }
    let now32 = (unsafe { GetTickCount64() } & 0xFFFF_FFFF) as u32;
    now32.wrapping_sub(info.dwTime) as u64
}

/// 检测是否有音频会话正在播放（用于"看视频/听音乐不锁屏"）。
/// 遍历默认多媒体播放设备的音频会话，只要存在非"系统音"且状态为 Active 即视为播放。
fn is_audio_playing() -> bool {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let r = (|| -> windows::core::Result<bool> {
            let enumerator: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
            let device: IMMDevice = enumerator.GetDefaultAudioEndpoint(eRender, eMultimedia)?;
            let manager: IAudioSessionManager2 = device.Activate::<IAudioSessionManager2>(CLSCTX_ALL, None)?;
            let sessions: IAudioSessionEnumerator = manager.GetSessionEnumerator()?;
            let count = sessions.GetCount()?;
            for i in 0..count {
                let control = sessions.GetSession(i)?;
                // 注意：不能依赖 IAudioSessionControl2::IsSystemSoundsSession().is_ok() 去排除
                // “系统音”——windows-rs 对 S_FALSE（值 1，同样属于成功码，表示“非系统音”会话）
                // 也会返回 Ok，导致普通视频/音乐会话被当成系统音全部跳过，is_audio_playing
                // 恒为 false，看视频也会锁屏。因此只按会话是否 Active 判定即可
                // （系统提示音极短，在默认 3s 采样 + 每秒判定的频率下影响可忽略）。
                if control.GetState()? == AudioSessionStateActive {
                    return Ok(true);
                }
            }
            Ok(false)
        })();
        CoUninitialize();
        r.unwrap_or(false)
    }
}

/// 全局空闲监控：每秒把"距上次输入的毫秒数"与"是否有音频播放"推送给前端
/// （system-idle 事件）。供隐私锁屏使用——无论用户在哪应用操作都不算空闲，
/// 且播放视频/音乐时即使无输入也不触发锁定。
pub fn start_lock_idle_monitor(app: AppHandle) {
    std::thread::spawn(move || {
        // 空闲时长每秒都发（及时）；音频枚举开销较大，每 3 秒做一次并缓存结果
        let mut audio_playing = false;
        let mut tick = 0u32;
        loop {
            if tick % 3 == 0 {
                audio_playing = is_audio_playing();
            }
            tick = tick.wrapping_add(1);
            let _ = app.emit(
                "system-idle",
                serde_json::json!({
                    "idleMs": last_input_idle_ms(),
                    "audioPlaying": audio_playing,
                }),
            );
            std::thread::sleep(Duration::from_secs(1));
        }
    });
}
