# M1 Core Engine(Linux 可实现)Implementation Plan — Plan A

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `book_learner_core` 中实现产品 M1 学习闭环的全部平台无关引擎——schema v4、AI 幂等编排、两阶段地图生成(可断点续跑)、稳定 id + 修订号的地图确认、服务端权威的持久化会话/回合、原子判定流转、投影 outbox 与重放——使 Mac 阶段只需把这些用例接到 Tauri command。

**Architecture:** 依据基线文档 §3"不可协商决策"并以 4 份 ADR 正式落档:①SQLite 是唯一事务事实源,Markdown/git 是 `projection_outbox` 驱动的可重放投影;②每个外部/非幂等操作携带客户端 request/turn ID,`ai_request`/`session_turn`/`projection_outbox` 以 ID 唯一,同 ID 重放返回既有结果、并发以 `expected_version` 冲突;③知识块锚点为有序多段(`block_anchor`,精度 exact|chapter_fallback),地图编辑为带稳定 block id 与 `map_revision` 的操作集,skip 为标记不删除;④EPUB 原生传输 **延后至 Mac**(core 只消费"已抽取的 spine 文本")。AI 外部调用期间**不持有数据库事务**。

**Tech Stack:** Rust stable、rusqlite 0.31(bundled)、serde/serde_json、chrono、tempfile、libc;测试用 fake codex 脚本 + `MockProvider`。

**Spec 依据:** `docs/superpowers/plans/2026-09-02-product-m1-implementation-baseline.md` §3 决策、§4 Node 1/4/5/6/8/9;`TECH_DESIGN.md` §3.3、§6.1/6.4/6.5/6.6/6.7/6.8;`PRODUCT_SPEC.md` §4 三类书模板、§5 队列与复习。**范围外**(Plan B 或 Mac):Tauri command/DTO 接线(本机无 GTK 不可编译)、web 契约 v2/Mock/前端页面(Plan B)、EPUB 抽取与 CFI 解析(Plan B,JS 侧)、原生 EPUB 传输(ADR-0004 延后)、tray/通知/whisper/导出。

**环境约束:** 工作仓库 `/bigtemp/fzv6en/book-learner/review-clone`,基于 `linux-local` 新建 `feat/m1-core-engine`;`CARGO_TARGET_DIR=/bigtemp/fzv6en/book-learner/cargo-target`;本机无推送凭证,每 Task 本地 commit,凭证到位后统一推送。

---

## 流程约定

- 每 Task:RED → GREEN → `cargo test`(全量)→ `cargo clippy --all-targets -- -D warnings` → `cargo fmt --check` → 勾选复选框 → DEVLOG → commit(`feat(core): … (A-Tn)`)。
- 新 schema 一律**追加式**(新表/`ALTER TABLE ADD COLUMN`),不重建旧表;每条 v3→v4 迁移用例须验证旧行保留。
- 所有 AI 调用经 `orchestrate::run_ai_request` / `run_ai_json`,禁止业务模块直接调 `AiProvider::complete`。
- 所有"读后写"事务 `BEGIN IMMEDIATE`(既定并发策略);**AI 调用前必须结束事务**,调用后重新开事务落库。

## 文件结构

```
docs/adr/
├─ 0001-sqlite-source-of-truth-and-projection-outbox.md
├─ 0002-idempotent-ai-operations-and-session-turns.md
├─ 0003-multi-segment-anchors-and-map-revision.md
└─ 0004-epub-native-transport.md          ← 状态:Deferred(Mac)
core/src/
├─ db.rs           ← SCHEMA_V4(追加表/列/索引)
├─ ai.rs           ← 限额(prompt/output 字节)、配置校验、test_connection
├─ orchestrate.rs  ← 新:幂等 AI 请求 + 传输重试 + JSON 纠错一次
├─ prompts.rs      ← 新增 6.1A/6.1B/6.4/6.5/6.6/6.8 构造器
├─ eval.rs         ← 新增 ChapterCandidate/DraftMap/ApplicationResult/MethodologyFragment/DiscussionNote/FinalReport 严格解析
├─ mapgen.rs       ← 新:两阶段地图作业(map_job 断点)+ 草图校验
├─ map.rs          ← 新:apply_draft_map / confirm_map(稳定 id + 修订号 + 操作集)
├─ session.rs      ← 新:start_or_resume_session / submit_turn / abandon_session
├─ verdict.rs      ← 新:request_evaluation / confirm_session_verdict(原子)
├─ projection.rs   ← 新:outbox 入队与重放(md + git)
└─ lib.rs          ← 注册模块
core/tests/m1_engine.rs ← 端到端(MockProvider):导入 spine→地图→确认→计划→队列→会话→评估→判定→投影重放→重启幂等→次日重考
```

---

### Task A0: 分支、ADR、计划入库

**Files:** Create `docs/adr/0001…0004.md`;Modify `DEVLOG.md`

- [ ] **Step A0.1** `git checkout -b feat/m1-core-engine linux-local`
- [ ] **Step A0.2** 写四份 ADR(格式:Status / Context / Decision / Consequences / Tests that enforce it)。ADR-0004 Status=Deferred,写明待 Mac 决策的两个选项(路径能力 vs 有界二进制通道)与 core 侧不变的接口(`spine_item` 表 + `mapgen` 只消费文本)。
- [ ] **Step A0.3** DEVLOG:Plan A 启动、范围、基线数字(core 53+27+1,web 186/2)。
- [ ] **Step A0.4** commit `docs: M1 core engine 计划与 ADR 0001–0004 (A-T0)`

### Task A1: schema v4

**Files:** Modify `core/src/db.rs`

- [ ] **Step A1.1 失败测试**(db tests 模块):
  1. `open_creates_schema_v4`:user_version=4;新表 `spine_item` `block_anchor` `map_job` `ai_request` `session_turn` `projection_outbox` 存在;`feynman_session` 新列 `task_id` `state` `version` `client_request_id` 存在(`pragma_table_info`);`book` 新列 `map_revision` `import_state`。
  2. `v3_rows_survive_v4`:用 `legacy_v1`+V2+V3 手工建 v3 库(执行 SCHEMA_V1/CONVERGE_V2/SCHEMA_V2/SCHEMA_V3,version=3),插 book/block/feynman_session 一行 → open → 行保留,`feynman_session.state='open'`、`version=0`。
  3. `v4_indexes_enforce_idempotency_keys`:`ai_request` 同 request_id 二次插入 UNIQUE;`session_turn(session_id,client_turn_id)` 重复 UNIQUE;`feynman_session` 同 task 两条 state='open' UNIQUE;`block_anchor(block_id,seq)` UNIQUE;`spine_item(book_id,idx)` UNIQUE。
  4. `v4_child_tables_enforce_foreign_keys`:五张新表引用不存在的父 id → FOREIGNKEY。
- [ ] **Step A1.2** RED → **Step A1.3 实现**(`SCHEMA_V4`,`migrate` 增 `if v < 4`):

```sql
ALTER TABLE book ADD COLUMN map_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE book ADD COLUMN import_state TEXT NOT NULL DEFAULT 'ready';
CREATE TABLE spine_item(
  id INTEGER PRIMARY KEY, book_id INTEGER NOT NULL REFERENCES book(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL, href TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', text TEXT NOT NULL,
  UNIQUE(book_id, idx), UNIQUE(book_id, href));
CREATE TABLE block_anchor(
  id INTEGER PRIMARY KEY, block_id INTEGER NOT NULL REFERENCES knowledge_block(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL, spine_href TEXT NOT NULL,
  cfi_start TEXT NOT NULL DEFAULT '', cfi_end TEXT NOT NULL DEFAULT '',
  precision TEXT NOT NULL CHECK(precision IN ('exact','chapter_fallback')),
  UNIQUE(block_id, seq));
CREATE TABLE map_job(
  id INTEGER PRIMARY KEY, book_id INTEGER NOT NULL REFERENCES book(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL UNIQUE,
  stage TEXT NOT NULL CHECK(stage IN ('chapters','merge','done','failed')),
  next_chapter INTEGER NOT NULL DEFAULT 0, candidates_json TEXT NOT NULL DEFAULT '[]',
  draft_json TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE ai_request(
  request_id TEXT PRIMARY KEY, kind TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','done','failed')),
  attempts INTEGER NOT NULL DEFAULT 0, result TEXT, error TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
ALTER TABLE feynman_session ADD COLUMN task_id INTEGER REFERENCES daily_task(id) ON DELETE SET NULL;
ALTER TABLE feynman_session ADD COLUMN state TEXT NOT NULL DEFAULT 'open';
ALTER TABLE feynman_session ADD COLUMN version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE feynman_session ADD COLUMN client_request_id TEXT;
CREATE UNIQUE INDEX feynman_session_request ON feynman_session(client_request_id) WHERE client_request_id IS NOT NULL;
CREATE UNIQUE INDEX feynman_session_open_per_task ON feynman_session(task_id) WHERE task_id IS NOT NULL AND state IN ('open','evaluating','evaluated');
CREATE TABLE session_turn(
  id INTEGER PRIMARY KEY, session_id INTEGER NOT NULL REFERENCES feynman_session(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL, role TEXT NOT NULL CHECK(role IN ('user','student')), text TEXT NOT NULL,
  client_turn_id TEXT, status TEXT NOT NULL DEFAULT 'done' CHECK(status IN ('pending','done','failed')),
  created_at TEXT NOT NULL, UNIQUE(session_id, seq));
CREATE UNIQUE INDEX session_turn_client ON session_turn(session_id, client_turn_id) WHERE client_turn_id IS NOT NULL;
CREATE TABLE projection_outbox(
  id INTEGER PRIMARY KEY, op_id TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','done','failed')),
  attempts INTEGER NOT NULL DEFAULT 0, error TEXT, created_at TEXT NOT NULL, done_at TEXT);
```
  `state`/`import_state` 的取值在代码层校验(`ALTER TABLE ADD COLUMN` 不加 CHECK,避免旧行兼容问题)。`feynman_session.transcript_json` 保留但不再作为事实源(权威 transcript = `session_turn`)。
- [ ] **Step A1.4** GREEN(含既有 v1→v3 用例)→ **Step A1.5** commit `feat(core): schema v4——spine/锚点/地图作业/AI 幂等/会话回合/投影 outbox (A-T1)`

### Task A2: `ai.rs` 限额、配置校验、test_connection

**Files:** Modify `core/src/ai.rs`

- [ ] **Step A2.1 失败测试**:
  1. `rejects_oversized_prompt_before_spawn`:system 为 600 KiB 字符串 → `Err(InvalidInput)`,fake codex 未被调用(脚本写 marker 文件,断言不存在);
  2. `rejects_oversized_output`:脚本向输出文件写 2 MiB → `Err(Ai("output exceeds …"))`;
  3. `validate_reports_missing_binary_and_workdir`:`CodexCliProvider::validate(&workdir)`:bin 不存在 → InvalidInput 含 "binary";workdir 不存在 → InvalidInput 含 "workdir";
  4. `test_connection_reports_version_and_latency`:fake 脚本对 `--version` 输出 `codex-cli 9.9.9` → `ConnectionReport { version: "codex-cli 9.9.9", latency_ms: >=0 }`。
- [ ] **Step A2.2** RED → **Step A2.3 实现**:常量 `MAX_PROMPT_BYTES = 512 * 1024`、`MAX_OUTPUT_BYTES = 1024 * 1024`(`complete` 内校验;输出用 `File::metadata().len()` 先判后读);`pub fn validate(&self, workdir: &Path) -> Result<()>`;`pub fn test_connection(&self) -> Result<ConnectionReport>`(`bin --version`,10s 超时,同样进程组处理)。
- [ ] **Step A2.4** GREEN → **Step A2.5** commit `feat(core): Codex provider 限额、配置校验与连接测试 (A-T2)`

### Task A3: `orchestrate.rs` — 幂等 AI 请求与重试

**Files:** Create `core/src/orchestrate.rs`;Modify `lib.rs`

接口(完整):

```rust
pub struct AiPolicy { pub max_transport_retries: u32 /*2*/, pub json_corrective_retries: u32 /*1*/ }
impl Default for AiPolicy { … }

pub enum RequestOutcome { Fresh(String), Replayed(String) }

/// 幂等文本请求:同 request_id 已 done → Replayed(存储结果),不调 provider;
/// pending/failed → 继续尝试(attempts 累加);传输类错误(CoreError::Ai)按策略重试;
/// InvalidInput/Conflict 不重试。调用期间不持有事务(每次状态更新单独短事务)。
pub fn run_ai_request(conn: &Connection, provider: &dyn AiProvider, request_id: &str, kind: &str,
                      req: &CompletionRequest, policy: &AiPolicy) -> Result<RequestOutcome>;

/// JSON 请求:在 run_ai_request 之上,parse 失败时**恰一次**纠错重试——把纠错提示追加到 system
/// (“上一次输出不是合法 JSON:<错误摘要>。请只输出 JSON。”),仍失败 → Err(EvalParse),ai_request 记 failed。
pub fn run_ai_json<T>(conn, provider, request_id, kind, req, policy, parse: fn(&str) -> Result<T>) -> Result<T>;

pub fn validate_request_id(id: &str) -> Result<()>  // 非空、≤128、可打印 ASCII/连字符
```

- [ ] **Step A3.1 失败测试**(`CountingProvider`:预设应答序列 `Vec<Result<String>>`,记录调用次数):
  1. `transport_failures_retry_with_same_id`:序列 [Err(Ai timeout), Err(Ai exit 1), Ok("x")] → Ok(Fresh("x")),provider 调用 3 次,`ai_request.attempts=3,status='done'`;
  2. `exhausted_retries_mark_failed`:三次 Err(Ai) → Err,`status='failed'`,`error` 非空;
  3. `same_id_replays_without_calling_provider`:先成功,再用同 id 调用 → Replayed,provider 调用计数不变;
  4. `invalid_input_not_retried`:Err(InvalidInput) → 立即 Err,调用 1 次;
  5. `json_corrective_retry_exactly_once`:序列 [Ok("not json"), Ok(合法 JSON)] → 解析成功,调用 2 次,第二次 system 含 "请只输出 JSON";
  6. `json_second_failure_gives_up`:[Ok("bad"), Ok("bad")] → Err(EvalParse),调用 2 次,`status='failed'`;
  7. `failed_request_can_be_resumed_by_same_id`:先耗尽失败,再同 id 调用且 provider 成功 → Fresh,attempts 累加。
- [ ] **Step A3.2** RED → **Step A3.3 实现** → **Step A3.4** GREEN → **Step A3.5** commit `feat(core): 幂等 AI 请求编排——同 ID 重放、传输重试、JSON 纠错一次 (A-T3)`

### Task A4: prompts 6.1A/6.1B/6.4/6.5/6.6/6.8 + 严格 schema

**Files:** Modify `core/src/prompts.rs`, `core/src/eval.rs`

- [ ] **Step A4.1 失败测试**:
  - prompts:`map_stage_a_prompt(ty, chapter_title, chapter_text)` 含 "知识点候选"、"JSON 数组"、章标题;`map_stage_b_prompt(ty, candidates_json)` 三类书各含其组织原则关键词(教材 "前置依赖" / 方法论 "观点—框架—案例" / 人文 "叙事脉络")并含 "15–45 分钟";`application_prompt(ctx)` 含 "现实情境"、"禁止书内例题";`methodology_prompt(ctx)` 含 "我的版本"、"markdown";`humanities_discussion_prompt(ctx)` 含 "对立视角"、"不评判立场";`final_exam_prompt(map_summary)` 含 "全书框架"、"学习报告"。全部末尾要求"最后一条消息只输出 JSON"(除 6.5 输出 markdown 片段的 JSON 包裹)。
  - eval 解析(全部 `deny_unknown_fields`,提取规则同 parse_eval):`parse_chapter_candidates` → `Vec<ChapterCandidate{title, summary, prereq_titles: Vec<String>, source_section}>`;`parse_draft_map` → `DraftMap{modules: Vec<DraftModule{name, blocks: Vec<DraftBlock{title, summary, source_sections: Vec<String>, prereqs: Vec<String>}>}>}`;`parse_application_result` → `{passed: bool, comment}`;`parse_methodology_fragment` → `{markdown, source_block}`;`parse_discussion_note` → `{markdown, used_facts: bool}`;`parse_final_report` → `{overall: u8(1-5), strongest_module, weakest_module, report_markdown}`。各含 1 条合法 + 1 条非法(未知字段/越界)用例。
- [ ] **Step A4.2** RED → **Step A4.3 实现** → **Step A4.4** GREEN → **Step A4.5** commit `feat(core): 地图生成/迁移应用/情境化/讨论/终评 prompt 与严格解析 (A-T4)`

### Task A5: `mapgen.rs` — 两阶段地图作业(断点续跑)

**Files:** Create `core/src/mapgen.rs`

接口:

```rust
pub struct SpineChapter { pub idx: i64, pub href: String, pub title: String, pub text: String }
pub enum MapProgress { Chapter { index: usize, total: usize, title: String }, Merging, Done { blocks: usize } }

/// 把已抽取的 spine 写入 spine_item(替换该书旧缓存),import_state='extracted'
pub fn store_spine(conn, book_id, chapters: &[SpineChapter]) -> Result<()>;

/// 运行/续跑地图作业:job_id 幂等。stage 'chapters' 从 next_chapter 起逐章 Stage A(每章一个 ai_request:
/// `{job_id}:ch{idx}`),每章成功后短事务更新 next_chapter/candidates_json;stage 'merge' 一次 Stage B
/// (`{job_id}:merge`);校验通过 → draft_json 落库、stage='done'、import_state='mapped';失败 → stage='failed'+error。
/// AI 调用期间不持事务。返回 DraftMap。
pub fn run_map_job(conn, provider, book_id, job_id, policy, on_progress: &mut dyn FnMut(MapProgress)) -> Result<DraftMap>;

pub fn validate_draft(draft: &DraftMap, chapters: &[SpineChapter]) -> Result<()>
// 规则:块数 1..=200;标题非空且全书唯一;prereqs 引用的标题存在且无环(DFS);source_sections 非空且
// 每项能匹配某章 href 或章标题(否则 InvalidInput 列出未匹配项);每模块 ≥1 块。
```

- [ ] **Step A5.1 失败测试**(MockProvider 按 request_id 后缀返回 Stage A/B 固定 JSON):
  1. `three_chapters_run_a_thrice_then_b_once`:调用顺序 ch0,ch1,ch2,merge;progress 事件 3 次 Chapter + Merging + Done;`map_job.stage='done'`,`book.import_state='mapped'`;
  2. `resume_after_crash_skips_finished_chapters`:先跑到 ch1 后让 provider 返回 Err(Ai) 三次 → job failed,next_chapter=2(0、1 已存);再次 `run_map_job` 同 job_id → 只调 ch2 与 merge(ai_request 同 ID 重放使 ch0/ch1 不再调 provider);
  3. `invalid_draft_rejected`:Stage B 返回有环/重复标题/未知 source_section 三种 → `Err(InvalidInput)` 且 stage='failed',error 含原因;
  4. `store_spine_replaces_old_cache`:两次 store_spine → 行数等于第二次章节数,`import_state='extracted'`。
- [ ] **Step A5.2** RED → **Step A5.3 实现** → **Step A5.4** GREEN → **Step A5.5** commit `feat(core): 两阶段知识地图作业,断点续跑与草图校验 (A-T5)`

### Task A6: `map.rs` — 草图落库与带修订号的地图确认

**Files:** Create `core/src/map.rs`

接口:

```rust
/// 首次确认:按 DraftMap 创建 knowledge_block(seq 顺序、module_name、prereq_ids 由标题解析)与
/// block_anchor(每个 source_section 一段:匹配到 spine href 则 precision='chapter_fallback'、cfi 空——
/// 精确 CFI 由 Plan B/Mac 通过 set_anchor_segments 回填);book.map_revision=1,import_state='ready'。
pub fn apply_draft_map(conn, book_id, draft: &DraftMap) -> Result<u64 /*revision*/>;

pub enum MapEditOp {
    Rename { block_id: i64, title: String },
    RenameModule { from: String, to: String },
    Reorder { block_ids: Vec<i64> },           // 完整新顺序
    SetSkipped { block_id: i64, skipped: bool },
    Merge { into: i64, from: Vec<i64> },       // from 标记 skipped,锚点段追加到 into 尾部
    Split { block_id: i64 },                   // → Err(InvalidInput("split needs anchor segments from reader"))
}
/// 乐观并发:expected_revision != book.map_revision → Conflict;成功 revision+1;不触碰 status/scores/passed_at
pub fn confirm_map(conn, book_id, expected_revision: u64, ops: &[MapEditOp]) -> Result<u64>;
pub fn set_anchor_segments(conn, block_id, segments: &[AnchorSegment]) -> Result<()>;  // Plan B 回填精确 CFI
pub fn list_anchors(conn, block_id) -> Result<Vec<AnchorSegment>>;
```

- [ ] **Step A6.1 失败测试**:apply 创建块/前置/fallback 锚点;stale revision → Conflict 且无变更;Reorder+SetSkipped 后 seq/skipped 正确且已通过块的 scores/passed_at 原样;Merge 追加锚点段、来源块 skipped=1;Split → InvalidInput;set_anchor_segments 覆盖为 exact 段。
- [ ] **Step A6.2** RED → **Step A6.3 实现** → **Step A6.4** GREEN → **Step A6.5** commit `feat(core): 地图草图落库与稳定 id/修订号的地图确认 (A-T6)`

### Task A7: `session.rs` — 持久化会话与回合

**Files:** Create `core/src/session.rs`

接口:

```rust
pub struct SessionView { pub session_id: i64, pub version: i64, pub state: String, pub block_id: i64, pub kind: String,
                         pub transcript: Vec<(String /*role*/, String /*text*/)> }
/// 返回该任务的唯一 open 会话(存在则 resume,不新建);client_request_id 幂等(同 id 重放返回同一会话)。
/// 任务不存在/不是今日队列 → NotFound;任务已 done → Conflict。
pub fn start_or_resume_session(conn, task_id, client_request_id, date) -> Result<SessionView>;

pub struct TurnResult { pub student_text: String, pub ready_to_end: bool, pub version: i64 }
/// ①校验 expected_version(不等 → Conflict);②同 client_turn_id 且已 done → 直接返回既有学生回复;
/// ③事务 A:写 user turn(status pending)、version+1;④**无事务**调用 run_ai_request(request_id=`turn:{session}:{client_turn_id}`);
/// ⑤事务 B:成功 → user turn done + student turn done + version+1;失败 → user turn 保持 pending 并返回 Err(可重试,
/// 同 client_turn_id 重试复用该 pending turn)。
pub fn submit_turn(conn, provider, policy, session_id, expected_version, client_turn_id, user_text, ctx: &FixedContext, ty: BookType) -> Result<TurnResult>;
pub fn abandon_session(conn, session_id, expected_version) -> Result<()>;  // state='abandoned'
```
  学生回复的 `[READY_TO_END]` 标记由 core 剥离并映射为 `ready_to_end=true`。

- [ ] **Step A7.1 失败测试**(MockProvider):双 start(不同 request id)返回同一 session;同 request id 重放返回同一;已 done 任务 → Conflict;submit 成功后 transcript 为 [user, student] 且 version=2;expected_version 错 → Conflict 且无写入;同 client_turn_id 重放 → 不调 provider、返回相同文本;provider 失败 → user turn pending、Err;同 turn id 重试成功 → 只有一条 user turn、一条 student;READY_TO_END 剥离;abandon 后 submit → Conflict。
- [ ] **Step A7.2** RED → **Step A7.3 实现** → **Step A7.4** GREEN → **Step A7.5** commit `feat(core): 持久化费曼会话与幂等回合 (A-T7)`

### Task A8: `verdict.rs` — 评估与原子判定流转

**Files:** Create `core/src/verdict.rs`

接口:

```rust
/// state open→evaluating;run_ai_json(parse_eval, request_id);成功存 eval_json,state='evaluated';同 request_id 重放返回既有评估。
pub fn request_evaluation(conn, provider, policy, session_id, request_id, ctx: &FixedContext) -> Result<EvalResult>;

pub struct VerdictOutcome { pub passed: bool, pub block_status: String, pub task_done: bool, pub outbox_ops: usize }
/// 单一原子事务(IMMEDIATE):校验 state='evaluated' 与 expected_version;同 request_id 已确认 → 返回既有 outcome;
/// pass → apply_eval_to_db(含 on_block_passed);relearn → block 'learning';按任务 kind 流转:
///   new → 上面已处理;weak_retest → on_weak_retest(ref_id, pass);review → on_review_result(ref_id, pass);
/// daily_task 置 done(pass 且 kind=new 时;weak_retest/review 无论 pass 否都置 done——重考/复习完成了这次尝试);
/// session state='confirmed'、version+1;入队 outbox:block_eval / sync_weakpoints / sync_map / git_commit(op_id 派生自 request_id)。
pub fn confirm_session_verdict(conn, session_id, expected_version, request_id, pass: bool, date) -> Result<VerdictOutcome>;
```

- [ ] **Step A8.1 失败测试**:evaluation 幂等;非 evaluated 状态 confirm → Conflict;pass 流转(块 passed、stage1 复习、weak_point 入库、task done、outbox 4 行);relearn 流转(块 learning、task 仍 pending、无复习);weak_retest 任务 pass → on_weak_retest streak+1、task done;review 任务 fail → 重置 1 天档 + 新薄弱点、task done;同 request_id 双 confirm → 同 outcome、无重复复习行/outbox 行;不同 request_id 二次 confirm → Conflict。
- [ ] **Step A8.2** RED → **Step A8.3 实现** → **Step A8.4** GREEN → **Step A8.5** commit `feat(core): 评估请求与原子判定流转 (A-T8)`

### Task A9: `projection.rs` — 投影 outbox 重放

**Files:** Create `core/src/projection.rs`

接口:

```rust
pub fn enqueue(tx: &Connection, op_id: &str, kind: &str, payload: &serde_json::Value) -> Result<()>;  // 在调用方事务内
/// 按 id 顺序处理 pending:kind ∈ block_eval{book_slug,seq,title,block_slug,eval,date} | sync_weakpoints{book_id}
/// | sync_map{book_id} | git_commit{message};每条成功 → done;失败 → failed+error 并**停止**(保持顺序);返回处理条数。
pub fn run_pending(conn, memory: &MemoryStore) -> Result<usize>;
```

- [ ] **Step A9.1 失败测试**:confirm 后 run_pending → 块 md 存在且含终稿、_weakpoints.md 含待考、_map.md 状态行、git log 含 message;再次 run_pending → 0 条(幂等);模拟 git 失败(把 memory root 的 .git 目录权限置 0o000,root 跳过)→ 前三条 done、git 条 failed、error 非空;恢复权限后 run_pending → 恰一条被处理且 git log 只多一条提交。
- [ ] **Step A9.2** RED → **Step A9.3 实现** → **Step A9.4** GREEN → **Step A9.5** commit `feat(core): 投影 outbox 重放——md 与 git 成为可重放投影 (A-T9)`

### Task A10: 端到端集成、文档回写、收尾

**Files:** Create `core/tests/m1_engine.rs`;Modify `TECH_DESIGN.md`(§3.3 投影/§4 v4/§5 编排/§6 已实现标注)、`IMPLEMENTATION_PLAN.md`、基线文档 Node 1/4/5/6/8/9 状态、`DEVLOG.md`

- [ ] **Step A10.1** 集成测试(MockProvider 按 request_id 后缀分发固定 JSON):建书 → store_spine(3 章) → run_map_job → apply_draft_map → set_plan → generate_daily(Day0,new 任务) → start_or_resume_session → submit_turn ×2(第二次 READY_TO_END) → request_evaluation → confirm_session_verdict(pass) → run_pending(md + git) → **重开连接**再 run_pending = 0、再 confirm 同 request_id = 同 outcome → generate_daily(Day1)队首为 weak_retest 且 review 到期。
- [ ] **Step A10.2** 全量:`cargo test`、clippy `-D warnings`、`cargo fmt --check`;记录用例数。
- [ ] **Step A10.3** 回写文档 + DEVLOG(每 Task 数字、与基线偏差、Mac 阶段需接线的 command 清单——按 Plan B 契约 v2 命名)。
- [ ] **Step A10.4** commit `docs: M1 core engine 收尾与回写 (A-T10)`;凭证到位后随 linux-local 一并推送。

## 完成定义(DoD)

1. v4 迁移追加式且保留 v3 全部行;六张新表外键/唯一索引生效。
2. 任一 AI 调用经 orchestrate:同 ID 不重复付费、传输错误最多重试 2 次、坏 JSON 恰纠错 1 次;AI 调用期间无事务持有(集成测试用第二连接在 provider 回调中执行写入验证不阻塞)。
3. 地图作业可从任意章节断点续跑;草图校验拒绝环/重复/未知来源。
4. 会话:一任务一 open 会话;回合幂等;失败保留用户回合;版本冲突可检测。
5. 判定:单事务完成会话/块/薄弱点/复习/任务/outbox;双确认幂等;outbox 重放后 md 与 git 与 SQLite 一致,重启重放幂等。
6. clippy/fmt/全量测试绿;每 Task 一 commit;DEVLOG 与 SPEC 回写完成。
