// 置顶提醒窗口页逻辑：
// 监听 Rust 推送的 show-reminder 事件 → 渲染内容 → 点击"知道了"或超时后调用 hide_reminder 关闭。
// 关闭即销毁窗口，避免透明常驻置顶窗留在右上角一直拦截点击；也不加投影。
const TAURI = (typeof window !== "undefined" && window.__TAURI__) || null;

const card = document.getElementById("card");
const iconEl = document.getElementById("icon");
const titleEl = document.getElementById("title");
const msgEl = document.getElementById("msg");

// 自动关闭时长（ms）；到点销毁窗口，防止置顶透明窗长期占住右上角
const AUTO_CLOSE_MS = 10000;
let autoHideTimer = null;

function hide() {
  card.classList.remove("show");
  clearTimeout(autoHideTimer);
  autoHideTimer = null;
  if (TAURI && TAURI.core && typeof TAURI.core.invoke === "function") {
    TAURI.core.invoke("hide_reminder").catch(() => {});
  }
}

function show() {
  card.classList.add("show");
  clearTimeout(autoHideTimer);
  autoHideTimer = setTimeout(hide, AUTO_CLOSE_MS);
}

if (TAURI && TAURI.event && typeof TAURI.event.listen === "function") {
  TAURI.event
    .listen("show-reminder", (e) => {
      const { icon, title, message } = e.payload || {};
      if (icon) {
        iconEl.innerHTML = icon;
        iconEl.style.display = "";
      } else {
        iconEl.innerHTML = "";
        iconEl.style.display = "none";
      }
      titleEl.textContent = title || "提醒";
      msgEl.textContent = message || "";
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
