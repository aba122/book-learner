//! 提醒线程(M2 T2):每 30s 用本地时间判定是否到点,经 tauri-plugin-notification 发系统通知。
//! 判定与幂等标记在 core `notify`(纯函数);本线程只做:取设置 → (晚间窗口内)取当日队列 pending 数 → 发通知 → 记标记。
//! 持一条长连接(避免每次 open_connection 触发迁移事务);日期/时刻取 `chrono::Local`,与前端 `localCalendarDate()` 一致。
use std::time::Duration;

use book_learner_core::notify::{self, Reminder};
use book_learner_core::{planning, settings, CoreError};
use rusqlite::Connection;
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_notification::NotificationExt;

use crate::state::AppState;

pub const POLL_INTERVAL: Duration = Duration::from_secs(30);

pub fn spawn_reminder_thread<R: Runtime>(app: AppHandle<R>) {
    let spawned = std::thread::Builder::new()
        .name("reminder".into())
        .spawn(move || {
            let connection = match app.state::<AppState>().open_connection() {
                Ok(connection) => connection,
                Err(error) => {
                    tracing::warn!(
                        internal_cause = error.internal_cause(),
                        "提醒线程无法打开数据库,已停用"
                    );
                    return;
                }
            };
            match app.notification().request_permission() {
                Ok(state) => tracing::info!(?state, "系统通知权限"),
                Err(error) => tracing::warn!(%error, "请求系统通知权限失败"),
            }
            loop {
                std::thread::sleep(POLL_INTERVAL);
                let now = chrono::Local::now();
                let date = now.format("%Y-%m-%d").to_string();
                let hm = now.format("%H:%M").to_string();
                if let Err(error) = tick(&app, &connection, &date, &hm) {
                    tracing::warn!(%error, "提醒检查失败");
                }
            }
        });
    if let Err(error) = spawned {
        tracing::warn!(%error, "提醒线程启动失败");
    }
}

fn tick<R: Runtime>(
    app: &AppHandle<R>,
    connection: &Connection,
    date: &str,
    hm: &str,
) -> book_learner_core::Result<()> {
    let settings = settings::get_settings(connection)?;
    let sent = notify::sent_marks(connection, date)?;
    // 只在晚间窗口内触碰当日队列(幂等生成),避免每 30s 扫表
    let pending = if notify::in_window(hm, &settings.evening_remind_time) {
        Some(
            planning::today_queue(connection, date)?
                .iter()
                .filter(|task| task.status == "pending")
                .count(),
        )
    } else {
        None
    };
    let Some(kind) = notify::decide(hm, &settings, pending, &sent)? else {
        return Ok(());
    };
    let (title, body) = match kind {
        Reminder::Daily => (
            "攻书 · 今日学习".to_string(),
            "今天的学习队列已经准备好了,来讲一块吧。".to_string(),
        ),
        Reminder::Evening => (
            "攻书 · 今天还没学完".to_string(),
            format!("还有 {} 项任务未完成,睡前再过一遍?", pending.unwrap_or(0)),
        ),
    };
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|error| CoreError::Other(format!("notification: {error}")))?;
    notify::mark_sent(connection, date, kind)?;
    tracing::info!(kind = kind.key(), date, "已发送系统通知");
    Ok(())
}
