// 开发者任务模型 — 状态 Coding/Testing/Review/Done + 项目/Deadline。
// 作为共享状态被「任务面板」与「快速指令条」共同消费(对齐 v2.0 开发者任务系统)。
import { Bus } from "./bus.js";
import { Store } from "./store.js";

let state = Store.load();
let tasks = state.tasks || [];

function persist() {
  state.tasks = tasks;
  Store.save(state);
  Bus.emit("tasks-changed", tasks);
}

export const Tasks = {
  list() { return tasks; },

  add({ text, project = "", status = "coding", due = "" }) {
    if (!text || !text.trim()) return;
    tasks.unshift({
      id: "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      text: text.trim(), project, status, due,
      done: status === "done",
      created: Date.now(),
    });
    persist();
  },

  toggle(id) {
    const t = tasks.find((x) => x.id === id);
    if (!t) return;
    t.done = !t.done;
    if (t.done && t.status !== "done") t.status = "done";
    if (!t.done && t.status === "done") t.status = "coding";
    persist();
  },

  setStatus(id, status) {
    const t = tasks.find((x) => x.id === id);
    if (!t) return;
    t.status = status;
    t.done = status === "done";
    persist();
  },

  remove(id) {
    tasks = tasks.filter((x) => x.id !== id);
    persist();
  },

  stats() {
    const total = tasks.length;
    const done = tasks.filter((t) => t.done).length;
    return { total, done, remain: total - done };
  },
};
