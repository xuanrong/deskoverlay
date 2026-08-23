// 速记视图：单栏「编辑 / 预览」切换的 Markdown 笔记，自动保存，零依赖。
import { state, saveState } from "../state.js";

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// ---------- markdown -> HTML ----------
function inlineToHtml(raw) {
  let s = esc(raw);
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (m, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, t, u) => `<img src="${esc(u)}" alt="${esc(t)}" />`);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, t, u) => `<a href="${esc(u)}" target="_blank" rel="noopener">${t}</a>`);
  s = s.replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (m, a, b) => `<strong>${a || b}</strong>`);
  s = s.replace(/(^|[^*])\*([^*\s][^*]*?[^*\s])\*(?!\*)/g, (m, pre, it) => `${pre}<em>${it}</em>`);
  s = s.replace(/(^|[^_])_([^_\s][^_]*?[^_\s])_(?!_)/g, (m, pre, it) => `${pre}<em>${it}</em>`);
  s = s.replace(/~~([^~]+)~~/g, (m, c) => `<del>${c}</del>`);
  s = s.replace(/\u0000(\d+)\u0000/g, (m, i) => `<code>${esc(codes[+i])}</code>`);
  return s;
}

function markdownToHtml(md) {
  const lines = String(md || "").replace(/\r\n/g, "\n").split("\n");
  const blocks = [];
  let cur = null, fence = null, fenceLang = "";
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fm = line.match(/^```([\w+-]*)\s*$/);
    if (fm) {
      if (fence) { blocks.push(["code", fenceLang, cur[1]]); cur = null; fence = null; }
      else { if (cur && cur[0] === "para") blocks.push(cur); cur = null; fence = fm[1]; fenceLang = fm[1]; cur = ["code", [],]; }
      i++; continue;
    }
    if (fence) { cur[1].push(line); i++; continue; }
    const trim = line.trim();
    if (!trim) {
      if (cur && ["para", "list", "ol", "quote"].includes(cur[0])) { blocks.push(cur); cur = null; }
      i++; continue;
    }
    if (/^(\*{3,}|-{3,}|_{3,})\s*$/.test(trim)) { if (cur) blocks.push(cur); cur = null; blocks.push(["hr"]); i++; continue; }
    const hm = trim.match(/^(#{1,6})\s+(.*)$/);
    if (hm) { if (cur) blocks.push(cur); cur = null; blocks.push(["h", hm[1].length, hm[2]]); i++; continue; }
    if (trim.startsWith("> ")) { if (!cur || cur[0] !== "quote") { if (cur) blocks.push(cur); cur = ["quote", []]; } cur[1].push(trim.slice(2)); i++; continue; }
    if (/^[-*]\s+/.test(trim)) { if (!cur || cur[0] !== "list") { if (cur) blocks.push(cur); cur = ["list", []]; } cur[1].push(trim.replace(/^[-*]\s+/, "")); i++; continue; }
    const om = trim.match(/^\d+[.)]\s+(.*)$/);
    if (om) { if (!cur || cur[0] !== "ol") { if (cur) blocks.push(cur); cur = ["ol", []]; } cur[1].push(om[1]); i++; continue; }
    if (!cur || cur[0] !== "para") { if (cur) blocks.push(cur); cur = ["para", []]; }
    cur[1].push(trim);
    i++;
  }
  if (cur) blocks.push(cur);

  const html = blocks.map((b) => {
    const k = b[0];
    if (k === "hr") return `<div class="pm-hr"></div>`;
    if (k === "h") return `<h${b[1]} class="pm-h pm-h${b[1]}">${inlineToHtml(b[2])}</h${b[1]}>`;
    if (k === "para") return `<p class="pm-p">${inlineToHtml(b[1].join("\n"))}</p>`;
    if (k === "quote") return `<blockquote class="pm-q">${b[2].map((x) => `<div>${inlineToHtml(x)}</div>`).join("")}</blockquote>`;
    if (k === "list") return `<ul class="pm-list">${b[1].map((x) => `<li>${inlineToHtml(x)}</li>`).join("")}</ul>`;
    if (k === "ol") return `<ol class="pm-list pm-ol">${b[1].map((x) => `<li>${inlineToHtml(x)}</li>`).join("")}</ol>`;
    if (k === "code") return `<div class="pm-fence"><pre><code>${esc(b[1] ? b[1] + "\n" : "")}${esc(b[2].join("\n"))}</code></pre></div>`;
    return "";
  }).join("");
  return `<div class="pm">${html || `<p class="pm-p pm-empty">（暂无内容，点击「编辑」开始记录）</p>`}</div>`;
}

// ---------- 视图 ----------
export function renderNotes(view) {
  view.header.style.display = "none";
  const body = view.body;
  body.innerHTML = `
    <div class="notes-top">
      <div class="notes-switch">
        <button class="ns-btn active" data-v="edit">编辑</button>
        <button class="ns-btn" data-v="preview">预览</button>
      </div>
      <span class="notes-saved" id="n-saved"></span>
    </div>
    <textarea class="notes-area" id="n-area" placeholder="随手记录灵感、会议纪要…（支持 Markdown：**加粗**、## 标题、- 列表 …）"></textarea>
    <div class="notes-preview" id="n-prev" hidden></div>`;
  const area = body.querySelector("#n-area");
  const prev = body.querySelector("#n-prev");
  const savedEl = body.querySelector("#n-saved");
  const btns = body.querySelectorAll(".ns-btn");
  area.value = state.notes || "";

  const show = (mode) => {
    const isEdit = mode === "edit";
    area.hidden = !isEdit;
    prev.hidden = isEdit;
    btns.forEach((b) => b.classList.toggle("active", b.dataset.v === mode));
    body.classList.toggle("notes-focus-edit", isEdit);
    if (!isEdit) prev.innerHTML = markdownToHtml(area.value);
  };
  btns.forEach((b) => b.addEventListener("click", () => show(b.dataset.v)));

  let timer;
  const onInput = () => {
    savedEl.textContent = "编辑中…";
    clearTimeout(timer);
    timer = setTimeout(() => {
      state.notes = area.value;
      saveState();
      savedEl.textContent = "已保存 " + new Date().toLocaleTimeString("zh-CN", { hour12: false });
    }, 500);
  };
  area.addEventListener("input", onInput);
  view.onDestroy(() => { clearTimeout(timer); });
}