# DeskOverlay

Windows 桌面工作台（Tauri v2 + WebView2）。应用嵌入 Explorer 桌面 WorkerW，使工作台成为「桌面本身」——Win+D 回到工作台，任务栏仍可见。

- 侧边导航 + 单模块切换的固定布局
- 今日概览、工作记录、灵感碎片、系统健康、在线音乐、休息一下（小游戏）、我的速记、系统设置等内置模块
- 隐私锁屏（离开自动锁定）、提醒（每日定时 / 间隔 / 久坐 / 喝水）、系统级置顶提醒窗口
- **可扩展架构：外部 .zip 插件包**，前端与（可选）Rust→wasm 后端都在插件包内，导入即用

---

## 一、运行 / 开发

环境要求：Rust（含 `cargo`）、Node.js（仅前端开发态静态服务器用）。

```bash
# 前端资源在 frontend/web（原生 ESM，无打包器），node serve.js 提供 devUrl:1420
cd src-tauri
cargo tauri dev
```

- 前端：`frontend/web/`（`js/` 为 ESM 模块，`css/style.css`）
- 后端：`src-tauri/src/`（`main.rs` 编排、`sys_bridge.rs` 系统采样、`wasm_plugin.rs` 插件 wasm 运行时、`plugin_pkg.rs` 插件包安装）
- 持久化：`state.json` 写入 app_data_dir（音乐类数据独立 `music.json`，工作记录独立 `worklogs.json`）

---

## 二、插件体系（外部 .zip 插件包）

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

## 三、制作一个「纯前端」插件包

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

## 四、制作一个「带 wasm 后端」的插件包

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

## 五、导入 / 管理

- **导入**：系统设置 → 插件 → 添加插件 → 选择 `.zip`
- **移除**：系统设置 → 插件 → 列表项右侧「移除」（会立即从侧边栏注销，并停止加载）
- **配置**：前端插件在视图内自行提供配置入口（如微信读书的「配置 API Key」）

---

## 六、常见问题

- **导入后没有后端结果**：若包内无预编译 `.wasm`，需在用户机器执行 `rustup target add wasm32-unknown-unknown` 才能自动编译后端。
- **`.wasm` 找不到 `host_log`**：后端必须 `#[link(wasm_import_module = "env")]` 声明该导入，宿主已注入。
- **依赖问题**：后端应尽量 `no_std`；如需标准库，使用 `wasm32-wasip1` 并让宿主启用 WASI（当前实现仅支持无 WASI 的 `wasm32-unknown-unknown` + 简单注入）。

---

## 许可证

数据本地持久化，插件系统为宿主能力框架，插件业务代码由各插件作者维护。