# book-learner

Mac 本地 EPUB 深度学习软件:西蒙学习法(拆知识块→设目标→逐块攻克)为骨架,费曼学习法(讲给 AI 学生听→暴露漏洞→回补→通过)为闭环。Tauri 2 + React + SQLite,AI 后端为本机已登录的 codex CLI 子进程,学习记忆库为 md 目录(codex 自主读取)+ git 备份。

## 文档阅读顺序

1. `PRODUCT_SPEC.md` — 产品定义:界面、流程、三类书模板、调度与节奏规则(需求的唯一权威来源)
2. `TECH_DESIGN.md` — 技术设计:架构、记忆库、数据模型、codex 集成、全部 AI prompt、EPUB/语音/导出
3. `IMPLEMENTATION_PLAN.md` — 三期任务拆解与验收标准
4. **Mac 会话从这里开始**:`docs/superpowers/plans/2026-09-07-mac-m1-wiring.md`(M0–M8 逐 Task 执行计划:推送/PR、契约同步、F3、原生门禁、10+3 条 command 接线、ADR-0004、tray、E2E → tag `m1`);接线映射真值见 `DEVLOG.md` 末段"Mac 阶段需接线的 command 清单";Node 级状态见 `docs/superpowers/plans/2026-09-02-product-m1-implementation-baseline.md`

## 当前状态

- [x] 产品与技术设计定稿(2026-08-30,与用户四轮问答确认)
- [x] L1 core crate(Linux,feat/l1-core):db/models/eval/memory/ai/sched,31 测试绿
- [x] L2 React 前端(Linux,feat/l2-web):七页面 + MockBackend,浏览器闭环可跑,27 测试绿
- [x] Mac Foundation 本地实现(feat/mac-m1):Tauri 2 壳、类型化 IPC、8 个 SQLite 能力、显式未实现能力、七路由失败态
- [x] M1 加固切片(Linux,已并入 feat/mac-m1):公共异步 hook、费曼页错误态、Codex 子进程卫生、记忆库原子写、schema v3、并发策略
- [x] M1 core 引擎(Linux,feat/m1-core-engine,tag `m1-linux-a`):schema v4、AI 幂等编排、地图作业、地图确认、会话/回合、原子判定、投影 outbox,core 127+27+1+1 绿
- [x] M1 web 契约 v2(Linux,feat/m1-web-contract,tag `m1-linux-b`):契约/Mock/门控解码器、费曼/地图/导入向导接新契约、EPUB 抽取与多段 CFI 锚定(Playwright),web 247/2 绿
- [x] Mac 阶段代码(2026-09-07,feat/mac-m1-wiring,PR #6,经 SSH 隧道在 Apple Silicon 实施):契约常量同步、F3、独立连接/启动恢复/codex 解析、地图组 5 条、会话组 5 条、EPUB 原生导入(ADR-0004 B)、epubUrl/blockSource、stats、tray/关窗隐藏/有序退出、受控测试日期;`unsupportedCapabilities` 仅剩 `completeTask`;CI 三任务绿
- [ ] **Mac 阶段收尾(需桌面会话)**:M2 Foundation 原生冒烟签字(tag `mac-m1`)、`tauri dev` 七路由/tray/Cmd+Q 目检、真实 WebView 导入吞吐(ADR-0004)、M8.1 真书 + 真 codex 七步端到端(`docs/smoke/m1-e2e-gate.md`)→ 合并 PR #3→#4→#5→#6 → main 上 tag `m1`
- [x] M2 学习系统代码(2026-09-08,PR #9–#17 合入 main,计划 `docs/superpowers/plans/2026-09-08-m2-learning-system.md` T0–T8):schema v5、快问会话、落后重排确认、单主攻书补完、提醒通知、Rust 番茄钟 + 托盘倒计时、学习者画像编辑、三类书通过后附加环节、统计页三区;记忆库写入一律经 outbox
- [x] 三份桌面门禁(2026-09-08,经用户 SSH 隧道 + 辅助功能权限 + debug-only 自动化桥执行):`mac-m1-native-smoke.md` → tag `mac-m1`;`m1-e2e-gate.md`(真书 + 真 codex 七步,发现并修 PR #21/#22)→ tag `m1`;`m2-gate.md`(通知/托盘番茄钟/落后重排/单主攻书/快问/三类附加环节/画像/统计)→ tag `m2`。门禁脚本 `docs/smoke/scripts/`
- [ ] M3 体验完善(计划 `docs/superpowers/plans/2026-09-08-m3-experience.md`):T1 整书终评(PR #25)、T2 Obsidian 导出(PR #26)、T5 数据安全(PR #27)、T4 阅读器打磨(PR #28)已合入 main;T3 whisper 语音输入在 `feat/m3-t3-voice`;T6 收尾与打包待做

## 开发环境要求

前端/core 可在 Linux 开发;Tauri 原生发布门禁需 macOS(Apple Silicon)、Rust stable、Node 20+、pnpm、**cmake**(`brew install cmake`,whisper.cpp 经 whisper-rs 编译;M3 T3 起)、codex CLI 已安装并登录(`codex exec "hi"` 可用)。语音转写模型不随 app 分发:下载 `ggml-*.bin` 后在设置页导入。

## 约定

- 浏览器开发:`pnpm -C web dev`;原生开发:`pnpm -C web tauri dev`;基础调试构建:`pnpm -C web tauri:build:debug`
- 界面语言中文;设计决策变更须同步回写对应 SPEC 文档
- Mac Foundation 的真实能力矩阵和冒烟手册见 `docs/smoke/mac-m1-native-smoke.md`;禁止原生环境回退到 Mock 数据
- 桌面门禁可经 SSH 无人值守执行:debug 构建设 `BOOK_LEARNER_AUTOMATION_SOCK` 启用自动化桥,驱动器与脚本在 `docs/smoke/scripts/`(脚本名传给 `bl-run.sh` 时用 `<name>-cmd.sh`,与会话名不同);后台 WebView 会被 macOS 节流,驱动前先把窗口置前
