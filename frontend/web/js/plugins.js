// 通用插件机制：从「外部 .js 插件文件」动态加载模块并注入工作台（侧边导航 + 视图渲染器）。
// 插件契约：文件默认导出 { id, title, icon, render }，render(view, api) 负责渲染视图。
// 插件不得超过 import 主应用内部模块——统一通过 api 使用核心能力，真正做到「工作台不含插件业务代码、插件可独立分发」。
import { invoke } from "./bus.js";
import { state, saveState } from "./state.js";
import { esc, showDialog } from "./views/common.js";
import { VIEW_RENDERERS } from "./views.js";
import { MODULES } from "./config.js";

// 暴露给插件的运行时 API（均为工作台通用能力，不含任何业务）
export const PLUGIN_API = { invoke, state, saveState, esc, showDialog };

const loaded = new Map(); // moduleId -> { def, path }
const changed = []; // 插件集合变化 → 通知 app 重建导航
export function onPluginsChanged(fn) { changed.push(fn); }
function notify() { changed.forEach((f) => { try { f(); } catch (_) {} }); }

// 读取外部文件文本并用 ES Module 动态执行
async function loadModuleFromPath(path) {
  const code = await invoke("read_text_file", { path });
  const url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
  let mod;
  try { mod = await import(url); } finally { URL.revokeObjectURL(url); }
  const def = mod && (mod.default || mod);
  if (!def || typeof def !== "object" || !def.id || !def.title || typeof def.render !== "function") {
    throw new Error("插件格式无效：需默认导出 { id, title, icon, render }");
  }
  return def;
}

function registerDef(def, path) {
  if (MODULES.some((m) => m.id === def.id)) return def; // 已存在同名模块
  MODULES.push({ id: def.id, title: def.title, icon: def.icon || "" });
  VIEW_RENDERERS[def.id] = (view) => def.render(view, PLUGIN_API);
  loaded.set(def.id, { def, path });
  return def;
}

function unregister(id) {
  const i = MODULES.findIndex((m) => m.id === id);
  if (i >= 0) MODULES.splice(i, 1);
  delete VIEW_RENDERERS[id];
  loaded.delete(id);
}

async function loadPlugin(rec) {
  const def = await loadModuleFromPath(rec.path);
  registerDef(def, rec.path);
  rec.id = def.id;
  rec.title = def.title;
}

/// 启动时加载全部「已启用」插件。返回每项结果，供启动流程记录/降级。
export async function initPlugins() {
  const list = Array.isArray(state.plugins)
    ? state.plugins.filter((p) => p && p.enabled !== false)
    : [];
  const results = [];
  for (const rec of list) {
    try {
      await loadPlugin(rec);
      results.push({ id: rec.id, ok: true });
      saveState();
    } catch (e) {
      results.push({ id: rec.id || rec.path || "(未知)", ok: false, err: String(e) });
    }
  }
  return results;
}

/// 用户新增插件：传入文件路径，加载并注册（enabled=true），失败抛错由调用方展示。
export async function addPlugin(path) {
  const p = (path || "").trim();
  if (!p) throw new Error("路径不能为空");
  const def = await loadModuleFromPath(p);
  registerDef(def, p);
  if (!Array.isArray(state.plugins)) state.plugins = [];
  // 避免同一路径重复添加
  if (state.plugins.some((x) => x.path === p)) throw new Error("该插件已添加");
  state.plugins.push({ id: def.id, title: def.title, path: p, enabled: true });
  saveState();
  notify();
  return def;
}

/// 移除插件（不随加载，直接注销并删除配置）
export function removePlugin(path) {
  const rec = (Array.isArray(state.plugins) ? state.plugins : []).find((x) => x.path === path);
  if (rec) unregister(rec.id);
  state.plugins = (Array.isArray(state.plugins) ? state.plugins : []).filter((x) => x.path !== path);
  saveState();
  notify();
}

/// 已加载插件清单（供设置页展示）
export function getPlugins() {
  return (Array.isArray(state.plugins) ? state.plugins : []).map((p) => ({
    ...p,
    loaded: loaded.has(p.id),
  }));
}