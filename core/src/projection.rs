//! 投影 outbox(ADR-0001):入队在调用方事务内;重放 `run_pending` 见计划 A9。

use crate::Result;
use rusqlite::Connection;

fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

/// 在调用方事务内入队;同 op_id 已存在则忽略(幂等)。
pub fn enqueue(
    conn: &Connection,
    op_id: &str,
    kind: &str,
    payload: &serde_json::Value,
) -> Result<()> {
    conn.execute(
        "INSERT OR IGNORE INTO projection_outbox(op_id,kind,payload,created_at) VALUES(?1,?2,?3,?4)",
        rusqlite::params![op_id, kind, payload.to_string(), now()],
    )?;
    Ok(())
}
