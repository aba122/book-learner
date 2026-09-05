use rusqlite::{ffi, Connection, Error, Transaction, TransactionBehavior};
use std::time::Duration;

/// 写锁等待上限。并发策略:所有连接设 busy_timeout;**所有读后写事务一律 BEGIN IMMEDIATE**
/// (SQLite 对已持 SHARED 的连接做 RESERVED 升级时不调用 busy handler,DEFERRED 会立刻 `database is locked`)。
const BUSY_TIMEOUT: Duration = Duration::from_secs(5);

pub fn open(path: &std::path::Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open(path)?;
    conn.busy_timeout(BUSY_TIMEOUT)?; // 显式声明策略(rusqlite 默认亦为 5s);必须在 configure 之前
    configure(&conn)?;
    Ok(conn)
}

pub fn open_in_memory() -> rusqlite::Result<Connection> {
    let conn = Connection::open_in_memory()?;
    conn.busy_timeout(BUSY_TIMEOUT)?;
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
        // 旧库收敛先于唯一索引:同书多计划留最新、多活跃留最新,否则 v2 索引会让迁移永久失败
        tx.execute_batch(CONVERGE_V2)?;
        tx.execute_batch(SCHEMA_V2)?;
        tx.pragma_update(None, "user_version", 2)?;
    }
    if v < 3 {
        tx.execute_batch(SCHEMA_V3)?;
        tx.pragma_update(None, "user_version", 3)?;
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

/// v2 前置收敛(仅对 user_version<2 的旧库执行)
const CONVERGE_V2: &str = r#"
DELETE FROM study_plan WHERE id NOT IN (SELECT max(id) FROM study_plan GROUP BY book_id);
UPDATE study_plan SET active=0
 WHERE active=1 AND id NOT IN (SELECT max(id) FROM study_plan WHERE active=1);
"#;

/// v3:主攻书唯一 + 子表重建补外键。
/// 事务内 foreign_keys=ON,`INSERT…SELECT` 遇孤儿行即失败并整体回滚(不静默通过);
/// 事务内无法切换 PRAGMA foreign_keys,故用"建新表→拷贝→删旧→改名"而非 OFF/ON 重建法。
/// `daily_task.ref_id` 为多态引用(weak_point.id 或 review_schedule.id),不加外键。
const SCHEMA_V3: &str = r#"
UPDATE book SET status='paused'
 WHERE status='active'
   AND id <> COALESCE(
     (SELECT sp.book_id FROM study_plan sp JOIN book b ON b.id=sp.book_id
       WHERE sp.active=1 AND b.status='active'),
     (SELECT max(id) FROM book WHERE status='active'));
CREATE UNIQUE INDEX book_single_active ON book(status) WHERE status='active';

CREATE TABLE daily_task_v3(
  id INTEGER PRIMARY KEY, date TEXT NOT NULL,
  book_id INTEGER NOT NULL REFERENCES book(id) ON DELETE CASCADE,
  block_id INTEGER NOT NULL REFERENCES knowledge_block(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('new','weak_retest','review')),
  seq INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','done','skipped')),
  est_minutes INTEGER NOT NULL DEFAULT 30, done_at TEXT,
  ref_id INTEGER);
INSERT INTO daily_task_v3(id,date,book_id,block_id,kind,seq,status,est_minutes,done_at,ref_id)
  SELECT id,date,book_id,block_id,kind,seq,status,est_minutes,done_at,ref_id FROM daily_task;
DROP TABLE daily_task;
ALTER TABLE daily_task_v3 RENAME TO daily_task;

CREATE TABLE feynman_session_v3(
  id INTEGER PRIMARY KEY,
  block_id INTEGER NOT NULL REFERENCES knowledge_block(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('learn','retest','review','final_exam')),
  transcript_json TEXT NOT NULL DEFAULT '[]', eval_json TEXT,
  started_at TEXT NOT NULL, ended_at TEXT, pomodoro_count INTEGER NOT NULL DEFAULT 0);
INSERT INTO feynman_session_v3(id,block_id,kind,transcript_json,eval_json,started_at,ended_at,pomodoro_count)
  SELECT id,block_id,kind,transcript_json,eval_json,started_at,ended_at,pomodoro_count FROM feynman_session;
DROP TABLE feynman_session;
ALTER TABLE feynman_session_v3 RENAME TO feynman_session;

CREATE TABLE weak_point_v3(
  id INTEGER PRIMARY KEY,
  block_id INTEGER NOT NULL REFERENCES knowledge_block(id) ON DELETE CASCADE,
  title TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', anchor_json TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','fixed')),
  pass_streak INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, fixed_at TEXT);
INSERT INTO weak_point_v3(id,block_id,title,detail,anchor_json,status,pass_streak,created_at,fixed_at)
  SELECT id,block_id,title,detail,anchor_json,status,pass_streak,created_at,fixed_at FROM weak_point;
DROP TABLE weak_point;
ALTER TABLE weak_point_v3 RENAME TO weak_point;

CREATE TABLE review_schedule_v3(
  id INTEGER PRIMARY KEY,
  block_id INTEGER NOT NULL REFERENCES knowledge_block(id) ON DELETE CASCADE,
  stage INTEGER NOT NULL CHECK(stage IN (1,3,7,14)),
  due_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'due' CHECK(status IN ('due','done','failed')));
INSERT INTO review_schedule_v3(id,block_id,stage,due_date,status)
  SELECT id,block_id,stage,due_date,status FROM review_schedule;
DROP TABLE review_schedule;
ALTER TABLE review_schedule_v3 RENAME TO review_schedule;

CREATE TABLE artifact_v3(
  id INTEGER PRIMARY KEY,
  book_id INTEGER NOT NULL REFERENCES book(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('restatement','methodology','reflection','application','report')),
  block_id INTEGER REFERENCES knowledge_block(id) ON DELETE SET NULL,
  content_md TEXT NOT NULL, created_at TEXT NOT NULL);
INSERT INTO artifact_v3(id,book_id,kind,block_id,content_md,created_at)
  SELECT id,book_id,kind,block_id,content_md,created_at FROM artifact;
DROP TABLE artifact;
ALTER TABLE artifact_v3 RENAME TO artifact;
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
        conn.query_row("PRAGMA foreign_keys", [], |r| r.get(0))
            .unwrap()
    }

    fn insert_book(conn: &Connection, slug: &str) -> i64 {
        conn.execute(
            "INSERT INTO book(title,type,slug,status) VALUES(?1,'textbook',?2,'paused')",
            [slug, slug],
        )
        .unwrap();
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
    fn open_creates_schema_v3() {
        let conn = super::open_in_memory().unwrap();
        let v: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(v, 3);
        for t in [
            "book",
            "knowledge_block",
            "study_plan",
            "daily_task",
            "feynman_session",
            "weak_point",
            "review_schedule",
            "artifact",
            "setting",
        ] {
            let n: i64 = conn
                .query_row(
                    "SELECT count(*) FROM sqlite_master WHERE type='table' AND name=?1",
                    [t],
                    |r| r.get(0),
                )
                .unwrap();
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
        first_migration
            .pragma_update(None, "user_version", 2)
            .unwrap();

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
            assert!(
                Instant::now() < deadline,
                "second migration never waited on SQLite's write lock"
            );
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
        assert!(error
            .to_string()
            .contains("failed to enable SQLite foreign keys: PRAGMA foreign_keys returned 0"));
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
        )
        .unwrap();

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

    fn legacy_v1(path: &std::path::Path) -> Connection {
        let legacy = Connection::open(path).unwrap();
        legacy.execute_batch(super::SCHEMA_V1).unwrap();
        legacy.pragma_update(None, "user_version", 1).unwrap();
        legacy
    }
    fn legacy_v2(path: &std::path::Path) -> Connection {
        let legacy = legacy_v1(path);
        legacy.execute_batch(super::SCHEMA_V2).unwrap();
        legacy.pragma_update(None, "user_version", 2).unwrap();
        legacy
    }
    fn user_version(conn: &Connection) -> i64 {
        conn.query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap()
    }
    fn count(conn: &Connection, sql: &str) -> i64 {
        conn.query_row(sql, [], |r| r.get(0)).unwrap()
    }
    /// 另一连接以 BEGIN IMMEDIATE 持写锁 hold_ms 后提交;recv 到信号即已持锁
    fn hold_write_lock(
        path: std::path::PathBuf,
        hold_ms: u64,
    ) -> (std::sync::mpsc::Receiver<()>, std::thread::JoinHandle<()>) {
        let (tx, rx) = sync_channel(0);
        let handle = std::thread::spawn(move || {
            let mut writer = Connection::open(path).unwrap();
            let held = writer
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .unwrap();
            tx.send(()).unwrap();
            std::thread::sleep(Duration::from_millis(hold_ms));
            held.commit().unwrap();
        });
        (rx, handle)
    }

    #[test]
    fn open_installs_busy_timeout_in_production_path() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("busy.db");
        super::open(&path).unwrap();
        let (started, writer) = hold_write_lock(path.clone(), 300);
        started.recv().unwrap();
        let conn = super::open(&path).expect("open 必须等待写锁,而非立即 SQLITE_BUSY");
        writer.join().unwrap();
        assert!(count(&conn, "PRAGMA busy_timeout") >= 5000);
    }

    #[test]
    fn generate_daily_waits_for_writer_lock_instead_of_failing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("queue.db");
        let conn = super::open(&path).unwrap();
        let book =
            crate::models::insert_book(&conn, "书", "", crate::models::BookType::Textbook, "bk")
                .unwrap();
        for i in 1..=2 {
            crate::models::insert_block(
                &conn,
                book,
                "m",
                i,
                &format!("块{i}"),
                &format!("b{i}"),
                &[],
            )
            .unwrap();
        }
        conn.execute(
            "INSERT INTO study_plan(book_id,deadline,daily_new_blocks) VALUES(?1,'2026-09-30',2)",
            [book],
        )
        .unwrap();
        let (started, writer) = hold_write_lock(path.clone(), 300);
        started.recv().unwrap();
        let queue = crate::sched::generate_daily(&conn, "2026-09-05")
            .expect("读后写事务须 BEGIN IMMEDIATE:DEFERRED 升级锁时 SQLite 不调用 busy handler");
        writer.join().unwrap();
        assert_eq!(queue.len(), 2);
    }

    #[test]
    fn v1_with_two_active_plans_migrates_to_single_active() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("legacy.db");
        let legacy = legacy_v1(&path);
        let a = insert_book(&legacy, "a");
        let b = insert_book(&legacy, "b");
        for book in [a, b] {
            legacy.execute(
                "INSERT INTO study_plan(book_id,deadline,daily_new_blocks) VALUES(?1,'2026-09-30',2)",
                [book],
            ).unwrap();
        }
        drop(legacy);
        let conn = super::open(&path).expect("多活跃计划的旧库必须可迁移,不得永久锁死");
        assert_eq!(user_version(&conn), 3);
        assert_eq!(count(&conn, "SELECT count(*) FROM study_plan"), 2);
        let active_book: i64 = conn
            .query_row("SELECT book_id FROM study_plan WHERE active=1", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(active_book, b, "保留 id 最大的活跃计划");
    }

    #[test]
    fn v1_with_two_plans_same_book_keeps_latest() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("legacy.db");
        let legacy = legacy_v1(&path);
        let a = insert_book(&legacy, "a");
        for deadline in ["2026-09-30", "2026-12-31"] {
            legacy.execute(
                "INSERT INTO study_plan(book_id,deadline,daily_new_blocks,active) VALUES(?1,?2,2,0)",
                rusqlite::params![a, deadline],
            ).unwrap();
        }
        drop(legacy);
        let conn = super::open(&path).unwrap();
        assert_eq!(count(&conn, "SELECT count(*) FROM study_plan"), 1);
        let deadline: String = conn
            .query_row("SELECT deadline FROM study_plan", [], |r| r.get(0))
            .unwrap();
        assert_eq!(deadline, "2026-12-31");
    }

    #[test]
    fn book_status_active_is_unique_after_v3() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("legacy.db");
        let legacy = legacy_v1(&path);
        for slug in ["one", "two", "three"] {
            // v1 默认 status='active':三本全活跃
            legacy
                .execute(
                    "INSERT INTO book(title,type,slug) VALUES(?1,'textbook',?1)",
                    [slug],
                )
                .unwrap();
        }
        legacy.execute(
            "INSERT INTO study_plan(book_id,deadline,daily_new_blocks,active) VALUES(2,'2026-09-30',2,1)",
            [],
        ).unwrap();
        drop(legacy);
        let conn = super::open(&path).unwrap();
        let active: Vec<i64> = conn
            .prepare("SELECT id FROM book WHERE status='active'")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(active, vec![2], "优先保留持有活跃计划的那本书");
        let error = conn
            .execute(
                "INSERT INTO book(title,type,slug,status) VALUES('四','textbook','four','active')",
                [],
            )
            .unwrap_err();
        assert_constraint_violation(error, ffi::SQLITE_CONSTRAINT_UNIQUE);
    }

    #[test]
    fn v3_child_tables_enforce_foreign_keys() {
        let conn = super::open_in_memory().unwrap();
        for sql in [
            "INSERT INTO weak_point(block_id,title,created_at) VALUES(999,'w','2026-09-05')",
            "INSERT INTO review_schedule(block_id,stage,due_date) VALUES(999,1,'2026-09-06')",
            "INSERT INTO daily_task(date,book_id,block_id,kind,seq) VALUES('2026-09-05',999,999,'new',1)",
            "INSERT INTO feynman_session(block_id,kind,started_at) VALUES(999,'learn','2026-09-05')",
            "INSERT INTO artifact(book_id,kind,content_md,created_at) VALUES(999,'report','x','2026-09-05')",
        ] {
            let error = conn.execute(sql, []).unwrap_err();
            assert_constraint_violation(error, ffi::SQLITE_CONSTRAINT_FOREIGNKEY);
        }
    }

    #[test]
    fn v2_with_orphan_rows_fails_migration_and_rolls_back() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("legacy.db");
        let legacy = legacy_v2(&path); // 原生连接外键关闭,可写入孤儿行
        legacy
            .execute(
                "INSERT INTO weak_point(block_id,title,created_at) VALUES(999,'orphan','2026-09-05')",
                [],
            )
            .unwrap();
        drop(legacy);
        assert!(
            super::open(&path).is_err(),
            "孤儿行必须导致 v3 迁移失败而非静默通过"
        );
        let raw = Connection::open(&path).unwrap();
        assert_eq!(user_version(&raw), 2);
        assert_eq!(count(&raw, "SELECT count(*) FROM weak_point"), 1);
        assert_eq!(
            count(
                &raw,
                "SELECT count(*) FROM sqlite_master WHERE name LIKE '%\\_v3' ESCAPE '\\'"
            ),
            0
        );
        assert_eq!(
            count(
                &raw,
                "SELECT count(*) FROM pragma_foreign_key_list('weak_point')"
            ),
            0
        );
    }

    #[test]
    fn v1_legacy_rows_survive_v3_rebuild() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("legacy.db");
        let legacy = legacy_v1(&path);
        legacy.execute_batch(
            "INSERT INTO book(id,title,type,slug) VALUES(1,'书','textbook','bk');
             INSERT INTO knowledge_block(id,book_id,seq,title,slug) VALUES(7,1,1,'块','b1');
             INSERT INTO weak_point(id,block_id,title,detail,created_at) VALUES(3,7,'弹性vs斜率','混淆','2026-09-01');
             INSERT INTO review_schedule(block_id,stage,due_date) VALUES(7,3,'2026-09-08');
             INSERT INTO daily_task(date,book_id,block_id,kind,seq,ref_id) VALUES('2026-09-05',1,7,'weak_retest',1,3);
             INSERT INTO feynman_session(block_id,kind,started_at) VALUES(7,'learn','2026-09-01');
             INSERT INTO artifact(book_id,kind,block_id,content_md,created_at) VALUES(1,'restatement',7,'x','2026-09-01');",
        ).unwrap();
        drop(legacy);
        let conn = super::open(&path).unwrap();
        assert_eq!(user_version(&conn), 3);
        let (id, title, detail): (i64, String, String) = conn
            .query_row("SELECT id,title,detail FROM weak_point", [], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            })
            .unwrap();
        assert_eq!(
            (id, title.as_str(), detail.as_str()),
            (3, "弹性vs斜率", "混淆")
        );
        let ref_id: i64 = conn
            .query_row("SELECT ref_id FROM daily_task", [], |r| r.get(0))
            .unwrap();
        assert_eq!(ref_id, 3);
        for t in ["review_schedule", "feynman_session", "artifact"] {
            assert_eq!(count(&conn, &format!("SELECT count(*) FROM {t}")), 1, "{t}");
        }
        for t in [
            "daily_task",
            "feynman_session",
            "weak_point",
            "review_schedule",
            "artifact",
        ] {
            assert!(
                count(
                    &conn,
                    &format!("SELECT count(*) FROM pragma_foreign_key_list('{t}')")
                ) >= 1,
                "{t} 应声明外键"
            );
        }
    }
}
