// AI 资讯 · 签到适配器（纯模块：零 import / 零 DOM / 零全局时钟）
// 复刻签到脚本目录下两个 Python 脚本的逻辑（checkin_workbuddy.py / checkin_trae.py）：
//   - WorkBuddy（腾讯 CodeBuddy）：$wbEncrypted AES-256-GCM 解 token → copilot.tencent.com
//   - Trae：iCube AES-256-CBC 解 JWT → api.trae.cn
// token 仅在内存中解密使用，不落盘、不打印。createCheckin(ports) 注入依赖以便单测。
//
// ports = { crypto, httpPost(url,body,headers), collectState(kind), wait(ms), now() }

const AT_REST_SECRET = "Sik9U5aXhCdwTVEwsEySDOmDoB9r9ntFxHF1fst9LQI=";
const TRAE_AUTH_KEY = "iCubeAuthInfo://icube.cloudide";
const WB_BASE = "https://copilot.tencent.com/v2/billing/meter";
const TRAE_BASE = "https://api.trae.cn/trae/api/v2/ug/checkin_credits";
const TRAE_PAY_BASE = "https://api.trae.cn/trae/api/v2/pay"; // 余额/权益查询
const TRAE_REQ_SOURCE = 1; // 只签 Trae CN IDE（SOLO/企业版不在面板范围，仅目录扫描收敛到 Trae CN）

const FRAMING_TAG = { file: "WBEF1", field: "WBEV1", record: "WBER1", stream: "WBES1" };
const FRAMING_NUM = { file: 1, field: 2, record: 3, stream: 4 };

// iCube 登录态解密常量（与 Trae 客户端加密格式对应）
const URE = new Uint8Array([
  82, 9, 106, 213, 48, 54, 165, 56, 191, 64, 163, 158, 129, 243, 215, 251,
  124, 227, 57, 130, 155, 47, 255, 135, 52, 142, 67, 68, 196, 222, 233, 203,
  84, 123, 148, 50, 166, 194, 35, 61, 238, 76, 149, 11, 66, 250, 195, 78, 8,
  46, 161, 102, 40, 217, 36, 178, 118, 91, 162, 73, 109, 139, 209, 37,
]);
const DRE = new Uint8Array([
  31, 221, 168, 51, 136, 7, 199, 49, 177, 18, 16, 89, 39, 128, 236, 95,
  96, 81, 127, 169, 25, 181, 74, 13, 45, 229, 122, 159, 147, 201, 156, 239,
  160, 224, 59, 77, 174, 42, 245, 176, 200, 235, 187, 60, 131, 83, 153, 97, 23,
  43, 4, 126, 186, 119, 214, 38, 225, 105, 20, 99, 85, 33, 12, 125,
]);

// ---------------- 字节小工具 ----------------
function strBytes(s) {
  return new TextEncoder().encode(s);
}
function b64ToBytes(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function b64UrlToBytes(s) {
  let t = s.replace(/-/g, "+").replace(/_/g, "/");
  while (t.length % 4) t += "=";
  return b64ToBytes(t);
}
function concatBytes(...arrs) {
  let total = 0;
  for (const a of arrs) total += a.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrs) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}
function u32be(n) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0, false);
  return b;
}
function bytesToHex(b) {
  let s = "";
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, "0");
  return s;
}

async function sha256(data, crypto) {
  const h = await crypto.subtle.digest("SHA-256", data);
  return new Uint8Array(h);
}
async function sha512(data, crypto) {
  const h = await crypto.subtle.digest("SHA-512", data);
  return new Uint8Array(h);
}

// ---------------- WorkBuddy：$wbEncrypted 字段解密 ----------------
function wbAad(framing, keyId, suite) {
  const tag = strBytes(FRAMING_TAG[framing]);
  const kid = strBytes(keyId);
  return concatBytes(
    strBytes("WB-AAD"),
    new Uint8Array([0, 1]),
    u32be(tag.length), tag,
    u32be(6), strBytes("sym-v1"),
    u32be(suite),
    u32be(kid.length), kid,
    new Uint8Array([FRAMING_NUM[framing], 0, 0]),
  );
}

async function wbDerive(crypto) {
  const wbKey = await sha256(strBytes(AT_REST_SECRET), crypto); // SHA-256 of UTF-8 bytes
  const kidFull = await sha256(wbKey, crypto);
  const keyId = bytesToHex(kidFull).slice(0, 16); // = "9127dea1b44020a7"
  return { wbKey, keyId };
}

async function wbOpenField(value, crypto, derived) {
  if (!value || typeof value !== "object" || value.$wbEncrypted !== 1) return value;
  if (value.scheme != null && value.scheme !== "sym-v1") {
    throw new Error("不支持的加密方案 " + value.scheme + "，请重新登录 WorkBuddy");
  }
  const env = JSON.parse(new TextDecoder().decode(b64ToBytes(value.envelope)));
  if (env.keyId !== derived.keyId) {
    throw new Error("密钥不匹配（WorkBuddy 版本可能已更新，请重新登录）");
  }
  const suite = env.suite || 1;
  const nonce = b64ToBytes(env.nonce);
  const ct = b64ToBytes(env.ciphertext);
  const tag = b64ToBytes(env.authTag);
  const aad = wbAad("field", env.keyId, suite);
  const key = await crypto.subtle.importKey("raw", derived.wbKey, { name: "AES-GCM" }, false, ["decrypt"]);
  // WebCrypto AES-GCM 要求输入为 ciphertext||tag
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: nonce, additionalData: aad },
    key,
    concatBytes(ct, tag),
  );
  return new TextDecoder().decode(plain);
}

async function wbLoadAccounts(files, crypto) {
  const derived = await wbDerive(crypto);
  const out = [];
  const seen = new Set();
  for (const f of files) {
    if (f.error) { out.push({ name: f.name, error: f.error }); continue; }
    try {
      const session = JSON.parse(f.text);
      const auth = session.auth || {};
      let token = auth.accessToken;
      if (token && typeof token === "object" && token.$wbEncrypted === 1) {
        token = await wbOpenField(token, crypto, derived);
      }
      if (!token) { out.push({ name: f.name, error: "登录态中无 accessToken" }); continue; }
      if (seen.has(token)) continue;
      seen.add(token);
      session.auth.accessToken = token; // 仅内存替换，不写回
      out.push({ name: f.name, session });
    } catch (e) {
      out.push({ name: f.name, error: String((e && e.message) || e) });
    }
  }
  return out;
}

async function wbApi(url, session, httpPost, wait) {
  const auth = session.auth || {};
  const account = session.account || {};
  const headers = {
    Authorization: "Bearer " + auth.accessToken,
    "X-User-Id": account.uid || "",
    "X-Domain": auth.domain || "",
    "Content-Type": "application/json",
    Accept: "application/json",
    // 网关拒 DeskOverlay 默认 UA（python-requests 同理），用浏览器 UA 覆盖
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
  };
  let lastErr = null;
  for (let i = 0; i < 3; i++) {
    try {
      const txt = await httpPost(url, "{}", headers);
      return JSON.parse(txt);
    } catch (e) {
      lastErr = e;
      if (i < 2) await wait(5000); // 客户端常后台轮换 token，重试
    }
  }
  throw lastErr;
}

async function wbBalance(session, httpPost, wait) {
  try {
    const resp = await wbApi(WB_BASE + "/get-user-resource", session, httpPost, wait);
    const accs = (((resp.data || {}).Response || {}).Data || {}).Accounts || [];
    return accs.reduce((s, a) => s + (Number(a.CapacityRemain) || 0), 0);
  } catch (e) {
    return null; // 余额查询失败不阻断签到结果
  }
}

// ---------------- Trae：iCube 登录态解密 ----------------
async function traeDecrypt(b64, crypto) {
  const t = b64ToBytes(b64);
  if (t.length < 6 + 32 + 16) throw new Error("登录态密文长度异常");
  const key = t.subarray(6, 38); // 32B
  const sha = await sha512(key, crypto); // 64B
  const xor = new Uint8Array(64);
  for (let i = 0; i < 64; i++) xor[i] = URE[i] ^ DRE[i];
  const h = await sha512(concatBytes(sha, xor), crypto); // 64B
  const aesKey = h.subarray(0, 16);
  const iv = h.subarray(16, 32);
  const ct = t.subarray(38);
  const ckey = await crypto.subtle.importKey("raw", aesKey, { name: "AES-CBC" }, false, ["decrypt"]);
  // WebCrypto AES-CBC 自动去 PKCS7 padding（Python 的 unpad 在此冗余）
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-CBC", iv }, ckey, ct));
  const json = new TextDecoder().decode(plain.subarray(64)); // 跳过 64B HMAC 头
  return JSON.parse(json);
}

function extractDeviceId(target) {
  const nc = target.netConfigText;
  if (nc) {
    const m = nc.match(/device_id&#\*(\d+)/);
    if (m) return m[1];
  }
  const logs = target.mainLogTexts || [];
  for (const txt of logs) {
    const m = txt.match(/\[ICDRS\][^\n]*?did: (\d+)/);
    if (m) return m[1];
  }
  return "";
}

async function traeLoadAccounts(targets, crypto) {
  const out = [];
  const seen = new Set();
  for (const t of targets) {
    // 只认 Trae CN 目录（Rust 侧已收敛，这里做二次防御，防止未来误加目录名）
    if (t.name && t.name !== "Trae CN") { out.push({ name: t.name, error: "非 Trae CN 目录，已忽略" }); continue; }
    if (t.error) { out.push({ name: t.name, error: t.error }); continue; }
    try {
      const storage = JSON.parse(t.storageText);
      const enc = storage[TRAE_AUTH_KEY];
      if (!enc) { out.push({ name: t.name, error: "storage.json 中无登录态" }); continue; }
      const auth = await traeDecrypt(enc, crypto);
      const token = auth.token;
      if (!token) { out.push({ name: t.name, error: "登录态中无 token" }); continue; }
      if (seen.has(token)) continue;
      seen.add(token);
      out.push({
        name: t.name,
        token,
        region: (auth.userRegion || {}).region || "",
        deviceId: extractDeviceId(t),
      });
    } catch (e) {
      out.push({ name: t.name, error: String((e && e.message) || e) });
    }
  }
  return out;
}

function traeTokenExpired(token, now) {
  try {
    const part = token.split(".")[1];
    const payload = JSON.parse(new TextDecoder().decode(b64UrlToBytes(part)));
    const exp = payload.exp;
    if (!exp) return false;
    return Number(exp) * 1000 < now();
  } catch (e) {
    return false; // 解析失败视为未过期（让接口报错再判）
  }
}

async function traeApi(url, token, region, deviceId, httpPost, wait, body) {
  const headers = {
    Authorization: "Cloud-IDE-JWT " + token,
    "Content-Type": "application/json",
    "x-device-id": deviceId || "",
    "User-Agent": "TraeCN/1.0",
  };
  if (region) headers["X-User-Region"] = region;
  const payload = JSON.stringify(body != null ? body : { req_source: TRAE_REQ_SOURCE });
  let lastErr = null;
  for (let i = 0; i < 3; i++) {
    try {
      const txt = await httpPost(url, payload, headers);
      return JSON.parse(txt);
    } catch (e) {
      lastErr = e;
      if (i < 2) await wait(5000);
    }
  }
  throw lastErr;
}

// Trae 可用积分余额：/pay/ide_user_ent_usage → usage_summary（total - consumed）
// 与 Trae CN 客户端「积分余额」一致；checkin_credits/status 的 credits 只是签到活动累计值，不能当余额。
async function traeBalance(token, region, deviceId, httpPost, wait) {
  try {
    const j = await traeApi(TRAE_PAY_BASE + "/ide_user_ent_usage", token, region, deviceId, httpPost, wait, {});
    const s = j.usage_summary || (j.data || {}).usage_summary;
    if (s && s.total_amount != null) {
      return Math.round(((Number(s.total_amount) || 0) - (Number(s.consumed_amount) || 0)) * 10) / 10;
    }
    return null;
  } catch (e) {
    return null; // 余额查询失败不阻断签到结果
  }
}

// 只查 Trae 余额（不签到、不写 state）：给面板「刷新」用。
// 返回 {name, signedToday, credits, detail, at} 数组；无登录态或失败返回 []
async function traeBalanceOnly(ports) {
  const { crypto, httpPost, collectState, wait, now } = ports;
  try {
    const collected = await collectState("trae");
    const accounts = (await traeLoadAccounts(collected.targets || [], crypto))
      .filter((a) => !a.error && a.token);
    const out = [];
    for (const a of accounts) {
      let signed = false, detail = "";
      try {
        const st = unwrap(await traeApi(TRAE_BASE + "/status", a.token, a.region, a.deviceId, httpPost, wait));
        signed = !!st.checked_in;
        detail = signed ? "今日已签到" : "待签到";
      } catch (e) { /* 状态查不到不阻断余额 */ }
      const bal = await traeBalance(a.token, a.region, a.deviceId, httpPost, wait);
      out.push({ name: a.name, signedToday: signed, credits: bal, detail: bal != null ? detail + "，可用积分 " + bal : detail, at: now() });
    }
    return out.filter((r) => isTraeCnResult(r));
  } catch (e) {
    return [];
  }
}

function unwrap(resp) {
  if (!resp) return {};
  if (resp.checked_in === undefined && resp.data && typeof resp.data === "object" && resp.data.checked_in !== undefined) {
    return resp.data;
  }
  return resp;
}

// ---------------- 主流程 ----------------
async function runWorkbuddy(ports) {
  const { crypto, httpPost, collectState, wait, now } = ports;
  const collected = await collectState("workbuddy");
  const accounts = await wbLoadAccounts(collected.files || [], crypto);
  const results = [];
  for (const a of accounts) {
    if (a.error) {
      results.push({ name: a.name, signedToday: false, credits: null, detail: a.error, at: now() });
      continue;
    }
    try {
      const status = await wbApi(WB_BASE + "/checkin-activity-status", a.session, httpPost, wait);
      const data = status.data || {};
      let signed = false, detail = "", gained = null;
      if (data.today_checked_in) {
        signed = true; detail = "今日已签到";
      } else if (data.active === false) {
        detail = "签到活动未开启";
      } else {
        const claim = await wbApi(WB_BASE + "/daily-checkin", a.session, httpPost, wait);
        if (claim.code === 0) {
          signed = true; gained = (claim.data || {}).credit; detail = "签到成功 +" + gained;
        } else if (claim.code === 10001) {
          signed = true; detail = "今日已签到";
        } else {
          detail = "签到失败 code=" + claim.code + " " + (claim.msg || "");
        }
      }
      const bal = await wbBalance(a.session, httpPost, wait);
      results.push({ name: a.name, signedToday: signed, credits: bal, detail, at: now() });
    } catch (e) {
      results.push({ name: a.name, signedToday: false, credits: null, detail: "查询失败：" + String((e && e.message) || e), at: now() });
    }
  }
  return { kind: "workbuddy", time: now(), results };
}

// 只查 WorkBuddy 的**今日签到状态 + 余额**（只读，绝不领取）：给面板打开时自动刷新用。
//
// ⛔ 与 runWorkbuddy 的唯一区别、也是最要紧的一条：这里**绝不调 /daily-checkin**。
//    状态接口（/checkin-activity-status）与余额接口（/get-user-resource）都是只读的，
//    重复调用没有副作用，所以可以放心在每次打开面板时自动跑；
//    一旦把领取接口混进来，就变成「用户只是看了一眼面板，就被替他签了」。
//
// 返回 {name, signedToday, credits, detail, at} 数组；无登录态或全部失败返回 []。
// 返回空数组**不代表「未签到」**，只代表「查不到」—— 调用方必须保留面板上原有的数据，不能据此清空。
async function wbStatusOnly(ports) {
  const { crypto, httpPost, collectState, wait, now } = ports;
  try {
    const collected = await collectState("workbuddy");
    const accounts = (await wbLoadAccounts(collected.files || [], crypto)).filter((a) => !a.error);
    const out = [];
    for (const a of accounts) {
      try {
        const status = await wbApi(WB_BASE + "/checkin-activity-status", a.session, httpPost, wait);
        const data = status.data || {};
        if (status.code !== 0 && status.code !== undefined && !("today_checked_in" in data)) {
          continue; // 接口没给出状态字段（异常响应）：当作查不到，别猜
        }
        let signed = false, detail = "待签到";
        if (data.today_checked_in) { signed = true; detail = "今日已签到"; }
        else if (data.active === false) detail = "签到活动未开启";
        const bal = await wbBalance(a.session, httpPost, wait);
        out.push({ name: a.name, signedToday: signed, credits: bal, detail, at: now() });
      } catch (e) { /* 单账号失败：跳过 —— 宁可保留旧数据，也不要谎报「未签」 */ }
    }
    return out;
  } catch (e) {
    return [];
  }
}

async function runTrae(ports) {
  const { crypto, httpPost, collectState, wait, now } = ports;
  const collected = await collectState("trae");
  const accounts = await traeLoadAccounts(collected.targets || [], crypto);
  const results = [];
  for (const a of accounts) {
    if (a.error) {
      results.push({ name: a.name, signedToday: false, credits: null, detail: a.error, at: now() });
      continue;
    }
    try {
      if (traeTokenExpired(a.token, now)) {
        results.push({ name: a.name, signedToday: false, credits: null, detail: "登录态已过期，请打开 Trae CN 客户端重新登录", at: now() });
        continue;
      }
      const st = unwrap(await traeApi(TRAE_BASE + "/status", a.token, a.region, a.deviceId, httpPost, wait));
      // 可用余额：以 /pay/ide_user_ent_usage 的 usage_summary 为准（客户端同款口径）；签到失败/未开时回退签到累计值
      let balance = await traeBalance(a.token, a.region, a.deviceId, httpPost, wait);
      let signed = false, credits = balance, detail = "";
      if (st.checked_in) {
        signed = true;
        detail = "今日已签到" + (credits != null ? "，可用积分 " + credits : "");
      } else if (!st.enable) {
        detail = "签到不可用";
      } else {
        const claim = await traeApi(TRAE_BASE + "/claim", a.token, a.region, a.deviceId, httpPost, wait);
        if (claim.code === 0) {
          signed = true;
          // 签到后重查余额（usage_summary 会即时更新）
          const b2 = await traeBalance(a.token, a.region, a.deviceId, httpPost, wait);
          if (b2 != null) credits = b2;
          detail = "签到成功" + (credits != null ? "，可用积分 " + credits : "");
        } else if (claim.checked_in) {
          signed = true;
          detail = "今日已签到" + (credits != null ? "，可用积分 " + credits : "");
        } else {
          detail = "签到失败：" + (claim.message || "未知");
        }
      }
      results.push({ name: a.name, signedToday: signed, credits, detail, at: now() });
    } catch (e) {
      results.push({ name: a.name, signedToday: false, credits: null, detail: "查询失败：" + String((e && e.message) || e), at: now() });
    }
  }
  // Trae 只保留 Trae CN 账号（防止目录被重新加宽时 SOLO/国际版混入）
  return { kind: "trae", time: now(), results: results.filter((r) => isTraeCnResult(r)) };
}

// 账号归一化后等于 "trae cn" 才保留；"trae solo cn" / "trae"（国际版）滤掉。
// name 为 "" 视为默认账号（Trae CN）保留。
function isTraeCnResult(r) {
  const n = String((r && (r.name != null ? r.name : r.account)) || "").replace(/\s+/g, " ").trim().toLowerCase();
  return n === "trae cn" || n === "";
}

export function createCheckin(ports) {
  return {
    // 手动签到（解密 + 状态 + 领取 + 余额）
    runCheckin(kind) {
      return kind === "workbuddy" ? runWorkbuddy(ports) : runTrae(ports);
    },
    // 只查实时余额/状态（不签到）：面板「刷新」用，避免读到旧后台结果文件的脏数据
    balanceOnly(kind) {
      return kind === "trae" ? traeBalanceOnly(ports) : Promise.resolve([]);
    },
    // WorkBuddy 的**只读**状态刷新（不领取）：面板打开时自动跑，用来纠正跨天后的陈旧状态
    statusOnly(kind) {
      return kind === "workbuddy" ? wbStatusOnly(ports) : Promise.resolve([]);
    },
  };
}
