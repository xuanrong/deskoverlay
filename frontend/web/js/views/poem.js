// 每日诗词：首页 span-2 卡显示每日一句，右上角刷新按钮换一句。无浮层。
// 数据源 jinrishici（今日诗词）免费接口，无需 key：https://v1.jinrishici.com/all.json
//   返回 { content, origin, author, category }：content=一句诗文，origin=出处诗名，
//   author=作者，category=分类（如「古诗文-植物-叶子」）。
// 按 YG 要求「每次都重新请求」：不持久缓存，卡片挂载和点刷新都重新拉。
// 网络失败回退到内置兜底句（离线也能显示，不空白）。
import { invoke } from "../bus.js";
import { esc } from "../utils.js";
import { ICON_REFRESH } from "../icons.js";

// 拉一句诗；失败抛错（调用方决定显示错误还是兜底）。
async function fetchPoem() {
  const raw = await invoke("http_get", {
    url: "https://v1.jinrishici.com/all.json",
    headers: { Accept: "application/json" },
  });
  const json = JSON.parse(String(raw).replace(/^\uFEFF/, ""));
  if (!json || !json.content) throw new Error("接口返回异常");
  return {
    content: String(json.content || ""),
    origin: String(json.origin || "佚名"),
    author: String(json.author || "佚名"),
    category: String(json.category || ""),
  };
}

// 内置兜底句：接口挂了/离线时卡片不空白。真诗词，非占位符。
const FALLBACK = { content: "海上生明月，天涯共此时。", origin: "望月怀远", author: "张九龄", category: "" };

// -------------------- 卡片渲染（span-2 首页卡，右上角刷新） --------------------
// 卡片只显示一句 content + 出处作者；右上角刷新按钮换一句（stopPropagation 不冒泡到网格）。
export function renderPoemCard(card) {
  if (!card) return;
  const body = card.querySelector("[data-body]");
  const extra = card.querySelector("[data-extra]");
  if (!body) return;

  // 右上角刷新按钮（跟签到/禅道卡同一套 cr-refresh 写法）
  if (extra) {
    extra.innerHTML = `<button class="cr-refresh" data-poem-refresh aria-label="换一句诗">${ICON_REFRESH}</button>`;
    const btn = extra.querySelector("[data-poem-refresh]");
    if (btn) {
      btn.addEventListener("click", (e) => {
        e.stopPropagation(); // 不冒泡到网格 click（否则可能触发整卡行为）
        loadCard(body, btn, true);
      });
    }
  }

  loadCard(body, extra?.querySelector("[data-poem-refresh]"), false);
}

async function loadCard(body, btn, manual) {
  // 拉取中给刷新按钮转圈反馈
  btn?.classList.add("is-busy");
  try {
    const p = await fetchPoem();
    paintCard(body, p, false);
  } catch (_) {
    // 接口失败 → 兜底句 + 标注离线（不静默假装成功）
    paintCard(body, FALLBACK, true);
  } finally {
    btn?.classList.remove("is-busy");
  }
}

function paintCard(body, p, offline) {
  body.innerHTML = `<div class="poem-card${offline ? " poem-offline" : ""}" data-poem-card>
    <p class="poem-line">${esc(p.content)}</p>
    <p class="poem-meta"><span class="poem-origin">${esc(p.origin)}</span><span class="poem-author">${esc(p.author)}</span></p>
  </div>`;
}
