// 灵感碎片视图：随手捕捉灵感卡片，支持分类标签、编辑 / 删除、按标签筛选、自定义标签。
import { state, saveState } from "../state.js";
import { esc, showDialog } from "./common.js";

// 内置标签（配色见 style.css .idea-tag.id-*）
const BUILTIN_TAGS = ["灵感", "想法", "待办", "阅读", "生活", "其他"];
const TAG_CLASS = { 灵感: "idea", 想法: "think", 待办: "todo", 阅读: "read", 生活: "life", 其他: "other" };

// 全部标签 = 内置 + 自定义
function allTags() {
  return [...BUILTIN_TAGS, ...(state.ideaTags || [])];
}
// 标签配色：内置用专属色，自定义用青色
function tagClass(tag) {
  return TAG_CLASS[tag] || "custom";
}
// 新增自定义标签
async function promptAddTag() {
  const input = await showDialog({ title: "新增标签", okText: "添加", cancelText: "取消", showCancel: true, input: true, inputValue: "" });
  const t = (input || "").trim();
  if (!t) return null;
  if (allTags().includes(t)) return null;
  if (!Array.isArray(state.ideaTags)) state.ideaTags = [];
  state.ideaTags.push(t);
  saveState();
  return t;
}
// 标签选择器：内置 + 自定义 + 新增入口；未使用的自定义标签可删除
function tagPicker(container, current, onChange) {
  const usedTags = new Set((state.ideabox || []).map((it) => it.tag));
  container.innerHTML = allTags().map((t) => {
    const isCustom = (state.ideaTags || []).includes(t);
    const deletable = isCustom && !usedTags.has(t);
    return `
      <span class="filter-chip">
        <button class="idea-tag-opt${t === current ? " active" : ""}" data-tag="${esc(t)}">${esc(t)}</button>
        ${deletable ? `<button class="filter-chip-del" data-del="${esc(t)}" title="删除该标签">×</button>` : ""}
      </span>`;
  }).join("")
    + `<button class="idea-tag-opt idea-tag-add" data-add="1" title="新增标签">＋ 新增</button>`;

  container.querySelectorAll("[data-tag]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const t = btn.dataset.tag;
      onChange(t);
      tagPicker(container, t, onChange);
    });
  });
  container.querySelectorAll("[data-del]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const t = btn.dataset.del;
      const ok = await showDialog({ title: "删除标签", message: `删除自定义标签「${t}」？`, okText: "删除", danger: true, cancelText: "取消" });
      if (!ok) return;
      state.ideaTags = (state.ideaTags || []).filter((x) => x !== t);
      const fallback = current === t ? "想法" : current; // 删除当前选中标签时回到默认
      saveState();
      onChange(fallback);
      tagPicker(container, fallback, onChange);
    });
  });
  container.querySelector("[data-add]")?.addEventListener("click", async () => {
    const t = await promptAddTag();
    if (t) {
      onChange(t);
      tagPicker(container, t, onChange);
    }
  });
}

export function renderIdeabox(view) {
  view.header.style.display = "none";
  const body = view.body;
  body.innerHTML = `
    <div class="idea-composer">
      <input class="idea-input" id="idea-input" type="text" placeholder="记一条灵感，Ctrl+Enter 提交…" autocomplete="off" spellcheck="false" />
      <div class="idea-composer-foot">
        <div class="idea-form-tags" id="idea-form-tags"></div>
        <button class="btn-primary idea-add" id="idea-add">添加灵感</button>
      </div>
    </div>
    <div class="idea-filters" id="idea-filters"></div>
    <div class="idea-grid" id="idea-grid"></div>`;
  const inputEl = body.querySelector("#idea-input");
  const addBtn = body.querySelector("#idea-add");
  const gridEl = body.querySelector("#idea-grid");
  const filtersEl = body.querySelector("#idea-filters");
  const formTagsEl = body.querySelector("#idea-form-tags");
  let newTag = "想法";
  let currentFilter = "全部"; // 筛选：全部 或 具体标签
  tagPicker(formTagsEl, newTag, (t) => { newTag = t; });

  // JS 瀑布流参数：列宽 / 间距，估算卡片高度用于分列放缩
  const COL_W = 220, GAP = 12;
  function cardHTML(it) {
    const tc = tagClass(it.tag);
    return `
      <div class="idea-card" data-id="${esc(it.id)}">
        <div class="idea-text">${esc(it.text)}</div>
        <div class="idea-meta">
          <span class="idea-meta-left">
            <span class="idea-tag id-${tc}">${esc(it.tag || "想法")}</span>
            <span class="idea-time">${fmtTime(it.ts)}</span>
          </span>
          <div class="idea-actions">
            <button class="idea-edit" data-id="${esc(it.id)}" title="编辑">✎</button>
            <button class="idea-del" data-id="${esc(it.id)}" title="删除">✕</button>
          </div>
        </div>
      </div>`;
  }
  // 估算卡片高度（用于选择最短列，避免整行留白）
  function estimate(it) {
    const perLine = Math.max(1, Math.floor((COL_W - 32) / 14));
    let lines = Math.max(1, Math.ceil(it.text.length / perLine));
    lines += (it.text.match(/\n/g) || []).length;
    return lines * 21 + 72;
  }

  // 时间显示：今天 HH:MM；其他日期 M月D日 HH:MM（跨年加年份）
  function fmtTime(ts) {
    const d = new Date(ts);
    if (isNaN(d)) return "";
    const pad = (n) => String(n).padStart(2, "0");
    const hhmm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const now = new Date();
    const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
    if (sameDay) return `今天 ${hhmm}`;
    const sameYear = d.getFullYear() === now.getFullYear();
    return `${sameYear ? "" : `${d.getFullYear()}-`}${d.getMonth() + 1}月${d.getDate()}日 ${hhmm}`;
  }

  // 编辑弹窗：修改内容 + 分类标签（含自定义）
  function editCard(it) {
    const ov = document.createElement("div");
    ov.className = "task-modal-overlay";
    ov.innerHTML = `
      <div class="task-modal idea-edit-modal">
        <h3>编辑灵感</h3>
        <div class="tm-field"><textarea id="ie-text" rows="3">${esc(it.text)}</textarea></div>
        <div class="idea-modal-tags" id="ie-tags"></div>
        <div class="tm-actions">
          <button class="tm-cancel">取消</button>
          <button class="btn-primary cm-ok">保存</button>
        </div>
      </div>`;
    document.body.appendChild(ov);
    const textEl = ov.querySelector("#ie-text");
    let tag = allTags().includes(it.tag) ? it.tag : "想法";
    tagPicker(ov.querySelector("#ie-tags"), tag, (t) => { tag = t; });
    textEl.focus(); textEl.setSelectionRange(textEl.value.length, textEl.value.length);

    const close = () => ov.remove();
    ov.querySelector(".tm-cancel").addEventListener("click", close);
    ov.querySelector(".cm-ok").addEventListener("click", () => {
      const text = textEl.value.trim();
      if (text) {
        it.text = text;
        it.tag = tag;
        saveState();
        renderFilters();
        render();
      }
      close();
    });
    ov.addEventListener("keydown", (e) => {
      if (e.key === "Escape") close();
      else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) ov.querySelector(".cm-ok").click();
    });
  }

  // 标签筛选栏：全部 + 各标签（新增/删除都在添加灵感的标签选择器里）
  function renderFilters() {
    const tags = allTags();
    filtersEl.innerHTML = `<button class="file-tab${currentFilter === "全部" ? " active" : ""}" data-f="全部">全部</button>`
      + tags.map((t) => `<button class="file-tab${currentFilter === t ? " active" : ""}" data-f="${esc(t)}">${esc(t)}</button>`).join("");
    filtersEl.querySelectorAll("[data-f]").forEach((btn) => {
      btn.addEventListener("click", () => {
        currentFilter = btn.dataset.f;
        renderFilters();
        render();
      });
    });
  }

  function render() {
    // 按筛选过滤（保留添加顺序）
    const list = (state.ideabox || []).filter((it) => currentFilter === "全部" || it.tag === currentFilter);
    if (!list.length) {
      gridEl.innerHTML = `<div class="dash-empty">${state.ideabox?.length ? "该标签下暂无卡片" : "还没有灵感卡片，先在顶部记录一条吧"}</div>`;
      return;
    }
    // 按容器宽度计算列数
    const w = gridEl.clientWidth || (gridEl.parentElement?.clientWidth || 600);
    const cols = Math.max(1, Math.floor((w + GAP) / (COL_W + GAP)));
    // 依次放入当前最短列，保持排序（新增在后，向左向右填充）
    const colArr = Array.from({ length: cols }, () => []);
    const colH = new Array(cols).fill(0);
    for (const it of list) {
      let bi = 0;
      for (let i = 1; i < cols; i++) if (colH[i] < colH[bi]) bi = i;
      colArr[bi].push(it);
      colH[bi] += estimate(it) + GAP;
    }
    gridEl.innerHTML = colArr.map((col) => `<div class="idea-col">${col.map(cardHTML).join("")}</div>`).join("");

    gridEl.querySelectorAll(".idea-edit").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const it = (state.ideabox || []).find((x) => x.id === btn.dataset.id);
        if (it) editCard(it);
      });
    });
    gridEl.querySelectorAll(".idea-del").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        state.ideabox = (state.ideabox || []).filter((it) => it.id !== btn.dataset.id);
        saveState();
        render();
      });
    });
  }

  function add() {
    const text = inputEl.value.trim();
    if (!text) { inputEl.focus(); return; }
    if (!Array.isArray(state.ideabox)) state.ideabox = [];
    // 新增追加到末尾：新的出现在后面
    state.ideabox.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), text, tag: newTag, ts: Date.now() });
    saveState();
    inputEl.value = "";
    inputEl.focus();
    render();
  }

  addBtn.addEventListener("click", add);
  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) add();
  });

  renderFilters();
  // 等容器布局完成后渲染，并响应窗口尺寸变化
  let rsTimer = 0;
  const onResize = () => { clearTimeout(rsTimer); rsTimer = setTimeout(render, 120); };
  window.addEventListener("resize", onResize);
  requestAnimationFrame(render);
  view.onDestroy(() => {
    clearTimeout(rsTimer);
    window.removeEventListener("resize", onResize);
  });
}