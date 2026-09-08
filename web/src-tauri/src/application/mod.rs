use book_learner_core::map::{AnchorSegment, MapEditOp};
use book_learner_core::mapgen::SpineChapter;
use book_learner_core::models::BookType;
use book_learner_core::prompts::FixedContext;
use book_learner_core::CoreError;
use rusqlite::OptionalExtension;

use crate::dto::{
    AnchorSegmentDto, AppSettingsDto, BlockSourceDto, BookDto, DailyTaskDto, EvaluationViewDto,
    ExportPreviewDto, ExportReportDto, ExtraOutcomeDto, FinalReportDto, ImportChunkDto,
    ImportResultDto, KnowledgeBlockDto, MapEditOpDto, MapProgressDto, MapRevisionDto, ProfileDto,
    ReplanDto, SessionViewDto, SpineChapterDto, StatsDetailDto, StatsDto, StudyPlanDto,
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
    // 先取书类型,再按类型取画像摘要(教材/方法论追加"个人情境",M2 T6)
    let (block_id, book_type, final_exam) = state.with_connection(|connection| {
        let view = book_learner_core::session::get_session(connection, session_id)?;
        let book_id = book_learner_core::models::get_block(connection, view.block_id)?.book_id;
        let (_, book_type) = book_learner_core::models::get_book_slug_type(connection, book_id)?;
        Ok((view.block_id, book_type, view.kind == "final_exam"))
    })?;
    let profile_summary = state
        .memory()
        .profile_summary_for(book_type)
        .map_err(IpcError::from)?;
    if final_exam {
        // 整书终评(M3 T1):上下文由会话自查全书地图,这里不算占位块的原文
        return Ok((
            FixedContext {
                profile_summary,
                block_title: "整书终评".into(),
                block_source_text: String::new(),
                eval_history: String::new(),
                related_weakpoints: String::new(),
                prereq_status: String::new(),
            },
            book_type,
        ));
    }
    state.with_connection(|connection| {
        let context = book_learner_core::session::fixed_context_for_block(
            connection,
            block_id,
            &profile_summary,
        )?;
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

/// 统计详情(M2 T7):三区一次取齐;`date` 仍由前端本地日历日提供。
pub fn stats_detail(state: &AppState, date: &str) -> Result<StatsDetailDto, IpcError> {
    state
        .with_connection(|connection| book_learner_core::stats::detail(connection, date))
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

/// 标记学完(M2 T8):计划冻结、复习照常;之后不能再设为主攻书。
pub fn finish_book(state: &AppState, book_id: i64) -> Result<(), IpcError> {
    state.with_connection(|connection| book_learner_core::library::finish_book(connection, book_id))
}

// ---- 学习者画像(M2 T6):读写 profile.md 四小节;写后经 outbox git_commit(由调用方触发后台重放)----

pub fn profile_get(state: &AppState) -> Result<ProfileDto, IpcError> {
    state
        .memory()
        .profile_sections()
        .map(Into::into)
        .map_err(IpcError::from)
}

pub fn profile_save(state: &AppState, profile: ProfileDto) -> Result<(), IpcError> {
    state
        .memory()
        .write_profile_sections(&profile.into())
        .map_err(IpcError::from)?;
    let op_id = format!("profile:{}", chrono::Utc::now().timestamp_millis());
    state.with_connection(|connection| {
        book_learner_core::projection::enqueue(
            connection,
            &op_id,
            "git_commit",
            &serde_json::json!({ "message": "profile: 更新学习者画像" }),
        )
    })
}

// ---- 通过后附加环节(M2 T5):回合复用 submit_turn;结束走整理 prompt 并入队归档投影 ----

pub fn extra_start(
    state: &AppState,
    block_id: i64,
    kind: &str,
    client_request_id: &str,
) -> Result<SessionViewDto, IpcError> {
    let kind = book_learner_core::extra::ExtraKind::parse(kind).map_err(IpcError::from)?;
    state
        .with_connection(|connection| {
            book_learner_core::extra::start(connection, block_id, kind, client_request_id)
        })
        .map(Into::into)
}

pub fn extra_finish(
    state: &AppState,
    session_id: i64,
    expected_version: i64,
    request_id: &str,
) -> Result<ExtraOutcomeDto, IpcError> {
    let (context, _) = session_context(state, session_id)?;
    let _job = state.jobs().begin();
    let (provider, policy) = state.ai_provider()?;
    let connection = state.open_connection()?;
    book_learner_core::extra::finish(
        &connection,
        provider.as_ref(),
        state.memory_root(),
        &policy,
        session_id,
        expected_version,
        request_id,
        &context,
    )
    .map(Into::into)
    .map_err(Into::into)
}

// ---- 整书终评(M3 T1):全部块通过后;回合复用 submit_turn;结束产出学习报告并归档 ----

pub fn final_exam_eligible(state: &AppState, book_id: i64) -> Result<bool, IpcError> {
    state.with_connection(|connection| book_learner_core::final_exam::eligible(connection, book_id))
}

pub fn final_exam_start(
    state: &AppState,
    book_id: i64,
    client_request_id: &str,
) -> Result<SessionViewDto, IpcError> {
    state
        .with_connection(|connection| {
            book_learner_core::final_exam::start(connection, book_id, client_request_id)
        })
        .map(Into::into)
}

pub fn final_exam_finish(
    state: &AppState,
    session_id: i64,
    expected_version: i64,
    request_id: &str,
) -> Result<FinalReportDto, IpcError> {
    let _job = state.jobs().begin();
    let (provider, policy) = state.ai_provider()?;
    let connection = state.open_connection()?;
    book_learner_core::final_exam::finish(
        &connection,
        provider.as_ref(),
        state.memory_root(),
        &policy,
        session_id,
        expected_version,
        request_id,
    )
    .map(Into::into)
    .map_err(Into::into)
}

// ---- Obsidian 导出(M3 T2):目标目录 = 设置项 obsidianVault(展开 ~);只读 SQLite 生成清单,增量写入 ----

/// 展开 `~`/`~/…` 为 HOME;core 不读环境变量,这里是唯一的展开点。
pub fn expand_home(raw: &str, home: Option<&std::path::Path>) -> std::path::PathBuf {
    if raw == "~" {
        return home
            .map(|h| h.to_path_buf())
            .unwrap_or_else(|| std::path::PathBuf::from(raw));
    }
    if let Some(rest) = raw.strip_prefix("~/") {
        if let Some(home) = home {
            return home.join(rest);
        }
    }
    std::path::PathBuf::from(raw)
}

fn export_target(state: &AppState) -> Result<std::path::PathBuf, IpcError> {
    let settings =
        state.with_connection(|connection| book_learner_core::settings::get_settings(connection))?;
    let home = std::env::var_os("HOME").map(std::path::PathBuf::from);
    let target = expand_home(settings.obsidian_vault.trim(), home.as_deref());
    if !target.is_absolute() {
        return Err(IpcError::invalid_request(
            "Obsidian 目标目录必须是绝对路径",
            format!("obsidianVault is relative: {}", target.display()),
        ));
    }
    Ok(target)
}

pub fn export_preview(state: &AppState, book_id: i64) -> Result<ExportPreviewDto, IpcError> {
    let target = export_target(state)?;
    let plan = state.with_connection(|connection| {
        book_learner_core::export::plan(connection, book_id, &target)
    })?;
    Ok(ExportPreviewDto {
        target: target.to_string_lossy().into_owned(),
        target_exists: target.is_dir(),
        dir: target.join(&plan.book_dir).to_string_lossy().into_owned(),
        files: plan.files.into_iter().map(|f| f.rel_path).collect(),
    })
}

pub fn export_obsidian(state: &AppState, book_id: i64) -> Result<ExportReportDto, IpcError> {
    let target = export_target(state)?;
    let _job = state.jobs().begin();
    let connection = state.open_connection()?;
    let plan =
        book_learner_core::export::plan(&connection, book_id, &target).map_err(IpcError::from)?;
    let report = book_learner_core::export::write(&plan).map_err(IpcError::from)?;
    Ok(ExportReportDto {
        dir: report.dir.to_string_lossy().into_owned(),
        written: report.written,
        unchanged: report.unchanged,
    })
}

/// 在 Finder 中显示本书的导出目录(只允许由设置 + 书名推导出的路径,不接受任意路径)。
pub fn export_reveal(state: &AppState, book_id: i64) -> Result<(), IpcError> {
    let preview = export_preview(state, book_id)?;
    let dir = std::path::PathBuf::from(&preview.dir);
    if !dir.is_dir() {
        return Err(IpcError::invalid_request(
            "还没有导出过这本书",
            format!("export dir missing: {}", dir.display()),
        ));
    }
    if cfg!(target_os = "macos") {
        std::process::Command::new("open")
            .arg(&dir)
            .spawn()
            .map_err(|error| IpcError::internal(format!("open failed: {error}")))?;
        Ok(())
    } else {
        Err(IpcError::invalid_request(
            "仅 macOS 支持在 Finder 中显示",
            "reveal unsupported on this platform",
        ))
    }
}
