// 本地持久化层 — Tauri 态走 Rust（state.json 落盘 app_data_dir），
// 浏览器 dev 态回退 localStorage。Store.load/save 均为异步。
import { invoke } from "./bus.js";

const KEY = "deskoverlay.state.v1";
const DEFAULTS = { currentModule: "dashboard", tasks: [], notes: "" };
const TAURI = typeof window !== "undefined" && window.__TAURI__;

export const Store = {
  async load() {
    if (TAURI) {
      try {
        return await invoke("load_state");
      } catch (e) {
        console.warn("[store] Rust load 失败，回退 localStorage", e);
      }
    }
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return structuredClone(DEFAULTS);
      return { ...structuredClone(DEFAULTS), ...JSON.parse(raw) };
    } catch (e) {
      console.warn("[store] localStorage 读取失败", e);
      return structuredClone(DEFAULTS);
    }
  },

  async save(state) {
    if (TAURI) {
      try {
        await invoke("save_state", { state });
        return;
      } catch (e) {
        console.warn("[store] Rust save 失败，回退 localStorage", e);
      }
    }
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch (e) {
      console.warn("[store] localStorage 写入失败", e);
    }
  },

  async reset() {
    if (TAURI) {
      try {
        await invoke("save_state", { state: structuredClone(DEFAULTS) });
        return;
      } catch (e) {
        console.warn("[store] Rust reset 失败，回退 localStorage", e);
      }
    }
    localStorage.removeItem(KEY);
  },
};
