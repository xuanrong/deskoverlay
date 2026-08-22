// 提醒功能：时钟块右侧提醒区（每日定时 / 间隔）、到期置顶提醒、配置弹窗。
import { invoke, Heartbeat } from "./bus.js";
import { state, saveState } from "./state.js";
import { ICON_CLOCK, ICON_WATER } from "./icons.js";
import { esc } from "./views/common.js";

const mcReminders = document.getElementById("mc-reminders");

// 将久坐配置推送到后端（监控线程据此启停与计时）。
// 注意：参数名用 intervalMin（camelCase）——Tauri v2 将 Rust 的 interval_min 转成
// camelCase 暴露给 JS，传 interval_min 会导致命令报「missing required key intervalMin」而失效。
async function pushSedentaryConfig() {
  const s = state.sedentary || { enabled: false, intervalMin: 45 };
  try {
    await invoke("set_sedentary_config", {
      enabled: !!s.enabled,
      intervalMin: s.intervalMin || 45,
    });
  } catch (e) {
    console.warn("[sedentary] 配置推送失败", e);
  }
}

// 久坐提醒图标（线性 SVG，currentColor）
// viewBox 向下偏移 2.75 单位，让小人图形在容器内垂直居中
const ICON_STRETCH = `<svg viewBox="0 -2.75 24 24"><circle cx="12" cy="4.5" r="2"/><path d="M12 7.5v4"/><path d="M8.5 9.5 12 7.5l3.5 2"/><path d="M12 11.5 8.5 16"/><path d="M12 11.5 15.5 15"/></svg>`;

// 距下次触发的剩余毫秒（用于「按临近时间排序」）。
// daily：到今天 HH:MM 的剩余时间（已过则计入明天）；interval：剩余倒计时；无时间信息返回 Infinity。
function approachingMs(r, nowTs) {
  if (r.type === "interval") {
    const interval = (r.intervalMin || 60) * 60000;
    return r.lastAt ? Math.max(0, interval - (nowTs - r.lastAt)) : interval;
  }
  if (!r.time) return Infinity;
  const [h, m] = r.time.split(":").map(Number);
  const t = new Date();
  t.setHours(h, m, 0, 0);
  let diff = t.getTime() - nowTs;
  if (diff <= 0) diff += 24 * 3600 * 1000;
  return diff;
}

// 渲染时钟块右侧提醒区：最多 3 行，按「距下次触发时间」升序（临近者在前）。
// 久坐/喝水提醒无前端倒计时，固定置顶以保证可见；其余定时提醒按临近时间排序，取满 3 行为止。
function renderReminders() {
  const nowTs = Date.now();
  const MAX_ROWS = 3;
  const rows = [];
  if (state.sedentary && state.sedentary.enabled) {
    rows.push({
      id: "sedentary",
      icon: ICON_STRETCH,
      label: "久坐提醒",
      sub: `${state.sedentary.intervalMin || 45}m`,
      pinned: true,
      sed: true,
    });
  }
  if (state.water && state.water.enabled) {
    const interval = (state.water.intervalMin || 90) * 60000;
    const rem = state.waterLastAt ? Math.max(0, interval - (nowTs - state.waterLastAt)) : interval;
    const sub = rem >= 60000 ? `${Math.ceil(rem / 60000)}m` : `${Math.max(1, Math.ceil(rem / 1000))}s`;
    rows.push({
      id: "water",
      icon: ICON_WATER,
      label: "喝水",
      sub,
      pinned: true,
      water: true,
    });
  }
  const active = (state.reminders || [])
    .filter((r) => r.enabled)
    .map((r) => {
      const sub = r.time || "--:--";
      return { id: r.id, icon: r.icon, label: r.label, sub, key: approachingMs(r, nowTs) };
    })
    .sort((a, b) => a.key - b.key);
  for (const r of active) {
    if (rows.length >= MAX_ROWS) break;
    rows.push(r);
  }
  mcReminders.innerHTML = rows.length
    ? rows.map((r) => `
      <div class="mc-rem-row${r.sed ? " mc-rem-sed" : ""}${r.water ? " mc-rem-water" : ""}" data-id="${esc(r.id)}" title="${esc(r.label)} · ${esc(r.sub)}">
        <span class="mc-rem-icon">${r.icon}</span>
        <span class="mc-rem-label">${esc(r.label)}</span>
        <span class="mc-rem-time">${esc(r.sub)}</span>
      </div>`).join("")
    : `<div class="mc-rem-row mc-rem-empty" title="提醒设置"><span class="mc-rem-icon">${ICON_CLOCK}</span><span class="mc-rem-label">提醒设置</span></div>`;
  mcReminders.querySelectorAll(".mc-rem-row").forEach((b) => b.addEventListener("click", openReminderSettings));
}

// 每秒增量更新：仅刷新间隔项的倒计时文本（不重建 DOM，避免时钟块闪烁）
function updateReminders() {
  const nowTs = Date.now();
  mcReminders.querySelectorAll(".mc-rem-row").forEach((row) => {
    const id = row.dataset.id;
    // 喝水倒计时
    if (id === "water" && state.water && state.water.enabled) {
      const interval = (state.water.intervalMin || 90) * 60000;
      const rem = state.waterLastAt ? Math.max(0, interval - (nowTs - state.waterLastAt)) : interval;
      const sub = rem >= 60000 ? `${Math.ceil(rem / 60000)}m` : `${Math.max(1, Math.ceil(rem / 1000))}s`;
      const timeEl = row.querySelector(".mc-rem-time");
      if (timeEl && timeEl.textContent !== sub) timeEl.textContent = sub;
      return;
    }
    // 通用间隔提醒倒计时
    const r = (state.reminders || []).find((x) => x.id === id && x.enabled && x.type === "interval");
    if (!r) return;
    const interval = (r.intervalMin || 60) * 60000;
    const rem = r.lastAt ? Math.max(0, interval - (nowTs - r.lastAt)) : interval;
    const sub = rem >= 60000 ? `${Math.ceil(rem / 60000)}m` : `${Math.max(1, Math.ceil(rem / 1000))}s`;
    const timeEl = row.querySelector(".mc-rem-time");
    if (timeEl && timeEl.textContent !== sub) timeEl.textContent = sub;
  });
}

// 每秒检查：daily 到 HH:MM 触发（当日防重复）；喝水滚动计时
function checkReminders() {
  const now = new Date();
  const cur = String(now.getHours()).padStart(2, "0") + ":" + String(now.getMinutes()).padStart(2, "0");
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const ts = now.getTime();
  let changed = false;

  // 喝水提醒
  if (state.water && state.water.enabled) {
    const interval = (state.water.intervalMin || 90) * 60000;
    if (!state.waterLastAt) { state.waterLastAt = ts; changed = true; }
    else if (ts - state.waterLastAt >= interval) {
      state.waterLastAt = ts;
      changed = true;
      showReminderToast({ label: "喝水", icon: ICON_WATER, type: "interval", intervalMin: state.water.intervalMin || 90 });
    }
  }

  // 通用提醒
  for (const r of state.reminders || []) {
    if (!r.enabled) continue;
    if (r.type === "interval") {
      const interval = (r.intervalMin || 60) * 60000;
      if (!r.lastAt) { r.lastAt = ts; changed = true; continue; }
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
  const isWater = r.label === "喝水";
  const msg = isWater
    ? "辛苦啦，起身喝杯温水，润润嗓子吧"
    : r.type === "interval"
    ? `已到「${r.label}」的间隔时间，休息一下再去处理吧`
    : `「${r.label}」时间到了，去准备一下吧`;
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

// 提醒配置弹窗：增删提醒 / 启停 / 名称与时刻
function openReminderSettings() {
  if (document.getElementById("rm-modal")) return;
  const ov = document.createElement("div");
  ov.id = "rm-modal";
  ov.className = "task-modal-overlay";
  const sed = state.sedentary || { enabled: false, intervalMin: 45 };
  const water = state.water || { enabled: false, intervalMin: 90 };
  ov.innerHTML = `
    <div class="task-modal remind-modal">
      <h3>提醒设置</h3>
      <div class="sed-section" id="sed-section">
        <div class="sed-head">
          <span class="sed-title">久坐提醒</span>
          <label class="rm-toggle"><input type="checkbox" id="sed-enable" ${sed.enabled ? "checked" : ""}/><span>启用</span></label>
        </div>
        <div class="sed-body">
          <span>连续使用</span>
          <input class="sed-int" id="sed-int" type="number" min="1" max="240" value="${sed.intervalMin || 45}" />
          <span>分钟后提醒（离开 ≥3 分钟视为休息，重新计时）</span>
        </div>
      </div>
      <div class="water-section" id="water-section">
        <div class="sed-head">
          <span class="sed-title">喝水提醒</span>
          <label class="rm-toggle"><input type="checkbox" id="water-enable" ${water.enabled ? "checked" : ""}/><span>启用</span></label>
        </div>
        <div class="sed-body">
          <span>每</span>
          <input class="sed-int" id="water-int" type="number" min="1" max="480" value="${water.intervalMin || 90}" />
          <span>分钟提醒一次</span>
        </div>
      </div>
      <div class="rm-list" id="rm-list"></div>
      <div class="rm-add"><button class="tm-cancel" id="rm-add-btn">+ 添加提醒</button></div>
      <div class="tm-actions"><button class="btn-primary cm-ok" id="rm-done">完成</button></div>
    </div>`;
  document.body.appendChild(ov);
  const list = ov.querySelector("#rm-list");

  // 久坐提醒：开关 + 间隔（变更即推送后端并刷新时钟块指示）
  const sedEnable = ov.querySelector("#sed-enable");
  const sedInt = ov.querySelector("#sed-int");
  if (sedEnable) sedEnable.addEventListener("change", () => {
    if (!state.sedentary) state.sedentary = { enabled: false, intervalMin: 45 };
    state.sedentary.enabled = sedEnable.checked;
    saveState();
    pushSedentaryConfig();
    renderReminders();
  });
  if (sedInt) sedInt.addEventListener("change", () => {
    if (!state.sedentary) state.sedentary = { enabled: false, intervalMin: 45 };
    state.sedentary.intervalMin = Math.max(1, Math.min(240, parseInt(sedInt.value, 10) || 45));
    sedInt.value = state.sedentary.intervalMin;
    saveState();
    pushSedentaryConfig();
    renderReminders();
  });

  // 喝水提醒：开关 + 间隔
  const waterEnable = ov.querySelector("#water-enable");
  const waterInt = ov.querySelector("#water-int");
  if (waterEnable) waterEnable.addEventListener("change", () => {
    if (!state.water) state.water = { enabled: false, intervalMin: 90 };
    state.water.enabled = waterEnable.checked;
    if (state.water.enabled && !state.waterLastAt) state.waterLastAt = Date.now();
    saveState();
    renderReminders();
  });
  if (waterInt) waterInt.addEventListener("change", () => {
    if (!state.water) state.water = { enabled: false, intervalMin: 90 };
    state.water.intervalMin = Math.max(1, Math.min(480, parseInt(waterInt.value, 10) || 90));
    waterInt.value = state.water.intervalMin;
    saveState();
    renderReminders();
  });

  function renderRows() {
    list.innerHTML = (state.reminders || []).map((r, i) => {
      return `
      <div class="rm-row">
        <span class="rm-icon">${r.icon}</span>
        <input class="rm-name" data-i="${i}" value="${esc(r.label)}" placeholder="提醒名称" />
        <input class="rm-time" type="time" data-i="${i}" value="${esc(r.time || "")}" title="每日触发时刻" />
        <label class="rm-toggle"><input type="checkbox" data-i="${i}" ${r.enabled ? "checked" : ""} /><span>启用</span></label>
        <button class="rm-del" data-i="${i}" title="删除">✕</button>
      </div>`;
    }).join("");

    list.querySelectorAll(".rm-name").forEach((el) => {
      el.addEventListener("change", () => {
        const r = state.reminders[el.dataset.i];
        if (r && el.value.trim()) r.label = el.value.trim();
        saveState();
        renderReminders();
      });
    });
    list.querySelectorAll(".rm-time").forEach((el) => {
      el.addEventListener("change", () => {
        const r = state.reminders[el.dataset.i];
        if (!r) return;
        r.time = el.value || "";
        saveState();
        renderReminders();
      });
    });
    list.querySelectorAll(".rm-toggle input").forEach((el) => {
      el.addEventListener("change", () => {
        const r = state.reminders[el.dataset.i];
        if (!r) return;
        r.enabled = el.checked;
        saveState();
        renderReminders();
      });
    });
    list.querySelectorAll(".rm-del").forEach((el) => {
      el.addEventListener("click", () => {
        state.reminders.splice(el.dataset.i, 1);
        saveState();
        renderRows();
        renderReminders();
      });
    });
  }

  ov.querySelector("#rm-add-btn").addEventListener("click", () => {
    state.reminders.push({ id: "r" + Date.now().toString(36), label: "新提醒", icon: ICON_CLOCK, type: "daily", time: "09:00", enabled: true, lastTriggeredDate: "" });
    saveState();
    renderRows();
    renderReminders();
  });
  ov.querySelector("#rm-done").addEventListener("click", () => ov.remove());
  ov.addEventListener("click", (e) => { if (e.target === ov) ov.remove(); });
  ov.addEventListener("keydown", (e) => { if (e.key === "Escape") ov.remove(); });

  renderRows();
}

/// 初始化提醒：渲染时钟块倒计时 + 推送久坐配置 + 每秒增量检查（走统一秒级心跳）。
export function initReminders() {
  renderReminders();
  pushSedentaryConfig();
  Heartbeat.on(() => { checkReminders(); updateReminders(); });
}
