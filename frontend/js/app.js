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
import { ICON_CHECK, ICON_EXTERNAL } from "./icons.js";

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

// -------------------- toast --------------------
function toast(msg) {
  let t = document.getElementById("do-toast");
  if (!t) {
    t = document.createElement("div");
    t.id = "do-toast";
    t.style.cssText = "position:fixed;left:50%;bottom:60px;transform:translateX(-50%);z-index:12000;background:rgba(14,18,26,.92);border:1px solid var(--border-strong);color:var(--text);padding:10px 18px;border-radius:12px;font-size:13px;box-shadow:var(--shadow);backdrop-filter:blur(18px);transition:opacity .2s;";
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.style.opacity = "1";
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.style.opacity = "0"; }, 1800);
}

// -------------------- 启动 Provider --------------------
Providers.startAll();

// -------------------- 主区域顶部时钟块（固定，所有模块之上） --------------------
const mcTime = document.getElementById("mc-time");
const mcDate = document.getElementById("mc-date");
Bus.on("provider-emit", ({ config_hash, output }) => {
  if (config_hash === "clock") {
    mcTime.textContent = output.time || "--:--:--";
    mcDate.textContent = output.date || "";
  }
});

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
  if (help && !help.hidden) { help.hidden = true; return; }
  if (window.__TAURI__ || window.__TAURI_INTERNALS__) {
    invoke("quit_app").catch(() => { try { window.close(); } catch (_) {} });
  }
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

// -------------------- 启动 --------------------
// 异步初始化状态，就绪后渲染导航与当前模块
loadState().then(() => {
  renderNav();
  const initial = MODULES.some((m) => m.id === state.currentModule) ? state.currentModule : "dashboard";
  switchModule(initial);

  // 恢复音乐播放状态（队列/歌曲/播放位置）
  initPlayback();

  // 提醒：渲染时钟块倒计时 + 每秒检查
  initReminders();

  console.log("[DeskOverlay] 工作台已就绪 · 模块:", state.currentModule);
});
