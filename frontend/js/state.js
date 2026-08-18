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
  musicSources: [], // 音乐音源插件：{ id, name, src, code }
  favorites: [], // 收藏的歌曲：{ title, artist, artwork, url }
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
  if (!Array.isArray(state.musicSources)) state.musicSources = [];
  if (!Array.isArray(state.favorites)) state.favorites = [];
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
