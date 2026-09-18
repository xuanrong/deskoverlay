// DeskOverlay 前端工作台 — 启动装配。
// 范式：侧边导航 + 固定主区域单模块切换（无拖拽面板、无工作模式）。
// 状态：统一由 state.js 单例管理，Rust 侧 state.json 持久化。
import { MODULES } from "./config.js";
import { state, loadState, saveState, pushRecentOp } from "./state.js";
import { Bus, invoke } from "./bus.js";
import { Providers } from "./providers.js";
import { VIEW_RENDERERS } from "./views.js";
import { initPlayback } from "./views/music.js";
import { Tasks } from "./tasks.js";
import { CommandBar } from "./commandbar.js";
import { initReminders } from "./reminders.js";
import { initPomodoro, startPomodoroNow, ICON_TOMATO } from "./pomodoro.js";
import { startLockController } from "./lock.js";
import { initPlugins, onPluginsChanged } from "./plugins.js";
import { Theme } from "./theme.js";
import { ICON_CHECK, ICON_EXTERNAL } from "./icons.js";
import { toast } from "./toast.js";
import { pillFor, lunarText, lunarShort, getDayEvents, holidayOf, workdayOf } from "./festivals.js";

// -------------------- 视图包装 --------------------
class View {
  constructor(root, moduleId) {
    root.innerHTML = `<div class="view"><div class="view-header"></div><div class="view-body"></div></div>`;
    this.moduleId = moduleId;
    this.header = root.querySelector(".view-header");
    this.body = root.querySelector(".view-body");
    this._destroyers = [];
  }
  onDestroy(fn) { this._destroyers.push(fn); }
  // 记录当前滚动位置到导航状态（切换/重启后恢复）
  saveScroll() {
    if (!state.navState) state.navState = {};
    if (!state.navState[this.moduleId]) state.navState[this.moduleId] = {};
    state.navState[this.moduleId].scrollTop = this.body.scrollTop || 0;
  }
  // 恢复上次滚动位置（视图内容渲染完成后调用）
  restoreScroll() {
    const st = state.navState?.[this.moduleId]?.scrollTop;
    if (typeof st === "number" && st > 0) this.body.scrollTop = st;
  }
  destroy() {
    this.saveScroll();
    this._destroyers.forEach((f) => { try { f(); } catch (e) {} });
    this._destroyers = [];
  }
}

// -------------------- 导航 + 模块切换 --------------------
const navList = document.getElementById("nav-list");
const viewContainer = document.getElementById("view-container");
let currentView = null;

function renderNav() {
  navList.innerHTML = MODULES.map((m) => `
    <div class="nav-item${m.id === state.currentModule ? " active" : ""}" data-module="${m.id}">
      <span class="ni-icon">${m.icon}</span>
      <span class="ni-title">${m.title}</span>
    </div>`).join("");
  navList.querySelectorAll(".nav-item").forEach((el) => {
    el.addEventListener("click", () => switchModule(el.dataset.module));
  });
}

function switchModule(id) {
  if (!VIEW_RENDERERS[id]) return;
  state.currentModule = id;
  saveState();
  navList.querySelectorAll(".nav-item").forEach((el) => {
    el.classList.toggle("active", el.dataset.module === id);
  });
  if (currentView) currentView.destroy();
  currentView = new View(viewContainer, id);
  VIEW_RENDERERS[id](currentView);
  // 内容渲染完成后恢复该模块上次的滚动位置（异步渲染的视图也能生效）
  requestAnimationFrame(() => currentView?.restoreScroll());
}

// 插件集合变化（添加/移除）后重建导航
onPluginsChanged(() => renderNav());

// -------------------- 快速指令条 --------------------
function buildCommands() {
  const cmds = [];
  for (const m of MODULES) {
    cmds.push({
      id: "mod-" + m.id,
      icon: m.icon,
      title: "切换到：" + m.title,
      sub: "侧边导航定位",
      keywords: "module nav 切换 " + m.id + " " + m.title,
      run: () => switchModule(m.id),
    });
  }
  cmds.push({
    id: "pomo-start",
    icon: ICON_TOMATO,
    title: "番茄钟：开始一轮专注",
    sub: "25 分钟专注倒计时 · 顶栏胶囊可暂停",
    keywords: "pomodoro 番茄钟 专注 focus timer 计时",
    run: () => { if (startPomodoroNow()) toast("番茄钟已开始"); else toast("番茄钟正在进行中"); },
  });
  cmds.push({
    id: "add-task",
    icon: ICON_CHECK,
    title: "添加待办",
    sub: "输入内容后回车，或用 「>内容」快速添加",
    keywords: "task 任务 待办 add todo",
    run: (text) => {
      if (text) { Tasks.add({ text }); switchModule("dashboard"); toast("已添加待办"); }
      else { CommandBar.open(">"); }
    },
  });
  const apps = [
    { name: "Figma", url: "https://figma.com" },
    { name: "GitHub", url: "https://github.com" },
    { name: "VS Code", url: "vscode://" },
  ];
  for (const a of apps) {
    cmds.push({
      icon: ICON_EXTERNAL, title: "启动：" + a.name,
      sub: "打开 " + a.url,
      keywords: "launch open 启动 " + a.name,
      run: () => { window.open(a.url, "_blank"); toast("启动 " + a.name); },
    });
  }
  return cmds;
}

CommandBar.init({
  barEl: document.getElementById("command-bar"),
  inputEl: document.getElementById("cb-input"),
  resultsEl: document.getElementById("cb-results"),
  commands: buildCommands(),
  onClose: () => {},
});

// -------------------- 启动 Provider --------------------
Providers.startAll();

// -------------------- 主区域顶部时钟块（固定，所有模块之上） --------------------
const mcTime = document.getElementById("mc-time");
const mcDate = document.getElementById("mc-date");
const mcFest = document.getElementById("mc-fest");

// 节日/节气/假期药丸：仅当天信息变化时更新；点击弹出详情面板
function refreshFestival() {
  if (!mcFest) return;
  const p = pillFor(new Date());
  if (mcFest.dataset.key !== p.text) {
    mcFest.dataset.key = p.text;
    mcFest.textContent = p.text;
    mcFest.className = ("mc-fest " + (p.cls || "")).trim();
    mcFest.title = p.tip || "";
    mcFest.hidden = !p.text;
  }
}

const WEEK_CN = "日一二三四五六";
const fmtMD = (d) => `${d.getMonth() + 1}月${d.getDate()}日`;
let festPanelEl = null;
let festView = null; // 当前查看的月份（1 号）
function showFestivalPanel() {
  if (festPanelEl) { festPanelEl.remove(); festPanelEl = null; return; }
  const now = new Date();
  festView = new Date(now.getFullYear(), now.getMonth(), 1);
  const ov = document.createElement("div");
  ov.className = "task-modal-overlay";
  festPanelEl = ov;
  ov.innerHTML = `
    <div class="task-modal festival-modal">
      <h3 class="cal-head">
        <button class="cal-nav" id="cal-prev" title="上个月">‹</button>
        <span id="cal-title"></span>
        <button class="cal-nav" id="cal-next" title="下个月">›</button>
      </h3>
      <div class="cal-week">${["日", "一", "二", "三", "四", "五", "六"].map((w) => `<span>${w}</span>`).join("")}</div>
      <div class="cal-grid" id="cal-grid"></div>
      <div class="cal-legend">
        <span><i class="lg-dot lg-hol"></i>法定假期</span>
        <span><i class="lg-dot lg-work"></i>调休补班</span>
        <span><i class="lg-dot lg-fest"></i>节日</span>
        <span><i class="lg-dot lg-term"></i>节气</span>
      </div>
      <div class="tm-actions"><button class="btn-primary cm-ok">关闭</button></div>
    </div>`;
  document.body.appendChild(ov);
  const draw = () => {
    const y = festView.getFullYear(), m = festView.getMonth();
    ov.querySelector("#cal-title").textContent = `${y}年${m + 1}月`;
    const offset = new Date(y, m, 1).getDay(); // 周日=0（周日为一周之始）
    const days = new Date(y, m + 1, 0).getDate();
    let html = "";
    for (let i = 0; i < offset; i++) html += `<div class="cal-cell empty"></div>`;
    for (let d = 1; d <= days; d++) {      const dt = new Date(y, m, d);
      const hol = holidayOf(dt);
      const wd = workdayOf(dt);
      const evs = getDayEvents(dt).filter((e) => e.type === "festival" || e.type === "term");
      const isToday = dt.toDateString() === now.toDateString();
      // 小字：节日 > 节气 > 农历（农历只在初一显示月名且加粗，其余只显示日）
      let sub = lunarShort(dt), subCls = "lunar" + (sub.endsWith("月") ? " month" : "");
      const fest = evs.find((e) => e.type === "festival");
      if (fest) { sub = fest.name; subCls = "festival"; }
      else if (evs.length) { sub = evs[0].name; subCls = "term"; }
      const tips = [`${m + 1}月${d}日 周${WEEK_CN[dt.getDay()]} · 农历${lunarText(dt)}`];
      if (evs.length) tips.push(evs.map((e) => e.name).join("、"));
      if (hol) tips.push(`${hol.name}假期（${fmtMD(hol.start)} - ${fmtMD(hol.end)}，共${hol.days}天）`);
      if (wd) tips.push("调休补班日");
      html += `<div class="cal-cell${hol ? " holiday" : ""}${wd ? " workday" : ""}${isToday ? " today" : ""}" title="${tips.join(" · ")}">
        ${hol ? '<span class="cal-tag tag-hol">休</span>' : wd ? '<span class="cal-tag tag-work">班</span>' : ""}
        <span class="cal-day">${d}</span>
        <span class="cal-sub ${subCls}">${sub}</span>
      </div>`;
    }
    // 尾部补空格至 42 格（固定 6 行）：弹窗高度不随月份周数变化
    for (let i = offset + days; i < 42; i++) html += `<div class="cal-cell empty"></div>`;
    ov.querySelector("#cal-grid").innerHTML = html;
  };
  ov.querySelector("#cal-prev").addEventListener("click", () => { festView = new Date(festView.getFullYear(), festView.getMonth() - 1, 1); draw(); });
  ov.querySelector("#cal-next").addEventListener("click", () => { festView = new Date(festView.getFullYear(), festView.getMonth() + 1, 1); draw(); });
  const close = () => { ov.remove(); festPanelEl = null; };
  ov.querySelector(".cm-ok").addEventListener("click", close);
  ov.addEventListener("click", (e) => { if (e.target === ov) close(); });
  ov.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
  draw();
}

Bus.on("provider-emit", ({ config_hash, output }) => {
  if (config_hash !== "clock") return;
  // 仅在值变化时写 DOM，避免每秒无条件赋值触发多余重排
  const time = output.time || "--:--:--";
  const date = output.date || "";
  if (mcTime.textContent !== time) mcTime.textContent = time;
  if (mcDate.textContent !== date) {
    mcDate.textContent = date;
    refreshFestival(); // 日期进入新一天时同步刷新节日/节气/假期药丸
  }
});

refreshFestival();
mcFest?.addEventListener("click", showFestivalPanel);

// 久坐提醒弹出：记入最近操作，便于回溯。
Bus.on("sedentary-fire", () => {
  pushRecentOp({ type: "sedentary", action: "提醒弹出", name: "久坐提醒" });
});


// -------------------- 事件绑定 --------------------
window.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.code === "Space") {
    e.preventDefault();
    CommandBar.toggle();
  }
});
window.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  const help = document.getElementById("help-overlay");
  if (help && !help.hidden) help.hidden = true;
});
document.getElementById("nav-quit").addEventListener("click", () => {
  if (window.__TAURI__ || window.__TAURI_INTERNALS__) {
    invoke("quit_app").catch(() => { try { window.close(); } catch (_) {} });
  } else {
    toast("桌面态可按 Esc 退出");
  }
});
document.getElementById("help-close").addEventListener("click", () => {
  document.getElementById("help-overlay").hidden = true;
});

// -------------------- 滚动条自动隐藏（滚动时显示，停止后隐藏） --------------------
let scrollHideTimer = null;
document.addEventListener("scroll", (e) => {
  const el = e.target === document ? document.documentElement : e.target;
  if (!el || !el.classList) return;
  el.classList.add("scrolling");
  clearTimeout(scrollHideTimer);
  scrollHideTimer = setTimeout(() => {
    document.querySelectorAll(".scrolling").forEach((n) => n.classList.remove("scrolling"));
  }, 500);
}, true);

// -------------------- 导航栏折叠/展开 --------------------
const navToggle = document.getElementById("nav-toggle");
function applyNavCollapsed(collapsed) {
  document.body.classList.toggle("nav-collapsed", collapsed);
  if (!navToggle) return;
  navToggle.title = collapsed ? "展开导航" : "折叠导航";
  const label = navToggle.querySelector("span");
  if (label) label.textContent = collapsed ? "展开" : "收起";
  const svg = navToggle.querySelector("svg");
  if (svg) {
    svg.innerHTML = collapsed
      ? '<path d="M10 5l7 7-7 7"/>'
      : '<path d="M14 5l-7 7 7 7"/><path d="M20 5l-7 7 7 7"/>';
  }
}
navToggle.addEventListener("click", () => {
  const collapsed = !document.body.classList.contains("nav-collapsed");
  if (!state.settings) state.settings = {};
  state.settings.navCollapsed = collapsed;
  saveState();
  applyNavCollapsed(collapsed);
});

// -------------------- 启动 --------------------
// 异步初始化状态，就绪后加载外部插件、渲染导航与当前模块
loadState().then(async () => {
  // 主题系统：最先应用（在任何模块渲染前把方案/token/背景写好，避免闪切）
  try { await Theme.init(); } catch (e) { console.warn("[theme] 初始化失败，使用默认深色", e); }
  // 恢复导航栏折叠状态
  applyNavCollapsed(!!state.settings?.navCollapsed);
  // 先加载启用的外部插件（如微信读书），使插件模块注册进导航，再切初始模块（否则初始模块若是插件会找不到）
  await initPlugins();
  renderNav();
  // 启动进入的模块：默认回到「今日概览」；设置允许记住上次所在模块
  const remember = state.settings?.rememberModule !== false;
  const last = MODULES.some((m) => m.id === state.currentModule) ? state.currentModule : "dashboard";
  const initial = remember ? last : "dashboard";
  switchModule(initial);

  // 恢复音乐播放状态（队列/歌曲/播放位置）
  initPlayback();

  // 提醒：渲染时钟块倒计时 + 每秒检查
  initReminders();

  // 番茄钟：时钟条胶囊常驻 + 秒级倒计时/到期推进
  initPomodoro();

  // 隐私锁定：离开设定时长后全屏遮罩
  startLockController();

  console.log("[DeskOverlay] 工作台已就绪 · 模块:", state.currentModule);
});
