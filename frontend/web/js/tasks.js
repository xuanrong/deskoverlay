// 开发者任务模型 — 状态 Coding/Testing/Review/Done + 项目/Deadline。
// 操作共享 state.js 单例的 tasks 字段，持久化由 saveState 统一处理。
import { Bus } from "./bus.js";
import { state, saveState } from "./state.js";
import { uid } from "./utils.js";

function persist() {
  saveState();
  Bus.emit("tasks-changed", state.tasks);
}

// 注：待办完成时曾会顺带写一条「工作记录」（state.workLogs）。
// 工作记录面板已整体移除，这里不再写 —— 否则会往一个没人读的字段里堆数据。
export const Tasks = {
  list() { return state.tasks; },

  add({ text, project = "", status = "pending", due = "", startDate = "", priority = "P2", tags = [] }) {
    if (!text || !text.trim()) return;
    state.tasks.unshift({
      id: uid("t"),
      text: text.trim(), project, status, due, startDate, priority, tags,
      done: status === "done",
      created: Date.now(),
    });
    persist();
  },

  /// 编辑保存：合并 patch 到指定待办。
  update(id, patch) {
    const t = state.tasks.find((x) => x.id === id);
    if (!t) return;
    const wasDone = t.done;
    Object.assign(t, patch);
    if ("status" in patch) t.done = patch.status === "done";
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
    const wasDone = t.done;
    t.status = status;
    t.done = status === "done";
    persist();
  },

  remove(id) {
    const t = state.tasks.find((x) => x.id === id);
    state.tasks = state.tasks.filter((x) => x.id !== id);
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
