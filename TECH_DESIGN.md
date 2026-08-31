# TECH_DESIGN — book-learner 技术设计

## 1. 技术栈与架构总览

- **外壳**:Tauri 2(Rust 内核),目标 macOS(Apple Silicon 优先);app 常驻菜单栏(tray)。
- **前端**:React 18 + TypeScript + Vite;状态管理 zustand;样式 Tailwind CSS v4 + 阅读器专用自定义排版 CSS(设计代币:字体栈/版心/行高集中定义)。
- **数据**:SQLite(Rust 侧 rusqlite,经 Tauri command 暴露给前端;调度引擎与记忆写入同在 Rust 侧,便于事务一致性)。
- **EPUB**:前端 epub.js 负责渲染与文本抽取;书源文件拷贝入 app 数据目录管理。
- **AI**:codex CLI 子进程(Rust 侧 spawn),provider trait 抽象。
- **语音**:whisper.cpp(whisper-rs 绑定或 CLI 子进程),模型按需下载。

```
┌─ React 前端 ────────────────────────────────┐
│ 书架/地图/阅读器(epub.js)/费曼对话/统计/设置 │
└──────────────┬──────────────────────────────┘
        Tauri commands / events
┌──────────────┴──────────────────────────────┐
│ Rust 内核                                    │
│ ├─ ai:      AiProvider trait → CodexCli     │
│ ├─ memory:  记忆库管理器(md 读写 + git)      │
│ ├─ sched:   调度引擎(每日队列/间隔重复/重排) │
│ ├─ store:   rusqlite(状态/对话原文/统计)    │
│ ├─ voice:   whisper 转写                     │
│ ├─ export:  Obsidian 导出器                  │
│ └─ tray:    菜单栏/通知/番茄钟计时           │
└─────────────────────────────────────────────┘
```

### 1.1 web/ 前端结构与 Backend 契约(L2 已实现,Linux 可跑)

前端在 `web/`(Vite 7 + React 18 + TS + Tailwind v4 + vitest),架构守则见 `web/ARCHITECTURE.md`(变更局部化四规则)。关键位置:

- **Backend 契约(后端能力唯一接口)**:`web/src/backend/types.ts` 的 `Backend` interface;页面只 import `web/src/backend/index.ts` 导出的 `backend` 单例。当前恒为 `MockBackend`(`backend/mock.ts`,内存种子+学生剧本)。**Mac 阶段接真后端 = 新增 `backend/tauri.ts` 一个文件**(Tauri command 封装,实现同一 interface)并在 `index.ts` 按 `__TAURI_INTERNALS__` 检测切换,页面零改动。
- **领域类型单源**:`web/src/types.ts`(镜像 core 模型,camelCase)。
- **设计代币**:`web/src/theme/tokens.css`(双主题全部视觉参数,经 `@theme inline` 映射为 Tailwind 类名);**行为参数**:`web/src/config.ts`(复习间隔/番茄钟/队列上限/字号档/打字机速度)。
- **功能切片**:`web/src/features/{today,library,map,reader,feynman,stats,settings}/`,切片间禁止互相 import。
- EPUB fixture:`web/scripts/make-fixture-epub.mjs` 生成 `web/public/fixtures/sample.epub`(3 章中文 EPUB3,章 href 与 MockBackend.blockSource 对齐)。

## 2. 数据目录布局

```
~/Library/Application Support/book-learner/
├─ app.db               ← SQLite
├─ books/<book_id>.epub ← 导入的书源文件
├─ models/              ← whisper 模型
└─ memory/              ← 记忆库(git 仓库,详见 §3)
```

## 3. 记忆库(核心)

### 3.1 目录结构与文件模板

```
memory/
├─ INDEX.md              ← 总索引:书列表+状态+各文件导读,程序化维护
├─ profile.md            ← 全局学习者画像
└─ books/<book_slug>/
   ├─ _map.md            ← 知识地图 + 各块状态一览表
   ├─ _weakpoints.md     ← 薄弱点清单(待考/已修复)
   ├─ _methodology.md    ← (方法论书)个人方法论累积文档
   └─ blocks/<序号>-<块slug>.md
```

`profile.md` 分节:`## 知识背景` `## 已掌握概念`(按领域列表)`## 误区模式`(AI 观察积累)`## 个人情境`(工作/研究/生活现状,用户可手改,AI 从对话提取后追加候选,用户确认)。

`blocks/<n>-<slug>.md` 模板(固定区块由程序写入,格式不漂移):

```markdown
---
block_id: 17
status: passed          # unlearned|learning|passed|weak|consolidated
scores: {accuracy: 4, completeness: 3, clarity: 5}
passed_at: 2026-08-30
review_stage: 3         # 间隔复习到第几档
---
# 供需弹性

## 复述终稿
<用户最终通过的那次复述全文>

## 评估历史
- 2026-08-30 第2次:通过建议 ✓;薄弱点:弹性vs斜率(已当场修复)
- 2026-08-29 第1次:重学建议;薄弱点:未区分点弹性与弧弹性

## AI 观察笔记
<codex 自由追加的定性认识,只增不改>
```

### 3.2 上下文组装(固定注入 + 自主补充)

每次 AI 调用,Rust 侧组装 prompt 时**固定注入**:
1. 学习者画像摘要(profile.md 前 N 行的"背景+误区模式"节);
2. 当前块:原文全文(从 EPUB 抽取)、块文件的 frontmatter 与评估历史;
3. 该书 _weakpoints.md 中与当前块相关(同块或前置块)的待考薄弱点;
4. 前置块的名称与掌握状态(从 _map.md)。

同时告知 codex:工作目录即记忆库,可自主阅读 INDEX.md 与任何文件补充上下文(调用均以 `-C <memory_dir>` 运行)。

### 3.3 评估 JSON schema(结构化写入的来源)

费曼对话结束后的评估调用,要求 codex 最后输出且仅输出:

```json
{
  "verdict": "pass_suggested" | "relearn_suggested",
  "scores": {"accuracy": 1-5, "completeness": 1-5, "clarity": 1-5},
  "summary": "一句话总评",
  "weak_points": [
    {"title": "弹性vs斜率", "detail": "...", "fixed_in_session": true,
     "anchor": {"chapter_href": "ch03.xhtml", "hint": "第二节 弹性的度量"}}
  ],
  "final_restatement": "从对话中提炼的用户复述终稿(用户原话为主,轻度整理)",
  "observation_note": "对用户学习模式的定性观察,一两句,可为空"
}
```

app 校验 schema(serde 严格解析,失败则带错误信息重试一次)后:
- 程序化写入块文件固定区块与 frontmatter、_weakpoints.md、_map.md 状态行、SQLite;
- `observation_note` 追加到块文件"AI 观察笔记"区(只追加,永不重写历史);
- 全部写入在同一事务语义下完成:先写 SQLite(事务),成功后写 md,最后 git commit。

### 3.4 git 备份

- 首次启动 `git init memory/`;每次学习会话结束(评估写入后)自动 `git add -A && git commit -m "study: <book>/<block> <date>"`(git2 crate 或子进程)。
- 设置页可配置私有远程,commit 后异步 push,失败静默重试不阻塞学习。
- SQLite 每日首次启动时快照一份 `app.db.bak` 进 memory/(纳入 git)。

## 4. 数据模型(SQLite 草案)

```sql
book(id, title, author, type/*textbook|methodology|humanities*/, epub_path,
     cover_path, slug, status/*active|paused|finished*/, created_at)
knowledge_block(id, book_id, module_name, seq, title, slug,
     spine_href, cfi_start, cfi_end, prereq_ids/*json*/,
     status, scores_json, passed_at, skipped)
study_plan(id, book_id, deadline, daily_new_blocks, daily_cap,
     remind_time, evening_remind_time, active)
daily_task(id, date, book_id, block_id,
     kind/*new|weak_retest|review*/, seq, status/*pending|done|skipped*/,
     est_minutes, done_at, ref_id/*指向 weak_point.id 或 review_schedule.id*/)
feynman_session(id, block_id, kind/*learn|retest|review|final_exam*/,
     transcript_json/*完整对话原文,供回看*/,
     eval_json, started_at, ended_at, pomodoro_count)
weak_point(id, block_id, title, detail, anchor_json,
     status/*open|fixed*/, pass_streak, created_at, fixed_at)
review_schedule(id, block_id, stage/*1|3|7|14*/, due_date,
     status/*due|done|failed*/)
artifact(id, book_id, kind/*restatement|methodology|reflection|application|report*/,
     block_id_nullable, content_md, created_at)
setting(key, value)
```

调度引擎(Rust)每日零点/启动时生成 daily_task:先查 open weak_point(≤3)、再查 due review_schedule、再按 study_plan 配额取下一批 unlearned 块。落后重排:连续 2 天新块配额未完成 → 剩余块 ÷ 剩余天数,超 daily_cap 则发前端事件弹确认框(顺延 or 缩减地图)。

## 5. Codex 集成

### 5.1 调用约定

- 每次调用独立子进程:
  `codex exec -C <memory_dir> --sandbox workspace-write --output-last-message <tmpfile> "<prompt>"`
  读取 tmpfile 作为回复(避免解析 stdout 流水);需要结构化时 prompt 要求"最后一条消息只输出 JSON"。
- 只读型调用(学生追问轮次)用 `--sandbox read-only`;需要 AI 写自由笔记的场景不开放——所有写入统一由 app 程序化完成(§3.3),保证格式。
- 超时:对话轮次 120s,地图生成每章 300s;超时/非零退出 → 指数退避重试 2 次 → 仍失败弹前端错误(可手动重试,不丢已有对话)。
- 多轮对话:app 把完整对话历史(system 设定 + 逐轮 user/assistant)拼进每次 prompt;无跨进程状态。
- 前端体验:非流式,等待期显示"学生思考中…",回复用打字机动画渲染。

### 5.2 provider 抽象

```rust
trait AiProvider {
    fn complete(&self, req: CompletionRequest) -> Result<String>;
    // req: {system, messages, workdir, sandbox, timeout, expect_json}
}
struct CodexCliProvider { bin_path, model, extra_args }
```
未来可加 OpenAI 兼容 API / Claude provider,不影响上层。

## 6. AI Prompt 设计(产品灵魂)

以下为各 prompt 的骨架,实施时作为初版直接使用并迭代。所有 prompt 均为中文,注入内容见 §3.2。

### 6.1 知识地图生成(两阶段,防长书超上下文)

**阶段 A(逐章)**:注入单章全文 →「你是学习设计师。总结本章的知识点候选:每条含标题、一句话内容、依赖的先前概念、原文小节标题。输出 JSON 数组。」
**阶段 B(汇总)**:注入全部章节候选 + 书籍类型 →「将候选整合为知识地图:合并重复、按模块分组、每块 15–45 分钟可学完、给出前置依赖(教材类)/观点-框架-案例层级(方法论类)/叙事脉络分段(人文类)。输出 JSON:modules[{name, blocks[{title, summary, source_sections[], prereqs[]}]}]。」
app 将 source_sections 解析为 spine_href + CFI 范围(§7.2)。

### 6.2 费曼学生扮演(对话轮次)

system 要点:「你扮演一位聪明但完全没学过这个主题的学生,用户在教你。规则:①每次只回复一段话,只提问或表达困惑,绝不讲课、绝不补充正确答案;②追问策略:优先追问用户表述中模糊、跳步、与原文相悖之处;用『为什么』『如果…会怎样』『这和 X 有什么区别』式问题;③若用户已把当前要点讲清,自然转向该块下一个要点;④全部要点讲清后,回复以 [READY_TO_END] 结尾示意可以收尾;⑤语气好奇友善,不引经据典。」
注入:固定上下文(§3.2)+ 对话历史 + 书籍类型侧重(教材:边界条件与推导;方法论:框架要素关系与案例;人文:因果链与发展逻辑)。

### 6.3 评估(对话结束时独立调用)

「你是学习评估师。基于以下讲授对话与原文,严格评估用户对本块的掌握。评分标准:准确性(与原文/事实相符)、完整性(要点覆盖)、清晰度(能否让外行听懂)。宁可低估不可高估;用户当场修复的漏洞记为 fixed_in_session。最后一条消息只输出 JSON(schema 见 §3.3)。」

### 6.4 迁移应用题(教材类,通过后)

「基于本块知识与用户画像中的个人情境,出 1–2 道**现实情境**应用题(禁止书内例题改编;优先贴近用户的工作/研究情境)。用户作答后,评估其思路是否正确运用了本块知识,指出运用错误或遗漏,输出简短评语 + 是否掌握迁移能力的判断。」

### 6.5 情境化方法论引导(方法论类,通过后)

「用户已掌握本块的观点/框架。请引导 2–3 轮:①问用户当下情境中哪个具体问题可以用它;②追问框架各要素如何映射到该问题;③请用户写出一段『我的版本』——结合情境改写后的个人方法论。最后将用户的『我的版本』整理为 markdown 片段输出(标注来源块),app 追加到 _methodology.md。」

### 6.6 脉络梳理与观点讨论(人文类)

复述轮:学生扮演侧重「这件事为什么会发生」「A 和 B 之间是什么关系」的因果与时间线追问,不考名词定义。
讨论轮(通过后):「提出一个与本块叙事相关的对立视角或争议(史学争论、不同学派解读),邀请用户写下自己的看法;不评判立场,只评估其论证是否用到了本块史实。输出用户思考的整理稿(归档为思考笔记)。」

### 6.7 间隔复习快问

「针对该块与其历史薄弱点,出 1–2 个快问(3 分钟内可答),优先考曾经的薄弱点。用户作答后输出 JSON:{passed: bool, comment, new_weak_point?}。」

### 6.8 整书终评

「基于 _map.md 全图与各块状态:①请用户先讲出全书框架(学生扮演式追问 2–3 轮);②出 2–3 道跨章节综合题(按书籍类型:综合应用/整合方法论/贯通脉络论述);③输出学习报告 markdown:总体掌握度、最强/最弱模块、薄弱点修复历程、建议重读章节。」

## 7. EPUB 处理

### 7.1 渲染
- epub.js `rendition` 分页/滚动双模式;主题注入自定义 CSS(覆盖出版方样式的可选开关)。
- 中文排版:字体栈 `Songti SC / PingFang SC / 霞鹜文楷(内置可选)`,版心 max-width 38em,行高 1.8,两端对齐 + `text-autospace`,亮/暗/纸质三主题。

### 7.2 知识块锚定
- 地图生成时 AI 给 `source_sections`(章节 href + 小节标题文本);app 在该章 DOM 中查找标题节点,生成起止 CFI(块首=该小节标题,块尾=下一小节标题前);跨章块存多段 CFI 范围数组。
- 标题匹配失败时回退为整章范围,并在地图页标记"锚点粗略"供手动校正(阅读器内选区→"设为块起点/终点")。
- 用户合并块 → CFI 范围数组合并;拆分块 → 进入阅读器选区指定分界点。
- 学习模式高亮用 epub.js annotations API 对块范围加下划线色层。

### 7.3 文本抽取
- 导入时逐 spine 抽取纯文本(DOM textContent,保留标题层级)缓存进 SQLite,供 prompt 注入与全文搜索,避免每次调用重新解析。

## 8. 语音链路

- 采集:webview `MediaRecorder`(16kHz wav)→ Tauri command 传 Rust。
- 转写:whisper-rs + `ggml-large-v3-turbo` 量化模型(约 600MB,中文效果好;设置页可选 small 型号);首次使用引导下载到 models/。
- 交互:按住说话/点击起止 → 转写结果填入输入框可编辑后发送(不直接发送,防转写错误污染评估)。
- TTS 预留:`trait TtsProvider { fn speak(&self, text) }`,V1 不实现;将来可接 macOS `say`/AVSpeechSynthesizer 或本地模型。

## 9. Obsidian 导出

- 设置 vault 目标文件夹;导出结构:
```
<vault>/book-learner/<书名>/
├─ 00-学习报告.md
├─ 01-我的方法论.md        (方法论书)
├─ blocks/<n>-<块名>.md    (复述终稿+薄弱点演变,含 frontmatter)
└─ notes/思考笔记-<块名>.md (人文书)
```
- frontmatter:`book / block / status / scores / passed_at / tags: [book-learner, <书名>]`;增量重导按文件覆盖。

## 10. 通知与番茄钟

- tauri-plugin-notification 发系统通知;提醒调度由常驻 tray 进程的定时器驱动(app 需开机自启可选项)。
- 番茄钟状态机在 Rust 侧(防止 webview 休眠漂移),tray 标题显示倒计时;结束通知 + 前端事件。
