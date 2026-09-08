use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use book_learner_core::ai::{AiProvider, CodexCliProvider};
use book_learner_core::memory::MemoryStore;
use book_learner_core::orchestrate::AiPolicy;
use book_learner_core::pomodoro::Machine;
use book_learner_core::{CoreError, Result as CoreResult};
use rusqlite::{Connection, OptionalExtension};

use crate::error::{ErrorCode, IpcError};
use crate::import::ImportStore;

/// 可跨线程共享的 AI provider(Tauri `manage` 要求 `Sync`;core 的 trait 无超 trait 约束)。
pub type SharedProvider = Arc<dyn AiProvider + Send + Sync>;

/// Finder 启动的 GUI 不继承 shell PATH,故在 `$PATH` 之后再查这些固定目录。
pub const CODEX_FALLBACK_DIRS: &[&str] = &["/opt/homebrew/bin", "/usr/local/bin"];

/// 计算 GUI 进程应使用的 PATH:把存在但缺失的工具目录**前置**(Homebrew / npm 全局 / nvm 最新 / volta /
/// ~/.local/bin)。codex 是 `#!/usr/bin/env node` 脚本,Finder 启动时 PATH 只有系统目录,子进程会以 127
/// "env: node: No such file or directory" 失败(2026-09-08 用户导入 CFA 笔记时发现)。纯函数便于测试。
pub fn augmented_path(
    current: Option<&std::ffi::OsStr>,
    home: Option<&Path>,
    fallback_dirs: &[&str],
) -> OsString {
    let existing: Vec<PathBuf> = current
        .map(|value| std::env::split_paths(value).collect())
        .unwrap_or_default();
    let mut candidates: Vec<PathBuf> = fallback_dirs.iter().map(PathBuf::from).collect();
    if let Some(home) = home {
        candidates.push(home.join(".npm-global").join("bin"));
        candidates.push(home.join(".volta").join("bin"));
        candidates.push(home.join(".local").join("bin"));
        if let Ok(entries) = std::fs::read_dir(home.join(".nvm").join("versions").join("node")) {
            let mut versions: Vec<PathBuf> = entries
                .flatten()
                .map(|entry| entry.path().join("bin"))
                .collect();
            versions.sort();
            if let Some(latest) = versions.pop() {
                candidates.push(latest);
            }
        }
    }
    let mut prefix: Vec<PathBuf> = Vec::new();
    for candidate in candidates {
        if candidate.is_dir() && !existing.contains(&candidate) && !prefix.contains(&candidate) {
            prefix.push(candidate);
        }
    }
    std::env::join_paths(prefix.into_iter().chain(existing))
        .unwrap_or_else(|_| current.map(OsString::from).unwrap_or_default())
}

/// 进程级修正 PATH(启动时调用一次):让 codex/node/git 等子进程在 Finder 启动的 app 里也能找到。
pub fn ensure_gui_path() {
    let current = std::env::var_os("PATH");
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let augmented = augmented_path(current.as_deref(), home.as_deref(), CODEX_FALLBACK_DIRS);
    if current.as_deref() != Some(augmented.as_os_str()) {
        tracing::info!(path = %augmented.to_string_lossy(), "PATH 已补全工具目录(GUI 启动)");
        std::env::set_var("PATH", augmented);
    }
}

/// 把某个可执行文件所在目录前置到 PATH(配置的 codex 路径可能在 nvm 等目录,其 `node` 也在旁边)。
fn ensure_dir_on_path(directory: &Path) {
    let current = std::env::var_os("PATH").unwrap_or_default();
    if std::env::split_paths(&current).any(|entry| entry == directory) {
        return;
    }
    if let Ok(joined) = std::env::join_paths(
        std::iter::once(directory.to_path_buf()).chain(std::env::split_paths(&current)),
    ) {
        std::env::set_var("PATH", joined);
    }
}

/// 进行中的慢命令(导入/地图作业/回合/评估)计数;退出前等待其收尾(M7 有序退出)。
#[derive(Default)]
pub struct JobRegistry {
    in_flight: Mutex<usize>,
    idle: Condvar,
}

impl JobRegistry {
    pub fn begin(&self) -> JobGuard<'_> {
        *self
            .in_flight
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) += 1;
        JobGuard(self)
    }

    pub fn in_flight(&self) -> usize {
        *self
            .in_flight
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// 阻塞直到无进行中任务或超时;返回是否已空闲。
    pub fn wait_idle(&self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        let mut count = self
            .in_flight
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        while *count > 0 {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return false;
            }
            let (guard, _) = self
                .idle
                .wait_timeout(count, remaining)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            count = guard;
        }
        true
    }
}

pub struct JobGuard<'a>(&'a JobRegistry);

impl Drop for JobGuard<'_> {
    fn drop(&mut self) {
        let mut count = self
            .0
            .in_flight
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *count = count.saturating_sub(1);
        self.0.idle.notify_all();
    }
}

pub struct AppState {
    connection: Mutex<Connection>,
    correlation_counter: AtomicU64,
    database_path: PathBuf,
    data_root: PathBuf,
    memory: MemoryStore,
    import: ImportStore,
    jobs: Arc<JobRegistry>,
    pomodoro: Mutex<Machine>,
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
        let import = ImportStore::new(&data_root);
        std::fs::create_dir_all(import.books_dir())
            .map_err(|error| IpcError::from(CoreError::Io(error)))?;
        Ok(Self {
            connection: Mutex::new(connection),
            correlation_counter: AtomicU64::new(0),
            database_path: database_path.to_path_buf(),
            data_root,
            memory,
            import,
            jobs: Arc::new(JobRegistry::default()),
            pomodoro: Mutex::new(Machine::new()),
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

    /// 受管 EPUB 存放目录 `<data_root>/books`(导入 finalize 落盘处;asset protocol 只放行此目录)。
    pub fn books_dir(&self) -> PathBuf {
        self.import.books_dir().to_path_buf()
    }

    pub fn import_store(&self) -> &ImportStore {
        &self.import
    }

    /// 慢命令在调用 core 前 `begin()` 持有守卫;退出时 `wait_idle`。
    pub fn jobs(&self) -> &Arc<JobRegistry> {
        &self.jobs
    }

    /// 番茄钟状态机(纯);命令与 ticker 线程都经此锁访问,锁内不做 I/O。
    pub fn pomodoro(&self) -> &Mutex<Machine> {
        &self.pomodoro
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
        if let Some(directory) = bin.parent() {
            ensure_dir_on_path(directory);
        }
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
