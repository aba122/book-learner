# Mac Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the traceable `mac-m1` technical foundation: a native Tauri 2 shell, typed IPC, selected real SQLite use cases, explicit unsupported states, and restart persistence without changing approved product behavior.

**Architecture:** React feature slices continue to depend only on the composed `Backend` contract. `TauriBackend` translates that contract to typed Tauri commands; thin commands call application services, which delegate transactions and product rules to `book_learner_core`. Browser mode keeps `MockBackend`, and native mode never falls back to mock domain data.

**Tech Stack:** macOS 15/Apple Silicon, Rust stable, Tauri 2, React 18, TypeScript 5.9, Vite 7, Vitest 4, rusqlite, Playwright smoke testing, pnpm 11.

**Spec:** `docs/superpowers/specs/2026-08-31-mac-foundation-design.md`

**Official references:**

- Tauri existing-frontend setup: <https://v2.tauri.app/start/create-project/>
- Tauri commands, managed state, async work, and serializable errors: <https://v2.tauri.app/develop/calling-rust/>
- Tauri development configuration: <https://v2.tauri.app/develop/>
- Tauri GitHub pipelines: <https://v2.tauri.app/distribute/pipelines/github/>

---

## Global execution rules

- Work only in `/Users/wulinxie/Desktop/.worktrees/book-learner/feat-mac-m1` on `feat/mac-m1`.
- Preserve unrelated user changes; stop if the worktree is unexpectedly dirty.
- For every behavioral change: write one focused failing test, run it and confirm the expected failure, implement minimally, run focused and full regression tests, then refactor.
- Scaffold/docs steps use explicit build/structure checks rather than artificial failing tests.
- Update `DEVLOG.md` at every node with decisions, deviations, exact verification, and known gaps.
- After each task: `git diff --check`, focused tests, full relevant suites, build, atomic commit, and `git push origin feat/mac-m1`.
- Do not open a PR, merge `main`, or tag `mac-m1` until Task 9 passes.
- Do not implement product behavior excluded by the spec. Unsupported native methods must fail with `not_implemented`.

## File responsibility map

### Shared and frontend

- `shared/app-defaults.json`: cross-runtime settings defaults only.
- `shared/tauri-wire-contract.json`: command names, top-level payload keys, and unsupported capability names shared by Rust/TypeScript tests.
- `web/src/config.ts`: typed re-exports of shared defaults plus existing UI behavior constants.
- `web/src/lib/localDate.ts`: one local calendar-day formatter used by Today, Map, and Feynman.
- `web/src/backend/errors.ts`: stable frontend `BackendError` and rejected-invoke normalization.
- `web/src/backend/tauri.ts`: Tauri transport adapter only; no product rules.
- `web/src/backend/index.ts`: runtime selection only.
- `web/src/components/AsyncError.tsx`: reusable Chinese unavailable/retry presentation.
- `web/src/features/*`: route-specific state preservation and retry behavior only.

### Core

- `core/src/db.rs`: sole connection initialization and schema migrations.
- `core/src/models.rs`: strict book/block read models and queries.
- `core/src/library.rs`: atomic active-book switch.
- `core/src/planning.rs`: plan validation/upsert and daily queue entrypoint.
- `core/src/settings.rs`: four-key settings defaults, validation, and atomic persistence.
- `core/src/lib.rs`: module exports and transport-independent error variants.

### Tauri

- `web/src-tauri/src/state.rs`: resolved data path and guarded database resource.
- `web/src-tauri/src/error.rs`: serializable IPC error codes.
- `web/src-tauri/src/dto/`: camelCase wire types and strict conversions.
- `web/src-tauri/src/application/`: use-case coordination; no duplicated SQL/rules.
- `web/src-tauri/src/commands/`: thin registered commands.
- `web/src-tauri/src/lib.rs`: builder/setup/registration.
- `web/src-tauri/src/main.rs`: binary entry only.

---

### Task 0: Commit the approved implementation plan

**Files:**
- Create: `docs/superpowers/plans/2026-08-31-mac-foundation.md`

- [ ] **Step 1: Verify the plan is the only pending change**

```bash
git status --short --branch
git diff --check
```

Expected: only this plan is untracked after the already-pushed design commit.

- [ ] **Step 2: Commit and push the plan node**

```bash
git add docs/superpowers/plans/2026-08-31-mac-foundation.md
git diff --cached --check
git commit -m "docs: plan Mac foundation implementation"
git push origin feat/mac-m1
```

Expected: remote `feat/mac-m1` contains the exact reviewed execution plan before implementation begins.

---

### Task 1: Toolchain, Tauri scaffold, and macOS CI

**Files:**
- Modify: `web/package.json`
- Modify: `web/pnpm-lock.yaml`
- Modify: `web/vite.config.ts`
- Modify: `.gitignore`
- Modify: `.github/workflows/ci.yml`
- Create: `web/src-tauri/Cargo.toml`
- Create: `web/src-tauri/build.rs`
- Create: `web/src-tauri/tauri.conf.json`
- Create: `web/src-tauri/capabilities/default.json`
- Create: `web/src-tauri/src/main.rs`
- Create: `web/src-tauri/src/lib.rs`
- Modify: `DEVLOG.md`

- [ ] **Step 1: Verify/install prerequisites without changing source**

Run:

```bash
xcode-select -p
clang --version
command -v codex
codex --version
/Users/wulinxie/.cargo/bin/rustc --version
/Users/wulinxie/.cargo/bin/cargo --version
```

If Rust is absent, download the official installer to an explicit temporary path and run the minimal profile after approval:

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs -o /private/tmp/book-learner-rustup.sh
sh /private/tmp/book-learner-rustup.sh -y --profile minimal
```

Expected: Xcode CLI tools, Codex CLI, `rustc`, and `cargo` all report versions. Record versions in `DEVLOG.md`.

- [ ] **Step 2: Add Tauri dependencies and scripts**

Run from `web/`:

```bash
pnpm add @tauri-apps/api@^2
pnpm add -D @tauri-apps/cli@^2
```

Add scripts:

```json
{
  "scripts": {
    "tauri": "tauri",
    "tauri:dev": "tauri dev",
    "tauri:build:debug": "tauri build --debug --no-bundle"
  }
}
```

- [ ] **Step 3: Create the minimal native crate**

`web/src-tauri/Cargo.toml` must use `book_learner_core = { path = "../../core" }`, `tauri = "2"`, `serde`, `serde_json`, `thiserror`, `tracing`, `tempfile` as a dev-dependency, and `tauri-build = "2"`. Use library name `book_learner_app` and crate types `staticlib`, `cdylib`, `rlib`.

`web/src-tauri/src/lib.rs` initially contains only one health command and the builder:

```rust
#[tauri::command]
fn health_check() -> &'static str { "ok" }

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![health_check])
        .run(tauri::generate_context!())
        .expect("book-learner Tauri runtime failed");
}
```

`tauri.conf.json` requirements:

- identifier `com.aba122.booklearner`;
- product name `book-learner`;
- dev URL `http://127.0.0.1:1420`;
- `beforeDevCommand: pnpm dev --host 127.0.0.1`;
- `beforeBuildCommand: pnpm build`;
- `frontendDist: ../dist`;
- main window title `攻书`, default `1280×800`, minimum `960×640`;
- bundle disabled for Foundation debug builds.

Update Vite server to port `1420` with `strictPort: true`.

- [ ] **Step 4: Verify scaffold**

Run:

```bash
/Users/wulinxie/.cargo/bin/cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
/Users/wulinxie/.cargo/bin/cargo test --manifest-path ../core/Cargo.toml
/Users/wulinxie/.cargo/bin/cargo check --manifest-path src-tauri/Cargo.toml
pnpm exec vitest --run
pnpm build
pnpm tauri:build:debug
```

Expected: core tests pass, 27 web tests pass, web build and no-bundle Tauri debug build succeed.

- [ ] **Step 5: Add macOS CI**

Add a `mac-foundation` job on a supported GitHub macOS runner: checkout, stable Rust, Node/pnpm setup, frozen install, core tests, and `pnpm -C web tauri:build:debug`. Keep existing Linux core/web jobs.

- [ ] **Step 6: Record, commit, and push node**

```bash
git add .github .gitignore web/package.json web/pnpm-lock.yaml web/vite.config.ts web/src-tauri DEVLOG.md
git diff --cached --check
git commit -m "build(mac): scaffold Tauri foundation"
git push origin feat/mac-m1
```

---

### Task 2: Codex argument and EPUB CFI risk smokes

**Files:**
- Modify: `web/package.json`
- Modify: `web/pnpm-lock.yaml`
- Create: `web/playwright.config.ts`
- Create: `web/cfi-smoke.html`
- Create: `web/src/cfi-smoke.ts`
- Create: `web/e2e/cfi-smoke.spec.ts`
- Modify: `DEVLOG.md`

- [ ] **Step 1: Re-run the real Codex CLI smoke**

Run:

```bash
/Users/wulinxie/.cargo/bin/cargo test --manifest-path core/Cargo.toml codex_real_smoke -- --ignored --nocapture
```

Expected: `-C`, `--sandbox read-only`, and `--output-last-message` work with the installed Codex version. Record version, duration, and output outcome; do not change the product prompt based on one latency sample.

- [ ] **Step 2: Add Playwright and write the failing CFI round-trip test**

Run:

```bash
pnpm add -D @playwright/test
pnpm exec playwright install chromium
```

`playwright.config.ts` must use `testDir: './e2e'`, `baseURL: 'http://127.0.0.1:1421'`, and a Vite `webServer` command `pnpm dev --host 127.0.0.1 --port 1421` with the same URL. Verify a trivial page can open before judging the CFI RED result.

The test opens `cfi-smoke.html`, waits for `window.__CFI_SMOKE__`, and asserts:

```ts
expect(result.href).toBe('chap1.xhtml')
expect(result.cfi).toMatch(/^epubcfi\(/)
expect(result.restoredText).toBe('第一章 供给与需求')
```

Declare `window.__CFI_SMOKE__` in the test/harness type. Run `pnpm exec playwright test e2e/cfi-smoke.spec.ts`; expected RED must be the CFI result assertion/wait, not a missing browser or unreachable web server.

- [ ] **Step 3: Implement the minimum browser harness**

Use the real fixture and epub.js APIs:

```ts
const book = ePub('/fixtures/sample.epub')
try {
  await book.ready
  const section = book.spine.get('chap1.xhtml')
  if (!section) throw new Error('fixture spine chap1.xhtml missing')
  await section.load(book.load.bind(book))
  const heading = section.document.querySelector('h1')
  if (!heading) throw new Error('fixture h1 missing')
  const range = section.document.createRange()
  range.selectNodeContents(heading)
  const cfi = section.cfiFromRange(range)
  const restored = await book.getRange(cfi)
  window.__CFI_SMOKE__ = { href: section.href, cfi, restoredText: restored.toString() }
} finally {
  book.destroy()
}
```

Publish `{ href, cfi, restoredText: restored.toString() }` to the smoke page, then destroy the book.

- [ ] **Step 4: Verify GREEN and record limitations**

Run focused CFI smoke, full Vitest, and web build. Record exact CFI, restored text, browser version, and that multi-range/manual correction remain follow-up work.

- [ ] **Step 5: Commit and push node**

```bash
git add web/package.json web/pnpm-lock.yaml web/playwright.config.ts web/cfi-smoke.html web/src/cfi-smoke.ts web/e2e DEVLOG.md
git diff --cached --check
git commit -m "test(mac): verify Codex and EPUB CFI risks"
git push origin feat/mac-m1
```

---

### Task 3: Shared defaults, local calendar day, and typed frontend errors

**Files:**
- Create: `shared/app-defaults.json`
- Modify: `web/tsconfig.app.json`
- Modify: `web/vite.config.ts`
- Modify: `web/src/config.ts`
- Modify: `web/src/backend/mock.ts`
- Create: `web/src/lib/localDate.ts`
- Create: `web/src/lib/localDate.test.ts`
- Create: `web/src/backend/errors.ts`
- Create: `web/src/backend/errors.test.ts`
- Modify: `web/src/features/today/TodayPage.tsx`
- Modify: `web/src/features/map/MapPage.tsx`
- Modify: `web/src/features/feynman/FeynmanPage.tsx`
- Modify: `DEVLOG.md`

- [ ] **Step 1: Write RED tests for local dates**

Test `localCalendarDate(date)` with instants whose UTC date differs from their supplied local calendar parts. Run the same test file with `TZ=Asia/Shanghai` and `TZ=America/Los_Angeles`, including a DST transition day. Assert Today/Map/Feynman no longer contain `toISOString().slice(0, 10)`.

Expected RED: helper missing and pages still use UTC dates.

- [ ] **Step 2: Implement one local calendar helper**

```ts
export function localCalendarDate(date = new Date()): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}
```

Replace the three page-local helpers with this import. Keep product ordering and copy unchanged.

- [ ] **Step 3: Write RED tests for `BackendError` normalization**

Cover a structured invoke rejection, plain string, native `Error`, and unknown value. Desired API:

```ts
new BackendError({ code, message, retryable, details })
normalizeBackendError(value): BackendError
isBackendError(value, code?): boolean
```

- [ ] **Step 4: Implement shared defaults and errors**

Create defaults:

```json
{
  "obsidianVault": "~/Obsidian/book-learner",
  "pomodoroMinutes": 25,
  "breakMinutes": 5,
  "remindTime": "21:00"
}
```

Before implementation, add a RED test importing the missing `APP_DEFAULTS` export and asserting all four fields equal `MockBackend.getSettings()`.

Enable `resolveJsonModule`, include the imported external JSON in TypeScript's graph, and allow only the repository-level `shared/` directory through Vite `server.fs.allow`. `config.ts` exports a strongly typed `APP_DEFAULTS`, derives `POMODORO_DEFAULT`, and keeps other constants. `MockBackend` initializes all four setting fields from `APP_DEFAULTS`; no hardcoded duplicate remains.

- [ ] **Step 5: Verify and push node**

Run both timezone-focused tests, all Vitest tests, lint, and build. Then:

```bash
git add shared/app-defaults.json web/tsconfig.app.json web/vite.config.ts web/src/config.ts web/src/backend/mock.ts web/src/backend/errors.ts web/src/backend/errors.test.ts web/src/lib web/src/features/today/TodayPage.tsx web/src/features/map/MapPage.tsx web/src/features/feynman/FeynmanPage.tsx DEVLOG.md
git diff --cached --check
git commit -m "fix(web): unify local dates and backend errors"
git push origin feat/mac-m1
```

---

### Task 4: SQLite connection integrity and migration v2

**Files:**
- Modify: `core/src/db.rs`
- Modify: `core/src/lib.rs`
- Modify: `core/tests/lifecycle.rs` only if migration behavior changes its setup
- Modify: `DEVLOG.md`

- [ ] **Step 1: Write RED connection tests**

Add tests that:

- assert `PRAGMA foreign_keys` is `1` for memory DB;
- create a disk DB, close/reopen, and assert it remains `1`;
- attempt an orphan `knowledge_block.book_id` and assert a foreign-key violation;
- assert `PRAGMA user_version` becomes `2`;
- assert duplicate `study_plan.book_id` is rejected by `study_plan_one_per_book`.
- assert a second `active=1` plan is rejected by partial unique index `study_plan_single_active`.
- build a legacy v1 DB containing conflicting plans and assert v2 migration fails visibly without silently deleting rows.

Run focused DB tests; expected RED because foreign keys are disabled and schema version is 1.

- [ ] **Step 2: Implement the sole initialization sequence**

Refactor both open functions through private `configure(conn)`:

```rust
fn configure(conn: &Connection) -> rusqlite::Result<()> {
    conn.pragma_update(None, "foreign_keys", "ON")?;
    let enabled: i64 = conn.query_row("PRAGMA foreign_keys", [], |r| r.get(0))?;
    if enabled != 1 { return Err(rusqlite::Error::ExecuteReturnedResults); }
    migrate(conn)
}
```

Migration v2 creates `study_plan_one_per_book` and partial unique `study_plan_single_active ON study_plan(active) WHERE active=1`, then updates `user_version` only after success. Conflicting legacy data aborts startup for explicit repair; migration never silently chooses/deletes a plan. Do not add unrelated indexes.

- [ ] **Step 3: Verify full core regression**

```bash
cargo test --manifest-path core/Cargo.toml db::tests
cargo test --manifest-path core/Cargo.toml --all-targets
cargo clippy --manifest-path core/Cargo.toml --all-targets -- -D warnings
```

- [ ] **Step 4: Record, commit, push**

```bash
git add core/src/db.rs core/src/lib.rs core/tests/lifecycle.rs DEVLOG.md
git diff --cached --check
git commit -m "fix(core): enforce SQLite integrity on every connection"
git push origin feat/mac-m1
```

---

### Task 5: Core library, planning, and settings use cases

**Files:**
- Modify: `core/src/lib.rs`
- Modify: `core/src/models.rs`
- Create: `core/src/library.rs`
- Create: `core/src/planning.rs`
- Create: `core/src/settings.rs`
- Create: `core/tests/foundation.rs`
- Modify: `DEVLOG.md`

- [ ] **Step 1: Write RED read-model tests**

Desired APIs:

```rust
models::list_books(&Connection) -> Result<Vec<Book>>
models::get_block(&Connection, block_id) -> Result<KnowledgeBlock>
```

Assert stable ordering, strict book type/status conversion, parsed scores, not-found error, and preservation of block IDs/status after reopen.

- [ ] **Step 2: Implement minimal strict read models**

Add transport-independent `Book` and extend `KnowledgeBlock` only with fields needed by the current frontend. Add `CoreError::{InvalidInput, NotFound, Conflict}` so application code does not parse error strings.

- [ ] **Step 3: Write RED active-book tests**

`library::set_active_book` must atomically:

- reject missing book without changes;
- set target book `active`;
- pause previous active book;
- deactivate previous plans and activate target plan if present;
- roll back every change on failure.
- preserve “at most one active book and one active plan” after reopen with two books/two plans.

- [ ] **Step 4: Implement active-book core transaction**

Keep all SQL and invariants in `core/src/library.rs`; application/Tauri code only delegates.

- [ ] **Step 5: Write RED plan tests**

`planning::set_plan` validates book existence, `YYYY-MM-DD`, positive daily count, cap, and `HH:mm`; then upserts by book ID atomically. If the target book is currently active, the same transaction first deactivates every other plan and upserts the target with `active=1`; otherwise it upserts with `active=0`. Test invalid input and injected/constraint failure leave all rows unchanged. With two books/two plans, close/reopen and assert at most one active plan. Expose `planning::today_queue` as the named delegate to `sched::generate_daily` without adding an outer transaction.

- [ ] **Step 6: Implement plan APIs minimally**

Reuse `chrono::NaiveDate` and one time-validation helper. Do not add deadline auto-adjust behavior here.

- [ ] **Step 7: Write RED settings tests**

Test fresh defaults from `shared/app-defaults.json`, invalid durations/time, atomic four-key save, and save/reopen. Verify a missing single key falls back without rewriting the DB.

- [ ] **Step 8: Implement settings**

Embed the shared JSON with `include_str!("../../shared/app-defaults.json")`; parse it once per call or with a standard-library `OnceLock`. Validate all fields before opening a transaction, then upsert four rows and commit.

- [ ] **Step 9: Verify and push node**

Run focused tests, all core tests, clippy, and formatting. Commit:

```bash
git add core/src/lib.rs core/src/models.rs core/src/library.rs core/src/planning.rs core/src/settings.rs core/tests/foundation.rs DEVLOG.md
git diff --cached --check
git commit -m "feat(core): add Mac foundation use cases"
git push origin feat/mac-m1
```

---

### Task 6: Rust application services, DTOs, commands, and data path

**Files:**
- Create: `web/src-tauri/src/error.rs`
- Create: `web/src-tauri/src/state.rs`
- Create: `web/src-tauri/src/dto/mod.rs`
- Create: `web/src-tauri/src/application/mod.rs`
- Create: `web/src-tauri/src/commands/mod.rs`
- Modify: `web/src-tauri/src/lib.rs`
- Create: `web/src-tauri/tests/foundation.rs`
- Create: `web/src-tauri/examples/seed_smoke.rs`
- Create: `shared/tauri-wire-contract.json`
- Modify: `.github/workflows/ci.yml`
- Modify: `DEVLOG.md`

The wire contract is fixed before code:

| Backend method | Command | JS top-level payload | Rust handler parameter | Response |
|---|---|---|---|---|
| `listBooks` | `library_list_books` | `{}` | state only | `Vec<BookDto>` |
| `setActiveBook` | `library_set_active_book` | `{ bookId }` | `book_id: i64` | `()` |
| `listBlocks` | `map_list_blocks` | `{ bookId }` | `book_id: i64` | `Vec<KnowledgeBlockDto>` |
| `getBlock` | `map_get_block` | `{ blockId }` | `block_id: i64` | `KnowledgeBlockDto` |
| `setPlan` | `planning_set_plan` | `{ request: StudyPlanRequest }` | `request: StudyPlanRequest` | `()` |
| `todayQueue` | `planning_today_queue` | `{ date }` | `date: String` | `Vec<DailyTaskDto>` |
| `getSettings` | `settings_get` | `{}` | state only | `AppSettingsDto` |
| `saveSettings` | `settings_save` | `{ settings: AppSettingsDto }` | `settings: AppSettingsDto` | `()` |
| unsupported methods | `unsupported_capability` | `{ capability }` | `capability: String` | error only |

Unsupported capability strings are exactly: `importEpub`, `generateMap`, `confirmMap`, `completeTask`, `blockSource`, `epubUrl`, `startSession`, `studentReply`, `endSession`, `confirmVerdict`, `stats`. `ErrorCode` serializes in snake_case. `health_check` is removed when this surface is registered.

- [ ] **Step 1: Write RED error/DTO tests**

Test camelCase JSON for Book, KnowledgeBlock, DailyTask, StudyPlan request, and AppSettings. Test mapping of core invalid/not-found/conflict/DB/IO errors into:

```rust
IpcError { code: ErrorCode, message: String, retryable: bool, details: Option<Value> }
```

Expected RED: modules missing.

Create `shared/tauri-wire-contract.json` from the table above and make both Rust and TypeScript tests load it, so command/payload/capability drift fails in both suites.

- [ ] **Step 2: Implement DTOs and serializable errors**

Use `#[serde(rename_all = "camelCase")]` and `#[serde(rename_all = "snake_case")]` for `ErrorCode`. Parse stored scores strictly; a corrupt value is `internal`, not silently discarded. Chinese messages are stable; internal causes are logged, not serialized as `details` by default.

- [ ] **Step 3: Write RED AppState/application persistence tests**

Use `tempdir` to open AppState, insert a fixture through core, call each supported service, drop state, reopen, and verify:

- books/blocks read;
- active switch;
- plan upsert and queue generation;
- settings save/reload;
- foreign keys remain enabled.

Also assert production path resolver appends exactly `book-learner/app.db`; a `#[cfg(debug_assertions)]` `BOOK_LEARNER_DATA_DIR` override accepts only an explicit absolute path. Production builds ignore the environment variable.

- [ ] **Step 4: Implement AppState and application services**

Expose a narrow `with_connection` method that maps mutex poisoning to `internal`. Each service obtains one connection guard and delegates to core. Do not copy SQL into `src-tauri`.

In Tauri setup, use `app.path().data_dir()?`, append `book-learner`, call `create_dir_all`, then append `app.db`; do not call `app_data_dir()`. Keep path resolution as a pure tested function before wiring it to `AppHandle`.

Add an atomic correlation counter to `AppState`. Every command runs through one helper that assigns `mac-<process>-<counter>`, and on error emits a structured `tracing` event containing only `command`, `correlation_id`, `error_code`, and an internal cause string. `IpcError` serialization must exclude the internal cause. Test generation monotonicity, required log fields, and that serialized UI errors contain neither DB paths nor transcript fixtures.

- [ ] **Step 5: Write RED command-surface tests**

Test plain inner command functions without GUI state. Supported command names:

```text
library_list_books
library_set_active_book
map_list_blocks
map_get_block
planning_set_plan
planning_today_queue
settings_get
settings_save
unsupported_capability
```

`unsupported_capability` always returns code `not_implemented` and includes the capability name only in safe details.

- [ ] **Step 6: Implement and register thin commands**

Use `#[tauri::command(async)]` consistently for the short blocking handlers so borrowed `State` remains supported by the macro while execution leaves the main thread. Register every command in one `generate_handler!` call. Setup resolves data dir as specified above, opens AppState, and fails startup rather than using memory fallback.

In addition to inner-function tests, Rust and TypeScript load the same `shared/tauri-wire-contract.json` and assert the table's command names/top-level keys. Cover `planning_set_plan`, `planning_today_queue`, and `settings_save` request deserialization explicitly.

- [ ] **Step 7: Add explicit smoke seeder**

`seed_smoke.rs` accepts one absolute directory argument, creates `app.db`, inserts one book/three blocks/one plan idempotently, and prints the exact path. It is an example binary only and is never registered as an app command.

- [ ] **Step 8: Verify and push node**

Update the macOS CI job to run `cargo test --manifest-path web/src-tauri/Cargo.toml --all-targets` and `cargo clippy --manifest-path web/src-tauri/Cargo.toml --all-targets -- -D warnings` before the debug build. Run core/Tauri tests, clippy, format, web tests/build, and Tauri debug build locally. Then:

```bash
git add shared/tauri-wire-contract.json web/src-tauri .github/workflows/ci.yml DEVLOG.md
git diff --cached --check
git commit -m "feat(mac): expose typed SQLite application commands"
git push origin feat/mac-m1
```

---

### Task 7: `TauriBackend` adapter and runtime selection

**Files:**
- Create: `web/src/backend/tauri.ts`
- Create: `web/src/backend/tauri.test.ts`
- Modify: `web/src/backend/index.ts`
- Create: `web/src/backend/index.test.ts`
- Modify: `web/src/backend/types.ts` only if capability interfaces are composed without changing public methods
- Modify: `DEVLOG.md`

- [ ] **Step 1: Write RED supported-adapter tests**

Inject an `InvokeFn` into `TauriBackend` and assert exact command names/payloads for all supported methods. Return fixture wire objects and assert safe-integer IDs, enum values, optional scores, and settings decode into existing frontend types.

Load `shared/tauri-wire-contract.json` and assert every adapter command and top-level payload key matches the Rust-side fixture.

- [ ] **Step 2: Write RED error and unsupported tests**

Assert structured rejections become `BackendError`. Every unsupported method must call `unsupported_capability` with a stable capability string; it must never instantiate/call `MockBackend`.

- [ ] **Step 3: Implement `TauriBackend` minimally**

Use `invoke` from `@tauri-apps/api/core`; keep all decode helpers private or in a focused transport module if the file exceeds roughly 250 lines. Do not add product rules or retry loops.

- [ ] **Step 4: Write RED runtime-selection tests**

Export a pure factory:

```ts
export function createBackend(isTauri = isTauriRuntime()): Backend
```

Assert browser returns `MockBackend`, Tauri returns `TauriBackend`, and no warning/fallback occurs.

- [ ] **Step 5: Implement selection and verify**

Run adapter/selection tests, all Vitest, lint, build, Rust suites, and Tauri debug build.

- [ ] **Step 6: Commit and push node**

```bash
git add web/src/backend/tauri.ts web/src/backend/tauri.test.ts web/src/backend/index.ts web/src/backend/index.test.ts web/src/backend/types.ts DEVLOG.md
git diff --cached --check
git commit -m "feat(web): connect typed Tauri backend"
git push origin feat/mac-m1
```

---

### Task 8: Seven-route error and unavailable states

**Files:**
- Create: `web/src/components/AsyncError.tsx`
- Create: `web/src/components/AsyncError.test.tsx`
- Modify: `web/src/features/today/TodayPage.tsx`
- Modify: `web/src/features/today/today.test.tsx`
- Modify: `web/src/features/library/LibraryPage.tsx`
- Modify: `web/src/features/library/ImportWizard.tsx`
- Modify: `web/src/features/library/library.test.tsx`
- Modify: `web/src/features/map/MapPage.tsx`
- Modify: `web/src/features/map/map.test.tsx`
- Modify: `web/src/features/reader/ReaderPage.tsx`
- Modify: `web/src/features/reader/reader.test.tsx`
- Modify: `web/src/features/feynman/FeynmanPage.tsx`
- Modify: `web/src/features/feynman/feynman.test.tsx`
- Modify: `web/src/features/stats/StatsPage.tsx`
- Create: `web/src/features/stats/stats.test.tsx`
- Modify: `web/src/features/settings/SettingsPage.tsx`
- Modify: `web/src/features/settings/settings.test.tsx`
- Modify: `DEVLOG.md`

- [ ] **Step 1: Implement shared presentation through RED tests**

`AsyncError` accepts `BackendError`, optional retry callback, and compact/full variants. Test Chinese message, accessible alert semantics, and that retry renders only when `error.retryable === true` and a callback exists. Keep it presentation-only.

Every route follows this matrix:

| Route | Retryable error | Non-retryable/not implemented | State preserved |
|---|---|---|---|
| Today | retry queue/stats/operation request | message only | loaded queue and task status |
| Library/Import | retry list/import attempt | message/close only | selected EPUB file |
| Map | retry list/confirm attempt | message only | edit order, skips, names |
| Reader | retry content load | back only | route/task context |
| Feynman | retry initialization only before a session exists | safe return only | no fake/duplicate session |
| Stats | retry runtime query | unavailable, never zero metrics | none fabricated |
| Settings | retry load/save | message only | edited form values |

- [ ] **Step 2: Today RED→GREEN**

Test both retryable and non-retryable queue failures, stats failure with usable queue, and `completeTask` failure retaining the task. Retry clears the old error only when the correct request is reissued. Implement separate `queueError`, `statsError`, and operation error states; do not collapse independent requests into `Promise.all`.

- [ ] **Step 3: Library/Import RED→GREEN**

Test retryable/non-retryable list failures and import `not_implemented` preserving the selected file inside the wizard. Implement try/catch/finally and reset stale errors only on a new attempt or close.

- [ ] **Step 4: Map RED→GREEN**

Test retryable/non-retryable list errors and `confirmMap` failure preserving edits/order/skips. A retry reissues only `confirmMap` with the same edit snapshot. Implement inline error near confirm actions. Do not add the product goal-entry shortcut deferred by the spec.

- [ ] **Step 5: Reader/Feynman RED→GREEN**

Test content/session failures replace loading states with back actions. Ensure abandoned/failed initialization does not call later session methods.

- [ ] **Step 6: Stats/Settings RED→GREEN**

Stats separately tests `not_implemented` with no zero metrics and retryable runtime failure. Settings tests retryable/non-retryable load and save; failed save keeps edits, retry reuses current edited values, and successful retry clears the error.

- [ ] **Step 7: Verify the whole web contract**

Run all focused files, full Vitest, lint, and build. Existing browser Mock happy paths must remain green.

- [ ] **Step 8: Commit and push node**

```bash
git add web/src/components/AsyncError.tsx web/src/components/AsyncError.test.tsx web/src/features/today web/src/features/library web/src/features/map web/src/features/reader web/src/features/feynman web/src/features/stats web/src/features/settings DEVLOG.md
git diff --cached --check
git commit -m "feat(web): add real-backend error states"
git push origin feat/mac-m1
```

---

### Task 9: Native persistence smoke, documentation, and release gate

**Files:**
- Modify: `CLAUDE.md`
- Modify: `TECH_DESIGN.md`
- Modify: `web/ARCHITECTURE.md`
- Modify: `DEVLOG.md`
- Modify: `docs/superpowers/plans/2026-08-31-mac-foundation.md` (check completed steps)
- Create: `docs/smoke/mac-m1-native-smoke.md`

- [ ] **Step 1: Update authority and closeout documentation**

Mark Mac Foundation complete in `CLAUDE.md`, document actual command/DTO locations in `TECH_DESIGN.md`, keep product M1 unchecked, update `web/ARCHITECTURE.md`, append final DEVLOG evidence/deviations, and draft `docs/smoke/mac-m1-native-smoke.md` with pending result slots.

- [ ] **Step 2: Fresh full automated verification**

Run:

```bash
cargo fmt --manifest-path core/Cargo.toml -- --check
cargo fmt --manifest-path web/src-tauri/Cargo.toml -- --check
cargo test --manifest-path core/Cargo.toml --all-targets
cargo clippy --manifest-path core/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path web/src-tauri/Cargo.toml --all-targets
cargo clippy --manifest-path web/src-tauri/Cargo.toml --all-targets -- -D warnings
pnpm -C web exec vitest --run
pnpm -C web lint
pnpm -C web build
pnpm -C web tauri:build:debug
pnpm -C web exec playwright test e2e/cfi-smoke.spec.ts
```

Expected: zero test/build/lint errors. Existing known bundle-size warning may remain documented.

- [ ] **Step 3: Prepare explicit native fixture**

```bash
mkdir -p /private/tmp/book-learner-mac-m1-smoke
cargo run --manifest-path web/src-tauri/Cargo.toml --example seed_smoke -- /private/tmp/book-learner-mac-m1-smoke
```

Verify printed DB path is exactly `/private/tmp/book-learner-mac-m1-smoke/app.db`.

- [ ] **Step 4: Run native Apple Silicon smoke**

Launch with an interactive terminal:

```bash
BOOK_LEARNER_DATA_DIR=/private/tmp/book-learner-mac-m1-smoke pnpm -C web tauri dev
```

Record:

- native runtime selects `TauriBackend`;
- Library/Map read fixture data;
- unsupported Import/Reader/Feynman/Stats show actionable states, no mock values;
- Settings save survives quit/relaunch;
- browser `pnpm dev` still shows Mock happy path;
- production run without override resolves `~/Library/Application Support/book-learner/app.db`.

Quit through macOS Cmd+Q, verify the process exits, relaunch with the same command, and recheck saved settings. Do not use a forced kill for the persistence assertion.

Capture commands and results in `docs/smoke/mac-m1-native-smoke.md`; do not commit private paths beyond the documented canonical/temp paths or user data.

- [ ] **Step 5: Re-run document and repository checks**

Fill the smoke result slots with commands/evidence, check every design acceptance criterion, then run:

```bash
git diff --check
git status --short --branch
```

- [ ] **Step 6: Final commit and push**

```bash
git add CLAUDE.md TECH_DESIGN.md web/ARCHITECTURE.md DEVLOG.md docs/smoke/mac-m1-native-smoke.md docs/superpowers/plans/2026-08-31-mac-foundation.md
git diff --cached --check
git commit -m "docs: close Mac foundation milestone"
git push origin feat/mac-m1
```

- [ ] **Step 7: Verify remote CI**

Verify Linux core/web and macOS Tauri jobs, including native tests and clippy, are green on the pushed commit. If a job fails, diagnose and fix through a new red-green commit; do not amend pushed node history.

- [ ] **Step 8: PR and tag gate**

Only after fresh verification and CI:

1. open PR `feat/mac-m1 → main` with node commits and smoke evidence;
2. review the complete diff against the design acceptance criteria;
3. merge without rewriting the auditable node history;
4. create/push annotated tag `mac-m1` on the merge commit;
5. do not mark product M1 complete.
