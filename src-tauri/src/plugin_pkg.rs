//! 外部「插件包」安装与后端编译：解压 zip → 安装到 app_data/plugins/<id>，用本机 cargo 把后端编译成 .wasm。
//! 宿主只做通用「解压 + 编译 + 布局」，插件业务代码（frontend.js / backend）均在 zip 内、不属于工作台代码。

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use tauri::Manager;

/// 从 zip 包解压安装插件，返回 manifest（补充 frontend/backend 的绝对路径）。
/// 返回结构：{ ...manifest, install_dir, frontend?, backend_dir?, backend? }
pub fn install(app: &tauri::AppHandle, zip_path: &str) -> Result<serde_json::Value, String> {
    let install_base = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("plugins");
    fs::create_dir_all(&install_base).map_err(|e| e.to_string())?;

    let file = fs::File::open(zip_path).map_err(|e| format!("打开 zip 失败：{e}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("zip 无效：{e}"))?;

    // 预读 manifest.json 以确定 id
    let mut manifest: serde_json::Value = serde_json::json!({});
    for i in 0..archive.len() {
        let mut f = archive.by_index(i).map_err(|e| e.to_string())?;
        let name = f.name().replace('\\', "/");
        let is_man = name.ends_with("manifest.json") || name == "manifest.json";
        if is_man {
            let mut s = String::new();
            f.read_to_string(&mut s).map_err(|e| e.to_string())?;
            manifest = serde_json::from_str(&s).map_err(|e| format!("manifest.json 解析失败：{e}"))?;
            break;
        }
    }
    let id = manifest
        .get("id")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .unwrap_or("plugin")
        .to_string();
    let target = install_base.join(&id);

    // 逐条解压（路径做简单防穿越）
    for i in 0..archive.len() {
        let mut f = archive.by_index(i).map_err(|e| e.to_string())?;
        let name = f.name().replace('\\', "/");
        if name.ends_with('/') {
            continue; // 目录项
        }
        let rel = sanitize(&name);
        if rel.is_empty() {
            continue;
        }
        let out = target.join(&rel);
        if let Some(parent) = out.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut buf = Vec::new();
        f.read_to_end(&mut buf).map_err(|e| e.to_string())?;
        fs::write(&out, &buf).map_err(|e| format!("写出 {rel} 失败：{e}"))?;
    }

    // 补充绝对路径
    if let Some(front) = manifest.get("frontend").and_then(|v| v.as_str()) {
        manifest["frontend"] = serde_json::json!(target.join(front).to_string_lossy());
    }
    if let Some(bk) = manifest.get("backend").and_then(|v| v.as_str()) {
        manifest["backend_dir"] = serde_json::json!(target.join(bk).to_string_lossy());
    }
    manifest["install_dir"] = serde_json::json!(target.to_string_lossy());

    // 优先：zip 内已自带预编译 .wasm（无需 cargo 编译），直接可用
    if let Some(w) = find_wasm(&target) {
        manifest["backend_wasm"] = serde_json::json!(w.to_string_lossy());
    }

    Ok(manifest)
}

/// 在目录及其子目录中递归查找第一个 .wasm 文件（zip 内预编译的后端产物）。
fn find_wasm(dir: &Path) -> Option<PathBuf> {
    let entries = fs::read_dir(dir).ok()?;
    for e in entries.flatten() {
        let p = e.path();
        if p.is_dir() {
            if let Some(f) = find_wasm(&p) {
                return Some(f);
            }
        } else if p.extension().map(|x| x == "wasm").unwrap_or(false) {
            return Some(p);
        }
    }
    None
}

/// 用本机 cargo 把后端源码(含 Cargo.toml) 编译成 wasm32-unknown-unknown，返回 .wasm 绝对路径。
pub fn build_backend(backend_dir: &str) -> Result<String, String> {
    let dir = Path::new(backend_dir);
    if !dir.join("Cargo.toml").exists() {
        return Err("后端目录缺少 Cargo.toml".to_string());
    }
    let out = std::process::Command::new("cargo")
        .args(["build", "--release", "--target", "wasm32-unknown-unknown"])
        .current_dir(dir)
        .output()
        .map_err(|e| format!("无法调用 cargo：{e}（请确认已安装 Rust）"))?;
    if !out.status.success() {
        return Err(format!(
            "后端编译失败：\n{}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    // 在 target 目录里找一个 *.wasm
    let release_dir = dir.join("target").join("wasm32-unknown-unknown").join("release");
    let mut wasm: Option<PathBuf> = None;
    if let Ok(rd) = fs::read_dir(&release_dir) {
        for e in rd.flatten() {
            if e.path().extension().map(|x| x == "wasm").unwrap_or(false) {
                wasm = Some(e.path());
            }
        }
    }
    wasm.map(|p| p.to_string_lossy().into_owned())
        .ok_or_else(|| "编译成功但未找到 .wasm 产物".to_string())
}

/// 简单路径防穿越：去掉前导 / 与 .. 段。
fn sanitize(name: &str) -> String {
    let mut parts = Vec::new();
    for seg in name.split('/') {
        match seg {
            "" | "." => {}
            ".." => { parts.pop(); }
            s => parts.push(s),
        }
    }
    parts.join("/")
}