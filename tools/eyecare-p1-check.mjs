// 护眼 P1 前端接线校验（无需浏览器：语法 + 契约 + 静态一致性）
//
// 覆盖：
//   1. 所有改动文件语法合法（node --check 等价的 ESM 解析）
//   2. state.eyeCare 默认值与 Rust set_eyecare_config 的范围一致
//   3. 单位换算正确（前端百分比 ↔ Rust 系数）
//   4. 设置页 / app.js 的接线点齐全（DOM id、函数导入、命令注册）
//   5. 无遗漏的 invoke 命令名（与 Rust generate_handler! 比对）
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log(`  [PASS] ${name}${detail ? "  " + detail : ""}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? "  " + detail : ""}`); }
};

const read = (p) => readFileSync(join(ROOT, p), "utf8");

console.log("=== 1. 文件存在与 ESM 语法 ===");
const files = [
  "frontend/web/js/eyeCare.js",
  "frontend/web/js/state.js",
  "frontend/web/js/app.js",
  "frontend/web/js/icons.js",
  "frontend/web/js/views/settings.js",
];
for (const f of files) {
  check(`${f} 存在`, existsSync(join(ROOT, f)));
}

// 用动态 import 做真实语法+求值校验会因缺少 DOM 失败，故用 Function 构造解析
// （等价于解析阶段检查：语法错误会在此抛错，模块图错误不会）
for (const f of files) {
  let ok = true, err = "";
  try {
    const src = read(f);
    // 去掉 import/export 语句后解析函数体 —— 只验证语法合法性
    const stripped = src
      .replace(/^\s*import\s[^;]*;?$/gm, "")
      .replace(/^\s*export\s+(default\s+)?/gm, "");
    new Function(stripped);
  } catch (e) { ok = false; err = e.message; }
  check(`${f} 语法合法`, ok, err);
}

console.log("\n=== 2. state.eyeCare 默认值范围 ===");
const stateSrc = read("frontend/web/js/state.js");
const defMatch = stateSrc.match(/eyeCare:\s*\{([\s\S]*?)\n  \},/);
check("state.js 含 eyeCare 默认值块", !!defMatch);
if (defMatch) {
  const block = defMatch[1];
  const num = (k) => { const m = block.match(new RegExp(`${k}:\\s*(-?\\d+)`)); return m ? +m[1] : null; };
  check("默认 kelvin 在 2000–6500", num("kelvin") >= 2000 && num("kelvin") <= 6500, `kelvin=${num("kelvin")}`);
  check("默认 brightness 在 50–100", num("brightness") >= 50 && num("brightness") <= 100, `brightness=${num("brightness")}`);
  check("默认 contrast 在 80–100", num("contrast") >= 80 && num("contrast") <= 100, `contrast=${num("contrast")}`);
  check("默认 enabled=false", /enabled:\s*false/.test(block));
}
check("loadState 含 eyeCare 校验段", /state\.eyeCare = \{\}|ec\.kelvin = ecClamp/.test(stateSrc));

console.log("\n=== 3. 单位换算：前端百分比 ↔ Rust 系数 ===");
const ecSrc = read("frontend/web/js/eyeCare.js");
check("brightness 除以 100", /brightness:\s*ec\.brightness\s*\/\s*100/.test(ecSrc));
check("contrast 除以 100", /contrast:\s*ec\.contrast\s*\/\s*100/.test(ecSrc));
// 状态显示侧：Rust 系数乘回 100
const settingsSrc = read("frontend/web/js/views/settings.js");
check("状态显示把系数乘回 100", /status\.brightness\s*\*\s*100/.test(settingsSrc));

console.log("\n=== 4. invoke 命令名与 Rust 注册一致 ===");
const rustMain = read("src-tauri/src/main.rs");
const handlerLine = rustMain.match(/generate_handler!\[([\s\S]*?)\]\)/);
const registered = handlerLine ? handlerLine[1] : "";
const ecCommands = ["set_eyecare_config", "restore_native_color", "eyecare_status"];
for (const c of ecCommands) {
  check(`Rust 已注册 ${c}`, registered.includes(`eyecare::${c}`));
  check(`前端调用了 ${c}`, ecSrc.includes(`"${c}"`));
}

console.log("\n=== 5. Rust 侧范围 clamp 与前端一致 ===");
const rustEc = read("src-tauri/src/eyecare.rs");
check("Rust kelvin clamp 2000–6500", /kelvin\.clamp\(2000\.0,\s*6500\.0\)/.test(rustEc));
check("Rust brightness clamp 0.5–1.0", /brightness\.clamp\(0\.5,\s*1\.0\)/.test(rustEc));
check("Rust contrast clamp 0.8–1.0", /contrast\.clamp\(0\.8,\s*1\.0\)/.test(rustEc));
check("build_ramp 内部也 clamp（双重保险）", /brightness\.clamp\(0\.5,\s*1\.0\)[\s\S]*contrast\.clamp\(0\.8,\s*1\.0\)/.test(rustEc));

console.log("\n=== 6. 设置页接线点齐全 ===");
const domIds = ["ec-enable", "ec-presets", "ec-kelvin", "ec-bright", "ec-contrast", "ec-restore", "ec-status-row"];
for (const id of domIds) {
  const inHtml = settingsSrc.includes(`id="${id}"`);
  const hasHandler = settingsSrc.includes(`#${id}`);
  check(`设置页 ${id} 有 DOM 且有处理`, inHtml && hasHandler);
}
check("设置页导入了 eyeCare 控制器", /from "\.\.\/eyeCare\.js"/.test(settingsSrc));
check("设置页绑定了状态订阅并解绑", /onEyeCareChange\(paintStatus\)/.test(settingsSrc) && /view\.onDestroy\(off\)/.test(settingsSrc));
check("预设点击走 immediate 推送", /EC_PRESETS\.find[\s\S]{0,200}immediate: true/.test(settingsSrc));
check("滑杆 input 走节流、change 立即", /addEventListener\("input"[\s\S]{0,200}setEyeCare\(\{ \[key\]/.test(settingsSrc));

console.log("\n=== 7. app.js 接线 ===");
const appSrc = read("frontend/web/js/app.js");
check("app.js 导入 initEyeCare", /import \{[^}]*initEyeCare[^}]*\} from "\.\/eyeCare\.js"/.test(appSrc));
check("启动时调用 initEyeCare()", /initEyeCare\(\)/.test(appSrc));
check("指令条含护眼开关命令", /eyecare-toggle/.test(appSrc));
check("指令条含恢复原色命令", /eyecare-restore/.test(appSrc));
check("ICON_EYE 已导入", /ICON_EYE/.test(appSrc) && /ICON_EYE/.test(read("frontend/web/js/icons.js")));

console.log("\n=== 8. 事件监听（守护线程 → UI）===");
check("监听 eyecare-overridden", /Bus\.on\("eyecare-overridden"/.test(ecSrc));
check("监听 eyecare-failed", /Bus\.on\("eyecare-failed"/.test(ecSrc));
check("Rust 侧 emit eyecare-overridden", /emit\("eyecare-overridden"/.test(rustEc));
check("Rust 侧 emit eyecare-failed", /emit\("eyecare-failed"/.test(rustEc));

console.log("\n=== 9. P2 时段模式接线 ===");
// state 默认值
check("state 含 mode 字段", /mode:\s*"manual"/.test(stateSrc));
check("state 含 dayKelvin", /dayKelvin:\s*\d+/.test(stateSrc));
check("state 含 nightKelvin", /nightKelvin:\s*\d+/.test(stateSrc));
check("state 含 from/to 时段", /from:\s*"22:00"/.test(stateSrc) && /to:\s*"07:00"/.test(stateSrc));
check("state 含 transitionMin", /transitionMin:\s*\d+/.test(stateSrc));
// loadState 校验
check("校验 mode 枚举", /\["manual",\s*"schedule"\]\.includes\(ec\.mode\)/.test(stateSrc));
check("校验时刻格式 HH:MM", /HM\.test\(ec\.from\)/.test(stateSrc));
// 推送字段
check("推送 mode", /mode:\s*ec\.mode/.test(ecSrc));
check("推送 dayKelvin", /dayKelvin:\s*ec\.dayKelvin/.test(ecSrc));
check("推送 nightKelvin", /nightKelvin:\s*ec\.nightKelvin/.test(ecSrc));
check("推送 from/to", /from:\s*ec\.from/.test(ecSrc) && /to:\s*ec\.to/.test(ecSrc));
check("推送 transitionMin", /transitionMin:\s*ec\.transitionMin/.test(ecSrc));
// 设置页 UI
check("设置页有模式切换 seg", /id="ec-mode"/.test(settingsSrc));
check("设置页有 ec-from/ec-to", /id="ec-from"/.test(settingsSrc) && /id="ec-to"/.test(settingsSrc));
check("设置页有 ec-day-k/ec-night-k", /id="ec-day-k"/.test(settingsSrc) && /id="ec-night-k"/.test(settingsSrc));
check("设置页有 ec-trans", /id="ec-trans"/.test(settingsSrc));
check("模式切换触发重渲染", /setEyeCare\(\{ mode \}[\s\S]{0,80}renderBody\(\)/.test(settingsSrc));
check("时刻 change 落盘", /ecFrom\.addEventListener\("change"/.test(settingsSrc));
// Rust 侧
check("Rust 有 EyeMode 枚举", /pub enum EyeMode/.test(rustEc));
check("Rust 有 schedule_state", /pub fn schedule_state/.test(rustEc));
check("Rust 有 target_kelvin_at", /pub fn target_kelvin_at/.test(rustEc));
check("Rust status 返回 effectiveKelvin", /"effectiveKelvin"/.test(rustEc));
check("Rust status 返回 mode", /"mode":\s*cfg\.mode\.as_str\(\)/.test(rustEc));
check("Rust 有 parse_hhmm 容错", /fn parse_hhmm/.test(rustEc));
check("Rust 单元测试覆盖跨午夜", /cross_midnight_night_detection/.test(rustEc));
check("Rust 单元测试覆盖过渡不重复", /transition_not_applied_twice_after_switch/.test(rustEc));

console.log("\n=== 10. 状态行显示生效色温 ===");
check("状态行用 effectiveKelvin", /status\.effectiveKelvin/.test(settingsSrc));
check("状态行区分日/夜色温", /日间 \$\{status\.dayKelvin\}K \/ 夜间/.test(settingsSrc));

console.log("\n=== 11. P3 顶栏胶囊 ===");
const capSrc = read("frontend/web/js/eyeCareCapsule.js");
check("胶囊文件存在", existsSync(join(ROOT, "frontend/web/js/eyeCareCapsule.js")));
let capOk = true, capErr = "";
try {
  const stripped = capSrc.replace(/^\s*import\s[^;]*;?$/gm, "").replace(/^\s*export\s+(default\s+)?/gm, "");
  new Function(stripped);
} catch (e) { capOk = false; capErr = e.message; }
check("胶囊语法合法", capOk, capErr);
check("导出 initEyeCareCapsule", /export function initEyeCareCapsule/.test(capSrc));
check("插到番茄钟右侧（顺序保证）", /pomoEl\.nextSibling/.test(capSrc));
check("app.js 调用 initEyeCareCapsule", /initEyeCareCapsule\(\)/.test(appSrc));
check("initPomodoro 在 initEyeCareCapsule 之前", 
  appSrc.indexOf("initPomodoro()") < appSrc.indexOf("initEyeCareCapsule()"));
check("胶囊有 4 个快捷档位", /QUICK_PRESETS/.test(capSrc) && /office/.test(capSrc) && /late/.test(capSrc));
check("胶囊区分未生效态", /data-inactive|dataset\.inactive/.test(capSrc));
check("胶囊支持 Esc 关闭", /e\.key === "Escape" && opened/.test(capSrc));
check("CSS 有 .mc-eye", /\.mc-eye \{/.test(read("frontend/web/css/style.css")));
check("CSS 有 .eye-pop", /\.eye-pop \{/.test(read("frontend/web/css/style.css")));
check("CSS 有窄窗适配", /max-width: 1180px[\s\S]{0,120}\.mc-eye/.test(read("frontend/web/css/style.css")));

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
