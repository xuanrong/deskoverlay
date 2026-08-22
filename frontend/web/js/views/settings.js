// 系统设置视图：面向应用偏好设置 + 插件管理 + 隐私锁定 + 关于信息。持久化到 state.settings / state.lock / state.plugins。
import { state, saveState } from "../state.js";
import { invoke } from "../bus.js";
import { esc, showDialog } from "./common.js";
import { getPlugins, addPlugin, removePlugin } from "../plugins.js";

export function renderSettings(view) {
  view.header.style.display = "none";
  const body = view.body;
  renderBody();

  function renderBody() {
    const plugins = getPlugins();
    body.innerHTML = `
      <div class="set-panel">
        <div class="set-group-title">通用</div>
        <div class="set-row">
          <div class="set-info">
            <div class="set-name">记住上次所在模块</div>
            <div class="set-desc">每次启动时回到上次浏览的模块；关闭则始终从「今日概览」开始</div>
          </div>
          <label class="set-toggle"><input type="checkbox" id="set-remember" ${state.settings?.rememberModule ? "checked" : ""} /><span></span></label>
        </div>
      </div>

      <div class="set-panel">
        <div class="set-group-title">插件</div>
        <div class="set-desc" style="padding:4px 0">通过 .zip 插件包扩展工作台模块（内含前端与后端源码/预编译 wasm），插件不内置于应用。</div>
        ${
          plugins.length
            ? plugins.map((p) => `
                <div class="set-row">
                  <div class="set-info">
                    <div class="set-name">${esc(p.title || p.id || "未命名")}${p.loaded ? "" : " <span style='color:var(--danger);font-size:11px'>（加载失败）</span>"}</div>
                    <div class="set-desc" style="word-break:break-all">${esc(p.path)}</div>
                  </div>
                  <div class="set-input">
                    <button class="btn-ghost plugin-rm" data-path="${esc(p.path)}">移除</button>
                  </div>
                </div>`).join("")
            : `<div class="dash-empty">暂无插件</div>`
        }
        <div class="set-row">
          <div class="set-info"><div class="set-name">添加插件</div><div class="set-desc">选择 .zip 插件包（含前端 + backend 源码/预编译 wasm，自动注册/加载并运行）</div></div>
          <button class="btn-primary" id="set-plugin-add">选择插件包(zip)</button>
        </div>
      </div>

      <div class="set-panel">
        <div class="set-group-title">隐私</div>
        <div class="set-row">
          <div class="set-info">
            <div class="set-name">离开后自动锁定</div>
            <div class="set-desc">离开电脑一段时间后弹出全屏遮罩，防止他人偷看</div>
          </div>
          <label class="set-toggle"><input type="checkbox" id="set-lock" ${state.lock?.enabled ? "checked" : ""} /><span></span></label>
        </div>
        <div class="set-row">
          <div class="set-info">
            <div class="set-name">自动锁定等待时间</div>
            <div class="set-desc">多少分钟后触发锁定（1–120 分钟）</div>
          </div>
          <div class="set-input">
            <input type="number" id="set-lock-min" min="1" max="120" step="1" value="${state.lock?.minutes ?? 5}" />
            <span class="set-unit">分钟</span>
          </div>
        </div>
      </div>

      <div class="set-panel">
        <div class="set-group-title">关于</div>
        <div class="set-row">
          <div class="set-info"><div class="set-name">DeskOverlay</div><div class="set-desc">Windows 桌面工作台 · 数据本地持久化</div></div>
          <div class="set-value">v0.3.0</div>
        </div>
      </div>`;

    body.querySelector("#set-remember").addEventListener("change", (e) => {
      if (!state.settings) state.settings = {};
      state.settings.rememberModule = e.target.checked;
      saveState();
    });
    body.querySelector("#set-lock").addEventListener("change", (e) => {
      if (!state.lock) state.lock = {};
      state.lock.enabled = e.target.checked;
      saveState();
    });
    body.querySelector("#set-lock-min").addEventListener("change", (e) => {
      if (!state.lock) state.lock = {};
      state.lock.minutes = Math.max(1, Math.min(120, Math.round(+e.target.value) || 5));
      e.target.value = state.lock.minutes;
      saveState();
    });
    body.querySelector("#set-plugin-add").addEventListener("click", async () => {
      let path = null;
      try {
        const picked = await invoke("plugin:dialog|open", {
          options: { multiple: false, title: "选择插件包", filters: [{ name: "插件包", extensions: ["zip"] }] },
        }).catch(() => null);
        path = typeof picked === "string" && picked ? picked : null;
      } catch (_) { path = null; }
      if (!path) return; // 取消选择
      await importPluginZip(path);
    });

    // 移除插件
    body.querySelectorAll(".plugin-rm").forEach((btn) => {
      btn.addEventListener("click", () => {
        removePlugin(btn.dataset.path);
        renderBody();
      });
    });

    // 导入并自动运行 zip 插件包（解压 → 注册前端 → 自动编译并运行后端）
    async function importPluginZip(zipPath) {
      let man;
      try {
        man = await invoke("install_plugin_package", { zipPath });
      } catch (e) {
        showDialog({ title: "导入失败", message: String(e && e.message || e), okText: "知道了", showCancel: false });
        return;
      }
      const lines = [`已导入：${(man && (man.title || man.id)) || "插件"}`];
      if (man && man.frontend) {
        try { await addPlugin(man.frontend); lines.push("前端模块已注册 → 侧边栏可见"); }
        catch (e) { lines.push("前端注册失败：" + (e && e.message || e)); }
      }
      // 后端：优先用 zip 自带 .wasm；否则用本机 cargo 自动编译后执行一次
      let wasm = man && man.backend_wasm ? man.backend_wasm : null;
      if (!wasm && man && man.backend_dir) {
        try {
          wasm = await invoke("build_wasm_backend", { backendDir: man.backend_dir });
          lines.push("（后端由本机 cargo 自动编译）");
        } catch (e) {
          lines.push("后端编译失败：" + (e && e.message || e));
        }
      }
      if (wasm) {
        try {
          const out = await invoke("run_wasm_backend", { path: wasm, input: "hello" });
          lines.push(`后端执行结果：${out}`);
        } catch (e) {
          lines.push("后端执行失败：" + (e && e.message || e));
        }
      }
      showDialog({ title: "导入结果", message: lines.join("\n"), okText: "知道了", showCancel: false });
      renderBody();
    }
  }
}