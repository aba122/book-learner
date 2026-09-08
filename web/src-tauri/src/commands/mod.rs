use tauri::{Emitter, Manager, State};

use crate::application;
use crate::dto::{
    AnchorSegmentDto, AppSettingsDto, BlockSourceDto, BookDto, DailyTaskDto, EvaluationViewDto,
    ImportChunkDto, ImportResultDto, KnowledgeBlockDto, MapEditOpDto, MapProgressDto,
    MapRevisionDto, SessionViewDto, SpineChapterDto, StudyPlanRequest, TurnResultDto,
    VerdictOutcomeDto,
};
use crate::error::IpcError;
use crate::state::AppState;

/// 地图作业进度事件名(与 web/src/backend/tauri.ts 的 MAP_JOB_PROGRESS_EVENT 一致)。
pub const MAP_JOB_PROGRESS_EVENT: &str = "map_job_progress";
/// 分块导入请求头(与 web/src/backend/tauri.ts 一致)。
pub const IMPORT_OP_ID_HEADER: &str = "x-op-id";
pub const IMPORT_CHUNK_INDEX_HEADER: &str = "x-chunk-index";

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
    // M6:原生导入(分块为原始请求体,元数据走头 x-op-id / x-chunk-index)、受管路径与块原文
    ("library_import_epub_chunk", &[]),
    (
        "library_import_epub_finalize",
        &["opId", "bookType", "title"],
    ),
    ("library_epub_url", &["bookId"]),
    ("map_block_source", &["blockId"]),
];

pub const UNSUPPORTED_CAPABILITIES: &[&str] = &["completeTask", "stats"];

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

pub fn session_start_or_resume_inner(
    state: &AppState,
    task_id: i64,
    client_request_id: &str,
    date: &str,
) -> Result<SessionViewDto, IpcError> {
    run_command(state, "session_start_or_resume", || {
        application::start_or_resume_session(state, task_id, client_request_id, date)
    })
}

pub fn session_submit_turn_inner(
    state: &AppState,
    session_id: i64,
    expected_version: i64,
    client_turn_id: &str,
    text: &str,
) -> Result<TurnResultDto, IpcError> {
    run_command(state, "session_submit_turn", || {
        application::submit_turn(state, session_id, expected_version, client_turn_id, text)
    })
}

pub fn session_request_evaluation_inner(
    state: &AppState,
    session_id: i64,
    request_id: &str,
) -> Result<EvaluationViewDto, IpcError> {
    run_command(state, "session_request_evaluation", || {
        application::request_evaluation(state, session_id, request_id)
    })
}

pub fn session_confirm_verdict_inner(
    state: &AppState,
    session_id: i64,
    expected_version: i64,
    request_id: &str,
    pass: bool,
    date: &str,
) -> Result<VerdictOutcomeDto, IpcError> {
    run_command(state, "session_confirm_verdict", || {
        application::confirm_session_verdict(
            state,
            session_id,
            expected_version,
            request_id,
            pass,
            date,
        )
    })
}

pub fn session_abandon_inner(
    state: &AppState,
    session_id: i64,
    expected_version: i64,
) -> Result<(), IpcError> {
    run_command(state, "session_abandon", || {
        application::abandon_session(state, session_id, expected_version)
    })
}

pub fn library_import_epub_chunk_inner(
    state: &AppState,
    op_id: &str,
    index: u64,
    bytes: &[u8],
) -> Result<ImportChunkDto, IpcError> {
    run_command(state, "library_import_epub_chunk", || {
        application::stage_import_chunk(state, op_id, index, bytes)
    })
}

pub fn library_import_epub_finalize_inner(
    state: &AppState,
    op_id: &str,
    book_type: &str,
    title: &str,
) -> Result<ImportResultDto, IpcError> {
    run_command(state, "library_import_epub_finalize", || {
        application::finalize_import(state, op_id, book_type, title)
    })
}

pub fn library_epub_url_inner(state: &AppState, book_id: i64) -> Result<String, IpcError> {
    run_command(state, "library_epub_url", || {
        application::epub_path(state, book_id)
    })
}

pub fn map_block_source_inner(state: &AppState, block_id: i64) -> Result<BlockSourceDto, IpcError> {
    run_command(state, "map_block_source", || {
        application::block_source(state, block_id)
    })
}

fn required_header(request: &tauri::ipc::Request<'_>, name: &str) -> Result<String, IpcError> {
    request
        .headers()
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned)
        .ok_or_else(|| {
            IpcError::invalid_request("导入请求缺少必要头部", format!("missing header {name}"))
        })
}

// ---- 契约 v2 命令(M4/M5):参数名/类型对齐 web/src/backend/types.ts ----

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
) -> Result<SessionViewDto, IpcError> {
    session_start_or_resume_inner(&state, task_id, &client_request_id, &date)
}

#[tauri::command(async)]
pub async fn session_submit_turn(
    state: State<'_, AppState>,
    session_id: i64,
    expected_version: i64,
    client_turn_id: String,
    text: String,
) -> Result<TurnResultDto, IpcError> {
    session_submit_turn_inner(&state, session_id, expected_version, &client_turn_id, &text)
}

#[tauri::command(async)]
pub async fn session_request_evaluation(
    state: State<'_, AppState>,
    session_id: i64,
    request_id: String,
) -> Result<EvaluationViewDto, IpcError> {
    session_request_evaluation_inner(&state, session_id, &request_id)
}

#[tauri::command(async)]
pub async fn session_confirm_verdict<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: State<'_, AppState>,
    session_id: i64,
    expected_version: i64,
    request_id: String,
    pass: bool,
    date: String,
) -> Result<VerdictOutcomeDto, IpcError> {
    let outcome = session_confirm_verdict_inner(
        &state,
        session_id,
        expected_version,
        &request_id,
        pass,
        &date,
    )?;
    // 判定已原子落库;md/git 投影在后台阻塞线程重放(独立连接),失败只记日志,启动恢复会补跑
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        match crate::run_startup_recovery(&state) {
            Ok(processed) => tracing::info!(session_id, processed, "判定后投影重放完成"),
            Err(error) => tracing::error!(
                session_id,
                error_code = error.code.as_str(),
                internal_cause = error.internal_cause(),
                "判定后投影重放失败"
            ),
        }
    });
    Ok(outcome)
}

#[tauri::command(async)]
pub async fn session_abandon(
    state: State<'_, AppState>,
    session_id: i64,
    expected_version: i64,
) -> Result<(), IpcError> {
    session_abandon_inner(&state, session_id, expected_version)
}

// ---- 导入与阅读器命令(M6)----

/// 分块导入:请求体为原始字节(`invoke(cmd, Uint8Array, { headers })`),op/序号走头部。
#[tauri::command(async)]
pub async fn library_import_epub_chunk(
    state: State<'_, AppState>,
    request: tauri::ipc::Request<'_>,
) -> Result<ImportChunkDto, IpcError> {
    let op_id = required_header(&request, IMPORT_OP_ID_HEADER)?;
    let index: u64 = required_header(&request, IMPORT_CHUNK_INDEX_HEADER)?
        .parse()
        .map_err(|_| IpcError::invalid_request("导入分块序号无效", "x-chunk-index not a u64"))?;
    let bytes = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => bytes.as_slice(),
        tauri::ipc::InvokeBody::Json(_) => {
            return Err(IpcError::invalid_request(
                "导入分块必须是原始字节体",
                "chunk body was JSON, expected raw bytes",
            ))
        }
    };
    library_import_epub_chunk_inner(&state, &op_id, index, bytes)
}

#[tauri::command(async)]
pub async fn library_import_epub_finalize(
    state: State<'_, AppState>,
    op_id: String,
    book_type: String,
    title: String,
) -> Result<ImportResultDto, IpcError> {
    library_import_epub_finalize_inner(&state, &op_id, &book_type, &title)
}

#[tauri::command(async)]
pub async fn library_epub_url(
    state: State<'_, AppState>,
    book_id: i64,
) -> Result<String, IpcError> {
    library_epub_url_inner(&state, book_id)
}

#[tauri::command(async)]
pub async fn map_block_source(
    state: State<'_, AppState>,
    block_id: i64,
) -> Result<BlockSourceDto, IpcError> {
    map_block_source_inner(&state, block_id)
}
