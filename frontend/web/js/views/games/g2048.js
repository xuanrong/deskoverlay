// 2048：4×4 滑动合并，方向键/按钮控制，分数累计，自动判断胜负。

const TILE_BG = {
  2: "rgba(88,166,255,0.35)", 4: "rgba(88,166,255,0.5)",
  8: "rgba(63,185,80,0.4)", 16: "rgba(63,185,80,0.55)",
  32: "rgba(210,153,34,0.4)", 64: "rgba(210,153,34,0.55)",
  128: "rgba(255,123,114,0.45)", 256: "rgba(255,123,114,0.6)",
  512: "rgba(188,140,255,0.45)", 1024: "rgba(188,140,255,0.6)",
  2048: "rgba(255,255,255,0.35)",
};

export function render2048(el) {
  el.innerHTML = `
    <div class="t2048-wrap" tabindex="0" id="t2048-wrap">
      <div class="t2048-head">
        <span class="t2048-title">2048</span>
        <span class="t2048-score">分数 <b id="t2048-score">0</b></span>
        <span class="t2048-best">最高 <b id="t2048-best">0</b></span>
        <button class="sudoku-btn" id="t2048-new">新游戏</button>
      </div>
      <div class="t2048-board" id="t2048-board"></div>
      <div class="t2048-msg" id="t2048-msg"></div>
      <div class="t2048-pad">
        <button class="sdk-num" data-dir="up">↑</button>
        <div class="t2048-pad-mid">
          <button class="sdk-num" data-dir="left">←</button>
          <button class="sdk-num" data-dir="down">↓</button>
          <button class="sdk-num" data-dir="right">→</button>
        </div>
      </div>
    </div>`;

  const boardEl = el.querySelector("#t2048-board");
  const wrapEl = el.querySelector("#t2048-wrap");
  const scoreEl = el.querySelector("#t2048-score");
  const bestEl = el.querySelector("#t2048-best");
  const msgEl = el.querySelector("#t2048-msg");

  let grid = Array(16).fill(0);
  let score = 0;
  let over = false;

  function best() {
    return Number(localStorage.getItem("deskoverlay.2048.best") || 0);
  }

  function spawn() {
    const empty = grid.map((v, i) => v === 0 ? i : -1).filter((i) => i >= 0);
    if (!empty.length) return;
    const i = empty[Math.floor(Math.random() * empty.length)];
    grid[i] = Math.random() < 0.9 ? 2 : 4;
  }

  // 压缩一行（去 0）→ 合并 → 再压缩
  function mergeLine(line) {
    const arr = line.filter((v) => v !== 0);
    const out = [];
    let gained = 0;
    for (let i = 0; i < arr.length; i++) {
      if (arr[i] === arr[i + 1]) {
        out.push(arr[i] * 2);
        gained += arr[i] * 2;
        i++;
      } else {
        out.push(arr[i]);
      }
    }
    while (out.length < 4) out.push(0);
    return { out, gained };
  }

  function move(dir) {
    const prev = grid.join(",");
    let gained = 0;
    for (let line = 0; line < 4; line++) {
      let cells;
      if (dir === "left") cells = [line * 4, line * 4 + 1, line * 4 + 2, line * 4 + 3];
      else if (dir === "right") cells = [line * 4 + 3, line * 4 + 2, line * 4 + 1, line * 4];
      else if (dir === "up") cells = [line, line + 4, line + 8, line + 12];
      else cells = [line + 12, line + 8, line + 4, line];
      const { out, gained: g } = mergeLine(cells.map((i) => grid[i]));
      gained += g;
      cells.forEach((i, k) => { grid[i] = out[k]; });
    }
    if (grid.join(",") !== prev) {
      score += gained;
      spawn();
      render();
      if (grid.includes(2048)) { msgEl.textContent = "🎉 达成 2048！"; msgEl.classList.add("ok"); }
      else if (!canMove()) {
        over = true;
        msgEl.textContent = "游戏结束";
        msgEl.classList.remove("ok");
      } else {
        msgEl.textContent = "";
        msgEl.classList.remove("ok");
      }
      if (score > best()) { localStorage.setItem("deskoverlay.2048.best", String(score)); }
      bestEl.textContent = best();
    }
  }

  function canMove() {
    for (let i = 0; i < 16; i++) {
      if (grid[i] === 0) return true;
      const r = Math.floor(i / 4), c = i % 4;
      if (c < 3 && grid[i] === grid[i + 1]) return true;
      if (r < 3 && grid[i] === grid[i + 4]) return true;
    }
    return false;
  }

  function render() {
    boardEl.innerHTML = grid.map((v) => `
      <div class="t2048-cell${v ? " filled" : ""}" ${v ? `style="background:${TILE_BG[v] || "rgba(255,255,255,0.25)"}"` : ""}>
        ${v || ""}
      </div>`).join("");
    scoreEl.textContent = score;
    bestEl.textContent = best();
  }

  el.querySelector("#t2048-new").addEventListener("click", () => {
    grid = Array(16).fill(0);
    score = 0; over = false;
    msgEl.textContent = ""; msgEl.classList.remove("ok");
    spawn(); spawn();
    render();
    wrapEl.focus();
  });

  el.querySelectorAll(".t2048-pad .sdk-num").forEach((b) => {
    b.addEventListener("click", () => {
      if (!over) move(b.dataset.dir);
      wrapEl.focus();
    });
  });

  // 键盘控制：方向键 + WASD，容器可聚焦，进入即生效
  const KEY_MAP = {
    ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down",
    a: "left", d: "right", w: "up", s: "down",
    A: "left", D: "right", W: "up", S: "down",
  };
  wrapEl.addEventListener("keydown", (e) => {
    const dir = KEY_MAP[e.key];
    if (dir) { e.preventDefault(); if (!over) move(dir); }
  });
  wrapEl.addEventListener("click", () => wrapEl.focus());

  grid = Array(16).fill(0);
  spawn(); spawn();
  render();
  wrapEl.focus();
}
