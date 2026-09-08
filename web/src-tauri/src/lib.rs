pub mod application;
pub mod automation;
pub mod commands;
pub mod dto;
pub mod error;
pub mod import;
pub mod notify;
pub mod pomodoro;
pub mod state;

use std::path::Path;
use std::time::Duration;

use book_learner_core::CoreError;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
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
        commands::library_import_epub_chunk,
        commands::library_import_epub_finalize,
        commands::library_epub_url,
        commands::map_block_source,
        commands::stats_get,
        commands::planning_check_behind,
        commands::planning_get_plan,
        commands::library_finish_book,
        commands::pomodoro_start,
        commands::pomodoro_pause,
        commands::pomodoro_resume,
        commands::pomodoro_stop,
        commands::pomodoro_state,
        commands::profile_get,
        commands::profile_save,
        commands::extra_start,
        commands::extra_finish,
        commands::stats_detail,
        commands::final_exam_eligible,
        commands::final_exam_start,
        commands::final_exam_finish,
        commands::export_preview,
        commands::export_obsidian,
        commands::export_reveal,
        commands::backup_snapshot_now,
        commands::backup_list,
        commands::backup_restore,
        commands::backup_cancel_restore,
        commands::git_remote_get,
        commands::git_remote_set,
        commands::git_push_now,
        commands::automation_report,
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
    // 待恢复标记(M3 T5):在打开数据库之前替换 app.db(连带移走热日志);标记无论成败都被消费
    let restored = match book_learner_core::backup::apply_pending_restore(
        database_directory,
        &database_path,
    ) {
        Ok(name) => name,
        Err(error) => {
            tracing::error!(%error, "应用待恢复快照失败,继续用当前数据库启动");
            None
        }
    };
    let state = state::AppState::open(&database_path)?;
    if let Some(name) = restored {
        tracing::warn!(snapshot = name, "已从快照恢复数据库;记忆库镜像将按库重生");
        // 镜像文件(地图/薄弱点)可能比恢复后的库新:对所有书入队再生
        let _ = state.with_connection(|connection| {
            let books = book_learner_core::models::list_books(connection)?;
            for book in books {
                book_learner_core::projection::enqueue(
                    connection,
                    &format!("restore:{name}:sync_map:{}", book.id),
                    "sync_map",
                    &serde_json::json!({ "book_id": book.id }),
                )?;
                book_learner_core::projection::enqueue(
                    connection,
                    &format!("restore:{name}:sync_weakpoints:{}", book.id),
                    "sync_weakpoints",
                    &serde_json::json!({ "book_id": book.id }),
                )?;
            }
            Ok(())
        });
    }
    // 每日首次启动快照(本地日期,与提醒线程一致;失败只记日志)
    snapshot_if_missing_today(&state);
    // 崩溃恢复:清理 24h 前未完成的导入暂存
    match state
        .import_store()
        .cleanup_stale(std::time::SystemTime::now())
    {
        Ok(0) => {}
        Ok(removed) => tracing::info!(removed, "已清理过期的导入暂存目录"),
        Err(error) => {
            tracing::warn!(internal_cause = error.internal_cause(), "清理导入暂存失败")
        }
    }
    Ok(state)
}

/// 启动恢复:用独立连接重放投影 outbox(SQLite 为事实源,md/git 为投影),返回处理条数;
/// 之后顺带跑一次 push 通道(到期才推,失败按退避留在队列,不影响返回值)。
pub fn run_startup_recovery(state: &state::AppState) -> Result<usize, IpcError> {
    let connection = state.open_connection()?;
    let processed = book_learner_core::projection::run_pending(&connection, state.memory())
        .map_err(IpcError::from)?;
    let now = chrono::Utc::now().to_rfc3339();
    match book_learner_core::projection::run_push_lane(&connection, state.memory(), &now) {
        Ok(Some(true)) => tracing::info!("记忆库已推送到远程"),
        Ok(Some(false)) => tracing::warn!("记忆库推送失败,已按退避重排"),
        Ok(None) => {}
        Err(error) => tracing::warn!(%error, "push 通道处理失败"),
    }
    Ok(processed)
}

/// 当日尚无快照时做一份(每日首次启动 / 退出前);只记日志,不影响启动或退出。
pub fn snapshot_if_missing_today(state: &state::AppState) {
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    let dir = application::snapshots_dir(state);
    let exists = book_learner_core::backup::list(&dir)
        .map(|list| list.iter().any(|s| s.date == today))
        .unwrap_or(false);
    if exists {
        return;
    }
    match application::backup_snapshot_now(state, &today) {
        Ok(snapshot) => tracing::info!(
            name = snapshot.name,
            bytes = snapshot.bytes,
            "已写入当日快照"
        ),
        Err(error) => tracing::warn!(internal_cause = error.internal_cause(), "当日快照失败"),
    }
}

/// 退出时等待进行中慢命令收尾的上限;超时强制退出(codex 子进程由 core 按进程组终止,
/// 但强制退出路径不再等待其收尾——见 DEVLOG M7 限制)。
pub const SHUTDOWN_GRACE: Duration = Duration::from_secs(10);

/// 有序退出:等待进行中的导入/地图作业/回合/评估收尾;返回是否在宽限内全部收尾。
pub fn orderly_shutdown(state: &state::AppState, grace: Duration) -> bool {
    // 进行中的番茄先结束并落分钟(M2 T3)
    pomodoro::stop_for_shutdown(state);
    let idle = state.jobs().wait_idle(grace);
    // 退出前刷新当日快照(M3 T5):覆盖同日文件
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    if let Err(error) = application::backup_snapshot_now(state, &today) {
        tracing::warn!(internal_cause = error.internal_cause(), "退出前快照失败");
    }
    if idle {
        tracing::info!("有序退出:无进行中任务");
    } else {
        tracing::warn!(
            in_flight = state.jobs().in_flight(),
            "退出宽限已过,仍有任务进行中,强制退出"
        );
    }
    idle
}

fn show_main_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// 托盘:显示主窗口 / 退出;图标取 bundle.icon(缺省时仅菜单可用)。
fn install_tray<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出攻书", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;
    let mut builder = TrayIconBuilder::with_id("main")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .tooltip("攻书 book-learner")
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => show_main_window(app),
            "quit" => app.exit(0),
            _ => {}
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.to_owned());
    }
    builder.build(app)?;
    Ok(())
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
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        // 关窗 = 隐藏(留在 Dock 与托盘),Cmd+Q / 托盘"退出"才真正退出
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .setup(|app| {
            let platform_data_dir = match app.path().data_dir() {
                Ok(directory) => directory,
                Err(error) => fail_startup(&IpcError::internal(format!(
                    "platform data dir unavailable: {error}"
                ))),
            };
            match initialize_state(&platform_data_dir) {
                Ok(state) => {
                    // asset protocol 只放行受管 books 目录;静态 glob 无法覆盖 BOOK_LEARNER_DATA_DIR 调试覆盖,故运行时授予
                    let books_dir = state.books_dir();
                    if let Err(error) = app.asset_protocol_scope().allow_directory(&books_dir, true)
                    {
                        fail_startup(&IpcError::internal(format!(
                            "asset protocol scope for {} failed: {error}",
                            books_dir.display()
                        )));
                    }
                    app.manage(state);
                    // 调试自动化桥:仅 debug 构建且设置了 BOOK_LEARNER_AUTOMATION_SOCK 时才监听
                    automation::maybe_spawn(app.handle().clone());
                    if let Err(error) = install_tray(app.handle()) {
                        // 托盘不可用不致命:主窗口与 Cmd+Q 仍可用
                        tracing::warn!(%error, "托盘初始化失败");
                    }
                    // 番茄钟 ticker(托盘倒计时/阶段事件/通知)
                    pomodoro::spawn_ticker(app.handle().clone());
                    // 每日/晚间系统通知(常驻线程,30s 轮询,判定在 core::notify)
                    notify::spawn_reminder_thread(app.handle().clone());
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
    let app = match application_builder(builder).build(tauri::generate_context!()) {
        Ok(app) => app,
        Err(error) => fail_startup(&IpcError::internal(format!(
            "tauri runtime failed to build: {error}"
        ))),
    };
    app.run(|handle, event| match event {
        // Cmd+Q / 托盘退出 / app.exit:先等进行中的慢命令收尾(≤ SHUTDOWN_GRACE),再退出
        tauri::RunEvent::ExitRequested { .. } => {
            let state = handle.state::<state::AppState>();
            orderly_shutdown(&state, SHUTDOWN_GRACE);
        }
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Reopen { .. } => show_main_window(handle),
        _ => {}
    });
}
