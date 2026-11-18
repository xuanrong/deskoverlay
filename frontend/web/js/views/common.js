// 视图公共工具：通用弹窗 / 音源结果归一化。
import { esc } from "../utils.js";

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

// textarea 自适应高度：随内容增高，超过 maxPx 后内部滚动（空内容回到 CSS min-height）
export function fitTextarea(el, maxPx = 200) {
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, maxPx) + "px";
}

// 把插件歌曲对象里各种格式的歌手信息归一化成一个「歌手名」字符串。
// 兼容：artist 字符串 / artists 数组（[{name}] 或 ["name"]）/ singer / artistName / singerName。
// 咪咕等音源把歌手放 artists 数组而非扁平 artist，不归一化歌单/搜索就显示「未知歌手」。
export function normalizeArtist(s) {
  if (!s || typeof s !== "object") return "";
  const pick = (v) => {
    if (!v) return "";
    if (typeof v === "string") return v.trim();
    if (Array.isArray(v)) {
      return v.map((x) => (typeof x === "string" ? x.trim() : (x && typeof x === "object" ? String(x.name || x.artistName || x.title || "").trim() : "")))
        .filter(Boolean).join(" / ");
    }
    if (typeof v === "object") return String(v.name || v.artistName || v.title || "").trim();
    return "";
  };
  return pick(s.artist) || pick(s.artists) || pick(s.singer) || pick(s.artistName) || pick(s.singerName) || pick(s.singerList);
}

// 规范化音源插件返回的歌曲列表（兼容 MusicFree 各种返回结构）
export function normalizeSongs(res) {
  let list;
  if (Array.isArray(res)) list = res;
  else if (res && Array.isArray(res.songs)) list = res.songs;
  else if (res && Array.isArray(res.data)) list = res.data; // MusicFree 插件返回 { isEnd, data }
  else if (res && Array.isArray(res.list)) list = res.list;
  else if (res && res.result && Array.isArray(res.result.songs)) list = res.result.songs;
  else list = [];
  // 补扁平 artist：renderSongList 只读 song.artist，咪咕等源的歌手在 artists 数组里，
  // 不归一化会显示「未知歌手」。song 对象原样保留（取流/歌词/下载靠它），只补 artist。
  return list.map((s) => {
    if (s && typeof s === "object" && !s.artist) {
      const a = normalizeArtist(s);
      if (a) return { ...s, artist: a };
    }
    return s;
  });
}
