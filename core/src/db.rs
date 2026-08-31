use rusqlite::Connection;

pub fn open(path: &std::path::Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open(path)?;
    migrate(&conn)?;
    Ok(conn)
}

pub fn open_in_memory() -> rusqlite::Result<Connection> {
    let conn = Connection::open_in_memory()?;
    migrate(&conn)?;
    Ok(conn)
}

fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    let v: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if v < 1 {
        conn.execute_batch(SCHEMA_V1)?;
        conn.pragma_update(None, "user_version", 1)?;
    }
    Ok(())
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

#[cfg(test)]
mod tests {
    #[test]
    fn open_creates_schema_v1() {
        let conn = super::open_in_memory().unwrap();
        let v: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(v, 1);
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
}
