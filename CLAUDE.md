# book-learner

Mac 本地 EPUB 深度学习软件:西蒙学习法(拆知识块→设目标→逐块攻克)为骨架,费曼学习法(讲给 AI 学生听→暴露漏洞→回补→通过)为闭环。Tauri 2 + React + SQLite,AI 后端为本机已登录的 codex CLI 子进程,学习记忆库为 md 目录(codex 自主读取)+ git 备份。

## 文档阅读顺序

1. `PRODUCT_SPEC.md` — 产品定义:界面、流程、三类书模板、调度与节奏规则(需求的唯一权威来源)
2. `TECH_DESIGN.md` — 技术设计:架构、记忆库、数据模型、codex 集成、全部 AI prompt、EPUB/语音/导出
3. `IMPLEMENTATION_PLAN.md` — 三期任务拆解与验收标准(按此开工)

## 当前状态

- [x] 产品与技术设计定稿(2026-08-30,与用户四轮问答确认)
- [ ] M1 核心闭环 ← **从这里开始**
- [ ] M2 学习系统
- [ ] M3 体验完善

## 开发环境要求

macOS(Apple Silicon)、Rust stable、Node 20+、pnpm、codex CLI 已安装并登录(`codex exec "hi"` 可用)。

## 约定

- 开发:`pnpm tauri dev`;构建:`pnpm tauri build`
- 界面语言中文;设计决策变更须同步回写对应 SPEC 文档
- 先做 IMPLEMENTATION_PLAN 中标注的两个不确定点冒烟(codex exec 参数行为、CFI 锚定),再铺开功能
