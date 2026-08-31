# DEVLOG — book-learner 开发日志

> 每个工作阶段结束追加一条。格式:日期 / 完成内容 / 关键决策与偏差 / 测试状态。

## 2026-08-31 · Mac Foundation T3 完成
- 共享默认值:仓库级 `shared/app-defaults.json` 成为 Web 设置的唯一默认值来源;`APP_DEFAULTS` 强类型导出,番茄钟常量与 `MockBackend` 设置均由其派生;Vite 仅额外放行 `shared/`,TypeScript 将该 JSON 纳入应用图。
- 本地日期:新增 `localCalendarDate`,统一 Today/Map/Feynman 的日历日计算;测试覆盖上海/洛杉矶的 UTC 跨日 instant、洛杉矶 DST 切换日,并锁定三页不得恢复 `toISOString().slice(0, 10)`。
- typed errors:新增 `BackendError`、`normalizeBackendError`、`isBackendError`,覆盖 Tauri 风格结构化拒绝、字符串、原生 `Error` 与未知值。
- TDD:三个循环均先观察 RED——日期/错误模块缺失、`APP_DEFAULTS` 缺失——再以最小实现转 GREEN;默认值契约 5/5,错误 5/5,双时区日期各 5/5。
- 验证:受影响聚焦测试 27/27,全量 Vitest 38/38;lint 退出 0(仅既有 6 个 warning,无新增);production build 与 `git diff --check` 通过(build 保留既有 >500kB chunk warning)。

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
