use rusqlite::Connection;
use crate::Result;

#[derive(Debug, Clone)]
pub struct DailyTask {
    pub id: i64,
    pub book_id: i64,
    pub block_id: i64,
    pub kind: String,
    pub seq: i64,
    pub status: String,
    pub est_minutes: i64,
    pub ref_id: Option<i64>,
}

const WEAK_RETEST_DAILY_LIMIT: i64 = 3; // PRODUCT_SPEC §5

fn list_daily(conn: &Connection, date: &str) -> Result<Vec<DailyTask>> {
    let mut st = conn.prepare(
        "SELECT id,book_id,block_id,kind,seq,status,est_minutes,ref_id \
         FROM daily_task WHERE date=?1 ORDER BY seq")?;
    let rows = st.query_map([date], |r| Ok(DailyTask {
        id: r.get(0)?, book_id: r.get(1)?, block_id: r.get(2)?, kind: r.get(3)?,
        seq: r.get(4)?, status: r.get(5)?, est_minutes: r.get(6)?, ref_id: r.get(7)?,
    }))?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// 生成某日队列(幂等):薄弱点重考(≤3)→ 到期复习 → 新块配额。PRODUCT_SPEC §5。
pub fn generate_daily(conn: &Connection, date: &str) -> Result<Vec<DailyTask>> {
    let existing = list_daily(conn, date)?;
    if !existing.is_empty() { return Ok(existing); }

    let tx = conn.unchecked_transaction()?;
    let mut seq = 0i64;
    let mut insert = |book_id: i64, block_id: i64, kind: &str, est: i64, ref_id: Option<i64>|
        -> Result<()> {
        seq += 1;
        tx.execute(
            "INSERT INTO daily_task(date,book_id,block_id,kind,seq,est_minutes,ref_id) \
             VALUES(?1,?2,?3,?4,?5,?6,?7)",
            rusqlite::params![date, book_id, block_id, kind, seq, est, ref_id])?;
        Ok(())
    };

    // 1) 薄弱点重考(按 created_at,上限 3)
    {
        let mut st = tx.prepare(
            "SELECT w.id, w.block_id, kb.book_id FROM weak_point w \
             JOIN knowledge_block kb ON kb.id = w.block_id \
             WHERE w.status='open' ORDER BY w.created_at LIMIT ?1")?;
        let rows: Vec<(i64, i64, i64)> = st.query_map([WEAK_RETEST_DAILY_LIMIT],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
            .collect::<rusqlite::Result<_>>()?;
        for (wid, block_id, book_id) in rows { insert(book_id, block_id, "weak_retest", 10, Some(wid))?; }
    }
    // 2) 到期间隔复习
    {
        let mut st = tx.prepare(
            "SELECT rs.id, rs.block_id, kb.book_id FROM review_schedule rs \
             JOIN knowledge_block kb ON kb.id = rs.block_id \
             WHERE rs.status='due' AND rs.due_date<=?1 ORDER BY rs.due_date")?;
        let rows: Vec<(i64, i64, i64)> = st.query_map([date],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
            .collect::<rusqlite::Result<_>>()?;
        for (rid, block_id, book_id) in rows { insert(book_id, block_id, "review", 5, Some(rid))?; }
    }
    // 3) 新块(活跃计划配额)
    {
        let plan: Option<(i64, i64)> = tx.query_row(
            "SELECT book_id, daily_new_blocks FROM study_plan WHERE active=1 LIMIT 1",
            [], |r| Ok((r.get(0)?, r.get(1)?))).map(Some).or_else(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => Ok(None), e => Err(e) })?;
        if let Some((book_id, quota)) = plan {
            for blk in crate::models::next_new_blocks(&tx, book_id, quota as usize)? {
                insert(book_id, blk.id, "new", 30, None)?;
            }
        }
    }
    drop(insert);
    tx.commit()?;
    list_daily(conn, date)
}

#[cfg(test)]
mod tests {
    fn setup() -> (rusqlite::Connection, i64) {
        let conn = crate::db::open_in_memory().unwrap();
        let b = crate::models::insert_book(&conn, "书", "", crate::models::BookType::Textbook, "bk").unwrap();
        for i in 1..=6 {
            crate::models::insert_block(&conn, b, "m", i, &format!("块{i}"), &format!("b{i}"), &[]).unwrap();
        }
        conn.execute("INSERT INTO study_plan(book_id,deadline,daily_new_blocks) VALUES(?1,'2026-09-30',2)", [b]).unwrap();
        (conn, b)
    }

    #[test]
    fn daily_queue_orders_weak_then_review_then_new() {
        let (conn, b) = setup();
        for i in 0..4 {
            conn.execute("INSERT INTO weak_point(block_id,title,created_at) VALUES(1,?1,?2)",
                rusqlite::params![format!("wp{i}"), format!("2026-08-2{i}")]).unwrap();
        }
        conn.execute("INSERT INTO review_schedule(block_id,stage,due_date) VALUES(2,1,'2026-08-30')", []).unwrap();
        let q = super::generate_daily(&conn, "2026-08-30").unwrap();
        let kinds: Vec<_> = q.iter().map(|t| t.kind.clone()).collect();
        assert_eq!(kinds, ["weak_retest","weak_retest","weak_retest","review","new","new"]);
        let _ = b;
    }
    #[test]
    fn generate_daily_is_idempotent() {
        let (conn, _) = setup();
        assert_eq!(super::generate_daily(&conn, "2026-08-30").unwrap().len(),
                   super::generate_daily(&conn, "2026-08-30").unwrap().len());
        let n: i64 = conn.query_row("SELECT count(*) FROM daily_task WHERE date='2026-08-30'", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 2);
    }
}
