// 笔记列表视图：左侧笔记列表 + 右侧编辑/阅读双态 Markdown 面板，支持导出为 .md。
// 交互：打开视图或切换笔记均显示编辑页但不自动聚焦；仅用户主动操作（点模式按钮、
// 双击正文）才进入输入；工具栏可切到 Markdown 阅读态；新建笔记直接聚焦标题。
import { state, saveState } from "../state.js";
import { invoke } from "../bus.js";
import { toast } from "../toast.js";

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// ─── marked.js 初始化 ───
let _markedReady = false;
function ensureMarked() {
  if (_markedReady) return true;
  if (typeof marked === "undefined") return false;
  marked.setOptions({ gfm: true, breaks: true, async: false });
  _markedReady = true;
  return true;
}

// ─── SVG 图标 ───
const SVG = {
  pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 3h6l-.5 5L17 10l-5 3-5-3 2.5-2L9 3Z"/></svg>',
  pinFill: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M9 4h6l-.5 4.5L17 12l-5 3-5-3 2.5-3.5L9 4Z"/><path d="M12 15v5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  del: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
  calendar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>',
  box: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><path d="M3.27 6.96 12 12l8.73-5.04"/><path d="M12 22V12"/></svg>',
  db: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="6" rx="9" ry="3"/><path d="M3 6v6c0 1.66 4.03 3 9 3s9-1.34 9-3V6"/><path d="M3 12v6c0 1.66 4.03 3 9 3s9-1.34 9-3v-6"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="M5 12h14"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>',
  doc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v5h5"/></svg>',
  eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>',
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
  // 导出：向下箭头落入托盘（下载 / 另存为语义）
  export: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v11"/><path d="m7.5 9.5 4.5 4.5 4.5-4.5"/><path d="M4 19.5h16"/></svg>',
};

// ─── 时间格式化 ───
function fmtTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const yesterday = new Date(now); yesterday.setDate(yesterday.getDate() - 1);
  const sameYesterday = d.toDateString() === yesterday.toDateString();
  const sameYear = d.getFullYear() === now.getFullYear();
  const pad = (n) => String(n).padStart(2, "0");
  if (sameDay) return `今天 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (sameYesterday) return `昨天 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (sameYear) return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// ─── 笔记分组 ───
function groupNotes(notes, query) {
  let list = notes.slice().sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return b.updatedAt - a.updatedAt;
  });
  if (query) {
    const q = query.toLowerCase();
    list = list.filter((n) =>
      n.title.toLowerCase().includes(q) ||
      n.content.toLowerCase().includes(q)
    );
  }
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const weekStart = todayStart - 6 * 86400000;
  return {
    pinned: list.filter((n) => n.pinned),
    today: list.filter((n) => !n.pinned && n.updatedAt >= todayStart),
    week: list.filter((n) => !n.pinned && n.updatedAt >= weekStart && n.updatedAt < todayStart),
    all: list.filter((n) => !n.pinned && n.updatedAt < weekStart),
  };
}

// ─── 从内容提取标题 ───
function extractTitle(content) {
  const firstLine = content.trim().split("\n").find((l) => l.trim());
  if (!firstLine) return "";
  const hm = firstLine.match(/^#{1,6}\s+(.*)$/);
  if (hm) return hm[1].trim().slice(0, 40);
  return firstLine.trim().slice(0, 40);
}

// ─── 生成预览文本 ───
function extractPreview(content) {
  const lines = content.trim().split("\n");
  for (const l of lines) {
    const t = l.trim();
    if (!t || t.startsWith("#") || t.startsWith("---")) continue;
    return t.replace(/[*_`~>\-]/g, "").trim().slice(0, 60);
  }
  return "";
}

// ─── 视图 ───
export function renderNotes(view) {
  view.header.style.display = "none";
  const body = view.body;

  let activeId = null;
  let searchQuery = "";
  let saveTimer = 0;
  let isPreviewMode = false; // 默认编辑页；切换笔记保持编辑页，但不自动聚焦
  let dirty = false; // 是否有未保存的编辑

  // ─── 构建 DOM ───
  body.innerHTML = `
    <div class="nt-wrap">
      <aside class="nt-sidebar">
        <div style="padding:8px 10px;display:flex;align-items:center;gap:8px;border-bottom:1px solid var(--border);">
          <div style="position:relative;display:flex;align-items:center;height:30px;flex:1 1 auto;background:var(--bg-input);border:1px solid var(--border);border-radius:6px;">
            <span style="position:absolute;left:8px;color:var(--text-faint);display:inline-flex;width:14px;height:14px;">${SVG.search}</span>
            <input id="nt-search" type="text" placeholder="搜索笔记…" style="flex:1;height:100%;background:transparent;border:0;outline:0;padding:0 8px 0 28px;color:var(--text);font-size:12px;font-family:var(--font);" />
          </div>
          <button id="nt-new" title="新建笔记" style="background:var(--green);color:#0c0c0d;width:30px;height:30px;border:0;border-radius:6px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;">${SVG.plus}</button>
        </div>
        <div class="nt-sidebar-scroll" id="nt-list"></div>
      </aside>
      <section class="nt-main">
        <div class="nt-toolbar">
          <input id="nt-title" class="nt-title-input" type="text" placeholder="笔记标题…" />
          <div class="spacer" style="flex:1 1 auto;"></div>
          <button id="nt-export" class="nt-tool" title="导出为 Markdown">${SVG.export}</button>
          <span class="nt-tool-sep"></span>
          <button id="nt-mode" class="nt-tool" title="预览">${SVG.eye}</button>
          <button id="nt-pin" class="nt-tool pin" title="置顶">${SVG.pin}</button>
          <button id="nt-del" class="nt-tool del" title="删除笔记">${SVG.del}</button>
        </div>
        <div class="nt-editor-wrap">
          <textarea id="nt-textarea" class="nt-editor-edit" spellcheck="false" placeholder="开始输入…（支持 Markdown）"></textarea>
          <div id="nt-preview" class="nt-editor-preview" hidden></div>
        </div>
        <div class="nt-status">
          <span id="nt-count">0 字</span>
          <span class="nt-sep"></span>
          <span id="nt-readtime">约 0 分钟</span>
          <div class="spacer"></div>
          <span class="nt-save-dot"></span>
          <span id="nt-saved">未编辑</span>
        </div>
      </section>
    </div>`;

  const elList = body.querySelector("#nt-list");
  const elSearch = body.querySelector("#nt-search");
  const elNew = body.querySelector("#nt-new");
  const elTitle = body.querySelector("#nt-title");
  const elPin = body.querySelector("#nt-pin");
  const elDel = body.querySelector("#nt-del");
  const elMode = body.querySelector("#nt-mode");
  const elExport = body.querySelector("#nt-export");
  const elTextarea = body.querySelector("#nt-textarea");
  const elPreview = body.querySelector("#nt-preview");
  const elCount = body.querySelector("#nt-count");
  const elReadtime = body.querySelector("#nt-readtime");
  const elSaved = body.querySelector("#nt-saved");

  // ─── 渲染笔记列表 ───
  function renderList() {
    const groups = groupNotes(state.notes || [], searchQuery);
    const sections = [
      { label: "置顶", icon: SVG.pin, items: groups.pinned },
      { label: "今天", icon: SVG.calendar, items: groups.today },
      { label: "本周", icon: SVG.box, items: groups.week },
      { label: "全部", icon: SVG.db, items: groups.all },
    ];

    elList.innerHTML = sections
      .filter((s) => s.items.length > 0)
      .map((s) => {
        const cards = s.items
          .map((n) => {
            const title = n.title || extractTitle(n.content) || "未命名";
            const preview = extractPreview(n.content);
            const isActive = n.id === activeId;
            const pinIcon = n.pinned ? SVG.pinFill : SVG.pin;
            const pinClass = n.pinned ? "nt-act pin pinned" : "nt-act pin";
            return `<div class="nt-card ${isActive ? "active" : ""}" data-id="${esc(n.id)}">
              <div class="nt-body">
                <div class="nt-title-row">
                  <div class="nt-title">${esc(title)}</div>
                  <div class="nt-time">${fmtTime(n.updatedAt)}</div>
                </div>
                ${preview ? `<div class="nt-preview">${esc(preview)}</div>` : ""}
              </div>
              <div class="nt-actions">
                <button class="${pinClass}" data-act="pin" data-id="${esc(n.id)}" title="${n.pinned ? "取消置顶" : "置顶"}">${pinIcon}</button>
                <button class="nt-act del" data-act="del" data-id="${esc(n.id)}" title="删除">${SVG.del}</button>
              </div>
            </div>`;
          })
          .join("");
        return `<div class="nt-group">
          <div class="nt-group-header">
            <span class="nt-grp-icon">${s.icon}</span>
            ${s.label}
            <span class="nt-grp-count">${s.items.length}</span>
          </div>
          ${cards}
        </div>`;
      })
      .join("");

    if (!elList.innerHTML.trim()) {
      elList.innerHTML = `<div style="text-align:center;padding:40px 16px;color:var(--text-faint);">
        <div style="margin-bottom:8px;display:inline-flex;">${SVG.doc}</div>
        <div style="font-size:13px;">${searchQuery ? "没有匹配的笔记" : "还没有笔记，点 + 新建一篇"}</div>
      </div>`;
    }

    elList.querySelectorAll(".nt-card").forEach((card) => {
      card.addEventListener("click", (e) => {
        if (e.target.closest("[data-act]")) return;
        selectNote(card.dataset.id);
      });
    });
    elList.querySelectorAll("[data-act]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const id = btn.dataset.id;
        if (btn.dataset.act === "pin") togglePin(id);
        else if (btn.dataset.act === "del") deleteNote(id);
      });
    });
  }

  // ─── 渲染预览（整篇 Markdown 一次性渲染） ───
  function renderPreview(content) {
    if (!activeId) {
      elPreview.innerHTML = `<p style="color:var(--text-faint);">还没有笔记，点 + 新建一篇</p>`;
      return;
    }
    if (!ensureMarked()) {
      elPreview.innerHTML = `<p style="color:var(--text-faint);">Markdown 库加载中…</p>`;
      return;
    }
    if (!content.trim()) {
      elPreview.innerHTML = `<p style="color:var(--text-faint);">这篇笔记还没有内容，点右上角编辑按钮开始写作</p>`;
      return;
    }
    elPreview.innerHTML = marked.parse(content);
  }

  // ─── 无笔记时的空态：保留编辑页，但禁用输入并给出引导 ───
  function renderEmptyState() {
    elTextarea.disabled = true;
    elTextarea.placeholder = "还没有笔记，点 + 新建一篇";
    elTitle.disabled = true;
    elTitle.placeholder = "—";
    elExport.disabled = true;
  }

  // ─── 有笔记时的正常态 ───
  function renderNoteState() {
    elTextarea.disabled = false;
    elTextarea.placeholder = "开始输入…（支持 Markdown）";
    elTitle.disabled = false;
    elTitle.placeholder = "笔记标题…";
    elExport.disabled = false;
  }

  // ─── 切换编辑 / 阅读（预览）模式 ───
  // focus 仅在用户主动切换（点按钮 / 双击正文）时为 true；切换笔记时保持编辑页但不抢焦点。
  function setMode(preview, { focus = false } = {}) {
    isPreviewMode = preview;
    if (preview) {
      // 退出编辑前落盘
      if (activeId) { clearTimeout(saveTimer); saveCurrent(); }
      elTextarea.hidden = true;
      elPreview.hidden = false;
      elMode.innerHTML = SVG.edit;
      elMode.title = "编辑";
      renderPreview(elTextarea.value);
      elPreview.scrollTop = 0;
    } else {
      elTextarea.hidden = false;
      elPreview.hidden = true;
      elMode.innerHTML = SVG.eye;
      elMode.title = "预览";
      if (focus) elTextarea.focus();
    }
  }

  // ─── 导出为 Markdown ───
  // 文件名净化：替换 Windows 非法字符、去掉结尾空白与点，避免另存为对话框写入失败
  function safeFileName(s) {
    const cleaned = String(s || "").replace(/[\\/:*?"<>|]/g, "_").replace(/[\s.]+$/g, "").slice(0, 60);
    return cleaned || "未命名笔记";
  }

  // 组装 Markdown：正文首行若已是同名 H1 则不重复添加标题
  function buildMarkdown(title, content) {
    const body = String(content || "").replace(/^\s*\n+/, "").replace(/\s+$/g, "");
    const t = String(title || "").trim();
    if (!t) return body + "\n";
    const firstLine = body.split("\n").find((l) => l.trim());
    const sameH1 = !!firstLine
      && /^#\s+/.test(firstLine.trim())
      && firstLine.trim().replace(/^#\s+/, "").trim() === t;
    return sameH1 ? body + "\n" : `# ${t}\n\n${body}\n`;
  }

  // 导出当前笔记：先落盘保证内容最新，再弹系统「另存为」写入 .md
  async function exportNote() {
    if (!activeId) return;
    clearTimeout(saveTimer);
    saveCurrent();
    const note = (state.notes || []).find((n) => n.id === activeId);
    if (!note) return;
    const title = note.title || extractTitle(note.content) || "未命名笔记";
    try {
      const saved = await invoke("export_text_file", {
        defaultName: safeFileName(title) + ".md",
        content: buildMarkdown(title, note.content),
        filterName: "Markdown 文档",
        extensions: ["md"],
      });
      if (!saved) { toast("已取消导出"); return; }
      toast(`已导出 ${String(saved).split(/[\\/]/).pop()}`);
    } catch (e) {
      console.error("[notes] 导出失败", e);
      toast("导出失败，请重试");
    }
  }

  // ─── 更新状态栏 ───
  function updateStatus(content) {
    const charCount = content.length;
    const readTime = Math.max(1, Math.ceil(charCount / 400));
    elCount.textContent = `${charCount} 字`;
    elReadtime.textContent = `约 ${readTime} 分钟`;
  }

  // ─── 防抖保存 ───
  function debouncedSave() {
    dirty = true;
    elSaved.textContent = "编辑中…";
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveCurrent, 1000);
  }

  // ─── 保存当前笔记（仅在 dirty 时） ───
  function saveCurrent() {
    if (!activeId || !dirty) return;
    const note = (state.notes || []).find((n) => n.id === activeId);
    if (!note) return;
    note.content = elTextarea.value;
    note.title = elTitle.value || extractTitle(note.content);
    note.updatedAt = Date.now();
    dirty = false;
    saveState();
    elSaved.textContent = "已保存 " + new Date().toLocaleTimeString("zh-CN", { hour12: false });
    updateStatus(note.content);
    renderList();
  }

  // ─── 输入事件 ───
  function onInput() {
    elSaved.textContent = "编辑中…";
    if (activeId) {
      const note = (state.notes || []).find((n) => n.id === activeId);
      if (note) {
        note.content = elTextarea.value;
        note.title = elTitle.value || extractTitle(elTextarea.value);
        updateStatus(note.content);
      }
    }
    debouncedSave();
  }

  // ─── 选择笔记 ───
  function selectNote(id) {
    if (activeId) { clearTimeout(saveTimer); saveCurrent(); }
    dirty = false;

    const note = (state.notes || []).find((n) => n.id === id);
    if (!note) return;
    activeId = id;
    elTitle.value = note.title || extractTitle(note.content);
    elPin.classList.toggle("active", note.pinned);
    elPin.innerHTML = note.pinned ? SVG.pinFill : SVG.pin;
    elPin.title = note.pinned ? "取消置顶" : "置顶";
    elTextarea.value = note.content;
    // 保持编辑页，但不进入焦点：不弹光标、不滚到文末
    renderNoteState();
    setMode(false);
    // 若编辑器仍持有焦点（上一篇正在编辑），切换时主动交还，避免光标残留在旧位置
    if (document.activeElement === elTextarea) elTextarea.blur();
    elTextarea.scrollTop = 0;
    updateStatus(note.content);
    renderList();
  }

  // ─── 新建笔记 ───
  function createNote() {
    if (activeId) { clearTimeout(saveTimer); saveCurrent(); }
    dirty = false;

    const now = Date.now();
    const note = {
      id: "n_" + now + "_" + Math.random().toString(36).slice(2, 8),
      title: "",
      content: "",
      pinned: false,
      createdAt: now,
      updatedAt: now,
    };
    if (!Array.isArray(state.notes)) state.notes = [];
    state.notes.unshift(note);
    activeId = note.id;
    saveState();
    renderList();
    selectNote(note.id); // 装载内容（编辑页、不聚焦）
    elTitle.focus(); // 新建例外：聚焦标题，便于立刻命名
  }

  // ─── 切换置顶 ───
  function togglePin(id) {
    const note = (state.notes || []).find((n) => n.id === id);
    if (!note) return;
    note.pinned = !note.pinned;
    saveState();
    renderList();
    if (id === activeId) {
      elPin.classList.toggle("active", note.pinned);
      elPin.innerHTML = note.pinned ? SVG.pinFill : SVG.pin;
    }
  }

  // ─── 删除笔记 ───
  function deleteNote(id) {
    if (!state.notes) return;
    const idx = state.notes.findIndex((n) => n.id === id);
    if (idx < 0) return;
    state.notes.splice(idx, 1);
    if (id === activeId) {
      activeId = null;
      if (state.notes.length > 0) {
        selectNote(state.notes[0].id);
      } else {
        elTitle.value = "";
        elTextarea.value = "";
        elPin.classList.remove("active");
        elPin.innerHTML = SVG.pin;
        elPin.title = "置顶";
        renderEmptyState();
        setMode(false); // 保持编辑页（输入已禁用），显示空态引导
      }
    }
    saveState();
    renderList();
  }

  // ─── 事件绑定 ───
  elNew.addEventListener("click", createNote);
  elSearch.addEventListener("input", () => {
    searchQuery = elSearch.value.trim();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(renderList, 200);
  });
  elTitle.addEventListener("input", debouncedSave);
  elTextarea.addEventListener("input", onInput);
  elMode.addEventListener("click", () => setMode(!isPreviewMode, { focus: true }));
  elExport.addEventListener("click", exportNote);
  elPreview.addEventListener("dblclick", () => { if (activeId) setMode(false, { focus: true }); });
  elTextarea.addEventListener("blur", () => { if (activeId) { clearTimeout(saveTimer); saveCurrent(); } });
  elTitle.addEventListener("blur", () => { if (activeId) { clearTimeout(saveTimer); saveCurrent(); } });
  elPin.addEventListener("click", () => { if (activeId) togglePin(activeId); });
  elDel.addEventListener("click", () => { if (activeId) deleteNote(activeId); });

  // ─── 初始化 ───
  ensureMarked();
  renderList();
  if (state.notes && state.notes.length > 0) {
    selectNote(state.notes[0].id); // 打开即编辑页，但不抢焦点
  } else {
    renderEmptyState();
    setMode(false);
  }

  view.onDestroy(() => { clearTimeout(saveTimer); });
}
