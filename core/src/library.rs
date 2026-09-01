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
