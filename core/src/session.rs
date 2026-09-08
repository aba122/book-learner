//! 持久化费曼会话与幂等回合(ADR-0002):一任务一未确认会话、服务端权威 transcript(`session_turn`)、
//! 回合协议(先按 client_turn_id 查重放/续跑;事务 A 写 pending 不 bump 版本;无事务调 AI;事务 B 落库 +1)。

use crate::ai::{AiProvider, CompletionRequest, Role};
use crate::eval::EvalResult;
use crate::models::BookType;
use crate::orchestrate::{run_ai_request, validate_client_id, AiPolicy};
use crate::prompts::{self, FixedContext};
use crate::{CoreError, Result};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior};
use std::path::Path;

/// 学生回复末尾的收尾标记(TECH_DESIGN §6.2);存库保留原文,输出时剥离
pub const READY_MARKER: &str = "[READY_TO_END]";
/// 固定注入原文的字节上限(超过在字符边界截断并标注)
pub const SOURCE_TEXT_LIMIT_BYTES: usize = 60 * 1024;
/// 对话轮次超时(TECH_DESIGN §5.1)
const TURN_TIMEOUT_SECS: u64 = 120;
const UNCONFIRMED_STATES: &str = "('open','evaluating','evaluated')";

#[derive(Debug, Clone, PartialEq)]
pub struct TurnView {
    pub role: String,
    /// 学生回复已剥离 [READY_TO_END]
    pub text: String,
    pub status: String,
    pub client_turn_id: Option<String>,
    pub ready_to_end: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SessionView {
    pub session_id: i64,
    /// 旧库(v3 前)会话无任务关联时为 0
    pub task_id: i64,
    pub version: i64,
    pub state: String,
    pub block_id: i64,
    pub kind: String,
    pub transcript: Vec<TurnView>,
    pub eval: Option<EvalResult>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TurnResult {
    pub student_text: String,
    pub ready_to_end: bool,
    pub version: i64,
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

/// 剥离收尾标记:返回 (干净文本, 是否 ready)
pub fn strip_ready(text: &str) -> (String, bool) {
    if text.contains(READY_MARKER) {
        (text.replace(READY_MARKER, "").trim().to_string(), true)
    } else {
        (text.trim().to_string(), false)
    }
}

fn session_state(conn: &Connection, session_id: i64) -> Result<(String, i64)> {
    conn.query_row(
        "SELECT state,version FROM feynman_session WHERE id=?1",
        [session_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .optional()?
    .ok_or_else(|| CoreError::NotFound(format!("session {session_id}")))
}

pub fn get_session(conn: &Connection, session_id: i64) -> Result<SessionView> {
    let (task_id, version, state, block_id, kind, eval_json): (
        Option<i64>,
        i64,
        String,
        i64,
        String,
        Option<String>,
    ) = conn
        .query_row(
            "SELECT task_id,version,state,block_id,kind,eval_json FROM feynman_session WHERE id=?1",
            [session_id],
            |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(|| CoreError::NotFound(format!("session {session_id}")))?;
    let mut st = conn.prepare(
        "SELECT role,text,status,client_turn_id FROM session_turn WHERE session_id=?1 ORDER BY seq",
    )?;
    let transcript = st
        .query_map([session_id], |r| {
            let role: String = r.get(0)?;
            let raw: String = r.get(1)?;
            let (text, ready) = if role == "student" {
                strip_ready(&raw)
            } else {
                (raw, false)
            };
            Ok(TurnView {
                role,
                text,
                status: r.get(2)?,
                client_turn_id: r.get(3)?,
                ready_to_end: ready,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let eval = match eval_json {
        Some(json) => Some(
            serde_json::from_str(&json)
                .map_err(|e| CoreError::Other(format!("corrupt eval_json: {e}")))?,
        ),
        None => None,
    };
    Ok(SessionView {
        session_id,
        task_id: task_id.unwrap_or(0),
        version,
        state,
        block_id,
        kind,
        transcript,
        eval,
    })
}

/// 返回该任务唯一未确认会话(存在则 resume);`client_request_id` 幂等。
/// 任务不存在或不属于 `date` → NotFound;任务已 done/skipped → Conflict。
pub fn start_or_resume_session(
    conn: &Connection,
    task_id: i64,
    client_request_id: &str,
    date: &str,
) -> Result<SessionView> {
    validate_client_id(client_request_id)?;
    let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate)?;
    if let Some(sid) = tx
        .query_row(
            "SELECT id FROM feynman_session WHERE client_request_id=?1",
            [client_request_id],
            |r| r.get::<_, i64>(0),
        )
        .optional()?
    {
        let view = get_session(&tx, sid)?;
        tx.commit()?;
        return Ok(view);
    }
    let (task_date, block_id, task_kind, status): (String, i64, String, String) = tx
        .query_row(
            "SELECT date,block_id,kind,status FROM daily_task WHERE id=?1",
            [task_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()?
        .ok_or_else(|| CoreError::NotFound(format!("task {task_id}")))?;
    if task_date != date {
        return Err(CoreError::NotFound(format!(
            "task {task_id} is not in the queue of {date}"
        )));
    }
    if status != "pending" {
        return Err(CoreError::Conflict(format!("task {task_id} is {status}")));
    }
    if let Some(sid) = tx
        .query_row(
            &format!(
                "SELECT id FROM feynman_session WHERE task_id=?1 AND state IN {UNCONFIRMED_STATES}"
            ),
            [task_id],
            |r| r.get::<_, i64>(0),
        )
        .optional()?
    {
        let view = get_session(&tx, sid)?;
        tx.commit()?;
        return Ok(view);
    }
    let kind = match task_kind.as_str() {
        "new" => "learn",
        "weak_retest" => "retest",
        "review" => "review",
        other => {
            return Err(CoreError::Other(format!(
                "corrupt daily_task.kind {other:?}"
            )))
        }
    };
    tx.execute(
        "INSERT INTO feynman_session(block_id,kind,started_at,task_id,state,version,client_request_id) \
         VALUES(?1,?2,?3,?4,'open',0,?5)",
        rusqlite::params![block_id, kind, now(), task_id, client_request_id],
    )?;
    let sid = tx.last_insert_rowid();
    let view = get_session(&tx, sid)?;
    tx.commit()?;
    Ok(view)
}

fn truncate_at_char_boundary(text: &str, limit: usize) -> String {
    if text.len() <= limit {
        return text.to_string();
    }
    let mut end = limit;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n(原文过长,已截断)", &text[..end])
}

/// 固定注入上下文(TECH_DESIGN §3.2)由 DB 组装;`profile_summary` 由调用方提供(来自 memory/profile.md)。
pub fn fixed_context_for_block(
    conn: &Connection,
    block_id: i64,
    profile_summary: &str,
) -> Result<FixedContext> {
    let block = crate::models::get_block(conn, block_id)?;
    let chapters = crate::mapgen::list_spine(conn, block.book_id)?;
    let mut source = String::new();
    let mut used_chapters: Vec<String> = vec![];
    for seg in crate::map::list_anchors(conn, block_id)? {
        let piece = if !seg.text.trim().is_empty() {
            seg.text.clone()
        } else if used_chapters.contains(&seg.spine_href) {
            continue;
        } else {
            used_chapters.push(seg.spine_href.clone());
            chapters
                .iter()
                .find(|c| c.href == seg.spine_href)
                .map(|c| c.text.clone())
                .unwrap_or_default()
        };
        if piece.is_empty() {
            continue;
        }
        if !source.is_empty() {
            source.push_str("\n\n");
        }
        source.push_str(&piece);
    }
    let block_source_text = truncate_at_char_boundary(&source, SOURCE_TEXT_LIMIT_BYTES);

    let mut st = conn.prepare(
        "SELECT started_at,eval_json FROM feynman_session \
         WHERE block_id=?1 AND eval_json IS NOT NULL ORDER BY started_at,id",
    )?;
    let evals: Vec<(String, String)> = st
        .query_map([block_id], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let mut history = vec![];
    for (i, (started, json)) in evals.iter().enumerate() {
        let date: String = started.chars().take(10).collect();
        match serde_json::from_str::<EvalResult>(json) {
            Ok(e) => {
                let verdict = match e.verdict {
                    crate::eval::Verdict::PassSuggested => "通过建议",
                    crate::eval::Verdict::RelearnSuggested => "重学建议",
                };
                history.push(format!("- {date} 第{}次:{verdict};{}", i + 1, e.summary));
            }
            Err(_) => history.push(format!("- {date} 第{}次:(评估记录损坏)", i + 1)),
        }
    }

    let mut st = conn.prepare(
        "SELECT title,detail FROM weak_point WHERE block_id=?1 AND status='open' ORDER BY created_at",
    )?;
    let weak: Vec<String> = st
        .query_map([block_id], |r| {
            let (t, d): (String, String) = (r.get(0)?, r.get(1)?);
            Ok(if d.is_empty() {
                format!("- {t}")
            } else {
                format!("- {t}:{d}")
            })
        })?
        .collect::<rusqlite::Result<_>>()?;

    let mut prereq = vec![];
    for pid in &block.prereq_ids {
        if let Ok(p) = crate::models::get_block(conn, *pid) {
            prereq.push(format!("- {}:{}", p.title, p.status));
        }
    }
    Ok(FixedContext {
        profile_summary: profile_summary.to_string(),
        block_title: block.title,
        block_source_text,
        eval_history: history.join("\n"),
        related_weakpoints: weak.join("\n"),
        prereq_status: prereq.join("\n"),
    })
}

fn student_reply_at(conn: &Connection, session_id: i64, seq: i64) -> Result<String> {
    conn.query_row(
        "SELECT text FROM session_turn WHERE session_id=?1 AND seq=?2 AND role='student'",
        [session_id, seq],
        |r| r.get(0),
    )
    .optional()?
    .ok_or_else(|| {
        CoreError::Other(format!(
            "corrupt session {session_id}: done user turn {seq} without student reply"
        ))
    })
}

fn replay(conn: &Connection, session_id: i64, user_seq: i64) -> Result<TurnResult> {
    let raw = student_reply_at(conn, session_id, user_seq + 1)?;
    let (student_text, ready_to_end) = strip_ready(&raw);
    let (_, version) = session_state(conn, session_id)?;
    Ok(TurnResult {
        student_text,
        ready_to_end,
        version,
    })
}

/// 回合协议见模块文档与 ADR-0002。`workdir` 为 codex 工作目录(记忆库根)。
#[allow(clippy::too_many_arguments)]
pub fn submit_turn(
    conn: &Connection,
    provider: &dyn AiProvider,
    workdir: &Path,
    policy: &AiPolicy,
    session_id: i64,
    expected_version: i64,
    client_turn_id: &str,
    user_text: &str,
    ctx: &FixedContext,
    ty: BookType,
) -> Result<TurnResult> {
    validate_client_id(client_turn_id)?;
    if !conn.is_autocommit() {
        return Err(CoreError::Other(
            "submit_turn must not be called inside a transaction".into(),
        ));
    }
    let user_text = user_text.trim();
    if user_text.is_empty() {
        return Err(CoreError::InvalidInput("empty user turn".into()));
    }
    // ① 同 client_turn_id:done → 重放;pending → 续跑
    let existing: Option<(i64, i64, String)> = conn
        .query_row(
            "SELECT id,seq,status FROM session_turn \
             WHERE session_id=?1 AND client_turn_id=?2 AND role='user'",
            rusqlite::params![session_id, client_turn_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    let (user_turn_id, user_seq) = match existing {
        Some((_, seq, status)) if status == "done" => return replay(conn, session_id, seq),
        Some((id, seq, _)) => (id, seq),
        None => {
            // ② 事务 A:校验并写 pending user turn(不 bump 版本)
            let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate)?;
            let (state, version) = session_state(&tx, session_id)?;
            if state != "open" {
                return Err(CoreError::Conflict(format!(
                    "session {session_id} is {state}"
                )));
            }
            let pending: Option<String> = tx
                .query_row(
                    "SELECT client_turn_id FROM session_turn \
                     WHERE session_id=?1 AND role='user' AND status='pending'",
                    [session_id],
                    |r| r.get(0),
                )
                .optional()?;
            if let Some(id) = pending {
                return Err(CoreError::Conflict(format!(
                    "a turn is still pending; retry it with client_turn_id {id}"
                )));
            }
            if version != expected_version {
                return Err(CoreError::Conflict(format!(
                    "session version is {version}, expected {expected_version}"
                )));
            }
            let next_seq: i64 = tx.query_row(
                "SELECT COALESCE(max(seq),0)+1 FROM session_turn WHERE session_id=?1",
                [session_id],
                |r| r.get(0),
            )?;
            tx.execute(
                "INSERT INTO session_turn(session_id,seq,role,text,client_turn_id,status,created_at) \
                 VALUES(?1,?2,'user',?3,?4,'pending',?5)",
                rusqlite::params![session_id, next_seq, user_text, client_turn_id, now()],
            )?;
            let id = tx.last_insert_rowid();
            tx.commit()?;
            (id, next_seq)
        }
    };
    // ③ 无事务调用 AI:messages = 已 done 回合 + 本 user 回合
    let mut st = conn.prepare(
        "SELECT role,text FROM session_turn WHERE session_id=?1 AND seq<=?2 \
         AND (status='done' OR id=?3) ORDER BY seq",
    )?;
    let messages: Vec<(Role, String)> = st
        .query_map(rusqlite::params![session_id, user_seq, user_turn_id], |r| {
            let role: String = r.get(0)?;
            let text: String = r.get(1)?;
            Ok((
                if role == "student" {
                    Role::Assistant
                } else {
                    Role::User
                },
                text,
            ))
        })?
        .collect::<rusqlite::Result<_>>()?;
    drop(st);
    let req = CompletionRequest {
        system: prompts::feynman_system(ty, ctx),
        messages,
        workdir: workdir.to_path_buf(),
        read_only: true,
        request_id: String::new(),
        timeout_secs: TURN_TIMEOUT_SECS,
    };
    let accept = |text: &str| {
        if text.trim().is_empty() {
            Err(CoreError::Ai("empty student reply".into()))
        } else {
            Ok(())
        }
    };
    let raw = run_ai_request(
        conn,
        provider,
        &format!("turn:{session_id}:{client_turn_id}"),
        "turn",
        &req,
        policy,
        &accept,
    )?
    .into_text();
    // ④ 事务 B:落库学生回复,version+1
    let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate)?;
    let (state, version) = session_state(&tx, session_id)?;
    if state != "open" {
        return Err(CoreError::Conflict(format!(
            "session {session_id} is {state}; reply discarded"
        )));
    }
    let status: String = tx.query_row(
        "SELECT status FROM session_turn WHERE id=?1",
        [user_turn_id],
        |r| r.get(0),
    )?;
    if status == "done" {
        let result = replay(&tx, session_id, user_seq)?;
        tx.commit()?;
        return Ok(result);
    }
    tx.execute(
        "UPDATE session_turn SET status='done' WHERE id=?1",
        [user_turn_id],
    )?;
    tx.execute(
        "INSERT INTO session_turn(session_id,seq,role,text,status,created_at) \
         VALUES(?1,?2,'student',?3,'done',?4)",
        rusqlite::params![session_id, user_seq + 1, raw, now()],
    )?;
    tx.execute(
        "UPDATE feynman_session SET version=?2 WHERE id=?1",
        rusqlite::params![session_id, version + 1],
    )?;
    tx.commit()?;
    let (student_text, ready_to_end) = strip_ready(&raw);
    Ok(TurnResult {
        student_text,
        ready_to_end,
        version: version + 1,
    })
}

/// 放弃会话:state='abandoned'、version+1;允许存在 pending 回合(其续跑的事务 B 会被拒绝)。
pub fn abandon_session(conn: &Connection, session_id: i64, expected_version: i64) -> Result<()> {
    let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate)?;
    let (state, version) = session_state(&tx, session_id)?;
    if !matches!(state.as_str(), "open" | "evaluating" | "evaluated") {
        return Err(CoreError::Conflict(format!(
            "session {session_id} is {state}"
        )));
    }
    if version != expected_version {
        return Err(CoreError::Conflict(format!(
            "session version is {version}, expected {expected_version}"
        )));
    }
    tx.execute(
        "UPDATE feynman_session SET state='abandoned', version=?2, ended_at=?3 WHERE id=?1",
        rusqlite::params![session_id, version + 1, now()],
    )?;
    tx.commit()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::{AiProvider, CompletionRequest, Role};
    use crate::orchestrate::AiPolicy;
    use crate::CoreError;
    use rusqlite::Connection;
    use std::cell::{Cell, RefCell};

    const DAY: &str = "2026-09-05";

    type Call = (String, Vec<(Role, String)>);
    struct TurnMock {
        fail: Cell<bool>,
        reply: RefCell<String>,
        calls: RefCell<Vec<Call>>,
    }
    impl TurnMock {
        fn new(reply: &str) -> Self {
            Self {
                fail: Cell::new(false),
                reply: RefCell::new(reply.into()),
                calls: RefCell::new(vec![]),
            }
        }
    }
    impl AiProvider for TurnMock {
        fn complete(&self, req: &CompletionRequest) -> crate::Result<String> {
            self.calls
                .borrow_mut()
                .push((req.request_id.clone(), req.messages.clone()));
            if self.fail.get() {
                return Err(CoreError::Ai("timeout".into()));
            }
            Ok(self.reply.borrow().clone())
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
            profile_summary: "研究者".into(),
            block_title: "供需弹性".into(),
            block_source_text: "原文".into(),
            eval_history: String::new(),
            related_weakpoints: String::new(),
            prereq_status: String::new(),
        }
    }
    /// 建书 + 2 块 + 计划 + 今日队列;返回 (task_id of block1, block1, block2)
    fn seed(conn: &Connection) -> (i64, i64, i64) {
        let book =
            crate::models::insert_book(conn, "书", "", crate::models::BookType::Textbook, "bk")
                .unwrap();
        let b1 =
            crate::models::insert_block(conn, book, "m", 1, "供需弹性", "elasticity", &[]).unwrap();
        let b2 = crate::models::insert_block(conn, book, "m", 2, "消费者剩余", "surplus", &[b1])
            .unwrap();
        conn.execute(
            "INSERT INTO study_plan(book_id,deadline,daily_new_blocks) VALUES(?1,'2026-09-30',2)",
            [book],
        )
        .unwrap();
        let q = crate::sched::generate_daily(conn, DAY).unwrap();
        assert_eq!(q[0].block_id, b1);
        (q[0].id, b1, b2)
    }
    fn workdir() -> std::path::PathBuf {
        std::env::temp_dir()
    }
    fn turns(conn: &Connection, sid: i64) -> Vec<(String, String, String)> {
        let mut st = conn
            .prepare("SELECT role,text,status FROM session_turn WHERE session_id=?1 ORDER BY seq")
            .unwrap();
        st.query_map([sid], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap()
    }
    fn submit(
        conn: &Connection,
        mock: &TurnMock,
        sid: i64,
        version: i64,
        turn_id: &str,
        text: &str,
    ) -> crate::Result<TurnResult> {
        submit_turn(
            conn,
            mock,
            &workdir(),
            &policy(),
            sid,
            version,
            turn_id,
            text,
            &ctx(),
            crate::models::BookType::Textbook,
        )
    }

    #[test]
    fn double_start_returns_same_session() {
        let conn = crate::db::open_in_memory().unwrap();
        let (task, b1, _) = seed(&conn);
        let a = start_or_resume_session(&conn, task, "r1", DAY).unwrap();
        let b = start_or_resume_session(&conn, task, "r2", DAY).unwrap();
        let c = start_or_resume_session(&conn, task, "r1", DAY).unwrap();
        assert_eq!(
            (a.session_id, b.session_id, c.session_id),
            (a.session_id, a.session_id, a.session_id)
        );
        assert_eq!(
            (
                a.state.as_str(),
                a.version,
                a.block_id,
                a.kind.as_str(),
                a.task_id
            ),
            ("open", 0, b1, "learn", task)
        );
        assert!(a.transcript.is_empty() && a.eval.is_none());
        let n: i64 = conn
            .query_row("SELECT count(*) FROM feynman_session", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1);
    }

    #[test]
    fn start_rejects_done_task_other_day_and_missing_task() {
        let conn = crate::db::open_in_memory().unwrap();
        let (task, _, _) = seed(&conn);
        assert!(matches!(
            start_or_resume_session(&conn, task, "r1", "2026-09-06").unwrap_err(),
            CoreError::NotFound(_)
        ));
        assert!(matches!(
            start_or_resume_session(&conn, 999, "r1", DAY).unwrap_err(),
            CoreError::NotFound(_)
        ));
        conn.execute("UPDATE daily_task SET status='done' WHERE id=?1", [task])
            .unwrap();
        assert!(matches!(
            start_or_resume_session(&conn, task, "r1", DAY).unwrap_err(),
            CoreError::Conflict(_)
        ));
        assert!(matches!(
            start_or_resume_session(&conn, task, "bad id", DAY).unwrap_err(),
            CoreError::InvalidInput(_)
        ));
    }

    #[test]
    fn submit_turn_persists_user_and_student() {
        let conn = crate::db::open_in_memory().unwrap();
        let (task, _, _) = seed(&conn);
        let s = start_or_resume_session(&conn, task, "r1", DAY).unwrap();
        let mock = TurnMock::new("为什么是相对变化率?");
        let r = submit(&conn, &mock, s.session_id, 0, "t1", "弹性是相对变化率").unwrap();
        assert_eq!(
            (r.student_text.as_str(), r.ready_to_end, r.version),
            ("为什么是相对变化率?", false, 1)
        );
        let calls = mock.calls.borrow().clone();
        assert_eq!(calls[0].0, format!("turn:{}:t1", s.session_id));
        assert_eq!(
            calls[0].1,
            vec![(Role::User, "弹性是相对变化率".to_string())]
        );
        let view = get_session(&conn, s.session_id).unwrap();
        assert_eq!(view.version, 1);
        let roles: Vec<_> = view
            .transcript
            .iter()
            .map(|t| (t.role.as_str(), t.status.as_str(), t.client_turn_id.clone()))
            .collect();
        assert_eq!(
            roles,
            vec![
                ("user", "done", Some("t1".into())),
                ("student", "done", None)
            ]
        );
        // 第二回合把完整历史送给 provider
        let r2 = submit(&conn, &mock, s.session_id, 1, "t2", "因为要消除单位").unwrap();
        assert_eq!(r2.version, 2);
        assert_eq!(mock.calls.borrow()[1].1.len(), 3);
    }

    #[test]
    fn stale_version_conflicts_without_write() {
        let conn = crate::db::open_in_memory().unwrap();
        let (task, _, _) = seed(&conn);
        let s = start_or_resume_session(&conn, task, "r1", DAY).unwrap();
        let mock = TurnMock::new("?");
        let err = submit(&conn, &mock, s.session_id, 5, "t1", "x").unwrap_err();
        assert!(matches!(err, CoreError::Conflict(_)));
        assert!(turns(&conn, s.session_id).is_empty());
        assert!(mock.calls.borrow().is_empty());
        assert!(matches!(
            submit(&conn, &mock, s.session_id, 0, "t1", "   ").unwrap_err(),
            CoreError::InvalidInput(_)
        ));
    }

    #[test]
    fn same_turn_id_replays_without_provider() {
        let conn = crate::db::open_in_memory().unwrap();
        let (task, _, _) = seed(&conn);
        let s = start_or_resume_session(&conn, task, "r1", DAY).unwrap();
        let mock = TurnMock::new("讲清楚了 [READY_TO_END]");
        let a = submit(&conn, &mock, s.session_id, 0, "t1", "x").unwrap();
        let b = submit(&conn, &mock, s.session_id, 0, "t1", "x").unwrap();
        let c = submit(&conn, &mock, s.session_id, 1, "t1", "x").unwrap();
        assert_eq!(a, b);
        assert_eq!(a, c);
        assert_eq!(
            (a.student_text.as_str(), a.ready_to_end, a.version),
            ("讲清楚了", true, 1)
        );
        assert_eq!(mock.calls.borrow().len(), 1);
        assert_eq!(turns(&conn, s.session_id).len(), 2);
    }

    #[test]
    fn ready_marker_is_stripped_but_stored_raw() {
        let conn = crate::db::open_in_memory().unwrap();
        let (task, _, _) = seed(&conn);
        let s = start_or_resume_session(&conn, task, "r1", DAY).unwrap();
        let mock = TurnMock::new("讲清楚了 [READY_TO_END]");
        submit(&conn, &mock, s.session_id, 0, "t1", "x").unwrap();
        let stored = turns(&conn, s.session_id);
        assert!(stored[1].1.contains(READY_MARKER));
        let view = get_session(&conn, s.session_id).unwrap();
        assert_eq!(view.transcript[1].text, "讲清楚了");
        assert!(view.transcript[1].ready_to_end);
        assert!(!view.transcript[0].ready_to_end);
    }

    #[test]
    fn provider_failure_keeps_pending_turn_and_resumes_after_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.db");
        let conn = crate::db::open(&path).unwrap();
        let (task, _, _) = seed(&conn);
        let s = start_or_resume_session(&conn, task, "r1", DAY).unwrap();
        let mock = TurnMock::new("?");
        mock.fail.set(true);
        let err = submit(&conn, &mock, s.session_id, 0, "t1", "弹性").unwrap_err();
        assert!(matches!(err, CoreError::Ai(_)));
        assert_eq!(mock.calls.borrow().len(), 3, "传输重试");
        assert_eq!(
            turns(&conn, s.session_id),
            vec![("user".into(), "弹性".into(), "pending".into())]
        );
        assert_eq!(get_session(&conn, s.session_id).unwrap().version, 0);
        // 其他 turn id 在 pending 期间 → Conflict
        let err = submit(&conn, &mock, s.session_id, 0, "t2", "y").unwrap_err();
        assert!(
            matches!(&err, CoreError::Conflict(m) if m.contains("pending")),
            "{err}"
        );
        drop(conn);
        // 重启:从 get_session 取回 pending 回合的 client_turn_id,用同一旧版本续跑
        let conn = crate::db::open(&path).unwrap();
        let view = get_session(&conn, s.session_id).unwrap();
        let pending = view
            .transcript
            .iter()
            .find(|t| t.status == "pending")
            .expect("pending user turn visible after reopen");
        let turn_id = pending.client_turn_id.clone().unwrap();
        mock.fail.set(false);
        let r = submit(&conn, &mock, s.session_id, view.version, &turn_id, "弹性").unwrap();
        assert_eq!(r.version, 1);
        let stored = turns(&conn, s.session_id);
        assert_eq!(stored.len(), 2);
        assert_eq!(
            (stored[0].2.as_str(), stored[1].0.as_str()),
            ("done", "student")
        );
    }

    #[test]
    fn abandon_blocks_turns_and_discards_inflight_reply() {
        let conn = crate::db::open_in_memory().unwrap();
        let (task, _, _) = seed(&conn);
        let s = start_or_resume_session(&conn, task, "r1", DAY).unwrap();
        let mock = TurnMock::new("?");
        mock.fail.set(true);
        assert!(submit(&conn, &mock, s.session_id, 0, "t1", "x").is_err());
        assert!(matches!(
            abandon_session(&conn, s.session_id, 7).unwrap_err(),
            CoreError::Conflict(_)
        ));
        abandon_session(&conn, s.session_id, 0).unwrap();
        let view = get_session(&conn, s.session_id).unwrap();
        assert_eq!((view.state.as_str(), view.version), ("abandoned", 1));
        mock.fail.set(false);
        let err = submit(&conn, &mock, s.session_id, 0, "t1", "x").unwrap_err();
        assert!(matches!(err, CoreError::Conflict(_)), "{err}");
        assert_eq!(turns(&conn, s.session_id).len(), 1, "回复被丢弃");
        assert!(matches!(
            submit(&conn, &mock, s.session_id, 1, "t3", "x").unwrap_err(),
            CoreError::Conflict(_)
        ));
        assert!(matches!(
            abandon_session(&conn, s.session_id, 1).unwrap_err(),
            CoreError::Conflict(_)
        ));
        // 放弃后可重新开始:同任务新会话
        let s2 = start_or_resume_session(&conn, task, "r9", DAY).unwrap();
        assert_ne!(s2.session_id, s.session_id);
    }

    #[test]
    fn fixed_context_prefers_exact_text_and_falls_back_to_chapter() {
        let conn = crate::db::open_in_memory().unwrap();
        let (_, b1, b2) = seed(&conn);
        let book = crate::models::get_block(&conn, b1).unwrap().book_id;
        let long_chapter = "章".repeat(30 * 1024); // 90 KiB
        crate::mapgen::store_spine(
            &conn,
            book,
            &[
                crate::mapgen::SpineChapter {
                    idx: 0,
                    href: "ch0.xhtml".into(),
                    title: "零".into(),
                    text: "第零章整章文本".into(),
                },
                crate::mapgen::SpineChapter {
                    idx: 1,
                    href: "ch1.xhtml".into(),
                    title: "一".into(),
                    text: long_chapter,
                },
            ],
        )
        .unwrap();
        let seg = |href: &str, precision: &str, text: &str| crate::map::AnchorSegment {
            spine_href: href.into(),
            cfi_start: String::new(),
            cfi_end: String::new(),
            precision: precision.into(),
            hint: String::new(),
            text: text.into(),
        };
        // b1:精确段优先;同章两段 fallback 只取一次整章
        crate::map::set_anchor_segments(
            &conn,
            b1,
            &[
                seg("ch0.xhtml", "exact", "精确段落"),
                seg("ch0.xhtml", "chapter_fallback", ""),
                seg("ch0.xhtml", "chapter_fallback", ""),
            ],
        )
        .unwrap();
        conn.execute("INSERT INTO weak_point(block_id,title,detail,created_at) VALUES(?1,'弹性vs斜率','混淆','2026-09-01')", [b1]).unwrap();
        conn.execute(
            "INSERT INTO feynman_session(block_id,kind,started_at,state,eval_json) VALUES(?1,'learn','2026-09-01','confirmed',?2)",
            rusqlite::params![b1, r#"{"verdict":"relearn_suggested","scores":{"accuracy":2,"completeness":2,"clarity":3},"summary":"跳步","final_restatement":"r"}"#],
        )
        .unwrap();
        let c1 = fixed_context_for_block(&conn, b1, "研究者").unwrap();
        assert_eq!(c1.profile_summary, "研究者");
        assert_eq!(c1.block_title, "供需弹性");
        assert!(c1.block_source_text.starts_with("精确段落"));
        assert_eq!(
            c1.block_source_text.matches("第零章整章文本").count(),
            1,
            "{}",
            c1.block_source_text
        );
        assert!(c1.related_weakpoints.contains("弹性vs斜率"));
        assert!(
            c1.eval_history.contains("2026-09-01")
                && c1.eval_history.contains("重学建议")
                && c1.eval_history.contains("跳步")
        );
        // b2:整章回退 + 超长截断 + 前置状态
        crate::map::set_anchor_segments(&conn, b2, &[seg("ch1.xhtml", "chapter_fallback", "")])
            .unwrap();
        let c2 = fixed_context_for_block(&conn, b2, "").unwrap();
        assert!(c2.block_source_text.len() <= SOURCE_TEXT_LIMIT_BYTES + 64);
        assert!(c2.block_source_text.ends_with("(原文过长,已截断)"));
        assert!(c2.prereq_status.contains("供需弹性") && c2.prereq_status.contains("unlearned"));
        assert!(matches!(
            fixed_context_for_block(&conn, 999, "").unwrap_err(),
            CoreError::NotFound(_)
        ));
    }
}
