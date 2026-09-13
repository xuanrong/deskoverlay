// 今日概览视图：待办事项（左）+ 文件中心/最近操作（右）。
import { Bus, invoke } from "../bus.js";
import { Tasks } from "../tasks.js";
import { state, saveState, pushRecentOp, onRecentOp } from "../state.js";
import { STATUS_LABEL, TASK_STATUSES, PRIORITY_LABEL } from "../config.js";
import { ICON_EXTERNAL, ICON_SEARCH, ICON_EDIT, ICON_TRASH, ICON_CHECK, ICON_BELL, ICON_FOLDER, ICON_PAPERCLIP } from "../icons.js";
import { ICON_TOMATO } from "../pomodoro.js";
import { FILE_CATEGORIES, FILE_ICONS } from "../filetypes.js";
import { esc, showDialog } from "./common.js";
import { toast } from "../toast.js";
import { createDatePicker } from "../datepicker.js";
import { createSelect } from "../selectbox.js";

// 文件中心布局切换用图标（本视图专用，不动共享的 ICON_LIST/ICON_GRID）
const LAYOUT_LIST_ICON = `<svg viewBox="0 0 24 24"><path d="M3.5 5.5H21"/><path d="M3.5 12H21"/><path d="M3.5 18.5H21"/></svg>`;
const LAYOUT_GRID_ICON = `<svg viewBox="0 0 24 24"><rect x="3.5" y="3.5" width="7.5" height="7.5" rx="1.5"/><rect x="13" y="3.5" width="7.5" height="7.5" rx="1.5"/><rect x="3.5" y="13" width="7.5" height="7.5" rx="1.5"/><rect x="13" y="13" width="7.5" height="7.5" rx="1.5"/></svg>`;

// 图片类扩展名 → 文件中心显示缩略图；成功结果按文件名缓存，避免每次渲染重复读取
const IMAGE_EXTS = new Set(["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg", "ico"]);
const THUMB_CACHE = new Map();

// 全盘文件名搜索：走后端自建索引（file_index），子串匹配文件名，内存驻留即时返回
function searchIcon(ext, isDir) {
  if (isDir) return ICON_FOLDER;
  for (const [cat, exts] of Object.entries(FILE_CATEGORIES)) if (exts.includes(ext)) return FILE_ICONS[cat] || ICON_PAPERCLIP;
  return ICON_PAPERCLIP;
}
// 索引命中(Hit{path,is_dir}) → 单行 <div>
function evRow(h) {
  const p = h.path || "";
  const name = p.split(/[\\/]/).pop() || "";
  const dir = p.slice(0, -name.length).replace(/[\\/]$/, "");
  const icon = searchIcon((name.split(".").pop() || "").toLowerCase(), !!h.is_dir);
  return `<div class="ev-item" data-path="${esc(p)}" title="${esc(p)}&#10;（右键操作）">
    <span class="ev-icon">${icon}</span>
    <span class="ev-name">${esc(name)}</span>
    <span class="ev-path">${esc(dir)}</span>
  </div>`;
}

// 最近操作类型 → 图标（线性 SVG）+ 标签
const OP_META = {
  file_open:   { icon: ICON_EXTERNAL, type: "文件" },
  file_reveal: { icon: ICON_SEARCH, type: "文件" },
  file_rename: { icon: ICON_EDIT, type: "文件" },
  file_delete: { icon: ICON_TRASH, type: "系统" },
  task_create: { icon: ICON_CHECK, type: "任务" },
  task_update: { icon: ICON_EDIT, type: "任务" },
  task_delete: { icon: ICON_TRASH, type: "任务" },
  reminder:    { icon: ICON_BELL, type: "提醒" },
  pomodoro:    { icon: ICON_TOMATO, type: "专注" },
};

// 相对时间：刚刚 / X 分钟前 / X 小时前 / 今天 HH:MM / 昨天 HH:MM / MM-DD
function relTime(ts) {
  const d = (Date.now() - ts) / 1000;
  if (d < 60) return "刚刚";
  if (d < 3600) return `${Math.floor(d / 60)} 分钟前`;
  if (d < 86400) return `${Math.floor(d / 3600)} 小时前`;
  const day = new Date(ts);
  const now = new Date();
  const hh = day.getHours().toString().padStart(2, "0");
  const mm = day.getMinutes().toString().padStart(2, "0");
  if (day.toDateString() === now.toDateString()) return `今天 ${hh}:${mm}`;
  const yest = new Date(now);
  yest.setDate(yest.getDate() - 1);
  if (day.toDateString() === yest.toDateString()) return `昨天 ${hh}:${mm}`;
  return `${day.getMonth() + 1}-${day.getDate()}`;
}

// 渲染单条最近操作记录
const OP_VERB = {
  file_open: "打开", file_reveal: "定位", file_rename: "重命名", file_delete: "删除",
  task_create: "创建", task_update: "修改", task_delete: "删除",
};
function recentOpRow(op) {
  // kind 优先（文件/任务类）；其余按 type 命中（sedentary→提醒，pomodoro→专注）；未知类型兜底圆点
  const m = OP_META[op.kind]
    || (op.type === "sedentary" ? OP_META.reminder : OP_META[op.type])
    || { icon: "•", type: "" };
  const verb = OP_VERB[op.kind] || op.action || "操作";
  const name = op.name || op.text || "";
  const typeCls = m.type === "任务" ? " task" : m.type === "系统" ? " system" : m.type === "提醒" ? " reminder" : m.type === "专注" ? " pomodoro" : "";
  return `
    <div class="recent-op">
      <span class="ro-icon">${m.icon}</span>
      <span class="ro-text">${esc(verb)}了 <b>${esc(name)}</b></span>
      <span class="ro-time">${relTime(op.ts)}</span>
      <span class="ro-type${typeCls}">${esc(m.type)}</span>
    </div>`;
}

// 渲染最近操作列表（默认 5 条）
function renderRecentOps() {
  const ops = (state.recentOps || []).slice(0, 5);
  if (!ops.length) return `<div class="dash-empty recent-empty">暂无操作记录</div>`;
  return ops.map(recentOpRow).join("");
}

// 全部操作记录弹窗
function showRecentOpsDialog() {
  const ops = state.recentOps || [];
  const ov = document.createElement("div");
  ov.className = "task-modal-overlay";
  ov.innerHTML = `
    <div class="task-modal recent-modal">
      <h3>全部操作记录 <span class="dash-count">${ops.length}</span></h3>
      <div class="recent-modal-list">
        ${ops.length ? ops.map(recentOpRow).join("") : `<div class="dash-empty recent-empty">暂无操作记录</div>`}
      </div>
      <div class="tm-actions">
        <button class="btn-primary cm-ok">关闭</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  const close = () => ov.remove();
  ov.querySelector(".cm-ok").addEventListener("click", close);
  ov.addEventListener("click", (e) => { if (e.target === ov) close(); });
  ov.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
}

// 操作记录变化时刷新"最近操作"列表（若列表已渲染）
onRecentOp(() => {
  const list = document.getElementById("d-recent-ops-list");
  if (list) list.innerHTML = renderRecentOps();
});

// 待办状态 SVG 图标（虚线圆 / 蓝色半圆 / 橙色实心圆 / 绿色对勾圆）
const STATUS_ICONS = {
  pending: `<svg class="ts-icon" viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="2 2"/></svg>`,
  doing: `<svg class="ts-icon" viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"><path d="M8 2 A 6 6 0 0 1 8 14 Z" fill="currentColor"/></svg>`,
  paused: `<svg class="ts-icon" viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"><circle cx="8" cy="8" r="5" fill="currentColor"/></svg>`,
  done: `<svg class="ts-icon" viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"><circle cx="8" cy="8" r="6.5" fill="currentColor"/><path d="M5.2 8.2 L7.2 10.2 L10.8 6" stroke="#0a0e15" stroke-width="1.7" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
};

export function renderDashboard(view) {
  view.header.style.display = "none";
  view.body.innerHTML = `
    <div class="dash-grid">
      <div class="dash-tasks" id="d-tasks"></div>
      <div class="dash-files" id="d-files"><div class="dash-empty">加载桌面文件…</div></div>
    </div>`;

  renderTasksMini(view.body.querySelector("#d-tasks"), view);
  renderFilesBlock(view.body.querySelector("#d-files"), view);
}

// -------------------- 待办事项（左侧） --------------------
function renderTasksMini(el, view) {
  el.innerHTML = `
    <div class="sec-title">
      <span>待办事项</span>
      <button class="file-layout-toggle" id="d-task-add" title="添加待办" aria-label="添加待办">＋</button>
    </div>
    <div class="dash-task-list" id="d-task-list"></div>`;

  el.querySelector("#d-task-add").addEventListener("click", () => showTaskModal("new", null, render));

  const listEl = el.querySelector("#d-task-list");
  // 指针拖拽状态：WebView2 中 HTML5 DnD 事件不稳定，改用 pointer 系列 + 浮动卡片跟手
  let drag = null; // { id, el, startX, startY, moved, ghost, raf }
  let suppressClick = false; // 拖拽结束后的 click 不触发编辑弹窗

  function clearDragVisual() {
    listEl.querySelectorAll(".dash-task").forEach((r) => {
      r.classList.remove("dragging", "drag-before", "drag-after");
    });
    document.body.classList.remove("no-select");
    if (drag) {
      if (drag.ghost) drag.ghost.remove();
      if (drag.raf) cancelAnimationFrame(drag.raf);
      drag.ghost = null;
      drag.raf = 0;
    }
  }

  // 根据指针 Y 坐标计算插入目标行
  function targetAt(y) {
    const rows = Array.from(listEl.querySelectorAll(".dash-task:not(.dragging)"));
    for (const r of rows) {
      const b = r.getBoundingClientRect();
      if (y < b.top + b.height / 2) return { id: r.dataset.id, cls: "drag-before" };
    }
    if (rows.length) return { id: rows[rows.length - 1].dataset.id, cls: "drag-after" };
    return null;
  }

  // 松手：按指针位置落位
  function finishDrag() {
    const fromId = drag?.id;
    const moved = drag?.moved;
    const t = targetAt(drag?.lastY ?? 0);
    clearDragVisual();
    drag = null;
    if (moved && fromId && t && t.id !== fromId) {
      suppressClick = true;
      Tasks.reorder(fromId, t.id);
    }
  }

  function render() {
    const tasks = Tasks.list();
    listEl.innerHTML = tasks.length
      ? tasks.map((t) => {
          const p = /^P\d$/.test(t.priority || "") ? t.priority : "P2";
          const pn = parseInt(p.slice(1), 10);
          const pCls = pn === 0 ? " critical" : pn === 1 ? " high" : pn === 2 ? " medium" : " low";
          const st = t.status || "pending";
          return `
        <div class="dash-task${st === "done" ? " done" : ""}" data-id="${t.id}">
          <span class="t-status st-${st}">${STATUS_ICONS[st] || ""}<span class="ts-text">${STATUS_LABEL[st] || st}</span></span>
          <span class="t-prio${pCls}">${p}</span>
          <span class="t-text">${esc(t.text)}</span>
          ${t.tags && t.tags.length ? `<span class="t-tags">${t.tags.map((tg) => `#${esc(tg)}`).join(" ")}</span>` : ""}
          ${t.due ? `<span class="t-due">${esc(t.due).slice(5)}</span>` : ""}
        </div>`;
        }).join("")
      : `<div class="dash-empty">暂无待办，点 + 添加</div>`;
    listEl.querySelectorAll(".dash-task").forEach((row) => {
      const task = Tasks.list().find((x) => x.id === row.dataset.id);
      if (!task) return;
      row.addEventListener("click", () => {
        if (suppressClick) { suppressClick = false; return; }
        showTaskModal("edit", task, render);
      });
      row.addEventListener("pointerdown", (e) => {
        if (e.button !== 0 || e.target.closest(".t-status")) return;
        drag = { id: row.dataset.id, el: row, startX: e.clientX, startY: e.clientY, lastY: e.clientY, moved: false, ghost: null, raf: 0 };
        try { row.setPointerCapture(e.pointerId); } catch (_) {}
      });
    });
  }

  // 拖动中：越过阈值后创建跟随鼠标的浮动卡片，实时高亮插入点
  window.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const dy = e.clientY - drag.startY;
    if (!drag.moved && Math.abs(dy) < 6) return;
    drag.moved = true;
    drag.lastY = e.clientY;
    drag.el.classList.add("dragging");
    document.body.classList.add("no-select");

    if (!drag.ghost) {
      const rect = drag.el.getBoundingClientRect();
      const ghost = drag.el.cloneNode(true);
      ghost.className = "dash-task drag-ghost";
      ghost.removeAttribute("data-id");
      ghost.style.left = rect.left + "px";
      ghost.style.top = rect.top + "px";
      ghost.style.width = rect.width + "px";
      ghost.style.height = rect.height + "px";
      document.body.appendChild(ghost);
      drag.ghost = ghost;
    }
    const dx = e.clientX - drag.startX;
    if (!drag.raf) {
      drag.raf = requestAnimationFrame(() => {
        drag.raf = 0;
        if (drag.ghost) drag.ghost.style.transform = `translate(${dx}px, ${dy}px)`;
      });
    }

    // 插入线指示
    const t = targetAt(e.clientY);
    listEl.querySelectorAll(".dash-task").forEach((r) => r.classList.remove("drag-before", "drag-after"));
    if (t) listEl.querySelector(`[data-id="${t.id}"]`)?.classList.add(t.cls);

    // 靠近列表上下边缘时自动滚动
    const lr = listEl.getBoundingClientRect();
    if (e.clientY < lr.top + 28) listEl.scrollTop -= 8;
    else if (e.clientY > lr.bottom - 28) listEl.scrollTop += 8;
  });

  window.addEventListener("pointerup", () => {
    if (!drag) return;
    if (!drag.moved) { clearDragVisual(); drag = null; return; }
    finishDrag();
  });
  window.addEventListener("pointercancel", () => {
    if (drag) { clearDragVisual(); drag = null; }
  });

  render();
  const off = Bus.on("tasks-changed", render);
  view.onDestroy(() => { off(); hideTaskModal(); });
}

// 待办弹窗（新建/编辑复用）：内容 / 状态 / 优先级(P0-P4) / 开始/截止日期 / 标签
let taskModalEl = null;
function showTaskModal(mode = "new", task = null, onDone) {
  hideTaskModal();
  const isEdit = mode === "edit";
  taskModalEl = document.createElement("div");
  taskModalEl.className = "task-modal-overlay";
  taskModalEl.innerHTML = `
    <div class="task-modal">
      <h3>${isEdit ? "编辑待办" : "新建待办"}</h3>
      <div class="tm-field">
        <label>内容</label>
        <textarea id="tm-text" rows="4" placeholder="待办内容…">${task ? esc(task.text) : ""}</textarea>
      </div>
      <div class="tm-row">
        <div class="tm-field"><label>状态</label><div id="tm-status"></div></div>
        <div class="tm-field"><label>优先级</label><div id="tm-priority"></div></div>
      </div>
      <div class="tm-row">
        <div class="tm-field"><label>开始日期</label><div id="tm-start"></div></div>
        <div class="tm-field"><label>截止日期</label><div id="tm-due"></div></div>
      </div>
      <div class="tm-field"><label>标签</label><input id="tm-tags" type="text" value="${task ? (task.tags || []).join(",") : ""}" placeholder="逗号分隔，如 工作,紧急" /></div>
      <div class="tm-actions">
        ${isEdit ? `<button class="tm-delete">删除</button>` : ""}
        <button class="tm-cancel">取消</button>
        <button class="btn-primary tm-ok">${isEdit ? "保存" : "添加"}</button>
      </div>
    </div>`;
  document.body.appendChild(taskModalEl);

  const textEl = taskModalEl.querySelector("#tm-text");
  textEl.focus();

  // 日期输入：自定义日期控件（替代原生 date 输入，规避 WebView2 占位文字问题）
  createDatePicker({ el: taskModalEl.querySelector("#tm-start"), value: task ? task.startDate || "" : "" });
  createDatePicker({ el: taskModalEl.querySelector("#tm-due"), value: task ? task.due || "" : "" });
  // 下拉：自定义选择控件（替代原生 select，弹出面板样式与深色主题统一）
  createSelect({
    el: taskModalEl.querySelector("#tm-status"),
    value: task ? task.status : "pending",
    options: TASK_STATUSES.map((s) => ({ value: s, label: STATUS_LABEL[s] })),
  });
  createSelect({
    el: taskModalEl.querySelector("#tm-priority"),
    value: task ? task.priority : "P2",
    options: ["P0", "P1", "P2", "P3", "P4"].map((p) => ({ value: p, label: `${p} · ${PRIORITY_LABEL[p]}` })),
  });

  const submit = () => {
    const t = textEl.value.trim();
    if (!t) { textEl.focus(); return; }
    const data = {
      text: t,
      status: taskModalEl.querySelector("#tm-status").value,
      priority: taskModalEl.querySelector("#tm-priority").value,
      startDate: taskModalEl.querySelector("#tm-start").value,
      due: taskModalEl.querySelector("#tm-due").value,
      tags: taskModalEl.querySelector("#tm-tags").value.split(",").map((s) => s.trim()).filter(Boolean),
    };
    if (isEdit) Tasks.update(task.id, data);
    else Tasks.add(data);
    hideTaskModal();
    onDone?.();
  };

  taskModalEl.querySelector(".tm-cancel").addEventListener("click", hideTaskModal);
  taskModalEl.querySelector(".tm-ok").addEventListener("click", submit);
  taskModalEl.querySelector(".tm-delete")?.addEventListener("click", async () => {
    const ok = await showDialog({ title: "删除待办", message: "确认删除该待办？删除后不可恢复。", okText: "删除", danger: true });
    if (!ok) return;
    Tasks.remove(task.id);
    hideTaskModal();
    onDone?.();
  });
  taskModalEl.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hideTaskModal();
    else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) submit();
  });
  textEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) submit();
  });
}
function hideTaskModal() {
  if (taskModalEl) {
    taskModalEl.querySelectorAll(".dp, .cs").forEach((d) => d._close?.());
    taskModalEl.remove();
    taskModalEl = null;
  }
}

// -------------------- 文件中心（右侧） --------------------
async function renderFilesBlock(el, view) {
  const CATS = ["文件夹", "图片", "文档", "代码", "压缩", "视频", "音频", "其他"];
  // 当前 tab 持久化到导航状态：切换模块/重启后恢复上次浏览的分类
  let currentTab = state.navState?.dashboard?.tab || "";
  // 布局模式（list 列表 / grid 网格），同样持久化
  let layout = state.navState?.dashboard?.layout || "list";

  // 完整刷新：重新拉取桌面文件 → 重新分组 → 重渲染 tabs/content（操作后调用）
  async function load() {
    let files;
    try {
      files = await invoke("list_desktop_files");
    } catch (e) {
      el.innerHTML = `<div class="sec-title">文件中心</div><div class="dash-empty">无法读取（dev 态不可用或未授权）</div>`;
      return;
    }

    const groups = {};
    for (const k of CATS) groups[k] = [];
    for (const f of files) {
      if (f.is_dir) { groups["文件夹"].push(f); continue; }
      let placed = false;
      for (const [cat, exts] of Object.entries(FILE_CATEGORIES)) {
        if (exts.includes(f.ext)) { groups[cat].push(f); placed = true; break; }
      }
      if (!placed) groups["其他"].push(f);
    }

    const tabs = CATS.filter((k) => groups[k].length);
    if (!tabs.length) {
      el.innerHTML = `<div class="sec-title">文件中心</div><div class="dash-empty">桌面无文件</div>`;
      return;
    }
    // 保留当前 tab；若该分类已无文件（删光/改名），回退到首个 tab
    if (!tabs.includes(currentTab)) currentTab = tabs[0];
    el.innerHTML = `
    <div class="sec-title">文件中心
      <span class="file-search"><input id="d-file-search" type="text" placeholder="全盘搜文件名…" spellcheck="false" autocomplete="off" /><button class="file-reindex" id="d-file-reindex" title="重建索引" type="button">↻</button></span>
      <button class="file-layout-toggle" id="d-file-layout" title="切换布局">${layout === "grid" ? LAYOUT_LIST_ICON : LAYOUT_GRID_ICON}</button>
    </div>
    <div class="file-tabs" id="d-file-tabs"></div>
    <div class="file-tab-content" id="d-file-content"></div>
    <div class="file-search-results" id="d-file-results" hidden></div>
    <div class="recent-ops">
      <div class="sec-title"><span>最近操作</span><a class="recent-ops-all">全部记录 →</a></div>
      <div class="recent-ops-list" id="d-recent-ops-list">${renderRecentOps()}</div>
    </div>`;

    const tabsEl = el.querySelector("#d-file-tabs");
    const contentEl = el.querySelector("#d-file-content");
    const layoutBtn = el.querySelector("#d-file-layout");
    layoutBtn?.addEventListener("click", () => {
      layout = layout === "grid" ? "list" : "grid";
      // 持久化布局偏好
      if (!state.navState) state.navState = {};
      if (!state.navState.dashboard) state.navState.dashboard = {};
      state.navState.dashboard.layout = layout;
      saveState();
      layoutBtn.innerHTML = layout === "grid" ? LAYOUT_LIST_ICON : LAYOUT_GRID_ICON;
      renderContent();
    });
    el.querySelector(".recent-ops-all").addEventListener("click", showRecentOpsDialog);

    // —— 全盘搜索（自建索引，后端 file_index）——
    const searchEl = el.querySelector("#d-file-search");
    const resultsEl = el.querySelector("#d-file-results");
    let searchTimer = null;
    let indexPoll = null; // 建索引期间的轮询
    let readyOnce = false; // 索引就绪缓存：已就绪则后续击键跳过 index_status
    // 搜索期间改动过文件（重命名/删除）→ 清空搜索回到分类浏览时需重载桌面列表。
    // 分类视图渲染自 load() 一次性抓取的 groups 快照，不重载会一直显示旧文件名。
    let desktopStale = false;
    function setBrowseMode(browse) { // browse=true 显示桌面分类；false 显示搜索结果
      tabsEl.style.display = browse ? "" : "none";
      contentEl.style.display = browse ? "" : "none";
      resultsEl.hidden = browse;
    }
    async function runSearch(q) {
      clearTimeout(indexPoll); indexPoll = null;
      if (!q) {
        setBrowseMode(true);
        resultsEl.innerHTML = "";
        // 搜索期间动过文件：此刻输入框已空，重载不会丢查询状态，直接刷新分类视图
        if (desktopStale) { desktopStale = false; load(); }
        return;
      }
      setBrowseMode(false);
      if (!readyOnce) { // 就绪前需查状态；就绪后缓存，击键不再多一次 IPC
        let st;
        try { st = await invoke("index_status"); } catch { st = { ready: false }; }
        if (st.ready) { readyOnce = true; }
        else {
          if (!st.building) {
            resultsEl.innerHTML = `<div class="ev-hint">索引尚未就绪，点击右侧「↻」重建索引。</div>`;
            return;
          }
          resultsEl.innerHTML = `<div class="ev-hint">正在建立索引… 已扫描 ${st.scanned ?? 0} 项</div>`;
          indexPoll = setTimeout(() => { if (searchEl.value.trim() === q) runSearch(q); }, 1000);
          return;
        }
      }
      let res;
      try {
        res = await invoke("search_files", { query: q, limit: 120 });
      } catch (err) {
        readyOnce = false; // 出错后重置状态缓存，下次重新探测
        resultsEl.innerHTML = `<div class="ev-hint">搜索出错：${esc(String(err))}。可点「↻」重建索引或重试。</div>`;
        return;
      }
      if (searchEl.value.trim() !== q) return; // 输入已变化，丢弃过期结果
      if (!res.length) { resultsEl.innerHTML = `<div class="dash-empty">没有匹配「${esc(q)}」的文件</div>`; return; }
      resultsEl.innerHTML = `<div class="ev-list">${res.map(evRow).join("")}</div>`;
    }
    // 事件委托：只挂一个双击监听，避免每次渲染重建 200 个监听
    resultsEl.addEventListener("dblclick", async (e) => {
      const row = e.target.closest(".ev-item");
      if (!row) return;
      try {
        await invoke("open_path", { target: row.dataset.path });
        pushRecentOp({ kind: "file_open", name: row.dataset.path.split(/[\\/]/).pop() });
      } catch (err) {
        showDialog({ title: "打开失败", message: String(err), okText: "知道了", showCancel: false });
      }
    });
    // 同样用事件委托挂右键：搜索结果行作用于**全盘绝对路径**，走 *_path 命令族
    resultsEl.addEventListener("contextmenu", (e) => {
      const row = e.target.closest(".ev-item");
      if (!row) return;
      e.preventDefault();
      showPathMenu(e.clientX, e.clientY, row.dataset.path, () => {
        desktopStale = true; // 桌面分类视图可能也含该文件，回浏览态时需重载
        runSearch(searchEl.value.trim());
      });
    });
    searchEl.addEventListener("input", () => {
      clearTimeout(searchTimer);
      const q = searchEl.value.trim();
      searchTimer = setTimeout(() => runSearch(q), 200);
    });
    searchEl.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { clearTimeout(indexPoll); searchEl.value = ""; runSearch(""); searchEl.blur(); }
    });
    el.querySelector("#d-file-reindex").addEventListener("click", async () => {
      await invoke("rebuild_index");
      readyOnce = false; // 重建后索引不在就绪态，重新走状态轮询
      runSearch(searchEl.value.trim());
    });

    function renderContent() {
      const arr = groups[currentTab] || [];
      const icon = FILE_ICONS[currentTab] || ICON_PAPERCLIP;
      const cell = (f) => {
        const ext = (f.ext || "").toLowerCase();
        const thumb = IMAGE_EXTS.has(ext)
          ? `<span class="fg-thumb-box"><span class="fg-icon">${icon}</span><img class="fg-thumb" data-img="${esc(f.name)}" alt="" hidden></span>`
          : `<span class="fg-icon">${icon}</span>`;
        const cls = layout === "grid" ? "fg-card" : "fg-item";
        return `<div class="${cls}" data-name="${esc(f.name)}" title="${esc(f.name)}（右键操作）">
          ${thumb}<span class="fg-name">${esc(f.name)}</span>
        </div>`;
      };
      contentEl.innerHTML = `<div class="${layout === "grid" ? "fg-grid" : "fg-list"}">` + arr.map(cell).join("") + `</div>`;
      contentEl.querySelectorAll(".fg-item, .fg-card").forEach((item) => {
        item.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          showFileMenu(e.clientX, e.clientY, item.dataset.name, load);
        });
        item.addEventListener("dblclick", () => {
          invoke("open_file", { name: item.dataset.name });
        });
      });
      loadThumbs(contentEl);
    }

    // 异步为图片文件加载缩略图（成功→显示图，失败→移除 img 露出图标兜底）
    // 并发限流：一次最多 4 个在途请求，避免几十张图同时读盘/占满 IPC；容器被切走后剩余项跳过
    async function loadThumbs(container) {
      const imgs = Array.from(container.querySelectorAll("img.fg-thumb[data-img]"));
      const queue = imgs.slice();
      const worker = async () => {
        while (queue.length) {
          const img = queue.shift();
          if (!img.isConnected) continue; // 已切走：容器被重建，无需继续
          const name = img.dataset.img;
          if (!THUMB_CACHE.has(name)) {
            try {
              THUMB_CACHE.set(name, (await invoke("image_thumbnail", { name })) || "");
              // 容量上限：超限淘汰最早条目（Map 按插入序迭代），避免 base64 常驻内存无限增长
              if (THUMB_CACHE.size > 200) {
                let n = THUMB_CACHE.size - 200;
                for (const k of THUMB_CACHE.keys()) {
                  THUMB_CACHE.delete(k);
                  if (--n <= 0) break;
                }
              }
            } catch (e) {
              THUMB_CACHE.set(name, "");
            }
          }
          const url = THUMB_CACHE.get(name);
          if (!url) { img.remove(); continue; }
          img.addEventListener("error", () => img.remove(), { once: true });
          img.src = url;
          img.hidden = false;
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, imgs.length) }, worker));
    }

    function renderTabs() {
      tabsEl.innerHTML = tabs.map((cat) => `
      <button class="file-tab${cat === currentTab ? " active" : ""}" data-cat="${cat}">${cat}<span class="ft-count">${groups[cat].length}</span></button>`).join("");
      tabsEl.querySelectorAll(".file-tab").forEach((btn) => {
        btn.addEventListener("click", () => {
          currentTab = btn.dataset.cat;
          // 持久化当前分类 tab，切走再回来时保持上次浏览位置
          if (!state.navState) state.navState = {};
          if (!state.navState.dashboard) state.navState.dashboard = {};
          state.navState.dashboard.tab = currentTab;
          saveState();
          renderTabs();
          renderContent();
        });
      });
    }

    renderTabs();
    renderContent();
  }

  await load();
  view.onDestroy(hideFileMenu);
}

// -------------------- 右键菜单 --------------------
// 两种作用域的菜单共用外壳：桌面分类视图用「文件名」作用域命令，
// 全盘搜索结果用「绝对路径」作用域命令（见 showPathMenu 注释）。
let fileMenuEl = null;

// 菜单外壳：按实测尺寸把位置夹回视口内、点击外部关闭、随视图销毁清理。
// items: [{ act, label, danger? }]；onPick(act) 处理动作。
// 销毁清理统一由 renderFilesBlock 里的 view.onDestroy(hideFileMenu) 负责，
// 此处不再按次注册（原实现每次打开都注册一次，会累积重复项）。
function openContextMenu(x, y, items, onPick) {
  hideFileMenu();
  fileMenuEl = document.createElement("div");
  fileMenuEl.className = "file-menu";
  fileMenuEl.innerHTML = items
    .map((it) => `<button data-act="${it.act}"${it.danger ? ' class="danger"' : ""}>${esc(it.label)}</button>`)
    .join("");
  // 先以不可见插入以量取实际尺寸，再夹取位置：菜单项数量不同高度差异明显，
  // 用固定余量（原实现 180/160）在屏幕底部会溢出。
  fileMenuEl.style.visibility = "hidden";
  document.body.appendChild(fileMenuEl);
  const w = fileMenuEl.offsetWidth;
  const h = fileMenuEl.offsetHeight;
  fileMenuEl.style.left = Math.max(4, Math.min(x, window.innerWidth - w - 4)) + "px";
  fileMenuEl.style.top = Math.max(4, Math.min(y, window.innerHeight - h - 4)) + "px";
  // 测量阶段入场动画已跑完，这里重放一次
  fileMenuEl.style.animation = "none";
  void fileMenuEl.offsetWidth;
  fileMenuEl.style.animation = "";
  fileMenuEl.style.visibility = "";

  fileMenuEl.addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    hideFileMenu();
    await onPick(btn.dataset.act);
  });

  setTimeout(() => document.addEventListener("click", hideFileMenu, { once: true }), 0);
}

function hideFileMenu() {
  if (fileMenuEl) { fileMenuEl.remove(); fileMenuEl = null; }
}

// 桌面文件右键菜单（打开 / 资源管理器定位 / 重命名 / 删除到回收站）
// 这些命令是 desktop_dir 作用域的：后端把入参当文件名 join 到桌面目录。
function showFileMenu(x, y, name, onChange) {
  openContextMenu(x, y, [
    { act: "open", label: "打开" },
    { act: "reveal", label: "在资源管理器中显示" },
    { act: "rename", label: "重命名" },
    { act: "delete", label: "删除（回收站）", danger: true },
  ], async (act) => {
    try {
      if (act === "open") {
        await invoke("open_file", { name });
        pushRecentOp({ kind: "file_open", name });
      } else if (act === "reveal") {
        await invoke("reveal_file", { name });
        pushRecentOp({ kind: "file_reveal", name });
      } else if (act === "rename") {
        const newName = await showDialog({ title: "重命名", input: true, inputValue: name, okText: "确定" });
        if (newName && newName !== name) {
          await invoke("rename_file", { name, newName });
          pushRecentOp({ kind: "file_rename", name, text: `${name} → ${newName}` });
          onChange();
        }
      } else if (act === "delete") {
        const ok = await showDialog({ title: "删除文件", message: `确认删除「${name}」？\n（移到回收站，可恢复）`, okText: "删除", danger: true });
        if (!ok) return;
        await invoke("delete_file", { name });
        pushRecentOp({ kind: "file_delete", name });
        onChange();
      }
    } catch (err) {
      showDialog({ title: "操作失败", message: String(err), okText: "知道了", showCancel: false });
    }
  });
}

// 全盘搜索结果右键菜单 —— 作用域是**绝对路径**，与桌面菜单的关键差异：
// 命中可能在任何盘符（含系统目录），不能走 open_file/reveal_file/rename_file/delete_file
// （那些会把路径当文件名拼到桌面目录上，结果是找不到文件或误改桌面上的同名文件），
// 故一律走 *_path 命令族。
function showPathMenu(x, y, path, onChange) {
  const name = path.split(/[\\/]/).pop() || path;
  openContextMenu(x, y, [
    { act: "open", label: "打开" },
    { act: "reveal", label: "在资源管理器中显示" },
    { act: "copy", label: "复制完整路径" },
    { act: "rename", label: "重命名" },
    { act: "delete", label: "删除（回收站）", danger: true },
  ], async (act) => {
    try {
      if (act === "open") {
        await invoke("open_path", { target: path });
        pushRecentOp({ kind: "file_open", name });
      } else if (act === "reveal") {
        await invoke("reveal_path", { target: path });
        pushRecentOp({ kind: "file_reveal", name });
      } else if (act === "copy") {
        await copyText(path);
      } else if (act === "rename") {
        const newName = await showDialog({ title: "重命名", input: true, inputValue: name, okText: "确定" });
        if (newName && newName !== name) {
          await invoke("rename_path", { target: path, newName });
          pushRecentOp({ kind: "file_rename", name, text: `${name} → ${newName}` });
          onChange();
        }
      } else if (act === "delete") {
        // 确认框里带上完整路径：搜索命中可能在任何位置，只给文件名不足以判断删的是哪一个
        const ok = await showDialog({
          title: "删除文件",
          message: `确认删除「${name}」？\n${path}\n（移到回收站，可恢复）`,
          okText: "删除",
          danger: true,
        });
        if (!ok) return;
        await invoke("delete_path", { target: path });
        pushRecentOp({ kind: "file_delete", name });
        onChange();
      }
    } catch (err) {
      showDialog({ title: "操作失败", message: String(err), okText: "知道了", showCancel: false });
    }
  });
}

// 复制文本到剪贴板：优先 Clipboard API，不可用则回退 textarea + execCommand。
// 打包版 origin 为 http://tauri.localhost（Chromium 视 *.localhost 为安全上下文），
// 但 WebView2 版本差异下 clipboard 仍可能缺失，故保留回退分支。
async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      toast("已复制路径");
      return;
    }
  } catch (_) { /* 落到回退分支 */ }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.cssText = "position:fixed;top:-1000px;opacity:0;";
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch (_) { ok = false; }
  ta.remove();
  toast(ok ? "已复制路径" : "复制失败，请手动选择路径");
}

