// 扫雷：左键翻开（空格扩散），右键标旗/取消，踩雷结束，全部非雷翻开胜利。
// 难度：简单 9×9×10 / 中等 13×13×28 / 困难 16×16×40，可随时切换。

const DIFFS = {
  easy:   { label: "简单", rows: 9,  cols: 9,  mines: 10, size: 38 },
  medium: { label: "中等", rows: 13, cols: 13, mines: 28, size: 30 },
  hard:   { label: "困难", rows: 16, cols: 16, mines: 40, size: 26 },
};

export function renderMinesweeper(el) {
  el.innerHTML = `
    <div class="mine-wrap">
      <div class="mine-head">
        <span class="mine-title">扫雷</span>
        <span class="mine-info">🚩 <b id="mine-flag">10</b></span>
        <span class="mine-info">⏱ <b id="mine-time">0</b></span>
        <div class="mine-diffs" id="mine-diffs"></div>
        <button class="sudoku-btn" id="mine-new">新游戏</button>
      </div>
      <div class="mine-board" id="mine-board"></div>
      <div class="mine-msg" id="mine-msg"></div>
    </div>`;

  const boardEl = el.querySelector("#mine-board");
  const flagEl = el.querySelector("#mine-flag");
  const timeEl = el.querySelector("#mine-time");
  const msgEl = el.querySelector("#mine-msg");
  const diffsEl = el.querySelector("#mine-diffs");

  let diff = DIFFS.easy;
  let mines = [];    // rows*cols bool
  let revealed = []; // rows*cols bool
  let flags = [];    // rows*cols bool
  let counts = [];   // rows*cols 相邻雷数
  let started = false;
  let over = false;
  let win = false;
  let seconds = 0;
  let timer = null;

  function idx(r, c) { return r * diff.cols + c; }
  function neighbors(i) {
    const r = Math.floor(i / diff.cols), c = i % diff.cols;
    const out = [];
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      const rr = r + dr, cc = c + dc;
      if (rr >= 0 && rr < diff.rows && cc >= 0 && cc < diff.cols) out.push(idx(rr, cc));
    }
    return out;
  }

  function init(seed) {
    // 首点不为雷：seed 是首次点击格
    const total = diff.rows * diff.cols;
    mines = Array(total).fill(false);
    const safe = new Set(neighbors(seed).concat([seed]));
    const cand = Array.from({ length: total }, (_, i) => i).filter((i) => !safe.has(i));
    for (let n = 0; n < diff.mines; n++) {
      const k = Math.floor(Math.random() * cand.length);
      mines[cand.splice(k, 1)[0]] = true;
    }
    counts = Array(total).fill(0);
    for (let i = 0; i < total; i++) counts[i] = neighbors(i).filter((j) => mines[j]).length;
    revealed = Array(total).fill(false);
    flags = Array(total).fill(false);
    started = false; over = false; win = false; seconds = 0;
    clearInterval(timer); timer = null;
    timeEl.textContent = "0";
    msgEl.textContent = ""; msgEl.classList.remove("ok");
  }

  function startTimer() {
    if (timer) return;
    timer = setInterval(() => { seconds++; timeEl.textContent = seconds; }, 1000);
  }

  function reveal(i) {
    if (over || win || revealed[i] || flags[i]) return;
    if (mines[i]) {
      // 踩雷
      over = true;
      revealed = revealed.map((_, k) => revealed[k] || mines[k]);
      clearInterval(timer);
      msgEl.textContent = "💥 踩到地雷了";
      render();
      return;
    }
    if (!started) { started = true; startTimer(); }
    revealed[i] = true;
    if (counts[i] === 0) {
      // 扩散
      for (const j of neighbors(i)) {
        if (!revealed[j] && !flags[j] && !mines[j]) reveal(j);
      }
    }
    checkWin();
    render();
  }

  function checkWin() {
    const ok = revealed.filter((v, i) => !mines[i] && !v).length === 0;
    if (ok) {
      win = true;
      clearInterval(timer);
      msgEl.textContent = "🎉 胜利！全部排除";
      msgEl.classList.add("ok");
    }
  }

  function toggleFlag(i) {
    if (over || win || revealed[i]) return;
    flags[i] = !flags[i];
    flagEl.textContent = diff.mines - flags.filter(Boolean).length;
    render();
  }

  function render() {
    boardEl.style.setProperty("--mine-cols", diff.cols);
    boardEl.style.setProperty("--mine-size", diff.size + "px");
    boardEl.innerHTML = Array.from({ length: diff.rows * diff.cols }, (_, i) => {
      const r = Math.floor(i / diff.cols), c = i % diff.cols;
      let cls = "mine-cell";
      let body = "";
      if (revealed[i]) {
        cls += " open";
        if (mines[i]) {
          cls += " boom";
          body = "💣";
        } else if (counts[i] > 0) {
          body = counts[i];
          cls += " n" + counts[i];
        }
      } else if (flags[i]) {
        body = "🚩";
      } else {
        cls += ` ${(r + c) % 2 === 0 ? "odd" : "even"}`;
      }
      return `<div class="${cls}" data-i="${i}">${body}</div>`;
    }).join("");

    boardEl.querySelectorAll(".mine-cell").forEach((cell) => {
      cell.addEventListener("click", () => reveal(Number(cell.dataset.i)));
      cell.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        toggleFlag(Number(cell.dataset.i));
      });
    });
  }

  function renderDiffs() {
    diffsEl.innerHTML = Object.entries(DIFFS).map(([key, d]) => `
      <button class="sudoku-btn mine-diff" data-diff="${key}">${d.label}</button>`).join("");
    diffsEl.querySelectorAll(".mine-diff").forEach((b) => {
      const active = DIFFS[b.dataset.diff] === diff;
      b.classList.toggle("active", active);
      b.addEventListener("click", () => {
        diff = DIFFS[b.dataset.diff];
        renderDiffs();
        init(-1);
        render();
      });
    });
  }

  el.querySelector("#mine-new").addEventListener("click", () => { init(-1); render(); });
  boardEl.addEventListener("contextmenu", (e) => e.preventDefault());

  renderDiffs();
  init(-1);
  render();
}
