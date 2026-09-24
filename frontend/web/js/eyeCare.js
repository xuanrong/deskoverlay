// 全局护眼 —— 前端控制器。
//
// 定位：**只做「配置 ↔ Rust」的桥接与状态同步**，不做任何视觉处理。
// 真正的色彩调节发生在显卡 Gamma 查找表（src-tauri/src/eyecare.rs），
// 对整机所有应用生效 —— 本文件不碰 CSS，也不该碰。
//
// 为什么需要这一层而不是设置页直接 invoke：
//   1. 启动时要从 state 恢复配置（设置页可能从未打开过）；
//   2. 守护线程的 eyecare-overridden / eyecare-failed 事件需要全局监听，
//      否则「被其他应用覆盖后夺回」「驱动屏蔽导致未生效」用户完全无感知；
//   3. 多处入口（设置页滑杆 / 顶栏胶囊 / 指令条）共用同一套推送与节流逻辑。
import { invoke, Bus } from "./bus.js";
import { state, saveState } from "./state.js";

/// 推送节流：拖滑杆时 input 事件触发极频繁，而单次 SetDeviceGammaRamp
/// 在部分硬件上需 200ms（官方文档），逐次调用会明显卡顿。
/// 80ms 节流 = 每秒最多 12 次，拖动仍跟手，且不会堆积调用。
const PUSH_THROTTLE_MS = 80;

let pushTimer = 0;
let pendingPush = null;

/// 后端返回的真实状态：{ enabled, kelvin, brightness, contrast, active }
/// 与 state.eyeCare（用户意图）分开维护 —— 两者可能不一致：
/// 配置 enabled=true 但 active=false 表示「已开启但未生效」（驱动屏蔽 / HDR 模式），
/// UI 必须能区分这两种情况，不能假装成功。
let backendStatus = null;

const listeners = new Set();

/// 订阅状态变化（设置页与顶栏胶囊据此刷新显示）。
export function onEyeCareChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify() {
  for (const fn of listeners) {
    try { fn({ config: state.eyeCare, status: backendStatus }); } catch (_) { /* 单个订阅者异常不影响其他 */ }
  }
}

/// 取后端真实状态（供 UI 判断「是否真的生效」）。
export function getEyeCareStatus() {
  return backendStatus;
}

/// 把 state.eyeCare 推送到 Rust。opts.immediate=true 时跳过节流（用于开关切换，
/// 需要即时反馈）；拖滑杆则走节流。
async function pushEyeCare(opts = {}) {
  const ec = state.eyeCare;
  const args = {
    enabled: !!ec.enabled,
    kelvin: ec.kelvin,
    // Rust 侧接收的是系数（0.5–1.0），前端存的是百分比，此处换算
    brightness: ec.brightness / 100,
    contrast: ec.contrast / 100,
    // —— 时段模式 ——
    mode: ec.mode,
    dayKelvin: ec.dayKelvin,
    nightKelvin: ec.nightKelvin,
    from: ec.from,
    to: ec.to,
    transitionMin: ec.transitionMin,
  };

  const doPush = async () => {
    try {
      await invoke("set_eyecare_config", args);
      await refreshEyeCareStatus();
    } catch (e) {
      // 命令抛错 = 写入未生效（驱动屏蔽 / HDR / 非主屏）。
      // 必须让用户看见：否则表现为「开关打开了但屏幕没变」，最难排查。
      console.warn("[eyeCare] 配置推送失败：", e);
      backendStatus = { ...args, active: false, error: String(e && e.message || e) };
      Bus.emit("eye-care:error", backendStatus);
    }
    notify();
  };

  if (opts.immediate) {
    clearTimeout(pushTimer);
    pushTimer = 0;
    pendingPush = null;
    return doPush();
  }

  // 节流：最后一次调用保证被执行（尾触发），避免松手后停在中间值
  pendingPush = doPush;
  if (pushTimer) return;
  pushTimer = setTimeout(() => {
    pushTimer = 0;
    const fn = pendingPush;
    pendingPush = null;
    if (fn) fn();
  }, PUSH_THROTTLE_MS);
}

/// 查询后端真实状态并广播。
export async function refreshEyeCareStatus() {
  try {
    backendStatus = await invoke("eyecare_status");
  } catch (_) {
    backendStatus = null;
  }
  notify();
  return backendStatus;
}

/// 更新配置并推送（设置页/胶囊/指令条统一入口）。
export async function setEyeCare(partial, opts = {}) {
  Object.assign(state.eyeCare, partial);
  saveState();
  notify(); // 先本地反馈，再等后端确认
  return pushEyeCare(opts);
}

/// 一键开/关。
export function toggleEyeCare() {
  return setEyeCare({ enabled: !state.eyeCare.enabled }, { immediate: true });
}

/// 恢复显示器原始色彩（修图/调色等需要准确色彩的场合）。
/// 语义是「本次护眼结束」：Rust 侧会把 enabled 置 false 并还原原始 ramp。
export async function restoreNativeColor() {
  try {
    await invoke("restore_native_color");
  } catch (e) {
    console.warn("[eyeCare] 恢复原色失败：", e);
  }
  state.eyeCare.enabled = false;
  saveState();
  await refreshEyeCareStatus();
}

// ────────────────────────── 初始化 ──────────────────────────

/// 启动时调用（loadState 之后）。从 state 恢复配置并推送，
/// 使「上次开着护眼 → 重启后自动生效」，无需用户再点一次。
export async function initEyeCare() {
  // 守护线程发现 ramp 被外部覆盖 → 已自动夺回，这里只刷新 UI 状态
  Bus.on("eyecare-overridden", () => { refreshEyeCareStatus(); });
  // 守护线程写入失败（驱动屏蔽 / HDR）→ 让 UI 能显示「未生效」
  Bus.on("eyecare-failed", () => { refreshEyeCareStatus(); });

  // 启动推送：即便 enabled=false 也推一次，让 Rust 侧配置与 state 对齐
  // （避免 Rust 默认值 4500/0.9/0.95 与 state 里的用户值不一致）
  await pushEyeCare({ immediate: true });
}
