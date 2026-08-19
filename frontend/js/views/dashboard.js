// 今日概览视图：待办事项（左）+ 文件中心/最近操作（右）。
import { Bus, invoke } from "../bus.js";
import { Tasks } from "../tasks.js";
import { state, saveState, pushRecentOp, onRecentOp } from "../state.js";
import { STATUS_LABEL, TASK_STATUSES, PRIORITY_LABEL } from "../config.js";
import { ICON_EXTERNAL, ICON_SEARCH, ICON_EDIT, ICON_TRASH, ICON_CHECK, ICON_FOLDER, ICON_IMAGE, ICON_DOC, ICON_CODE, ICON_ARCHIVE, ICON_VIDEO, ICON_MUSIC, ICON_PAPERCLIP } from "../icons.js";
import { esc, showDialog } from "./common.js";
import { createDatePicker } from "../datepicker.js";
import { createSelect } from "../selectbox.js";

// 最近操作类型 → 图标（线性 SVG）+ 标签
const OP_META = {
  file_open:   { icon: ICON_EXTERNAL, type: "文件" },
  file_reveal: { icon: ICON_SEARCH, type: "文件" },
  file_rename: { icon: ICON_EDIT, type: "文件" },
  file_delete: { icon: ICON_TRASH, type: "系统" },
  task_create: { icon: ICON_CHECK, type: "任务" },
  task_update: { icon: ICON_EDIT, type: "任务" },
  task_delete: { icon: ICON_TRASH, type: "任务" },
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
  const m = OP_META[op.kind] || { icon: "•", type: "" };
  const verb = OP_VERB[op.kind] || op.action || "操作";
  const name = op.name || op.text || "";
  return `
    <div class="recent-op">
      <span class="ro-icon">${m.icon}</span>
      <span class="ro-text">${esc(verb)}了 <b>${esc(name)}</b></span>
      <span class="ro-time">${relTime(op.ts)}</span>
      <span class="ro-type${m.type === "任务" ? " task" : m.type === "系统" ? " system" : ""}">${esc(m.type)}</span>
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

const FILE_CATEGORIES = {
  图片: ["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg", "ico"],
  文档: ["doc", "docx", "pdf", "txt", "md", "xlsx", "xls", "pptx", "ppt", "csv"],
  代码: ["js", "ts", "rs", "py", "go", "java", "cpp", "c", "h", "html", "css", "json", "xml", "sh"],
  压缩: ["zip", "rar", "7z", "tar", "gz", "bz2"],
  视频: ["mp4", "avi", "mkv", "mov", "wmv", "flv", "webm"],
  音频: ["mp3", "wav", "flac", "aac", "ogg", "m4a"],
};

const FILE_ICONS = {
  文件夹: ICON_FOLDER, 图片: ICON_IMAGE, 文档: ICON_DOC, 代码: ICON_CODE,
  压缩: ICON_ARCHIVE, 视频: ICON_VIDEO, 音频: ICON_MUSIC, 其他: ICON_PAPERCLIP,
};

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
    <div class="dash-section-title">
      <span>待办事项</span>
      <button class="dash-add-btn" id="d-task-add" title="添加待办" aria-label="添加待办">＋</button>
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
    const tasks = Tasks.list().slice(0, 8);
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

  // 完整刷新：重新拉取桌面文件 → 重新分组 → 重渲染 tabs/content（操作后调用）
  async function load() {
    let files;
    try {
      files = await invoke("list_desktop_files");
    } catch (e) {
      el.innerHTML = `<div class="dash-section-title">文件中心</div><div class="dash-empty">无法读取（dev 态不可用或未授权）</div>`;
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
      el.innerHTML = `<div class="dash-section-title">文件中心</div><div class="dash-empty">桌面无文件</div>`;
      return;
    }
    // 保留当前 tab；若该分类已无文件（删光/改名），回退到首个 tab
    if (!tabs.includes(currentTab)) currentTab = tabs[0];
    el.innerHTML = `
    <div class="dash-section-title">文件中心 <span class="dash-count">${files.length}</span></div>
    <div class="file-tabs" id="d-file-tabs"></div>
    <div class="file-tab-content" id="d-file-content"></div>
    <div class="recent-ops">
      <div class="recent-ops-head"><span>最近操作</span><a class="recent-ops-all">全部记录 →</a></div>
      <div class="recent-ops-list" id="d-recent-ops-list">${renderRecentOps()}</div>
    </div>`;

    const tabsEl = el.querySelector("#d-file-tabs");
    const contentEl = el.querySelector("#d-file-content");
    el.querySelector(".recent-ops-all").addEventListener("click", showRecentOpsDialog);

    function renderContent() {
      const arr = groups[currentTab] || [];
      const icon = FILE_ICONS[currentTab] || ICON_PAPERCLIP;
      contentEl.innerHTML = arr.map((f) => `
      <div class="fg-item" data-name="${esc(f.name)}" title="${esc(f.name)}（右键操作）">
        <span class="fg-icon">${icon}</span><span class="fg-name">${esc(f.name)}</span>
      </div>`).join("");
      contentEl.querySelectorAll(".fg-item").forEach((item) => {
        item.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          showFileMenu(e.clientX, e.clientY, item.dataset.name, view, load);
        });
        item.addEventListener("dblclick", () => {
          invoke("open_file", { name: item.dataset.name });
        });
      });
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

// 文件右键菜单（打开 / 资源管理器定位 / 重命名 / 删除到回收站）
let fileMenuEl = null;
function showFileMenu(x, y, name, view, onChange) {
  hideFileMenu();
  fileMenuEl = document.createElement("div");
  fileMenuEl.className = "file-menu";
  fileMenuEl.style.left = Math.min(x, window.innerWidth - 180) + "px";
  fileMenuEl.style.top = Math.min(y, window.innerHeight - 160) + "px";
  fileMenuEl.innerHTML = `
    <button data-act="open">打开</button>
    <button data-act="reveal">在资源管理器中显示</button>
    <button data-act="rename">重命名</button>
    <button data-act="delete" class="danger">删除（回收站）</button>`;
  document.body.appendChild(fileMenuEl);

  fileMenuEl.addEventListener("click", async (e) => {
    const act = e.target.dataset.act;
    if (!act) return;
    hideFileMenu();
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

  setTimeout(() => document.addEventListener("click", hideFileMenu, { once: true }), 0);
  view.onDestroy(hideFileMenu);
}
function hideFileMenu() {
  if (fileMenuEl) { fileMenuEl.remove(); fileMenuEl = null; }
}
