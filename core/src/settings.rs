use chrono::NaiveTime;
use rusqlite::{Connection, Error, ErrorCode, OptionalExtension, Transaction, TransactionBehavior};
use serde::Deserialize;

use crate::{CoreError, Result};

const DEFAULTS_JSON: &str = include_str!("../../shared/app-defaults.json");

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppSettings {
    pub obsidian_vault: String,
    pub pomodoro_minutes: i64,
    pub break_minutes: i64,
    pub remind_time: String,
}

fn defaults() -> Result<AppSettings> {
    serde_json::from_str(DEFAULTS_JSON)
        .map_err(|error| CoreError::Other(format!("invalid shared app defaults: {error}")))
}

fn corrupt_data(message: impl Into<String>) -> CoreError {
    CoreError::Other(format!("corrupt settings data: {}", message.into()))
}

fn optional_value(conn: &Connection, key: &str) -> Result<Option<String>> {
    Ok(conn
        .query_row("SELECT value FROM setting WHERE key=?1", [key], |row| {
            row.get(0)
        })
        .optional()?)
}

fn validate(value: &AppSettings) -> Result<()> {
    if !(1..=180).contains(&value.pomodoro_minutes) {
        return Err(CoreError::InvalidInput(
            "pomodoro minutes must be between 1 and 180".into(),
        ));
    }
    if !(1..=180).contains(&value.break_minutes) {
        return Err(CoreError::InvalidInput(
            "break minutes must be between 1 and 180".into(),
        ));
    }
    let time_bytes = value.remind_time.as_bytes();
    let time_has_exact_shape = time_bytes.len() == 5
        && time_bytes.get(2) == Some(&b':')
        && time_bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| index == 2 || byte.is_ascii_digit());
    if !time_has_exact_shape || NaiveTime::parse_from_str(&value.remind_time, "%H:%M").is_err() {
        return Err(CoreError::InvalidInput(format!(
            "remind time must use HH:mm: {}",
            value.remind_time
        )));
    }
    Ok(())
}

fn write_error(error: Error) -> CoreError {
    match error {
        Error::SqliteFailure(code, message) if code.code == ErrorCode::ConstraintViolation => {
            CoreError::Conflict(message.unwrap_or_else(|| "database constraint".into()))
        }
        other => other.into(),
    }
}

pub fn get_settings(conn: &Connection) -> Result<AppSettings> {
    let mut value = defaults()?;
    if let Some(stored) = optional_value(conn, "obsidianVault")? {
        value.obsidian_vault = stored;
    }
    if let Some(stored) = optional_value(conn, "pomodoroMinutes")? {
        value.pomodoro_minutes = stored
            .parse()
            .map_err(|_| corrupt_data("pomodoroMinutes must be an integer"))?;
    }
    if let Some(stored) = optional_value(conn, "breakMinutes")? {
        value.break_minutes = stored
            .parse()
            .map_err(|_| corrupt_data("breakMinutes must be an integer"))?;
    }
    if let Some(stored) = optional_value(conn, "remindTime")? {
        value.remind_time = stored;
    }
    validate(&value).map_err(|error| match error {
        CoreError::InvalidInput(message) => corrupt_data(message),
        other => other,
    })?;
    Ok(value)
}

pub fn save_settings(conn: &Connection, value: &AppSettings) -> Result<()> {
    validate(value)?;
    let stored_values = [
        ("obsidianVault", value.obsidian_vault.clone()),
        ("pomodoroMinutes", value.pomodoro_minutes.to_string()),
        ("breakMinutes", value.break_minutes.to_string()),
        ("remindTime", value.remind_time.clone()),
    ];
    let transaction = Transaction::new_unchecked(conn, TransactionBehavior::Immediate)?;
    for (key, stored) in stored_values {
        transaction
            .execute(
                "INSERT INTO setting(key,value) VALUES(?1,?2) \
                 ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                rusqlite::params![key, stored],
            )
            .map_err(write_error)?;
    }
    transaction.commit().map_err(write_error)?;
    Ok(())
}
