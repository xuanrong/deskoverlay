// 全局护眼 —— 顶栏状态胶囊。
//
// 定位：常驻时钟条（#main-clock）的护眼入口，与番茄钟胶囊并列。
// 交互与番茄钟保持一致（点击开关、右键/点击展开浮层），避免两套交互语言。
//
// 为什么需要胶囊而不是只靠设置页：
//   护眼是「随时想开就开、想关就关」的高频操作（例如临时修图要关掉），
//   埋进设置页要三次点击；胶囊一次点击即可，且常驻显示当前色温，
//   用户随时知道屏幕为什么偏暖。
import { state } from "./state.js";
import { esc } from "./utils.js";
import { toast } from "./toast.js";
import {
  setEyeCare, toggleEyeCare, restoreNativeColor,
  refreshEyeCareStatus, onEyeCareChange, getEyeCareStatus,
} from "./eyeCare.js";
import { ICON_EYE } from "./icons.js";

let capsuleEl = null;
let popEl = null;
let opened = false;

// 胶囊上显示的档位快捷项（与设置页预设同源，但此处只需一键切换常用值）
const QUICK_PRESETS = [
  { id: "office", name: "办公", kelvin: 5500, brightness: 95, contrast: 98 },
  { id: "read", name: "阅读", kelvin: 4500, brightness: 90, contrast: 95 },
  { id: "night", name: "夜间", kelvin: 3400, brightness: 82, contrast: 92 },
  { id: "late", name: "深夜", kelvin: 2700, brightness: 70, contrast: 88 },
];

/// 胶囊标题：区分三种状态（未开启 / 已生效 / 已开启但未生效）。
/// 刻意不显示色温数值 —— 胶囊要一眼可读，K 值留给浮层和设置页。
function capsuleTitle(ec, status) {
  if (!ec?.enabled) return "护眼";
  if (status && status.active === false) return "未生效";
  return "护眼中";
}

function renderCapsule() {
  if (!capsuleEl) return;
  const ec = state.eyeCare;
  const status = getEyeCareStatus();
  capsuleEl.dataset.on = ec?.enabled ? "1" : "0";
  // 未生效时给出视觉区分（边框转警示色），避免用户以为已生效
  capsuleEl.dataset.inactive = (ec?.enabled && status && status.active === false) ? "1" : "0";
  const timeEl = capsuleEl.querySelector(".eye-time");
  if (timeEl) timeEl.textContent = capsuleTitle(ec, status);
  capsuleEl.title = ec?.enabled
    ? (status && status.active === false)
      ? "护眼已开启但未生效 · 驱动屏蔽 / HDR / 远程桌面 · 点击查看"
      : "护眼已开启 · 点击查看"
    : "护眼未开启 · 点击开启（调节整机屏幕色温）";
}

function renderPopover() {
  if (!popEl) return;
  const ec = state.eyeCare;
  const status = getEyeCareStatus();

  const onEl = popEl.querySelector("#eye-pop-state");
  if (onEl) {
    if (!ec?.enabled) onEl.textContent = "未开启";
    else if (status && status.active === false) onEl.textContent = "已开启但未生效";
    else onEl.textContent = "已生效";
  }

  // 模式说明
  const modeEl = popEl.querySelector("#eye-pop-mode");
  if (modeEl) {
    modeEl.textContent = ec?.mode === "schedule"
      ? `按时段 · ${ec.from}–${ec.to}（日间 ${ec.dayKelvin}K / 夜间 ${ec.nightKelvin}K）`
      : `固定色温 · ${ec?.kelvin ?? 4500}K`;
  }

  // 快捷档位高亮
  popEl.querySelectorAll(".eye-preset").forEach((btn) => {
    const p = QUICK_PRESETS.find((x) => x.id === btn.dataset.id);
    const active = !!p && ec?.kelvin === p.kelvin && ec?.brightness === p.brightness && ec?.contrast === p.contrast;
    btn.classList.toggle("active", active);
  });

  // 开关按钮文案
  const toggleBtn = popEl.querySelector("#eye-pop-toggle");
  if (toggleBtn) toggleBtn.textContent = ec?.enabled ? "关闭护眼" : "开启护眼";
}

function openPopover() {
  if (!popEl || !capsuleEl) return;
  const r = capsuleEl.getBoundingClientRect();
  popEl.hidden = false;
  opened = true;
  renderPopover();
  // 定位在胶囊下方，并夹回视口内（沿用 dashboard 右键菜单的做法）
  const w = popEl.offsetWidth, h = popEl.offsetHeight;
  popEl.style.left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8)) + "px";
  popEl.style.top = Math.max(8, Math.min(r.bottom + 6, window.innerHeight - h - 8)) + "px";
}

function closePopover() {
  if (!popEl || popEl.hidden) return;
  popEl.hidden = true;
  opened = false;
}

function togglePopover() {
  opened ? closePopover() : openPopover();
}

/// 初始化护眼胶囊（在 initPomodoro 之后调用，确保插在番茄钟右侧）。
export function initEyeCareCapsule() {
  const clockEl = document.getElementById("main-clock");
  if (!clockEl || capsuleEl) return;

  // ── 胶囊本体 ──
  capsuleEl = document.createElement("div");
  capsuleEl.id = "mc-eye";
  capsuleEl.className = "mc-eye";
  capsuleEl.setAttribute("role", "button");
  capsuleEl.tabIndex = 0;
  capsuleEl.innerHTML = `
    <span class="eye-icon">${ICON_EYE}</span>
    <div class="eye-meta">
      <div class="eye-time">护眼</div>
    </div>`;

  // ── 浮层（懒挂到 body，避免被时钟条的 overflow 裁掉）──
  popEl = document.createElement("div");
  popEl.id = "eye-pop";
  popEl.className = "eye-pop";
  popEl.hidden = true;
  popEl.innerHTML = `
    <div class="eye-pop-head">
      <span class="eye-pop-title">${ICON_EYE}全局护眼</span>
      <span class="eye-pop-state" id="eye-pop-state">未开启</span>
    </div>
    <div class="eye-pop-mode" id="eye-pop-mode"></div>
    <div class="eye-pop-presets">
      ${QUICK_PRESETS.map((p) => `<button class="eye-preset" data-id="${p.id}">${esc(p.name)}</button>`).join("")}
    </div>
    <div class="eye-pop-actions">
      <button class="btn btn-primary eye-pop-toggle" id="eye-pop-toggle">开启护眼</button>
      <button class="btn eye-pop-restore" id="eye-pop-restore">恢复原色</button>
    </div>
    <div class="eye-pop-hint">作用于整机所有应用 · 详细设置见「系统设置 → 护眼」</div>`;

  // 插到番茄钟胶囊右侧（番茄钟可能尚未挂载，则插到提醒区之前）
  const pomoEl = document.getElementById("mc-pomo");
  const remindersEl = document.getElementById("mc-reminders");
  if (pomoEl) clockEl.insertBefore(capsuleEl, pomoEl.nextSibling);
  else clockEl.insertBefore(capsuleEl, remindersEl);
  document.body.appendChild(popEl);

  // ── 事件 ──
  capsuleEl.addEventListener("click", (e) => {
    e.stopPropagation();
    togglePopover();
  });
  capsuleEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); togglePopover(); }
  });

  popEl.querySelector("#eye-pop-toggle").addEventListener("click", async () => {
    await toggleEyeCare();
    toast(state.eyeCare.enabled ? "护眼模式已开启" : "护眼模式已关闭");
    renderPopover();
  });
  popEl.querySelector("#eye-pop-restore").addEventListener("click", async () => {
    await restoreNativeColor();
    toast("已恢复显示器原始色彩");
    renderPopover();
  });
  popEl.querySelectorAll(".eye-preset").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const p = QUICK_PRESETS.find((x) => x.id === btn.dataset.id);
      if (!p) return;
      // 快捷档位同时打开护眼 —— 点档位却不生效会让人困惑
      await setEyeCare({
        kelvin: p.kelvin, brightness: p.brightness, contrast: p.contrast,
        mode: "manual", enabled: true,
      }, { immediate: true });
      renderPopover();
    });
  });

  // 点击外部 / Esc / 窗口变化关闭（与 pomodoro 浮层一致的收尾行为）
  document.addEventListener("pointerdown", (e) => {
    if (opened && !popEl.contains(e.target) && !capsuleEl.contains(e.target)) closePopover();
  }, true);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && opened) closePopover();
  }, true);
  window.addEventListener("resize", () => { if (opened) closePopover(); });

  // 状态订阅：配置或后端状态变化都重绘胶囊。
  // （守护线程的 eyecare-overridden / eyecare-failed 由 eyeCare.js 统一订阅并刷新，
  //   这里只订阅它广播出来的状态变化，避免同一事件被两处重复处理。）
  onEyeCareChange(() => { renderCapsule(); if (opened) renderPopover(); });

  renderCapsule();
  // 首次查询后端真实状态，让「未生效」从一开始就可见
  refreshEyeCareStatus();
}
