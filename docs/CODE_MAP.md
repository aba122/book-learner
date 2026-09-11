# 攻书 book-learner 代码地图与定位手册

> 用途:产品测试阶段(2026-09-08 起)发现问题后,按「症状 → 定位表」找到层次与文件,再看对应模块章节与诊断工具箱,做到最小改动修复。以 main `f77fb6d`(M3 收官 tag `m3` + PDF 过渡 + Finder PATH 修复)为准;文中不写行号,只写文件与函数名,便于长期有效。

## 0. 三层架构与一条主链路

```
React/TS(web/src)  ──IPC(命令名 + camelCase JSON;二进制走原始体+头)──▶  Tauri 壳(web/src-tauri/src)  ──▶  core crate(core/src)
   页面/状态/EPUB 抽取/录音                     命令表 commands/mod.rs → application/mod.rs        SQLite 用例 + AI 编排 + 记忆库投影
   Mock 后端(浏览器开发)                        DTO/错误映射/导入暂存/语音/托盘/通知线程             codex 子进程 / git 子进程
```

- **唯一事实源是 SQLite**(`app.db`);记忆库 `memory/*.md` 与 git 只是 `projection_outbox` 驱动的可重放投影(ADR-0001)。任何"页面显示了但 md 没变"的问题都先查 outbox。
- **AI 调用全部幂等**(ADR-0002):每次调用有 `ai_request.request_id`,同 id 重放不重跑;前端重试是"同 id 再发",不是新请求。
- **一条主链路**:导入 EPUB(分块 → 校验 → 落盘)→ JS 抽取 spine 文本 → `store_spine` → 两阶段地图作业(codex 逐章 + 合并)→ 草图落库(块 + 锚点)→ 用户编辑定稿 → 设目标 → 今日队列(重考 → 复习 → 新块)→ 费曼会话(回合幂等)→ 评估 JSON → 用户判定(单事务:块状态 + 复习排期 + 薄弱点 + outbox)→ 投影重放写 md + git commit(+ push 通道)→ 附加环节 / 间隔复习 / 薄弱点重考 → 全部通过后整书终评 → 学习报告 → 导出 Obsidian。

## 1. 症状 → 定位表

| 症状(用户看到的) | 首先查 | 代码入口 |
|---|---|---|
| 书架删除书失败/删后记忆库目录还在 | `projection_outbox` `remove_book` 行;删前快照在 `snapshots/` | `core/src/library.rs` `delete_book`;`core/src/memory.rs` `remove_book`;壳层 `application::delete_book` |
| 导入向导「导入未完成 · 请求内容无效」 | 文件不是 EPUB(PDF 直选)/zip 结构异常;`import.rs` 校验 | `web/src-tauri/src/import.rs` `validate_epub` / `finalize`;向导 `web/src/features/library/ImportWizard.tsx` |
| 导入停在「正在生成知识地图」或报「AI 暂时没有回应」 | `ai_request` 表最新一行的 `error`(codex 退出码/超时/解析失败);`map_job.stage/error` | `core/src/mapgen.rs` `run_map_job`;codex 启动 `core/src/ai.rs`;PATH 问题见 §9 |
| 地图页空/块数为 0 | `book.import_state`(ready/extracted/mapped)、`knowledge_block` 行数、`map_job` | `core/src/map.rs` `apply_draft_map`;`web/src/features/map/MapPage.tsx` |
| 「确认定稿」报冲突 | `book.map_revision` 与前端 `expectedRevision` 不一致(多窗口/重试) | `core/src/map.rs` `confirm_map` |
| 今日队列没有任务/任务不对 | `daily_task`(当日行)、`study_plan.active`、`review_schedule.due_date`、`weak_point.status` | `core/src/sched.rs` `generate_daily`;`core/src/planning.rs` `today_queue` |
| 弹「进度落后」或配额被自动改 | `check_behind` 规则(§5「落后检测」) | `core/src/sched.rs` `check_behind` |
| 费曼页一直「学生思考中」 | 窗口是否在后台(WebView 节流);`ai_request` `turn:*` 行;`session_turn.status` | `core/src/session.rs` `submit_turn`;前端 `web/src/features/feynman/FeynmanPage.tsx` + `web/src/lib/useBackendOperation.ts` |
| 发送按钮无反应 | 渐显未结束(`▍`)、`inputLocked`、pendingTurn 未重试 | `FeynmanPage.tsx`(inputLocked 条件) |
| 「结束讲授」后评估失败/可重试 | `ai_request` `eval:*`;`feynman_session.state` 应回 `open` | `core/src/verdict.rs` `request_evaluation`;`core/src/eval.rs` `parse_eval` |
| 确认判定报「数据已被更新」 | `feynman_session.version` 与前端 `expectedVersion` | `core/src/verdict.rs` `confirm_session_verdict` |
| 判定后 `memory/` 没更新、git 没提交 | `projection_outbox` 有 `failed` 行(`error`);main 通道失败即停 | `core/src/projection.rs` `run_pending`;`core/src/memory.rs` |
| git 推送失败 | `projection_outbox` `lane='push'` 行、`next_retry_at`;远程需先在终端完成凭据 | `core/src/projection.rs` `run_push_lane`;`core/src/memory.rs` `push/set_remote` |
| 通知没弹/重复弹 | 必须 bundle 运行;`setting` 表 `notified:<kind>:<date>`;提醒时间键 | `core/src/notify.rs`;壳层 `notify.rs` 轮询线程 |
| 番茄钟托盘不走/分钟不落库 | Rust 状态机;`study_minutes` | `core/src/pomodoro.rs`;壳层 `pomodoro.rs` |
| 🎙 报权限/无模型/转写空 | TCC(从 Finder/`open` 启动)、设置页模型是否已导入(`setting.voiceModel`、`models/`) | `web/src/audio/pcm.ts`、`web/src/features/feynman/VoiceInput.tsx`;壳层 `voice.rs` |
| 导出 Obsidian 目录不存在/文件不对 | 设置 `obsidianVault` 必须是已存在的绝对目录 | `core/src/export.rs` `plan/write`;壳层 `application::expand_home` |
| 快照/恢复不生效 | `snapshots/`、`restore-pending.json`;恢复在**下次启动前**应用 | `core/src/backup.rs`;壳层 `lib.rs` `initialize_state` |
| 阅读器空白/骨架不消失 | 窗口后台节流;`library_epub_url` 返回的路径是否存在于 `books/` | `web/src/features/reader/EpubView.tsx`;壳层 `application::epub_url` |
| 高亮/书签/位置丢失 | `reader_mark` 表 | `core/src/reader_marks.rs`;`web/src/features/reader/ReaderPage.tsx` |
| 终评入口不出现 | 所有未跳过块须 `passed/consolidated` | `core/src/final_exam.rs` `eligible` |
| 统计数字不对 | 统计全部按 `date` 由前端本地日历日给出 | `core/src/stats.rs`;`web/src/lib/localDate.ts` |
| 设置保存失败 | 五个键的校验;`codexBin`/`voiceModel` 不在 `AppSettings` 里 | `core/src/settings.rs`;壳层 `application::codex_bin_set` |

## 2. 诊断工具箱

**数据目录**(release):`~/Library/Application Support/book-learner/`;debug 构建可用 `BOOK_LEARNER_DATA_DIR=<绝对路径>` 覆盖。内容:`app.db`、`books/<book_id>.epub`(文件名是 book id 不是 slug)、`import/`(分块暂存)、`memory/`(git 仓库)、`models/`(whisper)、`snapshots/`、`logs/`、`restore-pending.json`。

**测试阶段套件**:缺陷台账 `docs/testing/BUGS.md`(编号 BL-xxx、级别、根因、修复 PR、回归用例)、报告模板 `docs/testing/BUG_TEMPLATE.md`、测试清单 `docs/testing/TEST_PLAN.md`;用户报 bug 先跑一键诊断包 `docs/smoke/scripts/diag-bundle.sh`(日志 + `app.db` 只读快照 + 关键表导出 + 版本信息 → 桌面 zip);发版批次见 `CHANGELOG.md`。

**看日志**:`<数据目录>/logs/app.log.YYYY-MM-DD`(按天滚动、保留 14 天;设置页「诊断」→「打开日志目录」)。每条 IPC 命令一行 info(`command / correlation_id / elapsed_ms / outcome`),失败另带 `internal_cause`;前端事件 target=`client`(window.error / unhandledrejection / console.error / 路由 `route path=`);启动首行有 `version / git_sha / built_at`。`RUST_LOG` 可调级别。代码在 `web/src-tauri/src/diagnostics.rs`、`web/src/lib/clientLog.ts`。

**SQLite 只读速查**(把 `$DB` 换成 `~/Library/Application\ Support/book-learner/app.db`,务必 `-readonly`):
```sql
-- AI 调用最近失败原因(导入/回合/评估/终评都在这)
select request_id,kind,status,attempts,substr(error,1,200) from ai_request order by rowid desc limit 5;
-- 地图作业断点
select job_id,stage,next_chapter,substr(error,1,200) from map_job order by rowid desc limit 3;
-- 会话与回合
select id,kind,state,version,task_id,book_id,extra_kind from feynman_session order by id desc limit 5;
select session_id,seq,role,status,substr(text,1,60) from session_turn order by session_id desc,seq desc limit 10;
-- 投影是否卡住
select id,kind,lane,status,attempts,substr(error,1,120),next_retry_at from projection_outbox where status<>'done' order by id;
-- 今日队列与计划
select * from daily_task where date=date('now','localtime') order by seq;
select * from study_plan; select id,title,status,import_state,map_revision from book;
-- 设置直读键
select * from setting;
```

**桥驱动(debug 构建)**:`BOOK_LEARNER_AUTOMATION_SOCK=<sock>` 启动后用 `docs/smoke/scripts/bl-auto.py <sock> js|text|go|click|type|file|wait|waitgone|tray|quit`,标准脚本骨架见 `docs/smoke/scripts/gate-m3.sh`;驱动前先把窗口置前(后台 WebView 被节流)。正式版 app 同时在跑时,`set frontmost of process "book-learner"` 会激活到正式版而不是调试实例,要按 pid:`set frontmost of (first process whose unix id is <pid>)`;用户在 Mac 上操作会随时把调试窗口盖住(`document.visibilityState` 变 `hidden`),所以每个依赖渲染/翻页的步骤前都置前一次并读 `visibilityState`。

**受控日期**(DEV 构建):`localStorage['bookLearner.testDate']`(桥命令 `a set bookLearner.testDate 2026-09-10` 后 reload)。

## 3. 壳层 `web/src-tauri/src/`(Tauri 2,crate `book_learner_app`)

**启动时序 `lib.rs::run()`**:`state::ensure_gui_path()`(补 PATH:Homebrew/npm/nvm 等,Finder 启动无 shell PATH)→ 通知插件 → 关窗=隐藏(`on_window_event`)→ `setup`:`data_dir` → `initialize_state`(解析 `app.db` 路径;debug 认 `BOOK_LEARNER_DATA_DIR` → 先应用待恢复标记 `restore-pending.json` → `AppState::open`(`core::db::open` 迁移到 v8;`MemoryStore::init` 首次 `git init`)→ 恢复过则入队 `sync_map/sync_weakpoints` → 当日首次快照 → 清 24 h 前的导入暂存)→ `asset_protocol_scope.allow_directory(books/)` → `app.manage(state)` → 自动化桥(debug)→ 托盘(失败只 warn)→ 番茄钟 ticker → 提醒线程 → 后台 `run_startup_recovery`(重放 outbox main 通道 + push 通道)。启动失败走 `fail_startup`:rfd 同步 NSAlert + `exit(1)`(不能用 tauri-plugin-dialog,setup 阶段会死锁)。退出:`ExitRequested` → `orderly_shutdown`(结束番茄并落分钟 → 等慢命令 `SHUTDOWN_GRACE=10s` → 刷当日快照)。

**AppState(`state.rs`)**:`connection: Mutex<Connection>` 共享连接(`with_connection`,持锁期间禁止 AI/文件/git)+ `open_connection()` 每次新开(慢命令:地图作业、回合、评估、导入、导出、快照、push);`JobRegistry`(`begin()` RAII 计数,`wait_idle`);`ai_provider()`:直读 `setting.codexBin` → `resolve_codex_bin`(配置绝对路径 → `$PATH` → `/opt/homebrew/bin`、`/usr/local/bin` → `~/.npm-global/bin` → `~/.nvm/versions/node/*/bin` 高版本优先)→ 把 codex 所在目录前置 PATH → `CodexCliProvider{bin, extra_args: []}`。相对路径 → invalid_request;找不到 → not_found「未找到 codex 可执行文件,请在设置中填写其绝对路径」。

**命令约定**:`#[tauri::command(async)] xxx` → `xxx_inner`(`run_command`:分配 `correlation_id`,失败时 `tracing::error!(command, correlation_id, error_code, internal_cause)`)→ `application::xxx` → core。DTO 全在 `dto/mod.rs`(camelCase)。`WIRE_COMMANDS`(`commands/mod.rs`)必须与 `shared/tauri-wire-contract.json` 逐字相等(foundation 用例强制)。

| 组 | 命令(payload) → application → core |
|---|---|
| 书架 | `library_list_books[]`、`library_set_active_book[bookId]`(`library::set_active_book`:需有计划、非 finished)、`library_finish_book[bookId]`、`library_epub_url[bookId]`(返回 `books/<book_id>.epub` 绝对路径) |
| 导入 | `library_import_epub_chunk`(原始体,头 `x-op-id`/`x-chunk-index`,单块 ≤ 8 MiB)、`library_import_epub_finalize[opId,bookType,title]`(JOB) |
| 地图 | `map_store_spine[bookId,chapters]`、`map_run_job[bookId,jobId]`(AI+JOB,事件 `map_job_progress{jobId,progress}`;`map_revision>0` 直接返回块不跑 AI)、`map_confirm[bookId,expectedRevision,ops]`、`map_set_anchor_segments[blockId,segments]`、`map_list_anchors[blockId]`、`map_list_blocks/map_get_block`、`map_block_source[blockId]` |
| 计划 | `planning_set_plan[request]`、`planning_get_plan[bookId]`、`planning_check_behind[bookId,date]`(**有副作用,必须先于队列生成**)、`planning_today_queue[date]`、`stats_get[date]`、`stats_detail[date]` |
| 会话 | `session_start_or_resume[taskId,clientRequestId,date]`、`session_submit_turn[sessionId,expectedVersion,clientTurnId,text]`(AI)、`session_request_evaluation[sessionId,requestId]`(AI)、`session_confirm_verdict[sessionId,expectedVersion,requestId,pass,date]`(原子落库,之后后台重放投影)、`session_abandon[sessionId,expectedVersion]` |
| 附加/终评/画像 | `extra_start[blockId,kind,clientRequestId]`、`extra_finish[...]`(AI)、`final_exam_eligible/start/finish`(finish AI)、`profile_get[]`、`profile_save[profile]`(写 `profile.md` 并入队 `git_commit`) |
| 番茄钟 | `pomodoro_start[taskId,date]/pause/resume/stop/state`(Rust 状态机;事件 `pomodoro_changed` 只在阶段变化时发;托盘标题 `●MM:SS`/`○`/`‖`) |
| 导出/备份/git | `export_preview/export_obsidian/export_reveal[bookId]`、`backup_snapshot_now[date]`、`backup_list[]`、`backup_restore[name]`(只登记标记)、`backup_cancel_restore[]`、`git_remote_get[]`、`git_remote_set[url]`(`ls-remote` 校验)、`git_push_now[]` |
| 阅读器 | `reader_mark_list/add/update/remove`、`reader_position_set[bookId,spineHref,cfi]` |
| 语音 | `voice_models[]`、`voice_import_model[path]`(空则 rfd 主线程选择器)、`voice_select_model[name]`、`voice_delete_model[name]`、`voice_transcribe`(原始体 16 kHz i16 PCM,头 `x-bl-lang`/`x-bl-hint`) |
| 设置 | `settings_get/settings_save[settings]`、`settings_codex_get[]`、`settings_codex_set[path]`、`unsupported_capability[capability]`(只剩 `completeTask`) |

不在契约的命令:`automation_report`(debug 桥回传)。

**错误映射 `error.rs`**:`ErrorCode` = invalid_request / not_found / conflict / db_unavailable(可重试)/ io_failure(可重试)/ ai_unavailable(可重试;`CoreError::Ai|EvalParse`)/ not_implemented / internal。`internal_cause` 只进日志不过 IPC。前端 `tauri.ts` 的 `IPC_ERRORS` 文案与之一致。

**导入 `import.rs`**:暂存 `import/<opId>/part-NNNNNN` → `assemble`(分块须连续)→ `validate_epub`(zip 魔数、条目 ≤ 5000、路径安全、首条目 `mimetype`=`application/epub+zip`、有 `container.xml`)→ `epub_metadata`(读 OPF `dc:title/dc:creator`;**zip 须开 deflate**)→ 插书行(`slug=import-<opId>`,`import_state='staged'`)→ rename 到 `books/<book_id>.epub`。总量上限 200 MiB。

**语音 `voice.rs`**:`models/` 目录,`ggml-*.bin` 白名单,导入 ≥ 20 MiB 复制 + rename,首个自动选中;`transcribe` 按选中模型懒加载、`OnceLock<Mutex>` 串行;录音 ≤ 120 s;无模型 → invalid_request 且不加载 whisper;feature `voice` 默认开(需 cmake)。

**自动化桥 `automation.rs`**(debug + `BOOK_LEARNER_AUTOMATION_SOCK`):unix socket,一行 JSON:`{"js":...,"timeout_ms"}` 在 WebView eval 并经 `automation_report` 回传;`{"tray_title":true}`;`{"quit":true}`(走有序退出)。

**线程**:`reminder`(30 s 轮询,长连接,`setting` 表 `notified:<kind>:<date>` 幂等;晚间窗口才查队列)、`pomodoro-ticker`(1 s,锁外落库 `study_minutes`)。

**数据目录**(release `~/Library/Application Support/book-learner/`):`app.db(.replaced-<ts>)`、`memory/`、`books/<book_id>.epub`、`import/`、`models/`、`snapshots/app-YYYY-MM-DD.db`、`restore-pending.json`。`capabilities/default.json` 只有 `core:default` + `notification:default`(无 dialog/fs/shell 权限:文件选择走 rfd,`open` 走 `std::process::Command`)。

## 4. 前端 `web/src/`(React 18 + TS + Vite + Tailwind v4 + epub.js)

**路由(`App.tsx`,BrowserRouter)**

| 路由 | 页面 | 读 | 写 |
|---|---|---|---|
| `/` | `features/today/TodayPage` | `listBooks` → `checkBehind`(先)→ `todayQueue` → 每书 `listBlocks`;`stats`;`pomodoroState` | `completeTask`(Tauri 下有意 unsupported)、`pomodoroStart` |
| `/library` | `features/library/LibraryPage` | `listBooks` | `setActiveBook`、`finishBook`;`ImportWizard`(`importEpub/storeSpine/runMapJob`)、`ExportDialog` |
| `/map/:bookId` | `features/map/MapPage` | `listBlocks`、`listBooks`(取 `mapRevision`) | `confirmMap`、`setPlan` + `setActiveBook` |
| `/reader/:blockId?task=&back=` | `features/reader/ReaderPage` | `getBlock` → `blockSource/epubUrl/readerMarkList/listAnchors` | `readerMarkAdd/Remove`、`readerPositionSet`(800 ms 防抖,失败静默) |
| `/feynman/:taskId` | `features/feynman/FeynmanPage` | `todayQueue` → `getBlock` → `blockSource` → `startOrResumeSession` | `submitTurn`、`requestEvaluation`、`confirmSessionVerdict`、`abandonSession`、`extraStart/extraFinish` |
| `/final/:bookId` | `features/feynman/FinalExamPage` | `listBooks` → `finalExamStart` | `submitTurn`、`finalExamFinish` |
| `/stats` | `features/stats/StatsPage` | `stats`、`statsDetail`(独立失败/重试) | — |
| `/settings` | `features/settings/SettingsPage` | `getSettings`、`codexBinGet`、`voiceModels`、`profileGet`、`backupList`、`gitRemoteGet` | `saveSettings`、`codexBinSet`、`voice*`、`profileSave`、`backup*`、`gitRemoteSet/gitPushNow` |

跨页会话态只有 zustand `store.ts`(`activeBookId/currentTaskId/theme/pendingNotice`,内存态;夜读模式**不持久化**);领域数据一律走 backend。侧栏「知识地图」目标依赖 `activeBookId`,为空退回 `/library`。

**Backend 层(`backend/`)**:`index.ts` 按 `__TAURI_INTERNALS__` 选 `TauriBackend`(`tauri.ts`)或 `MockBackend`(`mock.ts`,内建《微观经济学》种子);`Backend` 接口在 `types.ts`。调用模式 `gated(method) → 出站校验 → call/callRaw → 逐字段 decode`,形状不符抛 `invalid_response`;非契约拒绝 → `transport_error`(devtools 打 `[ipc] transport_error`,脱敏)。错误码/文案表 `IPC_ERRORS`(与壳层一致);`retryable` 决定页面是否给「重试」。事件只有 `map_job_progress`(runMapJob 期间订阅)与 `pomodoro_changed`。`stats/statsDetail` 自带 `date=localCalendarDate()`。

**两个共享 hook(卡「思考中」/按钮禁用先看这里)**
- `lib/useAsyncResource.ts`:`{data,error,loading,reload}`;失败保留旧 data;多步 fetcher 每步 `if (!isCurrent()) throw new StaleResult()`;只在挂载时加载一次,换参靠 `key=` 重挂载。
- `lib/useBackendOperation.ts`:`run(key,...args)` 同 key 进行中返回 `'ignored'`;`retry(key)` **复用同一 clientId** 重放;`pending` 含"已提交待刷新"(`onCommitted` reject 时守卫不释放、不记错误 → 按钮永远「处理中…」,需 `releaseCommitted()`,目前只有 TodayPage 调);`errors` 逐 key 保留含不可重试错误(用于禁用态,刷新成功后要 `clearAllErrors()`);卸载**故意不清 `generations`**(StrictMode 下清了会让 opener 永远「思考中」)。
- `lib/ids.ts` `CLIENT_ID_RE=/^[A-Za-z0-9._-]{1,64}$/`;`lib/localDate.ts` `localCalendarDate()`,DEV 下可被 `bookLearner.testDate` 覆盖。

**导入向导(`features/library/ImportWizard.tsx`)**:选 `.pdf` → 只显示 Calibre 转换命令不导入;选类型时生成一次 `jobId`,`ImportAttempt{file,type,jobId,bookId?,chapters?}` 走四步:`importEpub`(4 MiB 分块 + finalize,title=文件名)→ `extractSpine`(`epub/extract.ts`:spine 去重、TOC/标题/href 三级取名、`chapterMarkdownText`、每 6 章让出主线程并汇报进度)→ `storeSpine` → `runMapJob`(进度文案 `importProgress.ts`)→ `navigate('/map/:id')`。重试用同一 attempt:已完成的导入/抽取不重跑,`storeSpine+runMapJob` 幂等重跑。EPUB 解析失败一律不可重试「无法解析这个 EPUB 文件」。

**地图页(`features/map/MapPage.tsx` + `mapOps.ts`)**:编辑态操作:上/下移、跳过/恢复、模块改名、并入上一块、拆分(两个标题)、删除(仅未学块;删除/并入可撤销;BL-002);`finalize()` → `diffMapOps`(renameModule → delete → merge → setSkipped → reorder → split),ops 为空不调后端直接进目标设定;`confirmMap(bookId, book.mapRevision, ops)` 冲突不可重试但保留编辑可重发;成功 → 目标设定对话框(`dailyBlocks = ceil(未跳过块/(deadline−today+1))`,`dailyCap=4`)→ `setPlan` → `setActiveBook` → `/`。「整书终评」仅 `allPassed` 时显示。

**锚点(`epub/anchors.ts` + `epub/headings.ts`)**:`resolveBlockAnchors(book, hints)` 把 core 的 `source_section="{href}#{小节标题}"` 解析成 [标题文本节点, 下一同级标题) 的两点折叠 CFI(`exact`),未命中 → 整章 `chapter_fallback`。**回填(BL-001,2026-09-09)**:`epub/anchorBlocks.ts` 在导入向导 `runMapJob` 后对每块 `listAnchors` → `resolveBlockAnchors` → `setAnchorSegments`,已 `exact` 跳过、单块失败不阻塞(console.error 进日志 target=client);2026-09-09 之前导入的书仍是整章回退,删除重导即可。回读定位/块下划线不准时先看 `block_anchor.precision`(诊断包 `tables/anchors.txt`)。

**今日页(`features/today/`)**:`today` 在挂载时固定;`loadQueueBundle` 顺序 `listBooks → checkBehind → todayQueue → listBlocks`;`TaskCard` 动作:所有任务「专注」;new → 「开始」进 `/reader/:blockId?task=`;weak_retest/review → 「完成」(Tauri 下不可用,显示「讲完自动完成」)+「开始重考/开始复习」直达 `/feynman/:taskId`,review 另有「回读原文」。`ReplanDialog`:顺延 = `setPlan(deadline = today + ceil(剩余/cap) − 1)`;缩减 = 按 seq 倒序把多出的块 `confirmMap(setSkipped)`;「本日不再提醒」写 `bookLearner.replanDismissed`。`Pomodoro.tsx` 本地按 `endsAt` 每秒重绘 + `subscribePomodoro`。

**费曼页(`features/feynman/FeynmanPage.tsx`)**:常量 `EVAL_REQUEST_ID='eval'`、`VERDICT_REQUEST_ID='verdict'`(每会话常量 → 重挂载即同 id 重试);`config.ts` `OPENER_TURN_ID='opener'`、`OPENER_TEXT`(review/retest/final_exam 固定开场)、`TYPEWRITER_CHAR_MS=28`。初始化找不到任务 → not_found;`key=sessionId` 挂 `TeachingRoom`;`fromView` 水合(done 回合入流、`pendingTurn` = 上次未完成的用户回合,`retryPending` 用原 clientTurnId + 当前 version 续跑);review/retest 自动发 opener 一次;发送生成 `clientTurnId` 进 args,重试复用;打字机结束前 `busy`;`inputLocked = busy || evaluating || pendingTurn || evalResult`;「结束讲授」→ `requestEvaluation(sessionId,'eval')`(evaluating 时文案「继续评估」);`EvalCard` → `confirmSessionVerdict(...,'verdict',pass,today)`;通过且 `task.kind==='new'` → `ExtraStage`(种类按书型 `EXTRA_KIND_FOR_BOOK`,opener 固定,`extra-finish` 请求 id,可「跳过」)否则回 `/`。「放弃本次」→ `abandonSession`。`VoiceInput`(三处)把转写**追加进输入框不发送**;录音链路 `audio/pcm.ts`,≤ 120 s;错误文案 `voiceSupport.ts`。

**终评/导出/阅读器/统计/设置**:`FinalExamPage`(`FINAL_EXAM_REQUEST_ID='final-report'`、`FINAL_EXAM_MIN_ANSWERS=2`;confirmed 时直接重放报告;报告视图去首行元注释)。`ExportDialog`(目标目录不存在则禁用导出;`reveal` 独立 key)。`ReaderPage`(`EpubView` props `url/fontSizePct/theme/typography/initialHref/highlights/blockSegments/onToc/onProgress/onSelected/onRelocated`;标记首载后本地维护;偏好 `bookLearner.readerPrefs`;`EpubView` 只在 `url` 变化时重建 rendition,首次 `rendered` 前显示骨架)。`StatsPage`(四卡 + 三区)。`SettingsPage`(`key=version` 重挂表单;节奏卡 → `saveSettings`;`CodexField`;`VoiceSection`;`ProfileSection`;`DataSection`)。

**localStorage 键**:`bookLearner.readerPrefs`、`bookLearner.replanDismissed`、`bookLearner.voiceDevice`、`bookLearner.testDate`(仅 DEV)。

**测试**:vitest 22 文件 / 322 用例(`pnpm -C web test -- --run`);Playwright `web/e2e/{anchors,cfi}-smoke.spec.ts`(需 `PLAYWRIGHT_BROWSERS_PATH`);`pnpm -C web build` 是唯一有效的类型门禁;oxlint 配置 `web/.oxlintrc.json`。

## 5. core `core/src/`(crate `book_learner_core`,纯 Rust,Linux 可测)

**模块职责**

| 模块 | 职责 / 主函数 | 表 |
|---|---|---|
| `db.rs` | `open`/迁移(`SCHEMA_VERSION=8`,BEGIN IMMEDIATE,`foreign_keys=ON`,busy 5 s) | DDL |
| `models.rs` | 书/块 CRUD;`insert_book`(已有主攻书则 paused 入库)、`next_new_blocks`(unlearned|learning 且未跳过,按 seq) | book, knowledge_block |
| `library.rs` | `set_active_book`(需计划、非 finished,同事务切计划 active)、`finish_book[_in]` | book, study_plan |
| `planning.rs` | `set_plan`、`get_plan`、`today_queue` | study_plan |
| `sched.rs` | `generate_daily`、`on_block_passed`、`on_review_result`、`on_weak_retest`、`insert_new_weak_points`(NOT EXISTS 去重)、`apply_eval_in_tx`、`check_behind` | daily_task, review_schedule, weak_point |
| `mapgen.rs` | `store_spine`、两阶段 `run_map_job`(逐章 stage A 候选 → merge 草图;断点 `map_job.next_chapter`) | spine_item, map_job |
| `map.rs` | `apply_draft_map`(落块 + 锚点,revision 0→1)、`confirm_map`(乐观并发 ops:rename/renameModule/reorder/setSkipped/merge/delete(仅无学习痕迹的块)/split(原块改名+新块复制锚点))、`set_anchor_segments`、`list_anchors` | knowledge_block, block_anchor |
| `session.rs` | `start_or_resume_session`、`fixed_context_for_block`(锚点文本 → 整章回退,≤ 60 KiB)、`submit_turn`(两阶段事务 + AI)、`abandon_session` | feynman_session, session_turn |
| `verdict.rs` | `request_evaluation`(AI JSON)、`confirm_session_verdict`(单事务:块状态 + 排期 + 薄弱点 + outbox) | 多表 |
| `extra.rs` / `final_exam.rs` | 附加环节 / 整书终评(`eligible`、`start`、`finish` 报告 + `finish_book_in`) | feynman_session, artifact |
| `orchestrate.rs` | `run_ai_request/run_ai_json/run_ai_parsed`:幂等 `ai_request`、传输重试 2 次退避 500 ms×2ⁿ、解析纠错 1 次;禁止事务内调用 | ai_request |
| `ai.rs` | `CodexCliProvider`:`codex exec --skip-git-repo-check -C <memory/> --sandbox read-only|workspace-write --output-last-message <tmp> <prompt>`;prompt ≤ 100 KiB(argv)、输出 ≤ 1 MiB、进程组超时杀 | — |
| `projection.rs` | outbox `enqueue/enqueue_in`、`run_pending`(main 通道保序,失败即停)、`run_push_lane`(退避 60 s×2ⁿ,上限 6 h) | projection_outbox |
| `memory.rs` | md 原子写(临时文件 + fsync + rename)、slug 白名单、git commit/push/remote、`profile_*` | 文件系统 |
| `stats.rs` / `export.rs` / `backup.rs` / `reader_marks.rs` / `pomodoro.rs` / `notify.rs` / `settings.rs` | 统计 / Obsidian 导出(只读)/ `VACUUM INTO` 快照与恢复标记 / 标记 / 番茄钟状态机 / 提醒判定 / 五个设置键 | — |
| `prompts.rs` | `feynman_system`、`eval_prompt`、`review_quiz_system`、`map_stage_a/b_prompt`、`extra_system/extra_summary_prompt`、`final_exam_system/final_report_prompt` | — |

**Schema 演进**:v1 基础八表 → v2 计划唯一索引 → v3 `book_single_active` + 子表补外键 → v4 `map_revision/import_state`、`spine_item`、`block_anchor(exact|chapter_fallback)`、`map_job`、`ai_request`、`session_turn`、`projection_outbox`、会话 `state/version/client_request_id/verdict_*` → v5 `extra_kind`、`study_minutes` → v6 `feynman_session.book_id`(终评唯一)→ v7 outbox `lane/next_retry_at` → v8 `reader_mark`。**只做加法**(重建 `feynman_session` 会级联删光回合)。

**状态机**:`knowledge_block.status` unlearned → learning(判定再学)→ passed(判定通过)→ consolidated(14 天档复习通过);`feynman_session.state` open → evaluating → evaluated → confirmed(任意未确认可 abandoned;AI 失败回退 open);`kind` learn|retest|review|final_exam(由 daily_task.kind new|weak_retest|review 映射);`weak_point` open →(连续 2 次通过)→ fixed;`review_schedule` 1→3→7→14 天,失败重置 +1 天;`book.status` active|paused|finished(至多一本 active);`import_state` ready → extracted(存 spine)→ mapped;`map_job.stage` chapters → merge → done|failed。

**ai_request 命名空间**:`turn:{session}:{clientTurnId}`、`eval:{session}:{requestId}`、`extra:{session}:{requestId}`、`final:{session}:{requestId}`、`map:{jobId}:ch{idx}[:p{k}]`、`map:{jobId}:merge`;客户端 id ≤ 64 且不含 `:`。

**超时(秒)**:回合 120、评估 120、附加 finish 120、终评报告 180、地图每章 300、`--version` 10。**队列**:重考 ≤ 3/日(est 10)→ 到期复习(est 5)→ 主攻书新块配额(est 30);已暂停/学完书的复习照常。**落后检测**:近两个有新块任务的过去日期都未完成 → `required = ceil(剩余块/剩余天)`,≤ cap 自动改配额,否则弹决定。**会话上限**:快问学生回合 6、附加 3(方法论 4)、终评 8(框架阶段 3、至少作答 3 次才能出报告)。

**投影 kind → 文件**:`init_book`(`_map.md/_weakpoints.md/blocks/` + INDEX 行)、`block_eval`(`blocks/<id:04>-<slug>.md`,仅新块判定)、`sync_weakpoints`、`sync_map`、`extra_archive`(`_applications.md/_methodology.md/_notes.md`)、`report_archive`(`_report.md`)、`git_commit`、`git_push`(push 通道)。md 内 `<!-- entry:… -->` 标记保证幂等。

**测试**:`cargo test --manifest-path core/Cargo.toml --all-targets`(单测 167 + 集成 29:`tests/foundation.rs`、`lifecycle.rs`、`m1_engine.rs`);`#[ignore]` 的 `codex_real_smoke` 需本机 codex。

## 6. 契约六处同步(改任何命令都要同一提交)

1. `shared/tauri-wire-contract.json` 2. `web/src-tauri/src/commands/mod.rs::WIRE_COMMANDS` 3. `web/src-tauri/src/lib.rs::register_commands` 4. `web/src-tauri/tests/foundation.rs` wire 用例(payload 分支)5. `web/src/backend/contract.test.ts` 6. `web/src/backend/tauri.test.ts::NATIVE_METHODS`;外加 `Backend` 接口(`web/src/backend/types.ts`)、`TauriBackend`(`tauri.ts`)、`MockBackend`(`mock.ts`)同语义。原始体命令 payloadKeys 为 `[]`。**载荷形状变了(命令名不变)也要动**:`tauri.ts` 的出站校验器(如 `MAP_OPS` + `validateMapOps`)、`tauri.test.ts` 的 payload 断言、壳层 DTO 与 foundation 的 DTO 形状断言——2026-09-11 BL-002 新增 delete/split 漏了出站校验器,Mac 上定稿被本地拦成「请求内容无法安全传输」(CI 全绿也测不出,只有调试包实测能发现)。

## 7. 构建、测试、CI

| 目的 | 命令 |
|---|---|
| 浏览器开发(Mock) | `pnpm -C web dev`(127.0.0.1:1420) |
| 原生开发 / debug bundle / release dmg | `pnpm -C web tauri dev` / `pnpm -C web tauri build --debug --bundles app` / `pnpm -C web tauri build --bundles app,dmg`(产物 `web/src-tauri/target/{debug,release}/bundle/`) |
| web 门禁 | `pnpm -C web test -- --run` · `pnpm -C web lint`(oxlint)· `pnpm -C web build`(**类型检查只有这条有效**,`tsc --noEmit -p` 不查) |
| core 门禁(Linux 可) | `cargo fmt --check` / `test --all-targets` / `clippy -D warnings`,`--manifest-path core/Cargo.toml` |
| 壳层门禁(只能 Mac) | 同上 `--manifest-path web/src-tauri/Cargo.toml`;Linux 缺 GTK 编不了 |
| 一键 CI 等待合并 | `/bigtemp/fzv6en/book-learner/ci-merge.sh <PR号>` |

CI(`.github/workflows/ci.yml`):`core`(ubuntu)、`web`(ubuntu,node 22,pnpm 11.24.0)、`mac-foundation`(macos-14:fmt → core test → src-tauri test → clippy → `tauri:build:debug`),整轮约 6 分钟(含 whisper 编译)。Feature `voice` 默认开(cmake);`zip` 必须 `features=["deflate"]`。**Cargo.lock 以 Mac 解析为准**(Linux 跑 cargo 会加 Linux 依赖,提交前回退)。Mac 依赖:cmake、codex CLI(node)、Calibre(可选,PDF)。

流程约定:每任务独立分支 → 本地门禁 → DEVLOG 条目 → PR → CI 绿合并;设计变更回写 PRODUCT_SPEC/TECH_DESIGN;schema 只做加法。

## 8. 门禁脚本与桌面自动化

- 门禁手册:`docs/smoke/mac-m1-native-smoke.md`(Foundation)、`m1-e2e-gate.md`(真书 + 真 codex 七步)、`m2-gate.md`(通知/番茄钟/重排/单主攻书/快问/附加环节/画像/统计)、`m3-gate.md`(语音/导出/终评/阅读器/快照/dmg/codex 路径);脚本在 `docs/smoke/scripts/`,骨架:`open -a <debug app> --env BOOK_LEARNER_DATA_DIR=<tmp> --env BOOK_LEARNER_AUTOMATION_SOCK=<sock>` → 等 socket → `front()` → `bl-auto.py` 驱动(`go/click/type/file/wait/waitgone/js/quit`)→ 观察值取页面文本 + SQLite + `memory/` + 导出目录。
- 驱动要点:发送前等渐显 `▍` 消失;对话框内按钮用 `[aria-label]` 容器限定(`dclick`);「确认定稿」只在编辑态出现(先点「编辑地图」);受控日期 `a set bookLearner.testDate <日期>` 后 reload;长文本经 python json 转义;大数据分片传(argv 上限)。
- ADR:0001 SQLite 事实源 + outbox 投影(修订:push 通道独立退避);0002 AI/回合幂等 id;0003 多段锚点 + 地图修订号;0004 EPUB 原生分块传输(B)。

## 9. 已知教训与陷阱(按主题;修复均已合入)

**运行时 / macOS**
- Finder 启动的 app 没有 shell PATH:codex 是 `#!/usr/bin/env node` 脚本,子进程 127「env: node: No such file」;`state::ensure_gui_path` 启动补全(PR #32)。**测试时若地图/回合失败,先查 `ai_request.error`。**
- WKWebView 的 localStorage 落盘有约 1 s 延迟:改完偏好立刻退出 app 会丢(探针切夜读后 <1 s 退出即复现);用户正常使用不受影响,探针要等 2–3 s 再 quit。
- 后台/被遮挡的 WebView 被 macOS 节流:IPC 回调可延迟数分钟、阅读器不渲染;驱动脚本先置前;用户侧表现为"切到别的 app 再回来才更新"。阅读器不渲染的具体链路:epub.js 的任务队列 `Queue.run()` 用 `requestAnimationFrame` 驱动,`rendition.display()` 只是入队,窗口不可见时 rAF 不派发 → 容器里连 iframe 都没有、骨架常驻、无 JS 错误、EPUB 资源请求正常;窗口一露出就自愈。所以驱动脚本 `go /reader/...` 之前必须 `front()`,否则会把"不渲染"误判成回归(2026-09-10 bisect 在 main 上也复现过)。
- 系统通知只在 bundle 运行时可用;麦克风 TCC 只有经 LaunchServices(Finder/`open`)启动才弹框,从终端直接执行二进制会立即 NotAllowedError。
- 扬声器回放会被 WebKit 回声消除压掉(录不到 TTS),真人说话不受影响。
- WKWebView 不向 `sandbox="allow-same-origin"`(无 allow-scripts)的 iframe 派发 `selectionchange`,鼠标点击同样收不到:epub.js 的 `selected` 在原生里永不触发(BL-006),点正文翻页无反应(BL-009)。对策:选区靠轮询 `getSelection()`;翻页靠父文档两侧透明点击区;能收点击的是 epub.js 画在父文档的注解 SVG(BL-007 借此做取消高亮)。任何"依赖 iframe 内 DOM 事件"的功能在 Mac 上都要实测。
- `tauri-plugin-dialog` 在 setup 阶段死锁 → 启动错误框用 rfd;文件选择器 rfd 必须经 `run_on_main_thread`(命令上下文可用)。
- Homebrew cask/github 直连经代理很慢;Mac 上 github 走 socks5 代理配置。

**AI / codex**
- codex 超时曾映射为不可重试 internal(PR #22 改 ai_unavailable 可重试);超时路径 3×120 s + 退避。
- 单轮往返 13–50 s,长章节地图阶段单章可达数分钟(上限 300 s);prompt 经 argv 上限 100 KiB。
- `--skip-git-repo-check` 必需;stderr 必须并发排空,超时按进程组杀。

**前端**
- StrictMode 下 `useBackendOperation` 卸载清理曾清空 generations 使 opener 永远"思考中"(PR #21)。
- 发送在渐显期间被忽略(设计);`completeTask` 有意 unsupported(任务经讲授判定完成)。
- vitest:fake timers 下 user-event 会死锁,用 `fireEvent + act`;Node 26 全局 localStorage 需 `vi.stubGlobal`;RTL 需显式 `afterEach(cleanup)`。

**导入 / EPUB**
- zip 未开 deflate 读不到 OPF(书名变文件名)——已修;单章 HTML 的书所有锚点整章回退,费曼注入整章原文(≤ 60 KiB);Calibre 转出的 EPUB 同样整章回退、章节名为拆分文件名。
- epub.js CFI 必须锚定文本节点。

**流程 / 脚本**
- 假绿:管道后要立刻读 `pipestatus`;改动脚本别挂在 `&&` 链尾;每任务核对用例数变化;分支 rebase 后 `--force-with-lease`;同名 tmux 会话先杀;传给 `bl-run.sh` 的脚本用 `<name>-cmd.sh`;python 里禁止 `open(p,'w').write(open(p).read())`;只按 pid 文件结束进程。

## 10. 未做 / 范围外(测试时不要当缺陷报)

**待修缺陷**(台账 `docs/testing/BUGS.md`):BL-002 地图页无删除/合并/拆分 UI(core 已支持 delete/merge/split ops);BL-003 夜读模式不持久化。已修:BL-001 锚点回填、BL-004 Finder PATH、BL-005 删除书。

**范围外**:PDF 原生导入(用 Calibre 转 EPUB,`docs/pdf-import.md`);应用内下载 whisper 模型;Developer ID 签名与公证(dmg 为 ad-hoc,首次打开需右键);霞鹜文楷内置;手动锚点校正 UI(选区设为块起点/终点);画像「个人情境」的 AI 提取与确认流;书架对 `staged/extracted` 未完成导入书的徽标与删除入口;未发送草稿跨重启持久化;大文件 EPUB(≥ 30 MB)吞吐未实测。
