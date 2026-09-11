# 缺陷台账(测试阶段,2026-09-09 起)

状态:open → fixing → fixed(PR)→ verified(用户在新包上确认)→ closed;wontfix / duplicate 另注。
每条修复必须带回归用例(用例名含编号)与 DEVLOG 条目;发布批次见 `CHANGELOG.md`。

| 编号 | 级别 | 状态 | 页面 | 现象 | 根因 | 修复 | 回归用例 | 报告日 |
|---|---|---|---|---|---|---|---|---|
| BL-001 | P1 | fixed | 阅读器/费曼 | 「回读原文」只跳到章首、学习模式无块下划线、费曼注入整章原文 | 前端从未调用 `resolveBlockAnchors`/`setAnchorSegments`,原生锚点全为 `chapter_fallback`(CODE_MAP §4) | 导入向导在地图作业后回填锚点(`epub/anchorBlocks.ts`);已导入的书需删除重导才有精确锚点 | `anchorBlocks.test`、library.test「BL-001」 | 09-09(review 发现) |
| BL-002 | P2 | open | 地图 | 编辑态只有上下移/跳过/改模块名,没有删除、合并、拆分 | 前端未做 UI;core `confirm_map` 已支持 delete/merge/split ops | — | — | 09-09(review 发现) |
| BL-003 | P3 | open | 全局 | 夜读模式刷新/重开后失效 | `store.theme` 只在内存,未持久化 | — | — | 09-09(review 发现) |
| BL-004 | P0 | verified | 导入 | Finder 启动后导入报「AI 暂时没有回应」 | GUI 进程无 Homebrew PATH,codex(node 脚本)127 | PR #32 `ensure_gui_path` | foundation `augmented_path_*` | 09-08(用户) |
| BL-005 | P1 | verified | 书架 | 没有删除书的入口;导入失败的书无法清理 | 功能缺失(ADR-0004 已记) | PR #35 `library_delete_book` + 「导入未完成」徽标 | core `delete_book_*`、foundation `delete_book_*`、library.test ×2 | 09-09(用户) |
| BL-006 | P1 | fixed | 阅读器 | 用户口述(09-09 17:4x):"在阅读器里用鼠标在正文里选中一段文字,松开后,没有小工具条出现" | WKWebView 里 epub.js 的正文 iframe 是 `sandbox="allow-same-origin"`(无脚本),其文档不派发 `selectionchange`,epub.js `selected` 永不触发(调试包实测 0 次) | `EpubView` 每 300 ms 轮询各 contents 的 `getSelection()`,用 `cfiFromRange` 算区间 CFI 上报(同一选区不重复) | reader.test「BL-006」 | 09-09(用户) |
| BL-007 | P2 | open | 阅读器 | 用户口述(09-09 18:5x):"高亮之后没有取消高亮的选项" | 现状:只能在顶栏「标记」面板里逐条删除;正文里点击已有高亮没有任何反应(epub.js 注解点击回调未接) | — | — | 09-09(用户) |
| BL-008 | P3 | open | 阅读器 | 用户口述(09-09 19:0x):"阅读界面可以设置成双页" | 建议:阅读器设置浮层加「单页/双页」(epub.js `spread: 'auto'/'none'`,现固定 `none`) | — | — | 09-09(用户) |
| BL-009 | P2 | open | 阅读器 | 用户口述(09-09 19:0x):"bug:鼠标点击不能左右翻页,只能通过键盘操作" | 待定位:顶栏有「‹ ›」按钮;用户预期点正文左右区域翻页——iframe 内的点击事件在 WKWebView 沙箱 iframe 里同样可能不派发(同 BL-006 根因),需实测;可在 iframe 上方叠透明点击区或用父文档 pointer 事件 | — | — | 09-09(用户) |
| BL-010 | P3 | open | 阅读器 | 用户口述(09-09 19:0x):"翻页可以加上翻书的那种显示特效,而不是干巴巴的翻页" | 建议:翻页过渡动画(CSS 位移/淡入,分页模式下可做;真实卷页特效成本高) | — | — | 09-09(用户) |
