# 阅读辅助对话「问书」与阅读记忆 — 设计

日期:2026-09-16 · 状态:待实现 · 触发:用户提出"读到不理解的段落时能和 AI 自由对话,并用这些对话塑造这本书的学习画像与记忆"。

## 1. 目标与范围

在阅读器右侧栏增加一个与「学习模式」并列的「问书」面板:用户把读不懂的段落带入(选中文字→「问 AI」,或复制粘贴),与 AI 自由问答,界面类似 ChatGPT。对话按书保存;话题结束时由 AI 提炼成结构化条目写进这本书的记忆文件 `_reading.md`,后续费曼对话、评估、复习快问与终评都读到它,追问与出题优先覆盖用户读书时问过、没懂的点。

四个已确认的决策:

| 决策点 | 结论 |
|---|---|
| 对话如何影响学习 | 只塑造"这本书的理解画像"(记忆条目);不直接生成薄弱点,不改计划 |
| AI 看到的上下文 | 用户带入的文字 + 当前章节全文(截断)+ 本话题近 8 轮 + 这本书已提炼的理解状态条目;书是上下文,回答靠 AI 自身知识 |
| 对话组织 | 一本书一条时间线,默认续聊(跨次打开阅读器也续,直到用户点「另起话题」);历史按话题回看,旧话题可续 |
| 提炼时机 | 一个话题攒到有新问答后提炼一次:「另起话题」时结束并提炼;离开阅读器时只提炼不结束;退出 app 不做事,下次启动补跑 |

不做:语音、图片、多书串聊、导出原始对话、从对话直接生成薄弱点、影响每日计划。

## 2. 架构落点

独立 core 模块 `reading_chat`(不复用费曼会话:费曼绑定块与任务、带评估语义;问书是书级别、多话题、无评估)。前端一个面板;壳层新增命令;记忆库写入一律经投影 outbox。与现有约定一致:每轮独立 `codex exec`、无状态;schema 只做加法;契约六处同步。

```
ReaderPage ──「问书」面板(ReadingChatPanel)
   │  backend.readingSend / readingTopics / readingTopicEnd …
   ▼
壳层 commands(reading_*)→ core::reading_chat
   ├─ SQLite: reading_topic / reading_message
   ├─ ai.rs codex exec(问答 prompt / 提炼 prompt)
   └─ projection outbox: sync_reading(book) → memory::sync_reading → books/<slug>/_reading.md
prompts::FixedContext.reading_notes ← fixed_context_for_block(conn) 从 reading_topic.distilled_json 派生
```

## 3. 数据与记忆

### 3.1 表(只加不改;迁移 v9,`SCHEMA_VERSION` 8→9,`db.rs` 里断言 `user_version` 的测试同步改)

```sql
CREATE TABLE reading_topic(
  id INTEGER PRIMARY KEY,
  book_id INTEGER NOT NULL REFERENCES book(id) ON DELETE CASCADE,
  started_at TEXT NOT NULL, ended_at TEXT,
  distilled_at TEXT, distilled_json TEXT, distilled_up_to INTEGER NOT NULL DEFAULT 0,
  anchor_href TEXT NOT NULL DEFAULT '', anchor_block_id INTEGER REFERENCES knowledge_block(id) ON DELETE SET NULL);
CREATE TABLE reading_message(
  id INTEGER PRIMARY KEY,
  topic_id INTEGER NOT NULL REFERENCES reading_topic(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('user','assistant')),
  text TEXT NOT NULL, quote TEXT NOT NULL DEFAULT '',
  spine_href TEXT NOT NULL DEFAULT '', block_id INTEGER REFERENCES knowledge_block(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'done' CHECK(status IN ('pending','done','failed')),
  client_msg_id TEXT, created_at TEXT NOT NULL);
CREATE UNIQUE INDEX reading_message_client ON reading_message(topic_id, client_msg_id) WHERE client_msg_id IS NOT NULL;
```

- `quote` 是用户带入的选文/贴文(上限 8000 字,前端截断并提示);`text` 上限 4000 字。`spine_href` 记发问时所在章节;`block_id` 由前端给:阅读器路由带着的 `blockId`,且当前 `spineHref` 属于该块锚点段(`map_list_anchors[blockId]` 已加载)的 href 之一时传该 id,否则传 null;不做全书范围的块查找。
- **话题生命周期**:`ended_at` 只由「另起话题」写入;"需要提炼" = 存在 assistant 消息且 `max(message.id) > distilled_up_to`。提炼成功写 `distilled_json`、`distilled_at`、`distilled_up_to = 当时的 max(message.id)`;无 assistant 消息的话题永远不提炼(`distilled_up_to` 保持 0 也不满足条件)。往旧话题(`ended_at` 非空)继续发消息不改 `ended_at`,只是新增消息,靠 `distilled_up_to` 触发再提炼。"续聊"的定义:`reading_send` 不带 `topicId` 时续该书 `ended_at` 为空的最新话题,没有则新建。
- 新话题的 `anchor_href`/`anchor_block_id` 取自它第一条用户消息的 `spineHref`/`blockId`。
- 删书:`library::delete_book` 顺带删两表(外键级联 + 显式删除,与现有删书路径一致);记忆库 `remove_book` 已删整个目录。

### 3.2 记忆文件 `books/<slug>/_reading.md`

由投影生成,固定三节,app 程序化合并:

```
# 《书名》阅读对话记忆

## 关注点
- [2026-09-16] 第 3 章 · 需求弹性(块 #5):问弹性和斜率是不是一回事
- …

## 理解状态
- [2026-09-16] 块 #5 · 误解:把"斜率"当成"弹性"(表述里二者混用)
- [2026-09-16] 块 #5 · 已澄清:弹性是百分比变化之比,同一直线上各点不同
- …

## 表述与习惯
- 偏好先要一句话结论再看推导
- …(AI 观察,只增不删)
```

- 每条以 `[日期] ` 开头(日期 = 该话题的 `distilled_at`),块号取 `knowledge_block.id`,便于按块检索;章节/块标题由 `projection.rs` 从 `spine_item.title`/`knowledge_block.title` 解析好再传给 `memory::sync_reading`(与 `sync_map`/`sync_weakpoints` 传元组的方式一致);投影时以各话题最新的 `distilled_json` 为准整文件重生成(同一话题再提炼即覆盖旧结果),不做文本级 diff。
- `INDEX.md` 模板加一行:`_reading.md` 是用户读这本书时与 AI 的问答提炼(关注点、理解状态、表述习惯),费曼与评估前请读。已存在的记忆库在 `ensure_book` 时幂等追加这一行(缺才加)。

### 3.3 提炼结果落库与投影

提炼 JSON 原文存 `reading_topic.distilled_json`(SQLite 是真相源,ADR-0001)。投影 outbox 入队 `sync_reading`(payload `{"book_id"}`,op_id `reading:{book_id}:t{topic_id}:sync_reading`),`memory::sync_reading` 读该书全部 `distilled_json` 重生成 `_reading.md`(与 `sync_map`、`sync_weakpoints` 同一"整文件重生成"风格,天然幂等)。

## 4. AI 调用

### 4.1 问答(每条用户消息一次 `codex exec`)

系统提示(`prompts::reading_system`):阅读助手;用中文;先直接回答,再按需展开;不出题、不评估、不引导复述;引用书中原文时注明"书里说";不确定就说不确定。固定注入:

1. 书名、类型、当前章节标题、所在块标题(有则给)。
2. 当前章节全文(`spine_item.text`);超过 `READING_CHAPTER_MAX_CHARS`(6000)时,以用户带入文字在章节文本中的首次命中为中心截 `±3000` 字,命不中则取章首 6000 字,并注明"已截断"。
3. 用户带入的文字(`quote`)。
4. 这本书已提炼的「理解状态」条目(从各话题 `distilled_json` 派生,不读 md;最新 40 条)。
5. 本话题最近 8 轮(user/assistant 各算一轮)。

工作目录为记忆库根,提示语允许它自行阅读 `profile.md`。超时 `READING_TURN_TIMEOUT_SECS`=120(与 `TURN_TIMEOUT_SECS` 同级的模块常量);提炼 `READING_DISTILL_TIMEOUT_SECS`=120。

### 4.2 提炼(话题结束时一次)

`prompts::reading_distill_prompt`:输入话题内全部消息(含 quote、章节/块),要求只输出 JSON:

```json
{"focus":[{"blockId":5,"href":"ch3.xhtml","note":"问弹性和斜率是不是一回事"}],
 "understanding":[{"blockId":5,"kind":"misconception|unclear|clarified","note":"把斜率当成弹性"}],
 "habits":["偏好先要一句话结论"]}
```

- 只对"需要提炼"的话题跑(定义见 3.1);无 assistant 消息的话题不提炼。
- 触发:①「另起话题」(先写 `ended_at`,再提炼当前话题);②离开阅读器页面(组件卸载)时提炼当前话题但不结束它(默认续聊跨次打开);③app 启动时 `lib.rs::run_startup_recovery` 扫描全部需要提炼的话题补跑(覆盖"退出 app"场景——退出时不做任何提炼,`SHUTDOWN_GRACE` 10 s 装不下一次 codex 往返)。②③都在后台,不阻塞界面。
- 解析失败或 codex 失败:`distilled_up_to` 不变,仍满足"需要提炼",下次触发再跑;`ai_request` 记日志(request id `reading_distill:{topic_id}:m{max_message_id}`,确定性 id 让 codex 成功但落库失败时可按 ADR-0002 回放),界面不报错。
- 成功:写 `distilled_json`、`distilled_at`、`distilled_up_to`,入队 `sync_reading`。

### 4.3 反哺学习与评估

`prompts::FixedContext` 新增 `reading_notes: String`,在 `fixed_context_for_block(conn, …)` 里直接从 SQLite 派生(不解析 md,投影可能滞后):读该书各话题 `distilled_json` 的 `focus`/`understanding` 中 `blockId` 等于当前块的条目,按话题时间倒序取最新 10 条,格式化为 `- [日期] 关注:…` / `- [日期] 误解|未澄清|已澄清:…`;无则空串。现有六处 `FixedContext` 测试构造器(`prompts`、`session`、`verdict`、`projection`、`extra`、`final_exam`)与两处生产构造点(`session.rs`、`application/mod.rs` 终评分支)同步补该字段。注入点:费曼系统提示、评估 prompt、复习快问系统提示、附加环节系统提示;终评的画像摘要后追加该书理解状态条目最新 20 条(同样从 DB 派生)。提示语固定:"以下是用户读这块时的提问与困惑;追问和出题优先覆盖这些点,标为已澄清的不要再纠缠。" 为空时整段省略。

## 5. 契约(六处同步,一次提交)

| 命令 | payloadKeys | 返回 |
|---|---|---|
| `reading_topics` | `bookId` | `ReadingTopic[]`(id、startedAt、endedAt、needsDistill、distilledAt、anchorHref、firstQuestion 前 20 字);`needsDistill` 按 3.1 定义派生,状态点:无 assistant 消息不显示 / needsDistill=待整理 / 否则已记入记忆 |
| `reading_messages` | `topicId` | `ReadingMessage[]`(id、role、text、quote、spineHref、blockId、status、clientMsgId、createdAt) |
| `reading_send` | `bookId, topicId?, clientMsgId, text, quote, spineHref, blockId?` | `{ topicId, userMessage, assistantMessage: ReadingMessage \| null }`;`topicId` 缺省 = 续该书 `ended_at` 为空的最新话题,没有则新建;幂等按 `(topicId, clientMsgId)`。**AI 失败不是错误**:返回 `userMessage.status='failed'`、`assistantMessage=null`,错误码只留给校验/传输失败(not_found、invalid_request、db_unavailable) |
| `reading_topic_end` | `topicId` | `{ distilled: boolean }`(写 `ended_at`,再对需要提炼的跑提炼;第一批只写 `ended_at` 返回 false) |
| `reading_distill` | `topicId` | `{ distilled: boolean }`(不结束话题,只对"需要提炼"的跑;第一批返回 false) |

重试 = 用同一 `clientMsgId` 再调 `reading_send`(ADR-0002:重试即同 id 重发;`run_ai_request` 对 failed 行重跑),不单设 `reading_retry`;客户端从 `reading_messages` 拿回 text/quote 即可重发。

- `reading_send` 先落 user 消息(status pending),调 codex(`ai_request` id `reading:{topic_id}:{client_msg_id}`,`client_msg_id` 须过 `orchestrate::validate_client_id`),成功写 assistant 消息并把 user 置 done;失败置 failed,按上表返回成功载荷,气泡上显示「重试」。
- **取消**:只有"停止等待"没有真正的取消命令。前端点取消后不再等 `reading_send` 返回,该条显示"等待中";后端照常完成并落库;面板每 3 s 拉一次 `reading_messages` 直到该条变 done/failed(最多 2 分钟;到时仍 pending 就停止轮询,气泡保持"等待中"并给一个「刷新」按钮,窗口重新获得焦点时也再拉一次)。同一话题的发送在壳层串行(按 topicId 互斥),等待期间输入框禁用。
- **第一批**只让 `reading_topic_end` 写 `ended_at` 并返回 `{distilled:false}`(提炼在第二批接上),契约六处同步只做一次。
- 壳层 `commands/mod.rs::WIRE_COMMANDS`、`lib.rs::register_commands`、`tests/foundation.rs` payload、`contract.test.ts`、`tauri.test.ts::NATIVE_METHODS`、`shared/tauri-wire-contract.json`;`Backend` 接口、`TauriBackend`(含出站校验)、`MockBackend`(AI 回复用固定模板"关于「{quote 前 12 字}」:…")。
- 阅读器现有 `reader_position` 与锚点段接口不变。

## 6. 界面

- 右侧栏在正文就绪后总是渲染:没有任务(不带 `?task=`)时只有「问书」一个标签,默认展开;带任务时「学习模式」「问书」两个标签互斥切换,默认「学习模式」,学习模式面板切走时不卸载只隐藏。列宽与学习模式一致,不遮翻页。
- 面板结构:顶栏(当前话题起始章节 · 「历史」下拉 · 「另起话题」)→ 消息流(用户右、AI 左;AI 回复 Markdown 渲染;用户消息顶部以引用块显示 quote)→ 输入区(顶部可删的引用区 + 文本框;Enter 发送、Shift+Enter 换行;发送后显示"思考中…";「取消」= 停止等待(见 §5),该条转为"等待中",后端结果到了自动补上)。
- 「问 AI」:选区工具条新增按钮,把选文填进引用区并切到「问书」;`spineHref`/`blockId` 随之带上。
- 历史:下拉列出该书全部话题(起始时间 + 首问前 20 字),选中即加载;在旧话题上继续发送 = 续该话题。
- 提炼触发:「另起话题」调 `reading_topic_end`(结束 + 提炼);离开阅读器页面调 `reading_distill[topicId]`(只提炼不结束);app 退出不做事,启动时补跑。都在后台,不阻塞界面;话题旁显示状态点(已记入记忆 / 待整理 = 需要提炼)。
- 空状态文案:"选中正文里的一段文字点「问 AI」,或直接在这里贴一段话来问。"

## 7. 错误处理

| 场景 | 处理 |
|---|---|
| codex 超时/失败 | `reading_send` 返回成功载荷、用户消息 failed,气泡上「重试」(同 clientMsgId 重发);校验/传输错误才走 AsyncError |
| 章节文本缺失(导入未完成) | 仍可问,上下文只带 quote,提示"本章原文不可用" |
| 提炼失败 | 静默,话题待整理,下次补跑;`ai_request` 有日志 |
| 删书 | 话题、消息级联删除;记忆目录整删 |
| 多窗口/并发 | `reading_send` 幂等;同一话题串行(壳层按 topicId 互斥);提炼与发送互斥 |
| 贴入超长文本 | quote 8000 字、text 4000 字前端截断并提示(prompt argv 上限 100 KiB) |

## 8. 验证

- core 单测:话题建/续/结束;`reading_send` 幂等;截断规则;提炼 JSON 解析与空话题跳过;`_reading.md` 整文件重生成幂等;`reading_notes_for` 按块匹配与上限;删书级联。
- 契约:foundation wire 用例 5 条命令;contract.test / tauri.test 同步。
- web:面板组件测试(发送→思考中→回复;失败→重试;另起话题;历史切换;「问 AI」带入选文;Enter/Shift+Enter)。
- Mac 实测(真 codex):带入选文 → 两轮问答 → 另起话题 → `_reading.md` 出现三节条目 → 打开该块费曼对话,`ai_request` 日志里的系统提示含 reading_notes。
- 交付两批 PR:①core + 契约 + 面板(能聊、能存、能带入选文);②提炼投影 + 反哺注入 + 退出/卸载触发。每批门禁绿、Mac 实测后合并,用户说「换」再装。

## 9. 常量

`READING_CHAPTER_MAX_CHARS=6000`、`READING_QUOTE_WINDOW=3000`、`READING_HISTORY_TURNS=8`、`READING_STATE_MAX=40`、`READING_NOTES_PER_BLOCK=10`、`READING_FINAL_STATE_MAX=20`、`READING_TURN_TIMEOUT_SECS=120`、`READING_DISTILL_TIMEOUT_SECS=120`,放 `core` 常量;前端 `web/src/config.ts` 只放 `READING_QUOTE_MAX_CHARS=8000`、`READING_TEXT_MAX_CHARS=4000`、`READING_POLL_MS=3000`、`READING_POLL_MAX_MS=120000`。
