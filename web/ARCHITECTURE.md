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
│  └─ localDate.ts           本地日历日
├─ backend/
│  ├─ types.ts           Backend 接口(后端能力唯一契约)
│  ├─ mock.ts            MockBackend(内存种子数据+学生剧本)
│  ├─ tauri.ts           invoke 传输适配、DTO 验证、IPC 错误收敛
│  ├─ errors.ts          稳定 BackendError 与通用归一化
│  └─ index.ts           运行时选择(Tauri → TauriBackend,浏览器 → MockBackend)
├─ components/           共享基础组件(含 AsyncError)
└─ features/<页面>/      功能切片(today/library/map/reader/feynman/stats/settings)
```

## Mac Foundation 能力矩阵

| 状态 | Backend 方法 |
|---|---|
| SQLite 原生支持 | `listBooks`, `setActiveBook`, `listBlocks`, `getBlock`, `setPlan`, `todayQueue`, `getSettings`, `saveSettings` |
| 显式 `not_implemented` | `importEpub`, `generateMap`, `confirmMap`, `completeTask`, `blockSource`, `epubUrl`, `startSession`, `studentReply`, `endSession`, `confirmVerdict`, `stats` |

command 名、payload 顶层 key 与未支持能力列表由 `../shared/tauri-wire-contract.json` 统一约束。页面不根据运行时分叉业务成功路径;真实原生失败一律保留并呈现。
