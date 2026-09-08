# Product M1 Implementation Baseline

**Status:** Ready for execution after the Mac Foundation release gate

**Date:** 2026-09-02

**Product authority:** `PRODUCT_SPEC.md`

**Technical authority:** `TECH_DESIGN.md`

**Milestone acceptance:** `IMPLEMENTATION_PLAN.md` M1

**Foundation smoke:** `docs/smoke/mac-m1-native-smoke.md`

## 1. Outcome and starting point

The next milestone is the product `m1`: import one real EPUB, generate and confirm its knowledge map, create a plan and daily task, read the exact source range, complete a durable Codex-backed Feynman session, confirm an evaluation, project the result to the memory repository, and resume with the correct weak-point task after restart.

Do not start product behavior until the Mac Foundation hard gate is green on Apple Silicon and the current local commits are pushed and reviewed. Foundation proves the native boundary; it does not prove the learning loop.

Current reusable assets:

| Area | Reusable now | Product-M1 gap |
|---|---|---|
| Shell/runtime | Tauri 2 shell, runtime selection, debug data-dir override | Apple Silicon smoke, basic tray lifecycle |
| SQLite | schema v2, migrations, strict reads, active book, plan/queue/settings transactions | EPUB cache, multi-range anchors, durable session/turn state, operation outbox, stronger foreign keys |
| AI | `AiProvider`, Codex CLI arguments, Feynman/eval prompts, strict eval parsing | stderr/process cleanup, retry orchestration, token/context limits, durable request idempotency |
| Memory | templates, deterministic sections, weak/map projection helpers, local git commit | safe slugs, atomic file replacement, recoverable SQLite→files→git orchestration |
| Web | seven routes, Mock happy path, typed Tauri adapter, route/operation error states | real import transport, map progress, EPUB errors/highlights, durable session resume, send/end/confirm errors |
| Scheduling | weak/review/new ordering, evaluation transitions, restart tests | one atomic task/session/verdict completion use case exposed to Tauri |

## 2. Findings that determine the order

### P0 — data correctness and recovery

1. `core/src/db.rs` stores only one `spine_href/cfi_start/cfi_end` on a block. This cannot represent the approved cross-chapter/multi-segment anchor model and there is no persisted spine text cache.
2. `MapEditBlock` contains title/module/sequence/skipped but no stable block ID or expected map version. A native `confirmMap` implementation would risk overwriting status, scores, dependencies, or concurrent edits.
3. `core/tests/lifecycle.rs` calls SQLite evaluation, Markdown writes, and git commit sequentially. The comment already calls SQLite one "half"; a crash between calls leaves divergent stores.
4. Several v1 child tables lack declared foreign keys, and `feynman_session` lacks task identity, state/version, request IDs, and normalized turns. Client-supplied full transcripts cannot be the source of truth.
5. `MemoryStore` joins raw slug strings into paths and writes target files in place. Production input must never be able to traverse the memory root, and projection interruption must not truncate the last good file.

### P0 — AI process and interaction durability

1. `CodexCliProvider` pipes stderr but only drains it after child exit. A noisy process can fill the pipe, block, and be reported as a timeout.
2. Timeout kills only the direct child; process-tree cleanup and temporary output cleanup need deterministic tests.
3. Feynman `send`, `endTeaching`, and `confirmVerdict` currently await backend calls without error state, synchronous guards, generations, or retry identity. A failure can leave "thinking" stuck or produce an unhandled rejection.
4. Navigating Feynman → Reader → Feynman remounts the route. Native start must resume the task's open session, not create another paid session.
5. `confirmVerdict` followed by generic `completeTask` is not atomic. Product M1 must expose one result-bearing core operation that updates session, block, weak/review state, daily task, and projection outbox together.

### P1 — EPUB and WebView boundary

1. The current `importEpub(file: File, type)` works for Mock but does not define an efficient native transfer for large local files. Raw user paths must not be accepted from arbitrary WebView input.
2. A managed EPUB URL must be scoped to the app's books directory and canonicalized; never expose a general `file://` reader.
3. `EpubView` swallows EPUB load/location failures and has no `onError`, so a successful `epubUrl` command can still render an empty reader.
4. The CFI smoke covers one heading text node only. M1 needs duplicate headings, nested nodes, missing headings, whole-chapter fallback, multi-segment blocks, and restart restoration.

### P1 — operability

1. A single `Mutex<Connection>` is adequate for Foundation calls but slow EPUB/Codex work must never hold it. Read context, release the database, perform external work, then reacquire for an atomic commit.
2. SQLite needs an explicit busy timeout and a documented concurrency policy before worker commands are added. WAL is optional and must be justified by tests rather than enabled by assumption.
3. The Web bundle remains about 603 kB minified. Lazy-loading EPUB/Feynman routes is desirable after correctness, not a blocker for the first vertical slice.
4. The six existing React lint warnings should be removed when the touched Reader/route lifecycle code is revised; do not suppress new warnings without a concrete external-system rationale.

## 3. Non-negotiable architecture decisions

- SQLite is the transactional source of truth. Markdown and git are replayable projections, never participants in a claimed cross-store ACID transaction.
- Every external or non-idempotent operation carries a stable operation/request ID. Retrying the same ID returns/resumes the existing result; it does not create a second session, turn, evaluation, book, or commit.
- Persist the user's turn before invoking Codex. On timeout/offline/error, keep the exact draft/turn and let retry reuse its request ID so the M1 "conversation is not lost" criterion is testable.
- The server owns the canonical transcript. The client sends a new turn plus expected session version, not an authoritative full transcript.
- Map edits use stable block IDs and optimistic map revision. Merge/split is an explicit operation union; skip remains a flag, never physical deletion.
- EPUB files live only below the managed books root. Import stages and validates before publication; ZIP bombs, unsafe paths, malformed container/package documents, duplicate slugs, and interrupted copy are explicit errors.
- Store normalized spine text and ordered anchor segments. A block may have one or more segments; each segment records precision (`exact` or `chapter_fallback`).
- Tauri commands stay transport-thin. Blocking SQLite/filesystem/process work runs off the WebView thread and no database guard is held while waiting for Codex, EPUB parsing, events, or git.
- Route errors remain scoped by resource/operation. Read results use generation invalidation; writes acquire a synchronous guard and retry only when server idempotency makes ambiguity safe.
- Logs may contain correlation/operation IDs and safe error codes, never EPUB text, transcript content, private paths, raw Codex output, or user settings.

## 4. Ordered implementation nodes

Each behavioral node uses RED → minimal GREEN → focused/full regression → rustfmt/lint/build → DEVLOG → atomic commit. Push each node after repository write access is restored. Do not tag `m1` until Node 12.

### Node 0 — finish the Foundation release gate

- Run `docs/smoke/mac-m1-native-smoke.md` on Apple Silicon with one fixture across both launches.
- Push the six local Foundation commits, verify core/Web/macOS jobs, review and merge `feat/mac-m1`, and tag the merge `mac-m1`.
- Rebase the product branch from that reviewed merge; do not build product M1 on an unverified native runtime.

**Gate:** every unchecked Foundation smoke item is green; remote branch/tag points are recorded.

### Node 1 — ADRs, contract v2, and schema v3

> **2026-09-05 状态**:Linux 加固切片已完成其中不依赖 ADR 的部分:v2 迁移收敛、v3 子表外键重建(孤儿回滚)、`book_single_active`、并发策略(busy_timeout + 读后写 IMMEDIATE)与两连接并发用例(H-T9a)。
> **2026-09-05 Plan A(A-T0/A-T1)**:ADR 0001–0004 已落档(`docs/adr/`,0004 Deferred);schema v4 追加式完成 spine 缓存、多段锚点(含 hint/text)、地图作业、AI 幂等表、会话状态/版本/幂等键、回合表、outbox,v3 行保留与外键/唯一用例齐备。契约 v2(TypeScript 侧)在 Plan B。

Create reviewed ADRs before code for:

1. native EPUB selection/staging transport (path capability versus bounded binary/channel transfer);
2. SQLite source-of-truth plus projection outbox/replay;
3. durable AI session/turn idempotency and cancellation semantics;
4. multi-segment EPUB anchor representation and map optimistic concurrency.

Then add migrations/models for spine cache, ordered block anchor segments, map revision/import state, durable session turns/requests, and projection outbox. Rebuild legacy child tables where required to add foreign keys and uniqueness without losing existing data. Migration must be one immediate transaction and remain reopen/concurrency safe.

**Tests:** v2→v3 fixture migration, rollback on corrupt legacy rows, FK/orphan rejection, uniqueness, multi-segment round-trip, pending-operation restart, two concurrent openers.

### Node 2 — secure EPUB acquisition spike and managed storage

- Prove the ADR's native file flow on Apple Silicon with a large fixture before finalizing the public Backend shape.
- Stage under an app-owned temporary/import directory with an operation ID; validate extension, MIME/container, size/entry limits, canonical paths, and package metadata.
- Derive internal slugs; never use title/author/user path as an unchecked filesystem component.
- Publish to `books/<book-id>.epub` only through a recoverable finalize step; duplicate retry returns the same book/import job.
- Return display metadata without exposing an arbitrary source path.

**Tests:** valid EPUB, malformed ZIP/container/package, traversal entry, oversized archive/entry count, duplicate retry, crash after staging and after DB commit, cleanup/recovery, non-UTF metadata.

### Node 3 — EPUB spine extraction and source APIs

- Follow the approved epub.js extraction direction unless Node 1 ADR explicitly changes `TECH_DESIGN.md` first.
- Persist ordered href/title/plain-text cache in bounded batches with import revision/checksum.
- Implement scoped managed-book URL and `blockSource` from stored ordered segments; validate every book/block relation.
- Never let a caller request an arbitrary local path.

**Tests:** three-book isolation, href normalization, chapter order, missing/corrupt resource, long chapter batching, reopen, URL scope escape attempts.

### Node 4 — harden Codex and add orchestration

> **2026-09-05 状态**:已完成 stderr 并发排空(有界 tail)、进程组终止(超时与正常退出)、错误尾部有界(H-T7)。
> **2026-09-05 Plan A(A-T2/A-T3)**:`validate`/`test_connection`、prompt 100 KiB 与输出 1 MiB 上限、`orchestrate` 同 ID 重放/accept 才记 done/传输重试 2 次/JSON 纠错一次、非 autocommit 拒绝——本节点 Linux 可做部分完成;Codex 设置项(bin/model)接线与脱敏日志留 Mac。

- Drain stderr concurrently into a bounded tail (or a bounded temporary file) while the child runs.
- Kill and reap the complete spawned process group on timeout/cancel; remove temporary output deterministically.
- Validate configured binary, working directory, sandbox, maximum prompt bytes, output bytes, and deadlines.
- Add orchestration-level retry: transport timeout/non-zero exit may retry with the same request ID; invalid JSON gets exactly one corrective retry. Do not retry validation/conflict errors.
- Add the Codex binary/model settings needed by product M1 and a safe "test connection" use case.

**Tests:** stderr larger than pipe capacity, non-zero tail truncation, descendant cleanup, timeout, empty output, oversized output, same-ID replay, JSON corrective retry exactly once, transcript/path redaction.

### Node 5 — two-stage knowledge-map generation

- Add strict chapter-candidate and merged-map schemas/prompts for each book type.
- Run per-chapter Stage A and aggregate Stage B without holding SQLite; persist job checkpoints and emit correlation-scoped progress.
- Validate dependencies, unique stable IDs/slugs, sequence, source references, and bounded block sizes before saving a draft map revision.
- Resume a failed/restarted job from durable checkpoints; retry never re-imports the book.

**Tests:** malformed/extra JSON, missing dependency, cycle, duplicate title/slug, partial chapter failure/resume, stale event ignored, cancellation/restart, three book-type prompt differences.

> **2026-09-05 Plan A(A-T4/A-T5)**:core 侧完成——三类书 Stage A/B prompt、严格 schema、`mapgen::run_map_job`(断点续跑、长章分片、草图校验、语义无效不记 done、候选压缩)。进度事件经 `MapProgress` 回调,Tauri event 发射与取消留 Mac;stale event 由前端 generation 处理(Plan B)。

### Node 6 — map confirmation, anchors, and memory initialization

> **2026-09-05 状态**:记忆库写入已改为临时文件 + fsync + rename,slug 白名单校验(H-T8)。
> **2026-09-05 Plan A(A-T6/A-T9)**:`map::apply_draft_map`/`confirm_map`(稳定 id、`expected_revision`、操作集 Rename/RenameModule/Reorder/SetSkipped/Merge,Split 留 Mac)、`slugify`、`set_anchor_segments`/`list_anchors`;`init_book`/`sync_map` 经 outbox 重放。剩余:小节标题 → CFI 解析(Plan B,JS)、手动校正 UI、Split。

- Replace `MapEditBlock[]` with a stable operation request containing `bookId`, expected map revision, stable block IDs, and explicit rename/reorder/skip/merge/split operations.
- Resolve source section headings into ordered CFI segments. Record whole-chapter fallback precision and expose manual correction; never pretend fallback is exact.
- Commit confirmed map, anchors, dependencies, skip flags, revision, and any plan invalidation atomically in SQLite.
- Enqueue deterministic memory initialization/projection; worker writes temp files, fsync/renames, commits git with operation ID, and marks the outbox row. Restart safely replays any unfinished projection.

**Tests:** stale revision conflict, status/score preservation, merge/split dependencies and anchors, fallback/manual correction, crash at every projection boundary, repeated operation ID, unsafe slug/title content.

### Node 7 — native reader and CFI lifecycle

- Implement `epubUrl`/`blockSource` against only confirmed managed content.
- Render and highlight every ordered segment, navigate between segments, and disclose fallback precision.
- Add `EpubView.onError` and teardown/generation handling for book open, navigation, locations, annotations, and route changes.
- Fix callback-ref lint warnings while touching the lifecycle and lazy-load the Reader/epub.js chunk if it does not complicate smoke reliability.

**Tests:** real managed EPUB, exact/fallback/multi-chapter anchors, duplicate/nested headings, corrupt URL/resource, rapid route switch, unmount during load, theme/size retention, back-to-session restoration.

### Node 8 — durable session and turn application services

- `startOrResumeSession(taskId, clientRequestId)` validates the daily task and returns the one open session plus canonical transcript/version.
- `submitTurn(sessionId, expectedVersion, clientTurnId, userText)` persists the user turn first, invokes Codex without a DB guard, then atomically appends one student reply or records retryable failure.
- Repeating a client request/turn ID returns the same session/reply. Different concurrent turns conflict by expected version.
- Abandon is an explicit state transition; Reader round-trip resumes, while a deliberate new attempt requires an explicit command.

**Tests:** double start, remount/resume, double send, concurrent version conflict, timeout/retry after persisted user turn, crash before/after Codex reply persistence, abandon/reopen, no raw client transcript trust.

> **2026-09-05 Plan A(A-T7)**:core 侧完成——`session::start_or_resume_session`/`get_session`/`submit_turn`/`abandon_session`/`fixed_context_for_block`,回合协议与重启续跑用例齐备。Tauri command 接线与前端水合在 Mac/Plan B。

### Node 9 — evaluation, verdict, task transition, and outbox

- `requestEvaluation(sessionId, requestId)` stores/reuses one strict evaluation result; JSON corrective retry uses the same request identity.
- `confirmSessionVerdict(sessionId, expectedVersion, requestId, pass)` is the sole atomic core transition for session end, block/scores, weak points/review schedule, and the linked daily task.
- Remove the frontend's `confirmVerdict` + generic `completeTask` two-call sequence. Keep generic completion unsupported so weak/review invariants cannot be bypassed.
- Enqueue and replay block/map/weakpoint Markdown projections and one git commit keyed by the verdict operation ID.

**Tests:** double confirm, crash/retry, pass/relearn, weak point fixed/open, new/weak/review task semantics, projection/git failure then restart replay, exactly one history entry and git commit.

> **2026-09-05 Plan A(A-T8/A-T9/A-T10)**:core 侧完成——`verdict::request_evaluation`/`confirm_session_verdict`(单事务、用户判定覆盖、任务类型分流、确认幂等)与 `projection::run_pending`(顺序重放、失败即停、failed 重试、跨崩溃幂等);端到端集成 `core/tests/m1_engine.rs`。前端去掉 confirmVerdict+completeTask 两调用与 `completeTask` 保持 unsupported 在 Plan B/Mac。

### Node 10 — Feynman UI operational recovery

> **2026-09-05 状态**:send/endTeaching/confirmVerdict/abandon 的隔离错误态、同步守卫、卸载失效已完成;confirmVerdict 成功而 completeTask 失败 → 回今日并显示后台同步提示(H-T5)。剩余:服务端会话水合、turn ID 幂等重试、草稿持久化(依赖 Node 8)。

- Hydrate from server session/transcript rather than clearing state on mount.
- Add isolated, state-preserving errors and synchronous guards for send, evaluation, verdict confirmation, and abandon.
- Preserve draft and canonical transcript on timeout; retry the same turn ID. Disable only the affected action.
- If verdict commit succeeds but projection is pending, return to Today with an explicit background-sync notice rather than resubmitting the verdict.
- Update stale "Mac stage" placeholders to the actual M1/M3 capability status.

**Tests:** every operation retryable/non-retryable failure, double click, late/unmount result, Reader round-trip, app restart, ambiguous committed response, no unhandled rejection/permanent spinner.

### Node 11 — basic tray lifecycle and queue integration

- Implement only the M1.1 basic tray/close behavior required for a usable local app. Notification scheduling and Rust Pomodoro remain M2.
- Define whether window close hides or quits; Cmd+Q must always perform an orderly shutdown and leave no Codex/import child behind.
- Ensure startup recovery runs migrations, import cleanup, session recovery, and projection replay before routes claim readiness.

**Tests/smoke:** hide/show, Cmd+Q, restart recovery, no orphan child, no duplicate daily queue/session/projection.

### Node 12 — product-M1 end-to-end gate

Use a real textbook EPUB and the real logged-in Codex CLI on Apple Silicon:

1. import and restart;
2. generate map, inspect progress, edit/confirm, and set target;
3. start today's new block, open the exact source, teach and deliberately expose one weak point;
4. exercise one Codex timeout/retry without losing the transcript;
5. request evaluation, confirm pass, and wait for memory projection/git commit;
6. Cmd+Q and relaunch; verify book/map/plan/task/session/settings and projection consistency;
7. advance the controlled test date and complete the weak-point retest at the head of the queue.

Run all core/Tauri/Web/Playwright tests, fmt, clippy, lint, production Web build, Tauri debug/release build, and a clean-user data-directory smoke. Inspect SQLite, Markdown, and git history against the same operation IDs. Review logs for content/path leakage.

**Release:** only after local smoke and remote CI are green, merge reviewed history and create annotated tag `m1`. Do not pull M2 notification/templates/stats or M3 voice/export/signing scope into this gate.

## 5. Definition of done for every node

- Tests demonstrate the failure before implementation and the behavior after it.
- Migrations and durable operations include reopen, retry, and injected-failure coverage.
- Public request/response shapes are mirrored in the shared wire contract and tested on Rust and TypeScript sides.
- Backend implementations remain substitutable; browser Mock tests and native unavailable/supported tests both pass.
- No new lint/clippy warnings, no permanent spinner, no unhandled rejection, no duplicate non-idempotent side effect.
- `DEVLOG.md`, affected authority docs, focused/full command results, commit hash, and remote CI URL are recorded.
- Worktree is clean and local/remote branch tips match before beginning the next node.

## 6. Explicitly deferred beyond product M1

- Whisper/voice, Obsidian export, git remote push/recovery UI, signing/DMG.
- M2 notification scheduling, Rust Pomodoro state machine, full statistics, three-type post-pass extensions, and complete spaced-review UX beyond the M1 weak retest.
- M3 reader bookmarks/typography polish, whole-book final evaluation, deletion recovery, and large-library performance work not required by the one-book M1 gate.
