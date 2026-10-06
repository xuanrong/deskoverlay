// AI 资讯视图（内置模块）：资讯 / 模型与免费额度 / 签到积分（WorkBuddy + Trae）。
// 走宿主 state.ai 持久化 + Rust http_get/http_post 代理取数；签到登录态解密在 ai-checkin.js（WebCrypto）。
import { invoke } from "../bus.js";
import { state, saveState } from "../state.js";
import { esc, ymd, uid } from "../utils.js";
import { showDialog } from "./common.js";
import { createCheckin } from "./ai-checkin.js";
import { ICON_EDIT, ICON_TRASH, ICON_EXTERNAL } from "../icons.js";

const ID = "ai";
const NEWS_TTL = 10 * 60 * 1000; // 资讯缓存 10 分钟
const DEFAULT_RESULT_DIR = "C:\\Users\\qiuxr\\workbuddy-checkin\\logs";

const DEFAULT_NEWS_SOURCES = [
  { id: "hf-papers", name: "Hugging Face Papers", type: "json", url: "https://huggingface.co/api/daily_papers", enabled: true },
  { id: "jqzx", name: "机器之心", type: "rss", url: "https://www.jiqizhixin.com/rss", enabled: true },
  { id: "qbitai", name: "量子位", type: "rss", url: "https://www.qbitai.com/feed", enabled: true },
];

function ensureAi() {
  if (!state.ai || typeof state.ai !== "object" || Array.isArray(state.ai)) state.ai = {};
  const a = state.ai;
  if (!a.news || typeof a.news !== "object" || Array.isArray(a.news)) {
    a.news = { sources: DEFAULT_NEWS_SOURCES.map((s) => ({ ...s })), items: [], lastFetch: 0 };
  } else {
    if (!Array.isArray(a.news.sources)) a.news.sources = DEFAULT_NEWS_SOURCES.map((s) => ({ ...s }));
    if (!Array.isArray(a.news.items)) a.news.items = [];
    if (typeof a.news.lastFetch !== "number") a.news.lastFetch = 0;
  }
  if (!a.models || typeof a.models !== "object" || Array.isArray(a.models)) a.models = { custom: [] };
  if (!Array.isArray(a.models.custom)) a.models.custom = [];
  if (!Array.isArray(a.models.lastGitItems)) a.models.lastGitItems = [];
  if (typeof a.models.lastGitFetch !== "number") a.models.lastGitFetch = 0;
  if (typeof a.models.lastGitSchema !== "number") a.models.lastGitSchema = 0;
  if (!a.checkin || typeof a.checkin !== "object" || Array.isArray(a.checkin)) a.checkin = {};
  const c = a.checkin;
  if (typeof c.resultDir !== "string" || !c.resultDir) c.resultDir = DEFAULT_RESULT_DIR;
  for (const k of ["workbuddy", "trae"]) {
    if (!c[k] || typeof c[k] !== "object" || Array.isArray(c[k])) c[k] = { accounts: [], lastRun: 0 };
    if (!Array.isArray(c[k].accounts)) c[k].accounts = [];
    if (typeof c[k].lastRun !== "number") c[k].lastRun = 0;
    // 一次性清洗：Trae 缓存账号只保留 Trae CN（旧版本曾把 TRAE SOLO CN / 国际版 Trae 也写进缓存）
    if (k === "trae") c.trae.accounts = c.trae.accounts.filter(isTraeCnAccount);
  }
}

// 适配器端口：crypto / httpPost / httpGet / collectState / wait / now
const checkin = createCheckin({
  crypto: globalThis.crypto,
  httpPost: (url, body, headers) => invoke("http_post", { url, body, headers }),
  httpGet: (url, headers) => invoke("http_get", { url, headers }),
  collectState: (kind) => invoke("collect_checkin_state", { kind }),
  wait: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
});
const httpGet = (url, headers) => invoke("http_get", { url, headers });

export function renderAi(view) {
  ensureAi();
  view.header.style.display = "none";
  const el = view.body;

  // 分栏布局（无整体滚动）：左窄 = 资讯；右 = 签到积分（上）+ 模型与免费额度（下）。
  // 各栏内部独立滚动。
  el.innerHTML = `
    <div class="ai-wrap">
      <div class="ai-col ai-col-news">
        <div class="ai-section" data-s="news" id="ai-news-root"></div>
      </div>
      <div class="ai-col ai-col-right">
        <div class="ai-section" data-s="checkin" id="ai-c-root"></div>
        <div class="ai-section" data-s="models" id="ai-m-root"></div>
      </div>
    </div>`;

  const roots = {
    checkin: el.querySelector("#ai-c-root"),
    news: el.querySelector("#ai-news-root"),
    models: el.querySelector("#ai-m-root"),
  };
  renderCheckin(roots.checkin);
  renderNews(roots.news);
  renderModels(roots.models);
}

// ============================ 资讯 ============================
async function renderNews(panel) {
  panel.innerHTML = `
    <div class="card-head">
      <div class="card-title">AI 资讯</div>
      <span class="ai-tools">
        <button class="btn-ghost" id="ai-news-src">管理源</button>
        <button class="btn-primary" id="ai-news-ref">刷新</button>
      </span>
    </div>
    <div class="fb-src" id="ai-news-meta">加载中…</div>
    <div class="ai-news-list" id="ai-news-list"></div>`;

  const listEl = panel.querySelector("#ai-news-list");
  const metaEl = panel.querySelector("#ai-news-meta");
  const a = state.ai.news;

  function renderItems() {
    if (!a.items.length) {
      listEl.innerHTML = `<div class="ai-empty">暂无资讯，点「刷新」抓取或「管理源」添加</div>`;
      return;
    }
    listEl.innerHTML = a.items.map((it) => `
      <div class="ai-news" data-link="${esc(it.link)}">
        <div class="ai-news-main">
          <div class="ai-news-title">${esc(it.title)}</div>
          <div class="ai-news-sum">${esc(it.summary || "")}</div>
        </div>
        <div class="ai-news-meta">
          <span class="badge badge-blue">${esc(it.source)}</span>
          <span class="ai-news-time">${esc(relTime(it.time))}</span>
        </div>
      </div>`).join("");
    listEl.querySelectorAll(".ai-news").forEach((row) => {
      row.addEventListener("click", () => {
        const link = row.dataset.link;
        if (link) invoke("open_path", { target: link }).catch((e) =>
          showDialog({ title: "打开失败", message: String(e), okText: "知道了", showCancel: false }),
        );
      });
    });
  }

  async function fetchAll() {
    metaEl.textContent = "抓取中…";
    const enabled = a.sources.filter((s) => s.enabled);
    if (!enabled.length) { metaEl.textContent = "没有启用的源"; renderItems(); return; }
    const items = [];
    await Promise.all(enabled.map(async (s) => {
      try {
        const txt = await httpGet(s.url, {});
        items.push(...parseFeed(s, txt));
      } catch (e) {
        metaEl.textContent += `${s.name} 失败 `;
      }
    }));
    // 去重 + 排序 + 截断
    const seen = new Set();
    const dedup = items.filter((it) => it.link && !seen.has(it.link) && seen.add(it.link));
    dedup.sort((x, y) => (y.time || 0) - (x.time || 0));
    a.items = dedup.slice(0, 200);
    a.lastFetch = Date.now();
    saveState();
    metaEl.textContent = `更新于 ${hhmm(new Date())} · ${a.items.length} 条`;
    renderItems();
  }

  panel.querySelector("#ai-news-ref").addEventListener("click", fetchAll);
  panel.querySelector("#ai-news-src").addEventListener("click", () => showSourcesModal(renderNews.bind(null, panel)));

  // 缓存未过期直接用，否则后台刷新
  renderItems();
  if (Date.now() - a.lastFetch > NEWS_TTL) {
    fetchAll();
  } else {
    metaEl.textContent = `更新于 ${hhmm(new Date(a.lastFetch))} · ${a.items.length} 条 · ${relTime(a.lastFetch)}`;
  }
}

// 资讯源管理弹窗
function showSourcesModal(reload) {
  let ov = document.querySelector("#ai-src-modal");
  if (ov) ov.remove();
  ov = document.createElement("div");
  ov.id = "ai-src-modal";
  ov.className = "task-modal-overlay";
  const render = () => {
    const rows = state.ai.news.sources.map((s) => `
      <div class="ai-src-row" data-id="${esc(s.id)}">
        <button class="ai-src-en${s.enabled ? " on" : ""}" title="${s.enabled ? "已启用" : "已禁用"}">${s.enabled ? "●" : "○"}</button>
        <span class="ai-src-name">${esc(s.name)}<span class="ai-src-type">${s.type}</span></span>
        <span class="ai-src-url">${esc(s.url)}</span>
        <span class="qa-actions">
          <button class="qa-act" data-act="edit" title="编辑">${ICON_EDIT}</button>
          <button class="qa-act danger" data-act="del" title="删除">${ICON_TRASH}</button>
        </span>
      </div>`).join("");
    ov.querySelector(".task-modal").innerHTML = `
      <h3>资讯源管理</h3>
      <div class="tm-field"><label>新增源</label>
        <div class="tm-row" style="grid-template-columns: 70px 60px 1fr auto;">
          <input id="ai-src-name" placeholder="名称" />
          <select id="ai-src-type"><option value="rss">rss</option><option value="json">json</option></select>
          <input id="ai-src-url" placeholder="https://…" />
          <button class="btn-primary" id="ai-src-add">添加</button>
        </div>
      </div>
      <div class="tm-field"><label>已有源</label><div class="ai-src-list">${rows || `<div class="ai-empty">暂无源</div>`}</div></div>
      <div class="tm-actions"><button class="tm-cancel">关闭</button></div>`;
    bindRows();
  };
  ov.innerHTML = `<div class="task-modal" style="width:min(620px,94vw)"></div>`;
  document.body.appendChild(ov);
  render();
  function bindRows() {
    ov.querySelector(".tm-cancel").addEventListener("click", () => { ov.remove(); reload(); });
    ov.querySelector("#ai-src-add").addEventListener("click", () => {
      const name = ov.querySelector("#ai-src-name").value.trim();
      const type = ov.querySelector("#ai-src-type").value;
      const url = ov.querySelector("#ai-src-url").value.trim();
      if (!name || !url) return;
      state.ai.news.sources.push({ id: uid("src_"), name, type, url, enabled: true });
      saveState(); render();
    });
    ov.querySelector(".ai-src-list").addEventListener("click", async (e) => {
      const row = e.target.closest(".ai-src-row");
      if (!row) return;
      const id = row.dataset.id;
      const s = state.ai.news.sources.find((x) => x.id === id);
      if (!s) return;
      const act = e.target.closest("[data-act]");
      if (e.target.closest(".ai-src-en")) { s.enabled = !s.enabled; saveState(); render(); return; }
      if (!act) return;
      if (act.dataset.act === "edit") {
        const name = await showDialog({ title: "编辑名称", input: true, inputValue: s.name, okText: "保存" });
        if (!name) return;
        const url = await showDialog({ title: "编辑地址", input: true, inputValue: s.url, okText: "保存" });
        if (!url) return;
        s.name = name; s.url = url; saveState(); render();
      } else if (act.dataset.act === "del") {
        const ok = await showDialog({ title: "删除源", message: `删除「${s.name}」？`, okText: "删除", danger: true });
        if (!ok) return;
        state.ai.news.sources = state.ai.news.sources.filter((x) => x.id !== id);
        saveState(); render();
      }
    });
    ov.addEventListener("keydown", (e) => { if (e.key === "Escape") { ov.remove(); reload(); } });
  }
}

function parseFeed(src, text) {
  try {
    if (src.type === "json") return parseJson(src, text);
    return parseRss(src, text);
  } catch (e) {
    return [];
  }
}

function parseRss(src, text) {
  const doc = new DOMParser().parseFromString(text, "text/xml");
  const items = [...doc.querySelectorAll("item, entry")];
  return items.map((it) => {
    const title = (it.querySelector("title")?.textContent || "").trim();
    const link = (it.querySelector("link")?.textContent || it.querySelector("link")?.getAttribute("href") || "").trim();
    const pub = it.querySelector("pubDate, published, updated")?.textContent || "";
    let desc = it.querySelector("description, summary, content")?.textContent || "";
    desc = desc.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim().slice(0, 200);
    return { id: uid("n_"), source: src.name, title, link, summary: desc, time: Date.parse(pub) || Date.now() };
  });
}

function parseJson(src, data) {
  const arr = Array.isArray(data) ? data : (data.data || data.items || data.results || []);
  return arr.slice(0, 50).map((it) => {
    const p = it.paper || it;
    const id = p.id || p.paperId || "";
    return {
      id: uid("n_"),
      source: src.name,
      title: p.title || p.name || "",
      link: id ? "https://huggingface.co/papers/" + id : (p.url || src.url),
      summary: (p.summary || p.abstract || "").replace(/\s+/g, " ").trim().slice(0, 200),
      time: Date.parse(it.publishedAt || p.publishedAt || p.time) || Date.now(),
    };
  });
}

// ============================ 模型与免费额度（git 自动拉取 + 本地兜底） ============================
// 数据源：github.com/PanStories/free-and-cheap-tokens（每日核验的免费额度目录，MIT）
//   每个 data/promos/*.json = 一个厂商的免费额度条目（provider / offer / terms / verification）
// 策略：进入模块时后台拉 git（24h 缓存写 state），拉取中/失败都只展示 git 数据，不做本地兜底。
const MODEL_GIT_REPO = "PanStories/free-and-cheap-tokens";
const MODEL_GIT_BASE = `https://api.github.com/repos/${MODEL_GIT_REPO}`;
const MODEL_TTL = 24 * 60 * 60 * 1000;

// 取单个 promo 文件的候选源，按序回退。
// 为什么必须多源：宿主 http_get 是直连（ureq 未开 proxy-from-env，不读 Clash 系统代理），
// 而 raw.githubusercontent.com（185.199.x）在境内直连被劣化 —— 实测同一文件一次 10s 超时、
// 一次 5.5s 才通，而 http_get 超时仅 15s。单一源 + Promise.all 一票否决，会让整轮刷新报废。
//   jsdelivr：CDN，实测 ~1s 直连可达，且自带缓存（首选）
//   raw     ：GitHub 原始源，偶发可用（次选）
//   api     ：api.github.com 能直连，但需 base64 解且共享匿名限流 60 次/时（兜底）
const MODEL_SOURCES = [
  { name: "jsdelivr", url: (p) => `https://cdn.jsdelivr.net/gh/${MODEL_GIT_REPO}@main/${p}`, plain: true },
  { name: "raw", url: (p) => `https://raw.githubusercontent.com/${MODEL_GIT_REPO}/main/${p}`, plain: true },
  { name: "api", url: (p) => `${MODEL_GIT_BASE}/contents/${p}`, plain: false },
];

// api.github.com contents 返回的是 base64（含换行），需转回 UTF-8 文本
function decodeBase64Utf8(b64) {
  const bin = atob(String(b64).replace(/\s+/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder("utf-8").decode(bytes);
}

// 宿主命令失败抛出的可能是字符串或对象；统一压成一行短文本，直接显示给人看
function errText(e) {
  if (!e) return "";
  let s = e;
  if (typeof e !== "string") {
    if (e.message) s = e.message;
    else { try { s = JSON.stringify(e); } catch (_) { s = String(e); } }
  }
  return String(s).replace(/\s+/g, " ").trim().slice(0, 160);
}

// 归一化结构版本。字段口径变更时 +1，使 state 里的旧缓存作废并自动重拉。
const MODEL_SCHEMA = 2;

// offer.type 是 schema 的受控枚举（schemas/promo.schema.json#/$defs/offer_type），
// 9 个取值全部在描述「怎么免费拿到」，枚举里不存在付费类型 —— 所以卡片不能再用
// 「免费/付费」二值判定（原实现恒为免费），改为直接展示额度性质标签，未知类型也不误判。
const OFFER_TYPE_LABEL = {
  free_tier: "免费层",
  trial_credit: "试用额度",
  signup_bonus: "注册赠金",
  referral_bonus: "邀请奖励",
  promo_code: "兑换码",
  daily_allowance: "每日额度",
  startup_program: "创业计划",
  academic_program: "教育计划",
  limited_event: "限时活动",
};
// 同类额度给同色 badge（复用既有 badge-* 配色，不新增 CSS）
const OFFER_TYPE_BADGE = {
  free_tier: "badge-green",
  trial_credit: "badge-blue",
  daily_allowance: "badge-blue",
  signup_bonus: "badge-purple",
  referral_bonus: "badge-purple",
  promo_code: "badge-amber",
  limited_event: "badge-amber",
  startup_program: "badge-neutral",
  academic_program: "badge-neutral",
};
// 上手难度（口径见仓库 ADR-003）；措辞只讲「门槛」本身，
// 绑卡与否由 needCard 单独标出，避免同一件事在一行里说两遍
const DIFFICULTY_LABEL = { easy: "零门槛", medium: "需实名或审批", hard: "需资质申请" };
const REGION_LABEL = { global: "全球可用", include: "限指定地区", exclude: "部分地区不可用" };
// categories 也是受控枚举；一条 promo 常同时覆盖多种能力（如 llm+embedding+image），
// 原实现把它压成「LLM/通用」二值，会丢掉「还能白拿图像/视频额度」这类关键信息。
const CATEGORY_LABEL = {
  llm: "对话",
  embedding: "向量",
  image: "图像",
  video: "视频",
  audio: "音频",
  agent_hosting: "Agent 托管",
  vector_db: "向量库",
  gpu_compute: "GPU",
  other: "其他",
};
// 影响「注册完就能用」的条款，用于「无需信用卡」过滤
const CARD_BLOCKING_TERMS = ["credit_card_required", "deposit_required"];
// terms 展示优先级：blocker（不满足就完全拿不到）> friction > note
const TERM_RANK = { blocker: 0, friction: 1, note: 2 };

// 把一个 git 上的 promo JSON 归一化成模型卡数据
function normalizePromo(p) {
  const provider = p.provider || {};
  const offer = p.offer || {};
  const terms = (Array.isArray(p.terms) ? p.terms : []).filter(Boolean);
  const verified = p.verification?.last_verified_at;
  // terms 按严重度排序后再取两条：blocker 必须优先露出，否则「需实名认证」这类
  // 决定能否领到的前置，会被 note 级的「有 RPM 限制」挤掉（原实现按数组原序截取）。
  const notes = terms
    .filter((t) => t.note)
    .sort((x, y) => (TERM_RANK[x.severity] ?? 3) - (TERM_RANK[y.severity] ?? 3))
    .slice(0, 2)
    .map((t) => t.note);
  return {
    id: p.id || offer.claim_url || provider.id || String(Date.now()),
    vendor: provider.name_zh || provider.name_en || "未知厂商",
    model: offer.headline || p.id || "免费额度",
    // 覆盖的能力类别（中文短标签，保留全部，不再压成单一值）
    cats: (p.categories || []).map((c) => CATEGORY_LABEL[c] || c).filter(Boolean),
    // 额度文案：中文优先，兜底英文，再兜底 summary；不再硬编码「免费」以免谎报
    amount: offer.value_display || offer.value_display_en || offer.summary || "",
    offerType: offer.type || "",
    difficulty: p.difficulty || "",
    // 是否强制绑卡/押金（「无需信用卡」过滤依据，tag 来自受控词表）
    needCard: terms.some((t) => CARD_BLOCKING_TERMS.includes(t.tag)),
    link: offer.claim_url || provider.homepage || "",
    country: provider.country || "",
    region: p.region?.availability || "",
    note: notes.join("；"),
    _source: "git",
    _verified: verified || null,
  };
}

// 源健康状态：连续失败 2 次即判该源本轮不可用，后续文件不再白等它
// （单个文件 404 之类不应直接判死，故用「连续」计数而非一票否决）
const modelSrcState = { fails: new Map(), dead: new Set() };
function resetModelSrcState() {
  modelSrcState.fails.clear();
  modelSrcState.dead.clear();
}
function noteSrcFail(name) {
  const n = (modelSrcState.fails.get(name) || 0) + 1;
  modelSrcState.fails.set(name, n);
  if (n >= 2) modelSrcState.dead.add(name);
}

// 按序尝试各源取单个文件，返回原文（失败抛最后一个错误）
async function getPromoFile(path) {
  const order = MODEL_SOURCES.filter((s) => !modelSrcState.dead.has(s.name));
  const tryList = order.length ? order : MODEL_SOURCES; // 全判死时兜底重试一轮
  let lastErr = null;
  for (const s of tryList) {
    try {
      const txt = await httpGet(s.url(path), {});
      modelSrcState.fails.set(s.name, 0);
      return s.plain ? txt : decodeBase64Utf8(JSON.parse(txt).content);
    } catch (e) {
      lastErr = e;
      noteSrcFail(s.name);
    }
  }
  throw lastErr || new Error("没有可用的数据源");
}

// 从 git 拉取全部 promo，返回 { items, total, failed, error }；全部失败时 error 非空
async function fetchModelOffers() {
  resetModelSrcState();
  const treeTxt = await httpGet(`${MODEL_GIT_BASE}/git/trees/HEAD?recursive=1`, {});
  const paths = (JSON.parse(treeTxt).tree || [])
    .filter((it) => it.type === "blob" && it.path && it.path.startsWith("data/promos/"))
    .map((it) => it.path);
  if (!paths.length) throw new Error("git 目录中没有 data/promos/ 条目");

  const items = [];
  let failed = 0;
  let firstErr = null;
  const CONC = 6;
  for (let i = 0; i < paths.length; i += CONC) {
    const chunk = paths.slice(i, i + CONC);
    // allSettled：个别文件失败不再让整轮刷新报废（原 Promise.all 一票否决，
    // 只要有一个文件超时，前面已取到的数据也全部丢掉）
    const rs = await Promise.allSettled(chunk.map(async (p) => normalizePromo(JSON.parse(await getPromoFile(p)))));
    for (const r of rs) {
      if (r.status === "fulfilled") items.push(r.value);
      else { failed++; if (!firstErr) firstErr = r.reason; }
    }
  }
  return { items, total: paths.length, failed, error: failed ? firstErr : null };
}

async function renderModels(panel) {
  const a = state.ai.models;
  const filter = state.navState[ID]?.modelFilter || "全部";
  const noCard = !!state.navState[ID]?.modelNoCard;

  // git 缓存：结构版本相符的才算可用；不符时仍留一份做兜底展示
  const anyCache = Array.isArray(a.lastGitItems) ? a.lastGitItems : [];
  const cacheOk = (a.lastGitSchema || 0) === MODEL_SCHEMA;
  const gitCache = cacheOk ? anyCache : [];
  let list = gitCache;

  panel.innerHTML = `
    <div class="card-head">
      <div class="card-title">模型与免费额度</div>
      <span class="ai-tools">
        <button class="btn-ghost" id="ai-m-free">${noCard ? "✓ 无需信用卡" : "无需信用卡"}</button>
      </span>
    </div>
    <div class="fb-src" id="ai-m-git-note"></div>
    <div class="ai-m-filter" id="ai-m-filter"></div>
    <div class="ai-m-grid" id="ai-m-grid"></div>`;

  const gridEl = panel.querySelector("#ai-m-grid");
  const filterEl = panel.querySelector("#ai-m-filter");
  const gitNoteEl = panel.querySelector("#ai-m-git-note");

  function paint(items, statusTag, meta) {
    list = items;
    const warn = statusTag === "fail" || statusTag === "stale";
    if (statusTag === "loading") gitNoteEl.textContent = "git 自动拉取中…";
    else if (statusTag === "git") {
      // 部分成功也要说清楚缺了几条，否则会以为数据是完整的
      const miss = meta && meta.failed ? `，${meta.failed}/${meta.total} 条拉取失败` : "";
      gitNoteEl.textContent = `已自动拉取 git 目录（${items.length} 条），更新于 ${relTime(a.lastGitFetch)}${miss}`;
    } else if (statusTag === "stale") {
      // 刷新失败但有旧缓存：展示旧数据 + 讲明原因，比直接白屏好
      gitNoteEl.textContent = `git 刷新失败（${meta || "未知原因"}），以下为上次成功拉取的缓存（${items.length} 条）`;
    } else if (statusTag === "fail") {
      // 原来只给一句「请检查网络」，无法判断到底是哪一环挂了，这里带上真实原因
      gitNoteEl.textContent = `git 拉取失败：${meta || "未知原因"}（可重新进入本模块重试）`;
    }
    gitNoteEl.classList.toggle("fb-src-warn", warn);

    const vendors = ["全部", ...[...new Set(items.map((m) => m.vendor))]];
    filterEl.innerHTML = vendors.map((v) => `<button class="ai-m-vendor${v === filter ? " active" : ""}" data-v="${esc(v)}">${esc(v)}</button>`).join("");
    const shown = list.filter((m) => (filter === "全部" || m.vendor === filter) && (!noCard || !m.needCard));
    gridEl.innerHTML = shown.length
      ? shown.map(modelCard).join("")
      : (statusTag === "loading" ? `<div class="ai-empty">拉取中…</div>` : `<div class="ai-empty">没有匹配的模型</div>`);
    gridEl.querySelectorAll(".ai-m-card").forEach((card) => {
      card.addEventListener("click", (e) => {
        // 「入口」走宿主 open_path（WebView 的 target="_blank" 在 Tauri 下不生效），
        // 与资讯卡片同一套机制。数据只来自 git 拉取，卡片本身不再有点击行为。
        const linkEl = e.target.closest(".ai-m-link");
        if (!linkEl) return;
        const url = linkEl.dataset.link;
        if (url) invoke("open_path", { target: url }).catch((err) =>
          showDialog({ title: "打开失败", message: String(err), okText: "知道了", showCancel: false }),
        );
      });
    });
  }

  // 首屏画 git 缓存；无缓存则先空着等后台拉
  const needFetch = !gitCache.length || Date.now() - (a.lastGitFetch || 0) > MODEL_TTL;
  paint(gitCache, gitCache.length ? "git" : "loading");

  if (needFetch) {
    try {
      const res = await fetchModelOffers();
      if (res.items.length) {
        a.lastGitItems = res.items;
        a.lastGitFetch = Date.now();
        a.lastGitSchema = MODEL_SCHEMA;
        saveState();
        paint(res.items, "git", res);
      } else {
        // 一条都没取到：能用旧缓存就展示旧缓存（含结构版本不符的），否则才报错
        const fallback = anyCache.length ? anyCache : [];
        paint(fallback, fallback.length ? "stale" : "fail", errText(res.error) || "没有取到任何条目");
      }
    } catch (e) {
      const fallback = anyCache.length ? anyCache : [];
      paint(fallback, fallback.length ? "stale" : "fail", errText(e));
    }
  }

  panel.querySelector("#ai-m-free").addEventListener("click", () => {
    if (!state.navState[ID]) state.navState[ID] = {};
    state.navState[ID].modelNoCard = !noCard; saveState(); renderModels(panel);
  });
  filterEl.addEventListener("click", (e) => {
    const b = e.target.closest(".ai-m-vendor");
    if (!b) return;
    if (!state.navState[ID]) state.navState[ID] = {};
    state.navState[ID].modelFilter = b.dataset.v; saveState(); renderModels(panel);
  });
}

function modelCard(m) {
  // badge 只表达额度性质（受控枚举），不再做「免费/付费」二值判定
  const badgeCls = OFFER_TYPE_BADGE[m.offerType] || "badge-neutral";
  const badgeTxt = OFFER_TYPE_LABEL[m.offerType] || "额度";
  // 元信息：上手难度 · 地区可用性 · 是否要绑卡
  const ctx = [
    DIFFICULTY_LABEL[m.difficulty],
    REGION_LABEL[m.region],
    m.needCard ? "需绑卡" : "",
  ].filter(Boolean).join(" · ");
  const cats = (m.cats || []).map((c) => `<span class="badge badge-neutral">${esc(c)}</span>`).join("");
  const verified = m._verified ? `核验 ${relTime(Date.parse(m._verified))}` : "";
  return `
    <div class="ai-m-card" data-id="${esc(m.id)}">
      <div class="ai-m-vlabel">${esc(m.vendor)}<span class="badge ${badgeCls}">${badgeTxt}</span></div>
      <div class="ai-m-name">${esc(m.model)}</div>
      ${cats ? `<div class="ai-m-cats">${cats}</div>` : ""}
      <div class="ai-m-ctx">${esc(ctx || "—")}</div>
      ${m.amount ? `<div class="ai-m-free">额度：${esc(m.amount)}</div>` : ""}
      ${m.note ? `<div class="ai-m-note">${esc(m.note)}</div>` : ""}
      ${verified ? `<div class="ai-m-verified">${verified}</div>` : ""}
      ${m.link ? `<a class="ai-m-link" data-link="${esc(m.link)}">${ICON_EXTERNAL}<span>入口</span></a>` : ""}
    </div>`;
}

// ============================ 签到 ============================
async function renderCheckin(panel) {
  const c = state.ai.checkin;
  panel.innerHTML = `
    <div class="card-head">
      <div class="card-title">签到积分</div>
      <span class="ai-tools">
        <button class="btn-primary" id="ai-c-all">全部签到</button>
      </span>
    </div>
    <div class="fb-src" id="ai-c-meta">加载中…</div>
    <div class="ai-c-grid">
      <div id="ai-c-wb"></div>
      <div id="ai-c-trae"></div>
    </div>`;

  const wbEl = panel.querySelector("#ai-c-wb");
  const traeEl = panel.querySelector("#ai-c-trae");
  const metaEl = panel.querySelector("#ai-c-meta");

  // meta 文案由多路异步结果共同拼成（Trae 实时余额 / WorkBuddy 实时状态各写各的），
  // 直接赋值会互相覆盖 —— 统一走「基础文案 + 备注数组」汇合，谁后到都不会吃掉别人。
  let metaBase = "";
  const metaNotes = [];
  const flushMeta = () => { metaEl.textContent = [metaBase, ...metaNotes].filter(Boolean).join(" · "); };
  const noteMeta = (s) => { metaNotes.push(s); flushMeta(); };

  // 读后台 Python 结果文件（last_result.json / trae_last_result.json）。
  // 两张卡先各自按「文件（今日）→ 缓存 → 空」画出，Trae 额外在后台补实时余额。
  // 关键：两张卡的渲染互相独立，Trae 的实时查询失败/慢不会阻塞 WorkBuddy 卡。
  async function loadFromResults() {
    metaEl.textContent = "读取后台结果中…";
    const [wbRes, traeRes] = await Promise.allSettled([
      invoke("read_text_file", { path: c.resultDir + "\\last_result.json" }),
      invoke("read_text_file", { path: c.resultDir + "\\trae_last_result.json" }),
    ]);
    const wb = wbRes.status === "fulfilled" ? parseWbResult(wbRes.value) : null;
    const traeFromFile = traeRes.status === "fulfilled" ? parseTraeResult(traeRes.value) : null;
    const today = ymd();
    const isToday = (t) => t && ymd(new Date(Date.parse(t) || Date.now())) === today;

    // WorkBuddy 卡：今日文件 → 缓存 → 空
    try {
      renderCard(wbEl, "workbuddy", "WorkBuddy",
        wb && isToday(wb.time) && wb.results.length ? wb : (c.workbuddy.accounts && c.workbuddy.accounts.length ? { results: c.workbuddy.accounts } : null));
    } catch (e) {
      wbEl.innerHTML = `<div class="ai-c-card"><div class="ai-c-title">WorkBuddy</div><div class="ai-empty">渲染异常：${esc(String((e && e.message) || e))}</div></div>`;
    }
    // Trae 卡：今日文件 → 缓存 → 空（先用文件值画出，保证卡立即可见；实时余额稍后覆盖）
    try {
      renderCard(traeEl, "trae", "Trae",
        traeFromFile && isToday(traeFromFile.time) && traeFromFile.results.length ? traeFromFile : (c.trae.accounts && c.trae.accounts.length ? { results: c.trae.accounts } : null));
    } catch (e) {
      traeEl.innerHTML = `<div class="ai-c-card"><div class="ai-c-title">Trae</div><div class="ai-empty">渲染异常：${esc(String((e && e.message) || e))}</div></div>`;
    }

    const fmtT = (iso) => { const t = iso ? Date.parse(iso) : NaN; return Number.isFinite(t) ? hhmm(new Date(t)) : "无"; };
    metaBase = `后台结果：WorkBuddy ${fmtT(wb && wb.time ? wb.time : null)} · Trae ${fmtT(traeFromFile && traeFromFile.time ? traeFromFile.time : null)}`;
    flushMeta();

    // 后台补 Trae 实时余额：成功则覆盖 Trae 卡；失败/无登录态则保留上面的文件/缓存值，绝不清空
    checkin.balanceOnly("trae").then((live) => {
      if (live && live.length) {
        try {
          renderCard(traeEl, "trae", "Trae", { time: new Date().toISOString(), results: live });
          noteMeta("Trae 已按实时余额刷新");
        } catch (e) {
          noteMeta("Trae 实时余额渲染异常：" + String((e && e.message) || e));
        }
      }
    }).catch(() => {
      // 实时查询失败：保留已画出的文件/缓存值，只在 meta 留一行原因（不清空卡片）
      noteMeta("Trae 实时查询失败（保留上方数据）");
    });

    // 后台补 WorkBuddy 实时**状态**（只读接口，不领取）：卡片上那份是「上次查询时刻」的快照，
    // 跨天不刷就会一直写着「今日已签到」（用户报的正是这个）。查不到时保留上方数据、绝不改判。
    checkin.statusOnly("workbuddy").then((live) => {
      if (live && live.length) {
        try {
          renderCard(wbEl, "workbuddy", "WorkBuddy", { time: new Date().toISOString(), results: live });
          noteMeta("WorkBuddy 已按实时状态刷新");
        } catch (e) {
          noteMeta("WorkBuddy 实时状态渲染异常：" + String((e && e.message) || e));
        }
      }
    }).catch(() => {
      noteMeta("WorkBuddy 实时状态查询失败（保留上方数据）");
    });
  }

  // 解析后台 Python 结果（workbuddy）
  function parseWbResult(text) {
    try {
      const j = JSON.parse(text);
      const at = (j.time && Date.parse(j.time)) || Date.now();
      const results = (j.results || []).map((r) => ({
        name: r.account || "",
        signedToday: r.status === "success" || r.status === "already_claimed",
        credits: r.remaining != null ? Number(r.remaining) : (r.credits != null ? Number(r.credits) : null),
        detail: r.detail || r.status || "",
        at,
      }));
      return { time: j.time || null, results };
    } catch (e) { return null; }
  }

  // 解析后台 Python 结果（trae），credits 保留原值（refresh 时会被实时余额覆盖）
  function parseTraeResult(text) {
    try {
      const j = JSON.parse(text);
      const at = (j.time && Date.parse(j.time)) || Date.now();
      const results = (j.results || [])
        .filter((r) => { const n = String(r.account || "").replace(/\s+/g, " ").trim().toLowerCase(); return n === "trae cn" || n === ""; })
        .map((r) => ({
          name: r.account || "",
          signedToday: r.status === "success" || r.status === "already_claimed",
          credits: r.credits != null ? Number(r.credits) : null,
          detail: r.detail || r.status || "",
          at,
        }));
      return { time: j.time || null, results };
    } catch (e) { return null; }
  }

  async function doCheckin(kind) {
    const cardEl = kind === "workbuddy" ? wbEl : traeEl;
    const title = kind === "workbuddy" ? "WorkBuddy" : "Trae";
    const signBtn = cardEl.querySelector(".ai-c-sign");
    if (signBtn) { signBtn.disabled = true; signBtn.textContent = "签到中…"; }
    try {
      const res = await checkin.runCheckin(kind);
      state.ai.checkin[kind].accounts = res.results;
      state.ai.checkin[kind].lastRun = Date.now();
      saveState();
      renderCard(cardEl, kind, title, res);
    } catch (e) {
      renderCard(cardEl, kind, title, { results: [{ name: "", signedToday: false, credits: null, detail: "签到失败：" + String((e && e.message) || e), at: Date.now() }] });
    }
  }

  function renderCard(cardEl, kind, title, res) {
    let results = res?.results || [];
    let norm = results.map((r) => ({
      name: r.name || r.account || "默认账号",
      signedToday: !!r.signedToday,
      credits: r.credits != null ? r.credits : (r.remaining != null ? Number(r.remaining) : null),
      detail: r.detail || r.status || "",
      // 记住这条结果是**什么时候取的** —— 跨天后 signedToday 必须失效，见 gateToday
      at: r.at != null ? r.at : (res?.time ? Date.parse(res.time) : 0),
    }));
    // ⛔ 必做：把「非今日」的结果降级为未签。
    //    少了这道闸，昨天签过的那条记录会把今天的卡片继续显示成「今日已签到」——
    //    用户报的「没签到却显示已签到」就是这个（缓存兜底分支原本没有日期过滤）。
    norm = gateToday(norm);
    if (kind === "trae") {
      const keep = norm.filter(isTraeCnAccount);
      if (keep.length) norm = keep;
    }
    const signed = norm.some((r) => r.signedToday);
    const total = sumCredits(kind, norm);
    const status = norm.length === 0 ? "unknown" : (signed ? "signed" : "pending");
    const emptyNote = kind === "trae"
      ? "未检测到 Trae CN 登录态（请打开 Trae CN 客户端登录后点「立即签到」）"
      : "未检测到登录态";
    cardEl.innerHTML = `
      <div class="ai-c-card" data-kind="${kind}">
        <div class="ai-c-head">
          <div class="ai-c-title">${esc(title)}</div>
          <span class="badge ${status === "signed" ? "badge-green" : status === "pending" ? "badge-amber" : "badge-neutral"}">${status === "signed" ? "今日已签到" : status === "pending" ? "待签到" : "未登录/未知"}</span>
        </div>
        <div class="ai-c-credits">${total != null ? total : "—"}</div>
        <div class="ai-c-accts">${norm.length ? norm.map((r) => `
          <div class="list-row">
            <span class="ai-c-acct-name">${esc(r.name)}</span>
            <span class="ai-c-acct-cred">${r.credits != null ? r.credits + " 积分" : "—"}</span>
            <span class="badge ${r.signedToday ? "badge-green" : "badge-amber"}">${r.signedToday ? "已签到" : "未签"}</span>
          </div>`).join("") : `<div class="ai-empty">${emptyNote}</div>`}</div>
        ${norm.length ? `<div class="ai-c-detail">${esc(norm[0].detail || "")}</div>` : ""}
        <div class="ai-c-acts">
          <button class="btn ${signed ? "" : "btn-primary"} ai-c-sign">${signed ? "重新查询" : "立即签到"}</button>
        </div>
      </div>`;
    // 防御：卡片内必须能挂上签到按钮，否则视为渲染失败，写一行占位保证卡片可见
    const btn = cardEl.querySelector(".ai-c-sign");
    if (btn) btn.addEventListener("click", () => doCheckin(kind));
    else cardEl.innerHTML = `<div class="ai-c-card"><div class="ai-c-title">${esc(title)}（渲染异常）</div><div class="ai-empty">渲染异常，点「全部签到」重试</div></div>`;
  }

  // 初值：显示上次面板签到/查询的实时结果（含实时余额）；无记录则空卡。
  // 每张卡独立 try/catch，任何一张渲染异常都不会阻断另一张，且把原因写进 meta 便于排查。
  try {
    renderCard(wbEl, "workbuddy", "WorkBuddy",
      c.workbuddy.accounts && c.workbuddy.accounts.length ? { results: c.workbuddy.accounts } : null);
  } catch (e) {
    wbEl.innerHTML = `<div class="ai-c-card"><div class="ai-c-title">WorkBuddy</div><div class="ai-empty">渲染异常：${esc(String((e && e.message) || e))}</div></div>`;
  }
  try {
    renderCard(traeEl, "trae", "Trae",
      c.trae.accounts && c.trae.accounts.length ? { results: c.trae.accounts } : null);
  } catch (e) {
    traeEl.innerHTML = `<div class="ai-c-card"><div class="ai-c-title">Trae</div><div class="ai-empty">渲染异常：${esc(String((e && e.message) || e))}</div></div>`;
  }

  panel.querySelector("#ai-c-all").addEventListener("click", async () => {
    await Promise.all([doCheckin("workbuddy"), doCheckin("trae")]);
  });

  // 首屏：先画两张卡（缓存），再后台读文件 + Trae 实时余额补全，互不阻塞
  loadFromResults().catch((e) => {
    // 任何异常都不允许让卡片空白：两张卡保留「未检测到登录态」空卡，并把错误写进 meta 便于排查
    metaEl.textContent = "后台结果读取失败：" + String((e && e.message) || e);
  });
}

// 账号归一化后等于 "trae cn" 才保留；"trae solo cn" / "trae"（国际版）滤掉。
// 注意：渲染层 norm 的 name 缺省为 "默认账号"（r.name/r.account 都空），此时视为 Trae CN 保留；
// 后台 Python 结果的 account 为 "Trae CN"，也归一化成 "trae cn"。
function isTraeCnAccount(r) {
  const n = String((r && (r.name != null ? r.name : r.account)) || "").replace(/\s+/g, " ").trim().toLowerCase();
  return n === "trae cn" || n === "" || n === "默认账号";
}

// 取账号条目的可用余额：workbuddy 优先 remaining（后台结果文件），其余用 credits（实时接口值）
function creditsOf(kind, r) {
  if (kind === "workbuddy" && r.remaining != null) return Number(r.remaining);
  return r.credits != null ? Number(r.credits) : null;
}

// ⛔ 跨天闸门：签到结果是**取数那一刻的快照**，不是持续状态。
// 少了它，昨天签过的那条记录（`signedToday: true` + 昨天的 `at`）会把今天的卡片一直显示成
// 「今日已签到」—— 用户报的「WorkBuddy 没签到却显示已签到」正是缓存兜底分支没有日期过滤。
// 规则：只有 `at` 落在今天的结果才保留 `signedToday`；否则一律降为未签，并把 detail 换成
// 「今日状态未知（上次查询 …）」。**只改「是否已签」这一项判定**，余额原样保留（那是上次已知值）。
// today 可注入 ⇒ 离线断言固定锚点即可，不会随日历漂移。
function gateToday(norm, today = ymd()) {
  return norm.map((r) => {
    const t = atMs(r.at);
    if (t && ymd(new Date(t)) === today) return r;
    const stamp = t ? mdhm(new Date(t)) : "时间未知";
    return { ...r, signedToday: false, detail: `今日状态未知（上次查询 ${stamp}${r.signedToday ? "：已签到" : ""}）` };
  });
}

// at 可能是毫秒数（面板实时结果），也可能是 ISO 串（后台结果文件的 time）。
// ⚠ 只对**字符串**走 Date.parse：`Date.parse(0)` 会把数字 0 当成字符串 "0" 解析成 2000-01-01，
//   于是一条「没有取数时间」的记录会被当成 2000 年的有效时间 —— 属于 num("")===0 同一族的坑。
function atMs(v) {
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : 0;
  }
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function mdhm(d) {
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${hhmm(d)}`;
}

// 多账号求和（过滤掉拿不到余额的条目；全为 null 返回 null）
function sumCredits(kind, results) {
  const vals = (results || []).map((r) => creditsOf(kind, r)).filter((v) => v != null && Number.isFinite(v));
  if (!vals.length) return null;
  return vals.reduce((s, v) => s + v, 0);
}

// ---------------- 小工具 ----------------
function hhmm(d = new Date()) {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
function relTime(ms) {
  if (!ms || !Number.isFinite(ms)) return "";
  const diff = Date.now() - ms;
  if (diff < 60000) return "刚刚";
  if (diff < 3600000) return Math.floor(diff / 60000) + " 分钟前";
  if (diff < 86400000) return Math.floor(diff / 3600000) + " 小时前";
  return Math.floor(diff / 86400000) + " 天前";
}
