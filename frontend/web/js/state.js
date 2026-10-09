// 统一状态源 — 单例 state 对象，所有模块共享同一引用，避免多份快照互相覆盖。
// 启动时 loadState() 从 Rust 读取；修改后调 saveState() 持久化。
import { Store } from "./store.js";
import { ymd, uid } from "./utils.js";
import { CHECKIN_RESULT_DIR, normalizeCheckinResultDir } from "./config.js";

// （历史）这里曾有一个 SCHEDULER_SEED —— 把本机在跑的签到脚本硬编码成面板的预置任务。
// 已于 2026-10-07 整体移除，原因：
//   1) 它把**个人数据**（绝对路径、任务名、cron、甚至签到习惯说明）写进了 git 跟踪的源码，
//      换台机器 / 分享仓库即成脏数据；
//   2) 它与 state.json 形成「两处真相」—— 源码一份、运行数据一份，必然不同步。实测踩过两次：
//      改 state.json 会被运行中的应用用内存状态写回覆盖；改源码又对已存在任务无效；
//   3) 为弥合 (2) 而生的 seededIds 补种机制还衍生新坑 —— id 一旦进过 seededIds，
//      seed 的后续修改**永远无法生效**（掘金任务改离线通道后「改了不生效」就是这个根因）。
//
// 现在的规则：任务的**唯一真相是 state.json**，全部由面板的「新建 / 编辑 / 删除」维护，
// 改任务不再需要动代码，也不再需要重启应用。换机迁移走面板上的「导出 / 导入」。

/// 补全单个任务的字段（老数据 / 手改 state.json 都可能缺字段）
function normalizeScheduleTask(t) {
  const out = t && typeof t === "object" && !Array.isArray(t) ? t : {};
  if (typeof out.id !== "string" || !out.id) out.id = uid("t_");
  if (typeof out.name !== "string" || !out.name) out.name = "未命名任务";
  if (typeof out.enabled !== "boolean") out.enabled = true;
  if (typeof out.scheduleEnabled !== "boolean") out.scheduleEnabled = true;
  if (typeof out.cron !== "string") out.cron = "";
  if (out.kind !== "http") out.kind = "command";
  if (typeof out.command !== "string") out.command = "";
  if (typeof out.cwd !== "string") out.cwd = "";
  if (typeof out.method !== "string" || !out.method) out.method = "GET";
  if (typeof out.url !== "string") out.url = "";
  if (!out.headers || typeof out.headers !== "object" || Array.isArray(out.headers)) out.headers = {};
  if (typeof out.body !== "string") out.body = "";
  if (typeof out.expect !== "string") out.expect = "";
  if (typeof out.note !== "string") out.note = "";
  // 创建日期（YYYY-MM-DD）：热力图用它区分「任务那时还不存在」与「该跑没跑」。
  // 老数据没有该字段 → 置空串，由前端回落到「最早一条按天聚合记录」。
  if (typeof out.since !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(out.since)) out.since = "";
  // 超时与重试收敛到后端同样的合理区间，避免手改出 0 或超大值
  if (typeof out.timeoutSec !== "number" || !isFinite(out.timeoutSec) || out.timeoutSec < 1) out.timeoutSec = 300;
  out.timeoutSec = Math.min(Math.round(out.timeoutSec), 86400);
  if (typeof out.retry !== "number" || !isFinite(out.retry) || out.retry < 0) out.retry = 0;
  out.retry = Math.min(Math.round(out.retry), 5);
  // 子进程输出编码：auto = 后端启发式判定；其余是给用户的确定性出口
  // （GBK 与 UTF-8 在字节层面存在真歧义，自动判定不可能 100% 正确）
  if (!["auto", "utf8", "gbk"].includes(out.outputEncoding)) out.outputEncoding = "auto";
  return out;
}

export const state = {
  currentModule: "dashboard",
  tasks: [],
  notes: [], // 笔记列表：{ id, title, content, pinned, createdAt, updatedAt }（按 updatedAt 降序）
  recentOps: [], // 最近操作记录：{ ts, type, action, name, ... }
  reminders: [], // 提醒配置：{ id, label, icon, type, time/intervalMin, enabled, ... }
  sedentary: { enabled: false, intervalMin: 45 }, // 久坐提醒：开关 + 连续使用间隔（分钟）
  water: { enabled: false, intervalMin: 90 }, // 喝水提醒：开关 + 间隔（分钟）
  pomodoro: {
    mode: "focus", // focus | short | long（当前会话模式）
    running: false, // 是否正在倒计时
    endsAt: 0, // 本轮结束时间戳（running 时有效，重启后据此续跑）
    pausedRemain: 0, // 暂停时剩余毫秒（未开始则为 0，代表整段时长）
    focusMin: 25, shortMin: 5, longMin: 15, // 各模式时长（分钟）
    cycleCount: 0, // 本轮长周期内已完成的专注数（0-3，第 4 个进入长休息）
    goal: 8, // 每日专注目标（轮）
    autoNext: false, // 阶段自然结束时是否自动开始下一阶段
    date: "", // 统计归属日期 YYYY-MM-DD
    done: 0, // 今日已完成专注轮数
    minutes: 0, // 今日累计专注分钟
    totalDone: 0, // 历史累计专注轮数
  }, // 番茄钟（顶部时钟区小组件）
  workLogs: [], // 工作记录：{ id, date:"YYYY-MM-DD", time:"HH:MM", text, type, tags }
  ideabox: [], // 灵感碎片：{ id, text, tag, ts }（按添加顺序排列）
  ideaTags: [], // 灵感碎片自定义标签（内置标签之外的扩展）
  mineBest: {}, // 扫雷最佳用时（秒）：{ easy, medium, hard }
  musicSources: [], // 音乐音源插件：{ id, name, src, code }
  favorites: [], // 收藏的歌曲：{ title, artist, artwork, url }
  playback: { queue: [], index: -1, song: null, playing: false, currentTime: 0 }, // 音乐播放状态（重启恢复）
  navState: {}, // 各模块导航浏览状态：{ [moduleId]: { scrollTop, tab, ... } }（切换/重启后恢复）
  settings: { rememberModule: true }, // 应用设置：rememberModule=启动时回到上次模块
  plugins: [], // 外部插件配置：{ id, title, path, enabled }（通过「设置 → 插件」导入）
  fund: {
    // 基金管家：自选 / 持仓 / 交易流水 / 行情缓存 / 设置
    watchlist: [], // { id, code, name, addedAt }
    holdings: [], // { id, code, name, shares, cost, unitCost?, addedAt }  cost=总成本（份额×单位成本）；unitCost=单位成本(元/份)
    trades: [], // { id, code, name, type:"buy"|"sell"|"div", date, amount, shares, fee, nav, note }
    cache: { quote: {}, history: {}, rank: {} },
    settings: { autoRefresh: true, refreshSec: 30, highlightPct: 0.5 },
    // AI 分析：OpenAI 兼容接口配置（apiKey 明文存本地 state.json，随「备份与恢复」走）+ 报告历史
    ai: {
      baseUrl: "", model: "", apiKey: "",
      temperature: 0.3, maxTokens: 4000, timeoutMs: 120000,
      history: [], // { id, at, model, content, summary }
    },
  },
  ai: {
    // AI 资讯：新闻源 + 缓存 / 模型目录用户覆盖 / 签到（WorkBuddy+Trae，token 不存）
    // sources 留 null：首次进入模块由 ensureAi 填默认源（用户清空后保持空，不回填）
    news: { sources: null, items: [], lastFetch: 0 },
    // models.custom = 用户覆盖/新增；lastGitItems = git 自动拉取的免费额度目录缓存（24h）
    models: { custom: [], lastGitItems: [], lastGitFetch: 0 },
    checkin: {
      // 签到脚本写的结果文件目录（面板「刷新」读 last_result.json / trae_last_result.json）。
      // 常量在 config.js —— 改路径两边一起改（脚本侧对应 workbuddy-checkin\checkin_paths.py），
      // 只改一边就会出现「脚本写了、面板读不到」的静默故障。
      resultDir: CHECKIN_RESULT_DIR,
      workbuddy: { accounts: [], lastRun: 0 },
      trae: { accounts: [], lastRun: 0 },
    },
  },
  scheduler: {
    // 定时任务：只来自用户（面板里新建 / 编辑）。源码不预置任何任务，理由见文件开头。
    // （历史：这里曾是 null，当「未初始化」哨兵用，首次进入模块时填入 SCHEDULER_SEED）
    tasks: [],
    maxConcurrent: 2, // 面板内调度同时运行的任务数上限
    catchUp: true, // 启动时补跑「上次运行期间被错过」的任务（窗口 6h，由后端判断）
  },
  lock: { enabled: false, minutes: 5 }, // 隐私锁定：离开 enabled 分钟自动锁定全屏
  quickAccess: [], // 快捷访问：{ id, type:"url"|"folder"|"file", title, target, groupId }
  qaGroups: [], // 快捷访问分组：{ id, name }
  lyric: {
    // 桌面歌词浮层（独立窗口）。P1 仅用到 pos；其余字段在 P2/P4 接入。
    enabled: false, // 是否启用桌面歌词
    locked: true, // 锁定态：鼠标穿透歌词条（点到底下的窗口/图标）
    hoverUnlock: true, // 悬停自动解锁（鼠标移入条内即可拖动/右键，移出后自动锁回）
    autoLockMs: 3000, // 移出后多久锁回（毫秒，0 = 立即）
    form: "single", // 显示形态：single | double
    style: "stroke", // 视觉模式：stroke（描边）| capsule（胶囊底板）| bold（加粗）
    align: "center", // 歌词对齐方式：left | center | right（参考网易云桌面歌词）
    fontSize: 22, // 字号 px（12–28）
    offset: 0, // 歌词时间偏移（秒，-5~+5）：正 = 歌词提前，负 = 延后
    colorText: "", // 歌词文字颜色（#RGB/#RRGGBB；空 = 默认近白）
    colorFill: "", // 卡拉OK染色进度色（空 = 跟随应用主题色）
    followTheme: true, // 是否跟随应用主题色
    pos: { xRatio: 0.5, yRatio: 0.92, monitorIndex: 0 }, // 相对工作区的比例位置
  },
  theme: undefined, // 主题配置（见 js/theme.js DEFAULT_THEME；undefined = 升级前老数据，启动时归一化补默认）
  eyeCare: {
    // 全局护眼（改显卡 Gamma 查找表，对整机所有应用生效 —— 见 src-tauri/src/eyecare.rs）
    enabled: false,
    mode: "manual", // manual=固定色温 | schedule=按时段自动切换
    kelvin: 4500, // 目标色温 K（2000–6500）；越低越暖。manual 模式使用
    brightness: 90, // 整体亮度百分比（50–100）
    contrast: 95, // 对比度百分比（80–100）
    // —— schedule 模式 ——
    dayKelvin: 5500, // 白天色温
    nightKelvin: 3400, // 夜间色温
    from: "22:00", // 夜间时段起
    to: "07:00", // 夜间时段止
    transitionMin: 30, // 切换点前的过渡时长（分钟），避免突兀变黄
  },
};

/// 异步初始化：从 Rust 读取状态并合并进单例。
export async function loadState() {
  const loaded = await Store.load();
  Object.assign(state, loaded);
  if (!Array.isArray(state.tasks)) state.tasks = [];
  if (typeof state.currentModule !== "string") state.currentModule = "dashboard";
  // 笔记列表：旧版 string → 包装为数组；数组则逐条校验
  if (typeof state.notes === "string") {
    const now = Date.now();
    state.notes = [{ id: "migrated", title: "未命名", content: state.notes, pinned: false, createdAt: now, updatedAt: now }];
  }
  if (!Array.isArray(state.notes)) state.notes = [];
  state.notes = state.notes.filter((n) => n && typeof n === "object" && typeof n.content === "string");
  state.notes.forEach((n) => {
    if (typeof n.id !== "string" || !n.id) n.id = uid("n_");
    if (typeof n.title !== "string") n.title = "";
    if (typeof n.pinned !== "boolean") n.pinned = false;
    if (typeof n.createdAt !== "number") n.createdAt = Date.now();
    if (typeof n.updatedAt !== "number") n.updatedAt = Date.now();
  });
  if (!Array.isArray(state.recentOps)) state.recentOps = [];
  // 提醒：只做结构校验，源码不预置任何内容（理由见文件开头）。
  // 为空数组保留（用户可能删光），不是数组才重置。
  if (!Array.isArray(state.reminders)) state.reminders = [];
  // 久坐提醒：结构校验
  if (!state.sedentary || typeof state.sedentary !== "object") {
    state.sedentary = { enabled: false, intervalMin: 45 };
  } else {
    if (typeof state.sedentary.enabled !== "boolean") state.sedentary.enabled = false;
    if (typeof state.sedentary.intervalMin !== "number") state.sedentary.intervalMin = 45;
    state.sedentary.intervalMin = Math.max(1, Math.min(240, state.sedentary.intervalMin || 45));
  }
  // 喝水提醒：结构校验
  if (!state.water || typeof state.water !== "object") {
    state.water = { enabled: false, intervalMin: 90 };
  } else {
    if (typeof state.water.enabled !== "boolean") state.water.enabled = false;
    if (typeof state.water.intervalMin !== "number") state.water.intervalMin = 90;
    state.water.intervalMin = Math.max(1, Math.min(480, state.water.intervalMin || 90));
  }
  // 喝水倒计时时间戳：恢复时若为数字则保留
  if (typeof state.waterLastAt !== "number") state.waterLastAt = 0;
  // 番茄钟：结构校验 + 跨日清零今日统计
  if (!state.pomodoro || typeof state.pomodoro !== "object" || Array.isArray(state.pomodoro)) {
    state.pomodoro = {};
  }
  const pm = state.pomodoro;
  if (!["focus", "short", "long"].includes(pm.mode)) pm.mode = "focus";
  if (typeof pm.running !== "boolean") pm.running = false;
  if (typeof pm.endsAt !== "number" || !isFinite(pm.endsAt)) pm.endsAt = 0;
  if (typeof pm.pausedRemain !== "number" || !isFinite(pm.pausedRemain) || pm.pausedRemain < 0) pm.pausedRemain = 0;
  const clampMin = (v, lo, hi, dflt) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) && n >= lo && n <= hi ? n : dflt;
  };
  pm.focusMin = clampMin(pm.focusMin, 1, 120, 25);
  pm.shortMin = clampMin(pm.shortMin, 1, 60, 5);
  pm.longMin = clampMin(pm.longMin, 1, 120, 15);
  pm.cycleCount = Math.max(0, Math.min(3, Math.round(Number(pm.cycleCount)) || 0));
  pm.goal = Math.max(1, Math.min(30, Math.round(Number(pm.goal)) || 8));
  if (typeof pm.autoNext !== "boolean") pm.autoNext = false;
  pm.totalDone = Math.max(0, Math.round(Number(pm.totalDone)) || 0);
  pm.done = Math.max(0, Math.round(Number(pm.done)) || 0);
  pm.minutes = Math.max(0, Math.round(Number(pm.minutes)) || 0);
  // 跨日：统计归零（避免昨日数字带到今天）
  const todayKey = ymd();
  if (pm.date !== todayKey) { pm.date = todayKey; pm.done = 0; pm.minutes = 0; }
  if (!Array.isArray(state.musicSources)) state.musicSources = [];
  if (!Array.isArray(state.favorites)) state.favorites = [];
  // 工作记录：结构校验
  if (!Array.isArray(state.workLogs)) state.workLogs = [];
  state.workLogs = state.workLogs.filter((w) => w && typeof w === "object" && w.id && w.text);
  // 灵感碎片：结构校验
  if (!Array.isArray(state.ideabox)) state.ideabox = [];
  state.ideabox = state.ideabox.filter((i) => i && typeof i === "object" && i.id && typeof i.text === "string" && i.text.trim());
  // 灵感碎片自定义标签：结构校验（去重、非空、去内置重名）
  if (!Array.isArray(state.ideaTags)) state.ideaTags = [];
  state.ideaTags = Array.from(new Set(state.ideaTags.filter((t) => typeof t === "string" && t.trim())));
  // 扫雷最佳用时：结构校验（数值类型）
  if (!state.mineBest || typeof state.mineBest !== "object" || Array.isArray(state.mineBest)) state.mineBest = {};
  for (const k of ["easy", "medium", "hard"]) {
    if (typeof state.mineBest[k] !== "number") state.mineBest[k] = null;
  }
  // 应用设置：结构校验
  if (!state.settings || typeof state.settings !== "object" || Array.isArray(state.settings)) state.settings = {};
  if (typeof state.settings.rememberModule !== "boolean") state.settings.rememberModule = true;
  // 外部插件：结构校验
  if (!Array.isArray(state.plugins)) state.plugins = [];
  state.plugins = state.plugins.filter((p) => p && typeof p === "object" && typeof p.path === "string" && p.path.trim());
  // 隐私锁定：结构校验
  if (!state.lock || typeof state.lock !== "object" || Array.isArray(state.lock)) state.lock = {};
  if (typeof state.lock.enabled !== "boolean") state.lock.enabled = false;
  if (typeof state.lock.minutes !== "number") state.lock.minutes = 5;
  state.lock.minutes = Math.max(1, Math.min(120, Math.round(state.lock.minutes) || 5));
  // 导航浏览状态：结构校验
  if (!state.navState || typeof state.navState !== "object" || Array.isArray(state.navState)) {
    state.navState = {};
  }
  // 基金管家：结构校验（自选/持仓/流水必须是数组，缓存与设置补齐默认）
  if (!state.fund || typeof state.fund !== "object" || Array.isArray(state.fund)) state.fund = {};
  {
    const fd = state.fund;
    if (!Array.isArray(fd.watchlist)) fd.watchlist = [];
    if (!Array.isArray(fd.holdings)) fd.holdings = [];
    if (!Array.isArray(fd.trades)) fd.trades = [];
    fd.watchlist = fd.watchlist.filter((w) => w && typeof w === "object" && typeof w.code === "string" && /^\d{6}$/.test(w.code));
    fd.holdings = fd.holdings.filter((h) => h && typeof h === "object" && typeof h.code === "string" && Number.isFinite(Number(h.shares)));
    // 旧数据只有总成本时，自动补单位成本 = 总成本 / 份额（便于双字段表单回显）
    fd.holdings.forEach((h) => {
      // 市值统一自动计算，清除历史「手动固定市值」字段
      delete h.marketValue; delete h.marketValueSet;
      if (!Number.isFinite(Number(h.unitCost)) || Number(h.unitCost) <= 0) {
        const s = Number(h.shares) || 0;
        h.unitCost = s > 0 ? (Number(h.cost) || 0) / s : 0;
      }
    });
    fd.trades = fd.trades.filter((t) => t && typeof t === "object" && typeof t.code === "string");
    if (!fd.cache || typeof fd.cache !== "object") fd.cache = {};
    if (!fd.cache.quote || typeof fd.cache.quote !== "object") fd.cache.quote = {};
    if (!fd.cache.history || typeof fd.cache.history !== "object") fd.cache.history = {};
    if (!fd.cache.rank || typeof fd.cache.rank !== "object") fd.cache.rank = {};
    if (!fd.settings || typeof fd.settings !== "object") fd.settings = {};
    if (typeof fd.settings.autoRefresh !== "boolean") fd.settings.autoRefresh = true;
    fd.settings.refreshSec = Math.max(15, Math.min(300, Math.round(Number(fd.settings.refreshSec)) || 30));
    fd.settings.highlightPct = Math.max(0.1, Math.min(10, Number(fd.settings.highlightPct) || 0.5));
    // AI 分析配置：字符串字段兜底；temperature 必须显式判有限值（0 是合法值，不能用 `|| 0.3` 兜）
    if (!fd.ai || typeof fd.ai !== "object" || Array.isArray(fd.ai)) fd.ai = {};
    const fa = fd.ai;
    for (const k of ["baseUrl", "model", "apiKey"]) {
      if (typeof fa[k] !== "string") fa[k] = "";
    }
    const temp = Number(fa.temperature);
    fa.temperature = Number.isFinite(temp) && temp >= 0 && temp <= 2 ? temp : 0.3;
    fa.maxTokens = Math.max(256, Math.min(8000, Math.round(Number(fa.maxTokens)) || 4000));
    // 一次性迁移：v1.9 首版默认值是 1600，对思考型模型（deepseek-reasoner / o1 系）不够，
    // 会出现「只有思考过程、正文为空」。该字段当时还没有 UI 入口，任何 1600 都来自我们的默认值，
    // 不存在「用户主动选了 1600」的情况，故可安全抬到 4000（此后该字段在界面上可自行调整）。
    if (fa.maxTokens === 1600) fa.maxTokens = 4000;
    fa.timeoutMs = Math.max(10000, Math.min(600000, Math.round(Number(fa.timeoutMs)) || 120000));
    if (!Array.isArray(fa.history)) fa.history = [];
    fa.history = fa.history.filter((r) => r && typeof r === "object" && typeof r.content === "string" && r.content.trim());
  }
  // AI 资讯：结构校验（sources 留空/null 由模块 ensureAi 填默认，用户清空后保持空）
  if (!state.ai || typeof state.ai !== "object" || Array.isArray(state.ai)) state.ai = {};
  {
    const a = state.ai;
    if (!a.news || typeof a.news !== "object" || Array.isArray(a.news)) a.news = { sources: null, items: [], lastFetch: 0 };
    if (!Array.isArray(a.news.items)) a.news.items = [];
    if (typeof a.news.lastFetch !== "number") a.news.lastFetch = 0;
    if (!a.models || typeof a.models !== "object" || Array.isArray(a.models)) a.models = { custom: [] };
    if (!Array.isArray(a.models.custom)) a.models.custom = [];
    if (!Array.isArray(a.models.lastGitItems)) a.models.lastGitItems = [];
    if (typeof a.models.lastGitFetch !== "number") a.models.lastGitFetch = 0;
    // 归一化结构版本，与 views/ai.js 的 MODEL_SCHEMA 对应；不一致则丢弃旧缓存重拉
    if (typeof a.models.lastGitSchema !== "number") a.models.lastGitSchema = 0;
    if (!a.checkin || typeof a.checkin !== "object" || Array.isArray(a.checkin)) a.checkin = {};
    // 结果目录：缺失 / 空 / 仍是旧路径时升级到 CHECKIN_RESULT_DIR（规则在 config.js）。
    // ⚠ 老 state.json 里存的是旧绝对路径（非空），只改默认值**不会生效** ⇒ 面板会一直读旧目录，
    //   而脚本已改写到新目录 ⇒ 静默失配（面板刷新永远拿不到新结果）。
    a.checkin.resultDir = normalizeCheckinResultDir(a.checkin.resultDir);
    for (const k of ["workbuddy", "trae"]) {
      if (!a.checkin[k] || typeof a.checkin[k] !== "object" || Array.isArray(a.checkin[k])) a.checkin[k] = { accounts: [], lastRun: 0 };
      if (!Array.isArray(a.checkin[k].accounts)) a.checkin[k].accounts = [];
      if (typeof a.checkin[k].lastRun !== "number") a.checkin[k].lastRun = 0;
      delete a.checkin[k].history; // 旧字段：趋势已去掉
      // Trae 账号只保留 Trae CN（旧版本曾缓存 TRAE SOLO CN / 国际版 Trae）
      if (k === "trae") {
        a.checkin.trae.accounts = a.checkin.trae.accounts.filter((acc) => {
          const n = String(acc && acc.name ? acc.name : "").replace(/\s+/g, " ").trim().toLowerCase();
          return n === "trae cn" || n === "";
        });
      }
    }
  }
  // 定时任务：结构校验 + 首次填充预置任务。
  // 必须在 loadState 里做（而非等用户打开模块）：后端调度线程每 20s 直接读 state.json，
  // 若拖到打开面板才写入任务表，签到任务在首次打开模块前根本不会被调度。
  state.scheduler = normalizeScheduler(state.scheduler);

  // 全局护眼：结构校验。
  // 范围与 Rust 侧 set_eyecare_config 的 clamp 保持一致（双重保险：
  // 老数据/手改 state.json 传越界值时，前端先收敛，后端再兜一层）。
  if (!state.eyeCare || typeof state.eyeCare !== "object" || Array.isArray(state.eyeCare)) state.eyeCare = {};
  {
    const ec = state.eyeCare;
    if (typeof ec.enabled !== "boolean") ec.enabled = false;
    if (!["manual", "schedule"].includes(ec.mode)) ec.mode = "manual";
    const ecClamp = (v, lo, hi, dflt) => {
      const n = Math.round(Number(v));
      return Number.isFinite(n) && n >= lo && n <= hi ? n : dflt;
    };
    ec.kelvin = ecClamp(ec.kelvin, 2000, 6500, 4500);
    ec.brightness = ecClamp(ec.brightness, 50, 100, 90);
    ec.contrast = ecClamp(ec.contrast, 80, 100, 95);
    ec.dayKelvin = ecClamp(ec.dayKelvin, 2000, 6500, 5500);
    ec.nightKelvin = ecClamp(ec.nightKelvin, 2000, 6500, 3400);
    ec.transitionMin = ecClamp(ec.transitionMin, 0, 180, 30);
    // 时刻格式校验：与 Rust 侧 parse_hhmm 的容错一致，非法值回落默认
    const HM = /^([01]\d|2[0-3]):[0-5]\d$/;
    if (typeof ec.from !== "string" || !HM.test(ec.from)) ec.from = "22:00";
    if (typeof ec.to !== "string" || !HM.test(ec.to)) ec.to = "07:00";
  }
  // 播放状态：结构校验
  if (!state.playback || typeof state.playback !== "object") {
    state.playback = { queue: [], index: -1, song: null, playing: false, currentTime: 0 };
  }
  if (!Array.isArray(state.playback.queue)) state.playback.queue = [];
  if (typeof state.playback.index !== "number") state.playback.index = -1;
  if (typeof state.playback.volume !== "number") state.playback.volume = 0.8;
  state.playback.volume = Math.max(0, Math.min(1, state.playback.volume));
  // 静音态：muted=true 时实际音量为 0，恢复时回到 preMuteVolume
  if (typeof state.playback.muted !== "boolean") state.playback.muted = false;
  if (typeof state.playback.preMuteVolume !== "number") state.playback.preMuteVolume = state.playback.volume || 0.8;
  state.playback.preMuteVolume = Math.max(0, Math.min(1, state.playback.preMuteVolume));
  // 快捷访问分组：结构校验
  if (!Array.isArray(state.qaGroups)) state.qaGroups = [];
  state.qaGroups = state.qaGroups.filter((g) => g && typeof g === "object" && typeof g.id === "string" && typeof g.name === "string");
  // 快捷访问：结构校验（缺失 id / target 的丢弃）
  if (!Array.isArray(state.quickAccess)) state.quickAccess = [];
  state.quickAccess = state.quickAccess.filter(
    (q) => q && typeof q === "object" && typeof q.id === "string" && typeof q.target === "string" && q.target.trim()
  );
  // 桌面歌词：结构校验 + 枚举回落 + 数值 clamp（老用户无该字段时补默认）
  if (!state.lyric || typeof state.lyric !== "object" || Array.isArray(state.lyric)) {
    state.lyric = { enabled: false, locked: true, form: "single", style: "stroke", align: "center", fontSize: 22, followTheme: true, pos: {} };
  }
  const ly = state.lyric;
  if (typeof ly.enabled !== "boolean") ly.enabled = false;
  if (typeof ly.locked !== "boolean") ly.locked = true;
  if (typeof ly.hoverUnlock !== "boolean") ly.hoverUnlock = true;
  if (typeof ly.followTheme !== "boolean") ly.followTheme = true;
  if (typeof ly.autoLockMs !== "number" || !isFinite(ly.autoLockMs)) ly.autoLockMs = 3000;
  ly.autoLockMs = Math.max(0, Math.min(60000, Math.round(ly.autoLockMs)));
  if (!["single", "double"].includes(ly.form)) ly.form = "single";
  if (!["stroke", "capsule", "bold"].includes(ly.style)) ly.style = "stroke";
  if (!["left", "center", "right"].includes(ly.align)) ly.align = "center";
  if (typeof ly.fontSize !== "number" || !isFinite(ly.fontSize)) ly.fontSize = 22;
  ly.fontSize = Math.max(12, Math.min(28, Math.round(ly.fontSize)));
  // 时间偏移：半秒步进，clamp 到 ±5（偏太多没有意义，还会让歌词完全对不上）
  if (typeof ly.offset !== "number" || !isFinite(ly.offset)) ly.offset = 0;
  ly.offset = Math.max(-5, Math.min(5, Math.round(ly.offset * 2) / 2));
  // 自定义颜色：只接受 #RGB / #RRGGBB；空串 = 跟随默认。脏值一律回落，防止注入垃圾到 CSS。
  const isLyColor = (v) => typeof v === "string" && (v === "" || /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v));
  if (!isLyColor(ly.colorText)) ly.colorText = "";
  if (!isLyColor(ly.colorFill)) ly.colorFill = "";
  if (!ly.pos || typeof ly.pos !== "object" || Array.isArray(ly.pos)) ly.pos = {};
  const num = (v, d) => (typeof v === "number" && isFinite(v) ? v : d);
  ly.pos.xRatio = Math.max(0, Math.min(1, num(ly.pos.xRatio, 0.5)));
  ly.pos.yRatio = Math.max(0, Math.min(1, num(ly.pos.yRatio, 0.92)));
  ly.pos.monitorIndex = Math.max(0, Math.round(num(ly.pos.monitorIndex, 0)));
}

// 定时任务：结构校验。任务**只来自用户**（面板里新建 / 编辑 / 删除），源码不带任何预置内容 ——
// 见文件开头那段说明：预置内容一旦写进源码，就与 state.json 形成「两处真相」，改哪边都可能被
// 另一边覆盖。所以这里只做校验与补字段，不做任何「填充」。
function normalizeScheduler(s) {
  if (!s || typeof s !== "object" || Array.isArray(s)) s = {};
  if (!Array.isArray(s.tasks)) s.tasks = [];
  s.tasks = s.tasks.map(normalizeScheduleTask);

  // 清理历史遗留：seededIds 是旧「一次性补种」机制的账本，机制已整体移除。
  // 老 state.json 里会带这个键，留着无害，但顺手删掉保持数据干净。
  if ("seededIds" in s) delete s.seededIds;

  if (typeof s.maxConcurrent !== "number" || !isFinite(s.maxConcurrent)) s.maxConcurrent = 2;
  s.maxConcurrent = Math.max(1, Math.min(8, Math.round(s.maxConcurrent)));
  if (typeof s.catchUp !== "boolean") s.catchUp = true;
  return s;
}

// 300ms 防抖：合并短时间内的连续保存（操作记录/播放状态/设置变更等），减少磁盘写入频率
let saveTimer = 0;

/// 持久化当前 state（异步，调用方可不 await；300ms 防抖合并连续调用）。
export function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    Store.save(state).catch((e) => console.warn("[state] 保存失败", e));
  }, 300);
}

/// 追加一条最近操作记录（最多 20 条），并持久化、通知订阅者刷新。
const recentOpListeners = new Set();
export function onRecentOp(fn) {
  recentOpListeners.add(fn);
}
export function pushRecentOp(op) {
  if (!state.recentOps) state.recentOps = [];
  state.recentOps.unshift({ ...op, ts: Date.now() });
  if (state.recentOps.length > 20) state.recentOps.length = 20;
  saveState();
  recentOpListeners.forEach((fn) => { try { fn(); } catch (e) {} });
}
