// 微信读书 · DeskOverlay 外部插件
// 契约：文件默认导出 { id, title, icon, render }；render(view, api) 渲染视图。
// 本插件完全自包含，不 import 主应用内部模块；核心能力统一经 api 提供：
//   api.invoke / api.state / api.saveState / api.esc / api.showDialog
// 通过「系统设置 → 插件」选择本文件路径即可启用。

const GATEWAY = "https://i.weread.qq.com/api/agent/gateway";
const SKILL_VERSION = "1.0.4";

// 浸泡样式：插件的 UI 复用工作台 CSS 变量（var(--bg-panel-2) 等），自包含于插件内注入，主应用无需包含任何微信读书样式。
const WEREAD_CSS = `
.shelf-toolbar { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 18px; flex-wrap: wrap; }
.shelf-actions { display: flex; align-items: center; gap: 8px; flex: 0 0 auto; }
.shelf-count { font-size: 12px; color: var(--text-dim); }
.shelf-status, .shelf-error { color: var(--text-dim); font-size: 13px; padding: 12px 2px; }
.shelf-error { color: var(--danger); }
.shelf-empty { display: flex; flex-direction: column; align-items: flex-start; gap: 10px; background: var(--bg-panel-2); border: 1px solid var(--border); border-radius: var(--radius); padding: 22px 20px; }
.shelf-empty .se-title { font-size: 16px; font-weight: 700; color: var(--text); }
.shelf-empty .se-desc { font-size: 13px; line-height: 1.6; color: var(--text-dim); max-width: 460px; }
.shelf-group { margin-bottom: 22px; }
.sg-title { font-size: 13px; font-weight: 600; color: var(--text-dim); margin-bottom: 12px; display: flex; align-items: center; gap: 8px; }
.sg-title span { font-size: 10.5px; color: var(--text-faint); background: var(--bg-panel-2); border: 1px solid var(--border); padding: 1px 8px; border-radius: 999px; }
.shelf-grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); }
.shelf-card { display: flex; flex-direction: column; gap: 6px; background: var(--bg-panel-2); border: 1px solid var(--border); border-radius: var(--radius); padding: 10px; text-decoration: none; color: inherit; transition: border-color var(--t-fast), background var(--t-fast), transform var(--t-fast); }
.shelf-card:hover { border-color: var(--border-strong); background: var(--bg-hover); transform: translateY(-1px); }
.sc-cover { position: relative; width: 100%; aspect-ratio: 5 / 7; border-radius: 8px; overflow: hidden; background: var(--bg-input); flex: 0 0 auto; }
.sc-cover img { width: 100%; height: 100%; object-fit: cover; display: block; }
.sc-cover-fb { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 30px; font-weight: 800; color: var(--text-faint); }
.sc-name { font-size: 13px; font-weight: 500; color: var(--text); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; line-height: 1.35; }
.sc-meta { font-size: 11.5px; color: var(--text-faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sc-tags { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 2px; }
.sc-tags i { font-style: normal; font-size: 10px; padding: 1px 7px; border-radius: 999px; background: rgba(88,166,255,0.16); color: var(--blue); }
.shelf-card:hover .sc-name { color: var(--blue); }
.shelf-tabs { display: flex; gap: 6px; margin-bottom: 16px; flex-wrap: wrap; }
.st-tab { padding: 6px 14px; border-radius: 8px; border: 1px solid var(--border); background: transparent; color: var(--text-dim); font-size: 12.5px; font-family: var(--font); cursor: pointer; transition: all var(--t-fast); }
.st-tab:hover { background: var(--bg-hover); color: var(--text); border-color: var(--border-strong); }
.st-tab.active { color: var(--blue); border-color: rgba(88,166,255,0.4); background: rgba(88,166,255,0.12); }
.shelf-content { min-height: 0; }
.sc-progress { margin-top: 2px; min-height: 16px; display: flex; flex-direction: column; gap: 3px; }
.sc-progress:empty { display: none; }
.sc-progress .sp-bar { height: 4px; border-radius: 999px; background: var(--bg-hover); overflow: hidden; }
.sc-progress .sp-bar i { display: block; height: 100%; border-radius: 999px; background: var(--blue); }
.sc-progress > span { font-size: 10px; color: var(--text-faint); }
.wr-search { display: flex; flex-direction: column; gap: 14px; }
.wr-search-bar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.wr-search-bar input { flex: 1 1 200px; min-width: 0; background: var(--bg-input); border: 1px solid var(--border-input); color: var(--text); padding: 8px 12px; border-radius: var(--radius-sm); font-size: 14px; outline: none; font-family: var(--font); }
.wr-search-bar input:focus { border-color: var(--blue); }
.wr-scope { background: var(--bg-input); border: 1px solid var(--border-input); color: var(--text); padding: 8px 8px; border-radius: var(--radius-sm); font-size: 12.5px; outline: none; font-family: var(--font); color-scheme: dark; }
.wr-count { font-size: 12px; color: var(--text-dim); margin-bottom: 8px; }
.wr-row { display: flex; align-items: center; gap: 12px; background: var(--bg-panel-2); border: 1px solid var(--border); border-radius: var(--radius); padding: 10px; cursor: pointer; transition: border-color var(--t-fast), background var(--t-fast); }
.wr-row:hover { border-color: var(--border-strong); background: var(--bg-hover); }
.wr-cover { flex: 0 0 auto; width: 40px; height: 56px; border-radius: 6px; overflow: hidden; background: var(--bg-input); position: relative; }
.wr-cover img { width: 100%; height: 100%; object-fit: cover; display: block; }
.wr-cover .sc-cover-fb { font-size: 18px; }
.wr-info { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.wr-title { font-size: 14px; font-weight: 500; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wr-meta { font-size: 11.5px; color: var(--text-faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wr-side { flex: 0 0 auto; display: flex; flex-direction: column; align-items: flex-end; gap: 3px; }
.wr-rating { font-size: 12px; color: var(--amber); }
.wr-course { font-size: 10.5px; color: var(--text-faint); }
.book-modal { max-width: 520px; }
.bd-head { display: flex; gap: 16px; align-items: flex-start; margin-bottom: 14px; }
.bd-cover { flex: 0 0 auto; width: 88px; height: 124px; border-radius: 8px; object-fit: cover; }
.bd-titles { min-width: 0; }
.bd-title { margin: 0 0 6px; font-size: 19px; line-height: 1.3; }
.bd-sub { font-size: 12.5px; color: var(--text-dim); line-height: 1.5; }
.bd-stats { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 12px; }
.bd-stats span { font-size: 11.5px; color: var(--text-dim); background: var(--bg-panel-2); border: 1px solid var(--border); padding: 2px 9px; border-radius: 999px; }
.bd-intro { font-size: 13px; color: var(--text-dim); line-height: 1.7; margin: 0 0 16px; display: -webkit-box; -webkit-line-clamp: 6; -webkit-box-orient: vertical; overflow: hidden; }
.wr-stat-tabs { display: flex; gap: 6px; margin-bottom: 16px; flex-wrap: wrap; }
.wr-stat-body { display: flex; flex-direction: column; gap: 18px; }
.wr-stat-cards { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); }
.ws-card { background: var(--bg-panel-2); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px 18px; }
.ws-num { font-size: 20px; font-weight: 700; color: var(--text); font-variant-numeric: tabular-nums; }
.ws-label { font-size: 12px; color: var(--text-faint); margin-top: 4px; }
.wr-stat-chart { display: flex; align-items: flex-end; gap: 6px; height: 150px; padding: 12px 4px 0; border-radius: var(--radius); border: 1px solid var(--border); background: var(--bg-panel-2); overflow-x: auto; }
.ws-bar-col { flex: 1 1 0; min-width: 22px; height: 100%; display: flex; flex-direction: column; justify-content: flex-end; gap: 5px; }
.ws-bar { width: 100%; min-height: 2px; background: linear-gradient(180deg, rgba(88,166,255,0.95), rgba(88,166,255,0.4)); border-radius: 4px 4px 0 0; transition: height var(--t); }
.ws-bar-label { font-size: 9.5px; color: var(--text-faint); text-align: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
`;
function injectStyle() {
  if (document.getElementById("weread-plugin-style")) return;
  const s = document.createElement("style");
  s.id = "weread-plugin-style";
  s.textContent = WEREAD_CSS;
  document.head.appendChild(s);
}

export default {
  id: "weread",
  title: "微信读书",
  icon: `<svg viewBox="0 0 24 24"><path d="M12 6c-1.8-1.2-4.2-1.5-7-1.2A2 2 0 0 0 3 6.7V19a1.7 1.7 0 0 0 1.9 1.7C7.8 20.5 10.3 21 12 21s4.2-.5 7.1-1.3A1.7 1.7 0 0 0 21 18V6.7a2 2 0 0 0-2-2c-2.8-.3-5.2 0-7 1.3z"/><path d="M12 6.5V20"/></svg>`,
  render(view, api) {
    const { invoke, state, saveState, esc, showDialog } = api;
    injectStyle();

    // ---------- 基础工具 ----------
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

    function fmtDuration(sec) {
      const s = Math.max(0, Math.round(Number(sec) || 0));
      if (s < 60) return `${s} 秒`;
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      return h > 0 ? `${h}小时${m}分钟` : `${m}分钟`;
    }
    function weekdayLabel(ts) {
      const d = new Date(ts * 1000);
      if (Number.isNaN(d.getTime())) return "";
      const w = ["日", "一", "二", "三", "四", "五", "六"][d.getDay()];
      return `${d.getMonth() + 1}/${d.getDate()} 周${w}`;
    }

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

    view.header.style.display = "none";
    const body = view.body;
    const savedTab = state.navState?.["weread"]?.tab || "shelf";
    body.innerHTML = `
      <div class="shelf-tabs">
        ${TABS.map((t) => `<button class="st-tab${t.id === savedTab ? " active" : ""}" data-tab="${t.id}">${esc(t.title)}</button>`).join("")}
      </div>
      <div class="shelf-content"></div>`;
    const content = body.querySelector(".shelf-content");

    function switchTab(id) {
      if (!state.navState) state.navState = {};
      if (!state.navState["weread"]) state.navState["weread"] = {};
      state.navState["weread"].tab = id;
      saveState();
      body.querySelectorAll(".st-tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === id));
      content.innerHTML = "";
      ({ shelf: renderShelfTab, search: renderSearchTab, stats: renderStatsTab })[id](content, switchTab);
    }
    body.querySelectorAll(".st-tab").forEach((b) =>
      b.addEventListener("click", () => switchTab(b.dataset.tab))
    );
    switchTab(savedTab);

    // ---------- 书架（含阅读进度） ----------
    async function renderShelfTab(bodyEl) {
      const key = (state.settings && state.settings.wereadKey || "").trim();
      if (!key) {
        bodyEl.innerHTML = `
          <div class="shelf-empty">
            <div class="se-title">还没有配置微信读书 API Key</div>
            <div class="se-desc">前往 weread.qq.com/r/weread-skills 获取 wrk- 开头的密钥，配置后即可同步书架。</div>
            <button class="btn-primary" id="shelf-config">配置 API Key</button>
          </div>`;
        bodyEl.querySelector("#shelf-config").addEventListener("click", () => promptKey(() => renderShelfTab(bodyEl)));
        return;
      }

      bodyEl.innerHTML = toolbar('<button class="btn btn-ghost" id="shelf-refresh">刷新</button>') + '<div class="shelf-status">正在同步书架…</div>';
      let books, albums, hasMp;
      try {
        const data = await gw("/shelf/sync");
        books = Array.isArray(data.books) ? data.books : [];
        albums = Array.isArray(data.albums) ? data.albums : [];
        hasMp = !!(data.mp && typeof data.mp === "object");
      } catch (e) {
        bodyEl.innerHTML = toolbar('<button class="btn btn-ghost" id="shelf-config">配置</button><button class="btn btn-ghost" id="shelf-retry">重试</button>') +
          `<div class="shelf-error">书架同步失败：${esc(e.message === "NO_KEY" ? "未配置 API Key" : e.message)}</div>`;
        bodyEl.querySelector("#shelf-config").addEventListener("click", () => promptKey(() => renderShelfTab(bodyEl)));
        bodyEl.querySelector("#shelf-retry").addEventListener("click", () => renderShelfTab(bodyEl));
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
      bodyEl.innerHTML = html;

      bodyEl.querySelector("#shelf-refresh").addEventListener("click", () => renderShelfTab(bodyEl));
      bodyEl.querySelectorAll(".shelf-card[data-bid]").forEach((el) =>
        el.addEventListener("click", () => {
          const link = el.dataset.link;
          if (link) window.open(link, "_blank");
          else if (el.dataset.bid) showBookDetail(el.dataset.bid);
        })
      );
      loadBookProgresses(books, bodyEl);
    }

    async function loadBookProgresses(books, bodyEl) {
      const recent = books
        .filter((b) => b && (b.bookId || (b.bookInfo && b.bookInfo.bookId)))
        .slice()
        .sort((a, b) => (b.readUpdateTime || 0) - (a.readUpdateTime || 0))
        .slice(0, 8);
      if (!recent.length) return;
      for (const b of recent) {
        const bid = b.bookId || b.bookInfo.bookId;
        const cell = bodyEl.querySelector(`.shelf-card[data-bid="${CSS.escape(String(bid))}"] .sc-progress`);
        if (!cell) continue;
        try {
          const p = await gw("/book/getprogress", { bookId: bid }).catch(() => null);
          const prog = p?.book?.progress ?? -1;
          if (prog >= 0) cell.innerHTML = `<div class="sp-bar"><i style="width:${Math.min(100, prog)}%"></i></div><span>${prog}%${prog >= 100 ? " · 已读完" : ""}</span>`;
        } catch (_) {}
      }
    }

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
    function renderSearchTab(bodyEl) {
      bodyEl.innerHTML = `
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

      const q = bodyEl.querySelector("#wr-q");
      const scope = bodyEl.querySelector("#wr-scope");
      const results = bodyEl.querySelector("#wr-results");

      const doSearch = async () => {
        const keyword = q.value.trim();
        if (!keyword) { results.innerHTML = '<div class="dash-empty">输入关键词后搜索</div>'; return; }
        results.innerHTML = '<div class="shelf-status">正在搜索…</div>';
        try {
          const data = await gw("/store/search", { keyword, scope: Number(scope.value), count: 15 });
          const list = Array.isArray(data.results) ? data.results : [];
          const flats = [];
          for (const g of list) for (const bk of (g.books || [])) if (bk && bk.bookInfo) flats.push(bk);
          if (!flats.length) { results.innerHTML = `<div class="dash-empty">抱歉，没有找到与「${esc(keyword)}」相关的结果。</div>`; return; }
          results.innerHTML = `<div class="wr-count">为您找到 ${flats.length} 条结果</div>` + flats.map(searchRow).join("");
          results.querySelectorAll("[data-bid]").forEach((el) =>
            el.addEventListener("click", () => showBookDetail(el.dataset.bid))
          );
        } catch (e) {
          results.innerHTML = `<div class="shelf-error">搜索失败：${esc(e.message)}</div>`;
        }
      };

      bodyEl.querySelector("#wr-go").addEventListener("click", doSearch);
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

    async function showBookDetail(bookId) {
      const ov = document.createElement("div");
      ov.className = "task-modal-overlay";
      ov.innerHTML = `<div class="task-modal book-modal"><h3>加载中…</h3><p class="cm-message">正在获取书籍信息</p></div>`;
      document.body.appendChild(ov);
      const modal = ov.querySelector(".task-modal");
      ov.addEventListener("click", (e) => { if (e.target === ov) done(); });
      const done = () => ov.remove();
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

    function renderStatsTab(bodyEl) {
      const savedMode = state.navState?.["weread"]?.statMode || "monthly";
      bodyEl.innerHTML = `
        <div class="wr-stat-tabs">${STAT_MODES.map((m) => `<button class="st-tab${m.id === savedMode ? " active" : ""}" data-mode="${m.id}">${esc(m.title)}</button>`).join("")}</div>
        <div class="wr-stat-body"></div>`;
      const statBody = bodyEl.querySelector(".wr-stat-body");
      const load = async (mode) => {
        if (!state.navState) state.navState = {};
        if (!state.navState["weread"]) state.navState["weread"] = {};
        state.navState["weread"].statMode = mode;
        saveState();
        statBody.innerHTML = '<div class="shelf-status">正在统计…</div>';
        try {
          const data = await gw("/readdata/detail", { mode });
          renderStats(statBody, data, mode);
        } catch (e) {
          statBody.innerHTML = `<div class="shelf-error">获取统计失败：${esc(e.message)}</div>`;
        }
      };
      bodyEl.querySelectorAll(".wr-stat-tabs .st-tab").forEach((b) =>
        b.addEventListener("click", () => {
          bodyEl.querySelectorAll(".wr-stat-tabs .st-tab").forEach((x) => x.classList.toggle("active", x === b));
          load(b.dataset.mode);
        })
      );
      load(savedMode);
    }

    function renderStats(bodyEl, data, mode) {
      const totalSec = data.totalReadTime || 0;
      const days = data.readDays || 0;
      const avg = data.dayAverageReadTime || 0;
      let html = `
        <div class="wr-stat-cards">
          <div class="ws-card"><div class="ws-num">${fmtDuration(totalSec)}</div><div class="ws-label">总阅读时长</div></div>
          <div class="ws-card"><div class="ws-num">${days}</div><div class="ws-label">有效阅读天数</div></div>
          <div class="ws-card"><div class="ws-num">${fmtDuration(avg)}</div><div class="ws-label">日均时长</div></div>
        </div>`;
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
      bodyEl.innerHTML = html;
    }

    // ---------- 配置 API Key ----------
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
  },
};