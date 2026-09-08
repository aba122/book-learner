//! 投影 outbox(ADR-0001):SQLite 是事实源,md/git 由本模块按 outbox 顺序重放。
//! 入队在调用方事务内;`run_pending` 按 id 顺序处理 pending/failed 行,失败即停(保持顺序),处理器幂等。

use crate::eval::EvalResult;
use crate::memory::MemoryStore;
use crate::{CoreError, Result};
use rusqlite::{Connection, OptionalExtension};

fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

/// 在调用方事务内入队;同 op_id 已存在则忽略(幂等)。
pub fn enqueue(
    conn: &Connection,
    op_id: &str,
    kind: &str,
    payload: &serde_json::Value,
) -> Result<()> {
    enqueue_in(conn, op_id, kind, payload, "main")
}

/// 指定通道入队(M3 T5):`main` 为记忆库投影,`push` 为远程推送(独立退避,失败不阻塞 main)。
pub fn enqueue_in(
    conn: &Connection,
    op_id: &str,
    kind: &str,
    payload: &serde_json::Value,
    lane: &str,
) -> Result<()> {
    conn.execute(
        "INSERT OR IGNORE INTO projection_outbox(op_id,kind,payload,created_at,lane) VALUES(?1,?2,?3,?4,?5)",
        rusqlite::params![op_id, kind, payload.to_string(), now(), lane],
    )?;
    Ok(())
}

/// `git_commit` 之后若配置了远程,则往 push 通道补一条(op_id 派生自 commit 的 op_id,幂等)。
fn enqueue_push_after_commit(
    conn: &Connection,
    memory: &MemoryStore,
    commit_op: &str,
) -> Result<()> {
    if memory.remote_url()?.is_some() {
        enqueue_in(
            conn,
            &format!("push:{commit_op}"),
            "git_push",
            &serde_json::json!({}),
            "push",
        )?;
    }
    Ok(())
}

pub const PUSH_BACKOFF_BASE_SECS: i64 = 60;
pub const PUSH_BACKOFF_MAX_SECS: i64 = 6 * 3600;

/// push 通道:到期的 pending/failed 行一轮只推一次(push 是"推 HEAD",天然合并);成功 → 该通道全部标 done;
/// 失败 → 全部标 failed、attempts+1,`next_retry_at` 按 2^attempts 分钟指数退避(上限 6h)。返回是否推送成功。
pub fn run_push_lane(
    conn: &Connection,
    memory: &MemoryStore,
    now_rfc3339: &str,
) -> Result<Option<bool>> {
    if !conn.is_autocommit() {
        return Err(CoreError::Other(
            "run_push_lane must not be called inside a transaction".into(),
        ));
    }
    let due: i64 = conn.query_row(
        "SELECT count(*) FROM projection_outbox WHERE lane='push' AND status IN ('pending','failed')          AND (next_retry_at IS NULL OR next_retry_at <= ?1)",
        [now_rfc3339],
        |r| r.get(0),
    )?;
    if due == 0 {
        return Ok(None);
    }
    let attempts: i64 = conn.query_row(
        "SELECT COALESCE(max(attempts),0) FROM projection_outbox WHERE lane='push' AND status IN ('pending','failed')",
        [],
        |r| r.get(0),
    )?;
    match memory.push() {
        Ok(_) => {
            conn.execute(
                "UPDATE projection_outbox SET status='done', done_at=?1, error=NULL                  WHERE lane='push' AND status IN ('pending','failed')",
                [now_rfc3339],
            )?;
            Ok(Some(true))
        }
        Err(e) => {
            let wait = (PUSH_BACKOFF_BASE_SECS << attempts.min(12)).min(PUSH_BACKOFF_MAX_SECS);
            let next = chrono::DateTime::parse_from_rfc3339(now_rfc3339)
                .map(|t| (t + chrono::Duration::seconds(wait)).to_rfc3339())
                .unwrap_or_else(|_| now_rfc3339.to_string());
            conn.execute(
                "UPDATE projection_outbox SET status='failed', attempts=attempts+1, error=?1, next_retry_at=?2                  WHERE lane='push' AND status IN ('pending','failed')",
                rusqlite::params![e.to_string(), next],
            )?;
            Ok(Some(false))
        }
    }
}

fn book_slug_title(conn: &Connection, book_id: i64) -> Result<(String, String)> {
    conn.query_row("SELECT slug,title FROM book WHERE id=?1", [book_id], |r| {
        Ok((r.get(0)?, r.get(1)?))
    })
    .optional()?
    .ok_or_else(|| CoreError::NotFound(format!("book {book_id}")))
}

fn field_i64(p: &serde_json::Value, key: &str) -> Result<i64> {
    p.get(key)
        .and_then(|v| v.as_i64())
        .ok_or_else(|| CoreError::InvalidInput(format!("projection payload missing {key}")))
}

fn field_str<'a>(p: &'a serde_json::Value, key: &str) -> Result<&'a str> {
    p.get(key)
        .and_then(|v| v.as_str())
        .ok_or_else(|| CoreError::InvalidInput(format!("projection payload missing {key}")))
}

/// 处理一条投影;每种处理器都必须幂等(见 ADR-0001)。
fn process(conn: &Connection, memory: &MemoryStore, kind: &str, payload: &str) -> Result<()> {
    let p: serde_json::Value = serde_json::from_str(payload)
        .map_err(|e| CoreError::InvalidInput(format!("corrupt projection payload: {e}")))?;
    match kind {
        "init_book" => {
            let (slug, title) = book_slug_title(conn, field_i64(&p, "book_id")?)?;
            memory.ensure_book(&slug, &title)
        }
        "block_eval" => {
            let (book_slug, book_title) = book_slug_title(conn, field_i64(&p, "book_id")?)?;
            let block_id = field_i64(&p, "block_id")?;
            let (block_title, block_slug): (String, String) = conn
                .query_row(
                    "SELECT title,slug FROM knowledge_block WHERE id=?1",
                    [block_id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?
                .ok_or_else(|| CoreError::NotFound(format!("block {block_id}")))?;
            let eval: EvalResult = serde_json::from_value(
                p.get("eval")
                    .cloned()
                    .ok_or_else(|| CoreError::InvalidInput("payload missing eval".into()))?,
            )
            .map_err(|e| CoreError::InvalidInput(format!("corrupt eval in payload: {e}")))?;
            let passed = p
                .get("passed")
                .and_then(|v| v.as_bool())
                .ok_or_else(|| CoreError::InvalidInput("payload missing passed".into()))?;
            let date = field_str(&p, "date")?;
            let entry_key = field_str(&p, "entry_key")?;
            memory.ensure_book(&book_slug, &book_title)?; // 防御:init_book 可能尚未重放
            memory.apply_eval(
                &book_slug,
                block_id,
                &block_title,
                &block_slug,
                &eval,
                passed,
                entry_key,
                date,
            )
        }
        "sync_weakpoints" => {
            let book_id = field_i64(&p, "book_id")?;
            let (slug, title) = book_slug_title(conn, book_id)?;
            memory.ensure_book(&slug, &title)?;
            let (open, fixed) = crate::sched::list_weakpoints(conn, book_id)?;
            memory.sync_weakpoints(&slug, &open, &fixed)
        }
        "sync_map" => {
            let book_id = field_i64(&p, "book_id")?;
            let (slug, title) = book_slug_title(conn, book_id)?;
            memory.ensure_book(&slug, &title)?;
            let rows: Vec<(String, String)> = crate::models::list_blocks(conn, book_id)?
                .into_iter()
                .map(|b| (b.title, b.status))
                .collect();
            memory.sync_map(&slug, &title, &rows)
        }
        "extra_archive" => {
            let artifact_id = field_i64(&p, "artifact_id")?;
            let entry_key = field_str(&p, "entry_key")?;
            let (book_id, kind, block_id, content, created_at): (
                i64,
                String,
                Option<i64>,
                String,
                String,
            ) = conn
                .query_row(
                    "SELECT book_id,kind,block_id,content_md,created_at FROM artifact WHERE id=?1",
                    [artifact_id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
                )
                .optional()?
                .ok_or_else(|| CoreError::NotFound(format!("artifact {artifact_id}")))?;
            let extra = crate::extra::ExtraKind::from_artifact_kind(&kind).ok_or_else(|| {
                CoreError::InvalidInput(format!(
                    "artifact {artifact_id} kind {kind:?} is not archivable"
                ))
            })?;
            let (slug, title) = book_slug_title(conn, book_id)?;
            let block_title: String = match block_id {
                Some(id) => conn
                    .query_row("SELECT title FROM knowledge_block WHERE id=?1", [id], |r| {
                        r.get(0)
                    })
                    .optional()?
                    .unwrap_or_else(|| "(已删除的块)".into()),
                None => "(已删除的块)".into(),
            };
            memory.ensure_book(&slug, &title)?;
            let date = created_at.get(..10).unwrap_or(&created_at);
            memory.append_archive(
                &slug,
                &title,
                extra.archive_file(),
                extra.archive_title(),
                entry_key,
                &format!("{date} · {block_title}"),
                &content,
            )
        }
        "report_archive" => {
            let artifact_id = field_i64(&p, "artifact_id")?;
            let entry_key = field_str(&p, "entry_key")?;
            let (book_id, kind, content, created_at): (i64, String, String, String) = conn
                .query_row(
                    "SELECT book_id,kind,content_md,created_at FROM artifact WHERE id=?1",
                    [artifact_id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
                )
                .optional()?
                .ok_or_else(|| CoreError::NotFound(format!("artifact {artifact_id}")))?;
            if kind != "report" {
                return Err(CoreError::InvalidInput(format!(
                    "artifact {artifact_id} kind {kind:?} is not a report"
                )));
            }
            let (slug, title) = book_slug_title(conn, book_id)?;
            memory.ensure_book(&slug, &title)?;
            let date = created_at.get(..10).unwrap_or(&created_at);
            memory.append_archive(
                &slug,
                &title,
                "_report.md",
                "学习报告",
                entry_key,
                &format!("{date} · 整书终评"),
                &content,
            )
        }
        "git_commit" => memory.commit(field_str(&p, "message")?),
        other => Err(CoreError::InvalidInput(format!(
            "unknown projection kind {other:?}"
        ))),
    }
}

/// 按 id 顺序重放 pending/failed 行(failed 行 attempts+1 重试);每条成功 → done;失败 → failed+error 并停止本轮。
/// 返回本次成功处理条数。调用方不得持有事务(文件/git I/O 期间不占数据库锁)。
pub fn run_pending(conn: &Connection, memory: &MemoryStore) -> Result<usize> {
    if !conn.is_autocommit() {
        return Err(CoreError::Other(
            "run_pending must not be called inside a transaction".into(),
        ));
    }
    let rows: Vec<(i64, String, String, String)> = {
        let mut st = conn.prepare(
            "SELECT id,kind,payload,op_id FROM projection_outbox \
             WHERE status IN ('pending','failed') AND lane='main' ORDER BY id",
        )?;
        let rows = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    let mut done = 0usize;
    for (id, kind, payload, op_id) in rows {
        conn.execute(
            "UPDATE projection_outbox SET attempts=attempts+1 WHERE id=?1",
            [id],
        )?;
        match process(conn, memory, &kind, &payload) {
            Ok(()) => {
                conn.execute(
                    "UPDATE projection_outbox SET status='done', error=NULL, done_at=?2 WHERE id=?1",
                    rusqlite::params![id, now()],
                )?;
                done += 1;
                // 提交成功且配置了远程 → push 通道补一条(失败不影响本轮 main 通道)
                if kind == "git_commit" {
                    enqueue_push_after_commit(conn, memory, &op_id)?;
                }
            }
            Err(e) => {
                conn.execute(
                    "UPDATE projection_outbox SET status='failed', error=?2 WHERE id=?1",
                    rusqlite::params![id, e.to_string()],
                )?;
                break;
            }
        }
    }
    Ok(done)
}

#[cfg(test)]
mod tests {
    #[test]
    fn push_lane_is_enqueued_after_commit_and_backs_off_on_failure() {
        let dir = tempfile::tempdir().unwrap();
        let conn = crate::db::open_in_memory().unwrap();
        let memory = MemoryStore::init(&dir.path().join("memory")).unwrap();
        // 无远程:git_commit 后不产生 push 行
        enqueue(
            &conn,
            "c1",
            "git_commit",
            &serde_json::json!({"message": "one"}),
        )
        .unwrap();
        assert_eq!(run_pending(&conn, &memory).unwrap(), 1);
        let lanes: i64 = conn
            .query_row(
                "SELECT count(*) FROM projection_outbox WHERE lane='push'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(lanes, 0);
        assert_eq!(
            run_push_lane(&conn, &memory, "2026-09-08T10:00:00+00:00").unwrap(),
            None
        );
        // 本地 bare 仓库当远程:set_remote 校验可达 → commit 后自动排 push → 一轮推送成功
        let bare = dir.path().join("remote.git");
        let init = std::process::Command::new("git")
            .args(["init", "--bare", "-q"])
            .arg(&bare)
            .status()
            .unwrap();
        assert!(init.success());
        let url = bare.to_string_lossy().into_owned();
        assert_eq!(
            memory.set_remote(&url).unwrap().as_deref(),
            Some(url.as_str())
        );
        assert_eq!(memory.remote_url().unwrap().as_deref(), Some(url.as_str()));
        std::fs::write(dir.path().join("memory/profile.md"), "# 画像\n改动\n").unwrap();
        enqueue(
            &conn,
            "c2",
            "git_commit",
            &serde_json::json!({"message": "two"}),
        )
        .unwrap();
        assert_eq!(run_pending(&conn, &memory).unwrap(), 1);
        let (lane, kind, status): (String, String, String) = conn
            .query_row(
                "SELECT lane,kind,status FROM projection_outbox WHERE op_id='push:c2'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(
            (lane.as_str(), kind.as_str(), status.as_str()),
            ("push", "git_push", "pending")
        );
        assert_eq!(
            run_push_lane(&conn, &memory, "2026-09-08T10:00:00+00:00").unwrap(),
            Some(true)
        );
        let status: String = conn
            .query_row(
                "SELECT status FROM projection_outbox WHERE op_id='push:c2'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(status, "done");
        let remote_log = std::process::Command::new("git")
            .arg("-C")
            .arg(&bare)
            .args(["log", "--oneline", "--all"])
            .output()
            .unwrap();
        assert!(
            String::from_utf8_lossy(&remote_log.stdout).contains("two"),
            "{}",
            String::from_utf8_lossy(&remote_log.stderr)
        );
        // 远程失效 → 一轮只尝试一次,全部 failed 并退避;到期前不再尝试
        std::fs::remove_dir_all(&bare).unwrap();
        enqueue_in(&conn, "push:x1", "git_push", &serde_json::json!({}), "push").unwrap();
        enqueue_in(&conn, "push:x2", "git_push", &serde_json::json!({}), "push").unwrap();
        assert_eq!(
            run_push_lane(&conn, &memory, "2026-09-08T11:00:00+00:00").unwrap(),
            Some(false)
        );
        let rows: Vec<(String, i64, String)> = {
            let mut st = conn.prepare("SELECT status,attempts,next_retry_at FROM projection_outbox WHERE lane='push' AND op_id LIKE 'push:x%'").unwrap();
            st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
                .unwrap()
                .collect::<rusqlite::Result<_>>()
                .unwrap()
        };
        assert_eq!(rows.len(), 2);
        for (status, attempts, next) in &rows {
            assert_eq!((status.as_str(), *attempts), ("failed", 1));
            assert!(next.starts_with("2026-09-08T11:01:00"), "{next}");
        }
        assert_eq!(
            run_push_lane(&conn, &memory, "2026-09-08T11:00:30+00:00").unwrap(),
            None,
            "退避期内不尝试"
        );
        assert_eq!(
            run_push_lane(&conn, &memory, "2026-09-08T11:02:00+00:00").unwrap(),
            Some(false)
        );
        let (attempts, next): (i64, String) = conn
            .query_row(
                "SELECT attempts,next_retry_at FROM projection_outbox WHERE op_id='push:x1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(attempts, 2);
        assert!(
            next.starts_with("2026-09-08T11:04:00"),
            "指数退避 2 分钟:{next}"
        );
        // main 通道不受 push 失败影响
        enqueue(
            &conn,
            "c3",
            "git_commit",
            &serde_json::json!({"message": "three"}),
        )
        .unwrap();
        assert_eq!(run_pending(&conn, &memory).unwrap(), 1);
        // 清除远程后 push 为 no-op
        assert_eq!(memory.set_remote("").unwrap(), None);
        assert!(!memory.push().unwrap());
        assert!(matches!(
            memory.set_remote("-bad"),
            Err(CoreError::InvalidInput(_))
        ));
    }

    use super::*;
    use crate::ai::{AiProvider, CompletionRequest};
    use crate::eval::{DraftBlock, DraftMap, DraftModule};
    use crate::memory::MemoryStore;
    use crate::orchestrate::AiPolicy;
    use crate::prompts::FixedContext;
    use rusqlite::Connection;

    const DAY0: &str = "2026-09-05";
    const EVAL_PASS: &str = r#"{"verdict":"pass_suggested","scores":{"accuracy":4,"completeness":4,"clarity":5},
        "summary":"讲解到位","weak_points":[{"title":"弹性vs斜率","detail":"未完全修复"}],
        "final_restatement":"弹性是相对变化率","observation_note":"举例能力强"}"#;
    const EVAL_RELEARN: &str = r#"{"verdict":"relearn_suggested","scores":{"accuracy":2,"completeness":2,"clarity":3},
        "summary":"跳步","final_restatement":"r","observation_note":"跳步明显"}"#;

    struct Mock(&'static str);
    impl AiProvider for Mock {
        fn complete(&self, req: &CompletionRequest) -> crate::Result<String> {
            Ok(if req.request_id.starts_with("eval:") {
                self.0.to_string()
            } else {
                "为什么?".to_string()
            })
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
    /// 建书 → spine → 草图落库(入队 init_book)→ 计划 → 会话 → 评估 → 确认(pass);返回 (book, block1, session)
    fn confirmed_fixture(
        conn: &Connection,
        memory: &MemoryStore,
        eval_reply: &'static str,
        pass: bool,
    ) -> (i64, i64, i64) {
        let book = crate::models::insert_book(
            conn,
            "微观经济学",
            "曼昆",
            crate::models::BookType::Textbook,
            "microecon",
        )
        .unwrap();
        crate::mapgen::store_spine(
            conn,
            book,
            &[
                crate::mapgen::SpineChapter {
                    idx: 0,
                    href: "ch0.xhtml".into(),
                    title: "供给与需求".into(),
                    text: "弹性原文".into(),
                },
                crate::mapgen::SpineChapter {
                    idx: 1,
                    href: "ch1.xhtml".into(),
                    title: "剩余".into(),
                    text: "剩余原文".into(),
                },
            ],
        )
        .unwrap();
        let draft = DraftMap {
            modules: vec![DraftModule {
                name: "供给与需求".into(),
                blocks: vec![
                    DraftBlock {
                        title: "供需弹性".into(),
                        summary: String::new(),
                        source_sections: vec!["ch0.xhtml#弹性".into()],
                        prereqs: vec![],
                    },
                    DraftBlock {
                        title: "消费者剩余".into(),
                        summary: String::new(),
                        source_sections: vec!["ch1.xhtml".into()],
                        prereqs: vec!["供需弹性".into()],
                    },
                ],
            }],
        };
        crate::map::apply_draft_map(conn, book, &draft).unwrap();
        let b1 = crate::models::list_blocks(conn, book).unwrap()[0].id;
        conn.execute(
            "INSERT INTO study_plan(book_id,deadline,daily_new_blocks) VALUES(?1,'2026-09-30',1)",
            [book],
        )
        .unwrap();
        let q = crate::sched::generate_daily(conn, DAY0).unwrap();
        let mock = Mock(eval_reply);
        let s = crate::session::start_or_resume_session(conn, q[0].id, "s1", DAY0).unwrap();
        crate::session::submit_turn(
            conn,
            &mock,
            memory.root(),
            &policy(),
            s.session_id,
            0,
            "t1",
            "弹性是相对变化率",
            &ctx(),
            crate::models::BookType::Textbook,
        )
        .unwrap();
        let e = crate::verdict::request_evaluation(
            conn,
            &mock,
            memory.root(),
            &policy(),
            s.session_id,
            "e1",
            &ctx(),
        )
        .unwrap();
        crate::verdict::confirm_session_verdict(conn, s.session_id, e.version, "c1", pass, DAY0)
            .unwrap();
        (book, b1, s.session_id)
    }
    fn rows(conn: &Connection) -> Vec<(String, String, i64, Option<String>)> {
        let mut st = conn
            .prepare("SELECT kind,status,attempts,error FROM projection_outbox ORDER BY id")
            .unwrap();
        st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap()
    }
    fn git_log(root: &std::path::Path) -> String {
        let out = std::process::Command::new("git")
            .arg("-C")
            .arg(root)
            .args(["log", "--oneline"])
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout).into_owned()
    }
    fn block_md(root: &std::path::Path, b1: i64) -> String {
        std::fs::read_to_string(root.join(format!("books/microecon/blocks/{b1:04}-供需弹性.md")))
            .unwrap()
    }

    #[test]
    fn replay_projects_md_and_git_then_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let memory = MemoryStore::init(&dir.path().join("memory")).unwrap();
        let conn = crate::db::open_in_memory().unwrap();
        let (_, b1, sid) = confirmed_fixture(&conn, &memory, EVAL_PASS, true);
        assert_eq!(rows(&conn).len(), 5);
        assert_eq!(run_pending(&conn, &memory).unwrap(), 5);
        assert!(
            rows(&conn).iter().all(|r| r.1 == "done" && r.2 == 1),
            "{:?}",
            rows(&conn)
        );
        let root = memory.root();
        assert!(
            root.join("books/microecon/blocks").is_dir(),
            "init_book 建目录,不手工 ensure_book"
        );
        let md = block_md(root, b1);
        assert!(
            md.contains("status: passed") && md.contains("弹性是相对变化率"),
            "{md}"
        );
        assert!(md.contains(&format!("<!-- verdict:{sid}:c1:block_eval -->")));
        let wp = std::fs::read_to_string(root.join("books/microecon/_weakpoints.md")).unwrap();
        let (open_pos, fixed_pos) = (wp.find("## 待考").unwrap(), wp.find("## 已修复").unwrap());
        let hit = wp.find("弹性vs斜率").unwrap();
        assert!(hit > open_pos && hit < fixed_pos, "{wp}");
        let map = std::fs::read_to_string(root.join("books/microecon/_map.md")).unwrap();
        assert!(
            map.contains("| 供需弹性 | passed |") && map.contains("| 消费者剩余 | unlearned |"),
            "{map}"
        );
        let index = std::fs::read_to_string(root.join("INDEX.md")).unwrap();
        assert!(index.contains("| 微观经济学 | books/microecon/ |"));
        assert!(git_log(root).contains("study: 微观经济学/供需弹性 2026-09-05"));
        assert_eq!(run_pending(&conn, &memory).unwrap(), 0);
        assert!(git_log(root).matches("study:").count() == 1);
    }

    #[test]
    fn user_override_reaches_block_md() {
        let dir = tempfile::tempdir().unwrap();
        let memory = MemoryStore::init(&dir.path().join("memory")).unwrap();
        let conn = crate::db::open_in_memory().unwrap();
        let (_, b1, _) = confirmed_fixture(&conn, &memory, EVAL_RELEARN, true);
        run_pending(&conn, &memory).unwrap();
        let md = block_md(memory.root(), b1);
        assert!(
            md.contains("status: passed") && md.contains("通过建议 ✓"),
            "{md}"
        );
        assert!(md.contains("## 复述终稿\n\nr"), "终稿按用户判定写入: {md}");
    }

    #[test]
    fn block_eval_replay_after_crash_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let memory = MemoryStore::init(&dir.path().join("memory")).unwrap();
        let conn = crate::db::open_in_memory().unwrap();
        let (_, b1, _) = confirmed_fixture(&conn, &memory, EVAL_PASS, true);
        run_pending(&conn, &memory).unwrap();
        // 模拟"文件已写、done 未落库":把 block_eval 行改回 pending 再重放
        conn.execute(
            "UPDATE projection_outbox SET status='pending' WHERE kind='block_eval'",
            [],
        )
        .unwrap();
        assert_eq!(run_pending(&conn, &memory).unwrap(), 1);
        let md = block_md(memory.root(), b1);
        assert_eq!(md.matches("第1次").count(), 1, "{md}");
        assert_eq!(md.matches("举例能力强").count(), 1, "{md}");
        assert!(!md.contains("第2次"));
    }

    #[test]
    fn git_failure_stops_and_failed_row_retries() {
        // root 不受目录权限约束
        if unsafe { libc::geteuid() } == 0 {
            return;
        }
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let memory = MemoryStore::init(&dir.path().join("memory")).unwrap();
        let conn = crate::db::open_in_memory().unwrap();
        confirmed_fixture(&conn, &memory, EVAL_PASS, true);
        let git_dir = memory.root().join(".git");
        std::fs::set_permissions(&git_dir, std::fs::Permissions::from_mode(0o000)).unwrap();
        let n = run_pending(&conn, &memory).unwrap();
        std::fs::set_permissions(&git_dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(n, 4);
        let r = rows(&conn);
        assert!(r[..4].iter().all(|x| x.1 == "done"), "{r:?}");
        assert_eq!(r[4].0, "git_commit");
        assert_eq!(r[4].1, "failed");
        assert!(!r[4].3.clone().unwrap_or_default().is_empty());
        assert_eq!(run_pending(&conn, &memory).unwrap(), 1, "只重试失败行");
        let r = rows(&conn);
        assert_eq!((r[4].1.as_str(), r[4].2), ("done", 2));
        assert_eq!(git_log(memory.root()).matches("study:").count(), 1);
    }

    #[test]
    fn enqueue_same_op_id_is_ignored_and_unknown_kind_fails_and_stops() {
        let dir = tempfile::tempdir().unwrap();
        let memory = MemoryStore::init(&dir.path().join("memory")).unwrap();
        let conn = crate::db::open_in_memory().unwrap();
        let book =
            crate::models::insert_book(&conn, "书", "", crate::models::BookType::Textbook, "bk")
                .unwrap();
        enqueue(&conn, "x:bogus", "bogus", &serde_json::json!({})).unwrap();
        enqueue(&conn, "x:bogus", "bogus", &serde_json::json!({})).unwrap();
        enqueue(
            &conn,
            "x:init",
            "init_book",
            &serde_json::json!({ "book_id": book }),
        )
        .unwrap();
        assert_eq!(rows(&conn).len(), 2);
        assert_eq!(run_pending(&conn, &memory).unwrap(), 0);
        let r = rows(&conn);
        assert_eq!((r[0].1.as_str(), r[1].1.as_str()), ("failed", "pending"));
        assert!(r[0].3.clone().unwrap().contains("bogus"));
        assert!(
            !memory.root().join("books/bk").exists(),
            "失败行之后的行不得越过"
        );
    }
}
