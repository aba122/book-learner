//! 阅读时长(BL-025,2026-09-21):阅读器里"可见且有操作"的秒数,按书按日累计(schema v11 `reading_time`)。
//! 前端每 60 s 与离开阅读器时记一笔;统计页按 日 / 周 / 月 / 书 汇总。
//! 与 `study_minutes`(番茄钟 / 任务预估)分开,不改"投入"口径;"今天"由前端本地日历日给出,core 不读系统时间。
use chrono::{Datelike, Days, NaiveDate};
use rusqlite::Connection;

use crate::{CoreError, Result};

pub const DAY_BUCKETS: u64 = 30;
pub const WEEK_BUCKETS: u64 = 12;
pub const MONTH_BUCKETS: u32 = 12;
/// 单笔上限:前端每分钟落一笔,离开时补零头;一笔超过一小时视为异常输入
pub const MAX_SECONDS_PER_RECORD: i64 = 3600;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct DayBucket {
    pub date: String,
    pub seconds: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct WeekBucket {
    /// 该周周一(YYYY-MM-DD)
    pub start: String,
    pub seconds: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct MonthBucket {
    /// YYYY-MM
    pub month: String,
    pub seconds: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct BookReadingTime {
    pub book_id: i64,
    pub title: String,
    pub seconds: i64,
    /// 最近一次有阅读记录的日期
    pub last_read: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ReadingTimeSummary {
    pub total_seconds: i64,
    pub today_seconds: i64,
    /// 本周(周一起)
    pub week_seconds: i64,
    /// 本月(1 日起)
    pub month_seconds: i64,
    /// 最近 30 天,旧 → 新
    pub days: Vec<DayBucket>,
    /// 最近 12 周(周一起),旧 → 新
    pub weeks: Vec<WeekBucket>,
    /// 最近 12 个月,旧 → 新
    pub months: Vec<MonthBucket>,
    /// 每本书累计,多 → 少
    pub books: Vec<BookReadingTime>,
}

fn parse_date(date: &str) -> Result<NaiveDate> {
    NaiveDate::parse_from_str(date, "%Y-%m-%d")
        .map_err(|_| CoreError::InvalidInput(format!("bad date {date:?}")))
}

fn fmt(date: NaiveDate) -> String {
    date.format("%Y-%m-%d").to_string()
}

fn week_start(date: NaiveDate) -> NaiveDate {
    date - Days::new(u64::from(date.weekday().num_days_from_monday()))
}

/// 记一笔阅读秒数(前端每分钟 / 离开时调用)。
pub fn record(conn: &Connection, book_id: i64, date: &str, seconds: i64) -> Result<()> {
    parse_date(date)?;
    if seconds <= 0 || seconds > MAX_SECONDS_PER_RECORD {
        return Err(CoreError::InvalidInput(format!("bad seconds {seconds}")));
    }
    let exists: i64 = conn.query_row("SELECT count(*) FROM book WHERE id=?1", [book_id], |r| {
        r.get(0)
    })?;
    if exists == 0 {
        return Err(CoreError::NotFound(format!("book {book_id}")));
    }
    conn.execute(
        "INSERT INTO reading_time(book_id,date,seconds,created_at) VALUES(?1,?2,?3,?4)",
        rusqlite::params![
            book_id,
            date,
            seconds,
            chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
        ],
    )?;
    Ok(())
}

/// 汇总(`date` = 前端本地"今天"):总量 / 今日 / 本周 / 本月 + 30 天 / 12 周 / 12 月桶 + 每本书。
pub fn summary(conn: &Connection, date: &str) -> Result<ReadingTimeSummary> {
    let today = parse_date(date)?;
    let this_week = week_start(today);
    let mut month_keys: Vec<(i32, u32)> = Vec::with_capacity(MONTH_BUCKETS as usize);
    let (mut y, mut m) = (today.year(), today.month());
    for _ in 0..MONTH_BUCKETS {
        month_keys.push((y, m));
        if m == 1 {
            m = 12;
            y -= 1;
        } else {
            m -= 1;
        }
    }
    month_keys.reverse();
    let earliest_day = today - Days::new(DAY_BUCKETS - 1);
    let earliest_week = this_week - Days::new(7 * (WEEK_BUCKETS - 1));
    let earliest_month = NaiveDate::from_ymd_opt(month_keys[0].0, month_keys[0].1, 1)
        .ok_or_else(|| CoreError::InvalidInput(format!("bad date {date:?}")))?;
    let earliest = earliest_day.min(earliest_week).min(earliest_month);

    let mut days: Vec<DayBucket> = (0..DAY_BUCKETS)
        .rev()
        .map(|back| DayBucket {
            date: fmt(today - Days::new(back)),
            seconds: 0,
        })
        .collect();
    let mut weeks: Vec<WeekBucket> = (0..WEEK_BUCKETS)
        .rev()
        .map(|back| WeekBucket {
            start: fmt(this_week - Days::new(7 * back)),
            seconds: 0,
        })
        .collect();
    let mut months: Vec<MonthBucket> = month_keys
        .iter()
        .map(|(y, m)| MonthBucket {
            month: format!("{y:04}-{m:02}"),
            seconds: 0,
        })
        .collect();

    let mut stmt = conn.prepare(
        "SELECT date, sum(seconds) FROM reading_time WHERE date >= ?1 AND date <= ?2 GROUP BY date",
    )?;
    let by_date = stmt
        .query_map(rusqlite::params![fmt(earliest), fmt(today)], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let (mut today_seconds, mut week_seconds, mut month_seconds) = (0i64, 0i64, 0i64);
    for (d, s) in &by_date {
        let Ok(nd) = NaiveDate::parse_from_str(d, "%Y-%m-%d") else {
            continue;
        };
        if nd == today {
            today_seconds += s;
        }
        if nd >= this_week {
            week_seconds += s;
        }
        if nd.year() == today.year() && nd.month() == today.month() {
            month_seconds += s;
        }
        if let Some(b) = days.iter_mut().find(|b| b.date == *d) {
            b.seconds += s;
        }
        let ws = fmt(week_start(nd));
        if let Some(b) = weeks.iter_mut().find(|b| b.start == ws) {
            b.seconds += s;
        }
        let mk = &d[..7];
        if let Some(b) = months.iter_mut().find(|b| b.month == mk) {
            b.seconds += s;
        }
    }
    let total_seconds: i64 = conn.query_row(
        "SELECT COALESCE(sum(seconds),0) FROM reading_time WHERE date <= ?1",
        [fmt(today)],
        |r| r.get(0),
    )?;
    let mut stmt = conn.prepare(
        "SELECT b.id, b.title, sum(r.seconds), max(r.date) FROM reading_time r \
         JOIN book b ON b.id = r.book_id WHERE r.date <= ?1 \
         GROUP BY b.id ORDER BY sum(r.seconds) DESC, b.id",
    )?;
    let books = stmt
        .query_map([fmt(today)], |r| {
            Ok(BookReadingTime {
                book_id: r.get(0)?,
                title: r.get(1)?,
                seconds: r.get(2)?,
                last_read: r.get(3)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(ReadingTimeSummary {
        total_seconds,
        today_seconds,
        week_seconds,
        month_seconds,
        days,
        weeks,
        months,
        books,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seed(conn: &Connection, title: &str, slug: &str) -> i64 {
        crate::models::insert_book(conn, title, "", crate::models::BookType::Textbook, slug)
            .unwrap()
    }

    #[test]
    fn record_validates_and_aggregates_by_day_week_month_and_book() {
        let conn = crate::db::open_in_memory().unwrap();
        let a = seed(&conn, "甲", "a");
        let b = seed(&conn, "乙", "b");
        // 2026-09-21 是周一
        record(&conn, a, "2026-09-21", 600).unwrap();
        record(&conn, a, "2026-09-21", 60).unwrap();
        record(&conn, b, "2026-09-20", 300).unwrap(); // 上周日 → 上一周桶、本月
        record(&conn, a, "2026-08-31", 120).unwrap(); // 上月最后一天 → 上周桶(8-31 周一起的那周)、上月
        record(&conn, b, "2026-09-22", 999).unwrap(); // "未来"(前端时钟跑到明天)不进今天的汇总
        assert!(matches!(
            record(&conn, a, "2026/09/21", 10),
            Err(CoreError::InvalidInput(_))
        ));
        assert!(matches!(
            record(&conn, a, "2026-09-21", 0),
            Err(CoreError::InvalidInput(_))
        ));
        assert!(matches!(
            record(&conn, a, "2026-09-21", 3601),
            Err(CoreError::InvalidInput(_))
        ));
        assert!(matches!(
            record(&conn, 999, "2026-09-21", 10),
            Err(CoreError::NotFound(_))
        ));

        let s = summary(&conn, "2026-09-21").unwrap();
        assert_eq!(s.total_seconds, 600 + 60 + 300 + 120);
        assert_eq!(s.today_seconds, 660);
        assert_eq!(s.week_seconds, 660); // 本周从周一 9-21 起
        assert_eq!(s.month_seconds, 660 + 300);
        assert_eq!(s.days.len(), 30);
        assert_eq!(
            s.days.last().unwrap(),
            &DayBucket {
                date: "2026-09-21".into(),
                seconds: 660
            }
        );
        assert_eq!(
            s.days[28],
            DayBucket {
                date: "2026-09-20".into(),
                seconds: 300
            }
        );
        assert_eq!(s.weeks.len(), 12);
        assert_eq!(s.weeks[11].start, "2026-09-21");
        assert_eq!(s.weeks[11].seconds, 660);
        assert_eq!(s.weeks[10].start, "2026-09-14");
        assert_eq!(s.weeks[10].seconds, 300);
        assert_eq!(s.weeks[8].start, "2026-08-31");
        assert_eq!(s.weeks[8].seconds, 120);
        assert_eq!(s.months.len(), 12);
        assert_eq!(
            s.months[11],
            MonthBucket {
                month: "2026-09".into(),
                seconds: 960
            }
        );
        assert_eq!(
            s.months[10],
            MonthBucket {
                month: "2026-08".into(),
                seconds: 120
            }
        );
        assert_eq!(s.months[0].month, "2025-10");
        assert_eq!(s.books.len(), 2);
        assert_eq!(
            (
                s.books[0].book_id,
                s.books[0].seconds,
                s.books[0].last_read.as_deref()
            ),
            (a, 780, Some("2026-09-21"))
        );
        assert_eq!(
            (
                s.books[1].book_id,
                s.books[1].seconds,
                s.books[1].last_read.as_deref()
            ),
            (b, 300, Some("2026-09-20"))
        );
        assert!(matches!(
            summary(&conn, "bad"),
            Err(CoreError::InvalidInput(_))
        ));
    }

    #[test]
    fn empty_summary_has_full_buckets_and_no_books() {
        let conn = crate::db::open_in_memory().unwrap();
        let s = summary(&conn, "2026-01-01").unwrap();
        assert_eq!(
            (
                s.total_seconds,
                s.today_seconds,
                s.week_seconds,
                s.month_seconds
            ),
            (0, 0, 0, 0)
        );
        assert_eq!(s.days.len(), 30);
        assert_eq!(s.weeks.len(), 12);
        assert_eq!(s.weeks[11].start, "2025-12-29"); // 2026-01-01 是周四,本周周一是 12-29
        assert_eq!(s.months[11].month, "2026-01");
        assert!(s.books.is_empty());
    }

    #[test]
    fn deleting_a_book_cascades_its_reading_time() {
        let conn = crate::db::open_in_memory().unwrap();
        let a = seed(&conn, "甲", "a");
        record(&conn, a, "2026-09-21", 60).unwrap();
        conn.execute("DELETE FROM book WHERE id=?1", [a]).unwrap();
        let n: i64 = conn
            .query_row("SELECT count(*) FROM reading_time", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0);
    }
}
