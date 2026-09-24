//! HTTP 代理：为前端插件提供 GET/POST/二进制请求能力，绕过 WebView 跨域限制。
//! 共享 ureq Agent（连接池）、统一注入默认 UA 与响应解码（gzip 魔数 / charset 回退）。

use std::io::Read;
use std::sync::OnceLock;

/// 共享 HTTP Agent：复用连接池（keep-alive + TLS 会话），避免每次请求重建。
/// 音源插件频繁请求第三方接口时显著减少握手开销。
static AGENT: OnceLock<ureq::Agent> = OnceLock::new();
fn agent() -> &'static ureq::Agent {
    AGENT.get_or_init(|| ureq::AgentBuilder::new().build())
}

/// 构建请求：注入默认 UA + 可选自定义 headers。
fn build_headers(req: ureq::Request, headers: &Option<serde_json::Value>) -> ureq::Request {
    let mut r = req.set(
        "User-Agent",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) DeskOverlay/0.3.0",
    );
    if let Some(h) = headers.as_ref().and_then(|v| v.as_object()) {
        for (k, v) in h {
            if let Some(s) = v.as_str() {
                // accept-encoding 必须剥离：插件手动透传 gzip 时 ureq 不做透明解压
                //（只解压自己协商的头），响应保持压缩字节 → read_to_string 报
                // "stream did not contain valid UTF-8"。剥掉后由 ureq（gzip feature）
                // 自动协商并解压，文本通道始终拿到明文。
                if k.eq_ignore_ascii_case("accept-encoding") {
                    continue;
                }
                r = r.set(k, s);
            }
        }
    }
    r
}

/// 响应字节 → 文本（http_get / http_post 共用）。
/// 1) gzip 魔数(1f 8b)强制解压——部分服务器无视协商头硬性返回压缩字节；
/// 2) 严格 UTF-8 优先；失败时按 Content-Type charset 解码，未声明则回退 GBK
///    （中文站点非 UTF-8 响应的常态），避免 "stream did not contain valid UTF-8"。
fn decode_response(resp: ureq::Response) -> Result<String, String> {
    let content_type = resp.header("Content-Type").unwrap_or("").to_string();
    let mut bytes = Vec::new();
    resp.into_reader()
        .take(5 * 1024 * 1024)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() > 2 && bytes[0] == 0x1f && bytes[1] == 0x8b {
        let mut gz = flate2::read::GzDecoder::new(&bytes[..]);
        let mut raw = Vec::new();
        gz.read_to_end(&mut raw)
            .map_err(|e| format!("gzip 解压失败：{e}"))?;
        bytes = raw;
    }
    if let Ok(s) = std::str::from_utf8(&bytes) {
        return Ok(s.to_string());
    }
    let charset = content_type
        .split(';')
        .find_map(|p| p.trim().strip_prefix("charset=").map(|c| c.trim_matches('"').trim().to_string()))
        .unwrap_or_default();
    let enc = encoding_rs::Encoding::for_label(charset.as_bytes())
        .or_else(|| encoding_rs::Encoding::for_label(b"gbk"))
        .unwrap_or(encoding_rs::UTF_8);
    let (text, _encoding, _had_errors) = enc.decode(&bytes);
    Ok(text.into_owned())
}

/// HTTP GET 代理：绕过 WebView 跨域限制，供音乐音源插件请求第三方接口。
/// headers 为可选 JSON 对象（键值均为字符串）。
/// 注意：ureq 为阻塞式 I/O，禁止在主线程命令里直接调用，否则整个应用（含 WebView 事件循环）
/// 会在请求期间冻结（最长 15s 超时）。因此命令声明为 async，把阻塞逻辑放进 spawn_blocking。
fn http_get_blocking(url: String, headers: Option<serde_json::Value>) -> Result<String, String> {
    let u = url.trim();
    if !(u.starts_with("http://") || u.starts_with("https://")) {
        return Err("仅支持 http/https 地址".to_string());
    }
    let resp = build_headers(agent().get(u), &headers)
        .timeout(std::time::Duration::from_secs(15))
        .call()
        .map_err(|e| e.to_string())?;
    decode_response(resp)
}

#[tauri::command]
pub async fn http_get(url: String, headers: Option<serde_json::Value>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || http_get_blocking(url, headers))
        .await
        .map_err(|e| format!("网络任务执行失败: {e}"))?
}

/// HTTP POST 代理：同 http_get，支持发送请求体（JSON/表单字符串）。
fn http_post_blocking(url: String, body: String, headers: Option<serde_json::Value>) -> Result<String, String> {
    let u = url.trim();
    if !(u.starts_with("http://") || u.starts_with("https://")) {
        return Err("仅支持 http/https 地址".to_string());
    }
    let resp = build_headers(agent().post(u), &headers)
        .timeout(std::time::Duration::from_secs(15))
        .send_string(&body)
        .map_err(|e| e.to_string())?;
    decode_response(resp)
}

#[tauri::command]
pub async fn http_post(url: String, body: String, headers: Option<serde_json::Value>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || http_post_blocking(url, body, headers))
        .await
        .map_err(|e| format!("网络任务执行失败: {e}"))?
}

/// HTTP GET 二进制代理：返回 base64 编码的响应体。
/// 供音源插件 `responseType: "arraybuffer"` 请求使用（如咪咕 VIP 加密取流），
/// 二进制不能走 http_get 文本通道（UTF-8 解码会损坏/报错）。
#[tauri::command]
pub async fn http_get_bytes(url: String, headers: Option<serde_json::Value>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let u = url.trim();
        if !(u.starts_with("http://") || u.starts_with("https://")) {
            return Err("仅支持 http/https 地址".to_string());
        }
        let resp = build_headers(agent().get(u), &headers)
            .timeout(std::time::Duration::from_secs(15))
            .call()
            .map_err(|e| e.to_string())?;
        let mut bytes = Vec::new();
        resp.into_reader()
            .take(5 * 1024 * 1024)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        use base64::Engine as _;
        Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
    })
    .await
    .map_err(|e| format!("网络任务执行失败: {e}"))?
}

/// 抓取指定 http(s) 地址响应的原始字节（上限 2MB）。供 favicon 图标读取。
pub(crate) fn fetch_bytes(url: &str) -> Result<Vec<u8>, String> {
    let resp = build_headers(agent().get(url), &None)
        .timeout(std::time::Duration::from_secs(10))
        .call()
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    resp.into_reader()
        .take(2 * 1024 * 1024)
        .read_to_end(&mut out)
        .map_err(|e| e.to_string())?;
    Ok(out)
}