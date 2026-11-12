// 弹窗定高 DOM 实测：起 headless Chrome + 静态服务（复用 smoke.mjs 的启动方式），
// 为每个弹窗建真实 DOM，读 getComputedStyle().height —— CSS 层叠/特异性/继承由浏览器算好，
// 比 grep CSS 文本可靠。断言：每个弹窗都有确定 height（非 auto、非被 max-height 钳制）。
// 从项目根目录跑：node tools/_modal-height-probe.mjs
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WEB = path.join(ROOT, "frontend", "web");
const CHROME = process.env.CHROME || [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
].find((p) => fs.existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 从 JS 源码抓所有 task-modal 弹窗类组合（与 _modal-height-check.mjs 同源）──
const jsFiles = [
  "frontend/web/js/app.js", "frontend/web/js/reminders.js",
  "frontend/web/js/views/dashboard.js", "frontend/web/js/views/common.js",
  "frontend/web/js/views/fund.js", "frontend/web/js/views/ideabox.js",
  "frontend/web/js/views/music.js", "frontend/web/js/views/quickaccess.js",
  "frontend/web/js/views/scheduler.js",
];
const combos = new Set();
for (const f of jsFiles) {
  const src = fs.readFileSync(path.join(ROOT, f), "utf8");
  for (const m of src.matchAll(/class="task-modal([^"]*)"/g)) {
    combos.add(JSON.stringify(m[1].trim().split(/\s+/).filter(Boolean)));
  }
}

// ── 静态服务（同 smoke.mjs）──
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
const server = http.createServer((req, res) => {
  const p = decodeURIComponent((req.url || "/").split("?")[0]);
  if (p === "/favicon.ico") { res.writeHead(200, { "Content-Type": "image/x-icon" }); res.end(); return; }
  const fp = path.join(WEB, p === "/" ? "index.html" : p);
  if (!fp.startsWith(WEB)) { res.writeHead(403); res.end("403"); return; }
  fs.readFile(fp, (err, buf) => {
    if (err) { res.writeHead(404); res.end("404"); return; }
    res.writeHead(200, { "Content-Type": MIME[path.extname(fp)] || "application/octet-stream" });
    res.end(buf);
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;

// ── 启动 Chrome ──
if (!CHROME) { console.error("找不到 Chrome，用 CHROME=<路径> 指定"); process.exit(1); }
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "deskoverlay-modalprobe-"));
const chrome = spawn(CHROME, [
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  "--disable-extensions", "--remote-debugging-port=0", `--user-data-dir=${profile}`,
  "--window-size=1600,900", "about:blank",
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
  if (fs.existsSync(portFile)) { devPort = fs.readFileSync(portFile, "utf8").split(/\r?\n/)[0].trim(); break; }
  await sleep(100);
}
if (!devPort) { console.error("Chrome 未就绪"); cleanup(1); }
let wsUrl = null;
for (let i = 0; i < 50 && !wsUrl; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${devPort}/json/list`)).json();
    wsUrl = list.find((t) => t.type === "page")?.webSocketDebuggerUrl || null;
  } catch {}
  if (!wsUrl) await sleep(100);
}
if (!wsUrl) { console.error("未找到页面调试目标"); cleanup(1); }

const ws = new WebSocket(wsUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve);
  ws.addEventListener("error", reject);
});
// 极简 CDP 客户端（照搬 smoke.mjs）
class CDP {
  constructor(ws) {
    this.ws = ws; this.seq = 0; this.pending = new Map(); this.handlers = new Map();
    ws.addEventListener("message", (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id) {
        const p = this.pending.get(m.id); if (!p) return;
        this.pending.delete(m.id);
        m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
      } else if (m.method) (this.handlers.get(m.method) || []).forEach((f) => f(m.params));
    });
  }
  send(method, params = {}) {
    const id = ++this.seq; this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
}
const cdp = new CDP(ws);
await cdp.send("Page.enable");
await cdp.send("Runtime.enable");
await cdp.send("Page.navigate", { url: `${BASE}/index.html` });
await sleep(1200);
async function evaluate(expression) {
  const r = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}

// 弹窗清单 → 浏览器里建 DOM 读 computed height
const list = [...combos].map((k) => JSON.parse(k));
const payload = JSON.stringify(list);
const results = await evaluate(`(()=>{
  const list=${payload}; const out=[];
  for(const extra of list){
    document.querySelectorAll('.probe-ov').forEach(n=>n.remove());
    const ov=document.createElement('div'); ov.className='task-modal-overlay probe-ov';
    const m=document.createElement('div'); m.className=('task-modal '+extra.join(' ')).trim();
    m.innerHTML='<h3>probe</h3><p class="cm-message">probe body</p><div class="tm-actions"><button>x</button></div>';
    ov.appendChild(m); document.body.appendChild(ov);
    const cs=getComputedStyle(m);
    out.push({cls:('task-modal '+extra.join(' ')).trim(), h:cs.height, maxH:cs.maxHeight, over:cs.overflowY});
  }
  document.querySelectorAll('.probe-ov').forEach(n=>n.remove());
  return out;
})()`);

console.log("弹窗定高 DOM 实测（真实生效值）\n" + "=".repeat(64));
let fail = 0;
for (const r of results) {
  const px = parseFloat(r.h);
  // 钳制判定：height 是确定像素值，且 max-height 不会把它压得更小
  const maxPx = parseFloat(r.maxH);
  const clamped = r.maxH !== "none" && !isNaN(maxPx) && maxPx < px;
  const ok = px > 0 && r.h !== "auto" && !clamped;
  if (!ok) fail++;
  console.log(`  ${ok ? "OK " : "✗  "} ${r.cls.padEnd(42)} height=${String(r.h).padEnd(13)} maxH=${r.maxH}${clamped ? "  ← 被钳制" : ""}`);
}
console.log("=".repeat(64));
console.log(fail === 0 ? "✓ 全部弹窗真实定高，无 max-height 钳制" : `✗ ${fail} 个异常`);
cleanup(fail === 0 ? 0 : 1);
