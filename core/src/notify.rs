//! 提醒判定(M2 T2,PRODUCT_SPEC §6 / TECH_DESIGN §10):纯函数 + `setting` 表幂等标记。
//! 副作用(发系统通知)在壳层线程内;core 不读系统时间,`now_hm`/`date` 由调用方给。
use crate::settings::AppSettings;
use crate::{CoreError, Result};
use rusqlite::{Connection, OptionalExtension};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reminder {
    /// 每日固定时间,无条件
    Daily,
    /// 晚间:当日队列仍有未完成任务时才发
    Evening,
}

impl Reminder {
    pub fn key(self) -> &'static str {
        match self {
            Reminder::Daily => "daily",
            Reminder::Evening => "evening",
        }
    }
}

/// 当日已发送标记(按日期隔离,跨日自然重置)。
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct SentMarks {
    pub daily: bool,
    pub evening: bool,
}

/// 到点判定允许的迟到分钟数(轮询周期 30s,进程可能刚被唤醒)。
pub const LATE_TOLERANCE_MINUTES: i64 = 2;

fn minutes_of(hm: &str) -> Result<i64> {
    let (h, m) = hm
        .split_once(':')
        .ok_or_else(|| CoreError::InvalidInput(format!("time must use HH:mm: {hm:?}")))?;
    let (h, m): (i64, i64) = (
        h.parse()
            .map_err(|_| CoreError::InvalidInput(format!("time must use HH:mm: {hm:?}")))?,
        m.parse()
            .map_err(|_| CoreError::InvalidInput(format!("time must use HH:mm: {hm:?}")))?,
    );
    if !(0..24).contains(&h) || !(0..60).contains(&m) {
        return Err(CoreError::InvalidInput(format!(
            "time out of range: {hm:?}"
        )));
    }
    Ok(h * 60 + m)
}

/// `now_hm` 落在 `[target, target + LATE_TOLERANCE_MINUTES]` 内。非法时间视为不在窗口内。
pub fn in_window(now_hm: &str, target_hm: &str) -> bool {
    match (minutes_of(now_hm), minutes_of(target_hm)) {
        (Ok(now), Ok(target)) => now >= target && now <= target + LATE_TOLERANCE_MINUTES,
        _ => false,
    }
}

/// 判定此刻该发哪种提醒(每种每日最多一次):每日提醒无条件;晚间提醒要求 `pending_today > 0`
/// (`None` = 调用方未取队列,视为不发)。同一分钟两者都到点时先发每日。
pub fn decide(
    now_hm: &str,
    settings: &AppSettings,
    pending_today: Option<usize>,
    sent: &SentMarks,
) -> Result<Option<Reminder>> {
    minutes_of(now_hm)?;
    if !sent.daily && in_window(now_hm, &settings.remind_time) {
        return Ok(Some(Reminder::Daily));
    }
    if !sent.evening
        && in_window(now_hm, &settings.evening_remind_time)
        && pending_today.is_some_and(|n| n > 0)
    {
        return Ok(Some(Reminder::Evening));
    }
    Ok(None)
}

fn mark_key(date: &str, kind: Reminder) -> String {
    format!("notified:{}:{date}", kind.key())
}

pub fn sent_marks(conn: &Connection, date: &str) -> Result<SentMarks> {
    let has = |kind: Reminder| -> Result<bool> {
        Ok(conn
            .query_row(
                "SELECT 1 FROM setting WHERE key=?1",
                [mark_key(date, kind)],
                |r| r.get::<_, i64>(0),
            )
            .optional()?
            .is_some())
    };
    Ok(SentMarks {
        daily: has(Reminder::Daily)?,
        evening: has(Reminder::Evening)?,
    })
}

/// 幂等:同日同类只记一次。
pub fn mark_sent(conn: &Connection, date: &str, kind: Reminder) -> Result<()> {
    conn.execute(
        "INSERT OR IGNORE INTO setting(key,value) VALUES(?1,'1')",
        [mark_key(date, kind)],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings() -> AppSettings {
        AppSettings {
            obsidian_vault: String::new(),
            pomodoro_minutes: 25,
            break_minutes: 5,
            remind_time: "21:00".into(),
            evening_remind_time: "22:30".into(),
        }
    }

    #[test]
    fn daily_fires_in_its_window_once_and_evening_needs_pending_tasks() {
        let s = settings();
        let none = SentMarks::default();
        assert_eq!(decide("20:59", &s, Some(3), &none).unwrap(), None);
        assert_eq!(
            decide("21:00", &s, None, &none).unwrap(),
            Some(Reminder::Daily)
        );
        assert_eq!(
            decide("21:02", &s, None, &none).unwrap(),
            Some(Reminder::Daily)
        );
        assert_eq!(decide("21:03", &s, None, &none).unwrap(), None);
        let daily_sent = SentMarks {
            daily: true,
            evening: false,
        };
        assert_eq!(decide("21:01", &s, Some(3), &daily_sent).unwrap(), None);
        assert_eq!(
            decide("22:30", &s, Some(2), &daily_sent).unwrap(),
            Some(Reminder::Evening)
        );
        assert_eq!(decide("22:30", &s, Some(0), &daily_sent).unwrap(), None);
        assert_eq!(decide("22:30", &s, None, &daily_sent).unwrap(), None);
        let both = SentMarks {
            daily: true,
            evening: true,
        };
        assert_eq!(decide("22:31", &s, Some(2), &both).unwrap(), None);
        assert!(decide("9pm", &s, None, &none).is_err());
        assert!(!in_window("21:00", "25:00"));
    }

    #[test]
    fn marks_are_per_day_and_idempotent() {
        let conn = crate::db::open_in_memory().unwrap();
        assert_eq!(
            sent_marks(&conn, "2026-09-08").unwrap(),
            SentMarks::default()
        );
        mark_sent(&conn, "2026-09-08", Reminder::Daily).unwrap();
        mark_sent(&conn, "2026-09-08", Reminder::Daily).unwrap();
        assert_eq!(
            sent_marks(&conn, "2026-09-08").unwrap(),
            SentMarks {
                daily: true,
                evening: false
            }
        );
        mark_sent(&conn, "2026-09-08", Reminder::Evening).unwrap();
        assert!(sent_marks(&conn, "2026-09-08").unwrap().evening);
        // 跨日重置
        assert_eq!(
            sent_marks(&conn, "2026-09-09").unwrap(),
            SentMarks::default()
        );
        let rows: i64 = conn
            .query_row(
                "SELECT count(*) FROM setting WHERE key LIKE 'notified:%'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(rows, 2);
    }
}
