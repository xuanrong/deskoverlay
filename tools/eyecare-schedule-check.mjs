// 时段模式（Schedule）纯函数验证 —— 跨午夜 / 过渡插值 / 边界
//
// 这些是时段功能最容易出错的地方：
//   * from > to 的跨午夜时段（22:00–07:00）不能简单比较大小
//   * 过渡区间在切换点前后都要生效，且方向对称
//   * 时段边界点（恰好 22:00 / 恰好 07:00）的归属要明确
//
// 注意：本脚本与 src-tauri/src/eyecare.rs 的 schedule_state / target_kelvin_at
// 是同一套算法的 JS 镜像。Rust 侧由 examples/eyecare_probe.rs 验证真实读写，
// 本脚本用于快速覆盖大量时间点的边界组合（比跑 Rust 二进制快得多）。

const minutesOfDay = (h, m) => Math.min(h, 23) * 60 + Math.min(m, 59);

// 返回 (是否夜间, 距「下一个」切换点还有多少分钟, 该切换点是否为「进入夜间」)
//
// 语义要点：toSwitch 是「距下一个切换点的倒计时」而非「距最近切换点」。
// 后者会让切换点两侧都落入过渡窗口，同一段过渡执行两次且方向相反
// （实测：07:00 正确 5500K，但 07:10 退回 4800K，07:30 又跳回 5500K）。
function scheduleState(nowMin, from, to) {
  const span = from <= to ? to - from : to + 1440 - from;
  const rel = ((nowMin - from) % 1440 + 1440) % 1440;
  const isNight = rel < span;
  // 夜间内 → 下一个切换点是「离开夜间」；白天内 → 下一个切换点是「进入夜间」
  return isNight ? [true, span - rel, false] : [false, 1440 - rel, true];
}

function targetKelvinAt(cfg, nowMin) {
  if (cfg.mode === "manual") return cfg.kelvin;
  const from = minutesOfDay(cfg.from[0], cfg.from[1]);
  const to = minutesOfDay(cfg.to[0], cfg.to[1]);
  const [isNight, toSwitch, enteringNight] = scheduleState(nowMin, from, to);
  const trans = Math.max(0, cfg.transitionMin);
  const day = cfg.dayKelvin, night = cfg.nightKelvin;
  // 只在到达切换点之前过渡（后侧不再过渡一次）
  if (trans === 0 || toSwitch >= trans) return isNight ? night : day;
  const t = 1 - toSwitch / trans;
  return enteringNight ? day + (night - day) * t : night + (day - night) * t;
}

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log(`  [PASS] ${name}${detail ? "  " + detail : ""}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? "  " + detail : ""}`); }
};
const near = (a, b, tol = 1) => Math.abs(a - b) <= tol;

// 跨午夜时段：22:00 – 07:00，过渡 30 分钟
const night = {
  mode: "schedule", kelvin: 4500,
  dayKelvin: 5500, nightKelvin: 3400,
  from: [22, 0], to: [7, 0], transitionMin: 30,
};

console.log("=== 1. 跨午夜时段归属（22:00–07:00）===");
const cases = [
  ["23:00 应为夜间", minutesOfDay(23, 0), true],
  ["00:30 应为夜间（跨午夜）", minutesOfDay(0, 30), true],
  ["03:00 应为夜间", minutesOfDay(3, 0), true],
  ["06:30 应为夜间", minutesOfDay(6, 30), true],
  ["08:00 应为白天", minutesOfDay(8, 0), false],
  ["12:00 应为白天", minutesOfDay(12, 0), false],
  ["21:00 应为白天", minutesOfDay(21, 0), false],
];
for (const [name, min, expect] of cases) {
  const [isNight] = scheduleState(min, minutesOfDay(22, 0), minutesOfDay(7, 0));
  check(name, isNight === expect, `isNight=${isNight}`);
}

console.log("\n=== 2. 同日时段（13:00–14:00）===");
const noonCases = [
  ["13:30 应为夜间", minutesOfDay(13, 30), true],
  ["12:59 应为白天", minutesOfDay(12, 59), false],
  ["14:01 应为白天", minutesOfDay(14, 1), false],
  ["00:00 应为白天", minutesOfDay(0, 0), false],
];
for (const [name, min, expect] of noonCases) {
  const [isNight] = scheduleState(min, minutesOfDay(13, 0), minutesOfDay(14, 0));
  check(name, isNight === expect, `isNight=${isNight}`);
}

console.log("\n=== 3. 稳态色温（远离过渡区）===");
check("14:00 白天取 dayKelvin", near(targetKelvinAt(night, minutesOfDay(14, 0)), 5500),
  `${targetKelvinAt(night, minutesOfDay(14, 0))}`);
check("23:00 夜间取 nightKelvin", near(targetKelvinAt(night, minutesOfDay(23, 0)), 3400),
  `${targetKelvinAt(night, minutesOfDay(23, 0))}`);
check("03:00 夜间取 nightKelvin", near(targetKelvinAt(night, minutesOfDay(3, 0)), 3400),
  `${targetKelvinAt(night, minutesOfDay(3, 0))}`);

console.log("\n=== 4. 过渡区间线性插值 ===");
const t2130 = targetKelvinAt(night, minutesOfDay(21, 30));
const t2145 = targetKelvinAt(night, minutesOfDay(21, 45));
const t2200 = targetKelvinAt(night, minutesOfDay(22, 0));
console.log(`  21:30=${t2130.toFixed(0)}K  21:45=${t2145.toFixed(0)}K  22:00=${t2200.toFixed(0)}K`);
check("过渡起点接近 dayKelvin", near(t2130, 5500, 5), `${t2130.toFixed(0)}K`);
check("过渡中点约在日夜间中值", near(t2145, 4450, 5), `${t2145.toFixed(0)}K`);
check("过渡终点等于 nightKelvin", near(t2200, 3400, 5), `${t2200.toFixed(0)}K`);
check("过渡单调递减（渐暖）", t2130 > t2145 && t2145 > t2200);

const t0630 = targetKelvinAt(night, minutesOfDay(6, 30));
const t0645 = targetKelvinAt(night, minutesOfDay(6, 45));
const t0700 = targetKelvinAt(night, minutesOfDay(7, 0));
console.log(`  06:30=${t0630.toFixed(0)}K  06:45=${t0645.toFixed(0)}K  07:00=${t0700.toFixed(0)}K`);
check("退出过渡起点等于 nightKelvin", near(t0630, 3400, 5), `${t0630.toFixed(0)}K`);
check("退出过渡单调递增（渐冷）", t0630 < t0645 && t0645 < t0700);
check("退出过渡终点接近 dayKelvin", near(t0700, 5500, 5), `${t0700.toFixed(0)}K`);

console.log("\n=== 5. 边界与异常输入 ===");
const noTrans = { ...night, transitionMin: 0 };
check("transition=0 时夜间精确取 nightKelvin", near(targetKelvinAt(noTrans, minutesOfDay(23, 0)), 3400));
check("transition=0 时白天精确取 dayKelvin", near(targetKelvinAt(noTrans, minutesOfDay(12, 0)), 5500));
check("transition=0 时无过渡区（21:59 仍是白天值）",
  near(targetKelvinAt(noTrans, minutesOfDay(21, 59)), 5500));

const zeroSpan = { ...night, from: [10, 0], to: [10, 0] };
check("from==to 时全天为白天（0 长度时段，不误判）",
  near(targetKelvinAt(zeroSpan, minutesOfDay(12, 0)), 5500),
  `${targetKelvinAt(zeroSpan, minutesOfDay(12, 0))}`);

const manual = { ...night, mode: "manual", kelvin: 5000 };
check("Manual 模式忽略时段（任何时刻都用 kelvin）",
  near(targetKelvinAt(manual, minutesOfDay(3, 0)), 5000) &&
  near(targetKelvinAt(manual, minutesOfDay(14, 0)), 5000));

console.log("\n=== 6. 全时段扫描（每 10 分钟，验证无跳变）===");
let maxJump = 0, jumpAt = 0, prev = targetKelvinAt(night, 0);
for (let m = 10; m < 1440; m += 10) {
  const cur = targetKelvinAt(night, m);
  const jump = Math.abs(cur - prev);
  if (jump > maxJump) { maxJump = jump; jumpAt = m; }
  prev = cur;
}
console.log(`  最大单步跳变 ${maxJump.toFixed(0)}K（在 ${Math.floor(jumpAt / 60)}:${String(jumpAt % 60).padStart(2, "0")}）`);
check("无突变（单步 < 800K，说明过渡生效）", maxJump < 800, `maxJump=${maxJump.toFixed(0)}K`);
check("过渡显著小于无过渡时的突跳", maxJump < Math.abs(5500 - 3400) * 0.5);

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
