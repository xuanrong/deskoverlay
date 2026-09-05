# 全站界面风格统一与简化方案

## Context（背景）

应用目前多个模块视图各自定义了独立样式类（`sys-*`、`set-*`、`wl-*`、`idea-*`、`qa-*`、`notes-*`、`music-*`），与既有共享原语（`.btn/.btn-primary/.btn-ghost/.btn-icon`、`.field/.input/.select/.textarea`、`.card/.card-head/.card-title`、`.task-modal*/.tm-field`、`.dash-empty`、`.file-tab`）不一致，造成视觉割裂与 CSS 冗余。

用户要求：**页面级 + 弹窗/组件全统一**，各模块顶部区块标题统一为**小块标题**（当前 `.dash-section-title`：13px / 600 / text-dim / 字距0.4px / 大写）。目标：复用既有原语，删除重复 CSS，做到视觉一致并精简（预计精简 \~150–200 行）。

约束：本任务只做「类名替换 + 少量模板文本调整」，不改行为/状态；surgical、逐模块可验证。

## 1. 统一小块标题：构造共享 `.sec-title`

- 在 style.css 把 `.dash-section-title`（L1171-1175）提升为通用 `.sec-title`（保留 `display:flex; justify-content:space-between; align-items:baseline` 以便内联操作按钮靠右）。

- 各 `view.header` 均已隐藏，页面标题统一为 body 顶部一条 `.sec-title`。

- 各模块插入标题文本（在 body.innerHTML 顶部）：
  system=系统健康、settings=系统设置、worklog=工作记录、ideabox=灵感碎片、notes=速记、music=音乐、relax=休息一下；quickaccess 把 `.view-title`（qa-title-row 内）改成 `.sec-title`。

- **music / relax 为居中 stage / 固定高双栏布局**：标题若挤压布局则改为「仅 gated 通过可视验证后启用」，`music-stage` 需保持 `flex:1`，relax 需把 `.relax-view` 改为纵向 flex + 内层横排，否则该项跳过（标记为可选/受验证门控）。

## 2. 各视图类 → 共享原语映射

| 视图          | 当前类 → 共享原语                                                                                                                                                                                                           |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| dashboard   | `.dash-section-title`→`.sec-title`；`.dash-add-btn`→`.btn-icon`；`.recent-ops-head`→`.sec-title`；其余(`.file-tab`/`.task-modal`/`.btn-primary`/`.tm-*`)已统一保留                                                             |
| system      | 加 `.sec-title`；`.sys-info`/`.sys-disks`→`.card`；`.sys-disks-head`→`.sec-title`；指标卡 `.sys-card` restyle 为 `bg-panel-2+border+radius`；`.sys-bar/图表`保留                                                                  |
| settings    | 加 `.sec-title`；`.set-panel`→`.card`；`.set-group-title`→`.sec-title`；数字输入→`.input`；开关/行描述保留                                                                                                                           |
| worklog     | 加 `.sec-title`；`.wl-form`→`.card`；`>textarea`→`.textarea`；`.wl-edit/.wl-del`→`.btn-icon`；时间线/圆点保留；编辑弹窗已用 `.tm-field`                                                                                                 |
| ideabox     | 加 `.sec-title`；`.idea-composer`→`.card`；`.idea-input`→`.input`；`.idea-card`→`.card` 视觉；标签→ `.badge` 色（保留 `.id-*`）；`.idea-edit/.idea-del`→`.btn-icon`；masonry/筛选布局保留                                                  |
| notes       | 加 `.sec-title`；`.notes-area/.notes-preview`→`.textarea` 视觉（restyle）；切换按钮段对齐 active 色                                                                                                                                 |
| music       | 加 `.sec-title`（门控）；`.mc-btn`→`.btn-icon`+保留 `.mc-big`；`input`→`.input`；`.om-close`→`.btn-icon`；删除按钮→`.btn-icon/btn-ghost`；播放器结构保留                                                                                    |
| relax       | 加 `.sec-title`（门控）；侧边游戏 tile restyle 为 card；`games/*.js` 小按钮统一 `.btn/.btn-ghost`；游戏棋盘布局保留                                                                                                                            |
| quickaccess | `.view-title`→`.sec-title`；`.qa-btn*`→`.btn/.btn-primary`；`.qa-card` restyle 为 card+tile（保留118px）；`.qa-act`→`.btn-icon`；`.qa-empty`→`.dash-empty`；`.qa-gitem`→`.list-row`；输入→`.input`；**.拖拽/ghost/insert 类保留**（行为关键） |

## 3. 标准化规则

- **卡片/面板**：统一 `background:var(--bg-panel-2); border:1px solid var(--border);` + `--radius*` token。

- **操作/图标按钮 hover**：统一 `.btn-icon` 模式（neutral=bg-hover/text，删除=rgba(danger-rgb,.15)）。

- **空状态**：统一 `.dash-empty`（替换 `.qa-empty`、重复的 `.empty-state` 等）。

- **圆角字面量 → token**（仅安全处）：6px→`--radius-xs`；8px（chip/小钮）→`--radius-xs`；10px→`--radius-sm`；18px→`--radius-lg`；999px/11px pill→`--radius-full`；不动微格（`.sdk-cell/.mine-cell/.t2048-cell/.sys-bar`）等结构性细胞尺寸。

## 4. 安全删除的冗余 CSS（随视图迁移后）

`.dash-add-btn`、`.recent-ops-head` 外观、`.file-layout-toggle`、`.set-panel/.set-group-title/.set-input`、`.idea-composer` 外观、共享 `.idea-input,.wl-form>textarea` 块、`.idea-card` 外观、`.idea-edit/.idea-del`、`.idea-edit-modal textarea`、`.wl-form` 外观/`.wl-form>textarea`/`.wl-form-row input,.dp,.cs` 重复、`#wl-e-text`、`.sys-info/.sys-disks/.sys-disks-head` 外观、`.qa-btn*/.qa-group-head/.qa-empty`、`.notes-area/.notes-preview` 重复、music 的 `.om-close/.online-panel input/.src-add input/.src-del`、`.idea-tag-opt` 基础、以及原 `.dash-section-title`（被 `.sec-title` 替换，净零）。

**执行顺序（降风险，逐模块可验证）**：

1. style.css + dashboard 造 `.sec-title`（无视觉变化，地基）
2. settings → 3) worklog → 4) ideabox → 5) system → 6) notes → 7) relax → 8) music → 9) quickaccess → 10) 死 CSS 清扫 + 圆角 token 化 → 11) 全量回归

## 关键文件

- `frontend/web/css/style.css`

- `frontend/web/js/views/{settings,worklog,ideabox,system,notes,relax,music,quickaccess,dashboard}.js`

## 验证

依次退出并 `cargo run`，逐模块检查：

- 所有模块顶部为统一小块标题；dashboard 待办拖动/弹窗、文件 tab 与 `+` 不回归

- settings 设置面板统一、开关/数字输入正常；worklog 时间线/改动正常、Ctrl+Enter；ideabox masonry/筛选/自定义标签/编辑弹窗正常

- system 指标卡与低电量变红、磁盘列表；notes 编辑/预览/自动保存；relax 各游戏操作与进度；music 播放/队列/收藏/音源管理、stage 不被标题挤压

- quickaccess 拖拽跨组/插入线、分组管理、浏览打开 URL/文件夹/文件；弹窗输入统一

- 最终 grep 确认无残留 `set-panel/idea-composer/wl-form 外观/qa-btn/dash-add-btn/sys-info 面板` 引用；无圆角 token 缺失；`cargo run` 无控制台报错。

