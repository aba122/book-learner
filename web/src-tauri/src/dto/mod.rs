use book_learner_core::eval::{EvalResult, Scores, Verdict, WeakPointItem};
use book_learner_core::map::{AnchorSegment, MapEditOp};
use book_learner_core::mapgen::{MapProgress, SpineChapter};
use book_learner_core::memory::ProfileSections;
use book_learner_core::models::{Book, KnowledgeBlock};
use book_learner_core::planning::StudyPlan;
use book_learner_core::pomodoro::Snapshot;
use book_learner_core::sched::{DailyTask, Replan, ReplanReport};
use book_learner_core::session::{SessionView, TurnResult, TurnView};
use book_learner_core::settings::AppSettings;
use book_learner_core::stats::Stats;
use book_learner_core::verdict::{EvaluationView, VerdictOutcome};
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
    /// ready | staged | extracted | mapped(导入未完成 = staged/extracted)
    pub import_state: String,
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
            import_state: book.import_state,
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
    pub evening_remind_time: String,
}

impl From<AppSettings> for AppSettingsDto {
    fn from(settings: AppSettings) -> Self {
        Self {
            obsidian_vault: settings.obsidian_vault,
            pomodoro_minutes: settings.pomodoro_minutes,
            break_minutes: settings.break_minutes,
            remind_time: settings.remind_time,
            evening_remind_time: settings.evening_remind_time,
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
            evening_remind_time: settings.evening_remind_time,
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
    Delete { block_id: i64 },
    Split { block_id: i64, title_a: String, title_b: String },
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
            MapEditOpDto::Delete { block_id } => Self::Delete { block_id },
            MapEditOpDto::Split {
                block_id,
                title_a,
                title_b,
            } => Self::Split {
                block_id,
                title_a,
                title_b,
            },
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

// ---- 会话组 DTO(M5):camelCase 镜像 core;`clientTurnId`/`eval` 缺省时序列化为 null,非省略 ----

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EvalWeakPointDto {
    pub title: String,
    pub detail: String,
    pub fixed_in_session: bool,
}

impl From<WeakPointItem> for EvalWeakPointDto {
    fn from(item: WeakPointItem) -> Self {
        Self {
            title: item.title,
            detail: item.detail,
            fixed_in_session: item.fixed_in_session,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EvalResultDto {
    /// pass_suggested | relearn_suggested
    pub verdict: String,
    pub scores: ScoresDto,
    pub summary: String,
    pub weak_points: Vec<EvalWeakPointDto>,
    pub final_restatement: String,
    pub observation_note: String,
}

impl From<EvalResult> for EvalResultDto {
    fn from(eval: EvalResult) -> Self {
        let verdict = match eval.verdict {
            Verdict::PassSuggested => "pass_suggested",
            Verdict::RelearnSuggested => "relearn_suggested",
        };
        Self {
            verdict: verdict.into(),
            scores: eval.scores.into(),
            summary: eval.summary,
            weak_points: eval.weak_points.into_iter().map(Into::into).collect(),
            final_restatement: eval.final_restatement,
            observation_note: eval.observation_note,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnViewDto {
    pub role: String,
    pub text: String,
    pub status: String,
    pub client_turn_id: Option<String>,
    pub ready_to_end: bool,
}

impl From<TurnView> for TurnViewDto {
    fn from(turn: TurnView) -> Self {
        Self {
            role: turn.role,
            text: turn.text,
            status: turn.status,
            client_turn_id: turn.client_turn_id,
            ready_to_end: turn.ready_to_end,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionViewDto {
    pub session_id: i64,
    pub task_id: i64,
    pub version: i64,
    pub state: String,
    pub block_id: i64,
    pub kind: String,
    /// 通过后附加环节种类(M2 T5);普通会话为 null
    pub extra_kind: Option<String>,
    /// 整书终评所属的书(M3 T1);普通会话为 null
    pub book_id: Option<i64>,
    pub transcript: Vec<TurnViewDto>,
    pub eval: Option<EvalResultDto>,
}

impl From<SessionView> for SessionViewDto {
    fn from(view: SessionView) -> Self {
        Self {
            session_id: view.session_id,
            task_id: view.task_id,
            version: view.version,
            state: view.state,
            block_id: view.block_id,
            kind: view.kind,
            extra_kind: view.extra_kind,
            book_id: view.book_id,
            transcript: view.transcript.into_iter().map(Into::into).collect(),
            eval: view.eval.map(Into::into),
        }
    }
}

/// 附加环节结束产出(M2 T5)
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtraOutcomeDto {
    pub kind: String,
    pub artifact_id: i64,
    pub version: i64,
    pub content_md: String,
}

impl From<book_learner_core::extra::ExtraOutcome> for ExtraOutcomeDto {
    fn from(outcome: book_learner_core::extra::ExtraOutcome) -> Self {
        Self {
            kind: outcome.kind.as_str().to_string(),
            artifact_id: outcome.artifact_id,
            version: outcome.version,
            content_md: outcome.content_md,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnResultDto {
    pub student_text: String,
    pub ready_to_end: bool,
    pub version: i64,
}

impl From<TurnResult> for TurnResultDto {
    fn from(result: TurnResult) -> Self {
        Self {
            student_text: result.student_text,
            ready_to_end: result.ready_to_end,
            version: result.version,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EvaluationViewDto {
    pub eval: EvalResultDto,
    pub version: i64,
}

impl From<EvaluationView> for EvaluationViewDto {
    fn from(view: EvaluationView) -> Self {
        Self {
            eval: view.eval.into(),
            version: view.version,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerdictOutcomeDto {
    pub passed: bool,
    pub block_status: String,
    pub task_done: bool,
    pub outbox_ops: usize,
    pub version: i64,
}

impl From<VerdictOutcome> for VerdictOutcomeDto {
    fn from(outcome: VerdictOutcome) -> Self {
        Self {
            passed: outcome.passed,
            block_status: outcome.block_status,
            task_done: outcome.task_done,
            outbox_ops: outcome.outbox_ops,
            version: outcome.version,
        }
    }
}

// ---- 导入/阅读器 DTO(M6)----

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportChunkDto {
    pub staged_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResultDto {
    pub book_id: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockSourceDto {
    pub href: String,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsDto {
    pub total_blocks: i64,
    pub passed_blocks: i64,
    pub streak_days: i64,
    pub open_weak_points: i64,
    pub fixed_weak_points: i64,
    pub minutes_today: i64,
}

impl From<Stats> for StatsDto {
    fn from(stats: Stats) -> Self {
        Self {
            total_blocks: stats.total_blocks,
            passed_blocks: stats.passed_blocks,
            streak_days: stats.streak_days,
            open_weak_points: stats.open_weak_points,
            fixed_weak_points: stats.fixed_weak_points,
            minutes_today: stats.minutes_today,
        }
    }
}

// ---- 统计详情(M2 T7)----

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookProgressDto {
    pub id: i64,
    pub title: String,
    pub status: String,
    pub total: i64,
    pub passed: i64,
    pub consolidated: i64,
    pub deadline: Option<String>,
    pub projected_finish: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DayEffortDto {
    pub date: String,
    pub minutes: i64,
    pub pomodoros: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreakDayDto {
    pub date: String,
    pub active: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WeakTrendDayDto {
    pub date: String,
    pub opened: i64,
    pub fixed: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvgScoresDto {
    pub accuracy: f64,
    pub completeness: f64,
    pub clarity: f64,
    pub samples: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsDetailDto {
    pub books: Vec<BookProgressDto>,
    pub days: Vec<DayEffortDto>,
    pub streak_calendar: Vec<StreakDayDto>,
    pub weak_trend: Vec<WeakTrendDayDto>,
    pub avg_scores: Option<AvgScoresDto>,
    pub review_pass_rate: Option<f64>,
}

impl From<book_learner_core::stats::StatsDetail> for StatsDetailDto {
    fn from(detail: book_learner_core::stats::StatsDetail) -> Self {
        Self {
            books: detail
                .books
                .into_iter()
                .map(|b| BookProgressDto {
                    id: b.id,
                    title: b.title,
                    status: b.status,
                    total: b.total,
                    passed: b.passed,
                    consolidated: b.consolidated,
                    deadline: b.deadline,
                    projected_finish: b.projected_finish,
                })
                .collect(),
            days: detail
                .days
                .into_iter()
                .map(|d| DayEffortDto {
                    date: d.date,
                    minutes: d.minutes,
                    pomodoros: d.pomodoros,
                })
                .collect(),
            streak_calendar: detail
                .streak_calendar
                .into_iter()
                .map(|d| StreakDayDto {
                    date: d.date,
                    active: d.active,
                })
                .collect(),
            weak_trend: detail
                .weak_trend
                .into_iter()
                .map(|d| WeakTrendDayDto {
                    date: d.date,
                    opened: d.opened,
                    fixed: d.fixed,
                })
                .collect(),
            avg_scores: detail.avg_scores.map(|a| AvgScoresDto {
                accuracy: a.accuracy,
                completeness: a.completeness,
                clarity: a.clarity,
                samples: a.samples,
            }),
            review_pass_rate: detail.review_pass_rate,
        }
    }
}

// ---- 落后重排(M2 T4)----

/// `status`: on_track | auto_adjusted(附 newDaily)| needs_decision(附 requiredDaily)
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplanDto {
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub new_daily: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub required_daily: Option<i64>,
    pub daily_cap: i64,
    pub remaining_blocks: i64,
    pub remaining_days: i64,
    pub deadline: String,
}

impl From<ReplanReport> for ReplanDto {
    fn from(report: ReplanReport) -> Self {
        let (status, new_daily, required_daily) = match report.status {
            Replan::OnTrack => ("on_track", None, None),
            Replan::AutoAdjusted { new_daily } => ("auto_adjusted", Some(new_daily), None),
            Replan::NeedsDecision { required_daily, .. } => {
                ("needs_decision", None, Some(required_daily))
            }
        };
        Self {
            status: status.into(),
            new_daily,
            required_daily,
            daily_cap: report.daily_cap,
            remaining_blocks: report.remaining_blocks,
            remaining_days: report.remaining_days,
            deadline: report.deadline,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StudyPlanDto {
    pub book_id: i64,
    pub deadline: String,
    pub daily_new_blocks: i64,
    pub daily_cap: i64,
    pub remind_time: String,
}

impl From<StudyPlan> for StudyPlanDto {
    fn from(plan: StudyPlan) -> Self {
        Self {
            book_id: plan.book_id,
            deadline: plan.deadline,
            daily_new_blocks: plan.daily_new_blocks,
            daily_cap: plan.daily_cap,
            remind_time: plan.remind_time,
        }
    }
}

// ---- 番茄钟(M2 T3)----

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PomodoroSnapshotDto {
    /// idle | work | break | paused
    pub phase: String,
    pub task_id: Option<i64>,
    pub date: Option<String>,
    /// unix 秒;暂停/空闲时为 null
    pub ends_at: Option<i64>,
    pub remaining_secs: i64,
    pub paused_phase: Option<String>,
}

impl From<Snapshot> for PomodoroSnapshotDto {
    fn from(snapshot: Snapshot) -> Self {
        Self {
            phase: snapshot.phase,
            task_id: snapshot.task_id,
            date: snapshot.date,
            ends_at: snapshot.ends_at,
            remaining_secs: snapshot.remaining_secs,
            paused_phase: snapshot.paused_phase,
        }
    }
}

// ---- 学习者画像(M2 T6)----

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProfileDto {
    pub background: String,
    pub mastered: String,
    pub pitfalls: String,
    pub context: String,
}

impl From<ProfileSections> for ProfileDto {
    fn from(sections: ProfileSections) -> Self {
        Self {
            background: sections.background,
            mastered: sections.mastered,
            pitfalls: sections.pitfalls,
            context: sections.context,
        }
    }
}

impl From<ProfileDto> for ProfileSections {
    fn from(profile: ProfileDto) -> Self {
        Self {
            background: profile.background,
            mastered: profile.mastered,
            pitfalls: profile.pitfalls,
            context: profile.context,
        }
    }
}

/// 整书终评报告(M3 T1)
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FinalReportDto {
    pub artifact_id: i64,
    pub version: i64,
    pub content_md: String,
    pub overall: u8,
    pub strongest_module: String,
    pub weakest_module: String,
}

impl From<book_learner_core::final_exam::FinalReport> for FinalReportDto {
    fn from(report: book_learner_core::final_exam::FinalReport) -> Self {
        Self {
            artifact_id: report.artifact_id,
            version: report.version,
            content_md: report.content_md,
            overall: report.overall,
            strongest_module: report.strongest_module,
            weakest_module: report.weakest_module,
        }
    }
}

// ---- Obsidian 导出(M3 T2)----

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportPreviewDto {
    /// 目标目录(已展开 `~`)
    pub target: String,
    pub target_exists: bool,
    /// 本书导出目录(`<target>/<书名>`)
    pub dir: String,
    /// 相对目标目录的文件清单
    pub files: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportReportDto {
    pub dir: String,
    pub written: usize,
    pub unchanged: usize,
}

// ---- 数据安全(M3 T5):快照/恢复/git 远程 ----

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotDto {
    pub name: String,
    pub date: String,
    pub bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupListDto {
    pub snapshots: Vec<SnapshotDto>,
    /// 已登记、下次启动生效的恢复目标快照名
    pub pending_restore: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRemoteDto {
    pub url: Option<String>,
}

/// codex 可执行路径(M3 T6):`path` 为设置项(绝对路径或未设置),`resolved` 为当前实际解析到的路径,
/// 解析失败时 `error` 给用户文案。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexBinDto {
    pub path: Option<String>,
    pub resolved: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PushResultDto {
    /// true = 已推送;false = 推送失败(见 error)或无远程
    pub pushed: bool,
    pub error: Option<String>,
}

impl From<book_learner_core::backup::SnapshotInfo> for SnapshotDto {
    fn from(s: book_learner_core::backup::SnapshotInfo) -> Self {
        Self {
            name: s.name,
            date: s.date,
            bytes: s.bytes,
        }
    }
}

// ---- 阅读器标记(M3 T4)----

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReaderMarkDto {
    pub id: i64,
    pub book_id: i64,
    pub kind: String,
    pub spine_href: String,
    pub cfi_start: String,
    pub cfi_end: Option<String>,
    pub text: String,
    pub color: String,
    pub note: String,
    pub created_at: String,
    pub updated_at: String,
}

impl From<book_learner_core::reader_marks::ReaderMark> for ReaderMarkDto {
    fn from(m: book_learner_core::reader_marks::ReaderMark) -> Self {
        Self {
            id: m.id,
            book_id: m.book_id,
            kind: m.kind,
            spine_href: m.spine_href,
            cfi_start: m.cfi_start,
            cfi_end: m.cfi_end,
            text: m.text,
            color: m.color,
            note: m.note,
            created_at: m.created_at,
            updated_at: m.updated_at,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NewReaderMarkDto {
    pub kind: String,
    pub spine_href: String,
    pub cfi_start: String,
    #[serde(default)]
    pub cfi_end: Option<String>,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub color: String,
    #[serde(default)]
    pub note: String,
}

impl From<NewReaderMarkDto> for book_learner_core::reader_marks::NewMark {
    fn from(m: NewReaderMarkDto) -> Self {
        Self {
            kind: m.kind,
            spine_href: m.spine_href,
            cfi_start: m.cfi_start,
            cfi_end: m.cfi_end,
            text: m.text,
            color: m.color,
            note: m.note,
        }
    }
}
