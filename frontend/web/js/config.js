// 模块定义 — 侧边导航 + 固定模块布局（无拖拽、无工作模式）。
// 每个模块对应导航栏一项与主区域一个固定视图。
// icon 为线性 SVG（stroke currentColor），导航/指令条统一渲染。
import { ICON_HOME, ICON_ACTIVITY, ICON_MUSIC, ICON_NOTES, ICON_GAME, ICON_WATER, ICON_CALENDAR, ICON_BUILDING, ICON_CLOCK, ICON_LIST, ICON_IDEA, ICON_GEAR } from "./icons.js";

export const MODULES = [
  { id: "dashboard", title: "今日概览", icon: ICON_HOME },
  { id: "worklog", title: "工作记录", icon: ICON_LIST },
  { id: "ideabox", title: "灵感碎片", icon: ICON_IDEA },
  { id: "system", title: "系统健康", icon: ICON_ACTIVITY },
  { id: "music", title: "在线音乐", icon: ICON_MUSIC },
  { id: "relax", title: "休息一下", icon: ICON_GAME },
  { id: "notes", title: "我的速记", icon: ICON_NOTES },
  { id: "settings", title: "系统设置", icon: ICON_GEAR },
];

// 待办状态枚举
export const TASK_STATUSES = ["pending", "doing", "paused", "done"];
export const STATUS_LABEL = {
  pending: "待开始", doing: "进行中", paused: "已暂停", done: "已完成",
};

// 优先级中文标签
export const PRIORITY_LABEL = { P0: "紧急", P1: "高", P2: "中", P3: "低", P4: "较低" };

// 默认提醒，可在时钟块配置弹窗中增删/启停/配置
// type: "daily"（每日固定时刻触发） | "interval"（每 N 分钟滚动触发）
// daily 用 time("HH:MM") + lastTriggeredDate（当日防重复）；interval 用 intervalMin + lastAt
export const DEFAULT_REMINDERS = [
  { id: "plan", label: "每日计划", icon: ICON_CALENDAR, type: "daily", time: "09:30", enabled: false, lastTriggeredDate: "" },
  { id: "off", label: "下班打卡", icon: ICON_BUILDING, type: "daily", time: "18:00", enabled: false, lastTriggeredDate: "" },
];
