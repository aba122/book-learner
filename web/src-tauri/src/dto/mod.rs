use book_learner_core::eval::Scores;
use book_learner_core::map::{AnchorSegment, MapEditOp};
use book_learner_core::mapgen::{MapProgress, SpineChapter};
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
    pub map_revision: i64,
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
            map_revision: book.map_revision,
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
    pub skipped: bool,
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
            skipped: block.skipped,
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

// ---- 契约 v2 DTO(camelCase 镜像 core 结构;形状以 web/src/types.ts 为准)----

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SpineChapterDto {
    pub idx: i64,
    pub href: String,
    pub title: String,
    pub text: String,
}

impl From<SpineChapterDto> for SpineChapter {
    fn from(chapter: SpineChapterDto) -> Self {
        Self {
            idx: chapter.idx,
            href: chapter.href,
            title: chapter.title,
            text: chapter.text,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AnchorSegmentDto {
    pub spine_href: String,
    pub cfi_start: String,
    pub cfi_end: String,
    /// exact | chapter_fallback(core 落库时校验)
    pub precision: String,
    pub hint: String,
    pub text: String,
}

impl From<AnchorSegmentDto> for AnchorSegment {
    fn from(segment: AnchorSegmentDto) -> Self {
        Self {
            spine_href: segment.spine_href,
            cfi_start: segment.cfi_start,
            cfi_end: segment.cfi_end,
            precision: segment.precision,
            hint: segment.hint,
            text: segment.text,
        }
    }
}

impl From<AnchorSegment> for AnchorSegmentDto {
    fn from(segment: AnchorSegment) -> Self {
        Self {
            spine_href: segment.spine_href,
            cfi_start: segment.cfi_start,
            cfi_end: segment.cfi_end,
            precision: segment.precision,
            hint: segment.hint,
            text: segment.text,
        }
    }
}

/// 判别字段 `op` 及取值与 `web/src/types.ts` 的 `MapEditOp` 一致;字段名 camelCase。
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum MapEditOpDto {
    Rename { block_id: i64, title: String },
    RenameModule { from: String, to: String },
    Reorder { block_ids: Vec<i64> },
    SetSkipped { block_id: i64, skipped: bool },
    Merge { into: i64, from: Vec<i64> },
    Split { block_id: i64 },
}

impl From<MapEditOpDto> for MapEditOp {
    fn from(op: MapEditOpDto) -> Self {
        match op {
            MapEditOpDto::Rename { block_id, title } => Self::Rename { block_id, title },
            MapEditOpDto::RenameModule { from, to } => Self::RenameModule { from, to },
            MapEditOpDto::Reorder { block_ids } => Self::Reorder { block_ids },
            MapEditOpDto::SetSkipped { block_id, skipped } => {
                Self::SetSkipped { block_id, skipped }
            }
            MapEditOpDto::Merge { into, from } => Self::Merge { into, from },
            MapEditOpDto::Split { block_id } => Self::Split { block_id },
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct MapRevisionDto {
    pub revision: u64,
}

/// 地图作业进度(Tauri event `map_job_progress` 的 payload.progress;判别字段 `stage`)。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "stage",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum MapProgressDto {
    Chapter {
        index: usize,
        total: usize,
        title: String,
    },
    Merging,
    Done {
        blocks: usize,
    },
}

impl From<MapProgress> for MapProgressDto {
    fn from(progress: MapProgress) -> Self {
        match progress {
            MapProgress::Chapter {
                index,
                total,
                title,
            } => Self::Chapter {
                index,
                total,
                title,
            },
            MapProgress::Merging => Self::Merging,
            MapProgress::Done { blocks } => Self::Done { blocks },
        }
    }
}
