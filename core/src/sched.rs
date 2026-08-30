use rusqlite::Connection;
use crate::Result;

#[derive(Debug, Clone)]
pub struct DailyTask {
    pub id: i64,
    pub book_id: i64,
    pub block_id: i64,
    pub kind: String,
    pub seq: i64,
    pub status: String,
    pub est_minutes: i64,
    pub ref_id: Option<i64>,
}

const WEAK_RETEST_DAILY_LIMIT: i64 = 3; // PRODUCT_SPEC §5

fn list_daily(conn: &Connection, date: &str) -> Result<Vec<DailyTask>> {
    let mut st = conn.prepare(
        "SELECT id,book_id,block_id,kind,seq,status,est_minutes,ref_id \
         FROM daily_task WHERE date=?1 ORDER BY seq")?;
    let rows = st.query_map([date], |r| Ok(DailyTask {
        id: r.get(0)?, book_id: r.get(1)?, block_id: r.get(2)?, kind: r.get(3)?,
        seq: r.get(4)?, status: r.get(5)?, est_minutes: r.get(6)?, ref_id: r.get(7)?,
    }))?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// 生成某日队列(幂等):薄弱点重考(≤3)→ 到期复习 → 新块配额。PRODUCT_SPEC §5。
pub fn generate_daily(conn: &Connection, date: &str) -> Result<Vec<DailyTask>> {
    let existing = list_daily(conn, date)?;
    if !existing.is_empty() { return Ok(existing); }

    let tx = conn.unchecked_transaction()?;
    let mut seq = 0i64;
    let mut insert = |book_id: i64, block_id: i64, kind: &str, est: i64, ref_id: Option<i64>|
        -> Result<()> {
        seq += 1;
        tx.execute(
            "INSERT INTO daily_task(date,book_id,block_id,kind,seq,est_minutes,ref_id) \
             VALUES(?1,?2,?3,?4,?5,?6,?7)",
            rusqlite::params![date, book_id, block_id, kind, seq, est, ref_id])?;
        Ok(())
    };

    // 1) 薄弱点重考(按 created_at,上限 3)
    {
        let mut st = tx.prepare(
            "SELECT w.id, w.block_id, kb.book_id FROM weak_point w \
             JOIN knowledge_block kb ON kb.id = w.block_id \
             WHERE w.status='open' ORDER BY w.created_at LIMIT ?1")?;
        let rows: Vec<(i64, i64, i64)> = st.query_map([WEAK_RETEST_DAILY_LIMIT],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
            .collect::<rusqlite::Result<_>>()?;
        for (wid, block_id, book_id) in rows { insert(book_id, block_id, "weak_retest", 10, Some(wid))?; }
    }
    // 2) 到期间隔复习
    {
        let mut st = tx.prepare(
            "SELECT rs.id, rs.block_id, kb.book_id FROM review_schedule rs \
             JOIN knowledge_block kb ON kb.id = rs.block_id \
             WHERE rs.status='due' AND rs.due_date<=?1 ORDER BY rs.due_date")?;
        let rows: Vec<(i64, i64, i64)> = st.query_map([date],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
            .collect::<rusqlite::Result<_>>()?;
        for (rid, block_id, book_id) in rows { insert(book_id, block_id, "review", 5, Some(rid))?; }
    }
    // 3) 新块(活跃计划配额)
    {
        let plan: Option<(i64, i64)> = tx.query_row(
            "SELECT book_id, daily_new_blocks FROM study_plan WHERE active=1 LIMIT 1",
            [], |r| Ok((r.get(0)?, r.get(1)?))).map(Some).or_else(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => Ok(None), e => Err(e) })?;
        if let Some((book_id, quota)) = plan {
            for blk in crate::models::next_new_blocks(&tx, book_id, quota as usize)? {
                insert(book_id, blk.id, "new", 30, None)?;
            }
        }
    }
    drop(insert);
    tx.commit()?;
    list_daily(conn, date)
}


fn add_days(date: &str, days: i64) -> Result<String> {
    use chrono::NaiveDate;
    let d = NaiveDate::parse_from_str(date, "%Y-%m-%d")
        .map_err(|e| crate::CoreError::Other(format!("bad date {date}: {e}")))?;
    Ok((d + chrono::Duration::days(days)).format("%Y-%m-%d").to_string())
}

/// 块通过:置 passed/passed_at 并排 stage1 复习(幂等)。
pub fn on_block_passed(conn: &Connection, block_id: i64, date: &str) -> Result<()> {
    conn.execute("UPDATE knowledge_block SET status='passed', passed_at=?2 \
                  WHERE id=?1 AND status NOT IN ('consolidated')",
        rusqlite::params![block_id, date])?;
    let existing: i64 = conn.query_row(
        "SELECT count(*) FROM review_schedule WHERE block_id=?1", [block_id], |r| r.get(0))?;
    if existing == 0 {
        conn.execute("INSERT INTO review_schedule(block_id,stage,due_date) VALUES(?1,1,?2)",
            rusqlite::params![block_id, add_days(date, 1)?])?;
    }
    Ok(())
}

/// 复习结果:pass → 下一档(due=结果日期+下一档天数),14 档通过 → consolidated;
/// fail → 生成薄弱点并重置回 1 天档。PRODUCT_SPEC §5。
pub fn on_review_result(conn: &Connection, sched_id: i64, pass: bool, date: &str) -> Result<()> {
    let (block_id, stage): (i64, i64) = conn.query_row(
        "SELECT block_id,stage FROM review_schedule WHERE id=?1", [sched_id],
        |r| Ok((r.get(0)?, r.get(1)?)))?;
    if pass {
        conn.execute("UPDATE review_schedule SET status='done' WHERE id=?1", [sched_id])?;
        match stage {
            1 | 3 | 7 => {
                let next = match stage { 1 => 3, 3 => 7, _ => 14 };
                conn.execute("INSERT INTO review_schedule(block_id,stage,due_date) VALUES(?1,?2,?3)",
                    rusqlite::params![block_id, next, add_days(date, next)?])?;
            }
            _ => {
                conn.execute("UPDATE knowledge_block SET status='consolidated' WHERE id=?1", [block_id])?;
            }
        }
    } else {
        conn.execute("UPDATE review_schedule SET status='failed' WHERE id=?1", [sched_id])?;
        conn.execute("INSERT INTO weak_point(block_id,title,detail,created_at) \
                      VALUES(?1,'间隔复习未通过','复习快问未答出,需重考',?2)",
            rusqlite::params![block_id, date])?;
        conn.execute("INSERT INTO review_schedule(block_id,stage,due_date) VALUES(?1,1,?2)",
            rusqlite::params![block_id, add_days(date, 1)?])?;
    }
    Ok(())
}

/// 薄弱点重考:连续 2 次通过置 fixed;失败清零。PRODUCT_SPEC §5。
pub fn on_weak_retest(conn: &Connection, weak_id: i64, pass: bool, date: &str) -> Result<()> {
    if pass {
        conn.execute("UPDATE weak_point SET pass_streak=pass_streak+1 WHERE id=?1", [weak_id])?;
        conn.execute("UPDATE weak_point SET status='fixed', fixed_at=?2 \
                      WHERE id=?1 AND pass_streak>=2",
            rusqlite::params![weak_id, date])?;
    } else {
        conn.execute("UPDATE weak_point SET pass_streak=0 WHERE id=?1", [weak_id])?;
    }
    Ok(())
}

/// 评估落库唯一入口(TECH_DESIGN §3.3 的 SQLite 半边)。
pub fn apply_eval_to_db(conn: &Connection, block_id: i64,
                        eval: &crate::eval::EvalResult, date: &str) -> Result<()> {
    use crate::eval::Verdict;
    let tx = conn.unchecked_transaction()?;
    tx.execute("UPDATE knowledge_block SET scores_json=?2 WHERE id=?1",
        rusqlite::params![block_id, serde_json::to_string(&eval.scores).unwrap()])?;
    for wp in eval.weak_points.iter().filter(|w| !w.fixed_in_session) {
        tx.execute("INSERT INTO weak_point(block_id,title,detail,anchor_json,created_at) \
                    VALUES(?1,?2,?3,?4,?5)",
            rusqlite::params![block_id, wp.title, wp.detail,
                wp.anchor.as_ref().map(|a| serde_json::to_string(a).unwrap()), date])?;
    }
    match eval.verdict {
        Verdict::PassSuggested => on_block_passed(&tx, block_id, date)?,
        Verdict::RelearnSuggested => {
            tx.execute("UPDATE knowledge_block SET status='learning' WHERE id=?1", [block_id])?;
        }
    }
    tx.commit()?;
    Ok(())
}

/// 薄弱点镜像查询辅助:(open, fixed),元组 (块标题, 薄弱点标题, 日期)。供 sync_weakpoints 与 Mac 壳复用。
#[allow(clippy::type_complexity)]
pub fn list_weakpoints(conn: &Connection, book_id: i64)
    -> Result<(Vec<(String, String, String)>, Vec<(String, String, String)>)> {
    let mut st = conn.prepare(
        "SELECT kb.title, w.title, w.created_at, w.status FROM weak_point w \
         JOIN knowledge_block kb ON kb.id = w.block_id \
         WHERE kb.book_id=?1 ORDER BY w.created_at")?;
    let rows: Vec<(String, String, String, String)> = st.query_map([book_id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let (mut open, mut fixed) = (vec![], vec![]);
    for (bt, wt, d, status) in rows {
        if status == "fixed" { fixed.push((bt, wt, d)); } else { open.push((bt, wt, d)); }
    }
    Ok((open, fixed))
}


#[derive(Debug, PartialEq)]
pub enum Replan {
    OnTrack,
    AutoAdjusted { new_daily: i64 },
    NeedsDecision { required_daily: i64, cap: i64 },
}

/// 落后检测与重排(PRODUCT_SPEC §6):最近 2 个有 new 任务的日期其 new 任务均未完成 → 落后;
/// required = ceil(剩余未学块 / 剩余天数);≤cap 自动改 daily_new_blocks,>cap 交上层确认(截止日不动)。
pub fn check_behind(conn: &Connection, book_id: i64, today: &str) -> Result<Replan> {
    let days: Vec<String> = {
        let mut st = conn.prepare(
            "SELECT DISTINCT date FROM daily_task \
             WHERE book_id=?1 AND kind='new' AND date<?2 ORDER BY date DESC LIMIT 2")?;
        let rows = st.query_map(rusqlite::params![book_id, today], |r| r.get(0))?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    if days.len() < 2 { return Ok(Replan::OnTrack); }
    for d in &days {
        let undone: i64 = conn.query_row(
            "SELECT count(*) FROM daily_task \
             WHERE book_id=?1 AND kind='new' AND date=?2 AND status!='done'",
            rusqlite::params![book_id, d], |r| r.get(0))?;
        if undone == 0 { return Ok(Replan::OnTrack); }
    }

    let remaining: i64 = conn.query_row(
        "SELECT count(*) FROM knowledge_block \
         WHERE book_id=?1 AND status='unlearned' AND skipped=0", [book_id], |r| r.get(0))?;
    let (deadline, cap): (String, i64) = conn.query_row(
        "SELECT deadline, daily_cap FROM study_plan WHERE book_id=?1 AND active=1",
        [book_id], |r| Ok((r.get(0)?, r.get(1)?)))?;
    use chrono::NaiveDate;
    let d_today = NaiveDate::parse_from_str(today, "%Y-%m-%d")
        .map_err(|e| crate::CoreError::Other(e.to_string()))?;
    let d_end = NaiveDate::parse_from_str(&deadline, "%Y-%m-%d")
        .map_err(|e| crate::CoreError::Other(e.to_string()))?;
    let days_left = ((d_end - d_today).num_days() + 1).max(1); // 含今天
    let required = (remaining + days_left - 1) / days_left;
    if required > cap {
        Ok(Replan::NeedsDecision { required_daily: required, cap })
    } else {
        conn.execute("UPDATE study_plan SET daily_new_blocks=?2 WHERE book_id=?1 AND active=1",
            rusqlite::params![book_id, required.max(1)])?;
        Ok(Replan::AutoAdjusted { new_daily: required.max(1) })
    }
}

#[cfg(test)]
mod tests {
    fn setup() -> (rusqlite::Connection, i64) {
        let conn = crate::db::open_in_memory().unwrap();
        let b = crate::models::insert_book(&conn, "书", "", crate::models::BookType::Textbook, "bk").unwrap();
        for i in 1..=6 {
            crate::models::insert_block(&conn, b, "m", i, &format!("块{i}"), &format!("b{i}"), &[]).unwrap();
        }
        conn.execute("INSERT INTO study_plan(book_id,deadline,daily_new_blocks) VALUES(?1,'2026-09-30',2)", [b]).unwrap();
        (conn, b)
    }

    #[test]
    fn daily_queue_orders_weak_then_review_then_new() {
        let (conn, b) = setup();
        for i in 0..4 {
            conn.execute("INSERT INTO weak_point(block_id,title,created_at) VALUES(1,?1,?2)",
                rusqlite::params![format!("wp{i}"), format!("2026-08-2{i}")]).unwrap();
        }
        conn.execute("INSERT INTO review_schedule(block_id,stage,due_date) VALUES(2,1,'2026-08-30')", []).unwrap();
        let q = super::generate_daily(&conn, "2026-08-30").unwrap();
        let kinds: Vec<_> = q.iter().map(|t| t.kind.clone()).collect();
        assert_eq!(kinds, ["weak_retest","weak_retest","weak_retest","review","new","new"]);
        let _ = b;
    }
    #[test]
    fn generate_daily_is_idempotent() {
        let (conn, _) = setup();
        assert_eq!(super::generate_daily(&conn, "2026-08-30").unwrap().len(),
                   super::generate_daily(&conn, "2026-08-30").unwrap().len());
        let n: i64 = conn.query_row("SELECT count(*) FROM daily_task WHERE date='2026-08-30'", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 2);
    }
    #[test]
    fn block_pass_schedules_stage1_review() {
        let (conn, _) = setup();
        super::on_block_passed(&conn, 1, "2026-08-30").unwrap();
        super::on_block_passed(&conn, 1, "2026-08-30").unwrap(); // 幂等
        let (stage, due): (i64, String) = conn.query_row(
            "SELECT stage,due_date FROM review_schedule WHERE block_id=1", [],
            |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!((stage, due.as_str()), (1, "2026-08-31"));
        let n: i64 = conn.query_row("SELECT count(*) FROM review_schedule WHERE block_id=1", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
        let st: String = conn.query_row("SELECT status FROM knowledge_block WHERE id=1", [], |r| r.get(0)).unwrap();
        assert_eq!(st, "passed");
    }
    #[test]
    fn review_pass_advances_and_consolidates() {
        let (conn, _) = setup();
        super::on_block_passed(&conn, 1, "2026-08-30").unwrap();
        for (day, expect_next) in [("2026-08-31", 3i64), ("2026-09-03", 7), ("2026-09-10", 14)] {
            let id: i64 = conn.query_row("SELECT id FROM review_schedule WHERE block_id=1 AND status='due'", [], |r| r.get(0)).unwrap();
            super::on_review_result(&conn, id, true, day).unwrap();
            let next: i64 = conn.query_row("SELECT stage FROM review_schedule WHERE block_id=1 AND status='due'", [], |r| r.get(0)).unwrap();
            assert_eq!(next, expect_next);
        }
        let id: i64 = conn.query_row("SELECT id FROM review_schedule WHERE block_id=1 AND status='due'", [], |r| r.get(0)).unwrap();
        super::on_review_result(&conn, id, true, "2026-09-24").unwrap();
        let st: String = conn.query_row("SELECT status FROM knowledge_block WHERE id=1", [], |r| r.get(0)).unwrap();
        assert_eq!(st, "consolidated");
        let due_left: i64 = conn.query_row("SELECT count(*) FROM review_schedule WHERE block_id=1 AND status='due'", [], |r| r.get(0)).unwrap();
        assert_eq!(due_left, 0);
    }
    #[test]
    fn review_fail_resets_and_creates_weakpoint() {
        let (conn, _) = setup();
        super::on_block_passed(&conn, 1, "2026-08-30").unwrap();
        let id: i64 = conn.query_row("SELECT id FROM review_schedule WHERE block_id=1", [], |r| r.get(0)).unwrap();
        super::on_review_result(&conn, id, false, "2026-08-31").unwrap();
        let (stage, due): (i64, String) = conn.query_row(
            "SELECT stage,due_date FROM review_schedule WHERE block_id=1 AND status='due'", [],
            |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!((stage, due.as_str()), (1, "2026-09-01"));
        let n: i64 = conn.query_row("SELECT count(*) FROM weak_point WHERE block_id=1 AND status='open'", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
    }
    #[test]
    fn apply_eval_to_db_persists_status_scores_weakpoints_and_schedules() {
        let (conn, _) = setup();
        let e: crate::eval::EvalResult = serde_json::from_str(r#"{
            "verdict":"pass_suggested","scores":{"accuracy":4,"completeness":3,"clarity":5},
            "summary":"s","final_restatement":"r","weak_points":[
              {"title":"未修复点","detail":"d"},
              {"title":"已当场修复","detail":"d","fixed_in_session":true}]}"#).unwrap();
        super::apply_eval_to_db(&conn, 1, &e, "2026-08-30").unwrap();
        let (st, passed_at, scores): (String, Option<String>, Option<String>) = conn.query_row(
            "SELECT status,passed_at,scores_json FROM knowledge_block WHERE id=1", [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap();
        assert_eq!(st, "passed");
        assert_eq!(passed_at.as_deref(), Some("2026-08-30"));
        assert!(scores.unwrap().contains("\"accuracy\":4"));
        let n: i64 = conn.query_row("SELECT count(*) FROM weak_point WHERE block_id=1 AND status='open'",
            [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
        let n2: i64 = conn.query_row("SELECT count(*) FROM review_schedule WHERE block_id=1 AND stage=1",
            [], |r| r.get(0)).unwrap();
        assert_eq!(n2, 1);
    }
    #[test]
    fn apply_eval_to_db_relearn_keeps_unpassed() {
        let (conn, _) = setup();
        let e: crate::eval::EvalResult = serde_json::from_str(r#"{
            "verdict":"relearn_suggested","scores":{"accuracy":2,"completeness":2,"clarity":3},
            "summary":"s","final_restatement":"r"}"#).unwrap();
        super::apply_eval_to_db(&conn, 1, &e, "2026-08-30").unwrap();
        let st: String = conn.query_row("SELECT status FROM knowledge_block WHERE id=1", [], |r| r.get(0)).unwrap();
        assert_eq!(st, "learning");
        let n: i64 = conn.query_row("SELECT count(*) FROM review_schedule", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0);
    }
    #[test]
    fn weak_retest_two_passes_fixes() {
        let (conn, _) = setup();
        conn.execute("INSERT INTO weak_point(block_id,title,created_at) VALUES(1,'w','2026-08-29')", []).unwrap();
        super::on_weak_retest(&conn, 1, true, "2026-08-30").unwrap();
        super::on_weak_retest(&conn, 1, true, "2026-08-31").unwrap();
        let st: String = conn.query_row("SELECT status FROM weak_point WHERE id=1", [], |r| r.get(0)).unwrap();
        assert_eq!(st, "fixed");
    }
    #[test]
    fn weak_retest_fail_resets_streak() {
        let (conn, _) = setup();
        conn.execute("INSERT INTO weak_point(block_id,title,created_at) VALUES(1,'w','2026-08-29')", []).unwrap();
        super::on_weak_retest(&conn, 1, true, "2026-08-30").unwrap();
        super::on_weak_retest(&conn, 1, false, "2026-08-31").unwrap();
        let (st, streak): (String, i64) = conn.query_row(
            "SELECT status,pass_streak FROM weak_point WHERE id=1", [],
            |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!((st.as_str(), streak), ("open", 0));
    }
    #[test]
    fn behind_two_days_triggers_replan() {
        let (conn, b) = setup();
        for d in ["2026-08-28", "2026-08-29"] {
            conn.execute("INSERT INTO daily_task(date,book_id,block_id,kind,seq) VALUES(?1,?2,1,'new',1)",
                rusqlite::params![d, b]).unwrap();
        }
        match super::check_behind(&conn, b, "2026-08-30").unwrap() {
            super::Replan::AutoAdjusted { new_daily } => assert!(new_daily >= 1),
            other => panic!("expect AutoAdjusted, got {other:?}"),
        }
        let updated: i64 = conn.query_row("SELECT daily_new_blocks FROM study_plan WHERE book_id=?1",
            [b], |r| r.get(0)).unwrap();
        assert!(updated >= 1);
    }
    #[test]
    fn replan_over_cap_needs_decision() {
        let (conn, b) = setup();
        conn.execute("UPDATE study_plan SET deadline='2026-08-30'", []).unwrap(); // 截止=今天:剩1天6块
        for d in ["2026-08-28", "2026-08-29"] {
            conn.execute("INSERT INTO daily_task(date,book_id,block_id,kind,seq) VALUES(?1,?2,1,'new',1)",
                rusqlite::params![d, b]).unwrap();
        }
        assert!(matches!(super::check_behind(&conn, b, "2026-08-30").unwrap(),
            super::Replan::NeedsDecision { required_daily: 6, cap: 4 }));
        let deadline: String = conn.query_row("SELECT deadline FROM study_plan WHERE book_id=?1",
            [b], |r| r.get(0)).unwrap();
        assert_eq!(deadline, "2026-08-30"); // 截止日不被静默修改
    }
    #[test]
    fn on_track_returns_ok() {
        let (conn, b) = setup();
        assert!(matches!(super::check_behind(&conn, b, "2026-08-30").unwrap(), super::Replan::OnTrack));
    }
}
