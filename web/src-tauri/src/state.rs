use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use book_learner_core::Result as CoreResult;
use rusqlite::Connection;

#[cfg(debug_assertions)]
use crate::error::ErrorCode;
use crate::error::IpcError;

pub struct AppState {
    connection: Mutex<Connection>,
    correlation_counter: AtomicU64,
}

impl AppState {
    pub fn open(database_path: &Path) -> Result<Self, IpcError> {
        let connection = book_learner_core::db::open(database_path)
            .map_err(book_learner_core::CoreError::from)
            .map_err(IpcError::from)?;
        Ok(Self {
            connection: Mutex::new(connection),
            correlation_counter: AtomicU64::new(0),
        })
    }

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

    pub fn next_correlation_id(&self) -> String {
        let counter = self.correlation_counter.fetch_add(1, Ordering::Relaxed) + 1;
        format!("mac-{}-{counter}", std::process::id())
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
