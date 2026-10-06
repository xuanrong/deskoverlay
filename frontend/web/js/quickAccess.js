// 快捷访问模型 — 管理 分组(qaGroups) 与 快捷方式(quickAccess)。
// 操作共享 state.js 单例字段，持久化由 saveState 统一处理。
import { state, saveState } from "./state.js";
import { uid } from "./utils.js";

const DEFAULT_GROUP = "默认";

function persist() {
  saveState();
}

/// 确保至少存在一个可用分组；缺失时注入「默认」分组。
function ensureDefaultGroup() {
  if (!Array.isArray(state.qaGroups)) state.qaGroups = [];
  if (!state.qaGroups.length) {
    state.qaGroups.push({ id: uid("qag"), name: DEFAULT_GROUP });
    persist();
  }
  return state.qaGroups;
}

export const QuickAccess = {
  list() { return state.quickAccess; },
  listGroups() { return ensureDefaultGroup(); },

  add({ type = "url", title, target, groupId }) {
    const t = (target || "").trim();
    if (!t) return;
    ensureDefaultGroup();
    const gid = groupId && state.qaGroups.some((g) => g.id === groupId) ? groupId : state.qaGroups[0].id;
    const q = {
      id: uid("qa"),
      type: type === "folder" || type === "file" ? type : "url",
      title: (title || "").trim() || t,
      target: t,
      groupId: gid,
    };
    state.quickAccess.push(q);
    persist();
    return q;
  },

  update(id, patch) {
    const q = state.quickAccess.find((x) => x.id === id);
    if (!q) return;
    if ("target" in patch && typeof patch.target === "string") patch.target = patch.target.trim();
    Object.assign(q, patch);
    persist();
  },

  remove(id) {
    state.quickAccess = state.quickAccess.filter((x) => x.id !== id);
    persist();
  },

  addGroup(name) {
    const n = (name || "").trim();
    if (!n) return;
    state.qaGroups.push({ id: uid("qag"), name: n });
    persist();
  },

  renameGroup(groupId, name) {
    const n = (name || "").trim();
    const g = state.qaGroups.find((x) => x.id === groupId);
    if (!g || !n) return;
    g.name = n;
    persist();
  },

  /// 删除分组：其内快捷方式并入「默认」分组；组名非空时保留最后一个「默认」分组。
  removeGroup(groupId) {
    const g = state.qaGroups.find((x) => x.id === groupId);
    if (!g) return;
    const keep = state.qaGroups.filter((x) => x.id !== groupId);
    if (!keep.length) keep.push({ id: uid("qag"), name: DEFAULT_GROUP });
    state.qaGroups = keep;
    state.quickAccess.forEach((q) => { if (q.groupId === groupId) q.groupId = keep[0].id; });
    persist();
  },

  /// 跨组移动 + 组内排序：把 from 移到 groupId 组中 atItem 之前（atItem 为空则移到末尾）。
  move(fromId, groupId, atItemId) {
    const from = state.quickAccess.findIndex((x) => x.id === fromId);
    if (from < 0) return;
    const [item] = state.quickAccess.splice(from, 1);
    const gid = groupId && state.qaGroups.some((g) => g.id === groupId) ? groupId : item.groupId;
    item.groupId = gid;
    if (atItemId && atItemId !== fromId) {
      const at = state.quickAccess.findIndex((x) => x.id === atItemId);
      if (at >= 0) state.quickAccess.splice(at, 0, item);
      else state.quickAccess.push(item);
    } else {
      state.quickAccess.push(item);
    }
    persist();
  },

  /// 分组排序：把 fromId 组移到 atGroupId 组**之前**（atGroupId 为空 → 移到末尾）。
  /// 落点用**组 id**而不是下标：拖动时被拖的那一组仍留在 DOM 里（只降透明度），
  /// 若用下标，splice 之后的坐标就整体错位一格。用 id 则「先摘出、再找锚点」天然正确。
  /// `state.qaGroups` 的数组顺序**就是**显示顺序（loadState 只做 filter、不重排），故直接改数组即可。
  moveGroup(fromId, atGroupId) {
    const from = state.qaGroups.findIndex((g) => g.id === fromId);
    if (from < 0 || atGroupId === fromId) return;
    const [g] = state.qaGroups.splice(from, 1);
    if (atGroupId) {
      const at = state.qaGroups.findIndex((x) => x.id === atGroupId);
      if (at >= 0) state.qaGroups.splice(at, 0, g);
      else state.qaGroups.push(g);
    } else {
      state.qaGroups.push(g);
    }
    persist();
  },
};