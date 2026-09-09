use crate::Result;
use rusqlite::Connection;

fn corrupt_data(message: impl Into<String>) -> crate::CoreError {
    crate::CoreError::Other(format!("corrupt database data: {}", message.into()))
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum BookType {
    Textbook,
    Methodology,
    Humanities,
}

impl BookType {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Textbook => "textbook",
            Self::Methodology => "methodology",
            Self::Humanities => "humanities",
        }
    }
    pub fn from_db_str(s: &str) -> Result<Self> {
        match s {
            "textbook" => Ok(Self::Textbook),
            "methodology" => Ok(Self::Methodology),
            "humanities" => Ok(Self::Humanities),
            _ => Err(corrupt_data(format!("invalid book type: {s}"))),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum BookStatus {
    Active,
    Paused,
    Finished,
}

impl BookStatus {
    pub(crate) fn from_db_str(s: &str) -> Result<Self> {
        match s {
            "active" => Ok(Self::Active),
            "paused" => Ok(Self::Paused),
            "finished" => Ok(Self::Finished),
            _ => Err(corrupt_data(format!("invalid book status: {s}"))),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Book {
    pub id: i64,
    pub title: String,
    pub author: String,
    pub book_type: BookType,
    pub slug: String,
    pub status: BookStatus,
    /// 地图乐观并发修订号:草图落库置 1,每次 confirm_map +1(0 = 尚无地图)
    pub map_revision: i64,
    /// 导入进度:ready(旧数据/草图后)| staged(已落盘未抽取)| extracted(已存 spine)| mapped(地图完成)
    pub import_state: String,
}

#[derive(Debug, Clone)]
pub struct KnowledgeBlock {
    pub id: i64,
    pub book_id: i64,
    pub module_name: String,
    pub seq: i64,
    pub title: String,
    pub slug: String,
    pub prereq_ids: Vec<i64>,
    pub status: String,
    pub scores: Option<crate::eval::Scores>,
    pub passed_at: Option<String>,
    /// 地图编辑"跳过"标记(不物理删除;队列与落后重排都排除它)
    pub skipped: bool,
}

pub fn list_books(conn: &Connection) -> Result<Vec<Book>> {
    let mut statement = conn.prepare(
        "SELECT id,title,author,type,slug,status,map_revision,import_state FROM book ORDER BY id",
    )?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, String>(4)?,
            row.get::<_, String>(5)?,
            row.get::<_, i64>(6)?,
            row.get::<_, String>(7)?,
        ))
    })?;

    rows.map(|row| {
        let (id, title, author, book_type, slug, status, map_revision, import_state) = row?;
        let status = BookStatus::from_db_str(&status)?;
        Ok(Book {
            id,
            title,
            author,
            book_type: BookType::from_db_str(&book_type)?,
            slug,
            status,
            map_revision,
            import_state,
        })
    })
    .collect()
}

pub fn insert_book(
    conn: &Connection,
    title: &str,
    author: &str,
    ty: BookType,
    slug: &str,
) -> Result<i64> {
    // 单主攻书:已有 active 书时新书以 paused 入库(唯一索引 book_single_active 兜底)
    let has_active: i64 =
        conn.query_row("SELECT count(*) FROM book WHERE status='active'", [], |r| {
            r.get(0)
        })?;
    let status = if has_active > 0 { "paused" } else { "active" };
    conn.execute(
        "INSERT INTO book(title,author,type,slug,status) VALUES(?1,?2,?3,?4,?5)",
        rusqlite::params![title, author, ty.as_str(), slug, status],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn insert_block(
    conn: &Connection,
    book_id: i64,
    module: &str,
    seq: i64,
    title: &str,
    slug: &str,
    prereqs: &[i64],
) -> Result<i64> {
    conn.execute(
        "INSERT INTO knowledge_block(book_id,module_name,seq,title,slug,prereq_ids) VALUES(?1,?2,?3,?4,?5,?6)",
        rusqlite::params![book_id, module, seq, title, slug, serde_json::to_string(prereqs).unwrap()])?;
    Ok(conn.last_insert_rowid())
}

const BLOCK_COLS: &str =
    "id,book_id,module_name,seq,title,slug,prereq_ids,status,scores_json,passed_at,skipped";

type RawBlock = (
    i64,
    i64,
    String,
    i64,
    String,
    String,
    String,
    String,
    Option<String>,
    Option<String>,
    i64,
);

fn row_to_raw_block(r: &rusqlite::Row) -> rusqlite::Result<RawBlock> {
    Ok((
        r.get(0)?,
        r.get(1)?,
        r.get(2)?,
        r.get(3)?,
        r.get(4)?,
        r.get(5)?,
        r.get(6)?,
        r.get(7)?,
        r.get(8)?,
        r.get(9)?,
        r.get(10)?,
    ))
}

fn parse_block(raw: RawBlock) -> Result<KnowledgeBlock> {
    let (
        id,
        book_id,
        module_name,
        seq,
        title,
        slug,
        prereq_raw,
        status,
        scores_raw,
        passed_at,
        skipped,
    ) = raw;
    if !matches!(
        status.as_str(),
        "unlearned" | "learning" | "passed" | "weak" | "consolidated"
    ) {
        return Err(corrupt_data(format!(
            "invalid knowledge block status: {status}"
        )));
    }
    let prereq_ids = serde_json::from_str(&prereq_raw)
        .map_err(|error| corrupt_data(format!("invalid prerequisite ids JSON: {error}")))?;
    let scores = scores_raw
        .map(|json| {
            let scores: crate::eval::Scores = serde_json::from_str(&json)
                .map_err(|error| corrupt_data(format!("invalid scores JSON: {error}")))?;
            if [scores.accuracy, scores.completeness, scores.clarity]
                .iter()
                .any(|score| !(1..=5).contains(score))
            {
                return Err(corrupt_data(
                    "knowledge block scores must be between 1 and 5",
                ));
            }
            Ok::<_, crate::CoreError>(scores)
        })
        .transpose()?;
    Ok(KnowledgeBlock {
        id,
        book_id,
        module_name,
        seq,
        title,
        slug,
        prereq_ids,
        status,
        scores,
        passed_at,
        skipped: skipped != 0,
    })
}

pub fn get_block(conn: &Connection, block_id: i64) -> Result<KnowledgeBlock> {
    let raw = conn
        .query_row(
            &format!("SELECT {BLOCK_COLS} FROM knowledge_block WHERE id=?1"),
            [block_id],
            row_to_raw_block,
        )
        .map_err(|error| match error {
            rusqlite::Error::QueryReturnedNoRows => {
                crate::CoreError::NotFound(format!("knowledge block {block_id}"))
            }
            other => other.into(),
        })?;
    parse_block(raw)
}

pub fn list_blocks(conn: &Connection, book_id: i64) -> Result<Vec<KnowledgeBlock>> {
    let mut st = conn.prepare(&format!(
        "SELECT {BLOCK_COLS} FROM knowledge_block WHERE book_id=?1 ORDER BY seq"
    ))?;
    let rows = st.query_map([book_id], row_to_raw_block)?;
    rows.map(|row| parse_block(row?)).collect()
}

/// 下一批待学新块:`unlearned` 与 `learning`(已开始但未通过,重学后仍需再入队)纯按 seq 交错。
pub fn next_new_blocks(conn: &Connection, book_id: i64, n: usize) -> Result<Vec<KnowledgeBlock>> {
    let mut st = conn.prepare(&format!(
        "SELECT {BLOCK_COLS} FROM knowledge_block \
         WHERE book_id=?1 AND status IN ('unlearned','learning') AND skipped=0 ORDER BY seq LIMIT ?2"
    ))?;
    let rows = st.query_map(rusqlite::params![book_id, n as i64], row_to_raw_block)?;
    rows.map(|row| parse_block(row?)).collect()
}

pub fn get_book_slug_type(conn: &Connection, book_id: i64) -> Result<(String, BookType)> {
    let (slug, ty): (String, String) =
        conn.query_row("SELECT slug,type FROM book WHERE id=?1", [book_id], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })?;
    Ok((slug, BookType::from_db_str(&ty)?))
}

#[cfg(test)]
mod tests {
    #[test]
    fn insert_and_fetch_book_with_blocks() {
        let conn = crate::db::open_in_memory().unwrap();
        let b = super::insert_book(
            &conn,
            "微观经济学",
            "曼昆",
            super::BookType::Textbook,
            "microecon",
        )
        .unwrap();
        super::insert_block(&conn, b, "供给与需求", 1, "供需弹性", "elasticity", &[]).unwrap();
        super::insert_block(&conn, b, "供给与需求", 2, "消费者剩余", "surplus", &[1]).unwrap();
        let blocks = super::list_blocks(&conn, b).unwrap();
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0].title, "供需弹性");
        assert_eq!(blocks[1].prereq_ids, vec![1]);
        let next = super::next_new_blocks(&conn, b, 1).unwrap();
        assert_eq!(next[0].seq, 1);
        let (slug, ty) = super::get_book_slug_type(&conn, b).unwrap();
        assert_eq!(slug, "microecon");
        assert_eq!(ty, super::BookType::Textbook);
    }

    #[test]
    fn next_new_blocks_includes_learning_blocks() {
        let conn = crate::db::open_in_memory().unwrap();
        let b = super::insert_book(&conn, "书", "", super::BookType::Textbook, "bk").unwrap();
        for i in 1..=3 {
            super::insert_block(&conn, b, "m", i, &format!("块{i}"), &format!("b{i}"), &[])
                .unwrap();
        }
        conn.execute(
            "UPDATE knowledge_block SET status='learning' WHERE seq=2",
            [],
        )
        .unwrap();
        let next: Vec<i64> = super::next_new_blocks(&conn, b, 2)
            .unwrap()
            .iter()
            .map(|k| k.seq)
            .collect();
        assert_eq!(next, vec![1, 2], "learning 与 unlearned 纯按 seq 交错");
        conn.execute("UPDATE knowledge_block SET status='passed' WHERE seq=1", [])
            .unwrap();
        let next: Vec<i64> = super::next_new_blocks(&conn, b, 2)
            .unwrap()
            .iter()
            .map(|k| k.seq)
            .collect();
        assert_eq!(next, vec![2, 3]);
    }

    #[test]
    fn list_blocks_reports_skipped_flag() {
        let conn = crate::db::open_in_memory().unwrap();
        let b = super::insert_book(&conn, "书", "", super::BookType::Textbook, "bk").unwrap();
        super::insert_block(&conn, b, "m", 1, "块1", "b1", &[]).unwrap();
        super::insert_block(&conn, b, "m", 2, "块2", "b2", &[]).unwrap();
        conn.execute("UPDATE knowledge_block SET skipped=1 WHERE seq=2", [])
            .unwrap();
        let blocks = super::list_blocks(&conn, b).unwrap();
        assert_eq!(
            blocks.iter().map(|k| k.skipped).collect::<Vec<_>>(),
            vec![false, true]
        );
        assert!(super::get_block(&conn, blocks[1].id).unwrap().skipped);
    }
}
