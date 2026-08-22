// 微信读书·书架视图：通过官方 Agent 网关提供书架（电子书 + 有声书专辑 + 文章收藏）、
// 搜书与书籍详情、阅读进度、阅读统计。
// 需要先在「系统设置」配置 WEREAD API Key（state.settings.wereadKey）。
import { invoke } from "../bus.js";
import { state, saveState } from "../state.js";
import { esc, showDialog } from "./common.js";

const GATEWAY = "https://i.weread.qq.com/api/agent/gateway";
const SKILL_VERSION = "1.0.4";

// 统一的网关调用：POST /api/agent/gateway，Bearer 鉴权，业务参数平铺顶层。
async function gw(apiName, params = {}) {
  const key = (state.settings && state.settings.wereadKey || "").trim();
  if (!key) throw new Error("NO_KEY");
  const resp = await invoke("http_post", {
    url: GATEWAY,
    body: JSON.stringify(Object.assign({ api_name: apiName, skill_version: SKILL_VERSION }, params)),
    headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
  });
  const data = typeof resp === "string" ? JSON.parse(resp) : resp;
  if (data && data.errcode && data.errcode !== 0) {
    throw new Error(data.errmsg || data.message || `接口错误(${data.errcode})`);
  }
  return data;
}

// 秒 → "X小时Y分钟"
function fmtDuration(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  if (s < 60) return `${s} 秒`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}小时${m}分钟` : `${m}分钟`;
}
// 时间戳 → 星期几（统计条图标签）
function weekdayLabel(ts) {
  const d = new Date(ts * 1000);
  if (Number.isNaN(d.getTime())) return "";
  const w = ["日", "一", "二", "三", "四", "五", "六"][d.getDay()];
  return `${d.getMonth() + 1}/${d.getDate()} 周${w}`;
}

// ---------- 顶部工具栏 ----------
function toolbar(content = "") {
  return `
    <div class="shelf-toolbar">
      <div class="view-header" style="display:flex;margin:0">
        <div class="view-title">微信读书</div>
        <div class="view-sub">官方 Agent 网关</div>
      </div>
      <div class="shelf-actions">${content}</div>
    </div>`;
}

// ---------- 标签页框架 ----------
const TABS = [
  { id: "shelf", title: "书架" },
  { id: "search", title: "搜书" },
  { id: "stats", title: "阅读统计" },
];

export function renderShelf(view) {
  view.header.style.display = "none";
  const body = view.body;
  const savedTab = state.navState?.["shelf"]?.tab || "shelf";
  body.innerHTML = `
    <div class="shelf-tabs">
      ${TABS.map((t) => `<button class="st-tab${t.id === savedTab ? " active" : ""}" data-tab="${t.id}">${esc(t.title)}</button>`).join("")}
    </div>
    <div class="shelf-content"></div>`;
  const content = body.querySelector(".shelf-content");

  function switchTab(id) {
    if (!state.navState) state.navState = {};
    if (!state.navState["shelf"]) state.navState["shelf"] = {};
    state.navState["shelf"].tab = id;
    saveState();
    body.querySelectorAll(".st-tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === id));
    content.innerHTML = "";
    ({ shelf: renderShelfTab, search: renderSearchTab, stats: renderStatsTab })[id](content, switchTab);
  }
  body.querySelectorAll(".st-tab").forEach((b) =>
    b.addEventListener("click", () => switchTab(b.dataset.tab))
  );
  switchTab(savedTab);
}

// ---------- 书架（含阅读进度） ----------
async function renderShelfTab(body) {
  const key = (state.settings && state.settings.wereadKey || "").trim();
  if (!key) {
    body.innerHTML = `
      <div class="shelf-empty">
        <div class="se-title">还没有配置微信读书 API Key</div>
        <div class="se-desc">前往 weread.qq.com/r/weread-skills 获取 wrk- 开头的密钥，配置后即可同步书架。</div>
        <button class="btn-primary" id="shelf-config">配置 API Key</button>
      </div>`;
    body.querySelector("#shelf-config").addEventListener("click", () => promptKey(() => renderShelfTab(body)));
    return;
  }

  body.innerHTML = toolbar('<button class="btn btn-ghost" id="shelf-refresh">刷新</button>') + '<div class="shelf-status">正在同步书架…</div>';
  let books, albums, hasMp;
  try {
    const data = await gw("/shelf/sync");
    books = Array.isArray(data.books) ? data.books : [];
    albums = Array.isArray(data.albums) ? data.albums : [];
    hasMp = !!(data.mp && typeof data.mp === "object");
  } catch (e) {
    body.innerHTML = toolbar('<button class="btn btn-ghost" id="shelf-config">配置</button><button class="btn btn-ghost" id="shelf-retry">重试</button>') +
      `<div class="shelf-error">书架同步失败：${esc(e.message === "NO_KEY" ? "未配置 API Key" : e.message)}</div>`;
    body.querySelector("#shelf-config").addEventListener("click", () => promptKey(() => renderShelfTab(body)));
    body.querySelector("#shelf-retry").addEventListener("click", () => renderShelfTab(body));
    return;
  }

  const total = books.length + albums.length + (hasMp ? 1 : 0);
  let html = toolbar(`<span class="shelf-count">${total} 个条目</span><button class="btn btn-ghost" id="shelf-refresh">刷新</button>`);
  if (books.length) {
    html += `<div class="shelf-group"><div class="sg-title">电子书 <span>${books.length}</span></div><div class="shelf-grid">${books.map(bookCard).join("")}</div></div>`;
  }
  if (albums.length) {
    html += `<div class="shelf-group"><div class="sg-title">有声书 / 专辑 <span>${albums.length}</span></div><div class="shelf-grid">${albums.map(albumCard).join("")}</div></div>`;
  }
  if (hasMp) {
    html += `<div class="shelf-group"><div class="sg-title">文章收藏 <span>1</span></div><div class="dash-empty">书架中存在「文章收藏」入口</div></div>`;
  }
  if (total === 0) html += `<div class="dash-empty">书架是空的，去搜书页或微信读书里加几本书吧。</div>`;
  body.innerHTML = html;

  body.querySelector("#shelf-refresh").addEventListener("click", () => renderShelfTab(body));
  // 点击电子书卡片 → 打开阅读链接
  body.querySelectorAll(".shelf-card[data-bid]").forEach((el) =>
    el.addEventListener("click", () => {
      const link = el.dataset.link;
      if (link) window.open(link, "_blank");
      else if (el.dataset.bid) showBookDetail(el.dataset.bid);
    })
  );

  // 异步补充最近阅读的电子书进度（避免对整本书架逐个请求）
  loadBookProgresses(books, body);
}

// 对最近阅读的前 N 本电子书补进度条
async function loadBookProgresses(books, body) {
  const recent = books
    .filter((b) => b && (b.bookId || (b.bookInfo && b.bookInfo.bookId)))
    .slice()
    .sort((a, b) => (b.readUpdateTime || 0) - (a.readUpdateTime || 0))
    .slice(0, 8);
  if (!recent.length) return;
  for (const b of recent) {
    const bid = b.bookId || b.bookInfo.bookId;
    const cell = body.querySelector(`.shelf-card[data-bid="${CSS.escape(String(bid))}"] .sc-progress`);
    if (!cell) continue;
    try {
      const p = await gw("/book/getprogress", { bookId: bid }).catch(() => null);
      const prog = p?.book?.progress ?? -1;
      if (prog >= 0) cell.innerHTML = `<div class="sp-bar"><i style="width:${Math.min(100, prog)}%"></i></div><span>${prog}%${prog >= 100 ? " · 已读完" : ""}</span>`;
    } catch (_) { /* 单本失败不影响其它 */ }
  }
}

// 单本电子书卡片（含进度占位、点击查看详情）
function bookCard(b) {
  const info = b.bookInfo || b;
  const bid = b.bookId || info.bookId || "";
  const cover = info.cover || "";
  const title = info.title || "未命名";
  const tags = [];
  if (b.finishReading === 1) tags.push("读完");
  if (b.isTop === 1) tags.push("置顶");
  if (b.secret === 1) tags.push("私密");
  return `
    <div class="shelf-card" data-bid="${esc(bid)}" data-link="${esc(b.deepLink || info.deepLink || "")}" title="${esc(title)}">
      <span class="sc-cover">${cover ? `<img src="${esc(cover)}" alt="" loading="lazy" />` : `<span class="sc-cover-fb">${esc(title.slice(0, 1))}</span>`}</span>
      <span class="sc-name">${esc(title)}</span>
      <span class="sc-meta">${esc([info.author, info.category].filter(Boolean).join(" · ")) || "—"}</span>
      ${tags.length ? `<span class="sc-tags">${tags.map((t) => `<i>${esc(t)}</i>`).join("")}</span>` : ""}
      <span class="sc-progress"></span>
    </div>`;
}

// 有声书专辑卡片
function albumCard(a) {
  const info = a.albumInfo || {};
  const link = a.deepLink || "";
  const name = info.name || "未命名专辑";
  const extra = a.albumInfoExtra || {};
  const tags = [];
  if (info.finish === 1) tags.push("完结");
  if (extra.secret === 1) tags.push("私密");
  return `
    <a class="shelf-card${link ? "" : " no-link"}" ${link ? `href="${esc(link)}" target="_blank" rel="noopener"` : ""} title="${esc(name)}">
      <span class="sc-cover">${info.cover ? `<img src="${esc(info.cover)}" alt="" loading="lazy" />` : `<span class="sc-cover-fb">${esc(name.slice(0, 1))}</span>`}</span>
      <span class="sc-name">${esc(name)}</span>
      <span class="sc-meta">${esc([info.authorName, info.finishStatus].filter(Boolean).join(" · ")) || "—"}</span>
      ${tags.length ? `<span class="sc-tags">${tags.map((t) => `<i>${esc(t)}</i>`).join("")}</span>` : ""}
    </a>`;
}

// ---------- 搜书 + 书籍详情 ----------
function renderSearchTab(body) {
  body.innerHTML = `
    <div class="wr-search">
      <div class="wr-search-bar">
        <input id="wr-q" type="text" placeholder="搜索书名 / 作者 / 关键词…" />
        <select id="wr-scope" class="wr-scope">
          <option value="10">电子书</option>
          <option value="0">全部</option>
          <option value="16">网文小说</option>
          <option value="14">有声书</option>
          <option value="6">作者</option>
          <option value="12">全文</option>
        </select>
        <button class="btn-primary" id="wr-go">搜索</button>
      </div>
      <div class="wr-results" id="wr-results"></div>
    </div>`;

  const q = body.querySelector("#wr-q");
  const scope = body.querySelector("#wr-scope");
  const results = body.querySelector("#wr-results");

  const doSearch = async () => {
    const keyword = q.value.trim();
    if (!keyword) { results.innerHTML = '<div class="dash-empty">输入关键词后搜索</div>'; return; }
    results.innerHTML = '<div class="shelf-status">正在搜索…</div>';
    try {
      const data = await gw("/store/search", { keyword, scope: Number(scope.value), count: 15 });
      const list = (Array.isArray(data.results) ? data.results : []);
      const flats = [];
      for (const g of list) for (const bk of (g.books || [])) if (bk && bk.bookInfo) flats.push(bk);
      if (!flats.length) { results.innerHTML = `<div class="dash-empty">抱歉，没有找到与「${esc(keyword)}」相关的结果。</div>`; return; }
      results.innerHTML = `<div class="wr-count">为您找到 ${flats.length} 条结果</div>` + flats.map((bk) => searchRow(bk)).join("");
      results.querySelectorAll("[data-bid]").forEach((el) =>
        el.addEventListener("click", () => showBookDetail(el.dataset.bid))
      );
    } catch (e) {
      results.innerHTML = `<div class="shelf-error">搜索失败：${esc(e.message)}</div>`;
    }
  };

  body.querySelector("#wr-go").addEventListener("click", doSearch);
  q.addEventListener("keydown", (e) => { if (e.key === "Enter") doSearch(); });
  q.focus();
}

function searchRow(bk) {
  const info = bk.bookInfo;
  const cover = info.cover || "";
  const rating = typeof info.newRating === "number" ? (info.newRating / 10).toFixed(1) : "—";
  const tag = (info.newRatingDetail && info.newRatingDetail.title) || "";
  return `
    <div class="wr-row" data-bid="${esc(info.bookId)}">
      <span class="wr-cover">${cover ? `<img src="${esc(cover)}" alt="" loading="lazy" />` : `<span class="sc-cover-fb">${esc((info.title || "书").slice(0, 1))}</span>`}</span>
      <span class="wr-info">
        <span class="wr-title">${esc(info.title || "未命名")}</span>
        <span class="wr-meta">${esc([info.author, info.category, info.publisher].filter(Boolean).join(" · ")) || "—"}</span>
      </span>
      <span class="wr-side"><span class="wr-rating">${esc(tag ? `${tag} ${rating}` : rating)}</span>${info.readingCount ? `<span class="wr-course">在读 ${info.readingCount}</span>` : ""}</span>
    </div>`;
}

// 书籍详情弹窗
async function showBookDetail(bookId) {
  const ov = document.createElement("div");
  ov.className = "task-modal-overlay";
  ov.innerHTML = `<div class="task-modal book-modal"><h3>加载中…</h3><p class="cm-message">正在获取书籍信息</p></div>`;
  document.body.appendChild(ov);
  const modal = ov.querySelector(".task-modal");
  ov.addEventListener("click", (e) => { if (e.target === ov) close(); });
  const done = () => { ov.remove(); };
  const close = () => done();

  try {
    const info = await gw("/book/info", { bookId });
    modal.innerHTML = `
      <div class="bd-head">
        ${info.cover ? `<img class="bd-cover" src="${esc(info.cover)}" alt="" />` : ""}
        <div class="bd-titles">
          <h3 class="bd-title">${esc(info.title || "未命名")}</h3>
          <div class="bd-sub">${esc([info.author, info.translator && ("译 " + info.translator), info.category].filter(Boolean).join(" · "))}</div>
        </div>
      </div>
      <div class="bd-stats">
        <span>评分 ${typeof info.newRating === "number" ? (info.newRating / 10).toFixed(1) : "—"}</span>
        ${info.wordCount ? `<span>${esc(info.wordCount)} 字</span>` : ""}
        ${info.publisher ? `<span>${esc(info.publisher)}</span>` : ""}
        ${info.publishTime ? `<span>${esc(info.publishTime)}</span>` : ""}
      </div>
      ${info.intro ? `<p class="bd-intro">${esc(info.intro)}</p>` : ""}
      <div class="tm-actions">
        ${info.deepLink ? `<a class="btn-primary" href="${esc(info.deepLink)}" target="_blank" rel="noopener" style="text-decoration:none">打开阅读</a>` : ""}
        <button class="tm-cancel" id="bd-close">关闭</button>
      </div>`;
    modal.querySelector("#bd-close").addEventListener("click", done);
  } catch (e) {
    modal.innerHTML = `<h3>获取失败</h3><p class="cm-message">${esc(e.message)}</p><div class="tm-actions"><button class="tm-cancel" id="bd-close">关闭</button></div>`;
    modal.querySelector("#bd-close").addEventListener("click", done);
  }
}

// ---------- 阅读统计 ----------
const STAT_MODES = [
  { id: "weekly", title: "本周" },
  { id: "monthly", title: "本月" },
  { id: "annually", title: "本年" },
  { id: "overall", title: "总计" },
];

function renderStatsTab(body) {
  const savedMode = state.navState?.["shelf"]?.statMode || "monthly";
  body.innerHTML = `
    <div class="wr-stat-tabs">${STAT_MODES.map((m) => `<button class="st-tab${m.id === savedMode ? " active" : ""}" data-mode="${m.id}">${esc(m.title)}</button>`).join("")}</div>
    <div class="wr-stat-body"></div>`;
  const statBody = body.querySelector(".wr-stat-body");
  const load = async (mode) => {
    if (!state.navState) state.navState = {};
    if (!state.navState["shelf"]) state.navState["shelf"] = {};
    state.navState["shelf"].statMode = mode;
    saveState();
    statBody.innerHTML = '<div class="shelf-status">正在统计…</div>';
    try {
      const data = await gw("/readdata/detail", { mode });
      renderStats(statBody, data, mode);
    } catch (e) {
      statBody.innerHTML = `<div class="shelf-error">获取统计失败：${esc(e.message)}</div>`;
    }
  };
  body.querySelectorAll(".wr-stat-tabs .st-tab").forEach((b) =>
    b.addEventListener("click", () => {
      body.querySelectorAll(".wr-stat-tabs .st-tab").forEach((x) => x.classList.toggle("active", x === b));
      load(b.dataset.mode);
    })
  );
  load(savedMode);
}

function renderStats(body, data, mode) {
  const totalSec = data.totalReadTime || 0;
  const days = data.readDays || 0;
  const avg = data.dayAverageReadTime || 0;
  let html = `
    <div class="wr-stat-cards">
      <div class="ws-card"><div class="ws-num">${fmtDuration(totalSec)}</div><div class="ws-label">总阅读时长</div></div>
      <div class="ws-card"><div class="ws-num">${days}</div><div class="ws-label">有效阅读天数</div></div>
      <div class="ws-card"><div class="ws-num">${fmtDuration(avg)}</div><div class="ws-label">日均时长</div></div>
    </div>`;

  // 条图：readTimes / dailyReadTimes（key=起始时间戳，value=秒）
  const buckets = data.readTimes && typeof data.readTimes === "object"
    ? data.readTimes : (data.dailyReadTimes && typeof data.dailyReadTimes === "object" ? data.dailyReadTimes : null);
  if (buckets) {
    const entries = Object.entries(buckets)
      .map(([k, v]) => ({ ts: Number(k), sec: Number(v) }))
      .filter((e) => !Number.isNaN(e.ts) && e.sec > 0)
      .sort((a, b) => a.ts - b.ts);
    if (entries.length) {
      const max = Math.max(...entries.map((e) => e.sec), 1);
      html += `<div class="wr-stat-chart">` + entries.map((e) => {
        const h = Math.max(2, Math.round((e.sec / max) * 90));
        const label = mode === "annually" || mode === "overall" ? new Date(e.ts * 1000).toLocaleDateString() : weekdayLabel(e.ts);
        return `<div class="ws-bar-col" title="${esc(label)} · ${fmtDuration(e.sec)}"><div class="ws-bar" style="height:${h}%"></div><div class="ws-bar-label">${esc(label)}</div></div>`;
      }).join("") + `</div>`;
    }
  }
  body.innerHTML = html;
}

// ---------- 配置 API Key 弹窗 ----------
function promptKey(ok) {
  showDialog({
    title: "配置微信读书 API Key",
    message: "在 weread.qq.com/r/weread-skills 获取 wrk- 开头的密钥",
    input: true,
    inputValue: (state.settings && state.settings.wereadKey) || "",
    okText: "保存",
  }).then((val) => {
    if (val === null) return;
    if (!state.settings) state.settings = {};
    state.settings.wereadKey = val;
    saveState();
    ok && ok();
  });
}