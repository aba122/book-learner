pub mod application;
pub mod commands;
pub mod dto;
pub mod error;
pub mod state;

use tauri::Manager;

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
    ])
}

pub fn application_builder<R: tauri::Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    install_tracing();
    register_commands(builder)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default().setup(|app| {
        let platform_data_dir = app.path().data_dir()?;
        let database_path = state::resolve_database_path(&platform_data_dir)
            .map_err(|error| std::io::Error::other(error.message))?;
        let database_directory = database_path.parent().ok_or_else(|| {
            std::io::Error::other("resolved database path has no parent directory")
        })?;
        std::fs::create_dir_all(database_directory)?;
        let state = state::AppState::open(&database_path)
            .map_err(|error| std::io::Error::other(error.message))?;
        app.manage(state);
        Ok(())
    });
    application_builder(builder)
        .run(tauri::generate_context!())
        .expect("book-learner Tauri runtime failed");
}
