# DeskOverlay 产品架构设计文档 v1.2（评审修订版）

> 产品代号：DeskOverlay  
> 定位：Windows Personal Operating Layer（Windows 个人桌面操作层）  
> 类型：桌面运行时 / 工作空间平台 / 插件化桌面系统  
> 技术基础：Tauri 2 + Rust + WebView2 + Win32 Desktop Integration  
> **核心设计原则：极稳注入、帧级可控、安全沙箱、AI即工具**

---

## 0. 验证状态（与 spike 对齐）

本架构各部分成熟度不同，避免误读：

| 模块 | 状态 | 说明 |
| :--- | :--- | :--- |
| 桌面注入（WorkerW / SetParent） | ✅ 已验证（spike） | 技术验证 spike 已落地并编译通过 |
| 选择性点击穿透（WM_NCHITTEST） | ✅ 已验证（spike） | 面板内可交互、面板外穿透到真实桌面 |
| Explorer 重启自愈 | ✅ 已验证（spike） | 2s 轮询 + 重新嵌入窗口 |
| CPU Provider 数据桥 | ✅ 已验证（spike） | sysinfo → `provider-emit` 事件 |
| 多显示器 | ⚠️ 当前为单窗口覆盖虚拟屏 | 每显示器独立 WebView2 为 P2+ 计划 |
| 守护进程 / Plugin SDK / AI Agent | 🔜 规划中 | 本文为设计目标，尚未实现 |

> 注：spike 为 Windows-only 的 Rust + WebView2 研究原型；守护进程、插件沙箱、AI 动作原语等为后续产品化工作，不应据此认为已具备相应能力。

---

## 1. 项目概述

DeskOverlay 不是传统桌面美化工具，而是一层运行于 Windows 桌面之上的**个人工作空间系统**。

**传统模式：**
> Windows Explorer → 桌面图标 → 用户操作

**DeskOverlay 模式：**
> Windows → Explorer → **DeskOverlay 守护进程（Daemon）** → 桌面运行时 → 个人工作空间 → 用户工作流

**核心理念：** 让 HTML/CSS/JS 成为 Windows 桌面的可编程交互层，且**永不因 Explorer 崩溃而消失**。

---

## 2. 产品定位

DeskOverlay 是：

- Windows 桌面操作层平台
- 工作流入口与信息聚合中心
- 上下文感知的智能工作区
- AI Agent 的确定性操作宿主

**不是：**

- 普通 Widget 工具
- 壁纸工具
- 图标整理工具

---

## 3. 核心架构（增强版）

```text
                     Plugin Marketplace (带安全审计)
                              |
                      Plugin Runtime (沙箱隔离)
                              |
    Context-Awareness Engine → Panel Engine (动态栅格/智能显隐)
                              |
          Provider System (双向数据网格 / Local Data Mesh)
                              |
               Desktop Runtime Core (含自愈守护进程)
                              |
        Windows Explorer / Win32 API / WorkerW 注入层
```

---

## 4. Desktop Runtime Core（核心加固与自愈机制）

负责：桌面注入、WebView2 承载、生命周期管理、**Explorer 崩溃自愈**、**多 DPI 适配**。

### 4.1 注入策略（双保险机制）

> **原生图标处理**：启动即隐藏 Explorer 桌面图标层（`SHELLDLL_DefView`），让覆盖层成为桌面上唯一可见的内容（亦符合"全屏接管、隐藏原生图标"的产品决策）。

- **主模式（默认）**：`Progman → WorkerW → DeskOverlay Window → WebView2 Canvas`，覆盖整个虚拟屏幕，位于壁纸/WorkerW 之上、已隐藏的图标层之下。
- **降级模式（Fallback）**：若 WorkerW 注入失败（例如游戏反作弊环境），退回 `WS_EX_LAYERED` 顶层透明窗口；点击归属仍由下方的**选择性命中测试（§4.1.1）**决定，而非整窗 `WS_EX_TRANSPARENT`——后者的整窗穿透会让整个覆盖层失去交互能力，与我们"全交互型"定位相悖。

### 4.1.1 选择性点击穿透（Selective Click-Through）★ 核心技术差异

不依赖 `WS_EX_TRANSPARENT`（整窗穿透、不可交互），而是对顶层窗口及 WebView2 子窗口做 `WM_NCHITTEST` 子类化：

- 光标落在已知面板矩形内 → 返回 `HTCLIENT`（可交互：拖动 / 点击 / 输入）；
- 光标落在面板外 → 返回 `HTTRANSPARENT`（点击穿透到真实桌面：右键菜单、框选图标等行为完全照旧）。

这是 DeskOverlay 相对 Zebar / Ivy 乃至 Stardock Fences 的关键差异——**在全屏接管桌面的同时，面板之外的区域仍是最真实的 Windows 桌面**，而不是一层永远吞掉点击的玻璃。该机制已在技术验证 spike 中落地（见 §0）。

### 4.2 守护进程（Daemon）—— **产品的生命线**

- 由 Rust 编写独立极小看门狗进程（内存占用**目标 < 8MB**，仅含监听与拉起逻辑），开机自启。
- 实时监听 Windows 消息：`SHELLHOOK`（Explorer 重启）、`WM_DISPLAYCHANGE`（分辨率 / DPI 变化）、`WM_SYSCOLORCHANGE`。
- **自愈契约**：检测到 Explorer 崩溃或分辨率变化时，在**目标 500ms 内**将现有 WebView2 窗口**重新嵌入**重建后的桌面，并恢复所有面板的几何坐标、透明度与数据状态（状态已实时序列化至 SQLite/JSON）。
- **进程存活兜底**：守护进程同时负责在 DeskOverlay 主进程异常退出时将其重新拉起，从而真正兑现"永不因 Explorer 崩溃而消失"。

---

## 5. Panel Engine（动态栅格与性能预算）

每个面板支持：拖动、缩放、最大化、锁定、隐藏、**折叠（折叠为标题栏）**、**贴靠吸附**、透明度调整。

### 5.1 动态栅格系统（Dynamic Grid）

- 引入类似 FancyZones 的布局引擎，支持面板间的**智能贴靠（Snap）**和**等比例缩放**。
- 布局状态以树形结构存储，支持撤销/重做（Undo/Redo）。

### 5.2 上下文智能显隐（Context-Aware Visibility）—— **核心亮点**

- 通过 Provider 监控当前前台窗口（如检测到 VSCode/IDE 全屏）。
- **规则引擎**：用户可自定义"工作区规则"。例如：
  - 进入"编码模式" → 自动隐藏娱乐面板（Spotify），降低 Git 面板透明度至 20%。
  - 桌面无任何窗口 → 自动展开所有信息型面板（日历、待办）。

### 5.3 性能预算与渲染节流（Performance Budget）

- 非活跃面板（被遮挡/最小化/后台）自动**降帧至 1fps** 并暂停动画。
- 引入 `render_mode` 标记：
  - `dynamic`：实时渲染（用于监控图表）。
  - `cached`：离屏缓存位图，数据变更时重绘（用于日历、静态文本），**降低 GPU 显存占用（目标约 60%）**。

**面板配置示例：**
```json
{
  "id": "calendar",
  "component": "calendar-panel",
  "provider": "calendar",
  "theme": "glass",
  "budget": { "max_fps": 30, "offline_cache": true },
  "context_rules": [{ "app": "code.exe", "action": "minimize" }]
}
```

---

## 6. Provider 系统（本地数据网格与双向通信）

Provider 是数据来源，但现在升级为 **"双向数据网格（Bidirectional Data Mesh）"**。

### 6.1 数据流架构

> **Provider（数据源）** ↔ **统一 Schema Registry** ↔ **Event Bus（高频 Rust 线程）** ↔ **Panel Renderer（节流渲染）**

### 6.2 数据写入能力（Actionable Provider）

- Provider 不仅支持"读取"，还支持"写入/命令"。
- 例如：日历 Provider 接收 AI 指令 `add_event`，通过**各应用原生接口**执行写入——本地日历走 COM、Outlook/Google 走 Graph API、Spotify 走本地 WebSocket/REST 等。
- 所有 Provider 必须严格遵循 `JSON Schema` 定义的数据契约（`type: timeline` / `type: metric` / `type: action`），确保前端渲染器与数据源解耦。

### 6.3 系统 Provider 列表（扩展）

| 类别 | 示例 | 特性 |
| :--- | :--- | :--- |
| **系统** | CPU、RAM、GPU、Network、Battery | 高频采样（Rust 原生线程） |
| **应用** | Calendar、Git、Spotify、Mail、**Everything（本地搜索）** | 支持写入操作 |
| **AI** | Task Agent、File Agent、Search Agent | 仅内部调用，不开放给第三方插件 |

---

## 7. Plugin SDK（安全沙箱与权限声明）

允许第三方创建：桌面组件、数据连接器、自动化工具。

### 7.1 插件结构（增强）

```text
plugin/
 ├ manifest.json  (必须声明权限)
 ├ panel.js
 ├ provider.js
 ├ style.css
 └ assets/
```

### 7.2 强制权限模型（Android-like Permissions）

- 插件必须在 `manifest.json` 中声明所需权限：
  ```json
  {
    "name": "Git Stats",
    "permissions": ["system:cpu", "fs:read:./git", "ai:search"],
    "storage": "plugin_id"  // 限定私有存储目录
  }
  ```
- **Rust 后端作为代理层（Proxy）**：
  - 插件运行于 WebView2 内，本就无法直接调用 Win32 API 或 `CreateFile`；真正的攻击面是 JS 任意 `fetch` 与 DOM XSS。
  - 所有文件 IO 通过 DeskOverlay 提供的 `Storage API`，路径严格限制在 `./deskoverlay/plugins/<plugin_id>/` 下。
  - 网络请求经 Tauri 的 `http` 模块并受 WebView2 `WebResourceRequested` 过滤，由后端做 TLS 校验与域名白名单，防止中间人攻击与数据外泄。

---

## 8. AI Desktop Agent（高确定性执行路径）

**战略转向**：AI 不依赖"虚拟鼠标坐标"这种高成本、低成功率的方式，而是采用 **"意图解析 + 内部 API 映射"** 的确定性路径。

### 8.1 核心架构

> 用户指令 → 本地/云端 LLM（意图识别） → **Action Widget（结构化指令集）** → DeskOverlay 内部 API → 面板变更 / Windows 动作

### 8.2 动作原语（Action Primitives）—— **关键创新**

AI 只能调用以下确定性的原子操作：

- `panel.resize(id, width, height)`
- `panel.move(id, x, y)`
- `panel.set_opacity(id, value)`
- `provider.exec(id, command)` （如"在日历创建会议"）
- `windows.launch(app_path)` （通过 ShellExecute）
- `workspace.switch(id)` （切换预定义布局）

**杜绝** 让 AI 生成任意 JavaScript 代码执行，防止注入风险。

### 8.3 临时面板（Ephemeral Panels）

- AI 生成的面板（如"帮我列出今天下载的文件"）默认带有 `lifespan`（生命周期）参数（默认 60 秒）。
- 超时后自动淡出关闭，避免 AI 交互污染桌面布局。

### 8.4 快速指令条（Quick Command Bar）

- Phase 1 落地形态：桌面顶部 Spotlight 风格输入框。
- 输入"打开 Figma"、"搜索 Q4 报告"，调用 Everything SDK 和 Windows Search，**响应目标 < 300ms**，是前期获取用户口碑的杀手锏。

---

## 9. UI 设计规范（强化"沉浸式效率"）

- **视觉基调**：深色、亚克力/玻璃半透明（Mica Alt）、克制高光、高信息密度。
- **交互反馈**：微米级动效（< 150ms），杜绝夸张转场。
- **字体与间距**：优先使用 Segoe UI Variable，行高设定为 1.5，确保 4K 显示器下清晰可读。
- **暗色/亮色**：强制跟随系统主题，但提供独立的"桌面叠加层对比度"调节滑块。

---

## 10. 多显示器支持（策略）

- 每个显示器独立创建 WorkerW 注入和 WebView2 实例。
- 每个显示器支持独立的工作空间布局与主题，**但共享同一个插件/Provider 数据池**。
- 显示器热插拔检测：插入新显示器时自动弹出"是否拓展桌面层"提示。

> **与当前 spike 的差异**：技术验证阶段采用单个 WebView2 覆盖整个虚拟屏（单窗口方案）。上述"每显示器独立 WebView2 实例"为 P2+ 规划，需在每屏分别注入 WorkerW 并处理跨屏 DPI/坐标映射，工作量显著，不计入 MVP。

---

## 11. 风险规避与工程韧性（新增关键章节）

| 风险点 | 应对策略 |
| :--- | :--- |
| **Explorer 频繁崩溃** | Rust 守护进程（Daemon）+ 状态快照秒级恢复（目标 <500ms）。 |
| **WebView2 内存泄漏** | 每个面板独立 WebView 上下文，闲置 >5min 自动销毁并释放内存。 |
| **高 DPI 缩放模糊** | 监听 `WM_DPICHANGED`，WebView2 自动重绘并缩放坐标矩阵。 |
| **第三方插件恶意窃听** | 强制权限声明 + Rust 代理层拦截系统敏感 API + 插件市场代码审计。 |

---

## 12. 开发路线（务实 3 阶段，聚焦 MVP）

### Phase 0 — 地基验证（4 周）
- Rust 守护进程开发，验证 WorkerW 注入与自愈。
- WebView2 基础承载，实现点击穿透切换。

### Phase 1 — 核心运行时与 MVP 交付（8 周）—— **生死线**
- 面板引擎（支持拖拽、缩放、折叠）。
- **重点打磨"统一信息面板"**：集成时钟、天气、CPU/内存、Todo 清单于一体，确保视觉无可挑剔。
- **快速指令条（Quick Command Bar）**：集成 Everything 搜索与系统应用启动。
- **目标**：开机即用，永不闪烁，内存占用**目标 < 150MB（含 WebView2，偏乐观）**。

### Phase 2 — 生态与智能上下文（12 周）
- 发布 Plugin SDK 与沙箱安全模型。
- 上线官方插件市场（日历、Git、Spotify）。
- 上下文感知引擎（根据前台应用自动折叠/显隐面板）。
- 多显示器独立 WebView2 实例（见 §10 差异说明）。

### Phase 3 — AI Agent 与商业化探索（长期）
- 接入本地小模型（Phi-3 / Qwen），实现"AI 动作原语"调度。
- 布局快照云同步（需用户授权）。
- 企业版功能：基于 LDAP 的统一工作区策略下发。

---

## 13. 长期愿景（修正版）

DeskOverlay 的最终目标是成为 Windows 上的 **"个人数字工作区操作系统"**。

**核心差异化**：不是"美化"，而是 **"稳定可靠的信息交互层"**。  
让桌面从"文件堆砌的入口"进化为 **"随工作状态呼吸的智能控制台"**。

--- 
*文档版本：v1.2（评审修订版） | 状态：架构评审中 | 更新日期：2026-08-15*
