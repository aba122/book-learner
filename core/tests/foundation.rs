use book_learner_core::{db, library, models, planning, settings, CoreError};

#[test]
fn list_books_returns_transport_models_in_stable_id_order() {
    let conn = db::open_in_memory().unwrap();
    conn.execute(
        "INSERT INTO book(id,title,author,type,slug,status) VALUES(20,'人文书','甲','humanities','history','paused')",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO book(id,title,author,type,slug,status) VALUES(10,'方法书','乙','methodology','method','active')",
        [],
    )
    .unwrap();

    let books = models::list_books(&conn).unwrap();

    assert_eq!(books.len(), 2);
    assert_eq!(books[0].id, 10);
    assert_eq!(books[0].title, "方法书");
    assert_eq!(books[0].author, "乙");
    assert_eq!(books[0].book_type, models::BookType::Methodology);
    assert_eq!(books[0].slug, "method");
    assert_eq!(books[0].status, models::BookStatus::Active);
    assert_eq!(books[1].id, 20);
    assert_eq!(books[1].book_type, models::BookType::Humanities);
    assert_eq!(books[1].status, models::BookStatus::Paused);
}

#[test]
fn list_books_strictly_rejects_unknown_database_enums() {
    for (column, value) in [("type", "memoir"), ("status", "archived")] {
        let conn = db::open_in_memory().unwrap();
        conn.pragma_update(None, "ignore_check_constraints", "ON")
            .unwrap();
        conn.execute(
            "INSERT INTO book(title,type,slug,status) VALUES('坏数据','textbook','bad','paused')",
            [],
        )
        .unwrap();
        conn.execute(
            &format!("UPDATE book SET {column}=?1 WHERE slug='bad'"),
            [value],
        )
        .unwrap();

        assert!(matches!(
            models::list_books(&conn),
            Err(CoreError::Other(_))
        ));
    }
}

#[test]
fn get_block_returns_frontend_fields_with_typed_scores() {
    let conn = db::open_in_memory().unwrap();
    let book =
        models::insert_book(&conn, "书", "作者", models::BookType::Textbook, "book").unwrap();
    let block = models::insert_block(&conn, book, "模块", 3, "知识块", "block", &[7, 8]).unwrap();
    conn.execute(
        "UPDATE knowledge_block SET status='passed', scores_json=?2, passed_at='2026-08-31' WHERE id=?1",
        rusqlite::params![block, r#"{"accuracy":4,"completeness":3,"clarity":5}"#],
    )
    .unwrap();

    let block = models::get_block(&conn, block).unwrap();

    assert_eq!(block.id, 1);
    assert_eq!(block.book_id, book);
    assert_eq!(block.module_name, "模块");
    assert_eq!(block.seq, 3);
    assert_eq!(block.title, "知识块");
    assert_eq!(block.slug, "block");
    assert_eq!(block.prereq_ids, vec![7, 8]);
    assert_eq!(block.status, "passed");
    assert_eq!(
        block.scores,
        Some(book_learner_core::eval::Scores {
            accuracy: 4,
            completeness: 3,
            clarity: 5,
        })
    );
    assert_eq!(block.passed_at.as_deref(), Some("2026-08-31"));
}

#[test]
fn get_block_strictly_rejects_invalid_scores_json() {
    for scores in [
        r#"{"accuracy":0,"completeness":3,"clarity":5}"#,
        r#"{"accuracy":4,"completeness":3,"clarity":5,"extra":1}"#,
    ] {
        let conn = db::open_in_memory().unwrap();
        let book =
            models::insert_book(&conn, "书", "", models::BookType::Textbook, "book").unwrap();
        let block = models::insert_block(&conn, book, "模块", 1, "块", "block", &[]).unwrap();
        conn.execute(
            "UPDATE knowledge_block SET scores_json=?2 WHERE id=?1",
            rusqlite::params![block, scores],
        )
        .unwrap();

        assert!(matches!(
            models::get_block(&conn, block),
            Err(CoreError::Other(_))
        ));
    }
}

#[test]
fn get_block_returns_typed_not_found() {
    let conn = db::open_in_memory().unwrap();

    assert!(matches!(
        models::get_block(&conn, 404),
        Err(CoreError::NotFound(_))
    ));
}

#[test]
fn block_identity_and_status_survive_disk_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("foundation.db");
    let conn = db::open(&path).unwrap();
    let book = models::insert_book(&conn, "书", "", models::BookType::Textbook, "book").unwrap();
    let block = models::insert_block(&conn, book, "模块", 1, "块", "block", &[]).unwrap();
    conn.execute(
        "UPDATE knowledge_block SET status='weak' WHERE id=?1",
        [block],
    )
    .unwrap();
    drop(conn);

    let reopened = db::open(&path).unwrap();
    let persisted = models::get_block(&reopened, block).unwrap();

    assert_eq!(persisted.id, block);
    assert_eq!(persisted.status, "weak");
}

#[test]
fn set_active_book_rejects_missing_target_without_changes() {
    let conn = db::open_in_memory().unwrap();
    let book =
        models::insert_book(&conn, "现有书", "", models::BookType::Textbook, "existing").unwrap();
    conn.execute(
        "INSERT INTO study_plan(book_id,deadline,daily_new_blocks,active) VALUES(?1,'2026-09-30',2,1)",
        [book],
    )
    .unwrap();

    let error = library::set_active_book(&conn, 404).unwrap_err();

    assert!(matches!(error, CoreError::NotFound(_)));
    let status: String = conn
        .query_row("SELECT status FROM book WHERE id=?1", [book], |row| {
            row.get(0)
        })
        .unwrap();
    let active: i64 = conn
        .query_row(
            "SELECT active FROM study_plan WHERE book_id=?1",
            [book],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!((status.as_str(), active), ("active", 1));
}

#[test]
fn set_active_book_switches_book_and_plan_as_one_invariant() {
    let conn = db::open_in_memory().unwrap();
    let first =
        models::insert_book(&conn, "第一本", "", models::BookType::Textbook, "first").unwrap();
    let second =
        models::insert_book(&conn, "第二本", "", models::BookType::Methodology, "second").unwrap();
    conn.execute("UPDATE book SET status='paused' WHERE id=?1", [second])
        .unwrap();
    conn.execute(
        "INSERT INTO study_plan(book_id,deadline,daily_new_blocks,active) VALUES(?1,'2026-09-30',2,1)",
        [first],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO study_plan(book_id,deadline,daily_new_blocks,active) VALUES(?1,'2026-10-31',1,0)",
        [second],
    )
    .unwrap();

    library::set_active_book(&conn, second).unwrap();

    let books: Vec<(i64, String)> = conn
        .prepare("SELECT id,status FROM book ORDER BY id")
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    let plans: Vec<(i64, i64)> = conn
        .prepare("SELECT book_id,active FROM study_plan ORDER BY book_id")
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert_eq!(
        books,
        vec![(first, "paused".into()), (second, "active".into())]
    );
    assert_eq!(plans, vec![(first, 0), (second, 1)]);
}

#[test]
fn set_active_book_rolls_back_every_row_on_trigger_failure() {
    let conn = db::open_in_memory().unwrap();
    conn.execute_batch(
        "INSERT INTO book(id,title,type,slug,status) VALUES(1,'一','textbook','one','active');
         INSERT INTO book(id,title,type,slug,status) VALUES(2,'二','textbook','two','paused');
         INSERT INTO study_plan(book_id,deadline,daily_new_blocks,active) VALUES(1,'2026-09-30',2,1);
         INSERT INTO study_plan(book_id,deadline,daily_new_blocks,active) VALUES(2,'2026-10-31',1,0);
         CREATE TRIGGER fail_target_plan BEFORE UPDATE OF active ON study_plan
         WHEN NEW.book_id=2 AND NEW.active=1
         BEGIN SELECT RAISE(ABORT, 'injected plan activation failure'); END;",
    )
    .unwrap();

    let error = library::set_active_book(&conn, 2).unwrap_err();

    assert!(matches!(error, CoreError::Conflict(_)));
    let books: Vec<(i64, String)> = conn
        .prepare("SELECT id,status FROM book ORDER BY id")
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    let plans: Vec<(i64, i64)> = conn
        .prepare("SELECT book_id,active FROM study_plan ORDER BY book_id")
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert_eq!(books, vec![(1, "active".into()), (2, "paused".into())]);
    assert_eq!(plans, vec![(1, 1), (2, 0)]);
}

#[test]
fn active_book_and_plan_uniqueness_survive_disk_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("active-book.db");
    let conn = db::open(&path).unwrap();
    conn.execute_batch(
        "INSERT INTO book(id,title,type,slug,status) VALUES(1,'一','textbook','one','active');
         INSERT INTO book(id,title,type,slug,status) VALUES(2,'二','textbook','two','paused');
         INSERT INTO study_plan(book_id,deadline,daily_new_blocks,active) VALUES(1,'2026-09-30',2,1);
         INSERT INTO study_plan(book_id,deadline,daily_new_blocks,active) VALUES(2,'2026-10-31',1,0);",
    )
    .unwrap();
    library::set_active_book(&conn, 2).unwrap();
    drop(conn);

    let reopened = db::open(&path).unwrap();
    let active_books: i64 = reopened
        .query_row(
            "SELECT count(*) FROM book WHERE status='active'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let active_plans: i64 = reopened
        .query_row(
            "SELECT count(*) FROM study_plan WHERE active=1",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let active_plan_book: i64 = reopened
        .query_row("SELECT book_id FROM study_plan WHERE active=1", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!((active_books, active_plans, active_plan_book), (1, 1, 2));
}

#[test]
fn set_plan_upserts_and_activates_only_the_active_books_plan() {
    let conn = db::open_in_memory().unwrap();
    conn.execute_batch(
        "INSERT INTO book(id,title,type,slug,status) VALUES(1,'一','textbook','one','paused');
         INSERT INTO book(id,title,type,slug,status) VALUES(2,'二','textbook','two','active');
         INSERT INTO study_plan(book_id,deadline,daily_new_blocks,daily_cap,remind_time,active)
         VALUES(1,'2026-09-30',2,4,'20:00',1);
         INSERT INTO study_plan(book_id,deadline,daily_new_blocks,daily_cap,remind_time,active)
         VALUES(2,'2026-10-01',1,4,'20:00',0);",
    )
    .unwrap();
    let plan = planning::StudyPlan {
        book_id: 2,
        deadline: "2026-11-30".into(),
        daily_new_blocks: 3,
        daily_cap: 5,
        remind_time: "08:30".into(),
    };

    planning::set_plan(&conn, &plan).unwrap();

    let first_active: i64 = conn
        .query_row("SELECT active FROM study_plan WHERE book_id=1", [], |row| {
            row.get(0)
        })
        .unwrap();
    let second: (String, i64, i64, String, i64) = conn
        .query_row(
            "SELECT deadline,daily_new_blocks,daily_cap,remind_time,active FROM study_plan WHERE book_id=2",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        )
        .unwrap();
    assert_eq!(first_active, 0);
    assert_eq!(second, ("2026-11-30".into(), 3, 5, "08:30".into(), 1));
}

#[test]
fn set_plan_rejects_invalid_fields_without_writing() {
    let invalid_plans = [
        planning::StudyPlan {
            book_id: 1,
            deadline: "2026-02-30".into(),
            daily_new_blocks: 2,
            daily_cap: 4,
            remind_time: "08:30".into(),
        },
        planning::StudyPlan {
            book_id: 1,
            deadline: "2026-9-01".into(),
            daily_new_blocks: 2,
            daily_cap: 4,
            remind_time: "08:30".into(),
        },
        planning::StudyPlan {
            book_id: 1,
            deadline: "26-09-01".into(),
            daily_new_blocks: 2,
            daily_cap: 4,
            remind_time: "08:30".into(),
        },
        planning::StudyPlan {
            book_id: 1,
            deadline: "2026-09-1".into(),
            daily_new_blocks: 2,
            daily_cap: 4,
            remind_time: "08:30".into(),
        },
        planning::StudyPlan {
            book_id: 1,
            deadline: "2026-09-30".into(),
            daily_new_blocks: 0,
            daily_cap: 4,
            remind_time: "08:30".into(),
        },
        planning::StudyPlan {
            book_id: 1,
            deadline: "2026-09-30".into(),
            daily_new_blocks: 2,
            daily_cap: 0,
            remind_time: "08:30".into(),
        },
        planning::StudyPlan {
            book_id: 1,
            deadline: "2026-09-30".into(),
            daily_new_blocks: 2,
            daily_cap: 4,
            remind_time: "8:30".into(),
        },
        planning::StudyPlan {
            book_id: 1,
            deadline: "2026-09-30".into(),
            daily_new_blocks: 2,
            daily_cap: 4,
            remind_time: " 9:00".into(),
        },
        planning::StudyPlan {
            book_id: 1,
            deadline: "2026-09-30".into(),
            daily_new_blocks: 2,
            daily_cap: 4,
            remind_time: "09: 0".into(),
        },
    ];

    for plan in invalid_plans {
        let conn = db::open_in_memory().unwrap();
        conn.execute(
            "INSERT INTO book(id,title,type,slug,status) VALUES(1,'书','textbook','book','active')",
            [],
        )
        .unwrap();

        let error = planning::set_plan(&conn, &plan).unwrap_err();

        assert!(matches!(error, CoreError::InvalidInput(_)));
        let plan_count: i64 = conn
            .query_row("SELECT count(*) FROM study_plan", [], |row| row.get(0))
            .unwrap();
        assert_eq!(plan_count, 0);
    }
}

#[test]
fn today_queue_delegates_to_daily_scheduler() {
    let conn = db::open_in_memory().unwrap();
    let book = models::insert_book(&conn, "书", "", models::BookType::Textbook, "book").unwrap();
    let block = models::insert_block(&conn, book, "模块", 1, "块", "block", &[]).unwrap();
    planning::set_plan(
        &conn,
        &planning::StudyPlan {
            book_id: book,
            deadline: "2026-09-30".into(),
            daily_new_blocks: 1,
            daily_cap: 4,
            remind_time: "21:00".into(),
        },
    )
    .unwrap();

    let queue = planning::today_queue(&conn, "2026-09-01").unwrap();

    assert_eq!(queue.len(), 1);
    assert_eq!(queue[0].block_id, block);
    assert_eq!(queue[0].kind, "new");
}

#[test]
fn today_queue_rejects_invalid_calendar_dates_before_writing() {
    for date in ["2026-9-01", "2026-02-30"] {
        let conn = db::open_in_memory().unwrap();
        let book =
            models::insert_book(&conn, "书", "", models::BookType::Textbook, "book").unwrap();
        models::insert_block(&conn, book, "模块", 1, "块", "block", &[]).unwrap();
        planning::set_plan(
            &conn,
            &planning::StudyPlan {
                book_id: book,
                deadline: "2026-09-30".into(),
                daily_new_blocks: 1,
                daily_cap: 4,
                remind_time: "21:00".into(),
            },
        )
        .unwrap();

        let error = planning::today_queue(&conn, date).unwrap_err();

        assert!(matches!(error, CoreError::InvalidInput(_)), "{date}");
        let task_count: i64 = conn
            .query_row("SELECT count(*) FROM daily_task", [], |row| row.get(0))
            .unwrap();
        assert_eq!(task_count, 0, "{date}");
    }
}

#[test]
fn set_plan_rejects_missing_book_without_changes() {
    let conn = db::open_in_memory().unwrap();
    let plan = planning::StudyPlan {
        book_id: 404,
        deadline: "2026-09-30".into(),
        daily_new_blocks: 1,
        daily_cap: 4,
        remind_time: "21:00".into(),
    };

    let error = planning::set_plan(&conn, &plan).unwrap_err();

    assert!(matches!(error, CoreError::NotFound(_)));
    let count: i64 = conn
        .query_row("SELECT count(*) FROM study_plan", [], |row| row.get(0))
        .unwrap();
    assert_eq!(count, 0);
}

#[test]
fn set_plan_reports_corrupt_stored_book_status_as_internal_data_error() {
    let conn = db::open_in_memory().unwrap();
    conn.pragma_update(None, "ignore_check_constraints", "ON")
        .unwrap();
    conn.execute(
        "INSERT INTO book(id,title,type,slug,status) VALUES(1,'书','textbook','book','corrupt')",
        [],
    )
    .unwrap();
    let plan = planning::StudyPlan {
        book_id: 1,
        deadline: "2026-09-30".into(),
        daily_new_blocks: 1,
        daily_cap: 4,
        remind_time: "21:00".into(),
    };

    let error = planning::set_plan(&conn, &plan).unwrap_err();

    assert!(matches!(error, CoreError::Other(_)));
    let count: i64 = conn
        .query_row("SELECT count(*) FROM study_plan", [], |row| row.get(0))
        .unwrap();
    assert_eq!(count, 0);
}

#[test]
fn set_plan_keeps_paused_books_plan_inactive() {
    let conn = db::open_in_memory().unwrap();
    conn.execute(
        "INSERT INTO book(id,title,type,slug,status) VALUES(1,'书','textbook','book','paused')",
        [],
    )
    .unwrap();
    let plan = planning::StudyPlan {
        book_id: 1,
        deadline: "2026-09-30".into(),
        daily_new_blocks: 2,
        daily_cap: 4,
        remind_time: "21:00".into(),
    };

    planning::set_plan(&conn, &plan).unwrap();

    let active: i64 = conn
        .query_row("SELECT active FROM study_plan WHERE book_id=1", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(active, 0);
}

#[test]
fn set_plan_rolls_back_deactivation_when_upsert_fails() {
    let conn = db::open_in_memory().unwrap();
    conn.execute_batch(
        "INSERT INTO book(id,title,type,slug,status) VALUES(1,'一','textbook','one','paused');
         INSERT INTO book(id,title,type,slug,status) VALUES(2,'二','textbook','two','active');
         INSERT INTO study_plan(book_id,deadline,daily_new_blocks,daily_cap,remind_time,active)
         VALUES(1,'2026-09-30',2,4,'20:00',1);
         CREATE TRIGGER fail_plan_insert BEFORE INSERT ON study_plan
         WHEN NEW.book_id=2
         BEGIN SELECT RAISE(ABORT, 'injected plan insert failure'); END;",
    )
    .unwrap();
    let plan = planning::StudyPlan {
        book_id: 2,
        deadline: "2026-10-31".into(),
        daily_new_blocks: 1,
        daily_cap: 4,
        remind_time: "08:30".into(),
    };

    let error = planning::set_plan(&conn, &plan).unwrap_err();

    assert!(matches!(error, CoreError::Conflict(_)));
    let rows: Vec<(i64, String, i64)> = conn
        .prepare("SELECT book_id,deadline,active FROM study_plan ORDER BY book_id")
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert_eq!(rows, vec![(1, "2026-09-30".into(), 1)]);
}

#[test]
fn set_plan_active_uniqueness_survives_disk_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("planning.db");
    let conn = db::open(&path).unwrap();
    conn.execute_batch(
        "INSERT INTO book(id,title,type,slug,status) VALUES(1,'一','textbook','one','paused');
         INSERT INTO book(id,title,type,slug,status) VALUES(2,'二','textbook','two','active');",
    )
    .unwrap();
    for (book_id, deadline) in [(1, "2026-09-30"), (2, "2026-10-31")] {
        planning::set_plan(
            &conn,
            &planning::StudyPlan {
                book_id,
                deadline: deadline.into(),
                daily_new_blocks: 2,
                daily_cap: 4,
                remind_time: "21:00".into(),
            },
        )
        .unwrap();
    }
    drop(conn);

    let reopened = db::open(&path).unwrap();
    let plan_count: i64 = reopened
        .query_row("SELECT count(*) FROM study_plan", [], |row| row.get(0))
        .unwrap();
    let active_count: i64 = reopened
        .query_row(
            "SELECT count(*) FROM study_plan WHERE active=1",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let active_book: i64 = reopened
        .query_row("SELECT book_id FROM study_plan WHERE active=1", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!((plan_count, active_count, active_book), (2, 1, 2));
}

#[test]
fn get_settings_uses_shared_defaults_for_fresh_database() {
    let conn = db::open_in_memory().unwrap();

    let value = settings::get_settings(&conn).unwrap();

    assert_eq!(value.obsidian_vault, "~/Obsidian/book-learner");
    assert_eq!(value.pomodoro_minutes, 25);
    assert_eq!(value.break_minutes, 5);
    assert_eq!(value.remind_time, "21:00");
    let persisted: i64 = conn
        .query_row("SELECT count(*) FROM setting", [], |row| row.get(0))
        .unwrap();
    assert_eq!(persisted, 0);
}

#[test]
fn save_settings_rejects_invalid_durations_and_time_before_writing() {
    let invalid_values = [
        settings::AppSettings {
            obsidian_vault: "~/Vault".into(),
            pomodoro_minutes: 0,
            break_minutes: 5,
            remind_time: "21:00".into(),
        },
        settings::AppSettings {
            obsidian_vault: "~/Vault".into(),
            pomodoro_minutes: 181,
            break_minutes: 5,
            remind_time: "21:00".into(),
        },
        settings::AppSettings {
            obsidian_vault: "~/Vault".into(),
            pomodoro_minutes: 25,
            break_minutes: 181,
            remind_time: "21:00".into(),
        },
        settings::AppSettings {
            obsidian_vault: "~/Vault".into(),
            pomodoro_minutes: 25,
            break_minutes: 5,
            remind_time: "9:00".into(),
        },
        settings::AppSettings {
            obsidian_vault: "~/Vault".into(),
            pomodoro_minutes: 25,
            break_minutes: 5,
            remind_time: " 9:00".into(),
        },
        settings::AppSettings {
            obsidian_vault: "~/Vault".into(),
            pomodoro_minutes: 25,
            break_minutes: 5,
            remind_time: "09: 0".into(),
        },
    ];

    for value in invalid_values {
        let conn = db::open_in_memory().unwrap();

        let error = settings::save_settings(&conn, &value).unwrap_err();

        assert!(matches!(error, CoreError::InvalidInput(_)));
        let count: i64 = conn
            .query_row("SELECT count(*) FROM setting", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }
}

#[test]
fn save_settings_persists_exactly_four_keys_across_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("settings.db");
    let conn = db::open(&path).unwrap();
    conn.execute(
        "INSERT INTO setting(key,value) VALUES('unrelatedKey','preserve-me')",
        [],
    )
    .unwrap();
    let expected = settings::AppSettings {
        obsidian_vault: "/Users/test/Notes".into(),
        pomodoro_minutes: 45,
        break_minutes: 10,
        remind_time: "08:15".into(),
    };

    settings::save_settings(&conn, &expected).unwrap();
    drop(conn);

    let reopened = db::open(&path).unwrap();
    assert_eq!(settings::get_settings(&reopened).unwrap(), expected);
    let values: Vec<(String, String)> = reopened
        .prepare("SELECT key,value FROM setting ORDER BY key")
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert_eq!(
        values,
        vec![
            ("breakMinutes".into(), "10".into()),
            ("obsidianVault".into(), "/Users/test/Notes".into()),
            ("pomodoroMinutes".into(), "45".into()),
            ("remindTime".into(), "08:15".into()),
            ("unrelatedKey".into(), "preserve-me".into()),
        ]
    );
}

#[test]
fn get_settings_falls_back_for_one_missing_key_without_rewriting_database() {
    let conn = db::open_in_memory().unwrap();
    conn.execute_batch(
        "INSERT INTO setting(key,value) VALUES('obsidianVault','/Notes');
         INSERT INTO setting(key,value) VALUES('pomodoroMinutes','40');
         INSERT INTO setting(key,value) VALUES('breakMinutes','8');",
    )
    .unwrap();

    let value = settings::get_settings(&conn).unwrap();

    assert_eq!(value.obsidian_vault, "/Notes");
    assert_eq!(value.pomodoro_minutes, 40);
    assert_eq!(value.break_minutes, 8);
    assert_eq!(value.remind_time, "21:00");
    let persisted: i64 = conn
        .query_row("SELECT count(*) FROM setting", [], |row| row.get(0))
        .unwrap();
    assert_eq!(persisted, 3);
}

#[test]
fn get_settings_reports_corrupt_stored_values_as_internal_data_errors() {
    for (key, stored) in [
        ("pomodoroMinutes", "0"),
        ("pomodoroMinutes", "181"),
        ("pomodoroMinutes", "not-a-number"),
        ("breakMinutes", "0"),
        ("breakMinutes", "181"),
        ("remindTime", "9:00"),
        ("remindTime", "25:00"),
    ] {
        let conn = db::open_in_memory().unwrap();
        conn.execute(
            "INSERT INTO setting(key,value) VALUES(?1,?2)",
            [key, stored],
        )
        .unwrap();

        let error = settings::get_settings(&conn).unwrap_err();

        assert!(matches!(error, CoreError::Other(_)), "{key}={stored}");
    }
}

#[test]
fn save_settings_rolls_back_all_keys_when_one_write_fails() {
    let conn = db::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TRIGGER fail_break_setting BEFORE INSERT ON setting
         WHEN NEW.key='breakMinutes'
         BEGIN SELECT RAISE(ABORT, 'injected setting failure'); END;",
    )
    .unwrap();
    let value = settings::AppSettings {
        obsidian_vault: "/Notes".into(),
        pomodoro_minutes: 40,
        break_minutes: 8,
        remind_time: "08:30".into(),
    };

    let error = settings::save_settings(&conn, &value).unwrap_err();

    assert!(matches!(error, CoreError::Conflict(_)));
    let persisted: i64 = conn
        .query_row("SELECT count(*) FROM setting", [], |row| row.get(0))
        .unwrap();
    assert_eq!(persisted, 0);
}
