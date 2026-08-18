// 事件总线 + 命令桥 —— 模拟 Tauri 的 invoke / listen(provider-emit) 解耦模型，
// 同时无缝桥接真实 Tauri 运行时（通过 withGlobalTauri 暴露的 window.__TAURI__）。
//
// 运行环境分两类：
//   1) 浏览器开发态（node serve.js）：无 __TAURI__，invoke 回退到 Bus 模拟，
//      provider-emit 由前端 providers.js 模拟源驱动。
//   2) 真实 Tauri 桌面态：invoke 调用 Rust 命令；Rust 经事件系统 emit 的
//      provider-emit 被桥接进 Bus，前端渲染器无需感知环境差异。

const listeners = new Map();

// 是否处于真实 Tauri 运行时（tauri.conf.json 需开启 app.withGlobalTauri）。
const TAURI = (typeof window !== "undefined" && window.__TAURI__) || null;

export const Bus = {
  on(event, fn) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(fn);
    return () => listeners.get(event)?.delete(fn);
  },
  emit(event, payload) {
    listeners.get(event)?.forEach((fn) => {
      try { fn(payload); } catch (e) { console.error(`[bus:${event}]`, e); }
    });
  },
};

// 命令面：优先调用真实 Rust 命令（report_panel_rect / remove_panel_rect 等），
// 浏览器态回退到 Bus 模拟（cmd:<command>），保留后端对接缝。
export async function invoke(command, args = {}) {
  if (TAURI && TAURI.core && typeof TAURI.core.invoke === "function") {
    try {
      return await TAURI.core.invoke(command, args);
    } catch (e) {
      console.warn(`[invoke:${command}] 调用失败，回退模拟：`, e);
    }
  }
  Bus.emit(`cmd:${command}`, args);
  return Promise.resolve();
}

// 将 Rust 经 Tauri 事件系统推送的 provider-emit / im-notify 桥接进 Bus，
// 使前端渲染器与 IM 角标无需区分运行环境即可消费真实数据。
if (TAURI && TAURI.event && typeof TAURI.event.listen === "function") {
  TAURI.event
    .listen("provider-emit", (e) => Bus.emit("provider-emit", e.payload))
    .catch((err) => console.warn("[bridge] provider-emit 监听失败：", err));
  TAURI.event
    .listen("im-notify", (e) => Bus.emit("im-notify", e.payload))
    .catch((err) => console.warn("[bridge] im-notify 监听失败：", err));
}
