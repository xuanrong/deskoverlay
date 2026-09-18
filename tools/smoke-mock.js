// DeskOverlay 前端冒烟测试的「假后端」。
// 由 tools/smoke.mjs 经 CDP `Page.addScriptToEvaluateOnNewDocument` 在页面脚本执行**之前**注入，
// 因此各模块在模块作用域读取 `window.__TAURI__` 时已能拿到本对象。
//
// 用途：无 Tauri 运行时也能在真浏览器里跑通主窗口与提醒窗口的关键契约。
// 断言读取 `window.__smoke.calls` / `fire()` / `listenerCount()`。
(() => {
  const internal = { calls: [], listeners: {} };

  // 劫持 Audio 构造器：music.js 用 `new Audio()` 创建播放器且**不插入 DOM**，
  // 故 `document.querySelector("audio")` 取不到实例，冒烟无法驱动 timeupdate。
  // 这里记录所有实例供断言取用（测试侧职责，不改生产代码）。
  const RealAudio = window.Audio;
  const audios = [];
  function PatchedAudio(...args) {
    const el = new RealAudio(...args);
    audios.push(el);
    return el;
  }
  PatchedAudio.prototype = RealAudio.prototype;
  window.Audio = PatchedAudio;
  // 搜索结果：第 1 条刻意构造为「文件名不含查询词、仅父目录含」——
  // 这正是 file_index::search_files 必须保留全路径趟的原因，也是本冒烟要守住的行为。
  const HITS = [
    { path: "C:\\Users\\qiuxr\\Documents\\采购\\Q1 汇总表.xlsx", is_dir: false },
    { path: "C:\\Users\\qiuxr\\Documents\\会议纪要\\2026-09-01 评审会.md", is_dir: false },
    { path: "C:\\Users\\qiuxr\\Desktop\\临时", is_dir: true },
  ];

  // 桌面文件列表：必须非空，否则文件中心会退化为「桌面无文件」空态而**不渲染搜索框**。
  const DESKTOP = [
    { name: "2026 计划.txt", path: "C:\\Users\\qiuxr\\Desktop\\2026 计划.txt", ext: "txt", is_dir: false, size: 120, mtime: 1757000000 },
    { name: "项目资料", path: "C:\\Users\\qiuxr\\Desktop\\项目资料", ext: "", is_dir: true, size: 0, mtime: 1757000000 },
  ];

  const table = {
    // 从 localStorage 读回 fixture：跨 Page.navigate 传递的开关不能放闭包变量（导航会新建 JS realm）。
    load_state: () => {
      try {
        const raw = localStorage.getItem("smoke_state");
        return raw ? JSON.parse(raw) : {};
      } catch { return {}; }
    },
    save_state: () => null,
    list_desktop_files: () => DESKTOP.slice(),
    index_status: () => ({ ready: true, building: false, scanned: 0, count: HITS.length, roots: ["C:\\"] }),
    search_files: () => HITS.map((h) => ({ ...h })),
    rebuild_index: () => null,
    read_text_file: () => "",
    check_media_playing: () => false,
    http_get: () => ({}),
    http_post: () => ({}),
    open_path: () => null,
    // ── 桌面歌词窗口（P1 骨架）──
    // 关键：`lyric_set_locked` 必须记录调用，冒烟要断言「锁定态切换真的下发了穿透开关」，
    // 这是 P1 的核心可验证行为（穿透是否正确生效只能真机看，但「有没有调用」能自动验）。
    lyric_ready: () => null,
    lyric_sync: () => null,
    // lyric_set_locked 在真实 Rust 侧会 set_ignore_cursor_events 并回发 lyric://locked 确认。
    // mock 复现这条回声，否则「页面锁定 → OS 状态 → 页面显示」的闭环无法断言。
    // 同时回发 sticky（locked=false 即用户显式解锁 → 保持解锁）与 hoverUnlock，
    // 与 Rust 侧 locked_payload() 的字段保持一致。
    lyric_set_locked: (args) => {
      const locked = !!args?.locked;
      (internal.listeners["lyric://locked"] || []).forEach((f) => {
        try { f({ payload: { locked, sticky: !locked, hoverUnlock: true } }); } catch (e) { console.error("[smoke] listener 抛错", e); }
      });
      return null;
    },
    lyric_move: () => null,
    lyric_pos_commit: () => null,
    lyric_apply_cfg: () => null,
    // 形态/样式/字号的统一提交通道。真实 Rust 侧会改窗口高度并全局广播
    // lyric://display（主窗口据此落盘）—— mock 复现这条广播，否则
    // 「歌词页右键改形态 → 主窗口持久化」这条链路无法断言。
    lyric_commit_display: (args) => {
      (internal.listeners["lyric://display"] || []).forEach((f) => {
        try { f({ payload: args ?? {} }); } catch (e) { console.error("[smoke] listener 抛错", e); }
      });
      return null;
    },
    // lyric_panel 在真实 Rust 侧会把窗口向上加高 38px（底边锚定）。mock 仅记录调用，
    // 冒烟断言「面板展开真的下发了命令」；几何由 Rust 保证，浏览器里无法验证。
    lyric_panel: () => null,
    show_lyric: () => null,
    // hide_lyric 在真实 Rust 侧会 emit "lyric-hidden"（供主窗口复位按钮态）。
    // mock 里复现这条广播，否则「歌词窗口自行关闭 → 主窗口按钮态复位」这条链路无法断言。
    hide_lyric: () => {
      (internal.listeners["lyric-hidden"] || []).forEach((f) => {
        try { f({ payload: null }); } catch (e) { console.error("[smoke] listener 抛错", e); }
      });
      return null;
    },
    // 窗口 API：歌词页拖动与位置换算用。outerPosition 返回物理坐标，
    // scaleFactor 返回 1 让 px 换算在断言里保持可预测。
    "plugin:window|outer_position": () => ({ x: 300, y: 900 }),
    "plugin:window|outer_size": () => ({ width: 760, height: 90 }),
    "plugin:window|scale_factor": () => 1,
    "plugin:window|current_monitor": () => ({
      name: "mock-monitor",
      scaleFactor: 1,
      position: { x: 0, y: 0 },
      size: { width: 1920, height: 1080 },
      workArea: { position: { x: 0, y: 0 }, size: { width: 1920, height: 1040 } },
    }),
    "plugin:window|available_monitors": () => [{
      name: "mock-monitor",
      scaleFactor: 1,
      position: { x: 0, y: 0 },
      size: { width: 1920, height: 1080 },
      workArea: { position: { x: 0, y: 0 }, size: { width: 1920, height: 1040 } },
    }],
  };

  window.__smoke = {
    dump: () => JSON.parse(JSON.stringify(internal.calls)),
    callsOf: (cmd) => JSON.parse(JSON.stringify(internal.calls.filter((c) => c.cmd === cmd))),
    cmds: () => internal.calls.map((c) => c.cmd),
    fire: (name, payload) => {
      const ls = internal.listeners[name] || [];
      ls.forEach((f) => {
        try { f({ payload }); } catch (e) { console.error("[smoke] listener 抛错", e); }
      });
      return ls.length;
    },
    listenerCount: (name) => (internal.listeners[name] || []).length,
    // 已注册监听器的名字清单（诊断用）：断言超时时能直接看出「页面到底注册了哪些通道」，
    // 而不是只知道某一条缺失 —— 例如脚本执行到一半抛错时，这里会少掉后半段的通道。
    listenerNames: () => Object.keys(internal.listeners).filter((n) => internal.listeners[n].length > 0),
    reset: () => { internal.calls.length = 0; },
    // 设置下一次 load_state 的返回值（写 localStorage，导航后仍生效）。
    setLoadState: (s) => { localStorage.setItem("smoke_state", JSON.stringify(s ?? {})); },
    clearLoadState: () => { localStorage.removeItem("smoke_state"); },
    // 取被劫持的 Audio 实例（music.js 的播放器不入 DOM，只能这样拿到）
    audio: (i = 0) => audios[i] || null,
    audioCount: () => audios.length,
  };

  // 供 window API 复用：与 __TAURI__.core.invoke 同一实现，保证调用被记录。
  const invoke = async (cmd, args) => {
    internal.calls.push({ cmd, args: args ?? null });
    const f = table[cmd];
    return f ? f(args) : null;
  };

  window.__TAURI__ = {
    core: {
      invoke,
      convertFileSrc: (p) => p,
    },
    event: {
      listen: async (name, cb) => {
        (internal.listeners[name] = internal.listeners[name] || []).push(cb);
        return () => {};
      },
      emit: async () => {},
    },
    // 窗口 API：歌词页的拖动与位置换算依赖它。方法内部仍走 invoke，
    // 使 `plugin:window|*` 调用同样被记录，便于断言。
    window: {
      getCurrentWindow: () => ({
        outerPosition: () => invoke("plugin:window|outer_position"),
        outerSize: () => invoke("plugin:window|outer_size"),
        scaleFactor: () => invoke("plugin:window|scale_factor"),
        currentMonitor: () => invoke("plugin:window|current_monitor"),
      }),
      availableMonitors: () => invoke("plugin:window|available_monitors"),
    },
  };
})();
