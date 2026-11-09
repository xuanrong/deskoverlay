#!/usr/bin/env node
/**
 * EMS 协议探针（**不是**生产代码）。
 *
 * 应用里真正的抓取实现在 `src-tauri/src/ems.rs`，由后台线程每 15 分钟跑一轮。
 * 这个脚本保留下来只有一个用途：**在不动 Rust 的前提下验证协议**。
 *
 * 什么时候用它：
 *   - EMS 改了加密方式或接口，要先快速确认 payload 结构
 *   - 怀疑 Rust 实现有问题，想拿一份「已知能跑通」的 Node 结果做对照
 *
 * ⚠ 两者必须给出同样的数字。如果对不上，先查 `args` 的索引（13 / 18），
 *   那是历史上最容易写错的地方。
 *
 * 协议要点（逆向自 EMS 前端加密模块）：
 *   - 请求体 {c, p}：c = base64(AES-128-CBC(JSON, key, iv, ZeroPadding))，p = iv + base64(RSA-512(key))
 *   - 响应 data.content = iv(16字符) + base64(AES-128-CBC(明文, 请求key, 响应iv))
 *   - key/iv 为每次请求新建的 16 字符 [0-9a-z] 随机串
 *
 * 用法：
 *   node tools/ems-probe.js
 */
"use strict";

const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

// ── 配置 ─────────────────────────────────────────────────────────────
//
// ⛔ 本文件**不得**出现任何真实主机名 / 账号 / 密码 —— 仓库是公开的。
//    配置从用户本机读取，查找顺序：
//      1. 环境变量 EMS_CONFIG 指向的文件
//      2. %APPDATA%/com.deskoverlay.desktop/ems.json
//
//    格式见仓库根的 `ems.config.example.json`。

function loadConfig() {
  const candidates = [];
  if (process.env.EMS_CONFIG) candidates.push(process.env.EMS_CONFIG);
  const appdata = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  candidates.push(path.join(appdata, "com.deskoverlay.desktop", "ems.json"));

  for (const p of candidates) {
    if (!fs.existsSync(p)) continue;
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(p, "utf8"));
    } catch (e) {
      throw new Error(`${p} 不是合法 JSON：${e.message}`);
    }
    // host 可能写成 "host:port" 或分开两段，两种都支持
    let host = String(raw.host || "").trim();
    let port = Number(raw.port) || 0;
    const m = /^(.+):(\d+)$/.exec(host);
    if (m) {
      host = m[1];
      port = port || Number(m[2]);
    }
    const need = ["username", "password", "context", "businessOfficeId", "pageId", "dataSetId", "scriptName"];
    const missing = need.filter((k) => !String(raw[k] ?? "").trim());
    if (!host) missing.unshift("host");
    if (missing.length) throw new Error(`${p} 缺少字段：${missing.join(", ")}`);

    return {
      host,
      port: port || 9392,
      context: raw.context,
      businessOfficeId: String(raw.businessOfficeId),
      username: String(raw.username),
      password: String(raw.password), // 上线时以 MD5 摘要发送
      pageId: raw.pageId,
      dataSetId: raw.dataSetId,
      scriptName: raw.scriptName,
      version: Number(raw.version) || 26,
      timeoutMs: Number(raw.timeoutMs) || 45000,
    };
  }
  throw new Error(
    `未配置 EMS：请把 ems.json 放到 ${candidates[candidates.length - 1]}（格式见 ems.config.example.json）`
  );
}

const CFG = loadConfig();

const BASE = `http://${CFG.host}:${CFG.port}`;

// 任务状态码（来自页面配置 status 列的 renderText）
const STATUS = { 1: "未开始", 2: "进行中", 3: "已完成", 4: "已关闭", 5: "校验未通过", 6: "校验通过" };

// args 是 21 段以 "!@" 分隔的字符串，其中：
//   [13] = 状态列表（逗号分隔）
//   [18] = "assigntome" 表示只看指派给我的，null 表示所有人
//   [19] = 排序字段，[20] = 排序方向
const ARGS_TEMPLATE = "0!@null!@null!@null!@null!@null!@null!@null!@null!@null!@null!@null!@null!@null!@null!@null!@null!@null!@null!@task_id!@desc";
const ARGS_STATUS_IDX = 13;
const ARGS_MINE_IDX = 18;

function buildArgs(statuses, mine) {
  const parts = ARGS_TEMPLATE.split("!@");
  parts[ARGS_STATUS_IDX] = statuses.join(",");
  parts[ARGS_MINE_IDX] = mine ? "assigntome" : "null";
  return parts.join("!@");
}

// ── RSA（PKCS#1 v1.5）────────────────────────────────────────────────
const RSA_PUB_B64 = "MFwwDQYJKoZIhvcNAQEBBQADSwAwSAJBAMKaTbS1XHH7u/4dhao1n5Lcegpy6AHKX2TjmTP7IDW6N4wznqlL3Tt+U0/Il1TlNp1/EN+tffYYg4dPrrCUDwcCAwEAAQ==";
const DER_TAIL = Buffer.from([0x02, 0x03, 0x01, 0x00, 0x01]);

function loadPubKey() {
  const der = Buffer.from(RSA_PUB_B64, "base64");
  const i = der.lastIndexOf(DER_TAIL);
  if (i < 0) throw new Error("RSA 公钥解析失败");
  const mod = der.subarray(i - 64, i);
  const exp = der.subarray(i + 2, i + 5);
  return { n: BigInt("0x" + mod.toString("hex")), e: BigInt("0x" + exp.toString("hex")), k: mod.length };
}
const PUB = loadPubKey();

function rsaEncrypt(msg) {
  const k = PUB.k;
  if (msg.length > k - 11) throw new Error("RSA 明文过长");
  const ps = Buffer.alloc(k - msg.length - 3);
  let off = 0;
  while (off < ps.length) {
    for (const b of crypto.randomBytes(ps.length - off + 8)) {
      if (b !== 0 && off < ps.length) ps[off++] = b;
    }
  }
  const em = Buffer.concat([Buffer.from([0x00, 0x02]), ps, Buffer.from([0x00]), msg]);
  let c = 1n;
  let base = BigInt("0x" + em.toString("hex")) % PUB.n;
  let exp = PUB.e;
  while (exp > 0n) {
    if (exp & 1n) c = (c * base) % PUB.n;
    base = (base * base) % PUB.n;
    exp >>= 1n;
  }
  return Buffer.from(c.toString(16).padStart(k * 2, "0"), "hex");
}

// ── AES-128-CBC / ZeroPadding ────────────────────────────────────────
function randKey() {
  let s = Math.random().toString(36).slice(2);
  while (s.length < 16) s += Math.random().toString(36).slice(2);
  return s.slice(0, 16);
}

function aesEncrypt(buf, key, iv) {
  const pad = (16 - (buf.length % 16)) % 16;
  const data = pad ? Buffer.concat([buf, Buffer.alloc(pad)]) : buf;
  const cipher = crypto.createCipheriv("aes-128-cbc", Buffer.from(key, "utf8"), Buffer.from(iv, "utf8"));
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(data), cipher.final()]);
}

function aesDecrypt(buf, key, iv) {
  const d = crypto.createDecipheriv("aes-128-cbc", Buffer.from(key, "utf8"), Buffer.from(iv, "utf8"));
  d.setAutoPadding(false);
  const out = Buffer.concat([d.update(buf), d.final()]);
  let end = out.length;
  while (end > 0 && out[end - 1] === 0) end--;
  return out.subarray(0, end);
}

function encryptPayload(obj) {
  const key = randKey();
  const iv = randKey();
  const c = aesEncrypt(Buffer.from(JSON.stringify(obj), "utf8"), key, iv).toString("base64");
  const p = iv + rsaEncrypt(Buffer.from(key, "utf8")).toString("base64");
  return { c, p, key };
}

function decryptResponse(content, key) {
  const iv = content.slice(0, 16);
  const body = Buffer.from(content.slice(16), "base64");
  return aesDecrypt(body, key, iv).toString("utf8");
}

// ── HTTP ─────────────────────────────────────────────────────────────
function request(opts, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(opts, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, buf: Buffer.concat(chunks), headers: res.headers }));
    });
    req.on("error", reject);
    req.setTimeout(CFG.timeoutMs, () => req.destroy(new Error("请求超时")));
    if (body) req.write(body);
    req.end();
  });
}

const md5 = (s) => crypto.createHash("md5").update(s, "utf8").digest("hex");

// ── 业务 ─────────────────────────────────────────────────────────────
async function login() {
  const body = new URLSearchParams({
    username: CFG.username,
    password: md5(CFG.password),
    context: CFG.context,
    businessOfficeId: CFG.businessOfficeId,
  }).toString();

  const res = await request({
    host: CFG.host, port: CFG.port, path: "/api/login", method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      Origin: BASE, Referer: BASE + "/",
      "Content-Length": Buffer.byteLength(body),
    },
  }, body);

  const json = JSON.parse(res.buf.toString("utf8"));
  if (!json.success || !json.data?.token) {
    throw new Error(`登录失败：${json.message || "无 token"}`);
  }
  const cookies = (res.headers["set-cookie"] || [])
    .map((s) => s.split(";")[0])
    .filter((s) => s && !/rememberMe=deleteMe/i.test(s))
    .join("; ");
  return { token: json.data.token, cookies };
}

async function searchTasks(auth, statuses, mine) {
  const payload = {
    dataSetId: CFG.dataSetId,
    columns: [],
    formType: "",
    allTablesFlag: true,
    queryRequest: { pageSize: 1, pageNum: 1, sortOrder: "", sortField: "" },
    searchFileNames: [], searchFileValues: [], searchRules: [],
    sumFields: [], avgFields: [], maxFields: [], minFields: [], countFields: [],
    allSearchColsFlag: false,
    allSearchColsValue: "",
    allSearchCols: [],
    componentKeyName: "主表格",
    args: buildArgs(statuses, mine),
    scriptName: CFG.scriptName,
    eventName: "Search",
    version: CFG.version,
    onAction: "1",
  };

  const { c, p, key } = encryptPayload(payload);
  const body = JSON.stringify({ c, p });
  const headers = {
    Accept: "application/json, text/plain, */*",
    "Content-Type": "application/json;charset=UTF-8",
    Authentication: auth.token,
    currentContext: CFG.context,
    operateContext: CFG.context,
    eventName: "Search",
    pageId: CFG.pageId,
    keyName: encodeURIComponent("主表格"),
    Origin: BASE, Referer: BASE + "/",
    "Content-Length": Buffer.byteLength(body),
  };
  if (auth.cookies) headers.Cookie = auth.cookies;

  const res = await request({
    host: CFG.host, port: CFG.port, path: "/api/business", method: "POST", headers,
  }, body);

  const outer = JSON.parse(res.buf.toString("utf8"));
  if (!outer.success) throw new Error(`接口失败：${outer.message || "未知"}`);

  const plain = decryptResponse(outer.data.content, key);
  const inner = JSON.parse(plain);
  if (!inner.success) throw new Error(`查询失败：${inner.message || "未知"}`);

  return Number(inner.data?.total) || 0;
}

/**
 * 抓取两个指标（全部只看「指派给我」的）：
 *   未完成需求 = 未开始(1) + 进行中(2)
 *   未验证需求 = 校验未通过(5)
 */
async function fetchStats() {
  const auth = await login();
  const [reqOpen, reqUnverified] = await Promise.all([
    searchTasks(auth, [1, 2], true),
    searchTasks(auth, [5], true),
  ]);
  return {
    reqOpen,
    reqUnverified,
    bugOpen: null,        // 待接入 bug 数据源
    bugUnverified: null,  // 待接入 bug 数据源
    updatedAt: Date.now(),
    error: "",
  };
}

// ── CLI ──────────────────────────────────────────────────────────────
// 只往 stdout 打印。不写任何文件 —— 生产落盘由 Rust + 前端 state 负责，
// 探针写盘只会制造第二份真相。
(async () => {
  try {
    const stats = await fetchStats();
    console.log(JSON.stringify(stats, null, 2));
    process.exit(0);
  } catch (err) {
    const fail = {
      reqOpen: null, reqUnverified: null, bugOpen: null, bugUnverified: null,
      updatedAt: Date.now(), error: String(err.message || err),
    };
    console.log(JSON.stringify(fail, null, 2));
    process.exit(1);
  }
})();
