// 笔记列表视图：左侧笔记列表 + 右侧编辑/阅读双态 Markdown 面板，支持导出为 .md。
// 交互：打开视图或切换笔记均按 navState.notes.noteModes 恢复该笔记上次的状态（编辑/预览），
// 均不自动聚焦；仅用户主动操作（点模式按钮、双击正文）才进入输入；新建笔记直接聚焦标题。
import { state, saveState } from "../state.js";
import { invoke } from "../bus.js";
import { toast } from "../toast.js";

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// ─── marked.js 初始化 ───
let _markedReady = false;
// ==高亮== 扩展：GFM 原生不支持，自定义 tokenizer 让预览态渲染 <mark>
const highlightExt = {
  name: "highlight",
  level: "inline",
  start(src) { const i = src.indexOf("=="); return i < 0 ? undefined : i; },
  tokenizer(src) {
    const m = /^==(?=\S)([\s\S]*?\S)==/.exec(src);
    if (m) return { type: "highlight", raw: m[0], tokens: this.lexer.inlineTokens(m[1]) };
  },
  renderer(token) { return `<mark>${this.parser.parseInline(token.tokens)}</mark>`; },
};
function ensureMarked() {
  if (_markedReady) return true;
  if (typeof marked === "undefined") return false;
  marked.setOptions({ gfm: true, breaks: true, async: false });
  marked.use({ extensions: [highlightExt] });
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
  // ─── Editing Toolbar 图标 ───
  chevD: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>',
  chevU: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m18 15-6-6-6 6"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
  code: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>',
  ul: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="9" y1="6" x2="21" y2="6"/><line x1="9" y1="12" x2="21" y2="12"/><line x1="9" y1="18" x2="21" y2="18"/><circle cx="4.5" cy="6" r="1" fill="currentColor" stroke="none"/><circle cx="4.5" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="4.5" cy="18" r="1" fill="currentColor" stroke="none"/></svg>',
  ol: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="10" y1="6" x2="21" y2="6"/><line x1="10" y1="12" x2="21" y2="12"/><line x1="10" y1="18" x2="21" y2="18"/><text x="2.5" y="8.5" font-size="8" font-weight="700" fill="currentColor" stroke="none">1</text><text x="2.5" y="14.5" font-size="8" font-weight="700" fill="currentColor" stroke="none">2</text><text x="2.5" y="20.5" font-size="8" font-weight="700" fill="currentColor" stroke="none">3</text></svg>',
  task: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 8 2 2 3.5-4"/><path d="m3 17 2 2 3.5-4"/><line x1="13" y1="7.5" x2="21" y2="7.5"/><line x1="13" y1="16.5" x2="21" y2="16.5"/></svg>',
  quote: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 11c0 5-2.5 7-6 7"/><path d="M10 5v6"/><path d="M21 11c0 5-2.5 7-6 7"/><path d="M21 5v6"/></svg>',
  codeblock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"/><polyline points="10 9 7.5 12 10 15"/><polyline points="14 9 16.5 12 14 15"/></svg>',
  link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>',
  table: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><line x1="3" y1="10" x2="21" y2="10"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="10" y1="4" x2="10" y2="20"/></svg>',
  hr: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="8" x2="7" y2="8" opacity=".4"/><line x1="17" y1="8" x2="20" y2="8" opacity=".4"/></svg>',
  more: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>',
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
  let isPreviewMode = false; // 默认编辑页；每篇笔记的状态记录在 navState.notes.noteModes，切换/重启后恢复
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
        <!-- Editing Toolbar：编辑格式栏（一期，仅编辑态显示） -->
        <div id="nt-fmt" class="et-row disabled" hidden></div>
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

  // ═══ Editing Toolbar（一期：固定格式栏）═══
  const elFmt = body.querySelector("#nt-fmt");
  let fmtCollapsed = localStorage.getItem("notes.toolbarCollapsed") === "1";

  elFmt.innerHTML = `
    <div class="et-full">
      <div class="et-menuwrap">
        <button class="et-btn" id="et-h" title="标题 Ctrl+1~4"><span class="et-h">H</span>${SVG.chevD}</button>
        <div class="et-menu" id="et-h-menu" hidden>
          ${[0, 1, 2, 3, 4].map((lv) => `<div class="et-mi" data-h="${lv}"><span class="chk"></span>${lv ? `标题 ${lv}` : "正文"}<span class="sp"></span><span class="et-kbd">Ctrl+${lv}</span></div>`).join("")}
        </div>
      </div>
      <span class="et-sep"></span>
      <button class="et-btn" data-fmt="bold" title="加粗 Ctrl+B"><span class="et-g">B</span></button>
      <button class="et-btn" data-fmt="italic" title="斜体 Ctrl+I"><span class="et-g it">I</span></button>
      <button class="et-btn" data-fmt="strike" title="删除线 Ctrl+Shift+X"><span class="et-g st">S</span></button>
      <button class="et-btn" data-fmt="highlight" title="高亮 Ctrl+Shift+H"><span class="et-g hl">高</span></button>
      <button class="et-btn" data-fmt="icode" title="行内代码 Ctrl+E">${SVG.code}</button>
      <span class="et-sep"></span>
      <button class="et-btn" data-fmt="ul" title="无序列表 Ctrl+Shift+8">${SVG.ul}</button>
      <button class="et-btn" data-fmt="ol" title="有序列表">${SVG.ol}</button>
      <button class="et-btn" data-fmt="task" title="任务列表">${SVG.task}</button>
      <span class="et-sep"></span>
      <button class="et-btn" data-fmt="quote" title="引用">${SVG.quote}</button>
      <button class="et-btn" data-fmt="codeblock" title="代码块">${SVG.codeblock}</button>
      <button class="et-btn" data-fmt="link" title="链接 Ctrl+K">${SVG.link}</button>
      <button class="et-btn" data-fmt="table" title="表格">${SVG.table}</button>
      <button class="et-btn" data-fmt="hr" title="分割线">${SVG.hr}</button>
      <div class="et-flex"></div>
      <div class="et-menuwrap">
        <button class="et-btn" id="et-more" title="更多">${SVG.more}</button>
        <div class="et-menu et-menu-right" id="et-more-menu" hidden>
          <div class="et-mi" data-fmt="ts"><span class="chk"></span>插入时间戳<span class="sp"></span><span class="et-kbd">Ctrl+;</span></div>
          <div class="et-mi" data-fmt="toc"><span class="chk"></span>插入目录 TOC</div>
          <div class="et-mi dis"><span class="chk"></span>字号<span class="sp"></span><span class="tag2">二期</span></div>
          <div class="et-mi dis"><span class="chk"></span>文字颜色<span class="sp"></span><span class="tag2">二期</span></div>
          <div class="et-mi dis"><span class="chk"></span>插入图片<span class="sp"></span><span class="tag2">二期</span></div>
        </div>
      </div>
      <button class="et-btn" id="et-collapse" title="收起工具栏">${SVG.chevU}</button>
    </div>
    <button class="et-btn et-expand" id="et-expand" title="展开工具栏">${SVG.chevD}</button>`;

  // ─── 选区工具：优先 execCommand，保留 textarea 原生撤销栈 ───
  function replaceRange(start, end, text, selStart, selEnd) {
    elTextarea.focus();
    elTextarea.setSelectionRange(start, end);
    if (!document.execCommand("insertText", false, text)) {
      elTextarea.setRangeText(text, start, end, "end");
    }
    if (selStart != null) elTextarea.setSelectionRange(selStart, selEnd ?? selStart);
    onInput();
  }

  // 行内样式：包裹选区；已包裹则取消；无选区插入占位文本并选中
  function wrapInline(pre, post, placeholder) {
    const v = elTextarea.value;
    const s = elTextarea.selectionStart, e = elTextarea.selectionEnd;
    if (s === e) {
      const ph = placeholder || "文本";
      replaceRange(s, e, pre + ph + post, s + pre.length, s + pre.length + ph.length);
      return;
    }
    const before = v.slice(Math.max(0, s - pre.length), s);
    const after = v.slice(e, e + post.length);
    if (before === pre && after === post) {
      replaceRange(s - pre.length, e + post.length, v.slice(s, e), s - pre.length, e - pre.length);
      return;
    }
    replaceRange(s, e, pre + v.slice(s, e) + post, s + pre.length, e + pre.length);
  }

  // 块级样式：对选区覆盖的每一行做变换（再点一次取消）
  function mapLines(fn) {
    const v = elTextarea.value;
    const s = elTextarea.selectionStart, e = elTextarea.selectionEnd;
    const ls = v.lastIndexOf("\n", s - 1) + 1;
    let le = v.indexOf("\n", e); if (le < 0) le = v.length;
    const lines = v.slice(ls, le).split("\n");
    const out = fn(lines).join("\n");
    replaceRange(ls, le, out, ls, ls + out.length);
  }

  const FMT = {
    bold: () => wrapInline("**", "**", "加粗文字"),
    italic: () => wrapInline("*", "*", "斜体文字"),
    strike: () => wrapInline("~~", "~~", "删除文字"),
    highlight: () => wrapInline("==", "==", "高亮文字"),
    icode: () => wrapInline("`", "`", "代码"),
    ul: () => mapLines((lines) => {
      const all = lines.filter((l) => l.trim()).every((l) => { const t = l.trimStart(); return t.startsWith("- ") || t.startsWith("- [ ] "); });
      return lines.map((l) => !l.trim() ? l : all ? l.replace(/^(\s*)- (?:\[ \] )?/, "$1") : l.replace(/^(\s*)/, "$1- "));
    }),
    ol: () => mapLines((lines) => {
      const all = lines.filter((l) => l.trim()).every((l) => /^\s*\d+\. /.test(l));
      let n = 0;
      return lines.map((l) => !l.trim() ? l
        : all ? l.replace(/^(\s*)\d+\. /, "$1")
        : l.replace(/^(\s*)/, (m) => m + (++n) + ". "));
    }),
    task: () => mapLines((lines) => lines.map((l) => {
      if (!l.trim()) return l;
      const t = l.trimStart();
      if (t.startsWith("- [ ] ")) return l.replace(/^(\s*)- \[ \] /, "$1");
      if (t.startsWith("- ")) return l.replace(/^(\s*)- /, "$1- [ ] ");
      return l.replace(/^(\s*)/, "$1- [ ] ");
    })),
    quote: () => mapLines((lines) => {
      const all = lines.filter((l) => l.trim()).every((l) => l.trimStart().startsWith("> "));
      return lines.map((l) => !l.trim() ? l : all ? l.replace(/^(\s*)> ?/, "$1") : l.replace(/^(\s*)/, "$1> "));
    }),
    heading: (lv) => mapLines((lines) => lines.map((l) => {
      const m = l.match(/^(\s*)(#{1,6})\s+/);
      const cur = m ? m[2].length : 0;
      const stripped = l.replace(/^(\s*)#{1,6}\s+/, "$1");
      if (cur === lv || lv === 0) return stripped; // 同级再点 → 回到正文
      const pad = (stripped.match(/^\s*/) || [""])[0];
      return pad + "#".repeat(lv) + " " + stripped.slice(pad.length);
    })),
    hr: () => {
      const s = elTextarea.selectionStart;
      replaceRange(s, elTextarea.selectionEnd, "\n\n---\n\n");
    },
    codeblock: () => {
      const v = elTextarea.value, s = elTextarea.selectionStart, e = elTextarea.selectionEnd;
      const inner = v.slice(s, e) || "// 代码";
      replaceRange(s, e, "```\n" + inner + "\n```", s + 4, s + 4 + inner.length);
    },
    table: () => {
      const s = elTextarea.selectionStart;
      const tpl = "\n| 列1 | 列2 | 列3 |\n| --- | --- | --- |\n|  |  |  |\n";
      replaceRange(s, elTextarea.selectionEnd, tpl);
    },
    link: () => {
      const v = elTextarea.value, s = elTextarea.selectionStart, e = elTextarea.selectionEnd;
      const sel = v.slice(s, e) || "链接文字";
      replaceRange(s, e, `[${sel}](url)`, s + sel.length + 3, s + sel.length + 6);
    },
    ts: () => {
      const d = new Date();
      const pad = (n) => String(n).padStart(2, "0");
      const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
      const s = elTextarea.selectionStart;
      replaceRange(s, elTextarea.selectionEnd, stamp, s + stamp.length);
    },
    toc: () => {
      const heads = [...elTextarea.value.matchAll(/^#{1,4}\s+(.+)$/gm)]
        .map((m) => m[1].trim()).filter((t) => t && t !== "目录");
      if (!heads.length) { toast("还没有可用的标题，先写几个标题吧"); return; }
      const s = elTextarea.selectionStart;
      replaceRange(s, elTextarea.selectionEnd, "\n\n## 目录\n\n" + heads.map((t) => "- " + t).join("\n") + "\n");
    },
  };

  // ─── 菜单开合 ───
  function closeMenus() {
    elFmt.querySelector("#et-h-menu").hidden = true;
    elFmt.querySelector("#et-more-menu").hidden = true;
  }
  elFmt.addEventListener("click", (e) => {
    const mi = e.target.closest(".et-mi:not(.dis)");
    const btn = e.target.closest(".et-btn");
    if (mi) {
      if (mi.dataset.h != null) FMT.heading(+mi.dataset.h);
      else if (mi.dataset.fmt && FMT[mi.dataset.fmt]) FMT[mi.dataset.fmt]();
      closeMenus();
      syncActive();
      return;
    }
    if (!btn) return;
    if (btn.id === "et-h") {
      const m = elFmt.querySelector("#et-h-menu");
      m.hidden = !m.hidden;
      elFmt.querySelector("#et-more-menu").hidden = true;
      return;
    }
    if (btn.id === "et-more") {
      const m = elFmt.querySelector("#et-more-menu");
      m.hidden = !m.hidden;
      elFmt.querySelector("#et-h-menu").hidden = true;
      return;
    }
    if (btn.id === "et-collapse") {
      fmtCollapsed = true;
      localStorage.setItem("notes.toolbarCollapsed", "1");
      syncFmtRow();
      return;
    }
    if (btn.id === "et-expand") {
      fmtCollapsed = false;
      localStorage.setItem("notes.toolbarCollapsed", "0");
      syncFmtRow();
      elTextarea.focus();
      return;
    }
    if (btn.dataset.fmt && FMT[btn.dataset.fmt]) {
      FMT[btn.dataset.fmt]();
      closeMenus();
      syncActive();
    }
  });
  const onDocClickFmt = (e) => { if (!e.target.closest(".et-menuwrap")) closeMenus(); };
  document.addEventListener("click", onDocClickFmt);

  // ─── 按钮状态回显：随光标/选区点亮已命中的样式 ───
  function syncActive() {
    if (isPreviewMode || !activeId || elTextarea.disabled) return;
    const v = elTextarea.value;
    const s = elTextarea.selectionStart, e = elTextarea.selectionEnd;
    const ls = v.lastIndexOf("\n", s - 1) + 1;
    let le = v.indexOf("\n", s); if (le < 0) le = v.length;
    const line = v.slice(ls, le);
    const set = (sel, on) => { const b = elFmt.querySelector(sel); if (b) b.classList.toggle("on", !!on); };
    const surround = (pre, post) =>
      v.slice(Math.max(0, s - pre.length), s) === pre && v.slice(e, e + post.length) === post;
    set('[data-fmt="bold"]', surround("**", "**"));
    set('[data-fmt="italic"]', v.slice(s - 1, s) === "*" && v.slice(s - 2, s) !== "**" && v.slice(e, e + 1) === "*");
    set('[data-fmt="strike"]', surround("~~", "~~"));
    set('[data-fmt="highlight"]', surround("==", "=="));
    set('[data-fmt="icode"]', surround("`", "`"));
    const hm = line.match(/^\s*(#{1,6})\s+/);
    const lv = hm ? hm[1].length : 0;
    set("#et-h", lv > 0);
    const hlab = elFmt.querySelector("#et-h .et-h");
    if (hlab) hlab.textContent = lv > 0 && lv <= 4 ? "H" + lv : "H";
    elFmt.querySelectorAll("#et-h-menu .et-mi").forEach((mi) => {
      mi.querySelector(".chk").innerHTML = +mi.dataset.h === lv ? SVG.check : "";
      mi.classList.toggle("sel", +mi.dataset.h === lv);
    });
  }
  ["keyup", "mouseup", "input", "focus"].forEach((ev) => elTextarea.addEventListener(ev, syncActive));

  // ─── 快捷键（与 Obsidian 对齐）───
  elTextarea.addEventListener("keydown", (e) => {
    if (isPreviewMode || elTextarea.disabled) return;
    if (!(e.ctrlKey || e.metaKey)) return;
    const k = e.key.toLowerCase();
    const run = (fn) => { e.preventDefault(); e.stopPropagation(); fn(); syncActive(); };
    if (e.shiftKey && k === "x") return run(FMT.strike);
    if (e.shiftKey && k === "h") return run(FMT.highlight);
    if (e.shiftKey && k === "8") return run(FMT.ul);
    if (!e.shiftKey && k === "b") return run(FMT.bold);
    if (!e.shiftKey && k === "i") return run(FMT.italic);
    if (!e.shiftKey && k === "e") return run(FMT.icode);
    if (!e.shiftKey && k === "k") return run(FMT.link);
    if (!e.shiftKey && k === ";") return run(FMT.ts);
    if (!e.shiftKey && /^[0-4]$/.test(e.key)) return run(() => FMT.heading(+e.key));
  });

  // ─── 格式栏显隐：预览态隐藏；收起态只留展开按钮 ───
  function syncFmtRow() {
    elFmt.hidden = isPreviewMode;
    elFmt.classList.toggle("collapsed", fmtCollapsed);
    if (!isPreviewMode) syncActive();
  }


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
    elFmt.classList.add("disabled");
  }

  // ─── 有笔记时的正常态 ───
  function renderNoteState() {
    elTextarea.disabled = false;
    elTextarea.placeholder = "开始输入…（支持 Markdown）";
    elTitle.disabled = false;
    elTitle.placeholder = "笔记标题…";
    elExport.disabled = false;
    elFmt.classList.remove("disabled");
  }

  // ─── 切换编辑 / 阅读（预览）模式 ───
  // focus 仅在用户主动切换（点按钮 / 双击正文）时为 true。
  // remember=true 时把该笔记的模式记入 navState.notes.noteModes（只记 "preview" 偏差，
  // 缺省即编辑态），切换笔记 / 重启后由 selectNote 恢复；恢复路径传 remember=false 避免多余写盘。
  function rememberMode(id, preview) {
    if (!state.navState) state.navState = {};
    if (!state.navState.notes || typeof state.navState.notes !== "object") state.navState.notes = {};
    if (!state.navState.notes.noteModes || typeof state.navState.notes.noteModes !== "object") {
      state.navState.notes.noteModes = {};
    }
    if (preview) state.navState.notes.noteModes[id] = "preview";
    else delete state.navState.notes.noteModes[id];
    saveState();
  }
  function savedModeIsPreview(id) {
    return state.navState?.notes?.noteModes?.[id] === "preview";
  }

  function setMode(preview, { focus = false, remember = true } = {}) {
    isPreviewMode = preview;
    if (remember && activeId) rememberMode(activeId, preview);
    syncFmtRow();
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
    // 记住上次查看的笔记：切换到其他模块再回来时恢复到这里
    if (!state.navState) state.navState = {};
    if (!state.navState.notes || typeof state.navState.notes !== "object") state.navState.notes = {};
    if (state.navState.notes.lastId !== id) {
      state.navState.notes.lastId = id;
      saveState();
    }
    elTitle.value = note.title || extractTitle(note.content);
    elPin.classList.toggle("active", note.pinned);
    elPin.innerHTML = note.pinned ? SVG.pinFill : SVG.pin;
    elPin.title = note.pinned ? "取消置顶" : "置顶";
    elTextarea.value = note.content;
    // 恢复该笔记上次的状态：上次停在预览则进预览，否则保持编辑页；均不抢焦点
    renderNoteState();
    setMode(savedModeIsPreview(id), { remember: false });
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
    // 清理该笔记的模式记录（navState.notes.noteModes 只存预览态偏差）
    if (state.navState?.notes?.noteModes) {
      delete state.navState.notes.noteModes[id];
    }
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
    // 恢复上次查看的笔记（navState.notes.lastId）；记录不存在或笔记已删则回退到列表第一篇
    const lastId = state.navState?.notes?.lastId;
    const last = lastId ? (state.notes || []).find((n) => n.id === lastId) : null;
    selectNote(last ? last.id : state.notes[0].id); // 打开即恢复上次状态，但不抢焦点
  } else {
    renderEmptyState();
    setMode(false);
  }

  view.onDestroy(() => { clearTimeout(saveTimer); document.removeEventListener("click", onDocClickFmt); });
}
