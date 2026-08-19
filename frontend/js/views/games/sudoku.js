// 数独小游戏：回溯生成完整解 → 按难度挖洞（唯一解验证）→ 交互输入。
// 难度：easy(挖32) / medium(挖45) / hard(挖55)，空格越多越难。

const DIFF_HOLES = { easy: 32, medium: 45, hard: 55 };
const DIFF_LABEL = { easy: "简单", medium: "中等", hard: "困难" };

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function ok(board, idx, v) {
  const r = Math.floor(idx / 9), c = idx % 9;
  for (let i = 0; i < 9; i++) {
    if (board[r * 9 + i] === v) return false;
    if (board[i * 9 + c] === v) return false;
  }
  const br = Math.floor(r / 3) * 3, bc = Math.floor(c / 3) * 3;
  for (let i = 0; i < 3; i++) for (let k = 0; k < 3; k++) {
    if (board[(br + i) * 9 + bc + k] === v) return false;
  }
  return true;
}

// 回溯生成一个完整解
function generateSolution() {
  const board = Array(81).fill(0);
  (function fill(i) {
    if (i >= 81) return true;
    if (board[i] !== 0) return fill(i + 1);
    for (const n of shuffle([1, 2, 3, 4, 5, 6, 7, 8, 9])) {
      if (ok(board, i, n)) {
        board[i] = n;
        if (fill(i + 1)) return true;
        board[i] = 0;
      }
    }
    return false;
  })(0);
  return board;
}

// 统计解的数量（最多数到 limit）
function countSolutions(board, limit = 2) {
  let count = 0;
  (function find(i) {
    if (count >= limit) return;
    while (i < 81 && board[i] !== 0) i++;
    if (i >= 81) { count++; return; }
    for (let n = 1; n <= 9; n++) {
      if (ok(board, i, n)) {
        board[i] = n;
        find(i + 1);
        board[i] = 0;
        if (count >= limit) return;
      }
    }
  })(0);
  return count;
}

// 按目标挖洞数挖空，每挖一个验证唯一解（不唯一则回退）
function dig(board, target) {
  let holes = 0;
  const cells = shuffle(Array.from({ length: 81 }, (_, i) => i));
  for (const i of cells) {
    if (holes >= target) break;
    const backup = board[i];
    board[i] = 0;
    if (countSolutions(board.slice(), 2) !== 1) {
      board[i] = backup;
    } else {
      holes++;
    }
  }
  return board;
}

// 生成指定难度的谜题，返回 { board(完整解), giver(谜题 81 数字 0=空) }
export function generateSudoku(difficulty) {
  const board = dig(generateSolution(), DIFF_HOLES[difficulty] || 45);
  return board;
}

export function renderSudoku(el) {
  el.innerHTML = `
    <div class="sudoku-wrap">
      <div class="sudoku-head">
        <span class="sudoku-title">数独</span>
        <div class="sudoku-diff" id="sdk-diff">
          ${Object.keys(DIFF_HOLES).map((d) => `<button class="sudoku-btn diff-btn" data-diff="${d}">${DIFF_LABEL[d]}</button>`).join("")}
        </div>
        <button class="sudoku-btn" id="sdk-check">检查</button>
        <button class="sudoku-btn" id="sdk-new">新游戏</button>
      </div>
      <div class="sudoku-board" id="sdk-board"></div>
      <div class="sudoku-pad" id="sdk-pad"></div>
      <div class="sudoku-msg" id="sdk-msg"></div>
    </div>`;

  const boardEl = el.querySelector("#sdk-board");
  const padEl = el.querySelector("#sdk-pad");
  const msgEl = el.querySelector("#sdk-msg");
  const diffEl = el.querySelector("#sdk-diff");

  let board = [];    // 81 当前值（0=空）
  let giver = [];    // 81 是否初始给定
  let difficulty = "medium";
  let selected = -1;

  function load() {
    board = generateSudoku(difficulty);
    giver = board.map((v) => v !== 0);
    selected = -1;
    msgEl.textContent = "";
    render();
    buildPad();
  }

  function cellConflicts(idx) {
    if (board[idx] === 0) return false;
    return !ok(board, idx, board[idx]);
  }

  function render() {
    boardEl.innerHTML = board.map((v, i) => {
      const r = Math.floor(i / 9), c = i % 9;
      const cls = ["sdk-cell"];
      if (giver[i]) cls.push("giver");
      if (i === selected) cls.push("sel");
      else if (selected !== -1) {
        const sr = Math.floor(selected / 9), sc = selected % 9;
        if (r === sr || c === sc ||
            (Math.floor(r / 3) === Math.floor(sr / 3) && Math.floor(c / 3) === Math.floor(sc / 3))) {
          cls.push("hl");
        }
      }
      if (!giver[i] && v !== 0 && cellConflicts(i)) cls.push("conflict");
      return `<div class="${cls.join(" ")}" data-i="${i}">${v ? v : ""}</div>`;
    }).join("");
    boardEl.querySelectorAll(".sdk-cell").forEach((cell) => {
      cell.addEventListener("click", () => {
        selected = Number(cell.dataset.i);
        render();
      });
    });
  }

  function buildPad() {
    padEl.innerHTML = Array.from({ length: 9 }, (_, n) => `<button class="sdk-num" data-n="${n + 1}">${n + 1}</button>`).join("")
      + `<button class="sdk-num sdk-erase" data-n="0">清除</button>`;
    padEl.querySelectorAll(".sdk-num").forEach((b) => {
      b.addEventListener("click", () => {
        if (selected === -1 || giver[selected]) return;
        const n = Number(b.dataset.n);
        board[selected] = n === 0 ? 0 : n;
        msgEl.textContent = "";
        render();
        if (isComplete()) {
          msgEl.textContent = "🎉 完成！太棒了";
          msgEl.classList.add("ok");
        } else {
          msgEl.classList.remove("ok");
        }
      });
    });
  }

  function isComplete() {
    return board.every((v) => v !== 0) && board.every((_, i) => !cellConflicts(i));
  }

  el.querySelector("#sdk-check").addEventListener("click", () => {
    if (!board.some((v) => v === 0)) {
      if (board.every((_, i) => !cellConflicts(i))) {
        msgEl.textContent = "🎉 完成！太棒了";
        msgEl.classList.add("ok");
      } else {
        msgEl.textContent = "有冲突的数字，请检查红色格子";
        msgEl.classList.remove("ok");
      }
    } else {
      msgEl.textContent = "还有空格未填写";
      msgEl.classList.remove("ok");
    }
  });

  el.querySelector("#sdk-new").addEventListener("click", load);

  diffEl.querySelectorAll(".diff-btn").forEach((b) => {
    b.addEventListener("click", () => {
      difficulty = b.dataset.diff;
      diffEl.querySelectorAll(".diff-btn").forEach((x) => x.classList.toggle("active", x === b));
      load();
    });
  });

  el.addEventListener("keydown", (e) => {
    if (/^[1-9]$/.test(e.key) && selected !== -1 && !giver[selected]) {
      board[selected] = Number(e.key);
      render();
    } else if (e.key === "Backspace" || e.key === "Delete") {
      if (selected !== -1 && !giver[selected]) {
        board[selected] = 0;
        render();
      }
    }
  });
  boardEl.tabIndex = 0;

  load();
}
