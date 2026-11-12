// 禅道统计视图：四个数字 —— 未完成需求 / 未完成 Bug / 未验证需求 / 未验证 Bug。
// 数据源：后台线程抓取的禅道统计快照（state.emsStats），本视图只读不写。
//
// 为什么独立成模块而不是塞进别处：
//   工作记录面板已整体移除（连同 state.workLogs），这个位置改成「一眼看数量」的看板。
//   用户日常关心的是「还有多少活没干完」，不是流水账。
//
// 数字之外还要能看「具体是哪些」：每格点开是明细列表，
// 数据来自同一份快照的 `*Rows` 字段（抓取时就一起带回来了，点开不再发请求）。
import { state } from "../state.js";
import { invoke } from "../bus.js";
import { ICON_REQ, ICON_BUG, ICON_VERIFY, ICON_REFRESH } from "../icons.js";
import { esc, hhmm } from "../utils.js";

// 四类统计的定义：key 对应 state.emsStats 里的字段
//   rowsKey —— 明细数组字段名
//   group   —— 分组标题（需求 / Bug）
//   tone    —— 配色语义：warn = 待办量（未完成），check = 待验证（未验证）
//   desc    —— 悬停提示里的口径说明
const STAT_ITEMS = [
  {
    key: "reqOpen",
    rowsKey: "reqOpenRows",
    group: "需求",
    label: "未完成",
    icon: ICON_REQ,
    tone: "warn",
    desc: "指派给我、状态为「未开始 / 进行中 / 校验未通过」的任务",
  },
  {
    key: "reqUnverified",
    rowsKey: "reqUnverifiedRows",
    group: "需求",
    label: "未验证",
    icon: ICON_VERIFY,
    tone: "check",
    desc: "指派我验证但还没验的需求，以及我提的被驳回需求",
  },
  {
    key: "bugOpen",
    rowsKey: "bugOpenRows",
    group: "Bug",
    label: "未完成",
    icon: ICON_BUG,
    tone: "warn",
    desc: "指派给我、阶段为「待解决 / 测试不通过」的 Bug（测试打回重做的也算未完成）",
  },
  {
    key: "bugUnverified",
    rowsKey: "bugUnverifiedRows",
    group: "Bug",
    label: "未验证",
    icon: ICON_VERIFY,
    tone: "check",
    desc: "指派给我、阶段为「待测试」的 Bug",
  },
];

// 把统计对象规整成四元组，缺失一律 null（渲染成「—」，绝不显示 0 冒充「没有」）
function readStats() {
  const s = state.emsStats;
  if (!s || typeof s !== "object") return { values: null, at: 0, error: "" };
  const v = (k) => {
    const n = s[k];
    return Number.isFinite(Number(n)) && n !== null && n !== "" ? Number(n) : null;
  };
  return {
    values: {
      reqOpen: v("reqOpen"),
      reqUnverified: v("reqUnverified"),
      bugOpen: v("bugOpen"),
      bugUnverified: v("bugUnverified"),
    },
    at: Number(s.updatedAt) || 0,
    error: typeof s.error === "string" ? s.error : "",
  };
}

// 数字格式化：大数字加千分位，null 显示「—」
function fmtNum(n) {
  if (n == null) return "—";
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

// 明细行里挑一个非空字符串字段
function text(v) {
  if (v == null) return "";
  const s = String(v).trim();
  return s === "null" ? "" : s;
}

// 优先级数字 → 中文。任务行给的是 `pri` 裸数字，需求行给的是 `priority_text` 文本。
const PRI_TEXT = { 1: "紧急", 2: "高", 3: "中", 4: "一般", 5: "低" };

// 单条明细的标题：任务用 task_name，需求用 title
function rowTitle(r) {
  return text(r.title) || "（无标题）";
}

// 单条明细的副标题：把有的字段拼起来，没有就整行省略
function rowMeta(r) {
  const bits = [];
  // 状态优先用带名字的（需求行 statusName / 任务行由 Rust 映射的 statusName）
  const status = text(r.statusName) || text(r.status);
  if (status) bits.push(status);

  // 产品：需求行有 product 名字；任务行没有产品名（product_id 是裸数字），跳过
  const product = text(r.product);
  if (product) bits.push(product);

  // 优先级：需求行是文本（"4一般需求类"），任务行是数字（4）
  const pri = text(r.priority);
  if (pri) bits.push(PRI_TEXT[pri] || pri);

  const assignee = text(r.assignee);
  if (assignee) bits.push(assignee);

  const deadline = text(r.deadline);
  if (deadline) bits.push(`截止 ${deadline}`);

  // Bug 行没有 deadline，有 openedDate（提出时间）；只取日期部分，太长的完整时间没意义
  const opened = text(r.opened);
  if (opened) bits.push(opened.slice(0, 10));

  const createMonth = text(r.createMonth);
  if (createMonth) bits.push(createMonth);

  return bits.join(" · ");
}

// 编号：任务有 reqId 时优先显示需求号，否则显示自己的 id
function rowId(r) {
  const reqId = text(r.reqId);
  if (reqId && reqId !== "0") return `#${reqId}`;
  const id = text(r.id);
  return id ? `#${id}` : "";
}

export function renderEmsStats(view) {
  const body = view.body;

  body.innerHTML = `
    <div class="es-wrap">
      <div class="es-head">
        <div class="es-head__text">
          <div class="es-title">我的待办</div>
          <div class="es-sub" data-es-sub></div>
        </div>
        <button class="es-refresh" data-es-refresh title="重新读取统计快照">
          ${ICON_REFRESH}<span>刷新</span>
        </button>
      </div>
      <div class="es-grid" data-es-grid></div>
      <div class="es-hint" data-es-hint></div>
    </div>`;

  const grid = body.querySelector("[data-es-grid]");
  const sub = body.querySelector("[data-es-sub]");
  const hint = body.querySelector("[data-es-hint]");

  // 单条明细的 HTML（四个格子共用这段）
  function rowHtml(r) {
    const meta = rowMeta(r);
    return `<div class="es-row">
      <div class="es-row__hd">
        <span class="es-row__id">${esc(rowId(r))}</span>
        <span class="es-row__title">${esc(rowTitle(r))}</span>
      </div>
      ${meta ? `<div class="es-row__meta">${esc(meta)}</div>` : ""}
    </div>`;
  }

  function paint() {
    const { values, at, error } = readStats();

    if (sub) {
      sub.textContent = at ? `更新于 ${hhmm(new Date(at))}` : "还没有统计数据";
    }

    if (!values) {
      grid.innerHTML = `<div class="es-empty">还没有统计快照。后台抓取跑过之后这里会显示四个数字。</div>`;
      if (hint) hint.hidden = true;
      return;
    }

    grid.innerHTML = STAT_ITEMS.map((it) => {
      const n = values[it.key];
      const isZero = n === 0;
      const isNull = n == null;
      const rows = Array.isArray(state.emsStats?.[it.rowsKey])
        ? state.emsStats[it.rowsKey]
        : null;

      const cls = ["es-cell", `es-cell--${it.tone}`]
        .concat(isZero ? ["is-zero"] : [])
        .concat(isNull ? ["is-none"] : [])
        .join(" ");

      // 明细直接摊在格子里，不用点开。
      // 三种情况分开处理，别把「没接过数据源」和「查过但确实没有」混为一谈：
      //   rows === null  → 该指标还没接口，不显示列表区
      //   rows.length===0 → 查过了，确实是 0 条
      //   rows.length > 0 → 正常列表
      let list = "";
      if (Array.isArray(rows)) {
        list = rows.length
          ? `<div class="es-rows">${rows.map(rowHtml).join("")}</div>`
          : `<div class="es-rows es-rows--empty"><div class="es-rows__empty">没有待办</div></div>`;
      }

      // 数字区：null 时不能放大一个「—」——破折号在 32px 下就是一根粗灰条，
      // 看着像加载失败的占位块。改成小字「暂无数据」，明确表示「没有这个数据源」。
      const numHTML = isNull
        ? `<span class="es-cell__none">暂无数据</span>`
        : `<span class="es-cell__num">${esc(fmtNum(n))}</span>`;

      // 数量紧跟标题（图标 → 分组 → 状态 → 数字），明细整格宽铺在下面。
      // ⛔ 数量不能单独占一列：原先数字是左侧 96px 固定宽的独立列，
      //    下方 200+ 像素全空着，而明细只有 466px 宽。挪到标题行后
      //    明细拿到完整 576px，格子也不再「上满下空」。
      return `<div class="${cls}" data-es-key="${esc(it.key)}" title="${esc(it.desc)}">
        <div class="es-cell__hd">
          <span class="es-cell__icon">${it.icon}</span>
          <span class="es-cell__group">${esc(it.group)}</span>
          <span class="es-cell__label">${esc(it.label)}</span>
          ${numHTML}
        </div>
        <div class="es-cell__body">
          ${list}
        </div>
      </div>`;
    }).join("");

    // 错误提示：有 error 才显示，否则必须显式藏起来 ——
    // 少了这一步，上次的错误红条会一直留在面板底部。
    if (hint) {
      if (error) {
        hint.textContent = `上次抓取失败：${error}`;
        hint.hidden = false;
      } else {
        hint.hidden = true;
        hint.textContent = "";
      }
    }
  }

  // 刷新：真的去抓一轮（和首页卡片右上角的按钮走同一个命令）。
  // 抓完结果走 provider-emit 回到 state，再重画 —— 光重读 state 是没用的，
  // 后台线程每 15 分钟才跑一次，不主动请求就永远是旧数字。
  const btn = body.querySelector("[data-es-refresh]");
  if (btn) {
    btn.addEventListener("click", async () => {
      btn.classList.add("is-busy");
      try {
        await invoke("ems_refresh_now");
      } catch {
        // 纯浏览器预览没有 Tauri 命令：至少重画一次，别让按钮看着像坏了
        paint();
      } finally {
        // 给一点时间让 provider-emit 回来并触发重画
        setTimeout(() => {
          btn.classList.remove("is-busy");
          paint();
        }, 600);
      }
    });
  }

  paint();
}
