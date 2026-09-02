use chrono::{NaiveDate, NaiveTime};
use rusqlite::{Connection, Error, ErrorCode, OptionalExtension, Transaction, TransactionBehavior};

use crate::{CoreError, Result};

#[derive(Debug, Clone, PartialEq)]
pub struct StudyPlan {
    pub book_id: i64,
    pub deadline: String,
    pub daily_new_blocks: i64,
    pub daily_cap: i64,
    pub remind_time: String,
}

fn write_error(error: Error) -> CoreError {
    match error {
        Error::SqliteFailure(code, message) if code.code == ErrorCode::ConstraintViolation => {
            CoreError::Conflict(message.unwrap_or_else(|| "database constraint".into()))
        }
        other => other.into(),
    }
}

fn validate_time(value: &str) -> Result<()> {
    let bytes = value.as_bytes();
    let has_exact_shape = bytes.len() == 5
        && bytes.get(2) == Some(&b':')
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| index == 2 || byte.is_ascii_digit());
    if !has_exact_shape || NaiveTime::parse_from_str(value, "%H:%M").is_err() {
        return Err(CoreError::InvalidInput(format!(
            "remind time must use HH:mm: {value}"
        )));
    }
    Ok(())
}

fn validate_date(value: &str, field: &str) -> Result<()> {
    let date_bytes = value.as_bytes();
    let has_exact_date_shape = date_bytes.len() == 10
        && date_bytes.get(4) == Some(&b'-')
        && date_bytes.get(7) == Some(&b'-')
        && date_bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| index == 4 || index == 7 || byte.is_ascii_digit());
    if !has_exact_date_shape {
        return Err(CoreError::InvalidInput(format!(
            "{field} must be a valid YYYY-MM-DD date: {value}"
        )));
    }
    NaiveDate::parse_from_str(value, "%Y-%m-%d").map_err(|_| {
        CoreError::InvalidInput(format!("{field} must be a valid YYYY-MM-DD date: {value}"))
    })?;
    Ok(())
}

fn validate_plan(plan: &StudyPlan) -> Result<()> {
    validate_date(&plan.deadline, "deadline")?;
    if plan.daily_new_blocks <= 0 {
        return Err(CoreError::InvalidInput(
            "daily new blocks must be positive".into(),
        ));
    }
    if plan.daily_cap <= 0 {
        return Err(CoreError::InvalidInput("daily cap must be positive".into()));
    }
    validate_time(&plan.remind_time)
}

pub fn set_plan(conn: &Connection, plan: &StudyPlan) -> Result<()> {
    validate_plan(plan)?;
    let transaction = Transaction::new_unchecked(conn, TransactionBehavior::Immediate)?;
    let status = transaction
        .query_row(
            "SELECT status FROM book WHERE id=?1",
            [plan.book_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    let status = status.ok_or_else(|| CoreError::NotFound(format!("book {}", plan.book_id)))?;
    let active = matches!(
        crate::models::BookStatus::from_db_str(&status)?,
        crate::models::BookStatus::Active
    );
    if active {
        transaction
            .execute("UPDATE study_plan SET active=0 WHERE active<>0", [])
            .map_err(write_error)?;
    }
    transaction
        .execute(
            "INSERT INTO study_plan(book_id,deadline,daily_new_blocks,daily_cap,remind_time,active)
             VALUES(?1,?2,?3,?4,?5,?6)
             ON CONFLICT(book_id) DO UPDATE SET
               deadline=excluded.deadline,
               daily_new_blocks=excluded.daily_new_blocks,
               daily_cap=excluded.daily_cap,
               remind_time=excluded.remind_time,
               active=excluded.active",
            rusqlite::params![
                plan.book_id,
                plan.deadline,
                plan.daily_new_blocks,
                plan.daily_cap,
                plan.remind_time,
                i64::from(active),
            ],
        )
        .map_err(write_error)?;
    transaction.commit().map_err(write_error)?;
    Ok(())
}

pub fn today_queue(conn: &Connection, date: &str) -> Result<Vec<crate::sched::DailyTask>> {
    validate_date(date, "date")?;
    crate::sched::generate_daily(conn, date)
}
