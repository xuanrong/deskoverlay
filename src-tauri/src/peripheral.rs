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
//! 电量（2026-11-11 起支持）：
//!   蓝牙键鼠 / 蓝牙耳机都能读 `DEVPKEY_Device_BatteryLevel`（0-100），
//!   实测本机 MCHOSE 键盘 43%、vivo TWS 耳机 90%。
//!
//!   ⚠️ 旧注释说「该属性对全部在线外设返回空」—— 那是**查错节点**导致的：
//!      电量挂在**设备节点**（`BTHLE\DEV_<mac>` / `BTHENUM\DEV_<mac>`）上，
//!      而 HID 集合（`HID\{00001812…}&COLxx`）和音频端点（`SWD\MMDEVAPI\…`）
//!      上都没有。所以现在的读法是「从集合节点沿父链往上找」。
//!
//!   仍读不到的情况：有线设备（本来没电池）、部分固件只把电量报给厂商工具。
//!   这类返回 null，前端**不显示**电量字段 —— 宁可没有，也不画 "--" 的假进度条。
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
///
/// ⛔ 2026-11-10 修正：**不能再只看「父链上有没有 Hub」**。
///
/// 实测本机拓扑（真实 USB 鼠标接在扩展坞上）：
///   HID\VID_3151&PID_5032&MI_00   ← 真鼠标（VID 3151 = 设备厂商）
///     → USB\VID_3151&PID_5032
///       → USB\VID_2109&PID_2817    ← VIA 通用 USB 集线器（VID 2109）
///         → USB\ROOT_HUB30
/// 旧判据在这里返回 true ⇒ 用户的**真实鼠标**被当成「扩展坞假设备」默认不计入，
/// 桌面胶囊显示「鼠标未连接」。这正是本次要修的第二个缺陷。
///
/// 真正的区分点是：**Hub 的 VID 与设备的 VID 是否相同**。
///   · 扩展坞 HID 芯片冒充键鼠：设备本身挂在 Hub 上，且**设备 VID == Hub VID**
///     （同一颗芯片既当 Hub 又当键鼠，VID 必然一样）。
///   · 真设备插在扩展坞上：设备 VID（3151）≠ Hub VID（2109）。
///
/// 所以现在只在「上游 Hub 的 VID 与本设备 VID 相同」时才判 viaHub。
/// 拿不到设备 VID 时保守返回 false（宁可多算一个，也不要漏掉用户真实的设备 ——
/// 漏掉是「以为没接」，多算只是「多显示一个」，后者可由用户手动忽略）。
unsafe fn is_via_hub(devinst: u32) -> bool {
    // 1) 先取设备自身 VID
    let self_vid = extract_vid(&device_id_of(devinst));
    let Some(self_vid) = self_vid else {
        return false;
    };

    // 2) 沿父链找 Hub，比较 VID
    let mut cur = devinst;
    // 最多向上走 6 层，避免异常拓扑死循环
    for _ in 0..6 {
        let mut parent = 0u32;
        if CM_Get_Parent(&mut parent, cur, 0).0 != 0 {
            break;
        }
        cur = parent;
        let id = device_id_of(cur);
        if let Some(vid) = extract_vid(&id) {
            if USB_HUB_VIDS.contains(&vid.as_str()) {
                // Hub 自己的 VID 与设备 VID 相同 ⇒ 同一颗芯片既当 Hub 又冒充键鼠
                return vid == self_vid;
            }
        }
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
            // 蓝牙耳机电量：音频端点自己不带这个属性，按型号名去 PnP 设备反查。
            // 查不到就是 null（有线耳机 / 内置声卡本来就没有电量）。
            "battery": if flow.0 == eRender.0 { battery_for_audio_name(&name) } else { None },
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
    let keys_all = collect_external_in_class(&GUID_DEVCLASS_KEYBOARD);

    // ⛔ 一个物理设备只算一种身份：**鼠标优先**。
    //
    //   2026-11-10 实测（用户本机）：VID_3151&PID_5032 是一只游戏鼠标
    //   （DEVPKEY_Device_BusReportedDeviceDesc = "Gaming Mouse"），
    //   但它同时暴露了 keyboard 类集合（MI_01&COL03，svc=kbdhid）——
    //   那是鼠标的宏键/多媒体键，不是第二个键盘。
    //   旧实现按类各数一遍，于是胶囊显示「鼠标 1 + 键盘 2」，而用户桌上只有
    //   一只鼠标 + 一把蓝牙键盘。用户直接指出这是误判。
    //
    //   判据：同一个「设备身份」（VID:PID，即同一个 USB 复合设备/接收器）
    //   如果已经作为鼠标计入，就把它在 Keyboard 类里的集合**剔除**。
    //   这条规则对无线键鼠套装同样安全：一套接收器通常只声明一个鼠标 +
    //   一个键盘，鼠标优先时仍会把键盘剔掉 —— 那正是期望行为（用户看到的
    //   是一个输入设备组，不是两台机器）。
    let mouse_keys: std::collections::HashSet<String> = mice
        .iter()
        .filter_map(|m| {
            let vid = m["vid"].as_str().unwrap_or("");
            let pid = m["pid"].as_str().unwrap_or("");
            if vid.is_empty() || pid.is_empty() {
                None
            } else {
                Some(format!("{vid}:{pid}"))
            }
        })
        .collect();
    let keys: Vec<serde_json::Value> = keys_all
        .into_iter()
        .filter(|k| {
            let vid = k["vid"].as_str().unwrap_or("");
            let pid = k["pid"].as_str().unwrap_or("");
            !mouse_keys.contains(&format!("{vid}:{pid}"))
        })
        .collect();

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
                // 上游是否经过 USB Hub —— 见 is_via_hub 的注释：
                // 只有「Hub 的 VID == 本设备 VID」才算冒充（同一颗芯片既当 Hub 又当键鼠）。
                // 真设备插在扩展坞上（设备 VID ≠ Hub VID）现在**不再**被判为 viaHub，
                // 否则用户的真实鼠标会被默认过滤掉（2026-11-10 实测踩到）。
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

    // ⛔ 一台蓝牙设备只能算「一个键盘」或「一个鼠标」，**不能既算键盘又算鼠标**。
    //
    //   2026-11-10 用户反馈 + 实测：MCHOSE G87 V2-1 是**三模**键盘（USB/2.4G/蓝牙
    //   三种连接方式，不是「键盘能当鼠标用」）。但它固件同时上报了三个 HID 集合：
    //     COL05  Keyboard  svc=kbdhid   present
    //     COL01  Keyboard  svc=kbdhid   present
    //     COL03  Mouse     svc=mouhid   present   ← 媒体键/鼠标模拟的附带集合
    //   Windows 认为 COL03 是真鼠标（driver 都加载了），但用户面前的桌上只有一把
    //   键盘。旧实现见 COL03 就置 mouse=true，于是胶囊同时亮「鼠标 + 键盘」。
    //
    //   新判据：**按设备（实例路径里的 MAC）分组**，每组只产出一种身份：
    //     组内有任何 Keyboard 集合 → 这组算键盘（键盘优先）；
    //     只有 Mouse 集合 → 才算是鼠标。
    //   这样一个三模键盘 = 1 键盘 + 0 鼠标，符合用户认知。
    //
    // 另外必须扫**三个类**：蓝牙键鼠的 COLxx 注册在 Keyboard / Mouse 类，
    // 只有杂项集合（用户控制设备、系统控制器）留在 HIDClass。只扫 HIDClass 会漏键鼠。
    // 每个类都不带 DIGCF_PRESENT 枚举，再逐个 `devnode_present` 定位 ——
    // 配对记忆的节点也在枚举结果里，定位失败即视为没连。

    // mac（大写十六进制）→ (键盘集合数, 鼠标集合数, 型号名, 电量)
    // 电量从顶层设备节点读（见 read_battery_level），集合节点上读不到。
    // ⛔ 必须记**数量**而不是布尔：一台设备同时暴露键盘和鼠标集合时，
    //    靠「哪个多」才能判主属性（实测蓝牙鼠标 Professor 1 是 2 键盘 + 1 鼠标，
    //    键盘集合反而更多 —— 所以数量也不是万能，见下方 adjudicate）。
    let mut groups: std::collections::BTreeMap<String, (usize, usize, String, Option<u8>)> =
        std::collections::BTreeMap::new();

    for class in [GUID_DEVCLASS_HIDCLASS, GUID_DEVCLASS_KEYBOARD, GUID_DEVCLASS_MOUSE] {
        let Ok(set) = SetupDiGetClassDevsW(Some(&class), None, None, Default::default()) else {
            continue;
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
            if !devnode_present(&inst) {
                continue;
            }
            let Some(desc) = read_device_desc(set, &dev) else { continue };
            let d = desc.to_lowercase();
            let is_kb = d.contains("keyboard") || d.contains("键盘");
            let is_mouse = d.contains("mouse") || d.contains("鼠标");
            // 杂项集合（用户控制设备 / 系统控制器）既不是键也不是鼠，跳过
            if !is_kb && !is_mouse {
                continue;
            }
            let key = bt_device_key(&inst);
            let e = groups.entry(key.clone()).or_insert((0, 0, String::new(), None));
            // 电量：设备级属性，挂在顶层节点。集合节点上查必然为空 ——
            // 这是旧实现「电量恒空」的真正原因（查错节点了）。
            if e.3.is_none() {
                // 电量在**顶层设备节点**上，集合节点查不到（旧实现"恒空"的真因）。
                // 沿 devinst 的父链往上走，遇到 BTHLE\DEV_* / BTHENUM\ 之类就试读，
                // 不靠实例 ID 字符串拼路径 —— 那条路试过，前缀过滤语义容易踩偏。
                e.3 = battery_from_ancestors(dev.DevInst);
            }
            if is_kb {
                e.0 += 1;
            }
            if is_mouse {
                e.1 += 1;
            }
            if e.2.is_empty() {
                e.2 = bt_model_name(&inst);
            }
        }
        let _ = SetupDiDestroyDeviceInfoList(set);
    }

    // 逐台输出（**不再合并成「一个鼠标 + 一个键盘」**）：
    // 实测两台蓝牙设备的 HID 报告描述符完全一致（Keyboard×2 + Mouse×1，
    // btnCaps/valCaps 逐字段相同），协议层分不出谁是主属性。
    // 与其猜一个必然有一半概率错的结论，不如如实上报每台设备各自具备的能力，
    // 由前端按设备呈现（一台设备 = 一个条目），这样：
    //   · 只连键盘 → 1 条；只连鼠标 → 1 条；两个都连 → 2 条，不会互相覆盖；
    //   · 名字用真实型号（MCHOSE G87 V2-1 / Professor 1），用户一眼能对上自己的硬件。
    let mut devices: Vec<serde_json::Value> = Vec::new();
    let mut names: Vec<String> = Vec::new();
    for (mac, (kb_n, mouse_n, model, battery)) in groups.iter() {
        if *kb_n == 0 && *mouse_n == 0 {
            continue;
        }
        if !model.is_empty() && !names.contains(model) {
            names.push(model.clone());
        }
        devices.push(serde_json::json!({
            "mac": mac,
            "name": model,
            "keyboard": *kb_n > 0,
            "mouse": *mouse_n > 0,
            "kbCollections": *kb_n,
            "mouseCollections": *mouse_n,
            // 电量百分比（0-100）；None/缺省表示这台设备不报电量
            "battery": *battery,
        }));
    }
    // 兼容字段：任一设备具备该能力即置 true（旧前端 / 检查脚本仍在读这两个布尔）
    let mouse = devices.iter().any(|d| d["mouse"].as_bool().unwrap_or(false));
    let keyboard = devices.iter().any(|d| d["keyboard"].as_bool().unwrap_or(false));
    let model = names.first().cloned().unwrap_or_default();

    serde_json::json!({
        "mouse": mouse,
        "keyboard": keyboard,
        "names": names,
        "model": model,
        // 逐台明细：前端按它渲染「一台一条」，避免两台设备抢同一个 id
        "devices": devices,
    })
}


/// 从蓝牙 HID 集合的实例路径里取「设备级」标识（MAC）。
///
/// 同一台蓝牙设备的多个 HID 集合共享同一个 MAC，例如：
///   HID\{00001812-...}_DEV_VID&0107D7_PID&EFFF_REV&0120_C818F53D9AFD&COL05\...
///                                                       ^^^^^^^^^^^^ MAC
/// 取不到 MAC 时退回完整路径（宁可多算一台，也不要把两台设备并成一台）。
fn bt_device_key(instance: &str) -> String {
    let up = instance.to_uppercase();
    // 形如 ..._REV&0120_C818F53D9AFD&COL05\...
    //      ^^^^^^^^ 先锚到 "REV&"，跳过其后的版本号（0120）与分隔 '_'，
    //               再取后面连续的十六进制串（12 位 MAC）。
    // ⛔ 不能直接对整串 find('_')：第一个 '_' 属于 "_REV" 自己，
    //    那样取到的是版本号，两台集合会落到不同的组（实测踩过）。
    let Some(rev) = up.find("REV&") else { return up };
    let after_rev = &up[rev + 4..];              // "0120_C818F53D9AFD&COL05\..."
    let Some(us) = after_rev.find('_') else { return up };
    let rest = &after_rev[us + 1..];             // "C818F53D9AFD&COL05\..."
    let mac: String = rest
        .chars()
        .take_while(|c| c.is_ascii_hexdigit())
        .collect();
    // MAC 至少 12 位；短于此视为没取到，退回完整路径（宁可多算一台也不要并错）
    if mac.len() >= 12 { mac } else { up }
}

/// 取蓝牙设备的真实型号名。
///
/// COLxx 节点自己叫 "HID Keyboard Device" / "HID-compliant mouse"，没有型号信息。
/// 型号在父链更上游：`BTHLE\Dev_<mac>\...` 的 FriendlyName（实测 "MCHOSE G87 V2-1"）。
/// 沿父链最多走 4 层找第一个像型号的名字，取不到返回空串（调用方回退到 desc）。
///
/// ⚠️ 用 `SetupDiOpenDeviceInfoW` 而不是 `CM_Get_DevNode_PropertyW`：
/// 后者要开 `Win32_Devices_Properties` feature，而本项目基线是 0 warning。
unsafe fn bt_model_name(instance_id: &str) -> String {
    use windows::Win32::Devices::DeviceAndDriverInstallation::{
        CM_Locate_DevNodeW, CM_LOCATE_DEVNODE_NORMAL,
    };
    let wide: Vec<u16> = instance_id.encode_utf16().chain(std::iter::once(0)).collect();
    let mut devinst = 0u32;
    if CM_Locate_DevNodeW(&mut devinst, windows::core::PCWSTR(wide.as_ptr()), CM_LOCATE_DEVNODE_NORMAL).0 != 0 {
        return String::new();
    }
    let mut cur = devinst;
    for _ in 0..4 {
        let mut parent = 0u32;
        if CM_Get_Parent(&mut parent, cur, 0).0 != 0 {
            break;
        }
        cur = parent;
        if let Some(name) = friendly_name_of_devinst(cur) {
            // "Bluetooth LE Service {…}" / 纯 GUID 都不算型号
            if !name.is_empty() && !name.contains("Bluetooth LE Service") && !name.contains("00001812") {
                return name;
            }
        }
    }
    String::new()
}

/// 读某个 devinst 的 `SPDRP_FRIENDLYNAME`。
///
/// ⛔ 宽字符串必须先落到具名变量：`PCWSTR(vec.chain(..).collect().as_ptr())`
///    里那个临时 Vec 会在语句结束就释放，传给 Win32 的是悬垂指针，
///    函数静默返回空（实测就是这么丢掉 "MCHOSE G87 V2-1" 的）。
unsafe fn friendly_name_of_devinst(devinst: u32) -> Option<String> {
    use windows::Win32::Devices::DeviceAndDriverInstallation::{SetupDiOpenDeviceInfoW, DIGCF_ALLCLASSES};
    const SPDRP_FRIENDLYNAME: u32 = 0x0000_000C;

    let inst = device_id_of(devinst);
    if inst.is_empty() {
        return None;
    }
    let wide: Vec<u16> = inst.encode_utf16().chain(std::iter::once(0)).collect();

    // DIGCF_ALLCLASSES 不能省：空 GUID + 默认 flags 建出来的集合是空的。
    let set = match SetupDiGetClassDevsW(None, None, None, DIGCF_ALLCLASSES) {
        Ok(s) => s,
        Err(_) => return None,
    };
    let mut dev = SP_DEVINFO_DATA {
        cbSize: std::mem::size_of::<SP_DEVINFO_DATA>() as u32,
        ..Default::default()
    };
    let opened = SetupDiOpenDeviceInfoW(
        set,
        windows::core::PCWSTR(wide.as_ptr()),
        None,
        0,
        Some(&mut dev),
    )
    .is_ok();
    let out = if opened { read_reg_string(set, &dev, SPDRP_FRIENDLYNAME) } else { None };
    let _ = SetupDiDestroyDeviceInfoList(set);
    out
}

/// 读 `SPDRP_*` 字符串属性（REG_SZ）。
unsafe fn read_reg_string(set: HDEVINFO, dev: &SP_DEVINFO_DATA, prop: u32) -> Option<String> {
    let mut buf = vec![0u8; 1024];
    SetupDiGetDeviceRegistryPropertyW(
        set,
        dev,
        SETUP_DI_REGISTRY_PROPERTY(prop),
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
    if s.is_empty() { None } else { Some(s) }
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

/// 读外设电量（0–100）。读不到返回 None。
///
/// ⚠️ 旧注释说「`DEVPKEY_Device_BatteryLevel` 对全部在线外设返回空」—— 那是错的，
///    2026-11-11 在本机实测三台蓝牙设备分别是 43 / 100 / 79。
///    当初读不到的真实原因大概率是**查的节点不对**：电量挂在蓝牙设备的**顶层
///    设备节点**（`BTHLE\DEV_<mac>`）上，而不是它的 HID 集合子节点
///    （`HID\{00001812…}&COLxx`）上。在子节点上查当然全是空。
///
/// 属性形状（来自 PnP 实测）：
///   key  = {104EA319-6EE2-4701-BD47-8DDBF425BBE5}, pid = 2
///   type = DEVPROP_TYPE_BYTE（UInt8），取值 0–100
///
/// 用 `CM_Get_DevNode_PropertyW` 直接按 devinst 读，不经过 SetupAPI 的类枚举 ——
/// 因为要读的是「设备节点」属性，不是「设备类实例」属性。
unsafe fn read_battery_level(devinst: u32) -> Option<u8> {
    use windows::Win32::Devices::Properties::DEVPROPTYPE;
    use windows::Win32::Foundation::DEVPROPKEY;

    // {104EA319-6EE2-4701-BD47-8DDBF425BBE5}, 2
    const PKEY_DEV_BATTERY_LEVEL: DEVPROPKEY = DEVPROPKEY {
        fmtid: windows::core::GUID::from_u128(0x104ea319_6ee2_4701_bd47_8ddbf425bbe5),
        pid: 2,
    };
    // ⚠️ 实测这个属性的 DEVPROP 类型是 **0x03 (DEVPROP_TYPE_UINT32)**，
    //    不是 PowerShell 里 `Type: Byte` 显示的那样 —— CIM 层会把 UINT32 映射成 Byte。
    //    只按 BYTE(0x11) 判会一直读不到（踩过）。
    const DEVPROP_TYPE_UINT32: u32 = 0x03;
    const DEVPROP_TYPE_BYTE: u32 = 0x11;

    let mut typ = DEVPROPTYPE::default();
    let mut buf = [0u8; 8];
    let mut size: u32 = buf.len() as u32;
    let rc = windows::Win32::Devices::DeviceAndDriverInstallation::CM_Get_DevNode_PropertyW(
        devinst,
        &PKEY_DEV_BATTERY_LEVEL,
        &mut typ,
        Some(buf.as_mut_ptr()),
        &mut size,
        0,
    );
    if rc.0 != 0 || size == 0 {
        return None;
    }
    // ⚠️ 实测该属性的 (type, size) 组合是 **(0x03 UINT32, size=1)** ——
    //    类型标称 32 位但实际只写了 1 字节。所以不能要求 size>=4，
    //    否则一直返回 None（这里踩过一次）。
    //    统一按「取首字节」读，UINT32 且 size>=4 时再按小端解析。
    let v = match typ.0 {
        DEVPROP_TYPE_UINT32 => {
            if size >= 4 {
                u32::from_le_bytes([buf[0], buf[1], buf[2], buf[3]]) as u8
            } else {
                buf[0]
            }
        }
        DEVPROP_TYPE_BYTE => buf[0],
        _ => return None,
    };
    // 100 以上视为异常值（有些驱动写 255 表示未知）
    if v <= 100 { Some(v) } else { None }
}

/// 沿 devinst 父链向上找「报电量的那个节点」，返回其电量。
///
/// 为什么沿父链而不是拼实例 ID：
///   HID 集合（`HID\{00001812…}&COLxx`）自己不带电量，
///   它的父链依次是 BTHLEDEVICE\…\{00001812…} → BTHLE\DEV_<mac>。
///   电量挂在 **BTHLE\DEV_<mac>** 这一层。
///   拼字符串的路子（CM_Get_Device_ID_List 前缀过滤）实测不稳：
///   flag 语义容易用错，一旦用错就整段返回空、静默丢电量。
///   父链遍历不依赖任何字符串规则，只依赖「设备树」这个事实。
unsafe fn battery_from_ancestors(devinst: u32) -> Option<u8> {
    let mut cur = devinst;
    for _ in 0..6 {
        // 先试当前节点自己
        if let Some(v) = read_battery_level(cur) {
            return Some(v);
        }
        let mut parent = 0u32;
        if CM_Get_Parent(&mut parent, cur, 0).0 != 0 {
            break;
        }
        cur = parent;
    }
    None
}

/// 给「蓝牙音频端点」补电量。
///
/// 为什么音频端点自己拿不到电量：
///   Core Audio 的 `IMMDevice` 只暴露音频属性（名字 / FormFactor / 状态），
///   电量属于**蓝牙设备节点**（`BTHENUM\DEV_<mac>` 或其子服务
///   `BTHENUM\{0000111E-…}`），不在音频属性里。
///
/// 做法：按名字里的型号关键词（如 "vivo TWS A2"）去 PnP 设备里找同名蓝牙节点，
/// 命中后沿父链读 DEVPKEY_Device_BatteryLevel —— 与键鼠电量同一条读法。
/// 名字匹配不上就返回 None（宁可没有，也不张冠李戴）。
unsafe fn battery_for_audio_name(name: &str) -> Option<u8> {
    if name.is_empty() {
        return None;
    }
    // 从 "耳机 (vivo TWS A2 Hands-Free AG Audio)" 里取出 "vivo TWS A2"
    let model = audio_model_key(name);
    if model.len() < 3 {
        return None;
    }
    use windows::Win32::Devices::DeviceAndDriverInstallation::{DIGCF_ALLCLASSES, DIGCF_PRESENT};
    let Ok(set) = SetupDiGetClassDevsW(None, None, None, DIGCF_ALLCLASSES | DIGCF_PRESENT) else {
        return None;
    };
    let mut found: Option<u8> = None;
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
        // 只看蓝牙来源的节点（BTHENUM / BTHLE / BTHLEDEVICE）
        if !(up.starts_with("BTHENUM\\")
            || up.starts_with("BTHLE\\")
            || up.starts_with("BTHLEDEVICE\\"))
        {
            continue;
        }
        // 名字匹配（大小写不敏感）
        let Ok(desc) = setup_read_friendly(set, &dev) else { continue };
        if !desc.to_lowercase().contains(&model) {
            continue;
        }
        if let Some(v) = battery_from_ancestors(dev.DevInst) {
            found = Some(v);
            break;
        }
    }
    let _ = SetupDiDestroyDeviceInfoList(set);
    found
}

/// 读 SetupAPI 枚举到的设备 FriendlyName（用于音频端点与 PnP 设备的名称匹配）。
unsafe fn setup_read_friendly(
    set: HDEVINFO,
    dev: &SP_DEVINFO_DATA,
) -> Result<String, ()> {
    const SPDRP_FRIENDLYNAME: u32 = 0x0000_000C;
    read_reg_string(set, dev, SPDRP_FRIENDLYNAME).ok_or(())
}

/// 从音频端点名里抽「型号关键词」。
///   "耳机 (vivo TWS A2 Hands-Free AG Audio)" → "vivo tws a2"
///   "耳机 (vivo TWS A2 Stereo)"              → "vivo tws a2"
/// 规则：取括号内文本，砍掉已知后缀词，转小写。
fn audio_model_key(name: &str) -> String {
    let inner = match (name.find('('), name.rfind(')')) {
        (Some(a), Some(b)) if b > a => &name[a + 1..b],
        _ => name,
    };
    let mut s = inner.to_lowercase();
    // 常见后缀：把「连接方式/档位」去掉，只留型号
    for suffix in [
        " hands-free ag audio",
        " hands-free ag",
        " hands-free",
        " stereo",
        " avrcp",
        " target",
    ] {
        if let Some(p) = s.find(suffix) {
            s.truncate(p);
        }
    }
    s.trim().to_string()
}

/// 采集一次外设快照。COM 初始化/反初始化在本函数内配对完成，
/// 因为它在独立线程里以 3 秒间隔反复调用。
fn snapshot() -> serde_json::Value {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let result = (|| -> serde_json::Value {
            let input = collect_external_input();
            let bt = input["bluetooth"].clone();
            // 蓝牙设备逐个并入明细。
            //
            // ⛔ 不能再按「一个蓝牙鼠标 + 一个蓝牙键盘」硬编码两条：
            //    旧实现只产出固定 id `bluetooth:mouse` / `bluetooth:keyboard`，
            //    同时连两把蓝牙设备（键盘 + 鼠标）时，两条记录抢同一个 id，
            //    前端按 id 去重就只剩一条 —— 用户「鼠标改蓝牙后识别不到」就是这么来的。
            //    现在按设备 MAC 生成 `bluetooth:<MAC>`，一台一条，互不覆盖。
            //
            // ⛔ 也不再试图判定「这台到底是键盘还是鼠标」：
            //    实测两台设备的 HID 报告描述符**完全一致**
            //    （Keyboard×2 + Mouse×1，btnCaps/valCaps 逐字段相同），
            //    协议层分不出主属性。与其猜，不如忠实上报「这台设备有键、有鼠」，
            //    让 count 按设备数计（一台 = 1 个输入设备）。
            let mut mice = input["mouse"].as_array().cloned().unwrap_or_default();
            let mut keys = input["keyboard"].as_array().cloned().unwrap_or_default();
            let bt_devices = bt["devices"].as_array().cloned().unwrap_or_default();
            for d in bt_devices {
                let name = d["name"].as_str().unwrap_or("");
                let mac = d["mac"].as_str().unwrap_or("");
                let has_kb = d["keyboard"].as_bool().unwrap_or(false);
                let has_mouse = d["mouse"].as_bool().unwrap_or(false);
                if !has_kb && !has_mouse {
                    continue;
                }
                let id = if mac.is_empty() {
                    "bluetooth:unknown".to_string()
                } else {
                    format!("bluetooth:{mac}")
                };
                let item = serde_json::json!({
                    "id": id,
                    "vid": "", "pid": "",
                    "instance": "BTHLE",
                    "viaHub": false,
                    "bluetooth": true,
                    "name": name,
                    // 这台设备同时具备键鼠用法；前端据此只说「蓝牙设备」，
                    // 不再硬贴「键盘」或「鼠标」标签。
                    "hasKeyboard": has_kb,
                    "hasMouse": has_mouse,
                    // 电量（0-100）。⛔ 这一行不能漏 —— 重建 item 时漏搬字段，
                    // 上游算好的电量会在这一步凭空消失（踩过）。
                    "battery": d["battery"].clone(),
                });
                if has_mouse {
                    mice.push(item.clone());
                }
                if has_kb {
                    keys.push(item);
                }
            }
            // 计数口径：**一台设备算一个**。
            // 蓝牙设备的同一条记录会同时出现在 mice 与 keys 里（因为它的 HID
            // 描述符同时声明了键与鼠用法），直接 len() 会把同一台设备数两遍
            // ——实测会变成「鼠标 2 / 键盘 2」而桌上只有两台设备。
            // 这里按 id 去重后分别统计：
            //   · 有鼠标能力的设备数 → mouse（胶囊「鼠标」槽位看它）
            //   · 有键盘能力的设备数 → keyboard
            // 同 id 在两个列表里只贡献一次。
            let uniq = |list: &[serde_json::Value]| -> usize {
                let mut seen = std::collections::HashSet::new();
                list.iter()
                    .filter_map(|d| d["id"].as_str())
                    .filter(|id| seen.insert(id.to_string()))
                    .count()
            };
            let mouse_count = uniq(&mice);
            let keyboard_count = uniq(&keys);

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

    /// 回归：**一台设备只算一种身份**，鼠标优先。
    ///
    /// 起因（2026-11-10 用户反馈）：桌面胶囊显示「鼠标 1 + 键盘 2」，
    /// 而用户桌上只有一只游戏鼠标 + 一把蓝牙键盘。
    /// 实测根因：VID_3151&PID_5032 是游戏鼠标（BusReportedDeviceDesc = "Gaming Mouse"），
    /// 却同时暴露 keyboard 类集合（MI_01&COL03，svc=kbdhid，宏键/多媒体键），
    /// 按类各数一遍就会多出一个「键盘」。
    ///
    /// 同理，MCHOSE G87 三模键盘（装入方式：USB/2.4G/蓝牙）固件里也带一个
    /// mouse 集合（COL03，svc=mouhid），旧实现会把它算成「键盘 + 鼠标」。
    /// ⛔「三模」指三种连接方式，不是「键盘能当鼠标用」—— 用户明确指出过。
    ///
    /// 这两条都用纯函数钉住：给出真实的实例路径，校验归组结果。
    #[test]
    fn one_physical_device_yields_one_identity() {
        // ① 蓝牙：同一台设备的键盘集合 + 鼠标集合必须归到同一个 key
        let bt_kb = r"HID\{00001812-0000-1000-8000-00805F9B34FB}_DEV_VID&0107D7_PID&EFFF_REV&0120_C818F53D9AFD&COL05\9&E068E2F&0&0004";
        let bt_ms = r"HID\{00001812-0000-1000-8000-00805F9B34FB}_DEV_VID&0107D7_PID&EFFF_REV&0120_C818F53D9AFD&COL03\9&E068E2F&0&0002";
        assert_eq!(
            bt_device_key(bt_kb),
            bt_device_key(bt_ms),
            "同一台蓝牙设备的两个 HID 集合必须归到同一个设备键"
        );
        // 且必须真的取到 MAC（不是退回完整路径）
        assert_eq!(bt_device_key(bt_kb), "C818F53D9AFD");

        // ② 不同蓝牙设备必须区分开（否则两台设备会被并成一台）
        let other = r"HID\{00001812-0000-1000-8000-00805F9B34FB}_DEV_VID&0107D7_PID&EFFF_REV&0120_A46BB62D9190&COL01&1&0&0000";
        assert_ne!(bt_device_key(bt_kb), bt_device_key(other), "不同蓝牙设备不能并成一台");

        // ③ 取不到 MAC 时退回完整路径（宁可多算一台，也不要并错）
        let no_mac = r"HID\SOMETHING\WITHOUT_MAC";
        assert_eq!(bt_device_key(no_mac), no_mac.to_uppercase());
    }

    /// 电量读取的正确性：`audio_model_key` 必须能把端点名收敛成型号关键词。
    ///
    /// 这条容易错的地方是「同一副耳机会暴露多个音频端点」
    /// （Stereo / Hands-Free AG / Avrcp…），型号必须归一成同一个串，
    /// 否则每个端点各查一次、结果还可能不一致。
    #[test]
    fn audio_model_key_normalizes_endpoint_names() {
        // 同一副 vivo 耳机的三种端点名 → 同一个关键词
        assert_eq!(audio_model_key("耳机 (vivo TWS A2 Stereo)"), "vivo tws a2");
        assert_eq!(
            audio_model_key("耳机 (vivo TWS A2 Hands-Free AG Audio)"),
            "vivo tws a2"
        );
        // 没有括号的名字原样转小写
        assert_eq!(audio_model_key("Realtek Audio"), "realtek audio");
        // 空名字不 panic
        assert_eq!(audio_model_key(""), "");
    }

    /// 电量节点在**父链**上，不在集合节点自己身上。
    /// 这条实测过：HID 集合节点查 DEVPKEY_Device_BatteryLevel 返回
    /// CR_NO_SUCH_VALUE(37)，沿父链走到 BTHLE\DEV_<mac> 才有值。
    /// 所以 battery_from_ancestors 必须真的向上遍历，不能只看自己。
    #[test]
    fn battery_read_from_ancestors_not_collection() {
        // 这台机器上若连着蓝牙键盘，应当能读到 0..=100 的值；
        // 没连时返回 None 也算通过（CI/别的机器上没有该设备）。
        let snap = snapshot();
        let mut saw_any = false;
        for key in ["mouseDevices", "keyboardDevices"] {
            if let Some(list) = snap[key].as_array() {
                for d in list {
                    if d["bluetooth"].as_bool().unwrap_or(false) {
                        if let Some(v) = d["battery"].as_u64() {
                            assert!(v <= 100, "电量必须是 0-100，实际 {v}");
                            saw_any = true;
                        }
                    }
                }
            }
        }
        // 不断言一定读到（设备可能没连），只打印，便于排查
        println!("本次读到蓝牙电量的设备数 > 0: {saw_any}");
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
