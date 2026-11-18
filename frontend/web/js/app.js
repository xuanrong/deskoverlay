// DeskOverlay 前端工作台 — 启动装配。
// 范式：一屏卡片工作台（无侧边导航）——首页是 6 列卡片网格 + 底部任务栏，
//       点卡片打开对应模块的全屏浮层，模块内部仍是 views.js 里的完整视图。
// 状态：统一由 state.js 单例管理，Rust 侧 state.json 持久化。
import { MODULES } from "./config.js";
import { state, loadState, saveState } from "./state.js";
import { Bus, invoke } from "./bus.js";
import { Providers } from "./providers.js";
import { initPlayback } from "./views/music.js";
import { initReminders } from "./reminders.js";
import { initPomodoro } from "./pomodoro.js";
import { startLockController } from "./lock.js";
import { initEyeCare } from "./eyeCare.js";
import { initEyeCareCapsule } from "./eyeCareCapsule.js";
import { Theme } from "./theme.js";
import { toast } from "./toast.js";
import { pillFor, lunarText, lunarShort, getDayEvents, holidayOf, workdayOf, setLegalOverride, fetchLegalYear } from "./festivals.js";
import { initWorkspace, openModule, setQuietToast, toggleEditMode, toggleCardLibrary, addCard } from "./workspace.js";
import { esc, fmtMD } from "./utils.js";

// -------------------- 启动 Provider --------------------
Providers.startAll();

// -------------------- 主区域顶部时钟块（固定，所有模块之上） --------------------
const mcTime = document.getElementById("mc-time");
const mcDate = document.getElementById("mc-date");
const mcFest = document.getElementById("mc-fest");

// 节日/节气/假期药丸：仅当天信息变化时更新；点击弹出详情面板
// 启动时恢复用户自定义的法定假期覆盖层（state.settings.legalOverride），
// 让「更新节假日」粘贴的年度安排在重启后依然生效。
setLegalOverride(state.settings?.legalOverride || null);

function refreshFestival() {
  if (!mcFest) return;
  const p = pillFor(new Date());
  if (mcFest.dataset.key !== p.text) {
    mcFest.dataset.key = p.text;
    mcFest.textContent = p.text;
    mcFest.className = ("mc-fest " + (p.cls || "")).trim();
    mcFest.setAttribute("aria-label", p.tip || "");
    mcFest.hidden = !p.text;
  }
}

const WEEK_CN = "日一二三四五六";
let festPanelEl = null;
let festView = null; // 当前查看的月份（1 号）
function showFestivalPanel() {
  if (festPanelEl) { festPanelEl.remove(); festPanelEl = null; return; }
  const now = new Date();
  festView = new Date(now.getFullYear(), now.getMonth(), 1);
  const ov = document.createElement("div");
  ov.className = "task-modal-overlay";
  festPanelEl = ov;
  ov.innerHTML = `
    <div class="task-modal festival-modal">
      <h3 class="cal-head">
        <button class="cal-nav" id="cal-prev" aria-label="上个月">‹</button>
        <span id="cal-title"></span>
        <button class="cal-nav" id="cal-next" aria-label="下个月">›</button>
      </h3>
      <div class="cal-week">${["日", "一", "二", "三", "四", "五", "六"].map((w) => `<span>${w}</span>`).join("")}</div>
      <div class="cal-grid" id="cal-grid"></div>
      <div class="cal-legend">
        <span><i class="lg-dot lg-hol"></i>法定假期</span>
        <span><i class="lg-dot lg-work"></i>调休补班</span>
        <span><i class="lg-dot lg-fest"></i>节日</span>
        <span><i class="lg-dot lg-term"></i>节气</span>
      </div>
      <div class="tm-actions">
        <button class="btn-ghost" id="cal-upd-hol">更新节假日</button>
        <button class="btn-primary cm-ok">关闭</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  const draw = () => {
    const y = festView.getFullYear(), m = festView.getMonth();
    ov.querySelector("#cal-title").textContent = `${y}年${m + 1}月`;
    const offset = new Date(y, m, 1).getDay(); // 周日=0（周日为一周之始）
    const days = new Date(y, m + 1, 0).getDate();
    let html = "";
    for (let i = 0; i < offset; i++) html += `<div class="cal-cell empty"></div>`;
    for (let d = 1; d <= days; d++) {      const dt = new Date(y, m, d);
      const hol = holidayOf(dt);
      const wd = workdayOf(dt);
      const evs = getDayEvents(dt).filter((e) => e.type === "festival" || e.type === "term");
      const isToday = dt.toDateString() === now.toDateString();
      // 小字：节日 > 节气 > 农历（农历只在初一显示月名且加粗，其余只显示日）
      let sub = lunarShort(dt), subCls = "lunar" + (sub.endsWith("月") ? " month" : "");
      const fest = evs.find((e) => e.type === "festival");
      if (fest) { sub = fest.name; subCls = "festival"; }
      else if (evs.length) { sub = evs[0].name; subCls = "term"; }
      const tips = [`${m + 1}月${d}日 周${WEEK_CN[dt.getDay()]} · 农历${lunarText(dt)}`];
      if (evs.length) tips.push(evs.map((e) => e.name).join("、"));
      if (hol) tips.push(`${hol.name}假期（${fmtMD(hol.start)} - ${fmtMD(hol.end)}，共${hol.days}天）`);
      if (wd) tips.push("调休补班日");
      html += `<div class="cal-cell${hol ? " holiday" : ""}${wd ? " workday" : ""}${isToday ? " today" : ""}" title="${tips.join(" · ")}">
        ${hol ? '<span class="cal-tag tag-hol">休</span>' : wd ? '<span class="cal-tag tag-work">班</span>' : ""}
        <span class="cal-day">${d}</span>
        <span class="cal-sub ${subCls}">${sub}</span>
      </div>`;
    }
    // 尾部补空格至 42 格（固定 6 行）：弹窗高度不随月份周数变化
    for (let i = offset + days; i < 42; i++) html += `<div class="cal-cell empty"></div>`;
    ov.querySelector("#cal-grid").innerHTML = html;
  };
  ov.querySelector("#cal-prev").addEventListener("click", () => { festView = new Date(festView.getFullYear(), festView.getMonth() - 1, 1); draw(); });
  ov.querySelector("#cal-next").addEventListener("click", () => { festView = new Date(festView.getFullYear(), festView.getMonth() + 1, 1); draw(); });
  ov.querySelector("#cal-upd-hol").addEventListener("click", () => openHolidayEditor(() => draw()));
  const close = () => { ov.remove(); festPanelEl = null; };
  ov.querySelector(".cm-ok").addEventListener("click", close);
  ov.addEventListener("click", (e) => { if (e.target === ov) close(); });
  ov.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
  draw();
}

// 更新节假日：弹出编辑框，联网拉取国务院年度安排（与内置 LEGAL 表同结构），
// 保存到 state.settings.legalOverride 并立即生效（setLegalOverride 清缓存重算）。
function openHolidayEditor(onSaved) {
  const cur = state.settings?.legalOverride || {};
  const ov = document.createElement("div");
  ov.className = "task-modal-overlay";
  const sampleYear = new Date().getFullYear() + 1;
  ov.innerHTML = `
    <div class="task-modal holiday-editor">
      <h3>更新法定节假日</h3>
      <div class="he-fetch">
        <span class="he-fetch-label">联网获取</span>
        <input type="number" id="he-year" min="2000" max="2100" value="${new Date().getFullYear() + 1}" />
        <button class="btn-primary he-fetch-btn" id="he-fetch">拉取</button>
        <span class="he-fetch-status" id="he-fetch-status">输入年份点「拉取」，自动填充下方 JSON，再保存</span>
      </div>
      <div class="he-tip">
        数据源 timor.tech（国务院年度安排，含调休补班）。拉取后可再手动微调下方 JSON，点保存生效（覆盖同年内置表；留空 <code>{}</code> = 用内置表）。
      </div>
      <textarea id="he-json" spellcheck="false" placeholder='点上方「拉取」自动填充；或手动粘贴：\n{\n  "${sampleYear}": [\n    { "name": "元旦", "start": [1,1], "end": [1,1], "workdays": [] }\n  ]\n}'>${esc(JSON.stringify(cur, null, 2))}</textarea>
      <div class="he-err" id="he-err"></div>
      <div class="tm-actions">
        <button class="btn-ghost he-clear">清空（用内置表）</button>
        <button class="btn-ghost he-cancel">取消</button>
        <button class="btn-primary he-save">保存</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  const ta = ov.querySelector("#he-json");
  const errEl = ov.querySelector("#he-err");
  const yearEl = ov.querySelector("#he-year");
  const fetchStatus = ov.querySelector("#he-fetch-status");
  const shut = () => ov.remove();
  // 联网获取：拉取 → 填充 JSON（不自动保存，让用户确认后再点保存）
  ov.querySelector("#he-fetch").addEventListener("click", async () => {
    const y = Math.round(+yearEl.value);
    if (!y) { errEl.textContent = "请输入有效年份。"; return; }
    const btn = ov.querySelector("#he-fetch");
    btn.disabled = true;
    fetchStatus.textContent = "拉取中…";
    errEl.textContent = "";
    try {
      const data = await fetchLegalYear(y);
      // 合并进当前 JSON（覆盖该年，保留其他年）
      let merged = {};
      try { merged = JSON.parse(ta.value) || {}; } catch (_) { merged = {}; }
      merged[y] = data[y];
      ta.value = JSON.stringify(merged, null, 2);
      const cnt = data[y].length;
      fetchStatus.textContent = `已获取 ${y} 年 ${cnt} 段假期，点「保存」生效`;
    } catch (e) {
      fetchStatus.textContent = "拉取失败";
      errEl.textContent = "联网失败：" + (typeof e === "string" ? e : e.message || String(e)) + "（可检查网络，或手动粘贴 JSON）";
    } finally {
      btn.disabled = false;
    }
  });
  ov.querySelector(".he-cancel").addEventListener("click", shut);
  ov.querySelector(".he-clear").addEventListener("click", () => {
    ta.value = "{}";
    errEl.textContent = "";
  });
  ov.querySelector(".he-save").addEventListener("click", () => {
    const txt = ta.value.trim();
    if (!txt) { errEl.textContent = "内容为空，请粘贴 JSON 或点「清空」。"; return; }
    let obj;
    try { obj = JSON.parse(txt); }
    catch (e) { errEl.textContent = "JSON 解析失败：" + e.message; return; }
    if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
      errEl.textContent = "顶层必须是对象 { 年份: [...] }。"; return;
    }
    // 轻校验：每个年份是数组，每项有 name/start/end
    for (const [y, list] of Object.entries(obj)) {
      if (!/^\d{4}$/.test(y) || !Array.isArray(list)) {
        errEl.textContent = `键「${y}」应为 4 位年份，值应为数组。`; return;
      }
      for (const h of list) {
        if (!h || typeof h.name !== "string" || !Array.isArray(h.start) || !Array.isArray(h.end)) {
          errEl.textContent = `${y} 年有一条缺少 name / start / end。`; return;
        }
      }
    }
    if (!state.settings) state.settings = {};
    state.settings.legalOverride = obj;
    setLegalOverride(obj);
    saveState();
    toast("节假日已更新");
    shut();
    if (typeof onSaved === "function") onSaved();
  });
  ov.addEventListener("click", (e) => { if (e.target === ov) shut(); });
  setTimeout(() => { ov.addEventListener("keydown", (e) => { if (e.key === "Escape") shut(); }); ta.focus(); }, 0);
}

Bus.on("provider-emit", ({ config_hash, output }) => {
  if (config_hash !== "clock") return;
  // 仅在值变化时写 DOM，避免每秒无条件赋值触发多余重排
  const time = output.time || "--:--:--";
  const date = output.date || "";
  if (mcTime.textContent !== time) mcTime.textContent = time;
  if (mcDate.textContent !== date) {
    mcDate.textContent = date;
    refreshFestival(); // 日期进入新一天时同步刷新节日/节气/假期药丸
  }
});

refreshFestival();
mcFest?.addEventListener("click", showFestivalPanel);

// -------------------- EMS 工作量统计 --------------------
// Rust 侧 ems.rs 定时抓 EMS 任务/需求列表，经 provider-emit("ems-stats") 推上来。
// 这里把它落进 state.emsStats 并持久化 —— 保持「前端是 state.json 唯一写者」。
// 注意：null 与 0 语义不同。null = 还没抓到过（显示「—」），0 = 确实是零。
Bus.on("provider-emit", ({ config_hash, output }) => {
  if (config_hash !== "ems-stats") return;
  if (!output || typeof output !== "object") return;

  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  // 明细数组：非数组一律 null。空数组 = 确实查过且没有，null = 没这个数据源。
  const rows = (v) => (Array.isArray(v) ? v : null);

  const prev = state.emsStats || {};
  const next = {
    reqOpen: num(output.reqOpen),
    reqOpenRows: rows(output.reqOpenRows),
    reqUnverified: num(output.reqUnverified),
    reqUnverifiedRows: rows(output.reqUnverifiedRows),
    bugOpen: num(output.bugOpen),
    bugOpenRows: rows(output.bugOpenRows),
    bugUnverified: num(output.bugUnverified),
    bugUnverifiedRows: rows(output.bugUnverifiedRows),
    updatedAt: Number(output.updatedAt) || Date.now(),
    error: typeof output.error === "string" ? output.error : "",
  };

  // 内容没变就不写盘，避免无谓重写 state.json。
  // 签名带上明细条数：数字没变但明细变了（比如换了内容）也要更新。
  // ⛔ 必须带上 updatedAt：它的语义是「上次成功抓取的时刻」，即使四个数字
  //    一点没变，这个时间也该前进。漏了它会导致「抓取成功但 state 不更新」
  //    → 卡片不重画 → 刷新按钮的 .is-busy 永久残留，图标一直转，
  //    用户看到「一直在转没有返回数据」，其实数据早就回来了。
  //    抓取现在是 2 小时一轮，多写几次 state.json 的成本可以忽略。
  const sig = (o) =>
    [
      o.reqOpen, o.reqUnverified, o.bugOpen, o.bugUnverified, o.error,
      o.reqOpenRows?.length ?? "-",
      o.reqUnverifiedRows?.length ?? "-",
      o.bugOpenRows?.length ?? "-",
      o.bugUnverifiedRows?.length ?? "-",
      o.updatedAt ?? 0,
    ].join("|");
  if (sig(prev) === sig(next)) return;

  state.emsStats = next;
  saveState();
  // 卡片由 workspace.js 的 watch("ems", …) 自动重画，这里不主动重绘 ——
  // 整体重建会打断用户正在操作的其它卡片（焦点、hover 全丢）。
});


// -------------------- 事件绑定 --------------------
window.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  const help = document.getElementById("help-overlay");
  if (help && !help.hidden) help.hidden = true;
});
document.getElementById("help-close").addEventListener("click", () => {
  document.getElementById("help-overlay").hidden = true;
});

// 底部任务栏：设置 / 编辑模式 / 退出
document.getElementById("tb-settings")?.addEventListener("click", () => openModule("settings"));
document.getElementById("tb-edit")?.addEventListener("click", () => toggleEditMode());
// 卡片库：编辑态横幅里的「卡片库」按钮开关面板；面板内点卡片加回网格（委托 workspace 处理）
document.getElementById("tb-card-library")?.addEventListener("click", (e) => {
  e.stopPropagation();
  toggleCardLibrary();
});
// 编辑横幅左侧「刷新」：重新加载桌面（= 之前右键菜单的浏览器刷新）。整页 reload，
// 启动时按持久化的 cardOrder/cardSize/cardPos 重铺，布局不丢。
document.getElementById("tb-edit-refresh")?.addEventListener("click", (e) => {
  e.stopPropagation();
  location.reload();
});
document.getElementById("card-library")?.addEventListener("click", (e) => {
  const item = e.target.closest("[data-library-card]");
  if (!item || item.disabled) return;
  e.stopPropagation();
  addCard(item.dataset.libraryCard);
});
document.getElementById("tb-quit")?.addEventListener("click", () => {
  if (window.__TAURI__ || window.__TAURI_INTERNALS__) {
    invoke("quit_app").catch(() => { try { window.close(); } catch (_) {} });
  } else {
    toast("桌面态才能退出应用");
  }
});
document.getElementById("tb-fund")?.addEventListener("click", () => openModule("fund"));
// CPU / 内存 / 磁盘只是任务栏上的读数，不可点 —— 系统健康浮层已整体移除。

// -------------------- 禁用右键菜单 --------------------
// 桌面小部件不该弹浏览器右键（刷新/检查/另存为那一串）。全局拦掉。
// ⛔ 用 capture 阶段拦，避免某个子元素 stopPropagation 把事件漏到浏览器默认菜单。
document.addEventListener("contextmenu", (e) => {
  e.preventDefault();
}, true);

// -------------------- 滚动条自动隐藏（滚动时显示，停止后隐藏） --------------------
let scrollHideTimer = null;
document.addEventListener("scroll", (e) => {
  const el = e.target === document ? document.documentElement : e.target;
  if (!el || !el.classList) return;
  el.classList.add("scrolling");
  clearTimeout(scrollHideTimer);
  scrollHideTimer = setTimeout(() => {
    document.querySelectorAll(".scrolling").forEach((n) => n.classList.remove("scrolling"));
  }, 500);
}, true);

// -------------------- 启动 --------------------
// 异步初始化状态，就绪后加载外部插件、渲染工作台卡片
loadState().then(async () => {
  // 主题系统：最先应用（在任何模块渲染前把方案/token/背景写好，避免闪切）
  try { await Theme.init(); } catch (e) { console.warn("[theme] 初始化失败，使用默认深色", e); }
  // 工作台首页：卡片网格 + 任务栏 + 浮层
  initWorkspace();
  setQuietToast(toast);

  // 启动时是否自动打开上次模块的浮层（设置里可关；关掉就只显示卡片工作台）
  const remember = state.settings?.rememberModule !== false;
  const last = MODULES.some((m) => m.id === state.currentModule) ? state.currentModule : null;
  if (remember && last && last !== "dashboard") openModule(last);

  // 恢复音乐播放状态（队列/歌曲/播放位置）
  initPlayback();

  // 提醒：渲染时钟块倒计时 + 每秒检查
  initReminders();

  // 番茄钟：时钟条胶囊常驻 + 秒级倒计时/到期推进
  initPomodoro();

  // 隐私锁定：离开设定时长后全屏遮罩
  startLockController();

  // 全局护眼：从 state 恢复配置并推送到 Rust（含守护线程的事件订阅）
  initEyeCare();

  // 护眼顶栏胶囊：必须放在 initPomodoro 之后，才能插到番茄钟胶囊右侧
  initEyeCareCapsule();
});
