// 通用小工具：HTML 转义、本地日期/时间字符串、唯一 id 生成。各层模块共用。

// HTML 转义（null-safe）：用于把动态文本安全嵌入 innerHTML 与属性值
export const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// 本地日期 key：YYYY-MM-DD（默认当前时刻）
export const ymd = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

// 本地时刻：HH:MM（默认当前时刻）
export const hhmm = (d = new Date()) =>
  `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

// 本地唯一 id：前缀 + 时间基 36 + 6 位随机后缀（同毫秒内不碰撞）
export const uid = (prefix) => `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;