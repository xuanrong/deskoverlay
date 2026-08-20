// 隐私锁定：监测空闲，离开设定时长后弹出全屏遮罩防偷看。
// 遮罩中央是一棵会随着锁定时间慢慢长大的树。
import { state } from "./state.js";

let lastActive = Date.now();
let globalIdleMs = -1; // 由后端 system-idle 提供全局空闲毫秒（Tauri）
let audioPlaying = false; // 是否有音频/视频正在播放
let intervalId = null;
let locked = false;
let growRaf = 0;

const ACTIVITY_EVENTS = ["mousemove", "mousedown", "keydown", "touchstart", "scroll"];
const GROW_MS = 12000; // 树从萌发到长成的时间（毫秒）

function onActivity() { lastActive = Date.now(); }

function buildOverlay() {
  const ov = document.createElement("div");
  ov.id = "lock-overlay";
  ov.className = "lock-overlay";
  ov.innerHTML = `
    <div class="lock-card">
      <svg class="lock-tree" viewBox="0 0 120 132" aria-hidden="true">
        <ellipse class="lt-ground" cx="60" cy="124" rx="40" ry="7"/>
        <path class="lt-trunk" d="M60 124 C 58 96 57 76 60 56 C 63 76 62 96 60 124 Z"/>
        <g class="lt-branch bl">
          <path d="M59 82 C 42 78 28 70 22 58 C 34 62 46 66 59 70 Z"/>
          <circle cx="14" cy="54" r="8"/>
        </g>
        <g class="lt-branch br">
          <path d="M61 68 C 78 64 92 56 98 44 C 86 48 74 52 61 56 Z"/>
          <circle cx="106" cy="48" r="8"/>
        </g>
        <g class="lt-canopy">
          <circle cx="60" cy="34" r="26" class="c1"/>
          <circle cx="34" cy="46" r="16" class="c2"/>
          <circle cx="86" cy="46" r="16" class="c2"/>
          <circle cx="46" cy="22" r="13" class="c2"/>
          <circle cx="74" cy="22" r="13" class="c2"/>
          <circle cx="60" cy="48" r="15" class="c3"/>
        </g>
        <g class="lt-orb">
          <circle cx="52" cy="30" r="2.4"/>
          <circle cx="68" cy="26" r="2.4"/>
          <circle cx="42" cy="42" r="2.2"/>
          <circle cx="78" cy="40" r="2.2"/>
        </g>
      </svg>
      <div class="lock-msg">
        <div class="lock-title">屏幕已锁定</div>
        <div class="lock-sub">为保护隐私，工作台内容已暂时隐藏</div>
        <button class="btn-primary lock-unlock">主人确认解锁</button>
      </div>
    </div>`;
  ov.querySelector(".lock-unlock").addEventListener("click", unlock);
  return ov;
}

// 树随时间长大：线性推进 --g / --gc（树干 → 树冠）
function growIn(ov) {
  const card = ov.querySelector(".lock-card");
  card.style.setProperty("--g", 0);
  card.style.setProperty("--gc", 0);
  const start = performance.now();
  const step = () => {
    const p = Math.min(1, (performance.now() - start) / GROW_MS);
    card.style.setProperty("--g", p.toFixed(3));
    const gc = p <= 0.15 ? 0 : Math.min(1, (p - 0.15) / 0.85);
    card.style.setProperty("--gc", gc.toFixed(3));
    if (p < 1) growRaf = requestAnimationFrame(step);
    else growRaf = 0;
  };
  growRaf = requestAnimationFrame(step);
}

function cancelGrow() {
  if (growRaf) { cancelAnimationFrame(growRaf); growRaf = 0; }
}

function showLock() {
  if (document.getElementById("lock-overlay")) return;
  const ov = buildOverlay();
  document.body.appendChild(ov);
  requestAnimationFrame(() => ov.classList.add("show"));
  growIn(ov);
}

// 触发锁屏：Tauri 用系统级置顶窗口；浏览器开发态用页面内浮层
async function doLock() {
  locked = true;
  const tauri = window.__TAURI__ || window.__TAURI_INTERNALS__;
  if (tauri && tauri.core && typeof tauri.core.invoke === "function") {
    try { await tauri.core.invoke("show_lock"); return; } catch (_) { /* 回退本地浮层 */ }
  }
  showLock();
}

function unlock() {
  const ov = document.getElementById("lock-overlay");
  if (ov) { ov.classList.remove("show"); setTimeout(() => ov.remove(), 300); }
  cancelGrow();
  locked = false;
  lastActive = Date.now();
}

function tick() {
  if (locked) return;
  const cfg = state.lock;
  if (!cfg || !cfg.enabled) return;
  const minutes = Math.min(120, Math.max(1, cfg.minutes || 5));
  // 正在播放音频/视频时不视为离开，不锁定
  if (audioPlaying) return;
  // 优先用全局空闲（任何应用无操作才算空闲）；浏览器开发态退回本地事件估算
  const idleMs = globalIdleMs >= 0 ? globalIdleMs : (Date.now() - lastActive);
  if (idleMs >= minutes * 60000) {
    doLock();
  }
}

export function startLockController() {
  ACTIVITY_EVENTS.forEach((e) => window.addEventListener(e, onActivity, { passive: true }));
  document.addEventListener("visibilitychange", () => { if (!document.hidden) lastActive = Date.now(); });
  intervalId = setInterval(tick, 1000);
  // 后端全局空闲事件：无论在哪应用操作都刷新
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
  }
}

export function stopLockController() {
  clearInterval(intervalId);
  intervalId = null;
  ACTIVITY_EVENTS.forEach((e) => window.removeEventListener(e, onActivity));
  cancelGrow();
}