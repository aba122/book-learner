//! 阅读器标记(M3 T4):高亮 / 书签 / 阅读位置,按书存 CFI(schema v8 `reader_mark`)。
//!
//! - `highlight`:区间 CFI(`cfi_start`..`cfi_end`)+ 选中文本 + 颜色 + 可选批注;
//! - `bookmark`:点 CFI(`cfi_end` NULL);同书同点幂等;
//! - `position`:每书一行(upsert),重开阅读器回到上次位置。
use rusqlite::{Connection, OptionalExtension};

use crate::{CoreError, Result};

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ReaderMark {
    pub id: i64,
    pub book_id: i64,
    /// highlight | bookmark | position
    pub kind: String,
    pub spine_href: String,
    pub cfi_start: String,
    pub cfi_end: Option<String>,
    pub text: String,
    pub color: String,
    pub note: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewMark {
    pub kind: String,
    pub spine_href: String,
    pub cfi_start: String,
    pub cfi_end: Option<String>,
    pub text: String,
    pub color: String,
    pub note: String,
}

pub const KINDS: [&str; 3] = ["highlight", "bookmark", "position"];
pub const COLORS: [&str; 4] = ["yellow", "green", "blue", "pink"];
const MAX_TEXT: usize = 4000;
const MAX_NOTE: usize = 4000;

fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

fn validate(mark: &NewMark) -> Result<()> {
    if !KINDS.contains(&mark.kind.as_str()) {
        return Err(CoreError::InvalidInput(format!(
            "unknown mark kind {:?}",
            mark.kind
        )));
    }
    if mark.spine_href.trim().is_empty() || mark.cfi_start.trim().is_empty() {
        return Err(CoreError::InvalidInput(
            "mark needs spine_href and cfi_start".into(),
        ));
    }
    if !mark.cfi_start.starts_with("epubcfi(") {
        return Err(CoreError::InvalidInput(format!(
            "bad cfi {:?}",
            mark.cfi_start
        )));
    }
    if let Some(end) = &mark.cfi_end {
        if !end.starts_with("epubcfi(") {
            return Err(CoreError::InvalidInput(format!("bad cfi {end:?}")));
        }
    }
    if mark.kind == "highlight" {
        if mark.cfi_end.is_none() {
            return Err(CoreError::InvalidInput("highlight needs cfi_end".into()));
        }
        if !mark.color.is_empty() && !COLORS.contains(&mark.color.as_str()) {
            return Err(CoreError::InvalidInput(format!(
                "unknown color {:?}",
                mark.color
            )));
        }
    }
    if mark.text.len() > MAX_TEXT || mark.note.len() > MAX_NOTE {
        return Err(CoreError::InvalidInput("mark text/note too long".into()));
    }
    Ok(())
}

fn book_exists(conn: &Connection, book_id: i64) -> Result<()> {
    conn.query_row("SELECT 1 FROM book WHERE id=?1", [book_id], |r| {
        r.get::<_, i64>(0)
    })
    .optional()?
    .map(|_| ())
    .ok_or_else(|| CoreError::NotFound(format!("book {book_id}")))
}

/// 新增标记;书签同书同点返回既有行;阅读位置走 `set_position`。
pub fn add(conn: &Connection, book_id: i64, mark: &NewMark) -> Result<ReaderMark> {
    validate(mark)?;
    book_exists(conn, book_id)?;
    if mark.kind == "position" {
        return set_position(conn, book_id, &mark.spine_href, &mark.cfi_start);
    }
    if mark.kind == "bookmark" {
        if let Some(existing) = conn
            .query_row(
                "SELECT id FROM reader_mark WHERE book_id=?1 AND kind='bookmark' AND spine_href=?2 AND cfi_start=?3",
                rusqlite::params![book_id, mark.spine_href, mark.cfi_start],
                |r| r.get::<_, i64>(0),
            )
            .optional()?
        {
            return get(conn, existing);
        }
    }
    let ts = now();
    let color = if mark.kind == "highlight" && mark.color.is_empty() {
        COLORS[0].to_string()
    } else {
        mark.color.clone()
    };
    conn.execute(
        "INSERT INTO reader_mark(book_id,kind,spine_href,cfi_start,cfi_end,text,color,note,created_at,updated_at) \
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?9)",
        rusqlite::params![
            book_id,
            mark.kind,
            mark.spine_href,
            mark.cfi_start,
            mark.cfi_end,
            mark.text,
            color,
            mark.note,
            ts
        ],
    )?;
    get(conn, conn.last_insert_rowid())
}

/// 每书一行的阅读位置(upsert)。
pub fn set_position(
    conn: &Connection,
    book_id: i64,
    spine_href: &str,
    cfi: &str,
) -> Result<ReaderMark> {
    if spine_href.trim().is_empty() || !cfi.starts_with("epubcfi(") {
        return Err(CoreError::InvalidInput(format!(
            "bad position {spine_href:?} {cfi:?}"
        )));
    }
    book_exists(conn, book_id)?;
    let ts = now();
    let existing: Option<i64> = conn
        .query_row(
            "SELECT id FROM reader_mark WHERE book_id=?1 AND kind='position'",
            [book_id],
            |r| r.get(0),
        )
        .optional()?;
    let id = match existing {
        Some(id) => {
            conn.execute(
                "UPDATE reader_mark SET spine_href=?2, cfi_start=?3, updated_at=?4 WHERE id=?1",
                rusqlite::params![id, spine_href, cfi, ts],
            )?;
            id
        }
        None => {
            conn.execute(
                "INSERT INTO reader_mark(book_id,kind,spine_href,cfi_start,cfi_end,text,color,note,created_at,updated_at) \
                 VALUES(?1,'position',?2,?3,NULL,'','','',?4,?4)",
                rusqlite::params![book_id, spine_href, cfi, ts],
            )?;
            conn.last_insert_rowid()
        }
    };
    get(conn, id)
}

pub fn update(
    conn: &Connection,
    id: i64,
    note: Option<&str>,
    color: Option<&str>,
) -> Result<ReaderMark> {
    let current = get(conn, id)?;
    let note = note.unwrap_or(&current.note);
    let color = color.unwrap_or(&current.color);
    if note.len() > MAX_NOTE {
        return Err(CoreError::InvalidInput("note too long".into()));
    }
    if current.kind == "highlight" && !COLORS.contains(&color) {
        return Err(CoreError::InvalidInput(format!("unknown color {color:?}")));
    }
    conn.execute(
        "UPDATE reader_mark SET note=?2, color=?3, updated_at=?4 WHERE id=?1",
        rusqlite::params![id, note, color, now()],
    )?;
    get(conn, id)
}

pub fn remove(conn: &Connection, id: i64) -> Result<()> {
    let changed = conn.execute("DELETE FROM reader_mark WHERE id=?1", [id])?;
    if changed == 0 {
        return Err(CoreError::NotFound(format!("mark {id}")));
    }
    Ok(())
}

pub fn get(conn: &Connection, id: i64) -> Result<ReaderMark> {
    conn.query_row(
        "SELECT id,book_id,kind,spine_href,cfi_start,cfi_end,text,color,note,created_at,updated_at FROM reader_mark WHERE id=?1",
        [id],
        row,
    )
    .optional()?
    .ok_or_else(|| CoreError::NotFound(format!("mark {id}")))
}

fn row(r: &rusqlite::Row<'_>) -> rusqlite::Result<ReaderMark> {
    Ok(ReaderMark {
        id: r.get(0)?,
        book_id: r.get(1)?,
        kind: r.get(2)?,
        spine_href: r.get(3)?,
        cfi_start: r.get(4)?,
        cfi_end: r.get(5)?,
        text: r.get(6)?,
        color: r.get(7)?,
        note: r.get(8)?,
        created_at: r.get(9)?,
        updated_at: r.get(10)?,
    })
}

/// 一本书的全部标记(含 position),按创建时间。
pub fn list(conn: &Connection, book_id: i64) -> Result<Vec<ReaderMark>> {
    book_exists(conn, book_id)?;
    let mut st = conn.prepare(
        "SELECT id,book_id,kind,spine_href,cfi_start,cfi_end,text,color,note,created_at,updated_at \
         FROM reader_mark WHERE book_id=?1 ORDER BY created_at, id",
    )?;
    let rows = st.query_map([book_id], row)?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seed(conn: &Connection) -> i64 {
        crate::models::insert_book(conn, "书", "", crate::models::BookType::Textbook, "bk").unwrap()
    }
    fn hl(text: &str) -> NewMark {
        NewMark {
            kind: "highlight".into(),
            spine_href: "chap1.xhtml".into(),
            cfi_start: "epubcfi(/6/4!/4/2/1:0)".into(),
            cfi_end: Some("epubcfi(/6/4!/4/2/1:12)".into()),
            text: text.into(),
            color: "".into(),
            note: "".into(),
        }
    }

    #[test]
    fn highlight_bookmark_and_position_round_trip() {
        let conn = crate::db::open_in_memory().unwrap();
        let book = seed(&conn);
        let h = add(&conn, book, &hl("道可道")).unwrap();
        assert_eq!(
            (h.kind.as_str(), h.color.as_str(), h.text.as_str()),
            ("highlight", "yellow", "道可道")
        );
        let updated = update(&conn, h.id, Some("重要"), Some("green")).unwrap();
        assert_eq!(
            (updated.note.as_str(), updated.color.as_str()),
            ("重要", "green")
        );
        assert!(matches!(
            update(&conn, h.id, None, Some("red")),
            Err(CoreError::InvalidInput(_))
        ));
        let bm = NewMark {
            kind: "bookmark".into(),
            cfi_end: None,
            text: "第一章".into(),
            ..hl("")
        };
        let b1 = add(&conn, book, &bm).unwrap();
        let b2 = add(&conn, book, &bm).unwrap();
        assert_eq!(b1.id, b2.id, "书签同点幂等");
        let p1 = set_position(&conn, book, "chap1.xhtml", "epubcfi(/6/4!/4/2/1:0)").unwrap();
        let p2 = set_position(&conn, book, "chap2.xhtml", "epubcfi(/6/6!/4/2/1:0)").unwrap();
        assert_eq!(p1.id, p2.id);
        assert_eq!(p2.spine_href, "chap2.xhtml");
        let all = list(&conn, book).unwrap();
        assert_eq!(
            all.iter().map(|m| m.kind.as_str()).collect::<Vec<_>>(),
            vec!["highlight", "bookmark", "position"]
        );
        remove(&conn, h.id).unwrap();
        assert!(matches!(remove(&conn, h.id), Err(CoreError::NotFound(_))));
        assert_eq!(list(&conn, book).unwrap().len(), 2);
        assert!(matches!(list(&conn, 999), Err(CoreError::NotFound(_))));
    }

    #[test]
    fn validation_rejects_bad_kinds_cfis_and_missing_end() {
        let conn = crate::db::open_in_memory().unwrap();
        let book = seed(&conn);
        assert!(matches!(
            add(
                &conn,
                book,
                &NewMark {
                    kind: "note".into(),
                    ..hl("x")
                }
            ),
            Err(CoreError::InvalidInput(_))
        ));
        assert!(matches!(
            add(
                &conn,
                book,
                &NewMark {
                    cfi_start: "1/2".into(),
                    ..hl("x")
                }
            ),
            Err(CoreError::InvalidInput(_))
        ));
        assert!(matches!(
            add(
                &conn,
                book,
                &NewMark {
                    cfi_end: None,
                    ..hl("x")
                }
            ),
            Err(CoreError::InvalidInput(_))
        ));
        assert!(matches!(
            add(
                &conn,
                book,
                &NewMark {
                    color: "red".into(),
                    ..hl("x")
                }
            ),
            Err(CoreError::InvalidInput(_))
        ));
        assert!(matches!(
            add(&conn, 999, &hl("x")),
            Err(CoreError::NotFound(_))
        ));
        // 书删除级联
        add(&conn, book, &hl("x")).unwrap();
        conn.execute("DELETE FROM book WHERE id=?1", [book])
            .unwrap();
        let n: i64 = conn
            .query_row("SELECT count(*) FROM reader_mark", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0);
    }
}
