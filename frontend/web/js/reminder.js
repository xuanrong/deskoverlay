// 置顶提醒窗口页逻辑：
// 监听 Rust 推送的 show-reminder 事件 → 渲染内容 → 点击"知道了"或超时后调用 hide_reminder 关闭。
// 关闭即销毁窗口，避免透明常驻置顶窗留在右上角一直拦截点击；也不加投影。
//
// 不变量（2026-09-12）：**窗口可见 ⟺ 有内容**。
// 卡片 opacity 起步为 0，一旦出现"窗口已显示但卡片未 show"的中间态，视觉上等于没有弹窗，
// 但窗口仍占据右上角矩形并吞掉该区域全部鼠标消息（含右键呼出桌面菜单），且本页的
// autoHideTimer 只在 show() 里启动 → 会永久残留。故：未收到推送绝不显示，
// 收到推送必启动倒计时，hide 的 invoke 失败必须重试。
const TAURI = (typeof window !== "undefined" && window.__TAURI__) || null;

const card = document.getElementById("card");
const iconSvg = document.getElementById("icon-svg");
const titleEl = document.getElementById("title");
const msgEl = document.getElementById("msg");
const timeEl = document.getElementById("time");

// 自动关闭：由进度条动画结束事件（rm-countdown 走完）驱动，与进度条严格同步；
// AUTO_CLOSE_MS 仅作兜底（比动画略长，动画事件异常丢失时也能关）。
const AUTO_CLOSE_MS = 11000;
let autoHideTimer = null;
// 本页是否成功展示过内容（供孤儿窗口兜底判断）
let shownOnce = false;

function inferType(title) {
  if (!title) return "general";
  if (title.includes("喝水")) return "water";
  if (title.includes("久坐")) return "sedentary";
  if (title.includes("番茄钟")) return "pomodoro";
  return "general";
}

// 请求后端销毁窗口；失败重试一次 —— 静默吞掉失败会留下拦截鼠标的残留窗口
function invokeHide(retry = 1) {
  if (!(TAURI && TAURI.core && typeof TAURI.core.invoke === "function")) return;
  TAURI.core.invoke("hide_reminder").catch(() => {
    if (retry > 0) setTimeout(() => invokeHide(retry - 1), 300);
  });
}

function hide() {
  card.classList.remove("show", "timing");
  clearTimeout(autoHideTimer);
  autoHideTimer = null;
  invokeHide();
}

function show() {
  shownOnce = true;
  // 重置进度条动画（移除 timing 类触发 reflow 后重新添加）
  card.classList.remove("timing");
  void card.offsetWidth;
  card.classList.add("show", "timing");
  clearTimeout(autoHideTimer);
  autoHideTimer = setTimeout(hide, AUTO_CLOSE_MS);
}

if (TAURI && TAURI.event && typeof TAURI.event.listen === "function") {
  TAURI.event
    .listen("show-reminder", (e) => {
      const { icon, title, message } = e.payload || {};
      const type = inferType(title || "");
      card.setAttribute("data-type", type);

      if (icon) {
        iconSvg.innerHTML = icon;
        iconSvg.style.display = "";
      } else {
        iconSvg.innerHTML = "";
        iconSvg.style.display = "none";
      }
      titleEl.textContent = title || "提醒";
      msgEl.textContent = message || "";

      const now = new Date();
      timeEl.textContent = String(now.getHours()).padStart(2, "0") + ":" + String(now.getMinutes()).padStart(2, "0");

      show();
    })
    .then(() => {
      // listener 已就绪：通知后端取用暂存内容推送（规避 emit 早于注册导致的丢事件）
      if (TAURI && TAURI.core && typeof TAURI.core.invoke === "function") {
        TAURI.core.invoke("reminder_ready").catch(() => {});
      }
    })
    .catch((err) => console.warn("[reminder] 监听失败：", err));
}

document.getElementById("ok").addEventListener("click", hide);

// 进度条走完（rm-countdown 动画结束）→ 关闭弹窗：与进度条严格同步，
// 避免 JS 计时先到导致「进度条还差一点就消失」的观感
card.addEventListener("animationend", (e) => {
  if (e.animationName === "rm-countdown") hide();
});

// 孤儿兜底：页面加载后始终未收到推送（listener 注册失败 / 事件丢失）时，
// 主动请后端销毁窗口——绝不让「无内容却已显示」的窗口留在右上角拦截鼠标。
// 与后端 REMINDER_HARD_TTL_MS 硬超时构成双保险：前端快（5s）、后端兜底（15s）。
setTimeout(() => {
  if (!shownOnce) invokeHide();
}, 5000);