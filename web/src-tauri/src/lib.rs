pub mod application;
pub mod commands;
pub mod dto;
pub mod error;
pub mod state;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
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
        })
        .invoke_handler(tauri::generate_handler![
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
        .run(tauri::generate_context!())
        .expect("book-learner Tauri runtime failed");
}
