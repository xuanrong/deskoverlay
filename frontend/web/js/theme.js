// 主题运行时 — 主题系统三层模型的中间层。
// 职责：读 ThemeConfig（state.theme）→ 计算 CSS 变量/data 属性 → 写 DOM → 持久化。
// 约束：
//  - computeThemeVars 为纯函数，锁屏/提醒窗口复用同一份计算逻辑（经 get_theme 拉取快照）。
//  - style.css 永远不知道具体皮肤存在；皮肤只是一份预填的 ThemeConfig 模板。
//  - apply 幂等：广播回来重复应用无副作用。
import { state, saveState } from "./state.js";
import { invoke, Bus } from "./bus.js";

// -------------------- 默认配置 --------------------
export const DEFAULT_THEME = {
  version: 1,
  scheme: "dark",            // "dark" | "light" | "auto"
  skinId: "builtin/default-dark",
  accent: { mode: "preset", presetId: "blue", hsl: [211, 100, 67] },
  background: {
    type: "none",            // "none" | "image" | "color" | "gradient"
    imageRef: "",            // 本地图片绝对路径（经 pick_file 选取）
    fit: "cover",            // cover | contain | fill
    color: "#0a0e15",
    gradient: { from: "#0a0e15", to: "#1a2332", angle: 160 },
    dim: 0.35,               // 暗化遮罩强度 0~1
  },
  glass: {
    panelAlpha: 0.72,        // 主面板不透明度 0.4~0.95
    blurMult: 1,             // 模糊倍率 0~1.5（0 = 关闭模糊；作用于三档 blur token）
  },
  overrides: {},             // 高级 token 覆盖 { "--radius": "14px" }
};

// 预设主题色（与旧版语义色对齐的 HSL 基准）
export const ACCENT_PRESETS = [
  { id: "blue",   name: "蓝", hsl: [211, 100, 67] },
  { id: "cyan",   name: "青", hsl: [187, 57, 52] },
  { id: "green",  name: "绿", hsl: [137, 55, 48] },
  { id: "amber",  name: "金", hsl: [40, 71, 48] },
  { id: "red",    name: "红", hsl: [6, 100, 72] },
  { id: "purple", name: "紫", hsl: [265, 100, 77] },
];

// 内置皮肤 = 预填的 ThemeConfig 模板（scheme/accent/background/glass）
export const BUILTIN_SKINS = [
  {
    id: "builtin/default-dark", name: "午夜玻璃", scheme: "dark",
    config: { scheme: "dark", accent: { mode: "preset", presetId: "blue", hsl: [211, 100, 67] },
      background: { type: "none" }, glass: { panelAlpha: 0.72, blurMult: 1 } },
  },
  {
    id: "builtin/aurora", name: "极光", scheme: "dark",
    config: { scheme: "dark", accent: { mode: "preset", presetId: "cyan", hsl: [187, 57, 52] },
      background: { type: "gradient", gradient: { from: "#071019", to: "#0d2b33", angle: 160 }, dim: 0 },
      glass: { panelAlpha: 0.68, blurMult: 1 } },
  },
  {
    id: "builtin/sunset", name: "暮色", scheme: "dark",
    config: { scheme: "dark", accent: { mode: "preset", presetId: "amber", hsl: [40, 71, 48] },
      background: { type: "gradient", gradient: { from: "#160f0a", to: "#2b1a0d", angle: 200 }, dim: 0 },
      glass: { panelAlpha: 0.7, blurMult: 1 } },
  },
  {
    id: "builtin/paper", name: "纸面", scheme: "light",
    config: { scheme: "light", accent: { mode: "preset", presetId: "blue", hsl: [211, 100, 55] },
      background: { type: "none" }, glass: { panelAlpha: 0.85, blurMult: 0.7 } },
  },
  {
    id: "builtin/matcha", name: "抹茶", scheme: "light",
    config: { scheme: "light", accent: { mode: "preset", presetId: "green", hsl: [137, 55, 40] },
      background: { type: "gradient", gradient: { from: "#eef3ea", to: "#dfe9dc", angle: 160 }, dim: 0 },
      glass: { panelAlpha: 0.82, blurMult: 0.7 } },
  },
];

// -------------------- 颜色计算（纯函数） --------------------
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// HSL(h 0-360, s/l 0-100) → "r, g, b"
export function hslToRgb(h, s, l) {
  s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)].map((v) => Math.round(v * 255));
}

// HSL → 相对亮度（WCAG）
function relLumFromHsl(h, s, l) {
  const [r, g, b] = hslToRgb(h, s, l).map((v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// accent 派生：基准 / hover 深色 / 透明底 RGB / 按钮对比文字色。
// 可读性保障（对比度驱动，而非亮度钳制——同亮度不同色相的实际对比度差异很大，
// 例如金色 L48 在深底可达 7.5:1，紫色 L45 仅 2.3:1）：
//   沿色阶微调 L，直到 accent 对该方案底色的对比度 ≥ 4.5:1（正文级），
//   并保留方案级软边界（深底提亮上限 85 / 浅底压暗下限 22）。
// 色相/饱和度始终不变；默认色均已在达标区间，视觉零变化。
export function computeAccent(hsl, scheme = "dark") {
  const [h, s, lRaw] = hsl;
  let l = clamp(lRaw, 25, 85);
  const bgLum = scheme === "light" ? relLumFromHsl(220, 30, 95) : relLumFromHsl(215, 25, 6);
  const contrastAt = (lv) => {
    const lum = relLumFromHsl(h, s, lv);
    return (Math.max(lum, bgLum) + 0.05) / (Math.min(lum, bgLum) + 0.05);
  };
  const dir = scheme === "light" ? -1 : 1; // 浅底向暗调、深底向亮调
  let guard = 24;
  while (contrastAt(l) < 4.5 && guard-- > 0) {
    const next = l + dir * 3;
    if (scheme === "light" ? next < 22 : next > 85) break;
    l = next;
  }
  const deepL = clamp(l - 15, 20, 90);
  const rgb = hslToRgb(h, s, l);
  return {
    accent: `hsl(${Math.round(h)}, ${Math.round(s)}%, ${Math.round(l)}%)`,
    accentRgb: rgb.join(", "),
    accentDeep: `hsl(${Math.round(h)}, ${Math.round(s)}%, ${Math.round(deepL)}%)`,
    accentContrast: l > 55 ? "#06121f" : "#ffffff",
    clamped: l !== clamp(lRaw, 25, 85),
  };
}

// ThemeConfig → { scheme, vars } 纯计算（锁屏/提醒窗口复用）。
// scheme=auto 在此解析为当前系统方案（matchMedia），保证 data-scheme 永远是 dark|light。
export function computeThemeVars(cfg) {
  const c = normalizeTheme(cfg);
  const scheme = resolveScheme(c.scheme);
  const a = computeAccent(c.accent.hsl, scheme);
  const alpha = clamp(c.glass.panelAlpha, 0.4, 0.95);
  const m = clamp(c.glass.blurMult, 0, 1.5);
  const vars = {
    "--accent": a.accent,
    "--accent-rgb": a.accentRgb,
    "--accent-deep": a.accentDeep,
    "--accent-contrast": a.accentContrast,
    "--panel-alpha": String(alpha),
    "--panel-alpha-2": String(clamp(alpha - 0.06, 0.35, 0.95)),
    "--panel-alpha-elevated": String(clamp(alpha + 0.18, 0.5, 0.97)),
    "--blur-scrim": `${Math.round(6 * m)}px`,
    "--blur-panel": `${Math.round(20 * m)}px`,
    "--blur-overlay": `${Math.round(28 * m)}px`,
  };
  return { scheme, skinId: c.skinId, vars, config: c };
}

// -------------------- 归一化（老数据/非法值防御） --------------------
export function normalizeTheme(raw) {
  const t = raw && typeof raw === "object" ? raw : {};
  const out = structuredClone(DEFAULT_THEME);
  if (t.scheme === "dark" || t.scheme === "light" || t.scheme === "auto") out.scheme = t.scheme;
  if (typeof t.skinId === "string" && t.skinId) out.skinId = t.skinId;
  if (t.accent && typeof t.accent === "object") {
    if (t.accent.mode === "preset" || t.accent.mode === "custom") out.accent.mode = t.accent.mode;
    if (typeof t.accent.presetId === "string") out.accent.presetId = t.accent.presetId;
    if (Array.isArray(t.accent.hsl) && t.accent.hsl.length === 3 && t.accent.hsl.every((n) => typeof n === "number")) {
      out.accent.hsl = [clamp(t.accent.hsl[0], 0, 360), clamp(t.accent.hsl[1], 0, 100), clamp(t.accent.hsl[2], 0, 100)];
    }
  }
  if (t.background && typeof t.background === "object") {
    const b = t.background, ob = out.background;
    if (["none", "image", "color", "gradient"].includes(b.type)) ob.type = b.type;
    if (typeof b.imageRef === "string") ob.imageRef = b.imageRef;
    if (["cover", "contain", "fill"].includes(b.fit)) ob.fit = b.fit;
    if (typeof b.color === "string" && b.color) ob.color = b.color;
    if (b.gradient && typeof b.gradient === "object") {
      if (typeof b.gradient.from === "string") ob.gradient.from = b.gradient.from;
      if (typeof b.gradient.to === "string") ob.gradient.to = b.gradient.to;
      if (typeof b.gradient.angle === "number") ob.gradient.angle = clamp(b.gradient.angle, 0, 360);
    }
    if (typeof b.dim === "number") ob.dim = clamp(b.dim, 0, 0.85);
  }
  if (t.glass && typeof t.glass === "object") {
    if (typeof t.glass.panelAlpha === "number") out.glass.panelAlpha = clamp(t.glass.panelAlpha, 0.4, 0.95);
    if (typeof t.glass.blurMult === "number") out.glass.blurMult = clamp(t.glass.blurMult, 0, 1.5);
  }
  if (t.overrides && typeof t.overrides === "object" && !Array.isArray(t.overrides)) {
    for (const [k, v] of Object.entries(t.overrides)) {
      if (k.startsWith("--") && (typeof v === "string" || typeof v === "number")) out.overrides[k] = v;
    }
  }
  return out;
}

// -------------------- DOM 应用 --------------------
let systemMql = null;
let systemHandler = null;
let bgDataUrl = "";          // imageRef 对应的 data URL 缓存（仅 asset 协议不可用时的回退）
let bgDataUrlFor = "";       // 缓存对应的 imageRef

// scheme 解析：auto → 跟随系统 prefers-color-scheme（不可用时默认深色）
function resolveScheme(scheme) {
  if (scheme !== "auto") return scheme;
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  } catch { return "dark"; }
}

// 背景图 URL 解析（2026-09-16 优化）：
//   优先 Rust prepare_wallpaper —— 预缩放屏幕尺寸副本 + asset:// 协议引用，
//   JS 零常驻字符串、位图仅 ~8MB（原 data URL 链路 ~50MB）。
//   命令缺失（旧后端/浏览器 dev）或预处理失败时回退原 data URL 链路。
async function resolveBackdropUrl(cfg) {
  if (cfg.background.type !== "image" || !cfg.background.imageRef) return "";
  try {
    const p = await invoke("prepare_wallpaper", { path: cfg.background.imageRef });
    if (p && p.ok && p.assetUrl) return p.assetUrl;
  } catch (_) { /* 旧后端无此命令 → 回退 */ }
  if (bgDataUrlFor === cfg.background.imageRef && bgDataUrl) return bgDataUrl;
  try {
    const dataUrl = await invoke("read_bg_data_url", { path: cfg.background.imageRef });
    if (dataUrl) { bgDataUrl = dataUrl; bgDataUrlFor = cfg.background.imageRef; }
    return dataUrl;
  } catch (e) {
    console.warn("[theme] 背景图读取失败", e);
    return "";
  }
}

// 渲染 #theme-backdrop（无该层的页面自动跳过）
function renderBackdrop(doc, cfg, url) {
  const root = doc.getElementById("theme-backdrop");
  if (!root) return;
  const media = root.querySelector(".tb-media");
  const dim = root.querySelector(".tb-dim");
  const b = cfg.background;
  if (b.type === "none" || (b.type === "image" && !url)) {
    root.classList.remove("active");
    if (media) media.style.background = "";
    if (dim) dim.style.background = "none";
    return;
  }
  root.classList.add("active");
  if (media) {
    if (b.type === "image") {
      media.style.background = `url("${url}") center/${b.fit} no-repeat`;
    } else if (b.type === "color") {
      media.style.background = b.color;
    } else {
      media.style.background = `linear-gradient(${b.gradient.angle}deg, ${b.gradient.from}, ${b.gradient.to})`;
    }
  }
  if (dim) dim.style.background = b.dim > 0 ? `rgba(0, 0, 0, ${b.dim})` : "none";
}

// 方案切换一次性过渡（不常驻，避免拖慢其他属性）
function withTransition(doc, fn) {
  const html = doc.documentElement;
  html.classList.add("theme-transition");
  try { fn(); } finally {
    setTimeout(() => html.classList.remove("theme-transition"), 300);
  }
}

// 幂等应用：方案 → 变量 → 背景层。opts.transition 控制是否带过渡动画。
export async function applyTheme(doc, cfg, opts = {}) {
  const { scheme, vars, skinId, config } = computeThemeVars(cfg);
  const html = doc.documentElement;
  const run = () => {
    html.dataset.scheme = scheme;
    html.dataset.skin = skinId;
    for (const [k, v] of Object.entries(vars)) html.style.setProperty(k, v);
    for (const [k, v] of Object.entries(config.overrides || {})) html.style.setProperty(k, String(v));
  };
  if (opts.transition) withTransition(doc, run); else run();
  const url = await resolveBackdropUrl(config);
  // 背景图为异步解析：解析完成后仅重渲染背景层，不重放过渡
  renderBackdrop(doc, config, url);
  return config;
}

// -------------------- 锁屏 / 提醒窗口 · 主题快照 --------------------
// 设计文档 §A.2：两页面保持零依赖自足，只经 get_theme 拉取快照 + theme://updated 热应用。
// lockMode=true 时强制深色 + 忽略背景/皮肤（隐私优先于皮肤，§A.6）。
export async function applyThemeSnapshot(doc, { lockMode = false } = {}) {
  const TAURI = typeof window !== "undefined" && window.__TAURI__;
  const forceDark = (c) => lockMode
    ? { ...c, scheme: "dark", skinId: "builtin/default-dark", background: { ...c.background, type: "none" } }
    : c;
  let raw = null;
  try {
    if (TAURI?.core?.invoke) raw = await TAURI.core.invoke("get_theme");
  } catch (e) { console.warn("[theme] 快照拉取失败，使用默认深色", e); }
  await applyTheme(doc, forceDark(normalizeTheme(raw)));
  try {
    if (TAURI?.event?.listen) {
      await TAURI.event.listen("theme://updated", async (e) => {
        await applyTheme(doc, forceDark(normalizeTheme(e?.payload)), { transition: true });
      });
    }
  } catch { /* 广播不可用时静默：快照已保证启动一致性 */ }
}

// -------------------- 主窗口控制器（持久化 + 广播 + 系统跟随） --------------------
export const Theme = {
  config: structuredClone(DEFAULT_THEME),
  _inited: false,

  // 启动时调用（loadState 之后）
  async init() {
    this.config = normalizeTheme(state.theme);
    await applyTheme(document, this.config);
    this._watchSystem();
    this._listenBroadcast();
    this._inited = true;
  },

  get() { return this.config; },

  // 局部合并更新。opts.persist=false 供滑杆拖动实时预览（只写 DOM 不落盘）。
  async update(partial, opts = {}) {
    this.config = normalizeTheme({ ...this.config, ...partial });
    await applyTheme(document, this.config, { transition: opts.transition });
    Bus.emit("theme:changed", this.config);
    if (opts.persist !== false) await this._persist();
    return this.config;
  },

  setScheme(scheme, opts = {}) { return this.update({ scheme }, { transition: true, ...opts }); },

  setAccent(accent, opts = {}) {
    return this.update({ accent: { ...this.config.accent, ...accent }, skinId: "custom" }, opts);
  },

  setBackground(partial, opts = {}) {
    return this.update({ background: { ...this.config.background, ...partial } }, opts);
  },

  setGlass(partial, opts = {}) { return this.update({ glass: { ...this.config.glass, ...partial } }, opts); },

  // 一键换肤：scheme/accent/background/glass 整套替换（overrides 保留）
  async applySkin(skinId) {
    const skin = BUILTIN_SKINS.find((s) => s.id === skinId);
    if (!skin) return this.config;
    this.config = normalizeTheme({
      ...this.config,
      skinId: skin.id,
      scheme: skin.config.scheme,
      accent: structuredClone(skin.config.accent),
      background: { ...structuredClone(DEFAULT_THEME.background), ...structuredClone(skin.config.background) },
      glass: { ...structuredClone(skin.config.glass) },
    });
    await applyTheme(document, this.config, { transition: true });
    Bus.emit("theme:changed", this.config);
    await this._persist();
    return this.config;
  },

  reset() {
    return this.update(structuredClone(DEFAULT_THEME), { transition: true });
  },

  async _persist() {
    state.theme = this.config;
    try { await saveState(); } catch (e) { console.warn("[theme] 持久化失败", e); }
    try { await invoke("broadcast_theme", { theme: this.config }); } catch { /* 浏览器 dev 态无此命令 */ }
  },

  // scheme=auto 时跟随系统深浅
  _watchSystem() {
    try {
      if (systemMql && systemHandler) systemMql.removeEventListener("change", systemHandler);
      systemMql = window.matchMedia("(prefers-color-scheme: dark)");
      systemHandler = () => {
        if (this.config.scheme === "auto") applyTheme(document, this.config, { transition: true });
      };
      systemMql.addEventListener("change", systemHandler);
    } catch { /* matchMedia 不可用时忽略 */ }
  },

  // Rust 广播（其他窗口改了主题）→ 幂等热应用，不回写
  _listenBroadcast() {
    try {
      const TAURI = typeof window !== "undefined" && window.__TAURI__;
      if (TAURI?.event?.listen) {
        TAURI.event.listen("theme://updated", (e) => {
          const incoming = normalizeTheme(e?.payload);
          // 只在内容确实不同时应用，避免广播回声
          if (JSON.stringify(incoming) !== JSON.stringify(this.config)) {
            this.config = incoming;
            applyTheme(document, incoming);
          }
        });
      }
    } catch { /* 忽略 */ }
  },
};
