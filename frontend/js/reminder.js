// 置顶提醒窗口页逻辑：
// 监听 Rust 推送的 show-reminder 事件 → 渲染内容 → 点击"知道了"后调用 hide_reminder 隐藏。
// 不自动消失（用户明确要求），也不加投影。
const TAURI = (typeof window !== "undefined" && window.__TAURI__) || null;

const CLOCK_SVG = `<svg viewBox="0 0 24 24" width="26" height="26"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 7v5l3 3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

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
      iconEl.innerHTML = icon || CLOCK_SVG;
      titleEl.textContent = title || "提醒";
      msgEl.textContent = message || "";
      show();
    })
    .catch((err) => console.warn("[reminder] 监听失败：", err));
}

document.getElementById("ok").addEventListener("click", hide);
