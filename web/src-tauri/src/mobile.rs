//! 手机访问(BL-032 第一阶段 M1,`docs/design/2026-10-02-mobile-phase1.md`)。
//!
//! 壳层内置一个 HTTP 服务,让 iPhone 上的 Safari 用同一份前端访问这台 Mac 上的攻书:
//! - `POST /api/<command>`:把请求原样交给主窗口 webview 的 [`tauri::webview::Webview::on_message`]——
//!   与 Tauri IPC **同一条分发路径**(参数反序列化、`run_command` 日志、`IpcError` 映射一字不差),
//!   所以不必逐条命令写调度;只放行 `shared/tauri-wire-contract.json` 里的命令。
//!   JSON 体 = IPC 的平铺参数;`application/octet-stream` 体 = 原始体命令(导入分块、语音),元数据头照传。
//! - `POST /api/pair`:用令牌换一个 HttpOnly cookie(之后 `<img>`、epub.js、EventSource 都自动带上)。
//! - `GET /api/ping`:免认证探活(版本 + 是否已配对)。
//! - `GET /files/<name>`:受管 books 目录下的 EPUB 与封面(支持 Range)。
//! - `GET /events`:SSE,转发 `pomodoro_changed` / `map_job_progress`(经 `listen_any`,发事件处不用改)。
//! - 其余 `GET`:打包进二进制的前端静态文件(`asset_resolver`),无扩展名的路径回落 `index.html`。
//!
//! 默认只绑 127.0.0.1,对外由 Tailscale serve 提供 HTTPS(Safari 只在 HTTPS 下给麦克风)。
//! 开关/端口/绑定/令牌存 `<data_root>/mobile-server.json`(0600),不进 SQLite、不随快照外流。
use std::collections::HashSet;
use std::io::Read;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::body::{Body, Bytes};
use axum::extract::{DefaultBodyLimit, Path as RoutePath, Request, State};
use axum::http::{header, HeaderMap, StatusCode, Uri};
use axum::response::sse::{Event as SseEvent, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::ipc::{CallbackFn, InvokeBody, InvokeResponse, InvokeResponseBody};
use tauri::webview::InvokeRequest;
use tauri::{AppHandle, EventId, Listener, Manager, Runtime};
use tokio::sync::{broadcast, oneshot, watch};
use tower::ServiceExt;

use crate::error::IpcError;

pub const DEFAULT_PORT: u16 = 7340;
pub const CONFIG_FILE: &str = "mobile-server.json";
pub const COOKIE_NAME: &str = "bl_session";
/// 经 SSE 转发给手机的事件(与 Tauri 事件同名,前端订阅代码不用改)
pub const FORWARDED_EVENTS: [&str; 2] = [
    crate::pomodoro::POMODORO_CHANGED_EVENT,
    crate::commands::MAP_JOB_PROGRESS_EVENT,
];
/// 导入分块 4 MB、语音 ≤ 120 s PCM ≈ 3.8 MB;留足余量
const MAX_BODY_BYTES: usize = 64 * 1024 * 1024;
const MAIN_WEBVIEW: &str = "main";
const SSE_KEEPALIVE: Duration = Duration::from_secs(15);

// ---- 配置 ----

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Bind {
    /// 只在本机回环(经 Tailscale serve 对外,默认)
    #[default]
    Loopback,
    /// 局域网所有网卡(无 HTTPS:Safari 不给麦克风)
    Lan,
}

impl Bind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Loopback => "loopback",
            Self::Lan => "lan",
        }
    }

    pub fn parse(value: &str) -> Result<Self, IpcError> {
        match value {
            "loopback" => Ok(Self::Loopback),
            "lan" => Ok(Self::Lan),
            other => Err(IpcError::invalid_request(
                "绑定方式只能是 loopback 或 lan",
                format!("bad bind {other:?}"),
            )),
        }
    }

    fn ip(self) -> IpAddr {
        match self {
            Self::Loopback => IpAddr::V4(Ipv4Addr::LOCALHOST),
            Self::Lan => IpAddr::V4(Ipv4Addr::UNSPECIFIED),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MobileConfig {
    pub enabled: bool,
    pub port: u16,
    pub bind: Bind,
    /// 访问令牌(64 位十六进制);空 = 还没生成
    pub token: String,
}

impl Default for MobileConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            port: DEFAULT_PORT,
            bind: Bind::Loopback,
            token: String::new(),
        }
    }
}

pub fn config_path(data_root: &Path) -> PathBuf {
    data_root.join(CONFIG_FILE)
}

/// 读配置;文件不存在或损坏 → 默认(关闭)
pub fn load_config(data_root: &Path) -> MobileConfig {
    std::fs::read_to_string(config_path(data_root))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

/// 原子写配置(先写临时文件再改名),权限 0600(内含令牌)
pub fn save_config(data_root: &Path, config: &MobileConfig) -> Result<(), IpcError> {
    let path = config_path(data_root);
    let tmp = path.with_extension("json.tmp");
    let text = serde_json::to_string_pretty(config)
        .map_err(|error| IpcError::internal(format!("serialize mobile config: {error}")))?;
    std::fs::write(&tmp, text).map_err(io_error)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600)).map_err(io_error)?;
    }
    std::fs::rename(&tmp, &path).map_err(io_error)
}

fn io_error(error: std::io::Error) -> IpcError {
    IpcError::from(book_learner_core::CoreError::Io(error))
}

/// 32 字节随机令牌(十六进制);随机源 /dev/urandom(macOS/Linux 都有,不引新依赖)
pub fn new_token() -> Result<String, IpcError> {
    let mut bytes = [0u8; 32];
    std::fs::File::open("/dev/urandom")
        .and_then(|mut file| file.read_exact(&mut bytes))
        .map_err(io_error)?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// 常量时间比较(长度不同直接 false)
fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

// ---- HTTP 服务 ----

struct Ctx<R: Runtime> {
    app: AppHandle<R>,
    token: String,
    commands: HashSet<String>,
    books_dir: PathBuf,
    events: broadcast::Sender<(String, String)>,
    shutdown: watch::Receiver<bool>,
}

/// 契约里的命令名(HTTP 只放行这些;调试桥 `automation_report` 等不在其中)
fn contract_commands() -> HashSet<String> {
    let contract: Value =
        serde_json::from_str(include_str!("../../../shared/tauri-wire-contract.json"))
            .expect("shared/tauri-wire-contract.json is valid JSON");
    contract["commands"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|entry| entry["command"].as_str())
        .map(String::from)
        .collect()
}

/// 把 Tauri 事件转进广播通道;drop 时注销监听
pub struct EventForwarder<R: Runtime> {
    app: AppHandle<R>,
    ids: Vec<EventId>,
}

impl<R: Runtime> Drop for EventForwarder<R> {
    fn drop(&mut self) {
        for id in self.ids.drain(..) {
            self.app.unlisten(id);
        }
    }
}

/// 一个可挂到监听器上的服务实例:路由 + 事件转发 + 停机信号
pub struct HttpService<R: Runtime> {
    pub router: Router,
    pub forwarder: EventForwarder<R>,
    /// 置 true:SSE 流结束、优雅停机开始
    pub shutdown: watch::Sender<bool>,
}

pub fn http_service<R: Runtime>(
    app: &AppHandle<R>,
    token: &str,
    books_dir: PathBuf,
) -> HttpService<R> {
    let (events, _) = broadcast::channel(64);
    let mut ids = Vec::new();
    for name in FORWARDED_EVENTS {
        let tx = events.clone();
        ids.push(app.listen_any(name, move |event| {
            let _ = tx.send((name.to_string(), event.payload().to_string()));
        }));
    }
    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let ctx = Arc::new(Ctx {
        app: app.clone(),
        token: token.to_string(),
        commands: contract_commands(),
        books_dir,
        events,
        shutdown: shutdown_rx,
    });
    let router = Router::new()
        .route("/api/ping", get(ping::<R>))
        .route("/api/pair", post(pair::<R>))
        .route("/api/{command}", post(api::<R>))
        .route("/files/{name}", get(files::<R>))
        .route("/events", get(events_stream::<R>))
        .fallback(static_files::<R>)
        .layer(DefaultBodyLimit::max(MAX_BODY_BYTES))
        .with_state(ctx);
    HttpService {
        router,
        forwarder: EventForwarder {
            app: app.clone(),
            ids,
        },
        shutdown: shutdown_tx,
    }
}

fn error_response(status: StatusCode, code: &str, message: &str) -> Response {
    (
        status,
        Json(json!({ "code": code, "message": message, "retryable": false, "details": null })),
    )
        .into_response()
}

fn unauthorized() -> Response {
    error_response(StatusCode::UNAUTHORIZED, "unauthorized", "需要先配对")
}

/// 已停掉(换令牌 / 改端口 / 关闭)的服务实例:keep-alive 长连接上再来的请求一律 503 并要求断开,
/// 旧令牌不会在旧连接上继续有效;客户端重连即到新实例。
fn retired<R: Runtime>(ctx: &Ctx<R>) -> Option<Response> {
    if !*ctx.shutdown.borrow() {
        return None;
    }
    let mut response = error_response(
        StatusCode::SERVICE_UNAVAILABLE,
        "internal",
        "服务已重启,请重试",
    );
    response.headers_mut().insert(
        header::CONNECTION,
        header::HeaderValue::from_static("close"),
    );
    Some(response)
}

/// 请求带的令牌:`Authorization: Bearer …` 或配对 cookie
fn request_token(headers: &HeaderMap) -> Option<String> {
    if let Some(bearer) = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
    {
        return Some(bearer.trim().to_string());
    }
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(';'))
        .find_map(|pair| {
            let (name, value) = pair.trim().split_once('=')?;
            (name == COOKIE_NAME).then(|| value.to_string())
        })
}

fn authorized<R: Runtime>(ctx: &Ctx<R>, headers: &HeaderMap) -> bool {
    !ctx.token.is_empty()
        && request_token(headers).is_some_and(|token| ct_eq(token.as_bytes(), ctx.token.as_bytes()))
}

async fn ping<R: Runtime>(State(ctx): State<Arc<Ctx<R>>>, headers: HeaderMap) -> Response {
    if let Some(response) = retired(&ctx) {
        return response;
    }
    Json(json!({
        "app": "book-learner",
        "version": env!("CARGO_PKG_VERSION"),
        "gitSha": crate::diagnostics::GIT_SHA,
        "paired": authorized(&ctx, &headers),
    }))
    .into_response()
}

#[derive(Deserialize)]
struct PairBody {
    token: String,
}

async fn pair<R: Runtime>(State(ctx): State<Arc<Ctx<R>>>, body: Bytes) -> Response {
    if let Some(response) = retired(&ctx) {
        return response;
    }
    let token = serde_json::from_slice::<PairBody>(&body)
        .map(|b| b.token.trim().to_string())
        .unwrap_or_default();
    if ctx.token.is_empty() || !ct_eq(token.as_bytes(), ctx.token.as_bytes()) {
        tracing::warn!(via = "http", "手机配对失败(令牌不符)");
        return unauthorized();
    }
    tracing::info!(via = "http", "手机配对成功");
    let cookie = format!(
        "{COOKIE_NAME}={}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000",
        ctx.token
    );
    (StatusCode::NO_CONTENT, [(header::SET_COOKIE, cookie)]).into_response()
}

/// 命令错误 → HTTP 状态(体是与 IPC 拒绝相同的 JSON,前端 `normalizeInvokeError` 原样可用)
fn status_for(error: &Value) -> StatusCode {
    match error.get("code").and_then(Value::as_str) {
        Some("invalid_request") => StatusCode::BAD_REQUEST,
        Some("not_found") => StatusCode::NOT_FOUND,
        Some("conflict") => StatusCode::CONFLICT,
        Some(_) => StatusCode::INTERNAL_SERVER_ERROR,
        // 非契约拒绝(参数反序列化失败等,tauri 给的是字符串)
        None => StatusCode::BAD_REQUEST,
    }
}

async fn api<R: Runtime>(
    State(ctx): State<Arc<Ctx<R>>>,
    RoutePath(command): RoutePath<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if let Some(response) = retired(&ctx) {
        return response;
    }
    if !authorized(&ctx, &headers) {
        return unauthorized();
    }
    if !ctx.commands.contains(&command) {
        return error_response(StatusCode::NOT_FOUND, "not_found", "没有这个命令");
    }
    let raw = headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.starts_with("application/octet-stream"));
    let invoke_body = if raw {
        InvokeBody::Raw(body.to_vec())
    } else if body.is_empty() {
        InvokeBody::Json(json!({}))
    } else {
        match serde_json::from_slice::<Value>(&body) {
            Ok(value) => InvokeBody::Json(value),
            Err(_) => {
                return error_response(StatusCode::BAD_REQUEST, "invalid_request", "请求内容无效")
            }
        }
    };
    // 单 webview 窗口:取窗口里的 Webview(`get_webview` 需要 tauri 的 unstable 特性)
    let Some(webview) = ctx
        .app
        .get_webview_window(MAIN_WEBVIEW)
        .map(|window| window.as_ref().clone())
    else {
        return error_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "internal",
            "攻书主窗口还没就绪",
        );
    };
    // 固定用 tauri 自定义协议地址:tauri 无条件视为本地来源(ACL 放行 app 命令)。
    // 不能取 `webview.url()`——页面没加载成功时 WKWebView 的 URL 为空,wry 在主线程 unwrap 直接 panic(M1 真机冒烟踩到)。
    let url: tauri::Url = "tauri://localhost".parse().expect("static url");
    // 元数据头(x-op-id / x-chunk-index / x-bl-lang / x-bl-hint …)照传;凭证不往命令层传
    let mut forwarded = HeaderMap::new();
    for (name, value) in &headers {
        if name != header::AUTHORIZATION && name != header::COOKIE {
            forwarded.append(name.clone(), value.clone());
        }
    }
    let (tx, rx) = oneshot::channel::<InvokeResponse>();
    webview.on_message(
        InvokeRequest {
            cmd: command,
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url,
            body: invoke_body,
            headers: forwarded,
            invoke_key: ctx.app.invoke_key().to_string(),
        },
        Box::new(move |_webview, _cmd, response, _callback, _error| {
            let _ = tx.send(response);
        }),
    );
    match rx.await {
        Ok(InvokeResponse::Ok(InvokeResponseBody::Json(json))) => {
            ([(header::CONTENT_TYPE, "application/json")], json).into_response()
        }
        Ok(InvokeResponse::Ok(InvokeResponseBody::Raw(bytes))) => {
            ([(header::CONTENT_TYPE, "application/octet-stream")], bytes).into_response()
        }
        Ok(InvokeResponse::Err(error)) => (status_for(&error.0), Json(error.0)).into_response(),
        Err(_) => error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal",
            "命令没有返回结果",
        ),
    }
}

/// books 目录下的直接子文件名(`7.epub`、`7.cover.jpg`):只许字母数字 . - _,不许隐藏文件与 `..`
fn safe_file_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && !name.starts_with('.')
        && !name.contains("..")
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
}

async fn files<R: Runtime>(
    State(ctx): State<Arc<Ctx<R>>>,
    RoutePath(name): RoutePath<String>,
    request: Request,
) -> Response {
    if let Some(response) = retired(&ctx) {
        return response;
    }
    if !authorized(&ctx, request.headers()) {
        return unauthorized();
    }
    let path = ctx.books_dir.join(&name);
    if !safe_file_name(&name) || !path.is_file() {
        return error_response(StatusCode::NOT_FOUND, "not_found", "文件不存在");
    }
    // ServeFile:Range / If-Modified-Since / 按扩展名的 Content-Type 都由它处理
    match tower_http::services::ServeFile::new(path)
        .oneshot(request)
        .await
    {
        Ok(response) => response.map(Body::new),
        Err(never) => match never {},
    }
}

async fn events_stream<R: Runtime>(State(ctx): State<Arc<Ctx<R>>>, headers: HeaderMap) -> Response {
    if let Some(response) = retired(&ctx) {
        return response;
    }
    if !authorized(&ctx, &headers) {
        return unauthorized();
    }
    let receiver = ctx.events.subscribe();
    let shutdown = ctx.shutdown.clone();
    let stream = futures_util::stream::unfold(
        (receiver, shutdown),
        |(mut receiver, mut shutdown)| async move {
            if *shutdown.borrow() {
                return None;
            }
            loop {
                tokio::select! {
                    _ = shutdown.changed() => return None,
                    message = receiver.recv() => match message {
                        Ok((name, payload)) => {
                            let event = SseEvent::default().event(name).data(payload);
                            return Some((Ok::<_, std::convert::Infallible>(event), (receiver, shutdown)));
                        }
                        Err(broadcast::error::RecvError::Lagged(_)) => continue,
                        Err(broadcast::error::RecvError::Closed) => return None,
                    },
                }
            }
        },
    );
    Sse::new(stream)
        .keep_alive(KeepAlive::new().interval(SSE_KEEPALIVE))
        .into_response()
}

/// 经 HTTP 分发的 index.html 注入运行时标记:前端据此同步选 `HttpBackend`(窗口里加载的同一份文件没有这个标记)
pub fn inject_runtime_meta(html: &[u8]) -> Vec<u8> {
    const META: &str = r#"<meta name="bl-runtime" content="http" />"#;
    let text = String::from_utf8_lossy(html);
    match text.find("<head>") {
        Some(at) => {
            let insert_at = at + "<head>".len();
            format!("{}\n    {META}{}", &text[..insert_at], &text[insert_at..]).into_bytes()
        }
        None => format!("{META}{text}").into_bytes(),
    }
}

async fn static_files<R: Runtime>(State(ctx): State<Arc<Ctx<R>>>, uri: Uri) -> Response {
    if let Some(response) = retired(&ctx) {
        return response;
    }
    let path = uri.path().trim_start_matches('/');
    let key = if path.is_empty() { "index.html" } else { path };
    let resolver = ctx.app.asset_resolver();
    // 无扩展名的路径是前端路由(/reader/4 …)→ index.html
    let is_route = !key.rsplit('/').next().unwrap_or(key).contains('.');
    let (asset, is_index) = match resolver.get(key.to_string()) {
        Some(asset) => (Some(asset), key == "index.html"),
        None if is_route => (resolver.get("index.html".to_string()), true),
        None => (None, false),
    };
    let Some(asset) = asset else {
        return error_response(StatusCode::NOT_FOUND, "not_found", "页面不存在");
    };
    // 带 hash 的打包产物长缓存;index.html 每次都问(发版后手机立刻拿到新版)
    let cache = if is_index {
        "no-cache"
    } else if key.starts_with("assets/") {
        "public, max-age=31536000, immutable"
    } else {
        "public, max-age=3600"
    };
    let mime = if key.ends_with(".webmanifest") {
        "application/manifest+json".to_string()
    } else {
        asset.mime_type.clone()
    };
    let bytes = if is_index {
        inject_runtime_meta(&asset.bytes)
    } else {
        asset.bytes.clone()
    };
    (
        [
            (header::CONTENT_TYPE, mime),
            (header::CACHE_CONTROL, cache.to_string()),
        ],
        bytes,
    )
        .into_response()
}

// ---- 运行中的服务(随 app 启停;设置命令触发重启)----

struct Running {
    port: u16,
    bind: Bind,
    shutdown: watch::Sender<bool>,
}

/// 由 `register_commands` 托管的单例
#[derive(Default)]
pub struct MobileServer {
    running: Mutex<Option<Running>>,
    last_error: Mutex<Option<String>>,
}

impl MobileServer {
    /// 停掉当前服务:监听口立即关闭、SSE 流结束;进行中的请求在各自连接上跑完,之后的请求得 503
    pub fn stop(&self) {
        if let Some(running) = self.running.lock().expect("mobile server lock").take() {
            let _ = running.shutdown.send(true);
            tracing::info!(port = running.port, "手机访问服务已停止");
        }
    }

    fn set_error(&self, message: Option<String>) {
        *self.last_error.lock().expect("mobile server lock") = message;
    }

    pub fn last_error(&self) -> Option<String> {
        self.last_error.lock().expect("mobile server lock").clone()
    }

    pub fn running(&self) -> Option<(u16, Bind)> {
        self.running
            .lock()
            .expect("mobile server lock")
            .as_ref()
            .map(|r| (r.port, r.bind))
    }

    /// 按配置(重)启动:先停旧的;关闭则只停。监听失败只记 `last_error`(状态里给用户看),不报错。
    pub fn apply<R: Runtime>(&self, app: &AppHandle<R>, data_root: &Path, books_dir: PathBuf) {
        self.stop();
        self.set_error(None);
        let config = load_config(data_root);
        if !config.enabled {
            return;
        }
        if config.token.is_empty() {
            self.set_error(Some("还没有访问令牌,请先生成".into()));
            return;
        }
        let address = SocketAddr::new(config.bind.ip(), config.port);
        // 刚停掉的旧监听口可能还没释放:短暂重试
        let mut listener = None;
        let mut last = None;
        for _ in 0..20 {
            match std::net::TcpListener::bind(address) {
                Ok(bound) => {
                    listener = Some(bound);
                    break;
                }
                Err(error) => {
                    last = Some(error);
                    std::thread::sleep(Duration::from_millis(100));
                }
            }
        }
        let Some(listener) = listener else {
            let detail = last.map(|e| e.to_string()).unwrap_or_default();
            tracing::warn!(port = config.port, %detail, "手机访问服务监听失败");
            self.set_error(Some(format!("端口 {} 无法监听:{detail}", config.port)));
            return;
        };
        if let Err(error) = listener.set_nonblocking(true) {
            self.set_error(Some(format!("监听口设置失败:{error}")));
            return;
        }
        let service = http_service(app, &config.token, books_dir);
        let shutdown = service.shutdown.clone();
        let mut stop_rx = shutdown.subscribe();
        let port = config.port;
        tauri::async_runtime::spawn(async move {
            let HttpService {
                router, forwarder, ..
            } = service;
            let listener = match tokio::net::TcpListener::from_std(listener) {
                Ok(listener) => listener,
                Err(error) => {
                    tracing::error!(%error, "手机访问服务监听口转换失败");
                    return;
                }
            };
            // 停机即丢弃 serve future → 监听口立刻关闭(换令牌的请求自己就在这个服务上,
            // 优雅停机会等它跑完而它又在等新监听口,互相卡死);已建立的连接各自跑完,
            // 之后再来的请求被 `retired` 拒掉,SSE 流随停机信号结束
            let serve = std::future::IntoFuture::into_future(axum::serve(listener, router));
            tokio::select! {
                served = serve => {
                    if let Err(error) = served {
                        tracing::error!(%error, "手机访问服务异常退出");
                    }
                }
                _ = stop_rx.wait_for(|stopped| *stopped) => {}
            }
            drop(forwarder);
        });
        tracing::info!(port, bind = config.bind.as_str(), "手机访问服务已启动");
        *self.running.lock().expect("mobile server lock") = Some(Running {
            port,
            bind: config.bind,
            shutdown,
        });
    }
}

// ---- 设置命令(契约:mobile_server_status / mobile_server_set / mobile_server_rotate_token)----

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileStatusDto {
    pub enabled: bool,
    pub port: u16,
    /// loopback | lan
    pub bind: String,
    pub running: bool,
    /// 监听失败等原因(中文)
    pub error: Option<String>,
    pub token_set: bool,
    /// 本机/局域网地址(http)
    pub local_url: String,
    /// 检测到 Tailscale 时的 HTTPS 地址(需先执行 `serve_command`)
    pub tailscale_url: Option<String>,
    /// 一次性配置 Tailscale HTTPS 转发的命令
    pub serve_command: String,
    /// 当前令牌(Mac 设置页显示二维码/复制用;已配对的手机本就持有它,不构成额外泄露)
    pub token: Option<String>,
    /// 扫码配对地址 `<手机可达地址>/#pair=<令牌>`
    pub pair_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileTokenDto {
    /// 新令牌(只在这次返回里出现)
    pub token: String,
    /// 扫码配对地址:`<地址>/#pair=<令牌>`
    pub pair_url: String,
}

/// 跑一个外部命令拿 stdout,超时就杀掉(Tailscale 守护进程没起时 CLI 可能卡住)
fn run_with_timeout(program: &str, args: &[&str], timeout: Duration) -> Option<String> {
    let mut child = std::process::Command::new(program)
        .args(args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()?;
    let started = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    return None;
                }
                let mut out = String::new();
                child.stdout.take()?.read_to_string(&mut out).ok()?;
                return Some(out);
            }
            Ok(None) if started.elapsed() < timeout => {
                std::thread::sleep(Duration::from_millis(50))
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
}

/// Tailscale 本机的 MagicDNS 名 → `https://<名>`(没装 / 没登录 → None)
pub fn tailscale_url() -> Option<String> {
    const CANDIDATES: [&str; 3] = [
        "tailscale",
        "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
        "/opt/homebrew/bin/tailscale",
    ];
    CANDIDATES.iter().find_map(|program| {
        let out = run_with_timeout(program, &["status", "--json"], Duration::from_secs(2))?;
        let status: Value = serde_json::from_str(&out).ok()?;
        let dns = status["Self"]["DNSName"].as_str()?.trim_end_matches('.');
        (!dns.is_empty()).then(|| format!("https://{dns}"))
    })
}

fn local_url(config: &MobileConfig) -> String {
    match config.bind {
        Bind::Loopback => format!("http://127.0.0.1:{}", config.port),
        Bind::Lan => {
            let host = run_with_timeout(
                "scutil",
                &["--get", "LocalHostName"],
                Duration::from_secs(2),
            )
            .map(|name| name.trim().to_string())
            .filter(|name| !name.is_empty())
            .map(|name| format!("{name}.local"))
            .unwrap_or_else(|| "localhost".into());
            format!("http://{host}:{}", config.port)
        }
    }
}

/// 手机该用的地址:局域网模式用本机局域网地址,否则优先 Tailscale HTTPS 地址
fn phone_base(config: &MobileConfig, tailscale: Option<&str>) -> String {
    match (config.bind, tailscale) {
        (Bind::Loopback, Some(url)) => url.to_string(),
        _ => local_url(config),
    }
}

fn pair_url(base: &str, token: &str) -> String {
    format!("{base}/#pair={token}")
}

pub fn status(server: &MobileServer, data_root: &Path) -> MobileStatusDto {
    let config = load_config(data_root);
    let tailscale = tailscale_url();
    let token = (!config.token.is_empty()).then(|| config.token.clone());
    MobileStatusDto {
        pair_url: token
            .as_deref()
            .map(|t| pair_url(&phone_base(&config, tailscale.as_deref()), t)),
        token,
        enabled: config.enabled,
        port: config.port,
        bind: config.bind.as_str().into(),
        running: server.running().is_some(),
        error: server.last_error(),
        token_set: !config.token.is_empty(),
        local_url: local_url(&config),
        tailscale_url: tailscale,
        serve_command: format!(
            "tailscale serve --bg --https=443 http://127.0.0.1:{}",
            config.port
        ),
    }
}

/// 设置命令里的(重)启:放到独立线程跑并等它结束。
/// 命令本身跑在 tokio 工作线程上;若在这里直接 `apply`,停机信号唤醒的旧服务任务会进**本线程**的 LIFO 槽
/// (别的工作线程偷不走),而本线程随即在重绑重试里阻塞 sleep → 旧监听口迟迟不关,新端口一直 EADDRINUSE
/// (M1 真机冒烟:经手机换令牌后服务没起来)。从非工作线程发信号,唤醒走全局队列,其他工作线程立刻关掉旧监听口。
fn restart<R: Runtime>(app: &AppHandle<R>, data_root: &Path, books_dir: PathBuf) {
    let app = app.clone();
    let data_root = data_root.to_path_buf();
    let worker = std::thread::spawn(move || {
        app.state::<MobileServer>()
            .apply(&app, &data_root, books_dir);
    });
    if worker.join().is_err() {
        tracing::error!("手机访问服务重启线程异常退出");
    }
}

pub fn set<R: Runtime>(
    app: &AppHandle<R>,
    server: &MobileServer,
    state: &crate::state::AppState,
    enabled: bool,
    port: u16,
    bind: &str,
) -> Result<MobileStatusDto, IpcError> {
    if port < 1024 {
        return Err(IpcError::invalid_request(
            "端口需在 1024–65535 之间",
            format!("bad port {port}"),
        ));
    }
    let mut config = load_config(state.data_root());
    config.enabled = enabled;
    config.port = port;
    config.bind = Bind::parse(bind)?;
    if config.token.is_empty() {
        config.token = new_token()?;
    }
    save_config(state.data_root(), &config)?;
    restart(app, state.data_root(), state.books_dir());
    Ok(status(server, state.data_root()))
}

/// 换新令牌:旧令牌(与它换来的 cookie)立刻失效;服务若开着则重启
pub fn rotate_token<R: Runtime>(
    app: &AppHandle<R>,
    state: &crate::state::AppState,
) -> Result<MobileTokenDto, IpcError> {
    let mut config = load_config(state.data_root());
    config.token = new_token()?;
    save_config(state.data_root(), &config)?;
    restart(app, state.data_root(), state.books_dir());
    let base = phone_base(&config, tailscale_url().as_deref());
    Ok(MobileTokenDto {
        pair_url: pair_url(&base, &config.token),
        token: config.token,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_round_trips_with_0600_and_defaults_on_garbage() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(load_config(dir.path()), MobileConfig::default());
        let config = MobileConfig {
            enabled: true,
            port: 7341,
            bind: Bind::Lan,
            token: new_token().unwrap(),
        };
        assert_eq!(config.token.len(), 64);
        save_config(dir.path(), &config).unwrap();
        assert_eq!(load_config(dir.path()), config);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(config_path(dir.path()))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        std::fs::write(config_path(dir.path()), "{not json").unwrap();
        assert_eq!(load_config(dir.path()), MobileConfig::default());
        assert_ne!(new_token().unwrap(), new_token().unwrap());
    }

    #[test]
    fn tokens_come_from_bearer_or_cookie_and_compare_in_constant_time() {
        let mut headers = HeaderMap::new();
        assert_eq!(request_token(&headers), None);
        headers.insert(header::COOKIE, "a=1; bl_session=abc; b=2".parse().unwrap());
        assert_eq!(request_token(&headers).as_deref(), Some("abc"));
        headers.insert(header::AUTHORIZATION, "Bearer xyz".parse().unwrap());
        assert_eq!(request_token(&headers).as_deref(), Some("xyz"));
        assert!(ct_eq(b"abc", b"abc"));
        assert!(!ct_eq(b"abc", b"abd"));
        assert!(!ct_eq(b"abc", b"abcd"));
    }

    #[test]
    fn file_names_are_restricted_to_plain_children() {
        for ok in ["1.epub", "12.cover.jpg", "a-b_c.png"] {
            assert!(safe_file_name(ok), "{ok}");
        }
        for bad in [
            "",
            ".hidden",
            "../app.db",
            "a/b.epub",
            "a\\b",
            "x..y",
            "app.db;",
        ] {
            assert!(!safe_file_name(bad), "{bad}");
        }
    }

    #[test]
    fn index_html_gets_runtime_meta_right_after_head() {
        let html = b"<!doctype html>\n<html><head>\n<title>x</title></head><body></body></html>";
        let out = String::from_utf8(inject_runtime_meta(html)).unwrap();
        assert!(
            out.contains(
                r#"<head>
    <meta name="bl-runtime" content="http" />"#
            ),
            "{out}"
        );
        assert_eq!(out.matches("bl-runtime").count(), 1);
        let bare = String::from_utf8(inject_runtime_meta(b"<p>no head</p>")).unwrap();
        assert!(bare.starts_with(r#"<meta name="bl-runtime""#));
    }

    #[test]
    fn phone_base_prefers_tailscale_unless_lan() {
        let mut config = MobileConfig::default();
        assert_eq!(
            phone_base(&config, Some("https://mac.ts.net")),
            "https://mac.ts.net"
        );
        assert_eq!(phone_base(&config, None), "http://127.0.0.1:7340");
        config.bind = Bind::Lan;
        assert!(phone_base(&config, Some("https://mac.ts.net")).ends_with(":7340"));
        assert_eq!(pair_url("https://a", "ab"), "https://a/#pair=ab");
    }

    #[test]
    fn bind_and_status_codes() {
        assert_eq!(Bind::parse("loopback").unwrap(), Bind::Loopback);
        assert_eq!(Bind::parse("lan").unwrap().as_str(), "lan");
        assert!(Bind::parse("wan").is_err());
        assert_eq!(
            status_for(&json!({"code": "not_found"})),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            status_for(&json!({"code": "ai_unavailable"})),
            StatusCode::INTERNAL_SERVER_ERROR
        );
        assert_eq!(status_for(&json!("invalid args")), StatusCode::BAD_REQUEST);
        assert!(contract_commands().contains("library_list_books"));
        assert!(!contract_commands().contains("automation_report"));
    }
}
