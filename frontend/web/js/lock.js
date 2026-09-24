// 隐私锁定：监测空闲，离开设定时长后弹出全屏遮罩防偷看。
// Tauri 正式环境使用系统级置顶窗口（lock.html）显示旋转星空；
// 浏览器开发态回退到页面内浮层，视觉与 lock.html 保持一致（星空场景见 lockScene.js）。
import { state } from "./state.js";
import { Heartbeat, invoke } from "./bus.js";
import { startSkyAnim } from "./lockScene.js";

let lastActive = Date.now();
let globalIdleMs = -1; // 由后端 system-idle 提供全局空闲毫秒（Tauri）
let audioPlaying = false; // 是否有音频/视频正在播放（同由 system-idle 事件提供，后端每 3 秒枚举一次）
let intervalId = null;
let locked = false;

const ACTIVITY_EVENTS = ["mousemove", "mousedown", "keydown", "touchstart", "scroll"];

function onActivity() { lastActive = Date.now(); }

function injectLockStyles() {
  if (document.getElementById("lock-fallback-style")) return;
  const style = document.createElement("style");
  style.id = "lock-fallback-style";
  style.textContent = `
    .lock-overlay {
      position: fixed; inset: 0; z-index: 2147483000;
      display: flex; align-items: center; justify-content: center;
      background:
        radial-gradient(circle at 50% 50%, rgba(30, 45, 72, 0.55) 0%, rgba(8, 12, 20, 0.95) 55%, #020305 100%);
      overflow: hidden;
      opacity: 0; transition: opacity 0.3s ease;
    }
    .lock-overlay.show { opacity: 1; }
    .lock-fb-sky { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
    .lock-fb-sun {
      position: absolute; left: 50%; top: 50%;
      translate: -50% -50%;
      width: 15vmin; height: 15vmin; min-width: 96px; min-height: 96px;
      border-radius: 50%; cursor: pointer; z-index: 10;
      background: radial-gradient(circle at 35% 35%, #fff7d1 0%, #ffcc33 25%, #ff9933 55%, #c44e1c 100%);
      box-shadow: 0 0 40px 8px rgba(255,180,60,0.55), 0 0 90px 24px rgba(255,130,30,0.28), inset -8px -8px 30px rgba(120,40,10,0.45);
      animation: lockFbSunPulse 3.2s ease-in-out infinite alternate;
      transition: filter 0.2s ease, box-shadow 0.2s ease;
    }
    .lock-fb-sun:hover { filter: brightness(1.15); box-shadow: 0 0 55px 14px rgba(255,190,70,0.7), 0 0 120px 36px rgba(255,140,40,0.38), inset -8px -8px 30px rgba(120,40,10,0.45); }
    .lock-fb-sun:active { filter: brightness(0.95); }
    @keyframes lockFbSunPulse {
      0% { transform: translate(-50%, -50%) scale(1); filter: brightness(1); }
      100% { transform: translate(-50%, -50%) scale(1.04); filter: brightness(1.1); }
    }
    .lock-fb-hint {
      position: absolute; left: 50%; bottom: 7vh;
      translate: -50% 0;
      text-align: center; color: rgba(230,237,243,0.8);
      pointer-events: none; z-index: 10;
    }
    .lock-fb-hint h1 { margin: 0; font-size: clamp(18px, 2.4vmin, 28px); font-weight: 700; letter-spacing: 1px; text-shadow: 0 2px 14px rgba(0,0,0,0.6); }
  `;
  document.head.appendChild(style);
}

function buildOverlay() {
  injectLockStyles();
  const ov = document.createElement("div");
  ov.id = "lock-overlay";
  ov.className = "lock-overlay";
  ov.innerHTML = `
    <canvas class="lock-fb-sky"></canvas>
    <div class="lock-fb-sun" role="button" aria-label="解锁" title="解锁"></div>
    <div class="lock-fb-hint">
      <h1>离开一会儿，马上回来</h1>
    </div>`;
  startSkyAnim(ov.querySelector(".lock-fb-sky"));
  ov.querySelector(".lock-fb-sun").addEventListener("click", unlock);
  return ov;
}

// 页面内遮罩回退：仅在浏览器开发态有实际防护意义。
// 打包版主窗口已注入 WorkerW 成为「桌面本身」，该遮罩会被任何前台应用盖住，
// 因此它不能替代系统级锁屏窗口——建窗失败的正解是后端重试（见 show_lock）。
function showLock() {
  if (document.getElementById("lock-overlay")) return;
  const ov = buildOverlay();
  document.body.appendChild(ov);
  requestAnimationFrame(() => ov.classList.add("show"));
}

// 触发锁屏：Tauri 用系统级置顶窗口；浏览器开发态用页面内浮层
async function doLock() {
  locked = true;
  const tauri = window.__TAURI__ || window.__TAURI_INTERNALS__;
  if (tauri && tauri.core && typeof tauri.core.invoke === "function") {
    try {
      // show_lock 无返回值（建窗是异步的，命令立即返回），因此不能按返回值判断成败。
      // 后端建窗重试 3 次仍失败时会推 lock-failed，由 startLockController 里的监听器
      // 重置 locked，让空闲心跳下一轮继续尝试。
      await tauri.core.invoke("show_lock");
      return;
    } catch (_) { /* 命令调用本身失败：落到本地浮层 */ }
  }
  showLock();
}

function unlock() {
  const ov = document.getElementById("lock-overlay");
  if (ov) { ov.classList.remove("show"); setTimeout(() => ov.remove(), 300); }
  locked = false;
  lastActive = Date.now();
}

function tick() {
  if (locked) return;
  const cfg = state.lock;
  if (!cfg || !cfg.enabled) return;
  // 正在播放音频/视频时不视为离开，不锁定（audioPlaying 由后端 system-idle 事件推送）
  if (audioPlaying) return;
  const minutes = Math.min(120, Math.max(1, cfg.minutes || 5));
  // 优先用全局空闲（任何应用无操作才算空闲）；浏览器开发态退回本地事件估算
  const idleMs = globalIdleMs >= 0 ? globalIdleMs : (Date.now() - lastActive);
  if (idleMs >= minutes * 60000) {
    doLock();
  }
}

// 将锁屏开关推送给后端：未启用时后端降频轮询（暂停音频枚举与空闲事件推送），避免常驻空转。
// 浏览器开发态 invoke 回退 Bus 模拟，无副作用。
export function pushLockEnabled() {
  invoke("set_lock_monitor_enabled", { enabled: !!(state.lock && state.lock.enabled) }).catch(() => {});
}

export function startLockController() {
  ACTIVITY_EVENTS.forEach((e) => window.addEventListener(e, onActivity, { passive: true }));
  document.addEventListener("visibilitychange", () => { if (!document.hidden) lastActive = Date.now(); });
  // 空闲检测走统一秒级心跳
  intervalId = Heartbeat.on(tick);
  // 推送初始开关状态（loadState 已完成，state.lock 就绪）
  pushLockEnabled();
  // 后端全局空闲事件：无论在哪应用操作都刷新；
  // audioPlaying 同源消费（后端每 3 秒枚举一次音频会话），替代前端 invoke 轮询的重复枚举
  if ((window.__TAURI__ || window.__TAURI_INTERNALS__) && window.__TAURI__?.event?.listen) {
    window.__TAURI__.event.listen("system-idle", (e) => {
      const p = e?.payload || {};
      if (typeof p.idleMs === "number") globalIdleMs = p.idleMs;
      if (typeof p.audioPlaying === "boolean") audioPlaying = p.audioPlaying;
    }).catch(() => {});
    // 系统级锁屏窗口解锁后，重置主窗口的锁定状态
    window.__TAURI__.event.listen("lock-hide", () => {
      locked = false;
      lastActive = Date.now();
      globalIdleMs = -1;
    }).catch(() => {});
    // 系统级锁屏建窗失败（后端已重试 3 次）：必须重置 locked，否则 tick() 会被
    // `if (locked) return` 永久拦住，锁定功能在本进程内彻底失效。
    // 重置后空闲计时从头开始，下一轮仍会重试。
    window.__TAURI__.event.listen("lock-failed", () => {
      locked = false;
      lastActive = Date.now();
    }).catch(() => {});
  }
}