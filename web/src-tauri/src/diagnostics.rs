//! 诊断与日志(测试阶段,2026-09-09):
//! - Rust tracing 同时写 stderr 与 `<data_root>/logs/app.log.YYYY-MM-DD`(按天滚动,保留 `LOG_KEEP_DAYS` 天);
//!   从 Finder 启动的 app 没有 stderr,之前定位问题只能翻 SQLite。
//! - `run_command` 为每条 IPC 命令记一行 info(命令名/关联 id/耗时/结果),只记元数据不记正文。
//! - 前端经 `log_client_event` 把 JS 异常、未处理 Promise、IPC 传输错误、路由切换写进同一日志(target=`client`)。
//! - `app_info` 给设置页显示版本 / git 提交 / 构建时间 / 数据目录 / 日志目录;`app_reveal_logs` 在 Finder 打开日志目录。
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use serde::Serialize;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::EnvFilter;

use crate::error::IpcError;
use crate::state::AppState;

pub const LOG_DIR_NAME: &str = "logs";
pub const LOG_FILE_PREFIX: &str = "app.log";
pub const LOG_KEEP_DAYS: i64 = 14;
/// 前端事件的消息/上下文各自截断到这么多字节(防止把整段复述或大对象倒进日志)
pub const CLIENT_EVENT_MAX_BYTES: usize = 4096;
pub const CLIENT_LEVELS: &[&str] = &["error", "warn", "info"];

/// 构建期由 build.rs 注入;本地无 git 时为 "unknown"
pub const GIT_SHA: &str = env!("BL_GIT_SHA");
pub const BUILT_AT: &str = env!("BL_BUILT_AT");

static GUARD: OnceLock<tracing_appender::non_blocking::WorkerGuard> = OnceLock::new();

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfoDto {
    pub version: String,
    pub git_sha: String,
    pub built_at: String,
    pub data_dir: String,
    pub log_dir: String,
}

pub fn log_dir(data_root: &Path) -> PathBuf {
    data_root.join(LOG_DIR_NAME)
}

/// 平台数据目录(与 tauri `app.path().data_dir()` 一致),用于在 App 句柄可用之前就把日志文件打开。
pub fn platform_data_dir_early() -> Option<PathBuf> {
    let home = std::env::var_os("HOME").map(PathBuf::from)?;
    if cfg!(target_os = "macos") {
        Some(home.join("Library").join("Application Support"))
    } else if let Some(xdg) = std::env::var_os("XDG_DATA_HOME") {
        Some(PathBuf::from(xdg))
    } else {
        Some(home.join(".local").join("share"))
    }
}

/// 安装进程级 subscriber:stderr + 可选的按天滚动文件。重复调用返回 false(已装)。
/// 日志级别:`RUST_LOG` 优先,默认 `info`。
pub fn init_logging(data_root: Option<&Path>) -> bool {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    let stderr_layer = tracing_subscriber::fmt::layer().with_writer(std::io::stderr);
    let file_layer = data_root.and_then(|root| {
        let dir = log_dir(root);
        std::fs::create_dir_all(&dir).ok()?;
        let appender = tracing_appender::rolling::daily(&dir, LOG_FILE_PREFIX);
        let (writer, guard) = tracing_appender::non_blocking(appender);
        // 只保留第一份 guard;若已有(重复初始化)则新 writer 随即丢弃
        if GUARD.set(guard).is_err() {
            return None;
        }
        Some(
            tracing_subscriber::fmt::layer()
                .with_ansi(false)
                .with_target(true)
                .with_writer(writer),
        )
    });
    tracing_subscriber::registry()
        .with(filter)
        .with(stderr_layer)
        .with(file_layer)
        .try_init()
        .is_ok()
}

/// 删除超过 `keep_days` 的 `app.log.YYYY-MM-DD`;返回删除数。只认本模块命名的文件。
pub fn prune_logs(dir: &Path, keep_days: i64, today: chrono::NaiveDate) -> usize {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    let mut removed = 0;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(date) = name
            .strip_prefix(&format!("{LOG_FILE_PREFIX}."))
            .and_then(|d| chrono::NaiveDate::parse_from_str(d, "%Y-%m-%d").ok())
        else {
            continue;
        };
        if (today - date).num_days() > keep_days && std::fs::remove_file(entry.path()).is_ok() {
            removed += 1;
        }
    }
    removed
}

fn truncate_bytes(text: &str, limit: usize) -> String {
    if text.len() <= limit {
        return text.to_string();
    }
    let mut end = limit;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…[+{}B]", &text[..end], text.len() - end)
}

/// 前端事件落日志(target `client`)。level 白名单;消息与上下文截断;不接受空消息。
pub fn record_client_event(
    level: &str,
    message: &str,
    context: Option<&serde_json::Value>,
) -> Result<(), IpcError> {
    if !CLIENT_LEVELS.contains(&level) {
        return Err(IpcError::invalid_request(
            "日志级别无效",
            format!("client log level {level:?}"),
        ));
    }
    let message = message.trim();
    if message.is_empty() {
        return Err(IpcError::invalid_request(
            "日志消息为空",
            "empty client log message",
        ));
    }
    let message = truncate_bytes(message, CLIENT_EVENT_MAX_BYTES);
    let context = context
        .filter(|value| !value.is_null())
        .map(|value| truncate_bytes(&value.to_string(), CLIENT_EVENT_MAX_BYTES))
        .unwrap_or_default();
    match level {
        "error" => tracing::error!(target: "client", message = %message, context = %context),
        "warn" => tracing::warn!(target: "client", message = %message, context = %context),
        _ => tracing::info!(target: "client", message = %message, context = %context),
    }
    Ok(())
}

pub fn app_info(state: &AppState) -> AppInfoDto {
    AppInfoDto {
        version: env!("CARGO_PKG_VERSION").to_string(),
        git_sha: GIT_SHA.to_string(),
        built_at: BUILT_AT.to_string(),
        data_dir: state.data_root().to_string_lossy().into_owned(),
        log_dir: log_dir(state.data_root()).to_string_lossy().into_owned(),
    }
}

/// 在 Finder 里打开日志目录(不存在则先创建)。只打开由数据目录推导的路径。
pub fn reveal_logs(state: &AppState) -> Result<(), IpcError> {
    let dir = log_dir(state.data_root());
    std::fs::create_dir_all(&dir)
        .map_err(|error| IpcError::from(book_learner_core::CoreError::Io(error)))?;
    if !cfg!(target_os = "macos") {
        return Err(IpcError::invalid_request(
            "此平台不支持在文件管理器中显示",
            "reveal only on macos",
        ));
    }
    let status = std::process::Command::new("open")
        .arg(&dir)
        .status()
        .map_err(|error| IpcError::internal(format!("open failed: {error}")))?;
    if !status.success() {
        return Err(IpcError::internal(format!("open exited with {status}")));
    }
    Ok(())
}
