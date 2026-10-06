// 基金 AI 分析（纯模块）：把「持仓账本 + 当日估值口径」组装成结构化快照，再转成
// OpenAI 兼容的对话请求，并把响应解析回 Markdown 报告。
//
// 三条不可破的约束（同 fund-estimator.js）：
//   ① 零 import —— 连 utils.js 都不引，内联自己的格式化工具
//   ② 零全局时钟 —— 需要时间的地方一律由调用方传入 stamp / ports.now
//   ③ 零 DOM / 零 state —— 网络与时钟全走 ports 注入
//
// 口径铁律：快照的数值口径**必须**与视图 calcHolding / computeHoldSummary 一致（份额、成本、
// 市值、当日盈亏、区分数值日涨跌与盘中估算），否则 AI 会基于与界面不同的数字给出结论。

export const AI_DEFAULTS = {
  baseUrl: "",
  model: "",
  apiKey: "",
  temperature: 0.3,
  // 输出上限 4000：思考型模型（deepseek-reasoner / o1 系）会先花掉大量 token 在思考链上，
  // 1600 这种量级常见「只有 reasoning_content、正文为空」的结果（见 emptyContentReason）。
  maxTokens: 4000,
  timeoutMs: 120000,
};

// 历史报告上限：报告正文 3–5KB，超过这个数会把 state.json 撑大且淹没最近结果
export const AI_HISTORY_MAX = 12;

export const AI_SYSTEM_PROMPT = [
  "你是一位资深的公募基金组合分析师，服务于中国个人投资者。你会收到一份由本地工具导出的真实持仓快照，请基于快照数据做客观分析。",
  "",
  "硬性要求：",
  "1. 只使用快照中给出的数据，不得臆造净值、涨跌幅、持仓或市场信息；快照没给的数据要明确写「数据缺失」。",
  "2. 每个数值判断都要给出依据（引用具体基金代码与数字），不要泛泛而谈。",
  "3. 注意快照的「当日口径」列：标注为「重仓拟合估算」或「场内ETF实时价」的当日涨跌是盘中估算值，不是官方净值涨跌，引用时必须说明这一点。",
  "4. 若某只基金没有行情数据（净值未加载），不要为它编造收益，直接说明该基金本次未参与计算。",
  "5. 不做择时预测、不承诺收益。建议要具体可执行（例如调整某类资产的仓位比例、补充某类资产），但不要给出精确到买入价格的指令。",
  "6. 输出中文 Markdown，严格按以下小节组织，标题文字不要改动：",
  "   ## 一、组合概览",
  "   ## 二、风险与集中度",
  "   ## 三、重点持仓点评",
  "   ## 四、可执行的调整建议",
  "   ## 五、风险提示",
  "7. 最后一节必须以这一行结尾：以上分析基于本地持仓数据自动生成，不构成投资建议。",
  "8. 全文控制在 800 字以内，直接给结论和依据，不要复述整张数据表。",
].join("\n");

const DAY_SRC_LABEL = { nav: "最新净值", fit: "重仓拟合估算", etf: "场内ETF实时价" };

// ---------- 小工具（内联，不引 utils.js） ----------
function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : (d === undefined ? 0 : d);
}
function rnd(v, n) {
  const x = Number(v);
  return Number.isFinite(x) ? Number(x.toFixed(n)) : null;
}
function nice(v, digits) {
  const x = rnd(v, digits);
  return x === null ? "--" : String(x);
}

// 把用户填的「接口地址」补成完整的 chat/completions 端点。
// 各家 OpenAI 兼容服务的基址深浅不一（DeepSeek 用 /v1、智谱用 /api/paas/v4、
// 通义用 /compatible-mode/v1），因此按「是否已带版本段」判断，而不是硬拼 /v1。
export function resolveEndpoint(baseUrl) {
  const u = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!u) return "";
  if (/\/chat\/completions$/i.test(u)) return u;      // 已经是完整端点
  if (/\/v\d+[a-z]*$/i.test(u)) return u + "/chat/completions"; // …/v1、…/v4、…/compatible-mode/v1
  return u + "/v1/chat/completions";                  // 只给了主机名/路径前缀
}

// ============================ 快照组装 ============================
// sum：视图 computeHoldSummary() 的返回值（口径与界面完全一致）
// extras：{ stamp, estDates, estAt, calib, mode } —— 由视图提供，模块不碰时钟与 DOM
export function buildSnapshot(sum, extras) {
  const e = extras || {};
  const s = sum || {};
  const hq = s.hq || {};
  const holdings = Array.isArray(s.holdings) ? s.holdings : [];
  const totalMarket = num(s.totalMarket);

  const items = holdings.map((h) => {
    const c = hq[h.id] || {};
    const hasData = !!c.hasData;
    const market = hasData ? num(c.market) : null;
    return {
      code: h.code || "",
      name: h.name || "",
      shares: rnd(c.shares, 2),
      unitCost: rnd(h.unitCost, 4),
      cost: rnd(c.cost, 2),
      nav: hasData ? rnd(c.nav, 4) : null,
      // 净值日期按代码由视图提供（避免往 F.holdings 里塞临时字段）
      navDate: hasData ? ((e.navDates || {})[h.code] || null) : null,
      market: market === null ? null : rnd(market, 2),
      // 占比 = 该只市值 / 组合总市值（含未取到行情的持仓，与穿透分析同口径）
      weight: hasData && totalMarket > 0 ? rnd((market / totalMarket) * 100, 2) : null,
      dayPct: hasData && c.dayPct !== null && c.dayPct !== undefined ? rnd(c.dayPct, 2) : null,
      dayProfit: hasData ? rnd(c.dayProfit, 2) : null,
      daySrc: hasData ? (DAY_SRC_LABEL[c.daySrc] || c.daySrc || "") : "",
      totalProfit: hasData ? rnd(c.totalProfit, 2) : null,
      totalPct: hasData && num(c.cost) > 0 ? rnd(c.totalPct, 2) : null,
    };
  });
  // 按市值降序：让 AI 优先点评权重大的持仓，也便于它直接判断集中度
  items.sort((a, b) => num(b.market, -1) - num(a.market, -1));

  // 集中度（占总市值，与界面穿透分析口径一致）：供 AI 直接引用，减少它自己算错
  const withMarket = items.filter((it) => it.market !== null);
  const sumTop = (n) => {
    if (!totalMarket || !withMarket.length) return null;
    const v = withMarket.slice(0, n).reduce((acc, it) => acc + it.market, 0);
    return rnd((v / totalMarket) * 100, 2);
  };
  const cal = e.calib || null;

  return {
    generatedAt: e.stamp || "",
    quoteMode: e.mode || (num(s.estCnt) > 0 ? "盘中估算" : "最新净值口径"),
    quoteDates: Array.isArray(e.estDates) ? e.estDates.slice() : [],
    quoteAt: e.estAt ? num(e.estAt) : 0,
    calib: cal ? { n: num(cal.n), mae: rnd(cal.mae, 2), hit: rnd(cal.hit, 3) } : null,
    count: items.length,
    countedCount: withMarket.length,
    hasQuotes: !!s.hasQuotes,
    totals: {
      market: s.hasQuotes ? rnd(totalMarket, 2) : null,
      cost: rnd(s.totalCost, 2),
      profit: s.hasQuotes ? rnd(num(s.totalProfit), 2) : null,
      profitPct: s.hasQuotes ? rnd(num(s.totalPct), 2) : null,
      dayProfit: s.hasQuotes ? rnd(num(s.totalDay), 2) : null,
    },
    concentration: { top1: sumTop(1), top5: sumTop(5), top10: sumTop(10) },
    items,
  };
}

// ============================ 提示词组装 ============================
export function buildUserPayload(snapshot) {
  const s = snapshot || {};
  const t = s.totals || {};
  const lines = [];
  lines.push(`快照时间：${s.generatedAt || "未知"}`);
  lines.push(`数据口径：${s.quoteMode}${s.quoteDates.length ? `（行情日 ${s.quoteDates.join(" / ")}）` : ""}`);
  if (s.calib && s.calib.n) {
    lines.push(`估值校准样本：${s.calib.n} 次 · 平均绝对偏差 ${nice(s.calib.mae, 2)}pp（盘中估算值的实测精度，供判断当日数字可信度）`);
  }
  lines.push("");
  lines.push("【组合汇总】");
  lines.push(`基金数：${s.count} 只（其中本次取到行情 ${s.countedCount} 只）`);
  lines.push(`总市值：${t.market === null ? "数据缺失" : nice(t.market, 2) + " 元"}`);
  lines.push(`总成本：${nice(t.cost, 2)} 元`);
  lines.push(`累计盈亏：${t.profit === null ? "数据缺失" : nice(t.profit, 2) + " 元（" + nice(t.profitPct, 2) + "%）"}`);
  lines.push(`当日盈亏：${t.dayProfit === null ? "数据缺失" : nice(t.dayProfit, 2) + " 元"}`);
  const c = s.concentration || {};
  lines.push(`集中度（占总市值）：Top1 ${c.top1 === null || c.top1 === undefined ? "--" : nice(c.top1, 2) + "%"} · Top5 ${c.top5 === null || c.top5 === undefined ? "--" : nice(c.top5, 2) + "%"} · Top10 ${c.top10 === null || c.top10 === undefined ? "--" : nice(c.top10, 2) + "%"}`);
  lines.push("");
  lines.push("【持仓明细】按市值降序，占比为占总市值百分比");
  lines.push("代码|名称|份额|单位成本|持仓成本|最新净值|市值|占比%|当日涨跌%|当日盈亏|累计盈亏|累计收益率%|当日口径");
  for (const it of s.items || []) {
    if (it.market === null) {
      lines.push(`${it.code}|${it.name}|${nice(it.shares, 2)}|${nice(it.unitCost, 4)}|${nice(it.cost, 2)}|-|-|-|-|-|-|-|无行情数据（净值未加载，本次未计入）`);
      continue;
    }
    lines.push([
      it.code, it.name, nice(it.shares, 2), nice(it.unitCost, 4), nice(it.cost, 2),
      nice(it.nav, 4), nice(it.market, 2), nice(it.weight, 2), nice(it.dayPct, 2),
      nice(it.dayProfit, 2), nice(it.totalProfit, 2), nice(it.totalPct, 2), it.daySrc,
    ].join("|"));
  }
  lines.push("");
  lines.push("请按系统提示要求的小节结构输出分析。");
  return lines.join("\n");
}

export function buildMessages(snapshot, opts) {
  const o = opts || {};
  return [
    { role: "system", content: o.system || AI_SYSTEM_PROMPT },
    { role: "user", content: buildUserPayload(snapshot) },
  ];
}

// ============================ 响应解析 ============================
// 把响应正文压成一行短文本：报错要带上原始响应，但不能把整页 HTML / 长 JSON 灌进界面
function snippet(text, n) {
  const s = String(text == null ? "" : text).replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n) + "…" : s;
}

// 「正文为空」是接大模型时最常撞上、又最难自己看出原因的一类失败。
// 把 finish_reason / 思考链 token 数 / 原始响应一次摊开，让报错本身就能定位问题：
// 思考型模型（deepseek-reasoner、o1 系）会先把输出预算花在 reasoning_content 上，
// 预算不够时正文就是空的 —— 这类场景光说「内容为空」用户无从下手。
function emptyReason(o) {
  const reason = o.reason || "未提供";
  const usage = o.usage && typeof o.usage === "object" ? o.usage : {};
  const det = usage.completion_tokens_details || {};
  const shown = (v) => (v === null || v === undefined ? "未知" : v);
  const parts = [];
  if (num(o.thinkLen, 0) > 0) {
    parts.push(`模型只产出思考过程（reasoning_content ${num(o.thinkLen, 0)} 字）而正文为空，这是思考型模型（deepseek-reasoner / o1 系）的典型表现`);
    parts.push(`本次 reasoning_tokens=${shown(det.reasoning_tokens)}、completion_tokens=${shown(usage.completion_tokens)}，输出预算被思考链耗尽`);
    parts.push("请把「最大输出」调大（建议 ≥4000）或改用非思考模型");
  } else if (reason === "length") {
    parts.push("输出被 max_tokens 截断（finish_reason=length），正文尚未产生就到达上限，请把「最大输出」调大后重试");
  } else if (reason === "content_filter") {
    parts.push("内容被服务端安全过滤（finish_reason=content_filter），可尝试换用其他模型");
  } else {
    parts.push(`接口返回内容为空（finish_reason=${reason}）`);
    parts.push("常见原因：模型名填错、该服务不兼容 /chat/completions 协议、或账号额度已用尽");
  }
  return parts.join("；") + "。原始响应：" + snippet(o.raw, 300);
}

function emptyContentReason(ch, j, text) {
  const msg = ch.message || {};
  const think = typeof msg.reasoning_content === "string" ? msg.reasoning_content.trim() : "";
  return emptyReason({ reason: ch.finish_reason, thinkLen: think.length, usage: j.usage, raw: text });
}

// 流式路径的同类诊断：解析器只记了思考链字数与 finish_reason，没有 message 对象。
// 必须单独走这条路 —— 否则「正文为空」会被下游误报成「接口返回的不是 JSON」，
// 把真正的成因（思考链吃光预算）彻底盖掉（这是实测踩到的坑）。
export function streamEmptyReason(st) {
  return emptyReason({ reason: st.finishReason, thinkLen: st.reasoning, usage: st.usage, raw: st.raw });
}

// 判断一段文本是不是 SSE 分块流（服务端按 stream:true 回，调用方却拿到整段文本）
const SSE_HINT = /(^|[\r\n])\s*data:/;

// 兼容 OpenAI Chat Completions 形状：choices[0].message.content；
// 另兜底 text 补全形状（choices[0].text）与部分服务把 content 返回成数组分段的情况。
export function extractContent(text) {
  // SSE 分块流：用同一个流式解析器再解析一遍，而不是当成 JSON 报「不是 JSON」——
  // 那句报错会把真正的失败原因盖掉。顺带也成了流式增量的兜底：万一某几块没被增量解析器收下，
  // 这里拿整段原文重放仍能把正文捞回来。
  if (SSE_HINT.test(String(text == null ? "" : text))) {
    const p = createStreamParser();
    p.push(text);
    p.flush();
    const st = p.state();
    if (st.error) throw new Error(st.error);
    if (!st.content.trim()) throw new Error(streamEmptyReason(st));
    return {
      content: st.content.trim(),
      model: st.model || "",
      usage: st.usage || null,
      finishReason: st.finishReason || "",
    };
  }
  let j;
  try {
    j = JSON.parse(text);
  } catch (_) {
    // 非 JSON 响应（网关 HTML 错误页等）：截断原文，别把整页 HTML 丢进报告里
    throw new Error("接口返回的不是 JSON：" + snippet(text, 180));
  }
  if (j && j.error) {
    const msg = j.error.message || j.error.msg || j.error.code || "接口报错";
    throw new Error(String(msg));
  }
  const ch = Array.isArray(j && j.choices) ? j.choices[0] : null;
  if (!ch) throw new Error("接口响应里没有 choices 字段：" + snippet(text, 180));
  const msg = ch.message || {};
  // 注意用 !== undefined 判定：content 为 null 时要落到 text 兜底，而不是把 null 当字符串
  let content = msg.content !== undefined && msg.content !== null ? msg.content : ch.text;
  if (Array.isArray(content)) {
    content = content.map((p) => (typeof p === "string" ? p : (p && p.text) || "")).join("");
  }
  if (typeof content !== "string" || !content.trim()) throw new Error(emptyContentReason(ch, j, text));
  return {
    content: content.trim(),
    model: (j && j.model) || "",
    usage: (j && j.usage) || null,
    finishReason: ch.finish_reason || "",
  };
}

// ============================ 流式解析 ============================
// SSE 增量解析器：把 Rust 逐块推来的原始文本喂进去，累积出正文 / 思考字数 / 元信息。
// 与 extractContent 放在同一处维护「响应长什么样」，避免传输层与解析层各写一套。
// 需兼容三种到达形态：
//   ① 标准 SSE：`data: {...}` 逐块，末尾 `data: [DONE]`（主流 OpenAI 兼容服务）
//   ② 服务端不理会 stream:true，一次性返回完整 JSON（会落在同一行里）
//   ③ 网关错误页 / 非 JSON 文本（交由调用方用 extractContent 兜底）
export function createStreamParser() {
  let carry = "";   // 上一块的末段可能被切在半行中间，留到下一块拼接
  let content = "";
  let reasoning = 0;
  let raw = "";
  let done = false;
  let model = "";
  let usage = null;
  let sawSse = false;
  let error = "";
  let finishReason = "";

  function takeLine(line) {
    const t = line.trim();
    if (!t || !t.startsWith("data:")) return; // 空行与 `: ping` 注释行忽略
    const data = t.slice(5).trim();
    if (data === "[DONE]") { done = true; return; }
    let j;
    try { j = JSON.parse(data); } catch (_) { return; }
    if (j && j.error) {
      error = String(j.error.message || j.error.msg || j.error.code || "接口报错");
      done = true;
      return;
    }
    if (j && j.model) model = String(j.model);
    if (j && j.usage) usage = j.usage;
    const ch = Array.isArray(j && j.choices) ? j.choices[0] : null;
    if (!ch) return;
    sawSse = true;
    const d = ch.delta || {};
    if (typeof d.reasoning_content === "string") reasoning += d.reasoning_content.length;
    let piece = d.content;
    if (Array.isArray(piece)) piece = piece.map((p) => (typeof p === "string" ? p : (p && p.text) || "")).join("");
    if (typeof piece === "string") content += piece;
    // finish_reason 要留下来：「正文为空」的成因诊断全靠它（length=被截断 / content_filter=安全过滤）
    if (ch.finish_reason) { finishReason = String(ch.finish_reason); done = true; }
  }

  return {
    push(text) {
      const s = String(text == null ? "" : text);
      raw += s;
      const parts = (carry + s).split(/\r?\n/);
      carry = parts.pop() || "";
      for (const line of parts) takeLine(line);
    },
    /** 流结束：处理残留的半行（服务端最后一行常常不带换行） */
    flush() {
      if (carry) { takeLine(carry); carry = ""; }
    },
    state() {
      return { content, reasoning, raw, done, model, usage, sawSse, error, finishReason };
    },
  };
}

// ============================ 主入口 ============================
export function createFundAi(ports) {
  const p = ports || {};
  const httpPost = p.httpPost;
  const now = p.now || (() => 0);

  // 请求体组装（非流式与流式共用）：视图走 http_post_stream 时直接取这里，
  // 避免「参数拼两遍」——两处一旦不同步，流式与非流式就会用上不同的模型或上限。
  function buildRequestBody(snapshot, cfg, opts) {
    return JSON.stringify({
      model: cfg.model,
      messages: buildMessages(snapshot, { system: cfg.systemPrompt || AI_SYSTEM_PROMPT }),
      temperature: num(cfg.temperature, AI_DEFAULTS.temperature),
      max_tokens: Math.max(256, Math.min(8000, num(cfg.maxTokens, AI_DEFAULTS.maxTokens))),
      stream: !!(opts && opts.stream),
    });
  }

  async function analyze(input) {
    const cfg = input && input.config ? input.config : {};
    const endpoint = resolveEndpoint(cfg.baseUrl);
    if (!endpoint) throw new Error("请先填写接口地址");
    if (!cfg.apiKey) throw new Error("请先填写 API Key");
    if (!cfg.model) throw new Error("请先填写模型名称");
    if (typeof httpPost !== "function") throw new Error("缺少网络通道");

    const body = buildRequestBody(input.snapshot, cfg, { stream: false });
    const timeoutMs = Math.max(1000, Math.min(600000, num(cfg.timeoutMs, AI_DEFAULTS.timeoutMs)));
    const t0 = now();
    const txt = await httpPost(
      endpoint,
      body,
      { "Content-Type": "application/json", "Authorization": "Bearer " + cfg.apiKey },
      timeoutMs,
    );
    const res = extractContent(txt);
    return {
      content: res.content,
      model: res.model || cfg.model,
      usage: res.usage,
      endpoint,
      ms: now() - t0,
    };
  }

  // buildRequestBody 必须导出：视图走流式通道（http_post_stream）时直接复用这一份组装，
  // 少一处「参数拼两遍」就少一次流式/非流式参数漂移
  return { analyze, buildSnapshot, buildMessages, buildUserPayload, extractContent, resolveEndpoint, buildRequestBody };
}
