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
}
