// 灵感碎片视图（随手记入口 + 卡片墙瀑布流）
// 数据模型沿用 state.ideabox: { id, text, tag, ts }（按记录时间倒序呈现）
// 自定义标签存于 state.ideaTags，统一用青色系。
import { state, saveState } from "../state.js";
import { esc, showDialog, insertBreak, fitTextarea } from "./common.js";

// 随手记输入区最大自适应高度（超出后内部滚动）
const INPUT_MAX_H = 200;

// 内置标签（配色见下方 TAG_COLOR / TAG_TEXT，CSS 中 .idea-tag.id-* 同源）
const BUILTIN_TAGS = ["灵感", "想法", "待办", "阅读", "生活", "其他"];
const TAG_CLASS = { 灵感: "idea", 想法: "think", 待办: "todo", 阅读: "read", 生活: "life", 其他: "other" };

// 标签主色（圆点 / 激活描边）与胶囊亮色文字
const TAG_COLOR = { idea: "#d29922", think: "#bc8cff", todo: "#58a6ff", read: "#3fb950", life: "#e6b45f", other: "#9aa7b4", custom: "#4fd1c5" };
const TAG_TEXT = { idea: "#e0b254", think: "#d2a8ff", todo: "#7cbdf9", read: "#63d47f", life: "#f0c77e", other: "#b6c2cf", custom: "#4fd1c5" };

function allTags() {
  return [...BUILTIN_TAGS, ...(state.ideaTags || [])];
}
// 标签 key：内置专属，自定义归 custom
function tagKey(tag) {
  return TAG_CLASS[tag] || "custom";
}
function tagColor(tag) {
  return TAG_COLOR[tagKey(tag)];
}
function tagText(tag) {
  return TAG_TEXT[tagKey(tag)];
}
// #hex → rgba(hex, alpha)
function rgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

// 各标签条数（新卡片标签选择与筛选计数共用）
function tagCounts() {
  const c = {};
  for (const it of state.ideabox || []) {
    const t = it.tag || "想法";
    c[t] = (c[t] || 0) + 1;
  }
  return c;
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

// 标签胶囊选择器（随手记卡 / 编辑弹窗共用）：
// 内置 + 自定义 + 新增入口；未使用的自定义标签可悬停 × 删除
// onTagsMutated: 自定义标签集合变化（新增/删除）后的回调
function tagPicker(container, current, onChange, onTagsMutated) {
  const usedTags = new Set((state.ideabox || []).map((it) => it.tag));
  container.innerHTML = allTags().map((t) => {
    const isCustom = (state.ideaTags || []).includes(t);
    const deletable = isCustom && !usedTags.has(t);
    const on = t === current;
    const c = tagColor(t);
    const s = on
      ? ` style="color:${tagText(t)};background:${rgba(c, 0.18)};border-color:${rgba(c, 0.42)};font-weight:500"`
      : "";
    return `
      <span class="idea-form-chip">
        <button class="idea-tag-opt${on ? " active" : ""}" data-tag="${esc(t)}"${s}>${esc(t)}</button>
        ${deletable ? `<button class="idea-form-del" data-del="${esc(t)}" title="删除该标签">×</button>` : ""}
      </span>`;
  }).join("")
    + `<button class="idea-tag-opt idea-tag-add" data-add="1" title="新增标签">＋ 新增标签</button>`;

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
      const fallback = current === t ? "想法" : current;
      saveState();
      onChange(fallback);
      tagPicker(container, fallback, onChange, onTagsMutated);
      onTagsMutated?.();
    });
  });
  container.querySelector("[data-add]")?.addEventListener("click", async () => {
    const t = await promptAddTag();
    if (t) {
      onChange(t);
      tagPicker(container, t, onChange, onTagsMutated);
      onTagsMutated?.();
    }
  });
}

export function renderIdeabox(view) {
  view.header.style.display = "none";
  const body = view.body;
  body.innerHTML = `
    <div class="idea-page">
      <section class="idea-composer">
        <textarea class="idea-input" id="idea-input" rows="1" placeholder="随手记下来：一句话灵感 / 待办 / 摘录，回车记录 · Ctrl+Enter 换行…" spellcheck="false"></textarea>
        <div class="idea-composer-foot">
          <div class="idea-form-tags" id="idea-form-tags"></div>
          <button class="btn-primary idea-add" id="idea-add">＋ 记录</button>
        </div>
      </section>
      <div class="idea-filter-row">
        <div class="idea-filters" id="idea-filters"></div>
        <div class="idea-search">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15.5 14h-.79l-.28-.27a6.5 6.5 0 1 0-.7.7l.27.28v.79l5 4.99L20.49 19zm-6 0A4.5 4.5 0 1 1 14 9.5 4.5 4.5 0 0 1 9.5 14"/></svg>
          <input id="idea-q" type="text" placeholder="搜索…" autocomplete="off" spellcheck="false" />
        </div>
      </div>
      <div class="idea-wall" id="idea-wall"></div>
    </div>`;

  const pageEl = body.querySelector(".idea-page");
  const inputEl = body.querySelector("#idea-input");
  const addBtn = body.querySelector("#idea-add");
  const qEl = body.querySelector("#idea-q");
  const wallEl = body.querySelector("#idea-wall");
  const filtersEl = body.querySelector("#idea-filters");
  const formTagsEl = body.querySelector("#idea-form-tags");

  let newTag = "想法"; // 随手记默认标签
  let currentFilter = "全部"; // 筛选：全部 或 具体标签
  let query = ""; // 搜索关键字

  // 标签集合变化（新增/删除）后：若当前筛选项已被删除则回「全部」，再整体重绘
  function refreshAfterTagChange() {
    if (currentFilter !== "全部" && !allTags().includes(currentFilter)) currentFilter = "全部";
    renderAll();
  }

  // ---------- 筛选胶囊行（彩色圆点 + 计数，激活描边随标签色） ----------
  function paintFilters() {
    const counts = tagCounts();
    const total = (state.ideabox || []).length;
    const chips = [{ t: "全部", n: total }]
      .concat(allTags().map((t) => ({ t, n: counts[t] || 0 })));
    filtersEl.innerHTML = chips.map(({ t, n }) => {
      const on = currentFilter === t;
      const c = t === "全部" ? "#58a6ff" : tagColor(t);
      return `
        <button class="fchip${on ? " active" : ""}" data-f="${esc(t)}"
          ${on ? `style="color:${t === "全部" ? "#e6edf3" : tagText(t)};background:${rgba(c, 0.14)};border-color:${rgba(c, 0.32)}"` : ""}>
          <span class="fdot" style="background:${c}"></span>
          <span>${esc(t)}</span>
          <span class="fc">${n}</span>
        </button>`;
    }).join("");
    filtersEl.querySelectorAll("[data-f]").forEach((btn) => {
      btn.addEventListener("click", () => {
        currentFilter = btn.dataset.f;
        renderAll();
      });
    });
  }

  // ---------- 卡片 ----------
  function cardHTML(it) {
    const k = tagKey(it.tag);
    const t = it.tag || "想法";
    return `
      <div class="idea-card" data-id="${esc(it.id)}">
        <div class="idea-card-top">
          <span class="idea-tag id-${k}" style="color:${tagText(t)};background:${rgba(tagColor(t), 0.16)}">${esc(t)}</span>
          <span class="idea-time">${fmtTime(it.ts)}</span>
        </div>
        <div class="idea-text">${esc(it.text)}</div>
        <div class="idea-acts">
          <button class="idea-edit" data-id="${esc(it.id)}" title="编辑">✎</button>
          <button class="idea-del" data-id="${esc(it.id)}" title="删除">✕</button>
        </div>
      </div>`;
  }

  // ---------- 卡片墙瀑布流（最短列填充） ----------
  function paintWall() {
    const all = state.ideabox || [];
    const kw = query.trim().toLowerCase();
    const list = all
      .filter((it) => currentFilter === "全部" || (it.tag || "想法") === currentFilter)
      .filter((it) => !kw || it.text.toLowerCase().includes(kw) || (it.tag || "").toLowerCase().includes(kw))
      .slice()
      .sort((a, b) => (b.ts || 0) - (a.ts || 0)); // 最新在前

    if (!list.length) {
      const base = (state.ideabox || []).length;
      wallEl.innerHTML = `<div class="idea-empty">${kw ? "没有匹配的碎片" : base ? "该标签下还没有碎片" : "还没有灵感碎片，先在随手记里记录一条吧"}</div>`;
      wallEl.style.display = "block";
      return;
    }

    const w = wallEl.clientWidth || (pageEl.clientWidth || 720);
    const GAP = 16;
    const COL_MIN = 300;
    const cols = Math.max(1, Math.min(6, Math.floor((w + GAP) / (COL_MIN + GAP))));
    const colW = (w - GAP * (cols - 1)) / cols;

    // 估算卡片高度：正文按列宽折行；胶囊行 + 留白 ~58px
    function estimate(it) {
      const perLine = Math.max(1, Math.floor((colW - 28) / 13.5));
      const nls = (it.text.match(/\n/g) || []).length;
      let lines = Math.max(1, Math.ceil(it.text.length / perLine)) + nls;
      return lines * 21 + 62;
    }

    const colArr = Array.from({ length: cols }, () => []);
    const colH = new Array(cols).fill(0);
    for (const it of list) {
      let bi = 0;
      for (let i = 1; i < cols; i++) if (colH[i] < colH[bi]) bi = i;
      colArr[bi].push(it);
      colH[bi] += estimate(it) + GAP;
    }
    wallEl.style.display = "flex";
    wallEl.innerHTML = colArr.map((col) => `<div class="idea-col">${col.map(cardHTML).join("")}</div>`).join("");

    wallEl.querySelectorAll(".idea-edit").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const it = (state.ideabox || []).find((x) => x.id === btn.dataset.id);
        if (it) editCard(it);
      });
    });
    wallEl.querySelectorAll(".idea-del").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        state.ideabox = (state.ideabox || []).filter((it) => it.id !== btn.dataset.id);
        saveState();
        renderAll();
      });
    });
  }

  // 整页重绘：页头计数 + 筛选胶囊 + 卡片墙 + 标签选择器（刷新自定义标签的删除角标显隐）
  function renderAll() {
    paintFilters();
    paintWall();
    rebuildFormTags();
  }

  // 重建随手记标签选择器（保持选中 = newTag；未使用自定义标签显示删除角标）
  function rebuildFormTags() {
    tagPicker(formTagsEl, newTag, (t) => { newTag = t; }, refreshAfterTagChange);
  }

  // ---------- 新增 ----------
  function add() {
    const text = inputEl.value.trim();
    if (!text) { inputEl.focus(); return; }
    if (!Array.isArray(state.ideabox)) state.ideabox = [];
    state.ideabox.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), text, tag: newTag, ts: Date.now() });
    saveState();
    inputEl.value = "";
    fitTextarea(inputEl, INPUT_MAX_H); // 清空后高度回落
    inputEl.focus();
    // 若当前标签筛选与新增标签不同，切到「全部」让新卡可见
    if (currentFilter !== "全部" && currentFilter !== newTag) currentFilter = "全部";
    renderAll();
  }

  addBtn.addEventListener("click", add);
  // 回车 = 记录；Ctrl/Cmd+回车 = 换行；Shift+回车保留默认换行（与工作记录录入一致）
  inputEl.addEventListener("keydown", (e) => {
    if (e.isComposing || e.key !== "Enter") return;
    if (e.ctrlKey || e.metaKey) { e.preventDefault(); insertBreak(inputEl); fitTextarea(inputEl, INPUT_MAX_H); }
    else if (!e.shiftKey) { e.preventDefault(); add(); }
  });
  inputEl.addEventListener("input", () => fitTextarea(inputEl, INPUT_MAX_H));

  // 搜索：输入后轻量重绘卡片墙
  let qTimer = 0;
  qEl.addEventListener("input", () => {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => { query = qEl.value; paintWall(); }, 120);
  });

  // ---------- 编辑弹窗 ----------
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
    tagPicker(ov.querySelector("#ie-tags"), tag, (t) => { tag = t; }, refreshAfterTagChange);
    textEl.focus(); textEl.setSelectionRange(textEl.value.length, textEl.value.length);

    const close = () => ov.remove();
    ov.querySelector(".tm-cancel").addEventListener("click", close);
    ov.querySelector(".cm-ok").addEventListener("click", () => {
      const text = textEl.value.trim();
      if (text) {
        it.text = text;
        it.tag = tag;
        saveState();
        renderAll();
      }
      close();
    });
    ov.addEventListener("keydown", (e) => {
      if (e.key === "Escape") close();
      else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) ov.querySelector(".cm-ok").click();
    });
  }

  // 初始化 + 容器布局稳定后再算列数，并响应窗口尺寸变化
  let rsTimer = 0;
  const onResize = () => { clearTimeout(rsTimer); rsTimer = setTimeout(paintWall, 120); };
  window.addEventListener("resize", onResize);

  renderAll();
  requestAnimationFrame(paintWall);
  view.onDestroy(() => {
    clearTimeout(rsTimer);
    clearTimeout(qTimer);
    window.removeEventListener("resize", onResize);
  });
}
