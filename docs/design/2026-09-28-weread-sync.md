# 微信读书打通(WeRead 同步)设计

日期:2026-09-28 · 状态:第一批实现中 · 台账:BL-030

## 1. 目标与非目标

**目标**:把用户在微信读书里的书架、阅读进度、阅读时长、划线与想法,单向同步进攻书,并与本地 EPUB 关联起来,让攻书成为"读书数据的汇总处":

- 书架页能看到微信读书里在读的书、进度与时长;能与本地 EPUB 关联(自动匹配 + 手动关联)。
- 统计页的阅读时长能把微信读书的时长并进来看(分序列,不混口径)。
- 划线与想法进到对应本地书的高亮里(第二批)。

**非目标(明确不做)**:

- 书的正文。微信读书的书有 DRM,官方接口不给正文,永远不会以 EPUB 形式进攻书;要在攻书里读,仍需用户自己的 EPUB。
- 书签。官方接口 `/book/bookmarklist` 过滤掉了书签(type=0),`/user/notebooks` 只给数量。
- 反向写回。没有写接口,攻书的进度/高亮/时长推不回微信读书。
- 有声书(专辑)、文章收藏、热门划线、公开点评、推荐:第一批只在设置页显示专辑条数,不导入。
- 封面图:网关返回的是外链 URL,第一批不加载(CSP 与离线考虑),沿用书架"首字 + 书脊色条"的签名。

## 2. 官方接口事实(2026-09-28 核实)

微信读书 2026-05-17 开放了官方「Skills / Agent API」:仓库 [Tencent/WeChatReading](https://github.com/Tencent/WeChatReading)(Apache-2.0,当前 skill 版本 1.0.4)。不再需要 cookie 抓网页版私有接口。

- **Key**:用户在 https://weread.qq.com/r/weread-skills 扫码登录后生成,绑定账号,格式 `wrk-xxxxxxxx`;同页可管理/撤销。
- **网关**:`POST https://i.weread.qq.com/api/agent/gateway`,`Authorization: Bearer <key>`,`Content-Type: application/json`。
- **请求**:JSON,`api_name` 指定接口,业务参数**平铺在顶层**(不能包在 `params` 里),**每次必须带 `skill_version`**。
- **响应**:JSON,字段裁剪;`errcode` 非 0 表示错误(`errmsg` 中文提示);出现 `upgrade_info` 表示 skill 需升级,应提示用户、不得忽略;`{"api_name":"/_list"}` 列出所有接口。HTTP 非 2xx 视为失败(401/403 视为 Key 失效)。
- **未写明**:限频、Key 有效期、第三方桌面 app 的使用条款。策略:调用保守(串行、间隔 ≥ 100 ms、单次同步进度查询 ≤ 60 本)、错误直显、`upgrade_info` 直显。

第一批用到的接口:

| 接口 | 参数 | 用到的字段 | 坑 |
|---|---|---|---|
| `/shelf/sync` | 无 | `books[]{bookId,title,author,cover,category,readUpdateTime,finishReading,updateTime,isTop,secret}`、`albums[]`(只计数)、`mp`(只计数)、`archive[]`(书单,不用) | 书架总数 = books + albums + (mp?1:0);`books[]` 含导入书/公众号书 |
| `/book/getprogress` | `bookId` | `book.progress`(0–100 整数,1 = 1%)、`book.recordReadingTime`(累计**秒**)、`book.updateTime`、`book.finishTime`(仅读完)、`book.chapterUid/chapterOffset` | 导入书/下架书可能报错(社区工具见 499),要按本跳过、不中断 |
| `/readdata/detail` | `mode`=weekly/monthly/annually/overall、`baseTime`(0 = 当前周期;历史周期传该周期内任一时间戳,服务端归一到周一/月初/年初) | `totalReadTime`(秒)、`readDays`、`readTimes{分桶起始时间戳: 秒}`(weekly/monthly 按天、annually 按月、overall 按年)、`dailyReadTimes`(annually 可能返回的逐日)、`readLongest[]{book,readTime}` | 所有时长都是**秒**;`readTimes` 只作明细,总量用 `totalReadTime` |
| `/book/bookmarklist` | `bookId` | `updated[]{bookmarkId,chapterUid,markText,range,colorStyle,type,createTime}`、`chapters[]{chapterUid,chapterIdx,title}` | 第二批;`range` 是微信读书章节文本的字符偏移,不是 CFI |
| `/review/list/mine` | `bookid`(小写)、`synckey`、`count` | `reviews[].review{reviewId,content,abstract,range,chapterUid,chapterIdx,createTime,star,chapterName}`、`hasMore`、`synckey` | 第二批;`abstract`/`range` 只有划线想法才有 |

## 3. 数据模型(schema v12,只加不改)

```
weread_account   -- 单行 id=1
  id INTEGER PRIMARY KEY CHECK(id=1)
  api_key TEXT NOT NULL
  connected_at TEXT NOT NULL          -- ISO
  auto_sync INTEGER NOT NULL DEFAULT 1
  last_sync_at TEXT                   -- 最近一次尝试
  last_sync_ok INTEGER                -- 1/0/NULL(没跑过)
  last_error TEXT                     -- 最近失败原因(中文)
  upgrade_message TEXT                -- 网关 upgrade_info.message
  album_count INTEGER NOT NULL DEFAULT 0
  mp_count INTEGER NOT NULL DEFAULT 0
  total_seconds INTEGER NOT NULL DEFAULT 0   -- overall.totalReadTime
  total_read_days INTEGER NOT NULL DEFAULT 0 -- overall.readDays

weread_book
  weread_id TEXT PRIMARY KEY
  title, author, cover_url, category TEXT NOT NULL DEFAULT ''
  finish_reading INTEGER NOT NULL DEFAULT 0
  read_update_time INTEGER NOT NULL DEFAULT 0   -- 秒级时间戳
  update_time INTEGER NOT NULL DEFAULT 0
  is_top INTEGER NOT NULL DEFAULT 0
  secret INTEGER NOT NULL DEFAULT 0
  progress INTEGER NOT NULL DEFAULT 0           -- 0–100
  reading_seconds INTEGER NOT NULL DEFAULT 0    -- recordReadingTime
  progress_fetched_for INTEGER NOT NULL DEFAULT -1  -- 上次拉进度时的 read_update_time(变了才重拉)
  local_book_id INTEGER REFERENCES book(id) ON DELETE SET NULL
  link_source TEXT NOT NULL DEFAULT 'none'      -- none | auto | manual
  removed INTEGER NOT NULL DEFAULT 0            -- 从书架消失(保留记录)
  first_seen_at, last_seen_at TEXT NOT NULL

weread_reading_day
  date TEXT PRIMARY KEY                          -- YYYY-MM-DD(本地日)
  seconds INTEGER NOT NULL
  fetched_at TEXT NOT NULL
```

决定:
- API Key 存在 SQLite(`weread_account.api_key`)。单用户本机 app,数据目录已受系统保护;快照/备份会带上 Key,文档注明;后续可迁 Keychain(需壳层新依赖,Linux 编不了,不在第一批)。
- 微信读书的时长**不写进** `reading_time`(本机计时口径),独立成表,统计页分序列展示。
- 第二批的划线/想法表(`weread_mark`、`weread_thought`)到时再加 v13,不预留空表。

## 4. 同步算法(`core::weread`)

`Gateway` trait(`call(api_name, params) -> Result<Value>`)+ `HttpGateway`(ureq,rustls)+ 测试用假网关。所有逻辑在 core,Linux 可测;壳层只是把 `HttpGateway` 装进去。

**connect(key)**:先用该 key 调一次 `/shelf/sync`,成功才写 `weread_account`,随后跑一次完整 `sync`。失败(401/403/errcode)不落任何东西,错误原样返回。

**sync()**(进程内互斥,已在跑则返回"同步中"):
1. `/shelf/sync` → `books[]` 逐本 upsert `weread_book`(标题/作者/时间等字段覆盖,`link_source`/`local_book_id` 不动);本次没出现的标 `removed=1`,重新出现清零;`albums.length`、`mp?1:0` 写 account。
2. 进度:对 `removed=0` 且 `read_update_time != progress_fetched_for` 的书,按 `read_update_time` 降序逐本 `/book/getprogress`(≤ 60 本/次,间隔 100 ms);单本失败跳过、记入本次错误摘要,不中断。
3. 时长:`/readdata/detail mode=overall` → `total_seconds/total_read_days`;`mode=monthly baseTime=0` → `readTimes` 逐日 upsert `weread_reading_day`;**首次同步**再补拉过去 11 个自然月(`baseTime` 取该月 1 日时间戳);之后每次只拉本月,且每月 1–3 日额外拉上月一次(补服务端晚到的数据)。`readTimes` 的 key 是分桶起始时间戳(秒),按本地时区转成日期。
4. 自动匹配:对 `link_source='none'` 的书,在本地 `book` 里找唯一候选:`norm(title)` 相等,或一方包含另一方且较短者 ≥ 4 字并且 `norm(author)` 相等/包含;`norm` = NFKC → 去空白与标点(含全角)→ 小写。唯一命中才写 `auto`;多候选不写(留给用户)。`manual` 永不被自动覆盖。
5. 写 account:`last_sync_at`、`last_sync_ok`、`last_error`(汇总:失败接口 + errmsg)、`upgrade_message`。

**disconnect(purge)**:删 `weread_account`;`purge=true` 同时清三张表。

**错误归类**:HTTP 401/403 或 errcode 表示鉴权失败 → `auth_failed`(设置页提示"重新获取 Key");网络/超时 → `network`;其余 → `gateway`。前端一律走现有 `AsyncError` 文案与重试。

## 5. 界面

- **设置 › 微信读书**(新分区,排在「数据」前):
  - 未连接:两行说明(去 https://weread.qq.com/r/weread-skills 扫码拿 Key;攻书只读取你自己的书架/进度/时长/笔记,不上传任何本机数据)+「打开获取页面」(壳层 `open` 该固定 URL)+ Key 密码框 +「连接并同步」。
  - 已连接:状态行「电子书 N 本 · 专辑 M · 上次同步 时间 · 成功/失败原因」、`upgrade_message` 警示、「立即同步」(忙态 Spinner)、「启动时自动同步」Toggle、「断开」(确认框:是否同时清除已同步数据)。
- **书架 › 微信读书**(本地栅格下方的新分区;未连接不渲染):每本卡 = 首字 + 书脊色签名、书名、作者、`进度%`、时长(x 小时 y 分)、「读完」Tag;右下「关联本地书…」→ `Select` 本地书(+「不关联」);已关联显示「已关联《x》」。本地书卡:有关联时卡底加一行「微信读书 · 65% · 3 小时 12 分」。分区标题右侧「同步」小钮。
- **统计 › 阅读时长**:四格保持本机口径;柱状图加第二序列「微信读书」(并列柱,图例两色);分区右上加一句「微信读书总计 x 小时 · 阅读 N 天」;读屏数据表加一列。未连接时一切如旧。
- **启动自动同步**:`App` 挂载 → `wereadStatus()`;已连接且 `auto_sync` 且 `last_sync_at` 早于 20 小时 → 后台 `wereadSync()`,失败只记在设置页,不弹提示。

## 6. 契约(六处同一提交)

| 命令 | 入参 | 回包 |
|---|---|---|
| `weread_status` | — | `WereadStatus`(`connected`、`autoSync`、`lastSyncAt`、`lastSyncOk`、`lastError`、`upgradeMessage`、`bookCount`、`albumCount`、`mpCount`、`totalSeconds`、`totalReadDays`、`syncing`) |
| `weread_connect` | `apiKey` | `WereadStatus`(验证 + 首次同步后) |
| `weread_sync` | — | `WereadStatus` |
| `weread_disconnect` | `purge: bool` | `void` |
| `weread_books` | — | `WereadBook[]`(`wereadId`、`title`、`author`、`category`、`finishReading`、`readUpdateTime`、`progress`、`readingSeconds`、`localBookId`、`linkSource`、`removed`) |
| `weread_link` | `wereadId`、`localBookId | null` | `WereadBook` |
| `weread_reading_days` | `from`、`to`(YYYY-MM-DD) | `{ days: [{date, seconds}] }` |
| `weread_open_key_page` | — | `void`(只打开固定 URL) |
| `app` 设置 `autoSync` | 走 `weread_set_auto_sync(enabled)` | `WereadStatus` |

Mock:内置 6 本演示书(2 本能自动匹配本地书)、30 天时长、`connect` 用 `wrk-` 前缀校验(否则 `auth_failed`)。

## 7. 分批

- **第一批(本 PR)**:schema v12、`core::weread`(网关客户端 + 同步 + 匹配)、上表命令、设置/书架/统计三处界面、启动自动同步、Mock、文档。
- **第二批**:划线/想法 → 对应本地书的高亮(用划线原文在本地 EPUB 对应章节做文本查找,epub.js `Section.find` 给出 CFI 区间;想法挂在高亮上),标记面板显示来源徽标;同步进记忆库 `_weread.md`(供 codex 上下文)与 Obsidian 导出。
- **第三批(可选)**:有声书条目、封面外链(CSP `img-src` 放行微信读书 CDN)、Key 迁 Keychain。

## 8. 风险与验证

- **真网关未验证**:实现按官方文档 + 社区 SDK(OpenWeRead)的请求/响应形状;第一批发版前必须用用户自己的 Key 在 Mac 上连一次,看真实回包(字段缺省、导入书 499、限频)。
- **接口可能变**:请求带 `skill_version`,`upgrade_info` 直显;解析一律容错(缺字段取默认,不因未知字段失败)。
- **验证手段**:core 单测(假网关 fixtures:书架 upsert/移除、进度按变化拉、时长分桶转日期与首次回补、自动匹配唯一性、鉴权失败不落 Key、单本失败不中断、upgrade_info);`HttpGateway` 对本地 TCP 假服务器验证请求头/体形状与 errcode 处理;web 单测(设置分区三态、书架分区与关联、统计双序列、启动自动同步只跑一次);headless 截图;Mac 真机 + 真 Key。

## 9. 实现落点(仓库)

见本文件末尾「落点清单」(实现时回填)。
