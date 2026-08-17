// 面板内容渲染器 — 每种面板类型一个渲染函数，订阅对应 Provider 事件并增量更新 DOM。
// 渲染器与数据解耦: 只通过 Bus('provider-emit') 接收数据，符合文档 §6 数据契约。
import { Bus } from "./bus.js";
import { Tasks } from "./tasks.js";
import { Store } from "./store.js";
import { MODES, STATUS_LABEL, TASK_STATUSES } from "./config.js";

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
}

// -------------------- 今日概览 (Dashboard / pro) --------------------
function renderDashboard(panel) {
  const body = panel.body;
  body.innerHTML = `
    <div class="clock-greet" id="d-greet">你好</div>
    <div class="clock-time" id="d-time">--:--:--</div>
    <div class="clock-date" id="d-date"></div>
    <div class="clock-mode" id="d-mode"><span class="mb-dot" style="width:8px;height:8px;border-radius:50%;background:var(--green)"></span><span id="d-mode-t">Coding Mode</span></div>
    <div class="task-stats" style="margin-top:14px" id="d-stats"></div>`;

  const greet = body.querySelector("#d-greet");
  const time = body.querySelector("#d-time");
  const date = body.querySelector("#d-date");
  const modeT = body.querySelector("#d-mode-t");
  const stats = body.querySelector("#d-stats");

  const off1 = Bus.on("provider-emit", ({ config_hash, output }) => {
    if (config_hash !== "clock") return;
    greet.textContent = output.greet + "，开发者";
    time.textContent = output.time;
    date.textContent = output.date;
  });
  const off2 = Bus.on("mode-changed", ({ label }) => { modeT.textContent = label; });
  const off3 = Bus.on("tasks-changed", renderStats);
  function renderStats() {
    const s = Tasks.stats();
    stats.innerHTML = `今日任务 <b>${s.done}</b>/<b>${s.total}</b> 已完成 · 剩 <b>${s.remain}</b>`;
  }
  renderStats();
  panel.onDestroy(() => { off1(); off2(); off3(); });
}

// -------------------- 系统监控 --------------------
function renderSystem(panel) {
  const body = panel.body;
  body.innerHTML = `
    <div class="kpi-grid">
      ${metric("cpu", "CPU", "%")}
      ${metric("ram", "内存", "GB")}
      ${metric("net", "网络 ↓/↑", "MB/s")}
      ${metric("bat", "电量", "%")}
    </div>`;

  const refs = {
    cpu: mref(body, "cpu"), ram: mref(body, "ram"),
    net: mref(body, "net"), bat: mref(body, "bat"),
  };

  const off = Bus.on("provider-emit", ({ config_hash, output }) => {
    if (config_hash !== "system") return;
    setBar(refs.cpu, output.cpu, output.cpu.toFixed(0) + "<small>%</small>", 100);
    setBar(refs.ram, output.ram, `${output.ramUsedGb}<small>/${output.ramTotalGb}GB</small>`, 100);
    refs.net.value.innerHTML = `<small>↓</small>${output.netDown} <small>↑</small>${output.netUp}`;
    refs.net.bar.style.width = Math.min(100, (output.netDown / 40) * 100) + "%";
    refs.net.barWrap.className = "bar";
    setBar(refs.bat, output.battery, output.battery + "<small>% · " + output.power + "</small>", 100);
  });
  panel.onDestroy(off);
}
function metric(id, label, unit) {
  return `<div class="metric" data-m="${id}">
    <div class="m-label"><span>${label}</span></div>
    <div class="m-value" data-v="${id}">--</div>
    <div class="bar" data-bar="${id}"><i></i></div>
  </div>`;
}
function mref(body, id) {
  return {
    value: body.querySelector(`[data-v="${id}"]`),
    bar: body.querySelector(`[data-bar="${id}"] i`),
    barWrap: body.querySelector(`[data-bar="${id}"]`),
  };
}
function setBar(ref, pct, html, max) {
  ref.value.innerHTML = html;
  const p = Math.min(100, (pct / max) * 100);
  ref.bar.style.width = p + "%";
  ref.barWrap.className = "bar" + (p >= 85 ? " crit" : p >= 65 ? " warn" : "");
}

// -------------------- 开发者任务 --------------------
function renderTasks(panel) {
  const body = panel.body;
  body.innerHTML = `
    <div class="task-stats" id="t-stats"></div>
    <div class="task-input-row">
      <input id="t-input" placeholder="添加任务…  回车确认" />
      <button class="btn-primary" id="t-add">添加</button>
    </div>
    <div id="t-list"></div>`;

  const input = body.querySelector("#t-input");
  const list = body.querySelector("#t-list");
  const statsEl = body.querySelector("#t-stats");

  function add() {
    const v = input.value.trim();
    if (!v) return;
    Tasks.add({ text: v });
    input.value = "";
  }
  body.querySelector("#t-add").addEventListener("click", add);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") add(); });

  function renderList() {
    const tasks = Tasks.list();
    list.innerHTML = "";
    if (!tasks.length) {
      list.innerHTML = `<div style="color:var(--text-faint);font-size:12.5px;padding:10px 2px">暂无任务，添加你的第一条开发任务。</div>`;
    }
    for (const t of tasks) {
      const row = el("div", "task" + (t.done ? " done" : ""));
      row.innerHTML = `
        <div class="chk" title="切换完成">${t.done ? "✓" : ""}</div>
        <div class="t-main">
          <div class="t-text">${esc(t.text)}</div>
          <div class="t-meta">
            <span class="status-pill st-${t.status}" data-status>${STATUS_LABEL[t.status]}</span>
            ${t.project ? `<span class="tag proj">${esc(t.project)}</span>` : ""}
            ${t.due ? `<span class="tag due">📅 ${esc(t.due)}</span>` : ""}
          </div>
        </div>
        <button class="t-del" title="删除">✕</button>`;
      row.querySelector(".chk").addEventListener("click", () => Tasks.toggle(t.id));
      row.querySelector(".t-del").addEventListener("click", () => Tasks.remove(t.id));
      const pill = row.querySelector("[data-status]");
      pill.addEventListener("click", () => {
        const idx = TASK_STATUSES.indexOf(t.status);
        Tasks.setStatus(t.id, TASK_STATUSES[(idx + 1) % TASK_STATUSES.length]);
      });
      list.appendChild(row);
    }
    const s = Tasks.stats();
    statsEl.innerHTML = `共 <b>${s.total}</b> · 已完成 <b>${s.done}</b> · 进行中 <b>${s.remain}</b>`;
  }

  const off = Bus.on("tasks-changed", renderList);
  renderList();
  panel.onDestroy(off);
}

// -------------------- 天气 --------------------
function renderWeather(panel) {
  const body = panel.body;
  const off = Bus.on("provider-emit", ({ config_hash, output }) => {
    if (config_hash !== "weather") return;
    body.innerHTML = `
      <div class="wx-now">
        <div style="font-size:44px">${output.icon}</div>
        <div>
          <div class="wx-temp">${output.now}°</div>
          <div class="wx-meta">${esc(output.city)} · ${esc(output.cond)}</div>
        </div>
      </div>
      <div class="wx-forecast">
        ${output.forecast.map((f) => `
          <div class="wx-day"><div class="d">${f.d}</div><div style="font-size:18px">${f.i}</div><div class="t">${f.t}</div></div>`).join("")}
      </div>`;
  });
  panel.onDestroy(off);
}

// -------------------- 日历 --------------------
function renderCalendar(panel) {
  const body = panel.body;
  const WD = ["日", "一", "二", "三", "四", "五", "六"];

  function dueDays() {
    const set = new Set();
    for (const t of Tasks.list()) {
      if (t.due) { const d = new Date(t.due); if (!isNaN(d)) set.add(d.getFullYear() + "-" + d.getMonth() + "-" + d.getDate()); }
    }
    return set;
  }

  function render(refDate) {
    const y = refDate.getFullYear(), m = refDate.getMonth();
    const first = new Date(y, m, 1);
    const startWd = first.getDay();
    const days = new Date(y, m + 1, 0).getDate();
    const todayStr = new Date().getFullYear() + "-" + new Date().getMonth() + "-" + new Date().getDate();
    const due = dueDays();

    let cells = "";
    for (let i = 0; i < startWd; i++) cells += `<div class="cal-cell muted"></div>`;
    for (let d = 1; d <= days; d++) {
      const key = y + "-" + m + "-" + d;
      const cls = "cal-cell" + (key === todayStr ? " today" : "") + (due.has(key) ? " has" : "");
      cells += `<div class="${cls}">${d}</div>`;
    }
    body.innerHTML = `
      <div class="cal-head">
        <div class="m">${y} 年 ${m + 1} 月</div>
        <div style="font-size:11px;color:var(--text-faint)">● 有截止任务</div>
      </div>
      <div class="cal-grid">
        ${WD.map((w) => `<div class="wd">${w}</div>`).join("")}
        ${cells}
      </div>`;
  }
  render(new Date());
  const off = Bus.on("tasks-changed", () => render(new Date()));
  panel.onDestroy(off);
}

// -------------------- 项目监控 (模拟) --------------------
function renderProjects(panel) {
  const body = panel.body;
  const rows = [
    { k: "当前项目", v: "desk-overlay", c: "state-run" },
    { k: "Git 分支", v: "main ✓ clean", c: "state-ok" },
    { k: "构建 Build", v: "成功", c: "state-ok" },
    { k: "本地服务", v: "运行中", c: "state-run" },
    { k: "Docker", v: "3 容器", c: "state-warn" },
  ];
  body.innerHTML = rows.map((r) =>
    `<div class="proj-row"><span class="k">${r.k}</span><span class="proj-state ${r.c}">${r.v}</span></div>`).join("");
}

// -------------------- 速记 --------------------
function renderNotes(panel) {
  const body = panel.body;
  let saved = Store.load();
  body.innerHTML = `
    <textarea class="notes-area" id="n-area" placeholder="随手记录灵感、会议纪要…"></textarea>
    <div class="notes-saved" id="n-saved"></div>`;
  const area = body.querySelector("#n-area");
  const savedEl = body.querySelector("#n-saved");
  area.value = saved.notes || "";

  let timer;
  area.addEventListener("input", () => {
    savedEl.textContent = "编辑中…";
    clearTimeout(timer);
    timer = setTimeout(() => {
      saved = Store.load();
      saved.notes = area.value;
      Store.save(saved);
      savedEl.textContent = "已保存 " + new Date().toLocaleTimeString("zh-CN", { hour12: false });
    }, 500);
  });
}

export const PANEL_RENDERERS = {
  dashboard: renderDashboard,
  system: renderSystem,
  tasks: renderTasks,
  weather: renderWeather,
  calendar: renderCalendar,
  projects: renderProjects,
  notes: renderNotes,
};
