// 锁屏页逻辑：canvas 绘制旋转星系（螺旋星云 + 椭圆轨道 + 正圆行星）+ 中央太阳解锁。
const TAURI = (typeof window !== "undefined" && window.__TAURI__) || null;

const canvas = document.getElementById("sky");
const ctx = canvas.getContext("2d");
const sunBtn = document.getElementById("sunUnlock");
let W = 0;
let H = 0;
let dpr = 1;
let cx = 0;
let cy = 0;

// 每颗行星：椭圆轨道(rx, ry)、公转速度/方向、初始角度、半径、配色
// 各行星相对比例保持不变，仅整体放大视觉尺寸
const PLANETS = [
  { rx: 0.20, ry: 0.106, speed: 0.02, dir: 1, r: 0.0125, a0: 0.0, colors: ["#9cc4e6", "#3d5f82", "#1f2c3d"], ring: false }, // 水星
  { rx: 0.26, ry: 0.138, speed: 0.015, dir: -1, r: 0.015, a0: 1.8, colors: ["#ffe6b8", "#d9a95e", "#7a4e1e"], ring: false }, // 金星
  { rx: 0.32, ry: 0.166, speed: 0.012, dir: 1, r: 0.017, a0: 3.6, colors: ["#5fb0dc", "#2d7fb8", "#11395e"], ring: false }, // 地球
  { rx: 0.37, ry: 0.192, speed: 0.0095, dir: -1, r: 0.014, a0: 5.1, colors: ["#f0a073", "#a05028", "#5a2a12"], ring: false }, // 火星
  { rx: 0.435, ry: 0.224, speed: 0.0075, dir: 1, r: 0.023, a0: 1.1, colors: ["#f0d4a4", "#c48a5a", "#8a5a2a"], ring: false }, // 木星
  { rx: 0.50, ry: 0.255, speed: 0.006, dir: -1, r: 0.021, a0: 4.4, colors: ["#f2e6c2", "#c9ad7a", "#7a5c30"], ring: true },  // 土星
  { rx: 0.565, ry: 0.286, speed: 0.005, dir: 1, r: 0.016, a0: 2.4, colors: ["#b8ecec", "#5aa8b8", "#2a6080"], ring: false }, // 天王星
  { rx: 0.62, ry: 0.315, speed: 0.004, dir: -1, r: 0.016, a0: 0.6, colors: ["#6aa6e8", "#2a4a9c", "#101f5e"], ring: false }, // 海王星
];

const STARS = 260;
let stars = [];

function resize() {
  dpr = Math.max(1, window.devicePixelRatio || 1);
  W = window.innerWidth;
  H = window.innerHeight;
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  canvas.style.width = W + "px";
  canvas.style.height = H + "px";
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  cx = W / 2;
  cy = H / 2;
  stars = [];
  for (let i = 0; i < STARS; i++) {
    stars.push({
      x: Math.random() * W,
      y: Math.random() * H,
      r: Math.random() < 0.85 ? 0.5 + Math.random() * 0.8 : 1.2 + Math.random() * 1.4,
      base: 0.25 + Math.random() * 0.6,
      tw: 1.5 + Math.random() * 3.5,
      ph: Math.random() * Math.PI * 2,
    });
  }
}

function drawCircle(x, y, radius, stops) {
  const g = ctx.createRadialGradient(x - radius * 0.35, y - radius * 0.35, radius * 0.1, x, y, radius);
  g.addColorStop(0, stops[0]);
  g.addColorStop(0.55, stops[1]);
  g.addColorStop(1, stops[2]);
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fillStyle = g;
  ctx.fill();
}

function frame(now) {
  const t = now / 1000;
  ctx.clearRect(0, 0, W, H);

  // 背景闪烁星星
  for (const s of stars) {
    const a = s.base + Math.sin(t * s.tw + s.ph) * 0.35;
    ctx.globalAlpha = Math.max(0, Math.min(1, a));
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // 星系核心辉光（柔和的暖色光晕，太阳 DOM 会叠在其上）
  const coreR = 0.13 * Math.min(W, H);
  const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR);
  core.addColorStop(0, "rgba(255,215,150,0.35)");
  core.addColorStop(0.5, "rgba(255,170,110,0.12)");
  core.addColorStop(1, "rgba(255,150,90,0)");
  ctx.fillStyle = core;
  ctx.beginPath();
  ctx.arc(cx, cy, coreR, 0, Math.PI * 2);
  ctx.fill();

  // 轨道椭圆环（淡）
  ctx.lineWidth = 1;
  for (const p of PLANETS) {
    ctx.strokeStyle = "rgba(255,255,255,0.10)";
    ctx.beginPath();
    ctx.ellipse(cx, cy, p.rx * Math.min(W, H), p.ry * Math.min(W, H), 0, 0, Math.PI * 2);
    ctx.stroke();
  }

  // 画行星（土星先画光环在背后）
  ctx.save();
  for (const p of PLANETS) {
    const x = cx + Math.cos(p.a0) * p.rx * Math.min(W, H);
    const y = cy + Math.sin(p.a0) * p.ry * Math.min(W, H);
    const rad = p.r * Math.min(W, H);
    if (p.ring) {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(-0.35);
      ctx.strokeStyle = "rgba(235,220,180,0.45)";
      ctx.lineWidth = Math.max(1.5, rad * 0.28);
      ctx.beginPath();
      ctx.ellipse(0, 0, rad * 1.7, rad * 0.55, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = "rgba(235,220,180,0.28)";
      ctx.lineWidth = Math.max(1, rad * 0.15);
      ctx.beginPath();
      ctx.ellipse(0, 0, rad * 2.1, rad * 0.7, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
    drawCircle(x, y, rad, p.colors);
    // 自转痕迹：极淡的横向条纹让球看起来在转
    ctx.save();
    ctx.translate(x, y);
    ctx.globalAlpha = 0.10;
    for (let k = -1; k <= 1; k++) {
      ctx.beginPath();
      ctx.ellipse(0, k * rad * 0.4, rad * 0.95, rad * 0.22, 0, Math.PI, Math.PI * 2);
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = Math.max(0.6, rad * 0.08);
      ctx.stroke();
    }
    ctx.restore();
  }
  ctx.restore();

  // 更新公转角度
  for (const p of PLANETS) p.a0 += p.speed * 0.3 * p.dir;

  requestAnimationFrame(frame);
}

function unlock() {
  if (TAURI && TAURI.core && typeof TAURI.core.invoke === "function") {
    TAURI.core.invoke("hide_lock").catch(() => {});
  }
}

sunBtn.addEventListener("click", unlock);
window.addEventListener("resize", resize);
resize();
requestAnimationFrame(frame);