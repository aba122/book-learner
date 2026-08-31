# book_learner_core(Linux 可实现部分)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Linux 服务器上实现 book-learner 的平台无关 Rust 核心库 `book_learner_core`(数据库、记忆库管理器、评估 schema、AI provider、prompt 组装、调度引擎),全部经 `cargo test` 验证,供 Mac 阶段的 Tauri 壳直接依赖。

**Architecture:** 单一 Rust library crate,模块 = db / models / eval / memory / ai / prompts / sched。SQLite 为状态唯一事实来源;记忆库 md 文件中 `_map.md`/`_weakpoints.md` 是由 SQLite 程序化再生的镜像,块文件为累积内容;AI 层为 trait + codex CLI 子进程实现(测试用假 codex 脚本,另备 `#[ignore]` 真实冒烟)。

**Tech Stack:** Rust 2021(cargo 1.80)、rusqlite(bundled)、serde/serde_json、thiserror、chrono、tempfile(dev)。git 操作用子进程(不引 git2)。

**Spec 依据:** `../../PRODUCT_SPEC.md` §5-6、`../../TECH_DESIGN.md` §3-6。**本计划范围外**(后续独立计划):React 前端、EPUB 抽取/CFI、Tauri 壳、whisper、导出器、`_methodology.md` 情境化方法论流(随 TECH §6.5 流程延后)。另:TECH §5.1 的指数退避重试与 §3.3 的解析失败重试属**编排层**职责(Mac 阶段实现),本 crate 只提供单次调用/单次解析原语。

---

## 开发流程约定(可追溯性)

- 仓库:`/p/fzv6enresearch/xwl/book-learner` 独立 git 仓库;**每个 Task 至少一个 commit**,格式 `<type>(core): <说明> (L1-T<n>)`,type ∈ feat/test/chore/docs/fix。
- TDD:先写失败测试 → 跑出失败 → 最小实现 → 跑过 → commit。禁止无测试的功能代码。
- `DEVLOG.md`:每个工作阶段结束追加一条(日期、完成的 Task、关键决策/偏差、测试状态)。
- 与 SPEC 出现偏差时,当场回写对应 SPEC 文档并在 DEVLOG 记录(已知第一处:daily_task 需增加 `ref_id` 字段,见 T1)。

## 文件结构

```
book-learner/
├─ DEVLOG.md                  ← T0 创建
├─ docs/plans/2026-08-30-core-crate-linux.md   ← 本文件
└─ core/                      ← cargo library crate: book_learner_core
   ├─ Cargo.toml
   ├─ src/lib.rs              ← pub mod 声明 + Error 类型
   ├─ src/db.rs               ← 连接 + migration(user_version)
   ├─ src/models.rs           ← 枚举/结构体 + book/block CRUD
   ├─ src/eval.rs             ← 评估 JSON 严格解析(TECH §3.3)
   ├─ src/memory.rs           ← 记忆库:init/ensure_book/apply_eval/sync 镜像/git commit
   ├─ src/ai.rs               ← AiProvider trait + CodexCliProvider
   ├─ src/prompts.rs          ← 固定注入组装 + 各 prompt 构造器(TECH §6)
   ├─ src/sched.rs            ← 每日队列/间隔重复/落后重排(PRODUCT §5-6)
   └─ tests/lifecycle.rs      ← T12 端到端集成测试
```

---

### Task 0: 仓库与工程初始化

**Files:** Create: `.gitignore`, `DEVLOG.md`, `core/Cargo.toml`, `core/src/lib.rs`

- [x] **Step 0.1** `cd /p/fzv6enresearch/xwl/book-learner && git init -b main`
- [x] **Step 0.2** 写 `.gitignore`:

```
core/target/
node_modules/
*.db
.DS_Store
```

- [x] **Step 0.3** 写 `DEVLOG.md`:

```markdown
# DEVLOG — book-learner 开发日志

> 每个工作阶段结束追加一条。格式:日期 / 完成内容 / 关键决策与偏差 / 测试状态。

## 2026-08-30 · 项目启动(Linux 阶段)
- 完成:SPEC 套件定稿(四文档);L1 计划(docs/plans/2026-08-30-core-crate-linux.md)。
- 决策:Linux 先实现平台无关 core crate;前端/Tauri 壳为后续独立计划。
- 环境:node22 / cargo1.80 / codex-cli 0.144.4(本机可用,AI 层可真冒烟)。
```

- [x] **Step 0.4** commit 规范文件:`git add PRODUCT_SPEC.md TECH_DESIGN.md IMPLEMENTATION_PLAN.md CLAUDE.md docs/ DEVLOG.md .gitignore && git commit -m "docs: SPEC 套件定稿 + L1 实施计划 (L1-T0)"`
- [x] **Step 0.5** `cargo init --lib core --name book_learner_core`;写 `core/Cargo.toml`:

```toml
[package]
name = "book_learner_core"
version = "0.1.0"
edition = "2021"

[dependencies]
rusqlite = { version = "0.31", features = ["bundled"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
thiserror = "1"
chrono = { version = "0.4", features = ["serde"] }

[dev-dependencies]
tempfile = "3"
```

- [x] **Step 0.6** `core/src/lib.rs` 骨架(模块随后续 Task 逐个解注释):

```rust
pub mod db;
// pub mod models;
// pub mod eval;
// pub mod memory;
// pub mod ai;
// pub mod prompts;
// pub mod sched;

#[derive(thiserror::Error, Debug)]
pub enum CoreError {
    #[error("db: {0}")] Db(#[from] rusqlite::Error),
    #[error("io: {0}")] Io(#[from] std::io::Error),
    #[error("eval parse: {0}")] EvalParse(String),
    #[error("ai: {0}")] Ai(String),
    #[error("{0}")] Other(String),
}
pub type Result<T> = std::result::Result<T, CoreError>;
```

- [x] **Step 0.7** `cd core && cargo build` 通过(先建空的 `src/db.rs`,内容 `// L1-T1`);`git add core && git commit -m "chore(core): crate 脚手架 (L1-T0)"`

### Task 1: db — schema v1 与 migration

**Files:** Modify: `core/src/db.rs`, `core/src/lib.rs`(启用 mod)

- [x] **Step 1.1 失败测试**(置于 `db.rs` 底部 `#[cfg(test)] mod tests`):

```rust
#[test]
fn open_creates_schema_v1() {
    let conn = super::open_in_memory().unwrap();
    let v: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
    assert_eq!(v, 1);
    for t in ["book","knowledge_block","study_plan","daily_task",
              "feynman_session","weak_point","review_schedule","artifact","setting"] {
        let n: i64 = conn.query_row(
            "SELECT count(*) FROM sqlite_master WHERE type='table' AND name=?1",
            [t], |r| r.get(0)).unwrap();
        assert_eq!(n, 1, "missing table {t}");
    }
}
#[test]
fn open_is_idempotent() {
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("a.db");
    super::open(&p).unwrap();
    super::open(&p).unwrap(); // 再次打开不报错、不重复建表
}
```

- [x] **Step 1.2** `cargo test` → FAIL(open 未定义)
- [x] **Step 1.3 实现**:

```rust
use rusqlite::Connection;

pub fn open(path: &std::path::Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open(path)?; migrate(&conn)?; Ok(conn)
}
pub fn open_in_memory() -> rusqlite::Result<Connection> {
    let conn = Connection::open_in_memory()?; migrate(&conn)?; Ok(conn)
}
fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    let v: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if v < 1 { conn.execute_batch(SCHEMA_V1)?; conn.pragma_update(None, "user_version", &1)?; }
    Ok(())
}

const SCHEMA_V1: &str = r#"
CREATE TABLE book(
  id INTEGER PRIMARY KEY, title TEXT NOT NULL, author TEXT DEFAULT '',
  type TEXT NOT NULL CHECK(type IN ('textbook','methodology','humanities')),
  epub_path TEXT DEFAULT '', cover_path TEXT DEFAULT '',
  slug TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','finished')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE knowledge_block(
  id INTEGER PRIMARY KEY, book_id INTEGER NOT NULL REFERENCES book(id),
  module_name TEXT NOT NULL DEFAULT '', seq INTEGER NOT NULL,
  title TEXT NOT NULL, slug TEXT NOT NULL,
  spine_href TEXT DEFAULT '', cfi_start TEXT DEFAULT '', cfi_end TEXT DEFAULT '',
  prereq_ids TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'unlearned'
    CHECK(status IN ('unlearned','learning','passed','weak','consolidated')),
  scores_json TEXT, passed_at TEXT, skipped INTEGER NOT NULL DEFAULT 0);
CREATE TABLE study_plan(
  id INTEGER PRIMARY KEY, book_id INTEGER NOT NULL REFERENCES book(id),
  deadline TEXT NOT NULL, daily_new_blocks INTEGER NOT NULL,
  daily_cap INTEGER NOT NULL DEFAULT 4,
  remind_time TEXT DEFAULT '20:00', evening_remind_time TEXT DEFAULT '22:00',
  active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE daily_task(
  id INTEGER PRIMARY KEY, date TEXT NOT NULL,
  book_id INTEGER NOT NULL, block_id INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('new','weak_retest','review')),
  seq INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','done','skipped')),
  est_minutes INTEGER NOT NULL DEFAULT 30, done_at TEXT,
  ref_id INTEGER);
CREATE TABLE feynman_session(
  id INTEGER PRIMARY KEY, block_id INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('learn','retest','review','final_exam')),
  transcript_json TEXT NOT NULL DEFAULT '[]', eval_json TEXT,
  started_at TEXT NOT NULL, ended_at TEXT, pomodoro_count INTEGER NOT NULL DEFAULT 0);
CREATE TABLE weak_point(
  id INTEGER PRIMARY KEY, block_id INTEGER NOT NULL,
  title TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', anchor_json TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','fixed')),
  pass_streak INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, fixed_at TEXT);
CREATE TABLE review_schedule(
  id INTEGER PRIMARY KEY, block_id INTEGER NOT NULL,
  stage INTEGER NOT NULL CHECK(stage IN (1,3,7,14)),
  due_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'due' CHECK(status IN ('due','done','failed')));
CREATE TABLE artifact(
  id INTEGER PRIMARY KEY, book_id INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('restatement','methodology','reflection','application','report')),
  block_id INTEGER, content_md TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE setting(key TEXT PRIMARY KEY, value TEXT NOT NULL);
"#;
```

- [x] **Step 1.4** `cargo test` → PASS
- [x] **Step 1.5** 回写 `TECH_DESIGN.md` §4:daily_task 增加 `ref_id`(指向 weak_point.id 或 review_schedule.id);DEVLOG 记一条。
- [x] **Step 1.6** `git add -A && git commit -m "feat(core): SQLite schema v1 与 migration (L1-T1)"`

### Task 2: eval — 评估 JSON 严格解析

**Files:** Create: `core/src/eval.rs`;Modify: `lib.rs`

- [x] **Step 2.1 失败测试**:

```rust
#[test]
fn parse_valid_eval() {
    let s = r#"评估如下:
```json
{"verdict":"pass_suggested","scores":{"accuracy":4,"completeness":3,"clarity":5},
 "summary":"整体清晰","weak_points":[{"title":"弹性vs斜率","detail":"混淆",
 "fixed_in_session":true,"anchor":{"chapter_href":"ch03.xhtml","hint":"第二节"}}],
 "final_restatement":"弹性是相对变化率……","observation_note":"倾向用比喻"}
```"#;
    let e = super::parse_eval(s).unwrap();
    assert_eq!(e.verdict, super::Verdict::PassSuggested);
    assert_eq!(e.scores.accuracy, 4);
    assert!(e.weak_points[0].fixed_in_session);
}
#[test]
fn reject_out_of_range_score() {
    let s = r#"{"verdict":"pass_suggested","scores":{"accuracy":9,"completeness":3,"clarity":5},
 "summary":"x","final_restatement":"y"}"#;
    assert!(super::parse_eval(s).is_err());
}
#[test]
fn reject_unknown_field() {
    let s = r#"{"verdict":"pass_suggested","scores":{"accuracy":4,"completeness":3,"clarity":5},
 "summary":"x","final_restatement":"y","extra":1}"#;
    assert!(super::parse_eval(s).is_err());
}
```

- [x] **Step 2.2** FAIL 确认 → **Step 2.3 实现**:

```rust
use serde::Deserialize;
use crate::{CoreError, Result};

#[derive(Debug, serde::Serialize, Deserialize, PartialEq, Clone)]
#[serde(rename_all = "snake_case")]
pub enum Verdict { PassSuggested, RelearnSuggested }

#[derive(Debug, serde::Serialize, Deserialize, PartialEq, Clone)]
#[serde(deny_unknown_fields)]
pub struct Scores { pub accuracy: u8, pub completeness: u8, pub clarity: u8 }

#[derive(Debug, serde::Serialize, Deserialize, PartialEq, Clone)]
#[serde(deny_unknown_fields)]
pub struct Anchor { pub chapter_href: String, pub hint: String }

#[derive(Debug, serde::Serialize, Deserialize, PartialEq, Clone)]
#[serde(deny_unknown_fields)]
pub struct WeakPointItem {
    pub title: String, pub detail: String,
    #[serde(default)] pub fixed_in_session: bool,
    #[serde(default)] pub anchor: Option<Anchor>,
}

#[derive(Debug, serde::Serialize, Deserialize, PartialEq, Clone)]
#[serde(deny_unknown_fields)]
pub struct EvalResult {
    pub verdict: Verdict, pub scores: Scores, pub summary: String,
    #[serde(default)] pub weak_points: Vec<WeakPointItem>,
    pub final_restatement: String,
    #[serde(default)] pub observation_note: String,
}

/// 从可能带 markdown 围栏/前后缀文本中提取首个 `{`..末个 `}` 并严格解析。
pub fn parse_eval(raw: &str) -> Result<EvalResult> {
    let start = raw.find('{').ok_or_else(|| CoreError::EvalParse("no json".into()))?;
    let end = raw.rfind('}').ok_or_else(|| CoreError::EvalParse("no json".into()))?;
    let e: EvalResult = serde_json::from_str(&raw[start..=end])
        .map_err(|e| CoreError::EvalParse(e.to_string()))?;
    for s in [e.scores.accuracy, e.scores.completeness, e.scores.clarity] {
        if !(1..=5).contains(&s) { return Err(CoreError::EvalParse(format!("score {s} out of 1..=5"))); }
    }
    Ok(e)
}
```

- [x] **Step 2.4** PASS → **Step 2.5** `git commit -m "feat(core): 评估 JSON 严格解析 (L1-T2)"`

### Task 3: models — 领域模型与 book/block 存取

**Files:** Create: `core/src/models.rs`

- [x] **Step 3.1 失败测试**:

```rust
#[test]
fn insert_and_fetch_book_with_blocks() {
    let conn = crate::db::open_in_memory().unwrap();
    let b = super::insert_book(&conn, "微观经济学", "曼昆", super::BookType::Textbook, "microecon").unwrap();
    super::insert_block(&conn, b, "供给与需求", 1, "供需弹性", "elasticity", &[]).unwrap();
    super::insert_block(&conn, b, "供给与需求", 2, "消费者剩余", "surplus", &[1]).unwrap();
    let blocks = super::list_blocks(&conn, b).unwrap();
    assert_eq!(blocks.len(), 2);
    assert_eq!(blocks[0].title, "供需弹性");
    assert_eq!(blocks[1].prereq_ids, vec![1]);
    let next = super::next_new_blocks(&conn, b, 1).unwrap();
    assert_eq!(next[0].seq, 1);
}
```

- [x] **Step 3.2** FAIL → **Step 3.3 实现**(要点;字段与 schema 一一对应):

```rust
use rusqlite::Connection;
use crate::Result;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum BookType { Textbook, Methodology, Humanities }
impl BookType {
    pub fn as_str(&self) -> &'static str {
        match self { Self::Textbook=>"textbook", Self::Methodology=>"methodology", Self::Humanities=>"humanities" }
    }
    pub fn from_str(s: &str) -> Self {
        match s { "methodology"=>Self::Methodology, "humanities"=>Self::Humanities, _=>Self::Textbook }
    }
}

#[derive(Debug, Clone)]
pub struct KnowledgeBlock {
    pub id: i64, pub book_id: i64, pub module_name: String, pub seq: i64,
    pub title: String, pub slug: String, pub prereq_ids: Vec<i64>,
    pub status: String, pub scores_json: Option<String>, pub passed_at: Option<String>,
}

pub fn insert_book(conn: &Connection, title: &str, author: &str, ty: BookType, slug: &str) -> Result<i64> {
    conn.execute("INSERT INTO book(title,author,type,slug) VALUES(?1,?2,?3,?4)",
        rusqlite::params![title, author, ty.as_str(), slug])?;
    Ok(conn.last_insert_rowid())
}
pub fn insert_block(conn: &Connection, book_id: i64, module: &str, seq: i64,
                    title: &str, slug: &str, prereqs: &[i64]) -> Result<i64> {
    conn.execute(
        "INSERT INTO knowledge_block(book_id,module_name,seq,title,slug,prereq_ids) VALUES(?1,?2,?3,?4,?5,?6)",
        rusqlite::params![book_id, module, seq, title, slug, serde_json::to_string(prereqs).unwrap()])?;
    Ok(conn.last_insert_rowid())
}
fn row_to_block(r: &rusqlite::Row) -> rusqlite::Result<KnowledgeBlock> { /* 按列序映射,prereq_ids 用 serde_json 解析 */ }
pub fn list_blocks(conn: &Connection, book_id: i64) -> Result<Vec<KnowledgeBlock>> { /* WHERE book_id=? ORDER BY seq */ }
pub fn next_new_blocks(conn: &Connection, book_id: i64, n: usize) -> Result<Vec<KnowledgeBlock>> {
    /* WHERE book_id=? AND status='unlearned' AND skipped=0 ORDER BY seq LIMIT n */
}
pub fn get_book_slug_type(conn: &Connection, book_id: i64) -> Result<(String, BookType)> { /* SELECT slug,type */ }
```

- [x] **Step 3.4** PASS → **Step 3.5** `git commit -m "feat(core): 领域模型与 book/block 存取 (L1-T3)"`

### Task 4: memory — 初始化与文件模板

**Files:** Create: `core/src/memory.rs`

设计(TECH §3):`MemoryStore { root }`。init 创建 `INDEX.md`/`profile.md` 模板并 `git init`;`ensure_book` 创建 `books/<slug>/{_map.md,_weakpoints.md,blocks/}`;`_map.md`/`_weakpoints.md` 永远由 `sync_map`/`sync_weakpoints` 从 SQLite 数据再生(镜像),块文件为累积内容。

- [x] **Step 4.1 失败测试**:

```rust
#[test]
fn init_creates_templates_and_git() {
    let dir = tempfile::tempdir().unwrap();
    let m = super::MemoryStore::init(dir.path()).unwrap();
    assert!(dir.path().join("INDEX.md").exists());
    assert!(dir.path().join("profile.md").exists());
    assert!(dir.path().join(".git").exists());
    let prof = std::fs::read_to_string(dir.path().join("profile.md")).unwrap();
    for sec in ["## 知识背景","## 已掌握概念","## 误区模式","## 个人情境"] {
        assert!(prof.contains(sec));
    }
    let _ = m;
}
#[test]
fn ensure_book_creates_book_dir_and_updates_index() {
    let dir = tempfile::tempdir().unwrap();
    let m = super::MemoryStore::init(dir.path()).unwrap();
    m.ensure_book("microecon", "微观经济学").unwrap();
    assert!(dir.path().join("books/microecon/blocks").is_dir());
    assert!(dir.path().join("books/microecon/_map.md").exists());
    assert!(dir.path().join("books/microecon/_weakpoints.md").exists());
    assert!(std::fs::read_to_string(dir.path().join("INDEX.md")).unwrap().contains("微观经济学"));
}
```

- [x] **Step 4.2** FAIL → **Step 4.3 实现要点**:
  - `init`:mkdir_p;若文件不存在写模板(INDEX 头部 + 空书表;profile 四节);`git init` + 首次 commit(子进程,`git -C <root> …`;需设 `user.name/email` 本地配置为 `book-learner`,避免服务器无全局配置时失败)。
  - `ensure_book(slug, title)`:建目录与两个镜像文件占位;INDEX.md 书表追加一行(存在则跳过)。
- [x] **Step 4.4** PASS → **Step 4.5** `git commit -m "feat(core): 记忆库初始化与模板 (L1-T4)"`

### Task 5: memory — apply_eval 与镜像再生

**Files:** Modify: `core/src/memory.rs`

- [x] **Step 5.1 失败测试**:

```rust
fn sample_eval(pass: bool) -> crate::eval::EvalResult { /* 构造:1 个未修复薄弱点 + observation_note */ }

#[test]
fn apply_eval_writes_block_file_and_accumulates() {
    let dir = tempfile::tempdir().unwrap();
    let m = super::MemoryStore::init(dir.path()).unwrap();
    m.ensure_book("microecon", "微观经济学").unwrap();
    m.apply_eval("microecon", 3, "供需弹性", "elasticity", &sample_eval(false), "2026-08-29").unwrap();
    m.apply_eval("microecon", 3, "供需弹性", "elasticity", &sample_eval(true),  "2026-08-30").unwrap();
    let f = std::fs::read_to_string(dir.path().join("books/microecon/blocks/03-elasticity.md")).unwrap();
    assert!(f.contains("status: passed"));
    assert!(f.contains("## 复述终稿"));         // 终稿=最近一次 pass 的 final_restatement
    assert!(f.matches("- 2026-08-").count() >= 2); // 评估历史两条都在
    assert!(f.contains("## AI 观察笔记"));      // 笔记只增不减
}
#[test]
fn sync_weakpoints_regenerates_mirror() {
    let dir = tempfile::tempdir().unwrap();
    let m = super::MemoryStore::init(dir.path()).unwrap();
    m.ensure_book("microecon", "微观经济学").unwrap();
    m.sync_weakpoints("microecon",
        &[("供需弹性".into(), "弹性vs斜率".into(), "2026-08-30".into())],
        &[("消费者剩余".into(), "混淆总剩余".into(), "2026-08-28".into())]).unwrap();
    let f = std::fs::read_to_string(dir.path().join("books/microecon/_weakpoints.md")).unwrap();
    let (open_pos, fixed_pos) = (f.find("## 待考").unwrap(), f.find("## 已修复").unwrap());
    assert!(f.find("弹性vs斜率").unwrap() > open_pos && f.find("弹性vs斜率").unwrap() < fixed_pos);
    assert!(f.find("混淆总剩余").unwrap() > fixed_pos);
}
#[test]
fn sync_map_regenerates_mirror() {
    let dir = tempfile::tempdir().unwrap();
    let m = super::MemoryStore::init(dir.path()).unwrap();
    m.ensure_book("microecon", "微观经济学").unwrap();
    m.sync_map("microecon", "微观经济学",
        &[("供需弹性".into(), "passed".into()), ("消费者剩余".into(), "unlearned".into())]).unwrap();
    let f = std::fs::read_to_string(dir.path().join("books/microecon/_map.md")).unwrap();
    assert!(f.contains("供需弹性") && f.contains("passed") && f.contains("消费者剩余"));
}
```

- [x] **Step 5.2** FAIL → **Step 5.3 实现要点**:
  - 块文件解析:按 `## 复述终稿` / `## 评估历史` / `## AI 观察笔记` 三个标记切分旧内容;frontmatter 全量再生(status/scores/passed_at/review_stage),`status` 由 verdict 决定(pass→passed,relearn→learning);评估历史**前插**一行 `- <date> 第N次:<verdict中文>;薄弱点:<titles(已当场修复标记)>`;observation_note 非空则**追加**到笔记区;verdict=pass 时终稿替换为 final_restatement,否则保留旧终稿。
  - frontmatter 的 `review_stage` 在 apply_eval 时恒写 0(该字段由调度层维护于 SQLite,md 中仅作展示,后续由 sync_map 层面体现进度)。
  - `sync_weakpoints(slug, open, fixed)` 与 `sync_map(slug, title, blocks: &[(String,String)])`(title+status):整文件再生。
- [x] **Step 5.4** PASS → **Step 5.5** `git commit -m "feat(core): apply_eval 块文件累积与镜像再生 (L1-T5)"`

### Task 6: memory — git 自动 commit

**Files:** Modify: `core/src/memory.rs`

- [x] **Step 6.1 失败测试**:

```rust
#[test]
fn commit_creates_git_commit_and_tolerates_empty() {
    let dir = tempfile::tempdir().unwrap();
    let m = super::MemoryStore::init(dir.path()).unwrap();
    m.ensure_book("microecon", "微观经济学").unwrap();
    m.commit("study: 微观经济学/供需弹性 2026-08-30").unwrap();
    m.commit("study: 空提交容忍").unwrap(); // 无变更不报错
    let log = std::process::Command::new("git").args(["-C"]).arg(dir.path())
        .args(["log","--oneline"]).output().unwrap();
    assert!(String::from_utf8_lossy(&log.stdout).contains("供需弹性"));
}
```

- [x] **Step 6.2** FAIL → **Step 6.3 实现**:`git -C root add -A` 后 `git -C root commit -m msg`;commit 退出码非 0 时检查 stdout/stderr 含 "nothing to commit" 则 Ok,否则 Err。
- [x] **Step 6.4** PASS → **Step 6.5** `git commit -m "feat(core): 记忆库 git 自动提交 (L1-T6)"`

### Task 7: ai — AiProvider trait 与 CodexCliProvider

**Files:** Create: `core/src/ai.rs`

- [x] **Step 7.1 失败测试**(假 codex 脚本):

```rust
fn fake_codex(dir: &std::path::Path, body: &str) -> std::path::PathBuf {
    // 生成可执行脚本:扫描参数取 --output-last-message 的下一个参数为输出路径,写入 body
    let p = dir.join("fake-codex");
    std::fs::write(&p, format!("#!/bin/bash
while [[ $# -gt 0 ]]; do
  if [[ \"$1\" == \"--output-last-message\" ]]; then out=\"$2\"; shift; fi; shift; done
printf '%s' '{body}' > \"$out\"
")).unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
    p
}

#[test]
fn codex_provider_returns_last_message() {
    let dir = tempfile::tempdir().unwrap();
    let bin = fake_codex(dir.path(), "你好,我是学生");
    let p = super::CodexCliProvider { bin, extra_args: vec![] };
    let req = super::CompletionRequest {
        system: "s".into(), messages: vec![(super::Role::User, "讲弹性".into())],
        workdir: dir.path().to_path_buf(), read_only: true, timeout_secs: 10 };
    assert_eq!(super::AiProvider::complete(&p, &req).unwrap(), "你好,我是学生");
}
#[test]
fn codex_provider_times_out() {
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("slow-codex");
    std::fs::write(&p, "#!/bin/bash\nsleep 30\n").unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
    let prov = super::CodexCliProvider { bin: p, extra_args: vec![] };
    let req = super::CompletionRequest { system: "".into(), messages: vec![],
        workdir: dir.path().to_path_buf(), read_only: true, timeout_secs: 1 };
    assert!(super::AiProvider::complete(&prov, &req).is_err());
}
```

- [x] **Step 7.2** FAIL → **Step 7.3 实现**:

```rust
pub enum Role { User, Assistant }
pub struct CompletionRequest { pub system: String, pub messages: Vec<(Role,String)>,
    pub workdir: std::path::PathBuf, pub read_only: bool, pub timeout_secs: u64 }
pub trait AiProvider { fn complete(&self, req: &CompletionRequest) -> crate::Result<String>; }
pub struct CodexCliProvider { pub bin: std::path::PathBuf, pub extra_args: Vec<String> }
```

  - prompt 渲染:`system + "\n\n=== 对话记录 ===\n" + 每轮 "用户:…"/"学生:…" + "\n(请给出你的下一条回复)"`(无历史则省略对话段)。
  - 子进程:`bin exec -C workdir --sandbox (read-only|workspace-write) --output-last-message <tmp> <prompt>`;`spawn` 后循环 `try_wait` + 100ms sleep,超时 `kill` 并返回 `CoreError::Ai("timeout")`;退出码非 0 → Err(带 stderr 摘要);读 tmp 文件为回复,空文件 → Err。
- [x] **Step 7.4** PASS → **Step 7.5 真实冒烟(手动)**:

```rust
#[test] #[ignore] // 需要本机已登录 codex;手动 cargo test -- --ignored 运行
fn codex_real_smoke() {
    let dir = tempfile::tempdir().unwrap();
    let p = super::CodexCliProvider { bin: "codex".into(), extra_args: vec![] };
    let req = super::CompletionRequest { system: "只回答一个词".into(),
        messages: vec![(super::Role::User, "1+1=?".into())],
        workdir: dir.path().to_path_buf(), read_only: true, timeout_secs: 120 };
    let out = super::AiProvider::complete(&p, &req).unwrap();
    assert!(!out.is_empty());
}
```

  运行 `cargo test codex_real_smoke -- --ignored`,把真实行为(参数是否兼容 0.144.4、耗时)记入 DEVLOG。
- [x] **Step 7.6** `git commit -m "feat(core): AiProvider trait 与 codex CLI 子进程实现 (L1-T7)"`

### Task 8: prompts — 固定注入与 prompt 构造

**Files:** Create: `core/src/prompts.rs`

- [x] **Step 8.1 失败测试**:

```rust
fn ctx() -> super::FixedContext { /* profile_summary/block_title/block_source_text/
    eval_history/related_weakpoints/prereq_status 各填样例 */ }

#[test]
fn feynman_system_contains_rules_and_context() {
    let s = super::feynman_system(crate::models::BookType::Textbook, &ctx());
    for k in ["扮演", "学生", "绝不讲课", "[READY_TO_END]", "边界条件"] { assert!(s.contains(k), "missing {k}"); }
    assert!(s.contains("供需弹性原文样例")); // 注入的原文
    assert!(s.contains("弹性vs斜率"));       // 注入的薄弱点
}
#[test]
fn feynman_system_varies_by_book_type() {
    let a = super::feynman_system(crate::models::BookType::Textbook, &ctx());
    let b = super::feynman_system(crate::models::BookType::Humanities, &ctx());
    assert!(a.contains("边界条件") && !b.contains("边界条件"));
    assert!(b.contains("因果"));
}
#[test]
fn review_quiz_prompt_and_result_parse() {
    let s = super::review_quiz_prompt(&ctx());
    for k in ["快问", "薄弱点", "JSON"] { assert!(s.contains(k), "missing {k}"); }
    let r = crate::eval::parse_quiz(r#"{"passed":true,"comment":"答出了要点"}"#).unwrap();
    assert!(r.passed && r.new_weak_point.is_none());
}
#[test]
fn eval_prompt_demands_json_only() {
    let s = super::eval_prompt(&ctx(), "用户:...\n学生:...");
    for k in ["评估", "准确性", "完整性", "清晰度", "最后一条消息只输出 JSON", "fixed_in_session"] {
        assert!(s.contains(k), "missing {k}");
    }
}
```

- [x] **Step 8.2** FAIL → **Step 8.3 实现**:`FixedContext` struct + 三个构造器 `feynman_system` / `eval_prompt` / `review_quiz_prompt`(TECH §6.2/6.3/6.7 的中文模板,`format!` 拼装;书籍类型侧重段:教材=准确性/推导/边界条件,方法论=框架要素/案例,人文=因果链/时间线)。同时在 `eval.rs` 增加 §6.7 响应解析:`pub struct QuizResult { pub passed: bool, pub comment: String, #[serde(default)] pub new_weak_point: Option<WeakPointItem> }` 与 `parse_quiz`(提取/严格规则同 `parse_eval`)。地图生成、迁移应用、情境化、终评 prompt 属 Mac 阶段流程,**本期不实现**(YAGNI,模板文本已在 TECH §6 备好)。
- [x] **Step 8.4** PASS → **Step 8.5** `git commit -m "feat(core): 固定注入与费曼/评估/复习 prompt 构造 (L1-T8)"`

### Task 9: sched — 每日队列生成

**Files:** Create: `core/src/sched.rs`

- [x] **Step 9.1 失败测试**:

```rust
fn setup() -> (rusqlite::Connection, i64) {
    let conn = crate::db::open_in_memory().unwrap();
    let b = crate::models::insert_book(&conn, "书", "", crate::models::BookType::Textbook, "bk").unwrap();
    for i in 1..=6 { crate::models::insert_block(&conn, b, "m", i, &format!("块{i}"), &format!("b{i}"), &[]).unwrap(); }
    conn.execute("INSERT INTO study_plan(book_id,deadline,daily_new_blocks) VALUES(?1,'2026-09-30',2)", [b]).unwrap();
    (conn, b)
}

#[test]
fn daily_queue_orders_weak_then_review_then_new() {
    let (conn, b) = setup();
    // 3+1 个 open 薄弱点(第 4 个应被截断)、1 个到期复习、配额 2 个新块
    for i in 0..4 { conn.execute(
        "INSERT INTO weak_point(block_id,title,created_at) VALUES(1,?1,?2)",
        rusqlite::params![format!("wp{i}"), format!("2026-08-2{i}")]).unwrap(); }
    conn.execute("INSERT INTO review_schedule(block_id,stage,due_date) VALUES(2,1,'2026-08-30')", []).unwrap();
    let q = super::generate_daily(&conn, "2026-08-30").unwrap();
    let kinds: Vec<_> = q.iter().map(|t| t.kind.clone()).collect();
    assert_eq!(kinds, ["weak_retest","weak_retest","weak_retest","review","new","new"]);
    let _ = b;
}
#[test]
fn generate_daily_is_idempotent() {
    let (conn, _) = setup();
    assert_eq!(super::generate_daily(&conn, "2026-08-30").unwrap().len(),
               super::generate_daily(&conn, "2026-08-30").unwrap().len());
    let n: i64 = conn.query_row("SELECT count(*) FROM daily_task WHERE date='2026-08-30'", [], |r| r.get(0)).unwrap();
    assert_eq!(n, 2); // 无薄弱点/复习时只有 2 个新块,且不重复插入
}
```

- [x] **Step 9.2** FAIL → **Step 9.3 实现**:`DailyTask` struct;`generate_daily(conn, date)`:该日已有任务→直接查回;否则事务内:open weak_point 按 created_at 取 ≤3(est 10min)→ due review(est 5min)→ active plan 的 daily_new_blocks 个 `next_new_blocks`(est 30min);seq 递增插入,`ref_id` 记 weak_point/review_schedule id。
- [x] **Step 9.4** PASS → **Step 9.5** `git commit -m "feat(core): 每日队列生成 (L1-T9)"`

### Task 10: sched — 通过流转与间隔重复

**Files:** Modify: `core/src/sched.rs`

- [x] **Step 10.1 失败测试**:

```rust
#[test]
fn block_pass_schedules_stage1_review() {
    let (conn, _) = setup();
    super::on_block_passed(&conn, 1, "2026-08-30").unwrap();
    super::on_block_passed(&conn, 1, "2026-08-30").unwrap(); // 幂等:二次调用不重复排复习
    let (stage, due): (i64, String) = conn.query_row(
        "SELECT stage,due_date FROM review_schedule WHERE block_id=1", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
    assert_eq!((stage, due.as_str()), (1, "2026-08-31"));
    let n: i64 = conn.query_row("SELECT count(*) FROM review_schedule WHERE block_id=1", [], |r| r.get(0)).unwrap();
    assert_eq!(n, 1);
}
#[test]
fn review_pass_advances_and_consolidates() {
    let (conn, _) = setup();
    super::on_block_passed(&conn, 1, "2026-08-30").unwrap();
    for (day, expect_next) in [("2026-08-31", 3i64), ("2026-09-03", 7), ("2026-09-10", 14)] {
        let id: i64 = conn.query_row("SELECT id FROM review_schedule WHERE block_id=1 AND status='due'", [], |r| r.get(0)).unwrap();
        super::on_review_result(&conn, id, true, day).unwrap();
        let next: i64 = conn.query_row("SELECT stage FROM review_schedule WHERE block_id=1 AND status='due'", [], |r| r.get(0)).unwrap();
        assert_eq!(next, expect_next);
    }
    let id: i64 = conn.query_row("SELECT id FROM review_schedule WHERE block_id=1 AND status='due'", [], |r| r.get(0)).unwrap();
    super::on_review_result(&conn, id, true, "2026-09-24").unwrap();
    let st: String = conn.query_row("SELECT status FROM knowledge_block WHERE id=1", [], |r| r.get(0)).unwrap();
    assert_eq!(st, "consolidated"); // 14 天档通过后不再有 due
}
#[test]
fn review_fail_resets_and_creates_weakpoint() {
    let (conn, _) = setup();
    super::on_block_passed(&conn, 1, "2026-08-30").unwrap();
    let id: i64 = conn.query_row("SELECT id FROM review_schedule WHERE block_id=1", [], |r| r.get(0)).unwrap();
    super::on_review_result(&conn, id, false, "2026-08-31").unwrap();
    let (stage, due): (i64, String) = conn.query_row(
        "SELECT stage,due_date FROM review_schedule WHERE block_id=1 AND status='due'", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
    assert_eq!((stage, due.as_str()), (1, "2026-09-01")); // 重置回 1 天档
    let n: i64 = conn.query_row("SELECT count(*) FROM weak_point WHERE block_id=1 AND status='open'", [], |r| r.get(0)).unwrap();
    assert_eq!(n, 1);
}
#[test]
fn apply_eval_to_db_persists_status_scores_weakpoints_and_schedules() {
    let (conn, _) = setup();
    let e: crate::eval::EvalResult = serde_json::from_str(r#"{
        "verdict":"pass_suggested","scores":{"accuracy":4,"completeness":3,"clarity":5},
        "summary":"s","final_restatement":"r","weak_points":[
          {"title":"未修复点","detail":"d"},
          {"title":"已当场修复","detail":"d","fixed_in_session":true}]}"#).unwrap();
    super::apply_eval_to_db(&conn, 1, &e, "2026-08-30").unwrap();
    let (st, passed_at, scores): (String, Option<String>, Option<String>) = conn.query_row(
        "SELECT status,passed_at,scores_json FROM knowledge_block WHERE id=1", [],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap();
    assert_eq!(st, "passed");
    assert_eq!(passed_at.as_deref(), Some("2026-08-30"));
    assert!(scores.unwrap().contains("\"accuracy\":4"));
    let n: i64 = conn.query_row("SELECT count(*) FROM weak_point WHERE block_id=1 AND status='open'",
        [], |r| r.get(0)).unwrap();
    assert_eq!(n, 1); // fixed_in_session 的不入库
    let n2: i64 = conn.query_row("SELECT count(*) FROM review_schedule WHERE block_id=1 AND stage=1",
        [], |r| r.get(0)).unwrap();
    assert_eq!(n2, 1); // pass → 自动排 stage1 复习
}
#[test]
fn apply_eval_to_db_relearn_keeps_unpassed() {
    let (conn, _) = setup();
    let e: crate::eval::EvalResult = serde_json::from_str(r#"{
        "verdict":"relearn_suggested","scores":{"accuracy":2,"completeness":2,"clarity":3},
        "summary":"s","final_restatement":"r"}"#).unwrap();
    super::apply_eval_to_db(&conn, 1, &e, "2026-08-30").unwrap();
    let st: String = conn.query_row("SELECT status FROM knowledge_block WHERE id=1", [], |r| r.get(0)).unwrap();
    assert_eq!(st, "learning");
    let n: i64 = conn.query_row("SELECT count(*) FROM review_schedule", [], |r| r.get(0)).unwrap();
    assert_eq!(n, 0); // 未通过不排复习
}
#[test]
fn weak_retest_two_passes_fixes() {
    let (conn, _) = setup();
    conn.execute("INSERT INTO weak_point(block_id,title,created_at) VALUES(1,'w','2026-08-29')", []).unwrap();
    super::on_weak_retest(&conn, 1, true, "2026-08-30").unwrap();
    super::on_weak_retest(&conn, 1, true, "2026-08-31").unwrap();
    let st: String = conn.query_row("SELECT status FROM weak_point WHERE id=1", [], |r| r.get(0)).unwrap();
    assert_eq!(st, "fixed");
}
```

- [x] **Step 10.2** FAIL → **Step 10.3 实现**:
  - 日期运算用 chrono `NaiveDate`;stage 推进映射 `1→3→7→14→consolidated`;**推进后的 due_date = 本次结果日期 + 下一档天数**(与 fail 重置"结果日期+1"口径一致)。
  - `on_block_passed(conn, block_id, date)`:置 `knowledge_block.status='passed', passed_at=date`(幂等)并插入 stage1 复习(due=date+1)。
  - **`apply_eval_to_db(conn, block_id, &EvalResult, date)`(评估落库的唯一入口,TECH §3.3 的 SQLite 半边)**:更新 `knowledge_block.scores_json`;verdict=pass → 调 `on_block_passed`;verdict=relearn → `status='learning'`;将 `fixed_in_session=false` 的 weak_points 逐条 INSERT 进 `weak_point` 表(anchor 序列化进 anchor_json)。
  - `on_weak_retest(id, pass, date)`:pass→pass_streak+1,≥2 置 fixed(记 fixed_at);fail→streak 清零。
  - 查询辅助 `list_weakpoints(conn, book_id) -> (open: Vec<(String,String,String)>, fixed: Vec<...>)`(块标题/薄弱点标题/日期),供 `sync_weakpoints` 镜像与 Mac 壳复用,避免调用方手写 SQL。
- [x] **Step 10.4** PASS → **Step 10.5** `git commit -m "feat(core): 间隔重复流转与薄弱点重考 (L1-T10)"`

### Task 11: sched — 落后检测与重排

**Files:** Modify: `core/src/sched.rs`

- [x] **Step 11.1 失败测试**:

```rust
#[test]
fn behind_two_days_triggers_replan() {
    let (conn, b) = setup(); // 6 块,daily_new_blocks=2,deadline 2026-09-30
    for d in ["2026-08-28","2026-08-29"] { // 两天 new 任务全 pending
        conn.execute("INSERT INTO daily_task(date,book_id,block_id,kind,seq) VALUES(?1,?2,1,'new',1)",
            rusqlite::params![d, b]).unwrap();
    }
    match super::check_behind(&conn, b, "2026-08-30").unwrap() {
        super::Replan::AutoAdjusted { new_daily } => assert!(new_daily >= 1), // 6 块/31 天,cap 内
        other => panic!("expect AutoAdjusted, got {other:?}"),
    }
}
#[test]
fn replan_over_cap_needs_decision() {
    let (conn, b) = setup();
    conn.execute("UPDATE study_plan SET deadline='2026-08-31'", []).unwrap(); // 只剩 1 天,6 块 > cap 4
    for d in ["2026-08-28","2026-08-29"] {
        conn.execute("INSERT INTO daily_task(date,book_id,block_id,kind,seq) VALUES(?1,?2,1,'new',1)",
            rusqlite::params![d, b]).unwrap();
    }
    assert!(matches!(super::check_behind(&conn, b, "2026-08-30").unwrap(),
        super::Replan::NeedsDecision { required_daily: 6, cap: 4 }));
}
#[test]
fn on_track_returns_ok() {
    let (conn, b) = setup();
    assert!(matches!(super::check_behind(&conn, b, "2026-08-30").unwrap(), super::Replan::OnTrack));
}
```

- [x] **Step 11.2** FAIL → **Step 11.3 实现**:`enum Replan { OnTrack, AutoAdjusted{new_daily: i64}, NeedsDecision{required_daily: i64, cap: i64} }`;判定:近 2 个"有 new 任务的日期"其 new 任务均非 done → behind;`required = ceil(剩余未学块 / max(1, 截止-今天天数))`;≤cap → AutoAdjusted 并 `UPDATE study_plan.daily_new_blocks`;>cap → NeedsDecision(截止日不动,交上层确认——PRODUCT §6)。
- [x] **Step 11.4** PASS → **Step 11.5** `git commit -m "feat(core): 落后检测与自动重排 (L1-T11)"`

### Task 12: 端到端集成测试(生命周期)

**Files:** Create: `core/tests/lifecycle.rs`;Modify: `lib.rs`(公开 API 检查)

- [x] **Step 12.1** 写集成测试(用 MockProvider 返回 canned 评估 JSON,不依赖 codex):

```rust
use book_learner_core::*;

struct MockProvider(String);
impl ai::AiProvider for MockProvider {
    fn complete(&self, _req: &ai::CompletionRequest) -> Result<String> { Ok(self.0.clone()) }
}

#[test]
fn full_block_lifecycle() {
    // Day0: 建库建书 → 记忆库 init/ensure_book → 生成每日队列(2 个新块)
    // 学块1:MockProvider 返回 pass 评估(带 1 个未修复薄弱点)→ parse_eval →
    //   sched::apply_eval_to_db(SQLite:状态/分数/薄弱点/排复习)→
    //   memory.apply_eval + sync_weakpoints + sync_map + memory.commit(md 镜像)
    // Day1: generate_daily → 断言队列 = [weak_retest(块1), review(块1), new, new]
    // 薄弱点重考 pass ×2 → fixed;review pass → 下一档 stage=3
    // 全程断言:块 md 文件内容、_weakpoints.md 镜像、_map.md 含块1 passed 状态行、
    //   git log 有 study commit、SQLite 状态一致(块状态/复习档位/薄弱点计数)
}
```

- [x] **Step 12.2** 跑通全部:`cargo test`(含单测+集成)全绿。
- [x] **Step 12.3** `cargo clippy -- -D warnings` 清零(若 clippy 不可用,记 DEVLOG 跳过)。
- [x] **Step 12.4** DEVLOG 收尾条目(L1 完成、测试计数、真实 codex 冒烟结果、遗留)。
- [x] **Step 12.5** `git add -A && git commit -m "test(core): 块生命周期端到端集成测试 (L1-T12)" && git tag l1-core`

---

## 完成定义(DoD)

1. `cd core && cargo test` 全绿(含 T12 集成);`cargo test -- --ignored` 的真实 codex 冒烟结果已记入 DEVLOG(成败均可,记录行为)。
2. git 历史逐 Task 可追溯,`git tag l1-core` 存在。
3. TECH_DESIGN.md 已回写实现期偏差(至少 ref_id 一条),DEVLOG 完整。
4. 遗留边界清晰:crate 未覆盖 EPUB/前端/Tauri/whisper/导出,留待后续计划。
