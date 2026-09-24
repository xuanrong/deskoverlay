# DeskOverlay

Windows 桌面工作台（Tauri v2 + WebView2）。应用嵌入 Explorer 桌面 WorkerW，使工作台成为「桌面本身」——Win+D 回到工作台，任务栏仍可见。

**内置模块（9 个，侧边导航 + 单模块切换，无拖拽 / 无工作模式）**

| 模块 | 内容 |
| --- | --- |
| 今日概览 | 待办事项（左）+ 文件中心 / 最近操作（右），文件中心支持桌面作用域与全盘索引搜索 |
| 快捷访问 | 分组网格 + 图标 |
| 工作记录 | 双栏总览工作台（类型筛选 + 周历热力） |
| 灵感碎片 | 随手记入口 + 卡片墙（JS 瀑布流）+ 自定义标签 |
| 系统健康 | CPU / 内存 / 磁盘 / 网络 / 电源实时采样与趋势 |
| 在线音乐 | 多音源在线搜索、阿里云盘、下载与队列、歌单、桌面歌词 |
| 休息一下 | 扫雷 / 2048 / 数独 |
| 笔记列表 | Markdown 编辑 / 预览双态、置顶分组、导出 .md |
| 系统设置 | 通用、外观（主题方案 / 皮肤 / 主题色）、插件、隐私、护眼、备份与恢复 |

**常驻能力**

- 时钟条上的**番茄钟胶囊**与**护眼色温胶囊**（点击开关，右键 / 点击展开浮层）
- 提醒：每日定时 / 间隔 / 久坐 / 喝水，均为系统级置顶窗口且**不抢键盘焦点**
- 隐私锁屏：空闲自动触发，Tauri 下使用独立的系统级置顶星空窗口
- 桌面歌词条：独立置顶窗口，单行 / 双行、描边 / 胶囊 / 加粗、对齐、字号、自定义配色、时间偏移
- 快速指令条：`Ctrl/Cmd + Space`
- **可扩展架构：外部 .zip 插件包**，前端与（可选）Rust→wasm 后端都在插件包内，导入即用

---

## 一、运行 / 开发

环境要求：Rust（含 `cargo` + `tauri-cli`）、Node.js（仅前端开发态静态服务器与校验脚本用）。

```bash
cd src-tauri
cargo tauri dev
```

`beforeDevCommand` 会自动执行 `node ../frontend/serve.js`，在 1420 端口提供 `frontend/web` 静态资源（`devUrl: http://localhost:1420`）。前端是**原生 ESM、无打包器**——改完刷新即可，不需要构建步骤。

只想看前端（不进 Tauri 运行时）：

```bash
cd frontend && node serve.js    # 然后访问 http://localhost:1420
```

此时 `window.__TAURI__` 不存在，`js/bus.js` 会自动回退到 Bus 模拟，界面可点但后端命令无效。

### 目录结构

```
frontend/
  serve.js                # 零依赖静态服务器（1420）
  web/                    # 打包进应用的静态资源（frontendDist）
    index.html            # 主窗口
    reminder.html         # 提醒窗口
    lyric.html            # 桌面歌词条
    lyric-menu.html       # 歌词设置弹窗
    lock.html             # 隐私锁屏
    js/                   # 原生 ESM 模块
      bus.js              # invoke / listen 解耦层：Tauri 态走 IPC，dev 态走 Bus 模拟
      state.js store.js   # 状态与持久化（saveState 300ms 防抖合并写入）
      theme.js            # 主题运行时（纯函数计算 CSS 变量，锁屏/提醒窗口复用）
      utils.js icons.js   # 共用小工具与线性 SVG 图标
      views/              # 各模块视图（views.js 负责注册与切换）
    css/style.css         # 全量样式（含全部窗口）
src-tauri/
  src/
    main.rs               # 命令编排、窗口生命周期、歌词/提醒/锁屏调度
    file_index.rs         # 全盘文件名索引（后台遍历固定盘，快照落盘 fileindex.txt）
    usn_index.rs          # 更快的 USN/$MFT 直读索引；读卷失败（未提权 / 非 NTFS）时回退 file_index
    sys_bridge.rs         # 系统采样（CPU / 内存 / 磁盘 / 网络 / 电源 / 空闲）
    eyecare.rs            # 护眼色温：时段算法 + 显示器色彩调整与守护线程
    sedentary.rs          # 久坐检测
    desktop_inject.rs     # 注入 Explorer WorkerW，成为「桌面本身」
    aliyundrive.rs        # 阿里云盘
    downloader.rs         # 下载与队列
    http.rs               # 共享 HTTP 传输层（ureq Agent 连接池）
    wasm_plugin.rs        # 插件 wasm 运行时（wasmi 沙箱）
    plugin_pkg.rs         # 插件包安装（解压 / manifest / 可选 cargo 编译）
    autostart.rs          # 开机自启
  examples/eyecare_probe.rs  # 护眼读写探测（非测试套件，按需手动跑）
tools/                    # 校验脚本（见下节）
frontend/STYLE_GUIDE.md   # 视觉规范
design/ .design/          # 设计 token 与静态设计稿（预览用 HTML，不参与构建）
```

### 架构约定（新增代码前先读）

1. **所有后端能力走 `bus.js` 的 `invoke()`**：不要直接摸 `window.__TAURI__.core.invoke`。`invoke` 在真实 Tauri 态失败会**抛升**（不静默降级），浏览器 dev 态才回退到 Bus 模拟。
2. **`state.json` 只有主窗口是写者**。歌词页 / 提醒页 / 锁屏页都是整体覆盖写且只持有启动时的旧快照，它们的改动必须 `emit` 回主窗口落盘。
3. **命令名与 DOM id 是裸字符串契约**，重命名后没有编译期报错——改完必须跑 `tools/contract-check.mjs`。

### 数据持久化

全部落在 `app_data_dir`（`%APPDATA%/com.deskoverlay.desktop/`）：

- `state.json` —— 主状态（设置 / 待办 / 笔记 / 灵感 / 导航态等）
- `music.json` —— 音乐类数据
- `worklogs.json` —— 工作记录
- `fileindex.txt` —— 全盘索引快照（下次启动秒恢复，无需整盘重扫）
- `plugins/<id>/` —— 解压后的插件包
- `wallpaper_cache/`、`music/` —— 壁纸缓存与音乐文件（已加入 assetProtocol scope）

「系统设置 → 备份与恢复」可整体打包为 zip 导出 / 导入。

### 快捷键

| 按键 | 行为 |
| --- | --- |
| `Ctrl/Cmd + Space` | 打开 / 关闭快速指令条 |
| `↑` `↓` `Enter` | 指令条内移动选择 / 执行 |
| `Esc` | 关闭当前浮层（帮助层 / 指令条 / 各弹窗）；**不会退出应用** |
| `Ctrl/Cmd + Enter` | 各弹窗内提交（新建待办 / 灵感 / 快捷访问） |

---

## 二、校验

改动后按顺序跑完这几项即视为通过（退出码非 0 即失败）：

```bash
cargo check                     # src-tauri 下执行：编译 + 必须 0 warning
node tools/contract-check.mjs   # 契约：命令 / DOM id / 事件名
node tools/eyecare-p1-check.mjs # 护眼前端接线
node tools/eyecare-schedule-check.mjs  # 护眼时段纯函数（跨午夜 / 过渡 / 边界）
node tools/smoke.mjs            # 真浏览器冒烟（headless Chrome + CDP）
```

| 脚本 | 覆盖 | 基线结果 |
| --- | --- | --- |
| `contract-check.mjs` | ① Rust 命令定义 ↔ `generate_handler!` 注册 ② 前端 `invoke` ↔ Rust 注册表 ③ JS 查询的 DOM id ↔ HTML/模板 ④ 事件配对（仅提示级） | 4 通过 / 0 失败 / 5 提示 |
| `eyecare-p1-check.mjs` | 改动文件语法、`state.eyeCare` 默认值 ↔ Rust 取值范围、百分比 ↔ 系数换算、设置页/app.js 接线点、命令名比对 | 89 通过 / 0 失败 |
| `eyecare-schedule-check.mjs` | 时段模式的纯函数镜像（与 `eyecare.rs` 同算法）：`from > to` 跨午夜、过渡插值方向与对称性、边界点归属 | 28 通过 / 0 失败 |
| `smoke.mjs` | 真浏览器 + 假后端：文件中心搜索结果渲染与右键菜单（必须走**绝对路径作用域**的 `delete_path`，不得误用桌面作用域的 `delete_file`）、提醒窗口「窗口可见 ⟺ 有内容」不变量、歌词条形态 / 样式 / 字号契约 | 102 / 105（中止于既存的 `lyric_panel` 契约漂移，见「常见问题」） |

`smoke.mjs` 会自动探测 Chrome 路径，可用 `CHROME=<路径>` 覆盖，例如：

```bash
CHROME=D:\chrome.exe node tools/smoke.mjs
```

为什么需要 `contract-check`：前端用裸字符串引用 Rust 命令与 DOM id，没有编译期约束。历史上就出现过 `lyric_panel → lyric_menu_toggle` 重命名漂移导致测试中断、`#dl-modal` 查不到导致下载弹窗可重复叠加，这类问题只有静态比对才拦得住。

---

## 三、插件体系（外部 .zip 插件包）

工作台源码本身**不包含任何插件业务**；插件是一个 `.zip` 包，通过「系统设置 → 插件 → 添加插件」导入：

1. 宿主将 zip 解压到 `app_data/plugins/<id>/`
2. 读取 `manifest.json`，注册前端模块（侧边栏出现对应入口）
3. 后端优先使用 zip 内**预编译的 `.wasm`**（无需任何工具链）；若没有，则调用本机 `cargo` 把 `backend/` 源码编译成 `.wasm` 后由内置 wasmi 沙箱执行

### 插件包结构

```
my-plugin.zip
├── manifest.json        # 必填：{ id, title, icon?, frontend?, backend? }
├── frontend.js          # 选：前端视图模块（见「前端契约」）
└── backend/             # 选：Rust → wasm 后端
    ├── Cargo.toml
    ├── src/lib.rs
    └── <lib>.wasm       # 选：作者预编译好的产物（宿主会优先使用）
```

`manifest.json` 示例：

```json
{
  "id": "my-plugin",
  "title": "我的插件",
  "icon": "<svg …></svg>",
  "frontend": "frontend.js",
  "backend": "backend"
}
```

> `id` 需唯一；`icon` 为内联 SVG 字符串。若含后端，`backend` 指向含源码（及可选 wasm）的目录。

---

## 四、制作一个「纯前端」插件包

只需要 `manifest.json` + `frontend.js` 两个文件，打成 zip 即可（两者放 zip 根目录）。

### 前端契约

`frontend.js` 是自包含的 ES Module，默认导出模块定义：

```js
export default {
  id: "my-plugin",          // 必须与 manifest.id 一致
  title: "我的插件",
  icon: `<svg viewBox="0 0 24 24"><path d="M12 3v9"/></svg>`,
  render(view, api) {
    // view.body 为容器；view.header 可隐藏
    view.header.style.display = "none";
    view.body.innerHTML = `<div>你好，插件</div>`;

    // api 提供的工作台能力（插件不 import 主应用内部模块，统一走 api）
    //   invoke(command, args)  调用宿主命令（如 http_post / run_wasm_backend）
    //   state / saveState      读写持久化状态
    //   esc(str)               HTML 转义
    //   showDialog(opts)       通用弹窗
  },
};
```

### 打包

```
┌ my-plugin/
│  ├ manifest.json
│  └ frontend.js
└ 压缩成 my-plugin.zip（manifest.json 在 zip 根）
```

在 Windows 下可用 `Compress-Archive -Path my-plugin\* -DestinationPath my-plugin.zip`，或在资源管理器中「压缩为 zip」。随后导入即可。

---

## 五、制作一个「带 wasm 后端」的插件包

后端用 Rust 编写并编译为 wasm，在沙箱中执行，适合逻辑/计算类能力；后端可通过 `api.invoke("run_wasm_backend", …)` 从前端触发。

### 后端契约（wasm32-unknown-unknown, `#![no_std]`）

宿主（`wasm_plugin.rs`）在 wasmi 沙箱内加载，约定如下导出 / 导入：

```
导出：
  memory
  alloc(size: i32) -> i32          bump 分配器，返回线性内存偏移
  run(in_ptr: i32, in_len: i32) -> i32  处理输入，返回结果长度
  get_result_ptr() -> i32         返回结果所在偏移
导入（由宿主注入）：
  env.host_log(ptr, len)          打印插件日志到宿主终端
```

最小后端骨架 `backend/src/lib.rs`：

```rust
#![no_std]
use core::slice;

#[link(wasm_import_module = "env")]
extern "C" { fn host_log(ptr: *const u8, len: u32); }

#[panic_handler]
fn on_panic(_: &core::panic::PanicInfo) -> ! { loop {} }

static mut HEAP: [u8; 64 * 1024] = [0; 64 * 1024];
static mut RESULT: [u8; 4096] = [0; 4096];
static mut RESULT_LEN: usize = 0;
static mut OFF: usize = 0;

#[no_mangle] pub extern "C" fn alloc(size: i32) -> i32 {
    let n = ((size.max(8) as usize) + 7) & !7;
    unsafe { let b = OFF; if b + n > HEAP.len() { return 0; } OFF = b + n; b as i32 }
}
#[no_mangle] pub extern "C" fn run(_in: i32, _len: i32) -> i32 {
    unsafe {
        host_log(b"[backend] hello".as_ptr(), 11);
        let s = b"backend ok";
        RESULT[..s.len()].copy_from_slice(s);
        RESULT_LEN = s.len(); RESULT_LEN as i32
    }
}
#[no_mangle] pub extern "C" fn get_result_ptr() -> i32 { unsafe { RESULT.as_ptr() as i32 } }
```

`backend/Cargo.toml`：

```toml
[package]
name = "my-backend"
version = "0.1.0"
edition = "2021"

[workspace]            # 独立于宿主/外层 workspace，便于单独编译

[lib]
crate-type = ["cdylib"]

[profile.release]
opt-level = "s"
lto = true
```

### 编译并打包（两种方式任选）

**方式 A：包内带预编译 `.wasm`（推荐，用户无需 Rust）**

```bash
cd backend
rustup target add wasm32-unknown-unknown
cargo build --release --target wasm32-unknown-unknown
# 产物：backend/target/wasm32-unknown-unknown/release/my_backend.wasm
```

把该 `.wasm` 复制进 `backend/`（如 `backend/my-backend.wasm`），再连同 `manifest.json`/`frontend.js`/`backend/` 一起打成 zip。宿主检测到 `backend/` 内有 `.wasm` 会直接使用，不需要工具链。

**方式 B：只发源码，导入时自动编译**

zip 里只放 `backend/` 源码（不含 `.wasm`）。用户机器装了 Rust（含 `wasm32-unknown-unknown` target）时，导入过程会自动执行 `cargo build` 再运行。

---

## 六、导入 / 管理

- **导入**：系统设置 → 插件 → 添加插件 → 选择 `.zip`
- **移除**：系统设置 → 插件 → 列表项右侧「移除」（会立即从侧边栏注销，并停止加载）
- **配置**：前端插件在视图内自行提供配置入口（如微信读书的「配置 API Key」）

---

## 七、常见问题

- **导入后没有后端结果**：若包内无预编译 `.wasm`，需在用户机器执行 `rustup target add wasm32-unknown-unknown` 才能自动编译后端。
- **`.wasm` 找不到 `host_log`**：后端必须 `#[link(wasm_import_module = "env")]` 声明该导入，宿主已注入。
- **依赖问题**：后端应尽量 `no_std`；如需标准库，使用 `wasm32-wasip1` 并让宿主启用 WASI（当前实现仅支持无 WASI 的 `wasm32-unknown-unknown` + 简单注入）。
- **`smoke.mjs` 停在「展开面板下发 lyric_panel」**：这是已知的测试脚本契约漂移——歌词设置面板已从歌词条内联面板改为独立窗口 `lyric_menu_toggle`，`tools/smoke.mjs` 中对应的断言尚未按新契约重写。属测试脚本待更新，不影响应用本身。
- **`cargo check` 有 warning**：本项目基线是 0 warning，warning 视为失败。常见来源是新增了未使用的 `use` 或未接线的命令。
- **改了命令名 / DOM id 后界面莫名失灵**：先跑 `node tools/contract-check.mjs`。

---

## 八、数据与许可

数据全部本地持久化，不上传任何服务器（在线音乐、云盘等功能按你填写的凭据直连对应服务）。

插件系统是宿主能力框架，插件业务代码由各插件作者自行维护与授权。