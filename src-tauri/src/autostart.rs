//! 开机自启：写 HKCU Run 注册表键（设计见 .raccoon/autostart-design.md）。
//!
//! 真值来源是注册表本身：`HKCU\...\CurrentVersion\Run` 下存在 `DeskOverlay` 值
//! 即视为已启用；state.json 只存用户意图，设置页展示以 `autostart_status` 为准。
//!
//! - 写入值：`"<exe 绝对路径>" --autostart`（引号包裹防含空格路径截断）；
//! - 幂等重写：已存在也覆盖为新路径，exe 移动后重开一次开关即自愈；
//! - dev 构建拒绝写入，避免把 target/debug 路径注册进注册表；
//! - HKCU 写入无需管理员权限，提权运行行为一致。

use serde::Serialize;
use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS};
use windows::Win32::System::Registry::{
    RegCloseKey, RegCreateKeyExW, RegDeleteValueW, RegOpenKeyExW, RegQueryValueExW, RegSetValueExW,
    HKEY, HKEY_CURRENT_USER, KEY_QUERY_VALUE, KEY_SET_VALUE, REG_OPTION_NON_VOLATILE, REG_SZ,
    REG_VALUE_TYPE,
};

/// Run 键相对路径与注册值名
const RUN_SUBKEY: PCWSTR = w!(r"Software\Microsoft\Windows\CurrentVersion\Run");
const VALUE_NAME: PCWSTR = w!("DeskOverlay");
/// 自启启动参数：main.rs setup 据此进入静默启动路径（延迟嵌入桌面）
const LAUNCH_ARG: &str = "--autostart";

#[derive(Serialize)]
pub struct AutostartStatus {
    pub enabled: bool,
    /// 当前注册的启动命令行（未启用为空串）
    pub cmdline: String,
    /// 当前运行中的 exe 绝对路径（便于诊断「路径已漂移」）
    pub exe: String,
}

/// 以指定权限打开 Run 键；失败（含键不存在）返回 None。
fn open_run_key(desired: windows::Win32::System::Registry::REG_SAM_FLAGS) -> Option<HKEY> {
    let mut hk = HKEY::default();
    let err = unsafe { RegOpenKeyExW(HKEY_CURRENT_USER, RUN_SUBKEY, Some(0), desired, &mut hk) };
    if err == ERROR_SUCCESS {
        Some(hk)
    } else {
        None
    }
}

/// 读取 Run 键下的 DeskOverlay 值（REG_SZ）。不存在/类型不符返回 None。
fn read_value() -> Option<String> {
    let hk = open_run_key(KEY_QUERY_VALUE)?;
    let out = (|| {
        let mut ty = REG_VALUE_TYPE::default();
        let mut size: u32 = 0;
        // 第一次调用仅取所需字节数（lpdata 传 None）
        let err = unsafe {
            RegQueryValueExW(hk, VALUE_NAME, None, Some(&mut ty), None, Some(&mut size))
        };
        if err != ERROR_SUCCESS || ty != REG_SZ || size == 0 {
            return None;
        }
        let mut buf = vec![0u8; size as usize];
        let err2 = unsafe {
            RegQueryValueExW(hk, VALUE_NAME, None, None, Some(buf.as_mut_ptr()), Some(&mut size))
        };
        if err2 != ERROR_SUCCESS {
            return None;
        }
        // 数据为 NUL 结尾的 UTF-16；按实际写入字节数解码
        let words: Vec<u16> = buf[..(size as usize).min(buf.len()) & !1]
            .chunks_exact(2)
            .map(|p| u16::from_le_bytes([p[0], p[1]]))
            .take_while(|&c| c != 0)
            .collect();
        Some(String::from_utf16_lossy(&words))
    })();
    unsafe {
        let _ = RegCloseKey(hk);
    }
    out
}

/// 删除 Run 键下的 DeskOverlay 值。值本就不存在视为成功（幂等）。
fn delete_value() -> Result<(), String> {
    let hk = open_run_key(KEY_SET_VALUE)
        .ok_or_else(|| "打开注册表 Run 键失败".to_string())?;
    let err = unsafe { RegDeleteValueW(hk, VALUE_NAME) };
    unsafe {
        let _ = RegCloseKey(hk);
    }
    if err == ERROR_SUCCESS || err == ERROR_FILE_NOT_FOUND {
        Ok(())
    } else {
        Err(format!("删除注册表值失败（错误码 {err:?}）"))
    }
}

/// 开启/关闭自启（公开入口，供 Tauri 命令调用）。
pub fn set_enabled(enabled: bool) -> Result<(), String> {
    if cfg!(debug_assertions) {
        return Err("开发构建不注册自启（避免把 target/debug 路径写入注册表）".to_string());
    }
    if !enabled {
        return delete_value();
    }
    let exe = std::env::current_exe().map_err(|e| format!("获取 exe 路径失败：{e}"))?;
    let cmdline = format!("\"{}\" {}", exe.display(), LAUNCH_ARG);

    let mut hk = HKEY::default();
    // 幂等覆盖：值已存在也重写为新路径（升级/移动目录后的自愈手段）
    let err = unsafe {
        RegCreateKeyExW(
            HKEY_CURRENT_USER,
            RUN_SUBKEY,
            Some(0),
            None,
            REG_OPTION_NON_VOLATILE,
            KEY_SET_VALUE,
            None,
            &mut hk,
            None,
        )
    };
    if err != ERROR_SUCCESS {
        return Err(format!("打开/创建注册表 Run 键失败（错误码 {err:?}）"));
    }
    let mut utf16: Vec<u16> = cmdline.encode_utf16().collect();
    utf16.push(0); // REG_SZ 需 NUL 结尾
    let bytes: Vec<u8> = utf16.iter().flat_map(|w| w.to_le_bytes()).collect();
    let err = unsafe { RegSetValueExW(hk, VALUE_NAME, Some(0), REG_SZ, Some(&bytes)) };
    unsafe {
        let _ = RegCloseKey(hk);
    }
    if err == ERROR_SUCCESS {
        Ok(())
    } else {
        Err(format!("写入注册表值失败（错误码 {err:?}）"))
    }
}

/// 读取当前实际状态：注册表存在 DeskOverlay 值即 enabled。
#[tauri::command]
pub fn autostart_status() -> AutostartStatus {
    let cmdline = read_value().unwrap_or_default();
    let exe = std::env::current_exe()
        .map(|p| p.display().to_string())
        .unwrap_or_default();
    AutostartStatus {
        enabled: !cmdline.is_empty(),
        cmdline,
        exe,
    }
}

/// 开启/关闭自启。成功返回 Ok，失败返回用户可读的错误文案（前端 toast）。
#[tauri::command]
pub fn set_autostart(enabled: bool) -> Result<(), String> {
    set_enabled(enabled)
}

/// 是否以开机自启方式拉起（main.rs setup 用）。
pub fn launched_by_autostart() -> bool {
    std::env::args().any(|a| a == LAUNCH_ARG)
}
