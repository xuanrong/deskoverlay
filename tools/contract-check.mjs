// 契约校验 —— 前端用裸字符串引用 Rust 命令 / DOM id / 事件名，无编译期约束，
// 重命名后极易静默失效（历史案例：lyric_panel → lyric_menu_toggle 漂移导致测试中断、
// #dl-modal 查不到导致下载弹窗可重复叠加）。
// 用法：node tools/contract-check.mjs   （有 FAIL 时退出码 1）
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src-tauri", "src");
const WEB = path.join(ROOT, "frontend", "web");

let pass = 0, fail = 0, warnN = 0;
const ok = (m) => { pass++; console.log("  [PASS] " + m); };
const bad = (m) => { fail++; console.log("  [FAIL] " + m); };
const warn = (m) => { warnN++; console.log("  [WARN] " + m); };

function walk(dir, ext, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, ext, out);
    else if (e.name.endsWith(ext)) out.push(p);
  }
  return out;
}
const read = (f) => fs.readFileSync(f, "utf8");
const rel = (f) => path.relative(ROOT, f).replace(/\\/g, "/");

function collect(map, key, file) {
  if (!map.has(key)) map.set(key, new Set());
  map.get(key).add(file);
}

// ── Rust 侧：命令定义与注册 ────────────────────────────
const rsFiles = walk(SRC, ".rs");
const rustDefined = new Map();
const rustRegistered = new Set();
const rustEmits = new Map();
for (const f of rsFiles) {
  const s = read(f);
  for (const m of s.matchAll(/#\[tauri::command\][\s\S]{0,300}?\bfn\s+(\w+)/g)) rustDefined.set(m[1], rel(f));
  const g = /generate_handler!\s*\[([\s\S]*?)\]/.exec(s);
  if (g) {
    for (const item of g[1].split(",")) {
      const t = item.trim();
      if (t) rustRegistered.add(t.split("::").pop());
    }
  }
  // emit_to("窗口名", "事件名") —— 第一个字符串是窗口名，必须取第二个
  for (const m of s.matchAll(/\.emit_to\(\s*"[^"]*"\s*,\s*"([^"]+)"/g)) collect(rustEmits, m[1], rel(f));
  for (const m of s.matchAll(/\.emit\(\s*"([^"]+)"/g)) collect(rustEmits, m[1], rel(f));
}

console.log("=== 1. Rust 命令：定义 ↔ generate_handler 注册 ===");
const unregistered = [...rustDefined.keys()].filter((k) => !rustRegistered.has(k)).sort();
const ghost = [...rustRegistered].filter((k) => !rustDefined.has(k)).sort();
if (unregistered.length) bad(`定义了 #[tauri::command] 但未注册：${unregistered.join(", ")}`);
else ok(`${rustDefined.size} 个命令全部已注册`);
if (ghost.length) bad(`注册表有悬空项（无对应定义）：${ghost.join(", ")}`);
else ok("注册表无悬空项");

// ── 前端侧：invoke 调用 / DOM id 查询 / 事件订阅 ────────
const jsFiles = walk(path.join(WEB, "js"), ".js").filter((f) => !f.includes("vendor"));
const htmlFiles = fs.readdirSync(WEB).filter((f) => f.endsWith(".html"));

const jsCalls = new Map();
const jsListens = new Map();
const jsBusEmit = new Map();
const jsBusOn = new Map();
const jsIds = new Set();
const jsQueries = new Map();
for (const f of jsFiles) {
  const s = read(f);
  const name = rel(f);
  for (const m of s.matchAll(/\binvoke\(\s*"([^"]+)"/g)) collect(jsCalls, m[1], name);
  for (const m of s.matchAll(/core\.invoke\(\s*"([^"]+)"/g)) collect(jsCalls, m[1], name);
  for (const m of s.matchAll(/\blisten\(\s*"([^"]+)"/g)) collect(jsListens, m[1], name);
  for (const m of s.matchAll(/Bus\.emit\(\s*"([^"]+)"/g)) collect(jsBusEmit, m[1], name);
  for (const m of s.matchAll(/Bus\.on\(\s*"([^"]+)"/g)) collect(jsBusOn, m[1], name);
  for (const m of s.matchAll(/\bid=\\?["']([^"'$\s]+)\\?["']/g)) jsIds.add(m[1]);
  for (const m of s.matchAll(/\.id\s*=\s*["']([^"'$\s]+)["']/g)) jsIds.add(m[1]);
  for (const m of s.matchAll(/querySelector(?:All)?\(\s*["'`]#([\w-]+)["'`]/g)) collect(jsQueries, m[1], name);
  for (const m of s.matchAll(/getElementById\(\s*["'`]([\w-]+)["'`]/g)) collect(jsQueries, m[1], name);
}

console.log("\n=== 2. 前端 invoke ↔ Rust 注册 ===");
// plugin:* 是 Tauri 官方插件（dialog/fs 等）的命令，不在本仓库注册表内
const missingCmd = [...jsCalls.keys()].filter((k) => !k.startsWith("plugin:") && !rustRegistered.has(k)).sort();
if (missingCmd.length) {
  for (const k of missingCmd) bad(`前端 invoke("${k}") 但 Rust 未注册  <- ${[...jsCalls.get(k)].join(", ")}`);
} else {
  ok(`前端调用的 ${jsCalls.size} 个命令均在 Rust 注册表中`);
}

console.log("\n=== 3. JS 查询的 DOM id ↔ HTML/模板中的 id ===");
const knownIds = new Set(jsIds);
for (const h of htmlFiles) {
  const s = read(path.join(WEB, h));
  for (const m of s.matchAll(/\bid="([^"$]+)"/g)) knownIds.add(m[1]);
}
const badIds = [...jsQueries.keys()].filter((k) => !knownIds.has(k)).sort();
if (badIds.length) {
  for (const k of badIds) bad(`查询 #${k} 但任何 HTML/模板中都不存在  <- ${[...jsQueries.get(k)].join(", ")}`);
} else {
  ok(`查询的 ${jsQueries.size} 个 id 均能在 HTML 或 JS 模板中找到`);
}

console.log("\n=== 4. 事件配对（提示级：单向事件可能是预留契约） ===");
// Rust emit → 前端 listen（bus.js 桥接后再 Bus.emit，故两者都算接收方）
const rustOnly = [...rustEmits.keys()].filter((k) => !jsListens.has(k)).sort();
for (const k of rustOnly) warn(`Rust emit "${k}" 但前端无 listen  <- ${[...rustEmits.get(k)].join(", ")}`);
// Bus.emit → Bus.on（桥接事件在被监听时才有效）
const busOnly = [...jsBusEmit.keys()].filter((k) => !jsBusOn.has(k)).sort();
for (const k of busOnly) warn(`Bus.emit "${k}" 但无 Bus.on  <- ${[...jsBusEmit.get(k)].join(", ")}`);
if (!rustOnly.length && !busOnly.length) ok("所有事件均有接收方");

console.log(`\n结果：${pass} 通过 / ${fail} 失败${warnN ? ` / ${warnN} 提示` : ""}`);
process.exit(fail ? 1 : 0);