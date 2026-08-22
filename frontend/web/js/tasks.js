// 开发者任务模型 — 状态 Coding/Testing/Review/Done + 项目/Deadline。
// 操作共享 state.js 单例的 tasks 字段，持久化由 saveState 统一处理。
import { Bus } from "./bus.js";
import { state, saveState, pushRecentOp } from "./state.js";

function persist() {
  saveState();
  Bus.emit("tasks-changed", state.tasks);
}

/// 待办完成时追加一条工作记录（类型：工作；日期：今天），随本次持久化一起落盘。
function addWorkLog(text, tags = []) {
  if (!text || !text.trim()) return;
  const d = new Date();
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  state.workLogs = state.workLogs || [];
  state.workLogs.push({
    id: "wl" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    date,
    type: "工作",
    text: `完成待办：${text.trim()}`,
    tags: Array.isArray(tags) ? tags.slice(0, 5) : [],
  });
}

export const Tasks = {
  list() { return state.tasks; },

  add({ text, project = "", status = "pending", due = "", startDate = "", priority = "P2", tags = [] }) {
    if (!text || !text.trim()) return;
    state.tasks.unshift({
      id: "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      text: text.trim(), project, status, due, startDate, priority, tags,
      done: status === "done",
      created: Date.now(),
    });
    pushRecentOp({ kind: "task_create", text: text.trim() });
    persist();
  },

  /// 编辑保存：合并 patch 到指定待办。
  update(id, patch) {
    const t = state.tasks.find((x) => x.id === id);
    if (!t) return;
    const wasDone = t.done;
    Object.assign(t, patch);
    if ("status" in patch) t.done = patch.status === "done";
    if (!wasDone && t.done) addWorkLog(t.text, t.tags);
    pushRecentOp({ kind: "task_update", text: t.text });
    persist();
  },

  toggle(id) {
    const t = state.tasks.find((x) => x.id === id);
    if (!t) return;
    t.done = !t.done;
    if (t.done && t.status !== "done") t.status = "done";
    if (!t.done && t.status === "done") t.status = "coding";
    if (t.done) addWorkLog(t.text, t.tags);
    persist();
  },

  setStatus(id, status) {
    const t = state.tasks.find((x) => x.id === id);
    if (!t) return;
    const wasDone = t.done;
    t.status = status;
    t.done = status === "done";
    if (!wasDone && t.done) addWorkLog(t.text, t.tags);
    persist();
  },

  remove(id) {
    const t = state.tasks.find((x) => x.id === id);
    state.tasks = state.tasks.filter((x) => x.id !== id);
    if (t) pushRecentOp({ kind: "task_delete", text: t.text });
    persist();
  },

  reorder(fromId, toId) {
    if (fromId === toId) return;
    const fromIdx = state.tasks.findIndex((x) => x.id === fromId);
    const toIdx = state.tasks.findIndex((x) => x.id === toId);
    if (fromIdx < 0 || toIdx < 0) return;
    const [item] = state.tasks.splice(fromIdx, 1);
    state.tasks.splice(toIdx, 0, item);
    persist();
  },

  stats() {
    const total = state.tasks.length;
    const done = state.tasks.filter((t) => t.done).length;
    return { total, done, remain: total - done };
  },
};
