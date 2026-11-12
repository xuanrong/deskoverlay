// 校验：所有弹窗容器都必须有确定 height（不能只有 max-height / 内容驱动）。
// 从 JS 抽出 .task-modal 后跟随的弹窗类名，再到 CSS 里查是否命中 height。
// 从项目根目录跑：node tools/_modal-height-check.mjs
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const cssPath = join(root, "frontend/web/css/style.css");
const css = readFileSync(cssPath, "utf8");

// 1) 从 JS 里抓所有 `<div class="task-modal ...">` 的弹窗类组合
const jsFiles = [
  "frontend/web/js/app.js",
  "frontend/web/js/reminders.js",
  "frontend/web/js/views/dashboard.js",
  "frontend/web/js/views/common.js",
  "frontend/web/js/views/fund.js",
  "frontend/web/js/views/ideabox.js",
  "frontend/web/js/views/music.js",
  "frontend/web/js/views/quickaccess.js",
  "frontend/web/js/views/scheduler.js",
];
const modalClasses = new Set(); // 每个弹窗的「类名数组」序列化 key
for (const f of jsFiles) {
  const p = join(root, f);
  if (!existsSync(p)) continue;
  const src = readFileSync(p, "utf8");
  // 匹配 class="task-modal xxx" 或 class="task-modal"（含模板字符串里的）
  for (const m of src.matchAll(/class="task-modal([^"]*)"/g)) {
    const extra = m[1].trim().split(/\s+/).filter(Boolean);
    modalClasses.add(JSON.stringify(extra));
  }
}

// 2) 对每个弹窗，判定 CSS 是否给了确定 height
function hasDefiniteHeight(classList) {
  // 逐级尝试：完整组合 → 去掉 task-modal → 单类，任一命中 height 即算定高
  const candidates = [];
  if (classList.length) candidates.push(classList.join(" "));
  candidates.push("task-modal");
  for (const c of classList) candidates.push(c);
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const cls of candidates) {
    // 选择器里的类名用字面量 \.cls（点号转义），避免 . 被当通配符误匹配别的类
    const sel = cls.split(/\s+/).map((c) => `\\.${esc(c)}`).join("");
    const re = new RegExp(`(^|[\\s,>])(${sel})(?![\\w-])[^{}]*\\{([^}]*)\\}`, "g");
    for (const m of css.matchAll(re)) {
      const body = m[3];
      const h = body.match(/(^|[^-])height\s*:\s*([^;]+);/);
      if (h && !/^\s*(auto|none|max-content|min-content)/.test(h[2])) {
        return { ok: true, via: cls, h: h[2].trim() };
      }
    }
  }
  return { ok: false };
}

let fail = 0;
console.log("弹窗容器定高校验\n" + "=".repeat(56));
for (const key of [...modalClasses].sort()) {
  const classList = JSON.parse(key);
  const label = ["task-modal", ...classList].join(".");
  const r = hasDefiniteHeight(classList);
  if (r.ok) {
    console.log(`  OK   ${label.padEnd(42)} height=${r.h}`);
  } else {
    console.log(`  ✗    ${label.padEnd(42)} 无确定 height（内容驱动/max-height）`);
    fail++;
  }
}
console.log("=".repeat(56));
console.log(fail === 0 ? "✓ 全部弹窗定高" : `✗ ${fail} 个弹窗未定高`);
process.exit(fail === 0 ? 0 : 1);
