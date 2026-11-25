//! 书摘整理线程(BL-034,设计 `docs/design/2026-11-25-excerpt-cards.md` §5):
//! 逐本跑 `excerpt_job` 里未完成的作业(queued/reading/selecting——上次退出时没跑完的也在里面),
//! 没有作业时等命令唤醒或 60 s。AI 调用在 core 里幂等、断点在库里,所以不登记慢命令计数,退出也不等它。
use std::collections::HashSet;
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use book_learner_core::excerpt;
use rusqlite::Connection;
use tauri::{AppHandle, Manager, Runtime};

use crate::state::AppState;

/// 启动后先让出 15 s(投影恢复、问书补提炼先跑)
pub const START_DELAY: Duration = Duration::from_secs(15);
/// 没有作业时最长等这么久再查一次(唤醒丢了也能接上)
pub const IDLE_POLL: Duration = Duration::from_secs(60);

/// 唤醒通道(由 `register_commands` 托管;线程在 setup 里 `spawn`,测试里不起线程,`poke` 什么也不做)
#[derive(Default)]
pub struct ExcerptWorker {
    wake: Mutex<Option<Sender<()>>>,
}

impl ExcerptWorker {
    /// 唤醒整理线程;线程没起来时忽略(作业留在库里,下次启动接着跑)
    pub fn poke(&self) {
        if let Ok(guard) = self.wake.lock() {
            if let Some(tx) = guard.as_ref() {
                let _ = tx.send(());
            }
        }
    }

    /// 装上唤醒通道;已装过返回 None(防止重复起线程)
    fn install(&self) -> Option<Receiver<()>> {
        let mut guard = self.wake.lock().ok()?;
        if guard.is_some() {
            return None;
        }
        let (tx, rx) = channel();
        *guard = Some(tx);
        Some(rx)
    }
}

pub fn spawn<R: Runtime>(app: AppHandle<R>) {
    let Some(rx) = app.state::<ExcerptWorker>().install() else {
        return;
    };
    let spawned = std::thread::Builder::new()
        .name("excerpt-worker".into())
        .spawn(move || {
            std::thread::sleep(START_DELAY);
            let state = app.state::<AppState>();
            let connection = match state.open_connection() {
                Ok(connection) => connection,
                Err(error) => {
                    tracing::warn!(
                        internal_cause = error.internal_cause(),
                        "书摘整理线程无法打开数据库,已停用"
                    );
                    return;
                }
            };
            loop {
                drain(&state, &connection);
                match rx.recv_timeout(IDLE_POLL) {
                    Ok(()) | Err(RecvTimeoutError::Timeout) => {}
                    Err(RecvTimeoutError::Disconnected) => return,
                }
                // 合并积压的唤醒
                while rx.try_recv().is_ok() {}
            }
        });
    if let Err(error) = spawned {
        tracing::warn!(%error, "书摘整理线程启动失败");
    }
}

/// 跑完当前所有未完成作业;同一轮里同一本书只试一次(防止读库异常时原地打转)
pub fn drain(state: &AppState, connection: &Connection) {
    let mut tried = HashSet::new();
    loop {
        let book_id = match excerpt::next_job(connection) {
            Ok(Some(book_id)) => book_id,
            Ok(None) => return,
            Err(error) => {
                tracing::warn!(%error, "读取书摘作业失败");
                return;
            }
        };
        if !tried.insert(book_id) {
            return;
        }
        run_one(state, connection, book_id);
    }
}

/// 书摘调用 codex 的额外参数:推理强度压到 medium(用户全局 xhigh 时一片就超过 300 s)
pub fn codex_args() -> Vec<String> {
    vec![
        "-c".into(),
        format!(
            "model_reasoning_effort={}",
            excerpt::EXCERPT_REASONING_EFFORT
        ),
    ]
}

/// 跑一本书的作业;codex 不可用时把作业标失败(原因写给用户看),否则它会一直排在队首
pub fn run_one(state: &AppState, connection: &Connection, book_id: i64) {
    let (provider, policy) = match state.ai_provider_with_args(codex_args()) {
        Ok(pair) => pair,
        Err(error) => {
            if let Err(db_error) =
                excerpt::fail_job_with(connection, book_id, &error.message, error.internal_cause())
            {
                tracing::warn!(book_id, %db_error, "书摘作业标记失败时出错");
            }
            tracing::warn!(
                book_id,
                internal_cause = error.internal_cause(),
                "书摘整理没有开始:AI 不可用"
            );
            return;
        }
    };
    tracing::info!(book_id, "开始整理书摘");
    let started = Instant::now();
    let result = excerpt::run_job(
        connection,
        provider.as_ref(),
        state.memory_root(),
        &policy,
        book_id,
        &mut |job| {
            tracing::info!(
                book_id,
                stage = job.stage.as_str(),
                piece = job.next_piece,
                total = job.total_pieces,
                "书摘整理进度"
            );
        },
    );
    match result {
        Ok(job) => tracing::info!(
            book_id,
            run = job.run,
            added = job.added,
            elapsed_s = started.elapsed().as_secs(),
            "书摘整理完成"
        ),
        Err(error) => tracing::warn!(
            book_id,
            %error,
            elapsed_s = started.elapsed().as_secs(),
            "书摘整理失败(已记在作业里,用户可重试)"
        ),
    }
}
