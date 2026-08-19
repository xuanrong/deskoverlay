// 扫雷：9×9 × 10 雷。左键翻开（空格扩散），右键标旗/取消，双击数字翻开周围（可选），
// 雷数/计时显示，踩雷结束，全部非雷翻开胜利。

const ROWS = 9, COLS = 9, MINES = 10;

export function renderMinesweeper(el) {
  el.innerHTML = `
    <div class="mine-wrap">
      <div class="mine-head">
        <span class="mine-title">扫雷</span>
        <span class="mine-info">🚩 <b id="mine-flag">${MINES}</b></span>
        <span class="mine-info">⏱ <b id="mine-time">0</b></span>
        <button class="sudoku-btn" id="mine-new">新游戏</button>
      </div>
      <div class="mine-board" id="mine-board"></div>
      <div class="mine-msg" id="mine-msg"></div>
    </div>`;

  const boardEl = el.querySelector("#mine-board");
  const flagEl = el.querySelector("#mine-flag");
  const timeEl = el.querySelector("#mine-time");
  const msgEl = el.querySelector("#mine-msg");

  let mines = [];    // 81 bool
  let revealed = []; // 81 bool
  let flags = [];    // 81 bool
  let counts = [];   // 81 相邻雷数
  let started = false;
  let over = false;
  let win = false;
  let seconds = 0;
  let timer = null;

  function idx(r, c) { return r * COLS + c; }
  function neighbors(i) {
    const r = Math.floor(i / COLS), c = i % COLS;
    const out = [];
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      const rr = r + dr, cc = c + dc;
      if (rr >= 0 && rr < ROWS && cc >= 0 && cc < COLS) out.push(idx(rr, cc));
    }
    return out;
  }

  function init(seed) {
    // 首点不为雷：seed 是首次点击格
    mines = Array(81).fill(false);
    const safe = new Set(neighbors(seed).concat([seed]));
    const cand = Array.from({ length: 81 }, (_, i) => i).filter((i) => !safe.has(i));
    for (let n = 0; n < MINES; n++) {
      const k = Math.floor(Math.random() * cand.length);
      mines[cand.splice(k, 1)[0]] = true;
    }
    counts = Array(81).fill(0);
    for (let i = 0; i < 81; i++) counts[i] = neighbors(i).filter((j) => mines[j]).length;
    revealed = Array(81).fill(false);
    flags = Array(81).fill(false);
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
    flagEl.textContent = MINES - flags.filter(Boolean).length;
    render();
  }

  function render() {
    boardEl.innerHTML = Array.from({ length: 81 }, (_, i) => {
      const r = Math.floor(i / COLS), c = i % COLS;
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

  el.querySelector("#mine-new").addEventListener("click", () => { init(-1); render(); });
  boardEl.addEventListener("contextmenu", (e) => e.preventDefault());

  init(-1);
  render();
}
