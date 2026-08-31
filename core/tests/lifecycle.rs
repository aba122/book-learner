//! L1-T12:块生命周期端到端集成测试(MockProvider,不依赖 codex)。
use book_learner_core::*;

struct MockProvider(String);
impl ai::AiProvider for MockProvider {
    fn complete(&self, _req: &ai::CompletionRequest) -> Result<String> { Ok(self.0.clone()) }
}

const EVAL_JSON: &str = r#"评估完成:
```json
{"verdict":"pass_suggested","scores":{"accuracy":4,"completeness":4,"clarity":5},
 "summary":"讲解到位","weak_points":[{"title":"弹性vs斜率","detail":"曾混淆,未完全修复"}],
 "final_restatement":"弹性是需求量对价格的相对变化率","observation_note":"举例能力强"}
```"#;

#[test]
fn full_block_lifecycle() {
    let dir = tempfile::tempdir().unwrap();
    let day0 = "2026-08-30";
    let day1 = "2026-08-31";

    // === Day0:建库建书 + 记忆库 ===
    let conn = db::open(&dir.path().join("app.db")).unwrap();
    let book = models::insert_book(&conn, "微观经济学", "曼昆", models::BookType::Textbook, "microecon").unwrap();
    let blk1 = models::insert_block(&conn, book, "供给与需求", 1, "供需弹性", "elasticity", &[]).unwrap();
    models::insert_block(&conn, book, "供给与需求", 2, "消费者剩余", "surplus", &[blk1]).unwrap();
    models::insert_block(&conn, book, "供给与需求", 3, "市场效率", "efficiency", &[]).unwrap();
    conn.execute("INSERT INTO study_plan(book_id,deadline,daily_new_blocks) VALUES(?1,'2026-09-30',2)", [book]).unwrap();

    let mem_root = dir.path().join("memory");
    let mem = memory::MemoryStore::init(&mem_root).unwrap();
    mem.ensure_book("microecon", "微观经济学").unwrap();

    // Day0 队列:无薄弱/复习,2 个新块
    let q0 = sched::generate_daily(&conn, day0).unwrap();
    assert_eq!(q0.iter().map(|t| t.kind.as_str()).collect::<Vec<_>>(), ["new", "new"]);
    assert_eq!(q0[0].block_id, blk1);

    // === 学块1:费曼对话(Mock)→ 评估 → SQLite 落库 → md 镜像 → git commit ===
    let provider = MockProvider(EVAL_JSON.into());
    let req = ai::CompletionRequest {
        system: prompts::eval_prompt(&prompts::FixedContext {
            profile_summary: "研究者".into(), block_title: "供需弹性".into(),
            block_source_text: "……".into(), eval_history: "".into(),
            related_weakpoints: "".into(), prereq_status: "".into(),
        }, "用户:弹性就是……\n学生:那和斜率一样吗?"),
        messages: vec![], workdir: mem_root.clone(), read_only: true, timeout_secs: 10,
    };
    let raw = ai::AiProvider::complete(&provider, &req).unwrap();
    let eval = eval::parse_eval(&raw).unwrap();

    sched::apply_eval_to_db(&conn, blk1, &eval, day0).unwrap();          // SQLite 半边
    mem.apply_eval("microecon", 1, "供需弹性", "elasticity", &eval, day0).unwrap(); // md 半边
    let (open, fixed) = sched::list_weakpoints(&conn, book).unwrap();
    mem.sync_weakpoints("microecon", &open, &fixed).unwrap();
    let blocks = models::list_blocks(&conn, book).unwrap();
    let map_rows: Vec<(String, String)> = blocks.iter().map(|b| (b.title.clone(), b.status.clone())).collect();
    mem.sync_map("microecon", "微观经济学", &map_rows).unwrap();
    mem.commit(&format!("study: 微观经济学/供需弹性 {day0}")).unwrap();

    // 断言:SQLite 状态
    let st: String = conn.query_row("SELECT status FROM knowledge_block WHERE id=?1", [blk1], |r| r.get(0)).unwrap();
    assert_eq!(st, "passed");
    assert_eq!(open.len(), 1);

    // 断言:md 镜像与块文件
    let block_md = std::fs::read_to_string(mem_root.join("books/microecon/blocks/01-elasticity.md")).unwrap();
    assert!(block_md.contains("status: passed") && block_md.contains("相对变化率"));
    let wp_md = std::fs::read_to_string(mem_root.join("books/microecon/_weakpoints.md")).unwrap();
    assert!(wp_md.contains("弹性vs斜率"));
    let map_md = std::fs::read_to_string(mem_root.join("books/microecon/_map.md")).unwrap();
    assert!(map_md.contains("| 供需弹性 | passed |"));
    let log = std::process::Command::new("git").arg("-C").arg(&mem_root)
        .args(["log", "--oneline"]).output().unwrap();
    assert!(String::from_utf8_lossy(&log.stdout).contains("供需弹性"));

    // === Day1:队列 = 薄弱点重考 → 到期复习 → 新块×2 ===
    let q1 = sched::generate_daily(&conn, day1).unwrap();
    assert_eq!(q1.iter().map(|t| t.kind.as_str()).collect::<Vec<_>>(),
               ["weak_retest", "review", "new", "new"]);
    assert_eq!(q1[0].block_id, blk1);
    assert_eq!(q1[1].block_id, blk1);

    // 薄弱点重考连续两天通过 → fixed
    let wp_id = q1[0].ref_id.unwrap();
    sched::on_weak_retest(&conn, wp_id, true, day1).unwrap();
    sched::on_weak_retest(&conn, wp_id, true, "2026-09-01").unwrap();
    let wst: String = conn.query_row("SELECT status FROM weak_point WHERE id=?1", [wp_id], |r| r.get(0)).unwrap();
    assert_eq!(wst, "fixed");

    // 复习通过 → 推进到 3 天档,due = day1+3
    let rs_id = q1[1].ref_id.unwrap();
    sched::on_review_result(&conn, rs_id, true, day1).unwrap();
    let (stage, due): (i64, String) = conn.query_row(
        "SELECT stage,due_date FROM review_schedule WHERE block_id=?1 AND status='due'",
        [blk1], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
    assert_eq!((stage, due.as_str()), (3, "2026-09-03"));
}
