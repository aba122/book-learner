# ADR-0001 SQLite 是唯一事务事实源,Markdown/git 是 outbox 驱动的可重放投影

**Status:** Accepted(2026-09-05,Plan A)

## Context

L1 的 `lifecycle.rs` 把"SQLite 评估落库 → 块 md 写入 → `_weakpoints.md`/`_map.md` 镜像 → git commit"作为四段顺序调用;任一段之间崩溃都会让三种存储分叉,且没有任何记录能说明哪一段已完成。TECH_DESIGN §3.3 已明确"三种存储不能共享 ACID 事务",基线文档 §3 要求"SQLite is the transactional source of truth. Markdown and git are replayable projections"。记忆库 md 是给 codex 自主阅读与 git 备份用的,不是任何用例的读取来源。

## Decision

1. 所有会改变学习状态的用例(地图确认、判定确认)在**一个** SQLite `BEGIN IMMEDIATE` 事务内完成全部状态变更,并在**同一事务**内向 `projection_outbox(op_id UNIQUE, kind, payload, status, attempts, error)` 入队投影操作。事务提交即视为用例成功;投影尚未发生不影响用例返回。
2. 投影由 `projection::run_pending(conn, memory)` 重放:按 `id` 顺序处理 `status IN ('pending','failed')` 的行(failed 行 `attempts+1` 重试);每条成功后以短事务标记 `done`;失败则标记 `failed` 并**停止本轮**(保持顺序,后续行不越过失败行)。
3. 投影种类:`init_book`(建书目录与模板)、`block_eval`(块 md,携带用户判定 `passed` 与幂等 `entry_key`)、`sync_weakpoints`、`sync_map`(镜像再生,内容在重放时从 SQLite 读取)、`git_commit`。
4. 投影处理器必须幂等:镜像再生天然幂等;`block_eval` 以 `entry_key`(= op_id)标记评估历史行,同 key 已存在则整次调用 no-op;`init_book` 已存在即跳过;`git_commit` 容忍空提交。
5. 应用启动与每次用例之后都可安全调用 `run_pending`;Mac 阶段在启动恢复序列中调用它(基线 Node 11)。

## Consequences

- md 与 git 可能短暂落后于 SQLite,但永远可以从 outbox 追平;不存在"SQLite 未提交而 md 已写"的方向。
- 投影失败(磁盘、git)不会阻塞学习;失败信息留在 outbox 行,前端可提示"后台同步待重试"。
- 顺序停止意味着一条持续失败的行会阻塞其后的投影;这是有意的(保持因果顺序),需要用户可见的错误而不是静默跳过。
- md 内容不再是任何读取用例的输入;`transcript_json` 保留仅供回看。

## Tests that enforce it

- `core/src/projection.rs`:重放后 md/git 与 SQLite 一致;二次 `run_pending` 为 0;"文件已写、done 未落库"重放不重复历史行;git 失败停止、恢复后仅重试失败行;同 op_id 二次入队仍一行。
- `core/src/verdict.rs`:`confirm_session_verdict` 单事务内 outbox 行数(new 4 / weak_retest·review 3);双确认不产生重复行。
- `core/tests/m1_engine.rs`:重开连接后 `run_pending` 为 0,判定重放返回同 outcome。
