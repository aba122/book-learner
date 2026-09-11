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
- T8A 收口:最终代码复审与计划增量复审均 APPROVED,无 Critical/Important/Minor 遗留。主线程重新运行 focused 33/33、全量 121 passed/1 skipped、lint(exit 0,既有 6 warnings)、build(179 modules)与 `git diff --check`,结果全部符合节点门禁;后续从 T8B Library/Import/Map 状态保留开始。

## 2026-09-02 · Mac Foundation CI 工具链修复
- `main` 与 `feat/mac-m1` 的 Web/macOS jobs 均在业务门禁前失败:从仓库根目录启动的 Corepack 选择 pnpm 11.25.0,与 `web/package.json` 固定的 11.24.0 冲突。两个 job 在 `corepack enable` 后显式激活 `pnpm@11.24.0`,保持包管理器版本与项目契约一致。
- 该修复只恢复 CI 依赖安装入口,不改变产品代码;提交后以远端 Actions 作为 Linux Web 与 macOS Tauri 门禁证据。

## 2026-09-02 · Mac Foundation T8B 完成
- App 启动时的主攻书探测变为 cancel-safe 的非关键读取,失败由 route loader 负责呈现且不再产生 unhandled rejection。Library 的书目读取按 generation 隔离重试、过期及卸载结果;已有书目在刷新失败时保留。切换主攻书使用同步 guard,错误留在确认框内。
- Import 捕获不可变的 File/type 尝试快照,同步 guard 阻止重复提交;`importEpub` 成功而 `generateMap` 失败时保存 `bookId`,重试只恢复地图生成而不重复导入。不可重试错误保留所选文件和类型并只提供关闭,关闭清理全部尝试状态。
- Map 将 block list 与 book title 作为独立读取资源,分别支持 retry/generation/unmount 隔离;定稿失败保留名称、顺序与跳过编辑,重试复用精确快照且不触发列表读取,同步 guard 阻止双击。目标保存同样捕获错误并防止并发写。
- TDD:新增用例在旧实现上为 11 failed/7 passed 且产生 10 个 unhandled rejections;最小实现后 App/Library/Import/Map focused 21/21。全量 Web 为 134 passed/2 timezone-conditional skipped(14 files),lint exit 0(仅 6 条既有 React warnings),production build 通过(179 modules,保留 599.77 kB chunk warning),`git diff --check` 通过。
- 远端偏差:当前 GitHub 身份 `Liuzzyg` 对仓库仅有 READ 权限,CI 修复提交 `980e83e` 推送收到 HTTP 403;后续节点继续保留本地原子提交,待具备写权限后统一推送并取得 Actions 证据。

## 2026-09-02 · Mac Foundation T8C 完成
- Reader 使用单一 generation/cancel-safe 内容管线,只有 `getBlock`、`blockSource` 与 `epubUrl` 全部成功才原子发布并挂载 `EpubView`;失败替换永久 loading,保留 `task`/`back` 导航语义,可重试错误重跑完整读取,参数切换或卸载后的结果被忽略。
- Feynman 将 today queue、block、source 三段只读准备与 `startSession` 非幂等边界分开。只读失败可在尚未尝试创建 session 时重试;调用 `startSession` 前同步设置 attempted guard,其 pending、歧义失败或卸载结果都不会获得第二次创建入口。失败初始化不发布半成品 task/block/source,也无法调用 reply/end/verdict/complete 操作。
- TDD:Reader/Feynman 新用例在旧实现上为 10 failed/9 passed 并产生 10 个 unhandled rejections;实现后 focused 19/19。全量 Web 为 145 passed/2 timezone-conditional skipped(14 files),lint exit 0 且仍只有 6 条既有 warning,production build 通过(179 modules,保留约 602 kB chunk warning),`git diff --check` 通过。

## 2026-09-02 · Mac Foundation T8D 完成
- Stats 将 loading/success 与 `BackendError` 分开,不用零值或 Mock 数据伪装原生失败;可重试错误只重发 `stats`,generation 与 unmount invalidation 阻止较晚的旧成功/失败恢复过期页面。
- Settings 将加载与保存错误独立呈现;保存时捕获不可变快照,失败不重置表单,编辑后重试使用当前新快照。同步 ref guard 阻止双击写入,form revision 避免在写入期间继续编辑后误报“已保存”,load/save generation 忽略过期与卸载结果。
- TDD:旧实现在 Stats/Settings 新矩阵上为 7 failed/7 passed 且有 10 个 unhandled rejections;实现后两文件 16/16。八文件页面错误契约 86/86,全量 Web 158 passed/2 timezone-conditional skipped(14 files),lint exit 0(仅原有 6 warnings),production build 成功(179 modules,602.96 kB chunk warning),`git diff --check` 通过。

## 2026-09-02 · Mac Foundation T9 本地收口(发布门禁待完成)
- 权威文档已对齐真实边界:`CLAUDE.md` 将 Mac Foundation 本地实现与 Apple Silicon 发布门禁/产品 M1 分开;`TECH_DESIGN.md` 记录 runtime、transport、command/application/DTO、数据路径及 8 supported/11 unsupported 能力;`web/ARCHITECTURE.md` 补齐 TauriBackend、BackendError 与异步边界守则。
- 持久化冒烟手册新增 `docs/smoke/mac-m1-native-smoke.md`,固定单一 `mktemp` fixture、两次同 shell 启动、Cmd+Q 退出、Settings 重启持久化、Tauri/Mock 对照与 production Application Support 路径检查;当前未在 Apple Silicon 上执行的槽位保持 PENDING。
- 历史 rustfmt 偏差:Task 6 曾明确保留 core 中 7 个旧文件的全库格式差异;Task 9 需要全量 `cargo fmt --check`,因此以单独的纯机械提交 `83b9275` 应用当前 stable rustfmt。格式化后 core 66 passed/1 ignored 且 clippy `-D warnings` 通过,无行为变更。
- CI 增加 core rustfmt + all-target tests + clippy、Web lint 与 Tauri rustfmt 门禁;工作流 YAML 解析通过。两个 Node job 仍显式激活项目锁定的 pnpm 11.24.0。
- 当前 Linux x86_64 验证:core fmt/tests/clippy PASS,Tauri fmt PASS,Web 158 passed/2 skipped + lint/build PASS,Playwright CFI 1/1 PASS。Tauri tests/clippy/debug build 在编译项目代码前因主机缺 `gdk-3.0`/Pango/Cairo 开发库失败;这些命令与 GUI 持久化冒烟必须由 macOS-14 CI/Apple Silicon 重跑。
- 发布阻塞:当前 GitHub 身份 `Liuzzyg` 的 REST 权限为 `pull:true,push:false`,无法推送本地节点或触发 Actions。远程 `28f563f` 的 [Actions 33606579463](https://github.com/aba122/book-learner/actions/runs/33606579463) 仅 core 成功,Web/macOS 都在 pnpm install 失败后跳过后续;本地 `980e83e` 修复了该入口但无法发布验证。因此不创建 PR、不合并、不打 `mac-m1` tag,也不将产品 M1 标记完成。

## 2026-09-02 · 产品 M1 架构复审与执行基线
- 复审不把 Foundation 的 11 个 `not_implemented` 直接按方法表平铺:真实依赖是“发布门禁 → ADR/模型 → EPUB 导入与缓存 → Codex 调用硬化 → 地图生成/定稿 → 阅读锚定 → 持久会话 → 评估确认/outbox → 前端操作失败恢复 → tray/E2E”。
- 必须先修的高风险边界:当前 schema 只有单段 `spine_href/cfi_start/cfi_end`,无 spine 文本缓存/多段锚点/地图版本;地图定稿 DTO 无 stable block ID/version;Feynman 传整段客户端 transcript 且 send/end/confirm 尚无错误恢复与幂等 key;SQLite→Markdown→Git 测试只是两段顺序调用,不具备跨存储原子性。
- Codex provider 在子进程退出前不消费 piped stderr,大量输出可填满 pipe 并被误判为超时;只 kill 直接 child 也需要验证不留后代进程。MemoryStore 直接 `join(slug)` 且原地覆写,生产接线前必须限定内部 slug、使用 temp+rename 投影并以 operation ID 幂等重放。
- 新基线文档:`docs/superpowers/plans/2026-09-02-product-m1-implementation-baseline.md`;保留 `IMPLEMENTATION_PLAN.md` 的产品验收,但用 12 个可审计节点取代已过时的粗粒度实施顺序。

## 2026-09-05 · M1 加固切片启动(Linux,分支 feat/m1-hardening)
- 触发:对 Mac Foundation(远端 main 74830ac)+ 本机 8 个未推送提交(linux-local d23ab9f)的 review,含 code-review 自动化排查 10 条(F1–F10,清单与处置见 docs/superpowers/plans/2026-09-05-m1-hardening-linux.md)。
- 范围:不含产品行为、不预设 ADR 结论的加固——前端两公共异步 hook 并迁移七页、费曼页三处裸 await 错误态、Today conflict 永久禁用/stats 不刷新、Settings 空输入、EpubView lint、IPC transport_error;core busy_timeout、v2/v3 迁移收敛与子表外键、主攻书/活跃计划唯一性、Codex stderr 死锁与进程组、记忆库 slug 消毒与原子写。
- 范围外:ADR 四份及其 schema 扩展、MapEditBlock 稳定 id(Node 6)、会话幂等(Node 8)、原生 EPUB(Node 2/3/7)、F3 Tauri setup panic(本机不可编译 Tauri crate,交 Mac)、Apple Silicon 门禁(Node 0)。
- 基线(独立复跑,非自述):web vitest 158 passed/2 skipped(14 files);core 66 passed/1 ignored(40 单测 + 25 foundation + 1 lifecycle);oxlint 6 warnings(Library/Today/Map 各 1 set-state-in-effect,EpubView 3 refs)。
- 环境:/p 卷群组配额 100%,工作仓库改为 /bigtemp/fzv6en/book-learner/review-clone;CARGO_TARGET_DIR=/bigtemp/fzv6en/book-learner/cargo-target。
- 推送:本机 PAT 已撤销(push:false)。每 Task 本地 commit;凭证恢复后 `git push origin linux-local:feat/mac-m1 feat/m1-hardening`,补记 CI URL。
- 远端 CI 现状:main/feat/mac-m1 各 run 均在 `pnpm install --frozen-lockfile` 失败(corepack pnpm 版本漂移);本地 980e83e 已修(`corepack prepare pnpm@11.24.0 --activate`),随上述推送生效。

## 2026-09-05 · M1 加固切片完成(feat/m1-hardening,Linux)
- 前端(T1–T6b):新增 `lib/useAsyncResource`(6 用例)与 `lib/useBackendOperation`(8 用例);七页面全部迁移,features/ 下再无自持 generation/mounted/guard ref;MapPage/ReaderPage 以 key 重挂载处理参数切换。费曼页初始化管线与 send/end/confirm 全部接 hook(F7,+7 用例);Today conflict 刷新后恢复(F6)、完成后刷 stats(F9,有意改动 today.test.tsx:472 断言 1→2)、跨页一次性提示 `store.pendingNotice`;Settings 数字草稿(F10);EpubView 回调 ref 改提交期同步;tauri.ts 非契约拒绝 → `transport_error` + 脱敏摘要(F8,有意更新 it.each 用例,隐私断言保留)。oxlint **0 warnings**(原 6 条全消)。
- core(T7–T9b):ai.rs stderr 并发排空/进程组终止/有界尾部(+3 用例,libc 依赖);memory.rs slug 白名单 + 原子写(+3 用例);db.rs busy_timeout 显式化、v2 收敛(F2)、v3 外键重建与 book_single_active(+8 用例,删 1 条语义相反旧用例);sched 读后写事务 IMMEDIATE;insert_book 降级 paused、set_active_book 要求有计划(F4/F5,+2 foundation 用例 + 1 Mock 契约用例)。
- code-review F1–F10 处置:F1 **部分误报**——rusqlite `Connection::open` 默认已设 5s busy_timeout,`open()` 并发实测本就成功;真问题是 `generate_daily` DEFERRED 读后写升级锁(已改 IMMEDIATE 并用并发用例锁定)。F2/F4/F5/F6/F7/F8/F9/F10 已修;**F3(Tauri setup panic)交 Mac 阶段**(本机不可编译 Tauri crate)。
- 与计划偏差:ReaderPage 迁移为计划外新增(否则 DoD"页面无自持 generation"不成立);T9a 并入 insert_book 降级(唯一索引落地后既有多书用例会撞索引,需同 commit 绿);set_plan 的 1e 语义由既有两条用例已锁定,未新增。
- 最终门禁:web vitest **186 passed / 2 skipped**(16 files)、tsc、oxlint 0、build 181 modules(单 chunk 604 kB 警告如前);core **53 单测 + 27 foundation + 1 lifecycle** 全绿、1 ignored(真实 codex)、clippy -D warnings 干净、fmt --check 通过。
- 回写:web/ARCHITECTURE.md(规则 1 契约面、规则 5 单点 hook、目录导览 lib/)、TECH_DESIGN §3.5/§4/§5.1、IMPLEMENTATION_PLAN 加固切片注记、基线文档 Node 1/4/6/10 状态。
- **待推送清单(本机无凭证,PAT 已撤销)**:`linux-local`(→ origin/feat/mac-m1,8 提交)与 `feat/m1-hardening`(15 提交)。凭证到位后:`git push origin linux-local:feat/mac-m1 feat/m1-hardening`,创建 PR #3(feat/m1-hardening → feat/mac-m1,堆叠),补记 CI URL。
- 后续建议:为"切换到无计划书籍"增加专用 IPC 错误码/文案(现复用 conflict 通用文案);Reader/Feynman 路由懒加载以压缩 604 kB 主包(基线 P1);F3 在 Mac 上修。

## 2026-09-05 · 加固切片合并入 linux-local
- 按用户选择,`feat/m1-hardening` 快进合并进本地 `linux-local`(= 待推送的 feat/mac-m1 续做分支),feature 分支删除。合并结果复跑:core 53+27+1 绿、web 186/2 绿。
- **待推送**:`linux-local` 领先 `origin/feat/mac-m1` 23 提交(8 Mac Foundation 续做 + 15 加固)。命令:`git push origin linux-local:feat/mac-m1`;远端 feat/mac-m1 之前是直接 merge 进 main 的,这批需再开 PR(feat/mac-m1 → main)。
- 便携方案:`/bigtemp/fzv6en/book-learner/feat-mac-m1-pending.bundle` 含这 23 个提交,可在有凭证的机器上 `git fetch <bundle> linux-local` 后推送。
- 权威工作副本为 `/bigtemp/fzv6en/book-learner/review-clone`;`/p/fzv6enresearch/xwl/book-learner` 副本停留在 d23ab9f(卷满不可写)。

## 2026-09-05 · Plan A 评审通过与启动(feat/m1-core-engine,Linux)
- 环境事故:本机 `/p/fzv6enresearch`(corezfs02 NFS)挂死,`~/.bashrc` 的 conda hook 让所有登录 shell 卡在 D 状态;已给两个 conda 块加 `timeout --foreground -s KILL 5 python -c pass` 可达性守卫(原文件备份 `~/.bashrc.bak-2026-09-05-before-nfs-guard`),shell 恢复。/p 卷仍不可用,工作全部在 /bigtemp 与 /u。
- Plan A 独立评审两轮:第一轮 10 条 Issue + 9 条建议(planA-review.md)全部并入;第二轮新发现 5 条 Issue(用户判定未传到 md 投影、Stage B 语义无效草图卡死作业、source_section 格式与 hint 列、pending 回合 id 未暴露、block_eval 跨崩溃重放重复)+ 8 条建议,全部并入后 **Approved**;末轮 4 条 advisory 亦已写入计划。与建议的一处有意偏离:relearn 保持 `learning`,改 `next_new_blocks` 含 learning(计划文首"评审修订记录")。
- 计划范围:schema v4、Codex 限额/校验、幂等 AI 编排、prompt 与严格解析、两阶段地图作业、地图确认、持久会话/回合、评估与判定、投影 outbox、端到端集成;ADR 0001–0004 落档(0004 Deferred)。
- 基线(独立复跑):core 53 单测 + 27 foundation + 1 lifecycle 全绿、1 ignored;web vitest 186 passed / 2 skipped(16 files)。
- 推送:本机无凭证,每 Task 本地 commit;Plan A DoD 达成后打 tag `m1-linux-a`。

## 2026-09-05 · A-T1 schema v4 完成
- 追加式迁移 v3→v4:`book.map_revision/import_state`,新表 `spine_item`(不对 href 唯一)/`block_anchor`(含 `hint`/`text`)/`map_job`/`ai_request`/`session_turn`/`projection_outbox`,`feynman_session` 增 `task_id/state/version/client_request_id/verdict_request_id/verdict_json` 与三条部分唯一索引(每任务一未确认会话、请求 id、判定 id)。
- RED:4 条新用例 + 3 条既有版本断言失败(7 failed);GREEN 后 core 57 单测 + 27 foundation + 1 lifecycle,clippy -D warnings 干净,fmt 通过。
- 偏差:无。`ai_request` 主键重复的扩展码是 `SQLITE_CONSTRAINT_PRIMARYKEY`(TEXT 主键非 rowid 别名),用例按此断言。

## 2026-09-05 · A-T2 Codex provider request_id、限额、校验与连接测试完成
- `CompletionRequest` 增 `request_id` 并派生 Clone(ai.rs 7 处 + lifecycle.rs 1 处字面量补齐);`MAX_PROMPT_BYTES=100 KiB`(渲染后 UTF-8 字节,spawn 前拒绝)、`MAX_OUTPUT_BYTES=1 MiB`(metadata 先判);`validate(workdir)`(裸名走 PATH 查找)与 `test_connection()`(`--version`,10s,进程组)。子进程等待/超时/补杀抽为 `wait_with_timeout`,stdout/stderr 排空共用泛型 drain。
- RED:5 条新用例编译失败(缺字段/常量/方法);GREEN 后 core 62 单测 + 27 + 1,clippy/fmt 通过。恰在 100 KiB 上限的 prompt 实测可 spawn(Linux MAX_ARG_STRLEN 128 KiB)。

## 2026-09-05 · A-T3 幂等 AI 请求编排完成
- 新模块 `orchestrate.rs`:`AiPolicy`(传输重试 2、纠错 1、退避 500ms 起,测试置 0)、`run_ai_request`(非 autocommit 直接拒绝;done 重放;pending/failed 续跑;accept 通过才记 done;`Ai|Io` 重试,其它不重试)、`run_ai_json`(parse 闭包兼 accept;失败恰纠错一次并把摘要追加到 system;Replayed 结果不再通过时作废重调)、`validate_request_id`/`validate_client_id`。
- RED:13 条用例编译失败;GREEN 后 core 75 单测 + 27 + 1,clippy/fmt 通过。
- 偏差:策略结构体多一个 `retry_backoff_ms` 字段(计划未列,用于让测试不等待退避)。

## 2026-09-05 · A-T4 地图/迁移/情境化/讨论/终评 prompt 与严格解析完成
- prompts:`map_stage_a_prompt(ty, href, title, text)`(source_section 固定 `"{href}#{小节标题}"`)、`map_stage_b_prompt(ty, candidates_json)`(三类书组织原则 + 15–45 分钟 + 沿用格式)、`application_prompt`/`methodology_prompt`/`humanities_discussion_prompt`/`final_exam_prompt`(prompt only,本计划无消费者)。
- eval:`ChapterCandidate`/`DraftMap{modules[{name, blocks[{title, summary, source_sections, prereqs}]}]}`/`ApplicationResult`/`MethodologyFragment`/`DiscussionNote`/`FinalReport`(全部 deny_unknown_fields + Serialize),数组提取 `[`..`]`,终评 overall 1–5 校验。
- RED:6 条用例编译失败;GREEN 后 core 81 单测 + 27 + 1,clippy/fmt 通过。测试字面量含 `"#` 需避开 raw string 终止符(已改写)。

## 2026-09-05 · A-T5 两阶段知识地图作业完成
- 新模块 `mapgen.rs`:`store_spine`/`list_spine`(替换式缓存,`import_state='extracted'`,同 href 允许重复)、`resolve_source_section`(href / 章标题 / 文件名尾 → (href, hint))、`compact_candidates`、`validate_draft`(块数 1..=200、标题唯一、prereq 存在且三色 DFS 无环、source_sections 可解析、每模块 ≥1 块)、`run_map_job`(job 建/续:Stage A 逐章,>60 KiB 章按段落/字符边界切片 `:p{k}`;每章短事务存 next_chapter/candidates_json;Stage B 经 `run_ai_json` 且 parse 闭包含 validate_draft;候选超限先去 summary 压缩、仍超则 `too large` 失败;done 作业直接返回草图;失败记 stage/error)。
- RED:7 条用例编译失败;GREEN 后 core 88 单测 + 27 + 1,clippy/fmt 通过。
- 偏差:`run_map_job` 比计划多一个 `workdir: &Path` 参数(codex `-C` 需要记忆库根,计划签名漏列;后续 session/verdict 同样处理)。

## 2026-09-05 · 并行测试偶发 ETXTBSY 修复(A-T5 门禁复跑)
- A-T5 提交时的全量运行中 `ai::tests::codex_provider_returns_last_message` 偶发失败,复跑 5 次抓到根因:`spawn …: Text file busy (os error 26)`——并行测试写入可执行脚本时,另一测试 fork 出的子进程在 exec 前短暂继承了该写 fd。这是 L1 起就存在的测试设计隐患,新增的 5 个 spawn 用例让概率上升。
- 修复:`CodexCliProvider` 的两处 spawn 改经 `spawn_with_retry`(`ErrorKind::ExecutableFileBusy` 有界重试 20×10ms;生产中二进制被替换时同样受益)。门禁脚本 `/bigtemp/fzv6en/book-learner/gate.sh`(test + clippy + fmt --check,任一失败非零)连续 6 次全绿。
- 流程修正:此前 commit 命令未以门禁退出码串联,A-T5 提交时未拦住偶发失败(提交内容本身与该失败无关);此后所有 commit 一律 `gate.sh && git commit`。

## 2026-09-05 · A-T6 地图草图落库、slugify 与稳定 id/修订号的地图确认完成
- 新模块 `map.rs`:`slugify`(Unicode 字母数字保留、其余折叠为 `-`、≤40、空→`block-{seq}`、重复加 `-n`)、`AnchorSegment{spine_href,cfi_start,cfi_end,precision,hint,text}`、`apply_draft_map`(单事务:块/前置/每 source_section 一段 chapter_fallback 锚点含 hint;无法解析 → InvalidInput 整体回滚;revision 0→1;入队 `init_book`)、`confirm_map`(expected_revision 不等 → Conflict 无变更;Rename/RenameModule/Reorder(须为全排列)/SetSkipped/Merge(来源块 skipped、锚点段**复制**追加、prereq 重映射去重)/Split → InvalidInput;revision+1;入队 `sync_map`)、`set_anchor_segments`/`list_anchors`。
- `memory::apply_eval` 新签名 `(book_slug, block_id, title, block_slug, eval, passed, entry_key, date)`:文件 `{block_id:04}-{slug}.md`、frontmatter `block_id:`、`passed` 覆盖 verdict、历史行尾 `<!-- entry_key -->`、同 key 整次 no-op;`validate_slug` 改 pub(crate)。`models::next_new_blocks` 含 learning 纯按 seq;`sched::check_behind` 剩余块计 learning。`projection.rs` 先落 `enqueue`(A9 补 run_pending)。
- RED:42 处编译错误;GREEN 后 core 100 单测 + 27 + 1(含既有 memory 4 条改签名、lifecycle 改 `0001-elasticity.md`),门禁脚本全绿。
- 偏差:`projection.rs` 提前在本 Task 创建(仅 enqueue);计划把它列在 A9。

## 2026-09-05 · A-T7 持久化费曼会话、幂等回合与固定上下文组装完成
- 新模块 `session.rs`:`get_session`(TurnView 含 `client_turn_id`/`ready_to_end`,学生文本输出时剥离 `[READY_TO_END]`)、`start_or_resume_session`(client_request_id 幂等;同任务未确认会话 resume;非当日/不存在 → NotFound;任务非 pending → Conflict;kind 映射 new→learn/weak_retest→retest/review→review)、`fixed_context_for_block`(exact 段 text 优先、fallback 整章且同章只取一次、60 KiB 字符边界截断、历史评估/薄弱点/前置状态)、`submit_turn`(①同 turn id done 重放/pending 续跑 ②事务 A 校验 state/无 pending/版本并写 pending 回合不 bump ③无事务 run_ai_request `turn:{sid}:{turn}` ④事务 B 复查 state='open'、落库学生原文、version+1)、`abandon_session`(允许 pending;confirmed/abandoned → Conflict)。
- RED:31 处编译错误;GREEN 后 core 109 单测 + 27 + 1,门禁全绿。修了两处测试自身问题(RefCell 借用跨调用、clippy 类型复杂度)。
- 偏差:`submit_turn` 比计划多 `workdir` 参数(同 A-T5 理由)。

## 2026-09-05 · A-T8 评估请求与原子判定流转完成
- `sched::apply_eval_in_tx(conn, block_id, eval, verdict, date)` 抽出(不开事务、显式 verdict),`apply_eval_to_db` 保留为包装;新模块 `verdict.rs`:`request_evaluation`(前置:无 pending 回合、≥1 用户回合;open→evaluating 短事务;`eval:{sid}:{rid}` 经 run_ai_json;成功 evaluated+version+1,失败回 open;evaluated 同 id 重放/异 id Conflict;evaluating 态无 eval 行或同 id 续跑、异 id Conflict)、`confirm_session_verdict`(单 IMMEDIATE 事务:同 `verdict:{sid}:{rid}` 已确认 → 从 verdict_json 重建且不看版本/pass;state 须 evaluated、版本一致;用户 pass 覆盖 AI verdict;new → apply_eval_in_tx + pass 时 task done;weak_retest/review 不改块、只走 on_weak_retest/on_review_result 且 task done;outbox new 4 行 / 其它 3 行,`block_eval` 载荷含 passed 与 entry_key;session confirmed、version+1)。
- `verdict_request_id` 存命名空间化的 `verdict:{sid}:{rid}`(全局唯一索引下避免跨会话的客户端 id 碰撞)。
- RED:16 处编译错误;GREEN 后 core 121 单测 + 27 + 1,门禁全绿。修正一处测试预期:人为把 state 置回 evaluating 后同 id 续跑会重做事务 B(版本再 +1),这是真实崩溃语义,不是缺陷。
- 偏差:`request_evaluation` 多 `workdir` 参数(同前)。

## 2026-09-05 · A-T9 投影 outbox 重放完成
- `projection::run_pending(conn, memory)`:按 id 顺序处理 pending/failed 行(attempts+1),处理器 init_book(ensure_book)/ block_eval(先 ensure_book 防御,再 apply_eval 带 passed 与 entry_key)/ sync_weakpoints / sync_map / git_commit,slug/标题/块列表重放时从 SQLite 读取;成功 done、失败 failed+error 并停止本轮;返回成功条数;非 autocommit 拒绝。
- 用例:完整链路(草图落库 → 会话 → 评估 → 确认)后重放 5 行 → 目录/块 md/薄弱点/地图镜像/INDEX/git 一致,二次重放 0;用户判定覆盖到 md;"文件已写、done 未落库"重放不重复历史行;.git 权限 000 → 前 4 行 done、git 行 failed,恢复后仅重试该行且 git 只多一提交;同 op_id 二次入队忽略;未知 kind failed 且不越过。
- RED:8 处编译错误;GREEN 后 core 126 单测 + 27 + 1,门禁全绿。

## 2026-09-05 · A-T10 端到端集成、文档回写与 Plan A 收尾(tag m1-linux-a)
- 集成测试 `core/tests/m1_engine.rs`:建书 → store_spine(3 章)→ run_map_job → apply_draft_map → set_plan → Day0 队列 → 会话两回合(第二回合 READY_TO_END)→ 评估 → 确认通过 → run_pending 5 行(init_book + 4,不手工 ensure_book;块 md/薄弱点/地图/git 一致)→ **重开连接** run_pending=0、同 request_id 确认重放同 outcome → Day1 队列 `[weak_retest, review, new]`。MockProvider 在每次回调里用第二连接写入 7 行 probe,证明 AI 调用期间无事务持有。
- 最终门禁:core **126 单测 + 27 foundation + 1 lifecycle + 1 m1_engine** 全绿、1 ignored(真实 codex),clippy `-D warnings` 干净,`cargo fmt --check` 通过;web 未改动(186/2 基线不变)。每 Task 用例数:A1 57 → A2 62 → A3 75 → A4 81 → A5 88 → A6 100 → A7 109 → A8 121 → A9 126。
- 与计划的偏差汇总:①`run_map_job`/`submit_turn`/`request_evaluation` 各多一个 `workdir: &Path` 参数(codex `-C` 需记忆库根);②`AiPolicy` 多 `retry_backoff_ms`;③`projection.rs` 的 `enqueue` 提前到 A6;④`verdict_request_id` 存 `verdict:{session}:{request}` 命名空间形式;⑤修了一处 L1 起就存在的并行 spawn 测试 ETXTBSY 隐患(单独 commit);⑥relearn 保持 `learning` 并让 `next_new_blocks`/`check_behind` 计 learning(评审建议的有意偏离,计划文首已记)。
- 回写:TECH_DESIGN §3.1(块文件命名 + 历史行幂等标记)、§3.3(outbox 投影已实现)、§4(v4 与 AI 期不持事务)、§5.1/5.2(编排与限额、CompletionRequest.request_id)、§6.1/6.2/6.3 已实现标注与 §6.4–6.8 prompt-only 标注、§7.2(锚点段 + hint);IMPLEMENTATION_PLAN 加 Plan A 注记;基线文档 Node 1/4/5/6/8/9 状态。
- **Mac 阶段需接线的 command 清单(按 Plan B 契约 v2 命名 → core 用例)**:`storeSpine(bookId, chapters)` → `mapgen::store_spine`;`runMapJob(bookId, jobId)`(进度 `MapProgress` 经 Tauri event)→ `mapgen::run_map_job` + 完成后 `map::apply_draft_map`;`confirmMap(bookId, expectedRevision, ops)` → `map::confirm_map`;`setAnchorSegments(blockId, segments)`/`listAnchors(blockId)` → `map::*`;`startOrResumeSession(taskId, clientRequestId)` → `session::start_or_resume_session`(date=本地日历日);`getSession(sessionId)` → `session::get_session`;`submitTurn(sessionId, expectedVersion, clientTurnId, text)` → `session::fixed_context_for_block`(profile 摘要取 memory/profile.md 前两节)+ `session::submit_turn`(workdir=记忆库根);`abandonSession(sessionId, expectedVersion)` → `session::abandon_session`;`requestEvaluation(sessionId, requestId)` → `verdict::request_evaluation`;`confirmSessionVerdict(sessionId, expectedVersion, requestId, pass)` → `verdict::confirm_session_verdict`,随后异步 `projection::run_pending`;`runProjection()`(启动恢复与后台同步)→ `projection::run_pending`;设置页"测试连接" → `ai::CodexCliProvider::validate/test_connection`;`completeTask` 保持 unsupported。所有慢调用不得持 `Mutex<Connection>`(核心已保证 AI 期无事务,壳层需在调用期间释放连接守卫或使用独立连接)。
- **待推送**:`feat/m1-core-engine`(A-T0…A-T10 共 12 提交,基于 linux-local)。Plan B 分支将基于本分支。

## 2026-09-05 · Plan B 评审通过与启动(feat/m1-web-contract,Linux)
- Plan B(`docs/superpowers/plans/2026-09-05-m1-web-contract-linux.md`)独立评审两轮:第一轮 2 条 Issue(unsupported 列表重复 confirmMap;无改动定稿必须仍打开目标设定)+ 6 条建议(评估/判定 id 用每会话常量 `'eval'`/`'verdict'`、契约加 `date`、tauri fixture 补字段、往返还原用 EpubCFI.toRange、门控用例用拒绝型假 invoke、bundle 显式列 tag)全部并入后 **Approved**;末轮 2 条 advisory(evaluating 态禁用输入、放弃用水合版本)亦已写入。
- 范围:契约 v2(追加式演进,B7 删旧)、MockBackend v2 语义、TauriBackend 门控解码器、费曼页/地图页/导入向导接新契约、EPUB JS 侧抽取与多段 CFI 锚定(Playwright)、回写与 tag `m1-linux-b` + bundle。
- 基线(独立复跑):web vitest 186 passed / 2 skipped(16 files)、oxlint 0 warnings、build 181 modules、Playwright 1 passed(需 `PLAYWRIGHT_BROWSERS_PATH=/bigtemp/fzv6en/book-learner/playwright-browsers`,浏览器不在 ~/.cache——计划已更新命令);core gate 126+27+1+1。

## 2026-09-05 · B-T1 契约 v2 追加、MockBackend v2 语义、Tauri 门控存根完成(补记:本条与 B-T2 条目在各自 commit 时未成功追加,于 B-T3 补入)
- core:`KnowledgeBlock.skipped`(BLOCK_COLS/RawBlock/parse + 用例)。web:`types.ts` 增 SpineChapter/AnchorSegment/MapProgress/MapEditOp/SessionState/SessionKind/TurnView/SessionView/TurnResult/EvaluationView/VerdictOutcome,`Book.mapRevision`、`KnowledgeBlock.skipped`;`Backend` 接口追加 9 个 v2 方法(confirmMap 旧签名保留到 B4);wire 契约追加 10 条 command、unsupported 列表 11+9;`lib/ids.ts`(`newClientId`,规则同 core `validate_client_id`,randomUUID 回退)。
- MockBackend v2:一任务一未确认会话 + clientRequestId 重放;`submitTurn` 同 clientTurnId 重放/版本冲突/空文本拒绝;`requestEvaluation` 同 id 重放、异 id 冲突;`confirmSessionVerdict` 原子(new:pass→passed+scores+passedAt=date+task done,relearn→learning;weak/review 不改块)、同 requestId 重放、outboxOps 4/3;`abandonSession`;`storeSpine`/`runMapJob`(进度 chapter×N→merging→done、块由章标题生成、每块一段 chapter_fallback 锚点、同 jobId 幂等、jobId 跨书冲突)/`setAnchorSegments`/`listAnchors`(blockSource 取段文本)。错误码/文案与 tauri.ts IPC_ERRORS 一致。
- TauriBackend:`decodeBook.mapRevision`/`decodeBlock.skipped` 缺省时默认 0/false(Mac DTO 待补,接线清单);9 个 v2 方法显式 `unsupported`。传输用例的"受支持命令"过滤改为排除 unsupportedCapabilities 门控项。
- RED:vitest 15 failed(含 ids 模块缺失)、core 编译错;GREEN:web 199 passed / 2 skipped(17 files)、tsc、oxlint 0、build;core gate 127+27+1+1。

## 2026-09-05 · B-T2 TauriBackend v2 解码器与契约门控完成(补记)
- `TauriBackend(invokeFn, { contract?, listen? })`:`gated(method, run)` 按契约 `unsupportedCapabilities` 门控(在列 → 显式 `not_implemented`;Mac 接线后移除条目即启用);9 个 v2 方法落地 command 名/payload/出站校验(`outboundClientId` 规则同 core、chapters/segments/pass/date)与解码器(SessionView/TurnView/Eval/TurnResult/EvaluationView/VerdictOutcome/AnchorSegment/MapProgress,路径化 `invalid_response`);`runMapJob` 经注入的 `listen` 订阅 `map_job_progress`(按 jobId 过滤、畸形事件忽略、invoke 结束/失败后 unlisten;无回调不订阅),默认动态加载 `@tauri-apps/api/event`。
- RED:25 failed;GREEN:web 225 passed / 2 skipped(17 files)、tsc、oxlint 0、build。实现修正:`gated` 须为 async,出站校验的同步 throw 才成为 rejection。

## 2026-09-05 · B-T3 费曼页接会话契约 v2 完成
- `FeynmanPage`:初始化管线末步 `startOrResumeSession(taskId, clientRequestId(挂载一次), today)`,幂等故允许重试初始化(删除单次守卫);`TeachingRoom` 以 sessionId 为 key 从服务端视图水合(done 回合 → 对话流、version、readyToEnd、evaluated → 直接评估卡、pending 用户回合 → 显示 + "上次发送未完成" 重试、evaluating → 输入禁用 + "继续评估")。发送:`clientTurnId` 触发时生成一次进入 args,重试复用(同 id、同旧版本);评估/判定 id 为每会话常量 `'eval'`/`'verdict'`;确认走 `confirmSessionVerdict(sessionId, version, 'verdict', pass, today)` 单步原子(不再 completeTask/pendingNotice);放弃走 `abandonSession(sessionId, version)`,失败留在页面可重试。
- 测试重写 20 条(fireEvent+act):契约参数、4 轮→评估→原子判定回今日(版本 5)、重挂载水合同会话、已评估/评估中/pending 回合水合、失败重试参数完全相同、版本冲突、放弃成功/失败、初始化失败重试沿用同一 clientRequestId、既有错误隔离用例。
- GREEN:web **228 passed / 2 skipped(17 files)**、tsc、oxlint 0、build。

## 2026-09-05 · B-T4 地图页接稳定 id 操作集与修订号乐观并发完成
- 契约:`confirmMap(bookId, expectedRevision, ops) → { revision }`(删 `MapEditBlock`);Mock 在工作副本上按序应用 rename/renameModule/reorder(须全排列)/setSkipped/merge(来源 skipped、锚点段复制、prereq 重映射)/split(invalid_request),全部合法才提交,修订号不符 conflict、成功 +1;TauriBackend `map_confirm` 门控 + `outboundOps` 逐变体校验 + `decodeRevision`。
- MapPage:`listBooks` 资源改为 `{title, mapRevision}`;编辑初值沿用 `block.skipped`,浏览模式显示"已跳过",目标换算只计未跳过块;`finalize` 用 `features/map/mapOps.ts` 的 `diffMapOps`(renameModule → setSkipped → reorder)差分,无差异不调后端但仍退出编辑并打开目标设定;成功后重载块与修订号(第二次定稿带新修订号);conflict 不可重试、编辑保留。
- 测试:Mock confirmMap 3 条(操作集生效且不触碰已通过块、非法操作原子拒绝、merge);Tauri 命令/出站/入站各补 confirmMap;地图页 5 条新用例 + 2 条既有用例按计划调整("进行中双击"先做一个编辑;"定稿后目标设定"断言不调后端)。
- GREEN:web **239 passed / 2 skipped(17 files)**、tsc、oxlint 0(`diffMapOps` 从页面文件移到 `mapOps.ts` 以满足 only-export-components)、build。

## 2026-09-05 · B-T5 EPUB spine 抽取与小节标题多段 CFI 锚定完成(Playwright 真浏览器覆盖)
- fixture:`make-fixture-epub.mjs` 每章增 h2 小节(chap1 "小结"×2 章内重复、chap2 "小结" 跨章重复、chap3 `机会<em>成本</em>` 嵌套节点),h1/href 不变,重生成 `public/fixtures/sample.epub`(3823 B);既有 cfi-smoke 仍通过。
- `epub/headings.ts`(纯逻辑,vitest 6 条):`normalizeHeading`(NFKC、去"第X章/节/1.2/一、/(三)"编号、折叠空白、小写)、`normalizeText`(行内折叠、空行去除、段落 "\n\n" 分隔——与 core Stage A 切片边界一致)、`pickHeading`(精确 > 包含;重复标题按 used 依次消费;空 hint → null)、`segmentEnd`(下一个 level ≤ 本级的标题)。
- `epub/extract.ts`:`openEpub`、`spineSections`(spine.each)、`loadSection`、`chapterMarkdownText`(标题层级 "# "/"## " 标记 + 块级分段)、`chapterPlainText`(无标记,fallback 段用)、`extractSpine`(TOC label 匹配 href ?? 首个 h1..h3 ?? href;href 去重;每章 unload)。`epub/anchors.ts`:`resolveBlockAnchors`(命中 → [标题首个文本节点起, 下一同级/更高级标题首个文本节点起) exact 段,两个**点** CFI + 归一化文本;未命中/空 hint → 整章 chapter_fallback)、`restoreSegmentText`(EpubCFI.toRange 两点组合 Range)。
- harness `anchors-smoke.html`/`src/anchors-smoke.ts` + `e2e/anchors-smoke.spec.ts`:spine 3 章/标题/标记文本、精确段在下一小节前结束、章内重复标题 CFI 不同且按序、跨章同名独立、嵌套节点可匹配、缺失/空 hint 回退整章且文本等于 chapterPlainText(≠ 带标记的 spine 文本)、7 段中 5 个 exact 段往返还原相等、多段顺序保持。
- GREEN:vitest **245 passed / 2 skipped(18 files)**、tsc、oxlint 0、build、Playwright 2/2(`PLAYWRIGHT_BROWSERS_PATH=/bigtemp/fzv6en/book-learner/playwright-browsers`)。

## 2026-09-05 · B-T6 导入向导接 spine 抽取、storeSpine 与地图作业进度完成
- `ImportWizard`:attempt 记 `{file, type, jobId(选类型时 newClientId 一次), bookId?, chapters?}`;op 依次 importEpub(已导入跳过)→ `openEpub(file.arrayBuffer()) + extractSpine`(已抽取跳过;失败映射为不可重试 `invalid_request`"无法解析这个 EPUB 文件",book 一律 destroy)→ `storeSpine` → `runMapJob(bookId, jobId, p => setProgress(progressLabel(p)))`;重试复用同一 attempt(同 jobId)。`features/library/importProgress.ts` 的 `progressLabel`:chapter → "正在分析第 i/n 章:标题"、merging → "正在整合知识地图…"、done → "已生成 N 个知识块"。
- 测试(vi.mock 抽取模块;真实抽取由 Playwright 覆盖):完整进度链路与跳转、作业失败重试只重跑作业且 jobId 相同(导入/抽取各 1 次)、抽取失败不可重试并保留文件与类型、既有可重试导入/原生不支持/进行中防重复用例(storeSpine 对假 bookId 需 stub;vi.mock 工厂的 vi.fn 需在 beforeEach mockClear)。
- GREEN:web **247 passed / 2 skipped(18 files)**、tsc、oxlint 0、build(门禁脚本 `/bigtemp/fzv6en/book-learner/webgate.sh`,取代此前会静默跳过的 && 链)。

## 2026-09-05 · B-T7 移除旧契约、回写文档,Plan B 收尾(tag m1-linux-b)
- 删除 v1 契约:`Backend` 接口/Mock/TauriBackend 的 `generateMap/startSession/studentReply/endSession/confirmVerdict` 与 `MapEditBlock`;wire `unsupportedCapabilities` 精确为 5 项显式未支持(importEpub/completeTask/blockSource/epubUrl/stats)+ 10 项契约门控(v2);Mock 契约用例改用 v2 方法;`grep -rn "generateMap|startSession|studentReply|endSession|confirmVerdict|MapEditBlock" web/src shared` 为空(费曼页局部处理函数改名 `decide`)。
- 回写:`web/ARCHITECTURE.md` 规则 6(id 与版本单点、服务端视图水合)、目录导览(lib/ids.ts、epub/)、能力矩阵 8/10/5;`TECH_DESIGN.md` §1.1 契约 v2 与 EPUB JS 侧、§1.2 矩阵指引、§7.2/§7.3 已实现标注;基线文档 Node 5/6/8/9/10 web 侧状态。
- 每 Task 用例数(web vitest):B1 199 → B2 225 → B3 228 → B4 239 → B5 245 → B6/B7 247(+2 skipped,18 files);Playwright 2 specs;core gate 127 单测 + 27 + 1 + 1(Plan B 仅加 `KnowledgeBlock.skipped`)。
- 与计划的偏差汇总:①B1/B2/B4/B5 的 DEVLOG 条目在各自 commit 时因 `&&` 链静默中断而缺失,分别补记/amend(B3 补 B1/B2;B4/B5 amend);改用 `webgate.sh`/`gate.sh` 显式门禁后不再发生;②`gated()` 须为 async 才能把出站校验的同步 throw 变成 rejection;③`diffMapOps` 从页面文件移到 `mapOps.ts`(only-export-components);④导入向导测试对假 bookId 需 stub `storeSpine`,vi.mock 工厂的 vi.fn 需 beforeEach mockClear;⑤费曼页 `confirmVerdict` 局部函数改名以保证旧名 grep 为空。
- **待推送清单(本机无凭证)**:`feat/m1-core-engine`(A-T0…A-T10 + ETXTBSY 修复,基于 linux-local)、`feat/m1-web-contract`(B-T0…B-T7,基于 feat/m1-core-engine)、tags `m1-linux-a`、`m1-linux-b`。便携:`git bundle create /bigtemp/fzv6en/book-learner/m1-linux-pending.bundle ^origin/feat/mac-m1 feat/m1-core-engine feat/m1-web-contract m1-linux-a m1-linux-b`(在本条 commit 与打 tag 之后创建;`git bundle verify`/`list-heads` 结果写入同目录 `m1-linux-pending.bundle.verify.txt`)。凭证到位后:`git push origin linux-local:feat/mac-m1 feat/m1-core-engine feat/m1-web-contract m1-linux-a m1-linux-b`,按顺序开 PR(feat/mac-m1 → main;feat/m1-core-engine → feat/mac-m1;feat/m1-web-contract → feat/m1-core-engine)。
- **Mac 阶段需接线的 command 清单(wire 名 → core 用例;DTO 为 camelCase 镜像,全部已有 TS 解码器与假 invoke 用例)**:
  1. `map_store_spine[bookId, chapters: SpineChapter{idx,href,title,text}[]]` → `mapgen::store_spine` → unit(null)。
  2. `map_run_job[bookId, jobId]` → `mapgen::run_map_job`(workdir=记忆库根;进度经 `MapProgress` 回调发 Tauri event `map_job_progress` payload `{jobId, progress:{stage:'chapter',index,total,title}|{stage:'merging'}|{stage:'done',blocks}}`)→ 成功后 `map::apply_draft_map`(已落库则跳过)→ 返回 `KnowledgeBlock[]`(含 `skipped`)。
  3. `map_confirm[bookId, expectedRevision, ops: MapEditOp[]]` → `map::confirm_map` → `{revision}`;ops 变体 `rename{blockId,title}|renameModule{from,to}|reorder{blockIds}|setSkipped{blockId,skipped}|merge{into,from}|split{blockId}`。
  4. `map_set_anchor_segments[blockId, segments: AnchorSegment{spineHref,cfiStart,cfiEnd,precision,hint,text}[]]` → `map::set_anchor_segments` → unit;`map_list_anchors[blockId]` → `map::list_anchors`。
  5. `session_start_or_resume[taskId, clientRequestId, date]` → `session::start_or_resume_session` → `SessionView{sessionId,taskId,version,state,blockId,kind,transcript:TurnView{role,text,status,clientTurnId|null,readyToEnd}[],eval|null}`。
  6. `session_submit_turn[sessionId, expectedVersion, clientTurnId, text]` → `session::fixed_context_for_block`(profile 摘要取 memory/profile.md)+ `session::submit_turn`(workdir=记忆库根)→ `TurnResult{studentText,readyToEnd,version}`。
  7. `session_request_evaluation[sessionId, requestId]` → `verdict::request_evaluation` → `EvaluationView{eval,version}`(requestId 前端固定为 `'eval'`)。
  8. `session_confirm_verdict[sessionId, expectedVersion, requestId, pass, date]` → `verdict::confirm_session_verdict`(requestId 前端固定为 `'verdict'`)→ `VerdictOutcome{passed,blockStatus,taskDone,outboxOps,version}`,随后异步 `projection::run_pending`。
  9. `session_abandon[sessionId, expectedVersion]` → `session::abandon_session` → unit。
  10. DTO 补字段:`Book.mapRevision`(core `book.map_revision`)、`KnowledgeBlock.skipped`(core `KnowledgeBlock.skipped`)——TS 解码器目前缺省 0/false,接线后视为必填。错误码映射:core `Conflict→conflict`、`InvalidInput→invalid_request`、`NotFound→not_found`(前端文案已就位)。
  接线步骤:实现 command → 从 `shared/tauri-wire-contract.json` 的 `unsupportedCapabilities` 移除该方法名 → `contract.test.ts` 精确列表同步 → TauriBackend 自动走真实 command。所有慢调用不得持 `Mutex<Connection>`(core 已保证 AI 期无事务,壳层需在调用期间释放连接守卫或用独立连接);启动恢复调用 `projection::run_pending`。

## 2026-09-05 · Plan B 复选框补勾与 bundle 重建
- B-T5 的计划复选框在当时的 commit 中未勾上(同前述 && 链中断问题),本条补勾;Plan A/Plan B 现无未勾选步骤。tag `m1-linux-b` 重指向本提交(tag 从未推送),bundle `/bigtemp/fzv6en/book-learner/m1-linux-pending.bundle` 重建并重新 `verify`(结果见同目录 `.verify.txt`)。

## 2026-09-07 · Mac 阶段执行计划落档
- 新增 `docs/superpowers/plans/2026-09-07-mac-m1-wiring.md`(M0–M8):推送/三个堆叠 PR 合并 → Rust 侧 wire 常量同步(JSON 19/15 vs Rust 9/11,Tauri 契约用例会先红)→ F3 → Foundation 原生门禁(`mac-m1`)→ 独立连接策略/记忆库根/启动恢复 → 接线地图组 5 条、会话组 5 条 → ADR-0004(默认选项 B,先 spike)与原生导入/epubUrl/blockSource → stats/tray/有序退出 → 受控测试日期 + 端到端门禁(`m1`)。独立评审一轮:6 条问题(契约用例 match panic、tauri.test.ts 为第四处同步点、分支策略矛盾、Book.map_revision 无数据源、asset protocol 作用域写法、测试日期无机制)与 9 条建议全部并入。
- `CLAUDE.md` 状态区与阅读顺序更新:Mac 会话入口指向该计划。预计 5–6 个工作日。

## 2026-09-07 · 推送、三个堆叠 PR 与 CI 修复
- 用用户提供的窄权限 token 推送 47 提交并建三个堆叠 PR:[#3](https://github.com/aba122/book-learner/pull/3) feat/mac-m1→main、[#4](https://github.com/aba122/book-learner/pull/4) feat/m1-core-engine→feat/mac-m1、[#5](https://github.com/aba122/book-learner/pull/5) feat/m1-web-contract→feat/m1-core-engine。合并顺序应为 #3 → #4 → #5(#4/#5 的 base 需在前一个合并后改指 main,GitHub 不会自动重定向)。
- 首轮 CI(runs 34085387055 / 34085388775 / 34085389736)三分支全红,根因两处:
  - web 任务:`web/src/lib/useAsyncResource.test.ts` 提前构造 `Promise.reject(new Error('x'))`,在被 fetcher 取用前已是未处理拒绝,vitest 报 `Errors 1 error` 并以非零码退出(用例本身 247 通过)。该问题自加固切片起存在;本地门禁 `webgate.sh` 只匹配 "failed" 文本、未看退出码,故未察觉——门禁已改为检查退出码。修复:惰性构造 `() => Promise.reject(...)`。
  - mac-foundation 任务:加固切片使 `library::set_active_book` 要求书已有学习计划(F4),`web/src-tauri/tests/foundation.rs` 三个用例在设计划前激活书 → `Conflict`。改为先设计划再激活,契约循环前为 `first` 预置计划。feat/m1-web-contract 另缺 B-T1 新增的 `KnowledgeBlock.skipped` 字段(E0063 编译错),补 `skipped: false`。
  - 修复提交 997cec2 落在 feat/mac-m1,merge 进上两层(7ce9c5e / de0e272);`skipped` 补丁 21a8043 仅在 feat/m1-web-contract。Rust 改动在 Linux 无法编译,以 `cargo fmt --check` + CI(macos-14)为验证。
- 第二轮 CI:feat/mac-m1 [run 34087344533](https://github.com/aba122/book-learner/actions/runs/34087344533) 全绿;feat/m1-core-engine [run 34087343847](https://github.com/aba122/book-learner/actions/runs/34087343847) 全绿;feat/m1-web-contract [run 34087343910](https://github.com/aba122/book-learner/actions/runs/34087343910) web/core 绿、mac-foundation 红——仅 `real_tauri_ipc_surface_matches_the_shared_wire_contract` 在 `foundation.rs:517` 整体比对失败(JSON 19 命令 vs Rust `WIRE_COMMANDS` 9),即 Mac 计划 M0 的已知缺口,其余 8 个 Tauri 用例通过。PR #5 的 mac 任务在 M0 同步前保持红,不做绕过。
- 推送本条后即撤销 token(`POST /credentials/revoke`,验证 401),本机不留凭证。

## 2026-09-07 · Mac 阶段开工:经反向 SSH 隧道接管 Mac、环境与基线、M0 契约同步
- **通道**:Linux(portal11)经用户建立的 SSH 反向隧道(`127.0.0.1:22022` → Mac `wulinxie@MBP`,macOS 26.6.2,Apple Silicon 12 核/16G)以非交互 ssh 执行命令;长任务用 `~/Developer/bl-run.sh <name> <cmd>`(tmux 会话 + `caffeinate -i` 防休眠,日志/退出码在 `~/Developer/bl-logs/`)。
- **环境**:Mac 原无 Rust/tmux/仓库;装 rustup(stable 1.98.1,含 clippy/rustfmt;写入 `~/.zshenv`/`~/.profile`)、`brew install tmux`(3.7c);仓库克隆到 `~/Developer/book-learner`。**github.com 直连被阻断**(clone 挂起 10 分钟),已设 `git config --global http.https://github.com.proxy socks5h://127.0.0.1:7897`(仅作用于 github.com;7897 为本机 Clash 混合端口,HTTP 模式亦可,npm 走 `https_proxy` 明显更快);crates.io/ghcr.io 直连正常。Node 26.0.0(CI 为 22,未见不兼容)、pnpm 11.1.3 在仓库内按 `packageManager` 自动切到 11.24.0。Mac 无 GitHub 凭证(无 gh/无 keychain 条目/无 SSH key)——**推送与 PR 合并待用户**。
- **基线**(feat/m1-web-contract ab94e3f):web `install --frozen-lockfile` + vitest 247/2 + lint 0 + build 通过;src-tauri 如预期仅契约用例红(8/9);**core `ai::tests::timeout_kills_descendants` 在整套并行且同机负载(pnpm 安装同时进行)时失败**(marker 未在 1s 超时前写出),单跑通过;且其"孙进程已终止"检查读 `/proc`,在 macOS 上空转。修复:超时 1s→3s,新增 `descendant_gone()`(Linux 读 `/proc`,其他平台 `ps -o stat=`),Linux/Mac 均绿。`web/src-tauri/Cargo.lock` 补 core 的 `libc` 依赖(Linux 无法构建该 crate 故此前未更新)。
- **M0**:`WIRE_COMMANDS` 增 10 条、`UNSUPPORTED_CAPABILITIES` 对齐 JSON 15 项、10 个占位命令(参数名/类型按 `types.ts`,统一 `not_implemented`,`details.capability` = 前端方法名)、`lib.rs` 注册;契约用例增 `PLACEHOLDER_COMMANDS` 表与逐命令 payload,键比对改为集合比对。门禁:core 127/27/1/1、src-tauri 9/1/2、clippy 0、fmt 过。**偏差**:分支 `feat/mac-m1-wiring` 自 `feat/m1-web-contract` 开出(PR 未合并);`tauri dev` 目检待 GUI 会话;本机提交暂不推送。

## 2026-09-07 · M1:启动失败可见(F3)
- `initialize_state(platform_data_dir)` 抽出 setup 逻辑(解析路径 → 建目录 → 打开状态),错误全部类型化;`run()` 在 setup/runtime 失败时 `tracing::error!(error_code, internal_cause)` + 原生错误框 + `exit(1)`,不再 `expect` panic。
- **偏差**:未用 tauri-plugin-dialog——其 `blocking_show` 经 `run_on_main_thread` 派发,而 setup 在主线程且事件循环尚未启动,会死锁;改用其底层 `rfd 0.16`(同步 NSAlert,主线程可用),无 capability 变更。
- 用例:相对路径覆盖 → `invalid_request` 且文案含"绝对路径";正常目录 → `book-learner/app.db` 创建;不可写目录(chmod 000,root 跳过)→ `io_failure`/`db_unavailable` 且 internal_cause 非空。首编译错 `AppState: !Debug` 使 `unwrap_err` 不可用,改 `.err().expect()`。
- 无人值守冒烟(`~/Developer/f3-smoke.sh`,替代需 GUI 的手工项):`BOOK_LEARNER_DATA_DIR=relative` 启动 debug 二进制 → stdout 日志 `ERROR … error_code="invalid_request" internal_cause="BOOK_LEARNER_DATA_DIR was relative"`,进程停在对话框(6s 后仍存活;系统日志 `CFUserNotificationDisplayAlert: called from main application thread, will block`),按 pid 结束。门禁:src-tauri 10/1/2、clippy 0、fmt 过;`tauri build --debug --no-bundle` 19s 通过。
- **事故记录**:一次用 `pgrep -f target/debug/book-learner` 清理"遗留进程"时误杀了 pid 15833(`ps` 显示为已运行 9 天的 "(CGEAMarker)",与本项目无关,匹配原因未明);此后只按 pid 文件结束进程,不再用模糊匹配杀进程。
- zsh 坑:脚本里 `echo ===X===` 会被 `=cmd` 展开报错并中断 `&&` 链;字符串一律加引号。

## 2026-09-07 · M3:独立连接策略、记忆库根与启动投影恢复
- `AppState` 增 `database_path/data_root/memory/provider_override`:`open()` 同时 `MemoryStore::init(<data_root>/memory)`(含 git init,故所有壳层测试都要求 git 可用);`open_connection()` 给慢命令用独立连接(含 busy_timeout/外键/迁移),用例证明持有 `with_connection` 守卫期间另一线程经独立连接写入不被串行化;`memory_root()/books_dir()`;`with_provider(Arc<dyn AiProvider+Send+Sync>)` 测试注入点。
- `ai_provider()`:注入优先;否则 `CodexCliProvider{bin}`,`bin` 取 `setting.codexBin`(绝对路径;不是 `AppSettings` 字段,直接读表)→ `resolve_codex_bin(configured, PATH, HOME, fallback_dirs)` 纯函数:`$PATH` → `/opt/homebrew/bin` → `/usr/local/bin` → `~/.npm-global/bin` → `~/.nvm/versions/node/*/bin`(高版本优先);相对路径 → `invalid_request`,全部失败 → `not_found`("请在设置中填写其绝对路径")。固定目录经参数注入使用例不受本机 `/opt/homebrew/bin/codex` 影响。
- 启动恢复:`run_startup_recovery(&state)`(独立连接 + `projection::run_pending`)在 setup 内经 `tauri::async_runtime::spawn_blocking` 触发,结果写日志;用例:入队 `init_book` → 恢复处理 1 条并生成 `books/first/_map.md`,再次调用为 0(幂等)。
- 门禁:src-tauri 13/1/2、clippy 0、fmt 过。

## 2026-09-07 · M4:接线地图组 5 条 command
- **core**:`models::Book` 增 `map_revision`(`list_books` SELECT 该列;core 内无其他 `Book {}` 字面量)。
- **DTO**:`BookDto.mapRevision`、`KnowledgeBlockDto.skipped`;新增 `SpineChapterDto`、`AnchorSegmentDto`(precision 由 core 落库校验)、`MapEditOpDto`(`#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]`,与 `types.ts` 的 `MapEditOp` 判别字段一致)、`MapRevisionDto`、`MapProgressDto`(`tag = "stage"`)。
- **application**:`store_spine/confirm_map/set_anchor_segments/list_anchors` 走共享连接;`run_map_job` 走独立连接 + `ai_provider()`:`map_revision > 0` 直接返回块列表、不发进度、不调 provider(与 MockBackend 语义一致),否则 `mapgen::run_map_job` → `map::apply_draft_map`(Conflict 视为并发已落库,回退为返回现有块)。`expectedRevision` 负数 → `invalid_request`。
- **command**:`map_run_job<R: Runtime>(app: AppHandle<R>, …)` 用 `app.emit("map_job_progress", {jobId, progress})` 发进度;`*_inner` 接 `&mut dyn FnMut(MapProgressDto)` 便于直接测试。
- **契约四处同步**:JSON `unsupportedCapabilities` 移除 5 项(余 10 → 本任务后剩 `importEpub/completeTask/blockSource/epubUrl/stats` + 会话组 5 项);Rust 常量同步;`contract.test.ts` 列表;`tauri.test.ts`:传输用例改为只比对 v1 方法集(v2 传输已有独立用例)、"unsupported 路由"用例改为按 JSON 数据驱动(接线一条自动收缩)、"缺省 mapRevision/skipped"用例反转为必填(`invalid_response`);`tauri.ts` 解码器删除 `?? 0`/`?? false`。
- **用例**:`seeded_state` 拆出 `seed_books(&state)` 以支持 `AppState::with_provider` 注入;`MapMock` 按 request_id 后缀返回 Stage A/B;IPC 用例经 `app.listen_any` 捕获事件(MockRuntime 不执行 JS,但 Rust 端事件总线可用),断言 ≥3 条且 jobId 一致、末条 `{stage:"done",blocks:1}`。契约用例的地图组 payload 改用无块的 `second`(`seed_map` 直接用 core 落一张单块草图)。
- **门禁**:core 127/27/1/1、src-tauri 16/1/2、web 248/1 + lint 0 + tsc + build、clippy 0。两轮 clippy 修正:未用 `serde_json::Value`、`let_and_return`。

## 2026-09-07 · M5:接线会话组 5 条 command
- **core**:`MemoryStore::profile_summary()` = `profile.md` 前两节(知识背景、已掌握概念,带小节标题;其余小节由 codex 在工作目录自主翻阅),含单测。
- **DTO**:`EvalWeakPointDto/EvalResultDto`(verdict 字符串 `pass_suggested|relearn_suggested`)、`TurnViewDto`(`clientTurnId` 为 null 而非省略)、`SessionViewDto`(`eval` 为 null 而非省略)、`TurnResultDto`、`EvaluationViewDto`、`VerdictOutcomeDto`——与 `tauri.ts` 解码器逐字段对齐。
- **application**:`start_or_resume_session/confirm_session_verdict/abandon_session` 走共享连接;`submit_turn/request_evaluation` 为慢命令:`session_context()` 先经共享连接取 `get_session().block_id` → `fixed_context_for_block(profile_summary)` + 书类型,再用独立连接 + `ai_provider()` 调 core(AI 期间不持守卫)。`session_confirm_verdict` 命令成功后经 `AppHandle` 在 `spawn_blocking` 中复用 `run_startup_recovery` 重放投影(失败只记日志,下次启动补跑)。
- **契约四处同步**:JSON/Rust `unsupportedCapabilities` 仅剩 `importEpub/completeTask/blockSource/epubUrl/stats`;`contract.test.ts` 列表;`tauri.test.ts` 的"出厂契约门控 v2"用例反转为"出厂契约直达真实命令,仅列入 unsupported 时门控"。占位机制(`placeholder()`/`PLACEHOLDER_COMMANDS`)随 10 条全部接线而移除/清空(M6 新命令再启用)。
- **用例**:`EngineMock` 兼回应地图/回合(第二回合 `[READY_TO_END]`)/评估;`seed_two_tasks()` 给 first 两块 + 每日 2 新块计划生成两任务。闭环:开始(幂等/日期不符 not_found)→ 回合(同 clientTurnId 重放不调 provider、过期版本 conflict、空文本 invalid_request、第二回合 readyToEnd)→ 续接后 transcript 4 条(`clientTurnId` null/字符串)→ 未评估即判定 conflict → 评估 v3 → 判定通过 v4、同 requestId 重放同结果、块 passed → 投影重放生成块 md → 已确认不可放弃、会话 B 放弃后再放弃 conflict、不存在会话 not_found。契约用例改用 `state_with_mock` + 会话 A/B 预置,会话组 5 条 payload 按 JSON 顺序真实走通。

## 2026-09-07 · M6:EPUB 原生导入(ADR-0004 选项 B)、受管 epubUrl 与 blockSource
- **ADR-0004 → Accepted(选项 B)**:WebView 已持有 `File` 且抽取在 JS 侧,原生只收字节;不暴露任何用户路径。Spike 只在 MockRuntime IPC 层验证了原始请求体分块落盘,**真实 WebView 吞吐/内存待 M8 GUI 冒烟补测**(SSH 隧道无桌面会话);回退选项 A 只需换前端传输段。
- **`import::ImportStore`**:`stage_chunk`(同目录临时文件 + fsync + rename;单块 ≤ 8 MiB、单书 ≤ 200 MiB 超限即清暂存)→ `finalize`(分块 0..n 连续 → 拼装 → 校验:zip 魔数、条目 ≤ 5000、无 `..`/绝对路径、首条目 `mimetype`=`application/epub+zip`、存在 `META-INF/container.xml`,不解压正文 → 书行 `import_state='staged'`(TECH_DESIGN §4 已补)→ 原子 rename 到 `books/<id>.epub`;失败无书行且清暂存;落盘失败回滚书行;同 `op_id` 幂等)→ `cleanup_stale(24h)` 在 `initialize_state` 内执行。依赖 `zip 8`(无默认特性,只读目录与 stored 条目)。
- **command**:`library_import_epub_chunk`(`tauri::ipc::Request<'_>` 原始体 + `x-op-id`/`x-chunk-index` 头;JSON 体或缺头 → `invalid_request`)、`library_import_epub_finalize[opId,bookType,title]`、`library_epub_url[bookId]`(书行与文件都必须存在)、`map_block_source[blockId]`(exact 段文本优先,否则整章 spine 文本)。asset protocol:`tauri.conf.json` 开 `assetProtocol`(静态 scope 为空)+ `tauri` 特性 `protocol-asset`(首轮门禁即因缺此特性在 tauri-build 失败)+ setup 内 `asset_protocol_scope().allow_directory(books_dir, true)`(失败视为启动失败)。
- **前端**:`TauriBackend.importEpub` 按 4 MiB 分块 `invoke(cmd, Uint8Array, { headers })` 再 finalize(title 取文件名去 `.epub`);`epubUrl` 经可注入的 `convertFileSrc` 转 asset URL;`blockSource` 解码;`chunkBytes`/`convertFileSrc` 为构造选项供测试注入。契约四处同步:JSON 增 4 条命令(分块命令 `payloadKeys: []`),`unsupportedCapabilities` 仅剩 `completeTask`(有意保留)与 `stats`(M7);`contract.test.ts`/`tauri.test.ts`(v1 传输用例排除原生方法;新增分块上传/空文件/类型校验/asset URL/blockSource 用例)。
- **用例**:`import.rs` 单测(暂存→拼装→校验→落盘、幂等;损坏/缺 container/错 mimetype/mimetype 非首条目/遍历/绝对路径 → 无书行;条目超限/分块不连续/超大小/非法 op_id/空块;过期清理)。IPC 用例 `native_import_over_ipc_*`(两块分片、缺头/JSON 体拒绝、finalize 幂等、非法 bookType、受管路径/not_found、块原文 fallback→exact)。契约循环:分块命令走原始体特殊分支后 finalize 同一 op;`library_epub_url` 用预置文件的 second。
- **门禁**:src-tauri 全绿、clippy 0(两轮修正:`let mut first` 多余、测试闭包生命周期)、web 251/1 + lint + tsc + build。

## 2026-09-07 · M7.1:`stats_get` 接线
- **core `stats::compute(conn, date)`**(新模块):范围 = 主攻书(active)的块/薄弱点/任务,无主攻书时全库;`total/passed` 不含 `skipped` 块;`streak_days` = 连续有"已完成任务"的天数(今天已有完成含今天,否则从昨天起算,当天未结束不算断);`minutes_today` = 当日 done 任务 `est_minutes` 之和(番茄钟精确计时属 M2);`date` 由调用方提供,core 不读系统时间;非法日期 → InvalidInput。单测覆盖范围切换、连击断点、无主攻书全库。
- **壳层**:`StatsDto` + `application::stats` + `stats_get[date]`;契约四处同步,`unsupportedCapabilities` 仅剩 `completeTask`(有意保留)。TS `TauriBackend.stats()` 在内部取 `localCalendarDate()` 作 `date`(契约 `Backend.stats()` 无参签名不变);`decodeStats` 六项整数校验。用例:foundation 走一遍费曼闭环后 passed/streak/minutes/openWeakPoints 变化;契约循环 `stats_get {date}`;TS 用例改用 `completeTask` 作 unsupported 样例。
- **门禁**:core 129/27/1/1、src-tauri 4+19+1+2、web 252/1、clippy 0。

## 2026-09-07 · 推送 Mac 分支与 PR #6;M7.2 tray/有序退出;M8.0 受控测试日期
- **推送/PR**:用用户提供的窄权限 token 从 Linux 侧推送 `feat/mac-m1-wiring`(Mac 打 bundle → Linux fetch → push),建堆叠 [PR #6](https://github.com/aba122/book-learner/pull/6)(→ feat/m1-web-contract;含 M0–M7.1 共 8 个提交);token 用后即撤销(202 / 验证 401),本机无残留。合并顺序 #3 → #4 → #5 → #6。
- **M7.2 生命周期**:`tauri` 特性加 `tray-icon`;`bundle.icon` 指向 `icons/`(供 `default_window_icon`);托盘菜单"显示主窗口 / 退出攻书"(`install_tray`,失败只记 warn 不致命);关窗 = 隐藏(`CloseRequested → hide + prevent_close`);macOS `RunEvent::Reopen`(点 Dock 图标)重新显示主窗口;`RunEvent::ExitRequested`(Cmd+Q / 托盘退出 / `app.exit`)→ `orderly_shutdown(state, SHUTDOWN_GRACE=10s)`:等待 `JobRegistry` 在飞慢命令(导入 finalize / 地图作业 / 回合 / 评估各持 `JobGuard`)收尾,超时 warn 后强制退出。**限制**:强制退出路径不再等 codex 子进程;core 在每次调用返回/超时时按进程组终止,故残留窗口 ≤ 该调用自身超时。tray/Cmd+Q 的目检(`pgrep codex` 为空)待 GUI 会话。用例:`JobRegistry` 计数/`wait_idle` 超时与恢复、`orderly_shutdown` 空闲/占用;EngineMock 在 AI 调用期间观察到在飞 = 1、结束后 0。
- **M8.0**:`localCalendarDate()` 不传参时在 DEV 构建读 `localStorage['bookLearner.testDate']`(`YYYY-MM-DD`,非法值忽略),显式传参不受影响,生产构建(`import.meta.env.DEV=false`)忽略;用法:DevTools 里 `localStorage.setItem('bookLearner.testDate','2026-09-10')` 后刷新,今日页/地图页/费曼页与 `stats_get` 的"今天"随之推进。
- **M8.0 修正**:Mac 上 Node 26 的实验性全局 `localStorage` 未开 `--localstorage-file` 时为 `undefined`,且 vitest 的 jsdom 环境不覆盖已存在的全局 → 两条用例在 Mac 红、在 CI(Node 22)绿。模块与用例改读 `window.localStorage`(真实 WebView 中与全局相同)。**教训**:b978ce2 是在门禁链 `( vitest | grep; echo )` 吞掉退出码的情况下提交的——远程链一律 `set -o pipefail` 并显式检查 `pipestatus`;本机 Node(26)与 CI(22)不一致,建议 Mac 上装 node@22 或以 CI 为准。
- **M8.0 再修正(827aeb3 仍红)**:vitest 的 jsdom 环境下 `window` 即 `globalThis`,`window.localStorage` 同样落到 Node 26 的 undefined。最终做法:模块读 `globalThis.localStorage`(WebView 中即真实存储),用例用 `vi.stubGlobal(localStorage, 内存 Storage)` 注入并在 `afterEach` 还原,彻底不依赖环境;另补"无 storage 时静默"分支。827aeb3 同样是在 `echo` 之后读 `pipestatus`(已被重置)造成的假绿提交——远程链改为管道后立刻 `rc=${pipestatus[1]}` 再判断。本提交前 Mac 全量 web 门禁真实通过。

## 2026-09-07 · M8.2(无人值守部分)与 M8.3 文档回写
- **CI**:推送的 feat/mac-m1-wiring(19ae10a)[run 34181949033](https://github.com/aba122/book-learner/actions/runs/34181949033) core/web/mac-foundation 三任务首次全绿(mac-foundation 含 src-tauri 全量测试、clippy、`tauri build --debug`)。
- **M8.2 无人值守段(Mac 实测)**:真实 codex 冒烟(core `codex_real_smoke`,本机 codex-cli 0.153.0)10.25s 通过;`tauri build --no-bundle` release 1m02s 通过(14.3 MB);干净数据目录启动冒烟:release 二进制首启存活、无 ERROR(写入正式位置 `~/Library/Application Support/book-learner/`,因 `BOOK_LEARNER_DATA_DIR` 覆盖仅 debug 生效)与 debug 二进制隔离目录首启均生成 `app.db`/`books/`/`memory/`(git init 一次提交)、启动投影恢复 processed=0、按 pid 干净结束;核心/壳层/前端全量测试、clippy、fmt、lint、tsc、web build 均绿。Playwright、`tauri dev` 目检、真实 WebView 导入吞吐与 M8.1 七步端到端需桌面会话。
- **M8.3**:CLAUDE.md 状态区、IMPLEMENTATION_PLAN M1 验收注记、基线 Node 0/2/3/7/11/12 状态行已回写;PR 合并与 main 上 tag `m1` 待用户按 #3→#4→#5→#6 合并后执行。
- **本机未推送提交**(M7.2 起):需用户再提供 token 或在 Mac 上配置 GitHub 凭证后推送到 feat/mac-m1-wiring(PR #6 自动更新)。

## 2026-09-08 · 合并 PR #3→#4→#5→#6 至 main;端到端门禁模板
- 按用户指示以 merge 方式顺序合并:[#3](https://github.com/aba122/book-learner/pull/3) 4deb045 → [#4](https://github.com/aba122/book-learner/pull/4) 1ea2477(base 改指 main)→ [#5](https://github.com/aba122/book-learner/pull/5) 0cebe52(其 head 的 mac-foundation 为已知红,由 #6 修复,合并前 mergeable_state=unstable)→ [#6](https://github.com/aba122/book-learner/pull/6) 2ac4096(head 4234bc1 CI 三任务绿,[run 34183141170](https://github.com/aba122/book-learner/actions/runs/34183141170))。main = 2ac4096,Mac 与 Linux 克隆均已同步。
- token 策略变更(用户 2026-09-08):推送 token 保留到整个产品开发完成再撤销,存放于本机 `~/.ssh/codex-mac/github-token`(600),不进仓库;此前一枚 token 在该指示到达前已被上一条命令撤销,用户已重发。
- 新增 `docs/smoke/m1-e2e-gate.md`:M8.1 七步(导入并重启 → 地图/编辑/定稿/目标 → 阅读精确原文并暴露薄弱点 → codex 超时重试 → 评估/确认/投影 → Cmd+Q 一致性 → 推进受控日期重考)+ 日志泄漏检查 + 签字表;附 ADR-0004 真实 WebView 吞吐记录位。**执行需 Mac 桌面会话**;签字后在 main 打 `m1`。`mac-m1` tag 同样待 `docs/smoke/mac-m1-native-smoke.md` 签字。
- 下一步:M2 学习系统计划(`docs/superpowers/plans/2026-09-08-m2-learning-system.md`),core 已具备 review_schedule 1/3/7/14、on_review_result/on_weak_retest、check_behind 与 §6.4–6.8 prompt,M2 以接线与节奏(通知/番茄钟/重排确认)为主。

## 2026-09-08 · M2 T0:schema v5(追加式)
- `SCHEMA_V5`:`feynman_session.extra_kind`(CHECK 三值,NULL = 普通会话)+ partial unique index `feynman_session_extra_once(block_id, extra_kind)`;`study_minutes(date, book_id?, task_id?→SET NULL, minutes≥0, source∈{pomodoro}, created_at)` + `(date)` 索引。**不重建任何表**(评审指出:`session_turn` 对 `feynman_session` 级联删除,重建会清空回合)。
- 用例:`open_creates_schema_v5`(列/表/五个索引、extra_kind CHECK 与每块每类一次、负分钟拒绝)、`v4_rows_survive_v5_without_rebuilding_sessions`(v4 库含会话与 2 条回合 → v5 后回合不丢、索引不丢、`extra_kind` 为 NULL、二次打开幂等);既有版本断言 4→5。core 131/27/1/1、clippy 0。TECH_DESIGN §4 补 v5。

## 2026-09-08 · M2 T1:间隔复习与薄弱点重考的"快问"会话
- **core**:`prompts::review_quiz_system(ty, ctx, kind)`——只负责出题与一次追问,不含 JSON 子句(旧 `review_quiz_prompt` 保留未用);`session::submit_turn` 按会话 kind 选 system prompt(learn → 费曼学生;review/retest → 复习考官),快问会话学生回合达 `MAX_QUIZ_STUDENT_TURNS`(6)仍未收尾则强制附加 `[READY_TO_END]`;`sched::insert_new_weak_points`(评估中未修复薄弱点落库,同块同标题 open 者去重)与 `on_review_result_with(has_specific)`(评估已有薄弱点时不再插通用"间隔复习未通过");`confirm_session_verdict` 的 review/retest 分支调用之。开场协议:**core 回合协议不变**(用户先开口),前端以固定 `clientTurnId='opener'` 自动提交。m1_engine 扩展第 10–11 步:复习会话用快问 prompt、用户判定未通过 → stage 重置 1、评估薄弱点去重且无通用条目;重考会话 prompt 针对薄弱点、连续两日通过 → `fixed`。
- **web**:TodayPage 重考/复习卡"开始重考/开始复习"直达 `/feynman/<taskId>`,review 卡"回读原文"进阅读器;FeynmanPage 对 review/retest 空会话把开场提示行作为初始对话流并 effect 发送一次(oxlint `set-state-in-effect` 规则下不在 effect 里 setState),opener 回合渲染为居中提示条,标题"复习:"+ 提示文案(`config.ts` 的 `OPENER_TEXT`/`SESSION_HINT`/`OPENER_TURN_ID`);Mock 对 opener 返回快问文案。用例:today 三条导航、feynman 三条(复习 opener/提示、重考 opener 与重挂载不重复、新块不开场)。**范围决定**:`completeTask` 的"完成"按钮流暂保留(原生显示"完成暂不可用"),清理留 T9。
- 门禁:core 全绿(m1_engine 扩展)、web 259/2、lint 0、tsc。

## 2026-09-08 · M2 T4:落后重排确认
- **core**:`sched::ReplanReport{status, remaining_blocks, remaining_days, deadline, daily_cap}` 与 `check_behind_report`(`check_behind` 改为其薄包装);无主攻计划或未落后 → `OnTrack`(不再报错);非法日期 → InvalidInput;`planning::get_plan(conn, book_id) -> Option<StudyPlan>`。单测覆盖数值、截止已过按 1 天、无计划。
- **壳层**:`ReplanDto`(status `on_track|auto_adjusted|needs_decision`,可选 `newDaily`/`requiredDaily`)、`StudyPlanDto`;`planning_check_behind[bookId,date]`、`planning_get_plan[bookId]`;六处契约同步;foundation 用例覆盖 on_track 数字、连续两天未完成 + 上限 1 → needs_decision、放宽上限 → auto_adjusted 并写回计划、无计划书 on_track。
- **web**:TodayPage 管线改为 `listBooks → checkBehind(主攻书) → todayQueue → listBlocks`(落后检测有副作用须先于当日队列生成);`auto_adjusted` 显示提示条;`needs_decision` 弹 `ReplanDialog`:顺延 = `getPlan` 为底只改截止日(今天 + ceil(剩余/上限) − 1 天),缩减 = `confirmMap` 对 seq 最靠后的 (剩余 − 上限×天数) 个未学块 `setSkipped`,"本日不再提醒"只写偏好(`lib/prefs.ts`,localStorage 不可用时静默)。新增 `addCalendarDays`;Mock 的 `checkBehind`/`getPlan` 镜像 core 数字(Mock 数据永不落后)。两条"晚到的旧队列"竞态用例改挂在管线首步 `listBooks`(旧一轮在首步后即判过期)。
- 门禁:core 与 web(259/2、lint 0、tsc)在 Linux 绿;src-tauri 由 CI macos 任务验证(隧道此时已断开)。

## 2026-09-08 · M2 T8:单主攻书补完
- **core**:`library::finish_book`(status→finished、计划 active=0;若为主攻则全局无主攻直至另选;幂等;不存在 NotFound);`set_active_book` 对已学完的书返回 Conflict("复习照常,不能再主攻");回归用例证明 `generate_daily` 的到期复习/薄弱点重考不按主攻书过滤(暂停/已学完的书照常入队),新块只来自主攻计划。
- **壳层/契约**:`library_finish_book[bookId]`,六处同步;foundation 用例:标记学完后无主攻、再激活 conflict、次日不产新块。
- **web**:书架卡片改为"封面按钮 + 说明行"(已暂停:计划冻结 · 复习照常;已学完:复习照常 · 不再主攻),"标记为已学完"经确认调用 `finishBook`;已学完的书点击直接看地图不弹切换;切换确认文案含"计划冻结、复习照常";Mock 同语义。
- 门禁:core/web 在 Linux 绿;src-tauri 由 CI macos 任务验证。

## 2026-09-08 · M2 T2:提醒判定与系统通知
- **core**:`AppSettings` 增 `evening_remind_time`(默认 22:00,`shared/app-defaults.json`;HH:mm 校验抽为 `validate_time`;`setting` 表第 5 个键 `eveningRemindTime`),`setting` 表为唯一权威,`study_plan` 的两列废弃(TECH_DESIGN §4 已注)。新模块 `notify`:`decide(now_hm, settings, pending_today, sent)`——到达 `remind_time`(容忍迟到 2 分钟)且当日未发 → Daily(无条件,PRODUCT_SPEC §6);到达 `evening_remind_time` 且 `pending_today > 0` 且未发 → Evening;`sent_marks/mark_sent` 以 `notified:<kind>:<date>` 键幂等、按日隔离。单测覆盖窗口边界、每日一次、晚间需 pending、跨日重置、非法时间。
- **壳层**:`tauri-plugin-notification` + capability `notification:default`;`notify::spawn_reminder_thread`:持一条长连接,30s 轮询,`chrono::Local` 取日期/时刻(与前端本地日历日一致;DEV 受控日期不影响提醒),只在晚间窗口内触碰当日队列(幂等生成)取 pending 数,发通知后记标记;启动时请求通知权限并记日志。`AppSettingsDto` 增字段;foundation 夹具同步。**macOS 通知需以 bundle 运行**,目检项在 `docs/smoke/m2-gate.md` §1。
- **web**:`AppSettings.eveningRemindTime`,解码/校验,设置页"晚间提醒(当日未完成时)"字段(不用 `hint`——它渲染为 `role=alert` 会撞现有断言);夹具补字段(tauri.test 的计划对象不含该字段)。
- 门禁:core 136/27/1/1、web 265/2、lint 0、tsc;src-tauri 与通知插件编译由 CI 验证。

## 2026-09-08 · T8 补完(过程失误记录)与 M2 T3:Rust 番茄钟 + 托盘倒计时
- **过程失误**:PR #12(T8)实际只包含 core/application/文档——当时 `git stash pop` 冲突后整条 `&&` 链静默中止,壳层命令、六处契约、Mock/解码器、书架 UI 与用例都没执行;我看到 web 用例数没有增加却没有追查。CI 因为没有任何引用而通过。本 PR 第一笔提交补齐 T8 的全部遗漏(`library_finish_book` 命令与契约、Mock `finishBook`/已学完不可再主攻、书架徽标与"标记为已学完"确认、foundation/tauri/library 用例)。**规则更新**:改动脚本单独执行、不挂在 `&&` 链尾;每个 Task 的用例数变化必须核对。
- **T3 core**:`pomodoro::Machine` 纯状态机(Idle/Work/Break/Paused,时间由调用方以 unix 秒传入):`start`(仅空闲;分钟 1..=180)→ `tick` 到点 Work→Break(`WorkDone{minutes}`)、Break→Idle(`BreakDone`);`pause/resume` 保留剩余秒与已专注秒;`stop` 专注阶段按整分钟计(不足 1 分钟不落库)、休息阶段不再计;`Snapshot{phase, taskId, date, endsAt, remainingSecs, pausedPhase}`;`record_minutes` 落 `study_minutes`。`stats::compute.minutes_today = max(预估完成分钟, 番茄分钟)`(TECH_DESIGN §4 规则),按主攻书范围。
- **T3 壳层**:`AppState.pomodoro: Mutex<Machine>`;`pomodoro.rs`:命令层 `start/pause/resume/stop/snapshot`(锁内只改状态,落分钟在锁外;`date` 来自前端),ticker 线程每 1s `tick(now)`:阶段变化 → 落分钟、发事件 `pomodoro_changed{snapshot}`、系统通知;托盘标题 `●MM:SS`/`○MM:SS`/`‖MM:SS`(仅在文本变化时写,无托盘时静默);`orderly_shutdown` 前 `stop_for_shutdown` 落分钟。五条命令 `pomodoro_start[taskId,date]/pause/resume/stop/state`,六处契约同步(事件名只作常量,`ARCHITECTURE.md` 已注)。
- **T3 web**:`Backend` 增五个方法 + `subscribePomodoro`;Mock 用 `setTimeout` 镜像阶段切换并广播;`Pomodoro.tsx` 只按快照渲染(`endsAt − Date.now()` 每秒重绘,暂停/继续/结束经 `useBackendOperation`,订阅推送);TodayPage 挂载取 `pomodoroState`,"专注"经 `pomodoroStart(taskId, today)`;用例改为经后端启动/暂停/继续/结束。
- 门禁:core 139/27/1/1、web 269/2、lint 0、tsc;src-tauri 由 CI 验证。

## 2026-09-08 · M2 T6:学习者画像编辑
- **core**:`memory::PROFILE_HEADINGS` 与 `ProfileSections{background, mastered, pitfalls, context}`;`profile_sections()` 读四节,`write_profile_sections()` 原子重写(标题行固定、空节写"(待补充)"、未知小节按原顺序保留在末尾),**不直接 git commit**;`profile_summary_for(ty)`:教材/方法论追加"个人情境"节(模板占位文案不算内容),人文只前两节。单测覆盖往返、未知节保留、按类型摘要。
- **壳层**:`ProfileDto`(deny_unknown_fields);`application::profile_get/profile_save`——保存后入队 outbox `git_commit{message:"profile: 更新学习者画像"}`(`op_id=profile:<毫秒>`),命令层 `profile_save` 在返回前 `spawn_blocking` 走 `run_startup_recovery` 同款后台重放;`session_context` 改为先取书类型再取 `profile_summary_for(ty)`。命令 `profile_get[]`、`profile_save[profile]`,六处契约同步;foundation 用例:模板默认值 → 保存 → 读回一致、outbox 出现 1 条 pending、重放后记忆库 git log 含该提交、多余字段拒绝。
- **web**:`Profile` 类型与 `profileGet/profileSave`;Mock 内存实现;`TauriBackend` 解码/出站校验;设置页新增"学习者画像"卡:知识背景/个人情境文本域、已掌握概念/误区模式只读 `<pre>`,独立"保存画像"按钮(`useBackendOperation`,与设置表单互不影响),读取失败只影响本卡且可重试。用例 4 条(展示、只提交画像不触发 saveSettings、保存失败重试、读取失败不影响设置表单)。
- 门禁:core 140/27/1/1、web 274/2、lint 0、rustfmt;src-tauri 由 CI 验证(Linux 无 GTK)。**首推 CI 红**:`ProfileSection` 用了不存在的 `resource.version`,而本地 `tsc --noEmit -p tsconfig.json` 对 solution 式 tsconfig(只有 references)什么都不检查,故未发现。**规则更新**:web 类型门禁一律用 `pnpm -C web build`(`tsc -b && vite build`),不再用 `tsc --noEmit -p tsconfig.json`。`cargo test` 在 Linux 会给 `web/src-tauri/Cargo.lock` 追加 Linux 平台依赖,已回退不提交。

## 2026-09-08 · M2 T5:三类书通过后附加环节
- **core**:新模块 `extra`——`ExtraKind{Application, Methodology, Discussion}`(书类型映射、`artifact.kind` 映射 application/methodology/reflection、归档文件 `_applications.md/_methodology.md/_notes.md`、学生回合上限含开场:方法论 4、其余 3);`extra::start(conn, block_id, kind, client_request_id)`:仅当块 status ∈ {passed, consolidated} **且**存在已确认的 learn 会话(两者都查,防数据不一致),写 `feynman_session(kind='learn', extra_kind, task_id NULL)`,client id 幂等、同块同类返回既有会话;`extra::finish(...)`:三段式(短事务 A 校验并 open→evaluating → 无事务调 AI 整理 prompt(纯 markdown,剥最外层代码围栏)→ 短事务 B 写 `artifact` + 会话 confirmed/`verdict_request_id`/`ended_at`、不写 `eval_json`,入队 `extra_archive{artifact_id, entry_key}` 与 `git_commit`;失败回退 open;同 request id 重放返回同一产出且不再调 AI)。`session::submit_turn` 按 `extra_kind` 选 `prompts::extra_system`,回合上限统一为 `turn_cap`(快问 6 / 附加环节按种类);`verdict::request_evaluation` 拒绝附加环节会话;`SessionView.extra_kind`;`prompts::extra_system/extra_summary_prompt` 替换三个"prompt only"构造器(TECH_DESIGN §6.4 已注实现说明);`memory::append_archive`(文件不存在建头、entry_key 注释标记幂等、原子写);`projection` 新增 `extra_archive` 处理器。单测 5 条(映射/围栏、start 前置条件与幂等、回合 prompt 与上限强制收尾、finish 全链路含投影重放幂等、失败回退)。
- **壳层/契约**:`SessionViewDto.extra_kind`、`ExtraOutcomeDto{kind, artifactId, version, contentMd}`(比计划多 `contentMd`,免前端再查 artifact);`extra_start[blockId, kind, clientRequestId]`、`extra_finish[sessionId, expectedVersion, requestId]`(结束后 `spawn_blocking` 走 `run_startup_recovery` 同款重放);六处同步;foundation 用例:未通过块 conflict、非法 kind invalid_request、讲授闭环后开始(幂等)→ 开场 + 作答 → 结束 → 重放不再调 AI → 投影后 `_applications.md` 有内容且 git log 含归档提交 → 评估接口拒绝;wire 用例在契约循环里为 `extra_finish` 现场补两回合。
- **web**:`ExtraKind`/`SessionView.extraKind`/`ExtraOutcome`;`extraStart/extraFinish`(Mock:块须 passed、同块同类一次、按种类脚本回复、结束返回整理稿;解码器校验枚举);`config` 的 `EXTRA_KIND_FOR_BOOK` 与 `EXTRA_STAGE`(标题/说明/opener/归档文件);回合渲染抽为 `Transcript.tsx`(`TranscriptLines`/`StudentAvatar`)供讲授页与附加环节共用;`ExtraStage`:新块判定"通过"后替代评估卡出现(其余判定直接回今日)——按书类型标题与说明、开始/跳过;开始后 `extraStart` → 固定 opener 自动开场(提示行在事件里入流,effect 只发送,避开 `set-state-in-effect`)→ 作答 → "整理并归档"(≥1 次作答可用,收尾后主强调)→ 展示整理稿与 `books/<slug>/<file>` 归档路径 → 返回今日;已结束会话重进直接以常量 request id 重放整理稿。用例:三类分支、跳过不调 extraStart、不通过不给、全流程参数与归档文案、extraStart 失败重试沿用同一 id;原"确认通过回今日"两条改为先出附加环节。
- 门禁:core 145/27/1/1、web 282/2、lint 0、`pnpm build`、rustfmt、clippy 0;src-tauri 在 Mac 原生 `cargo test` + CI 验证。

## 2026-09-08 · M2 T7:统计页三区
- **core**:`stats::detail(conn, date) -> StatsDetail`——进度区 `books[]`(全部书,主攻在前;total/passed/consolidated、`study_plan.deadline`、`projected_finish` = 今天 + ceil(剩余 × 7 / 近 7 天通过数),无通过或已学完为 None);投入区 `days[14]`(不分书;minutes 同 `compute` 口径 max(预估, 番茄),pomodoros 为 `study_minutes` 段数)与 `streak_calendar[56]`(当天有 done 任务即 active);质量区(主攻书范围)`weak_trend[14]`(按 `created_at`/`fixed_at` 前 10 位取日)、`avg_scores`(最近 10 次 `eval_json` 均分,None 表示无评估)、`review_pass_rate`(近 30 天 `daily_task.kind='review' AND status='done'` 经 `ref_id` 关联 `review_schedule.status` 的 done/(done+failed),None 表示无复习)。两条单测:全量数字与空库安全。stable Rust 无 `div_ceil`,用整数算式。
- **壳层/契约**:`StatsDetailDto` 及 5 个子 DTO(camelCase、可空字段 null);`stats_detail[date]`;六处同步;foundation 用例校验三区长度、camelCase、可空字段与非法日期 invalid_request。
- **web**:`StatsDetail` 类型族;`statsDetail()`(日期同 `stats()` 由前端本地日历日给);解码器新增 `finiteNumberAt`/`nullableAt`;Mock 进度按书/块推导、投入与质量为确定性样例;`StatsPage` 汇总卡下新增独立加载的三区(`StatsDetailSections`):进度(按书条形 + 通过/巩固/截止/预计完成)、投入(14 天柱状图纯 div、56 格打卡日历 `grid-rows-7`)、质量(薄弱点新增/修复双柱、评估均分三条、复习通过率 `ProgressRing`);空数据每区给说明文案;详情失败只影响三区且可重试。用例 3 条 + tauri 解码 1 条。
- 门禁:core 147/27/1/1、web 288/2、lint 0、`pnpm build`、rustfmt、clippy 0;src-tauri 由 Mac 原生 `cargo test` 与 CI 验证。

## 2026-09-08 · M2 T9:门禁与回写(无人值守段)
- **全量门禁(Mac 原生,经隧道无人值守)**:结果表已填入 `docs/smoke/m2-gate.md` §9——core 146/1 失败(见下)+ 27/1/1、clippy 0、fmt;src-tauri foundation 26、clippy 0、fmt;web 287/1 跳过、lint 0、`pnpm build`;`tauri build --debug --bundles app`(41 MB)与 release(15.4 MB)通过;debug bundle 干净目录首启:`app.db` v5 含 M2 新表/索引、记忆库 git 初始化、无 ERROR、通知权限 Granted、投影恢复 0、按 pid 干净退出。
- **唯一失败**:`ai::tests::timeout_kills_descendants` 再次在并行负载下抖动——不是"没杀干净",而是 bash 晚于 3s 超时才启动,超时把还没起来的脚本连带杀掉,marker 缺失。改为逐级放大超时(3s → 6s → 12s)重试直到 marker 出现再断言"孙进程已被进程组终止";断言语义不变。Linux 单跑通过。
- **回写**:`docs/smoke/m2-gate.md` 补齐 T3(番茄钟/托盘 5 项)、T5(附加环节 5 项)、T6(画像 2 项)、T7(统计 1 项)目检项;IMPLEMENTATION_PLAN M2 节加实施状态(2.1–2.5 代码全入 main;2.3 的"个人情境 AI 提取与确认流"未做,留 M3);CLAUDE.md 状态区;TECH_DESIGN §10 实现说明(notify::decide、30s 轮询线程、番茄钟状态机/托盘/事件)。
- **待桌面会话**:`docs/smoke/m2-gate.md` §1–§8 目检并签字 → main 打 `m2`;`mac-m1`/`m1` 两个 tag 同样待相应冒烟签字。

## 2026-09-08 · 桌面门禁改经 SSH 执行:调试自动化桥 + mac-m1 签字
- **背景**:三份桌面门禁(mac-m1 / m1-e2e / m2)原定需用户桌面会话;用户要求经隧道由我完成,并选择"两条路都开":①给 SSH 进程授 macOS 辅助功能(已生效)与屏幕录制(待授);②允许 debug-only 自动化桥。
- **自动化桥**(`web/src-tauri/src/automation.rs`):仅 debug 构建、且设置 `BOOK_LEARNER_AUTOMATION_SOCK` 时监听 unix socket;一行 JSON 请求 → `{"js"}` 在主 WebView `eval` 并经 `automation_report` 命令回传结果、`{"tray_title"}` 读番茄钟 ticker 记录的托盘标题、`{"quit"}` 走 `app.exit(0)`(= Cmd+Q 的 `ExitRequested` 路径)。**不进 IPC 契约**(`WIRE_COMMANDS`/JSON 不含它),release 构建 `maybe_spawn` 为 no-op、`automation_report` 恒返回 invalid_request。驱动器 `docs/smoke/scripts/bl-auto.py`(text/click/type/file/wait/go/tray/quit)。
- **mac-m1 门禁**:脚本 `docs/smoke/scripts/gate-mac-m1.sh` 在 Mac 上无人值守跑通 §1–§3(seed → 首启检查 → 退出 → 同 fixture 重启 → 设置 37 保留),文档已回填并签字;§4 浏览器 Mock 对照与生产路径引用既有用例与 M8.2 实测。tag `mac-m1` 待本 PR 合并后打在 main。
- **过程失误**:把脚本命名为与 `bl-run.sh` 会话同名的 `bridge-build.sh`,被其包装脚本覆盖成自调用 → 递归 fork 至 "fork failed: resource temporarily unavailable";进程自行回退、确认无残留后改名 `*-cmd.sh` 重跑。规则:传给 bl-run 的脚本一律 `<name>-cmd.sh`。

## 2026-09-08 · m1-e2e 门禁(真书 + 真 codex)经 SSH 执行并签字
- **执行**:`docs/smoke/scripts/gate-m1-e2e.sh`(七步主跑,41 分钟)+ `gate-m1-step4.sh`(第 4 步补跑 ×2)+ `gate-m1-day2.sh`(第 7 步第 2 天),`tauri dev` + 调试自动化桥 + 真实 codex-cli 0.153.0;书为 Gutenberg #7337《道德經》(公版,按"教材"模板,记为偏差)。观察值全部来自页面文本、日志、SQLite 与记忆库文件,已回填 `docs/smoke/m1-e2e-gate.md` 并签字。
- **数据**:导入 + 地图 148 s(Stage A 9 s + 87 s,merge 49 s;10 块);首轮讲授 codex 往返 10 s;评估 35 s;超时路径 3×120 s + 退避 = 362 s;`projection_outbox` 全 done;日志无原文/复述泄漏。
- **修复的缺陷(门禁发现)**:①`tauri dev`(React StrictMode)下快问 opener 永远"学生思考中"——`useBackendOperation` 卸载清理清空 generations,模拟重挂载后在飞 opener 被判过期(PR #21,加 StrictMode 回归用例);②codex 超时映射为不可重试的 `internal`,页面无"重试"入口(PR #22:`Ai/EvalParse → ai_unavailable` retryable)。
- **产品发现(列入 M3 T6 收尾)**:①导入书名取文件名而非 EPUB `dc:title`;②重考评估会新增措辞略异的重复薄弱点(现有去重只按标题精确匹配,建议同块内按归一化标题/相似度去重或重考不新增);③单章 HTML 的书所有块都是 `chapter_fallback`,费曼 prompt 注入整章原文(26 KB),可考虑按块小节切片。
- **脚本教训**:发送前必须等学生回复渐显结束(`▍` 消失),否则前端按设计忽略发送;`a click` 对多个同名按钮取 DOM 首个,对话框内按钮要限定在 `[aria-label]` 容器内;macOS `pgrep` 无 `-c`。

## 2026-09-08 · m2 门禁经 SSH 执行并签字
- **bundle 段**(`gate-m2-bundle.sh`,debug bundle):提醒 15:10 / 晚间 15:12 各发一次(日志"已发送系统通知",`setting` 标记 daily/evening 各一行,60 s 后无重复);System Events 点关闭按钮 → 窗口 0、进程常驻;番茄钟 1 分钟:托盘 `●00:58…` 每秒递减,暂停 `‖00:54` 停住,继续恢复,隐藏后仍走,到点 `○01:00` 休息、结束回空闲,`study_minutes` 3 行各 1 分钟(自动/手动结束/运行中退出"退出前番茄钟已结束并落分钟"),统计"今日投入 3"。Reopen:`open -a` 后窗口 1、页面 visible。
- **dev 段**(`gate-m2-dev.sh` + 补跑,`tauri dev` + 真 codex):三类书各导入一本(《老子》教材 / 《孫子兵法》方法论 / 《戲中戲》人文,Gutenberg 公版)各学 1 块;附加环节三条全链路(迁移应用题引用画像"5 人平台定价团队";情境化方法论三轮引导 → 我的版本;观点讨论对立视角 → 看法),artifact + `_applications.md/_methodology.md/_notes.md` + git 归档提交;画像保存经 outbox commit;标记已学完后所有计划 active=0、暂停/已学完书的复习次日照常入队;快问会话 opener 自动出题、复习 1 → 3 推进;落后重排:截止已过 + 剩余 8 块 > 上限 4 → "进度落后,需要你决定"(顺延到 +1 天 / 缩减跳过 4 块),缩减分支跳过 4 块截止不变;统计三区数字与 SQLite 一致。
- **过程发现**:①dev 段首跑在"确认定稿"失败——该按钮只在编辑态出现,脚本先点"编辑地图";②切换主攻书当天今日队列仍是旧书任务(对话框已说明"今日队列明天起按新书生成",按设计),脚本改为推进日期后再教新书的块;③§4 误把当时主攻的人文书标为已学完(书架首个"标记为已学完"按钮属于主攻卡),后续用复制文件名重新导入人文书;④**窗口在后台时 WebView 被 macOS 节流**:codex 20 s 内完成的回合,前端 5 分钟后才收到 IPC 回调(`ai_request` 与页面状态对比),把窗口置前(System Events `set frontmost`)后回合 9–24 s 即显示——门禁脚本已加 `front()`,写入 CLAUDE.md 约定;⑤`useBackendOperation` 在 StrictMode 下的 opener 问题与 AI 超时不可重试均已在 m1-e2e 修复(PR #21/#22)。
- **签字**:`docs/smoke/m2-gate.md` §1–§8 全部勾选;tag `m2` 待本 PR 合并后打。
## 2026-09-08 · M3 T1:整书终评与学习报告
- **core**:schema v6(加列 `feynman_session.book_id`、partial unique `feynman_session_final_once(book_id) WHERE kind='final_exam' AND state<>'abandoned'`;v5→v6 用例证明回合不丢、放弃后可重开);新模块 `final_exam`:`eligible`(未跳过块 ≥1 且全通过,不看书状态)、`start`(client id 幂等、每书一次、占位块 = seq 最小未跳过块)、`map_summary`(地图表 + 薄弱点)、`finish`(三段式:≥2 次作答 → 报告 prompt → `artifact(report)` + confirmed + `finish_book_in` + outbox `report_archive/sync_map/git_commit`;失败回退 open;同 id 重放);`parse_report` 解析首行元注释并剥围栏;`session::submit_turn` 对 `final_exam` 自查上下文(`book_id` → 地图摘要;学生回合数 → 阶段)、回合上限 8;`verdict::request_evaluation` 拒绝终评会话;`library::finish_book_in(tx)`(评审 #1);`orchestrate::run_ai_parsed(correction_hint)`(评审 #5);`projection` 新增 `report_archive`。单测 6 条 + db 1 条。
- **壳层/契约**:`SessionViewDto.book_id`、`FinalReportDto`;`final_exam_eligible[bookId]`、`final_exam_start[bookId, clientRequestId]`、`final_exam_finish[sessionId, expectedVersion, requestId]`(结束后后台重放);`session_context` 对终评会话不算占位块原文(评审 #3);六处同步;foundation 用例覆盖前置条件、幂等、评估拒绝、报告/书状态/`_report.md`/git log,wire 用例现场补三回合。
- **web**:`SessionView.bookId`、`FinalReport`、`finalExamEligible/Start/Finish`(解码校验 overall 1..5);Mock 两阶段脚本与报告样例;`config` 增 `OPENER_TEXT.final_exam`、`FINAL_EXAM_REQUEST_ID`;新页 `FinalExamPage`(`/final/:bookId`:opener 自动开场 → 作答 ≥2 次可"生成学习报告" → 报告页(星级/最强最弱/正文/归档路径)→ 返回书架;已结束会话重进以常量 id 重放报告);地图页在全部块通过时显示"整书终评"入口。用例 5 条 + tauri 解码 1 条。
- 门禁:core 154/27/1/1、clippy 0、fmt;web 294/2、lint 0、`pnpm build`;src-tauri 在 Mac 原生 `cargo test`(foundation 27)通过。**过程失误**:一次 `open(p,'w').write(open(p).read())` 把 `MapPage.tsx` 截成空文件(先截断后读),从 git 恢复后重做——改文件一律先读后写。

## 2026-09-08 · M3 T2:Obsidian 导出
- **core**:新模块 `export`——`safe_name`、`plan(conn, book_id, target)`(只读 SQLite:块 + 评估历史 + 薄弱点演变 + artifact 分组;frontmatter;wikilink 以目标目录为根;跳过块不导出;`00-学习报告.md` 始终生成、`01-我的方法论.md` 仅方法论书/有产出时)、`write(plan)`(目标目录须已存在;临时文件 + fsync + rename;内容相同不写;不删其它文件)。单测 4 条,含"所有 wikilink 目标都在清单内"与增量写入。
- **壳层/契约**:`ExportPreviewDto{target, targetExists, dir, files}`、`ExportReportDto{dir, written, unchanged}`;`application::expand_home` 是 `~` 的唯一展开点,目标须为绝对路径;`export_preview/export_obsidian/export_reveal[bookId]`(reveal 用 `open` 打开由设置 + 书名推导的目录,不接受任意路径);六处同步;foundation 用例覆盖默认目标、临时 vault 写入/增量、NotFound、`~` 展开;wire 用例现场把设置指到临时 vault 并先导出再 reveal。
- **web**:`ExportPreview/ExportReport` 类型、`exportPreview/exportObsidian/exportReveal`、解码器与用例;Mock 按书/块推导清单并镜像"首次全写、再次全不变";书架卡新增"导出到 Obsidian"→ `ExportDialog`(清单预览 → 确认导出 → 写入/未变计数 → 在 Finder 中显示;目标目录不存在时提示去设置页并禁用导出;失败可重试)。用例 2 条。
- 门禁:core 159/27/1/1、clippy 0、fmt;web 297/2、lint 0、build;src-tauri 由 Mac 原生 `cargo test` + CI 验证。

## 2026-09-08 · M3 T5:数据安全(快照/恢复/git 远程)
- **core**:新模块 `backup`——`snapshot`(`VACUUM INTO` → `.tmp` + fsync + rename,同日覆盖)、`prune`(最近 7 份 + 近 3 个月各最早一份,只删本模块命名的文件)、`list`、`restore_plan`(文件名白名单 `app-YYYY-MM-DD.db`、`integrity_check`、`user_version ≤ SCHEMA_VERSION`)、`request_restore/pending_restore/cancel_restore`(标记文件)、`apply_pending_restore`(启动前替换库,移走热日志,原库 `.replaced-<ts>`,标记无论成败消费);`db::SCHEMA_VERSION = 7`,v7 加列 `projection_outbox.lane/next_retry_at`;`memory::{remote_url, set_remote, push}` + 带超时/无 TTY 提示的 `git_timeout`(复用 `ai::wait_with_timeout` 进程组兜底);`projection::{enqueue_in, run_push_lane}`,`run_pending` 只处理 main 通道且 `git_commit` 成功后有远程即补 push 行。单测 5 条(快照/覆盖/保留策略/恢复标记与热日志/push 通道用本地 bare 仓库验证成功、退避与 main 不受影响)。
- **壳层/契约**:`SnapshotDto/BackupListDto/GitRemoteDto/PushResultDto`;`initialize_state` 在打开库前应用待恢复标记并对所有书入队镜像再生,之后"每日首次启动快照";`orderly_shutdown` 退出前刷新当日快照;`run_startup_recovery` 顺带跑 push 通道;命令 `backup_snapshot_now[date]/backup_list/backup_restore[name]/backup_cancel_restore/git_remote_get/git_remote_set[url]/git_push_now`(手动推送清退避);六处同步;foundation 用例覆盖快照 → 登记 → 重启后库被替换与 `.replaced` 保留 → 镜像再生入队 → 远程校验/拒绝非法 URL → 提交后自动推送到 bare 仓库 → 立即推送。
- **web**:类型与 `backupSnapshotNow/backupList/backupRestore/backupCancelRestore/gitRemoteGet/gitRemoteSet/gitPushNow`,解码器与用例;Mock 内存实现;设置页"数据"分区替代原禁用占位:快照清单/立即快照/恢复登记(确认对话框)与取消/远程 URL 保存并校验/立即推送结果。用例 2 条。
- 门禁:core 163/27/1/1、clippy 0、fmt;web 300/2、lint 0、build;src-tauri 由 Mac 原生 `cargo test` + CI 验证(首跑因用例数据目录布局与 `initialize_state` 不一致失败,已改用 `<dir>/book-learner/app.db`)。

## 2026-09-08 · M3 T4:阅读器打磨(标记/排版/位置)
- **core**:schema v8 `reader_mark`(随书级联);`reader_marks::{add, update, remove, list, set_position, get}`——highlight 需区间 CFI 与四色之一(默认 yellow)、bookmark 同书同点幂等、position 每书一行 upsert,CFI 必须以 `epubcfi(` 开头,文本/批注限长。单测 2 条。
- **壳层/契约**:`ReaderMarkDto`/`NewReaderMarkDto`(deny_unknown_fields);`reader_mark_list[bookId]/reader_mark_add[bookId, mark]/reader_mark_update[id, note, color]/reader_mark_remove[id]/reader_position_set[bookId, spineHref, cfi]`;六处同步;foundation 用例。
- **web**:`EpubView` 扩展——`typography` 属性(行高/缩进/覆盖出版方样式,三套主题按开关注入规则并在变化时重注册)、`highlights` 同步(增删注解)、`blockSegments`(该章 `rendered` 后两点 CFI 组合区间加下划线)、`onSelected`(区间 CFI + 选中文本 + 章节)、`onRelocated`、`currentLocation()`;非组件导出移到 `readerThemes.ts`(oxlint only-export-components)。`ReaderPage`:偏好持久化(`bookLearner.readerPrefs`)、顶栏"书签/标记"、选区工具条四色高亮、`MarksPanel`(书签/高亮跳转与删除)、阅读位置节流写回并作为非学习模式起始位置、学习模式起始位置为首段锚点、设置浮层新增行高/缩进/覆盖开关、版心 38em 容器。Mock/解码器/用例;reader 用例 +5。
- **范围决定**:霞鹜文楷 woff2 不内置(10 MB,待 dmg 体积评估);手动锚点校正 UI(选区设为块起点/终点)未做,记入 M3 T6 或 M4。
- **过程失误(再次)**:`open(p,'w').write(open(p).read())` 又把 `ReaderPage.tsx` 截空一次,从 git 恢复重做;**改文件的脚本里禁止这种写法**,已在记忆文件记规则。
- 门禁:core 165/27/1/1、clippy 0、fmt;web 307/2、lint 0、build;src-tauri 由 Mac 原生 `cargo test` + CI 验证。

## 2026-09-08 · M3 T3:whisper 本机语音输入
- **T3.0 spike(Mac)**:`brew install cmake`;`web/src-tauri/Info.plist` 加 `NSMicrophoneUsageDescription`(tauri-build 嵌入 bundle);WKWebView `getUserMedia` **可用**,但有一个前提——从 SSH 会话直接执行 `book-learner.app/Contents/MacOS/book-learner` 时 TCC 无法弹框,`getUserMedia` 立即 `NotAllowedError`;改为 `open -a <app> --env …`(经 LaunchServices 进 GUI 会话)后系统弹授权框、拿到「MacBook Pro麦克风」48 kHz 流。无需 cpal 回退。模型经终端 curl 下载到 `~/Developer/bl-smoke/models/`(app 不带 HTTP 客户端,应用内下载不做)。
- **壳层**:`voice.rs`(Cargo feature `voice` 默认开启,`whisper-rs = 0.16`):模型目录 `<data_root>/models/`,`KNOWN_MODELS` 三款 + 目录内其它 `ggml-*.bin`;`import`(文件名/体积 ≥ 20 MiB 校验,复制为 `.tmp` 再 rename,首个导入自动选中)、`set_selected`(只接受已导入)、`delete`(名称白名单,只删该目录)、`pcm_i16_to_f32`(奇数长度/空/超 120 s 拒绝)、`percent_decode`、`transcribe`(路径变化才重载 `WhisperContext`;`OnceLock<Mutex>` 缓存兼作串行锁;greedy、`zh`、`initial_prompt`=块/书标题、线程数 = 核数 ≤ 8;分段 `get_segment(i).to_str_lossy()` 拼接);命令 `voice_models[] / voice_import_model[path](空则 rfd 主线程选择器,取消返回 null) / voice_select_model[name] / voice_delete_model[name] / voice_transcribe(原始体,头 x-bl-lang / x-bl-hint)`;六处同步;foundation 用例 2 条 + wire 分支 5 条(无模型即 invalid_request,不加载 whisper)。
- **web**:`audio/pcm.ts`(`ScriptProcessorNode` 原始帧 → `downmix` → `resampleLinear` 16 kHz → `floatToInt16`;`MediaRecorder`+`decodeAudioData` 回退;`listAudioInputs`);`VoiceInput`(🎙 → 录音态计时 + 电平 + 取消,≤ 120 s 自动停 → 转写中 → 文本经 `onText` **追加进输入框**并提示时长;权限拒绝/无麦克风/占用/无模型给可行动文案,`voiceSupport.ts`);费曼页 / 附加环节 / 终评三处启用;设置页「语音」分区(模型清单单选/删除确认/路径导入/原生选择器/输入设备 `enumerateDevices` 存 localStorage)替代原禁用占位;`config` 增 `VOICE_MAX_SECONDS/VOICE_SAMPLE_RATE/VOICE_DEVICE_KEY`;Mock 内存模型清单 + 固定文本。vitest +12(pcm 4、VoiceInput 4、设置 2、tauri 解码 1、契约 1)。
- **门禁(Mac,`gate-m3-t3.sh`,debug bundle 经 `open` 启动 + 自动化桥)**:①设置页填路径导入 574 MB 模型 → 清单显示 547 MB、单选自动选中、`setting.voiceModel=large-v3-turbo-q5_0`;②`say -v Tingting` 合成《道德经》第一章 11.4 s 语音(16 kHz i16)经 `voice_transcribe`:**冷 3.6 s(含加载模型)、热 2.9 s**,文本"道可道 非常道 明可明 非常明无明天地之始 有明万物之母故常无寓意观其妙 常有寓意观其教"(同音字来自 TTS 发音;CPU 推理,未启 Metal——Metal feature 需 Xcode 完整工具链编 shader,留作后续可选);③费曼页 🎙 真麦克风:点 🎙 → 1 s 内进入录音态(计时 0:05、电平 2%,环境音)→ 点停止 → 转写 3.2 s → 输入框填入"好"、提示"已填入,可编辑后发送(5.7 秒语音,转写用时 3.2 秒)"——`getUserMedia`→ScriptProcessor→重采样→IPC 原始体→whisper 全链路成立(授权在 spike 已给过,未再弹框)。
- 数字:壳层 Mac `cargo test` 32/4/1 绿(whisper.cpp 首次编译约 30 s,增量 11 s),clippy 0;web 317/2、lint 0、`pnpm build`。**首推被拒**:分支曾 rebase 到 main,须 `--force-with-lease`;Mac 同名 tmux 会话要先杀再起。

## 2026-09-08 · M3 T6:收尾与打包
- **T6.1 文案与性能**:子代理巡检七页面 + 终评/导入向导的加载/空态/错误态文案(表见本条末),据此修正——IPC 错误文案两侧同改(`数据已被更新,请刷新后重试` / `此功能暂未提供` / `请求内容无效` / `与应用内核通信失败,请重试` / `应用内核返回了无法识别的数据` / `未知错误`;去掉全角逗号与"后端"字样)、地图页"合并/拆分"提示与零块空态、任务卡"讲完自动完成"(completeTask 有意 unsupported)、导出对话框去掉 TECH_DESIGN 章节号、终评"这本书已不在书架上"走 `BackendError`、费曼准备页文案;今日页展示番茄钟状态读取失败;统计"投入"零投入文案。**性能**:`extractSpine(book, onProgress)` 每 6 章 `scheduler.yield()`/`setTimeout(0)` 让出主线程并逐章汇报(导入向导显示 `正在抽取章节文本 n/N:标题`);`EpubView` 首次 `rendered` 前显示骨架。**设置页启用 codex 可执行路径**:命令 `settings_codex_get[]`(path + 当前解析结果/错误文案)与 `settings_codex_set[path]`(校验即解析:相对路径 invalid_request、不可执行 not_found;空则清除),六处契约同提交;字段显示"当前使用 …"。**积压缺陷**:导入书名/作者改取 OPF `dc:title`/`dc:creator`(壳层最小字符串解析,不引 XML 依赖;**门禁发现 `zip` 关了默认特性无 deflate,读不到压缩条目**——校验只读 Stored 的 mimetype 才没暴露,开启 `deflate` 特性并把用例条目改为 Deflated);`apply_eval_in_tx` 改用 `insert_new_weak_points` 的 NOT EXISTS 去重(重考/重学同题薄弱点不再重复登记,已修复的再报出仍新增一行)。
- **T6.2 打包**:`tauri.conf.json` `bundle.active=true`、`targets [app,dmg]`、`icon.icns`、`macOS.minimumSystemVersion 12.0`、dmg 窗口布局;Mac `pnpm tauri build --bundles app,dmg` 97 s(release 首次含 whisper.cpp),`book-learner_0.1.0_aarch64.dmg` 5.7 MB,ad-hoc 签名(`flags=adhoc,linker-signed`);挂载 → 复制到新目录 → `open` 启动 → System Events 见窗口「攻书」visible → 退出。release 构建不认 `BOOK_LEARNER_DATA_DIR`(按设计),数据落 `~/Library/Application Support/book-learner/`。未新建干净 macOS 账号(需管理员密码),以"新目录副本 + 默认数据目录"替代;quarantine 与 Developer ID/notarization 步骤写在 `docs/smoke/m3-gate.md`。清掉 release 下 `Ordering` 未用导入告警。
- **T6.3 门禁(`gate-m3.sh`,debug bundle 经 `open --env` 启动 + 真 codex)**:§0 模型导入、codex 路径检测"当前使用 /opt/homebrew/bin/codex";§1a 导入《老子》(古登堡 24039)168 s 生成 13 块;§3 其余块置通过后地图页"整书终评"→ 考官开场追问框架 → 3 次作答 → 学习报告(总体 4/5、最强"复制、转换与商业分发"、最弱"许可与权利基础"),`artifact(report)`、`_report.md` 追加、书 finished、git `report:` 提交;§2 导出 14 个文件(`00-学习报告.md` + 13 块),块文件 frontmatter `book/block/seq/module/status/scores/passed_at/tags`、wikilink 以目标目录为根;§5 立即快照 → `snapshots/app-2026-09-08.db` 236 KB → 登记恢复 → `restore-pending.json` → 退出重启 → `app.db.replaced-<ts>` 保留、标记消费、数据完整;§7 codex 路径保存/清除写表。**首跑三处未过并处理**:①书名仍是文件名 → zip deflate(上文);②§1b 用 `say` 经扬声器朗读、麦克风电平 1%、转写成乱码——WebKit `echoCancellation` 把系统回放当回声压掉,真人说话不受影响;补跑 `gate-m3b.sh` 改为"真麦克风只验录音态/电平/回填 + 合成 16 kHz 语音经 `voice_transcribe` 填入输入框后完整走判定";③§4 阅读器 30 s 未渲染——`go /reader` 前没置前,后台 WebView 被节流(m2 已知),置前后同页 8 s 内 iframe 就绪;补跑脚本加 `front()`。**补跑(`gate-m3b.sh`/`gate-m3c.sh`)**:书名/作者 `老子|Laozi` ✓;真麦克风 4.4 s 录音 → 转写 3.4 s 回填 ✓;合成 17.9 s 语音经 `voice_transcribe` 2.9 s、文本准确 → 发送 → 学生追问 → 结束讲授 → 评估("建议再学",因朗读内容是老子而首块是古登堡许可证——判定合理);阅读器置前 2 s 骨架消失、书签/位置行落库 ✓。`gate-m3d.sh`(音频 base64 分片经桥传入,argv 有上限):合成 39.8 秒复述(古登堡使命/体系/许可/商标)经 `voice_transcribe` 6.4 秒转写、文本准确 → 填入输入框 → 发送 → 学生追问 → 结束讲授 → 评估「建议再学」(3/2/4,三条具体薄弱点:许可证触发条件过度概括、版本更新原则缺失、商业传播条件不具体)→ 点「暂不通过,再学一遍」→ 块 learning、薄弱点 3 条、回合 2;首跑中「确认通过」路径亦走通(块 passed)。判定严格是产品本意,语音链路含判定确认已完整闭环。
- **文档回写**:TECH_DESIGN §2(数据目录:models/snapshots/restore-pending)、§3.4(outbox 提交、push 通道退避、快照不进记忆库)、§4(v6–v8、`setting` 直读键)、§8(T3 已写);ADR-0001 增"推送通道例外"修订;IMPLEMENTATION_PLAN M3 表按 PR 勾选 + 明确范围外;CLAUDE.md 环境要求(cmake)与状态;`docs/smoke/m3-gate.md` 签字。
- 数字:core 166/27/1/1、clippy 0、fmt;web 321/2、lint 0、`pnpm build`;src-tauri Mac `cargo test` 33/4/1(含 codex 路径用例)、clippy 0、fmt。
- **文案巡检表(2026-09-08,子代理输出摘要)**:书架 `正在打开书架…`/`书架还空着——导入一本 EPUB 开始。`;地图 `正在展开地图…`/(新增零块文案);阅读器 `正在打开书籍…`/`(本书没有目录)`/`还没有书签…`;今日 `正在取回今日队列…`/`今天没有排定的任务`+鼓励语;费曼 `准备费曼讲授`/`你的学生已经坐好了…`;终评 `正在准备终评…`;统计 `正在统计…`/`书架为空;…`/`尚无评估;…`/`近 30 天没有间隔复习记录。`/(新增零投入);设置 `正在读取设置…`/`还没有快照;…`/(codex 字段启用);导入向导分步进度。保留的英文/术语:`Cmd/Ctrl + Enter 发送`、`Aa`、`Obsidian`/`git`/`whisper`/`codex`(产品名词)。

## 2026-09-08 · PDF 过渡方案:Calibre 转 EPUB 再导入
- **决定**:PDF 原生导入(pdf.js 抽取、按页锚定、PDF 阅读视图,估 2–3 天基础版)不立项;用户选择先用 Calibre `ebook-convert x.pdf x.epub` 转成 EPUB 再导入。学习闭环与格式无关,只有阅读器看到的是转换后排版。
- **改动**:导入向导文件选择器接受 `.pdf`,选到 PDF 时不导入、显示针对该文件的 `ebook-convert "书.pdf" "书.epub" --enable-heuristics` 命令与扫描版/文档提示,换选 EPUB 继续(library 用例 +1);`docs/pdf-import.md`(安装、参数、页眉页脚正则、切章、限制、验证记录);`docs/smoke/scripts/pdf-roundtrip.sh`。
- **Mac 环境**:Homebrew cask 走官方站经代理只有 3–4 MB/min,改从 GitHub Releases 拉 dmg 手动复制到 `/Applications/calibre.app`(与 cask 等效,记 CLAUDE.md 环境要求为可选)。
- **验证**:公版《道德經》EPUB → PDF(4 s)→ EPUB(2 s,书名/作者保留)→ 向导选 PDF 只给提示 → 选转换 EPUB 导入成功(6 章、21 块、544 s)。观察:章节名为 Calibre 拆分文件名,锚点全部整章回退——写进文档作为可选调参项。
- 数字:web 322/2、lint 0、build;core/壳层未改。

## 2026-09-09 · 测试阶段:发布脚本与诊断日志
- **背景**:用户开始测试;首个问题「导入失败 AI 暂时没有回应」根因是 Finder 启动没有 Homebrew PATH(PR #32),但从 Finder 启动的 app 没有任何日志,只能翻 SQLite 定位;且新旧包并存靠手工替换。
- **发布**:`docs/smoke/scripts/install-release.sh` 成为换包唯一入口(拉 main → 壳层测试 → release app+dmg → 优雅退出正在运行的正式版 → 替换 `/Applications` → 重开 → 打印版本);`build.rs` 注入 `BL_GIT_SHA`(含 `-dirty`)与 `BL_BUILT_AT`。
- **日志**(`diagnostics.rs`):`run()` 最先安装 stderr + `<data_root>/logs/app.log.YYYY-MM-DD`(`tracing-appender` 按天滚动、非阻塞;`RUST_LOG` 默认 info),启动首行记版本/提交/构建时间/日志目录;启动时清理 14 天前的日志;`run_command` 每条命令一行 info(命令名/关联 id/耗时/结果),失败带 `internal_cause`,不记正文;命令 `app_info[]`(版本/提交/构建/数据目录/日志目录)、`app_reveal_logs[]`(Finder 打开)、`log_client_event[level,message,context]`(白名单级别、消息与上下文各截 4 KiB、target client);六处契约同提交。
- **web**:`lib/clientLog.ts` 在 `main.tsx` 安装——window error / unhandledrejection / console.error 转发(每分钟 30 条限流并补丢弃计数、防递归、失败静默),`App.tsx` `RouteLogger` 记路由切换;设置页新增「诊断」分区(版本 · 提交 · 构建时间、数据/日志目录、打开日志目录)。用例:clientLog 3、settings 1、tauri 解码 1、契约 1;foundation 2。
- 教训回写 CODE_MAP §2 / CLAUDE.md 约定 / TECH_DESIGN §2。

## 2026-09-09 · 删除书(测试阶段补功能)
- **背景**:用户测试时问"书架没有删除?"——此前只有设为主攻/标记学完/导出,ADR-0004 也早记着"导入未完成书的徽标与删除入口未做"。
- **core**:`library::delete_book`(单事务:清掉引用该书的待处理投影 → 显式删 v1 老表 `daily_task/study_plan/knowledge_block`(对 book 无级联)→ 删 `book` 行,其余表靠外键级联 → 入队 `remove_book` + `git_commit`);`memory::remove_book`(删 `books/<slug>/`、去 INDEX 行,幂等);投影种类 `remove_book`;`Book.import_state` 进模型。单测 2 条(library 1、memory 1)。
- **壳层/契约**:`BookDto.importState`;`application::delete_book`(先刷当日快照 → core 删 → 删 `books/<id>.epub`);命令 `library_delete_book[bookId, date]`(后台重放投影);六处同步;foundation 用例 1 条 + wire 尾条。
- **web**:`Book.importState`、`deleteBook(bookId, date)`;书架卡片:`staged/extracted` 显示「导入未完成」徽标替代状态徽标;每张卡「删除」→ 危险确认框(说明会删什么、删前快照可恢复)→ 删主攻书后 `activeBookId` 置空;Mock 同语义(`importEpub` staged → `storeSpine` extracted → `runMapJob` mapped)。用例 +3(library 2、tauri 1);旧用例"暂停书显示已暂停"改为先完成导入。
- 门禁:core 168/27/1/1、clippy 0;web 330/2、lint 0、build;Mac 壳层见 PR。

## 2026-09-09 · 测试阶段套件 + BL-001 锚点回填
- **套件(PR #37)**:`docs/testing/BUGS.md` 缺陷台账(BL-001–005 预填)、`BUG_TEMPLATE.md`、`TEST_PLAN.md`(六大块清单 + 范围外)、`docs/smoke/scripts/diag-bundle.sh`(日志 + `app.db` 只读 `VACUUM INTO` 快照 + 16 张关键表导出 + 版本/系统信息 → 桌面 zip)、`CHANGELOG.md`(按批次发版)。
- **BL-001**:代码地图 review 发现 App 从未调用 `resolveBlockAnchors`/`setAnchorSegments`(只有 Playwright 冒烟在用),原生环境所有块锚点都是壳层落库时的整章回退。修法:新增 `web/src/epub/anchorBlocks.ts`——导入向导在 `runMapJob` 返回后重开 EPUB,对每块 `listAnchors` 取小节标题,`resolveBlockAnchors` 解析成两点 CFI 后 `setAnchorSegments` 写回;已是 `exact` 的块跳过(重试幂等),单块失败只计数不阻塞导入,进度显示「正在定位原文 n/N」。单测 1 条(解析/跳过/失败隔离/进度)+ 向导用例 1 条(Mock 整章回退 → 回填后全为精确段)。**已导入的书不回填**(需删除重导);手动锚点校正 UI 仍在范围外。
- 门禁:web 332/2、lint 0、build。

## 2026-09-09 · BL-006 阅读器选区工具条不出现
- **定位**:日志里 17:58 的阅读器会话只有 `reader_mark_add`(书签),没有任何前端异常;调试包探针:程序化选区与合成 mousedown/mouseup 后,iframe 文档上的 `selectionchange` 计数为 0,`[role=toolbar]` 不出现。根因:epub.js 用 `sandbox="allow-same-origin"`(我们 `allowScriptedContent:false`,不给 `allow-scripts`)的 srcdoc iframe 渲染正文,WKWebView 不向这种无脚本 iframe 派发 `selectionchange`,而 epub.js 的 `selected` 事件完全依赖它。开 `allow-scripts` 会让 EPUB 内脚本拿到 app 的 IPC,不可取。
- **修法**:`EpubView` 保留 `selected` 监听的同时,每 `READER_SELECTION_POLL_MS=300` ms 轮询 `rendition.getContents()` 各 contents 的 `window.getSelection()`,非空则 `contents.cfiFromRange(range)` 得区间 CFI 上报;同一区间只报一次,选区消失后重置。用例 1 条(reader.test「BL-006」,含 mock `getContents`)。Mac 验证:调试包程序化选区后工具条出现。
- 门禁:web 333/2、lint 0、build。

## 2026-09-10 · 阅读器一批(BL-007/008/009/010)
- **BL-009 鼠标点击不翻页**:同 BL-006 根因——正文 iframe 在 WKWebView 沙箱里收不到鼠标事件。修法:父文档在正文左右各叠一条 48 px 透明翻页区(`page-zone-prev/next`,悬停显渐变),点击即 `prev()/next()`;原 ‹ › 按钮抬到 z-20,键盘照旧。
- **BL-007 取消高亮**:epub.js 的注解 SVG 画在父文档,能收点击;`annotations.highlight` 第三参传回调 → `onHighlightClicked(cfi)` → 「高亮操作」条(换色 `readerMarkUpdate`、取消 `readerMarkRemove`、关闭);选区工具条与高亮操作条互斥。
- **BL-008 双页**:阅读设置加「双页显示」,prefs 持久化 `spread`,`rendition.spread('auto'|'none')` 运行时切换。
- **BL-010 翻页过渡**:`EpubView.next/prev` 先置 `data-turning`(下一 tick 用 `setTimeout(0)` 设,连续翻页可重触发;不用 rAF,后台窗口不派发帧)再翻页,CSS 关键帧让新页从翻页方向滑入 220 ms;`prefers-reduced-motion` 下不动。不做真实卷页。
- 用例 +4(reader.test);旧高亮用例的注解第三参改为 `expect.any(Function)`。门禁:web 337/2、lint 0、build。
- **Mac 实测**(debug bundle + 桥,`reader3/4-verify`):两侧翻页区点击后 `reader_position` 跨章前进/后退;`data-turning="next"` 出现并在 220 ms 后清除;点注解 SVG → 「高亮操作」→ 取消,SVG 与 `reader_mark` 行同时消失;勾选「双页显示」后 `rendition.spread('auto')`,仍是单个 iframe,分栏需视口 ≥ 800 px,故双页时阅读列放宽到 80em。
- **一次误判**:bisect 四个提交(含 main)都出现"容器里没有 iframe、骨架常驻",查到根因是探针没先置前——epub.js `Queue.run()` 靠 rAF 驱动,被遮挡的 WKWebView 不派发帧,`display()` 永远排队(见 CODE_MAP §9)。不是回归,驱动脚本一律先 `front()` 再开阅读器。
- 双页的 `spread()` 只在 `ready` 之后调用(`renderTo` 固定 `spread:'none'`),`start()` 之前调用会让 epub.js 没有 manager(`this.manager.next` undefined)。
