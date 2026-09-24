// 节日 / 节气 / 法定假期 —— 日期栏药丸与面板数据源（纯前端，零依赖，无网络请求）。
// 组成：
//   1) 农历转换：经典压缩位表（1900-2100），推导农历节日（春节/元宵/端午/中秋/除夕…）
//   2) 二十四节气：太阳视黄经低精度天文算法（误差约 ±0.01°，日期精确到日）
//   3) 公历节日：固定月日规则
//   4) 法定假期 + 调休补班：国务院年度通知，无法算法推导，按年内置 LEGAL 表
// 数据更新：每年 11 月国务院公布次年安排后，在 LEGAL 表追加一条即可。

const LUNAR_INFO = [
  0x04bd8, 0x04ae0, 0x0a570, 0x054d5, 0x0d260, 0x0d950, 0x16554, 0x056a0, 0x09ad0, 0x055d2, // 1900-1909
  0x04ae0, 0x0a5b6, 0x0a4d0, 0x0d250, 0x1d255, 0x0b540, 0x0d6a0, 0x0ada2, 0x095b0, 0x14977, // 1910-1919
  0x04970, 0x0a4b0, 0x0b4b5, 0x06a50, 0x06d40, 0x1ab54, 0x02b60, 0x09570, 0x052f2, 0x04970, // 1920-1929
  0x06566, 0x0d4a0, 0x0ea50, 0x06e95, 0x05ad0, 0x02b60, 0x186e3, 0x092e0, 0x1c8d7, 0x0c950, // 1930-1939
  0x0d4a0, 0x1d8a6, 0x0b550, 0x056a0, 0x1a5b4, 0x025d0, 0x092d0, 0x0d2b2, 0x0a950, 0x0b557, // 1940-1949
  0x06ca0, 0x0b550, 0x15355, 0x04da0, 0x0a5b0, 0x14573, 0x052b0, 0x0a9a8, 0x0e950, 0x06aa0, // 1950-1959
  0x0aea6, 0x0ab50, 0x04b60, 0x0aae4, 0x0a570, 0x05260, 0x0f263, 0x0d950, 0x05b57, 0x056a0, // 1960-1969
  0x096d0, 0x04dd5, 0x04ad0, 0x0a4d0, 0x0d4d4, 0x0d250, 0x0d558, 0x0b540, 0x0b6a0, 0x195a6, // 1970-1979
  0x095b0, 0x049b0, 0x0a974, 0x0a4b0, 0x0b27a, 0x06a50, 0x06d40, 0x0af46, 0x0ab60, 0x09570, // 1980-1989
  0x04af5, 0x04970, 0x064b0, 0x074a3, 0x0ea50, 0x06b58, 0x05ac0, 0x0ab60, 0x096d5, 0x092e0, // 1990-1999
  0x0c960, 0x0d954, 0x0d4a0, 0x0da50, 0x07552, 0x056a0, 0x0abb7, 0x025d0, 0x092d0, 0x0cab5, // 2000-2009
  0x0a950, 0x0b4a0, 0x0baa4, 0x0ad50, 0x055d9, 0x04ba0, 0x0a5b0, 0x15176, 0x052b0, 0x0a930, // 2010-2019
  0x07954, 0x06aa0, 0x0ad50, 0x05b52, 0x04b60, 0x0a6e6, 0x0a4e0, 0x0d260, 0x0ea65, 0x0d530, // 2020-2029
  0x05aa0, 0x076a3, 0x096d0, 0x04afb, 0x04ad0, 0x0a4d0, 0x1d0b6, 0x0d250, 0x0d520, 0x0dd45, // 2030-2039
  0x0b5a0, 0x056d0, 0x055b2, 0x049b0, 0x0a577, 0x0a4b0, 0x0aa50, 0x1b255, 0x06d20, 0x0ada0, // 2040-2049
  0x14b63, 0x09370, 0x049f8, 0x04970, 0x064b0, 0x168a6, 0x0ea50, 0x06b20, 0x1a6c4, 0x0aae0, // 2050-2059
  0x0a2e0, 0x0d2e3, 0x0c960, 0x0d557, 0x0d4a0, 0x0da50, 0x05d55, 0x056a0, 0x0a6d0, 0x055d4, // 2060-2069
  0x052d0, 0x0a9b8, 0x0a950, 0x0b4a0, 0x0b6a6, 0x0ad50, 0x055a0, 0x0aba4, 0x0a5b0, 0x052b0, // 2070-2079
  0x0b273, 0x06930, 0x07337, 0x06aa0, 0x0ad50, 0x14b55, 0x04b60, 0x0a570, 0x054e4, 0x0d160, // 2080-2089
  0x0e968, 0x0d520, 0x0daa0, 0x16aa6, 0x056d0, 0x04ae0, 0x0a9d4, 0x0a2d0, 0x0d150, 0x0f252, // 2090-2099
  0x0d520, // 2100
];

const MS_DAY = 86400000;

function leapMonth(y) { return LUNAR_INFO[y - 1900] & 0xf; }
function leapDays(y) { return leapMonth(y) ? ((LUNAR_INFO[y - 1900] & 0x10000) ? 30 : 29) : 0; }
function lMonthDays(y, m) { return (LUNAR_INFO[y - 1900] & (0x10000 >> m)) ? 30 : 29; }
function lYearDays(y) {
  let sum = 348;
  for (let i = 0x8000; i > 0x8; i >>= 1) sum += (LUNAR_INFO[y - 1900] & i) ? 1 : 0;
  return sum + leapDays(y);
}

// 公历 → 农历：{ year, month, day, isLeap }
function solarToLunar(date) {
  let offset = Math.floor((date - new Date(1900, 0, 31)) / MS_DAY);
  let i, temp = 0;
  for (i = 1900; i < 2101 && offset > 0; i++) { temp = lYearDays(i); offset -= temp; }
  if (offset < 0) { offset += temp; i--; }
  const year = i;
  const leap = leapMonth(year);
  let isLeap = false;
  for (i = 1; i < 13 && offset > 0; i++) {
    if (leap > 0 && i === leap + 1 && !isLeap) { --i; isLeap = true; temp = leapDays(year); }
    else temp = lMonthDays(year, i);
    if (isLeap && i === leap + 1) isLeap = false;
    offset -= temp;
  }
  if (offset === 0 && leap > 0 && i === leap + 1) {
    if (isLeap) isLeap = false;
    else { isLeap = true; --i; }
  }
  if (offset < 0) { offset += temp; --i; }
  return { year, month: i, day: offset + 1, isLeap };
}

const L_MONTHS = ["正", "二", "三", "四", "五", "六", "七", "八", "九", "十", "冬", "腊"];
const L_NUM = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];
function lDayName(d) {
  if (d === 10) return "初十";
  if (d === 20) return "二十";
  if (d === 30) return "三十";
  if (d < 10) return "初" + L_NUM[d - 1];
  if (d < 20) return "十" + L_NUM[d - 11];
  return "廿" + L_NUM[d - 21];
}

// 农历日期中文（如「七月廿四」）
export function lunarText(date) {
  const l = solarToLunar(date);
  return `${l.isLeap ? "闰" : ""}${L_MONTHS[l.month - 1]}月${lDayName(l.day)}`;
}

// 农历短格式（日历格小字用）：初一显示月名（如「七月」），其余只显示日（如「初五」）
export function lunarShort(date) {
  const l = solarToLunar(date);
  return l.day === 1 ? `${l.isLeap ? "闰" : ""}${L_MONTHS[l.month - 1]}月` : lDayName(l.day);
}

// ==================== 二十四节气（太阳视黄经跨越 15° 整数倍） ====================
const TERMS = [
  ["小寒", 285], ["大寒", 300], ["立春", 315], ["雨水", 330], ["惊蛰", 345], ["春分", 0],
  ["清明", 15], ["谷雨", 30], ["立夏", 45], ["小满", 60], ["芒种", 75], ["夏至", 90],
  ["小暑", 105], ["大暑", 120], ["立秋", 135], ["处暑", 150], ["白露", 165], ["秋分", 180],
  ["寒露", 195], ["霜降", 210], ["立冬", 225], ["小雪", 240], ["大雪", 255], ["冬至", 270],
];

// 太阳视黄经（低精度，±0.01°）。jd = 儒略日
function sunLambda(jd) {
  const n = jd - 2451545.0;
  const L = 280.460 + 0.9856474 * n;
  const g = ((357.528 + 0.9856003 * n) % 360) * Math.PI / 180;
  let lam = L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g);
  lam %= 360;
  return lam < 0 ? lam + 360 : lam;
}
const jdOf = (date) => date.getTime() / MS_DAY + 2440587.5;

const termCache = new Map();
function termsOfYear(y) {
  if (termCache.has(y)) return termCache.get(y);
  const jd0 = jdOf(new Date(y, 0, 1, 12)); // 每日正午采样
  const days = ((y % 4 === 0 && y % 100 !== 0) || y % 400 === 0) ? 366 : 365;
  const lam = [sunLambda(jd0)];
  for (let i = 1; i <= days; i++) {
    let l = sunLambda(jd0 + i);
    while (l < lam[i - 1] - 180) l += 360; // 展平 0°/360° 跳变（一年内单调递增）
    lam.push(l);
  }
  const base = lam[0];
  const out = [];
  for (const [name, angle] of TERMS) {
    let t = angle;
    while (t < base) t += 360;
    if (t > base + 360) t -= 360;
    let idx = -1;
    for (let i = 1; i <= days; i++) {
      if (lam[i] >= t) { idx = i; break; }
    }
    if (idx < 1) continue;
    // 线性插值精确跨越时刻 → 所在自然日为节气日
    const frac = (t - lam[idx - 1]) / (lam[idx] - lam[idx - 1] || 1);
    const cross = new Date((jd0 + idx - 1 + frac - 2440587.5) * MS_DAY);
    out.push({ m: cross.getMonth() + 1, d: cross.getDate(), name, type: "term" });
  }
  out.sort((a, b) => a.m * 40 + a.d - (b.m * 40 + b.d));
  termCache.set(y, out);
  return out;
}

// ==================== 节日 ====================
const SOLAR_FESTS = [
  [1, 1, "元旦"], [3, 8, "妇女节"], [3, 12, "植树节"], [5, 1, "劳动节"], [5, 4, "青年节"],
  [6, 1, "儿童节"], [7, 1, "建党节"], [8, 1, "建军节"], [9, 10, "教师节"], [10, 1, "国庆节"], [12, 25, "圣诞节"],
];
const LUNAR_FESTS = {
  "1-1": "春节", "1-15": "元宵节", "2-2": "龙抬头", "5-5": "端午节", "7-7": "七夕节",
  "8-15": "中秋节", "9-9": "重阳节", "12-8": "腊八节",
};

// 国务院办公厅年度通知（来源：中国政府网 2025-11-04 发布的 2026 年安排）
const LEGAL = {
  2025: [
    { name: "元旦", start: [1, 1], end: [1, 1], workdays: [] },
    { name: "春节", start: [1, 28], end: [2, 4], workdays: [[1, 26], [2, 8]] },
    { name: "清明节", start: [4, 4], end: [4, 6], workdays: [] },
    { name: "劳动节", start: [5, 1], end: [5, 5], workdays: [[4, 27]] },
    { name: "端午节", start: [5, 31], end: [6, 2], workdays: [] },
    { name: "国庆节·中秋节", start: [10, 1], end: [10, 8], workdays: [[9, 28], [10, 11]] },
  ],
  2026: [
    { name: "元旦", start: [1, 1], end: [1, 3], workdays: [[1, 4]] },
    { name: "春节", start: [2, 15], end: [2, 23], workdays: [[2, 14], [2, 28]] },
    { name: "清明节", start: [4, 4], end: [4, 6], workdays: [] },
    { name: "劳动节", start: [5, 1], end: [5, 5], workdays: [[5, 9]] },
    { name: "端午节", start: [6, 19], end: [6, 21], workdays: [] },
    { name: "中秋节", start: [9, 25], end: [9, 27], workdays: [] },
    { name: "国庆节", start: [10, 1], end: [10, 7], workdays: [[9, 20], [10, 10]] },
  ],
};

// ==================== 事件构建与查询 ====================
const stripTime = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const dKey = (d) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
const md = (y, m, d) => new Date(y, m - 1, d);

const legalCache = new Map();
function legalOf(y) {
  if (legalCache.has(y)) return legalCache.get(y);
  const list = (LEGAL[y] || []).map((h) => {
    const start = md(y, h.start[0], h.start[1]);
    const end = md(y, h.end[0], h.end[1]);
    return {
      name: h.name, start, end,
      days: Math.round((end - start) / MS_DAY) + 1,
      workdays: (h.workdays || []).map(([m, d]) => md(y, m, d)),
    };
  });
  legalCache.set(y, list);
  return list;
}

// 某年全部事件 → Map(月-日-年 key → [{name, type}])，type: festival | term | workday
const evCache = new Map();
function eventsOfYear(y) {
  if (evCache.has(y)) return evCache.get(y);
  const map = new Map();
  const add = (date, ev) => {
    const k = dKey(date);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(ev);
  };
  for (const [m, d, name] of SOLAR_FESTS) add(md(y, m, d), { name, type: "festival" });
  // 农历节日 + 除夕：逐日转农历比对（除夕 = 腊月最后一天）
  for (let i = 0; i < 366; i++) {
    const dt = new Date(y, 0, 1 + i);
    if (dt.getFullYear() !== y) break;
    const l = solarToLunar(dt);
    if (l.isLeap) continue;
    const fname = LUNAR_FESTS[`${l.month}-${l.day}`];
    if (fname) add(dt, { name: fname, type: "festival" });
    if (l.month === 12 && l.day === lMonthDays(l.year, 12)) add(dt, { name: "除夕", type: "festival" });
  }
  for (const t of termsOfYear(y)) add(md(y, t.m, t.d), { name: t.name, type: "term" });
  for (const h of legalOf(y)) {
    for (const w of h.workdays) add(w, { name: "调休补班", type: "workday" });
  }
  evCache.set(y, map);
  return map;
}

// 当日是假期中的第几天
export function holidayOf(date) {
  const base = stripTime(date);
  for (const h of legalOf(base.getFullYear())) {
    if (base >= stripTime(h.start) && base <= stripTime(h.end)) {
      return { ...h, index: Math.round((base - stripTime(h.start)) / MS_DAY) + 1 };
    }
  }
  return null;
}
// 当日是否调休补班日
export function workdayOf(date) {
  const base = stripTime(date);
  for (const h of legalOf(base.getFullYear())) {
    if (h.workdays.some((w) => stripTime(w).getTime() === base.getTime())) return h;
  }
  return null;
}

// 当日全部事件（含假期/补班标记）
export function getDayEvents(date) {
  const evs = (eventsOfYear(date.getFullYear()).get(dKey(date)) || []).slice();
  const hol = holidayOf(date);
  if (hol) evs.push({ name: `${hol.name}假期`, type: "holiday" });
  if (workdayOf(date)) evs.push({ name: "调休补班", type: "workday" });
  return evs;
}

// 未来 maxDays 内的节日/节气/补班事件
function getUpcoming(from, maxDays = 60, limit = 12) {
  const base = stripTime(from);
  const out = [];
  for (let off = 0; off <= maxDays && out.length < limit; off++) {
    const dt = new Date(base.getFullYear(), base.getMonth(), base.getDate() + off);
    for (const ev of eventsOfYear(dt.getFullYear()).get(dKey(dt)) || []) {
      out.push({ date: dt, days: off, ...ev });
      if (out.length >= limit) break;
    }
  }
  return out;
}

const fmtMD = (d) => `${d.getMonth() + 1}月${d.getDate()}日`;

// 日期栏药丸：{ text, cls, tip }。cls: "" | "today" | "today holiday" | "term"
export function pillFor(now) {
  const base = stripTime(now);
  // 1) 假期中
  const hol = holidayOf(base);
  if (hol) {
    const txt = hol.days > 1 ? `${hol.name}假期 第${hol.index}天/共${hol.days}天` : `${hol.name}假期`;
    const wd = hol.workdays.length ? `，${hol.workdays.map(fmtMD).join("、")}补班` : "";
    return { text: txt, cls: "today holiday", tip: `${hol.name}：${fmtMD(hol.start)} 至 ${fmtMD(hol.end)}，共${hol.days}天${wd}` };
  }
  // 2) 当日节日 / 节气
  const todays = getDayEvents(base);
  const fest = todays.find((e) => e.type === "festival");
  const term = todays.find((e) => e.type === "term");
  if (fest) return { text: `今日 · ${fest.name}`, cls: "today", tip: `今天是${fest.name}` };
  if (term) return { text: `今日 · ${term.name}`, cls: "today term", tip: `今天是二十四节气·${term.name}` };
  // 3) 倒计时：假期（≤60 天优先）> 最近的节日/节气
  const hols = [...legalOf(base.getFullYear()), ...legalOf(base.getFullYear() + 1)]
    .map((h) => ({ h, days: Math.round((stripTime(h.start) - base) / MS_DAY) }))
    .filter((x) => x.days > 0)
    .sort((a, b) => a.days - b.days);
  const nextHol = hols[0];
  if (nextHol && nextHol.days <= 60) {
    const wd = nextHol.h.workdays.length ? `，${nextHol.h.workdays.map(fmtMD).join("、")}补班` : "";
    return { text: `距${nextHol.h.name} ${nextHol.days} 天`, cls: "holiday", tip: `${nextHol.h.name}：${fmtMD(nextHol.h.start)} 至 ${fmtMD(nextHol.h.end)}，共${nextHol.h.days}天${wd}` };
  }
  const ups = getUpcoming(base, 45, 24);
  const nf = ups.find((e) => e.type === "festival");
  const nt = ups.find((e) => e.type === "term");
  const near = !nf ? nt : !nt ? nf : (nf.days <= nt.days ? nf : nt);
  if (near) {
    return { text: `距${near.name} ${near.days} 天`, cls: near.type === "term" ? "term" : "", tip: `${fmtMD(near.date)} · ${near.name}` };
  }
  return { text: "", cls: "", tip: "" };
}
