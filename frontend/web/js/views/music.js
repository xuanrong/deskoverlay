// 音乐 / 在线音乐视图 + 全局播放器 + 音源管理。
// 全局播放器（音乐页 / 在线音乐页共享）：音频由 musicAudio 单例承载，UI 由各视图自行渲染。
import { invoke } from "../bus.js";
import { state, saveState } from "../state.js";
import { ICON_MUSIC, ICON_SHUFFLE, ICON_REPEAT, ICON_HEART, ICON_PREV, ICON_NEXT, ICON_PLAY, ICON_PAUSE, ICON_LIST, ICON_MORE, ICON_VOLUME } from "../icons.js";
import { esc, normalizeSongs } from "./common.js";
import { createSelect } from "../selectbox.js";

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

async function fetchLyric(song, srcId) {
  const src = (state.musicSources || []).find((x) => x.id === srcId);
  if (!src || !song) return;
  try {
    const plugin = loadMusicPlugin(src.code);
    if (typeof plugin.getLyric !== "function") return;
    const res = await plugin.getLyric(song);
    const lrc = extractLrc(res);
    if (!lrc) {
      if (lyricEl) lyricEl.innerHTML = `<div class="dash-empty">暂无歌词</div>`;
      return;
    }
    if (currentSong && currentSong.srcId === srcId) {
      currentSong.lyric = lrc;
      currentLyric = parseLrc(lrc);
      if (lyricEl) renderLyric();
    }
  } catch (e) { /* 歌词拉取失败不阻塞播放 */ }
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

// 持久化播放状态（队列/索引/当前歌曲/播放中/进度），重启后恢复
function savePlayback() {
  state.playback = {
    queue: playQueue.map((it) => ({ meta: it.meta || {}, song: it.song || null, srcId: it.srcId || null, url: it.url || null, type: it.type || "在线" })),
    index: queueIndex,
    song: currentSong ? {
      title: currentSong.title, artist: currentSong.artist, artwork: currentSong.artwork,
      url: currentSong.url, type: currentSong.type, srcId: currentSong.srcId,
    } : null,
    playing: !!musicAudio.src && !musicAudio.paused,
    currentTime: musicAudio.currentTime || 0,
    volume: state.playback.volume ?? musicAudio.volume ?? 0.8,
  };
  saveState();
}
// 仅在播放、暂停、切歌（loadMeta）时写盘，避免播放期间每 10s 全量重写状态文件
musicAudio.addEventListener("play", savePlayback);
musicAudio.addEventListener("pause", savePlayback);

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
  savePlayback();
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
// forceReload=true 时忽略已缓存 url，强制重新获取（用于启动恢复，防止旧链接失效）
async function loadQueueItem(i, forceReload) {
  const item = playQueue[i];
  if (!item) return;
  queueIndex = i;
  if (item.url && !forceReload) { loadMeta({ ...item.meta, url: item.url, type: item.type, song: item.song, srcId: item.srcId }); return; }
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
  // axios 既可作为函数调用 axios({url,method,...})，也可 axios.get/post(...)（Parcel 打包插件大量用前者）
  const axiosExec = (method, a, b, c) => {
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

  const axiosMock = (cfg) => axiosExec((cfg && cfg.method) || "GET", cfg, undefined, undefined);
  axiosMock.get = (url, cfg) => axiosExec("GET", url, cfg);
  axiosMock.post = (url, data, cfg) => axiosExec("POST", url, data, cfg);
  axiosMock.put = (url, data, cfg) => axiosExec("POST", url, data, cfg);
  axiosMock.delete = (url, cfg) => axiosExec("GET", url, cfg);
  axiosMock.head = (url, cfg) => axiosExec("GET", url, cfg);
  axiosMock.default = axiosMock;
  axiosMock.create = () => axiosMock;
  axiosMock.interceptors = { request: { use() {} }, response: { use() {} } };
  axiosMock.getUri = (cfg) => (cfg && cfg.url) || "";
  const heMock = {
    decode: (s) => String(s)
      .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/&#(\d+);/g, (m, n) => String.fromCharCode(n)),
    encode: (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
  };
  // crypto-js 最小实现：仅覆盖插件用到的 Base64→UTF8 解密（不依赖浏览器 atob/TextDecoder）
  const b64decode = (str) => {
    const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";
    const s = String(str).replace(/[^A-Za-z0-9+/=]/g, "");
    let bits, h1, h2, h3, h4, i = 0, out = "";
    while (i < s.length) {
      h1 = B64.indexOf(s[i++]); h2 = B64.indexOf(s[i++]);
      h3 = B64.indexOf(s[i++]); h4 = B64.indexOf(s[i++]);
      bits = (h1 << 18) | (h2 << 12) | (h3 << 6) | h4;
      out += String.fromCharCode((bits >> 16) & 0xff, (bits >> 8) & 0xff, bits & 0xff);
    }
    return out; // 二进制串
  };
  const utf8decode = (bin) => {
    let out = "", p = 0;
    while (p < bin.length) {
      const c = bin.charCodeAt(p++);
      if (c < 0x80) out += String.fromCharCode(c);
      else if (c < 0xe0) out += String.fromCharCode(((c & 0x1f) << 6) | (bin.charCodeAt(p++) & 0x3f));
      else out += String.fromCharCode(((c & 0x0f) << 12) | ((bin.charCodeAt(p++) & 0x3f) << 6) | (bin.charCodeAt(p++) & 0x3f));
    }
    return out;
  };
  const cryptoUtf8 = {};
  const cryptoMock = {
    enc: {
      Utf8: cryptoUtf8,
      Base64: {
        parse: (str) => ({ toString: (enc) => (enc === cryptoUtf8 ? utf8decode(b64decode(str)) : String(str)) }),
        stringify: (wa) => (wa && wa.toString ? wa.toString(cryptoUtf8) : ""),
      },
    },
    MD5: () => ({ toString: () => "" }),
    AES: { decrypt: () => ({ toString: () => "" }) },
  };
  const require = (name) => {
    if (name === "axios") return axiosMock;
    if (name === "he") return heMock;
    if (name === "cheerio") return { load: () => ({ text: () => "", html: () => "" }) };
    if (name === "crypto-js" || name === "crypto-js/...") return cryptoMock;
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
  const out = mod.exports || {};
  // Parcel/ESM 打包的插件会把真实实例挂在 .default 上，需解包；
  // 不解包则 plugin.search / getMediaSource 等全部为 undefined（表现为「缺少search」）
  return out.default && typeof out.default === "object" ? out.default : out;
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

// 启动恢复：从持久化的 playback 重建队列、恢复当前歌曲与播放位置/状态
export function initPlayback() {
  const pb = state.playback;
  if (!pb || !Array.isArray(pb.queue) || !pb.queue.length) return;
  playQueue = pb.queue.map((it) => ({
    meta: it.meta || {},
    song: it.song || null,
    srcId: it.srcId || null,
    url: it.url || null,
    type: it.type || "在线",
  }));
  const idx = (typeof pb.index === "number" && pb.index >= 0 && pb.index < playQueue.length) ? pb.index : 0;
  loadQueueItem(idx, true).then(() => {
    if (pb.currentTime) {
      const seek = () => { try { musicAudio.currentTime = pb.currentTime; } catch (e) {} };
      if (musicAudio.readyState >= 1) seek();
      else musicAudio.addEventListener("loadedmetadata", seek, { once: true });
    }
    if (!pb.playing) musicAudio.pause();
    savePlayback();
  });
}

export function renderMusic(view) {
  view.header.style.display = "none";
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
          <button class="mc-btn" id="mc-like" title="喜欢（收藏到在线音乐-喜欢）">${ICON_HEART}</button>
          <button class="mc-btn" id="mc-shuffle" title="随机/顺序播放">${ICON_REPEAT}</button>
          <button class="mc-btn" id="mc-prev" title="上一首">${ICON_PREV}</button>
          <button class="mc-btn mc-big" id="mc-play" title="播放/暂停">${ICON_PLAY}</button>
          <button class="mc-btn" id="mc-next" title="下一首">${ICON_NEXT}</button>
          <button class="mc-btn" id="mc-list" title="列表">${ICON_LIST}</button>
        </div>
        <div class="music-right">
          <button class="mc-btn mc-pill" id="mc-online" title="在线音乐（音源搜索/歌单/排行榜）">在线</button>
          <div class="mc-vol" title="音量">
            <span>${ICON_VOLUME}</span>
            <input type="range" id="mc-vol-range" min="0" max="100" value="${Math.round((state.playback.volume ?? 0.8) * 100)}" />
          </div>
          <button class="mc-btn" id="mc-more" title="更多">${ICON_MORE}</button>
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
    playBtn.innerHTML = playing ? ICON_PAUSE : ICON_PLAY;
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
    // 音量跟随持久化状态：切视图/重启后保持一致
    state.playback.volume = musicAudio.volume;
  });
  // 每次渲染用持久化音量同步播放器与滑杆（不再硬编码覆盖用户设置）
  musicAudio.volume = state.playback.volume ?? 0.8;
  const volRange = body.querySelector("#mc-vol-range");
  if (volRange && Math.abs(+volRange.value - Math.round(musicAudio.volume * 100)) > 1) {
    volRange.value = Math.round(musicAudio.volume * 100);
  }

  // 底部功能按钮：喜欢/随机/上一首/下一首/队列/在线
  const likeBtn = body.querySelector("#mc-like");
  const shuffleBtn = body.querySelector("#mc-shuffle");
  const prevBtn = body.querySelector("#mc-prev");
  const nextBtn = body.querySelector("#mc-next");
  const listBtn = body.querySelector("#mc-list");

  syncPlayerButtons = () => {
    const fav = !!(currentSong && currentSong.url && (state.favorites || []).some((f) => f.url === currentSong.url));
    likeBtn.classList.toggle("active", fav);
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
            <button data-mode="toplist" class="active">排行榜</button>
            <button data-mode="sheet">歌单</button>
            <button data-mode="search">搜索</button>
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
  let mode = "toplist"; // search | toplist | sheet
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
      const res = await plugin.getTopListDetail(normalized, 1);
      renderSongList(normalizeMusicList(res), { title: "排行榜：" + (topList.title || ""), back: renderTopLists });
    } catch (e) {
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
        for (let gi = 0; gi < grp.list.length; gi++) {
          const it = grp.list[gi];
          const rank = gi + 1;
          const topCls = rank <= 3 ? ` top${rank}` : "";
          html += `<div class="online-item toplist-item${topCls}"><span class="tl-rank">${rank}</span><span class="mr-title">${esc(it.title || it.name)}</span><span class="mr-artist">${esc(it.description || "")}</span></div>`;
        }
      }
      const frag = document.createElement("div");
      frag.innerHTML = html;
      frag.querySelectorAll(".online-item").forEach((row, i) => {
        row.addEventListener("click", () => loadTopListDetail(items[i]));
      });
      resultsEl.appendChild(frag);
    } catch (e) {
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
      // 协议标准：默认推荐歌单走 getRecommendSheetsByTag（默认 tag id 为空字符串）
      if (typeof plugin.getRecommendSheetsByTag === "function") res = await plugin.getRecommendSheetsByTag({ id: "" }, 1);
      const sheets = normalizeList(res);
      if (!sheets.length) {
        resultsEl.innerHTML = `<div class="dash-empty">输入关键词搜索歌单</div>`;
        return;
      }
      renderCollection(sheets, {
        title: current.name + " · 热门歌单",
        back: () => loadDefaultSheets(),
        renderRow: (it) => `<div class="online-item sheet-item"><span class="sheet-ico">♫</span><span class="sheet-info"><span class="sheet-title">${esc(it.title || it.name)}</span><span class="sheet-desc">${esc(it.artist || it.description || "")}</span></span></div>`,
        onClick: (sheet) => loadSheetDetail(sheet, ""),
      });
    } catch (e) {
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
          renderRow: (it) => `<div class="online-item sheet-item"><span class="sheet-ico">♫</span><span class="sheet-info"><span class="sheet-title">${esc(it.title || it.name)}</span><span class="sheet-desc">${esc(it.artist || it.description || "")}</span></span></div>`,
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
      resultsEl.innerHTML = `<div class="dash-empty">搜索失败：${esc(String(e && e.message || e))}</div>`;
    }
  }

  // 搜索类型下拉（按插件 supportedSearchType 过滤；歌单走模式 tab）
  function updateTypeOptions(typeEl) {
    const opts = [{ value: "music", label: "歌曲" }];
    if (current) {
      try {
        const plugin = loadMusicPlugin(current.code);
        const sup = plugin.supportedSearchType || [];
        if (sup.includes("album")) opts.push({ value: "album", label: "专辑" });
      } catch (e) {}
    }
    typeEl._setOptions?.(opts);
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
      ${isSheet ? "" : `<div id="online-type" class="online-type-cs" title="搜索类型"></div>`}
      <button class="mc-btn mc-pill" id="online-btn">搜索</button>`;
    panelInput = panelEl.querySelector("#online-input");
    typeSelectEl = isSheet ? null : panelEl.querySelector("#online-type");
    if (typeSelectEl) {
      createSelect({ el: typeSelectEl, value: "music", options: [{ value: "music", label: "歌曲" }] });
      updateTypeOptions(typeSelectEl);
    }
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
  switchMode("toplist");
}
