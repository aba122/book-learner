//! 幂等 AI 请求编排(ADR-0002):同 request_id 重放、accept 校验、传输重试、JSON 纠错一次。
//! 所有 AI 调用必须经本模块;调用期间不持有数据库事务。

use crate::ai::{AiProvider, CompletionRequest};
use crate::{CoreError, Result};
use rusqlite::{Connection, OptionalExtension};
use std::cell::RefCell;

/// 重试策略。传输类错误(`Ai | Io`)最多重试 `max_transport_retries` 次(指数退避,起始 `retry_backoff_ms`);
/// 结构化请求 accept 失败最多纠错 `json_corrective_retries` 次。
#[derive(Debug, Clone, PartialEq)]
pub struct AiPolicy {
    pub max_transport_retries: u32,
    pub json_corrective_retries: u32,
    pub retry_backoff_ms: u64,
}
impl Default for AiPolicy {
    fn default() -> Self {
        Self {
            max_transport_retries: 2,
            json_corrective_retries: 1,
            retry_backoff_ms: 500,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum RequestOutcome {
    Fresh(String),
    Replayed(String),
}
impl RequestOutcome {
    pub fn text(&self) -> &str {
        match self {
            Self::Fresh(t) | Self::Replayed(t) => t,
        }
    }
    pub fn into_text(self) -> String {
        match self {
            Self::Fresh(t) | Self::Replayed(t) => t,
        }
    }
}

const MAX_REQUEST_ID_LEN: usize = 128;
const MAX_CLIENT_ID_LEN: usize = 64;
/// 纠错提示里附带的错误摘要字符数
const ERROR_SUMMARY_CHARS: usize = 200;

/// 完整请求 id:非空、≤128、仅 `[A-Za-z0-9._:-]`。
pub fn validate_request_id(id: &str) -> Result<()> {
    let ok = !id.is_empty()
        && id.len() <= MAX_REQUEST_ID_LEN
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b':' | b'-'));
    if ok {
        Ok(())
    } else {
        Err(CoreError::InvalidInput(format!(
            "invalid request id {id:?}"
        )))
    }
}

/// 客户端提供的 id 片段:非空、≤64、仅 `[A-Za-z0-9._-]`(不含 ':',留给命名空间)。
pub fn validate_client_id(id: &str) -> Result<()> {
    let ok = !id.is_empty()
        && id.len() <= MAX_CLIENT_ID_LEN
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'));
    if ok {
        Ok(())
    } else {
        Err(CoreError::InvalidInput(format!("invalid client id {id:?}")))
    }
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

fn load(conn: &Connection, id: &str) -> Result<Option<(String, Option<String>)>> {
    Ok(conn
        .query_row(
            "SELECT status,result FROM ai_request WHERE request_id=?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?)
}

fn ensure_row(conn: &Connection, id: &str, kind: &str) -> Result<()> {
    let ts = now();
    conn.execute(
        "INSERT INTO ai_request(request_id,kind,status,created_at,updated_at) VALUES(?1,?2,'pending',?3,?3) \
         ON CONFLICT(request_id) DO UPDATE SET status='pending', updated_at=excluded.updated_at",
        rusqlite::params![id, kind, ts],
    )?;
    Ok(())
}

fn bump_attempt(conn: &Connection, id: &str) -> Result<()> {
    conn.execute(
        "UPDATE ai_request SET attempts=attempts+1, updated_at=?2 WHERE request_id=?1",
        rusqlite::params![id, now()],
    )?;
    Ok(())
}

fn mark_done(conn: &Connection, id: &str, result: &str) -> Result<()> {
    conn.execute(
        "UPDATE ai_request SET status='done', result=?2, error=NULL, updated_at=?3 WHERE request_id=?1",
        rusqlite::params![id, result, now()],
    )?;
    Ok(())
}

fn mark_failed(conn: &Connection, id: &str, error: &str) -> Result<()> {
    conn.execute(
        "UPDATE ai_request SET status='failed', result=NULL, error=?2, updated_at=?3 WHERE request_id=?1",
        rusqlite::params![id, error, now()],
    )?;
    Ok(())
}

fn is_transport_error(e: &CoreError) -> bool {
    matches!(e, CoreError::Ai(_) | CoreError::Io(_))
}

/// 幂等文本请求(接口语义见 ADR-0002 与计划 A3)。
pub fn run_ai_request(
    conn: &Connection,
    provider: &dyn AiProvider,
    request_id: &str,
    kind: &str,
    req: &CompletionRequest,
    policy: &AiPolicy,
    accept: &dyn Fn(&str) -> Result<()>,
) -> Result<RequestOutcome> {
    if !conn.is_autocommit() {
        return Err(CoreError::Other(
            "run_ai_request must not be called inside a transaction".into(),
        ));
    }
    validate_request_id(request_id)?;
    if let Some((status, Some(result))) = load(conn, request_id)? {
        if status == "done" {
            return Ok(RequestOutcome::Replayed(result));
        }
    }
    ensure_row(conn, request_id, kind)?;
    let mut req = req.clone();
    req.request_id = request_id.to_string();
    let mut transport_failures = 0u32;
    loop {
        bump_attempt(conn, request_id)?;
        match provider.complete(&req) {
            Ok(text) => match accept(&text) {
                Ok(()) => {
                    mark_done(conn, request_id, &text)?;
                    return Ok(RequestOutcome::Fresh(text));
                }
                Err(e) => {
                    mark_failed(conn, request_id, &e.to_string())?;
                    return Err(e);
                }
            },
            Err(e)
                if is_transport_error(&e) && transport_failures < policy.max_transport_retries =>
            {
                transport_failures += 1;
                let backoff = policy
                    .retry_backoff_ms
                    .saturating_mul(1u64 << (transport_failures - 1));
                if backoff > 0 {
                    std::thread::sleep(std::time::Duration::from_millis(backoff));
                }
            }
            Err(e) => {
                mark_failed(conn, request_id, &e.to_string())?;
                return Err(e);
            }
        }
    }
}

fn summarize(e: &CoreError) -> String {
    let text = e.to_string();
    let total = text.chars().count();
    if total <= ERROR_SUMMARY_CHARS {
        text
    } else {
        text.chars().take(ERROR_SUMMARY_CHARS).collect::<String>() + "…"
    }
}

/// 结构化请求:`parse` 既是 accept 校验也是结果解析(可含语义校验)。accept 失败恰纠错一次;
/// Replayed 结果若不再通过 parse → 记 failed 并再调 provider(见计划 A3)。
pub fn run_ai_json<T>(
    conn: &Connection,
    provider: &dyn AiProvider,
    request_id: &str,
    kind: &str,
    req: &CompletionRequest,
    policy: &AiPolicy,
    parse: &dyn Fn(&str) -> Result<T>,
) -> Result<T> {
    let mut req = req.clone();
    let mut corrections = 0u32;
    loop {
        let rejected: RefCell<Option<String>> = RefCell::new(None);
        let accept = |text: &str| match parse(text) {
            Ok(_) => Ok(()),
            Err(e) => {
                *rejected.borrow_mut() = Some(summarize(&e));
                Err(e)
            }
        };
        match run_ai_request(conn, provider, request_id, kind, &req, policy, &accept) {
            Ok(RequestOutcome::Fresh(text)) => return parse(&text),
            Ok(RequestOutcome::Replayed(text)) => match parse(&text) {
                Ok(v) => return Ok(v),
                Err(e) => {
                    // 存储结果已不满足当前要求(如 spine 重存):作废后按 Fresh 流程再调 provider
                    mark_failed(conn, request_id, &e.to_string())?;
                }
            },
            Err(e) => {
                let reason = rejected.borrow_mut().take();
                match reason {
                    Some(reason) if corrections < policy.json_corrective_retries => {
                        corrections += 1;
                        req.system.push_str(&format!(
                            "\n\n上一次输出不可用:{reason}。请只输出满足要求的 JSON。"
                        ));
                    }
                    _ => return Err(e),
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::{AiProvider, CompletionRequest};
    use crate::CoreError;
    use std::cell::{Cell, RefCell};
    use std::collections::VecDeque;

    enum Reply {
        Ok(&'static str),
        Ai,
        Io,
        Invalid,
        Db,
    }
    struct CountingProvider {
        replies: RefCell<VecDeque<Reply>>,
        calls: Cell<usize>,
        systems: RefCell<Vec<String>>,
    }
    impl CountingProvider {
        fn new(replies: Vec<Reply>) -> Self {
            Self {
                replies: RefCell::new(replies.into()),
                calls: Cell::new(0),
                systems: RefCell::new(vec![]),
            }
        }
    }
    impl AiProvider for CountingProvider {
        fn complete(&self, req: &CompletionRequest) -> crate::Result<String> {
            self.calls.set(self.calls.get() + 1);
            self.systems.borrow_mut().push(req.system.clone());
            match self
                .replies
                .borrow_mut()
                .pop_front()
                .expect("no scripted reply")
            {
                Reply::Ok(s) => Ok(s.to_string()),
                Reply::Ai => Err(CoreError::Ai("timeout".into())),
                Reply::Io => Err(CoreError::Io(std::io::Error::other("pipe"))),
                Reply::Invalid => Err(CoreError::InvalidInput("too big".into())),
                Reply::Db => Err(CoreError::Db(rusqlite::Error::QueryReturnedNoRows)),
            }
        }
    }
    fn req() -> CompletionRequest {
        CompletionRequest {
            system: "sys".into(),
            messages: vec![],
            workdir: std::env::temp_dir(),
            read_only: true,
            request_id: String::new(),
            timeout_secs: 5,
        }
    }
    fn policy() -> AiPolicy {
        AiPolicy {
            retry_backoff_ms: 0,
            ..AiPolicy::default()
        }
    }
    fn row(conn: &rusqlite::Connection, id: &str) -> (String, i64, Option<String>, Option<String>) {
        conn.query_row(
            "SELECT status,attempts,result,error FROM ai_request WHERE request_id=?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .unwrap()
    }
    fn accept_all(_: &str) -> crate::Result<()> {
        Ok(())
    }

    #[test]
    fn transport_failures_retry_with_same_id() {
        let conn = crate::db::open_in_memory().unwrap();
        let p = CountingProvider::new(vec![Reply::Ai, Reply::Ai, Reply::Ok("x")]);
        let out = run_ai_request(&conn, &p, "r1", "test", &req(), &policy(), &accept_all).unwrap();
        assert_eq!(out, RequestOutcome::Fresh("x".into()));
        assert_eq!(p.calls.get(), 3);
        let (status, attempts, result, _) = row(&conn, "r1");
        assert_eq!(
            (status.as_str(), attempts, result.as_deref()),
            ("done", 3, Some("x"))
        );
    }

    #[test]
    fn exhausted_retries_mark_failed() {
        let conn = crate::db::open_in_memory().unwrap();
        let p = CountingProvider::new(vec![Reply::Ai, Reply::Ai, Reply::Ai]);
        let err =
            run_ai_request(&conn, &p, "r1", "test", &req(), &policy(), &accept_all).unwrap_err();
        assert!(matches!(err, CoreError::Ai(_)));
        assert_eq!(p.calls.get(), 3);
        let (status, attempts, _, error) = row(&conn, "r1");
        assert_eq!((status.as_str(), attempts), ("failed", 3));
        assert!(!error.unwrap().is_empty());
    }

    #[test]
    fn same_id_replays_without_calling_provider() {
        let conn = crate::db::open_in_memory().unwrap();
        let p = CountingProvider::new(vec![Reply::Ok("x")]);
        run_ai_request(&conn, &p, "r1", "test", &req(), &policy(), &accept_all).unwrap();
        let out = run_ai_request(&conn, &p, "r1", "test", &req(), &policy(), &accept_all).unwrap();
        assert_eq!(out, RequestOutcome::Replayed("x".into()));
        assert_eq!(p.calls.get(), 1);
    }

    #[test]
    fn invalid_input_not_retried() {
        let conn = crate::db::open_in_memory().unwrap();
        let p = CountingProvider::new(vec![Reply::Invalid, Reply::Ok("x")]);
        let err =
            run_ai_request(&conn, &p, "r1", "test", &req(), &policy(), &accept_all).unwrap_err();
        assert!(matches!(err, CoreError::InvalidInput(_)));
        assert_eq!(p.calls.get(), 1);
        assert_eq!(row(&conn, "r1").0, "failed");
    }

    #[test]
    fn io_error_is_retried_db_error_is_not() {
        let conn = crate::db::open_in_memory().unwrap();
        let p = CountingProvider::new(vec![Reply::Io, Reply::Ok("x")]);
        run_ai_request(&conn, &p, "r1", "test", &req(), &policy(), &accept_all).unwrap();
        assert_eq!(p.calls.get(), 2);
        let p2 = CountingProvider::new(vec![Reply::Db, Reply::Ok("x")]);
        assert!(run_ai_request(&conn, &p2, "r2", "test", &req(), &policy(), &accept_all).is_err());
        assert_eq!(p2.calls.get(), 1);
    }

    #[test]
    fn accept_failure_marks_failed_without_done() {
        let conn = crate::db::open_in_memory().unwrap();
        let p = CountingProvider::new(vec![Reply::Ok("bad"), Reply::Ok("good")]);
        let reject_bad = |t: &str| {
            if t == "bad" {
                Err(CoreError::EvalParse("no json".into()))
            } else {
                Ok(())
            }
        };
        let err =
            run_ai_request(&conn, &p, "r1", "test", &req(), &policy(), &reject_bad).unwrap_err();
        assert!(matches!(err, CoreError::EvalParse(_)));
        let (status, attempts, result, error) = row(&conn, "r1");
        assert_eq!((status.as_str(), attempts, result), ("failed", 1, None));
        assert!(error.unwrap().contains("no json"));
        let out = run_ai_request(&conn, &p, "r1", "test", &req(), &policy(), &reject_bad).unwrap();
        assert_eq!(out, RequestOutcome::Fresh("good".into()));
        assert_eq!(p.calls.get(), 2);
        assert_eq!(row(&conn, "r1").0, "done");
    }

    fn parse_num(t: &str) -> crate::Result<i64> {
        t.trim()
            .parse()
            .map_err(|e: std::num::ParseIntError| CoreError::EvalParse(e.to_string()))
    }

    #[test]
    fn json_corrective_retry_exactly_once() {
        let conn = crate::db::open_in_memory().unwrap();
        let p = CountingProvider::new(vec![Reply::Ok("not json"), Reply::Ok("42")]);
        let v = run_ai_json(&conn, &p, "r1", "test", &req(), &policy(), &parse_num).unwrap();
        assert_eq!(v, 42);
        assert_eq!(p.calls.get(), 2);
        let systems = p.systems.borrow();
        assert!(!systems[0].contains("请只输出"));
        assert!(
            systems[1].contains("请只输出满足要求的 JSON"),
            "{}",
            systems[1]
        );
        assert_eq!(row(&conn, "r1").0, "done");
    }

    #[test]
    fn semantic_reject_also_gets_one_corrective_retry() {
        let conn = crate::db::open_in_memory().unwrap();
        let p = CountingProvider::new(vec![Reply::Ok("1"), Reply::Ok("2")]);
        let parse = |t: &str| {
            let n = parse_num(t)?;
            if n == 1 {
                Err(CoreError::InvalidInput("cycle detected".into()))
            } else {
                Ok(n)
            }
        };
        let v = run_ai_json(&conn, &p, "r1", "test", &req(), &policy(), &parse).unwrap();
        assert_eq!(v, 2);
        assert!(p.systems.borrow()[1].contains("cycle detected"));
    }

    #[test]
    fn json_second_failure_gives_up() {
        let conn = crate::db::open_in_memory().unwrap();
        let p = CountingProvider::new(vec![Reply::Ok("bad"), Reply::Ok("bad"), Reply::Ok("3")]);
        let err = run_ai_json(&conn, &p, "r1", "test", &req(), &policy(), &parse_num).unwrap_err();
        assert!(matches!(err, CoreError::EvalParse(_)));
        assert_eq!(p.calls.get(), 2);
        assert_eq!(row(&conn, "r1").0, "failed");
    }

    #[test]
    fn failed_request_can_be_resumed_by_same_id() {
        let conn = crate::db::open_in_memory().unwrap();
        let p = CountingProvider::new(vec![Reply::Ai, Reply::Ai, Reply::Ai, Reply::Ok("x")]);
        assert!(run_ai_request(&conn, &p, "r1", "test", &req(), &policy(), &accept_all).is_err());
        let out = run_ai_request(&conn, &p, "r1", "test", &req(), &policy(), &accept_all).unwrap();
        assert_eq!(out, RequestOutcome::Fresh("x".into()));
        assert_eq!(row(&conn, "r1").1, 4);
    }

    #[test]
    fn replayed_result_rejected_by_parse_recalls_provider() {
        let conn = crate::db::open_in_memory().unwrap();
        let p = CountingProvider::new(vec![Reply::Ok("1"), Reply::Ok("2")]);
        assert_eq!(
            run_ai_json(&conn, &p, "r1", "test", &req(), &policy(), &parse_num).unwrap(),
            1
        );
        let stricter = |t: &str| {
            let n = parse_num(t)?;
            if n < 2 {
                Err(CoreError::InvalidInput("stale".into()))
            } else {
                Ok(n)
            }
        };
        assert_eq!(
            run_ai_json(&conn, &p, "r1", "test", &req(), &policy(), &stricter).unwrap(),
            2
        );
        assert_eq!(p.calls.get(), 2);
        assert_eq!(row(&conn, "r1").0, "done");
    }

    #[test]
    fn rejects_call_inside_transaction() {
        let conn = crate::db::open_in_memory().unwrap();
        let p = CountingProvider::new(vec![Reply::Ok("x")]);
        let tx = conn.unchecked_transaction().unwrap();
        let err =
            run_ai_request(&tx, &p, "r1", "test", &req(), &policy(), &accept_all).unwrap_err();
        assert!(
            matches!(err, CoreError::Other(ref m) if m.contains("transaction")),
            "{err}"
        );
        assert_eq!(p.calls.get(), 0);
    }

    #[test]
    fn request_id_validation() {
        assert!(validate_request_id("map:job-1:ch0").is_ok());
        for bad in ["", &"a".repeat(129), "has space", "中文"] {
            assert!(
                matches!(validate_request_id(bad), Err(CoreError::InvalidInput(_))),
                "{bad:?}"
            );
        }
        assert!(validate_client_id("turn_1.a-b").is_ok());
        for bad in ["", &"a".repeat(65), "a:b", "x/y"] {
            assert!(
                matches!(validate_client_id(bad), Err(CoreError::InvalidInput(_))),
                "{bad:?}"
            );
        }
        let conn = crate::db::open_in_memory().unwrap();
        let p = CountingProvider::new(vec![Reply::Ok("x")]);
        assert!(run_ai_request(&conn, &p, "bad id", "t", &req(), &policy(), &accept_all).is_err());
        assert_eq!(p.calls.get(), 0);
    }
}
