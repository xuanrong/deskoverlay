// 基金估值核心：重仓股拟合估值 + 精度自校准 + 「当日涨跌」口径裁决 + 持仓穿透聚合。
//
// 设计目标：**与 DOM、视图闭包、`state` 完全解耦**，可脱离整个应用单独跑单测。
//   · 不 import 任何东西（连 utils 也不）——因此 Node 可以用 `data:` URL 直接把它当 ESM 导入，
//     不必给整个前端目录加 `"type": "module"`；
//   · 不计时也不读全局时钟——时钟由 `now()` 端口注入，于是「15:00 收盘分界」这类
//     与时段耦合的逻辑可以在测试里钉死时间（此前测试会随之在 15:00 前后给出不同结论）；
//   · 不直接读写 `state.fund`——校准样本容器由 `calib` 端口提供。
//
// 数据源（仍走宿主 Rust `http_get` 代理）：
//   fundf10.eastmoney.com/FundArchivesDatas.aspx?type=jjcc   → 股票投资明细（含占净值比例）
//   hq.sinajs.cn/list=…                                      → A股/港股/美股混合批量行情
export function createEstimator(ports) {
  const {
    http,            // (url, headers) => Promise<string>
    getQuote,        // (code) => quote | undefined（取 stockPos / navDate / gszzl）
    navSeries,       // (code) => Promise<Array|null>（校准回填用；与收益曲线共用内存缓存）
    calib,           // { all: () => object, persist: () => void }
    referers,        // { f10, sina }
    isTrading,       // () => boolean
    ymd,             // (Date) => "YYYY-MM-DD"（本地时区）
    now = () => Date.now(),
  } = ports;

  const C = Object.assign({
    STOCK_BATCH: 120,                 // 新浪 hq 单次批量代码数（URL 长度保护）
    TTL_POSITION: 12 * 60 * 60 * 1000, // 持仓明细缓存（季报口径，半天更新一次足够）
    EST_MIN_COVER: 30,                // 覆盖率（Σ占净值比）低于此值不估算
    EST_MIN_DETAIL: 3,                // 命中个股少于此数不估算
    POS_CONC: 4,                      // 东财 F10 并发上限（>4 会限流，实测个别基金静默失败）
    CALIB_MAX: 40,                    // 每只基金最多保留的样本数
    CALIB_MIN_N: 3,                   // 少于此样本数不给统计（噪声主导）
    CALIB_HIT_PP: 0.2,                // |偏差| ≤ 0.2pp 记为「命中」
    CALIB_SWEEP_GAP: 3 * 60 * 60 * 1000, // 收盘后补采样间隔（同一会话内不必高频重跑）
    CALIB_STALE_DAYS: 30,             // 超过这么多天仍未回填的样本一律清理
    LOOK_MIN_VALUE: 0.01,             // 穿透分析：低于 1 分钱的个股暴露忽略
  }, ports.consts || {});

  const posMemo = new Map();   // 基金代码 -> { at, list, reportDate, covered }
  const estMemo = new Map();   // 基金代码 -> 估值结果（仅内存，不落盘）
  let estAt = 0;               // 最近一次估值完成时间
  // 本轮估值所依据的行情交易日（已排序）。必须按**单只基金实际命中的持仓**归属，不能取全市场最大日期：
  // A股/港股休市时其行情仍标为上个交易日（2026-10-01 国庆：A股 p[30]=09-30、港股 p[17]=09-30），
  // 而美股行情此时已标为当天（gb_* p[3]=10-01）。取全局最大会让「持有一只美股」污染所有基金，
  // 使纯 A 股基金的 hqDate 被推到净值尚未覆盖的日期，从而在官方净值已公布后仍继续显示估算。
  let estDates = [];
  let calibSweepAt = 0;
  let calibRunning = false;

  // ---------- 基础解析 ----------

  // 宽松数字解析：空串必须返回 null（Number("") === 0，直接转换会把「无数据」当成合法的 0%）
  function parseNumLoose(v) {
    const s = String(v === null || v === undefined ? "" : v).trim();
    if (s === "") return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  // 东财统一行情码（市场.代码）→ 新浪符号。1=沪 0=深 116=港股 105/106/107=美股（其余市场不参与估算）
  function emToSina(market, code) {
    const c = String(code || "").trim();
    if (!c) return null;
    if (market === "1") return /^\d{6}$/.test(c) ? "sh" + c : null;
    if (market === "0") return /^\d{6}$/.test(c) ? "sz" + c : null;
    if (market === "116") return "hk" + c.padStart(5, "0");
    if (market === "105" || market === "106" || market === "107") return "gb_" + c.toLowerCase().replace(/[^a-z0-9.]/g, "");
    return null;
  }

  // ---------- 取数 ----------

  // 拉取并解析单只基金的股票投资明细。topline=50 —— 披露多少取多少（年报/半年报为全量持仓）
  async function fetchPositions(code) {
    const hit = posMemo.get(code);
    if (hit && now() - hit.at < C.TTL_POSITION) return hit;
    const url = `https://fundf10.eastmoney.com/FundArchivesDatas.aspx?type=jjcc&code=${encodeURIComponent(code)}&topline=50&year=&month=&rt=${now()}`;
    let raw;
    try {
      raw = await http(url, referers.f10);
    } catch (e) {
      // 请求失败（限流/超时）：回退过期缓存——持仓是季报数据，超期数小时仍有参考价值；无缓存才向上抛
      if (hit) return hit;
      throw e;
    }
    const rec = { at: now(), list: [], reportDate: "", covered: 0 };
    const m = /content:"([\s\S]*?)",arryear:/.exec(raw);
    if (m) {
      const html = m[1].replace(/\\"/g, '"');
      const dm = /截止至：[\s\S]{0,80}?(\d{4}-\d{2}-\d{2})/.exec(html);
      rec.reportDate = dm ? dm[1] : "";
      // 第 1 个 tbody = 股票投资明细（第 2 个是按市值排序的附表，无占净值比例，忽略）
      const tb = /<tbody>([\s\S]*?)<\/tbody>/.exec(html);
      if (tb) {
        for (const tr of tb[1].split("<tr>").slice(1)) {
          const em = /unify\/r\/(\d+)\.([A-Za-z0-9.]+)/.exec(tr);
          if (!em) continue;
          const sym = emToSina(em[1], em[2]);
          if (!sym) continue;
          const tds = (tr.match(/<td[^>]*>[\s\S]*?<\/td>/g) || []).map((x) => x.replace(/<[^>]+>/g, "").trim());
          // 列序：序号|股票代码|股票名称|最新价|涨跌幅|相关资讯|占净值比例|持股数|持仓市值
          let w = parseNumLoose(String(tds[6] || "").replace("%", ""));
          if (w === null) {
            const t = tds.find((x) => /^\d+(\.\d+)?%$/.test(x));
            w = t ? parseNumLoose(t.replace("%", "")) : null;
          }
          if (w === null || w <= 0) continue;
          rec.list.push({ sym, code: em[2], name: tds[2] || em[2], weight: w });
        }
      }
      rec.covered = rec.list.reduce((s, x) => s + x.weight, 0);
    }
    posMemo.set(code, rec);
    return rec;
  }

  // 批量取个股行情（A股 / 港股 / 美股混合）→ { map: Map<新浪符号, { pct, date }>, date: 全市场最大交易日 }
  // date 逐符号返回，是因为各市场休市安排不同：同一次批量请求里 A 股可能还是上一个交易日、
  // 美股却已翻篇。由调用方按「本基金实际命中的持仓」聚合，才能得到该基金真正的行情基准日。
  async function fetchStockQuotes(syms) {
    const out = new Map();
    let hqDate = "";
    const uniq = Array.from(new Set(syms.filter(Boolean)));
    if (!uniq.length) return { map: out, date: hqDate };
    const batches = [];
    for (let i = 0; i < uniq.length; i += C.STOCK_BATCH) batches.push(uniq.slice(i, i + C.STOCK_BATCH));
    // 注意：逗号必须是原始字符，列表末尾不得追加任何 query 参数（sina 是「路径式」接口）
    const raws = await Promise.all(
      batches.map((b) => http(`https://hq.sinajs.cn/list=${b.join(",")}`, referers.sina).catch(() => ""))
    );
    for (const raw of raws) {
      for (const line of String(raw || "").split("\n")) {
        const m = /hq_str_([A-Za-z0-9_]+)="([^"]*)"/.exec(line);
        if (!m) continue;
        const sym = m[1], p = m[2].split(",");
        // 行情所属交易日：A股 p[30]=2026-09-30 / 港股 p[17]=2026/09/30 / 美股 p[3]=2026-10-01 09:49:26
        const dstr = sym.startsWith("hk") ? String(p[17] || "").replace(/\//g, "-")
          : sym.startsWith("gb_") ? String(p[3] || "").slice(0, 10)
            : String(p[30] || "");
        const okDate = /^\d{4}-\d{2}-\d{2}$/.test(dstr) ? dstr : "";
        if (okDate && okDate > hqDate) hqDate = okDate;
        let pct = null;
        if (sym.startsWith("hk")) {
          // …今开(2) 昨收(3) 最高(4) 最低(5) 现价(6) 涨跌额(7) 涨跌幅(8)…
          pct = parseNumLoose(p[8]);
        } else if (sym.startsWith("gb_")) {
          // 名称(0) 现价(1) 涨跌幅(2) 时间(3) 涨跌额(4)…
          pct = parseNumLoose(p[2]);
        } else {
          // A 股：名称(0) 今开(1) 昨收(2) 现价(3)…（自算，避免依赖行情未开盘时的空字段）
          const price = parseNumLoose(p[3]), prev = parseNumLoose(p[2]);
          if (price !== null && prev !== null && prev > 0) pct = ((price - prev) / prev) * 100;
        }
        if (pct === null) continue;
        out.set(sym, { pct, date: okDate });
      }
    }
    return { map: out, date: hqDate };
  }

  // ---------- 估值 ----------

  // 为一批基金构建估值：并发拉持仓 → 汇总个股去重 → 一次批量取行情 → 加权
  async function buildEstimates(codes) {
    const uniq = Array.from(new Set((codes || []).filter(Boolean)));
    if (!uniq.length) return;
    // 分批拉取持仓：东财对并发 F10 请求会限流，全部并发时实测会出现个别基金静默失败
    const posRecs = new Array(uniq.length).fill(null);
    for (let i = 0; i < uniq.length; i += C.POS_CONC) {
      const part = uniq.slice(i, i + C.POS_CONC);
      const res = await Promise.all(part.map((c) => fetchPositions(c).catch(() => null)));
      res.forEach((r, j) => { posRecs[i + j] = r; });
    }
    const allSyms = [];
    posRecs.forEach((r) => { if (r) for (const s of r.list) allSyms.push(s.sym); });
    const hq = await fetchStockQuotes(allSyms);
    const hqMap = hq.map;
    const dateSet = new Set();
    uniq.forEach((code, i) => {
      const pos = posRecs[i];
      // 本次未取到持仓（网络/限流）：保留上一轮估值，避免盘中一次抖动让整个账本的估算消失
      if (!pos) return;
      if (!pos.list.length) { estMemo.delete(code); return; }
      const detail = [];
      let sumWR = 0, sumW = 0, fundDate = "";
      for (const s of pos.list) {
        const r = hqMap.get(s.sym);
        if (r === undefined) continue;   // 该个股暂无行情（停牌/退市/接口缺项）→ 不计入
        sumWR += s.weight * r.pct;
        sumW += s.weight;
        if (r.date > fundDate) fundDate = r.date;   // 本基金实际命中持仓中的最新交易日
        detail.push({ sym: s.sym, code: s.code, name: s.name, weight: s.weight, pct: r.pct });
      }
      // 覆盖率过低（ETF 联接 / 债券型）或命中个股太少时不做估算：
      // 样本噪声与口径缺失造成的偏差，可能比估算本身更有害
      if (detail.length < C.EST_MIN_DETAIL || sumW <= 0 || pos.covered < C.EST_MIN_COVER) {
        estMemo.delete(code);
        return;
      }
      const hqDate = fundDate || hq.date;         // 该基金估值所依据的行情日（按自身持仓归属）
      dateSet.add(hqDate);
      const q = getQuote(code);
      const declared = parseNumLoose(q && q.stockPos) || 0;   // pingzhongdata 披露的「股票占净值比例」
      // 股票仓位不可能低于已覆盖的重仓股权重和，取二者较大值并封顶 100
      const posShare = Math.min(100, Math.max(declared > 0 ? declared : 0, pos.covered));
      const normPct = sumWR / sumW;               // 股票部分的加权涨幅（未覆盖部分按同比例外推）
      detail.sort((a, b) => b.weight - a.weight);
      const estPct = normPct * (posShare / 100);  // 折算到全基金：股票仓位 × 股票部分涨幅
      estMemo.set(code, {
        code,
        pct: estPct,
        normPct,
        avgPct: detail.reduce((a, b) => a + b.pct, 0) / detail.length,
        covered: pos.covered,                     // 已披露持仓占净值比例（覆盖率）
        posShare,                                 // 股票仓位
        hit: detail.length, total: pos.list.length,
        reportDate: pos.reportDate,
        hqDate,                                   // 行情所属交易日（用于判断估值是否已被净值覆盖）
        detail,                                   // 已按权重降序
        at: now(),
      });
      // 精度校准：仅在行情已收盘时入样（盘中价与官方日增长率不可比）
      recordCalibration(code, hqDate, estPct);
    });
    estAt = now();
    estDates = Array.from(dateSet).sort();
  }

  // ---------- 估值结果读取（视图与穿透共用） ----------

  const getEstimate = (code) => estMemo.get(code);
  const allEstimates = () => [...estMemo.values()];
  const positions = (code) => posMemo.get(code);
  const hasPositions = (code) => posMemo.has(code);
  const clearPositions = () => posMemo.clear();
  const getEstAt = () => estAt;
  const getEstDates = () => estDates;

  // ---------- 持仓穿透（Look-through） ----------
  // 用「基金持仓市值 × 个股占净值比」把各基金的重仓股还原成「我实际持有的股票」，
  // 回答季报明细本身答不了的两个问题：钱最终压在哪几只股票上、几只基金是否在重复押注。
  // 复用 posMemo（季报口径），与「是否需要盘中估值」无关，非交易时段同样可用。
  //
  // 设计要点：**聚合函数是纯的**——只吃「调用方已算好市值的持仓行」，不读 state、不算净值。
  // 市值口径属于视图（最新净值 / 盘中估算 / 场内 ETF 实时价三种可能），模块不该猜。
  // 副作用只有一件事：`ensurePositions` 负责把 posMemo 填上（含 12h TTL 与并发分批）。

  // 确保持仓明细可用（穿透视图专用；不依赖 buildEstimates 的交易时段判断）。
  //
  // 返回「**本次是否新增了**可用持仓」——注意不是「是否有可用持仓」：TTL 过期后重取成功
  // 仍返回 false（数据一直都在，只是刷新了）。全部失败必为 false。
  // 本函数**不会 reject**（内部逐个 catch，http 失败只表现为没落缓存）。
  //
  // 视图侧目前不分支于此值（成功/失败都只是重渲染，空态由 stocks.length 兜住），
  // 「只自动加载一次」的防循环守卫在视图层的 lookLoaded —— 不要把这个返回值当成守卫。
  async function ensurePositions(codes) {
    const uniq = Array.from(new Set((codes || []).filter(Boolean)));
    const todo = uniq.filter((c) => {
      const h = posMemo.get(c);
      return !h || now() - h.at > C.TTL_POSITION;
    });
    if (!todo.length) return false;
    const before = todo.filter((c) => posMemo.has(c)).length;
    for (let i = 0; i < todo.length; i += C.POS_CONC) {
      const part = todo.slice(i, i + C.POS_CONC);
      await Promise.all(part.map((c) => fetchPositions(c).catch(() => null)));
    }
    return todo.filter((c) => posMemo.has(c)).length > before;
  }

  // 穿透汇总 → { stocks, funds, totalValue, coveredValue, coverage, concentration }
  // rows: [{ code, name, market }]，market 为「我持有该基金的市值」（口径由调用方定）
  // posOf 可注入，便于测试；生产走默认的 posMemo 读取
  function buildLookThrough(rows, posOf = positions) {
    // 个股当日涨跌：直接复用本轮估值结果（非交易时段为空，此时不展示该列）
    const symPct = new Map();
    for (const e of estMemo.values()) {
      for (const d of e.detail) if (d.sym && !symPct.has(d.sym)) symPct.set(d.sym, d.pct);
    }

    const agg = new Map();   // sym -> { sym, code, name, value, funds: Map<基金代码, 市值> }
    const funds = [];
    let totalValue = 0, coveredValue = 0;
    for (const h of rows || []) {
      // 无行情 / 市值为 0 的持仓：既不出现在明细里，也不进分母（否则覆盖率会被稀释）
      if (!(h.market > 0)) continue;
      totalValue += h.market;
      const row = { code: h.code, name: h.name || h.code, market: h.market,
                    covered: 0, ratio: 0, ok: false, reportDate: "", count: 0 };
      const pos = posOf(h.code);
      if (pos && pos.list.length) {
        row.ok = true;
        row.reportDate = pos.reportDate;
        row.count = pos.list.length;
        for (const s of pos.list) {
          const v = h.market * (s.weight / 100);
          if (v < C.LOOK_MIN_VALUE) continue;   // 低于 1 分钱的暴露忽略（也不计入已穿透市值）
          row.covered += v;
          let cur = agg.get(s.sym);
          if (!cur) { cur = { sym: s.sym, code: s.code, name: s.name, value: 0, funds: new Map() }; agg.set(s.sym, cur); }
          cur.value += v;
          cur.funds.set(h.code, (cur.funds.get(h.code) || 0) + v);
        }
        coveredValue += row.covered;
        row.ratio = row.covered / h.market;
      }
      funds.push(row);
    }

    const stocks = [...agg.values()].map((s) => ({
      sym: s.sym, code: s.code, name: s.name, value: s.value,
      pct: symPct.has(s.sym) ? symPct.get(s.sym) : null,
      share: totalValue > 0 ? s.value / totalValue : 0,
      fundCount: s.funds.size,
      funds: [...s.funds.entries()].map(([code, v]) => ({ code, value: v })).sort((a, b) => b.value - a.value),
    })).sort((a, b) => b.value - a.value);

    const sumTop = (n) => stocks.slice(0, n).reduce((a, b) => a + b.value, 0);
    const share = (n) => (totalValue > 0 ? sumTop(n) / totalValue : 0);
    return {
      stocks, funds, totalValue, coveredValue,
      coverage: totalValue > 0 ? coveredValue / totalValue : 0,
      concentration: { top1: share(1), top5: share(5), top10: share(10), top20: share(20) },
    };
  }

  // 基金两两重叠度：Σ min(wA, wB) —— 「两只基金各买一半，仍有 x% 仓位押在同一批股票上」
  // 注意口径是「占净值比」而非「占总资产比」：它衡量的是**钱的重复**，与各基金股票仓位无关。
  // rows 只用到 code / name；无持仓明细的基金不参与配对。
  function buildOverlap(rows, posOf = positions) {
    const list = (rows || []).filter((r) => r && r.code);
    const codes = list.map((r) => r.code).filter((c) => { const p = posOf(c); return p && p.list.length; });
    const nameOf = (c) => { const r = list.find((x) => x.code === c); return (r && r.name) || c; };
    const wmap = new Map();
    for (const c of codes) {
      const m = new Map();
      for (const s of posOf(c).list) m.set(s.code, s.weight);
      wmap.set(c, m);
    }
    const pairs = [];
    for (let i = 0; i < codes.length; i++) {
      for (let j = i + 1; j < codes.length; j++) {
        const a = wmap.get(codes[i]), b = wmap.get(codes[j]);
        let ov = 0, shared = 0;
        for (const [k, w] of a) {
          if (b.has(k)) { ov += Math.min(w, b.get(k)); shared++; }
        }
        pairs.push({ a: codes[i], b: codes[j], aName: nameOf(codes[i]), bName: nameOf(codes[j]), overlap: ov, shared });
      }
    }
    return pairs.sort((x, y) => y.overlap - x.overlap);
  }

  // ---------- 精度自校准 ----------
  // 拟合估值能算出来不难，难的是「知道自己有多准」。这里把每次收盘后的估算值与
  // 之后公布的官方日增长率配对存下来，累积成每只基金的 MAE / 命中率 / 系统性偏差，
  // 直接展示在「估算依据」面板里 —— 估算从「能估」变成「可度量」。

  // 行情所属交易日是否已收盘。盘中取到的价格不是收盘价，与官方「日增长率」不可比，不能入样。
  function quotesClosed(date) {
    const today = ymd(new Date(now()));
    if (!date) return false;
    if (date < today) return true;
    if (date > today) return false;
    const t = new Date(now());
    return t.getHours() * 60 + t.getMinutes() >= 900;  // 15:00 收盘
  }
  function calibList(code) {
    const store = calib.all();
    let list = store[code];
    if (!Array.isArray(list)) { list = []; store[code] = list; }
    return list;
  }
  // 落一条样本（按「行情所属日」幂等）。返回是否发生了写入。
  function recordCalibration(code, date, pct) {
    if (!date || !isFinite(pct) || !quotesClosed(date)) return false;
    const list = calibList(code);
    const hit = list.find((x) => x.d === date);
    if (hit) {
      // 已回填实际值 → 锁定，不再覆盖估算值（否则会破坏配对的可比性）
      if (typeof hit.real === "number") return false;
      hit.est = pct;
      return true;
    }
    list.push({ d: date, est: pct });
    if (list.length > C.CALIB_MAX) list.splice(0, list.length - C.CALIB_MAX);
    return true;
  }
  // 统计：MAE（平均绝对偏差）、bias（系统性偏差，正=估值偏好）、命中率
  function calibStats(list) {
    const done = (list || []).filter((x) => typeof x.real === "number" && isFinite(x.est) && isFinite(x.real));
    if (done.length < C.CALIB_MIN_N) return null;
    let sumAbs = 0, sumDev = 0, maxAbs = 0, hit = 0;
    for (const x of done) {
      const dev = x.est - x.real;
      sumAbs += Math.abs(dev);
      sumDev += dev;
      if (Math.abs(dev) > maxAbs) maxAbs = Math.abs(dev);
      if (Math.abs(dev) <= C.CALIB_HIT_PP) hit++;
    }
    return {
      n: done.length,
      mae: sumAbs / done.length,
      bias: sumDev / done.length,
      max: maxAbs,
      hitRate: (hit / done.length) * 100,
    };
  }
  // 组合级校准：把各基金的样本并成一个池子，用于汇总卡副标题
  function calibOverall() {
    let sumAbs = 0, n = 0;
    for (const code of Object.keys(calib.all() || {})) {
      for (const x of calibList(code)) {
        if (typeof x.real !== "number" || !isFinite(x.est)) continue;
        sumAbs += Math.abs(x.est - x.real);
        n++;
      }
    }
    return n >= C.CALIB_MIN_N ? { n, mae: sumAbs / n } : null;
  }
  // 用净值序列回填实际值（官方日增长率；缺失时用相邻净值反推）
  async function syncCalibration() {
    if (calibRunning) return 0;
    const store = calib.all();
    const codes = Object.keys(store || {}).filter((c) =>
      calibList(c).some((x) => typeof x.real !== "number"));
    if (!codes.length) return 0;
    calibRunning = true;
    let filled = 0, pruned = 0;
    try {
      // 30 天仍未回填的样本一律清掉。**必须对所有 code 生效，不能只写在「序列取不到」分支里**：
      // 「这一日没有净值」不等于「净值尚未公布」——休市日（如 2026-10-01 国庆）A 股与 QDII
      // 都不发布净值，那个日期永远不会出现在序列里，样本会永久 pending 并占住 CALIB_MAX 槽位，
      // 把后面的有效样本挤出去（calibStats 会跳过 real 未定的样本，所以只是慢性挤占，不污染统计）。
      const staleCut = ymd(new Date(now() - C.CALIB_STALE_DAYS * 86400000));
      for (const code of codes) {
        const series = await navSeries(code);   // 与收益曲线共用 30 分钟内存缓存
        const list = calibList(code);
        if (series) {
          const idx = new Map(series.map((p, i) => [ymd(new Date(p.t)), i]));
          for (const x of list) {
            if (typeof x.real === "number") continue;
            const i = idx.get(x.d);
            if (i === undefined) continue;               // 该日无净值（未公布 / 休市）→ 下次再试
            let real = series[i].ret;
            if (!isFinite(real) && i > 0 && series[i - 1].nav > 0) {
              real = (series[i].nav / series[i - 1].nav - 1) * 100;
            }
            if (!isFinite(real)) continue;
            x.real = real;
            filled++;
          }
        }
        // 清理过期未回填（放在 if (series) 之外，见上）
        for (let i = list.length - 1; i >= 0; i--) {
          if (typeof list[i].real !== "number" && list[i].d < staleCut) { list.splice(i, 1); pruned++; }
        }
      }
      if (!filled && !pruned) return 0;
      if (pruned) { const s = calib.all(); for (const c of Object.keys(s)) if (!calibList(c).length) delete s[c]; }
      calib.persist();
    } finally {
      calibRunning = false;
    }
    return filled;
  }
  // 收盘后补采样：盘中价格不是收盘价，采不了；收盘后到净值发布之间是唯一采样窗口。
  // 独立于 shouldEstimate（那是「要不要用估算展示」的判断），因此周末/晚上打开也能补上。
  async function calibrationSweep(codes) {
    const uniq = Array.from(new Set((codes || []).filter(Boolean)));
    if (!uniq.length || isTrading()) return;
    if (now() - calibSweepAt < C.CALIB_SWEEP_GAP) return;
    calibSweepAt = now();
    try { await buildEstimates(uniq); } catch (_) { /* 网络抖动：下轮再补 */ }
    await syncCalibration();
  }

  // ---------- 「当日涨跌」口径裁决 ----------

  // 是否显示盘中估算：交易时段，或「今天是交易日但最新净值仍是昨日」（收盘后净值尚未发布）
  function shouldEstimate(q) {
    if (isTrading()) return true;
    const nowD = new Date(now());
    const day = nowD.getDay();
    if (day === 0 || day === 6) return false;
    const today = ymd(nowD);
    const nd = q && q.navDate ? q.navDate : "";
    return !!nd && nd < today;
  }

  // 单只基金「当日涨跌」取数优先级：场内 ETF 实时价 > 重仓股拟合估值 > 最新净值日涨跌
  function dayPctOf(code, q) {
    if (q && q.isEst) return { pct: parseNumLoose(q.gszzl), src: "etf" };
    const e = estMemo.get(code);
    if (e && shouldEstimate(q)) {
      // 净值已覆盖估值所依据的行情交易日（收盘净值已发布 / 休市日重复估算）→ 净值口径更准，改用它
      const covered = !!(e.hqDate && q && q.navDate && q.navDate >= e.hqDate);
      if (!covered) return { pct: e.pct, src: "fit", est: e };
    }
    return { pct: q ? parseNumLoose(q.gszzl) : null, src: "nav" };
  }

  return {
    consts: C,
    // 取数
    fetchPositions,
    fetchStockQuotes,
    // 估值
    buildEstimates,
    // 结果读取
    getEstimate, allEstimates, positions, hasPositions, clearPositions, getEstAt, getEstDates,
    // 持仓穿透（聚合为纯函数，市值口径由调用方给定）
    ensurePositions, buildLookThrough, buildOverlap,
    // 口径裁决
    shouldEstimate, dayPctOf,
    // 校准
    quotesClosed, calibList, recordCalibration, calibStats, calibOverall, syncCalibration, calibrationSweep,
    // 仅测试用：手工灌入估值结果（生产路径只由 buildEstimates 写入）
    __setEstimate: (code, v) => (v ? estMemo.set(code, v) : estMemo.delete(code)),
  };
}
