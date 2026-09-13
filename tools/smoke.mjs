// DeskOverlay 前端冒烟测试 —— 真浏览器（headless Chrome）+ CDP，注入假后端跑通关键契约。
//
// 为什么需要：Rust 侧 `cargo check` 只能保证编译，前端的实际行为（搜索结果右键菜单走哪套
// 命令族、提醒窗口「无内容不显示」不变量）此前从未被执行验证过。而 Electron/Tauri 之外
// 的纯浏览器运行会把 `window.__TAURI__` 换成假后端，从而可在 CI 里无人值守地复核。
//
// 用法：
//   node tools/smoke.mjs                    # 自动探测 Chrome 路径
//   CHROME=D:\\chrome.exe node tools/smoke.mjs
//
// 退出码：0 = 全部通过；1 = 有断言失败。
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WEB = path.join(ROOT, "frontend", "web");
const MOCK_SRC = fs.readFileSync(path.join(ROOT, "tools", "smoke-mock.js"), "utf8");

const CHROME = process.env.CHROME || [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
].find((p) => fs.existsSync(p));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ───────────────────────── 静态服务 ─────────────────────────
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
};
const server = http.createServer((req, res) => {
  const p = decodeURIComponent((req.url || "/").split("?")[0]);
  // 空 favicon：headless Chrome 总会请求它，返回 404 会产生一条「Failed to load resource」
  // 控制台错误，其到达时机不确定 → 会随机污染「无 JS 异常」断言。从源头消掉这层噪声。
  if (p === "/favicon.ico") { res.writeHead(200, { "Content-Type": "image/x-icon" }); res.end(); return; }
  const fp = path.join(WEB, p === "/" ? "index.html" : p);
  // 防目录穿越：解析后必须仍在 web 根内
  if (!fp.startsWith(WEB)) { res.writeHead(403); res.end("403"); return; }
  fs.readFile(fp, (err, buf) => {
    if (err) {
      console.log(`  [404] ${p}`);
      res.writeHead(404);
      res.end("404");
      return;
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(fp)] || "application/octet-stream" });
    res.end(buf);
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const PORT = server.address().port;
const BASE = `http://127.0.0.1:${PORT}`;

// ───────────────────────── 启动 Chrome ─────────────────────────
if (!CHROME) {
  console.error("找不到 Chrome，请用 CHROME=<路径> 指定。");
  process.exit(1);
}
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "deskoverlay-smoke-"));
const chrome = spawn(CHROME, [
  "--headless=new",
  "--disable-gpu",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-extensions",
  "--remote-debugging-port=0",
  `--user-data-dir=${profile}`,
  "--window-size=1600,900",
  "about:blank",
], { stdio: "ignore" });

function cleanup(code) {
  try { chrome.kill(); } catch {}
  try { server.close(); } catch {}
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
  process.exit(code);
}

const portFile = path.join(profile, "DevToolsActivePort");
let devPort = null;
for (let i = 0; i < 100 && !devPort; i++) {
  if (fs.existsSync(portFile)) {
    devPort = fs.readFileSync(portFile, "utf8").split(/\r?\n/)[0].trim();
    break;
  }
  await sleep(100);
}
if (!devPort) { console.error("Chrome 未在 10s 内就绪（DevToolsActivePort 未生成）"); cleanup(1); }

let wsUrl = null;
for (let i = 0; i < 50 && !wsUrl; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${devPort}/json/list`)).json();
    wsUrl = list.find((t) => t.type === "page")?.webSocketDebuggerUrl || null;
  } catch {}
  if (!wsUrl) await sleep(100);
}
if (!wsUrl) { console.error("未找到可用的页面调试目标"); cleanup(1); }

// ───────────────────────── 极简 CDP 客户端 ─────────────────────────
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.handlers = new Map();
    ws.addEventListener("message", (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id) {
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
      } else if (m.method) {
        (this.handlers.get(m.method) || []).forEach((f) => f(m.params));
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.seq;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
  }
}

const ws = new WebSocket(wsUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve);
  ws.addEventListener("error", reject);
});
const cdp = new CDP(ws);

await cdp.send("Page.enable");
await cdp.send("Runtime.enable");
await cdp.send("Log.enable");
// 必须在任何页面脚本之前注入，供模块作用域读取 window.__TAURI__
await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: MOCK_SRC });

// 两类问题分开收集：JS 异常是硬信号；来源为 network 的控制台错误属资源加载噪声，
// 不应当作「页面脚本出错」（favicon 已在上面的静态服务里消掉，双保险）。
const problems = [];
const netNoise = [];
cdp.on("Runtime.exceptionThrown", (p) => {
  const d = p.exceptionDetails || {};
  problems.push("JS 异常：" + (d.exception?.description || d.text || "unknown"));
});
cdp.on("Log.entryAdded", (p) => {
  const e = p.entry || {};
  if (e.level !== "error") return;
  if (e.source === "network") netNoise.push(e.text);
  else problems.push("控制台错误：" + e.text);
});

async function evaluate(expression) {
  const r = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error("求值失败：" + (d.exception?.description || d.text) + "\n表达式：" + expression);
  }
  return r.result.value;
}
async function waitFor(expression, label, timeout = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { if (await evaluate(expression)) return; } catch {}
    await sleep(100);
  }
  throw new Error(`等待超时（${timeout}ms）：${label}`);
}

// ───────────────────────── 断言 ─────────────────────────
const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass, detail });
  console.log(`${pass ? "  通过  " : "  失败  "} ${name}${detail ? "  —  " + detail : ""}`);
}
function eq(name, actual, expected) {
  check(name, actual === expected, actual === expected ? "" : `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

let failed = false;
try {
  // ═══════════ 主窗口：文件中心搜索 + 搜索结果右键菜单 ═══════════
  await cdp.send("Page.navigate", { url: `${BASE}/index.html` });
  await waitFor(`document.readyState === "complete"`, "index.html 加载完成");
  await waitFor(`!!document.querySelector("#d-file-search")`, "文件中心渲染出搜索框");
  check(
    "主窗口启动无 JS 异常、无资源加载失败",
    problems.length === 0 && netNoise.length === 0,
    [...problems, ...netNoise.map((t) => "资源加载：" + t)].join(" | ")
  );

  // 输入查询 → 触发 200ms 防抖 → search_files → 渲染结果列表
  await evaluate(`
    const el = document.querySelector("#d-file-search");
    el.value = "采购";
    el.dispatchEvent(new Event("input", { bubbles: true }));
    true;
  `);
  await waitFor(`document.querySelectorAll("#d-file-results .ev-item").length === 3`, "搜索结果渲染 3 行");

  const rows = await evaluate(`Array.from(document.querySelectorAll("#d-file-results .ev-item")).map(r => r.dataset.path)`);
  eq("结果行携带全盘绝对路径", rows[0], "C:\\Users\\qiuxr\\Documents\\采购\\Q1 汇总表.xlsx");
  eq("结果行数", rows.length, 3);
  const pathOnly = rows.find((p) => p.includes("\\采购\\"));
  check(
    "位于同名目录下的文件未被丢失（文件名不含查询词，仅父目录含）",
    !!pathOnly && !pathOnly.split("\\").pop().includes("采购"),
    pathOnly ? `文件名「${pathOnly.split("\\").pop()}」由父目录「采购」命中` : "未找到该条"
  );

  // 右键 → 菜单应出现，且为「搜索版」（含复制完整路径，共 5 项）
  await evaluate(`
    const r = document.querySelector("#d-file-results .ev-item");
    r.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 100, clientY: 100 }));
    true;
  `);
  await waitFor(`!!document.querySelector(".file-menu")`, "右键菜单出现");
  const labels = await evaluate(`Array.from(document.querySelectorAll(".file-menu button[data-act]")).map(b => b.textContent.trim())`);
  eq("菜单项数（搜索版 5 项 > 桌面版 4 项）", labels.length, 5);
  eq("菜单含「复制完整路径」", labels.includes("复制完整路径"), true);

  // 菜单不得越出视口：位置已按实测尺寸夹取
  const clamped = await evaluate(`
    (() => {
      const m = document.querySelector(".file-menu");
      const rect = m.getBoundingClientRect();
      return rect.left >= 0 && rect.top >= 0 &&
             rect.right <= window.innerWidth + 1 && rect.bottom <= window.innerHeight + 1;
    })()
  `);
  check("菜单夹取在视口内", clamped === true);

  // 点「删除」→ 确认框须带完整路径（避免同名文件误删）
  await evaluate(`document.querySelector('.file-menu button[data-act="delete"]').click(); true;`);
  await waitFor(`!!document.querySelector(".task-modal-overlay .cm-message")`, "删除确认框出现");
  const dialogText = await evaluate(`document.querySelector(".task-modal-overlay .cm-message").textContent`);
  check("确认框展示完整路径", dialogText.includes("C:\\Users\\qiuxr\\Documents\\采购\\Q1 汇总表.xlsx"), dialogText.replace(/\n/g, " / "));

  // 确认删除 → 必须调用**绝对路径作用域**的 delete_path，且 target 为原样全路径
  await evaluate(`window.__smoke.reset(); document.querySelector(".task-modal-overlay .cm-ok").click(); true;`);
  await waitFor(`window.__smoke.callsOf("delete_path").length === 1`, "调用 delete_path");
  const del = await evaluate(`window.__smoke.callsOf("delete_path")[0]`);
  eq("delete_path 收到完整路径", del.args.target, "C:\\Users\\qiuxr\\Documents\\采购\\Q1 汇总表.xlsx");
  eq("未误用桌面作用域命令 delete_file", (await evaluate(`window.__smoke.callsOf("delete_file").length`)), 0);

  // ═══════════ 提醒窗口 ═══════════
  problems.length = 0;
  await cdp.send("Page.navigate", { url: `${BASE}/reminder.html` });
  await waitFor(`document.readyState === "complete" && !!document.getElementById("card")`, "reminder.html 加载完成");
  await waitFor(`window.__smoke.listenerCount("show-reminder") === 1`, "show-reminder 监听器已注册");

  const idle = await evaluate(`document.getElementById("card").classList.contains("show")`);
  eq("未收到推送时不显示（窗口可见 ⟺ 有内容）", idle, false);

  const fired = await evaluate(`window.__smoke.fire("show-reminder", { icon: "<svg></svg>", title: "久坐提醒", message: "该起来活动一下了" });`);
  eq("推送被监听器接收", fired, 1);
  const shown = await evaluate(`
    (() => {
      const c = document.getElementById("card");
      return { show: c.classList.contains("show"), timing: c.classList.contains("timing"), type: c.dataset.type,
               title: document.getElementById("title").textContent, msg: document.getElementById("msg").textContent };
    })()
  `);
  eq("渲染后卡片显示", shown.show, true);
  eq("倒计时动画类已挂（自动关闭依赖它）", shown.timing, true);
  eq("提醒类型推断（久坐）", shown.type, "sedentary");
  eq("标题渲染", shown.title, "久坐提醒");
  eq("正文渲染", shown.msg, "该起来活动一下了");

  await evaluate(`window.__smoke.reset(); document.getElementById("ok").click(); true;`);
  await waitFor(`window.__smoke.callsOf("hide_reminder").length >= 1`, "点「知道了」调用 hide_reminder");
  check("提醒关闭走 hide_reminder", true);

  await sleep(300);
  check(
    "提醒窗口全程无 JS 异常、无资源加载失败",
    problems.length === 0 && netNoise.length === 0,
    [...problems, ...netNoise.map((t) => "资源加载：" + t)].join(" | ")
  );
} catch (err) {
  failed = true;
  console.error("\n执行中断：" + err.message);
}

const pass = results.filter((r) => r.pass).length;
console.log(`\n断言 ${pass}/${results.length} 通过${failed ? "，执行中断" : ""}`);
cleanup(!failed && problems.length === 0 && netNoise.length === 0 ? 0 : 1);
