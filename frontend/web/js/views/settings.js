// 系统设置视图：面向应用偏好设置 + 隐私锁定 + 关于信息。持久化到 state.settings / state.lock。
import { state, saveState } from "../state.js";

export function renderSettings(view) {
  view.header.style.display = "none";
  const body = view.body;
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
}