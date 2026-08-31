use rusqlite::{ffi, Connection, Error, Transaction, TransactionBehavior};

pub fn open(path: &std::path::Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open(path)?;
    configure(&conn)?;
    Ok(conn)
}

pub fn open_in_memory() -> rusqlite::Result<Connection> {
    let conn = Connection::open_in_memory()?;
    configure(&conn)?;
    Ok(conn)
}

fn configure(conn: &Connection) -> rusqlite::Result<()> {
    conn.pragma_update(None, "foreign_keys", "ON")?;
    let foreign_keys: i64 = conn.query_row("PRAGMA foreign_keys", [], |r| r.get(0))?;
    if foreign_keys != 1 {
        return Err(Error::SqliteFailure(
            ffi::Error::new(ffi::SQLITE_ERROR),
            Some(format!(
                "failed to enable SQLite foreign keys: PRAGMA foreign_keys returned {foreign_keys}"
            )),
        ));
    }
    migrate(conn)
}

fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate)?;
    let v: i64 = tx.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if v < 1 {
        tx.execute_batch(SCHEMA_V1)?;
        tx.pragma_update(None, "user_version", 1)?;
    }
    if v < 2 {
        tx.execute_batch(SCHEMA_V2)?;
        tx.pragma_update(None, "user_version", 2)?;
    }
    tx.commit()
}

const SCHEMA_V1: &str = r#"
CREATE TABLE book(
  id INTEGER PRIMARY KEY, title TEXT NOT NULL, author TEXT DEFAULT '',
  type TEXT NOT NULL CHECK(type IN ('textbook','methodology','humanities')),
  epub_path TEXT DEFAULT '', cover_path TEXT DEFAULT '',
  slug TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','finished')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE knowledge_block(
  id INTEGER PRIMARY KEY, book_id INTEGER NOT NULL REFERENCES book(id),
  module_name TEXT NOT NULL DEFAULT '', seq INTEGER NOT NULL,
  title TEXT NOT NULL, slug TEXT NOT NULL,
  spine_href TEXT DEFAULT '', cfi_start TEXT DEFAULT '', cfi_end TEXT DEFAULT '',
  prereq_ids TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'unlearned'
    CHECK(status IN ('unlearned','learning','passed','weak','consolidated')),
  scores_json TEXT, passed_at TEXT, skipped INTEGER NOT NULL DEFAULT 0);
CREATE TABLE study_plan(
  id INTEGER PRIMARY KEY, book_id INTEGER NOT NULL REFERENCES book(id),
  deadline TEXT NOT NULL, daily_new_blocks INTEGER NOT NULL,
  daily_cap INTEGER NOT NULL DEFAULT 4,
  remind_time TEXT DEFAULT '20:00', evening_remind_time TEXT DEFAULT '22:00',
  active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE daily_task(
  id INTEGER PRIMARY KEY, date TEXT NOT NULL,
  book_id INTEGER NOT NULL, block_id INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('new','weak_retest','review')),
  seq INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','done','skipped')),
  est_minutes INTEGER NOT NULL DEFAULT 30, done_at TEXT,
  ref_id INTEGER);
CREATE TABLE feynman_session(
  id INTEGER PRIMARY KEY, block_id INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('learn','retest','review','final_exam')),
  transcript_json TEXT NOT NULL DEFAULT '[]', eval_json TEXT,
  started_at TEXT NOT NULL, ended_at TEXT, pomodoro_count INTEGER NOT NULL DEFAULT 0);
CREATE TABLE weak_point(
  id INTEGER PRIMARY KEY, block_id INTEGER NOT NULL,
  title TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', anchor_json TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','fixed')),
  pass_streak INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, fixed_at TEXT);
CREATE TABLE review_schedule(
  id INTEGER PRIMARY KEY, block_id INTEGER NOT NULL,
  stage INTEGER NOT NULL CHECK(stage IN (1,3,7,14)),
  due_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'due' CHECK(status IN ('due','done','failed')));
CREATE TABLE artifact(
  id INTEGER PRIMARY KEY, book_id INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('restatement','methodology','reflection','application','report')),
  block_id INTEGER, content_md TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE setting(key TEXT PRIMARY KEY, value TEXT NOT NULL);
"#;

const SCHEMA_V2: &str = r#"
CREATE UNIQUE INDEX study_plan_one_per_book ON study_plan(book_id);
CREATE UNIQUE INDEX study_plan_single_active ON study_plan(active) WHERE active=1;
"#;

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::mpsc::sync_channel;
    use std::time::{Duration, Instant};

    use rusqlite::{ffi, Connection, Error, ErrorCode, TransactionBehavior};

    static MIGRATION_WAITING_ON_LOCK: AtomicBool = AtomicBool::new(false);

    fn mark_migration_waiting_on_lock(_: i32) -> bool {
        MIGRATION_WAITING_ON_LOCK.store(true, Ordering::SeqCst);
        std::thread::yield_now();
        true
    }

    fn foreign_keys(conn: &Connection) -> i64 {
        conn.query_row("PRAGMA foreign_keys", [], |r| r.get(0)).unwrap()
    }

    fn insert_book(conn: &Connection, slug: &str) -> i64 {
        conn.execute(
            "INSERT INTO book(title,type,slug) VALUES(?1,'textbook',?2)",
            [slug, slug],
        ).unwrap();
        conn.last_insert_rowid()
    }

    fn assert_constraint_violation(error: Error, expected_extended_code: i32) {
        match error {
            Error::SqliteFailure(sqlite_error, _) => {
                assert_eq!(sqlite_error.code, ErrorCode::ConstraintViolation);
                assert_eq!(sqlite_error.extended_code, expected_extended_code);
            }
            other => panic!("expected SQLite constraint violation, got {other:?}"),
        }
    }

    #[test]
    fn open_creates_schema_v2() {
        let conn = super::open_in_memory().unwrap();
        let v: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(v, 2);
        for t in ["book","knowledge_block","study_plan","daily_task",
                  "feynman_session","weak_point","review_schedule","artifact","setting"] {
            let n: i64 = conn.query_row(
                "SELECT count(*) FROM sqlite_master WHERE type='table' AND name=?1",
                [t], |r| r.get(0)).unwrap();
            assert_eq!(n, 1, "missing table {t}");
        }
    }
    #[test]
    fn open_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.db");
        super::open(&p).unwrap();
        super::open(&p).unwrap();
    }

    #[test]
    fn concurrent_open_waits_before_reading_migration_version() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("concurrent-migration.db");
        let legacy = Connection::open(&path).unwrap();
        legacy.execute_batch(super::SCHEMA_V1).unwrap();
        legacy.pragma_update(None, "user_version", 1).unwrap();
        drop(legacy);

        let mut first = Connection::open(&path).unwrap();
        let first_migration = first
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .unwrap();
        first_migration.execute_batch(super::SCHEMA_V2).unwrap();
        first_migration.pragma_update(None, "user_version", 2).unwrap();

        MIGRATION_WAITING_ON_LOCK.store(false, Ordering::SeqCst);
        let second_path = path.clone();
        let (started_tx, started_rx) = sync_channel(0);
        let second = std::thread::spawn(move || -> rusqlite::Result<()> {
            let conn = Connection::open(second_path)?;
            conn.busy_handler(Some(mark_migration_waiting_on_lock))?;
            started_tx.send(()).unwrap();
            super::configure(&conn)
        });
        started_rx.recv_timeout(Duration::from_secs(1)).unwrap();

        let deadline = Instant::now() + Duration::from_secs(2);
        while !MIGRATION_WAITING_ON_LOCK.load(Ordering::SeqCst) {
            assert!(Instant::now() < deadline, "second migration never waited on SQLite's write lock");
            std::thread::yield_now();
        }

        first_migration.commit().unwrap();
        second.join().unwrap().unwrap();
    }

    #[test]
    fn open_in_memory_enables_foreign_keys() {
        let conn = super::open_in_memory().unwrap();
        assert_eq!(foreign_keys(&conn), 1);
    }

    #[test]
    fn configure_enables_foreign_keys_when_connection_starts_disabled() {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "OFF").unwrap();
        assert_eq!(foreign_keys(&conn), 0);

        super::configure(&conn).unwrap();

        assert_eq!(foreign_keys(&conn), 1);
    }

    #[test]
    fn configure_fails_clearly_when_foreign_keys_cannot_be_enabled() {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "OFF").unwrap();
        let tx = conn.unchecked_transaction().unwrap();

        let error = super::configure(&tx).unwrap_err();

        assert_eq!(foreign_keys(&tx), 0);
        assert!(error.to_string().contains(
            "failed to enable SQLite foreign keys: PRAGMA foreign_keys returned 0"
        ));
    }

    #[test]
    fn disk_connections_enable_foreign_keys_after_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("foreign-keys.db");

        let conn = super::open(&path).unwrap();
        assert_eq!(foreign_keys(&conn), 1);
        drop(conn);

        let reopened = super::open(&path).unwrap();
        assert_eq!(foreign_keys(&reopened), 1);
    }

    #[test]
    fn foreign_keys_reject_orphan_knowledge_blocks() {
        let conn = super::open_in_memory().unwrap();
        let error = conn.execute(
            "INSERT INTO knowledge_block(book_id,seq,title,slug) VALUES(999,1,'orphan','orphan')",
            [],
        ).unwrap_err();

        assert_constraint_violation(error, ffi::SQLITE_CONSTRAINT_FOREIGNKEY);
    }

    #[test]
    fn study_plan_allows_only_one_plan_per_book() {
        let conn = super::open_in_memory().unwrap();
        let book = insert_book(&conn, "one-plan");
        conn.execute(
            "INSERT INTO study_plan(book_id,deadline,daily_new_blocks,active) VALUES(?1,'2026-09-30',2,0)",
            [book],
        ).unwrap();

        let error = conn.execute(
            "INSERT INTO study_plan(book_id,deadline,daily_new_blocks,active) VALUES(?1,'2026-10-31',1,0)",
            [book],
        ).unwrap_err();

        assert_constraint_violation(error, ffi::SQLITE_CONSTRAINT_UNIQUE);
        let index_exists: i64 = conn.query_row(
            "SELECT count(*) FROM sqlite_master WHERE type='index' AND name='study_plan_one_per_book'",
            [],
            |r| r.get(0),
        ).unwrap();
        assert_eq!(index_exists, 1);
    }

    #[test]
    fn study_plan_allows_only_one_active_plan() {
        let conn = super::open_in_memory().unwrap();
        let first_book = insert_book(&conn, "first-active");
        let second_book = insert_book(&conn, "second-active");
        conn.execute(
            "INSERT INTO study_plan(book_id,deadline,daily_new_blocks) VALUES(?1,'2026-09-30',2)",
            [first_book],
        ).unwrap();

        let error = conn.execute(
            "INSERT INTO study_plan(book_id,deadline,daily_new_blocks) VALUES(?1,'2026-10-31',1)",
            [second_book],
        ).unwrap_err();

        assert_constraint_violation(error, ffi::SQLITE_CONSTRAINT_UNIQUE);
        let index_sql: String = conn.query_row(
            "SELECT sql FROM sqlite_master WHERE type='index' AND name='study_plan_single_active'",
            [],
            |r| r.get(0),
        ).unwrap();
        assert_eq!(
            index_sql,
            "CREATE UNIQUE INDEX study_plan_single_active ON study_plan(active) WHERE active=1"
        );
    }

    #[test]
    fn conflicting_v1_study_plans_abort_v2_migration_without_data_loss() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("legacy-v1.db");
        let legacy = Connection::open(&path).unwrap();
        legacy.execute_batch(super::SCHEMA_V1).unwrap();
        legacy.pragma_update(None, "user_version", 1).unwrap();
        let first_book = insert_book(&legacy, "legacy-first");
        let second_book = insert_book(&legacy, "legacy-second");
        for book in [first_book, second_book] {
            legacy.execute(
                "INSERT INTO study_plan(book_id,deadline,daily_new_blocks) VALUES(?1,'2026-09-30',2)",
                [book],
            ).unwrap();
        }
        drop(legacy);

        assert!(super::open(&path).is_err());

        let unchanged = Connection::open(&path).unwrap();
        let version: i64 = unchanged.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        let plans: i64 = unchanged.query_row("SELECT count(*) FROM study_plan", [], |r| r.get(0)).unwrap();
        let v2_indexes: i64 = unchanged.query_row(
            "SELECT count(*) FROM sqlite_master WHERE type='index' AND name IN ('study_plan_one_per_book','study_plan_single_active')",
            [],
            |r| r.get(0),
        ).unwrap();
        assert_eq!(version, 1);
        assert_eq!(plans, 2);
        assert_eq!(v2_indexes, 0);
    }
}
