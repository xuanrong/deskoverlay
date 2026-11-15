// 自定义时间选择控件：完全替代原生 input[type="time"]。
// 背景：原生 time 控件的时钟图标 / 内部伪元素由 WebView2 渲染，风格与自绘的
// createDatePicker / createSelect 不统一，因此自绘时分面板，文字与行为完全可控。
// 用法：
//   createTimePicker({ el, value, onChange });
//   - el      容器元素（渲染控件；el.value 承载 'HH:MM'，可直接读取）
//   - value   初始值 'HH:MM'
//   - onChange 选中后回调 (value) => {}
// 交互：点击整框弹出时分面板；单击时或分即选中并关闭（免去再点确定）；
//       点外部 / Esc / 外部滚动关闭。
// 样式复用 createDatePicker 的 .dp 系列（同一套控件外观），弹出面板用 .tp-pop。

import { esc } from "./utils.js";

const ICON_CLOCK = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>`;

const pad2 = (n) => String(n).padStart(2, "0");

let currentPop = null;

function closeCurrentPop() {
  if (currentPop) {
    currentPop._cleanup?.();
    currentPop = null;
  }
}

export function createTimePicker({ el, value = "", onChange = null }) {
  el.classList.add("dp");
  el.tabIndex = 0;
  el.value = /^\d{1,2}:\d{2}$/.test(value) ? value : "";

  function render() {
    const v = el.value || "";
    el.innerHTML = `
      <span class="dp-display">${v ? esc(v) : '<span class="dp-ph">选择时间</span>'}</span>
      <span class="dp-icon">${ICON_CLOCK}</span>`;
  }

  function setValue(v) {
    el.value = v || "";
    render();
    el.dispatchEvent(new CustomEvent("change"));
    onChange?.(el.value);
  }

  function buildPop() {
    const [hh, mm] = (el.value || "09:00").split(":").map(Number);
    let selH = isFinite(hh) ? hh : 9;
    let selM = isFinite(mm) ? mm : 0;

    const pop = document.createElement("div");
    pop.className = "dp-pop tp-pop";
    pop.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });

    function draw() {
      const hours = Array.from({ length: 24 }, (_, h) => h);
      const minutes = Array.from({ length: 12 }, (_, i) => i * 5); // 5 分钟步进，覆盖常用
      pop.innerHTML = `
        <div class="tp-cols">
          <div class="tp-col">
            <div class="tp-col-title">时</div>
            <div class="tp-list" data-col="h">${hours.map((h) => `
              <button type="button" class="tp-cell${h === selH ? " sel" : ""}" data-v="${h}">${pad2(h)}</button>`).join("")}
            </div>
          </div>
          <div class="tp-col">
            <div class="tp-col-title">分</div>
            <div class="tp-list" data-col="m">${minutes.map((m) => `
              <button type="button" class="tp-cell${m === selM ? " sel" : ""}" data-v="${m}">${pad2(m)}</button>`).join("")}
            </div>
          </div>
        </div>
        <button type="button" class="tp-confirm">${pad2(selH)}:${pad2(selM)} 确定</button>`;
    }
    draw();

    pop.addEventListener("click", (e) => {
      // 单击时/分：选中该值 + 更新「确定」按钮的预览，不落定
      const cell = e.target.closest(".tp-cell");
      if (cell) {
        const col = cell.closest(".tp-list").dataset.col;
        const v = Number(cell.dataset.v);
        if (col === "h") selH = v; else selM = v;
        draw();
        return;
      }
      // 点「确定」：落定当前选中的时分
      if (e.target.closest(".tp-confirm")) {
        setValue(`${pad2(selH)}:${pad2(selM)}`);
        close();
      }
    });

    const onDocDown = (e) => {
      if (!pop.contains(e.target) && !el.contains(e.target)) close();
    };
    // 滚动关闭：只关「外部滚动」（切走弹窗该收起）。⚠ 弹窗内部列表（时/分）自身滚动
    // 的 target 也落在 pop 里，必须放行，否则滚轮一动就被当成页面滚动而关闭 → 滚不动。
    const onScroll = (e) => { if (!pop.contains(e.target)) close(); };

    pop._cleanup = () => {
      document.removeEventListener("pointerdown", onDocDown, true);
      window.removeEventListener("scroll", onScroll, true);
      pop.remove();
    };

    document.addEventListener("pointerdown", onDocDown, true);
    window.addEventListener("scroll", onScroll, true);
    document.body.appendChild(pop);
    // 定位：贴控件下方，空间不足则翻到上方
    const rect = el.getBoundingClientRect();
    pop.style.left = Math.min(rect.left, Math.max(8, window.innerWidth - pop.offsetWidth - 8)) + "px";
    let top = rect.bottom + 6;
    if (top + pop.offsetHeight > window.innerHeight - 8) top = Math.max(8, rect.top - pop.offsetHeight - 6);
    pop.style.top = top + "px";

    // 打开时把时/分列表滚到当前选中项居中（必须在 appendChild + 定位之后，此时才有布局、offsetTop 才准）
    pop.querySelectorAll(".tp-list").forEach((list) => {
      const sel = list.querySelector(".tp-cell.sel");
      if (sel) list.scrollTop = sel.offsetTop - list.clientHeight / 2 + sel.offsetHeight / 2;
    });

    function close() { closeCurrentPop(); }
    pop._close = close;
    currentPop = pop;
  }

  function open() {
    closeCurrentPop();
    buildPop();
  }

  el.addEventListener("click", (e) => { e.stopPropagation(); open(); });
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
    if (e.key === "Escape") closeCurrentPop();
  });

  // 供外部销毁时关闭（弹窗移除、视图销毁等）
  el._close = () => closeCurrentPop();

  render();
  return el;
}
