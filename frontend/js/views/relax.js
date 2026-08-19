// 休息一下 — 小游戏大厅（游戏列表左侧 + 游戏区右侧）。
// 新增游戏：在 views/games/ 写渲染函数，然后在 GAMES 数组注册即可。
import { esc } from "./common.js";
import { renderSudoku } from "./games/sudoku.js";
import { render2048 } from "./games/g2048.js";
import { renderMinesweeper } from "./games/minesweeper.js";

const GAMES = [
  { id: "sudoku", title: "数独", desc: "9×9 数字推理，生成器控难度", render: renderSudoku },
  { id: "g2048", title: "2048", desc: "滑动合并数字，冲击 2048", render: render2048 },
  { id: "minesweeper", title: "扫雷", desc: "9×9 十雷，左键翻开右键标旗", render: renderMinesweeper },
];

let cachedContent = null; // 保存游戏 DOM，切换视图时不丢失进度

export function renderRelax(view) {
  view.header.style.display = "none";
  const body = view.body;

  // 有缓存时直接恢复，避免游戏进度丢失
  if (cachedContent) {
    body.innerHTML = "";
    body.appendChild(cachedContent);
    const active = cachedContent.querySelector(".relax-game.active");
    // 恢复后可聚焦的游戏容器（如 2048 支持键盘）
    const gameFocus = cachedContent.querySelector("[tabindex='0']");
    if (active && active.dataset.id === "g2048" && gameFocus) gameFocus.focus();
    view.onDestroy(() => {
      cachedContent = body.querySelector(".relax-view");
      cachedContent.remove();
    });
    return;
  }

  body.innerHTML = `
    <div class="relax-view">
      <div class="relax-side" id="relax-side"></div>
      <div class="relax-main" id="relax-main"></div>
    </div>`;

  const sideEl = body.querySelector("#relax-side");
  const mainEl = body.querySelector("#relax-main");
  let current = GAMES[0];

  function renderSide() {
    sideEl.innerHTML = GAMES.map((g) => `
      <button class="relax-game${g.id === current.id ? " active" : ""}" data-id="${g.id}" title="${esc(g.desc)}">
        <span class="rg-title">${esc(g.title)}</span>
        <span class="rg-desc">${esc(g.desc)}</span>
      </button>`).join("");
    sideEl.querySelectorAll(".relax-game").forEach((b) => {
      b.addEventListener("click", () => {
        const g = GAMES.find((x) => x.id === b.dataset.id);
        if (g) { current = g; renderSide(); renderMain(); }
      });
    });
  }

  function renderMain() {
    mainEl.innerHTML = "";
    current.render(mainEl);
  }

  // 切换视图时保存 DOM，避免重新创建导致游戏进度丢失
  view.onDestroy(() => {
    cachedContent = body.querySelector(".relax-view");
    cachedContent.remove();
  });

  renderSide();
  renderMain();
}