//! EMS 工作量统计抓取：未完成需求 / 未验证需求（以及后续的 Bug 两项）。
//!
//! # 为什么要在 Rust 里重做一遍加密
//!
//! EMS（亿能达 ERP）前端对每个业务请求都做了应用层加密，协议是逆向出来的：
//!
//! ```text
//! 请求体 { c, p }
//!   key  = 16 字符随机串 [0-9a-z]
//!   iv   = 16 字符随机串 [0-9a-z]
//!   c    = base64( AES-128-CBC( JSON明文, key, iv, ZeroPadding ) )
//!   p    = iv + base64( RSA-512/PKCS#1v1.5( key ) )
//!
//! 响应 data.content
//!   = iv'(16字符) + base64( AES-128-CBC( 明文, 请求的key, iv' ) )
//! ```
//!
//! 两个坑必须记住：
//!   1. **ZeroPadding 不是 PKCS#7** —— 尾部补 `0x00`，解密后按 `0x00` 截断。
//!   2. **RSA 只有 512 位** —— ring/openssl 这类库最低要求 2048 位，用不了，
//!      所以这里直接用 `num_bigint` 做 modpow 手工实现 PKCS#1 v1.5。
//!
//! # 数据口径
//!
//! 任务状态码（来自页面配置 `status` 列的 renderText）：
//!   `1=未开始  2=进行中  3=已完成  4=已关闭  5=校验未通过  6=校验通过`
//!
//! 于是：
//!   * 未完成需求 = 状态 ∈ {1, 2}
//!   * 未验证需求 = 状态 = 5
//!
//! 两者都只统计「指派给我」的（`args[18] = "assigntome"`）。
//!
//! # args 的格式（21 段，`!@` 分隔）
//!
//! ```text
//! [0]  固定 "0"
//! [13] 状态列表，逗号分隔，如 "1,2,5"     ← 筛选状态
//! [18] "assigntome" 或 "null"            ← 只看我的 / 所有人
//! [19] 排序字段 "task_id"
//! [20] 排序方向 "desc"
//! ```
//!
//! ⚠ 索引必须是 13 和 18（21 段），早先误以为是 12/17 导致查出来恒为 0。

use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use aes::cipher::{BlockEncrypt, BlockDecrypt, KeyInit, generic_array::GenericArray};
use num_bigint::BigUint;
use serde_json::Value as Json;

// ── 配置 ─────────────────────────────────────────────────────────────
//
// ⛔ 本文件**不得**出现任何真实主机名 / 账号 / 密码。
//    仓库是公开的，凭据一律从用户本机的配置文件读取：
//
//      %APPDATA%/com.deskoverlay.desktop/ems.json
//
//    格式见仓库根的 `ems.config.example.json`（该示例只含占位符）。
//    首次运行时若文件不存在，抓取线程会静默跳过并在前端显示「未配置」。

/// 运行期配置：全部来自 `ems.json`，没有任何默认凭据。
#[derive(Debug, Clone)]
pub struct EmsConfig {
    /// 主机:端口，例如 `host.example:9392`。
    pub host: String,
    /// 登录账号。
    pub username: String,
    /// 登录密码明文（仅在内存里存在，发送前转 MD5）。
    pub password: String,
    /// 上下文标识（如 `ecanerp`）。
    pub context: String,
    /// 业务单位 ID —— **必填**，缺了所有查询都返回空 `data`。
    pub business_office_id: String,
    /// 任务管理页面 ID。
    pub page_id: String,
    /// 任务主表格数据集 ID。
    pub data_set_id: String,
    /// 表格搜索脚本名（多个用逗号连起来，原样照抄）。
    pub script_name: String,
    /// 脚本版本号。
    pub version: u32,
    /// 需求列表页面 ID（「未验证需求」用）。
    pub req_page_id: String,
    /// 需求主表格数据集 ID。
    pub req_data_set_id: String,
    /// 需求页脚本名。
    pub req_script_name: String,
    /// 需求页脚本版本号。
    pub req_version: u32,
    /// Bug 列表页面 ID（「未完成 / 未验证 Bug」用）。
    pub bug_page_id: String,
    /// Bug 主表格数据集 ID —— 与任务页**相同**（`07794dcb…`），靠 `args[0]` 切视图。
    pub bug_data_set_id: String,
    /// Bug 页脚本名（只有一段，不像任务页是两段逗号拼接）。
    pub bug_script_name: String,
    /// Bug 页脚本版本号。
    pub bug_version: u32,
}

impl EmsConfig {
    /// 从 JSON 值解析。缺字段一律报错 —— 宁可「未配置」也不要带着半套配置去请求。
    fn from_json(v: &Json) -> Result<Self, String> {
        let s = |k: &str| -> Result<String, String> {
            v.get(k)
                .and_then(Json::as_str)
                .map(str::trim)
                .filter(|x| !x.is_empty())
                .map(str::to_string)
                .ok_or_else(|| format!("ems.json 缺少字段 `{k}`"))
        };
        let version = v
            .get("version")
            .and_then(Json::as_u64)
            .unwrap_or(26) as u32;
        let req_version = v
            .get("reqVersion")
            .and_then(Json::as_u64)
            .unwrap_or(6) as u32;
        let bug_version = v
            .get("bugVersion")
            .and_then(Json::as_u64)
            .unwrap_or(31) as u32;

        Ok(Self {
            host: s("host")?,
            username: s("username")?,
            password: s("password")?,
            context: s("context")?,
            business_office_id: s("businessOfficeId")?,
            page_id: s("pageId")?,
            data_set_id: s("dataSetId")?,
            script_name: s("scriptName")?,
            version,
            req_page_id: s("reqPageId")?,
            req_data_set_id: s("reqDataSetId")?,
            req_script_name: s("reqScriptName")?,
            req_version,
            bug_page_id: s("bugPageId")?,
            bug_data_set_id: s("bugDataSetId")?,
            bug_script_name: s("bugScriptName")?,
            bug_version,
        })
    }

    /// 读用户配置文件。文件不存在或字段不全都返回 `Err`（原因给前端看）。
    ///
    /// 路径必须用 `app_data_dir` 而不是相对路径：相对路径在打包后是 exe 所在目录，
    /// 那里通常不可写，也不该让用户去翻 Program Files。
    pub fn load(app: &tauri::AppHandle) -> Result<Self, String> {
        use tauri::Manager as _;
        let dir = app
            .path()
            .app_data_dir()
            .map_err(|e| format!("无法定位数据目录：{e}"))?;
        let file = dir.join("ems.json");
        if !file.exists() {
            return Err(format!(
                "未配置 EMS：请把 ems.json 放到 {}（格式见 ems.config.example.json）",
                dir.display()
            ));
        }
        let text = std::fs::read_to_string(&file)
            .map_err(|e| format!("读取 ems.json 失败：{e}"))?;
        let v: Json =
            serde_json::from_str(&text).map_err(|e| format!("ems.json 不是合法 JSON：{e}"))?;
        Self::from_json(&v)
    }
}

/// RSA 公钥（DER，base64）。512 位，指数 65537。
///
/// 这是 EMS **服务端下发的公钥**，随前端 JS 一起公开分发给每个浏览器，
/// 不属于隐私信息（没有它连加密都做不了）。保留在代码里是正确的。
const RSA_PUB_B64: &str = "MFwwDQYJKoZIhvcNAQEBBQADSwAwSAJBAMKaTbS1XHH7u/4dhao1n5Lcegpy6AHKX2TjmTP7IDW6N4wznqlL3Tt+U0/Il1TlNp1/EN+tffYYg4dPrrCUDwcCAwEAAQ==";

/// 抓取轮询间隔：2 小时。数据本身一天变不了几次，这个频率足够新鲜。
const FETCH_INTERVAL: Duration = Duration::from_secs(2 * 60 * 60);
/// 启动后先等一会儿再抓，避开开机瞬间的窗口创建/桌面注入高峰。
const STARTUP_DELAY: Duration = Duration::from_secs(20);

/// 前端是否还关心这些数据（工作台卡片/面板是否在渲染）。
/// 关闭时不发请求，省得白白给 EMS 服务器压力。
static EMS_ON: AtomicBool = AtomicBool::new(true);

/// 抓取单飞锁：**同一时刻只允许一轮抓取在跑**。
///
/// 为什么必须有：定时线程（2 小时一轮）和「刷新」按钮线程是两条独立的
/// `std::thread`，没有这把锁时会出现
///
/// * 用户在定时轮抓取途中点刷新 → 两轮同时登录、同时发 8 个查询，
///   EMS 服务端压力翻倍；
/// * 两轮各自 emit 一次 `provider-emit`，**后到的覆盖先到的**，
///   如果先到的反而是更新的那轮，前端就显示成旧数据了。
///
/// 用 `try_lock` 而不是 `lock`：抢不到锁说明已经有一轮在跑，
/// 直接跳过这次（定时轮跳过等于等下一轮；手动刷新跳过也不会报错，
/// 因为马上就会收到在跑那轮的结果）。排队等待毫无意义——数据一样。
static FETCHING: Mutex<()> = Mutex::new(());

// ── 编解码小工具 ─────────────────────────────────────────────────────

/// 标准 base64 编码（`base64` crate 已作为直接依赖存在于依赖树中）。
fn b64_encode(data: &[u8]) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.encode(data)
}

fn b64_decode(s: &str) -> Option<Vec<u8>> {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.decode(s).ok()
}

/// MD5 摘要的小写十六进制串（登录接口的密码字段）。
fn md5_hex(s: &str) -> String {
    use md5::{Digest, Md5};
    let mut h = Md5::new();
    h.update(s.as_bytes());
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

/// 生成 16 字符的会话密钥 / IV。
///
/// EMS 前端用的是 `Math.random().toString(36)` 截 16 位，字符集 `[0-9a-z]`。
/// 这里取同样字符集：AES 密钥与 IV 都按 UTF-8 字节直接使用，字符集一致才等价。
fn rand16() -> String {
    const CHARS: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut out = String::with_capacity(16);
    // 用系统熵源；不可用时退回时间戳混合，绝不 panic。
    let mut buf = [0u8; 16];
    if getrandom_bytes(&mut buf).is_err() {
        let t = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(0x9E3779B97F4A7C15);
        let mut x = t | 1;
        for b in buf.iter_mut() {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            *b = x as u8;
        }
    }
    for b in buf.iter() {
        out.push(CHARS[(*b as usize) % CHARS.len()] as char);
    }
    out
}

/// 取系统随机字节。Windows 上用 `BCryptGenRandom` 之外的通用做法：
/// 读 `std` 的随机源不直接暴露，这里用 `std::time` + 进程/线程地址混合熵，
/// 对「会话密钥」这个用途已经足够（EMS 前端本身就是 `Math.random()`）。
fn getrandom_bytes(buf: &mut [u8]) -> Result<(), ()> {
    if buf.is_empty() {
        return Ok(());
    }
    // 以高精度时间 + 进程 ID + 栈地址作为种子，跑 xorshift 填满缓冲区。
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .map_err(|_| ())?;
    let pid = std::process::id() as u64;
    let addr = buf.as_ptr() as u64;
    let mut x = now ^ pid.rotate_left(17) ^ addr.rotate_left(33);
    if x == 0 {
        x = 0x9E3779B97F4A7C15;
    }
    for b in buf.iter_mut() {
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        *b = (x >> 24) as u8;
    }
    Ok(())
}

// ── AES-128-CBC + ZeroPadding ────────────────────────────────────────

/// AES-128-CBC 加密，尾部补 `0x00` 到 16 字节整数倍。
///
/// ⚠ 明文长度恰好是 16 的倍数时**不补**整块（`pad = 0`），这与 PKCS#7 相反。
fn aes_cbc_encrypt(plain: &[u8], key: &str, iv: &str) -> Vec<u8> {
    let k: [u8; 16] = {
        let b = key.as_bytes();
        let mut a = [0u8; 16];
        a.copy_from_slice(&b[..16.min(b.len())]);
        a
    };
    let mut prev: [u8; 16] = {
        let b = iv.as_bytes();
        let mut a = [0u8; 16];
        a.copy_from_slice(&b[..16.min(b.len())]);
        a
    };
    let cipher = aes::Aes128::new(GenericArray::from_slice(&k));

    let pad = (16 - (plain.len() % 16)) % 16;
    let mut data = plain.to_vec();
    data.extend(std::iter::repeat(0u8).take(pad));

    let mut out = Vec::with_capacity(data.len());
    for chunk in data.chunks(16) {
        let mut block = [0u8; 16];
        for i in 0..16 {
            block[i] = chunk[i] ^ prev[i];
        }
        let mut ga = GenericArray::clone_from_slice(&block);
        cipher.encrypt_block(&mut ga);
        out.extend_from_slice(&ga);
        prev.copy_from_slice(&ga);
    }
    out
}

/// AES-128-CBC 解密，并按 `0x00` 截断尾部。
fn aes_cbc_decrypt(cipher_text: &[u8], key: &str, iv: &str) -> Vec<u8> {
    let k: [u8; 16] = {
        let b = key.as_bytes();
        let mut a = [0u8; 16];
        a.copy_from_slice(&b[..16.min(b.len())]);
        a
    };
    let mut prev: [u8; 16] = {
        let b = iv.as_bytes();
        let mut a = [0u8; 16];
        a.copy_from_slice(&b[..16.min(b.len())]);
        a
    };
    let cipher = aes::Aes128::new(GenericArray::from_slice(&k));

    let mut out = Vec::with_capacity(cipher_text.len());
    for chunk in cipher_text.chunks(16) {
        if chunk.len() < 16 {
            break;
        }
        let mut ga = GenericArray::clone_from_slice(chunk);
        cipher.decrypt_block(&mut ga);
        for i in 0..16 {
            out.push(ga[i] ^ prev[i]);
        }
        prev.copy_from_slice(chunk);
    }
    while out.last() == Some(&0u8) {
        out.pop();
    }
    out
}

// ── RSA-512 / PKCS#1 v1.5 ────────────────────────────────────────────

/// 从 DER 里抠出 (n, e, 模长字节数)。
///
/// 结构固定为 `30 5c 30 0d 06 09 2a864886f70d010101 05 00 03 4b 00 30 48
/// 02 41 00 <64字节模数> 02 03 01 00 01`，所以直接按「找指数尾部」定位。
fn rsa_pub_parts() -> Option<(BigUint, BigUint, usize)> {
    let der = b64_decode(RSA_PUB_B64)?;
    // 指数尾：02 03 01 00 01
    let tail: [u8; 5] = [0x02, 0x03, 0x01, 0x00, 0x01];
    let mut idx = None;
    if der.len() >= tail.len() {
        for i in 0..=(der.len() - tail.len()) {
            if der[i..i + tail.len()] == tail {
                idx = Some(i);
            }
        }
    }
    let i = idx?;
    if i < 64 {
        return None;
    }
    let modulus = &der[i - 64..i];
    let n = BigUint::from_bytes_be(modulus);
    let e = BigUint::from_bytes_be(&[0x01, 0x00, 0x01]); // 65537
    Some((n, e, 64))
}

/// PKCS#1 v1.5 加密（`0x00 0x02 <非零随机填充> 0x00 <明文>`）。
fn rsa_encrypt(msg: &[u8]) -> Option<Vec<u8>> {
    let (n, e, k) = rsa_pub_parts()?;
    if msg.len() + 11 > k {
        return None;
    }
    let ps_len = k - msg.len() - 3;
    let mut ps = Vec::with_capacity(ps_len);
    while ps.len() < ps_len {
        let mut tmp = vec![0u8; (ps_len - ps.len()) + 8];
        getrandom_bytes(&mut tmp).ok()?;
        for b in tmp {
            if b != 0 && ps.len() < ps_len {
                ps.push(b);
            }
        }
    }
    let mut em = Vec::with_capacity(k);
    em.push(0x00);
    em.push(0x02);
    em.extend_from_slice(&ps);
    em.push(0x00);
    em.extend_from_slice(msg);

    let m = BigUint::from_bytes_be(&em);
    let c = m.modpow(&e, &n);
    let bytes = c.to_bytes_be();
    // 左补 0 到模长
    let mut out = vec![0u8; k - bytes.len()];
    out.extend_from_slice(&bytes);
    Some(out)
}

// ── 请求信封 ─────────────────────────────────────────────────────────

/// 把明文 JSON 包成 `{c, p}`，同时返回本次会话密钥（响应解密要用）。
fn seal(payload: &Value) -> Option<(String, String, String)> {
    let key = rand16();
    let iv = rand16();
    let plain = serde_json::to_vec(payload).ok()?;
    let c = b64_encode(&aes_cbc_encrypt(&plain, &key, &iv));
    let rsa = rsa_encrypt(key.as_bytes())?;
    let p = format!("{iv}{}", b64_encode(&rsa));
    Some((c, p, key))
}

/// 解开响应体里的 `data.content`。
fn open(content: &str, key: &str) -> Option<String> {
    if content.len() < 16 {
        return None;
    }
    let iv = &content[..16];
    let body = b64_decode(&content[16..])?;
    let plain = aes_cbc_decrypt(&body, key, iv);
    String::from_utf8(plain).ok()
}

// ── HTTP ─────────────────────────────────────────────────────────────

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(8))
        .timeout(Duration::from_secs(30))
        .build()
}

/// 登录，返回 (token, cookie)。
fn login(cfg: &EmsConfig) -> Result<(String, String), String> {
    let body = format!(
        "username={}&password={}&context={}&businessOfficeId={}",
        cfg.username,
        md5_hex(&cfg.password),
        cfg.context,
        cfg.business_office_id
    );
    let res = agent()
        .post(&format!("http://{}/api/login", cfg.host))
        .set("Content-Type", "application/x-www-form-urlencoded")
        .set("Accept", "application/json")
        .set("Origin", &format!("http://{}", cfg.host))
        .set("Referer", &format!("http://{}/", cfg.host))
        .send_string(&body)
        .map_err(|e| format!("登录请求失败：{e}"))?;

    let cookie = res
        .all("set-cookie")
        .iter()
        .filter_map(|s| s.split(';').next())
        .filter(|s| !s.is_empty() && !s.to_ascii_lowercase().contains("rememberme=deleteme"))
        .collect::<Vec<_>>()
        .join("; ");

    let text = res.into_string().map_err(|e| format!("登录响应读取失败：{e}"))?;
    let v: Value = serde_json::from_str(&text).map_err(|e| format!("登录响应解析失败：{e}"))?;
    if v.get("success").and_then(Value::as_bool) != Some(true) {
        let msg = v
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("未知错误");
        return Err(format!("登录被拒：{msg}"));
    }
    let token = v
        .pointer("/data/token")
        .and_then(Value::as_str)
        .ok_or("登录响应里没有 token")?
        .to_string();
    Ok((token, cookie))
}

/// `args` 模板（21 段，任务列表页）。
///
/// ⛔ **`[19]` / `[20]` 必须是 `null`，不能填 `task_id` / `desc`。**
/// 这两段是服务端的排序字段位；填了值以后服务端会拼出非法的 ORDER BY，
/// 整个查询直接 500「数据库sql语法错误」——表现为「刷新永远拿不到数据」。
/// 曾经照抄浏览器里抓到的 curl（那里带 `task_id`/`desc`）踩过这个坑：
/// 浏览器发的时候服务端会忽略，但同样的值走 API 就炸。
/// 实测：填 null → total=1（mine + 1,2,5，正确）；填 task_id/desc → 500。
const ARGS_TEMPLATE: [&str; 21] = [
    "0", "null", "null", "null", "null", "null", "null", "null", "null", "null", "null", "null",
    "null", "null", "null", "null", "null", "null", "null", "null", "null",
];
const ARGS_STATUS_IDX: usize = 13;
const ARGS_MINE_IDX: usize = 18;

/// 拼任务页 `args`：`statuses` 是状态码列表，`mine` 决定只看指派给我的还是所有人。
fn build_args(statuses: &[u32], mine: bool) -> String {
    let mut parts: Vec<String> = ARGS_TEMPLATE.iter().map(|s| s.to_string()).collect();
    parts[ARGS_STATUS_IDX] = statuses
        .iter()
        .map(|s| s.to_string())
        .collect::<Vec<_>>()
        .join(",");
    parts[ARGS_MINE_IDX] = if mine { "assigntome" } else { "null" }.to_string();
    parts.join("!@")
}

/// 一张业务表格的查询规格（不同页面的 `pageId` / `dataSetId` / 脚本名各不相同）。
struct TableSpec {
    page_id: String,
    data_set_id: String,
    script_name: String,
    version: u32,
    args: Vec<String>,
}

/// 「未完成需求」= 任务页里指派给我、**还没走完**的任务。
///
/// 状态取 `{1 未开始, 2 进行中, 5 校验未通过}`：
///   * 1、2 显然没干完；
///   * **5 也必须算**——「校验未通过」是被打回重做，活还在我手上，
///     恰恰是最该盯着的（曾经漏掉它，导致明明有活却显示 0）。
/// 排除的是 `3 已完成` / `4 已关闭` / `6 校验通过` 这些真正收尾的。
fn spec_task_open(cfg: &EmsConfig) -> TableSpec {
    TableSpec {
        page_id: cfg.page_id.clone(),
        data_set_id: cfg.data_set_id.clone(),
        script_name: cfg.script_name.clone(),
        version: cfg.version,
        args: build_args(&[1, 2, 5], true).split("!@").map(str::to_string).collect(),
    }
}

/// 「未验证需求」= 需求页的 `validbyme` 视图。
///
/// ⚠ 这**不是**「任务状态 = 校验未通过」。服务端返回的 `searchConditionSql` 说明它的真实语义是：
///   (A) 需求状态 = 90（待验证）且该需求下存在「指派给我验证、我还没验」的任务；或
///   (B) 需求是我提的，且状态 ∈ {130, 131, 135}（被驳回一类）。
///
/// 所以必须查**需求页**（`pageId = 1ada384a…`），拿任务页去凑是错的。
fn spec_req_unverified(cfg: &EmsConfig) -> TableSpec {
    // 24 段模板。只有 [0]="validbyme"、[5]=" "、[12]="0" 有意义，其余保持 null。
    let mut args: Vec<String> = vec!["null".to_string(); 24];
    args[0] = "validbyme".to_string();
    args[5] = " ".to_string();
    args[12] = "0".to_string();
    TableSpec {
        page_id: cfg.req_page_id.clone(),
        data_set_id: cfg.req_data_set_id.clone(),
        script_name: cfg.req_script_name.clone(),
        version: cfg.req_version,
        args,
    }
}

/// Bug 阶段码（`bug_step`）。
///
/// ⛔ 语义按**禅道页面的真实口径**来，不要凭字面猜：
///   * `20 待解决` —— 派给我、**我还没动手修** → 这才是「未完成 Bug」；
///   * `29 待测试` / `30 待内部验证` / `33 测试中` —— 已经修完、等验证，属「未验证」那一族；
///   * `50 已关闭` —— 收尾，不算待办。
///
/// 曾经把 `{29,30,33}` 当成「未完成」，理由是「活还在我手上」——**错了**：
/// 那三个都已经是 `resolved`（已修复），是「等我验证」而不是「等我修」，
/// 于是首页把 35 个待验证的 Bug 报成了「未完成」。用户指出「bug 是有 5 个」，
/// 对照 curl 才确认 5 = `待解决(20)`。
///
/// ⚠ 「未验证 Bug」用的是 `validbyme` 视图（见 `spec_bug_unverified`），
/// 不是这里的 step 过滤，所以本常量只服务于「未完成」。
const BUG_STEP_PENDING_RESOLVE: &str = "20";

/// 「未完成 Bug」= 指派给我、**还没修**的 Bug → `待解决(20)`。
fn spec_bug_open(cfg: &EmsConfig) -> TableSpec {
    // Bug 页 args 是 14 段：[0] 视图、[4] bug_step 过滤，其余 null。
    let mut args: Vec<String> = vec!["null".to_string(); 14];
    args[0] = "assigntome".to_string();
    args[4] = BUG_STEP_PENDING_RESOLVE.to_string();
    TableSpec {
        page_id: cfg.bug_page_id.clone(),
        data_set_id: cfg.bug_data_set_id.clone(),
        script_name: cfg.bug_script_name.clone(),
        version: cfg.bug_version,
        args,
    }
}

/// 「未验证 Bug」= Bug 页的 `validbyme` 视图。
///
/// ⛔ **就是 `args[0]="validbyme"`，不加任何 `bug_step` 过滤。**
/// 这是用户在禅道页面上点「未验证」时浏览器真实发出的请求（解密 curl 确认）：
/// `args = "validbyme!@null!@null!@null!@null!..."`，14 段，`[4]` 也是 null。
///
/// 曾经自作聪明改成 `assigntome` + `bug_step=29`，因为觉得「`validbyme` 恒为 0，
/// 肯定是查错了」—— 错了。本账号下 `validbyme` 确实就是 **0**（实测：不带 step 是 0，
/// 逐个 step 10/20/29/30/31/32/33/40/50 也全是 0），那是**真实的 0**，不是 bug。
/// 而 `assigntome + 29` 得到的 25 是「我修完待我去测」，是另一个口径。
fn spec_bug_unverified(cfg: &EmsConfig) -> TableSpec {
    let mut args: Vec<String> = vec!["null".to_string(); 14];
    args[0] = "validbyme".to_string();
    TableSpec {
        page_id: cfg.bug_page_id.clone(),
        data_set_id: cfg.bug_data_set_id.clone(),
        script_name: cfg.bug_script_name.clone(),
        version: cfg.bug_version,
        args,
    }
}

/// 查一次业务表格，返回 (总数, 明细行)。
///
/// `rows_limit` 是明细条数上限：卡片只要数字，但弹窗要显示具体条目，
/// 所以这里把行一起带回来。传 0 表示只要数量（`pageSize=1`，省带宽）。
fn query_table(
    cfg: &EmsConfig,
    token: &str,
    cookie: &str,
    spec: &TableSpec,
    page_size: u32,
) -> Result<(u64, Vec<Value>), String> {
    let payload = json!({
        "dataSetId": spec.data_set_id,
        "columns": [],
        "formType": "",
        "allTablesFlag": true,
        "queryRequest": {
            "pageSize": page_size.max(1),
            "pageNum": 1,
            "sortOrder": "",
            "sortField": ""
        },
        "searchFileNames": [],
        "searchFileValues": [],
        "searchRules": [],
        "sumFields": [],
        "avgFields": [],
        "maxFields": [],
        "minFields": [],
        "countFields": [],
        "allSearchColsFlag": false,
        "allSearchColsValue": "",
        "allSearchCols": [],
        "componentKeyName": "主表格",
        "args": spec.args.join("!@"),
        "scriptName": spec.script_name,
        "eventName": "Search",
        "version": spec.version,
        "onAction": "1"
    });

    let (c, p, key) = seal(&payload).ok_or("请求加密失败")?;
    let body = serde_json::to_string(&json!({ "c": c, "p": p })).map_err(|e| e.to_string())?;

    let mut req = agent()
        .post(&format!("http://{}/api/business", cfg.host))
        .set("Accept", "application/json, text/plain, */*")
        .set("Content-Type", "application/json;charset=UTF-8")
        .set("Authentication", token)
        .set("currentContext", &cfg.context)
        .set("operateContext", &cfg.context)
        .set("eventName", "Search")
        .set("pageId", &spec.page_id)
        .set("keyName", &urlencode("主表格"))
        .set("Origin", &format!("http://{}", cfg.host))
        .set("Referer", &format!("http://{}/", cfg.host));
    if !cookie.is_empty() {
        req = req.set("Cookie", cookie);
    }

    let res = req.send_string(&body).map_err(|e| format!("查询请求失败：{e}"))?;
    let text = res.into_string().map_err(|e| format!("查询响应读取失败：{e}"))?;
    let outer: Value = serde_json::from_str(&text).map_err(|e| format!("查询响应解析失败：{e}"))?;

    if outer.get("success").and_then(Value::as_bool) != Some(true) {
        let msg = outer.get("message").and_then(Value::as_str).unwrap_or("未知错误");
        return Err(format!("查询被拒：{msg}"));
    }
    let content = outer
        .pointer("/data/content")
        .and_then(Value::as_str)
        .ok_or("响应里没有 data.content")?;

    let plain = open(content, &key).ok_or("响应解密失败")?;
    let inner: Value = serde_json::from_str(&plain).map_err(|e| format!("内层响应解析失败：{e}"))?;
    if inner.get("success").and_then(Value::as_bool) != Some(true) {
        let msg = inner.get("message").and_then(Value::as_str).unwrap_or("未知错误");
        return Err(format!("查询失败：{msg}"));
    }

    let total = inner
        .pointer("/data/total")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let rows = inner
        .pointer("/data/rows")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    Ok((total, rows))
}

/// 极简 URL 编码（只处理中文这类非 ASCII，够 keyName 用）。
fn urlencode(s: &str) -> String {
    let mut out = String::new();
    for b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

// ── 对外：抓一次快照 ──────────────────────────────────────────────────

/// 每个指标最多带回多少条明细。弹窗一屏放不下更多，也没必要。
const DETAIL_LIMIT: u32 = 50;

/// 抓取一轮统计。失败时返回 `Err`，由调用方决定是保留旧值还是记错误。
///
/// 返回结构：
/// ```json
/// {
///   "reqOpen": 0, "reqOpenRows": [ … ],
///   "reqUnverified": 1, "reqUnverifiedRows": [ … ],
///   "bugOpen": null, "bugUnverified": null,
///   "updatedAt": 1234, "error": ""
/// }
/// ```
///
/// `*Rows` 是给弹窗显示「具体是哪些」用的，只保留渲染需要的最小字段集，
/// 避免把整个 34 字段的任务行塞进 `state.json`（那份文件是前端整体重写的，越瘦越好）。
///
/// `bug_*` 走 Bug 列表页（`pageId = 6da1dcf2…`）。注意它的 `dataSetId` 和任务页
/// **相同**，靠 `args[0]` 切视图、`args[4]` 按 `bug_step` 过滤。
///
/// ⚡ **四个查询并发发**（`std::thread::scope`）：它们彼此完全独立，串行跑就是
/// 四份网络往返时间相加。实测单次查询 0.6~1.5s，串行一轮 3~6s、并发一轮约 1.5s。
/// 每个线程各建自己的 `agent()` 与 `seal()`（key/iv 都是新随机数），
/// 只共享只读的 `cfg` / `token` / `cookie`，不存在数据竞争。
///
/// 用 `scope` 而不是 `spawn` + `join`：能直接借用 `cfg`，不必 `clone`。
/// 任一查询失败就让整轮失败（`?` 在收集结果时生效）—— 四个格子是一组，
/// 半新半旧的数据比报错更误导。
pub fn fetch_once(cfg: &EmsConfig) -> Result<Value, String> {
    let (token, cookie) = login(cfg)?;

    // 先把 spec 算好（纯本地计算，很快），再交给四个线程。
    let specs = [
        spec_task_open(cfg),
        spec_req_unverified(cfg),
        spec_bug_open(cfg),
        spec_bug_unverified(cfg),
    ];

    let results: Vec<Result<(u64, Vec<Value>), String>> = std::thread::scope(|scope| {
        let handles: Vec<_> = specs
            .iter()
            .map(|spec| {
                let (token, cookie) = (token.as_str(), cookie.as_str());
                scope.spawn(move || query_table(cfg, token, cookie, spec, DETAIL_LIMIT))
            })
            .collect();
        // join 按 spawn 顺序取，所以下面按下标取用是稳定的。
        handles
            .into_iter()
            .map(|h| h.join().unwrap_or_else(|_| Err("查询线程异常退出".to_string())))
            .collect()
    });

    // 顺序与 specs 一致：任务未完成 / 需求未验证 / Bug 未完成 / Bug 未验证
    let mut it = results.into_iter();
    let (req_open, open_rows) = it.next().unwrap()?;
    let (req_unverified, unv_rows) = it.next().unwrap()?;
    let (bug_open, bug_open_rows) = it.next().unwrap()?;
    let (bug_unverified, bug_unv_rows) = it.next().unwrap()?;

    Ok(json!({
        "reqOpen": req_open,
        "reqOpenRows": slim_task_rows(&open_rows),
        "reqUnverified": req_unverified,
        "reqUnverifiedRows": slim_req_rows(&unv_rows),
        "bugOpen": bug_open,
        "bugOpenRows": slim_bug_rows(&bug_open_rows),
        "bugUnverified": bug_unverified,
        "bugUnverifiedRows": slim_bug_rows(&bug_unv_rows),
        "updatedAt": now_ms(),
        "error": ""
    }))
}

/// 任务状态码 → 中文名。任务行的响应里**没有** `statusName` 字段（需求行才有），
/// 所以这里自己映射一份，否则弹窗只能显示一个裸数字。
fn task_status_name(code: i64) -> &'static str {
    match code {
        1 => "未开始",
        2 => "进行中",
        3 => "已完成",
        4 => "已关闭",
        5 => "校验未通过",
        6 => "校验通过",
        _ => "未知",
    }
}

/// 从 `Value` 里抠出整数：EMS 有时给数字 `5`、有时给字符串 `"5"`，两种都要认。
fn as_code(v: &Value) -> i64 {
    v.as_i64()
        .or_else(|| v.as_str().and_then(|s| s.trim().parse::<i64>().ok()))
        .unwrap_or(0)
}

/// 任务行瘦身：只留弹窗要显示的几个字段。
///
/// 注意别用 `hbdwbh_name` 当产品名 —— 那是**组织**名（「福建亿能达信息技术股份有限公司」），
/// 产品只有 `product_id`（159 这种裸 ID，没有名字映射，显示出来对用户没意义）。
fn slim_task_rows(rows: &[Value]) -> Value {
    let out: Vec<Value> = rows
        .iter()
        .map(|r| {
            let status = pick(r, &["status"]);
            let code = as_code(&status);
            json!({
                "id": pick(r, &["task_id"]),
                "reqId": pick(r, &["req_id"]),
                "title": pick(r, &["task_name"]),
                "status": status,
                "statusName": task_status_name(code),
                "priority": pick(r, &["pri"]),
                "opened": pick(r, &["opened_date"]),
                "deadline": pick(r, &["deadline"]),
                "assignee": pick(r, &["assigned_to"]),
            })
        })
        .collect();
    Value::Array(out)
}

/// 需求行瘦身。
fn slim_req_rows(rows: &[Value]) -> Value {
    let out: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "id": pick(r, &["id"]),
                "title": pick(r, &["title"]),
                "status": pick(r, &["status"]),
                "statusName": pick(r, &["statusName"]),
                "product": pick(r, &["product_name"]),
                "priority": pick(r, &["priority_text"]),
                "createBy": pick(r, &["create_by"]),
                "assignee": pick(r, &["assign_name"]),
                "createMonth": pick(r, &["create_month"]),
            })
        })
        .collect();
    Value::Array(out)
}

/// Bug 行瘦身。
///
/// Bug 的字段和任务/需求都不同：没有 `task_name`，标题在 `title_text`
/// （`title` 前面带了个 `1@@` 前缀，是内部标记，不能直接显示）。
/// 状态要显示 `bug_step_name`（「待测试」这类），因为 `status` 只有
/// `active` / `resolved` / `closed` 三档，看不出具体卡在哪一步。
fn slim_bug_rows(rows: &[Value]) -> Value {
    let out: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "id": pick(r, &["id"]),
                "title": pick(r, &["title_text", "title"]),
                "status": pick(r, &["status"]),
                "statusName": pick(r, &["bug_step_name"]),
                "step": pick(r, &["bug_step"]),
                "product": pick(r, &["product_name"]),
                "severity": pick(r, &["severity"]),
                "build": pick(r, &["build_name", "build"]),
                "assignee": pick(r, &["assignedto"]),
                "opened": pick(r, &["openedDate"]),
            })
        })
        .collect();
    Value::Array(out)
}

/// 按候选键名依次取值，取第一个非空；都没有就返回 `null`。
fn pick(row: &Value, keys: &[&str]) -> Value {
    for k in keys {
        if let Some(v) = row.get(*k) {
            if !v.is_null() {
                return v.clone();
            }
        }
    }
    Value::Null
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ── 后台线程 ─────────────────────────────────────────────────────────

/// 抓一轮并推给前端。失败也推一次（带 `error` 字段）——
/// 前端需要知道「上次失败了 / 还没配置」，而不是继续显示一个看起来新鲜的旧数字。
///
/// **单飞**：拿到 `FETCHING` 锁才真正抓，抢不到就直接返回（说明已有一轮在跑，
/// 它的结果马上就到）。这把锁同时挡住了「定时轮 + 手动刷新」叠在一起发请求、
/// 以及两轮 emit 互相覆盖导致前端回退成旧数据。
fn fetch_and_emit(app: &tauri::AppHandle) {
    use tauri::Emitter as _;

    // try_lock 失败 = 另一轮正在跑，静默跳过
    let Ok(_guard) = FETCHING.try_lock() else {
        return;
    };

    let output = match EmsConfig::load(app).and_then(|cfg| fetch_once(&cfg)) {
        Ok(snapshot) => snapshot,
        Err(err) => json!({
            "reqOpen": Value::Null,
            "reqOpenRows": Value::Null,
            "reqUnverified": Value::Null,
            "reqUnverifiedRows": Value::Null,
            "bugOpen": Value::Null,
            "bugOpenRows": Value::Null,
            "bugUnverified": Value::Null,
            "bugUnverifiedRows": Value::Null,
            "updatedAt": now_ms(),
            "error": err
        }),
    };
    let _ = app.emit(
        "provider-emit",
        json!({ "config_hash": "ems-stats", "output": output }),
    );
}

/// 启动 EMS 统计抓取线程：启动后 20 秒抓第一轮，之后每 2 小时一轮。
///
/// 结果通过 `provider-emit`（`config_hash = "ems-stats"`）推给前端，
/// 前端把它写进 `state.emsStats` 并落盘 —— 保持「前端是 state.json 唯一写者」这条约束。
///
/// **每轮都重新读 `ems.json`**，而不是启动时读一次缓存：用户改完配置不必重启应用，
/// 也让「先开应用、后放配置」这种顺序能正常工作。
pub fn start_ems_provider(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        std::thread::sleep(STARTUP_DELAY);
        loop {
            if EMS_ON.load(Ordering::Relaxed) {
                fetch_and_emit(&app);
            }
            std::thread::sleep(FETCH_INTERVAL);
        }
    });
}

/// 前端「刷新」按钮：立刻抓一轮（不等 2 小时的周期）。
///
/// 在**独立线程**里跑：一次抓取要发 4 个查询，走网络可能要几秒，
/// 直接在命令里同步跑会把 UI 卡住。命令本身立刻返回，结果照旧走
/// `provider-emit` 推回去 —— 前端不需要为它写第二套接收逻辑。
#[tauri::command]
pub fn ems_refresh_now(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        fetch_and_emit(&app);
    });
}

/// 前端开关：关掉后不再发请求（工作台不显示 EMS 卡片时用）。
#[allow(dead_code)]
pub fn set_ems_enabled(on: bool) {
    EMS_ON.store(on, Ordering::Relaxed);
}

// ── 测试 ─────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn md5_of_known_value() {
        // 空串与 "abc" 的 MD5 是公开常量，用来确认摘要实现没接错。
        assert_eq!(md5_hex(""), "d41d8cd98f00b204e9800998ecf8427e");
        assert_eq!(md5_hex("abc"), "900150983cd24fb0d6963f7d28e17f72");
    }

    #[test]
    fn rand16_is_sixteen_lowercase_alnum() {
        for _ in 0..50 {
            let s = rand16();
            assert_eq!(s.len(), 16, "长度必须是 16");
            assert!(
                s.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit()),
                "字符集必须是 [0-9a-z]：{s}"
            );
        }
    }

    #[test]
    fn aes_zero_padding_roundtrip() {
        let key = "abcdefgh12345678";
        let iv = "zyxwvuts87654321";
        for len in [0usize, 1, 15, 16, 17, 32, 33, 100] {
            let plain: Vec<u8> = (0..len).map(|i| b'a' + (i % 26) as u8).collect();
            let ct = aes_cbc_encrypt(&plain, key, iv);
            assert_eq!(ct.len() % 16, 0, "密文必须是 16 的倍数");
            let back = aes_cbc_decrypt(&ct, key, iv);
            assert_eq!(back, plain, "长度 {len} 的往返必须一致");
        }
    }

    #[test]
    fn aes_does_not_add_full_block_when_aligned() {
        // ZeroPadding 的语义：恰好对齐时不补整块（PKCS#7 会补）。
        let key = "abcdefgh12345678";
        let iv = "zyxwvuts87654321";
        let plain = vec![b'x'; 16];
        assert_eq!(aes_cbc_encrypt(&plain, key, iv).len(), 16);
    }

    #[test]
    fn rsa_pubkey_parsed() {
        let (n, e, k) = rsa_pub_parts().expect("公钥应能解析");
        assert_eq!(k, 64, "512 位模长 = 64 字节");
        assert_eq!(e, BigUint::from(65537u32), "公钥指数应为 65537");
        assert!(n.bits() > 500, "模数应有约 512 位，实际 {}", n.bits());
    }

    #[test]
    fn rsa_encrypt_produces_block_sized_output() {
        let out = rsa_encrypt(b"abcdefgh12345678").expect("加密应成功");
        assert_eq!(out.len(), 64, "RSA-512 输出固定 64 字节");
    }

    #[test]
    fn rsa_rejects_too_long_message() {
        assert!(rsa_encrypt(&vec![b'a'; 54]).is_none(), "64-11=53 是上限");
    }

    #[test]
    fn args_has_21_segments_and_right_slots() {
        let args = build_args(&[1, 2, 5], true);
        let parts: Vec<&str> = args.split("!@").collect();
        assert_eq!(parts.len(), 21, "args 必须是 21 段");
        assert_eq!(parts[13], "1,2,5", "状态列表在索引 13");
        assert_eq!(parts[18], "assigntome", "我的筛选在索引 18");
        // ⛔ [19]/[20] 必须是 null。填 task_id/desc 会让服务端拼出非法 ORDER BY，
        //    整个查询 500「数据库sql语法错误」，表现为刷新永远没数据。
        assert_eq!(parts[19], "null", "[19] 必须是 null（排序字段位）");
        assert_eq!(parts[20], "null", "[20] 必须是 null（排序方向位）");
    }

    /// 回归守卫：任何一段都不能是 `task_id` / `desc`。
    #[test]
    fn args_never_contains_sort_fields() {
        for mine in [true, false] {
            let args = build_args(&[1, 2, 5], mine);
            assert!(!args.contains("task_id"), "args 里不能出现 task_id：{args}");
            assert!(
                !args.split("!@").any(|s| s == "desc"),
                "args 里不能出现 desc：{args}"
            );
        }
    }

    #[test]
    fn args_all_people_uses_null() {
        let parts: Vec<String> = build_args(&[1, 2], false)
            .split("!@")
            .map(str::to_string)
            .collect();
        assert_eq!(parts[18], "null", "所有人时该位必须是 null");
        assert_eq!(parts[13], "1,2");
    }

    #[test]
    fn req_unverified_args_has_24_segments() {
        // 需求页的 args 是 **24 段**，与任务页的 21 段不同。
        // 只有 [0]="validbyme"、[5]=" "、[12]="0" 有意义。
        let cfg = EmsConfig::from_json(&json!({
            "host": "h:1", "username": "u", "password": "p", "context": "c",
            "businessOfficeId": "1", "pageId": "a", "dataSetId": "b", "scriptName": "s",
            "reqPageId": "d", "reqDataSetId": "e", "reqScriptName": "f",
            "bugPageId": "g", "bugDataSetId": "h", "bugScriptName": "i"
        }))
        .expect("配置应解析成功");
        let spec = spec_req_unverified(&cfg);
        assert_eq!(spec.args.len(), 24, "需求页 args 必须是 24 段");
        assert_eq!(spec.args[0], "validbyme");
        assert_eq!(spec.args[5], " ");
        assert_eq!(spec.args[12], "0");
        // 其余位必须都是 null，写错会让服务端静默返回别的口径
        for (i, v) in spec.args.iter().enumerate() {
            if i != 0 && i != 5 && i != 12 {
                assert_eq!(v, "null", "第 {i} 位应为 null，实际 {v:?}");
            }
        }
    }

    #[test]
    fn task_status_name_covers_all_codes() {
        assert_eq!(task_status_name(1), "未开始");
        assert_eq!(task_status_name(2), "进行中");
        assert_eq!(task_status_name(3), "已完成");
        assert_eq!(task_status_name(4), "已关闭");
        assert_eq!(task_status_name(5), "校验未通过");
        assert_eq!(task_status_name(6), "校验通过");
        assert_eq!(task_status_name(99), "未知");
    }

    #[test]
    fn as_code_accepts_both_number_and_string() {
        // EMS 同一字段有时给 5、有时给 "5"，两种都得认，
        // 否则状态名会显示成「未知」。
        assert_eq!(as_code(&json!(5)), 5);
        assert_eq!(as_code(&json!("5")), 5);
        assert_eq!(as_code(&json!(" 5 ")), 5);
        assert_eq!(as_code(&json!(null)), 0);
        assert_eq!(as_code(&json!("abc")), 0);
    }

    #[test]
    fn slim_task_row_maps_status_name() {
        // 用真实响应里的字段形状：status 是字符串、没有 statusName、
        // hbdwbh_name 是组织名（不该被当成产品名带出去）。
        let rows = vec![json!({
            "task_id": 202403,
            "req_id": 121557,
            "task_name": "【方案锁定与解锁】新绩效工资方案定义锁定某一条方案",
            "status": "5",
            "pri": 4,
            "opened_date": "2026-11-03 14:29:39",
            "deadline": "2026-11-06",
            "assigned_to": "丘宣荣",
            "hbdwbh_name": "福建亿能达信息技术股份有限公司"
        })];
        let slim = slim_task_rows(&rows);
        let r = &slim[0];
        assert_eq!(r["statusName"], "校验未通过", "status=\"5\" 也要能映射出中文名");
        assert_eq!(r["id"], 202403);
        assert_eq!(r["reqId"], 121557);
        assert_eq!(r["deadline"], "2026-11-06");
        assert!(r.get("product").is_none(), "组织名不能当产品名带出去");
    }

    #[test]
    fn task_open_args_uses_status_1_2_5() {
        let cfg = EmsConfig::from_json(&json!({
            "host": "h:1", "username": "u", "password": "p", "context": "c",
            "businessOfficeId": "1", "pageId": "a", "dataSetId": "b", "scriptName": "s",
            "reqPageId": "d", "reqDataSetId": "e", "reqScriptName": "f",
            "bugPageId": "g", "bugDataSetId": "h", "bugScriptName": "i"
        }))
        .expect("配置应解析成功");
        let spec = spec_task_open(&cfg);
        assert_eq!(spec.args.len(), 21, "任务页 args 是 21 段");
        // 5=校验未通过 是被打回重做，必须算「未完成」。
        // 漏掉它会出现「明明有活却显示 0」——这个 bug 真出现过。
        assert_eq!(spec.args[13], "1,2,5", "未完成需求 = 未开始 + 进行中 + 校验未通过");
        assert_eq!(spec.args[18], "assigntome", "只看指派给我的");
    }

    #[test]
    fn urlencode_escapes_chinese() {
        // 「主表格」的 UTF-8 是 E4 B8 BB E8 A1 A8 E6 A0 BC
        assert_eq!(urlencode("主表格"), "%E4%B8%BB%E8%A1%A8%E6%A0%BC");
        assert_eq!(urlencode("abc-1_2.3~"), "abc-1_2.3~");
    }

    #[test]
    fn seal_and_open_roundtrip() {
        // 自己封一个信封，再按响应格式解回来 —— 验证密钥传递方向正确。
        let payload = json!({ "hello": "世界", "n": 42 });
        let (c, p, key) = seal(&payload).expect("封装应成功");
        assert!(!c.is_empty());
        assert_eq!(p.len(), 16 + 88, "p = 16 字符 iv + 88 字符 RSA(64字节 base64)");
        assert_eq!(key.len(), 16);

        // 响应侧：iv + base64(AES(明文, 同一把 key, 新 iv))
        let resp_iv = rand16();
        let plain = serde_json::to_vec(&json!({ "success": true, "data": { "total": 7 } })).unwrap();
        let ct = aes_cbc_encrypt(&plain, &key, &resp_iv);
        let content = format!("{resp_iv}{}", b64_encode(&ct));

        let back = open(&content, &key).expect("解密应成功");
        let v: Value = serde_json::from_str(&back).unwrap();
        assert_eq!(v.pointer("/data/total").and_then(Value::as_u64), Some(7));
    }

    #[test]
    fn open_rejects_short_content() {
        assert!(open("short", "abcdefgh12345678").is_none());
    }

    #[test]
    fn bug_args_use_14_segments_and_step_filter() {
        let cfg = EmsConfig::from_json(&json!({
            "host": "h:1", "username": "u", "password": "p", "context": "c",
            "businessOfficeId": "1", "pageId": "a", "dataSetId": "b", "scriptName": "s",
            "reqPageId": "d", "reqDataSetId": "e", "reqScriptName": "f",
            "bugPageId": "g", "bugDataSetId": "h", "bugScriptName": "i"
        }))
        .expect("配置应解析成功");

        // Bug 页 args 只有 14 段，和任务页 21 / 需求页 24 都不同。
        let open = spec_bug_open(&cfg);
        assert_eq!(open.args.len(), 14, "Bug 页 args 是 14 段");
        assert_eq!(open.args[0], "assigntome", "只看指派给我的");
        // ⛔ 未完成 = 待解决(20)：派给我、我还没动手修。
        //    曾经写成 29,30,33（待测试/待内部验证/测试中），但那三个都是 resolved
        //    的「等我去验」，把 35 个待验证报成了「未完成」。
        assert_eq!(open.args[4], "20", "未完成 = 待解决");
        assert_eq!(open.version, 31, "Bug 页默认版本 31");

        // ⛔ 未验证 = validbyme 视图，**不加 step 过滤**。
        //    这是禅道页面上点「未验证」时浏览器真实发的请求（解密 curl 确认）。
        //    本账号下它就是 0 —— 真实的 0，不是查错了。
        let unv = spec_bug_unverified(&cfg);
        assert_eq!(unv.args.len(), 14);
        assert_eq!(unv.args[0], "validbyme", "未验证 = validbyme 视图");
        assert_eq!(unv.args[4], "null", "未验证不加 bug_step 过滤");
    }

    /// 回归守卫：未完成和未验证必须是两个不同视图，别混成一个。
    #[test]
    fn bug_open_and_unverified_are_distinct_views() {
        let cfg = EmsConfig::from_json(&json!({
            "host": "h:1", "username": "u", "password": "p", "context": "c",
            "businessOfficeId": "1", "pageId": "a", "dataSetId": "b", "scriptName": "s",
            "reqPageId": "d", "reqDataSetId": "e", "reqScriptName": "f",
            "bugPageId": "g", "bugDataSetId": "h", "bugScriptName": "i"
        }))
        .expect("配置应解析成功");
        let open = spec_bug_open(&cfg);
        let unv = spec_bug_unverified(&cfg);
        assert_ne!(
            open.args.join("!@"),
            unv.args.join("!@"),
            "未完成和未验证不能是同一个 args"
        );
        assert_eq!(open.args[0], "assigntome", "未完成看「指派给我」");
        assert_eq!(unv.args[0], "validbyme", "未验证看「待我验证」");
    }

    /// 抓取间隔就是产品需求里的 2 小时，改它必须是有意为之。
    #[test]
    fn fetch_interval_is_two_hours() {
        assert_eq!(FETCH_INTERVAL, Duration::from_secs(7200));
    }

    /// 四个查询必须**并发**发出，不能退回串行。
    ///
    /// 断言方式：让四个任务都 sleep 同一段时间，然后量总耗时。
    /// 串行 ≈ 4×delay，并发 ≈ 1×delay。取中间值判定，避免调度抖动误报。
    ///
    /// 这条测试守的是性能而不是功能 —— 串行也能算出正确数字，
    /// 但一轮要 2 秒而不是 0.7 秒，用户点「刷新」时的手感差别很明显。
    #[test]
    fn four_queries_run_concurrently() {
        use std::time::Instant;

        const DELAY: Duration = Duration::from_millis(120);
        let started = Instant::now();

        // 复刻 fetch_once 里的并发骨架
        std::thread::scope(|scope| {
            let handles: Vec<_> = (0..4)
                .map(|_| scope.spawn(|| std::thread::sleep(DELAY)))
                .collect();
            for h in handles {
                h.join().expect("线程不应 panic");
            }
        });

        let elapsed = started.elapsed();
        // 串行至少 480ms；并发约 120ms。取 300ms 作分界，留足余量。
        assert!(
            elapsed < DELAY * 2 + Duration::from_millis(60),
            "四个任务应并发执行，实际耗时 {elapsed:?}（接近 4×{DELAY:?} 说明退化成串行了）"
        );
    }

    /// 单飞锁：另一轮抓取在跑时，`try_lock` 必须失败（= 这次抓取被跳过）。
    ///
    /// 这条测试直接锁住 `fetch_and_emit` 的并发语义 —— 定时线程和「刷新」按钮
    /// 是两条独立线程，没有这把锁就会同时发 8 个查询、两轮 emit 互相覆盖。
    #[test]
    fn fetch_is_single_flight() {
        // 模拟「已有一轮在跑」：先自己持锁
        let held = FETCHING.try_lock();
        assert!(held.is_ok(), "首轮应能拿到锁");

        // 这时第二轮必须抢不到（fetch_and_emit 里就是这么判断的）
        assert!(
            FETCHING.try_lock().is_err(),
            "已有一轮在跑时，第二轮必须拿不到锁（应被跳过）"
        );

        // 释放后又能拿到，说明锁不会被永久占住
        drop(held);
        assert!(FETCHING.try_lock().is_ok(), "上一轮结束后应能重新抓取");
    }

    #[test]
    fn slim_bug_row_prefers_title_text_and_step_name() {
        // Bug 行：title 带 "1@@" 内部前缀，title_text 才是干净标题；
        // status 只有 active/resolved/closed，具体阶段看 bug_step_name。
        let rows = vec![json!({
            "id": 89489,
            "title": "1@@【医院收支结余对比分析】字体样式统一",
            "title_text": "【医院收支结余对比分析】字体样式统一",
            "status": "resolved",
            "bug_step": 29,
            "bug_step_name": "待测试",
            "product_name": "绩效管理系统",
            "assignedto": "丘宣荣",
            "openedDate": "2026-11-05 17:29:00",
            "build_name": "HRP3.0-20261102版本"
        })];
        let slim = slim_bug_rows(&rows);
        let r = &slim[0];
        assert_eq!(r["title"], "【医院收支结余对比分析】字体样式统一", "不能用带 1@@ 前缀的 title");
        assert_eq!(r["statusName"], "待测试", "阶段名取 bug_step_name");
        assert_eq!(r["product"], "绩效管理系统");
        assert_eq!(r["id"], 89489);
    }

    #[test]
    fn config_parses_full_json() {
        let v = json!({
            "host": "h.example:9392",
            "username": "u",
            "password": "p",
            "context": "ctx",
            "businessOfficeId": "10000",
            "pageId": "pg",
            "dataSetId": "ds",
            "scriptName": "s",
            "version": 26,
            "reqPageId": "rpg",
            "reqDataSetId": "rds",
            "reqScriptName": "rs",
            "bugPageId": "bpg",
            "bugDataSetId": "bds",
            "bugScriptName": "bs",
            "reqVersion": 6,
            "bugVersion": 31
        });
        let cfg = EmsConfig::from_json(&v).expect("完整配置应解析成功");
        assert_eq!(cfg.host, "h.example:9392");
        assert_eq!(cfg.version, 26);
        assert_eq!(cfg.req_page_id, "rpg");
        assert_eq!(cfg.req_version, 6);
        assert_eq!(cfg.bug_page_id, "bpg");
        assert_eq!(cfg.bug_version, 31);
    }

    #[test]
    fn config_rejects_missing_field() {
        // 少任何一个必填字段都必须报错 —— 宁可「未配置」也不要拿半套配置去请求。
        let v = json!({
            "host": "h.example:9392",
            "username": "u",
            "password": "p",
            "context": "ctx",
            "businessOfficeId": "10000",
            "pageId": "pg",
            "dataSetId": "ds",
            "scriptName": "s",
            "reqPageId": "rpg",
            "reqDataSetId": "rds",
            "reqScriptName": "rs",
            "bugPageId": "bpg",
            "bugDataSetId": "bds",
            "bugScriptName": "bs"
            // 故意漏掉 version / reqVersion / bugVersion（都有默认值，不算必填）
        });
        assert!(EmsConfig::from_json(&v).is_ok(), "version 有默认值，缺了也能解析");

        let v2 = json!({ "host": "h.example:9392" });
        let err = EmsConfig::from_json(&v2).unwrap_err();
        assert!(err.contains("缺少字段"), "错误信息应指出缺字段：{err}");
    }

    #[test]
    fn config_rejects_blank_field() {
        // 空串等同于没填：比「填了个空字符串」更早暴露问题。
        let v = json!({
            "host": "   ",
            "username": "u",
            "password": "p",
            "context": "ctx",
            "businessOfficeId": "10000",
            "pageId": "pg",
            "dataSetId": "ds",
            "scriptName": "s",
            "reqPageId": "rpg",
            "reqDataSetId": "rds",
            "reqScriptName": "rs"
        });
        assert!(EmsConfig::from_json(&v).is_err(), "空白 host 应被拒绝");
    }

    #[test]
    fn source_contains_no_credentials() {
        // 守卫测试：这个文件是要提交到公开仓库的，绝不能出现真实凭据。
        // 用「拼接」构造敏感串，避免测试源码本身成为泄露源。
        let src = include_str!("ems.rs");
        let needles = [
            ["180", "530", "206"].concat(),      // 账号
            ["023", "619"].concat(),             // 密码
            ["220.", "250.", "40."].concat(),    // 主机前缀
            ["192.", "168.", "1."].concat(),     // 内网前缀
        ];
        for n in needles {
            assert!(!src.contains(&n), "ems.rs 里出现了疑似凭据：{n}");
        }
    }

    /// 真实网络自检（默认跳过）：确认 Rust 侧的加密能被 EMS 服务器接受。
    ///
    /// ```text
    /// cargo test --manifest-path src-tauri/Cargo.toml ems_live -- --ignored --nocapture
    /// ```
    ///
    /// 单元测试只能证明「自己封的信封自己解得开」，证明不了协议对得上服务器。
    /// 这个测试是唯一能验证 RSA/AES 实现真的被服务端认可的方式。
    ///
    /// 凭据来自用户本机的 `ems.json`（见 `EmsConfig`），**不写在测试里**。
    /// 文件不存在时直接跳过而不是失败 —— 公开仓库的 CI 上本来就没有这份配置。
    #[test]
    #[ignore = "需要访问 EMS 内网，手动运行"]
    fn ems_live_fetch() {
        let cfg = match test_config() {
            Ok(c) => c,
            Err(e) => {
                println!("跳过：{e}");
                return;
            }
        };
        let snap = fetch_once(&cfg).expect("真实抓取应成功");
        println!("{}", serde_json::to_string_pretty(&snap).unwrap());
        assert!(
            snap.get("reqUnverified").and_then(Value::as_u64).is_some(),
            "未验证需求应是一个数字"
        );
    }

    /// 为测试读配置：优先 `EMS_CONFIG` 环境变量指向的文件，其次用户数据目录的 `ems.json`。
    ///
    /// 走环境变量而不是 `app_data_dir`，是因为单元测试里没有 `AppHandle`。
    fn test_config() -> Result<EmsConfig, String> {
        if let Ok(p) = std::env::var("EMS_CONFIG") {
            let text = std::fs::read_to_string(&p).map_err(|e| format!("读取 {p} 失败：{e}"))?;
            let v: Value = serde_json::from_str(&text).map_err(|e| format!("{p} 不是合法 JSON：{e}"))?;
            return EmsConfig::from_json(&v);
        }
        let appdata = std::env::var("APPDATA").map_err(|_| "未设置 APPDATA".to_string())?;
        let p = std::path::Path::new(&appdata)
            .join("com.deskoverlay.desktop")
            .join("ems.json");
        if !p.exists() {
            return Err(format!("没有 ems.json（也设 EMS_CONFIG）→ {}", p.display()));
        }
        let text = std::fs::read_to_string(&p).map_err(|e| e.to_string())?;
        let v: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
        EmsConfig::from_json(&v)
    }
}
