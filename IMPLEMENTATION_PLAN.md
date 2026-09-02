# IMPLEMENTATION_PLAN — 三期实施计划

> 每期结束产物都可日常使用。任务按依赖排序,标注验收标准(AC)。
> 环境:macOS + Rust stable + Node 20+ + pnpm + codex CLI 已登录。

## Mac Foundation 前置门禁

在产品 M1 前先完成 `docs/superpowers/specs/2026-08-31-mac-foundation-design.md`:Tauri 原生壳、typed IPC、受支持 SQLite 用例、`TauriBackend` 与真实后端错误态。该门禁产物标记为 `mac-m1`,**不等同于**本计划的产品 `m1`,也不满足下方 M1 验收。它只为 M1.1 提供 Tauri 壳(仍欠 tray),为 M1.2 提供数据库/command 基座;M1.3–M1.10 及全部 M1 闭环仍按原计划完成。

## M1 核心闭环 —— 「能导入一本书并完整学完一个知识块」

| # | 任务 | 说明 / 依赖 |
|---|---|---|
| 1.1 | 项目脚手架 | `pnpm create tauri-app`(React+TS+Vite),配 Tailwind v4、zustand、rusqlite、目录结构(§TECH 1);tray 基础常驻 |
| 1.2 | SQLite 层 | 建 §TECH 4 全部表 + migration 机制;Tauri commands CRUD |
| 1.3 | EPUB 导入 | 文件选择/拖入 → 拷贝入 books/、解析元数据封面、逐 spine 抽取纯文本缓存(§TECH 7.3) |
| 1.4 | AiProvider + codex 集成 | trait + CodexCliProvider(§TECH 5):子进程、--output-last-message、超时重试、JSON 校验重试;设置页配 bin 路径。**先做**:手动冒烟测试 codex exec 在目标机上的行为 |
| 1.5 | 记忆库管理器 | memory/ 目录初始化、文件模板生成、INDEX.md 程序化维护、git init/auto-commit(§TECH 3) |
| 1.6 | 知识地图生成 | 两阶段 prompt(§TECH 6.1)+ 进度 UI;书籍类型选择(含 AI 建议) |
| 1.7 | 地图编辑确认页 | 合并/拆分/删除/跳过/排序;定稿写 _map.md + SQLite |
| 1.8 | 基础阅读器 | epub.js 渲染、目录、进度、字体字号、亮暗主题;块锚定(§TECH 7.2,含失败回退整章)与学习模式高亮 |
| 1.9 | 费曼对话页 | 学生扮演对话(§TECH 6.2)、回读原文往返、结束→评估调用(§TECH 6.3)→评估卡→用户确认;写入链路(SQLite→md→git commit) |
| 1.10 | 薄弱点清单 + 基础每日队列 | 目标设定(期限↔每日块数)、每日 daily_task 生成(薄弱点重考→新块,间隔复习 M2 再加)、今日学习页 |

**M1 验收**:导入一本真实 EPUB(建议先用教材类)走通:地图生成→编辑确认→设目标→今日队列→阅读→费曼对话→评估通过→memory/ 出现正确的块文件与 git commit→次日队列开头出现薄弱点重考并可完成。codex 断网/超时时对话不丢、可重试。

## M2 学习系统 —— 「调度、节奏、三类模板完整」

| # | 任务 | 说明 / 依赖 |
|---|---|---|
| 2.1 | 间隔重复 | review_schedule 调度(1/3/7/14)、快问 prompt(§TECH 6.7)、失败重置+生成薄弱点、汇入每日队列 |
| 2.2 | 强节奏 | 每日/晚间系统通知;番茄钟(Rust 状态机+tray 倒计时);落后检测与自动重排+确认弹窗(§PRODUCT 6) |
| 2.3 | 三类书模板完整化 | 教材:迁移应用题环节(§TECH 6.4);方法论:情境化引导+_methodology.md(§TECH 6.5);人文:脉络追问侧重+观点讨论归档(§TECH 6.6);profile.md 个人情境节的提取与确认流 |
| 2.4 | 单主攻书 | 书架页、切换确认、暂停书计划冻结、已完成书复习照常 |
| 2.5 | 统计页 | 进度/投入/质量三区(§PRODUCT 3.6) |

**M2 验收**:三类书各导入一本并各学 ≥2 块,附加环节行为符合模板定义;制造落后 2 天触发重排确认;番茄钟计时与通知在关窗常驻状态下正常;第 1 天通过的块在第 2 天出现复习任务。

## M3 体验完善 —— 「语音、导出、终评、打磨」

| # | 任务 | 说明 / 依赖 |
|---|---|---|
| 3.1 | 语音输入 | whisper 模型下载管理、录音→转写→可编辑发送(§TECH 8) |
| 3.2 | Obsidian 导出 | 导出器(§TECH 9)、vault 路径设置、增量重导 |
| 3.3 | 整书终评 | 全块通过触发、终评流程(§TECH 6.8)、学习报告归档 |
| 3.4 | 阅读器打磨 | 高亮/书签、纸质主题、中文排版精调(§TECH 7.1)、出版方样式覆盖开关 |
| 3.5 | 数据安全 | SQLite 快照、git 远程 push、恢复入口;误删回收(块删除进 skipped 而非物理删) |
| 3.6 | 收尾 | 空状态/错误态文案、性能(大 EPUB 加载)、打包签名 dmg |

**M3 验收**:全程语音学完一个块;导出后在 Obsidian 中链接与 frontmatter 正确;一本书完整学完产出学习报告;打包后的 app 在干净 macOS 用户下可运行。

## 实施顺序注意

- 1.4(codex 冒烟)是最大不确定性,脚手架完成后立刻做,验证 `--output-last-message`、`-C`、sandbox 参数在已登录环境的真实行为,再定 prompt 细节。
- 1.8 的 CFI 锚定是第二不确定点,先做"整章回退"保底,再做小节精确锚定。
- 每期结束打 git tag(m1/m2/m3)。
