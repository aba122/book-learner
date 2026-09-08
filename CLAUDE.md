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
- [ ] M2 学习系统 / M3 体验完善(见 IMPLEMENTATION_PLAN)

## 开发环境要求

前端/core 可在 Linux 开发;Tauri 原生发布门禁需 macOS(Apple Silicon)、Rust stable、Node 20+、pnpm、codex CLI 已安装并登录(`codex exec "hi"` 可用)。

## 约定

- 浏览器开发:`pnpm -C web dev`;原生开发:`pnpm -C web tauri dev`;基础调试构建:`pnpm -C web tauri:build:debug`
- 界面语言中文;设计决策变更须同步回写对应 SPEC 文档
- Mac Foundation 的真实能力矩阵和冒烟手册见 `docs/smoke/mac-m1-native-smoke.md`;禁止原生环境回退到 Mock 数据
