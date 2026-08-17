// 本地持久化层 — 面板几何 / 任务 / 速记 / 模式 持久化到 localStorage。
// 对应文档 §7「布局数据化」与 §11「状态保存」。刷新后自动恢复。
const KEY = "deskoverlay.state.v1";

const defaults = {
  panels: null,      // 由 config 默认填充
  tasks: [],
  notes: "",
  mode: "coding",
  closedPanels: [],  // 已关闭面板 id(用户可重新添加)
};

export const Store = {
  load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return structuredClone(defaults);
      const parsed = JSON.parse(raw);
      return { ...structuredClone(defaults), ...parsed };
    } catch (e) {
      console.warn("[store] 读取失败，使用默认状态", e);
      return structuredClone(defaults);
    }
  },
  save(state) {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch (e) {
      console.warn("[store] 写入失败", e);
    }
  },
  reset() {
    localStorage.removeItem(KEY);
  },
};
