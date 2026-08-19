// 置顶提醒窗口页逻辑：
// 监听 Rust 推送的 show-reminder 事件 → 渲染内容 → 点击"知道了"后调用 hide_reminder 隐藏。
// 不自动消失（用户明确要求），也不加投影。
const TAURI = (typeof window !== "undefined" && window.__TAURI__) || null;

const card = document.getElementById("card");
const iconEl = document.getElementById("icon");
const titleEl = document.getElementById("title");
const msgEl = document.getElementById("msg");

function hide() {
  card.classList.remove("show");
  if (TAURI && TAURI.core && typeof TAURI.core.invoke === "function") {
    TAURI.core.invoke("hide_reminder").catch(() => {});
  }
}

function show() {
  card.classList.add("show");
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
    .catch((err) => console.warn("[reminder] 监听失败：", err));
}

document.getElementById("ok").addEventListener("click", hide);
