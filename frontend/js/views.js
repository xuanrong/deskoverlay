// 视图渲染器注册 — 从 views/ 子目录聚合各模块视图。
// 每加一个模块：在 views/ 新建文件并在此注册即可。
import { renderDashboard } from "./views/dashboard.js";
import { renderSystem } from "./views/system.js";
import { renderMusic } from "./views/music.js";
import { renderNotes } from "./views/notes.js";

export const VIEW_RENDERERS = {
  dashboard: renderDashboard,
  system: renderSystem,
  music: renderMusic,
  notes: renderNotes,
};
