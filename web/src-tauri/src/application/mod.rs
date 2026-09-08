use book_learner_core::map::{AnchorSegment, MapEditOp};
use book_learner_core::mapgen::SpineChapter;
use book_learner_core::models::BookType;
use book_learner_core::prompts::FixedContext;
use book_learner_core::CoreError;
use rusqlite::OptionalExtension;

use crate::dto::{
    AnchorSegmentDto, AppSettingsDto, BlockSourceDto, BookDto, DailyTaskDto, EvaluationViewDto,
    ImportChunkDto, ImportResultDto, KnowledgeBlockDto, MapEditOpDto, MapProgressDto,
    MapRevisionDto, ReplanDto, SessionViewDto, SpineChapterDto, StatsDto, StudyPlanDto,
    StudyPlanRequest, TurnResultDto, VerdictOutcomeDto,
};
use crate::error::IpcError;
use crate::state::AppState;

pub fn list_books(state: &AppState) -> Result<Vec<BookDto>, IpcError> {
    state
        .with_connection(book_learner_core::models::list_books)
        .map(|books| books.into_iter().map(Into::into).collect())
}

pub fn set_active_book(state: &AppState, book_id: i64) -> Result<(), IpcError> {
    state.with_connection(|connection| {
        book_learner_core::library::set_active_book(connection, book_id)
    })
}

pub fn list_blocks(state: &AppState, book_id: i64) -> Result<Vec<KnowledgeBlockDto>, IpcError> {
    let blocks = state.with_connection(|connection| {
        book_learner_core::models::list_blocks(connection, book_id)
    })?;
    blocks.into_iter().map(TryInto::try_into).collect()
}

pub fn get_block(state: &AppState, block_id: i64) -> Result<KnowledgeBlockDto, IpcError> {
    state
        .with_connection(|connection| book_learner_core::models::get_block(connection, block_id))?
        .try_into()
}

pub fn set_plan(state: &AppState, request: StudyPlanRequest) -> Result<(), IpcError> {
    let plan = request.into();
    state.with_connection(|connection| book_learner_core::planning::set_plan(connection, &plan))
}

pub fn today_queue(state: &AppState, date: &str) -> Result<Vec<DailyTaskDto>, IpcError> {
    state
        .with_connection(|connection| book_learner_core::planning::today_queue(connection, date))
        .map(|tasks| tasks.into_iter().map(Into::into).collect())
}

pub fn get_settings(state: &AppState) -> Result<AppSettingsDto, IpcError> {
    state
        .with_connection(book_learner_core::settings::get_settings)
        .map(Into::into)
}

pub fn save_settings(state: &AppState, settings: AppSettingsDto) -> Result<(), IpcError> {
    let settings = settings.into();
    state.with_connection(|connection| {
        book_learner_core::settings::save_settings(connection, &settings)
    })
}

// ---- 地图组(M4):除地图作业外均为快速 DB 操作,走共享连接 ----

pub fn store_spine(
    state: &AppState,
    book_id: i64,
    chapters: Vec<SpineChapterDto>,
) -> Result<(), IpcError> {
    let chapters: Vec<SpineChapter> = chapters.into_iter().map(Into::into).collect();
    state.with_connection(|connection| {
        book_learner_core::mapgen::store_spine(connection, book_id, &chapters)
    })
}

pub fn confirm_map(
    state: &AppState,
    book_id: i64,
    expected_revision: i64,
    ops: Vec<MapEditOpDto>,
) -> Result<MapRevisionDto, IpcError> {
    let expected = u64::try_from(expected_revision).map_err(|_| {
        IpcError::invalid_request(
            "地图修订号无效",
            format!("expectedRevision {expected_revision} is negative"),
        )
    })?;
    let ops: Vec<MapEditOp> = ops.into_iter().map(Into::into).collect();
    state
        .with_connection(|connection| {
            book_learner_core::map::confirm_map(connection, book_id, expected, &ops)
        })
        .map(|revision| MapRevisionDto { revision })
}

pub fn set_anchor_segments(
    state: &AppState,
    block_id: i64,
    segments: Vec<AnchorSegmentDto>,
) -> Result<(), IpcError> {
    let segments: Vec<AnchorSegment> = segments.into_iter().map(Into::into).collect();
    state.with_connection(|connection| {
        book_learner_core::map::set_anchor_segments(connection, block_id, &segments)
    })
}

pub fn list_anchors(state: &AppState, block_id: i64) -> Result<Vec<AnchorSegmentDto>, IpcError> {
    state
        .with_connection(|connection| book_learner_core::map::list_anchors(connection, block_id))
        .map(|segments| segments.into_iter().map(Into::into).collect())
}

fn map_revision(state: &AppState, book_id: i64) -> Result<i64, IpcError> {
    state
        .with_connection(|connection| {
            Ok(connection
                .query_row(
                    "SELECT map_revision FROM book WHERE id=?1",
                    [book_id],
                    |row| row.get::<_, i64>(0),
                )
                .optional()?)
        })?
        .ok_or_else(|| IpcError::from(CoreError::NotFound(format!("book {book_id}"))))
}

/// 地图作业(慢命令):独立连接 + 注入/配置的 provider,AI 调用期间不持有共享连接守卫。
/// 已有地图(map_revision > 0)时直接返回块列表、不发进度、不重跑(与 MockBackend 语义一致);
/// 作业完成后落库草图,若并发下已被落库(Conflict)同样回退为返回现有块列表。
pub fn run_map_job(
    state: &AppState,
    book_id: i64,
    job_id: &str,
    on_progress: &mut dyn FnMut(MapProgressDto),
) -> Result<Vec<KnowledgeBlockDto>, IpcError> {
    if map_revision(state, book_id)? > 0 {
        return list_blocks(state, book_id);
    }
    let _job = state.jobs().begin();
    let (provider, policy) = state.ai_provider()?;
    let connection = state.open_connection()?;
    let draft = book_learner_core::mapgen::run_map_job(
        &connection,
        provider.as_ref(),
        state.memory_root(),
        book_id,
        job_id,
        &policy,
        &mut |progress| on_progress(progress.into()),
    )?;
    match book_learner_core::map::apply_draft_map(&connection, book_id, &draft) {
        Ok(_) | Err(CoreError::Conflict(_)) => {}
        Err(error) => return Err(error.into()),
    }
    list_blocks(state, book_id)
}

// ---- 会话组(M5):回合/评估为慢命令(独立连接 + provider),其余走共享连接 ----

pub fn start_or_resume_session(
    state: &AppState,
    task_id: i64,
    client_request_id: &str,
    date: &str,
) -> Result<SessionViewDto, IpcError> {
    state
        .with_connection(|connection| {
            book_learner_core::session::start_or_resume_session(
                connection,
                task_id,
                client_request_id,
                date,
            )
        })
        .map(Into::into)
}

/// 会话所属块的固定注入上下文与书类型:画像摘要取记忆库 `profile.md` 前两节。
fn session_context(
    state: &AppState,
    session_id: i64,
) -> Result<(FixedContext, BookType), IpcError> {
    let block_id = state
        .with_connection(|connection| {
            book_learner_core::session::get_session(connection, session_id)
        })?
        .block_id;
    let profile_summary = state.memory().profile_summary().map_err(IpcError::from)?;
    state.with_connection(|connection| {
        let context = book_learner_core::session::fixed_context_for_block(
            connection,
            block_id,
            &profile_summary,
        )?;
        let book_id = book_learner_core::models::get_block(connection, block_id)?.book_id;
        let (_, book_type) = book_learner_core::models::get_book_slug_type(connection, book_id)?;
        Ok((context, book_type))
    })
}

pub fn submit_turn(
    state: &AppState,
    session_id: i64,
    expected_version: i64,
    client_turn_id: &str,
    text: &str,
) -> Result<TurnResultDto, IpcError> {
    let (context, book_type) = session_context(state, session_id)?;
    let _job = state.jobs().begin();
    let (provider, policy) = state.ai_provider()?;
    let connection = state.open_connection()?;
    book_learner_core::session::submit_turn(
        &connection,
        provider.as_ref(),
        state.memory_root(),
        &policy,
        session_id,
        expected_version,
        client_turn_id,
        text,
        &context,
        book_type,
    )
    .map(Into::into)
    .map_err(Into::into)
}

pub fn request_evaluation(
    state: &AppState,
    session_id: i64,
    request_id: &str,
) -> Result<EvaluationViewDto, IpcError> {
    let (context, _) = session_context(state, session_id)?;
    let _job = state.jobs().begin();
    let (provider, policy) = state.ai_provider()?;
    let connection = state.open_connection()?;
    book_learner_core::verdict::request_evaluation(
        &connection,
        provider.as_ref(),
        state.memory_root(),
        &policy,
        session_id,
        request_id,
        &context,
    )
    .map(Into::into)
    .map_err(Into::into)
}

/// 判定确认(原子:块状态/任务/薄弱点/outbox 入队);投影重放由 command 层异步触发。
pub fn confirm_session_verdict(
    state: &AppState,
    session_id: i64,
    expected_version: i64,
    request_id: &str,
    pass: bool,
    date: &str,
) -> Result<VerdictOutcomeDto, IpcError> {
    state
        .with_connection(|connection| {
            book_learner_core::verdict::confirm_session_verdict(
                connection,
                session_id,
                expected_version,
                request_id,
                pass,
                date,
            )
        })
        .map(Into::into)
}

pub fn abandon_session(
    state: &AppState,
    session_id: i64,
    expected_version: i64,
) -> Result<(), IpcError> {
    state.with_connection(|connection| {
        book_learner_core::session::abandon_session(connection, session_id, expected_version)
    })
}

// ---- 导入与阅读器(M6):导入落盘走独立连接;路径与原文为快查询 ----

pub fn stage_import_chunk(
    state: &AppState,
    op_id: &str,
    index: u64,
    bytes: &[u8],
) -> Result<ImportChunkDto, IpcError> {
    state
        .import_store()
        .stage_chunk(op_id, index, bytes)
        .map(|staged_bytes| ImportChunkDto { staged_bytes })
}

pub fn finalize_import(
    state: &AppState,
    op_id: &str,
    book_type: &str,
    title: &str,
) -> Result<ImportResultDto, IpcError> {
    let book_type = BookType::from_db_str(book_type).map_err(|error| {
        IpcError::invalid_request("书籍类型无效", format!("bookType {book_type:?}: {error}"))
    })?;
    let _job = state.jobs().begin();
    let connection = state.open_connection()?;
    state
        .import_store()
        .finalize(&connection, op_id, book_type, title)
        .map(|book_id| ImportResultDto { book_id })
}

/// 受管 EPUB 的绝对路径(书行与文件都必须存在);前端经 convertFileSrc 转为 asset URL。
pub fn epub_path(state: &AppState, book_id: i64) -> Result<String, IpcError> {
    let exists: Option<i64> = state.with_connection(|connection| {
        Ok(connection
            .query_row("SELECT id FROM book WHERE id=?1", [book_id], |row| {
                row.get(0)
            })
            .optional()?)
    })?;
    if exists.is_none() {
        return Err(IpcError::from(CoreError::NotFound(format!(
            "book {book_id}"
        ))));
    }
    let path = state.import_store().book_path(book_id);
    if !path.is_file() {
        return Err(IpcError::from(CoreError::NotFound(format!(
            "epub file for book {book_id}"
        ))));
    }
    Ok(path.to_string_lossy().into_owned())
}

/// 块原文:exact 锚点段文本优先;否则整章 spine 文本。href 取首个锚点段。
pub fn block_source(state: &AppState, block_id: i64) -> Result<BlockSourceDto, IpcError> {
    state.with_connection(|connection| {
        let block = book_learner_core::models::get_block(connection, block_id)?;
        let anchors = book_learner_core::map::list_anchors(connection, block_id)?;
        let Some(first) = anchors.first() else {
            return Err(CoreError::NotFound(format!("anchors for block {block_id}")));
        };
        let href = first.spine_href.clone();
        let exact: Vec<&str> = anchors
            .iter()
            .filter(|segment| segment.precision == "exact" && !segment.text.trim().is_empty())
            .map(|segment| segment.text.trim())
            .collect();
        if !exact.is_empty() {
            return Ok(BlockSourceDto {
                href,
                text: exact.join("\n\n"),
            });
        }
        let chapter = book_learner_core::mapgen::list_spine(connection, block.book_id)?
            .into_iter()
            .find(|chapter| chapter.href == href)
            .ok_or_else(|| CoreError::NotFound(format!("spine chapter {href}")))?;
        Ok(BlockSourceDto {
            href,
            text: chapter.text,
        })
    })
}

/// 统计(M7):范围为主攻书;`date` 由前端本地日历日提供。
pub fn stats(state: &AppState, date: &str) -> Result<StatsDto, IpcError> {
    state
        .with_connection(|connection| book_learner_core::stats::compute(connection, date))
        .map(Into::into)
}

// ---- 落后重排(M2 T4):check_behind 有副作用(≤cap 时改写 daily_new_blocks),前端须在生成当日队列之前调用 ----

pub fn check_behind(state: &AppState, book_id: i64, date: &str) -> Result<ReplanDto, IpcError> {
    state
        .with_connection(|connection| {
            book_learner_core::sched::check_behind_report(connection, book_id, date)
        })
        .map(Into::into)
}

pub fn get_plan(state: &AppState, book_id: i64) -> Result<Option<StudyPlanDto>, IpcError> {
    state
        .with_connection(|connection| book_learner_core::planning::get_plan(connection, book_id))
        .map(|plan| plan.map(Into::into))
}
