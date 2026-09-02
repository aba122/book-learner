use crate::dto::{AppSettingsDto, BookDto, DailyTaskDto, KnowledgeBlockDto, StudyPlanRequest};
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
