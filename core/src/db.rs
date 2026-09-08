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
    if v < 4 {
        tx.execute_batch(SCHEMA_V4)?;
        tx.pragma_update(None, "user_version", 4)?;
    }
    if v < 5 {
        tx.execute_batch(SCHEMA_V5)?;
        tx.pragma_update(None, "user_version", 5)?;
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

/// v4(2026-09-05,ADR-0001/0002/0003):追加式——spine 文本缓存、多段锚点、地图作业断点、AI 幂等请求、
/// 会话状态/版本/幂等键、回合表、投影 outbox。`ALTER TABLE ADD COLUMN` 不加 CHECK(旧行兼容),
/// `feynman_session.state`(open|evaluating|evaluated|confirmed|abandoned)与 `book.import_state`
/// (ready|extracted|mapped)在代码层校验。`transcript_json` 保留仅供回看,权威 transcript = `session_turn`。
/// `spine_item` 不对 href 唯一(EPUB spine 可重复引用同一 manifest 项)。
const SCHEMA_V4: &str = r#"
ALTER TABLE book ADD COLUMN map_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE book ADD COLUMN import_state TEXT NOT NULL DEFAULT 'ready';
CREATE TABLE spine_item(
  id INTEGER PRIMARY KEY, book_id INTEGER NOT NULL REFERENCES book(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL, href TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', text TEXT NOT NULL,
  UNIQUE(book_id, idx));
CREATE TABLE block_anchor(
  id INTEGER PRIMARY KEY, block_id INTEGER NOT NULL REFERENCES knowledge_block(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL, spine_href TEXT NOT NULL,
  cfi_start TEXT NOT NULL DEFAULT '', cfi_end TEXT NOT NULL DEFAULT '',
  precision TEXT NOT NULL CHECK(precision IN ('exact','chapter_fallback')),
  hint TEXT NOT NULL DEFAULT '', text TEXT NOT NULL DEFAULT '',
  UNIQUE(block_id, seq));
CREATE TABLE map_job(
  id INTEGER PRIMARY KEY, book_id INTEGER NOT NULL REFERENCES book(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL UNIQUE,
  stage TEXT NOT NULL CHECK(stage IN ('chapters','merge','done','failed')),
  next_chapter INTEGER NOT NULL DEFAULT 0, candidates_json TEXT NOT NULL DEFAULT '[]',
  draft_json TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE ai_request(
  request_id TEXT PRIMARY KEY, kind TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','done','failed')),
  attempts INTEGER NOT NULL DEFAULT 0, result TEXT, error TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
ALTER TABLE feynman_session ADD COLUMN task_id INTEGER REFERENCES daily_task(id) ON DELETE SET NULL;
ALTER TABLE feynman_session ADD COLUMN state TEXT NOT NULL DEFAULT 'open';
ALTER TABLE feynman_session ADD COLUMN version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE feynman_session ADD COLUMN client_request_id TEXT;
ALTER TABLE feynman_session ADD COLUMN verdict_request_id TEXT;
ALTER TABLE feynman_session ADD COLUMN verdict_json TEXT;
CREATE UNIQUE INDEX feynman_session_request ON feynman_session(client_request_id) WHERE client_request_id IS NOT NULL;
CREATE UNIQUE INDEX feynman_session_open_per_task ON feynman_session(task_id) WHERE task_id IS NOT NULL AND state IN ('open','evaluating','evaluated');
CREATE UNIQUE INDEX feynman_session_verdict_request ON feynman_session(verdict_request_id) WHERE verdict_request_id IS NOT NULL;
CREATE TABLE session_turn(
  id INTEGER PRIMARY KEY, session_id INTEGER NOT NULL REFERENCES feynman_session(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL, role TEXT NOT NULL CHECK(role IN ('user','student')), text TEXT NOT NULL,
  client_turn_id TEXT, status TEXT NOT NULL DEFAULT 'done' CHECK(status IN ('pending','done','failed')),
  created_at TEXT NOT NULL, UNIQUE(session_id, seq));
CREATE UNIQUE INDEX session_turn_client ON session_turn(session_id, client_turn_id) WHERE client_turn_id IS NOT NULL;
CREATE TABLE projection_outbox(
  id INTEGER PRIMARY KEY, op_id TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','done','failed')),
  attempts INTEGER NOT NULL DEFAULT 0, error TEXT, created_at TEXT NOT NULL, done_at TEXT);
"#;

/// v5(2026-09-08,M2 T0):追加式,**不重建任何表**(`session_turn.session_id … ON DELETE CASCADE` 在
/// foreign_keys=ON 下重建 `feynman_session` 会级联删光回合)。
/// - `feynman_session.extra_kind`:通过后附加环节(application|methodology|discussion),NULL = 普通会话;
///   `kind` 仍为 learn,任务关联为 NULL;每块每类只允许一次(partial unique index)。
/// - `study_minutes`:番茄钟专注分钟(date 由前端提供);`task_id` 可空且随任务删除置空。
const SCHEMA_V5: &str = r#"
ALTER TABLE feynman_session ADD COLUMN extra_kind TEXT CHECK(extra_kind IN ('application','methodology','discussion'));
CREATE UNIQUE INDEX feynman_session_extra_once ON feynman_session(block_id, extra_kind) WHERE extra_kind IS NOT NULL;
CREATE TABLE study_minutes(
  id INTEGER PRIMARY KEY, date TEXT NOT NULL,
  book_id INTEGER REFERENCES book(id) ON DELETE SET NULL,
  task_id INTEGER REFERENCES daily_task(id) ON DELETE SET NULL,
  minutes INTEGER NOT NULL CHECK(minutes >= 0),
  source TEXT NOT NULL CHECK(source IN ('pomodoro')),
  created_at TEXT NOT NULL);
CREATE INDEX study_minutes_date ON study_minutes(date);
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
    fn open_creates_base_tables() {
        let conn = super::open_in_memory().unwrap();
        let v: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(v, 5);
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
        assert_eq!(user_version(&conn), 5);
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
        assert_eq!(user_version(&conn), 5);
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

    fn legacy_v3(path: &std::path::Path) -> Connection {
        let legacy = legacy_v2(path);
        legacy.execute_batch(super::SCHEMA_V3).unwrap();
        legacy.pragma_update(None, "user_version", 3).unwrap();
        legacy
    }
    fn has_column(conn: &Connection, table: &str, col: &str) -> bool {
        count(
            conn,
            &format!("SELECT count(*) FROM pragma_table_info('{table}') WHERE name='{col}'"),
        ) == 1
    }

    #[test]
    fn open_creates_schema_v4() {
        let conn = super::open_in_memory().unwrap();
        assert_eq!(user_version(&conn), 5);
        for t in [
            "spine_item",
            "block_anchor",
            "map_job",
            "ai_request",
            "session_turn",
            "projection_outbox",
        ] {
            assert_eq!(
                count(
                    &conn,
                    &format!(
                        "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='{t}'"
                    )
                ),
                1,
                "missing table {t}"
            );
        }
        for c in [
            "task_id",
            "state",
            "version",
            "client_request_id",
            "verdict_request_id",
            "verdict_json",
        ] {
            assert!(
                has_column(&conn, "feynman_session", c),
                "feynman_session.{c}"
            );
        }
        for c in ["map_revision", "import_state"] {
            assert!(has_column(&conn, "book", c), "book.{c}");
        }
        for c in ["text", "hint"] {
            assert!(has_column(&conn, "block_anchor", c), "block_anchor.{c}");
        }
    }

    #[test]
    fn v3_rows_survive_v4() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("legacy.db");
        let legacy = legacy_v3(&path);
        legacy
            .execute_batch(
                "INSERT INTO book(id,title,type,slug) VALUES(1,'书','textbook','bk');
                 INSERT INTO knowledge_block(id,book_id,seq,title,slug) VALUES(7,1,1,'块','b1');
                 INSERT INTO feynman_session(id,block_id,kind,started_at) VALUES(5,7,'learn','2026-09-01');",
            )
            .unwrap();
        drop(legacy);
        let conn = super::open(&path).unwrap();
        assert_eq!(user_version(&conn), 5);
        let (state, version): (String, i64) = conn
            .query_row(
                "SELECT state,version FROM feynman_session WHERE id=5",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!((state.as_str(), version), ("open", 0));
        let (rev, import_state): (i64, String) = conn
            .query_row(
                "SELECT map_revision,import_state FROM book WHERE id=1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!((rev, import_state.as_str()), (0, "ready"));
        assert_eq!(
            count(&conn, "SELECT count(*) FROM knowledge_block WHERE id=7"),
            1
        );
    }

    #[test]
    fn v4_indexes_enforce_idempotency_keys() {
        let conn = super::open_in_memory().unwrap();
        let book = insert_book(&conn, "bk");
        conn.execute(
            "INSERT INTO knowledge_block(id,book_id,seq,title,slug) VALUES(7,?1,1,'块','b1')",
            [book],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO daily_task(id,date,book_id,block_id,kind,seq) VALUES(11,'2026-09-05',?1,7,'new',1)",
            [book],
        )
        .unwrap();
        // ai_request 以 request_id 为主键
        conn.execute(
            "INSERT INTO ai_request(request_id,kind,status,created_at,updated_at) VALUES('r1','turn','done','t','t')",
            [],
        )
        .unwrap();
        let e = conn
            .execute(
                "INSERT INTO ai_request(request_id,kind,status,created_at,updated_at) VALUES('r1','turn','done','t','t')",
                [],
            )
            .unwrap_err();
        assert_constraint_violation(e, ffi::SQLITE_CONSTRAINT_PRIMARYKEY);
        // 一任务一未确认会话;confirmed 不占槽
        conn.execute(
            "INSERT INTO feynman_session(id,block_id,kind,started_at,task_id,state) VALUES(1,7,'learn','t',11,'open')",
            [],
        )
        .unwrap();
        let e = conn
            .execute(
                "INSERT INTO feynman_session(id,block_id,kind,started_at,task_id,state) VALUES(2,7,'learn','t',11,'evaluating')",
                [],
            )
            .unwrap_err();
        assert_constraint_violation(e, ffi::SQLITE_CONSTRAINT_UNIQUE);
        conn.execute(
            "INSERT INTO feynman_session(id,block_id,kind,started_at,task_id,state) VALUES(2,7,'learn','t',11,'confirmed')",
            [],
        )
        .unwrap();
        // verdict_request_id / client_request_id 唯一
        conn.execute(
            "UPDATE feynman_session SET verdict_request_id='v1' WHERE id=2",
            [],
        )
        .unwrap();
        let e = conn
            .execute(
                "UPDATE feynman_session SET verdict_request_id='v1' WHERE id=1",
                [],
            )
            .unwrap_err();
        assert_constraint_violation(e, ffi::SQLITE_CONSTRAINT_UNIQUE);
        conn.execute(
            "UPDATE feynman_session SET client_request_id='c1' WHERE id=1",
            [],
        )
        .unwrap();
        let e = conn
            .execute(
                "UPDATE feynman_session SET client_request_id='c1' WHERE id=2",
                [],
            )
            .unwrap_err();
        assert_constraint_violation(e, ffi::SQLITE_CONSTRAINT_UNIQUE);
        // session_turn(session_id, client_turn_id) 唯一
        conn.execute(
            "INSERT INTO session_turn(session_id,seq,role,text,client_turn_id,created_at) VALUES(1,1,'user','x','t1','t')",
            [],
        )
        .unwrap();
        let e = conn
            .execute(
                "INSERT INTO session_turn(session_id,seq,role,text,client_turn_id,created_at) VALUES(1,2,'user','y','t1','t')",
                [],
            )
            .unwrap_err();
        assert_constraint_violation(e, ffi::SQLITE_CONSTRAINT_UNIQUE);
        // block_anchor(block_id, seq) 唯一
        conn.execute(
            "INSERT INTO block_anchor(block_id,seq,spine_href,precision) VALUES(7,1,'ch1.xhtml','chapter_fallback')",
            [],
        )
        .unwrap();
        let e = conn
            .execute(
                "INSERT INTO block_anchor(block_id,seq,spine_href,precision) VALUES(7,1,'ch2.xhtml','exact')",
                [],
            )
            .unwrap_err();
        assert_constraint_violation(e, ffi::SQLITE_CONSTRAINT_UNIQUE);
        // spine_item(book_id, idx) 唯一;同 href 不同 idx 允许
        conn.execute(
            "INSERT INTO spine_item(book_id,idx,href,text) VALUES(?1,0,'ch1.xhtml','a')",
            [book],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO spine_item(book_id,idx,href,text) VALUES(?1,1,'ch1.xhtml','b')",
            [book],
        )
        .unwrap();
        let e = conn
            .execute(
                "INSERT INTO spine_item(book_id,idx,href,text) VALUES(?1,1,'ch3.xhtml','c')",
                [book],
            )
            .unwrap_err();
        assert_constraint_violation(e, ffi::SQLITE_CONSTRAINT_UNIQUE);
    }

    #[test]
    fn v4_child_tables_enforce_foreign_keys() {
        let conn = super::open_in_memory().unwrap();
        for sql in [
            "INSERT INTO spine_item(book_id,idx,href,text) VALUES(999,0,'x','t')",
            "INSERT INTO block_anchor(block_id,seq,spine_href,precision) VALUES(999,1,'x','exact')",
            "INSERT INTO map_job(book_id,job_id,stage,created_at,updated_at) VALUES(999,'j','chapters','t','t')",
            "INSERT INTO session_turn(session_id,seq,role,text,created_at) VALUES(999,1,'user','x','t')",
        ] {
            let error = conn.execute(sql, []).unwrap_err();
            assert_constraint_violation(error, ffi::SQLITE_CONSTRAINT_FOREIGNKEY);
        }
        let book = insert_book(&conn, "bk");
        conn.execute(
            "INSERT INTO knowledge_block(id,book_id,seq,title,slug) VALUES(7,?1,1,'块','b1')",
            [book],
        )
        .unwrap();
        let error = conn
            .execute(
                "INSERT INTO feynman_session(block_id,kind,started_at,task_id) VALUES(7,'learn','t',999)",
                [],
            )
            .unwrap_err();
        assert_constraint_violation(error, ffi::SQLITE_CONSTRAINT_FOREIGNKEY);
    }

    fn legacy_v4(path: &std::path::Path) -> Connection {
        let legacy = legacy_v3(path);
        legacy.execute_batch(super::SCHEMA_V4).unwrap();
        legacy.pragma_update(None, "user_version", 4).unwrap();
        legacy
    }

    #[test]
    fn open_creates_schema_v5() {
        let conn = super::open_in_memory().unwrap();
        assert_eq!(user_version(&conn), 5);
        assert!(has_column(&conn, "feynman_session", "extra_kind"));
        assert_eq!(
            count(
                &conn,
                "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='study_minutes'"
            ),
            1
        );
        for idx in [
            "feynman_session_request",
            "feynman_session_open_per_task",
            "feynman_session_verdict_request",
            "feynman_session_extra_once",
            "study_minutes_date",
        ] {
            assert_eq!(
                count(
                    &conn,
                    &format!(
                        "SELECT count(*) FROM sqlite_master WHERE type='index' AND name='{idx}'"
                    )
                ),
                1,
                "missing index {idx}"
            );
        }
        // extra_kind 受 CHECK 约束;每块每类只允许一次
        conn.execute_batch(
            "INSERT INTO book(id,title,author,type,slug) VALUES(1,'b','a','textbook','b');
             INSERT INTO knowledge_block(id,book_id,module_name,seq,title,slug) VALUES(1,1,'m',1,'t','t');",
        )
        .unwrap();
        let insert = |kind: &str| {
            conn.execute(
                "INSERT INTO feynman_session(block_id,kind,started_at,extra_kind) VALUES(1,'learn','2026-09-08',?1)",
                [kind],
            )
        };
        assert!(insert("application").is_ok());
        assert!(
            insert("application").is_err(),
            "second application session for the block"
        );
        assert!(insert("bogus").is_err(), "extra_kind CHECK");
        assert!(
            conn.execute(
                "INSERT INTO study_minutes(date,book_id,task_id,minutes,source,created_at) \
                 VALUES('2026-09-08',1,NULL,-1,'pomodoro','2026-09-08')",
                [],
            )
            .is_err(),
            "negative minutes"
        );
    }

    #[test]
    fn v4_rows_survive_v5_without_rebuilding_sessions() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("legacy.db");
        let legacy = legacy_v4(&path);
        legacy
            .execute_batch(
                "INSERT INTO book(id,title,author,type,slug) VALUES(1,'b','a','textbook','b');
                 INSERT INTO knowledge_block(id,book_id,module_name,seq,title,slug) VALUES(1,1,'m',1,'t','t');
                 INSERT INTO feynman_session(id,block_id,kind,started_at,state,version,client_request_id) \
                   VALUES(7,1,'learn','2026-09-05','confirmed',4,'req-7');
                 INSERT INTO session_turn(session_id,seq,role,text,client_turn_id,created_at) \
                   VALUES(7,1,'user','讲','turn-1','2026-09-05'),(7,2,'student','问',NULL,'2026-09-05');",
            )
            .unwrap();
        drop(legacy);

        let conn = super::open(&path).unwrap();
        assert_eq!(user_version(&conn), 5);
        assert_eq!(count(&conn, "SELECT count(*) FROM session_turn"), 2);
        assert_eq!(
            count(&conn, "SELECT count(*) FROM feynman_session WHERE id=7 AND extra_kind IS NULL AND state='confirmed'"),
            1
        );
        for idx in [
            "feynman_session_request",
            "feynman_session_open_per_task",
            "session_turn_client",
        ] {
            assert_eq!(
                count(
                    &conn,
                    &format!(
                        "SELECT count(*) FROM sqlite_master WHERE type='index' AND name='{idx}'"
                    )
                ),
                1,
                "index {idx} lost"
            );
        }
        drop(conn);
        // 幂等:再次打开不报错、版本不变
        let again = super::open(&path).unwrap();
        assert_eq!(user_version(&again), 5);
        assert_eq!(count(&again, "SELECT count(*) FROM session_turn"), 2);
    }
}
