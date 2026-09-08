# M3 体验完善 Implementation Plan(终评、导出、语音、阅读器、数据安全、收尾)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 M2 之上交付 IMPLEMENTATION_PLAN §M3 的六项:整书终评与学习报告;Obsidian 导出;whisper 本地语音输入;阅读器打磨(高亮/书签/排版/出版方样式开关);数据安全(SQLite 快照、git 远程 push、恢复入口);收尾(文案、性能、可分发 dmg)。**M3 验收**(IMPLEMENTATION_PLAN):全程语音学完一个块;导出后在 Obsidian 中链接与 frontmatter 正确;一本书完整学完产出学习报告;打包后的 app 在干净 macOS 用户下可运行。

**Architecture:** 延续 M1/M2 约定——SQLite 事实源、md/git 为 outbox 投影(记忆库写入**一律经 outbox**);Tauri command 薄层 + `application` 用例 + core 用例;慢命令 `open_connection()` + `JobGuard`;`date` 由前端本地日历日提供;行为参数只进 `web/src/config.ts`;**契约同步六处同一 commit**(JSON / `WIRE_COMMANDS` / `register_commands` / foundation wire payload / `contract.test.ts` / `tauri.test.ts`)+ Mock 同语义;schema 只做加法(v6);长驻/副作用只在壳层线程。新增原则:**文件系统输出(导出、快照)都写到用户可见路径,先写临时文件再原子改名;任何第三方二进制/模型都经设置页可见、可卸载。**

**Tech Stack:** 同 M2;新增 `whisper-rs`(需 Mac 上 `cmake`,经 Homebrew 安装;模型 `ggml-large-v3-turbo-q5_0` ≈ 570 MB 与 `ggml-small` ≈ 470 MB 从 Hugging Face 下载,经代理)、webview `MediaRecorder` + `AudioContext.decodeAudioData` 重采样到 16 kHz 单声道 PCM;`tauri-plugin-shell`(可选,打开导出目录用 `opener` 亦可);打包 `tauri build --bundles dmg`(ad-hoc 签名;Developer ID 签名/公证留给用户凭证)。

**Spec 依据:** PRODUCT_SPEC §3.4/§3.7/§7/§8;TECH_DESIGN §6.8、§7.1、§8、§9、§4(v6 加法)。**范围外:** TTS(仅 trait 预留)、开机自启、多用户/云同步、DRM。

**执行环境:** core/web 在 Linux;src-tauri、whisper 编译、dmg 在 Mac(经隧道 `bl-run.sh` + scp 脚本);语音录制、Obsidian 目检、dmg 安装需桌面会话,记入 `docs/smoke/m3-gate.md`。分支:每 Task 一个 `feat/m3-tN-*` → PR → CI 绿 → 合并。

---

## 现状盘点(2026-09-08)

- **终评**:`feynman_session.kind` 已含 `final_exam`(`db.rs:97`),但 `block_id NOT NULL` 且无 book 级会话;`prompts::final_exam_prompt(map_summary)` 为单段含 JSON 子句的 prompt(`prompts.rs:177`),不能直接当回合 system prompt(同 M2 拆法);`artifact.kind` 已含 `report`;`library::finish_book` 存在(用户手动)。
- **导出**:`settings.obsidian_vault` 已存(默认 `~/Obsidian/book-learner`),设置页可编辑;记忆库已有 `books/<slug>/{_map.md,_weakpoints.md,blocks/NNNN-<slug>.md,_applications.md,_methodology.md,_notes.md}`(后三者按附加环节产生);`artifact` 表有 application/methodology/reflection 行。无导出器。
- **语音**:设置页 `whisper 模型` 字段为禁用占位;core/壳层无音频代码;费曼页 🎙 按钮禁用;Mac 无 `cmake`/`ffmpeg`/`whisper-cli`。
- **阅读器**:`EpubView` 已有三主题(`themes.register`)、字号档;无高亮/书签持久化、无出版方样式覆盖开关;学习模式块范围高亮与手动锚点校正(§7.2)自 M1 延后;`block_anchor` 段有两点 CFI。
- **数据安全**:记忆库 git 仅本地 commit(`memory::commit`);设置页 `记忆库 git 远程` 禁用占位;无 SQLite 快照;地图删除块已是 `skipped` 软删。
- **收尾**:`orderly_shutdown` 有宽限;导入走分块原始请求体;CI macos 任务 `tauri build --debug`;`docs/smoke/` 已有 mac-m1/m1-e2e/m2 三份门禁(均待桌面签字)。

## 文件结构(新增/主要改动)

```
core/src/
├─ db.rs          ← v6(加法):feynman_session.book_id(NULL;终评会话)、reader_mark(高亮/书签)、snapshot 记录不入库(文件系统)
├─ final_exam.rs  ← 新:start/finish(三阶段会话 + 报告 artifact + outbox report_archive + finish_book)
├─ prompts.rs     ← final_exam_system(阶段化,无 JSON)、final_report_prompt(只输出 markdown)
├─ export.rs      ← 新:Obsidian 导出树(frontmatter + 记忆库 md 变换 + artifact),原子写、增量覆盖
├─ reader_marks.rs← 新:高亮/书签 CRUD(按 book/spine href/CFI)
├─ backup.rs      ← 新:VACUUM INTO 快照与保留策略;git push 投影种类
├─ memory.rs      ← push_remote(可选 remote,失败可重试)、report 归档
└─ voice/(壳层)  ← 语音只在壳层:whisper-rs 绑定、模型管理
web/src-tauri/src/
├─ voice.rs       ← 新:模型目录/下载(带进度事件)/转写命令(原始请求体 PCM)
├─ backup.rs      ← 新:退出前快照、启动时恢复入口
└─ commands/…     ← final_exam_*、export_obsidian、reader_mark_*、voice_*、backup_*、git_remote_*
web/src/features/
├─ feynman/FinalExamPage.tsx、VoiceInput.tsx
├─ library/ExportDialog.tsx
├─ reader/(高亮/书签面板、排版设置、出版方样式开关)
└─ settings/(语音模型、git 远程、快照/恢复)
docs/smoke/m3-gate.md
```

---

## Task T1: 整书终评与学习报告(1.5 天;不依赖其它 Task)

**Files:** `core/src/{db.rs,final_exam.rs(新),prompts.rs,session.rs,projection.rs,memory.rs,library.rs}`、壳层与契约六处、`web/src/{types.ts,config.ts}`、`web/src/backend/{types,mock,tauri}.ts`、`web/src/features/{library/LibraryPage.tsx,map/MapPage.tsx,feynman/FinalExamPage.tsx(新)}`

- [x] **T1.1 失败测试(core)**:v6 加列 `feynman_session.book_id INTEGER REFERENCES book(id) ON DELETE CASCADE`(默认 NULL,v4 有同类先例 `db.rs:233`;终评会话 `block_id` 取该书 seq 最小的未跳过块作占位并写 `book_id`,占位块选择写进用例);`final_exam::eligible(conn, book_id) -> bool`(书 `import_state='mapped'`、未跳过块 ≥1 且全部 ∈ {passed, consolidated};**不看 `finished`**——手动"标记为已学完"的书仍可终评,报告有价值且 `finish_book` 幂等);`final_exam::start(conn, book_id, client_request_id) -> SessionView`(kind=`final_exam`;partial unique `feynman_session_final_once(book_id) WHERE kind='final_exam' AND state<>'abandoned'`,"返回既有"只匹配非 abandoned 行,补用例"放弃后可重开");`submit_turn` 当 `kind='final_exam'` 时**自查上下文**:由 `feynman_session.book_id` 取 `models::list_blocks` + `sched::list_weakpoints` 组装 `map_summary`,由 `session_turn` 学生回合数得 `phase`,system prompt 为 `prompts::final_exam_system(ty, profile_summary, map_summary, phase)`(仍注入画像摘要:教材综合应用题依赖"个人情境"):①0–2 回合追问全书框架;②之后出 2–3 道跨章综合题(按书类型);学生回合上限 8 强制 `[READY_TO_END]`;壳层 `session_context` 对终评会话**跳过** `fixed_context_for_block`(否则白算占位块原文);`verdict::request_evaluation` 增加 `kind='final_exam'` → Conflict(与 `extra_kind` 守卫并列),并以用例固化"终评会话永不写 `eval_json`"(`fixed_context_for_block`、`stats::detail` 都靠 `eval_json IS NOT NULL` 过滤,现有 SQL 不改);`final_exam::finish(...) -> FinalReport{artifact_id, version, content_md, overall, strongest_module, weakest_module}`:报告 prompt `final_report_prompt(map_summary, weak_history, transcript)` 只输出 markdown 且首行为 `<!-- overall:N strongest:… weakest:… -->` 元注释;**transcript 与弱点史截断**(codex prompt 走 argv,ADR-0004 记有 100 KiB 上限);解析走 `run_ai_json<T>`(把纠错文案参数化:markdown 解析失败时提示"只输出以元注释开头的 markdown",不再硬编码"只输出 JSON");写 `artifact(kind='report')`,会话 confirmed 且**不写 eval_json**;入队 `report_archive{artifact_id, entry_key}`(投影写 `books/<slug>/_report.md`,`entry_key` 幂等,照 `extra_archive` 写)+ `git_commit`;完成书状态改用新提取的 `library::finish_book_in(tx)`(两条 UPDATE,`finish_book` 与终评共用,**不能在事务 B 内再调 `finish_book`**——它自己开 IMMEDIATE 事务会报 nested transaction)。
- [x] **T1.2 壳层/契约**:`final_exam_eligible[bookId]` → bool;`final_exam_start[bookId, clientRequestId]` → `SessionViewDto`(`SessionViewDto` 增 `book_id: Option<i64>`;TS `SessionView.bookId: number | null`,`decodeSessionView` 改可空);回合复用 `session_submit_turn`;`final_exam_finish[sessionId, expectedVersion, requestId]` → `FinalReportDto`;结束后后台重放投影。foundation 用例:未全通过 → conflict;全通过 → 开始/回合/结束 → artifact report、书 finished、`_report.md`、git log;终评会话 `session_request_evaluation` → conflict;`session_confirm_verdict` 因 `task_id` NULL 自然 conflict(回归用例)。
- [x] **T1.3 web**:书架卡与地图页在 `eligible` 时出现"整书终评"入口;`FinalExamPage`(复用 `Transcript.tsx` 与 opener 机制:opener「请开始终评」;阶段提示条"先讲全书框架 → 综合题";"生成学习报告"按钮 ≥3 次作答可用);报告页展示 markdown(总体掌握度、最强/最弱模块、薄弱点修复历程、建议重读章节)与"已归档到 books/<slug>/_report.md";Mock 同语义。vitest:入口条件、opener、报告展示与书状态刷新。
- [x] **T1.4** 门禁;DEVLOG;PR `feat/m3-t1-final-exam`。

## Task T2: Obsidian 导出(1 天;依赖 T1 的 report 归档种类,可先做除报告外部分)

**Files:** `core/src/export.rs(新)`、`core/src/memory.rs`、壳层 `commands/…`、契约六处、`web/src/features/library/{LibraryPage.tsx,ExportDialog.tsx(新)}`、设置页

- [ ] **T2.1 失败测试(core)**:`export::plan(conn, book_id, target_dir) -> ExportPlan{root, files: Vec<ExportFile{rel_path, content}>}`——**只读 SQLite**(ADR-0001:md 不是任何用例的读取来源;`eval_json.final_restatement`、`weak_point`、`artifact.content_md` 在库里齐全;codex 自由追加的"AI 观察笔记"如需带出,由 application 层先 `run_pending(main)` 再读块 md 附加,记为可选);设置项 `obsidianVault` 的语义**定为目标目录**(默认值 `~/Obsidian/book-learner` 保持,不再拼第二层 `book-learner/`),`~` 由 application 层用 HOME 展开后传入 core;结构按 TECH_DESIGN §9:`<目标>/<书名>/00-学习报告.md`(artifact report;无则占位说明)、`01-我的方法论.md`(方法论书;methodology artifact 合并)、`blocks/<seq>-<块名>.md`(复述终稿 + 评估历史 + 薄弱点演变)、`notes/<seq>-<块名>.md`(人文书 reflection)、`applications/<seq>-<块名>.md`(教材书 application);**所有块级文件统一 `<seq>-` 前缀**(块标题无唯一约束);文件名安全化沿用 `memory::validate_slug` 思路:去 `/\:*?"<>|` 与控制字符、去首尾空白与点、禁 `.`/`..`/空、限 120 字节;**wikilink 约定**(M3 验收"链接正确"):`00-学习报告.md` 链到各 `[[blocks/<seq>-<块名>]]`,块文件链到 `[[00-学习报告]]` 与同模块相邻块,`notes/applications` 回链块文件,用例校验链接目标都在导出清单内;frontmatter `book / block / seq / status / scores / passed_at / tags: [book-learner, <书名>]`;`export::write(plan) -> ExportReport{written, unchanged, dir}`:内容相同不写(增量),临时文件 + `sync_all` + rename;目标目录不存在 → InvalidInput(不自动创建目标根,只创建 `<书名>/` 及子目录);只覆盖清单内文件,不删除其它文件。
- [ ] **T2.2 壳层/契约/web**:`export_obsidian[bookId]` → `ExportReportDto`(慢命令,`JobGuard`);`export_preview[bookId]` → 文件清单(不写盘);书架卡"导出到 Obsidian"→ `ExportDialog`(预览清单 → 确认 → 结果与"在 Finder 中显示"经 `opener`);设置页导出分区显示目标目录校验状态(存在/可写)。Mock 内存实现。
- [ ] **T2.3** 门禁;DEVLOG;PR `feat/m3-t2-obsidian-export`。

## Task T3: whisper 本地语音输入(2 天;Mac 编译;不依赖其它 Task)

**Files:** `web/src-tauri/{Cargo.toml,src/voice.rs(新),src/commands/…}`、契约六处、`web/src/features/feynman/VoiceInput.tsx(新)`、`FeynmanPage.tsx`/`ExtraStage.tsx`、设置页语音分区、`web/src/audio/pcm.ts(新)`

- [ ] **T3.0 前置(Mac,先 spike 再开工)**:`brew install cmake`(记录到 DEVLOG 与 CLAUDE.md 环境要求;CI macos-14 自带 cmake);**`web/src-tauri/Info.plist` 加 `NSMicrophoneUsageDescription`**(tauri-build 会嵌入 dev 与 bundle;缺它 TCC 会直接杀进程);5 分钟 spike:当前 wry 版本下 WKWebView `getUserMedia` 能否弹出权限并拿到流(wry 经 `WKUIDelegate` 授权,需实测)——**不行则回退为 Rust 侧 `cpal` 录音**(同样需 Info.plist,绕开 WebView 与 IPC 大体);`whisper-rs` 加入 `Cargo.toml` **feature `voice`(默认开启)**,只进 src-tauri(Linux core 任务不受影响),记录 CI macos 任务耗时(>10 分钟则 CI 用 `--no-default-features` 并另设手动工作流)。
- [ ] **T3.1 壳层(Mac)**:`voice.rs`:模型目录 `<data_dir>/models/`;`voice_models[]` → 列表(名称、大小、是否已存在、当前选择);**基线为手动导入模型文件**(`voice_import_model[]`:rfd 选文件 → 校验大小/扩展名(可选 SHA)→ 移入 `models/`),`voice_download[name, proxyUrl?]` 为可选(壳层无 HTTP 客户端且 Finder 启动的 app 不继承 shell 代理变量:加 `reqwest`(rustls)并在设置页提供代理 URL / 镜像地址字段;后台线程 + 事件 `voice_download_progress{name, received, total}`,临时文件原子改名,`JobGuard`);`voice_delete[name]` 只删 `models/` 白名单内的文件;`voice_transcribe`(原始请求体 = **16 kHz 单声道 i16 PCM**,头部 `x-bl-lang`;沿用导入的分块协议上限(单块 ≤ 8 MiB),前端限录音 ≤ 120 s 自动停止;`whisper-rs` `full()` 中文 `zh`,`initial_prompt` 为当前块标题;返回 `{ text, seconds }`;模型实例按选择懒加载缓存在 `AppState`;并发转写串行化;超时值按 DEVLOG 实测时延定)。设置键 `voiceModel` 直读 `setting` 表(与 `codexBin` 先例一致,**不进 `AppSettings`**)。foundation 用例只测模型目录/列表/导入校验/删除白名单与转写输入校验(不加载模型;真实转写用 `#[ignore]` 的本机用例)。
- [ ] **T3.2 web**:`audio/pcm.ts`:`MediaRecorder` 录制 → `decodeAudioData` → `OfflineAudioContext` 重采样 16 kHz 单声道 → `Int16Array`;`VoiceInput`(按住说话/点击起止,电平提示,转写中态,结果**填入输入框可编辑**不直接发送);费曼页与附加环节的 🎙 按钮启用(Mock 返回固定文本);设置页"语音"分区:模型列表/导入/下载进度/删除/选择,输入设备选择(`enumerateDevices`);权限拒绝与无模型的错误态文案;`voice_transcribe` 在 `contract.test.ts` 走原始请求体的特殊分支,`voice_download_progress` 事件按 `pomodoro_changed` 先例进 `Backend.subscribe*` 与 Mock。vitest:PCM 重采样长度与 i16 量化、VoiceInput 状态机(Mock)、设置页列表。
- [ ] **T3.3** 门禁(Mac `cargo test` 含 `voice`);DEVLOG(含真实转写时延);PR `feat/m3-t3-voice`。

## Task T4: 阅读器打磨(1.5 天;不依赖其它 Task)

**Files:** `core/src/{db.rs,reader_marks.rs(新)}`、壳层与契约六处、`web/src/features/reader/{ReaderPage.tsx,EpubView.tsx,MarksPanel.tsx(新)}`、`web/src/config.ts`

- [ ] **T4.1 失败测试(core)**:v6 表 `reader_mark(id, book_id → CASCADE, kind IN ('highlight','bookmark'), spine_href, cfi_start, cfi_end NULL(书签), text, color, note, created_at)`;`reader_marks::{add, update_note, remove, list(book_id)}`;书签同 `spine_href+cfi_start` 幂等。
- [ ] **T4.2 壳层/契约**:`reader_mark_add/update/remove/list`;foundation 用例。
- [ ] **T4.3 web**:`EpubHandle`(现只有 `next/prev/display`)扩展 `currentCfi()`、`addAnnotation(kind, rangeCfi, cls)`/`removeAnnotation`、`onSelected(cb)`、`onRelocated(cb)`;`useEffect([url])` 重建 rendition 后**重加全部注解**;高亮(选区 → 颜色 → `annotations.highlight`,重进恢复)、书签(当前页 CFI,列表跳转)、`MarksPanel`(目录/书签/高亮三页签);学习模式**多段块高亮**(自 M1 延后项):`block_anchor` 存的是两个折叠点 CFI,该章渲染后用 `EpubCFI.toRange` 两点组合成 Range,再 `section.cfiFromRange` 得区间 CFI 后 `annotations.underline`;手动锚点校正(选区 → "设为块起点/终点" → `setAnchorSegments`);阅读位置持久化(`reader_mark kind='position'` 每书一行 upsert,重开回到上次位置);排版:字体栈(`Songti SC / PingFang SC` + 可选内置霞鹜文楷 woff2 放 `web/public/fonts/` 以绝对 URL 在 iframe 主题 `@font-face` 引用,约 10 MB 进 dmg 记 DEVLOG)、**版心 38em 约束容器 div 而非 iframe body**(分页模式由 epub.js 控制 body 宽度与分栏)、行高档位(1.5/1.8/2.1,持久化)、两端对齐、`text-autospace`(macOS 15.4+ 生效,低版本忽略)、段首缩进开关、**出版方样式覆盖开关**(关闭时不注入版心/字体规则,只保留主题色);偏好持久化到 `lib/prefs.ts`;Mock。vitest:高亮/书签 CRUD 经 Mock、开关切换注入规则、多段高亮的区间 CFI 组合与调用次数、阅读位置恢复。
- [ ] **T4.4** 门禁;DEVLOG;PR `feat/m3-t4-reader-polish`。

## Task T5: 数据安全(1 天;不依赖其它 Task)

**Files:** `core/src/{backup.rs(新),memory.rs,projection.rs,settings.rs}`、壳层 `backup.rs(新)`、`lib.rs`(退出/启动钩子)、契约六处、设置页数据分区

- [ ] **T5.1 失败测试(core)**:`backup::snapshot(conn, dir, today) -> PathBuf`——在 `open_connection()` 的独立连接上 `VACUUM INTO ?1`(绑定参数传路径;先删崩溃残留的 `.tmp`,写 `.tmp` → `sync_all` → rename;同日覆盖;期间持 SHARED 锁,写事务等 busy_timeout 5 s 可接受);保留策略:最近 7 份 + **每月最早一份 × 3 个月**(不用"每月 1 日",当天不开 app 就没有);快照目录 `<data_dir>/snapshots/`(**不进 memory/ git**,与 TECH_DESIGN §3.4 "快照进 memory/" 冲突,回写 §3.4);`backup::list(dir)`;`backup::restore_plan(dir, name) -> RestorePlan`(**name 必须匹配 `app-YYYY-MM-DD.db` 且位于快照目录**,拒绝任意路径;校验 `PRAGMA integrity_check` 与 `user_version ≤ 当前`);`memory::set_remote(url)`(立即 `git ls-remote` 校验,结果返回给设置页)/`memory::push()`(有 remote 才 push;`git push -u origin HEAD`;**复用 `ai.rs` 的 `wait_with_timeout` + 进程组 kill,超时 30 s**;环境 `GIT_TERMINAL_PROMPT=0`、`GIT_SSH_COMMAND=ssh -oBatchMode=yes`,Finder 启动的 GUI 无 TTY 也不继承 shell 环境,文档要求用户先在终端完成一次凭据/known_hosts);投影 outbox 加列 `lane TEXT NOT NULL DEFAULT 'main'`(v6 加法),push 走 `lane='push'`:`run_pending(lane)` 按 lane 分别顺序处理,**同一轮只推一次**(一次成功即把该 lane 所有 pending 标 done——push 是"推 HEAD"天然合并),失败按 `attempts` 指数退避(加列 `next_retry_at`),`run_startup_recovery` 先 main 后 push;ADR-0001 第 21 条"顺序停止是有意的"补充 lane 例外。
- [ ] **T5.2 壳层/契约**:退出前(`orderly_shutdown`)与每日首次启动做快照(壳层用本地日期,与 `notify` 线程先例一致,写明不违反"date 由前端提供"的约定;`backup_snapshot_now[]` 亦可手动);`backup_list[]`、`backup_restore[name]`(写"待恢复"标记文件,下次启动前替换 `app.db` 并**连带移走 `app.db-journal`/`-wal`/`-shm`**(连接为默认回滚日志模式,热日志会回放进新库),原库保留为 `.replaced-<ts>`;恢复后对所有书入队 `sync_map`+`sync_weakpoints`(镜像文件可再生;`blocks/*.md` 追加区可能比库新,记为已知限制);不在运行中替换);`git_remote_get/set[url]`、`git_push_now[]`;设置页"数据"分区(快照列表/立即快照/恢复/记忆库远程 URL 与校验结果/立即推送/最近推送结果)。foundation 用例:快照文件与保留策略、恢复标记流程与 journal 清理、name 白名单拒绝路径、无 remote 时 push 为 no-op、push lane 一轮一推与退避。
- [ ] **T5.3** 门禁;DEVLOG;PR `feat/m3-t5-data-safety`。

## Task T6: 收尾与打包(1 天;依赖 T1–T5)

- [ ] **T6.1 文案与性能**:七页面空状态/错误态文案巡检表(记入 DEVLOG);大 EPUB(≥30 MB、≥200 章)导入:**抽取不能进 Web Worker**(`extract.ts`/`anchors.ts` 依赖 epub.js `section.document` DOM,Worker 无 `DOMParser`),改为主线程分批 `await`(每 N 章 `scheduler.yield()`/`setTimeout(0)`)+ 导入进度条;阅读器首屏 `rendition.display` 前显示骨架;设置页顺手启用"codex 可执行路径"(后端 `setting.codexBin` 已支持,UI 仍是禁用占位)。
- [ ] **T6.2 打包**:`tauri.conf.json` `bundle.active: true` + `bundle.macOS` 段(`minimumSystemVersion`、`dmg` 窗口;`icon.icns` 已存在;CI 仍 `--no-bundle`);`pnpm -C web tauri build --bundles dmg`(ad-hoc 签名);干净 macOS 用户(`sysadminctl` 新建测试账号或用户提供)安装运行冒烟——**本机生成的 dmg 无 quarantine 属性**,门禁写明经浏览器下载后需"右键打开"或 `xattr -d com.apple.quarantine` 的步骤;Developer ID 签名与 notarization 步骤写成文档(需用户证书,不在本计划执行)。
- [ ] **T6.3 门禁与回写**:`docs/smoke/m3-gate.md`(语音学完一个块;Obsidian 中链接/frontmatter 目检;整书终评产出报告;dmg 干净账号运行);IMPLEMENTATION_PLAN M3 状态、CLAUDE.md、TECH_DESIGN §3.1(`_report.md`、快照目录)/§3.4/§4(v6)/§6.8(阶段 system + 报告 prompt)/§7.1/§8/§9、ADR-0001(lane 例外);DEVLOG 收尾;签字后 main 打 `m3`。**明确范围外并回写 IMPLEMENTATION_PLAN**:profile.md"个人情境"的 AI 提取与确认流(2.3 后半)继续延后,M3 不做。

## 完成定义(DoD)

1. 每个 Task:RED → GREEN → 全量门禁 → 勾选 → DEVLOG → PR → CI 绿 → 合并;契约六处 + Mock 同一 commit。
2. schema v6 只做加法;所有新表/列有迁移用例。
3. 文件输出(导出、快照、模型)原子写;删除只删本 app 创建的文件。
4. 语音转写结果必须经用户可编辑后才发送。
5. `docs/smoke/m3-gate.md` 签字后打 `m3`。

## 预计工时

T1 1.5 天 · T2 1 天 · T3 2 天 · T4 1.5 天 · T5 1 天 · T6 1 天 ≈ **8 个工作日**。顺序:**T1 → T2 → T5 → T4 → T3 → T6**(语音编译最不确定,放在核心功能之后;T5 早做以便后续开发期间即有快照保护)。

## 评审记录

- 2026-09-08 独立评审 24 条问题全部并入(8 条阻断):`finish_book` 事务嵌套(提取 `finish_book_in(tx)`)、终评唯一索引与 `abandon_session` 冲突(索引排除 abandoned)、`submit_turn` 无 `map_summary/phase` 入口(终评会话自查上下文,壳层跳过块级上下文)、`request_evaluation` 未挡终评(加守卫并固化"不写 eval_json")、报告解析走 `run_ai_json` 并参数化纠错文案、占位块与 eligibility 边界、`_report.md`/§3.1/§6.8 回写、vault 双重嵌套与 `~` 展开、文件名安全与 `<seq>-` 前缀、wikilink 约定、导出只读 SQLite(ADR-0001)、git push 超时/无 TTY 凭据/单轮一推与退避、恢复流程 journal 清理与 name 白名单、`VACUUM INTO` 细节与快照目录不进 git、缺 `Info.plist` 麦克风声明与 `getUserMedia` spike(回退 cpal)、PCM 改 i16 + 120 s 上限、模型改手动导入为基线、多段高亮需区间 CFI 与 `EpubHandle` 扩展、版心约束容器而非 body、行距与阅读位置、Worker 抽取不可行改主线程分批、`bundle.active`/quarantine、六处同步补充(原始体分支、事件、`bookId` 可空、`voiceModel` 直读 setting)、范围外补"个人情境提取"并启用 codex 路径字段。
