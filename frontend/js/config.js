// 工作台配置 — 对齐文档 §7「配置与数据模型」。
// panels 由数据描述(可拖拽/缩放/折叠/显隐均由配置驱动)，便于后续按反馈快速调整。
// desktop 配置预留 hide_native_icons / monitor_strategy / self_heal 等字段(由 Rust 注入层消费)。

export const DESKTOP_CONFIG = {
  desktop: {
    hide_native_icons: true,
    monitor_strategy: "virtual",
    self_heal: true,
  },
  // 默认面板布局(首次启动 / 重置时使用)
  panels: [
    { id: "dashboard", type: "dashboard", title: "今日概览", pro: true,
      x: 40, y: 40, w: 300, h: 230, z: 10 },
    { id: "system", type: "system", title: "系统监控", provider: "system",
      x: 40, y: 300, w: 300, h: 268, z: 10 },
    { id: "tasks", type: "tasks", title: "开发者任务",
      x: 372, y: 40, w: 340, h: 528, z: 11 },
    { id: "weather", type: "weather", title: "天气", provider: "weather",
      x: 744, y: 40, w: 280, h: 200, z: 10 },
    { id: "calendar", type: "calendar", title: "日历", provider: "clock",
      x: 744, y: 268, w: 280, h: 300, z: 10 },
    { id: "projects", type: "projects", title: "项目监控",
      x: 1056, y: 40, w: 300, h: 220, z: 10 },
    { id: "notes", type: "notes", title: "速记",
      x: 1056, y: 288, w: 300, h: 280, z: 10 },
  ],
};

// 工作模式 — 上下文感知显隐(对齐文档 §5.2 / v2.0 工作模式)。
// visible: 该模式下显示的面板 id；其余面板自动隐藏。
export const MODES = {
  coding: {
    label: "Coding Mode",
    desc: "专注开发",
    dot: "var(--green)",
    visible: ["dashboard", "system", "tasks", "projects", "notes"],
  },
  meeting: {
    label: "Meeting Mode",
    desc: "会议与记录",
    dot: "var(--blue)",
    visible: ["dashboard", "calendar", "notes", "weather"],
  },
  focus: {
    label: "Focus Mode",
    desc: "仅留当前任务",
    dot: "var(--purple)",
    visible: ["dashboard", "tasks"],
  },
  afterwork: {
    label: "After Work Mode",
    desc: "今日总结",
    dot: "var(--gold-2)",
    visible: ["dashboard", "tasks", "calendar", "weather"],
  },
};

export const MODE_ORDER = ["coding", "meeting", "focus", "afterwork"];

// 任务状态枚举(对齐 v2.0 开发者任务系统)
export const TASK_STATUSES = ["coding", "testing", "review", "done"];
export const STATUS_LABEL = {
  coding: "Coding", testing: "Testing", review: "Review", done: "Done",
};
