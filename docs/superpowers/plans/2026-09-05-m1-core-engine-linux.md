# M1 Core Engine(Linux 可实现)Implementation Plan — Plan A

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `book_learner_core` 中实现产品 M1 学习闭环的全部平台无关引擎——schema v4、AI 幂等编排、两阶段地图生成(可断点续跑)、稳定 id + 修订号的地图确认、服务端权威的持久化会话/回合、原子判定流转、投影 outbox 与重放——使 Mac 阶段只需把这些用例接到 Tauri command。

**Architecture:** 依据基线文档 §3"不可协商决策"并以 4 份 ADR 正式落档:①SQLite 是唯一事务事实源,Markdown/git 是 `projection_outbox` 驱动的可重放投影;②每个外部/非幂等操作携带客户端 request/turn ID,`ai_request`/`session_turn`/`projection_outbox`/会话确认以 ID 唯一,同 ID 重放返回既有结果、并发以 `expected_version` 冲突;③知识块锚点为有序多段(`block_anchor`,精度 exact|chapter_fallback,可携带段文本),地图编辑为带稳定 block id 与 `map_revision` 的操作集,skip 为标记不删除;④EPUB 原生传输 **延后至 Mac**(core 只消费"已抽取的 spine 文本")。AI 外部调用期间**不持有数据库事务**(`run_ai_request` 入口检查 `conn.is_autocommit()`)。

**Tech Stack:** Rust stable、rusqlite 0.31(bundled)、serde/serde_json、chrono、tempfile、libc;测试用 fake codex 脚本 + `MockProvider`(按 `CompletionRequest.request_id` 分发固定应答)。

**Spec 依据:** `docs/superpowers/plans/2026-09-02-product-m1-implementation-baseline.md` §3 决策、§4 Node 1/4/5/6/8/9;`TECH_DESIGN.md` §3.3、§6.1/6.4/6.5/6.6/6.7/6.8、§7.2/7.3;`PRODUCT_SPEC.md` §4 三类书模板、§5 队列与复习。**范围外**(Plan B 或 Mac):Tauri command/DTO 接线(本机无 GTK 不可编译)、web 契约 v2/Mock/前端页面(Plan B)、EPUB 抽取与 CFI 解析(Plan B,JS 侧)、原生 EPUB 传输(ADR-0004 延后)、tray/通知/whisper/导出。

**环境约束:** 工作仓库 `/bigtemp/fzv6en/book-learner/review-clone`,基于 `linux-local` 新建 `feat/m1-core-engine`;`CARGO_TARGET_DIR=/bigtemp/fzv6en/book-learner/cargo-target`;本机无推送凭证,每 Task 本地 commit,凭证到位后统一推送。

**评审修订记录(2026-09-05,独立评审 10 条 Issue + 9 条建议,全部并入):** I1 `apply_eval_in_tx` 抽出(A8 加 sched.rs);I2 用户 pass 覆盖 AI verdict;I3 weak_retest/review 不改块状态/不写 eval 薄弱点;I4 `run_ai_request` 增 `accept` 校验、只有通过才记 done;I5 `MAX_PROMPT_BYTES=100 KiB` + 上限用例 + Stage A 分片;I6 `CompletionRequest.request_id`;I7 回合重试协议(先查 turn id、事务 A 不 bump 版本);I8 `verdict_request_id`/`verdict_json`;I9 outbox `init_book` + `block_eval` 防御性 `ensure_book`;I10 slugify 规则。建议:request_id 命名空间;`run_pending` 重试 failed 行;块文件名 `{block_id:04}-{slug}.md`;评估失败回 `open`;`is_autocommit` 检查;`spine_item` 去 href 唯一;prompt-only 标注。**建议中一处有意偏离**:relearn 后块状态保持 `learning`(不改回 `unlearned`,保留 UI 语义),改为让 `next_new_blocks` 同时选 `unlearned` 与 `learning`(按 seq),同样解决"块永不再入队"问题,并加用例锁定。

**第二轮评审(5 条 Issue + 8 条建议,全部并入):** R1 用户判定必须传到 md 投影(`memory::apply_eval` 增显式 `passed`,outbox `block_eval` 载荷带 `passed`);R2 Stage B 经 `run_ai_json` 且 accept = parse + `validate_draft`(语义无效草图不记 done,重试再调 provider);R3 `source_section` 固定格式 `"{href}#{小节标题}"`,校验只匹配 href 部分,`block_anchor` 增 `hint` 列保存小节标题供 Plan B 解析 CFI;R4 `TurnView` 暴露 `client_turn_id`,重启后可续跑 pending 回合;R5 `block_eval` 投影以 op_id 标记评估历史行,跨崩溃重放不重复。建议:A1 外键用例措辞;`CompletionRequest: Clone`、可重试错误 = `Ai | Io`;Stage B 候选压缩;lifecycle.rs 文件名;`next_new_blocks` 纯按 seq、`check_behind` 计 learning;学生回复原文存库、输出时剥离;abandon 与 pending 回合;`evaluating` 态恢复;Merge 锚点为**复制**。

---

## 流程约定

- 每 Task:RED → GREEN → `cargo test`(全量)→ `cargo clippy --all-targets -- -D warnings` → `cargo fmt --check` → 勾选复选框 → DEVLOG → commit(`feat(core): … (A-Tn)`)。
- 新 schema 一律**追加式**(新表/`ALTER TABLE ADD COLUMN`),不重建旧表;每条 v3→v4 迁移用例须验证旧行保留。
- 所有 AI 调用经 `orchestrate::run_ai_request` / `run_ai_json`,禁止业务模块直接调 `AiProvider::complete`。
- 所有"读后写"事务 `BEGIN IMMEDIATE`(既定并发策略);**AI 调用前必须结束事务**,调用后重新开事务落库;`run_ai_request` 在非 autocommit 连接上直接返回 `Err(Other("run_ai_request inside transaction"))`。
- **request_id 命名空间**(全部经 `validate_request_id`,≤128;客户端提供的 id 经 `validate_client_id`,≤64 且仅 `[A-Za-z0-9._-]`):`map:{job_id}:ch{idx}`、`map:{job_id}:ch{idx}:p{k}`(分片)、`map:{job_id}:merge`、`turn:{session_id}:{client_turn_id}`、`eval:{session_id}:{request_id}`;outbox `op_id` = `verdict:{session_id}:{request_id}:{kind}` / `map:{book_id}:r{revision}:{kind}`。

## 文件结构

```
docs/adr/
├─ 0001-sqlite-source-of-truth-and-projection-outbox.md
├─ 0002-idempotent-ai-operations-and-session-turns.md
├─ 0003-multi-segment-anchors-and-map-revision.md   ← 含块文件命名 {block_id:04}-{slug}.md
└─ 0004-epub-native-transport.md          ← 状态:Deferred(Mac)
core/src/
├─ db.rs           ← SCHEMA_V4(追加表/列/索引)
├─ ai.rs           ← CompletionRequest.request_id、限额(prompt/output 字节)、配置校验、test_connection
├─ orchestrate.rs  ← 新:幂等 AI 请求(accept 校验)+ 传输重试 + JSON 纠错一次 + id 校验
├─ prompts.rs      ← 新增 6.1A/6.1B/6.4/6.5/6.6/6.8 构造器(6.4–6.8 为 prompt only)
├─ eval.rs         ← 新增 ChapterCandidate/DraftMap/ApplicationResult/MethodologyFragment/DiscussionNote/FinalReport 严格解析
├─ mapgen.rs       ← 新:两阶段地图作业(map_job 断点、长章分片)+ 草图校验
├─ map.rs          ← 新:slugify / apply_draft_map / confirm_map(稳定 id + 修订号 + 操作集)/ 锚点段
├─ session.rs      ← 新:start_or_resume_session / submit_turn / abandon_session / fixed_context_for_block
├─ verdict.rs      ← 新:request_evaluation / confirm_session_verdict(原子)
├─ sched.rs        ← apply_eval_in_tx 抽出(verdict 显式参数);next_new_blocks 含 learning(models.rs)
├─ memory.rs       ← apply_eval 的 seq 参数改为 block_id,文件名 {block_id:04}-{slug}.md,frontmatter block_id:;显式 passed;历史行带 entry_key 幂等
├─ models.rs       ← next_new_blocks 含 learning(纯按 seq);sched::check_behind 剩余块计 learning
├─ projection.rs   ← 新:outbox 入队与重放(init_book / block_eval / sync_weakpoints / sync_map / git_commit)
└─ lib.rs          ← 注册模块
core/tests/m1_engine.rs ← 端到端(MockProvider):导入 spine→地图→确认→计划→队列→会话→评估→判定→投影重放→重启幂等→次日重考
```

---

### Task A0: 分支、ADR、计划入库

**Files:** Create `docs/adr/0001…0004.md`;Modify `DEVLOG.md`

- [x] **Step A0.1** `git checkout -b feat/m1-core-engine linux-local`
- [x] **Step A0.2** 写四份 ADR(格式:Status / Context / Decision / Consequences / Tests that enforce it)。ADR-0001 写明 outbox 顺序处理、失败即停、failed 行按 id 顺序重试;ADR-0002 写明 request_id 命名空间、`accept` 才记 done、回合重试协议(事务 A 不 bump 版本)、用户 pass 覆盖 AI verdict;ADR-0003 写明锚点段可携带 `text`、块文件改名 `{block_id:04}-{slug}.md`(Reorder 改 seq 不再孤立历史)、slugify 规则;ADR-0004 Status=Deferred,写明待 Mac 决策的两个选项(路径能力 vs 有界二进制通道)与 core 侧不变的接口(`spine_item` 表 + `mapgen` 只消费文本),并记录 prompt 经 argv 传入的 100 KiB 上限(将来可改 stdin)。
- [x] **Step A0.3** DEVLOG:Plan A 评审通过与修订摘要、启动、范围、基线数字(core 53+27+1,web 186/2)。
- [x] **Step A0.4** commit `docs: M1 core engine 计划与 ADR 0001–0004 (A-T0)`

### Task A1: schema v4

**Files:** Modify `core/src/db.rs`

- [x] **Step A1.1 失败测试**(db tests 模块):
  1. `open_creates_schema_v4`:user_version=4;新表 `spine_item` `block_anchor` `map_job` `ai_request` `session_turn` `projection_outbox` 存在;`feynman_session` 新列 `task_id` `state` `version` `client_request_id` `verdict_request_id` `verdict_json` 存在(`pragma_table_info`);`book` 新列 `map_revision` `import_state`;`block_anchor.text` 与 `block_anchor.hint` 存在。
  2. `v3_rows_survive_v4`:用 `legacy_v1`+V2+V3 手工建 v3 库(执行 SCHEMA_V1/CONVERGE_V2/SCHEMA_V2/SCHEMA_V3,version=3),插 book/block/feynman_session 一行 → open → 行保留,`feynman_session.state='open'`、`version=0`、`book.map_revision=0`、`import_state='ready'`。
  3. `v4_indexes_enforce_idempotency_keys`:`ai_request` 同 request_id 二次插入 UNIQUE;`session_turn(session_id,client_turn_id)` 重复 UNIQUE;`feynman_session` 同 task 两条 state='open' UNIQUE;同 `verdict_request_id` 两条 UNIQUE;`block_anchor(block_id,seq)` UNIQUE;`spine_item(book_id,idx)` UNIQUE;**`spine_item` 同 book 同 href 不同 idx 允许**。
  4. `v4_child_tables_enforce_foreign_keys`:带外键的四张新表(`spine_item` `block_anchor` `map_job` `session_turn`)引用不存在的父 id → FOREIGNKEY;`feynman_session.task_id` 引用不存在的 daily_task → FOREIGNKEY(`ai_request`/`projection_outbox` 无外键)。
- [x] **Step A1.2** RED → **Step A1.3 实现**(`SCHEMA_V4`,`migrate` 增 `if v < 4`):

```sql
ALTER TABLE book ADD COLUMN map_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE book ADD COLUMN import_state TEXT NOT NULL DEFAULT 'ready';
CREATE TABLE spine_item(
  id INTEGER PRIMARY KEY, book_id INTEGER NOT NULL REFERENCES book(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL, href TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', text TEXT NOT NULL,
  UNIQUE(book_id, idx));
CREATE TABLE block_anchor(
  id INTEGER PRIMARY KEY, block_id INTEGER NOT NULL REFERENCES knowledge_block(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL, spine_href TEXT NOT NULL,
  cfi_start TEXT NOT NULL DEFAULT '', cfi_end TEXT NOT NULL DEFAULT '',
  precision TEXT NOT NULL CHECK(precision IN ('exact','chapter_fallback')),
  hint TEXT NOT NULL DEFAULT '', text TEXT NOT NULL DEFAULT '',
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
ALTER TABLE feynman_session ADD COLUMN verdict_request_id TEXT;
ALTER TABLE feynman_session ADD COLUMN verdict_json TEXT;
CREATE UNIQUE INDEX feynman_session_request ON feynman_session(client_request_id) WHERE client_request_id IS NOT NULL;
CREATE UNIQUE INDEX feynman_session_open_per_task ON feynman_session(task_id) WHERE task_id IS NOT NULL AND state IN ('open','evaluating','evaluated');
CREATE UNIQUE INDEX feynman_session_verdict_request ON feynman_session(verdict_request_id) WHERE verdict_request_id IS NOT NULL;
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
  `state`(open|evaluating|evaluated|confirmed|abandoned)/`import_state`(ready|extracted|mapped)的取值在代码层校验(`ALTER TABLE ADD COLUMN` 不加 CHECK,避免旧行兼容问题)。`feynman_session.transcript_json` 保留但不再作为事实源(权威 transcript = `session_turn`)。
- [x] **Step A1.4** GREEN(含既有 v1→v3 用例)→ **Step A1.5** commit `feat(core): schema v4——spine/锚点/地图作业/AI 幂等/会话回合/判定幂等/投影 outbox (A-T1)`

### Task A2: `ai.rs` request_id、限额、配置校验、test_connection

**Files:** Modify `core/src/ai.rs`、`core/tests/lifecycle.rs`(结构体字面量补 `request_id`)

- [x] **Step A2.1 失败测试**:
  1. `rejects_oversized_prompt_before_spawn`:渲染后 prompt 为 100 KiB + 1 字节 → `Err(InvalidInput)`,fake codex 未被调用(脚本写 marker 文件,断言不存在);
  2. `prompt_exactly_at_limit_spawns`:渲染后 prompt **恰为 100 KiB**(ASCII)→ fake codex 被调用并返回 Ok(证明限额低于 Linux `MAX_ARG_STRLEN` 128 KiB);
  3. `rejects_oversized_output`:脚本向输出文件写 2 MiB → `Err(Ai("output exceeds …"))`;
  4. `validate_reports_missing_binary_and_workdir`:`CodexCliProvider::validate(&workdir)`:bin 不存在 → InvalidInput 含 "binary";workdir 不存在 → InvalidInput 含 "workdir";
  5. `test_connection_reports_version_and_latency`:fake 脚本对 `--version` 输出 `codex-cli 9.9.9` → `ConnectionReport { version: "codex-cli 9.9.9", latency_ms: >=0 }`。
- [x] **Step A2.2** RED → **Step A2.3 实现**:`CompletionRequest` 增 `pub request_id: String` 并 `#[derive(Clone)]`(ai.rs 7 处测试字面量 + lifecycle.rs 1 处补字段;`CodexCliProvider` 不使用该字段,仅供编排/Mock 分发);常量 `MAX_PROMPT_BYTES = 100 * 1024`(对 `render_prompt` 结果计 UTF-8 字节)、`MAX_OUTPUT_BYTES = 1024 * 1024`(`complete` 内校验;输出用 `File::metadata().len()` 先判后读);`pub fn validate(&self, workdir: &Path) -> Result<()>`;`pub fn test_connection(&self) -> Result<ConnectionReport>`(`bin --version`,10s 超时,同样进程组处理)。
- [x] **Step A2.4** GREEN → **Step A2.5** commit `feat(core): Codex provider request_id、限额、配置校验与连接测试 (A-T2)`

### Task A3: `orchestrate.rs` — 幂等 AI 请求与重试

**Files:** Create `core/src/orchestrate.rs`;Modify `lib.rs`

接口(完整):

```rust
pub struct AiPolicy { pub max_transport_retries: u32 /*2*/, pub json_corrective_retries: u32 /*1*/ }
impl Default for AiPolicy { … }

pub enum RequestOutcome { Fresh(String), Replayed(String) }

/// 幂等文本请求。前置:conn.is_autocommit() 否则 Err(Other)。
/// 同 request_id 已 done → Replayed(存储结果),不调 provider;pending/failed → 继续尝试(attempts 累加)。
/// 每次 provider 成功后先调 accept(&text):通过 → status='done' 存 result;不通过 → status='failed'、
/// error=accept 错误、返回该错误(不重试——纠错由 run_ai_json 负责);传输类错误(CoreError::Ai | CoreError::Io)按策略重试;
/// InvalidInput/Conflict/Db/其他不重试。调用期间不持事务(每次状态更新单独短事务)。req 被 clone 并把 request_id 覆盖为 request_id。
pub fn run_ai_request(conn: &Connection, provider: &dyn AiProvider, request_id: &str, kind: &str,
                      req: &CompletionRequest, policy: &AiPolicy,
                      accept: &dyn Fn(&str) -> Result<()>) -> Result<RequestOutcome>;

/// 结构化请求:accept = parse 闭包(可含语义校验,如 Stage B 的 validate_draft)。accept 失败时**恰一次**纠错重试——
/// 把纠错提示追加到 system(“上一次输出不可用:<错误摘要>。请只输出满足要求的 JSON。”)再次 run_ai_request
/// (同 id,因状态非 done 会再调 provider);仍失败 → 返回 accept 的错误(EvalParse 或 InvalidInput),ai_request 记 failed。
/// Replayed 时对存储结果再 parse;若不通过(如 spine 重存后 validate_draft 失败)→ 该行记 failed 并按 Fresh 流程再调 provider(纠错计数照常)。
pub fn run_ai_json<T>(conn, provider, request_id, kind, req, policy, parse: &dyn Fn(&str) -> Result<T>) -> Result<T>;

pub fn validate_request_id(id: &str) -> Result<()>  // 非空、≤128、仅 [A-Za-z0-9._:-]
pub fn validate_client_id(id: &str) -> Result<()>   // 非空、≤64、仅 [A-Za-z0-9._-]
```

- [x] **Step A3.1 失败测试**(`CountingProvider`:预设应答序列 `Vec<Result<String>>`,记录调用次数与每次 system):
  1. `transport_failures_retry_with_same_id`:序列 [Err(Ai timeout), Err(Ai exit 1), Ok("x")] → Ok(Fresh("x")),provider 调用 3 次,`ai_request.attempts=3,status='done'`;
  2. `exhausted_retries_mark_failed`:三次 Err(Ai) → Err,`status='failed'`,`error` 非空;
  3. `same_id_replays_without_calling_provider`:先成功,再用同 id 调用 → Replayed,provider 调用计数不变;
  4. `invalid_input_not_retried`:Err(InvalidInput) → 立即 Err,调用 1 次;
  5. `accept_failure_marks_failed_without_done`:accept 拒绝 → Err,`status='failed'`,result 为 NULL,再次同 id 调用会再调 provider;
  6. `json_corrective_retry_exactly_once`:序列 [Ok("not json"), Ok(合法 JSON)] → 解析成功,调用 2 次,第二次 system 含 "请只输出满足要求的 JSON",最终 status='done';`semantic_reject_also_gets_one_corrective_retry`:parse 闭包对合法 JSON 返回 InvalidInput("cycle") → 第二次 system 含 "cycle";
  6b. `io_error_is_retried_db_error_is_not`:[Err(Io), Ok("x")] → 调用 2 次成功;[Err(Db)] → 调用 1 次即 Err;
  7. `json_second_failure_gives_up`:[Ok("bad"), Ok("bad")] → Err(EvalParse),调用 2 次,`status='failed'`;
  8. `failed_request_can_be_resumed_by_same_id`:先耗尽失败,再同 id 调用且 provider 成功 → Fresh,attempts 累加;
  9. `rejects_call_inside_transaction`:`conn.unchecked_transaction()` 内调用 → Err(Other),provider 未被调;
  10. `request_id_validation`:空/129 字符/含空格 → InvalidInput;client id 65 字符/含冒号 → InvalidInput。
- [x] **Step A3.2** RED → **Step A3.3 实现** → **Step A3.4** GREEN → **Step A3.5** commit `feat(core): 幂等 AI 请求编排——同 ID 重放、accept 校验、传输重试、JSON 纠错一次 (A-T3)`

### Task A4: prompts 6.1A/6.1B/6.4/6.5/6.6/6.8 + 严格 schema

**Files:** Modify `core/src/prompts.rs`, `core/src/eval.rs`

- [ ] **Step A4.1 失败测试**:
  - prompts:`map_stage_a_prompt(ty, chapter_href, chapter_title, chapter_text)` 含 "知识点候选"、"JSON 数组"、章标题,并规定每条候选的 `source_section` 必须写成 `"{chapter_href}#{原文小节标题}"`(无小节则 `"{chapter_href}"`),prompt 中出现该 href;`map_stage_b_prompt(ty, candidates_json)` 三类书各含其组织原则关键词(教材 "前置依赖" / 方法论 "观点—框架—案例" / 人文 "叙事脉络")并含 "15–45 分钟",且要求 `source_sections` 原样沿用候选的 `"{href}#{小节标题}"` 格式;`application_prompt(ctx)` 含 "现实情境"、"禁止书内例题";`methodology_prompt(ctx)` 含 "我的版本"、"markdown";`humanities_discussion_prompt(ctx)` 含 "对立视角"、"不评判立场";`final_exam_prompt(map_summary)` 含 "全书框架"、"学习报告"。全部末尾要求"最后一条消息只输出 JSON"(6.5 输出 markdown 片段的 JSON 包裹)。**6.4/6.5/6.6/6.8 本计划无消费者(prompt only),文档回写时标注。**
  - eval 解析(全部 `deny_unknown_fields` + `Serialize`,提取规则同 parse_eval):`parse_chapter_candidates` → `Vec<ChapterCandidate{title, summary, prereq_titles: Vec<String>, source_section /*"{href}#{小节标题}"*/}>`(输入为 JSON 数组:提取首个 `[`..末个 `]`);`parse_draft_map` → `DraftMap{modules: Vec<DraftModule{name, blocks: Vec<DraftBlock{title, summary, source_sections: Vec<String>, prereqs: Vec<String>}>}>}`;`parse_application_result` → `{passed: bool, comment}`;`parse_methodology_fragment` → `{markdown, source_block}`;`parse_discussion_note` → `{markdown, used_facts: bool}`;`parse_final_report` → `{overall: u8(1-5), strongest_module, weakest_module, report_markdown}`。各含 1 条合法 + 1 条非法(未知字段/越界)用例。
- [ ] **Step A4.2** RED → **Step A4.3 实现** → **Step A4.4** GREEN → **Step A4.5** commit `feat(core): 地图生成/迁移应用/情境化/讨论/终评 prompt 与严格解析 (A-T4)`

### Task A5: `mapgen.rs` — 两阶段地图作业(断点续跑、长章分片)

**Files:** Create `core/src/mapgen.rs`

接口:

```rust
pub struct SpineChapter { pub idx: i64, pub href: String, pub title: String, pub text: String }
pub enum MapProgress { Chapter { index: usize, total: usize, title: String }, Merging, Done { blocks: usize } }
pub const STAGE_A_PIECE_BYTES: usize = 60 * 1024;

/// 把已抽取的 spine 写入 spine_item(替换该书旧缓存),import_state='extracted'。单事务 IMMEDIATE。
pub fn store_spine(conn, book_id, chapters: &[SpineChapter]) -> Result<()>;
pub fn list_spine(conn, book_id) -> Result<Vec<SpineChapter>>;

/// 运行/续跑地图作业:job_id 经 validate_client_id;不存在则建 map_job(stage='chapters');stage='done' 直接返回存储草图。
/// stage 'chapters' 从 next_chapter 起逐章 Stage A:章文本 ≤60 KiB → 一个 ai_request `map:{job_id}:ch{idx}`;
/// 超过 → 按 STAGE_A_PIECE_BYTES 在字符边界(优先段落 "\n\n",其次任意 char 边界)切片,每片一个 ai_request
/// `map:{job_id}:ch{idx}:p{k}`,片内候选按顺序合并;每章成功后短事务更新 next_chapter/candidates_json。
/// stage 'merge' 一次 Stage B(`map:{job_id}:merge`),经 run_ai_json 且 parse 闭包 = parse_draft_map + validate_draft(捕获 chapters):
/// 语义无效草图**不记 done**(纠错一次,仍失败记 failed,下次同 job_id 会再调 provider);通过 → draft_json 落库、stage='done'、import_state='mapped';
/// 任一失败 → 短事务 stage='failed'+error 并返回 Err(下次同 job_id 从断点续跑;已 done 的 ai_request 重放不再调 provider)。
/// Stage B 输入若超过 MAX_PROMPT_BYTES:先 compact_candidates(去掉 summary 字段)再试;仍超 → Err(InvalidInput("book too large for single merge"))、stage failed。
/// AI 调用期间不持事务。返回 DraftMap。
pub fn run_map_job(conn, provider, book_id, job_id, policy, on_progress: &mut dyn FnMut(MapProgress)) -> Result<DraftMap>;

/// 把 "{href}#{小节标题}" 或 "{章标题}#{小节标题}" 解析为 (href, hint);无 '#' 则 hint 为空。
pub fn resolve_source_section(section: &str, chapters: &[SpineChapter]) -> Option<(String /*href*/, String /*hint*/)>;
pub fn compact_candidates(candidates: &[ChapterCandidate]) -> serde_json::Value;  // 去 summary

pub fn validate_draft(draft: &DraftMap, chapters: &[SpineChapter]) -> Result<()>
// 规则:块数 1..=200;标题非空且全书唯一;prereqs 引用的标题存在且无环(DFS);source_sections 非空且
// 每项的 href 部分(‘#’ 前)能匹配某章 href 或章标题(否则 InvalidInput 列出未匹配项);每模块 ≥1 块。
```

- [ ] **Step A5.1 失败测试**(MockProvider 按 request_id 后缀返回 Stage A/B 固定 JSON):
  1. `three_chapters_run_a_thrice_then_b_once`:调用顺序 ch0,ch1,ch2,merge;progress 事件 3 次 Chapter + Merging + Done;`map_job.stage='done'`,`book.import_state='mapped'`;再次同 job_id → 不调 provider、返回同草图;
  2. `resume_after_crash_skips_finished_chapters`:先跑到 ch1 后让 provider 返回 Err(Ai) 三次 → job failed,next_chapter=2(0、1 已存);再次 `run_map_job` 同 job_id → 只调 ch2 与 merge(ai_request 同 ID 重放使 ch0/ch1 不再调 provider);
  3. `long_chapter_is_split_into_pieces`:一章 150 KiB 中文文本 → 该章 3 个 ai_request(`:p0..p2`),每片 prompt ≤ 100 KiB,候选按片顺序合并;
  4. `invalid_draft_rejected_and_retry_calls_provider_again`:Stage B 返回有环/重复标题/未知 source_section 三种 → `Err(InvalidInput)` 且 stage='failed',error 含原因,merge 的 ai_request 为 failed(非 done);每种情况 provider 收到一次纠错重试(第二次 system 含原因);之后再次 `run_map_job` 同 job_id 且 provider 改为返回合法草图 → 成功(证明未被坏结果卡死);
  5. `store_spine_replaces_old_cache`:两次 store_spine → 行数等于第二次章节数,`import_state='extracted'`;同 href 两次出现允许;
  6. `resolve_source_section_formats`:`"ch01.xhtml#1.2 弹性"` → (ch01.xhtml, "1.2 弹性");`"第一章#1.2"`(章标题)→ (该章 href, "1.2");`"ch01.xhtml"` → hint 空;未知 → None;
  7. `oversized_merge_input_is_compacted_then_rejected`:候选总量 > 100 KiB 但去 summary 后 ≤ 100 KiB → merge 成功;去后仍超 → InvalidInput 且 stage failed、error 含 "too large"。
- [ ] **Step A5.2** RED → **Step A5.3 实现** → **Step A5.4** GREEN → **Step A5.5** commit `feat(core): 两阶段知识地图作业,断点续跑、长章分片与草图校验 (A-T5)`

### Task A6: `map.rs` — 草图落库与带修订号的地图确认

**Files:** Create `core/src/map.rs`;Modify `core/src/memory.rs`(块文件命名、显式 passed、entry_key 幂等)、`core/src/models.rs`(`next_new_blocks` 含 learning)、`core/src/sched.rs`(`check_behind` 剩余块计 learning)、`core/tests/lifecycle.rs`(`apply_eval` 新签名与 `0001-elasticity.md`)

接口:

```rust
/// slug 派生:保留 Unicode 字母数字,其余替换为 '-',折叠连续 '-'、去首尾 '-',≤40 字符;空 → `block-{seq}`;
/// 同书重复加 `-2`/`-3` 后缀。结果必过 memory::validate_slug(改为 pub(crate))。
pub fn slugify(title: &str, seq: i64, taken: &HashSet<String>) -> String;

/// 首次确认(book.map_revision 必须为 0,否则 Conflict):按 DraftMap 创建 knowledge_block(seq 顺序、module_name、
/// slug=slugify、prereq_ids 由标题解析)与 block_anchor(每个 source_section 经 resolve_source_section 得 (href, hint) 一段:
/// spine_href=href、hint=小节标题、precision='chapter_fallback'、cfi 空、text 空——精确 CFI 与段文本由 Plan B/Mac 按 hint 解析后
/// 通过 set_anchor_segments 回填);任一 source_section 无法解析(草图未经校验或 spine 已被替换)→ InvalidInput,整体回滚;
/// book.map_revision=1,import_state='ready';同一事务入队 outbox `init_book{book_id}`(op_id `map:{book_id}:r1:init_book`)。
pub fn apply_draft_map(conn, book_id, draft: &DraftMap) -> Result<u64 /*revision*/>;

pub enum MapEditOp {
    Rename { block_id: i64, title: String },
    RenameModule { from: String, to: String },
    Reorder { block_ids: Vec<i64> },           // 必须是该书全部块 id 的一个排列,否则 InvalidInput
    SetSkipped { block_id: i64, skipped: bool },
    Merge { into: i64, from: Vec<i64> },       // from 标记 skipped(保留自身锚点);from 的锚点段**复制**追加到 into 尾部;其他块 prereq 中的 from 替换为 into(去重)
    Split { block_id: i64 },                   // → Err(InvalidInput("split needs anchor segments from reader"))
}
/// 乐观并发:expected_revision != book.map_revision → Conflict 且无变更;单事务 IMMEDIATE;成功 revision+1;
/// 不触碰 status/scores/passed_at;同一事务入队 outbox `sync_map{book_id}`(op_id `map:{book_id}:r{new}:sync_map`)。
pub fn confirm_map(conn, book_id, expected_revision: u64, ops: &[MapEditOp]) -> Result<u64>;

pub struct AnchorSegment { pub spine_href: String, pub cfi_start: String, pub cfi_end: String, pub precision: String, pub hint: String, pub text: String }
pub fn set_anchor_segments(conn, block_id, segments: &[AnchorSegment]) -> Result<()>;  // 覆盖;Plan B 回填精确 CFI 与段文本
pub fn list_anchors(conn, block_id) -> Result<Vec<AnchorSegment>>;
```

- [ ] **Step A6.1 失败测试**:
  1. `slugify_rules`:"供需弹性: 价格 vs 收入" → "供需弹性-价格-vs-收入";全符号标题 → `block-3`;41+ 字符截断到 ≤40;重复 → `-2`、`-3`;结果通过 validate_slug;
  2. `apply_creates_blocks_prereqs_and_fallback_anchors`:块/前置 id/模块/seq 正确;每块锚点 precision='chapter_fallback' 且 hint 为小节标题、spine_href 为解析出的 href;map_revision=1;outbox 有一行 `init_book`;二次 apply → Conflict;
  3. `stale_revision_conflicts_without_change`;
  4. `reorder_and_skip_keep_scores`:Reorder+SetSkipped 后 seq/skipped 正确,已通过块的 status/scores/passed_at 原样;revision=2;outbox 有 `sync_map`;
  5. `merge_copies_anchors_and_remaps_prereqs`:来源块 skipped=1 且仍保留自身锚点,into 尾部多出复制的段(seq 连续),引用来源块的 prereq 改为 into;
  6. `split_is_rejected`;`reorder_must_be_permutation`;
  7. `set_anchor_segments_overwrites_with_exact`:回填后 list_anchors 为 exact 段且含 hint 与 text;
  8. `next_new_blocks_includes_learning_blocks`(models):`WHERE status IN ('unlearned','learning') AND skipped=0 ORDER BY seq`——learning 与 unlearned 纯按 seq 交错;`check_behind_counts_learning_as_remaining`(sched);
  9. memory:`apply_eval(book_slug, block_id, title, block_slug, eval, passed: bool, entry_key: &str, date)`——`passed` 决定 status/passed_at/终稿/"通过建议✓|重学建议"(不再看 eval.verdict);历史行末尾带 `<!-- {entry_key} -->`,若文件已含该 key 则整次调用为 no-op(观察笔记也不重复);既有 4 条调用 apply_eval 的用例改为 block_id 参数与 `0003-elasticity.md` 文件名、frontmatter `block_id: 3`;新增 `apply_eval_same_key_is_noop` 与 `apply_eval_passed_overrides_verdict`(eval.verdict=relearn + passed=true → `status: passed`、终稿写入);lifecycle.rs 改为 `0001-elasticity.md`。
- [ ] **Step A6.2** RED → **Step A6.3 实现** → **Step A6.4** GREEN → **Step A6.5** commit `feat(core): 地图草图落库、slugify 与稳定 id/修订号的地图确认 (A-T6)`

### Task A7: `session.rs` — 持久化会话与回合

**Files:** Create `core/src/session.rs`

接口:

```rust
pub struct TurnView { pub role: String, pub text: String /*学生回复已剥离 [READY_TO_END]*/, pub status: String, pub client_turn_id: Option<String>, pub ready_to_end: bool }
pub struct SessionView { pub session_id: i64, pub task_id: i64, pub version: i64, pub state: String, pub block_id: i64,
                         pub kind: String, pub transcript: Vec<TurnView>, pub eval: Option<EvalResult> }
/// 返回该任务的唯一未确认会话(存在则 resume,不新建);client_request_id 经 validate_client_id,幂等(同 id 重放返回同一会话)。
/// 任务不存在或 daily_task.date != date → NotFound;任务已 done → Conflict。kind 映射:new→learn、weak_retest→retest、review→review。
pub fn start_or_resume_session(conn, task_id, client_request_id, date) -> Result<SessionView>;
pub fn get_session(conn, session_id) -> Result<SessionView>;

/// 固定注入上下文(TECH_DESIGN §3.2)由 DB 组装:block_title;block_source_text = 各锚点段 text(空则整章 spine 文本),
/// 超过 60 KiB 在字符边界截断并附 "(原文过长,已截断)";eval_history = 该块历史会话 eval_json 摘要行;
/// related_weakpoints = 该块 open 薄弱点;prereq_status = 前置块 标题:状态;profile_summary 由调用方传入(来自 memory/profile.md)。
pub fn fixed_context_for_block(conn, block_id, profile_summary: &str) -> Result<FixedContext>;

pub struct TurnResult { pub student_text: String, pub ready_to_end: bool, pub version: i64 }
/// 协议(顺序不可变):①client_turn_id 经 validate_client_id;②查同 session 同 client_turn_id:已 done → 直接返回既有学生回复
/// (不校验版本);pending → 续跑(跳到④);③否则:state!='open' → Conflict;存在其他 pending user turn → Conflict("pending turn");
/// expected_version != version → Conflict;事务 A:写 user turn(status pending),**不 bump version**;
/// ④**无事务**调用 run_ai_request(request_id=`turn:{session}:{client_turn_id}`,messages=全部 done 回合 + 本 user 回合);
/// ⑤事务 B(IMMEDIATE,重新检查 state='open',否则丢弃回复并返回 Conflict):成功 → user turn done + student turn done(text 存**原文**,含标记)+ version+1;
/// 失败 → user turn 保持 pending 并返回 Err(客户端用**同一 expected_version**与同 client_turn_id 重试即续跑;重启后由 get_session 的
/// pending TurnView.client_turn_id 取回该 id)。输出时 core 剥离 `[READY_TO_END]` 并映射为 ready_to_end=true(重放 done 回合同样重算)。
pub fn submit_turn(conn, provider, policy, session_id, expected_version, client_turn_id, user_text, ctx: &FixedContext, ty: BookType) -> Result<TurnResult>;
pub fn abandon_session(conn, session_id, expected_version) -> Result<()>;  // state='abandoned',version+1;允许存在 pending 回合;confirmed/abandoned → Conflict
```

- [ ] **Step A7.1 失败测试**(MockProvider):双 start(不同 request id)返回同一 session;同 request id 重放返回同一;任务已 done → Conflict;非当日 → NotFound;submit 成功后 transcript 为 [user done, student done] 且 version=1;expected_version 错 → Conflict 且无写入;同 client_turn_id 重放 → 不调 provider、返回相同文本与 ready_to_end;provider 失败 → user turn pending、version 仍 0、Err;**重开连接** → get_session 的 pending 回合带 client_turn_id → 用该 id 与旧版本重试成功 → 只有一条 user turn、一条 student、version=1;另一 turn id 在 pending 期间 → Conflict;READY_TO_END 剥离但 session_turn.text 保留原文;abandon 后 submit → Conflict;pending 期间 abandon 成功且续跑回合的事务 B → Conflict、不写学生回复;fixed_context_for_block 用 exact 段 text 优先、无段回退整章、超长截断。
- [ ] **Step A7.2** RED → **Step A7.3 实现** → **Step A7.4** GREEN → **Step A7.5** commit `feat(core): 持久化费曼会话、幂等回合与固定上下文组装 (A-T7)`

### Task A8: `verdict.rs` — 评估与原子判定流转

**Files:** Create `core/src/verdict.rs`;Modify `core/src/sched.rs`

sched 改动:抽出 `pub fn apply_eval_in_tx(conn: &Connection, block_id, eval: &EvalResult, verdict: Verdict, date) -> Result<()>`(不开事务、按显式 verdict 行动:写 scores、插入未修复薄弱点;Pass → on_block_passed;Relearn → status='learning');`apply_eval_to_db` 保留为包装(自开 IMMEDIATE 事务、传 `eval.verdict`),既有测试不变。

接口:

```rust
pub struct EvaluationView { pub eval: EvalResult, pub version: i64 }
/// 前置:无 pending user turn、≥1 条 user turn(否则 Conflict);request_id 经 validate_client_id。
/// state open → evaluating(短事务);run_ai_json(parse_eval, `eval:{session}:{request_id}`,transcript 来自 session_turn);
/// 成功 → 短事务:eval_json、state='evaluated'、version+1;失败 → state 回 'open'(同 id 可重试)并返回 Err。
/// 已 evaluated:同 request_id(ai_request 已 done)→ 返回既有评估与当前版本;不同 request_id → Conflict。
/// 发现 state='evaluating'(上次崩溃在两个短事务之间):不存在任何 `eval:{session}:*` 行或同 id 行存在 → 用本次 id 续跑(重放/再调);存在不同 id 的行 → Conflict。
pub fn request_evaluation(conn, provider, policy, session_id, request_id, ctx: &FixedContext) -> Result<EvaluationView>;

pub struct VerdictOutcome { pub passed: bool, pub block_status: String, pub task_done: bool, pub outbox_ops: usize, pub version: i64 }
/// 单一原子事务(IMMEDIATE):同 verdict_request_id 已确认 → 从 verdict_json 重建 outcome 返回(不校验版本);
/// 否则校验 state='evaluated'、expected_version;**用户 pass 覆盖 AI verdict**;按任务 kind:
///   new:apply_eval_in_tx(verdict = pass?Pass:Relearn);pass → daily_task done;relearn → 块 'learning'、task 仍 pending;
///   weak_retest:不改块 status/passed_at、不写 eval 薄弱点;on_weak_retest(ref_id, pass);task done;
///   review:同上不改块;on_review_result(ref_id, pass);task done;
/// session:state='confirmed'、version+1、verdict_request_id、verdict_json(存 outcome);
/// outbox(op_id `verdict:{session}:{request_id}:{kind}`):new → block_eval{book_id, block_id, eval, passed(用户判定), date, entry_key=op_id}
/// + sync_weakpoints + sync_map + git_commit(4);weak_retest/review → sync_weakpoints + sync_map + git_commit(3)。
pub fn confirm_session_verdict(conn, session_id, expected_version, request_id, pass: bool, date) -> Result<VerdictOutcome>;
```

- [ ] **Step A8.1 失败测试**:evaluation 幂等(同 id 二次不调 provider);evaluation 失败后 state 回 open 且同 id 重试成功;手工置 state='evaluating' 后同 id 续跑成功、异 id → Conflict;非 evaluated 状态 confirm → Conflict;`apply_eval_in_tx` 在外层事务内可用(既有 apply_eval_to_db 用例仍绿);pass 流转(块 passed、stage1 复习、weak_point 入库、task done、outbox 4 行);relearn 流转(块 learning、task 仍 pending、无复习、次日 generate_daily 仍含该块为 new);**用户与 AI 不一致**:AI relearn + pass=true → passed;AI pass + pass=false → learning;weak_retest 任务 pass → on_weak_retest streak+1、task done、块 status/passed_at 不变、薄弱点数不变、outbox 3 行;review 任务 fail → 重置 1 天档 + 新薄弱点(仅 on_review_result 产生的 1 条)、task done、块 status 不变;同 request_id 双 confirm → 同 outcome、无重复复习行/outbox 行;不同 request_id 二次 confirm → Conflict。
- [ ] **Step A8.2** RED → **Step A8.3 实现** → **Step A8.4** GREEN → **Step A8.5** commit `feat(core): 评估请求与原子判定流转——用户判定覆盖、任务类型分流、确认幂等 (A-T8)`

### Task A9: `projection.rs` — 投影 outbox 重放

**Files:** Create `core/src/projection.rs`

接口:

```rust
pub fn enqueue(tx: &Connection, op_id: &str, kind: &str, payload: &serde_json::Value) -> Result<()>;  // 在调用方事务内;同 op_id 已存在 → 忽略
/// 按 id 顺序处理 status IN ('pending','failed') 的行(failed 行 attempts++ 重试):
/// kind ∈ init_book{book_id}(ensure_book(slug,title)) | block_eval{book_id, block_id, eval, passed, date, entry_key}(先 ensure_book 防御,再
/// memory.apply_eval(book_slug, block_id, title, block_slug, eval, passed, entry_key, date)——同 entry_key 已写入则 no-op)
/// | sync_weakpoints{book_id} | sync_map{book_id} | git_commit{message};
/// slug/title/块列表在重放时从 SQLite 读取(投影反映当前状态)。每条成功 → done(短事务);失败 → failed+error 并**停止**(保持顺序);返回本次成功处理条数。
pub fn run_pending(conn, memory: &MemoryStore) -> Result<usize>;
```

- [ ] **Step A9.1 失败测试**:apply_draft_map + confirm 后 run_pending(不手工 ensure_book)→ books/<slug>/ 目录、块 md `{block_id:04}-{slug}.md` 存在且含终稿、_weakpoints.md 含待考、_map.md 状态行、git log 含 message;再次 run_pending → 0 条(幂等);**用户判定覆盖**:AI relearn + confirm(pass=true) 后块 md `status: passed` 且含终稿;**跨崩溃重放**:第一次 run_pending 后把 block_eval 行手工改回 pending(模拟"文件已写、done 未落库")再 run_pending → 评估历史恰 1 行、观察笔记恰 1 条;模拟 git 失败(把 memory root 的 .git 目录权限置 0o000,root 跳过)→ 前面各条 done、git 条 failed、error 非空;恢复权限后 run_pending → 恰一条被处理(failed 行重试)且 git log 只多一条提交;enqueue 同 op_id 二次 → 仍一行。
- [ ] **Step A9.2** RED → **Step A9.3 实现** → **Step A9.4** GREEN → **Step A9.5** commit `feat(core): 投影 outbox 重放——md 与 git 成为可重放投影 (A-T9)`

### Task A10: 端到端集成、文档回写、收尾

**Files:** Create `core/tests/m1_engine.rs`;Modify `TECH_DESIGN.md`(§3.1 块文件命名/§3.3 投影/§4 v4/§5 编排/§6 已实现标注与 prompt-only)、`IMPLEMENTATION_PLAN.md`、基线文档 Node 1/4/5/6/8/9 状态、`DEVLOG.md`

- [ ] **Step A10.1** 集成测试(MockProvider 按 request_id 分发固定 JSON;**provider 回调内用第二连接对同一 DB 文件写入一行 setting,证明 AI 调用期间无事务持有**):建书 → store_spine(3 章) → run_map_job → apply_draft_map → set_plan → generate_daily(Day0,new 任务) → start_or_resume_session → submit_turn ×2(第二次 READY_TO_END) → request_evaluation → confirm_session_verdict(pass) → run_pending(init_book + md + git,不手工 ensure_book) → **重开连接**再 run_pending = 0、再 confirm 同 request_id = 同 outcome → generate_daily(Day1)队首为 weak_retest 且 review 到期。
- [ ] **Step A10.2** 全量:`cargo test`、clippy `-D warnings`、`cargo fmt --check`;记录用例数。
- [ ] **Step A10.3** 回写文档 + DEVLOG(每 Task 数字、与基线偏差、Mac 阶段需接线的 command 清单——按 Plan B 契约 v2 命名:`startOrResumeSession` / `submitTurn` / `requestEvaluation` / `confirmSessionVerdict` / `abandonSession` / `confirmMap`(ops+expectedRevision)/ `mapJob` 进度 / `storeSpine` / `setAnchorSegments` / `runProjection`)。
- [ ] **Step A10.4** commit `docs: M1 core engine 收尾与回写 (A-T10)`;打 tag `m1-linux-a`;凭证到位后随 linux-local 一并推送。

## 完成定义(DoD)

1. v4 迁移追加式且保留 v3 全部行;六张新表外键/唯一索引生效;确认幂等键(`verdict_request_id`)唯一。
2. 任一 AI 调用经 orchestrate:同 ID 不重复付费、传输错误最多重试 2 次、坏 JSON 恰纠错 1 次、只有 accept 通过才记 done;AI 调用期间无事务持有(`is_autocommit` 检查 + 集成测试第二连接写入不阻塞)。
3. 地图作业可从任意章节断点续跑;长章分片后每片 prompt ≤ 100 KiB;草图校验拒绝环/重复/未知来源。
4. 会话:一任务一未确认会话;回合幂等;失败保留用户回合且版本不变、同版本重试续跑;版本冲突可检测。
5. 判定:单事务完成会话/块/薄弱点/复习/任务/outbox;用户判定覆盖 AI 建议且同样体现在块 md;非 new 任务不改块状态;双确认幂等;outbox 重放后 md 与 git 与 SQLite 一致,重启重放幂等(含"文件已写、done 未落库"边界),failed 行可重试。
6. clippy/fmt/全量测试绿;每 Task 一 commit;DEVLOG 与 SPEC 回写完成。
