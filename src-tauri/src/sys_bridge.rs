//! 系统数据 Provider 桥 —— 对齐文档 §5.5「Provider 模型」(移植自 Zebar)。
//!
//! 后端起线程周期采集（CPU + 内存 + 网络速率），经 Tauri 事件把
//! `{ "config_hash": "system", "output": {...} }` 推给前端；
//! 前端按 config_hash 路由并消费 output 字段（时钟块系统状态卡 / 面板）。
//!
//! 网络速率：sysinfo `Networks` 独立类型取累计收发字节，两次采样差值 / 间隔 = 速率(byte/s)。

use std::time::{Duration, Instant};
use sysinfo::{CpuRefreshKind, Disks, Networks, System};
use tauri::{AppHandle, Emitter};

/// 启动系统指标 Provider 线程：每秒采集 CPU / 内存 / 网络速率 / 磁盘并 emit 事件。
pub fn start_system_provider(app: AppHandle) {
    std::thread::spawn(move || {
        let mut sys = System::new();
        let mut networks = Networks::new();
        let mut disks = Disks::new();
        let mut prev_rx: u64 = 0;
        let mut prev_tx: u64 = 0;
        let mut prev_net_time = Instant::now();
        loop {
            sys.refresh_cpu_specifics(CpuRefreshKind::everything());
            sys.refresh_memory();
            networks.refresh_list();
            disks.refresh_list();

            let cpu: f32 = sys.global_cpu_usage();

            let total = sys.total_memory() as f32;
            let used = sys.used_memory() as f32;
            let ram_pct = if total > 0.0 { (used / total) * 100.0 } else { 0.0 };
            // 字节 → GB
            let ram_total_gb = total / 1024.0 / 1024.0 / 1024.0;
            let ram_used_gb = used / 1024.0 / 1024.0 / 1024.0;

            // 系统信息：CPU 型号 / 物理核心数 / 运行时间（秒）
            let cpu_name = sys.cpus().first().map(|c| c.brand().to_string()).unwrap_or_default();
            let cpu_cores = sys.physical_core_count().unwrap_or(0) as u32;
            let uptime = System::uptime();

            // 网络速率（byte/s）：累计收发字节的两次采样差值 / 间隔
            let mut rx: u64 = 0;
            let mut tx: u64 = 0;
            for (_, net) in &networks {
                rx += net.received();
                tx += net.transmitted();
            }
            let now = Instant::now();
            let dt = now.duration_since(prev_net_time).as_secs_f64();
            let net_down = if prev_rx > 0 && dt > 0.0 { (rx.saturating_sub(prev_rx)) as f64 / dt } else { 0.0 };
            let net_up = if prev_tx > 0 && dt > 0.0 { (tx.saturating_sub(prev_tx)) as f64 / dt } else { 0.0 };
            prev_rx = rx;
            prev_tx = tx;
            prev_net_time = now;

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

            let _ = app.emit(
                "provider-emit",
                serde_json::json!({
                    "config_hash": "system",
                    "output": {
                        "cpu": cpu,
                        "ram": ram_pct,
                        "ramUsedGb": ram_used_gb,
                        "ramTotalGb": ram_total_gb,
                        // 网络速率 byte/s；电池占位（需 battery feature，后续扩展）
                        "netUp": net_up,
                        "netDown": net_down,
                        "battery": 0,
                        "power": "AC",
                        // 系统健康页：CPU 型号 / 物理核心数 / 开机时长（秒）/ 磁盘列表
                        "cpuName": cpu_name,
                        "cpuCores": cpu_cores,
                        "uptime": uptime,
                        "disks": disks_arr
                    }
                }),
            );

            std::thread::sleep(Duration::from_secs(1));
        }
    });
}
