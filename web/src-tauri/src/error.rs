use std::fmt;

use book_learner_core::CoreError;
use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    InvalidRequest,
    NotFound,
    Conflict,
    DbUnavailable,
    IoFailure,
    NotImplemented,
    Internal,
}

impl ErrorCode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::InvalidRequest => "invalid_request",
            Self::NotFound => "not_found",
            Self::Conflict => "conflict",
            Self::DbUnavailable => "db_unavailable",
            Self::IoFailure => "io_failure",
            Self::NotImplemented => "not_implemented",
            Self::Internal => "internal",
        }
    }
}

impl fmt::Display for ErrorCode {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

#[derive(Debug, Serialize)]
pub struct IpcError {
    pub code: ErrorCode,
    pub message: String,
    pub retryable: bool,
    pub details: Option<Value>,
    #[serde(skip)]
    pub(crate) internal_cause: String,
}

impl IpcError {
    pub(crate) fn internal(cause: impl Into<String>) -> Self {
        Self {
            code: ErrorCode::Internal,
            message: "应用内部错误".into(),
            retryable: false,
            details: None,
            internal_cause: cause.into(),
        }
    }

    pub(crate) fn not_implemented(capability: String) -> Self {
        Self {
            code: ErrorCode::NotImplemented,
            message: "此功能尚未在 Mac 版中实现".into(),
            retryable: false,
            details: Some(serde_json::json!({ "capability": capability })),
            internal_cause: "unsupported native capability".into(),
        }
    }

    pub(crate) fn internal_cause(&self) -> &str {
        &self.internal_cause
    }
}

impl From<CoreError> for IpcError {
    fn from(source: CoreError) -> Self {
        let internal_cause = source.to_string();
        let (code, message, retryable) = match source {
            CoreError::InvalidInput(_) => (ErrorCode::InvalidRequest, "请求参数无效", false),
            CoreError::NotFound(_) => (ErrorCode::NotFound, "未找到请求的数据", false),
            CoreError::Conflict(_) => (ErrorCode::Conflict, "数据状态冲突，请刷新后重试", false),
            CoreError::Db(_) => (ErrorCode::DbUnavailable, "无法读取本地学习数据", true),
            CoreError::Io(_) => (ErrorCode::IoFailure, "无法访问本地文件", true),
            CoreError::EvalParse(_) | CoreError::Ai(_) | CoreError::Other(_) => {
                (ErrorCode::Internal, "应用内部错误", false)
            }
        };
        Self {
            code,
            message: message.into(),
            retryable,
            details: None,
            internal_cause,
        }
    }
}
