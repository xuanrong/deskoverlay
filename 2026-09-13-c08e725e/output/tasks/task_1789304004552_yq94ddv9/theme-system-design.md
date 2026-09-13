# DeskOverlay 主题系统设计方案

> 版本：v1.0（设计稿，未实施）
> 范围：深色/浅色切换 · 自定义主题色 · 换肤 · 自定义背景
> 关联：`frontend/web/css/style.css`（token 体系）、`frontend/web/js/store.js`（持久化）、`frontend/web/js/views/settings.js`（设置页）、`lock.html` / `reminder.html`（独立窗口）

---

## 1. 现状与约束

### 1.1 现有资产（可复用）

| 资产 | 位置 | 对主题系统的意义 |
|---|---|---|
| 完整 token 体系 | `style.css` `:root`（颜色/排版/间距/圆角/阴影） | 主题切换 = 换 token 值，无需改组件 |
| 语义别名层 | `--primary/--success/--warning/--error` 指向原始色 | 主题色注入只需改一层 |
| RGB 分量 token | `--blue-rgb` 等用于构造透明色 | 主题色需要配套 `--accent-rgb` |
| 持久化通道 | `Store.load/save` → Rust `state.json` | 主题配置直接挂在 state 上，零新基建 |
| 设置页骨架 | `views/settings.js` | 外观设置作为新分区挂入 |
| 插件包机制 | `.zip` 插件（manifest.json） | 未来皮肤包可对齐此模式 |

### 1.2 硬约束

1. **无打包器**：原生 ESM，主题系统必须是纯运行时方案（CSS 变量 + `data-*` 属性），不能依赖构建期注入。
2. **桌面即背景**：应用嵌入 WorkerW，`--bg-base` 之下就是真实壁纸。自定义背景不是"给应用换壁纸"，而是"在桌面上叠加一层可控的视觉层"。
3. **三个 HTML 入口**：`index.html`、`lock.html`、`reminder.html` 是独立 WebView，主题必须三处一致。
4. **玻璃拟态**：面板是 `rgba` 半透明 + backdrop-filter。浅色主题下玻璃质感要重新推导，不能简单反色。
5. **state.json 兼容**：新增字段必须走 `DEFAULTS` 合并，老用户 state 无 theme 字段时要静默补默认值。

---

## 2. 总体架构：三层模型

```
┌─────────────────────────────────────────────────────┐
│  皮肤层（Skin）      预置/未来的完整视觉包            │
│  = scheme + accent + background + token 覆盖包      │
├─────────────────────────────────────────────────────┤
│  主题层（theme.js 运行时）                           │
│  输入: ThemeConfig（持久化于 state.theme）           │
│  输出: <html> 上的 data-scheme / data-skin 属性      │
│        + 一组内联 CSS 变量（accent / 背景 / 透明度） │
├─────────────────────────────────────────────────────┤
│  Token 层（style.css）                               │
│  L0 原始色板（不变）                                 │
│  L1 方案 token   :root[data-scheme="dark"|"light"]   │
│  L2 组件 token   消费 L1 + 内联变量，保持不变         │
└─────────────────────────────────────────────────────┘
```

核心原则：**皮肤和自定义都只是"数据"，运行时把数据编译成 CSS 变量与属性；style.css 永远不知道具体皮肤存在。**

---

## 3. 数据模型

### 3.1 ThemeConfig（持久化结构，挂 `state.theme`）

```js
theme: {
  version: 1,
  scheme: "dark",            // "dark" | "light" | "auto"（auto 跟随系统 prefers-color-scheme）
  skinId: "default-dark",    // 当前皮肤（见 §6）
  accent: {
    mode: "preset",          // "preset" | "custom"
    presetId: "blue",        // 预设色板 id
    hsl: [211, 100, 67],     // custom 模式下的 HSL 基准色
  },
  background: {
    type: "none",            // "none" | "image" | "color" | "gradient"
    imageRef: "",            // image 模式：已拷入 app_data 的文件名（非原始路径）
    fit: "cover",            // image 显示模式: cover | contain | fill
    color: "#0a0e15",        // color 模式
    gradient: { from: "#0a0e15", to: "#1a2332", angle: 160 }, // gradient 模式
    dim: 0.35,               // 0~1 暗化遮罩强度（保证文字可读）
  },
  glass: {
    panelAlpha: 0.72,        // 面板不透明度 0.4~0.95
    blur: 18,                // backdrop-filter px
  },
  overrides: {},             // 高级：token 级覆盖 { "--radius-lg": "14px" }，皮肤/未来设置用
}
```

### 3.2 关键决策

- **scheme 与皮肤解耦但皮肤携带默认值**：用户可直接切深/浅色，皮肤只是"一键填好一整套 config"。
- **accent 用 HSL 存储**：方便派生 hover/active/soft 等梯度（只调 L 和 S），也方便取色器回填。
- **背景图只存 imageRef**：选图后由 Tauri 端拷贝到 `app_data/theme/bg.<ext>`，state 不存绝对路径（跨机器/重装安全）。
- **overrides 留白但实现**：一行 merge 逻辑就能支撑未来的"高级自定义"，成本低收益高。

---

## 4. CSS 分层策略（style.css 改造）

### 4.1 Token 三层拆分

现有 `:root` 拆成三层，**组件代码零改动**（仍消费同名变量）：

```css
/* L0 原始色板：主题无关，保持唯一来源 */
:root {
  --blue-500: #58a6ff; --green-500: #3fb950; --amber-500: #d29922;
  --danger-500: #ff7b72; --purple-500: #bc8cff; --cyan-500: #39c5cf;
  /* 排版/间距/圆角/阴影刻度也留在这层，主题不触碰 */
}

/* L1 方案 token：默认值 = 深色（现值原样迁入，零视觉回归） */
:root, :root[data-scheme="dark"] {
  --bg-base: #0a0e15;
  --bg-panel: rgba(16, 20, 28, 0.72);
  --text: #e6edf3;  /* …现有全部深色值 */
  /* 语义别名指向 accent 运行时变量，主题色切换只动这里 */
  --primary: var(--accent, var(--blue-500));
  --accent-rgb: var(--accent-rgb-runtime, 88, 166, 255);
}

:root[data-scheme="light"] {
  --bg-base: #eef1f6;
  --bg-panel: rgba(255, 255, 255, 0.66);
  --bg-panel-2: rgba(255, 255, 255, 0.8);
  --bg-elevated: rgba(255, 255, 255, 0.94);
  --bg-input: rgba(0, 0, 0, 0.04);
  --bg-hover: rgba(0, 0, 20, 0.05);
  --border: rgba(10, 20, 40, 0.10);
  --border-strong: rgba(10, 20, 40, 0.18);
  --text: #1a2230; --text-dim: #4a5568; --text-faint: #8b95a5;
  --text-invert: #f5f8fc;
  /* 阴影在浅色下更重（玻璃靠阴影而不是高光区分层级） */
  --shadow-panel: 0 8px 32px rgba(20, 35, 60, 0.12);
  /* 语义色在浅底上的可读版本（L 提一档） */
  --green: #1a7f37; --amber: #9a6700; --danger: #cf222e; --purple: #8250df;
}
```

### 4.2 主题色（accent）派生

运行时只注入 4 个变量，其余全部在 CSS 内派生：

```js
// theme.js 输出（<html> style.setProperty）
"--accent": "hsl(211, 100%, 67%)"
"--accent-rgb-runtime": "88, 166, 255"   // 供 rgba() 透明底
"--accent-deep": "hsl(211, 90%, 52%)"    // hover/active（L-15）
"--accent-soft": "hsl(211, 100%, 67%, 0.14)" // soft 背景
```

派生规则（HSL 数学）：
| 变量 | 规则 | 用途 |
|---|---|---|
| `--accent` | 基准 HSL | 主强调/激活/链接 |
| `--accent-deep` | L − 15（clamp ≥ 25） | hover / 渐变按钮 |
| `--accent-rgb-runtime` | HSL→RGB | `rgba(var(--accent-rgb-runtime), .12)` 等 |
| `--accent-contrast` | L > 55 ? 深色文字 : 白色 | 按钮文字自动对比 |

浅色方案下派生方向翻转：`--accent-deep` 改为 L − 10（浅底下 accent 本身即可作 hover）。若用户自选色过亮/过暗（L < 25 或 L > 85），运行时自动 clamp 到可读区间并在设置页提示。

### 4.3 背景与玻璃的运行时注入

背景层结构（`index.html` 首个元素，桌面壁纸之上、一切 UI 之下）：

```html
<div id="theme-backdrop" aria-hidden="true"></div>
```

```css
#theme-backdrop { position: fixed; inset: 0; z-index: -1; }
```

运行时按 `background.type` 写内联样式：
- `image`：`background: url(<tauri-asset-url>) center/cover`，上面叠 `rgba(0,0,0,var(--bg-dim))` 遮罩层；
- `gradient`：`linear-gradient(<angle>, from, to)`；
- `color`：纯色。

玻璃参数同样运行时注入，避免为每个组合写死 CSS：

```js
"--panel-alpha": "0.72"   // style.css: --bg-panel: rgba(var(--panel-tint), var(--panel-alpha))
"--panel-blur": "18px"    // backdrop-filter: blur(var(--panel-blur))
"--bg-dim": "0.35"
```

需要把现有 `--bg-panel` 从"写死 rgba"改为 `rgba(var(--panel-tint), var(--panel-alpha))` 形态，其中 `--panel-tint` 由方案层给（深色 `16,20,28`、浅色 `255,255,255`）。这是一次性的小改造，改完后透明度滑杆实时生效。

---

## 5. 运行时：theme.js 模块设计

新文件 `frontend/web/js/theme.js`，职责单一：**读 config → 写 DOM → 存回 store**。

```js
// 对外 API（约 120 行，无依赖除 bus/store）
Theme.init(state)               // 启动时应用持久化的主题
Theme.get() → ThemeConfig
Theme.setScheme("dark"|"light"|"auto")
Theme.setAccent({mode, presetId, hsl})
Theme.setBackground(partial)    // 局部合并
Theme.setGlass({panelAlpha, blur})
Theme.applySkin(skinId)         // 皮肤 = 整套 config 模板，合并后 apply
Theme.export() / Theme.import() // 未来：主题分享
```

应用流程 `apply(config)`：
1. 解析 scheme（auto → `matchMedia('(prefers-color-scheme: dark)')`，并监听变更）；
2. `document.documentElement.dataset.scheme = "dark"|"light"`；
3. `dataset.skin = skinId`（皮肤特例样式挂钩子，见 §6）；
4. 计算 accent 派生值，`style.setProperty` 注入 4~6 个变量；
5. 渲染 `#theme-backdrop`；
6. 注入 glass 变量；
7. **广播 `bus.emit("theme:changed", config)`**。

### 5.1 多窗口同步（关键点）

`lock.html` / `reminder.html` 不走 app.js。方案：
- 三页共用 `theme.js`（纯函数部分），各自在启动时读同一份 state（锁屏/提醒窗口本就通过 Rust 读 state.json）后调用 `Theme.apply`；
- 主窗口改主题时，Rust 端保存 state.json 后，由主窗口通过 Tauri event 向所有窗口 emit `theme://updated`，锁屏/提醒窗口监听并热应用——避免"改完主题开锁屏颜色还是旧的"。

---

## 6. 换肤（Skin）设计

### 6.1 皮肤定义

皮肤 = **一份预填的 ThemeConfig 模板 + 可选的少量特例样式**，不是平行体系：

```js
const BUILTIN_SKINS = [
  { id: "default-dark",  name: "午夜玻璃", config: { scheme: "dark", accent: {...默认蓝}, glass: {...当前值} } },
  { id: "aurora",        name: "极光",     config: { scheme: "dark", accent: {preset cyan}, background: {type:"gradient", gradient:{from:"#071019",to:"#0d2b33",angle:160}} } },
  { id: "sunset",        name: "暮色",     config: { scheme: "dark", accent: {preset amber}, background: {type:"gradient", ...暖色} } },
  { id: "paper",         name: "纸面",     config: { scheme: "light", accent: {preset blue}, glass: {panelAlpha: 0.85, blur: 12} } },
  { id: "matcha",        name: "抹茶",     config: { scheme: "light", accent: {preset green}, ... } },
];
```

### 6.2 皮肤特例样式（克制使用）

皮肤通过 `data-skin` 属性获得极小的覆盖空间，**只允许改装饰性 token**（阴影、边框色、圆角、点缀），禁止覆盖布局/间距/字号：

```css
:root[data-skin="aurora"] { --shadow-panel: 0 8px 32px rgba(0, 40, 60, .35); }
```

### 6.3 与插件包机制的兼容路径（本期不实现，仅预留）

现有插件 manifest 已有 `ui-theme.json` / `primitives.json`（design/task-theme 中可见雏形）。未来皮肤包 = zip 内含 `skin.json`（ThemeConfig 模板 + 可选 `skin.css`，经清单校验后注入）。本期只保证：皮肤数据结构与未来 zip 字段一一对应，`skinId` 命名空间留 `builtin/` 与 `plugin/` 前缀。

---

## 7. 设置页 UI（settings.js 新增"外观"分区）

```
外观
├─ 主题方案      [ 深色 ] [ 浅色 ] [ 跟随系统 ]     ← 三态分段控件
├─ 皮肤          横向缩略卡画廊（5 个内置），点击即整体应用
├─ 主题色        6 预设色点 + [自定义] 打开 HSL 取色器
│                （预览条实时刷新：按钮 / 链接 / 高亮 三种元素）
├─ 背景          类型选择：无 / 图片 / 纯色 / 渐变
│                图片 → Tauri dialog 选图 → 缩略预览 + 显示模式 + 暗化滑杆
├─ 玻璃质感      面板不透明度滑杆（0.4–0.95） + 模糊强度滑杆（0–30px）
└─ 恢复默认      仅重置 theme 字段
```

交互细节：
- **全部实时预览**：滑杆/取色器拖动即 `Theme.setXxx`（写 DOM），松手才 `Store.save` 落盘；
- 取色器用原生 `<input type="color">` 起步（无依赖），后续可换自绘 HSL 面板；
- 选图走 `@tauri-apps/plugin-dialog` → Rust `copy_theme_bg` 命令拷贝进 app_data，防路径失效。

---

## 8. 持久化与兼容

| 事项 | 方案 |
|---|---|
| 存储 | `state.theme`，随现有 `Store.save` 走 Rust `save_state` |
| 老数据迁移 | `DEFAULTS.theme` + `structuredClone` 合并（store.js 现有模式直接覆盖），无破坏性 |
| 默认值 | `theme` 缺失 = 当前视觉（深色玻璃 + 默认蓝），**升级零感知** |
| 回退 | `Theme.apply` 整体 try/catch，异常时回落默认深色并 toast 提示 |

---

## 9. 实施计划（建议 4 个 PR）

| 阶段 | 内容 | 验收 |
|---|---|---|
| P1 Token 分层 | style.css 拆 L0/L1、新增 light 方案块、panel rgba 参数化；`data-scheme` 手动验证 | 深色视觉逐像素不变；手动切 light 各模块无不可读文本 |
| P2 运行时 | `theme.js` + 启动接入 + 多窗口同步 + state 持久化 | 改主题后重启保持；锁屏/提醒窗口同步 |
| P3 设置 UI | 外观分区：方案/主题色/背景/玻璃 + 实时预览 | 滑杆拖动实时生效，落盘正确 |
| P4 换肤 | 内置 5 皮肤画廊 + `data-skin` 钩子 + 恢复默认 | 一键换肤后各模块无样式断裂 |

每阶段跑现有冒烟测试（headless Chrome + 假后端），P1 需为主窗口截图对比深色基线。

---

## 10. 风险与注意

1. **浅色下的图表/状态色**：dashboard、system 模块大量使用状态色，浅色版已整体调暗（§4.1），但需逐模块人工过一遍对比度（目标 ≥ 4.5:1 正文）。
2. **backdrop-filter 性能**：模糊值是全局变量， WebView2 下 blur > 24 在低端机可能掉帧——滑杆上限 30 并在文档标注建议值。
3. **tomato/专注红**：`--tomato` 语义独立于 `--danger`，浅色版两值都需单独调整，不能共用。
4. **背景图体积**：大图直接塞 base64 会拖慢 state 读写，必须走文件拷贝方案（§3.2）。
5. **auto 模式的监听泄漏**：`matchMedia` listener 在窗口卸载时移除。
6. **插件页配色**：外部插件包若自带样式，深浅切换可能出现对比问题——本期只保证宿主 token 正确导出，插件适配留给插件协议后续版本。

---

## 11. 明确不做（本期边界）

- 不做在线主题商店 / 主题分享市场（接口已预留 export/import）
- 不做 zip 皮肤包安装（结构与 manifest 已对齐，另立任务）
- 不做基于壁纸自动取色（Windows 壁纸 API 提取主色，可作后续增强）
- 不做 per-module 主题（成本高、收益低）
