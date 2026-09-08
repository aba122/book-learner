//! 统计(M1 基础版):范围 = 主攻书(active)的块与任务;无主攻书时为全库。
//! `date` 由调用方(前端本地日历日)提供,core 不读系统时间。
use crate::{CoreError, Result};
use chrono::{Days, NaiveDate};
use rusqlite::{params_from_iter, Connection, OptionalExtension};
use std::collections::HashSet;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Stats {
    pub total_blocks: i64,
    pub passed_blocks: i64,
    /// 连续有"已完成任务"的天数:今天已有完成则含今天,否则从昨天起算(当天未结束不算断)
    pub streak_days: i64,
    pub open_weak_points: i64,
    pub fixed_weak_points: i64,
    /// 当日已完成任务的预估分钟之和(番茄钟精确计时属 M2)
    pub minutes_today: i64,
}

fn parse_date(date: &str) -> Result<NaiveDate> {
    NaiveDate::parse_from_str(date, "%Y-%m-%d")
        .map_err(|_| CoreError::InvalidInput(format!("invalid date {date:?}, expected YYYY-MM-DD")))
}

pub fn compute(conn: &Connection, date: &str) -> Result<Stats> {
    let today = parse_date(date)?;
    let active: Option<i64> = conn
        .query_row("SELECT id FROM book WHERE status='active'", [], |r| {
            r.get(0)
        })
        .optional()?;
    let scope: Vec<i64> = active.into_iter().collect();
    let block_scope = if active.is_some() {
        " AND kb.book_id=?1"
    } else {
        ""
    };
    let task_scope = if active.is_some() {
        " AND book_id=?1"
    } else {
        ""
    };
    let count = |sql: String| -> Result<i64> {
        Ok(conn.query_row(&sql, params_from_iter(scope.iter()), |r| r.get(0))?)
    };
    let total_blocks = count(format!(
        "SELECT count(*) FROM knowledge_block kb WHERE kb.skipped=0{block_scope}"
    ))?;
    let passed_blocks = count(format!(
        "SELECT count(*) FROM knowledge_block kb \
         WHERE kb.skipped=0 AND kb.status IN ('passed','consolidated'){block_scope}"
    ))?;
    let open_weak_points = count(format!(
        "SELECT count(*) FROM weak_point wp JOIN knowledge_block kb ON kb.id=wp.block_id \
         WHERE wp.status='open'{block_scope}"
    ))?;
    let fixed_weak_points = count(format!(
        "SELECT count(*) FROM weak_point wp JOIN knowledge_block kb ON kb.id=wp.block_id \
         WHERE wp.status='fixed'{block_scope}"
    ))?;
    let minutes_today: i64 = {
        let sql = format!(
            "SELECT COALESCE(sum(est_minutes),0) FROM daily_task \
             WHERE status='done' AND date=?{}{task_scope}",
            scope.len() + 1
        );
        let mut params: Vec<Box<dyn rusqlite::ToSql>> = scope
            .iter()
            .map(|id| Box::new(*id) as Box<dyn rusqlite::ToSql>)
            .collect();
        params.push(Box::new(date.to_string()));
        conn.query_row(&sql, params_from_iter(params.iter()), |r| r.get(0))?
    };
    let done_dates: HashSet<NaiveDate> = {
        let mut st = conn.prepare(&format!(
            "SELECT DISTINCT date FROM daily_task WHERE status='done'{task_scope}"
        ))?;
        let rows = st.query_map(params_from_iter(scope.iter()), |r| r.get::<_, String>(0))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
            .iter()
            .filter_map(|d| NaiveDate::parse_from_str(d, "%Y-%m-%d").ok())
            .collect()
    };
    let mut cursor = if done_dates.contains(&today) {
        Some(today)
    } else {
        today.checked_sub_days(Days::new(1))
    };
    let mut streak_days = 0;
    while let Some(day) = cursor {
        if !done_dates.contains(&day) {
            break;
        }
        streak_days += 1;
        cursor = day.checked_sub_days(Days::new(1));
    }
    Ok(Stats {
        total_blocks,
        passed_blocks,
        streak_days,
        open_weak_points,
        fixed_weak_points,
        minutes_today,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{insert_block, insert_book, BookType};

    fn seed(conn: &Connection) -> (i64, i64) {
        let first = insert_book(conn, "甲", "a", BookType::Textbook, "first").unwrap();
        let second = insert_book(conn, "乙", "b", BookType::Humanities, "second").unwrap();
        for (book, n) in [(first, 3), (second, 2)] {
            for i in 1..=n {
                insert_block(
                    conn,
                    book,
                    "m",
                    i,
                    &format!("b{book}-{i}"),
                    &format!("b{book}-{i}"),
                    &[],
                )
                .unwrap();
            }
        }
        (first, second)
    }

    fn task(conn: &Connection, date: &str, book: i64, block: i64, status: &str, minutes: i64) {
        conn.execute(
            "INSERT INTO daily_task(date,book_id,block_id,kind,seq,status,est_minutes) \
             VALUES(?1,?2,?3,'new',1,?4,?5)",
            rusqlite::params![date, book, block, status, minutes],
        )
        .unwrap();
    }

    #[test]
    fn stats_scope_to_the_active_book_and_count_streak_weakpoints_and_minutes() {
        let conn = crate::db::open_in_memory().unwrap();
        let (first, second) = seed(&conn);
        let b1: i64 = conn
            .query_row(
                "SELECT min(id) FROM knowledge_block WHERE book_id=?1",
                [first],
                |r| r.get(0),
            )
            .unwrap();
        let b2: i64 = conn
            .query_row(
                "SELECT min(id) FROM knowledge_block WHERE book_id=?1",
                [second],
                |r| r.get(0),
            )
            .unwrap();
        conn.execute(
            "UPDATE knowledge_block SET status='passed' WHERE id=?1",
            [b1],
        )
        .unwrap();
        conn.execute("UPDATE knowledge_block SET skipped=1 WHERE id=?1", [b1 + 2])
            .unwrap();
        conn.execute(
            "UPDATE knowledge_block SET status='consolidated' WHERE id=?1",
            [b2],
        )
        .unwrap();
        for (title, status, block) in [("w1", "open", b1), ("w2", "fixed", b1), ("w3", "open", b2)]
        {
            conn.execute(
                "INSERT INTO weak_point(block_id,title,status,created_at) VALUES(?1,?2,?3,'2026-09-01')",
                rusqlite::params![block, title, status],
            )
            .unwrap();
        }
        // first:9/5、9/6 完成,9/7 待办;9/3 完成(9/4 断);second:9/7 完成(不计入主攻书范围)
        task(&conn, "2026-09-03", first, b1, "done", 30);
        task(&conn, "2026-09-05", first, b1, "done", 25);
        task(&conn, "2026-09-06", first, b1, "done", 20);
        task(&conn, "2026-09-06", first, b1 + 1, "done", 10);
        task(&conn, "2026-09-07", first, b1 + 1, "pending", 30);
        task(&conn, "2026-09-07", second, b2, "done", 45);

        let stats = compute(&conn, "2026-09-07").unwrap();
        assert_eq!(
            stats,
            Stats {
                total_blocks: 2,
                passed_blocks: 1,
                streak_days: 2, // 今天无完成 → 从昨天起算:9/6、9/5
                open_weak_points: 1,
                fixed_weak_points: 1,
                minutes_today: 0,
            }
        );
        let stats = compute(&conn, "2026-09-06").unwrap();
        assert_eq!((stats.streak_days, stats.minutes_today), (2, 30));
        assert_eq!(compute(&conn, "2026-09-09").unwrap().streak_days, 0);

        // 无主攻书 → 全库
        conn.execute("UPDATE book SET status='paused'", []).unwrap();
        let all = compute(&conn, "2026-09-07").unwrap();
        assert_eq!(
            (
                all.total_blocks,
                all.passed_blocks,
                all.open_weak_points,
                all.minutes_today,
                all.streak_days
            ),
            (4, 2, 2, 45, 3) // 全库:9/7(second)、9/6、9/5 连续
        );
        assert!(matches!(
            compute(&conn, "2026/09/07"),
            Err(CoreError::InvalidInput(_))
        ));
    }
}
