// 工作模式控制器 — 上下文感知显隐(对齐文档 §5.2 / v2.0 工作模式)。
// 切换模式时按 MODES 配置决定面板集合，并广播 mode-changed 供概览面板更新。
import { MODES, MODE_ORDER } from "./config.js";
import { Bus } from "./bus.js";

export const Workspaces = {
  init({ panelManager, badgeEl, getClosedIds, onMode }) {
    this.pm = panelManager;
    this.badgeEl = badgeEl;
    this.getClosedIds = getClosedIds;
    this.onMode = onMode;
    this.current = "coding";

    this.badgeEl.addEventListener("click", () => this.cycle());
    this.badgeEl.title = "点击切换工作模式";
  },

  // 提供给指令条的模式切换命令
  modeCommands() {
    return MODE_ORDER.map((key) => ({
      id: "mode-" + key,
      icon: "🎯",
      title: "切换模式：" + MODES[key].label,
      sub: MODES[key].desc,
      keywords: "mode 模式 " + key + " " + MODES[key].label,
      run: () => this.switchMode(key),
    }));
  },

  switchMode(key) {
    if (!MODES[key]) return;
    this.current = key;
    const m = MODES[key];
    const visible = m.visible;
    const closed = this.getClosedIds();
    this.pm.applyMode(key, visible, closed);

    this.badgeEl.innerHTML = `<span class="mb-dot" style="background:${m.dot}"></span>${m.label}`;
    Bus.emit("mode-changed", { key, label: m.label });
    this.onMode?.(key);
    Bus.emit("cmd:workspace-switch", { id: key });
  },

  cycle() {
    const i = MODE_ORDER.indexOf(this.current);
    this.switchMode(MODE_ORDER[(i + 1) % MODE_ORDER.length]);
  },
};
