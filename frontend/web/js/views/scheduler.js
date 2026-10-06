// 定时任务 — 面板式调度管理（任务列表 / 可视化编辑器 / 实时日志 / 运行历史 / 系统计划任务导出）。
//
// ## 数据流（两端各管一段，避免双份真相）
//   任务定义：前端唯一写者 → state.scheduler.tasks → saveState() 落 state.json
//             → Rust 调度线程每 20s 读该文件判定到期 → 执行 → emit 事件回推输出
//   运行历史：Rust 独占写 scheduler-store.json，前端只经命令读取。
//     （历史含完整输出、体量大；若塞进 state.json，前端每次保存都要搬运全部日志。）
//   由此：编辑任务无需通知后端，保存即生效；但历史必须靠命令查，不能从 state 里读。
//
// ## 两个调度引擎互不干扰
//   - 「面板内调度」= Rust 后台线程触发，要求 app 在运行，**有实时输出与历史**。
//   - 「系统计划任务」= schtasks 触发，app 关着也跑，但**不经过本进程**，
//     所以实时流拿不到，只能读包装脚本落盘的日志文件（见「日志 → 系统计划任务」）。
//   同一任务同时开两者 = 同一时刻触发两次，UI 在编辑器中明确提示。
import { invoke, Bus } from "../bus.js";
import { state, saveState } from "../state.js";
import { esc, uid } from "../utils.js";
import { showDialog } from "./common.js";
import { toast } from "../toast.js";
import { ICON_TRASH } from "../icons.js";

const ID = "scheduler";
const WEEK_LABEL = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/// 运行状态 → 展示文案与徽标色
const STATUS_META = {
  success: { text: "成功", cls: "badge-green" },
  failed: { text: "失败", cls: "badge-danger" },
  timeout: { text: "超时", cls: "badge-amber" },
  canceled: { text: "已停止", cls: "badge-neutral" },
};

function relTime(ms) {
  if (!ms) return "—";
  const d = Date.now() - ms;
  if (d < 0) return fmtClock(ms);
  if (d < 60_000) return "刚刚";
  if (d < 3600_000) return `${Math.floor(d / 60_000)} 分钟前`;
  if (d < 86400_000) return `${Math.floor(d / 3600_000)} 小时前`;
  return `${Math.floor(d / 86400_000)} 天前`;
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

/// 绝对时刻：今天只显示 HH:MM，其它日期带月日
function fmtClock(ms) {
  if (!ms) return "—";
  const d = new Date(ms);
  const now = new Date();
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  return sameDay ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

function fmtDuration(ms) {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  return `${m}m${Math.round((ms % 60_000) / 1000)}s`;
}

// ============================ cron ⇄ 人话 / 表单 ============================
//
// 本模块对外的表达式统一是 **Unix 5 段**：分 时 日 月 周（例：0 10 * * * = 每天 10:00）。
// 星期按 Unix 口径 0=周日…6=周六（7 也作周日）。语义校验一律交给后端
// scheduler_check_cron（与调度器同一套实现），前端只负责「翻译成人话」。

/// cron → 人话。无法归纳成常见形态时回落到原表达式（不自作聪明换一个近似说法）。
export function describeCron(cron) {
  const f = String(cron || "").trim().split(/\s+/);
  // 6/7 段是「秒 分 时 日 月 周 [年]」的秒级原生语法，单独描述
  if (f.length === 6 || f.length === 7) {
    const base = describeCron(f.slice(1, 6).join(" "));
    return f[0] === "0" ? base : `每 ${f[0]} 秒（${base}）`;
  }
  if (f.length !== 5) return cron ? `${cron}（格式不完整）` : "未设置";
  const [mi, h, dom, mon, dow] = f;
  if (mi.startsWith("*/") && h === "*" && dom === "*" && mon === "*" && dow === "*") {
    return `每 ${mi.slice(2)} 分钟`;
  }
  if (h.startsWith("*/") && dom === "*" && mon === "*" && dow === "*") {
    return `每 ${h.slice(2)} 小时（第 ${mi} 分）`;
  }
  const isNum = (s) => /^\d+$/.test(s);
  if (isNum(mi) && isNum(h)) {
    const t = `${pad2(+h)}:${pad2(+mi)}`;
    if (dom === "*" && mon === "*" && dow === "*") return `每天 ${t}`;
    if (isNum(dom) && mon === "*" && dow === "*") return `每月 ${+dom} 日 ${t}`;
    if (dom === "*" && mon === "*" && dow !== "*") {
      const days = dow.split(",").map((d) => {
        if (d.includes("-")) {
          const [a, b] = d.split("-").map(Number);
          return `${a}–${b}`;
        }
        return WEEK_LABEL[Number(d) % 7] || d;
      });
      return `每周 ${days.join("、")} ${t}`;
    }
  }
  return cron;
}

/// cron → 可视化表单模型
function cronToForm(cron) {
  const f = String(cron || "").trim().split(/\s+/);
  const base = { mode: "daily", hh: 10, mm: 0, days: [1], dom: 1, n: 30, raw: String(cron || "0 10 * * *") };
  if (f.length !== 5) return { ...base, mode: "custom" };
  const [mi, h, dom, mon, dow] = f;
  if (mi.startsWith("*/") && h === "*" && dom === "*" && dow === "*") {
    return { ...base, mode: "minutes", n: Number(mi.slice(2)) || 30 };
  }
  if (h.startsWith("*/") && dom === "*" && dow === "*") {
    return { ...base, mode: "hours", n: Number(h.slice(2)) || 1, mm: Number(mi) || 0 };
  }
  if (/^\d+$/.test(mi) && /^\d+$/.test(h)) {
    const common = { ...base, hh: Number(h), mm: Number(mi) };
    if (dom === "*" && mon === "*" && dow === "*") return { ...common, mode: "daily" };
    if (/^\d+$/.test(dom) && mon === "*" && dow === "*") return { ...common, mode: "monthly", dom: Number(dom) };
    if (dom === "*" && mon === "*" && dow !== "*" && dow.split(",").every((x) => /^\d+$/.test(x))) {
      return { ...common, mode: "weekly", days: dow.split(",").map(Number) };
    }
  }
  return { ...base, mode: "custom" };
}

/// 表单模型 → cron
function formToCron(f) {
  const mi = Math.max(0, Math.min(59, Math.round(f.mm || 0)));
  const h = Math.max(0, Math.min(23, Math.round(f.hh || 0)));
  switch (f.mode) {
    case "minutes":
      return `*/${Math.max(1, Math.min(59, Math.round(f.n || 30)))} * * * *`;
    case "hours":
      return `${mi} */${Math.max(1, Math.min(23, Math.round(f.n || 1)))} * * *`;
    case "weekly": {
      const days = (f.days && f.days.length ? f.days : [1]).slice().sort((a, b) => a - b).join(",");
      return `${mi} ${h} * * ${days}`;
    }
    case "monthly":
      return `${mi} ${h} ${Math.max(1, Math.min(31, Math.round(f.dom || 1)))} * *`;
    case "custom":
      return String(f.raw || "").trim();
    default:
      return `${mi} ${h} * * *`;
  }
}

// ============================ 任务行渲染（纯函数，便于离线核对） ============================

/// 渲染一行任务。ctx = { running, lastRun, liveText, nextAt, exported, monthHeat }
/// 抽成模块级纯函数而非留在 renderScheduler 闭包里：这样能脱离 DOM 直接喂数据出标记，
/// 用真实 CSS 截图核对样式（本模块视觉元素多，光看代码判断不出好不好看）。
///
/// 右侧列（.sch-side）是**纵向叠加**：按钮行在上面、当月热力图在下面，正好用掉原本空着的那块。
export function taskRowHtml(t, ctx) {
  const c = ctx || {};
  const st = c.lastRun ? STATUS_META[c.lastRun.status] || STATUS_META.failed : null;

  // 触发来源：把「面板内调度」与「系统计划任务」两个引擎的状态摆在一起。
  // 双引擎方案里最容易踩的坑就是分不清某个任务到底由谁触发，这里必须显式呈现。
  const triggers = [
    `<span class="sch-chip${t.scheduleEnabled ? " on" : ""}">面板内调度 ${t.scheduleEnabled ? "开" : "关"}</span>`,
    `<span class="sch-chip${c.exported ? " on" : ""}">系统计划任务 ${c.exported ? "已注册" : "未注册"}</span>`,
  ].join("");

  return `
    <div class="sch-row${t.enabled ? "" : " off"}" data-id="${esc(t.id)}">
      <div class="sch-row-main">
        <div class="sch-name">
          <span class="sch-dot${t.enabled ? " on" : ""}"></span>
          <span class="sch-title-t">${esc(t.name)}</span>
          ${st ? `<span class="badge ${st.cls}">上次${st.text}</span>` : `<span class="badge badge-neutral">未运行</span>`}
        </div>
        <div class="sch-meta">
          ${esc(describeCron(t.cron))}
          <code class="sch-cron">${esc(t.cron || "—")}</code>
          ${t.kind === "http" ? `<span class="sch-kind">HTTP ${esc(t.method || "GET")}</span>` : `<span class="sch-kind">命令</span>`}
        </div>
        <div class="sch-meta2">
          ${monthSummaryHtml(c.monthHeat)}
          ${triggers}
          ${c.lastRun ? `<span>上次 <span data-rel="${c.lastRun.startedAt}">${relTime(c.lastRun.startedAt)}</span> · ${fmtDuration(c.lastRun.durationMs)}${c.lastRun.trigger === "catchup" ? " · 补跑" : ""}</span>` : ""}
          ${c.nextAt && t.enabled && t.scheduleEnabled ? `<span>下次 <span data-next="${c.nextAt}">${fmtClock(c.nextAt)}</span></span>` : ""}
        </div>
        ${t.note ? `<div class="sch-note">${esc(t.note)}</div>` : ""}
        ${c.running || c.liveText ? `<pre class="sch-live" data-live="${esc(t.id)}">${esc(c.liveText || "")}</pre>` : ""}
      </div>
      <div class="sch-side">
        <div class="sch-actions dense">
          ${c.running
            ? `<button class="btn-danger btn-xs" data-act="stop" data-run="${esc(c.running.runId)}">停止</button>`
            : `<button class="btn-ghost btn-xs" data-act="run">运行</button>`}
          <button class="btn-ghost btn-xs" data-act="logs">日志</button>
          <button class="btn-ghost btn-xs" data-act="edit">编辑</button>
          <button class="btn-icon" data-act="toggle" title="${t.enabled ? "停用" : "启用"}">${t.enabled ? "●" : "○"}</button>
          <button class="btn-icon" data-act="del" title="删除">${ICON_TRASH}</button>
        </div>
        ${monthHeatHtml(c.monthHeat, c.exported)}
      </div>
    </div>`;
}

// ============================ 当月热力图（纯函数，便于离线断言） ============================
//
// 数据来自后端 `scheduler_heat`：daily[taskId]["YYYY-MM-DD"] = { ok, bad, warn, stop }。
// 这份聚合与 runs 的 MAX_RUNS=300 截断**完全解耦** —— 若直接从运行历史推，
// 月初的记录会被后来的运行挤掉，热力图就会把「记录被裁」画成「没跑过」，
// 等于把残缺数据当完整数据展示（正确性问题，不是美观问题）。

export const HEAT_COLS = 7;                       // 每行 = 一周（列 1 = 周日）；行数按当月自适应，多为 5 行
const HEAT_WD = ["日", "一", "二", "三", "四", "五", "六"];   // 下标就是 Date#getDay()，别再自己推星期
/// 这四种「当天有记录」的态走状态色阶；其余态（未到 / 今天未到点 / 漏跑 / 无数据 / 停用）各有自己的类名
const HEAT_WORST = { ok: 1, bad: 1, warn: 1, stop: 1 };

/// 本地日期 YYYY-MM-DD。
/// ⚠ 不能用 `toISOString().slice(0,10)`：那是 UTC，东八区 00:00–07:59 会落到**前一天**。
export function todayKey(d) {
  const x = d instanceof Date ? d : new Date();
  return `${x.getFullYear()}-${pad2(x.getMonth() + 1)}-${pad2(x.getDate())}`;
}

/// 一天里跑过多次时取**最差**的那次作为代表色：失败 > 超时 > 已停止 > 成功。
/// 反之（取最好）会把「早上成功、晚上失败」画成绿色，正好掩盖最该看的那次。
export function heatWorstOf(agg) {
  if (!agg) return null;
  const n = (k) => Number(agg[k]) || 0;
  if (n("bad") > 0) return "bad";
  if (n("warn") > 0) return "warn";
  if (n("stop") > 0) return "stop";
  if (n("ok") > 0) return "ok";
  return null;
}

/// cron 单字段 → 允许值集合。`*` → null（任意）；写法看不懂 → undefined（放弃判定）。
/// 支持 `*` / `a` / `a-b` / `*/n` / `a-b/n` / 逗号列表 —— 恰好覆盖编辑器能产出的全部形态。
function cronFieldSet(expr, min, max) {
  const s = String(expr == null ? "" : expr).trim();
  if (!s) return undefined;
  if (s === "*") return null;
  const out = new Set();
  for (const part of s.split(",")) {
    const [range, stepTxt] = part.split("/");
    const step = stepTxt === undefined ? 1 : Number(stepTxt);
    if (!isFinite(step) || step < 1) return undefined;
    let a, b;
    if (range === "*") { a = min; b = max; }
    else if (range.includes("-")) {
      const [x, y] = range.split("-").map(Number);
      if (!isFinite(x) || !isFinite(y)) return undefined;
      a = x; b = y;
    } else {
      a = b = Number(range);
      if (!isFinite(a)) return undefined;
    }
    if (a < min || b > max || a > b) return undefined;
    for (let v = a; v <= b; v += step) out.add(v);
  }
  return out;
}

/// 该 cron 在指定日期**是否应触发**。true / false / **null（判不了）**。
///
/// 为什么要写这个：设计初稿说「用后端 nextDue 就能区分未到与漏跑」，那只对**每天**跑的任务成立。
/// 每周一跑的任务在周二会被误判成「今天该触发却没过」，于是整周飘红 —— 假警报比漏报更伤可信度。
/// 判不了（表达式不完整 / 字段爆界）一律返回 null，调用方按「不判」处理，绝不按「该跑」处理。
export function cronHitsDay(cron, y, m, d) {
  let f = String(cron || "").trim().split(/\s+/);
  if (f.length === 6 || f.length === 7) f = f.slice(1);   // 秒级语法：丢掉秒段
  if (f.length !== 5) return null;
  const mi = cronFieldSet(f[0], 0, 59);
  const hh = cronFieldSet(f[1], 0, 23);
  const dom = cronFieldSet(f[2], 1, 31);
  const mon = cronFieldSet(f[3], 1, 12);
  const dow = cronFieldSet(f[4], 0, 7);                   // Unix：0=周日…6=周六，7 也作周日
  if ([mi, hh, dom, mon, dow].some((x) => x === undefined)) return null;
  if (mon && !mon.has(m)) return false;
  const domHit = dom ? dom.has(d) : true;
  const dw = new Date(y, m - 1, d).getDay();
  const dowHit = dow ? (dow.has(dw) || (dw === 0 && dow.has(7))) : true;
  // 日与周**同时**被限定时按 Vixie cron 的 OR 语义；只限了一个就按那一个
  if (dom && dow) return domHit || dowHit;
  if (dom) return domHit;
  if (dow) return dowHit;
  return true;
}

/// "YYYY-MM-DD" → 在该月内的日号；早于该月 → 1；晚于该月或缺字段 → 0（无依据）
function dayOfMonthIn(ymd, y, m) {
  const s = String(ymd || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return 0;
  const [yy, mm, dd] = s.split("-").map(Number);
  if (yy < y || (yy === y && mm < m)) return 1;
  if (yy === y && mm === m) return dd;
  return 0;
}

/// 任务「从哪一天开始存在」—— 用来区分「那会儿还没这任务」与「该跑没跑」。
/// 优先用任务上的 `since`（新建时写入）；老数据没有该字段，回落到最早的聚合记录。
/// 两条都没有 → 0，表示**没有依据**：整月按「无数据」画，而不是一律判漏跑（否则新任务会满屏红）。
export function heatFromDay(t, daily, y, m) {
  const s = dayOfMonthIn(t && t.since, y, m);
  if (s > 0) return s;
  const keys = Object.keys(daily || {}).sort();
  if (keys.length) {
    const e = dayOfMonthIn(keys[0], y, m);
    if (e > 0) return e;
  }
  return 0;
}

/// 当月热力图模型。
///   t     = 任务定义（只读 enabled / scheduleEnabled / cron / since）
///   daily = 该任务的 { "YYYY-MM-DD": { ok, bad, warn, stop } }
///   ctx   = { y, m, today, now, nextDue, cols }
/// 返回 { y, m, cols, rows, lead, cellCount, cells, ok, failed, miss, hasData, from, judging }，cells 项含 cls/tip/kind。
export function monthHeatModel(t, daily, ctx) {
  const c = ctx || {};
  const y = Number(c.y);
  const m = Number(c.m);
  const cols = Number(c.cols) || HEAT_COLS;
  const daysIn = new Date(y, m, 0).getDate();
  const today = Number(c.today) > 0 && Number(c.today) <= daysIn ? Number(c.today) : 0;
  const now = Number(c.now) || 0;
  const due = Number(c.nextDue) || 0;
  const map = daily && typeof daily === "object" ? daily : {};
  const from = heatFromDay(t, map, y, m);
  // 停用 / 关了面板内调度 / 没写 cron → 本就无从判断「那天该不该跑」，一律不判漏跑
  const judging = t.enabled !== false && t.scheduleEnabled !== false && !!String(t.cron || "").trim();
  // 「今天这次还没到」：nextDue 必须**落在今天之内**且还没到。
  // 只看 `due > now` 是错的 —— 今天 20:00 该跑、现在 21:00 时 nextDue 是**明天** 20:00，
  // 那也是 > now，会把「今天漏跑」说成「未到」。
  const dueD = due > 0 ? new Date(due) : null;
  const dueToday = !!dueD && today > 0 && dueD.getFullYear() === y && dueD.getMonth() + 1 === m && dueD.getDate() === today;

  // 以**周日**为起点补前导空位（中国日历习惯）：前导空位数就是当月首日的 `getDay()`，
  // 补完后每 7 格一轮 ⇒ **列即星期**（列 1 = 周日、列 7 = 周六），且 `idx % 7 === 真实 getDay()`。
  // 行数不是常数：31 天 + 最多 6 个空位 = 37 ⇒ 最长需要 6 行（如 2026-08 首日周六），其余多为 5 行。
  const lead = new Date(y, m - 1, 1).getDay();
  const raw = [];
  for (let i = 0; i < lead; i++) raw.push({ pad: true });
  for (let d = 1; d <= daysIn; d++) raw.push({ d });
  while (raw.length % cols) raw.push({ pad: true });

  let ok = 0, failed = 0, miss = 0, hasData = false;
  const cells = raw.map((cell) => {
    if (cell.pad) return { pad: true, kind: "pad", cls: "shc pad", tip: "" };
    const d = cell.d;
    const isToday = d === today;
    const key = `${y}-${pad2(m)}-${pad2(d)}`;
    const agg = map[key];
    // 星期直接取真实 `getDay()`：不要再从 lead 推、更不要写成 `(d + 2) % 7` 那种
    // 只在某一个月碰巧成立的式子（2026 年 12 个月里有 10 个月会错）。
    const dateTip = `${key} 周${HEAT_WD[new Date(y, m - 1, d).getDay()]}`;
    const worst = heatWorstOf(agg);
    let kind, tip;
    if (worst) {
      hasData = true;
      kind = worst;
      const n = (k) => Number(agg[k]) || 0;
      const parts = [];
      if (n("ok")) parts.push(`成功 ×${n("ok")}`);
      if (n("bad")) parts.push(`失败 ×${n("bad")}`);
      if (n("warn")) parts.push(`超时 ×${n("warn")}`);
      if (n("stop")) parts.push(`已停止 ×${n("stop")}`);
      tip = `${dateTip} · ${parts.join("，")}`;
      if (worst === "ok") ok++; else failed++;
    } else if (today > 0 && d > today) {
      kind = "future";
      tip = `${dateTip} · 未到`;
    } else if (from === 0 || d < from) {
      // 画成「未运行」会把「我们不知道」说成「它没跑」—— 必须留白
      kind = "nodata";
      tip = `${dateTip} · 无数据（该任务那时还不存在，或早于最早记录）`;
    } else {
      const hit = judging ? cronHitsDay(t.cron, y, m, d) : null;
      if (!judging) {
        kind = "off";
        tip = `${dateTip} · 未运行（任务已停用或未参与面板内调度，不计漏跑）`;
      } else if (hit !== true) {
        kind = "off";
        tip = hit === false
          ? `${dateTip} · 未运行（该日不满足 ${t.cron}）`
          : `${dateTip} · 未运行（无法判定该日是否应触发）`;
      } else if (isToday && (due === 0 || (dueToday && due > now))) {
        // 只有「下一次触发就落在今天之内、且还没到」才算未到。
        // 拿不到 nextDue（due === 0）时也给「未到」而不是「漏跑」—— 不冤枉人。
        kind = "pending";
        tip = `${dateTip} · 今天的触发时刻还没到`;
      } else {
        kind = "missed";
        miss++;
        tip = `${dateTip} · 漏跑：应触发但无记录`;
      }
    }
    // 名字不能叫 today —— 外层还在用它判断 d > today，同名会踩 TDZ
    const ring = isToday ? " today" : "";
    // 四种「有记录」态 → .x-*；其余态直接沿用 kind 作类名（future / pending / missed / nodata / off）
    const cls = HEAT_WORST[kind] ? `shc x-${kind}${ring}` : `shc ${kind}${ring}`;
    return { d, kind, cls, tip, isToday };
  });

  return { y, m, cols, rows: cells.length / cols, lead, cellCount: cells.length, cells, ok, failed, miss, hasData, from, judging };
}

/// 星期表头（整个列表只画一次，放在 .sch-list 顶部 —— 每行都画等于白送 13px 行高）。
/// 标签下标 == `getDay()`，所以第 1 格就是「日」。
export function heatHeadHtml(cols) {
  const n = Number(cols) || HEAT_COLS;
  const labels = Array.from({ length: n }, (_, i) => `<span>${HEAT_WD[i % 7]}</span>`).join("");
  return `<div class="sch-colhead"><div class="shg-head">${labels}</div></div>`;
}

/// 热力块。没有记录时降级为文案 —— 一片空网格看起来像「数据丢了」，说不清是什么状态。
export function monthHeatHtml(model, exported) {
  if (!model || !model.hasData) {
    const txt = exported ? "由系统计划任务触发<br>不经本进程，无记录" : "还没有运行记录";
    return `<div class="sch-heat"><div class="sch-heat-none">${txt}</div></div>`;
  }
  const grid = model.cells
    .map((c) => `<i class="${c.cls}"${c.tip ? ` title="${esc(c.tip)}"` : ""}></i>`)
    .join("");
  return `<div class="sch-heat"><div class="shg">${grid}</div></div>`;
}

/// 行内摘要（成功 / 失败 / 漏跑）。放在信息行里、不占块高。
export function monthSummaryHtml(model) {
  if (!model || !model.hasData) return "";
  return `<span class="sch-month"><b>${model.m}月</b>`
    + `<span class="m-ok">成功${model.ok}</span>`
    + (model.failed ? `<span class="m-bad">失败${model.failed}</span>` : "")
    + (model.miss ? `<span class="m-miss">漏跑${model.miss}</span>` : "")
    + `</span>`;
}

// ============================ 视图 ============================

export function renderScheduler(view) {
  view.header.style.display = "none";
  const el = view.body;
  const s = state.scheduler;

  // 内存态（不需持久化）：正在跑的运行、实时输出、系统计划任务注册状态、历史缓存
  const live = new Map(); // taskId -> { runId, text }
  let exportState = {}; // taskId -> bool
  let status = { running: [], maxConcurrent: s.maxConcurrent, catchUp: s.catchUp, nextDue: {} };
  let runsCache = []; // 运行历史（后端事实，按需查询）
  let heatCache = {}; // taskId -> { "YYYY-MM-DD": { ok, bad, warn, stop } }（后端按天聚合，与 runs 截断解耦）

  el.innerHTML = `
    <div class="sch-wrap">
      <div class="card-head">
        <div class="card-title">定时任务</div>
        <span class="ai-tools">
          <button class="btn-ghost" id="sch-cfg">调度设置</button>
          <button class="btn-primary" id="sch-new">新建任务</button>
        </span>
      </div>
      <div class="sch-sum" id="sch-sum"></div>
      <div class="sch-list" id="sch-list"></div>
    </div>`;

  const sumEl = el.querySelector("#sch-sum");
  const listEl = el.querySelector("#sch-list");

  // ---------- 汇总行 ----------
  function paintSummary() {
    const tasks = s.tasks || [];
    const scheduled = tasks.filter((t) => t.enabled && t.scheduleEnabled && t.cron).length;
    const running = status.running?.length || 0;
    // 取「面板内调度」下最早的一次触发时刻作为整体下次触发的参考
    const due = tasks
      .filter((t) => t.enabled && t.scheduleEnabled && t.cron)
      .map((t) => status.nextDue?.[t.id] || 0)
      .filter((x) => x > 0)
      .sort((a, b) => a - b);
    let nextTxt;
    if (!scheduled) nextTxt = "无任务参与面板内调度";
    else if (!due.length) nextTxt = "等待后端登记下次触发时刻";
    else nextTxt = `下次触发 ${fmtClock(due[0])}`;
    sumEl.innerHTML = [
      `<span>面板内调度 <b>${scheduled}</b> 个</span>`,
      `<span>运行中 <b>${running}</b>/${s.maxConcurrent}</span>`,
      `<span>${esc(nextTxt)}</span>`,
      `<span>启动补跑 <b>${s.catchUp ? "开" : "关"}</b></span>`,
    ].join('<i class="sch-sep"></i>');
  }

  // ---------- 任务列表 ----------
  function paintList() {
    const tasks = s.tasks || [];
    if (!tasks.length) {
      listEl.innerHTML = `<div class="empty-state">还没有任务。点右上角「新建任务」添加</div>`;
      return;
    }
    // 星期表头整个列表只画一次（每行都画等于白送 13px 行高），右缘与行内热力图对齐
    listEl.innerHTML = heatHeadHtml(HEAT_COLS) + tasks.map(rowHtml).join("");
    bindRowEvents();
  }

  function rowHtml(t) {
    // 每次重绘重新取「今天」：跨零点后重绘能立刻切到新的一天，不靠模块重载
    const n = new Date();
    return taskRowHtml(t, {
      running: (status.running || []).find((r) => r.taskId === t.id),
      lastRun: lastRunOf(t.id),
      liveText: live.get(t.id)?.text || "",
      nextAt: status.nextDue?.[t.id] || 0,
      exported: !!exportState[t.id],
      monthHeat: monthHeatModel(t, heatCache[t.id], {
        y: n.getFullYear(),
        m: n.getMonth() + 1,
        today: n.getDate(),
        now: n.getTime(),
        nextDue: status.nextDue?.[t.id] || 0,
        cols: HEAT_COLS,
      }),
    });
  }

  // 运行历史按任务缓存，避免每次渲染都查一遍
  function lastRunOf(taskId) {
    return runsCache.find((r) => r.taskId === taskId) || null;
  }

  function bindRowEvents() {
    listEl.querySelectorAll(".sch-row").forEach((row) => {
      const id = row.dataset.id;
      row.querySelectorAll("[data-act]").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          const act = btn.dataset.act;
          const t = (s.tasks || []).find((x) => x.id === id);
          if (!t) return;
          if (act === "run") return doRun(t);
          if (act === "stop") return doStop(btn.dataset.run);
          if (act === "logs") return openLogs(t);
          if (act === "edit") return openEditor(t);
          if (act === "toggle") return toggleTask(t, !t.enabled);
          if (act === "del") return removeTask(t);
        });
      });
    });
  }

  // ---------- 数据刷新 ----------
  async function loadRuns() {
    const r = await invoke("scheduler_runs", { limit: 50 });
    runsCache = Array.isArray(r) ? r : [];
  }

  /// 当月热力图的按天聚合。**不带 output** —— 走 scheduler_runs(limit:300) 的话
  /// 等于把 300 × 最长 60KB 的日志灌进 IPC，只为读出「哪天跑了几次」。
  async function loadHeat() {
    const h = await invoke("scheduler_heat");
    heatCache = h && typeof h === "object" && !Array.isArray(h) ? h : {};
  }

  async function loadStatus() {
    const st = await invoke("scheduler_status", {});
    status = st && typeof st === "object" ? st : { running: [], maxConcurrent: s.maxConcurrent, catchUp: s.catchUp, nextDue: {} };
    // 后端在跑但前端没收到 started 事件（例如切模块时开始的）→ 补上实时区
    for (const r of status.running || []) {
      if (!live.has(r.taskId)) live.set(r.taskId, { runId: r.runId, text: "" });
    }
  }

  async function loadExportState() {
    const ids = (s.tasks || []).map((t) => t.id);
    if (!ids.length) { exportState = {}; return; }
    const m = await invoke("scheduler_export_status", { taskIds: ids });
    exportState = m && typeof m === "object" ? m : {};
  }

  async function refresh() {
    await Promise.all([loadRuns(), loadHeat(), loadStatus()]);
    paintSummary();
    paintList();
  }

  // ---------- 操作 ----------
  async function doRun(t) {
    try {
      live.set(t.id, { runId: "", text: "" });
      const runId = await invoke("scheduler_run_now", { taskId: t.id });
      if (runId) live.get(t.id).runId = runId;
      paintList();
    } catch (e) {
      live.delete(t.id);
      showDialog({ title: "无法运行", message: String(e), okText: "知道了", showCancel: false });
    }
  }

  async function doStop(runId) {
    if (!runId) return;
    try {
      await invoke("scheduler_cancel", { runId });
    } catch (e) {
      toast(`停止失败：${e}`);
    }
  }

  function toggleTask(t, next) {
    t.enabled = next;
    saveState();
    paintList();
    paintSummary();
  }

  async function removeTask(t) {
    const ok = await showDialog({
      title: "删除任务",
      message: `确定删除「${t.name}」？运行历史会一并清除。若已注册系统计划任务，建议先在编辑里注销。`,
      okText: "删除",
      danger: true,
    });
    if (!ok) return;
    s.tasks = (s.tasks || []).filter((x) => x.id !== t.id);
    saveState();
    try {
      await invoke("scheduler_clear_runs", { taskId: t.id });
    } catch (_) {}
    runsCache = runsCache.filter((r) => r.taskId !== t.id);
    delete heatCache[t.id];
    paintList();
    paintSummary();
  }

  // ---------- 实时输出 ----------
  function appendLive(taskId, text) {
    const cur = live.get(taskId);
    if (!cur) live.set(taskId, { runId: "", text });
    else cur.text += text;
    const pre = listEl.querySelector(`pre[data-live="${CSS.escape(taskId)}"]`);
    if (pre) {
      pre.textContent = live.get(taskId).text;
      pre.scrollTop = pre.scrollHeight; // 跟随到底部，等同终端体验
    } else {
      paintList();
    }
  }

  // 事件订阅：模块卸载时统一解绑，避免切走后再收到事件往已销毁的 DOM 上写
  const offs = [];
  offs.push(Bus.on("scheduler://started", (p) => {
    if (!p) return;
    live.set(p.taskId, { runId: p.runId, text: "" });
    // 定时触发的运行前端此前毫不知情，这里补一条运行中记录，否则界面看不到
    if (!status.running) status.running = [];
    if (!status.running.some((r) => r.runId === p.runId)) {
      status.running.push({ runId: p.runId, taskId: p.taskId, name: p.name, trigger: p.trigger, startedAt: p.startedAt });
    }
    paintSummary();
    paintList();
  }));
  offs.push(Bus.on("scheduler://log", (p) => {
    if (!p || !p.text) return;
    appendLive(p.taskId, p.text);
  }));
  offs.push(Bus.on("scheduler://done", async (p) => {
    if (!p) return;
    live.delete(p.taskId);
    status.running = (status.running || []).filter((r) => r.runId !== p.runId);
    const meta = STATUS_META[p.status] || STATUS_META.failed;
    toast(`${p.name || "任务"}：${meta.text}（${fmtDuration(p.durationMs)}）`);
    await refresh();
  }));
  view.onDestroy(() => offs.forEach((f) => f()));

  // ---------- 编辑器 ----------
  function openEditor(t) {
    const isNew = !t;
    const d = t || {
      id: uid("t_"),
      name: "",
      // 创建日期：热力图靠它区分「那会儿还没这任务」与「该跑没跑」。
      // 老任务没有这个字段，回落到「最早一条聚合记录」，再没有就整月留白（不冤判漏跑）。
      since: todayKey(),
      enabled: true,
      scheduleEnabled: true,
      cron: "0 10 * * *",
      kind: "command",
      command: "",
      cwd: "",
      method: "GET",
      url: "",
      headers: {},
      body: "",
      expect: "",
      timeoutSec: 300,
      retry: 0,
      outputEncoding: "auto",
      note: "",
    };
    const f = cronToForm(d.cron);
    const ov = document.createElement("div");
    ov.className = "task-modal-overlay";
    ov.innerHTML = `
      <div class="task-modal sch-modal">
        <h3>${isNew ? "新建任务" : "编辑任务"}</h3>
        <div class="sch-form">
          <div class="tm-field">
            <label>任务名称</label>
            <input id="sf-name" type="text" value="${esc(d.name)}" placeholder="例如：WorkBuddy 每日签到" />
          </div>

          <div class="tm-field">
            <label>任务类型</label>
            <select id="sf-kind">
              <option value="command"${d.kind === "command" ? " selected" : ""}>本地命令 / 脚本</option>
              <option value="http"${d.kind === "http" ? " selected" : ""}>HTTP 请求</option>
            </select>
          </div>

          <div data-kind="command">
            <div class="tm-field">
              <label>命令</label>
              <textarea id="sf-command" rows="2" placeholder='例如："C:\\path\\python.exe" "C:\\path\\script.py"'>${esc(d.command)}</textarea>
              <span class="sch-hint">经 cmd 执行，支持引号与管道；运行时不弹出黑窗</span>
            </div>
            <div class="tm-field">
              <label>工作目录（可选）</label>
              <input id="sf-cwd" type="text" value="${esc(d.cwd)}" placeholder="留空则用 app 当前目录" />
            </div>
          </div>

          <div data-kind="http">
            <div class="sch-inline">
              <div class="tm-field" style="flex:0 0 110px">
                <label>方法</label>
                <select id="sf-method">
                  ${["GET", "POST", "PUT", "DELETE", "HEAD"].map((m) => `<option value="${m}"${d.method === m ? " selected" : ""}>${m}</option>`).join("")}
                </select>
              </div>
              <div class="tm-field" style="flex:1">
                <label>URL</label>
                <input id="sf-url" type="text" value="${esc(d.url)}" placeholder="https://..." />
              </div>
            </div>
            <div class="tm-field">
              <label>请求头（每行 <code>键: 值</code>）</label>
              <textarea id="sf-headers" rows="2" placeholder="Authorization: Bearer xxx">${esc(headersToText(d.headers))}</textarea>
            </div>
            <div class="tm-field">
              <label>请求体（可选）</label>
              <textarea id="sf-body" rows="2">${esc(d.body)}</textarea>
            </div>
            <div class="tm-field">
              <label>响应需包含（可选）</label>
              <input id="sf-expect" type="text" value="${esc(d.expect)}" placeholder='例如："success" —— 不含则判为失败' />
            </div>
          </div>

          <div class="sch-sec">调度</div>
          <div class="sch-inline">
            <div class="tm-field" style="flex:0 0 150px">
              <label>方式</label>
              <select id="sf-mode">
                <option value="daily">每天</option>
                <option value="weekly">每周</option>
                <option value="monthly">每月</option>
                <option value="minutes">每隔 N 分钟</option>
                <option value="hours">每隔 N 小时</option>
                <option value="custom">自定义 cron</option>
              </select>
            </div>
            <div class="tm-field" id="sf-slot-time">
              <label>时间</label>
              <input id="sf-time" type="time" value="${pad2(f.hh)}:${pad2(f.mm)}" />
            </div>
            <div class="tm-field" id="sf-slot-n" style="flex:0 0 130px">
              <label>间隔</label>
              <input id="sf-n" type="number" min="1" max="59" value="${f.n || 30}" />
            </div>
            <div class="tm-field" id="sf-slot-dom" style="flex:0 0 130px">
              <label>日</label>
              <input id="sf-dom" type="number" min="1" max="31" value="${f.dom || 1}" />
            </div>
          </div>
          <div class="tm-field" id="sf-slot-days">
            <label>星期</label>
            <div class="sch-days">
              ${WEEK_LABEL.map((w, i) => `<button type="button" class="sch-day${f.days.includes(i) ? " on" : ""}" data-d="${i}">${w}</button>`).join("")}
            </div>
          </div>
          <div class="tm-field" id="sf-slot-raw">
            <label>cron 表达式（分 时 日 月 周）</label>
            <input id="sf-raw" type="text" value="${esc(f.raw)}" placeholder="0 10 * * *" title="分 时 日 月 周，例：0 10 * * * = 每天 10:00；星期 0 与 7 都是周日" />
          </div>
          <div class="sch-cronbar">
            <code id="sf-cron">${esc(d.cron)}</code>
            <span id="sf-human">${esc(describeCron(d.cron))}</span>
            <span class="sch-next" id="sf-next"></span>
          </div>
          <div class="sch-hint">
            5 段：<code>分 时 日 月 周</code>，与 crontab / 青龙面板一致。
            例 <code>0 10 * * *</code> 每天 10:00、<code>*/30 * * * *</code> 每 30 分钟、<code>0 9 * * 1-5</code> 工作日 09:00。
            星期 <code>0</code> 与 <code>7</code> 都表示周日。
          </div>

          <div class="sch-sec">运行</div>
          <div class="sch-inline">
            <div class="tm-field" style="flex:0 0 130px">
              <label>超时（秒）</label>
              <input id="sf-timeout" type="number" min="1" max="86400" value="${d.timeoutSec || 300}" />
            </div>
            <div class="tm-field" style="flex:0 0 130px">
              <label>失败重试（次）</label>
              <input id="sf-retry" type="number" min="0" max="5" value="${d.retry || 0}" />
            </div>
            <div class="tm-field" style="flex:1">
              <label>输出编码</label>
              <select id="sf-enc">
                <option value="auto"${d.outputEncoding === "auto" || !d.outputEncoding ? " selected" : ""}>自动识别</option>
                <option value="utf8"${d.outputEncoding === "utf8" ? " selected" : ""}>UTF-8</option>
                <option value="gbk"${d.outputEncoding === "gbk" ? " selected" : ""}>GBK（系统默认）</option>
              </select>
            </div>
          </div>
          <div class="sch-hint">
            输出编码影响日志里的中文：Windows 上 cmd 的报错、未设 <code>PYTHONUTF8</code> 的 python 都按 GBK 输出，
            而 git / node / cargo 多是 UTF-8。默认「自动识别」按落点特征判定；出现乱码时手工指定最可靠。
            另外 <code>pythonw.exe</code> 这类无窗口解释器不产生任何输出，日志会是空的 —— 要看输出请改用 <code>python.exe</code>。
          </div>
          <div class="sch-switches">
            <label class="sch-sw"><input type="checkbox" id="sf-enabled"${d.enabled ? " checked" : ""} /><span>启用任务</span></label>
            <label class="sch-sw"><input type="checkbox" id="sf-sched"${d.scheduleEnabled ? " checked" : ""} /><span>面板内调度</span></label>
          </div>
          <div class="sch-hint">
            面板内调度要求 deskoverlay 正在运行；关掉它只保留手动运行。想由 Windows 计划任务触发，见下方「系统计划任务」。
          </div>

          <div class="sch-sec">系统计划任务（app 关着也能触发）</div>
          <div class="sch-osbox">
            <div id="sf-os-state" class="sch-hint"></div>
            <div class="sch-osacts">
              <button type="button" class="btn-ghost btn-xs" id="sf-os-preview">预览命令</button>
              <button type="button" class="btn-ghost btn-xs" id="sf-os-reg">注册</button>
              <button type="button" class="btn-ghost btn-xs" id="sf-os-unreg">注销</button>
            </div>
            <div class="sch-hint">
              注意：系统计划任务触发的运行不经过本进程，<b>没有实时输出</b>，只能在「日志 → 系统计划任务」里看落盘日志。
              同时开启面板内调度会造成同一时刻触发两次。
            </div>
            <pre class="sch-osout" id="sf-os-out"></pre>
          </div>
          <div class="tm-field">
            <label>备注（可选）</label>
            <input id="sf-note" type="text" value="${esc(d.note)}" placeholder="为什么这么配 / 现由谁触发" />
          </div>
        </div>
        <div class="tm-actions">
          <button class="tm-cancel" id="sf-cancel">取消</button>
          <button class="btn-primary" id="sf-save">${isNew ? "创建" : "保存"}</button>
        </div>
      </div>`;
    document.body.appendChild(ov);

    // ---- 表单联动 ----
    const $ = (sel) => ov.querySelector(sel);
    const form = { ...f };
    let days = f.days.slice();

    function syncKind() {
      const kind = $("#sf-kind").value;
      ov.querySelectorAll("[data-kind]").forEach((n) => {
        n.style.display = n.dataset.kind === kind ? "" : "none";
      });
    }
    function syncMode() {
      const mode = $("#sf-mode").value;
      $("#sf-slot-time").style.display = ["daily", "weekly", "monthly"].includes(mode) ? "" : "none";
      $("#sf-slot-n").style.display = ["minutes", "hours"].includes(mode) ? "" : "none";
      $("#sf-slot-dom").style.display = mode === "monthly" ? "" : "none";
      $("#sf-slot-days").style.display = mode === "weekly" ? "" : "none";
      $("#sf-slot-raw").style.display = mode === "custom" ? "" : "none";
      // 「每隔 N 分钟」的输入上限与小时不同，顺手纠正，避免填 60 分钟这种无效值
      const nEl = $("#sf-n");
      nEl.max = mode === "hours" ? "23" : "59";
    }
    async function syncCron() {
      const tEl = $("#sf-time").value || "10:00";
      const [hh, mm] = tEl.split(":").map(Number);
      form.mode = $("#sf-mode").value;
      form.hh = isFinite(hh) ? hh : 10;
      form.mm = isFinite(mm) ? mm : 0;
      form.n = Number($("#sf-n").value) || 1;
      form.dom = Number($("#sf-dom").value) || 1;
      form.days = days;
      form.raw = $("#sf-raw").value;
      const cron = formToCron(form);
      $("#sf-cron").textContent = cron;
      $("#sf-human").textContent = describeCron(cron);
      // 实时校验交给后端（与调度器同一套 cron 实现），避免前端自己写一套解析而与后端不一致
      const nextEl = $("#sf-next");
      nextEl.textContent = "";
      if (!cron.trim()) return;
      try {
        const r = await invoke("scheduler_check_cron", { expr: cron });
        if (r && r.ok) {
          const list = (r.preview || []).map(fmtClock).join("、");
          nextEl.textContent = `接下来：${list}`;
          nextEl.classList.remove("bad");
        } else {
          nextEl.textContent = r && r.error ? r.error : "表达式无效";
          nextEl.classList.add("bad");
        }
      } catch (_) {
        nextEl.textContent = "";
      }
    }

    $("#sf-mode").value = f.mode;
    syncKind();
    syncMode();
    syncCron();

    $("#sf-kind").addEventListener("change", syncKind);
    $("#sf-mode").addEventListener("change", () => { syncMode(); syncCron(); });
    ["#sf-time", "#sf-n", "#sf-dom", "#sf-raw"].forEach((sel) => {
      $(sel).addEventListener("input", syncCron);
      $(sel).addEventListener("change", syncCron);
    });
    ov.querySelectorAll(".sch-day").forEach((b) => {
      b.addEventListener("click", () => {
        const i = Number(b.dataset.d);
        if (days.includes(i)) days = days.filter((x) => x !== i);
        else days = [...days, i];
        b.classList.toggle("on", days.includes(i));
        syncCron();
      });
    });

    // ---- 系统计划任务：注册状态 / 预览 / 注册 / 注销 ----
    const osOut = $("#sf-os-out");
    let osBusy = false;
    // 后端是从 state.json 里按 id 找任务的，所以**未保存的新任务无法注册**。
    // 直接禁用并说明原因，好过让用户点了之后吃一个「任务不存在」。
    if (isNew) {
      $("#sf-os-state").innerHTML = "先点「创建」保存任务，之后才能注册到系统计划任务。";
      ["#sf-os-preview", "#sf-os-reg", "#sf-os-unreg"].forEach((sel) => { $(sel).disabled = true; });
    }
    async function refreshOs() {
      if (isNew) return;
      try {
        const m = await invoke("scheduler_export_status", { taskIds: [d.id] });
        const on = !!(m && m[d.id]);
        $("#sf-os-state").innerHTML = on
          ? `<span class="badge badge-green">已注册</span> 系统计划任务会在 app 未运行时也触发`
          : `<span class="badge badge-neutral">未注册</span> 仅面板内调度与手动运行`;
      } catch (e) {
        $("#sf-os-state").textContent = `状态查询失败：${e}`;
      }
    }
    async function osAction(kind) {
      if (osBusy || isNew) return;
      osBusy = true;
      osOut.textContent = "处理中…";
      try {
        // 预览/注册前先把表单写回 state 并落盘：后端是从 state.json 读任务定义的，
        // 若不先保存，改完 cron 立刻点注册，注册的会是旧时间。
        const saved = collect();
        if (!saved) {
          osOut.textContent = "请先修正表单（任务名/命令或 URL 不能为空）";
          return;
        }
        applyTo(d, saved);
        saveState();
        const cmd = kind === "preview" ? "scheduler_export_preview"
          : kind === "reg" ? "scheduler_export_task" : "scheduler_unexport_task";
        const r = await invoke(cmd, { taskId: d.id });
        const lines = [];
        if (r && r.human) lines.push(`调度：${r.human}`);
        if (r && r.name) lines.push(`任务名：${r.name}`);
        if (r && r.commandLine) lines.push(`命令：${r.commandLine}`);
        if (r && r.wrapper) lines.push(`包装脚本：${r.wrapper}`);
        if (r && r.output) lines.push(`输出：${r.output}`);
        osOut.textContent = lines.join("\n") || "完成";
        if (kind !== "preview") {
          toast(kind === "reg" ? "已注册到系统计划任务" : "已从系统计划任务注销");
          await refreshOs();
          await loadExportState();
        }
      } catch (e) {
        osOut.textContent = `失败：${e}`;
      } finally {
        osBusy = false;
      }
    }
    $("#sf-os-preview").addEventListener("click", () => osAction("preview"));
    $("#sf-os-reg").addEventListener("click", () => osAction("reg"));
    $("#sf-os-unreg").addEventListener("click", () => osAction("unreg"));
    refreshOs();

    // ---- 收集 / 保存 ----
    function collect() {
      const name = $("#sf-name").value.trim();
      if (!name) { toast("请填任务名称"); return null; }
      const cron = formToCron({
        mode: $("#sf-mode").value,
        hh: Number(($("#sf-time").value || "10:00").split(":")[0]),
        mm: Number(($("#sf-time").value || "10:00").split(":")[1]),
        n: Number($("#sf-n").value) || 1,
        dom: Number($("#sf-dom").value) || 1,
        days,
        raw: $("#sf-raw").value,
      }).trim();
      if (!cron) { toast("请填写 cron 表达式"); return null; }
      const kind = $("#sf-kind").value;
      const out = {
        ...d,
        name,
        kind,
        cron,
        enabled: $("#sf-enabled").checked,
        scheduleEnabled: $("#sf-sched").checked,
        cwd: $("#sf-cwd").value.trim(),
        command: $("#sf-command") ? $("#sf-command").value.trim() : d.command,
        headers: textToHeaders($("#sf-headers") ? $("#sf-headers").value : ""),
        body: $("#sf-body") ? $("#sf-body").value : "",
        expect: $("#sf-expect") ? $("#sf-expect").value.trim() : "",
        method: $("#sf-method") ? $("#sf-method").value : "GET",
        url: $("#sf-url") ? $("#sf-url").value.trim() : "",
        timeoutSec: Math.max(1, Math.min(86400, Number($("#sf-timeout").value) || 300)),
        retry: Math.max(0, Math.min(5, Number($("#sf-retry").value) || 0)),
        outputEncoding: $("#sf-enc") ? $("#sf-enc").value : "auto",
        note: $("#sf-note").value.trim(),
      };
      if (kind === "command" && !out.command) { toast("请填写命令"); return null; }
      if (kind === "http" && !out.url) { toast("请填写 URL"); return null; }
      return out;
    }

    ov.querySelector("#sf-cancel").addEventListener("click", () => ov.remove());
    ov.addEventListener("keydown", (e) => { if (e.key === "Escape") ov.remove(); });
    $("#sf-save").addEventListener("click", async () => {
      const out = collect();
      if (!out) return;
      if (isNew) (s.tasks || (s.tasks = [])).push(out);
      else applyTo(d, out);
      saveState();
      ov.remove();
      await refresh();
      toast(isNew ? "任务已创建" : "任务已保存");
    });
  }

  /// 就地更新任务对象：保持 tasks 数组里的引用不变（编辑器持有的是引用）
  function applyTo(target, src) {
    for (const k of Object.keys(src)) target[k] = src[k];
  }

  function headersToText(h) {
    if (!h || typeof h !== "object") return "";
    return Object.entries(h).map(([k, v]) => `${k}: ${v}`).join("\n");
  }
  function textToHeaders(txt) {
    const out = {};
    String(txt || "").split("\n").forEach((line) => {
      const i = line.indexOf(":");
      if (i <= 0) return;
      const k = line.slice(0, i).trim();
      const v = line.slice(i + 1).trim();
      if (k) out[k] = v;
    });
    return out;
  }

  // ---------- 日志 ----------
  async function openLogs(t) {
    const ov = document.createElement("div");
    ov.className = "task-modal-overlay";
    ov.innerHTML = `
      <div class="task-modal sch-modal log-modal">
        <h3>${esc(t.name)} · 运行日志</h3>
        <div class="sch-logtabs">
          <button class="sch-tab on" data-t="panel">面板内调度</button>
          <button class="sch-tab" data-t="os">系统计划任务</button>
          <button class="btn-ghost btn-xs" id="sf-clear" style="margin-left:auto">清空</button>
        </div>
        <div class="sch-logbody" id="sf-logbody"></div>
        <div class="tm-actions"><button class="tm-cancel" id="sf-lclose">关闭</button></div>
      </div>`;
    document.body.appendChild(ov);
    ov.querySelector("#sf-lclose").addEventListener("click", () => ov.remove());
    ov.addEventListener("keydown", (e) => { if (e.key === "Escape") ov.remove(); });

    const body = ov.querySelector("#sf-logbody");
    let tab = "panel";

    async function paint() {
      if (tab === "os") {
        let r = null;
        try { r = await invoke("scheduler_read_os_log", { taskId: t.id }); } catch (_) {}
        if (!r || !r.exists) {
          body.innerHTML = `<div class="empty-state">还没有由系统计划任务触发的记录。先在上方「注册」。</div>`;
          return;
        }
        body.innerHTML = `<div class="sch-logpath">${esc(r.path || "")}</div><pre class="sch-logtext">${esc(r.text || "（空）")}</pre>`;
        return;
      }
      const runs = runsCache.filter((x) => x.taskId === t.id);
      if (!runs.length) {
        body.innerHTML = `<div class="empty-state">还没有运行记录</div>`;
        return;
      }
      // 展开态：默认展开最近一次，其余折叠 —— 历史多了也能一眼看到最近结果
      body.innerHTML = runs.map((r, i) => {
        const m = STATUS_META[r.status] || STATUS_META.failed;
        const tg = r.trigger === "cron" ? "定时" : r.trigger === "catchup" ? "补跑" : "手动";
        return `
          <div class="sch-run" data-open="${i === 0 ? "1" : "0"}">
            <div class="sch-run-head">
              <span class="badge ${m.cls}">${m.text}</span>
              <span class="sch-run-time">${esc(new Date(r.startedAt).toLocaleString("zh-CN"))}</span>
              <span class="sch-run-meta">${fmtDuration(r.durationMs)} · ${tg}${r.exitCode != null ? ` · 退出码 ${r.exitCode}` : ""}</span>
            </div>
            <pre class="sch-logtext">${esc(r.output || "（无输出）")}</pre>
          </div>`;
      }).join("");
      body.querySelectorAll(".sch-run").forEach((n) => {
        n.querySelector(".sch-run-head").addEventListener("click", () => {
          n.dataset.open = n.dataset.open === "1" ? "0" : "1";
        });
      });
    }

    ov.querySelectorAll(".sch-tab").forEach((b) => {
      b.addEventListener("click", () => {
        ov.querySelectorAll(".sch-tab").forEach((x) => x.classList.toggle("on", x === b));
        tab = b.dataset.t;
        paint();
      });
    });
    ov.querySelector("#sf-clear").addEventListener("click", async () => {
      const ok = await showDialog({ title: "清空日志", message: "清空该任务的运行历史？此操作不可撤销。", okText: "清空", danger: true });
      if (!ok) return;
      try {
        if (tab === "os") await invoke("scheduler_clear_os_log", { taskId: t.id });
        else {
          await invoke("scheduler_clear_runs", { taskId: t.id });
          runsCache = runsCache.filter((r) => r.taskId !== t.id);
          await loadHeat(); // 后端已把该任务的按天聚合一并清掉，本地缓存必须跟着走
        }
      } catch (e) {
        toast(`清空失败：${e}`);
      }
      paint();
      paintList();
    });

    await paint();
  }

  // ---------- 调度设置 ----------
  function openSettings() {
    const ov = document.createElement("div");
    ov.className = "task-modal-overlay";
    ov.innerHTML = `
      <div class="task-modal confirm-modal sch-set-modal">
        <h3>调度设置</h3>
        <div class="tm-field">
          <label>并发上限（同时运行的任务数）</label>
          <input id="ss-max" type="number" min="1" max="8" value="${s.maxConcurrent}" />
        </div>
        <label class="sch-sw"><input type="checkbox" id="ss-catchup"${s.catchUp ? " checked" : ""} /><span>启动时补跑错过的任务</span></label>
        <div class="sch-hint">
          补跑仅针对「app 未运行期间错过」的任务，且只补最近 6 小时内到期的（避免开机后涌出一堆过期任务）。
          并发满时不会丢弃触发，而是等到有空位再执行。
        </div>
        <div class="tm-actions">
          <button class="tm-cancel" id="ss-cancel">取消</button>
          <button class="btn-primary" id="ss-save">保存</button>
        </div>
      </div>`;
    document.body.appendChild(ov);
    ov.querySelector("#ss-cancel").addEventListener("click", () => ov.remove());
    ov.addEventListener("keydown", (e) => { if (e.key === "Escape") ov.remove(); });
    ov.querySelector("#ss-save").addEventListener("click", async () => {
      s.maxConcurrent = Math.max(1, Math.min(8, Number(ov.querySelector("#ss-max").value) || 2));
      s.catchUp = ov.querySelector("#ss-catchup").checked;
      saveState();
      ov.remove();
      await loadStatus();
      paintSummary();
      paintList();
    });
  }

  // ---------- 顶部按钮 ----------
  el.querySelector("#sch-new").addEventListener("click", () => openEditor(null));
  el.querySelector("#sch-cfg").addEventListener("click", openSettings);

  // ---------- 首次加载 ----------
  (async () => {
    await refresh();
    await loadExportState();
    paintList();
  })();

  // ---------- 走时 ----------
  /// 只改写「上次多久前 / 下次几点」这类随时间变化的文本。
  /// 不能整表重绘：行内实时输出 <pre> 会因此丢掉滚动位置（用户正盯着日志时尤其明显）。
  function tickRelTimes() {
    for (const n of listEl.querySelectorAll("[data-rel]")) n.textContent = relTime(Number(n.dataset.rel));
    for (const n of listEl.querySelectorAll("[data-next]")) n.textContent = fmtClock(Number(n.dataset.next));
  }

  // 运行中任务的耗时/相对时间需要走动才不显得卡住
  const beat = setInterval(async () => {
    if (status.running?.length || (s.tasks || []).some((t) => t.enabled && t.scheduleEnabled)) {
      await loadStatus();
      paintSummary();
    }
    tickRelTimes();
  }, 5000);
  view.onDestroy(() => clearInterval(beat));
}
