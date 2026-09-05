// 番茄钟小组件 —— 常驻于主区域顶部时钟条（main-clock），位于提醒列表之前。
// 交互：胶囊点击展开浮层；胶囊内右侧按钮一键 开始/暂停；到期系统提醒。
// 状态机：focus → (short | long @第4轮) → focus；跳过=切下一阶段但不计完成。
// 持久化：state.pomodoro（含 endsAt，重启后 running 状态可续跑）。
import { state, saveState, pushRecentOp } from "./state.js";
import { Heartbeat, invoke } from "./bus.js";
import { esc } from "./views/common.js";

// ---------- 常量与工具 ----------
const C = 106.8; // 环周长（r=17）
const MODE_MIN = (p) => (p.mode === "short" ? p.shortMin : p.mode === "long" ? p.longMin : p.focusMin);
const MODE_NAME = { focus: "专注", short: "短休", long: "长休" };
const MODE_COLOR = { focus: "#ff7b72", short: "#3fb950", long: "#39c5cf" };
const PAUSE_COLOR = "#d29922";
const ICON_PLAY = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.2v13.6L19 12 8 5.2z"/></svg>`;
const ICON_PAUSE = `<svg viewBox="0 0 24 24" fill="currentColor"><rect x="7.2" y="5.4" width="3.4" height="13.2" rx="1.1" fill="currentColor"/><rect x="13.4" y="5.4" width="3.4" height="13.2" rx="1.1" fill="currentColor"/></svg>`;
const ICON_TOMATO = `<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="14.5" r="7" fill="#ff7b72" stroke="none"/><path d="M12 7.5C10.6 5.6 8.3 5 6.5 5.4c.9 2.6 3.2 3.6 5.5 3.6s4.6-1 5.5-3.6c-1.8-.4-4.1.2-5.5 2.1z" fill="#3fb950" stroke="none"/></svg>`;
const ICON_GEAR = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="12" cy="12" r="3.1"/><path d="M12 2.9v2.3M12 18.8v2.3M2.9 12h2.3M18.8 12h2.3M5.7 5.7l1.6 1.6M16.7 16.7l1.6 1.6M18.3 5.7l-1.6 1.6M7.3 16.7l-1.6 1.6"/></svg>`;
export { ICON_TOMATO };

// 配置项：范围与步进（时长分钟 / 目标轮数）
const CFG = {
  focusMin: { min: 1, max: 120, step: 5, label: "专注时长" },
  shortMin: { min: 1, max: 60, step: 1, label: "短休时长" },
  longMin: { min: 1, max: 120, step: 5, label: "长休时长" },
  goal: { min: 1, max: 30, step: 1, label: "每日目标" },
};

function todayKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function fmtMs(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

// ---------- DOM ----------
let pomoEl = null; // 胶囊容器
let popEl = null; // 浮层容器
let opened = false;
let closePop = null;

function ensureToday() {
  const k = todayKey();
  if (state.pomodoro.date !== k) {
    state.pomodoro.date = k;
    state.pomodoro.done = 0;
    state.pomodoro.minutes = 0;
  }
}

// 剩余毫秒（未运行：暂停剩余；未开始为 0 → 视为整段）
function remainMs() {
  const p = state.pomodoro;
  if (p.running) return Math.max(0, p.endsAt - Date.now());
  const full = MODE_MIN(p) * 60000;
  return p.pausedRemain > 0 ? p.pausedRemain : full;
}
function fullMs() {
  return MODE_MIN(state.pomodoro) * 60000;
}
// 已完成比例（0-1）
function elapsedRatio() {
  const full = fullMs();
  return Math.min(1, Math.max(0, (full - remainMs()) / full));
}
function accent() {
  const p = state.pomodoro;
  return p.running ? MODE_COLOR[p.mode] : PAUSE_COLOR;
}

// ---------- 渲染 ----------
// ratio = 剩余占比（0~1）。弧长 = ratio × 周长：满环起步、随倒计时递减收缩，归零=本段完成。
function setArc(ratio) {
  const arc = pomoEl.querySelector(".pomo-arc");
  if (!arc) return;
  const r = Math.max(0, Math.min(1, ratio));
  const len = r * C;
  arc.style.strokeDasharray = `${len.toFixed(2)} ${C}`;
  arc.style.stroke = accent();
  arc.style.opacity = len > 0.5 ? "1" : "0";
}

function subText() {
  const p = state.pomodoro;
  const nm = MODE_NAME[p.mode];
  if (p.running) {
    if (p.mode === "focus") return `${nm}中 · 第 ${p.cycleCount + 1} 轮`;
    return p.mode === "long" ? "长休息 · 放松一下" : "短休息 · 放松一下";
  }
  const started = p.pausedRemain > 0 && p.pausedRemain < fullMs() - 500;
  if (started) return "已暂停 · 待继续";
  return `${nm} · 点击开始`;
}

function renderCapsule() {
  const p = state.pomodoro;
  const timeEl = pomoEl.querySelector(".pomo-time");
  const subEl = pomoEl.querySelector(".pomo-sub");
  const actEl = pomoEl.querySelector(".pomo-act");
  const full = fullMs();
  const remain = remainMs();
  if (timeEl) timeEl.textContent = fmtMs(remain);
  if (subEl) subEl.textContent = subText();
  if (actEl) {
    actEl.innerHTML = p.running ? ICON_PAUSE : ICON_PLAY;
    actEl.title = p.running ? "暂停" : "开始";
  }
  setArc(p.running || remain < full ? remain / full : 0);
  pomoEl.dataset.running = p.running ? "1" : "0";
  pomoEl.title = `番茄钟 · ${esc(subText())} · ${fmtMs(remain)}`;
  // 跨日/浮层统计刷新
  if (popEl) renderPopover();
}

function renderPopover() {
  const p = state.pomodoro;
  const accentCol = accent();
  popEl.style.setProperty("--accent", accentCol);
  // rgb 分量供 active 底色使用
  const rgb = hexToRgb(accentCol);
  popEl.style.setProperty("--accent-rgb", rgb);

  // 今日统计
  const todayEl = popEl.querySelector(".pomo-pop-today");
  if (todayEl) todayEl.textContent = `今日 ${p.done} / ${p.goal}`;

  // 时长按钮
  popEl.querySelectorAll(".pomo-seg button").forEach((b) => {
    b.classList.toggle("active", b.dataset.mode === p.mode);
    b.style.display = "";
  });
  const lbl = (key) => popEl.querySelector(`[data-min="${key}"]`);
  const fEl = lbl("focus"), sEl = lbl("short"), lEl = lbl("long");
  if (fEl) fEl.textContent = p.focusMin;
  if (sEl) sEl.textContent = p.shortMin;
  if (lEl) lEl.textContent = p.longMin;

  // 大倒计时 + 进度条 + 说明
  const remain = remainMs();
  const full = fullMs();
  const bigEl = popEl.querySelector(".pomo-big");
  if (bigEl) bigEl.textContent = fmtMs(remain);
  const fillEl = popEl.querySelector(".pomo-bar-fill");
  if (fillEl) fillEl.style.width = `${(remain / full) * 100}%`;
  const subEl = popEl.querySelector(".pomo-subrow");
  if (subEl) {
    if (p.running) {
      subEl.textContent = p.mode === "focus"
        ? `${MODE_NAME[p.mode]}中 · 第 ${p.cycleCount + 1} 轮 · ${p.focusMin} 分钟`
        : `休息中 · ${MODE_NAME[p.mode]} ${p.mode === "long" ? p.longMin : p.shortMin} 分钟`;
    } else {
      const started = p.pausedRemain > 0 && p.pausedRemain < full - 500;
      subEl.textContent = started
        ? `已暂停 · ${MODE_NAME[p.mode]}剩余 ${fmtMs(remain)}`
        : `等待开始 · ${MODE_NAME[p.mode]} ${Math.round(full / 60000)} 分钟`;
    }
  }

  // 主按钮文案
  const main = popEl.querySelector(".pomo-main");
  if (main) {
    main.textContent = p.running ? "暂停一下" : (p.pausedRemain > 0 && p.pausedRemain < full - 500 ? "继续" : `开始${MODE_NAME[p.mode]}`);
  }

  // 配置区数值同步
  const cfgEl = popEl.querySelector(".pomo-config");
  if (cfgEl) {
    for (const k of Object.keys(CFG)) {
      const valEl = cfgEl.querySelector(`[data-v="${k}"]`);
      if (valEl) valEl.textContent = p[k];
    }
    const autoEl = cfgEl.querySelector("#pm-auto");
    if (autoEl) autoEl.checked = !!p.autoNext;
  }
}

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
}

// ---------- 行为 ----------
function start() {
  const p = state.pomodoro;
  ensureToday();
  if (p.running) return;
  p.running = true;
  const full = fullMs();
  p.pausedRemain = p.pausedRemain > 0 ? p.pausedRemain : full;
  p.endsAt = Date.now() + p.pausedRemain;
  saveState();
  renderCapsule();
}
function pause() {
  const p = state.pomodoro;
  if (!p.running) return;
  p.pausedRemain = Math.max(0, p.endsAt - Date.now());
  p.running = false;
  p.endsAt = 0;
  saveState();
  renderCapsule();
}
function toggle() {
  state.pomodoro.running ? pause() : start();
}

// 切换模式（重设整段时长、停止）
function setMode(mode) {
  const p = state.pomodoro;
  if (!["focus", "short", "long"].includes(mode) || p.mode === mode) return;
  p.mode = mode;
  p.running = false;
  p.endsAt = 0;
  p.pausedRemain = 0;
  saveState();
  renderCapsule();
}

// 阶段结束：complete=true 表示正常走完（专注计一轮）；skip 则直接进入下一阶段
function advance(complete) {
  const p = state.pomodoro;
  ensureToday();
  if (p.mode === "focus") {
    if (complete) {
      p.done += 1;
      p.minutes += p.focusMin;
      p.totalDone += 1;
      p.cycleCount += 1;
      pushRecentOp({ type: "pomodoro", action: "完成专注", name: `番茄钟 · 完成第 ${p.done} 轮` });
    }
    const next = p.cycleCount % 4 === 0 ? "long" : "short";
    p.mode = next;
    notify(next === "long" ? "已完成 4 轮专注，进入长休息吧" : "本轮专注完成，休息一下吧", "focus");
  } else {
    p.mode = "focus";
    notify("休息结束，开始新一轮专注吧", "break");
  }
  p.running = false;
  p.endsAt = 0;
  p.pausedRemain = 0;
  saveState();
  renderCapsule();
  // 自然结束时若开启「自动开始下一阶段」则立即进入（跳过不计入自动开始）
  if (complete && state.pomodoro.autoNext) start();
}

// 阶段到期/结束 → 系统提醒（桌面态走 Rust，浏览器态用页面 toast）
function notify(msg, kind) {
  const title = kind === "focus" ? "专注完成" : "休息结束";
  const icon = kind === "focus"
    ? `<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="14.5" r="7" fill="#ff7b72"/><path d="M12 7.5C10.6 5.6 8.3 5 6.5 5.4c.9 2.6 3.2 3.6 5.5 3.6s4.6-1 5.5-3.6c-1.8-.4-4.1.2-5.5 2.1z" fill="#3fb950"/></svg>`
    : `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.2v13.6L19 12 8 5.2z"/></svg>`;
  if (window.__TAURI__) {
    invoke("show_reminder", { icon, title: `番茄钟 · ${title}`, message: msg }).catch(() => {});
    return;
  }
  const t = document.createElement("div");
  t.className = "rm-toast";
  t.innerHTML = `
    <span class="rm-toast-icon">${icon}</span>
    <div class="rm-toast-body"><b>${esc(title)}</b><span>${esc(msg)}</span></div>
    <button class="rm-toast-ok">知道了</button>`;
  document.body.appendChild(t);
  requestAnimationFrame(() => t.classList.add("show"));
  const close = () => { t.classList.remove("show"); setTimeout(() => t.remove(), 300); };
  t.querySelector(".rm-toast-ok").addEventListener("click", close);
  t.addEventListener("click", (e) => { if (e.target === t) close(); });
  clearTimeout(t._timer);
  t._timer = setTimeout(close, 8000);
}

// ---------- 浮层开关 ----------
function openPopup(anchor) {
  if (popEl.hidden === false) return;
  const r = anchor.getBoundingClientRect();
  popEl.hidden = false;
  popEl.style.top = `${Math.round(r.bottom + 8)}px`;
  // 右侧与胶囊右缘对齐（避免盖到更右的提醒区之外）
  popEl.style.left = "";
  popEl.style.right = `${Math.round(window.innerWidth - r.right)}px`;
  renderPopover();
  opened = true;
}
function closePopup() {
  if (!popEl || popEl.hidden) return;
  popEl.hidden = true;
  opened = false;
}

// ---------- 秒级心跳：到期检测 + 倒计时刷新 ----------
function tick() {
  const p = state.pomodoro;
  if (p.running && Date.now() >= p.endsAt) {
    advance(true);
    return;
  }
  renderCapsule();
}

function togglePopup() {
  if (opened) { closePopup(); return; }
  openPopup(pomoEl);
}

// 供指令条等外部入口「一键开始/继续」；已在运行则忽略。
export function startPomodoroNow() {
  const p = state.pomodoro;
  if (p.running) return false;
  start();
  return true;
}

// ---------- 初始化 ----------
export function initPomodoro() {
  ensureToday();
  const remindersEl = document.getElementById("mc-reminders");
  const clockEl = document.getElementById("main-clock");

  // 胶囊结构
  pomoEl = document.createElement("div");
  pomoEl.id = "mc-pomo";
  pomoEl.className = "mc-pomo";
  pomoEl.setAttribute("role", "button");
  pomoEl.tabIndex = 0;
  pomoEl.innerHTML = `
    <svg class="pomo-ring" width="40" height="40" viewBox="0 0 40 40" fill="none" aria-hidden="true">
      <circle class="pomo-track" cx="20" cy="20" r="17"/>
      <circle class="pomo-arc" cx="20" cy="20" r="17" transform="rotate(-90 20 20)"/>
    </svg>
    <div class="pomo-meta">
      <div class="pomo-time">25:00</div>
      <div class="pomo-sub">专注 · 点击开始</div>
    </div>
    <button class="pomo-act" title="开始"></button>`;

  // 浮层结构（懒挂载到 body）
  popEl = document.createElement("div");
  popEl.id = "pomo-pop";
  popEl.className = "pomo-pop";
  popEl.hidden = true;
  popEl.innerHTML = `
    <div class="pomo-pop-head">
      <span class="pomo-pop-title">${ICON_TOMATO}番茄钟</span>
      <span class="pomo-pop-right">
        <span class="pomo-pop-today">今日 0 / 8</span>
        <button class="pomo-gear" id="pomo-gear" title="时长与目标">${ICON_GEAR}</button>
      </span>
    </div>
    <div class="pomo-config" id="pomo-config" hidden>
      <div class="pomo-cfg-row"><span>专注时长</span><span class="pomo-stepper"><button type="button" data-k="focusMin" data-d="-1">−</button><b data-v="focusMin">25</b><button type="button" data-k="focusMin" data-d="1">+</button></span></div>
      <div class="pomo-cfg-row"><span>短休时长</span><span class="pomo-stepper"><button type="button" data-k="shortMin" data-d="-1">−</button><b data-v="shortMin">5</b><button type="button" data-k="shortMin" data-d="1">+</button></span></div>
      <div class="pomo-cfg-row"><span>长休时长</span><span class="pomo-stepper"><button type="button" data-k="longMin" data-d="-1">−</button><b data-v="longMin">15</b><button type="button" data-k="longMin" data-d="1">+</button></span></div>
      <div class="pomo-cfg-row"><span>每日目标（轮）</span><span class="pomo-stepper"><button type="button" data-k="goal" data-d="-1">−</button><b data-v="goal">8</b><button type="button" data-k="goal" data-d="1">+</button></span></div>
      <div class="pomo-cfg-row"><span>自动开始下一阶段</span><label class="pm-check"><input type="checkbox" id="pm-auto" /></label></div>
    </div>
    <div class="pomo-seg">
      <button data-mode="focus" class="active">专注 <b data-min="focus">25</b></button>
      <button data-mode="short">短休 <b data-min="short">5</b></button>
      <button data-mode="long">长休 <b data-min="long">15</b></button>
    </div>
    <div class="pomo-big">25:00</div>
    <div class="pomo-bar"><div class="pomo-bar-fill"></div></div>
    <div class="pomo-subrow">等待开始 · 专注 25 分钟</div>
    <div class="pomo-actions">
      <button class="btn btn-primary pomo-main">开始专注</button>
      <button class="btn pomo-skip">跳过本轮</button>
    </div>
    <div class="pomo-hint">到点自动提醒 · Esc 关闭浮层</div>`;

  clockEl.insertBefore(pomoEl, remindersEl);
  document.body.appendChild(popEl);

  // 事件：胶囊（开/关浮层）、右侧按钮（开始/暂停）、浮层操作
  pomoEl.addEventListener("click", togglePopup);
  pomoEl.querySelector(".pomo-act").addEventListener("click", (e) => { e.stopPropagation(); toggle(); });
  pomoEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); togglePopup(); }
  });

  popEl.querySelector(".pomo-seg").addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (btn) setMode(btn.dataset.mode);
  });
  popEl.querySelector(".pomo-main").addEventListener("click", toggle);
  popEl.querySelector(".pomo-skip").addEventListener("click", () => advance(false));

  // 配置面板：展开/收起
  popEl.querySelector("#pomo-gear").addEventListener("click", () => {
    const cfg = popEl.querySelector("#pomo-config");
    cfg.hidden = !cfg.hidden;
    popEl.querySelector("#pomo-gear").classList.toggle("active", !cfg.hidden);
    if (!cfg.hidden) renderPopover();
  });
  // 时长/目标步进
  popEl.querySelector("#pomo-config").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-k]");
    if (!btn) return;
    const key = btn.dataset.k;
    const c = CFG[key];
    const p = state.pomodoro;
    if (!c) return;
    const next = Math.max(c.min, Math.min(c.max, (p[key] ?? c.min) + c.step * (Number(btn.dataset.d) || 0)));
    if (next === p[key]) return;
    p[key] = next;
    // 若修改的是「当前空闲模式」的时长，整段自动按新时长展示（未开始时 pausedRemain=0 即整段）
    if (!p.running && key === p.mode + "Min") p.pausedRemain = 0;
    saveState();
    renderCapsule();
  });
  // 自动开始下一阶段开关
  popEl.querySelector("#pm-auto").addEventListener("change", (e) => {
    state.pomodoro.autoNext = e.target.checked;
    saveState();
    renderPopover();
  });

  // 关闭：点击外部 / Esc / 窗口变化
  const onDocDown = (e) => {
    if (opened && !popEl.contains(e.target) && !pomoEl.contains(e.target)) closePopup();
  };
  const onKey = (e) => {
    if (e.key === "Escape" && opened) closePopup();
  };
  const onResize = () => { if (opened) closePopup(); };
  document.addEventListener("pointerdown", onDocDown, true);
  document.addEventListener("keydown", onKey, true);
  window.addEventListener("resize", onResize);

  // 应用关闭时不必解绑；启动即渲染并进入秒级心跳
  renderCapsule();
  Heartbeat.on(tick);
}
