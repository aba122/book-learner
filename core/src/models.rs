use rusqlite::Connection;
use crate::Result;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum BookType { Textbook, Methodology, Humanities }

impl BookType {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Textbook => "textbook",
            Self::Methodology => "methodology",
            Self::Humanities => "humanities",
        }
    }
    pub fn from_str(s: &str) -> Self {
        match s {
            "methodology" => Self::Methodology,
            "humanities" => Self::Humanities,
            _ => Self::Textbook,
        }
    }
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
    pub scores_json: Option<String>,
    pub passed_at: Option<String>,
}

pub fn insert_book(conn: &Connection, title: &str, author: &str, ty: BookType, slug: &str) -> Result<i64> {
    conn.execute("INSERT INTO book(title,author,type,slug) VALUES(?1,?2,?3,?4)",
        rusqlite::params![title, author, ty.as_str(), slug])?;
    Ok(conn.last_insert_rowid())
}

pub fn insert_block(conn: &Connection, book_id: i64, module: &str, seq: i64,
                    title: &str, slug: &str, prereqs: &[i64]) -> Result<i64> {
    conn.execute(
        "INSERT INTO knowledge_block(book_id,module_name,seq,title,slug,prereq_ids) VALUES(?1,?2,?3,?4,?5,?6)",
        rusqlite::params![book_id, module, seq, title, slug, serde_json::to_string(prereqs).unwrap()])?;
    Ok(conn.last_insert_rowid())
}

const BLOCK_COLS: &str = "id,book_id,module_name,seq,title,slug,prereq_ids,status,scores_json,passed_at";

fn row_to_block(r: &rusqlite::Row) -> rusqlite::Result<KnowledgeBlock> {
    let prereq_raw: String = r.get(6)?;
    Ok(KnowledgeBlock {
        id: r.get(0)?, book_id: r.get(1)?, module_name: r.get(2)?, seq: r.get(3)?,
        title: r.get(4)?, slug: r.get(5)?,
        prereq_ids: serde_json::from_str(&prereq_raw).unwrap_or_default(),
        status: r.get(7)?, scores_json: r.get(8)?, passed_at: r.get(9)?,
    })
}

pub fn list_blocks(conn: &Connection, book_id: i64) -> Result<Vec<KnowledgeBlock>> {
    let mut st = conn.prepare(&format!(
        "SELECT {BLOCK_COLS} FROM knowledge_block WHERE book_id=?1 ORDER BY seq"))?;
    let rows = st.query_map([book_id], row_to_block)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn next_new_blocks(conn: &Connection, book_id: i64, n: usize) -> Result<Vec<KnowledgeBlock>> {
    let mut st = conn.prepare(&format!(
        "SELECT {BLOCK_COLS} FROM knowledge_block \
         WHERE book_id=?1 AND status='unlearned' AND skipped=0 ORDER BY seq LIMIT ?2"))?;
    let rows = st.query_map(rusqlite::params![book_id, n as i64], row_to_block)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn get_book_slug_type(conn: &Connection, book_id: i64) -> Result<(String, BookType)> {
    let (slug, ty): (String, String) = conn.query_row(
        "SELECT slug,type FROM book WHERE id=?1", [book_id],
        |r| Ok((r.get(0)?, r.get(1)?)))?;
    Ok((slug, BookType::from_str(&ty)))
}

#[cfg(test)]
mod tests {
    #[test]
    fn insert_and_fetch_book_with_blocks() {
        let conn = crate::db::open_in_memory().unwrap();
        let b = super::insert_book(&conn, "微观经济学", "曼昆", super::BookType::Textbook, "microecon").unwrap();
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
}
