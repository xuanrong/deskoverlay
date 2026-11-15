// 一屏工作台：卡片网格 + 模块全屏浮层 + 底部任务栏数据。
// 设计稿来源：.workbuddy/design/trae-workbench/pages/桌面工作台.html（6 列网格，卡片即入口）。
// 分工：本文件只管「工作台首页」的卡片渲染与浮层开关；模块内部仍由 views.js 的原渲染器负责，
// 卡片只读 state / Tasks / Bus，绝不反向写入模块视图。
import { MODULES, CHECKIN_RESULT_DIR } from "./config.js";
import { state, saveState } from "./state.js";
import { Bus, Heartbeat, invoke } from "./bus.js";
import { VIEW_RENDERERS } from "./views.js";
import { Tasks } from "./tasks.js";
import { musicControl, musicLyricAt } from "./views/music.js";
// 指数行情取数（模块级导出）：任务栏无需打开基金模块即可显示大盘
import { fetchIndexQuotes } from "./views/fund.js";
// 签到实时查询：刷新按钮要能主动拉最新余额，不能只重读那个早上 10 点的旧文件
import { createCheckin } from "./views/ai-checkin.js";
import { LYRIC_PALETTES } from "./theme.js";
// 待办弹窗：卡片标题栏的「新增」按钮复用浮层那套表单，不另写简化版
import { showTaskModal } from "./views/dashboard.js";
import { esc, ymd, hhmm } from "./utils.js";
import {
  ICON_AI,
  ICON_MUSIC,
  ICON_CHECK, ICON_PLAY, ICON_PAUSE, ICON_NEXT, ICON_PREV, ICON_GRID,
  ICON_CREDIT, ICON_FOLDER, ICON_GLOBE, ICON_DOC, ICON_REFRESH, ICON_SPARK,
  ICON_MUYU_BIG, ICON_EXPAND, ICON_PLUS, ICON_KANBAN, ICON_BELL,
} from "./icons.js";

// -------------------- 卡片配置 --------------------
// 设计稿只有 6 张卡，但应用有 11 个模块。这里的做法：
//   1) 主网格铺「核心卡片」，覆盖设计稿的 6 个位置（待办 / 笔记 / 音乐 / 定时任务 / 快捷访问 / 文件中心→AI资讯）；
//   2) 其余模块做成 1 格小卡（icon + 名称），点开同样是全屏浮层，一个模块都不丢。
// span 语义同设计稿：span-1 / span-2 / span-4，row-2 = 纵向占两行。
const CARDS = [
  { id: "tasks",    module: "dashboard",   title: "待办事项", kind: "tasks",    span: 4, row: 2 },
  { id: "notes",    module: "notes",       title: "最近笔记", kind: "notes",    span: 2, row: 1 },
  { id: "music",    module: "music",       title: "音乐播放", kind: "music",    span: 2, row: 1 },
  { id: "sched",    module: "scheduler",   title: "定时任务", kind: "sched",    span: 2, row: 1 },
  // 快捷访问：占 2 格宽（span-4），横向铺 4 列 × 2 行 = 8 个快捷方式。
  // 之前是 span-2（2 列 × 2 行 = 4 个），一半宽度都浪费在右侧留白上。
  { id: "quick",    module: "quickaccess", title: "快捷访问", kind: "quick",    span: 4, row: 1 },
  // 电子木鱼：1 格宽。点击整张卡就敲一下（次数 +1），没有浮层。
  // 原位置是「AI 资讯」卡（已随整个模块移除）。
  { id: "muyu",     module: "muyu",        title: "电子木鱼", kind: "muyu",     span: 1, row: 1 },
  // 禅道：1 格宽，内部 2×2 四个数字。
  // ⛔ 必须 span-1：网格是 6 列 × 4 行 = 24 格，原 worklog 占 1 格；
  //    改成 span-2 会多占 1 格 → 总 25 格 → 溢出第 5 行，把「一屏装下」破坏掉。
  // icon 用 ICON_KANBAN 而不是模块默认的 ICON_REQ：
  //   ① ICON_REQ（文档+折角）和卡内「未验证需求」格子撞图，标题栏和格子一样很怪；
  //   ② 「文档」读不出禅道是项目管理工具，层叠卡片+勾更像「一堆活儿」。
  { id: "ems",      module: "ems-stats",   title: "禅道", kind: "ems",    span: 1, row: 1, icon: ICON_KANBAN },
// 灵感碎片：不再只是「图标 + 名称」的入口，改成「一颗灵感一颗星」的星图卡
// icon 用 ICON_AI 的四角星芒，而不是灯泡（星星形状更适合「一颗灵感一颗星」）
// ⚠ span-2 是布局需要：最后一行必须是 6 格（木鱼1 + 禅道1 + 灵感2 + 签到2）。
//   原「AI 资讯」占 2 格，它删除后木鱼只占 1 格 → 只剩 5 格 → 右侧留一个空洞。
//   星图卡本来就是「越宽星星铺得越开越好看」，补在这里最自然。
  { id: "ideabox",  module: "ideabox",     title: "灵感碎片", kind: "ideas",    span: 2, row: 1, icon: ICON_AI },
  // 签到积分：WorkBuddy / Trae 两个账号的可用积分余额（数据来自签到脚本写的结果文件）。
  // ⚠ 原「AI 资讯」模块已移除，签到卡不再有浮层可进 —— module 用独立的 "credits"
  //    （不在 MODULES 里），点击只触发一次实时刷新，不打开任何面板。
  { id: "credits",  module: "credits",     title: "签到积分", kind: "credits",  span: 2, row: 1, icon: ICON_CREDIT },
];

// 不占卡片的模块：底部任务栏已经有入口，网格里再放一张就是重复。
//   fund     → 任务栏中部常驻上证指数（点击打开浮层）
//   settings → 任务栏左侧「设置」按钮
// ⛔ 这份清单必须与 cardList() 的补卡逻辑配套：否则它们会被当成「未覆盖模块」
// 自动补回 1 格小卡，等于白删（补卡是为了让插件模块有位置，不是兜底所有模块）。
// 注：system 不在这里 —— 它已从 MODULES 里彻底移除（浮层不要了），
// 不是「有卡片但藏起来」，所以无需在此排除。
const TASKBAR_ONLY = new Set(["fund", "settings"]);

const MODULE_BY_ID = new Map(MODULES.map((m) => [m.id, m]));
const moduleTitle = (id) => MODULE_BY_ID.get(id)?.title || id;
const moduleIcon = (id) => MODULE_BY_ID.get(id)?.icon || ICON_GRID;

// 「有卡片但没有模块」的例外：这些卡的 module 不在 MODULES 里，也不开浮层。
//   credits → 签到积分。原「AI 资讯」模块删除后它失去了宿主模块，但卡片要留
//             （点击只做一次实时刷新）。
// ⛔ 不加这个集合，cardList() 的 MODULE_BY_ID.has() 过滤会把它们当「模块已删」丢掉。
const CARDLESS_MODULES = new Set(["credits"]);

// -------------------- 卡片尺寸（用户可调）--------------------
// 需求：「每个卡片都能改变大小」。实现为编辑模式下拖右下角把手，吸附到网格。
//
// ⛔ 为什么是「吸附网格」而不是自由像素：
//    卡片是 CSS Grid 的直接子项，宽高由 grid-column/grid-row span 决定。
//    改成绝对定位 + 像素宽高会丢掉整个 6 列对齐体系（参考线、最后一行右边界
//    自检、媒体查询降级全部失效）。吸附到格 = 只改 span 数字，其它机制照旧。
//
// ⛔ 尺寸上限由**网格容量**决定，不是拍脑袋：6 列 × 4 行 = 24 格，
//    9 张卡默认正好占满 24 格。放大任何一张就必然溢出到第 5 行。
//    这里**允许溢出并让网格滚动**（.widget-grid 本来就是 overflow-y:auto），
//    而不是拒绝放大 —— 拒绝会变成「点了没反应」，正是 #44 那个坑的形态。
//    用户自己缩别的卡就能重新收进一屏。
const SPAN_MAX = 6;
const ROW_MAX = 4;

// 每张卡的当前尺寸：{ [id]: { span, row } }
// 来源优先级：state.settings.cardSize[id] > CARDS 里的声明值。
function cardDefaults() {
  const map = new Map();
  for (const c of cardList()) map.set(c.id, { span: c.span || 1, row: c.row || 1 });
  return map;
}

function spanOf(id, fallback) {
  const v = state.settings?.cardSize?.[id]?.span;
  return clampSize(v, fallback || 1, SPAN_MAX);
}
function rowOf(id, fallback) {
  const v = state.settings?.cardSize?.[id]?.row;
  return clampSize(v, fallback || 1, ROW_MAX);
}
function clampSize(v, fallback, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(max, Math.round(n)));
}

// 把尺寸写进 DOM 类名。只改 span-N / row-N，不重建卡片 —— 重建会丢焦点、
// 打断木鱼动画、让音乐卡按钮闪一下（§16 明确禁止整卡重画）。
function applyCardSize(card, span, row) {
  if (!card) return;
  const s = clampSize(span, 1, SPAN_MAX);
  const r = clampSize(row, 1, ROW_MAX);
  for (let i = 1; i <= SPAN_MAX; i++) card.classList.toggle(`span-${i}`, i === s);
  for (let i = 1; i <= ROW_MAX; i++) card.classList.toggle(`row-${i}`, i === r);
  card.dataset.span = String(s);
  card.dataset.row = String(r);
  // ⛔ 同步内联 grid-column / grid-row 的 **span 部分**：applyGridPositions 写的内联样式
  //    （grid-column: N / span X）优先级高于 span-N 类，会把卡片锁在初始 X。
  //    resize 时若不同步这里，卡片根本不变大变小（内联 span 没跟着改）。
  //    只改 span、保留锚点列/行（N 不变）→ 缩放在原位缩、留空；放大往右/往下撑，不重排其它卡。
  if (card.style.gridColumn) {
    const col = parseInt(card.style.gridColumn, 10) || 1;
    card.style.gridColumn = `${col} / span ${s}`;
  }
  if (card.style.gridRow) {
    const rw = parseInt(card.style.gridRow, 10) || 1;
    card.style.gridRow = `${rw} / span ${r}`;
  }
}

// 启动时按持久化值铺一遍
function applyCardSizes(grid) {
  const defs = cardDefaults();
  grid.querySelectorAll(".widget").forEach((card) => {
    const id = card.dataset.card;
    const d = defs.get(id) || { span: 1, row: 1 };
    applyCardSize(card, spanOf(id, d.span), rowOf(id, d.row));
  });
}

// 给每张卡**固定网格坐标**（explicit grid-column / grid-row）。
// ⛔ 为什么需要：卡片原本靠 CSS Grid「自动流」排布（按 DOM 顺序自动填格）。
//    自动流的副作用：前面某张卡缩小后空出的格，后面/下面的卡会**自动往前/往上补**
//    （用户实测：前面缩小，后面就往前移）。改成显式坐标后，每张卡的位置锁死，
//    缩放只改变被操作那张的 span、在原位缩，空出的格就空着，后面的卡不移位。
// 算法：按当前 DOM 顺序装箱 —— 每张卡从左上往右下找第一个不与已放卡重叠的位置。
//    这与原自动流的初始铺法一致（同样紧凑），只是之后不再随缩放重排。
function applyGridPositions(grid) {
  const cards = Array.from(grid.querySelectorAll(".widget"));
  const occupied = new Set(); // "col,row" 已被占用的格
  for (const card of cards) {
    const span = Number(card.dataset.span) || 1;
    const rowSpan = Number(card.dataset.row) || 1;
    let placeCol = 1, placeRow = 1, placed = false;
    // 从 (1,1) 起逐格扫，找到第一个能容纳 span×rowSpan 且不重叠的左上角
    while (!placed) {
      let ok = true;
      for (let dc = 0; dc < span && ok; dc++) {
        for (let dr = 0; dr < rowSpan && ok; dr++) {
          if (occupied.has(`${placeCol + dc},${placeRow + dr}`)) ok = false;
        }
      }
      if (ok) { placed = true; break; }
      // 当前起点放不下 → 右移一格；越过右边界就换下一行行首
      placeCol++;
      if (placeCol + span - 1 > SPAN_MAX) { placeCol = 1; placeRow++; }
    }
    // 占住这块区域的所有格
    for (let dc = 0; dc < span; dc++) {
      for (let dr = 0; dr < rowSpan; dr++) occupied.add(`${placeCol + dc},${placeRow + dr}`);
    }
    // 写死坐标（span 仍由 CSS 类控制跨几列/几行，这里只钉左上角）
    card.style.gridColumn = `${placeCol} / span ${span}`;
    card.style.gridRow = `${placeRow} / span ${rowSpan}`;
  }
}

function persistCardSize(id, span, row) {
  if (!state.settings) state.settings = {};
  if (!state.settings.cardSize || typeof state.settings.cardSize !== "object") {
    state.settings.cardSize = {};
  }
  state.settings.cardSize[id] = { span, row };
  saveState();
}

// 动态卡片清单：设计稿里的核心卡按固定 span 铺，其余模块自动补 1 格小卡。
function cardList() {
  const designed = CARDS.filter(
    (c) => MODULE_BY_ID.has(c.module) || CARDLESS_MODULES.has(c.module),
  );
  const covered = new Set(designed.map((c) => c.module));
  const extra = MODULES
    .filter((m) => !covered.has(m.id) && !TASKBAR_ONLY.has(m.id))
    .map((m) => ({ id: m.id, module: m.id, title: m.title, kind: "mini", span: 1, row: 1 }));
  return designed.concat(extra);
}

// -------------------- 浮层（模块全屏视图） --------------------
let overlayEl = null;
let overlayBody = null;
let overlayView = null;
let overlayModuleId = null;

class OverlayView {
  // 与 app.js 的 View 接口保持一致的极简壳：渲染器只用 header / body / onDestroy。
  constructor(root, moduleId) {
    root.innerHTML = `<div class="view"><div class="view-header"></div><div class="view-body"></div></div>`;
    this.moduleId = moduleId;
    this.header = root.querySelector(".view-header");
    this.body = root.querySelector(".view-body");
    this._destroyers = [];
  }
  onDestroy(fn) { this._destroyers.push(fn); }
  saveScroll() {
    if (!state.navState) state.navState = {};
    if (!state.navState[this.moduleId]) state.navState[this.moduleId] = {};
    state.navState[this.moduleId].scrollTop = this.body.scrollTop || 0;
  }
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

function initOverlayRefs() {
  if (overlayEl) return;
  overlayEl = document.getElementById("module-overlay");
  overlayBody = document.getElementById("mo-body");
  const closeBtn = document.getElementById("mo-close");
  closeBtn?.addEventListener("click", closeModule);
  // 点遮罩空白处关闭；点面板内部不关
  overlayEl?.addEventListener("click", (e) => {
    if (e.target === overlayEl) closeModule();
  });
}

export function openModule(id) {
  initOverlayRefs();
  if (!id || !VIEW_RENDERERS[id] || !overlayEl) return;
  // 同一模块重复点：不重建视图（保住滚动位置与正在跑的定时器）
  if (overlayModuleId === id && !overlayEl.hidden) return;

  if (overlayView) { overlayView.destroy(); overlayView = null; }
  overlayModuleId = id;
  state.currentModule = id;
  saveState();

  const titleEl = document.getElementById("mo-title");
  const iconEl = document.getElementById("mo-icon");
  const subEl = document.getElementById("mo-sub");
  if (titleEl) titleEl.textContent = moduleTitle(id);
  if (iconEl) iconEl.innerHTML = moduleIcon(id);
  if (subEl) subEl.textContent = "";

  overlayEl.hidden = false;
  overlayBody.innerHTML = "";
  overlayView = new OverlayView(overlayBody, id);
  try {
    VIEW_RENDERERS[id](overlayView);
  } catch (e) {
    console.warn("[workspace] 模块渲染失败：", id, e);
    overlayBody.innerHTML = `<div class="dash-empty">模块加载失败：${esc(String(e && e.message || e))}</div>`;
  }
  requestAnimationFrame(() => {
    overlayView?.restoreScroll();
    // 副标题取渲染器可能写进 header 的内容（有些模块 header 是隐藏的）
    if (subEl && overlayView) {
      const t = overlayView.header?.textContent?.trim();
      subEl.textContent = t && t !== moduleTitle(id) ? t : "";
    }
  });
  document.body.classList.add("overlay-open");
}

function closeModule() {
  if (!overlayEl || overlayEl.hidden) return;
  overlayEl.hidden = true;
  document.body.classList.remove("overlay-open");
  if (overlayView) { overlayView.destroy(); overlayView = null; }
  overlayModuleId = null;
  // 关掉浮层就重新读一次积分文件：签到/AI 操作都在浮层里做，签完回来卡片该是新数字。
  // ⛔ 定时任务卡的状态同步写在 loadCredits(true) 里（签到卡刷新按钮走同一条路径），
  //    这里不重复拉，避免一次关闭打两轮 IPC。
  loadCredits(true);
}

function isModuleOpen() {
  return !!overlayEl && !overlayEl.hidden;
}

// -------------------- 卡片渲染 --------------------
const gridEl = () => document.getElementById("widget-grid");
const cardEl = (id) => document.querySelector(`#widget-grid [data-card="${id}"]`);

// 通用骨架：大卡带标题栏，小卡是 icon + 名称
const skeletonHTML = () => `<div class="w-skel"><span></span><span></span><span></span></div>`;
const emptyHTML = (t) => `<div class="w-empty">${esc(t)}</div>`;

// 尺寸类名：把 {span,row} 翻译成 span-N / row-N。
// ⛔ 必须统一从 sizeOf() 取，不能各分支自己拼 —— 五个分支里有两处（mini/muyu）
//    原来写死 span-1，改 CARDS 也不生效（踩过）。现在全部走同一个函数。
// ⛔ row 只在 >1 时加类：row-1 没有对应 CSS（默认就是占 1 行），加了也无害但脏。
function sizeClass(id, span, row) {
  const s = spanOf(id, span);
  const r = rowOf(id, row);
  return `span-${s}${r > 1 ? ` row-${r}` : ""}`;
}

// 把手：纯 CSS 折角，不用 SVG（装饰性，不是图标）。
function resizeHandleHTML() {
  return `<span class="widget__resize" data-resize aria-label="拖动改大小"></span>`;
}

function cardShell(cfg) {
  const mod = cfg.module;
  // cfg.icon 优先：允许卡片用专属图标而不借用模块图标（积分卡就复用了 ai 模块但换了图标）
  const icon = cfg.icon || moduleIcon(mod);
  const cls = sizeClass(cfg.id, cfg.span, cfg.row);
  if (cfg.kind === "mini") {
    // mini 卡外层是 <button>（整卡可聚焦），⛔ 不能再嵌 <button>（button 嵌 button 非法、会拆 DOM）。
    // 右上角入口用 <span data-open>：grid 的 click 委托 closest("[data-open]") 对 span 同样生效。
    return `<button class="widget widget--1 ${cls}" data-card="${cfg.id}" data-module="${mod}" aria-label="打开${esc(cfg.title)}">
      <span class="w-icon">${icon}</span>
      <span class="w-label">${esc(cfg.title)}</span>
      <span class="w-badge" data-badge hidden></span>
      <span class="w-expand" data-open="${mod}" aria-label="打开${esc(cfg.title)}">${ICON_EXPAND}</span>
      ${resizeHandleHTML()}
    </button>`;
  }
  // 灵感碎片：星图卡 —— 标题栏（图标 + 名称 + 条数）+ 星区
  // ⚠ 这里原本漏了「展开」按钮（其它卡都有），2026-11 补上。
  //   星图卡是唯一一张「标题栏有数字、但正文没有可点入口」的卡，
  //   用户只能靠「点整卡」猜它可打开 —— 补按钮后交互和其它卡一致。
  //   顺序必须是 extra 在前、open 在后：`.widget__extra` 是 flex:1 1 auto，
  //   放后面会把条数数字顶到中间。
  if (cfg.kind === "ideas") {
    return `<section class="widget widget--stars ${cls}" data-card="${cfg.id}" data-module="${mod}">
      <div class="widget__title">
        <span class="widget__icon">${icon}</span>
        <span class="widget__name">${esc(cfg.title)}</span>
        <span class="widget__extra" data-extra></span>
        <button class="widget__open" data-open="${mod}" aria-label="打开${esc(cfg.title)}">${ICON_EXPAND}</button>
      </div>
      <div class="widget__body widget__body--stars" data-body>${skeletonHTML()}</div>
      ${resizeHandleHTML()}
    </section>`;
  }
  // 电子木鱼：1 格宽，整卡可点（不设 data-open，避免点一下既敲又开浮层）。
  // 用 <button> 而不是 <section>：天然可聚焦、支持 Enter/Space，无障碍不用额外写。
  if (cfg.kind === "muyu") {
    return `<button class="widget widget--muyu ${cls}" data-card="${cfg.id}" data-module="${mod}" aria-label="敲一下，功德 +1">
      <div class="widget__title">
        <span class="widget__icon">${icon}</span>
        <span class="widget__name">${esc(cfg.title)}</span>
        <span class="widget__extra" data-extra></span>
      </div>
      <div class="widget__body" data-body>${skeletonHTML()}</div>
      ${resizeHandleHTML()}
    </button>`;
  }
  // 禅道：2×2 数字矩阵（四个数字横向排开，数字在左、标签在右）
  if (cfg.kind === "ems") {
    return `<section class="widget widget--ems ${cls}" data-card="${cfg.id}" data-module="${mod}">
      <div class="widget__title">
        <span class="widget__icon">${icon}</span>
        <span class="widget__name">${esc(cfg.title)}</span>
        <span class="widget__extra" data-extra></span>
        <button class="widget__open" data-open="${mod}" aria-label="打开${esc(cfg.title)}">${ICON_EXPAND}</button>
      </div>
      <div class="widget__body" data-body>${skeletonHTML()}</div>
      ${resizeHandleHTML()}
    </section>`;
  }
  return `<section class="widget widget--multi ${cls}" data-card="${cfg.id}" data-module="${mod}">
    <div class="widget__title">
      <span class="widget__icon">${icon}</span>
      <span class="widget__name">${esc(cfg.title)}</span>
      <span class="widget__extra" data-extra></span>
      <button class="widget__open" data-open="${mod}" aria-label="打开${esc(cfg.title)}">${ICON_EXPAND}</button>
    </div>
    <div class="widget__body" data-body>${skeletonHTML()}</div>
    ${resizeHandleHTML()}
  </section>`;
}

// -------------------- 各卡片内容 --------------------
// 待办：读 Tasks.list()，展示未完成的前几条 + 统计

// 上一次渲染时正文的高度。ResizeObserver 靠它判断「真的变了」——
// ⛔ 没有这个哨兵会死循环：render 改 DOM → 高度微变 → observer 回调 → 再 render。
let lastTasksBodyH = 0;
let tasksRO = null;

// 行距常量（与 CSS 里的 .wt-row 高度严格对应）。
// ⛔ 改这个数必须同步改 CSS，否则「能放几行」算错 —— 要么底部留白，
//    要么多算一行导致正文溢出。
const WT_ROW_H = 34;   // .wt-row 的 height
const WT_GAP = 2;      // .wt-list 的 gap
const WT_PITCH = WT_ROW_H + WT_GAP;   // 一个「行位」= 36px

// 一行待办。顺序与「今日概览」浮层里的 .dash-task 一致：
// 状态 → 优先级 → 标题 → 标签 → 截止。
// ⛔ 卡片和浮层是同一份数据的两个视图，列顺序必须一样，否则来回看会错位。
function taskRowHTML(t) {
  const status = t.status || "pending";
  const tags = (t.tags || []).slice(0, 2)
    .map((g) => `<span class="wt-tag">#${esc(g)}</span>`).join("");
  // 截止日期：due 是 'YYYY-MM-DD'，只显示 MM-DD。
  // 逾期判定用字符串比较就够 —— 'YYYY-MM-DD' 的字典序 == 时间序。
  const dueRaw = (t.due || "").trim();
  let due = "";
  if (dueRaw) {
    const short = dueRaw.length >= 10 ? dueRaw.slice(5) : dueRaw;
    const overdue = dueRaw < ymd();
    due = `<span class="wt-due${overdue ? " is-overdue" : ""}" title="${overdue ? "已逾期：" : "截止："}${esc(dueRaw)}">${esc(short)}</span>`;
  }
  // 优先级：与浮层同口径，P0–P4 **全部显示**，颜色四档。
  // （早期版本让 P2 不渲染，但那样和浮层对不上 —— 用户在浮层看到 P2、
  //   卡片上没有，会以为两条不是同一件事。位置也和浮层一致，放在标题前。）
  const pri = /^P\d$/.test(t.priority || "") ? t.priority : "P2";
  const priNum = parseInt(pri.slice(1), 10);
  const priCls = priNum === 0 ? "critical" : priNum === 1 ? "high" : priNum === 2 ? "medium" : "low";
  return `<div class="wt-row" data-task="${esc(t.id)}">
    <i class="wt-bar st-${esc(status)}" aria-hidden="true"></i>
    <button class="wt-check" data-toggle="${esc(t.id)}"
      aria-label="标记完成">${ICON_CHECK}</button>
    <span class="wt-pri ${priCls}">${pri}</span>
    <span class="wt-text">${esc(t.text || "")}</span>
    ${tags ? `<span class="wt-tags">${tags}</span>` : ""}
    ${due}
  </div>`;
}

function renderTasksCard() {
  const el = cardEl("tasks");
  if (!el) return;
  const body = el.querySelector("[data-body]");
  const extra = el.querySelector("[data-extra]");
  const all = Tasks.list() || [];
  const doing = all.filter((t) => !t.done && t.status !== "done");
  const st = Tasks.stats();
  // 右上角：完成进度 + 「新增待办」按钮。
  // 原来只有进度数字，加一条待办必须先点「展开」进浮层再点右上角的 ＋ —— 两跳。
  // 现在卡片上直接给入口，复用浮层同一个 showTaskModal（不另写简化表单）。
  // ⚠ 顺序：进度 pill 在前、加号在后。`.widget__extra` 是 flex:1 1 auto + flex-end，
  //   加号放最后才能贴右边缘，和邻卡的「展开」按钮对齐成一条竖线。
  if (extra) {
    extra.innerHTML = `<span class="w-pill">${st.done}/${st.total} 完成</span>
      <button class="cr-refresh wt-add" data-task-add aria-label="新增待办">${ICON_PLUS}</button>`;
    const addBtn = extra.querySelector("[data-task-add]");
    if (addBtn) {
      // ⛔ 必须 stopPropagation：整张卡是可点的（点卡开浮层），
      //    不拦的话点「新增」会同时弹出待办弹窗**和**今日概览浮层。
      addBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        showTaskModal("new", null, () => { renderTasksCard(); renderBadges(); });
      });
    }
  }
  if (!all.length) {
    body.innerHTML = emptyHTML("还没有待办，点右上角的 + 加一条");
    return;
  }

  // ---- 行数自适应 ----
  // ⛔ 不能写死 slice(0, 6)：正文可用高度随视口变（实测 1440×870 是 287px、
  //    1280×800 只有 252px、1600×900 是 302px）。写死一个数字必然在某个视口
  //    要么底部白留一大片，要么多算一行把正文撑出滚动条。
  //
  // 布局只有一块：未完成列表。没有底栏、没有「已完成」折叠区
  // （用户要求「不要显示已完成了」），所以预算 100% 给未完成行。
  //   占高 = 34n + 2(n-1)   （n ≥ 1）
  const bodyH = body.clientHeight || 260;
  lastTasksBodyH = bodyH;
  // ⛔ 必须监听正文高度变化并重算行数。
  //    踩过：只在渲染时读一次 clientHeight，之后窗口从 1280 拉到 1600，
  //    正文从 252px 涨到 302px（能多放 1 行），但卡片还是显示 6 条 ——
  //    因为没有任何东西触发重画。心跳的 watch("tasks") 签名只认
  //    待办数据的 id/done/status，**不认视口尺寸**，所以签名不变就不重画。
  //    音乐卡和禅道卡也踩过同一类坑（签名漏字段），这里是签名漏「尺寸」。
  if (!tasksRO && typeof ResizeObserver !== "undefined") {
    tasksRO = new ResizeObserver(() => {
      const b = cardEl("tasks")?.querySelector("[data-body]");
      if (!b) return;
      // 只在高度真的变了才重画（±1px 容差），否则 render 改 DOM → 高度微变
      // → 回调 → 再 render，无限循环。
      if (Math.abs(b.clientHeight - lastTasksBodyH) <= 1) return;
      renderTasksCard();
    });
    tasksRO.observe(body);
  }
  const budget = bodyH;
  // 未完成能放几行：全部预算给未完成列表。
  const cap = Math.max(1, Math.floor((budget + WT_GAP) / WT_PITCH));
  const shown = doing.slice(0, cap);
  const hidden = doing.length - shown.length;

  // 全部完成：给一句反馈。⛔ 不能什么都不画 —— 卡片会变成一片空白，
  // 用户会以为卡片坏了。这里不列已完成的条目（用户要求「不要显示已完成了」），
  // 只留一句提示 + 标题栏的进度 pill。
  body.innerHTML = shown.length
    ? `<div class="wt-list">${shown.map((t) => taskRowHTML(t)).join("")}</div>`
    : `<div class="w-done-all">${ICON_CHECK}<span>全部完成，收工！</span></div>`;

  // 放不下的条数写在标题栏的进度 pill 里，不再占正文高度。
  if (extra) {
    const pill = extra.querySelector(".w-pill");
    if (pill && hidden > 0) pill.textContent = `${st.done}/${st.total} 完成 · 还有 ${hidden} 条`;
  }

  body.querySelectorAll("[data-toggle]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = btn.dataset.toggle;
      Tasks.toggle(id);
      renderTasksCard();
      renderBadges();
      toastQuiet("已勾掉一条");
    });
  });
}

// 笔记：state.notes 按 updatedAt 降序取前 5 条
// 最近笔记卡：干净的单行列表 —— 标题 + 日期，不加多余装饰。
function renderNotesCard() {
  const el = cardEl("notes");
  if (!el) return;
  const body = el.querySelector("[data-body]");
  const extra = el.querySelector("[data-extra]");
  const notes = (state.notes || []).slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  if (extra) extra.textContent = notes.length ? `${notes.length} 篇` : "";
  if (!notes.length) { body.innerHTML = emptyHTML("暂无笔记"); return; }
  body.innerHTML = `<div class="w-list">${notes.slice(0, 5).map((n) => `
    <div class="w-li">
      <span class="w-li-title">${esc(n.title || "未命名")}</span>
      <span class="w-li-time">${fmtDate(n.updatedAt)}</span>
    </div>`).join("")}</div>`;
}

// 音乐：读 state.playback（播放器状态由 music.js 落盘）
// 结构分两块：**静态骨架**（封面/歌名/按钮/进度条容器）只在切歌或播放状态变化时重建；
// **高频部分**（进度条 transform、时间文字、歌词行）由 music-progress 广播驱动，只改属性不重排。
// 为什么不用 Heartbeat 每秒重画整卡：那样会反复 innerHTML，按钮焦点和 hover 态都会丢，
// 而且每秒一次全量重建在 6 列网格里很浪费。
let musicTickBound = false;
let musicLyricShown = false;
// 最近一次广播带来的歌词行：卡片骨架重建时要用它回填，
// 否则重建后 lyric 参数为 undefined 会把已显示的歌词又藏起来（每 250ms 一次的闪断）。
let lastMusicLyric = null;

function renderMusicCard() {
  const el = cardEl("music");
  if (!el) return;
  const body = el.querySelector("[data-body]");
  const extra = el.querySelector("[data-extra]");
  const pb = state.playback || {};
  const song = pb.song;
  if (extra) extra.innerHTML = pb.playing ? `<span class="w-pill w-pill--live">播放中</span>` : "";
  if (!song) {
    musicLyricShown = false;
    body.innerHTML = `<div class="wm-empty">${ICON_MUSIC}<span>去「在线音乐」挑一首</span></div>`;
    return;
  }
  const cur = pb.currentTime || 0;
  const dur = pb.duration || 0;
  const pct = dur > 0 ? Math.min(1, Math.max(0, cur / dur)) : 0;
  // ⚠ 歌词块在 .wm-info **里面**，不是单独一行 —— 见 CSS 里
  //   `[data-card="music"] .widget__body` 的注释：
  //   封面是「跟着卡片高度自适应」的（`height:100%` + `aspect-ratio`），
  //   歌词若独占一行会先占掉 16px，封面就长不满；
  //   放进信息列后封面能吃满剩余高度，歌词也跟歌名左对齐，视觉更整齐。
  body.innerHTML = `
    <div class="wm-card">
      <div class="wm-art${pb.playing ? " is-playing" : ""}" ${song.artwork ? `style="background-image:url('${esc(song.artwork)}')"` : ""}>
        ${song.artwork ? "" : ICON_MUSIC}
      </div>
      <div class="wm-info">
        <div class="wm-title">${esc(song.title || "未命名")}</div>
        <div class="wm-artist">${esc(song.artist || song.type || "")}</div>
        <div class="wm-lyric" hidden></div>
      </div>
      <div class="wm-ctrl">
        <button class="wm-btn" data-mc="prev" aria-label="上一首">${ICON_PREV}</button>
        <button class="wm-btn wm-btn--main" data-mc="toggle" aria-label="播放/暂停">${pb.playing ? ICON_PAUSE : ICON_PLAY}</button>
        <button class="wm-btn" data-mc="next" aria-label="下一首">${ICON_NEXT}</button>
      </div>
    </div>
    <div class="wm-prog" aria-label="${fmtTime(cur)} / ${dur > 0 ? fmtTime(dur) : '未知时长'}">
      <span class="wm-time">${fmtTime(cur)}</span>
      <div class="wm-track${dur > 0 ? "" : " wm-track--idle"}"><div class="wm-fill" style="transform:scaleX(${pct.toFixed(4)})"></div></div>
      <span class="wm-time wm-time--dur">${dur > 0 ? fmtTime(dur) : ""}</span>
    </div>`;
  // 播放控制直接调音乐模块的导出函数：musicAudio 单例由 music.js 独占，
  // 工作台只发指令，绝不自己 new Audio（否则会出现两份播放器抢同一个 state.playback）。
  body.querySelectorAll("[data-mc]").forEach((b) => {
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      const ok = musicControl(b.dataset.mc);
      if (!ok) toastQuiet("先去「在线音乐」挑一首");
    });
  });
  paintMusicTick({ currentTime: cur, duration: dur, playing: pb.playing, lyric: lastMusicLyric });
  bindMusicTick();
}

// 封面主色取色：给首页音乐卡的当前歌词行染上封面主色（color-thief 思路的轻量版）。
// ⚠ artwork 有三种来源：本地文件 / 在线远程 URL / data URL。远程图若图源不带 CORS 头，
//   画进 canvas 后 `getImageData` 会抛 SecurityError（tainted canvas）⇒ 必须防御：
//   取不到就返回 null，调用方回落到 CSS 的主题强调色，绝不让歌词变透明或报错。
// 缓存按 artwork 字符串存结果（含 null=取不到），因为 paintMusicTick 每秒跑多次，
// 不缓存会反复 new Image + 采样，白烧 CPU。换歌（artwork 变）才重新取色。
const lyricColorCache = new Map();
let lyricColorArtwork = null; // 已取色（或在取）的封面，换歌才重新取

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    // 远程图带 crossOrigin 才可能在 canvas 上取到像素；本地/data URL 不受影响。
    if (!src.startsWith("data:")) img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("封面加载失败"));
    img.src = src;
  });
}

/// 从封面图提取一个「足够亮、看得清」的主色，返回 CSS 颜色串；取不到返回 null。
async function lyricColorFromArtwork(artwork) {
  if (!artwork || typeof artwork !== "string") return null;
  if (lyricColorCache.has(artwork)) return lyricColorCache.get(artwork);
  let color = null;
  try {
    const img = await loadImage(artwork);
    // 缩到 24×24 采样就够算主色，避免大图逐像素遍历。
    const N = 24;
    const cv = document.createElement("canvas");
    cv.width = N; cv.height = N;
    const ctx = cv.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, N, N);
    const data = ctx.getImageData(0, 0, N, N).data;
    // 按 16 级量化 RGB 统计频次，取出现最多的桶的中心色（简化版主色）。
    const buckets = new Map();
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 125) continue; // 跳过透明像素
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
      const cur = buckets.get(key);
      if (cur) { cur.n++; cur.r += r; cur.g += g; cur.b += b; }
      else buckets.set(key, { n: 1, r, g, b });
    }
    let best = null;
    for (const v of buckets.values()) if (!best || v.n > best.n) best = v;
    if (best) {
      const [h, s, l] = rgbToHsl(best.r / best.n, best.g / best.n, best.b / best.n);
      // 压到中等亮度 + 保底饱和度：太暗/太灰在卡片背景上看不清。
      const L = Math.min(72, Math.max(55, l));
      const S = Math.min(85, Math.max(45, s));
      color = `hsl(${Math.round(h)} ${Math.round(S)}% ${Math.round(L)}%)`;
    }
  } catch {
    color = null; // 跨域污染 / 加载失败 / 无 2d ctx ⇒ 回落主题色
  }
  lyricColorCache.set(artwork, color);
  return color;
}

/// RGB(0-255) → [h(0-360), s%(0-100), l%(0-100)]
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0));
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  return [h, s * 100, l * 100];
}

// 高频重绘：只改已有节点，不重建。卡片不在页面上时直接跳过。
function paintMusicTick(t) {
  const el = cardEl("music");
  if (!el) return;
  const body = el.querySelector("[data-body]");
  if (!body) return;
  const fill = body.querySelector(".wm-fill");
  const track = body.querySelector(".wm-track");
  const curEl = body.querySelector(".wm-time:not(.wm-time--dur)");
  const durEl = body.querySelector(".wm-time--dur");
  const prog = body.querySelector(".wm-prog");
  const lyricEl = body.querySelector(".wm-lyric");
  if (!fill) return;

  const dur = t.duration || 0;
  const cur = t.currentTime || 0;
  const pct = dur > 0 ? Math.min(1, Math.max(0, cur / dur)) : 0;
  fill.style.transform = `scaleX(${pct.toFixed(4)})`;
  if (track) track.classList.toggle("wm-track--idle", dur <= 0);
  if (curEl) curEl.textContent = fmtTime(cur);
  if (durEl) durEl.textContent = dur > 0 ? fmtTime(dur) : "";
  if (prog) prog.setAttribute("aria-label", `${fmtTime(cur)} / ${dur > 0 ? fmtTime(dur) : "未知时长"}`);

  // 歌词：只显示「当前行」，上一行淡出在上方做上下文。没有歌词就整块收起，不占高度。
  if (lyricEl) {
    const ly = t.lyric || musicLyricAt(cur);
    // 记住这次的结果，卡片骨架重建时回填，避免歌词块闪断
    if (t.lyric) lastMusicLyric = t.lyric;
    if (ly.total > 0) {
      // 首次出现歌词时才建节点，之后只改 textContent（歌词是外部数据，不用 innerHTML 拼字符串）
      if (!lyricEl.querySelector(".wm-lyric-cur")) {
        lyricEl.innerHTML = `<span class="wm-lyric-prev"></span><span class="wm-lyric-cur"></span>`;
      }
      const curLine = lyricEl.querySelector(".wm-lyric-cur");
      const prevLine = lyricEl.querySelector(".wm-lyric-prev");
      if (curLine) curLine.textContent = ly.line || "";
      if (prevLine) prevLine.textContent = ly.prev || "";
      lyricEl.hidden = false;
      musicLyricShown = true;
      applyLyricLook(lyricEl);
    } else {
      lyricEl.hidden = true;
      musicLyricShown = false;
    }
  }
}

// ── 首页音乐卡歌词配色（可配置，照桌面歌词 state.lyric.* 那套）──
// 配置项（设置 → 音乐 → 歌词配色，落在 state.lyric.homePalette）：
//   LYRIC_PALETTES 里的 id（落日晖/晴空/…）→ 取该色板主色 c1
//   "cover" = 跟随封面主色（canvas 取色，取不到回落主题色）
//   "off"   = 不染色（正文灰）
// 字号/间距走 .wm-lyric CSS 变量默认值，不在此配置。
// 每秒 tick 都调；封面取色按 artwork 缓存，开销可忽略。
function applyLyricLook(lyricEl) {
  const pal = state.lyric?.homePalette ?? "cover";
  const curLine = lyricEl.querySelector(".wm-lyric-cur");
  if (!curLine) return;

  // off：拔掉 inline 颜色 → 回落 CSS 的正文灰（--text-dim）。
  if (pal === "off") { curLine.style.color = ""; return; }
  // 命名色板：取该色板主色 c1（落日晖=暖橙、晴空=天蓝…）。
  if (pal !== "cover") {
    const p = LYRIC_PALETTES.find((x) => x.id === pal);
    curLine.style.color = p ? p.c1 : "";
    return;
  }
  // cover：取封面主色，取不到回落主题色（远程图跨域污染时取不到，绝不透明）。
  const artwork = state.playback?.song?.artwork || "";
  if (artwork !== lyricColorArtwork) {
    lyricColorArtwork = artwork;
    lyricColorFromArtwork(artwork).then((c) => {
      // 取色期间配置可能已切走（换模式/换歌），只在自己还是 cover 时上色
      if ((state.lyric?.homePalette ?? "cover") !== "cover") return;
      curLine.style.color = c || "var(--blue)";
    }).catch(() => { curLine.style.color = "var(--blue)"; });
  } else if (lyricColorCache.has(artwork)) {
    curLine.style.color = lyricColorCache.get(artwork) || "var(--blue)";
  }
}

// 只在工作台首页存在时订阅一次，避免重复注册
function bindMusicTick() {
  if (musicTickBound) return;
  musicTickBound = true;
  Bus.on("music-progress", paintMusicTick);
}

// 定时任务：scheduler_status 给出 running / nextDue；卡片展示任务列表，
// 标题栏 [data-extra] 显示「今日异常」警告（失败 / 漏跑 / 到点未跑），由 refreshSchedWarnings() 异步填充。
// ⛔ 警告放标题栏（不占正文独立行）—— 正文只有约 89px，独立横幅会挤掉任务行。
// 列表每行：圆点 + 任务名 + **下次运行时刻**（右侧，替代原来难读的裸 cron）。
//   今天到期 → 「HH:MM」；非今天 → 「周X HH:MM」；无 cron / 没拉到 → 「—」。
//   cron 原文降级为该行 title（悬停可看），不再占主视觉。
const WD_CN = ["日", "一", "二", "三", "四", "五", "六"];
function schedNextLabel(ms) {
  if (typeof ms !== "number" || ms <= 0) return "—";
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  const now = new Date();
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  return sameDay ? hm : `周${WD_CN[d.getDay()]} ${hm}`;
}
function renderSchedCard() {
  const el = cardEl("sched");
  if (!el) return;
  const body = el.querySelector("[data-body]");
  const extra = el.querySelector("[data-extra]");
  const tasks = (state.scheduler?.tasks || []).filter((t) => t.enabled !== false);
  // extra 先给个基础态（启用数），refreshSchedWarnings 拉到数据后覆盖成警告胶囊（无异常则回落到此）
  if (extra) extra.textContent = tasks.length ? `${tasks.length} 个启用` : "";
  if (!tasks.length) { body.innerHTML = emptyHTML("暂无定时任务"); return; }
  const tk = ymd();
  // 排序：只有异常任务（失败/漏跑/超时）置顶，其余（未跑/已跑成/已停）**一律按下次运行时刻最近在前**。
  // 不能给「未跑」单独设优先级——否则周日才跑的未跑任务会压过今天就到期的已跑任务。
  // 无 nextDue 的排最后。
  const isAnomaly = (t) => ["bad", "missed", "warn"].includes(schedRunState(schedHeat?.[t.id]?.[tk]));
  const dueOf = (t) => schedNextDue[t.id];
  tasks.sort((a, b) => {
    const xa = isAnomaly(a) ? 0 : 1, xb = isAnomaly(b) ? 0 : 1;
    if (xa !== xb) return xa - xb;
    const da = dueOf(a), db = dueOf(b);
    const va = typeof da === "number" && da > 0 ? da : Infinity; // 无 nextDue → 视为最远
    const vb = typeof db === "number" && db > 0 ? db : Infinity;
    return va - vb;
  });
  // 全部启用任务都列出（正文 overflow-y:auto，超出滚动），每行用「状态点」标出今天跑了没跑。
  // 状态取 heat 当天 last（最终结果）：success=已跑成 / failed=失败 / timeout=超时 / canceled=已停 /
  // missed=漏跑 / 无记录=今天还没跑。颜色见 .sch-st-* CSS。
  const rows = tasks.map((t) => {
    const name = t.name || t.title || "未命名任务";
    const agg = schedHeat?.[t.id]?.[tk];
    const st = schedRunState(agg);
    const next = schedNextLabel(schedNextDue[t.id]);
    return `
    <div class="w-li">
      <span class="w-li-dot sch-st-${st}"></span>
      <span class="w-li-title">${esc(name)}</span>
      <span class="w-li-time">${esc(next)}</span>
    </div>`;
  }).join("");
  // ⛔ 保留 .w-list / .w-li / .w-li-dot / .w-li-title / .w-li-time：card 检查脚本依赖。
  body.innerHTML = `<div class="w-list">${rows}</div>`;
  // 静态渲染完立刻刷一次警告（异步，不阻塞首帧）
  refreshSchedWarnings();
}

// 今天该任务的运行状态 → 状态点 class 后缀 + 文案。依据 heat 当天 last（最终结果）。
// 没拉到 heat（后端没起/首帧）→ pending（中性），拉到后心跳按 nextDue/heat 签名重画。
function schedRunState(agg) {
  if (!agg) return "pending";
  return ({ success: "ok", failed: "bad", timeout: "warn", canceled: "stop", missed: "missed" })[agg.last] || "pending";
}
const ST_TEXT = {
  ok: "已跑成", bad: "失败", warn: "超时",
  stop: "已停止", missed: "漏跑", pending: "待运行",
};

// ── 今日异常警告：失败 / 漏跑 / 到点未跑 ─────────────────────────────────
// 数据源：
//   · scheduler_heat → daily[taskId]["YYYY-MM-DD"] = { ok, bad, warn, stop, missed, last }
//     bad=失败，missed=到点没启动（漏跑），两者都算异常。
//   · scheduler_status → nextDue[taskId] = 下次到期时间戳(ms)。
//     若某启用任务的 nextDue 落在「今天且已过去」，但 heat 里该任务今天**零记录**，
//     说明它到点了却还没跑（调度器没补跑/还没轮到）→ 也算异常「到点未跑」。
// 轻量：两个 IPC 都不带 output，60s 刷一次开销可忽略。
// 进行中的那次拉取。并发调用（心跳 / 签到回来 / 手动刷新）复用同一个 Promise，
// 而不是「已有请求就直接返回」—— 后者会让调用方以为刷新完了，其实拿到的是旧 heat，
// 重画出来状态点还是旧的（签到后不更新就是这个原因）。
let schedWarnInflight = null;
// 缓存 scheduler_status.nextDue（taskId → 下次到期 ms），供 renderSchedCard 显示「下次运行时刻」。
// 列表重画时若还没拉到数据就先不显示时刻，refreshSchedWarnings 回填后下一轮心跳补上。
let schedNextDue = {};
// 缓存 scheduler_heat（taskId → { "YYYY-MM-DD": { ok,bad,warn,stop,missed,last } }），
// 供 renderSchedCard 给每行画「跑了没跑」状态点（当天 last 状态）。
let schedHeat = {};
async function refreshSchedWarnings() {
  const el = cardEl("sched");
  const extraEl = el && el.querySelector("[data-extra]");
  if (!extraEl) return;
  const tasks = (state.scheduler?.tasks || []).filter((t) => t.enabled !== false);
  // 无任务/拉取前：标题栏回落显示「N 个启用」
  const base = () => { extraEl.textContent = tasks.length ? `${tasks.length} 个启用` : ""; };
  if (!tasks.length) { base(); return; }
  // 已有请求在飞 → 等它，别另起也别直接返回（直接返回 = 调用方拿到旧数据）
  if (schedWarnInflight) return schedWarnInflight;
  schedWarnInflight = (async () => {
    let heat = {}, nextDue = {};
    try {
      const [h, st] = await Promise.all([
        invoke("scheduler_heat").catch(() => ({})),
        invoke("scheduler_status", {}).catch(() => ({})),
      ]);
      if (h && typeof h === "object" && !Array.isArray(h)) heat = h;
      if (st && typeof st === "object") nextDue = st.nextDue || {};
      schedNextDue = nextDue; // 供列表显示「下次运行时刻」
      schedHeat = heat;       // 供列表画「跑了没跑」状态点
    } catch (_) { base(); return; } // 后端没起/浏览器态：回落「N 个启用」

    const tk = ymd();
    const now = Date.now();
    const dayStart = new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate()).getTime();
    const bad = [], missed = [], pending = [];
    for (const t of tasks) {
      const agg = heat?.[t.id]?.[tk];
      const hasRunToday = agg && (agg.ok || agg.bad || agg.warn || agg.stop || agg.missed);
      // ⛔ 判据必须用 `last`（当天**最后一次**运行的结果），不能用 `bad`/`missed` 累计计数。
      //    Rust 侧 DayAgg 的语义写得很明确（scheduler.rs）：`last` 才是「最终结果」，
      //    「失败 → 重试成功 ⇒ 显示成功」。计数是全天累计，一旦失败过就永远 >0。
      //    拿计数判异常 ⇒ 早上失败、中午补签成功，状态点已经变绿，标题栏却还挂着「失败」，
      //    两边自相矛盾。用户报的「已经补签了 卡片上面还是显示失败」就是这个。
      //    这里直接复用 schedRunState(agg)，与状态点、热力图同一套口径，不许再分叉。
      const st = schedRunState(agg);
      if (st === "bad") { bad.push(t); continue; }
      if (st === "missed") { missed.push(t); continue; }
      // 到点未跑：nextDue 在「今天 00:00 ~ 现在」之间，且今天完全没跑过
      const nd = nextDue[t.id];
      if (!hasRunToday && typeof nd === "number" && nd > 0 && nd >= dayStart && nd <= now) pending.push(t);
    }

    // 无异常 → 回落「N 个启用」
    if (!bad.length && !missed.length && !pending.length) { base(); return; }
    // 有异常 → 标题栏 [data-extra] 显示内联警告胶囊（含启用数做前缀，保留总量信息）
    const name = (t) => esc(t.name || t.title || "未命名任务");
    const tip = [...bad, ...missed, ...pending].map(name).join("、");
    const cnt = (n, cls, label) => `<span class="sw-item ${cls}" title="${label}：${n.map(name).join("、")}">${label}${n.length}</span>`;
    const parts = [];
    if (bad.length) parts.push(cnt(bad, "sw-bad", "失败"));
    if (missed.length) parts.push(cnt(missed, "sw-missed", "漏跑"));
    if (pending.length) parts.push(cnt(pending, "sw-pending", "到点未跑"));
    extraEl.innerHTML = `<span class="sw-extra" title="今日异常：${tip}"><span class="sw-icon">${ICON_BELL}</span>${parts.join("")}</span>`;
  })();
  // 调用方 await 这个 Promise 就一定能拿到「本次拉取完成后」的 schedHeat/schedNextDue，
  // 不会出现「以为刷新完了、重画出来还是旧状态点」。
  try { return await schedWarnInflight; }
  finally { schedWarnInflight = null; }
}


// 快捷访问：state.quickAccess，点击直接 open_path。
// 布局是两列网格（不是参差不齐的胶囊流）：每项一行「图标 + 名称 + 类型小字」。
// 卡片内容区只有约 89px 高。现在卡片占 4 格宽（span-4），可以铺 5 列 × 3 行 = 15 个格子
// （每格 26px 高 + gap 4px = 86px，稳稳落在 89px 内；图标 18px + 两行文字压到 12/10px）。
// 所以：≤15 项全显示；>15 项时显示 14 项 + 1 个「还有 N 项」，避免 slice 砍掉后
// 用户不知道还剩多少，也避免第 16 格挤出滚动条。
const QUICK_TYPE = { folder: "文件夹", url: "网址", file: "文件" };
const QUICK_ICON = { folder: ICON_FOLDER, url: ICON_GLOBE, file: ICON_DOC };

// ── 快捷访问卡：按分组分块（2 列区块）────────────────────────────────────
//
// 旧版是「5 列 × 3 行 = 15 格」的一维网格，超出压成「还有 N 项」。
// 三个问题（2026-11-10 实测，1280 视口下 quick 卡 828×150、正文区 794×89px）：
//   ① 容量写死 15：本机 17 项，第 16/17 项看不见；
//   ② 完全没用 qaGroups —— 用户在模块里分的组，卡片上毫无体现；
//   ③ 条目等宽拉伸，「豆包」和「json格式化」一样宽，行内留白碎。
//
// 新版：**每组一个区块，区块排成 2 列**，块内条目 flex-wrap 自动换行。
// 为什么是 2 列而不是「每组一整行」：实测后者每行只用掉 18~50% 宽度
// （4 组各占一行，右侧全空）；2 列区块能把利用率提到 34~95%，同一高度
// 装下更多、也更像「分块」。
//
// 容量随尺寸自然伸缩：1 行高约 20 项，放大到 2 行高约 40 项（旧版恒为 15）。
//
// ⛔ 保留 .qa-item / .qa-title / .qa-more 类名：tools/quick-check.mjs 依赖它们。

/// 单组最多渲染多少项。超过折叠成 +N，避免一组膨胀到把别的组挤没。
const QUICK_GROUP_MAX = 24;

function renderQuickCard() {
  const el = cardEl("quick");
  if (!el) return;
  const body = el.querySelector("[data-body]");
  const extra = el.querySelector("[data-extra]");
  const items = state.quickAccess || [];
  const groups = Array.isArray(state.qaGroups) ? state.qaGroups : [];

  if (!items.length) {
    if (extra) extra.textContent = "";
    body.innerHTML = emptyHTML("还没有快捷项，去「快捷访问」加一个");
    return;
  }

  // 按分组归集；顺序沿用 qaGroups（用户拖出来的顺序即显示顺序）。
  // 没有 groupId 的老数据归到第一组，保证一条都不丢。
  const firstGid = groups[0]?.id || "";
  const buckets = groups
    .map((g) => ({ g, list: items.filter((q) => (q.groupId || firstGid) === g.id) }))
    .filter((b) => b.list.length);
  // 兜底：qaGroups 为空 / 所有项都指向不存在的组 ⇒ 退化成单块平铺，
  // 宁可少一层分组，也不能让卡片空白。
  if (!buckets.length) buckets.push({ g: { id: "", name: "" }, list: items });

  if (extra) {
    extra.textContent = buckets.length > 1
      ? `${items.length} 项 · ${buckets.length} 组`
      : `${items.length} 项`;
  }

  const itemHTML = (q) => {
    const type = QUICK_TYPE[q.type] || "链接";
    const icon = QUICK_ICON[q.type] || ICON_GLOBE;
    return `<button class="qa-item" data-qa="${esc(q.id)}" data-type="${esc(q.type || "")}"
      title="${esc(q.title || q.target || "未命名")} · ${esc(type)}"
      aria-label="${esc(q.title || q.target || "未命名")}">
      <span class="qa-icon">${icon}</span>
      <span class="qa-text"><span class="qa-title">${esc(q.title || q.target || "未命名")}</span></span>
    </button>`;
  };

  body.innerHTML = `<div class="qa-blocks">${buckets.map(({ g, list }) => {
    const cap = list.length > QUICK_GROUP_MAX ? QUICK_GROUP_MAX - 1 : list.length;
    const shown = list.slice(0, cap);
    const rest = list.length - shown.length;
    // 组名做成**行内标签**，与条目在同一行流里。
    // ⛔ 不能给每组一个独立标题行：4 组就是 4 行标题，把正文区（89px）
    //    挤掉一半，条目字号只能压到 9px —— 比设计规范下限 10px 还小。
    //    实测改成行内后，17 项只用 2 行（47/89px），字号可回到 11~13px。
    return `<span class="qa-blk">
        <span class="qa-blk__tag" title="${esc(g.name || "全部")}（${list.length} 项）">
          <span class="qa-blk__nm">${esc(g.name || "全部")}</span>
        </span>${shown.map(itemHTML).join("")}${
        rest > 0
          ? `<button class="qa-item qa-more" data-more="1" aria-label="还有 ${rest} 项，点开看全部">
              <span class="qa-icon">${ICON_GRID}</span>
              <span class="qa-text"><span class="qa-title">+${rest}</span></span>
            </button>`
          : ""
      }</span>`;
  }).join("")}</div>`;

  body.querySelectorAll("[data-qa]").forEach((b) => {
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      const q = items.find((x) => x.id === b.dataset.qa);
      if (!q) return;
      invoke("open_path", { target: q.target }).catch(() => toastQuiet("打开失败"));
    });
  });
  // 「+N」不打开具体路径，而是直接进快捷访问模块看全部
  body.querySelectorAll("[data-more]").forEach((b) => {
    b.addEventListener("click", (e) => { e.stopPropagation(); openModule("quickaccess"); });
  });
}

// -------------------- 电子木鱼卡 --------------------
// 「点击即 +1」的功德计数器：整张卡就是按钮，点一下木鱼敲一次、数字跳一下。
//
// 为什么把计数放在 state 而不是内存：
//   关掉应用再打开，功德得还在 —— 否则每次启动归零，这功能就只剩个动画。
//
// 三个数字：
//   total  累计功德（永不清零，除非用户点重置）
//   today  今日功德（跨天自动归零，靠 date 字段判断）
//   date   今日功德归属的日期（YYYY-MM-DD），跨天判定用
//
// 连击（combo）只放内存：它是「一口气敲多少下」的即时反馈，
// 隔几秒就断，没有持久化的意义，写进 state.json 反而多一堆无用的磁盘写。
const COMBO_WINDOW_MS = 900;   // 两下间隔小于这个值算连击
const COMBO_KEEP_MS = 2200;    // 超过这么久没敲，连击归零
let muyuCombo = 0;
let muyuLastAt = 0;
let muyuComboTimer = 0;

function ensureMuyu() {
  if (!state.muyu || typeof state.muyu !== "object" || Array.isArray(state.muyu)) {
    state.muyu = { total: 0, today: 0, date: "" };
  }
  const m = state.muyu;
  if (typeof m.total !== "number" || !isFinite(m.total) || m.total < 0) m.total = 0;
  if (typeof m.today !== "number" || !isFinite(m.today) || m.today < 0) m.today = 0;
  if (typeof m.date !== "string") m.date = "";
  return m;
}

/// 跨天归零：只在读取/敲击时调用，不靠定时器（应用没开的时候不该有定时器在跑）。
function muyuRollDay(m) {
  const today = ymd();
  if (m.date !== today) {
    m.date = today;
    m.today = 0;
  }
}

function renderMuyuCard() {
  const el = cardEl("muyu");
  if (!el) return;
  const body = el.querySelector("[data-body]");
  const extra = el.querySelector("[data-extra]");
  const m = ensureMuyu();
  muyuRollDay(m);
  if (extra) extra.textContent = m.today ? `今日 ${m.today}` : "";
  body.innerHTML = `<div class="my-wrap">
    <span class="my-bell">${ICON_MUYU_BIG}</span>
    <span class="my-num" data-my-num>${m.total}</span>
    <span class="my-cap" data-my-cap>${muyuCombo >= 2 ? `连击 ×${muyuCombo}` : ""}</span>
  </div>`;
}

/// 敲一下。只改数字和连击文案，不整卡 innerHTML ——
/// 那样会打断正在播的缩放动画（动画在 .my-bell 上，重建会把元素换掉）。
function muyuHit() {
  const el = cardEl("muyu");
  if (!el) return;
  const m = ensureMuyu();
  muyuRollDay(m);

  const now = Date.now();
  muyuCombo = now - muyuLastAt <= COMBO_WINDOW_MS ? muyuCombo + 1 : 1;
  muyuLastAt = now;
  m.total += 1;
  m.today += 1;
  saveState();

  // 数字与今日数
  const num = el.querySelector("[data-my-num]");
  if (num) num.textContent = m.total;
  const extra = el.querySelector("[data-extra]");
  if (extra) extra.textContent = `今日 ${m.today}`;
  const cap = el.querySelector("[data-my-cap]");
  if (cap) cap.textContent = muyuCombo >= 2 ? `连击 ×${muyuCombo}` : "";

  // 敲击动画：先摘掉再加回，强制重启动画（连续快速点击也能每次都播）
  const bell = el.querySelector(".my-bell");
  if (bell) {
    bell.classList.remove("is-hit");
    void bell.offsetWidth;
    bell.classList.add("is-hit");
  }
  // 连击归零：这段时间内没再敲就收起连击文案（正常态不显示任何文字）
  clearTimeout(muyuComboTimer);
  muyuComboTimer = setTimeout(() => {
    muyuCombo = 0;
    const c = el.querySelector("[data-my-cap]");
    if (c) c.textContent = "";
    const b = el.querySelector(".my-bell");
    if (b) b.classList.remove("is-hit");
  }, COMBO_KEEP_MS);
}

// -------------------- 签到积分卡 --------------------
// 数据源：签到脚本写的结果文件（路径唯一真相在 config.js 的 CHECKIN_RESULT_DIR）。
//   last_result.json       → WorkBuddy（腾讯 CodeBuddy）
//   trae_last_result.json  → Trae CN
//
// ⛔ 两个平台的字段语义**不一样**，不能拿同名字段硬凑：
//   WorkBuddy：remaining = 钱包可用余额（要显示的就是它）
//              credits   = 本次签到得到的积分（"签到成功 +100 积分" 里的 100）
//   Trae：      credits   = 可用积分余额（detail 文案就是「签到成功，可用积分 3690.2」）
//   拿 WorkBuddy 的 credits 当余额会显示成 +100，看着像余额归零。
//
// 文件缺失 / 没签到过 / 浏览器 dev 态（invoke 返回 undefined）一律降级成「—」，
// 绝不抛异常 —— 这张卡不能因为读不到文件就把整个网格拖垮。
const CREDITS_TTL = 60 * 1000;
const creditsCache = { at: 0, wb: null, trae: null };
let creditsLoading = false;

// 实时查询用的 checkin 实例（与签到卡各建一个，互不干扰）。
// 只在用户点刷新时用：balanceOnly/statusOnly 都是**只读**接口，不领取积分、不签到。
const liveCheckin = createCheckin({
  crypto: globalThis.crypto,
  httpPost: (url, body, headers) => invoke("http_post", { url, body, headers }),
  httpGet: (url, headers) => invoke("http_get", { url, headers }),
  collectState: (kind) => invoke("collect_checkin_state", { kind }),
  wait: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
});

const creditsDir = () => {
  const d = state.ai?.checkin?.resultDir;
  return typeof d === "string" && d.trim() ? d.trim() : CHECKIN_RESULT_DIR;
};

// 余额格式化：整数不带小数点，小数最多留 1 位（3690.2 而不是 3690.20）
function fmtCredit(n) {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  const v = Number(n);
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

// 解析单个结果文件。kind 决定「哪个字段是余额」以及 Trae 只认 CN 账号。
function parseCreditFile(text, kind) {
  if (typeof text !== "string" || !text.trim()) return null;
  let j;
  try { j = JSON.parse(text); } catch (e) { return null; }
  const all = Array.isArray(j?.results) ? j.results : [];
  const list = kind === "trae"
    // Trae 结果文件里可能混着国际版账号，只取 Trae CN（与 ai.js 的 isTraeCnAccount 同口径）
    ? all.filter((r) => {
        const n = String((r && r.account) || "").replace(/\s+/g, " ").trim().toLowerCase();
        return n === "trae cn" || n === "";
      })
    : all;
  if (!list.length) return null;

  const t = j.time ? Date.parse(j.time) : NaN;
  const time = Number.isFinite(t) ? t : 0;
  // ⛔ 跨天闸门：结果文件是「取数那一刻的快照」，不是持续状态。
  // 只认 status 成功会让昨天的文件今天还写着「今日已签」（ai.js 的 gateToday 防的就是这个）。
  // 判定 = 状态成功 **且** 快照时间落在今天；余额照常显示（那是上次已知值）。
  const okStatus = list.some((r) => r.status === "success" || r.status === "already_claimed");
  const signedToday = okStatus && !!time && ymd(new Date(time)) === ymd();
  // 余额：WorkBuddy 只认 remaining（credits 是本次所得，不是余额）；Trae 认 credits
  let balance = null;
  let earned = null;
  for (const r of list) {
    const raw = kind === "workbuddy"
      ? (r.remaining != null ? r.remaining : null)
      : (r.credits != null ? r.credits : null);
    const v = raw == null ? null : Number(raw);
    if (v != null && Number.isFinite(v)) balance = (balance || 0) + v;
    if (kind === "workbuddy" && r.credits != null) {
      const e = Number(r.credits);
      if (Number.isFinite(e)) earned = (earned || 0) + e;
    }
  }
  return {
    balance,
    earned,
    signedToday,
    time,
    detail: String(list[0]?.detail || ""),
  };
}

// 从 state.ai.checkin 取「面板里签到/查询得到的实时结果」。
// ⛔ 为什么必须优先用它：last_result.json 是**外部签到脚本**写的，只有脚本跑过才更新；
//    面板里的「立即签到 / 重新查询」走的是实时接口（ai-checkin.js），结果只进内存 + state，
//    从不写回那个文件。所以只看文件的话，点刷新永远读到早上那份旧快照 —— 用户报的就是这个。
// 面板结果里 credits/remaining 的语义按平台分别取（同 parseCreditFile 的口径）。
function creditsFromState(kind) {
  const c = state.ai?.checkin?.[kind];
  const accs = Array.isArray(c?.accounts) ? c.accounts : [];
  if (!accs.length) return null;
  const at = Number(c.lastRun) || 0;
  const signedToday = !!at && ymd(new Date(at)) === ymd() &&
    accs.some((r) => r.signedToday === true);
  let balance = null;
  let earned = null;
  for (const r of accs) {
    // WorkBuddy：remaining 才是余额；Trae：credits 就是余额
    const raw = kind === "workbuddy"
      ? (r.remaining != null ? r.remaining : (r.credits != null ? r.credits : null))
      : (r.credits != null ? r.credits : null);
    const v = raw == null ? null : Number(raw);
    if (v != null && Number.isFinite(v)) balance = (balance || 0) + v;
    if (kind === "workbuddy" && r.earned != null) {
      const e = Number(r.earned);
      if (Number.isFinite(e)) earned = (earned || 0) + e;
    }
  }
  if (balance == null) return null;
  return {
    balance,
    earned,
    signedToday,
    time: at,
    detail: String(accs[0]?.detail || ""),
    from: "state",   // 标记来源：面板实时
  };
}

// 两份数据取「更新时间更晚」的那份。面板实时结果通常比磁盘快照新。
function newer(a, b) {
  if (!a) return b;
  if (!b) return a;
  return (b.time || 0) > (a.time || 0) ? b : a;
}

async function loadCredits(force = false) {
  // ⛔ 提前返回也不能吞掉「定时任务卡状态同步」：签到卡刷新按钮和关闭浮层都会带 force，
  //    而积分卡可能正好在加载中（creditsLoading）。这时积分由在飞的那次负责，
  //    但 sched 卡的状态必须照刷 —— 它是独立数据源，跟积分加载状态无关。
  if (creditsLoading) {
    if (force) refreshSchedWarnings().then(() => renderSchedCard()).catch(() => {});
    return;
  }
  if (!force && Date.now() - creditsCache.at < CREDITS_TTL) return;
  creditsLoading = true;
  // 先把按钮切到「读取中」，让用户知道点了有反应（实时查询要发网络请求，可能几百毫秒）
  renderCreditsCard();
  try {
    const dir = creditsDir();
    const [wbRes, traeRes] = await Promise.allSettled([
      invoke("read_text_file", { path: dir + "\\last_result.json" }),
      invoke("read_text_file", { path: dir + "\\trae_last_result.json" }),
    ]);
    const wbFile = wbRes.status === "fulfilled" ? parseCreditFile(wbRes.value, "workbuddy") : null;
    const traeFile = traeRes.status === "fulfilled" ? parseCreditFile(traeRes.value, "trae") : null;
    // 面板实时结果 vs 磁盘快照：谁新用谁。两边都没有就留 null（卡片走空状态）
    creditsCache.wb = newer(creditsFromState("workbuddy"), wbFile);
    creditsCache.trae = newer(creditsFromState("trae"), traeFile);

    // 用户主动点刷新 → 再发一次实时查询（只读接口，不签到）。
    // ⛔ 这一步是关键：只重读文件的话，文件是外部脚本写的，不跑脚本就永远是旧快照。
    if (force) {
      const [wbLive, traeLive] = await Promise.allSettled([
        liveCheckin.statusOnly("workbuddy"),
        liveCheckin.balanceOnly("trae"),
      ]);
      const wbNow = wbLive.status === "fulfilled" ? creditsFromLive(wbLive.value, "workbuddy") : null;
      const traeNow = traeLive.status === "fulfilled" ? creditsFromLive(traeLive.value, "trae") : null;
      if (wbNow) {
        creditsCache.wb = wbNow;
        // 同步回 state，面板打开时也能看到这次刷新的结果
        state.ai.checkin.workbuddy.accounts = wbLive.value;
        state.ai.checkin.workbuddy.lastRun = Date.now();
      }
      if (traeNow) {
        creditsCache.trae = traeNow;
        state.ai.checkin.trae.accounts = traeLive.value;
        state.ai.checkin.trae.lastRun = Date.now();
      }
      if (wbNow || traeNow) saveState();
    }
  } catch (e) {
    creditsCache.wb = null;
    creditsCache.trae = null;
  } finally {
    creditsCache.at = Date.now();
    creditsLoading = false;
  }
  renderCreditsCard();
  // ⛔ 签到卡的「刷新」按钮只走 loadCredits(true)，不经过 closeModule ——
  //    签到脚本本身就是一个定时任务，签到成功后它的今日状态（heat.last）也会变，
  //    定时任务卡必须跟着更新，否则用户签完回来看到状态点还是旧的。
  //    force=true 才拉：心跳里的 loadCredits() 是节流调用，不该每次都多打两个 IPC。
  if (force) refreshSchedWarnings().then(() => renderSchedCard()).catch(() => {});
}

// 把实时查询返回的账号数组转成卡片用的结构（口径同 creditsFromState）
function creditsFromLive(list, kind) {
  if (!Array.isArray(list) || !list.length) return null;
  let balance = null;
  let earned = null;
  let signed = false;
  for (const r of list) {
    const raw = kind === "workbuddy"
      ? (r.remaining != null ? r.remaining : (r.credits != null ? r.credits : null))
      : (r.credits != null ? r.credits : null);
    const v = raw == null ? null : Number(raw);
    if (v != null && Number.isFinite(v)) balance = (balance || 0) + v;
    if (kind === "workbuddy" && r.earned != null) {
      const e = Number(r.earned);
      if (Number.isFinite(e)) earned = (earned || 0) + e;
    }
    if (r.signedToday === true) signed = true;
  }
  if (balance == null) return null;
  return {
    balance,
    earned,
    signedToday: signed,
    time: Date.now(),
    detail: String(list[0]?.detail || ""),
    from: "live",   // 标记来源：实时接口
  };
}

// 单栏：平台名（带状态点）→ 余额大字 → 状态备注，纵向三段。
// 左右并排两栏，中间由 CSS 画分割线（不用额外元素）。
function creditsCol(title, item) {
  const note = !item
    ? "未签到"
    : item.signedToday
      ? (item.earned != null && item.earned > 0 ? `今日 +${fmtCredit(item.earned)}` : "今日已签")
      : (item.time ? `${new Date(item.time).getMonth() + 1}/${new Date(item.time).getDate()} 记录` : "未签到");
  const val = item && item.balance != null ? fmtCredit(item.balance) : "—";
  const cls = !item ? " is-empty" : (item.signedToday ? " is-signed" : "");
  const tip = item
    ? `${title}：${val} 积分\n${item.detail || note}${item.time ? `\n更新于 ${hhmm(new Date(item.time))}` : ""}`
    : `${title}：还没有签到记录`;
  return `<div class="cr-col${cls}" aria-label="${esc(tip.replace(/\n/g, " "))}">
    <div class="cr-head">
      <span class="cr-dot${item && item.signedToday ? " is-on" : ""}"></span>
      <span class="cr-name">${esc(title)}</span>
    </div>
    <div class="cr-val">${esc(val)}</div>
    <div class="cr-note">${esc(note)}</div>
  </div>`;
}

function renderCreditsCard() {
  const el = cardEl("credits");
  if (!el) return;
  const body = el.querySelector("[data-body]");
  const extra = el.querySelector("[data-extra]");
  const c = creditsCache;
  // 右上角：读取时间 + 刷新按钮。签到是外部脚本写的文件，卡片不会自己知道文件变了，
  // 所以必须给一个手动入口 —— 否则只能等 60s TTL 过期，或者去 AI 面板里签到回来再看。
  if (extra) {
    extra.innerHTML = `<button class="cr-refresh${creditsLoading ? " is-busy" : ""}" data-credits-refresh aria-label="重新读取签到结果（签到后点这里）">${
      ICON_REFRESH
    }<span class="cr-refresh-label">${creditsLoading ? "读取中" : (c.at ? esc(hhmm(new Date(c.at))) : "刷新")}</span></button>`;
    const btn = extra.querySelector("[data-credits-refresh]");
    if (btn) {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        loadCredits(true);
      });
    }
  }
  if (!c.wb && !c.trae) {
    body.innerHTML = emptyHTML("还没有签到记录，点「展开」去签到");
    return;
  }
  body.innerHTML = `<div class="cr-grid">
    ${creditsCol("WorkBuddy", c.wb)}
    ${creditsCol("Trae", c.trae)}
  </div>`;
}

// -------------------- 灵感碎片：星空卡 --------------------
// 「一颗灵感一颗星」，但不是排成格子 —— 是撒在天上的星芒：
//   · 星形用 ICON_SPARK（四角星芒，和 AI 资讯卡同一个星星形状），不是五角星
//   · 位置：黄金角螺旋（137.508°），第 i 颗星的半径 = sqrt((i+0.5)/STAR_FILL)
//     → 第 1 颗紧贴中心，越往后越往外，随灵感增多从中间自然扩散开来；
//     → 黄金角保证任何数量都不会挤成一条直线或重叠成一坨。
//   · 每颗星的大小 / 色相 / 亮度都是**由 index 决定的稳定伪随机**，
//     重画时不会乱跳（不能用 Math.random，否则每秒心跳都会重新洗牌）。
//   · ⛔ 星图**没有任何动画**（原来的 twinkle 无限动画已删）。核显 2880x1800 下实测：
//     那个 ease-in-out 无限动画常驻吃 13.8% GPU，删掉后掉到 0.6%（-95%）。
//     视觉层次全靠「大小 + 色相 + 亮度」三个维度的差异，静态就已经够看。
const STAR_CAP = 20;    // 20 颗大星就够铺满整卡（再多会挤，收成「+N」）
const STAR_FILL = 20;   // 第 i 颗星落在半径 sqrt((i+0.5)/STAR_FILL) 处
const GOLDEN_DEG = 137.508;

// 星云色相盘：金 → 橙 → 粉 → 紫 → 蓝 → 青，绕一圈回来。
// 取 HSL 而不是写死色值，是为了让每颗星只差一个 --h，CSS 那边一行 hsl() 就够。
const STAR_HUE_BASE = 38;   // 从暖金开始
const STAR_HUE_SPAN = 300;  // 绕 300°（留 60° 缺口，避免首尾撞色）

// 稳定伪随机：同一个 index 永远得到同一个值（换成 Math.random 会让星星每次心跳都跳动）
function starRnd(i, salt) {
  const x = Math.sin(i * 12.9898 + salt * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

function renderIdeasCard() {
  const el = cardEl("ideabox");
  if (!el) return;
  const body = el.querySelector("[data-body]");
  const extra = el.querySelector("[data-extra]");
  const ideas = Array.isArray(state.ideabox) ? state.ideabox : [];
  const n = ideas.length;
  if (extra) extra.textContent = n ? `${n}` : "";
  if (!n) {
    body.innerHTML = emptyHTML("还没有灵感，点开记一条");
    return;
  }
  const shown = Math.min(n, STAR_CAP);
  const rest = n - shown;
  const stars = Array.from({ length: shown }, (_, i) => {
    // 半径：越靠后的星离中心越远 → 灵感增多时星野从中心向外扩
    const r = Math.sqrt((i + 0.5) / STAR_FILL);
    const ang = (i * GOLDEN_DEG) * Math.PI / 180;
    // 椭圆半径取卡片的「内切椭圆」：横向留 7%、纵向留 9% 给星身，最外圈不会被裁掉。
    // 卡是扁的（194x102），所以横向半径远大于纵向 —— 星野自然铺满整张扁卡。
    const x = 50 + 43 * r * Math.cos(ang);
    const y = 50 + 41 * r * Math.sin(ang);
    const size = 10 + starRnd(i, 1) * 11;             // 10~21px：大小差异做近远层次
    // 色相：黄金角铺开 + 一点抖动，保证相邻两颗一定不同色，且整体不出现明显色带
    const hue = Math.round(
      (STAR_HUE_BASE + i * GOLDEN_DEG * 0.9 + starRnd(i, 2) * 26) % STAR_HUE_SPAN
    );
    // 亮度：小星更淡、大星更亮 → 静态也有一眼能看出的深浅层次
    const op = (0.38 + (size - 10) / 11 * 0.5 + starRnd(i, 3) * 0.12).toFixed(2);
    return `<span class="idea-star" style="left:${x.toFixed(2)}%;top:${y.toFixed(2)}%;--s:${size.toFixed(1)}px;--h:${hue};--o:${op}">${ICON_SPARK}</span>`;
  }).join("");
  body.innerHTML = `<div class="idea-sky" aria-label="共 ${n} 条灵感">${stars}${
    rest > 0 ? `<span class="idea-star-more">+${rest}</span>` : ""
  }</div>`;
}

// -------------------- 禅道卡 --------------------
// 四个数字：未完成需求 / 未验证需求 / 未完成 Bug / 未验证 Bug。
// 数据源 state.emsStats 由后台线程写入（本卡只读）。
// ⛔ null 与 0 必须区分：null = 还没抓过（显示「—」），0 = 真的没有了。
//    混用会让「今天全清完了」和「压根没数据」看起来一模一样。
const EMS_CELLS = [
  { key: "reqOpen",       group: "需求", label: "未完成", tone: "warn"  },
  { key: "reqUnverified", group: "需求", label: "未验证", tone: "check" },
  { key: "bugOpen",       group: "Bug",  label: "未完成", tone: "warn"  },
  { key: "bugUnverified", group: "Bug",  label: "未验证", tone: "check" },
];

function emsValue(s, key) {
  const n = s ? s[key] : null;
  return Number.isFinite(Number(n)) && n !== null && n !== "" ? Number(n) : null;
}

function renderEmsCard() {
  const el = cardEl("ems");
  if (!el) return;
  const body = el.querySelector("[data-body]");
  const extra = el.querySelector("[data-extra]");
  const s = state.emsStats;
  const at = Number(s?.updatedAt) || 0;

  // 右上角：和「签到积分」卡同一套写法 —— 刷新按钮 + 时间，而不是一个裸时间。
  // 抓取是后台每 15 分钟一轮，用户想立刻看新数据时得有个手动入口。
  if (extra) {
    const label = s?.error ? "抓取失败" : (at ? hhmm(new Date(at)) : "刷新");
    extra.innerHTML = `<button class="cr-refresh${s?.error ? " is-stale" : ""}" data-ems-refresh${
      s?.error ? ` aria-label="${esc(s.error)}"` : ' aria-label="重新读取统计快照"'
    }>${ICON_REFRESH}<span class="cr-refresh-label">${esc(label)}</span></button>`;
    const btn = extra.querySelector("[data-ems-refresh]");
    if (btn) {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        // 真的去抓一轮，不是只重画 —— 抓完结果走 provider-emit 回来，
        // app.js 落进 state 后 watch("ems") 会自动重画这张卡。
        btn.classList.add("is-busy");
        // ⛔ 必须兜底摘掉 is-busy。它平时靠 renderEmsCard 重建 innerHTML 被动清除，
        // 而重画由 watch("ems") 签名变化触发。若签名不含 updatedAt，抓回来的四个
        // 数字和上次一样时就不重画 —— 按钮上的 .is-busy 会让图标无限旋转，
        // 看起来像「一直在转但没有数据」。
        // 现在签名已带 updatedAt（每次成功抓取都会重画），这里的 45s 定时器
        // 只兜「网络失败 / 命令不存在 / emit 丢失」这几种重画不会发生的情况。
        // 45s = 30s 网络超时 + 登录 + 余量，不提前停转，否则数据还没到图标就停了。
        setTimeout(() => btn.classList.remove("is-busy"), 45000);
        try {
          await invoke("ems_refresh_now");
        } catch {
          // 命令不存在（纯浏览器预览）或调用失败：立刻停转 + 重画，
          // 至少让时间/错误反映当前 state，而不是一直转。
          btn.classList.remove("is-busy");
          renderEmsCard();
        }
      });
    }
  }

  const has = s && typeof s === "object";
  // 布局：每格「数字在左、分组+标签在右」，横向排开。比原来上下堆三行省一半高度，
  // 数字也就能放大了 —— 卡片正文只有约 115px 高，竖排时字号被逼到 17px。
  const cells = EMS_CELLS.map((c) => {
    const n = has ? emsValue(s, c.key) : null;
    const cls = ["we-cell", `we-cell--${c.tone}`]
      .concat(n === 0 ? ["is-zero"] : [])
      .concat(n == null ? ["is-none"] : [])
      .join(" ");
    return `<div class="${cls}">
      <span class="we-num">${n == null ? "—" : esc(String(n))}</span>
      <span class="we-cap"><span class="we-grp">${esc(c.group)}</span>${esc(c.label)}</span>
    </div>`;
  }).join("");
  body.innerHTML = `<div class="we-grid">${cells}</div>`;
}

// -------------------- 小卡徽标 --------------------
// 小卡徽标：待办剩余数等
// 注：原来挂在 worklog 小卡上的徽标随工作记录面板一起移除（那张卡已不存在）。
function renderBadges() {
  const st = Tasks.stats();
  const badge = cardEl("tasks")?.querySelector("[data-badge]");
  if (badge) {
    const n = st.remain;
    badge.hidden = !n;
    badge.textContent = n > 99 ? "99+" : String(n);
  }
}

function renderAllCards() {
  renderTasksCard();
  renderNotesCard();
  renderMusicCard();
  renderSchedCard();
  renderQuickCard();
  renderMuyuCard();
  renderCreditsCard();
  renderIdeasCard();
  renderEmsCard();
  renderBadges();
}

// -------------------- 底部任务栏 --------------------
function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) return "0:00";
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}
function fmtDate(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

let toastQuiet = () => {};
export function setQuietToast(fn) { toastQuiet = fn || (() => {}); }

// 系统指标：来自 provider-emit("system")（Rust 每秒推）
// CPU / 内存 / 磁盘都是纯展示 —— 系统健康浮层已整体移除，这里就是唯一的查看入口。
//
// 防抖动的关键：只写数字，不写标签和 %。
// 标签（CPU/内存/磁盘）和百分号是 HTML 里固定的，数字段由 CSS 给了固定宽度
// （.tm-num 的 ch 单位），所以「5」和「100」占的宽度一样，
// 底部栏整组总宽恒定 —— 不会因为数值位数变化而左右挪动。
function bindTaskbarSystem() {
  const cpuVal = document.getElementById("tb-cpu-val");
  const ramVal = document.getElementById("tb-ram-val");
  const diskVal = document.getElementById("tb-disk-val");
  const diskEl = document.getElementById("tb-disk");

  // 磁盘：多个盘合并成一个「总占用率」。
  // 口径是「所有磁盘已用总和 / 容量总和」而非各盘使用率的平均 ——
  // 后者会让一块 99% 的小盘和一块 10% 的 2T 大盘权重相同，读数是失真的。
  // 明细放 title，鼠标悬停即可看到每个盘的占用。
  const paintDisk = (list) => {
    if (!diskVal || !Array.isArray(list) || !list.length) return;
    let used = 0, total = 0;
    const parts = [];
    for (const d of list) {
      const t = Number(d.totalGb ?? 0), u = Number(d.usedGb ?? 0);
      if (!(t > 0)) continue;
      used += u;
      total += t;
      // mount 形如 "C:"，自带冒号，这里不再补 —— 否则会出现 "C::" 
      const label = String(d.mount || d.name || "?").trim();
      parts.push(`${label} ${Number(d.pct ?? 0).toFixed(0)}%`);
    }
    if (!(total > 0)) return;
    const pct = (used / total) * 100;
    diskVal.textContent = String(Math.round(pct));
    diskVal.parentElement?.parentElement?.setAttribute("data-ready", "1");
    // 高占用转警示色：和 CPU/内存保持同一套「越满越警示」的语义
    if (diskEl) diskEl.classList.toggle("warn", pct >= 85);
    // ⛔ 用 aria-label 而不是 title：用户明确要求底部栏不要原生 tooltip。
    //    明细（各盘符占用）仍然保留在这里，供读屏与检查脚本读取。
    if (diskEl) diskEl.setAttribute("aria-label", `磁盘占用 ${pct.toFixed(1)}%\n${parts.join("\n")}`);
  };

  Bus.on("provider-emit", ({ config_hash, output }) => {
    if (config_hash !== "system") return;
    // data-ready=1 后百分号才显示 —— 首帧之前是 "--"，不该出现 "--%" 这种怪组合
    if (cpuVal) { cpuVal.textContent = String(Math.round(output.cpu ?? 0)); cpuVal.parentElement?.parentElement?.setAttribute("data-ready", "1"); }
    if (ramVal) { ramVal.textContent = String(Math.round(output.ram ?? 0)); ramVal.parentElement?.parentElement?.setAttribute("data-ready", "1"); }
    // disks 是静态字段，Rust 每 5 秒随 static 一起推；缺省时保留上一帧
    if (Array.isArray(output.disks) && output.disks.length) paintDisk(output.disks);
  });
}

// -------------------- 外设状态（任务栏胶囊 + 详情浮层）--------------------
// 数据来自 Rust peripheral.rs 的 provider-emit("peripheral")，3 秒一轮。
//
// 为什么放 Rust 而不是前端：WebView2 里 enumerateDevices() 未授权麦克风时
// 只返回 3 个占位项、label 与 deviceId 全空 —— 前端只能知道"设备数变了"，
// 不知道"变的是耳机还是扬声器"。要区分类型必须读 PKEY_AudioEndpoint_FormFactor。
//
// 交互：胶囊常驻只显示「有没有连」，点一下展开浮层看真实设备名。
// 浮层挂在 body 末尾（不在 taskbar 内），因为 taskbar 有 overflow 裁剪，
// 向上弹出会被切掉。
let periphData = null;
let periphPopOpen = false;

// 音频设备归类到胶囊的三个槽位。
// 耳机槽：headphone / headset 且是输出流 —— 耳麦(Headset)也算耳机，
// 因为用户视角"戴上耳机听歌"是同一件事。
// 扬声器不算耳机槽：内置扬声器永远在，算进去会让耳机图标恒亮，失去意义。
function periphSlots(audio) {
  const list = Array.isArray(audio) ? audio : [];
  const out = list.filter((a) => a && a.flow === "out");
  const hp = out.find((a) => a.kind === "headphone" || a.kind === "headset");
  return { headphone: hp || null, outputs: out };
}

// 被用户忽略的输入设备 id 集合（"VID:PID:MI_xx:COLxx"）。
// 存在 state.periphIgnore，跨会话保留。
//
// 为什么需要这个：扩展坞 / 无线接收器的 HID 芯片会向系统报告自己是键鼠，
// Windows 认为它们真实存在，任何 API 都会看到。而罗技 Unifying 接收器
// 是同样的签名（一个 USB 设备同时暴露鼠标+键盘），自动判"假"会误杀真设备。
// 所以把判断权交给用户，本鱼只负责把设备身份如实摆出来。
function periphIgnored() {
  const arr = state.periphIgnore;
  return Array.isArray(arr) ? arr : [];
}

// 用户手动「计入」的设备 id（覆盖 viaHub 的默认排除）。
// 场景：用户真把键盘鼠标插在扩展坞上用 —— viaHub 会误判成假设备，
// 点「计入」把它加回白名单。
function periphIncluded() {
  const arr = state.periphInclude;
  return Array.isArray(arr) ? arr : [];
}

// 过滤掉不该计入的设备，返回 { mouse, keyboard, ignoredCount, hubCount }
//
// 两条排除规则：
//   1. 用户手动「忽略」的（state.periphIgnore）
//   2. 经 USB Hub 上游的（viaHub=true）—— 扩展坞自带的 HID 芯片会冒充键鼠，
//      实测本机 VID_1EA7&PID_0066 挂在 VIA/Genesys 双级 Hub 下面，
//      拔掉所有真键鼠它依然报"已连接"。但用户把真键鼠插扩展坞上时也会命中，
//      所以浮层里仍列出来并标注「经扩展坞」，可手动恢复计入。
function periphInputCounts(data) {
  const ignored = new Set(periphIgnored());
  const included = new Set(periphIncluded());
  const rawMouse = Number(data?.mouse ?? 0);
  const rawKeyboard = Number(data?.keyboard ?? 0);
  const mList = Array.isArray(data?.mouseDevices) ? data.mouseDevices : [];
  const kList = Array.isArray(data?.keyboardDevices) ? data.keyboardDevices : [];

  // 没有明细（旧数据 / dev mock）时无法过滤，直接用原始数量。
  // 明细为空 → 胶囊那边取不到电量，自然不画环（有线设备本来也没电量）。
  if (!mList.length && !kList.length) {
    return { mouse: rawMouse, keyboard: rawKeyboard, ignoredCount: 0, hubCount: 0, mouseReady: [], keyboardReady: [] };
  }
  // 蓝牙设备：**按设备如实呈现**，不猜它是键盘还是鼠标。
  //
  // 为什么放弃判定主属性（2026-11-11 实测，这是本模块最绕的一处）：
  //   本机同时连着两把蓝牙设备，它们的 HID 报告描述符**逐字段完全相同**：
  //     MCHOSE G87 V2-1（键盘）  usage=0x06 Keyboard ×2 / usage=0x02 Mouse ×1
  //     Professor 1（鼠标）      usage=0x06 Keyboard ×2 / usage=0x02 Mouse ×1
  //   btnCaps / valCaps 也一样，类归属（Keyboard 类 + Mouse 类）也一样。
  //   试过的三种判据都会在某台上翻车：
  //     「键盘优先」→ 蓝牙鼠标被吞（用户反馈过）；
  //     「鼠标优先」→ 蓝牙键盘被吞；
  //     「按设备名关键词」→ "MCHOSE G87 V2-1" 里没有 keyboard 字样，判错。
  //   所以不再猜。每台设备按 MAC 独立成条（Rust 侧已改为 bluetooth:<MAC>），
  //   同时具备哪种能力就进哪个列表，两个列表都进也无妨 —— 它们 id 相同，
  //   计数时按 id 去重，不会重复累加。
  const isBt = (d) => !!d?.bluetooth;
  const count = (list) =>
    list.filter((d) => {
      if (ignored.has(d?.id)) return false;
      if (d?.viaHub && !included.has(d?.id)) return false;
      return true;
    }).length;
  const hubOf = (list) =>
    list.filter((d) => !ignored.has(d?.id) && d?.viaHub && !included.has(d?.id)).length;

  // ⛔ 按 **id 去重**而不是按列表长度：
  //    同一台蓝牙设备会同时出现在 mouseDevices 与 keyboardDevices 里（同一条、同 id），
  //    len() 会把它数两遍（实测变「鼠标 2 / 键盘 2」，而桌上只有两台设备）。
  const uniqBy = (list) => {
    const seen = new Set();
    return list.filter((d) => {
      const id = d?.id;
      if (!id) return true;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  };
  const mListU = uniqBy(mList.filter((d) => !ignored.has(d?.id) && (!d?.viaHub || included.has(d?.id))));
  const kListU = uniqBy(kList.filter((d) => !ignored.has(d?.id) && (!d?.viaHub || included.has(d?.id))));
  const m = mListU.length;
  const k = kListU.length;

  // 忽略数只按设备算一次（同一台蓝牙设备在两个列表里是重复的）
  const ignoredIds = new Set();
  for (const d of [...mList, ...kList]) {
    if (d?.id && ignored.has(d.id)) ignoredIds.add(d.id);
  }
  const hubCount = hubOf(mList) + hubOf(kList);
  // btDevices：蓝牙设备去重后的完整清单，供浮层「按设备列一条」渲染
  const btMap = new Map();
  for (const d of [...mList, ...kList]) {
    if (isBt(d) && d?.id && !btMap.has(d.id)) btMap.set(d.id, d);
  }
  // 胶囊要按类取「最低电量」的设备，所以把**过滤后**的明细也带出去。
  // 注意是过滤后的列表（mListU/kListU），不能返回原始列表 ——
  // 否则被忽略/经扩展坞排除的设备会参与取最低值，环显示一台它压根没计入的设备。
  return {
    mouse: m, keyboard: k, ignoredCount: ignoredIds.size, hubCount,
    btDevices: [...btMap.values()],
    mouseReady: mListU, keyboardReady: kListU,
  };
}

function paintPeriph(data) {
  periphData = data || {};
  const pill = document.getElementById("tb-periph");
  if (!pill) return;

  const slots = periphSlots(periphData.audio);
  const { mouse, keyboard, hubCount, mouseReady, keyboardReady } = periphInputCounts(periphData);

  const setSlot = (kind, on) => {
    const el = pill.querySelector(`.pi[data-kind="${kind}"]`);
    if (!el) return;
    el.dataset.on = on ? "1" : "0";
  };
  // 电量：取该类设备里**电量最低**的那台（用户选择）。
  // 理由：这是一圈告警性质的指示 —— 哪台快没电就先看见哪台；
  // 取平均会掩盖「某台只剩 8%」，取第一台则取决于列表顺序（不稳定）。
  // 拿不到电量（null）就**不画环**，不能当成 0% —— 有线设备本就没有电池。
  // 返回 { pct, name }：环只画百分比，但提示里要能说清是哪台设备的电量。
  const lowest = (list) => {
    let best = null;
    for (const d of Array.isArray(list) ? list : []) {
      const b = d?.battery;
      if (typeof b !== "number" || !Number.isFinite(b)) continue;
      if (best == null || b < best.pct) best = { pct: b, name: d?.name || d?.type || "" };
    }
    return best;
  };
  const battLevel = (p) => (p <= 10 ? "crit" : p <= 20 ? "low" : p <= 50 ? "mid" : "hi");

  const setBatt = (kind, info) => {
    const el = pill.querySelector(`.pi[data-kind="${kind}"]`);
    if (!el) return;
    if (info == null) {
      // 没有电量：撤掉环，回到原样（不能留一个灰环冒充 0%）
      el.removeAttribute("data-batt");
      el.removeAttribute("data-lv");
      el.style.removeProperty("--p");
      return;
    }
    const p = Math.max(0, Math.min(100, Math.round(info.pct)));
    el.dataset.batt = "1";
    el.dataset.lv = battLevel(p);
    el.style.setProperty("--p", String(p));
  };

  setSlot("headphone", !!slots.headphone);
  setSlot("mouse", mouse > 0);
  setSlot("keyboard", keyboard > 0);

  // 耳机槽只有一台（音频端点里第一个 headphone/headset）
  const hBatt = lowest([slots.headphone]);
  const mBatt = lowest(mouseReady);
  const kBatt = lowest(keyboardReady);
  setBatt("headphone", hBatt);
  setBatt("mouse", mBatt);
  setBatt("keyboard", kBatt);

  pill.dataset.ready = "1";

  // 悬停提示：没连时说"未连接"，连了就给设备名/数量，有电量再补「xx%」。
  // 环只表达大概程度，具体数字在这里给（读屏可读，不弹原生 tooltip）。
  const withBatt = (base, info) => (info ? `${base} · 电量 ${Math.round(info.pct)}%` : base);
  const hpTip = slots.headphone
    ? withBatt(`耳机：${slots.headphone.name || slots.headphone.type}`, hBatt)
    : "耳机：未连接";
  const tips = [
    hpTip,
    withBatt(`鼠标：${mouse > 0 ? `已连接 ${mouse} 个` : "未连接"}`, mBatt),
    withBatt(`键盘：${keyboard > 0 ? `已连接 ${keyboard} 个` : "未连接"}`, kBatt),
  ];
  // 有经扩展坞的设备未计入时，提示里说清楚，避免用户以为漏检
  if (hubCount > 0) tips.push(`（另有 ${hubCount} 个经扩展坞的设备未计入）`);
  // ⛔ 用 aria-label 而不是 title：用户明确要求底部栏不要原生 tooltip。
  //    设备明细仍然保留在这里（读屏 + 检查脚本用），可见详情走点击后的 #periph-pop。
  pill.setAttribute("aria-label", tips.join("\n"));

  // 浮层开着时同步刷新内容（否则展开后要等 3 秒才有数据）
  if (periphPopOpen) renderPeriphPop();
}

function renderPeriphPop() {
  const list = document.getElementById("periph-pop-list");
  const hint = document.getElementById("periph-pop-hint");
  if (!list) return;

  const data = periphData || {};
  const audio = Array.isArray(data.audio) ? data.audio : [];
  const outs = audio.filter((a) => a && a.flow === "out");
  const ins = audio.filter((a) => a && a.flow === "in");
  const { mouse, keyboard, ignoredCount, hubCount } = periphInputCounts(data);

  // 已连接项数 / 总槽位数。
  // ⚠️ 计数必须和胶囊的三个槽位一致：耳机 / 鼠标 / 键盘。
  // 不能用 outs.length —— 内置扬声器永远在，会让计数恒为满，
  // 耳机拔掉后仍显示「3 / 3」，读数失真。
  const hasHeadphone = outs.some((a) => a.kind === "headphone" || a.kind === "headset");
  const onCount = (hasHeadphone ? 1 : 0) + (mouse > 0 ? 1 : 0) + (keyboard > 0 ? 1 : 0);
  if (hint) {
    const extras = [];
    if (hubCount > 0) extras.push(`扩展坞 ${hubCount} 未计入`);
    if (ignoredCount > 0) extras.push(`忽略 ${ignoredCount}`);
    hint.textContent = `${onCount} / 3 已连接` + (extras.length ? ` · ${extras.join(" · ")}` : "");
  }

  const icon = (kind) => {
    if (kind === "mouse") return `<rect x="6" y="3" width="12" height="18" rx="6"></rect><path d="M12 3v7"></path>`;
    if (kind === "keyboard") return `<rect x="2" y="6" width="20" height="12" rx="2"></rect><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M8 14h8"></path>`;
    if (kind === "microphone") return `<rect x="9" y="2" width="6" height="11" rx="3"></rect><path d="M5 11a7 7 0 0 0 14 0M12 18v4"></path>`;
    if (kind === "speaker") return `<path d="M11 5L6 9H2v6h4l5 4V5z"></path><path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path>`;
    return `<path d="M3 18v-6a9 9 0 0 1 18 0v6"></path><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"></path>`;
  };

  // ignoreId 存在时渲染「忽略」按钮（仅输入设备有）；
  // includeId 存在时渲染「计入」按钮（经扩展坞、默认不计入的设备）
  // ⛔ 这里**不显示电量**：电量环在首页胶囊上（#tb-periph），浮层只管设备明细。
  const row = (kind, name, meta, stateText, on, ignoreId, includeId) => `
    <div class="periph-row${on ? " is-on" : ""}">
      <span class="periph-row__icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${icon(kind)}</svg></span>
      <div class="periph-row__body">
        <div class="periph-row__name">${esc(name)}</div>
        <div class="periph-row__meta">${esc(meta)}</div>
      </div>
      <span class="periph-row__state${on ? "" : " is-off"}">${esc(stateText)}</span>
      ${ignoreId ? `<button class="periph-row__ignore" data-ignore="${esc(ignoreId)}" aria-label="以后不再计入这个设备">忽略</button>` : ""}
      ${includeId ? `<button class="periph-row__ignore periph-row__include" data-include="${esc(includeId)}" aria-label="这个确实是真实设备，计入它">计入</button>` : ""}
    </div>`;

  const parts = [];

  // 音频：逐个列（耳机/扬声器/麦克风都有真实名字）
  for (const a of outs) {
    parts.push(row(
      a.kind || "speaker", a.name || a.type || "音频设备",
      `${a.type || "音频"} · 输出`, "已连接", true, "", "",
    ));
  }
  for (const a of ins) {
    // 麦克风：有端点就算存在，但未必被应用启用 —— 标"可用"而非"已连接"更准确
    parts.push(row(
      a.kind || "microphone", a.name || a.type || "麦克风",
      `${a.type || "麦克风"} · 输入`, "可用", true, "", "",
    ));
  }
  if (!outs.length && !ins.length) {
    parts.push(`<div class="periph-empty">未检测到音频设备</div>`);
  }

  // 输入设备：按设备逐个列（带 VID/PID），可单独忽略。
  // 扩展坞 / 无线接收器的 HID 芯片会向系统报告自己是键鼠，Windows 认为它们
  // 真实存在 —— 自动判"假"会误杀罗技 Unifying 这类一收多配的真设备，
  // 所以把判断权交给用户。
  const mDevs = Array.isArray(data.mouseDevices) ? data.mouseDevices : [];
  const kDevs = Array.isArray(data.keyboardDevices) ? data.keyboardDevices : [];
  const ignored = new Set(periphIgnored());
  const included = new Set(periphIncluded());

  const devRows = (kind, devs, label) => {
    if (!devs.length) {
      // ⛔ 不要因为「这个类目下没有有线设备」就写「未接入」：
      //    蓝牙设备已经单独列在下面了，它同样提供该能力。
      //    此时再标一个「鼠标 未连接」会和下面「Professor 1 已连接」自相矛盾。
      const btProvides = [...mDevs, ...kDevs].some(
        (d) => d?.bluetooth && (kind === "mouse" ? d?.hasMouse : d?.hasKeyboard),
      );
      if (btProvides) return; // 由下面的蓝牙条目代表，不重复占一行
      parts.push(row(kind, label, "未接入", "未连接", false));
      return;
    }
    for (const d of devs) {
      const isIgnored = ignored.has(d?.id);
      const isBt = !!d?.bluetooth;
      // 经扩展坞且用户没手动计入过 → 默认不计入
      const isHubExcluded = !!d?.viaHub && !included.has(d?.id);
      const vidPid = d?.vid && d?.pid
        ? `VID_${d.vid} PID_${d.pid}`
        : (isBt ? "蓝牙连接" : "未知身份");
      const src = isBt ? "蓝牙" : (d?.viaHub ? "经扩展坞" : "外接");

      if (isIgnored) {
        parts.push(row(kind, `${label}（已忽略）`, `${vidPid} · 不计入`, "已忽略", false));
      } else if (isHubExcluded) {
        // 经扩展坞的设备默认不计入（扩展坞 HID 芯片冒充键鼠），
        // 但仍列出来并可「计入」—— 用户真把键鼠插扩展坞上时需要能恢复。
        parts.push(row(kind, `${label}（经扩展坞）`, `${vidPid} · ${src} · 不计入`, "未计入", false, "", d?.id || ""));
      } else {
        // 没有 VID/PID 的设备不给忽略按钮：忽略了会退化成 ":" 把所有同类都屏蔽
        const canIgnore = !!(d?.vid && d?.pid && d?.id);
        // 蓝牙设备用真实型号名（Rust 侧取到上游节点的 FriendlyName，
        // 实测 "MCHOSE G87 V2-1"）；取不到再回退到通用标签
        const name = isBt && d?.name ? `${d.name}（${label}）` : label;
        parts.push(row(kind, name, `${vidPid} · ${src}`, "已连接", true, canIgnore ? d.id : ""));
      }
    }
  };
  // 蓝牙设备**单独按设备列**，不塞进「鼠标 / 键盘」两个列表里各列一遍。
  //
  // 原因：同一台蓝牙设备的 HID 描述符同时声明键鼠能力（实测两台的描述符
  // 逐字段相同），塞进两个列表就会在浮层里出现两行同名设备，用户会以为
  // 插了两台。按设备列一条、在副标题里写明它具备哪些能力，才是如实的。
  const btSeen = new Set();
  const btDevs = [];
  for (const d of [...mDevs, ...kDevs]) {
    if (d?.bluetooth && d?.id && !btSeen.has(d.id)) {
      btSeen.add(d.id);
      btDevs.push(d);
    }
  }
  // 非蓝牙设备仍按原来的鼠标 / 键盘分列
  devRows("mouse", mDevs.filter((d) => !d?.bluetooth), "鼠标");
  devRows("keyboard", kDevs.filter((d) => !d?.bluetooth), "键盘");

  // 蓝牙设备逐台一条
  for (const d of btDevs) {
    const isIgnored = ignored.has(d?.id);
    const name = d?.name || "蓝牙设备";
    const caps = [];
    if (d?.hasKeyboard) caps.push("键盘");
    if (d?.hasMouse) caps.push("鼠标");
    const meta = `蓝牙连接${caps.length ? " · 支持" + caps.join("+") : ""}`;
    // 电量不在这里画：首页胶囊的图标外圈才是电量环，浮层只列设备明细。
    const stateText = "已连接";
    // 图标按**这台设备实际具备的能力**取，不能一律画键盘：
    // 只有鼠标能力的设备（实测 MX Master 3S）画成键盘图标是错的。
    const kind = d?.hasMouse && !d?.hasKeyboard ? "mouse" : "keyboard";
    if (isIgnored) {
      parts.push(row(kind, `${name}（已忽略）`, `${meta} · 不计入`, "已忽略", false));
    } else {
      parts.push(row(kind, name, meta, stateText, true, d?.id || "", ""));
    }
  }

  // 有输入设备时给一句说明：为什么这里会出现「没插却显示已连接」的设备。
  // 这不是 bug，是扩展坞/接收器的 HID 芯片在冒充键鼠 —— 让用户知道能用「忽略」处理。
  if (mDevs.length || kDevs.length) {
    parts.push(`<div class="periph-tip">经扩展坞的设备默认不计入（其 HID 芯片常冒充键鼠）。真把键鼠插扩展坞上时，点「计入」恢复。蓝牙设备按台列出并标注其支持的能力。</div>`);
  }

  // 有被忽略的设备时，底部给一个恢复入口
  if (ignoredCount > 0) {
    parts.push(`<div class="periph-restore"><button class="periph-restore__btn" data-restore="1">恢复全部被忽略的设备（${ignoredCount}）</button></div>`);
  }

  list.innerHTML = parts.join("");
}

// 浮层定位：贴胶囊右缘、向上展开。用 fixed 定位避免受父级 transform 影响。
function positionPeriphPop() {
  const pop = document.getElementById("periph-pop");
  const pill = document.getElementById("tb-periph");
  if (!pop || !pill) return;
  const pr = pill.getBoundingClientRect();
  const pw = pop.offsetWidth || 300;
  const ph = pop.offsetHeight || 200;
  // 水平：优先右对齐胶囊，超出窗口则贴右边界 8px
  let left = pr.right - pw;
  const maxLeft = window.innerWidth - pw - 8;
  if (left > maxLeft) left = maxLeft;
  if (left < 8) left = 8;
  // 垂直：向上展开（任务栏在最底部）
  let top = pr.top - ph - 8;
  if (top < 8) top = pr.bottom + 8; // 万一上方不够，翻到下方
  pop.style.left = `${Math.round(left)}px`;
  pop.style.top = `${Math.round(top)}px`;
}

function setPeriphPop(open) {
  const pop = document.getElementById("periph-pop");
  const pill = document.getElementById("tb-periph");
  if (!pop || !pill) return;
  periphPopOpen = !!open;
  if (open) {
    renderPeriphPop();
    pop.hidden = false;
    positionPeriphPop();
  } else {
    pop.hidden = true;
  }
  pill.setAttribute("aria-expanded", open ? "true" : "false");
  pill.classList.toggle("is-open", !!open);
}

function bindTaskbarPeriph() {
  const pill = document.getElementById("tb-periph");
  if (!pill) return;

  pill.addEventListener("click", (e) => {
    e.stopPropagation();
    setPeriphPop(!periphPopOpen);
  });

  // 点外部 / Esc 关闭
  document.addEventListener("click", (e) => {
    if (!periphPopOpen) return;
    if (e.target.closest("#periph-pop") || e.target.closest("#tb-periph")) return;
    setPeriphPop(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && periphPopOpen) setPeriphPop(false);
  });

  // 窗口尺寸变化时重新定位（浮层是 fixed，不重算会飘）
  window.addEventListener("resize", () => { if (periphPopOpen) positionPeriphPop(); });

  Bus.on("provider-emit", ({ config_hash, output }) => {
    if (config_hash !== "peripheral") return;
    paintPeriph(output);
  });

  // 浮层内的「忽略 / 恢复」按钮：事件委托，因为行是 innerHTML 重建的
  document.addEventListener("click", (e) => {
    const pop = document.getElementById("periph-pop");
    if (!pop || pop.hidden) return;

    const ig = e.target.closest("[data-ignore]");
    if (ig) {
      e.stopPropagation();
      const id = ig.dataset.ignore;
      if (!id) return;
      const cur = periphIgnored();
      if (!cur.includes(id)) {
        state.periphIgnore = [...cur, id];
        saveState();
        // 立即重画：不等下一轮 provider 推送（3 秒）
        if (periphData) paintPeriph(periphData);
      }
      return;
    }

    // 「计入」：把经扩展坞的设备加回白名单（用户真把键鼠插扩展坞上时用）
    const inc = e.target.closest("[data-include]");
    if (inc) {
      e.stopPropagation();
      const id = inc.dataset.include;
      if (!id) return;
      const cur = periphIncluded();
      if (!cur.includes(id)) {
        state.periphInclude = [...cur, id];
        saveState();
        if (periphData) paintPeriph(periphData);
      }
      return;
    }

    const rs = e.target.closest("[data-restore]");
    if (rs) {
      e.stopPropagation();
      state.periphIgnore = [];
      state.periphInclude = [];
      saveState();
      if (periphData) paintPeriph(periphData);
    }
  });

  // 通知后端开始采样（无消费者时后端降频空转）
  invoke("start_peripheral_sampling").catch(() => {});
  // 首帧兜底：dev 态没有 Rust 后端，用空数据画占位，避免胶囊一直是灰点
  if (!periphData) {
    paintPeriph({ audio: [], mouse: 0, keyboard: 0 });
    const p = document.getElementById("tb-periph");
    if (p) p.dataset.ready = "0";
  }
}


// 工作台窗口被注入桌面后撑满整块虚拟屏，Windows 原生任务栏浮在其上（z-order 高于 WorkerW），
// 会压住窗口最底下一条 —— 底部任务栏和最后一行卡片就被挡住了。
// Rust 侧 taskbar_inset 用「虚拟屏 - 工作区」算出遮挡量（逻辑像素），
// 这里写进 CSS 变量 --tb-inset-*，由 .taskbar 的 padding 与网格的 padding 一起让位。
// 浏览器 dev 态没有该命令 → invoke 回退返回 undefined，变量保持 0，不影响预览。
let insetTimer = 0;
async function syncTaskbarInset() {
  let r = null;
  try { r = await invoke("taskbar_inset"); } catch (_) { r = null; }
  const root = document.documentElement;
  const px = (v) => (typeof v === "number" && isFinite(v) && v > 0 ? Math.round(v) : 0);
  const bottom = px(r?.bottom), top = px(r?.top), left = px(r?.left), right = px(r?.right);
  root.style.setProperty("--tb-inset-bottom", `${bottom}px`);
  root.style.setProperty("--tb-inset-top", `${top}px`);
  root.style.setProperty("--tb-inset-left", `${left}px`);
  root.style.setProperty("--tb-inset-right", `${right}px`);
}

function bindTaskbarInset() {
  syncTaskbarInset();
  // 任务栏可能被用户移动/自动隐藏/换显示器：低频重算即可（这是系统级状态，不是数据流）
  clearInterval(insetTimer);
  insetTimer = setInterval(syncTaskbarInset, 5000);
  window.addEventListener("resize", syncTaskbarInset);
}

// 基金行情：任务栏只显示上证指数（红涨绿跌）。
// 「今日盈利」已移除 —— 底部栏只留指数走势，盈亏明细进基金管家浮层看。
function bindTaskbarFund() {
  const idxEl = document.getElementById("tb-fund-idx");
  const deltaEl = document.getElementById("tb-fund-delta");
  const chgEl = document.getElementById("tb-fund-chg");
  const paint = (valEl, v, suffix = "", isPct = false) => {
    if (!valEl) return;
    const up = v > 0, down = v < 0;
    valEl.classList.toggle("up", up);
    valEl.classList.toggle("down", down);
    const sign = up ? "+" : "";
    const num = isPct ? `${v.toFixed(2)}%` : `${v.toFixed(2)}`;
    valEl.textContent = `${sign}${num}${suffix}`;
  };
  // 拉指数行情：主动取一次，不依赖基金模块是否打开过。
  // 有缓存（30s 内）就直接命中，因此 30s 轮询的实际网络开销是每分钟约 2 次。
  let fetching = false;
  const pullIndex = async () => {
    if (fetching) return;
    fetching = true;
    try { await fetchIndexQuotes(); } catch (_) { /* 失败保留上一帧，不弹错 */ }
    finally { fetching = false; }
  };
  // 涨跌额和涨跌幅都不该显示涨跌色时，把 .up/.down 摘掉（回到中性灰）。
  const neutral = (el) => { if (el) { el.classList.remove("up", "down"); } };
  const refresh = () => {
    // 指数：读模块级缓存（fetchIndexQuotes 写入 state.fund.cache.index.idx）
    const cache = state.fund?.cache?.index;
    const rec = cache && cache.idx;
    const list = rec && rec.data ? rec.data : null;
    if (list && list.length) {
      const sh = list.find((x) => /上证/.test(String(x.name || ""))) || list[0];
      // 点位：无数据回退「--」，并清掉涨跌色
      if (idxEl) idxEl.textContent = sh.price ? sh.price.toFixed(2) : "--";
      // 涨跌额（点数变化）：数量维度，和百分比并列展示
      if (deltaEl) {
        if (sh.chg !== null && sh.chg !== undefined && sh.price) paint(deltaEl, Number(sh.chg), "", false);
        else { deltaEl.textContent = "--"; neutral(deltaEl); }
      }
      // 涨跌幅：百分比维度
      if (chgEl) {
        if (sh.pct !== null && sh.pct !== undefined && sh.price) paint(chgEl, Number(sh.pct), "", true);
        else { chgEl.textContent = "--"; neutral(chgEl); }
      }
    }
  };
  pullIndex();
  refresh();
  setInterval(() => { pullIndex(); refresh(); }, 30000);
  return refresh;
}

// -------------------- 编辑模式 --------------------
// 设计稿的「编辑模式」：卡片可拖动换位。这里落地为最稳的一档——
// 进入编辑态时卡片可拖到别的位置交换顺序，顺序存 state.settings.cardOrder。
//
// ⛔ 视觉反馈必须够强：原来只有 1px/35% 的虚线描边，深色底上等于没有，
//    用户点了按钮以为「没效果」（实际 class、draggable、拖拽落盘全都正常）。
//    现在靠三件事让状态一眼可见：① 卡片实线+光晕 ② 顶部常驻横幅 ③ 参考网格线。
let editMode = false;
export function toggleEditMode() {
  editMode = !editMode;
  const grid = document.getElementById("widget-grid");
  grid?.classList.toggle("edit-mode", editMode);
  // 横幅是 grid 的兄弟节点，靠 body 上的类控制显示（见 CSS .edit-banner）
  document.body.classList.toggle("is-editing", editMode);
  document.getElementById("tb-edit")?.classList.toggle("active", editMode);
  document.getElementById("tb-edit")?.setAttribute("aria-pressed", editMode ? "true" : "false");
  // ⛔ 不再设 draggable：拖拽已改成 Pointer Events（initCardDrag 里靠 editMode 判断）。
  //    若设 draggable=true 会触发原生 HTML5 拖拽、和 pointer 拖拽打架（拖一下两套都启动）。
  // 进入编辑态不再弹 toast —— 顶部横幅 + 卡片描边 + 参考线已经是三重反馈，
  // 再弹一条 1.2 秒的 toast 只会和横幅抢位置（横幅固定在右下角，toast 在底部正中）。
  // 退出时仍提示「布局已保存」，因为那是**唯一**能确认「改动生效了」的信号。
  if (!editMode) {
    saveState();
    toastQuiet("布局已保存");
  }
}

// -------------------- 网格占用 / 交换（拖拽 + 改大小共用） --------------------
// 读取每张卡当前钉死的网格坐标（左上角 col/row + 占用 span/rowSpan）。
function cardCells(grid) {
  const map = new Map();
  grid.querySelectorAll(".widget").forEach((c) => {
    map.set(c, {
      col: parseInt(c.style.gridColumn, 10) || 1,
      row: parseInt(c.style.gridRow, 10) || 1,
      span: Number(c.dataset.span) || 1,
      rowSpan: Number(c.dataset.row) || 1,
    });
  });
  return map;
}

// 目标区域 [col..col+span) × [row..row+rowSpan) 是否与「除 ignore 外」的某卡占用区重叠
function regionFree(grid, col, row, span, rowSpan, ignore) {
  for (const [c, r] of cardCells(grid)) {
    if (c === ignore) continue;
    const oCol = col < r.col + r.span && col + span > r.col;
    const oRow = row < r.row + r.rowSpan && row + rowSpan > r.row;
    if (oCol && oRow) return false;
  }
  return true;
}

// 从锚点 (col,row) 出发、不撞邻卡的前提下，≤ 期望尺寸的最大块。
// ⛔ 必须把**本卡自己**排除（ignore）：否则本卡当前占用区会被当成「邻卡」挡住自己缩放。
//   缩小永远放行（更小必不撞），放大只在真有空位时放行 → 不锁死缩放、也不压邻卡。
function fitSize(grid, col, row, wantSpan, wantRow, ignore) {
  let best = { span: 1, row: 1 };
  for (let s = 1; s <= wantSpan; s++) {
    for (let r = 1; r <= wantRow; r++) {
      if (regionFree(grid, col, row, s, r, ignore)) best = { span: s, row: r };
    }
  }
  return best;
}

// 互换两张卡的网格坐标（各拿对方位置，尺寸不变）。只在两卡**尺寸相同**时调用 → 绝不溢出/压邻卡。
function swapGridPos(a, b) {
  const ac = a.style.gridColumn, ar = a.style.gridRow;
  a.style.gridColumn = b.style.gridColumn; a.style.gridRow = b.style.gridRow;
  b.style.gridColumn = ac; b.style.gridRow = ar;
}

// -------------------- 编辑模式：拖拽换位（手机桌面式自由摆放） --------------------
// ⛔ 不用 HTML5 drag&drop —— 它只能以「另一张卡」为落点，落不到空格，且 WebView2 里
//    draggable + 拖拽把手容易打架。改用 Pointer Events 自己算落点：
//    按住卡拖动 → 实时把鼠标位置换算成网格 (col,row) → 显示半透明落点预览 →
//    松手落到那个格。落到空格 = 移过去（其它卡不动）；落到别的卡 = 和它交换坐标。
//    这样前面空出来的格就能被填上（用户要的手机桌面体验）。
function initCardDrag(grid) {
  let st = null;   // { card, id, grabDX, grabDY, span, rowSpan }
  let ghost = null; // 跟随鼠标的半透明落点预览（grid 的直接子元素，用 grid-column/row 定位）

  // 网格几何：列数 / 每列宽 / 每行高 / 相对 grid 的内容原点。全部实测，不写死。
  const gridGeom = () => {
    const cs = getComputedStyle(grid);
    const track = (v) => String(v).split(" ").filter((s) => s && s !== "none").map((x) => parseFloat(x) || 0);
    const widths = track(cs.gridTemplateColumns); // 每列真实像素宽（repeat/minmax 已解析）
    const heights = track(cs.gridTemplateRows);   // 每行真实像素高（自适应行高实测）
    const cols = widths.length || 6;
    const gap = parseFloat(cs.columnGap) || 12;
    const gapY = parseFloat(cs.rowGap) || 12;
    const gr = grid.getBoundingClientRect();
    return {
      cols, widths, heights, gap, gapY,
      originX: gr.left + (parseFloat(cs.paddingLeft) || 0),
      originY: gr.top + (parseFloat(cs.paddingTop) || 0),
    };
  };

  // 鼠标位置 → 目标落点 (col,row)（拖拽卡左上角要放的格）。夹到网格内、且不溢出右边界。
  // ⛔ 行/列必须用 gridTemplateRows/Columns 的**真实像素尺寸累积**换算，不能用「第一张卡高度」
  //    估算 —— 行高是 minmax(150px,1fr) 自适应，估算值偏小会把第四行算成第二行（踩过）。
  const targetCell = (e, span, rowSpan) => {
    const g = gridGeom();
    // 列：累积列宽+列间距，找到鼠标 x 落在第几列
    let col = 1;
    for (let i = 0; i < g.widths.length; i++) {
      const lineX = g.originX + g.widths.slice(0, i + 1).reduce((a, b) => a + b, 0) + g.gap * (i + 1);
      if (e.clientX >= lineX) col = i + 2; else break;
    }
    col = Math.max(1, Math.min(col, g.widths.length || g.cols));
    // 行：累积行高+行间距，找到鼠标 y 落在第几行
    let row = 1;
    for (let i = 0; i < g.heights.length; i++) {
      const lineY = g.originY + g.heights.slice(0, i + 1).reduce((a, b) => a + b, 0) + g.gapY * (i + 1);
      if (e.clientY >= lineY) row = i + 2; else break;
    }
    row = Math.max(1, row);
    col = Math.max(1, Math.min(col, (g.widths.length || g.cols) - span + 1)); // 不溢出右边界
    return { col, row, cols: g.cols };
  };

  const mkGhost = () => {
    const el = document.createElement("div");
    el.className = "drag-ghost";
    grid.appendChild(el);
    return el;
  };
  const placeGhost = (col, row, span, rowSpan) => {
    if (!ghost) return;
    ghost.style.gridColumn = `${col} / span ${span}`;
    ghost.style.gridRow = `${row} / span ${rowSpan}`;
  };

  grid.addEventListener("pointerdown", (e) => {
    if (!editMode || e.button !== 0) return;
    if (e.target.closest("[data-resize]")) return; // 把手是改尺寸，不抢
    const card = e.target.closest(".widget");
    if (!card) return;
    e.preventDefault();
    const span = Number(card.dataset.span) || 1;
    const rowSpan = Number(card.dataset.row) || 1;
    const cr = card.getBoundingClientRect();
    st = {
      card, id: card.dataset.card, span, rowSpan,
      grabDX: e.clientX - cr.left,   // 鼠标在卡内的偏移，落点据此对齐
      grabDY: e.clientY - cr.top,
    };
    try { grid.setPointerCapture(e.pointerId); } catch (_) {}
  });

  grid.addEventListener("pointermove", (e) => {
    if (!st) return;
    if (!ghost) { ghost = mkGhost(); st.card.classList.add("dragging"); }
    const t = targetCell(e, st.span, st.rowSpan);
    placeGhost(t.col, t.row, st.span, st.rowSpan);
  });

  const finish = (e) => {
    if (!st) return;
    const { card, id, span, rowSpan } = st;
    const t = targetCell(e, span, rowSpan);
    if (ghost) { ghost.remove(); ghost = null; }
    card.classList.remove("dragging");
    st = null;
    // 找落点区域的卡（被压的那张）。落到空格 → over 为空。
    const over = Array.from(grid.querySelectorAll(".widget")).find((c) => {
      if (c === card) return false;
      const cc = parseInt(c.style.gridColumn, 10) || 1, cr = parseInt(c.style.gridRow, 10) || 1;
      const cs = Number(c.dataset.span) || 1, crs = Number(c.dataset.row) || 1;
      return t.col < cc + cs && t.col + span > cc && t.row < cr + crs && t.row + rowSpan > cr;
    });
    if (!over) {
      // 落到空格 → 放那里，其它卡**一律不动**（不补位）。
      card.style.gridColumn = `${t.col} / span ${span}`;
      card.style.gridRow = `${t.row} / span ${rowSpan}`;
    } else {
      // 落到别的卡 → 只有**尺寸相同**才互换位置（绝不溢出/压邻卡）；
      // 尺寸不同 → 不动（卡回原位），最简单也最不会出错。
      const os = Number(over.dataset.span) || 1, ors = Number(over.dataset.row) || 1;
      if (os === span && ors === rowSpan) swapGridPos(card, over);
    }
    persistCardOrder(grid);
  };
  grid.addEventListener("pointerup", finish);
  grid.addEventListener("pointercancel", () => {
    if (ghost) { ghost.remove(); ghost = null; }
    if (st) { st.card.classList.remove("dragging"); st = null; }
  });
}

function persistCardOrder(grid) {
  if (!state.settings) state.settings = {};
  state.settings.cardOrder = Array.from(grid.querySelectorAll(".widget")).map((c) => c.dataset.card);
  saveState();
}

// -------------------- 编辑模式：拖把手改尺寸 --------------------
// ⛔ 用 Pointer Events 而不是 mouse*：WebView2 里鼠标/触控笔/触摸都走 pointer，
//    一套逻辑全覆盖，且 setPointerCapture 能保证指针移出卡片后仍继续收到 move
//    （用 mousemove 挂在 document 上虽然也行，但会和卡片拖拽的 dragstart 抢事件）。
//
// ⛔ 必须 stopPropagation + preventDefault：卡片本身在编辑态是 draggable=true，
//    不拦的话按住把手一拖会触发**整卡拖拽换位**，而不是改大小。
//    这也是「把手必须在卡片内部、但拖拽必须被拦截」的原因。
//
// ⛔ 阈值：移动超过 6px 才算「开始改尺寸」，否则用户只是想点一下卡片
//    （编辑态下点击本来不开模块，但会产生一次无意义的 saveState）。
function initCardResize(grid) {
  let st = null; // { card, id, startX, startY, span, row, cellW, cellH, active }

  const cellSize = () => {
    // 从网格真实几何反推单格尺寸：cols 是 6（媒体查询会改，但 gap/padding 同步变，
    // 所以按实际 computedStyle 读，不写死）。
    const cs = getComputedStyle(grid);
    const cols = cs.gridTemplateColumns.split(" ").filter((s) => s && s !== "none").length || 6;
    const gap = parseFloat(cs.columnGap) || 12;
    const gapY = parseFloat(cs.rowGap) || 12;
    const padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
    const w = (grid.clientWidth - padX - gap * (cols - 1)) / cols;
    // 行高：grid-auto-rows 是 minmax(150px, 1fr)，直接量第一行卡的实际高度最稳。
    const first = grid.querySelector(".widget:not(.row-2):not(.row-3):not(.row-4)");
    const h = first ? first.getBoundingClientRect().height : 150;
    return { w: Math.max(40, w + gap), h: Math.max(40, h + gapY) };
  };

  grid.addEventListener("pointerdown", (e) => {
    if (!editMode) return;
    const handle = e.target.closest("[data-resize]");
    if (!handle) return;
    const card = handle.closest(".widget");
    if (!card) return;
    // ⛔ 拦住卡片拖拽：不 preventDefault 的话 draggable 父元素会开始 HTML5 拖拽
    e.preventDefault();
    e.stopPropagation();
    const { w, h } = cellSize();
    st = {
      card,
      id: card.dataset.card,
      startX: e.clientX,
      startY: e.clientY,
      // ⛔ 按下那一刻的尺寸要单独存一份（span0/row0）：move 里所有计算都以它为基准，
      //    而不是读 DOM 当前值。读 DOM 会变成「增量累加」，每步都要重新锚定，
      //    锚定一旦被提前 return 跳过就产生跳格（踩过）。
      span0: Number(card.dataset.span) || 1,
      row0: Number(card.dataset.row) || 1,
      cellW: w,
      cellH: h,
      active: false,
    };
    try { handle.setPointerCapture(e.pointerId); } catch (_) {}
  });

  grid.addEventListener("pointermove", (e) => {
    if (!st) return;
    const dx = e.clientX - st.startX;
    const dy = e.clientY - st.startY;
    if (!st.active) {
      if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
      st.active = true;
      st.card.classList.add("is-resizing");
      // ⛔ 已改用 Pointer Events 拖拽（不再依赖 draggable），这里无需再动 draggable。
    }
    e.preventDefault();
    // ⛔ 用「按下时的尺寸 + 总位移 / 格宽」算目标，**不要**每步重新锚定 startX 再累加。
    //    踩过：第一版每步 `st.span = span; st.startX = e.clientX`，但「尺寸没变」时
    //    提前 return 跳过了重新锚定 → 位移一直累积，攒过半格突然跳 2~3 格
    //    （实测拖 2 格变成 +3）。总位移模型天然没有漂移，也不需要锚定。
    const wantSpan = clampSize(st.span0 + Math.round(dx / st.cellW), 1, SPAN_MAX);
    const wantRow = clampSize(st.row0 + Math.round(dy / st.cellH), 1, ROW_MAX);
    // ⛔ 用 fitSize（排除自身）把尺寸夹到「不撞邻卡」：缩小永远放行，放大只往真空位撑。
    //    之前锁死是因为 fitSize 没排除自身 —— 本卡占用区被当成邻卡，连缩小都撞 → 卡回最小。
    //    现在排除了自身 → 缩小照常、放大到有空位为止，绝不压邻卡（不重叠）。
    const col = parseInt(st.card.style.gridColumn, 10) || 1;
    const rw = parseInt(st.card.style.gridRow, 10) || 1;
    const fit = fitSize(grid, col, rw, wantSpan, wantRow, st.card);
    const span = fit.span, row = fit.row;
    if (span === Number(st.card.dataset.span) && row === Number(st.card.dataset.row)) return;
    applyCardSize(st.card, span, row);
  });

  const finish = (e) => {
    if (!st) return;
    const { card, id, active } = st;
    st = null;
    card.classList.remove("is-resizing");
    if (!active) return; // 只是点了一下，什么都没改
    let span = Number(card.dataset.span) || 1;
    const row = Number(card.dataset.row) || 1;
    // ⛔ resize 只改本卡大小，**绝不重排其它卡**（不调 applyGridPositions —— 它是紧凑装箱，
    //    会自动补位 + 挤走用户摆的卡）。只把 span 夹到「从本卡当前列不溢出右边界」，
    //    放大往右/往下撑开（临时压邻卡由用户再拖 adjustment，不自动动别人）；缩小在本位缩、留空。
    const startCol = parseInt(card.style.gridColumn, 10) || 1;
    span = Math.min(span, SPAN_MAX - startCol + 1);
    applyCardSize(card, span, row);
    persistCardSize(id, span, row);
    // 尺寸变了 → 内容区高度变了。任务卡自己有 ResizeObserver，其余卡靠
    // 1s 心跳的签名对比**不会**因为尺寸变化而重画（签名不含尺寸）。
    // 这里主动重画一遍，否则笔记/快捷/定时任务卡会保持旧行数直到数据变化。
    repaintCard(id);
  };
  grid.addEventListener("pointerup", finish);
  grid.addEventListener("pointercancel", finish);
}

// 尺寸变化后主动重画某张卡（签名不含尺寸，心跳不会触发）
function repaintCard(id) {
  switch (id) {
    case "tasks": renderTasksCard(); break;
    case "notes": renderNotesCard(); break;
    case "music": renderMusicCard(); break;
    case "sched": renderSchedCard(); break;
    case "quick": renderQuickCard(); break;
    case "muyu": renderMuyuCard(); break;
    case "credits": renderCreditsCard(); break;
    case "ideabox": renderIdeasCard(); break;
    case "ems": renderEmsCard(); break;
    default: break;
  }
}

// 按已保存顺序重排（启动时调用；不在记录里的卡片保持默认位置排在末尾）
function applyCardOrder(grid) {
  const order = state.settings?.cardOrder;
  if (!Array.isArray(order) || !order.length) return;
  const cards = Array.from(grid.querySelectorAll(".widget"));
  const byId = new Map(cards.map((c) => [c.dataset.card, c]));
  for (const id of order) {
    const c = byId.get(id);
    if (c) { grid.appendChild(c); byId.delete(id); }
  }
  // 剩下的按原样追加
  for (const c of byId.values()) grid.appendChild(c);
}

// -------------------- 初始化 --------------------
let started = false;

export function initWorkspace() {
  if (started) return;
  started = true;

  const grid = gridEl();
  if (grid) {
    grid.insertAdjacentHTML("beforeend", cardList().map(cardShell).join(""));
    // 卡片点击：**只有右上角「展开」按钮（data-open）才打开浮层**，点卡片本体不弹。
    // 卡片内的按钮/交互自己 stopPropagation。木鱼（敲）、签到（刷新）的整卡点击是功能行为，保留。
    grid.addEventListener("click", (e) => {
      if (editMode) return; // 编辑态下点击只用于拖拽，不打开模块
      const openBtn = e.target.closest("[data-open]");
      if (openBtn) { openModule(openBtn.dataset.open); return; }
      const card = e.target.closest(".widget");
      if (!card) return;
      // 木鱼卡：整卡就是「敲一下」（它没有浮层）。签到卡：没有模块可开，点击只触发一次实时刷新。
      if (card.dataset.card === "muyu") { muyuHit(); return; }
      if (card.dataset.card === "credits") { loadCredits(true); return; }
    });
    grid.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const openBtn = e.target.closest("[data-open]");
      if (openBtn) { e.preventDefault(); openModule(openBtn.dataset.open); return; }
      const card = e.target.closest(".widget");
      if (!card) return;
      e.preventDefault();
      // 键盘操作同样：木鱼敲一下、签到刷新，其余不开浮层（浮层只走右上角按钮）
      if (card.dataset.card === "muyu") { muyuHit(); return; }
      if (card.dataset.card === "credits") { loadCredits(true); return; }
    });
    initCardDrag(grid);
    // ⛔ 顺序：先 applyCardSizes（写出 data-span/data-row），再 initCardResize ——
    //    拖拽逻辑读 dataset，没有 dataset 会把所有卡当成 span-1 起点。
    applyCardSizes(grid);
    initCardResize(grid);
    applyCardOrder(grid);
    // 铺完尺寸和顺序后固定每张卡的网格坐标：后续缩放/拖拽不再触发自动流重排
    // （否则前面卡缩小，后面卡会往前/往上补位）。resize 不重算，保持其它卡不动。
    applyGridPositions(grid);
  }

  initOverlayRefs();
  renderAllCards();
  // 积分卡的数据在磁盘上（签到脚本写的 JSON），首屏先画骨架，异步读完再填。
  loadCredits(true);

  bindTaskbarSystem();
  bindTaskbarFund();
  bindTaskbarPeriph();
  bindTaskbarInset();

  // 数据变化 → 重画对应卡片。
  // 待办有现成事件（tasks.js 里 emit）；其余模块没有对外事件，用「签名对比 + 1s 心跳」兜底：
  // 只在签名真的变了才重画，避免每秒重排 DOM（模块内部的定时器仍然只归模块自己管）。
  Bus.on("tasks-changed", () => { renderTasksCard(); renderBadges(); });
  // 签到完成 → 立刻重读结果文件（不然要等 60s TTL 过期才看到新余额）
  Bus.on("credits-changed", () => loadCredits(true));
  const sig = {};
  const watch = (key, compute, paint) => {
    const s = compute();
    if (sig[key] === s) return;
    sig[key] = s;
    paint();
  };
  Heartbeat.on(() => {
    watch("notes", () => (state.notes || []).map((n) => `${n.id}:${n.updatedAt}:${n.title}`).join("|"), renderNotesCard);
    // 音乐卡：签名里**不放 currentTime**。时间/进度由 music-progress 广播高频驱动（paintMusicTick），
    // 放进签名会让 Heartbeat 每秒 innerHTML 重建一次卡片，按钮焦点和 hover 全丢。
    // 这里只在「切歌 / 播放态 / 封面」变化时重建骨架。
    watch("music", () => {
      const pb = state.playback || {};
      return `${pb.playing}|${pb.song?.title || ""}|${pb.song?.artist || ""}|${pb.song?.artwork || ""}|${Math.round(pb.duration || 0)}`;
    }, renderMusicCard);
    // 定时任务卡：签名除任务列表外还要含 nextDue（下次到期时刻）——
    // 否则 refreshSchedWarnings 首次拉到 nextDue 后列表不重画，时刻会一直停在「—」。
    // 定时任务卡：签名 = 任务列表 + nextDue（下次时刻）+ 今天各任务运行状态（heat.last）。
    // ⛔ 必须含运行状态：任务跑完/到点后 heat.last 变了，签名不变就不会重画，状态点会卡旧的。
    watch("sched", () => (state.scheduler?.tasks || []).map((t) => {
      const agg = schedHeat?.[t.id]?.[ymd()];
      return `${t.id}:${t.enabled}:${t.name}:${agg?.last || "-"}:${schedNextDue[t.id] || "-"}`;
    }).join("|"), renderSchedCard);
    // 快捷访问：签名必须含**分组**信息。
    // 卡片按 qaGroups 分块渲染，只盯 quickAccess 的话，用户改组名 / 把条目挪组
    // 都不会触发重画（列表字段一个没变），卡片会一直显示旧分组。
    watch(
      "quick",
      () => (state.quickAccess || []).map((q) => `${q.id}:${q.title}:${q.groupId || ""}`).join("|")
        + "#" + (state.qaGroups || []).map((g) => `${g.id}:${g.name}`).join("|"),
      renderQuickCard,
    );
    // 木鱼：签名用 total + 今日日期。跨天时 date 变 → 今日数归零并重画。
    // 不用把 today 放进签名：今天数变了必然 total 也变了，total 已经覆盖。
    watch("muyu", () => `${state.muyu?.total ?? 0}|${state.muyu?.date ?? ""}`, renderMuyuCard);
    watch("tasks", () => (Tasks.list() || []).map((t) => `${t.id}:${t.done}:${t.status}`).join("|"), () => { renderTasksCard(); renderBadges(); });
    // 灵感：条数变了就重点亮星星（用 id 列表做签名，编辑文字也会重画）
    watch("ideas", () => (state.ideabox || []).map((i) => i.id).join("|"), renderIdeasCard);
    // 禅道：签名包含四个数字 + 错误信息 + updatedAt。
    // ⛔ updatedAt 必须进签名：否则「抓取成功但四个数字没变」时签名相同、
    // 卡片不重画，右上角的刷新按钮会一直停在 .is-busy（图标无限旋转），
    // 用户看到的就是「一直在转没有返回数据」——数字其实早就回来了。
    // 带上 updatedAt 后，每次成功抓取都会重画一次，时间也跟着刷新。
    watch("ems", () => {
      const s = state.emsStats || {};
      return `${s.reqOpen}|${s.reqUnverified}|${s.bugOpen}|${s.bugUnverified}|${s.error || ""}|${s.updatedAt || 0}`;
    }, renderEmsCard);
    // 积分：文件在磁盘上，靠 TTL 节流（60s 内不重复读盘），不参与签名对比
    loadCredits();
  });

  // Esc 关浮层（浮层开着时优先关浮层，不关帮助）
  window.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (isModuleOpen()) { e.stopPropagation(); closeModule(); }
  }, true);

  // 系统采样：首页任务栏要指标，所以常开（离开系统健康页也不停，任务栏还在用）
  invoke("start_system_sampling").catch(() => {});

  // 定时任务「今日异常」警告：运行结果由后端推进（跑完/漏跑/到点），
  // 不体现在 state.scheduler.tasks 签名里，心跳不会触发 → 独立 60s 轮询刷新。
  // 轻量：scheduler_status + scheduler_heat 都不带 output，开销可忽略。
  setInterval(() => {
    if (document.hidden) return;               // 页面不可见跳过，回到前台下一轮补
    if (isModuleOpen()) return;                // 浮层打开时不刷首页卡（省 IPC）
    refreshSchedWarnings();
  }, 60000);
}
