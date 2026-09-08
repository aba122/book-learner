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
    /// 当日投入分钟:max(已完成任务预估分钟之和, 番茄钟实际专注分钟之和)
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
        let estimated: i64 = conn.query_row(&sql, params_from_iter(params.iter()), |r| r.get(0))?;
        // 番茄钟实际专注分钟(M2 T3):与预估取较大者,避免两套口径相加重复计数
        let pomodoro_sql = format!(
            "SELECT COALESCE(sum(minutes),0) FROM study_minutes WHERE date=?{}{}",
            scope.len() + 1,
            if active.is_some() {
                " AND book_id=?1"
            } else {
                ""
            }
        );
        let pomodoro: i64 =
            conn.query_row(&pomodoro_sql, params_from_iter(params.iter()), |r| r.get(0))?;
        estimated.max(pomodoro)
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

// ---- 统计详情(M2 T7):进度 / 投入 / 质量三区 ----

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct BookProgress {
    pub id: i64,
    pub title: String,
    pub status: String,
    pub total: i64,
    pub passed: i64,
    pub consolidated: i64,
    pub deadline: Option<String>,
    /// 按最近 7 天日均通过数外推的完成日;无通过或已学完为 None
    pub projected_finish: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct DayEffort {
    pub date: String,
    /// 与 `compute.minutes_today` 同口径:max(已完成任务预估, 番茄钟实际)
    pub minutes: i64,
    pub pomodoros: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct StreakDay {
    pub date: String,
    pub active: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct WeakTrendDay {
    pub date: String,
    pub opened: i64,
    pub fixed: i64,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct AvgScores {
    pub accuracy: f64,
    pub completeness: f64,
    pub clarity: f64,
    pub samples: i64,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct StatsDetail {
    /// 进度区:全部书(主攻书在前),各书独立外推
    pub books: Vec<BookProgress>,
    /// 投入区(不分书):最近 14 天,旧 → 新
    pub days: Vec<DayEffort>,
    /// 投入区:最近 56 天打卡日历,旧 → 新
    pub streak_calendar: Vec<StreakDay>,
    /// 质量区(主攻书范围):最近 14 天新增/修复薄弱点
    pub weak_trend: Vec<WeakTrendDay>,
    /// 质量区:最近 10 次评估均分;无评估为 None
    pub avg_scores: Option<AvgScores>,
    /// 质量区:近 30 天间隔复习通过率 done/(done+failed);无复习为 None
    pub review_pass_rate: Option<f64>,
}

pub const EFFORT_DAYS: u64 = 14;
pub const STREAK_CALENDAR_DAYS: u64 = 56;
pub const WEAK_TREND_DAYS: u64 = 14;
pub const AVG_SCORE_SAMPLES: i64 = 10;
pub const REVIEW_WINDOW_DAYS: u64 = 30;
const PROJECTION_WINDOW_DAYS: u64 = 7;

fn day_range(today: NaiveDate, len: u64) -> Vec<NaiveDate> {
    (0..len)
        .rev()
        .filter_map(|back| today.checked_sub_days(Days::new(back)))
        .collect()
}

fn fmt(date: NaiveDate) -> String {
    date.format("%Y-%m-%d").to_string()
}

pub fn detail(conn: &Connection, date: &str) -> Result<StatsDetail> {
    let today = parse_date(date)?;
    let active: Option<i64> = conn
        .query_row("SELECT id FROM book WHERE status='active'", [], |r| {
            r.get(0)
        })
        .optional()?;

    // 进度区
    let mut books = Vec::new();
    {
        let mut st =
            conn.prepare("SELECT id,title,status FROM book ORDER BY (status='active') DESC, id")?;
        let rows: Vec<(i64, String, String)> = st
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
            .collect::<rusqlite::Result<_>>()?;
        let window_start = fmt(today
            .checked_sub_days(Days::new(PROJECTION_WINDOW_DAYS - 1))
            .unwrap_or(today));
        for (id, title, status) in rows {
            let (total, passed, consolidated, recent): (i64, i64, i64, i64) = conn.query_row(
                "SELECT count(*), \
                        sum(status IN ('passed','consolidated')), \
                        sum(status='consolidated'), \
                        sum(status IN ('passed','consolidated') AND passed_at BETWEEN ?2 AND ?3) \
                 FROM knowledge_block WHERE book_id=?1 AND skipped=0",
                rusqlite::params![id, window_start, date],
                |r| {
                    Ok((
                        r.get(0)?,
                        r.get::<_, Option<i64>>(1)?.unwrap_or(0),
                        r.get::<_, Option<i64>>(2)?.unwrap_or(0),
                        r.get::<_, Option<i64>>(3)?.unwrap_or(0),
                    ))
                },
            )?;
            let deadline: Option<String> = conn
                .query_row(
                    "SELECT deadline FROM study_plan WHERE book_id=?1",
                    [id],
                    |r| r.get(0),
                )
                .optional()?;
            let remaining = total - passed;
            let projected_finish = if remaining > 0 && recent > 0 {
                // 日均 = recent/7;所需天数向上取整
                let days_needed = (remaining * PROJECTION_WINDOW_DAYS as i64 + recent - 1) / recent;
                today
                    .checked_add_days(Days::new(days_needed as u64))
                    .map(fmt)
            } else {
                None
            };
            books.push(BookProgress {
                id,
                title,
                status,
                total,
                passed,
                consolidated,
                deadline,
                projected_finish,
            });
        }
    }

    // 投入区(不分书)
    let days = day_range(today, EFFORT_DAYS)
        .into_iter()
        .map(|day| {
            let d = fmt(day);
            let estimated: i64 = conn.query_row(
                "SELECT COALESCE(sum(est_minutes),0) FROM daily_task WHERE status='done' AND date=?1",
                [&d],
                |r| r.get(0),
            )?;
            let (pomodoro_minutes, pomodoros): (i64, i64) = conn.query_row(
                "SELECT COALESCE(sum(minutes),0), count(*) FROM study_minutes WHERE date=?1 AND source='pomodoro'",
                [&d],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?;
            Ok(DayEffort {
                date: d,
                minutes: estimated.max(pomodoro_minutes),
                pomodoros,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    let done_dates: HashSet<String> = {
        let mut st = conn.prepare("SELECT DISTINCT date FROM daily_task WHERE status='done'")?;
        let rows = st.query_map([], |r| r.get::<_, String>(0))?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    let streak_calendar = day_range(today, STREAK_CALENDAR_DAYS)
        .into_iter()
        .map(|day| {
            let d = fmt(day);
            let active = done_dates.contains(&d);
            StreakDay { date: d, active }
        })
        .collect();

    // 质量区(主攻书范围)
    let scope_sql = if active.is_some() {
        " AND kb.book_id=?2"
    } else {
        ""
    };
    let scope_params = |first: &str| -> Vec<Box<dyn rusqlite::ToSql>> {
        let mut params: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(first.to_string())];
        if let Some(id) = active {
            params.push(Box::new(id));
        }
        params
    };
    let weak_trend = day_range(today, WEAK_TREND_DAYS)
        .into_iter()
        .map(|day| {
            let d = fmt(day);
            let params = scope_params(&d);
            let opened: i64 = conn.query_row(
                &format!(
                    "SELECT count(*) FROM weak_point wp JOIN knowledge_block kb ON kb.id=wp.block_id \
                     WHERE substr(wp.created_at,1,10)=?1{scope_sql}"
                ),
                params_from_iter(params.iter()),
                |r| r.get(0),
            )?;
            let fixed: i64 = conn.query_row(
                &format!(
                    "SELECT count(*) FROM weak_point wp JOIN knowledge_block kb ON kb.id=wp.block_id \
                     WHERE wp.status='fixed' AND substr(wp.fixed_at,1,10)=?1{scope_sql}"
                ),
                params_from_iter(params.iter()),
                |r| r.get(0),
            )?;
            Ok(WeakTrendDay {
                date: d,
                opened,
                fixed,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    let avg_scores = {
        let scope = if active.is_some() {
            " AND kb.book_id=?2"
        } else {
            ""
        };
        let mut st = conn.prepare(&format!(
            "SELECT fs.eval_json FROM feynman_session fs JOIN knowledge_block kb ON kb.id=fs.block_id \
             WHERE fs.eval_json IS NOT NULL{scope} ORDER BY fs.id DESC LIMIT ?1"
        ))?;
        let mut params: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(AVG_SCORE_SAMPLES)];
        if let Some(id) = active {
            params.push(Box::new(id));
        }
        let rows = st.query_map(params_from_iter(params.iter()), |r| r.get::<_, String>(0))?;
        let mut sums = (0.0, 0.0, 0.0);
        let mut samples = 0i64;
        for json in rows {
            let eval: crate::eval::EvalResult = serde_json::from_str(&json?)
                .map_err(|e| CoreError::Other(format!("corrupt eval_json: {e}")))?;
            sums.0 += eval.scores.accuracy as f64;
            sums.1 += eval.scores.completeness as f64;
            sums.2 += eval.scores.clarity as f64;
            samples += 1;
        }
        if samples == 0 {
            None
        } else {
            let n = samples as f64;
            Some(AvgScores {
                accuracy: sums.0 / n,
                completeness: sums.1 / n,
                clarity: sums.2 / n,
                samples,
            })
        }
    };
    let review_pass_rate = {
        let from = fmt(today
            .checked_sub_days(Days::new(REVIEW_WINDOW_DAYS - 1))
            .unwrap_or(today));
        let scope = if active.is_some() {
            " AND dt.book_id=?3"
        } else {
            ""
        };
        let mut params: Vec<Box<dyn rusqlite::ToSql>> =
            vec![Box::new(from), Box::new(date.to_string())];
        if let Some(id) = active {
            params.push(Box::new(id));
        }
        let (done, failed): (i64, i64) = conn.query_row(
            &format!(
                "SELECT COALESCE(sum(rs.status='done'),0), COALESCE(sum(rs.status='failed'),0) \
                 FROM daily_task dt JOIN review_schedule rs ON rs.id=dt.ref_id \
                 WHERE dt.kind='review' AND dt.status='done' AND dt.date BETWEEN ?1 AND ?2{scope}"
            ),
            params_from_iter(params.iter()),
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        if done + failed == 0 {
            None
        } else {
            Some(done as f64 / (done + failed) as f64)
        }
    };
    Ok(StatsDetail {
        books,
        days,
        streak_calendar,
        weak_trend,
        avg_scores,
        review_pass_rate,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{insert_block, insert_book, BookType};

    #[test]
    fn detail_covers_progress_effort_and_quality_sections() {
        let conn = crate::db::open_in_memory().unwrap();
        let (first, second) = seed(&conn);
        conn.execute("UPDATE book SET status='active' WHERE id=?1", [first])
            .unwrap();
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
        // 进度:first 3 块,b1 通过(7 天窗内)、b1+1 巩固(窗外)、b1+2 未学 → 剩 1,近 7 天通过 1 → 7 天后
        conn.execute(
            "UPDATE knowledge_block SET status='passed', passed_at='2026-09-05' WHERE id=?1",
            [b1],
        )
        .unwrap();
        conn.execute(
            "UPDATE knowledge_block SET status='consolidated', passed_at='2026-08-20' WHERE id=?1",
            [b1 + 1],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO study_plan(book_id,deadline,daily_new_blocks) VALUES(?1,'2026-09-30',2)",
            [first],
        )
        .unwrap();
        // 投入:9/6 任务 20+10 分钟 vs 番茄 45 → 45;9/7 任务 30 vs 番茄 0 → 30;番茄 2 段
        task(&conn, "2026-09-06", first, b1, "done", 20);
        task(&conn, "2026-09-06", first, b1 + 1, "done", 10);
        task(&conn, "2026-09-07", second, b2, "done", 30);
        for (d, m) in [("2026-09-06", 25), ("2026-09-06", 20)] {
            conn.execute(
                "INSERT INTO study_minutes(date,book_id,minutes,source,created_at) VALUES(?1,?2,?3,'pomodoro','x')",
                rusqlite::params![d, first, m],
            )
            .unwrap();
        }
        // 质量:主攻书 9/6 新增 2、9/7 修复 1;second 的薄弱点不计
        for (block, created, fixed) in [
            (b1, "2026-09-06", Some("2026-09-07")),
            (b1, "2026-09-06T10:00:00Z", None),
            (b2, "2026-09-06", None),
        ] {
            conn.execute(
                "INSERT INTO weak_point(block_id,title,status,created_at,fixed_at) VALUES(?1,'w',?2,?3,?4)",
                rusqlite::params![block, if fixed.is_some() { "fixed" } else { "open" }, created, fixed],
            )
            .unwrap();
        }
        let eval = |a: u8, c: u8, l: u8| {
            format!(
                r#"{{"verdict":"pass_suggested","scores":{{"accuracy":{a},"completeness":{c},"clarity":{l}}},"summary":"","weak_points":[],"final_restatement":"","observation_note":""}}"#
            )
        };
        for (block, json) in [
            (b1, eval(5, 3, 4)),
            (b1, eval(3, 5, 4)),
            (b2, eval(1, 1, 1)),
        ] {
            conn.execute(
                "INSERT INTO feynman_session(block_id,kind,started_at,state,version,eval_json) VALUES(?1,'learn','x','confirmed',1,?2)",
                rusqlite::params![block, json],
            )
            .unwrap();
        }
        // 复习通过率:主攻书 done 2 / failed 1;second 的不计;窗外(8/1)不计
        for (d, status) in [
            ("2026-09-01", "done"),
            ("2026-09-03", "done"),
            ("2026-09-05", "failed"),
            ("2026-08-01", "failed"),
        ] {
            conn.execute(
                "INSERT INTO review_schedule(block_id,stage,due_date,status) VALUES(?1,1,?2,?3)",
                rusqlite::params![b1, d, status],
            )
            .unwrap();
            let rs = conn.last_insert_rowid();
            conn.execute(
                "INSERT INTO daily_task(date,book_id,block_id,kind,seq,status,est_minutes,ref_id) VALUES(?1,?2,?3,'review',9,'done',5,?4)",
                rusqlite::params![d, first, b1, rs],
            )
            .unwrap();
        }
        conn.execute("INSERT INTO review_schedule(block_id,stage,due_date,status) VALUES(?1,1,'2026-09-02','failed')", [b2]).unwrap();
        let rs2 = conn.last_insert_rowid();
        conn.execute(
            "INSERT INTO daily_task(date,book_id,block_id,kind,seq,status,est_minutes,ref_id) VALUES('2026-09-02',?1,?2,'review',9,'done',5,?3)",
            rusqlite::params![second, b2, rs2],
        )
        .unwrap();

        let d = detail(&conn, "2026-09-07").unwrap();
        assert_eq!(d.books.len(), 2);
        let bp = &d.books[0];
        assert_eq!(
            (
                bp.id,
                bp.status.as_str(),
                bp.total,
                bp.passed,
                bp.consolidated
            ),
            (first, "active", 3, 2, 1)
        );
        assert_eq!(bp.deadline.as_deref(), Some("2026-09-30"));
        assert_eq!(bp.projected_finish.as_deref(), Some("2026-09-14"));
        assert_eq!(
            (
                d.books[1].id,
                d.books[1].passed,
                d.books[1].projected_finish.as_deref()
            ),
            (second, 0, None)
        );
        assert_eq!(d.days.len(), 14);
        assert_eq!(d.days[0].date, "2026-08-25");
        let last = &d.days[13];
        assert_eq!(
            (last.date.as_str(), last.minutes, last.pomodoros),
            ("2026-09-07", 30, 0)
        );
        let prev = &d.days[12];
        assert_eq!(
            (prev.date.as_str(), prev.minutes, prev.pomodoros),
            ("2026-09-06", 45, 2)
        );
        assert_eq!(d.streak_calendar.len(), 56);
        assert_eq!(d.streak_calendar[0].date, "2026-07-14");
        // 9/7、9/6 有完成任务;9/5 有已完成的复习任务;9/4 无
        assert!(
            d.streak_calendar[55].active
                && d.streak_calendar[54].active
                && d.streak_calendar[53].active
        );
        assert!(!d.streak_calendar[52].active);
        assert_eq!(d.weak_trend.len(), 14);
        assert_eq!((d.weak_trend[12].opened, d.weak_trend[12].fixed), (2, 0));
        assert_eq!((d.weak_trend[13].opened, d.weak_trend[13].fixed), (0, 1));
        let avg = d.avg_scores.unwrap();
        assert_eq!(
            (avg.accuracy, avg.completeness, avg.clarity, avg.samples),
            (4.0, 4.0, 4.0, 2)
        );
        assert_eq!(d.review_pass_rate, Some(2.0 / 3.0));
        assert!(matches!(
            detail(&conn, "bad"),
            Err(CoreError::InvalidInput(_))
        ));
    }

    #[test]
    fn detail_is_empty_safe_without_books() {
        let conn = crate::db::open_in_memory().unwrap();
        let d = detail(&conn, "2026-09-07").unwrap();
        assert!(d.books.is_empty());
        assert_eq!(d.days.len(), 14);
        assert!(d.days.iter().all(|x| x.minutes == 0 && x.pomodoros == 0));
        assert!(d.streak_calendar.iter().all(|x| !x.active));
        assert!(d.weak_trend.iter().all(|x| x.opened == 0 && x.fixed == 0));
        assert_eq!((d.avg_scores, d.review_pass_rate), (None, None));
    }

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
        // 番茄钟分钟与预估取较大者(主攻书范围)
        crate::pomodoro::record_minutes(&conn, "2026-09-06", Some(first), Some(1), 50).unwrap();
        crate::pomodoro::record_minutes(&conn, "2026-09-06", Some(second), None, 99).unwrap();
        assert_eq!(compute(&conn, "2026-09-06").unwrap().minutes_today, 50);
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
