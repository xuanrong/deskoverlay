// 提醒功能：时钟块右侧提醒区（每日定时 / 间隔）、到期置顶提醒、配置弹窗。
import { invoke } from "./bus.js";
import { state, saveState } from "./state.js";
import { ICON_CLOCK } from "./icons.js";
import { esc } from "./views/common.js";

const mcReminders = document.getElementById("mc-reminders");

// 渲染时钟块右侧提醒区：纵向列表，启用项 icon+名称+右侧子信息（每日时刻 或 间隔倒计时）
function renderReminders() {
  const active = (state.reminders || []).filter((r) => r.enabled);
  const nowTs = Date.now();
  mcReminders.innerHTML = active.length
    ? active.map((r) => {
        let sub;
        if (r.type === "interval") {
          const interval = (r.intervalMin || 60) * 60000;
          const rem = r.lastAt ? Math.max(0, interval - (nowTs - r.lastAt)) : interval;
          sub = rem >= 60000 ? `${Math.ceil(rem / 60000)}m` : `${Math.max(1, Math.ceil(rem / 1000))}s`;
        } else {
          sub = r.time || "--:--";
        }
        return `
      <div class="mc-rem-row" data-id="${esc(r.id)}" title="${esc(r.label)} · ${esc(sub)}">
        <span class="mc-rem-icon">${r.icon}</span>
        <span class="mc-rem-label">${esc(r.label)}</span>
        <span class="mc-rem-time">${esc(sub)}</span>
      </div>`;
      }).join("")
    : `<div class="mc-rem-row mc-rem-empty" title="提醒设置"><span class="mc-rem-icon">${ICON_CLOCK}</span><span class="mc-rem-label">提醒设置</span></div>`;
  mcReminders.querySelectorAll(".mc-rem-row").forEach((b) => b.addEventListener("click", openReminderSettings));
}

// 每秒检查：daily 到 HH:MM 触发（当日防重复）；interval 滚动计时（lastAt + 间隔）
function checkReminders() {
  const now = new Date();
  const cur = String(now.getHours()).padStart(2, "0") + ":" + String(now.getMinutes()).padStart(2, "0");
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const ts = now.getTime();
  let changed = false;
  for (const r of state.reminders || []) {
    if (!r.enabled) continue;
    if (r.type === "interval") {
      const interval = (r.intervalMin || 60) * 60000;
      if (!r.lastAt) { r.lastAt = ts; changed = true; continue; } // 首次启用/重启后从当前时刻开始计时
      if (ts - r.lastAt >= interval) {
        r.lastAt = ts;
        changed = true;
        showReminderToast(r);
      }
    } else {
      if (!r.time) continue;
      if (r.time === cur && r.lastTriggeredDate !== today) {
        r.lastTriggeredDate = today;
        changed = true;
        showReminderToast(r);
      }
    }
  }
  if (changed) saveState();
}

// 提醒弹卡：桌面态用系统级置顶窗口（盖住浏览器等）；浏览器开发态用页面内 toast
function showReminderToast(r) {
  const isInterval = r.type === "interval";
  const detail = isInterval ? `已到间隔 ${r.intervalMin || 60} 分钟` : `已到 ${r.time || "--:--"}`;
  const msg = detail + "，该处理一下了";
  if (window.__TAURI__) {
    invoke("show_reminder", { icon: r.icon, title: `${r.label}提醒`, message: msg });
    return;
  }
  const t = document.createElement("div");
  t.className = "rm-toast";
  t.innerHTML = `
    <span class="rm-toast-icon">${r.icon}</span>
    <div class="rm-toast-body">
      <b>${esc(r.label)}提醒</b>
      <span>${esc(msg)}</span>
    </div>
    <button class="rm-toast-ok">知道了</button>`;
  document.body.appendChild(t);
  requestAnimationFrame(() => t.classList.add("show"));
  const close = () => { t.classList.remove("show"); setTimeout(() => t.remove(), 300); };
  t.querySelector(".rm-toast-ok").addEventListener("click", close);
  t.addEventListener("click", (e) => { if (e.target === t) close(); });
  clearTimeout(t._timer);
  t._timer = setTimeout(close, 8000);
}

// 提醒配置弹窗：增删提醒 / 启停 / 名称与类型/时刻/间隔
function openReminderSettings() {
  if (document.getElementById("rm-modal")) return;
  const ov = document.createElement("div");
  ov.id = "rm-modal";
  ov.className = "task-modal-overlay";
  ov.innerHTML = `
    <div class="task-modal remind-modal">
      <h3>提醒设置</h3>
      <div class="rm-list" id="rm-list"></div>
      <div class="rm-add"><button class="tm-cancel" id="rm-add-btn">+ 添加提醒</button></div>
      <div class="tm-actions"><button class="btn-primary cm-ok" id="rm-done">完成</button></div>
    </div>`;
  document.body.appendChild(ov);
  const list = ov.querySelector("#rm-list");

  function renderRows() {
    list.innerHTML = (state.reminders || []).map((r, i) => {
      const isInterval = r.type === "interval";
      return `
      <div class="rm-row">
        <span class="rm-icon">${r.icon}</span>
        <input class="rm-name" data-i="${i}" value="${esc(r.label)}" placeholder="提醒名称" />
        <select class="rm-type" data-i="${i}">
          <option value="daily"${isInterval ? "" : " selected"}>每日定时</option>
          <option value="interval"${isInterval ? " selected" : ""}>间隔</option>
        </select>
        <input class="rm-time" type="time" data-i="${i}" value="${esc(r.time || "")}" title="每日触发时刻" ${isInterval ? "style='display:none'" : ""} />
        <span class="rm-int-wrap" data-i="${i}" ${isInterval ? "" : "style='display:none'"}>
          <input class="rm-int" type="number" min="1" max="1440" data-i="${i}" value="${r.intervalMin || 60}" title="间隔（分钟）" />
          <span class="rm-unit">分</span>
        </span>
        <label class="rm-toggle"><input type="checkbox" data-i="${i}" ${r.enabled ? "checked" : ""} /><span>启用</span></label>
        <button class="rm-del" data-i="${i}" title="删除">✕</button>
      </div>`;
    }).join("");

    list.querySelectorAll(".rm-name").forEach((el) => {
      el.addEventListener("change", () => {
        const r = state.reminders[el.dataset.i];
        if (r && el.value.trim()) r.label = el.value.trim();
        saveState();
      });
    });
    list.querySelectorAll(".rm-type").forEach((el) => {
      el.addEventListener("change", () => {
        const r = state.reminders[el.dataset.i];
        if (!r) return;
        r.type = el.value;
        saveState();
        renderRows();
      });
    });
    list.querySelectorAll(".rm-time").forEach((el) => {
      el.addEventListener("change", () => {
        const r = state.reminders[el.dataset.i];
        if (!r) return;
        r.time = el.value || "";
        saveState();
      });
    });
    list.querySelectorAll(".rm-int").forEach((el) => {
      el.addEventListener("change", () => {
        const r = state.reminders[el.dataset.i];
        if (!r) return;
        r.intervalMin = Math.max(1, Math.min(1440, parseInt(el.value, 10) || 60));
        el.value = r.intervalMin;
        saveState();
      });
    });
    list.querySelectorAll(".rm-toggle input").forEach((el) => {
      el.addEventListener("change", () => {
        const r = state.reminders[el.dataset.i];
        if (!r) return;
        r.enabled = el.checked;
        saveState();
      });
    });
    list.querySelectorAll(".rm-del").forEach((el) => {
      el.addEventListener("click", () => {
        state.reminders.splice(el.dataset.i, 1);
        saveState();
        renderRows();
      });
    });
  }

  ov.querySelector("#rm-add-btn").addEventListener("click", () => {
    state.reminders.push({ id: "r" + Date.now().toString(36), label: "新提醒", icon: ICON_CLOCK, type: "daily", time: "09:00", intervalMin: 60, enabled: true, lastAt: 0, lastTriggeredDate: "" });
    saveState();
    renderRows();
  });
  ov.querySelector("#rm-done").addEventListener("click", () => ov.remove());
  ov.addEventListener("click", (e) => { if (e.target === ov) ov.remove(); });
  ov.addEventListener("keydown", (e) => { if (e.key === "Escape") ov.remove(); });

  renderRows();
}

/// 初始化提醒：渲染时钟块倒计时 + 每秒检查。
export function initReminders() {
  renderReminders();
  setInterval(() => { checkReminders(); renderReminders(); }, 1000);
}
