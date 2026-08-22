// 视图公共工具：HTML 转义 / 通用弹窗 / 音源结果归一化。

export const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// 通用弹窗（与工作台深色风格统一）：确认 / 输入 / 提示
// opts: { title, message, okText, cancelText, danger, showCancel, input, inputValue }
// 返回 Promise：确认 → true；取消/关闭 → null；输入 → 输入值（取消为 null）
export function showDialog({ title, message = "", okText = "确定", cancelText = "取消", danger = false, showCancel = true, input = false, inputValue = "" }) {
  return new Promise((resolve) => {
    const ov = document.createElement("div");
    ov.className = "task-modal-overlay";
    ov.innerHTML = `
      <div class="task-modal confirm-modal">
        <h3>${esc(title)}</h3>
        ${message ? `<p class="cm-message">${esc(message)}</p>` : ""}
        ${input ? `<div class="tm-field"><input id="cm-input" type="text" value="${esc(inputValue)}" /></div>` : ""}
        <div class="tm-actions">
          ${showCancel ? `<button class="tm-cancel">${esc(cancelText)}</button>` : ""}
          <button class="btn-primary cm-ok${danger ? " danger" : ""}">${esc(okText)}</button>
        </div>
      </div>`;
    document.body.appendChild(ov);

    const inputEl = ov.querySelector("#cm-input");
    const done = (val) => { ov.remove(); resolve(val); };

    ov.querySelector(".cm-ok").addEventListener("click", () => {
      done(input ? (inputEl.value || "").trim() : true);
    });
    ov.querySelector(".tm-cancel")?.addEventListener("click", () => done(null));
    ov.addEventListener("keydown", (e) => {
      if (e.key === "Escape") done(null);
      else if (e.key === "Enter" && input) done((inputEl.value || "").trim());
    });
    if (inputEl) { inputEl.focus(); inputEl.select(); }
  });
}

// 规范化音源插件返回的歌曲列表（兼容 MusicFree 各种返回结构）
export function normalizeSongs(res) {
  if (Array.isArray(res)) return res;
  if (res && Array.isArray(res.songs)) return res.songs;
  if (res && Array.isArray(res.data)) return res.data; // MusicFree 插件返回 { isEnd, data }
  if (res && Array.isArray(res.list)) return res.list;
  if (res && res.result && Array.isArray(res.result.songs)) return res.result.songs;
  return [];
}
