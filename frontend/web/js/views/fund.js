// 基金管家视图 · 对标养基宝的桌面基金模块。
// 四个页签：总览 / 自选持仓 / 市场排行 / 基金搜索；走宿主 state.fund 持久化 + Rust http_get 代理取数。
// 视觉全部复用宿主 STYLE_GUIDE token（--bg-panel / --text / --blue / --green / --danger …），
// 涨跌遵循 A 股习惯：红涨绿跌（--danger 红 / --green 绿）。
import { state, saveState } from "../state.js";
import { invoke, listen } from "../bus.js";
import { toast } from "../toast.js";
import { esc, uid } from "../utils.js";
// 估值核心（重仓股拟合 + 精度自校准）已抽成独立纯模块：不碰 DOM、不碰闭包、不碰 state。
// 依赖全部由下方 createEstimator({…}) 的 ports 注入，因此可脱离应用单独跑单测。
import { createEstimator } from "./fund-estimator.js";
// AI 分析（纯模块）：组装持仓快照 → 组 OpenAI 兼容请求 → 解析报告（含 SSE 流式增量）。
// 同样零 import / 零 DOM / 零全局时钟，网络与时钟由下面 createFundAi({…}) 注入。
import { createFundAi, createStreamParser, extractContent, AI_DEFAULTS, AI_HISTORY_MAX } from "./fund-ai.js";

const ID = "fund";
const TITLE = "基金管家";
const ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17l5-5 4 4 8-8"/><path d="M15 8h6v6"/></svg>';

// 账户收益曲线画布随窗口宽度重绘。模块级只注册一次（与 pomodoro / ideabox 的惯例一致）：
// 若写在 renderCurve 里，每次进入基金管家视图都会再叠一个监听器。
// 状态通过画布元素上的 __redraw 回调取，视图切换后旧画布被丢弃即自动释放。
// 按 class 全量遍历取画布：曲线块本身不带 id（panelWH 与 panelOverview 常驻 DOM，
// 用 id 会命中隐藏那份，且两份同 id 不合法）。
let curveResizeTimer = 0;
window.addEventListener("resize", () => {
  clearTimeout(curveResizeTimer);
  curveResizeTimer = setTimeout(() => {
    document.querySelectorAll("canvas.cur-canvas").forEach((cv) => {
      if (typeof cv.__redraw === "function") cv.__redraw();
    });
  }, 160);
});

const REFERER_EM = { "Referer": "https://fund.eastmoney.com/" };
const REFERER_F10 = { "Referer": "https://fundf10.eastmoney.com/" };
const REFERER_RANK = { "Referer": "https://fund.eastmoney.com/data/fundranking.html" };
const SINA_H = { "Referer": "https://finance.sina.com.cn/" };
const CACHE_TTL = 5 * 60 * 1000; // 兼容旧引用（getTTL 分档后不再使用）
// 不同数据分级缓存：行情快、排行/板块慢，避免高频请求被限流
const TTL_QUOTE = 60 * 1000;        // 单基金净值/估算
const TTL_HISTORY = 5 * 60 * 1000;  // 历史净值
const TTL_RANK = 30 * 60 * 1000;    // 排行 / 搜索 / 板块
const TTL_INDEX = 30 * 1000;        // 指数（盘中变化快）
// 注：估值 / 校准相关阈值（TTL_POSITION、STOCK_BATCH、EST_MIN_COVER、CALIB_*）已随估值核心
// 迁至 views/fund-estimator.js 的 consts；本文件按需从 est.consts 取别名。
// 失效缓存兜底窗口：接口失败时允许回退到 N 分钟前的旧数据，显示但标注
const STALE_WINDOW = 30 * 60 * 1000;
// 请求超时（毫秒），防止个别接口长时间挂起拖垮整页
const REQ_TIMEOUT = 12 * 1000;
const HISTORY_POINTS = 20;
// 走势弹窗周期选择（近1周/1月/3月/6月/1年），本地切片无需额外请求
const CHART_PERIODS = [
  { id: "1w", label: "近1周", days: 7 },
  { id: "1m", label: "近1月", days: 30 },
  { id: "3m", label: "近3月", days: 91 },
  { id: "6m", label: "近6月", days: 182 },
  { id: "1y", label: "近1年", days: 365 },
];
const RANK_SORTS = [
  { id: "1nzf", label: "近1周" },
  { id: "1yzf", label: "近1月" },
  { id: "3yzf", label: "近3月" },
  { id: "6yzf", label: "近6月" },
  { id: "1jz", label: "近1年" },
];
const FTYPES = [
  { v: "all", label: "全部" },
  { v: "gp", label: "股票型" },
  { v: "hh", label: "混合型" },
  { v: "zq", label: "债券型" },
  { v: "zs", label: "指数型" },
  { v: "qdii", label: "QDII" },
  { v: "fof", label: "FOF" },
];
const TRADE_TYPES = {
  buy: { label: "申购", cls: "badge-blue" },
  sell: { label: "赎回", cls: "badge-amber" },
  div: { label: "分红", cls: "badge-purple" },
};
// 定投计划：周期与扣款日
const PLAN_CYCLES = [
  { id: "day", label: "每日" },
  { id: "week", label: "每周" },
  { id: "month", label: "每月" },
];
const PLAN_WEEKDAYS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
// 单次最多补记期数：防止长期未打开后一次写入过多流水
const PLAN_MAX_CATCHUP = 24;
// A 股一年约 244 个交易日，用于把「日投」折算成每月金额（见 planMonthlyAmount）
const PLAN_TRADE_DAYS = 244;
// 定投年化只在样本足够时才给（期数太少年化无统计意义）
const PLAN_XIRR_MIN_FLOWS = 3;
const PLAN_XIRR_MIN_DAYS = 90;

function isTradingNow(d) {
  const t = d || new Date();
  const day = t.getDay();
  if (day === 0 || day === 6) return false;
  const mins = t.getHours() * 60 + t.getMinutes();
  return (mins >= 570 && mins <= 690) || (mins >= 780 && mins <= 900);
}

function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}
function fmtPct(v, digits) {
  if (v === null || v === undefined || !isFinite(v)) return "--";
  const s = v > 0 ? "+" : "";
  return s + v.toFixed(digits === undefined ? 2 : digits) + "%";
}
function fmtMoney(v) {
  if (v === null || v === undefined || !isFinite(v)) return "--";
  const n = Math.round(v * 100) / 100;
  return n.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function pctClass(v) {
  if (v === null || v === undefined || !isFinite(v)) return "";
  if (v > 0) return "fund-pct-up";
  if (v < 0) return "fund-pct-down";
  return "";
}

export function renderFund(view) {
  const body = view.body;
  view.header.style.display = "none";

  if (!state.fund || typeof state.fund !== "object" || Array.isArray(state.fund)) state.fund = {};
  const F = state.fund;
  if (!Array.isArray(F.watchlist)) F.watchlist = [];
  if (!Array.isArray(F.holdings)) F.holdings = [];
  if (!Array.isArray(F.trades)) F.trades = [];
  if (!Array.isArray(F.plans)) F.plans = [];   // 定投计划
  // 读入即归一化（见 normalizePlans）：让 plan.cycle / plan.day 在进入内存的那一刻就落在合法域内
  F.plans = normalizePlans(F.plans);
  // 估算精度校准样本：{ 基金代码: [{ d: 净值日, est: 估算值%, real: 官方日增长率% }, …] }
  if (!F.calib || typeof F.calib !== "object" || Array.isArray(F.calib)) F.calib = {};
  if (!F.cache || typeof F.cache !== "object") F.cache = {};
  if (!F.cache.quote) F.cache.quote = {};
  if (!F.cache.history) F.cache.history = {};
  if (!F.cache.rank) F.cache.rank = {};
  if (!F.settings || typeof F.settings !== "object") F.settings = {};
  if (typeof F.settings.autoRefresh !== "boolean") F.settings.autoRefresh = true;
  F.settings.refreshSec = Math.max(15, Math.min(300, num(F.settings.refreshSec, 30)));
  F.settings.highlightPct = Math.max(0.1, Math.min(10, num(F.settings.highlightPct, 0.5)));
  // AI 分析配置 + 报告历史（loadState 已归一化，这里兜住「同会话内被外部改坏」的情况）
  if (!F.ai || typeof F.ai !== "object" || Array.isArray(F.ai)) F.ai = {};
  if (!Array.isArray(F.ai.history)) F.ai.history = [];

  const save = () => { try { saveState(); } catch (_) {} };

  // —— 统一请求层：超时 + 重试 + 失败返回 null，避免单接口拖垮整页 ——
  async function getRaw(url, headers) {
    return await invoke("http_get", { url, headers: headers || null });
  }
  // 带超时的请求：用 AbortController 之外的方案（invoke 不支持取消，靠 Promise.race 兜底）
  function withTimeout(p) {
    let timer = 0;
    const t = new Promise((_, rej) => {
      timer = setTimeout(() => rej(new Error("请求超时")), REQ_TIMEOUT);
    });
    return Promise.race([p, t]).finally(() => clearTimeout(timer));
  }
  // 主请求：超时 + 静默重试（网络抖动 / 东财限流常见），默认 2 次尝试。
  // tries 可选：多路并发场景（如涨跌分布 5 页）需要更高次数，见 DIST_TRIES。
  async function get(url, headers, tries) {
    const n = Math.max(1, Number(tries) || 2);
    let lastErr;
    for (let i = 0; i < n; i++) {
      try { return await withTimeout(getRaw(url, headers)); }
      catch (e) {
        lastErr = e;
        if (i < n - 1) await new Promise((r) => setTimeout(r, 300 + Math.random() * 300));
      }
    }
    throw lastErr || new Error("请求失败");
  }

  // —— 缓存：分级 TTL + 失效缓存兜底 ——
  // rec: { at, data, failed }，failed 表示这是接口失败后的旧数据回退
  function cacheBucketOf(kind) {
    if (kind === "quote") return F.cache.quote;
    if (kind === "history") return F.cache.history;
    return F.cache.rank;
  }
  function getTTL(kind) {
    if (kind === "quote") return TTL_QUOTE;
    if (kind === "history") return TTL_HISTORY;
    if (kind === "index") return TTL_INDEX;
    return TTL_RANK;
  }
  function cached(key, kind) {
    const bucket = cacheBucketOf(kind);
    const rec = bucket ? bucket[key] : null;
    if (!rec || typeof rec.at !== "number") return undefined;
    if (Date.now() - rec.at < getTTL(kind)) return rec.data;
    return undefined;
  }
  // 失效缓存兜底：接口失败时允许回退 STALE_WINDOW 内的旧数据
  function cachedStale(key, kind) {
    const bucket = cacheBucketOf(kind);
    const rec = bucket ? bucket[key] : null;
    if (!rec || typeof rec.at !== "number") return undefined;
    if (Date.now() - rec.at < STALE_WINDOW) return { data: rec.data, at: rec.at };
    return undefined;
  }
  // 原始缓存记录（含写入时刻 at）：供需要判断「这条缓存是多久前写的」的调用方使用，
  // 例如涨跌分布的「残缺结果只复用 60s」判断（见 DIST_PARTIAL_TTL）。
  function cachedRec(key, kind) {
    const bucket = cacheBucketOf(kind);
    const rec = bucket ? bucket[key] : null;
    return rec && typeof rec.at === "number" ? rec : null;
  }
  function storeCache(kind, key, data) {
    const bucket = cacheBucketOf(kind);
    if (!bucket) return;
    bucket[key] = { at: Date.now(), data };
  }
  // 统一读取缓存：quote 缓存可能是 {at, data} 包装（storeCache/refreshQuotes 写入），也可能是原始对象
  // staleMemo 记录最近一次"接口失败但回退旧数据"的代码，界面据此显示"缓"标记（不落盘）
  const staleMemo = {};
  // 基金主题列表内存缓存：不落 state.json（上百个主题 × 多组合会把存档撑大）
  const themeMemo = new Map();
  function getQuote(code) {
    const rec = F.cache.quote["q:" + code];
    if (!rec) return undefined;
    const base = rec.data && typeof rec.data === "object" && "code" in rec.data ? rec.data : rec;
    if (staleMemo[code]) return Object.assign({}, base, { stale: true });
    return base;
  }

  // —— 估值核心实例 ——
  // 生命周期与视图一致（每次进入基金管家重建），因此 posMemo / estMemo 仍是不落盘的本轮内存缓存。
  // calib 走访问器而非直接传 F.calib 对象：state.fund 若被整体替换，闭包里的旧引用会失效。
  const est = createEstimator({
    http: get,
    getQuote,
    navSeries: (code) => navSeriesCode(code),   // 与收益曲线共用 30 分钟净值缓存
    calib: { all: () => F.calib, persist: save },
    referers: { f10: REFERER_F10, sina: SINA_H },
    isTrading: () => isTradingNow(),
    ymd,
  });
  // —— AI 分析（纯模块）——
  // httpPost 走宿主 http_post 的「自定义超时」通道：大模型生成常需 30–120s，
  // 默认 15s 必然被截断（见 src-tauri/src/http.rs 的 timeout_ms 参数）。
  const fundAi = createFundAi({
    httpPost: (url, body, headers, timeoutMs) => invoke("http_post", { url, body, headers, timeoutMs }),
    now: () => Date.now(),
  });
  // 只解构视图真正用到的出口；模块内部能力（allEstimates / hasPositions / getEstimate…）
  // 已随穿透聚合一并收进模块，视图不再直接消费，不必挂在这里。
  const {
    buildEstimates,
    positions, clearPositions, getEstAt, getEstDates,
    ensurePositions, buildLookThrough, buildOverlap,
    shouldEstimate, dayPctOf,
    calibList, calibStats, calibOverall, syncCalibration, calibrationSweep,
  } = est;
  // 阈值别名（避免到处写 est.consts.X）
  const CALIB_MIN_N = est.consts.CALIB_MIN_N;   // 校准面板
  const CALIB_HIT_PP = est.consts.CALIB_HIT_PP; // 校准面板
  const TTL_POSITION = est.consts.TTL_POSITION; // 穿透视图判断「要不要显示加载态」

  // —— 实时净值 / 估算 ——
  function extractVar(js, varName) {
    const m = new RegExp("var\\s+" + varName + "\\s*=\\s*(\\[.*?\\]);", "s").exec(js);
    if (!m) return null;
    try { return JSON.parse(m[1]); } catch (_) { return null; }
  }

  // 注意：天天基金 fundgz 估值接口已于 2026-07-21 下线（返回 404），不再调用。
  // 主源：fund.eastmoney.com/pingzhongdata（收盘净值 + 日涨跌幅 + 净值趋势，数据权威、免认证）。
  // 盘中代理：对已映射的指数基金，用新浪行情 hq.sinajs.cn 取对应场内 ETF 实时价，算估算涨跌。
  // 未映射的场外基金：盘中显示"最新净值日涨跌"（昨日收盘数据），非实时估算；界面以 title/tag 区分。
  const ETF_PROXY = {
    "510300": "sh510300", "159919": "sz159919", "000016": "sh510050",
    "510500": "sh510500", "159915": "sz159915", "512880": "sh512880",
    "512760": "sh512760", "512480": "sh512480", "512170": "sh512170",
    "512010": "sh512010", "515000": "sh515000", "510880": "sh510880",
    "512100": "sh512100", "515700": "sh515700", "512690": "sh512690",
  };
  async function fetchSinaEtf(etfSym) {
    // 返回 { price, prevClose, time } 或 null
    // 同 fetchIndexes：路径式接口，结尾不可追加 &format=text（会被并入代码本身）
    const raw = await get(`https://hq.sinajs.cn/list=${etfSym}`, SINA_H);
    const line = raw.split("\n").find((l) => l.includes(`hq_str_${etfSym}="`));
    if (!line) return null;
    // 新浪返回 GBK 文本，字段逗号分隔：名称,今开,昨收,现价,最高,最低,...
    const parts = line.split('="')[1]?.split(",") || [];
    const price = num(parts[3], 0);
    const prevClose = num(parts[2], 0);
    if (!price || !prevClose) return null;
    const time = [parts[30], parts[31]].filter(Boolean).join(" ") || "";
    return { price, prevClose, time };
  }

  // 重仓股拟合估值（fetchPositions / fetchStockQuotes / buildEstimates）与精度自校准
  // （quotesClosed / calibList / calibStats / calibOverall / syncCalibration / calibrationSweep）
  // 已整体迁至 views/fund-estimator.js；上方 createEstimator 已把同名绑定接回本作用域。
  // 相关阈值见 est.consts（EST_MIN_COVER / CALIB_MAX / CALIB_MIN_N / CALIB_HIT_PP / POS_CONC…）。
  // ---------- 持仓穿透（Look-through） ----------
  // 聚合逻辑（ensurePositions / buildLookThrough / buildOverlap）已迁至 views/fund-estimator.js
  // 并抽成**纯函数**：只吃「已算好市值的持仓行」，不读 F、不算净值——市值口径属于视图。
  // 这里只留唯一的适配器：把 F.holdings 经 calcHolding 折成带市值的行。
  // 无行情（hasData=false）或市值为 0 的持仓仍会出现在数组里，由聚合侧决定是否跳过
  // （穿透明细跳过它、重叠度仍可能纳入——保持与迁移前一致）。
  let lookLoaded = false;        // 穿透视图是否已自动加载过一次持仓（避免失败后反复重试）
  const lookRows = () => (F.holdings || []).map((h) => {
    const c = calcHolding(h, getQuote(h.code));
    return { code: h.code, name: h.name || h.code, market: c.hasData ? c.market : 0 };
  });

  // 「当日涨跌」口径裁决（shouldEstimate / dayPctOf）已随估值核心迁至 fund-estimator.js，
  // 由上方 createEstimator 解构接回同名绑定。
  async function fetchQuote(code) {
    const key = "q:" + code;
    const hit = cached(key, "quote");
    if (hit) return hit;

    try {
      // 主源：pingzhongdata（净值 + 日涨跌 + 净值趋势 + 名称）
      const js = await get(`https://fund.eastmoney.com/pingzhongdata/${encodeURIComponent(code)}.js`, REFERER_EM);
      const trend = extractVar(js, "Data_netWorthTrend") || [];
      const mName = /var\s+fS_name\s*=\s*"([^"]*)"/.exec(js);
      const name = mName ? mName[1] : "";
      const latest = trend[trend.length - 1];
      const prev = trend[trend.length - 2];
      const dwjz = latest ? num(latest.y, 0) : 0;
      const jzzzl = latest ? num(latest.equityReturn, 0) : 0; // 日涨跌 %
      // 净值日期：Data_netWorthTrend 的 x 是「本地零点」时间戳，必须用 ymd() 取本地自然日。
      // 用 toISOString().slice(0,10) 会在 GMT+8 整体前移一天（曾导致 navDate 恒比真实净值日早 1 天，
      // 进而让 dayPctOf 的「净值已覆盖行情日」判断失效——休市日/收盘后仍继续显示估算而非官方净值）。
      const date = latest ? ymd(new Date(num(latest.x, 0))) : "";
      // 股票占净比（最新报告期，%）——拟合估值用它把「股票部分涨幅」折算成全基金涨幅。
      // 用 Data_assetAllocation（报告期口径，与持仓明细同期）而非 Data_fundSharesPositions：
      // 后者口径不明（如 161725 给 74.62，而同期股票占净比实为 94.79），会显著低估弹性。
      let stockPos = 0;
      const allocRaw = /var\s+Data_assetAllocation\s*=\s*(\{[\s\S]*?\});/.exec(js);
      if (allocRaw) {
        try {
          const series = (JSON.parse(allocRaw[1]).series) || [];
          const s = series.find((x) => x && /股票/.test(String(x.name || "")));
          const arr = (s && s.data) || [];
          const v = arr.length ? Number(arr[arr.length - 1]) : NaN;
          if (Number.isFinite(v) && v > 0) stockPos = v;
        } catch (_) {}
      }

      // 盘中代理：代码与场内 ETF 相同（如 510300）→ 用 ETF 实时价估算
      let etf = null;
      if (ETF_PROXY[code] && isTradingNow()) {
        try { etf = await fetchSinaEtf(ETF_PROXY[code]); } catch (_) {}
      }
      let gszzl = jzzzl, gztime = date + " 净值", isEst = false;
      if (etf) {
        gszzl = etf.prevClose > 0 ? ((etf.price - etf.prevClose) / etf.prevClose) * 100 : jzzzl;
        gztime = etf.time || date;
        isEst = true;
      }
      // q.nav 永远是基金单位净值；q.gszzl 永远是估算涨跌%（ETF 代理仅用来补估算涨跌）
      const q = { code, name, dwjz, nav: dwjz, gszzl, gztime, isEst, navDate: date, stockPos };
      delete staleMemo[code]; // 新数据成功 → 清除失效标记
      storeCache("quote", key, q);
      return q;
    } catch (e) {
      // 接口失败：回退 STALE_WINDOW 内的旧净值，避免整个卡片显示 --
      const stale = cachedStale(key, "quote");
      if (stale) {
        staleMemo[code] = Date.now(); // 标记为"缓"（仅内存，不落盘）
        return Object.assign({}, stale.data, { stale: true, staleAt: stale.at, error: String(e && e.message || e) });
      }
      throw e;
    }
  }

  async function fetchHistory(code, points) {
    // 走势弹窗一次拉满近 1 年（约 250 个交易日），周期切换在本地切片，避免重复请求
    const n = points || HISTORY_POINTS;
    const key = "h:" + code + ":" + n;
    const hit = cached(key, "history");
    if (hit) return hit;
    try {
      const url = `https://api.fund.eastmoney.com/f10/lsjz?fundCode=${encodeURIComponent(code)}&pageIndex=1&pageSize=${n}&startDate=&endDate=`;
      const raw = await get(url, REFERER_F10);
      const json = JSON.parse(raw);
      const list = ((json && json.Data && json.Data.LSJZList) || []).map((r) => ({
        date: r.FSRQ,
        nav: num(r.DWJZ, 0),
        // 走势图与持仓页统一走 nav；dwjz 为旧字段名，保留做兼容（部分图表仍引用）
        dwjz: num(r.DWJZ, 0),
        accNav: num(r.LJJZ, 0),
        pct: r.JZZZL === "" ? null : num(r.JZZZL, 0),
      }));
      storeCache("history", key, list);
      return list;
    } catch (e) {
      const stale = cachedStale(key, "history");
      if (stale) return stale.data;
      throw e;
    }
  }
  // 走势弹窗用的一次性拉满（近 1 年），独立 key 避免污染其他消费方的历史缓存
  // 数据源：pingzhongdata 的 Data_netWorthTrend（一次返回全量，比 f10/lsjz 分页 13 次更稳）
  async function fetchHistoryFull(code) {
    const key = "hfull:" + code;
    const hit = cached(key, "history");
    if (hit) return hit;
    try {
      const js = await get(`https://fund.eastmoney.com/pingzhongdata/${encodeURIComponent(code)}.js?v=${Date.now()}`, REFERER_EM);
      const arr = extractVar(js, "Data_netWorthTrend");
      if (!Array.isArray(arr) || !arr.length) throw new Error("净值趋势数据为空");
      const list = arr
        .map((p) => {
          const d = new Date(num(p.x, 0));
          // 用本地时区格式化日期（中国东八区），避免 toISOString 的 UTC 日期偏移
          const y = d.getFullYear(), mo = String(d.getMonth() + 1).padStart(2, "0"), da = String(d.getDate()).padStart(2, "0");
          return {
            date: isFinite(d.getTime()) ? y + "-" + mo + "-" + da : "",
            nav: num(p.y, 0),
            dwjz: num(p.y, 0),
            pct: p.equityReturn === undefined || p.equityReturn === null || p.equityReturn === "" ? null : num(p.equityReturn, 0),
          };
        })
        .filter((r) => r.date && r.nav > 0);
      if (!list.length) throw new Error("净值趋势数据无效");
      storeCache("history", key, list);
      return list;
    } catch (e) {
      const stale = cachedStale(key, "history");
      if (stale) return stale.data;
      throw e;
    }
  }

  async function searchFund(kw) {
    const key = "s:" + kw;
    const hit = cached(key, "rank");
    if (hit) return hit;
    try {
      const url = `https://fundsuggest.eastmoney.com/FundSearch/api/FundSearchAPI.ashx?m=1&key=${encodeURIComponent(kw)}&t=0&sl=30&_=${Date.now()}`;
      const raw = await get(url, REFERER_EM);
      const json = JSON.parse(raw);
      const list = ((json && json.Datas) || [])
        .filter((d) => d && d.CODE && /^\d{6}$/.test(String(d.CODE)))
        .map((d) => ({ code: String(d.CODE), name: d.NAME, type: d.FTYPE || "" }));
      storeCache("rank", key, list);
      return list;
    } catch (e) {
      const stale = cachedStale(key, "rank");
      if (stale) return stale.data;
      throw e;
    }
  }

  function parseRankJson(raw) {
    const idx = raw.indexOf("{");
    if (idx < 0) throw new Error("排行接口返回格式异常");
    // 截取到匹配的闭合大括号（避免末尾 ; 等残留）
    let depth = 0, end = -1;
    for (let i = idx; i < raw.length; i++) {
      const ch = raw[i];
      if (ch === "{") depth++;
      else if (ch === "}") { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end < 0) throw new Error("排行接口返回未闭合");
    let s = raw.slice(idx, end + 1);
    // 兼容 JSONP 风格：接口属性名未加引号（datas: / allRecords: / isRise: …），
    // 老版本接口返回带引号的标准 JSON，这里统一规范化后再 parse
    s = s.replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*:)/g, (m, a, k, c) => a + "\"" + k + "\"" + c);
    return JSON.parse(s);
  }

  async function fetchRank(sort, ftype) {
    const key = "r:" + sort + ":" + ftype;
    const hit = cached(key, "rank");
    if (hit) return hit;
    try {
      const ft = ftype && ftype !== "all" ? ftype : "gp";
      const url = `https://fund.eastmoney.com/data/rankhandler.aspx?op=ph&dt=kf&ft=${encodeURIComponent(ft)}&rs=&gs=0&sc=${encodeURIComponent(sort)}&st=desc&pi=1&pn=50&fl=0&cp=1`;
      const raw = await get(url, REFERER_RANK);
      const json = parseRankJson(raw);
      const list = ((json && json.datas) || []).map((row) => {
        const c = String(row).split(",");
        return {
          code: c[0], name: c[1], pct: num(c[sortIdxOf(sort)], null),
          nav: num(c[4], 0), type: c[6] || "", accNav: num(c[5], 0),
        };
      });
      storeCache("rank", key, list);
      return list;
    } catch (e) {
      const stale = cachedStale(key, "rank");
      if (stale) return stale.data;
      throw e;
    }
  }

  // 排行 CSV 列索引（fundcode, name, pjz, jzzrq, dwjz, ljjz, rq, ...）
  const sortIdxOf = (s) => ({ "1nzf": 7, "1yzf": 8, "3yzf": 9, "6yzf": 10, "1jz": 11 })[s] || 7;

  // ---------- 指数行情（新浪 hq.sinajs.cn，混合 A股 / 港股 / 美股） ----------
  // 各市场返回格式不同，按代码前缀分别解析（见 parseIndexQuote）。
  const INDEXES = [
    { sym: "sh000001", name: "上证指数" },
    { sym: "sz399001", name: "深证成指" },
    { sym: "sz399006", name: "创业板指" },
    { sym: "sh000300", name: "沪深300" },
    { sym: "sh000905", name: "中证500" },
    { sym: "sh000688", name: "科创50" },
    { sym: "rt_hkHSI", name: "恒生指数" },
    { sym: "rt_hkHSTECH", name: "恒生科技" },
    { sym: "gb_ixic", name: "纳斯达克" },
    { sym: "gb_inx", name: "标普500" },
    { sym: "gb_dji", name: "道琼斯" },
  ];
  // 按前缀解析单条行情 → { name, price, prevClose, chg, pct, time }
  // A股  sh/sz ：名称,今开,昨收,现价,最高,最低,…（现价 idx3 / 昨收 idx2）
  // 港股 rt_hk：英文码,名称,今开,昨收,最高,最低,现价,涨跌额,涨跌幅,…（现价 idx6 / 涨跌额 idx7 / 涨跌幅 idx8）
  // 美股 gb_  ：名称,现价,涨跌幅,时间,涨跌额,今开,最高,最低,…（现价 idx1 / 涨跌幅 idx2 / 涨跌额 idx4）
  function parseIndexQuote(sym, p) {
    if (sym.startsWith("rt_hk")) {
      return {
        name: p[1], price: num(p[6], 0), prevClose: num(p[3], 0),
        chg: num(p[7], null), pct: num(p[8], null),
        time: [p[17], p[18]].filter(Boolean).join(" "),
      };
    }
    if (sym.startsWith("gb_")) {
      const price = num(p[1], 0), chg = num(p[4], null);
      return {
        name: p[0], price, chg, pct: num(p[2], null),
        prevClose: (price > 0 && chg !== null) ? price - chg : 0,
        time: p[3] || "",
      };
    }
    return {
      name: p[0], price: num(p[3], 0), prevClose: num(p[2], 0),
      chg: null, pct: null,
      time: [p[30], p[31]].filter(Boolean).join(" "),
    };
  }
  async function fetchIndexes() {
    const key = "idx";
    const hit = cached(key, "index");
    if (hit) return hit;
    const syms = INDEXES.map((i) => i.sym).join(",");
    // 注意一：新浪 hq.sinajs.cn 不解析 %2C，多代码必须用「原始逗号」分隔，
    //         否则整串被当成一个无效代码 → 响应无匹配行 → 误判为「指数行情加载失败」。
    // 注意二：该接口是「路径式」写法（/list=…，无 ? 号），任何后缀（如 &format=text）
    //         都会被并入「最后一个代码」，使末位指数静默丢失。默认返回即为 text 格式，
    //         故列表末尾不得追加任何 query 参数。
    const raw = await get(`https://hq.sinajs.cn/list=${syms}`, SINA_H);
    // 新浪返回 GBK，宿主 http_get 已解码为 UTF-8（名称由本地映射兜底）
    const list = [];
    for (const line of raw.split("\n")) {
      // 代码可能含大写与下划线（rt_hkHSI / gb_ixic），正则须涵盖
      const m = /hq_str_([A-Za-z0-9_]+)="([^"]*)"/.exec(line);
      if (!m) continue;
      const meta = INDEXES.find((i) => i.sym === m[1]);
      if (!meta) continue;
      const q = parseIndexQuote(meta.sym, m[2].split(","));
      const price = q.price;
      // 优先用行情自带涨跌，缺失时用昨收推算
      let pct = q.pct, chg = q.chg;
      if (pct === null && q.prevClose > 0) pct = ((price - q.prevClose) / q.prevClose) * 100;
      if (chg === null && q.prevClose > 0) chg = price - q.prevClose;
      // 价与涨跌额均有效才算有数据（新浪缺数据的指数会返回价=0），否则界面显示「暂无数据」
      const hasData = price > 0 && chg !== null;
      list.push({ name: q.name || meta.name, sym: meta.sym, price, chg, pct, hasData, time: q.time });
    }
    if (!list.length) throw new Error("指数行情加载失败");
    storeCache("index", key, list);
    return list;
  }

  // ---------- 基金主题（天天基金「主题基金」ztjj） ----------
  // 对标养基宝的「主题」口径：CRO / CPO / 黄金 / 创新药 这类基金主题，而非股票行业板块。
  // 注意：push2.eastmoney.com 对非浏览器客户端会被指纹拦截并静默断连（EOF），
  // 故改用主机可达的 api.fund.eastmoney.com（同一 BK 主题代码体系）。
  const THEME_PERIODS = [
    { id: "D", label: "今日" },
    { id: "W", label: "近1周" },
    { id: "M", label: "近1月" },
    { id: "Q", label: "近3月" },
    { id: "Y", label: "近1年" },
  ];
  const THEME_TYPES = [
    { id: "0", label: "全部" },
    { id: "001002", label: "行业" },
    { id: "001003", label: "概念" },
  ];
  const REFERER_THEME = { "Referer": "https://fund.eastmoney.com/ztjj/default.html" };
  // 返回：{ Data: [{ INDEXCODE, INDEXNAME, <st 字段> }] }；st 既是指标周期也是返回字段名。
  // 只保留 TOP12（按当前周期涨幅降序），控制缓存（会落 state.json）与渲染体积。
  async function fetchThemes(tt, st) {
    const key = tt + ":" + st;
    // 今日盘中变化快用 30s，其余周期 30min；只存内存，不落 state.json
    const ttl = st === "D" ? TTL_INDEX : TTL_RANK;
    const rec = themeMemo.get(key);
    if (rec && Date.now() - rec.at < ttl) return rec.data;
    try {
      const url = `https://api.fund.eastmoney.com/ztjj/GetZTJJListNew?tt=${encodeURIComponent(tt)}&dt=syl&st=${encodeURIComponent(st)}&pi=1&pn=500&_=${Date.now()}`;
      const raw = await get(url, REFERER_THEME);
      const j = JSON.parse(raw);
      // 返回全部主题（约：全部 182 / 行业 84 / 概念 98），按当前周期涨幅降序
      const list = ((j && j.Data) || [])
        .map((x) => ({ code: x.INDEXCODE, name: x.INDEXNAME, pct: num(x[st], null) }))
        .filter((x) => x.name && x.pct !== null && isFinite(x.pct))
        .sort((a, b) => b.pct - a.pct);
      if (!list.length) throw new Error("主题数据为空");
      themeMemo.set(key, { at: Date.now(), data: list });
      return list;
    } catch (e) {
      // 失败回退最近一次内存缓存（STALE_WINDOW 内）
      if (rec && Date.now() - rec.at < STALE_WINDOW) return rec.data;
      throw e;
    }
  }

  // ---------- 基金涨跌分布（全市场 · 天天基金排行接口 ft=all） ----------
  // 口径：全市场开放式基金（股票/混合/指数/债券/QDII/FOF，约 2.46 万只），
  //      按「日增长率」分档计数 —— 与养基宝「基金涨跌分布」同一口径。
  // 注意：该接口给的是**净值口径**（每日盘后公布），盘中拿到的是上一交易日净值，
  //      不是实时估值。所以界面必须标注净值日期（见 #fund-dist-src），不可省略。
  const DIST_BUCKETS = [
    { label: "≤-5%", from: -Infinity, to: -5 },
    { label: "-5~-3%", from: -5, to: -3 },
    { label: "-3~-2%", from: -3, to: -2 },
    { label: "-2~-1%", from: -2, to: -1 },
    { label: "-1~0%", from: -1, to: 0 },
    { label: "0%", from: 0, to: 0 },
    { label: "0~1%", from: 0, to: 1 },
    { label: "1~2%", from: 1, to: 2 },
    { label: "2~3%", from: 2, to: 3 },
    { label: "3~5%", from: 3, to: 5 },
    { label: "≥5%", from: 5, to: Infinity },
  ];
  // 单页 5000 条 ≈ 730KB / 1.6~4.8s；5 页并发共 25000 条 ≥ 全市场 24630 只。
  // 宿主 http_get 为 async + spawn_blocking，可安全并发；单次响应上限 5MB，未触顶。
  const DIST_PN = 5000;
  const DIST_PAGES = 5;
  // —— 容错参数（用法见 settleWithin / fetchDistribution）——
  // 单路尝试次数：get 的默认值只有 2 次，而「5 路里总有一路抖」是常态，故提到 3 次。
  const DIST_TRIES = 3;
  // 整批软截止：超过此时长仍未返回的页按失败计，避免一路拖到 3×12s 才收尾。
  const DIST_DEADLINE = 22 * 1000;
  // 残缺结果（缺页）的复用窗口：缺页数据仍会自愈重取，但 60s 内不重复打 5 路请求。
  const DIST_PARTIAL_TTL = 60 * 1000;
  // sc=rzdf 为「日增长率」，返回行 CSV 第 7 列（idx6）即日涨跌幅
  function rankPageUrl(pi, pn) {
    return "https://fund.eastmoney.com/data/rankhandler.aspx?op=ph&dt=kf&ft=all"
      + `&rs=&gs=0&sc=rzdf&st=desc&pi=${pi}&pn=${pn}&fl=0&cp=1`;
  }
  // —— 软截止并发：把「一票否决」换成「部分成功可用」——
  // Promise.all 只要有一路 reject 就整体失败，前面已取到的页全部作废；而 5 路里
  // 总有一路会抖（实测单页最长 6.2s，逼近 12s/15s 双层超时）。这里改为：
  //   ① 任一路失败只标记该槽位，不影响其余；
  //   ② 超过 ms 仍未 settle 的页同样标记为空（按失败计），保证调用侧一定收尾；
  //   ③ 本函数自身 never reject，失败信息随槽位返回，由调用侧决定是否降级。
  // 返回：与入参等长的数组，元素为 { ok:true, value } / { ok:false, error } / null(超时未回)。
  function settleWithin(promises, ms) {
    return new Promise((resolve) => {
      const out = new Array(promises.length).fill(null);
      if (!promises.length) { resolve(out); return; }
      let left = promises.length;
      const timer = setTimeout(() => resolve(out), ms);
      const done = () => { if (--left === 0) { clearTimeout(timer); resolve(out); } };
      promises.forEach((p, i) => {
        Promise.resolve(p).then(
          (v) => { out[i] = { ok: true, value: v }; },
          (e) => { out[i] = { ok: false, error: e }; }
        ).then(done, done);
      });
    });
  }
  // 从 settleWithin 的结果里挑出可用页，并给出覆盖率。
  // 纯函数（不碰网络 / 缓存 / DOM），便于离线校验「部分成功」这条主路径；
  // 保持入参下标顺序，使跨页去重仍然优先保留靠前页（与改造前的 Promise.all 一致）。
  function pagesOf(settled, total) {
    const raws = [];
    let firstErr = null;
    for (const s of settled || []) {
      if (s && s.ok && typeof s.value === "string" && s.value) raws.push(s.value);
      else if (!firstErr && s && s.error) firstErr = s.error;
    }
    return {
      raws, firstErr,
      pagesOk: raws.length,
      pagesTotal: total,
      // 部分成功同样出结果，但必须由界面显式声明缺了几页（否则会被误认成数据完整）
      partial: raws.length < total,
    };
  }
  // 纯聚合：把（可能不完整的分页）原始文本 → 分布统计。与网络层解耦，便于离线校验。
  function tallyDistribution(raws) {
    const counts = DIST_BUCKETS.map(() => 0);
    const seen = new Set();     // 分页边界可能重叠，按基金代码去重
    const dateTally = {};       // 净值日期计数（取众数作为展示日期）
    let up = 0, down = 0, flat = 0, skipped = 0;
    for (const raw of raws) {
      // 行格式：code,name,pinyin,净值日期,单位净值,累计净值,日增长率,…
      for (const m of String(raw || "").matchAll(/"(\d{6}),[^"]*"/g)) {
        const c = m[0].split(",");
        const code = c[0].slice(1);
        if (seen.has(code)) continue;
        seen.add(code);
        // 次新/未建仓/暂停披露的基金日增长率为空串，必须显式跳过：
        // num("") 会退化成 0，若不过滤会全部被误计入「平盘」档（实测末页有 883 条）。
        const s6 = String(c[6] == null ? "" : c[6]).trim();
        if (!s6) { skipped++; continue; }
        const v = num(s6, null);
        if (v === null) { skipped++; continue; }
        const dt = (c[3] || "").trim();
        if (dt) dateTally[dt] = (dateTally[dt] || 0) + 1;
        if (v > 0) up++; else if (v < 0) down++; else flat++;
        for (let i = 0; i < DIST_BUCKETS.length; i++) {
          const b = DIST_BUCKETS[i];
          if (b.from === 0 && b.to === 0) { if (v === 0) { counts[i]++; break; } }
          else if (v >= b.from && v < b.to) { counts[i]++; break; }
        }
      }
    }
    let date = "", best = 0;
    for (const k of Object.keys(dateTally)) if (dateTally[k] > best) { best = dateTally[k]; date = k; }
    const total = up + down + flat;
    return {
      date, total, up, down, flat, skipped, unique: seen.size,
      buckets: DIST_BUCKETS.map((b, i) => ({ label: b.label, count: counts[i] })),
      max: Math.max(1, ...counts),
    };
  }
  // 返回 { date, total, up, down, flat, buckets:[{label,count}], max,
  //        pagesOk, pagesTotal, partial }
  // partial=true 表示部分页失败/超时，计数为「偏样」（接口按日增长率降序，
  // 缺页会截掉跌幅端），界面必须显式标注，不可当作全市场口径展示。
  async function fetchDistribution() {
    const key = "dist";
    const rec = cachedRec(key, "rank");
    const hit = cached(key, "rank");
    // 完整结果直接复用；残缺结果只在 DIST_PARTIAL_TTL 内复用，
    // 否则会被 TTL_RANK(30min) 把「缺页数据」固化成完整数据（网络恢复后也不刷新）。
    if (hit && (!hit.partial || (rec && Date.now() - rec.at < DIST_PARTIAL_TTL))) return hit;
    try {
      const tasks = Array.from({ length: DIST_PAGES }, (_, i) =>
        get(rankPageUrl(i + 1, DIST_PN), REFERER_RANK, DIST_TRIES));
      const pages = pagesOf(await settleWithin(tasks, DIST_DEADLINE), DIST_PAGES);
      if (!pages.pagesOk) {
        throw pages.firstErr || new Error(`${DIST_PAGES} 页全部超时未返回`);
      }
      const data = tallyDistribution(pages.raws);
      if (!data.total) throw new Error("涨跌分布数据为空");
      data.pagesOk = pages.pagesOk;
      data.pagesTotal = pages.pagesTotal;
      data.partial = pages.partial;
      // 残缺结果同样落缓存：一是供 cachedStale 兜底（好过白屏），
      // 二是由上面的 DIST_PARTIAL_TTL 窗口限制重取频率（避免降级期间反复打 5 路请求）。
      storeCache("rank", key, data);
      return data;
    } catch (e) {
      const stale = cachedStale(key, "rank");
      if (stale) return stale.data;
      throw e;
    }
  }

  // 分布图：红=涨 / 绿=跌 / 灰=平盘（A 股惯例），柱高按最大档归一化
  function distHTML(d) {
    if (!d) return `<div class="fund-empty">加载中…</div>`;
    if (!d.total) return `<div class="fund-empty">暂无涨跌分布数据</div>`;
    const ratio = d.down > 0 ? (d.up / d.down) : null;
    const bars = d.buckets.map((b, i) => {
      const zero = DIST_BUCKETS[i] && DIST_BUCKETS[i].from === 0 && DIST_BUCKETS[i].to === 0;
      const neg = DIST_BUCKETS[i] && DIST_BUCKETS[i].to <= 0 && !zero;
      const tone = zero ? "flat" : (neg ? "down" : "up");
      const h = b.count ? Math.max(1.2, (b.count / d.max) * 100) : 0;
      // 数量标签跟随柱顶（bottom = 柱高 + 5px），而不是固定在图表顶行：
      // 否则矮柱的数字悬在半空，容易与相邻高柱产生误读
      return `
        <div class="dist-col">
          <div class="dist-bar-wrap">
            ${h ? `<div class="dist-bar ${tone}" style="height:${h.toFixed(2)}%"></div>
            <div class="dist-num" style="bottom:calc(${h.toFixed(2)}% + 5px)">${b.count}</div>` : ""}
          </div>
          <div class="dist-x">${esc(b.label)}</div>
        </div>`;
    }).join("");
    // 部分页失败/超时必须显式声明：接口按「日增长率降序」返回，缺页截掉的是跌幅端，
    // 柱子形状会失真 —— 不标注就会被当成完整分布读（技能文档已明确要求「部分成功要显式说明缺了几条」）。
    const gap = d.partial
      ? `<div class="dist-warn">仅取到 ${d.pagesOk}/${d.pagesTotal} 页 · 缺页截掉跌幅端，分布为偏样，仅作参考</div>`
      : "";
    return `
      ${gap}
      <div class="dist-stats">
        <span class="dist-stat"><b class="up">${d.up}</b><em>只上涨</em></span>
        <span class="dist-stat"><b class="down">${d.down}</b><em>只下跌</em></span>
        <span class="dist-stat"><b class="flat">${d.flat}</b><em>只平盘</em></span>
        ${ratio === null ? "" : `<span class="dist-stat dist-ratio"><em>涨跌比</em><b>${ratio.toFixed(2)}</b></span>`}
      </div>
      <div class="dist-chart">${bars}</div>`;
  }

  function calcHolding(h, q) {
    const shares = num(h.shares, 0);
    const cost = num(h.cost, 0);
    const nav = q ? num(q.nav ?? q.dwjz, 0) : 0;
    const prev = q ? num(q.dwjz, 0) : 0;
    // 市值一律自动计算：市值 = 净值 × 份额
    // 无有效净值（行情未加载 / 接口失败）时标记 hasData=false，
    // 界面显示「--」而不是把市值当成 0 得出 -100% 的假盈亏
    const hasData = nav > 0;
    const market = nav * shares;
    // 当日涨跌：场内 ETF > 重仓拟合估算 > 最新净值日涨跌（见 dayPctOf）
    const dp = dayPctOf(h.code, q);
    const pct = dp.pct;
    const hasPct = hasData && pct !== null && isFinite(pct);
    // 日盈亏 = 昨日市值 × 涨跌%。净值口径下 market 已是「今日市值」，需先反推昨日市值；
    // 估算口径下 nav 仍是昨日净值，market 本身就是昨日市值。
    const prevMarket = dp.src === "nav" ? market / (1 + pct / 100) : market;
    const dayProfit = hasPct ? (prevMarket * pct) / 100 : (hasData ? (nav - prev) * shares : 0);
    const totalProfit = hasData ? market - cost : 0;
    const dayPct = hasPct ? pct : (hasData && prev > 0 ? ((nav - prev) / prev) * 100 : 0);
    const totalPct = hasData && cost > 0 ? (totalProfit / cost) * 100 : 0;
    return { shares, cost, nav, prev, market, dayProfit, totalProfit, dayPct, totalPct, hasData,
             daySrc: dp.src, dayEst: dp.est || null, hasFixed: false };
  }

  // ---------- CSV 导出 ----------
  // 导出的是「给人看、也能被 Excel / Numbers / pandas 直接吃」的表：
  // 数值列一律输出**纯数字**（不带 + 号、不带千分位、不带 %），百分比只体现在列名里 ——
  // 否则 "+1.23" 与 "1,234.56" 会被表格软件当文本，排序和求和当场失效。
  // 三个必须处理的细节：
  //   1) **UTF-8 BOM**：简体中文 Windows 的 Excel 默认按 GBK 解析 CSV，不加 BOM 中文全是乱码；
  //   2) **CRLF**：Excel 的传统换行（LF 也能读，CRLF 更稳）；
  //   3) **公式注入防护**：以 = + @ 开头的**文本**单元格会被 Excel 当公式执行（OWASP CSV Injection），
  //      前面补一个半角单引号让它按文本处理。数值通路不做此处理（负号是合法数字前缀）。
  const DAY_SRC_LABEL = { nav: "最新净值", fit: "重仓拟合估算", etf: "场内ETF实时价" };

  function csvCell(v) {
    if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
    if (v === null || v === undefined) return "";
    let s = String(v);
    if (/^[=+@]/.test(s) || (/^-/.test(s) && !/^-?[\d.]/.test(s))) s = "'" + s;
    // 含分隔符 / 引号 / 换行 → 整体用双引号包裹，内部引号翻倍（RFC 4180）
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }
  function csvText(header, rows) {
    return "\uFEFF" + [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
  }
  // 保留 n 位小数后回到 number：避免 0.1+0.2 那种长尾浮点被当成「精度」导出。
  // 刻意不用 num()：`num("")` 返回 0（Number("") === 0），会把「没有这个字段」导成 0，
  // 而导出场景里空 = 不适用（分红没有份额、无净值时不写市值），写成 0 是错误信息。
  function rnd(v, n) {
    if (v === null || v === undefined || v === "") return "";
    const x = Number(v);
    return Number.isFinite(x) ? Number(x.toFixed(n)) : "";
  }
  // 统一落盘：走宿主的「另存为」对话框（与「笔记 → 导出 Markdown」共用 export_text_file）
  async function saveCSV(defaultName, content) {
    try {
      const saved = await invoke("export_text_file", {
        defaultName,
        content,
        filterName: "CSV 表格",
        extensions: ["csv"],
      });
      if (!saved) { toast("已取消导出"); return; }
      toast(`已导出 ${String(saved).split(/[\\/]/).pop()}`);
    } catch (e) {
      console.error("[fund] 导出 CSV 失败", e);
      toast("导出失败，请重试");
    }
  }
  const csvStamp = () => ymd(new Date());

  // 持仓账本：与界面同口径（盘中「当日收益」是估算值），另附「当日口径」列说明这个数字从哪来，
  // 免得下游拿到一列估算值却以为它是官方净值涨跌
  async function exportHoldingsCSV() {
    const sum = computeHoldSummary();
    if (!sum.holdings.length) { toast("还没有持仓记录，无可导出内容"); return; }
    const rows = sum.holdings.map((h) => {
      const q = getQuote(h.code);
      const c = sum.hq[h.id] || calcHolding(h, q);
      return [
        h.code, h.name || "",
        rnd(c.shares, 2), rnd(h.unitCost, 4), rnd(c.cost, 2),
        c.hasData ? rnd(c.nav, 4) : "", (q && q.navDate) || "",
        c.hasData ? rnd(c.market, 2) : "",
        c.hasData ? rnd(c.dayPct, 2) : "", c.hasData ? rnd(c.dayProfit, 2) : "",
        c.hasData ? (DAY_SRC_LABEL[c.daySrc] || c.daySrc) : "",
        c.hasData ? rnd(c.totalProfit, 2) : "", c.hasData ? rnd(c.totalPct, 2) : "",
      ];
    });
    const header = ["基金代码", "基金名称", "持有份额", "单位成本", "持仓成本", "最新净值", "净值日期",
      "持仓市值", "当日涨跌幅%", "当日收益", "当日口径", "累计盈亏", "累计收益率%"];
    await saveCSV(`基金持仓_${csvStamp()}.csv`, csvText(header, rows));
  }

  // 交易流水：账本内数组是「新→旧」（写入用 unshift），导出翻成**按日期升序**，
  // 方便在表格里直接拉时间轴。份额/净值对分红不适用，留空而不是写 0（写 0 会被误读成「0 份成交」）
  async function exportTradesCSV() {
    const trades = F.trades || [];
    if (!trades.length) { toast("还没有交易流水，无可导出内容"); return; }
    const rows = trades.slice().reverse().map((t) => {
      const tt = TRADE_TYPES[t.type] || { label: t.type || "" };
      const plan = t.planId ? (F.plans || []).find((p) => p.id === t.planId) : null;
      const isDiv = t.type === "div";
      return [
        t.date || "", tt.label, t.code || "", t.name || "",
        rnd(t.amount, 2), isDiv ? "" : rnd(t.shares, 2), isDiv ? "" : rnd(t.nav, 4), rnd(t.fee, 2),
        t.auto ? "是" : "", plan ? planDayLabel(plan) : "", t.note || "",
      ];
    });
    const header = ["日期", "类型", "基金代码", "基金名称", "金额", "份额", "净值", "手续费",
      "定投自动记账", "定投周期", "备注"];
    await saveCSV(`基金交易流水_${csvStamp()}.csv`, csvText(header, rows));
  }

  // 定投计划：收益口径与卡片一致（只统计该计划自动记账产生的申购），年化沿用 XIRR 的「无意义则留空」规则
  async function exportPlansCSV() {
    const plans = F.plans || [];
    if (!plans.length) { toast("还没有定投计划，无可导出内容"); return; }
    const rows = plans.map((p) => {
      const st = planStats(p);
      const off = p.enabled === false;
      return [
        p.code, p.name || "", planDayLabel(p),
        rnd(p.amount, 2), rnd(planMonthlyAmount(p), 0),
        p.startDate || "", off ? "已暂停" : "进行中",
        st.count, rnd(st.invested, 2), rnd(st.shares, 2), rnd(st.avgCost, 4),
        st.hasData ? rnd(st.market, 2) : "", st.hasData ? rnd(st.profit, 2) : "",
        st.hasData && st.pct !== null ? rnd(st.pct, 2) : "",
        st.annual === null || st.annual === undefined ? "" : rnd(st.annual, 2),
        off ? "" : planNextDate(p),
      ];
    });
    const header = ["基金代码", "基金名称", "周期", "每期金额", "每月合计", "起始日期", "状态",
      "已投期数", "累计投入", "累计份额", "平均成本", "当前市值", "累计收益", "收益率%", "年化%", "下次扣款日"];
    await saveCSV(`基金定投计划_${csvStamp()}.csv`, csvText(header, rows));
  }

  // ---------- DOM 骨架 ----------
  body.innerHTML = `
      <div class="fund-wrap">
        <div class="fund-head">
          <div class="fund-tabs">
            <button class="fund-tab active" data-tab="overview">总览</button>
            <button class="fund-tab" data-tab="wh">自选持仓</button>
            <button class="fund-tab" data-tab="rank">市场排行</button>
            <button class="fund-tab" data-tab="search">基金搜索</button>
          </div>
          <div class="fund-head-actions">
            <button class="btn-ghost" id="fund-refresh" title="刷新行情">刷新</button>
            <button class="btn" id="fund-add-watch" title="添加自选基金">添加自选</button>
          </div>
        </div>
        <div class="fund-status" id="fund-status" hidden></div>
        <div class="fund-panel" id="fund-panel-overview"></div>
        <div class="fund-panel" id="fund-panel-wh" hidden></div>
        <div class="fund-panel" id="fund-panel-rank" hidden></div>
        <div class="fund-panel" id="fund-panel-search" hidden></div>
      </div>`;

  const statusEl = body.querySelector("#fund-status");
  const panelOverview = body.querySelector("#fund-panel-overview");
  const panelWH = body.querySelector("#fund-panel-wh");
  const panelRank = body.querySelector("#fund-panel-rank");
  const panelSearch = body.querySelector("#fund-panel-search");
  const tabBtns = body.querySelectorAll(".fund-tab");
  let searchInputEl = null;
  let whSub = "watch";
  let whBody = null;
  // 依赖实时行情的子页签：心跳刷新时才需要整体重建。
  // 收益曲线（历史净值 + 本地流水）、交易流水（本地数据）与行情无关，
  // 重建只会让曲线闪一次「加载中…」，故不列入。
  const WH_LIVE_SUBS = new Set(["watch", "hold", "look", "plans"]);

  // ---------- 定投计划：日期推算 / 按扣款日取净值 / 自动记账 / 收益统计 ----------
  // 日期统一按「本地自然日」处理（不用 toISOString，避免 UTC 偏移把扣款日挪一天）
  function ymd(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  function parseYmd(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s == null ? "" : s).trim());
    if (!m) return null;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return isNaN(d.getTime()) ? null : d;
  }
  // 今天（本地自然日零点）。定投里所有「今天 / 已过去」的判断都走这里，避免各处自己 new Date()
  // 后口径不一（也便于单测替换锚点）。
  function todayDate() { const t = new Date(); return new Date(t.getFullYear(), t.getMonth(), t.getDate()); }
  function todayStr() { return ymd(todayDate()); }
  // 取两个日期串中较晚的一个（空串 / 非法值一律视为「无约束」）。
  // YYYY-MM-DD 的字典序即时间序，可直接比大小，不必来回 parse。
  function laterYmd(a, b) {
    const x = parseYmd(a) ? a : "", y = parseYmd(b) ? b : "";
    if (!x) return y;
    if (!y) return x;
    return x > y ? x : y;
  }
  // 周期取值一律走这里：只接受 PLAN_CYCLES 里的 id，其余一律退化为「每月」。
  // 历史 bug：对话框保存时写成 `cycEl.value === "week" ? "week" : "month"` —— 白名单里漏了 "day"，
  // 于是「每日」被静默存成「每月 1 日」，**整个日定投在 UI 上根本创建不出来**。
  // 这种「枚举白名单漏项」不该靠人眼盯，故抽成纯函数并由 check_plans 钉住。
  function planCycleOf(v) {
    const id = String(v == null ? "" : v);
    return PLAN_CYCLES.some((c) => c.id === id) ? id : "month";
  }
  // 扣款日的可读文本
  function planDayLabel(plan) {
    if (plan.cycle === "day") return "每日";
    if (plan.cycle === "week") {
      const i = Math.min(7, Math.max(1, num(plan.day, 1))) - 1;
      return `每${PLAN_WEEKDAYS[i] || "周一"}`; // 周一 → 每周一
    }
    return `每月 ${Math.min(28, Math.max(1, num(plan.day, 1)))} 日`;
  }
  // 下次扣款日（用于卡片文案）：严格晚于今天的第一期。
  // 今天及之前该记未记的期次由「待扣款 N 期」徽标表达，两者分工明确 ——
  // 若这里也报待扣款里最早的一期，会出现「下次扣款 2026-09-15」这种过去日期。
  // 起点抬到明天同时解决「老计划枚举被 PLAN_MAX_CATCHUP 从历史上截断」的问题
  // （旧实现伪造 lastPaidDate 就是为绕这个，代价是把今天已记账的期次又报了一次）。
  function planNextDate(plan) {
    const today = todayDate();
    // 明天用「日期 +1」推，不用 +24h 毫秒（有夏令时的时区会差一小时 → 可能落到今天）
    const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
    const from = laterYmd(plan.runFrom, ymd(tomorrow));
    const rest = planDueDates({ ...plan, runFrom: from }, new Date(today.getTime() + 400 * 24 * 3600 * 1000));
    return rest.length ? rest[0] : "";
  }
  // 计划对象的「解析边界」：从持久化状态读进来时，一次性把字段收敛到合法域。
  // 之后所有读取点（planDueDates / planDayLabel / planMonthlyAmount / runDuePlans）都可直接信任
  // plan.cycle —— 不必在每处再防一次「未知周期」，也不会再走 planDueDates 的 else 分支被当成「每月」。
  // 历史教训：周期枚举曾有一份手写白名单漏掉 "day"，把用户选的「每日」静默存成「每月 1 日」。
  // 白名单已收敛为 PLAN_CYCLES + planCycleOf（写入侧），这里再兜住**存量数据**（读取侧）。
  // 注意：这里只做「值域收敛」，不猜语义 —— 存量 cycle:"month" 与真正的月投无法区分，
  // 不做自动迁移；用户把该计划改一次（对话框已修好）即可自愈。
  function normalizePlans(list) {
    if (!Array.isArray(list)) return [];
    return list
      .filter((p) => p && typeof p === "object" && !Array.isArray(p))
      .map((p) => {
        p.cycle = planCycleOf(p.cycle);
        const d = Math.round(num(p.day, 1));
        p.day = p.cycle === "week" ? Math.min(7, Math.max(1, d))
          : p.cycle === "day" ? 1
            : Math.min(28, Math.max(1, d));
        p.amount = num(p.amount, 0);
        if (typeof p.startDate !== "string") p.startDate = "";
        if (typeof p.runFrom !== "string") p.runFrom = "";
        if (typeof p.lastPaidDate !== "string") p.lastPaidDate = "";
        if (typeof p.enabled !== "boolean") p.enabled = p.enabled !== false;
        return p;
      });
  }
  // 应扣款日：枚举起点之后、<= until 的期次（升序）。纯计算，无到期时零开销。
  // limit：本次枚举的期数上限，默认 PLAN_MAX_CATCHUP（防一次性写入过多流水）。
  //
  // 枚举起点取三重下限的最大值，缺一不可：
  //   ① startDate        —— 少了它，把起投日改晚后会枚举出起投日之前的「幽灵期次」并补记成申购；
  //   ② runFrom 起算日    —— 少了它，暂停期间累积的期次会在恢复的瞬间被一次性补记；
  //   ③ lastPaidDate + 1 —— 少了它，已记账的期次会被重复记账。
  // runFrom 对老数据（无此字段）为「无约束」，行为与旧版一致。
  function planDueDates(plan, until, limit) {
    const cap = limit === undefined ? PLAN_MAX_CATCHUP : limit;
    const start = parseYmd(plan.startDate);
    if (!start) return [];
    let from = start;
    const rf = parseYmd(plan.runFrom);
    if (rf && rf > from) from = rf;
    const last = parseYmd(plan.lastPaidDate);
    if (last) {
      const next = new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1);
      if (next > from) from = next;
    }
    const out = [];
    if (plan.cycle === "day") {
      // 每个交易日扣款：周末不生成（法定节假日由 runDuePlans 按净值是否存在跳过）
      let d = new Date(from.getFullYear(), from.getMonth(), from.getDate());
      while (d <= until && out.length < cap) {
        const wd = d.getDay();
        if (wd !== 0 && wd !== 6) out.push(ymd(d));
        d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
      }
    } else if (plan.cycle === "week") {
      const wd = Math.min(7, Math.max(1, num(plan.day, 1))); // 1=周一 … 7=周日
      let d = new Date(from.getFullYear(), from.getMonth(), from.getDate());
      const cur = d.getDay() === 0 ? 7 : d.getDay();
      d.setDate(d.getDate() + (wd - cur));
      if (d < from) d.setDate(d.getDate() + 7);
      while (d <= until && out.length < cap) {
        out.push(ymd(d));
        d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 7);
      }
    } else {
      // 每月 1~28 日（下拉限定在 28 以内，规避 29-31 日在部分月份不存在）
      const day = Math.min(28, Math.max(1, num(plan.day, 1)));
      let y = from.getFullYear(), m = from.getMonth();
      let d = new Date(y, m, day);
      if (d < from) { m++; if (m > 11) { m = 0; y++; } d = new Date(y, m, day); }
      while (d <= until && out.length < cap) {
        out.push(ymd(d));
        m++; if (m > 11) { m = 0; y++; }
        d = new Date(y, m, day);
      }
    }
    return out;
  }
  // 单个计划「已到期但未记账」的期次（净值取不到时会残留，界面据此显示待扣款 / 角标）。
  // 暂停中的计划一律返回空 —— 暂停期间本就不会扣款，若照常报「待扣款」，
  // 角标会和卡片的「已暂停」标签自相矛盾。
  function planPendingDates(plan) {
    if (plan.enabled === false) return [];
    return planDueDates(plan, todayDate());
  }

  // 全量历史单位净值序列（pingzhongdata 的 Data_netWorthTrend，一次请求可取任意日期）。
  // 只用于按日期查单点，不落缓存：几千点 × N 只基金会把 state.json 撑大。
  async function fetchNavSeries(code) {
    const js = await get(`https://fund.eastmoney.com/pingzhongdata/${code}.js?v=${Date.now()}`, REFERER_EM);
    const arr = extractVar(js, "Data_netWorthTrend");
    if (!Array.isArray(arr) || !arr.length) return null;
    const list = arr
      // 同时保留官方日增长率（equityReturn）：估算精度校准要拿它当「实际值」，
      // 与 fetchQuote 的 gszzl / 账本净值口径的当日涨跌同源。
      .map((p) => ({
        t: num(p.x, 0),
        nav: num(p.y, 0),
        ret: p.equityReturn === undefined || p.equityReturn === null || p.equityReturn === "" ? NaN : Number(p.equityReturn),
      }))
      .filter((p) => p.t > 0 && p.nav > 0);
    return list.length ? list : null;
  }
  // 序列中「dateStr 当天或之后最近一个交易日」的净值（定投遇非交易日顺延到**下一交易日**）。
  // 方向为什么是向后：扣款日当天没有净值（周末 / 节假日）时，能真正成交的是下一个交易日，
  // 用它的净值记账，于是「流水日期 == 所用净值的日期 == 真实交易日」三者天然一致。
  // 旧实现向前取（用前一交易日净值记账、流水日期仍写扣款日），后果是账本里出现
  // 非交易日的定投流水（周末 / 国庆），且日期与净值对不上（可能落到上一个月）。
  // 返回 null = 序列里还没有 >= dateStr 的交易日（当天净值未公布 / 尚未顺延到位）→ 调用方等待重试。
  function navAtOrAfter(series, dateStr) {
    const target = parseYmd(dateStr);
    if (!target || !Array.isArray(series) || !series.length) return null;
    const start = target.getTime();
    for (const p of series) {
      if (p.t >= start) return { nav: p.nav, date: ymd(new Date(p.t)) };
    }
    return null; // 序列按时间升序，走到这里说明序列最新一天仍早于扣款日
  }

  // 年化收益率（XIRR）：二分法求 Σ amount_i / (1+r)^((t_i-t_0)/365) = 0
  // 要求现金流同时含正负、且样本足够（期数少 / 跨度短时年化会被放大成无意义数字，调用方过滤）
  function xirr(flows) {
    if (!Array.isArray(flows) || flows.length < 2) return null;
    const fs2 = flows.slice().sort((a, b) => a.ts - b.ts);
    if (!fs2.some((f) => f.amount < 0) || !fs2.some((f) => f.amount > 0)) return null;
    const t0 = fs2[0].ts;
    const YEAR = 365 * 24 * 3600 * 1000;
    const npv = (r) => fs2.reduce((s, f) => s + f.amount / Math.pow(1 + r, (f.ts - t0) / YEAR), 0);
    let lo = -0.9999, hi = 10;
    let flo = npv(lo), root = null;
    if (!isFinite(flo) || !isFinite(npv(hi)) || flo * npv(hi) > 0) return null;
    for (let i = 0; i < 120; i++) {
      const mid = (lo + hi) / 2;
      const fm = npv(mid);
      if (!isFinite(fm)) return null;
      if (Math.abs(fm) < 1e-7) { root = mid; break; }
      if (flo * fm <= 0) hi = mid; else { lo = mid; flo = fm; }
    }
    if (root === null) root = (lo + hi) / 2;
    return root * 100;
  }

  // 计划维度统计：只统计「该计划产生的」买入流水（口径干净、可解释）。
  // 赎回/分红属于账户层面操作，不计入计划收益，界面上会标注这一点。
  function planStats(plan) {
    const ts = (F.trades || []).filter((t) => t.planId === plan.id && t.type === "buy");
    let invested = 0, shares = 0;
    const flows = [];
    let firstTs = 0;
    for (const t of ts) {
      const a = num(t.amount, 0), s = num(t.shares, 0);
      invested += a; shares += s;
      const d = parseYmd(t.date);
      if (d) {
        flows.push({ ts: d.getTime(), amount: -a });
        if (!firstTs || d.getTime() < firstTs) firstTs = d.getTime();
      }
    }
    const q = getQuote(plan.code);
    const nav = q ? num(q.nav ?? q.dwjz, 0) : 0;
    const market = nav > 0 ? nav * shares : 0;
    const hasData = nav > 0 && shares > 0;
    const profit = hasData ? market - invested : null;
    const pct = hasData && invested > 0 ? (profit / invested) * 100 : null;
    // 年化：把当前市值当作期末正现金流
    let annual = null;
    const spanDays = firstTs ? (Date.now() - firstTs) / (24 * 3600 * 1000) : 0;
    if (hasData && flows.length >= PLAN_XIRR_MIN_FLOWS && spanDays >= PLAN_XIRR_MIN_DAYS) {
      annual = xirr(flows.concat([{ ts: Date.now(), amount: market }]));
    }
    return { count: ts.length, invested, shares, avgCost: shares > 0 ? invested / shares : 0, nav, market, hasData, profit, pct, annual };
  }

  let plansRunning = false;
  // 定投取净值序列用的短时缓存。runDuePlans 由 30s 心跳驱动，而在「扣款日=今天、净值还没公布」
  // 的那段时间里它每轮都要看一眼序列；序列接口带 ?v= 时间戳（等效不缓存），若不加这层，
  // 一整天会每 30 秒重下一份几百 KB 的全量净值。10 分钟粒度足够：净值公布最多晚 10 分钟入账。
  const PLAN_NAV_TTL = 10 * 60 * 1000;
  const PLAN_NAV_MAX = 50; // 兜底上限，防止长期运行后 Map 无限增长（Map 保持插入序）
  const navSeriesMemo = new Map();
  async function navSeriesCached(code) {
    const hit = navSeriesMemo.get(code);
    if (hit && Date.now() - hit.at < PLAN_NAV_TTL) return hit.list;
    let list = null;
    try { list = await fetchNavSeries(code); } catch (_) { list = null; }
    if (list) {
      navSeriesMemo.delete(code);
      navSeriesMemo.set(code, { at: Date.now(), list });
      while (navSeriesMemo.size > PLAN_NAV_MAX) navSeriesMemo.delete(navSeriesMemo.keys().next().value);
    }
    return list;
  }
  // 自动记账：到期即按「扣款日当天的净值」入账（扣款日遇非交易日顺延到**下一交易日**，用该日净值）。
  // 幂等靠 plan.lastPaidDate；净值取不到时保留待扣款、下次重试（绝不写入错误账目）。
  // 期数以流水为准（planStats().count），不再维护 paidCount 这类会与流水漂移的冗余计数。
  async function runDuePlans() {
    if (plansRunning) return;
    const plans = (F.plans || []).filter((p) => p && p.enabled !== false && /^\d{6}$/.test(String(p.code || "")) && num(p.amount, 0) > 0);
    if (!plans.length) return;
    // 先做纯计算的到期判断：无到期则一次网络请求都不发
    const today = todayDate();
    const jobs = plans.map((p) => ({ plan: p, due: planDueDates(p, today) })).filter((j) => j.due.length);
    if (!jobs.length) return;
    plansRunning = true;
    let added = 0, skipped = 0, voided = 0, name = "";
    try {
      for (const job of jobs) {
        // 本轮开始后计划可能已被删除 / 暂停（取净值是网络等待，用户在此期间的操作会并发进来）：
        // 避免给一个已经删掉的计划补记流水。jobs 持有的是 F.plans 里的对象引用。
        const alive = () => (F.plans || []).includes(job.plan) && job.plan.enabled !== false;
        if (!alive()) continue;
        const code = job.plan.code;
        const series = await navSeriesCached(code);
        // 净值序列拉取失败（或该基金没有净值序列）→ 整轮挂起，下轮重试，绝不推进锚点
        if (!series) continue;
        if (!alive()) continue; // 就在本轮 await 期间被删除 / 暂停 → 立刻收手
        const firstDs = ymd(new Date(series[0].t)); // 该基金最早的净值日
        // 扣款日早于基金最早净值日 → 这些期次在现实中永远不会成立（那时基金还没有净值）。
        // 必须整体挡掉：否则会被「顺延」到成立日、多期堆成同一批重复流水。
        // 锚点**一次推到「成立日前一天」**而不一期一期走 —— 老数据的起投日可能比成立日早好几年，
        // 一期一期走要几十轮心跳才追得上今天，期间角标与状态栏会一直报这些虚期次。
        // 日期用「年月日 ±1 天」推，不用 ±24h 毫秒（夏令时时区会差一小时，可能落到同一天）。
        if (job.due[0] < firstDs) {
          const f = parseYmd(firstDs);
          const barEnd = new Date(f.getFullYear(), f.getMonth(), f.getDate() - 1);
          // 作废期数取**真实期数**（不受 PLAN_MAX_CATCHUP 截断）：这句是给用户看的账目说明
          voided += planDueDates(job.plan, barEnd, Infinity).length;
          const bar = ymd(barEnd);
          if (!job.plan.lastPaidDate || job.plan.lastPaidDate < bar) job.plan.lastPaidDate = bar;
        }
        for (const dateStr of job.due) {
          if (!alive()) break; // 就在本轮 await 期间被删除 / 暂停 → 立刻收手
          if (dateStr < firstDs) continue; // 已在上面整体作废
          const hit = navAtOrAfter(series, dateStr); // 扣款日当天或之后最近一个交易日
          // 取不到只有一种可能：序列最新一天仍早于扣款日 —— 今天的净值还没公布 / 长假还没结束 /
          // 数据源滞旧（QDII 净值 T+1）。此时**必须等待**：按「非交易日」跳过会永久丢掉这一期
          // （锚点推进不可逆），借用往日净值又会用错价格，两者都会写错账。
          if (!hit) break;
          const own = hit.date === dateStr; // 扣款日本身就是交易日
          if (!own && job.plan.cycle === "day") {
            // 日定投：扣款日（法定节假日）当天没有净值 → 当日不扣款，跳过并推进锚点（不顺延）
            job.plan.lastPaidDate = dateStr; skipped++; continue;
          }
          const amount = num(job.plan.amount, 0);
          const shares = amount / hit.nav;
          const nm = job.plan.name || code;
          // 流水日期一律写「真正成交的那个交易日」：月/周投遇非交易日顺延到下一交易日，
          // 于是账本里不会再出现非交易日（周末 / 国庆）的定投流水，日期与净值也永远对得上。
          applyTrade({
            code, name: nm, type: "buy", date: hit.date,
            amount, shares, nav: hit.nav,
            planId: job.plan.id, auto: true,
            note: own
              ? `定投自动记账 · 净值 ${hit.nav}`
              : `定投自动记账 · 扣款日 ${dateStr} 非交易日，顺延至 ${hit.date}，净值 ${hit.nav}`,
          });
          job.plan.lastPaidDate = dateStr;
          added++; name = nm;
        }
      }
    } finally {
      plansRunning = false;
    }
    if (added || skipped || voided) {
      save();
      const pending = (F.plans || []).reduce((n, p) => n + planPendingDates(p).length, 0);
      // 三种变化都要有反馈：只跳过 / 只作废时若静默，用户会以为定投开关失灵。
      // 各段必须写明「是哪一种变化」—— 「作废（扣款日早于基金成立日）」不能混进「跳过非交易日」，
      // 这句是给用户看的账目说明，口径必须准确（同 §8.7 第 12 条的取舍）。
      const parts = [];
      if (added) parts.push(`定投已自动记账 ${added} 笔${name ? "（" + name + "…）" : ""}`);
      if (skipped) parts.push(`跳过非交易日 ${skipped} 期`);
      if (voided) parts.push(`作废 ${voided} 期（扣款日早于基金成立日）`);
      if (pending) parts.push(`另有 ${pending} 期待扣款`);
      setStatus(parts.join("，"), pending ? "warn" : "ok");
      // 重渲染整页而非只重渲染计划子页：待扣款角标挂在子页签栏上，只有 renderWH 会重建它
      if (currentTab === "wh") renderWH();
    }
  }

  let statusTimer = 0;
  function setStatus(msg, kind) {
    statusEl.textContent = msg || "";
    statusEl.className = "fund-status" + (kind ? " " + kind : "");
    statusEl.hidden = !msg;
    clearTimeout(statusTimer);
    if (msg) statusTimer = setTimeout(() => { statusEl.hidden = true; }, 5000);
  }

  let currentTab = "overview";
  function switchTab(tab) {
    currentTab = tab;
    tabBtns.forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
    panelOverview.hidden = tab !== "overview";
    panelWH.hidden = tab !== "wh";
    panelRank.hidden = tab !== "rank";
    panelSearch.hidden = tab !== "search";
    if (tab === "overview") loadOverview();
    if (tab === "wh") renderWH();
    if (tab === "rank") loadRank();
  }
  tabBtns.forEach((b) => b.addEventListener("click", () => switchTab(b.dataset.tab)));
  body.querySelector("#fund-refresh").addEventListener("click", () => {
    refreshAll().then(() => setStatus("行情已刷新", "ok")).catch((e) => setStatus("刷新失败：" + (e && e.message || e), "err"));
  });
  body.querySelector("#fund-add-watch").addEventListener("click", () => {
    switchTab("search");
    setTimeout(() => { if (searchInputEl) searchInputEl.focus(); }, 50);
  });

  // ---------- 持仓汇总计算（总览 + 自选持仓共用） ----------
  function computeHoldSummary() {
    const holdings = F.holdings || [];
    const hq = {};
    let totalMarket = 0, totalCost = 0, totalDay = 0, anyData = false, fitCnt = 0, etfCnt = 0;
    for (const h of holdings) {
      const q = getQuote(h.code);
      const c = calcHolding(h, q);
      hq[h.id] = c;
      totalMarket += c.market;
      totalCost += c.cost;
      totalDay += c.dayProfit;
      if (c.hasData) anyData = true;
      if (c.daySrc === "fit") fitCnt++;
      else if (c.daySrc === "etf") etfCnt++;
    }
    const totalProfit = totalMarket - totalCost;
    const totalPct = totalCost > 0 ? (totalProfit / totalCost) * 100 : 0;
    return { holdings, hq, totalMarket, totalCost, totalDay, totalProfit, totalPct,
             fitCnt, etfCnt, estCnt: fitCnt + etfCnt,
             hasQuotes: holdings.length > 0 && anyData };
  }
  function hhmm(ts) {
    const d = new Date(ts || Date.now());
    return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  }
  function summaryCardsHTML(sum) {
    // 盘中估算（重仓股拟合 / 场内 ETF）与最新净值口径混用时，用副标题说明取数来源
    // 并把实测校准精度一并暴露，避免用户把估算值当成官方值
    const ov = calibOverall();
    const calTxt = ov ? ` · 校准 ±${ov.mae.toFixed(2)}pp` : "";
    // 行情基准日：跨市场持仓会落在不同交易日（如国庆 A 股休市、美股照常），逐日列出避免歧义
    const estDates = getEstDates(), estAt = getEstAt();
    const dTxt = estDates.length ? `行情 ${estDates.map((d) => d.slice(5)).join("/")} · ` : "";
    const estSub = sum.estCnt
      ? `盘中估算 · ${dTxt}${hhmm(estAt)} 更新 · ${sum.estCnt}/${sum.holdings.length} 只${calTxt}`
      : `最新净值口径 · ${dTxt}${calTxt}`;
    return `
      <div class="fund-summary">
        <div class="fund-sum-card">
          <div class="fsc-label">持仓市值</div>
          <div class="fsc-val">${sum.hasQuotes ? "¥" + fmtMoney(sum.totalMarket) : "--"}</div>
        </div>
        <div class="fund-sum-card">
          <div class="fsc-label">累计盈亏</div>
          <div class="fsc-val ${pctClass(sum.totalProfit)}">${sum.hasQuotes ? (sum.totalProfit >= 0 ? "+" : "") + fmtMoney(sum.totalProfit) : "--"}</div>
          <div class="fsc-sub ${pctClass(sum.totalPct)}">${sum.hasQuotes ? fmtPct(sum.totalPct) : ""}</div>
        </div>
        <div class="fund-sum-card">
          <div class="fsc-label">${sum.estCnt ? "今日估算盈亏" : "今日盈亏"}</div>
          <div class="fsc-val ${pctClass(sum.totalDay)}">${sum.hasQuotes ? (sum.totalDay >= 0 ? "+" : "") + fmtMoney(sum.totalDay) : "--"}</div>
          <div class="fsc-sub">${sum.hasQuotes ? esc(estSub) : ""}</div>
        </div>
        <div class="fund-sum-card">
          <div class="fsc-label">持仓数量</div>
          <div class="fsc-val">${sum.holdings.length} 只</div>
        </div>
      </div>`;
  }
  // 「估」标签悬浮说明：附上实测校准精度，让用户知道这个估算值有多可信
  function estTagTitle(code) {
    const base = "盘中估算：定期报告重仓股拟合";
    const st = calibStats(F.calib[code] || []);
    if (!st) return base;
    return `${base}；历史校准 ${st.n} 次，平均偏差 ±${st.mae.toFixed(2)}pp、命中率 ${st.hitRate.toFixed(0)}%（点击展开估算依据）`;
  }
  // 校准段：把「估算值」和「官方日增长率」的实测偏差摊开给用户看
  function calibPanelHTML(code) {
    const list = calibList(code);
    const st = calibStats(list);
    if (!st) {
      const pend = list.filter((x) => typeof x.real !== "number").length;
      const done = list.length - pend;
      return `
        <div class="cal-block">
          <div class="cal-head">
            <span class="cal-title">估算精度校准</span>
            <span class="cal-meta">${done || pend ? `已采 ${done} 次 / 待净值公布 ${pend} 次` : "尚无样本"} · 样本满 ${CALIB_MIN_N} 次给出统计</span>
          </div>
          <div class="cal-note">收盘后打开本模块会按当日收盘价自动采一次；官方净值公布后回填实际值，用于衡量这只基金估算值的可信度。</div>
        </div>`;
    }
    const rows = list
      .filter((x) => typeof x.real === "number")
      .slice(-5).reverse()
      .map((x) => {
        const dev = x.est - x.real;
        return `<div class="cal-row">
            <span class="cal-d">${esc(x.d)}</span>
            <span class="cal-v ${pctClass(x.est)}">${fmtPct(x.est)}</span>
            <span class="cal-v ${pctClass(x.real)}">${fmtPct(x.real)}</span>
            <span class="cal-v ${Math.abs(dev) <= CALIB_HIT_PP ? "cal-ok" : "cal-bad"}">${(dev >= 0 ? "+" : "") + dev.toFixed(2)}pp</span>
          </div>`;
      }).join("");
    // 系统性偏差：长期同向偏移说明口径本身有偏（如股票仓位取值偏小），比随机噪声更值得提醒
    const biasWarn = st.n >= 5 && Math.abs(st.bias) > 0.15
      ? `<span class="est-warn">系统性${st.bias > 0 ? "偏高" : "偏低"} ${Math.abs(st.bias).toFixed(2)}pp，可能源于持仓明细滞后或股票仓位口径偏差</span>`
      : "";
    return `
        <div class="cal-block">
          <div class="cal-head">
            <span class="cal-title">估算精度校准</span>
            <span class="cal-meta">近 <b>${st.n}</b> 次 · 平均偏差 <b>±${st.mae.toFixed(2)}pp</b>
              · 最大 <b>${st.max.toFixed(2)}pp</b> · 命中率 <b>${st.hitRate.toFixed(0)}%</b>（|偏差|≤${CALIB_HIT_PP}pp）</span>
          </div>
          <div class="cal-rows">
            <div class="cal-row cal-hd"><span>净值日</span><span class="cal-v">估算</span><span class="cal-v">实际</span><span class="cal-v">偏差</span></div>
            ${rows}
          </div>
          <div class="cal-foot">
            ${biasWarn}
            <span class="cal-note">估算取「行情已收盘」时的拟合值，与官方日增长率同日同口径；偏差主要来自季报持仓滞后（1~3 个月）期间的调仓。</span>
          </div>
        </div>`;
  }
  // 估算依据面板：展开后可见参与拟合的重仓股权重与涨跌，用于解释估算结果
  function estPanelHTML(e) {
    const rows = e.detail.slice(0, 12).map((s) => `
      <div class="est-row">
        <span class="est-name">${esc(s.name)}<i>${esc(s.code)}</i></span>
        <span class="est-w">${s.weight.toFixed(2)}%</span>
        <span class="est-p ${pctClass(s.pct)}">${fmtPct(s.pct)}</span>
      </div>`).join("");
    const more = e.detail.length > 12 ? `<div class="est-more">另有 ${e.detail.length - 12} 只持仓未列出</div>` : "";
    return `
      <div class="est-panel" data-code="${esc(e.code)}" hidden>
        <div class="est-head">
          <span class="est-title">估算依据 · 重仓股拟合</span>
          <span class="est-meta">持仓 ${esc(e.reportDate || "—")} · 行情 ${esc(e.hqDate || "—")} · 覆盖 ${e.covered.toFixed(1)}%
            / 股票仓位 ${e.posShare.toFixed(1)}%${e.covered < 60 ? ` · <b class="est-warn">覆盖率偏低，偏差可能较大</b>` : ""}</span>
        </div>
        <div class="est-rows">${rows}${more}</div>
        <div class="est-foot">
          <span>加权涨幅 <b class="${pctClass(e.normPct)}">${fmtPct(e.normPct)}</b></span>
          <span>等权平均 <b class="${pctClass(e.avgPct)}">${fmtPct(e.avgPct)}</b></span>
          <span>折算估算 <b class="${pctClass(e.pct)}">${fmtPct(e.pct)}</b></span>
          <span class="est-note">加权涨幅 = Σ(占净值比×个股涨跌)/Σ(占净值比)，再乘股票仓位；估算基于滞后季报持仓，与实际净值存在偏差，仅供参考</span>
        </div>
        ${calibPanelHTML(e.code)}
      </div>`;
  }

  // ---------- 自选列表渲染（自选持仓页使用） ----------
  function watchRowsHTML(watch) {
    const holdings = F.holdings || [];
    return watch.map((w) => {
      const q = getQuote(w.code);
      const nav = q ? num(q.nav ?? q.dwjz, 0) : 0;
      const held = holdings.find((h) => h.code === w.code);
      // 自选行情「今日涨跌」与持仓账本同源：场内 ETF > 重仓拟合估值 > 最新净值
      const dp = dayPctOf(w.code, q);
      const pct = dp.pct;
      const staleTag = q && q.stale ? '<span class="fr-est" title="实时数据源失败，显示缓存数据">缓</span>' : "";
      const estTag = dp.src === "fit" ? `<span class="fr-est" title="${esc(estTagTitle(w.code))}">估</span>`
        : dp.src === "etf" ? '<span class="fr-est" title="盘中估算：场内 ETF 实时价">估</span>' : "";
      const pctTitle = dp.src === "fit" ? "盘中估算涨跌（定期报告重仓股加权拟合）"
        : dp.src === "etf" ? "盘中估算涨跌（场内 ETF 实时价）"
          : (q && q.stale ? "缓存涨跌（数据源暂时不可用）" : "最新净值日涨跌");
      return `
        <div class="fund-row" data-code="${esc(w.code)}">
          <div class="fr-name">
            <div class="fr-title">${esc(w.name || w.code)}</div>
            <div class="fr-sub">${esc(w.code)}${held ? ' · <span class="fr-held">持仓中</span>' : ""}</div>
          </div>
          <div class="fr-val">${nav ? nav.toFixed(4) : "--"}${staleTag}</div>
          <div class="fr-val ${pctClass(pct)}" title="${esc(pctTitle)}">${fmtPct(pct)}${estTag}${q && q.stale ? '<span class="fr-est" title="数据源失败，显示缓存">缓</span>' : ""}</div>
          <div class="fr-act">
            ${held
              ? `<button class="btn-ghost fr-edit" data-code="${esc(w.code)}" title="编辑持仓">编辑</button>`
              : `<button class="btn-ghost fr-buy" data-code="${esc(w.code)}" title="记一笔持仓">持仓</button>`}
            <button class="btn-ghost fr-chart" data-code="${esc(w.code)}" title="净值走势">走势</button>
            <button class="btn-ghost fr-del" data-code="${esc(w.code)}" title="移出自选">移除</button>
          </div>
        </div>`;
    }).join("");
  }
  function watchBlockHTML(opts) {
    opts = opts || {};
    const watch = F.watchlist || [];
    return `
      <div class="fund-block-head">
        <span class="fb-title">${opts.title || "自选列表"}</span>
        <span class="fb-hint">${watch.length} 只 · ${isTradingNow() ? "交易时段 自动刷新" : "非交易时段 显示最新净值"}</span>
      </div>
      ${watch.length ? `
      <div class="fund-table-head">
        <span class="fh-name">名称 / 代码</span>
        <span class="fh-val">最新净值</span>
        <span class="fh-val" title="盘中为估算值（重仓股拟合 / 场内 ETF 实时价），收盘后为最新净值涨跌">今日涨跌</span>
        <span class="fh-act">操作</span>
      </div>
      <div class="fund-list">${watchRowsHTML(watch)}</div>` : `<div class="fund-empty">还没有自选基金，点右上角「添加自选」搜索一只吧</div>`}`;
  }
  function bindWatchEvents(container) {
    container.querySelectorAll(".fr-del").forEach((b) => b.addEventListener("click", () => removeWatch(b.dataset.code)));
    container.querySelectorAll(".fr-buy").forEach((b) => b.addEventListener("click", () => openHoldingDialog(b.dataset.code)));
    container.querySelectorAll(".fr-edit").forEach((b) => b.addEventListener("click", () => openHoldingDialog(b.dataset.code)));
    container.querySelectorAll(".fr-chart").forEach((b) => b.addEventListener("click", () => openChart(b.dataset.code)));
  }

  // ================= 账户收益曲线（历史回推，不做每日快照） =================
  // 市值由「历史净值序列 × 各时点份额」回推，所以刚记完账就能看到完整历史，
  // 不需要等系统跑够天数攒快照。
  // 收益率指数按「剔除现金流后的日收益」连乘（TWR），定投 / 加减仓不会污染曲线；
  // 基准（沪深300联接）按同时点、同金额进出，只比较「选基能力」，不比较「投入节奏」。
  const BENCH = { code: "110020", name: "沪深300" };
  const CURVE_RANGES = [
    { id: "all", label: "全部", days: 0 },
    { id: "1y", label: "近1年", days: 365 },
    { id: "3m", label: "近3月", days: 91 },
  ];
  const CURVE_MIN_POINTS = 3;          // 少于 3 个交易日不画（曲线没有意义）
  const CURVE_XIRR_MIN_DAYS = 90;      // 年化样本下限，跨度太短会被放大成无意义数字
  const TTL_NAVSERIES = 30 * 60 * 1000;
  const navMemo = new Map();           // code -> { at, list }，内存缓存，不落 state.json
  let curveRange = "all", curveMode = "pct", curveToken = 0;

  async function navSeriesCode(code) {
    const rec = navMemo.get(code);
    if (rec && rec.list && Date.now() - rec.at < TTL_NAVSERIES) return rec.list;
    let list = null;
    try { list = await fetchNavSeries(code); } catch (_) { list = null; }
    if (list && list.length) { navMemo.set(code, { at: Date.now(), list }); return list; }
    return rec ? rec.list : null;
  }
  // 序列在时刻 t 的净值（≤t 的最近一个交易日）；序列尚未覆盖该日则返回 0。
  // 游标必须按 t 升序调用，一次遍历 O(n)。
  function navCursor(series) {
    let i = 0;
    return (t) => {
      if (!series || !series.length) return 0;
      while (i + 1 < series.length && series[i + 1].t <= t) i++;
      return series[i].t <= t ? series[i].nav : 0;
    };
  }
  // 交易 → 按日期聚合。flow = 账户净现金流（买入为正，赎回/分红为负）；
  // items 供「份额 / 成本」两条平行账推进：买入份额+成本+，赎回按比例冲减成本，分红只冲减成本。
  function curveEvents() {
    const ev = new Map();
    const at = (ds) => {
      let e = ev.get(ds);
      if (!e) { e = { flow: 0, items: [] }; ev.set(ds, e); }
      return e;
    };
    for (const t of (F.trades || [])) {
      if (!t || !/^\d{6}$/.test(String(t.code || "")) || !parseYmd(t.date)) continue;
      const amt = num(t.amount, 0);
      const e = at(t.date);
      if (t.type === "buy") {
        e.flow += amt;
        e.items.push({ code: t.code, shares: num(t.shares, 0), amount: amt, kind: "buy" });
      } else if (t.type === "sell") {
        e.flow -= amt;
        e.items.push({ code: t.code, shares: -num(t.shares, 0), amount: amt, kind: "sell" });
      } else if (t.type === "div") {
        e.flow -= amt;
        e.items.push({ code: t.code, shares: 0, amount: amt, kind: "div" });
      }
    }
    return ev;
  }
  function pushAnchor(ev, a) {
    let e = ev.get(a.date);
    if (!e) { e = { flow: 0, items: [] }; ev.set(a.date, e); }
    e.flow += a.flow;
    e.items.push({ code: a.code, shares: a.shares, amount: a.flow, kind: "buy" });
  }
  // 手工录入的持仓没有流水：用「单位成本」在历史净值里反查买入日。
  // 从录入日往前扫，取「最近一个」与成本价贴合的交易日（先按 0.5% 严容差，再放宽到 5%），
  // 避免匹配到多年前的历史价位。匹配不上就退回到录入日。界面上会标注「推算」。
  function inferBuyEvent(h, series) {
    const cost = num(h.cost, 0), shares = num(h.shares, 0);
    if (!(cost > 0) || !(shares > 0)) return null;
    const unit = cost / shares;
    const addedTs = num(h.addedAt, 0) || Date.now();
    const list = series || [];
    let best = null;
    for (const tol of [0.005, 0.05]) {
      for (let i = list.length - 1; i >= 0; i--) {
        const p = list[i];
        if (p.t > addedTs) continue;
        if (Math.abs(p.nav - unit) / unit <= tol) { best = p; break; }
      }
      if (best) break;
    }
    if (best) return { code: h.code, date: ymd(new Date(best.t)), flow: cost, shares };
    return { code: h.code, date: ymd(new Date(addedTs)), flow: cost, shares };
  }

  async function accountCurve() {
    const holdings = F.holdings || [];
    const codes = new Set();
    holdings.forEach((h) => { if (h && /^\d{6}$/.test(String(h.code || ""))) codes.add(h.code); });
    (F.trades || []).forEach((t) => { if (t && /^\d{6}$/.test(String(t.code || ""))) codes.add(t.code); });
    const fundCodes = Array.from(codes);
    if (!fundCodes.length) return { empty: "noPosition" };

    const ev = curveEvents();
    // 净值序列 + 基准，一次性并发拉取（单只失败只影响该基金，不致命）
    const got = await Promise.all([BENCH.code].concat(fundCodes).map((c) => navSeriesCode(c)));
    const benchSeries = got[0];
    const seriesMap = new Map();
    fundCodes.forEach((c, i) => { const s = got[i + 1]; if (s && s.length) seriesMap.set(c, s); });
    if (!seriesMap.size) return { empty: "noNav" };

    // 账本自洽：把「流水累计份额」补齐到「当前持仓份额」。
    // 两种情况会不一致——① 手工录入的持仓本来就没有流水；② 流水被 200 条上限截断。
    const traded = new Map();
    for (const e of ev.values()) for (const it of e.items) traded.set(it.code, (traded.get(it.code) || 0) + it.shares);
    const anchors = [];
    const gapCodes = new Set();  // 流水与持仓不一致的代码：成本以账本为准，不再由流水推算
    for (const h of holdings) {
      const cur = num(h.shares, 0);
      if (!(cur > 0)) continue;
      const s = seriesMap.get(h.code);
      const have = traded.get(h.code) || 0;
      if (Math.abs(have) < 1e-6) {
        const a = inferBuyEvent(h, s);
        if (a) { pushAnchor(ev, a); anchors.push(a); }
      } else if (Math.abs(have - cur) / cur > 0.001) {
        const gap = cur - have;
        const first = s && s.length ? s[0] : null;
        const a = {
          code: h.code,
          date: first ? ymd(new Date(first.t)) : ymd(new Date()),
          flow: gap * (first ? first.nav : 0),
          shares: gap,
        };
        pushAnchor(ev, a);
        anchors.push(a);
        gapCodes.add(h.code);
      }
    }
    if (!ev.size) return { empty: "noTrade" };

    // 交易日全集：各序列取并集，且不早于首笔交易（避免为一段空仓期白算几千个点）
    let firstTs = Infinity;
    for (const ds of ev.keys()) {
      const d = parseYmd(ds);
      if (d && d.getTime() < firstTs) firstTs = d.getTime();
    }
    if (!isFinite(firstTs)) return { empty: "noTrade" };
    const tset = new Set();
    for (const s of seriesMap.values()) for (const p of s) if (p.t >= firstTs) tset.add(p.t);
    if (benchSeries) for (const p of benchSeries) if (p.t >= firstTs) tset.add(p.t);
    // 关键：交易日记的日期可能不是交易日（周末/节假日扣款的定投、周一定投遇休市），
    // 这些日期也必须落进时间轴，否则整笔买卖会被静默丢掉。净值由游标向前顺延取值。
    for (const ds of ev.keys()) {
      const d = parseYmd(ds);
      if (d && d.getTime() >= firstTs) tset.add(d.getTime());
    }
    const dates = Array.from(tset).sort((a, b) => a - b);
    if (dates.length < CURVE_MIN_POINTS) return { empty: "tooShort" };

    const cursors = new Map();
    for (const c of seriesMap.keys()) cursors.set(c, navCursor(seriesMap.get(c)));
    const benchNav = navCursor(benchSeries);
    const shares = new Map();
    const costs = new Map();   // 与 shares 平行的成本账，规则同 applyTrade（赎回按比例冲减、分红全额冲减）
    let benchUnits = 0;
    const rows = [];
    let prevV = 0, prevB = 0, idx = 1, bIdx = 1;

    for (const t of dates) {
      const ds = ymd(new Date(t));
      const e = ev.get(ds);
      let flow = 0;
      if (e) {
        flow = e.flow;
        for (const it of e.items) {
          const c0 = costs.get(it.code) || 0;
          if (it.kind === "buy") {
            shares.set(it.code, (shares.get(it.code) || 0) + it.shares);
            costs.set(it.code, c0 + it.amount);
          } else if (it.kind === "sell") {
            const cur = shares.get(it.code) || 0;
            const ratio = cur > 0 ? Math.min(1, -it.shares / cur) : 0;
            shares.set(it.code, Math.max(0, cur + it.shares));
            costs.set(it.code, Math.max(0, c0 * (1 - ratio)));
          } else {  // 分红：份额不变，成本下降（= 已回收的本金）
            costs.set(it.code, Math.max(0, c0 - it.amount));
          }
        }
        const bn = benchNav(t);
        if (bn > 0) benchUnits += flow / bn;  // 基准：同时点、同金额进出
      }
      let value = 0;
      for (const c of seriesMap.keys()) {
        const sh = shares.get(c) || 0;
        if (sh === 0) continue;
        const nv = cursors.get(c)(t);
        if (nv > 0) value += sh * nv;
      }
      const bn2 = benchNav(t);
      const bValue = bn2 > 0 ? benchUnits * bn2 : 0;
      const net = (rows.length ? rows[rows.length - 1].net : 0) + flow;
      // 剔除现金流后的日收益，连乘成指数
      if (prevV > 0) { const r = (value - flow) / prevV; if (isFinite(r) && r > 0) idx *= r; }
      if (prevB > 0) { const r = (bValue - flow) / prevB; if (isFinite(r) && r > 0) bIdx *= r; }
      rows.push({ t, date: ds, value, net, flow, idx, bench: bValue, bIdx, benchOk: bn2 > 0 });
      prevV = value; prevB = bValue;
    }

    const last = rows[rows.length - 1];
    const range = CURVE_RANGES.find((r) => r.id === curveRange) || CURVE_RANGES[0];
    const fromT = range.days ? last.t - range.days * 86400000 : rows[0].t;
    let si = 0;
    while (si < rows.length - 1 && rows[si].t < fromT) si++;
    const win = rows.slice(si);
    if (win.length < CURVE_MIN_POINTS) return { empty: "tooShort" };
    const base = win[0];
    const hasBench = !!benchSeries && win[0].benchOk;

    // 区间内归一化：收益率模式起点=100，金额模式直接用市值
    const pts = win.map((r) => ({
      date: r.date,
      acct: curveMode === "money" ? r.value : (r.idx / base.idx) * 100,
      bench: hasBench ? (curveMode === "money" ? r.bench : (r.bIdx / base.bIdx) * 100) : null,
    }));
    // 最大回撤：在现金流中性的指数上算，定投加仓不会被误判成回撤
    let peak = -Infinity, mdd = 0;
    for (const r of win) {
      const v = r.idx / base.idx;
      if (v > peak) peak = v;
      const dd = peak > 0 ? (peak - v) / peak : 0;
      if (dd > mdd) mdd = dd;
    }
    const twr = (last.idx / base.idx - 1) * 100;
    const bTwr = hasBench && last.bIdx > 0 ? (last.bIdx / base.bIdx - 1) * 100 : null;

    // 年化（XIRR）：把「买入」记为负现金流、「赎回/分红」与「期末市值」记为正现金流。
    // 与所选区间无关，反映的是「这笔钱实际赚了多少」。
    // 只要「一笔投入 + 期末市值」两个现金流就已定义良好，故下限是 2 条（而非定投那种 3 期）。
    const flows = [];
    let grossBuy = 0;
    for (const [ds, e] of ev) {
      const d = parseYmd(ds);
      if (d && Math.abs(e.flow) > 0.005) flows.push({ ts: d.getTime(), amount: -e.flow });
      if (e.flow > 0) grossBuy += e.flow;
    }
    flows.push({ ts: last.t, amount: last.value });
    const tsAll = flows.map((f) => f.ts);
    const spanDays = (Math.max.apply(null, tsAll) - Math.min.apply(null, tsAll)) / 86400000;
    let annual = null;
    if (flows.length >= 2 && spanDays >= CURVE_XIRR_MIN_DAYS && last.value > 0) annual = xirr(flows);

    // 持仓浮盈：与曲线同口径（最新净值 × 份额 − 成本），
    // 这样「持仓浮盈 + 已实现(赎回) = 总收益」恒等，不受盘中估值波动影响。
    // 流水被截断的代码（gapCodes）成本以账本为准。
    let costEnd = 0;
    for (const [c, v] of costs) if (!gapCodes.has(c)) costEnd += v;
    // 流水与持仓不一致的代码，成本以账本为准（其历史成本无法由剩余流水还原）
    for (const h of holdings) if (gapCodes.has(h.code)) costEnd += num(h.cost, 0);
    const profit = last.value - last.net;
    const unreal = last.value - costEnd;
    return {
      pts, hasBench, anchors, from: base.date, to: last.date,
      stats: {
        value: last.value, net: last.net, profit, grossBuy,
        benchValue: hasBench ? last.bench : null,
        twr, annual, mdd: mdd * 100, bTwr,
        excess: bTwr === null ? null : twr - bTwr,
        unreal,
        realized: profit - unreal,
        points: win.length,
      },
    };
  }

  function curCard(label, val, cls, sub, subCls) {
    return `<div class="cur-card">
        <div class="cur-label">${label}</div>
        <div class="cur-val ${cls || ""}">${val}</div>
        ${sub ? `<div class="cur-sub ${subCls || ""}">${sub}</div>` : ""}
      </div>`;
  }
  const moneySigned = (v) => (v >= 0 ? "+" : "-") + "¥" + fmtMoney(Math.abs(v));
  function fmtCurveAxis(v) {
    if (curveMode === "money") {
      if (Math.abs(v) >= 10000) return (v / 10000).toFixed(Math.abs(v) >= 100000 ? 0 : 1) + "万";
      return String(Math.round(v));
    }
    return fmtPct(v - 100, 1);
  }
  function curveBodyHTML(c) {
    const s = c.stats;
    const acctC = s.twr >= 0 ? "#ff7b72" : "#3fb950";
    const benchTxt = c.hasBench ? fmtPct(s.bTwr) : "--";
    const excessTxt = s.excess === null ? "无基准" : (s.excess >= 0 ? "+" : "") + s.excess.toFixed(2) + "pp";
    const exCls = s.excess === null ? "" : (s.excess >= 0 ? "fund-pct-up" : "fund-pct-down");
    const estNote = c.anchors.length
      ? `其中 ${c.anchors.length} 只持仓没有交易流水，买入日按「单位成本 ↔ 历史净值」推算，曲线前段仅供参考。`
      : "";
    const unrealTxt = moneySigned(s.unreal);
    const realizedTxt = moneySigned(s.realized);
    return `
      <div class="cur-sum">
        ${curCard("账户收益", moneySigned(s.profit), pctClass(s.profit),
          `市值 ¥${fmtMoney(s.value)}`, "")}
        ${curCard("区间收益率", fmtPct(s.twr), pctClass(s.twr), "现金流中性(TWR)", "")}
        ${curCard("年化收益", s.annual === null ? "--" : fmtPct(s.annual), pctClass(s.annual),
          s.annual === null ? "跨度不足 90 天" : "XIRR 资金加权", "")}
        ${curCard("最大回撤", "-" + s.mdd.toFixed(2) + "%", s.mdd > 0 ? "fund-pct-down" : "",
          `${s.points} 个交易日`, "")}
        ${curCard(`同期${esc(BENCH.name)}`, benchTxt, pctClass(s.bTwr), "同现金流投入", "")}
        ${curCard("超额收益", excessTxt, exCls, s.excess === null ? "基准不可用" : "账户 − 基准", "")}
      </div>
      <div class="cur-meta">
        <span>区间 <b>${esc(c.from)} ~ ${esc(c.to)}</b></span>
        <span>净投入 <b>¥${fmtMoney(s.net)}</b></span>
        <span>累计买入 <b>¥${fmtMoney(s.grossBuy)}</b></span>
        <span title="最新净值口径的持仓浮盈（与曲线同口径）。账本「累计盈亏」盘中会叠加估值，两者会有小幅差异">持仓浮盈 <b class="${pctClass(s.unreal)}">${unrealTxt}</b></span>
        <span title="赎回部分落袋的盈亏；按账本口径分红冲减成本，故计入浮盈而非已实现">已实现(赎回) <b class="${pctClass(s.realized)}">${realizedTxt}</b></span>
        <span style="opacity:.75">两者相加 = 账户收益</span>
        ${estNote ? `<span class="cur-note">※ ${esc(estNote)}</span>` : ""}
      </div>
      <canvas class="cur-canvas"></canvas>
      <div class="cur-legend">
        <span><i style="background:${acctC}"></i>账户 <b>${fmtPct(s.twr)}</b></span>
        ${c.hasBench ? `<span><i style="background:#8b949e"></i>${esc(BENCH.name)} <b>${benchTxt}</b></span>` : ""}
        <span style="opacity:.75">口径：历史净值回推 · 不含手续费 · 每日更新</span>
      </div>`;
  }

  function drawCurve(canvas, pts) {
    if (!canvas || !pts || pts.length < 2) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(280, canvas.clientWidth || 640);
    const h = canvas.clientHeight || 240;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const padL = 50, padR = 14, padT = 14, padB = 22;
    const acct = pts.map((p) => p.acct);
    const bnch = pts.map((p) => (p.bench === null || !isFinite(p.bench) ? null : p.bench));
    const vals = acct.concat(bnch.filter((v) => v !== null));
    let mn = Math.min.apply(null, vals), mx = Math.max.apply(null, vals);
    if (!isFinite(mn) || !isFinite(mx)) return;
    if (mx - mn < 1e-9) { mx += 1; mn -= 1; }
    const padV = (mx - mn) * 0.08;
    mn -= padV; mx += padV;
    const X = (i) => padL + (i / (pts.length - 1)) * (w - padL - padR);
    const Y = (v) => padT + (1 - (v - mn) / (mx - mn)) * (h - padT - padB);

    // 横向网格 + 左侧刻度
    ctx.font = "10px system-ui, -apple-system, sans-serif";
    ctx.textBaseline = "middle"; ctx.textAlign = "right";
    for (let k = 0; k <= 3; k++) {
      const v = mn + ((mx - mn) * k) / 3;
      const y = Y(v);
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y);
      ctx.strokeStyle = "rgba(128,140,160,0.16)"; ctx.lineWidth = 1; ctx.stroke();
      ctx.fillStyle = "#5b6675";
      ctx.fillText(fmtCurveAxis(v), padL - 7, y);
    }
    // 收益率模式下的 0% 基准线
    if (curveMode === "pct" && mn < 100 && mx > 100) {
      ctx.save();
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(padL, Y(100)); ctx.lineTo(w - padR, Y(100));
      ctx.strokeStyle = "rgba(128,140,160,0.55)"; ctx.stroke();
      ctx.restore();
    }
    // 基准（灰线）
    if (bnch.some((v) => v !== null)) {
      ctx.beginPath();
      let started = false;
      bnch.forEach((v, i) => {
        if (v === null) return;
        if (!started) { ctx.moveTo(X(i), Y(v)); started = true; } else ctx.lineTo(X(i), Y(v));
      });
      ctx.strokeStyle = "rgba(139,148,158,0.8)"; ctx.lineWidth = 1.3; ctx.stroke();
    }
    // 账户（红涨绿跌，面积渐变）
    const up = acct[acct.length - 1] >= acct[0];
    const lineC = up ? "#ff7b72" : "#3fb950";
    const areaC = up ? "rgba(255,123,114,0.26)" : "rgba(63,185,80,0.22)";
    ctx.beginPath();
    ctx.moveTo(X(0), h - padB);
    for (let i = 0; i < acct.length; i++) ctx.lineTo(X(i), Y(acct[i]));
    ctx.lineTo(X(acct.length - 1), h - padB);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, padT, 0, h - padB);
    grad.addColorStop(0, areaC);
    grad.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = grad; ctx.fill();
    ctx.beginPath();
    for (let i = 0; i < acct.length; i++) { if (i === 0) ctx.moveTo(X(i), Y(acct[i])); else ctx.lineTo(X(i), Y(acct[i])); }
    ctx.strokeStyle = lineC; ctx.lineWidth = 1.7; ctx.lineJoin = "round"; ctx.lineCap = "round";
    ctx.stroke();
    // 末点
    ctx.beginPath();
    ctx.arc(X(acct.length - 1), Y(acct[acct.length - 1]), 2.8, 0, Math.PI * 2);
    ctx.fillStyle = lineC; ctx.fill();
    // 首尾日期
    ctx.fillStyle = "#5b6675"; ctx.textBaseline = "alphabetic";
    ctx.textAlign = "left"; ctx.fillText(pts[0].date, padL, h - 5);
    ctx.textAlign = "right"; ctx.fillText(pts[pts.length - 1].date, w - padR, h - 5);
  }

  const CURVE_EMPTY = {
    noPosition: "还没有持仓。先到「自选持仓 · 持仓账本」记一笔，曲线会自动回推历史。",
    noTrade: "暂无交易 / 持仓记录，无法推算账户曲线。",
    noNav: "暂时取不到净值序列（接口受限或代码有误），稍后重试。",
    tooShort: "有效交易日不足 3 天，暂无可绘制的曲线。",
  };
  // 曲线块标记：只挂在「自选持仓 · 收益曲线」子页签下。
  // 刻意**不带 id** —— panelWH 与 panelOverview 始终同时存在于 DOM（只是 hidden），
  // 同 id 不合法且 getElementById 会命中隐藏那份。区间/口径按钮靠 root 作用域内的选择器查。
  function curveBlockHTML() {
    return `
      <div class="fund-block fund-curve-block">
        <div class="fund-block-head">
          <div class="ov-ctl">
            <span class="fb-title">账户收益曲线</span>
            <span class="fb-src" title="由历史净值序列回推，无需等待系统逐日攒快照；收益率已剔除申赎现金流（TWR），定投与加减仓不会污染曲线。基准按同样时点、同样金额买入沪深300联接基金。">历史回推 · 净值口径</span>
            <div class="seg">
              ${CURVE_RANGES.map((r) => `<button class="seg-btn${curveRange === r.id ? " active" : ""}" data-cur-r="${r.id}">${r.label}</button>`).join("")}
            </div>
            <div class="seg">
              <button class="seg-btn${curveMode === "pct" ? " active" : ""}" data-cur-m="pct">收益率</button>
              <button class="seg-btn${curveMode === "money" ? " active" : ""}" data-cur-m="money">金额</button>
            </div>
          </div>
        </div>
        <div class="cur-body"><div class="fund-empty">加载中…</div></div>
      </div>`;
  }
  // 只切区间/口径，不重建整页（净值序列已内存缓存，切换是瞬时的）
  function bindCurveEvents(root) {
    root.querySelectorAll("[data-cur-r]").forEach((b) =>
      b.addEventListener("click", () => { curveRange = b.dataset.curR; renderCurve(root); }));
    root.querySelectorAll("[data-cur-m]").forEach((b) =>
      b.addEventListener("click", () => { curveMode = b.dataset.curM; renderCurve(root); }));
  }
  // 只重绘曲线块本体（不重建整个页面，避免同页其他快数据跟着闪一下）。
  // root：承载曲线的容器（当前为 whBody）；stillActive：等待期间是否还在该页，
  // 用于避免「切走后异步结果写回隐藏面板」。
  async function renderCurve(root, stillActive) {
    const host = root;
    if (!host || (stillActive && !stillActive())) return;
    const block = host.querySelector(".fund-curve-block");
    if (!block) return;
    block.querySelectorAll("[data-cur-r]").forEach((b) => b.classList.toggle("active", b.dataset.curR === curveRange));
    block.querySelectorAll("[data-cur-m]").forEach((b) => b.classList.toggle("active", b.dataset.curM === curveMode));
    const bodyEl = block.querySelector(".cur-body");
    if (!bodyEl) return;
    const tok = ++curveToken;
    bodyEl.innerHTML = `<div class="fund-empty">加载中…</div>`;
    let c;
    try {
      c = await accountCurve();
    } catch (e) {
      if (tok === curveToken) bodyEl.innerHTML = `<div class="fund-empty">曲线计算失败：${esc(String((e && e.message) || e))}</div>`;
      return;
    }
    if (tok !== curveToken) return;                        // 已有更新的渲染，丢弃本次结果
    if (stillActive && !stillActive()) return;             // 等待期间已切走，不写回
    if (c.empty) { bodyEl.innerHTML = `<div class="fund-empty">${esc(CURVE_EMPTY[c.empty] || "暂无可绘制的曲线")}</div>`; return; }
    bodyEl.innerHTML = curveBodyHTML(c);
    const cv = bodyEl.querySelector("canvas.cur-canvas");
    if (cv) {
      // 交给模块级的 resize 监听器重绘（回调挂在画布上，随画布一起被回收）
      cv.__redraw = () => drawCurve(cv, c.pts);
      drawCurve(cv, c.pts);
    }
  }

  // ---------- 总览页 ----------
  let ovPeriod = "D", ovType = "0";
  function renderOverviewShell() {
    panelOverview.innerHTML = `
      <div class="fund-block">
        <div class="fund-block-head">
          <span class="fb-title">大盘指数</span>
          <span class="fb-hint">实时行情 · 新浪数据</span>
        </div>
        <div class="idx-grid" id="fund-idx-grid"><div class="fund-empty">加载中…</div></div>
      </div>
      <div class="fund-block">
        <div class="fund-block-head">
          <span class="fb-title">基金涨跌分布</span>
          <span class="fb-src" id="fund-dist-src">全市场 · 净值口径</span>
        </div>
        <div id="fund-ov-dist"><div class="fund-empty">加载中…</div></div>
      </div>
      <div class="fund-block">
        <div class="fund-block-head">
          <div class="ov-ctl">
            <span class="fb-title">基金主题</span><span class="fb-src" id="fund-bk-src">天天基金 · 主题基金</span>
            <div class="seg">
              ${THEME_TYPES.map((t) => `<button class="seg-btn${ovType===t.id?" active":""}" data-ovt="${t.id}">${t.label}</button>`).join("")}
            </div>
            <div class="seg">
              ${THEME_PERIODS.map((p) => `<button class="seg-btn${ovPeriod===p.id?" active":""}" data-ovp="${p.id}">${p.label}</button>`).join("")}
            </div>
          </div>
        </div>
        <div class="bk-grid" id="fund-bk-grid"><div class="fund-empty">加载中…</div></div>
      </div>`;
    panelOverview.querySelectorAll("[data-ovt]").forEach((b) =>
      b.addEventListener("click", () => { ovType = b.dataset.ovt; renderOverviewShell(); loadOverview(); }));
    panelOverview.querySelectorAll("[data-ovp]").forEach((b) =>
      b.addEventListener("click", () => { ovPeriod = b.dataset.ovp; renderOverviewShell(); loadOverview(); }));
  }

  function idxCardsHTML(idx) {
    return idx.map((x) => `
        <div class="idx-card${x.hasData ? "" : " idx-na"}" title="${esc(x.name)}${x.hasData ? "" : " · 无有效行情"}">
          <div class="idx-name">${esc(x.name)}</div>
          <div class="idx-price ${x.hasData ? pctClass(x.pct) : "idx-na"}">${x.hasData ? x.price.toFixed(2) : "--"}</div>
          <div class="idx-chg ${x.hasData ? pctClass(x.pct) : "idx-na"}">${x.hasData ? (x.chg >= 0 ? "+" : "") + x.chg.toFixed(2) + "  " + fmtPct(x.pct) : "暂无数据"}</div>
        </div>`).join("");
  }

  // 总览：指数行情刷新（30s 自动刷新只更新指数；涨跌分布是净值口径、主题按周期缓存，
  // 均无需高频刷新，避免周期性重建 DOM 造成闪烁）
  async function refreshOverviewLive() {
    if (currentTab !== "overview") return;
    try {
      const html = idxCardsHTML(await fetchIndexes());
      const el = panelOverview.querySelector("#fund-idx-grid");
      if (el) el.innerHTML = html;
    } catch (_) { /* 保留上一次渲染 */ }
  }

  async function loadOverview() {
    if (currentTab !== "overview") return;
    renderOverviewShell();
    // 三块并行加载：分布首次需 5 路并发拉取全市场（约 5s），串行会连累主题渲染
    const jobIdx = (async () => {
      try {
        const html = idxCardsHTML(await fetchIndexes());
        const el = panelOverview.querySelector("#fund-idx-grid");
        if (el) el.innerHTML = html;
      } catch (e) {
        const el = panelOverview.querySelector("#fund-idx-grid");
        if (el) el.innerHTML = `<div class="fund-empty">指数加载失败：${esc(String(e && e.message || e))}</div>`;
      }
    })();
    const jobDist = (async () => {
      try {
        const d = await fetchDistribution();
        const el = panelOverview.querySelector("#fund-ov-dist");
        if (el) el.innerHTML = distHTML(d);
        const srcEl = panelOverview.querySelector("#fund-dist-src");
        if (srcEl && d) {
          // partial 时不能再写「全市场」——取样不足，改为「样本 N 只 · 缺 M 页」并转琥珀色。
          // classList.toggle 的第二个参数必须显式传布尔：renderOverviewShell 每次都重建该节点，
          // 但有缓存的路径（cached 命中）会直接走到这里，不能残留上一轮的颜色。
          srcEl.textContent = d.partial
            ? `样本 ${d.total} 只 · 净值 ${d.date} · 缺 ${d.pagesTotal - d.pagesOk} 页`
            : `全市场 ${d.total} 只 · 净值 ${d.date}`;
          srcEl.classList.toggle("fb-src-warn", !!d.partial);
          srcEl.title = d.partial
            ? `仅取到 ${d.pagesOk}/${d.pagesTotal} 页（接口按日增长率降序排列，缺页截掉的是跌幅端，`
              + `分布为偏样，仅作参考）。按成功页计得有效样本 ${d.total} 只，`
              + `另有 ${d.skipped} 只次新/未披露净值基金未计入。`
            : `口径：开放式基金「日增长率」（净值口径，非盘中估值）。`
              + `另有 ${d.skipped} 只次新/未披露净值基金未计入。`;
        }
      } catch (e) {
        const el = panelOverview.querySelector("#fund-ov-dist");
        if (el) el.innerHTML = `<div class="fund-empty">涨跌分布加载失败：${esc(String(e && e.message || e))}</div>`;
      }
    })();
    const jobTheme = (async () => {
      try {
        // fetchThemes 已按当前周期涨幅降序返回全部主题，直接渲染
        const list = await fetchThemes(ovType, ovPeriod);
        const srcEl = panelOverview.querySelector("#fund-bk-src");
        if (srcEl) srcEl.textContent = list.length ? `天天基金 · 共 ${list.length} 个主题` : "天天基金 · 主题基金";
        const bkEl = panelOverview.querySelector("#fund-bk-grid");
        if (!bkEl) return;
        if (!list.length) {
          bkEl.innerHTML = `<div class="fund-empty">暂无主题数据</div>`;
        } else {
          bkEl.innerHTML = list.map((b, i) => {
            const v = b.pct;
            return `
          <div class="bk-card" title="${esc(b.name)}">
            <span class="bk-rank">${i + 1}</span>
            <span class="bk-name">${esc(b.name)}</span>
            <span class="bk-pct ${pctClass(v)}">${fmtPct(v)}</span>
          </div>`;
          }).join("");
        }
      } catch (e) {
        const bkEl = panelOverview.querySelector("#fund-bk-grid");
        if (bkEl) bkEl.innerHTML = `<div class="fund-empty">主题加载失败：${esc(String(e && e.message || e))}</div>`;
      }
    })();
    await Promise.all([jobIdx, jobDist, jobTheme]);
  }

  // ---------- 自选持仓页（子页签：自选行情 / 持仓账本 / 收益曲线 / 穿透分析 / 交易流水 / 定投计划） ----------
  function renderWH() {
    if (!panelWH) return;
    const pendingAll = (F.plans || []).reduce((n, p) => n + planPendingDates(p).length, 0);
    panelWH.innerHTML = `
      <div class="fund-subtabs" id="fund-wh-subtabs">
        <button class="fund-subtab${whSub === "watch" ? " active" : ""}" data-wh="watch">自选行情</button>
        <button class="fund-subtab${whSub === "hold" ? " active" : ""}" data-wh="hold">持仓账本</button>
        <button class="fund-subtab${whSub === "curve" ? " active" : ""}" data-wh="curve">收益曲线</button>
        <button class="fund-subtab${whSub === "look" ? " active" : ""}" data-wh="look">穿透分析</button>
        <button class="fund-subtab${whSub === "trades" ? " active" : ""}" data-wh="trades">交易流水</button>
        <button class="fund-subtab${whSub === "plans" ? " active" : ""}" data-wh="plans">定投计划${
          pendingAll ? `<i class="fund-dot" title="有 ${pendingAll} 期待扣款"></i>` : ""}</button>
        <button class="fund-subtab${whSub === "ai" ? " active" : ""}" data-wh="ai">AI 分析</button>
      </div>
      <div class="fund-wh-body" id="fund-wh-body"></div>`;
    whBody = panelWH.querySelector("#fund-wh-body");
    panelWH.querySelectorAll(".fund-subtab").forEach((b) =>
      b.addEventListener("click", () => { whSub = b.dataset.wh; renderWH(); }));
    if (whSub === "watch") renderWHWatch();
    else if (whSub === "hold") renderWHHold();
    else if (whSub === "curve") renderWHCurve();
    else if (whSub === "look") renderWHLook();
    else if (whSub === "trades") renderWHTrades();
    else if (whSub === "plans") renderWHPlans();
    else if (whSub === "ai") renderWHAi();
  }
  // 收益曲线子页签：账户视角，与账本 / 流水 / 计划放在一起更顺手
  // （原先在总览页也有一份，后按需求撤掉，只保留这里）。
  function renderWHCurve() {
    if (!whBody) return;
    whBody.innerHTML = curveBlockHTML();
    bindCurveEvents(whBody);
    renderCurve(whBody, () => currentTab === "wh" && whSub === "curve").catch(() => {});
  }
  // ---------- AI 分析子页签 ----------
  // 口径只取「持仓账本 + 当日估值」：快照直接来自 computeHoldSummary()，与账本界面同一份数字。
  // 走宿主 http_post_stream 的 SSE 通道逐字渲染；配置默认收起，把版面让给报告本身。
  let aiBusy = false;      // 流式生成中
  let aiErr = "";          // 最近一次失败原因
  let aiViewId = "";       // 当前查看的报告 id（"" = 最近一条）
  let aiKeyShown = false;  // API Key 是否明文显示
  let aiDelArm = "";       // 两段式删除确认（项目无原生 confirm 先例）
  let aiMeta = "";         // 状态行：生成进度 / 耗时 / 用量
  let aiCfgOpen = false;   // 设置区是否展开（默认收起）
  let aiParser = null;     // 当前流的 SSE 解析器
  let aiBuf = "";          // 当前流已收到的正文（逐字渲染用）
  let aiStreamId = "";     // 当前流 id（事件按 id 过滤）
  let aiStopUn = null;     // 事件订阅的取消函数
  let aiPaintTimer = 0;    // 渲染节流：最多每 80ms 重排一次
  let aiT0 = 0;            // 本次开始的时刻
  let aiSnapSummary = "";  // 本次快照摘要（落库时用，彼时 snap 已不在作用域）

  function aiCfg() {
    const a = F.ai || {};
    const nz = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
    return {
      baseUrl: typeof a.baseUrl === "string" ? a.baseUrl : "",
      model: typeof a.model === "string" ? a.model : "",
      apiKey: typeof a.apiKey === "string" ? a.apiKey : "",
      temperature: nz(a.temperature, AI_DEFAULTS.temperature),
      maxTokens: nz(a.maxTokens, AI_DEFAULTS.maxTokens),
      timeoutMs: nz(a.timeoutMs, AI_DEFAULTS.timeoutMs),
    };
  }

  function aiSnapshot() {
    const sum = computeHoldSummary();
    if (!sum.holdings.length) return null;
    const navDates = {};
    for (const h of sum.holdings) {
      const q = getQuote(h.code);
      if (q && q.navDate) navDates[h.code] = q.navDate;
    }
    return fundAi.buildSnapshot(sum, {
      stamp: `${ymd(new Date())} ${hhmm(Date.now())}`,
      estDates: getEstDates(),
      estAt: getEstAt(),
      calib: calibOverall(),
      navDates,
      mode: sum.estCnt ? "盘中估算" : "最新净值口径",
    });
  }

  function aiSummarize(snap) {
    const p = snap.totals ? snap.totals.profitPct : null;
    const pct = p === null || p === undefined ? "--" : (p >= 0 ? "+" : "") + p.toFixed(2) + "%";
    return `${snap.count} 只 · 累计 ${pct}`;
  }

  // 报告正文按 Markdown 渲染（复用 vendor/marked，与笔记阅读态同一套）；
  // 未加载时降级为纯文本，绝不因渲染器缺失而丢内容。
  function renderAiMd(text) {
    try {
      if (typeof marked !== "undefined" && marked.parse) {
        if (marked.setOptions) marked.setOptions({ gfm: true, breaks: true });
        return marked.parse(text);
      }
    } catch (_) { /* 落到纯文本兜底 */ }
    return `<pre class="fai-pre">${esc(text)}</pre>`;
  }

  function aiCurReport() {
    const a = F.ai;
    if (!a.history.length) return null;
    return (aiViewId ? a.history.find((r) => r.id === aiViewId) : a.history[0]) || a.history[0];
  }

  function renderWHAi() {
    if (!whBody) return;
    const a = F.ai;
    const cfg = aiCfg();
    const sum = computeHoldSummary();
    const canRun = sum.holdings.length > 0;
    const cur = aiCurReport();
    const st = aiParser ? aiParser.state() : null;
    const host = (() => { try { return new URL(cfg.baseUrl).host; } catch (_) { return ""; } })();
    const hint = !canRun
      ? "还没有持仓记录，无法分析"
      : aiBusy
        ? (st && st.reasoning && !aiBuf ? `模型思考中…（已 ${st.reasoning} 字）` : "正在生成…")
        : `${sum.holdings.length} 只持仓 · ${sum.estCnt ? "含盘中估算，结论可能随行情变动" : "按最新净值口径"}`;

    whBody.innerHTML = `
      <div class="fund-block">
        <div class="fai-bar">
          <span class="fai-sum" title="${esc(cfg.baseUrl || "尚未配置接口地址")}">${
            esc(cfg.model || "未填模型")} · ${esc(host || "未填地址")} · ${cfg.maxTokens} tokens</span>
          <span class="fb-acts">
            <button class="btn-ghost btn-xs" id="fai-cfgbtn">${aiCfgOpen ? "收起设置" : "设置"}</button>
            ${aiBusy
              ? `<button class="btn btn-xs" id="fai-stop">停止</button>`
              : `<button class="btn btn-primary btn-xs" id="fai-run"${canRun ? "" : " disabled"}>开始分析</button>`}
          </span>
        </div>
        <div class="fai-hint">${esc(hint)}</div>
        ${aiCfgOpen ? `
        <div class="fai-cfg">
          <label class="fai-field"><span>接口地址</span>
            <input class="input" id="fai-url" value="${esc(cfg.baseUrl)}" placeholder="https://api.deepseek.com" spellcheck="false" /></label>
          <label class="fai-field"><span>模型</span>
            <input class="input" id="fai-model" value="${esc(cfg.model)}" placeholder="deepseek-chat" spellcheck="false" /></label>
          <label class="fai-field"><span>API Key</span>
            <span class="fai-keywrap">
              <input class="input" id="fai-key" type="${aiKeyShown ? "text" : "password"}" value="${esc(cfg.apiKey)}" placeholder="sk-…" spellcheck="false" autocomplete="off" />
              <button class="btn-ghost btn-xs" id="fai-keyeye">${aiKeyShown ? "隐藏" : "显示"}</button>
            </span></label>
          <label class="fai-field"><span>最大输出（tokens）</span>
            <input class="input" id="fai-maxtok" type="number" min="256" max="8000" step="256" value="${cfg.maxTokens}"
              title="思考型模型（deepseek-reasoner 等）会先消耗大量 token 思考，太小会导致正文为空" /></label>
          <label class="fai-field"><span>超时（秒）</span>
            <input class="input" id="fai-timeout" type="number" min="10" max="600" step="10" value="${Math.round(cfg.timeoutMs / 1000)}"
              title="推理较慢的模型需要更长的等待时间（上限 600 秒）" /></label>
        </div>` : ""}
      </div>
      <div class="fund-block">
        <div class="fund-block-head">
          <span class="fb-title">分析报告</span>
          <span class="fb-src fai-meta"${aiMeta ? "" : " hidden"}>${esc(aiMeta)}</span>
          <span class="fb-acts">
            <button class="btn-ghost btn-xs" id="fai-copy"${cur ? "" : " disabled"}>复制</button>
            <button class="btn-ghost btn-xs" id="fai-export"${cur ? "" : " disabled"}>导出 MD</button>
            <button class="btn-ghost btn-xs fai-del${cur && aiDelArm === cur.id ? " fai-del-arm" : ""}" id="fai-del"${cur ? "" : " disabled"}>${cur && aiDelArm === cur.id ? "确认删除？" : "删除"}</button>
          </span>
        </div>
        <div class="fai-report">${aiReportHTML()}</div>
      </div>
      <div class="fund-block">
        <div class="fund-block-head">
          <span class="fb-title">历史报告</span>
          <span class="fb-hint">${a.history.length ? `共 ${a.history.length} 次 · 点选查看` : `最多保留 ${AI_HISTORY_MAX} 次`}</span>
        </div>
        ${a.history.length
          ? `<div class="fai-hist">${a.history.map((r) => `
              <button class="fai-chip${cur && cur.id === r.id ? " on" : ""}" data-id="${esc(r.id)}" title="${
                esc((r.at || "") + (r.summary ? " · " + r.summary : ""))}">${esc(String(r.at || "").slice(5, 16))}</button>`).join("")}</div>`
          : `<div class="fund-empty">暂无历史报告</div>`}
      </div>`;

    bindWHAi();
    attachCaret(whBody); // 首屏若正处流式（切页签回来）也要有光标
  }

  // 报告区内容 —— 首屏渲染与流式刷新共用这一处，避免两条通路各写一遍
  function aiReportHTML() {
    const cur = aiCurReport();
    const errBox = aiErr ? `<div class="fai-error">${esc(aiErr)}</div>` : "";
    if (aiBusy) {
      const st = aiParser ? aiParser.state() : null;
      // 光标挂在 .fai-streaming 里最后一个块级子元素上（见 CSS）：作为 .fai-md 的兄弟会被挤到下一行
      const body = aiBuf
        ? `<div class="fai-md fai-streaming">${renderAiMd(aiBuf)}</div>`
        : `<div class="fund-empty">${st && st.reasoning ? `模型正在思考…（已 ${st.reasoning} 字）` : "等待模型输出…"}</div>`;
      return errBox + body;
    }
    if (cur) {
      return errBox
        + `<div class="fai-report-meta">${esc(cur.at || "")}${cur.model ? " · " + esc(cur.model) : ""}${cur.summary ? " · " + esc(cur.summary) : ""}</div>`
        + `<div class="fai-md">${renderAiMd(cur.content)}</div>`;
    }
    return errBox + (aiErr ? "" : `<div class="fund-empty">还没有分析报告：点右上角「设置」填好接口，再点「开始分析」</div>`);
  }

  // 流式光标必须贴在「正在生成的那个字」之后。但 .fai-md 的直接子节点都是块级（p/ul/blockquote/table），
  // 光标作为其兄弟会被挤到下一行 —— 故渲染完成后一路下钻到最后一个元素，把光标追加进它内部
  function attachCaret(root) {
    const md = root.querySelector(".fai-md.fai-streaming");
    if (!md) return;
    let node = md;
    while (node.children.length) node = node.children[node.children.length - 1];
    const c = document.createElement("span");
    c.className = "fai-caret";
    node.appendChild(c);
  }

  // 流式刷新只替换报告区与状态行，**不重建整块** —— 否则每帧都会丢输入焦点与滚动位置
  function paintAiReport(follow) {
    const el = whBody && whBody.querySelector(".fai-report");
    if (!el) return;
    el.innerHTML = aiReportHTML();
    attachCaret(el);
    if (follow) el.scrollTop = el.scrollHeight;
  }
  function paintAiMeta() {
    const el = whBody && whBody.querySelector(".fai-meta");
    if (!el) return;
    el.textContent = aiMeta || "";
    el.hidden = !aiMeta;
  }

  // 把屏幕上的配置写回 state（设置区收起时元素不存在，自然跳过）
  function commitCfgFromDom() {
    const q = (s) => (whBody ? whBody.querySelector(s) : null);
    const urlEl = q("#fai-url"), modelEl = q("#fai-model"), keyEl = q("#fai-key");
    if (urlEl) F.ai.baseUrl = urlEl.value.trim();
    if (modelEl) F.ai.model = modelEl.value.trim();
    if (keyEl) F.ai.apiKey = keyEl.value; // 不 trim：Key 本身不含空白，避免误伤
    const tokEl = q("#fai-maxtok"), toEl = q("#fai-timeout");
    // 空输入必须回退默认值：num("")===0 会把「清空」当成 0，再被 clamp 成下限
    if (tokEl) {
      const t = Number(tokEl.value);
      F.ai.maxTokens = tokEl.value.trim() === "" || !Number.isFinite(t)
        ? AI_DEFAULTS.maxTokens : Math.max(256, Math.min(8000, Math.round(t)));
    }
    if (toEl) {
      const s = Number(toEl.value);
      F.ai.timeoutMs = toEl.value.trim() === "" || !Number.isFinite(s)
        ? AI_DEFAULTS.timeoutMs : Math.max(10, Math.min(600, Math.round(s))) * 1000;
    }
    save();
  }

  // ---------- 流式分析 ----------
  async function runAnalyze() {
    if (aiBusy) return;
    commitCfgFromDom();
    const cfg = aiCfg();
    // 校验失败时把设置区摊开，否则用户看不到该填哪一项
    if (!cfg.baseUrl.trim()) { aiCfgOpen = true; aiErr = "请先填写接口地址"; renderWHAi(); return; }
    if (!cfg.model.trim()) { aiCfgOpen = true; aiErr = "请先填写模型名称"; renderWHAi(); return; }
    if (!cfg.apiKey) { aiCfgOpen = true; aiErr = "请先填写 API Key"; renderWHAi(); return; }
    const snap = aiSnapshot();
    if (!snap) { aiErr = "还没有持仓记录，无法分析"; renderWHAi(); return; }

    const sid = uid("fais_");
    aiStreamId = sid;
    aiBusy = true; aiErr = ""; aiDelArm = ""; aiViewId = "";
    aiBuf = ""; aiParser = createStreamParser();
    aiMeta = "正在连接…"; aiT0 = Date.now();
    aiSnapSummary = aiSummarize(snap);
    renderWHAi();
    // 订阅必须在发出请求之前：Rust 可能瞬间就开始推块（事件丢了就只能等超时）
    try {
      aiStopUn = await listen("fund-ai://stream", (p) => { if (p && p.id === sid) onStreamEvent(p); });
    } catch (_) { aiStopUn = null; }

    try {
      await invoke("http_post_stream", {
        streamId: sid,
        url: fundAi.resolveEndpoint(cfg.baseUrl),
        body: fundAi.buildRequestBody(snap, cfg, { stream: true }),
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + cfg.apiKey },
        timeoutMs: cfg.timeoutMs,
      });
    } catch (e) {
      // 命令本体失败（命令未注册 / IPC 异常）也统一转成一次 done 事件
      onStreamEvent({ id: sid, done: true, error: String((e && e.message) || e) });
    }
  }

  async function stopAnalyze() {
    if (!aiBusy || !aiStreamId) return;
    aiMeta = "正在停止…";
    paintAiMeta();
    try { await invoke("http_stream_cancel", { streamId: aiStreamId }); } catch (_) {}
  }

  function onStreamEvent(p) {
    if (!aiParser) return;
    if (p.chunk) {
      aiParser.push(p.chunk);
      const st = aiParser.state();
      aiBuf = st.content;
      aiMeta = aiBuf ? `生成中… ${aiBuf.length} 字` : (st.reasoning ? `模型思考中…（已 ${st.reasoning} 字）` : "等待模型输出…");
      // 节流：每 80ms 才重排一次 DOM（逐 token 直接渲染会把主线程打满）
      if (!aiPaintTimer) {
        aiPaintTimer = setTimeout(() => {
          aiPaintTimer = 0;
          paintAiMeta();
          paintAiReport(true);
        }, 80);
      }
    }
    if (p.done) finishAnalyze(p);
  }

  function finishAnalyze(p) {
    if (aiPaintTimer) { clearTimeout(aiPaintTimer); aiPaintTimer = 0; }
    if (aiStopUn) { try { aiStopUn(); } catch (_) {} aiStopUn = null; }
    aiStreamId = "";
    const parser = aiParser;
    aiParser = null;
    aiBusy = false;
    if (!parser) return;
    parser.flush();
    const st = parser.state();
    const cfg = aiCfg();
    const secs = ((Date.now() - aiT0) / 1000).toFixed(1);

    let text = st.content;
    let err = p.error || st.error || "";
    // 兜底：把整段原文交给 extractContent 再解析一次。
    //   · 服务端没按 SSE 回（一次性完整 JSON / 网关错误页）→ 这就是正路
    //   · 已是 SSE 但增量解析没攒到正文 → extractContent 会重放整段（能捞回就捞回）；
    //     捞不回来时抛的是 streamEmptyReason 的成因文案（如「思考链吃光输出预算」），
    //     而不是那句会把成因彻底盖掉的「接口返回的不是 JSON」（实测踩过）
    if (!text && !err && st.raw) {
      try { text = extractContent(st.raw).content; } catch (e) { err = String((e && e.message) || e); }
    }

    if (!text) {
      aiBuf = "";
      aiMeta = "";
      aiErr = p.canceled
        ? "已停止（尚未收到正文）" + (err ? "；" + err : "")
        : "分析失败：" + (err || "分析结束但没有收到任何内容");
      renderWHAi();
      return;
    }
    const rec = {
      id: uid("fai_"),
      at: `${ymd(new Date())} ${hhmm(Date.now())}`,
      model: st.model || cfg.model,
      content: text,
      summary: aiSnapSummary,
    };
    F.ai.history.unshift(rec);
    if (F.ai.history.length > AI_HISTORY_MAX) F.ai.history.length = AI_HISTORY_MAX;
    aiViewId = rec.id;
    aiBuf = ""; aiErr = "";
    const u = st.usage || {};
    aiMeta = `${p.canceled ? "已停止" : "完成"} · ${secs}s · ${text.length} 字${u.total_tokens ? ` · ${u.total_tokens} tokens` : ""}`;
    save();
    renderWHAi();
  }

  function bindWHAi() {
    const q = (sel) => whBody.querySelector(sel);

    q("#fai-cfgbtn").addEventListener("click", () => { aiCfgOpen = !aiCfgOpen; renderWHAi(); });

    // 配置项只监听 change（失焦 / 回车提交），逐键输入不写盘
    ["#fai-url", "#fai-model", "#fai-key", "#fai-maxtok", "#fai-timeout"].forEach((sel) => {
      const el = q(sel);
      if (el) el.addEventListener("change", commitCfgFromDom);
    });

    // 显隐切换只改 type 与按钮文案，不重建 DOM（重建会丢输入焦点）
    const keyEye = q("#fai-keyeye");
    if (keyEye) keyEye.addEventListener("click", () => {
      aiKeyShown = !aiKeyShown;
      const keyEl = q("#fai-key");
      if (keyEl) keyEl.type = aiKeyShown ? "text" : "password";
      keyEye.textContent = aiKeyShown ? "隐藏" : "显示";
    });

    // 生成中「开始分析」不存在、改为「停止」，两者互斥，故各自判空绑定
    const runBtn = q("#fai-run");
    if (runBtn) runBtn.addEventListener("click", runAnalyze);
    const stopBtn = q("#fai-stop");
    if (stopBtn) stopBtn.addEventListener("click", stopAnalyze);

    q("#fai-copy").addEventListener("click", async () => {
      const r = aiCurReport();
      if (!r) { toast("还没有报告"); return; }
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(r.content);
          toast("报告已复制到剪贴板");
        } else {
          toast("当前环境不支持复制，请用「导出 MD」");
        }
      } catch (_) {
        toast("复制失败，请用「导出 MD」");
      }
    });

    q("#fai-export").addEventListener("click", async () => {
      const r = aiCurReport();
      if (!r) { toast("还没有报告"); return; }
      try {
        const saved = await invoke("export_text_file", {
          defaultName: `基金AI分析_${ymd(new Date()).replace(/-/g, "")}.md`,
          content: r.content,
          filterName: "Markdown",
          extensions: ["md"],
        });
        if (saved) toast(`已导出 ${String(saved).split(/[\\/]/).pop()}`);
        else toast("已取消导出");
      } catch (_) {
        toast("导出失败，请重试");
      }
    });

    // 删除作用在「当前查看的那条」上，两段式确认（第一次点击进入确认态，3 秒后自动撤销）
    q("#fai-del").addEventListener("click", () => {
      const cur = aiCurReport();
      if (!cur) return;
      if (aiDelArm !== cur.id) {
        aiDelArm = cur.id;
        renderWHAi();
        setTimeout(() => { if (aiDelArm === cur.id) { aiDelArm = ""; if (whSub === "ai") renderWHAi(); } }, 3000);
        return;
      }
      F.ai.history = F.ai.history.filter((r) => r.id !== cur.id);
      aiDelArm = "";
      if (aiViewId === cur.id) aiViewId = "";
      save(); renderWHAi();
    });

    whBody.querySelectorAll(".fai-chip").forEach((b) => b.addEventListener("click", () => {
      aiViewId = b.dataset.id;
      aiErr = ""; aiDelArm = "";
      renderWHAi();
    }));
  }

  function renderWHWatch() {
    if (!whBody) return;
    whBody.innerHTML = `<div class="fund-block">${watchBlockHTML({ title: "自选列表" })}</div>`;
    bindWatchEvents(whBody);
  }
  function renderWHHold() {
    if (!whBody) return;
    const sum = computeHoldSummary();
    const holdings = sum.holdings;
    let html = `<div class="fund-block"><div class="fund-block-head">
        <span class="fb-title">持仓汇总</span>
        <span class="fb-hint">成本为总成本（份额×单位成本）</span>
        <button class="btn btn-xs" id="fund-newhold">记一笔持仓</button>
      </div>${sum.holdings.length ? summaryCardsHTML(sum) : `<div class="fund-empty">还没有持仓记录</div>`}</div>`;
    html += `<div class="fund-block"><div class="fund-block-head">
        <span class="fb-title">持仓账本</span>
        <span class="fb-hint">市值 = 最新净值 × 份额</span>
        <button class="btn-ghost btn-xs" id="fund-exp-hold" title="导出为 CSV（UTF-8，可直接用 Excel 打开）">导出 CSV</button>
      </div>`;
    if (holdings.length) {
      html += `
        <div class="fund-table-head">
          <span class="fh-name">名称 / 份额</span>
          <span class="fh-val">市值 / 成本</span>
          <span class="fh-val" title="盘中为估算值（点「估」看依据），收盘后为最新净值涨跌">当日收益</span>
          <span class="fh-val">累计盈亏</span>
          <span class="fh-act">操作</span>
        </div>
        <div class="fund-list">
          ${holdings.map((h) => {
            const c = sum.hq[h.id] || calcHolding(h, null);
            const dCls = c.hasData ? pctClass(c.dayPct) : "";
            const estTag = c.daySrc === "fit"
              ? `<i class="fr-est est-open" data-code="${esc(h.code)}" title="${esc(estTagTitle(h.code))}，点击查看依据">估</i>`
              : (c.daySrc === "etf" ? `<i class="fr-est" title="场内 ETF 实时价估算">估</i>` : "");
            return `
            <div class="fund-row" data-code="${esc(h.code)}">
              <div class="fr-name">
                <div class="fr-title">${esc(h.name || h.code)}</div>
                <div class="fr-sub">${esc(h.code)}${c.shares ? ` · ${c.shares.toFixed(2)} 份` : ""}${h.unitCost ? ` · 成本价 ${num(h.unitCost, 0).toFixed(4)}` : ""}</div>
              </div>
              <div class="fr-val">${c.hasData ? fmtMoney(c.market) : "--"}<span class="fr-mkt"> / ${fmtMoney(c.cost)}</span></div>
              <div class="fr-val ${dCls}">
                ${c.hasData ? (c.dayProfit >= 0 ? "+" : "") + fmtMoney(c.dayProfit) : "--"}${estTag}
                ${c.hasData ? `<span class="fr-pct ${dCls}">${fmtPct(c.dayPct)}</span>` : ""}
              </div>
              <div class="fr-val ${c.hasData ? pctClass(c.totalProfit) : ""}">
                ${c.hasData ? (c.totalProfit >= 0 ? "+" : "") + fmtMoney(c.totalProfit) : "--"}
                ${c.hasData ? `<span class="fr-pct ${pctClass(c.totalPct)}">${fmtPct(c.totalPct)}</span>` : ""}
              </div>
              <div class="fr-act">
                <button class="btn-ghost fr-trade" data-code="${esc(h.code)}" data-type="buy">申购</button>
                <button class="btn-ghost fr-trade" data-code="${esc(h.code)}" data-type="sell">赎回</button>
                <button class="btn-ghost fr-trade" data-code="${esc(h.code)}" data-type="div">分红</button>
                <button class="btn-ghost fr-edit" data-code="${esc(h.code)}" title="编辑">编辑</button>
                <button class="btn-ghost fr-delh" data-code="${esc(h.code)}" title="删除持仓">删除</button>
              </div>
            </div>
            ${c.daySrc === "fit" && c.dayEst ? estPanelHTML(c.dayEst) : ""}`;
          }).join("")}
        </div>`;
    } else {
      html += `<div class="fund-empty">还没有持仓记录，点「记一笔持仓」添加</div>`;
    }
    html += `</div>`;
    whBody.innerHTML = html;
    // 「估」标签 → 展开 / 收起估算依据面板
    whBody.querySelectorAll(".est-open").forEach((el) =>
      el.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const p = whBody.querySelector(`.est-panel[data-code="${el.dataset.code}"]`);
        if (p) p.hidden = !p.hidden;
      }));
    whBody.querySelectorAll(".fr-trade").forEach((b) => b.addEventListener("click", () => openTradeDialog(b.dataset.code, b.dataset.type)));
    whBody.querySelectorAll(".fr-edit").forEach((b) => b.addEventListener("click", () => openHoldingDialog(b.dataset.code)));
    whBody.querySelectorAll(".fr-delh").forEach((b) => b.addEventListener("click", () => removeHolding(b.dataset.code)));
    const newhold = whBody.querySelector("#fund-newhold");
    if (newhold) newhold.addEventListener("click", () => openHoldingDialog(""));
    const expHold = whBody.querySelector("#fund-exp-hold");
    if (expHold) expHold.addEventListener("click", () => exportHoldingsCSV());
  }

  // ---------- 穿透分析（自选持仓页第 3 个子页签） ----------
  let ltExpand = false;   // 穿透表是否展开全部股票
  function renderWHLook() {
    if (!whBody) return;
    const holdings = F.holdings || [];
    if (!holdings.length) {
      whBody.innerHTML = `<div class="fund-block"><div class="fund-empty">还没有持仓记录，先在「持仓账本」记一笔</div></div>`;
      return;
    }
    // 首次进入自动拉一次持仓明细（12h 缓存，之后不再重复请求）；失败不重试，改由按钮手动触发
    const stale = holdings.filter((h) => {
      const p = positions(h.code);
      return !p || Date.now() - p.at > TTL_POSITION;
    });
    if (stale.length && !lookLoaded) {
      lookLoaded = true;
      whBody.innerHTML = `<div class="fund-block">
        <div class="fund-block-head"><span class="fb-title">持仓穿透</span></div>
        <div class="look-loading">正在获取 ${stale.length} 只基金的持仓明细…</div>
        <div class="look-hint">穿透依据各基金定期报告披露的持仓（季报为前十大，半年报 / 年报为全量），加载后 12 小时内不再重复请求</div>
      </div>`;
      // ensurePositions 内部逐个 catch，不会 reject（http 失败只表现为「没落缓存」），
      // 故只需一个分支；加载完统一重渲染，「拉不到」与「拉到了但穿不透」都由空态兜住。
      // 防重复重试的守卫是上面的 lookLoaded，不是这个 Promise 的结果。
      ensurePositions(holdings.map((h) => h.code))
        .then(() => { if (whSub === "look") renderWHLook(); });
      return;
    }

    const lt = buildLookThrough(lookRows());
    if (!lt.stocks.length) {
      whBody.innerHTML = `<div class="fund-block">
        <div class="fund-block-head"><span class="fb-title">持仓穿透</span>
          <button class="btn btn-xs" id="look-retry">重新获取持仓明细</button></div>
        <div class="fund-empty">暂无可穿透的持仓明细</div>
        <div class="look-hint">债券型 / 货币型基金不含股票持仓；ETF 联接基金的持仓是母 ETF 而非股票，均无法穿透</div>
      </div>`;
      bindLookEvents();
      return;
    }

    const cc = lt.concentration;
    const top = lt.stocks[0] || {};
    let html = "";

    // ① 穿透概览：集中度
    html += `<div class="fund-block">
      <div class="fund-block-head">
        <span class="fb-title">穿透概览</span>
        <span class="fb-hint">已穿透 ¥${fmtMoney(lt.coveredValue)} / 总市值 ¥${fmtMoney(lt.totalValue)} · 覆盖率 ${(lt.coverage * 100).toFixed(1)}%</span>
        <button class="btn btn-xs" id="look-retry">刷新持仓明细</button>
      </div>
      <div class="fund-summary">
        <div class="fund-sum-card">
          <div class="fsc-label">最大单一持仓</div>
          <div class="fsc-val">${(cc.top1 * 100).toFixed(2)}%</div>
          <div class="fsc-sub">${esc(top.name || "—")}</div>
        </div>
        <div class="fund-sum-card">
          <div class="fsc-label">前五大持仓</div>
          <div class="fsc-val ${cc.top5 >= 0.5 ? "ov-high" : ""}">${(cc.top5 * 100).toFixed(1)}%</div>
        </div>
        <div class="fund-sum-card">
          <div class="fsc-label">前十大持仓</div>
          <div class="fsc-val ${cc.top10 >= 0.7 ? "ov-high" : ""}">${(cc.top10 * 100).toFixed(1)}%</div>
        </div>
        <div class="fund-sum-card">
          <div class="fsc-label">穿透股票数</div>
          <div class="fsc-val">${lt.stocks.length} 只</div>
        </div>
      </div>
      ${cc.top10 >= 0.7 ? `<div class="look-warn">前十大股票占总仓位 ${(cc.top10 * 100).toFixed(1)}%，集中度偏高——几只基金很可能在重复押注同一批标的</div>` : ""}
    </div>`;

    // ② 实际持有的股票
    const rows = ltExpand ? lt.stocks : lt.stocks.slice(0, 20);
    html += `<div class="fund-block">
      <div class="fund-block-head">
        <span class="fb-title">实际持有的股票</span>
        <span class="fb-hint">按「基金持仓市值 × 个股占净值比」聚合</span>
        ${lt.stocks.length > 20 ? `<button class="btn-ghost" id="lt-toggle">${ltExpand ? "收起" : `展开全部 ${lt.stocks.length} 只`}</button>` : ""}
      </div>
      <div class="lt-head"><span>股票</span><span class="lt-r">我的市值</span><span class="lt-r">占总仓位</span><span class="lt-r">今日</span></div>
      <div class="lt-list">
        ${rows.map((s, i) => `
          <div class="lt-row">
            <div class="lt-name">
              <div class="lt-title"><span class="lt-rank">${i + 1}</span>${esc(s.name)}</div>
              <div class="lt-sub">${esc(s.code)}${s.fundCount > 1 ? ` · ${s.fundCount} 只基金共同持有` : ""}</div>
            </div>
            <div class="lt-r">¥${fmtMoney(s.value)}</div>
            <div class="lt-r">${(s.share * 100).toFixed(2)}%</div>
            <div class="lt-r ${pctClass(s.pct)}">${s.pct === null ? "--" : fmtPct(s.pct)}</div>
          </div>`).join("")}
      </div>
    </div>`;

    // ③ 持仓重叠度
    const ov = buildOverlap(lookRows());
    if (ov.length) {
      const strong = ov.filter((p) => p.overlap >= 20);
      const show = strong.length ? strong : ov.slice(0, 3);
      html += `<div class="fund-block">
        <div class="fund-block-head">
          <span class="fb-title">持仓重叠度</span>
          <span class="fb-hint">两只基金各买一半时，押在同一批股票上的仓位比例</span>
        </div>
        <div class="ov-list">
          ${show.map((p) => `
            <div class="ov-row">
              <span class="ov-pair">${esc(p.aName)}<i> × </i>${esc(p.bName)}</span>
              <span class="ov-shared">共同持仓 ${p.shared} 只</span>
              <span class="ov-val${p.overlap >= 40 ? " ov-high" : ""}">${p.overlap.toFixed(1)}%</span>
            </div>`).join("")}
        </div>
        ${strong.length ? `<div class="look-warn">有 ${strong.length} 组基金的持仓重叠 ≥ 20%，分散效果可能低于预期</div>` : `<div class="look-hint">各基金持仓重叠度均低于 20%，分散效果良好</div>`}
      </div>`;
    }

    // ④ 当日收益归因
    const attr = holdings
      .map((h) => ({ h, c: calcHolding(h, getQuote(h.code)) }))
      .filter((x) => x.c.hasData && Math.abs(x.c.dayProfit) > 0.005)
      .sort((a, b) => Math.abs(b.c.dayProfit) - Math.abs(a.c.dayProfit));
    if (attr.length) {
      const maxAbs = Math.max(...attr.map((x) => Math.abs(x.c.dayProfit)));
      const sumDay = attr.reduce((a, x) => a + x.c.dayProfit, 0);
      html += `<div class="fund-block">
        <div class="fund-block-head">
          <span class="fb-title">当日收益归因</span>
          <span class="fb-hint">合计 <b class="${pctClass(sumDay)}">${sumDay >= 0 ? "+" : ""}${fmtMoney(sumDay)}</b></span>
        </div>
        <div class="attr-list">
          ${attr.map((x) => {
            const up = x.c.dayProfit >= 0;
            const w = maxAbs > 0 ? (Math.abs(x.c.dayProfit) / maxAbs) * 100 : 0;
            return `<div class="attr-row">
              <span class="attr-name">${esc(x.h.name || x.h.code)}</span>
              <span class="attr-track"><i class="${up ? "attr-up" : "attr-down"}" style="width:${Math.max(2, w).toFixed(1)}%"></i></span>
              <span class="attr-val ${pctClass(x.c.dayProfit)}">${up ? "+" : ""}${fmtMoney(x.c.dayProfit)}<i>${fmtPct(x.c.dayPct)}</i></span>
            </div>`;
          }).join("")}
        </div>
      </div>`;
    }

    whBody.innerHTML = html;
    bindLookEvents();
  }
  function bindLookEvents() {
    if (!whBody) return;
    const t = whBody.querySelector("#lt-toggle");
    if (t) t.addEventListener("click", () => { ltExpand = !ltExpand; renderWHLook(); });
    const r = whBody.querySelector("#look-retry");
    if (r) r.addEventListener("click", () => {
      lookLoaded = false;
      clearPositions();  // 强制重取持仓明细（用户主动刷新）
      renderWHLook();
    });
  }
  function renderWHTrades() {
    if (!whBody) return;
    const trades = F.trades || [];
    let html = `<div class="fund-block"><div class="fund-block-head">
        <span class="fb-title">交易流水</span>
        <span class="fb-hint">${trades.length} 笔${trades.length > 30 ? "（下方只显示最近 30 笔，导出为全部）" : ""}</span>
        <button class="btn-ghost btn-xs" id="fund-exp-trades" title="导出全部流水为 CSV（按日期升序）">导出 CSV</button>
      </div>`;
    if (trades.length) {
      html += `<div class="fund-list fund-trades">`;
      html += trades.slice(0, 30).map((t) => {
        const tt = TRADE_TYPES[t.type] || { label: t.type, cls: "" };
        const amtCls = t.type === "sell" ? "fund-pct-down" : "fund-pct-up";
        return `
        <div class="fund-row trade-row" data-id="${esc(t.id)}">
          <div class="fr-name">
            <div class="fr-title"><span class="badge ${tt.cls}">${tt.label}</span>${t.auto ? `<span class="badge badge-purple" title="${esc(t.note || "定投自动记账")}">定投</span>` : ""} ${esc(t.name || t.code)}</div>
            <div class="fr-sub">${esc(t.date || "")} · ${esc(t.code)}${t.auto && t.note ? ` · ${esc(t.note)}` : ""}</div>
          </div>
          <div class="fr-val">
            <div class="${amtCls}">${t.type === "sell" ? "-" : "+"}¥${fmtMoney(t.amount || 0)}</div>
            <div class="fr-sub">${t.shares ? (t.shares > 0 ? "+" : "") + t.shares.toFixed(2) + " 份" : (t.type === "div" ? "现金分红" : "")}</div>
          </div>
          <div class="fr-act"><button class="btn-ghost tr-del" data-id="${esc(t.id)}" title="删除">删除</button></div>
        </div>`;
      }).join("");
      html += `</div>`;
    } else {
      html += `<div class="fund-empty">暂无交易流水</div>`;
    }
    html += `</div>`;
    whBody.innerHTML = html;
    whBody.querySelectorAll(".tr-del").forEach((b) => b.addEventListener("click", () => removeTrade(b.dataset.id)));
    const expTrades = whBody.querySelector("#fund-exp-trades");
    if (expTrades) expTrades.addEventListener("click", () => exportTradesCSV());
  }

  // ---------- 定投计划（自选持仓页第 4 个子页签） ----------
  // 按月折算的定投额，用于「每月合计」。周投 ×52/12；月投即面额。
  // 日投只能按**交易日**折算：一年约 244 个交易日（= 244/12 ≈ 20.3 期/月），
  // 不是 365/12（≈30.4 期/月）—— 后者把周末与节假日也算成扣款日，会高估约 50%。
  function planMonthlyAmount(plan) {
    const a = num(plan.amount, 0);
    if (plan.cycle === "day") return Math.round((a * PLAN_TRADE_DAYS) / 12);
    if (plan.cycle === "week") return Math.round((a * 52) / 12);
    return a;
  }
  function planCardHTML(row) {
    const p = row.p, st = row.st, pending = row.pending;
    const off = p.enabled === false;
    const cls = st.hasData ? pctClass(st.profit) : "";
    const next = off ? "" : planNextDate(p);
    return `
      <div class="plan-card${off ? " plan-off" : ""}" data-id="${esc(p.id)}">
        <div class="plan-head">
          <div class="plan-title">
            <span class="plan-name">${esc(p.name || p.code)}</span>
            <span class="plan-code">${esc(p.code)}</span>
          </div>
          <div class="plan-tags">
            <span class="badge badge-blue">${esc(planDayLabel(p))}</span>
            <span class="badge">¥${fmtMoney(num(p.amount, 0))} / 期</span>
            ${off ? `<span class="badge">已暂停</span>` : ""}
            ${pending ? `<span class="badge badge-amber" title="已到期但净值未取到，稍后自动重试">待扣款 ${pending} 期</span>` : ""}
          </div>
        </div>
        <div class="plan-metrics">
          <div class="plan-m"><span>累计投入</span><b>¥${fmtMoney(st.invested)}</b></div>
          <div class="plan-m"><span>累计份额</span><b>${st.shares ? st.shares.toFixed(2) : "--"}</b></div>
          <div class="plan-m"><span>平均成本</span><b>${st.avgCost ? st.avgCost.toFixed(4) : "--"}</b></div>
          <div class="plan-m"><span>当前市值</span><b>${st.hasData ? "¥" + fmtMoney(st.market) : "--"}</b></div>
          <div class="plan-m"><span>累计收益</span><b class="${cls}">${st.hasData ? (st.profit >= 0 ? "+" : "") + "¥" + fmtMoney(st.profit) : "--"}</b></div>
          <div class="plan-m"><span>收益率</span><b class="${cls}">${st.hasData && st.pct !== null ? fmtPct(st.pct) : "--"}</b></div>
          <div class="plan-m"><span>年化</span><b class="${st.annual === null ? "" : pctClass(st.annual)}"${st.annual === null ? ` title="期数或持有期不足，年化无统计意义"` : ""}>${st.annual === null ? "--" : fmtPct(st.annual)}</b></div>
          <div class="plan-m"><span>已投期数</span><b>${st.count} 期</b></div>
        </div>
        <div class="plan-foot">
          <span class="plan-next">${off ? "已暂停，不再自动扣款" : next ? `下次扣款 ${esc(next)}` : "—"}</span>
          <div class="plan-acts">
            ${pending ? `<button class="btn-ghost plan-retry" data-id="${esc(p.id)}">重试扣款</button>` : ""}
            <button class="btn-ghost plan-edit" data-id="${esc(p.id)}">编辑</button>
            <button class="btn-ghost plan-toggle" data-id="${esc(p.id)}">${off ? "启用" : "暂停"}</button>
            <button class="btn-ghost plan-del${planDelArm === p.id ? " plan-del-armed" : ""}" data-id="${esc(p.id)}"${planDelArm === p.id ? ` title="已产生的流水与持仓会保留"` : ""}>${planDelArm === p.id ? "确认删除？" : "删除"}</button>
          </div>
        </div>
      </div>`;
  }
  function renderWHPlans() {
    if (!whBody) return;
    const plans = F.plans || [];
    const rows = plans.map((p) => ({ p, st: planStats(p), pending: planPendingDates(p).length }));
    const active = rows.filter((r) => r.p.enabled !== false);
    const totalInvested = rows.reduce((s, r) => s + r.st.invested, 0);
    const totalMarket = rows.reduce((s, r) => s + r.st.market, 0);
    const monthly = active.reduce((s, r) => s + planMonthlyAmount(r.p), 0);
    const profit = totalMarket - totalInvested;
    const hasMarket = rows.some((r) => r.st.hasData);
    let html = `<div class="fund-block"><div class="fund-block-head">
        <span class="fb-title">定投计划</span>
        <span class="fb-hint">${active.length} 个进行中${plans.length - active.length ? ` · ${plans.length - active.length} 个已暂停` : ""} · 每月合计 ¥${fmtMoney(monthly)}</span>
        <span class="fb-acts">
          <button class="btn-ghost btn-xs" id="fund-exp-plans" title="导出定投计划为 CSV">导出 CSV</button>
          <button class="btn btn-xs" id="fund-newplan">新建定投</button>
        </span>
      </div>`;
    if (rows.length) {
      html += `<div class="plan-sum">
          <div class="plan-sum-i"><span>累计投入</span><b>¥${fmtMoney(totalInvested)}</b></div>
          <div class="plan-sum-i"><span>当前市值</span><b>${hasMarket ? "¥" + fmtMoney(totalMarket) : "--"}</b></div>
          <div class="plan-sum-i"><span>累计收益</span><b class="${hasMarket ? pctClass(profit) : ""}">${hasMarket ? (profit >= 0 ? "+" : "") + "¥" + fmtMoney(profit) : "--"}</b></div>
          <div class="plan-sum-i"><span>收益率</span><b class="${hasMarket && totalInvested > 0 ? pctClass(profit) : ""}">${hasMarket && totalInvested > 0 ? fmtPct((profit / totalInvested) * 100) : "--"}</b></div>
        </div>`;
      html += `<div class="plan-list">${rows.map(planCardHTML).join("")}</div>`;
      html += `<div class="field-hint">计划收益只统计「该计划自动记账产生的申购」；你在该基金上的手动赎回 / 分红不计入计划，仍体现在持仓账本里。</div>`;
    } else {
      html += `<div class="fund-empty">还没有定投计划，点「新建定投」开始一笔</div>`;
    }
    html += `</div>`;
    whBody.innerHTML = html;
    const nb = whBody.querySelector("#fund-newplan");
    if (nb) nb.addEventListener("click", () => openPlanDialog(""));
    const expPlans = whBody.querySelector("#fund-exp-plans");
    if (expPlans) expPlans.addEventListener("click", () => exportPlansCSV());
    whBody.querySelectorAll(".plan-edit").forEach((b) => b.addEventListener("click", () => openPlanDialog(b.dataset.id)));
    whBody.querySelectorAll(".plan-toggle").forEach((b) => b.addEventListener("click", () => togglePlan(b.dataset.id)));
    whBody.querySelectorAll(".plan-del").forEach((b) => b.addEventListener("click", () => removePlan(b.dataset.id)));
    whBody.querySelectorAll(".plan-retry").forEach((b) => b.addEventListener("click", () => {
      b.disabled = true;
      b.textContent = "重试中…";
      // 这里必须自己兜一次重渲染：runDuePlans 在「本轮既没记账也没跳过」时（净值仍未公布）
      // 不会重渲染，否则按钮会一直卡在禁用的「重试中…」。它与 ensurePositions 不同 ——
      // runDuePlans 内部是 try/finally 而非逐个 catch，仍可能 reject，所以两条分支都要接。
      const back = () => { if (whSub === "plans") renderWHPlans(); };
      runDuePlans().then(back).catch(back);
    }));
  }
  function togglePlan(id) {
    const p = (F.plans || []).find((x) => x.id === id);
    if (!p) return;
    const resuming = p.enabled === false;
    // 恢复前先数一下会作废多少期（算完再改 runFrom，否则数出来是 0）。
    // 这里传 Infinity 绕过 PLAN_MAX_CATCHUP：补记上限是「一次最多写多少流水」的保护，
    // 而这句话是给用户看的账目说明，必须准确 —— 暂停两年的日投不能只说「24 期」。
    const lapsed = resuming ? planDueDates(p, todayDate(), Infinity).length : 0;
    p.enabled = resuming;
    if (resuming) {
      // 恢复不补记：把起算日推回今天，暂停期间的期次直接作废。
      // 暂停的语义就是「期间不再自动扣款」（见下方文案），若恢复时按调度规则补记，
      // 暂停半年会瞬间写入二十几笔并不存在的申购，账目与语义同时对不上。
      p.runFrom = todayStr();
    }
    save();
    renderWHPlans();
    if (resuming) {
      runDuePlans().catch(() => {});
      setStatus(lapsed ? `定投已启用，暂停期间 ${lapsed} 期不再补记` : "定投已启用", "ok");
    } else setStatus("定投已暂停，期间不再自动扣款", "ok");
  }
  // 删除用两段式按钮确认（宿主内没有原生 confirm 的先例，避免不同 WebView 行为不一致）
  let planDelArm = "";
  let planDelTimer = 0;
  function removePlan(id) {
    const p = (F.plans || []).find((x) => x.id === id);
    if (!p) return;
    if (planDelArm !== id) {
      planDelArm = id;
      clearTimeout(planDelTimer);
      planDelTimer = setTimeout(() => {
        if (planDelArm === id) { planDelArm = ""; if (whSub === "plans") renderWHPlans(); }
      }, 4000);
      renderWHPlans();
      return;
    }
    clearTimeout(planDelTimer);
    planDelArm = "";
    // 只删计划本身：已产生的申购流水与持仓保留（它们是账目事实）
    F.plans = (F.plans || []).filter((x) => x.id !== id);
    save();
    renderWHPlans();
    setStatus("定投计划已删除（已产生的流水与持仓保留）", "ok");
  }

  // 新建 / 编辑定投计划
  function openPlanDialog(planId) {
    const editing = (F.plans || []).find((x) => x.id === planId) || null;
    const ov = document.createElement("div");
    ov.className = "task-modal-overlay";
    const wk = F.watchlist || [];
    ov.innerHTML = `
      <div class="task-modal fund-modal">
        <h3>${editing ? "编辑定投" : "新建定投"}</h3>
        <div class="tm-field">
          <label class="field-label">基金</label>
          <select class="select" id="fund-p-code">
            ${wk.length ? `` : `<option value="">（自选为空，请手动填写代码）</option>`}
            ${wk.map((w) => `<option value="${esc(w.code)}"${editing && editing.code === w.code ? " selected" : ""}>${esc(w.name || w.code)} · ${esc(w.code)}</option>`).join("")}
          </select>
        </div>
        <div class="tm-row">
          <div class="tm-field">
            <label class="field-label">基金代码</label>
            <input class="input" id="fund-p-raw" value="${esc(editing ? editing.code : "")}" placeholder="6 位代码" />
          </div>
          <div class="tm-field">
            <label class="field-label">名称（可选）</label>
            <input class="input" id="fund-p-name" value="${esc(editing ? editing.name || "" : "")}" placeholder="留空则取代码" />
          </div>
        </div>
        <div class="tm-row">
          <div class="tm-field">
            <label class="field-label">每期金额（元）</label>
            <input class="input" id="fund-p-amount" type="number" step="1" min="0" value="${editing ? num(editing.amount, 0) : 500}" />
          </div>
          <div class="tm-field">
            <label class="field-label">周期</label>
            <select class="select" id="fund-p-cycle">
              ${PLAN_CYCLES.map((c) => `<option value="${c.id}"${editing && editing.cycle === c.id ? " selected" : (!editing && c.id === "month" ? " selected" : "")}>${c.label}</option>`).join("")}
            </select>
          </div>
        </div>
        <div class="tm-row">
          <div class="tm-field">
            <label class="field-label">扣款日</label>
            <select class="select" id="fund-p-day"></select>
          </div>
          <div class="tm-field">
            <label class="field-label">开始日期</label>
            <input class="input" id="fund-p-start" type="date" value="${esc(editing ? editing.startDate : ymd(new Date()))}" />
          </div>
        </div>
        <div class="field-hint" id="fund-p-hint"></div>
        <div class="tm-actions">
          <button class="btn" id="fund-p-cancel">取消</button>
          <button class="btn-primary" id="fund-p-ok">${editing ? "保存" : "创建"}</button>
        </div>
      </div>`;
    document.body.appendChild(ov);
    const selEl = ov.querySelector("#fund-p-code");
    const rawEl = ov.querySelector("#fund-p-raw"), nameEl = ov.querySelector("#fund-p-name");
    const amtEl = ov.querySelector("#fund-p-amount"), cycEl = ov.querySelector("#fund-p-cycle");
    const dayEl = ov.querySelector("#fund-p-day"), startEl = ov.querySelector("#fund-p-start");
    const hintEl = ov.querySelector("#fund-p-hint");
    // 说明文案必须随周期变：日投与月/周投的**非交易日规则不同**
    // （日投每天都要扣，遇非交易日直接跳过；月/周投顺延到下一交易日、按该交易日净值补记）
    const fillHint = () => {
      hintEl.innerHTML = cycEl.value === "day"
        ? "每个交易日到期时按<b>当天净值</b>自动折算份额并记一笔申购；<b>周末与法定节假日不扣款</b>（不顺延）。<b>本模块不做资金代扣</b>，仅为记账。"
        : "到期后按「扣款日当天的净值」自动折算份额并记一笔申购；扣款日遇非交易日（周末 / 节假日）<b>顺延到下一交易日</b>，按该交易日净值记账，流水日期也记在该交易日。<b>本模块不做资金代扣</b>，仅为记账。";
    };
    // 扣款日选项随周期切换（每日无扣款日可选 / 每周 1-7 / 每月 1-28）
    const fillDays = (keep) => {
      const want = keep !== undefined ? String(keep) : dayEl.value;
      if (cycEl.value === "day") {
        dayEl.innerHTML = `<option value="1">每个交易日（周末与节假日不扣）</option>`;
        dayEl.value = "1";
        dayEl.disabled = true;
        return;
      }
      dayEl.disabled = false;
      if (cycEl.value === "week") {
        dayEl.innerHTML = PLAN_WEEKDAYS.map((w, i) => `<option value="${i + 1}">${w}</option>`).join("");
        dayEl.value = /^[1-7]$/.test(want) ? want : "1";
      } else {
        dayEl.innerHTML = Array.from({ length: 28 }, (_, i) => `<option value="${i + 1}">每月 ${i + 1} 日</option>`).join("");
        dayEl.value = /^\d{1,2}$/.test(want) && Number(want) >= 1 && Number(want) <= 28 ? want : "1";
      }
    };
    fillDays(editing ? editing.day : undefined);
    fillHint();
    cycEl.addEventListener("change", () => { fillDays(undefined); fillHint(); });
    // 选自选自动带出代码与名称（仍可手动改）
    if (selEl && selEl.options.length) {
      selEl.addEventListener("change", () => {
        const w = wk.find((x) => x.code === selEl.value);
        if (!w) return;
        rawEl.value = w.code;
        nameEl.value = w.name || "";
      });
      if (!editing && selEl.value) {
        const w = wk.find((x) => x.code === selEl.value);
        if (w) { rawEl.value = w.code; nameEl.value = w.name || ""; }
      }
    }
    const close = () => ov.remove();
    ov.querySelector("#fund-p-cancel").addEventListener("click", close);
    ov.addEventListener("click", (e) => { if (e.target === ov) close(); });
    ov.addEventListener("keydown", (e) => {
      if (e.key === "Escape") close();
      else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) ov.querySelector("#fund-p-ok").click();
    });
    ov.querySelector("#fund-p-ok").addEventListener("click", () => {
      const code = rawEl.value.trim();
      const amount = num(amtEl.value, 0);
      const start = startEl.value || ymd(new Date());
      if (!/^\d{6}$/.test(code)) { rawEl.focus(); return; }
      if (amount <= 0) { amtEl.focus(); return; }
      if (!parseYmd(start)) { startEl.focus(); return; }
      const name = nameEl.value.trim() || code;
      const payload = {
        code, name, amount,
        cycle: planCycleOf(cycEl.value),
        day: num(dayEl.value, 1),
        startDate: start,
      };
      if (editing) {
        Object.assign(editing, payload);
        // 起算日只许往后推，绝不回退到已越过的时间：回退会把此前「已作废 / 已记账」的期次
        // 重新纳入枚举并重复记账（旧实现在这里清空 lastPaidDate，正是这个后果）。
        // 期次枚举本身取 startDate / runFrom / lastPaidDate+1 三者的最大值，改晚起投日
        // 会自动抬高枚举起点，无需清锚点。
        editing.runFrom = laterYmd(editing.runFrom, payload.startDate);
      } else {
        // 新建：起算日 = 今天。今天之前的期次一律不补记 —— 用户填一个过去的开始日期时，
        // 不该被立刻补记成一堆并不存在的申购；而今天这一期仍然有效：若今天不是扣款日、
        // 或今天的净值还没公布，runDuePlans 会自然地什么都不做或挂起等待。
        F.plans.push({
          id: uid("p_"), ...payload,
          enabled: true,
          runFrom: todayStr(),
          lastPaidDate: "",
          createdAt: Date.now(),
        });
      }
      save();
      close();
      if (whSub === "plans") renderWHPlans();
      renderAll();
      runDuePlans().catch(() => {});
      setStatus(editing ? "定投计划已保存" : "定投计划已创建，到期自动记账", "ok");
    });
    setTimeout(() => amtEl.focus(), 50);
  }

  // ---------- 市场排行页 ----------
  let rankSort = "1nzf";
  let rankFtype = "all";
  function renderRankShell() {
    panelRank.innerHTML = `
      <div class="fund-block">
        <div class="fund-block-head">
          <div class="rank-sorts">
            ${RANK_SORTS.map((s) => `<button class="rank-sort${s.id === rankSort ? " active" : ""}" data-sort="${s.id}">${s.label}</button>`).join("")}
          </div>
          <div class="rank-types">
            <select class="select" id="fund-rank-ftype">
              ${FTYPES.map((f) => `<option value="${f.v}"${f.v === rankFtype ? " selected" : ""}>${f.label}</option>`).join("")}
            </select>
          </div>
        </div>
        <div class="rank-result" id="fund-rank-result"><div class="fund-empty">加载中…</div></div>
      </div>`;
    panelRank.querySelectorAll(".rank-sort").forEach((b) =>
      b.addEventListener("click", () => { rankSort = b.dataset.sort; rankFtype = rankFtype || "all"; renderRankShell(); loadRank(); }));
    panelRank.querySelector("#fund-rank-ftype").addEventListener("change", (e) => { rankFtype = e.target.value; renderRankShell(); loadRank(); });
  }
  async function loadRank() {
    if (currentTab !== "rank") return;
    const el = panelRank.querySelector("#fund-rank-result");
    if (!el) return;
    el.innerHTML = `<div class="fund-empty">加载中…</div>`;
    try {
      const list = await fetchRank(rankSort, rankFtype);
      if (!list.length) { el.innerHTML = `<div class="fund-empty">暂无数据，试试切换排序或类型</div>`; return; }
      el.innerHTML = `
        <div class="fund-table-head">
          <span class="fh-rank">#</span>
          <span class="fh-name">名称 / 代码</span>
          <span class="fh-val">${(RANK_SORTS.find((s) => s.id === rankSort) || {}).label || "涨幅"}</span>
          <span class="fh-val">类型</span>
          <span class="fh-act">操作</span>
        </div>
        <div class="fund-list">
          ${list.slice(0, 50).map((r, i) => {
            const inWatch = (F.watchlist || []).some((w) => w.code === r.code);
            const inHold = (F.holdings || []).some((h) => h.code === r.code);
            return `
            <div class="fund-row" data-code="${esc(r.code)}">
              <div class="fr-rank">${i + 1}</div>
              <div class="fr-name">
                <div class="fr-title">${esc(r.name || r.code)}</div>
                <div class="fr-sub">${esc(r.code)}${inHold ? ' · <span class="fr-held">持仓中</span>' : ""}</div>
              </div>
              <div class="fr-val ${pctClass(r.sortVal)}">${fmtPct(r.sortVal)}</div>
              <div class="fr-val"><span class="fr-type">${esc(r.type || "--")}</span></div>
              <div class="fr-act">
                ${inWatch
                  ? `<button class="btn-ghost fr-rmwatch" data-code="${esc(r.code)}" title="移出自选">已自选</button>`
                  : `<button class="btn-ghost fr-addwatch" data-code="${esc(r.code)}" data-name="${esc(r.name || "")}" data-type="${esc(r.type || "")}" title="加入自选">加入自选</button>`}
                <button class="btn-ghost fr-chart" data-code="${esc(r.code)}" title="净值走势">走势</button>
              </div>
            </div>`;
          }).join("")}
        </div>`;
      el.querySelectorAll(".fr-addwatch").forEach((b) =>
        b.addEventListener("click", () => addWatch(b.dataset.code, b.dataset.name, b.dataset.type)));
      el.querySelectorAll(".fr-rmwatch").forEach((b) =>
        b.addEventListener("click", () => removeWatch(b.dataset.code)));
      el.querySelectorAll(".fr-chart").forEach((b) =>
        b.addEventListener("click", () => openChart(b.dataset.code)));
    } catch (e) {
      el.innerHTML = `<div class="fund-empty">排行加载失败：${esc(String(e && e.message || e))}</div>`;
    }
  }

// ---------- 基金搜索页 ----------
  function renderSearchShell() {
    panelSearch.innerHTML = `
      <div class="fund-block">
        <div class="fund-block-head">
          <div class="search-row">
            <input class="input" id="fund-search-input" placeholder="输入基金代码或名称，如 110022 / 易方达" autocomplete="off" spellcheck="false" />
            <button class="btn-primary" id="fund-search-btn">搜索</button>
          </div>
        </div>
        <div class="search-result" id="fund-search-result">
          <div class="fund-empty">支持 6 位代码精确匹配或名称模糊搜索，点结果可加入自选</div>
        </div>
      </div>`;
    searchInputEl = panelSearch.querySelector("#fund-search-input");
    const btn = panelSearch.querySelector("#fund-search-btn");
    const doSearch = () => {
      const kw = searchInputEl.value.trim();
      if (!kw) { searchInputEl.focus(); return; }
      runSearch(kw);
    };
    btn.addEventListener("click", doSearch);
    searchInputEl.addEventListener("keydown", (e) => {
      if (e.isComposing || e.key !== "Enter") return;
      e.preventDefault();
      doSearch();
    });
    if (searchInputEl) searchInputEl.focus();
  }
  async function runSearch(kw) {
    const el = panelSearch.querySelector("#fund-search-result");
    el.innerHTML = `<div class="fund-empty">搜索中…</div>`;
    try {
      const list = await searchFund(kw);
      if (!list.length) { el.innerHTML = `<div class="fund-empty">没有匹配的基金，换个关键词试试</div>`; return; }
      el.innerHTML = `
        <div class="fund-table-head">
          <span class="fh-name">名称 / 代码</span>
          <span class="fh-val">类型</span>
          <span class="fh-act">操作</span>
        </div>
        <div class="fund-list">
          ${list.map((r) => {
            const inWatch = (F.watchlist || []).some((w) => w.code === r.code);
            return `
            <div class="fund-row" data-code="${esc(r.code)}">
              <div class="fr-name">
                <div class="fr-title">${esc(r.name || r.code)}</div>
                <div class="fr-sub">${esc(r.code)}</div>
              </div>
              <div class="fr-val"><span class="fr-type">${esc(r.type || "--")}</span></div>
              <div class="fr-act">
                ${inWatch
                  ? `<button class="btn-ghost fr-rmwatch" data-code="${esc(r.code)}" title="移出自选">已自选</button>`
                  : `<button class="btn btn-primary btn-xs fr-addwatch" data-code="${esc(r.code)}" data-name="${esc(r.name || "")}" data-type="${esc(r.type || "")}">加入自选</button>`}
              </div>
            </div>`;
          }).join("")}
        </div>`;
      el.querySelectorAll(".fr-addwatch").forEach((b) =>
        b.addEventListener("click", () => addWatch(b.dataset.code, b.dataset.name, b.dataset.type)));
      el.querySelectorAll(".fr-rmwatch").forEach((b) =>
        b.addEventListener("click", () => removeWatch(b.dataset.code)));
    } catch (e) {
      el.innerHTML = `<div class="fund-empty">搜索失败：${esc(String(e && e.message || e))}</div>`;
    }
  }

// ---------- 增删改 ----------
  function addWatch(code, name, type) {
    const c = String(code || "").trim();
    if (!c) return;
    if ((F.watchlist || []).some((w) => w.code === c)) { setStatus("已在自选中", "ok"); return; }
    F.watchlist.push({ id: uid("w_"), code: c, name: name || c, type: type || "", addedAt: Date.now() });
    save();
    renderAll();
    setStatus(`已添加自选：${name || c}`, "ok");
    refreshQuotes([c]);
  }
  function removeWatch(code) {
    F.watchlist = (F.watchlist || []).filter((w) => w.code !== code);
    save();
    renderAll();
  }
  function removeHolding(code) {
    F.holdings = (F.holdings || []).filter((h) => h.code !== code);
    save();
    renderAll();
  }
  function removeTrade(id) {
    F.trades = (F.trades || []).filter((t) => t.id !== id);
    save();
    renderWH();
  }

// 持仓弹窗（新增 / 编辑）
  async function openHoldingDialog(code) {
    const existing = (F.holdings || []).find((h) => h.code === code);
    const watch = (F.watchlist || []).find((w) => w.code === code);
    const ov = document.createElement("div");
    ov.className = "task-modal-overlay";
    ov.innerHTML = `
      <div class="task-modal fund-modal">
        <h3>${existing ? "编辑持仓" : "记一笔持仓"}</h3>
        <div class="tm-field">
          <label class="field-label">基金代码</label>
          <input class="input" id="fund-fh-code" value="${esc(code)}" placeholder="6 位基金代码" />
        </div>
        <div class="tm-field">
          <label class="field-label">基金名称</label>
          <input class="input" id="fund-fh-name" value="${esc((existing && existing.name) || (watch && watch.name) || "")}" placeholder="名称" />
        </div>
        <div class="tm-row">
          <div class="tm-field">
            <label class="field-label">持有份额</label>
            <input class="input" id="fund-fh-shares" type="number" step="0.01" min="0" value="${existing ? existing.shares : ""}" placeholder="1234.56" />
          </div>
          <div class="tm-field">
            <label class="field-label">单位成本（元/份）</label>
            <input class="input" id="fund-fh-unit" type="number" step="0.0001" min="0" value="${existing ? existing.unitCost || "" : ""}" placeholder="买入时净值，如 1.0200" />
          </div>
        </div>
        <div class="field-hint">总成本 = 份额 × 单位成本；市值 = 最新净值 × 份额（均自动计算）。</div>
        <div class="tm-actions">
          <button class="btn" id="fund-fh-cancel">取消</button>
          <button class="btn-primary" id="fund-fh-ok">保存</button>
        </div>
      </div>`;
    document.body.appendChild(ov);
    const codeEl = ov.querySelector("#fund-fh-code"), nameEl = ov.querySelector("#fund-fh-name");
    const sharesEl = ov.querySelector("#fund-fh-shares"), unitEl = ov.querySelector("#fund-fh-unit");
    const close = () => ov.remove();
    ov.querySelector("#fund-fh-cancel").addEventListener("click", close);
    ov.addEventListener("click", (e) => { if (e.target === ov) close(); });
    ov.addEventListener("keydown", (e) => {
      if (e.key === "Escape") close();
      else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) ov.querySelector("#fund-fh-ok").click();
    });
    ov.querySelector("#fund-fh-ok").addEventListener("click", () => {
      const c = codeEl.value.trim();
      const shares = num(sharesEl.value, 0);
      const unitCost = num(unitEl.value, 0);
      // 总成本 = 份额 × 单位成本（持仓只记份额和单位成本）
      const cost = shares * unitCost;
      if (!/^\d{6}$/.test(c)) { codeEl.focus(); return; }
      if (shares <= 0) { sharesEl.focus(); return; }
      if (unitCost <= 0) { unitEl.focus(); return; }
      const idx = F.holdings.findIndex((h) => h.code === c);
      if (existing) {
        existing.code = c; existing.name = nameEl.value.trim() || c;
        existing.shares = shares; existing.cost = cost; existing.unitCost = unitCost;
        delete existing.marketValue; delete existing.marketValueSet;
      } else if (idx >= 0) {
        F.holdings[idx].shares = shares; F.holdings[idx].cost = cost; F.holdings[idx].unitCost = unitCost;
        F.holdings[idx].name = nameEl.value.trim() || c;
        delete F.holdings[idx].marketValue; delete F.holdings[idx].marketValueSet;
      } else {
        F.holdings.push({ id: uid("h_"), code: c, name: nameEl.value.trim() || c, shares, cost, unitCost, addedAt: Date.now() });
      }
      if (!(F.watchlist || []).some((w) => w.code === c)) {
        F.watchlist.push({ id: uid("w_"), code: c, name: nameEl.value.trim() || c, addedAt: Date.now() });
      }
      save();
      close();
      renderAll();
      refreshQuotes([c]);
    });
    setTimeout(() => sharesEl.focus(), 50);
  }

  // 交易弹窗（申购 / 赎回 / 分红）
  function openTradeDialog(code, type) {
    const t = TRADE_TYPES[type] || { label: type };
    const h = (F.holdings || []).find((x) => x.code === code);
    const w = (F.watchlist || []).find((x) => x.code === code);
    const navNow = getQuote(code);
    const ov = document.createElement("div");
    ov.className = "task-modal-overlay";
    ov.innerHTML = `
      <div class="task-modal fund-modal">
        <h3>${t.label} · ${esc((h && h.name) || (w && w.name) || code)}</h3>
        <div class="fund-modal-info">代码 ${esc(code)}${navNow ? ` · 最新净值 <b>${num(navNow.nav ?? navNow.dwjz, 0).toFixed(4)}</b>${navNow.gztime ? `（${esc(navNow.gztime)}）` : ""}` : ""}</div>
        <div class="tm-field">
          <label class="field-label">${type === "div" ? "分红金额（元）" : "金额（元）"}</label>
          <input class="input" id="fund-ft-amount" type="number" step="0.01" min="0" placeholder="0.00" />
        </div>
        ${type !== "div" ? `
        <div class="tm-field">
          <label class="field-label">${type === "sell" ? "赎回份额" : "获得份额"}</label>
          <input class="input" id="fund-ft-shares" type="number" step="0.01" min="0" placeholder="按金额自动折算，可留空" />
        </div>` : ""}
        <div class="tm-field">
          <label class="field-label">交易日期</label>
          <input class="input" id="fund-ft-date" type="date" value="${ymd(new Date())}" />
        </div>
        <div class="tm-actions">
          <button class="btn" id="fund-ft-cancel">取消</button>
          <button class="btn-primary" id="fund-ft-ok">${t.label}</button>
        </div>
      </div>`;
    document.body.appendChild(ov);
    const amtEl = ov.querySelector("#fund-ft-amount"), sharesEl = ov.querySelector("#fund-ft-shares"), dateEl = ov.querySelector("#fund-ft-date");
    const close = () => ov.remove();
    ov.querySelector("#fund-ft-cancel").addEventListener("click", close);
    ov.addEventListener("click", (e) => { if (e.target === ov) close(); });
    ov.addEventListener("keydown", (e) => {
      if (e.key === "Escape") close();
      else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) ov.querySelector("#fund-ft-ok").click();
    });
    ov.querySelector("#fund-ft-ok").addEventListener("click", () => {
      const amount = num(amtEl.value, 0);
      let shares = sharesEl ? num(sharesEl.value, 0) : 0;
      if (amount <= 0) { amtEl.focus(); return; }
      const nav = navNow ? num(navNow.nav ?? navNow.dwjz, 0) : 0;
      // 份额留空时按净值折算；行情未加载（nav=0）不能静默记账，
      // 否则会出现「份额=0、成本=全额」→ 市值 0 / 盈亏 -100% 的错误持仓
      if (shares <= 0 && type !== "div") {
        if (nav > 0) {
          shares = amount / nav;
        } else {
          amtEl.focus();
          const hint = sharesEl;
          if (hint) hint.setAttribute("placeholder", "行情未加载，请先刷新或手动填写份额");
          return;
        }
      }
      const name = (h && h.name) || (w && w.name) || code;
      const date = dateEl.value || ymd(new Date());
      applyTrade({ code, name, type, date, amount, shares, nav });
      save();
      close();
      renderAll();
    });
    setTimeout(() => amtEl.focus(), 50);
  }

  // 统一记账入口：手动申购/赎回/分红与定投自动记账共用同一套持仓增减规则，
  // 避免两条路径各写一份导致口径漂移。
  // t = { code, name, type:'buy'|'sell'|'div', date, amount, shares, nav, fee?, note?, planId?, auto? }
  function applyTrade(t) {
    const code = t.code;
    const type = t.type;
    const amount = num(t.amount, 0);
    const shares = num(t.shares, 0);
    const nav = num(t.nav, 0);
    const name = t.name || code;
    if (type === "buy") {
      const h = (F.holdings || []).find((x) => x.code === code);
      if (h) { h.shares = num(h.shares, 0) + shares; h.cost = num(h.cost, 0) + amount; }
      else F.holdings.push({ id: uid("h_"), code, name, shares, cost: amount, unitCost: nav > 0 ? amount / shares : 0, addedAt: Date.now() });
      if (!(F.watchlist || []).some((x) => x.code === code)) F.watchlist.push({ id: uid("w_"), code, name, addedAt: Date.now() });
    } else if (type === "sell") {
      const hi = F.holdings.findIndex((x) => x.code === code);
      if (hi >= 0) {
        const cur = num(F.holdings[hi].shares, 0);
        F.holdings[hi].shares = Math.max(0, cur - shares);
        const costRatio = cur > 0 ? shares / cur : 0;
        F.holdings[hi].cost = Math.max(0, num(F.holdings[hi].cost, 0) - num(F.holdings[hi].cost, 0) * costRatio);
        // 按比例赎回后单位成本不变，仅当份额归零时清除
        if (F.holdings[hi].shares <= 0.0001) F.holdings.splice(hi, 1);
      }
    } else if (type === "div") {
      // 现金分红：份额不变，但成本下降（分红 = 已回收的本金），
      // 这样累计盈亏（市值 - 成本）才能正确反映分红收益
      const hi = F.holdings.findIndex((x) => x.code === code);
      if (hi >= 0) {
        F.holdings[hi].cost = Math.max(0, num(F.holdings[hi].cost, 0) - amount);
        const s2 = num(F.holdings[hi].shares, 0);
        if (s2 > 0) F.holdings[hi].unitCost = num(F.holdings[hi].cost, 0) / s2;
      }
    }
    // 申购后同步单位成本（总成本/份额）
    if (type === "buy") {
      const hi = F.holdings.findIndex((x) => x.code === code);
      if (hi >= 0) {
        const s2 = num(F.holdings[hi].shares, 0);
        if (s2 > 0) F.holdings[hi].unitCost = num(F.holdings[hi].cost, 0) / s2;
      }
    }
    // 份额发生变化（申购/赎回）后，手动填写的固定市值已过时，
    // 清除历史遗留字段，市值一律按「净值×份额」自动算
    if (type === "buy" || type === "sell") {
      const hi = F.holdings.findIndex((x) => x.code === code);
      if (hi >= 0) { delete F.holdings[hi].marketValue; delete F.holdings[hi].marketValueSet; }
    }
    const rec = {
      id: uid("t_"), code, name, type, date: t.date,
      amount, shares: type === "div" ? 0 : shares,
      fee: num(t.fee, 0), nav, note: t.note || "",
    };
    if (t.planId) rec.planId = t.planId;
    if (t.auto) rec.auto = true;
    F.trades.unshift(rec);
    if (F.trades.length > 200) F.trades.length = 200;
    return rec;
  }

  // 净值走势弹窗：自绘 canvas 迷你折线 + 周期切换（近1周/1月/3月/6月/1年）
  // 数据源：pingzhongdata 的 Data_netWorthTrend 一次返回全量历史，
  // 周期切换在本地切片（零额外请求）；画布按宽度等距降采样保证曲线平滑。
  // 鼠标悬浮显示十字线 + 高亮点 + tooltip（日期 / 净值 / 日涨跌）。
  function openChart(code) {
    const w = (F.watchlist || []).find((x) => x.code === code);
    const h = (F.holdings || []).find((x) => x.code === code);
    const title = (h && h.name) || (w && w.name) || code;
    const ov = document.createElement("div");
    ov.className = "task-modal-overlay";
    ov.innerHTML = `
      <div class="task-modal fund-modal fund-chart-modal">
        <h3>净值走势 · ${esc(title)}</h3>
        <div class="chart-sub">${esc(code)}</div>
        <div class="chart-periods" id="fund-chart-periods"></div>
        <canvas id="fund-chart" width="560" height="180"></canvas>
        <div class="chart-legend" id="fund-chart-legend">加载中…</div>
        <div class="tm-actions"><button class="btn-primary cm-ok">关闭</button></div>
      </div>`;
    document.body.appendChild(ov);
    const close = () => ov.remove();
    ov.querySelector(".cm-ok").addEventListener("click", close);
    ov.addEventListener("click", (e) => { if (e.target === ov) close(); });
    ov.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });

    const periodEl = ov.querySelector("#fund-chart-periods");
    const canvas = ov.querySelector("#fund-chart");
    const legendEl = ov.querySelector("#fund-chart-legend");
    const subEl = ov.querySelector(".chart-sub");
    let fullList = null; // 升序完整历史
    let curPeriod = "3m"; // 默认近 3 月，视觉更均衡

    function renderPeriods() {
      periodEl.innerHTML = CHART_PERIODS.map((p) =>
        `<button class="seg-btn${p.id === curPeriod ? " active" : ""}" data-per="${p.id}">${p.label}</button>`
      ).join("");
      periodEl.querySelectorAll("[data-per]").forEach((b) =>
        b.addEventListener("click", () => { curPeriod = b.dataset.per; render(); }));
    }
    // 按周期切片（按自然日，数据可能少于周期天数时退回可用范围）
    function sliceByPeriod(list) {
      const p = CHART_PERIODS.find((x) => x.id === curPeriod) || CHART_PERIODS[2];
      const cutoff = Date.now() - p.days * 24 * 3600 * 1000;
      const sliced = list.filter((r) => new Date(r.date + "T00:00:00").getTime() >= cutoff);
      // 过滤后不足 2 点（新基金 / 数据缺失）退回完整数据
      return sliced.length >= 2 ? sliced : list;
    }
    function renderLegend(asc) {
      if (!asc || !asc.length) return;
      const first = asc[0], last = asc[asc.length - 1];
      const fv = first.dwjz ?? first.nav;
      const lv = last.dwjz ?? last.nav;
      const chg = fv > 0 ? ((lv - fv) / fv) * 100 : 0;
      legendEl.innerHTML =
        `<span>${esc(first.date)} 起</span> <span>至 <b>${esc(last.date)}</b></span> · ` +
        `<span class="${pctClass(chg)}">累计 ${fmtPct(chg)}</span> · ` +
        `<span>最新 <b>${lv ? lv.toFixed(4) : "--"}</b></span>`;
    }
    // 悬浮回调：把当前周期数据传进来，用 legend 行显示「日期 / 净值 / 日涨跌」
    function onHover(idx, row) {
      if (idx < 0 || !row) { renderLegend(sliceByPeriod(fullList.slice())); return; }
      const v = row.dwjz ?? row.nav;
      const p = row.pct;
      legendEl.innerHTML =
        `<b>${esc(row.date)}</b> · 单位净值 <b>${v ? v.toFixed(4) : "--"}</b>` +
        (p === null || p === undefined ? "" : ` · 日涨跌 <b class="${pctClass(p)}">${fmtPct(p)}</b>`);
    }
    function render() {
      renderPeriods();
      if (!fullList || !fullList.length) return;
      const asc = sliceByPeriod(fullList.slice());
      drawChart(canvas, asc, onHover);
      renderLegend(asc);
    }
    renderPeriods();
    (async () => {
      try {
        fullList = await fetchHistoryFull(code);
        if (!fullList || !fullList.length) {
          legendEl.textContent = "暂无历史净值数据";
          return;
        }
        // fetchHistoryFull 返回升序（旧→新），drawChart 直接画
        fullList = fullList.slice();
        render();
      } catch (e) {
        legendEl.textContent = "走势加载失败：" + String(e && e.message || e);
      }
    })();
  }

// 画净值折线（渐变面积），复用宿主系统健康页的画法
  // onHover(idx, row, mx): 鼠标悬浮回调（返回 null 表示未命中）
  function drawChart(canvas, list, onHover) {
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || canvas.width || 560;
    const h = canvas.clientHeight || canvas.height || 180;
    canvas.width = w * dpr; canvas.height = h * dpr;
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    // 密集数据降采样：超过画布 2 倍宽度时等距抽样，保证曲线平滑不糊
    let src = list;
    const MAX_PTS = w * 2;
    if (src.length > MAX_PTS) {
      const step = Math.ceil(src.length / MAX_PTS);
      src = src.filter((_, i) => i % step === 0);
      if (src.length < 2) src = list;
    }
    const vals = src.map((r) => num(r.dwjz ?? r.nav, 0));
    if (vals.length < 2) return;
    const mn = Math.min.apply(null, vals), mx = Math.max.apply(null, vals);
    const span = mx - mn || 1;
    const padL = 8, padR = 8, padT = 12, padB = 18;
    const x = (i) => padL + (i / (vals.length - 1)) * (w - padL - padR);
    const y = (v) => padT + (1 - (v - mn) / span) * (h - padT - padB);
    // 面积
    ctx.beginPath();
    ctx.moveTo(x(0), h - padB);
    for (let i = 0; i < vals.length; i++) ctx.lineTo(x(i), y(vals[i]));
    ctx.lineTo(x(vals.length - 1), h - padB);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, padT, 0, h - padB);
    grad.addColorStop(0, "rgba(88,166,255,0.28)");
    grad.addColorStop(1, "rgba(88,166,255,0)");
    ctx.fillStyle = grad;
    ctx.fill();
    // 折线
    ctx.beginPath();
    for (let i = 0; i < vals.length; i++) { if (i === 0) ctx.moveTo(x(i), y(vals[i])); else ctx.lineTo(x(i), y(vals[i])); }
    ctx.strokeStyle = "#58a6ff"; ctx.lineWidth = 1.6; ctx.lineJoin = "round"; ctx.lineCap = "round";
    ctx.stroke();
    // 极值点：沿用全模块的「红涨绿跌」，高点标红、低点标绿
    // （原先 max=绿 / min=红，与本文件其余图表及文件头的视觉约定正好相反）
    const imax = vals.indexOf(mx), imin = vals.indexOf(mn);
    for (const i of [imax, imin]) {
      if (i < 0) continue;
      ctx.beginPath();
      ctx.arc(x(i), y(vals[i]), 2.5, 0, Math.PI * 2);
      ctx.fillStyle = i === imax ? "#ff7b72" : "#3fb950";
      ctx.fill();
    }

// 起止日期刻度
    ctx.fillStyle = "#5b6675"; ctx.font = "10px system-ui, sans-serif"; ctx.textBaseline = "alphabetic";
    ctx.textAlign = "left"; ctx.fillText(src[0].date, padL, h - 4);
    ctx.textAlign = "right"; ctx.fillText(src[src.length - 1].date, w - padR, h - 4);

    // 鼠标悬浮：十字线 + 高亮点 + tooltip 数据回调
    if (!onHover) return;
    const hoverCtx = ctx;
    const drawBase = () => {
      hoverCtx.clearRect(0, 0, w, h);
      // 面积
      hoverCtx.beginPath();
      hoverCtx.moveTo(x(0), h - padB);
      for (let i = 0; i < vals.length; i++) hoverCtx.lineTo(x(i), y(vals[i]));
      hoverCtx.lineTo(x(vals.length - 1), h - padB);
      hoverCtx.closePath();
      const g = hoverCtx.createLinearGradient(0, padT, 0, h - padB);
      g.addColorStop(0, "rgba(88,166,255,0.28)");
      g.addColorStop(1, "rgba(88,166,255,0)");
      hoverCtx.fillStyle = g; hoverCtx.fill();
      hoverCtx.beginPath();
      for (let i = 0; i < vals.length; i++) { if (i === 0) hoverCtx.moveTo(x(i), y(vals[i])); else hoverCtx.lineTo(x(i), y(vals[i])); }
      hoverCtx.strokeStyle = "#58a6ff"; hoverCtx.lineWidth = 1.6; hoverCtx.lineJoin = "round"; hoverCtx.lineCap = "round";
      hoverCtx.stroke();
      const imax2 = vals.indexOf(mx), imin2 = vals.indexOf(mn);
      for (const i of [imax2, imin2]) {
        if (i < 0) continue;
        hoverCtx.beginPath();
        hoverCtx.arc(x(i), y(vals[i]), 2.5, 0, Math.PI * 2);
        hoverCtx.fillStyle = i === imax2 ? "#ff7b72" : "#3fb950";
        hoverCtx.fill();
      }
      hoverCtx.fillStyle = "#5b6675"; hoverCtx.font = "10px system-ui, sans-serif"; hoverCtx.textBaseline = "alphabetic";
      hoverCtx.textAlign = "left"; hoverCtx.fillText(src[0].date, padL, h - 4);
      hoverCtx.textAlign = "right"; hoverCtx.fillText(src[src.length - 1].date, w - padR, h - 4);
    };
    canvas.onmousemove = (e) => {
      const rect = canvas.getBoundingClientRect();
      const mpx = ((e.clientX - rect.left) / rect.width) * w;
      if (mpx < padL || mpx > w - padR) { drawBase(); onHover(-1, null); return; }
      let idx = Math.round((mpx - padL) / (w - padL - padR) * (vals.length - 1));
      idx = Math.max(0, Math.min(vals.length - 1, idx));
      const px = x(idx), py = y(vals[idx]);
      drawBase();
      // 十字线
      hoverCtx.strokeStyle = "rgba(139,148,158,0.55)"; hoverCtx.lineWidth = 1;
      hoverCtx.setLineDash([3, 3]);
      hoverCtx.beginPath(); hoverCtx.moveTo(px, padT); hoverCtx.lineTo(px, h - padB); hoverCtx.stroke();
      hoverCtx.beginPath(); hoverCtx.moveTo(padL, py); hoverCtx.lineTo(w - padR, py); hoverCtx.stroke();
      hoverCtx.setLineDash([]);
      // 高亮点
      hoverCtx.beginPath(); hoverCtx.arc(px, py, 3.5, 0, Math.PI * 2);
      hoverCtx.fillStyle = "#58a6ff"; hoverCtx.fill();
      hoverCtx.lineWidth = 1.6; hoverCtx.strokeStyle = "#fff"; hoverCtx.stroke();
      onHover(idx, src[idx]);
    };
    canvas.onmouseleave = () => {
      drawBase();
      onHover(-1, null);
    };
  }

  // ---------- 刷新 ----------
  async function refreshQuotes(codes) {
    const list = (codes && codes.length ? codes : (F.watchlist || []).map((w) => w.code));
    const uniq = Array.from(new Set(list));
    const tasks = uniq.map(async (c) => {
      try { return await fetchQuote(c); } catch (e) { return null; }
    });
    const results = await Promise.all(tasks);
    // stale 回退数据不更新缓存时间戳，下次刷新仍会尝试拉取新数据
    results.forEach((q) => {
      if (q && !q.stale) storeCache("quote", "q:" + q.code, q);
    });
    // 盘中估算：需要净值里的股票仓位（stockPos），故在行情落缓存之后再构建；
    // 仅在「确有需要估算的基金」时才拉持仓明细，非交易时段不产生额外请求
    if (uniq.some((c) => shouldEstimate(getQuote(c)))) {
      try { await buildEstimates(uniq); } catch (_) {}
    } else {
      // 非展示时段（收盘后 / 周末）仍要补校准样本：净值发布前的收盘价拟合是唯一可比口径，
      // 错过这个窗口就永久少一个样本。内部有 3 小时间隔节流 + 行情日去重，不会反复发请求。
      try { await calibrationSweep(uniq); } catch (_) {}
    }
    // 回填已公布净值的样本实际值（净值序列走 30 分钟内存缓存）
    try { await syncCalibration(); } catch (_) {}
    save();
    if (currentTab === "wh" && WH_LIVE_SUBS.has(whSub)) renderWH();
    if (currentTab === "overview") refreshOverviewLive();
  }
  async function refreshAll() {
    await refreshQuotes();
    if (currentTab === "rank") loadRank();
  }

// 定时器：定投到期检查 + 交易时段行情刷新（30s）
  let autoTimer = 0;
  function startAutoRefresh() {
    clearInterval(autoTimer);
    // 定时器**无条件**安装：`settings.autoRefresh` 管的是「行情轮询」，不该连定投记账一起停掉。
    // 旧实现直接 return，导致关掉自动刷新的用户永远等不到定投自动记账（只剩进页面那一次）。
    autoTimer = setInterval(() => {
      if (document.hidden) return;
      // 定投到期检查：内部先做纯计算判断，无到期时不发任何请求（不受 autoRefresh 影响）
      runDuePlans().catch(() => {});
      if (!F.settings.autoRefresh) return;
      if (!isTradingNow()) return;
      if (currentTab === "wh") refreshQuotes();
      if (currentTab === "overview") refreshOverviewLive();
      if (currentTab === "rank") loadRank();
    }, F.settings.refreshSec * 1000);
  }

  function renderAll() {
    if (currentTab === "wh") renderWH();
    if (currentTab === "overview") refreshOverviewLive();
    if (currentTab === "rank") loadRank();
  }

// ---------- 初始化 ----------
  renderOverviewShell();
  renderRankShell();
  renderSearchShell();
  renderWH();
  startAutoRefresh();
  refreshAll().catch(() => setStatus("行情更新失败，请稍后手动刷新", "err"));
  loadOverview().catch(() => {});
  // 定投到期检查（进入模块即查一次；无到期时不发请求）
  runDuePlans().catch(() => {});

  view.onDestroy(() => {
    clearInterval(autoTimer);
    clearTimeout(statusTimer);
  });
}