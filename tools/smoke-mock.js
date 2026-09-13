// DeskOverlay 前端冒烟测试的「假后端」。
// 由 tools/smoke.mjs 经 CDP `Page.addScriptToEvaluateOnNewDocument` 在页面脚本执行**之前**注入，
// 因此各模块在模块作用域读取 `window.__TAURI__` 时已能拿到本对象。
//
// 用途：无 Tauri 运行时也能在真浏览器里跑通主窗口与提醒窗口的关键契约。
// 断言读取 `window.__smoke.calls` / `fire()` / `listenerCount()`。
(() => {
  const internal = { calls: [], listeners: {} };
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
    load_state: () => ({}),
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
    reset: () => { internal.calls.length = 0; },
  };

  window.__TAURI__ = {
    core: {
      invoke: async (cmd, args) => {
        internal.calls.push({ cmd, args: args ?? null });
        const f = table[cmd];
        return f ? f(args) : null;
      },
      convertFileSrc: (p) => p,
    },
    event: {
      listen: async (name, cb) => {
        (internal.listeners[name] = internal.listeners[name] || []).push(cb);
        return () => {};
      },
      emit: async () => {},
    },
    window: { getCurrentWindow: () => ({}) },
  };
})();
