pub mod application;
pub mod commands;
pub mod dto;
pub mod error;
pub mod state;

use std::path::Path;

use book_learner_core::CoreError;
use tauri::Manager;

use crate::error::IpcError;

pub fn install_tracing() -> bool {
    tracing_subscriber::fmt().try_init().is_ok()
}

pub fn register_commands<R: tauri::Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder.invoke_handler(tauri::generate_handler![
        commands::library_list_books,
        commands::library_set_active_book,
        commands::map_list_blocks,
        commands::map_get_block,
        commands::planning_set_plan,
        commands::planning_today_queue,
        commands::settings_get,
        commands::settings_save,
        commands::unsupported_capability,
        commands::map_store_spine,
        commands::map_run_job,
        commands::map_confirm,
        commands::map_set_anchor_segments,
        commands::map_list_anchors,
        commands::session_start_or_resume,
        commands::session_submit_turn,
        commands::session_request_evaluation,
        commands::session_confirm_verdict,
        commands::session_abandon,
    ])
}

pub fn application_builder<R: tauri::Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    install_tracing();
    register_commands(builder)
}

/// 启动初始化(F3):解析数据库路径 → 建目录 → 打开状态。任何失败都返回类型化错误,
/// 由 `run()` 以原生对话框展示并写日志后退出,而不是 panic。
pub fn initialize_state(platform_data_dir: &Path) -> Result<state::AppState, IpcError> {
    let database_path = state::resolve_database_path(platform_data_dir)?;
    let database_directory = database_path
        .parent()
        .ok_or_else(|| IpcError::internal("resolved database path has no parent directory"))?;
    std::fs::create_dir_all(database_directory)
        .map_err(|error| IpcError::from(CoreError::Io(error)))?;
    state::AppState::open(&database_path)
}

/// 启动恢复:用独立连接重放投影 outbox(SQLite 为事实源,md/git 为投影),返回处理条数。
pub fn run_startup_recovery(state: &state::AppState) -> Result<usize, IpcError> {
    let connection = state.open_connection()?;
    book_learner_core::projection::run_pending(&connection, state.memory()).map_err(IpcError::from)
}

/// 启动失败的用户可见处理:日志(含 internal_cause)+ 原生阻塞错误框 + 退出码 1。
fn fail_startup(error: &IpcError) -> ! {
    tracing::error!(
        error_code = error.code.as_str(),
        internal_cause = error.internal_cause(),
        "book-learner 启动初始化失败"
    );
    // setup 在主线程且事件循环尚未启动:tauri-plugin-dialog 的 blocking_show 经
    // run_on_main_thread 派发会死锁;rfd 的同步 NSAlert(runModal 自带循环)可直接在主线程使用
    rfd::MessageDialog::new()
        .set_level(rfd::MessageLevel::Error)
        .set_title("book-learner 无法启动")
        .set_description(format!("{}\n\n详细原因已写入日志。", error.message))
        .set_buttons(rfd::MessageButtons::Ok)
        .show();
    std::process::exit(1)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default().setup(|app| {
        let platform_data_dir = match app.path().data_dir() {
            Ok(directory) => directory,
            Err(error) => fail_startup(&IpcError::internal(format!(
                "platform data dir unavailable: {error}"
            ))),
        };
        match initialize_state(&platform_data_dir) {
            Ok(state) => {
                app.manage(state);
                // 启动恢复放后台阻塞线程:文件/git I/O 不占主线程,也不持有 AppState 守卫
                let handle = app.handle().clone();
                tauri::async_runtime::spawn_blocking(move || {
                    let state = handle.state::<state::AppState>();
                    match run_startup_recovery(&state) {
                        Ok(processed) => tracing::info!(processed, "启动投影恢复完成"),
                        Err(error) => tracing::error!(
                            error_code = error.code.as_str(),
                            internal_cause = error.internal_cause(),
                            "启动投影恢复失败"
                        ),
                    }
                });
                Ok(())
            }
            Err(error) => fail_startup(&error),
        }
    });
    if let Err(error) = application_builder(builder).run(tauri::generate_context!()) {
        fail_startup(&IpcError::internal(format!(
            "tauri runtime failed: {error}"
        )));
    }
}
