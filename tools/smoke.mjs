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

  // ═══════════ 桌面歌词窗口（P1 骨架） ═══════════
  problems.length = 0;
  netNoise.length = 0;
  await cdp.send("Page.navigate", { url: `${BASE}/lyric.html` });
  await waitFor(`document.readyState === "complete" && !!document.getElementById("bar")`, "lyric.html 加载完成");
  await waitFor(`window.__smoke.listenerCount("lyric://line") === 1`, "lyric://line 监听器已注册");
  // 注意用 >=1 而非 ===1：歌词页经 theme.js 引入了 bus.js，它会把 lyric://display
  // 桥接进应用内 Bus，故本页该通道有 2 个监听器（业务监听 + 桥接）。
  // 写死 ===1 会永远等不到（这里踩过一次：表现为「监听器已注册」超时，但通道其实早就好了）。
  await waitFor(`window.__smoke.listenerCount("lyric://display") >= 1`, "lyric://display 监听器已注册");
  await waitFor(`window.__smoke.listenerCount("lyric://locked") === 1`, "lyric://locked 监听器已注册");

  // 握手顺序：必须**先注册 listener 再调 lyric_ready**，否则 Rust 侧 ready 后立即 emit
  // 会在 listener 就绪前发出而丢失（reminder.js 用同一套握手规避过）。
  await waitFor(`window.__smoke.callsOf("lyric_ready").length === 1`, "就绪握手已发送");

  // 不变量「窗口可见 ⟺ 有内容」：未收到任何推送时也必须有占位内容，不能是空白窗。
  const idleLyric = await evaluate(`
    (() => {
      const t = document.getElementById("text").textContent;
      const line = document.getElementById("line");
      return { text: t, idle: line.dataset.idle, hasFill: !!document.getElementById("fill") };
    })()
  `);
  check("未收到推送时已有占位内容（可见 ⟺ 有内容）", idleLyric.text.length > 0, `实际: ${JSON.stringify(idleLyric.text)}`);
  eq("占位态标记为 idle", idleLyric.idle, "1");

  // 推送一行歌词 → 渲染文本 + 进入非 idle 态
  await evaluate(`window.__smoke.fire("lyric://line", { idx: 3, text: "夜色渐浓 灯火也温柔", lineStart: 83.4, lineEnd: 88.9, t0: 85, playing: true });`);
  const shownLyric = await evaluate(`
    (() => ({
      text: document.getElementById("text").textContent,
      fill: document.getElementById("fill").textContent,
      idle: document.getElementById("line").dataset.idle,
      playing: document.getElementById("bar").dataset.playing,
    }))()
  `);
  eq("歌词文本渲染", shownLyric.text, "夜色渐浓 灯火也温柔");
  eq("染色副本内容与底层一致", shownLyric.fill, "夜色渐浓 灯火也温柔");
  eq("离开占位态", shownLyric.idle, "0");
  eq("播放态标记已置位", shownLyric.playing, "true");

  // t0 校准：事件带 t0=85、行区间 [83.4, 88.9]，到达瞬间进度应直接对齐到
  // (85-83.4)/5.5 ≈ 29%，而不是从 0 开始爬 —— 否则每次换行染色都晚一拍。
  const pAligned = await evaluate(`parseFloat(document.getElementById("fill").style.getPropertyValue("--p") || "0")`);
  check("t0 校准使染色立即对齐到推送时刻", pAligned >= 0.25 && pAligned <= 0.35, `--p = ${pAligned}（期望≈0.29）`);

  // 版式：底层与染色层必须像素级重合。
  // 用实测矩形而非截图 —— 绝对定位元素在 flex 容器里纵向位置不可靠，
  // 一旦错位，染色会与文字本体分离（视觉上是「两层字」），这条断言专门守它。
  const align = await evaluate(`
    (() => {
      const t = document.getElementById("text").getBoundingClientRect();
      const f = document.getElementById("fill").getBoundingClientRect();
      return { dx: Math.round(Math.abs(t.left - f.left)), dy: Math.round(Math.abs(t.top - f.top)),
               dw: Math.round(Math.abs(t.width - f.width)) };
    })()
  `);
  check("底层与染色层水平重合", align.dx <= 1, `Δx = ${align.dx}`);
  check("底层与染色层垂直重合", align.dy <= 1, `Δy = ${align.dy}`);
  check("底层与染色层等宽", align.dw <= 1, `Δw = ${align.dw}`);

  // 卡拉OK 染色进度：rAF 插值应继续推进 --p（真浏览器里 rAF 真实运行）
  await sleep(400);
  const p1 = await evaluate(`parseFloat(document.getElementById("fill").style.getPropertyValue("--p") || "0")`);
  check("rAF 插值推进染色进度", p1 > pAligned, `${pAligned} → ${p1}`);

  // 暂停 → 按 t0 **精确定位**后冻结（不归零：归零会让进度条跳回行首，像重播这一句）。
  // 暂停态随 lyric://line 的 playing 字段下发（主窗口在 pause 事件里 force 推一次并带 t0），
  // 故暂停时进度先对齐到暂停那一刻、再静止 —— 比「保持上一个插值值」更准。
  // t0=86.5、行区间 [83.4, 88.9] → (86.5-83.4)/5.5 ≈ 0.56
  await evaluate(`window.__smoke.fire("lyric://line", { idx: 3, text: "夜色渐浓 灯火也温柔", lineStart: 83.4, lineEnd: 88.9, t0: 86.5, playing: false });`);
  await sleep(60);
  const pPause = await evaluate(`parseFloat(document.getElementById("fill").style.getPropertyValue("--p") || "0")`);
  check("暂停按 t0 精确定位（≈0.56）", pPause > 0.50 && pPause < 0.62, `--p = ${pPause}`);
  await sleep(200);
  const pPause2 = await evaluate(`parseFloat(document.getElementById("fill").style.getPropertyValue("--p") || "0")`);
  eq("暂停期间进度不再推进", pPause2, pPause);

  // 无歌词占位态：idle=true 时应显示「歌名 — 歌手」，绝不出现空窗
  await evaluate(`window.__smoke.fire("lyric://line", { idx: -1, text: "", title: "夜航", artist: "某某", idle: true, playing: true });`);
  const idleMeta = await evaluate(`
    (() => ({ text: document.getElementById("text").textContent, idle: document.getElementById("line").dataset.idle }))()
  `);
  eq("无歌词时退化为「歌名 — 歌手」", idleMeta.text, "夜航 — 某某");
  eq("占位态标记为 idle", idleMeta.idle, "1");

  // 锁定/穿透切换：这是 P1 的核心行为。穿透是否真的生效只能真机看，
  // 但「切换时是否真的下发了 set_ignore_cursor_events」可以自动断言。
  // 注意按钮是**双向**的（显示当前状态的下一步动作），故先经事件把状态摆正到
  // 「已解锁」，再点按钮，此时它的动作才是「锁定」。
  await evaluate(`window.__smoke.fire("lyric://locked", { locked: false }); true;`);
  await sleep(60);
  await evaluate(`window.__smoke.reset(); document.getElementById("btn-lock").click(); true;`);
  await waitFor(`window.__smoke.callsOf("lyric_set_locked").length === 1`, "点锁定下发 lyric_set_locked");
  const lockCall = await evaluate(`window.__smoke.callsOf("lyric_set_locked")[0].args`);
  eq("锁定请求为 locked=true", lockCall.locked, true);
  await sleep(60);
  eq("锁定态写入 data-locked", await evaluate(`document.getElementById("bar").dataset.locked`), "true");

  // 解锁路径：锁定态下窗口收不到鼠标事件（穿透），本页无法自行解锁，
  // 只能由外部（Rust 悬停探测线程 / 主窗口 / 后续热键）经 lyric://locked 下发。
  // 关键：本页收到后**只更新本地态，绝不回发 lyric_set_locked** ——
  // 回发会让 Rust 再次广播 lyric://locked，形成无限回声。
  await evaluate(`window.__smoke.reset(); window.__smoke.fire("lyric://locked", { locked: false }); true;`);
  await sleep(60);
  eq("外部下发解锁后本地态跟随", await evaluate(`document.getElementById("bar").dataset.locked`), "false");
  eq("外部解锁不回发命令（无回声）", await evaluate(`window.__smoke.callsOf("lyric_set_locked").length`), 0);

  // 锁定态下工具条**不再隐藏**：穿透时页面收不到鼠标事件，:hover 永不触发，
  // opacity 本就停在 0；原先那条 display:none 反而会在状态标记滞后时把按钮整个藏掉，
  // 让用户找不到解锁入口（这正是「没有解锁按钮」的根因之一）。
  await evaluate(`window.__smoke.fire("lyric://locked", { locked: true }); true;`);
  await sleep(60);
  eq("外部锁定后工具条仍可渲染（不 display:none）",
    await evaluate(`getComputedStyle(document.getElementById("tools")).display !== "none"`), true);
  // 锁定按钮文字必须变成「解锁」——这是用户唯一的回到可交互状态的入口
  eq("锁定时按钮显示「解锁」", await evaluate(`document.getElementById("btn-lock").textContent`), "解锁");
  await evaluate(`window.__smoke.fire("lyric://locked", { locked: false }); true;`);
  await sleep(60);
  eq("解锁后按钮显示「锁定」", await evaluate(`document.getElementById("btn-lock").textContent`), "锁定");

  // 字号调节
  const size0 = await evaluate(`getComputedStyle(document.documentElement).getPropertyValue("--ly-size").trim()`);
  await evaluate(`document.getElementById("btn-bigger").click(); true;`);
  const size1 = await evaluate(`getComputedStyle(document.documentElement).getPropertyValue("--ly-size").trim()`);
  check("增大字号生效", parseInt(size1) > parseInt(size0), `${size0} → ${size1}`);

  // 关闭走 hide_lyric（销毁窗口，释放 WebView2 实例）
  await evaluate(`window.__smoke.reset(); document.getElementById("btn-close").click(); true;`);
  await waitFor(`window.__smoke.callsOf("hide_lyric").length >= 1`, "关闭调用 hide_lyric");

  await sleep(300);
  check(
    "歌词窗口全程无 JS 异常、无资源加载失败",
    problems.length === 0 && netNoise.length === 0,
    [...problems, ...netNoise.map((t) => "资源加载：" + t)].join(" | ")
  );

  // ═══════════ 主窗口：桌面歌词入口 ═══════════
  problems.length = 0;
  netNoise.length = 0;
  await cdp.send("Page.navigate", { url: `${BASE}/index.html` });
  await waitFor(`document.readyState === "complete" && !!document.querySelector(".nav-item")`, "主窗口加载完成");
  await evaluate(`(() => { const n = [...document.querySelectorAll(".nav-item")].find(x => /在线音乐/.test(x.textContent)); n && n.click(); return true; })()`);
  await waitFor(`!!document.getElementById("mc-lyric")`, "音乐页渲染出桌面歌词按钮");

  await evaluate(`window.__smoke.reset(); document.getElementById("mc-lyric").click(); true;`);
  await waitFor(`window.__smoke.callsOf("show_lyric").length === 1`, "点按钮调用 show_lyric");
  // P4 起 show_lyric 不再接收 locked：初始锁定态由 Rust 统一推导（state + 悬停解锁开关）。
  // 若这里又出现 locked 入参，说明两个入口（音乐页 / 设置页）会各传各的、行为分叉。
  eq("show_lyric 不再携带 locked 入参", "locked" in ((await evaluate(`window.__smoke.callsOf("show_lyric")[0].args`)) || {}), false);

  // 显示后应立即推一次首屏（force），否则歌词窗口停在占位文案直到下一次换行
  await waitFor(`window.__smoke.callsOf("lyric_sync").length >= 1`, "显示后立即推送首屏");
  const firstSync = await evaluate(`window.__smoke.callsOf("lyric_sync")[0].args.payload`);
  check("首屏推送带歌名/歌手字段", "title" in firstSync && "playing" in firstSync, JSON.stringify(firstSync).slice(0, 120));

  // ── P2 推送链路：用假音源插件走通「取流 → 取词 → 换行推送」全链路 ──
  // 只改 state 无法验证真实链路（fetchLyric 的异步补推、loadMeta 的换歌强制推都在插件路径上）。
  // 插件契约：getMediaSource(song) 返回 {url}；getLyric(song) 返回 LRC 文本。
  // 注意：fixture 必须在 Node 侧构造成对象后整体 JSON.stringify —— 手写嵌套引号
  // 会让内层字符串把外层引号吃掉（这里踩过一次：插件源码里的双引号提前闭合了字符串字面量）。
  const FAKE_SOURCE_CODE = [
    "module.exports = {",
    "  platform: '假音源',",
    "  getMediaSource: async () => ({ url: 'http://example.com/a.mp3' }),",
    // 同时返回行级 lyric 与逐字 qrc —— 这正是「逐字被行级遮蔽」的真实场景：
    // extractLrc 必须优先取逐字字段，否则拿到的永远是行级版本（只能同步到行）。
    "  getLyric: async () => ({",
    "    lyric: ['[00:00.00]夜色渐浓','[00:10.00]第二行歌词','[00:20.00]第三行歌词'].join('\\n'),",
    // 增强 LRC：4 个字，每字 1 秒（t=0/1/2/3），行区间 [0,10]。
    // 若按「整行线性扫描」，t=1s 时进度只有 10%；按字推进则应为 25%（第一字唱完）。
    // 另两行也给逐字数据，供「换行推送」断言使用。
    "    qrc: ['<00:00.00>夜<00:01.00>色<00:02.00>渐<00:03.00>浓',",
    "          '<00:10.00>第<00:11.00>二<00:12.00>行<00:13.00>歌<00:14.00>词',",
    "          '<00:20.00>第<00:21.00>三<00:22.00>行<00:23.00>歌<00:24.00>词'].join('\\n'),",
    "  }),",
    "};",
  ].join("\n");
  const LYRIC_FIXTURE = {
    musicSources: [{ id: "src1", name: "假音源", src: "fake", code: FAKE_SOURCE_CODE }],
    playback: {
      queue: [{ meta: { title: "夜航", artist: "某某" }, song: { title: "夜航", artist: "某某", hash: "h1" },
                srcId: "src1", url: "http://example.com/a.mp3", type: "在线" }],
      index: 0, song: { title: "夜航", artist: "某某", url: "http://example.com/a.mp3", srcId: "src1" },
      playing: true, currentTime: 0, volume: 0.8,
    },
  };
  await evaluate(`(() => { window.__smoke.setLoadState(${JSON.stringify(LYRIC_FIXTURE)}); return true; })()`);
  // 重新加载页面：initPlayback 从 fixture 恢复队列并真实取流+取词（这条路径不依赖视图渲染）
  await cdp.send("Page.navigate", { url: `${BASE}/index.html` });
  await waitFor(`document.readyState === "complete" && !!document.querySelector(".nav-item")`, "带音源 fixture 重新加载");
  await sleep(600);   // 等 initPlayback 的异步取流/取词落地

  // 关键：歌词窗口未打开时，一次 IPC 都不该发（闸门关闭 = 零开销）
  eq("未开启歌词窗口时不推送（闸门关闭）", await evaluate(`window.__smoke.callsOf("lyric_sync").length`), 0);

  // 开启歌词窗口 → 应立即推送首屏，且带真实歌名（证明 initPlayback 路径上的数据是活的）
  await evaluate(`(() => { const n = [...document.querySelectorAll(".nav-item")].find(x => /在线音乐/.test(x.textContent)); n && n.click(); return true; })()`);
  await waitFor(`!!document.getElementById("mc-lyric")`, "音乐页渲染");
  await evaluate(`window.__smoke.reset(); document.getElementById("mc-lyric").click(); true;`);
  await sleep(300);
  const withSong = await evaluate(`window.__smoke.callsOf("lyric_sync")`);
  check("首屏推送携带真实歌名", withSong.length >= 1 && withSong[0].args.payload.title === "夜航",
    JSON.stringify(withSong[0]?.args?.payload || {}).slice(0, 160));

  // ── 逐字歌词：核心断言 ──
  // 音源同时给了行级 lyric 和逐字 qrc，必须选中逐字（否则永远只能同步到行）。
  const firstPayload = withSong[0].args.payload;
  eq("逐字数据未被行级歌词遮蔽（extractLrc 优先逐字字段）", Array.isArray(firstPayload.words) ? "yes" : "no", "yes");
  eq("逐字片段数", firstPayload.words?.length, 4);
  eq("逐字文本拼回整行（防标签残留）", firstPayload.words?.map((w) => w.text).join(""), "夜色渐浓");
  eq("行文本已剥离逐字标签", firstPayload.text, "夜色渐浓");
  // 逐字时间应转为**相对行首**的偏移（窗口侧无需知道歌曲绝对时间轴）
  eq("逐字时间转为相对行首偏移", firstPayload.words?.map((w) => w.t).join(","), "0,1,2,3");

  // 换行推送与去重：直接驱动真实 Audio 实例的 timeupdate。
  // 音频实例由 `new Audio()` 创建且不入 DOM，经 mock 劫持构造器后可用 __smoke.audio() 取到。
  const seek = async (t, times = 1) => {
    await evaluate(`
      (() => {
        const a = window.__smoke.audio();
        if (!a) return false;
        a.currentTime = ${t};
        for (let i = 0; i < ${times}; i++) a.dispatchEvent(new Event("timeupdate"));
        return true;
      })()
    `);
    await sleep(120);
  };
  const syncCount = () => evaluate(`window.__smoke.callsOf("lyric_sync").length`);

  check("取到播放器 Audio 实例（供驱动 timeupdate）", await evaluate(`!!window.__smoke.audio()`), true);

  // 跳到第 2 行（10s 起）→ 应推一次，且 text 为第二行
  await evaluate(`window.__smoke.reset(); true;`);
  await seek(12, 3);   // 同一行内连续 3 次 timeupdate
  const n1 = await syncCount();
  eq("同一行内多次 timeupdate 只推一次（去重生效）", n1, 1);
  const line2 = await evaluate(`window.__smoke.callsOf("lyric_sync")[0].args.payload`);
  eq("换行后推送对应行文本", line2.text, "第二行歌词");
  check("推送带 t0 用于校准", typeof line2.t0 === "number" && line2.t0 >= 12, `t0 = ${line2.t0}`);

  // 再跳到第 3 行 → 应再推一次（行号变化必须推）
  await evaluate(`window.__smoke.reset(); true;`);
  await seek(21, 2);
  const line3 = await evaluate(`window.__smoke.callsOf("lyric_sync")[0]?.args?.payload`);
  eq("继续换行推送第三行", line3?.text, "第三行歌词");

  // 末行没有下一行 → 需给出默认 lineEnd，否则染色层无从计算进度
  check("末行有兜底 lineEnd（>lineStart）", line3.lineEnd > line3.lineStart, `[${line3.lineStart}, ${line3.lineEnd}]`);

  // ── 歌词时间偏移：display 下发 offset → music.js 落盘 → 推送行号与 t0 整体平移 ──
  // 配置入口在歌词条工具条（不放设置页），这里直接驱动广播验证数据链路。
  await evaluate(`window.__smoke.fire("lyric://display", { form: "single", style: "stroke", fontSize: 22, offset: 2 }); true;`);
  await sleep(80);
  await evaluate(`window.__smoke.reset(); true;`);
  await seek(9, 2);
  const offLine = await evaluate(`window.__smoke.callsOf("lyric_sync")[0]?.args?.payload`);
  eq("偏移生效：9s+2s 提前切到第二行", offLine?.text, "第二行歌词");
  eq("偏移生效：t0 = 音频时间 + 偏移", offLine.t0, 11);
  // 偏移清零，避免影响后续断言
  await evaluate(`window.__smoke.fire("lyric://display", { offset: 0 }); true;`);
  await sleep(80);


  // ── 逐字裁切：切到歌词窗口页，验证「按字推进」而非整行线性扫描 ──
  // 判据：同样 t=1s，线性扫描只到 10%（1/10），按字推进应到 25%（第一个字刚好唱完）。
  // 这是「不准确到字」的回归防线。
  await cdp.send("Page.navigate", { url: `${BASE}/lyric.html` });
  await waitFor(`document.readyState === "complete" && !!document.getElementById("bar")`, "歌词页加载");
  await waitFor(`window.__smoke.callsOf("lyric_ready").length >= 1`, "歌词页握手");
  const WORDS_LINE = { idx: 0, text: "夜色渐浓", lineStart: 0, lineEnd: 10, t0: 1, playing: false,
    words: [{ t: 0, d: 1, text: "夜" }, { t: 1, d: 1, text: "色" }, { t: 2, d: 1, text: "渐" }, { t: 3, d: 1, text: "浓" }] };
  await evaluate(`window.__smoke.fire("lyric://line", ${JSON.stringify(WORDS_LINE)}); true;`);
  await sleep(120);
  const pWord = await evaluate(`parseFloat(document.getElementById("fill").style.getPropertyValue("--p") || "0")`);
  check("逐字裁切：t=1s 时进度≈25%（第一字唱完），而非线性扫描的 10%", pWord > 0.15 && pWord < 0.40,
    `--p = ${pWord}（线性扫描会是 0.10）`);

  // 无逐字数据时必须回退线性扫描（不能因为拿不到逐字就完全不染色）
  await evaluate(`window.__smoke.fire("lyric://line", { idx: 0, text: "夜色渐浓", lineStart: 0, lineEnd: 10, t0: 1, playing: false }); true;`);
  await sleep(120);
  const pLinear = await evaluate(`parseFloat(document.getElementById("fill").style.getPropertyValue("--p") || "0")`);
  check("无逐字数据时回退整行线性扫描", pLinear > 0.05 && pLinear < 0.15, `--p = ${pLinear}（期望≈0.10）`);

  // 逐字片段与行文本不匹配时也必须回退（防宽度映射错位导致染色跑到字缝里）
  await evaluate(`window.__smoke.fire("lyric://line", { idx: 0, text: "完全不同的文本", lineStart: 0, lineEnd: 10, t0: 1, playing: false,
    words: [{ t: 0, d: 1, text: "夜" }, { t: 1, d: 1, text: "色" }] }); true;`);
  await sleep(120);
  const pMismatch = await evaluate(`parseFloat(document.getElementById("fill").style.getPropertyValue("--p") || "0")`);
  check("逐字与行文本不匹配时回退线性扫描", pMismatch > 0.05 && pMismatch < 0.15, `--p = ${pMismatch}`);

  // ── P3/P4：工具条按钮与锁定联动 ──
  // 形态/样式曾是右键菜单，已改为工具条上的可见按钮：
  // 歌词条默认穿透锁定，鼠标事件到不了页面，右键根本无反应，
  // 必须先悬停解锁 —— 等于要求用户先猜一个隐藏前提。
  await evaluate(`window.__smoke.reset(); true;`);
  const toolBtns = await evaluate(`
    (() => ({
      form: !!document.getElementById("btn-form"),
      style: !!document.getElementById("btn-style"),
      // 菜单类名必须已从页面消失（残留样式/代码会被误当成「还有菜单」）
      leftover: !!document.querySelector(".ly-menu"),
    }))()
  `);
  eq("工具条含形态按钮", toolBtns.form, true);
  eq("工具条含样式按钮", toolBtns.style, true);
  eq("右键菜单已移除（无残留节点）", toolBtns.leftover, false);

  // 工具条**不**随锁定隐藏（见上）：穿透时 :hover 不触发，它本就不显示。
  await evaluate(`window.__smoke.fire("lyric://locked", { locked: true }); true;`);
  await sleep(60);
  eq("锁定事件写入 data-locked", await evaluate(`document.getElementById("bar").dataset.locked`), "true");
  eq("锁定时按钮文字切为「解锁」", await evaluate(`document.getElementById("btn-lock").textContent`), "解锁");

  // 锁定态下只留「解锁」一个按钮 —— 其余按钮此时不可交互，显示出来会让人
  // 以为歌词条没锁（这也是「锁定之后还能操作」观感的来源）。
  await evaluate(`window.__smoke.fire("lyric://locked", { locked: true }); true;`);
  await sleep(60);
  const lockedBtns = await evaluate(`
    (() => [...document.querySelectorAll(".ly-tools .ly-btn")]
      .filter((b) => getComputedStyle(b).display !== "none")
      .map((b) => b.id))()
  `);
  eq("锁定态只显示解锁按钮", JSON.stringify(lockedBtns), JSON.stringify(["btn-lock"]));

  // 解锁 → 工具条可交互
  await evaluate(`window.__smoke.fire("lyric://locked", { locked: false }); true;`);
  await sleep(80);
  eq("外部解锁写入 data-locked", await evaluate(`document.getElementById("bar").dataset.locked`), "false");
  eq("解锁后按钮文字切回「锁定」", await evaluate(`document.getElementById("btn-lock").textContent`), "锁定");

  // 字号按钮必须显示 A- / A+（用户可读的惯用符号，而非含义不明的自绘图标）
  eq("减小字号按钮显示 A-", await evaluate(`document.getElementById("btn-smaller").textContent.trim()`), "A-");
  eq("增大字号按钮显示 A+", await evaluate(`document.getElementById("btn-bigger").textContent.trim()`), "A+");

  // 高度契约：歌词区高度必须吃满「视口高 - 工具条高」。
  // 曾因 #bar 加了 4px gap 而 Rust 高度没算它，歌词内容被压出窗口 ——
  // 切单双行时歌词和操作栏挤到一起。
  // 注意断言的是**相对关系**（吃满剩余）而非绝对 56px：冒烟浏览器视口 1600×900，
  // 真机窗口才是 90/122；布局契约是「工具条固定 34 + 歌词区吃满剩余」。
  const heightFit = await evaluate(`
    (() => {
      const tools = document.getElementById("tools").getBoundingClientRect();
      const lines = document.querySelector(".ly-lines").getBoundingClientRect();
      return { toolsH: Math.round(tools.height), linesH: Math.round(lines.height),
               expectH: window.innerHeight - Math.round(tools.height),
               noOverlap: lines.top >= tools.bottom - 1 };
    })()
  `);
  eq("工具条高度 34px", heightFit.toolsH, 34);
  eq("歌词区高度吃满剩余空间", heightFit.linesH, heightFit.expectH);
  check("工具条与歌词区不重叠", heightFit.noOverlap === true,
    `lines.top - tools.bottom = ${heightFit.linesH - heightFit.expectH}`);

  // 工具条必须在窗口内（窗口高度 = 歌词高 + 工具条高，浮出窗口的控件会被直接裁掉）
  const toolsBox = await evaluate(`
    (() => {
      const r = document.getElementById("tools").getBoundingClientRect();
      return { insideX: r.left >= -1 && r.right <= window.innerWidth + 1,
               insideY: r.top >= -1 && r.bottom <= window.innerHeight + 1 };
    })()
  `);
  check("工具条未溢出窗口", toolsBox.insideX === true && toolsBox.insideY === true,
    `insideX=${toolsBox.insideX} insideY=${toolsBox.insideY}`);

  // 关键回归：工具条必须**不占歌词宽度**（曾放在 flex 流里，即使透明也照样占宽，
  // 把歌词可用宽度从 724px 压到 ~478px —— 这正是「歌词显示宽度有问题」的根因）。
  const widthFit = await evaluate(`
    (() => {
      const lines = document.querySelector(".ly-lines").getBoundingClientRect();
      const bar = document.getElementById("bar").getBoundingClientRect();
      return { linesW: Math.round(lines.width), barW: Math.round(bar.width),
               // 歌词区应几乎占满整条（只差左右 padding 36px），而不是被工具条挤掉
               fillsBar: lines.width > bar.width - 60 };
    })()
  `);
  check("歌词区占满整条宽度（不被工具条挤压）", widthFit.fillsBar === true,
    `lines=${widthFit.linesW} bar=${widthFit.barW}`);
  check("歌词区宽度接近整条（≥ 660px）", widthFit.linesW >= 660, `lines=${widthFit.linesW}px`);

  // 居中性：歌词必须相对**整条**居中，而不是贴左。
  // 曾漏配 grid-template-columns:100% —— 单隐式列 auto 尺寸且 justify-content:start，
  // 该列贴左，place-items 只在列内居中，于是整块歌词看起来靠左。
  await evaluate(`window.__smoke.fire("lyric://line", { idx: 0, text: "夜色渐浓 灯火也温柔", lineStart: 0, lineEnd: 10, t0: 1, playing: false }); true;`);
  await sleep(80);
  const centerCheck = await evaluate(`
    (() => {
      const t = document.getElementById("text").getBoundingClientRect();
      const bar = document.getElementById("bar").getBoundingClientRect();
      const leftGap = t.left - bar.left, rightGap = bar.right - t.right;
      return { leftGap: Math.round(leftGap), rightGap: Math.round(rightGap),
               skew: Math.round(Math.abs(leftGap - rightGap)) };
    })()
  `);
  check("歌词相对整条水平居中（左右留白对称）", centerCheck.skew <= 24,
    `左=${centerCheck.leftGap} 右=${centerCheck.rightGap}`);

  // 染色层必须与底层文字**像素级重合**（居中改动后仍要对齐，否则染色会跑偏）
  const alignCheck = await evaluate(`
    (() => {
      const a = document.getElementById("text").getBoundingClientRect();
      const b = document.getElementById("fill").getBoundingClientRect();
      return { dx: Math.round(Math.abs(a.left - b.left)), dw: Math.round(Math.abs(a.width - b.width)) };
    })()
  `);
  check("染色层与底层文字重合（Δx=0, Δw=0）", alignCheck.dx === 0 && alignCheck.dw === 0,
    `Δx=${alignCheck.dx} Δw=${alignCheck.dw}`);

  // 锁定按钮是**双向**切换：点一次锁定，再点一次必须能解锁（曾经只单向锁定 → 锁死）
  await evaluate(`window.__smoke.reset(); document.getElementById("btn-lock").click(); true;`);
  await waitFor(`window.__smoke.callsOf("lyric_set_locked").length === 1`, "锁定按钮下发 lyric_set_locked");
  eq("第一次点击 → locked=true", (await evaluate(`window.__smoke.callsOf("lyric_set_locked")[0].args`)).locked, true);
  await sleep(60);
  eq("锁定时按钮文字为「解锁」", await evaluate(`document.getElementById("btn-lock").textContent`), "解锁");
  await evaluate(`window.__smoke.reset(); document.getElementById("btn-lock").click(); true;`);
  await waitFor(`window.__smoke.callsOf("lyric_set_locked").length === 1`, "再次点击下发 lyric_set_locked");
  eq("第二次点击 → locked=false（可解回）",
    (await evaluate(`window.__smoke.callsOf("lyric_set_locked")[0].args`)).locked, false);

  // sticky（保持解锁）：Rust 下发 sticky=true 时按钮高亮，表示不会被自动锁回
  await evaluate(`window.__smoke.fire("lyric://locked", { locked: false, sticky: true }); true;`);
  await sleep(60);
  eq("保持解锁时按钮高亮", await evaluate(`document.getElementById("btn-lock").classList.contains("active")`), true);

  // 「悬停解锁」关闭 → 禁用锁定按钮（否则锁上就再也解不开）
  await evaluate(`window.__smoke.fire("lyric://locked", { locked: false, sticky: false, hoverUnlock: false }); true;`);
  await sleep(60);
  eq("关闭悬停解锁时禁用锁定按钮", await evaluate(`document.getElementById("btn-lock").disabled`), true);
  await evaluate(`window.__smoke.fire("lyric://locked", { locked: false, sticky: false, hoverUnlock: true }); true;`);
  await sleep(60);
  eq("开启悬停解锁后恢复可点", await evaluate(`document.getElementById("btn-lock").disabled`), false);

  // 字号按钮
  await evaluate(`window.__smoke.fire("lyric://locked", { locked: false }); true;`);
  await sleep(60);
  const sizeBefore = await evaluate(`getComputedStyle(document.documentElement).getPropertyValue("--ly-size").trim()`);
  await evaluate(`document.getElementById("btn-bigger").click(); true;`);
  await sleep(60);
  const sizeAfter = await evaluate(`getComputedStyle(document.documentElement).getPropertyValue("--ly-size").trim()`);
  check("字号按钮生效", parseInt(sizeAfter) > parseInt(sizeBefore), `${sizeBefore} → ${sizeAfter}`);

  // ── P4：单双行与视觉模式 ──
  // 初始形态来自 Rust 下发的 lyric://display；先确认默认值
  eq("初始形态为单行", await evaluate(`document.getElementById("bar").dataset.form`), "single");

  // 单行形态下第二行必须**不可见**（display:none）—— 否则窗口只有 56px 高，
  // 多出来的行会被裁掉一半，看起来像渲染错误
  const nextHidden = await evaluate(`
    (() => {
      const el = document.getElementById("line2");
      return getComputedStyle(el).display === "none";
    })()
  `);
  eq("单行形态隐藏第二行", nextHidden, true);

  // 双行形态：改 data-form 后第二行应可见。
  // 注意必须走真实事件（Rust 广播），直接改 dataset 只改 DOM 属性、JS 内部 form 变量不变。
  await evaluate(`window.__smoke.fire("lyric://display", { form: "double", style: "stroke", fontSize: 22 }); true;`);
  await sleep(80);
  eq("形态切到双行", await evaluate(`document.getElementById("bar").dataset.form`), "double");
  const nextShown = await evaluate(`getComputedStyle(document.getElementById("line2")).display !== "none"`);
  eq("双行形态显示第二行", nextShown, true);

  // 第二行渲染的是「下一句」（payload.next），且**没有染色层**（未播到的句子不应预染色）
  await evaluate(`window.__smoke.fire("lyric://line", { idx: 0, text: "当前句", next: "下一句", lineStart: 0, lineEnd: 10, t0: 1, playing: false }); true;`);
  await sleep(80);
  eq("第二行渲染下一句", await evaluate(`document.getElementById("text2").textContent`), "下一句");
  eq("第二行无染色层", await evaluate(`!!document.querySelector("#line2 .ly-fill")`), false);

  // 末行没有 next → 第二行留空，避免残留上一首的句子
  await evaluate(`window.__smoke.fire("lyric://line", { idx: 0, text: "最后一句", next: "", lineStart: 0, lineEnd: 10, t0: 1, playing: false }); true;`);
  await sleep(80);
  eq("末行第二行为空（不残留）", await evaluate(`document.getElementById("text2").textContent`), "");

  // 三种视觉模式：data-style 驱动，胶囊模式必须有底板（区别于描边模式）
  const styleSamples = {};
  for (const s of ["stroke", "capsule", "bold"]) {
    await evaluate(`window.__smoke.fire("lyric://display", { form: "double", style: "${s}", fontSize: 22 }); true;`);
    // 等待必须盖过 #bar 的 background 过渡（160ms）：60ms 时可能读出过渡起点（透明），
    // 造成「胶囊模式有底板」偶发假失败
    await sleep(220);
    styleSamples[s] = await evaluate(`
      (() => {
        const cs = getComputedStyle(document.getElementById("bar"));
        const t = getComputedStyle(document.getElementById("text"));
        return { style: document.getElementById("bar").dataset.style, bg: cs.backgroundColor, weight: t.fontWeight };
      })()
    `);
  }
  eq("描边模式 data-style", styleSamples.stroke.style, "stroke");
  eq("胶囊模式 data-style", styleSamples.capsule.style, "capsule");
  eq("加粗模式 data-style", styleSamples.bold.style, "bold");
  // 胶囊模式有底板、描边模式透明 —— 这是两种模式最本质的视觉差异
  check("胶囊模式有底板", styleSamples.capsule.bg !== "rgba(0, 0, 0, 0)", `bg = ${styleSamples.capsule.bg}`);
  check("描边模式无底板", styleSamples.stroke.bg === "rgba(0, 0, 0, 0)", `bg = ${styleSamples.stroke.bg}`);
  check("加粗模式字重更大", parseInt(styleSamples.bold.weight) > parseInt(styleSamples.stroke.weight),
    `${styleSamples.stroke.weight} → ${styleSamples.bold.weight}`);

  // ── 配色应用：lyric://display 下发颜色 → CSS 变量 → 文字/染色实际变色 ──
  await evaluate(`window.__smoke.fire("lyric://line", { idx: 0, text: "夜色渐浓 灯火也温柔", lineStart: 0, lineEnd: 10, t0: 1, playing: false }); true;`);
  await sleep(60);
  await evaluate(`window.__smoke.fire("lyric://display", { form: "double", style: "bold", fontSize: 22, colorText: "#FFE9A8", colorFill: "#FF6B9D" }); true;`);
  await sleep(80);
  eq("自定义文字颜色应用", await evaluate(`getComputedStyle(document.getElementById("text")).color`), "rgb(255, 233, 168)");
  eq("自定义染色颜色应用", await evaluate(`getComputedStyle(document.getElementById("fill")).color`), "rgb(255, 107, 157)");
  // 空串 = 回到默认：文字近白；染色跟随主题品牌色（不再是自定义色）。
  // 这里守的是 removeProperty 回退路径 —— 空值自定义属性会让 var() 替换出非法声明。
  await evaluate(`window.__smoke.fire("lyric://display", { form: "double", style: "bold", fontSize: 22, colorText: "", colorFill: "" }); true;`);
  await sleep(80);
  eq("空串恢复默认文字色（近白）", await evaluate(`getComputedStyle(document.getElementById("text")).color`), "rgb(245, 249, 254)");
  const fillDefault = await evaluate(`getComputedStyle(document.getElementById("fill")).color`);
  check("空串恢复默认染色（跟随主题，非自定义色）", fillDefault !== "rgb(255, 107, 157)", fillDefault);

  // ── 工具条「设置」面板：网易云式点选交互（色板直选 + 偏移 ± 步进）──
  // 展开面板 → 必须下发 lyric_panel（Rust 把窗口向上加高、底边锚定，歌词不动）
  await evaluate(`window.__smoke.reset(); document.getElementById("btn-panel").click(); true;`);
  await waitFor(`window.__smoke.callsOf("lyric_panel").length === 1`, "展开面板下发 lyric_panel");
  eq("面板展开请求 open=true", (await evaluate(`window.__smoke.callsOf("lyric_panel")[0].args`)).open, true);
  eq("面板渲染出时间偏移行", await evaluate(`!!document.getElementById("off-val")`), true);
  eq("偏移初值显示「同步」", await evaluate(`document.getElementById("off-val").textContent`), "同步");
  eq("文字色板渲染 5 个色块", await evaluate(`document.querySelectorAll("#sw-text .ly-sw").length`), 5);
  eq("染色色板渲染 6 个色块", await evaluate(`document.querySelectorAll("#sw-fill .ly-sw").length`), 6);

  // 偏移 ＋ 步进：0 → +0.5 → +1
  await evaluate(`document.getElementById("off-plus").click(); true;`);
  await waitFor(`window.__smoke.callsOf("lyric_commit_display").length === 1`, "偏移＋下发 lyric_commit_display");
  eq("偏移＋半秒", (await evaluate(`window.__smoke.callsOf("lyric_commit_display")[0].args`)).offset, 0.5);
  eq("偏移值显示 +0.5s", await evaluate(`document.getElementById("off-val").textContent`), "+0.5s");
  await evaluate(`document.getElementById("off-plus").click(); document.getElementById("off-plus").click(); document.getElementById("off-plus").click(); true;`);
  await sleep(60);
  eq("偏移连续＋到 +2s", (await evaluate(`window.__smoke.callsOf("lyric_commit_display").slice(-1)[0].args`)).offset, 2);
  // 越界：+5 再点不动
  await evaluate(`window.__smoke.reset(); (() => { for (let i = 0; i < 8; i++) document.getElementById("off-plus").click(); return true; })(); true;`);
  await sleep(60);
  eq("偏移 clamp 到 +5", (await evaluate(`window.__smoke.callsOf("lyric_commit_display").slice(-1)[0].args`)).offset, 5);
  eq("偏移值显示 +5s", await evaluate(`document.getElementById("off-val").textContent`), "+5s");
  await evaluate(`window.__smoke.reset(); document.getElementById("off-minus").click(); true;`);
  await sleep(60);
  eq("偏移 − 退到 +4.5s", (await evaluate(`window.__smoke.callsOf("lyric_commit_display")[0].args`)).offset, 4.5);

  // 色板点选：点中即生效并高亮
  await evaluate(`window.__smoke.reset(); document.querySelector('#sw-fill .ly-sw[data-v="#FF6B9D"]').click(); true;`);
  await waitFor(`window.__smoke.callsOf("lyric_commit_display").length === 1`, "色板点选下发 lyric_commit_display");
  eq("点选染色色块下发", (await evaluate(`window.__smoke.callsOf("lyric_commit_display")[0].args`)).colorFill, "#FF6B9D");
  eq("被点色块高亮", await evaluate(`document.querySelector('#sw-fill .ly-sw[data-v="#FF6B9D"]').classList.contains("active")`), true);
  // 点「跟随默认」色块 → 恢复默认
  await evaluate(`window.__smoke.reset(); document.querySelector('#sw-text .ly-sw.def').click(); true;`);
  await sleep(60);
  eq("点默认色块下发空串", (await evaluate(`window.__smoke.callsOf("lyric_commit_display")[0].args`)).colorText, "");

  // Esc / 点击面板外收起 → 下发 open=false
  await evaluate(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); true;`);
  await sleep(80);
  const closeCall = await evaluate(`window.__smoke.callsOf("lyric_panel").slice(-1)[0]?.args`);
  eq("Esc 收起面板 open=false", closeCall?.open, false);

  // 工具条形态/样式按钮：点击后必须下发 lyric_commit_display（由 Rust 改窗口高度 + 持久化）
  await evaluate(`window.__smoke.fire("lyric://locked", { locked: false }); true;`);
  await sleep(60);
  // 按钮文字 = 当前生效值（此刻是 double+bold），一眼可见当前状态
  eq("形态按钮标注当前形态（双行）", await evaluate(`document.getElementById("btn-form").textContent`), "双行");
  eq("样式按钮标注当前样式（加粗）", await evaluate(`document.getElementById("btn-style").textContent`), "加粗");

  // 点形态按钮 → 下发命令 + 本地切到单行
  await evaluate(`window.__smoke.reset(); document.getElementById("btn-form").click(); true;`);
  await waitFor(`window.__smoke.callsOf("lyric_commit_display").length === 1`, "形态按钮下发 lyric_commit_display");
  const formCall = await evaluate(`window.__smoke.callsOf("lyric_commit_display")[0].args`);
  eq("形态按钮提交 form=single", formCall.form, "single");
  eq("形态已切回单行", await evaluate(`document.getElementById("bar").dataset.form`), "single");
  eq("形态按钮文字同步为单行", await evaluate(`document.getElementById("btn-form").textContent`), "单行");

  // 点样式按钮 → 循环切换（加粗 → 描边）
  await evaluate(`window.__smoke.reset(); document.getElementById("btn-style").click(); true;`);
  await waitFor(`window.__smoke.callsOf("lyric_commit_display").length === 1`, "样式按钮下发 lyric_commit_display");
  eq("样式按钮循环切换（加粗→描边）", (await evaluate(`window.__smoke.callsOf("lyric_commit_display")[0].args`)).style, "stroke");
  eq("样式按钮文字同步为描边", await evaluate(`document.getElementById("btn-style").textContent`), "描边");

  // 字号按钮同样走提交通道（保证持久化，而非只改本地）
  await evaluate(`window.__smoke.reset(); document.getElementById("btn-bigger").click(); true;`);
  await waitFor(`window.__smoke.callsOf("lyric_commit_display").length === 1`, "字号按钮下发 lyric_commit_display");
  check("字号随提交带上", typeof (await evaluate(`window.__smoke.callsOf("lyric_commit_display")[0].args`)).fontSize === "number", "fontSize 缺失");

  // ── 回到主窗口：验证关闭闸门与按钮态复位 ──
  await cdp.send("Page.navigate", { url: `${BASE}/index.html` });
  await waitFor(`document.readyState === "complete" && !!document.querySelector(".nav-item")`, "回到主窗口");
  await evaluate(`(() => { const n = [...document.querySelectorAll(".nav-item")].find(x => /在线音乐/.test(x.textContent)); n && n.click(); return true; })()`);
  await waitFor(`!!document.getElementById("mc-lyric")`, "音乐页重新渲染");
  // 重新开启再关闭，验证闸门开关
  await evaluate(`document.getElementById("mc-lyric").click(); true;`);
  await sleep(200);
  await evaluate(`window.__smoke.reset(); document.getElementById("mc-lyric").click(); true;`);
  await waitFor(`window.__smoke.callsOf("hide_lyric").length === 1`, "再次点击调用 hide_lyric");
  await evaluate(`window.__smoke.reset(); true;`);
  await seek(0, 2);
  eq("关闭后不再推送（闸门已关）", await syncCount(), 0);

  // 歌词窗口自行关闭（点它自己的 ✕）→ 主窗口按钮态应复位，否则按钮停在「已开启」
  await evaluate(`window.__smoke.fire("lyric-hidden", null); true;`);
  await sleep(100);
  eq("窗口自行关闭后按钮态复位", await evaluate(`document.getElementById("mc-lyric").classList.contains("active")`), false);

  // ── 系统设置：不应再有「桌面歌词」区段 ──
  // 配置入口已全部迁到歌词条工具条（形态/样式/字号/偏移/配色/开关），设置页只留其他系统项。
  // 反向断言防回归：将来谁往设置页加回歌词控件，这里会立刻暴露两套入口并存的分叉。
  await evaluate(`(() => { const n = [...document.querySelectorAll(".nav-item")].find(x => /系统设置/.test(x.textContent)); n && n.click(); return true; })()`);
  await waitFor(`!!document.querySelector(".sec-title")`, "设置页渲染完成");
  eq("系统设置不含「桌面歌词」文案", await evaluate(`document.body.innerHTML.includes("桌面歌词")`), false);
  const lyIdsLeft = await evaluate(`["ly-enabled", "ly-hover", "ly-autolock", "ly-size", "ly-pos-reset", "ly-form", "ly-style", "ly-offset", "ly-color-text", "ly-color-fill"].filter((id) => document.getElementById(id)).join(",")`);
  eq("无遗留歌词设置控件", lyIdsLeft, "");

  await sleep(200);
  check(
    "设置页无 JS 异常、无资源加载失败",
    problems.length === 0 && netNoise.length === 0,
    [...problems, ...netNoise.map((t) => "资源加载：" + t)].join(" | ")
  );

  await sleep(300);
  check(
    "设置页桌面歌词入口迁移后无 JS 异常、无资源加载失败",
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
