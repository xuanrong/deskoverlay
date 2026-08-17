// DeskOverlay 前端工作台 — 启动装配。
// 装配: 配置 → 面板引擎 → Provider 数据网格 → 工作模式 → 快速指令条 → 持久化。
import { DESKTOP_CONFIG, MODES } from "./config.js";
import { Store } from "./store.js";
import { Bus } from "./bus.js";
import { Providers } from "./providers.js";
import { PanelManager } from "./panel.js";
import { PANEL_RENDERERS } from "./panels.js";
import { Tasks } from "./tasks.js";
import { CommandBar } from "./commandbar.js";
import { Workspaces } from "./workspaces.js";

const workspaceEl = document.getElementById("workspace");

let state = Store.load();
// 首次启动: 用默认布局初始化
if (!state.panels) {
  state.panels = structuredClone(DESKTOP_CONFIG.panels);
}

// 轻量 toast
function toast(msg) {
  let t = document.getElementById("do-toast");
  if (!t) {
    t = document.createElement("div");
    t.id = "do-toast";
    t.style.cssText = "position:fixed;left:50%;bottom:90px;transform:translateX(-50%);z-index:12000;background:rgba(14,18,26,.92);border:1px solid var(--border-strong);color:var(--text);padding:10px 18px;border-radius:12px;font-size:13px;box-shadow:var(--shadow);backdrop-filter:blur(18px);transition:opacity .2s;";
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.style.opacity = "1";
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.style.opacity = "0"; }, 1800);
}

// ---------------- 面板管理器 ----------------
const pm = new PanelManager(workspaceEl, {
  onLayoutChange(layout) {
    state.panels = layout;
    lastLayout = layout;
    Store.save(state);
  },
  onPanelRemoved(id) {
    state.panels = state.panels.filter((p) => p.id !== id);
    const def = lastLayout?.find((p) => p.id === id);
    if (def && !state.closedPanels.find((c) => c.id === id)) state.closedPanels.push(def);
    Store.save(state);
  },
  onPanelAdded(id) {
    state.closedPanels = state.closedPanels.filter((c) => c.id !== id);
    Store.save(state);
  },
});

let lastLayout = null;
Bus.on("cmd:report-panel-rect", () => { /* 对接 Rust 命中测试，占位 */ });

// 渲染已开启面板
for (const def of state.panels) {
  pm.add(def);
}
lastLayout = pm.collectLayout();

// ---------------- 工作模式 ----------------
Workspaces.init({
  panelManager: pm,
  badgeEl: document.getElementById("mode-badge"),
  getClosedIds: () => state.closedPanels.map((c) => c.id),
  onMode: (key) => { state.mode = key; Store.save(state); },
});

// ---------------- 快速指令条 ----------------
const TYPE_LABEL = Object.fromEntries(
  DESKTOP_CONFIG.panels.map((p) => [p.type, p.title]));
const TYPE_ICON = { dashboard: "📊", system: "🖥", tasks: "✅", weather: "🌤", calendar: "📅", projects: "📦", notes: "📝" };

function buildCommands() {
  const cmds = [];
  // 模式切换
  cmds.push(...Workspaces.modeCommands());
  // 新增面板(每种类型)
  for (const p of DESKTOP_CONFIG.panels) {
    cmds.push({
      id: "add-" + p.type,
      icon: TYPE_ICON[p.type] || "▦",
      title: "新增面板：" + p.title,
      sub: "重新放置一个" + p.title + "面板",
      keywords: "add panel 面板 " + p.type + " " + p.title,
      run: () => tryAddPanel(p.type),
    });
  }
  // 添加任务
  cmds.push({
    id: "add-task",
    icon: "✅",
    title: "添加开发任务",
    sub: "输入任务文本后回车，或用 「>任务内容」",
    keywords: "task 任务 add todo",
    run: (text) => {
      if (text) { Tasks.add({ text }); toast("已添加任务"); }
      else { CommandBar.open(">"); }
    },
  });
  // 启动应用(浏览器内打开 Web 应用；Tauri 侧经由 windows.launch ShellExecute)
  const apps = [
    { name: "Figma", url: "https://figma.com" },
    { name: "GitHub", url: "https://github.com" },
    { name: "VS Code", url: "vscode://" },
    { name: "终端", url: null },
  ];
  for (const a of apps) {
    cmds.push({
      icon: "🚀", title: "启动：" + a.name,
      sub: a.url ? "打开 " + a.url : "将由 ShellExecute 启动",
      keywords: "launch open 启动 " + a.name,
      run: () => {
        if (a.url) window.open(a.url, "_blank");
        else Bus.emit("cmd:windows-launch", { app: a.name });
        toast("启动 " + a.name);
      },
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

// 新增/重开面板
function tryAddPanel(type) {
  // 未指定类型(Dock ＋): 优先重开最近关闭的面板，否则新增一个默认面板
  if (type == null) {
    if (state.closedPanels.length) {
      const def = { ...state.closedPanels[state.closedPanels.length - 1] };
      pm.add(def);
      Workspaces.switchMode(Workspaces.current);
      toast("已重开：" + (TYPE_LABEL[def.type] || def.title));
    } else {
      tryAddPanel("notes");
    }
    return;
  }
  // 1) 优先重开已关闭的同类面板(保留几何)
  const closed = state.closedPanels.find((c) => c.type === type);
  if (closed) {
    const def = { ...closed };
    pm.add(def);
    Workspaces.switchMode(Workspaces.current); // 重新应用模式显隐
    toast("已重开：" + TYPE_LABEL[type]);
    return;
  }
  // 2) 若当前已有该类型，提示
  const exists = [...pm.panels.values()].some((p) => p.def.type === type);
  if (exists) { toast(TYPE_LABEL[type] + " 已显示"); return; }
  // 3) 否则新建实例
  const base = DESKTOP_CONFIG.panels.find((p) => p.type === type);
  const n = (Object.keys(pm.panels).length) + 1;
  const def = { ...base, id: base.id + "-" + n, x: 120 + n * 24, y: 120 + n * 24 };
  pm.add(def);
  Workspaces.switchMode(Workspaces.current);
  toast("已新增：" + TYPE_LABEL[type]);
}

// ---------------- 启动 Provider ----------------
Providers.startAll();

// ---------------- 快捷键 / Dock ----------------
window.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.code === "Space") {
    e.preventDefault();
    CommandBar.toggle();
  }
});
// 全局 Esc：无覆盖层时退出应用（全屏无边框窗口无系统关闭按钮）。
// 命令栏自身的 Esc 已 stopPropagation，不会冒泡到此处，故不会误退。
window.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  const help = document.getElementById("help-overlay");
  if (help && !help.hidden) { help.hidden = true; return; }
  if (window.__TAURI__ || window.__TAURI_INTERNALS__) {
    Bus.invoke("quit_app").catch(() => { try { window.close(); } catch (_) {} });
  }
});
document.getElementById("dock-cmd").addEventListener("click", () => CommandBar.toggle());
document.getElementById("dock-add").addEventListener("click", () => tryAddPanel(null));
document.getElementById("dock-help").addEventListener("click", () => {
  document.getElementById("help-overlay").hidden = false;
});
document.getElementById("help-close").addEventListener("click", () => {
  document.getElementById("help-overlay").hidden = true;
});
document.getElementById("dock-reset").addEventListener("click", () => {
  if (confirm("重置工作台布局？将恢复默认面板与位置。")) {
    Store.reset();
    location.reload();
  }
});

// ---------------- 恢复模式 ----------------
Workspaces.switchMode(state.mode && MODES[state.mode] ? state.mode : "coding");

// 首次访问展示帮助
if (!localStorage.getItem("deskoverlay.seen-help")) {
  document.getElementById("help-overlay").hidden = false;
  localStorage.setItem("deskoverlay.seen-help", "1");
}

console.log("[DeskOverlay] 工作台已就绪 · 面板数:", pm.panels.size);
