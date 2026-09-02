# book-learner

Mac 本地 EPUB 深度学习软件:西蒙学习法(拆知识块→设目标→逐块攻克)为骨架,费曼学习法(讲给 AI 学生听→暴露漏洞→回补→通过)为闭环。Tauri 2 + React + SQLite,AI 后端为本机已登录的 codex CLI 子进程,学习记忆库为 md 目录(codex 自主读取)+ git 备份。

## 文档阅读顺序

1. `PRODUCT_SPEC.md` — 产品定义:界面、流程、三类书模板、调度与节奏规则(需求的唯一权威来源)
2. `TECH_DESIGN.md` — 技术设计:架构、记忆库、数据模型、codex 集成、全部 AI prompt、EPUB/语音/导出
3. `IMPLEMENTATION_PLAN.md` — 三期任务拆解与验收标准(按此开工)

## 当前状态

- [x] 产品与技术设计定稿(2026-08-30,与用户四轮问答确认)
- [x] L1 core crate(Linux,feat/l1-core):db/models/eval/memory/ai/sched,31 测试绿
- [x] L2 React 前端(Linux,feat/l2-web):七页面 + MockBackend,浏览器闭环可跑,27 测试绿
- [x] Mac Foundation 本地实现(feat/mac-m1):Tauri 2 壳、类型化 IPC、8 个 SQLite 能力、11 个显式未实现能力、七路由失败态
- [ ] Mac Foundation 发布门禁:在 Apple Silicon 完成原生退出/重启持久化冒烟,推送分支并通过 macOS CI、PR 与 `mac-m1` tag
- [ ] 产品 M1:EPUB 导入/抽取/CFI、地图生成与定稿、Codex 费曼闭环、评估一致性(见 IMPLEMENTATION_PLAN)
- [ ] M2 学习系统 / M3 体验完善(见 IMPLEMENTATION_PLAN)

## 开发环境要求

前端/core 可在 Linux 开发;Tauri 原生发布门禁需 macOS(Apple Silicon)、Rust stable、Node 20+、pnpm、codex CLI 已安装并登录(`codex exec "hi"` 可用)。

## 约定

- 浏览器开发:`pnpm -C web dev`;原生开发:`pnpm -C web tauri dev`;基础调试构建:`pnpm -C web tauri:build:debug`
- 界面语言中文;设计决策变更须同步回写对应 SPEC 文档
- Mac Foundation 的真实能力矩阵和冒烟手册见 `docs/smoke/mac-m1-native-smoke.md`;禁止原生环境回退到 Mock 数据
