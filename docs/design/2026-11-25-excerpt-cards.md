# 书摘卡片设计

日期:2026-11-25 · 状态:实现中 · 台账:BL-034 · 视觉小样:https://claude.ai/artifact/MqyncEeqDULyjiS3AnkAoe

## 1. 目标与非目标

**用户原话(11-25)**:按照作家分类,把书里的好句好段整理成类似卡片的效果。导入书籍时先让 Agent 整理一遍,每本大约 50 句/段;之后我可以自己删减;阅读时也能把选中的句子、段落添加到对应作者的卡片库里。要美观、有审美。

**目标**

- 新页面「书摘」:按作者归类,作者下按书分组,每条书摘是一张卡片。
- 导入完成后自动在后台整理这本书的书摘(AI 挑约 50 条,书短则按篇幅减少);已有的书由用户在书摘页点「整理」才开始。
- 删减:删整张(可撤销),也能改卡片文字(如把长段裁短);改过的卡片标「已改」,可恢复原文。
- 阅读器选区工具条加「存为书摘」,存进这本书作者的卡片库,带章节与区间 CFI。
- 卡片上「在书中查看」:回到阅读器原处并短暂高亮那段文字。

**非目标(这一版不做)**

- 卡片导出成图片、分享;Obsidian 导出与记忆库投影(书摘只在 SQLite,快照照常备份)。
- 微信读书划线自动变书摘(划线已进本地高亮,用户可从阅读器手动存)。
- 个人批注/想法、收藏星标、按标签筛选页。

**用户确认的取舍(11-25 问答)**:卡片用「纸笺」风格;已有 4 本书点按钮再整理(不在升级后自动跑);删减 = 删整张 + 可改字。

## 2. 用户流程

1. **导入**:导入向导跑完知识地图后,前端调 `excerpt_generate(bookId, regenerate=false)` 入队,向导照常跳到地图页;后台线程逐本整理。
2. **已有的书**:书摘页空态显示「为 N 本书整理书摘」(N = 有正文、还没整理过的书);点了逐本入队。
3. **看进度**:书摘页每本书的分组头显示状态——排队中 / 正在读第 k/n 段 / 正在精选 / 没有完成(原因 + 重试);页面在有作业进行时每 4 秒查一次作业状态,某本完成就刷新卡片。
4. **删减**:卡片悬停出现 复制 · 在书中查看 · 编辑 · 删除;删除后底部提示「已删除 · 撤销」;编辑在对话框里改文字。手机上用卡片右上「⋯」动作单。
5. **阅读时存入**:选中文字 → 工具条「存为书摘」→ 提示「已存入「作者」的书摘 · 查看」;同一段文字重复存不会重复建卡(删过的会恢复)。
6. **重新整理**:书的「⋯」菜单 → 重新整理(确认框说明:AI 整理且没改过的卡片会被新一批替换;改过的、手动存的、删过的都不受影响,删过的不会再出现)。
7. **更正作者**:书的「⋯」菜单 → 更正作者(改 `book.author`,书架也跟着变);OPF 里没有作者的书(「待识别」)归在「未识别作者」组。

## 3. 数据(schema v14,只做加法)

```sql
CREATE TABLE excerpt(
  id INTEGER PRIMARY KEY,
  book_id INTEGER NOT NULL REFERENCES book(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK(source IN ('ai','user')),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','removed')),
  text TEXT NOT NULL,             -- 卡片显示的文字(可编辑)
  original_text TEXT NOT NULL,    -- 书中原文(定位、去重、恢复原文;不随编辑变)
  norm_key TEXT NOT NULL,         -- original_text 归一化键:去空白、全角转半角、引号统一
  tag TEXT NOT NULL DEFAULT '',   -- AI 给的 2–6 字主题标签
  spine_href TEXT NOT NULL DEFAULT '',
  chapter_title TEXT NOT NULL DEFAULT '',
  chapter_idx INTEGER NOT NULL DEFAULT -1,  -- spine 序(排序)
  char_offset INTEGER NOT NULL DEFAULT -1,  -- 章节正文里的字符位置(排序;未知为 -1)
  cfi TEXT,                       -- 阅读器划选的区间 CFI;AI 的为空,查看时现找
  edited INTEGER NOT NULL DEFAULT 0,
  run INTEGER NOT NULL DEFAULT 0, -- AI 第几轮整理产生(用户的为 0)
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX excerpt_book ON excerpt(book_id, status);
CREATE INDEX excerpt_norm ON excerpt(book_id, norm_key);
CREATE TABLE excerpt_job(
  book_id INTEGER PRIMARY KEY REFERENCES book(id) ON DELETE CASCADE,
  run INTEGER NOT NULL DEFAULT 1,
  stage TEXT NOT NULL CHECK(stage IN ('queued','reading','selecting','done','failed')),
  next_piece INTEGER NOT NULL DEFAULT 0,
  total_pieces INTEGER NOT NULL DEFAULT 0,
  target INTEGER NOT NULL DEFAULT 0,
  candidates_json TEXT NOT NULL DEFAULT '[]',
  added INTEGER NOT NULL DEFAULT 0,
  error TEXT, error_detail TEXT,
  queued_at TEXT NOT NULL, updated_at TEXT NOT NULL, finished_at TEXT);
```

- 删除是软删(`status='removed'`):撤销即改回;删过的 `norm_key` 是墓碑,重新整理与阅读器存入都以它去重。
- 删书时两表级联删除。
- 卡片排序:章节序 → 章内位置 → id;作者归类在前端做(见 §6.1),作者名以 `book.author` 为准。

## 4. AI 整理作业(core `excerpt.rs`)

两阶段,结构同知识地图作业(断点续跑、AI 调用全部幂等、调用期间不持事务):

1. **选章**:沿用脉络图的正文判定(剔封面、书名页、版权、目录、<200 字的页),另剔索引、参考文献、注释、译名对照。
2. **目标数**:`target = clamp(正文字数 / 2000, 12, 50)`。用户的书:鲍曼约 10 万字 → 50;亚隆约 50 万字 → 50。
3. **阶段 A(逐段读)**:正文章按段落切成 ≤ 80 KiB 的片(超长段落按字符硬切),每片一次 AI 调用,请求 id `excerpt:<book>:r<run>:p<k>`。每片最多要 `k = clamp(ceil(2 × target × 片字数 / 正文字数), 3, 15)` 条候选,要求逐字照抄同一自然段里的连续原文、句子 15–120 字、段落 ≤ 300 字,带 2–6 字标签 `tag`、一句理由 `why`、自评 `score`(1–5)。
4. **逐字校验**:候选在本章正文里按归一化文本查找(去空白、全角转半角、引号与破折号统一;找不到再去掉首尾标点重找),命中后**卡片文字取书中原文**(句末标点从原文补齐);找不到、含标题行(`#`)、少于 6 字或多于 400 字的丢弃;同章区间重叠或归一化键相同的去重。
5. **阶段 B(精选)**:全部候选(编号、章节、标签、原文,单条在 prompt 里截到 240 字;超出 prompt 上限时按自评分从低到高剔除)一次调用,请求 id `excerpt:<book>:r<run>:pick`,输出 `{"picks":[{"id","tag"}]}`。标准:质量第一、覆盖全书各章、意思相近只留一条、以好句为主穿插段落、统一标签用词。没有候选时跳过阶段 B,作业以 0 条完成。
6. **落库**(单事务):第 1 轮直接插入;重新整理(第 n>1 轮)先删掉本书 `source='ai' AND status='active' AND edited=0` 的卡片再插入;插入时跳过与现有卡片(含墓碑)`norm_key` 相同的。
7. **失败**:任一步失败 → `stage='failed'`,`error` 存给用户看的中文原因(超时 / 找不到 codex / AI 没有回应 / 输出无法解析),`error_detail` 存原始错误;「重试」= 同一轮续跑(已完成的片从 `ai_request` 重放,不再调 AI)。spine 变了(片数不同)则开新一轮。

超时:每次调用 300 s(同地图每章)。规模估算:每片 30–120 s,10 万字的书约 5 片 + 精选,约 5–10 分钟;50 万字约 20 片,约 20–40 分钟。

**入队语义 `enqueue(book, regenerate)`**:

| 现状 | regenerate=false | regenerate=true |
|---|---|---|
| 没有作业 | 新建 run=1,queued | 同左 |
| queued / reading / selecting | 原样返回 | conflict「正在整理」 |
| failed | 改回 queued(同一轮续跑) | run+1,从头 |
| done | 原样返回 | run+1,从头 |

书没有正文(`spine_item` 为空)→ invalid_request「这本书还没抽取正文,先完成导入」。

## 5. 后台线程与命令(壳层)

- **整理线程**`excerpt_worker.rs`:启动 15 s 后开始,循环取最早入队的未完成作业(`queued/reading/selecting`,所以上次退出时没跑完的会自动续跑),逐本跑完;没有作业时等唤醒或 60 s。命令入队后唤醒它。codex 找不到时把作业标失败(原因写清楚)。不登记慢命令计数,退出不等它(断点在库里)。
- **命令**(契约六处同一提交):

| 命令 | 载荷 | 返回 |
|---|---|---|
| `excerpt_library` | — | `{books: ExcerptBook[], excerpts: Excerpt[]}`(只含 active;每本书带计数、作业、`readerBlockId`) |
| `excerpt_jobs` | — | `ExcerptJob[]`(轮询用,轻量) |
| `excerpt_generate` | `bookId, regenerate` | `ExcerptJob`(入队并唤醒线程) |
| `excerpt_add` | `bookId, excerpt{text, spineHref, cfi}` | `{excerpt, created, author}`(章节标题与位置由 core 按 spine 补) |
| `excerpt_update` | `id, text` | `Excerpt`(`text=null` 表示恢复原文) |
| `excerpt_remove` | `id` | — |
| `excerpt_restore` | `id` | `Excerpt` |
| `library_set_author` | `bookId, author` | `Book` |

## 6. 界面

### 6.1 作者归类(前端 `features/excerpts/authors.ts`)

`book.author` 原样很乱(`(英)齐格蒙特·鲍曼`、`西格蒙德·弗洛伊德(Sigmund Freud)`、`待识别`)。归一:去掉开头的国别/朝代括注(记为注记「英」)、结尾括注(记为原名)、结尾的「著/编/译」等;多位作者取第一位;间隔号统一为「·」;拉丁字母小写比较。空或「待识别」→「未识别作者」组(排最后)。首字徽记取间隔号后最后一段的首字(鲍、弗、亚)。作者色 6 种(黛、青、赭、绛、苍、藕,令牌 `--author-1..6`),按归一键哈希取,只作装饰。

### 6.2 书摘页 `/excerpts`(侧栏在「书架」下面,手机标签栏同位)

- 桌面三栏:应用侧栏 | 作者栏(「全部」+ 各作者:徽记、名字、卡片数)| 内容(作者头:大徽记、宋体名、注记、「n 本书 · m 张卡片」;按书分组:小封面、书名、「AI 挑选 a · 我添加 u」、状态行、「⋯」菜单;卡片瀑布流)。
- 工具栏:标题「书摘」、搜索框(按文字/书名/章节/标签过滤当前视图)、有待整理的书时「为 N 本书整理」。
- 手机:作者栏变成顶部横滑徽记标签,卡片单列,动作走「⋯」动作单。
- 选中作者存 `bookLearner.excerptAuthor`。

### 6.3 卡片(纸笺)

暖白纸面 `bg-card`、1 px 分隔线边框、12 px 圆角、卡片阴影;左上一枚作者色大引号(透明度 .35);正文宋体,≤ 34 字的短句 19 px / 1.65,其余 15 px / 1.85,保留换行;底部虚线分隔的元信息行:「《书名》· 章节」+「我添加」/「已改」+ 作者色标签。悬停上浮 1 px、阴影加深,右上出现四个图标钮。

### 6.4 阅读器

- 选区工具条:「问 AI」后面加「存为书摘」。
- `/reader/:blockId` 通过路由 state `{reveal:{href,text,cfi}}` 打开:起始位置用 cfi(没有就用章节),渲染后定位并闪一下高亮(`bl-flash`,约 2.4 s);AI 卡片按原文在该章 `section.search` 找(全文 → 前缀回退,同微信读书划线定位),找不到就停在章节开头。查看引起的跳转不写阅读位置。
- 书没有知识块(没生成地图)时阅读器打不开,卡片的「在书中查看」禁用并说明。

## 7. 验证

- core:归一化/逐字查找、片与目标数、候选解析校验、作业全流程(Mock provider)、失败续跑不重调、重新整理替换规则、墓碑去重、阅读器存入(章节补全、去重、恢复)、入队语义、v14 迁移与级联。
- 壳层:wire 循环 8 条命令;入队唤醒不阻塞。
- 前端:作者归一单测;书摘页(归类、切换作者、搜索、删除撤销、编辑与恢复原文、空态一键整理、进度与失败重试);阅读器「存为书摘」;导入向导完成后入队;契约/解码测试。
- 真机:用户数据副本 + 调试版,真 codex 整理一本书(鲍曼),核对条数、逐字、覆盖与质量;Mac 上 Playwright 截图(桌面 1280 × 800、手机 390 × 844,日/夜)。
