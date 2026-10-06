// 快捷访问视图（独立导航模块）：网页链接 / 文件夹 / 文件 快捷方式，支持分组与跨组拖动。
// 两套独立的拖拽：**卡片**（跨组移动 + 组内排序，落点见 pickGroupRow）
// 与**分组**（整体排序，只能从标题栏抓手发起，落点见 pickGroupDrop）。
// 分组拖拽不绑在整组上：整组拖会和卡片拖抢同一个手势，标题栏是唯一不冲突的抓手。
import { invoke } from "../bus.js";
import { QuickAccess } from "../quickAccess.js";
import { ICON_FOLDER, ICON_EDIT, ICON_TRASH, ICON_PAPERCLIP, ICON_GLOBE, ICON_DOC, ICON_GRIP } from "../icons.js";
import { FILE_CATEGORIES, FILE_ICONS } from "../filetypes.js";
import { showDialog } from "./common.js";
import { esc } from "../utils.js";
import { createSelect } from "../selectbox.js";

function qaCardIcon(q) {
  if (q.type === "url") return ICON_GLOBE;
  if (q.type === "folder") return ICON_FOLDER;
  const ext = (q.target.split(".").pop() || "").toLowerCase();
  for (const [cat, exts] of Object.entries(FILE_CATEGORIES)) if (exts.includes(ext)) return FILE_ICONS[cat] || ICON_DOC;
  return ICON_PAPERCLIP;
}
function qaCardHtml(q) {
  const icon = q.type === "url" && q.icon
    ? `<img class="qa-favicon" src="${q.icon}" alt="" />`
    : qaCardIcon(q);
  return `<div class="qa-card" data-id="${q.id}" draggable="false">
      <span class="qa-icon">${icon}</span>
      <span class="qa-title">${esc(q.title || q.target)}</span>
      <span class="qa-actions">
        <button class="qa-act" data-act="edit" title="编辑">${ICON_EDIT}</button>
        <button class="qa-act danger" data-act="delete" title="删除">${ICON_TRASH}</button>
      </span>
    </div>`;
}

/// 纵向一维列表的落点（「管理分组」弹窗里用）：返回「应插到第几行**之前**」，
/// `rects.length` = 插到末尾。`skipIndex` = 正在拖的那一行。
///
/// 与 `pickGroupDrop` 分开写而不是加开关：两者几何不同 —— 三列栅格要分「上下半区 + 左右半区」，
/// 而这里的行是**等宽整行**，左右半区没有意义（指针永远落在行的横向范围内），
/// 硬套会变成「只有右半行才是『插到后面』」，上下拖时手感忽左忽右。
export function pickRowDrop(rects, y, skipIndex) {
  for (let i = 0; i < rects.length; i++) {
    if (i === skipIndex) continue;
    const r = rects[i];
    if (y < r.top + r.height / 2) return i;   // 指针在该行中线之上 → 插到它前
  }
  return rects.length;
}

/// 分组拖拽的落点：返回「应插到第几个组**之前**」（`rects.length` = 插到末尾）。
/// `skipIndex` = 正在拖动的那个组（自己当然不算落点）。
///
/// 判据与卡片落点同构（**行优先**）：先把「完全在指针上方」的组跳过，再遇到「完全在指针下方」
/// 的组就插到它前面；同一条水平带内则比左右半区。三列并排时这一步是必需的 ——
/// 只看纵向距离的话同一带里三个组无从区分（同 `pickGroupRow` 踩过的坑）。
export function pickGroupDrop(rects, x, y, skipIndex) {
  for (let i = 0; i < rects.length; i++) {
    if (i === skipIndex) continue;
    const r = rects[i];
    if (r.bottom <= y) continue;              // 整组在指针上方：继续往后找
    if (r.top > y) return i;                  // 整组在指针下方：插到它前
    if (r.left + r.width / 2 < x) continue;   // 同一水平带且在中心右侧：继续
    return i;
  }
  return rects.length;                        // 落到所有组之后 → 末尾
}

/// 选出指针所在的「组」（`rects` = 各 `.qa-row` 的矩形，按 DOM 顺序）。
/// 抽成纯函数只为能离线断言：它依赖矩形而不是 DOM，喂几个假矩形就能跑。
///
/// ⚠ 这里必须看**横向**。分组改成三列后，同一条水平带里并排着 3 个 `.qa-row`，
/// 它们的 `mid` 几乎相同 —— 只比 `|y - mid|` 的话，DOM 里靠前的那一组永远获胜，
/// 表现为「把卡片拖到第 3 组，却插进了第 1 组」，而且只在多列时才复现。
/// 故先按「指针是否落在该组矩形内」分层（横向权重高于纵向），层内再比纵向距离。
export function pickGroupRow(rects, x, y) {
  let best = -1;
  let bestTier = Infinity;
  let bestD = Infinity;
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i];
    const inX = x >= r.left && x <= r.right;
    const inY = y >= r.top && y <= r.bottom;
    // 都命中 0 / 只中横向 1 / 只中纵向 2 / 都没命中 3
    const tier = (inX ? 0 : 2) + (inY ? 0 : 1);
    // 纵向判据沿用原来的「行首附近算命中」：组的矩形高，直接用中点会让下半组判错
    const mid = r.top + Math.min(34, r.height / 2);
    const d = Math.abs(y - mid);
    if (tier < bestTier || (tier === bestTier && d < bestD)) { bestTier = tier; bestD = d; best = i; }
  }
  return best;
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
  let drag = null; // 卡片拖拽：{ id, el, startX, startY, moved, ghost, raf }
  let gDrag = null; // 分组拖拽：{ id, el, startX, startY, moved, ghost, raf, atKey, atGroupId, h }

  function removeInsertSlot() {
    groupsEl.querySelector(".qa-ph")?.remove();
  }

  function clearDragVisual() {
    groupsEl.querySelectorAll(".qa-card").forEach((r) => r.classList.remove("dragging"));
    removeInsertSlot();
    document.body.classList.remove("no-select");
    if (drag) {
      if (drag.ghost) drag.ghost.remove();
      if (drag.raf) cancelAnimationFrame(drag.raf);
      drag.ghost = null;
      drag.raf = 0;
    }
  }

  // 按指针位置计算插入点：先定位到「哪个组」（pickGroupRow，三列并排时靠横向区分），
  // 再在该组卡片流中按“整卡在上/同行左右半区”定位列。
  // 返回 { groupId, atId }（atId 为将被推到占位槽之后的那张卡，null 表示组尾）。
  function targetAt(x, y) {
    const rowList = Array.from(groupsEl.querySelectorAll(".qa-row"));
    const gi = pickGroupRow(rowList.map((r) => r.getBoundingClientRect()), x, y);
    if (gi < 0) return null;
    const rowBest = rowList[gi];
    const cards = Array.from(rowBest.children).filter((el) => el.classList.contains("qa-card"));
    let idx = cards.length;
    for (let i = 0; i < cards.length; i++) {
      const rc = cards[i].getBoundingClientRect();
      if (rc.bottom <= y) continue;          // 完全位于指针上方：插到其后
      if (rc.top > y) { idx = i; break; }    // 已到指针下方的卡：插到其前
      if (rc.left + rc.width / 2 < x) continue; // 同行且在中心右侧
      idx = i;
      break;
    }
    const atId = cards[idx] ? cards[idx].dataset.id : null;
    return { groupId: rowBest.dataset.group, atId, idx, row: rowBest };
  }

  // 在目标位置插入占位槽，让周围卡片实时让位；仅在落点变化时调用。
  let lastTargetKey = null;
  function placeInsertSlot(t) {
    const key = t ? `${t.groupId}:${t.atId ?? "├─end"}` : "";
    if (lastTargetKey === key) return;
    lastTargetKey = key;
    removeInsertSlot();
    if (!t) return;
    const slot = document.createElement("div");
    slot.className = "qa-ph";
    t.row.insertBefore(slot, t.row.children[t.idx] ?? null);
  }

  function finishDrag() {
    const fromId = drag?.id;
    const moved = drag?.moved;
    const t = drag?.target;
    clearDragVisual();
    drag = null;
    lastTargetKey = null;
    if (moved && fromId && t && !(t.groupId && t.atId === fromId)) {
      suppressClick = true;
      // 拖拽释放通常不派发 click，短暂复位避免吞掉下一次真实的快捷方式点击
      setTimeout(() => { suppressClick = false; }, 300);
      QuickAccess.move(fromId, t.groupId, t.atId);
      render();
    }
  }

  // ---------------- 分组拖拽排序 ----------------
  // 用「整组大小的占位槽」让其余分组实时让位：.qa-groups 是栅格，槽位一进来后面的组就自动重排，
  // 不需要自己算行列。槽高取被拖组的实测高度，避免让位时后面几行上下跳。
  function removeGroupSlot() {
    groupsEl.querySelector(".qa-gslot")?.remove();
  }

  function clearGroupDragVisual() {
    removeGroupSlot();
    // 恢复被摘出文档流的那一组（拖动中被 display:none 隐藏，由占位槽接替）
    groupsEl.querySelectorAll(".qa-group").forEach((g) => { g.style.display = ""; });
    document.body.classList.remove("no-select");
    if (gDrag) {
      if (gDrag.ghost) gDrag.ghost.remove();
      if (gDrag.raf) cancelAnimationFrame(gDrag.raf);
      gDrag.ghost = null;
      gDrag.raf = 0;
    }
  }

  function placeGroupSlot(atEl, height) {
    const slot = document.createElement("div");
    slot.className = "qa-gslot";
    slot.style.height = height + "px";
    groupsEl.insertBefore(slot, atEl || null);   // atEl 为 null → 追加到末尾
  }

  function finishGroupDrag() {
    const fromId = gDrag?.id;
    const moved = gDrag?.moved;
    const atGroupId = gDrag?.atGroupId ?? null;
    clearGroupDragVisual();
    gDrag = null;
    if (moved && fromId) {
      suppressClick = true;
      setTimeout(() => { suppressClick = false; }, 300);
      QuickAccess.moveGroup(fromId, atGroupId);
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
          <div class="qa-group-head" title="按住拖动可给分组排序"><span class="qa-grip">${ICON_GRIP}</span>${esc(g.name || "")}<span class="qa-count">${items.length}</span></div>
          <div class="qa-row" data-group="${g.id}">${items.map(qaCardHtml).join("") || `<div class="dash-empty">该分组暂无内容，点右上角「添加」加入</div>`}</div>
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

    // 分组拖拽只从**标题栏**发起：整组可拖会和卡片拖抢同一个手势，
    // 而标题栏里没有卡片、也没有按钮，是唯一不冲突的抓手。
    // 指针捕获挂在**容器**上而不是标题栏：被拖的组随后会被 display:none 摘出文档流，
    // 捕获目标一旦不再渲染，浏览器就会释放捕获，拖动会在中途失效。
    groupsEl.querySelectorAll(".qa-group-head").forEach((head) => {
      head.addEventListener("pointerdown", (e) => {
        if (e.button !== 0 || e.target.closest("button")) return;
        const grp = head.closest(".qa-group");
        if (!grp) return;
        gDrag = { id: grp.dataset.gid, el: grp, startX: e.clientX, startY: e.clientY, moved: false, ghost: null, raf: 0, atKey: undefined, atGroupId: null };
        try { groupsEl.setPointerCapture(e.pointerId); } catch (_) {}
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
    placeInsertSlot(t);
  });

  // 分组拖拽：幽灵 = 整组克隆（含卡片），占位槽 = 整组大小。
  // 落点算出来的是「DOM 里的第几个组」，再换成**组 id** 交给模型 ——
  // 被拖的那一组此时仍在 DOM 里（只降透明度），用下标会整体错位一格。
  window.addEventListener("pointermove", (e) => {
    if (!gDrag) return;
    const dx = e.clientX - gDrag.startX;
    const dy = e.clientY - gDrag.startY;
    if (!gDrag.moved && Math.abs(dx) < 6 && Math.abs(dy) < 6) return;

    if (!gDrag.moved) {
      gDrag.moved = true;
      const rect = gDrag.el.getBoundingClientRect();
      gDrag.h = rect.height;
      document.body.classList.add("no-select");
      // ① 先克隆幽灵（必须在隐藏之前，否则克隆出来也是 display:none）
      const ghost = gDrag.el.cloneNode(true);
      ghost.classList.add("qa-ghost");
      ghost.removeAttribute("data-gid");
      ghost.style.left = rect.left + "px";
      ghost.style.top = rect.top + "px";
      ghost.style.width = rect.width + "px";
      document.body.appendChild(ghost);
      gDrag.ghost = ghost;
      // ② 再把原元素**摘出文档流**，由占位槽接替它的位置。
      //    若只降透明度、让它继续占一格，栅格会多出一格 → 拖动中容器忽高忽低（用户实测到的就是这个）。
      gDrag.el.style.display = "none";
    }
    if (!gDrag.raf) {
      gDrag.raf = requestAnimationFrame(() => {
        gDrag.raf = 0;
        if (gDrag?.ghost) gDrag.ghost.style.transform = `translate(${dx}px, ${dy}px)`;
      });
    }

    // 候选里**排除被拖的组**（它已不在文档流里、矩形是 0×0），索引只对应剩下的组
    const groups = Array.from(groupsEl.querySelectorAll(".qa-group")).filter((g) => g !== gDrag.el);
    const at = pickGroupDrop(groups.map((g) => g.getBoundingClientRect()), e.clientX, e.clientY, -1);
    const atEl = groups[at] || null;
    const key = atEl ? atEl.dataset.gid : "├─end";
    if (key !== gDrag.atKey) {          // 落点没变就别重建槽位（每帧重建会抖）
      gDrag.atKey = key;
      gDrag.atGroupId = atEl ? atEl.dataset.gid : null;
      removeGroupSlot();
      placeGroupSlot(atEl, gDrag.h);
    }
  });

  window.addEventListener("pointerup", () => {
    if (!gDrag) return;
    if (!gDrag.moved) { clearGroupDragVisual(); gDrag = null; return; }
    finishGroupDrag();
  });
  window.addEventListener("pointercancel", () => {
    if (gDrag) { clearGroupDragVisual(); gDrag = null; }
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
  view.onDestroy(() => {
    hideQuickAccessModal();
    // 视图切走时若正拖着，幽灵卡片挂在 document.body 上、不随视图 DOM 一起消失 —— 主动清掉
    clearDragVisual();
    clearGroupDragVisual();
    drag = null;
    gDrag = null;
  });

  render();
}

// 添加/编辑 弹窗：类型 / 名称 / 地址（可浏览） / 分组
let qaModalEl = null;
let qaModalDrag = null;   // 管理分组弹窗内的拖动状态（幽灵挂在 body 上，关弹窗时必须清）
function hideQuickAccessModal() {
  if (qaModalEl) {
    qaModalDrag?.cleanup();
    qaModalDrag = null;
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
          <input id="qa-target" type="text" value="${item ? esc(item.target) : ""}" placeholder="${isEdit ? "网页链接或本地路径" : "链接或本地路径…"}" />
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
    if (isEdit) { QuickAccess.update(item.id, data); hideQuickAccessModal(); onDone?.(); return; }
    const added = QuickAccess.add(data);
    hideQuickAccessModal();
    onDone?.();
    // 网址快捷方式：异步获取站点图标（失败时保留默认地球图标）
    if (added && data.type === "url") {
      invoke("fetch_favicon", { url: data.target })
        .then((icon) => { if (icon) { QuickAccess.update(added.id, { icon }); onDone?.(); } })
        .catch(() => {});
    }
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

/// 管理分组弹窗里的一行。抽成函数是为了「只刷列表、不重建弹窗」——
/// `.task-modal-overlay` 带 `animation: viewIn 120ms ease both`，一旦重建 overlay，
/// 这段入场动画就会**重播一遍**（用户看到的就是「拖动之后弹窗闪一下」）。
function qaGroupRowHtml(g) {
  const n = QuickAccess.list().filter((q) => q.groupId === g.id).length;
  return `
            <div class="qa-gitem" data-gid="${g.id}">
              <span class="qa-gname"><span class="qa-grip">${ICON_GRIP}</span>${esc(g.name)}<span class="qa-count">${n}</span></span>
              <span class="qa-actions">
                <button class="qa-act" data-act="rename" title="重命名">${ICON_EDIT}</button>
                <button class="qa-act danger" data-act="delete" title="删除分组">${ICON_TRASH}</button>
              </span>
            </div>`;
}

// 分组管理弹窗：新增 / 重命名 / 删除
function showQuickAccessGroupsModal(onDone) {
  hideQuickAccessModal();
  qaModalEl = document.createElement("div");
  qaModalEl.className = "task-modal-overlay";
  qaModalEl.innerHTML = `
    <div class="task-modal">
      <h3>管理分组</h3>
      <div class="tm-field"><label>新增分组</label>
        <div class="tm-row" style="grid-template-columns: 1fr auto;">
          <input id="qa-g-new" type="text" placeholder="分组名称…" />
          <button class="btn-primary" id="qa-g-add" type="button">添加</button>
        </div>
      </div>
      <div class="tm-field"><label>已有分组（按住可拖动排序）</label>
        <div class="qa-glist" id="qa-glist">
          ${QuickAccess.listGroups().map(qaGroupRowHtml).join("")}
        </div>
      </div>
      <div class="tm-actions"><button class="tm-cancel">关闭</button></div>
    </div>`;
  document.body.appendChild(qaModalEl);

  // ---------------- 弹窗内的分组拖动排序（纵向一维列表） ----------------
  // 监听器挂在 qaModalEl 上而不是 window：弹窗一移除，监听器随之消失，不必手动解绑。
  // pointerdown 用**事件委托**（行是每次重绘出来的）；拖动中开了 setPointerCapture，
  // 指针移出弹窗范围事件仍会回到被捕获的元素 → 冒泡到 qaModalEl，所以不会丢。
  //
  // ⚠ 指针捕获挂在 **qaModalEl**（而不是被拖的那一行）：拖动中会把该行 display:none 摘出文档流，
  //   捕获目标一旦不再渲染浏览器就释放捕获，拖动会中途断掉。
  const glist = qaModalEl.querySelector("#qa-glist");
  const rowsNow = () => Array.from(glist.querySelectorAll(".qa-gitem"));
  // 只换列表的 innerHTML、**不重建弹窗**：overlay 一旦重新 createElement + appendChild，
  // 它身上的 `animation: viewIn 120ms` 就会重播（= 用户看到的「闪一下」）。容器元素不动，
  // 挂在 #qa-glist 上的事件委托也一并保住。
  const renderRows = () => { glist.innerHTML = QuickAccess.listGroups().map(qaGroupRowHtml).join(""); };
  let drag = null;   // { id, el, startX, startY, moved, ghost, raf, h, atKey, atGroupId }

  function clearDragVisual() {
    glist.querySelector(".qa-iph")?.remove();
    // 恢复被摘出文档流的那一行（拖动中被 display:none 隐藏，由占位槽接替）
    rowsNow().forEach((r) => { r.style.display = ""; });
    document.body.classList.remove("no-select");
    if (drag?.ghost) drag.ghost.remove();
    if (drag?.raf) cancelAnimationFrame(drag.raf);
  }
  function endDrag() { clearDragVisual(); drag = null; }
  qaModalDrag = { cleanup: () => { clearDragVisual(); drag = null; } };   // 关弹窗时清掉挂在 body 上的幽灵

  glist.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || e.target.closest(".qa-act")) return;   // 重命名/删除按钮不触发拖动
    const row = e.target.closest(".qa-gitem");
    if (!row) return;
    drag = { id: row.dataset.gid, el: row, startX: e.clientX, startY: e.clientY, moved: false, ghost: null, raf: 0, atKey: undefined, atGroupId: null };
    try { qaModalEl.setPointerCapture(e.pointerId); } catch (_) {}
  });

  qaModalEl.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (!drag.moved && Math.abs(dx) < 6 && Math.abs(dy) < 6) return;

    if (!drag.moved) {
      drag.moved = true;
      const r = drag.el.getBoundingClientRect();
      drag.h = r.height;
      document.body.classList.add("no-select");
      // ① 先克隆幽灵（必须在隐藏之前）
      const ghost = drag.el.cloneNode(true);
      ghost.classList.add("qa-ighost");
      ghost.removeAttribute("data-gid");
      ghost.style.left = r.left + "px";
      ghost.style.top = r.top + "px";
      ghost.style.width = r.width + "px";
      document.body.appendChild(ghost);
      drag.ghost = ghost;
      // ② 再把原行摘出文档流，由占位槽接替它的位置 —— 否则列表会多出一行，
      //    .task-modal 是**内容撑高 + 垂直居中**的，于是每拖一下就变高并整体下移（用户实测到的就是这个）
      drag.el.style.display = "none";
    }
    if (!drag.raf) {
      drag.raf = requestAnimationFrame(() => {
        drag.raf = 0;
        if (drag?.ghost) drag.ghost.style.transform = `translate(0, ${dy}px)`;
      });
    }

    // 候选里排除被拖的那一行（已不在文档流、矩形是 0×0）
    const rows = rowsNow().filter((r) => r !== drag.el);
    const at = pickRowDrop(rows.map((r) => r.getBoundingClientRect()), e.clientY, -1);
    const atEl = rows[at] || null;
    const key = atEl ? atEl.dataset.gid : "├─end";
    if (key !== drag.atKey) {          // 落点没变就不重建槽位（重建会改布局、进而改落点 → 振荡）
      drag.atKey = key;
      drag.atGroupId = atEl ? atEl.dataset.gid : null;
      glist.querySelector(".qa-iph")?.remove();
      const slot = document.createElement("div");
      slot.className = "qa-iph";
      slot.style.height = drag.h + "px";
      glist.insertBefore(slot, atEl || null);
    }
  });

  qaModalEl.addEventListener("pointerup", () => {
    if (!drag) return;
    const fromId = drag.id;
    const moved = drag.moved;
    const atGroupId = drag.atGroupId ?? null;
    endDrag();
    if (!moved) return;
    QuickAccess.moveGroup(fromId, atGroupId);
    // ⛔ 这里**绝不**调 showQuickAccessGroupsModal()：它先 hide 再 createElement + appendChild，
    //    overlay 成了新节点 ⇒ `animation: viewIn 120ms` 从头播一遍，就是那下「闪」。
    //    改为只重排列表内容 —— 零重建、零入场动画，其余行原地不动。
    renderRows();
    onDone?.();                            // 背后的快捷访问视图同步刷新
  });
  qaModalEl.addEventListener("pointercancel", () => { if (drag) endDrag(); });

  const addBtn = qaModalEl.querySelector("#qa-g-add");
  const newInput = qaModalEl.querySelector("#qa-g-new");
  const addGroup = () => {
    const name = newInput.value.trim();
    if (!name) return;
    QuickAccess.addGroup(name);
    newInput.value = "";   // 局部刷新不会像整表重建那样顺手清空输入框，这里显式清
    renderRows();
    onDone?.();
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
      renderRows();                        // 同样是局部刷新（不重建弹窗）
    } else if (btn.dataset.act === "delete") {
      const ok = await showDialog({ title: "删除分组", message: `删除「${g.name}」？其内快捷方式将并入「默认」分组。`, okText: "删除", danger: true });
      if (!ok) return;
      QuickAccess.removeGroup(gid);
      onDone?.();
      if (QuickAccess.listGroups().length) renderRows();   // 还剩分组 → 局部刷新
      else hideQuickAccessModal();                         // 一个不剩 → 关掉弹窗
    }
  });

  qaModalEl.querySelector(".tm-cancel").addEventListener("click", hideQuickAccessModal);
  qaModalEl.addEventListener("keydown", (e) => { if (e.key === "Escape") hideQuickAccessModal(); });
}