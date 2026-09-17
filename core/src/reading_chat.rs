//! 阅读辅助对话「问书」(spec 2026-09-16):按书存话题/消息;每条用户消息一次 codex exec
//! (无状态,历史回合渲染进 system);话题提炼(第二批)把问答压成结构化条目,反哺 FixedContext。
use crate::ai::{AiProvider, CompletionRequest, Role};
use crate::orchestrate::{run_ai_json, run_ai_request, validate_client_id, AiPolicy};
use crate::{prompts, CoreError, Result};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior};
use std::path::Path;

/// 章节原文注入上限(字);超过时以带入文字为中心截 ±READING_QUOTE_WINDOW
pub const READING_CHAPTER_MAX_CHARS: usize = 6000;
pub const READING_QUOTE_WINDOW: usize = 3000;
/// 注入 system 的历史回合数(用户/助手各算一轮)
pub const READING_HISTORY_TURNS: usize = 8;
/// 注入问答 prompt 的理解状态条目上限
pub const READING_STATE_MAX: usize = 40;
/// 反哺费曼/评估时每块取的条目上限
pub const READING_NOTES_PER_BLOCK: usize = 10;
/// 终评画像摘要后追加的理解状态条目上限
pub const READING_FINAL_STATE_MAX: usize = 20;
pub const READING_TURN_TIMEOUT_SECS: u64 = 120;
pub const READING_DISTILL_TIMEOUT_SECS: u64 = 120;
/// 前端也截,这里兜底
pub const READING_QUOTE_MAX_CHARS: usize = 8000;
pub const READING_TEXT_MAX_CHARS: usize = 4000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReadingTopic {
    pub id: i64,
    pub book_id: i64,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub distilled_at: Option<String>,
    /// 有 assistant 回复且回复 id > distilled_up_to
    pub needs_distill: bool,
    pub anchor_href: String,
    pub anchor_block_id: Option<i64>,
    /// 首条用户提问前 20 字
    pub first_question: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReadingMessage {
    pub id: i64,
    pub topic_id: i64,
    pub role: String,
    pub text: String,
    pub quote: String,
    pub spine_href: String,
    pub block_id: Option<i64>,
    pub status: String,
    pub client_msg_id: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone)]
pub struct SendInput {
    pub book_id: i64,
    pub topic_id: Option<i64>,
    pub client_msg_id: String,
    pub text: String,
    pub quote: String,
    pub spine_href: String,
    pub block_id: Option<i64>,
}

/// AI 失败不是错误:user_message.status='failed'、assistant_message=None
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SendResult {
    pub topic_id: i64,
    pub user_message: ReadingMessage,
    pub assistant_message: Option<ReadingMessage>,
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn truncate_chars(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

/// 章节上下文窗口:不超过 max 时原样;否则以 quote(前 40 字)首次命中为中心截 ±window 字,命不中取章首 max 字;截断处加 …
pub fn chapter_window(text: &str, quote: &str, max: usize, window: usize) -> String {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= max {
        return text.to_string();
    }
    let needle: Vec<char> = quote.trim().chars().take(40).collect();
    let hit = if needle.is_empty() {
        None
    } else {
        chars
            .windows(needle.len())
            .position(|w| w == needle.as_slice())
    };
    match hit {
        Some(pos) => {
            let center = pos + needle.len() / 2;
            let start = center.saturating_sub(window);
            let end = (center + window).min(chars.len());
            let mut out = String::new();
            if start > 0 {
                out.push('…');
            }
            out.extend(&chars[start..end]);
            if end < chars.len() {
                out.push('…');
            }
            out
        }
        None => {
            let mut out: String = chars[..max].iter().collect();
            out.push('…');
            out
        }
    }
}

const MSG_COLS: &str =
    "id,topic_id,role,text,quote,spine_href,block_id,status,client_msg_id,created_at";

fn row_message(r: &rusqlite::Row<'_>) -> rusqlite::Result<ReadingMessage> {
    Ok(ReadingMessage {
        id: r.get(0)?,
        topic_id: r.get(1)?,
        role: r.get(2)?,
        text: r.get(3)?,
        quote: r.get(4)?,
        spine_href: r.get(5)?,
        block_id: r.get(6)?,
        status: r.get(7)?,
        client_msg_id: r.get(8)?,
        created_at: r.get(9)?,
    })
}

pub fn get_topic(conn: &Connection, id: i64) -> Result<ReadingTopic> {
    conn.query_row(
        "SELECT t.id,t.book_id,t.started_at,t.ended_at,t.distilled_at,t.distilled_up_to,t.anchor_href,t.anchor_block_id, \
         COALESCE((SELECT max(id) FROM reading_message m WHERE m.topic_id=t.id AND m.role='assistant' AND m.status='done'),0), \
         COALESCE((SELECT text FROM reading_message m WHERE m.topic_id=t.id AND m.role='user' ORDER BY id LIMIT 1),'') \
         FROM reading_topic t WHERE t.id=?1",
        [id],
        |r| {
            let distilled_up_to: i64 = r.get(5)?;
            let last_assistant: i64 = r.get(8)?;
            let first: String = r.get(9)?;
            Ok(ReadingTopic {
                id: r.get(0)?,
                book_id: r.get(1)?,
                started_at: r.get(2)?,
                ended_at: r.get(3)?,
                distilled_at: r.get(4)?,
                needs_distill: last_assistant > 0 && last_assistant > distilled_up_to,
                anchor_href: r.get(6)?,
                anchor_block_id: r.get(7)?,
                first_question: first.chars().take(20).collect(),
            })
        },
    )
    .optional()?
    .ok_or_else(|| CoreError::NotFound(format!("reading topic {id}")))
}

/// 该书全部话题,新在前
pub fn list_topics(conn: &Connection, book_id: i64) -> Result<Vec<ReadingTopic>> {
    let mut st = conn.prepare("SELECT id FROM reading_topic WHERE book_id=?1 ORDER BY id DESC")?;
    let ids: Vec<i64> = st
        .query_map([book_id], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    ids.into_iter().map(|id| get_topic(conn, id)).collect()
}

pub fn list_messages(conn: &Connection, topic_id: i64) -> Result<Vec<ReadingMessage>> {
    get_topic(conn, topic_id)?;
    let mut st = conn.prepare(&format!(
        "SELECT {MSG_COLS} FROM reading_message WHERE topic_id=?1 ORDER BY id"
    ))?;
    let rows = st.query_map([topic_id], row_message)?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

fn get_message(conn: &Connection, id: i64) -> Result<ReadingMessage> {
    conn.query_row(
        &format!("SELECT {MSG_COLS} FROM reading_message WHERE id=?1"),
        [id],
        row_message,
    )
    .optional()?
    .ok_or_else(|| CoreError::NotFound(format!("reading message {id}")))
}

/// 取话题:给定 id 须属于该书;缺省续该书 ended_at 为空的最新话题,没有则新建(锚点取首条消息的章节/块)
pub fn ensure_topic(
    conn: &Connection,
    book_id: i64,
    topic_id: Option<i64>,
    spine_href: &str,
    block_id: Option<i64>,
) -> Result<i64> {
    if let Some(id) = topic_id {
        let topic = get_topic(conn, id)?;
        if topic.book_id != book_id {
            return Err(CoreError::InvalidInput(format!(
                "topic {id} belongs to another book"
            )));
        }
        return Ok(id);
    }
    let open: Option<i64> = conn
        .query_row(
            "SELECT id FROM reading_topic WHERE book_id=?1 AND ended_at IS NULL ORDER BY id DESC LIMIT 1",
            [book_id],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(id) = open {
        return Ok(id);
    }
    let exists: Option<i64> = conn
        .query_row("SELECT 1 FROM book WHERE id=?1", [book_id], |r| r.get(0))
        .optional()?;
    if exists.is_none() {
        return Err(CoreError::NotFound(format!("book {book_id}")));
    }
    conn.execute(
        "INSERT INTO reading_topic(book_id,started_at,anchor_href,anchor_block_id) VALUES(?1,?2,?3,?4)",
        rusqlite::params![book_id, now(), spine_href, block_id],
    )?;
    Ok(conn.last_insert_rowid())
}

/// 「另起话题」:写 ended_at(幂等);提炼由调用方(第二批 distill_topic)接着做
pub fn end_topic(conn: &Connection, topic_id: i64) -> Result<()> {
    get_topic(conn, topic_id)?;
    conn.execute(
        "UPDATE reading_topic SET ended_at=COALESCE(ended_at,?2) WHERE id=?1",
        rusqlite::params![topic_id, now()],
    )?;
    Ok(())
}

// ---- 提炼(话题 → 理解画像条目)----

#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct DistilledFocus {
    #[serde(rename = "blockId", default)]
    pub block_id: Option<i64>,
    #[serde(default)]
    pub href: String,
    pub note: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct DistilledUnderstanding {
    #[serde(rename = "blockId", default)]
    pub block_id: Option<i64>,
    /// misconception | unclear | clarified(其它值归一为 unclear)
    #[serde(default)]
    pub kind: String,
    pub note: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Distilled {
    #[serde(default)]
    pub focus: Vec<DistilledFocus>,
    #[serde(default)]
    pub understanding: Vec<DistilledUnderstanding>,
    #[serde(default)]
    pub habits: Vec<String>,
}

pub fn kind_label(kind: &str) -> &'static str {
    match kind {
        "misconception" => "误解",
        "clarified" => "已澄清",
        _ => "未澄清",
    }
}

fn parse_distilled(text: &str) -> Result<Distilled> {
    let trimmed = text.trim();
    let json = trimmed
        .strip_prefix("```json")
        .or_else(|| trimmed.strip_prefix("```"))
        .and_then(|t| t.strip_suffix("```"))
        .unwrap_or(trimmed)
        .trim();
    let mut d: Distilled =
        serde_json::from_str(json).map_err(|e| CoreError::Ai(format!("distill json: {e}")))?;
    for u in &mut d.understanding {
        if !matches!(u.kind.as_str(), "misconception" | "unclear" | "clarified") {
            u.kind = "unclear".into();
        }
    }
    d.focus.retain(|f| !f.note.trim().is_empty());
    d.understanding.retain(|u| !u.note.trim().is_empty());
    d.habits.retain(|h| !h.trim().is_empty());
    Ok(d)
}

/// 需要提炼的话题:有 done 的 assistant 回复且回复 id > distilled_up_to(按 id 升序)
pub fn topics_needing_distill(conn: &Connection) -> Result<Vec<i64>> {
    let mut st = conn.prepare(
        "SELECT t.id FROM reading_topic t WHERE EXISTS(\
            SELECT 1 FROM reading_message m WHERE m.topic_id=t.id AND m.role='assistant' \
            AND m.status='done' AND m.id>t.distilled_up_to) ORDER BY t.id",
    )?;
    let ids = st.query_map([], |r| r.get(0))?;
    Ok(ids.collect::<rusqlite::Result<_>>()?)
}

/// 提炼一个话题:不需要提炼 → Ok(false);codex/解析失败 → Err(不改任何列,下次再跑);
/// 成功 → 写 distilled_json/distilled_at/distilled_up_to 并入队 sync_reading(op_id 带消息水位)
pub fn distill_topic(
    conn: &Connection,
    provider: &dyn AiProvider,
    workdir: &Path,
    policy: &AiPolicy,
    topic_id: i64,
) -> Result<bool> {
    if !conn.is_autocommit() {
        return Err(CoreError::Other(
            "distill_topic must not be called inside a transaction".into(),
        ));
    }
    let topic = get_topic(conn, topic_id)?;
    if !topic.needs_distill {
        return Ok(false);
    }
    let max_id: i64 = conn.query_row(
        "SELECT COALESCE(max(id),0) FROM reading_message WHERE topic_id=?1 AND status='done'",
        [topic_id],
        |r| r.get(0),
    )?;
    let book_title: String =
        conn.query_row("SELECT title FROM book WHERE id=?1", [topic.book_id], |r| {
            r.get(0)
        })?;
    let chapters = crate::mapgen::list_spine(conn, topic.book_id)?;
    let mut transcript = String::new();
    for m in list_messages(conn, topic_id)?
        .into_iter()
        .filter(|m| m.status == "done")
    {
        let who = if m.role == "assistant" {
            "助手"
        } else {
            "用户"
        };
        let chapter = chapters
            .iter()
            .find(|c| c.href == m.spine_href)
            .map(|c| c.title.clone())
            .unwrap_or_else(|| m.spine_href.clone());
        let block = m
            .block_id
            .map(|b| format!(" · 块 #{b}"))
            .unwrap_or_default();
        transcript.push_str(&format!("[{who} · {chapter}{block}]\n"));
        if !m.quote.is_empty() {
            transcript.push_str(&format!("引用:「{}」\n", m.quote));
        }
        transcript.push_str(&m.text);
        transcript.push_str("\n\n");
    }
    let req = CompletionRequest {
        system: prompts::reading_distill_prompt(&book_title, &transcript),
        messages: vec![],
        workdir: workdir.to_path_buf(),
        read_only: true,
        request_id: String::new(),
        timeout_secs: READING_DISTILL_TIMEOUT_SECS,
    };
    let distilled = run_ai_json(
        conn,
        provider,
        &format!("reading_distill:{topic_id}:m{max_id}"),
        "reading_distill",
        &req,
        policy,
        &parse_distilled,
    )?;
    let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate)?;
    tx.execute(
        "UPDATE reading_topic SET distilled_json=?2, distilled_at=?3, distilled_up_to=?4 WHERE id=?1",
        rusqlite::params![
            topic_id,
            serde_json::to_string(&distilled).unwrap_or_default(),
            now(),
            max_id
        ],
    )?;
    crate::projection::enqueue(
        &tx,
        &format!(
            "reading:{}:t{topic_id}:m{max_id}:sync_reading",
            topic.book_id
        ),
        "sync_reading",
        &serde_json::json!({ "book_id": topic.book_id }),
    )?;
    tx.commit()?;
    Ok(true)
}

/// 该书各话题已提炼的结果(按 distilled_at 新→旧),附提炼日期
pub fn distilled_topics(conn: &Connection, book_id: i64) -> Result<Vec<(String, Distilled)>> {
    let mut st = conn.prepare(
        "SELECT distilled_at, distilled_json FROM reading_topic \
         WHERE book_id=?1 AND distilled_json IS NOT NULL ORDER BY distilled_at DESC, id DESC",
    )?;
    let rows = st.query_map([book_id], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
    })?;
    let mut out = vec![];
    for row in rows {
        let (at, json) = row?;
        if let Ok(d) = serde_json::from_str::<Distilled>(&json) {
            out.push((at.chars().take(10).collect(), d));
        }
    }
    Ok(out)
}

/// 已提炼的理解状态条目(新→旧,最多 max 条):`- [日期] 块 #N · 误解:…`
pub fn understanding_lines(conn: &Connection, book_id: i64, max: usize) -> Result<Vec<String>> {
    let mut lines = vec![];
    for (date, d) in distilled_topics(conn, book_id)? {
        for u in d.understanding {
            let block = u
                .block_id
                .map(|b| format!("块 #{b} · "))
                .unwrap_or_default();
            lines.push(format!(
                "- [{date}] {block}{}:{}",
                kind_label(&u.kind),
                u.note
            ));
            if lines.len() >= max {
                return Ok(lines);
            }
        }
    }
    Ok(lines)
}

/// 反哺费曼/评估:该块相关的关注点与理解状态(新→旧,最多 max 条)
pub fn reading_notes_for_block(
    conn: &Connection,
    book_id: i64,
    block_id: i64,
    max: usize,
) -> Result<Vec<String>> {
    let mut lines = vec![];
    for (date, d) in distilled_topics(conn, book_id)? {
        for f in d.focus.iter().filter(|f| f.block_id == Some(block_id)) {
            lines.push(format!("- [{date}] 关注:{}", f.note));
        }
        for u in d
            .understanding
            .iter()
            .filter(|u| u.block_id == Some(block_id))
        {
            lines.push(format!("- [{date}] {}:{}", kind_label(&u.kind), u.note));
        }
        if lines.len() >= max {
            lines.truncate(max);
            break;
        }
    }
    Ok(lines)
}

/// 发送一条用户消息:①事务 A 落 pending user 行(同 topic+client id:done 重放 / pending|failed 续跑)
/// ②无事务调 codex ③事务 B 写 assistant 行、user 置 done;失败则 user 置 failed、assistant=None(不是错误)
pub fn send_message(
    conn: &Connection,
    provider: &dyn AiProvider,
    workdir: &Path,
    policy: &AiPolicy,
    input: &SendInput,
) -> Result<SendResult> {
    validate_client_id(&input.client_msg_id)?;
    if !conn.is_autocommit() {
        return Err(CoreError::Other(
            "send_message must not be called inside a transaction".into(),
        ));
    }
    let text = truncate_chars(input.text.trim(), READING_TEXT_MAX_CHARS);
    if text.is_empty() {
        return Err(CoreError::InvalidInput("empty reading question".into()));
    }
    let quote = truncate_chars(input.quote.trim(), READING_QUOTE_MAX_CHARS);
    let topic_id = ensure_topic(
        conn,
        input.book_id,
        input.topic_id,
        &input.spine_href,
        input.block_id,
    )?;
    // ① 幂等
    let existing: Option<(i64, String)> = conn
        .query_row(
            "SELECT id,status FROM reading_message WHERE topic_id=?1 AND client_msg_id=?2 AND role='user'",
            rusqlite::params![topic_id, input.client_msg_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let user_id = match existing {
        Some((id, status)) if status == "done" => {
            let assistant = conn
                .query_row(
                    &format!(
                        "SELECT {MSG_COLS} FROM reading_message WHERE topic_id=?1 AND role='assistant' AND id>?2 ORDER BY id LIMIT 1"
                    ),
                    rusqlite::params![topic_id, id],
                    row_message,
                )
                .optional()?;
            return Ok(SendResult {
                topic_id,
                user_message: get_message(conn, id)?,
                assistant_message: assistant,
            });
        }
        Some((id, _)) => {
            conn.execute(
                "UPDATE reading_message SET status='pending' WHERE id=?1",
                [id],
            )?;
            id
        }
        None => {
            let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate)?;
            tx.execute(
                "INSERT INTO reading_message(topic_id,role,text,quote,spine_href,block_id,status,client_msg_id,created_at) \
                 VALUES(?1,'user',?2,?3,?4,?5,'pending',?6,?7)",
                rusqlite::params![
                    topic_id,
                    text,
                    quote,
                    input.spine_href,
                    input.block_id,
                    input.client_msg_id,
                    now()
                ],
            )?;
            let id = tx.last_insert_rowid();
            tx.commit()?;
            id
        }
    };
    // ② 组 prompt(书名/类型、章节窗口、块名、理解状态、历史回合)
    let (book_title, book_type): (String, String) = conn.query_row(
        "SELECT title,type FROM book WHERE id=?1",
        [input.book_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    let chapter = crate::mapgen::list_spine(conn, input.book_id)?
        .into_iter()
        .find(|c| c.href == input.spine_href);
    let (chapter_title, chapter_text, truncated) = match chapter {
        Some(c) => {
            let windowed = chapter_window(
                &c.text,
                &quote,
                READING_CHAPTER_MAX_CHARS,
                READING_QUOTE_WINDOW,
            );
            let truncated = windowed.chars().count() < c.text.chars().count();
            (c.title, windowed, truncated)
        }
        None => (String::new(), String::new(), false),
    };
    let block_title = match input.block_id {
        Some(b) => crate::models::get_block(conn, b)
            .map(|k| k.title)
            .unwrap_or_default(),
        None => String::new(),
    };
    let understanding = understanding_lines(conn, input.book_id, READING_STATE_MAX)?;
    // 历史回合渲染进 system(ai::render_prompt 会把 Role::Assistant 标成“学生:”,不适合阅读助手);
    // messages 只放本条提问
    let mut st = conn.prepare(
        "SELECT role,text,quote FROM reading_message WHERE topic_id=?1 AND status='done' AND id<?2 ORDER BY id",
    )?;
    let all: Vec<(String, String, String)> = st
        .query_map(rusqlite::params![topic_id, user_id], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })?
        .collect::<rusqlite::Result<_>>()?;
    drop(st);
    let skip = all.len().saturating_sub(READING_HISTORY_TURNS * 2);
    let history: Vec<String> = all
        .into_iter()
        .skip(skip)
        .map(|(role, t, q)| {
            let who = if role == "assistant" {
                "助手"
            } else {
                "用户"
            };
            if role == "user" && !q.is_empty() {
                format!("{who}(引用「{q}」):{t}")
            } else {
                format!("{who}:{t}")
            }
        })
        .collect();
    let system = prompts::reading_system(&prompts::ReadingContext {
        book_title,
        book_type,
        chapter_title,
        chapter_text,
        truncated,
        block_title,
        quote: quote.clone(),
        understanding,
        history,
    });
    let question = if quote.is_empty() {
        text.clone()
    } else {
        format!("引用:「{quote}」\n\n{text}")
    };
    let req = CompletionRequest {
        system,
        messages: vec![(Role::User, question)],
        workdir: workdir.to_path_buf(),
        read_only: true,
        request_id: String::new(),
        timeout_secs: READING_TURN_TIMEOUT_SECS,
    };
    let accept = |t: &str| {
        if t.trim().is_empty() {
            Err(CoreError::Ai("empty reading reply".into()))
        } else {
            Ok(())
        }
    };
    let outcome = run_ai_request(
        conn,
        provider,
        &format!("reading:{topic_id}:{}", input.client_msg_id),
        "reading",
        &req,
        policy,
        &accept,
    );
    // ③ 落库
    let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate)?;
    let assistant_id = match outcome {
        Ok(o) => {
            tx.execute(
                "INSERT INTO reading_message(topic_id,role,text,spine_href,block_id,status,created_at) \
                 VALUES(?1,'assistant',?2,?3,?4,'done',?5)",
                rusqlite::params![
                    topic_id,
                    o.text().trim(),
                    input.spine_href,
                    input.block_id,
                    now()
                ],
            )?;
            let aid = tx.last_insert_rowid();
            tx.execute(
                "UPDATE reading_message SET status='done' WHERE id=?1",
                [user_id],
            )?;
            Some(aid)
        }
        Err(_) => {
            // 失败原因已由 orchestrate 记在 ai_request 表;这里只标状态
            tx.execute(
                "UPDATE reading_message SET status='failed' WHERE id=?1",
                [user_id],
            )?;
            None
        }
    };
    tx.commit()?;
    Ok(SendResult {
        topic_id,
        user_message: get_message(conn, user_id)?,
        assistant_message: assistant_id.map(|id| get_message(conn, id)).transpose()?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::{AiProvider, CompletionRequest};
    use crate::mapgen::{store_spine, SpineChapter};
    use std::sync::Mutex;

    struct Script(Mutex<Vec<crate::Result<String>>>);
    impl AiProvider for Script {
        fn complete(&self, req: &CompletionRequest) -> crate::Result<String> {
            if req.request_id.starts_with("reading_distill:") {
                assert!(
                    req.messages.is_empty(),
                    "提炼 prompt 在 system,messages 为空"
                );
            } else {
                assert!(req.system.contains("阅读助手"), "system 应为阅读助手");
                assert_eq!(req.messages.len(), 1, "messages 只放本条提问");
            }
            self.0.lock().unwrap().remove(0)
        }
    }
    /// 测试不重试:run_ai_request 默认对 CoreError::Ai 重试 2 次,会吃掉脚本里的下一条应答
    fn policy() -> AiPolicy {
        AiPolicy {
            max_transport_retries: 0,
            json_corrective_retries: 0,
            retry_backoff_ms: 0,
        }
    }
    fn setup() -> (Connection, i64) {
        let conn = crate::db::open_in_memory().unwrap();
        let book = crate::models::insert_book(
            &conn,
            "微观",
            "",
            crate::models::BookType::Textbook,
            "micro",
        )
        .unwrap();
        store_spine(
            &conn,
            book,
            &[SpineChapter {
                idx: 0,
                href: "ch0.xhtml".into(),
                title: "第一章".into(),
                text: "需求定律。".repeat(50),
            }],
        )
        .unwrap();
        (conn, book)
    }
    fn input(book: i64, topic: Option<i64>, id: &str, text: &str) -> SendInput {
        SendInput {
            book_id: book,
            topic_id: topic,
            client_msg_id: id.into(),
            text: text.into(),
            quote: "需求定律".into(),
            spine_href: "ch0.xhtml".into(),
            block_id: None,
        }
    }
    fn send(
        conn: &Connection,
        p: &dyn AiProvider,
        book: i64,
        topic: Option<i64>,
        id: &str,
        text: &str,
    ) -> SendResult {
        send_message(
            conn,
            p,
            Path::new("."),
            &policy(),
            &input(book, topic, id, text),
        )
        .unwrap()
    }

    #[test]
    fn send_creates_topic_and_stores_both_messages() {
        let (conn, book) = setup();
        let p = Script(Mutex::new(vec![Ok("需求定律是说…".into())]));
        let r = send(&conn, &p, book, None, "m1", "什么是需求定律");
        assert_eq!(r.user_message.status, "done");
        assert_eq!(r.user_message.quote, "需求定律");
        let a = r.assistant_message.expect("assistant");
        assert_eq!(a.text, "需求定律是说…");
        assert_eq!(a.spine_href, "ch0.xhtml");
        let topics = list_topics(&conn, book).unwrap();
        assert_eq!(topics.len(), 1);
        assert_eq!(topics[0].anchor_href, "ch0.xhtml");
        assert_eq!(topics[0].first_question, "什么是需求定律");
        assert!(topics[0].needs_distill, "有回复即需要提炼");
        assert!(topics[0].ended_at.is_none());
        assert_eq!(list_messages(&conn, r.topic_id).unwrap().len(), 2);
    }

    #[test]
    fn ai_failure_marks_user_failed_and_same_id_retries() {
        let (conn, book) = setup();
        let p = Script(Mutex::new(vec![
            Err(CoreError::Ai("down".into())),
            Ok("好了".into()),
        ]));
        let r1 = send(&conn, &p, book, None, "m1", "问");
        assert_eq!(r1.user_message.status, "failed");
        assert!(r1.assistant_message.is_none());
        assert!(!get_topic(&conn, r1.topic_id).unwrap().needs_distill);
        let r2 = send(&conn, &p, book, Some(r1.topic_id), "m1", "问");
        assert_eq!(r2.user_message.id, r1.user_message.id, "同 id 不重复落消息");
        assert_eq!(r2.user_message.status, "done");
        assert_eq!(r2.assistant_message.unwrap().text, "好了");
        assert_eq!(list_messages(&conn, r1.topic_id).unwrap().len(), 2);
        // done 后再发同 id → 重放,不再调 AI(脚本已空,调了会 panic)
        let r3 = send(&conn, &p, book, Some(r1.topic_id), "m1", "问");
        assert_eq!(r3.assistant_message.unwrap().text, "好了");
    }

    #[test]
    fn history_goes_into_system_prompt_not_messages() {
        let (conn, book) = setup();
        struct Capture(Mutex<Vec<String>>);
        impl AiProvider for Capture {
            fn complete(&self, req: &CompletionRequest) -> crate::Result<String> {
                self.0.lock().unwrap().push(req.system.clone());
                Ok(format!("答{}", self.0.lock().unwrap().len()))
            }
        }
        let p = Capture(Mutex::new(vec![]));
        let r1 = send(&conn, &p, book, None, "m1", "第一问");
        send(&conn, &p, book, Some(r1.topic_id), "m2", "第二问");
        let systems = p.0.lock().unwrap();
        assert!(!systems[0].contains("本话题此前的问答"));
        assert!(systems[1].contains("本话题此前的问答"));
        assert!(systems[1].contains("用户(引用「需求定律」):第一问"));
        assert!(systems[1].contains("助手:答1"));
        assert!(systems[1].contains("第一章"), "章节标题注入");
    }

    #[test]
    fn default_topic_is_latest_open_and_end_topic_starts_new() {
        let (conn, book) = setup();
        let p = Script(Mutex::new(vec![
            Ok("a".into()),
            Ok("b".into()),
            Ok("c".into()),
        ]));
        let r1 = send(&conn, &p, book, None, "m1", "一");
        let r2 = send(&conn, &p, book, None, "m2", "二");
        assert_eq!(r1.topic_id, r2.topic_id, "不带 topic_id 续最新未结束话题");
        end_topic(&conn, r1.topic_id).unwrap();
        let r3 = send(&conn, &p, book, None, "m3", "三");
        assert_ne!(r3.topic_id, r1.topic_id, "结束后新建");
        assert_eq!(list_topics(&conn, book).unwrap().len(), 2);
        assert_eq!(
            list_topics(&conn, book).unwrap()[0].id,
            r3.topic_id,
            "新在前"
        );
        // 空话题 end 也只写 ended_at,不报错(先结束 r3 的话题,ensure_topic 才会新建一个空的)
        end_topic(&conn, r3.topic_id).unwrap();
        let empty = ensure_topic(&conn, book, None, "ch0.xhtml", None).unwrap();
        assert_ne!(empty, r3.topic_id);
        end_topic(&conn, empty).unwrap();
        assert!(!get_topic(&conn, empty).unwrap().needs_distill);
        // 别的书的话题不能拿来续
        let other = crate::models::insert_book(
            &conn,
            "另一本",
            "",
            crate::models::BookType::Textbook,
            "other",
        )
        .unwrap();
        assert!(matches!(
            ensure_topic(&conn, other, Some(r1.topic_id), "", None).unwrap_err(),
            CoreError::InvalidInput(_)
        ));
    }

    #[test]
    fn chapter_context_is_windowed_around_quote() {
        let text = format!("{}关键句{}", "前".repeat(5000), "后".repeat(5000));
        let w = chapter_window(&text, "关键句", 6000, 3000);
        assert!(w.contains("关键句"));
        assert!(w.chars().count() <= 6000 + 20);
        assert!(w.starts_with('…') && w.ends_with('…'));
        let head = chapter_window(&text, "不存在", 6000, 3000);
        assert!(head.starts_with('前') && head.ends_with('…'));
        assert_eq!(chapter_window("短文", "x", 6000, 3000), "短文");
    }

    #[test]
    fn rejects_bad_client_id_and_empty_text_and_missing_book() {
        let (conn, book) = setup();
        let p = Script(Mutex::new(vec![]));
        let mut bad = input(book, None, "a:b", "x");
        assert!(matches!(
            send_message(&conn, &p, Path::new("."), &policy(), &bad).unwrap_err(),
            CoreError::InvalidInput(_)
        ));
        bad = input(book, None, "m", "   ");
        assert!(matches!(
            send_message(&conn, &p, Path::new("."), &policy(), &bad).unwrap_err(),
            CoreError::InvalidInput(_)
        ));
        bad = input(999, None, "m", "x");
        assert!(matches!(
            send_message(&conn, &p, Path::new("."), &policy(), &bad).unwrap_err(),
            CoreError::NotFound(_)
        ));
        assert!(matches!(
            list_messages(&conn, 999).unwrap_err(),
            CoreError::NotFound(_)
        ));
    }

    const DISTILL_JSON: &str = r#"{"focus":[{"blockId":1,"href":"ch0.xhtml","note":"问需求定律"}],"understanding":[{"blockId":1,"kind":"misconception","note":"把斜率当弹性"},{"blockId":1,"kind":"clarified","note":"弹性是百分比之比"},{"blockId":2,"kind":"odd","note":"别的块"}],"habits":["先要结论"]}"#;

    #[test]
    fn distill_writes_json_and_marks_up_to_and_is_skipped_without_new_messages() {
        let (conn, book) = setup();
        let p = Script(Mutex::new(vec![
            Ok("答".into()),
            Ok(format!("```json\n{DISTILL_JSON}\n```")),
            Ok("答2".into()),
            Ok(DISTILL_JSON.into()),
        ]));
        let r = send(&conn, &p, book, None, "m1", "问");
        assert!(get_topic(&conn, r.topic_id).unwrap().needs_distill);
        assert!(distill_topic(&conn, &p, Path::new("."), &policy(), r.topic_id).unwrap());
        let t = get_topic(&conn, r.topic_id).unwrap();
        assert!(!t.needs_distill && t.distilled_at.is_some());
        assert!(
            !distill_topic(&conn, &p, Path::new("."), &policy(), r.topic_id).unwrap(),
            "没新消息不再跑"
        );
        send(&conn, &p, book, Some(r.topic_id), "m2", "再问");
        assert!(get_topic(&conn, r.topic_id).unwrap().needs_distill);
        assert!(distill_topic(&conn, &p, Path::new("."), &policy(), r.topic_id).unwrap());
        // 两次提炼 → 两行 sync_reading(op_id 带水位,不会被 INSERT OR IGNORE 吞掉)
        let n: i64 = conn
            .query_row(
                "SELECT count(*) FROM projection_outbox WHERE kind='sync_reading'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 2);
        // 理解状态条目:kind 归一(odd → 未澄清)
        let lines = understanding_lines(&conn, book, 40).unwrap();
        assert!(
            lines
                .iter()
                .any(|l| l.contains("块 #1 · 误解:把斜率当弹性")),
            "{lines:?}"
        );
        assert!(lines.iter().any(|l| l.contains("块 #2 · 未澄清:别的块")));
        assert_eq!(understanding_lines(&conn, book, 1).unwrap().len(), 1);
        // 按块反哺
        let notes = reading_notes_for_block(&conn, book, 1, 10).unwrap();
        assert_eq!(notes.len(), 3, "{notes:?}");
        assert!(notes[0].contains("关注:问需求定律"));
        assert!(reading_notes_for_block(&conn, book, 3, 10)
            .unwrap()
            .is_empty());
        // 空话题 / 无回复不提炼(先结束当前话题,ensure_topic 才会新建一个空的)
        end_topic(&conn, r.topic_id).unwrap();
        let empty = ensure_topic(&conn, book, None, "ch0.xhtml", None).unwrap();
        assert_ne!(empty, r.topic_id);
        assert!(!distill_topic(&conn, &p, Path::new("."), &policy(), empty).unwrap());
        assert!(topics_needing_distill(&conn).unwrap().is_empty());
    }

    #[test]
    fn distill_failure_keeps_needs_distill() {
        let (conn, book) = setup();
        let p = Script(Mutex::new(vec![Ok("答".into()), Ok("not json".into())]));
        let r = send(&conn, &p, book, None, "m1", "问");
        assert!(distill_topic(&conn, &p, Path::new("."), &policy(), r.topic_id).is_err());
        let t = get_topic(&conn, r.topic_id).unwrap();
        assert!(t.needs_distill && t.distilled_at.is_none());
        assert_eq!(topics_needing_distill(&conn).unwrap(), vec![r.topic_id]);
    }
}
