//! 两阶段知识地图作业(TECH_DESIGN §6.1,ADR-0002/0003/0004):
//! Stage A 逐章(长章分片)→ Stage B 汇总;`map_job` 记录断点,任一失败后同 job_id 续跑;
//! AI 调用期间不持事务;core 只消费已抽取的 spine 文本(`spine_item`)。

use crate::ai::{AiProvider, CompletionRequest, MAX_PROMPT_BYTES};
use crate::eval::{parse_chapter_candidates, parse_draft_map, ChapterCandidate, DraftMap};
use crate::models::BookType;
use crate::orchestrate::{run_ai_json, validate_client_id, AiPolicy};
use crate::{prompts, CoreError, Result};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior};
use std::collections::HashMap;
use std::path::Path;

#[derive(Debug, Clone, PartialEq)]
pub struct SpineChapter {
    pub idx: i64,
    pub href: String,
    pub title: String,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq)]
pub enum MapProgress {
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

/// Stage A 单片文本上限(字节);超过的章按段落/字符边界切片,每片一个 ai_request
pub const STAGE_A_PIECE_BYTES: usize = 60 * 1024;
/// 地图生成每次调用超时(TECH_DESIGN §5.1:每章 300s)
const MAP_STAGE_TIMEOUT_SECS: u64 = 300;
const MAX_BLOCKS: usize = 200;

fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

/// 把已抽取的 spine 写入 `spine_item`(替换该书旧缓存),`import_state='extracted'`。
pub fn store_spine(conn: &Connection, book_id: i64, chapters: &[SpineChapter]) -> Result<()> {
    let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate)?;
    let exists = tx
        .query_row("SELECT 1 FROM book WHERE id=?1", [book_id], |r| {
            r.get::<_, i64>(0)
        })
        .optional()?;
    if exists.is_none() {
        return Err(CoreError::NotFound(format!("book {book_id}")));
    }
    tx.execute("DELETE FROM spine_item WHERE book_id=?1", [book_id])?;
    for ch in chapters {
        tx.execute(
            "INSERT INTO spine_item(book_id,idx,href,title,text) VALUES(?1,?2,?3,?4,?5)",
            rusqlite::params![book_id, ch.idx, ch.href, ch.title, ch.text],
        )?;
    }
    tx.execute(
        "UPDATE book SET import_state='extracted' WHERE id=?1",
        [book_id],
    )?;
    tx.commit()?;
    Ok(())
}

pub fn list_spine(conn: &Connection, book_id: i64) -> Result<Vec<SpineChapter>> {
    let mut st =
        conn.prepare("SELECT idx,href,title,text FROM spine_item WHERE book_id=?1 ORDER BY idx")?;
    let rows = st.query_map([book_id], |r| {
        Ok(SpineChapter {
            idx: r.get(0)?,
            href: r.get(1)?,
            title: r.get(2)?,
            text: r.get(3)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// `"{href}#{小节标题}"` / `"{章标题}#{小节标题}"` / `"{href}"` → (href, hint);无法匹配任何章 → None。
pub fn resolve_source_section(
    section: &str,
    chapters: &[SpineChapter],
) -> Option<(String, String)> {
    let (head, hint) = match section.split_once('#') {
        Some((h, t)) => (h.trim(), t.trim()),
        None => (section.trim(), ""),
    };
    if head.is_empty() {
        return None;
    }
    let found = chapters
        .iter()
        .find(|c| c.href == head)
        .or_else(|| chapters.iter().find(|c| c.title.trim() == head))
        .or_else(|| {
            chapters
                .iter()
                .find(|c| c.href.rsplit('/').next() == Some(head))
        })?;
    Some((found.href.clone(), hint.to_string()))
}

/// Stage B 输入压缩:去掉 summary 字段(标题/前置/来源保留)。
pub fn compact_candidates(candidates: &[ChapterCandidate]) -> serde_json::Value {
    serde_json::Value::Array(
        candidates
            .iter()
            .map(|c| {
                serde_json::json!({
                    "title": c.title,
                    "prereq_titles": c.prereq_titles,
                    "source_section": c.source_section,
                })
            })
            .collect(),
    )
}

/// 草图校验:块数 1..=200;标题非空且唯一;prereqs 存在且无环;source_sections 非空且可解析;每模块 ≥1 块。
pub fn validate_draft(draft: &DraftMap, chapters: &[SpineChapter]) -> Result<()> {
    let blocks: Vec<&crate::eval::DraftBlock> =
        draft.modules.iter().flat_map(|m| m.blocks.iter()).collect();
    if blocks.is_empty() || blocks.len() > MAX_BLOCKS {
        return Err(CoreError::InvalidInput(format!(
            "block count {} out of 1..={MAX_BLOCKS}",
            blocks.len()
        )));
    }
    for m in &draft.modules {
        if m.blocks.is_empty() {
            return Err(CoreError::InvalidInput(format!(
                "module {:?} has no blocks",
                m.name
            )));
        }
    }
    let mut index: HashMap<&str, usize> = HashMap::new();
    for (i, b) in blocks.iter().enumerate() {
        let title = b.title.trim();
        if title.is_empty() {
            return Err(CoreError::InvalidInput("empty block title".into()));
        }
        if index.insert(title, i).is_some() {
            return Err(CoreError::InvalidInput(format!(
                "duplicate block title: {title}"
            )));
        }
    }
    let mut unresolved = vec![];
    for b in &blocks {
        if b.source_sections.is_empty() {
            return Err(CoreError::InvalidInput(format!(
                "block {:?} has no source_sections",
                b.title
            )));
        }
        for s in &b.source_sections {
            if resolve_source_section(s, chapters).is_none() {
                unresolved.push(format!("{s} (block {})", b.title));
            }
        }
        for p in &b.prereqs {
            if !index.contains_key(p.trim()) {
                return Err(CoreError::InvalidInput(format!(
                    "unknown prereq {p:?} in block {:?}",
                    b.title
                )));
            }
        }
    }
    if !unresolved.is_empty() {
        return Err(CoreError::InvalidInput(format!(
            "unresolved source_section: {}",
            unresolved.join("; ")
        )));
    }
    // 环检测(三色 DFS)
    let mut color = vec![0u8; blocks.len()];
    fn dfs(
        i: usize,
        blocks: &[&crate::eval::DraftBlock],
        index: &HashMap<&str, usize>,
        color: &mut [u8],
    ) -> Option<String> {
        color[i] = 1;
        for p in &blocks[i].prereqs {
            let j = index[p.trim()];
            match color[j] {
                1 => return Some(blocks[j].title.clone()),
                0 => {
                    if let Some(t) = dfs(j, blocks, index, color) {
                        return Some(t);
                    }
                }
                _ => {}
            }
        }
        color[i] = 2;
        None
    }
    for i in 0..blocks.len() {
        if color[i] == 0 {
            if let Some(t) = dfs(i, &blocks, &index, &mut color) {
                return Err(CoreError::InvalidInput(format!(
                    "prerequisite cycle involving block {t:?}"
                )));
            }
        }
    }
    Ok(())
}

/// 按段落("\n\n")贪心切片,单段超限时按字符边界切;每片 ≤ STAGE_A_PIECE_BYTES。
fn split_pieces(text: &str) -> Vec<String> {
    if text.len() <= STAGE_A_PIECE_BYTES {
        return vec![text.to_string()];
    }
    let mut pieces = vec![];
    let mut current = String::new();
    let push_chunk = |chunk: &str, pieces: &mut Vec<String>, current: &mut String| {
        if !current.is_empty() && current.len() + 2 + chunk.len() > STAGE_A_PIECE_BYTES {
            pieces.push(std::mem::take(current));
        }
        if !current.is_empty() {
            current.push_str("\n\n");
        }
        current.push_str(chunk);
    };
    for para in text.split("\n\n") {
        if para.len() <= STAGE_A_PIECE_BYTES {
            push_chunk(para, &mut pieces, &mut current);
            continue;
        }
        // 超长段落:按字符边界硬切
        let mut start = 0;
        let mut last_ok = 0;
        for (i, _) in para.char_indices() {
            if i - start > STAGE_A_PIECE_BYTES {
                push_chunk(&para[start..last_ok], &mut pieces, &mut current);
                start = last_ok;
            }
            last_ok = i;
        }
        push_chunk(&para[start..], &mut pieces, &mut current);
    }
    if !current.is_empty() {
        pieces.push(current);
    }
    pieces
}

struct JobRow {
    book_id: i64,
    stage: String,
    next_chapter: i64,
    candidates_json: String,
    draft_json: Option<String>,
}

fn load_or_create_job(conn: &Connection, book_id: i64, job_id: &str) -> Result<JobRow> {
    let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate)?;
    let ts = now();
    tx.execute(
        "INSERT INTO map_job(book_id,job_id,stage,created_at,updated_at) VALUES(?1,?2,'chapters',?3,?3) \
         ON CONFLICT(job_id) DO NOTHING",
        rusqlite::params![book_id, job_id, ts],
    )?;
    let row = tx.query_row(
        "SELECT book_id,stage,next_chapter,candidates_json,draft_json FROM map_job WHERE job_id=?1",
        [job_id],
        |r| {
            Ok(JobRow {
                book_id: r.get(0)?,
                stage: r.get(1)?,
                next_chapter: r.get(2)?,
                candidates_json: r.get(3)?,
                draft_json: r.get(4)?,
            })
        },
    )?;
    tx.commit()?;
    if row.book_id != book_id {
        return Err(CoreError::Conflict(format!(
            "map job {job_id} belongs to book {}",
            row.book_id
        )));
    }
    Ok(row)
}

fn update_job(
    conn: &Connection,
    job_id: &str,
    sql_set: &str,
    params: &[&dyn rusqlite::ToSql],
) -> Result<()> {
    let sql = format!("UPDATE map_job SET {sql_set}, updated_at=? WHERE job_id=?");
    let ts = now();
    let mut all: Vec<&dyn rusqlite::ToSql> = params.to_vec();
    all.push(&ts);
    all.push(&job_id);
    conn.execute(&sql, all.as_slice())?;
    Ok(())
}

fn fail_job(conn: &Connection, job_id: &str, err: &CoreError) -> Result<()> {
    let msg = err.to_string();
    update_job(conn, job_id, "stage='failed', error=?", &[&msg])
}

fn request(workdir: &Path, system: String) -> CompletionRequest {
    CompletionRequest {
        system,
        messages: vec![],
        workdir: workdir.to_path_buf(),
        read_only: true,
        request_id: String::new(),
        timeout_secs: MAP_STAGE_TIMEOUT_SECS,
    }
}

fn stage_a_chapter(
    conn: &Connection,
    provider: &dyn AiProvider,
    workdir: &Path,
    ty: BookType,
    job_id: &str,
    ch: &SpineChapter,
    policy: &AiPolicy,
) -> Result<Vec<ChapterCandidate>> {
    let pieces = split_pieces(&ch.text);
    let mut out = vec![];
    for (k, piece) in pieces.iter().enumerate() {
        let (request_id, title) = if pieces.len() == 1 {
            (format!("map:{job_id}:ch{}", ch.idx), ch.title.clone())
        } else {
            (
                format!("map:{job_id}:ch{}:p{k}", ch.idx),
                format!("{}(第{}/{}段)", ch.title, k + 1, pieces.len()),
            )
        };
        let req = request(
            workdir,
            prompts::map_stage_a_prompt(ty, &ch.href, &title, piece),
        );
        let mut cands = run_ai_json(
            conn,
            provider,
            &request_id,
            "map_stage_a",
            &req,
            policy,
            &parse_chapter_candidates,
        )?;
        out.append(&mut cands);
    }
    Ok(out)
}

/// 运行/续跑地图作业(接口语义见计划 A5)。`workdir` 为 codex 工作目录(记忆库根)。
pub fn run_map_job(
    conn: &Connection,
    provider: &dyn AiProvider,
    workdir: &Path,
    book_id: i64,
    job_id: &str,
    policy: &AiPolicy,
    on_progress: &mut dyn FnMut(MapProgress),
) -> Result<DraftMap> {
    validate_client_id(job_id)?;
    if !conn.is_autocommit() {
        return Err(CoreError::Other(
            "run_map_job must not be called inside a transaction".into(),
        ));
    }
    let (_, ty) = crate::models::get_book_slug_type(conn, book_id).map_err(|e| match e {
        CoreError::Db(rusqlite::Error::QueryReturnedNoRows) => {
            CoreError::NotFound(format!("book {book_id}"))
        }
        other => other,
    })?;
    let chapters = list_spine(conn, book_id)?;
    if chapters.is_empty() {
        return Err(CoreError::InvalidInput(format!(
            "book {book_id} has no spine text stored"
        )));
    }
    let job = load_or_create_job(conn, book_id, job_id)?;
    if job.stage == "done" {
        if let Some(json) = job.draft_json.as_deref() {
            return parse_draft_map(json);
        }
    }
    let mut candidates: Vec<ChapterCandidate> = serde_json::from_str(&job.candidates_json)
        .map_err(|e| CoreError::Other(format!("corrupt map_job.candidates_json: {e}")))?;
    let next = job.next_chapter.max(0) as usize;
    if next > chapters.len() {
        let err =
            CoreError::InvalidInput("spine changed since the job started; start a new job".into());
        fail_job(conn, job_id, &err)?;
        return Err(err);
    }
    if job.stage != "merge" {
        for (idx, ch) in chapters.iter().enumerate().skip(next) {
            on_progress(MapProgress::Chapter {
                index: idx,
                total: chapters.len(),
                title: ch.title.clone(),
            });
            match stage_a_chapter(conn, provider, workdir, ty, job_id, ch, policy) {
                Ok(mut cands) => {
                    candidates.append(&mut cands);
                    let json = serde_json::to_string(&candidates)
                        .map_err(|e| CoreError::Other(e.to_string()))?;
                    let next_chapter = (idx + 1) as i64;
                    update_job(
                        conn,
                        job_id,
                        "stage='chapters', next_chapter=?, candidates_json=?, error=NULL",
                        &[&next_chapter, &json],
                    )?;
                }
                Err(e) => {
                    fail_job(conn, job_id, &e)?;
                    return Err(e);
                }
            }
        }
        update_job(conn, job_id, "stage='merge', error=NULL", &[])?;
    }
    on_progress(MapProgress::Merging);
    let full_json =
        serde_json::to_string(&candidates).map_err(|e| CoreError::Other(e.to_string()))?;
    let mut system = prompts::map_stage_b_prompt(ty, &full_json);
    if system.len() > MAX_PROMPT_BYTES {
        system = prompts::map_stage_b_prompt(ty, &compact_candidates(&candidates).to_string());
    }
    if system.len() > MAX_PROMPT_BYTES {
        let err = CoreError::InvalidInput(format!(
            "book too large for single merge: {} bytes after compaction (limit {MAX_PROMPT_BYTES})",
            system.len()
        ));
        fail_job(conn, job_id, &err)?;
        return Err(err);
    }
    let req = request(workdir, system);
    let parse = |text: &str| -> Result<DraftMap> {
        let draft = parse_draft_map(text)?;
        validate_draft(&draft, &chapters)?;
        Ok(draft)
    };
    match run_ai_json(
        conn,
        provider,
        &format!("map:{job_id}:merge"),
        "map_merge",
        &req,
        policy,
        &parse,
    ) {
        Ok(draft) => {
            let json =
                serde_json::to_string(&draft).map_err(|e| CoreError::Other(e.to_string()))?;
            let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate)?;
            tx.execute(
                "UPDATE map_job SET stage='done', draft_json=?2, error=NULL, updated_at=?3 WHERE job_id=?1",
                rusqlite::params![job_id, json, now()],
            )?;
            tx.execute(
                "UPDATE book SET import_state='mapped' WHERE id=?1",
                [book_id],
            )?;
            tx.commit()?;
            let blocks = draft.modules.iter().map(|m| m.blocks.len()).sum();
            on_progress(MapProgress::Done { blocks });
            Ok(draft)
        }
        Err(e) => {
            fail_job(conn, job_id, &e)?;
            Err(e)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::{AiProvider, CompletionRequest};
    use crate::eval::ChapterCandidate;
    use crate::orchestrate::AiPolicy;
    use crate::CoreError;
    use std::cell::RefCell;
    use std::collections::HashSet;

    /// 按 request_id 分发固定应答;记录调用顺序与每次 system 字节数
    struct MapMock {
        calls: RefCell<Vec<String>>,
        system_lens: RefCell<Vec<usize>>,
        fail_ids: RefCell<HashSet<String>>,
        merge_reply: RefCell<String>,
        stage_a: Box<dyn Fn(&str) -> String>,
    }
    impl MapMock {
        fn new(merge_reply: &str) -> Self {
            Self {
                calls: RefCell::new(vec![]),
                system_lens: RefCell::new(vec![]),
                fail_ids: RefCell::new(HashSet::new()),
                merge_reply: RefCell::new(merge_reply.to_string()),
                stage_a: Box::new(default_stage_a),
            }
        }
        fn calls_matching(&self, needle: &str) -> usize {
            self.calls
                .borrow()
                .iter()
                .filter(|c| c.contains(needle))
                .count()
        }
    }
    /// 默认阶段 A 应答:每章一条候选 C{idx},source_section 为 "{href}#S{idx}"
    fn default_stage_a(request_id: &str) -> String {
        let ch = request_id.split(":ch").nth(1).unwrap();
        let idx: usize = ch.split(':').next().unwrap().parse().unwrap();
        let piece = ch
            .split(":p")
            .nth(1)
            .map(|p| format!("-{p}"))
            .unwrap_or_default();
        format!(
            r#"[{{"title":"C{idx}{piece}","summary":"s","prereq_titles":[],"source_section":"ch{idx}.xhtml#S{idx}"}}]"#
        )
    }
    impl AiProvider for MapMock {
        fn complete(&self, req: &CompletionRequest) -> crate::Result<String> {
            self.calls.borrow_mut().push(req.request_id.clone());
            self.system_lens.borrow_mut().push(req.system.len());
            if self.fail_ids.borrow().contains(&req.request_id) {
                return Err(CoreError::Ai("simulated timeout".into()));
            }
            if req.request_id.ends_with(":merge") {
                Ok(self.merge_reply.borrow().clone())
            } else {
                Ok((self.stage_a)(&req.request_id))
            }
        }
    }
    const GOOD_MERGE: &str = r#"{"modules":[{"name":"M","blocks":[
        {"title":"C0","summary":"","source_sections":["ch0.xhtml#S0"],"prereqs":[]},
        {"title":"C1","summary":"","source_sections":["ch1.xhtml#S1"],"prereqs":["C0"]},
        {"title":"C2","summary":"","source_sections":["第二章#S2"],"prereqs":["C1"]}]}]}"#;

    fn chapters(n: usize) -> Vec<SpineChapter> {
        (0..n)
            .map(|i| SpineChapter {
                idx: i as i64,
                href: format!("ch{i}.xhtml"),
                title: format!("第{}章", ["零", "一", "二", "三"][i]),
                text: format!("第{i}章正文。\n\n第二段。"),
            })
            .collect()
    }
    fn setup(n: usize) -> (rusqlite::Connection, i64) {
        let conn = crate::db::open_in_memory().unwrap();
        let book =
            crate::models::insert_book(&conn, "书", "", crate::models::BookType::Textbook, "bk")
                .unwrap();
        store_spine(&conn, book, &chapters(n)).unwrap();
        (conn, book)
    }
    fn policy() -> AiPolicy {
        AiPolicy {
            retry_backoff_ms: 0,
            ..AiPolicy::default()
        }
    }
    fn job(conn: &rusqlite::Connection, job_id: &str) -> (String, i64, Option<String>) {
        conn.query_row(
            "SELECT stage,next_chapter,error FROM map_job WHERE job_id=?1",
            [job_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap()
    }
    fn import_state(conn: &rusqlite::Connection, book: i64) -> String {
        conn.query_row("SELECT import_state FROM book WHERE id=?1", [book], |r| {
            r.get(0)
        })
        .unwrap()
    }
    fn workdir() -> std::path::PathBuf {
        std::env::temp_dir()
    }

    #[test]
    fn three_chapters_run_a_thrice_then_b_once() {
        let (conn, book) = setup(3);
        let mock = MapMock::new(GOOD_MERGE);
        let mut events = vec![];
        let draft = run_map_job(
            &conn,
            &mock,
            &workdir(),
            book,
            "job1",
            &policy(),
            &mut |e| events.push(e),
        )
        .unwrap();
        assert_eq!(
            *mock.calls.borrow(),
            vec![
                "map:job1:ch0",
                "map:job1:ch1",
                "map:job1:ch2",
                "map:job1:merge"
            ]
        );
        assert!(matches!(
            events[0],
            MapProgress::Chapter {
                index: 0,
                total: 3,
                ..
            }
        ));
        assert!(matches!(
            events[2],
            MapProgress::Chapter {
                index: 2,
                total: 3,
                ..
            }
        ));
        assert_eq!(events[3], MapProgress::Merging);
        assert_eq!(events[4], MapProgress::Done { blocks: 3 });
        assert_eq!(draft.modules[0].blocks.len(), 3);
        assert_eq!(job(&conn, "job1").0, "done");
        assert_eq!(import_state(&conn, book), "mapped");
        let again = run_map_job(
            &conn,
            &mock,
            &workdir(),
            book,
            "job1",
            &policy(),
            &mut |_| {},
        )
        .unwrap();
        assert_eq!(again, draft);
        assert_eq!(mock.calls.borrow().len(), 4, "done 作业不再调 provider");
    }

    #[test]
    fn resume_after_crash_skips_finished_chapters() {
        let (conn, book) = setup(3);
        let mock = MapMock::new(GOOD_MERGE);
        mock.fail_ids.borrow_mut().insert("map:job1:ch2".into());
        let err = run_map_job(
            &conn,
            &mock,
            &workdir(),
            book,
            "job1",
            &policy(),
            &mut |_| {},
        )
        .unwrap_err();
        assert!(matches!(err, CoreError::Ai(_)));
        let (stage, next, error) = job(&conn, "job1");
        assert_eq!((stage.as_str(), next), ("failed", 2));
        assert!(error.unwrap().contains("timeout"));
        assert_eq!(mock.calls_matching(":ch2"), 3, "传输重试 3 次");
        mock.fail_ids.borrow_mut().clear();
        mock.calls.borrow_mut().clear();
        run_map_job(
            &conn,
            &mock,
            &workdir(),
            book,
            "job1",
            &policy(),
            &mut |_| {},
        )
        .unwrap();
        assert_eq!(*mock.calls.borrow(), vec!["map:job1:ch2", "map:job1:merge"]);
        assert_eq!(job(&conn, "job1").0, "done");
    }

    #[test]
    fn long_chapter_is_split_into_pieces() {
        let conn = crate::db::open_in_memory().unwrap();
        let book =
            crate::models::insert_book(&conn, "书", "", crate::models::BookType::Textbook, "bk")
                .unwrap();
        let paragraph = "弹性是需求量对价格变动的相对反应程度。".repeat(200); // ~11 KiB
        let long = std::iter::repeat_n(paragraph.as_str(), 14)
            .collect::<Vec<_>>()
            .join("\n\n"); // ~150 KiB
        store_spine(
            &conn,
            book,
            &[SpineChapter {
                idx: 0,
                href: "ch0.xhtml".into(),
                title: "长章".into(),
                text: long,
            }],
        )
        .unwrap();
        let mock = MapMock::new(
            r#"{"modules":[{"name":"M","blocks":[{"title":"C0-0","summary":"","source_sections":["ch0.xhtml#S0"],"prereqs":[]}]}]}"#,
        );
        run_map_job(
            &conn,
            &mock,
            &workdir(),
            book,
            "job1",
            &policy(),
            &mut |_| {},
        )
        .unwrap();
        let calls = mock.calls.borrow();
        let pieces: Vec<_> = calls.iter().filter(|c| c.contains(":ch0:p")).collect();
        assert_eq!(pieces.len(), 3, "{calls:?}");
        assert!(mock
            .system_lens
            .borrow()
            .iter()
            .all(|&l| l <= crate::ai::MAX_PROMPT_BYTES));
        let stored: String = conn
            .query_row(
                "SELECT candidates_json FROM map_job WHERE job_id='job1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let cands: Vec<ChapterCandidate> = serde_json::from_str(&stored).unwrap();
        let titles: Vec<_> = cands.iter().map(|c| c.title.as_str()).collect();
        assert_eq!(titles, ["C0-0", "C0-1", "C0-2"], "片内候选按片顺序合并");
    }

    #[test]
    fn invalid_draft_rejected_and_retry_calls_provider_again() {
        let cases = [
            (
                "cycle",
                r#"{"modules":[{"name":"M","blocks":[{"title":"C0","summary":"","source_sections":["ch0.xhtml#S0"],"prereqs":["C1"]},{"title":"C1","summary":"","source_sections":["ch1.xhtml#S1"],"prereqs":["C0"]}]}]}"#,
            ),
            (
                "duplicate",
                r#"{"modules":[{"name":"M","blocks":[{"title":"C0","summary":"","source_sections":["ch0.xhtml#S0"],"prereqs":[]},{"title":"C0","summary":"","source_sections":["ch1.xhtml#S1"],"prereqs":[]}]}]}"#,
            ),
            (
                "unresolved",
                r#"{"modules":[{"name":"M","blocks":[{"title":"C0","summary":"","source_sections":["nowhere.xhtml#S0"],"prereqs":[]}]}]}"#,
            ),
        ];
        for (reason, bad) in cases {
            let (conn, book) = setup(3);
            let mock = MapMock::new(bad);
            let err = run_map_job(
                &conn,
                &mock,
                &workdir(),
                book,
                "job1",
                &policy(),
                &mut |_| {},
            )
            .unwrap_err();
            assert!(matches!(err, CoreError::InvalidInput(_)), "{reason}: {err}");
            let (stage, _, error) = job(&conn, "job1");
            assert_eq!(stage, "failed", "{reason}");
            assert!(error.unwrap().contains(reason), "{reason}");
            assert_eq!(mock.calls_matching(":merge"), 2, "{reason}: 纠错重试一次");
            let status: String = conn
                .query_row(
                    "SELECT status FROM ai_request WHERE request_id='map:job1:merge'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(status, "failed", "{reason}: 语义无效不得记 done");
            *mock.merge_reply.borrow_mut() = GOOD_MERGE.to_string();
            mock.calls.borrow_mut().clear();
            run_map_job(
                &conn,
                &mock,
                &workdir(),
                book,
                "job1",
                &policy(),
                &mut |_| {},
            )
            .unwrap();
            assert_eq!(*mock.calls.borrow(), vec!["map:job1:merge"], "{reason}");
        }
    }

    #[test]
    fn store_spine_replaces_old_cache() {
        let (conn, book) = setup(3);
        let mut two = chapters(2);
        two[1].href = "ch0.xhtml".into(); // 同 href 两次出现允许
        store_spine(&conn, book, &two).unwrap();
        let rows = list_spine(&conn, book).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[1].href, "ch0.xhtml");
        assert_eq!(import_state(&conn, book), "extracted");
        assert!(matches!(
            store_spine(&conn, 999, &two).unwrap_err(),
            CoreError::NotFound(_)
        ));
    }

    #[test]
    fn resolve_source_section_formats() {
        let ch = chapters(3);
        assert_eq!(
            resolve_source_section("ch1.xhtml#1.2 弹性", &ch),
            Some(("ch1.xhtml".into(), "1.2 弹性".into()))
        );
        assert_eq!(
            resolve_source_section("第二章#S2", &ch),
            Some(("ch2.xhtml".into(), "S2".into()))
        );
        assert_eq!(
            resolve_source_section("ch0.xhtml", &ch),
            Some(("ch0.xhtml".into(), String::new()))
        );
        assert_eq!(resolve_source_section("nowhere#x", &ch), None);
    }

    #[test]
    fn oversized_merge_input_is_compacted_then_rejected() {
        // 三章候选各带 40 KiB summary:总量超限,去 summary 后可合并
        let (conn, book) = setup(3);
        let mut mock = MapMock::new(GOOD_MERGE);
        mock.stage_a = Box::new(|id: &str| {
            let idx = id.split(":ch").nth(1).unwrap();
            format!(
                r#"[{{"title":"C{idx}","summary":"{}","prereq_titles":[],"source_section":"ch{idx}.xhtml#S{idx}"}}]"#,
                "x".repeat(40 * 1024)
            )
        });
        run_map_job(
            &conn,
            &mock,
            &workdir(),
            book,
            "job1",
            &policy(),
            &mut |_| {},
        )
        .unwrap();
        let merge_len = *mock.system_lens.borrow().last().unwrap();
        assert!(merge_len <= crate::ai::MAX_PROMPT_BYTES);
        // 标题本身就超限:压缩无济于事 → 明确失败
        let (conn2, book2) = setup(3);
        let mut mock2 = MapMock::new(GOOD_MERGE);
        mock2.stage_a = Box::new(|id: &str| {
            let idx = id.split(":ch").nth(1).unwrap();
            format!(
                r#"[{{"title":"{}","summary":"","prereq_titles":[],"source_section":"ch{idx}.xhtml#S{idx}"}}]"#,
                "t".repeat(40 * 1024)
            )
        });
        let err = run_map_job(
            &conn2,
            &mock2,
            &workdir(),
            book2,
            "job2",
            &policy(),
            &mut |_| {},
        )
        .unwrap_err();
        assert!(
            matches!(&err, CoreError::InvalidInput(m) if m.contains("too large")),
            "{err}"
        );
        let (stage, _, error) = job(&conn2, "job2");
        assert_eq!(stage, "failed");
        assert!(error.unwrap().contains("too large"));
        assert_eq!(mock2.calls_matching(":merge"), 0);
    }
}
