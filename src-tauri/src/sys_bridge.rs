//! 系统数据 Provider 桥 —— 对齐文档 §5.5「Provider 模型」(移植自 Zebar)。
//!
//! 后端起线程周期采集（此处为 CPU + 内存），经 Tauri 事件把
//! `{ "config_hash": "system", "output": {...} }` 推给前端；
//! 前端 `panels.js` 的 renderSystem 按 config_hash 路由并消费 output 字段。
//! 字段形态必须与前端模拟 Provider（providers.js 的 startSystem）保持一致，
//! 否则真实数据无法驱动系统面板。
//!
//! 该模型可无侵入扩展：新增 RAM/网络/电池/日历等 Provider，只需加采集线程与前端渲染。

use std::time::Duration;
use sysinfo::{CpuRefreshKind, System};
use tauri::{AppHandle, Emitter};

/// 启动系统指标 Provider 线程：每秒采集全局 CPU 占用与内存占用并 emit 事件。
pub fn start_system_provider(app: AppHandle) {
    std::thread::spawn(move || {
        let mut sys = System::new();
        loop {
            sys.refresh_cpu_specifics(CpuRefreshKind::everything());
            sys.refresh_memory();

            let cpu: f32 = sys.global_cpu_usage();

            let total = sys.total_memory() as f32;
            let used = sys.used_memory() as f32;
            let ram_pct = if total > 0.0 { (used / total) * 100.0 } else { 0.0 };
            // 字节 → GB
            let ram_total_gb = total / 1024.0 / 1024.0 / 1024.0;
            let ram_used_gb = used / 1024.0 / 1024.0 / 1024.0;

            let _ = app.emit(
                "provider-emit",
                serde_json::json!({
                    "config_hash": "system",
                    "output": {
                        "cpu": cpu,
                        "ram": ram_pct,
                        "ramUsedGb": ram_used_gb,
                        "ramTotalGb": ram_total_gb,
                        // 网络速率/电池需额外数据源(sysinfo 网络历史、battery feature)，
                        // 此处以占位值填充，后续按需扩展；CPU/RAM 为真实采集。
                        "netUp": 0.0,
                        "netDown": 0.0,
                        "battery": 0,
                        "power": "AC"
                    }
                }),
            );

            std::thread::sleep(Duration::from_secs(1));
        }
    });
}
