// 轻量页面内提示条 —— 底部居中浮层，1.8s 后淡出。
// 原先定义在 app.js 内部，抽为共用模块供各视图复用（导出结果、操作反馈等）。

export function toast(msg) {
  let t = document.getElementById("do-toast");
  if (!t) {
    t = document.createElement("div");
    t.id = "do-toast";
    t.style.cssText = "position:fixed;left:50%;bottom:60px;transform:translateX(-50%);z-index:12000;background:rgba(14,18,26,.92);border:1px solid var(--border-strong);color:var(--text);padding:10px 18px;border-radius:12px;font-size:13px;box-shadow:var(--shadow);backdrop-filter:blur(18px);transition:opacity .2s;";
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.style.opacity = "1";
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.style.opacity = "0"; }, 1800);
}
