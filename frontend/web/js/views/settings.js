// 系统设置视图：面向应用偏好设置 + 外观主题 + 插件管理 + 隐私锁定 + 备份恢复 + 关于信息。持久化到 state.settings / state.theme / state.lock / state.plugins。
import { state, saveState, loadState } from "../state.js";
import { invoke } from "../bus.js";
import { esc, showDialog } from "./common.js";
import { getPlugins, addPlugin, removePlugin } from "../plugins.js";
import { pushLockEnabled } from "../lock.js";
import { Theme, ACCENT_PRESETS, BUILTIN_SKINS, computeAccent } from "../theme.js";
import { toast } from "../toast.js";

// hex(#rrggbb) → [h, s, l]（s/l 0-100），供自定义主题色取色器使用
function hexToHsl(hex) {
  const m = hex.replace("#", "");
  const r = parseInt(m.slice(0, 2), 16) / 255, g = parseInt(m.slice(2, 4), 16) / 255, b = parseInt(m.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h = Math.round(h * 60); if (h < 0) h += 360;
  }
  const l = (max + min) / 2;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  return [h, Math.round(s * 100), Math.round(l * 100)];
}

export function renderSettings(view) {
  view.header.style.display = "none";
  const body = view.body;
  renderBody();

  function renderBody() {
    // ---- 外观分区辅助 ----
    const t = Theme.get();
    function skinPreviewBg(s) {
      const c = s.config;
      if (c.background?.type === "gradient") {
        return `linear-gradient(${c.background.gradient.angle}deg, ${c.background.gradient.from}, ${c.background.gradient.to})`;
      }
      return c.scheme === "light" ? "linear-gradient(160deg,#e9edf5,#dfe8f3)" : "linear-gradient(160deg,#0a0e15,#101826)";
    }
    function skinPreviewAccent(s) {
      const a = s.config.accent;
      // 与实际应用一致：经方案感知亮度钳制后的 accent
      return computeAccent(a.hsl, s.config.scheme).accent;
    }
    function hslToHex([h, s, l]) {
      s /= 100; l /= 100;
      const k = (n) => (n + h / 30) % 12;
      const a = s * Math.min(l, 1 - l);
      const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
      return "#" + [f(0), f(8), f(4)].map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("");
    }
    function currentAccentHex() { return hslToHex(t.accent.hsl); }
    function bgExtraHtml() {
      const b = t.background;
      if (b.type === "image") {
        return `
          <div class="set-row" style="padding:4px 0">
            <div class="set-info"><div class="set-desc" style="word-break:break-all">${b.imageRef ? esc(b.imageRef) : "未选择图片"}</div></div>
            <div class="set-input"><button class="btn-primary" id="th-bg-pick">选择图片</button></div>
          </div>
          <div class="set-row" style="padding:4px 0">
            <div class="th-range"><span style="font-size:var(--text-xs);color:var(--text-dim);min-width:64px">显示模式</span>
              <select id="th-bg-fit" class="set-select">
                <option value="cover" ${b.fit === "cover" ? "selected" : ""}>填充裁切</option>
                <option value="contain" ${b.fit === "contain" ? "selected" : ""}>完整显示</option>
                <option value="fill" ${b.fit === "fill" ? "selected" : ""}>拉伸</option>
              </select>
            </div>
          </div>
          <div class="set-row" style="padding:4px 0">
            <div class="th-range"><span style="font-size:var(--text-xs);color:var(--text-dim);min-width:64px">暗化遮罩</span>
              <input type="range" id="th-bg-dim" min="0" max="85" step="5" value="${Math.round(b.dim * 100)}" />
              <span class="th-range-val" id="th-bg-dim-val">${Math.round(b.dim * 100)}%</span>
            </div>
          </div>`;
      }
      if (b.type === "color") {
        return `<div class="set-row" style="padding:4px 0">
          <div class="th-range"><span style="font-size:var(--text-xs);color:var(--text-dim);min-width:64px">背景色</span>
            <input type="color" id="th-bg-color" value="${esc(b.color)}" />
          </div></div>`;
      }
      if (b.type === "gradient") {
        return `<div class="set-row" style="padding:4px 0">
          <div class="th-range"><span style="font-size:var(--text-xs);color:var(--text-dim);min-width:64px">起止色</span>
            <input type="color" id="th-bg-gfrom" value="${esc(b.gradient.from)}" />
            <input type="color" id="th-bg-gto" value="${esc(b.gradient.to)}" />
            <span style="font-size:var(--text-xs);color:var(--text-dim);margin-left:8px">角度</span>
            <input type="number" id="th-bg-gangle" min="0" max="360" step="10" value="${Math.round(b.gradient.angle)}" style="width:56px" class="set-select" />
          </div></div>`;
      }
      return `<div class="set-desc">使用内置桌面渐变背景</div>`;
    }

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
        <div class="set-row">
          <div class="set-info">
            <div class="set-name">开机自动启动</div>
            <div class="set-desc">随 Windows 登录静默启动；可在任务管理器 → 启动应用中管理</div>
          </div>
          <label class="set-toggle"><input type="checkbox" id="set-autostart" /><span></span></label>
        </div>
      </div>

      <div class="set-panel">
        <div class="sec-title">外观</div>
        <div class="set-row">
          <div class="set-info">
            <div class="set-name">主题方案</div>
            <div class="set-desc">深色 / 浅色玻璃；「跟随系统」随 Windows 深浅色自动切换</div>
          </div>
          <div class="seg-group" id="th-scheme">
            <button data-v="dark" class="${t.scheme === "dark" ? "active" : ""}">深色</button>
            <button data-v="light" class="${t.scheme === "light" ? "active" : ""}">浅色</button>
            <button data-v="auto" class="${t.scheme === "auto" ? "active" : ""}">跟随系统</button>
          </div>
        </div>

        <div class="set-row" style="flex-direction:column;align-items:stretch">
          <div class="set-info"><div class="set-name">皮肤</div><div class="set-desc">一键应用整套视觉（方案 + 主题色 + 背景 + 玻璃质感）</div></div>
          <div class="th-skins" id="th-skins">
            ${BUILTIN_SKINS.map((s) => `
              <div class="th-skin${t.skinId === s.id ? " active" : ""}" data-id="${s.id}" title="${esc(s.name)}">
                <div class="ts-preview" style="background:${skinPreviewBg(s)}">
                  <span class="ts-dot" style="background:${skinPreviewAccent(s)}"></span>
                </div>
                <div class="ts-name"><span>${esc(s.name)}</span><span class="ts-check">✓</span></div>
              </div>`).join("")}
          </div>
        </div>

        <div class="set-row" style="flex-direction:column;align-items:stretch">
          <div class="set-info"><div class="set-name">主题色</div><div class="set-desc">主强调色（激活 / 链接 / 按钮），实时预览</div></div>
          <div class="th-swatches" id="th-swatches">
            ${ACCENT_PRESETS.map((p) => {
              const active = t.accent.mode === "preset" && t.accent.presetId === p.id;
              return `<div class="th-swatch${active ? " active" : ""}" data-id="${p.id}" title="${p.name}" style="background:hsl(${p.hsl[0]},${p.hsl[1]}%,${p.hsl[2]}%)"></div>`;
            }).join("")}
            <input type="color" class="th-swatch-custom" id="th-accent-custom" title="自定义" value="${currentAccentHex()}" />
          </div>
          <div class="th-preview">
            <button class="tp-btn" tabindex="-1">按钮</button>
            <span class="tp-link" tabindex="-1">链接文字</span>
            <span class="tp-chip" tabindex="-1">高亮标签</span>
          </div>
        </div>

        <div class="set-row" style="flex-direction:column;align-items:stretch">
          <div class="set-info"><div class="set-name">背景</div><div class="set-desc">工作台画布背景：图片 / 纯色 / 渐变（自带暗化遮罩保证可读性）</div></div>
          <div class="seg-group" id="th-bg-type">
            <button data-v="none" class="${t.background.type === "none" ? "active" : ""}">默认</button>
            <button data-v="image" class="${t.background.type === "image" ? "active" : ""}">图片</button>
            <button data-v="color" class="${t.background.type === "color" ? "active" : ""}">纯色</button>
            <button data-v="gradient" class="${t.background.type === "gradient" ? "active" : ""}">渐变</button>
          </div>
          <div id="th-bg-extra" style="margin-top:8px">
            ${bgExtraHtml()}
          </div>
        </div>

        <div class="set-row" style="flex-direction:column;align-items:stretch">
          <div class="set-info"><div class="set-name">玻璃质感</div><div class="set-desc">面板透明度与模糊强度（0% = 关闭模糊，更省 GPU；拖动实时预览，松手保存）</div></div>
          <div class="set-row" style="padding:4px 0">
            <div class="th-range"><span style="font-size:var(--text-xs);color:var(--text-dim);min-width:64px">面板透明度</span>
              <input type="range" id="th-alpha" min="40" max="95" step="1" value="${Math.round(t.glass.panelAlpha * 100)}" />
              <span class="th-range-val" id="th-alpha-val">${Math.round(t.glass.panelAlpha * 100)}%</span>
            </div>
          </div>
          <div class="set-row" style="padding:4px 0">
            <div class="th-range"><span style="font-size:var(--text-xs);color:var(--text-dim);min-width:64px">模糊强度</span>
              <input type="range" id="th-blur" min="0" max="150" step="5" value="${Math.round(t.glass.blurMult * 100)}" />
              <span class="th-range-val" id="th-blur-val">${Math.round(t.glass.blurMult * 100)}%</span>
            </div>
          </div>
        </div>

        <div class="set-row">
          <div class="set-info">
            <div class="set-name">恢复默认外观</div>
            <div class="set-desc">重置为「午夜玻璃」默认深色主题</div>
          </div>
          <button class="btn-ghost" id="th-reset">重置</button>
        </div>
      </div>

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
        <div class="set-row">
          <div class="set-info">
            <div class="set-name">锁屏弹窗测试</div>
            <div class="set-desc">立即弹出全屏锁屏窗口预览效果，点击中央太阳即可解锁返回</div>
          </div>
          <button class="btn-ghost" id="set-lock-test">预览</button>
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
    // 开机自启：开关状态以注册表实态为准（autostart_status），不信任本地记忆，
    // 避免用户在任务管理器禁用启动项后 UI 与系统漂移。
    const autoChk = body.querySelector("#set-autostart");
    if (autoChk) {
      invoke("autostart_status").then((s) => {
        autoChk.checked = !!(s && s.enabled);
      }).catch(() => {});
      autoChk.addEventListener("change", async () => {
        const want = autoChk.checked;
        try {
          await invoke("set_autostart", { enabled: want });
          // 以回读的注册表实态回填，成功与否以实态为准
          const s = await invoke("autostart_status");
          autoChk.checked = !!(s && s.enabled);
          if (autoChk.checked === want) {
            if (!state.settings) state.settings = {};
            state.settings.autostart = want;
            if (!want) delete state.settings.autostart;
            saveState();
            toast(want ? "已注册开机自启" : "已取消开机自启");
          } else {
            toast("自启状态与系统不一致，请重试");
          }
        } catch (err) {
          autoChk.checked = !want;
          toast(typeof err === "string" ? err : "设置失败，请重试");
        }
      });
    }
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
        const picked = await invoke("plugin:dialog|open", {          options: { multiple: false, title: "选择插件包", filters: [{ name: "插件包", extensions: ["zip"] }] },
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

    // 锁屏弹窗测试：直接调 show_lock 弹出系统级全屏锁屏窗口。
    // 与空闲触发完全同链路（lock.js → show_lock 命令 → 后端建窗重试 → lock-init/lock-failed 事件），
    // 看到的就是真实锁屏效果；解锁走锁屏页中央太阳（hide_lock 销毁窗口），无需额外清理。
    const lockTestBtn = body.querySelector("#set-lock-test");
    if (lockTestBtn) {
      lockTestBtn.addEventListener("click", async () => {
        const confirmed = await showDialog({
          title: "预览锁屏弹窗",
          message: "将弹出全屏锁屏窗口，点击锁屏中央的太阳即可解锁返回设置页。",
          okText: "弹出",
        });
        if (!confirmed) return;
        try {
          await invoke("show_lock");
        } catch (e) {
          console.error("[settings] 锁屏预览失败", e);
          showDialog({ title: "预览失败", message: "锁屏窗口创建失败，请重试", showCancel: false });
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

    // -------------------- 外观分区事件 --------------------
    // 主题方案（分段控件）
    body.querySelectorAll("#th-scheme button").forEach((btn) => {
      btn.addEventListener("click", async () => {
        await Theme.setScheme(btn.dataset.v);
        body.querySelectorAll("#th-scheme button").forEach((b) => b.classList.toggle("active", b === btn));
      });
    });

    // 皮肤画廊
    body.querySelectorAll(".th-skin").forEach((card) => {
      card.addEventListener("click", async () => {
        await Theme.applySkin(card.dataset.id);
        renderBody();
      });
    });

    // 主题色：预设色点
    body.querySelectorAll(".th-swatch").forEach((dot) => {
      dot.addEventListener("click", async () => {
        const p = ACCENT_PRESETS.find((x) => x.id === dot.dataset.id);
        if (!p) return;
        await Theme.setAccent({ mode: "preset", presetId: p.id, hsl: [...p.hsl] });
        renderBody();
      });
    });
    // 主题色：自定义取色器（拖动实时预览，松手落盘）
    const accentCustom = body.querySelector("#th-accent-custom");
    if (accentCustom) {
      accentCustom.addEventListener("input", () => {
        const hsl = hexToHsl(accentCustom.value);
        Theme.setAccent({ mode: "custom", presetId: "custom", hsl }, { persist: false });
      });
      accentCustom.addEventListener("change", () => {
        const hsl = hexToHsl(accentCustom.value);
        Theme.setAccent({ mode: "custom", presetId: "custom", hsl });
      });
    }

    // 背景类型
    body.querySelectorAll("#th-bg-type button").forEach((btn) => {
      btn.addEventListener("click", async () => {
        await Theme.setBackground({ type: btn.dataset.v });
        renderBody();
      });
    });
    // 背景图片：选择 + 显示模式 + 暗化
    const bgPick = body.querySelector("#th-bg-pick");
    if (bgPick) {
      bgPick.addEventListener("click", async () => {
        let path = null;
        try {
          const picked = await invoke("plugin:dialog|open", {
            options: {
              multiple: false, title: "选择背景图片",
              filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp", "bmp"] }],
            },
          }).catch(() => null);
          path = typeof picked === "string" && picked ? picked : null;
        } catch (_) { path = null; }
        if (!path) return;
        await Theme.setBackground({ imageRef: path });
        renderBody();
      });
    }
    const bgFit = body.querySelector("#th-bg-fit");
    if (bgFit) bgFit.addEventListener("change", () => Theme.setBackground({ fit: bgFit.value }));
    const bgDim = body.querySelector("#th-bg-dim");
    if (bgDim) {
      const val = body.querySelector("#th-bg-dim-val");
      bgDim.addEventListener("input", () => {
        if (val) val.textContent = bgDim.value + "%";
        Theme.setBackground({ dim: (+bgDim.value) / 100 }, { persist: false });
      });
      bgDim.addEventListener("change", () => Theme.setBackground({ dim: (+bgDim.value) / 100 }));
    }
    // 背景纯色
    const bgColor = body.querySelector("#th-bg-color");
    if (bgColor) {
      bgColor.addEventListener("input", () => Theme.setBackground({ color: bgColor.value }, { persist: false }));
      bgColor.addEventListener("change", () => Theme.setBackground({ color: bgColor.value }));
    }
    // 背景渐变
    const gFrom = body.querySelector("#th-bg-gfrom"), gTo = body.querySelector("#th-bg-gto"), gAngle = body.querySelector("#th-bg-gangle");
    const pushGradient = (persist) => Theme.setBackground({
      gradient: {
        from: gFrom ? gFrom.value : t.background.gradient.from,
        to: gTo ? gTo.value : t.background.gradient.to,
        angle: gAngle ? Math.max(0, Math.min(360, Math.round(+gAngle.value) || 0)) : t.background.gradient.angle,
      },
    }, persist ? {} : { persist: false });
    if (gFrom) { gFrom.addEventListener("input", () => pushGradient(false)); gFrom.addEventListener("change", () => pushGradient(true)); }
    if (gTo) { gTo.addEventListener("input", () => pushGradient(false)); gTo.addEventListener("change", () => pushGradient(true)); }
    if (gAngle) gAngle.addEventListener("change", () => pushGradient(true));

    // 玻璃质感滑杆（input 实时预览，change 落盘）
    const alphaSlider = body.querySelector("#th-alpha"), alphaVal = body.querySelector("#th-alpha-val");
    if (alphaSlider) {
      alphaSlider.addEventListener("input", () => {
        if (alphaVal) alphaVal.textContent = alphaSlider.value + "%";
        Theme.setGlass({ panelAlpha: (+alphaSlider.value) / 100 }, { persist: false });
      });
      alphaSlider.addEventListener("change", () => Theme.setGlass({ panelAlpha: (+alphaSlider.value) / 100 }));
    }
    const blurSlider = body.querySelector("#th-blur"), blurVal = body.querySelector("#th-blur-val");
    if (blurSlider) {
      blurSlider.addEventListener("input", () => {
        if (blurVal) blurVal.textContent = blurSlider.value + "%";
        Theme.setGlass({ blurMult: (+blurSlider.value) / 100 }, { persist: false });
      });
      blurSlider.addEventListener("change", () => Theme.setGlass({ blurMult: (+blurSlider.value) / 100 }));
    }

    // 重置外观
    const resetBtn = body.querySelector("#th-reset");
    if (resetBtn) {
      resetBtn.addEventListener("click", async () => {
        await Theme.reset();
        renderBody();
      });
    }

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