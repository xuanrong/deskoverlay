// 锁屏页逻辑：监听 show（lock-init）开始树成长动画；点解锁调用 hide_lock。
const TAURI = (typeof window !== "undefined" && window.__TAURI__) || null;

const card = document.querySelector(".lock-card");
const GROW_MS = 12000;
let raf = 0;

function startGrow() {
  if (raf) cancelAnimationFrame(raf);
  card.style.setProperty("--g", 0);
  card.style.setProperty("--gc", 0);
  const start = performance.now();
  const step = () => {
    const p = Math.min(1, (performance.now() - start) / GROW_MS);
    card.style.setProperty("--g", p.toFixed(3));
    const gc = p <= 0.15 ? 0 : Math.min(1, (p - 0.15) / 0.85);
    card.style.setProperty("--gc", gc.toFixed(3));
    if (p < 1) raf = requestAnimationFrame(step);
    else raf = 0;
  };
  raf = requestAnimationFrame(step);
}

function stopGrow() {
  if (raf) { cancelAnimationFrame(raf); raf = 0; }
}

function unlock() {
  if (TAURI && TAURI.core && typeof TAURI.core.invoke === "function") {
    TAURI.core.invoke("hide_lock").catch(() => {});
  }
}

document.getElementById("unlock").addEventListener("click", unlock);

if (TAURI && TAURI.event && typeof TAURI.event.listen === "function") {
  TAURI.event.listen("lock-init", () => startGrow()).catch(() => {});
  TAURI.event.listen("lock-hide", () => stopGrow()).catch(() => {});
}