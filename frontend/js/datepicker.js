// 自定义日期选择控件：完全替代原生 input[type="date"]。
// 背景：WebView2 中原生日期控件的 "yyyy/mm/dd" 占位文字由内部伪元素渲染，
// 颜色无法可靠控制、选中行为也不稳定，因此自绘日历，文字与行为完全可控。
// 用法：
//   createDatePicker({ el, value, onChange });
//   - el      容器元素（渲染控件；el.value 承载 'YYYY-MM-DD'，空串=未选，可直接读取）
//   - value   初始值
//   - onChange 选中后回调 (value) => {}
// 交互：点击整框弹出日历；点外部 / Esc / 滚动关闭；支持今天与清除。

const WEEK = ["一", "二", "三", "四", "五", "六", "日"];
const pad = (n) => String(n).padStart(2, "0");
const toStr = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = (s) => {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3]);
};
const fmtDisplay = (s) => {
  const d = parse(s);
  return d ? `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日` : "";
};

const ICON_CAL = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>`;
const ICON_PREV = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>`;
const ICON_NEXT = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>`;

let currentPop = null;

function closeCurrentPop() {
  if (currentPop) {
    currentPop._cleanup?.();
    currentPop = null;
  }
}

export function createDatePicker({ el, value = "", onChange = null }) {
  el.classList.add("dp");
  el.tabIndex = 0;
  el.value = value || "";

  function render() {
    const v = el.value ? fmtDisplay(el.value) : "";
    el.innerHTML = `
      <span class="dp-display">${v ? v : '<span class="dp-ph">选择日期</span>'}</span>
      <span class="dp-icon">${ICON_CAL}</span>`;
  }

  function setValue(v) {
    el.value = v || "";
    render();
    el.dispatchEvent(new CustomEvent("change"));
    onChange?.(el.value);
  }

  function buildPop() {
    const today = new Date();
    const todayStr = toStr(today);
    const init = parse(el.value) || today;
    let viewY = init.getFullYear();
    let viewM = init.getMonth();

    const pop = document.createElement("div");
    pop.className = "dp-pop";
    pop.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });

    function draw() {
      const first = new Date(viewY, viewM, 1);
      const offset = (first.getDay() + 6) % 7; // 周一为一周起点
      const cells = [];
      for (let i = 0; i < 42; i++) {
        const d = new Date(viewY, viewM, 1 - offset + i);
        const ds = toStr(d);
        const cls = ["dp-day"];
        if (d.getMonth() !== viewM) cls.push("other");
        if (ds === todayStr) cls.push("today");
        if (ds === el.value) cls.push("sel");
        cells.push(`<button type="button" class="${cls.join(" ")}" data-date="${ds}">${d.getDate()}</button>`);
      }
      pop.innerHTML = `
        <div class="dp-pop-head">
          <button type="button" class="dp-nav" data-nav="-1" title="上个月">${ICON_PREV}</button>
          <span class="dp-pop-title">${viewY}年${viewM + 1}月</span>
          <button type="button" class="dp-nav" data-nav="1" title="下个月">${ICON_NEXT}</button>
        </div>
        <div class="dp-week">${WEEK.map((w) => `<span>${w}</span>`).join("")}</div>
        <div class="dp-grid">${cells.join("")}</div>
        <div class="dp-pop-foot">
          <button type="button" class="dp-today">今天</button>
          <button type="button" class="dp-clear">清除</button>
        </div>`;
    }
    draw();

    pop.addEventListener("click", (e) => {
      const nav = e.target.closest("[data-nav]");
      if (nav) {
        viewM += +nav.dataset.nav;
        if (viewM < 0) { viewM = 11; viewY--; }
        if (viewM > 11) { viewM = 0; viewY++; }
        draw();
        return;
      }
      const day = e.target.closest(".dp-day");
      if (day) { setValue(day.dataset.date); close(); return; }
      if (e.target.closest(".dp-today")) { setValue(todayStr); close(); return; }
      if (e.target.closest(".dp-clear")) { setValue(""); close(); return; }
    });

    const onDocDown = (e) => {
      if (!pop.contains(e.target) && !el.contains(e.target)) close();
    };
    const onScroll = () => close();

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
