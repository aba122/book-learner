pub mod ai;
pub mod db;
pub mod eval;
pub mod library;
pub mod memory;
pub mod models;
pub mod planning;
pub mod prompts;
pub mod sched;
pub mod settings;

#[derive(thiserror::Error, Debug)]
pub enum CoreError {
    #[error("db: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("invalid input: {0}")]
    InvalidInput(String),
    #[error("not found: {0}")]
    NotFound(String),
    #[error("conflict: {0}")]
    Conflict(String),
    #[error("eval parse: {0}")]
    EvalParse(String),
    #[error("ai: {0}")]
    Ai(String),
    #[error("{0}")]
    Other(String),
}
pub type Result<T> = std::result::Result<T, CoreError>;
