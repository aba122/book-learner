//! SQLite 快照与恢复(TECH_DESIGN §3.4;M3 T5)。
//!
//! - 快照:`VACUUM INTO` 到 `<snapshots>/app-YYYY-MM-DD.db`(同日覆盖;先写 `.tmp` + fsync 再改名);
//!   保留最近 7 份 + 最近 3 个月各自最早的一份。快照目录**不进 memory/ git**。
//! - 恢复:`restore_plan` 只接受快照目录内匹配 `app-YYYY-MM-DD.db` 的文件名(不接受任意路径),
//!   校验 `integrity_check` 与 `user_version ≤ SCHEMA_VERSION`;`request_restore` 写待恢复标记,
//!   `apply_pending_restore` 在下次启动**打开数据库之前**替换 `app.db`(连带移走 -journal/-wal/-shm,
//!   原库保留为 `app.db.replaced-<ts>`)。
use rusqlite::{Connection, OpenFlags};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use crate::{CoreError, Result};

pub const SNAPSHOT_DIR_NAME: &str = "snapshots";
pub const RESTORE_MARKER: &str = "restore-pending.json";
pub const KEEP_RECENT: usize = 7;
pub const KEEP_MONTHS: usize = 3;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct SnapshotInfo {
    pub name: String,
    pub date: String,
    pub bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RestorePlan {
    pub path: PathBuf,
    pub name: String,
    pub user_version: i64,
    pub bytes: u64,
}

fn snapshot_name(date: &str) -> Result<String> {
    if !is_snapshot_name(&format!("app-{date}.db")) {
        return Err(CoreError::InvalidInput(format!(
            "invalid snapshot date {date:?}, expected YYYY-MM-DD"
        )));
    }
    Ok(format!("app-{date}.db"))
}

/// `app-YYYY-MM-DD.db`(只允许数字与横线,防路径穿越)
pub fn is_snapshot_name(name: &str) -> bool {
    let Some(rest) = name.strip_prefix("app-") else {
        return false;
    };
    let Some(date) = rest.strip_suffix(".db") else {
        return false;
    };
    let bytes = date.as_bytes();
    bytes.len() == 10
        && bytes.iter().enumerate().all(|(i, b)| {
            if i == 4 || i == 7 {
                *b == b'-'
            } else {
                b.is_ascii_digit()
            }
        })
}

fn date_of(name: &str) -> &str {
    &name[4..14]
}

/// 在独立连接上 `VACUUM INTO` 生成当日快照并按保留策略修剪;返回快照路径。
pub fn snapshot(conn: &Connection, dir: &Path, date: &str) -> Result<PathBuf> {
    let name = snapshot_name(date)?;
    std::fs::create_dir_all(dir)?;
    let path = dir.join(&name);
    let tmp = dir.join(format!("{name}.tmp"));
    let _ = std::fs::remove_file(&tmp);
    conn.execute("VACUUM INTO ?1", [tmp.to_string_lossy().as_ref()])?;
    std::fs::File::open(&tmp)?.sync_all()?;
    std::fs::rename(&tmp, &path)?;
    prune(dir)?;
    Ok(path)
}

/// 保留最近 `KEEP_RECENT` 份 + 最近 `KEEP_MONTHS` 个月各自最早的一份;其余删除。只删本模块命名的文件。
pub fn prune(dir: &Path) -> Result<Vec<String>> {
    let mut names: Vec<String> = list(dir)?.into_iter().map(|s| s.name).collect(); // 新 → 旧
    let mut keep: std::collections::HashSet<String> =
        names.iter().take(KEEP_RECENT).cloned().collect();
    let mut by_month: BTreeMap<String, String> = BTreeMap::new(); // 月 → 最早的一份
    for name in &names {
        let month = date_of(name)[..7].to_string();
        by_month.insert(month, name.clone()); // 列表新→旧,后写入的更早
    }
    for (_, earliest) in by_month.iter().rev().take(KEEP_MONTHS) {
        keep.insert(earliest.clone());
    }
    names.retain(|n| !keep.contains(n));
    for name in &names {
        std::fs::remove_file(dir.join(name))?;
    }
    Ok(names)
}

/// 快照清单,新 → 旧。
pub fn list(dir: &Path) -> Result<Vec<SnapshotInfo>> {
    let mut out = Vec::new();
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(out),
        Err(e) => return Err(e.into()),
    };
    for entry in entries {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if !is_snapshot_name(&name) {
            continue;
        }
        out.push(SnapshotInfo {
            date: date_of(&name).to_string(),
            bytes: entry.metadata()?.len(),
            name,
        });
    }
    out.sort_by(|a, b| b.name.cmp(&a.name));
    Ok(out)
}

/// 校验一份快照可恢复:名字白名单、位于快照目录、`integrity_check` ok、`user_version ≤ SCHEMA_VERSION`。
pub fn restore_plan(dir: &Path, name: &str) -> Result<RestorePlan> {
    if !is_snapshot_name(name) {
        return Err(CoreError::InvalidInput(format!(
            "{name:?} is not a snapshot name"
        )));
    }
    let path = dir.join(name);
    let bytes = std::fs::metadata(&path)
        .map_err(|_| CoreError::NotFound(format!("snapshot {name}")))?
        .len();
    let conn = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let integrity: String = conn.query_row("PRAGMA integrity_check", [], |r| r.get(0))?;
    if integrity != "ok" {
        return Err(CoreError::InvalidInput(format!(
            "snapshot {name} failed integrity_check: {integrity}"
        )));
    }
    let user_version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if user_version > crate::db::SCHEMA_VERSION {
        return Err(CoreError::InvalidInput(format!(
            "snapshot {name} is schema v{user_version}, newer than this app (v{})",
            crate::db::SCHEMA_VERSION
        )));
    }
    Ok(RestorePlan {
        path,
        name: name.to_string(),
        user_version,
        bytes,
    })
}

/// 写待恢复标记(下次启动生效);先校验。
pub fn request_restore(data_root: &Path, name: &str) -> Result<RestorePlan> {
    let plan = restore_plan(&data_root.join(SNAPSHOT_DIR_NAME), name)?;
    let marker =
        serde_json::json!({ "name": plan.name, "requested_at": chrono::Utc::now().to_rfc3339() });
    crate::memory::atomic_write(&data_root.join(RESTORE_MARKER), &marker.to_string())?;
    Ok(plan)
}

pub fn pending_restore(data_root: &Path) -> Option<String> {
    let text = std::fs::read_to_string(data_root.join(RESTORE_MARKER)).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    value.get("name")?.as_str().map(str::to_string)
}

pub fn cancel_restore(data_root: &Path) -> Result<()> {
    match std::fs::remove_file(data_root.join(RESTORE_MARKER)) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.into()),
    }
}

/// 启动时(打开数据库之前)应用待恢复标记:再次校验 → 原库改名 `app.db.replaced-<ts>` → 移走热日志 →
/// 复制快照为 `app.db`。返回被应用的快照名;无标记返回 None。标记无论成败都被移除(避免启动循环)。
pub fn apply_pending_restore(data_root: &Path, database_path: &Path) -> Result<Option<String>> {
    let Some(name) = pending_restore(data_root) else {
        return Ok(None);
    };
    cancel_restore(data_root)?;
    let plan = restore_plan(&data_root.join(SNAPSHOT_DIR_NAME), &name)?;
    let stamp = chrono::Utc::now().format("%Y%m%d-%H%M%S");
    if database_path.exists() {
        let replaced = database_path.with_file_name(format!(
            "{}.replaced-{stamp}",
            database_path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| "app.db".into())
        ));
        std::fs::rename(database_path, &replaced)?;
    }
    for suffix in ["-journal", "-wal", "-shm"] {
        let side = database_path.with_file_name(format!(
            "{}{suffix}",
            database_path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| "app.db".into())
        ));
        match std::fs::rename(&side, side.with_extension(format!("replaced-{stamp}"))) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
    }
    let tmp = database_path.with_extension("db.restoring");
    std::fs::copy(&plan.path, &tmp)?;
    std::fs::File::open(&tmp)?.sync_all()?;
    std::fs::rename(&tmp, database_path)?;
    Ok(Some(name))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seeded_db(path: &Path) -> Connection {
        let conn = crate::db::open(path).unwrap();
        crate::models::insert_book(&conn, "书", "", crate::models::BookType::Textbook, "bk")
            .unwrap();
        conn
    }

    #[test]
    fn snapshot_names_are_strict() {
        assert!(is_snapshot_name("app-2026-09-08.db"));
        for bad in [
            "app-2026-09-08.db.tmp",
            "../app-2026-09-08.db",
            "app-2026-9-8.db",
            "x.db",
            "app-2026-09-08.db/",
            "app-2026-09-0a.db",
        ] {
            assert!(!is_snapshot_name(bad), "{bad}");
        }
        assert!(matches!(
            restore_plan(Path::new("/tmp"), "../etc/passwd"),
            Err(CoreError::InvalidInput(_))
        ));
    }

    #[test]
    fn snapshot_writes_a_valid_copy_and_overwrites_same_day() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("app.db");
        let conn = seeded_db(&db);
        let snaps = dir.path().join(SNAPSHOT_DIR_NAME);
        let p = snapshot(&conn, &snaps, "2026-09-08").unwrap();
        assert_eq!(p, snaps.join("app-2026-09-08.db"));
        assert!(!snaps.join("app-2026-09-08.db.tmp").exists());
        let plan = restore_plan(&snaps, "app-2026-09-08.db").unwrap();
        assert_eq!(plan.user_version, crate::db::SCHEMA_VERSION);
        let copy = Connection::open(&p).unwrap();
        let n: i64 = copy
            .query_row("SELECT count(*) FROM book", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1);
        // 同日再快照:覆盖而非报错
        crate::models::insert_book(&conn, "书2", "", crate::models::BookType::Textbook, "bk2")
            .unwrap();
        snapshot(&conn, &snaps, "2026-09-08").unwrap();
        let copy = Connection::open(&p).unwrap();
        let n: i64 = copy
            .query_row("SELECT count(*) FROM book", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 2);
        assert_eq!(list(&snaps).unwrap().len(), 1);
        assert!(matches!(
            snapshot(&conn, &snaps, "bad"),
            Err(CoreError::InvalidInput(_))
        ));
    }

    #[test]
    fn prune_keeps_seven_recent_plus_earliest_of_three_months() {
        let dir = tempfile::tempdir().unwrap();
        let dates = [
            "2026-06-03",
            "2026-06-20",
            "2026-07-01",
            "2026-07-15",
            "2026-08-02",
            "2026-08-09",
            "2026-08-30",
            "2026-09-01",
            "2026-09-02",
            "2026-09-03",
            "2026-09-04",
            "2026-09-05",
            "2026-09-06",
            "2026-09-07",
            "2026-09-08",
        ];
        for d in dates {
            std::fs::write(dir.path().join(format!("app-{d}.db")), b"x").unwrap();
        }
        std::fs::write(dir.path().join("notes.txt"), b"keep").unwrap();
        let removed = prune(dir.path()).unwrap();
        let mut kept: Vec<String> = list(dir.path())
            .unwrap()
            .into_iter()
            .map(|s| s.date)
            .collect();
        kept.sort();
        // 最近 7 份(09-02..09-08)+ 9 月最早 09-01 + 8 月最早 08-02 + 7 月最早 07-01;6 月整月删除
        assert_eq!(
            kept,
            vec![
                "2026-07-01",
                "2026-08-02",
                "2026-09-01",
                "2026-09-02",
                "2026-09-03",
                "2026-09-04",
                "2026-09-05",
                "2026-09-06",
                "2026-09-07",
                "2026-09-08"
            ]
        );
        assert_eq!(removed.len(), 5);
        assert!(dir.path().join("notes.txt").exists());
    }

    #[test]
    fn restore_marker_is_applied_before_open_and_moves_journals_aside() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("app.db");
        let conn = seeded_db(&db);
        let snaps = dir.path().join(SNAPSHOT_DIR_NAME);
        snapshot(&conn, &snaps, "2026-09-08").unwrap();
        crate::models::insert_book(
            &conn,
            "后来的书",
            "",
            crate::models::BookType::Textbook,
            "later",
        )
        .unwrap();
        drop(conn);
        std::fs::write(dir.path().join("app.db-journal"), b"hot").unwrap();
        assert!(matches!(
            request_restore(dir.path(), "app-2000-01-01.db"),
            Err(CoreError::NotFound(_))
        ));
        let plan = request_restore(dir.path(), "app-2026-09-08.db").unwrap();
        assert_eq!(plan.name, "app-2026-09-08.db");
        assert_eq!(
            pending_restore(dir.path()).as_deref(),
            Some("app-2026-09-08.db")
        );
        let applied = apply_pending_restore(dir.path(), &db).unwrap();
        assert_eq!(applied.as_deref(), Some("app-2026-09-08.db"));
        assert!(pending_restore(dir.path()).is_none(), "marker consumed");
        assert!(
            !dir.path().join("app.db-journal").exists(),
            "hot journal moved aside"
        );
        let replaced: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.contains("replaced-"))
            .collect();
        assert_eq!(replaced.len(), 2, "{replaced:?}");
        let conn = crate::db::open(&db).unwrap();
        let n: i64 = conn
            .query_row("SELECT count(*) FROM book", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1, "restored copy predates the second book");
        assert_eq!(apply_pending_restore(dir.path(), &db).unwrap(), None);
        // 损坏的快照被拒绝且标记仍被消费
        std::fs::write(snaps.join("app-2026-09-09.db"), b"not a database").unwrap();
        assert!(restore_plan(&snaps, "app-2026-09-09.db").is_err());
        assert!(request_restore(dir.path(), "app-2026-09-09.db").is_err());
        assert!(pending_restore(dir.path()).is_none());
    }
}
