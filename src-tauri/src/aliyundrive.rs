//! 阿里云盘对接（P1 播放链路）：社区授权绑定 + 官方 OpenAPI 直调。
//! 设计见 .raccoon/aliyundrive-music-design.md。
//!
//! 通道说明（2026-09 核实）：
//! - 开放平台 2025-07 起暂停个人开发者申请 → 采用 AList/OpenList 社区托管授权页
//!   扫码获取 refresh_token，之后直调阿里官方开放接口（openapi.alipan.com）。
//! - access_token 约 2h；refresh_token 约 30 天且滚动失效（刷新后旧值立即作废）
//!   → 每次刷新成功必须原子落盘新 refresh_token，Mutex 串行防并发重复刷新。
//! - ureq 阻塞式 I/O：所有网络调用经 spawn_blocking，不占 async 运行时线程。

use std::io::{Read as _, Seek as _};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, UNIX_EPOCH};

use serde::Deserialize;
use tauri::{AppHandle, Manager};

/// OpenAPI 基址（官方）
const API_BASE: &str = "https://openapi.alipan.com";
/// 刷新代理：社区 token（alistgo 官方工具页签发，client b8c990e6…）的 secret 由
/// alistgo 服务端持有，本机无法直接调官方 /oauth/access_token（会报 invalid client_secret）。
/// 走 alistgo 续期代理：POST {grant_type:refresh_token, refresh_token} → 新 token 对。
const REFRESH_URL: &str = "https://api.alistgo.com/alist/ali_open/token";
/// 凭证目录（app_data_dir/aliyundrive）
const AD_DIR: &str = "aliyundrive";
/// 提前刷新余量：过期前 10 分钟主动续期
const REFRESH_MARGIN_SECS: u64 = 600;

/// 刷新串行锁：refresh_token 滚动失效，并发刷新会导致其中一个新 token 被另一个旧请求作废
static REFRESH_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn refresh_lock() -> &'static Mutex<()> {
    REFRESH_LOCK.get_or_init(|| Mutex::new(()))
}

/// 凭证目录：app_data_dir/aliyundrive
fn ad_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("获取数据目录失败：{e}"))?
        .join(AD_DIR);
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建凭证目录失败：{e}"))?;
    Ok(dir)
}

fn token_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(ad_dir(app)?.join("token.json"))
}

/// 本地凭证（token.json 结构）
#[derive(Debug, Clone, Deserialize, serde::Serialize)]
struct TokenState {
    refresh_token: String,
    access_token: String,
    /// access_token 过期时间（unix 秒）
    expires_at: u64,
}

fn load_tokens(app: &AppHandle) -> Option<TokenState> {
    let p = token_path(app).ok()?;
    let s = std::fs::read_to_string(p).ok()?;
    serde_json::from_str(&s).ok()
}

fn save_tokens(app: &AppHandle, st: &TokenState) -> Result<(), String> {
    let p = token_path(app)?;
    // 原子写：先写临时文件再 rename，防中途崩溃损坏凭证
    let tmp = p.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string(st).map_err(|e| e.to_string())?)
        .map_err(|e| format!("写入凭证失败：{e}"))?;
    std::fs::rename(&tmp, &p).map_err(|e| format!("落盘凭证失败：{e}"))?;
    Ok(())
}

/// token 脱敏：日志/错误信息只显示前 6 位
fn mask(t: &str) -> String {
    let mut s: String = t.chars().take(6).collect();
    s.push('…');
    s
}

/// 用 refresh_token 换新 token 对（官方 /oauth/access_token）。
/// 成功后返回新 TokenState（含新 refresh_token，调用方必须落盘）。
fn do_refresh(refresh_token: &str) -> Result<TokenState, String> {
    #[derive(Deserialize)]
    struct Resp {
        access_token: String,
        refresh_token: String,
        expires_in: u64,
    }
    let agent = http_agent();
    let resp = agent
        .post(REFRESH_URL)
        .send_json(serde_json::json!({
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
        }))
        .map_err(|e| match e {
            ureq::Error::Status(code, r) => {
                let body = r.into_string().unwrap_or_default();
                // 常见：invalid_grant（refresh_token 已失效/被作废）→ 提示重新扫码
                if body.contains("invalid_grant") || body.contains("InvalidRefreshToken") || body.contains("RefreshTokenInvalid") || body.contains("invalid refresh_token") {
                    format!("refresh_token 已失效（{}），请重新扫码授权", mask(refresh_token))
                } else {
                    format!("刷新令牌失败（HTTP {code}）：{}", &body[..body.len().min(200)])
                }
            }
            other => format!("刷新令牌网络错误：{other}"),
        })?;
    let r: Resp = resp.into_json().map_err(|e| format!("解析令牌响应失败：{e}"))?;
    Ok(TokenState {
        access_token: r.access_token,
        refresh_token: r.refresh_token,
        expires_at: now_secs() + r.expires_in.saturating_sub(REFRESH_MARGIN_SECS),
    })
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

// ── HTTP 连接复用与直链缓存（降低首播延迟） ─────────────────────
// 每次新建 Agent = 完整 TLS 握手（openapi + OSS 两跳）；媒体栈对同一首歌会发
// 探测 + 真实多次请求，每请求重签直链一次 → 首播延迟被放大数倍。
// 全局 Agent（连接池 keep-alive）+ 直链缓存（直链有效期数小时，缓存 25 分钟留余量）。

fn http_agent() -> &'static ureq::Agent {
    static AGENT: OnceLock<ureq::Agent> = OnceLock::new();
    AGENT.get_or_init(|| {
        ureq::AgentBuilder::new()
            .timeout_connect(Duration::from_secs(10))
            .build()
    })
}

fn url_cache() -> &'static Mutex<HashMap<String, (String, std::time::Instant)>> {
    static URL_CACHE: OnceLock<Mutex<HashMap<String, (String, std::time::Instant)>>> =
        OnceLock::new();
    URL_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

const URL_CACHE_TTL: Duration = Duration::from_secs(25 * 60);
/// 缓存容量上限：满了先清过期条目，仍超限则淘汰最旧写入（防长期使用无界增长）
const URL_CACHE_CAP: usize = 64;

/// 取播放直链：优先缓存（force=true 跳过缓存强制重签），未命中调接口并写缓存
fn cached_url(app: &AppHandle, file_id: &str, force: bool) -> Result<String, String> {
    if !force {
        if let Ok(m) = url_cache().lock() {
            if let Some((url, at)) = m.get(file_id) {
                if at.elapsed() < URL_CACHE_TTL {
                    return Ok(url.clone());
                }
            }
        }
    }
    let url = get_download_url_blocking(app, file_id)?;
    if let Ok(mut m) = url_cache().lock() {
        // 容量治理：先清过期，仍满则按写入时间淘汰最旧
        if m.len() >= URL_CACHE_CAP {
            m.retain(|_, (_, at)| at.elapsed() < URL_CACHE_TTL);
            if m.len() >= URL_CACHE_CAP {
                if let Some(oldest) = m
                    .iter()
                    .min_by_key(|(_, (_, at))| *at)
                    .map(|(k, _)| k.clone())
                {
                    m.remove(&oldest);
                }
            }
        }
        m.insert(file_id.to_string(), (url.clone(), std::time::Instant::now()));
    }
    Ok(url)
}

/// 确保拿到有效 access_token：未过期直接用；过期则串行刷新并落盘。
/// 双重检查（锁外判过期 + 锁内再判）避免排队线程重复刷新。
fn ensure_access(app: &AppHandle) -> Result<String, String> {
    let st = load_tokens(app).ok_or("未绑定阿里云盘，请先在设置中授权")?;
    if now_secs() < st.expires_at {
        return Ok(st.access_token);
    }
    let _g = refresh_lock().lock().map_err(|_| "刷新锁异常")?;
    // 锁内重读：可能已被前一个等待线程刷新
    let st = load_tokens(app).ok_or("未绑定阿里云盘，请先在设置中授权")?;
    if now_secs() < st.expires_at {
        return Ok(st.access_token);
    }
    let new_st = do_refresh(&st.refresh_token)?;
    save_tokens(app, &new_st)?;
    Ok(new_st.access_token)
}

/// 统一 OpenAPI POST 调用：带 Bearer，401 时刷新重试一次
fn api_call(app: &AppHandle, path: &str, body: serde_json::Value) -> Result<serde_json::Value, String> {
    let call = |token: &str| -> Result<serde_json::Value, String> {
        http_agent()
            .post(&format!("{API_BASE}{path}"))
            .set("Authorization", &format!("Bearer {token}"))
            .send_json(body.clone())
            .map_err(|e| match e {
                ureq::Error::Status(code, r) => {
                    let body = r.into_string().unwrap_or_default();
                    format!("__HTTP_{code}__{}", &body[..body.len().min(200)])
                }
                other => format!("__NET__{other}"),
            })?
            .into_json::<serde_json::Value>()
            .map_err(|e| format!("解析响应失败：{e}"))
    };
    let token = ensure_access(app)?;
    match call(&token) {
        Ok(v) => Ok(v),
        Err(e) if e.starts_with("__HTTP_401__") => {
            // 强制刷新后重试一次
            let _g = refresh_lock().lock().map_err(|_| "刷新锁异常")?;
            let st = load_tokens(app).ok_or("未绑定阿里云盘")?;
            if now_secs() >= st.expires_at {
                let new_st = do_refresh(&st.refresh_token)?;
                save_tokens(app, &new_st)?;
                return call(&new_st.access_token);
            }
            Err(e)
        }
        Err(e) => Err(e.trim_start_matches("__").replace("__", " ")),
    }
}

/// drive_id 缓存（会话内不变）
static DRIVE_ID: OnceLock<String> = OnceLock::new();

fn drive_id(app: &AppHandle) -> Result<String, String> {
    if let Some(id) = DRIVE_ID.get() {
        return Ok(id.clone());
    }
    let v = api_call(app, "/adrive/v1.0/user/getDriveInfo", serde_json::json!({}))?;
    let id = v["resource_drive_id"]
        .as_str()
        .or_else(|| v["default_drive_id"].as_str())
        .ok_or("获取 drive_id 失败：响应缺少 drive_id 字段")?
        .to_string();
    let _ = DRIVE_ID.set(id.clone());
    Ok(id)
}

/// 云盘文件条目（列表/搜索统一输出结构）
#[derive(Debug, serde::Serialize)]
pub struct AdFile {
    pub file_id: String,
    pub name: String,
    /// 字节数（文件夹为 0）
    pub size: u64,
    /// file / folder
    pub kind: String,
    pub ext: String,
    pub updated_at: String,
}

fn parse_items(v: &serde_json::Value) -> Vec<AdFile> {
    v["items"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|it| {
                    let kind = it["type"].as_str().unwrap_or("file").to_string();
                    let name = it["name"].as_str()?.to_string();
                    let ext = it["file_extension"]
                        .as_str()
                        .unwrap_or("")
                        .to_ascii_lowercase();
                    Some(AdFile {
                        file_id: it["file_id"].as_str()?.to_string(),
                        size: it["size"].as_u64().unwrap_or(0),
                        kind,
                        ext,
                        updated_at: it["updated_at"].as_str().unwrap_or("").to_string(),
                        name,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// 绑定：验证用户粘贴的 refresh_token（刷新一次 + 取 drive 信息），成功则落盘。
/// refresh_token 获取方式：打开 AList/OpenList 社区授权页，用阿里云盘 App 扫码。
#[tauri::command]
pub async fn ad_auth_bind(app: AppHandle, refresh_token: String) -> Result<serde_json::Value, String> {
    let rt = refresh_token.trim().to_string();
    if rt.len() < 16 {
        return Err("refresh_token 格式异常，请确认已完整粘贴".to_string());
    }
    let app2 = app.clone();
    let rt2 = rt.clone();
    let info = tauri::async_runtime::spawn_blocking(move || -> Result<serde_json::Value, String> {
        // 刷新一次：验证有效性并拿到首个 access_token（滚动产生新 refresh_token）
        let st = do_refresh(&rt2)?;
        save_tokens(&app2, &st)?;
        let v: serde_json::Value = http_agent()
            .post(&format!("{API_BASE}/adrive/v1.0/user/getDriveInfo"))
            .set("Authorization", &format!("Bearer {}", st.access_token))
            .send_json(serde_json::json!({}))
            .map_err(|e| match e {
                ureq::Error::Status(code, r) => {
                    let body = r.into_string().unwrap_or_default();
                    format!("验证失败（HTTP {code}）：{}", &body[..body.len().min(200)])
                }
                other => format!("验证网络错误：{other}"),
            })?
            .into_json()
            .map_err(|e| format!("解析账号信息失败：{e}"))?;
        let _ = DRIVE_ID.set(
            v["resource_drive_id"]
                .as_str()
                .or_else(|| v["default_drive_id"].as_str())
                .unwrap_or("")
                .to_string(),
        );
        Ok(serde_json::json!({
            "nickname": v["user_name"].as_str().or_else(|| v["nickname"].as_str()).unwrap_or(""),
            "drive_id": DRIVE_ID.get().cloned().unwrap_or_default(),
        }))
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(info)
}

/// 授权状态：是否已绑定 + 账号昵称（不发起网络请求，仅读本地）
#[tauri::command]
pub fn ad_auth_status(app: AppHandle) -> Result<serde_json::Value, String> {
    match load_tokens(&app) {
        Some(st) => Ok(serde_json::json!({
            "bound": true,
            "expires_in": st.expires_at.saturating_sub(now_secs()),
        })),
        None => Ok(serde_json::json!({ "bound": false })),
    }
}

/// 解绑：删除本地凭证
#[tauri::command]
pub fn ad_unbind(app: AppHandle) -> Result<(), String> {
    let p = token_path(&app)?;
    if p.exists() {
        std::fs::remove_file(&p).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 列出云盘目录（默认根目录）。folder_id 传 "root" 或具体 file_id。
#[tauri::command]
pub async fn ad_list(app: AppHandle, folder_id: Option<String>) -> Result<Vec<AdFile>, String> {
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<AdFile>, String> {
        let drive = drive_id(&app2)?;
        let parent = folder_id.unwrap_or_else(|| "root".to_string());
        let mut marker = String::new();
        let mut out: Vec<AdFile> = Vec::new();
        // 分页拉全（limit 上限 100/页）
        loop {
            let v = api_call(
                &app2,
                "/adrive/v1.0/openFile/list",
                serde_json::json!({
                    "drive_id": drive,
                    "parent_file_id": parent,
                    "limit": 100,
                    "order_by": "name",
                    "order_direction": "ASC",
                    "marker": marker,
                }),
            )?;
            out.extend(parse_items(&v));
            marker = v["next_marker"].as_str().unwrap_or("").to_string();
            if marker.is_empty() {
                break;
            }
        }
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 搜索云盘文件（官方 search 接口，name match 语法；失败返回空列表由前端降级）
#[tauri::command]
pub async fn ad_search(app: AppHandle, keyword: String) -> Result<Vec<AdFile>, String> {
    let kw = keyword.trim().to_string();
    if kw.is_empty() {
        return Ok(Vec::new());
    }
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<AdFile>, String> {
        let drive = drive_id(&app2)?;
        // query 语法：name match "kw"（转义引号防注入）
        let escaped = kw.replace('"', "\\\"");
        let v = api_call(
            &app2,
            "/adrive/v1.0/openFile/search",
            serde_json::json!({
                "drive_id": drive,
                "query": format!("name match \"{escaped}\""),
                "limit": 100,
            }),
        )?;
        Ok(parse_items(&v))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 获取播放直链（内部使用：给 adstream 协议转发用）。
fn get_download_url_blocking(app: &AppHandle, file_id: &str) -> Result<String, String> {
    let drive = drive_id(app)?;
    // 实测端点为驼峰 getDownloadUrl（下划线 get_download_url 返回 404）
    let v = api_call(
        app,
        "/adrive/v1.0/openFile/getDownloadUrl",
        serde_json::json!({
            "drive_id": drive,
            "file_id": file_id,
        }),
    )?;
    v["url"]
        .as_str()
        .map(|s| s.to_string())
        .ok_or_else(|| "获取播放直链失败：响应缺少 url".to_string())
}

/// 播放地址：本地流式服务的 URL（127.0.0.1 回环，直链与 token 不暴露给前端）。
/// ext：可选扩展名（mp3/flac/...），用于服务端返回精确的 audio MIME。
#[tauri::command]
pub async fn ad_play_url(
    app: AppHandle,
    file_id: String,
    ext: Option<String>,
) -> Result<String, String> {
    if file_id.is_empty() || file_id.contains('/') || file_id.contains('\\') {
        return Err("非法 file_id".to_string());
    }
    let app2 = app.clone();
    let port = tauri::async_runtime::spawn_blocking(move || ensure_stream_server(app2))
        .await
        .map_err(|e| e.to_string())??;
    // 后台预热直链缓存：用户点播放到音频发起请求之间有数百毫秒空隙，
    // 提前把直链拉好，流式服务命中缓存即可立刻回首块
    let app3 = app.clone();
    let fid2 = file_id.clone();
    tauri::async_runtime::spawn(async move {
        let _ = tauri::async_runtime::spawn_blocking(move || {
            let _ = cached_url(&app3, &fid2, false);
        })
        .await;
    });
    // 扩展名拼进路径段（仅允许字母数字 ≤5 位，供 MIME 推断；file_id 本体不含点）
    let ext_part = match ext.as_deref() {
        Some(e)
            if !e.is_empty()
                && e.len() <= 5
                && e.chars().all(|c| c.is_ascii_alphanumeric()) =>
        {
            format!(".{e}")
        }
        _ => String::new(),
    };
    Ok(format!("http://127.0.0.1:{port}/audio/{file_id}{ext_part}"))
}

// ── 本地流式音频服务 ─────────────────────────────────────────────
// 为什么不用 Tauri 自定义协议：UriSchemeResponder 只接受 Into<Cow<'static,[u8]>>，
// wry(Win) 用 SHCreateMemStream 物化整个 body → 不支持流式，只能整文件下载完再回
// （首播延迟 = 全文件下载时长，且占内存；同步回调还会卡 WebView2 UI 线程）。
// 方案：仅绑定 127.0.0.1 的迷你 HTTP 服务，<audio> 直连；收到 Range 请求后从云盘直链
// 64KB 分块拉流转发 —— 真流式、首字节快、seek 由 Range 直通。
// 安全：仅回环地址、file_id 严格校验、单连接 200MB 上限。

static STREAM_APP: OnceLock<AppHandle> = OnceLock::new();
static STREAM_PORT: OnceLock<u16> = OnceLock::new();
static STREAM_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
/// 并发连接上限：音频场景媒体栈通常 1~2 连接，限 4 防异常请求耗尽线程。
/// 超出的连接在 acquire 处排队等待（而非拒绝），空闲即放行。
/// std 无 Semaphore：Mutex 计数 + Condvar 实现轻量计数信号量。
static STREAM_SEM: OnceLock<StreamSem> = OnceLock::new();

struct StreamSem {
    count: Mutex<usize>,
    cv: std::sync::Condvar,
}

impl StreamSem {
    fn new(max: usize) -> Self {
        Self {
            count: Mutex::new(max),
            cv: std::sync::Condvar::new(),
        }
    }
    /// 获取许可（带超时）；超时返回 false
    fn acquire_timeout(&self, timeout: Duration) -> bool {
        let deadline = std::time::Instant::now() + timeout;
        // 中毒锁兜底：直接取内部值继续（单进程内 Mutex 中毒只可能来自 panic，计数仍可用）
        let mut left = match self.count.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        while *left == 0 {
            let now = std::time::Instant::now();
            if now >= deadline {
                return false;
            }
            let res = match self.cv.wait_timeout(left, deadline - now) {
                Ok((_, r)) => r,
                Err(_) => {
                    // 中毒锁：重取计数继续（wait_timeout 出错时守卫已还原）
                    left = match self.count.lock() {
                        Ok(g) => g,
                        Err(p) => p.into_inner(),
                    };
                    continue;
                }
            };
            left = match self.count.lock() {
                Ok(g) => g,
                Err(p) => p.into_inner(),
            };
            if res.timed_out() && *left == 0 {
                return false;
            }
        }
        *left -= 1;
        true
    }
}

fn stream_sem() -> &'static StreamSem {
    STREAM_SEM.get_or_init(|| StreamSem::new(4))
}

// ── 上游预读缓冲 ─────────────────────────────────────────────
// OSS 上游强制 Connection: close（每请求新建 TLS + 慢启动，实测 1MB/1.9s），
// 媒体栈频繁的小 Range 请求若逐个打到上游，衔接处缓冲易饿 → 播放断续。
// 对策：单文件预读窗口（4MB）——请求落在窗口内直接回，未命中才打上游并顺带
// 预读余量。内存代价 ≤4MB/文件，切歌清理。
struct Prefetch {
    /// 窗口起始偏移
    start: u64,
    data: Vec<u8>,
    /// 文件真实总大小（取自上游 Content-Range 尾段）。
    /// 命中路径回 Content-Range 必须用它，不能用窗口末尾冒充文件大小，
    /// 否则媒体栈把 duration 限制在窗口内、4MB 之外拖不动进度。
    total: u64,
}

static PREFETCH: OnceLock<Mutex<Option<(String, Prefetch)>>> = OnceLock::new();

fn prefetch_slot() -> &'static Mutex<Option<(String, Prefetch)>> {
    PREFETCH.get_or_init(|| Mutex::new(None))
}

/// 预读窗口大小：flac 码率 ~1Mbps 下 4MB ≈ 32 秒音频，足够吸收上游连接建立抖动
const PREFETCH_WINDOW: u64 = 4 * 1024 * 1024;

fn stream_lock() -> &'static Mutex<()> {
    STREAM_LOCK.get_or_init(|| Mutex::new(()))
}

/// 启动本地流式服务（幂等），返回端口
fn ensure_stream_server(app: AppHandle) -> Result<u16, String> {
    use std::net::TcpListener;
    if let Some(p) = STREAM_PORT.get() {
        return Ok(*p);
    }
    let _g = stream_lock().lock().map_err(|_| "流服务锁异常")?;
    if let Some(p) = STREAM_PORT.get() {
        return Ok(*p);
    }
    let _ = STREAM_APP.set(app.clone());
    let listener =
        TcpListener::bind(("127.0.0.1", 0)).map_err(|e| format!("绑定流服务端口失败：{e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    std::thread::spawn(move || {
        for conn in listener.incoming() {
            match conn {
                Ok(s) => {
                    // 每连接一线程（音频播放并发低：媒体栈通常 1~2 连接）
                    std::thread::spawn(move || handle_stream_conn(s));
                }
                Err(_) => continue,
            }
        }
    });
    STREAM_PORT.set(port).ok();
    Ok(port)
}

/// 处理一条流式连接：解析 GET /audio/<file_id> + Range 头 → 拉流转发
fn handle_stream_conn(mut stream: std::net::TcpStream) {
    use std::io::Read;
    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));

    // 读请求头（\r\n\r\n 截止，8KB 上限防超长头）
    let mut head_buf: Vec<u8> = Vec::with_capacity(1024);
    let mut tmp = [0u8; 1024];
    loop {
        match stream.read(&mut tmp) {
            Ok(0) => break,
            Ok(n) => {
                head_buf.extend_from_slice(&tmp[..n]);
                if head_buf.windows(4).any(|w| w == b"\r\n\r\n") {
                    break;
                }
            }
            Err(_) => return,
        }
        if head_buf.len() > 8192 {
            return;
        }
    }
    let head = String::from_utf8_lossy(&head_buf);
    let mut lines = head.lines();
    let request_line = lines.next().unwrap_or("");
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("");
    let target = parts.next().unwrap_or("");
    if method != "GET" {
        let _ = write_simple(&mut stream, 405, "method not allowed");
        return;
    }
    let path = target.split(['?', '#']).next().unwrap_or("");
    let segment = path
        .trim_start_matches('/')
        .trim_start_matches("audio/")
        .split('/')
        .next()
        .unwrap_or("")
        .to_string();
    // 段内可能带扩展名（<file_id>.<ext>）：拆出纯 file_id 与 ext（供 MIME 推断）
    let (file_id, ext) = match segment.rsplit_once('.') {
        Some((id, e))
            if !id.is_empty()
                && !e.is_empty()
                && e.len() <= 5
                && e.chars().all(|c| c.is_ascii_alphanumeric()) =>
        {
            (id.to_string(), e.to_ascii_lowercase())
        }
        _ => (segment.clone(), String::new()),
    };
    if file_id.is_empty() || file_id.contains("..") || file_id.len() > 128 {
        let _ = write_simple(&mut stream, 400, "bad file_id");
        return;
    }
    let range = head
        .lines()
        .find(|l| l.to_ascii_lowercase().starts_with("range:"))
        .and_then(|l| l.split_once(':'))
        .map(|(_, v)| v.trim().to_string())
        .unwrap_or_default();

    let app = match STREAM_APP.get() {
        Some(a) => a.clone(),
        None => return,
    };
    // 并发保护：超过 4 个并发连接时排队等待（带 30s 超时防死等）
    let permit = stream_sem().acquire_timeout(Duration::from_secs(30));
    if !permit {
        let _ = write_simple(&mut stream, 503, "stream busy, try again");
        return;
    }
    // RAII 守卫：serve_audio 返回（含出错/提前断连）时自动释放许可并唤醒排队连接
    struct SemGuard<'a>(&'a StreamSem);
    impl Drop for SemGuard<'_> {
        fn drop(&mut self) {
            if let Ok(mut left) = self.0.count.lock() {
                *left += 1;
            }
            self.0.cv.notify_one();
        }
    }
    let _guard = SemGuard(stream_sem());
    let result = serve_audio(&app, &file_id, &ext, &range, &mut stream);
    if let Err(e) = result {
        // 头已发出则只能断连；未发出时尽力回一个错误响应
        let _ = write_simple(&mut stream, 502, &format!("adstream error: {e}"));
    }
}

/// 拉流转发主体：取直链（失效重签一次）→ 写响应头 → 64KB 分块拷贝
fn serve_audio(
    app: &AppHandle,
    file_id: &str,
    ext: &str,
    range: &str,
    stream: &mut std::net::TcpStream,
) -> Result<(), String> {
    use std::io::{Read, Write};
    let fetch = |url: &str, range: &str| -> Result<ureq::Response, String> {
        let mut req = http_agent().get(url).set("User-Agent", "Mozilla/5.0");
        if !range.is_empty() {
            req = req.set("Range", range);
        }
        req.call().map_err(|e| match e {
            ureq::Error::Status(code, r) => {
                let body = r.into_string().unwrap_or_default();
                format!("__HTTP_{code}__{}", &body[..body.len().min(120)])
            }
            other => format!("__NET__{other}"),
        })
    };

    // 解析请求 Range：bytes=<start>-<end|空>（空 end = 到文件尾）
    let (req_start, req_end_open) = parse_range_start(range);
    // 预读窗口命中：请求完全落在已缓冲数据内 → 零上游请求直接回
    let served_from_cache: Option<(u64, Vec<u8>, u64)> = (|| {
        let guard = prefetch_slot().lock().ok()?;
        let (cached_id, pf) = guard.as_ref()?;
        if cached_id != file_id {
            return None;
        }
        let start = req_start?;
        if start < pf.start || start >= pf.start + pf.data.len() as u64 {
            return None;
        }
        let off = (start - pf.start) as usize;
        let take = match req_end_open {
            None => pf.data.len() - off,
            Some(end) => ((end - start + 1) as usize).min(pf.data.len() - off),
        };
        Some((start, pf.data[off..off + take].to_vec(), pf.total))
    })();

    if let Some((start, chunk, total)) = served_from_cache {
        let cr = format!("bytes {start}-{} / {total}", start + chunk.len() as u64 - 1);
        write_audio_head(stream, 206, ext, &cr, chunk.len() as u64)?;
        stream.write_all(&chunk).map_err(|e| format!("转发音频流失败：{e}"))?;
        return Ok(());
    }

    // 未命中：向上游请求大窗口（从请求起点起 PREFETCH_WINDOW 字节），
    // 边读边转发：上游首块到达立即回给媒体栈（不等整窗拉满——OSS ~500KB/s
    // 限速下 4MB 要 ~8s，整窗读完再回是起播/拖动进度卡顿的主因），
    // 转发的同时把字节累积进预读窗口，读满或 EOF 后一次性入缓存。
    let up_start = req_start.unwrap_or(0);
    let up_end = up_start + PREFETCH_WINDOW - 1;
    let mut url = cached_url(app, file_id, false)?;
    let resp = match fetch(&url, &format!("bytes={up_start}-{up_end}")) {
        Ok(r) => r,
        Err(e) if e.starts_with("__HTTP_4") || e.starts_with("__HTTP_5") => {
            // 缓存直链可能已过期 → 强制重签一次再试
            url = cached_url(app, file_id, true)?;
            fetch(&url, &format!("bytes={up_start}-{up_end}"))?
        }
        Err(e) => return Err(e),
    };
    let status = resp.status();
    if status != 200 && status != 206 {
        return Err(format!("上游响应异常：HTTP {status}"));
    }
    let content_range = resp.header("Content-Range").unwrap_or("").to_string();
    // 窗口总大小（Content-Range 尾段）= 文件总大小
    let total: u64 = content_range
        .rsplit('/')
        .next()
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    // 窗口实际可给长度：到文件尾截断；无 Content-Range（200 全量）时
    // 取上游 Content-Length 与窗口上限的较小者
    let window_len: u64 = if content_range.is_empty() {
        resp.header("Content-Length")
            .and_then(|s| s.parse().ok())
            .unwrap_or(PREFETCH_WINDOW)
            .min(PREFETCH_WINDOW)
    } else {
        PREFETCH_WINDOW.min(total.saturating_sub(up_start))
    };
    // 回给媒体栈的长度 = 请求长度与窗口长度的较小值
    let out_len: u64 = match req_end_open {
        None => window_len,
        Some(end) => (end - up_start + 1).min(window_len),
    };
    let cr = if status == 206 {
        format!("bytes {up_start}-{} / {total}", up_start + out_len - 1)
    } else {
        String::new()
    };
    // 头先发（长度已知，无需等数据）：媒体栈立刻知道本次范围
    write_audio_head(stream, status, ext, &cr, out_len)?;

    // 并行分段拉取：实测上游单连接限速 ~100KB/s（TTFB ~2.8s），低于 flac
    // 播放码率（~125KB/s），单连接顺序拉必然断续；限速按连接计，多连接可叠加
    // （实测双连接 ~197KB/s 近似线性）。将窗口均分 4 段并行 Range 拉取，
    // 按序转发给媒体栈 + 逐块入预读缓存（滑动窗口语义不变）。
    const STREAM_PAR: usize = 4;
    let seg_len = PREFETCH_WINDOW / STREAM_PAR as u64;
    let n_segs = if window_len == 0 { 0 } else { ((window_len + seg_len - 1) / seg_len) as usize };
    let slots: std::sync::Arc<std::sync::Mutex<Vec<Option<Vec<u8>>>>> =
        std::sync::Arc::new(std::sync::Mutex::new(vec![None; n_segs]));
    let cv = std::sync::Arc::new(std::sync::Condvar::new());
    let agent = http_agent();
    for i in 0..n_segs {
        let seg_start = up_start + i as u64 * seg_len;
        let seg_end = seg_start + seg_len - 1;
        let url2 = url.clone();
        let slots2 = slots.clone();
        let cv2 = cv.clone();
        std::thread::spawn(move || {
            let res = agent
                .get(&url2)
                .set("User-Agent", "Mozilla/5.0")
                .set("Range", &format!("bytes={seg_start}-{seg_end}"))
                .call();
            let data = match res {
                Ok(r) if r.status() == 200 || r.status() == 206 => {
                    let mut d = Vec::new();
                    let _ = r.into_reader().take(seg_len + 1024 * 1024).read_to_end(&mut d);
                    d
                }
                _ => {
                    eprintln!("[ad-stream] 分段拉取失败 seg={i}");
                    Vec::new()
                }
            };
            if let Ok(mut g) = slots2.lock() {
                g[i] = Some(data);
            }
            cv2.notify_all();
        });
    }

    // 按序消费各段：转发请求所需部分 + 逐块入预读缓存。
    // 写客户端失败 = 客户端已断开（seek/切歌），停止消费避免白耗上游带宽。
    let mut sent = 0u64;
    let mut read_pos = 0u64; // 相对 up_start 的已消费偏移
    'outer: for i in 0..n_segs {
        // 等待段 i 就绪（并行拉取中，早于序号的段可能已就绪）
        let data = {
            let mut g = slots.lock().map_err(|_| "段缓冲锁异常".to_string())?;
            while g[i].is_none() {
                let (g2, _) = cv
                    .wait_timeout(g, Duration::from_millis(500))
                    .map_err(|_| "段等待异常".to_string())?;
                g = g2;
            }
            g[i].take().unwrap_or_default()
        };
        if data.is_empty() {
            break 'outer; // 段失败：响应无法补齐，断连由媒体栈重试兜底
        }
        let mut off = 0usize;
        while off < data.len() {
            let n = (data.len() - off).min(64 * 1024);
            let chunk = &data[off..off + n];
            if sent < out_len {
                let take = ((out_len - sent) as usize).min(chunk.len());
                if stream.write_all(chunk).is_err() {
                    break 'outer;
                }
                sent += take as u64;
                if sent == out_len {
                    // 请求部分回完：半关闭写端，媒体栈即刻完成本响应，
                    // 本连接继续按序消费剩余段做预读
                    let _ = stream.shutdown(std::net::Shutdown::Write);
                }
            }
            // 逐块入缓存：接管（无缓存/切歌/窗口滑动）或续写（缓存进度恰好衔接）
            if let Ok(mut guard) = prefetch_slot().lock() {
                let takeover = match guard.as_ref() {
                    None => true,
                    Some((id, pf)) => *id != file_id || pf.start != up_start,
                };
                if takeover {
                    *guard = Some((
                        file_id.to_string(),
                        Prefetch {
                            start: up_start,
                            data: chunk.to_vec(),
                            total,
                        },
                    ));
                } else if let Some((_, pf)) = guard.as_mut() {
                    if pf.data.len() as u64 == read_pos {
                        pf.data.extend_from_slice(chunk);
                    }
                }
            }
            read_pos += n as u64;
            off += n;
        }
    }
    if read_pos == 0 {
        return Err("上游返回空数据".to_string());
    }
    Ok(())
}

/// 解析 Range 头起点与终点（None start = 无 Range；end None = 开放区间）
fn parse_range_start(range: &str) -> (Option<u64>, Option<u64>) {
    let s = range.trim();
    let spec = s.strip_prefix("bytes=").unwrap_or("");
    let mut it = spec.split('-');
    let a = it.next().and_then(|x| x.trim().parse::<u64>().ok());
    let b = it.next().and_then(|x| x.trim().parse::<u64>().ok());
    match a {
        Some(start) => (Some(start), b),
        None => (None, None),
    }
}

/// 写音频响应头（统一 MIME/Range 头）
fn write_audio_head(
    stream: &mut std::net::TcpStream,
    status: u16,
    ext: &str,
    content_range: &str,
    len: u64,
) -> Result<(), String> {
    use std::io::Write;
    let mime = if ext.is_empty() {
        "audio/mpeg".to_string()
    } else {
        guess_mime(&format!("x.{ext}"))
    };
    let mut head = format!(
        "HTTP/1.1 {status} {}\r\n",
        if status == 206 { "Partial Content" } else { "OK" }
    );
    head.push_str(&format!("Content-Type: {mime}\r\n"));
    head.push_str("Accept-Ranges: bytes\r\n");
    if status == 206 && !content_range.is_empty() {
        head.push_str(&format!("Content-Range: {content_range}\r\n"));
    }
    head.push_str(&format!("Content-Length: {len}\r\n"));
    head.push_str("Connection: close\r\n\r\n");
    stream
        .write_all(head.as_bytes())
        .map_err(|e| format!("写响应头失败：{e}"))
}

/// 极简错误响应（头可能已发出的场景由调用方忽略失败）
fn write_simple(stream: &mut std::net::TcpStream, status: u16, msg: &str) -> std::io::Result<()> {
    use std::io::Write;    let reason = match status {
        400 => "Bad Request",
        405 => "Method Not Allowed",
        502 => "Bad Gateway",
        _ => "Error",
    };
    let body = msg.as_bytes();
    let head = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(head.as_bytes())?;
    stream.write_all(body)
}

/// 按扩展名推断标准音频 MIME（WebView2 媒体栈只认标准类型）
fn guess_mime(name: &str) -> String {
    let ext = name.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "mp3" | "mpga" => "audio/mpeg",
        "flac" => "audio/flac",
        "m4a" | "mp4a" => "audio/mp4",
        "wav" => "audio/wav",
        "ogg" | "oga" => "audio/ogg",
        "aac" => "audio/aac",
        "wma" => "audio/x-ms-wma",
        "ape" => "audio/x-ape",
        _ => "audio/mpeg",
    }
    .to_string()
}

// ── P2：本地歌曲上传云盘 ─────────────────────────────────────────
// 流程：SHA1 → create（content_hash 命中即秒传 rapid_upload）→ 分片 PUT → complete
// 任务模式与 downloader 一致：spawn_blocking + cancel 标志 + 快照查询。

struct UploadTask {
    cancel: Arc<AtomicBool>,
    name: String,
    /// hashing | uploading | done | failed | cancelled
    status: String,
    sent: u64,
    total: u64,
    note: Option<String>,
    error: Option<String>,
}

static UPLOADS: OnceLock<Mutex<HashMap<u64, UploadTask>>> = OnceLock::new();
static UPLOAD_NEXT_ID: AtomicU64 = AtomicU64::new(1);
/// 分片大小（官方约束 ≤1 万片，10MB 对音乐文件足够）
const UPLOAD_PART_SIZE: u64 = 10 * 1024 * 1024;

fn uploads() -> &'static Mutex<HashMap<u64, UploadTask>> {
    UPLOADS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 上传任务字段批量更新（None = 不变）
#[allow(clippy::too_many_arguments)]
fn upload_update(
    id: u64,
    status: Option<&str>,
    sent: Option<u64>,
    total: Option<u64>,
    error: Option<String>,
    note: Option<String>,
) {
    if let Ok(mut m) = uploads().lock() {
        if let Some(t) = m.get_mut(&id) {
            if let Some(s) = status {
                t.status = s.to_string();
            }
            if let Some(v) = sent {
                t.sent = v;
            }
            if let Some(v) = total {
                t.total = v;
            }
            if error.is_some() {
                t.error = error;
            }
            if note.is_some() {
                t.note = note;
            }
        }
    }
}

/// 确保云盘存在 /音乐 文件夹并返回 file_id（有则复用，无则创建）
fn ensure_music_folder(app: &AppHandle) -> Result<String, String> {
    let drive = drive_id(app)?;
    let v = api_call(
        app,
        "/adrive/v1.0/openFile/list",
        serde_json::json!({
            "drive_id": drive, "parent_file_id": "root", "limit": 100,
        }),
    )?;
    for it in v["items"].as_array().map(|a| a.as_slice()).unwrap_or(&[]) {
        if it["type"] == "folder" && it["name"] == "音乐" {
            if let Some(id) = it["file_id"].as_str() {
                return Ok(id.to_string());
            }
        }
    }
    let created = api_call(
        app,
        "/adrive/v1.0/openFile/create",
        serde_json::json!({
            "drive_id": drive, "parent_file_id": "root", "name": "音乐",
            "type": "folder", "check_name_mode": "refuse",
        }),
    )?;
    created["file_id"]
        .as_str()
        .map(|s| s.to_string())
        .ok_or_else(|| "创建 /音乐 文件夹失败：响应缺少 file_id".to_string())
}

/// 上传执行主体（阻塞线程）：SHA1 → create（秒传探测）→ 分片 PUT → complete
fn run_upload(app: AppHandle, id: u64, path: PathBuf, name: String, cancel: Arc<AtomicBool>) {
    let drive_of = |app: &AppHandle| drive_id(app);
    let result = (|| -> Result<(), String> {
        let total = std::fs::metadata(&path)
            .map_err(|e| format!("读取本地文件失败：{e}"))?
            .len();
        upload_update(id, Some("hashing"), None, Some(total), None, None);

        // 1) 流式计算 SHA1（秒传哈希）
        let mut file = std::fs::File::open(&path).map_err(|e| format!("打开本地文件失败：{e}"))?;
        let mut hasher = sha1_smol::Sha1::new();
        let mut buf = [0u8; 262144];
        loop {
            if cancel.load(Ordering::Relaxed) {
                return Err("已取消".to_string());
            }
            let n = file.read(&mut buf).map_err(|e| format!("读取失败：{e}"))?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
        }
        let hash = hasher
            .digest()
            .bytes()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();

        // 2) 目标文件夹 + create（content_hash 命中即秒传）
        let folder = ensure_music_folder(&app)?;
        let part_count = total.div_ceil(UPLOAD_PART_SIZE).max(1);
        let part_numbers: Vec<serde_json::Value> = (1..=part_count)
            .map(|i| serde_json::json!({ "part_number": i }))
            .collect();
        let v = api_call(
            &app,
            "/adrive/v1.0/openFile/create",
            serde_json::json!({
                "drive_id": drive_of(&app)?,
                "parent_file_id": folder,
                "name": name,
                "type": "file",
                "check_name_mode": "ignore",
                "size": total,
                "content_hash_name": "sha1",
                "content_hash": hash,
                "part_info_list": part_numbers,
            }),
        )?;
        if v["rapid_upload"] == serde_json::json!(true) {
            upload_update(
                id,
                Some("done"),
                Some(total),
                None,
                None,
                Some("秒传完成（云端已存在相同内容）".to_string()),
            );
            return Ok(());
        }
        let file_id = v["file_id"]
            .as_str()
            .ok_or_else(|| "create 响应缺少 file_id".to_string())?
            .to_string();
        let upload_id = v["upload_id"].as_str().unwrap_or("").to_string();
        let parts = v["part_info_list"]
            .as_array()
            .ok_or_else(|| "create 响应缺少 part_info_list".to_string())?
            .clone();

        // 3) 逐片 PUT（按 part_number 顺序；每片独立签发的 OSS 地址）
        let agent = http_agent();
        let mut sent: u64 = 0;
        for (idx, p) in parts.iter().enumerate() {
            if cancel.load(Ordering::Relaxed) {
                return Err("已取消".to_string());
            }
            let upload_url = p["upload_url"]
                .as_str()
                .ok_or_else(|| format!("分片 {idx} 缺少 upload_url"))?;
            let offset = idx as u64 * UPLOAD_PART_SIZE;
            let chunk_len = std::cmp::min(UPLOAD_PART_SIZE, total.saturating_sub(offset)) as usize;
            file.seek(std::io::SeekFrom::Start(offset))
                .map_err(|e| format!("定位分片失败：{e}"))?;
            let mut chunk = vec![0u8; chunk_len];
            file.read_exact(&mut chunk)
                .map_err(|e| format!("读取分片失败：{e}"))?;
            let pr = agent
                .put(upload_url)
                .set("User-Agent", "Mozilla/5.0")
                .send_bytes(&chunk)
                .map_err(|e| format!("分片 {idx} 上传失败：{e}"))?;
            drop(pr);
            sent += chunk_len as u64;
            upload_update(id, Some("uploading"), Some(sent), None, None, None);
        }

        // 4) complete
        api_call(
            &app,
            "/adrive/v1.0/openFile/complete",
            serde_json::json!({
                "drive_id": drive_of(&app)?,
                "file_id": file_id,
                "upload_id": upload_id,
            }),
        )?;
        upload_update(id, Some("done"), Some(total), None, None, None);
        Ok(())
    })();

    match result {
        Ok(()) => upload_update(id, Some("done"), None, None, None, None),
        Err(e) => {
            let (status, err) = if e == "已取消" {
                ("cancelled", None)
            } else {
                ("failed", Some(e))
            };
            upload_update(id, Some(status), None, None, err, None);
        }
    }
}

/// 开始上传：filename 必须是本地已下载目录（app_data/music/）内的文件。
#[tauri::command]
pub async fn ad_upload_start(app: AppHandle, filename: String) -> Result<u64, String> {
    let dir = crate::downloader::music_dir_path(&app)?;
    if filename.is_empty() || filename.contains('/') || filename.contains('\\') || filename.contains("..") {
        return Err("非法文件名".to_string());
    }
    let path = dir.join(&filename);
    if !path.is_file() {
        return Err("本地文件不存在".to_string());
    }
    let id = UPLOAD_NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let cancel = Arc::new(AtomicBool::new(false));
    uploads()
        .lock()
        .map_err(|e| e.to_string())?
        .insert(
            id,
            UploadTask {
                cancel: cancel.clone(),
                name: filename,
                status: "hashing".to_string(),
                sent: 0,
                total: 0,
                note: None,
                error: None,
            },
        );
    let name = name_of(&path);
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        run_upload(app2, id, path, name, cancel)
    });
    Ok(id)
}

fn name_of(path: &std::path::Path) -> String {
    path.file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default()
}

/// 取消上传任务
#[tauri::command]
pub fn ad_upload_cancel(id: u64) -> Result<(), String> {
    if let Ok(m) = uploads().lock() {
        if let Some(t) = m.get(&id) {
            t.cancel.store(true, Ordering::Relaxed);
        }
    }
    Ok(())
}

/// 上传任务快照（前端 500ms 轮询渲染）
#[tauri::command]
pub fn ad_upload_list() -> Result<Vec<serde_json::Value>, String> {
    let m = uploads().lock().map_err(|e| e.to_string())?;
    let mut out: Vec<serde_json::Value> = m
        .iter()
        .map(|(id, t)| {
            serde_json::json!({
                "id": id,
                "name": t.name,
                "status": t.status,
                "sent": t.sent,
                "total": t.total,
                "note": t.note,
                "error": t.error,
            })
        })
        .collect();
    out.sort_by_key(|v| -(v["id"].as_u64().unwrap_or(0) as i64));
    Ok(out)
}

// ── 音频内嵌元数据（歌词 + 封面） ─────────────────────────────
// 云盘歌曲无插件元数据来源：从音频文件自身提取（ID3(mp3)/Vorbis(flac) 内嵌的
// 歌词与封面）。云端文件需先经流式服务拉取本地片段？——不，内嵌元数据可能在
// 文件任意位置（ID3v2 在头部，APE 标签在尾部），直接对云盘文件做两次 Range
// 拉取（头 512KB + 尾 512KB）解析，避免整文件下载。

/// 从云盘音频提取内嵌歌词与封面（base64 data URL）。
/// 实现：经流式服务语义直接对上游直链做头/尾 Range 拉取 → lofty 解析。
#[tauri::command]
pub async fn ad_track_meta(app: AppHandle, file_id: String, ext: String) -> Result<serde_json::Value, String> {
    if file_id.is_empty() || file_id.contains('/') || file_id.contains('\\') {
        return Err("非法 file_id".to_string());
    }
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<serde_json::Value, String> {
        use lofty::prelude::*;
        use lofty::probe::Probe;

        // 取直链（缓存命中则零 API 开销）
        let url = cached_url(&app2, &file_id, false)?;
        let agent = http_agent();
        let fetch_range = |range: &str| -> Result<Vec<u8>, String> {
            let resp = agent
                .get(&url)
                .set("User-Agent", "Mozilla/5.0")
                .set("Range", range)
                .call()
                .map_err(|e| format!("拉取元数据失败：{e}"))?;
            let mut buf = Vec::new();
            resp.into_reader().take(1024 * 1024).read_to_end(&mut buf)
                .map_err(|e| format!("读取元数据失败：{e}"))?;
            Ok(buf)
        };

        // 直接拉头 512KB（flac METADATA BLOCK / ID3v2 都在文件头部，无需知道总大小）。
        // 失败路径全部带 debug 字段返回，便于前端定位。
        let head = fetch_range("bytes=0-524287")?;
        if head.is_empty() {
            return Ok(serde_json::json!({ "lyric": null, "cover": null, "debug": "empty head" }));
        }
        let mut combined = head;
        // 补拉尾部 512KB：APE 标签位于文件尾（mp3/ape 常见），m4a 的 moov 原子也可能在尾。
        // suffix range（bytes=-N）无需知道总大小；拉取失败不影响头部解析。
        if let Ok(tail) = fetch_range("bytes=-524288") {
            if !tail.is_empty() {
                combined.extend_from_slice(&tail);
            }
        }

        // 按扩展名直接指定文件类型（拼接的 head+tail 非完整文件，探测可能失败）
        let ftype = match ext.to_ascii_lowercase().as_str() {
            "mp3" | "mpga" => lofty::file::FileType::Mpeg,
            "flac" => lofty::file::FileType::Flac,
            "m4a" | "mp4a" | "mp4" => lofty::file::FileType::Mp4,
            "wav" => lofty::file::FileType::Wav,
            "ogg" | "oga" => lofty::file::FileType::Vorbis,
            "opus" => lofty::file::FileType::Opus,
            "ape" => lofty::file::FileType::Ape,
            _ => {
                return Ok(serde_json::json!({ "lyric": null, "cover": null, "debug": format!("unsupported ext: {ext}") }));
            }
        };
        let tagged = match Probe::new(std::io::Cursor::new(&combined)).set_file_type(ftype).read() {
            Ok(t) => t,
            Err(e) => {
                return Ok(serde_json::json!({ "lyric": null, "cover": null, "debug": format!("parse: {e}") }));
            }
        };
        let Some(tag) = tagged.primary_tag().or_else(|| tagged.first_tag()) else {
            return Ok(serde_json::json!({ "lyric": null, "cover": null, "debug": "no tag" }));
        };

        // 歌词：LYRICS 类帧（ID3 USLT / Vorbis LYRICS）
        let lyric = tag
            .get_string(&ItemKey::Lyrics)
            .map(|s| s.to_string())
            .filter(|s| !s.trim().is_empty());
        // 封面：第一张 FrontCover → data URL（≤3MB）
        let cover = tag
            .pictures()
            .first()
            .filter(|p| p.data().len() <= 3 * 1024 * 1024 && !p.data().is_empty())
            .map(|p| {
                let mime = p
                    .mime_type()
                    .map(|m| m.to_string())
                    .unwrap_or_else(|| "image/jpeg".to_string());
                let mime = if mime.is_empty() { "image/jpeg" } else { &mime };
                use base64::Engine as _;
                format!(
                    "data:{mime};base64,{}",
                    base64::engine::general_purpose::STANDARD.encode(p.data())
                )
            });
        // 成功解析也带 debug：区分「tag 里确实无歌词/封面」与上游失败路径
        let pic_count = tag.pictures().len();
        Ok(serde_json::json!({
            "lyric": lyric,
            "cover": cover,
            "debug": format!("parsed, lyrics={}, pictures={pic_count}", lyric.is_some())
        }))
    })
    .await
    .map_err(|e| e.to_string())?
}
