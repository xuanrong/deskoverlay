// 视图渲染器注册 — 从 views/ 子目录聚合各模块视图。
// 每加一个模块：在 views/ 新建文件并在此注册即可。
//
// 注：system（系统健康）已移除 —— 浮层不要了，CPU/内存/磁盘改由底部任务栏常驻显示。
// views/system.js 一并删除，避免留一个没人注册的死渲染器（它内部的 provider 监听
// 若被误挂回去，会白跑一份每秒采样的逻辑）。
import { renderDashboard } from "./views/dashboard.js";
import { renderMusic } from "./views/music.js";
import { renderNotes } from "./views/notes.js";
import { renderEmsStats } from "./views/ems-stats.js";
import { renderIdeabox } from "./views/ideabox.js";
import { renderSettings } from "./views/settings.js";
import { renderQuickAccess } from "./views/quickaccess.js";
import { renderFund } from "./views/fund.js";
import { renderScheduler } from "./views/scheduler.js";

export const VIEW_RENDERERS = {
  dashboard: renderDashboard,
  quickaccess: renderQuickAccess,
  "ems-stats": renderEmsStats,
  ideabox: renderIdeabox,
  fund: renderFund,
  scheduler: renderScheduler,
  music: renderMusic,
  notes: renderNotes,
  settings: renderSettings,
};
