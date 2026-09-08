# web/ 架构守则(变更局部化)
1. **后端只经契约**:页面/组件只 import `backend`(src/backend/index.ts)、`backend/types.ts`、
   `backend/errors.ts` 与 `types.ts`,禁止直接 fetch/Tauri API。换后端 = 新增 backend/xxx.ts 一个文件。
2. **切片隔离**:features/<A>/ 禁止 import features/<B>/ 的任何文件;
   复用下沉到 components/ 或 backend 契约。改一个页面只动一个目录。
3. **视觉单点**:颜色/字体/圆角/阅读排版参数只写 theme/tokens.css(CSS 变量);
   组件内禁止硬编码色值。改视觉不触组件。
4. **行为单点**:一切可调参数(复习间隔/番茄钟/队列上限/任务预估时长)只写 config.ts;
   组件内禁止魔法数字。改规则不触页面。
5. **异步边界(单点实现)**:读取一律经 `lib/useAsyncResource`(generation 失效 + 卸载守卫 + 错误归一化;多步 fetcher 在步间检查 `isCurrent()`),
   写入一律经 `lib/useBackendOperation`(按 key 同步守卫 + committed-awaiting-refresh 持锁 + 逐 key 错误)。
   **页面禁止自持 generation/mounted/guard ref**;路由参数变化用 `key` 重挂载而非手工失效。
   歧义成功不自动重发;失败必须通过 `AsyncError` 或操作内联错误可见,不得留在永久 spinner。改重试/错误策略只动 lib/ 两个文件。
6. **id 与版本单点(2026-09-05,契约 v2)**:非幂等写操作的客户端 id(`clientRequestId`/`clientTurnId`/`jobId`)在触发时由 `lib/ids.ts` 生成一次并进入操作 args,
   重试复用同一 id(服务端重放/续跑);评估与判定用每会话常量 id(`'eval'`/`'verdict'`,core 按会话命名空间化)。
   `expectedVersion`/`expectedRevision` 只取服务端返回(会话视图 / 书目 `mapRevision`),页面不推算、不缓存旧值。
   会话页面以服务端视图为唯一事实源水合(以 sessionId 为 key 重挂载,不在 effect 里 setState)。

## 目录导览

```
src/
├─ main.tsx              仅 bootstrap
├─ App.tsx               路由 + 侧栏外壳
├─ theme/tokens.css      全部设计代币(色/字/距/阅读排版参数)
├─ config.ts             全部行为参数(间隔天数/番茄钟/薄弱点上限…)
├─ types.ts              领域类型单源(镜像 core 模型,camelCase)
├─ store.ts              zustand:仅跨页会话状态(当前书/进行中任务/一次性跨页提示)
├─ lib/
│  ├─ useAsyncResource.ts    读资源 hook(全部页面读取的唯一实现)
│  ├─ useBackendOperation.ts 写操作 hook(全部页面写入的唯一实现)
│  ├─ ids.ts                 客户端 id 生成(规则同 core validate_client_id)
│  └─ localDate.ts           本地日历日
├─ epub/
│  ├─ headings.ts            纯逻辑:标题归一化/匹配(重复标题按序消费)、文本归一化(vitest)
│  ├─ extract.ts             epub.js:打开、有序 spine 抽取(带标题层级标记)、整章纯文本
│  └─ anchors.ts             epub.js:小节标题 → 有序多段点 CFI(exact / 整章 chapter_fallback)、往返还原(Playwright)
├─ backend/
│  ├─ types.ts           Backend 接口(后端能力唯一契约)
│  ├─ mock.ts            MockBackend(内存种子数据+学生剧本)
│  ├─ tauri.ts           invoke 传输适配、DTO 验证、IPC 错误收敛
│  ├─ errors.ts          稳定 BackendError 与通用归一化
│  └─ index.ts           运行时选择(Tauri → TauriBackend,浏览器 → MockBackend)
├─ components/           共享基础组件(含 AsyncError)
└─ features/<页面>/      功能切片(today/library/map/reader/feynman/stats/settings)
```

## 能力矩阵(2026-09-05,契约 v2)

| 状态 | Backend 方法 |
|---|---|
| SQLite 原生支持 | `listBooks`, `setActiveBook`, `listBlocks`, `getBlock`, `setPlan`, `todayQueue`, `getSettings`, `saveSettings` |
| 契约门控(TS 解码器/出站校验已落地;Mac 接线 Rust command 后从 `unsupportedCapabilities` 移除即生效) | `storeSpine`, `runMapJob`, `confirmMap`, `setAnchorSegments`, `listAnchors`, `startOrResumeSession`, `submitTurn`, `requestEvaluation`, `confirmSessionVerdict`, `abandonSession` |
| 显式 `not_implemented` | `importEpub`, `completeTask`, `blockSource`, `epubUrl`, `stats` |

command 名、payload 顶层 key 与门控/未支持列表由 `../shared/tauri-wire-contract.json` 统一约束(`TauriBackend` 按该列表决定走真实 command 还是 `unsupported_capability`)。页面不根据运行时分叉业务成功路径;真实原生失败一律保留并呈现。`runMapJob` 进度经 Tauri event `map_job_progress`(payload `{ jobId, progress }`)按 jobId 过滤。 番茄钟阶段变化经 event `pomodoro_changed`(payload 为 `PomodoroSnapshot`),页面只经 `backend.subscribePomodoro` 订阅,不直连 Tauri event API。
