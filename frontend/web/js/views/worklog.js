// 工作记录视图 · 方案 B（双栏总览工作台）：
// 左栏 = 类型筛选 / 类型分布 / 周历热力；右栏 = 快捷录入 + 按天分组的时间线。
// 记录粒度只到「日期」，不含时分；历史数据遗留的 time 字段保留但不再展示/录入。
// 数据模型沿用 state.workLogs: { id, date:"YYYY-MM-DD", text, type, tags }
import { state, saveState } from "../state.js";
import { esc, fitTextarea } from "./common.js";
import { createDatePicker } from "../datepicker.js";
import { createSelect } from "../selectbox.js";
import { ICON_CLOSE } from "../icons.js";

// 快捷录入 textarea 最大自适应高度（与 CSS max-height 对齐，超出后内部滚动）
const INPUT_MAX_H = 130;

// 记录类型 → 中文标签 + 颜色（与设计稿 / 视觉 token 对齐）
const LOG_TYPES = ["工作", "会议", "学习", "生活", "其他"];
const TYPE_CLASS = { 工作: "work", 会议: "meet", 学习: "study", 生活: "life", 其他: "other" };
const TYPE_COLOR = {
  工作: "#5fa8d3",
  会议: "#b48ae6",
  学习: "#5fd39a",
  生活: "#e6b45f",
  其他: "#9aa7b4",
};
const DOT_CLASS = { 工作: "wb-dot-work", 会议: "wb-dot-meet", 学习: "wb-dot-study", 生活: "wb-dot-life", 其他: "wb-dot-other" };
const PILL_CLASS = { 工作: "wb-pill-work", 会议: "wb-pill-meet", 学习: "wb-pill-study", 生活: "wb-pill-life", 其他: "wb-pill-other" };

// 当天日期 YYYY-MM-DD（本地时区）
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function toDate(str) {
  const d = new Date(str + "T00:00:00");
  return isNaN(d) ? null : d;
}

function dateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function addDays(d, n) {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

// 日期标题：今天/昨天 + 周几；其他显示「M月D日 · 周X」（跨年带年份）
function dateTitle(dateStr) {
  if (!dateStr) return "";
  const today = todayStr();
  const yest = dateKey(addDays(new Date(), -1));
  const d = toDate(dateStr);
  if (!d) return dateStr;
  const week = ["日", "一", "二", "三", "四", "五", "六"][d.getDay()];
  if (dateStr === today) return `今天 · 周${week}`;
  if (dateStr === yest) return `昨天 · 周${week}`;
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return (sameYear ? "" : `${d.getFullYear()}年`) + `${d.getMonth() + 1}月${d.getDate()}日 · 周${week}`;
}

// ---------- 数据派生 ----------

// 记录类型 → 条数（用于分布 / 筛选计数）
function typeCounts() {
  const c = {};
  for (const t of LOG_TYPES) c[t] = 0;
  for (const log of state.workLogs || []) {
    const t = LOG_TYPES.includes(log.type) ? log.type : "其他";
    c[t]++;
  }
  return c;
}

// 连续记录天数（截至今天）
function streakDays() {
  let n = 0;
  const set = new Set((state.workLogs || []).map((w) => w.date || todayStr()));
  let d = new Date();
  while (set.has(dateKey(d))) { n++; d = addDays(d, -1); }
  return n;
}

// 周历热力：近 4 周（周日为首），28 格，行=周(旧在上)，列=日~六
function heatCells() {
  const counts = new Map();
  for (const log of state.workLogs || []) {
    const k = log.date || todayStr();
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const today = new Date();
  const thisSun = addDays(today, -today.getDay()); // 本周周日（getDay：周日=0）
  const cells = [];
  for (let w = 3; w >= 0; w--) {
    const ws = addDays(thisSun, -w * 7);
    for (let i = 0; i < 7; i++) {
      const d = addDays(ws, i);
      const k = dateKey(d);
      const n = counts.get(k) || 0;
      const future = d > today;
      const lv = future ? 0 : n === 0 ? 0 : n <= 2 ? 1 : n <= 4 ? 2 : 3;
      cells.push({ key: k, lv, today: k === dateKey(today), future });
    }
  }
  return cells;
}

// 按日期分组（最近在前）；同日内保持录入顺序（粒度到天，不再按时分排序）
function groupByDay(list) {
  const map = new Map();
  for (const log of list) {
    const date = log.date || todayStr();
    if (!map.has(date)) map.set(date, []);
    map.get(date).push(log);
  }
  return [...map.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));
}

// ---------- 区块模板 ----------

// 左栏 · 类型筛选
function filterCardHTML(counts, filter) {
  const rows = ["全部", ...LOG_TYPES].map((t) => {
    const active = filter === t;
    const dotCls = t === "全部" ? "wb-dot-all" : DOT_CLASS[t];
    const num = t === "全部" ? Object.values(counts).reduce((a, b) => a + b, 0) : counts[t] || 0;
    return `
      <button class="wb-flt ${active ? "on" : ""}" data-t="${esc(t)}">
        <span class="wb-dot ${dotCls}"></span>
        <span class="wb-flt-name">${esc(t === "全部" ? "全部记录" : t)}</span>
        <span class="wb-flt-c">${num}</span>
      </button>`;
  }).join("");
  return `
    <section class="wb-card wb-card-flt">
      <div class="wb-card-hd"><span class="wb-card-t">按类型筛选</span></div>
      <div class="wb-flt-list">${rows}</div>
    </section>`;
}

// 左栏 · 类型分布（堆叠条 + 图例）
function distCardHTML(counts, total) {
  const segs = LOG_TYPES.map((t) => {
    const pct = total ? Math.round(((counts[t] || 0) / total) * 100) : 0;
    return pct > 0 ? `<span class="wb-seg" style="width:${pct}%;background:${TYPE_COLOR[t]}"></span>` : "";
  }).join("");
  const legend = LOG_TYPES.map((t) => {
    const pct = total ? Math.round(((counts[t] || 0) / total) * 100) : 0;
    return `
      <span class="wb-lg">
        <span class="wb-dot ${DOT_CLASS[t]}"></span>
        ${esc(t)} <b>${counts[t] || 0}</b> · ${pct}%
      </span>`;
  }).join("");
  return `
    <section class="wb-card wb-card-dist">
      <div class="wb-card-hd"><span class="wb-card-t">类型分布</span><span class="wb-card-sub">${total} 条</span></div>
      <div class="wb-bar">${segs}</div>
      <div class="wb-legend">${legend}</div>
    </section>`;
}

// 左栏 · 周历热力
function heatCardHTML() {
  const streak = streakDays();
  const cells = heatCells();
  const grid = cells.map((c) =>
    `<div class="wb-hcell lv${c.lv}${c.today ? " today" : ""}" title="${c.key}${c.future ? "" : ""}"></div>`
  ).join("");
  return `
    <section class="wb-card wb-card-heat">
      <div class="wb-card-hd">
        <span class="wb-card-t">记录热力</span>
        ${streak > 0 ? `<span class="wb-chip">连续 ${streak} 天</span>` : ""}
      </div>
      <div class="wb-week"><span>日</span><span>一</span><span>二</span><span>三</span><span>四</span><span>五</span><span>六</span></div>
      <div class="wb-heat">${grid}</div>
      <div class="wb-hnote">近 4 周 · 颜色越亮当日记录越多 · 今日描边</div>
    </section>`;
}

// 单条时间线条目（类型胶囊 + 紫色标签；记录粒度到天，无时刻列）
function logItem(log) {
  const pill = PILL_CLASS[log.type] || "wb-pill-other";
  return `
    <div class="wb-it" data-id="${esc(log.id)}">
      <div class="wb-it-body">
        <div class="wb-it-text">${esc(log.text)}</div>
        <div class="wb-it-meta">
          <span class="wb-pill ${pill}">${esc(log.type || "其他")}</span>
          ${log.tags && log.tags.length ? `<span class="wb-tags">${log.tags.map((t) => `#${esc(t)}`).join(" ")}</span>` : ""}
        </div>
      </div>
      <div class="wb-actions">
        <button class="wb-edit" data-id="${esc(log.id)}" title="编辑">✎</button>
        <button class="wb-del" data-id="${esc(log.id)}" title="删除">${ICON_CLOSE}</button>
      </div>
    </div>`;
}

// 右栏 · 时间线（按天分组）
function timelineHTML(filter) {
  const all = state.workLogs || [];
  const list = filter === "全部" ? all : all.filter((w) => (LOG_TYPES.includes(w.type) ? w.type : "其他") === filter);
  const days = groupByDay(list);
  if (!days.length) {
    return `<div class="wb-empty">${filter !== "全部" ? "该类型下暂无记录" : "还没有记录，在上方记一条开始吧"}</div>`;
  }
  return days.map(([date, items]) => `
    <div class="wb-day">
      <div class="wb-day-hd">
        <span class="wb-day-t">${esc(dateTitle(date))}</span>
        <span class="wb-day-d">${esc(date)}</span>
        <span class="wb-day-c">${items.length} 条</span>
      </div>
      <div class="wb-day-items">${items.map(logItem).join("")}</div>
    </div>`).join("");
}

export function renderWorkLog(view) {
  view.header.style.display = "none";
  const body = view.body;
  body.innerHTML = `
    <div class="wb">
      <aside class="wb-side" id="wb-side"></aside>
      <section class="wb-main">
        <div class="wb-card wb-entry">
          <div class="wb-entry-top">
            <textarea id="wb-text" rows="1" placeholder="记一条：今天完成了什么？"></textarea>
            <button class="btn-primary" id="wb-add">＋ 记录</button>
          </div>
          <div class="wb-entry-foot">
            <div class="wb-types" id="wb-types">
              ${LOG_TYPES.map((t) => `<button class="wb-type" data-type="${esc(t)}">${esc(t)}</button>`).join("")}
            </div>
            <span id="wb-date" class="wb-date"></span>
          </div>
        </div>
        <div class="wb-tl" id="wb-tl"></div>
      </section>
    </div>`;

  const sideEl = body.querySelector("#wb-side");
  const tlEl = body.querySelector("#wb-tl");
  const textEl = body.querySelector("#wb-text");
  const addBtn = body.querySelector("#wb-add");
  const dateSlot = body.querySelector("#wb-date");
  const typeBtns = [...body.querySelectorAll("#wb-types .wb-type")];

  let curType = "工作";
  let filter = "全部";
  createDatePicker({ el: dateSlot, value: todayStr() });
  const dateVal = () => (dateSlot.value || todayStr());

  function paintTypeChips() {
    for (const b of typeBtns) {
      const t = b.dataset.type;
      const on = t === curType;
      const c = TYPE_COLOR[t];
      b.classList.toggle("on", on);
      if (on) {
        b.style.color = c;
        b.style.background = c + "2a";
        b.style.borderColor = c + "59";
      } else {
        b.style.color = "";
        b.style.background = "";
        b.style.borderColor = "";
      }
    }
  }

  function paintFilter() {
    const all = state.workLogs || [];
    const counts = typeCounts();
    sideEl.innerHTML = filterCardHTML(counts, filter) + distCardHTML(counts, all.length) + heatCardHTML();
    sideEl.querySelectorAll(".wb-flt").forEach((btn) => {
      btn.addEventListener("click", () => {
        filter = btn.dataset.t;
        renderAll();
      });
    });
  }

  function renderTimeline() {
    tlEl.innerHTML = timelineHTML(filter);
    tlEl.querySelectorAll(".wb-edit").forEach((btn) => {
      btn.addEventListener("click", () => editLog(btn.dataset.id, renderAll));
    });
    tlEl.querySelectorAll(".wb-del").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.workLogs = (state.workLogs || []).filter((w) => w.id !== btn.dataset.id);
        saveState();
        renderAll();
      });
    });
  }

  // 整页重绘：左栏（统计/筛选/热力）与右栏时间线一起刷新
  function renderAll() {
    paintFilter();
    renderTimeline();
  }

  addBtn.addEventListener("click", () => {
    const text = textEl.value.trim();
    if (!text) { textEl.focus(); return; }
    state.workLogs = state.workLogs || [];
    state.workLogs.push({
      id: "wl" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      date: dateVal(),
      type: curType,
      text,
      tags: [],
    });
    saveState();
    textEl.value = "";
    fitTextarea(textEl, INPUT_MAX_H); // 清空后高度回落
    renderAll();
    const day = tlEl.querySelector(".wb-day");
    day?.scrollIntoView({ behavior: "smooth", block: "start" });
    textEl.focus();
  });

  typeBtns.forEach((b) => b.addEventListener("click", () => {
    curType = b.dataset.type;
    paintTypeChips();
  }));

  // 回车 = 换行（默认行为）；Ctrl/Cmd+回车 = 记录（与灵感碎片随手记一致）
  textEl.addEventListener("keydown", (e) => {
    if (e.isComposing || e.key !== "Enter") return;
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      addBtn.click();
      fitTextarea(textEl, INPUT_MAX_H);
    }
    // 其余情况（含 Shift+回车）执行默认换行
  });
  textEl.addEventListener("input", () => fitTextarea(textEl, INPUT_MAX_H));

  // 编辑弹窗：内容 / 日期 / 类型 / 标签（粒度到天，无时分）
  function editLog(id, onDone) {
    const log = (state.workLogs || []).find((w) => w.id === id);
    if (!log) return;
    const ov = document.createElement("div");
    ov.className = "task-modal-overlay";
    ov.innerHTML = `
      <div class="task-modal wl-edit-modal">
        <h3>编辑记录</h3>
        <div class="tm-field"><label>内容</label><textarea id="wl-e-text" rows="6">${esc(log.text)}</textarea></div>
        <div class="tm-field"><label>日期</label><div id="wl-e-date"></div></div>
        <div class="tm-row">
          <div class="tm-field"><label>类型</label><div id="wl-e-type"></div></div>
          <div class="tm-field"><label>标签（逗号分隔）</label><input id="wl-e-tags" type="text" value="${esc((log.tags || []).join(","))}" /></div>
        </div>
        <div class="tm-actions">
          <button class="tm-cancel">取消</button>
          <button class="btn-primary wl-e-ok">保存</button>
        </div>
      </div>`;
    document.body.appendChild(ov);
    createDatePicker({ el: ov.querySelector("#wl-e-date"), value: log.date || "" });
    createSelect({ el: ov.querySelector("#wl-e-type"), value: log.type || "其他", options: LOG_TYPES.map((t) => ({ value: t, label: t })) });
    ov.querySelector(".tm-cancel").addEventListener("click", () => ov.remove());
    ov.querySelector(".wl-e-ok").addEventListener("click", () => {
      const text = ov.querySelector("#wl-e-text").value.trim();
      if (!text) return;
      log.text = text;
      log.date = ov.querySelector("#wl-e-date").value || log.date;
      log.type = ov.querySelector("#wl-e-type").value;
      log.tags = ov.querySelector("#wl-e-tags").value.split(",").map((s) => s.trim()).filter(Boolean);
      saveState();
      ov.remove();
      onDone?.();
    });
    ov.addEventListener("keydown", (e) => { if (e.key === "Escape") ov.remove(); });
  }

  renderAll();
  paintTypeChips();
  view.onDestroy(() => { dateSlot._close?.(); });
}
