use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use book_learner_core::ai::{AiProvider, CodexCliProvider};
use book_learner_core::memory::MemoryStore;
use book_learner_core::orchestrate::AiPolicy;
use book_learner_core::{CoreError, Result as CoreResult};
use rusqlite::{Connection, OptionalExtension};

use crate::error::{ErrorCode, IpcError};

/// 可跨线程共享的 AI provider(Tauri `manage` 要求 `Sync`;core 的 trait 无超 trait 约束)。
pub type SharedProvider = Arc<dyn AiProvider + Send + Sync>;

/// Finder 启动的 GUI 不继承 shell PATH,故在 `$PATH` 之后再查这些固定目录。
pub const CODEX_FALLBACK_DIRS: &[&str] = &["/opt/homebrew/bin", "/usr/local/bin"];

pub struct AppState {
    connection: Mutex<Connection>,
    correlation_counter: AtomicU64,
    database_path: PathBuf,
    data_root: PathBuf,
    memory: MemoryStore,
    provider_override: Option<SharedProvider>,
}

impl AppState {
    /// 打开数据库,并初始化同目录下的记忆库 `<data_root>/memory`(含 git 仓库)。
    pub fn open(database_path: &Path) -> Result<Self, IpcError> {
        let connection = book_learner_core::db::open(database_path)
            .map_err(CoreError::from)
            .map_err(IpcError::from)?;
        let data_root = database_path
            .parent()
            .ok_or_else(|| IpcError::internal("database path has no parent directory"))?
            .to_path_buf();
        let memory = MemoryStore::init(&data_root.join("memory")).map_err(IpcError::from)?;
        Ok(Self {
            connection: Mutex::new(connection),
            correlation_counter: AtomicU64::new(0),
            database_path: database_path.to_path_buf(),
            data_root,
            memory,
            provider_override: None,
        })
    }

    /// 测试注入 AI provider;生产路径不调用(走 codex CLI)。
    pub fn with_provider(mut self, provider: SharedProvider) -> Self {
        self.provider_override = Some(provider);
        self
    }

    /// 快操作共享连接:持有互斥守卫期间不得做 AI 调用或文件/git I/O。
    pub fn with_connection<T>(
        &self,
        operation: impl FnOnce(&Connection) -> CoreResult<T>,
    ) -> Result<T, IpcError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| IpcError::internal("SQLite connection mutex poisoned"))?;
        operation(&connection).map_err(IpcError::from)
    }

    /// 慢命令(地图作业、会话回合、评估、导入、投影恢复)专用独立连接(含 busy_timeout/外键/迁移),
    /// 不持有 `with_connection` 的守卫,避免 UI 快查询被串行在 AI 调用之后。
    pub fn open_connection(&self) -> Result<Connection, IpcError> {
        book_learner_core::db::open(&self.database_path)
            .map_err(CoreError::from)
            .map_err(IpcError::from)
    }

    pub fn next_correlation_id(&self) -> String {
        let counter = self.correlation_counter.fetch_add(1, Ordering::Relaxed) + 1;
        format!("mac-{}-{counter}", std::process::id())
    }

    pub fn database_path(&self) -> &Path {
        &self.database_path
    }

    pub fn data_root(&self) -> &Path {
        &self.data_root
    }

    pub fn memory(&self) -> &MemoryStore {
        &self.memory
    }

    /// 记忆库根(codex 工作目录)。
    pub fn memory_root(&self) -> &Path {
        self.memory.root()
    }

    /// 受管 EPUB 存放目录 `<data_root>/books`(M6 导入落盘处)。
    pub fn books_dir(&self) -> PathBuf {
        self.data_root.join("books")
    }

    /// AI provider 与策略:注入优先;否则 codex CLI,`bin` 取 `setting.codexBin`(绝对路径)或按
    /// [`resolve_codex_bin`] 的固定顺序解析 `codex`。`codexBin` 不是 `AppSettings` 字段,直接读表。
    pub fn ai_provider(&self) -> Result<(SharedProvider, AiPolicy), IpcError> {
        if let Some(provider) = &self.provider_override {
            return Ok((Arc::clone(provider), AiPolicy::default()));
        }
        let configured: Option<String> = self.with_connection(|connection| {
            Ok(connection
                .query_row(
                    "SELECT value FROM setting WHERE key='codexBin'",
                    [],
                    |row| row.get(0),
                )
                .optional()?)
        })?;
        let bin = resolve_codex_bin(
            configured.as_deref(),
            std::env::var_os("PATH"),
            std::env::var_os("HOME").map(PathBuf::from),
            CODEX_FALLBACK_DIRS,
        )?;
        Ok((
            Arc::new(CodexCliProvider {
                bin,
                extra_args: vec![],
            }),
            AiPolicy::default(),
        ))
    }
}

/// 解析 codex 可执行文件:配置的绝对路径 → `$PATH` 各目录 → `fallback_dirs` → `~/.npm-global/bin`
/// → `~/.nvm/versions/node/*/bin`(高版本优先)。纯函数(环境经参数传入),便于测试。
pub fn resolve_codex_bin(
    configured: Option<&str>,
    path_env: Option<OsString>,
    home: Option<PathBuf>,
    fallback_dirs: &[&str],
) -> Result<PathBuf, IpcError> {
    if let Some(value) = configured.map(str::trim).filter(|value| !value.is_empty()) {
        let path = PathBuf::from(value);
        if !path.is_absolute() {
            return Err(IpcError {
                code: ErrorCode::InvalidRequest,
                message: "设置中的 codex 路径必须是绝对路径".into(),
                retryable: false,
                details: None,
                internal_cause: format!("codexBin is relative: {value}"),
            });
        }
        if is_executable(&path) {
            return Ok(path);
        }
        return Err(codex_not_found(format!(
            "configured codexBin is not an executable file: {}",
            path.display()
        )));
    }
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(path_env) = path_env {
        candidates.extend(std::env::split_paths(&path_env));
    }
    candidates.extend(fallback_dirs.iter().map(PathBuf::from));
    if let Some(home) = home {
        candidates.push(home.join(".npm-global").join("bin"));
        if let Ok(entries) = std::fs::read_dir(home.join(".nvm").join("versions").join("node")) {
            let mut versions: Vec<PathBuf> = entries
                .flatten()
                .map(|entry| entry.path().join("bin"))
                .collect();
            versions.sort();
            versions.reverse();
            candidates.extend(versions);
        }
    }
    for directory in &candidates {
        let candidate = directory.join("codex");
        if is_executable(&candidate) {
            return Ok(candidate);
        }
    }
    Err(codex_not_found(format!(
        "codex not found in {} candidate directories",
        candidates.len()
    )))
}

fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path)
        .map(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

fn codex_not_found(cause: String) -> IpcError {
    IpcError {
        code: ErrorCode::NotFound,
        message: "未找到 codex 可执行文件,请在设置中填写其绝对路径".into(),
        retryable: false,
        details: None,
        internal_cause: cause,
    }
}

pub fn resolve_database_path(platform_data_dir: &Path) -> Result<PathBuf, IpcError> {
    match debug_data_dir_override()? {
        Some(directory) => Ok(directory.join("app.db")),
        None => Ok(platform_data_dir.join("book-learner").join("app.db")),
    }
}

#[cfg(debug_assertions)]
fn debug_data_dir_override() -> Result<Option<PathBuf>, IpcError> {
    let Some(value) = std::env::var_os("BOOK_LEARNER_DATA_DIR") else {
        return Ok(None);
    };
    let path = PathBuf::from(value);
    if !path.is_absolute() {
        return Err(IpcError {
            code: ErrorCode::InvalidRequest,
            message: "调试数据目录必须是绝对路径".into(),
            retryable: false,
            details: None,
            internal_cause: "BOOK_LEARNER_DATA_DIR was relative".into(),
        });
    }
    Ok(Some(path))
}

#[cfg(not(debug_assertions))]
fn debug_data_dir_override() -> Result<Option<PathBuf>, IpcError> {
    Ok(None)
}
