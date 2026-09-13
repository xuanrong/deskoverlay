// 系统设置视图：面向应用偏好设置 + 插件管理 + 隐私锁定 + 备份恢复 + 关于信息。持久化到 state.settings / state.lock / state.plugins。
import { state, saveState, loadState } from "../state.js";
import { invoke } from "../bus.js";
import { esc, showDialog } from "./common.js";
import { getPlugins, addPlugin, removePlugin } from "../plugins.js";
import { pushLockEnabled } from "../lock.js";

export function renderSettings(view) {
  view.header.style.display = "none";
  const body = view.body;
  renderBody();

  function renderBody() {
    const plugins = getPlugins();
    body.innerHTML = `
      <div class="set-panel">
        <div class="sec-title">通用</div>
        <div class="set-row">
          <div class="set-info">
            <div class="set-name">记住上次所在模块</div>
            <div class="set-desc">每次启动时回到上次浏览的模块；关闭则始终从「今日概览」开始</div>
          </div>
          <label class="set-toggle"><input type="checkbox" id="set-remember" ${state.settings?.rememberModule ? "checked" : ""} /><span></span></label>
        </div>
      </div>

      <div class="set-panel">
        <div class="sec-title">插件</div>
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
        <div class="sec-title">隐私</div>
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
        <div class="set-row">
          <div class="set-info">
            <div class="set-name">检测媒体播放</div>
            <div class="set-desc">测试当前是否有视频/音乐在播放（与“播放时不锁屏”同一判定逻辑）</div>
          </div>
          <button class="btn-ghost" id="set-media-test">测试</button>
        </div>
      </div>

      <div class="set-panel">
        <div class="sec-title">备份与恢复</div>
        <div class="set-row">
          <div class="set-info">
            <div class="set-name">导出备份</div>
            <div class="set-desc">将所有数据（笔记、工作记录、灵感碎片、任务、设置等）打包为 zip 文件</div>
          </div>
          <button class="btn-primary" id="set-backup">导出备份</button>
        </div>
        <div class="set-row">
          <div class="set-info">
            <div class="set-name">恢复备份</div>
            <div class="set-desc">从 zip 备份文件恢复数据，当前数据将被覆盖</div>
          </div>
          <button class="btn-ghost" id="set-restore">选择备份文件</button>
        </div>
      </div>

      <div class="set-panel">
        <div class="sec-title">关于</div>
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
      // 同步后端监控开关：关闭时降频轮询，开启时恢复每秒空闲推送
      pushLockEnabled();
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

    // 测试媒体播放检测
    const mediaBtn = body.querySelector("#set-media-test");
    if (mediaBtn) {
      mediaBtn.addEventListener("click", async () => {
        mediaBtn.textContent = "检测中…";
        mediaBtn.disabled = true;
        try {
          const playing = await invoke("check_media_playing").catch((e) => { console.error(e); return null; });
          if (playing === null) {
            showDialog({ title: "检测失败", message: "无法读取音频会话（可能是系统/权限问题）" });
          } else {
            showDialog({
              title: "检测结果",
              message: playing ? "✅ 检测到当前有视频/音乐在播放（不会锁屏）" : "未检测到正在播放的媒体（空闲时才会触发锁定）",
            });
          }
        } finally {
          mediaBtn.textContent = "测试";
          mediaBtn.disabled = false;
        }
      });
    }

    // 备份
    const backupBtn = body.querySelector("#set-backup");
    if (backupBtn) {
      backupBtn.addEventListener("click", async () => {
        backupBtn.textContent = "导出中…";
        backupBtn.disabled = true;
        try {
          let savePath = null;
          try {
            savePath = await invoke("plugin:dialog|save", {
              options: {
                title: "选择备份保存位置",
                defaultPath: `deskoverlay-backup-${new Date().toISOString().slice(0, 10)}.zip`,
                filters: [{ name: "备份文件", extensions: ["zip"] }],
              },
            });
          } catch (_) { savePath = null; }
          if (!savePath || (typeof savePath !== "string")) { backupBtn.textContent = "导出备份"; backupBtn.disabled = false; return; }
          await invoke("backup_data", { zipPath: savePath });
          showDialog({ title: "备份完成", message: `数据已导出到：\n${savePath}`, okText: "知道了", showCancel: false });
        } catch (e) {
          showDialog({ title: "备份失败", message: String(e && e.message || e), okText: "知道了", showCancel: false });
        } finally {
          backupBtn.textContent = "导出备份";
          backupBtn.disabled = false;
        }
      });
    }

    // 恢复
    const restoreBtn = body.querySelector("#set-restore");
    if (restoreBtn) {
      restoreBtn.addEventListener("click", async () => {
        let zipPath = null;
        try {
          const picked = await invoke("plugin:dialog|open", {
            options: { multiple: false, title: "选择备份文件", filters: [{ name: "备份文件", extensions: ["zip"] }] },
          }).catch(() => null);
          zipPath = typeof picked === "string" && picked ? picked : null;
        } catch (_) { zipPath = null; }
        if (!zipPath) return;

        const confirmed = await showDialog({
            title: "确认恢复",
            message: "恢复将覆盖当前所有数据，且无法撤销。\n确定继续吗？",
            okText: "确认恢复",
            cancelText: "取消",
            danger: true,
          });
        if (!confirmed) return;

        restoreBtn.textContent = "恢复中…";
        restoreBtn.disabled = true;
        try {
          await invoke("restore_data", { zipPath });
          // 重新加载状态
          await loadState();
          await showDialog({ title: "恢复完成", message: "数据已恢复，即将刷新页面以应用更改。", okText: "刷新", showCancel: false });
          location.reload();
        } catch (e) {
          showDialog({ title: "恢复失败", message: String(e && e.message || e), okText: "知道了", showCancel: false });
        } finally {
          restoreBtn.textContent = "选择备份文件";
          restoreBtn.disabled = false;
        }
      });
    }

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