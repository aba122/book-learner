use tauri::{Emitter, State};

use crate::application;
use crate::dto::{
    AnchorSegmentDto, AppSettingsDto, BookDto, DailyTaskDto, KnowledgeBlockDto, MapEditOpDto,
    MapProgressDto, MapRevisionDto, SpineChapterDto, StudyPlanRequest,
};

/// 地图作业进度事件名(与 web/src/backend/tauri.ts 的 MAP_JOB_PROGRESS_EVENT 一致)。
pub const MAP_JOB_PROGRESS_EVENT: &str = "map_job_progress";
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
    // 契约 v2(Plan B):命令名与 payloadKeys 逐字对齐 shared/tauri-wire-contract.json
    ("map_store_spine", &["bookId", "chapters"]),
    ("map_run_job", &["bookId", "jobId"]),
    ("map_confirm", &["bookId", "expectedRevision", "ops"]),
    ("map_set_anchor_segments", &["blockId", "segments"]),
    ("map_list_anchors", &["blockId"]),
    (
        "session_start_or_resume",
        &["taskId", "clientRequestId", "date"],
    ),
    (
        "session_submit_turn",
        &["sessionId", "expectedVersion", "clientTurnId", "text"],
    ),
    ("session_request_evaluation", &["sessionId", "requestId"]),
    (
        "session_confirm_verdict",
        &["sessionId", "expectedVersion", "requestId", "pass", "date"],
    ),
    ("session_abandon", &["sessionId", "expectedVersion"]),
];

pub const UNSUPPORTED_CAPABILITIES: &[&str] = &[
    "importEpub",
    "completeTask",
    "blockSource",
    "epubUrl",
    "stats",
    "startOrResumeSession",
    "submitTurn",
    "requestEvaluation",
    "confirmSessionVerdict",
    "abandonSession",
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

pub fn map_store_spine_inner(
    state: &AppState,
    book_id: i64,
    chapters: Vec<SpineChapterDto>,
) -> Result<(), IpcError> {
    run_command(state, "map_store_spine", || {
        application::store_spine(state, book_id, chapters)
    })
}

pub fn map_run_job_inner(
    state: &AppState,
    book_id: i64,
    job_id: &str,
    on_progress: &mut dyn FnMut(MapProgressDto),
) -> Result<Vec<KnowledgeBlockDto>, IpcError> {
    run_command(state, "map_run_job", || {
        application::run_map_job(state, book_id, job_id, on_progress)
    })
}

pub fn map_confirm_inner(
    state: &AppState,
    book_id: i64,
    expected_revision: i64,
    ops: Vec<MapEditOpDto>,
) -> Result<MapRevisionDto, IpcError> {
    run_command(state, "map_confirm", || {
        application::confirm_map(state, book_id, expected_revision, ops)
    })
}

pub fn map_set_anchor_segments_inner(
    state: &AppState,
    block_id: i64,
    segments: Vec<AnchorSegmentDto>,
) -> Result<(), IpcError> {
    run_command(state, "map_set_anchor_segments", || {
        application::set_anchor_segments(state, block_id, segments)
    })
}

pub fn map_list_anchors_inner(
    state: &AppState,
    block_id: i64,
) -> Result<Vec<AnchorSegmentDto>, IpcError> {
    run_command(state, "map_list_anchors", || {
        application::list_anchors(state, block_id)
    })
}

/// v2 命令占位期(M0):命令已注册、参数已按契约类型化,但 core 用例尚未接线;
/// 统一返回 `not_implemented`(details.capability = 前端方法名)。M4/M5 逐条替换为真实实现。
fn placeholder(state: &AppState, command: &'static str, method: &str) -> Result<(), IpcError> {
    run_command(state, command, || {
        Err(IpcError::not_implemented(method.to_string()))
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

// ---- 契约 v2 占位命令(M0):参数名/类型对齐 web/src/backend/types.ts,接线时保持签名 ----

#[tauri::command(async)]
pub async fn map_store_spine(
    state: State<'_, AppState>,
    book_id: i64,
    chapters: Vec<SpineChapterDto>,
) -> Result<(), IpcError> {
    map_store_spine_inner(&state, book_id, chapters)
}

#[tauri::command(async)]
pub async fn map_run_job<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: State<'_, AppState>,
    book_id: i64,
    job_id: String,
) -> Result<Vec<KnowledgeBlockDto>, IpcError> {
    let mut emit = |progress: MapProgressDto| {
        // 进度只是提示:发送失败仅记日志,最终结果仍由返回值决定
        if let Err(error) = app.emit(
            MAP_JOB_PROGRESS_EVENT,
            serde_json::json!({ "jobId": job_id, "progress": progress }),
        ) {
            tracing::warn!(job_id, %error, "map_job_progress event failed");
        }
    };
    map_run_job_inner(&state, book_id, &job_id, &mut emit)
}

#[tauri::command(async)]
pub async fn map_confirm(
    state: State<'_, AppState>,
    book_id: i64,
    expected_revision: i64,
    ops: Vec<MapEditOpDto>,
) -> Result<MapRevisionDto, IpcError> {
    map_confirm_inner(&state, book_id, expected_revision, ops)
}

#[tauri::command(async)]
pub async fn map_set_anchor_segments(
    state: State<'_, AppState>,
    block_id: i64,
    segments: Vec<AnchorSegmentDto>,
) -> Result<(), IpcError> {
    map_set_anchor_segments_inner(&state, block_id, segments)
}

#[tauri::command(async)]
pub async fn map_list_anchors(
    state: State<'_, AppState>,
    block_id: i64,
) -> Result<Vec<AnchorSegmentDto>, IpcError> {
    map_list_anchors_inner(&state, block_id)
}

#[tauri::command(async)]
pub async fn session_start_or_resume(
    state: State<'_, AppState>,
    task_id: i64,
    client_request_id: String,
    date: String,
) -> Result<(), IpcError> {
    let _ = (task_id, client_request_id, date);
    placeholder(&state, "session_start_or_resume", "startOrResumeSession")
}

#[tauri::command(async)]
pub async fn session_submit_turn(
    state: State<'_, AppState>,
    session_id: i64,
    expected_version: i64,
    client_turn_id: String,
    text: String,
) -> Result<(), IpcError> {
    let _ = (session_id, expected_version, client_turn_id, text);
    placeholder(&state, "session_submit_turn", "submitTurn")
}

#[tauri::command(async)]
pub async fn session_request_evaluation(
    state: State<'_, AppState>,
    session_id: i64,
    request_id: String,
) -> Result<(), IpcError> {
    let _ = (session_id, request_id);
    placeholder(&state, "session_request_evaluation", "requestEvaluation")
}

#[tauri::command(async)]
pub async fn session_confirm_verdict(
    state: State<'_, AppState>,
    session_id: i64,
    expected_version: i64,
    request_id: String,
    pass: bool,
    date: String,
) -> Result<(), IpcError> {
    let _ = (session_id, expected_version, request_id, pass, date);
    placeholder(&state, "session_confirm_verdict", "confirmSessionVerdict")
}

#[tauri::command(async)]
pub async fn session_abandon(
    state: State<'_, AppState>,
    session_id: i64,
    expected_version: i64,
) -> Result<(), IpcError> {
    let _ = (session_id, expected_version);
    placeholder(&state, "session_abandon", "abandonSession")
}
