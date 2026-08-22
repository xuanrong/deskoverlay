// 快速指令条 — 对齐文档 §8.4 Spotlight 风格，目标响应 <300ms。
// 支持: 切换工作模式 / 新增面板 / 添加任务 / 启动应用 / 搜索。
import { ICON_CHECK } from "./icons.js";

export const CommandBar = {
  init({ barEl, inputEl, resultsEl, commands, onClose }) {
    this.barEl = barEl;
    this.inputEl = inputEl;
    this.resultsEl = resultsEl;
    this.commands = commands;
    this.onClose = onClose;
    this.active = 0;
    this.filtered = [];

    inputEl.addEventListener("input", () => this._render());
    inputEl.addEventListener("keydown", (e) => this._onKey(e));
    barEl.addEventListener("pointerdown", (e) => { if (e.target === barEl) this.close(); });
  },

  open(prefill = "") {
    this.barEl.hidden = false;
    requestAnimationFrame(() => {
      this.barEl.classList.add("open");
      this.inputEl.value = prefill;
      this.inputEl.focus();
      this._render();
    });
  },

  close() {
    this.barEl.classList.remove("open");
    this.onClose?.();
    setTimeout(() => { this.barEl.hidden = true; }, 180);
  },

  toggle(prefill) {
    if (!this.barEl.hidden && this.barEl.classList.contains("open")) this.close();
    else this.open(prefill);
  },

  _onKey(e) {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); this.close(); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); this._move(1); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); this._move(-1); return; }
    if (e.key === "Enter") {
      e.preventDefault();
      const cmd = this.filtered[this.active];
      if (cmd) this._run(cmd);
    }
  },

  _move(d) {
    if (!this.filtered.length) return;
    this.active = (this.active + d + this.filtered.length) % this.filtered.length;
    this._render();
  },

  _render() {
    const q = this.inputEl.value.trim().toLowerCase();
    let list = this.commands;

    // 任务快捷语法: ">xxx" 或 "任务 xxx" 置顶为「添加任务」
    const taskMatch = q.startsWith(">") ? q.slice(1).trim()
      : (q.startsWith("任务 ") ? q.slice(3).trim() : null);
    const extra = [];
    if (taskMatch) {
      extra.push({
        icon: ICON_CHECK, title: `添加任务：${taskMatch}`,
        sub: "回车创建到开发者任务面板", keywords: "task add 任务",
        run: () => this.commands.find((c) => c.id === "add-task")?.run(taskMatch),
      });
    }

    if (q && !taskMatch) {
      list = list.filter((c) =>
        (c.title + " " + (c.keywords || "") + " " + (c.sub || "")).toLowerCase().includes(q));
    }
    this.filtered = [...extra, ...list];
    if (this.active >= this.filtered.length) this.active = 0;

    if (!this.filtered.length) {
      this.resultsEl.innerHTML = `<div class="cb-empty">无匹配指令</div>`;
      return;
    }
    this.resultsEl.innerHTML = this.filtered.map((c, i) => `
      <li class="cb-item ${i === this.active ? "active" : ""}" data-i="${i}">
        <span class="ci-icon">${c.icon || "•"}</span>
        <span class="ci-main">${c.title}${c.sub ? `<div class="ci-sub">${c.sub}</div>` : ""}</span>
        ${c.key ? `<span class="ci-key">${c.key}</span>` : ""}
      </li>`).join("");

    this.resultsEl.querySelectorAll(".cb-item").forEach((li) => {
      li.addEventListener("click", () => this._run(this.filtered[+li.dataset.i]));
      li.addEventListener("mousemove", () => {
        this.active = +li.dataset.i; this._render();
      });
    });
  },

  _run(cmd) {
    try { cmd.run?.(); } catch (e) { console.error("[cmd]", e); }
    this.close();
  },
};
