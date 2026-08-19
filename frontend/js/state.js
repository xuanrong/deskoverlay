// 统一状态源 — 单例 state 对象，所有模块共享同一引用，避免多份快照互相覆盖。
// 启动时 loadState() 从 Rust 读取；修改后调 saveState() 持久化。
import { Store } from "./store.js";
import { DEFAULT_REMINDERS } from "./config.js";

export const state = {
  currentModule: "dashboard",
  tasks: [],
  notes: "",
  recentOps: [], // 最近操作记录：{ ts, type, action, name, ... }
  reminders: [], // 提醒配置：{ id, label, icon, type, time/intervalMin, enabled, ... }
  sedentary: { enabled: false, intervalMin: 45 }, // 久坐提醒：开关 + 连续使用间隔（分钟）
  water: { enabled: false, intervalMin: 90 }, // 喝水提醒：开关 + 间隔（分钟）
  workLogs: [], // 工作记录：{ id, date:"YYYY-MM-DD", time:"HH:MM", text, type, tags }
  musicSources: [], // 音乐音源插件：{ id, name, src, code }
  favorites: [], // 收藏的歌曲：{ title, artist, artwork, url }
  playback: { queue: [], index: -1, song: null, playing: false, currentTime: 0 }, // 音乐播放状态（重启恢复）
  navState: {}, // 各模块导航浏览状态：{ [moduleId]: { scrollTop, tab, ... } }（切换/重启后恢复）
};

let ready = false;
const readyQueue = [];

/// 异步初始化：从 Rust 读取状态并合并进单例。
export async function loadState() {
  const loaded = await Store.load();
  Object.assign(state, loaded);
  if (!Array.isArray(state.tasks)) state.tasks = [];
  if (typeof state.notes !== "string") state.notes = "";
  if (typeof state.currentModule !== "string") state.currentModule = "dashboard";
  if (!Array.isArray(state.recentOps)) state.recentOps = [];
  // 提醒：老数据无该字段时填充默认配置；为空数组则保留（用户可能删光）
  if (state.reminders === undefined) {
    state.reminders = DEFAULT_REMINDERS.map((r) => ({ ...r }));
  } else if (!Array.isArray(state.reminders)) {
    state.reminders = [];
  }
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
  if (!Array.isArray(state.musicSources)) state.musicSources = [];
  if (!Array.isArray(state.favorites)) state.favorites = [];
  // 工作记录：结构校验
  if (!Array.isArray(state.workLogs)) state.workLogs = [];
  state.workLogs = state.workLogs.filter((w) => w && typeof w === "object" && w.id && w.text);
  // 导航浏览状态：结构校验
  if (!state.navState || typeof state.navState !== "object" || Array.isArray(state.navState)) {
    state.navState = {};
  }
  // 播放状态：结构校验
  if (!state.playback || typeof state.playback !== "object") {
    state.playback = { queue: [], index: -1, song: null, playing: false, currentTime: 0 };
  }
  if (!Array.isArray(state.playback.queue)) state.playback.queue = [];
  if (typeof state.playback.index !== "number") state.playback.index = -1;
  if (typeof state.playback.volume !== "number") state.playback.volume = 0.8;
  state.playback.volume = Math.max(0, Math.min(1, state.playback.volume));
  ready = true;
  readyQueue.forEach((fn) => fn());
  readyQueue.length = 0;
}

/// 状态就绪后执行（用于需要等待初始化完成的场景）。
export function onReady(fn) {
  if (ready) fn();
  else readyQueue.push(fn);
}

/// 持久化当前 state（异步，调用方可不 await）。
export function saveState() {
  Store.save(state).catch((e) => console.warn("[state] 保存失败", e));
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
