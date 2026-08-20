// 工作记录视图：按天分组的垂直时间线，可填写/编辑/删除记录。
import { state, saveState } from "../state.js";
import { esc } from "./common.js";
import { createDatePicker } from "../datepicker.js";
import { createSelect } from "../selectbox.js";

// 记录类型 → 中文标签 + 颜色类
const LOG_TYPES = ["工作", "会议", "学习", "生活", "其他"];
const TYPE_CLASS = { 工作: "work", 会议: "meet", 学习: "study", 生活: "life", 其他: "other" };

// 当天日期 YYYY-MM-DD（本地时区）
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// 日期标题：今天/昨天 + 周几；其他日期显示「M月D日 · 周X」（跨年加年份）
function dateTitle(dateStr) {
  if (!dateStr) return "";
  const today = todayStr();
  const y = new Date();
  y.setDate(y.getDate() - 1);
  const yest = `${y.getFullYear()}-${String(y.getMonth() + 1).padStart(2, "0")}-${String(y.getDate()).padStart(2, "0")}`;
  const d = new Date(dateStr + "T00:00:00");
  if (isNaN(d)) return dateStr;
  const week = ["日", "一", "二", "三", "四", "五", "六"][d.getDay()];
  if (dateStr === today) return `今天 · 周${week}`;
  if (dateStr === yest) return `昨天 · 周${week}`;
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return (sameYear ? "" : `${d.getFullYear()}年`) + `${d.getMonth() + 1}月${d.getDate()}日 · 周${week}`;
}

// 单条时间线条目
function logItem(log) {
  const tc = TYPE_CLASS[log.type] || "other";
  return `
    <div class="wl-item" data-id="${esc(log.id)}">
      <div class="wl-dot wl-dot-${tc}"></div>
      <div class="wl-body">
        <div class="wl-text">${esc(log.text)}</div>
        <div class="wl-meta">
          <span class="wl-type wl-type-${tc}">${esc(log.type || "其他")}</span>
          ${log.tags && log.tags.length ? `<span class="wl-tags">${log.tags.map((t) => `#${esc(t)}`).join(" ")}</span>` : ""}
        </div>
      </div>
      <div class="wl-actions">
        <button class="wl-edit" data-id="${esc(log.id)}" title="编辑">编辑</button>
        <button class="wl-del" data-id="${esc(log.id)}" title="删除">✕</button>
      </div>
    </div>`;
}

// 按日期分组（最近在前），同日内新记录在前
function groupByDay() {
  const map = new Map();
  for (const log of state.workLogs || []) {
    const date = log.date || todayStr();
    if (!map.has(date)) map.set(date, []);
    map.get(date).push(log);
  }
  return [...map.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([date, list]) => [date, list.slice().reverse()]);
}

export function renderWorkLog(view) {
  view.header.style.display = "none";
  const body = view.body;
  body.innerHTML = `
    <div class="wl-form">
      <textarea id="wl-text" rows="2" placeholder="记录一条工作，Ctrl+Enter 提交…"></textarea>
      <div class="wl-form-foot">
        <div class="wl-form-row">
          <label>日期 <span id="wl-date"></span></label>
          <label>类型 <span id="wl-type"></span></label>
        </div>
        <button class="btn-primary wl-add" id="wl-add">添加记录</button>
      </div>
    </div>
    <div class="wl-timeline" id="wl-timeline"></div>`;

  const dateEl = body.querySelector("#wl-date");
  const typeEl = body.querySelector("#wl-type");
  const textEl = body.querySelector("#wl-text");
  const addBtn = body.querySelector("#wl-add");
  const timelineEl = body.querySelector("#wl-timeline");

  // 日期输入：自定义日期控件（替代原生 date 输入，规避 WebView2 占位文字问题）；默认今天
  createDatePicker({ el: dateEl, value: todayStr() });
  // 类型下拉：自定义选择控件
  createSelect({ el: typeEl, value: "工作", options: LOG_TYPES.map((t) => ({ value: t, label: t })) });

  function render() {
    const days = groupByDay();
    if (!days.length) {
      timelineEl.innerHTML = `<div class="dash-empty">还没有记录，填写上方表单开始记录吧</div>`;
      return;
    }
    timelineEl.innerHTML = days.map(([date, list]) => `
      <div class="wl-day">
        <div class="wl-day-head"><span class="wl-day-title">${esc(dateTitle(date))}</span><span class="wl-day-date">${esc(date)}</span><span class="wl-day-count">${list.length} 条</span></div>
        <div class="wl-day-items">${list.map(logItem).join("")}</div>
      </div>`).join("");

    timelineEl.querySelectorAll(".wl-edit").forEach((btn) => {
      btn.addEventListener("click", () => editLog(btn.dataset.id, render));
    });
    timelineEl.querySelectorAll(".wl-del").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.workLogs = (state.workLogs || []).filter((w) => w.id !== btn.dataset.id);
        saveState();
        render();
      });
    });
  }

  addBtn.addEventListener("click", () => {
    const text = textEl.value.trim();
    if (!text) { textEl.focus(); return; }
    state.workLogs = state.workLogs || [];
    state.workLogs.push({
      id: "wl" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      date: dateEl.value || todayStr(),
      type: typeEl.value,
      text,
      tags: [],
    });
    saveState();
    textEl.value = "";
    // 滚动到刚添加的当天
    render();
    const day = timelineEl.querySelector(".wl-day");
    day?.scrollIntoView({ behavior: "smooth", block: "start" });
    body.scrollTop = 0;
    textEl.focus();
  });

  // 回车换行（textarea 默认）；Ctrl/Cmd+回车快速添加
  textEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); addBtn.click(); }
  });

  // 编辑弹窗：内容 / 类型 / 日期 / 标签
  function editLog(id, onDone) {
    const log = (state.workLogs || []).find((w) => w.id === id);
    if (!log) return;
    const ov = document.createElement("div");
    ov.className = "task-modal-overlay";
    ov.innerHTML = `
      <div class="task-modal wl-edit-modal">
        <h3>编辑记录</h3>
        <div class="tm-field"><label>内容</label><textarea id="wl-e-text" rows="6">${esc(log.text)}</textarea></div>
        <div class="tm-row">
          <div class="tm-field"><label>日期</label><div id="wl-e-date"></div></div>
          <div class="tm-field"><label>类型</label><div id="wl-e-type"></div></div>
        </div>
        <div class="tm-field"><label>标签（逗号分隔）</label><input id="wl-e-tags" type="text" value="${esc((log.tags || []).join(","))}" /></div>
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

  render();
  view.onDestroy(() => { dateEl._close?.(); typeEl._close?.(); });
}
