# DeskOverlay 样式体系（Design System）

统一全应用的视觉规范，确保界面一致、专业、可维护。本文档是团队复用与新增页面的唯一样式依据。

实现位置：[frontend/css/style.css](css/style.css)，所有 token 定义于 `:root`。

---

## 1. 核心原则

1. **Token 优先**：颜色、间距、字号、圆角一律使用 `:root` 中的 CSS 变量，禁止硬编码色值。
2. **组件复用**：优先使用通用组件类（`.btn` / `.card` / `.badge` / `.list-row` 等），不重复造轮子。
3. **单一职责**：一个类只做一件事，通过组合实现复杂 UI。
4. **层级明确**：背景、边框、文本、阴影均有固定层级，遵循"层级表"。
5. **不写死像素**：除非必要，尺寸使用间距刻度（`--sp-*`）与字号阶梯（`--text-*`）。

---

## 2. 颜色系统

### 2.1 中性色（背景层级）

| Token | 值 | 使用场景 |
|---|---|---|
| `--bg-base` | `#0a0e15` | 桌面最底层背景 |
| `--bg-panel` | `rgba(16,20,28,.72)` | 内容面板（半透明玻璃） |
| `--bg-panel-2` | `rgba(22,27,36,.66)` | 次级面板 / 输入区 / 卡片 |
| `--bg-elevated` | `rgba(31,38,50,.9)` | 浮层（弹窗 / 菜单） |
| `--bg-input` | `#111820` | 输入控件专用底色 |
| `--bg-hover` | `rgba(255,255,255,.06)` | 通用 hover 高亮 |
| `--bg-hover-strong` | `rgba(255,255,255,.1)` | 更强的高亮（kbd / 代码行） |

**层级关系**：`bg-base < bg-panel < bg-panel-2 < bg-elevated`，越上层越亮、越不透明。

### 2.2 边框

| Token | 值 | 使用场景 |
|---|---|---|
| `--border` | `rgba(255,255,255,.10)` | 常规分隔线 |
| `--border-strong` | `rgba(255,255,255,.18)` | 强调边框（按钮描边） |
| `--border-input` | `#2a3340` | 输入控件边框 |

### 2.3 文本

| Token | 值 | 使用场景 |
|---|---|---|
| `--text` | `#e6edf3` | 主文本 |
| `--text-dim` | `#9aa7b4` | 次级文本 / 描述 |
| `--text-faint` | `#5b6675` | 弱化文本 / 占位 / 空态 |
| `--text-invert` | `#061014` | 深色底上的反白文字 |

### 2.4 语义色

| Token | 值 | 别名 | 场景 |
|---|---|---|---|
| `--blue` | `#58a6ff` | `--primary` | 主强调 / 激活 / 链接 |
| `--green` | `#3fb950` | `--success` | 成功 / 完成 / 运行 |
| `--amber` | `#d29922` | `--warning` | 警告 / 暂停 |
| `--danger` | `#ff7b72` | `--error` | 危险 / 错误 / 删除 |
| `--purple` | `#bc8cff` | — | 次级强调（磁盘 / 特殊标签） |
| `--cyan` | `#39c5cf` | — | 辅助强调（渐变点缀） |

> **RGB 分量**：`--blue-rgb` 等分量变量用于构造半透明背景，如 `rgba(var(--blue-rgb), .15)`。组件层一律使用语义别名 `--primary` / `--success` / `--warning` / `--error`。

---

## 3. 排版规范

### 3.1 字号阶梯

| Token | 值 | 场景 |
|---|---|---|
| `--text-xs` | 10px | 辅助说明 / 角标 |
| `--text-sm` | 11px | 标签 / 时间 / 小徽章 |
| `--text-base` | 13px | 默认正文 |
| `--text-md` | 14px | 列表项 / 输入框 |
| `--text-lg` | 18px | 弹窗标题 / 区块强调 |
| `--text-xl` | 22px | 视图主标题 |
| `--text-display` | 48px | 大数字（时钟 / 温度） |

### 3.2 行高 / 字重

| Token | 值 | 场景 |
|---|---|---|
| `--lh-tight` | 1.2 | 标题 / 单行 |
| `--lh-normal` | 1.5 | 默认 |
| `--lh-loose` | 1.7 | 正文段落 / 文本域 |
| `--fw-regular` / `--fw-medium` / `--fw-semibold` / `--fw-bold` | 400 / 500 / 600 / 700 | — |

---

## 4. 间距标准（4px 基准刻度）

| Token | 值 | Token | 值 |
|---|---|---|---|
| `--sp-1` | 4px | `--sp-5` | 20px |
| `--sp-2` | 8px | `--sp-6` | 24px |
| `--sp-3` | 12px | `--sp-8` | 32px |
| `--sp-4` | 16px | | |

**规则**：使用 `gap` / `padding` / `margin` 时从刻度中取值，不随意写 3/5/7/9px 等游离值。

---

## 5. 圆角体系

| Token | 值 | 场景 |
|---|---|---|
| `--radius-xs` | 6px | 小元素 / 列表行 / 状态标签 |
| `--radius-sm` | 10px | 按钮 / 输入框 / 小卡片 |
| `--radius` | 16px | 面板 / 卡片 / 弹窗容器 |
| `--radius-lg` | 18px | 大浮层 |
| `--radius-full` | 999px | 胶囊（徽章 / 状态条） |

---

## 6. 阴影体系（层级递增）

| Token | 值 | 场景 |
|---|---|---|
| `--shadow-xs` | `0 1px 3px` | 轻提拉 |
| `--shadow-sm` | `0 4px 14px` | 小浮层 |
| `--shadow-soft` | `0 8px 24px` | 卡片悬浮 |
| `--shadow` | `0 18px 50px` | 弹窗 |
| `--shadow-lg` | `0 30px 80px` | 命令条 / 全局浮层 |

---

## 7. 动效

| Token | 值 | 场景 |
|---|---|---|
| `--t-fast` | `120ms ease` | hover / 微交互 |
| `--t` | `180ms cubic-bezier(.22,.61,.36,1)` | 默认过渡 |
| `--t-slow` | `260ms ease` | 大面积变化 |

**规则**：交互反馈统一用 `var(--t-fast)`，状态过渡用 `var(--t)`。

---

## 8. 组件规范

### 8.1 按钮体系

层级：主按钮 > 次按钮 > 幽灵按钮 > 危险按钮 > 图标按钮。

| 类名 | 用途 | 说明 |
|---|---|---|
| `.btn-primary` | 主要动作（保存 / 添加 / 完成） | 绿色渐变实心，唯一视觉焦点 |
| `.btn` | 次按钮（关闭 / 取消外的一般动作） | 面板底 + 描边 |
| `.btn-ghost` | 低优先级动作 | 透明，hover 高亮 |
| `.btn-danger` | 破坏性操作（删除） | 红描边，hover 红底 |
| `.btn-icon` | 纯图标按钮 | 34×34 方形 |

```html
<button class="btn btn-primary">保存</button>
<button class="btn">关闭</button>
<button class="btn-ghost">跳过</button>
<button class="btn-danger">删除</button>
<button class="btn-icon" title="播放">▶</button>
```

### 8.2 表单体系

| 类名 | 用途 |
|---|---|
| `.field` | 字段容器（label + 控件纵向排列） |
| `.field-label` | 字段标签 |
| `.input` / `.select` / `.textarea` | 输入控件（统一底色 / 边框 / 聚焦光晕） |

```html
<div class="field">
  <label class="field-label">名称</label>
  <input class="input" placeholder="请输入" />
</div>
```

### 8.3 卡片体系

| 类名 | 用途 |
|---|---|
| `.card` | 内容面板（背景 / 圆角 / 内边距） |
| `.card-head` | 卡片头部（标题 + 操作区左右布局） |
| `.card-title` | 卡片标题 |

```html
<div class="card">
  <div class="card-head">
    <div class="card-title">磁盘</div>
    <button class="btn-ghost">详情</button>
  </div>
  <!-- 内容 -->
</div>
```

### 8.4 标签 / 徽章

| 类名 | 语义色 |
|---|---|
| `.badge-blue` / `.badge-green` / `.badge-amber` / `.badge-danger` / `.badge-purple` | 状态色徽章 |
| `.badge-neutral` | 中性徽章 |

```html
<span class="badge badge-green">已完成</span>
<span class="badge badge-danger">已过期</span>
```

### 8.5 列表行

```html
<div class="list-row">
  <span>标题</span>
  <span class="badge badge-blue">运行中</span>
</div>
```

带 hover 反馈的统一列表行，间距 `--sp-2/--sp-3`，圆角 `--radius-xs`。

### 8.6 空状态

```html
<div class="empty-state">暂无数据</div>
```

居中的弱化提示，居中 `--sp-4` 上下内边距。

### 8.7 弹窗

| 类名 | 用途 |
|---|---|
| `.task-modal-overlay` | 遮罩层（半透明 + 模糊） |
| `.task-modal` | 弹窗容器（统一 `--bg-elevated` / `--radius-lg` / `--shadow` / `28px 30px` 内边距） |
| `.tm-actions` | 底部按钮组（右对齐） |
| `.confirm-modal` / `.recent-modal` / `.queue-modal` / `.source-modal` / `.remind-modal` | 变体，仅覆盖宽度 |

弹窗宽度规范：确认 420 / 提醒 480 / 播放队列 460 / 音源 520 / 操作记录 560 / 在线音乐 1000（px）。

---

## 9. 响应式设计规则

桌面优先，窗口宽度可变：

| 容器宽度 | 行为 |
|---|---|
| 网格面板（dashboard 双栏） | `grid-template-columns: 1fr 1fr`，窄窗口自动压缩 |
| 弹窗 | `width: min(Npx, 94vw)`，小屏收窄并留边距 |
| 系统指标卡 | 固定 4 列，卡片内容自适应 |
| 游戏棋盘 | 固定尺寸网格，容器水平居中 |

**规则**：
- 弹窗一律 `min(...vw)` 约束，避免超出视口。
- 长文本使用 `min-width: 0` + `overflow:hidden; text-overflow:ellipsis; white-space:nowrap` 防撑破。
- 滚动容器指定 `min-height: 0` 使 flex 子项可收缩。
- 禁止横向滚动（`body` 隐藏溢出）。

---

## 10. 滚动条

全局统一（见 style.css 通用组件区）：

- 宽 `8px`，thumb 灰蓝 `rgba(120,130,150,.3)`，hover `.5`，圆角 `6px`。
- 所有容器自动继承，无需逐处声明。

---

## 11. 使用场景与层级关系

```
桌面背景 (--bg-base)
 └─ 面板/卡片 (--bg-panel / --bg-panel-2)
     ├─ 标题 (--text) + 次级 (--text-dim) + 弱化 (--text-faint)
     ├─ 列表行 (hover → --bg-hover)
     └─ 按钮 (主→次→幽灵)
 └─ 浮层弹窗 (--bg-elevated + --shadow)
```

交互状态总览：

| 状态 | 表现 |
|---|---|
| hover | `--bg-hover` 高亮（列表 / 按钮 / 图标） |
| active / 选中 | 语义色背景 `rgba(var(--blue-rgb), .12~.2)` + 语义色文字 |
| focus | 输入框聚焦光晕 `0 0 0 3px rgba(var(--blue-rgb), .15)` |
| disabled | `opacity: .45` + `cursor: not-allowed` |
| danger | `--danger` 文字 + 红描边 / 红底 |

---

## 12. 维护与扩展

### 12.1 新增页面步骤

1. 复用 `view-title` / `view-sub`（视图头部）与 `.view-body`（滚动区）。
2. 布局用 `.card` / `.dash-grid` 等同级容器，不新建视觉基础。
3. 颜色 / 间距 / 字号只引用 token。
4. 新增语义色前先确认语义色表，避免新增重复色值。

### 12.2 新增 token

- 在 `:root` 按区块（颜色 / 排版 / 间距 / 圆角 / 阴影 / 动效）添加，注明使用场景注释。
- 颜色值只允许出现一次（在 token 定义处），其余一律 `var()`。

### 12.3 新增组件

- 组件类命名语义化、可组合；先检查通用组件区是否已有等价类。
- 样式写在对应视图区块之前，归属"通用组件"区的组件供全项目复用。

### 12.4 禁止事项

- ❌ 硬编码色值（如 `#111820`、`#2a3340`）直接写在规则中。
- ❌ 使用游离字号 / 间距（非刻度值）。
- ❌ 为单个页面复制通用组件样式（应改用通用类或扩展 token）。
