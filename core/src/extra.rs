//! 三类书通过后附加环节(PRODUCT_SPEC §4、TECH_DESIGN §6.4–6.6;M2 T5)。
//!
//! 教材 → 迁移应用题;方法论 → 情境化「我的版本」;人文 → 对立视角讨论。
//! 会话复用 `feynman_session`(`kind='learn'`,`extra_kind` 标记,`task_id` NULL;每块每类一次),
//! 回合复用 `session::submit_turn`;`finish` 以整理 prompt 产出 markdown 写 `artifact`,
//! 并经 outbox `extra_archive` 追加到记忆库 `_applications.md` / `_methodology.md` / `_notes.md`。
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior};
use std::path::Path;

use crate::ai::{AiProvider, CompletionRequest};
use crate::models::BookType;
use crate::orchestrate::{run_ai_request, validate_client_id, AiPolicy};
use crate::prompts::{self, FixedContext};
use crate::session::{get_session, SessionView};
use crate::{CoreError, Result};

/// 整理 prompt 的超时(秒)。
pub const FINISH_TIMEOUT_SECS: u64 = 120;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExtraKind {
    Application,
    Methodology,
    Discussion,
}

impl ExtraKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Application => "application",
            Self::Methodology => "methodology",
            Self::Discussion => "discussion",
        }
    }

    pub fn parse(value: &str) -> Result<Self> {
        match value {
            "application" => Ok(Self::Application),
            "methodology" => Ok(Self::Methodology),
            "discussion" => Ok(Self::Discussion),
            other => Err(CoreError::InvalidInput(format!(
                "unknown extra kind {other:?}"
            ))),
        }
    }

    /// 书类型 → 附加环节种类(PRODUCT_SPEC 三类书模板)。
    pub fn for_book_type(ty: BookType) -> Self {
        match ty {
            BookType::Textbook => Self::Application,
            BookType::Methodology => Self::Methodology,
            BookType::Humanities => Self::Discussion,
        }
    }

    /// `artifact.kind`:application → application、methodology → methodology、discussion → reflection。
    pub fn artifact_kind(self) -> &'static str {
        match self {
            Self::Application => "application",
            Self::Methodology => "methodology",
            Self::Discussion => "reflection",
        }
    }

    pub fn from_artifact_kind(value: &str) -> Option<Self> {
        match value {
            "application" => Some(Self::Application),
            "methodology" => Some(Self::Methodology),
            "reflection" => Some(Self::Discussion),
            _ => None,
        }
    }

    /// 记忆库中书目录下的归档文件名。
    pub fn archive_file(self) -> &'static str {
        match self {
            Self::Application => "_applications.md",
            Self::Methodology => "_methodology.md",
            Self::Discussion => "_notes.md",
        }
    }

    pub fn archive_title(self) -> &'static str {
        match self {
            Self::Application => "迁移应用",
            Self::Methodology => "个人方法论",
            Self::Discussion => "思考笔记",
        }
    }

    /// 学生(AI)回合上限,**含开场回合的回复**:方法论 3 轮引导 + 开场 = 4,其余 2 + 开场 = 3;
    /// 达到后强制带 READY_TO_END 收尾(与快问会话同机制)。
    pub fn max_student_turns(self) -> i64 {
        match self {
            Self::Methodology => 4,
            _ => 3,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExtraOutcome {
    pub kind: ExtraKind,
    pub artifact_id: i64,
    pub version: i64,
    /// 整理稿(前端直接展示,免再查 artifact)
    pub content_md: String,
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

/// 开始(或返回既有的)附加环节会话。仅当块已通过(status passed/consolidated)且存在已确认的 learn 会话;
/// `client_request_id` 幂等;同块同类已存在则返回既有会话(任何状态)。
pub fn start(
    conn: &Connection,
    block_id: i64,
    kind: ExtraKind,
    client_request_id: &str,
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
    if let Some(sid) = tx
        .query_row(
            "SELECT id FROM feynman_session WHERE block_id=?1 AND extra_kind=?2",
            rusqlite::params![block_id, kind.as_str()],
            |r| r.get::<_, i64>(0),
        )
        .optional()?
    {
        let view = get_session(&tx, sid)?;
        tx.commit()?;
        return Ok(view);
    }
    let status: String = tx
        .query_row(
            "SELECT status FROM knowledge_block WHERE id=?1",
            [block_id],
            |r| r.get(0),
        )
        .optional()?
        .ok_or_else(|| CoreError::NotFound(format!("block {block_id}")))?;
    if !matches!(status.as_str(), "passed" | "consolidated") {
        return Err(CoreError::Conflict(format!(
            "block {block_id} is {status}; the extra stage requires a passed block"
        )));
    }
    let confirmed_learn: i64 = tx.query_row(
        "SELECT count(*) FROM feynman_session \
         WHERE block_id=?1 AND kind='learn' AND extra_kind IS NULL AND state='confirmed'",
        [block_id],
        |r| r.get(0),
    )?;
    if confirmed_learn == 0 {
        return Err(CoreError::Conflict(format!(
            "block {block_id} has no confirmed teaching session"
        )));
    }
    tx.execute(
        "INSERT INTO feynman_session(block_id,kind,started_at,task_id,state,version,client_request_id,extra_kind) \
         VALUES(?1,'learn',?2,NULL,'open',0,?3,?4)",
        rusqlite::params![block_id, now(), client_request_id, kind.as_str()],
    )?;
    let sid = tx.last_insert_rowid();
    let view = get_session(&tx, sid)?;
    tx.commit()?;
    Ok(view)
}

fn latest_artifact(conn: &Connection, block_id: i64, kind: ExtraKind) -> Result<(i64, String)> {
    conn.query_row(
        "SELECT id,content_md FROM artifact WHERE block_id=?1 AND kind=?2 ORDER BY id DESC LIMIT 1",
        rusqlite::params![block_id, kind.artifact_kind()],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .optional()?
    .ok_or_else(|| {
        CoreError::Other(format!(
            "confirmed extra session of block {block_id} has no artifact"
        ))
    })
}

/// 结束附加环节:整理 prompt 产出 markdown → `artifact` + 会话 confirmed(不写 `eval_json`)+ outbox
/// `extra_archive{artifact_id, entry_key}` 与 `git_commit`。`request_id` 幂等(同 id 重放返回同一产出)。
#[allow(clippy::too_many_arguments)]
pub fn finish(
    conn: &Connection,
    provider: &dyn AiProvider,
    workdir: &Path,
    policy: &AiPolicy,
    session_id: i64,
    expected_version: i64,
    request_id: &str,
    ctx: &FixedContext,
) -> Result<ExtraOutcome> {
    validate_client_id(request_id)?;
    if !conn.is_autocommit() {
        return Err(CoreError::Other(
            "extra::finish must not be called inside a transaction".into(),
        ));
    }
    let full_id = format!("extra:{session_id}:{request_id}");
    // 短事务 A:状态检查与 open→evaluating
    let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate)?;
    let (state, version, block_id, extra_kind, done_request): (
        String,
        i64,
        i64,
        Option<String>,
        Option<String>,
    ) = tx
        .query_row(
            "SELECT state,version,block_id,extra_kind,verdict_request_id FROM feynman_session WHERE id=?1",
            [session_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .optional()?
        .ok_or_else(|| CoreError::NotFound(format!("session {session_id}")))?;
    let kind = ExtraKind::parse(extra_kind.as_deref().ok_or_else(|| {
        CoreError::InvalidInput(format!("session {session_id} is not an extra stage"))
    })?)?;
    match state.as_str() {
        "confirmed" => {
            if done_request.as_deref() == Some(full_id.as_str()) {
                let (artifact_id, content_md) = latest_artifact(&tx, block_id, kind)?;
                tx.commit()?;
                return Ok(ExtraOutcome {
                    kind,
                    artifact_id,
                    version,
                    content_md,
                });
            }
            return Err(CoreError::Conflict(format!(
                "session {session_id} was already finished by another request"
            )));
        }
        "open" => {
            if version != expected_version {
                return Err(CoreError::Conflict(format!(
                    "session version is {version}, expected {expected_version}"
                )));
            }
        }
        "evaluating" => {
            let existing: Vec<String> = {
                let mut st =
                    tx.prepare("SELECT request_id FROM ai_request WHERE request_id LIKE ?1")?;
                let rows = st.query_map([format!("extra:{session_id}:%")], |r| r.get(0))?;
                rows.collect::<rusqlite::Result<_>>()?
            };
            if !existing.is_empty() && !existing.iter().any(|id| id == &full_id) {
                return Err(CoreError::Conflict(format!(
                    "session {session_id} is being finished by another request"
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
            "a user turn is still pending; finish or abandon it before closing the stage".into(),
        ));
    }
    let user_turns: i64 = tx.query_row(
        "SELECT count(*) FROM session_turn WHERE session_id=?1 AND role='user' AND status='done'",
        [session_id],
        |r| r.get(0),
    )?;
    if user_turns < 2 {
        return Err(CoreError::Conflict(
            "nothing to summarize: answer at least once after the opener".into(),
        ));
    }
    tx.execute(
        "UPDATE feynman_session SET state='evaluating' WHERE id=?1 AND state='open'",
        [session_id],
    )?;
    let transcript = crate::verdict::render_transcript(&tx, session_id)?;
    tx.commit()?;

    // 无事务调用 AI:整理稿为纯 markdown
    let req = CompletionRequest {
        system: prompts::extra_summary_prompt(kind, ctx, &transcript),
        messages: vec![],
        workdir: workdir.to_path_buf(),
        read_only: true,
        request_id: String::new(),
        timeout_secs: FINISH_TIMEOUT_SECS,
    };
    let accept = |text: &str| {
        if text.trim().is_empty() {
            Err(CoreError::Ai("empty summary".into()))
        } else {
            Ok(())
        }
    };
    let result = run_ai_request(conn, provider, &full_id, "extra", &req, policy, &accept)
        .map(|outcome| strip_fence(&outcome.into_text()));

    // 短事务 B:落库或回退
    let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate)?;
    match result {
        Ok(content_md) => {
            let (state, version): (String, i64) = tx.query_row(
                "SELECT state,version FROM feynman_session WHERE id=?1",
                [session_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?;
            if state != "evaluating" {
                return Err(CoreError::Conflict(format!(
                    "session {session_id} is {state}; summary discarded"
                )));
            }
            let (book_id, block_title): (i64, String) = tx.query_row(
                "SELECT book_id,title FROM knowledge_block WHERE id=?1",
                [block_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?;
            let created_at = now();
            tx.execute(
                "INSERT INTO artifact(book_id,kind,block_id,content_md,created_at) VALUES(?1,?2,?3,?4,?5)",
                rusqlite::params![book_id, kind.artifact_kind(), block_id, content_md, created_at],
            )?;
            let artifact_id = tx.last_insert_rowid();
            tx.execute(
                "UPDATE feynman_session SET state='confirmed', version=?2, verdict_request_id=?3, ended_at=?4 WHERE id=?1",
                rusqlite::params![session_id, version + 1, full_id, created_at],
            )?;
            let archive_op = format!("{full_id}:archive");
            crate::projection::enqueue(
                &tx,
                &archive_op,
                "extra_archive",
                &serde_json::json!({ "artifact_id": artifact_id, "entry_key": archive_op }),
            )?;
            crate::projection::enqueue(
                &tx,
                &format!("{full_id}:git_commit"),
                "git_commit",
                &serde_json::json!({
                    "message": format!("extra: 归档{} · {block_title}", kind.archive_title())
                }),
            )?;
            tx.commit()?;
            Ok(ExtraOutcome {
                kind,
                artifact_id,
                version: version + 1,
                content_md,
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

/// 模型偶尔会把 markdown 包在 ```markdown 围栏里;剥掉最外层围栏。
fn strip_fence(text: &str) -> String {
    let t = text.trim();
    if let Some(rest) = t.strip_prefix("```") {
        let body = rest.split_once('\n').map(|(_, b)| b).unwrap_or("");
        if let Some(inner) = body.strip_suffix("```") {
            return inner.trim().to_string();
        }
    }
    t.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::CompletionRequest;
    use std::cell::RefCell;

    struct Mock {
        replies: RefCell<Vec<String>>,
        calls: RefCell<Vec<(String, String)>>,
    }
    impl Mock {
        fn new(replies: &[&str]) -> Self {
            Self {
                replies: RefCell::new(replies.iter().rev().map(|s| s.to_string()).collect()),
                calls: RefCell::new(vec![]),
            }
        }
    }
    impl AiProvider for Mock {
        fn complete(&self, req: &CompletionRequest) -> Result<String> {
            self.calls
                .borrow_mut()
                .push((req.request_id.clone(), req.system.clone()));
            self.replies
                .borrow_mut()
                .pop()
                .ok_or_else(|| CoreError::Ai("no scripted reply".into()))
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
    /// 建书(教材)+ 1 块;`passed=true` 时把块置为 passed 并插入一条已确认的 learn 会话
    fn seed(conn: &Connection, passed: bool) -> i64 {
        let book = crate::models::insert_book(conn, "书", "", BookType::Textbook, "bk").unwrap();
        let b1 =
            crate::models::insert_block(conn, book, "m", 1, "供需弹性", "elasticity", &[]).unwrap();
        if passed {
            conn.execute(
                "UPDATE knowledge_block SET status='passed', passed_at='2026-09-01' WHERE id=?1",
                [b1],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO feynman_session(block_id,kind,started_at,state,version,client_request_id) \
                 VALUES(?1,'learn','2026-09-01T00:00:00Z','confirmed',3,'learn-req')",
                [b1],
            )
            .unwrap();
        }
        b1
    }
    fn turn(
        conn: &Connection,
        mock: &Mock,
        sid: i64,
        version: i64,
        id: &str,
        text: &str,
    ) -> crate::session::TurnResult {
        crate::session::submit_turn(
            conn,
            mock,
            &std::env::temp_dir(),
            &policy(),
            sid,
            version,
            id,
            text,
            &ctx(),
            BookType::Textbook,
        )
        .unwrap()
    }

    #[test]
    fn kind_mapping_is_total() {
        assert_eq!(
            ExtraKind::for_book_type(BookType::Textbook),
            ExtraKind::Application
        );
        assert_eq!(
            ExtraKind::for_book_type(BookType::Methodology),
            ExtraKind::Methodology
        );
        assert_eq!(
            ExtraKind::for_book_type(BookType::Humanities),
            ExtraKind::Discussion
        );
        for k in [
            ExtraKind::Application,
            ExtraKind::Methodology,
            ExtraKind::Discussion,
        ] {
            assert_eq!(ExtraKind::parse(k.as_str()).unwrap(), k);
            assert_eq!(ExtraKind::from_artifact_kind(k.artifact_kind()), Some(k));
        }
        assert!(matches!(
            ExtraKind::parse("quiz"),
            Err(CoreError::InvalidInput(_))
        ));
        assert_eq!(strip_fence("```markdown\n## 评语\n好\n```"), "## 评语\n好");
        assert_eq!(strip_fence("## 评语"), "## 评语");
    }

    #[test]
    fn start_requires_a_passed_block_and_is_once_per_block_and_kind() {
        let conn = crate::db::open_in_memory().unwrap();
        let b = seed(&conn, false);
        assert!(matches!(
            start(&conn, b, ExtraKind::Application, "x1"),
            Err(CoreError::Conflict(_))
        ));
        assert!(matches!(
            start(&conn, 999, ExtraKind::Application, "x1"),
            Err(CoreError::NotFound(_))
        ));
        conn.execute(
            "UPDATE knowledge_block SET status='passed' WHERE id=?1",
            [b],
        )
        .unwrap();
        // 块已 passed 但无已确认 learn 会话(数据不一致)→ 仍拒绝
        assert!(matches!(
            start(&conn, b, ExtraKind::Application, "x1"),
            Err(CoreError::Conflict(_))
        ));
        conn.execute(
            "INSERT INTO feynman_session(block_id,kind,started_at,state,version,client_request_id) \
             VALUES(?1,'learn','2026-09-01T00:00:00Z','confirmed',3,'learn-req')",
            [b],
        )
        .unwrap();
        let v = start(&conn, b, ExtraKind::Application, "x1").unwrap();
        assert_eq!(
            (
                v.kind.as_str(),
                v.extra_kind.as_deref(),
                v.task_id,
                v.state.as_str()
            ),
            ("learn", Some("application"), 0, "open")
        );
        // 同 client id 与同块同类:都返回既有会话
        assert_eq!(
            start(&conn, b, ExtraKind::Application, "x1")
                .unwrap()
                .session_id,
            v.session_id
        );
        assert_eq!(
            start(&conn, b, ExtraKind::Application, "x2")
                .unwrap()
                .session_id,
            v.session_id
        );
        // 不同类可另开
        assert_ne!(
            start(&conn, b, ExtraKind::Discussion, "x3")
                .unwrap()
                .session_id,
            v.session_id
        );
    }

    #[test]
    fn turns_use_extra_prompts_and_cap_forces_ready() {
        let conn = crate::db::open_in_memory().unwrap();
        let b = seed(&conn, true);
        let sid = start(&conn, b, ExtraKind::Application, "x1")
            .unwrap()
            .session_id;
        let mock = Mock::new(&["题目:你的实验定价……", "运用正确。", "还有一点补充。"]);
        let r1 = turn(&conn, &mock, sid, 0, "opener", "请出题");
        assert!(!r1.ready_to_end);
        assert!(
            mock.calls.borrow()[0].1.contains("现实情境应用题"),
            "extra system prompt expected"
        );
        assert!(!mock.calls.borrow()[0]
            .1
            .contains("扮演一位聪明但完全没学过"));
        let r2 = turn(&conn, &mock, sid, 1, "t2", "我会先估计弹性……");
        assert!(!r2.ready_to_end);
        // 第 3 个学生回合达上限(application=3)→ 强制收尾
        let r3 = turn(&conn, &mock, sid, 2, "t3", "补充完毕");
        assert!(r3.ready_to_end);
        assert_eq!(r3.student_text, "还有一点补充。");
    }

    #[test]
    fn finish_writes_artifact_confirms_session_and_enqueues_archive_idempotently() {
        let conn = crate::db::open_in_memory().unwrap();
        let b = seed(&conn, true);
        let sid = start(&conn, b, ExtraKind::Application, "x1")
            .unwrap()
            .session_id;
        let mock = Mock::new(&[
            "题目",
            "评语",
            "```markdown\n## 评语\n运用正确\n## 掌握判断\n已掌握\n```",
        ]);
        // 只有开场回合 → 无内容可整理
        turn(&conn, &mock, sid, 0, "opener", "请出题");
        assert!(matches!(
            finish(
                &conn,
                &mock,
                &std::env::temp_dir(),
                &policy(),
                sid,
                1,
                "fin",
                &ctx()
            ),
            Err(CoreError::Conflict(_))
        ));
        turn(&conn, &mock, sid, 1, "t2", "我的作答");
        assert!(
            matches!(
                finish(
                    &conn,
                    &mock,
                    &std::env::temp_dir(),
                    &policy(),
                    sid,
                    1,
                    "fin",
                    &ctx()
                ),
                Err(CoreError::Conflict(_))
            ),
            "version mismatch"
        );
        let out = finish(
            &conn,
            &mock,
            &std::env::temp_dir(),
            &policy(),
            sid,
            2,
            "fin",
            &ctx(),
        )
        .unwrap();
        assert_eq!(out.kind, ExtraKind::Application);
        assert_eq!(out.version, 3);
        assert_eq!(out.content_md, "## 评语\n运用正确\n## 掌握判断\n已掌握");
        assert!(mock
            .calls
            .borrow()
            .last()
            .unwrap()
            .1
            .contains("用户:我的作答"));
        let (kind, block, content): (String, i64, String) = conn
            .query_row(
                "SELECT kind,block_id,content_md FROM artifact WHERE id=?1",
                [out.artifact_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(
            (kind.as_str(), block, content),
            ("application", b, out.content_md.clone())
        );
        let view = get_session(&conn, sid).unwrap();
        assert_eq!(
            (view.state.as_str(), view.eval.is_none()),
            ("confirmed", true)
        );
        let kinds: Vec<String> = {
            let mut st = conn
                .prepare("SELECT kind FROM projection_outbox WHERE status='pending' ORDER BY id")
                .unwrap();
            st.query_map([], |r| r.get(0))
                .unwrap()
                .collect::<rusqlite::Result<_>>()
                .unwrap()
        };
        assert_eq!(
            kinds,
            vec!["extra_archive".to_string(), "git_commit".to_string()]
        );
        // 同 id 重放返回同一产出且不再调用 AI;其它 id → Conflict
        let calls = mock.calls.borrow().len();
        let again = finish(
            &conn,
            &mock,
            &std::env::temp_dir(),
            &policy(),
            sid,
            99,
            "fin",
            &ctx(),
        )
        .unwrap();
        assert_eq!(again, out);
        assert_eq!(mock.calls.borrow().len(), calls);
        assert!(matches!(
            finish(
                &conn,
                &mock,
                &std::env::temp_dir(),
                &policy(),
                sid,
                3,
                "other",
                &ctx()
            ),
            Err(CoreError::Conflict(_))
        ));
        // 重放投影:归档文件出现内容且再次重放不重复
        let dir = tempfile::tempdir().unwrap();
        let memory = crate::memory::MemoryStore::init(dir.path()).unwrap();
        assert_eq!(crate::projection::run_pending(&conn, &memory).unwrap(), 2);
        let path = dir.path().join("books/bk/_applications.md");
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.starts_with("# 迁移应用 — 书\n"), "{text}");
        assert!(
            text.contains("## 2026-")
                && text.contains("供需弹性")
                && text.contains("## 掌握判断\n已掌握")
        );
        conn.execute(
            "UPDATE projection_outbox SET status='pending' WHERE kind='extra_archive'",
            [],
        )
        .unwrap();
        assert_eq!(crate::projection::run_pending(&conn, &memory).unwrap(), 1);
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            text,
            "archive must be idempotent"
        );
        // 评估接口拒绝附加环节会话
        assert!(matches!(
            crate::verdict::request_evaluation(
                &conn,
                &mock,
                &std::env::temp_dir(),
                &policy(),
                sid,
                "e",
                &ctx()
            ),
            Err(CoreError::Conflict(_))
        ));
    }

    #[test]
    fn finish_failure_reverts_to_open() {
        let conn = crate::db::open_in_memory().unwrap();
        let b = seed(&conn, true);
        let sid = start(&conn, b, ExtraKind::Discussion, "x1")
            .unwrap()
            .session_id;
        let mock = Mock::new(&["对立视角……", "有道理。"]);
        turn(&conn, &mock, sid, 0, "opener", "请提出对立视角");
        turn(&conn, &mock, sid, 1, "t2", "我的看法");
        let err = finish(
            &conn,
            &mock,
            &std::env::temp_dir(),
            &policy(),
            sid,
            2,
            "fin",
            &ctx(),
        )
        .unwrap_err();
        assert!(matches!(err, CoreError::Ai(_)), "{err:?}");
        assert_eq!(get_session(&conn, sid).unwrap().state, "open");
    }
}
