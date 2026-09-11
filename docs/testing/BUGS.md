# 缺陷台账(测试阶段,2026-09-09 起)

状态:open → fixing → fixed(PR)→ verified(用户在新包上确认)→ closed;wontfix / duplicate 另注。
每条修复必须带回归用例(用例名含编号)与 DEVLOG 条目;发布批次见 `CHANGELOG.md`。

| 编号 | 级别 | 状态 | 页面 | 现象 | 根因 | 修复 | 回归用例 | 报告日 |
|---|---|---|---|---|---|---|---|---|
| BL-001 | P1 | fixed | 阅读器/费曼 | 「回读原文」只跳到章首、学习模式无块下划线、费曼注入整章原文 | 前端从未调用 `resolveBlockAnchors`/`setAnchorSegments`,原生锚点全为 `chapter_fallback`(CODE_MAP §4) | 导入向导在地图作业后回填锚点(`epub/anchorBlocks.ts`);已导入的书需删除重导才有精确锚点 | `anchorBlocks.test`、library.test「BL-001」 | 09-09(review 发现) |
| BL-002 | P2 | fixed | 地图 | 编辑态只有上下移/跳过/改模块名,没有删除、合并、拆分 | 前端未做 UI;core 只有 merge,delete 没有、split 是占位报错 | PR #41:core `Delete`(只删未学且未进计划/无记录的块,删锚点、清他人 prereq 引用)+ `Split{title_a,title_b}`(原块改名、新块紧随其后、同模块/前置、复制锚点段);编辑态行内「并入上一块 / 拆分 / 删除」,删除与并入可撤销 | core `split_inserts_second_block_*`、`delete_removes_untouched_block_*`;map.test「BL-002」;contract.test delete/split;foundation DTO 形状 | 09-09(review 发现);09-11 修 |
| BL-003 | P3 | fixed | 全局 | 夜读模式刷新/重开后失效 | `store.theme` 只在内存,未持久化 | PR #41:`THEME_KEY`(localStorage)启动读回并打 `data-theme`,切换时写入 | store.test「BL-003」 | 09-09(review 发现);09-11 修 |
| BL-004 | P0 | verified | 导入 | Finder 启动后导入报「AI 暂时没有回应」 | GUI 进程无 Homebrew PATH,codex(node 脚本)127 | PR #32 `ensure_gui_path` | foundation `augmented_path_*` | 09-08(用户) |
| BL-005 | P1 | verified | 书架 | 没有删除书的入口;导入失败的书无法清理 | 功能缺失(ADR-0004 已记) | PR #35 `library_delete_book` + 「导入未完成」徽标 | core `delete_book_*`、foundation `delete_book_*`、library.test ×2 | 09-09(用户) |
| BL-006 | P1 | fixed | 阅读器 | 用户口述(09-09 17:4x):"在阅读器里用鼠标在正文里选中一段文字,松开后,没有小工具条出现" | WKWebView 里 epub.js 的正文 iframe 是 `sandbox="allow-same-origin"`(无脚本),其文档不派发 `selectionchange`,epub.js `selected` 永不触发(调试包实测 0 次) | `EpubView` 每 300 ms 轮询各 contents 的 `getSelection()`,用 `cfiFromRange` 算区间 CFI 上报(同一选区不重复) | reader.test「BL-006」 | 09-09(用户) |
| BL-007 | P2 | fixed | 阅读器 | 用户口述(09-09 18:5x):"高亮之后没有取消高亮的选项" | epub.js 注解 SVG 画在父文档,可收点击;`annotations.highlight` 传入点击回调 | 点击高亮 → 「高亮操作」条:四色换色(`readerMarkUpdate`)、取消高亮(`readerMarkRemove`) | reader.test「BL-007」 | 09-09(用户) |
| BL-008 | P3 | fixed | 阅读器 | 用户口述(09-09 19:0x):"阅读界面可以设置成双页" | 阅读设置固定 `spread: 'none'` | 阅读设置加「双页显示」(prefs.spread → `rendition.spread('auto'/'none')`;开启时正文容器放宽到 80em,epub.js 视口 ≥ 800px 才排双页) | reader.test「BL-008」 | 09-09(用户) |
| BL-009 | P2 | fixed | 阅读器 | 用户口述(09-09 19:0x):"bug:鼠标点击不能左右翻页,只能通过键盘操作" | 同 BL-006:正文 iframe 在 WKWebView 沙箱里收不到鼠标事件,点正文两侧无反应 | 父文档在正文左右各叠 48px 透明翻页区(悬停显渐变),点击即 prev/next;‹ › 按钮与键盘照旧 | reader.test「BL-009」 | 09-09(用户) |
| BL-010 | P3 | fixed | 阅读器 | 用户口述(09-09 19:0x):"翻页可以加上翻书的那种显示特效,而不是干巴巴的翻页";换包 21c2803 后口述(09-11 11:2x):"我要的是纸质书翻页的那种特效"——滑入不算 | 无过渡;PR #40 只做了滑入 | PR #41 返工:仿纸书两拍 3D 翻页——当前页绕书脊立起(200 ms,正文随之转动)→ 立到边缘换页(跨章最多等 400 ms)→ 纸背落向翻页方向(260 ms);立着时连点忽略;`prefers-reduced-motion` 直接换页。双页模式整跨翻转,未做单侧卷页(需页面快照,后续) | reader.test「BL-010」「BL-009」 | 09-09(用户);09-11 返工 |
