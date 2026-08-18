// 开发者任务模型 — 状态 Coding/Testing/Review/Done + 项目/Deadline。
// 操作共享 state.js 单例的 tasks 字段，持久化由 saveState 统一处理。
import { Bus } from "./bus.js";
import { state, saveState, pushRecentOp } from "./state.js";

function persist() {
  saveState();
  Bus.emit("tasks-changed", state.tasks);
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
    Object.assign(t, patch);
    if ("status" in patch) t.done = patch.status === "done";
    pushRecentOp({ kind: "task_update", text: t.text });
    persist();
  },

  toggle(id) {
    const t = state.tasks.find((x) => x.id === id);
    if (!t) return;
    t.done = !t.done;
    if (t.done && t.status !== "done") t.status = "done";
    if (!t.done && t.status === "done") t.status = "coding";
    persist();
  },

  setStatus(id, status) {
    const t = state.tasks.find((x) => x.id === id);
    if (!t) return;
    t.status = status;
    t.done = status === "done";
    persist();
  },

  remove(id) {
    const t = state.tasks.find((x) => x.id === id);
    state.tasks = state.tasks.filter((x) => x.id !== id);
    if (t) pushRecentOp({ kind: "task_delete", text: t.text });
    persist();
  },

  stats() {
    const total = state.tasks.length;
    const done = state.tasks.filter((t) => t.done).length;
    return { total, done, remain: total - done };
  },
};
