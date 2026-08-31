# Mac Foundation Design

**Status:** Approved technical design  
**Date:** 2026-08-31  
**Branch:** `feat/mac-m1`  
**Product authority:** `PRODUCT_SPEC.md`  
**Technical authority:** `TECH_DESIGN.md`

## 1. Goal

Build the first native macOS vertical slice without changing approved product behavior:

- launch the existing React application inside a Tauri 2 shell;
- select `TauriBackend` in Tauri and keep `MockBackend` in a browser;
- read books and knowledge blocks, generate plans and daily queues through core rules, and persist the currently exposed settings in SQLite;
- expose those capabilities through a typed, testable IPC boundary;
- keep EPUB, Codex, memory-library writes, tray, notifications, voice, and export behind later capability seams.

The milestone is complete when the development app restarts without losing supported data and every existing route either renders real local data or presents an actionable Chinese unavailable state. Native code must never return mock domain data.

Mac Foundation is a technical prerequisite for product M1, not a replacement for it. It does not satisfy the M1 acceptance criteria in `IMPLEMENTATION_PLAN.md`; the `mac-m1` tag means the native contract/persistence base is ready, while the later `m1` tag still requires the full one-block learning loop.

The two documented risk checks remain ordered immediately after scaffolding: verify real `codex exec` arguments on this Mac and verify EPUB CFI generation/range restoration against the fixture. They are smoke-only here; production Codex and EPUB adapters remain out of scope.

## 2. Non-goals

This milestone does not invent or revise product behavior. It excludes:

- real EPUB import, metadata/text extraction, and CFI integration;
- real knowledge-map generation or editing;
- Codex-backed Feynman sessions and evaluation persistence;
- review/retest interaction redesign;
- tray, notifications, native Pomodoro, Whisper, Obsidian export, signing, and DMG distribution.

Unsupported operations return typed `not_implemented` errors instead of silently falling back to mock data.

## 3. Architecture

```text
React feature slices
    │ depend only on Backend
    ▼
TauriBackend (TypeScript transport adapter)
    │ invoke(command, DTO)
    ▼
Tauri commands (transport boundary)
    │ validate + translate only
    ▼
Application services (use-case coordination)
    │
    └── book_learner_core (domain rules, transactions, SQLite)
```

### 3.1 Frontend boundary

- `web/src/backend/types.ts` remains the only capability contract visible to pages.
- `web/src/backend/tauri.ts` implements it with `@tauri-apps/api/core.invoke`.
- `web/src/backend/index.ts` selects `TauriBackend` only in Tauri; browser tests and Vite development continue to use `MockBackend`.
- Transport DTO conversion and error normalization stay in `tauri.ts`; feature slices never import Tauri APIs.
- `web/src/lib/localDate.ts` becomes the only Today/Map/Feynman calendar-day helper.

### 3.2 Rust boundary

The new `src-tauri` crate depends on `core` through a local path:

```text
src-tauri/src/
├── lib.rs                  app builder and command registration
├── main.rs                 binary entrypoint only
├── state.rs                data paths and database resource
├── error.rs                stable IPC error serialization
├── dto/                    IPC request/response types
├── commands/               thin Tauri handlers
├── application/            use-case coordination
└── infrastructure/         SQLite connection factory only
```

`commands` contain no SQL or product rules. `application` does not depend on React field names. Product rules and SQL remain in `core`; `src-tauri/infrastructure` must not copy scheduler or persistence rules. `AppState` owns only resolved data paths and the database resource—no speculative provider slots.

### 3.3 Transaction ownership and connections

- If a core API is already atomic (`generate_daily`, `apply_eval_to_db`), application delegates without an outer transaction.
- New multi-statement product operations are implemented as atomic core APIs and own their transaction there.
- Application services coordinate calls but never form a second domain layer or nest core-owned transactions.
- No Tauri command exposes a raw `rusqlite::Connection`.
- `core::db::open/open_in_memory` are the only connection initialization entrypoints. Their fixed order is open → `PRAGMA foreign_keys=ON` → verify value `1` → migrate. `src-tauri/infrastructure` only resolves a path and calls `core::db::open`.
- Blocking database/filesystem work stays off the WebView event loop. Callers do not depend on mutex or pool details.

## 4. Contract and data model

### 4.1 Stable DTO rules

- TypeScript uses camelCase; Rust DTOs use snake_case internally and serialize with `#[serde(rename_all = "camelCase")]`.
- Database rows never cross IPC directly.
- IDs are signed 64-bit integers in Rust and validated safe integers in TypeScript.
- Dates crossing IPC are local calendar strings (`YYYY-MM-DD`), never UTC `toISOString()` dates.
- Unknown enum values produce a typed decode error rather than defaulting to another state.

### 4.2 Capability matrix

| Backend method | Mac-M1 status | Behavior / side effect |
|---|---|---|
| `listBooks` | supported | Read real SQLite books. |
| `setActiveBook` | supported | Core transaction makes one book/plan active and pauses the previous one. |
| `listBlocks`, `getBlock` | supported | Read real SQLite blocks; skipped rows are not silently deleted. |
| `setPlan` | supported | Validate and upsert one active plan through an atomic core API. |
| `todayQueue` | supported | Generate/read through core `generate_daily`; write-on-first-read is explicit. |
| `getSettings`, `saveSettings` | supported | Persist exactly `obsidianVault`, `pomodoroMinutes`, `breakMinutes`, `remindTime`; durations 1–180 and time `HH:mm`. |
| `importEpub`, `generateMap` | not implemented | Return `not_implemented`; Import shows a retry-safe unavailable state. |
| `confirmMap` | not implemented | Current request lacks stable block identity/version; no row mutation. |
| `completeTask` | not implemented | Never bypass learn/retest/review transitions. |
| `blockSource`, `epubUrl` | not implemented | Reader shows unavailable instead of loading forever. |
| session methods | not implemented | Feynman shows unavailable and creates no fake native session. |
| `stats` | not implemented | Full semantics belong to M2; Stats shows unavailable. |

`completeTask` must not become a generic status toggle. Later, a new-block task completes in the same core transaction as the user-confirmed verdict; weak/review tasks complete only through result-bearing core commands that update weak-point/review state.

Before `confirmMap` is implemented, its request must carry stable `blockId` plus an optimistic version or use an explicit operation union. Skip means `skipped=1`, not deletion; order, status, scores, anchors, dependencies, and plan recalculation commit together.

The TypeScript contract may be composed from smaller capability interfaces while still exporting `Backend`. Unsupported methods remain present and fail explicitly so capability drift cannot look like success.

Cross-runtime setting defaults have one source: `shared/app-defaults.json`. `web/src/config.ts` re-exports its behavior values and core embeds/deserializes the same file. Initial values are `~/Obsidian/book-learner`, work `25`, break `5`, and reminder `21:00`. `getSettings` fills missing keys from these defaults without persisting unrelated data; `saveSettings` validates first and writes all four keys atomically.

## 5. Data flow

### 5.1 Startup and data directory

1. Tauri resolves the platform data root and explicitly appends `book-learner`, yielding `~/Library/Application Support/book-learner/` on macOS.
2. The bundle identifier is `com.aba122.booklearner`; code does not use a bundle-ID-derived app-data directory.
3. The directory is created if absent.
4. `core::db::open(app.db)` performs the sole foreign-key/configuration/migration sequence.
5. `AppState` is registered before the window loads.
6. React detects Tauri and instantiates `TauriBackend`.

Startup failure is fatal and visible; the app never substitutes an in-memory database.

### 5.2 Reads and writes

For reads, the page calls `Backend`, `TauriBackend` invokes a stable command, the command validates transport input, application delegates to core, and DTOs return to the page.

For writes, the page sends a complete use-case request rather than SQL-shaped patches. Application validates use-case input and delegates transaction ownership to an atomic core API. The page reloads through `Backend` only after commit.

This milestone implements SQLite-only writes and makes no new cross-store atomicity claim. `TECH_DESIGN.md` §3.3 remains a later design concern; before SQLite/Markdown/Git orchestration, a dedicated ADR must define failure recovery, idempotency, and any migration.

## 6. Error handling and observability

All IPC failures use a stable payload:

```json
{
  "code": "db_unavailable",
  "message": "无法读取本地学习数据",
  "retryable": true,
  "details": null
}
```

Initial codes: `invalid_request`, `not_found`, `conflict`, `db_unavailable`, `io_failure`, `not_implemented`, `internal`.

- User messages are Chinese and actionable.
- Internal causes are logged with command name and correlation ID without leaking paths or transcripts to UI.
- Expected errors return `Result`; command handlers do not panic.
- `TauriBackend` preserves `code` and `retryable` for later centralized retry UI.
- No rejection may leave a permanent spinner. Route behavior is fixed as follows:

| Route | Error behavior |
|---|---|
| Today | Queue failure shows a full retry state. `stats` failure keeps the queue usable and shows a local unavailable notice. Failed `completeTask` keeps the task unchanged and shows an inline operation error. |
| Library | `listBooks` failure shows retry. Import `not_implemented` stays inside the wizard with the selected file retained and a close/retry-safe message. |
| Map | list failure shows retry. `confirmMap` failure preserves every edit and shows an inline unavailable message. |
| Reader | content/URL failure replaces the spinner with an unavailable state and a back action. |
| Feynman | task/session failure shows unavailable with a safe return action; no fake session is created. |
| Stats | `not_implemented` or runtime failure shows unavailable/retry rather than fabricated metrics. |
| Settings | load failure shows retry; save failure keeps form edits and shows a retryable inline error. |

## 7. Testing strategy

Behavioral changes follow red-green-refactor. Design/scaffold-only nodes use structure/build verification instead of artificial failing tests.

### 7.1 Rust

- DTO serialization, error mapping, date validation, and supported application-service unit tests;
- temporary-file SQLite integration tests including restart persistence;
- command-surface tests without launching a GUI;
- connection tests proving foreign keys reject orphan rows after first open and reopen;
- existing core tests remain green.

### 7.2 TypeScript

- shared contract tests only for capabilities both adapters support;
- separate Mock full-capability and Tauri explicit-unavailable tests;
- runtime selection, command name, payload casing, conversion, and error-normalization tests;
- local-calendar tests across UTC boundaries and at least Asia/Shanghai plus America/Los_Angeles DST cases;
- Today/Map tests for unsupported operations that preserve queue/edit state;
- Import, Reader, Feynman, and Stats unavailable-state tests;
- Library/Map/Today/Settings retryable and non-retryable runtime-error tests;
- fresh-database setting defaults, invalid-save no-partial-write, and save/reopen tests;
- existing feature tests remain green.

### 7.3 Native smoke

1. Prepare a temporary SQLite fixture through a debug/test data-directory override.
2. Rust application/command integration tests and a mocked-invoke `TauriBackend` harness read fixture books/blocks, save a plan, and generate a queue. Plan UI reachability is explicitly deferred because product flow opens it after the currently unsupported map confirmation.
3. In the native UI, read the fixture and save settings; quit and reopen to verify settings persistence and real data reads.
4. Verify production data resolves exactly to `~/Library/Application Support/book-learner/app.db`.
5. Verify browser Vite still uses mock data.
6. Verify web production and Apple Silicon Tauri debug builds.

## 8. Delivery and traceability

Delivery uses `feat/mac-m1` with independently verifiable nodes:

1. approved design and implementation plan;
2. Rust toolchain and Tauri scaffold;
3. real Codex-argument and EPUB-CFI smoke checks;
4. typed IPC/error foundation and local-calendar fix;
5. core database integrity and supported use cases;
6. TypeScript `TauriBackend`, runtime selection, and unavailable states;
7. native persistence smoke and documentation closeout.

These outputs feed product M1: the Tauri shell continues M1.1 but tray remains outstanding; database/command foundations continue M1.2 but unsupported capabilities remain outstanding; M1.3–M1.10 are not claimed by `mac-m1`.

For every behavioral node: observe the focused test fail, implement minimally, run focused/full regression, lint/build, record decisions in `DEVLOG.md`, make atomic commits, and push immediately to `origin/feat/mac-m1`.

CI adds a macOS Tauri debug-build job; local Apple Silicon native smoke is a merge hard gate. The milestone ends with PR review, merge to `main`, and a `mac-m1` tag.

## 9. Flexibility rules

- Product rules live in `core`, never transport adapters.
- Replaceable technology stays behind narrow providers/repositories when first needed.
- Feature slices import only composed `Backend` capabilities.
- DTOs are separate from persistence models and versionable.
- Visual values stay in `tokens.css`; behavior constants stay in `config.ts` until user-configurable.
- No command/component silently changes persisted behavior or falls back to mock data.
- Refactoring is limited to boundaries touched by this milestone.

## 10. Acceptance criteria

- Tauri launches on Apple Silicon and uses `~/Library/Application Support/book-learner/app.db`.
- Browser uses `MockBackend`; native uses `TauriBackend`.
- Supported library/block reads, active-book switch, plan/queue operations, and four settings use SQLite and survive restart.
- Unsupported import/map-edit/task-completion/EPUB/session/stats operations return typed errors, display route-level unavailable states, and never return native mock content.
- Foreign-key enforcement rejects orphan rows after first open and restart.
- Today, Map, and Feynman use one local calendar day across UTC boundaries and DST zones.
- Existing/new web and core tests pass; web production and Tauri debug builds pass.
- DEVLOG, architecture docs, commits, pushed branch, CI, PR, and tag provide an auditable history.
