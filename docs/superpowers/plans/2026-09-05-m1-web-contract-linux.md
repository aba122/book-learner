# M1 Web 契约 v2 与 EPUB JS 侧(Linux 可实现)Implementation Plan — Plan B

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 web 侧与 Plan A 的 core 引擎对齐——Backend 契约 v2(与 core 用例同名的幂等/版本化操作、稳定 block id + 修订号的地图确认、地图作业进度)、MockBackend 的 v2 语义、费曼页与地图页接新契约、EPUB 在 JS 侧的 spine 抽取与小节标题 → 有序多段 CFI 锚点(Playwright 真浏览器覆盖),使 Mac 阶段只剩 Rust DTO/command 接线。

**Architecture:** 契约演进**追加式**:先并存新旧方法(B1),页面逐个迁移(B3/B4/B6),最后删除旧方法(B7),每个 commit 都 tsc/lint/vitest 全绿。所有非幂等写操作的 id(`clientRequestId`/`clientTurnId`/`requestId`/`jobId`)在**触发时生成一次**并随 `useBackendOperation` 的 lastArgs 复用,重试即重放;版本(`expectedVersion`/`expectedRevision`)来自服务端返回值,页面不自行推算。`TauriBackend` 按 `shared/tauri-wire-contract.json` 的 `unsupportedCapabilities` **门控**:v2 方法的 command 名、payload key 与 DTO 解码器现在就落地并用假 invoke 测试,但在 Mac 移除对应 unsupported 条目前一律返回显式 `not_implemented`。EPUB 抽取/锚定只依赖 epub.js 的 `section.load`/`cfiFromRange`/`getRange`,纯逻辑(标题归一化与匹配)拆到无 DOM 的模块用 vitest 覆盖,DOM/CFI 路径用 Playwright(chromium,本机可跑)覆盖。

**Tech Stack:** React 18 + TS 5.9 + Vite 7 + vitest 4(jsdom,fireEvent + act 约定)+ Playwright 1.62(chromium)+ epubjs 0.3 + jszip(fixture);core 仅一处小改(`KnowledgeBlock.skipped`)。

**Spec 依据:** `TECH_DESIGN.md` §1.1(契约位置)、§4 v4、§6.1/6.2/6.3 已实现标注、§7.2/7.3(锚定与抽取在 JS 侧);`web/ARCHITECTURE.md` 五规则;基线文档 §3 决策(id 幂等、服务端权威 transcript、稳定 block id + 修订号、多段锚点)与 Node 5/6/8/9/10 的 web 侧部分;`docs/adr/0002`/`0003`/`0004`;Plan A DEVLOG A-T10 的 Mac 接线清单(契约命名以其为准)。**范围外**(Mac):Rust command/DTO 接线、原生 EPUB 传输(ADR-0004)、`epubUrl`/`blockSource` 原生实现、阅读器多段高亮与手动校正 UI(Node 7)、tray。

**环境约束:** 工作仓库 `/bigtemp/fzv6en/book-learner/review-clone`;基于 `feat/m1-core-engine` 新建 `feat/m1-web-contract`;`web/node_modules` 已就位勿重装;vitest 4 fake timers 与 user-event 互等死锁——涉及计时器的用例用 `fireEvent + act`,`findBy*` 在 fake timers 下会超时改用 `getBy*`;Playwright 用 `PLAYWRIGHT_BROWSERS_PATH=/bigtemp/fzv6en/book-learner/playwright-browsers pnpm -C web exec playwright test`(浏览器在 /bigtemp,不在 ~/.cache;webServer 自起 1421 端口);cargo 用 `CARGO_TARGET_DIR=/bigtemp/fzv6en/book-learner/cargo-target`;不改 `web/src-tauri`;绝不 push。

---

## 流程约定

- 每 Task:RED → GREEN → 焦点 → 全量 `pnpm -C web exec vitest --run` → `pnpm -C web exec tsc -b`(`build` 前半)→ `pnpm -C web lint`(**0 warnings**)→ `pnpm -C web build` → (涉及 core 时)`/bigtemp/fzv6en/book-learner/gate.sh` → 勾选复选框 → DEVLOG → commit(`feat|refactor|test(web): … (B-Tn)`)。B5 另加 `pnpm -C web exec playwright test`。
- 契约变更三处同步:`web/src/backend/types.ts`(接口)、`shared/tauri-wire-contract.json`(command/payloadKeys/unsupported)、`web/src/backend/contract.test.ts`(锁定)。
- 页面不得自持 id/版本推算逻辑:id 由 `lib/ids.ts` 生成一次并进入操作 args;版本只取服务端返回。
- 行为不变式:Today/Reader/Stats/Settings/Library(除导入向导)页面与其测试**不改**;`completeTask` 保留(Today 的复习直接完成),原生仍 unsupported(基线 Node 9)。

## 文件结构

```
core/src/models.rs                  ← KnowledgeBlock 增 skipped(BLOCK_COLS/RawBlock/parse + 用例)
web/src/types.ts                    ← 领域类型 v2:SpineChapter/AnchorSegment/MapProgress/MapEditOp/SessionView/TurnView/TurnResult/EvaluationView/VerdictOutcome;Book.mapRevision;KnowledgeBlock.skipped
web/src/backend/types.ts            ← Backend 接口 v2(B1 追加,B4 改 confirmMap 签名,B7 删旧)
shared/tauri-wire-contract.json     ← v2 command 名/payloadKeys + unsupported 列表(v2 全部先列为 unsupported)
web/src/backend/mock.ts             ← MockBackend v2 语义(幂等 id、版本冲突、一任务一会话、地图修订号、作业进度、spine/锚点存储)
web/src/backend/tauri.ts            ← v2 方法:按契约门控;DTO 解码器;runMapJob 进度经注入的 listen
web/src/backend/contract.test.ts / tauri.test.ts ← 契约与传输用例
web/src/lib/ids.ts (+ .test.ts)     ← newClientId():≤64、仅 [A-Za-z0-9._-](与 core validate_client_id 一致)
web/src/epub/headings.ts (+ .test.ts) ← 纯逻辑:标题归一化、候选匹配(重复标题按出现顺序消费)、段落切分文本归一化
web/src/epub/extract.ts             ← epub.js:有序 spine 抽取(href/title/text,去重 href)
web/src/epub/anchors.ts             ← epub.js:hint → 有序多段 CFI(exact),缺失回退整章(chapter_fallback),带段文本
web/src/anchors-smoke.ts + web/anchors-smoke.html ← Playwright 用真浏览器 harness(同 cfi-smoke 模式)
web/e2e/anchors-smoke.spec.ts       ← 重复标题/嵌套节点/缺失回退/多段/往返还原
web/scripts/make-fixture-epub.mjs   ← fixture 增 h2 小节(重复"小结"、嵌套 <em>),重新生成 public/fixtures/sample.epub
web/src/features/feynman/FeynmanPage.tsx (+ feynman.test.tsx) ← 接 startOrResumeSession/submitTurn/requestEvaluation/confirmSessionVerdict/abandonSession,服务端水合
web/src/features/map/MapPage.tsx (+ map.test.tsx) ← 操作集 + expectedRevision;skipped 展示
web/src/features/library/ImportWizard.tsx (+ library.test.tsx) ← importEpub → extractSpine → storeSpine → runMapJob(进度)
web/ARCHITECTURE.md / TECH_DESIGN.md §1.1/§7.2/§7.3 / DEVLOG.md ← 回写
```

---

## 契约 v2(B1 起生效;命名与 core 用例一致)

```ts
// web/src/types.ts(新增)
export interface SpineChapter { idx: number; href: string; title: string; text: string }
export type AnchorPrecision = 'exact' | 'chapter_fallback'
export interface AnchorSegment { spineHref: string; cfiStart: string; cfiEnd: string; precision: AnchorPrecision; hint: string; text: string }
export type MapProgress =
  | { stage: 'chapter'; index: number; total: number; title: string }
  | { stage: 'merging' }
  | { stage: 'done'; blocks: number }
export type MapEditOp =
  | { op: 'rename'; blockId: number; title: string }
  | { op: 'renameModule'; from: string; to: string }
  | { op: 'reorder'; blockIds: number[] }            // 全部块 id 的一个排列
  | { op: 'setSkipped'; blockId: number; skipped: boolean }
  | { op: 'merge'; into: number; from: number[] }
  | { op: 'split'; blockId: number }                 // core 返回 invalid_request(Mac 实现)
export type SessionState = 'open' | 'evaluating' | 'evaluated' | 'confirmed' | 'abandoned'
export type SessionKind = 'learn' | 'retest' | 'review' | 'final_exam'
export interface TurnView { role: 'user' | 'student'; text: string; status: 'pending' | 'done' | 'failed'; clientTurnId: string | null; readyToEnd: boolean }
export interface SessionView { sessionId: number; taskId: number; version: number; state: SessionState; blockId: number; kind: SessionKind; transcript: TurnView[]; eval: EvalResult | null }
export interface TurnResult { studentText: string; readyToEnd: boolean; version: number }
export interface EvaluationView { eval: EvalResult; version: number }
export interface VerdictOutcome { passed: boolean; blockStatus: BlockStatus; taskDone: boolean; outboxOps: number; version: number }
// 修改
export interface Book { …; mapRevision: number }          // core book.map_revision
export interface KnowledgeBlock { …; skipped: boolean }   // core knowledge_block.skipped

// web/src/backend/types.ts(B1 追加;B4 改 confirmMap;B7 删 generateMap/startSession/studentReply/endSession/confirmVerdict/MapEditBlock)
storeSpine(bookId: number, chapters: SpineChapter[]): Promise<void>
runMapJob(bookId: number, jobId: string, onProgress?: (p: MapProgress) => void): Promise<KnowledgeBlock[]>   // 作业 + 草图落库;同 jobId 幂等;已有地图直接返回
confirmMap(bookId: number, expectedRevision: number, ops: MapEditOp[]): Promise<{ revision: number }>      // B4 起
setAnchorSegments(blockId: number, segments: AnchorSegment[]): Promise<void>
listAnchors(blockId: number): Promise<AnchorSegment[]>
startOrResumeSession(taskId: number, clientRequestId: string, date: string): Promise<SessionView>   // date = 页面挂载时固定的本地日历日(core 校验任务属于该日)
submitTurn(sessionId: number, expectedVersion: number, clientTurnId: string, text: string): Promise<TurnResult>
requestEvaluation(sessionId: number, requestId: string): Promise<EvaluationView>
confirmSessionVerdict(sessionId: number, expectedVersion: number, requestId: string, pass: boolean, date: string): Promise<VerdictOutcome>   // date 同上(core 用于排复习/薄弱点日期)
abandonSession(sessionId: number, expectedVersion: number): Promise<void>
```

**id 约定**:`clientRequestId`/`clientTurnId`/`jobId` 由 `lib/ids.ts` 在触发时生成一次;评估与判定的 `requestId` 为**每会话确定的常量** `'eval'` / `'verdict'`(core 已按 `eval:{session}:{id}` / `verdict:{session}:{id}` 命名空间化,因此跨会话不冲突),这样重挂载后仍是"同 id 重试",core 处于 `evaluating` 时也能续跑而不是 Conflict。

wire(`shared/tauri-wire-contract.json` `commands` 追加;全部先进 `unsupportedCapabilities`,Mac 接线后逐条移除):
`storeSpine→map_store_spine[bookId,chapters]`、`runMapJob→map_run_job[bookId,jobId]`(进度经 Tauri event `map_job_progress`,payload `{jobId, progress}`)、`confirmMap→map_confirm[bookId,expectedRevision,ops]`、`setAnchorSegments→map_set_anchor_segments[blockId,segments]`、`listAnchors→map_list_anchors[blockId]`、`startOrResumeSession→session_start_or_resume[taskId,clientRequestId,date]`、`submitTurn→session_submit_turn[sessionId,expectedVersion,clientTurnId,text]`、`requestEvaluation→session_request_evaluation[sessionId,requestId]`、`confirmSessionVerdict→session_confirm_verdict[sessionId,expectedVersion,requestId,pass,date]`、`abandonSession→session_abandon[sessionId,expectedVersion]`。

错误码(Mock 与 tauri.ts `IPC_ERRORS` 一致):版本/修订号不符、状态不允许、任务已完成、同任务重复 → `conflict`(不可重试);id 不合法/reorder 非全排列/split → `invalid_request`;不存在 → `not_found`。

---

### Task B0: 分支、基线、计划入库

- [x] **Step B0.1** `git checkout -b feat/m1-web-contract feat/m1-core-engine`
- [x] **Step B0.2** 基线复跑并记录:`pnpm -C web exec vitest --run`(186 passed / 2 skipped,16 files)、`pnpm -C web lint`(0 warnings)、`pnpm -C web build`、`pnpm -C web exec playwright test`(1 passed)、`gate.sh`(core 126+27+1+1)。
- [x] **Step B0.3** DEVLOG:Plan B 评审通过与启动、范围、基线。
- [x] **Step B0.4** commit `docs: M1 web 契约 v2 计划 (B-T0)`

### Task B1: 领域类型 v2、契约追加、MockBackend v2 语义、Tauri 门控存根

**Files:** Modify `core/src/models.rs`、`web/src/types.ts`、`web/src/backend/types.ts`、`shared/tauri-wire-contract.json`、`web/src/backend/mock.ts`、`web/src/backend/tauri.ts`、`web/src/backend/contract.test.ts`、`web/src/backend/tauri.test.ts`;Create `web/src/lib/ids.ts`、`web/src/lib/ids.test.ts`

- [x] **Step B1.1 core 失败测试**(models tests):`list_blocks` 返回 `skipped`;`UPDATE knowledge_block SET skipped=1` 后为 true。RED → 实现(`BLOCK_COLS` 加 `skipped`,`RawBlock` 加 i64,`parse_block` 转 bool,结构体加 `pub skipped: bool`)→ `gate.sh` 绿(map.rs 用例可顺手改用该字段,不强制)。
- [x] **Step B1.2 web 失败测试**:
  - `lib/ids.test.ts`:`newClientId()` 长度 ≤64、匹配 `/^[A-Za-z0-9._-]+$/`、两次不同;`crypto.randomUUID` 不存在时的回退同样满足(用 `vi.stubGlobal`)。
  - `contract.test.ts`:
    1. wire 契约:`commands` 精确等于旧 9 条 + 上表 10 条(顺序:旧条目后追加);`unsupportedCapabilities` 精确等于旧 11 条 + **9** 个新方法名(`storeSpine, runMapJob, setAnchorSegments, listAnchors, startOrResumeSession, submitTurn, requestEvaluation, confirmSessionVerdict, abandonSession`——`confirmMap` 已在旧 11 条中,不得重复,否则精确相等用例与 tauri "每个 unsupported 条目对应恰一个方法"用例失败)。
    2. Mock 一任务一会话:`startOrResumeSession(3,'a',D)` 与 `(3,'b',D)` 同 sessionId、`(3,'a',D)` 重放同一;`transcript=[]`、`version=0`、`state='open'`、`kind='learn'`;`taskId=3`(`D` 为任意 `YYYY-MM-DD`;Mock 不按日期过滤,只校验格式,非法 → `invalid_request`)。
    3. Mock 任务校验:不存在任务 → `not_found`;已 done 任务(先 `completeTask(2)`)→ `conflict`;`clientRequestId` 含空格/冒号或 65 字符 → `invalid_request`。
    4. Mock 回合幂等与版本:`submitTurn(s,0,'t1','x')` 返回学生剧本第 1 条且 `version=1`;同 `'t1'` 再调(任意 expectedVersion)返回**相同** TurnResult 且剧本不推进;`submitTurn(s,0,'t2','y')`(旧版本)→ `conflict`;`(s,1,'t2','y')` → 第 2 条、`version=2`;第 4 条 `readyToEnd=true`;空文本 → `invalid_request`;`startOrResumeSession` 重放后 `transcript` 为 4 条(user/student 交替,`clientTurnId` 回填)。
    5. Mock 评估与判定:无回合 `requestEvaluation` → `conflict`;有回合后 `requestEvaluation(s,'eval')` → 评估固定件、`version` +1、state `evaluated`;同 `'eval'` 重放相同;`'e2'` → `conflict`;`confirmSessionVerdict(s,v,'verdict',true,D)` → `{passed:true, blockStatus:'passed', taskDone:true, outboxOps:4, version:v+1}`,块 `passed` 且 `scores/passedAt=D` 写入,任务 `done`;同 `'verdict'`(任何版本/pass)重放相同 outcome;`'c2'` → `conflict`;版本不符 → `conflict`;`pass=false` 时块 `learning`、任务仍 `pending`;weak_retest/review 任务(队列 id 1/2)确认后块状态不变、`outboxOps:3`、任务 done。
    6. Mock 放弃:`abandonSession(s,v)` 后 state `abandoned`、`version` +1;再 `submitTurn` → `conflict`;同任务再 `startOrResumeSession('z')` 得到**新** sessionId。
    7. Mock 地图:种子书 `mapRevision=1`,块 `skipped=false`;`runMapJob(1,'job-1')` 已有地图直接返回 12 块且不改修订号;`importEpub` 新书 `mapRevision=0`,`storeSpine(book,3 章)` 后 `runMapJob(book,'job-2', onProgress)` 依次收到 `chapter×3 → merging → done{blocks}`,块标题来自章标题,每块 `listAnchors` 为 1 段 `chapter_fallback`(`hint` 为章标题、`spineHref` 为章 href),`mapRevision=1`;同 `'job-2'` 重放不再触发进度且返回同块 id;`'job-2'` 用于另一本书 → `conflict`;`setAnchorSegments(blockId, [exact 段])` 后 `listAnchors` 相等且 `blockSource` 文本取自段 `text`。
  - `tauri.test.ts`:unsupported 列表用例覆盖 9 个新方法(调用 → `not_implemented` 且 `unsupported_capability` payload 正确;`confirmMap` 仍为旧签名直到 B4);既有 fixture `book`/`block`/`blockWithoutOptional` 补 `mapRevision`/`skipped`(解码器会输出默认值,`toEqual` 才能相等)。
- [x] **Step B1.3** RED(tsc:接口缺方法)→ **Step B1.4 实现**:类型与接口追加;JSON;`lib/ids.ts`(`crypto.randomUUID?.() ?? 时间戳+随机` 并校验正则);Mock 内部结构 `MockSession{sessionId, taskId, blockId, kind, state, version, transcript, scriptIdx, eval, clientRequestId, turnResults: Map<string,TurnResult>, evalRequestId?, verdictRequestId?, verdictOutcome?}`、`jobs: Map<jobId, bookId>`、`spines: Map<bookId, SpineChapter[]>`、`anchors: Map<blockId, AnchorSegment[]>`、`Book.mapRevision`、`KnowledgeBlock.skipped`;错误一律 `BackendError`(code 见上表);`TauriBackend` 的 10 个方法先 `return this.unsupported('<method>')`;`decodeBook`/`decodeBlock` 接受可选 `mapRevision`(默认 0)/`skipped`(默认 false)——**记入 Mac 接线清单:Rust DTO 必须补齐两字段**。
- [x] **Step B1.5** GREEN(vitest 全量、tsc、lint 0、build、gate.sh)→ **Step B1.6** commit `feat(web): Backend 契约 v2 追加与 MockBackend 幂等/版本语义 (B-T1)`

### Task B2: TauriBackend v2 解码器与契约门控

**Files:** Modify `web/src/backend/tauri.ts`、`web/src/backend/tauri.test.ts`

- [x] **Step B2.1 失败测试**(构造 `new TauriBackend(invoke, { contract, listen })`,测试用契约 = 正式契约但从 `unsupportedCapabilities` 移除被测方法):
  1. 10 个方法各一条"命令名 + payloadKeys 与契约一致 + 完整 fixture 解码相等"(SessionView 含 transcript/eval null、TurnResult、EvaluationView、VerdictOutcome、`{revision}`、AnchorSegment[]、KnowledgeBlock[] 含 `skipped`);
  2. 出站校验:非安全整数 `sessionId`、空 `clientTurnId`、`ops` 中未知 `op` → `invalid_request` 且**不调用** invoke;
  3. 入站校验:`state` 非法枚举、`transcript[0].role` 非法、`version` 非整数、`eval` 非 null 非对象 → `invalid_response` 带 path;
  4. 门控:正式契约下调用 `submitTurn` → `not_implemented`(不调用 `session_submit_turn`);假 invoke 须按既有 unsupported 用例的模式**以结构化错误拒绝** `unsupported_capability`(resolve 的假 invoke 会按设计得到 `invalid_response`);
  5. `runMapJob` 进度:注入的 `listen('map_job_progress', cb)` 在 invoke 期间收到 `{jobId:'j1', progress:{stage:'chapter',index:0,total:3,title:'一'}}` → `onProgress` 被调;不同 jobId 的事件被忽略;invoke 结束后 unlisten 被调用(即使 invoke 拒绝)。
- [x] **Step B2.2** RED → **Step B2.3 实现**:`TauriBackend` 构造 `(invokeFn = invoke, options: { contract?: WireContract; listen?: ListenFn } = {})`,`listen` 默认动态 `import('@tauri-apps/api/event').listen`(测试注入假函数);解码器 `decodeSessionView/decodeTurnView/decodeTurnResult/decodeEvaluationView/decodeVerdictOutcome/decodeAnchorSegment/decodeRevision`;出站 `outboundClientId`(正则同 ids.ts)、`outboundOps`;`gated(method, run)`:`contract.unsupportedCapabilities.includes(method) ? this.unsupported(method) : run()`。
- [x] **Step B2.4** GREEN → **Step B2.5** commit `feat(web): TauriBackend v2 命令解码器与契约门控,进度事件订阅 (B-T2)`

### Task B3: FeynmanPage 接新契约(服务端水合、同 id 重试、无 completeTask)

**Files:** Modify `web/src/features/feynman/FeynmanPage.tsx`、`web/src/features/feynman/feynman.test.tsx`

设计:
- `clientRequestId = useState(newClientId)`(每次挂载一次);初始化管线 `todayQueue → getBlock → blockSource → startOrResumeSession(taskId, clientRequestId, today)`(`today` 沿用页面挂载时固定的 `localCalendarDate`);因幂等,**允许重试初始化**(删除 `startAttempted` 单次守卫)。
- 水合:`transcript` 由 `view.transcript` 中 `status==='done'` 的回合映射为 `ChatMessage`;`version` 状态取 `view.version`;`readyToEnd` = 最后一条学生回合的 `readyToEnd`;`view.state==='evaluated' && view.eval` → 直接显示 EvalCard;`view.state==='evaluating'`(上次评估中断)→ 输入框与"发送"**禁用**(core 对非 open 会话的回合一律 Conflict),只保留"继续评估"("结束讲授"按钮改文案)与"放弃本次",点击继续评估即 `requestEvaluation(sessionId,'eval')`(core 同 id 续跑);放弃一律用**水合后的** `version`(evaluated/evaluating 态 core 也允许放弃);`pending` 用户回合 → 显示其文本并在其下呈现"上次发送未完成"的 `AsyncError`(retryable)+ 重试按钮,重试即 `sendOp.run('send', { clientTurnId: 原 id, text, expectedVersion: view.version })`。
- 发送:`send()` 生成 `clientTurnId = newClientId()`,`sendOp.run('send', { clientTurnId, text, expectedVersion: version })`;op 内 `backend.submitTurn(...)` 成功后 `setVersion(r.version)`;`retry('send')` 复用 lastArgs(同 id、同旧版本)。
- 结束讲授:`requestEvaluation(sessionId, 'eval')`(常量 id,见契约"id 约定")成功 → `setEvalResult(eval)`、`setVersion(version)`。
- 确认:`confirmSessionVerdict(sessionId, version, 'verdict', pass, today)` 成功 → `navigate('/')`;**不再调用 completeTask、不再设置 pendingNotice**。
- 放弃:Confirm 确认后 `abandonOp.run('abandon')` → `abandonSession(sessionId, version)` → 成功 `navigate('/')`;失败在 header 下方 `AsyncError`(可重试)。

- [x] **Step B3.1 失败测试**(改写 feynman.test.tsx,沿用 fireEvent+act;删除 `completeTask` 相关 3 条,替换为):
  1. 发送 → 学生第 1 条渐显(spy `submitTurn` 第 1 参 sessionId、第 2 参 0、第 3 参匹配 id 正则、第 4 参文本);`startOrResumeSession` 第 3 参为 `YYYY-MM-DD`;
  2. 4 轮 → ready → 结束讲授(`requestEvaluation(sessionId,'eval')`)→ 评估卡 → 确认通过:`confirmSessionVerdict(sessionId, 5, 'verdict', true, <today>)`(4 回合 +1 评估 = 5)→ 回今日;
  3. 重挂载水合:发送 1 轮后 unmount → 再 render 同路由 → 立即可见 2 条消息、`startOrResumeSession` 第二次调用返回同 sessionId,Mock 会话数不变;
  4. 已评估会话水合:spy `startOrResumeSession` 返回 `state:'evaluated', eval:固定件, version:9` → 无需再点结束即出现评估卡;确认调用带 `expectedVersion=9`;`state:'evaluating'` 水合 → 按钮"继续评估",点击调用 `requestEvaluation(sessionId,'eval')`;
  5. 失败保留并同 id 重试:`submitTurn` 第一次 retryable 拒绝 → 用户消息仍在、错误可见、无"思考中";点重试 → 第二次调用四个参数与第一次**完全相同**;成功后渐显;
  6. pending 回合水合:spy `startOrResumeSession` 返回含 `{role:'user', status:'pending', clientTurnId:'turn-x', text:'上次讲到一半'}` 的 transcript → 页面显示该消息与"上次发送未完成"重试;点重试 → `submitTurn(sessionId, view.version, 'turn-x', '上次讲到一半')`;
  7. 版本冲突:`submitTurn` 拒绝 `conflict`(不可重试)→ 错误可见、无重试按钮、输入框仍可用(用户可刷新);
  8. 放弃:确认放弃 → `abandonSession(sessionId, 当前版本)` 被调 → 回今日;`abandonSession` 失败 → 留在页面、错误可见可重试;
  9. 初始化失败可重试(含 `startOrResumeSession` 失败后重试同一 `clientRequestId`);
  10. 保留:卸载后晚到回复不处理、写操作进行中禁用"放弃"、回读原文跳转、双击不重复发送(改 spy 到 `submitTurn`)。
- [x] **Step B3.2** RED → **Step B3.3 实现** → **Step B3.4** GREEN(vitest 全量、tsc、lint 0、build)→ **Step B3.5** commit `feat(web): 费曼页接会话契约 v2——服务端水合、同 id 重试、原子判定 (B-T3)`

### Task B4: MapPage 接操作集 + expectedRevision;confirmMap 签名切换

**Files:** Modify `web/src/backend/types.ts`(`confirmMap` 新签名,删 `MapEditBlock`)、`web/src/backend/mock.ts`、`web/src/backend/tauri.ts`、`web/src/backend/contract.test.ts`、`web/src/backend/tauri.test.ts`、`web/src/features/map/MapPage.tsx`、`web/src/features/map/map.test.tsx`

设计:
- 浏览模式显示 `block.skipped`(半透明 + Tag "已跳过");编辑模式初值 `skipped = block.skipped`。
- `expectedRevision` 取自 `listBooks()` 中该书的 `mapRevision`(已有的 title 资源改为返回 `{title, mapRevision}`)。
- `finalize()` 由编辑态与原始块列表**差分**生成 ops(顺序固定):`renameModule`(按原模块名去重,仅变化者)→ `setSkipped`(仅变化者)→ `reorder`(仅当顺序变化;`blockIds` 为全部块 id 新顺序)。**无差异 → 跳过后端调用,但仍走成功路径**:退出编辑态并打开目标设定对话框(用户原样接受生成的地图也必须能设定计划;目标设定只有此入口)。
- `confirmMap(bookId, expectedRevision, ops)` 成功 → 退出编辑、重载块与书(新修订号)、打开目标设定;失败保留编辑,`conflict` 不可重试(文案要求刷新)。
- 既有用例调整:"地图定稿写入进行中同步阻止重复提交"须先做一个编辑(如跳过 `items[3]`)再点定稿(否则无差异不会调用后端);"定稿后目标设定"保持无编辑直接定稿 → 对话框打开、`confirmMap` **不**被调用。

- [x] **Step B4.1 失败测试**:
  - Mock/契约:`confirmMap(1, 0, [])` → `conflict`(种子修订号 1);`confirmMap(1, 1, [{op:'setSkipped',blockId:4,skipped:true},{op:'reorder',blockIds:[2,1,3,…12]}])` → `{revision:2}`,`listBlocks` 中块 4 `skipped=true`、块 2 `seq=1`、块 1 `seq=2`,已通过块的 `scores/passedAt/status` 不变;`reorder` 缺 id → `invalid_request` 且无变更;`split` → `invalid_request`;`merge{into:1,from:[2]}` → 块 2 `skipped=true` 且块 3 的 `prereqIds` 由 `[2]` 变 `[1]`;`renameModule` 改名;`listBooks` 修订号随之 +1。
  - tauri:`confirmMap` 门控解码(`map_confirm[bookId,expectedRevision,ops]` → `{revision}`);unsupported 用例改为新签名。
  - MapPage:跳过 + 上移后定稿 → `confirmMap(1, 1, [ {op:'setSkipped',blockId:4,skipped:true}, {op:'reorder',blockIds:[2,1,3,4,…,12]} ])`;改模块名 → 首条为 `renameModule{from:'供给与需求',to:'新模块'}`;无改动定稿 → 不调用后端、退出编辑态、目标设定对话框打开;`conflict` 拒绝 → 错误可见、无重试、编辑保留;成功后书修订号刷新(第二次定稿 `expectedRevision=2`);浏览模式种子块 `skipped` 显示"已跳过"(把种子块 4 置 skipped 后渲染);保留:加载失败/晚到/卸载/进行中双击(先做一个编辑)/目标设定用例。
- [x] **Step B4.2** RED → **Step B4.3 实现** → **Step B4.4** GREEN(vitest、tsc、lint 0、build)→ **Step B4.5** commit `feat(web): 地图页接稳定 id 操作集与修订号乐观并发 (B-T4)`

### Task B5: EPUB JS 侧——spine 抽取、小节标题 → 多段 CFI、Playwright 覆盖

**Files:** Create `web/src/epub/headings.ts`、`web/src/epub/headings.test.ts`、`web/src/epub/extract.ts`、`web/src/epub/anchors.ts`、`web/src/anchors-smoke.ts`、`web/anchors-smoke.html`、`web/e2e/anchors-smoke.spec.ts`;Modify `web/scripts/make-fixture-epub.mjs`、`web/public/fixtures/sample.epub`(重新生成)

接口:

```ts
// headings.ts(无 DOM 依赖)
export function normalizeHeading(s: string): string          // 去首尾/折叠空白、全角标点→半角、去掉编号前缀"第X节"/"1.2 "/"一、"、小写
export function normalizeText(s: string): string             // 折叠空白,段落以 "\n\n" 分隔
export interface HeadingCandidate { index: number; level: number; text: string }
/** 按 hint 在候选中找匹配:精确归一化相等 > 前缀/包含;同一 hint 多次出现按 used 集合跳过已消费者;无匹配 → null */
export function pickHeading(hint: string, candidates: HeadingCandidate[], used: Set<number>): HeadingCandidate | null
/** 段范围终点:下一个 level ≤ 本标题 level 的候选(无则 null = 章末) */
export function segmentEnd(start: HeadingCandidate, candidates: HeadingCandidate[]): HeadingCandidate | null

// extract.ts
export async function extractSpine(book: Book /* epubjs */): Promise<SpineChapter[]>
// 顺序遍历 book.spine(用 `spine.each(cb)`,typings 无 spineItems);section.load(book.load.bind(book));title = TOC label(href 匹配)?? 首个 h1..h3 文本 ?? href;
// text = body 内按块级元素/标题分段的 normalizeText(标题行前缀 "# "/"## " 保留层级);去重 href(保留首个);idx 为去重后序号;每章 unload
export async function openEpub(source: ArrayBuffer | string): Promise<Book>   // epub.js 打开(File.arrayBuffer() 或 URL),供向导与 harness 共用
export function chapterPlainText(doc: Document): string                       // normalizeText(body.textContent),**不带** "# " 标记——fallback 段的 text 与 harness 断言都用它

// anchors.ts
export interface AnchorHint { spineHref: string; hint: string }
export async function resolveBlockAnchors(book: Book, hints: AnchorHint[]): Promise<AnchorSegment[]>
// 每个 hint:load 该章;候选 = h1..h6 顺序表(text = 归一化 textContent,含嵌套子元素);pickHeading(hint) 命中 →
//   range = [标题元素起, segmentEnd 元素起 或 body 末) → cfiStart = section.cfiFromRange(collapsed at start),
//   cfiEnd = section.cfiFromRange(collapsed at end),text = normalizeText(range.toString()),precision 'exact';
//   hint 为空或未命中 → 整章:cfiStart/cfiEnd 为 body 首/末的折叠点 CFI,text = chapterPlainText(doc),precision 'chapter_fallback'。
//   同一调用内同章同 hint 多次 → used 集合依次消费;章 href 不存在 → 抛 Error(调用方决定回退)。
//   注意 cfiStart/cfiEnd 是两个**点** CFI(折叠 Range 经 section.cfiFromRange),不是 epub.js 的区间 CFI。
export async function restoreSegmentText(book: Book, seg: AnchorSegment): Promise<string>
// 往返还原不能用 book.getRange(它只接受单个区间 CFI):load 该章 section,用 `new EpubCFI(seg.cfiStart).toRange(section.document)`
// 与 `new EpubCFI(seg.cfiEnd).toRange(section.document)` 得到两个折叠 Range,再组合成一个 Range(start 取前者起点、end 取后者起点),
// 返回 normalizeText(range.toString())。
```

- [ ] **Step B5.1 fixture**:`make-fixture-epub.mjs` 每章增 `sections:[{heading, paras}]` 渲染为 `<h2>`;chap1:`需求定律`、`均衡与弹性`、`小结`、`练习`、`小结`(章内重复);chap2:`效用与边际`、`小结`(跨章重复);chap3:`生产函数`、`机会<em>成本</em>`(嵌套节点)、`规模经济`;h1 与 href 不变(reader 测试与 cfi-smoke 不受影响)。运行 `node web/scripts/make-fixture-epub.mjs` 重生成;`pnpm -C web exec playwright test e2e/cfi-smoke.spec.ts` 仍 1 passed。
- [ ] **Step B5.2 失败测试(vitest,headings.test.ts)**:`normalizeHeading('第一节 需求定律')==='需求定律'`、`'1.2  均衡与弹性'→'均衡与弹性'`、全角冒号/空白折叠;`pickHeading` 精确优先于包含、重复标题按 used 依次消费、无匹配 null;`segmentEnd`:h2 的终点是下一个 h2 或 h1,h3 的终点是下一个 h3/h2/h1,末尾 null;`normalizeText` 折叠与段落分隔。
- [ ] **Step B5.3** RED → 实现 `headings.ts` → GREEN。
- [ ] **Step B5.4 失败测试(Playwright,anchors-smoke.spec.ts)**:harness `anchors-smoke.ts` 打开 `/fixtures/sample.epub`,执行 `extractSpine` 与 `resolveBlockAnchors(book, [chap1#需求定律, chap1#小结, chap1#小结, chap2#小结, chap3#机会成本, chap3#不存在的小节, chap1#(空)])`,对每个 exact 段调用 `restoreSegmentText`,把结果挂到 `window.__ANCHORS_SMOKE__`;spec 断言:
  1. spine 3 章、href 为 chap1..3、title 为 h1 文本、chap1 文本含 `## 需求定律` 与 `弹性衡量`;
  2. `chap1#需求定律` exact,text 以"需求定律"起且不含"均衡与弹性"(段在下一 h2 前结束);
  3. 两个 `chap1#小结` 均 exact 且 `cfiStart` **不同**(重复标题按顺序消费),第二个 text 含"练习"之后的内容;`chap2#小结` 与 chap1 的不同 href;
  4. `chap3#机会成本` exact(嵌套 `<em>` 不影响匹配)且 text 含"机会成本";
  5. `chap3#不存在的小节` 与 `chap1#(空)` 为 `chapter_fallback`,text 等于 `chapterPlainText(该章 document)`(harness 同时导出该值供比较;不含 "# " 标记,因此**不等于** spine 抽取文本)且 cfiStart/cfiEnd 非空;
  6. 往返:每个 exact 段 `restored` 归一化后等于 `seg.text`;
  7. 多段:同一块传 `[chap1#需求定律, chap2#小结]` 得 2 段顺序保持。
- [ ] **Step B5.5** RED(harness 页面 `__ANCHORS_SMOKE__` 为空/断言失败)→ **Step B5.6 实现** `extract.ts`/`anchors.ts`/harness → **Step B5.7** GREEN:`pnpm -C web exec playwright test`(2 files passed)、vitest 全量、tsc、lint 0、build。
- [ ] **Step B5.8** commit `feat(web): EPUB spine 抽取与小节标题多段 CFI 锚定,Playwright 真浏览器覆盖 (B-T5)`

### Task B6: 导入向导接 JS 抽取 + storeSpine + runMapJob 进度

**Files:** Modify `web/src/features/library/ImportWizard.tsx`、`web/src/features/library/library.test.tsx`

设计:`ImportAttempt{file, type, jobId: newClientId(), bookId?, chapters?}`;op:`importEpub`(已导入则跳过)→ `openEpub(await file.arrayBuffer())` + `extractSpine`(已抽取则跳过;进度"正在抽取章节文本…")→ `storeSpine(bookId, chapters)` → `runMapJob(bookId, jobId, p => setProgress(progressLabel(p)))`;`progressLabel`:chapter → `正在分析第 {index+1}/{total} 章:{title}`、merging → `正在整合知识地图…`、done → `已生成 {blocks} 个知识块`。重试复用同一 attempt(同 jobId)。抽取失败 → `BackendError{code:'invalid_request', message:'无法解析这个 EPUB 文件', retryable:false}`。

- [x] **Step B6.1 失败测试**(`vi.mock('../../epub/extract')` 返回固定 3 章;沿用现有用例风格):导入 → 选类型 → 依次出现"正在抽取章节文本…"、"正在分析第 1/3 章:…"(用 deferred 控制 `runMapJob` 并手动触发 `onProgress`)→ 完成跳 `/map/:bookId`;`storeSpine` 收到 mock 章节;`runMapJob` 第 2 参匹配 id 正则且**重试时与首次相同**、`importEpub` 只调一次(`runMapJob` 先拒绝一次再成功);抽取失败 → 不可重试错误、保留文件与类型、只提供关闭;保留:原生不支持导入、进行中防重复。
- [x] **Step B6.2** RED → **Step B6.3 实现** → **Step B6.4** GREEN → **Step B6.5** commit `feat(web): 导入向导接 spine 抽取、storeSpine 与地图作业进度 (B-T6)`

### Task B7: 删除旧契约、回写文档、收尾

**Files:** Modify `web/src/backend/types.ts`、`web/src/backend/mock.ts`、`web/src/backend/tauri.ts`、`shared/tauri-wire-contract.json`、`web/src/backend/contract.test.ts`、`web/src/backend/tauri.test.ts`、`web/ARCHITECTURE.md`、`TECH_DESIGN.md`(§1.1 契约 v2、§7.2/7.3 已实现标注)、`docs/superpowers/plans/2026-09-02-product-m1-implementation-baseline.md`(Node 5/6/8/9/10 web 侧状态)、`DEVLOG.md`

- [ ] **Step B7.1 失败测试**:契约用例把 `unsupportedCapabilities` 精确改为 `['importEpub','completeTask','blockSource','epubUrl','stats']` + 10 个 v2 方法(删 `generateMap/startSession/studentReply/endSession/confirmVerdict`);tauri unsupported 用例同步;`grep -rn "generateMap\|startSession\|studentReply\|endSession\|confirmVerdict\|MapEditBlock" web/src` 必须为空(用 vitest 之外的 shell 检查记入 DEVLOG)。
- [ ] **Step B7.2** RED → **Step B7.3 实现**:删接口/Mock/Tauri 旧方法与 `MapEditBlock`;`ARCHITECTURE.md` 增规则 6(**id 与版本单点**:写操作 id 在触发时由 `lib/ids.ts` 生成一次并进入操作 args,重试复用;版本只取服务端返回)、能力矩阵改为 v2(原生支持 8 / 契约门控待接线 10 / 显式 unsupported 5);TECH_DESIGN §1.1 契约 v2 与 `epub/` 目录、§7.2/7.3 已实现标注(hint 匹配规则、重复标题按序消费、回退整章);基线 Node 状态。
- [ ] **Step B7.4** 全量门禁:vitest、tsc、lint 0、build、Playwright 2 specs、`gate.sh`;记录数字。
- [ ] **Step B7.5** DEVLOG 收尾条目:每 Task 数字、偏差、**待推送清单**(`feat/m1-core-engine`、`feat/m1-web-contract`、tags `m1-linux-a`/`m1-linux-b`)、**Mac 阶段需接线的 command 清单**(10 条 v2 command 与 DTO 字段:`Book.mapRevision`、`KnowledgeBlock.skipped`、SessionView/TurnView/TurnResult/EvaluationView/VerdictOutcome/AnchorSegment/SpineChapter/MapProgress 的 camelCase 形状、`map_job_progress` 事件;接线后从 `unsupportedCapabilities` 移除即生效)。
- [ ] **Step B7.6** commit `refactor(web): 移除旧会话/地图契约,回写架构与设计文档 (B-T7)`;`git tag -a m1-linux-b`;`git bundle create /bigtemp/fzv6en/book-learner/m1-linux-pending.bundle ^origin/feat/mac-m1 feat/m1-core-engine feat/m1-web-contract m1-linux-a m1-linux-b`(range 语法不会自动带上 tag,必须逐个列出;DEVLOG 记录 bundle 路径与 `git bundle verify` / `git bundle list-heads` 结果)。

## 完成定义(DoD)

1. 契约 v2 在 `types.ts` + wire JSON 落地且命名与 core 用例一致;契约测试锁定 command/payloadKeys/unsupported;旧方法全部移除。
2. MockBackend 实现 v2 语义:同 id 重放、版本/修订号冲突、一任务一未确认会话、放弃后可重开、地图作业幂等与进度、锚点存储。
3. TauriBackend v2 解码器经假 invoke 测试,门控由契约 JSON 驱动;进度事件订阅可测。
4. 费曼页:服务端水合(含已评估与 pending 回合)、同 turn id/同版本重试、评估与判定 id 稳定、放弃走后端、不再 completeTask;地图页:差分操作集 + expectedRevision,conflict 不可重试,skipped 可见。
5. `epub/extract.ts`/`anchors.ts`:Playwright 覆盖重复标题(章内/跨章)、嵌套节点、缺失回退整章(标注 precision)、多段、往返还原;纯逻辑 vitest 覆盖。
6. 导入向导:抽取 → storeSpine → runMapJob 进度;重试同 jobId 幂等。
7. 门禁:vitest 全绿、tsc、oxlint 0、build、Playwright 2 specs、core gate;每 Task 一 commit;DEVLOG/ARCHITECTURE/TECH_DESIGN/基线回写;tag `m1-linux-b` 与 pending bundle。
