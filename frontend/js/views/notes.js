// 速记视图：随手记录，自动保存。
import { state, saveState } from "../state.js";

export function renderNotes(view) {
  view.header.innerHTML = `<div class="view-title">速记</div><div class="view-sub">随手记录 · 自动保存</div>`;
  const body = view.body;
  body.innerHTML = `
    <textarea class="notes-area" id="n-area" placeholder="随手记录灵感、会议纪要…"></textarea>
    <div class="notes-saved" id="n-saved"></div>`;
  const area = body.querySelector("#n-area");
  const savedEl = body.querySelector("#n-saved");
  area.value = state.notes || "";

  let timer;
  const onInput = () => {
    savedEl.textContent = "编辑中…";
    clearTimeout(timer);
    timer = setTimeout(() => {
      state.notes = area.value;
      saveState();
      savedEl.textContent = "已保存 " + new Date().toLocaleTimeString("zh-CN", { hour12: false });
    }, 500);
  };
  area.addEventListener("input", onInput);
  view.onDestroy(() => { clearTimeout(timer); });
}
