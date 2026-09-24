// 锁屏页逻辑：canvas 绘制旋转星空（场景实现见 lockScene.js）+ 中央太阳解锁。
import { startSkyAnim } from "./lockScene.js";

const TAURI = (typeof window !== "undefined" && window.__TAURI__) || null;

startSkyAnim(document.getElementById("sky"));
document.getElementById("sunUnlock").addEventListener("click", unlock);

// 解锁：请求后端销毁系统级锁屏窗口。
// 必须重试——这是全屏置顶窗口，invoke 静默失败会让用户卡在锁屏页无法退出，只能杀进程。
// 拆成两层是为了让 unlock 保持无参：它被当作 click 监听器直接使用（见上方绑定），
// 若把 retry 直接做成 unlock 的形参，Event 对象会被当成 retry 传入导致重试判断失效。
function hideLockWin(retry) {
  if (!(TAURI && TAURI.core && typeof TAURI.core.invoke === "function")) return;
  TAURI.core.invoke("hide_lock").catch(() => {
    if (retry > 0) setTimeout(() => hideLockWin(retry - 1), 300);
  });
}

function unlock() {
  hideLockWin(2);
}