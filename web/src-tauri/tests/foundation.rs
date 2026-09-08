use std::ffi::OsString;
use std::io::Write;
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};

use book_learner_app::application;
use book_learner_app::commands;
use book_learner_app::dto::{
    AnchorSegmentDto, AppSettingsDto, BookDto, DailyTaskDto, KnowledgeBlockDto, MapEditOpDto,
    MapProgressDto, SpineChapterDto, StudyPlanRequest, TurnResultDto,
};
use book_learner_app::error::{ErrorCode, IpcError};
use book_learner_app::state::{resolve_codex_bin, resolve_database_path, AppState, JobRegistry};
use book_learner_core::ai::{AiProvider, CompletionRequest};
use book_learner_core::eval::{DraftBlock, DraftMap, DraftModule, Scores};
use book_learner_core::map;
use book_learner_core::models::{Book, BookStatus, BookType, KnowledgeBlock};
use book_learner_core::projection;
use book_learner_core::sched::DailyTask;
use book_learner_core::CoreError;
use serde_json::{json, Value};
use tauri::http::{HeaderMap, HeaderName, HeaderValue};
use tauri::ipc::{CallbackFn, InvokeBody};
use tauri::test::{get_ipc_response, mock_builder, mock_context, noop_assets, INVOKE_KEY};
use tauri::webview::InvokeRequest;
use tauri::Listener;
use tracing_subscriber::fmt::MakeWriter;

#[test]
fn dto_json_matches_the_camel_case_frontend_contract() {
    let book = BookDto::from(Book {
        id: 7,
        title: "系统思考".into(),
        author: "作者".into(),
        book_type: BookType::Methodology,
        slug: "systems".into(),
        status: BookStatus::Paused,
        map_revision: 3,
    });
    assert_eq!(
        serde_json::to_value(book).unwrap(),
        json!({
            "id": 7, "title": "系统思考", "author": "作者",
            "type": "methodology", "slug": "systems", "status": "paused", "mapRevision": 3
        })
    );

    let block = KnowledgeBlockDto::try_from(KnowledgeBlock {
        id: 11,
        book_id: 7,
        module_name: "反馈".into(),
        seq: 2,
        title: "增强回路".into(),
        slug: "reinforcing-loop".into(),
        prereq_ids: vec![9, 10],
        status: "passed".into(),
        scores: Some(Scores {
            accuracy: 4,
            completeness: 3,
            clarity: 5,
        }),
        passed_at: Some("2026-09-01".into()),
        skipped: false,
    })
    .unwrap();
    assert_eq!(
        serde_json::to_value(block).unwrap(),
        json!({
            "id": 11, "bookId": 7, "moduleName": "反馈", "seq": 2,
            "title": "增强回路", "slug": "reinforcing-loop", "prereqIds": [9, 10],
            "status": "passed", "scores": {"accuracy": 4, "completeness": 3, "clarity": 5},
            "passedAt": "2026-09-01", "skipped": false
        })
    );

    let task = DailyTaskDto::from(DailyTask {
        id: 21,
        book_id: 7,
        block_id: 11,
        kind: "weak_retest".into(),
        seq: 1,
        status: "pending".into(),
        est_minutes: 10,
        ref_id: None,
    });
    assert_eq!(
        serde_json::to_value(task).unwrap(),
        json!({
            "id": 21, "bookId": 7, "blockId": 11, "kind": "weak_retest",
            "seq": 1, "status": "pending", "estMinutes": 10
        })
    );

    let settings = AppSettingsDto {
        obsidian_vault: "/Users/reader/Notes".into(),
        pomodoro_minutes: 30,
        break_minutes: 8,
        remind_time: "20:30".into(),
    };
    assert_eq!(
        serde_json::to_value(settings).unwrap(),
        json!({
            "obsidianVault": "/Users/reader/Notes", "pomodoroMinutes": 30,
            "breakMinutes": 8, "remindTime": "20:30"
        })
    );
}

#[test]
fn command_request_dtos_deserialize_camel_case_json() {
    let request: StudyPlanRequest = serde_json::from_value(json!({
        "bookId": 4,
        "deadline": "2026-10-01",
        "dailyNewBlocks": 2,
        "dailyCap": 4,
        "remindTime": "21:00"
    }))
    .unwrap();
    assert_eq!(request.book_id, 4);
    assert_eq!(request.daily_new_blocks, 2);

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct PlanPayload {
        request: StudyPlanRequest,
    }
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct QueuePayload {
        date: String,
    }
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct SettingsPayload {
        settings: AppSettingsDto,
    }

    let plan: PlanPayload = serde_json::from_value(json!({"request": {
        "bookId": 4, "deadline": "2026-10-01", "dailyNewBlocks": 2,
        "dailyCap": 4, "remindTime": "21:00"
    }}))
    .unwrap();
    assert_eq!(plan.request.book_id, 4);
    let queue: QueuePayload = serde_json::from_value(json!({"date": "2026-09-01"})).unwrap();
    assert_eq!(queue.date, "2026-09-01");
    let settings: SettingsPayload = serde_json::from_value(json!({"settings": {
        "obsidianVault": "/Notes", "pomodoroMinutes": 25,
        "breakMinutes": 5, "remindTime": "21:00"
    }}))
    .unwrap();
    assert_eq!(settings.settings.obsidian_vault, "/Notes");
}

#[test]
fn error_codes_are_snake_case_and_core_errors_map_to_safe_stable_payloads() {
    assert_eq!(
        serde_json::to_value(ErrorCode::InvalidRequest).unwrap(),
        "invalid_request"
    );
    assert_eq!(
        serde_json::to_value(ErrorCode::DbUnavailable).unwrap(),
        "db_unavailable"
    );

    let cases = [
        (
            CoreError::InvalidInput("private request".into()),
            ErrorCode::InvalidRequest,
            "请求参数无效",
            false,
        ),
        (
            CoreError::NotFound("private row".into()),
            ErrorCode::NotFound,
            "未找到请求的数据",
            false,
        ),
        (
            CoreError::Conflict("private constraint".into()),
            ErrorCode::Conflict,
            "数据状态冲突，请刷新后重试",
            false,
        ),
        (
            CoreError::Db(rusqlite::Error::InvalidQuery),
            ErrorCode::DbUnavailable,
            "无法读取本地学习数据",
            true,
        ),
        (
            CoreError::Io(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "/private/secret/app.db",
            )),
            ErrorCode::IoFailure,
            "无法访问本地文件",
            true,
        ),
        (
            CoreError::Other("corrupt database data: transcript fixture".into()),
            ErrorCode::Internal,
            "应用内部错误",
            false,
        ),
    ];

    for (source, code, message, retryable) in cases {
        let ipc = IpcError::from(source);
        assert_eq!(ipc.code, code);
        assert_eq!(ipc.message, message);
        assert_eq!(ipc.retryable, retryable);
        assert_eq!(ipc.details, None);
        let serialized = serde_json::to_string(&ipc).unwrap();
        assert!(!serialized.contains("/private/secret/app.db"));
        assert!(!serialized.contains("transcript fixture"));
        assert!(!serialized.contains("internal_cause"));
    }
}

fn spine_chapter_json() -> Value {
    json!({"idx": 0, "href": "ch0.xhtml", "title": "第一章", "text": "第一章原文:弹性是相对变化率。"})
}

fn anchor_segment_json() -> Value {
    json!({
        "spineHref": "ch0.xhtml", "cfiStart": "epubcfi(/6/2!/4/2)", "cfiEnd": "epubcfi(/6/2!/4/4)",
        "precision": "exact", "hint": "第一章", "text": "弹性是相对变化率。"
    })
}

/// 为 `book_id` 存一章 spine 并落一张单块草图(不经 AI),返回该块 id;书的 map_revision 变为 1。
fn seed_map(state: &AppState, book_id: i64) -> i64 {
    let chapter: SpineChapterDto = serde_json::from_value(spine_chapter_json()).unwrap();
    commands::map_store_spine_inner(state, book_id, vec![chapter]).unwrap();
    let draft = DraftMap {
        modules: vec![DraftModule {
            name: "模块一".into(),
            blocks: vec![DraftBlock {
                title: "供需弹性".into(),
                summary: String::new(),
                source_sections: vec!["ch0.xhtml#第一章".into()],
                prereqs: vec![],
            }],
        }],
    };
    let revision = state
        .with_connection(|connection| map::apply_draft_map(connection, book_id, &draft))
        .unwrap();
    assert_eq!(revision, 1);
    commands::map_list_blocks_inner(state, book_id).unwrap()[0].id
}

#[test]
fn map_group_commands_round_trip_and_expose_revision_and_skipped() {
    let directory = tempfile::tempdir().unwrap();
    let (state, first, second, _) = seeded_state(&directory.path().join("app.db"));
    let block_id = seed_map(&state, second);

    let books = commands::library_list_books_inner(&state).unwrap();
    let revision_of = |id: i64| {
        books
            .iter()
            .find(|book| book.id == id)
            .unwrap()
            .map_revision
    };
    assert_eq!(revision_of(first), 0);
    assert_eq!(revision_of(second), 1);
    assert_eq!(
        serde_json::to_value(&books[1]).unwrap()["mapRevision"],
        json!(1)
    );

    let blocks = commands::map_list_blocks_inner(&state, second).unwrap();
    assert_eq!(blocks.len(), 1);
    assert!(!blocks[0].skipped);
    assert_eq!(
        serde_json::to_value(&blocks[0]).unwrap()["skipped"],
        json!(false)
    );
    // 草图落库的 chapter_fallback 锚点带 hint
    let anchors = commands::map_list_anchors_inner(&state, block_id).unwrap();
    assert_eq!(anchors.len(), 1);
    assert_eq!(anchors[0].precision, "chapter_fallback");
    assert_eq!(anchors[0].hint, "第一章");

    // 编辑确认:TS 形状的 ops 经 serde 判别字段 `op` 反序列化
    let ops: Vec<MapEditOpDto> = serde_json::from_value(json!([
        {"op": "setSkipped", "blockId": block_id, "skipped": true},
        {"op": "rename", "blockId": block_id, "title": "价格弹性"},
        {"op": "renameModule", "from": "模块一", "to": "供给与需求"},
        {"op": "reorder", "blockIds": [block_id]}
    ]))
    .unwrap();
    assert_eq!(
        ops[0],
        MapEditOpDto::SetSkipped {
            block_id,
            skipped: true
        }
    );
    assert!(
        serde_json::from_value::<MapEditOpDto>(json!({"op": "explode", "blockId": 1})).is_err()
    );
    let confirmed = commands::map_confirm_inner(&state, second, 1, ops).unwrap();
    assert_eq!(confirmed.revision, 2);
    let blocks = commands::map_list_blocks_inner(&state, second).unwrap();
    assert!(blocks[0].skipped);
    assert_eq!(blocks[0].title, "价格弹性");
    assert_eq!(blocks[0].module_name, "供给与需求");
    // 过期修订号 → conflict;负数 → invalid_request
    assert_eq!(
        commands::map_confirm_inner(&state, second, 1, vec![])
            .unwrap_err()
            .code,
        ErrorCode::Conflict
    );
    assert_eq!(
        commands::map_confirm_inner(&state, second, -1, vec![])
            .unwrap_err()
            .code,
        ErrorCode::InvalidRequest
    );

    // 锚点段往返(替换语义)
    let segment: AnchorSegmentDto = serde_json::from_value(anchor_segment_json()).unwrap();
    commands::map_set_anchor_segments_inner(&state, block_id, vec![segment.clone()]).unwrap();
    assert_eq!(
        commands::map_list_anchors_inner(&state, block_id).unwrap(),
        vec![segment]
    );
    let bad: AnchorSegmentDto = serde_json::from_value(json!({
        "spineHref": "ch0.xhtml", "cfiStart": "", "cfiEnd": "", "precision": "guess", "hint": "", "text": ""
    }))
    .unwrap();
    assert_eq!(
        commands::map_set_anchor_segments_inner(&state, block_id, vec![bad])
            .unwrap_err()
            .code,
        ErrorCode::InvalidRequest
    );
    assert_eq!(
        commands::map_list_anchors_inner(&state, i64::MAX)
            .unwrap()
            .len(),
        0
    );
}

#[test]
fn native_import_over_ipc_stages_raw_chunks_finalizes_and_serves_managed_paths() {
    let directory = tempfile::tempdir().unwrap();
    let (state, _mock) = state_with_mock(&directory.path().join("ipc.db"));
    let (_, second, _) = seed_books(&state);
    let second_block = seed_map(&state, second);
    let books_dir = state.books_dir();
    let app = book_learner_app::register_commands(mock_builder().manage(state))
        .build(mock_context(noop_assets()))
        .unwrap();
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();

    let epub = fake_epub();
    let (head, tail) = epub.split_at(epub.len() / 2);
    let staged = invoke_raw(
        &webview,
        "library_import_epub_chunk",
        head.to_vec(),
        &[("x-op-id", "op-ipc"), ("x-chunk-index", "0")],
    )
    .unwrap();
    assert_eq!(staged["stagedBytes"], json!(head.len()));
    let staged = invoke_raw(
        &webview,
        "library_import_epub_chunk",
        tail.to_vec(),
        &[("x-op-id", "op-ipc"), ("x-chunk-index", "1")],
    )
    .unwrap();
    assert_eq!(staged["stagedBytes"], json!(epub.len()));
    // 缺头部 / JSON 体 → invalid_request
    let error = invoke_raw(
        &webview,
        "library_import_epub_chunk",
        epub.clone(),
        &[("x-op-id", "op-ipc")],
    )
    .unwrap_err();
    assert_eq!(error["code"], "invalid_request");
    let error = invoke_json(
        &webview,
        "library_import_epub_chunk",
        json!({"opId": "op-ipc"}),
    )
    .unwrap_err();
    assert_eq!(error["code"], "invalid_request");

    let result = invoke_json(
        &webview,
        "library_import_epub_finalize",
        json!({"opId": "op-ipc", "bookType": "methodology", "title": "系统之美"}),
    )
    .unwrap();
    let book_id = result["bookId"].as_i64().unwrap();
    assert!(books_dir.join(format!("{book_id}.epub")).is_file());
    // 同 op 再次 finalize → 同一 bookId;非法 bookType → invalid_request
    let again = invoke_json(
        &webview,
        "library_import_epub_finalize",
        json!({"opId": "op-ipc", "bookType": "methodology", "title": "x"}),
    )
    .unwrap();
    assert_eq!(again["bookId"], json!(book_id));
    let error = invoke_json(
        &webview,
        "library_import_epub_finalize",
        json!({"opId": "op-none", "bookType": "novel", "title": "x"}),
    )
    .unwrap_err();
    assert_eq!(error["code"], "invalid_request");

    // 受管路径:只由 book_id 决定;无文件的书 → not_found
    let path = invoke_json(&webview, "library_epub_url", json!({"bookId": book_id})).unwrap();
    assert_eq!(
        path,
        json!(books_dir.join(format!("{book_id}.epub")).to_string_lossy())
    );
    let error = invoke_json(&webview, "library_epub_url", json!({"bookId": second})).unwrap_err();
    assert_eq!(error["code"], "not_found");
    let error = invoke_json(&webview, "library_epub_url", json!({"bookId": i64::MAX})).unwrap_err();
    assert_eq!(error["code"], "not_found");

    // 块原文:草图落库的 chapter_fallback → 整章 spine 文本;设 exact 段后 → 段文本
    let source = invoke_json(
        &webview,
        "map_block_source",
        json!({"blockId": second_block}),
    )
    .unwrap();
    assert_eq!(source["href"], json!("ch0.xhtml"));
    assert_eq!(source["text"], spine_chapter_json()["text"]);
    invoke_json(
        &webview,
        "map_set_anchor_segments",
        json!({"blockId": second_block, "segments": [anchor_segment_json()]}),
    )
    .unwrap();
    let source = invoke_json(
        &webview,
        "map_block_source",
        json!({"blockId": second_block}),
    )
    .unwrap();
    assert_eq!(source["text"], anchor_segment_json()["text"]);
    let error =
        invoke_json(&webview, "map_block_source", json!({"blockId": i64::MAX})).unwrap_err();
    assert_eq!(error["code"], "not_found");
}

#[test]
fn job_registry_counts_in_flight_work_and_orderly_shutdown_waits_within_grace() {
    let jobs = Arc::new(JobRegistry::default());
    assert_eq!(jobs.in_flight(), 0);
    assert!(jobs.wait_idle(std::time::Duration::from_millis(10)));

    let started = std::time::Instant::now();
    let worker_jobs = Arc::clone(&jobs);
    let worker = std::thread::spawn(move || {
        let _guard = worker_jobs.begin();
        std::thread::sleep(std::time::Duration::from_millis(300));
    });
    // 让工作线程先拿到守卫
    while jobs.in_flight() == 0 && started.elapsed() < std::time::Duration::from_secs(2) {
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    assert_eq!(jobs.in_flight(), 1);
    assert!(
        !jobs.wait_idle(std::time::Duration::from_millis(30)),
        "should time out while busy"
    );
    assert!(
        jobs.wait_idle(std::time::Duration::from_secs(5)),
        "should become idle after the job ends"
    );
    worker.join().unwrap();
    assert_eq!(jobs.in_flight(), 0);

    // 状态级封装:空闲立即返回 true;持有守卫且宽限极短 → false
    let directory = tempfile::tempdir().unwrap();
    let state = AppState::open(&directory.path().join("app.db")).unwrap();
    assert!(book_learner_app::orderly_shutdown(
        &state,
        std::time::Duration::from_millis(10)
    ));
    let guard = state.jobs().begin();
    assert!(!book_learner_app::orderly_shutdown(
        &state,
        std::time::Duration::from_millis(10)
    ));
    drop(guard);
    assert!(book_learner_app::orderly_shutdown(
        &state,
        std::time::Duration::from_millis(10)
    ));
}

#[test]
fn stats_get_scopes_to_the_active_book_and_reflects_confirmed_verdicts() {
    let directory = tempfile::tempdir().unwrap();
    let (state, _mock) = state_with_mock(&directory.path().join("app.db"));
    let (first, _, block) = seed_books(&state);
    let (task_a, _) = seed_two_tasks(&state, first, block, DAY);
    let before = commands::stats_get_inner(&state, DAY).unwrap();
    assert_eq!(
        (
            before.total_blocks,
            before.passed_blocks,
            before.streak_days,
            before.minutes_today
        ),
        (2, 0, 0, 0)
    );
    // 走一遍闭环:通过后块 passed、任务 done、薄弱点入库
    let sid = commands::session_start_or_resume_inner(&state, task_a, "req-a", DAY)
        .unwrap()
        .session_id;
    commands::session_submit_turn_inner(&state, sid, 0, "turn-1", "弹性是相对变化率").unwrap();
    let evaluation = commands::session_request_evaluation_inner(&state, sid, "eval").unwrap();
    commands::session_confirm_verdict_inner(&state, sid, evaluation.version, "verdict", true, DAY)
        .unwrap();
    let after = commands::stats_get_inner(&state, DAY).unwrap();
    assert_eq!(
        (after.total_blocks, after.passed_blocks, after.streak_days),
        (2, 1, 1)
    );
    assert!(after.minutes_today > 0, "{after:?}");
    assert_eq!(after.open_weak_points, 1, "{after:?}");
    assert_eq!(
        serde_json::to_value(&after).unwrap()["openWeakPoints"],
        json!(1)
    );
    assert_eq!(
        commands::stats_get_inner(&state, "07/09/2026")
            .unwrap_err()
            .code,
        ErrorCode::InvalidRequest
    );
}

#[test]
fn planning_check_behind_and_get_plan_expose_replan_numbers() {
    let directory = tempfile::tempdir().unwrap();
    let (state, first, second, block) = seeded_state(&directory.path().join("app.db"));
    assert_eq!(
        commands::planning_get_plan_inner(&state, second).unwrap(),
        None
    );
    let (_, _) = seed_two_tasks(&state, first, block, DAY); // first:两块 + 计划(每日 2,上限 4)
    let plan = commands::planning_get_plan_inner(&state, first)
        .unwrap()
        .expect("first has a plan");
    assert_eq!(
        (plan.book_id, plan.daily_new_blocks, plan.daily_cap),
        (first, 2, 4)
    );
    assert_eq!(
        serde_json::to_value(&plan).unwrap()["dailyNewBlocks"],
        json!(2)
    );

    // 未落后:on_track,但仍带剩余块/剩余天/截止/上限
    let report = commands::planning_check_behind_inner(&state, first, DAY).unwrap();
    assert_eq!(report.status, "on_track");
    assert_eq!(
        (
            report.remaining_blocks,
            report.daily_cap,
            report.deadline.as_str()
        ),
        (2, 4, "2026-10-01")
    );
    assert!(report.remaining_days > 0);
    let json = serde_json::to_value(&report).unwrap();
    assert!(
        json.get("newDaily").is_none() && json.get("requiredDaily").is_none(),
        "{json}"
    );

    // 连续两天新块未完成 → 落后;截止=今天、上限 1 → needs_decision(required 2 > cap 1)
    state
        .with_connection(|connection| {
            for date in ["2026-08-30", "2026-08-31"] {
                connection.execute(
                    "INSERT INTO daily_task(date,book_id,block_id,kind,seq) VALUES(?1,?2,?3,'new',9)",
                    rusqlite::params![date, first, block],
                )?;
            }
            connection.execute(
                "UPDATE study_plan SET deadline=?2, daily_new_blocks=1, daily_cap=1 WHERE book_id=?1",
                rusqlite::params![first, DAY],
            )?;
            Ok(())
        })
        .unwrap();
    let report = commands::planning_check_behind_inner(&state, first, DAY).unwrap();
    assert_eq!(
        (
            report.status.as_str(),
            report.required_daily,
            report.remaining_days
        ),
        ("needs_decision", Some(2), 1)
    );
    assert_eq!(
        serde_json::to_value(&report).unwrap()["requiredDaily"],
        json!(2)
    );
    // 上限放宽到 4 → 自动均摊为每日 2(写回计划),不再需要决定
    state
        .with_connection(|connection| {
            connection.execute(
                "UPDATE study_plan SET daily_cap=4 WHERE book_id=?1",
                [first],
            )?;
            Ok(())
        })
        .unwrap();
    let report = commands::planning_check_behind_inner(&state, first, DAY).unwrap();
    assert_eq!(
        (report.status.as_str(), report.new_daily),
        ("auto_adjusted", Some(2))
    );
    assert_eq!(
        commands::planning_get_plan_inner(&state, first)
            .unwrap()
            .unwrap()
            .daily_new_blocks,
        2
    );
    assert_eq!(
        commands::planning_check_behind_inner(&state, first, "2026/09/01")
            .unwrap_err()
            .code,
        ErrorCode::InvalidRequest
    );
    // 无计划的书:on_track 且不报错
    assert_eq!(
        commands::planning_check_behind_inner(&state, second, DAY)
            .unwrap()
            .status,
        "on_track"
    );
}

fn seeded_state(path: &Path) -> (AppState, i64, i64, i64) {
    let state = AppState::open(path).unwrap();
    let (first, second, block) = seed_books(&state);
    (state, first, second, block)
}

/// 两本书(first 活跃且有一块;second 暂停、无块)。
fn seed_books(state: &AppState) -> (i64, i64, i64) {
    state
        .with_connection(|connection| {
            let first = book_learner_core::models::insert_book(
                connection,
                "第一本",
                "甲",
                BookType::Textbook,
                "first",
            )?;
            let second = book_learner_core::models::insert_book(
                connection,
                "第二本",
                "乙",
                BookType::Humanities,
                "second",
            )?;
            connection.execute("UPDATE book SET status='paused' WHERE id=?1", [second])?;
            let block = book_learner_core::models::insert_block(
                connection,
                first,
                "模块一",
                1,
                "知识块",
                "block",
                &[],
            )?;
            Ok((first, second, block))
        })
        .unwrap()
}

const DAY: &str = "2026-09-01";
const EVAL_JSON: &str = r#"{"verdict":"pass_suggested","scores":{"accuracy":4,"completeness":4,"clarity":5},
    "summary":"讲解到位","weak_points":[{"title":"弹性vs斜率","detail":"曾混淆,未完全修复"}],
    "final_restatement":"弹性是需求量对价格的相对变化率","observation_note":"举例能力强"}"#;

/// 假 provider:按 request_id 前缀/后缀回应地图 Stage A/B、学生回合(第二回合 READY_TO_END)与评估;
/// 计数用于断言"已有地图不重跑"与"同 clientTurnId 重放不再调 provider"。
struct EngineMock {
    calls: Mutex<usize>,
    turns: Mutex<usize>,
    /// AI 调用期间观察到的在飞任务数(证明慢命令持有 JobGuard)
    jobs: Mutex<Option<Arc<JobRegistry>>>,
    observed_in_flight: Mutex<Vec<usize>>,
}

impl EngineMock {
    fn calls(&self) -> usize {
        *self.calls.lock().unwrap()
    }
}

impl AiProvider for EngineMock {
    fn complete(&self, request: &CompletionRequest) -> book_learner_core::Result<String> {
        *self.calls.lock().unwrap() += 1;
        if let Some(jobs) = self.jobs.lock().unwrap().as_ref() {
            self.observed_in_flight
                .lock()
                .unwrap()
                .push(jobs.in_flight());
        }
        let id = request.request_id.as_str();
        if id.starts_with("turn:") {
            let mut turns = self.turns.lock().unwrap();
            *turns += 1;
            return Ok(if *turns == 1 {
                "那弹性和斜率一样吗?".into()
            } else {
                "明白了,讲清楚了。[READY_TO_END]".into()
            });
        }
        if id.starts_with("eval:") {
            return Ok(EVAL_JSON.into());
        }
        if id.ends_with(":merge") {
            return Ok(r#"{"modules":[{"name":"供给与需求","blocks":[
                {"title":"供需弹性","summary":"","source_sections":["ch0.xhtml#第一章"],"prereqs":[]}]}]}"#
                .into());
        }
        if id.starts_with("map:") {
            return Ok(
                r#"[{"title":"供需弹性","summary":"s","prereq_titles":[],"source_section":"ch0.xhtml#第一章"}]"#
                    .into(),
            );
        }
        Err(CoreError::Ai(format!("unexpected request {id}")))
    }
}

fn state_with_mock(path: &Path) -> (AppState, Arc<EngineMock>) {
    let mock = Arc::new(EngineMock {
        calls: Mutex::new(0),
        turns: Mutex::new(0),
        jobs: Mutex::new(None),
        observed_in_flight: Mutex::new(Vec::new()),
    });
    let state = AppState::open(path)
        .unwrap()
        .with_provider(Arc::clone(&mock) as Arc<dyn AiProvider + Send + Sync>);
    *mock.jobs.lock().unwrap() = Some(Arc::clone(state.jobs()));
    (state, mock)
}

/// 给 `first` 加第二块并设"每日 2 新块"的计划,生成 `date` 队列;返回 (block 的任务 id, 第二块的任务 id)。
fn seed_two_tasks(state: &AppState, first: i64, block: i64, date: &str) -> (i64, i64) {
    let block2 = state
        .with_connection(|connection| {
            book_learner_core::models::insert_block(
                connection,
                first,
                "模块一",
                2,
                "第二块",
                "block-2",
                &[],
            )
        })
        .unwrap();
    application::set_plan(
        state,
        StudyPlanRequest {
            book_id: first,
            deadline: "2026-10-01".into(),
            daily_new_blocks: 2,
            daily_cap: 4,
            remind_time: "21:00".into(),
        },
    )
    .unwrap();
    let queue = application::today_queue(state, date).unwrap();
    let task_of = |wanted: i64| {
        queue
            .iter()
            .find(|task| task.block_id == wanted && task.kind == "new")
            .map(|task| task.id)
            .unwrap_or_else(|| panic!("no new task for block {wanted}: {queue:?}"))
    };
    (task_of(block), task_of(block2))
}

#[test]
fn session_group_commands_run_the_feynman_loop_with_idempotent_ids_and_versions() {
    let directory = tempfile::tempdir().unwrap();
    let (state, mock) = state_with_mock(&directory.path().join("app.db"));
    let (first, _, block) = seed_books(&state);
    let (task_a, task_b) = seed_two_tasks(&state, first, block, DAY);

    // 开始/续接:同 clientRequestId 幂等;日期不符 → not_found
    let view = commands::session_start_or_resume_inner(&state, task_a, "req-a", DAY).unwrap();
    assert_eq!(
        (
            view.state.as_str(),
            view.version,
            view.block_id,
            view.kind.as_str()
        ),
        ("open", 0, block, "learn")
    );
    assert!(view.transcript.is_empty() && view.eval.is_none());
    let view_json = serde_json::to_value(&view).unwrap();
    assert_eq!(view_json["eval"], Value::Null);
    assert_eq!(view_json["sessionId"], json!(view.session_id));
    let sid = view.session_id;
    assert_eq!(
        commands::session_start_or_resume_inner(&state, task_a, "req-a", DAY)
            .unwrap()
            .session_id,
        sid
    );
    assert_eq!(
        commands::session_start_or_resume_inner(&state, task_a, "req-x", "2026-09-02")
            .unwrap_err()
            .code,
        ErrorCode::NotFound
    );

    // 回合:学生追问;同 clientTurnId 重放不再调 provider;过期版本 → conflict;空文本 → invalid_request
    let turn =
        commands::session_submit_turn_inner(&state, sid, 0, "turn-1", "弹性是相对变化率").unwrap();
    assert_eq!(
        turn,
        TurnResultDto {
            student_text: "那弹性和斜率一样吗?".into(),
            ready_to_end: false,
            version: 1
        }
    );
    let calls_after_turn = mock.calls();
    assert_eq!(
        commands::session_submit_turn_inner(&state, sid, 0, "turn-1", "弹性是相对变化率").unwrap(),
        turn
    );
    assert_eq!(mock.calls(), calls_after_turn);
    assert_eq!(
        commands::session_submit_turn_inner(&state, sid, 0, "turn-2", "再讲")
            .unwrap_err()
            .code,
        ErrorCode::Conflict
    );
    assert_eq!(
        commands::session_submit_turn_inner(&state, sid, 1, "turn-2", "  ")
            .unwrap_err()
            .code,
        ErrorCode::InvalidRequest
    );
    let turn2 =
        commands::session_submit_turn_inner(&state, sid, 1, "turn-2", "不一样,斜率有单位").unwrap();
    assert!(turn2.ready_to_end && turn2.version == 2, "{turn2:?}");
    assert_eq!(turn2.student_text, "明白了,讲清楚了。");
    let view = commands::session_start_or_resume_inner(&state, task_a, "req-a", DAY).unwrap();
    assert_eq!(view.transcript.len(), 4);
    let transcript = serde_json::to_value(&view.transcript).unwrap();
    assert_eq!(transcript[0]["clientTurnId"], json!("turn-1"));
    assert_eq!(transcript[1]["clientTurnId"], Value::Null);
    assert_eq!(transcript[3]["readyToEnd"], json!(true));

    // 未评估即判定 → conflict;评估(requestId 固定 'eval')→ camelCase JSON
    assert_eq!(
        commands::session_confirm_verdict_inner(&state, sid, 2, "verdict", true, DAY)
            .unwrap_err()
            .code,
        ErrorCode::Conflict
    );
    let evaluation = commands::session_request_evaluation_inner(&state, sid, "eval").unwrap();
    assert_eq!(
        (evaluation.eval.verdict.as_str(), evaluation.version),
        ("pass_suggested", 3)
    );
    let eval_json = serde_json::to_value(&evaluation).unwrap();
    assert_eq!(
        eval_json["eval"]["weakPoints"][0]["fixedInSession"],
        json!(false)
    );
    assert!(eval_json["eval"]["finalRestatement"].is_string());
    assert!(eval_json["eval"]["observationNote"].is_string());

    // 判定:用户确认通过;同 requestId 重放返回同一结果(忽略版本);块状态流转
    let outcome =
        commands::session_confirm_verdict_inner(&state, sid, 3, "verdict", true, DAY).unwrap();
    assert!(
        outcome.passed && outcome.task_done && outcome.block_status == "passed",
        "{outcome:?}"
    );
    assert!(
        outcome.outbox_ops > 0 && outcome.version == 4,
        "{outcome:?}"
    );
    assert_eq!(
        commands::session_confirm_verdict_inner(&state, sid, 999, "verdict", false, DAY).unwrap(),
        outcome
    );
    assert_eq!(
        serde_json::to_value(&outcome).unwrap()["blockStatus"],
        json!("passed")
    );
    assert_eq!(
        commands::map_get_block_inner(&state, block).unwrap().status,
        "passed"
    );
    // 投影重放(command 层异步触发的是同一函数)→ 记忆库出现块 md
    assert!(book_learner_app::run_startup_recovery(&state).unwrap() > 0);
    let blocks_dir = state
        .memory_root()
        .join("books")
        .join("first")
        .join("blocks");
    assert!(
        std::fs::read_dir(&blocks_dir).unwrap().next().is_some(),
        "{blocks_dir:?}"
    );

    // 已确认会话不可放弃 → conflict;会话 B 可放弃,再次放弃 → conflict;不存在的会话 → not_found
    assert_eq!(
        commands::session_abandon_inner(&state, sid, 4)
            .unwrap_err()
            .code,
        ErrorCode::Conflict
    );
    let sid_b = commands::session_start_or_resume_inner(&state, task_b, "req-b", DAY)
        .unwrap()
        .session_id;
    commands::session_abandon_inner(&state, sid_b, 0).unwrap();
    assert_eq!(
        commands::session_abandon_inner(&state, sid_b, 1)
            .unwrap_err()
            .code,
        ErrorCode::Conflict
    );
    assert_eq!(
        commands::session_submit_turn_inner(&state, i64::MAX, 0, "t", "x")
            .unwrap_err()
            .code,
        ErrorCode::NotFound
    );
}

#[test]
fn map_run_job_uses_the_injected_provider_reports_progress_and_is_idempotent() {
    let directory = tempfile::tempdir().unwrap();
    let (state, mock) = state_with_mock(&directory.path().join("app.db"));
    let (first, second, _) = seed_books(&state);
    let chapter: SpineChapterDto = serde_json::from_value(spine_chapter_json()).unwrap();
    commands::map_store_spine_inner(&state, second, vec![chapter]).unwrap();

    let mut events: Vec<MapProgressDto> = vec![];
    let blocks =
        commands::map_run_job_inner(&state, second, "job-1", &mut |p| events.push(p)).unwrap();
    assert_eq!(blocks.len(), 1);
    assert_eq!(blocks[0].title, "供需弹性");
    assert!(!blocks[0].skipped);
    assert_eq!(*mock.calls.lock().unwrap(), 2, "Stage A + Stage B");
    // 地图作业期间持有 JobGuard(在飞 = 1),结束后释放
    assert_eq!(*mock.observed_in_flight.lock().unwrap(), vec![1, 1]);
    assert_eq!(state.jobs().in_flight(), 0);
    assert!(matches!(
        events.first(),
        Some(MapProgressDto::Chapter {
            index: 0,
            total: 1,
            ..
        })
    ));
    assert!(events.contains(&MapProgressDto::Merging));
    assert_eq!(events.last(), Some(&MapProgressDto::Done { blocks: 1 }));
    assert_eq!(
        serde_json::to_value(&events[0]).unwrap(),
        json!({"stage": "chapter", "index": 0, "total": 1, "title": "第一章"})
    );
    let books = commands::library_list_books_inner(&state).unwrap();
    assert_eq!(
        books.iter().find(|b| b.id == second).unwrap().map_revision,
        1
    );

    // 已有地图:同 jobId / 新 jobId 都直接返回现有块,不发进度、不调 provider
    let mut again: Vec<MapProgressDto> = vec![];
    let same =
        commands::map_run_job_inner(&state, second, "job-1", &mut |p| again.push(p)).unwrap();
    let fresh =
        commands::map_run_job_inner(&state, second, "job-2", &mut |p| again.push(p)).unwrap();
    assert_eq!(same, blocks);
    assert_eq!(fresh, blocks);
    assert!(again.is_empty());
    assert_eq!(*mock.calls.lock().unwrap(), 2);

    // 无 spine 的书 → invalid_request;不存在的书 → not_found
    assert_eq!(
        commands::map_run_job_inner(&state, first, "job-3", &mut |_| {})
            .unwrap_err()
            .code,
        ErrorCode::InvalidRequest
    );
    assert_eq!(
        commands::map_run_job_inner(&state, i64::MAX, "job-4", &mut |_| {})
            .unwrap_err()
            .code,
        ErrorCode::NotFound
    );
}

#[test]
fn map_run_job_over_ipc_emits_map_job_progress_events_with_the_job_id() {
    let directory = tempfile::tempdir().unwrap();
    let (state, _mock) = state_with_mock(&directory.path().join("ipc.db"));
    let (_, second, _) = seed_books(&state);
    let chapter: SpineChapterDto = serde_json::from_value(spine_chapter_json()).unwrap();
    commands::map_store_spine_inner(&state, second, vec![chapter]).unwrap();

    let app = book_learner_app::register_commands(mock_builder().manage(state))
        .build(mock_context(noop_assets()))
        .unwrap();
    let received: Arc<Mutex<Vec<Value>>> = Arc::default();
    let sink = Arc::clone(&received);
    app.listen_any(commands::MAP_JOB_PROGRESS_EVENT, move |event| {
        sink.lock()
            .unwrap()
            .push(serde_json::from_str(event.payload()).unwrap());
    });
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();

    let blocks = invoke_json(
        &webview,
        "map_run_job",
        json!({"bookId": second, "jobId": "job-ipc"}),
    )
    .unwrap();
    assert_eq!(blocks.as_array().unwrap().len(), 1);
    assert_eq!(blocks[0]["skipped"], json!(false));
    let events = received.lock().unwrap();
    assert!(events.len() >= 3, "{events:?}");
    assert!(events.iter().all(|e| e["jobId"] == "job-ipc"), "{events:?}");
    assert_eq!(events[0]["progress"]["stage"], "chapter");
    assert_eq!(
        events.last().unwrap()["progress"],
        json!({"stage": "done", "blocks": 1})
    );
}

#[test]
fn application_services_delegate_to_core_and_persist_across_reopen() {
    let directory = tempfile::tempdir().unwrap();
    let database = directory.path().join("app.db");
    let (state, first, second, block) = seeded_state(&database);

    assert_eq!(application::list_books(&state).unwrap().len(), 2);
    assert_eq!(application::list_blocks(&state, first).unwrap().len(), 1);
    assert_eq!(
        application::get_block(&state, block).unwrap().title,
        "知识块"
    );
    // 主攻书切换要求该书已有学习计划(core::library::set_active_book,F4),故先设计划再激活
    application::set_plan(
        &state,
        StudyPlanRequest {
            book_id: second,
            deadline: "2026-10-01".into(),
            daily_new_blocks: 2,
            daily_cap: 4,
            remind_time: "20:15".into(),
        },
    )
    .unwrap();
    application::set_active_book(&state, second).unwrap();
    let second_block = state
        .with_connection(|connection| {
            book_learner_core::models::insert_block(
                connection,
                second,
                "模块二",
                1,
                "第二块",
                "second-block",
                &[],
            )
        })
        .unwrap();
    let queue = application::today_queue(&state, "2026-09-01").unwrap();
    assert_eq!(queue.len(), 1);
    assert_eq!(queue[0].block_id, second_block);
    let expected_settings = AppSettingsDto {
        obsidian_vault: "/Users/reader/Vault".into(),
        pomodoro_minutes: 40,
        break_minutes: 10,
        remind_time: "08:30".into(),
    };
    application::save_settings(&state, expected_settings.clone()).unwrap();
    drop(state);

    let reopened = AppState::open(&database).unwrap();
    let books = application::list_books(&reopened).unwrap();
    assert_eq!(
        books.iter().find(|book| book.id == second).unwrap().status,
        "active"
    );
    assert_eq!(
        application::get_settings(&reopened).unwrap(),
        expected_settings
    );
    let foreign_keys = reopened
        .with_connection(|connection| {
            Ok(connection.query_row("PRAGMA foreign_keys", [], |row| row.get::<_, i64>(0))?)
        })
        .unwrap();
    assert_eq!(foreign_keys, 1);
}

fn environment_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

#[test]
fn database_path_appends_exact_product_location_and_debug_override_is_absolute() {
    let _guard = environment_lock().lock().unwrap();
    let original = std::env::var_os("BOOK_LEARNER_DATA_DIR");
    std::env::remove_var("BOOK_LEARNER_DATA_DIR");
    assert_eq!(
        resolve_database_path(Path::new("/Users/reader/Library/Application Support")).unwrap(),
        Path::new("/Users/reader/Library/Application Support/book-learner/app.db")
    );

    #[cfg(debug_assertions)]
    {
        std::env::set_var("BOOK_LEARNER_DATA_DIR", "/private/tmp/book-data");
        assert_eq!(
            resolve_database_path(Path::new("/ignored")).unwrap(),
            Path::new("/private/tmp/book-data/app.db")
        );
        std::env::set_var("BOOK_LEARNER_DATA_DIR", "relative/path");
        let error = resolve_database_path(Path::new("/ignored")).unwrap_err();
        assert_eq!(error.code, ErrorCode::InvalidRequest);
    }

    #[cfg(not(debug_assertions))]
    {
        std::env::set_var("BOOK_LEARNER_DATA_DIR", "/private/tmp/ignored-in-release");
        assert_eq!(
            resolve_database_path(Path::new("/production/data")).unwrap(),
            Path::new("/production/data/book-learner/app.db")
        );
    }

    match original {
        Some(value) => std::env::set_var("BOOK_LEARNER_DATA_DIR", value),
        None => std::env::remove_var("BOOK_LEARNER_DATA_DIR"),
    }
}

#[test]
fn startup_initialization_returns_typed_errors_instead_of_panicking() {
    use std::os::unix::fs::PermissionsExt;
    let _guard = environment_lock().lock().unwrap();
    let original = std::env::var_os("BOOK_LEARNER_DATA_DIR");

    #[cfg(debug_assertions)]
    {
        std::env::set_var("BOOK_LEARNER_DATA_DIR", "relative/data");
        let error = book_learner_app::initialize_state(Path::new("/ignored"))
            .err()
            .expect("relative override must fail");
        assert_eq!(error.code, ErrorCode::InvalidRequest);
        assert!(error.message.contains("绝对路径"), "{}", error.message);
    }
    std::env::remove_var("BOOK_LEARNER_DATA_DIR");

    // 成功路径:在平台数据目录下创建 book-learner/app.db
    let directory = tempfile::tempdir().unwrap();
    drop(book_learner_app::initialize_state(directory.path()).unwrap());
    let product_root = directory.path().join("book-learner");
    assert!(product_root.join("app.db").is_file());
    assert!(product_root.join("memory").join("INDEX.md").is_file());

    // 数据目录不可写 → 类型化 io/db 错误且 internal_cause 非空(root 不受权限位约束则跳过)
    let locked = tempfile::tempdir().unwrap();
    std::fs::set_permissions(locked.path(), std::fs::Permissions::from_mode(0o000)).unwrap();
    if std::fs::create_dir(locked.path().join("probe")).is_err() {
        let error = book_learner_app::initialize_state(locked.path())
            .err()
            .expect("unwritable data dir must fail");
        assert!(
            matches!(error.code, ErrorCode::IoFailure | ErrorCode::DbUnavailable),
            "{:?}",
            error.code
        );
        assert!(
            !format!("{error:?}").contains("internal_cause: \"\""),
            "{error:?}"
        );
    }
    std::fs::set_permissions(locked.path(), std::fs::Permissions::from_mode(0o700)).unwrap();

    match original {
        Some(value) => std::env::set_var("BOOK_LEARNER_DATA_DIR", value),
        None => std::env::remove_var("BOOK_LEARNER_DATA_DIR"),
    }
}

#[test]
fn app_state_exposes_data_locations_and_independent_connections() {
    let directory = tempfile::tempdir().unwrap();
    let state = AppState::open(&directory.path().join("app.db")).unwrap();
    assert_eq!(state.data_root(), directory.path());
    assert_eq!(state.memory_root(), directory.path().join("memory"));
    assert_eq!(state.books_dir(), directory.path().join("books"));
    assert!(state.memory_root().join("INDEX.md").is_file());
    assert!(state.memory_root().join(".git").is_dir());

    // 持有 with_connection 守卫期间,另一线程经独立连接完成写入,且不被守卫串行化(远小于 5s busy 上限)
    let started = std::time::Instant::now();
    state
        .with_connection(|_guarded| {
            std::thread::scope(|scope| {
                scope
                    .spawn(|| {
                        let connection = state.open_connection().unwrap();
                        connection
                            .execute(
                                "INSERT INTO setting(key,value) VALUES('probe','1') \
                                 ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                                [],
                            )
                            .unwrap();
                    })
                    .join()
                    .unwrap();
            });
            Ok(())
        })
        .unwrap();
    assert!(
        started.elapsed() < std::time::Duration::from_secs(4),
        "independent connection was serialized behind the guard"
    );
    let probe: String = state
        .with_connection(|connection| {
            Ok(
                connection.query_row("SELECT value FROM setting WHERE key='probe'", [], |row| {
                    row.get(0)
                })?,
            )
        })
        .unwrap();
    assert_eq!(probe, "1");
}

#[test]
fn startup_recovery_replays_pending_projection_outbox() {
    let directory = tempfile::tempdir().unwrap();
    let (state, first, _, _) = seeded_state(&directory.path().join("app.db"));
    state
        .with_connection(|connection| {
            projection::enqueue(
                connection,
                "init_book:first",
                "init_book",
                &json!({"book_id": first}),
            )
        })
        .unwrap();
    assert_eq!(book_learner_app::run_startup_recovery(&state).unwrap(), 1);
    assert!(state
        .memory_root()
        .join("books")
        .join("first")
        .join("_map.md")
        .is_file());
    // 幂等:无 pending 行时不再处理
    assert_eq!(book_learner_app::run_startup_recovery(&state).unwrap(), 0);
}

#[test]
fn codex_binary_resolution_prefers_setting_then_path_then_known_directories() {
    use std::os::unix::fs::PermissionsExt;
    let directory = tempfile::tempdir().unwrap();
    let make = |dir: &Path| {
        std::fs::create_dir_all(dir).unwrap();
        let binary = dir.join("codex");
        std::fs::write(&binary, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o755)).unwrap();
        binary
    };
    let configured = make(&directory.path().join("configured"));
    let on_path = make(&directory.path().join("path"));
    let known = make(&directory.path().join("known"));
    let home = directory.path().join("home");
    let npm_global = make(&home.join(".npm-global").join("bin"));
    let empty = directory.path().join("empty");
    std::fs::create_dir_all(&empty).unwrap();
    let path_env = Some(OsString::from(format!(
        "{}:{}",
        empty.display(),
        directory.path().join("path").display()
    )));
    let empty_path = Some(OsString::from(empty.as_os_str()));
    let known_dir = directory.path().join("known");
    let known_dirs = [known_dir.to_str().unwrap()];

    assert_eq!(
        resolve_codex_bin(
            Some(configured.to_str().unwrap()),
            path_env.clone(),
            Some(home.clone()),
            &known_dirs
        )
        .unwrap(),
        configured
    );
    assert_eq!(
        resolve_codex_bin(Some("codex"), None, None, &[])
            .unwrap_err()
            .code,
        ErrorCode::InvalidRequest
    );
    assert_eq!(
        resolve_codex_bin(Some("/nonexistent/codex"), None, None, &[])
            .unwrap_err()
            .code,
        ErrorCode::NotFound
    );
    assert_eq!(
        resolve_codex_bin(None, path_env, Some(home.clone()), &known_dirs).unwrap(),
        on_path
    );
    assert_eq!(
        resolve_codex_bin(None, empty_path.clone(), Some(home.clone()), &known_dirs).unwrap(),
        known
    );
    assert_eq!(
        resolve_codex_bin(None, empty_path.clone(), Some(home), &[]).unwrap(),
        npm_global
    );
    assert_eq!(
        resolve_codex_bin(None, empty_path, Some(directory.path().join("nohome")), &[])
            .unwrap_err()
            .code,
        ErrorCode::NotFound
    );
}

#[test]
fn poisoned_connection_mutex_returns_typed_internal_error() {
    let directory = tempfile::tempdir().unwrap();
    let state = AppState::open(&directory.path().join("app.db")).unwrap();
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _: Result<(), IpcError> = state.with_connection(|_| panic!("poison fixture"));
    }));

    let error = application::list_books(&state).unwrap_err();
    assert_eq!(error.code, ErrorCode::Internal);
}

#[derive(Clone, Default)]
struct LogBuffer(Arc<Mutex<Vec<u8>>>);

struct LogWriter(Arc<Mutex<Vec<u8>>>);

impl Write for LogWriter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl<'a> MakeWriter<'a> for LogBuffer {
    type Writer = LogWriter;

    fn make_writer(&'a self) -> Self::Writer {
        LogWriter(Arc::clone(&self.0))
    }
}

#[test]
fn command_inner_functions_are_thin_typed_and_emit_correlated_errors() {
    let directory = tempfile::tempdir().unwrap();
    let database = directory.path().join("app.db");
    let (state, first, second, block) = seeded_state(&database);

    assert_eq!(commands::library_list_books_inner(&state).unwrap().len(), 2);
    // 先设计划再激活(主攻书切换要求已有学习计划)
    commands::planning_set_plan_inner(
        &state,
        StudyPlanRequest {
            book_id: second,
            deadline: "2026-10-01".into(),
            daily_new_blocks: 1,
            daily_cap: 4,
            remind_time: "21:00".into(),
        },
    )
    .unwrap();
    commands::library_set_active_book_inner(&state, second).unwrap();
    assert_eq!(
        commands::map_list_blocks_inner(&state, first)
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        commands::map_get_block_inner(&state, block).unwrap().id,
        block
    );
    let _ = commands::planning_today_queue_inner(&state, "2026-09-01".into()).unwrap();
    let settings = commands::settings_get_inner(&state).unwrap();
    commands::settings_save_inner(&state, settings).unwrap();

    let first_correlation = state.next_correlation_id();
    let second_correlation = state.next_correlation_id();
    let first_counter: u64 = first_correlation
        .rsplit('-')
        .next()
        .unwrap()
        .parse()
        .unwrap();
    let second_counter: u64 = second_correlation
        .rsplit('-')
        .next()
        .unwrap()
        .parse()
        .unwrap();
    assert_eq!(second_counter, first_counter + 1);

    let buffer = LogBuffer::default();
    let subscriber = tracing_subscriber::fmt()
        .without_time()
        .with_ansi(false)
        .with_writer(buffer.clone())
        .finish();
    let error = tracing::subscriber::with_default(subscriber, || {
        commands::map_get_block_inner(&state, i64::MAX).unwrap_err()
    });
    assert_eq!(error.code, ErrorCode::NotFound);
    let log = String::from_utf8(buffer.0.lock().unwrap().clone()).unwrap();
    assert!(log.contains("command=\"map_get_block\""), "{log}");
    assert!(log.contains("correlation_id=\"mac-"), "{log}");
    assert!(log.contains("error_code=\"not_found\""), "{log}");
    assert!(log.contains("internal_cause="), "{log}");
}

#[test]
fn unsupported_capability_is_always_safe_and_not_implemented() {
    let directory = tempfile::tempdir().unwrap();
    let state = AppState::open(&directory.path().join("app.db")).unwrap();
    let error = commands::unsupported_capability_inner(&state, "importEpub".into()).unwrap_err();
    assert_eq!(error.code, ErrorCode::NotImplemented);
    assert_eq!(error.details, Some(json!({"capability": "importEpub"})));
    assert_eq!(error.message, "此功能尚未在 Mac 版中实现");
}

fn invoke_json(
    webview: &tauri::WebviewWindow<tauri::test::MockRuntime>,
    command: &str,
    payload: Value,
) -> Result<Value, Value> {
    invoke_body(
        webview,
        command,
        InvokeBody::Json(payload),
        HeaderMap::new(),
    )
}

/// 原始请求体 + 自定义头(分块导入的传输形态)。
fn invoke_raw(
    webview: &tauri::WebviewWindow<tauri::test::MockRuntime>,
    command: &str,
    bytes: Vec<u8>,
    headers: &[(&str, &str)],
) -> Result<Value, Value> {
    let mut map = HeaderMap::new();
    for (name, value) in headers {
        map.insert(
            HeaderName::from_bytes(name.as_bytes()).unwrap(),
            HeaderValue::from_str(value).unwrap(),
        );
    }
    invoke_body(webview, command, InvokeBody::Raw(bytes), map)
}

/// 最小合法 EPUB(mimetype 首条目 + container.xml + 一章),全部 stored。
fn fake_epub() -> Vec<u8> {
    let options =
        zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    for (name, body) in [
        ("mimetype", "application/epub+zip"),
        ("META-INF/container.xml", "<container/>"),
        ("OEBPS/ch0.xhtml", "<html>ch0</html>"),
    ] {
        writer.start_file(name, options).unwrap();
        writer.write_all(body.as_bytes()).unwrap();
    }
    writer.finish().unwrap().into_inner()
}

fn invoke_body(
    webview: &tauri::WebviewWindow<tauri::test::MockRuntime>,
    command: &str,
    body: InvokeBody,
    headers: HeaderMap,
) -> Result<Value, Value> {
    get_ipc_response(
        webview,
        InvokeRequest {
            cmd: command.into(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: "tauri://localhost".parse().unwrap(),
            body,
            headers,
            invoke_key: INVOKE_KEY.into(),
        },
    )
    .map(|body| body.deserialize().unwrap())
}

/// 已注册但尚未接线的 v2 命令(M0 占位);M4/M5 每接一条就从此移除并改为预期 `Ok`。
const PLACEHOLDER_COMMANDS: &[&str] = &[];

#[test]
fn real_tauri_ipc_surface_matches_the_shared_wire_contract() {
    let contract: Value =
        serde_json::from_str(include_str!("../../../shared/tauri-wire-contract.json")).unwrap();
    assert_eq!(
        contract.as_object().unwrap().keys().collect::<Vec<_>>(),
        vec!["commands", "unsupportedCapabilities"]
    );
    let actual: Vec<(&str, Vec<&str>)> = contract["commands"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| {
            (
                entry["command"].as_str().unwrap(),
                entry["payloadKeys"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|key| key.as_str().unwrap())
                    .collect(),
            )
        })
        .collect();
    let expected: Vec<(&str, Vec<&str>)> = commands::WIRE_COMMANDS
        .iter()
        .map(|(command, keys)| (*command, keys.to_vec()))
        .collect();
    assert_eq!(actual, expected);
    assert_eq!(
        contract["unsupportedCapabilities"],
        json!(commands::UNSUPPORTED_CAPABILITIES)
    );

    let directory = tempfile::tempdir().unwrap();
    let (state, _mock) = state_with_mock(&directory.path().join("ipc.db"));
    let (first, second, block) = seed_books(&state);
    // 地图组命令用无块的 second:先存 spine 并落一张单块草图
    let second_block = seed_map(&state, second);
    // 会话组命令:first 两块 + 计划(顺带满足"主攻书切换要求已有计划")→ 今日两任务 →
    // 会话 A 走完整闭环(开始→回合→评估→判定),会话 B 用于 abandon
    let (task_a, task_b) = seed_two_tasks(&state, first, block, DAY);
    let session_a = commands::session_start_or_resume_inner(&state, task_a, "req-a", DAY)
        .unwrap()
        .session_id;
    let session_b = commands::session_start_or_resume_inner(&state, task_b, "req-b", DAY)
        .unwrap()
        .session_id;
    // 导入/阅读器命令:second 预置受管 EPUB 文件;契约循环里的分块命令走原始请求体分支
    std::fs::write(state.import_store().book_path(second), fake_epub()).unwrap();
    let app = book_learner_app::register_commands(mock_builder().manage(state))
        .build(mock_context(noop_assets()))
        .unwrap();
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();

    for entry in contract["commands"].as_array().unwrap() {
        let command = entry["command"].as_str().unwrap();
        let payload = match command {
            "library_list_books" | "settings_get" => json!({}),
            "library_set_active_book" | "map_list_blocks" => json!({"bookId": first}),
            "map_get_block" => json!({"blockId": block}),
            "planning_set_plan" => json!({"request": {
                "bookId": first, "deadline": "2026-10-01", "dailyNewBlocks": 1,
                "dailyCap": 4, "remindTime": "21:00"
            }}),
            "planning_today_queue" => json!({"date": DAY}),
            "settings_save" => json!({"settings": {
                "obsidianVault": "/Notes", "pomodoroMinutes": 25,
                "breakMinutes": 5, "remindTime": "21:00"
            }}),
            "unsupported_capability" => json!({"capability": "importEpub"}),
            // 契约 v2:占位期 payload 只需满足参数名/类型;接线后改为可落库的真实值
            "map_store_spine" => json!({"bookId": second, "chapters": [spine_chapter_json()]}),
            "map_run_job" => json!({"bookId": second, "jobId": "job-1"}),
            "map_confirm" => json!({"bookId": second, "expectedRevision": 1, "ops": [
                {"op": "setSkipped", "blockId": second_block, "skipped": true}
            ]}),
            "map_set_anchor_segments" => json!({
                "blockId": second_block, "segments": [anchor_segment_json()]
            }),
            "map_list_anchors" => json!({"blockId": second_block}),
            "session_start_or_resume" => json!({
                "taskId": task_a, "clientRequestId": "req-a", "date": DAY
            }),
            "session_submit_turn" => json!({
                "sessionId": session_a, "expectedVersion": 0, "clientTurnId": "turn-1",
                "text": "弹性是相对变化率"
            }),
            "session_request_evaluation" => json!({"sessionId": session_a, "requestId": "eval"}),
            "session_confirm_verdict" => json!({
                "sessionId": session_a, "expectedVersion": 2, "requestId": "verdict",
                "pass": true, "date": DAY
            }),
            "session_abandon" => json!({"sessionId": session_b, "expectedVersion": 0}),
            "library_import_epub_chunk" => {
                // 原始请求体:payloadKeys 必须为空,元数据经头部;随后 finalize 复用同一 op
                assert_eq!(entry["payloadKeys"], json!([]), "{command}");
                let response = invoke_raw(
                    &webview,
                    command,
                    fake_epub(),
                    &[("x-op-id", "op-wire"), ("x-chunk-index", "0")],
                )
                .unwrap_or_else(|error| panic!("{command} was not invokable: {error}"));
                assert!(response["stagedBytes"].as_u64().unwrap() > 0, "{response}");
                continue;
            }
            "library_import_epub_finalize" => json!({
                "opId": "op-wire", "bookType": "textbook", "title": "契约导入"
            }),
            "library_epub_url" => json!({"bookId": second}),
            "map_block_source" => json!({"blockId": second_block}),
            "stats_get" => json!({"date": DAY}),
            "planning_check_behind" => json!({"bookId": first, "date": DAY}),
            "planning_get_plan" => json!({"bookId": first}),
            other => panic!("contract contains unknown command {other}"),
        };
        // payload 是 JSON 对象,键序无语义(serde_json 默认 BTreeMap),按集合比对
        let mut actual_keys: Vec<&str> = payload
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        let mut expected_keys: Vec<&str> = entry["payloadKeys"]
            .as_array()
            .unwrap()
            .iter()
            .map(|key| key.as_str().unwrap())
            .collect();
        actual_keys.sort_unstable();
        expected_keys.sort_unstable();
        assert_eq!(actual_keys, expected_keys, "{command}");

        let response = invoke_json(&webview, command, payload);
        if command == "unsupported_capability" {
            assert_eq!(response.unwrap_err()["code"], "not_implemented");
        } else if PLACEHOLDER_COMMANDS.contains(&command) {
            // M0 占位期:已注册且参数通过反序列化,但返回 not_implemented(capability = 前端方法名)
            let error = response.expect_err(command);
            assert_eq!(error["code"], "not_implemented", "{command}");
            assert_eq!(error["details"]["capability"], entry["method"], "{command}");
        } else {
            response.unwrap_or_else(|error| panic!("{command} was not invokable: {error}"));
        }
    }

    for (command, wrong_payload) in [
        ("planning_set_plan", json!({"plan": {}})),
        ("planning_today_queue", json!({"day": "2026-09-01"})),
        ("settings_save", json!({"value": {}})),
    ] {
        assert!(
            invoke_json(&webview, command, wrong_payload).is_err(),
            "{command}"
        );
    }
    assert!(invoke_json(&webview, "health_check", json!({})).is_err());
}
