// 面板引擎 — 标题栏拖动 / 缩放手柄 / 折叠(折叠为标题栏) / 锁定 / 关闭 / 边缘吸附 / z-order。
import { PANEL_RENDERERS } from "./panels.js";
import { Bus } from "./bus.js";

const SNAP = 22;        // 边缘吸附阈值
const MIN_W = 220, MIN_H = 96;

export class PanelManager {
  constructor(workspace, ctx) {
    this.workspace = workspace;
    this.ctx = ctx;                 // { onLayoutChange(layout), getMode() }
    this.panels = new Map();
    this.maxZ = 10;
    this._layoutTimer = null;
  }

  add(def) {
    if (this.panels.has(def.id)) return;
    const panel = new Panel(def, this);
    this.panels.set(def.id, panel);
    this.workspace.appendChild(panel.el);
    const render = PANEL_RENDERERS[def.type];
    if (render) render(panel);
    this.bringToFront(panel);
    this.ctx.onPanelAdded?.(def.id);
    this._scheduleLayoutSave();
    return panel;
  }

  remove(id) {
    const p = this.panels.get(id);
    if (!p) return;
    p.destroy();
    this.panels.delete(id);
    this.ctx.onPanelRemoved?.(id);
    this._scheduleLayoutSave();
  }

  get(id) { return this.panels.get(id); }

  bringToFront(panel) {
    this.maxZ += 1;
    panel.el.style.zIndex = this.maxZ;
    this.panels.forEach((p) => p.el.classList.remove("active-panel"));
    panel.el.classList.add("active-panel");
  }

  // 模式驱动显隐(对齐文档 §5.2 上下文智能显隐)
  applyMode(modeKey, visibleIds, closedIds) {
    this.panels.forEach((p, id) => {
      const visible = visibleIds.includes(id) && !closedIds.includes(id);
      p.el.style.display = visible ? "flex" : "none";
    });
  }

  // 收集当前几何，供持久化
  collectLayout() {
    const out = [];
    this.panels.forEach((p, id) => {
      out.push({ id, type: p.def.type, title: p.def.title, pro: p.def.pro,
        x: p.x, y: p.y, w: p.w, h: p.h, z: +p.el.style.zIndex || p.def.z,
        collapsed: p.collapsed, locked: p.locked });
    });
    return out;
  }

  _scheduleLayoutSave() {
    clearTimeout(this._layoutTimer);
    this._layoutTimer = setTimeout(() => {
      this.ctx.onLayoutChange?.(this.collectLayout());
    }, 250);
  }
}

export class Panel {
  constructor(def, manager) {
    this.def = def;
    this.manager = manager;
    this.id = def.id;
    this.x = def.x; this.y = def.y; this.w = def.w; this.h = def.h;
    this.collapsed = !!def.collapsed;
    this.locked = !!def.locked;
    this._destroyers = [];

    const el = document.createElement("div");
    el.className = "panel" + (def.pro ? " pro" : "") + (this.collapsed ? " collapsed" : "") + (this.locked ? " locked" : "");
    el.style.left = this.x + "px";
    el.style.top = this.y + "px";
    el.style.width = this.w + "px";
    el.style.height = this.h + "px";

    el.innerHTML = `
      <div class="p-header">
        <div class="p-title"><span class="dot"></span><span class="p-title-text">${def.title}</span></div>
        <div class="p-actions">
          <button class="p-btn btn-collapse" title="折叠">－</button>
          <button class="p-btn btn-lock" title="锁定">${this.locked ? "🔒" : "🔓"}</button>
          <button class="p-btn close" title="关闭">✕</button>
        </div>
      </div>
      <div class="p-body"></div>
      <div class="resize-handle"></div>`;

    this.el = el;
    this.body = el.querySelector(".p-body");
    this.header = el.querySelector(".p-header");

    el.querySelector(".btn-collapse").addEventListener("click", (e) => { e.stopPropagation(); this.toggleCollapse(); });
    el.querySelector(".btn-lock").addEventListener("click", (e) => { e.stopPropagation(); this.toggleLock(); });
    el.querySelector(".close").addEventListener("click", (e) => { e.stopPropagation(); this.manager.remove(this.id); });

    this._bindDrag();
    this._bindResize();
    el.addEventListener("pointerdown", () => this.manager.bringToFront(this), true);
  }

  toggleCollapse() {
    this.collapsed = !this.collapsed;
    this.el.classList.toggle("collapsed", this.collapsed);
    this.el.querySelector(".btn-collapse").textContent = this.collapsed ? "□" : "－";
    this.manager._scheduleLayoutSave();
  }

  toggleLock() {
    this.locked = !this.locked;
    this.el.classList.toggle("locked", this.locked);
    this.el.querySelector(".btn-lock").textContent = this.locked ? "🔒" : "🔓";
    this.manager._scheduleLayoutSave();
  }

  onDestroy(fn) { this._destroyers.push(fn); }

  destroy() {
    this._destroyers.forEach((f) => { try { f(); } catch (e) {} });
    this.el.remove();
  }

  _reportRect() {
    // 命中矩形上报(对接 Rust 选择性穿透)
    Bus.emit("cmd:report-panel-rect", { id: this.id, x: this.x, y: this.y, w: this.w, h: this.h });
  }

  _bindDrag() {
    let sx, sy, ox, oy, dragging = false;
    const header = this.header;
    header.addEventListener("pointerdown", (e) => {
      if (this.locked || e.target.closest(".p-btn")) return;
      dragging = true;
      sx = e.clientX; sy = e.clientY; ox = this.x; oy = this.y;
      this.el.classList.add("dragging");
      header.setPointerCapture(e.pointerId);
    });
    header.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      let nx = ox + (e.clientX - sx);
      let ny = oy + (e.clientY - sy);
      this.x = nx; this.y = ny;
      this.el.style.left = nx + "px";
      this.el.style.top = ny + "px";
    });
    const end = (e) => {
      if (!dragging) return;
      dragging = false;
      this.el.classList.remove("dragging");
      this._snap();
      this._reportRect();
      this.manager._scheduleLayoutSave();
    };
    header.addEventListener("pointerup", end);
    header.addEventListener("pointercancel", end);
  }

  _snap() {
    const W = window.innerWidth, H = window.innerHeight;
    if (this.x < SNAP) this.x = SNAP;
    if (this.y < SNAP) this.y = SNAP;
    if (this.x + this.w > W - SNAP) this.x = Math.max(SNAP, W - this.w - SNAP);
    if (this.y + this.h > H - SNAP) this.y = Math.max(SNAP, H - this.h - SNAP);
    this.el.style.left = this.x + "px";
    this.el.style.top = this.y + "px";
  }

  _bindResize() {
    const handle = this.el.querySelector(".resize-handle");
    let sx, sy, ow, oh, resizing = false;
    handle.addEventListener("pointerdown", (e) => {
      if (this.locked) return;
      e.stopPropagation();
      resizing = true;
      sx = e.clientX; sy = e.clientY; ow = this.w; oh = this.h;
      handle.setPointerCapture(e.pointerId);
    });
    handle.addEventListener("pointermove", (e) => {
      if (!resizing) return;
      this.w = Math.max(MIN_W, ow + (e.clientX - sx));
      this.h = Math.max(MIN_H, oh + (e.clientY - sy));
      this.el.style.width = this.w + "px";
      this.el.style.height = this.h + "px";
    });
    const end = () => {
      if (!resizing) return;
      resizing = false;
      this._reportRect();
      this.manager._scheduleLayoutSave();
    };
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  }
}
