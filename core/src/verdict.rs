//! 评估请求与原子判定流转(ADR-0001/0002):`request_evaluation` 幂等且失败回 open;
//! `confirm_session_verdict` 单事务完成会话/块/薄弱点/复习/任务/outbox,用户判定覆盖 AI 建议,同 request_id 重放。

use crate::ai::{AiProvider, CompletionRequest};
use crate::eval::{parse_eval, EvalResult, Verdict};
use crate::orchestrate::{run_ai_json, validate_client_id, AiPolicy};
use crate::prompts::{self, FixedContext};
use crate::{CoreError, Result};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior};
use std::path::Path;

const EVAL_TIMEOUT_SECS: u64 = 120;

#[derive(Debug, Clone, PartialEq)]
pub struct EvaluationView {
    pub eval: EvalResult,
    pub version: i64,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct VerdictOutcome {
    pub passed: bool,
    pub block_status: String,
    pub task_done: bool,
    pub outbox_ops: usize,
    pub version: i64,
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

fn eval_request_id(session_id: i64, request_id: &str) -> String {
    format!("eval:{session_id}:{request_id}")
}

fn verdict_key(session_id: i64, request_id: &str) -> String {
    format!("verdict:{session_id}:{request_id}")
}

fn parse_stored_eval(json: &str) -> Result<EvalResult> {
    serde_json::from_str(json).map_err(|e| CoreError::Other(format!("corrupt eval_json: {e}")))
}

/// 渲染权威 transcript(仅 done 回合;学生文本剥离收尾标记)
fn render_transcript(conn: &Connection, session_id: i64) -> Result<String> {
    let mut st = conn.prepare(
        "SELECT role,text FROM session_turn WHERE session_id=?1 AND status='done' ORDER BY seq",
    )?;
    let lines: Vec<String> = st
        .query_map([session_id], |r| {
            let role: String = r.get(0)?;
            let text: String = r.get(1)?;
            Ok(if role == "student" {
                format!("学生:{}", crate::session::strip_ready(&text).0)
            } else {
                format!("用户:{text}")
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(lines.join("\n"))
}

/// 评估请求(语义见计划 A8)。`workdir` 为 codex 工作目录。
pub fn request_evaluation(
    conn: &Connection,
    provider: &dyn AiProvider,
    workdir: &Path,
    policy: &AiPolicy,
    session_id: i64,
    request_id: &str,
    ctx: &FixedContext,
) -> Result<EvaluationView> {
    validate_client_id(request_id)?;
    if !conn.is_autocommit() {
        return Err(CoreError::Other(
            "request_evaluation must not be called inside a transaction".into(),
        ));
    }
    let full_id = eval_request_id(session_id, request_id);
    // 短事务 A:状态检查与 open→evaluating
    let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate)?;
    let (state, version, eval_json): (String, i64, Option<String>) = tx
        .query_row(
            "SELECT state,version,eval_json FROM feynman_session WHERE id=?1",
            [session_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?
        .ok_or_else(|| CoreError::NotFound(format!("session {session_id}")))?;
    let existing_ids: Vec<String> = {
        let mut st = tx.prepare("SELECT request_id FROM ai_request WHERE request_id LIKE ?1")?;
        let rows = st.query_map([format!("eval:{session_id}:%")], |r| r.get(0))?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    match state.as_str() {
        "evaluated" => {
            let done: bool = tx
                .query_row(
                    "SELECT status='done' FROM ai_request WHERE request_id=?1",
                    [&full_id],
                    |r| r.get(0),
                )
                .optional()?
                .unwrap_or(false);
            return match (done, eval_json) {
                (true, Some(json)) => Ok(EvaluationView {
                    eval: parse_stored_eval(&json)?,
                    version,
                }),
                _ => Err(CoreError::Conflict(format!(
                    "session {session_id} was already evaluated by another request"
                ))),
            };
        }
        "open" => {}
        "evaluating" => {
            if !existing_ids.is_empty() && !existing_ids.iter().any(|id| id == &full_id) {
                return Err(CoreError::Conflict(format!(
                    "session {session_id} is being evaluated by another request"
                )));
            }
        }
        other => {
            return Err(CoreError::Conflict(format!(
                "session {session_id} is {other}"
            )))
        }
    }
    let pending: i64 = tx.query_row(
        "SELECT count(*) FROM session_turn WHERE session_id=?1 AND role='user' AND status='pending'",
        [session_id],
        |r| r.get(0),
    )?;
    if pending > 0 {
        return Err(CoreError::Conflict(
            "a user turn is still pending; finish or abandon it before evaluating".into(),
        ));
    }
    let user_turns: i64 = tx.query_row(
        "SELECT count(*) FROM session_turn WHERE session_id=?1 AND role='user' AND status='done'",
        [session_id],
        |r| r.get(0),
    )?;
    if user_turns == 0 {
        return Err(CoreError::Conflict(
            "nothing to evaluate: no user turns".into(),
        ));
    }
    tx.execute(
        "UPDATE feynman_session SET state='evaluating' WHERE id=?1 AND state='open'",
        [session_id],
    )?;
    let transcript = render_transcript(&tx, session_id)?;
    tx.commit()?;

    // 无事务调用 AI
    let req = CompletionRequest {
        system: prompts::eval_prompt(ctx, &transcript),
        messages: vec![],
        workdir: workdir.to_path_buf(),
        read_only: true,
        request_id: String::new(),
        timeout_secs: EVAL_TIMEOUT_SECS,
    };
    let result = run_ai_json(conn, provider, &full_id, "eval", &req, policy, &parse_eval);

    // 短事务 B:落库或回退
    let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate)?;
    match result {
        Ok(eval) => {
            let (state, version): (String, i64) = tx.query_row(
                "SELECT state,version FROM feynman_session WHERE id=?1",
                [session_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?;
            if state != "evaluating" {
                return Err(CoreError::Conflict(format!(
                    "session {session_id} is {state}; evaluation discarded"
                )));
            }
            let json = serde_json::to_string(&eval).map_err(|e| CoreError::Other(e.to_string()))?;
            tx.execute(
                "UPDATE feynman_session SET state='evaluated', eval_json=?2, version=?3 WHERE id=?1",
                rusqlite::params![session_id, json, version + 1],
            )?;
            tx.commit()?;
            Ok(EvaluationView {
                eval,
                version: version + 1,
            })
        }
        Err(e) => {
            tx.execute(
                "UPDATE feynman_session SET state='open' WHERE id=?1 AND state='evaluating'",
                [session_id],
            )?;
            tx.commit()?;
            Err(e)
        }
    }
}

/// 原子判定流转(语义见计划 A8 与 ADR-0002)。
pub fn confirm_session_verdict(
    conn: &Connection,
    session_id: i64,
    expected_version: i64,
    request_id: &str,
    pass: bool,
    date: &str,
) -> Result<VerdictOutcome> {
    validate_client_id(request_id)?;
    let key = verdict_key(session_id, request_id);
    let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate)?;
    #[allow(clippy::type_complexity)]
    let row: Option<(
        String,
        i64,
        i64,
        Option<i64>,
        Option<String>,
        Option<String>,
        Option<String>,
    )> = tx
        .query_row(
            "SELECT state,version,block_id,task_id,eval_json,verdict_request_id,verdict_json \
             FROM feynman_session WHERE id=?1",
            [session_id],
            |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                    r.get(6)?,
                ))
            },
        )
        .optional()?;
    let (state, version, block_id, task_id, eval_json, verdict_request_id, verdict_json) =
        row.ok_or_else(|| CoreError::NotFound(format!("session {session_id}")))?;
    if verdict_request_id.as_deref() == Some(key.as_str()) {
        let json = verdict_json
            .ok_or_else(|| CoreError::Other("confirmed session without verdict_json".into()))?;
        return serde_json::from_str(&json)
            .map_err(|e| CoreError::Other(format!("corrupt verdict_json: {e}")));
    }
    if state == "confirmed" {
        return Err(CoreError::Conflict(format!(
            "session {session_id} was already confirmed by another request"
        )));
    }
    if state != "evaluated" {
        return Err(CoreError::Conflict(format!(
            "session {session_id} is {state}, not evaluated"
        )));
    }
    if version != expected_version {
        return Err(CoreError::Conflict(format!(
            "session version is {version}, expected {expected_version}"
        )));
    }
    let eval = parse_stored_eval(
        eval_json
            .as_deref()
            .ok_or_else(|| CoreError::Other("evaluated session without eval_json".into()))?,
    )?;
    let task_id = task_id
        .ok_or_else(|| CoreError::Conflict(format!("session {session_id} has no daily task")))?;
    let (task_kind, ref_id): (String, Option<i64>) = tx
        .query_row(
            "SELECT kind,ref_id FROM daily_task WHERE id=?1",
            [task_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?
        .ok_or_else(|| CoreError::NotFound(format!("task {task_id}")))?;
    let (book_id, block_title): (i64, String) = tx.query_row(
        "SELECT book_id,title FROM knowledge_block WHERE id=?1",
        [block_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    let book_title: String =
        tx.query_row("SELECT title FROM book WHERE id=?1", [book_id], |r| {
            r.get(0)
        })?;

    let mut task_done = false;
    let mut mark_task_done = |tx: &Connection| -> Result<()> {
        tx.execute(
            "UPDATE daily_task SET status='done', done_at=?2 WHERE id=?1",
            rusqlite::params![task_id, now()],
        )?;
        task_done = true;
        Ok(())
    };
    match task_kind.as_str() {
        "new" => {
            let verdict = if pass {
                Verdict::PassSuggested
            } else {
                Verdict::RelearnSuggested
            };
            crate::sched::apply_eval_in_tx(&tx, block_id, &eval, verdict, date)?;
            if pass {
                mark_task_done(&tx)?;
            }
        }
        "weak_retest" => {
            let weak_id = ref_id.ok_or_else(|| {
                CoreError::Other(format!("weak_retest task {task_id} without ref_id"))
            })?;
            // 评估中暴露的新薄弱点也落库(去重),再推进被重考的那条
            crate::sched::insert_new_weak_points(&tx, block_id, &eval, date)?;
            crate::sched::on_weak_retest(&tx, weak_id, pass, date)?;
            mark_task_done(&tx)?;
        }
        "review" => {
            let sched_id = ref_id
                .ok_or_else(|| CoreError::Other(format!("review task {task_id} without ref_id")))?;
            let specific = crate::sched::insert_new_weak_points(&tx, block_id, &eval, date)?;
            crate::sched::on_review_result_with(&tx, sched_id, pass, date, specific > 0)?;
            mark_task_done(&tx)?;
        }
        other => {
            return Err(CoreError::Other(format!(
                "corrupt daily_task.kind {other:?}"
            )))
        }
    }
    let block_status: String = tx.query_row(
        "SELECT status FROM knowledge_block WHERE id=?1",
        [block_id],
        |r| r.get(0),
    )?;

    let mut outbox_ops = 0usize;
    let mut enqueue = |kind: &str, payload: serde_json::Value| -> Result<()> {
        crate::projection::enqueue(&tx, &format!("{key}:{kind}"), kind, &payload)?;
        outbox_ops += 1;
        Ok(())
    };
    if task_kind == "new" {
        enqueue(
            "block_eval",
            serde_json::json!({
                "book_id": book_id,
                "block_id": block_id,
                "eval": eval,
                "passed": pass,
                "date": date,
                "entry_key": format!("{key}:block_eval"),
            }),
        )?;
    }
    enqueue("sync_weakpoints", serde_json::json!({ "book_id": book_id }))?;
    enqueue("sync_map", serde_json::json!({ "book_id": book_id }))?;
    enqueue(
        "git_commit",
        serde_json::json!({ "message": format!("study: {book_title}/{block_title} {date}") }),
    )?;

    let outcome = VerdictOutcome {
        passed: pass,
        block_status,
        task_done,
        outbox_ops,
        version: version + 1,
    };
    let json = serde_json::to_string(&outcome).map_err(|e| CoreError::Other(e.to_string()))?;
    tx.execute(
        "UPDATE feynman_session SET state='confirmed', version=?2, verdict_request_id=?3, \
         verdict_json=?4, ended_at=?5 WHERE id=?1",
        rusqlite::params![session_id, version + 1, key, json, now()],
    )?;
    tx.commit()?;
    Ok(outcome)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::{AiProvider, CompletionRequest};
    use crate::orchestrate::AiPolicy;
    use crate::prompts::FixedContext;
    use crate::CoreError;
    use rusqlite::Connection;
    use std::cell::{Cell, RefCell};

    const DAY0: &str = "2026-09-05";
    const DAY1: &str = "2026-09-06";
    const EVAL_PASS: &str = r#"{"verdict":"pass_suggested","scores":{"accuracy":4,"completeness":4,"clarity":5},
        "summary":"讲解到位","weak_points":[{"title":"弹性vs斜率","detail":"未完全修复"}],
        "final_restatement":"弹性是相对变化率","observation_note":"举例能力强"}"#;
    const EVAL_RELEARN: &str = r#"{"verdict":"relearn_suggested","scores":{"accuracy":2,"completeness":2,"clarity":3},
        "summary":"跳步","final_restatement":"r"}"#;

    struct Mock {
        eval_reply: RefCell<String>,
        fail_eval: Cell<bool>,
        eval_calls: Cell<usize>,
    }
    impl Mock {
        fn new(eval_reply: &str) -> Self {
            Self {
                eval_reply: RefCell::new(eval_reply.into()),
                fail_eval: Cell::new(false),
                eval_calls: Cell::new(0),
            }
        }
    }
    impl AiProvider for Mock {
        fn complete(&self, req: &CompletionRequest) -> crate::Result<String> {
            if req.request_id.starts_with("eval:") {
                self.eval_calls.set(self.eval_calls.get() + 1);
                if self.fail_eval.get() {
                    return Err(CoreError::Ai("timeout".into()));
                }
                Ok(self.eval_reply.borrow().clone())
            } else {
                Ok("为什么?".into())
            }
        }
    }
    fn policy() -> AiPolicy {
        AiPolicy {
            retry_backoff_ms: 0,
            ..AiPolicy::default()
        }
    }
    fn ctx() -> FixedContext {
        FixedContext {
            profile_summary: String::new(),
            block_title: "供需弹性".into(),
            block_source_text: "原文".into(),
            eval_history: String::new(),
            related_weakpoints: String::new(),
            prereq_status: String::new(),
        }
    }
    fn workdir() -> std::path::PathBuf {
        std::env::temp_dir()
    }
    /// 建书 + 2 块 + 计划;返回 (book, b1, b2)
    fn seed(conn: &Connection) -> (i64, i64, i64) {
        let book = crate::models::insert_book(
            conn,
            "微观经济学",
            "",
            crate::models::BookType::Textbook,
            "microecon",
        )
        .unwrap();
        let b1 =
            crate::models::insert_block(conn, book, "m", 1, "供需弹性", "elasticity", &[]).unwrap();
        let b2 = crate::models::insert_block(conn, book, "m", 2, "消费者剩余", "surplus", &[b1])
            .unwrap();
        conn.execute(
            "INSERT INTO study_plan(book_id,deadline,daily_new_blocks) VALUES(?1,'2026-09-30',1)",
            [book],
        )
        .unwrap();
        (book, b1, b2)
    }
    /// 今日队列首任务 → 开会话 → 讲一轮;返回 (session_id, task_id, version)
    fn session_with_turn(conn: &Connection, mock: &Mock, day: &str) -> (i64, i64, i64) {
        let q = crate::sched::generate_daily(conn, day).unwrap();
        let s = crate::session::start_or_resume_session(
            conn,
            q[0].id,
            &format!("start-{}", q[0].id),
            day,
        )
        .unwrap();
        let r = crate::session::submit_turn(
            conn,
            mock,
            &workdir(),
            &policy(),
            s.session_id,
            s.version,
            "t1",
            "弹性是相对变化率",
            &ctx(),
            crate::models::BookType::Textbook,
        )
        .unwrap();
        (s.session_id, q[0].id, r.version)
    }
    fn evaluate(
        conn: &Connection,
        mock: &Mock,
        sid: i64,
        rid: &str,
    ) -> crate::Result<EvaluationView> {
        request_evaluation(conn, mock, &workdir(), &policy(), sid, rid, &ctx())
    }
    fn state(conn: &Connection, sid: i64) -> (String, i64) {
        conn.query_row(
            "SELECT state,version FROM feynman_session WHERE id=?1",
            [sid],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap()
    }
    fn count(conn: &Connection, sql: &str) -> i64 {
        conn.query_row(sql, [], |r| r.get(0)).unwrap()
    }
    fn block_row(conn: &Connection, id: i64) -> (String, Option<String>) {
        conn.query_row(
            "SELECT status,passed_at FROM knowledge_block WHERE id=?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap()
    }
    fn outbox(conn: &Connection) -> Vec<(String, String, String)> {
        let mut st = conn
            .prepare("SELECT op_id,kind,payload FROM projection_outbox ORDER BY id")
            .unwrap();
        st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap()
    }

    #[test]
    fn evaluation_is_idempotent_and_bumps_version() {
        let conn = crate::db::open_in_memory().unwrap();
        seed(&conn);
        let mock = Mock::new(EVAL_PASS);
        let (sid, _, v) = session_with_turn(&conn, &mock, DAY0);
        assert_eq!(v, 1);
        let e = evaluate(&conn, &mock, sid, "e1").unwrap();
        assert_eq!(e.eval.verdict, crate::eval::Verdict::PassSuggested);
        assert_eq!(e.version, 2);
        assert_eq!(state(&conn, sid), ("evaluated".into(), 2));
        let again = evaluate(&conn, &mock, sid, "e1").unwrap();
        assert_eq!(again, e);
        assert_eq!(mock.eval_calls.get(), 1);
        assert!(matches!(
            evaluate(&conn, &mock, sid, "e2").unwrap_err(),
            CoreError::Conflict(_)
        ));
        let view = crate::session::get_session(&conn, sid).unwrap();
        assert_eq!(view.eval, Some(e.eval));
    }

    #[test]
    fn evaluation_failure_returns_to_open_and_same_id_retries() {
        let conn = crate::db::open_in_memory().unwrap();
        seed(&conn);
        let mock = Mock::new(EVAL_PASS);
        let (sid, _, _) = session_with_turn(&conn, &mock, DAY0);
        mock.fail_eval.set(true);
        assert!(matches!(
            evaluate(&conn, &mock, sid, "e1").unwrap_err(),
            CoreError::Ai(_)
        ));
        assert_eq!(state(&conn, sid), ("open".into(), 1));
        mock.fail_eval.set(false);
        assert_eq!(evaluate(&conn, &mock, sid, "e1").unwrap().version, 2);
    }

    #[test]
    fn evaluating_state_recovery() {
        let conn = crate::db::open_in_memory().unwrap();
        seed(&conn);
        let mock = Mock::new(EVAL_PASS);
        let (sid, _, _) = session_with_turn(&conn, &mock, DAY0);
        // 崩溃在 state→evaluating 之后、ai_request 写入之前:无任何 eval 行 → 用本次 id 续跑
        conn.execute(
            "UPDATE feynman_session SET state='evaluating' WHERE id=?1",
            [sid],
        )
        .unwrap();
        let first = evaluate(&conn, &mock, sid, "e1").unwrap();
        assert_eq!(first.version, 2);
        // 已有其它 id 的 eval 行 → Conflict
        conn.execute(
            "UPDATE feynman_session SET state='evaluating' WHERE id=?1",
            [sid],
        )
        .unwrap();
        assert!(matches!(
            evaluate(&conn, &mock, sid, "e9").unwrap_err(),
            CoreError::Conflict(_)
        ));
        // 同 id 续跑:ai_request 已 done → 不再调 provider;事务 B 重做(状态回 evaluated,版本再 +1)
        let resumed = evaluate(&conn, &mock, sid, "e1").unwrap();
        assert_eq!(resumed.eval, first.eval);
        assert_eq!(resumed.version, 3);
        assert_eq!(state(&conn, sid).0, "evaluated");
        assert_eq!(mock.eval_calls.get(), 1);
    }

    #[test]
    fn evaluation_requires_user_turn_and_no_pending() {
        let conn = crate::db::open_in_memory().unwrap();
        seed(&conn);
        let mock = Mock::new(EVAL_PASS);
        let q = crate::sched::generate_daily(&conn, DAY0).unwrap();
        let s = crate::session::start_or_resume_session(&conn, q[0].id, "s1", DAY0).unwrap();
        assert!(matches!(
            evaluate(&conn, &mock, s.session_id, "e1").unwrap_err(),
            CoreError::Conflict(_)
        ));
        conn.execute(
            "INSERT INTO session_turn(session_id,seq,role,text,client_turn_id,status,created_at) VALUES(?1,1,'user','x','t1','pending','t')",
            [s.session_id],
        )
        .unwrap();
        let err = evaluate(&conn, &mock, s.session_id, "e1").unwrap_err();
        assert!(
            matches!(&err, CoreError::Conflict(m) if m.contains("pending")),
            "{err}"
        );
        assert_eq!(state(&conn, s.session_id).0, "open");
        assert!(matches!(
            evaluate(&conn, &mock, s.session_id, "bad id").unwrap_err(),
            CoreError::InvalidInput(_)
        ));
    }

    #[test]
    fn confirm_requires_evaluated_state() {
        let conn = crate::db::open_in_memory().unwrap();
        seed(&conn);
        let mock = Mock::new(EVAL_PASS);
        let (sid, _, v) = session_with_turn(&conn, &mock, DAY0);
        let err = confirm_session_verdict(&conn, sid, v, "c1", true, DAY0).unwrap_err();
        assert!(matches!(err, CoreError::Conflict(_)));
        assert!(matches!(
            confirm_session_verdict(&conn, 999, 0, "c1", true, DAY0).unwrap_err(),
            CoreError::NotFound(_)
        ));
    }

    #[test]
    fn pass_flow_for_new_task() {
        let conn = crate::db::open_in_memory().unwrap();
        let (book, b1, _) = seed(&conn);
        let mock = Mock::new(EVAL_PASS);
        let (sid, task, _) = session_with_turn(&conn, &mock, DAY0);
        let e = evaluate(&conn, &mock, sid, "e1").unwrap();
        assert!(matches!(
            confirm_session_verdict(&conn, sid, e.version + 5, "c1", true, DAY0).unwrap_err(),
            CoreError::Conflict(_)
        ));
        let out = confirm_session_verdict(&conn, sid, e.version, "c1", true, DAY0).unwrap();
        assert_eq!(
            out,
            VerdictOutcome {
                passed: true,
                block_status: "passed".into(),
                task_done: true,
                outbox_ops: 4,
                version: e.version + 1
            }
        );
        assert_eq!(block_row(&conn, b1), ("passed".into(), Some(DAY0.into())));
        assert_eq!(
            count(
                &conn,
                "SELECT count(*) FROM review_schedule WHERE stage=1 AND status='due'"
            ),
            1
        );
        assert_eq!(
            count(&conn, "SELECT count(*) FROM weak_point WHERE status='open'"),
            1
        );
        let task_status: String = conn
            .query_row("SELECT status FROM daily_task WHERE id=?1", [task], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(task_status, "done");
        assert_eq!(state(&conn, sid), ("confirmed".into(), e.version + 1));
        let ob = outbox(&conn);
        let kinds: Vec<_> = ob.iter().map(|o| o.1.as_str()).collect();
        assert_eq!(
            kinds,
            ["block_eval", "sync_weakpoints", "sync_map", "git_commit"]
        );
        assert_eq!(ob[0].0, format!("verdict:{sid}:c1:block_eval"));
        let payload: serde_json::Value = serde_json::from_str(&ob[0].2).unwrap();
        assert_eq!(payload["passed"], true);
        assert_eq!(payload["block_id"], b1);
        assert_eq!(payload["book_id"], book);
        assert_eq!(payload["entry_key"], format!("verdict:{sid}:c1:block_eval"));
        assert!(payload["eval"]["final_restatement"]
            .as_str()
            .unwrap()
            .contains("相对变化率"));
        let git: serde_json::Value = serde_json::from_str(&ob[3].2).unwrap();
        assert!(git["message"]
            .as_str()
            .unwrap()
            .contains("微观经济学/供需弹性"));
    }

    #[test]
    fn relearn_flow_keeps_task_pending_and_requeues_next_day() {
        let conn = crate::db::open_in_memory().unwrap();
        let (_, b1, _) = seed(&conn);
        let mock = Mock::new(EVAL_PASS); // AI 建议通过,用户判定重学
        let (sid, task, _) = session_with_turn(&conn, &mock, DAY0);
        let e = evaluate(&conn, &mock, sid, "e1").unwrap();
        let out = confirm_session_verdict(&conn, sid, e.version, "c1", false, DAY0).unwrap();
        assert_eq!(
            (
                out.passed,
                out.block_status.as_str(),
                out.task_done,
                out.outbox_ops
            ),
            (false, "learning", false, 4)
        );
        assert_eq!(block_row(&conn, b1), ("learning".into(), None));
        assert_eq!(count(&conn, "SELECT count(*) FROM review_schedule"), 0);
        let task_status: String = conn
            .query_row("SELECT status FROM daily_task WHERE id=?1", [task], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(task_status, "pending");
        let payload: serde_json::Value = serde_json::from_str(&outbox(&conn)[0].2).unwrap();
        assert_eq!(payload["passed"], false);
        // 次日队列:薄弱点重考(eval 的未修复薄弱点)+ 该块仍以 new 入队
        let q1 = crate::sched::generate_daily(&conn, DAY1).unwrap();
        let kinds: Vec<_> = q1.iter().map(|t| (t.kind.as_str(), t.block_id)).collect();
        assert_eq!(kinds, [("weak_retest", b1), ("new", b1)]);
    }

    #[test]
    fn user_verdict_overrides_ai_suggestion() {
        let conn = crate::db::open_in_memory().unwrap();
        let (_, b1, _) = seed(&conn);
        let mock = Mock::new(EVAL_RELEARN);
        let (sid, _, _) = session_with_turn(&conn, &mock, DAY0);
        let e = evaluate(&conn, &mock, sid, "e1").unwrap();
        assert_eq!(e.eval.verdict, crate::eval::Verdict::RelearnSuggested);
        let out = confirm_session_verdict(&conn, sid, e.version, "c1", true, DAY0).unwrap();
        assert!(out.passed && out.block_status == "passed");
        assert_eq!(block_row(&conn, b1).0, "passed");
        assert_eq!(
            count(&conn, "SELECT count(*) FROM review_schedule WHERE stage=1"),
            1
        );
    }

    /// 让块 b1 在 DAY0 通过并带一个薄弱点(不经会话),供次日 weak_retest/review 用例
    fn pass_b1_on_day0(conn: &Connection, b1: i64) {
        let e = crate::eval::parse_eval(EVAL_PASS).unwrap();
        crate::sched::apply_eval_to_db(conn, b1, &e, DAY0).unwrap();
    }

    #[test]
    fn weak_retest_task_only_routes_to_on_weak_retest() {
        let conn = crate::db::open_in_memory().unwrap();
        let (_, b1, _) = seed(&conn);
        pass_b1_on_day0(&conn, b1);
        let mock = Mock::new(EVAL_RELEARN); // 评估内容不得改块状态
        let (sid, task, _) = session_with_turn(&conn, &mock, DAY1);
        let kind: String = conn
            .query_row("SELECT kind FROM daily_task WHERE id=?1", [task], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(kind, "weak_retest");
        let e = evaluate(&conn, &mock, sid, "e1").unwrap();
        let out = confirm_session_verdict(&conn, sid, e.version, "c1", true, DAY1).unwrap();
        assert_eq!(
            (
                out.passed,
                out.block_status.as_str(),
                out.task_done,
                out.outbox_ops
            ),
            (true, "passed", true, 3)
        );
        assert_eq!(
            block_row(&conn, b1),
            ("passed".into(), Some(DAY0.into())),
            "块状态/passed_at 不变"
        );
        assert_eq!(
            count(&conn, "SELECT count(*) FROM weak_point"),
            1,
            "不写 eval 薄弱点"
        );
        let streak: i64 = conn
            .query_row("SELECT pass_streak FROM weak_point", [], |r| r.get(0))
            .unwrap();
        assert_eq!(streak, 1);
        let kinds: Vec<_> = outbox(&conn).iter().map(|o| o.1.clone()).collect();
        assert_eq!(kinds, ["sync_weakpoints", "sync_map", "git_commit"]);
        let task_status: String = conn
            .query_row("SELECT status FROM daily_task WHERE id=?1", [task], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(task_status, "done");
    }

    #[test]
    fn review_task_fail_resets_schedule_without_touching_block() {
        let conn = crate::db::open_in_memory().unwrap();
        let (_, b1, _) = seed(&conn);
        pass_b1_on_day0(&conn, b1);
        conn.execute("UPDATE weak_point SET status='fixed'", [])
            .unwrap(); // 只剩 review 任务
        let mock = Mock::new(EVAL_PASS);
        let (sid, task, _) = session_with_turn(&conn, &mock, DAY1);
        let kind: String = conn
            .query_row("SELECT kind FROM daily_task WHERE id=?1", [task], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(kind, "review");
        let e = evaluate(&conn, &mock, sid, "e1").unwrap();
        let out = confirm_session_verdict(&conn, sid, e.version, "c1", false, DAY1).unwrap();
        assert!(!out.passed && out.task_done && out.outbox_ops == 3);
        assert_eq!(block_row(&conn, b1), ("passed".into(), Some(DAY0.into())));
        assert_eq!(
            count(
                &conn,
                "SELECT count(*) FROM review_schedule WHERE status='failed'"
            ),
            1
        );
        let (stage, due): (i64, String) = conn
            .query_row(
                "SELECT stage,due_date FROM review_schedule WHERE status='due'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!((stage, due.as_str()), (1, "2026-09-07"));
        assert_eq!(
            count(&conn, "SELECT count(*) FROM weak_point WHERE status='open'"),
            1,
            "仅 on_review_result 产生的 1 条"
        );
    }

    #[test]
    fn double_confirm_same_request_is_idempotent() {
        let conn = crate::db::open_in_memory().unwrap();
        seed(&conn);
        let mock = Mock::new(EVAL_PASS);
        let (sid, _, _) = session_with_turn(&conn, &mock, DAY0);
        let e = evaluate(&conn, &mock, sid, "e1").unwrap();
        let a = confirm_session_verdict(&conn, sid, e.version, "c1", true, DAY0).unwrap();
        let b = confirm_session_verdict(&conn, sid, e.version, "c1", true, DAY0).unwrap();
        let c = confirm_session_verdict(&conn, sid, 999, "c1", false, DAY0).unwrap();
        assert_eq!(a, b);
        assert_eq!(a, c, "同 request_id 重放不看版本与 pass");
        assert_eq!(count(&conn, "SELECT count(*) FROM review_schedule"), 1);
        assert_eq!(count(&conn, "SELECT count(*) FROM projection_outbox"), 4);
        assert_eq!(count(&conn, "SELECT count(*) FROM weak_point"), 1);
        assert!(matches!(
            confirm_session_verdict(&conn, sid, a.version, "c2", true, DAY0).unwrap_err(),
            CoreError::Conflict(_)
        ));
    }
}
