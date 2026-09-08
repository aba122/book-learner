use tauri::{Emitter, Manager, State};

use crate::application;
use crate::dto::{
    AnchorSegmentDto, AppSettingsDto, BlockSourceDto, BookDto, DailyTaskDto, EvaluationViewDto,
    ExtraOutcomeDto, ImportChunkDto, ImportResultDto, KnowledgeBlockDto, MapEditOpDto,
    MapProgressDto, MapRevisionDto, PomodoroSnapshotDto, ProfileDto, ReplanDto, SessionViewDto,
    SpineChapterDto, StatsDto, StudyPlanDto, StudyPlanRequest, TurnResultDto, VerdictOutcomeDto,
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
    // M7:统计(date 由前端本地日历日提供,core 不读系统时间)
    ("stats_get", &["date"]),
    // M2 T4:落后检测(有副作用,先于当日队列生成调用)与计划读取
    ("planning_check_behind", &["bookId", "date"]),
    ("planning_get_plan", &["bookId"]),
    // M2 T8:标记学完(计划冻结,复习照常)
    ("library_finish_book", &["bookId"]),
    // M2 T3:番茄钟(Rust 状态机;事件 pomodoro_changed 只作常量)
    ("pomodoro_start", &["taskId", "date"]),
    ("pomodoro_pause", &[]),
    ("pomodoro_resume", &[]),
    ("pomodoro_stop", &[]),
    ("pomodoro_state", &[]),
    // M2 T6:学习者画像(profile.md 四小节)
    ("profile_get", &[]),
    ("profile_save", &["profile"]),
    // M2 T5:通过后附加环节(回合复用 session_submit_turn)
    ("extra_start", &["blockId", "kind", "clientRequestId"]),
    (
        "extra_finish",
        &["sessionId", "expectedVersion", "requestId"],
    ),
];

pub const UNSUPPORTED_CAPABILITIES: &[&str] = &["completeTask"];

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

pub fn stats_get_inner(state: &AppState, date: &str) -> Result<StatsDto, IpcError> {
    run_command(state, "stats_get", || application::stats(state, date))
}

pub fn planning_check_behind_inner(
    state: &AppState,
    book_id: i64,
    date: &str,
) -> Result<ReplanDto, IpcError> {
    run_command(state, "planning_check_behind", || {
        application::check_behind(state, book_id, date)
    })
}

pub fn planning_get_plan_inner(
    state: &AppState,
    book_id: i64,
) -> Result<Option<StudyPlanDto>, IpcError> {
    run_command(state, "planning_get_plan", || {
        application::get_plan(state, book_id)
    })
}

pub fn library_finish_book_inner(state: &AppState, book_id: i64) -> Result<(), IpcError> {
    run_command(state, "library_finish_book", || {
        application::finish_book(state, book_id)
    })
}

pub fn pomodoro_start_inner(
    state: &AppState,
    task_id: i64,
    date: &str,
) -> Result<PomodoroSnapshotDto, IpcError> {
    run_command(state, "pomodoro_start", || {
        crate::pomodoro::start(state, task_id, date)
    })
}

pub fn pomodoro_pause_inner(state: &AppState) -> Result<PomodoroSnapshotDto, IpcError> {
    run_command(state, "pomodoro_pause", || crate::pomodoro::pause(state))
}

pub fn pomodoro_resume_inner(state: &AppState) -> Result<PomodoroSnapshotDto, IpcError> {
    run_command(state, "pomodoro_resume", || crate::pomodoro::resume(state))
}

pub fn pomodoro_stop_inner(state: &AppState) -> Result<PomodoroSnapshotDto, IpcError> {
    run_command(state, "pomodoro_stop", || crate::pomodoro::stop(state))
}

pub fn pomodoro_state_inner(state: &AppState) -> Result<PomodoroSnapshotDto, IpcError> {
    run_command(state, "pomodoro_state", || crate::pomodoro::snapshot(state))
}

pub fn profile_get_inner(state: &AppState) -> Result<ProfileDto, IpcError> {
    run_command(state, "profile_get", || application::profile_get(state))
}

pub fn profile_save_inner(state: &AppState, profile: ProfileDto) -> Result<(), IpcError> {
    run_command(state, "profile_save", || {
        application::profile_save(state, profile)
    })
}

pub fn extra_start_inner(
    state: &AppState,
    block_id: i64,
    kind: &str,
    client_request_id: &str,
) -> Result<SessionViewDto, IpcError> {
    run_command(state, "extra_start", || {
        application::extra_start(state, block_id, kind, client_request_id)
    })
}

pub fn extra_finish_inner(
    state: &AppState,
    session_id: i64,
    expected_version: i64,
    request_id: &str,
) -> Result<ExtraOutcomeDto, IpcError> {
    run_command(state, "extra_finish", || {
        application::extra_finish(state, session_id, expected_version, request_id)
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

#[tauri::command(async)]
pub async fn stats_get(state: State<'_, AppState>, date: String) -> Result<StatsDto, IpcError> {
    stats_get_inner(&state, &date)
}

#[tauri::command(async)]
pub async fn planning_check_behind(
    state: State<'_, AppState>,
    book_id: i64,
    date: String,
) -> Result<ReplanDto, IpcError> {
    planning_check_behind_inner(&state, book_id, &date)
}

#[tauri::command(async)]
pub async fn planning_get_plan(
    state: State<'_, AppState>,
    book_id: i64,
) -> Result<Option<StudyPlanDto>, IpcError> {
    planning_get_plan_inner(&state, book_id)
}

#[tauri::command(async)]
pub async fn library_finish_book(state: State<'_, AppState>, book_id: i64) -> Result<(), IpcError> {
    library_finish_book_inner(&state, book_id)
}

// ---- 番茄钟命令(M2 T3)----

#[tauri::command(async)]
pub async fn pomodoro_start(
    state: State<'_, AppState>,
    task_id: i64,
    date: String,
) -> Result<PomodoroSnapshotDto, IpcError> {
    pomodoro_start_inner(&state, task_id, &date)
}

#[tauri::command(async)]
pub async fn pomodoro_pause(state: State<'_, AppState>) -> Result<PomodoroSnapshotDto, IpcError> {
    pomodoro_pause_inner(&state)
}

#[tauri::command(async)]
pub async fn pomodoro_resume(state: State<'_, AppState>) -> Result<PomodoroSnapshotDto, IpcError> {
    pomodoro_resume_inner(&state)
}

#[tauri::command(async)]
pub async fn pomodoro_stop(state: State<'_, AppState>) -> Result<PomodoroSnapshotDto, IpcError> {
    pomodoro_stop_inner(&state)
}

#[tauri::command(async)]
pub async fn pomodoro_state(state: State<'_, AppState>) -> Result<PomodoroSnapshotDto, IpcError> {
    pomodoro_state_inner(&state)
}

// ---- 学习者画像命令(M2 T6)----

#[tauri::command(async)]
pub async fn profile_get(state: State<'_, AppState>) -> Result<ProfileDto, IpcError> {
    profile_get_inner(&state)
}

/// 保存后在后台重放投影(git commit),与判定后的重放同一路径。
#[tauri::command(async)]
pub async fn profile_save<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: State<'_, AppState>,
    profile: ProfileDto,
) -> Result<(), IpcError> {
    profile_save_inner(&state, profile)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        if let Err(error) = crate::run_startup_recovery(&state) {
            tracing::error!(
                error_code = error.code.as_str(),
                internal_cause = error.internal_cause(),
                "画像保存后投影重放失败"
            );
        }
    });
    Ok(())
}

// ---- 附加环节命令(M2 T5)----

#[tauri::command(async)]
pub async fn extra_start(
    state: State<'_, AppState>,
    block_id: i64,
    kind: String,
    client_request_id: String,
) -> Result<SessionViewDto, IpcError> {
    extra_start_inner(&state, block_id, &kind, &client_request_id)
}

/// 结束后在后台重放投影(归档 + git commit),与判定后的重放同一路径。
#[tauri::command(async)]
pub async fn extra_finish<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: State<'_, AppState>,
    session_id: i64,
    expected_version: i64,
    request_id: String,
) -> Result<ExtraOutcomeDto, IpcError> {
    let outcome = extra_finish_inner(&state, session_id, expected_version, &request_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        if let Err(error) = crate::run_startup_recovery(&state) {
            tracing::error!(
                error_code = error.code.as_str(),
                internal_cause = error.internal_cause(),
                "附加环节归档投影重放失败"
            );
        }
    });
    Ok(outcome)
}
