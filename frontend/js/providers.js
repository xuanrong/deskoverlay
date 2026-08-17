// Provider 数据网格 — 对齐文档 §6「双向数据网格」与 §5.5 Provider 模型。
// 数据流向: Provider → Event Bus(provider-emit) → Panel Renderer(按 config_hash 路由)。
// 浏览器内系统指标用真实感随机游走模拟；Tauri 后端接入真实 sysinfo 后只需替换 emit 源。
import { Bus } from "./bus.js";

const timers = new Map();

// ---- 工具: 受限随机游走，结果平滑且有界 ----
function walk(prev, min, max, step) {
  let v = prev + (Math.random() - 0.5) * step;
  if (v < min) v = min + Math.random() * step * 0.3;
  if (v > max) v = max - Math.random() * step * 0.3;
  return v;
}

function emit(hash, output) {
  Bus.emit("provider-emit", { config_hash: hash, output });
}

// ---- 系统指标 Provider (CPU / RAM / Network / Battery) ----
function startSystem() {
  let cpu = 18, ram = 46, netUp = 0.4, netDown = 2.1, battery = 82;
  const tick = () => {
    cpu = walk(cpu, 3, 92, 14);
    ram = walk(ram, 30, 88, 6);
    netUp = walk(netUp, 0, 12, 3);
    netDown = walk(netDown, 0, 40, 8);
    battery = walk(battery, 5, 100, 0.6);
    emit("system", {
      cpu: +cpu.toFixed(1),
      ram: +ram.toFixed(1),
      ramUsedGb: +((ram / 100) * 16).toFixed(1),
      ramTotalGb: 16,
      netUp: +netUp.toFixed(2),
      netDown: +netDown.toFixed(2),
      battery: +battery.toFixed(0),
      power: battery > 95 ? "AC" : "Battery",
    });
  };
  tick();
  timers.set("system", setInterval(tick, 1000));
}

// ---- 时钟 Provider ----
function startClock() {
  const tick = () => {
    const now = new Date();
    const h = now.getHours();
    let greet = "晚上好";
    if (h < 5) greet = "夜深了";
    else if (h < 11) greet = "早上好";
    else if (h < 14) greet = "中午好";
    else if (h < 18) greet = "下午好";
    emit("clock", {
      time: now.toLocaleTimeString("zh-CN", { hour12: false }),
      date: now.toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric", weekday: "long" }),
      weekday: now.getDay(),
      day: now.getDate(),
      month: now.getMonth(),
      year: now.getFullYear(),
      greet,
    });
  };
  tick();
  timers.set("clock", setInterval(tick, 1000));
}

// ---- 天气 Provider (模拟，含 5 日预报) ----
const WX = [
  { city: "上海", now: 21, cond: "多云", icon: "⛅", forecast: [
    { d: "周一", t: "21°", i: "⛅" }, { d: "周二", t: "19°", i: "🌧" },
    { d: "周三", t: "23°", i: "☀" }, { d: "周四", t: "20°", i: "⛅" },
    { d: "周五", t: "18°", i: "🌧" } ] },
];
function startWeather() {
  const w = WX[0];
  emit("weather", w);
  timers.set("weather", setInterval(() => emit("weather", w), 60000));
}

const REGISTRY = { system: startSystem, clock: startClock, weather: startWeather };

export const Providers = {
  start(hash) {
    if (timers.has(hash)) return;
    const fn = REGISTRY[hash];
    if (fn) fn();
  },
  startAll() { Object.keys(REGISTRY).forEach((h) => this.start(h)); },
  stop(hash) {
    if (timers.has(hash)) { clearInterval(timers.get(hash)); timers.delete(hash); }
  },
};
