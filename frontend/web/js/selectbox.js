// 自定义下拉选择控件：替代原生 <select>。
// 背景：原生 select 的弹出面板由系统渲染，无法与深色主题统一，且自定义箭头在
// WebView2 中不稳定，因此自绘下拉面板，样式与交互完全可控。
// 用法：
//   createSelect({ el, value, options, placeholder, onChange });
//   - el       容器元素（渲染控件；el.value 承载当前选中 value，可直接读取）
//   - options  [{ value, label }]
//   - placeholder 未选中时的提示文字
//   - onChange 选中后回调 (value) => {}
// 动态更新选项：el._setOptions(opts)（保留当前选中，若选中项被移除则显示提示）
// 交互：点击展开；点外部 / Esc / 滚动关闭；选中项打勾。

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ICON_CHEV = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>`;
const ICON_CHECK = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>`;

let currentPop = null;
let currentEl = null;

function closeCurrentPop() {
  if (currentPop) {
    currentPop._cleanup?.();
    currentPop = null;
  }
  if (currentEl) {
    currentEl.classList.remove("open");
    currentEl = null;
  }
}

export function createSelect({ el, value = "", options = [], placeholder = "请选择", onChange = null }) {
  el.classList.add("cs");
  el.tabIndex = 0;
  el.value = value || "";
  let opts = options;

  const labelOf = (v) => {
    const o = opts.find((o) => o.value === v);
    return o ? o.label : "";
  };

  function render() {
    const cur = labelOf(el.value);
    el.innerHTML = `
      <span class="cs-display">${cur ? esc(cur) : `<span class="cs-ph">${esc(placeholder)}</span>`}</span>
      <span class="cs-arrow">${ICON_CHEV}</span>`;
  }

  function setValue(v, fire = true) {
    el.value = v || "";
    render();
    if (fire) {
      el.dispatchEvent(new CustomEvent("change"));
      onChange?.(el.value);
    }
  }

  function buildPop() {
    const pop = document.createElement("div");
    pop.className = "cs-pop";
    pop.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });

    function draw() {
      pop.innerHTML = `<div class="cs-list">${
        opts.length
          ? opts.map((o, i) => `
            <button type="button" class="cs-opt${o.value === el.value ? " sel" : ""}" data-i="${i}">
              <span class="cs-opt-label">${esc(o.label)}</span>
              ${o.value === el.value ? `<span class="cs-opt-check">${ICON_CHECK}</span>` : ""}
            </button>`).join("")
          : `<div class="cs-empty">无选项</div>`
      }</div>`;
    }
    draw();

    pop.addEventListener("click", (e) => {
      const opt = e.target.closest(".cs-opt");
      if (!opt) return;
      const o = opts[+opt.dataset.i];
      if (o) { setValue(o.value); close(); }
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

    // 定位：贴控件下方左对齐；空间不足向上翻；宽度至少对齐控件
    const rect = el.getBoundingClientRect();
    pop.style.left = Math.min(rect.left, Math.max(8, window.innerWidth - pop.offsetWidth - 8)) + "px";
    pop.style.top = rect.bottom + 4 + "px";
    if (rect.bottom + 4 + pop.offsetHeight > window.innerHeight - 8) {
      pop.style.top = Math.max(8, rect.top - pop.offsetHeight - 4) + "px";
    }
    if (pop.offsetWidth < rect.width) pop.style.width = rect.width + "px";

    function close() { closeCurrentPop(); }
    pop._close = close;
    currentPop = pop;
  }

  function open() {
    closeCurrentPop();
    currentEl = el;
    el.classList.add("open");
    buildPop();
  }

  el.addEventListener("click", (e) => { e.stopPropagation(); open(); });
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
    else if (e.key === "Escape") closeCurrentPop();
  });

  // 动态更新选项：保留当前选中；若选中项已不存在则回退到第一项（无则清空）
  el._setOptions = (next) => {
    opts = next || [];
    if (el.value && !opts.some((o) => o.value === el.value)) {
      el.value = opts[0]?.value || "";
    }
    render();
  };
  // 供外部销毁时关闭
  el._close = () => closeCurrentPop();

  render();
  return el;
}
