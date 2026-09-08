# IMPLEMENTATION_PLAN — 三期实施计划

> 每期结束产物都可日常使用。任务按依赖排序,标注验收标准(AC)。
> 环境:macOS + Rust stable + Node 20+ + pnpm + codex CLI 已登录。

## Mac Foundation 前置门禁

在产品 M1 前先完成 `docs/superpowers/specs/2026-08-31-mac-foundation-design.md`:Tauri 原生壳、typed IPC、受支持 SQLite 用例、`TauriBackend` 与真实后端错误态。该门禁产物标记为 `mac-m1`,**不等同于**本计划的产品 `m1`,也不满足下方 M1 验收。它只为 M1.1 提供 Tauri 壳(仍欠 tray),为 M1.2 提供数据库/command 基座;M1.3–M1.10 及全部 M1 闭环仍按原计划完成。

> 2026-09-02 实施基线:上述 Foundation 代码已本地收口,但 Apple Silicon 原生冒烟、远程 CI/PR/tag 仍是硬门禁。由于 L1/L2/Foundation 已预先完成了部分 M1/M2 基础,后续依赖顺序、当前缺口与每节点验收以 `docs/superpowers/plans/2026-09-02-product-m1-implementation-baseline.md` 为执行基线;本文的产品范围与最终验收不变。

> 2026-09-05 Plan A(Linux,`docs/superpowers/plans/2026-09-05-m1-core-engine-linux.md`,tag `m1-linux-a`):core 引擎完成 1.2 的 schema v4、1.4 的幂等编排/限额/连接测试、1.5 的投影 outbox 重放、1.6 的两阶段地图作业、1.7 的地图确认(core 侧,稳定 id + 修订号)、1.9 的持久会话/评估/判定(core 侧)、1.10 队列含 learning 块;ADR 0001–0004 落档。EPUB 抽取/CFI(1.3/1.8)与前端契约 v2 在 Plan B(JS 侧),Tauri command 接线在 Mac(清单见 DEVLOG A-T10)。

> 2026-09-05 加固切片(Linux,`docs/superpowers/plans/2026-09-05-m1-hardening-linux.md`):在产品 M1 前完成了 review 判定的 P0 加固——前端异步读写收敛为 `lib/` 两个 hook 并迁移七页、费曼页写操作错误态、IPC transport_error;core 侧 Codex 子进程卫生、记忆库 slug 校验与原子写、schema v3 外键/主攻书唯一/迁移收敛、读后写事务 IMMEDIATE。不含产品行为与 ADR 依赖项。

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

> 2026-09-07 状态:M1 的全部代码路径已在 Apple Silicon 接线并经自动化门禁(core/src-tauri/web 三套测试、clippy、fmt、debug/release 构建、干净目录启动冒烟、真实 codex 冒烟)验证;下述验收需在桌面会话用真书 + 真 codex 走一遍并签字(`docs/smoke/m1-e2e-gate.md`),之后打 tag `m1`。

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
