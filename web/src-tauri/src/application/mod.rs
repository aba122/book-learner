use book_learner_core::map::{AnchorSegment, MapEditOp};
use book_learner_core::mapgen::SpineChapter;
use book_learner_core::CoreError;
use rusqlite::OptionalExtension;

use crate::dto::{
    AnchorSegmentDto, AppSettingsDto, BookDto, DailyTaskDto, KnowledgeBlockDto, MapEditOpDto,
    MapProgressDto, MapRevisionDto, SpineChapterDto, StudyPlanRequest,
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
