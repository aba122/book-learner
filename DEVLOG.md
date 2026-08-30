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
