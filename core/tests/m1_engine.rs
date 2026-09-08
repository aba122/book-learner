//! A-T10:M1 核心引擎端到端(MockProvider,不依赖 codex)。
//! 导入 spine → 地图作业 → 草图落库 → 计划 → 队列 → 会话/回合 → 评估 → 判定 → 投影重放 →
//! 重开连接(重放幂等、确认重放)→ 次日队列(薄弱点重考 + 复习 + 新块)。
//! provider 回调内用**第二连接**对同一 DB 文件写入,证明 AI 调用期间没有事务被持有。
use book_learner_core::*;
use std::cell::Cell;
use std::path::PathBuf;

const DAY0: &str = "2026-09-05";
const DAY1: &str = "2026-09-06";
const EVAL_JSON: &str = r#"评估完成:
```json
{"verdict":"pass_suggested","scores":{"accuracy":4,"completeness":4,"clarity":5},
 "summary":"讲解到位","weak_points":[{"title":"弹性vs斜率","detail":"曾混淆,未完全修复"}],
 "final_restatement":"弹性是需求量对价格的相对变化率","observation_note":"举例能力强"}
```"#;

struct EngineMock {
    db_path: PathBuf,
    turns: Cell<usize>,
    /// 最近一次回合请求的 system prompt(断言快问/费曼 prompt 选择)
    last_system: std::cell::RefCell<String>,
}
impl ai::AiProvider for EngineMock {
    fn complete(&self, req: &ai::CompletionRequest) -> Result<String> {
        if req.request_id.starts_with("turn:") {
            *self.last_system.borrow_mut() = req.system.clone();
        }
        // 无事务持有的证明:第二连接写入必须立即成功(否则 busy_timeout 5s 后报错)
        let probe = db::open(&self.db_path).unwrap();
        probe
            .execute(
                "INSERT OR REPLACE INTO setting(key,value) VALUES(?1,?2)",
                rusqlite::params![format!("probe:{}", req.request_id), req.request_id],
            )
            .expect("second connection must not be blocked by a held transaction");
        let id = req.request_id.as_str();
        if let Some(rest) = id.strip_prefix("map:") {
            if rest.ends_with(":merge") {
                return Ok(r#"{"modules":[{"name":"供给与需求","blocks":[
                    {"title":"供需弹性","summary":"","source_sections":["ch0.xhtml#S0"],"prereqs":[]},
                    {"title":"消费者剩余","summary":"","source_sections":["ch1.xhtml#S1"],"prereqs":["供需弹性"]},
                    {"title":"市场效率","summary":"","source_sections":["第二章#S2"],"prereqs":["消费者剩余"]}]}]}"#.into());
            }
            let idx: usize = rest.split(":ch").nth(1).unwrap().parse().unwrap();
            let title = ["供需弹性", "消费者剩余", "市场效率"][idx];
            return Ok(format!(
                r#"[{{"title":"{title}","summary":"s","prereq_titles":[],"source_section":"ch{idx}.xhtml#S{idx}"}}]"#
            ));
        }
        if id.starts_with("turn:") {
            self.turns.set(self.turns.get() + 1);
            return Ok(if self.turns.get() == 1 {
                "那弹性和斜率一样吗?".into()
            } else {
                "明白了,讲清楚了。[READY_TO_END]".into()
            });
        }
        if id.starts_with("eval:") {
            return Ok(EVAL_JSON.into());
        }
        Err(CoreError::Ai(format!("unexpected request {id}")))
    }
}

fn policy() -> orchestrate::AiPolicy {
    orchestrate::AiPolicy {
        retry_backoff_ms: 0,
        ..orchestrate::AiPolicy::default()
    }
}

#[test]
fn m1_engine_end_to_end() {
    let dir = tempfile::tempdir().unwrap();
    let db_path = dir.path().join("app.db");
    let mem = memory::MemoryStore::init(&dir.path().join("memory")).unwrap();
    let provider = EngineMock {
        db_path: db_path.clone(),
        turns: Cell::new(0),
        last_system: std::cell::RefCell::new(String::new()),
    };
    let conn = db::open(&db_path).unwrap();

    // 1. 建书 + 已抽取 spine(EPUB 抽取在 JS 侧,ADR-0004)
    let book = models::insert_book(
        &conn,
        "微观经济学",
        "曼昆",
        models::BookType::Textbook,
        "microecon",
    )
    .unwrap();
    let chapters: Vec<mapgen::SpineChapter> = (0..3)
        .map(|i| mapgen::SpineChapter {
            idx: i,
            href: format!("ch{i}.xhtml"),
            title: format!("第{}章", ["零", "一", "二"][i as usize]),
            text: format!("第{i}章原文:弹性是需求量对价格变动的相对反应程度。"),
        })
        .collect();
    mapgen::store_spine(&conn, book, &chapters).unwrap();

    // 2. 两阶段地图作业 → 草图落库(稳定 id + 修订号 1 + init_book 入队)
    let mut events = vec![];
    let draft = mapgen::run_map_job(
        &conn,
        &provider,
        mem.root(),
        book,
        "job-1",
        &policy(),
        &mut |e| events.push(e),
    )
    .unwrap();
    assert!(matches!(
        events.last(),
        Some(mapgen::MapProgress::Done { blocks: 3 })
    ));
    assert_eq!(map::apply_draft_map(&conn, book, &draft).unwrap(), 1);
    let blocks = models::list_blocks(&conn, book).unwrap();
    assert_eq!(blocks.len(), 3);
    let (b1, b2) = (blocks[0].id, blocks[1].id);
    assert_eq!(blocks[1].prereq_ids, vec![b1]);
    assert_eq!(
        map::list_anchors(&conn, blocks[2].id).unwrap()[0].spine_href,
        "ch2.xhtml"
    );

    // 3. 计划 + Day0 队列
    planning::set_plan(
        &conn,
        &planning::StudyPlan {
            book_id: book,
            deadline: "2026-09-30".into(),
            daily_new_blocks: 1,
            daily_cap: 4,
            remind_time: "20:00".into(),
        },
    )
    .unwrap();
    let q0 = sched::generate_daily(&conn, DAY0).unwrap();
    assert_eq!(
        q0.iter()
            .map(|t| (t.kind.as_str(), t.block_id))
            .collect::<Vec<_>>(),
        [("new", b1)]
    );

    // 4. 会话:两回合,第二回合 READY_TO_END
    let session = session::start_or_resume_session(&conn, q0[0].id, "start-1", DAY0).unwrap();
    let ctx = session::fixed_context_for_block(&conn, b1, "研究者").unwrap();
    assert!(ctx.block_source_text.contains("第0章原文"));
    let r1 = session::submit_turn(
        &conn,
        &provider,
        mem.root(),
        &policy(),
        session.session_id,
        0,
        "turn-1",
        "弹性是需求量对价格的相对变化率",
        &ctx,
        models::BookType::Textbook,
    )
    .unwrap();
    assert!(!r1.ready_to_end && r1.version == 1);
    assert!(
        provider.last_system.borrow().contains("聪明但完全没学过"),
        "learn 会话用费曼学生 prompt"
    );
    let r2 = session::submit_turn(
        &conn,
        &provider,
        mem.root(),
        &policy(),
        session.session_id,
        1,
        "turn-2",
        "不一样,斜率有单位而弹性没有",
        &ctx,
        models::BookType::Textbook,
    )
    .unwrap();
    assert!(r2.ready_to_end && r2.version == 2);
    assert_eq!(r2.student_text, "明白了,讲清楚了。");

    // 5. 评估 → 判定(用户确认通过)
    let ev = verdict::request_evaluation(
        &conn,
        &provider,
        mem.root(),
        &policy(),
        session.session_id,
        "eval-1",
        &ctx,
    )
    .unwrap();
    assert_eq!(ev.version, 3);
    let out =
        verdict::confirm_session_verdict(&conn, session.session_id, 3, "confirm-1", true, DAY0)
            .unwrap();
    assert!(out.passed && out.task_done && out.block_status == "passed" && out.outbox_ops == 4);

    // 6. 投影重放:不手工 ensure_book
    assert_eq!(projection::run_pending(&conn, &mem).unwrap(), 5);
    let root = mem.root();
    let block_md =
        std::fs::read_to_string(root.join(format!("books/microecon/blocks/{b1:04}-供需弹性.md")))
            .unwrap();
    assert!(block_md.contains("status: passed") && block_md.contains("相对变化率"));
    let wp = std::fs::read_to_string(root.join("books/microecon/_weakpoints.md")).unwrap();
    assert!(wp.contains("弹性vs斜率"));
    let map_md = std::fs::read_to_string(root.join("books/microecon/_map.md")).unwrap();
    assert!(
        map_md.contains("| 供需弹性 | passed |") && map_md.contains("| 市场效率 | unlearned |")
    );
    let log = std::process::Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["log", "--oneline"])
        .output()
        .unwrap();
    assert!(String::from_utf8_lossy(&log.stdout).contains("study: 微观经济学/供需弹性 2026-09-05"));

    // 7. provider 回调内的第二连接写入全部成功(每个 AI 请求一行 probe)
    let probes: i64 = conn
        .query_row(
            "SELECT count(*) FROM setting WHERE key LIKE 'probe:%'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(probes, 7, "3 章 + merge + 2 回合 + 1 评估");

    // 8. 重开连接:重放幂等、确认重放
    drop(conn);
    let conn = db::open(&db_path).unwrap();
    assert_eq!(projection::run_pending(&conn, &mem).unwrap(), 0);
    let replay =
        verdict::confirm_session_verdict(&conn, session.session_id, 999, "confirm-1", false, DAY0)
            .unwrap();
    assert_eq!(replay, out);
    let view = session::get_session(&conn, session.session_id).unwrap();
    assert_eq!(
        (view.state.as_str(), view.version, view.transcript.len()),
        ("confirmed", 4, 4)
    );

    // 9. 次日队列:薄弱点重考 → 到期复习 → 新块
    let q1 = sched::generate_daily(&conn, DAY1).unwrap();
    assert_eq!(
        q1.iter()
            .map(|t| (t.kind.as_str(), t.block_id))
            .collect::<Vec<_>>(),
        [("weak_retest", b1), ("review", b1), ("new", b2)]
    );

    // 10. 次日复习:快问 prompt;用户判定"未通过" → stage 重置 1、评估薄弱点去重、不插通用条目
    let review_task = q1.iter().find(|t| t.kind == "review").unwrap();
    let rs = session::start_or_resume_session(&conn, review_task.id, "start-r1", DAY1).unwrap();
    assert_eq!(rs.kind, "review");
    let ctx1 = session::fixed_context_for_block(&conn, b1, "研究者").unwrap();
    let rr = session::submit_turn(
        &conn,
        &provider,
        mem.root(),
        &policy(),
        rs.session_id,
        0,
        "opener",
        "请开始快问",
        &ctx1,
        models::BookType::Textbook,
    )
    .unwrap();
    assert!(rr.version == 1);
    {
        let sys = provider.last_system.borrow();
        assert!(sys.contains("复习考官") && sys.contains("快问"), "{sys}");
        assert!(!sys.contains("聪明但完全没学过"));
    }
    let open_before: i64 = conn
        .query_row(
            "SELECT count(*) FROM weak_point WHERE block_id=?1 AND status='open'",
            [b1],
            |r| r.get(0),
        )
        .unwrap();
    let ev1 = verdict::request_evaluation(
        &conn,
        &provider,
        mem.root(),
        &policy(),
        rs.session_id,
        "eval-r1",
        &ctx1,
    )
    .unwrap();
    let out_r = verdict::confirm_session_verdict(
        &conn,
        rs.session_id,
        ev1.version,
        "confirm-r1",
        false,
        DAY1,
    )
    .unwrap();
    assert!(!out_r.passed && out_r.task_done);
    let (failed, due_stage, due_date): (i64, i64, String) = conn
        .query_row(
            "SELECT (SELECT count(*) FROM review_schedule WHERE block_id=?1 AND status='failed'), \
                    stage, due_date FROM review_schedule WHERE block_id=?1 AND status='due'",
            [b1],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!((failed, due_stage, due_date.as_str()), (1, 1, "2026-09-07"));
    let open_after: i64 = conn
        .query_row(
            "SELECT count(*) FROM weak_point WHERE block_id=?1 AND status='open'",
            [b1],
            |r| r.get(0),
        )
        .unwrap();
    // 评估里的"弹性vs斜率"已是 open 薄弱点 → 去重;评估有薄弱点 → 不插"间隔复习未通过"
    assert_eq!(open_after, open_before);
    let generic: i64 = conn
        .query_row(
            "SELECT count(*) FROM weak_point WHERE title='间隔复习未通过'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(generic, 0);

    // 11. 薄弱点重考:retest prompt;连续 2 天通过 → fixed
    let retest = q1.iter().find(|t| t.kind == "weak_retest").unwrap();
    let ts = session::start_or_resume_session(&conn, retest.id, "start-t1", DAY1).unwrap();
    assert_eq!(ts.kind, "retest");
    session::submit_turn(
        &conn,
        &provider,
        mem.root(),
        &policy(),
        ts.session_id,
        0,
        "opener",
        "请针对我的薄弱点提问",
        &ctx1,
        models::BookType::Textbook,
    )
    .unwrap();
    assert!(provider.last_system.borrow().contains("薄弱点重考"));
    let ev_t = verdict::request_evaluation(
        &conn,
        &provider,
        mem.root(),
        &policy(),
        ts.session_id,
        "eval-t1",
        &ctx1,
    )
    .unwrap();
    verdict::confirm_session_verdict(&conn, ts.session_id, ev_t.version, "confirm-t1", true, DAY1)
        .unwrap();
    let weak_id = retest.ref_id.unwrap();
    let (streak, status): (i64, String) = conn
        .query_row(
            "SELECT pass_streak,status FROM weak_point WHERE id=?1",
            [weak_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!((streak, status.as_str()), (1, "open"));
    const DAY2: &str = "2026-09-07";
    let q2 = sched::generate_daily(&conn, DAY2).unwrap();
    let retest2 = q2
        .iter()
        .find(|t| t.kind == "weak_retest" && t.ref_id == Some(weak_id))
        .expect("weak point still open → retested again");
    let ts2 = session::start_or_resume_session(&conn, retest2.id, "start-t2", DAY2).unwrap();
    session::submit_turn(
        &conn,
        &provider,
        mem.root(),
        &policy(),
        ts2.session_id,
        0,
        "opener",
        "请针对我的薄弱点提问",
        &ctx1,
        models::BookType::Textbook,
    )
    .unwrap();
    let ev_t2 = verdict::request_evaluation(
        &conn,
        &provider,
        mem.root(),
        &policy(),
        ts2.session_id,
        "eval-t2",
        &ctx1,
    )
    .unwrap();
    verdict::confirm_session_verdict(
        &conn,
        ts2.session_id,
        ev_t2.version,
        "confirm-t2",
        true,
        DAY2,
    )
    .unwrap();
    let (streak, status): (i64, String) = conn
        .query_row(
            "SELECT pass_streak,status FROM weak_point WHERE id=?1",
            [weak_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!((streak, status.as_str()), (2, "fixed"));
}
