// 模块定义 — 一屏卡片工作台 + 全屏浮层（无侧边导航、无拖拽重排之外的模式）。
// 每个模块对应一张卡片与一个浮层视图。
// icon 为线性 SVG（stroke currentColor），卡片/指令条统一渲染。
//
// ⚠️ 注意：system（系统健康）**不在**这张表里 —— 它的浮层已整体移除，
// CPU / 内存 / 磁盘改为底部任务栏常驻读数（见 workspace.js 的 bindTaskbarSystem）。
// 因此不要把它加回来：一加回来，卡片补卡逻辑与指令条都会立刻多出这条入口。
import { ICON_HOME, ICON_MUSIC, ICON_NOTES, ICON_LIST, ICON_IDEA, ICON_GEAR, ICON_EXTERNAL, ICON_FUND, ICON_AI, ICON_CLOCK, ICON_KANBAN, ICON_MUYU } from "./icons.js";

export const MODULES = [
  { id: "dashboard", title: "今日概览", icon: ICON_HOME },
  { id: "quickaccess", title: "快捷访问", icon: ICON_EXTERNAL },
  // 原「工作记录」已整体移除（含 state.workLogs），这个位置改为禅道待办看板
  // icon 用 ICON_KANBAN（层叠任务卡 + 勾）：原来是 ICON_REQ（文档+折角），
  // 既和浮层里「未验证需求」那一格撞图，也读不出「项目管理」这层意思。
  { id: "ems-stats", title: "禅道", icon: ICON_KANBAN },
  { id: "ideabox", title: "灵感碎片", icon: ICON_IDEA },
  // 原「AI 资讯」模块已移除（资讯列表 / 模型与免费额度 / AI 弹窗全部删除）。
  // ⚠ 签到积分卡还活着，它复用 state.ai.checkin 但**不再有对应模块** ——
  //   卡片清单里直接写 module: "credits"（不在 MODULES 里），点它不打开浮层，
  //   只做实时刷新。别为了「统一」把它塞回 MODULES，那样会多出一个空浮层。
  { id: "muyu", title: "电子木鱼", icon: ICON_MUYU },
  { id: "scheduler", title: "定时任务", icon: ICON_CLOCK },
  { id: "fund", title: "基金管家", icon: ICON_FUND },
  { id: "music", title: "在线音乐", icon: ICON_MUSIC },
  { id: "notes", title: "笔记列表", icon: ICON_NOTES },
  { id: "settings", title: "系统设置", icon: ICON_GEAR },
];

// 待办状态枚举
export const TASK_STATUSES = ["pending", "doing", "paused", "done"];
export const STATUS_LABEL = {
  pending: "待开始", doing: "进行中", paused: "已暂停", done: "已完成",
};

// 优先级中文标签
export const PRIORITY_LABEL = { P0: "紧急", P1: "高", P2: "中", P3: "低", P4: "较低" };

// 提醒的默认内容已移除（2026-10-07）。
// 这里原本有一份 `DEFAULT_REMINDERS`，预置两条示例提醒（"每日计划" 09:30 / "下班打卡" 18:00）。
// 它与 state.js 里那份 SCHEDULER_SEED 是同一个模式 —— 把「用户数据」写进 git 跟踪的源码。
// 虽然这两条只是通用示例、不含个人路径，但同一个模式迟早会再长出下一份带个人信息的预置，
// 所以一并清掉。实测它当时已近乎死代码（state.reminders 默认就是 []，undefined 分支基本不命中），
// 删除不改变任何现有行为。
//
// 只保留字段语义说明（写提醒功能时照此实现）：
//   type: "daily"（每日固定时刻触发） | "interval"（每 N 分钟滚动触发）
//   daily 用 time("HH:MM") + lastTriggeredDate（当日防重复）；interval 用 intervalMin + lastAt
// 提醒现在完全由用户在时钟块的配置弹窗里增删 / 启停 / 配置。

// ─── 签到结果目录 ───
// 唯一真相在这里：state.js 的默认结构与老数据迁移、首页签到卡的读取，全部引用这个常量。
// ⚠ **脚本侧另有一份对应物**：签到脚本目录下的 `checkin_paths.py`（其 RESULT_DIR 常量）。
//    改路径必须两边同时改，只改一边会出现「脚本写了、面板读不到」的静默失配
//    （面板刷新按钮读 resultDir\last_result.json 与 trae_last_result.json）。
// 放在仓库内的 .workbuddy/ 下：该目录已在 .gitignore 里，结果文件不会污染仓库。
// （历史：这里曾是 C:\Users\<用户名>\workbuddy-checkin\logs —— 个人路径进了 git 跟踪的源码）
export const CHECKIN_RESULT_DIR = "C:\\TraeProjects\\deskoverlay\\.workbuddy\\checkin-logs";

// 旧路径的后缀。老 state.json 里存的是完整旧路径，**非空** ⇒ 只改默认值不会生效，
// 必须就地升级，否则面板会一直读旧目录、而脚本已写新目录 = 静默失配。
// 用后缀匹配而不是写死完整旧路径：免得把个人用户名再写回 git 跟踪的源码。
const LEGACY_CHECKIN_RESULT_DIR_RE = /workbuddy-checkin[\\/]+logs[\\/]*$/i;

/// 归一化结果目录：缺失 / 空 / 仍是旧路径 ⇒ 返回 CHECKIN_RESULT_DIR，否则原样保留用户设置。
/// state.js（loadState 归一化）与 workspace.js 的签到卡共用这一条规则。
export function normalizeCheckinResultDir(dir) {
  return typeof dir === "string" && dir && !LEGACY_CHECKIN_RESULT_DIR_RE.test(dir)
    ? dir
    : CHECKIN_RESULT_DIR;
}
