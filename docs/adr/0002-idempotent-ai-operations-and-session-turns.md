# ADR-0002 AI 操作与会话回合以客户端 ID 幂等,服务端持有权威 transcript

**Status:** Accepted(2026-09-05,Plan A)

## Context

Codex 调用是付费、慢(15–30 s)、可能超时的外部操作;前端路由重挂载(费曼 → 阅读器 → 费曼)、双击、超时后重试都可能重复触发。Foundation 的 `startSession/studentReply/endSession/confirmVerdict` 让客户端传整段 transcript,服务端无法区分重放与新请求。基线 §3:"Every external or non-idempotent operation carries a stable operation/request ID … Persist the user's turn before invoking Codex … The server owns the canonical transcript."

## Decision

1. **请求 ID 命名空间**(`orchestrate::validate_request_id`,≤128,`[A-Za-z0-9._:-]`;客户端提供的部分经 `validate_client_id`,≤64,`[A-Za-z0-9._-]`):`map:{job_id}:ch{idx}[:p{k}]`、`map:{job_id}:merge`、`turn:{session_id}:{client_turn_id}`、`eval:{session_id}:{request_id}`;判定确认以 `feynman_session.verdict_request_id` 唯一。
2. **`ai_request` 幂等表**:`run_ai_request` 是所有 AI 调用的唯一入口。同 id 已 `done` → 返回存储结果、不调 provider;`pending/failed` → 继续尝试并累加 `attempts`。provider 成功后先经 `accept` 校验,**只有 accept 通过才记 done**;不通过记 `failed`。传输类错误(`Ai | Io`)最多重试 2 次;`InvalidInput/Conflict/Db` 不重试。`run_ai_json` 在 accept 失败时**恰一次**纠错重试(把错误摘要追加到 system)。
3. **AI 调用期间不持有数据库事务**:`run_ai_request` 在非 autocommit 连接上直接返回 `Err(Other)`。调用方在事务 A 落库 → 调用 → 事务 B 落库。
4. **会话**:一个 `daily_task` 同时最多一个未确认会话(部分唯一索引 `feynman_session_open_per_task`);`start_or_resume_session` 以 `client_request_id` 幂等且存在即 resume。权威 transcript 是 `session_turn`,客户端只发"新回合 + expected_version"。
5. **回合协议**(顺序不可变):先按 `client_turn_id` 查重放(done → 直接返回)或续跑(pending → 跳过版本检查);否则校验 `state='open'`、无其他 pending 回合、`expected_version`;事务 A 写 pending user turn 且**不 bump version**;无事务调用 AI;事务 B 写学生回复并 `version+1`。失败时 user turn 保持 pending,客户端用同一版本、同一 turn id 重试;`get_session` 暴露 pending 回合的 `client_turn_id` 供重启后续跑。
6. **判定**:用户的 `pass` 覆盖 AI verdict;`confirm_session_verdict` 单事务;同 `verdict_request_id` 重放从 `verdict_json` 重建 outcome;不同 id 二次确认 → Conflict。

## Consequences

- 同一操作重复触发不会产生第二次付费调用、第二个会话、第二条回合或第二次判定。
- `expected_version` 让并发写可检测;版本只在"服务端状态被回复/评估/判定推进"时变化,客户端重试无需猜测新版本。
- `accept` 语义意味着"合法 JSON 但语义无效"(如地图有环)也不会被永久记为 done 卡死作业。
- prompt 经 argv 传入,上限 100 KiB(见 ADR-0004);超限为 `InvalidInput` 不重试。

## Tests that enforce it

- `core/src/orchestrate.rs`:同 id 重放不调 provider;传输重试 3 次;耗尽记 failed 并可续;accept 失败不记 done;纠错恰一次;事务内调用被拒;id 校验。
- `core/src/session.rs`:双 start 同会话;同 turn id 重放;失败保留 pending、版本不变;重开连接后凭 `client_turn_id` 续跑;pending 期间他 turn → Conflict。
- `core/src/verdict.rs`:评估幂等与失败回 open;确认幂等;用户判定覆盖 AI 建议。
- `core/tests/m1_engine.rs`:provider 回调内第二连接写入不阻塞(无事务持有)。
