use std::io::Write;
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};

use book_learner_app::application;
use book_learner_app::commands;
use book_learner_app::dto::{
    AppSettingsDto, BookDto, DailyTaskDto, KnowledgeBlockDto, StudyPlanRequest,
};
use book_learner_app::error::{ErrorCode, IpcError};
use book_learner_app::state::{resolve_database_path, AppState};
use book_learner_core::eval::Scores;
use book_learner_core::models::{Book, BookStatus, BookType, KnowledgeBlock};
use book_learner_core::sched::DailyTask;
use book_learner_core::CoreError;
use serde_json::{json, Value};
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
    });
    assert_eq!(
        serde_json::to_value(book).unwrap(),
        json!({
            "id": 7, "title": "系统思考", "author": "作者",
            "type": "methodology", "slug": "systems", "status": "paused"
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
    })
    .unwrap();
    assert_eq!(
        serde_json::to_value(block).unwrap(),
        json!({
            "id": 11, "bookId": 7, "moduleName": "反馈", "seq": 2,
            "title": "增强回路", "slug": "reinforcing-loop", "prereqIds": [9, 10],
            "status": "passed", "scores": {"accuracy": 4, "completeness": 3, "clarity": 5},
            "passedAt": "2026-09-01"
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

fn seeded_state(path: &Path) -> (AppState, i64, i64, i64) {
    let state = AppState::open(path).unwrap();
    let ids = state
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
        .unwrap();
    (state, ids.0, ids.1, ids.2)
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
    application::set_active_book(&state, second).unwrap();
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

#[test]
fn rust_command_surface_matches_the_shared_wire_contract() {
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

    let registered_source = include_str!("../src/lib.rs");
    for (command, _) in commands::WIRE_COMMANDS {
        assert!(
            registered_source.contains(command),
            "{command} is not registered"
        );
    }
    assert!(!registered_source.contains("health_check"));
}
