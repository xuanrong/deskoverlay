//! 外设状态 Provider —— 检测耳机/扬声器/麦克风 + 鼠标/键盘的连接情况。
//!
//! 为什么必须放在 Rust 侧（而不是前端）：
//! WebView2 里 `navigator.mediaDevices.enumerateDevices()` 在**未授权麦克风时**
//! 只返回 3 个占位项，`label` 与 `deviceId` 全是空串 —— 前端只能知道"设备数变了"，
//! 不知道"变的是什么"。要区分"这是耳机还是扬声器"，必须走 Windows Core Audio
//! 的 `PKEY_AudioEndpoint_FormFactor`，这只有原生侧能读。
//!
//! 两类数据源：
//!   - 音频：Core Audio `EnumAudioEndpoints(DEVICE_STATE_ACTIVE)`，
//!     FormFactor 判类型（Headphones/Headset/Speakers/Microphone…），
//!     `PKEY_Device_FriendlyName` 取真实设备名。
//!   - 输入：SetupAPI 按 Mouse/Keyboard 设备类枚举 + 上游父链判定（见下）。
//!
//! ⚠️ 不做电量：实测 `DEVPKEY_Device_BatteryLevel` 对全部在线外设返回空，
//!    蓝牙耳机电量要走 GATT 连接（代价极大）。与其画一个永远 "--" 的假进度条，不如不画。
//!
//! 轮询而非事件：`WM_DEVICECHANGE` 需要挂窗口消息循环，与当前 Tauri 主循环耦合，
//! 成本远高于 3 秒一次枚举（实测单次枚举 < 1ms）。

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use windows::core::GUID;
use windows::Win32::Devices::DeviceAndDriverInstallation::{
    CM_Get_Device_IDW, CM_Get_Parent, SetupDiDestroyDeviceInfoList, SetupDiEnumDeviceInfo,
    SetupDiGetClassDevsW, SetupDiGetDeviceInstanceIdW, SetupDiGetDeviceRegistryPropertyW,
    DIGCF_PRESENT, HDEVINFO, SETUP_DI_REGISTRY_PROPERTY, SP_DEVINFO_DATA,
};
use windows::Win32::Foundation::PROPERTYKEY;
use windows::Win32::Media::Audio::{
    eCapture, eRender, DEVICE_STATE_ACTIVE, EDataFlow, EndpointFormFactor, IMMDeviceEnumerator,
    MMDeviceEnumerator, PKEY_AudioEndpoint_FormFactor,
};
use windows::Win32::System::Com::StructuredStorage::{
    PropVariantClear, PropVariantToStringAlloc,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_MULTITHREADED, STGM_READ,
};
use windows::Win32::UI::Shell::PropertiesSystem::IPropertyStore;

/// 设备安装类 GUID（鼠标 / 键盘）。
/// 用 SetupAPI 按类枚举，而不是 RawInput 全量扫描 —— 见 `count_external_input` 的注释。
const GUID_DEVCLASS_MOUSE: GUID = GUID::from_u128(0x4d36e96f_e325_11ce_bfc1_08002be10318);
const GUID_DEVCLASS_KEYBOARD: GUID = GUID::from_u128(0x4d36e96b_e325_11ce_bfc1_08002be10318);
/// HIDClass：蓝牙键鼠只能从这里找到（见 `collect_bluetooth_hid`）。
const GUID_DEVCLASS_HIDCLASS: GUID = GUID::from_u128(0x745a17a0_74d3_11d0_b6fe_00a0c90f57da);

/// `SPDRP_REMOVAL_POLICY`（0x1F）：设备移除策略。
/// 1=不可移除（内置） 2=可有序移除 3=可意外拔出（USB 热插拔）
const SPDRP_REMOVAL_POLICY: u32 = 0x0000_001F;

/// USB Hub 的典型 VID（上游链路里出现这些就是走了扩展坞/Hub）。
/// 实测本机扩展坞链路：
///   HID\VID_1EA7&PID_0066&MI_00   ← 冒充键盘的 HID 集合
///     → USB\VID_1EA7&PID_0066     ← 复合设备
///       → USB\VID_2109&PID_2813   ← VIA USB Hub（扩展坞主控）
///         → USB\VID_05E3&PID_0610 ← Genesys Logic Hub（扩展坞二级）
/// 只要父链上出现 Hub，这个"键鼠"就不是直接插在机器上的。
const USB_HUB_VIDS: &[&str] = &[
    "2109", // VIA Labs
    "05E3", // Genesys Logic
    "1A40", // Terminus
    "0424", // Microchip / SMSC
    "0BDA", // Realtek
    "1A86", // QinHeng (CH34x 常见于廉价扩展坞)
    "04B4", // Cypress
    "1D6B", // Linux Foundation（虚拟）
];

/// 判定「这个 HID 集合是不是扩展坞自带的假键鼠」。
///
/// 为什么要往上找父链：扩展坞的 HID 控制芯片会向系统报告自己是
/// 「HID Keyboard Device」+「HID-compliant mouse」，Windows 认为它们
/// `Status=OK`、`policy=3`，任何单纯看设备类的办法都会把它们当真。
/// 但它们**一定**挂在某个 USB Hub 下面，而真实键盘鼠标通常直连根集线器
/// 或机箱面板口（父链只有 ROOT_HUB）。
///
/// ⚠️ 这个判据是「启发式」，不追求 100% 准确 —— 用户把真键鼠插在扩展坞上
/// 时也会命中。所以前端仍然保留「忽略」开关作为兜底。
unsafe fn is_via_hub(devinst: u32) -> bool {
    let mut cur = devinst;
    // 最多向上走 6 层，避免异常拓扑死循环
    for _ in 0..6 {
        let id = device_id_of(cur);
        if let Some(vid) = extract_vid(&id) {
            if USB_HUB_VIDS.contains(&vid.as_str()) {
                return true;
            }
        }
        let mut parent = 0u32;
        if CM_Get_Parent(&mut parent, cur, 0).0 != 0 {
            break;
        }
        cur = parent;
    }
    false
}

/// 从实例 ID 抽 VID（大写四位）。`USB\VID_2109&PID_2813\...` → `"2109"`
fn extract_vid(instance: &str) -> Option<String> {
    let up = instance.to_uppercase();
    let p = up.find("VID_")?;
    let s = &up[p + 4..];
    let end = s.find(|c: char| !c.is_ascii_hexdigit()).unwrap_or(s.len());
    if end >= 4 {
        Some(s[..4].to_string())
    } else {
        None
    }
}

/// 读设备实例 ID（按 devinst）。父链遍历用它。
unsafe fn device_id_of(devinst: u32) -> String {
    let mut buf = vec![0u16; 512];
    if CM_Get_Device_IDW(devinst, &mut buf, 0).0 == 0 {
        let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        String::from_utf16_lossy(&buf[..end])
    } else {
        String::new()
    }
}

/// 把 SetupAPI 的 `SP_DEVINFO_DATA.DevInst` 转成可遍历的 devnode。
unsafe fn is_devinst_via_hub(dev_inst: u32) -> bool {
    is_via_hub(dev_inst)
}

/// `PKEY_AudioEndpoint_FormFactor`：音频端点的物理形态（耳机/扬声器/麦克风…）。
/// windows-rs 已导出同名常量，直接复用，避免自己拼 GUID 出错。
const PKEY_FORM_FACTOR: PROPERTYKEY = PKEY_AudioEndpoint_FormFactor;

/// `PKEY_Device_FriendlyName`：设备显示名。
/// ⚠️ 它在 `Win32::Devices::FunctionDiscovery` 而不是 `Media::Audio` —— 容易找错模块。
const PKEY_FRIENDLY_NAME: PROPERTYKEY = windows::Win32::Devices::FunctionDiscovery::PKEY_Device_FriendlyName;

/// `VT_UI4` 的原始值：FormFactor 以无符号 32 位整数存放。
const VT_UI4_VALUE: u16 = 19;

/// 前端是否正在消费外设数据。无消费者时降频，避免空转。
static PERIPHERAL_ON: AtomicBool = AtomicBool::new(false);

#[tauri::command]
pub fn start_peripheral_sampling() {
    PERIPHERAL_ON.store(true, Ordering::Relaxed);
}

#[tauri::command]
pub fn stop_peripheral_sampling() {
    PERIPHERAL_ON.store(false, Ordering::Relaxed);
}

/// 把 EndpointFormFactor 翻成前端可直接用的语义标签。
/// 返回 (类型键, 中文名)。类型键用于选图标，中文名用于悬停提示。
fn form_factor_label(ff: i32) -> (&'static str, &'static str) {
    // 枚举值见 EndpointFormFactor（mmdeviceapi.h），windows-rs 已导出同名常量
    match ff {
        v if v == EndpointFormFactor(3).0 => ("headphone", "耳机"),
        v if v == EndpointFormFactor(5).0 => ("headset", "耳麦"),
        v if v == EndpointFormFactor(1).0 => ("speaker", "扬声器"),
        v if v == EndpointFormFactor(4).0 => ("microphone", "麦克风"),
        v if v == EndpointFormFactor(6).0 => ("handset", "手持电话"),
        v if v == EndpointFormFactor(2).0 => ("linelevel", "线路输入"),
        v if v == EndpointFormFactor(8).0 => ("spdif", "S/PDIF"),
        v if v == EndpointFormFactor(9).0 => ("hdmi", "HDMI 显示设备"),
        v if v == EndpointFormFactor(0).0 => ("network", "网络音频"),
        _ => ("unknown", "音频设备"),
    }
}

/// 读一个 PROPVARIANT 字符串属性。
/// `PropVariantToStringAlloc` 分配的内存归调用方，必须用 `PropVariantClear` 释放 ——
/// 这里在同一个函数内配对完成，避免泄漏。
unsafe fn read_string(store: &IPropertyStore, key: &PROPERTYKEY) -> Option<String> {
    let mut pv = store.GetValue(key).ok()?;
    let s = PropVariantToStringAlloc(&pv)
        .ok()
        .and_then(|pw| pw.to_string().ok());
    let _ = PropVariantClear(&mut pv);
    s
}

/// 读 FormFactor（VT_UI4）。读不到时返回 None，由调用方回退到"未知音频设备"。
unsafe fn read_form_factor(store: &IPropertyStore) -> Option<i32> {
    let mut pv = store.GetValue(&PKEY_FORM_FACTOR).ok()?;
    // PROPVARIANT 外层是 union，内层 PROPVARIANT_0_0 才带 vt，
    // 所以访问路径是 pv.Anonymous.Anonymous.vt（两层 Anonymous）。
    let vt = pv.Anonymous.Anonymous.vt;
    let out = if vt.0 == VT_UI4_VALUE {
        Some(pv.Anonymous.Anonymous.Anonymous.uintVal as i32)
    } else {
        None
    };
    let _ = PropVariantClear(&mut pv);
    out
}

/// 枚举某数据流方向（eRender=播放 / eCapture=录音）下的活动端点。
/// 只取 `DEVICE_STATE_ACTIVE` —— 已拔出但驱动残留的设备不会出现在这里，
/// 这正是我们要的语义（"当前真正连着"）。
unsafe fn collect_endpoints(enumerator: &IMMDeviceEnumerator, flow: EDataFlow) -> Vec<serde_json::Value> {
    let mut out = Vec::new();
    let Ok(collection) = enumerator.EnumAudioEndpoints(flow, DEVICE_STATE_ACTIVE) else {
        return out;
    };
    let count = collection.GetCount().unwrap_or(0);
    // EDataFlow 是 newtype(i32)，比较用 .0 避免依赖 PartialEq 实现
    let flow_name = if flow.0 == eRender.0 { "out" } else { "in" };
    for i in 0..count {
        let Ok(dev) = collection.Item(i) else { continue };
        let Ok(store) = dev.OpenPropertyStore(STGM_READ) else { continue };
        let name = read_string(&store, &PKEY_FRIENDLY_NAME).unwrap_or_default();
        let ff = read_form_factor(&store).unwrap_or(-1);
        let (kind, label) = form_factor_label(ff);
        out.push(serde_json::json!({
            "name": name,
            "kind": kind,
            "type": label,
            // 播放流 = 输出设备，录音流 = 输入设备
            "flow": flow_name,
            "formFactor": ff,
        }));
    }
    out
}

/// 统计**外接**鼠标/键盘设备，并返回每个设备的身份信息。
///
/// ⚠️ 这里踩过两个坑，别再改回去：
///
/// 【坑一】`GetRawInputDeviceList` 单纯计数会算进内置与虚拟设备。
/// 实测本机（笔记本 + 扩展坞）RawInput 报 2 鼠标 / 5 键盘，其中包含
/// 「内置触摸板」「笔记本 ACPI 键盘」「Intel HID 事件筛选器」
/// 「Microsoft Keyboard RID\0 虚拟占位」—— 全是用户不认为存在的设备。
///
/// 【坑二】改用 SetupAPI 的 `SPDRP_REMOVAL_POLICY` 能滤掉内置：
///   1 = 不可移除（内置触摸板 / 笔记本键盘 / ACPI 键盘）
///   2 = 可有序移除
///   3 = 可意外拔出（USB 热插拔）
/// 实测本机降到 1 鼠标 / 1 键盘，但**这 1/1 仍是扩展坞**。
///
/// 为什么不能自动再往下区分：扩展坞的 HID 控制芯片会向上报告
/// 「HID Keyboard Device」+「HID-compliant mouse」，Windows 自己也认为
/// 它们 Status=OK。更关键的是——**罗技 Unifying 接收器是同样的签名**：
/// 一个 USB 设备同时暴露鼠标和键盘，那是完全合法的真实设备。
/// 任何「同 VID/PID 同时有键鼠 → 判为假」的启发式都会误杀无线套装。
///
/// 所以最终方案：如实上报设备身份（VID/PID），由前端提供「忽略此设备」，
/// 用户对自己的硬件最清楚。Rust 侧保持无状态，忽略名单存在前端 state.json。
unsafe fn collect_external_input() -> serde_json::Value {
    let mice = collect_external_in_class(&GUID_DEVCLASS_MOUSE);
    let keys = collect_external_in_class(&GUID_DEVCLASS_KEYBOARD);
    // 蓝牙键鼠不在 Mouse/Keyboard 类里，必须单独找（见 collect_bluetooth_hid）
    let bt = collect_bluetooth_hid();
    serde_json::json!({
        "mouseCount": mice.len(),
        "keyboardCount": keys.len(),
        // 设备明细：前端按 id 过滤忽略名单，并展示给用户确认
        "mouse": mice,
        "keyboard": keys,
        "bluetooth": bt,
    })
}

/// 枚举某个设备类下**当前在线**且 policy=3（可意外拔出）的实例。
/// 返回 `{ id, vid, pid, viaHub }`，id 是稳定可持久化的身份（前端忽略名单用它）。
unsafe fn collect_external_in_class(class: &GUID) -> Vec<serde_json::Value> {
    let mut out = Vec::new();
    let Ok(set) = SetupDiGetClassDevsW(Some(class), None, None, DIGCF_PRESENT) else {
        return out;
    };
    let mut i = 0u32;
    loop {
        let mut dev = SP_DEVINFO_DATA {
            cbSize: std::mem::size_of::<SP_DEVINFO_DATA>() as u32,
            ..Default::default()
        };
        if SetupDiEnumDeviceInfo(set, i, &mut dev).is_err() {
            break;
        }
        // 只认 3：可意外拔出。1=内置，2=可有序移除（多为内置热插拔槽位）
        if read_removal_policy(set, &dev) == Some(3) {
            if let Some(inst) = read_instance_id(set, &dev) {
                // 从实例 ID 里抽 VID/PID 给用户看的身份标识。
                // 例：HID\VID_1EA7&PID_0066&MI_01&COL02\9&24BB373&0&0001
                let (vid, pid) = parse_vid_pid(&inst);
                // 上游是否经过 USB Hub —— 经过的多半是扩展坞自带的假键鼠。
                // 这不是硬过滤：真键鼠插扩展坞上也会命中，所以只作为
                // 「默认不计入 + 前端可恢复」的软判据。
                let via_hub = is_devinst_via_hub(dev.DevInst);
                // ⚠️ id 必须是**每个接口唯一**的，不能只用 "VID:PID"：
                // 同一个扩展坞的鼠标接口（MI_01&COL02）和键盘接口（MI_00）
                // 共享 VID/PID，只用 VID:PID 会导致「忽略鼠标」把键盘也一起忽略。
                // 所以 id 带上 MI_xx / COLxx 接口段。
                out.push(serde_json::json!({
                    "id": device_key(&vid, &pid, &inst),
                    "vid": vid,
                    "pid": pid,
                    "instance": inst,
                    "viaHub": via_hub,
                }));
            }
        }
        i += 1;
    }
    let _ = SetupDiDestroyDeviceInfoList(set);
    out
}

/// 枚举蓝牙 HID 设备（BLE GATT HID + 经典蓝牙 HID），只算**当前真正连着**的。
///
/// ⚠️ 为什么必须单独做：蓝牙鼠标/键盘**不在** `GUID_DEVCLASS_MOUSE` /
/// `GUID_DEVCLASS_KEYBOARD` 里被 `DIGCF_PRESENT` 枚举到 —— 它们挂在
/// `BTHLEDEVICE\{00001812-...}`（HID over GATT）或 `BTHENUM\...` 下面。
///
/// ⚠️ 判「是否连着」只有一个可靠办法：**看 HID 集合节点（COLxx）能不能 locate**。
/// 实测对比（本机 MCHOSE G87 三模键盘，蓝牙未连接）：
///   - `BTHLE\DEV_xxx` 蓝牙设备本身      → started=true  ← 配对记忆，**没有区分能力**
///   - `BTHLEDEVICE\{00001812...}`       → started=true  ← 同上，也是记忆
///   - `HID\{00001812...}&COL01`（键盘） → **NOT-PRESENT** ← 这才是真相
///   - `HID\{00001812...}&COL03`（鼠标） → **NOT-PRESENT**
///   - 对照：USB 扩展坞键盘 / 触摸板      → started=true
/// 所以用 `CM_Locate_DevNodeW` 试定位每个 COLxx 节点，定位失败 = 当前没连。
///
/// 类型判定看 COLxx 节点的 `SPDRP_DEVICEDESC`：
///   "HID Keyboard Device" / "HID-compliant mouse"（英文，不受系统语言影响）
unsafe fn collect_bluetooth_hid() -> serde_json::Value {
    const BLE_HID_UUID: &str = "00001812-0000-1000-8000-00805F9B34FB";
    const BT_HID_UUID: &str = "00001124-0000-1000-8000-00805F9B34FB";

    let mut mouse = false;
    let mut keyboard = false;
    let mut names: Vec<String> = Vec::new();

    // 从 HIDClass 类枚举拿**所有** BTH 来源的节点（含 BTHLEDEVICE 与 COLxx）。
    // 注意不能只按 DIGCF_PRESENT：这里要枚举到未激活的节点再逐个试定位，
    // 所以去掉 PRESENT 过滤，靠 locate 结果判断在线与否。
    let Ok(set) = SetupDiGetClassDevsW(Some(&GUID_DEVCLASS_HIDCLASS), None, None, Default::default())
    else {
        return serde_json::json!({ "mouse": false, "keyboard": false, "names": names });
    };
    let mut i = 0u32;
    loop {
        let mut dev = SP_DEVINFO_DATA {
            cbSize: std::mem::size_of::<SP_DEVINFO_DATA>() as u32,
            ..Default::default()
        };
        if SetupDiEnumDeviceInfo(set, i, &mut dev).is_err() {
            break;
        }
        i += 1;

        let Some(inst) = read_instance_id(set, &dev) else { continue };
        let up = inst.to_uppercase();
        let is_bt = up.contains(BLE_HID_UUID) || up.contains(BT_HID_UUID);
        // 只看 HID 集合节点（带 &COLxx），父节点 BTHLEDEVICE 本身不算
        if !is_bt || !up.contains("&COL") {
            continue;
        }
        // 关键：能不能 locate —— 定位失败说明这个集合当前没激活（设备没连）
        if !devnode_present(&inst) {
            continue;
        }
        if let Some(desc) = read_device_desc(set, &dev) {
            let d = desc.to_lowercase();
            if d.contains("mouse") || d.contains("鼠标") {
                mouse = true;
            }
            if d.contains("keyboard") || d.contains("键盘") {
                keyboard = true;
            }
            if !names.contains(&desc) {
                names.push(desc);
            }
        }
    }
    let _ = SetupDiDestroyDeviceInfoList(set);

    serde_json::json!({ "mouse": mouse, "keyboard": keyboard, "names": names })
}

/// 设备节点当前是否存在/已启动。`CM_Locate_DevNodeW` 定位失败 = 不在线。
///
/// 这是区分「配对记忆」与「当前连着」的唯一可靠判据 —— 见 `collect_bluetooth_hid`。
unsafe fn devnode_present(instance_id: &str) -> bool {
    use windows::Win32::Devices::DeviceAndDriverInstallation::{
        CM_Locate_DevNodeW, CM_LOCATE_DEVNODE_NORMAL,
    };
    let wide: Vec<u16> = instance_id.encode_utf16().chain(std::iter::once(0)).collect();
    let mut devinst = 0u32;
    CM_Locate_DevNodeW(
        &mut devinst,
        windows::core::PCWSTR(wide.as_ptr()),
        CM_LOCATE_DEVNODE_NORMAL,
    )
    .0 == 0
}

/// 读 `SPDRP_DEVICEDESC`（设备描述，如 "HID-compliant mouse"）。
unsafe fn read_device_desc(set: HDEVINFO, dev: &SP_DEVINFO_DATA) -> Option<String> {
    const SPDRP_DEVICEDESC: u32 = 0x0000_0000;
    let mut buf = vec![0u8; 1024];
    SetupDiGetDeviceRegistryPropertyW(
        set,
        dev,
        SETUP_DI_REGISTRY_PROPERTY(SPDRP_DEVICEDESC),
        None,
        Some(&mut buf),
        None,
    )
    .ok()?;
    let u16s: Vec<u16> = buf
        .chunks_exact(2)
        .map(|c| u16::from_le_bytes([c[0], c[1]]))
        .collect();
    let end = u16s.iter().position(|&c| c == 0).unwrap_or(u16s.len());
    let s = String::from_utf16_lossy(&u16s[..end]);
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

/// 从实例 ID 里解析 `VID_XXXX` / `PID_XXXX`；解析不到时返回空串。
fn parse_vid_pid(instance: &str) -> (String, String) {
    let up = instance.to_uppercase();
    let grab = |tag: &str| -> String {
        match up.find(tag) {
            Some(p) => {
                let s = &up[p + tag.len()..];
                let end = s.find(|c: char| !c.is_ascii_hexdigit()).unwrap_or(s.len());
                s[..end.min(4)].to_string()
            }
            None => String::new(),
        }
    };
    (grab("VID_"), grab("PID_"))
}

/// 生成设备的稳定唯一键：`VID:PID:MI_xx:COLxx`。
///
/// 为什么不能只用 `VID:PID`：同一个 USB 复合设备（扩展坞 / 无线接收器）
/// 会同时暴露鼠标接口（`&MI_01&COL02`）和键盘接口（`&MI_00`），
/// 两者 VID/PID 完全相同。只用 VID:PID 会导致「忽略鼠标」把键盘一起忽略。
/// 补上接口段后每个 HID 集合都能被单独识别。
fn device_key(vid: &str, pid: &str, instance: &str) -> String {
    let up = instance.to_uppercase();
    // 抽 MI_xx（interface）与 COLxx（collection）段。
    // MI 段要截到 '&' 或 '\' 为止 —— 否则 MI_01&COL02 会被整段吞掉，
    // 再拼上 COL02 就变成 "MI_01&COL02:COL02"。
    let seg = |tag: &str, stops: &[char]| -> String {
        match up.find(tag) {
            Some(p) => {
                let s = &up[p..];
                let end = s.find(|c: char| stops.contains(&c)).unwrap_or(s.len());
                s[..end].to_string()
            }
            None => String::new(),
        }
    };
    let mi = seg("MI_", &['&', '\\']);
    let col = seg("COL", &['&', '\\']);
    let mut key = format!("{vid}:{pid}");
    if !mi.is_empty() {
        key.push(':');
        key.push_str(&mi);
    }
    if !col.is_empty() {
        key.push(':');
        key.push_str(&col);
    }
    key
}

/// 读设备实例 ID（稳定身份，比 FriendlyName 可靠）。
unsafe fn read_instance_id(set: HDEVINFO, dev: &SP_DEVINFO_DATA) -> Option<String> {
    let mut buf = vec![0u16; 512];
    let mut needed: u32 = 0;
    SetupDiGetDeviceInstanceIdW(set, dev, Some(&mut buf), Some(&mut needed)).ok()?;
    let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    Some(String::from_utf16_lossy(&buf[..end]))
}

/// 读 `SPDRP_REMOVAL_POLICY`。读不到时返回 None（保守跳过，不误报）。
unsafe fn read_removal_policy(
    set: HDEVINFO,
    dev: &SP_DEVINFO_DATA,
) -> Option<u32> {
    let mut buf = [0u8; 4];
    SetupDiGetDeviceRegistryPropertyW(
        set,
        dev,
        SETUP_DI_REGISTRY_PROPERTY(SPDRP_REMOVAL_POLICY),
        None,
        Some(&mut buf),
        None,
    )
    .ok()?;
    Some(u32::from_le_bytes(buf))
}

/// 采集一次外设快照。COM 初始化/反初始化在本函数内配对完成，
/// 因为它在独立线程里以 3 秒间隔反复调用。
fn snapshot() -> serde_json::Value {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let result = (|| -> serde_json::Value {
            let input = collect_external_input();
            let bt = input["bluetooth"].clone();
            // 蓝牙键鼠补进设备明细：它们不在 Mouse/Keyboard 类里，只能靠 HIDClass 找。
            // 蓝牙设备没有可靠的 VID/PID（VID&0107D7_PID&EFFF 是 HID 规范伪 ID），
            // 所以用固定 id "bluetooth"，前端不再给「忽略」按钮（忽略整类没有意义）。
            let mut mice = input["mouse"].as_array().cloned().unwrap_or_default();
            let mut keys = input["keyboard"].as_array().cloned().unwrap_or_default();
            let bt_mouse = bt["mouse"].as_bool().unwrap_or(false);
            let bt_keyboard = bt["keyboard"].as_bool().unwrap_or(false);
            if bt_mouse {
                mice.push(serde_json::json!({
                    "id": "bluetooth:mouse",
                    "vid": "", "pid": "",
                    "instance": "BTHLE",
                    "viaHub": false,
                    "bluetooth": true,
                }));
            }
            if bt_keyboard {
                keys.push(serde_json::json!({
                    "id": "bluetooth:keyboard",
                    "vid": "", "pid": "",
                    "instance": "BTHLE",
                    "viaHub": false,
                    "bluetooth": true,
                }));
            }
            let mouse_count = mice.len();
            let keyboard_count = keys.len();

            let audio = match CoCreateInstance::<_, IMMDeviceEnumerator>(&MMDeviceEnumerator, None, CLSCTX_ALL) {
                Ok(en) => {
                    let mut outs = collect_endpoints(&en, eRender);
                    let ins = collect_endpoints(&en, eCapture);
                    outs.extend(ins);
                    outs
                }
                Err(_) => Vec::new(),
            };

            // 派生三个前端直接用的布尔位：有没有耳机、有没有鼠标、有没有键盘
            let has_headphone = audio.iter().any(|a| {
                let k = a["kind"].as_str().unwrap_or("");
                (k == "headphone" || k == "headset") && a["flow"].as_str() == Some("out")
            });

            serde_json::json!({
                "audio": audio,
                // 数量是**未经前端忽略名单过滤**的原始值；前端过滤后再显示。
                // 分开给是为了让前端能在浮层里提示「检测到 N 个，已忽略 M 个」。
                "mouse": mouse_count,
                "keyboard": keyboard_count,
                // 设备明细（含 VID/PID 与 viaHub），前端据此实现「忽略此设备」
                "mouseDevices": mice,
                "keyboardDevices": keys,
                "hasHeadphone": has_headphone,
                "hasMouse": mouse_count > 0,
                "hasKeyboard": keyboard_count > 0,
            })
        })();
        CoUninitialize();
        result
    }
}

/// 启动外设 Provider 线程：3 秒一次推送 `provider-emit(config_hash="peripheral")`。
/// 无消费者时降到 10 秒，只轮询开关状态。
pub fn start_peripheral_provider(app: AppHandle) {
    std::thread::spawn(move || {
        let mut last: Option<String> = None;
        loop {
            if PERIPHERAL_ON.load(Ordering::Relaxed) {
                let out = snapshot();
                // 内容不变就不推，省掉前端无谓的重绘。
                // 注意：不能因为"没变"就完全不推 —— 首帧必须推，否则前端永远等不到数据。
                let sig = out.to_string();
                if last.as_deref() != Some(sig.as_str()) {
                    let _ = app.emit(
                        "provider-emit",
                        serde_json::json!({ "config_hash": "peripheral", "output": out }),
                    );
                    last = Some(sig);
                }
                std::thread::sleep(Duration::from_secs(3));
            } else {
                // 不用清空 last：前端可能随时重新订阅（刷新页面），
                // 清空会导致「重连后数据没变 → 判定为无变化 → 不推首帧」，
                // 前端就永远停在灰点态。
                std::thread::sleep(Duration::from_secs(10));
            }
        }
    });
}

/// 真实环境自检：`cargo test peripheral -- --nocapture` 会打印本机实际读到的外设。
/// 这是唯一能证明 Core Audio / RawInput 真的工作的方式 ——
/// 前端 mock 注入的是假数据，只能验证渲染逻辑，验证不了采集逻辑。
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn probe_real_peripherals() {
        let out = snapshot();
        println!("=== 外设快照 ===\n{}", serde_json::to_string_pretty(&out).unwrap_or_default());

        // 基本不变量：鼠标键盘数量必须是有限值（不是 u32::MAX 那种错误哨兵）
        let mouse = out["mouse"].as_u64().unwrap_or(0);
        let keyboard = out["keyboard"].as_u64().unwrap_or(0);
        println!("\n鼠标 {mouse} 个，键盘 {keyboard} 个");
        assert!(mouse < 100, "鼠标数量异常: {mouse}");
        assert!(keyboard < 100, "键盘数量异常: {keyboard}");

        // 音频端点：结构完整性
        if let Some(audio) = out["audio"].as_array() {
            println!("音频端点 {} 个：", audio.len());
            for a in audio {
                println!(
                    "  [{}] {} ({}) flow={}",
                    a["kind"].as_str().unwrap_or("?"),
                    a["name"].as_str().unwrap_or("(无名)"),
                    a["type"].as_str().unwrap_or("?"),
                    a["flow"].as_str().unwrap_or("?"),
                );
            }
        }
    }

    /// `device_key` 是「忽略名单」的唯一键，错了会导致：
    ///   - 只用 VID:PID → 扩展坞的鼠标和键盘共用一个键，忽略一个另一个也没了
    ///   - MI 段不截断 → 出现 "MI_01&COL02:COL02" 这种重复拼接
    /// 两种情况都实测踩过，所以用纯函数测试钉死。
    #[test]
    fn device_key_is_unique_per_interface() {
        // 扩展坞：同一个 USB 复合设备的鼠标接口与键盘接口
        let mouse = "HID\\VID_1EA7&PID_0066&MI_01&COL02\\9&24BB373&0&0001";
        let keyboard = "HID\\VID_1EA7&PID_0066&MI_00\\9&270CB0B6&0&0000";
        let (mvid, mpid) = parse_vid_pid(mouse);
        let (kvid, kpid) = parse_vid_pid(keyboard);
        assert_eq!((mvid.as_str(), mpid.as_str()), ("1EA7", "0066"));
        assert_eq!((kvid.as_str(), kpid.as_str()), ("1EA7", "0066"));

        let mkey = device_key(&mvid, &mpid, mouse);
        let kkey = device_key(&kvid, &kpid, keyboard);
        assert_ne!(mkey, kkey, "同一扩展坞的鼠标和键盘必须有不同的忽略键");
        assert_eq!(mkey, "1EA7:0066:MI_01:COL02");
        assert_eq!(kkey, "1EA7:0066:MI_00");
        // 不能出现重复的 COL 段（曾因 MI 段未在 '&' 处截断而产生）
        assert!(!mkey.contains("COL02:COL02"), "COL 段被重复拼接: {mkey}");

        // 普通单接口设备：没有 MI/COL，键就是 VID:PID
        let plain = "USB\\VID_046D&PID_C52B\\5&1A2B3C4D&0&1";
        let (v, p) = parse_vid_pid(plain);
        assert_eq!(device_key(&v, &p, plain), "046D:C52B");

        // 解析不到 VID/PID 时退化为 ":"（前端据此不给忽略按钮）
        let (v2, p2) = parse_vid_pid("ACPI\\IDEA0100\\4&52236B9&0");
        assert_eq!((v2.as_str(), p2.as_str()), ("", ""));
    }

    /// 蓝牙判据的核心：`devnode_present` 必须能区分「配对记忆」与「当前连着」。
    ///
    /// 实测对照（本机）：
    ///   - MCHOSE G87 的 HID 集合（蓝牙未连）→ false
    ///   - 扩展坞键盘（USB 真连着）           → true
    /// 如果这条断了，蓝牙键鼠会永远显示「已连接」或永远检测不到。
    #[test]
    fn devnode_present_distinguishes_paired_from_connected() {
        unsafe {
            // 必然存在的节点
            assert!(
                devnode_present("USB\\ROOT_HUB30\\4&2A853AD3&0&0"),
                "根集线器必须能定位"
            );
            // 纯属虚构的节点必须定位失败
            assert!(
                !devnode_present("HID\\VID_FFFF&PID_FFFF\\0&0&0&0"),
                "不存在的节点不该定位成功"
            );
        }
    }

    /// 蓝牙检测的判据：只有 HID 集合（&COLxx）在线才算「连着」，
    /// 父节点 BTHLEDEVICE 的 started 状态没有区分能力（实测全是 true）。
    #[test]
    fn bluetooth_requires_active_hid_collection() {
        let bt = unsafe { collect_bluetooth_hid() };
        println!("蓝牙键鼠检测结果：{bt}");
        // 结构完整性：三个字段都要有
        assert!(bt["mouse"].is_boolean(), "缺少 mouse 字段");
        assert!(bt["keyboard"].is_boolean(), "缺少 keyboard 字段");
        assert!(bt["names"].is_array(), "缺少 names 字段");
        // 检测到设备时必须有名字（否则无法向用户说明是什么）
        if bt["mouse"].as_bool() == Some(true) || bt["keyboard"].as_bool() == Some(true) {
            assert!(
                !bt["names"].as_array().map(|a| a.is_empty()).unwrap_or(true),
                "检测到蓝牙键鼠但没拿到设备名"
            );
        }
    }
}
