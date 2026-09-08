//! 番茄钟壳层(M2 T3):命令只改状态机并落分钟;ticker 线程每 1s `tick(now)`,阶段变化时
//! 落分钟、发事件 `pomodoro_changed{snapshot}`、发系统通知,并把托盘标题更新为倒计时。
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use book_learner_core::pomodoro::{Session, Transition};
use book_learner_core::{pomodoro, settings};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_notification::NotificationExt;

use crate::dto::PomodoroSnapshotDto;
use crate::error::IpcError;
use crate::state::AppState;

/// 与 web/src/backend/tauri.ts 的 POMODORO_CHANGED_EVENT 一致。
pub const POMODORO_CHANGED_EVENT: &str = "pomodoro_changed";
pub const TICK_INTERVAL: Duration = Duration::from_secs(1);

pub fn unix_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn lock_error() -> IpcError {
    IpcError::internal("pomodoro mutex poisoned")
}

/// 启动:任务所属书作为分钟归属;分钟数取设置。
pub fn start(state: &AppState, task_id: i64, date: &str) -> Result<PomodoroSnapshotDto, IpcError> {
    book_learner_core::orchestrate::validate_request_id(date)
        .ok()
        .filter(|_| date.len() == 10)
        .ok_or_else(|| IpcError::invalid_request("日期格式无效", format!("date {date:?}")))?;
    let (book_id, work, brk) = state.with_connection(|connection| {
        let book_id: Option<i64> = connection
            .query_row(
                "SELECT book_id FROM daily_task WHERE id=?1",
                [task_id],
                |r| r.get(0),
            )
            .ok();
        let settings = settings::get_settings(connection)?;
        Ok((book_id, settings.pomodoro_minutes, settings.break_minutes))
    })?;
    let mut machine = state.pomodoro().lock().map_err(|_| lock_error())?;
    let snapshot = machine.start(
        Session {
            task_id: Some(task_id),
            book_id,
            date: date.to_string(),
        },
        unix_now(),
        work,
        brk,
    )?;
    Ok(snapshot.into())
}

pub fn pause(state: &AppState) -> Result<PomodoroSnapshotDto, IpcError> {
    let mut machine = state.pomodoro().lock().map_err(|_| lock_error())?;
    Ok(machine.pause(unix_now())?.into())
}

pub fn resume(state: &AppState) -> Result<PomodoroSnapshotDto, IpcError> {
    let mut machine = state.pomodoro().lock().map_err(|_| lock_error())?;
    Ok(machine.resume(unix_now())?.into())
}

/// 结束:锁内只改状态,落分钟在锁外。
pub fn stop(state: &AppState) -> Result<PomodoroSnapshotDto, IpcError> {
    let (snapshot, transition, session) = {
        let mut machine = state.pomodoro().lock().map_err(|_| lock_error())?;
        let session = machine.session().cloned();
        let (snapshot, transition) = machine.stop(unix_now())?;
        (snapshot, transition, session)
    };
    if let (Some(Transition::Stopped { minutes }), Some(session)) = (transition, session) {
        state.with_connection(|connection| {
            pomodoro::record_minutes(
                connection,
                &session.date,
                session.book_id,
                session.task_id,
                minutes,
            )
        })?;
    }
    Ok(snapshot.into())
}

pub fn snapshot(state: &AppState) -> Result<PomodoroSnapshotDto, IpcError> {
    let machine = state.pomodoro().lock().map_err(|_| lock_error())?;
    Ok(machine.snapshot(unix_now()).into())
}

fn tray_title(snapshot: &PomodoroSnapshotDto) -> Option<String> {
    let mark = match snapshot.phase.as_str() {
        "work" => "●",
        "break" => "○",
        "paused" => "‖",
        _ => return None,
    };
    let secs = snapshot.remaining_secs.max(0);
    Some(format!("{mark}{:02}:{:02}", secs / 60, secs % 60))
}

/// 每秒推进状态机:阶段变化 → 落分钟 + 事件 + 通知;每秒 → 托盘标题(只在文本变化时写)。
pub fn spawn_ticker<R: Runtime>(app: AppHandle<R>) {
    let spawned = std::thread::Builder::new()
        .name("pomodoro-ticker".into())
        .spawn(move || {
            let mut last_title: Option<String> = None;
            loop {
                std::thread::sleep(TICK_INTERVAL);
                let state = app.state::<AppState>();
                let now = unix_now();
                let (transition, session, snapshot) = {
                    let Ok(mut machine) = state.pomodoro().lock() else {
                        continue;
                    };
                    let session = machine.session().cloned();
                    let transition = machine.tick(now);
                    (
                        transition,
                        session,
                        PomodoroSnapshotDto::from(machine.snapshot(now)),
                    )
                };
                if let Some(transition) = transition {
                    if let (Transition::WorkDone { minutes }, Some(session)) =
                        (&transition, &session)
                    {
                        if let Err(error) = state.with_connection(|connection| {
                            pomodoro::record_minutes(
                                connection,
                                &session.date,
                                session.book_id,
                                session.task_id,
                                *minutes,
                            )
                        }) {
                            tracing::warn!(
                                internal_cause = error.internal_cause(),
                                "番茄钟分钟落库失败"
                            );
                        }
                    }
                    let (title, body) = match transition {
                        Transition::WorkDone { minutes } => (
                            "专注结束".to_string(),
                            format!("已专注 {minutes} 分钟,休息一下。"),
                        ),
                        Transition::BreakDone => {
                            ("休息结束".to_string(), "回到下一块吧。".to_string())
                        }
                        Transition::Stopped { .. } => ("番茄钟已结束".to_string(), String::new()),
                    };
                    if let Err(error) = app.notification().builder().title(title).body(body).show()
                    {
                        tracing::warn!(%error, "番茄钟通知发送失败");
                    }
                    if let Err(error) = app.emit(POMODORO_CHANGED_EVENT, &snapshot) {
                        tracing::warn!(%error, "pomodoro_changed 事件发送失败");
                    }
                }
                let title = tray_title(&snapshot);
                if title != last_title {
                    if let Some(tray) = app.tray_by_id("main") {
                        let _ = tray.set_title(title.as_deref());
                    }
                    crate::automation::record_tray_title(title.as_deref());
                    last_title = title;
                }
            }
        });
    if let Err(error) = spawned {
        tracing::warn!(%error, "番茄钟 ticker 启动失败");
    }
}

/// 退出前:结束进行中的番茄并落分钟(用于 orderly_shutdown)。
pub fn stop_for_shutdown(state: &AppState) {
    match stop(state) {
        Ok(_) => tracing::info!("退出前番茄钟已结束并落分钟"),
        Err(error) if error.code == crate::error::ErrorCode::Conflict => {}
        Err(error) => tracing::warn!(
            internal_cause = error.internal_cause(),
            "退出前结束番茄钟失败"
        ),
    }
}
