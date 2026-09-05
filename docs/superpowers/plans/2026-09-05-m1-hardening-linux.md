# M1 Hardening Slice(Linux 可实现)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不触碰产品行为、不预设 ADR 结论的前提下,消除 M1 基线文档与 2026-09-05 review 共同判定的 P0 缺陷:前端异步机制去重为两个公共 hook 并让费曼页三处裸 await 获得错误态;core 侧修复 Codex 子进程 stderr 死锁/进程组清理、记忆库路径消毒与原子写、子表外键缺失与 v2 唯一索引迁移死锁、生产路径缺 busy_timeout、主攻书/活跃计划唯一性漏洞;传输层让 IPC 契约破坏可见。

**Architecture:** 前端新增 `web/src/lib/useAsyncResource.ts`(读资源:generation 失效 + 卸载守卫 + 归一化错误 + reload)与 `web/src/lib/useBackendOperation.ts`(写操作:按 key 同步守卫 + committed-awaiting-refresh 持锁 + 逐 key 错误 + 卸载失效),七个页面退化为声明式,行为由现有 158 个测试锁定;core 侧 `ai.rs` 并发排空 stderr 到有界 tail 并按进程组 kill,`memory.rs` 拒绝不安全 slug 并以"临时文件 + rename"原子落盘,`db.rs` 增加 schema v3(子表重建补外键,孤儿行导致迁移回滚)并在 v2 步骤前收敛多 active 计划。

**Tech Stack:** React 18 + TS + vitest/RTL(jsdom,fireEvent+act 约定)、Rust stable + rusqlite 0.31 + tempfile。

**Spec 依据:** 2026-09-05 code-review 10 条发现(编号 F1–F10,见 DEVLOG 收录);`docs/superpowers/plans/2026-09-02-product-m1-implementation-baseline.md` §2 P0、§3 决策("Route errors remain scoped by resource/operation. Read results use generation invalidation; writes acquire a synchronous guard")、§4 Node 4 / Node 10 的 Linux 可做子集;`web/ARCHITECTURE.md` 四规则。**范围外**(留给后续 Node,原因):ADR 四份与 spine 缓存/锚点段/会话表/outbox(Node 1,需用户决策);`MapEditBlock` 稳定 id 与地图修订号(Node 6,依赖 ADR4,现在改会被重做);会话/回合幂等 ID 与 draft 持久化(Node 8);原生 EPUB(Node 2/3/7);Apple Silicon 门禁(Node 0);**F3 `src-tauri/src/lib.rs:49` setup 失败 panic 无提示**——本机无法编译 Tauri crate,记入 DEVLOG 交 Mac 阶段修(改为显式错误对话框/日志后再退出)。

**环境约束:** 工作仓库为 `/bigtemp/fzv6en/book-learner/review-clone`(/p 卷配额满,不可写);基于分支 `linux-local`(= origin/feat/mac-m1 + 8 个未推送提交)新建 `feat/m1-hardening`;cargo 用 `CARGO_TARGET_DIR=/bigtemp/fzv6en/book-learner/cargo-target`;Tauri crate 在 Linux 无法编译(缺 GTK),本切片不改 `web/src-tauri`。

## code-review 发现清单(2026-09-05,与本计划 Task 的对应)

| # | 级别 | 位置 | 问题 | 处置 |
|---|---|---|---|---|
| F1 | HIGH | `core/src/db.rs:29` | 生产路径 `open()` 无 busy_timeout/handler,迁移串行化只在测试成立;并发打开即 `database is locked` | T9a |
| F2 | MED | `core/src/db.rs:97` | v2 唯一索引对已有多计划(同书多条 / 多 active)的旧库永久迁移失败 | T9a |
| F3 | MED | `web/src-tauri/src/lib.rs:49` | setup 失败 → panic,无窗口无日志 | **交 Mac 阶段**(本机不可编译 Tauri) |
| F4 | MED | `core/src/library.rs:37` | 切到无计划书籍 → 无任何 active 计划,队列静默停产 | T9b |
| F5 | MED | `core/src/planning.rs:84` | `book.status='active'` 不唯一,`insert_book` 不降级;setPlan/setActiveBook 两调用间有不一致窗口 | T9b |
| F6 | MED | `TodayPage.tsx:206` | conflict 失败永久禁用"完成",刷新不恢复 | T2/T3 |
| F7 | MED | `FeynmanPage.tsx:128` | send/endTeaching/confirmVerdict 无错误处理,永久 spinner | T5 |
| F8 | MED | `web/src/backend/tauri.ts:40` | 非契约 IPC 错误(如 Tauri 反序列化失败的纯字符串)坍缩为 unknown,双侧不可见 | T6b |
| F9 | LOW | `TodayPage.tsx:124` | 完成任务后 stats 不刷新 | T3 |
| F10 | LOW | `SettingsPage.tsx:129` | 数字输入清空变 0 | T4a |

---

## 流程约定

- 每 Task:RED → GREEN → 焦点回归 → 全量回归(`pnpm -C web exec vitest --run` / `cargo test`)→ 勾选复选框 → DEVLOG → conventional commit(`feat|fix|refactor(web|core): … (H-Tn)`)。
- **推送**:本机当前无凭证(PAT 已撤销)。每 Task 本地 commit;凭证到位后按顺序 push `feat/mac-m1`(8 个待推提交)与 `feat/m1-hardening`,并在 DEVLOG 记录远端 CI URL。这是基线文档 §4 "Push each node after repository write access is restored" 的既定策略。
- 行为不变式:重构类 Task(T3/T4)**不得修改**现有 feature 测试的断言;若现有测试只因为 mock 注入方式而需改动,DEVLOG 说明。
- lint:本切片结束时 `pnpm -C web lint` 须 **0 warnings**(现有 6 条全部消除)。

## 文件结构

```
web/src/lib/
├─ useAsyncResource.ts / .test.ts      ← T1 读资源 hook(单一职责:加载/失效/错误/重载)
└─ useBackendOperation.ts / .test.ts   ← T2 写操作 hook(单一职责:守卫/逐 key 错误/提交后持锁)
web/src/features/today/TodayPage.tsx   ← T3 改用两 hook(230→~120 行)
web/src/features/{stats,settings,library,map}/*Page.tsx ← T4 同上
web/src/features/feynman/FeynmanPage.tsx ← T5 send/end/confirm/abandon 接 useBackendOperation
web/src/features/reader/EpubView.tsx   ← T6 refs-in-render 修复
core/src/ai.rs                          ← T7 stderr 并发排空 + 进程组 kill
core/src/memory.rs                      ← T8 slug 校验 + 原子写
core/src/db.rs                          ← T9 v2 active 收敛 + SCHEMA_V3 子表重建
web/ARCHITECTURE.md / TECH_DESIGN.md / DEVLOG.md ← T10 回写
```

---

### Task 0: 分支与基线

- [x] **Step 0.1** `cd /bigtemp/fzv6en/book-learner/review-clone && git checkout -b feat/m1-hardening linux-local`
- [x] **Step 0.2** 基线确认(必须与 review 数字一致):`pnpm -C web exec vitest --run`(158 passed / 2 skipped)、`pnpm -C web lint`(6 warnings)、`CARGO_TARGET_DIR=… cargo test --manifest-path core/Cargo.toml`(66 passed / 1 ignored)。
- [x] **Step 0.3** DEVLOG 追加"2026-09-05 · M1 加固切片启动":范围、范围外与原因、推送策略、基线数字。
- [x] **Step 0.4** commit:`docs: M1 加固切片计划与基线 (H-T0)`(含本计划文件)

### Task 1: `useAsyncResource`(读资源 hook)

**Files:** Create `web/src/lib/useAsyncResource.ts`, `web/src/lib/useAsyncResource.test.ts`

设计(完整接口):

```ts
import { useCallback, useEffect, useRef, useState } from 'react'
import { normalizeBackendError, type BackendError } from '../backend/errors'

/** 多步 fetcher 在 isCurrent()===false 时抛出,hook 静默丢弃(不算错误)。 */
export class StaleResult extends Error { constructor() { super('stale'); this.name = 'StaleResult' } }

export interface AsyncResource<T> {
  data: T | null            // 最近一次成功结果;失败时保留旧快照
  error: BackendError | null
  loading: boolean          // 首载或 reload 进行中
  reload: () => Promise<boolean>  // 触发重载;晚到/卸载后结果被丢弃;返回是否成功发布
}

/** 读资源:generation 失效 + 卸载守卫 + 错误归一化。fetcher 须为稳定引用(useCallback)。
 *  多步 fetcher(如 todayQueue→listBlocks)必须在每步之间检查 isCurrent(),为 false 时立即 return/throw,
 *  否则卸载或 reload 后仍会发起后续请求(Today 既有断言 `listBlocks not called after unmount` 依赖此)。 */
export function useAsyncResource<T>(fetcher: (isCurrent: () => boolean) => Promise<T>): AsyncResource<T> {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<BackendError | null>(null)
  const [loading, setLoading] = useState(true)
  const generation = useRef(0)
  const mounted = useRef(false)

  const load = useCallback(async (): Promise<boolean> => {
    const gen = ++generation.current
    const isCurrent = () => mounted.current && gen === generation.current
    try {
      const next = await fetcher(isCurrent)
      if (!mounted.current || gen !== generation.current) return false
      setData(next); setError(null); setLoading(false)
      return true
    } catch (e) {
      if (e instanceof StaleResult) return false        // 多步 fetcher 主动放弃
      if (!mounted.current || gen !== generation.current) return false
      setError(normalizeBackendError(e)); setLoading(false)
      return false
    }
  }, [fetcher])

  useEffect(() => {
    mounted.current = true
    void load()                       // 不在 effect 内同步 setState(loading 初值已为 true)
    return () => { mounted.current = false; generation.current += 1 }
  }, [load])

  const reload = useCallback(() => {
    setLoading(true); setError(null)  // 事件处理器路径,允许同步 setState
    return load()
  }, [load])

  return { data, error, loading, reload }
}
```

- [x] **Step 1.1 失败测试**(`useAsyncResource.test.ts`,用 `renderHook` + deferred):
  1. 成功:data 发布、loading=false、error=null;
  2. 失败:error 为 BackendError(非 BackendError 输入被归一化 code='unknown')、data 保持旧值;
  3. 竞态:reload 两次,先发后至的旧结果被丢弃(第一次 deferred 后 resolve,data 应为第二次结果);
  4. 卸载:unmount 后 resolve 不抛、不再 setState(无 act 警告);
  5. reload 失败保留旧 data 且返回 false;成功返回 true;
  6. 多步 fetcher:第一步 resolve 前 unmount,fetcher 内 `if (!isCurrent()) return` 后第二步 spy **未被调用**(对应 Today 既有断言)。
- [x] **Step 1.2** RED → **Step 1.3** 实现如上 → **Step 1.4** GREEN → **Step 1.5** commit `feat(web): useAsyncResource 读资源 hook (H-T1)`

### Task 2: `useBackendOperation`(写操作 hook)

**Files:** Create `web/src/lib/useBackendOperation.ts`, `web/src/lib/useBackendOperation.test.ts`

设计(完整接口;抽象自 TodayPage 的 completionGuards / committedCompletionGuards / operationGenerations / operationFailures):

```ts
export type OpKey = number | string

export interface BackendOperation<A extends unknown[]> {
  run: (key: OpKey, ...args: A) => Promise<'ok' | 'failed' | 'ignored'>
  pending: ReadonlySet<OpKey>                 // 守卫中(进行中或提交后等待刷新)
  errors: ReadonlyMap<OpKey, BackendError>    // 逐 key 最近错误(非可重试错误也保留,供禁用态)
  retry: (key: OpKey) => Promise<'ok' | 'failed' | 'ignored'>  // 用上次 args 重跑
  clearError: (key: OpKey) => void
  clearAllErrors: () => void                  // 资源刷新成功后调用(F6:conflict 等不可重试错误不得永久禁用行)
  releaseCommitted: () => void                // 刷新成功后释放"已提交待刷新"守卫
}

export interface OperationOptions<A extends unknown[]> {
  /** 操作成功后调用(如刷新队列)。若其 reject,守卫**保持**(committed-awaiting-refresh),直到 releaseCommitted()。 */
  onCommitted?: (key: OpKey, ...args: A) => Promise<unknown>
}

export function useBackendOperation<A extends unknown[]>(
  op: (...args: A) => Promise<unknown>,
  options?: OperationOptions<A>,
): BackendOperation<A>
```

语义(逐条对应测试):
- `run` 同步检查 `pending.has(key)` → 有则立即返回 `'ignored'`(同任务双击);同步加入 pending(ref + state 同步)。
- 每 key generation:后发起的 run 使早先晚到的结果 `'ignored'`;卸载后一切结果 `'ignored'` 且不 setState。
- 失败:`errors.set(key, normalize(e))`,释放守卫,返回 `'failed'`。
- 成功且无 onCommitted:释放守卫,清 error,`'ok'`。成功且有 onCommitted:**先**把 key 标为 committed(与现 TodayPage 一致:并发的成功刷新可提前释放),再 await 之;resolve → 释放守卫;reject → **保留**守卫、不记 error(写已成功)、`'ok'`;`releaseCommitted()` 释放所有 committed key。
- `retry(key)`:无 lastArgs → `'ignored'`;否则 `run(key, ...lastArgs)`。
- 卸载:清 pending/lastArgs、generation 全部失效。

- [x] **Step 2.1 失败测试**:双击同 key 第二次 'ignored';不同 key 独立;失败记录逐 key 错误并释放;成功清错误;onCommitted reject 保持 pending、releaseCommitted 释放;晚到结果 'ignored';卸载后 'ignored' 且无 setState;retry 用上次 args。
- [x] **Step 2.2** RED → **Step 2.3** 实现 → **Step 2.4** GREEN → **Step 2.5** commit `feat(web): useBackendOperation 写操作 hook (H-T2)`

### Task 3: TodayPage 迁移到两 hook

**Files:** Modify `web/src/features/today/TodayPage.tsx`;测试 `today.test.tsx` **不改断言**

- [x] **Step 3.1** 记录基线:`pnpm -C web exec vitest --run src/features/today/today.test.tsx`(33 passed)与 `wc -l TodayPage.tsx`(230)。
- [x] **Step 3.2** 重构:队列+blocks 合为一个 `useAsyncResource(loadQueueBundle)`(fetcher 内部串行 todayQueue→listBlocks,**每步之间 `if (!isCurrent()) throw new StaleResult()`**(hook 对 StaleResult 静默丢弃,保持 `data` 类型干净,不引入 `| null`)以保住既有断言 `today.test.tsx:292-303`;返回 `{tasks, blocks}` 原子发布;`today` 仍在挂载时固定);stats 为第二个 `useAsyncResource`;完成任务为 `useBackendOperation(backend.completeTask, { onCommitted: () => queue.reload().then(ok => ok ? undefined : Promise.reject()) })`,队列 reload 成功后 `releaseCommitted()` **并 `clearAllErrors()`**(F6:`conflict` 文案说"刷新后重试",刷新后必须重新可用);`completionUnavailable` = `errors.get(id)?.retryable === false`。**F9**:`onCommitted` 内 `void stats.reload()` **fire-and-forget**(不参与 ok/reject 判定,stats 失败不得持有完成守卫),然后 await 队列 reload——这会改动 `today.test.tsx:472`(`重试完成操作只重发同一任务并在成功后刷新队列`)中 `expect(stats).toHaveBeenCalledTimes(1)` → 2,属**有意行为变更**,DEVLOG 明记(本切片唯一允许改的旧断言)。新增用例:conflict 失败 → 队列刷新成功后"完成"重新可用。删除页面内全部 generation/mounted/guard ref。
- [x] **Step 3.3** `today.test.tsx` 33/33 GREEN 不改断言;`pnpm -C web lint` 中 TodayPage 的 `set-state-in-effect` 警告消失(5 条剩余)。
- [x] **Step 3.4** commit `refactor(web): TodayPage 迁移至公共异步 hook (H-T3)`

### Task 4: Stats / Settings / Library / Map 迁移

**Files:** Modify 四个 `*Page.tsx`;各自测试不改断言

- [x] **Step 4.1** Stats(读)与 Settings(读 + saveSettings 写)先迁;**F10**:数字输入清空不得变 0——`AppSettings` 数字字段为 `number`,页面需为 pomodoroMinutes/breakMinutes 各持一个**字符串草稿 state**,空串/NaN/非正整数在本地显示校验错误并禁用保存,不发请求;合法时才写回 number(新增用例);焦点测试 GREEN,commit `refactor(web): Stats/Settings 迁移至公共异步 hook (H-T4a)`
- [x] **Step 4.2** Library(读 books + importEpub/generateMap/setActiveBook 写)与 Map(读 blocks + confirmMap/setPlan/setActiveBook 写)迁移;Map 的编辑态本地 state 保持;焦点测试 GREEN;lint 中 LibraryPage/MapPage 的 `set-state-in-effect` 消失(剩 3 条 EpubView)。commit `refactor(web): Library/Map 迁移至公共异步 hook (H-T4b)`
- [x] **Step 4.3** 全量 vitest 158/2 GREEN;`grep -c "Generation\|mounted.current" web/src/features/**/*.tsx` 应仅剩 Feynman/Reader(T5/T6 处理)。

### Task 5: FeynmanPage 操作错误态(基线 Node 10 的非幂等子集)

**Files:** Modify `web/src/features/feynman/FeynmanPage.tsx`;Test `feynman.test.tsx`(**新增**用例,不改旧断言)

- [x] **Step 5.1 失败测试**(遵循文件头 fireEvent+act 约定):
  1. `studentReply` reject(可重试)→ 出现 AsyncError(role=alert)含重试按钮,`thinking` 结束(无"思考中"永驻),用户草稿**保留在 transcript**(已发送的用户消息不丢),重试成功后学生回复正常渐显;
  2. `studentReply` reject 期间再点发送 → 'ignored'(无第二次调用);
  3. `endSession` reject → 错误显示于评估区,"结束讲授"按钮可重试,不导航;
  4. `confirmVerdict` reject → 错误显示于评估卡内,不导航、不调 `completeTask`;不可重试错误禁用"确认通过";
  5. `confirmVerdict` 成功但 `completeTask` reject → **不再回滚也不重发 verdict**(基线 §Node 10):`'confirm'` 操作函数**内部** try/catch `completeTask`,失败时 `useSession().setPendingNotice('评估已保存,任务状态稍后同步')` 并正常 resolve(hook 得 `'ok'`),随后导航 `/`;Today 页顶部显示一次性提示条并在挂载后清除。若把失败抛给 hook,评估卡会显示错误而不导航——这是错误实现;
  6. 卸载后晚到的 reply 不 setState(无 act 警告);
  7. 放弃(abandon)在 pending 期间禁用。
- [x] **Step 5.2** RED → **Step 5.3** 实现:`send`/`endTeaching`/`confirmVerdict` 各为 `useBackendOperation` 的 key('send'/'end'/'confirm');store 增 `pendingNotice`;Today 顶部渲染并在挂载后清除。
- [x] **Step 5.4** GREEN(feynman 焦点 + today 焦点)→ **Step 5.5** commit `feat(web): 费曼页 send/end/confirm 错误隔离与守卫 (H-T5)`

### Task 6: EpubView refs-in-render 修复

**Files:** Modify `web/src/features/reader/EpubView.tsx:53-56`;Test `reader.test.tsx`(现有用例作安全网 + 1 新用例)

- [x] **Step 6.1 失败测试**:onToc/onProgress 回调在父组件重渲染后被替换,epub 事件触发时应调用**最新**回调(用 mock rendition 手动触发 `relocated` 事件,断言第二个 spy 被调而非第一个)。
- [x] **Step 6.2** 实现:把 `onTocRef.current = onToc` 等三处渲染期赋值改为 `useEffect(() => { onTocRef.current = onToc }, [onToc])`(同 onProgress/initialHref);不改行为。
- [x] **Step 6.3** reader 焦点 GREEN;`pnpm -C web lint` **0 warnings**;commit `fix(web): EpubView 回调 ref 改为 effect 同步,lint 归零 (H-T6)`

### Task 6b: `tauri.ts` — 让 IPC 契约破坏可见(F8)

**Files:** Modify `web/src/backend/tauri.ts:40`(normalizeInvokeError);Test `web/src/backend/tauri.test.ts`(新增)

- [x] **Step 6b.1 失败测试**:invoke reject 为纯字符串(Tauri 参数反序列化失败形态)→ `BackendError.code === 'transport_error'`、`retryable=false`、message 固定"与本地后端通信失败"、**details 仅含脱敏摘要 `{ actualType: 'string', length: n }`**(绝不带原文——既有用例 `tauri.test.ts:245-262` 断言 message+details 不含 `/Users/alice`/`top-secret`,必须继续成立);reject 为非契约对象 → `transport_error`,details `{ actualType: 'object', keys: <键名数组,≤10> }`(键名不是用户内容)。**有意更新**该既有 `it.each` 用例:code `'unknown'`→`'transport_error'`,message 随之改,隐私断言保留。
- [x] **Step 6b.2** RED → **Step 6b.3** 实现(只改 fallback 分支;`console.error('[ipc] transport_error', details)` 只输出脱敏摘要,符合基线 §3 日志策略)→ **Step 6b.4** GREEN → commit `fix(web): IPC 非契约错误显式归类为 transport_error 并保留脱敏摘要 (H-T6b)`

### Task 7: core `ai.rs` — stderr 并发排空与进程组清理(基线 Node 4 子集)

**Files:** Modify `core/src/ai.rs`

- [ ] **Step 7.1 失败测试**(现有 fake-codex 脚本模式):
  1. `stderr_larger_than_pipe_does_not_hang`:脚本向 stderr 写 2 MiB 后 `exit 3`(不写输出文件);`complete()` 须在 <10s 内返回 `Err(Ai)`,且错误文本含 `exit status: 3` 与 tail(最后 ≤400 字符);
  2. `timeout_kills_descendants`:脚本 `sleep 60 & echo $! > $MARKER; wait`(子孙进程);timeout_secs=1;返回 timeout 错误后,读取 MARKER 的 pid,**在 3s 内轮询** `/proc/<pid>/stat` 直到文件不存在或状态为 `Z`(SIGKILL 后的僵尸需等 init 回收,`kill -0` 对僵尸仍成功,不能用它判定);
  3. `stderr_tail_is_bounded`:非零退出 + 5000 字符 stderr → 错误消息长度 < 600;
  4. 现有 4 个 ai 测试保持 GREEN。
- [ ] **Step 7.2** RED → **Step 7.3** 实现:
  - `Command::process_group(0)`(`std::os::unix::process::CommandExt`,unix-only;cfg 保护)使子进程成为独立进程组;
  - spawn 后 `take()` stderr,起一个线程持续 `read` 到环形/有界缓冲(保留最后 4 KiB),线程在 EOF 结束;
  - 超时:`libc::kill(-pid, SIGKILL)`(引入 `libc` 依赖,unix)再 `child.wait()`;**正常退出路径也在 `wait()` 后对进程组补发 SIGKILL**(注释说明:leader 被回收后 pgid 理论上可被复用,Linux 上窗口可忽略,勿"修复"掉)(codex 留下的孙进程会让 stderr 管道不关闭、drain 线程 join 永挂);join 用 `recv_timeout(2s)` 有界等待,超时则放弃 join(线程为 detached,读到 EOF 自行结束);
  - 非零退出:tail 取缓冲末 400 字符(chars 边界安全)。
  - 临时输出文件:`NamedTempFile` 在所有返回路径 drop 即删除(现状已满足,加注释断言)。
- [ ] **Step 7.4** GREEN + `cargo clippy --all-targets -- -D warnings` → **Step 7.5** commit `fix(core): Codex 子进程 stderr 并发排空与进程组终止 (H-T7)`

### Task 8: core `memory.rs` — slug 校验与原子写

**Files:** Modify `core/src/memory.rs`

- [ ] **Step 8.1 失败测试**:
  1. `ensure_book("../evil", …)`、`"a/b"`、`""`、含 `\0` 或控制字符 → `Err(CoreError::InvalidInput)` 且 `root/..` 下未创建任何目录;
  2. `apply_eval` 传 `block_slug = "../x"` → InvalidInput;
  3. `atomic_write_leaves_no_temp`:apply_eval 成功后 `blocks/` 目录内不存在 `*.tmp*` 文件;
  4. `atomic_write_replaces_whole_file`:先写好原始块文件,再把 `blocks/` 目录 `chmod 0o555` 使临时文件创建失败 → `apply_eval` 返回 Err 且原文件内容逐字节未变、目录内无残留临时文件;测试开头 `if unsafe { libc::geteuid() } == 0 { return }`(root 不受目录权限约束);断言后把 `blocks/` 恢复 0o755,否则 TempDir 清理会静默失败留下目录。
- [ ] **Step 8.2** RED → **Step 8.3** 实现:`fn validate_slug(s: &str) -> Result<&str>`(规则:非空、长度 ≤ 128、**允许 Unicode 字母数字及 `._-`**、拒绝 `/` `\\` 与控制字符、拒绝全为 `.` 的值(`.`、`..`、`...`)——否则 `ensure_book(".")` 会把镜像文件写进 `books/` 本身);所有 `join(slug)` 前调用;`fn atomic_write(path, content)`:同目录 `NamedTempFile::new_in(parent)` 写入 + `flush` + `persist(path)`(rename)。ensure_book/apply_eval/sync_weakpoints/sync_map/INDEX 追加全部改用。
- [ ] **Step 8.4** GREEN(memory 焦点 + lifecycle 集成)→ **Step 8.5** commit `fix(core): 记忆库 slug 校验与原子落盘 (H-T8)`

### Task 9: core `db.rs` — v2 active 收敛 + SCHEMA_V3 子表外键重建

**Files:** Modify `core/src/db.rs`, `core/src/sched.rs`(generate_daily 事务模式), `core/src/library.rs`, `core/src/planning.rs`, `core/src/models.rs`, `web/src/backend/mock.ts`

- [ ] **Step 9.1 失败测试**:
  0. **F1** `open_installs_busy_timeout_in_production_path`:两连接 A、B 打开同一文件库(不安装任何测试 handler);A 开 IMMEDIATE 事务持有 100ms 后提交;B 在此期间 `open()` **必须成功**而非 `SQLITE_BUSY`(断言 `PRAGMA busy_timeout` ≥ 5000);另一用例:`sched::generate_daily` 在另一连接持写锁 100ms 时不失败——**前提是把 `generate_daily` 的 `unchecked_transaction()`(DEFERRED)改为 `Transaction::new_unchecked(conn, TransactionBehavior::Immediate)`**:SQLite 对已持 SHARED 读事务的连接做 RESERVED 升级时**不调用 busy handler**(死锁规避),DEFERRED 读后写会立刻 `database is locked`。并发策略正式记为:**所有读后写事务一律 BEGIN IMMEDIATE**(library/planning 已如此;`apply_eval_to_db` 先写故不受影响,也统一改)。
  1. `v1_with_two_active_plans_migrates_to_single_active`:手工建 v1 库,插两本书各一计划均 active=1 → `open()` 成功,user_version=3,仅 id 最大者 active=1;
  1b. **F2** `v1_with_two_plans_same_book_keeps_latest`:同一 book 两条 plan → 迁移后仅 id 最大者保留(另一条删除),不再是永久死锁;
  1c. **F5** `book_status_active_is_unique_after_v3`:v1 库三本书全 status='active' → v3 后仅 id 最大者 active,其余 'paused';之后 `INSERT book(... status='active')` 在已有 active 时 → `SQLITE_CONSTRAINT_UNIQUE`;
  1d. **F5** `insert_book_demotes_to_paused_when_active_exists`:`models::insert_book` 在已有 active 书时插入 → 新书 status='paused'(不再默认 active);
  1e. **F5** `set_plan_activates_only_for_active_book`(**回归锁**:`planning.rs:84-112` 现已按此行为,RED 阶段即绿,记录为锁定而非变更):对 paused 书 `set_plan` → 新计划 active=0 且不清其他;对 active 书 → active=1 并清其他;
  1f. **F4** `set_active_book_requires_plan`:目标书无 study_plan → `Err(CoreError::Conflict)`,原 active 书与计划**不变**;有计划 → 切换成功且恰一条 active 计划、恰一本 active 书(同一事务)。
  2. `v3_child_tables_enforce_foreign_keys`:`open_in_memory()` 后向 `weak_point`/`review_schedule`/`daily_task`/`feynman_session`/`artifact` 插入不存在的 block_id/book_id → 各返回 `SQLITE_CONSTRAINT_FOREIGNKEY`(现有 `assert_constraint_violation` 助手);
  3. `v2_with_orphan_rows_fails_migration_and_rolls_back`:手工建 v2 库(执行 V1+V2),插一条 `weak_point(block_id=999)` → `open()` 返回 Err,重新只读打开检查 user_version 仍为 2 且旧表结构完整(`PRAGMA table_info(weak_point)` 无变化);
  4. 既有 db 测试处置(**明确改动,非全部保持**):`open_creates_schema_v2` → 断言 v3;`conflicting_v1_study_plans_abort_v2_migration_without_data_loss`(`db.rs:327-360`,断言 open 失败且两计划保留)与新语义**相反,删除并由 1/1b 取代**;db.rs 测试助手 `insert_book`(`db.rs:123-130`)默认插 `status='active'`,第二本起会撞新唯一索引——改为显式传 status,`study_plan_allows_only_one_active_plan` 用 `'paused'` 插第二本;并发迁移测试保持 GREEN(见 busy_timeout 放置)。`core/tests/foundation.rs` 与 `web/src/backend/mock.ts` 若依赖"新书默认 active",按新语义更新并 DEVLOG 说明。
  5. **F4 Mock 对齐**:`MockBackend.setActiveBook` 对无计划书籍同样抛 `BackendError({code:'conflict', retryable:false})`,并加 mock 契约测试,保证浏览器与原生行为一致(LibraryPage 切换主攻的错误态在两侧一致可见)。
- [ ] **Step 9.2** RED → **Step 9.3** 实现:
  - **`open()` 与 `open_in_memory()` 中、调用 `configure()` 之前**执行 `conn.busy_timeout(Duration::from_secs(5))`(F1)。**不要放进 `configure()`**:`busy_timeout` 与 `busy_handler` 互斥,既有测试 `concurrent_open_waits_before_reading_migration_version`(`db.rs:179-218`)先自装 handler 再直接调 `configure()`,放进去会覆盖它导致该测试超时失败;
  - `SCHEMA_V2` 步骤前插入两条收敛:`DELETE FROM study_plan WHERE id NOT IN (SELECT max(id) FROM study_plan GROUP BY book_id)`(F2 同书多计划留最新)与 `UPDATE study_plan SET active=0 WHERE active=1 AND id NOT IN (SELECT max(id) FROM study_plan WHERE active=1)`(对已在 v2+ 的库不执行——步骤按版本跳过);
  - `SCHEMA_V3` 增 book 收敛:优先保留**持有 active 计划的那本书**为 active(`UPDATE book SET status='paused' WHERE status='active' AND id <> COALESCE((SELECT sp.book_id FROM study_plan sp JOIN book b ON b.id=sp.book_id WHERE sp.active=1 AND b.status='active'), (SELECT max(id) FROM book WHERE status='active'))`——JOIN 限定活跃计划所属书本身 active,否则遗留数据会把所有书降级为零活跃),再 `CREATE UNIQUE INDEX book_single_active ON book(status) WHERE status='active'`(F5;避免 v2 步骤保留的活跃计划与 v3 选出的活跃书不一致);
  - `models::insert_book`:存在 active 书时以 `'paused'` 插入(F5);`planning::set_plan`:仅当目标书 status='active' 才置 active=1 并清其他,否则 active=0(F5,消除 MapPage 两调用间的窗口);`library::set_active_book`:先查目标书有无 plan,无 → `Conflict("目标书籍尚无学习计划")`,有 → 同一事务内更新 book.status 与 plan.active(F4);
  - `SCHEMA_V3`:对 daily_task / feynman_session / weak_point / review_schedule / artifact 五表执行 `CREATE TABLE <t>_v3(… REFERENCES …)` → `INSERT INTO <t>_v3 SELECT … FROM <t>` → `DROP TABLE <t>` → `ALTER TABLE <t>_v3 RENAME TO <t>`;外键:`block_id REFERENCES knowledge_block(id) ON DELETE CASCADE`、`book_id REFERENCES book(id) ON DELETE CASCADE`、`daily_task.ref_id` 不加 FK(多态引用,注释说明);全部在既有 IMMEDIATE 事务内,`foreign_keys=ON` 使 INSERT…SELECT 遇孤儿即失败并回滚(即测试 3 的机制);`user_version=3`。
  - 注意 SQLite 在事务内无法切换 `PRAGMA foreign_keys`,因此**不用** OFF/ON 重建法;RENAME 时 SQLite ≥3.26 会自动更新引用方,本项目无表引用这五张表,安全。
- [ ] **Step 9.4** GREEN(db + library + planning + sched + foundation 集成测试;`core/tests/foundation.rs` 若断言旧的 insert_book 默认 active,按新语义更新并 DEVLOG 说明)+ clippy + `cargo fmt --check` → **Step 9.5** 拆两个 commit:`fix(core): busy_timeout 与 v2/v3 迁移数据收敛、子表外键 (H-T9a)`、`fix(core): 主攻书与活跃计划唯一性:insert_book/set_plan/set_active_book (H-T9b)`

### Task 10: 收尾——全量门禁、文档回写、推送准备

- [ ] **Step 10.1** 全量:`pnpm -C web exec vitest --run`(≥158 且新增用例计入)、`pnpm -C web lint`(**0 warnings**)、`pnpm -C web build`、`cargo test`(≥66 + 新增)、`cargo clippy --all-targets -- -D warnings`、`cargo fmt --check`。
- [ ] **Step 10.2** 回写:`web/ARCHITECTURE.md` 规则 1 文本补 `backend/errors.ts` 与 `backend/types.ts` 为允许的契约面(code-review 指出的文档漂移),并增第 5 条"异步读写只经 `lib/useAsyncResource` / `lib/useBackendOperation`,页面禁止自持 generation/mounted ref";`TECH_DESIGN.md` §3.3 补"记忆库写入为同目录临时文件 + rename 原子替换;slug 白名单校验",§4 补 schema v3 外键与级联语义,§5.1 补 stderr 并发排空/进程组终止;`IMPLEMENTATION_PLAN.md` M1 行注明本切片完成项;基线文档 Node 4/10 标注已完成子项与剩余。
- [ ] **Step 10.3** DEVLOG 收尾:收录 code-review F1–F10 及各自处置(本切片修复 / F3 交 Mac),各 Task 数字、偏差、**待推送清单**(`feat/mac-m1` 8 提交 + `feat/m1-hardening` N 提交)、推送后需确认的 CI URL 占位。
- [ ] **Step 10.4** commit `docs: M1 加固切片收尾与回写 (H-T10)`;**凭证到位后**:`git push origin linux-local:feat/mac-m1 feat/m1-hardening`(8 个待推提交在本地分支 `linux-local` 上,本地无 `feat/mac-m1` 分支),创建 PR #3(`feat/m1-hardening` → `feat/mac-m1`,堆叠),补 CI URL 到 DEVLOG 并 amend/追加提交。

## 完成定义(DoD)

1. 七页面无自持 generation/mounted 逻辑;两 hook 有独立测试;所有既有 feature 测试断言未改且全绿。
2. 费曼页任何后端失败都不会造成"思考中"永驻或 unhandled rejection;已发送用户消息不丢。
3. lint 0 warnings;vitest / cargo test / clippy / fmt / build 全绿。
4. codex 子进程 stderr 洪泛不再挂起;超时后无孤儿子孙进程;记忆库拒绝路径遍历、写入原子;子表外键生效、孤儿行导致迁移回滚而非静默通过;生产路径 busy_timeout 生效;旧库多计划/多活跃书迁移不再死锁;恰一本 active 书、恰一条 active 计划由数据库与用例双重保证;切到无计划书籍返回可操作错误而非静默清空队列。
5. 每 Task 一个可追溯 commit;DEVLOG 含待推送清单;推送与 PR #3 在凭证到位后完成。
