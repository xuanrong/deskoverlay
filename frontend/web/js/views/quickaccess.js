// 快捷访问视图（独立导航模块）：网页链接 / 文件夹 / 文件 快捷方式，支持分组与跨组拖动。
import { invoke } from "../bus.js";
import { QuickAccess } from "../quickAccess.js";
import { ICON_FOLDER, ICON_EDIT, ICON_TRASH, ICON_PAPERCLIP, ICON_GLOBE } from "../icons.js";
import { FILE_CATEGORIES, FILE_ICONS } from "../filetypes.js";
import { esc, showDialog } from "./common.js";
import { createSelect } from "../selectbox.js";

function qaCardIcon(q) {
  if (q.type === "url") return ICON_GLOBE;
  if (q.type === "folder") return ICON_FOLDER;
  const ext = (q.target.split(".").pop() || "").toLowerCase();
  for (const [cat, exts] of Object.entries(FILE_CATEGORIES)) if (exts.includes(ext)) return FILE_ICONS[cat] || ICON_DOC;
  return ICON_PAPERCLIP;
}
function qaCardHtml(q) {
  return `<div class="qa-card" data-id="${q.id}" draggable="false">
      <span class="qa-icon">${qaCardIcon(q)}</span>
      <span class="qa-title">${esc(q.title || q.target)}</span>
      <span class="qa-actions">
        <button class="qa-act" data-act="edit" title="编辑">${ICON_EDIT}</button>
        <button class="qa-act danger" data-act="delete" title="删除">${ICON_TRASH}</button>
      </span>
    </div>`;
}

export function renderQuickAccess(view) {
  view.header.style.display = "none";
  const el = view.body;
  el.innerHTML = `
    <div class="sec-title">快捷访问
      <span class="qa-tools">
        <button class="btn-ghost" id="qa-manage" title="管理分组">管理分组</button>
        <button class="btn-primary" id="qa-add" title="添加快捷访问">＋ 添加</button>
      </span>
    </div>
    <div class="qa-groups" id="qa-groups"></div>`;

  const groupsEl = el.querySelector("#qa-groups");
  let suppressClick = false; // 拖拽结束后的 click 不触发「打开」
  let drag = null; // { id, el, startX, startY, moved, ghost, raf }

  function clearDragVisual() {
    groupsEl.querySelectorAll(".qa-card").forEach((r) => r.classList.remove("dragging", "qa-insert-before", "qa-insert-after"));
    document.body.classList.remove("no-select");
    if (drag) {
      if (drag.ghost) drag.ghost.remove();
      if (drag.raf) cancelAnimationFrame(drag.raf);
      drag.ghost = null;
      drag.raf = 0;
    }
  }

  // 扫描所有分组的卡片 + 空分组行，返回指针最近的插入点 { groupId, atId, cls }
  function targetAt(x, y) {
    let best = null;
    let bestDist = Infinity;
    const cards = Array.from(groupsEl.querySelectorAll(".qa-card:not(.dragging)"));
    for (const c of cards) {
      const r = c.getBoundingClientRect();
      const groupId = c.dataset.group;
      const before = { atId: c.dataset.id, cls: "qa-insert-before", dx: x - r.left, dy: y - r.top };
      const after = { atId: c.dataset.id, cls: "qa-insert-after", dx: r.right - x, dy: r.bottom - y };
      for (const cand of [before, after]) {
        const d = Math.hypot(Math.max(0, cand.dx), Math.max(0, cand.dy));
        if (d < bestDist) { bestDist = d; best = { groupId, atId: cand.atId, cls: cand.cls }; }
      }
    }
    const rows = Array.from(groupsEl.querySelectorAll(".qa-row"));
    for (const row of rows) {
      const r = row.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
        const groupId = row.dataset.group;
        const last = row.querySelector(".qa-card:last-child");
        const d = Math.abs(y - r.top);
        if (!best || d < 8) best = { groupId, atId: last ? last.dataset.id : null, cls: "qa-insert-after" };
      }
    }
    return best;
  }

  function finishDrag() {
    const fromId = drag?.id;
    const moved = drag?.moved;
    const t = drag?.target;
    clearDragVisual();
    drag = null;
    if (moved && fromId && t && !(t.groupId && t.atId === fromId)) {
      suppressClick = true;
      // 拖拽释放通常不派发 click，短暂复位避免吞掉下一次真实的快捷方式点击
      setTimeout(() => { suppressClick = false; }, 300);
      QuickAccess.move(fromId, t.groupId, t.atId);
      render();
    }
  }

  function render() {
    const groupsNow = QuickAccess.listGroups();
    groupsEl.innerHTML = groupsNow.length
      ? groupsNow.map((g) => {
          const items = QuickAccess.list().filter((q) => q.groupId === g.id);
          return `
        <div class="qa-group" data-gid="${g.id}">
          <div class="qa-group-head">${esc(g.name || "")}<span class="qa-count">${items.length}</span></div>
          <div class="qa-row" data-group="${g.id}">${items.map(qaCardHtml).join("") || `<div class="dash-empty">＋ 点击右上角"添加"加入此分组</div>`}</div>
        </div>`;
        }).join("")
      : `<div class="dash-empty">暂无分组，点「管理分组」新建</div>`;

    groupsEl.querySelectorAll(".qa-card").forEach((card) => {
      const q = QuickAccess.list().find((x) => x.id === card.dataset.id);
      if (!q) return;
      card.dataset.group = q.groupId;

      card.addEventListener("click", (e) => {
        if (suppressClick) { suppressClick = false; return; }
        if (e.target.closest(".qa-act")) return;
        invoke("open_path", { target: q.target }).catch((err) =>
          showDialog({ title: "打开失败", message: String(err), okText: "知道了", showCancel: false })
        );
      });
      card.querySelector("[data-act='edit']").addEventListener("click", (e) => {
        e.stopPropagation();
        showQuickAccessModal("edit", q, render);
      });
      card.querySelector("[data-act='delete']").addEventListener("click", async (e) => {
        e.stopPropagation();
        const ok = await showDialog({ title: "删除快捷方式", message: `确认删除「${q.title || q.target}」？`, okText: "删除", danger: true });
        if (!ok) return;
        QuickAccess.remove(q.id);
        render();
      });
      card.addEventListener("pointerdown", (e) => {
        if (e.button !== 0 || e.target.closest(".qa-act")) return;
        drag = { id: card.dataset.id, el: card, startX: e.clientX, startY: e.clientY, target: null, moved: false, ghost: null, raf: 0 };
        try { card.setPointerCapture(e.pointerId); } catch (_) {}
      });
    });
  }

  window.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (!drag.moved && Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
    drag.moved = true;
    drag.el.classList.add("dragging");
    document.body.classList.add("no-select");

    if (!drag.ghost) {
      const rect = drag.el.getBoundingClientRect();
      const ghost = drag.el.cloneNode(true);
      ghost.className = "qa-card qa-ghost";
      ghost.removeAttribute("data-id");
      ghost.style.left = rect.left + "px";
      ghost.style.top = rect.top + "px";
      ghost.style.width = rect.width + "px";
      document.body.appendChild(ghost);
      drag.ghost = ghost;
    }
    if (!drag.raf) {
      drag.raf = requestAnimationFrame(() => {
        drag.raf = 0;
        if (drag.ghost) drag.ghost.style.transform = `translate(${dx}px, ${dy}px)`;
      });
    }

    const t = targetAt(e.clientX, e.clientY);
    drag.target = t;
    groupsEl.querySelectorAll(".qa-card").forEach((r) => r.classList.remove("qa-insert-before", "qa-insert-after"));
    if (t) groupsEl.querySelector(`.qa-card[data-id="${t.atId}"]`)?.classList.add(t.cls);
  });

  window.addEventListener("pointerup", () => {
    if (!drag) return;
    if (!drag.moved) { clearDragVisual(); drag = null; return; }
    finishDrag();
  });
  window.addEventListener("pointercancel", () => {
    if (drag) { clearDragVisual(); drag = null; }
  });

  el.querySelector("#qa-add").addEventListener("click", () => showQuickAccessModal("new", null, render));
  el.querySelector("#qa-manage").addEventListener("click", () => showQuickAccessGroupsModal(render));
  view.onDestroy(() => hideQuickAccessModal());

  render();
}

// 添加/编辑 弹窗：类型 / 名称 / 地址（可浏览） / 分组
let qaModalEl = null;
function hideQuickAccessModal() {
  if (qaModalEl) {
    qaModalEl.querySelectorAll(".dp, .cs").forEach((d) => d._close?.());
    qaModalEl.remove();
    qaModalEl = null;
  }
}
function showQuickAccessModal(mode, item, onDone) {
  hideQuickAccessModal();
  const isEdit = mode === "edit";
  qaModalEl = document.createElement("div");
  qaModalEl.className = "task-modal-overlay";
  qaModalEl.innerHTML = `
    <div class="task-modal">
      <h3>${isEdit ? "编辑快捷方式" : "添加快捷访问"}</h3>
      <div class="tm-field"><label>类型</label><div id="qa-type"></div></div>
      <div class="tm-field"><label>名称</label><input id="qa-title" type="text" value="${item ? esc(item.title || "") : ""}" placeholder="显示名称" /></div>
      <div class="tm-field">
        <label>地址</label>
        <div class="tm-row" style="grid-template-columns: 1fr auto;">
          <input id="qa-target" type="text" value="${item ? esc(item.target) : ""}" placeholder="${isEdit ? "网页链接或本地路径" : "粘贴链接，文件夹/文件可点浏览选择"}" />
          <button id="qa-browse" class="tm-cancel" type="button" style="margin:0;">浏览…</button>
        </div>
      </div>
      <div class="tm-field"><label>所属分组</label><div id="qa-group"></div></div>
      <div class="tm-actions">
        ${isEdit ? `<button class="tm-delete">删除</button>` : ""}
        <button class="tm-cancel" id="qa-cancel">取消</button>
        <button class="btn-primary tm-ok">${isEdit ? "保存" : "添加"}</button>
      </div>
    </div>`;
  document.body.appendChild(qaModalEl);

  const typeEl = qaModalEl.querySelector("#qa-type");
  const titleEl = qaModalEl.querySelector("#qa-title");
  const targetEl = qaModalEl.querySelector("#qa-target");
  const groupEl = qaModalEl.querySelector("#qa-group");
  const browseBtn = qaModalEl.querySelector("#qa-browse");

  const groups = QuickAccess.listGroups();
  createSelect({
    el: typeEl, value: item ? item.type : "url",
    options: [
      { value: "url", label: "网页链接" },
      { value: "folder", label: "文件夹" },
      { value: "file", label: "文件" },
    ],
    onChange: (v) => { browseBtn.style.display = v === "url" ? "none" : ""; },
  });
  browseBtn.style.display = item && item.type !== "url" ? "" : "none";
  createSelect({
    el: groupEl, value: item ? item.groupId : (groups[0]?.id || ""),
    options: [...groups.map((g) => ({ value: g.id, label: g.name })), { value: "__new", label: "＋ 新建分组…" }],
  });

  browseBtn.addEventListener("click", async () => {
    const type = typeEl.value;
    if (type === "folder") await pickAndFill("folder");
    else if (type === "file") await pickAndFill("file");
  });
  async function pickAndFill(kind) {
    try {
      const p = await invoke(kind === "folder" ? "pick_folder" : "pick_file");
      if (!p) return;
      targetEl.value = p;
      if (!titleEl.value.trim()) {
        const base = p.split(/[\\/]/).pop() || p;
        titleEl.value = base;
      }
    } catch (err) {
      showDialog({ title: "选择失败", message: String(err), okText: "知道了", showCancel: false });
    }
  }

  titleEl.focus();
  const submit = async () => {
    const gv = groupEl.value;
    let groupId = gv;
    if (gv === "__new") {
      const name = await showDialog({ title: "新建分组", input: true, okText: "创建" });
      if (!name) return;
      QuickAccess.addGroup(name);
      groupId = QuickAccess.listGroups().slice(-1)[0].id;
    }
    const data = {
      type: typeEl.value,
      title: titleEl.value.trim(),
      target: targetEl.value.trim(),
      groupId,
    };
    if (!data.target) { targetEl.focus(); return; }
    if (isEdit) QuickAccess.update(item.id, data);
    else QuickAccess.add(data);
    hideQuickAccessModal();
    onDone?.();
  };

  qaModalEl.querySelector("#qa-cancel").addEventListener("click", hideQuickAccessModal);
  qaModalEl.querySelector(".tm-ok").addEventListener("click", submit);
  qaModalEl.querySelector(".tm-delete")?.addEventListener("click", async () => {
    const ok = await showDialog({ title: "删除快捷方式", message: "确认删除该快捷方式？", okText: "删除", danger: true });
    if (!ok) return;
    QuickAccess.remove(item.id);
    hideQuickAccessModal();
    onDone?.();
  });
  qaModalEl.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hideQuickAccessModal();
    else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) submit();
  });
}

// 分组管理弹窗：新增 / 重命名 / 删除
function showQuickAccessGroupsModal(onDone) {
  hideQuickAccessModal();
  const groups = QuickAccess.listGroups();
  qaModalEl = document.createElement("div");
  qaModalEl.className = "task-modal-overlay";
  qaModalEl.innerHTML = `
    <div class="task-modal">
      <h3>管理分组</h3>
      <div class="tm-field"><label>新增分组</label>
        <div class="tm-row" style="grid-template-columns: 1fr auto;">
          <input id="qa-g-new" type="text" placeholder="分组名称" />
          <button class="btn-primary" id="qa-g-add" type="button">添加</button>
        </div>
      </div>
      <div class="tm-field"><label>已有分组</label>
        <div class="qa-glist" id="qa-glist">
          ${groups.map((g) => `
            <div class="qa-gitem" data-gid="${g.id}">
              <span class="qa-gname">${esc(g.name)}<span class="qa-count">${QuickAccess.list().filter((q) => q.groupId === g.id).length}</span></span>
              <span class="qa-actions">
                <button class="qa-act" data-act="rename" title="重命名">${ICON_EDIT}</button>
                <button class="qa-act danger" data-act="delete" title="删除分组">${ICON_TRASH}</button>
              </span>
            </div>`).join("")}
        </div>
      </div>
      <div class="tm-actions"><button class="tm-cancel">关闭</button></div>
    </div>`;
  document.body.appendChild(qaModalEl);

  const addBtn = qaModalEl.querySelector("#qa-g-add");
  const newInput = qaModalEl.querySelector("#qa-g-new");
  const addGroup = () => {
    const name = newInput.value.trim();
    if (!name) return;
    QuickAccess.addGroup(name);
    onDone?.();
    showQuickAccessGroupsModal(onDone);
  };
  addBtn.addEventListener("click", addGroup);
  newInput.addEventListener("keydown", (e) => { if (e.key === "Enter") addGroup(); });

  qaModalEl.querySelector("#qa-glist").addEventListener("click", async (e) => {
    const btn = e.target.closest(".qa-act");
    const row = e.target.closest(".qa-gitem");
    if (!btn || !row) return;
    const gid = row.dataset.gid;
    const g = QuickAccess.listGroups().find((x) => x.id === gid);
    if (!g) return;
    if (btn.dataset.act === "rename") {
      const name = await showDialog({ title: "重命名分组", input: true, inputValue: g.name, okText: "确定" });
      if (!name || name === g.name) return;
      QuickAccess.renameGroup(gid, name);
      onDone?.();
      showQuickAccessGroupsModal(onDone);
    } else if (btn.dataset.act === "delete") {
      const ok = await showDialog({ title: "删除分组", message: `删除「${g.name}」？其内快捷方式将并入「默认」分组。`, okText: "删除", danger: true });
      if (!ok) return;
      QuickAccess.removeGroup(gid);
      onDone?.();
      if (QuickAccess.listGroups().length) showQuickAccessGroupsModal(onDone);
      else hideQuickAccessModal();
    }
  });

  qaModalEl.querySelector(".tm-cancel").addEventListener("click", hideQuickAccessModal);
  qaModalEl.addEventListener("keydown", (e) => { if (e.key === "Escape") hideQuickAccessModal(); });
}