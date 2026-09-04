# 快捷访问导航栏（今日概览下方）实现方案

## Context（背景）

用户希望在「今日概览」下方新增一个**快捷访问**导航栏，用于快速打开网页、文件夹或文件，支持分组管理与快捷方式拖动排序。经与用户确认：

- 分组采用**可增删/重命名的分组列表**，每个快捷方式归属一个分组；

- 拖动排序支持**跨分组拖动**；

- 点击快捷方式**直接打开**（网页用默认浏览器，文件夹/文件用默认程序），无需确认。

目标：复用现有待办事项的指针拖拽、自定义下拉/弹窗、图标与状态持久化模式，保持代码精简、不引入新依赖。

## 数据模型（state.js）

在 `frontend/web/js/state.js` 中新增两个字段并加入 `loadState()` 结构校验：

```js
quickAccess: [],   // { id, type:"url"|"folder"|"file", title, target, groupId }
qaGroups: [],      // { id, name }
```

- `loadState()`：仿照 `state.tasks` / `state.plugins` 的写法，做数组校验 + 过滤非法项（缺失 id 或 target 的丢弃）。

- 首次使用无分组时，渲染层兜底注入一个「默认」分组（不写死进 state，避免污染）。

## 后端命令（src-tauri/src/main.rs）

复用现有 `open_file` 的 `cmd /C start "" ...` 模式，新增三个命令并注册进 `invoke_handler`：

```rust
// 打开任意目标：http(s) 链接 → 默认浏览器；本地路径 → 默认程序
#[tauri::command]
fn open_path(target: String) -> Result<(), String> {
    std::process::Command::new("cmd")
        .args(["/C", "start", "", &target])
        .spawn().map_err(|e| e.to_string())?;
    Ok(())
}
// 借用已引入的 tauri-plugin-dialog（Cargo.toml 已有依赖）弹出系统选择器
#[tauri::command]
fn pick_folder(app: tauri::AppHandle) -> Result<Option<String>, String> { /* app.dialog().file().blocking_pick_folder() 转字符串 */ }
#[tauri::command]
fn pick_file(app: tauri::AppHandle) -> Result<Option<String>, String> { /* app.dialog().file().blocking_pick_file() 转字符串 */ }
```

需在 main.rs 顶部 `use tauri_plugin_dialog::DialogExt;`。

## 数据操作模块（新建 frontend/web/js/quickAccess.js）

复刻 `tasks.js` 的 `persist()`（`saveState()`）模式，导出对象：

- `listGroups()` / `ensureDefaultGroup()`：分组列表，缺失时补「默认」

- `list()`：快捷方式列表

- `add({type,title,target,groupId})`：生成 `id`，追加

- `update(id, patch)`

- `remove(id)`

- `addGroup(name)` / `renameGroup(groupId, name)` / `removeGroup(groupId)`（删除分组时其内快捷方式归入「默认」）

- `move(fromId, groupId, atItemId)`：跨组移动 + 组内排序（`splice` 后改 `groupId` 并 `persist()`）

## 渲染与交互（frontend/web/js/views/dashboard.js）

1. `renderDashboard()` 现有 `.dash-grid` **之后**追加 `<div class="qa-block" id="qa-block"></div>`，并调用 `renderQuickAccess(...)`。
2. `renderQuickAccess(el, view)`：

   - 区块标题「快捷访问」复用 `.dash-section-title`，右侧放「＋ 添加」和「分组管理」按钮。

   - 每个分组渲染为一个 `.qa-group` 小节（组名标题 + `.qa-row` 横向 wrap 卡片）。

   - 每张卡片 `.qa-card`：图标（网页用 `ICON_GLOBE`，文件夹用 `ICON_FOLDER`，文件按扩展名映射复用 `FILE_ICONS`）+ 标题；hover 显示右上角编辑/删除小按钮。

   - 事件：点击卡片 → `invoke("open_path", { target })` 直接打开；指针拖拽 → 排序。
3. **跨分组拖拽**：复用待办 `pointerdown/pointermove/pointerup + drag-ghost` 模式，但 `targetAt` 改为扫描**所有分组**的 `.qa-card` 矩形，按指针 XY 计算落入的分组和目标卡片（前/后），实时高亮插入线；松手调 `QuickAccess.move(...)`。拖拽结束用 `suppressClick` 抑制误触发「打开」。
4. **添加快捷访问弹窗** `showQuickAccessModal(mode, item, onDone)`：复用 `.task-modal-overlay` 结构与 `createSelect`/`showDialog`。

   - 字段：类型下拉（网页链接/文件夹/文件）、名称、地址（含「浏览…」按钮：文件夹/文件类型时调用 `pick_folder`/`pick_file` 并自动填入路径+按 basename 补名称）、所属分组下拉（含「＋ 新建分组…」项）。

   - 编辑态带「删除」；提交/取消/Esc 逻辑完全对齐 `showTaskModal`。
5. **分组管理弹窗**：列出各分组，支持重命名/删除/新增，删除后其快捷方式并入「默认」。

## 样式（frontend/web/css/style.css）

新增 `.qa-block/.qa-group/.qa-row/.qa-card/.qa-card:hover/.qa-card .qa-actions/.qa-card .qa-del/.qa-edit/.qa-ghost/.qa-insert-before/.qa-insert-after` 等，风格沿用现有暗色面板（`--bg-panel-2`、`--border`、圆角）。浮空拖动卡片沿用 `.dash-task.drag-ghost` 的影子思路。复用 `.task-modal-overlay` 弹窗样式，无需新增弹窗层样式。

## 需要修改/新增的文件

| 文件                                   | 改动                                                    |
| ------------------------------------ | ----------------------------------------------------- |
| `frontend/web/js/state.js`           | 新增 `quickAccess`、`qaGroups` 字段 + `loadState` 校验       |
| `frontend/web/js/quickAccess.js`     | 新建：分组与快捷方式 CRUD + 跨组 move + 持久化                       |
| `frontend/web/js/views/dashboard.js` | `renderDashboard` 挂载、`renderQuickAccess`、拖拽、添加弹窗、分组管理 |
| `frontend/web/css/style.css`         | `.qa-*` 样式                                            |
| `src-tauri/src/main.rs`              | `open_path`/`pick_folder`/`pick_file` + 注册命令          |

## 验证

1. `cargo run` 启动（或 dev 态 `node serve.js` 浏览器验证布局；dev 态 `open_path`/pick 会走 bus 模拟，仅桌面态真实生效）。
2. 在「快捷访问」下添加网页链接/文件夹/文件各一个，确认卡片出现、图标与名称正确。
3. 新建组、重命名组、删除组（确认其快捷方式并入默认组）。
4. 在同一组内拖动排序，以及把一个卡片拖到另一组，确认插入线与落位正确；点击卡片直接打开默认浏览器/程序。
5. 重启应用确认配置持久化。

