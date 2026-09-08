//! 整书终评(TECH_DESIGN §6.8;M3 T1)。
//!
//! 全部未跳过块通过后可开始:会话 `kind='final_exam'`、`book_id` 为所属书、`block_id` 为该书 seq 最小的
//! 未跳过块占位(列非空);每书同时只有一个未放弃的终评会话(`feynman_session_final_once`)。
//! 回合复用 `session::submit_turn`(system prompt 由会话按学生回合数分阶段自查);`finish` 以报告 prompt 产出
//! markdown 学习报告 → `artifact(kind='report')`、会话 confirmed(**不写 eval_json**)、书 finished,
//! 并经 outbox `report_archive` 追加到 `books/<slug>/_report.md` + `git_commit`。
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior};
use std::path::Path;

use crate::ai::{AiProvider, CompletionRequest};
use crate::orchestrate::{run_ai_parsed, validate_client_id, AiPolicy};
use crate::prompts;
use crate::session::{get_session, SessionView};
use crate::{CoreError, Result};

/// 学生回合上限(含开场回合的回复):框架追问 3 + 综合题 3 + 简评余量。
pub const MAX_FINAL_STUDENT_TURNS: i64 = 8;
/// 学生回合数小于此值时为第一阶段(追问全书框架),之后进入综合题阶段。
pub const FRAMEWORK_PHASE_TURNS: i64 = 3;
/// 结束前至少需要的用户回合(开场 + 两次作答)。
pub const MIN_USER_TURNS_TO_FINISH: i64 = 3;
pub const REPORT_TIMEOUT_SECS: u64 = 180;
/// 报告 prompt 中对话与弱点史的截断上限(codex prompt 走 argv,ADR-0004 记有 100 KiB 上限)。
const TRANSCRIPT_LIMIT: usize = 24_000;
const WEAK_HISTORY_LIMIT: usize = 8_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FinalReport {
    pub artifact_id: i64,
    pub version: i64,
    pub content_md: String,
    pub overall: u8,
    pub strongest_module: String,
    pub weakest_module: String,
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

fn book_exists(conn: &Connection, book_id: i64) -> Result<()> {
    conn.query_row("SELECT 1 FROM book WHERE id=?1", [book_id], |r| {
        r.get::<_, i64>(0)
    })
    .optional()?
    .map(|_| ())
    .ok_or_else(|| CoreError::NotFound(format!("book {book_id}")))
}

/// 可开始终评:未跳过块 ≥ 1 且全部 ∈ {passed, consolidated}。**不看** `book.status`(手动标记已学完的书仍可终评)。
pub fn eligible(conn: &Connection, book_id: i64) -> Result<bool> {
    book_exists(conn, book_id)?;
    let (total, done): (i64, i64) = conn.query_row(
        "SELECT count(*), COALESCE(sum(status IN ('passed','consolidated')),0) \
         FROM knowledge_block WHERE book_id=?1 AND skipped=0",
        [book_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    Ok(total > 0 && done == total)
}

fn placeholder_block(conn: &Connection, book_id: i64) -> Result<i64> {
    conn.query_row(
        "SELECT id FROM knowledge_block WHERE book_id=?1 AND skipped=0 ORDER BY seq, id LIMIT 1",
        [book_id],
        |r| r.get(0),
    )
    .optional()?
    .ok_or_else(|| CoreError::Conflict(format!("book {book_id} has no blocks")))
}

/// 开始(或返回既有的)终评会话。`client_request_id` 幂等;同书已有未放弃的终评会话则返回它(任何状态);
/// 未全部通过 → Conflict。放弃后可重开(唯一索引排除 abandoned)。
pub fn start(conn: &Connection, book_id: i64, client_request_id: &str) -> Result<SessionView> {
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
            "SELECT id FROM feynman_session \
             WHERE book_id=?1 AND kind='final_exam' AND state<>'abandoned' ORDER BY id DESC LIMIT 1",
            [book_id],
            |r| r.get::<_, i64>(0),
        )
        .optional()?
    {
        let view = get_session(&tx, sid)?;
        tx.commit()?;
        return Ok(view);
    }
    if !eligible(&tx, book_id)? {
        return Err(CoreError::Conflict(format!(
            "book {book_id} still has blocks that are not passed; the final exam requires all blocks passed"
        )));
    }
    let block_id = placeholder_block(&tx, book_id)?;
    tx.execute(
        "INSERT INTO feynman_session(block_id,kind,started_at,task_id,state,version,client_request_id,book_id) \
         VALUES(?1,'final_exam',?2,NULL,'open',0,?3,?4)",
        rusqlite::params![block_id, now(), client_request_id, book_id],
    )?;
    let sid = tx.last_insert_rowid();
    let view = get_session(&tx, sid)?;
    tx.commit()?;
    Ok(view)
}

/// 全书地图与各块状态摘要(注入终评 prompt):模块 | 块 | 状态,附待考/已修复薄弱点。
pub fn map_summary(conn: &Connection, book_id: i64) -> Result<String> {
    let blocks = crate::models::list_blocks(conn, book_id)?;
    let mut out = String::from("| 模块 | 知识块 | 状态 |\n|---|---|---|\n");
    for block in blocks.iter().filter(|b| !b.skipped) {
        out.push_str(&format!(
            "| {} | {} | {} |\n",
            block.module_name, block.title, block.status
        ));
    }
    let (open, fixed) = crate::sched::list_weakpoints(conn, book_id)?;
    if !open.is_empty() {
        out.push_str("\n待考薄弱点:\n");
        for (block, title, date) in open {
            out.push_str(&format!("- [{block}] {title} ({date})\n"));
        }
    }
    if !fixed.is_empty() {
        out.push_str("\n已修复薄弱点:\n");
        for (block, title, date) in fixed {
            out.push_str(&format!("- [{block}] {title} ({date})\n"));
        }
    }
    Ok(out)
}

fn weak_history(conn: &Connection, book_id: i64) -> Result<String> {
    let mut st = conn.prepare(
        "SELECT kb.title, w.title, w.status, w.created_at, COALESCE(w.fixed_at,'') \
         FROM weak_point w JOIN knowledge_block kb ON kb.id=w.block_id \
         WHERE kb.book_id=?1 ORDER BY w.created_at, w.id",
    )?;
    let rows: Vec<(String, String, String, String, String)> = st
        .query_map([book_id], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
        })?
        .collect::<rusqlite::Result<_>>()?;
    if rows.is_empty() {
        return Ok("(全程无薄弱点)".into());
    }
    let mut out = String::new();
    for (block, title, status, created, fixed) in rows {
        let created = created.get(..10).unwrap_or(&created).to_string();
        if status == "fixed" {
            out.push_str(&format!(
                "- [{block}] {title}:{created} 暴露 → {} 修复\n",
                fixed.get(..10).unwrap_or(&fixed)
            ));
        } else {
            out.push_str(&format!("- [{block}] {title}:{created} 暴露,仍待考\n"));
        }
    }
    Ok(truncate(&out, WEAK_HISTORY_LIMIT))
}

fn truncate(text: &str, limit: usize) -> String {
    if text.len() <= limit {
        return text.to_string();
    }
    let mut end = limit;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n(已截断)", &text[..end])
}

/// 解析报告:首行元注释 `<!-- overall:N strongest:… weakest:… -->`,其余为正文(剥最外层代码围栏)。
pub fn parse_report(text: &str) -> Result<(u8, String, String, String)> {
    let mut body = text.trim();
    if let Some(rest) = body.strip_prefix("```") {
        let inner = rest.split_once('\n').map(|(_, b)| b).unwrap_or("");
        if let Some(inner) = inner.strip_suffix("```") {
            body = inner.trim();
        }
    }
    let first = body.lines().next().unwrap_or("").trim();
    let meta = first
        .strip_prefix("<!--")
        .and_then(|s| s.strip_suffix("-->"))
        .map(str::trim)
        .ok_or_else(|| CoreError::EvalParse("report must start with the meta comment".into()))?;
    let mut overall: Option<u8> = None;
    let mut strongest = String::new();
    let mut weakest = String::new();
    // 键值以 " overall:" / " strongest:" / " weakest:" 分隔;模块名可含空格
    let keys = ["overall:", "strongest:", "weakest:"];
    let mut positions: Vec<(usize, &str)> = keys
        .iter()
        .filter_map(|k| meta.find(k).map(|i| (i, *k)))
        .collect();
    positions.sort();
    for (idx, (pos, key)) in positions.iter().enumerate() {
        let start = pos + key.len();
        let end = positions
            .get(idx + 1)
            .map(|(p, _)| *p)
            .unwrap_or(meta.len());
        let value = meta[start..end].trim();
        match *key {
            "overall:" => {
                overall = value
                    .chars()
                    .take_while(|c| c.is_ascii_digit())
                    .collect::<String>()
                    .parse()
                    .ok()
            }
            "strongest:" => strongest = value.to_string(),
            _ => weakest = value.to_string(),
        }
    }
    let overall = overall
        .filter(|n| (1..=5).contains(n))
        .ok_or_else(|| CoreError::EvalParse("report meta must give overall 1-5".into()))?;
    if strongest.is_empty() || weakest.is_empty() {
        return Err(CoreError::EvalParse(
            "report meta must name strongest and weakest modules".into(),
        ));
    }
    Ok((overall, strongest, weakest, body.to_string()))
}

fn latest_report(conn: &Connection, book_id: i64) -> Result<(i64, String)> {
    conn.query_row(
        "SELECT id,content_md FROM artifact WHERE book_id=?1 AND kind='report' ORDER BY id DESC LIMIT 1",
        [book_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .optional()?
    .ok_or_else(|| CoreError::Other(format!("confirmed final exam of book {book_id} has no report")))
}

/// 结束终评:报告 prompt → `artifact(kind='report')` + 会话 confirmed(不写 eval_json)+ 书 finished +
/// outbox `report_archive{artifact_id, entry_key}` 与 `git_commit`。`request_id` 幂等(同 id 重放返回同一报告)。
#[allow(clippy::too_many_arguments)]
pub fn finish(
    conn: &Connection,
    provider: &dyn AiProvider,
    workdir: &Path,
    policy: &AiPolicy,
    session_id: i64,
    expected_version: i64,
    request_id: &str,
) -> Result<FinalReport> {
    validate_client_id(request_id)?;
    if !conn.is_autocommit() {
        return Err(CoreError::Other(
            "final_exam::finish must not be called inside a transaction".into(),
        ));
    }
    let full_id = format!("final:{session_id}:{request_id}");
    let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate)?;
    #[allow(clippy::type_complexity)]
    let (state, version, kind, book_id, done_request): (
        String,
        i64,
        String,
        Option<i64>,
        Option<String>,
    ) = tx
        .query_row(
            "SELECT state,version,kind,book_id,verdict_request_id FROM feynman_session WHERE id=?1",
            [session_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .optional()?
        .ok_or_else(|| CoreError::NotFound(format!("session {session_id}")))?;
    if kind != "final_exam" {
        return Err(CoreError::InvalidInput(format!(
            "session {session_id} is not a final exam"
        )));
    }
    let book_id = book_id.ok_or_else(|| {
        CoreError::Other(format!("final exam session {session_id} has no book_id"))
    })?;
    match state.as_str() {
        "confirmed" => {
            if done_request.as_deref() == Some(full_id.as_str()) {
                let (artifact_id, content_md) = latest_report(&tx, book_id)?;
                let (overall, strongest, weakest, _) = parse_report(&content_md)?;
                tx.commit()?;
                return Ok(FinalReport {
                    artifact_id,
                    version,
                    content_md,
                    overall,
                    strongest_module: strongest,
                    weakest_module: weakest,
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
                let rows = st.query_map([format!("final:{session_id}:%")], |r| r.get(0))?;
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
            "a user turn is still pending; finish or abandon it before the report".into(),
        ));
    }
    let user_turns: i64 = tx.query_row(
        "SELECT count(*) FROM session_turn WHERE session_id=?1 AND role='user' AND status='done'",
        [session_id],
        |r| r.get(0),
    )?;
    if user_turns < MIN_USER_TURNS_TO_FINISH {
        return Err(CoreError::Conflict(format!(
            "the final exam needs at least {} answers before the report",
            MIN_USER_TURNS_TO_FINISH - 1
        )));
    }
    tx.execute(
        "UPDATE feynman_session SET state='evaluating' WHERE id=?1 AND state='open'",
        [session_id],
    )?;
    let transcript = truncate(
        &crate::verdict::render_transcript(&tx, session_id)?,
        TRANSCRIPT_LIMIT,
    );
    let map = map_summary(&tx, book_id)?;
    let history = weak_history(&tx, book_id)?;
    let book_title: String =
        tx.query_row("SELECT title FROM book WHERE id=?1", [book_id], |r| {
            r.get(0)
        })?;
    tx.commit()?;

    let req = CompletionRequest {
        system: prompts::final_report_prompt(&map, &history, &transcript),
        messages: vec![],
        workdir: workdir.to_path_buf(),
        read_only: true,
        request_id: String::new(),
        timeout_secs: REPORT_TIMEOUT_SECS,
    };
    let result = run_ai_parsed(
        conn,
        provider,
        &full_id,
        "final",
        &req,
        policy,
        &parse_report,
        "请只输出以元注释 <!-- overall:N strongest:… weakest:… --> 开头的 markdown 学习报告。",
    );

    let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate)?;
    match result {
        Ok((overall, strongest, weakest, content_md)) => {
            let (state, version): (String, i64) = tx.query_row(
                "SELECT state,version FROM feynman_session WHERE id=?1",
                [session_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?;
            if state != "evaluating" {
                return Err(CoreError::Conflict(format!(
                    "session {session_id} is {state}; report discarded"
                )));
            }
            let created_at = now();
            tx.execute(
                "INSERT INTO artifact(book_id,kind,block_id,content_md,created_at) VALUES(?1,'report',NULL,?2,?3)",
                rusqlite::params![book_id, content_md, created_at],
            )?;
            let artifact_id = tx.last_insert_rowid();
            tx.execute(
                "UPDATE feynman_session SET state='confirmed', version=?2, verdict_request_id=?3, ended_at=?4 WHERE id=?1",
                rusqlite::params![session_id, version + 1, full_id, created_at],
            )?;
            crate::library::finish_book_in(&tx, book_id)?;
            let archive_op = format!("{full_id}:archive");
            crate::projection::enqueue(
                &tx,
                &archive_op,
                "report_archive",
                &serde_json::json!({ "artifact_id": artifact_id, "entry_key": archive_op }),
            )?;
            crate::projection::enqueue(
                &tx,
                &format!("{full_id}:sync_map"),
                "sync_map",
                &serde_json::json!({ "book_id": book_id }),
            )?;
            crate::projection::enqueue(
                &tx,
                &format!("{full_id}:git_commit"),
                "git_commit",
                &serde_json::json!({ "message": format!("report: 整书终评 · {book_title}") }),
            )?;
            tx.commit()?;
            Ok(FinalReport {
                artifact_id,
                version: version + 1,
                content_md,
                overall,
                strongest_module: strongest,
                weakest_module: weakest,
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::BookType;
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
    fn ctx() -> prompts::FixedContext {
        prompts::FixedContext {
            profile_summary: "研究者".into(),
            block_title: "供需弹性".into(),
            block_source_text: "原文".into(),
            eval_history: String::new(),
            related_weakpoints: String::new(),
            prereq_status: String::new(),
        }
    }
    /// 建书 + 3 块;`passed` 为通过的块数(按 seq)
    fn seed(conn: &Connection, passed: usize) -> (i64, Vec<i64>) {
        let book = crate::models::insert_book(conn, "书", "", BookType::Textbook, "bk").unwrap();
        let mut ids = vec![];
        for (i, (title, slug)) in [
            ("供需弹性", "elasticity"),
            ("消费者剩余", "surplus"),
            ("市场效率", "efficiency"),
        ]
        .iter()
        .enumerate()
        {
            let id = crate::models::insert_block(conn, book, "m", i as i64 + 1, title, slug, &[])
                .unwrap();
            ids.push(id);
        }
        for id in ids.iter().take(passed) {
            conn.execute(
                "UPDATE knowledge_block SET status='passed', passed_at='2026-09-01' WHERE id=?1",
                [id],
            )
            .unwrap();
        }
        (book, ids)
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
    const REPORT: &str = "<!-- overall:4 strongest:供给与需求 weakest:市场结构 -->\n## 总体掌握度\n扎实\n## 最强模块\n供给与需求\n## 最弱模块\n市场结构\n## 薄弱点修复历程\n无\n## 建议重读章节\n无\n## 终评对话要点\n略";

    #[test]
    fn parse_report_reads_meta_and_strips_fences() {
        let (overall, s, w, body) = parse_report(&format!("```markdown\n{REPORT}\n```")).unwrap();
        assert_eq!(
            (overall, s.as_str(), w.as_str()),
            (4, "供给与需求", "市场结构")
        );
        assert!(body.starts_with("<!-- overall:4") && body.ends_with("略"));
        assert!(matches!(
            parse_report("## 没有元注释"),
            Err(CoreError::EvalParse(_))
        ));
        assert!(matches!(
            parse_report("<!-- overall:9 strongest:a weakest:b -->\nx"),
            Err(CoreError::EvalParse(_))
        ));
        assert!(matches!(
            parse_report("<!-- overall:3 strongest: weakest:b -->\nx"),
            Err(CoreError::EvalParse(_))
        ));
    }

    #[test]
    fn eligible_requires_every_unskipped_block_passed() {
        let conn = crate::db::open_in_memory().unwrap();
        let (book, ids) = seed(&conn, 2);
        assert!(!eligible(&conn, book).unwrap());
        assert!(matches!(
            start(&conn, book, "f1"),
            Err(CoreError::Conflict(_))
        ));
        // 跳过最后一块 → 其余全通过 → 可终评;书状态不影响
        conn.execute("UPDATE knowledge_block SET skipped=1 WHERE id=?1", [ids[2]])
            .unwrap();
        assert!(eligible(&conn, book).unwrap());
        crate::library::finish_book(&conn, book).unwrap();
        assert!(eligible(&conn, book).unwrap());
        assert!(matches!(eligible(&conn, 999), Err(CoreError::NotFound(_))));
    }

    #[test]
    fn start_is_idempotent_once_per_book_and_reopens_after_abandon() {
        let conn = crate::db::open_in_memory().unwrap();
        let (book, ids) = seed(&conn, 3);
        let v = start(&conn, book, "f1").unwrap();
        assert_eq!(
            (
                v.kind.as_str(),
                v.book_id,
                v.block_id,
                v.task_id,
                v.state.as_str()
            ),
            ("final_exam", Some(book), ids[0], 0, "open")
        );
        assert_eq!(start(&conn, book, "f1").unwrap().session_id, v.session_id);
        assert_eq!(start(&conn, book, "f2").unwrap().session_id, v.session_id);
        crate::session::abandon_session(&conn, v.session_id, 0).unwrap();
        let again = start(&conn, book, "f3").unwrap();
        assert_ne!(again.session_id, v.session_id);
        assert_eq!(again.state, "open");
        // 普通会话的 book_id 为 None
        assert_eq!(
            get_session(&conn, again.session_id).unwrap().book_id,
            Some(book)
        );
    }

    #[test]
    fn turns_use_phased_final_prompt_and_cap() {
        let conn = crate::db::open_in_memory().unwrap();
        let (book, _) = seed(&conn, 3);
        let sid = start(&conn, book, "f1").unwrap().session_id;
        let mock = Mock::new(&[
            "框架问题 1",
            "框架问题 2",
            "框架问题 3",
            "综合题 1",
            "综合题 2",
            "简评 [READY_TO_END]",
        ]);
        let r = turn(&conn, &mock, sid, 0, "opener", "请开始终评");
        assert!(!r.ready_to_end);
        let calls = mock.calls.borrow();
        let first = &calls[0].1;
        assert!(
            first.contains("第一阶段") && first.contains("供需弹性") && first.contains("研究者"),
            "{first}"
        );
        assert!(!first.contains("扮演一位聪明但完全没学过"));
        drop(calls);
        turn(&conn, &mock, sid, 1, "t2", "全书分三块");
        turn(&conn, &mock, sid, 2, "t3", "主线是均衡");
        // 已有 3 个学生回合 → 第二阶段(综合题)
        turn(&conn, &mock, sid, 3, "t4", "补充");
        let calls = mock.calls.borrow();
        let fourth = &calls[3].1;
        assert!(
            fourth.contains("第二阶段") && fourth.contains("综合应用题"),
            "{fourth}"
        );
        drop(calls);
        turn(&conn, &mock, sid, 4, "t5", "答 1");
        let last = turn(&conn, &mock, sid, 5, "t6", "答 2");
        assert!(last.ready_to_end);
    }

    #[test]
    fn finish_writes_report_finishes_book_and_enqueues_archive() {
        let conn = crate::db::open_in_memory().unwrap();
        let (book, ids) = seed(&conn, 3);
        conn.execute(
            "INSERT INTO weak_point(block_id,title,status,created_at,fixed_at) VALUES(?1,'弹性vs斜率','fixed','2026-08-30','2026-09-01')",
            [ids[0]],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO study_plan(book_id,deadline,daily_new_blocks) VALUES(?1,'2026-09-30',2)",
            [book],
        )
        .unwrap();
        let sid = start(&conn, book, "f1").unwrap().session_id;
        let fenced = format!("```\n{REPORT}\n```");
        let mock = Mock::new(&["问 1", "问 2", &fenced]);
        turn(&conn, &mock, sid, 0, "opener", "请开始终评");
        assert!(
            matches!(
                finish(
                    &conn,
                    &mock,
                    &std::env::temp_dir(),
                    &policy(),
                    sid,
                    1,
                    "rep"
                ),
                Err(CoreError::Conflict(_))
            ),
            "needs answers"
        );
        turn(&conn, &mock, sid, 1, "t2", "全书分三块");
        // 评估接口拒绝终评会话
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
        // 还差一次作答
        assert!(matches!(
            finish(
                &conn,
                &mock,
                &std::env::temp_dir(),
                &policy(),
                sid,
                2,
                "rep"
            ),
            Err(CoreError::Conflict(_))
        ));
        conn.execute(
            "INSERT INTO session_turn(session_id,seq,role,text,client_turn_id,status,created_at) VALUES(?1,5,'user','答','t3','done','x')",
            [sid],
        )
        .unwrap();
        let report = finish(
            &conn,
            &mock,
            &std::env::temp_dir(),
            &policy(),
            sid,
            2,
            "rep",
        )
        .unwrap();
        assert_eq!(
            (
                report.overall,
                report.strongest_module.as_str(),
                report.weakest_module.as_str(),
                report.version
            ),
            (4, "供给与需求", "市场结构", 3)
        );
        assert!(report.content_md.starts_with("<!-- overall:4"));
        let calls = mock.calls.borrow();
        let prompt = &calls.last().unwrap().1;
        assert!(
            prompt.contains("弹性vs斜率:2026-08-30 暴露 → 2026-09-01 修复")
                && prompt.contains("用户:全书分三块"),
            "{prompt}"
        );
        drop(calls);
        let (kind, block, content): (String, Option<i64>, String) = conn
            .query_row(
                "SELECT kind,block_id,content_md FROM artifact WHERE id=?1",
                [report.artifact_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(
            (kind.as_str(), block, content == report.content_md),
            ("report", None, true)
        );
        let view = get_session(&conn, sid).unwrap();
        assert_eq!(
            (view.state.as_str(), view.eval.is_none()),
            ("confirmed", true)
        );
        let (status, active): (String, i64) = conn
            .query_row("SELECT b.status, p.active FROM book b JOIN study_plan p ON p.book_id=b.id WHERE b.id=?1", [book], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();
        assert_eq!((status.as_str(), active), ("finished", 0));
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
            vec![
                "report_archive".to_string(),
                "sync_map".into(),
                "git_commit".into()
            ]
        );
        // 重放:同 id 不再调 AI;其它 id → Conflict
        let calls = mock.calls.borrow().len();
        assert_eq!(
            finish(
                &conn,
                &mock,
                &std::env::temp_dir(),
                &policy(),
                sid,
                99,
                "rep"
            )
            .unwrap(),
            report
        );
        assert_eq!(mock.calls.borrow().len(), calls);
        assert!(matches!(
            finish(
                &conn,
                &mock,
                &std::env::temp_dir(),
                &policy(),
                sid,
                3,
                "other"
            ),
            Err(CoreError::Conflict(_))
        ));
        // 投影:_report.md 出现且幂等
        let dir = tempfile::tempdir().unwrap();
        let memory = crate::memory::MemoryStore::init(dir.path()).unwrap();
        assert_eq!(crate::projection::run_pending(&conn, &memory).unwrap(), 3);
        let path = dir.path().join("books/bk/_report.md");
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(
            text.starts_with("# 学习报告 — 书\n")
                && text.contains("整书终评")
                && text.contains("## 最弱模块"),
            "{text}"
        );
        conn.execute(
            "UPDATE projection_outbox SET status='pending' WHERE kind='report_archive'",
            [],
        )
        .unwrap();
        crate::projection::run_pending(&conn, &memory).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), text);
    }

    #[test]
    fn finish_failure_reverts_to_open_and_bad_report_is_retried_then_rejected() {
        let conn = crate::db::open_in_memory().unwrap();
        let (book, _) = seed(&conn, 3);
        let sid = start(&conn, book, "f1").unwrap().session_id;
        let mock = Mock::new(&["问 1", "问 2", "没有元注释的报告", "还是没有"]);
        turn(&conn, &mock, sid, 0, "opener", "请开始终评");
        turn(&conn, &mock, sid, 1, "t2", "答 1");
        conn.execute(
            "INSERT INTO session_turn(session_id,seq,role,text,client_turn_id,status,created_at) VALUES(?1,5,'user','答','t3','done','x')",
            [sid],
        )
        .unwrap();
        let err = finish(
            &conn,
            &mock,
            &std::env::temp_dir(),
            &policy(),
            sid,
            2,
            "rep",
        )
        .unwrap_err();
        assert!(matches!(err, CoreError::EvalParse(_)), "{err:?}");
        let calls = mock.calls.borrow();
        let corrective = &calls.last().unwrap().1;
        assert!(corrective.contains("元注释"), "{corrective}");
        assert_eq!(get_session(&conn, sid).unwrap().state, "open");
        let status: String = conn
            .query_row("SELECT status FROM book WHERE id=?1", [book], |r| r.get(0))
            .unwrap();
        assert_eq!(status, "active");
    }
}
