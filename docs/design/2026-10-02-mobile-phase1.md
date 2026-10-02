# 攻书上手机 · 第一阶段设计:Mac 为主的网页版

日期:2026-10-02 · 状态:待实现 · 台账:BL-032(第一阶段) · 终局:iOS 原生 app(第三阶段)

## 0. 结论先行

- **架构定调:Mac 为主、手机为辅。** Mac 上的攻书是唯一的数据与 AI 源;手机是它的另一块屏幕。这个定调贯穿三个阶段,第一阶段做出来的 Mac 端 HTTP 服务与手机布局,到原生 app 阶段分别变成同步端点 / AI 中转与现成界面。
- 第一阶段交付:**iPhone 上用 Safari「添加到主屏幕」的攻书**,功能与 Mac 等价(含费曼、问书、脉络图、语音),数据天然一致(只有一份)。
- 不做:离线、跨设备同步引擎、iOS 构建、App Store。这些是第三阶段的事。

## 1. 目标与非目标

**目标**
1. 手机上能完成主链路:看今日队列 → 阅读(翻页、划选高亮、问书、脉络图)→ 费曼讲授(含语音)→ 评估判定;书架、地图、统计、设置可用。
2. 一份数据:手机与 Mac 看到的永远是同一个 SQLite,无需同步。
3. 在外也能用:经 Tailscale 访问家里/办公室的 Mac。
4. 为第三阶段铺路:手机布局与 HTTP 服务都是原生 app 要复用的部件。

**非目标**
- 离线使用、跨设备同步、冲突合并(第三阶段)。
- iOS/Android 构建、签名、分发(第三阶段;Apple 开发者账号第一阶段不需要)。
- 多用户、公网匿名访问、账号系统:仍是单用户私有工具。
- 平板专门布局:iPad 走桌面布局即可。

## 2. 总体架构

```
iPhone Safari / 主屏幕 PWA
   │  HTTPS(Tailscale serve 代理,自带证书)
   ▼
Mac · 攻书壳层内置 HTTP 服务(127.0.0.1:<port>)
   ├─ POST /api/<command>      → commands::<command>_inner(&AppState, …)   ← 与 Tauri IPC 同一命令层
   ├─ GET  /files/<name>       → <data_root>/books/ 里的 EPUB 与封面
   ├─ GET  /events             → SSE:pomodoro_changed / map_job_progress
   └─ GET  /                   → 前端静态文件(Tauri 打包进二进制的同一份 dist)
   ▼
SQLite · 记忆库 · codex CLI · whisper(全部仍在 Mac 上)
```

前端只多一种 `Backend` 实现;页面代码不感知自己跑在 Mac 壳层里还是手机浏览器里。

## 3. Mac 端 HTTP 服务(壳层)

### 3.1 启用与暴露
- 设置页新分区「手机访问」:开关、端口(默认 7340)、访问令牌(32 字节随机,只显示一次,可「重新生成」)、访问地址与二维码(内容 = `https://<主机名>/#token=<令牌>`,扫一下就配好)。
- **只绑定 127.0.0.1。** 对外暴露交给 Tailscale:`tailscale serve --bg --https=443 http://127.0.0.1:7340`(一次性命令,文档写进设置页说明),得到 `https://<mac>.<tailnet>.ts.net`,证书由 Tailscale 签发、随处可达、不走公网。
- 可选「局域网模式」(绑定 0.0.0.0):没有 Tailscale 时用,但 Safari 在 http:// 下不给麦克风,语音不可用;设置页明示。
- 服务随 app 启动(开关为开时),随 app 退出;Mac 休眠即不可达(设置页提示"合盖/休眠时手机不可用;可在能耗设置里关闭'显示器关闭时自动睡眠'")。

### 3.2 路由
| 路由 | 语义 |
|---|---|
| `POST /api/<command>` | 体为 JSON 对象,键与契约 `payloadKeys` 一致(camelCase);原始体命令(`library_import_epub_chunk`、`voice_transcribe`)体为 `application/octet-stream`,元数据走与 IPC 同名的头(`x-op-id`、`x-chunk-index`、`x-bl-lang`、`x-bl-hint`)。成功 → 200 + 命令返回值 JSON(unit 返回 `null`);失败 → 4xx/5xx + `IpcError` 的序列化(`{code,message,retryable,details}`),前端 `normalizeInvokeError` 原样可用 |
| `GET /files/<basename>` | 只服务 `<data_root>/books/` 直接子文件(`<id>.epub`、`<id>.cover.<ext>`),拒绝路径分隔符;`Content-Type` 按扩展名;支持 `Range`(epub.js 用整文件,阅读器大书 100 MB 也只拉一次) |
| `GET /events` | SSE;事件名与 Tauri 一致(`pomodoro_changed`、`map_job_progress`),数据为同一 JSON;壳层在现有 `app.emit` 的三处旁边同时推到一个 `tokio::sync::broadcast`;心跳 15 s |
| `GET /`、`/assets/*`、`/manifest.webmanifest` | 用 `app.asset_resolver()` 返回打包进二进制的前端文件(与窗口里加载的是同一份),未命中回落到 `index.html`(SPA 路由) |
| `GET /api/ping` | 无需令牌,返回版本与 `gitSha`,配对页用来探活 |

### 3.3 命令调度
- 新文件 `web/src-tauri/src/http/dispatch.rs`:`dispatch(state, command, body, headers) -> Result<Value, IpcError>`,**每条契约命令一个 match 臂**,把 JSON 平铺参数反序列化成对应类型后调用既有的 `commands::<name>_inner`(与 Tauri 命令包装器完全相同的入口,`run_command` 日志、错误映射一字不改)。
- 带 `AppHandle` 的命令(问书结束/提炼、微信读书同步后的投影重放、地图作业进度事件)在 HTTP 层同样拿 `AppHandle` 调用,行为一致。
- **防遗漏测试**:foundation 新增一条用例,循环 `shared/tauri-wire-contract.json` 的每条命令,用与 IPC 循环相同的样例载荷打 `dispatch`,任一命令缺臂即失败(与现有"契约 ⇄ WIRE_COMMANDS"断言同级)。
- 不走 HTTP 的命令:`automation_report`(调试桥)、菜单相关(`menu_action` 只是事件);`app_reveal_logs`、`export_reveal`、`weread_open_key_page` 这类"在 Mac 上打开 Finder/浏览器"的命令照常执行(效果发生在 Mac 上),前端在手机模式下隐藏这些按钮。

### 3.4 安全
- 每个 `/api` 与 `/files` 请求校验 `Authorization: Bearer <令牌>`;常量时间比较;失败 401 且不记录令牌。
- 令牌存 `<data_root>/mobile-token`(0600),不进 SQLite(快照里不带);重新生成即旧令牌全部失效(手机需重新扫码)。
- 不做 CORS 放行(前端与 API 同源);`/events` 的令牌走查询参数(EventSource 不能带头)——只在 HTTPS 下可接受,局域网 http 模式下同样提示。
- 速率:不限;单用户工具。日志里 HTTP 请求与 IPC 命令同一格式(`command=… outcome=… via=http`)。

### 3.5 依赖与并发
- `axum`(tokio 已随 tauri 在依赖图里;hyper/tower 亦然),在 `tauri::async_runtime` 上 `spawn`。
- 命令层共享连接本来就是互斥的;长命令(费曼回合、评估、地图作业 30–300 s)在 HTTP 层不设超时,反代(Tailscale serve)默认超时足够,写进验证清单。
- Mac 窗口与手机同时操作同一数据:允许;各自界面的本地状态可能滞后(例如阅读器标记首载后本地维护),切页或刷新即最新。写进 PRODUCT_SPEC。

## 4. 前端

### 4.1 `HttpBackend`
- 不新写一套:`TauriBackend` 已可注入 `invoke / convertFileSrc / listen`,`HttpBackend = new TauriBackend(httpInvoke, { convertFileSrc: path => '/files/' + basename(path), listen: sseListen })`。所有解码/出站校验/错误归一与壳层内完全相同,契约测试只需多跑一遍 HTTP 变体。
- `httpInvoke(command, payload, options)`:JSON → `fetch('/api/'+command, {method:'POST', body, headers:{Authorization}})`;`Uint8Array` 载荷 → `application/octet-stream` + `options.headers`;非 2xx → 抛出响应体(契约拒绝对象)。
- `sseListen(event, handler)`:进程内单个 `EventSource('/events?token=…')`,按事件名分发;断线自动重连(EventSource 原生)。
- 运行时选择(`backend/index.ts`):有 `__TAURI_INTERNALS__` → Tauri;否则 `location.origin` 下 `/api/ping` 可达 → Http;否则(vite dev / 测试)→ Mock。构建时不需要区分产物:同一份 dist 既被壳层窗口加载也被 HTTP 服务分发。

### 4.2 配对与会话
- 首次打开 `https://…/#token=…`:取出令牌存 `localStorage`(`bookLearner.mobileToken`),清掉 URL 片段;无令牌或 401 → 「配对」页(输入令牌 / 提示在 Mac 设置页扫码)。
- 令牌只在手机浏览器本地;「重新生成」后手机回到配对页。

### 4.3 PWA 外壳
- `manifest.webmanifest`:名称「攻书」、`display: standalone`、`theme_color/background_color` 取令牌纸色、图标(1024/512/192,由现有 favicon 导出 PNG)。
- `index.html`:`viewport-fit=cover`、`apple-mobile-web-app-capable`、`apple-mobile-web-app-status-bar-style=default`、`apple-touch-icon`。
- **不做 Service Worker**:第一阶段没有离线,避免缓存住旧版本;每次打开都拉最新 dist(文件带 hash,体积小)。
- 高度用 `100dvh`,底部用 `env(safe-area-inset-bottom)`;iOS 键盘弹起时 `visualViewport` 驱动输入区贴底。

### 4.4 手机布局(视口 ≤ 767 px = 手机模式;其余沿用桌面)
| 区域 | 桌面 | 手机 |
|---|---|---|
| 外壳 | 左侧栏 240 px + 52 px 工具栏带(拖动区) | 侧栏隐藏;底部标签栏 5 项(今日 / 书架 / 地图 / 统计 / 设置,54 px + 安全区);工具栏带 44 px,不再是拖动区;日/夜切换进设置 |
| 今日 | 任务卡 + 番茄钟胶囊 | 单列任务卡;番茄钟胶囊收成一行,点开 sheet 控制 |
| 书架 | 栅格 4–5 列 + 右键菜单 | 栅格 3 列;「更多操作」只保留按钮;微信读书分区同;导入向导全屏 sheet(文件选择走 Safari 文件选择器) |
| 阅读器 | 正文 + 右栏(学习模式/问书/脉络图)+ 浮层 | 正文全屏单页;右栏改**底部抽屉**(半开 40% / 全开 90%,可拖);工具栏只留 返回 · 标题 · 「…」(目录/书签/标记/阅读设置/抽屉);左右 1/3 点按翻页(`pointerLayer` 已有);划选用系统选区(触摸长按)→ 浮条贴选区上方;阅读设置浮层改 sheet;翻页圆钮隐藏 |
| 费曼 | 左原文参考 + 中对话 + 右脉络图 | 顶部分段「对话 / 原文 / 脉络图」三选一占满;输入区贴底随键盘;评估卡与附加环节全屏 sheet;语音钮同桌面(需 HTTPS) |
| 地图 | 模块卡 + 行内图标钮 | 单列;编辑态动作收进行尾「…」菜单(复审里本就建议) |
| 统计 | 瓦片 2/4 列 | 瓦片 2 列,图表全宽,触摸点柱子显示数值 |
| 设置 | 左列分区导航 + 右侧分组 | 分区导航变顶部横向滚动药丸;分组列表单列;「手机访问」分区在手机上只显示状态与「重新配对」 |
| 对话框 / 菜单 | 居中对话框、锚定菜单 | 贴底 sheet / action sheet;长按 = 右键;最小触控 44 pt;无 hover 依赖,Tooltip 不出 |

实现方式:Tailwind `max-md:` 变体 + 已有容器查询;抽屉与 sheet 作为新原语(`BottomSheet`),复用 `Dialog` 的焦点陷阱与 `data-modal-open` 语义(阅读器"弹窗开着不翻页"照常成立)。被测试钉住的可访问名、`data-testid`、`reader-column` 等全部不动;新增的手机模式用例用 390 × 844 视口跑。

## 5. 契约与设置
- 现有命令**一条不改**。
- 新增(六处同步):`mobile_server_status() → {enabled, port, bind, url, tokenSet}`、`mobile_server_set({enabled, port, bind})`、`mobile_server_rotate_token() → {token, url}`(令牌只在这次返回里出现一次)。
- 设置项进 `app_settings`(enabled/port/bind);令牌在文件。

## 6. 里程碑(约两周,每个独立分支 → PR)
1. **M1 壳层 HTTP 服务 + 调度 + 契约循环测试**(3 天):axum 服务、`dispatch`、`/files`、`/events`、静态文件、令牌、三条设置命令。Mac 真机:curl 过一遍契约。
2. **M2 `HttpBackend` + 运行时选择 + 配对页 + PWA 外壳**(2 天):同一份 dist 在 Safari 里跑通桌面布局;语音在 Tailscale HTTPS 下能录。
3. **M3 外壳与底部标签栏 + 今日/书架/设置手机布局**(2 天)。
4. **M4 阅读器手机布局**(3 天):底部抽屉、触摸划选、翻页、阅读设置 sheet;真机验证 BL-006/009/011 那套触摸行为。
5. **M5 费曼/地图/统计手机布局 + 真机走完主链路**(2 天)。
6. **M6 文档、门禁、发版**(1 天):PRODUCT_SPEC §3.9「手机访问」、CODE_MAP、TEST_PLAN 手机清单、CHANGELOG。

## 7. 验证
- 壳层:foundation 契约循环 HTTP 版(每条命令一臂);`/files` 路径穿越拒绝;401/令牌轮换;SSE 收到番茄钟与地图进度。
- 前端:`HttpBackend` 复用 `tauri.test` 的全部解码用例(注入 http invoke 的假实现);配对页三态;手机模式用例按页。
- headless:390 × 844 与 1280 × 800 两套截图(浅/深色),无横向溢出、底部安全区留白、键盘弹起输入区可见。
- 真机:iPhone Safari 经 Tailscale 走完 导入 → 地图 → 阅读(翻页/划选/问书/脉络图)→ 费曼(含语音)→ 评估 → 统计;Mac 与手机同时开着互不干扰。

## 8. 风险与应对
| 风险 | 应对 |
|---|---|
| Safari 在 http:// 下不给麦克风、PWA 行为受限 | 默认走 Tailscale HTTPS;局域网模式明示"语音不可用" |
| Mac 休眠 / 关机即不可用 | 设置页提示能耗设置;第三阶段的离线子集才真正解决 |
| epub.js 触摸选区与翻页点按冲突 | 手机模式用系统长按选区,点按翻页只认位移 ≤ 4 px 的 tap;真机门禁 |
| 费曼/地图作业长请求经反代超时 | Tailscale serve 无固定超时;局域网模式直连;前端已有"同 id 重试续跑" |
| 同一数据两端同时改 | 命令层本就串行;界面本地状态滞后靠刷新;写进 PRODUCT_SPEC |
| 调度器臂与契约脱节 | 契约循环测试硬性保证 |

## 9. 与后续阶段的衔接
- 第二阶段(用两周,记录手机上真正用的功能)决定第三阶段的离线子集。
- 第三阶段原生 app:本地 SQLite 存离线子集,与 Mac 同步;AI 走本阶段的 HTTP 服务中转。**从本阶段起所有写操作仍只经命令层**,给未来的事件日志留唯一入口;本阶段不写事件日志。
- Apple 开发者账号(99 美元/年)在第三阶段开工前办好即可。

## 10. 实现落点(回填)
待 M1–M6 各 PR 回填。
