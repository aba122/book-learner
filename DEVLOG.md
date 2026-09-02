# DEVLOG — book-learner 开发日志

> 每个工作阶段结束追加一条。格式:日期 / 完成内容 / 关键决策与偏差 / 测试状态。

## 2026-09-01 · Mac Foundation T7 完成
- 原生适配：新增可注入 `InvokeFn` 的 `TauriBackend`，8 个已支持方法精确调用共享 wire contract 中的 command 与 camelCase 顶层 payload；默认边界使用 `@tauri-apps/api/core` 的 `invoke`。
- 严格解码：Book/KnowledgeBlock/DailyTask 的所有 i64 字段及出站 ID/计划/设置整数均要求 `Number.isSafeInteger`；严格校验 book type/status、block status、task kind/status、字符串/数组/对象形状、可选 scores/passedAt/refId 的省略语义，分数限 1..5。仅校验传输形状，正数、日期、时间和分钟范围仍由 core 裁决，未增加 retry 或产品规则。
- 失败边界：Tauri invoke rejection 仅接受 Rust `IpcError` 的 7 个已知 code，并使用与 Rust 一致的固定安全消息/retryable；除共享契约中的 `not_implemented` capability 外丢弃 raw details，原生 Error/未知拒绝统一固定消息且不附原对象。解码错误 details 只含 path/expected/actualType，不包含 raw value。11 个未支持方法只调 `unsupported_capability`，不使用 Mock/伪进度。
- 运行时选择：导出可注入候选 global 的纯 `isTauriRuntime` 与 `createBackend`；浏览器选 `MockBackend`，Tauri 选 `TauriBackend`，原生路径无 warning 和 Mock fallback，测试不修改 window 或 module cache。
- TDD 与审查：supported RED 为 `./tauri` 缺失；解码 RED 为 22 组坏 wire fixture 与 5 组 unsafe outbound i64 被静默接受；unsupported/error RED 为裸拒绝对象与缺方法 `TypeError`；runtime RED 为 detector/factory 未导出。质量复审又先复现 7 个敏感错误泄露 RED、3 个 non-null unit response 假成功 RED、4 个出站根对象误分类 RED，分别转 GREEN；malformed 表每 case 只调一次 operation 并复用 Promise。
- 验证：adapter/index focused 53/53；Web 全量 93 通过/1 skipped；lint 退出 0（仅保留 6 个既有 React warning）；production build 通过（保留既有 >500kB chunk warning）；core unit 40 通过/1 ignored、foundation 25/25、lifecycle 1/1；Tauri 12/12，debug no-bundle build 通过。

## 2026-09-01 · Mac Foundation T6 完成
- 契约优先：新增 Rust/TypeScript 共读的 `shared/tauri-wire-contract.json`，固定 9 个 Tauri command、camelCase 顶层 payload key 与 11 个 unsupported capability；移除 `health_check`，所有 handler 统一使用 async command 宏并在单一 handler 表注册。
- 原生分层：`AppState` 独占一个启用 foreign keys 的磁盘 SQLite 连接，application 仅持单 guard 委托 core，DTO 与 core/数据库模型隔离；书、块、计划、队列和设置均通过 typed camelCase JSON 暴露，损坏持久化分数继续作为 internal 错误而非静默丢弃。
- 路径与启动：生产路径只从 Tauri `data_dir()` 解析并精确追加 `book-learner/app.db`，先创建目录再打开数据库，失败即终止且无内存回退；debug 的 `BOOK_LEARNER_DATA_DIR` 只接受绝对路径，release 编译忽略该变量。
- 错误与观测：core 错误映射为稳定中文 `IpcError`；内部 cause 不进入序列化 payload。每个 command 生成 `mac-<pid>-<counter>` correlation ID，失败日志仅记录 command、correlation ID、error code 与内部 cause。unsupported 永远返回 `not_implemented`，安全 details 只含 capability。
- 冒烟与 CI：`seed_smoke` 只接受一个绝对目录，幂等播种一书/三块/一计划并打印精确 `app.db` 路径；mac-foundation 在 debug build 前新增 Tauri all-target tests 与 clippy 门禁。
- TDD：基础测试先因五个原生模块缺失而 RED，最小实现后 9/9 GREEN；播种例程先因参数/播种函数缺失而 RED，随后 2/2 GREEN。
- 审查修复：debug override 目录与 `seed_smoke` 统一为 `<BOOK_LEARNER_DATA_DIR>/app.db`，避免 Task 9 启动时错读嵌套子目录；无 override 的生产路径仍为平台数据目录下 `book-learner/app.db`，release 继续忽略环境变量。路径期望先 RED 后 GREEN。
- 质量审查修复：planning 抽取严格 `YYYY-MM-DD` 校验，`today_queue` 在任何排程写入前拒绝非补零或无效日历日期；真实 Tauri mock runtime 通过生产共用的泛型注册函数逐项调用共享契约 9 个命令，并验证 request/date/settings 的 camelCase 顶层 key 与错误 key 拒绝；runtime 启动路径以幂等 `try_init` 安装最小 fmt tracing subscriber。三项均先取得定向 RED 再转 GREEN。
- 验证：core unit 40 通过/1 ignored、foundation 25/25、lifecycle 1/1；Tauri debug 12/12、release 路径测试及 debug/release clippy 通过；Web 40 通过/1 skipped、production build 与 Tauri debug build 通过；Task 6 修改的 core 文件定向 rustfmt、Tauri crate 全量 fmt 与 diff check 通过。整个 core crate 的 `cargo fmt --check` 仍报告本节点外既有旧文件格式差异，本节点未制造无关批量格式提交。

## 2026-09-01 · Mac Foundation T5 完成
- 严格读模型:新增按 ID 稳定排序的 `Book` 查询与单知识块查询;book type/status、block status、前置依赖 JSON 和评估分数均严格解析,缺失知识块返回 typed `NotFound`,不再把损坏数据静默降级为默认类型或空依赖。
- 核心用例:`library::set_active_book` 在单一 immediate transaction 内切换主攻书及对应计划;`planning::set_plan` 严格验证固定宽度 `YYYY-MM-DD`、正数配额/上限和 `HH:mm`,按书原子 upsert 并仅让主攻书计划 active;`today_queue` 直接委托既有排程器,未增加嵌套事务或截止日自动调整。
- 设置持久化:Rust 通过 `include_str!` 读取 `shared/app-defaults.json`;新库和缺键只在读取结果中回退默认值而不回写。保存前统一验证 1–180 分钟与 `HH:mm`,再以单事务 upsert 四个已公开键,保留无关键。
- TDD 与审查:foundation 24/24,覆盖磁盘重开、缺失目标、严格枚举/日期/时间、触发器注入失败回滚和 active 唯一性。规格审查发现 Chrono 会接受未补零日期,新增三个回归用例先 RED,再补显式格式检查转 GREEN;质量审查进一步隔离“用户请求无效”与“SQLite 持久化损坏”的错误类型,并补齐已存设置校验、损坏书状态和时间数字位回归后通过复审。
- 验证:`cargo test --test foundation` 24/24;`cargo test --all-targets` 为 core unit 40 通过/1 ignored、foundation 24/24、lifecycle 1/1;`cargo clippy --all-targets -- -D warnings` 零警告;本节点 Rust 文件格式与 diff check 通过。

## 2026-08-31 · Mac Foundation T4 完成
- SQLite 连接完整性:`open` 与 `open_in_memory` 统一经私有 `configure`,每次连接显式开启并回读验证 `foreign_keys=1`,再执行迁移;孤儿 `knowledge_block.book_id` 由 SQLite FK 约束拒绝。bundled SQLite 本机编译默认已开启 FK,所以公开路径 FK 测试在基线即通过;另以原始连接显式关闭 FK 后验证 `configure` 恢复为 1,取得缺少配置入口的编译 RED 后转 GREEN。
- schema v2:仅新增 `study_plan_one_per_book` 与 partial unique `study_plan_single_active`,分别约束每书单计划与全库单 active 计划;两个索引和 `user_version=2` 同一事务提交。legacy v1 若有冲突计划则迁移显式失败,事务回滚确保不删行、不残留半套索引且版本保持 1,交由用户修复数据。
- TDD:首轮 focused DB tests 因版本仍为 1、两个唯一约束缺失、legacy 冲突未阻止迁移而 4 项 RED;配置入口测试另以 `configure` 不存在产生编译 RED;事务内无法启用 FK 的测试先复现模糊嵌套事务错误 RED,再由回读检查转为明确错误。最小实现后 focused DB 10/10 GREEN。
- 并发审查修复:受控双连接测试先让 A 在未提交的 immediate 事务中完成 v2,再通过 busy handler 信号确认 B 已等待写锁;旧实现因事务外读取 v1,待 A 提交后重复建索引而 RED。迁移入口改为先取得 `BEGIN IMMEDIATE`,再于同一事务读取版本、按需执行 v1/v2 并提交,并发打开会在锁后读取最新版本。
- 验证:`cargo test --manifest-path core/Cargo.toml db::tests` 11/11;并发定向测试连续 20 次通过;`cargo test --manifest-path core/Cargo.toml --all-targets` 40 通过/1 ignored + lifecycle 1/1;`cargo clippy --manifest-path core/Cargo.toml --all-targets -- -D warnings` 零警告。

## 2026-08-31 · Mac Foundation T3 完成
- 共享默认值:仓库级 `shared/app-defaults.json` 成为 Web 设置的唯一默认值来源;`APP_DEFAULTS` 以 `Readonly<AppSettings>` 冻结副本导出,番茄钟常量与 `MockBackend` 设置均由其派生;Vite 仅额外放行 `shared/`,TypeScript 将该 JSON 纳入应用图。
- 本地日期:新增 `localCalendarDate`,统一 Today/Map/Feynman 的日历日计算;测试可在任意宿主时区运行,并分别锁定上海 UTC 跨日、洛杉矶 DST 跳时后临近日界的跨日 instant,三页不得恢复 `toISOString().slice(0, 10)`。
- typed errors:新增 `BackendError`、`normalizeBackendError`、`isBackendError`,覆盖 Tauri 风格结构化拒绝、字符串、原生 `Error` 与未知值。
- TDD:实现阶段三个循环均先观察 RED——日期/错误模块缺失、`APP_DEFAULTS` 缺失——再以最小实现转 GREEN;审查修复另复现 UTC 期望未定义与默认对象未冻结两个 RED,随后转 GREEN。
- 验证:UTC 日期 4 通过/2 定向跳过,上海与洛杉矶日期各 5 通过/1 定向跳过;默认值契约 6/6;全量 Vitest 39 通过/1 定向跳过;lint 退出 0(仅既有 6 个 warning,无新增);production build 与 diff check 通过(build 保留既有 >500kB chunk warning)。

## 2026-08-31 · Mac Foundation T2 完成
- Codex CLI:0.144.1 在临时/记忆库目录运行时要求显式 `--skip-git-repo-check`;先由真实冒烟复现,再以参数契约回归测试驱动 provider 修复。两次真实只读调用均返回“二”,分别耗时 13.5s 与 50.99s;`-C`、`--sandbox read-only`、`--output-last-message` 与新参数共同通过,不依据单次延迟调整产品 prompt。
- EPUB CFI:Playwright 1.62.1 / Chromium 151 使用真实 `sample.epub` 完成 heading range 往返;元素子节点偏移会被 epub.js 解释成字符偏移,因此范围必须锚定文本节点。结果为 `epubcfi(/6/2!/4/2,/1:0,/1:9)`,恢复文本“第一章 供给与需求”。
- 边界:本节点只验证单一文本节点 range;跨节点/跨段范围与用户手工校正留给后续 EPUB 生产接入节点。

## 2026-08-31 · Mac Foundation T1 完成
- 工具链:Xcode 26.3 / Apple clang 17.0.0 / rustc+cargo 1.98.0 / Node 25.3.0 / pnpm 10.29.3 / codex-cli 0.144.1。
- 完成:新增 Tauri 2 最小原生 crate、固定 Vite 开发端口、macOS CI、调试构建脚本及可替换 SVG 图标源;本节点仅建立可编译原生壳,产品命令由后续 typed IPC 节点接入。
- 配置:bundle id `com.aba122.booklearner`;窗口标题“攻书”,默认 1280×800,最小 960×640;Foundation 阶段关闭 bundle。
- 验证:core 30 单测 + 1 集成通过(1 ignored);web 27/27 通过;web production build 通过(保留既有 bundle >500kB 警告);`cargo check` 与 `tauri build --debug --no-bundle` 通过,原生可执行文件产于 `web/src-tauri/target/debug/book-learner`。

## 2026-08-31 · Mac-M1 设计启动
- 范围:首个 Mac 垂直切片完成 Tauri 2 原生壳、typed IPC、受支持 SQLite 用例与 `TauriBackend`;真实 EPUB/Codex 仅按既定顺序做风险冒烟,生产接入及记忆库/tray/语音/导出留给后续独立节点,不改变既有产品规则。
- 架构:采用契约优先分层(`Backend → TauriBackend → commands → application services → core/repositories`),浏览器继续使用 MockBackend;DTO、持久化模型与 UI 类型隔离。
- 安全边界:原生端未实现的导入/地图编辑/任务完成/阅读/会话/统计能力必须返回 typed `not_implemented` 并显示中文不可用态,不得回退 Mock;复习/重考不可由通用 completeTask 绕过。
- 计划关系:`mac-m1` 是产品 M1 的技术前置门禁,只交付原生 contract/SQLite 基座,不替代 `IMPLEMENTATION_PLAN.md` 的 M1 验收或 `m1` tag。
- 流程:开发分支 `feat/mac-m1`;节点级原子 commit 后立即 push,里程碑经 CI/PR 合并 main 并打 `mac-m1` tag。
- 设计文档:`docs/superpowers/specs/2026-08-31-mac-foundation-design.md`。
- 基线验证:`pnpm exec vitest --run` 27/27 通过;`pnpm build` 通过(现有 bundle >500kB 警告保留)。本机尚无 Rust toolchain,在实施脚手架节点补齐。

## 2026-08-30 · 项目启动(Linux 阶段)
- 完成:SPEC 套件定稿(四文档);L1 计划(docs/plans/2026-08-30-core-crate-linux.md),经独立评审两轮(1 阻断已修 + 9 条建议已并入)。
- 决策:Linux 先实现平台无关 core crate;前端/Tauri 壳为后续独立计划。实现工作在 feat/l1-core 分支进行(偏差:计划 T0 未提分支,规范起见补充),完成后合回 main。
- 环境:node22 / cargo1.80 / codex-cli 0.144.4(本机可用,AI 层可真冒烟)。

## 2026-08-30 · L1-T1 完成
- db schema v1 + migration(user_version),2 测试绿。
- 偏差回写:daily_task 增加 ref_id(关联薄弱点/复习计划来源),已更新 TECH_DESIGN §4。
- 环境:cargo 1.80 无法编译新版 tempfile(edition2024),rustup 升级至 1.98.0。

## 2026-08-30 · L1-T2~T7 完成
- eval 严格解析(围栏剥离/deny_unknown_fields/1-5 校验)、models CRUD、memory(init/模板/apply_eval 累积/镜像再生/git 自动提交)、ai(AiProvider + CodexCliProvider)全绿。
- 真实 codex 冒烟(cargo test codex_real_smoke -- --ignored):通过。codex-cli 0.144.4 兼容 -C / --sandbox read-only / --output-last-message;单轮往返 13.7s(短 prompt)。费曼对话轮次的预期延迟量级 ~15-30s,前端"学生思考中"状态必要。
- 偏差:tempfile 从 dev-dependency 提升为运行时依赖(CodexCliProvider 需要 NamedTempFile)。

## 2026-08-30 · L1-T9~T11 完成
- 调度引擎:每日队列(薄弱≤3→复习→新块,幂等)、间隔重复 1/3/7/14 流转、复习失败重置+生成薄弱点、薄弱点连续2次通过修复、评估落库 apply_eval_to_db、落后检测与重排(cap 内自动/超 cap 交决策,截止日不静默改)。
- 偏差:计划 T11 测试假设剩余天数不含截止日;实现采用"含今天与截止日"语义(截止日当天可学习,产品语义更合理),测试场景改为截止日=今天。i64::div_ceil 未稳定,改手写 ceil。

## 2026-08-30 · L1-T12 完成,L1 收官
- 端到端集成测试 lifecycle.rs 一次通过:Day0 建书→学块→评估(围栏 JSON)→SQLite 落库+md 镜像+git commit→Day1 队列 [weak_retest, review, new, new]→薄弱点两连过 fixed→复习推进 3 天档。
- 测试总计:31 通过(30 单测 + 1 集成),1 ignored(真实 codex 冒烟,已单独跑过并通过);clippy --all-targets 零警告。
- 遗留边界(交 Mac 阶段):EPUB 抽取/CFI、React 前端、Tauri 壳、whisper、Obsidian 导出、_methodology.md 流、AI 重试编排。

## 2026-08-30 · 远程仓库与 PR
- 远程:https://github.com/aba122/book-learner(私有);main 与 feat/l1-core 已推送。
- 注:本机 SSH 密钥属另一账号(2019ChenGong),对本仓无权限;推送走 HTTPS+PAT。Mac 端克隆请用自己账号的认证;用完的 PAT 应及时 revoke。

## 2026-08-30 · L2 启动前:磁盘配额事件
- /p/fzv6enresearch 群组卷 100% 满;cargo clean 释放 679MB 救急。
- 本机存储策略(不入库,机器相关):pnpm store 与 web/node_modules(符号链接)、cargo target(CARGO_TARGET_DIR)全部放 /bigtemp/fzv6en/book-learner/;/p 卷只放源码。core 重新构建需 CARGO_TARGET_DIR=/bigtemp/fzv6en/book-learner/cargo-target cargo test。

## 2026-08-30 · L2-T0 完成(web 脚手架/CI/推送链路)
- feat/l2-web 分支自 feat/l1-core 建立并推送成功(HTTPS+PAT credential store 复用 L1 配置)。
- 脚手架:Vite 7 + React 18 + TS(create-vite 默认给 React 19/Vite 8,按计划技术栈手动钉回)+ vitest/jsdom/RTL + Tailwind v4 + zustand/epubjs/react-router-dom/jszip;`packageManager: pnpm@11.24.0`。
- 磁盘偏差(重要,机器相关):计划的"先建 node_modules 符号链接再 install"在 pnpm 11 下不可行——pnpm 链接阶段按 realpath 删除重建 node_modules,符号链接目标被删。实际方案:正常 install 后整体 mv 到 /bigtemp/fzv6en/book-learner/web-node_modules 再建符号链接(/p 上 web/ 仅 ~200K)。
- pnpm 11 双配置(机器相关,勿破坏):`web/pnpm-workspace.yaml` 入库版只含 allowBuilds(esbuild/core-js/es5-ext=false,未审批 build 的全新安装 exit 1 实测,CI 必需;这些 postinstall 均非必需)+ verifyDepsBeforeRun=false;本地盘上同文件经 `git update-index --skip-worktree web/pnpm-workspace.yaml` 隐藏修改,多一行 `virtualStoreDir: /bigtemp/fzv6en/book-learner/web-node_modules/.pnpm`(缺它任何 install/add 报 UNSAFE_MODULES_DIR/UNEXPECTED_VIRTUAL_STORE)。若需还原:`git update-index --no-skip-worktree`。Mac 阶段克隆后无此问题(无 /bigtemp 约束)。
- CI:.github/workflows/ci.yml(core: cargo test;web: corepack + install --frozen-lockfile + vitest --run + build)。
- 本地验证:vitest 0 测试 exit 0(passWithNoTests)、build 通过。

## 2026-08-30 · L2 并行会话检测(headless 续跑会话主动退出)
- 23:07 启动的 headless 续跑会话(本条作者)开工检查时发现:上次"被中断"的会话实为存活——23:05 已被 `claude -r` 恢复(pts/0),并于 23:08:48 提交并推送 L2-T4(70f39bb),随即开始创建 T5/T6 文件(features/library/、features/map/)。
- 同一工作区双代理并行会产生提交/推送竞态与重复实现;headless 会话未触碰任何代码,记录本条后正常退出,L2 余下任务由交互式会话继续。
- headless 会话独立验证过 T4 快照:vitest 11/11 绿、build 通过。
- 提醒:截至本条,DEVLOG 缺 L2-T1~T4 的逐任务记录(仅有 T0),请交互式会话收尾时补齐。

## 2026-08-30 · L2-T1~T6 完成(契约/Mock/外壳/今日/书架/地图)
- T1 领域类型 + Backend 契约 + 4 条红契约测试;T2 MockBackend(微观经济学 12 块种子、供需弹性学生剧本、固定评估卡)转绿。
- T3 设计代币(纸感亮色/夜读暗色双主题,宋体标题+黑体正文,赤/琥珀/靛三任务色)+ 6 共享组件 + 侧栏外壳;Playwright 截图目检双主题通过。测试基建修正:vitest 未开 globals 时 RTL 不自动 cleanup,test-setup 显式 afterEach(cleanup)。
- T4 今日学习页(队列排序卡/进度环/streak/番茄钟浮窗)。偏差:计划约定的 userEvent advanceTimers 模式在"点击后启动计时器"场景仍死锁,番茄钟测试改用同步 fireEvent 触发点击(userEvent 高保真语义此处非必需)。
- T5 书架页(首字色块封面/主攻置顶/Confirm 切换)+ 导入向导(文件→类型→进度→跳地图);测试用 deferred generateMap 使进度文案可确定性断言。
- T6 知识地图页(模块分组/状态徽标/星级/编辑模式跳过与移动/改模块名/合并拆分禁用留位)+ 目标设定面板(期限→每日块数向上取整换算,含今天与截止日,与 L1 语义一致);日期敏感测试用 vi.useFakeTimers({toFake:['Date']}) 钉住今天,不影响 userEvent。
- 并行会话说明:23:07 headless 续跑会话发现本会话存活后已主动退出,未产生代码冲突。

## 2026-08-30 · L2 并行会话检测(第二次,headless 续跑会话再次主动退出)
- 23:15 启动的 headless 续跑会话(本条作者)开工检查时发现:pts/0 的交互式会话(`claude -r`,23:05 启动,PID 1999606)仍存活且正在实施 L2-T7——工作区有其未提交的 T7 半成品(scripts/make-fixture-epub.mjs、public/fixtures/sample.epub、reader.test.tsx、EpubView.tsx、ReaderPage.tsx、config/tokens 增量),且 ReaderPage.tsx 在 23:18:43(headless 会话运行期间)仍被持续改写、进程 CPU 时间持续增长。
- 为避免重复实现与 commit/push 竞态(同 23:07 那次先例),headless 会话未触碰任何代码与计划复选框,记录本条后正常退出;T7 及余下任务由交互式会话继续。
- headless 会话已独立核验的部分(仅只读检查,供交互式会话参考):fixture EPUB 结构合法(mimetype 首条目、STORE 不压缩、3 章 spine);reader.test.tsx 覆盖计划 Step 7.2 全部断言点;工作区半成品与计划 Step 7.1–7.3 相符,属"完整推进中"而非残缺。
- 注意:本机 /p 为网络卷,属性缓存有延迟——headless 会话最初两次 `git status`/`ls` 看到的是过时快照(误报"干净"),数十秒后才逐步显现真实改动;判断工作区状态请以重复采样为准。

## 2026-08-30 · L2 并行会话检测(第三次,headless 续跑会话再次主动退出)
- 23:20 启动的 headless 续跑会话(本条作者)开工检查时发现:pts/0 交互式会话(PID 1999606)仍存活,T7 已由其提交并推送(ca9dc19,23:19:14),且正在实施 L2-T8——本会话运行期间(23:21)`features/feynman/feynman.test.tsx`(4.3KB)被创建,`config.ts` 出现未提交的 `TYPEWRITER_CHAR_MS` 增量,60 秒窗口内进程 CPU 时间持续增长。红测试先行,符合 Step 8.1 的 TDD 节奏,属正常推进而非中断残留。
- 按前两次先例(23:07、23:15),本会话未触碰任何代码与计划复选框,记录本条后正常退出;T8 及余下任务(T9/T10、tag、PR#2)由交互式会话继续。
- 本会话只读核验(供参考):T7 提交完整(fixture EPUB 3620B + EpubView/ReaderPage + reader.test.tsx 101 行 + 计划复选框已勾);工作区此刻仅 DEVLOG(第二次检测记录,仍未提交,收尾请一并入库)+ config.ts + feynman.test.tsx 三处改动,均可归属 T8 进行中。
- 给启动方的建议:交互式会话存活期间无需再启 headless 续跑;如需确认其死活,`ps -p 1999606` + 隔 ≥60s 两次采样 CPU 时间即可(/p 卷缓存延迟,单次快照不可信)。

## 2026-08-31 · L2-T7~T10 完成,L2 收官
- T7 阅读器:jszip 生成合法 EPUB3 fixture(mimetype 首条目 STORE);EpubView 封装 epub.js 生命周期,三阅读主题读 tokens(--reader-*)注入 iframe;浏览器实读逐项目检(翻页/目录跳章/字号档/夜读主题/进度条)通过。目检抓到真 bug:学习模式浮层遮住翻页按钮,已改为分栏布局。
- T8 费曼对话页:原文参考折叠栏/对话流/打字机渐显(interval+函数式 setState,批量推进可整段渐显)/思考中状态/评估卡(三维星级/薄弱点已修复标记/AI 建议)/确认通过回今日;放弃走 Confirm 不落评估。偏差:vitest 4 fake timers 下 user-event 连纯点击都死锁,feature 测试统一 fireEvent + act(计划的 advanceTimers 约定不可行,DEVLOG 即此记录)。
- T9 统计页(纯 CSS 环形/条形)+ 设置页(番茄钟/休息/提醒/Obsidian 路径可存;codex/whisper/git 远程禁用留位)。
- T10 全量验证:vitest 27/27 绿、build 通过、core 回归 30+1 绿(CARGO_TARGET_DIR=/bigtemp)。Playwright 全流程冒烟:今日→开始新块→阅读器→费曼 4 轮→评估→确认通过→回今日(块变已完成、进度 3/12、今日 30 分钟),截图留档 /bigtemp/fzv6en/book-learner/l2-smoke-shots/。
- 偏差清单(延后项):地图合并/拆分(需原文选区,Mac);语音输入/书封面(留位);阅读器书签与行距/段首缩进设置(延后);今日页"明日预告"(契约缺失,Mac 阶段补 tomorrowPreview);菜单栏番茄倒计时(tray,Mac);epub CFI 精确锚定(前端只消费 blockSource.href)。
- 回写:TECH_DESIGN §1.1(web/ 结构与 Backend 契约位置)、CLAUDE.md 状态区(L2 完成,Mac 阶段入口=backend/tauri.ts+Tauri 壳)。

## 2026-08-31 · L2 PR 与 tag
- tag `l2-web` 已推送;PR #2 已创建:https://github.com/aba122/book-learner/pull/2(feat/l2-web → feat/l1-core,堆叠,PR#1 合并后自动重定向)。
- 最终 CI(5c103b8):core + web 双 job 绿。

## 2026-09-02 · Mac Foundation T8A 完成
- `AsyncError` 保持纯展示职责:接收 `BackendError`、可选 `onRetry` 与 `compact/full` 变体,以 `role=alert` 显示中文消息;只有 `retryable === true` 且存在回调时才显示重试按钮,不包含 backend、timer 或重试策略。
- Today 将今日队列及其 required `listBlocks` hydration 作为单一原子 pipeline,全部成功后才发布 tasks/blocks;队列刷新失败保留旧快照。queue/stats/completeTask 三类错误和重试入口互相隔离;stats 失败不伪造数据且不阻断队列,completeTask 失败不乐观改变任务,成功后只刷新队列 pipeline。页面挂载时固定本次队列日期,跨午夜重试仍使用同一日期。
- 恢复前 `AsyncError` TDD 记录:`pnpm -C web exec vitest --run src/components/AsyncError.test.tsx` 依次观察到组件缺失(1 failed suite/0 tests)→1/1 GREEN;重试按钮 1 failed/2→2/2 GREEN;不可重试隐藏按钮 1 failed/3→3/3 GREEN;full 样式 1 failed/3→3/3 GREEN;compact 样式 1 failed/4→4/4 GREEN。Today 初始失败态同命令替换为 `src/features/today/today.test.tsx`:不可重试队列 1 failed/6→6/6 GREEN;可重试队列 1 failed/7→7/7 GREEN;hydration 1 failed/8 后中断。
- 恢复后的逐项 RED/GREEN 命令与结果:`pnpm -C web exec vitest --run src/features/today/today.test.tsx -t '队列 hydration 的 listBlocks 失败时不发布半成品快照'` 为 1 failed/7 skipped(错误未呈现且任务卡已提前发布)→1 passed/7 skipped;同命令分别以 `-t '统计失败时保留可用队列且不伪造统计'` 得 1 failed/8 skipped→1 passed/8 skipped,`-t '重试统计只重新请求统计'` 得 1 failed/9 skipped→1 passed/9 skipped,`-t '完成任务失败时保留原任务与未完成状态'` 得 1 failed + 1 unhandled error/10 skipped→1 passed/10 skipped,`-t '重试完成操作只重发同一任务并在成功后刷新队列'` 得 1 failed/11 skipped→1 passed/11 skipped,`-t '完成后的队列刷新失败时保留旧快照'` 得 1 failed/12 skipped→1 passed/12 skipped,`-t '跨午夜重试队列仍使用当前页面的同一日期'` 得 1 failed/13 skipped(第二次收到 `2026-09-03`)→1 passed/13 skipped。
- 最终验证:`pnpm -C web exec vitest --run src/components/AsyncError.test.tsx src/features/today/today.test.tsx` 为 21/21;`pnpm -C web exec vitest --run` 为 109 passed/1 skipped(14 files);`pnpm -C web lint` exit 0;`pnpm -C web build` 成功(179 modules);`git diff --check` 通过。
- 保留既有警告:lint 共 6 条——LibraryPage 与 TodayPage、MapPage 各 1 条 `react(set-state-in-effect)`,EpubView 3 条 `react(refs)`;build 保留单一 minified chunk >500 kB 警告(`index-TtPZyRTE.js` 594.12 kB, gzip 187.61 kB)。
- 质量复审修复 RED/GREEN:`AsyncError` 表单内重试 RED 为点击触发表单 submit,显式 `type="button"` 后 GREEN;Today 的同任务双击、写成功但队列刷新失败后二次写、不同任务独立 guard 与逐任务错误/精确重试用例在旧实现上分别 RED,改为同步 ref guard、committed-awaiting-refresh 集合及逐任务错误 Map 后 GREEN。
- 质量复审并发/卸载 RED/GREEN:旧 queue success、旧 queue failure、旧 stats success、旧 stats failure 会覆盖较新状态或错误;卸载后的 queue 会继续 hydration,卸载后的 complete success/failure 会继续刷新或规范化错误。加入 queue/stats generation、operation generation 与 cleanup invalidation 后上述用例全部 GREEN;`TaskCard` 用单一 `completing` prop 同时表达进行态和禁用态,避免两个等价 prop 漂移。
- 质量修复最终验证:`pnpm -C web exec vitest --run src/components/AsyncError.test.tsx src/features/today/today.test.tsx` 为 32/32;`pnpm -C web exec vitest --run` 为 120 passed/1 skipped(14 files);`pnpm -C web lint` exit 0,仅保留既有 6 条警告(LibraryPage/TodayPage/MapPage 各 1 条 `react(set-state-in-effect)`,EpubView 3 条 `react(refs)`);`pnpm -C web build` 成功(179 modules),保留单一 minified chunk >500 kB 警告(`index-DvYvy9ij.js` 595.41 kB,gzip 187.96 kB);`git diff --check` 通过。
- 不可重试完成失败复审 RED/GREEN:`pnpm -C web exec vitest --run src/features/today/today.test.tsx -t '不可重试的完成失败禁用完成动作但不阻塞其他任务动作'` 在旧实现为 1 failed/26 skipped(仍显示可点击“完成”)→保留该任务 completion guard,并以独立 `completionUnavailable` 状态显示禁用的“完成暂不可用”后为 1 passed/26 skipped;错误仍在对应 row 内且无重试按钮,“专注”“开始重考”与“回读原文”保持可用。最终 focused 两文件 33/33;全量 Vitest 121 passed/1 skipped(14 files);lint exit 0,仅既有 6 条警告;build 成功(179 modules),保留单一 minified chunk >500 kB 警告(`index-DkvQupeo.js` 595.58 kB,gzip 188.02 kB)。
