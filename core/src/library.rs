use rusqlite::{Connection, Error, ErrorCode, OptionalExtension, Transaction, TransactionBehavior};

use crate::{CoreError, Result};

fn write_error(error: Error) -> CoreError {
    match error {
        Error::SqliteFailure(code, message) if code.code == ErrorCode::ConstraintViolation => {
            CoreError::Conflict(message.unwrap_or_else(|| "database constraint".into()))
        }
        other => other.into(),
    }
}

pub fn set_active_book(conn: &Connection, book_id: i64) -> Result<()> {
    let transaction = Transaction::new_unchecked(conn, TransactionBehavior::Immediate)?;
    let exists = transaction
        .query_row("SELECT 1 FROM book WHERE id=?1", [book_id], |row| {
            row.get::<_, i64>(0)
        })
        .optional()?;
    if exists.is_none() {
        return Err(CoreError::NotFound(format!("book {book_id}")));
    }
    // 无学习计划的书不能成为主攻书:否则全局将没有 active 计划,今日队列会静默停产(F4)
    let has_plan = transaction
        .query_row(
            "SELECT 1 FROM study_plan WHERE book_id=?1",
            [book_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()?;
    if has_plan.is_none() {
        return Err(CoreError::Conflict(format!(
            "book {book_id} has no study plan; set a plan before activating it"
        )));
    }
    // 已学完的书不能再成为主攻书(其到期复习照常汇入队列,M2 T8)
    let status: String =
        transaction.query_row("SELECT status FROM book WHERE id=?1", [book_id], |row| {
            row.get(0)
        })?;
    if status == "finished" {
        return Err(CoreError::Conflict(format!(
            "book {book_id} is finished; reviews continue but it cannot be the active book"
        )));
    }
    transaction
        .execute(
            "UPDATE book SET status='paused' WHERE status='active' AND id<>?1",
            [book_id],
        )
        .map_err(write_error)?;
    transaction
        .execute("UPDATE book SET status='active' WHERE id=?1", [book_id])
        .map_err(write_error)?;
    transaction
        .execute("UPDATE study_plan SET active=0 WHERE active<>0", [])
        .map_err(write_error)?;
    transaction
        .execute("UPDATE study_plan SET active=1 WHERE book_id=?1", [book_id])
        .map_err(write_error)?;
    transaction.commit().map_err(write_error)?;
    Ok(())
}

/// 标记一本书学完(M2 T8):status → finished、其计划 active=0(不再产新块;到期复习照常)。
/// 若它是主攻书,则此后全局无主攻书直至用户另选。幂等;不存在 → NotFound。
pub fn finish_book(conn: &Connection, book_id: i64) -> Result<()> {
    let transaction = Transaction::new_unchecked(conn, TransactionBehavior::Immediate)?;
    let exists = transaction
        .query_row("SELECT 1 FROM book WHERE id=?1", [book_id], |row| {
            row.get::<_, i64>(0)
        })
        .optional()?;
    if exists.is_none() {
        return Err(CoreError::NotFound(format!("book {book_id}")));
    }
    finish_book_in(&transaction, book_id)?;
    transaction.commit().map_err(write_error)?;
    Ok(())
}

/// `finish_book` 的事务内版本(M3 T1):供整书终评在自己的事务里调用(嵌套开事务会报错)。
pub fn finish_book_in(conn: &Connection, book_id: i64) -> Result<()> {
    conn.execute("UPDATE book SET status='finished' WHERE id=?1", [book_id])
        .map_err(write_error)?;
    conn.execute("UPDATE study_plan SET active=0 WHERE book_id=?1", [book_id])
        .map_err(write_error)?;
    Ok(())
}

/// `delete_book` 的结果:投影需要的 slug 与"删的是不是主攻书"(删后不自动选新主攻)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeletedBook {
    pub slug: String,
    pub was_active: bool,
}

/// 删除一本书(测试阶段补功能):单事务内删掉该书的全部学习数据,并入队 `remove_book` + `git_commit`
/// 投影(删 `memory/books/<slug>/` 与 INDEX 行)。v1 老表 `knowledge_block`/`study_plan` 对 `book`
/// 没有级联删除,须显式删;其余表靠外键级联。引用该书的**待处理**投影一并清掉,否则重放到缺失的书会
/// 卡住 main 通道。不存在 → NotFound。EPUB 文件与快照由壳层处理。
pub fn delete_book(conn: &Connection, book_id: i64) -> Result<DeletedBook> {
    let transaction = Transaction::new_unchecked(conn, TransactionBehavior::Immediate)?;
    let (slug, status): (String, String) = transaction
        .query_row(
            "SELECT slug,status FROM book WHERE id=?1",
            [book_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?
        .ok_or_else(|| CoreError::NotFound(format!("book {book_id}")))?;
    let pending: Vec<(i64, String)> = {
        let mut statement =
            transaction.prepare("SELECT id,payload FROM projection_outbox WHERE status<>'done'")?;
        let rows = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
        rows.collect::<std::result::Result<_, _>>()?
    };
    for (id, payload) in pending {
        if payload_refers_to(&payload, book_id, &slug) {
            transaction.execute("DELETE FROM projection_outbox WHERE id=?1", [id])?;
        }
    }
    transaction
        .execute("DELETE FROM daily_task WHERE book_id=?1", [book_id])
        .map_err(write_error)?;
    transaction
        .execute("DELETE FROM study_plan WHERE book_id=?1", [book_id])
        .map_err(write_error)?;
    transaction
        .execute("DELETE FROM knowledge_block WHERE book_id=?1", [book_id])
        .map_err(write_error)?;
    transaction
        .execute("DELETE FROM book WHERE id=?1", [book_id])
        .map_err(write_error)?;
    crate::projection::enqueue(
        &transaction,
        &format!("book:{book_id}:remove_book"),
        "remove_book",
        &serde_json::json!({ "slug": slug, "book_id": book_id }),
    )?;
    crate::projection::enqueue(
        &transaction,
        &format!("book:{book_id}:remove_book:git_commit"),
        "git_commit",
        &serde_json::json!({ "message": format!("remove: 删除书 {slug}") }),
    )?;
    transaction.commit().map_err(write_error)?;
    Ok(DeletedBook {
        slug,
        was_active: status == "active",
    })
}

fn payload_refers_to(payload: &str, book_id: i64, slug: &str) -> bool {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(payload) else {
        return false;
    };
    value.get("book_id").and_then(|v| v.as_i64()) == Some(book_id)
        || value.get("slug").and_then(|v| v.as_str()) == Some(slug)
}

#[cfg(test)]
mod tests {
    use crate::models::{insert_book, BookType};
    use crate::planning::{set_plan, StudyPlan};

    fn plan(book_id: i64) -> StudyPlan {
        StudyPlan {
            book_id,
            deadline: "2026-12-31".into(),
            daily_new_blocks: 1,
            daily_cap: 4,
            remind_time: "21:00".into(),
        }
    }

    #[test]
    fn finish_book_freezes_plan_and_blocks_reactivation() {
        let conn = crate::db::open_in_memory().unwrap();
        let first = insert_book(&conn, "甲", "a", BookType::Textbook, "first").unwrap();
        let second = insert_book(&conn, "乙", "b", BookType::Textbook, "second").unwrap();
        set_plan(&conn, &plan(first)).unwrap();
        set_plan(&conn, &plan(second)).unwrap();
        super::finish_book(&conn, first).unwrap();
        let (status, active): (String, i64) = conn
            .query_row(
                "SELECT b.status, p.active FROM book b JOIN study_plan p ON p.book_id=b.id WHERE b.id=?1",
                [first],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!((status.as_str(), active), ("finished", 0));
        let actives: i64 = conn
            .query_row("SELECT count(*) FROM book WHERE status='active'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(actives, 0, "no active book until the user picks another");
        assert!(matches!(
            super::set_active_book(&conn, first),
            Err(crate::CoreError::Conflict(_))
        ));
        super::set_active_book(&conn, second).unwrap();
        super::finish_book(&conn, first).unwrap(); // 幂等
        assert!(matches!(
            super::finish_book(&conn, 999),
            Err(crate::CoreError::NotFound(_))
        ));
    }

    #[test]
    fn delete_book_removes_all_rows_pending_projections_and_enqueues_removal() {
        let conn = crate::db::open_in_memory().unwrap();
        let first = insert_book(&conn, "甲", "a", BookType::Textbook, "first").unwrap();
        let second = insert_book(&conn, "乙", "b", BookType::Textbook, "second").unwrap();
        set_plan(&conn, &plan(first)).unwrap();
        let block =
            crate::models::insert_block(&conn, first, "模块", 1, "块", "block", &[]).unwrap();
        let other_block =
            crate::models::insert_block(&conn, second, "模块", 1, "块二", "block-2", &[]).unwrap();
        conn.execute(
            "INSERT INTO weak_point(block_id,title,created_at) VALUES(?1,'w','2026-09-01')",
            [block],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO review_schedule(block_id,stage,due_date,status) VALUES(?1,1,'2026-09-02','due')",
            [block],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO daily_task(date,book_id,block_id,kind,seq,status) VALUES('2026-09-01',?1,?2,'new',1,'pending')",
            [first, block],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO feynman_session(block_id,kind,started_at,state,version) VALUES(?1,'learn','2026-09-01T00:00:00Z','open',0)",
            [block],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO artifact(book_id,kind,block_id,content_md,created_at) VALUES(?1,'restatement',?2,'x','2026-09-01')",
            [first, block],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO spine_item(book_id,idx,href,title,text) VALUES(?1,0,'c.xhtml','c','t')",
            [first],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO reader_mark(book_id,kind,spine_href,cfi_start,text,color,note,created_at,updated_at) VALUES(?1,'bookmark','c.xhtml','epubcfi(/6/2!/4/2)','','','','2026-09-01','2026-09-01')",
            [first],
        )
        .unwrap();
        crate::projection::enqueue(
            &conn,
            "p:first",
            "sync_map",
            &serde_json::json!({"book_id": first}),
        )
        .unwrap();
        crate::projection::enqueue(
            &conn,
            "p:second",
            "sync_map",
            &serde_json::json!({"book_id": second}),
        )
        .unwrap();

        let deleted = super::delete_book(&conn, first).unwrap();
        assert_eq!(
            deleted,
            super::DeletedBook {
                slug: "first".into(),
                was_active: true
            }
        );
        let count = |sql: &str| -> i64 { conn.query_row(sql, [], |r| r.get(0)).unwrap() };
        assert_eq!(count("SELECT count(*) FROM book"), 1);
        assert_eq!(count("SELECT count(*) FROM knowledge_block"), 1);
        assert_eq!(count("SELECT count(*) FROM study_plan"), 0);
        assert_eq!(count("SELECT count(*) FROM weak_point"), 0);
        assert_eq!(count("SELECT count(*) FROM review_schedule"), 0);
        assert_eq!(count("SELECT count(*) FROM daily_task"), 0);
        assert_eq!(count("SELECT count(*) FROM feynman_session"), 0);
        assert_eq!(count("SELECT count(*) FROM artifact"), 0);
        assert_eq!(count("SELECT count(*) FROM spine_item"), 0);
        assert_eq!(count("SELECT count(*) FROM reader_mark"), 0);
        let remaining: i64 = conn
            .query_row("SELECT id FROM knowledge_block", [], |r| r.get(0))
            .unwrap();
        assert_eq!(remaining, other_block);
        assert_eq!(
            count("SELECT count(*) FROM book WHERE status='active'"),
            0,
            "删掉主攻书后不自动选新主攻"
        );
        let ops: Vec<(String, String, String)> = {
            let mut st = conn
                .prepare("SELECT op_id,kind,status FROM projection_outbox ORDER BY id")
                .unwrap();
            st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
                .unwrap()
                .collect::<std::result::Result<_, _>>()
                .unwrap()
        };
        assert_eq!(
            ops,
            vec![
                ("p:second".into(), "sync_map".into(), "pending".into()),
                (
                    "book:1:remove_book".into(),
                    "remove_book".into(),
                    "pending".into()
                ),
                (
                    "book:1:remove_book:git_commit".into(),
                    "git_commit".into(),
                    "pending".into()
                ),
            ]
        );
        assert!(matches!(
            super::delete_book(&conn, first),
            Err(crate::CoreError::NotFound(_))
        ));
    }
}
