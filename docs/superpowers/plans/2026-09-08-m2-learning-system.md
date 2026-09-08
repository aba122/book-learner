# M2 学习系统 Implementation Plan(调度、节奏、三类模板、统计)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 M1 闭环之上交付 IMPLEMENTATION_PLAN §M2 的五项:间隔复习与薄弱点重考以"快问"形态进入费曼流程;强节奏(系统通知、Rust 番茄钟 + 托盘倒计时、落后重排确认);三类书通过后附加环节与 profile 画像编辑;单主攻书补完;统计页三区。**M2 验收**(IMPLEMENTATION_PLAN):三类书各导入一本并各学 ≥2 块,附加环节行为符合模板定义;制造落后 2 天触发重排确认;番茄钟计时与通知在关窗常驻状态下正常;第 1 天通过的块在第 2 天出现复习任务。

**Architecture:** 延续 M1 约定——SQLite 事实源、md/git 为 outbox 投影;Tauri command 薄层 + `application` 用例 + core 用例;慢命令用 `open_connection()` 并持 `JobGuard`;`date` 一律由前端本地日历日提供(壳层长驻线程只做"到点"比对,落库日期仍来自前端);行为参数只进 `web/src/config.ts`。**契约同步是六处,同一 commit**:①`shared/tauri-wire-contract.json` ②`commands/mod.rs::WIRE_COMMANDS/UNSUPPORTED` ③`lib.rs::register_commands` ④`tests/foundation.rs` 契约用例的 payload `match`(未知命令 panic)⑤`web/src/backend/contract.test.ts` ⑥`web/src/backend/tauri.test.ts`;Mock 同语义同 commit。事件名只作 Rust/TS 常量(`MAP_JOB_PROGRESS_EVENT` 先例),不进 JSON(`contract.test.ts:56` 断言顶层键固定)。**新增长驻逻辑(通知判定、番茄钟)为纯状态机并单测,副作用(发通知/托盘标题)只在壳层线程内。schema 只做加法(v5),不重建表。**

**Tech Stack:** 同 M1;新增 `tauri-plugin-notification`(系统通知,capabilities 增 `notification:default`;**macOS 通知要求以 bundle 形式运行**,门禁用 `pnpm -C web tauri build --debug --bundles app` 产出的 .app,`tauri dev`/裸二进制看不到通知)。

**Spec 依据:** PRODUCT_SPEC §3.1/3.6/3.8/§4/§5/§6;TECH_DESIGN §6.4–6.8(prompt 构造器已在 core `prompts.rs`)、§10;core 现有 `sched::{generate_daily,on_block_passed,on_review_result,on_weak_retest,check_behind}`、`verdict::confirm_session_verdict` 按任务类型路由(`verdict.rs:300-324`)、`artifact` 表(`book_id NOT NULL`,`kind IN ('restatement','methodology','reflection','application','report')`,`content_md`;`db.rs:187-192`)。**范围外:** M3(语音、Obsidian 导出、整书终评 §6.8、签名 DMG)、开机自启、**个人情境的 AI 自动提取与确认流(IMPLEMENTATION_PLAN 2.3 后半,移至 M3;M2 只做手工编辑)**。

**执行环境:** core/web 任务在 Linux 或 Mac 均可;src-tauri 任务在 Mac(经隧道,`~/Developer/bl-run.sh` 跑门禁;远程链管道后立刻 `rc=${pipestatus[1]}` 再判断);托盘标题、系统通知、关窗常驻的目检需桌面会话,记入 `docs/smoke/m2-gate.md`。分支:每个 Task 一个 `feat/m2-tN-*` 分支 → PR → CI 绿 → 合并(merge)。

---

## 现状盘点(2026-09-08,经独立评审核实)

- core `sched.rs`:`generate_daily` 按 薄弱点重考(≤3)→ 到期复习 → 新块 排序且**按日期幂等**(`sched.rs:40-43`);`check_behind` **不是纯查询**——在"均摊 ≤ cap"分支已直接改写 `study_plan.daily_new_blocks`(`sched.rs:347-353`),无主攻计划时报错(`sched.rs:329-333`);`on_review_result` 失败只插一条通用薄弱点"间隔复习未通过"(`sched.rs:178-182`)。
- core `session.rs`/`verdict.rs`:会话 kind 由任务类型映射;所有 kind 都用 `prompts::feynman_system`;`submit_turn` 拒绝空用户文本(`session.rs:353-356`),`request_evaluation` 要求 ≥1 个 done 用户回合(`verdict.rs:140-149`),即**协议要求用户先开口**;`confirm_session_verdict` 对 review/retest 分支**不落库 `eval.weak_points`**(`verdict.rs:312-324`);`fixed_context_for_block` 把该块所有会话的 `eval_json` 按 `EvalResult` 解析(`session.rs:256-276`)。
- core `prompts.rs`:`review_quiz_prompt` 末尾要求"最后一条消息只输出 JSON"(`prompts.rs:57-64`),**不能直接当回合 system prompt**;§6.4/6.5/6.6/6.8 只有构造器。
- core `db.rs`:`migrate()` 在一个 IMMEDIATE 事务内且 `foreign_keys=ON` 已生效(`db.rs:23-37`);`session_turn.session_id … ON DELETE CASCADE`(`db.rs:239`)——**重建 `feynman_session` 会级联删光回合**,故 M2 一律加列不重建;`review_schedule` 无完成日期列(`db.rs:176-181`);`daily_task` 随块删除级联(`db.rs:141-142`);`study_plan` 已有 `remind_time/evening_remind_time` 列(`db.rs:81`)但产品设置页的权威是 `setting` 表(§3.7)。
- 壳层:tray 初始化失败仅 warn(`lib.rs:180-183`);`session_confirm_verdict` 后在 `spawn_blocking` 里跑 `run_pending`(`commands/mod.rs:475-486`)——任何直接 `git commit` 都会与之竞争 index.lock,**记忆库写入一律经 outbox**。
- web:`SessionKind` 为 `'learn'|'retest'|'review'|'final_exam'` 且解码器 `enumAt` 严格(`tauri.ts:154,361`);`Pomodoro.tsx` 为 JS 计时;TodayPage 先 `todayQueue` 再渲染(`TodayPage.tsx:35`),`review` 任务先进阅读器;Settings 仅 `remindTime`;`localDate.ts` 有 DEV 受控日期。

## 文件结构(新增/主要改动)

```
core/src/
├─ db.rs             ← v5(加法):feynman_session.extra_kind、study_minutes、partial unique index
├─ session.rs        ← 按 kind/extra_kind 选 system prompt;extra 会话不写 eval_json
├─ prompts.rs        ← review_quiz_system(ctx, kind)(提问,无 JSON 子句);extra_* system prompt
├─ verdict.rs        ← review/retest 分支落库 eval.weak_points
├─ extra.rs          ← 新:附加环节 start/finish + artifact + outbox extra_archive
├─ pomodoro.rs       ← 新:纯状态机(Idle/Work/Break/Paused,ends_at)
├─ notify.rs         ← 新:提醒判定纯函数 + 幂等标记
├─ stats.rs          ← 扩展:StatsDetail 三区
├─ memory.rs         ← profile 分节读写(经 outbox git_commit)、_applications/_methodology/_notes 投影
└─ library.rs        ← finish_book
web/src-tauri/src/
├─ pomodoro.rs / notify.rs ← 壳层线程:ticker(托盘标题/事件/通知)、分钟级提醒
├─ commands/mod.rs   ← pomodoro_*、planning_check_behind、planning_get_plan、extra_*、profile_*、stats_detail、library_finish_book
└─ lib.rs            ← run():注册通知插件、启动线程、退出停表
web/src/
├─ backend/{types,mock,tauri}.ts + shared/tauri-wire-contract.json + contract.test.ts + tauri.test.ts
├─ types.ts(SessionView.extraKind、Replan、PomodoroSnapshot、Profile、StatsDetail)
├─ features/today/{TodayPage,Pomodoro,ReplanDialog}.tsx
├─ features/feynman/{FeynmanPage,ExtraStage}.tsx(opener 回合渲染为系统提示)
├─ features/settings/SettingsPage.tsx(晚间提醒、学习者画像)
├─ features/stats/StatsPage.tsx(三区)
└─ config.ts
docs/smoke/m2-gate.md  ← 新:M2 桌面验收清单
```

---

### Task T0: schema v5(加法迁移,半天)

**Files:** `core/src/db.rs`, `core/tests/foundation.rs`(v4→v5 用例), `TECH_DESIGN.md` §4

- [x] **T0.1 失败测试**:v4 库(含 feynman_session/session_turn 各若干行)迁到 v5 后:`session_turn` 行数不变、三个 partial unique index 仍在(`db.rs:235-237`)、`user_version=5`;新列/表存在;二次 `migrate` 幂等;`open_creates_base_tables` 的版本断言(`db.rs:296`)更新。
- [x] **T0.2 实现(仅 ALTER/CREATE,不重建)**:`ALTER TABLE feynman_session ADD COLUMN extra_kind TEXT CHECK(extra_kind IN ('application','methodology','discussion'))`(NULL = 普通会话);`CREATE UNIQUE INDEX feynman_session_extra_once ON feynman_session(block_id, extra_kind) WHERE extra_kind IS NOT NULL`;`CREATE TABLE study_minutes(id PK, date TEXT NOT NULL, book_id INTEGER, task_id INTEGER REFERENCES daily_task(id) ON DELETE SET NULL, minutes INTEGER NOT NULL, source TEXT NOT NULL CHECK(source IN ('pomodoro')), created_at TEXT NOT NULL)` + `(date)` 索引。TECH_DESIGN §4 补 v5。
- [x] **T0.3** core 门禁;PR `feat/m2-t0-schema-v5`。

### Task T1: 间隔复习与薄弱点重考的"快问"会话(core + web,1 天;依赖 T0)

**Files:** `core/src/{prompts.rs,session.rs,verdict.rs,sched.rs}`, `core/tests/m1_engine.rs`(扩), `web/src/features/today/TodayPage.tsx`, `web/src/features/feynman/FeynmanPage.tsx`, `web/src/backend/mock.ts`, `web/src/config.ts`

- [x] **T1.1 失败测试(core)**:①`prompts::review_quiz_system(ctx, kind)` 只负责**提问**(重考:优先考该块 open 薄弱点;复习:1–2 个快问、3 分钟),**不含 JSON 子句**;评分复用 `eval_prompt`/`EvalResult`。②`submit_turn` 对 kind=`review`/`retest` 的会话,provider 收到的 `system` 以 `review_quiz_system` 为基底;`learn` 仍为 `feynman_system`。③**开场协议**(不改 core 回合协议):前端以固定 `clientTurnId='opener'`、文本 `"请开始快问"`(重考:`"请针对我的薄弱点提问"`)提交首轮,学生回复即为问题;core 用例按此模拟。④`confirm_session_verdict` 的 review/retest 分支落库 `eval.weak_points` 为新薄弱点(去重:同块同标题 open 者不重复),`on_review_result` 失败时仅当 eval 无薄弱点才插通用条目;m1_engine 扩展:"复习失败 → stage 重置 1 + 具体薄弱点"、"重考连续 2 次通过 → fixed"。⑤review/retest 会话 6 轮后学生强制 `READY_TO_END`(`session::MAX_TURNS_BY_KIND`)。
- [x] **T1.2 实现(core)**:如上;`review_quiz_prompt` 旧构造器改名为 `review_quiz_grading_prompt` 保留(M3 终评可能复用)或删除并更新其单测。
- [x] **T1.3 web**(范围决定:保留 `completeTask` 的"完成"按钮流,原生显示"完成暂不可用",清理留 T9):TodayPage 的 `review` 任务直达 `/feynman/<taskId>`(卡片保留"回看原文"链接到阅读器);FeynmanPage 对 review/retest 会话:进入后若 transcript 为空则自动提交 opener(经 `useBackendOperation`,幂等 id 固定);opener 回合渲染为系统提示条而非用户气泡;标题/提示("间隔复习 · 快问,约 5 分钟" / "薄弱点重考 · 优先讲清曾经混淆之处")用 `config.ts` 文案;Mock 的 `submitTurn` 对 opener 返回快问文案。vitest:today 导航、opener 自动提交且重进不重复、标题/提示。
- [x] **T1.4** 门禁 + DEVLOG + PR `feat/m2-t1-review-quiz`。

### Task T4: 落后重排确认(半天;不依赖 T0)

**Files:** `core/src/sched.rs`, `core/src/planning.rs`(`get_plan`), `web/src-tauri/{dto,application,commands,lib,tests}`, 契约六处, `web/src/backend/{types,mock,tauri}.ts`, `web/src/features/today/{ReplanDialog,TodayPage}.tsx`, `web/src/config.ts`

- [x] **T4.1 失败测试**:core `check_behind` 返回 `Replan{behind, missed_days, remaining_blocks, remaining_days, suggested_daily, exceeds_cap, deadline, daily_cap}`(补字段与单测;无主攻计划返回 `behind=false` 而非错误);`planning::get_plan(conn, book_id) -> Option<StudyPlan>`;壳层 `planning_check_behind[bookId, date]` → `ReplanDto`、`planning_get_plan[bookId]` → `StudyPlan|null`。应用决策不加写命令:顺延 = `planning_set_plan`(以 `get_plan` 现值为底只改 deadline),缩减 = `map_confirm` 的 `setSkipped` ops(前端按 seq 从后往前挑未学块)。
- [x] **T4.2 web**:TodayPage **先** `checkBehind(activeBookId, today)` **再** `todayQueue(today)`(`check_behind` 会改写 `daily_new_blocks`,必须在当日队列生成前);`behind && exceeds_cap` → `ReplanDialog`(①顺延截止到自动算出的日期 ②缩减地图:标记 N 个块跳过并列出;取消 = 本日不再弹,**不改期限**,以 `localStorage['bookLearner.replanDismissed']=<date>` 记住);`behind && !exceeds_cap` → 顶部提示条"已按剩余天数均摊,今日 X 块"。Mock 同语义(含 `getPlan`)。vitest:两分支、取消、顺序。
- [x] **T4.3** 门禁(src-tauri 由 CI macos 任务验证:隧道断开期间以 CI 为 Mac 门禁);DEVLOG;PR `feat/m2-t4-replan`。

### Task T8: 单主攻书补完与回归(半天;不依赖 T0)

**Files:** `core/src/{sched.rs,library.rs}`, `web/src-tauri/{...}`, 契约六处, `web/src/backend/{types,mock,tauri}.ts`, `web/src/features/library/LibraryPage.tsx`

- [x] **T8.1 失败测试(core)**:暂停书与已学完书的到期复习仍汇入今日队列(`generate_daily` 复习查询不按主攻书过滤——补回归用例);暂停书计划 `active=0` 不产新块;新增 `library::finish_book(conn, book_id)`(状态 → finished、计划 active=0;若该书为主攻则全局无主攻);`set_active_book` 对 finished 书 → Conflict("已学完的书不能设为主攻,其复习照常")。
- [x] **T8.2 壳层/契约/web**:`library_finish_book[bookId]`;书架卡片 已暂停/已学完 徽标、"复习照常"说明、"标记为已学完"确认;切换确认文案含"当前书计划冻结";Mock 同语义。
- [x] **T8.3** 门禁(src-tauri 由 CI 验证);DEVLOG;PR `feat/m2-t8-single-active`。

### Task T2: 提醒判定与系统通知(半天;不依赖 T0)

**Files:** `core/src/{notify.rs(新),settings.rs}`, `shared/app-defaults.json`, `web/src-tauri/{Cargo.toml,capabilities/default.json,tauri.conf.json,src/notify.rs,src/lib.rs}`, `web/src/{types.ts,config.ts}`, `web/src/backend/{mock,tauri}.ts`, `web/src/features/settings/SettingsPage.tsx`, `tauri.test.ts` fixture

- [x] **T2.1 失败测试(core)**:`AppSettings` 增 `evening_remind_time`(默认 22:00,HH:mm 校验;`setting` 表是**唯一权威**,`study_plan.remind_time/evening_remind_time` 列保留但视为废弃,记入 TECH_DESIGN §4);`notify::decide(now_hm, date, &settings, pending_today: Option<usize>, &SentMarks) -> Option<Reminder>`:到达 `remind_time` 分钟(允许 ≤2 分钟迟到)且当日未发 → `Daily`(**无条件**,PRODUCT_SPEC §6);到达 `evening_remind_time` 且 `pending_today > 0` 且未发 → `Evening`;同日不重复、跨日重置;`mark_sent(conn, date, kind)` 写 `setting` 键 `notified:<kind>:<date>`。契约变更:`AppSettingsDto`/TS `AppSettings`/`app-defaults.json`/Mock/Settings 页/`tauri.test.ts` fixture 同 commit。
- [x] **T2.2 实现(壳层)**(由 CI macos 任务编译验证;通知到点目检待桌面会话):`tauri-plugin-notification` + capabilities `notification:default`;`notify.rs` 在 `run()` 内起线程,**持一条长连接**(不每次 `open_connection`),每 30s:`chrono::Local` 取 `HH:MM` 与本地日期(仅用于"到点";落库/队列日期同此本地日期——与前端 `localCalendarDate()` 一致,DEV 受控日期不影响提醒,记入文档)→ 晚间检查时若当日队列未生成则 `today_queue`(幂等)取 pending 数 → `decide` → 发通知 → `mark_sent`。首次发送前请求权限。
- [x] **T2.3** 门禁(`docs/smoke/m2-gate.md` 已建,§1 为通知目检项);`docs/smoke/m2-gate.md` 目检项(以 `--bundles app` 的 .app 运行、关窗常驻到点收到两类通知);DEVLOG;PR `feat/m2-t2-notify`。

### Task T3: Rust 番茄钟状态机 + 托盘倒计时(1 天;依赖 T0)

**Files:** `core/src/{pomodoro.rs(新),stats.rs}`, `web/src-tauri/src/{pomodoro.rs,commands/mod.rs,lib.rs,state.rs}`, 契约六处, `web/src/backend/{types,mock,tauri}.ts`, `web/src/features/today/{Pomodoro,TodayPage}.tsx`, `TECH_DESIGN.md` §4

- [x] **T3.1 失败测试(core)**:`pomodoro::Machine`:`start(task_id, date, now, work_min, break_min)` → `Work{ends_at}`;`tick(now)` 到点 → `Break` + `Transition::WorkDone{minutes,date,task_id}`;Break 到点 → `Idle` + `BreakDone`;`pause/resume` 保留剩余秒;`stop` → `Idle` + 已专注整分钟;`Snapshot{phase, endsAt, taskId, remainingSecs}` 可序列化;`WorkDone`/`stop` 落 `study_minutes`(date 来自 `start` 的前端日期);`stats::compute.minutes_today = max(est_done_sum, pomodoro_sum)`。
- [x] **T3.2 实现(壳层)**(由 CI macos 任务编译验证;托盘倒计时/通知目检待桌面会话):`AppState` 持 `Mutex<Machine>`;command `pomodoro_start[taskId, date]`、`pomodoro_pause`、`pomodoro_resume`、`pomodoro_stop`、`pomodoro_state` → `PomodoroSnapshotDto`;ticker 线程每 1s `tick`:阶段变化时发事件 `POMODORO_CHANGED_EVENT`(常量)+ 系统通知;托盘标题 `●MM:SS`/`○MM:SS`(空闲清空;**无托盘时静默跳过**);`orderly_shutdown` 前 `stop` 并落分钟。契约六处 + Mock(`setTimeout` 模拟)。
- [x] **T3.3 web**:`Pomodoro.tsx` 订阅快照(启动 `pomodoroState()` + 事件),倒计时用 `endsAt - Date.now()` 渲染;TodayPage 任务卡"开始专注";vitest:快照渲染、事件更新、停止回写。
- [x] **T3.4** 门禁(壳层用例:command 往返、退出前停表落分钟);桌面目检入 `m2-gate.md`;DEVLOG;PR `feat/m2-t3-pomodoro`。

### Task T6: 学习者画像编辑(半天;不依赖 T0)

**Files:** `core/src/{memory.rs,projection.rs,session.rs}`, `web/src-tauri/{...}`, 契约六处, `web/src/backend/{types,mock,tauri}.ts`, `web/src/features/settings/SettingsPage.tsx`

- [x] **T6.1 失败测试(core)**:`MemoryStore::profile_sections() -> ProfileSections{background, mastered, pitfalls, context}`;`write_profile_sections(&ProfileSections)` 原子写并保留未知小节,**不直接 git commit**——写后入队 outbox `git_commit{message:"profile: 更新画像"}`(新增该幂等投影种类,`run_pending` 时 commit;与 `session_confirm_verdict` 的后台重放不再竞争 index.lock);`profile_summary_for(ty)`:教材/方法论追加"个人情境"节,人文只前两节;`application::session_context` 先取书类型再取摘要。
- [x] **T6.2 壳层/契约/前端**:`profile_get` → `ProfileDto`,`profile_save[profile]` → unit(保存后触发 `run_startup_recovery` 同款后台重放);设置页"学习者画像"分区(知识背景 / 个人情境文本域,误区模式只读);Mock 内存实现。
- [x] **T6.3** 门禁;DEVLOG;PR `feat/m2-t6-profile`。

### Task T5: 三类书通过后附加环节(1.5 天;依赖 T0、T1、T6)

**Files:** `core/src/{extra.rs(新),session.rs,prompts.rs,projection.rs,memory.rs}`, `web/src-tauri/{...}`, 契约六处, `web/src/{types.ts}`, `web/src/backend/{types,mock,tauri}.ts`, `web/src/features/feynman/{ExtraStage,FeynmanPage}.tsx`

- [ ] **T5.1 失败测试(core)**:`extra::start(conn, block_id, kind, client_request_id) -> SessionView`:仅当该块存在 `state='confirmed'` 且通过的 `learn` 会话;写 `feynman_session(kind='learn', extra_kind=kind, task_id NULL, client_request_id)`(partial unique index 保证每块每类一次,重复 start 返回既有);`submit_turn` 按 `extra_kind` 选 system prompt(§6.4/6.5/6.6 的 `extra_application_system/extra_methodology_system/extra_discussion_system`,由现有构造器改造,不含 JSON 子句),**开场协议同 T1**(前端 opener:"请出题" / "请引导" / "请提出对立视角");轮次上限:方法论 3、其余 2;`extra::finish(conn, provider, session_id, expected_version, request_id) -> ExtraOutcome{kind, artifact_id, version}`:provider 以整理 prompt 输出 markdown(应用题:评语 + 掌握判断;方法论:「我的版本」;讨论:思考整理稿),写 `artifact(book_id, kind, content_md, created_at)`(kind 映射:application→`application`、methodology→`methodology`、discussion→`reflection`),会话 `state='confirmed'`、**不写 `eval_json`**(`fixed_context_for_block` 只解析 EvalResult),入队 outbox `extra_archive{artifact_id}` → 投影追加到 `_applications.md`/`_methodology.md`/`_notes.md`(op_id 判重幂等)+ git commit。
- [ ] **T5.2 壳层/契约**:`extra_start[blockId, kind, clientRequestId]` → `SessionViewDto`(`SessionViewDto`/TS `SessionView` 增 `extraKind: 'application'|'methodology'|'discussion'|null`,解码器与 Mock 同步;`kind` 仍为 `learn`);回合复用 `session_submit_turn`;`extra_finish[sessionId, expectedVersion, requestId]` → `ExtraOutcomeDto`;判定不改块状态、不动任务。
- [ ] **T5.3 web**:FeynmanPage 确认"通过"后(仅 new 任务)出现 `ExtraStage` 卡:按书类型标题(迁移应用题 / 情境化方法论 / 观点讨论)、"开始"/"跳过";对话复用回合组件与 opener 机制;结束显示整理稿与"已归档到 …md";跳过不阻塞。vitest:三类分支、跳过、归档文案。
- [ ] **T5.4** 门禁;DEVLOG;PR `feat/m2-t5-extra-stage`。

### Task T7: 统计页三区(1 天;依赖 T3)

**Files:** `core/src/stats.rs`, `web/src-tauri/{...}`, 契约六处, `web/src/backend/{types,mock,tauri}.ts`, `web/src/features/stats/StatsPage.tsx`

- [ ] **T7.1 失败测试(core)**:`stats::detail(conn, date) -> StatsDetail`:进度区 `books[]{id,title,total,passed,consolidated,deadline,projected_finish}`(按最近 7 天日均通过数外推;0 → null);投入区 `days[14]{date,minutes,pomodoros}`(minutes 同 `compute` 的合并规则)、`streak_calendar[56]{date,active}`;质量区 `weak_trend[14]{date,opened,fixed}`、`avg_scores`(最近 10 次评估均值)、`review_pass_rate`(近 30 天:`daily_task.kind='review' AND status='done'` 经 `ref_id` 关联 `review_schedule.status` 的 done/(done+failed),按 `daily_task.date` 取窗口)。主攻书范围(投入区不分书)。
- [ ] **T7.2 壳层/契约/前端**:`stats_detail[date]` → `StatsDetailDto`;StatsPage 三区(纯 CSS/SVG 图,遵守 `tokens.css`);Mock 确定性数据。vitest:渲染与空态。
- [ ] **T7.3** 门禁;DEVLOG;PR `feat/m2-t7-stats-detail`。

### Task T9: M2 门禁与回写(半天)

- [ ] **T9.1** `docs/smoke/m2-gate.md`:以 `pnpm -C web tauri build --debug --bundles app` 的 .app 运行;三类书各学 ≥2 块含附加环节;推进受控日期制造连续 2 天落后 → 重排弹窗两分支;关窗常驻下到点通知(每日/晚间)、番茄钟托盘倒计时与结束通知;第 1 天通过的块第 2 天出现复习并以快问完成;已学完书的复习照常。
- [ ] **T9.2** 全量门禁(三套测试、clippy、fmt、lint、tsc、build、debug/release 构建、干净目录冒烟);回写 IMPLEMENTATION_PLAN M2 状态、CLAUDE.md、TECH_DESIGN §4/§10;DEVLOG 收尾;签字后 main 打 `m2`。

## 完成定义(DoD)

1. 每个 Task:RED → GREEN → 全量门禁 → 勾选 → DEVLOG → PR → CI 绿 → 合并;契约六处 + Mock 同步在同一 commit。
2. 长驻逻辑(通知判定、番茄钟)为纯状态机且有单测;副作用只在壳层线程内;日期来自前端或与前端一致的本地日历日。
3. schema v5 只做加法;v4→v5 用例证明 `session_turn` 不丢、索引不丢、幂等。
4. 记忆库写入一律经 outbox(含 profile 与附加环节归档),幂等可重放。
5. `docs/smoke/m2-gate.md` 签字后打 `m2`。

## 预计工时

T0 半天 · T1 1 天 · T4 半天 · T8 半天 · T2 半天 · T3 1 天 · T6 半天 · T5 1.5 天 · T7 1 天 · T9 半天 ≈ **7 个工作日**。顺序:**T0 → T1 → T4 → T8 → T2 → T3 → T6 → T5 → T7 → T9**。

## 评审记录

- 2026-09-08 独立评审 14 条问题全部并入:v5 重建会级联删 `session_turn`(改为加列)、`artifact` 真实结构、v5 双重声明(并入 T0)、`review_quiz_prompt` 含 JSON 子句与"AI 先开口"违反回合协议(拆提问/评分 + 前端 opener)、新会话 kind 破坏 TS 解码器(改 `extraKind`)、契约同步为六处、`check_behind` 有副作用需先于队列生成、通知权威与无条件每日提醒、番茄钟日期来自前端与 `study_minutes.task_id` 可空、复习通过率数据源、profile 写入经 outbox、`finish_book` 缺失、macOS 通知需 bundle。
