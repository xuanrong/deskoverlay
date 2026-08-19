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

export function renderRelax(view) {
  view.header.innerHTML = `<div class="view-title">休息一下</div><div class="view-sub">小游戏 · 放松片刻再继续</div>`;
  const body = view.body;
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

  renderSide();
  renderMain();
}
