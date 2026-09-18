// 桌面歌词窗口页逻辑（P1 骨架）。
//
// 定位：**纯显示层，不做时间推进**。音频实例（musicAudio）与 LRC 解析结果都活在主窗口的
// JS realm 里，若本页也持有时间轴，两个窗口会各自计时 → 卡拉OK 进度肉眼可见地漂移。
// 故时间基准由主窗口在**换行时**推一次（lineStart / lineEnd），本页用 rAF 基于锚点自插值；
// 锚点每次换行重置，误差不累积。播放全程的 IPC 次数 = 歌词行数，而非每秒 10 次。
//
// 不变量（继承自 reminder.js 的教训）：**窗口可见 ⟺ 有内容**。
// 透明置顶窗一旦没有内容，视觉上等于不存在，却仍在吞鼠标消息。故本页立即渲染占位行，
// 绝不留空白。
//
// P1 范围：静态占位内容 + 锁定/穿透切换 + 拖动 + 字号；真实歌词数据在 P2 接入。
const TAURI = (typeof window !== "undefined" && window.__TAURI__) || null;

const invoke = (cmd, args) =>
  TAURI && TAURI.core && typeof TAURI.core.invoke === "function"
    ? TAURI.core.invoke(cmd, args)
    : Promise.resolve();

const listen = (evt, cb) =>
  TAURI && TAURI.event && typeof TAURI.event.listen === "function"
    ? TAURI.event.listen(evt, cb)
    : Promise.resolve(() => {});

// 注意：浏览器 dev 态 / 冒烟 mock 下 window API 可能不可用（mock 返回 {}），
// 所有调用点都要判空 —— 拖动与位置换算属「有则增强」，缺失时不应抛错。
const win = TAURI && TAURI.window && typeof TAURI.window.getCurrentWindow === "function"
  ? TAURI.window.getCurrentWindow()
  : null;

const bar = document.getElementById("bar");
const lineEl = document.getElementById("line");
const textEl = document.getElementById("text");
const fillEl = document.getElementById("fill");
const line2El = document.getElementById("line2");
const text2El = document.getElementById("text2");
const btnLock = document.getElementById("btn-lock");

const FONT_MIN = 12, FONT_MAX = 28, FONT_STEP = 2;
const DEFAULT_TEXT = "桌面歌词 · 待播放";
const FORMS = ["single", "double"];
const STYLES = ["stroke", "capsule", "bold"];
const ALIGNS = ["left", "center", "right"];

// ───────────────────────── 显示状态 ─────────────────────────
// locked / fontSize / form / style 都只在本页保存「当前生效值」，权威来源是 state.json。
// 本页不落盘（主窗口是 state.json 唯一写者）；本页改动的形态经 Rust 回传主窗口持久化。
// 初始锁定态与 HTML 默认值保持一致（"true" = 按锁定处理）：
// 在 Rust 的 `lyric://locked` 通知到达前，鼠标事件到不了页面，
// 此时若 JS 里认为是「已解锁」，工具条会显示成可点但实际点不动（幽灵交互）。
let locked = bar.dataset.locked === "true";
let fontSize = 22;
let playing = false;
let form = "single";         // single | double（决定窗口高度，由 Rust 侧实际改尺寸）
let styleMode = "stroke";    // stroke | capsule | bold
let align = "center";        // 歌词对齐方式：left | center | right（参考网易云）
let colorText = "";          // 文字颜色（#RGB/#RRGGBB；空 = 默认近白）
let colorFill = "";          // 卡拉OK染色色（空 = 跟随主题品牌色）
let offsetVal = 0;           // 歌词时间偏移（秒；正 = 提前，负 = 延后）

// rAF 插值状态
let rafId = 0;
let anchorPerf = 0;          // 本行起始时刻的 performance.now() 基准（毫秒）
let lineStart = 0;
let lineEnd = 0;
let elapsedBase = 0;         // 推送时刻音频已走过的秒数（t0 校准用）

const clamp01 = (v) => Math.min(1, Math.max(0, v));

// ───────────────────────── 卡拉OK 染色 ─────────────────────────
// 两条路径：
//   A) 有逐字时间轴（words）→ 按**每个字的实际演唱时刻**推进裁切位置（精确到字）
//   B) 无逐字数据 → 回退整行线性扫描（elapsed / 行时长）
//
// A 的关键：裁切位置不能按「字数等分」算，因为字符宽度不等宽
// （中英文混排、标点、空格差异很大）。必须**实测每个字的像素宽度**，
// 按字符边界定位 —— 否则染色会跑在字与字之间，看起来仍然「不准」。
let words = null;        // [{ t, d, text, w }] w = 该字在行内的像素宽度（累计）
let wordCuts = null;     // 每个字的**右边界**累计宽度占比 [0..1]，用于把时间映射成裁切比例

// 用 canvas 量文字宽度（不依赖 DOM 插入，且能复用同一字体度量）
const measureCanvas = document.createElement("canvas");
const measureCtx = measureCanvas.getContext("2d");

function measureCharWidths(text, font) {
  measureCtx.font = font;
  const total = measureCtx.measureText(text).width;
  if (!total) return null;
  const cuts = [];
  let acc = 0;
  // 逐字累加宽度 → 得到每个字结束位置的占比
  for (const ch of text) {
    acc += measureCtx.measureText(ch).width;
    cuts.push(acc / total);
  }
  return cuts;
}

// 当前该染色到哪个比例（0..1）。
// 有 words 时按字插值：找到当前字，在其左右边界之间按该字内的进度插值，
// 使染色平滑推进而不是逐字跳跃。
function progressAt(elapsed) {
  const dur = lineEnd - lineStart;
  if (words && wordCuts && wordCuts.length === words.length) {
    // 定位当前字
    let i = -1;
    for (let k = 0; k < words.length; k++) {
      if (elapsed >= words[k].t) i = k;
      else break;
    }
    if (i < 0) return 0;                                   // 尚未开始唱
    const left = i === 0 ? 0 : wordCuts[i - 1];
    const right = wordCuts[i];
    const w = words[i];
    // 该字自身的持续时长（缺失时用「下一个字的起点 - 本字起点」，再不行给 0.25s 兜底）
    let wd = w.d;
    if (!wd) wd = (i + 1 < words.length ? words[i + 1].t : dur) - w.t;
    if (!(wd > 0)) wd = 0.25;
    const p = clamp01((elapsed - w.t) / wd);
    return left + (right - left) * p;
  }
  return dur > 0 ? clamp01(elapsed / dur) : 0;
}

// 只在该行有效期内跑 rAF，行结束即停 —— 无歌词 / 暂停时不占用任何帧。
//
// 时间模型（t0 校准）：主窗口在 timeupdate（约 4Hz）里检测行切换，故事件到达时
// 音频已经在这行走了最多 ~250ms。若以「收到事件的时刻」为锚点，染色会整体晚一拍。
// 主窗口因此随事件带上 `t0`（推送瞬间的音频时间），本页据此把进度**立即对齐**：
//   elapsed = t0 之后经过的秒数 + (t0 - lineStart)
function tick() {
  rafId = 0;
  const dur = lineEnd - lineStart;
  if (dur <= 0) return;
  const elapsed = elapsedBase + (performance.now() - anchorPerf) / 1000;
  const p = progressAt(elapsed);
  fillEl.style.setProperty("--p", p.toFixed(4));
  if (p < 1 && playing) rafId = requestAnimationFrame(tick);
}

function startFill() {
  if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
  anchorPerf = performance.now();
  tick();
}

function stopFill() {
  if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
  fillEl.style.setProperty("--p", "0");
}

// ───────────────────────── 内容渲染 ─────────────────────────
function renderLine(p) {
  const text = (p && p.text) || "";
  // idle：无歌词（纯音乐 / 音源未实现 getLyric）→ 退化为「歌名 — 歌手」，
  // 绝不显示空窗（透明置顶窗无内容会静默吞鼠标，见文件头的不变量说明）。
  const idle = !!(p && p.idle) || !text;
  if (idle) {
    const meta = [p?.title, p?.artist].filter(Boolean).join(" — ");
    textEl.textContent = meta || DEFAULT_TEXT;
    fillEl.textContent = "";
    lineEl.dataset.idle = "1";
  } else {
    textEl.textContent = text;
    fillEl.textContent = text;
    lineEl.dataset.idle = "0";
  }
  // 第二行（下一句，仅双行形态可见）：无逐字染色 —— 未播到的句子不应预先染色。
  // 末行没有 next 时留空，避免残留上一首的句子。
  const nextText = (p && p.next) || "";
  text2El.textContent = nextText;
  line2El.dataset.idle = nextText ? "0" : "1";
  playing = !!(p && p.playing);
  bar.dataset.playing = playing ? "true" : "false";

  lineStart = Number(p?.lineStart) || 0;
  lineEnd = Number(p?.lineEnd) || 0;
  // t0 校准：clamp 到 [0, dur]，防主窗口时钟与行边界不一致时算出负进度
  const t0 = Number(p?.t0) || 0;
  elapsedBase = Math.max(0, Math.min(lineEnd - lineStart, t0 - lineStart));

  // 逐字时间轴：仅在文本与逐字片段完全对应时启用（否则宽度映射会错位）
  words = null;
  wordCuts = null;
  if (!idle && Array.isArray(p?.words) && p.words.length) {
    const joined = p.words.map((w) => w.text).join("");
    if (joined === text) {
      words = p.words;
      refreshWordCuts();   // 用实际渲染样式量取字符宽度（见函数内注释）
    }
  }

  if (idle || lineEnd <= lineStart) {
    stopFill();
  } else if (playing) {
    startFill();
  } else {
    // 暂停态：按 t0 定到静态位置后冻结（不启动 rAF，避免暂停时仍占用帧）
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    fillEl.style.setProperty("--p", progressAt(elapsedBase).toFixed(4));
  }
}

function setFontSize(px) {
  fontSize = Math.min(FONT_MAX, Math.max(FONT_MIN, px));
  document.documentElement.style.setProperty("--ly-size", fontSize + "px");
  // 字号变了 → 字符宽度占比随之改变，缓存的 wordCuts 失效。
  // 不重算的话，染色会按旧宽度的边界裁切，与文字本体错位。
  refreshWordCuts();
}

// 重算当前行的字符宽度表（字号 / 字体变化后调用）。
// 用当前实际渲染样式量取，保证与文字本体的度量完全一致。
function refreshWordCuts() {
  if (!words || !textEl.textContent) return;
  const cs = getComputedStyle(textEl);
  const font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  const cuts = measureCharWidths(textEl.textContent, font);
  wordCuts = cuts && cuts.length === words.length ? cuts : null;
  if (!wordCuts) words = null;   // 度量失败则回退整行线性扫描，宁可粗也不能错位
}

// 字号增减：本地即时应用 + 交 Rust 广播持久化。
// 到边界时不再调用（否则每次点击都会白推一次 IPC）。
function bumpFont(delta) {
  const next = Math.min(FONT_MAX, Math.max(FONT_MIN, fontSize + delta));
  if (next === fontSize) return;
  commitDisplay({ fontSize: next });
}
// ───────────────────────── 显示形态 / 视觉模式 ─────────────────────────
// 本页只负责 **CSS 层面**的切换（data-form / data-style）。
// 单双行的**窗口高度**（56 → 88）必须由 Rust 侧真的改窗口尺寸 ——
// 留一块透明区来「假装双行」会让条下方那段区域吞掉鼠标，破坏穿透。
// 故这里只更新本地状态与 DOM，尺寸变更与持久化都交给 Rust
// （lyric_commit_display 会改尺寸并广播出去，由主窗口落盘）。
function applyDisplay(cfg) {
  const f = cfg?.form, s = cfg?.style, al = cfg?.align;
  const size = cfg?.fontSize, ct = cfg?.colorText, cf = cfg?.colorFill, off = cfg?.offset;
  form = FORMS.includes(f) ? f : "single";
  styleMode = STYLES.includes(s) ? s : "stroke";
  align = ALIGNS.includes(al) ? al : "center";
  bar.dataset.form = form;
  bar.dataset.style = styleMode;
  bar.dataset.align = align;
  if (typeof size === "number") setFontSize(size);
  // 配色："" = 回到默认（文字近白 / 染色跟随主题品牌色）。
  // 回退必须用 removeProperty 而非 setProperty(name, "") —— 空值的自定义属性
  // 会让 var() 替换出非法声明、回退行为不可预期；移除后 CSS 里的 fallback 才生效。
  const rootStyle = document.documentElement.style;
  if (typeof ct === "string") {
    colorText = ct;
    ct ? rootStyle.setProperty("--ly-color-text", ct) : rootStyle.removeProperty("--ly-color-text");
  }
  if (typeof cf === "string") {
    colorFill = cf;
    cf ? rootStyle.setProperty("--ly-color-fill", cf) : rootStyle.removeProperty("--ly-color-fill");
  }
  // 时间偏移：半秒步进，clamp ±5。本页只存生效值；推送节奏由主窗口驱动。
  if (typeof off === "number" && isFinite(off)) offsetVal = Math.max(-5, Math.min(5, Math.round(off * 2) / 2));
  syncLockBtn();
}

// 用户/弹窗改配置 → 本地先应用（即时反馈），再交 Rust 广播持久化（主窗口落盘）。
// payload 恒带全部字段：任一入口改动，另一侧都能拿到完整配置。
function commitDisplay(patch) {
  const payload = {
    form: patch.form ?? form,
    style: patch.style ?? styleMode,
    align: patch.align ?? align,
    fontSize: patch.fontSize ?? fontSize,
    colorText: patch.colorText ?? colorText,
    colorFill: patch.colorFill ?? colorFill,
    offset: patch.offset ?? offsetVal,
  };
  applyDisplay(payload);
  invoke("lyric_commit_display", payload).catch(() => {});
}

// ───────────────────────── 锁定 / 穿透 ─────────────────────────
// 锁定态下窗口对鼠标**完全透明**（WS_EX_TRANSPARENT）：鼠标事件不会到达本页。
// 因此「悬停解锁」**不可能在本页实现** —— 它由 Rust 侧的悬停探测线程完成
// （轮询光标位置与窗口矩形做命中测试，命中即解锁、移出延时后锁回），
// 结果通过 `lyric://locked` 事件下发到本页（见下方监听）。
//
// 本页的锁定按钮是**双向**的：
//   · 点「锁定」→ 立即穿透。此后本页收不到鼠标事件，但悬停探测线程仍会在
//     鼠标移入时解锁，工具条仍能再次出现 —— 不会把自己锁死。
//   · 点「解锁」→ 解锁并置 sticky，探测线程不再自动锁回。
//     用于「我要反复拖动 / 调样式，别锁回去」；否则鼠标一移开就又被锁上，按钮等于没用。
//     想回到自动行为，点「锁定」即可清掉 sticky。
let sticky = false;      // 是否「保持解锁」（由 Rust 下发，页面不自行推断）

function setLocked(v) {
  locked = !!v;
  bar.dataset.locked = locked ? "true" : "false";
  invoke("lyric_set_locked", { locked });
}

function syncLockBtn() {
  if (!btnLock) return;
  btnLock.textContent = locked ? "解锁" : "锁定";
  btnLock.title = locked
    ? "解锁：鼠标可操作歌词条（保持解锁，不自动锁回）"
    : "锁定：穿透鼠标，可点到底下的窗口/图标";
  // 常驻解锁时高亮，一眼看出「现在不会被自动锁回」
  btnLock.classList.toggle("active", !locked && sticky);
}

// ───────────────────────── 拖动 ─────────────────────────
// 手动拖动（而非 -webkit-app-region: drag）：后者在 transparent + decorations(false)
// 的窗口上表现不稳（可能丢失透明合成），且无法做吸附与参考线。
// pointermove 在 120Hz 鼠标下每秒可触发上百次 → 用 rAF 合帧，每帧最多一次 IPC，
// 否则每次 IPC + SetWindowPos 会造成明显拖顿。拖动期间**不落盘**，松手才提交。
let drag = null;

async function onDown(e) {
  if (locked || !win) return;
  if (e.button !== 0) return;
  // 工具条按钮与设置菜单区域都不触发拖动：菜单项是 .ly-mi（非 .ly-btn），
  // 不排除的话按下菜单项会启动拖动并 setPointerCapture —— 后续 click 被重定向到
  // #bar，菜单项的 click 处理器永远收不到（「点菜单没反应」的根源），
  // 且鼠标稍动整个歌词条就被拖走（「菜单位置不对」的同一根源）。
  if (e.target.closest(".ly-btn")) return;   // 工具条按钮不触发拖动
  let pos, scale;
  try {
    pos = await win.outerPosition();
    scale = await win.scaleFactor();
  } catch { return; }
  if (!pos) return;
  drag = {
    sx: e.screenX, sy: e.screenY,      // 起点（CSS px）
    px: pos.x, py: pos.y,              // 窗口起点（物理 px）
    scale: scale || 1,
    tx: null, ty: null, raf: 0,
    moved: false,                      // 未实际移动前不算拖动（见 onMove）
  };
  // 按下瞬间**不加** dragging 视觉态：dragging = opacity 0.85（半透明发灰），
  // 单纯点击歌词也会闪一下灰 ——「点击一闪一闪变灰」的根源。
  // 拖动视觉态延迟到 onMove 里位移超过阈值才进入（见 DRAG_THRESHOLD）。
  try { bar.setPointerCapture(e.pointerId); } catch {}
}

// 位移超过该值（CSS px）才视为拖动：区分「点击」与「拖动」，点击零视觉变化
const DRAG_THRESHOLD = 3;

function onMove(e) {
  if (!drag) return;
  const dx = e.screenX - drag.sx;
  const dy = e.screenY - drag.sy;
  if (!drag.moved) {
    if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
    drag.moved = true;
    bar.classList.add("dragging");     // 真拖动才进入半透明视觉态
  }
  // screenX/Y 是 CSS px，乘 scaleFactor 换成物理 px 才能与窗口坐标同量纲
  drag.tx = drag.px + dx * drag.scale;
  drag.ty = drag.py + dy * drag.scale;
  if (drag.raf) return;
  drag.raf = requestAnimationFrame(() => {
    if (!drag) return;
    drag.raf = 0;
    if (drag.tx != null) invoke("lyric_move", { x: Math.round(drag.tx), y: Math.round(drag.ty) });
  });
}

function onUp() {
  if (!drag) return;
  const d = drag;
  drag = null;
  if (d.raf) cancelAnimationFrame(d.raf);
  bar.classList.remove("dragging");
  // 未实际拖动（纯点击）不提交位置：省一次 IPC，也避免落盘抖动
  const apply = d.moved && d.tx != null
    ? invoke("lyric_move", { x: Math.round(d.tx), y: Math.round(d.ty) })
    : Promise.resolve();
  apply.then(commitPos).catch(() => {});
}

// 拖动结束：把位置换算为**相对工作区的比例**交回主窗口落盘。
// 用比例而非绝对像素：换分辨率或接/拔外接显示器后，绝对像素会让歌词条落到屏幕外「消失」。
async function commitPos() {
  if (!win || !TAURI?.window?.availableMonitors) return;
  try {
    const [pos, size, mon, mons] = await Promise.all([
      win.outerPosition(), win.outerSize(), win.currentMonitor(), TAURI.window.availableMonitors(),
    ]);
    if (!pos || !size || !mon) return;
    const wa = mon.workArea;
    const availW = wa.size.width - size.width;
    const availH = wa.size.height - size.height;
    const idx = (mons || []).findIndex(
      (m) => m.position.x === mon.position.x && m.position.y === mon.position.y
    );
    await invoke("lyric_pos_commit", {
      xRatio: clamp01(availW > 0 ? (pos.x - wa.position.x) / availW : 0.5),
      yRatio: clamp01(availH > 0 ? (pos.y - wa.position.y) / availH : 0.92),
      monitorIndex: idx < 0 ? 0 : idx,
    });
  } catch { /* 位置提交失败不影响显示 */ }
}

// ───────────────────────── 事件接线 ─────────────────────────
bar.addEventListener("pointerdown", onDown);
bar.addEventListener("pointermove", onMove);
bar.addEventListener("pointerup", onUp);
bar.addEventListener("pointercancel", onUp);

// 锁定 / 解锁：双向切换。锁定时窗口立即穿透（本页再也收不到鼠标事件），
// 但悬停探测线程会在鼠标移入时重新解锁，故不会把自己锁死。
btnLock.addEventListener("click", () => setLocked(!locked));
document.getElementById("btn-smaller").addEventListener("click", () => bumpFont(-FONT_STEP));
document.getElementById("btn-bigger").addEventListener("click", () => bumpFont(FONT_STEP));
// 设置：切换独立设置弹窗（lyric_menu 窗口）的显示/隐藏 —— 菜单是独立窗口，
// 歌词条窗口自身不做任何尺寸变化（「点设置闪一下」的机制性根治）
document.getElementById("btn-panel").addEventListener("click", () => invoke("lyric_menu_toggle"));
document.getElementById("btn-close").addEventListener("click", () => {
  invoke("hide_lyric").catch(() => {});
});

// ───────────────────────── 启动握手 ─────────────────────────
// 顺序至关重要：**先注册 listener，再调 lyric_ready**。
// 反过来的话，Rust 侧在 ready 后立即 emit，事件会在 listener 注册完成前发出而丢失
// （reminder.js 用同一套握手规避过这个竞态）。
setFontSize(fontSize);
syncLockBtn();
// 先渲染占位行，确保「窗口可见 ⟺ 有内容」：即便 lyric_ready 后没有任何推送，
// 用户看到的也是一条有意义的占位歌词，而不是空白透明窗。
renderLine({ text: "", idle: true });
// 刻意**不**在此处 setLocked(false)：
// 初始锁定态由 Rust 统一推导（读 state + 悬停解锁开关），并在 lyric_ready 时经
// `lyric://locked` 下发。页面若在这里硬编码一次解锁，会覆盖掉 Rust 的判定，
// 导致「默认配置下启动即穿透」失效 —— 歌词条一开始就拦住桌面点击。
// 页面在收到通知前保持 HTML 默认值（data-locked="true"），即「未知 = 按锁定处理」的安全侧。

let readySent = false;
const sendReady = () => {
  if (readySent) return;
  readySent = true;
  invoke("lyric_ready").catch((e) => console.warn("[lyric] 就绪握手失败：", e));
};

Promise.all([
  listen("lyric://line", (e) => renderLine(e?.payload)),
  // Rust 悬停探测线程下发的锁定态（命中→解锁、移出延时→锁回）。
  // 本页只是**执行方**：探测在 Rust 侧，因为锁定态下窗口收不到鼠标事件。
  listen("lyric://locked", (e) => {
    const p = e?.payload || {};
    const v = !!p.locked;
    locked = v;
    sticky = !!p.sticky;
    bar.dataset.locked = v ? "true" : "false";
    // 按钮文字跟随真实穿透态（「锁定」/「解锁」）。这条通道同时服务：
    // 悬停探测线程的自动解锁、外部发起（设置页/热键）、以及本页点击的回声。
    syncLockBtn();
    // 「悬停解锁」关掉时，锁上就再无回到可交互的途径（悬停不会解锁），
    // 故此时禁用锁定按钮 —— 宁可不给点，也不要把用户锁死。
    if (btnLock && p.hoverUnlock === false) {
      btnLock.disabled = true;
      btnLock.title = "悬停解锁已关闭，锁定后将无法从歌词条解锁（请先在设置中开启）";
    } else if (btnLock) {
      btnLock.disabled = false;
    }
  }),
  listen("lyric://display", (e) => {
    const p = e?.payload || {};
    // 权威配置由 Rust 下发（新建窗口、设置页改动、歌词页自身改动的回执都走这里）
    applyDisplay({
      form: p.form,
      style: p.style,
      align: p.align,
      fontSize: typeof p.fontSize === "number" ? p.fontSize : undefined,
      colorText: typeof p.colorText === "string" ? p.colorText : undefined,
      colorFill: typeof p.colorFill === "string" ? p.colorFill : undefined,
      offset: typeof p.offset === "number" ? p.offset : undefined,
    });
  }),
  // 主窗口收起歌词（点音乐页按钮 / 设置里关开关）→ 本页无需动作，Rust 已销毁窗口。
])
  .then(sendReady)
  .catch((err) => {
    console.warn("[lyric] 监听注册失败：", err);
    // 监听失败仍要握手，否则窗口永远不显示（宁可显示占位行也不要静默不出）。
    sendReady();
  });

// 孤儿兜底：页面加载后始终未收到任何内容推送时，占位行已经渲染，
// 故不存在「可见但空白」的空窗；此处只在页面被卸载时清理 rAF，避免泄漏。
window.addEventListener("beforeunload", () => {
  if (rafId) cancelAnimationFrame(rafId);
});
