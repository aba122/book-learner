# Mac 阶段:M1 原生接线与发布门禁 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Apple Silicon Mac 上把 Linux 阶段完成的 core 引擎与 web 契约 v2 接成可用的原生应用:推送/合并已完成工作、通过 Foundation 原生门禁、修 F3、决策并实现 EPUB 原生导入、接线 10+3 条 Tauri command、基础 tray 与启动恢复、真书 + 真 codex 端到端门禁 → 打 tag `m1`。

**Architecture:** Tauri command 保持"传输薄层":校验 + DTO 转换 + 调用 `book_learner_core` 用例;慢操作(地图作业、会话回合、评估、导入)**用独立 SQLite 连接**,不持有 `AppState` 的 `Mutex<Connection>`;AI 调用期间 core 已保证无事务。每接一条 command:实现 → 从 `shared/tauri-wire-contract.json` 与 Rust `UNSUPPORTED_CAPABILITIES` 同步移除 → `web/src/backend/contract.test.ts` 精确列表同步 → TauriBackend 门控自动放开。EPUB 传输按 ADR-0004 选项 B(WebView 已持有 `File`,抽取在 JS;原生只需接收字节落盘),经 Tauri 2 `invoke` 原始请求体分块传输,先做大文件 spike 再定稿。

**Tech Stack:** macOS 14+ Apple Silicon、Rust stable、Node 22 + pnpm 11.24.0(corepack)、Tauri 2(`tauri-plugin-dialog`、tray-icon feature)、codex CLI(已登录)。

**Spec 依据:** `DEVLOG.md` 末段"Mac 阶段需接线的 command 清单"(权威映射:wire 名 → core 用例 → DTO);`docs/adr/0004-epub-native-transport.md`;`docs/smoke/mac-m1-native-smoke.md`;基线文档 `docs/superpowers/plans/2026-09-02-product-m1-implementation-baseline.md` Node 0/2/3/7/11/12;`web/src/backend/tauri.ts`(v2 解码器 = DTO 形状的真值)与 `web/src/types.ts`(`MapEditOp` 等判别联合的字段名)。**范围外:** M2(通知调度、Rust 番茄钟、三类模板后半段、完整统计)、M3(语音/导出/签名 DMG)、`completeTask` 通用完成(基线要求保持 unsupported,判定流转只经 `session_confirm_verdict`);设置页"测试连接"(`CodexCliProvider::validate/test_connection`,DEVLOG A-T10 提及但不在共享契约内,留 M2)。

---

## 前置条件(Mac 会话开工前一次性完成)

```bash
# 1. 工具链
rustup update stable && node -v   # v22.x
corepack enable && corepack prepare pnpm@11.24.0 --activate
codex exec "hi"                    # 已登录
# 2. 取得代码(二选一)
git clone https://github.com/aba122/book-learner.git && cd book-learner      # 若 Linux 分支已推送
#   或:从 bundle 取(Linux 上 /bigtemp/fzv6en/book-learner/*.bundle 拷到本地)
git fetch feat-mac-m1-pending.bundle linux-local:feat/mac-m1
git fetch m1-linux-pending.bundle feat/m1-core-engine:feat/m1-core-engine feat/m1-web-contract:feat/m1-web-contract 'refs/tags/*:refs/tags/*'
git checkout feat/m1-web-contract
# 3. 基线(必须与 Linux 记录一致)
pnpm -C web install --frozen-lockfile
cargo test --manifest-path core/Cargo.toml            # 127 + 27 + 1 + 1,1 ignored
pnpm -C web exec vitest --run                         # 247 passed / 2 skipped
pnpm -C web lint && pnpm -C web build                 # 0 warnings
cargo test --manifest-path web/src-tauri/Cargo.toml   # ← 预期 foundation 契约用例 RED(见 M0.3)
```

## 流程约定

- 每 Task:RED → GREEN → 全量门禁(core / web / **src-tauri** 三套测试 + clippy + fmt + lint + tsc + build)→ 勾选复选框 → DEVLOG → commit → **push**(Mac 有凭证,恢复"每节点推送")。
- **分支策略(merge-first)**:M0.2 先把三个既有 PR 合并进 main,再 `git checkout -b feat/mac-m1-wiring main`;M2.2 的 `mac-m1` 与 M8.3 的 `m1` 都打在 main 上。
- **契约同步是四处,不可分离,必须同一 commit**:①`shared/tauri-wire-contract.json`;②`web/src-tauri/src/commands/mod.rs`(`WIRE_COMMANDS` / `UNSUPPORTED_CAPABILITIES`);③`web/src/backend/contract.test.ts` 精确列表;④`web/src/backend/tauri.test.ts`——其传输用例断言"记录到的调用 == 所有不在 unsupported 中的命令",`routes every unsupported method` 用例硬编码 15 个操作与 unsupported 对照,v2 段有 `V2_METHODS` 常量;每次从 unsupported 移除或新增 command 都要同步这三处断言,否则 web 门禁在 Task 中途即红。`web/src-tauri/tests/foundation.rs` 的 `real_tauri_ipc_surface_matches_the_shared_wire_contract` 按契约逐命令构造 payload(`match` 的 fallback 对未知命令 `panic!`)并断言除 `unsupported_capability` 外全部 `Ok`——新增 command 必须同 commit 扩展该 `match`。
- 原生环境**禁止**回退 Mock 数据;未接线能力保持显式 `not_implemented`。
- 慢命令用 `AppState::open_connection()`(M3 引入)而非 `with_connection`。

## 文件结构

```
web/src-tauri/src/
├─ lib.rs            ← setup 错误处理(F3)、启动恢复、tray、command 注册
├─ state.rs          ← database_path/memory_root/books_dir、open_connection、provider/policy 构造
├─ commands/mod.rs   ← WIRE_COMMANDS/UNSUPPORTED 同步;新 command 薄层
├─ application/mod.rs← 新用例编排(map/session/import/stats)
├─ dto/mod.rs        ← 新 DTO(SpineChapter/MapEditOp/AnchorSegment/SessionView/TurnView/TurnResult/EvaluationView/VerdictOutcome/MapProgress/ImportResult/Stats)+ Book.map_revision + Block.skipped
├─ import.rs         ← 新:EPUB 暂存/校验/finalize(ADR-0004 选项 B)
└─ tests/foundation.rs ← 契约同步用例扩展、连接策略用例、DTO 往返用例
docs/adr/0004-epub-native-transport.md ← Status: Deferred → Accepted(选项 B + spike 数据)
docs/smoke/mac-m1-native-smoke.md      ← 填写签字
```

---

### Task M0: 推送、PR、编译基线与契约同步修复(半天)

- [x] **M0.1**(2026-09-07 在 Linux 侧用用户 token 完成;CI core/web 绿,tag 未推送)推送 Linux 阶段全部成果:`git push origin feat/mac-m1 feat/m1-core-engine feat/m1-web-contract m1-linux-a m1-linux-b`;确认 GitHub Actions core/web job 转绿(pnpm 版本修复已在 feat/mac-m1)。
- [ ] **M0.2**(PR #3/#4/#5 已开;**合并待用户**——Mac 无 GitHub 凭证;本分支 `feat/mac-m1-wiring` 暂自 `feat/m1-web-contract` 开出,PR 合并后再并入 main)开三个堆叠 PR 并按序合并:`feat/mac-m1 → main`、`feat/m1-core-engine → feat/mac-m1`、`feat/m1-web-contract → feat/m1-core-engine`(每个合并前 CI 绿;合并后 GitHub 自动重定向下游 base)。合并完成后 `git checkout -b feat/mac-m1-wiring main`。
- [x] **M0.3 失败测试**(实测 `foundation.rs:517` 整体比对红,8/9 过):`cargo test --manifest-path web/src-tauri/Cargo.toml` — 预期 `tests/foundation.rs` 中对照 `shared/tauri-wire-contract.json` 的用例 RED(JSON 19 条命令/15 项 unsupported vs Rust 9/11)。
- [x] **M0.4 实现**(占位命令参数已按 types.ts 类型化;payload 键比对改为集合比对,因 serde_json 默认 BTreeMap 键序无语义):`commands/mod.rs` 的 `WIRE_COMMANDS` 增 10 条(command 名与 payloadKeys 逐字对齐 JSON:`map_store_spine[bookId,chapters]`…`session_abandon[sessionId,expectedVersion]`);`UNSUPPORTED_CAPABILITIES` 改为 JSON 当前 15 项;这 10 条命令**暂以占位实现**(注册同名 command,内部返回 `IpcError::not_implemented(方法名)`)。同 commit 扩展 `foundation.rs` 的 `real_tauri_ipc_surface_matches_the_shared_wire_contract`:为 10 条新命令补 payload 分支,并把"占位期间预期 `not_implemented`"写成表驱动(一个 `PLACEHOLDER_COMMANDS` 集合),M4/M5 每接一条就从该集合移除、改为预期 `Ok`;M6 的 `library_import_epub_chunk` 需要原始请求体,在该用例中单列特殊分支。
- [x] **M0.5** GREEN(src-tauri 9+1+2 全绿,clippy 0;`tauri dev` 七路由目检待有 GUI 会话时补做——本阶段经 SSH 隧道无桌面)(此时 v2 能力仍是未实现态)。commit `chore(mac): 同步 Rust 侧 wire 契约常量,注册 v2 占位命令 (M0)` + push。

### Task M1: F3 —— 启动失败可见(1 小时)

**Files:** `web/src-tauri/src/lib.rs`, `web/src-tauri/Cargo.toml`(`tauri-plugin-dialog`), `tests/foundation.rs`

- [x] **M1.1 失败测试**(`startup_initialization_returns_typed_errors_instead_of_panicking`):把 `setup` 闭包内逻辑抽为 `pub fn initialize_state(platform_data_dir: &Path) -> Result<AppState, IpcError>`;用例(须持 `foundation.rs` 既有的 `environment_lock()`,因既有用例也改写 `BOOK_LEARNER_DATA_DIR` 且并行运行):`BOOK_LEARNER_DATA_DIR` 为相对路径 → `Err(code=InvalidRequest, message 含 "绝对路径")`;数据目录不可写(chmod 000,root 跳过)→ `Err(code=IoFailure|DbUnavailable)`,`internal_cause` 非空。
- [x] **M1.2 实现**(偏差:对话框用 `rfd` 直连而非 tauri-plugin-dialog,原因见 DEVLOG):`run()` 中 setup 失败 → `tauri_plugin_dialog` 阻塞式错误对话框(标题"book-learner 无法启动",正文 `error.message` + "详细原因已写入日志"),`tracing::error!(code, internal_cause)`,然后 `std::process::exit(1)`;**不再 `expect` panic**。
- [x] **M1.3** GREEN;手工(以无人值守脚本 `~/Developer/f3-smoke.sh` 替代:进程停在对话框、日志含 error_code/internal_cause):设置 `BOOK_LEARNER_DATA_DIR=relative` 启动 → 看到对话框而非崩溃。commit `fix(mac): 启动失败显示原生错误对话框并记录日志,不再 panic (M1, F3)` + push。

### Task M2: Foundation 原生门禁(半天,手工)

- [ ] **M2.1** 逐节执行 `docs/smoke/mac-m1-native-smoke.md` §1–§4(唯一 fixture、两次原生启动、生产路径对照),把每个复选框与观察值填进文档;失败项先修再重跑。
- [ ] **M2.2** §5 签字;DEVLOG 记录;commit `docs(smoke): Apple Silicon 原生门禁通过 (M2)` + push;在 main 上打 annotated tag `mac-m1` 并推送。

### Task M3: 连接策略、记忆库根与启动恢复(半天)

**Files:** `state.rs`, `lib.rs`, `tests/foundation.rs`

- [x] **M3.1 失败测试**(三个用例:数据位置+独立连接不被守卫串行化、启动恢复重放 outbox、codex 路径解析纯函数):`AppState::open_connection()` 返回新连接(`db::open(path)`,含 busy_timeout/外键/迁移);用例:持有 `with_connection` 守卫期间,另一线程经 `open_connection()` 完成一次写入不阻塞超过 busy 上限(证明慢命令不会被守卫串行化);`AppState::memory_root()` = `<data_dir>/book-learner/memory`(debug 覆盖同 database_path 规则);`AppState::books_dir()` = `<data_dir>/book-learner/books`。
- [x] **M3.2 实现**(`resolve_codex_bin` 为纯函数,固定目录经参数注入;`with_provider` 注入点已就位供 M4):`AppState` 增 `database_path/memory_root/books_dir` 字段与三个方法;`memory::MemoryStore::init(memory_root)` 在 setup 内完成;setup 末尾 `tauri::async_runtime::spawn` 一次 `projection::run_pending(open_connection()?, &memory)`(启动恢复,结果写日志);`AppState::ai_provider()` 返回 `CodexCliProvider { bin, extra_args: [] }` 与 `AiPolicy::default()`;`bin` 直接读 `setting` 表键 `codexBin`(`codexBin` **不是** `AppSettings` 字段,勿改 `deny_unknown_fields` 结构),缺省解析 `codex`:Finder 启动的 GUI 不继承 shell PATH,解析顺序为 绝对路径设置 → `$PATH` → `/opt/homebrew/bin` → `/usr/local/bin` → `~/.npm-global/bin` → `~/.nvm/versions/node/*/bin`,全部失败 → `not_found` 并在设置页提示填写绝对路径。
- [x] **M3.3** GREEN(src-tauri 13/1/2、clippy 0);commit `feat(mac): 独立连接策略、记忆库根与启动投影恢复 (M3)` + push。

### Task M4: 接线 map 组(5 命令,1 天)

**Files:** `dto/mod.rs`, `application/mod.rs`, `commands/mod.rs`, `lib.rs`, `shared/tauri-wire-contract.json`, `web/src/backend/contract.test.ts`, `tests/foundation.rs`

DTO 形状以 `web/src/backend/tauri.ts` 的 `decode*` 与 `web/src/types.ts` 为真值(camelCase;`MapEditOp` 用 serde 内部标签枚举,标签字段名与 TS 判别字段一致——在 Mac 上打开 `types.ts` 核对后再写)。

- [x] **M4.1 失败测试**(`map_group_commands_round_trip_and_expose_revision_and_skipped`、`map_run_job_uses_the_injected_provider_reports_progress_and_is_idempotent`、`map_run_job_over_ipc_emits_map_job_progress_events_with_the_job_id`)(`tests/foundation.rs`,直接调 `*_inner`):
  - `map_store_spine` 写 `spine_item` 且 `import_state='extracted'`;
  - `map_run_job` 用 `MockProvider`(测试内实现 `AiProvider`,按 request_id 后缀返回 Stage A/B 固定 JSON;`AppState` 需可注入 provider——加 `AppState::with_provider(Box<dyn AiProvider>)` 测试构造)→ 返回块列表(含 `skipped`)、进度事件至少 3 次 Chapter + Merging + Done(用 `tauri::test::mock_app` 捕获 `map_job_progress` payload `{jobId, progress}`);再次同 jobId → 不重复落库;
  - `map_confirm` 修订号不符 → `conflict`;成功返回 `{revision}`;
  - `map_set_anchor_segments`/`map_list_anchors` 往返;
  - DTO:`BookDto.map_revision`、`KnowledgeBlockDto.skipped` 序列化字段名 `mapRevision`/`skipped`。**core 改动(本 Task 允许)**:`models::Book` 增 `map_revision: i64` 且 `list_books` SELECT 该列(修正 `core/tests/foundation.rs` 与 `web/src-tauri/examples/seed_smoke.rs` 中的 `Book { .. }` 字面量);`KnowledgeBlock.skipped` 已在 core。接线后 TS 侧 `decodeBook`/`decodeBlock` 删除 `?? 0`/`?? false` 缺省,`mapRevision`/`skipped` 视为必填(同 commit 更新 `tauri.test.ts` fixture)。
  - 测试基建:`AppState::with_provider(Box<dyn AiProvider + Send + Sync>)`(`AiProvider` 无超 trait,Tauri `manage` 要求 `Sync`;测试 `MockProvider` 用 `Mutex` 而非 core 测试里的 `RefCell`);进度事件在 `tauri::test::mock_app` 下用 `app.listen_any("map_job_progress", …)` 或注入的 sink 捕获(MockRuntime 不执行 JS)。
  - `MapEditOp` serde:`#[serde(tag = "<判别字段名,以 web/src/types.ts 为准>", rename_all = "camelCase", rename_all_fields = "camelCase")]`(serde ≥1.0.229 支持 `rename_all_fields`,使 `blockId`/`blockIds` 自动对齐)。
- [x] **M4.2 实现**(TS 解码器 mapRevision/skipped 改必填;tauri.test.ts 的 unsupported 路由用例改为按契约 JSON 数据驱动):`application::{store_spine, run_map_job, confirm_map, set_anchor_segments, list_anchors}`(慢的 `run_map_job` 用 `open_connection()`;**先查 `book.map_revision > 0`——已有地图则直接返回 `list_blocks` 且不发进度、不重跑作业**(与 Mock 语义一致);否则 `mapgen::run_map_job` 后 `map::apply_draft_map`,若其返回 `Conflict`(并发下已落库)同样回退为 `list_blocks`);command 薄层;`register_commands` 注册;JSON/Rust/TS 三处从 unsupported 移除 `storeSpine/runMapJob/confirmMap/setAnchorSegments/listAnchors`。
- [x] **M4.3** GREEN(core 127/27/1/1、src-tauri 16/1/2、web 248/1、clippy 0;`tauri dev` 目检待 GUI 会话);`tauri dev`:导入向导走到地图页(需 M6 之前用 Mock 不可行——此处先用 `BOOK_LEARNER_DATA_DIR` 指向 `seed_smoke` 库并手工调用 `map_store_spine`,或推迟目检到 M6)。commit `feat(mac): 接线地图组 5 条 command (M4)` + push。

### Task M5: 接线 session 组(5 命令,1 天)

- [x] **M5.1 失败测试**(`session_group_commands_run_the_feynman_loop_with_idempotent_ids_and_versions` + 契约用例会话组 payload 走真实闭环):`session_start_or_resume` 幂等/同任务 resume;`session_submit_turn`(MockProvider)返回 `TurnResult{studentText,readyToEnd,version}`,同 clientTurnId 重放不调 provider,版本冲突 → `conflict`;`session_request_evaluation`(requestId 固定 `'eval'`)返回 `EvaluationView{eval,version}`;`session_confirm_verdict`(requestId `'verdict'`)返回 `VerdictOutcome{passed,blockStatus,taskDone,outboxOps,version}` 且随后 `projection::run_pending` 被触发(记忆库出现块 md);`session_abandon`;错误码映射 `Conflict→conflict/InvalidInput→invalid_request/NotFound→not_found`。
- [x] **M5.2 实现**(core 增 `MemoryStore::profile_summary()`;`session_confirm_verdict` 命令用 `AppHandle` 在 `spawn_blocking` 里复用 `run_startup_recovery` 重放投影):`application::{start_or_resume_session, submit_turn, request_evaluation, confirm_session_verdict, abandon_session}`;`submit_turn` 需 `ty: BookType`(经 `models::get_book_slug_type`)与 `ctx`(`session::fixed_context_for_block(conn, block_id, profile_summary: &str)`——profile 摘要 = `profile.md` 前两节;`memory::extract_section` 为私有,**core 增 `MemoryStore::profile_summary(&self) -> Result<String>`**,本 Task 允许)+ `open_connection()` + `ai_provider()` + `memory_root` 作 workdir;`confirm_session_verdict` 成功后 `tauri::async_runtime::spawn(run_pending)`;三处契约移除 5 项。
- [x] **M5.3** GREEN(用例见 DEVLOG);`tauri dev`:用 seed 库走"今日→费曼→评估→确认"(真 codex)。commit `feat(mac): 接线会话组 5 条 command (M5)` + push。

### Task M6: ADR-0004 决策与原生导入 / epubUrl / blockSource(1–1.5 天)

**Files:** `docs/adr/0004…md`, `src/import.rs`(新), `application/mod.rs`, `commands/mod.rs`, `tauri.conf.json`(asset protocol scope), `capabilities/default.json`, `web/src/backend/tauri.ts`(`importEpub` 改为原始请求体分块 invoke), `web/src/features/library/ImportWizard.tsx`(若签名变)

- [x] **M6.1 Spike(≤2 小时,记录进 ADR)**(部分:MockRuntime IPC 层原始请求体分块落盘已验证;真实 WebView 50/300 MB 吞吐待 M8 GUI 冒烟补测,ADR 已注明):用 50 MB 与 300 MB 合成 EPUB 测两条路:(B) `invoke('library_import_epub_chunk', bytes, { headers })` 分块 4 MiB 传原始请求体;(A) `tauri-plugin-dialog` 路径能力。记录耗时/内存/失败模式;**默认结论 B**(理由:WebView 已持有 `File` 供 epub.js 抽取,原生只需字节落盘;无任意路径暴露),除非 spike 证明不可接受。ADR Status → Accepted,写决策与数据。
- [x] **M6.2 失败测试**(`import.rs` 4 个单测 + `native_import_over_ipc_*`;书架"导入未完成"徽标/续跑/删除未做——需 `Book.importState` 进契约与 `deleteBook` 新命令,记入 ADR 偏差)(`import.rs` 单测 + foundation):`stage_chunk(op_id, idx, bytes)` 写 `<data>/import/<op_id>/part-<idx>`,单文件上限(默认 200 MiB,超出 `invalid_request`);`finalize(op_id, book_type, title?)`:校验 zip 魔数、`mimetype` 首条目为 `application/epub+zip`、`META-INF/container.xml` 存在、条目数 ≤ 5000、无 `..`/绝对路径条目;通过 → `models::insert_book` 后 `UPDATE book SET import_state='staged'`(`staged` 是 v4 文档三态 `ready|extracted|mapped` 之外的新值,回写 TECH_DESIGN §4)+ 原子 rename 到 `books/<book_id>.epub` + 清理暂存;失败 → 无 book 行、暂存清理;同 `op_id` 二次 finalize 返回同一 `bookId`;崩溃恢复:启动时删除 24h 前的暂存目录。**书架对 `staged`/`extracted`(有书无地图)的书显示"导入未完成"徽标,点击进入导入向导续跑(向导按 `import_state` 跳过已完成步骤)或删除**——防止向导中途崩溃留下不可用书目。
- [x] **M6.3 实现**(分块经 `tauri::ipc::Request` 原始体 + `x-op-id`/`x-chunk-index` 头;`protocol-asset` 特性 + 运行时 `allow_directory(books_dir)`;TS `epubUrl` 经可注入的 `convertFileSrc`) `library_import_epub_chunk` / `library_import_epub_finalize`(两条新 command 加入三处契约;`importEpub` 从 unsupported 移除);`library_epub_url[bookId]` → Rust 返回受管绝对路径 `books_dir/<id>.epub`(校验 id 存在且路径在 books_dir 下),TS `TauriBackend.epubUrl` 用 `convertFileSrc` 转 asset URL;asset protocol:`tauri.conf.json` 开启 `app.security.assetProtocol.enable`,**作用域在 setup 里运行时授予** `app.asset_protocol_scope().allow_directory(&books_dir, true)`(静态 glob 无法覆盖 `BOOK_LEARNER_DATA_DIR` 调试覆盖目录,而 M4.3/M5.3/M6.4 与 smoke 都依赖该覆盖;否则 `EpubView` 的 `ePub(url)` 会静默失败);`map_block_source[blockId]` → 由 `block_anchor` 段(exact 优先)或 `spine_item` 拼 `{href, text}`;`epubUrl/blockSource` 从 unsupported 移除。TS 侧 `TauriBackend.importEpub` 改为分块上传 + finalize(保留 `File` 给 epub.js 抽取)。
- [x] **M6.4** GREEN(src-tauri 含 import 单测全绿、web 251/1、clippy 0);`tauri dev` 用真 EPUB:导入 → 抽取 → 地图作业 → 地图页。commit `feat(mac): EPUB 原生导入(ADR-0004 选项 B)、受管 epubUrl 与 blockSource (M6)` + push。

### Task M7: `stats_get` 与基础 tray/生命周期(半天)

- [x] **M7.1**(core `stats::compute(conn, date)`:范围=主攻书;连击=连续有完成任务的天数,当天无完成则从昨天起算;TS `stats()` 内部取本地日历日)`stats_get` → core 新增 `stats::compute(conn, date) -> Stats{totalBlocks,passedBlocks,streakDays,openWeakPoints,fixedWeakPoints,minutesToday}`(在 **core** 加用例;streak 按连续有 done 任务的日期计算;minutesToday 按当日 done 任务 est_minutes 求和,番茄钟精确统计属 M2)→ command → 三处契约移除 `stats`。
- [ ] **M7.2** tray:菜单"显示主窗口 / 退出";关窗 = 隐藏到 tray(`on_window_event CloseRequested → hide + prevent_close`);Cmd+Q / 菜单退出 = 有序退出:等待进行中的导入/作业收尾(超时 10s 后强制)、无 codex 子进程残留(core 已按进程组终止)。用例:foundation 层验证 `shutdown_hook` 会 join 进行中的任务句柄;手工:Cmd+Q 后 `pgrep codex` 为空。
- [ ] **M7.3** commit `feat(mac): stats 命令、tray 生命周期与有序退出 (M7)` + push。

### Task M8: 产品 M1 端到端门禁 → tag `m1`(半天)

- [ ] **M8.0 受控测试日期**(Node 12 第 7 步的前提):所有 command 的 `date` 均由前端 `localCalendarDate()` 提供,core 不读系统时间;在 `web/src/lib/localDate.ts` 增加**仅 `import.meta.env.DEV` 生效**的覆盖——`localStorage.getItem('bookLearner.testDate')`(`YYYY-MM-DD`)存在则返回它;vitest 用例覆盖"生产构建忽略该键"与"DEV 下生效";DEVLOG 记录用法(`localStorage.setItem('bookLearner.testDate','2026-09-10')` 后刷新)。
- [ ] **M8.1** 按基线 Node 12 七步,用一本真实教材 EPUB + 真 codex:导入并重启 → 生成地图/进度/编辑/定稿/设目标 → 开始今日新块、阅读精确原文、讲授并故意暴露一个薄弱点 → 制造一次 codex 超时并重试(transcript 不丢)→ 评估、确认通过、等待记忆库投影与 git commit → Cmd+Q 重启,核对 SQLite/Markdown/git 一致 → 经 M8.0 机制把日期推进一天,完成队首薄弱点重考。每步观察值写入 `docs/smoke/m1-e2e-gate.md`(新建,格式同 mac-m1 smoke)。
- [ ] **M8.2** 全量门禁:三套测试、clippy、fmt、lint、tsc、web build、`pnpm -C web tauri build --debug` 与 release build、干净用户目录冒烟;日志抽查无 EPUB 文本/transcript/私有路径泄漏。
- [ ] **M8.3** 回写 `IMPLEMENTATION_PLAN.md` M1 验收状态、`CLAUDE.md` 状态区、基线文档 Node 0/2/3/7/11/12;DEVLOG 收尾;PR 合并 → main 上 annotated tag `m1` 并推送。

## 完成定义(DoD)

1. 三处契约完全一致且 `unsupportedCapabilities` 仅剩 `completeTask`(有意保留);其余 v2 能力在原生环境走真实 command。
2. 启动失败不 panic;Foundation 门禁与 M1 端到端门禁文档均签字;`mac-m1`、`m1` 两个 tag 在 main 上。
3. 慢命令不持有连接守卫;启动恢复重放 outbox;Cmd+Q 无子进程残留。
4. ADR-0004 为 Accepted 且含 spike 数据;导入拒绝损坏/遍历/超限文件,重复导入幂等。
5. 每 Task 一 commit 一 push;CI 三 job 绿;DEVLOG 完整。

## 预计工时

M0 半天 · M1 1h · M2 半天 · M3 半天 · M4 1 天 · M5 1 天 · M6 1–1.5 天 · M7 半天 · M8 半天 ≈ **5–6 个工作日**(含真机调试余量)。
