pub mod db;
pub mod eval;
pub mod models;

#[derive(thiserror::Error, Debug)]
pub enum CoreError {
    #[error("db: {0}")] Db(#[from] rusqlite::Error),
    #[error("io: {0}")] Io(#[from] std::io::Error),
    #[error("eval parse: {0}")] EvalParse(String),
    #[error("ai: {0}")] Ai(String),
    #[error("{0}")] Other(String),
}
pub type Result<T> = std::result::Result<T, CoreError>;
