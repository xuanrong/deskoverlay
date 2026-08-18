// 音乐 / 在线音乐视图 + 全局播放器 + 音源管理。
// 全局播放器（音乐页 / 在线音乐页共享）：音频由 musicAudio 单例承载，UI 由各视图自行渲染。
import { invoke } from "../bus.js";
import { state, saveState } from "../state.js";
import { ICON_MUSIC, ICON_SHUFFLE, ICON_REPEAT } from "../icons.js";
import { esc, normalizeSongs } from "./common.js";

const musicAudio = new Audio();
let currentSong = null; // { title, artist, artwork, url, type, song, srcId, lyric }
let currentLyric = [];  // [{ time, text }] LRC 解析结果

// 解析 LRC 歌词文本 → [{ time, text }]（按时间排序）
function parseLrc(lrc) {
  const lines = [];
  const re = /\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
  for (const row of String(lrc).split(/\r?\n/)) {
    const times = [];
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(row))) {
      times.push((+m[1]) * 60 + (+m[2]) + ((+(m[3] || 0)) / 1000));
    }
    const text = row.replace(re, "").trim();
    if (text) for (const t of times) lines.push({ time: t, text });
  }
  return lines.sort((a, b) => a.time - b.time);
}

// 从音源插件拉取歌词（若 song 带 srcId 且插件实现 getLyric）
// 兼容多种返回结构：string / {lyric} / {lrc} / {lrc:{lyric}} / {lrclist:[...]} / {data:{...}}
function extractLrc(res, depth = 0) {
  if (typeof res === "string") return res;
  if (!res || typeof res !== "object" || depth > 6) return "";
  // 常见歌词字段：字符串值直接返回（要求长度 > 2 排除占位）
  for (const k of ["lyric", "lrc", "krc", "rawLrc", "lyricContent", "lrcContent", "content", "text", "txt", "lyrics"]) {
    const v = res[k];
    if (typeof v === "string" && v.trim().length > 2) return v;
  }
  // 嵌套对象：lrc.lyric / lrc.lrc / data.lyric 等
  for (const k of ["lrc", "data", "result", "info", "songinfo", "song"]) {
    const inner = res[k];
    if (inner && typeof inner === "object") {
      const s = extractLrc(inner, depth + 1);
      if (s) return s;
    }
  }
  if (Array.isArray(res.lrclist)) {
    // 酷狗 lrclist: [{ time, lineLyric }]，转 LRC 文本
    return res.lrclist.map((l) => {
      const t = l.time || l.t || 0;
      const m = Math.floor(t / 60), s = Math.floor(t % 60);
      return `[${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}]${l.lineLyric || l.text || ""}`;
    }).join("\n");
  }
  return "";
}

// 调试日志：同时输出到前端 console 与 Rust 终端（log_msg 命令）。
// 对象用循环安全的 inspect 序列化（JSON.stringify 遇循环引用会失败）。
function inspect(v, depth = 0, seen = new Set()) {
  if (v === null) return "null";
  const t = typeof v;
  if (t !== "object") return String(v).slice(0, 120);
  if (seen.has(v)) return "[Circular]";
  seen.add(v);
  if (v instanceof Date) return "Date(" + v.toISOString() + ")";
  if (Array.isArray(v)) return `Array(${v.length})[${v.map((x) => inspect(x, depth + 1, seen)).join(",").slice(0, 300)}]`;
  const keys = Object.keys(v).slice(0, 20);
  return `{${keys.map((k) => `${k}:${inspect(v[k], depth + 1, seen)}`).join(", ").slice(0, 400)}}`;
}
function dbg(...args) {
  const msg = args.map((a) => (typeof a === "string" ? a : inspect(a))).join(" ");
  console.log("[music]", msg);
  invoke("log_msg", { msg }).catch(() => {});
}

async function fetchLyric(song, srcId) {
  dbg("fetchLyric 开始", { title: song && (song.title || song.name), srcId });
  const src = (state.musicSources || []).find((x) => x.id === srcId);
  if (!src || !song) { dbg("跳过：无音源或无歌曲对象"); return; }
  try {
    const plugin = loadMusicPlugin(src.code);
    if (typeof plugin.getLyric !== "function") {
      dbg("插件无 getLyric 方法（不支持歌词）");
      if (lyricEl) lyricEl.innerHTML = `<div class="dash-empty">暂无歌词（音源不支持）</div>`;
      return;
    }
    dbg("调用 plugin.getLyric");
    const res = await plugin.getLyric(song);
    dbg("getLyric 返回结构", res);
    const lrc = extractLrc(res);
    dbg("extractLrc 结果长度", lrc.length, "| 前80字符:", lrc.slice(0, 80));
    if (!lrc) {
      if (lyricEl) lyricEl.innerHTML = `<div class="dash-empty">暂无歌词（返回为空）</div>`;
      return;
    }
    if (currentSong && currentSong.srcId === srcId) {
      currentSong.lyric = lrc;
      currentLyric = parseLrc(lrc);
      dbg("歌词解析行数", currentLyric.length);
      if (lyricEl) renderLyric();
    } else {
      dbg("歌词返回时歌曲已切换，忽略");
    }
  } catch (e) {
    dbg("歌词拉取异常", String(e));
    if (lyricEl) lyricEl.innerHTML = `<div class="dash-empty">暂无歌词（拉取失败：${esc(String(e).slice(0, 60))}）</div>`;
  }
}

// 音乐页歌词区（由 renderMusic 设置）与高亮索引
let lyricEl = null;
let lastLyricIdx = -1;
// 在线音乐弹窗结果区（由 openOnlineMusic 设置），供队列加载失败提示
let onlineResultsEl = null;
// 播放器按钮状态同步回调（由 renderMusic 设置）
let syncPlayerButtons = null;
// 音乐页 UI 同步回调（由 renderMusic 设置；播放新歌时刷新标题/歌词等）
let syncMusicUI = null;

// 渲染歌词区
function renderLyric() {
  if (!lyricEl) return;
  lyricEl.innerHTML = currentLyric.length
    ? currentLyric.map((l, i) => `<div class="ly-line${i === 0 ? " cur" : ""}" data-i="${i}">${esc(l.text)}</div>`).join("")
    : `<div class="dash-empty">暂无歌词</div>`;
  lastLyricIdx = -1;
}

// 播放队列与状态
let playQueue = [];    // [{ meta:{title,artist,artwork}, song, srcId, url, type }]
let queueIndex = -1;
let randomMode = false;
let queueModalEl = null;

// 播完自动下一首（只绑定一次）
musicAudio.addEventListener("ended", () => { if (playQueue.length) playNext(); });

// 直接播放一首（不动队列；各视图负责自己的 UI 渲染）
function loadMeta({ title, artist, artwork, url, type, song, srcId }) {
  currentSong = { title, artist, artwork, url, type, song, srcId, lyric: null };
  currentLyric = [];
  if (lyricEl) renderLyric();
  if (musicAudio.src && musicAudio.src.startsWith("blob:")) URL.revokeObjectURL(musicAudio.src);
  musicAudio.src = url;
  musicAudio.play().catch(() => {});
  if (song && srcId) fetchLyric(song, srcId);
  syncPlayerButtons?.();
  syncMusicUI?.();
}

// 在线列表播放：整列表入队，播放 index 项
function playList(list, index, src) {
  if (!list || !list.length) return;
  playQueue = list.map((s) => ({
    meta: { title: s.title || s.name, artist: s.artist || "", artwork: s.artwork },
    song: s,
    srcId: src ? src.id : null,
    url: null,
    type: src ? "在线 · " + (src.name || "") : "在线",
  }));
  queueIndex = Math.max(0, Math.min(index, playQueue.length - 1));
  loadQueueItem(queueIndex);
}

// 加载并播放队列项 i（在线项需先经 getMediaSource 取播放地址）
async function loadQueueItem(i) {
  const item = playQueue[i];
  if (!item) return;
  queueIndex = i;
  if (item.url) { loadMeta({ ...item.meta, url: item.url, type: item.type, song: item.song, srcId: item.srcId }); return; }
  if (item.srcId) {
    const src = (state.musicSources || []).find((x) => x.id === item.srcId);
    if (src) {
      // 乐观更新：立即显示目标歌曲信息（加载中），避免切歌期间 UI 停留旧歌
      currentSong = { ...item.meta, url: null, type: item.type, song: item.song, srcId: item.srcId, lyric: null };
      currentLyric = [];
      if (lyricEl) renderLyric();
      syncPlayerButtons?.();
      syncMusicUI?.();
      try {
        const plugin = loadMusicPlugin(src.code);
        const ms = await plugin.getMediaSource(item.song, "standard");
        const url = (ms && (ms.url || ms.src)) || (typeof ms === "string" ? ms : "");
        if (url) {
          item.url = url;
          loadMeta({ ...item.meta, url, type: item.type, song: item.song, srcId: item.srcId });
          return;
        }
      } catch (e) { /* 单曲失败，交给下方提示 */ }
    }
  }
  if (onlineResultsEl) onlineResultsEl.innerHTML = `<div class="dash-empty">播放失败（音源可能失效）</div>`;
}

function playNext() {
  if (!playQueue.length) return;
  const ni = randomMode
    ? Math.floor(Math.random() * playQueue.length)
    : (queueIndex + 1) % playQueue.length;
  loadQueueItem(ni);
}

function playPrev() {
  if (!playQueue.length) return;
  const pi = randomMode
    ? Math.floor(Math.random() * playQueue.length)
    : (queueIndex - 1 + playQueue.length) % playQueue.length;
  loadQueueItem(pi);
}

// 随机模式开关
function toggleRandom() {
  randomMode = !randomMode;
  syncPlayerButtons?.();
}

// 喜欢当前歌曲（♡ 收藏/取消收藏，列表在在线弹窗「喜欢」tab）
function toggleFavorite() {
  const c = currentSong;
  if (!c || !c.url) return;
  const favs = state.favorites || [];
  const i = favs.findIndex((f) => f.url === c.url);
  if (i >= 0) favs.splice(i, 1);
  else favs.push({ title: c.title, artist: c.artist, artwork: c.artwork, url: c.url });
  state.favorites = favs;
  saveState();
  syncPlayerButtons?.();
  if (favEl) renderFavoritesInto(favEl);
}

// 在线弹窗「喜欢」tab 的结果区（openOnlineMusic 设置）
let favEl = null;

// 渲染收藏歌曲列表到指定容器（点击 → 整列表入队播放）
function renderFavoritesInto(el) {
  const favs = state.favorites || [];
  el.innerHTML = favs.length
    ? favs.map((f, i) => `
      <div class="online-result">
        <span class="mr-play">▶</span>
        <span class="mr-title">${esc(f.title || "")}</span>
        <span class="mr-artist">${esc(f.artist || "")}</span>
      </div>`).join("")
    : `<div class="dash-empty">暂无喜欢的音乐，播放时点 ♡ 收藏</div>`;
  el.querySelectorAll(".online-result").forEach((row, idx) => {
    row.addEventListener("click", () => playFavorites(idx));
  });
}

// 播放收藏列表（从 idx 开始整列表入队）
function playFavorites(idx) {
  const favs = state.favorites || [];
  if (!favs.length) return;
  playQueue = favs.map((f) => ({
    meta: { title: f.title, artist: f.artist, artwork: f.artwork },
    song: null,
    srcId: null,
    url: f.url,
    type: "喜欢",
  }));
  queueIndex = Math.max(0, Math.min(idx, playQueue.length - 1));
  loadQueueItem(queueIndex);
}


// 播放队列面板
function showQueue() {
  if (queueModalEl) return;
  const ov = document.createElement("div");
  ov.className = "task-modal-overlay";
  queueModalEl = ov;
  ov.innerHTML = `
    <div class="task-modal queue-modal">
      <h3>播放队列 <span class="dash-count">${playQueue.length}</span>${randomMode ? ' <span class="q-random-on">⇄ 随机</span>' : ""}</h3>
      <div class="queue-list">
        ${playQueue.length ? playQueue.map((it, i) => `
          <div class="queue-item${i === queueIndex ? " cur" : ""}" data-i="${i}">
            <span class="qi-idx">${i + 1}</span>
            <span class="qi-title">${esc(it.meta.title || "")}</span>
            <span class="qi-artist">${esc(it.meta.artist || "")}</span>
          </div>`).join("") : `<div class="dash-empty">队列为空</div>`}
      </div>
      <div class="tm-actions"><button class="btn-primary cm-ok">关闭</button></div>
    </div>`;
  document.body.appendChild(ov);
  const close = () => { ov.remove(); queueModalEl = null; };
  ov.querySelector(".cm-ok").addEventListener("click", close);
  ov.addEventListener("click", (e) => { if (e.target === ov) close(); });
  ov.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
  ov.querySelectorAll(".queue-item").forEach((row) => {
    row.addEventListener("click", () => {
      loadQueueItem(Number(row.dataset.i));
      close();
    });
  });
}

// 给 disc 封面元素应用 artwork（URL）或恢复默认渐变
function applyArtwork(el, artwork) {
  if (!el) return;
  const icon = el.querySelector(".music-art-icon");
  if (artwork) {
    el.style.backgroundImage = `url("${esc(artwork)}")`;
    el.style.backgroundSize = "cover";
    el.style.backgroundPosition = "center";
    if (icon) icon.style.display = "none";
  } else {
    el.style.backgroundImage = "";
    if (icon) icon.style.display = "";
  }
}

// ---- 音源插件加载（模块级，供各视图复用）----
// 兼容 MusicFree 协议插件（含 jsjiami 混淆版）：
//   module.exports = { platform, async search(kw, page, type), async getMediaSource(song, quality) }
// 通过 require polyfill 提供 mock axios / he，把 HTTP 请求转到 Rust 代理（无 CORS、可带 headers）。
function loadMusicPlugin(code) {
  const mod = { exports: {} };

  const safeParse = (text) => { try { return JSON.parse(text); } catch { return text; } };
  const toQuery = (params) => {
    if (!params) return "";
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) sp.append(k, v);
    const qs = sp.toString();
    return qs ? "?" + qs : "";
  };
  // 归一化 axios 调用 → { url, method, params, headers, body }
  // 覆盖：axios.get(url,cfg) / axios.post(url,data,cfg) / axios({url,method,...})
  function normAxios(method, a, b, c) {
    if (a && typeof a === "object" && typeof a.url === "string") {
      const o = a;
      const d = o.data;
      return {
        url: o.url,
        method: (o.method || "GET").toUpperCase(),
        params: o.params,
        headers: o.headers,
        body: d !== undefined
          ? (typeof d === "string" ? d : (typeof d.append === "function" ? d.toString() : JSON.stringify(d)))
          : (o.body || ""),
      };
    }
    let params, headers, body = "";
    if (method === "GET") {
      const cfg = b || {};
      params = cfg.params; headers = cfg.headers;
    } else {
      const cfg = c || {};
      params = cfg.params; headers = cfg.headers;
      const d = b; // axios.post(url, data, config) 第二参是请求体
      if (typeof d === "string") body = d;
      else if (d && typeof d === "object") {
        if (d.append && typeof d.append === "function") {
          body = d.toString(); // URLSearchParams/FormData → "k=v&..."
        } else if ("params" in d || "headers" in d || "body" in d) {
          // 兼容旧约定：axios.post(url, {params,headers,body})
          params = d.params; headers = d.headers; body = d.body || "";
        } else {
          body = JSON.stringify(d);
        }
      }
    }
    return { url: a, method, params, headers, body };
  }
  const request = (method) => (a, b, c) => {
    const r = normAxios(method, a, b, c);
    const full = r.url + toQuery(r.params);
    const h = r.headers || {};
    const p = r.method === "POST"
      ? invoke("http_post", { url: full, body: r.body, headers: h })
      : invoke("http_get", { url: full, headers: h });
    return p.then((text) => ({
      data: safeParse(text),
      status: 200,
      statusText: "OK",
      headers: {},
      config: { url: full, method: r.method, headers: h },
      request: {},
    }));
  };

  const axiosMock = {
    get: request("GET"), post: request("POST"), put: request("POST"), delete: request("GET"),
    default: { get: request("GET"), post: request("POST") },
    create: () => axiosMock,
    interceptors: { request: { use() {} }, response: { use() {} } },
    getUri: (cfg) => (cfg && cfg.url) || "",
  };
  const heMock = {
    decode: (s) => String(s)
      .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/&#(\d+);/g, (m, n) => String.fromCharCode(n)),
    encode: (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
  };
  const require = (name) => {
    if (name === "axios") return axiosMock;
    if (name === "he") return heMock;
    if (name === "cheerio") return { load: () => ({ text: () => "", html: () => "" }) };
    if (name === "crypto-js" || name === "crypto-js/...") return {};
    if (name === "dayjs") return { default: () => ({ format: () => "" }) };
    if (name === "lodash" || name === "lodash/...") return {};
    return {};
  };

  const sandbox = {
    axios: axiosMock,
    http: {
      get: (url, opts = {}) => invoke("http_get", { url, headers: opts.headers }),
      post: (url, body = "", opts = {}) => invoke("http_post", { url, body, headers: opts.headers }),
      request: (url, opts = {}) =>
        (opts.method === "POST" ? invoke("http_post", { url, body: opts.body || "", headers: opts.headers }) : invoke("http_get", { url, headers: opts.headers })),
    },
    console, URL, URLSearchParams, encodeURIComponent, decodeURIComponent, JSON, Math, Date, Object, Array,
    String, Number, Boolean, Promise, parseInt, parseFloat, setTimeout, clearTimeout, Infinity, NaN,
  };

  const fn = new Function("module", "exports", "globalThis", "require", `'use strict';\n${code}\n`);
  fn(mod, mod.exports, sandbox, require);
  return mod.exports || {};
}

// ---- 音源管理弹窗：添加（URL/本地 js）/ 移除 ----
function showMusicSources(onDone) {
  if (document.getElementById("src-modal")) return;
  const ov = document.createElement("div");
  ov.id = "src-modal";
  ov.className = "task-modal-overlay";
  ov.innerHTML = `
    <div class="task-modal source-modal">
      <h3>音源管理</h3>
      <div class="src-list" id="src-list"></div>
      <div class="src-add">
        <input id="src-url" type="text" placeholder="音源 JS 地址（https://…）" autocomplete="off" spellcheck="false" />
        <button class="tm-cancel" id="src-add-url">添加 URL</button>
        <button class="tm-cancel" id="src-add-file">本地 .js</button>
        <input type="file" id="src-file" accept=".js" hidden />
      </div>
      <div class="src-hint">兼容 MusicFree 插件（含 jsjiami 混淆版，自动适配 axios/he）。音源自备，示例：<code>https://js.258008.xyz/nian/kg.js</code>（酷狗）、<code>https://js.258008.xyz/nian/kw.js</code>（酷我）。</div>
      <div class="tm-actions"><button class="btn-primary cm-ok" id="src-done">完成</button></div>
    </div>`;
  document.body.appendChild(ov);
  const list = ov.querySelector("#src-list");
  const close = () => { ov.remove(); if (onDone) try { onDone(); } catch (e) {} };

  function renderList() {
    list.innerHTML = (state.musicSources || []).length
      ? state.musicSources.map((s, i) => `
        <div class="src-row">
          <span class="src-name">${esc(s.name || "未命名")}</span>
          <span class="src-src">${esc(s.src || "")}</span>
          <button class="src-del" data-i="${i}" title="移除">✕</button>
        </div>`).join("")
      : `<div class="dash-empty">未安装音源</div>`;
    list.querySelectorAll(".src-del").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.musicSources.splice(Number(btn.dataset.i), 1);
        saveState();
        renderList();
      });
    });
  }

  function addSource(src, code) {
    let name = "未命名";
    try {
      const p = loadMusicPlugin(code);
      if (p && (p.platform || p.name)) name = p.platform || p.name;
    } catch (e) {
      const m = code.match(/@name\s+([^\n\r]+)/);
      if (m) name = m[1].trim();
    }
    state.musicSources.push({ id: "s" + Date.now().toString(36), name, src, code });
    saveState();
    renderList();
  }

  ov.querySelector("#src-add-url").addEventListener("click", async () => {
    const url = ov.querySelector("#src-url").value.trim();
    if (!url) return;
    try {
      const code = await invoke("http_get", { url });
      if (!code || !code.trim()) { window.alert("拉取内容为空"); return; }
      addSource(url, code);
      ov.querySelector("#src-url").value = "";
    } catch (e) {
      window.alert("拉取失败：" + e);
    }
  });

  ov.querySelector("#src-add-file").addEventListener("click", () => ov.querySelector("#src-file").click());
  ov.querySelector("#src-file").addEventListener("change", (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => addSource(f.name, String(r.result || ""));
    r.readAsText(f);
  });

  ov.querySelector("#src-done").addEventListener("click", close);
  ov.addEventListener("click", (e) => { if (e.target === ov) close(); });
  ov.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });

  renderList();
}

export function renderMusic(view) {
  view.header.innerHTML = `<div class="view-title">音乐</div><div class="view-sub">在线播放 · 点「在线」搜索歌单/榜单</div>`;
  const body = view.body;
  body.innerHTML = `
    <div class="music-view">
      <div class="music-stage">
        <div class="music-glow"></div>
        <div class="music-disc"><div class="music-art" id="music-art"><span class="music-art-icon">${ICON_MUSIC}</span></div></div>
        <div class="music-title" id="music-title">${esc(currentSong ? currentSong.title : "未选择音乐")}</div>
        <div class="music-artist" id="music-artist">${esc(currentSong ? (currentSong.artist || "") : '点「在线」搜索歌曲，或选歌单/榜单开始播放')}</div>
      </div>
      <div class="music-lyric" id="music-lyric"></div>
      <div class="music-progress-bar">
        <span class="music-time" id="music-cur">0:00</span>
        <div class="music-track" id="music-track"><div class="music-track-fill" id="music-fill"></div></div>
        <span class="music-time" id="music-dur">0:00</span>
      </div>
      <div class="music-foot">
        <div class="music-info">
          <div class="music-name" id="music-name">${esc(currentSong ? currentSong.title : "--")}</div>
          <div class="music-sub" id="music-sub">${esc(currentSong ? (currentSong.artist || currentSong.type || "") : "未播放")}</div>
        </div>
        <div class="music-controls">
          <button class="mc-btn" id="mc-like" title="喜欢（收藏到在线音乐-喜欢）">♡</button>
          <button class="mc-btn" id="mc-shuffle" title="随机/顺序播放">${ICON_REPEAT}</button>
          <button class="mc-btn" id="mc-prev" title="上一首">⏮</button>
          <button class="mc-btn mc-big" id="mc-play" title="播放/暂停">▶</button>
          <button class="mc-btn" id="mc-next" title="下一首">⏭</button>
          <button class="mc-btn" id="mc-list" title="列表">☰</button>
        </div>
        <div class="music-right">
          <button class="mc-btn mc-pill" id="mc-online" title="在线音乐（音源搜索/歌单/排行榜）">在线</button>
          <div class="mc-vol" title="音量">
            <span>♪</span>
            <input type="range" id="mc-vol-range" min="0" max="100" value="80" />
          </div>
          <button class="mc-btn" id="mc-more" title="更多">···</button>
        </div>
      </div>
    </div>`;

  const discEl = body.querySelector(".music-disc");
  const artEl = body.querySelector("#music-art");
  const titleEl = body.querySelector("#music-title");
  const artistEl = body.querySelector("#music-artist");
  const nameEl = body.querySelector("#music-name");
  const subEl = body.querySelector("#music-sub");
  const curEl = body.querySelector("#music-cur");
  const durEl = body.querySelector("#music-dur");
  const trackEl = body.querySelector("#music-track");
  const fillEl = body.querySelector("#music-fill");
  const playBtn = body.querySelector("#mc-play");
  lyricEl = body.querySelector("#music-lyric");

  const fmt = (sec) => {
    if (!isFinite(sec) || sec < 0) return "0:00";
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60).toString().padStart(2, "0");
    return `${m}:${s}`;
  };

  // 渲染当前歌曲到 UI（进入页面时同步全局播放状态）
  function syncUI() {
    if (!currentSong) return;
    titleEl.textContent = currentSong.title || "未知歌曲";
    artistEl.textContent = currentSong.artist || currentSong.type || "";
    nameEl.textContent = currentSong.title || "未知歌曲";
    subEl.textContent = currentSong.artist || currentSong.type || "";
    applyArtwork(artEl, currentSong.artwork);
    curEl.textContent = fmt(musicAudio.currentTime);
    if (musicAudio.duration) {
      durEl.textContent = fmt(musicAudio.duration);
      fillEl.style.width = (musicAudio.currentTime / musicAudio.duration * 100) + "%";
    }
    if (lyricEl) renderLyric();
  }
  // 供全局播放器在播放新歌时同步本页 UI（在线弹窗播放后立即更新标题/歌词）
  syncMusicUI = syncUI;

  function updatePlayBtn() {
    const playing = !musicAudio.paused && !!musicAudio.src;
    playBtn.textContent = playing ? "⏸" : "▶";
    if (discEl) discEl.classList.toggle("playing", playing);
  }
  function onPlayPause() { updatePlayBtn(); syncPlayerButtons?.(); }
  function onTime() {
    curEl.textContent = fmt(musicAudio.currentTime);
    if (musicAudio.duration) fillEl.style.width = (musicAudio.currentTime / musicAudio.duration * 100) + "%";
    // 歌词同步高亮
    if (currentLyric.length && lyricEl) {
      let idx = -1;
      for (let i = 0; i < currentLyric.length; i++) {
        if (musicAudio.currentTime >= currentLyric[i].time) idx = i;
        else break;
      }
      if (idx !== -1 && idx !== lastLyricIdx) {
        lastLyricIdx = idx;
        lyricEl.querySelectorAll(".ly-line").forEach((el, j) => el.classList.toggle("cur", j === idx));
        const cur = lyricEl.querySelector(".ly-line.cur");
        if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: "center", behavior: "smooth" });
      }
    }
  }
  function onMeta() { durEl.textContent = fmt(musicAudio.duration); }

  playBtn.addEventListener("click", () => {
    if (musicAudio.src) {
      if (musicAudio.paused) musicAudio.play().catch(() => {}); else musicAudio.pause();
    }
  });
  // 具名回调：先移除再添加，避免视图反复渲染时重复监听
  musicAudio.removeEventListener("play", onPlayPause);
  musicAudio.removeEventListener("pause", onPlayPause);
  musicAudio.removeEventListener("timeupdate", onTime);
  musicAudio.removeEventListener("loadedmetadata", onMeta);
  musicAudio.addEventListener("play", onPlayPause);
  musicAudio.addEventListener("pause", onPlayPause);
  musicAudio.addEventListener("timeupdate", onTime);
  musicAudio.addEventListener("loadedmetadata", onMeta);

  trackEl.addEventListener("click", (e) => {
    if (!musicAudio.duration) return;
    const r = trackEl.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    musicAudio.currentTime = pct * musicAudio.duration;
  });

  body.querySelector("#mc-vol-range").addEventListener("input", (e) => {
    musicAudio.volume = e.target.value / 100;
  });
  musicAudio.volume = 0.8;

  // 底部功能按钮：喜欢/随机/上一首/下一首/队列/在线
  const likeBtn = body.querySelector("#mc-like");
  const shuffleBtn = body.querySelector("#mc-shuffle");
  const prevBtn = body.querySelector("#mc-prev");
  const nextBtn = body.querySelector("#mc-next");
  const listBtn = body.querySelector("#mc-list");

  syncPlayerButtons = () => {
    const fav = !!(currentSong && currentSong.url && (state.favorites || []).some((f) => f.url === currentSong.url));
    likeBtn.classList.toggle("active", fav);
    likeBtn.textContent = fav ? "♥" : "♡";
    // 随机/顺序播放图标切换
    shuffleBtn.innerHTML = randomMode ? ICON_SHUFFLE : ICON_REPEAT;
    shuffleBtn.classList.toggle("active", randomMode);
    const hasQueue = playQueue.length > 0;
    prevBtn.disabled = !hasQueue;
    nextBtn.disabled = !hasQueue;
    listBtn.classList.toggle("has", playQueue.length > 0);
  };

  likeBtn.addEventListener("click", toggleFavorite);
  shuffleBtn.addEventListener("click", toggleRandom);
  prevBtn.addEventListener("click", playPrev);
  nextBtn.addEventListener("click", playNext);
  listBtn.addEventListener("click", showQueue);
  body.querySelector("#mc-online").addEventListener("click", openOnlineMusic);
  body.querySelector("#mc-more").addEventListener("click", () => {});

  syncUI();
  updatePlayBtn();
  syncPlayerButtons();
}

// -------------------- 在线音乐（音源 tab + 搜索点播） --------------------
// 在线音乐弹窗：左侧音源 tab + 顶部模式切换（搜索/排行榜/歌单）
function openOnlineMusic() {
  if (document.getElementById("online-modal")) return;
  const ov = document.createElement("div");
  ov.id = "online-modal";
  ov.className = "task-modal-overlay";
  ov.innerHTML = `
    <div class="online-modal">
      <div class="online-modal-head">
        <span class="om-title">在线音乐</span>
        <button class="om-close" title="关闭">✕</button>
      </div>
      <div class="online-body">
        <div class="online-src-side" id="online-src-side"></div>
        <div class="online-main">
          <div class="online-mode-tabs" id="online-mode-tabs">
            <button data-mode="search" class="active">搜索</button>
            <button data-mode="toplist">排行榜</button>
            <button data-mode="sheet">歌单</button>
          </div>
          <div class="online-panel" id="online-panel"></div>
          <div class="online-results" id="online-results"></div>
        </div>
      </div>
      <div class="online-hint">点歌曲即整列表加入播放队列；播放控制回到音乐页。</div>
    </div>`;
  document.body.appendChild(ov);
  onlineResultsEl = ov.querySelector("#online-results");
  const close = () => { ov.remove(); onlineResultsEl = null; favEl = null; };
  ov.querySelector(".om-close").addEventListener("click", close);
  ov.addEventListener("click", (e) => { if (e.target === ov) close(); });
  ov.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });

  const srcSideEl = ov.querySelector("#online-src-side");
  const modeTabsEl = ov.querySelector("#online-mode-tabs");
  const panelEl = ov.querySelector("#online-panel");
  const resultsEl = ov.querySelector("#online-results");
  let current = (state.musicSources || []).find((s) => s.code) || null;
  let mode = "search"; // search | toplist | sheet
  let favMode = false; // 左侧「喜欢」tab 激活时
  let panelInput = null;
  let typeSelectEl = null;

  // 显示/隐藏顶部模式与输入区（「喜欢」tab 不显示）
  function setChrome(show) {
    modeTabsEl.style.display = show ? "" : "none";
    panelEl.style.display = show ? "" : "none";
  }

  // 列表归一化
  const normalizeList = (res) => {
    if (Array.isArray(res)) return res;
    if (res && Array.isArray(res.data)) return res.data;
    if (res && res.data && Array.isArray(res.data.list)) return res.data.list;
    return [];
  };
  const normalizeMusicList = (res) => {
    if (Array.isArray(res)) return res;
    if (res && Array.isArray(res.musicList)) return res.musicList;
    if (res && Array.isArray(res.data)) return res.data;
    if (res && res.data && Array.isArray(res.data.musicList)) return res.data.musicList;
    return [];
  };

  // 上下文栏（返回 + 标题）
  function renderContext(title, back) {
    const bar = document.createElement("div");
    bar.className = "online-ctx";
    bar.innerHTML = `<button class="oc-back" title="返回">←</button><span class="oc-title">${esc(title)}</span>`;
    bar.querySelector(".oc-back").addEventListener("click", back);
    return bar;
  }

  // 渲染歌曲列表（点击 → 整列表入队播放）
  function renderSongList(songs, ctx) {
    resultsEl.innerHTML = "";
    if (ctx) resultsEl.appendChild(renderContext(ctx.title, ctx.back));
    if (!songs.length) { resultsEl.innerHTML += `<div class="dash-empty">空列表</div>`; return; }
    const frag = document.createElement("div");
    frag.innerHTML = songs.slice(0, 100).map((song) => `
      <div class="online-result">
        <span class="mr-play">▶</span>
        <span class="mr-title">${esc(song.title || song.name)}</span>
        <span class="mr-artist">${esc(song.artist || "未知歌手")}</span>
      </div>`).join("");
    frag.querySelectorAll(".online-result").forEach((row, idx) => row.addEventListener("click", () => playList(songs, idx, current)));
    resultsEl.appendChild(frag);
  }

  // 渲染集合列表（歌单/专辑/榜单，点击进入详情）
  function renderCollection(items, opts) {
    resultsEl.innerHTML = "";
    if (opts.title) resultsEl.appendChild(renderContext(opts.title, opts.back));
    if (!items.length) { resultsEl.innerHTML += `<div class="dash-empty">空列表</div>`; return; }
    const frag = document.createElement("div");
    frag.innerHTML = items.slice(0, 100).map(opts.renderRow).join("");
    frag.querySelectorAll(".online-item").forEach((row, idx) => row.addEventListener("click", () => opts.onClick(items[idx])));
    resultsEl.appendChild(frag);
  }

  // 榜单详情 → 歌曲列表
  async function loadTopListDetail(topList) {
    resultsEl.innerHTML = `<div class="dash-empty">加载中…</div>`;
    try {
      const plugin = loadMusicPlugin(current.code);
      if (typeof plugin.getTopListDetail !== "function") throw new Error("该音源不支持榜单详情");
      // 字段归一化：不同接口返回的榜单 id 字段名不同，统一补 rankid/volid
      // （酷狗 rank/song 接口必须带 rankid，否则报「参数不合法」）
      const normalized = {
        ...topList,
        rankid: topList.rankid ?? topList.id ?? topList.rank_id ?? topList.specialid ?? topList.code ?? topList.rankId,
        volid: topList.volid ?? topList.vol ?? topList.vol_id ?? topList.version,
      };
      dbg("榜单详情参数", { rankid: normalized.rankid, volid: normalized.volid, title: normalized.title });
      const res = await plugin.getTopListDetail(normalized, 1);
      renderSongList(normalizeMusicList(res), { title: "排行榜：" + (topList.title || ""), back: renderTopLists });
    } catch (e) {
      dbg("榜单详情失败", e && (e.stack || e.message));
      resultsEl.innerHTML = `<div class="dash-empty">加载失败：${esc(String(e && e.message || e))}</div>`;
    }
  }

  // 歌单详情 → 歌曲列表
  async function loadSheetDetail(sheet, keyword) {
    resultsEl.innerHTML = `<div class="dash-empty">加载中…</div>`;
    try {
      const plugin = loadMusicPlugin(current.code);
      if (typeof plugin.getMusicSheetInfo !== "function") throw new Error("该音源不支持歌单详情");
      const res = await plugin.getMusicSheetInfo(sheet, 1);
      renderSongList(normalizeMusicList(res), {
        title: "歌单：" + (sheet.title || ""),
        back: () => { if (keyword) { if (panelInput) panelInput.value = keyword; doSearch(); } else loadDefaultSheets(); },
      });
    } catch (e) {
      dbg("歌单详情失败", e && (e.stack || e.message));
      resultsEl.innerHTML = `<div class="dash-empty">加载失败：${esc(String(e && e.message || e))}</div>`;
    }
  }

  // 专辑详情 → 歌曲列表
  async function loadAlbumDetail(album, keyword) {
    resultsEl.innerHTML = `<div class="dash-empty">加载中…</div>`;
    try {
      const plugin = loadMusicPlugin(current.code);
      if (typeof plugin.getAlbumInfo !== "function") throw new Error("该音源不支持专辑详情");
      const res = await plugin.getAlbumInfo(album);
      renderSongList(normalizeMusicList(res), { title: "专辑：" + (album.title || ""), back: () => { if (panelInput) panelInput.value = keyword; doSearch(); } });
    } catch (e) {
      dbg("专辑详情失败", e && (e.stack || e.message));
      resultsEl.innerHTML = `<div class="dash-empty">加载失败：${esc(String(e && e.message || e))}</div>`;
    }
  }

  // 排行榜列表（官方协议：getTopLists 返回分组结构 [{title, data:[榜单]}]）
  async function renderTopLists() {
    if (!current) { resultsEl.innerHTML = `<div class="dash-empty">未安装音源，点「音源」安装</div>`; return; }
    resultsEl.innerHTML = `<div class="dash-empty">加载中…</div>`;
    try {
      const plugin = loadMusicPlugin(current.code);
      if (typeof plugin.getTopLists !== "function") throw new Error("该音源不支持排行榜");
      const raw = normalizeList(await plugin.getTopLists());
      dbg("getTopLists 分组(前2)", raw.slice(0, 2));
      // 收集分组与扁平索引（榜单 id 字段可能是 id/rankid，点详情时统一归一化）
      const groups = [];
      const items = [];
      for (const g of raw) {
        if (g && Array.isArray(g.data) && g.data.length) {
          groups.push({ title: g.title, list: g.data });
          for (const it of g.data) items.push(it);
        } else if (g && (g.title || g.id)) {
          groups.push({ title: "", list: [g] });
          items.push(g);
        }
      }
      if (!items.length) { resultsEl.innerHTML = `<div class="dash-empty">暂无榜单</div>`; return; }
      resultsEl.innerHTML = "";
      resultsEl.appendChild(renderContext(current.name + " · 排行榜", () => switchMode("search")));
      let html = "";
      for (const grp of groups) {
        if (grp.title) html += `<div class="online-group-title">${esc(grp.title)}</div>`;
        for (const it of grp.list) {
          html += `<div class="online-item"><span class="mr-play">▤</span><span class="mr-title">${esc(it.title || it.name)}</span><span class="mr-artist">${esc(it.description || "")}</span></div>`;
        }
      }
      const frag = document.createElement("div");
      frag.innerHTML = html;
      let idx = 0;
      frag.querySelectorAll(".online-item").forEach((row) => {
        row.addEventListener("click", () => loadTopListDetail(items[idx]));
        idx++;
      });
      resultsEl.appendChild(frag);
    } catch (e) {
      dbg("排行榜失败", e && (e.stack || e.message));
      resultsEl.innerHTML = `<div class="dash-empty">加载失败：${esc(String(e && e.message || e))}</div>`;
    }
  }

  // 歌单模式默认列表（无关键词时展示热门/推荐歌单）
  async function loadDefaultSheets() {
    if (!current) { resultsEl.innerHTML = `<div class="dash-empty">未安装音源，点「音源」安装</div>`; return; }
    resultsEl.innerHTML = `<div class="dash-empty">加载歌单中…</div>`;
    try {
      const plugin = loadMusicPlugin(current.code);
      let res = null;
      if (typeof plugin.getMusicSheetPage === "function") res = await plugin.getMusicSheetPage(1, "hot");
      else if (typeof plugin.getMusicSheets === "function") res = await plugin.getMusicSheets(1, "hot");
      const sheets = normalizeList(res);
      if (!sheets.length) {
        resultsEl.innerHTML = `<div class="dash-empty">输入关键词搜索歌单</div>`;
        return;
      }
      renderCollection(sheets, {
        title: current.name + " · 热门歌单",
        back: () => loadDefaultSheets(),
        renderRow: (it) => `<div class="online-item"><span class="mr-play">☰</span><span class="mr-title">${esc(it.title || it.name)}</span><span class="mr-artist">${esc(it.artist || it.description || "")}</span></div>`,
        onClick: (sheet) => loadSheetDetail(sheet, ""),
      });
    } catch (e) {
      dbg("默认歌单失败", e && (e.stack || e.message));
      resultsEl.innerHTML = `<div class="dash-empty">歌单加载失败：${esc(String(e && e.message || e))} · 可输入关键词搜索</div>`;
    }
  }

  // 搜索（按模式/类型分发）
  async function doSearch() {
    if (!current) { resultsEl.innerHTML = `<div class="dash-empty">未安装音源，点「音源」安装</div>`; return; }
    const kw = (panelInput && panelInput.value || "").trim();
    if (!kw) { if (panelInput) panelInput.focus(); return; }
    const type = mode === "sheet" ? "sheet" : (typeSelectEl ? typeSelectEl.value : "music");
    resultsEl.innerHTML = `<div class="dash-empty">搜索中…</div>`;
    try {
      const plugin = loadMusicPlugin(current.code);
      if (typeof plugin.search !== "function") throw new Error("插件缺少 search");
      const res = await plugin.search(kw, 1, type); // MusicFree 签名：search(kw, page, type)
      if (type === "sheet") {
        renderCollection(normalizeList(res), {
          title: `歌单「${kw}」`,
          back: () => { if (panelInput) panelInput.value = kw; doSearch(); },
          renderRow: (it) => `<div class="online-item"><span class="mr-play">☰</span><span class="mr-title">${esc(it.title || it.name)}</span><span class="mr-artist">${esc(it.artist || it.description || "")}</span></div>`,
          onClick: (sheet) => loadSheetDetail(sheet, kw),
        });
      } else if (type === "album") {
        renderCollection(normalizeList(res), {
          title: `专辑「${kw}」`,
          back: () => { if (panelInput) panelInput.value = kw; doSearch(); },
          renderRow: (it) => `<div class="online-item"><span class="mr-play">▣</span><span class="mr-title">${esc(it.title || it.name)}</span><span class="mr-artist">${esc(it.artist || it.description || "")}</span></div>`,
          onClick: (album) => loadAlbumDetail(album, kw),
        });
      } else {
        renderSongList(normalizeSongs(res), null);
      }
    } catch (e) {
      dbg("搜索失败", e && (e.stack || e.message));
      resultsEl.innerHTML = `<div class="dash-empty">搜索失败：${esc(String(e && e.message || e))}</div>`;
    }
  }

  // 搜索类型下拉（按插件 supportedSearchType 过滤；歌单走模式 tab）
  function updateTypeOptions(typeEl) {
    typeEl.innerHTML = `<option value="music">歌曲</option>`;
    if (!current) return;
    try {
      const plugin = loadMusicPlugin(current.code);
      const sup = plugin.supportedSearchType || [];
      if (sup.includes("album")) typeEl.innerHTML += `<option value="album">专辑</option>`;
    } catch (e) {}
  }

  // 模式切换
  function switchMode(m) {
    mode = m;
    modeTabsEl.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.mode === m));
    renderPanel();
    if (mode === "toplist") {
      renderTopLists();
    } else if (mode === "sheet") {
      loadDefaultSheets();
    } else {
      resultsEl.innerHTML = `<div class="dash-empty">在「${esc(current ? current.name : "")}」搜索</div>`;
    }
  }

  // 渲染顶部输入面板（搜索 / 歌单 模式）
  function renderPanel() {
    if (mode === "toplist") {
      panelEl.innerHTML = `<div class="online-panel-hint">当前音源的排行榜</div>`;
      panelInput = null;
      typeSelectEl = null;
      return;
    }
    const isSheet = mode === "sheet";
    panelEl.innerHTML = `
      <input id="online-input" type="text" placeholder="${isSheet ? "搜索歌单…" : "搜索歌曲…"}" autocomplete="off" spellcheck="false" />
      ${isSheet ? "" : `<select id="online-type" title="搜索类型"><option value="music">歌曲</option></select>`}
      <button class="mc-btn mc-pill" id="online-btn">搜索</button>`;
    panelInput = panelEl.querySelector("#online-input");
    typeSelectEl = isSheet ? null : panelEl.querySelector("#online-type");
    if (typeSelectEl) updateTypeOptions(typeSelectEl);
    panelEl.querySelector("#online-btn").addEventListener("click", doSearch);
    panelInput.addEventListener("keydown", (e) => { if (e.key === "Enter") doSearch(); });
    panelInput.focus();
  }

  // 左侧音源栏：顶部固定「喜欢」，下面音源列表 + 管理
  function renderSrcSide() {
    const sources = (state.musicSources || []).filter((s) => s.code);
    if (current && !sources.some((s) => s.id === current.id)) current = sources[0] || null;
    srcSideEl.innerHTML =
      `<button class="online-src online-src-fav${favMode ? " active" : ""}" id="online-src-fav" title="喜欢的音乐">♡ 喜欢</button>` +
      (sources.length
        ? sources.map((s, i) => `
          <button class="online-src${!favMode && current && s.id === current.id ? " active" : ""}" data-i="${i}" title="${esc(s.name || "")}">${esc(s.name || "未命名")}</button>`).join("")
        : `<span class="online-src-none">未安装音源</span>`)
      + `<button class="online-src online-src-add" id="online-src-btn" title="音源管理">+ 音源</button>`;

    srcSideEl.querySelector("#online-src-fav").addEventListener("click", () => {
      favMode = true;
      favEl = resultsEl;
      renderSrcSide();
      setChrome(false);
      renderFavoritesInto(resultsEl);
    });
    srcSideEl.querySelectorAll(".online-src[data-i]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const sources = (state.musicSources || []).filter((s) => s.code);
        current = sources[Number(btn.dataset.i)] || null;
        favMode = false;
        favEl = null;
        setChrome(true);
        renderSrcSide();
        switchMode(mode);
      });
    });
    srcSideEl.querySelector("#online-src-btn").addEventListener("click", () => showMusicSources(renderSrcSide));
  }

  modeTabsEl.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => switchMode(b.dataset.mode)));

  renderSrcSide();
  switchMode("search");
}
