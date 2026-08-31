# book-learner L2 — React 前端(Linux 可实现)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Linux 上实现 book-learner 的完整 React 前端(七个页面 + 设计系统 + Mock 后端桥),浏览器可跑通全学习流程;Mac 阶段只需新增 `backend/tauri.ts` 一个文件接入真后端。

**Architecture:** 变更局部化优先——①所有后端交互经单一 `Backend` 接口契约,页面永不直接触达数据源;②按功能切片(`features/<页面>/`),切片间禁止互相 import;③视觉参数全部集中于 `theme/tokens.css`,行为参数全部集中于 `config.ts`;④领域类型单源 `types.ts`(镜像 Rust core 模型)。任何单点需求变更(换后端/调视觉/改行为参数/改单页交互)都只动对应一处。

**Tech Stack:** Vite 7 + React 18 + TypeScript、Tailwind CSS v4(+ tokens.css 设计代币)、zustand、react-router-dom、epub.js、vitest + @testing-library/react(jsdom)。UI 实现前须加载 @frontend-design 技能。

**Spec 依据:** `../../PRODUCT_SPEC.md` §3(逐界面规格)、`../../TECH_DESIGN.md` §1/§7。**范围外**:Tauri 壳与 `backend/tauri.ts`、真实 codex 链路、whisper 语音、系统通知/tray(全部 Mac 阶段);epub CFI 精确锚定(前端只消费 `blockSource` 契约)。

**本机磁盘约束(重要):** /p 卷群组配额几乎满。重型产物一律放 /bigtemp:pnpm store 已配 `/bigtemp/fzv6en/pnpm-store`;`web/node_modules` 必须是指向 `/bigtemp/fzv6en/book-learner/web-node_modules` 的符号链接(T0 建立,先建链接再 install);core 重建用 `CARGO_TARGET_DIR=/bigtemp/fzv6en/book-learner/cargo-target`。

---

## 流程约定(在 L1 约定基础上新增)

- **每个 Task 完成 = commit + 立即 `git push origin feat/l2-web`**(T0 配好免交互推送)。
- 分支 `feat/l2-web` 基于 `feat/l1-core`(堆叠 PR:PR#2 base 设为 `feat/l1-core`,PR#1 合并后 GitHub 自动重定向到 main)。
- TDD:组件测试断言行为(渲染内容/交互后状态),不断言像素;epub.js 在 jsdom 中以模块 mock 处理,真渲染由浏览器验证。
- 变更局部化四规则写入 `web/ARCHITECTURE.md`,代码评审以此为查验清单。
- DEVLOG 照旧;与 SPEC 偏差当场回写。

## 文件结构

```
book-learner/
├─ .github/workflows/ci.yml   ← T0:push 触发 cargo test + pnpm test(远端可追溯绿灯)
└─ web/
   ├─ package.json  vite.config.ts  tsconfig.json  index.html
   ├─ ARCHITECTURE.md          ← 变更局部化四规则 + 目录导览
   ├─ node_modules -> /bigtemp/fzv6en/book-learner/web-node_modules(符号链接,已 gitignore)
   ├─ scripts/make-fixture-epub.mjs  ← 生成微型合法 EPUB 到 public/fixtures/sample.epub
   ├─ public/fixtures/sample.epub
   └─ src/
      ├─ main.tsx              ← 仅 bootstrap
      ├─ App.tsx               ← 路由 + 侧栏外壳
      ├─ test-setup.ts
      ├─ theme/tokens.css      ← 全部设计代币(色/字/距/阅读排版参数)
      ├─ config.ts             ← 全部行为参数(间隔天数/番茄钟/薄弱点上限…)
      ├─ types.ts              ← 领域类型单源(镜像 core 模型,camelCase)
      ├─ store.ts              ← zustand:仅跨页会话状态(当前书/进行中任务)
      ├─ backend/
      │  ├─ types.ts           ← Backend 接口(后端能力唯一契约)
      │  ├─ mock.ts            ← MockBackend(内存种子数据+学生剧本)
      │  ├─ index.ts           ← 运行时选择(Tauri 环境检测,现阶段恒 mock)
      │  └─ contract.test.ts
      ├─ components/           ← 共享基础组件:Button Card Tag ProgressRing PageHeader Confirm
      └─ features/
         ├─ today/    TodayPage.tsx TaskCard.tsx today.test.tsx
         ├─ library/  LibraryPage.tsx ImportWizard.tsx library.test.tsx
         ├─ map/      MapPage.tsx map.test.tsx
         ├─ reader/   ReaderPage.tsx EpubView.tsx reader.test.tsx
         ├─ feynman/  FeynmanPage.tsx EvalCard.tsx feynman.test.tsx
         ├─ stats/    StatsPage.tsx stats.test.tsx
         └─ settings/ SettingsPage.tsx settings.test.tsx
```

---

### Task 0: 分支、推送链路、磁盘策略、工程脚手架、CI

**Files:** Create: `web/`(脚手架)、`web/ARCHITECTURE.md`、`.github/workflows/ci.yml`;Modify: `DEVLOG.md`、根 `.gitignore`

- [x] **Step 0.1** `git checkout -b feat/l2-web feat/l1-core`
- [x] **Step 0.2 免交互推送**:`git remote set-url origin https://github.com/aba122/book-learner.git`;`git config --local credential.helper "store --file /u/fzv6en/.book-learner-cred"`;写 `/u/fzv6en/.book-learner-cred`(chmod 600,仓库外):`https://aba122:<PAT>@github.com`。**PAT 来源**:用当前会话中用户提供且已验证有效(API 200)的 token;若已失效,**暂停并向用户索取新 token**,期间各 Task 照常本地 commit,token 到位后一次性补 push(commit 历史仍逐 Task 可追溯)。验证 `git push -u origin feat/l2-web` 成功。
- [x] **Step 0.3 脚手架(注意磁盘策略)**:`pnpm create vite web --template react-ts`;删除生成的 demo 文件;**先建符号链接** `ln -s /bigtemp/fzv6en/book-learner/web-node_modules web/node_modules`;再 `pnpm -C web add zustand epubjs react-router-dom` 与 `pnpm -C web add -D tailwindcss @tailwindcss/vite vitest jsdom @testing-library/react @testing-library/user-event @testing-library/jest-dom @types/node jszip`(jszip 必须显式加:pnpm 隔离布局下不能 import 传递依赖)。`web/package.json` 写入 `"packageManager": "pnpm@11.24.0"`(CI corepack 确定性)。根 `.gitignore` 增加 `web/node_modules`。
- [x] **Step 0.4** `vite.config.ts`:接入 `@tailwindcss/vite` 插件与 vitest 配置(`test: { environment: 'jsdom', setupFiles: './src/test-setup.ts', passWithNoTests: true }`(零测试时 vitest --run 默认退出码 1,会打红 T0 的 CI),需 `/// <reference types="vitest/config" />`);`src/test-setup.ts` 引入 `@testing-library/jest-dom/vitest`。**`web/tsconfig.app.json` 增加 `"exclude": ["src/**/*.test.*", "src/test-setup.ts"]`**(create-vite 的 build 是 `tsc -b && vite build`,不排除的话 T1 的红测试 import 不存在的 mock.ts 会把 build 也打红;vitest 仍正常跑测试)。
- [x] **Step 0.5** 写 `web/ARCHITECTURE.md`:

```markdown
# web/ 架构守则(变更局部化)
1. **后端只经契约**:页面/组件只 import `backend`(src/backend/index.ts)与 `types.ts`,
   禁止直接 fetch/Tauri API。换后端 = 新增 backend/xxx.ts 一个文件。
2. **切片隔离**:features/<A>/ 禁止 import features/<B>/ 的任何文件;
   复用下沉到 components/ 或 backend 契约。改一个页面只动一个目录。
3. **视觉单点**:颜色/字体/圆角/阅读排版参数只写 theme/tokens.css(CSS 变量);
   组件内禁止硬编码色值。改视觉不触组件。
4. **行为单点**:一切可调参数(复习间隔/番茄钟/队列上限/任务预估时长)只写 config.ts;
   组件内禁止魔法数字。改规则不触页面。
```

- [x] **Step 0.6** `.github/workflows/ci.yml`:push/PR 触发,两 job——`core`(dtolnay/rust-toolchain@stable → `cargo test --manifest-path core/Cargo.toml`)与 `web`(actions/setup-node@v4 node 22 → `corepack enable` → `pnpm -C web install --frozen-lockfile` → `pnpm -C web test -- --run` → `pnpm -C web build`)。
- [x] **Step 0.7** `pnpm -C web test -- --run`(0 测试通过)与 `pnpm -C web build` 通过;DEVLOG 记 L2 启动;**commit + push**:`chore(web): L2 脚手架/CI/推送链路 (L2-T0)`

### Task 1: 领域类型 + Backend 契约(灵活性的锚点)

**Files:** Create: `web/src/types.ts`, `web/src/backend/types.ts`, `web/src/config.ts`(**index.ts 归 T2**);Test: `web/src/backend/contract.test.ts`

- [x] **Step 1.1** `types.ts`(完整代码,镜像 core 模型):

```ts
export type BookType = 'textbook' | 'methodology' | 'humanities'
export type BookStatus = 'active' | 'paused' | 'finished'
export type BlockStatus = 'unlearned' | 'learning' | 'passed' | 'weak' | 'consolidated'
export type TaskKind = 'new' | 'weak_retest' | 'review'
export type Verdict = 'pass_suggested' | 'relearn_suggested'

export interface Book { id: number; title: string; author: string; type: BookType; slug: string; status: BookStatus }
export interface Scores { accuracy: number; completeness: number; clarity: number }
export interface KnowledgeBlock {
  id: number; bookId: number; moduleName: string; seq: number; title: string; slug: string
  prereqIds: number[]; status: BlockStatus; scores?: Scores; passedAt?: string
}
export interface DailyTask {
  id: number; bookId: number; blockId: number; kind: TaskKind; seq: number
  status: 'pending' | 'done' | 'skipped'; estMinutes: number; refId?: number
}
export interface EvalWeakPoint { title: string; detail: string; fixedInSession: boolean }
export interface EvalResult {
  verdict: Verdict; scores: Scores; summary: string
  weakPoints: EvalWeakPoint[]; finalRestatement: string; observationNote: string
}
export interface StudyPlan { bookId: number; deadline: string; dailyNewBlocks: number; dailyCap: number; remindTime: string }
export interface ChatMessage { role: 'user' | 'student'; text: string }
export interface Stats { totalBlocks: number; passedBlocks: number; streakDays: number; openWeakPoints: number; fixedWeakPoints: number; minutesToday: number }
export interface AppSettings { obsidianVault: string; pomodoroMinutes: number; breakMinutes: number; remindTime: string }
```

- [x] **Step 1.2** `backend/types.ts`(完整代码——唯一后端契约):

```ts
import type {
  AppSettings, Book, BookType, ChatMessage, DailyTask, EvalResult,
  KnowledgeBlock, Stats, StudyPlan, TaskKind,
} from '../types'

export interface MapEditBlock { title: string; moduleName: string; seq: number; skipped: boolean }

export interface Backend {
  // 书架与导入
  listBooks(): Promise<Book[]>
  importEpub(file: File, type: BookType): Promise<{ bookId: number }>
  generateMap(bookId: number, onProgress?: (msg: string) => void): Promise<KnowledgeBlock[]>
  confirmMap(bookId: number, blocks: MapEditBlock[]): Promise<void>
  setActiveBook(bookId: number): Promise<void>
  // 计划与队列
  setPlan(plan: StudyPlan): Promise<void>
  todayQueue(date: string): Promise<DailyTask[]>
  completeTask(taskId: number): Promise<void>
  // 知识块与阅读
  listBlocks(bookId: number): Promise<KnowledgeBlock[]>
  getBlock(blockId: number): Promise<KnowledgeBlock>
  blockSource(blockId: number): Promise<{ href: string; text: string }>
  epubUrl(bookId: number): Promise<string>
  // 费曼环节
  startSession(blockId: number, kind: TaskKind): Promise<{ sessionId: number }>
  studentReply(sessionId: number, transcript: ChatMessage[]): Promise<{ text: string; readyToEnd: boolean }>
  endSession(sessionId: number): Promise<EvalResult>
  confirmVerdict(sessionId: number, pass: boolean): Promise<void>
  // 统计与设置
  stats(): Promise<Stats>
  getSettings(): Promise<AppSettings>
  saveSettings(s: AppSettings): Promise<void>
}
```

- [x] **Step 1.3** `config.ts`(行为参数单点,完整代码):

```ts
import type { TaskKind } from './types'
export const REVIEW_STAGES = [1, 3, 7, 14] as const
export const WEAK_RETEST_DAILY_LIMIT = 3
export const POMODORO_DEFAULT = { work: 25, break: 5 }
export const DAILY_CAP_DEFAULT = 4
export const TASK_EST_MINUTES: Record<TaskKind, number> = { new: 30, weak_retest: 10, review: 5 }
export const KIND_LABEL: Record<TaskKind, string> = { new: '新知识块', weak_retest: '薄弱点重考', review: '间隔复习' }
export const KIND_ORDER: TaskKind[] = ['weak_retest', 'review', 'new']
```

- [x] **Step 1.4 失败测试** `contract.test.ts`(测 MockBackend 的可见行为,T2 转绿):

```ts
import { describe, expect, it } from 'vitest'
import { MockBackend } from './mock'

describe('MockBackend 契约行为', () => {
  it('种子含至少一本主攻书', async () => {
    const b = new MockBackend()
    const books = await b.listBooks()
    expect(books.length).toBeGreaterThan(0)
    expect(books.some(x => x.status === 'active')).toBe(true)
  })
  it('今日队列按 weak_retest→review→new 排序', async () => {
    const b = new MockBackend()
    const q = await b.todayQueue('2026-08-30')
    const kinds = q.map(t => t.kind)
    expect(kinds).toEqual([...kinds].sort((a, z) =>
      ['weak_retest', 'review', 'new'].indexOf(a) - ['weak_retest', 'review', 'new'].indexOf(z)))
    expect(new Set(kinds)).toEqual(new Set(['weak_retest', 'review', 'new']))
  })
  it('学生剧本依次消费且末条 readyToEnd', async () => {
    const b = new MockBackend()
    const { sessionId } = await b.startSession(1, 'new')
    const replies = []
    for (let i = 0; i < 4; i++) replies.push(await b.studentReply(sessionId, []))
    expect(replies.at(-1)!.readyToEnd).toBe(true)
    expect(new Set(replies.map(r => r.text)).size).toBe(4)
  })
  it('评估结果分数在 1-5 且确认通过改变块状态', async () => {
    const b = new MockBackend()
    const { sessionId } = await b.startSession(4, 'new')
    const ev = await b.endSession(sessionId)
    for (const s of Object.values(ev.scores)) { expect(s).toBeGreaterThanOrEqual(1); expect(s).toBeLessThanOrEqual(5) }
    await b.confirmVerdict(sessionId, true)
    expect((await b.getBlock(4)).status).toBe('passed')
  })
})
```

  Run:FAIL(mock.ts 不存在)。**注意:T1 不建 backend/index.ts**(它 import mock.ts,会让 T1 提交连 build 都红;index.ts 归 T2)。`pnpm -C web build` 必须仍绿(红的只有测试)。
- [x] **Step 1.5 commit + push**:`feat(web): 领域类型与 Backend 契约 (L2-T1)`(契约+红测试小步提交,T2 立即转绿)

### Task 2: MockBackend(Linux 开发的替身后端)

**Files:** Create: `web/src/backend/mock.ts`, `web/src/backend/index.ts`

- [x] **Step 2.0** `backend/index.ts`:`const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window`;`export const backend: Backend = new MockBackend()`(isTauri 分支留 TODO 注释指向 Mac 阶段 tauri.ts)。
- [x] **Step 2.1 实现**:`export class MockBackend implements Backend`。内存种子(构造时 `seed()`,实例间独立):一本《微观经济学》(textbook,3 模块 12 块:2 passed/1 weak/9 unlearned)+ 今日队列(1 weak_retest + 1 review + 2 new,按 `KIND_ORDER` 与 `TASK_EST_MINUTES`)+ 学生剧本(4 条:3 追问 + 1 条 `readyToEnd: true`,内容贴"供需弹性"语境)+ 固定 EvalResult(pass 建议、**2 个薄弱点:1 个 `fixedInSession: true` + 1 个未修复**——T8 的"已当场修复"标记断言与 stats.fixedWeakPoints 都依赖此、observationNote 非空)。**2 个 passed 种子块必须带 `scores`**(T6 星级断言依赖)。写操作真实变更内存(confirmMap 重排/跳过、completeTask 置 done、confirmVerdict(true) 置块 passed、saveSettings 覆盖)。`generateMap` 以 3 次 `onProgress` 回调模拟进度后返回块列表。`epubUrl` 返回 `/fixtures/sample.epub`。`blockSource` 返回该块所在章 href 与 200 字左右中文原文样例。
- [x] **Step 2.2** `pnpm -C web test -- --run` → contract.test.ts 全绿。
- [x] **Step 2.3 commit + push**:`feat(web): MockBackend 内存实现 (L2-T2)`

### Task 3: 设计代币 + 共享组件 + App 外壳

**前置:实现前先 `Skill(frontend-design)` 加载设计指引,整个 L2 的 UI 按其执行。**

**Files:** Create: `web/src/theme/tokens.css`, `web/src/components/{Button,Card,Tag,ProgressRing,PageHeader,Confirm}.tsx`, `web/src/App.tsx`, `web/src/store.ts`;Modify: `web/src/main.tsx`, `web/src/index.css`;Test: `web/src/App.test.tsx`

- [ ] **Step 3.1** `tokens.css`:CSS 变量,`:root`(纸感亮色)与 `[data-theme='dark']` 两套——文字墨色阶 `--ink-1..4`、背景纸感阶 `--paper-1..3`、三任务色(`--c-weak` 赤 / `--c-review` 琥珀 / `--c-new` 靛)、语义色(成功/警示)、字体栈(`--font-serif`:Songti SC/Noto Serif CJK SC 标题用;`--font-sans`:PingFang SC/Noto Sans CJK SC 正文)、阅读排版(`--reading-max-width: 38em; --reading-line-height: 1.9`)、间距/圆角/阴影阶。`index.css` 里 `@import './theme/tokens.css'` + `@import 'tailwindcss'` + **`@theme inline`** 把代币映射为 Tailwind 色名(inline 保留 var() 间接,`[data-theme='dark']` 覆盖才生效);`data-theme` 属性打在 `<html>` 上(store 切换时同步)。
- [ ] **Step 3.2 失败测试** `App.test.tsx`:`render(<App />)`(App 内部用 createMemoryRouter 或包 MemoryRouter)→ 断言侧栏五项导航文本(今日学习/书架/知识地图/统计/设置);`userEvent.click` "书架" → 出现书架页 PageHeader 标题。Run:FAIL。
- [ ] **Step 3.3 实现**:`App.tsx` 侧栏 + `<Routes>` 七路由(`/`、`/library`、`/map/:bookId`、`/reader/:blockId`、`/feynman/:taskId`、`/stats`、`/settings`),页面组件先建最小占位(PageHeader + 空态);`store.ts` zustand 存 `activeBookId`/`currentTaskId`(App 挂载时从 listBooks 解析 active 书回填,侧栏"知识地图"链接用它拼 `/map/:bookId`,无主攻书时该项跳书架);共享组件全部只用代币变量。
- [ ] **Step 3.4** 测试绿;`pnpm -C web dev` 浏览器目检外壳与两主题。**commit + push**:`feat(web): 设计代币/共享组件/应用外壳 (L2-T3)`

### Task 4: 今日学习页

**Files:** Create: `web/src/features/today/{TodayPage,TaskCard,Pomodoro}.tsx`;Test: `today.test.tsx`

**测试约定(全部 feature 测试统一,只在此处定义一次)**:①凡 fake timers 与 userEvent 并用,必须 `userEvent.setup({ advanceTimers: vi.advanceTimersByTime })`,否则互等死锁;②注入模式:用工厂形式 `vi.mock('../../backend', () => ({ backend: null as unknown as Backend }))`(裸 automock 下命名空间可能不可写),`beforeEach` 里给 `backendModule.backend` 赋新 `new MockBackend()`,断言调用参数用 `vi.spyOn(backendModule.backend, 'confirmMap')` 等。

- [ ] **Step 4.1 失败测试**:渲染 TodayPage → `findAllByTestId('task-card')` 顺序为 weak→review→new(卡上有 `KIND_LABEL` 文本与预估分钟);顶部显示进度(passed/total 来自 stats);点击新块卡"开始" → 断言路由跳 `/reader/:blockId?task=<taskId>`(T7 学习模式靠此参数,MemoryRouter 断言 location);**review 任务卡有直接"完成"按钮**(新块的完成走费曼确认流,复习/重考在对话页外也可标记)→ 点击后 `completeTask` 被调且卡片变完成态;**番茄钟**:点任务卡"专注"→ 倒计时从 `POMODORO_DEFAULT.work` 分钟开始走(fake timers 快进 1 分钟断言显示 24:00)。
- [ ] **Step 4.2 实现** PRODUCT_SPEC §3.1:队列卡(左色条 = 任务色代币)、streak 与今日时长、进度环、空状态鼓励文案(明日预告契约缺失,留偏差)、页内番茄钟组件(work/break 两阶段,读 config;菜单栏倒计时归 Mac 阶段)。测试绿。
- [ ] **Step 4.3 commit + push**:`feat(web): 今日学习页 (L2-T4)`

### Task 5: 书架页 + 导入向导

**Files:** Create: `web/src/features/library/{LibraryPage,ImportWizard}.tsx`;Test: `library.test.tsx`

- [ ] **Step 5.1 失败测试**:书架渲染种子书与状态徽标(主攻中);点"导入书籍"→ 向导逐步:`upload` 一个 File → 三类型卡片选"教材" → 出现 generateMap 进度文案 → 完成跳 `/map/:bookId`。
- [ ] **Step 5.2 实现** PRODUCT_SPEC §3.2:封面网格(书名首字色块封面)、主攻书置顶、切换主攻书用 Confirm 组件确认后调 `setActiveBook`。测试绿。
- [ ] **Step 5.3 commit + push**:`feat(web): 书架页与导入向导 (L2-T5)`

### Task 6: 知识地图页

**Files:** Create: `web/src/features/map/MapPage.tsx`;Test: `map.test.tsx`

- [ ] **Step 6.1 失败测试**:按模块分组渲染 12 块(状态徽标 + 已通过块的星级);进入编辑模式 → 对某块点"跳过"、对另一块点"上移" → 点"确认定稿" → 断言 `confirmMap` 收到的 `MapEditBlock[]` 中该块 `skipped=true` 且顺序已变;**定稿后出现"目标设定"面板**(PRODUCT_SPEC §2 步骤3,西蒙法核心):输入完成期限 → 自动换算显示每日块数(或反向),设提醒时间 → 点"开始学习" → 断言 `setPlan` 收到 StudyPlan 且路由跳 `/`(该书成为主攻书:`setActiveBook` 被调)。
- [ ] **Step 6.2 实现** PRODUCT_SPEC §3.3 + 目标设定:编辑操作 = 跳过/恢复、上移/下移、改模块名;"合并/拆分"按钮渲染为禁用态(tooltip:需读原文选区,Mac 阶段实现;DEVLOG 记偏差);目标设定面板换算逻辑 = 未跳过块数 ÷ 天数(向上取整);`dailyCap` 用 config 的 `DAILY_CAP_DEFAULT`,不写魔法数。测试绿。
- [ ] **Step 6.3 commit + push**:`feat(web): 知识地图页 (L2-T6)`

### Task 7: 阅读器(epub.js)

**Files:** Create: `web/src/features/reader/{ReaderPage,EpubView}.tsx`, `web/scripts/make-fixture-epub.mjs`, `web/public/fixtures/sample.epub`;Test: `reader.test.tsx`(`vi.mock('epubjs')`)

- [ ] **Step 7.1** `make-fixture-epub.mjs`:用 jszip(Step 0.3 已作为显式 devDependency 安装)构造合法微型 EPUB——`mimetype`(STORE 不压缩)+ `META-INF/container.xml` + `OEBPS/content.opf`(3 个 spine 项)+ 3 章中文 xhtml(每章 ≥3 段,含 `<h1>`)。`node web/scripts/make-fixture-epub.mjs` 生成 `web/public/fixtures/sample.epub` 并提交产物。
- [ ] **Step 7.2 失败测试**:mock epubjs 默认导出(返回 `{ renderTo: vi.fn(() => rendition), loaded: { navigation: Promise.resolve({ toc: [...] }) }, destroy: vi.fn() }`,rendition 含 `display/themes.fontSize/themes.select/on` 的 spy)。断言:渲染 ReaderPage → `ePub` 以 mock 的 epubUrl 调用、`renderTo` 被调;点字号 +/- → `themes.fontSize` 收到变化值;切主题 → `themes.select` 被调;带 `?task=<id>` 进入 → 右侧出现块信息栏与"开始费曼讲授"按钮,点击跳 `/feynman/:taskId`。
- [ ] **Step 7.3 实现** PRODUCT_SPEC §3.4:`EpubView` 封装 epubjs 生命周期(初始化/销毁/resize),注册三主题(读 tokens 变量)与字号档;`ReaderPage` 组装目录抽屉、进度条、设置浮层、学习模式浮层(blockSource 的块信息 + 按钮)。测试绿 + `pnpm dev` 浏览器实读 fixture(翻页/目录/主题/字号逐项目检)。
- [ ] **Step 7.4 commit + push**:`feat(web): EPUB 阅读器与学习模式 (L2-T7)`

### Task 8: 费曼对话页(灵魂页面)

**Files:** Create: `web/src/features/feynman/{FeynmanPage,EvalCard}.tsx`;Test: `feynman.test.tsx`(fake timers 快进打字机;**必须** `userEvent.setup({ advanceTimers: vi.advanceTimersByTime })`,否则 user-event 与 fake timers 互等死锁)

- [ ] **Step 8.1 失败测试**:进入 FeynmanPage(路由带 taskId)→ 输入复述并发送 → 学生剧本第 1 条渐显完成后完整出现;连续 4 轮 → "结束讲授"按钮变主强调态;点击 → EvalCard:三维星级、薄弱点列表("已当场修复"打勾标记)、AI 建议文案;点"确认通过" → 断言 `confirmVerdict(sessionId, true)` 被调且路由回 `/`;"回读原文"跳 `/reader/:blockId?back=<taskId>`;"放弃本次"弹 Confirm 且确认后不调 confirmVerdict 直接返回。
- [ ] **Step 8.2 实现** PRODUCT_SPEC §3.5:左侧可折叠原文参考(blockSource)、中部对话流(用户右/学生左、打字机动画、自动滚底)、底部输入区(textarea,Cmd/Ctrl+Enter 发送;语音按钮禁用态 tooltip"Mac 版可用");工具条(回读原文/结束讲授/放弃本次)。测试绿 + 浏览器完整学一个块目检。
- [ ] **Step 8.3 commit + push**:`feat(web): 费曼对话页与评估卡 (L2-T8)`

### Task 9: 统计页 + 设置页

**Files:** Create: `web/src/features/stats/StatsPage.tsx`, `web/src/features/settings/SettingsPage.tsx`;Test: `stats.test.tsx`, `settings.test.tsx`

- [ ] **Step 9.1 失败测试**:统计页渲染 `stats()` 全部指标(进度、streak、今日分钟、薄弱点 open/fixed);设置页表单显示 `getSettings` 值,修改番茄钟分钟 + 保存 → `saveSettings` 收到新值并显示已保存提示。
- [ ] **Step 9.2 实现** §3.6/3.7 的 Linux 子集(图表用纯 CSS 条形/环形,不引图表库;codex 路径/whisper 模型/git 远程设置项渲染禁用态留位,tooltip 注明 Mac 阶段)。测试绿。
- [ ] **Step 9.3 commit + push**:`feat(web): 统计页与设置页 (L2-T9)`

### Task 10: 收尾——全量验证、文档回写、PR #2

- [ ] **Step 10.1** `pnpm -C web test -- --run` 全绿;`pnpm -C web build` 通过;`CARGO_TARGET_DIR=/bigtemp/fzv6en/book-learner/cargo-target cargo test --manifest-path core/Cargo.toml` 回归绿。
- [ ] **Step 10.2** 浏览器全流程冒烟:优先 @webapp-testing(Playwright:今日→开始任务→阅读器→费曼 4 轮→评估→确认通过→回今日,截图留档 scratchpad);Playwright 不可用则 `pnpm dev` 手动目检,DEVLOG 记录方式与结果。
- [ ] **Step 10.3** 回写:`TECH_DESIGN.md` §1 增补 web/ 结构与 Backend 契约位置;`CLAUDE.md` 状态区标记 L2 完成、Mac 阶段入口改为"实现 backend/tauri.ts + Tauri 壳接线";DEVLOG 收尾(测试计数/偏差清单:地图合并拆分延后、语音/封面留位、阅读器书签与行距/段首缩进设置延后、今日页"明日预告"契约缺失延后、菜单栏番茄倒计时归 Mac)。
- [ ] **Step 10.4** 确认 GitHub Actions 最新 run 绿(API:`/repos/aba122/book-learner/actions/runs?per_page=1`);红则修至绿。
- [ ] **Step 10.5** commit + push + `git tag l2-web && git push origin l2-web`;创建 **PR #2**:`feat/l2-web` → base `feat/l1-core`(堆叠,PR#1 合并后 GitHub 自动重定向),body 含 Summary/Test Plan/ARCHITECTURE.md 链接与逐 Task push 说明。

## 完成定义(DoD)

1. 七页面全部可用,浏览器跑通"今日队列→阅读→费曼对话→评估通过→回今日"闭环(Mock 数据)。
2. vitest 全绿 + build 通过 + GitHub CI 绿;逐 Task commit 可追溯,push 原则上逐 Task(凭证迟到时允许补推)。
3. 变更局部化四规则成立并写入 ARCHITECTURE.md:换后端=新增 1 文件、改视觉=tokens.css、改行为参数=config.ts、改单页=单目录。
4. PR #2 已创建,含逐 Task commit 历史。
