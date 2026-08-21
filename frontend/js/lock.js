// 隐私锁定：监测空闲，离开设定时长后弹出全屏遮罩防偷看。
// Tauri 正式环境使用系统级置顶窗口（lock.html）显示旋转星空；
// 浏览器开发态回退到页面内浮层，视觉与 lock.html 保持一致。
import { state } from "./state.js";
import { Heartbeat } from "./bus.js";

let lastActive = Date.now();
let globalIdleMs = -1; // 由后端 system-idle 提供全局空闲毫秒（Tauri）
let audioPlaying = false; // 是否有音频/视频正在播放
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

// 一套行星+星星参数，与 lock.html 的 lockpage.js 保持一致
const LOCK_PLANETS = [
  { rx: 0.20, ry: 0.106, speed: 0.02, dir: 1, r: 0.0125, a0: 0.0, colors: ["#9cc4e6", "#3d5f82", "#1f2c3d"], ring: false },
  { rx: 0.26, ry: 0.138, speed: 0.015, dir: -1, r: 0.015, a0: 1.8, colors: ["#ffe6b8", "#d9a95e", "#7a4e1e"], ring: false },
  { rx: 0.32, ry: 0.166, speed: 0.012, dir: 1, r: 0.017, a0: 3.6, colors: ["#5fb0dc", "#2d7fb8", "#11395e"], ring: false },
  { rx: 0.37, ry: 0.192, speed: 0.0095, dir: -1, r: 0.014, a0: 5.1, colors: ["#f0a073", "#a05028", "#5a2a12"], ring: false },
  { rx: 0.435, ry: 0.224, speed: 0.0075, dir: 1, r: 0.023, a0: 1.1, colors: ["#f0d4a4", "#c48a5a", "#8a5a2a"], ring: false },
  { rx: 0.50, ry: 0.255, speed: 0.006, dir: -1, r: 0.021, a0: 4.4, colors: ["#f2e6c2", "#c9ad7a", "#7a5c30"], ring: true },
  { rx: 0.565, ry: 0.286, speed: 0.005, dir: 1, r: 0.016, a0: 2.4, colors: ["#b8ecec", "#5aa8b8", "#2a6080"], ring: false },
  { rx: 0.62, ry: 0.315, speed: 0.004, dir: -1, r: 0.016, a0: 0.6, colors: ["#6aa6e8", "#2a4a9c", "#101f5e"], ring: false },
];
const LOCK_STAR_COUNT = 260;

// 启动星空 canvas 动画，返回取消函数
function startSkyAnim(canvas, planetsRef) {
  const ctx = canvas.getContext("2d");
  let dpr = 1, W = 0, H = 0, cx = 0, cy = 0;
  let stars = [];
  let raf = 0;

  function resize() {
    dpr = Math.max(1, window.devicePixelRatio || 1);
    W = canvas.clientWidth || window.innerWidth;
    H = canvas.clientHeight || window.innerHeight;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.width = W + "px";
    canvas.style.height = H + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cx = W / 2;
    cy = H / 2;
    stars = [];
    for (let i = 0; i < LOCK_STAR_COUNT; i++) {
      stars.push({
        x: Math.random() * W, y: Math.random() * H,
        r: Math.random() < 0.85 ? 0.5 + Math.random() * 0.8 : 1.2 + Math.random() * 1.4,
        base: 0.25 + Math.random() * 0.6, tw: 1.5 + Math.random() * 3.5, ph: Math.random() * Math.PI * 2,
      });
    }
  }

  function drawCircle(px, py, radius, stops) {
    const g = ctx.createRadialGradient(px - radius * 0.35, py - radius * 0.35, radius * 0.1, px, py, radius);
    g.addColorStop(0, stops[0]);
    g.addColorStop(0.55, stops[1]);
    g.addColorStop(1, stops[2]);
    ctx.beginPath();
    ctx.arc(px, py, radius, 0, Math.PI * 2);
    ctx.fillStyle = g;
    ctx.fill();
  }

  function frame(now) {
    const t = now / 1000;
    ctx.clearRect(0, 0, W, H);
    for (const s of stars) {
      const a = s.base + Math.sin(t * s.tw + s.ph) * 0.35;
      ctx.globalAlpha = Math.max(0, Math.min(1, a));
      ctx.fillStyle = "#fff";
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // 星系核心辉光
    const coreR = 0.13 * Math.min(W, H);
    const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR);
    core.addColorStop(0, "rgba(255,215,150,0.35)");
    core.addColorStop(0.5, "rgba(255,170,110,0.12)");
    core.addColorStop(1, "rgba(255,150,90,0)");
    ctx.fillStyle = core;
    ctx.beginPath();
    ctx.arc(cx, cy, coreR, 0, Math.PI * 2);
    ctx.fill();

    ctx.lineWidth = 1;
    for (const p of planetsRef) {
      ctx.strokeStyle = "rgba(255,255,255,0.10)";
      ctx.beginPath();
      ctx.ellipse(cx, cy, p.rx * Math.min(W, H), p.ry * Math.min(W, H), 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.save();
    for (const p of planetsRef) {
      const x = cx + Math.cos(p.a0) * p.rx * Math.min(W, H);
      const y = cy + Math.sin(p.a0) * p.ry * Math.min(W, H);
      const rad = p.r * Math.min(W, H);
      if (p.ring) {
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(-0.35);
        ctx.strokeStyle = "rgba(235,220,180,0.45)";
        ctx.lineWidth = Math.max(1.5, rad * 0.28);
        ctx.beginPath();
        ctx.ellipse(0, 0, rad * 1.7, rad * 0.55, 0, 0, Math.PI * 2);
        ctx.stroke();
        ctx.strokeStyle = "rgba(235,220,180,0.28)";
        ctx.lineWidth = Math.max(1, rad * 0.15);
        ctx.beginPath();
        ctx.ellipse(0, 0, rad * 2.1, rad * 0.7, 0, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
      drawCircle(x, y, rad, p.colors);
      ctx.save();
      ctx.translate(x, y);
      ctx.globalAlpha = 0.10;
      for (let k = -1; k <= 1; k++) {
        ctx.beginPath();
        ctx.ellipse(0, k * rad * 0.4, rad * 0.95, rad * 0.22, 0, Math.PI, Math.PI * 2);
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = Math.max(0.6, rad * 0.08);
        ctx.stroke();
      }
      ctx.restore();
    }
    ctx.restore();
    for (const p of planetsRef) p.a0 += p.speed * 0.3 * p.dir;
    raf = requestAnimationFrame(frame);
  }

  resize();
  window.addEventListener("resize", resize);
  raf = requestAnimationFrame(frame);
  return () => {
    cancelAnimationFrame(raf);
    window.removeEventListener("resize", resize);
  };
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
      <h1>屏幕已锁定</h1>
    </div>`;
  startSkyAnim(ov.querySelector(".lock-fb-sky"), LOCK_PLANETS);
  ov.querySelector(".lock-fb-sun").addEventListener("click", unlock);
  return ov;
}

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
      // show_lock 返回是否真正展示了系统级锁屏窗口；false 或调用失败则回退页面内遮罩
      const shown = await tauri.core.invoke("show_lock");
      if (shown !== false) return;
    } catch (_) { /* 命令失败：落到本地浮层 */ }
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
  // 空闲检测走统一秒级心跳
  intervalId = Heartbeat.on(tick);
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
  // intervalId 现在是 Heartbeat.on 返回的取消函数（而非定时器 id）
  if (typeof intervalId === "function") intervalId();
  else if (intervalId) clearInterval(intervalId);
  intervalId = null;
  ACTIVITY_EVENTS.forEach((e) => window.removeEventListener(e, onActivity));
}
