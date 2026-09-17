# 阅读辅助对话「问书」与阅读记忆 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 阅读器右栏新增「问书」面板:带入选文与 AI 自由问答,对话按书存 SQLite;话题提炼成结构化条目投影到 `books/<slug>/_reading.md`,并作为 `FixedContext.reading_notes` 反哺费曼/评估/复习/终评。

**Architecture:** 独立 core 模块 `reading_chat`(两张新表、问答与提炼两个 prompt、按 `distilled_up_to` 判定"需要提炼");壳层新增 5 条命令并做契约六处同步;前端 `ReadingChatPanel` 挂在阅读器右栏;记忆库写入经 projection outbox `sync_reading`;`fixed_context_for_block` 从 `reading_topic.distilled_json` 派生 `reading_notes`。规范:`docs/superpowers/specs/2026-09-16-reading-chat-design.md`。

**Tech Stack:** Rust(rusqlite、serde_json、chrono)、Tauri 2、React + TypeScript + Vitest、codex CLI(经 `ai::AiProvider`)。

**流程约定(本仓库)**:每批一个分支(`feat/reading-chat-1`、`feat/reading-chat-2`)→ 本地门禁(`bash /bigtemp/fzv6en/book-learner/webgate.sh`;`cargo test`/`cargo fmt --check`/`clippy -D warnings` 于 `core/`;壳层只能在 Mac 上 `cargo test`)→ DEVLOG → PR → `ci-merge.sh <PR>` → Mac 实测 → 用户说「换」再装。提交用 `git -c user.name="Chen Gong" -c user.email=cheng_abc@outlook.com commit`,推送用 `GIT_ASKPASS=/u/fzv6en/.ssh/codex-mac/askpass.sh git push`。Linux 上跑 `cargo test` 前后核对 `web/src-tauri/Cargo.lock` 未被改动。

---

## 文件地图

**core(`core/src/`)**
- `db.rs`:`SCHEMA_VERSION` 8→9,`SCHEMA_V9`(两张表 + 索引),迁移分支;现有断言 `user_version==8` 的测试改 9。
- `reading_chat.rs`(新):话题/消息模型与 SQL、`send`(两事务包 codex 调用)、`end_topic`、`needs_distill`、`distill`(第二批)、`reading_notes_for_block`(第二批)、章节截断。
- `prompts.rs`:`reading_system`、`reading_distill_prompt`(第二批);`FixedContext.reading_notes`(第二批)。
- `session.rs`:`fixed_context_for_block` 填 `reading_notes`(第二批)。
- `projection.rs`:`sync_reading` 分支(第二批)。
- `memory.rs`:`sync_reading` 与 INDEX 说明行(第二批)。
- `library.rs`:`delete_book` 显式删两表。
- `lib.rs`:`pub mod reading_chat;`。

**壳层(`web/src-tauri/`)**
- `src/dto/mod.rs`:`ReadingTopicDto`、`ReadingMessageDto`、`ReadingSendResultDto`、`DistillResultDto`。
- `src/application/mod.rs`:`reading_topics/messages/send/topic_end/distill`。
- `src/commands/mod.rs`:5 条 `*_inner` + `#[tauri::command]` + `WIRE_COMMANDS` 5 行。
- `src/lib.rs`:`generate_handler!` 加 5 项;`run_startup_recovery` 补跑提炼(第二批)。
- `tests/foundation.rs`:wire payload 5 项;EngineMock `reading:` / `reading_distill:` 分支;一条端到端用例。

**web(`web/src/`)**
- `types.ts`:`ReadingTopic`、`ReadingMessage`、`ReadingSendResult`。
- `backend/types.ts`、`backend/tauri.ts`(方法 + 解码 + 出站校验)、`backend/mock.ts`、`backend/contract.test.ts`、`backend/tauri.test.ts`(`NATIVE_METHODS` + payload 断言)。
- `config.ts`:`READING_QUOTE_MAX_CHARS`、`READING_TEXT_MAX_CHARS`、`READING_POLL_MS`、`READING_POLL_MAX_MS`。
- `features/reader/ReadingChatPanel.tsx`(新)+ `readingChat.test.tsx`(新);`ReaderPage.tsx`(右栏标签、「问 AI」、卸载触发);`reader.test.tsx`(侧栏存在性用例)。

**共享**:`shared/tauri-wire-contract.json` 5 行。

---

# 第一批:能聊、能存、能带入选文(分支 `feat/reading-chat-1`)

### Task 1: 迁移 v9 与 `reading_chat` 表

**Files:**
- Modify: `core/src/db.rs`(`SCHEMA_VERSION`、`migrate`、新增 `SCHEMA_V9`、测试断言)

- [ ] **Step 1: 写失败测试**(追加到 `core/src/db.rs` 的 `mod tests`)

```rust
#[test]
fn v9_creates_reading_tables_with_cascade() {
    let conn = open_in_memory().unwrap();
    let v: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
    assert_eq!(v, 9);
    let book = crate::models::insert_book(&conn, "书", "", crate::models::BookType::Textbook, "bk").unwrap();
    conn.execute(
        "INSERT INTO reading_topic(book_id,started_at) VALUES(?1,'2026-09-16T00:00:00Z')",
        [book],
    ).unwrap();
    let topic = conn.last_insert_rowid();
    conn.execute(
        "INSERT INTO reading_message(topic_id,role,text,created_at,client_msg_id) VALUES(?1,'user','为什么','2026-09-16T00:00:01Z','m1')",
        [topic],
    ).unwrap();
    // 同话题同 client_msg_id 唯一
    assert!(conn.execute(
        "INSERT INTO reading_message(topic_id,role,text,created_at,client_msg_id) VALUES(?1,'user','again','2026-09-16T00:00:02Z','m1')",
        [topic],
    ).is_err());
    conn.execute("DELETE FROM book WHERE id=?1", [book]).unwrap();
    let n: i64 = conn.query_row("SELECT count(*) FROM reading_message", [], |r| r.get(0)).unwrap();
    assert_eq!(n, 0, "删书级联到消息");
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd core && cargo test -q v9_creates_reading_tables`
Expected: FAIL(`user_version` 为 8 / 表不存在)

- [ ] **Step 3: 实现**

`SCHEMA_VERSION` 改 9;`migrate` 里在 `if v < 8 {…}` 之后加:

```rust
    if v < 9 {
        tx.execute_batch(SCHEMA_V9)?;
        tx.pragma_update(None, "user_version", 9)?;
    }
```

在 `SCHEMA_V8` 之后加:

```rust
/// v9(问书):阅读辅助对话的话题与消息;提炼结果存 distilled_json,distilled_up_to 记录已提炼到的消息 id
const SCHEMA_V9: &str = r#"
CREATE TABLE reading_topic(
  id INTEGER PRIMARY KEY,
  book_id INTEGER NOT NULL REFERENCES book(id) ON DELETE CASCADE,
  started_at TEXT NOT NULL, ended_at TEXT,
  distilled_at TEXT, distilled_json TEXT, distilled_up_to INTEGER NOT NULL DEFAULT 0,
  anchor_href TEXT NOT NULL DEFAULT '',
  anchor_block_id INTEGER REFERENCES knowledge_block(id) ON DELETE SET NULL);
CREATE INDEX reading_topic_book ON reading_topic(book_id, id);
CREATE TABLE reading_message(
  id INTEGER PRIMARY KEY,
  topic_id INTEGER NOT NULL REFERENCES reading_topic(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('user','assistant')),
  text TEXT NOT NULL, quote TEXT NOT NULL DEFAULT '',
  spine_href TEXT NOT NULL DEFAULT '',
  block_id INTEGER REFERENCES knowledge_block(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'done' CHECK(status IN ('pending','done','failed')),
  client_msg_id TEXT, created_at TEXT NOT NULL);
CREATE INDEX reading_message_topic ON reading_message(topic_id, id);
CREATE UNIQUE INDEX reading_message_client ON reading_message(topic_id, client_msg_id) WHERE client_msg_id IS NOT NULL;
"#;
```

把 `db.rs` 测试里所有 `assert_eq!(…user_version…, 8)` 改成 9(`grep -n "8)" core/src/db.rs` 逐条核对)。

- [ ] **Step 4: 跑全部 core 测试**

Run: `cd core && cargo test -q 2>&1 | grep -E "test result|FAILED|panicked"`
Expected: 全部 `ok`

- [ ] **Step 5: 提交**

```bash
git add core/src/db.rs
git commit -m "feat(core): v9 迁移——reading_topic / reading_message(问书)"
```

### Task 2: core 模块 `reading_chat`——话题、消息、发送(两事务包 codex)

**Files:**
- Create: `core/src/reading_chat.rs`
- Modify: `core/src/lib.rs`(`pub mod reading_chat;`)、`core/src/prompts.rs`(`reading_system`)、`core/src/library.rs`(删书显式删表)

- [ ] **Step 1: 写失败测试**(`core/src/reading_chat.rs` 底部 `mod tests`;先只写文件骨架 + 测试)

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::{AiProvider, CompletionRequest};
    use crate::mapgen::{store_spine, SpineChapter};
    use crate::orchestrate::AiPolicy;
    use std::sync::Mutex;

    struct Script(Mutex<Vec<crate::Result<String>>>);
    impl AiProvider for Script {
        fn complete(&self, req: &CompletionRequest) -> crate::Result<String> {
            assert!(req.system.contains("阅读助手"));
            self.0.lock().unwrap().remove(0)
        }
    }
    fn setup() -> (rusqlite::Connection, i64) {
        let conn = crate::db::open_in_memory().unwrap();
        let book = crate::models::insert_book(&conn, "微观", "", crate::models::BookType::Textbook, "micro").unwrap();
        store_spine(&conn, book, &[SpineChapter { idx: 0, href: "ch0.xhtml".into(), title: "第一章".into(), text: "需求定律。".repeat(50) }]).unwrap();
        (conn, book)
    }
    /// 测试不重试:run_ai_request 默认对 CoreError::Ai 重试 2 次、run_ai_json 纠错重试 1 次,会吃掉脚本里的下一条应答
    fn policy() -> AiPolicy {
        AiPolicy { max_transport_retries: 0, json_corrective_retries: 0, retry_backoff_ms: 0 }
    }
    fn send(conn: &rusqlite::Connection, p: &dyn AiProvider, book: i64, topic: Option<i64>, id: &str, text: &str) -> SendResult {
        send_message(conn, p, std::path::Path::new("."), &policy(), &SendInput {
            book_id: book, topic_id: topic, client_msg_id: id.into(), text: text.into(),
            quote: "需求定律".into(), spine_href: "ch0.xhtml".into(), block_id: None,
        }).unwrap()
    }

    #[test]
    fn send_creates_topic_and_stores_both_messages() {
        let (conn, book) = setup();
        let p = Script(Mutex::new(vec![Ok("需求定律是说…".into())]));
        let r = send(&conn, &p, book, None, "m1", "什么是需求定律");
        assert_eq!(r.user_message.status, "done");
        let a = r.assistant_message.expect("assistant");
        assert_eq!(a.text, "需求定律是说…");
        let topics = list_topics(&conn, book).unwrap();
        assert_eq!(topics.len(), 1);
        assert_eq!(topics[0].anchor_href, "ch0.xhtml");
        assert_eq!(topics[0].first_question, "什么是需求定律");
        assert!(topics[0].needs_distill, "有回复即需要提炼");
        assert_eq!(list_messages(&conn, r.topic_id).unwrap().len(), 2);
    }

    #[test]
    fn ai_failure_marks_user_failed_and_same_id_retries() {
        let (conn, book) = setup();
        let p = Script(Mutex::new(vec![Err(crate::CoreError::Ai("down".into())), Ok("好了".into())]));
        let r1 = send(&conn, &p, book, None, "m1", "问");
        assert_eq!(r1.user_message.status, "failed");
        assert!(r1.assistant_message.is_none());
        let r2 = send(&conn, &p, book, Some(r1.topic_id), "m1", "问");
        assert_eq!(r2.user_message.id, r1.user_message.id, "同 id 不重复落消息");
        assert_eq!(r2.assistant_message.unwrap().text, "好了");
        assert_eq!(list_messages(&conn, r1.topic_id).unwrap().len(), 2);
        // done 后再发同 id → 重放
        let r3 = send(&conn, &p, book, Some(r1.topic_id), "m1", "问");
        assert_eq!(r3.assistant_message.unwrap().text, "好了");
    }

    #[test]
    fn default_topic_is_latest_open_and_end_topic_starts_new() {
        let (conn, book) = setup();
        let p = Script(Mutex::new(vec![Ok("a".into()), Ok("b".into()), Ok("c".into())]));
        let r1 = send(&conn, &p, book, None, "m1", "一");
        let r2 = send(&conn, &p, book, None, "m2", "二");
        assert_eq!(r1.topic_id, r2.topic_id, "不带 topic_id 续最新未结束话题");
        end_topic(&conn, r1.topic_id).unwrap();
        let r3 = send(&conn, &p, book, None, "m3", "三");
        assert_ne!(r3.topic_id, r1.topic_id, "结束后新建");
        assert_eq!(list_topics(&conn, book).unwrap().len(), 2);
        // 空话题 end 也只写 ended_at,不报错(先结束 r3 的话题,ensure_topic 才会新建一个空的)
        end_topic(&conn, r3.topic_id).unwrap();
        let empty = ensure_topic(&conn, book, None, "ch0.xhtml", None).unwrap();
        assert_ne!(empty, r3.topic_id);
        end_topic(&conn, empty).unwrap();
    }

    #[test]
    fn chapter_context_is_windowed_around_quote() {
        let text = format!("{}关键句{}", "前".repeat(5000), "后".repeat(5000));
        let w = chapter_window(&text, "关键句", 6000, 3000);
        assert!(w.contains("关键句"));
        assert!(w.chars().count() <= 6000 + 20);
        assert!(w.starts_with("…") && w.ends_with("…"));
        let head = chapter_window(&text, "不存在", 6000, 3000);
        assert!(head.starts_with("前") && head.ends_with("…"));
        assert_eq!(chapter_window("短文", "x", 6000, 3000), "短文");
    }

    #[test]
    fn rejects_bad_client_id_and_empty_text() {
        let (conn, book) = setup();
        let p = Script(Mutex::new(vec![]));
        let bad = send_message(&conn, &p, std::path::Path::new("."), &policy(), &SendInput {
            book_id: book, topic_id: None, client_msg_id: "a:b".into(), text: "x".into(),
            quote: String::new(), spine_href: String::new(), block_id: None,
        });
        assert!(matches!(bad.unwrap_err(), crate::CoreError::InvalidInput(_)));
        let empty = send_message(&conn, &p, std::path::Path::new("."), &policy(), &SendInput {
            book_id: book, topic_id: None, client_msg_id: "m".into(), text: "  ".into(),
            quote: String::new(), spine_href: String::new(), block_id: None,
        });
        assert!(matches!(empty.unwrap_err(), crate::CoreError::InvalidInput(_)));
    }
}
```

- [ ] **Step 2: 跑测试确认编译失败**

Run: `cd core && cargo test -q reading_chat 2>&1 | head -5`
Expected: 编译错误(模块/函数不存在)

- [ ] **Step 3: 实现模块**(`core/src/reading_chat.rs`)

```rust
//! 阅读辅助对话「问书」(spec 2026-09-16):按书存话题/消息;每条用户消息一次 codex exec;
//! 提炼(第二批)把话题压成结构化条目,反哺 FixedContext。
use crate::ai::{AiProvider, CompletionRequest, Role};
use crate::orchestrate::{run_ai_request, validate_client_id, AiPolicy};
use crate::{prompts, CoreError, Result};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior};
use std::path::Path;

pub const READING_CHAPTER_MAX_CHARS: usize = 6000;
pub const READING_QUOTE_WINDOW: usize = 3000;
pub const READING_HISTORY_TURNS: usize = 8;
pub const READING_STATE_MAX: usize = 40;
pub const READING_NOTES_PER_BLOCK: usize = 10;
pub const READING_FINAL_STATE_MAX: usize = 20;
pub const READING_TURN_TIMEOUT_SECS: u64 = 120;
pub const READING_DISTILL_TIMEOUT_SECS: u64 = 120;
/// 前端也截,这里兜底
pub const READING_QUOTE_MAX_CHARS: usize = 8000;
pub const READING_TEXT_MAX_CHARS: usize = 4000;

#[derive(Debug, Clone, PartialEq)]
pub struct ReadingTopic {
    pub id: i64,
    pub book_id: i64,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub distilled_at: Option<String>,
    pub needs_distill: bool,
    pub anchor_href: String,
    pub anchor_block_id: Option<i64>,
    pub first_question: String,
}

#[derive(Debug, Clone, PartialEq)]
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

#[derive(Debug, Clone, PartialEq)]
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

/// 章节上下文:超过 max 时以 quote 首次命中为中心截 ±window 字,命不中取章首 max 字;截断处加 …
pub fn chapter_window(text: &str, quote: &str, max: usize, window: usize) -> String {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= max {
        return text.to_string();
    }
    let needle: Vec<char> = quote.trim().chars().take(40).collect();
    let hit = if needle.is_empty() {
        None
    } else {
        chars.windows(needle.len()).position(|w| w == needle.as_slice())
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

fn read_topic(conn: &Connection, id: i64) -> Result<ReadingTopic> {
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

pub fn list_topics(conn: &Connection, book_id: i64) -> Result<Vec<ReadingTopic>> {
    let mut st = conn.prepare("SELECT id FROM reading_topic WHERE book_id=?1 ORDER BY id DESC")?;
    let ids: Vec<i64> = st.query_map([book_id], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
    ids.into_iter().map(|id| read_topic(conn, id)).collect()
}

fn row_message(r: &rusqlite::Row<'_>) -> rusqlite::Result<ReadingMessage> {
    Ok(ReadingMessage {
        id: r.get(0)?, topic_id: r.get(1)?, role: r.get(2)?, text: r.get(3)?, quote: r.get(4)?,
        spine_href: r.get(5)?, block_id: r.get(6)?, status: r.get(7)?, client_msg_id: r.get(8)?, created_at: r.get(9)?,
    })
}
const MSG_COLS: &str = "id,topic_id,role,text,quote,spine_href,block_id,status,client_msg_id,created_at";

pub fn list_messages(conn: &Connection, topic_id: i64) -> Result<Vec<ReadingMessage>> {
    read_topic(conn, topic_id)?;
    let mut st = conn.prepare(&format!("SELECT {MSG_COLS} FROM reading_message WHERE topic_id=?1 ORDER BY id"))?;
    let rows = st.query_map([topic_id], row_message)?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

fn get_message(conn: &Connection, id: i64) -> Result<ReadingMessage> {
    conn.query_row(&format!("SELECT {MSG_COLS} FROM reading_message WHERE id=?1"), [id], row_message)
        .optional()?
        .ok_or_else(|| CoreError::NotFound(format!("reading message {id}")))
}

/// 取话题:给定 id 须属于该书;缺省续该书 ended_at 为空的最新话题,没有则新建(锚点取首条消息的章节/块)
pub fn ensure_topic(conn: &Connection, book_id: i64, topic_id: Option<i64>, spine_href: &str, block_id: Option<i64>) -> Result<i64> {
    if let Some(id) = topic_id {
        let t = read_topic(conn, id)?;
        if t.book_id != book_id {
            return Err(CoreError::InvalidInput(format!("topic {id} belongs to another book")));
        }
        return Ok(id);
    }
    let open: Option<i64> = conn
        .query_row("SELECT id FROM reading_topic WHERE book_id=?1 AND ended_at IS NULL ORDER BY id DESC LIMIT 1", [book_id], |r| r.get(0))
        .optional()?;
    if let Some(id) = open {
        return Ok(id);
    }
    crate::models::get_book_slug_type(conn, book_id)?;
    conn.execute(
        "INSERT INTO reading_topic(book_id,started_at,anchor_href,anchor_block_id) VALUES(?1,?2,?3,?4)",
        rusqlite::params![book_id, now(), spine_href, block_id],
    )?;
    Ok(conn.last_insert_rowid())
}

/// 「另起话题」:写 ended_at(幂等);提炼由调用方(第二批 distill)接着做
pub fn end_topic(conn: &Connection, topic_id: i64) -> Result<()> {
    read_topic(conn, topic_id)?;
    conn.execute("UPDATE reading_topic SET ended_at=COALESCE(ended_at,?2) WHERE id=?1", rusqlite::params![topic_id, now()])?;
    Ok(())
}

/// 已提炼的理解状态条目(第二批实现,这里先返回空;签名固定以便 prompt 先接好)
pub fn understanding_lines(_conn: &Connection, _book_id: i64, _max: usize) -> Result<Vec<String>> {
    Ok(vec![])
}

/// 发送一条用户消息:①事务 A 落 pending user 行(同 topic+client id:done 重放 / pending|failed 续跑)
/// ②无事务调 codex ③事务 B 写 assistant 行、user 置 done;失败 user 置 failed、assistant=None(不是错误)
pub fn send_message(conn: &Connection, provider: &dyn AiProvider, workdir: &Path, policy: &AiPolicy, input: &SendInput) -> Result<SendResult> {
    validate_client_id(&input.client_msg_id)?;
    if !conn.is_autocommit() {
        return Err(CoreError::Other("send_message must not be called inside a transaction".into()));
    }
    let text = truncate_chars(input.text.trim(), READING_TEXT_MAX_CHARS);
    if text.is_empty() {
        return Err(CoreError::InvalidInput("empty reading question".into()));
    }
    let quote = truncate_chars(input.quote.trim(), READING_QUOTE_MAX_CHARS);
    let topic_id = ensure_topic(conn, input.book_id, input.topic_id, &input.spine_href, input.block_id)?;
    // ① 幂等
    let existing: Option<(i64, String)> = conn
        .query_row("SELECT id,status FROM reading_message WHERE topic_id=?1 AND client_msg_id=?2 AND role='user'",
            rusqlite::params![topic_id, input.client_msg_id], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()?;
    let user_id = match existing {
        Some((id, status)) if status == "done" => {
            let assistant = conn
                .query_row(&format!("SELECT {MSG_COLS} FROM reading_message WHERE topic_id=?1 AND role='assistant' AND id>?2 ORDER BY id LIMIT 1"),
                    rusqlite::params![topic_id, id], row_message)
                .optional()?;
            return Ok(SendResult { topic_id, user_message: get_message(conn, id)?, assistant_message: assistant });
        }
        Some((id, _)) => {
            conn.execute("UPDATE reading_message SET status='pending' WHERE id=?1", [id])?;
            id
        }
        None => {
            let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate)?;
            tx.execute(
                "INSERT INTO reading_message(topic_id,role,text,quote,spine_href,block_id,status,client_msg_id,created_at) \
                 VALUES(?1,'user',?2,?3,?4,?5,'pending',?6,?7)",
                rusqlite::params![topic_id, text, quote, input.spine_href, input.block_id, input.client_msg_id, now()],
            )?;
            let id = tx.last_insert_rowid();
            tx.commit()?;
            id
        }
    };
    // ② 组 prompt
    let (book_title, book_type) = conn.query_row("SELECT title,type FROM book WHERE id=?1", [input.book_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
    let chapter = crate::mapgen::list_spine(conn, input.book_id)?
        .into_iter()
        .find(|c| c.href == input.spine_href);
    let (chapter_title, chapter_text, chapter_text_truncated) = match chapter {
        Some(c) => {
            let windowed = chapter_window(&c.text, &quote, READING_CHAPTER_MAX_CHARS, READING_QUOTE_WINDOW);
            let truncated = windowed.chars().count() < c.text.chars().count();
            (c.title, windowed, truncated)
        }
        None => (String::new(), String::new(), false),
    };
    let block_title: String = match input.block_id {
        Some(b) => crate::models::get_block(conn, b).map(|k| k.title).unwrap_or_default(),
        None => String::new(),
    };
    let state = understanding_lines(conn, input.book_id, READING_STATE_MAX)?;
    // 历史回合渲染进 system(ai::render_prompt 会把 Role::Assistant 标成“学生:”,不适合阅读助手);
    // messages 只放本条提问
    let mut st = conn.prepare(
        "SELECT role,text,quote FROM reading_message WHERE topic_id=?1 AND status='done' AND id<?2 ORDER BY id",
    )?;
    let all: Vec<(String, String, String)> = st
        .query_map(rusqlite::params![topic_id, user_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<rusqlite::Result<_>>()?;
    drop(st);
    let skip = all.len().saturating_sub(READING_HISTORY_TURNS * 2);
    let history: Vec<String> = all
        .into_iter()
        .skip(skip)
        .map(|(role, t, q)| {
            let who = if role == "assistant" { "助手" } else { "用户" };
            if role == "user" && !q.is_empty() { format!("{who}(引用「{q}」):{t}") } else { format!("{who}:{t}") }
        })
        .collect();
    let system = prompts::reading_system(&prompts::ReadingContext {
        book_title, book_type, chapter_title, chapter_text, block_title, quote: quote.clone(), understanding: state, history,
        truncated: chapter_text_truncated,
    });
    let question = if quote.is_empty() { text.clone() } else { format!("引用:「{quote}」\n\n{text}") };
    let req = CompletionRequest {
        system, messages: vec![(Role::User, question)], workdir: workdir.to_path_buf(), read_only: true, request_id: String::new(), timeout_secs: READING_TURN_TIMEOUT_SECS,
    };
    let accept = |t: &str| if t.trim().is_empty() { Err(CoreError::Ai("empty reading reply".into())) } else { Ok(()) };
    let outcome = run_ai_request(conn, provider, &format!("reading:{topic_id}:{}", input.client_msg_id), "reading", &req, policy, &accept);
    // ③ 落库
    let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate)?;
    let assistant = match outcome {
        Ok(o) => {
            tx.execute(
                "INSERT INTO reading_message(topic_id,role,text,spine_href,block_id,status,created_at) VALUES(?1,'assistant',?2,?3,?4,'done',?5)",
                rusqlite::params![topic_id, o.text().trim(), input.spine_href, input.block_id, now()],
            )?;
            let aid = tx.last_insert_rowid();
            tx.execute("UPDATE reading_message SET status='done' WHERE id=?1", [user_id])?;
            Some(aid)
        }
        Err(e) => {
            tracing_failed(&e);
            tx.execute("UPDATE reading_message SET status='failed' WHERE id=?1", [user_id])?;
            None
        }
    };
    tx.commit()?;
    Ok(SendResult {
        topic_id,
        user_message: get_message(conn, user_id)?,
        assistant_message: assistant.map(|id| get_message(conn, id)).transpose()?,
    })
}

fn tracing_failed(e: &CoreError) {
    // core 无 tracing 依赖时留空实现;壳层的 ai_request 表已记失败原因
    let _ = e;
}
```

`core/src/lib.rs` 加 `pub mod reading_chat;`。`core/src/library.rs::delete_book` 在 `DELETE FROM knowledge_block` 之前加:

```rust
    transaction.execute("DELETE FROM reading_message WHERE topic_id IN (SELECT id FROM reading_topic WHERE book_id=?1)", [book_id])?;
    transaction.execute("DELETE FROM reading_topic WHERE book_id=?1", [book_id])?;
```

(按该文件现有的 `.execute(...).map_err`/`?` 风格写。)

`core/src/prompts.rs` 加:

```rust
/// 问书(阅读辅助对话)的固定注入
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ReadingContext {
    pub book_title: String,
    pub book_type: String,
    pub chapter_title: String,
    pub chapter_text: String,
    pub block_title: String,
    pub quote: String,
    pub understanding: Vec<String>,
    /// 本话题历史回合(“用户:…”/“助手:…”,最近 READING_HISTORY_TURNS 轮),已渲染成行
    pub history: Vec<String>,
    /// 章节原文被窗口截断
    pub truncated: bool,
}

/// 阅读助手 system prompt:直答、不出题不评估;书是上下文,答案靠模型自身知识
pub fn reading_system(ctx: &ReadingContext) -> String {
    let chapter = if ctx.chapter_text.is_empty() {
        "(本章原文不可用)".to_string()
    } else if ctx.truncated {
        format!("(已截断,只保留用户带入文字附近)\n{}", ctx.chapter_text)
    } else {
        ctx.chapter_text.clone()
    };
    let history = if ctx.history.is_empty() {
        String::new()
    } else {
        format!("\n\n=== 本话题此前的问答 ===\n{}", ctx.history.join("\n"))
    };
    let state = if ctx.understanding.is_empty() {
        String::new()
    } else {
        format!("\n\n=== 用户读这本书时已暴露的理解状态(别重复解释已澄清的,别和之前的解释矛盾)===\n{}", ctx.understanding.join("\n"))
    };
    let block = if ctx.block_title.is_empty() { String::new() } else { format!(" · 知识块:{}", ctx.block_title) };
    format!(
"你是一位阅读助手,陪用户读《{}》({})。用户读到不理解的地方会把原文贴给你提问。\
用中文回答;先直接回答问题,再按需要展开;不出题、不评估、不引导复述;引用书里的话时注明“书里说”;不确定就说不确定。\
书的内容只是上下文,解释靠你自己的知识。\n\n=== 当前章节:{}{} ===\n{}\n\n=== 用户带入的原文 ===\n{}{}{}\n\n提示:你的工作目录即记忆库,可自主阅读 profile.md 了解用户背景。",
        ctx.book_title, ctx.book_type, ctx.chapter_title, block, chapter,
        if ctx.quote.is_empty() { "(无)".to_string() } else { ctx.quote.clone() }, state, history)
}
```

- [ ] **Step 4: 跑测试**

Run: `cd core && cargo test -q reading_chat 2>&1 | grep -E "test result|FAILED|panicked|error"`
Expected: 5 passed

- [ ] **Step 5: fmt / clippy / 全量**

Run: `cd core && cargo fmt && cargo clippy -q --all-targets -- -D warnings && cargo test -q 2>&1 | grep -E "test result|FAILED"`
Expected: 无警告,全部 ok

- [ ] **Step 6: 提交**

```bash
git add core/src/reading_chat.rs core/src/lib.rs core/src/prompts.rs core/src/library.rs
git commit -m "feat(core): reading_chat——话题/消息、两事务包 codex 的 send、章节窗口截断、阅读助手 prompt"
```

### Task 3: 壳层 DTO、application、5 条命令、契约六处同步

**Files:**
- Modify: `web/src-tauri/src/dto/mod.rs`、`web/src-tauri/src/application/mod.rs`、`web/src-tauri/src/commands/mod.rs`、`web/src-tauri/src/lib.rs`、`web/src-tauri/tests/foundation.rs`、`shared/tauri-wire-contract.json`

- [ ] **Step 1: DTO**(`dto/mod.rs` 末尾)

```rust
use book_learner_core::reading_chat::{ReadingMessage, ReadingTopic, SendResult};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadingTopicDto {
    pub id: i64,
    pub book_id: i64,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub distilled_at: Option<String>,
    pub needs_distill: bool,
    pub anchor_href: String,
    pub anchor_block_id: Option<i64>,
    pub first_question: String,
}
impl From<ReadingTopic> for ReadingTopicDto { /* 逐字段 */ }

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadingMessageDto {
    pub id: i64, pub topic_id: i64, pub role: String, pub text: String, pub quote: String,
    pub spine_href: String, pub block_id: Option<i64>, pub status: String,
    pub client_msg_id: Option<String>, pub created_at: String,
}
impl From<ReadingMessage> for ReadingMessageDto { /* 逐字段 */ }

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadingSendResultDto {
    pub topic_id: i64,
    pub user_message: ReadingMessageDto,
    pub assistant_message: Option<ReadingMessageDto>,
}
impl From<SendResult> for ReadingSendResultDto { /* 逐字段 */ }

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DistillResultDto { pub distilled: bool }
```

- [ ] **Step 2: application**(`application/mod.rs`,参照 `submit_turn`)

```rust
pub fn reading_topics(state: &AppState, book_id: i64) -> Result<Vec<ReadingTopicDto>, IpcError> {
    state.with_connection(|c| book_learner_core::reading_chat::list_topics(c, book_id))
        .map(|v| v.into_iter().map(Into::into).collect())
}
pub fn reading_messages(state: &AppState, topic_id: i64) -> Result<Vec<ReadingMessageDto>, IpcError> {
    state.with_connection(|c| book_learner_core::reading_chat::list_messages(c, topic_id))
        .map(|v| v.into_iter().map(Into::into).collect())
}
/// 同一话题串行:发送/提炼/结束互斥(spec §7);忙则 conflict,前端在等待期间本就禁用输入。
/// topic_id 为 None(首条消息)不上锁:前端拿到首条回复后总带 topicId,并发首条只影响锚点归属,可接受
pub(crate) fn lock_topic(state: &AppState, topic_id: Option<i64>) -> Result<Option<TopicGuard>, IpcError> {
    let Some(id) = topic_id else { return Ok(None) };
    let mut busy = state.reading_busy().lock().expect("reading_busy poisoned");
    if !busy.insert(id) {
        return Err(IpcError::conflict("这个话题正在处理,请稍等"));
    }
    Ok(Some(TopicGuard { state: state.reading_busy().clone(), id }))
}
struct TopicGuard { state: std::sync::Arc<std::sync::Mutex<std::collections::HashSet<i64>>>, id: i64 }
impl Drop for TopicGuard { fn drop(&mut self) { self.state.lock().expect("reading_busy poisoned").remove(&self.id); } }
// AppState 加字段 `reading_busy: Arc<Mutex<HashSet<i64>>>` 与访问器 `reading_busy()`;IpcError 若无 `conflict` 构造器,按 error.rs 现有 ErrorCode::Conflict 的写法加一个。

pub fn reading_send(state: &AppState, input: book_learner_core::reading_chat::SendInput) -> Result<ReadingSendResultDto, IpcError> {
    let _guard = lock_topic(state, input.topic_id)?;
    let _job = state.jobs().begin();
    let (provider, policy) = state.ai_provider()?;
    let connection = state.open_connection()?;
    book_learner_core::reading_chat::send_message(&connection, provider.as_ref(), state.memory_root(), &policy, &input)
        .map(Into::into).map_err(Into::into)
}
pub fn reading_topic_end(state: &AppState, topic_id: i64) -> Result<DistillResultDto, IpcError> {
    let _guard = lock_topic(state, Some(topic_id))?;
    state.with_connection(|c| book_learner_core::reading_chat::end_topic(c, topic_id))?;
    Ok(DistillResultDto { distilled: false }) // 第二批接提炼
}
pub fn reading_distill(state: &AppState, topic_id: i64) -> Result<DistillResultDto, IpcError> {
    let _guard = lock_topic(state, Some(topic_id))?;
    Ok(DistillResultDto { distilled: false }) // 第二批
}
```

(`with_connection` 的错误映射按文件现有写法;`SendInput` 的 `book_id/topic_id/client_msg_id/text/quote/spine_href/block_id` 由命令层组装。)

- [ ] **Step 3: commands**(`commands/mod.rs`):`WIRE_COMMANDS` 末尾追加 5 行(顺序即契约顺序):

```rust
    ("reading_topics", &["bookId"]),
    ("reading_messages", &["topicId"]),
    ("reading_send", &["bookId", "topicId", "clientMsgId", "text", "quote", "spineHref", "blockId"]),
    ("reading_topic_end", &["topicId"]),
    ("reading_distill", &["topicId"]),
```

`*_inner` 五个(`run_command(state, "<name>", || application::<fn>(…))`)+ 五个 `#[tauri::command(async)] pub async fn`。`reading_send` 有 7 个业务参数,`reading_send_inner(state, input: SendInput)` 只收一个结构体(避开 clippy `too_many_arguments`);`#[tauri::command]` 函数本身参数(`book_id: i64, topic_id: Option<i64>, client_msg_id: String, text: String, quote: String, spine_href: String, block_id: Option<i64>`,camelCase 由 Tauri 自动转)加 `#[allow(clippy::too_many_arguments)]`,内部组 `SendInput` 再调 `_inner`。`lib.rs::generate_handler!` 加五项。

- [ ] **Step 4: 契约 json**:`shared/tauri-wire-contract.json` 的 `commands` 末尾追加(方法名 = 前端 Backend 方法):

```json
    { "method": "readingTopics", "command": "reading_topics", "payloadKeys": ["bookId"] },
    { "method": "readingMessages", "command": "reading_messages", "payloadKeys": ["topicId"] },
    { "method": "readingSend", "command": "reading_send", "payloadKeys": ["bookId", "topicId", "clientMsgId", "text", "quote", "spineHref", "blockId"] },
    { "method": "readingTopicEnd", "command": "reading_topic_end", "payloadKeys": ["topicId"] },
    { "method": "readingDistill", "command": "reading_distill", "payloadKeys": ["topicId"] }
```

- [ ] **Step 5: foundation**:`EngineMock::complete` 加分支

```rust
        if id.starts_with("reading:") {
            return Ok("需求定律说的是价格与需求量反向变动。".into());
        }
        if id.starts_with("reading_distill:") {
            return Ok(r#"{"focus":[{"blockId":null,"href":"ch0.xhtml","note":"问需求定律"}],"understanding":[{"blockId":null,"kind":"clarified","note":"价格与需求量反向"}],"habits":["先要结论"]}"#.into());
        }
```

wire 用例 `match command` 加 5 项(用 `second`/`second_block`;`reading_send` 先于 `reading_messages`/`reading_topic_end` 出现,契约顺序已保证 topics 在前——`reading_topics` 对空书返回 `[]` 即可,`reading_messages` 需要 topic:先在 `reading_messages` 分支里调 `commands::reading_send_inner(...)` 取得 topicId 再 `json!({"topicId": id})`,`reading_topic_end`/`reading_distill` 同样查最新 topic):

```rust
            "reading_topics" => json!({"bookId": second}),
            "reading_messages" | "reading_topic_end" | "reading_distill" => {
                let state = app.state::<AppState>();
                let sent = commands::reading_send_inner(&state, book_learner_core::reading_chat::SendInput {
                    book_id: second, topic_id: None, client_msg_id: "wire-q1".into(), text: "什么是需求定律".into(),
                    quote: "需求定律".into(), spine_href: "ch0.xhtml".into(), block_id: None,
                }).unwrap();
                json!({"topicId": sent.topic_id})
            }
            "reading_send" => json!({"bookId": second, "topicId": null, "clientMsgId": "wire-q0", "text": "第一问", "quote": "", "spineHref": "ch0.xhtml", "blockId": null}),
```

再加一条端到端用例(`#[test] fn reading_chat_roundtrip`,用自己的 state,不依赖 wire 循环留下的话题数):send → assistant 非空 → topics 长度 1 且 `needs_distill` → end → topics[0].ended_at 非空 → 再 send(无 topicId)开新话题 → 两个话题。

- [ ] **Step 6: Linux 侧能做的检查**

Run: `cd core && cargo test -q 2>&1 | grep -E "test result|FAILED"`;`git diff --stat web/src-tauri/Cargo.lock`(应为空)
壳层编译与 `tests/foundation.rs` 只能在 Mac 上跑:Task 6 的 Mac 门禁一并跑。

- [ ] **Step 7: 提交**

```bash
git add web/src-tauri shared/tauri-wire-contract.json
git commit -m "feat(shell): reading_* 5 条命令 + DTO + 契约同步(foundation/EngineMock 分支)"
```

### Task 4: web 契约层(types、Backend、TauriBackend、Mock、契约测试)

**Files:**
- Modify: `web/src/types.ts`、`web/src/backend/types.ts`、`web/src/backend/tauri.ts`、`web/src/backend/mock.ts`、`web/src/backend/contract.test.ts`、`web/src/backend/tauri.test.ts`、`web/src/config.ts`

- [ ] **Step 1: 写失败测试**——`contract.test.ts` 追加:

```ts
  it('问书:发送建话题并回复;同 clientMsgId 重放;另起话题后新建;历史按话题', async () => {
    const b = new MockBackend()
    const r1 = await b.readingSend({ bookId: 1, topicId: null, clientMsgId: 'q1', text: '什么是需求定律', quote: '需求定律', spineHref: 'chap1.xhtml', blockId: 1 })
    expect(r1.userMessage).toMatchObject({ role: 'user', status: 'done', quote: '需求定律', blockId: 1 })
    expect(r1.assistantMessage?.role).toBe('assistant')
    expect(r1.assistantMessage?.text).toContain('需求定律')
    const again = await b.readingSend({ bookId: 1, topicId: r1.topicId, clientMsgId: 'q1', text: '什么是需求定律', quote: '', spineHref: 'chap1.xhtml', blockId: null })
    expect(again.assistantMessage?.id).toBe(r1.assistantMessage?.id)
    const topics = await b.readingTopics(1)
    expect(topics).toHaveLength(1)
    expect(topics[0]).toMatchObject({ id: r1.topicId, needsDistill: true, firstQuestion: '什么是需求定律', anchorHref: 'chap1.xhtml' })
    expect(await b.readingMessages(r1.topicId)).toHaveLength(2)
    expect(await b.readingTopicEnd(r1.topicId)).toEqual({ distilled: false })
    expect((await b.readingTopics(1))[0].endedAt).not.toBeNull()
    const r2 = await b.readingSend({ bookId: 1, topicId: null, clientMsgId: 'q2', text: '再问', quote: '', spineHref: 'chap1.xhtml', blockId: null })
    expect(r2.topicId).not.toBe(r1.topicId)
    await expect(b.readingSend({ bookId: 1, topicId: null, clientMsgId: 'bad:id', text: 'x', quote: '', spineHref: '', blockId: null })).rejects.toMatchObject({ code: 'invalid_request' })
    await expect(b.readingMessages(999)).rejects.toMatchObject({ code: 'not_found' })
  })
```

`tauri.test.ts`:`NATIVE_METHODS` 追加 `'readingTopics', 'readingMessages', 'readingSend', 'readingTopicEnd', 'readingDistill'`;在 native 组里加一条:mock invoke 返回夹具 `{ topicId: 1, userMessage: {...}, assistantMessage: null }` 时 `readingSend` 解码通过且 payload 为 `{ bookId: 1, topicId: null, clientMsgId: 'q1', text: '问', quote: '', spineHref: 'a.xhtml', blockId: null }`;坏夹具(`userMessage.status: 'weird'`)→ `invalid_response`;出站 `clientMsgId: 'a:b'` → `invalid_request`。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -C web exec vitest --run src/backend 2>&1 | grep -E "×|Tests "`
Expected: 新用例失败(方法不存在)

- [ ] **Step 3: 实现**

`types.ts`:

```ts
/** 问书(阅读辅助对话,spec 2026-09-16) */
export interface ReadingTopic {
  id: number; bookId: number; startedAt: string; endedAt: string | null; distilledAt: string | null
  /** 有回复且回复晚于上次提炼 → 待整理 */
  needsDistill: boolean
  anchorHref: string; anchorBlockId: number | null; firstQuestion: string
}
export interface ReadingMessage {
  id: number; topicId: number; role: 'user' | 'assistant'; text: string; quote: string
  spineHref: string; blockId: number | null; status: 'pending' | 'done' | 'failed'
  clientMsgId: string | null; createdAt: string
}
export interface ReadingSendInput { bookId: number; topicId: number | null; clientMsgId: string; text: string; quote: string; spineHref: string; blockId: number | null }
/** AI 失败也是成功载荷:userMessage.status='failed'、assistantMessage=null */
export interface ReadingSendResult { topicId: number; userMessage: ReadingMessage; assistantMessage: ReadingMessage | null }
```

`backend/types.ts` 的 `Backend` 加:

```ts
  /** 问书:按书的话题列表(新→旧)、话题消息、发送(幂等按 topicId+clientMsgId)、另起话题、提炼 */
  readingTopics(bookId: number): Promise<ReadingTopic[]>
  readingMessages(topicId: number): Promise<ReadingMessage[]>
  readingSend(input: ReadingSendInput): Promise<ReadingSendResult>
  readingTopicEnd(topicId: number): Promise<{ distilled: boolean }>
  readingDistill(topicId: number): Promise<{ distilled: boolean }>
```

`tauri.ts`:解码器 `decodeReadingTopic`/`decodeReadingMessage`/`decodeReadingSendResult`(status 只接受三值、role 两值,否则 `invalidShape`),五个方法用 `this.gated(...)` + `outboundInteger`/`outboundClientId`/`outboundString`,`topicId`/`blockId` 为 null 或整数。`config.ts` 加 `READING_QUOTE_MAX_CHARS = 8000`、`READING_TEXT_MAX_CHARS = 4000`、`READING_POLL_MS = 3000`、`READING_POLL_MAX_MS = 120_000`。

`mock.ts`:字段不能与同名方法冲突——`private readingTopicRows: ReadingTopic[] = []`、`private readingMessageRows: ReadingMessage[] = []`、`private nextReadingId = 1`;`readingSend`:`requireClientId`;空 text → `invalidRequest()`;书不存在 → `notFound()`;找/建话题(锚点取首条);同 id 已 done → 重放;否则落 user(done)+ assistant(文本 `关于「${quote.slice(0,12) || text.slice(0,12)}」:这句话在说……(Mock 回复)`);`readingTopics` 按 id 倒序、`needsDistill = 有 assistant`;`readingTopicEnd` 写 `endedAt`,返回 `{distilled:false}`;`readingDistill` 返回 `{distilled:false}`;`deleteBook` 里顺带清两组数据。

- [ ] **Step 4: 跑测试**

Run: `pnpm -C web exec vitest --run src/backend 2>&1 | grep -E "×|Test Files|Tests "`
Expected: 全过

- [ ] **Step 5: 提交**

```bash
git add web/src/types.ts web/src/backend web/src/config.ts
git commit -m "feat(web): 问书契约层——types/Backend/TauriBackend/Mock + 契约测试"
```

### Task 5: `ReadingChatPanel` 与阅读器接入(标签、「问 AI」、发送/等待/重试/另起/历史)

**Files:**
- Create: `web/src/features/reader/ReadingChatPanel.tsx`、`web/src/features/reader/readingChat.test.tsx`
- Modify: `web/src/features/reader/ReaderPage.tsx`、`web/src/features/reader/reader.test.tsx`

- [ ] **Step 1: 写失败测试**(`readingChat.test.tsx`,复用 `reader.test.tsx` 的 `h`/`renderReader` 写法——把 `renderReader` 与 epub mock 抽到 `readerTestHarness.tsx` 供两文件共用)

用例:
1. 无任务打开 `/reader/4`:正文就绪后右栏只有「问书」标签且已展开,空状态文案可见;带 `?task=1` 时两个标签,默认「学习模式」,点「问书」切换,再点回「学习模式」原面板仍在(不重新挂载:用 `data-testid=learn-panel` 上的 `key` 无变化/内容保持)。
2. 输入「什么是需求定律」回车 → `readingSend` 被调(`bookId` 来自块、`spineHref` 来自当前位置、`blockId`=4 当当前 href 属于块 4 的锚点段,否则 null)→ 出现用户气泡与 AI 气泡;发送期间输入框禁用、显示"思考中…";Shift+Enter 只换行。
3. 「问 AI」:模拟选区(同 BL-006 的 `getContents` 桩)→ 工具条出现「问 AI」→ 点击后引用区显示选文、面板切到「问书」、可删引用;发送时 `quote` 带上。
4. 失败:`readingSend` 桩返回 `userMessage.status='failed'`、`assistantMessage:null` → 气泡带「重试」→ 点重试用同一 `clientMsgId` 与 `topicId` 再调。
5. 「另起话题」:调 `readingTopicEnd(topicId)`,消息流清空,状态点变化;当前话题无消息时按钮禁用。「历史」下拉列出 `readingTopics` 并可切换(切换后 `readingMessages` 加载)。
6. 取消 = 停止等待:点「取消」后输入框恢复,该条显示"等待中",随后 `readingMessages` 轮询(用假定时器推进 3 s)拿到 done 后气泡补上。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -C web exec vitest --run src/features/reader/readingChat.test.tsx 2>&1 | grep -E "×|Tests "`

- [ ] **Step 3: 实现面板**(`ReadingChatPanel.tsx`,props:`bookId`、`currentHref`、`blockIdForHref(href) => number|null`、`quoteDraft` + `onQuoteConsumed`、`onNeedsDistillChange?`;内部状态:`topicId`、`messages`、`topics`、`text`、`sending`、`waitingId`、`error`)

要点:
- 首次挂载:`readingTopics(bookId)` → 取第一个 `endedAt===null` 的为当前(否则 `topicId=null`,消息空),`readingMessages` 加载。
- 发送:`clientMsgId = 'rq-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)`(过 `outboundClientId`:不含冒号、≤64);前端截断 `quote`/`text`;乐观插入 user 气泡(status pending);调用返回后用结果替换(`topicId` 记下);`assistantMessage` 为 null → 该条 failed,显示「重试」(同 id、同 topicId 重发)。
- 取消:`AbortController` 只用于停止等待(不传给后端);置 `waitingId`,启动 `setInterval(READING_POLL_MS)` 拉 `readingMessages(topicId)`,直到该 clientMsgId 的用户消息 status≠pending 或超 `READING_POLL_MAX_MS`(超时显示「刷新」按钮;`window` `focus` 事件再拉一次)。
- 「另起话题」:先把本地 `topicId=null`、清消息(立刻可用),再 `void backend.readingTopicEnd(topicId).catch(() => {}).finally(() => 重拉 readingTopics)`——第二批里该命令同步跑提炼可能长达 120 s,不能等它;无消息时禁用。
- 「历史」:`<select aria-label="历史话题">`,选项 `${startedAt.slice(0,16)} · ${firstQuestion}`;选中加载消息并把 `topicId` 设为它(旧话题续聊)。
- 卸载:`useEffect` cleanup 里若 `topicId` 且有 assistant 消息 → `void backend.readingDistill(topicId).catch(() => {})`(第一批返回 false,无害;忙时后端返回 conflict,吞掉)。
- 样式沿用 `Card`/`Button`/`AsyncError`;AI 文本用 `whitespace-pre-wrap`(不引入 markdown 库,YAGNI);气泡 `data-testid="reading-msg"` + `data-role`/`data-status`。

`ReaderPage.tsx`:
- 新状态 `sideTab: 'learn' | 'chat'`(有任务默认 `'learn'`,无任务 `'chat'`);右栏容器改为 `ready &&` 渲染;标签行两个按钮(无任务时只渲染「问书」);学习模式面板包在 `hidden={sideTab!=='learn'}` 的 div 里(不卸载);`ReadingChatPanel` 同理 `hidden={sideTab!=='chat'}`。
- 选区工具条加 `<button aria-label="问 AI">问 AI</button>`:`setQuoteDraft(selection.text)`、`setSideTab('chat')`、`setSelection(null)`、`epubRef.current?.clearSelection()`。
- `blockIdForHref`:`content.data?.segments.some(s => s.spineHref === href) ? blockId : null`(锚点段已在 `content` 里)。
- `currentHref`:来自 `onRelocated` 的 `href`(已有 `position`/`lastLocation`)。

- [ ] **Step 4: 跑测试**

Run: `pnpm -C web exec vitest --run src/features/reader 2>&1 | grep -E "×|Test Files|Tests "`
Expected: 全过(含既有阅读器用例)

- [ ] **Step 5: 全量 web 门禁**

Run: `bash /bigtemp/fzv6en/book-learner/webgate.sh 2>&1 | tail -3`
Expected: `WEBGATE: ALL GREEN`

- [ ] **Step 6: 提交**

```bash
git add web/src/features/reader
git commit -m "feat(reader): 「问书」面板——带入选文、发送/等待/重试、另起话题、历史;右栏标签"
```

### Task 6: 第一批文档、PR、Mac 门禁与实测、合并

**Files:**
- Modify: `DEVLOG.md`、`CHANGELOG.md`、`docs/CODE_MAP.md`(§阅读器、§6 契约表、§9 无新陷阱则不加)、`PRODUCT_SPEC.md`(阅读器一节加「问书」两句)

- [ ] **Step 1: 文档**:DEVLOG 新条目「2026-09-16 · 问书第一批」(设计链接、取舍:AI 失败返回成功载荷、取消=停止等待、第一批状态点恒"待整理"、AI 回复先按纯文本 `whitespace-pre-wrap` 显示而非 spec 说的 Markdown 渲染——不引第三方库,后续按需加);CHANGELOG Unreleased 加一行;CODE_MAP 阅读器段落加面板与命令;PRODUCT_SPEC §阅读器加「问书」。
- [ ] **Step 2: 推送 + PR**:`git push -u origin feat/reading-chat-1`,`gh pr create`(标题「问书第一批:面板 + 契约 + core reading_chat」)。
- [ ] **Step 3: Mac 门禁**(经隧道,`~/Developer/bl-logs/<name>-cmd.sh` + `bl-run.sh`):`cargo test`(壳层,含 foundation)、`clippy -D warnings`、`cargo fmt --check`(core 与壳层)、打 debug bundle。
- [ ] **Step 4: Mac 实测**(真 codex,调试包 + 桥,置前按 pid):打开测试书某块 → 桥合成事件在指针层划选 → 「问 AI」→ 输入问题回车 → 等回复(≤120 s)→ `reading_message` 两行、`ai_request` 有 `reading:` 行 → 「另起话题」→ `reading_topic.ended_at` 非空 → 再问一条开新话题 → 历史下拉两条。记录到 DEVLOG。
- [ ] **Step 5: 合并**:`bash /bigtemp/fzv6en/book-learner/ci-merge.sh <PR>`(等待循环放在另一条命令里,命令行不得含未加括号的 `ci-merge.sh <PR>`);同步 Linux/Mac 仓库到 main;用户说「换」再 `install-release.sh`。

---

# 第二批:提炼、投影、反哺(分支 `feat/reading-chat-2`)

### Task 7: 提炼 prompt 与 `distill_topic`、`needs_distill` 判定、启动补跑

**Files:**
- Modify: `core/src/prompts.rs`(`reading_distill_prompt`)、`core/src/reading_chat.rs`(`Distilled` 结构、`distill_topic`、`topics_needing_distill`、`understanding_lines` 实现)、`web/src-tauri/src/application/mod.rs`(`reading_topic_end`/`reading_distill` 接提炼)、`web/src-tauri/src/lib.rs`(`run_startup_recovery` 补跑)

- [ ] **Step 1: 写失败测试**(`reading_chat.rs` tests)

```rust
    const DISTILL_JSON: &str = r#"{"focus":[{"blockId":1,"href":"ch0.xhtml","note":"问需求定律"}],"understanding":[{"blockId":1,"kind":"misconception","note":"把斜率当弹性"},{"blockId":1,"kind":"clarified","note":"弹性是百分比之比"}],"habits":["先要结论"]}"#;

    #[test]
    fn distill_writes_json_and_marks_up_to_and_is_skipped_without_new_messages() {
        let (conn, book) = setup();
        let p = Script(Mutex::new(vec![Ok("答".into()), Ok(DISTILL_JSON.into()), Ok("答2".into()), Ok(DISTILL_JSON.into())]));
        let r = send(&conn, &p, book, None, "m1", "问");
        assert!(read_topic(&conn, r.topic_id).unwrap().needs_distill);
        assert!(distill_topic(&conn, &p, std::path::Path::new("."), &policy(), r.topic_id).unwrap());
        let t = read_topic(&conn, r.topic_id).unwrap();
        assert!(!t.needs_distill && t.distilled_at.is_some());
        assert!(!distill_topic(&conn, &p, std::path::Path::new("."), &policy(), r.topic_id).unwrap(), "没新消息不再跑");
        send(&conn, &p, book, Some(r.topic_id), "m2", "再问");
        assert!(read_topic(&conn, r.topic_id).unwrap().needs_distill);
        assert!(distill_topic(&conn, &p, std::path::Path::new("."), &policy(), r.topic_id).unwrap());
        // 两次提炼 → 两行 sync_reading(op_id 带水位,不会被 INSERT OR IGNORE 吞掉)
        let n: i64 = conn.query_row("SELECT count(*) FROM projection_outbox WHERE kind='sync_reading'", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 2);
        // 理解状态条目可读
        let lines = understanding_lines(&conn, book, 40).unwrap();
        assert!(lines.iter().any(|l| l.contains("把斜率当弹性")));
        // 空话题 / 无回复不提炼(先结束当前话题,ensure_topic 才会新建一个空的)
        end_topic(&conn, r.topic_id).unwrap();
        let empty = ensure_topic(&conn, book, None, "ch0.xhtml", None).unwrap();
        assert_ne!(empty, r.topic_id);
        assert!(!distill_topic(&conn, &p, std::path::Path::new("."), &policy(), empty).unwrap());
    }

    #[test]
    fn distill_failure_keeps_needs_distill() {
        let (conn, book) = setup();
        let p = Script(Mutex::new(vec![Ok("答".into()), Ok("not json".into())]));
        let r = send(&conn, &p, book, None, "m1", "问");
        assert!(distill_topic(&conn, &p, std::path::Path::new("."), &policy(), r.topic_id).is_err());
        assert!(read_topic(&conn, r.topic_id).unwrap().needs_distill);
        assert_eq!(topics_needing_distill(&conn).unwrap(), vec![r.topic_id]);
    }
```

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 实现**

`prompts.rs`:

```rust
/// 问书话题提炼:只输出 JSON(focus/understanding/habits)
pub fn reading_distill_prompt(book_title: &str, transcript: &str) -> String {
    format!(
"下面是用户读《{book_title}》时与阅读助手的一段问答。请把它提炼成用户对这本书的“理解画像”条目,只输出 JSON,不要别的文字:\n\
{{\"focus\":[{{\"blockId\":数字或null,\"href\":\"章节href\",\"note\":\"用户问了什么(一句话)\"}}],\
\"understanding\":[{{\"blockId\":数字或null,\"kind\":\"misconception|unclear|clarified\",\"note\":\"具体的误解/未澄清/已澄清点(一句话)\"}}],\
\"habits\":[\"用户的表述或学习习惯(可空)\"]}}\n\
要求:每条一句话、具体到概念;没有的类别给空数组;blockId 用消息里标注的块号。\n\n=== 问答 ===\n{transcript}")
}
```

`reading_chat.rs`:

```rust
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
pub struct DistilledFocus { pub block_id: Option<i64>, pub href: String, pub note: String }
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
pub struct DistilledUnderstanding { pub block_id: Option<i64>, pub kind: String, pub note: String }
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Distilled {
    #[serde(default)] pub focus: Vec<DistilledFocus>,
    #[serde(default)] pub understanding: Vec<DistilledUnderstanding>,
    #[serde(default)] pub habits: Vec<String>,
}
```

(字段用 `#[serde(rename = "blockId")]` 对齐 camelCase;`kind` 只接受三值,其它按 `unclear` 归一。)

`distill_topic(conn, provider, workdir, policy, topic_id) -> Result<bool>`:读话题;`needs_distill` 为 false → `Ok(false)`;拼 transcript(每条 `[用户|助手 · 章节 href · 块 #id]` + quote + text);`run_ai_json::<Distilled>`(request id `reading_distill:{topic_id}:m{max_id}`,`timeout_secs=READING_DISTILL_TIMEOUT_SECS`,`read_only=true`)→ 事务写 `distilled_json/distilled_at/distilled_up_to=max_id` → `projection::enqueue(conn, &format!("reading:{book_id}:t{topic_id}:m{max_id}:sync_reading"), "sync_reading", &json!({"book_id": book_id}))`(op_id 带消息水位:outbox 按 op_id `INSERT OR IGNORE` 且 done 行不删,固定 op_id 会让二次提炼永远不再投影)→ `Ok(true)`。提炼 prompt 放在 `CompletionRequest.system`(与 extra/final_exam 一致),`messages` 为空。JSON 解析失败经 `run_ai_json` 的纠错重试仍失败 → `Err`,不改任何列。

`topics_needing_distill(conn) -> Result<Vec<i64>>`:`SELECT t.id FROM reading_topic t WHERE EXISTS(SELECT 1 FROM reading_message m WHERE m.topic_id=t.id AND m.role='assistant' AND m.status='done' AND m.id>t.distilled_up_to) ORDER BY t.id`。

`understanding_lines(conn, book_id, max)`:遍历该书 `distilled_json`(按 `distilled_at DESC`),展开 `understanding`,格式 `- [日期] 块 #N · 误解|未澄清|已澄清:note`(无块号省略 `块 #N ·`),取前 `max` 条。

壳层:`application::reading_topic_end` = `end_topic` 后 `distill_topic`(错误只 `tracing::warn!`,返回 `{distilled:false}`);`reading_distill` 同(不 end)。两条命令的 `#[tauri::command]` 层在成功后像 `session_confirm_verdict` 那样 `spawn_blocking(run_startup_recovery)` 排空 outbox,`_reading.md` 才会当场写出。
**启动补跑不要放进 `run_startup_recovery`**(它被五个命令处理器复用,里面不能塞 codex 调用):新增 `lib.rs::distill_pending_reading_topics(state)`——`let _job = state.jobs().begin()`(让有序退出等它),`state.ai_provider()` 失败只 warn 并返回,遍历 `reading_chat::topics_needing_distill` 逐个先 `application::lock_topic`(`pub(crate)`;忙则跳过)再 `distill_topic`(错误 warn 继续),最后再 `projection::run_pending` 一次;在 `setup` 闭包里 `run_startup_recovery` 之后的同一 `spawn_blocking` 里调用一次。

- [ ] **Step 4: 跑测试、fmt、clippy、全量**
- [ ] **Step 5: 提交** `feat(core): 问书话题提炼(distill_topic)、needs_distill、启动补跑`

### Task 8: 投影 `sync_reading` 与 `_reading.md`

**Files:**
- Modify: `core/src/projection.rs`、`core/src/memory.rs`(`sync_reading`、`INDEX_TEMPLATE` 说明行与 `ensure_book` 幂等追加)

- [ ] **Step 1: 写失败测试**(`memory.rs` tests 与 `projection.rs` tests 各一条)

memory:`sync_reading("microecon", "微观", &[entry…])` 两次内容一致;文件三节存在;条目格式 `- [2026-09-16] 第一章 · 需求弹性(块 #3):问弹性和斜率`;`ensure_book` 后 `INDEX.md` 含 `_reading.md` 一行且重复调用只有一行。
projection:入队 `sync_reading` → `run_pending` 后文件存在,`git log` 多一次提交(沿用现有投影测试的断言方式)。

- [ ] **Step 2: 实现**

`memory.rs`:

```rust
/// 投影用的一条阅读记忆(章节/块标题已由 projection 解析好)
pub struct ReadingEntry {
    pub date: String,        // distilled_at 前 10 位
    pub chapter_title: String,
    pub block_id: Option<i64>,
    pub block_title: String,
    pub focus: Vec<String>,
    pub understanding: Vec<(String, String)>, // (kind 中文, note)
    pub habits: Vec<String>,
}
pub fn sync_reading(&self, book_slug: &str, book_title: &str, entries: &[ReadingEntry]) -> Result<()>
```

整文件重生成:`# 《{title}》阅读对话记忆`,三节按 spec §3.2 格式;`habits` 去重保序。`INDEX_TEMPLATE` 加说明行;`ensure_book` 里若 `INDEX.md` 不含 `_reading.md` 则追加该行。

`projection.rs`:`"sync_reading" => { book_id; (slug,title); ensure_book; 读 reading_topic(distilled_json 非空,按 distilled_at) + spine_item.title 映射 + knowledge_block.title 映射 → entries; memory.sync_reading(...) }`。

- [ ] **Step 3: 跑测试、fmt、clippy、全量;提交** `feat(core): sync_reading 投影 → books/<slug>/_reading.md`

### Task 9: `FixedContext.reading_notes` 反哺

**Files:**
- Modify: `core/src/prompts.rs`(字段 + `context_block` 追加段 + `final_exam_system` 追加)、`core/src/session.rs`(`fixed_context_for_block` 填充)、`core/src/reading_chat.rs`(`reading_notes_for_block`)、以及所有构造 `FixedContext` 的文件:`core/src/{prompts,session,verdict,projection,extra,final_exam}.rs`、`web/src-tauri/src/application/mod.rs`(`grep -rn "FixedContext {" core web/src-tauri/src` 逐个补 `reading_notes: String::new()`)

- [ ] **Step 1: 写失败测试**:`reading_chat.rs`:`reading_notes_for_block(conn, book, block=1, 10)` 返回含「关注:问需求定律」与「误解:把斜率当弹性」的行,块 2 为空;`prompts.rs` 现有 `context_block` 用例加 `reading_notes` 非空时输出含固定提示语、为空时不含。
- [ ] **Step 2: 实现**:`context_block` 末尾在"前置块掌握情况"之后加(非空时):`\n\n=== 用户读这块时的提问与困惑(追问和出题优先覆盖这些点,标为已澄清的不要再纠缠)===\n{reading_notes}`;`final_exam_system` 的画像摘要后追加 `understanding_lines(conn, book, READING_FINAL_STATE_MAX)`(由 `final_exam::map_summary` 的调用方传入,或在 `application::session_context` 的 final_exam 分支里拼进 `profile_summary`——选后者,改动最小)。
- [ ] **Step 3: 跑 core 全量 + clippy;提交** `feat(core): FixedContext.reading_notes——问书提炼反哺费曼/评估/复习/终评`

### Task 10: 前端触发与状态点

**Files:**
- Modify: `web/src/features/reader/ReadingChatPanel.tsx`、`readingChat.test.tsx`、`web/src/backend/mock.ts`(`readingDistill`/`readingTopicEnd` 返回 `distilled:true` 并把 `needsDistill` 置 false、`distilledAt` 置时间)

- [ ] **Step 1: 测试**:另起话题后历史里该话题状态点为「已记入记忆」;卸载时调 `readingDistill(topicId)`;`readingTopics` 里 `needsDistill=false` 的话题不显示"待整理"。
- [ ] **Step 2: 实现**:状态点 `<span data-testid="topic-state" data-state="pending|done|none">`;`readingTopicEnd` 返回后重拉 `readingTopics`。
- [ ] **Step 3: web 门禁;提交** `feat(reader): 问书话题状态点与卸载提炼触发`

### Task 11: 第二批文档、PR、Mac 实测、合并

- [ ] **Step 1: 文档**:DEVLOG「问书第二批」;CODE_MAP §记忆库文件加 `_reading.md`,§AI 固定注入加 `reading_notes`;TECH_DESIGN §3.2 固定注入表加一行;CHANGELOG。
- [ ] **Step 2: PR + Mac 门禁**(同 Task 6 Step 2–3)。
- [ ] **Step 3: Mac 实测**(真 codex):一个话题两轮问答 → 「另起话题」→ 等 `reading_topic.distilled_at` 非空 → 记忆库 `books/<slug>/_reading.md` 三节有条目、git 多一次提交 → 打开该块费曼对话发一回合 → `ai_request` 表里 `turn:` 行的 prompt(或壳层日志)含"用户读这块时的提问与困惑" → 退出 app 前留一个未提炼话题,重开 app 后 `distilled_at` 被补上。记录到 DEVLOG。
- [ ] **Step 4: 合并、同步仓库;用户说「换」再装。**
