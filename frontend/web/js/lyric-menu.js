// 桌面歌词设置弹窗（独立窗口）页逻辑。
//
// 定位：**纯配置层**。歌词条窗口（lyric）只负责显示与穿透，本弹窗负责全部外观配置
// （模式/样式/对齐/配色/偏移）。两者通过 lyric_commit_display → Rust 广播解耦：
// 本页改动经 Rust 广播 lyric://display，歌词条窗口收到后应用；歌词条自己的改动
// 也走同一广播，本页据此同步 ✓ 高亮。歌词条窗口在菜单打开期间**不做任何尺寸
// 变化**（弹窗是独立窗口），从机制上杜绝「点设置闪一下」。
//
// 弹窗为 WS_EX_NOACTIVATE 风格（focusable(false)）：可点击但绝不抢键盘焦点；
// 关闭由 Rust 侧完成（toggle / 拖动动条 / 手动锁定 / 光标移出），本页只渲染。
const TAURI = (typeof window !== "undefined" && window.__TAURI__) || null;

const invoke = (cmd, args) =>
  TAURI && TAURI.core && typeof TAURI.core.invoke === "function"
    ? TAURI.core.invoke(cmd, args)
    : Promise.resolve();

const listen = (evt, cb) =>
  TAURI && TAURI.event && typeof TAURI.event.listen === "function"
    ? TAURI.event.listen(evt, cb)
    : Promise.resolve(() => {});

const panelEl = document.getElementById("panel");
const offValEl = document.getElementById("off-val");
const miFormEl = document.getElementById("mi-form");
const miStyleEl = document.getElementById("mi-style");
const miAlignEl = document.getElementById("mi-align");
const miColorEl = document.getElementById("mi-color");
const subStyleEl = document.getElementById("sub-style");
const subAlignEl = document.getElementById("sub-align");
const subColorEl = document.getElementById("sub-color");

const FORMS = ["single", "double"];
const STYLES = ["stroke", "capsule", "bold"];
const ALIGNS = ["left", "center", "right"];

// 生效值（权威来源是 state.json，经 Rust 广播同步到本页）
let form = "single";
let styleMode = "stroke";
let align = "center";
let colorText = "";
let colorFill = "";
let offsetVal = 0;

// 命名配色方案（对齐网易云菜单命名：网易红/落日晖/可爱粉…）。
// 第一个 = 自定义：文字近白、染色跟随主题品牌色（落盘是空串语义）。
const COLOR_SCHEMES = [
  { name: "自定义", text: "",        fill: "" },
  { name: "网易红", text: "#FFE9EC", fill: "#EC4141" },
  { name: "落日晖", text: "#FFF3E0", fill: "#FF9F43" },
  { name: "可爱粉", text: "#FFE4EC", fill: "#FF6B9D" },
  { name: "天际蓝", text: "#E8F3FF", fill: "#58A6FF" },
  { name: "清新绿", text: "#EAFFFB", fill: "#2BD9C8" },
  { name: "活力紫", text: "#F0E9FF", fill: "#8B7CF6" },
  { name: "温柔黄", text: "#FFF9DB", fill: "#F7B500" },
  { name: "低调灰", text: "#E6E8EB", fill: "#8A919E" },
];

// 渲染配色子菜单：行首双色圆点，行尾 ✓ 标当前方案
function renderSchemes() {
  if (!subColorEl) return;
  subColorEl.innerHTML = COLOR_SCHEMES.map((s, i) => {
    const active = s.text === colorText && s.fill === colorFill;
    const style = (s.text || s.fill) ? `--sw-a:${s.text || "#F5F9FE"};--sw-b:${s.fill || "var(--bg-brand)"};` : "";
    return `<button class="ly-mi ${active ? "selected" : ""}" data-i="${i}" title="${s.name}：未唱 ${s.text || "近白"} / 已唱 ${s.fill || "跟随主题"}">
      <span class="ly-cdot" style="${style}"></span>${s.name}<span class="ly-mcheck">${active ? "✓" : ""}</span></button>`;
  }).join("");
  subColorEl.querySelectorAll(".ly-mi").forEach((b) => b.addEventListener("click", () => {
    const s = COLOR_SCHEMES[Number(b.dataset.i)] || COLOR_SCHEMES[0];
    commitDisplay({ colorText: s.text, colorFill: s.fill });
  }));
}

// 子菜单开合：同一时间只显示一个；默认显示「更换配色」（最常用）
function toggleSub(which) {
  const map = { style: [subStyleEl, miStyleEl], align: [subAlignEl, miAlignEl], color: [subColorEl, miColorEl] };
  for (const [key, [sub, mi]] of Object.entries(map)) {
    if (!sub) continue;
    const show = key === which;
    sub.hidden = !show;
    if (mi) mi.classList.toggle("active", show);
  }
}

// ✓ 高亮跟随生效值（取值可能来自本页点击，也可能来自 Rust 广播）
function syncChecks(subEl, cur) {
  if (!subEl) return;
  subEl.querySelectorAll(".ly-mi").forEach((b) => {
    const chk = b.querySelector(".ly-mcheck");
    const on = b.dataset.v === cur;
    if (chk) chk.textContent = on ? "✓" : "";
    b.classList.toggle("selected", on);
  });
}

function syncPanelUI() {
  if (miFormEl) miFormEl.textContent = form === "double" ? "切换单行模式" : "切换双行模式";
  syncChecks(subStyleEl, styleMode);
  syncChecks(subAlignEl, align);
  renderSchemes();
  if (offValEl) offValEl.textContent = offsetVal === 0 ? "同步" : `${offsetVal > 0 ? "+" : ""}${offsetVal}s`;
}

// 用户改配置 → 交 Rust 广播（歌词条窗口与主窗口落盘都在另一侧完成）
function commitDisplay(patch) {
  const payload = {
    form: patch.form ?? form,
    style: patch.style ?? styleMode,
    align: patch.align ?? align,
    fontSize: patch.fontSize ?? 22,
    colorText: patch.colorText ?? colorText,
    colorFill: patch.colorFill ?? colorFill,
    offset: patch.offset ?? offsetVal,
  };
  invoke("lyric_commit_display", payload).catch(() => {});
}

// ───────────────────────── 事件接线 ─────────────────────────
miFormEl?.addEventListener("click", () => commitDisplay({ form: form === "double" ? "single" : "double" }));
miStyleEl?.addEventListener("click", () => toggleSub("style"));
miAlignEl?.addEventListener("click", () => toggleSub("align"));
miColorEl?.addEventListener("click", () => toggleSub("color"));
subStyleEl?.querySelectorAll(".ly-mi").forEach((b) =>
  b.addEventListener("click", () => commitDisplay({ style: b.dataset.v })));
subAlignEl?.querySelectorAll(".ly-mi").forEach((b) =>
  b.addEventListener("click", () => commitDisplay({ align: b.dataset.v })));
document.getElementById("off-plus")?.addEventListener("click", () => commitDisplay({ offset: Math.min(5, offsetVal + 0.5) }));
document.getElementById("off-minus")?.addEventListener("click", () => commitDisplay({ offset: Math.max(-5, offsetVal - 0.5) }));

// ───────────────────────── 广播同步 + 就绪握手 ─────────────────────────
// 顺序至关重要：**先注册 listener，再调 ready**（与歌词条窗口同一套握手，
// 避免 ready 后 Rust 立即 emit、事件在监听注册前丢失的竞态）。
let readySent = false;
const sendReady = () => {
  if (readySent) return;
  readySent = true;
  invoke("lyric_menu_ready").catch((e) => console.warn("[menu] 就绪握手失败：", e));
};

Promise.all([
  listen("lyric://display", (e) => {
    const p = e?.payload || {};
    // 权威配置由 Rust 下发：更新 ✓ 高亮 / 文案 / 偏移值
    if (FORMS.includes(p.form)) form = p.form;
    if (STYLES.includes(p.style)) styleMode = p.style;
    if (ALIGNS.includes(p.align)) align = p.align;
    if (typeof p.colorText === "string") colorText = p.colorText;
    if (typeof p.colorFill === "string") colorFill = p.colorFill;
    if (typeof p.offset === "number" && isFinite(p.offset)) {
      offsetVal = Math.max(-5, Math.min(5, Math.round(p.offset * 2) / 2));
    }
    syncPanelUI();
  }),
])
  .then(sendReady)
  .catch(() => sendReady());

syncPanelUI();
