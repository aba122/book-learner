//! 番茄钟状态机(M2 T3,TECH_DESIGN §10):纯状态机,时间由调用方以 unix 秒传入,不读系统时间;
//! 副作用(托盘标题、事件、通知)在壳层 ticker 线程内。专注分钟经 [`record_minutes`] 落 `study_minutes`
//! (`date` 来自前端本地日历日)。
use crate::{CoreError, Result};
use rusqlite::Connection;

#[derive(Debug, Clone, PartialEq, Eq)]
enum State {
    Idle,
    Work {
        started_at: i64,
        ends_at: i64,
    },
    Break {
        ends_at: i64,
    },
    /// 暂停时保留阶段与剩余秒;`worked_secs` 为暂停前已专注秒数(用于 stop 计分钟)
    Paused {
        was_work: bool,
        remaining_secs: i64,
        worked_secs: i64,
    },
}

/// 当前任务上下文(启动时给定,贯穿整个番茄)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Session {
    pub task_id: Option<i64>,
    pub book_id: Option<i64>,
    pub date: String,
}

/// 供前端/托盘渲染的快照(`ends_at` 为 unix 秒;暂停/空闲时为 None)。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Snapshot {
    /// idle | work | break | paused
    pub phase: String,
    pub task_id: Option<i64>,
    pub date: Option<String>,
    pub ends_at: Option<i64>,
    pub remaining_secs: i64,
    /// 暂停时所处阶段(work|break);其余为 None
    pub paused_phase: Option<String>,
}

/// 阶段变化事件;`WorkDone`/`Stopped` 携带应落库的专注分钟(0 分钟不落库)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Transition {
    WorkDone { minutes: i64 },
    BreakDone,
    Stopped { minutes: i64 },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Machine {
    state: State,
    session: Option<Session>,
    work_secs: i64,
    break_secs: i64,
}

impl Default for Machine {
    fn default() -> Self {
        Self {
            state: State::Idle,
            session: None,
            work_secs: 25 * 60,
            break_secs: 5 * 60,
        }
    }
}

impl Machine {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn is_idle(&self) -> bool {
        self.state == State::Idle
    }

    pub fn session(&self) -> Option<&Session> {
        self.session.as_ref()
    }

    /// 只能从空闲启动;`work_min`/`break_min` 来自设置(1..=180)。
    pub fn start(
        &mut self,
        session: Session,
        now: i64,
        work_min: i64,
        break_min: i64,
    ) -> Result<Snapshot> {
        if self.state != State::Idle {
            return Err(CoreError::Conflict(
                "a pomodoro is already running; stop it first".into(),
            ));
        }
        if !(1..=180).contains(&work_min) || !(1..=180).contains(&break_min) {
            return Err(CoreError::InvalidInput(
                "pomodoro minutes must be between 1 and 180".into(),
            ));
        }
        self.work_secs = work_min * 60;
        self.break_secs = break_min * 60;
        self.session = Some(session);
        self.state = State::Work {
            started_at: now,
            ends_at: now + self.work_secs,
        };
        Ok(self.snapshot(now))
    }

    /// 时钟推进:到点则切换阶段并返回事件;其余返回 None。
    pub fn tick(&mut self, now: i64) -> Option<Transition> {
        match self.state {
            State::Work { ends_at, .. } if now >= ends_at => {
                self.state = State::Break {
                    ends_at: now + self.break_secs,
                };
                Some(Transition::WorkDone {
                    minutes: self.work_secs / 60,
                })
            }
            State::Break { ends_at } if now >= ends_at => {
                self.state = State::Idle;
                self.session = None;
                Some(Transition::BreakDone)
            }
            _ => None,
        }
    }

    pub fn pause(&mut self, now: i64) -> Result<Snapshot> {
        self.state = match self.state {
            State::Work {
                started_at,
                ends_at,
            } => State::Paused {
                was_work: true,
                remaining_secs: (ends_at - now).max(0),
                worked_secs: (now - started_at).max(0),
            },
            State::Break { ends_at } => State::Paused {
                was_work: false,
                remaining_secs: (ends_at - now).max(0),
                worked_secs: self.work_secs,
            },
            _ => {
                return Err(CoreError::Conflict(
                    "nothing to pause: pomodoro is not running".into(),
                ))
            }
        };
        Ok(self.snapshot(now))
    }

    pub fn resume(&mut self, now: i64) -> Result<Snapshot> {
        self.state = match self.state {
            State::Paused {
                was_work: true,
                remaining_secs,
                worked_secs,
            } => State::Work {
                started_at: now - worked_secs,
                ends_at: now + remaining_secs,
            },
            State::Paused {
                was_work: false,
                remaining_secs,
                ..
            } => State::Break {
                ends_at: now + remaining_secs,
            },
            _ => {
                return Err(CoreError::Conflict(
                    "nothing to resume: pomodoro is not paused".into(),
                ))
            }
        };
        Ok(self.snapshot(now))
    }

    /// 手动结束:专注阶段按已过整分钟计;休息/暂停于休息阶段不再计分(WorkDone 时已计)。
    pub fn stop(&mut self, now: i64) -> Result<(Snapshot, Option<Transition>)> {
        let minutes = match self.state {
            State::Idle => {
                return Err(CoreError::Conflict(
                    "nothing to stop: pomodoro is idle".into(),
                ))
            }
            State::Work { started_at, .. } => (now - started_at).max(0) / 60,
            State::Paused {
                was_work: true,
                worked_secs,
                ..
            } => worked_secs / 60,
            State::Break { .. } | State::Paused { .. } => 0,
        };
        self.state = State::Idle;
        self.session = None;
        let transition = (minutes > 0).then_some(Transition::Stopped { minutes });
        Ok((self.snapshot(now), transition))
    }

    pub fn snapshot(&self, now: i64) -> Snapshot {
        let (phase, ends_at, remaining, paused_phase) = match &self.state {
            State::Idle => ("idle", None, 0, None),
            State::Work { ends_at, .. } => ("work", Some(*ends_at), (ends_at - now).max(0), None),
            State::Break { ends_at } => ("break", Some(*ends_at), (ends_at - now).max(0), None),
            State::Paused {
                was_work,
                remaining_secs,
                ..
            } => (
                "paused",
                None,
                *remaining_secs,
                Some(if *was_work { "work" } else { "break" }),
            ),
        };
        Snapshot {
            phase: phase.into(),
            task_id: self.session.as_ref().and_then(|s| s.task_id),
            date: self.session.as_ref().map(|s| s.date.clone()),
            ends_at,
            remaining_secs: remaining,
            paused_phase: paused_phase.map(str::to_string),
        }
    }
}

/// 专注分钟落库(`study_minutes`,source=pomodoro);0 分钟直接忽略。
pub fn record_minutes(
    conn: &Connection,
    date: &str,
    book_id: Option<i64>,
    task_id: Option<i64>,
    minutes: i64,
) -> Result<()> {
    if minutes <= 0 {
        return Ok(());
    }
    conn.execute(
        "INSERT INTO study_minutes(date,book_id,task_id,minutes,source,created_at) \
         VALUES(?1,?2,?3,?4,'pomodoro',?5)",
        rusqlite::params![
            date,
            book_id,
            task_id,
            minutes,
            chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
        ],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session() -> Session {
        Session {
            task_id: Some(7),
            book_id: Some(1),
            date: "2026-09-08".into(),
        }
    }

    #[test]
    fn work_break_cycle_reports_transitions_and_snapshots() {
        let mut m = Machine::new();
        assert!(m.is_idle());
        let snap = m.start(session(), 1_000, 25, 5).unwrap();
        assert_eq!(
            (
                snap.phase.as_str(),
                snap.ends_at,
                snap.remaining_secs,
                snap.task_id
            ),
            ("work", Some(1_000 + 1500), 1500, Some(7))
        );
        assert!(matches!(
            m.start(session(), 1_001, 25, 5),
            Err(CoreError::Conflict(_))
        ));
        assert_eq!(m.tick(1_000 + 1499), None);
        assert_eq!(
            m.tick(1_000 + 1500),
            Some(Transition::WorkDone { minutes: 25 })
        );
        let snap = m.snapshot(1_000 + 1500);
        assert_eq!((snap.phase.as_str(), snap.remaining_secs), ("break", 300));
        assert_eq!(m.tick(1_000 + 1500 + 299), None);
        assert_eq!(m.tick(1_000 + 1500 + 300), Some(Transition::BreakDone));
        assert!(m.is_idle());
        assert_eq!(m.snapshot(9_999).task_id, None);
        assert!(matches!(m.stop(1), Err(CoreError::Conflict(_))));
        assert!(matches!(
            Machine::new().start(session(), 0, 0, 5),
            Err(CoreError::InvalidInput(_))
        ));
    }

    #[test]
    fn pause_resume_keep_remaining_and_stop_counts_whole_minutes() {
        let mut m = Machine::new();
        m.start(session(), 0, 25, 5).unwrap();
        let snap = m.pause(130).unwrap(); // 专注 2 分 10 秒后暂停
        assert_eq!(
            (
                snap.phase.as_str(),
                snap.paused_phase.as_deref(),
                snap.remaining_secs,
                snap.ends_at
            ),
            ("paused", Some("work"), 1500 - 130, None)
        );
        assert_eq!(m.tick(10_000), None, "paused: no transition however late");
        let snap = m.resume(1_000).unwrap();
        assert_eq!(
            (snap.phase.as_str(), snap.ends_at),
            ("work", Some(1_000 + 1500 - 130))
        );
        assert!(matches!(m.resume(1_001), Err(CoreError::Conflict(_))));
        // 再专注 70 秒后结束:累计 200 秒 → 3 分钟
        let (snap, transition) = m.stop(1_070).unwrap();
        assert_eq!(snap.phase, "idle");
        assert_eq!(transition, Some(Transition::Stopped { minutes: 3 }));
        // 休息阶段结束不再计分
        let mut m = Machine::new();
        m.start(session(), 0, 1, 1).unwrap();
        assert_eq!(m.tick(60), Some(Transition::WorkDone { minutes: 1 }));
        let (_, transition) = m.stop(70).unwrap();
        assert_eq!(transition, None);
        // 不足 1 分钟的专注不落库
        let mut m = Machine::new();
        m.start(session(), 0, 25, 5).unwrap();
        assert_eq!(m.stop(59).unwrap().1, None);
        assert!(matches!(
            Machine::new().pause(0),
            Err(CoreError::Conflict(_))
        ));
    }

    #[test]
    fn record_minutes_persists_rows_and_ignores_zero() {
        let conn = crate::db::open_in_memory().unwrap();
        record_minutes(&conn, "2026-09-08", None, None, 0).unwrap();
        record_minutes(&conn, "2026-09-08", None, None, 25).unwrap();
        record_minutes(&conn, "2026-09-08", None, None, 3).unwrap();
        let (rows, total): (i64, i64) = conn
            .query_row(
                "SELECT count(*), COALESCE(sum(minutes),0) FROM study_minutes WHERE date='2026-09-08'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!((rows, total), (2, 28));
    }
}
