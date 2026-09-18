// 音乐 / 在线音乐视图 + 全局播放器 + 音源管理。
// 全局播放器（音乐页 / 在线音乐页共享）：音频由 musicAudio 单例承载，UI 由各视图自行渲染。
import { Bus, invoke } from "../bus.js";
import { state, saveState } from "../state.js";
import { ICON_MUSIC, ICON_SHUFFLE, ICON_REPEAT, ICON_HEART, ICON_PREV, ICON_NEXT, ICON_PLAY, ICON_PAUSE, ICON_LIST, ICON_MORE, ICON_VOLUME, ICON_VOLUME_MUTE, ICON_LOCATE, ICON_CLOSE, ICON_BACK, ICON_ALBUM, ICON_LYRICS } from "../icons.js";
import { esc, normalizeSongs } from "./common.js";
import { createSelect } from "../selectbox.js";

const musicAudio = new Audio();
let currentSong = null; // { title, artist, artwork, url, type, song, srcId, lyric }
let currentLyric = [];  // [{ time, text }] LRC 解析结果

// 解析 LRC 歌词文本 → [{ time, text, words? }]（按时间排序）
//
// 小数位语义（易错点）：LRC 的 `[mm:ss.xx]` 中 `.xx` 是**十进制小数秒**，
// `.34` = 340ms、`.3` = 300ms，**不是**毫秒数。原实现一律 `frac/1000`，
// 导致两位小数（最常见格式）每行偏 ~0.3s、一位小数偏 ~0.5s。
// 正确做法是按位数定标：1 位 /10、2 位 /100、3 位 /1000。
function fracToSec(frac) {
  if (!frac) return 0;
  const n = parseInt(frac, 10) || 0;
  return frac.length === 1 ? n / 10 : frac.length === 2 ? n / 100 : n / 1000;
}

// 逐字标签解析（QRC / 增强型 LRC 的 <mm:ss.xx> 或 <ms,ms> 形式）：
//   <00:12.34>字<00:12.80>字     —— 增强 LRC，每个标签是该字的起始时刻
//   [1234,567]字[1780,410]字     —— QRC，[起始毫秒,持续毫秒]
// 返回 [{ t, d, text }]，无逐字数据时返回空数组（调用方回退到整行线性扫描）。
function parseWordTags(text, fromIdx = 0) {
  // fromIdx：跳过 QRC 行头 [起始ms,持续ms]，否则行头会被误当成第一个「字」
  const body = text.slice(fromIdx);
  const words = [];
  // 增强 LRC：<mm:ss.xx> 或 <mm:ss.xxx>（绝对时间轴）
  const reEnh = /<(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?>/g;
  // QRC：[起始ms,持续ms] 或 (起始ms,持续ms)
  const reQrc = /[[(](\d+),(\d+)[\])]/g;
  const collect = (parts, toT, hasDur) => {
    for (let i = 0; i < parts.length; i++) {
      const seg = body.slice(parts[i].idx + parts[i].len, i + 1 < parts.length ? parts[i + 1].idx : undefined);
      if (!seg) continue;
      const t = toT(parts[i]);
      const d = hasDur ? parts[i].d : (i + 1 < parts.length ? toT(parts[i + 1]) - t : 0);
      words.push({ t, d, text: seg });
    }
  };
  if (reEnh.test(body)) {
    reEnh.lastIndex = 0;
    const parts = [];
    let m;
    while ((m = reEnh.exec(body))) parts.push({ idx: m.index, len: m[0].length, t: (+m[1]) * 60 + (+m[2]) + fracToSec(m[3]), d: 0 });
    collect(parts, (p) => p.t, false);
    return words;
  }
  if (reQrc.test(body)) {
    reQrc.lastIndex = 0;
    const parts = [];
    let m;
    while ((m = reQrc.exec(body))) parts.push({ idx: m.index, len: m[0].length, t: (+m[1]) / 1000, d: (+m[2]) / 1000 });
    collect(parts, (p) => p.t, true);
    return words;
  }
  return words;
}

function parseLrc(lrc) {
  const lines = [];
  const re = /\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
  for (const row of String(lrc).split(/\r?\n/)) {
    const times = [];
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(row))) {
      times.push((+m[1]) * 60 + (+m[2]) + fracToSec(m[3]));
    }
    // 纯 QRC：行首是 [起始ms,持续ms]，没有 [mm:ss] 行标签 —— 需先识别出来。
    let headerEnd = 0;
    if (!times.length) {
      const h = /^\s*\[(\d+),(\d+)\]/.exec(row);
      if (h) {
        times.push((+h[1]) / 1000);
        headerEnd = h[0].length;
      }
    }
    // 逐字标签要先剥离再取正文，否则 <..> / [ms,ms] 会混进显示文本
    const words = parseWordTags(row, headerEnd);
    // 关键兜底：**纯逐字歌词**（整行只有 <mm:ss.xx> 或 [ms,ms]，没有行级标签）
    // 若不从首字推导行起始时刻，times 为空 → 整行被丢弃，逐字歌词完全无法显示。
    if (!times.length && words.length) times.push(words[0].t);
    const text = row
      .replace(re, "")
      .replace(/<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g, "")
      .replace(/[[(]\d+,\d+[\])]/g, "")
      .trim();
    if (!text) continue;
    for (const t of times) lines.push({ time: t, text, words: words.length ? words : undefined });
  }
  return lines.sort((a, b) => a.time - b.time);
}

// 从音源插件拉取歌词（若 song 带 srcId 且插件实现 getLyric）
// 兼容多种返回结构：string / {lyric} / {lrc} / {lrc:{lyric}} / {lrclist:[...]} / {data:{...}}
//
// 逐字优先：音源常**同时**返回行级与逐字两份歌词（如 lyric + qrc/yrc/krc），
// 若按字段名顺序取第一个字符串，会选中行级版本 → 逐字信息永久拿不到（表现为「只能同步到行」）。
// 故先扫一遍「逐字字段名」，命中就用它；没有才回退到行级字段。
const WORD_FIELDS = ["qrc", "yrc", "krc", "wordByWord", "lyricWords", "enhancedLrc", "verbatimLyric"];
const LINE_FIELDS = ["lyric", "lrc", "rawLrc", "lyricContent", "lrcContent", "content", "text", "txt", "lyrics"];

// 判断文本是否含逐字标签（增强 LRC 的 <mm:ss.xx> 或 QRC 的 [ms,ms]）
function hasWordTags(s) {
  return /<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/.test(s) || /\[\d+,\d+\]/.test(s);
}

function extractLrc(res, depth = 0) {
  if (typeof res === "string") return res;
  if (!res || typeof res !== "object" || depth > 6) return "";
  // 1) 优先逐字字段：命中即返回，避免被行级字段遮蔽
  for (const k of WORD_FIELDS) {
    const v = res[k];
    if (typeof v === "string" && v.trim().length > 2 && hasWordTags(v)) return v;
  }
  // 2) 任意字段里带逐字标签的字符串（兜底：字段名不固定时也能捞到）
  for (const k of Object.keys(res)) {
    const v = res[k];
    if (typeof v === "string" && v.trim().length > 2 && hasWordTags(v)) return v;
  }
  // 3) 回退行级字段（常见歌词字段：字符串值直接返回，长度 > 2 排除占位）
  for (const k of LINE_FIELDS) {
    const v = res[k];
    if (typeof v === "string" && v.trim().length > 2) return v;
  }
  // 4) 嵌套对象：lrc.lyric / data.lyric 等
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
      // 歌词是**异步**到达的（音源插件网络请求）：此时行号大概率没变，
      // 不强制推一次的话，歌词窗口会一直停在「歌名 — 歌手」的占位态。
      pushLyric(true);
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

// ── 桌面歌词（独立窗口）状态 ──
// P1 骨架：仅维护「是否已显示」的会话内状态，不落盘（持久化在 P4 接 state.lyric）。
let lyricVisible = false;
let lyricBtnEl = null;
function syncLyricBtn() {
  if (lyricBtnEl) lyricBtnEl.classList.toggle("active", lyricVisible);
}
// 歌词窗口拖动结束后回写位置 → 由**主窗口**落盘。
// 歌词窗口不能自己调 save_state：它是整体覆盖写，而歌词窗口手里只有启动时的旧快照，
// 落盘会抹掉主窗口刚写的任务/笔记改动。故维持「主窗口是 state.json 唯一写者」。
Bus.on("lyric://moved", (pos) => {
  if (!pos || typeof pos !== "object") return;
  if (!state.lyric || typeof state.lyric !== "object") state.lyric = {};
  state.lyric.pos = {
    xRatio: Number(pos.xRatio) || 0.5,
    yRatio: Number(pos.yRatio) || 0.92,
    monitorIndex: Number(pos.monitorIndex) || 0,
  };
  saveState();
});
// 歌词窗口被它自己的关闭按钮销毁 → 复位主窗口的按钮态（否则按钮会停在「已开启」）。
Bus.on("lyric-hidden", () => {
  lyricVisible = false;
  lyricWinOn = false;
  syncLyricBtn();
});
// 歌词条形态/样式/字号变更（歌词页右键菜单发起）→ 由**主窗口**落盘。
// 与位置回写同理：歌词页只有启动时的旧快照，自己写 save_state 会抹掉主窗口的改动。
Bus.on("lyric://display", (p) => {
  if (!p || typeof p !== "object") return;
  if (!state.lyric || typeof state.lyric !== "object") state.lyric = {};
  if (["single", "double"].includes(p.form)) state.lyric.form = p.form;
  if (["stroke", "capsule", "bold"].includes(p.style)) state.lyric.style = p.style;
  if (["left", "center", "right"].includes(p.align)) state.lyric.align = p.align;
  if (typeof p.fontSize === "number") state.lyric.fontSize = Math.max(12, Math.min(28, Math.round(p.fontSize)));
  // 自定义颜色（空串 = 回到默认）。格式已在 Rust 侧校验，这里照单落盘。
  if (typeof p.colorText === "string") state.lyric.colorText = p.colorText;
  if (typeof p.colorFill === "string") state.lyric.colorFill = p.colorFill;
  // 时间偏移（秒）：歌词条工具条循环档位发起，落盘后 pushLyric 检测到变化会强推一行
  if (typeof p.offset === "number" && isFinite(p.offset)) {
    state.lyric.offset = Math.max(-5, Math.min(5, Math.round(p.offset * 2) / 2));
  }
  saveState();
});

// ────────────────── 桌面歌词推送层（P2） ──────────────────
// 刻意放在**模块级**而非 renderMusic 的闭包内：initPlayback 会在应用启动时恢复上次播放，
// 那一刻音乐页可能从未渲染过（闭包内的 timeupdate 监听尚未绑定）→ 歌词窗口永远收不到数据。
// 模块级监听与视图渲染解耦，切到其他模块时桌面歌词照常跟随。
let lyricWinOn = false;   // 歌词窗口是否已显示 —— 推送的总闸门（关着时一次 IPC 都不发）
let lastPushedIdx = -2;   // 已推送的行号；与主窗口歌词区的 lastLyricIdx 分开维护，互不污染
let lastLyricOffset = 0;  // 上次推送用的偏移 —— 变化时要强推一行（t0 平移了，仅靠行号去重会漏）

// 歌词时间偏移（设置 → 桌面歌词 → 时间偏移）：正 = 歌词提前，负 = 延后。
// 行查找与 t0 都用「音频时间 + 偏移」，染色进度随之整体平移；0 = 不偏移。
function lyricOffset() {
  const v = state.lyric?.offset;
  return typeof v === "number" && isFinite(v) ? v : 0;
}

// t 时刻应高亮的行号（-1 = 尚未到第一行）
function lyricIdxAt(t) {
  let idx = -1;
  for (let i = 0; i < currentLyric.length; i++) {
    if (t >= currentLyric[i].time) idx = i;
    else break;
  }
  return idx;
}

// 组装推给歌词窗口的一行。
// `t0` 是推送瞬间的音频时间 —— 歌词窗口据此**校准**染色进度：timeupdate 约 4Hz，
// 行切换最多迟 250ms 才被检测到，若以「收到事件的时刻」为锚点，染色会整体晚一拍；
// 带上 t0 后窗口能算出「此刻音频已走到哪」，进度立刻对齐。
function lyricPayload(idx) {
  const title = currentSong?.title || "";
  const artist = currentSong?.artist || currentSong?.type || "";
  const playing = !!musicAudio.src && !musicAudio.paused;
  // t0 带上偏移：歌词窗口用它相对行边界算染色进度，偏移即整体平移进度
  const t0 = (musicAudio.currentTime || 0) + lyricOffset();
  // 无歌词（纯音乐 / 音源未实现 getLyric）：退化为「歌名 — 歌手」，绝不留空窗
  if (!currentLyric.length) return { idx: -1, text: "", title, artist, playing, t0, idle: true };
  const i = Math.max(0, Math.min(currentLyric.length - 1, idx));
  const cur = currentLyric[i];
  const next = currentLyric[i + 1];
  return {
    idx: i,
    text: cur.text,
    next: next ? next.text : "",   // 供后续双行形态使用
    lineStart: cur.time,
    // 末行没有下一行：给一个默认时长，避免染色层无从计算进度
    lineEnd: next ? next.time : cur.time + 6,
    // 逐字时间轴（有则精确到字，无则由窗口回退整行线性扫描）。
    // 只传相对行首的偏移秒数，不传绝对时间 —— 窗口侧无需知道歌曲绝对时间轴。
    words: Array.isArray(cur.words) && cur.words.length
      ? cur.words.map((w) => ({ t: +(w.t - cur.time).toFixed(3), d: +w.d.toFixed(3), text: w.text }))
      : null,
    title, artist, playing, t0, idle: false,
  };
}

// 推送当前行。force=true 时忽略行号去重（播放状态变化 / 换歌 / 窗口刚显示时用）。
function pushLyric(force) {
  if (!lyricWinOn) return;
  const off = lyricOffset();
  // 偏移变化也要强推：行号可能没变，但 t0 / 染色进度整体平移了，
  // 否则改完偏移要等下一行才生效。timeupdate 最多 ~250ms 后应用。
  if (off !== lastLyricOffset) { force = true; lastLyricOffset = off; }
  const idx = lyricIdxAt(musicAudio.currentTime + off);
  if (!force && idx === lastPushedIdx) return;
  lastPushedIdx = idx;
  invoke("lyric_sync", { payload: lyricPayload(idx) }).catch(() => {});
}

// 行号变化才推送 → 推送频率 = 歌词行数，而非每秒 4 次（timeupdate 的触发频率）。
musicAudio.addEventListener("timeupdate", () => pushLyric(false));
// 播放/暂停要强制推一次：行号没变，但 playing 变了，歌词窗口需据此停/启染色动画。
musicAudio.addEventListener("play", () => pushLyric(true));
musicAudio.addEventListener("pause", () => pushLyric(true));

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
    muted: !!state.playback.muted,
    preMuteVolume: state.playback.preMuteVolume ?? 0.8,
  };
  saveState();
}
// 仅在播放、暂停、切歌（loadMeta）时写盘，避免播放期间每 10s 全量重写状态文件
musicAudio.addEventListener("play", savePlayback);
musicAudio.addEventListener("pause", savePlayback);

// 耳机断开/没电自动暂停：监听音频输出设备变化，有输出设备被移除且正在播放时立即暂停，
// 防止系统自动切到扬声器外放。（devicechange 在 WebView2/Chromium 下对输出设备生效）
let lastOutputIds = null;
async function snapshotOutputIds() {
  try {
    if (!navigator.mediaDevices?.enumerateDevices) return null;
    const devs = await navigator.mediaDevices.enumerateDevices();
    // 无麦克风权限时 deviceId 可能为空串，因此同时保留数量用于对比
    return devs.filter((d) => d.kind === "audiooutput").map((d) => d.deviceId || `anon:${d.label || "?"}`).sort();
  } catch { return null; }
}
snapshotOutputIds().then((ids) => { lastOutputIds = ids; });
if (navigator.mediaDevices?.addEventListener) {
  navigator.mediaDevices.addEventListener("devicechange", async () => {
    const now = await snapshotOutputIds();
    if (!now || !lastOutputIds) { lastOutputIds = now; return; }
    // 设备被移除（按 id 对比 + 数量减少兜底，兼容无权限时 deviceId 为空的实现）
    const removed =
      lastOutputIds.some((id) => id && !id.startsWith("anon:") && !now.includes(id)) ||
      now.length < lastOutputIds.length;
    if (removed && !musicAudio.paused) musicAudio.pause(); // pause 事件自动同步 UI 与播放状态
    lastOutputIds = now;
  });
}

// 直接播放一首（不动队列；各视图负责自己的 UI 渲染）
function loadMeta({ title, artist, artwork, url, type, song, srcId }) {
  currentSong = { title, artist, artwork, url, type, song, srcId, lyric: null };
  currentLyric = [];
  if (lyricEl) renderLyric();
  if (musicAudio.src && musicAudio.src.startsWith("blob:")) URL.revokeObjectURL(musicAudio.src);
  musicAudio.src = url;
  musicAudio.play().catch(() => {});
  if (song && srcId) fetchLyric(song, srcId);
  // 换歌必须强制推：行号会从上一首的末尾跳回 -1，若靠去重判断，
  // 新歌首屏会残留上一首的最后一行。此处 currentLyric 已被清空 → 推占位态（歌名—歌手），
  // 待 fetchLyric 异步返回后再推真实首行。
  lastPushedIdx = -2;
  pushLyric(true);
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
  // 队列面板开着时同步高亮当前项（自动切歌/切行后「定位当前」仍指向正确歌曲）
  if (queueModalEl) {
    const list = queueModalEl.querySelector(".queue-list");
    if (list) {
      list.querySelectorAll(".queue-item.cur").forEach((r) => r.classList.remove("cur"));
      list.querySelector(`.queue-item[data-i="${i}"]`)?.classList.add("cur");
    }
  }
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

// 收藏 key：插件歌曲按「源+歌曲标识」稳定去重（明细收藏时还没有播放地址）；
// 本地/无 song 数据回退 url。songIdentity 用插件歌曲的唯一字段，缺失时退化为标题+歌手。
function songIdentity(song) {
  if (!song) return "";
  return String(song.hash ?? song.id ?? song.songId ?? song.copyrightId ?? `${song.title || song.name || ""}|${song.artist || ""}`);
}
function favKeyOf(f) {
  return f.srcId && f.song ? `p:${f.srcId}:${songIdentity(f.song)}` : (f.url || "");
}
const songArtwork = (song) => song?.artwork || song?.al?.picUrl || song?.pic || "";

// 收藏/取消收藏一首「尚未播放」的歌曲（歌单/榜单明细行 ♡）
function toggleFavSong(song, srcId, meta) {
  if (!song) return;
  const favs = state.favorites || [];
  const k = favKeyOf({ url: meta.url || "", song, srcId });
  const i = favs.findIndex((f) => favKeyOf(f) === k);
  if (i >= 0) favs.splice(i, 1);
  else favs.push({ title: meta.title || "", artist: meta.artist || "", artwork: meta.artwork || songArtwork(song), url: meta.url || "", song, srcId });
  state.favorites = favs;
  saveState();
  syncPlayerButtons?.();
  if (favEl) renderFavoritesInto(favEl);
}

// 喜欢当前歌曲（♡ 收藏/取消收藏，列表在在线弹窗「喜欢」tab）
function toggleFavorite() {
  const c = currentSong;
  if (!c || !c.url) return;
  const favs = state.favorites || [];
  const k = favKeyOf({ url: c.url, song: c.song, srcId: c.srcId });
  let i = favs.findIndex((f) => favKeyOf(f) === k);
  if (i < 0) i = favs.findIndex((f) => f.url && f.url === c.url); // 兼容旧数据（仅 url）
  if (i >= 0) favs.splice(i, 1);
  else favs.push({ title: c.title, artist: c.artist, artwork: c.artwork, url: c.url, song: c.song || null, srcId: c.srcId || null });
  state.favorites = favs;
  saveState();
  syncPlayerButtons?.();
  if (favEl) renderFavoritesInto(favEl);
}

// 在线弹窗「喜欢」tab 的结果区（openOnlineMusic 设置）
let favEl = null;

// 渲染收藏歌曲列表到指定容器（点击 → 整列表入队播放；右侧 ✕ 取消收藏）
function renderFavoritesInto(el) {
  const favs = state.favorites || [];
  el.innerHTML = favs.length
    ? favs.map((f, i) => `
      <div class="online-result">
        <span class="mr-play">${ICON_PLAY}</span>
        <span class="mr-title">${esc(f.title || "")}</span>
        <span class="mr-artist">${esc(f.artist || "")}</span>
        <button class="mr-del" data-i="${i}" title="取消收藏">${ICON_CLOSE}</button>
      </div>`).join("")
    : `<div class="dash-empty">暂无喜欢的音乐，播放时点红心收藏</div>`;
  el.querySelectorAll(".online-result").forEach((row, idx) => {
    row.addEventListener("click", () => playFavorites(idx));
  });
  // 删除（取消收藏）：不触发整列表播放
  el.querySelectorAll(".mr-del").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const i = Number(btn.dataset.i);
      const favs = state.favorites || [];
      if (i >= 0 && i < favs.length) favs.splice(i, 1);
      state.favorites = favs;
      saveState();
      renderFavoritesInto(el);
      // 若当前播放的正是被取消收藏的歌，同步底部按键的收藏态
      const likeBtn = document.getElementById("mc-like");
      if (likeBtn && currentSong && currentSong.url) {
        const stillFav = favs.some((x) => x.url === currentSong.url);
        likeBtn.classList.toggle("active", stillFav);
      }
    });
  });
}

// 播放收藏列表（从 idx 开始整列表入队）
function playFavorites(idx) {
  const favs = state.favorites || [];
  if (!favs.length) return;
  playQueue = favs.map((f) => ({
    meta: { title: f.title, artist: f.artist, artwork: f.artwork },
    song: f.song || null,
    srcId: f.srcId || null,
    url: f.url || "",
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
      <h3>播放队列 <span class="dash-count">${playQueue.length}</span>${randomMode ? ' <span class="q-random-on">${ICON_SHUFFLE} 随机</span>' : ""}</h3>
      <div class="queue-list">
        ${playQueue.length ? playQueue.map((it, i) => `
          <div class="queue-item${i === queueIndex ? " cur" : ""}" data-i="${i}">
            <span class="qi-idx">${i + 1}</span>
            <span class="qi-title">${esc(it.meta.title || "")}</span>
            <span class="qi-artist">${esc(it.meta.artist || "")}</span>
          </div>`).join("") : `<div class="dash-empty">队列为空</div>`}
      </div>
      <div class="tm-actions"><button class="tm-cancel q-locate" title="滚动到正在播放的歌曲">${ICON_LOCATE}<span>定位当前</span></button><button class="btn-primary cm-ok">关闭</button></div>
    </div>`;
  document.body.appendChild(ov);

  // 定位到当前播放歌曲：滚动列表使其居中可见，并闪烁高亮一次
  const locateCur = (smooth) => {
    const list = ov.querySelector(".queue-list");
    const cur = list && list.querySelector(".queue-item.cur");
    if (!list || !cur) return;
    const lr = list.getBoundingClientRect();
    const cr = cur.getBoundingClientRect();
    if (smooth) {
      list.style.scrollBehavior = "smooth";
      setTimeout(() => { list.style.scrollBehavior = ""; }, 700);
    }
    list.scrollTop += cr.top + cr.height / 2 - (lr.top + lr.height / 2);
    cur.classList.remove("qi-flash");
    void cur.offsetWidth; // 强制重排以重启动画
    cur.classList.add("qi-flash");
  };

  const close = () => { ov.remove(); queueModalEl = null; };
  ov.querySelector(".cm-ok").addEventListener("click", close);
  ov.querySelector(".q-locate").addEventListener("click", () => locateCur(true));
  ov.addEventListener("click", (e) => { if (e.target === ov) close(); });
  ov.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
  ov.querySelectorAll(".queue-item").forEach((row) => {
    row.addEventListener("click", () => {
      loadQueueItem(Number(row.dataset.i));
      close();
    });
  });
  // 打开队列时自动定位到当前播放的歌曲（瞬间滚动，不平滑）
  requestAnimationFrame(() => locateCur(false));
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
// 实例缓存：同一脚本只执行一次，避免每次搜索/取流/歌词都重新解析执行（脚本往往数百 KB 且混淆）。
// 执行抛错不缓存（下次调用可重试，addSource 的正则兜底不受影响）。
const pluginCache = new Map();
function loadMusicPlugin(code) {
  if (pluginCache.has(code)) return pluginCache.get(code);
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
  const plugin = out.default && typeof out.default === "object" ? out.default : out;
  pluginCache.set(code, plugin);
  return plugin;
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
          <button class="src-del" data-i="${i}" title="移除">${ICON_CLOSE}</button>
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
          <button class="mc-btn" id="mc-lyric" title="桌面歌词（在桌面最上层显示歌词条）">${ICON_LYRICS}</button>
          <div class="mc-vol" title="音量">
            <button class="mc-btn" id="mc-vol-icon" title="静音/恢复（点击切换）">${state.playback.muted ? ICON_VOLUME_MUTE : ICON_VOLUME}</button>
            <input type="range" id="mc-vol-range" min="0" max="100" value="${Math.round((state.playback.muted ? 0 : (state.playback.volume ?? 0.8)) * 100)}" />
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
      fillEl.style.transform = `scaleX(${musicAudio.currentTime / musicAudio.duration})`;
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
    if (musicAudio.duration) fillEl.style.transform = `scaleX(${musicAudio.currentTime / musicAudio.duration})`;
    // 歌词同步高亮：只动「上一行移除 + 当前行添加」两个节点（O(1)，避免每次换行全列表重设 class）
    if (currentLyric.length && lyricEl) {
      let idx = -1;
      for (let i = 0; i < currentLyric.length; i++) {
        if (musicAudio.currentTime >= currentLyric[i].time) idx = i;
        else break;
      }
      if (idx !== -1 && idx !== lastLyricIdx) {
        const prev = lyricEl.children[lastLyricIdx];
        if (prev) prev.classList.remove("cur");
        const cur = lyricEl.children[idx];
        if (cur) {
          cur.classList.add("cur");
          // 只滚动歌词容器自身：scrollIntoView 会连带滚动所有外层滚动容器；
          // 用视觉矩形差值改 scrollTop（容器 scroll-behavior:smooth 提供平滑动画）
          const cr = lyricEl.getBoundingClientRect();
          const tr = cur.getBoundingClientRect();
          lyricEl.scrollTop += tr.top + tr.height / 2 - (cr.top + cr.height / 2);
        }
        lastLyricIdx = idx;
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
    // 拖动进度条是行号的**大跨度跳变**：必须强制推，且要重置去重值 ——
    // 若跳到同一行（如前后微调），去重会把这次跳变吞掉，歌词窗口的染色锚点
    // 仍停在旧时刻，进度条位置与染色会明显对不上。
    lastPushedIdx = -2;
    pushLyric(true);
  });

  // ── 音量区：图标 = 静音/恢复开关，滑杆 = 精确音量 ──
  // muted=true 时实际音量恒为 0，恢复时回到静音前的音量（preMuteVolume）。
  // 拖滑杆会自动解除静音 —— 拖了滑杆却没声音会让用户困惑。
  const volRange = body.querySelector("#mc-vol-range");
  const volIcon = body.querySelector("#mc-vol-icon");
  const applyVolumeUI = () => {
    const muted = !!state.playback.muted;
    const vol = muted ? 0 : (state.playback.volume ?? 0.8);
    musicAudio.volume = vol;
    if (volRange && Math.abs(+volRange.value - Math.round(vol * 100)) > 0) volRange.value = Math.round(vol * 100);
    if (volIcon) volIcon.innerHTML = muted ? ICON_VOLUME_MUTE : ICON_VOLUME;
  };
  volIcon?.addEventListener("click", () => {
    if (state.playback.muted) {
      // 恢复：回到静音前的音量
      state.playback.muted = false;
      state.playback.volume = state.playback.preMuteVolume || 0.8;
    } else {
      // 静音：记住当前音量（音量本身>0 才有恢复意义）
      state.playback.preMuteVolume = state.playback.volume || musicAudio.volume || 0.8;
      state.playback.muted = true;
      state.playback.volume = 0;
    }
    saveState();
    applyVolumeUI();
  });
  volRange?.addEventListener("input", (e) => {
    const v = e.target.value / 100;
    // 拖滑杆自动解除静音
    if (state.playback.muted && v > 0) state.playback.muted = false;
    else if (state.playback.muted && v === 0) return; // 静音态下滑到 0 不改状态
    state.playback.volume = v;
    if (v > 0) state.playback.preMuteVolume = v;
    musicAudio.volume = v;
    if (volIcon) volIcon.innerHTML = state.playback.muted ? ICON_VOLUME_MUTE : ICON_VOLUME;
  });
  // 每次渲染用持久化状态同步播放器与滑杆（不再硬编码覆盖用户设置）
  applyVolumeUI();

  // 底部功能按钮：喜欢/随机/上一首/下一首/队列/在线
  const likeBtn = body.querySelector("#mc-like");
  const shuffleBtn = body.querySelector("#mc-shuffle");
  const prevBtn = body.querySelector("#mc-prev");
  const nextBtn = body.querySelector("#mc-next");
  const listBtn = body.querySelector("#mc-list");

  syncPlayerButtons = () => {
    const fav = !!(currentSong && currentSong.url && (state.favorites || []).some((f) => favKeyOf(f) === favKeyOf({ url: currentSong.url, song: currentSong.song, srcId: currentSong.srcId })));
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

  // 桌面歌词：切换显示/隐藏
  lyricBtnEl = body.querySelector("#mc-lyric");
  lyricBtnEl.addEventListener("click", () => {
    lyricVisible = !lyricVisible;
    syncLyricBtn();
    if (lyricVisible) {
      lyricWinOn = true;
      // 先置 lyricWinOn 再显示窗口：窗口显示后 lyric_ready 会取走暂存内容，
      // 若此时闸门还关着，首屏就会是占位文案而非当前行。
      lastPushedIdx = -2;
      // 不传 locked：初始锁定态由 Rust 统一推导（读 state + 悬停解锁开关），
      // 两个入口（音乐页按钮 / 设置页开关）各传各的会导致行为不一致。
      invoke("show_lyric")
        .then(() => pushLyric(true))
        .catch((e) => {
          // 建窗失败要把闸门关回去，否则后续 timeupdate 会对着不存在的窗口空推
          lyricWinOn = false;
          lyricVisible = false;
          syncLyricBtn();
          console.warn("[music] 显示桌面歌词失败：", e);
        });
    } else {
      lyricWinOn = false;
      invoke("hide_lyric").catch((e) => console.warn("[music] 隐藏桌面歌词失败：", e));
    }
  });
  syncLyricBtn();

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
        <button class="om-close" title="关闭">${ICON_CLOSE}</button>
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

  // 上下文栏（标题 + 可选返回：back 为空时不渲染返回按钮，用于模式根列表）
  function renderContext(title, back) {
    const bar = document.createElement("div");
    bar.className = "online-ctx";
    bar.innerHTML = back
      ? `<button class="oc-back" title="返回">${ICON_BACK}</button><span class="oc-title">${esc(title)}</span>`
      : `<span class="oc-title">${esc(title)}</span>`;
    if (back) bar.querySelector(".oc-back").addEventListener("click", back);
    return bar;
  }

  // 渲染歌曲列表（点击 → 整列表入队播放；ctx.fav=true 时支持单首 ♡ 收藏与「全部收藏」）
  function renderSongList(songs, ctx) {
    resultsEl.innerHTML = "";
    const srcId = current ? current.id : "";
    const favs = state.favorites || [];
    const keyOfSong = (s) => `p:${srcId}:${songIdentity(s)}`;
    const isFav = (s) => favs.some((f) => favKeyOf(f) === keyOfSong(s));
    if (ctx) {
      const bar = renderContext(ctx.title, ctx.back);
      if (ctx.fav && songs.length) {
        const allIn = songs.every(isFav);
        const favAll = document.createElement("button");
        favAll.className = "oc-favall" + (allIn ? " active" : "");
        favAll.innerHTML = `${ICON_HEART}<span>${allIn ? "已全部收藏" : "全部收藏"}</span>`;
        favAll.addEventListener("click", () => {
          const list = state.favorites || [];
          if (allIn) {
            // 全部取消：移除本列表内的收藏
            const keys = new Set(songs.map(keyOfSong));
            state.favorites = list.filter((f) => !keys.has(favKeyOf(f)));
          } else {
            for (const s of songs) {
              if (list.some((f) => favKeyOf(f) === keyOfSong(s))) continue;
              list.push({ title: s.title || s.name || "", artist: s.artist || "", artwork: songArtwork(s), url: "", song: s, srcId });
            }
            state.favorites = list;
          }
          saveState();
          syncPlayerButtons?.();
          if (favEl) renderFavoritesInto(favEl);
          renderSongList(songs, ctx); // 重渲染刷新 ♡ 状态
        });
        bar.appendChild(favAll);
      }
      resultsEl.appendChild(bar);
    }
    if (!songs.length) { resultsEl.innerHTML += `<div class="dash-empty">空列表</div>`; return; }
    const frag = document.createElement("div");
    frag.innerHTML = songs.slice(0, 100).map((song, i) => `
      <div class="online-result">
        <span class="mr-play">${ICON_PLAY}</span>
        <span class="mr-title">${esc(song.title || song.name)}</span>
        <span class="mr-artist">${esc(song.artist || "未知歌手")}</span>
        ${ctx?.fav ? `<button class="mr-fav${isFav(song) ? " active" : ""}" data-i="${i}" title="${isFav(song) ? "取消喜欢" : "加到喜欢"}">${ICON_HEART}</button>` : ""}
      </div>`).join("");
    frag.querySelectorAll(".online-result").forEach((row, idx) => row.addEventListener("click", () => playList(songs, idx, current)));
    if (ctx?.fav) {
      frag.querySelectorAll(".mr-fav").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          const song = songs[Number(btn.dataset.i)];
          toggleFavSong(song, srcId, { title: song.title || song.name || "", artist: song.artist || "" });
          btn.classList.toggle("active");
          btn.title = btn.classList.contains("active") ? "取消喜欢" : "加到喜欢";
        });
      });
    }
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
      renderSongList(normalizeMusicList(res), { title: "排行榜：" + (topList.title || ""), back: renderTopLists, fav: true });
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
        fav: true,
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
      renderSongList(normalizeMusicList(res), { title: "专辑：" + (album.title || ""), back: () => { if (panelInput) panelInput.value = keyword; doSearch(); }, fav: true });
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
      // 排行榜根列表是模式顶层：只显示标题，不放返回按钮（明细页才有返回）
      resultsEl.appendChild(renderContext(current.name + " · 排行榜", null));
      let html = "";
      for (const grp of groups) {
        if (grp.title) html += `<div class="online-group-title">${esc(grp.title)}</div>`;
        for (let gi = 0; gi < grp.list.length; gi++) {
          const it = grp.list[gi];
          const rank = gi + 1;
          const topCls = rank <= 3 ? ` top${rank}` : "";
          const name = it.title || it.name || "";
          const desc = it.description || "";
          // 悬停 title 显示完整榜名与描述（列表内被单行省略截断）
          const tip = desc ? `${name}：${desc}` : name;
          html += `<div class="online-item toplist-item${topCls}" title="${esc(tip)}"><span class="tl-rank">${rank}</span><span class="tl-main"><span class="mr-title">${esc(name)}</span>${desc ? `<span class="mr-artist">${esc(desc)}</span>` : ""}</span></div>`;
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
        back: null, // 根列表无上一级，不放返回按钮
        renderRow: (it) => `<div class="online-item sheet-item"><span class="sheet-ico">${ICON_MUSIC}</span><span class="sheet-info"><span class="sheet-title">${esc(it.title || it.name)}</span><span class="sheet-desc">${esc(it.artist || it.description || "")}</span></span></div>`,
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
          back: null, // 搜索结果是根视图，返回无意义
          renderRow: (it) => `<div class="online-item sheet-item"><span class="sheet-ico">${ICON_MUSIC}</span><span class="sheet-info"><span class="sheet-title">${esc(it.title || it.name)}</span><span class="sheet-desc">${esc(it.artist || it.description || "")}</span></span></div>`,
          onClick: (sheet) => loadSheetDetail(sheet, kw),
        });
      } else if (type === "album") {
        renderCollection(normalizeList(res), {
          title: `专辑「${kw}」`,
          back: null,
          renderRow: (it) => `<div class="online-item"><span class="mr-play mr-album">${ICON_ALBUM}</span><span class="mr-title">${esc(it.title || it.name)}</span><span class="mr-artist">${esc(it.artist || it.description || "")}</span></div>`,
          onClick: (album) => loadAlbumDetail(album, kw),
        });
      } else {
        // 歌曲搜索结果：根视图（无返回），同样支持收藏
        renderSongList(normalizeSongs(res), { title: `歌曲「${kw}」`, back: null, fav: true });
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
      // 排行榜模式无搜索需求：隐藏整个输入面板（含原「当前音源的排行榜」提示）
      panelEl.innerHTML = "";
      panelEl.style.display = "none";
      panelInput = null;
      typeSelectEl = null;
      return;
    }
    panelEl.style.display = "";
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
      `<button class="online-src online-src-fav${favMode ? " active" : ""}" id="online-src-fav" title="喜欢的音乐">${ICON_HEART}<span>喜欢</span></button>` +
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
