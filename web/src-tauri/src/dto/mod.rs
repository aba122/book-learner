use book_learner_core::eval::Scores;
use book_learner_core::models::{Book, KnowledgeBlock};
use book_learner_core::planning::StudyPlan;
use book_learner_core::sched::DailyTask;
use book_learner_core::settings::AppSettings;
use serde::{Deserialize, Serialize};

use crate::error::IpcError;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookDto {
    pub id: i64,
    pub title: String,
    pub author: String,
    #[serde(rename = "type")]
    pub book_type: String,
    pub slug: String,
    pub status: String,
}

impl From<Book> for BookDto {
    fn from(book: Book) -> Self {
        let status = match book.status {
            book_learner_core::models::BookStatus::Active => "active",
            book_learner_core::models::BookStatus::Paused => "paused",
            book_learner_core::models::BookStatus::Finished => "finished",
        };
        Self {
            id: book.id,
            title: book.title,
            author: book.author,
            book_type: book.book_type.as_str().into(),
            slug: book.slug,
            status: status.into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScoresDto {
    pub accuracy: u8,
    pub completeness: u8,
    pub clarity: u8,
}

impl From<Scores> for ScoresDto {
    fn from(scores: Scores) -> Self {
        Self {
            accuracy: scores.accuracy,
            completeness: scores.completeness,
            clarity: scores.clarity,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeBlockDto {
    pub id: i64,
    pub book_id: i64,
    pub module_name: String,
    pub seq: i64,
    pub title: String,
    pub slug: String,
    pub prereq_ids: Vec<i64>,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scores: Option<ScoresDto>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub passed_at: Option<String>,
}

impl TryFrom<KnowledgeBlock> for KnowledgeBlockDto {
    type Error = IpcError;

    fn try_from(block: KnowledgeBlock) -> Result<Self, Self::Error> {
        if let Some(scores) = &block.scores {
            if [scores.accuracy, scores.completeness, scores.clarity]
                .iter()
                .any(|score| !(1..=5).contains(score))
            {
                return Err(IpcError::internal(
                    "knowledge block scores outside the persisted 1..=5 invariant",
                ));
            }
        }
        Ok(Self {
            id: block.id,
            book_id: block.book_id,
            module_name: block.module_name,
            seq: block.seq,
            title: block.title,
            slug: block.slug,
            prereq_ids: block.prereq_ids,
            status: block.status,
            scores: block.scores.map(Into::into),
            passed_at: block.passed_at,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DailyTaskDto {
    pub id: i64,
    pub book_id: i64,
    pub block_id: i64,
    pub kind: String,
    pub seq: i64,
    pub status: String,
    pub est_minutes: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ref_id: Option<i64>,
}

impl From<DailyTask> for DailyTaskDto {
    fn from(task: DailyTask) -> Self {
        Self {
            id: task.id,
            book_id: task.book_id,
            block_id: task.block_id,
            kind: task.kind,
            seq: task.seq,
            status: task.status,
            est_minutes: task.est_minutes,
            ref_id: task.ref_id,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StudyPlanRequest {
    pub book_id: i64,
    pub deadline: String,
    pub daily_new_blocks: i64,
    pub daily_cap: i64,
    pub remind_time: String,
}

impl From<StudyPlanRequest> for StudyPlan {
    fn from(request: StudyPlanRequest) -> Self {
        Self {
            book_id: request.book_id,
            deadline: request.deadline,
            daily_new_blocks: request.daily_new_blocks,
            daily_cap: request.daily_cap,
            remind_time: request.remind_time,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppSettingsDto {
    pub obsidian_vault: String,
    pub pomodoro_minutes: i64,
    pub break_minutes: i64,
    pub remind_time: String,
}

impl From<AppSettings> for AppSettingsDto {
    fn from(settings: AppSettings) -> Self {
        Self {
            obsidian_vault: settings.obsidian_vault,
            pomodoro_minutes: settings.pomodoro_minutes,
            break_minutes: settings.break_minutes,
            remind_time: settings.remind_time,
        }
    }
}

impl From<AppSettingsDto> for AppSettings {
    fn from(settings: AppSettingsDto) -> Self {
        Self {
            obsidian_vault: settings.obsidian_vault,
            pomodoro_minutes: settings.pomodoro_minutes,
            break_minutes: settings.break_minutes,
            remind_time: settings.remind_time,
        }
    }
}
