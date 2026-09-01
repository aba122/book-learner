use tauri::State;

use crate::application;
use crate::dto::{AppSettingsDto, BookDto, DailyTaskDto, KnowledgeBlockDto, StudyPlanRequest};
use crate::error::IpcError;
use crate::state::AppState;

pub const WIRE_COMMANDS: &[(&str, &[&str])] = &[
    ("library_list_books", &[]),
    ("library_set_active_book", &["bookId"]),
    ("map_list_blocks", &["bookId"]),
    ("map_get_block", &["blockId"]),
    ("planning_set_plan", &["request"]),
    ("planning_today_queue", &["date"]),
    ("settings_get", &[]),
    ("settings_save", &["settings"]),
    ("unsupported_capability", &["capability"]),
];

pub const UNSUPPORTED_CAPABILITIES: &[&str] = &[
    "importEpub",
    "generateMap",
    "confirmMap",
    "completeTask",
    "blockSource",
    "epubUrl",
    "startSession",
    "studentReply",
    "endSession",
    "confirmVerdict",
    "stats",
];

fn run_command<T>(
    state: &AppState,
    command: &'static str,
    operation: impl FnOnce() -> Result<T, IpcError>,
) -> Result<T, IpcError> {
    let correlation_id = state.next_correlation_id();
    operation().inspect_err(|error| {
        tracing::error!(
            command,
            correlation_id,
            error_code = error.code.as_str(),
            internal_cause = error.internal_cause()
        );
    })
}

pub fn library_list_books_inner(state: &AppState) -> Result<Vec<BookDto>, IpcError> {
    run_command(state, "library_list_books", || {
        application::list_books(state)
    })
}

pub fn library_set_active_book_inner(state: &AppState, book_id: i64) -> Result<(), IpcError> {
    run_command(state, "library_set_active_book", || {
        application::set_active_book(state, book_id)
    })
}

pub fn map_list_blocks_inner(
    state: &AppState,
    book_id: i64,
) -> Result<Vec<KnowledgeBlockDto>, IpcError> {
    run_command(state, "map_list_blocks", || {
        application::list_blocks(state, book_id)
    })
}

pub fn map_get_block_inner(state: &AppState, block_id: i64) -> Result<KnowledgeBlockDto, IpcError> {
    run_command(state, "map_get_block", || {
        application::get_block(state, block_id)
    })
}

pub fn planning_set_plan_inner(
    state: &AppState,
    request: StudyPlanRequest,
) -> Result<(), IpcError> {
    run_command(state, "planning_set_plan", || {
        application::set_plan(state, request)
    })
}

pub fn planning_today_queue_inner(
    state: &AppState,
    date: String,
) -> Result<Vec<DailyTaskDto>, IpcError> {
    run_command(state, "planning_today_queue", || {
        application::today_queue(state, &date)
    })
}

pub fn settings_get_inner(state: &AppState) -> Result<AppSettingsDto, IpcError> {
    run_command(state, "settings_get", || application::get_settings(state))
}

pub fn settings_save_inner(state: &AppState, settings: AppSettingsDto) -> Result<(), IpcError> {
    run_command(state, "settings_save", || {
        application::save_settings(state, settings)
    })
}

pub fn unsupported_capability_inner(state: &AppState, capability: String) -> Result<(), IpcError> {
    run_command(state, "unsupported_capability", || {
        Err(IpcError::not_implemented(capability))
    })
}

#[tauri::command(async)]
pub async fn library_list_books(state: State<'_, AppState>) -> Result<Vec<BookDto>, IpcError> {
    library_list_books_inner(&state)
}

#[tauri::command(async)]
pub async fn library_set_active_book(
    state: State<'_, AppState>,
    book_id: i64,
) -> Result<(), IpcError> {
    library_set_active_book_inner(&state, book_id)
}

#[tauri::command(async)]
pub async fn map_list_blocks(
    state: State<'_, AppState>,
    book_id: i64,
) -> Result<Vec<KnowledgeBlockDto>, IpcError> {
    map_list_blocks_inner(&state, book_id)
}

#[tauri::command(async)]
pub async fn map_get_block(
    state: State<'_, AppState>,
    block_id: i64,
) -> Result<KnowledgeBlockDto, IpcError> {
    map_get_block_inner(&state, block_id)
}

#[tauri::command(async)]
pub async fn planning_set_plan(
    state: State<'_, AppState>,
    request: StudyPlanRequest,
) -> Result<(), IpcError> {
    planning_set_plan_inner(&state, request)
}

#[tauri::command(async)]
pub async fn planning_today_queue(
    state: State<'_, AppState>,
    date: String,
) -> Result<Vec<DailyTaskDto>, IpcError> {
    planning_today_queue_inner(&state, date)
}

#[tauri::command(async)]
pub async fn settings_get(state: State<'_, AppState>) -> Result<AppSettingsDto, IpcError> {
    settings_get_inner(&state)
}

#[tauri::command(async)]
pub async fn settings_save(
    state: State<'_, AppState>,
    settings: AppSettingsDto,
) -> Result<(), IpcError> {
    settings_save_inner(&state, settings)
}

#[tauri::command(async)]
pub async fn unsupported_capability(
    state: State<'_, AppState>,
    capability: String,
) -> Result<(), IpcError> {
    unsupported_capability_inner(&state, capability)
}
