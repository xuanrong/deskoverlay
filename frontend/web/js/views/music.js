// 音乐 / 在线音乐视图 + 全局播放器 + 音源管理。
// 全局播放器（音乐页 / 在线音乐页共享）：音频由 musicAudio 单例承载，UI 由各视图自行渲染。
import { Bus, invoke } from "../bus.js";
import { state, saveState } from "../state.js";
import { ICON_MUSIC, ICON_SHUFFLE, ICON_REPEAT, ICON_HEART, ICON_PREV, ICON_NEXT, ICON_PLAY, ICON_PAUSE, ICON_LIST, ICON_MORE, ICON_VOLUME, ICON_VOLUME_MUTE, ICON_LOCATE, ICON_CLOSE, ICON_BACK, ICON_ALBUM, ICON_LYRICS, ICON_DOWNLOAD, ICON_TRASH } from "../icons.js";
import { esc, normalizeSongs } from "./common.js";
import { toast } from "../toast.js";
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
  musicAudio.pause();          // 换源前先停：避免上一首的加载/播放状态串到新 src
  musicAudio.removeAttribute("src");
  musicAudio.load();           // 显式重置媒体元素状态机（清 error/网络状态）
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
  // 云盘项：直链带时效不可缓存，每次播放现取（在 item.url 缓存检查之前拦截）
  if (item.type === "云盘" && item.song?.fileId) {
    try {
      const url = await invoke("ad_play_url", { fileId: item.song.fileId, ext: item.song.ext || null });
      item.url = url;
      loadMeta({ ...item.meta, url, type: item.type, song: item.song });
      bindAdExpiryRetry();
      fetchAdTrackMeta(item.song); // 异步补全内嵌歌词/封面
      return;
    } catch (e) {
      if (onlineResultsEl) onlineResultsEl.innerHTML = `<div class="dash-empty">云盘播放失败：${esc(String(e && e.message || e))}</div>`;
      return;
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
      let failMsg = "";
      try {
        // 多档音质回退 + 单档重试：部分歌曲只有 high/low 档资源，只试 standard 会被误判失效
        const url = await getOnlineUrl(src, item.song);
        item.url = url;
        loadMeta({ ...item.meta, url, type: item.type, song: item.song, srcId: item.srcId });
        return;
      } catch (e) {
        // 透出插件真实失败原因：区分「该歌曲无资源/VIP」和「音源接口挂了」
        failMsg = String(e && e.message || e);
      }
      if (onlineResultsEl) onlineResultsEl.innerHTML = `<div class="dash-empty">播放失败：${esc(failMsg)}</div>`;
      return;
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

// -------------------- 音乐下载（Rust 流式落盘，设计见 .raccoon/music-download-design.md） --------------------

// 统一取流：多档音质依次回退（部分歌曲只有某一档资源，只试 standard 会被误判「音源失效」），
// 单档异常重试一次（瞬时网络抖动）。取不到时抛最后一个真实错误，便于 UI 区分「歌曲无资源」和「音源挂了」。
// prefer 指定期望档位：从该档开始依次尝试，仍按 standard→high→low 的降级链兜底。
async function getOnlineUrl(src, song, prefer) {
  const plugin = loadMusicPlugin(src.code);
  const chain = ["standard", "high", "low"];
  const qualities = prefer && chain.includes(prefer)
    ? [prefer, ...chain.filter((q) => q !== prefer)]
    : chain;
  let lastErr = null;
  for (const q of qualities) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const ms = await plugin.getMediaSource(song, q);
        const url = (ms && (ms.url || ms.src)) || (typeof ms === "string" ? ms : "");
        if (url) return url;
        break; // 该档返回空（无此资源），换下一档，不重试
      } catch (e) {
        lastErr = e;
        if (attempt === 0) await new Promise((r) => setTimeout(r, 300));
      }
    }
  }
  // 全部失败后：尝试已安装的洛雪源换源取流（洛雪协议支持跨平台用歌曲 ID 取流）
  const lxSrc = (state.musicSources || []).find((s) => s.code && isLxSource(s.code));
  if (lxSrc && !src.__lx) {
    try {
      const lp = loadMusicPlugin(lxSrc.code);
      const ms = await lp.getMediaSource(song, prefer || "standard");
      const lxUrl = (ms && (ms.url || ms.src)) || (typeof ms === "string" ? ms : "");
      if (lxUrl) return lxUrl;
    } catch (_) { /* 洛雪换源失败，落到原始错误 */ }
  }
  throw lastErr || new Error("各音质档均未取到播放地址");
}

// 文件名安全化（Windows 非法字符；Rust 侧 sanitize 二次校验）
function safeFilename(s) {
  return String(s || "").replace(/[\\/:*?"<>|]/g, "").replace(/[\x00-\x1f]/g, "").trim().slice(0, 120);
}
// 下载任务表：id → { title, artist, received, total, status }（status: running/done/failed）
const dlTasks = new Map();
// 事件监听只挂一次（模块级）
let dlEventsBound = false;
function bindDownloadEvents(onChange) {
  if (dlEventsBound) return;
  dlEventsBound = true;
  const { listen } = window.__TAURI__?.event || {};
  if (!listen) return;
  listen("download-progress", (e) => {
    const p = e.payload || {};
    const t = dlTasks.get(p.id);
    if (t) { t.received = p.received; t.total = p.total; onChange?.(); }
  }).catch(() => {});
  listen("download-done", (e) => {
    const p = e.payload || {};
    const t = dlTasks.get(p.id);
    if (t) { t.status = "done"; t.filename = p.filename; onChange?.(); }
    // 自动上传：开启时下载完成即入云盘上传队列
    if (state.ad_auto_upload && p.filename) {
      invoke("ad_upload_start", { filename: p.filename }).catch(() => {});
    }
  }).catch(() => {});
  listen("download-failed", (e) => {
    const p = e.payload || {};
    const t = dlTasks.get(p.id);
    if (t) { t.status = "failed"; t.error = p.error || "下载失败"; onChange?.(); }
  }).catch(() => {});
}

// 下载一首歌：song 为插件歌曲对象（含 id/typeEname 等），src 为音源记录。
// quality：期望音质档（standard/high/low），选定档缺失时自动降级。
// 流程：getMediaSource 取直链 → 查重 → download_start。返回 Promise<string>（提示文案）。
async function downloadSong(song, src, quality = "standard") {
  if (!song || !src) throw new Error("缺少歌曲或音源信息");
  const plugin = loadMusicPlugin(src.code);
  const url = await getOnlineUrl(src, song, quality);
  // 查重：进行中 + 已完成（本次会话内，同曲同音质才视为重复）
  const dlKey = `${src.id}:${songIdentity(song)}:${quality}`;
  for (const t of dlTasks.values()) {
    if (t.status !== "failed" && t.key === dlKey) {
      return t.status === "done" ? "该歌曲已下载" : "该歌曲正在下载中";
    }
  }
  const title = song.title || song.name || "未知";
  const artist = song.artist || "未知歌手";
  const qTag = quality === "high" ? " [HQ]" : quality === "low" ? " [LQ]" : "";
  const filename = safeFilename(`${artist} - ${title}${qTag}`);
  // 歌词同步落盘：取词失败不阻塞下载（离线只是没词，不影响听）
  let lyric = null;
  if (typeof plugin.getLyric === "function") {
    try {
      const l = await plugin.getLyric(song);
      lyric = typeof l === "string" ? l : (l && (l.rawLrc || l.lyric || l.lrc)) || null;
      if (lyric && typeof lyric !== "string") lyric = null;
    } catch (_) { lyric = null; }
  }
  const id = await invoke("download_start", { url, filename, lyric, artworkUrl: songArtwork(song) || null });
  dlTasks.set(id, { key: dlKey, title, artist, received: 0, total: 0, status: "running", id });
  return "已加入下载";
}

// 下载音质选择菜单：在按钮旁弹出三档选项（含音质说明），点选后回调。
function showQualityMenu(anchor, onPick) {
  document.getElementById("dl-qmenu")?.remove();
  const menu = document.createElement("div");
  menu.id = "dl-qmenu";
  menu.innerHTML = [
    { q: "standard", label: "标准音质", desc: "128kbps · 体积小" },
    { q: "high", label: "高品音质", desc: "320kbps · 推荐" },
    { q: "low", label: "流畅音质", desc: "体积最小" },
  ].map((o) => `<div class="dl-q-item" data-q="${o.q}"><span class="dl-q-label">${o.label}</span><span class="dl-q-desc">${o.desc}</span></div>`).join("");
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.left = Math.min(r.left, window.innerWidth - menu.offsetWidth - 8) + "px";
  menu.style.top = Math.min(r.bottom + 4, window.innerHeight - menu.offsetHeight - 8) + "px";
  const close = () => menu.remove();
  menu.querySelectorAll(".dl-q-item").forEach((item) => {
    item.addEventListener("click", () => { close(); onPick(item.dataset.q); });
  });
  setTimeout(() => {
    document.addEventListener("click", close, { once: true });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); }, { once: true });
  }, 0);
}

// 下载管理面板（Tab 页：进行中 / 已下载，弹窗固定尺寸）
function showDownloads() {
  if (document.getElementById("dl-modal")) return;
  const ov = document.createElement("div");
  ov.className = "task-modal-overlay";
  ov.innerHTML = `
    <div class="task-modal source-modal dl-modal">
      <div class="sm-head">
        <h3>下载管理</h3>
        <span class="sm-count" id="dl-count"></span>
      </div>
      <div class="dl-tabs">
        <button class="dl-tab active" data-tab="running">进行中<span class="dl-tab-badge" id="dl-badge-running"></span></button>
        <button class="dl-tab" data-tab="done">已下载<span class="dl-tab-badge" id="dl-badge-done"></span></button>
        <button class="dl-tab" data-tab="cloud">云盘上传<span class="dl-tab-badge" id="dl-badge-upload"></span></button>
      </div>
      <div class="dl-tab-pane active" id="dl-running"></div>
      <div class="dl-tab-pane" id="dl-done"></div>
      <div class="dl-tab-pane" id="dl-upload"></div>
      <div class="tm-actions"><button class="btn-primary cm-ok" id="dl-done-btn">完成</button></div>
    </div>`;
  document.body.appendChild(ov);
  const close = () => { ov.remove(); };
  ov.querySelector("#dl-done-btn").addEventListener("click", close);
  ov.addEventListener("click", (e) => { if (e.target === ov) close(); });
  ov.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });

  // Tab 切换
  const panes = {
    running: ov.querySelector("#dl-running"),
    done: ov.querySelector("#dl-done"),
  };
  ov.querySelectorAll(".dl-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      ov.querySelectorAll(".dl-tab").forEach((t) => t.classList.toggle("active", t === tab));
      Object.entries(panes).forEach(([k, el]) => el.classList.toggle("active", k === tab.dataset.tab));
    });
  });
  // 默认落在「已下载」tab；有任务进行中时切到「进行中」
  const focusRunning = () => {
    const has = [...dlTasks.values()].some((t) => t.status === "running");
    if (has) ov.querySelector('.dl-tab[data-tab="running"]')?.click();
    else ov.querySelector('.dl-tab[data-tab="done"]')?.click();
  };
  focusRunning();

  const runningEl = panes.running;
  const doneEl = panes.done;
  const uploadEl = panes.upload;
  const countEl = ov.querySelector("#dl-count");
  const badgeRunning = ov.querySelector("#dl-badge-running");
  const badgeDone = ov.querySelector("#dl-badge-done");
  const badgeUpload = ov.querySelector("#dl-badge-upload");
  const fmtSize = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB");

  const render = () => {
    // 进行中：done 状态保留 5 秒后移出（给用户看到「已完成」的反馈窗口）
    const tasks = [...dlTasks.values()].filter((t) => t.status !== "done" || Date.now() - (t.doneAt || 0) < 5000);
    const active = tasks.filter((t) => t.status === "running").length;
    countEl.textContent = active ? `${active} 个任务进行中` : "";
    badgeRunning.textContent = tasks.length || "";
    runningEl.innerHTML = tasks.length
      ? tasks.map((t) => {
          const pct = t.total ? Math.min(100, Math.round((t.received / t.total) * 100)) : 0;
          const foot = t.status === "running"
            ? `<div class="dl-row-foot"><div class="dl-bar"><div class="dl-bar-in" style="width:${pct}%"></div></div><span class="dl-pct">${t.total ? pct + "%" : fmtSize(t.received)}</span><button class="src-del" data-cancel="${t.id}" title="取消">${ICON_CLOSE}</button></div>`
            : t.status === "failed"
            ? `<div class="dl-row-foot"><span class="dl-err">${esc(t.error || "失败")}</span></div>`
            : `<div class="dl-row-foot"><span class="dl-ok">已完成</span></div>`;
          return `<div class="dl-item dl-card${t.status === "failed" ? " dl-failed" : ""}">
            <div class="dl-row-head">
              <span class="src-name">${esc(t.title)}</span>
              <span class="dl-artist">${esc(t.artist)}</span>
            </div>
            ${foot}
          </div>`;
        }).join("")
      : `<div class="src-empty">暂无下载任务<br /><span>在搜索结果或榜单里点下载图标即可</span></div>`;
    runningEl.querySelectorAll("[data-cancel]").forEach((btn) => {
      btn.addEventListener("click", () => invoke("download_cancel", { id: Number(btn.dataset.cancel) }).catch(() => {}));
    });
    // 已下载列表（实扫目录）
    invoke("downloaded_list").then((list) => {
      badgeDone.textContent = (list && list.length) || "";
      doneEl.innerHTML = (list && list.length)
        ? list.map((f) => `
            <div class="dl-item dl-play" data-play="${esc(f.filename)}">
              <span class="dl-play-ico">${ICON_PLAY}</span>
              <div class="src-info">
                <span class="src-name">${esc(f.filename.replace(/\.[^.]+$/, ""))}</span>
              </div>
              <button class="mr-dl" data-up="${esc(f.filename)}" title="上传到云盘 /音乐">⬆ 云盘</button>
              <button class="src-del" data-del="${esc(f.filename)}" title="删除">${ICON_TRASH}</button>
            </div>`).join("")
        : `<div class="src-empty">还没有下载的歌曲<br /><span>下载完成后会出现在这里，可离线播放</span></div>`;
      doneEl.querySelectorAll("[data-play]").forEach((row) => {
        row.addEventListener("click", (e) => {
          if (e.target.closest("[data-del]") || e.target.closest("[data-up]")) return;
          playDownloaded(row.dataset.play);
        });
      });
      doneEl.querySelectorAll("[data-up]").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          const fname = btn.dataset.up;
          btn.disabled = true;
          invoke("ad_upload_start", { filename: fname })
            .then(() => {
              toast("已加入云盘上传队列");
              ov.querySelector('.dl-tab[data-tab="cloud"]')?.click();
              render();
            })
            .catch((e) => toast("上传失败：" + String(e && e.message || e)))
            .finally(() => { btn.disabled = false; });
        });
      });
      doneEl.querySelectorAll("[data-del]").forEach((btn) => {
        btn.addEventListener("click", () => {
          invoke("downloaded_delete", { filename: btn.dataset.del }).then(render).catch((e) => toast(String(e)));
        });
      });
    }).catch(() => { doneEl.innerHTML = `<div class="src-empty">读取下载目录失败</div>`; });

    // 云盘上传 tab：auto 开关 + 任务列表（后端快照，500ms 轮询随 render 刷新）
    invoke("ad_upload_list").then((tasks) => {
      const active = (tasks || []).filter((t) => t.status === "hashing" || t.status === "uploading").length;
      badgeUpload.textContent = active || "";
      uploadEl.innerHTML = `
        <label class="ad-auto-row" title="本地下载完成后自动上传到云盘 /音乐">
          <input type="checkbox" id="ad-auto" ${state.ad_auto_upload ? "checked" : ""} />
          <span>下载完成后自动上传到云盘</span>
        </label>
        ${tasks && tasks.length ? tasks.map((t) => {
          const pct = t.total ? Math.min(100, Math.round(((t.sent || 0) / t.total) * 100)) : 0;
          const statusText = { hashing: "计算哈希…", uploading: "上传中", done: "已完成", failed: "失败", cancelled: "已取消" }[t.status] || t.status;
          const foot = t.status === "hashing" || t.status === "uploading"
            ? `<div class="dl-row-foot"><div class="dl-bar"><div class="dl-bar-in" style="width:${pct}%"></div></div><span class="dl-pct">${pct}%</span><button class="src-del" data-upcancel="${t.id}" title="取消">${ICON_CLOSE}</button></div>`
            : t.status === "failed"
            ? `<div class="dl-row-foot"><span class="dl-err">${esc(t.error || "上传失败")}</span></div>`
            : `<div class="dl-row-foot"><span class="dl-ok">已完成${t.note ? " · " + esc(t.note) : ""}</span></div>`;
          return `<div class="dl-item dl-card${t.status === "failed" ? " dl-failed" : ""}">
            <div class="dl-row-head"><span class="src-name">☁ ${esc(t.name.replace(/\.[^.]+$/, ""))}</span><span class="dl-artist">云盘</span></div>
            ${foot}
          </div>`;
        }).join("")
        : `<div class="src-empty">暂无上传任务<br /><span>在「已下载」里点 ⬆ 上传到云盘，或开启自动上传</span></div>`}`;
      uploadEl.querySelector("#ad-auto")?.addEventListener("change", (e) => {
        state.ad_auto_upload = !!e.target.checked;
        saveState();
        toast(state.ad_auto_upload ? "已开启：下载完成自动上传云盘" : "已关闭自动上传");
      });
      uploadEl.querySelectorAll("[data-upcancel]").forEach((btn) => {
        btn.addEventListener("click", () => invoke("ad_upload_cancel", { id: Number(btn.dataset.upcancel) }).catch(() => {}));
      });
    }).catch(() => { uploadEl.innerHTML = `<div class="src-empty">读取上传任务失败</div>`; });
  };
  bindDownloadEvents(render);
  render();
  // 面板打开期间定时刷新进度（事件回调也触发，双保险）
  const timer = setInterval(render, 500);
  const obs = new MutationObserver(() => { if (!document.contains(ov)) { clearInterval(timer); obs.disconnect(); } });
  obs.observe(document.body, { childList: true });
}

// 播放已下载的本地文件（convertFileSrc → asset 协议，不依赖音源；
// 封面/歌词从下载时落盘的同名附属文件读取：.lrc + .jpg/.png/.webp）
async function playDownloaded(filename) {
  try {
    const conv = window.__TAURI__?.core?.convertFileSrc;
    if (!conv) throw new Error("convertFileSrc 不可用");
    const { appDataDir } = window.__TAURI__?.path || {};
    const dir = appDataDir ? await appDataDir() : "";
    const url = conv(`${dir}\\music\\${filename}`);
    // 资产先行：封面 data URL + 歌词文本，取不到则降级为无封面/无词
    let assets = { lrc: null, cover: null };
    try { assets = (await invoke("local_track_assets", { filename })) || assets; } catch (_) {}
    loadMeta({ title: filename.replace(/\.[^.]+$/, ""), artist: "本地", artwork: assets.cover || null, url, type: "本地" });
    // 本地歌词：注入播放链路（页面歌词区 + 桌面歌词窗口）
    if (assets.lrc && currentSong) {
      currentSong.lyric = assets.lrc;
      currentLyric = parseLrc(assets.lrc);
      if (lyricEl) renderLyric();
      pushLyric(true);
    }
  } catch (e) {
    toast("本地播放失败：" + String(e && e.message || e));
  }
}

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
// 剥离 accept-encoding：插件手动透传压缩头会导致响应以 gzip 字节返回，
// 经文本通道读取报 "stream did not contain valid UTF-8"（Rust 侧同步剥离，双保险）
function stripAE(headers) {
  if (!headers || typeof headers !== "object") return headers;
  const h = { ...headers };
  for (const k of Object.keys(h)) {
    if (k.toLowerCase() === "accept-encoding") delete h[k];
  }
  return h;
}
function loadMusicPlugin(code) {
  if (pluginCache.has(code)) return pluginCache.get(code);
  // 洛雪音源走独立沙箱（协议完全不同）
  if (isLxSource(code)) return loadLxPlugin(code);
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
        responseType: o.responseType,
        body: d !== undefined
          ? (typeof d === "string" ? d : (typeof d.append === "function" ? d.toString() : JSON.stringify(d)))
          : (o.body || ""),
      };
    }
    let params, headers, body = "", responseType;
    if (method === "GET") {
      const cfg = b || {};
      params = cfg.params; headers = cfg.headers; responseType = cfg.responseType;
    } else {
      const cfg = c || {};
      params = cfg.params; headers = cfg.headers; responseType = cfg.responseType;
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
    return { url: a, method, params, headers, body, responseType };
  }
  // base64 → Uint8Array（http_get_bytes 返回体解码，供插件 responseType:"arraybuffer"）
  const b64ToUint8Array = (b64) => {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  };
  // axios 既可作为函数调用 axios({url,method,...})，也可 axios.get/post(...)（Parcel 打包插件大量用前者）
  const axiosExec = (method, a, b, c) => {
    const r = normAxios(method, a, b, c);
    const full = r.url + toQuery(r.params);
    // accept-encoding 剥离：压缩响应走文本通道会报 UTF-8 错（Rust 侧同步剥离，双保险）
    const h = { ...(r.headers || {}) };
    for (const k of Object.keys(h)) {
      if (k.toLowerCase() === "accept-encoding") delete h[k];
    }
    // 二进制响应：走 http_get_bytes（base64 传输）解码为 Uint8Array——
    // 咪咕等音源的 VIP 加密取流用 responseType:"arraybuffer"，文本通道会损坏密文
    if (r.responseType === "arraybuffer" || r.responseType === "uint8array") {
      return invoke("http_get_bytes", { url: full, headers: h }).then((b64) => ({
        data: b64ToUint8Array(b64),
        status: 200,
        statusText: "OK",
        headers: {},
        config: { url: full, method: r.method, headers: h },
        request: {},
      }));
    }
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
    // MusicFree 宿主协议全局：插件 userVariables（咪咕等插件的登录导入功能读取）
    env: { getUserVariables: () => (state.settings?.pluginVars || {}) },
    http: {
      get: (url, opts = {}) => invoke("http_get", { url, headers: stripAE(opts.headers) }),
      post: (url, body = "", opts = {}) => invoke("http_post", { url, body, headers: stripAE(opts.headers) }),
      request: (url, opts = {}) =>
        (opts.method === "POST" ? invoke("http_post", { url, body: opts.body || "", headers: stripAE(opts.headers) }) : invoke("http_get", { url, headers: stripAE(opts.headers) })),
    },
    console, URL, URLSearchParams, encodeURIComponent, decodeURIComponent, JSON, Math, Date, Object, Array,
    String, Number, Boolean, Promise, parseInt, parseFloat, setTimeout, clearTimeout, Infinity, NaN,
  };

  const fn = new Function("module", "exports", "globalThis", "require", `'use strict';\n${code}\n`);
  let execErr = null;
  try {
    fn(mod, mod.exports, sandbox, require);
  } catch (e) {
    execErr = e;
  }
  const out = mod.exports || {};
  const plugin = out.default && typeof out.default === "object" ? out.default : out;
  // 洛雪混淆脚本的特征被字符串表隐藏，isLxSource 可能漏判——
  // MusicFree 沙箱执行报错且代码含 globalThis 时，回落洛雪沙箱再试
  if (execErr && /globalThis/.test(code)) {
    try { return loadLxPlugin(code); } catch (_) { throw execErr; }
  }
  if (execErr) throw execErr;
  pluginCache.set(code, plugin);
  return plugin;
}

// ---- 洛雪（LX Music）自定义源兼容层 ----
// 洛雪协议：脚本通过 globalThis.lx 获取宿主 API，on(EVENT_NAMES.request) 注册
// musicUrl 处理器，send(EVENT_NAMES.inited, {sources}) 声明能力。与 MusicFree 协议
// 完全不同（无 search，只做「取播放地址」一件事），故单独沙箱执行并包装为
// MusicFree 形态：search 走内置酷狗聚合（洛雪源只管取流），getMediaSource 触发
// musicUrl 事件。音质映射：standard→128k / high→320k / super→flac。
const LX_EVENT_NAMES = { request: "request", inited: "inited" };
// 洛雪源声明支持的平台 → 中文名（供搜索聚合展示来源）
const LX_SOURCE_NAMES = { kw: "酷我", kg: "酷狗", tx: "QQ音乐", wy: "网易云", mg: "咪咕" };

function loadLxPlugin(code) {
  if (pluginCache.has(code)) return pluginCache.get(code);
  const handlers = {}; // action → handler（musicUrl 等）
  let inited = false;
  let initedPayload = null;

  // 从脚本头注释解析元数据（洛雪协议：@name/@version/@author/@description/@homepage）
  const meta = {};
  const header = code.slice(0, 2000).match(/\/\*!?\*?([\s\S]*?)\*\//);
  if (header) {
    for (const m of header[1].matchAll(/@(\w+)\s+(.+)/g)) {
      meta[m[1].trim()] = m[2].trim();
    }
  }

  const lx = {
    EVENT_NAMES: LX_EVENT_NAMES,
    env: "desktop",
    version: "2.0.0",
    // 洛雪宿主协议：脚本头注释元数据 + 原始脚本（野花等源用它做完整性校验/版本比对）
    currentScriptInfo: {
      name: meta.name || "洛雪音源",
      description: meta.description || "",
      version: meta.version || "1.0.0",
      author: meta.author || "",
      homepage: meta.homepage || "",
      rawScript: code,
    },
    // request：洛雪宿主的 HTTP API（回调风格）→ 转 Rust 代理
    request: (url, options = {}, callback) => {
      const method = (options.method || "GET").toUpperCase();
      const h = stripAE(options.headers || {});
      const p = method === "POST"
        ? invoke("http_post", { url, body: options.body || "", headers: h })
        : invoke("http_get", { url, headers: h });
      p.then((text) => {
        // 洛雪 request 语义：resp.body 为响应体（字符串或 JSON 对象——JSON 自动解析）
        let body = safeParse(text);
        callback && callback(null, { body, statusCode: 200, headers: {}, raw: text });
      }).catch((e) => callback && callback(e));
    },
    on: (event, handler) => {
      if (event === LX_EVENT_NAMES.request) handlers.request = handler;
    },
    send: (event, payload) => {
      if (event === LX_EVENT_NAMES.inited) { inited = true; initedPayload = payload; }
    },    utils: {
      buffer: { from: (s) => String(s), bufToString: (b) => String(b) },
      // md5 是洛雪源最常用的校验工具（野花源 init 时校验脚本 md5），给真实现
      crypto: {
        md5: (s) => {
          // 同步 MD5 不可得（Rust 代理是异步的）——常用场景是脚本完整性校验，
          // 这里用轻量 JS 实现兜底（与 5sing 适配版同一实现思路）
          return lxMd5(String(s));
        },
        aesEncrypt: () => { throw new Error("utils.crypto.aesEncrypt 未支持"); },
        rsaEncrypt: () => { throw new Error("utils.crypto.rsaEncrypt 未支持"); },
        randomBytes: (n) => Array.from({ length: n }, () => Math.floor(Math.random() * 256)),
      },
      randomBytes: (n) => Array.from({ length: n }, () => Math.floor(Math.random() * 256)),
      zlib: { deflate: () => { throw new Error("utils.zlib 未支持"); }, inflate: () => { throw new Error("utils.zlib 未支持"); },
        inflateRaw: () => { throw new Error("utils.zlib 未支持"); }, gzip: () => { throw new Error("utils.zlib 未支持"); }, ungzip: () => { throw new Error("utils.zlib 未支持"); } },
    },
  };

  const sandbox = {
    console, URL, URLSearchParams, encodeURIComponent, decodeURIComponent, JSON, Math, Date, Object, Array,
    String, Number, Boolean, Promise, parseInt, parseFloat, setTimeout, clearTimeout, setInterval, clearInterval, Infinity, NaN,
    atob, btoa, TextEncoder, TextDecoder, Headers, fetch, AbortController,
  };
  // 洛雪源 init 阶段的内部 Promise 链（如野花源拉配置失败重试）可能产生未捕获 rejection，
  // 真实洛雪宿主有全局兜底——这里同样兜底，防止整个应用崩溃
  const rejectionGuard = (e) => { console.warn("[lx] 未处理的 rejection:", String(e && e.message || e).slice(0, 80)); };
  window.addEventListener("unhandledrejection", rejectionGuard);
  const fn = new Function("globalThis", `'use strict';\n${code}\n`);
  fn({ ...sandbox, lx });

  if (!handlers.request) {
    throw new Error("洛雪音源初始化失败（未注册 request 处理器）");
  }
  // 异步 init：部分源（如野花）init 时发网络请求拉配置，之后才 send(inited)。
  // ready promise 承诺「init 完成（或 3s 超时）」，getMediaSource 内部等待之。
  let resolveReady;
  const ready = new Promise((r) => { resolveReady = r; });
  if (inited) resolveReady();
  const origSend = lx.send;
  lx.send = (event, payload) => {
    origSend(event, payload);
    if (event === LX_EVENT_NAMES.inited && initedPayload) resolveReady();
  };
  setTimeout(() => resolveReady(), 3000); // 超时兜底：musicUrl 调用本身会再触发请求

  const qualityMap = { standard: "128k", high: "320k", super: "flac" };
  const plugin = {
    platform: "洛雪音源" + (meta.name ? " · " + meta.name : ""),
    version: meta.version || "lx-compat",
    // 洛雪源只做取流，不提供搜索——搜索复用其它音源（UI 已有提示）
    supportedSearchType: [],
    async getMediaSource(song, quality) {
      const handler = handlers.request;
      if (!handler) throw new Error("洛雪音源未就绪");
      await ready; // 等异步 init 完成（最多 3s）
      const q = qualityMap[quality] || "128k";
      // 换源取流：洛雪各平台处理器读取各自所需的 ID 字段（songmid/hash/copyrightId）。
      // 歌曲可能来自其它音源（字段名不一致），统一补齐别名，让每个平台都有机会命中。
      const musicInfo = {
        ...song,
        songmid: song.songmid ?? song.id,
        hash: song.hash ?? song.id,
        copyrightId: song.copyrightId ?? song.id,
      };
      // 平台尝试顺序：歌曲带 lxSource 标记则优先，否则按声明的平台逐个尝试
      const declared = Object.keys((initedPayload && initedPayload.sources) || {});
      const platforms = declared.length ? declared : ["kw", "kg", "tx", "wy", "mg"];
      const preferred = song.lxSource;
      const order = preferred && platforms.includes(preferred)
        ? [preferred, ...platforms.filter((p) => p !== preferred)]
        : platforms;
      let lastErr = null;
      for (const source of order) {
        try {
          const url = await Promise.resolve(
            handler({ action: "musicUrl", source, info: { type: q, musicInfo } })
          );
          if (url) return { url };
        } catch (e) {
          lastErr = e;
        }
      }
      throw new Error(lastErr && lastErr.message ? String(lastErr.message) : "洛雪音源各平台均未取到播放地址");
    },
    // 供 UI 展示声明的平台与音质（异步 init，读取时取最新）
    get lxSources() { return (initedPayload && initedPayload.sources) || {}; },
    __lx: true,
  };
  pluginCache.set(code, plugin);
  return plugin;
}

// 轻量同步 MD5（hex），供洛雪源脚本完整性校验（与 5sing 适配版同一实现）
function lxMd5(str) {
  const S = [7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22,
             5,9,14,20,5,9,14,20,5,9,14,20,5,9,14,20,
             4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23,
             6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21];
  const K = new Array(64);
  for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296);
  let H0 = 0x67452301, H1 = 0xEFCDAB89, H2 = 0x98BADCFE, H3 = 0x10325476;
  const ml = str.length, bitLen = ml * 8;
  const len = Math.ceil((ml + 1 + 8) / 64) * 64;
  const bytes = new Array(len).fill(0);
  for (let i = 0; i < ml; i++) bytes[i] = str.charCodeAt(i) & 0xff;
  bytes[ml] = 0x80;
  bytes[len - 8] = bitLen & 0xff;
  bytes[len - 7] = (bitLen >>> 8) & 0xff;
  bytes[len - 6] = (bitLen >>> 16) & 0xff;
  bytes[len - 5] = (bitLen >>> 24) & 0xff;
  for (let off = 0; off < len; off += 64) {
    const M = new Array(16);
    for (let i = 0; i < 16; i++)
      M[i] = bytes[off + i*4] | (bytes[off + i*4 + 1] << 8) | (bytes[off + i*4 + 2] << 16) | (bytes[off + i*4 + 3] << 24);
    let A = H0, B = H1, C = H2, D = H3;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) { F = (B & C) | ((~B) & D); g = i; }
      else if (i < 32) { F = (D & B) | ((~D) & C); g = (5*i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3*i + 5) % 16; }
      else { F = C ^ (B | (~D)); g = (7*i) % 16; }
      F = (F + A + K[i] + M[g]) | 0;
      A = D; D = C; C = B;
      B = (B + ((F << S[i]) | (F >>> (32 - S[i])))) | 0;
    }
    H0 = (H0 + A) | 0; H1 = (H1 + B) | 0; H2 = (H2 + C) | 0; H3 = (H3 + D) | 0;
  }
  const hex = (n) => { let s = ""; for (let i = 0; i < 4; i++) s += ((n >>> (i*8)) & 0xff).toString(16).padStart(2, "0"); return s; };
  return hex(H0) + hex(H1) + hex(H2) + hex(H3);
}

// 判断脚本是否为洛雪音源。注意混淆器会把特征字符串编码：
// - 'lx' 存为 \x6c\x78（globalThis['\x6c\x78']）
// - EVENT_NAMES/musicUrl 等收进字符串表
// 故需要多特征组合，且执行失败时还有回落（见 loadMusicPlugin）
function isLxSource(code) {
  if (!/globalThis/.test(code)) return false;
  if (/EVENT_NAMES/.test(code)) return true; // 明文协议特征
  if (/globalThis\s*\[\s*['"]lx['"]\s*\]/.test(code)) return true; // globalThis['lx']
  if (/\\x6c\\x78/.test(code)) return true; // 混淆的 'lx'（\x6c\x78）
  if (/lx-music/.test(code)) return true; // UA 特征串
  // 字符串表组合特征：musicUrl + inited 是洛雪协议独有
  if (/musicUrl/.test(code) && /inited/.test(code)) return true;
  return false;
}

// ---- 音源管理弹窗：添加（URL/本地 js）/ 移除 ----
function showMusicSources(onDone) {
  if (document.getElementById("src-modal")) return;
  const ov = document.createElement("div");
  ov.id = "src-modal";
  ov.className = "task-modal-overlay";
  ov.innerHTML = `
    <div class="task-modal source-modal">
      <div class="sm-head">
        <h3>音源管理</h3>
        <span class="sm-count" id="src-count"></span>
      </div>
      <div class="sm-body">
        <div class="sm-left">
          <div class="sm-sec-title">已安装 <span class="sm-tip">拖拽排序，靠前为默认</span></div>
          <div class="src-list" id="src-list"></div>
        </div>
        <div class="sm-right">
          <div class="sm-sec-title">添加音源</div>
          <div class="sm-add-field">
            <label>在线音源地址</label>
            <input id="src-url" type="text" placeholder="https://…/xxx.js" autocomplete="off" spellcheck="false" />
            <button class="btn-primary sm-add-btn" id="src-add-url">拉取并安装</button>
          </div>
          <div class="sm-add-divider"><span>或</span></div>
          <button class="sm-add-file" id="src-add-file">
            <span class="sm-add-file-ico">＋</span>
            <span>选择本地 .js 文件</span>
          </button>
          <input type="file" id="src-file" accept=".js" hidden />
        </div>
      </div>
      <div class="tm-actions"><button class="btn-primary cm-ok" id="src-done">完成</button></div>
    </div>`;
  document.body.appendChild(ov);
  const list = ov.querySelector("#src-list");
  const countEl = ov.querySelector("#src-count");
  const close = () => { ov.remove(); if (onDone) try { onDone(); } catch (e) {} };

  function renderList() {
    const n = (state.musicSources || []).length;
    countEl.textContent = n ? `${n} 个音源` : "";
    list.innerHTML = n
      ? state.musicSources.map((s, i) => `
        <div class="src-row" data-i="${i}">
          <span class="src-drag" title="拖拽排序">⋮⋮</span>
          <span class="src-order">${i + 1}</span>
          <div class="src-info">
            <span class="src-name">${esc(s.name || "未命名")}</span>
            <span class="src-src">${esc(s.src || "本地文件")}</span>
          </div>
          <button class="src-del" data-i="${i}" title="移除">${ICON_CLOSE}</button>
        </div>`).join("")
      : `<div class="src-empty">还没有安装音源<br /><span>从右侧添加在线地址或本地 .js 文件</span></div>`;
    // 排序：指针事件自实现拖拽（mousedown 起拖 + ghost 跟随 + mouseup 落位）。
    // 不用 HTML5 drag events——WebView2（尤其嵌入 WorkerW 的子窗口）里 drop 事件链不可靠，
    // 幽灵图能出现但 drop 不触发，表现为「能拖但换不了顺序」。
    const rowEls = [...list.querySelectorAll(".src-row")];
    rowEls.forEach((row, idx) => {
      row.addEventListener("mousedown", (e) => {
        if (e.button !== 0 || e.target.closest(".src-del")) return; // 删除按钮不触发拖拽
        e.preventDefault(); // 防止拖动时选中文本
        startSrcDrag(e, idx, rowEls);
      });
    });
    list.querySelectorAll(".src-del").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.musicSources.splice(Number(btn.dataset.i), 1);
        saveState();
        renderList();
      });
    });
  }

  // 音源拖拽排序主体：ghost 克隆行跟随鼠标，落点行高亮，mouseup 提交顺序。
  function startSrcDrag(e, fromIdx, rowEls) {
    const rects = rowEls.map((r) => r.getBoundingClientRect());
    const ghost = rowEls[fromIdx].cloneNode(true);
    ghost.classList.add("drag-ghost");
    ghost.style.cssText += `position:fixed;left:${rects[fromIdx].left}px;top:${rects[fromIdx].top}px;width:${rects[fromIdx].width}px;margin:0;z-index:17000;pointer-events:none;box-shadow:0 10px 28px rgba(0,0,0,.45);`;
    document.body.appendChild(ghost);
    rowEls[fromIdx].classList.add("dragging");
    const ox = e.clientX - rects[fromIdx].left;
    const oy = e.clientY - rects[fromIdx].top;
    let hoverIdx = fromIdx;
    const idxFromY = (y) => {
      for (let i = 0; i < rects.length; i++) {
        if (y >= rects[i].top && y <= rects[i].bottom) return i;
      }
      return fromIdx;
    };
    const onMove = (ev) => {
      ghost.style.left = ev.clientX - ox + "px";
      ghost.style.top = ev.clientY - oy + "px";
      hoverIdx = idxFromY(ev.clientY);
      rowEls.forEach((r, i) => r.classList.toggle("drag-over", i === hoverIdx && i !== fromIdx));
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      ghost.remove();
      rowEls.forEach((r) => r.classList.remove("dragging", "drag-over"));
      if (hoverIdx !== fromIdx) {
        const [item] = state.musicSources.splice(fromIdx, 1);
        state.musicSources.splice(hoverIdx, 0, item);
        saveState(); // 数组顺序即左侧音源栏与默认音源的顺序，持久化到 music.json
      }
      renderList();
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
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
    if (!url) { toast("请先输入音源地址"); return; }
    const btn = ov.querySelector("#src-add-url");
    btn.disabled = true;
    try {
      const code = await invoke("http_get", { url });
      if (!code || !code.trim()) { toast("拉取内容为空"); return; }
      addSource(url, code);
      ov.querySelector("#src-url").value = "";
      toast("音源已安装");
    } catch (e) {
      toast("拉取失败：" + e);
    } finally {
      btn.disabled = false;
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
          <button class="mc-btn" id="mc-dl" title="下载管理">${ICON_DOWNLOAD}</button>
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
  body.querySelector("#mc-dl").addEventListener("click", showDownloads);
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

// -------------------- 阿里云盘（P1 播放链路） --------------------
// 设计见 .raccoon/aliyundrive-music-design.md。
// 社区授权（AList/OpenList 扫码页拿 refresh_token）→ 粘贴绑定 → 官方 OpenAPI 直调。
// 音频文件类型过滤（云盘列表/搜索共用）
const AD_AUDIO_EXT = new Set(["mp3", "flac", "m4a", "wav", "ape", "ogg", "wma", "aac"]);
const AD_AUTH_URL = "https://alistgo.com/zh/guide/drivers/aliyundrive.html"; // 社区授权页入口（文档页含跳转）

// 云盘文件 → 播放队列歌曲结构（title 去扩展名，artist 固定「云盘」）
function adSongOf(f) {
  return {
    title: (f.name || "").replace(/\.[^.]+$/, ""),
    artist: "云盘",
    artwork: "",
    // 队列项直接带 file_id + 扩展名，播放时 ad_play_url 现取直链（直链带时效，不能缓存）
    fileId: f.file_id,
    ext: f.ext || "",
  };
}

// 云盘根目录：默认 /音乐（不存在时回退 root）
let adMusicFolderId = null;
async function adResolveMusicFolder() {
  if (adMusicFolderId) return adMusicFolderId;
  try {
    const list = await invoke("ad_list", { folderId: "root" });
    const music = list.find((f) => f.kind === "folder" && f.name === "音乐");
    adMusicFolderId = music ? music.file_id : "root";
  } catch (_) { adMusicFolderId = "root"; }
  return adMusicFolderId;
}

// 云盘整列表入队播放：与 playList 对等（上一首/下一首/随机可覆盖云盘歌曲）。
// 队列项不缓存 url —— type "云盘" 的取流走 loadQueueItem 的专用分支，每次现取直链。
function playCloudList(list, index) {
  if (!list || !list.length) return;
  playQueue = list.map((s) => ({
    meta: { title: s.title, artist: "云盘", artwork: null },
    song: { fileId: s.fileId },
    srcId: null,
    url: null,
    type: "云盘",
  }));
  queueIndex = Math.max(0, Math.min(index, playQueue.length - 1));
  loadQueueItem(queueIndex);
}

// 云盘直链过期兜底：播放中触发媒体错误时，重签直链续播一次（仅云盘来源）。
function bindAdExpiryRetry() {
  if (currentSong?.type !== "云盘" || !currentSong.song?.fileId) return;
  const fileId = currentSong.song.fileId;
  const onErr = () => {
    if (currentSong?.song?.fileId !== fileId) return;
    invoke("ad_play_url", { fileId })
      .then((fresh) => {
        musicAudio.src = fresh;
        musicAudio.play().catch(() => {});
      })
      .catch(() => {});
  };
  musicAudio.addEventListener("error", onErr, { once: true });
}

// 云盘歌曲元数据补全：从音频内嵌标签（ID3/Vorbis）提取歌词与封面。
// 拉取失败/无内嵌时静默降级（无词无封面），不影响播放。
// 延迟 3 秒执行：上游 OSS 单连接限速（~500KB/s），播放启动阶段音频流优先，
// 元数据的头尾拉取错峰，避免抢带宽造成开头卡顿。
async function fetchAdTrackMeta(song) {
  if (!song?.fileId) return;
  await new Promise((r) => setTimeout(r, 3000));
  if (!currentSong || currentSong.song?.fileId !== song.fileId) return; // 延迟期间已切歌
  try {
    const meta = await invoke("ad_track_meta", { fileId: song.fileId, ext: song.ext || "" });
    console.log("[ad-meta] result:", JSON.stringify({ hasLyric: !!meta?.lyric, hasCover: !!meta?.cover, debug: meta?.debug || null }));
    if (!currentSong || currentSong.song?.fileId !== song.fileId) return; // 已切歌
    if (meta?.lyric && currentSong && !currentSong.lyric) {
      currentSong.lyric = meta.lyric;
      currentLyric = parseLrc(meta.lyric);
      if (lyricEl) renderLyric();
      lastPushedIdx = -2;
      pushLyric(true);
    }
    if (meta?.cover && currentSong && !currentSong.artwork) {
      currentSong.artwork = meta.cover;
      syncMusicUI?.();
    }
  } catch (e) {
    console.warn("[ad-meta] 获取失败:", String(e && e.message || e));
  }
}

// 播放云盘歌曲：ad_play_url 取流式地址 → loadMeta（复用现有播放链路），并入播放队列
async function playAdFile(song) {
  try {
    const url = await invoke("ad_play_url", { fileId: song.fileId, ext: song.ext || null });
    loadMeta({ title: song.title, artist: song.artist || "云盘", artwork: null, url, type: "云盘" });
    bindAdExpiryRetry();
    fetchAdTrackMeta(song); // 异步补全内嵌歌词/封面，不阻塞播放
  } catch (e) {
    toast("云盘播放失败：" + String(e && e.message || e));
  }
}

// 云盘 tab 主体：绑定状态 → 未绑定显示授权引导；已绑定显示目录浏览 + 搜索
async function renderAdDriveTab(resultsEl, panelEl, modeTabsEl) {
  let status = { bound: false };
  try { status = (await invoke("ad_auth_status")) || status; } catch (_) {}

  if (!status.bound) {
    modeTabsEl.style.display = "none";
    panelEl.style.display = "none";
    resultsEl.innerHTML = `
      <div class="ad-auth-guide">
        <div class="dash-empty">尚未绑定阿里云盘</div>
        <div class="ad-auth-steps">
          <p>1. 点下方按钮打开社区授权页，用<b>阿里云盘 App 扫码</b>登录</p>
          <p>2. 授权成功后页面会显示一串 <b>refresh_token</b>，复制它</p>
          <p>3. 粘贴到下面并点「绑定」</p>
        </div>
        <button class="btn-primary" id="ad-open-auth">打开授权页</button>
        <div class="ad-auth-input">
          <input id="ad-token" type="password" placeholder="粘贴 refresh_token…" autocomplete="off" spellcheck="false" />
          <button class="btn-primary" id="ad-bind">绑定</button>
        </div>
        <div class="ad-auth-note">token 仅保存在本机应用数据目录，不会上传。约 30 天需重新扫码一次。</div>
      </div>`;
    resultsEl.querySelector("#ad-open-auth").addEventListener("click", () => {
      invoke("open_path", { target: AD_AUTH_URL }).catch((e) => toast("打开授权页失败：" + e));
    });
    resultsEl.querySelector("#ad-bind").addEventListener("click", async () => {
      const btn = resultsEl.querySelector("#ad-bind");
      const token = resultsEl.querySelector("#ad-token").value.trim();
      if (!token) { toast("请先粘贴 refresh_token"); return; }
      btn.disabled = true;
      btn.textContent = "验证中…";
      try {
        const info = await invoke("ad_auth_bind", { refreshToken: token });
        toast("已绑定：" + (info.nickname || "阿里云盘"));
        renderAdDriveTab(resultsEl, panelEl, modeTabsEl); // 重新渲染为已绑定态
      } catch (e) {
        toast("绑定失败：" + String(e && e.message || e));
        btn.disabled = false;
        btn.textContent = "绑定";
      }
    });
    return;
  }

  // 已绑定：目录浏览 + 搜索
  modeTabsEl.style.display = "none"; // 云盘 tab 无排行榜/歌单模式
  panelEl.style.display = "";
  panelEl.innerHTML = `
    <input id="ad-input" type="text" placeholder="搜索云盘歌曲…" autocomplete="off" spellcheck="false" />
    <button class="mc-btn mc-pill" id="ad-refresh" title="刷新目录">↻</button>
    <button class="mc-btn mc-pill" id="ad-unbind" title="解绑阿里云盘">解绑</button>`;
  const input = panelEl.querySelector("#ad-input");
  panelEl.querySelector("#ad-refresh").addEventListener("click", async () => { adMusicFolderId = null; loadAdFolder(resultsEl, await adResolveMusicFolder()); });
  panelEl.querySelector("#ad-unbind").addEventListener("click", async () => {
    try { await invoke("ad_unbind"); toast("已解绑"); renderAdDriveTab(resultsEl, panelEl, modeTabsEl); }
    catch (e) { toast(String(e)); }
  });
  const doAdSearch = async () => {
    const kw = input.value.trim();
    if (!kw) return;
    resultsEl.innerHTML = `<div class="dash-empty">搜索中…</div>`;
    try {
      const list = (await invoke("ad_search", { keyword: kw })).filter((f) => AD_AUDIO_EXT.has(f.ext));
      renderAdFiles(resultsEl, list, { title: `云盘「${kw}」`, back: async () => loadAdFolder(resultsEl, await adResolveMusicFolder()) });
      if (!list.length) resultsEl.innerHTML += `<div class="dash-empty">没有匹配的音频文件</div>`;
    } catch (e) {
      resultsEl.innerHTML = `<div class="dash-empty">搜索失败：${esc(String(e && e.message || e))}</div>`;
    }
  };
  panelEl.querySelector("#ad-input").addEventListener("keydown", (e) => { if (e.key === "Enter") doAdSearch(); });
  input.focus();
  loadAdFolder(resultsEl, await adResolveMusicFolder());
}

// 拉取并渲染云盘目录（root 或 folder_id）
async function loadAdFolder(resultsEl, folderId) {
  resultsEl.innerHTML = `<div class="dash-empty">加载云盘目录…</div>`;
  try {
    const list = await invoke("ad_list", { folderId });
    const songs = list.filter((f) => f.kind === "file" && AD_AUDIO_EXT.has(f.ext)).map(adSongOf);
    renderAdFiles(resultsEl, songs, { title: "云盘 · /音乐", back: null });
    if (!songs.length) resultsEl.innerHTML += `<div class="dash-empty">该目录暂无音频文件<br /><span>把歌传到云盘后点 ↻ 刷新</span></div>`;
  } catch (e) {
    const msg = String(e && e.message || e);
    resultsEl.innerHTML = /失效|重新扫码/.test(msg)
      ? `<div class="dash-empty">授权已过期，请到「解绑」后重新扫码绑定</div>`
      : `<div class="dash-empty">加载失败：${esc(msg)}</div>`;
  }
}

// 渲染云盘歌曲列表（复用 online-result 行样式；点击即播，不整列表入队——直链时效短，逐首现取）
function renderAdFiles(resultsEl, songs, ctx) {
  resultsEl.innerHTML = "";
  if (ctx) {
    const bar = document.createElement("div");
    bar.className = "online-ctx";
    bar.innerHTML = ctx.back
      ? `<button class="oc-back" title="返回">${ICON_BACK}</button><span class="oc-title">${esc(ctx.title)}</span>`
      : `<span class="oc-title">${esc(ctx.title)}</span>`;
    if (ctx.back) bar.querySelector(".oc-back").addEventListener("click", ctx.back);
    resultsEl.appendChild(bar);
  }
  if (!songs.length) return;
  const frag = document.createElement("div");
  frag.innerHTML = songs.slice(0, 200).map((s) => `
    <div class="online-result">
      <span class="mr-play">${ICON_PLAY}</span>
      <span class="mr-title">${esc(s.title)}</span>
      <span class="mr-artist">${esc(s.artist)}</span>
    </div>`).join("");
  frag.querySelectorAll(".online-result").forEach((row, idx) => row.addEventListener("click", () => playCloudList(songs, idx)));
  resultsEl.appendChild(frag);
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
  let adMode = false; // 左侧「云盘」tab 激活时（仅用于高亮态）
  let panelInput = null;
  let typeSelectEl = null;

  // 显示/隐藏顶部模式与输入区（「喜欢」tab 不显示）
  function setChrome(show) {
    modeTabsEl.style.display = show ? "" : "none";
    panelEl.style.display = show ? "" : "none";
  }

  // 洛雪源只做取流（协议无搜索/歌单/排行榜）：这些功能代理到第一个非洛雪音源，
  // 搜索结果播放时仍走当前（洛雪）源取流——即「别的源找歌，洛雪源出流」。
  function searchPluginFor(src) {
    const p = loadMusicPlugin(src.code);
    if (!p.__lx) return p;
    const alt = (state.musicSources || []).find((s) => s.code && s.id !== src.id && !loadMusicPlugin(s.code).__lx);
    return alt ? loadMusicPlugin(alt.code) : p;
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
        ${current ? `<button class="mr-dl" data-dl="${i}" title="下载">${ICON_DOWNLOAD}</button>` : ""}
      </div>`).join("");
    frag.querySelectorAll(".online-result").forEach((row, idx) => row.addEventListener("click", () => playList(songs, idx, current)));
    // 行内下载按钮：弹出音质选择菜单（选定档缺失时自动降级）
    frag.querySelectorAll(".mr-dl").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const song = songs[Number(btn.dataset.dl)];
        if (!song || !current) return;
        showQualityMenu(btn, async (q) => {
          btn.disabled = true;
          try {
            toast(await downloadSong(song, current, q));
          } catch (err) {
            toast(typeof err === "string" ? err : (err && err.message) || "下载失败");
          } finally {
            btn.disabled = false;
          }
        });
      });
    });
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
      const plugin = searchPluginFor(current);
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
      const plugin = searchPluginFor(current);
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
      const plugin = searchPluginFor(current);
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
      const plugin = searchPluginFor(current);
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
      const plugin = searchPluginFor(current);
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
      const plugin = searchPluginFor(current);
      if (typeof plugin.search !== "function") throw new Error("没有可搜索的音源（洛雪源只负责取流，请先安装其它音源）");
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
        const plugin = searchPluginFor(current);
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

  // 左侧音源栏：顶部固定「喜欢」，下面音源列表 + 云盘 + 管理
  function renderSrcSide() {
    const sources = (state.musicSources || []).filter((s) => s.code);
    if (current && !sources.some((s) => s.id === current.id)) current = sources[0] || null;
    srcSideEl.innerHTML =
      `<button class="online-src online-src-fav${favMode ? " active" : ""}" id="online-src-fav" title="喜欢的音乐">${ICON_HEART}<span>喜欢</span></button>` +
      (sources.length
        ? sources.map((s, i) => `
          <button class="online-src${!favMode && current && s.id === current.id ? " active" : ""}" data-i="${i}" title="${esc(s.name || "")}">${esc(s.name || "未命名")}</button>`).join("")
        : `<span class="online-src-none">未安装音源</span>`)
      + `<button class="online-src${adMode ? " active" : ""}" id="online-src-ad" title="阿里云盘音乐">☁ 云盘</button>`
      + `<button class="online-src online-src-add" id="online-src-btn" title="音源管理">+ 音源</button>`;

    srcSideEl.querySelector("#online-src-fav").addEventListener("click", () => {
      favMode = true;
      adMode = false;
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
        adMode = false;
        favEl = null;
        setChrome(true);
        renderSrcSide();
        switchMode(mode);
      });
    });
    // 云盘 tab：独立渲染分支（不走音源插件链路）
    srcSideEl.querySelector("#online-src-ad").addEventListener("click", () => {
      favMode = false;
      adMode = true;
      favEl = null;
      current = null;
      renderSrcSide();
      renderAdDriveTab(resultsEl, panelEl, modeTabsEl);
    });
    srcSideEl.querySelector("#online-src-btn").addEventListener("click", () => showMusicSources(renderSrcSide));
  }

  modeTabsEl.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => switchMode(b.dataset.mode)));

  renderSrcSide();
  switchMode("toplist");
}
