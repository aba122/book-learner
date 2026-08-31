# DEVLOG — book-learner 开发日志

> 每个工作阶段结束追加一条。格式:日期 / 完成内容 / 关键决策与偏差 / 测试状态。

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
