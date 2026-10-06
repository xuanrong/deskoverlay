//! AI 资讯模块 · 签到登录态收集器
//!
//! 只读本地客户端登录态文件，返回原始文本给前端解密（token 不进 Rust 内存以外的地方）。
//! - WorkBuddy = 腾讯 CodeBuddy：读 %LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\*.info
//! - Trae（只认 Trae CN）：读 %APPDATA%\Trae CN\User\globalStorage\storage.json
//!   + ahanet/tt_net_config.config + logs/*/main.log（设备 ID 候选）
//!
//! 解密（AES-GCM / AES-CBC）与调官方接口都在前端 JS（WebCrypto + http_post）完成，
//! 本命令仅解决「JS 在 WebView2 里读不到环境变量、列不了目录」这一步。

use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};

/// 面板只服务 Trae CN 客户端（按需求收敛；TRAE SOLO CN / 国际版 Trae 虽与 CN 同账号积分互通，
/// 但本面板不做支持）。
const TRAE_DIRS: &[&str] = &["Trae CN"];

/// 收集签到所需的本地登录态原始文本（按 kind 分流）。返回 JS 直接消费的 JSON。
#[tauri::command]
pub fn collect_checkin_state(kind: String) -> Result<Value, String> {
    match kind.as_str() {
        "workbuddy" => collect_workbuddy(),
        "trae" => collect_trae(),
        _ => Err(format!("未知签到类型: {kind}")),
    }
}

fn collect_workbuddy() -> Result<Value, String> {
    let ld = std::env::var("LOCALAPPDATA")
        .map_err(|_| "未设置 LOCALAPPDATA 环境变量".to_string())?;
    let dir = PathBuf::from(ld)
        .join("CodeBuddyExtension")
        .join("Data")
        .join("Public")
        .join("auth");
    if !dir.is_dir() {
        return Err(format!(
            "未找到 WorkBuddy 登录态目录（请先打开 WorkBuddy/CodeBuddy 并登录）：{}",
            dir.display()
        ));
    }
    let mut files = Vec::new();
    let rd = fs::read_dir(&dir).map_err(|e| format!("读取登录态目录失败: {e}"))?;
    for entry in rd.flatten() {
        let p = entry.path();
        let is_info = p
            .extension()
            .and_then(|e| e.to_str())
            .map(|s| s.eq_ignore_ascii_case("info"))
            .unwrap_or(false);
        if !is_info {
            continue;
        }
        let name = p
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        match fs::read_to_string(&p) {
            Ok(text) => files.push(json!({
                "name": name,
                "path": p.to_string_lossy(),
                "text": text
            })),
            Err(e) => files.push(json!({
                "name": name,
                "path": p.to_string_lossy(),
                "error": e.to_string()
            })),
        }
    }
    if files.is_empty() {
        return Err(format!(
            "登录态目录存在但无 .info 文件（请在 WorkBuddy 客户端重新登录）：{}",
            dir.display()
        ));
    }
    Ok(json!({ "files": files }))
}

fn collect_trae() -> Result<Value, String> {
    let ad = std::env::var("APPDATA").map_err(|_| "未设置 APPDATA 环境变量".to_string())?;
    let base = PathBuf::from(ad);
    let mut targets = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for n in TRAE_DIRS {
        let appdir = base.join(n);
        let storage = appdir
            .join("User")
            .join("globalStorage")
            .join("storage.json");
        if !storage.is_file() {
            continue;
        }
        let key = storage.to_string_lossy().to_lowercase();
        if !seen.insert(key) {
            continue;
        }
        let storage_text = match fs::read_to_string(&storage) {
            Ok(t) => t,
            Err(e) => {
                targets.push(json!({
                    "name": n,
                    "appDir": appdir.to_string_lossy(),
                    "error": format!("读取 storage.json 失败: {e}")
                }));
                continue;
            }
        };
        let net_path = appdir.join("ahanet").join("tt_net_config.config");
        let net_text = fs::read_to_string(&net_path).ok();
        let main_logs = collect_main_logs(&appdir.join("logs"));
        targets.push(json!({
            "name": n,
            "appDir": appdir.to_string_lossy(),
            "storageText": storage_text,
            "netConfigText": net_text,
            "mainLogTexts": main_logs
        }));
    }
    if targets.is_empty() {
        return Err("未找到 Trae CN 登录态目录（请先打开 Trae CN 客户端并登录）".to_string());
    }
    Ok(json!({ "targets": targets }))
}

/// 收集 <logs_dir>/<子目录>/main.log（按 mtime 倒序，最多 5 个），返回文件文本数组。
/// 复刻 Python 脚本的 `logs_dir.glob("*/main.log")`：只取子目录下的 main.log。
fn collect_main_logs(logs_dir: &Path) -> Vec<String> {
    let mut out = Vec::new();
    let rd = match fs::read_dir(logs_dir) {
        Ok(r) => r,
        Err(_) => return out,
    };
    let mut cands: Vec<(std::time::SystemTime, PathBuf)> = Vec::new();
    for e in rd.flatten() {
        let p = e.path();
        if !p.is_dir() {
            continue;
        }
        let ml = p.join("main.log");
        if ml.is_file() {
            if let Ok(meta) = fs::metadata(&ml) {
                if let Ok(m) = meta.modified() {
                    cands.push((m, ml));
                }
            }
        }
    }
    cands.sort_by(|a, b| b.0.cmp(&a.0));
    for (_, p) in cands.into_iter().take(5) {
        if let Ok(t) = fs::read_to_string(&p) {
            out.push(t);
        }
    }
    out
}
