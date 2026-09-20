# Design review: book-learner(攻书)— 三批改版后复审(2026-09-20,main 待合 `feat/ui-batch3-pages`)

审查工具:`apple-design` skill(HIG 122 页)。对照基线 `2026-09-20-hig-review-baseline.md`,逐条核对代码与 Mac 调试构建(第一、二批已真机实测;第三批以单测 + 代码核对为准,装机后补目视)。

### Summary

论点没有变:暖纸色 + 宋体标题的“书斋”,三任务色只标数据。三批之后,导航与控件全部走系统惯例(透明标题栏 + 侧栏材质、每页 52 px 工具栏带、菜单栏、对话框/浮层/菜单原语、分组内嵌列表),辨识度集中在字标/页标题/任务色条/反白墨色气泡四处。**总评:Good**——Critical 清零,基线的五个 High 全部关闭,余下均为 Medium/Low 打磨项。会被记住的一点仍是任务卡的 4 px 色条与宋体标题压在纸上,现在多了一个:反白墨色的“你说的话”。

### Critical

无。基线三项的关闭证据:
- 对比度:`label-3` #6b6150(5.4:1)、复习色 #8c5f12(5.0:1)、强调 #3b5aa6(5.8:1);`label-4` 仅装饰,`tokensPolicy.test` 棘轮 = 0。
- 对话框:`Dialog` 原语(焦点陷阱、Esc、还原、`data-modal-open`)覆盖 Confirm / 导入向导 / 导出 / 重排 / 目标设定 / 评估卡 / 附加环节;`Popover`/`Menu` 同样 Esc + 焦点回锚;阅读器 ←/→ 在模态与浮层内不翻页。
- 焦点环:`outline-none` 全部清除(设置画像区、脉络图详情 4 处改 `Input/Textarea`),全局 `:focus-visible` 2 px 环 + 输入框 3 px 强调环。

### Improvements

- **Medium · 悬停显现的动作**(阅读器翻页圆钮、地图编辑态行内钮):键盘可达(`focus-visible`/`focus-within` 显现),但首次使用者可能不知道悬停有动作。已在地图编辑态顶部给一行提示;阅读器另有点正文两侧与 ←/→ 两条路。
  - Why:`pointing-devices.md`(判断):hover 只作补充,不作唯一发现路径。
  - Fix(可选):地图行右侧常驻一个「⋯」更多菜单,收纳六个动作。
- **Medium · 工具栏里的标题用 `<h1>`**(阅读器为 span,费曼/终评为 h1):语义上工具栏内不该有标题,但页面唯一 h1 由测试与读屏顺序依赖。
  - Fix(可选):把 h1 移到滚动区顶部并在带里放 `aria-hidden` 副本。
- **Medium · 强调色不跟随系统**:WKWebView 里 `AccentColor` 关键字只对 `color/fill` 生效,`background-color` 变透明,故固定靛蓝。
  - Why:`color.md › Desktop (macOS)`:“consider using the accent color… in all appearances”。
  - Fix(可选):壳层读 `NSColor.controlAccentColor` 经 IPC 注入 `--accent`,监听 `NSSystemColorsDidChangeNotification`。
- **Low · App 菜单标题显示进程名 `book-learner`**(由 CFBundleName 决定;改 productName 会改 .app 名与安装脚本路径)。
- **Low · `Tag` 仍是圆角胶囊 `text-xs`**:与 macOS 的方角小标签略有差别,但与任务色条同源,保留作签名的一部分。
- **Low · 31 处 `title=` 已减到图表柱条上的逐日 `title`**(读屏走数据表,`title` 只给指针悬停)。

### Craft notes

- 点 of view:书斋——纸、宋体、三色脊梁;控件全部系统化,不抢戏。
- 结构编码信息:今日队列序号(真序列)、地图行序号(真顺序)、设置分区导航(真层级);没有装饰性的 01/02。
- 大胆只花在一处:用户气泡反白墨色;其余安静(卡面白 + 细分隔线)。
- 可删的一件:书架封面的“首字 + 书脊色”合成封面——留着是因为它是唯一的“书”的物证。

### What works

- 令牌两层 + 棘轮测试:视觉规则可执行、可回归。
- 每页一致的骨架(带 / 滚动区 / 56rem 版心)让八个页面读起来是同一个 app。
- 可访问名与 testid 三批零改动地保住了约 80 个中文名字——重构没有偷换语义。
- 图表附读屏数据表,VoiceOver 能逐日读数。

### Platform notes

- 减少透明度 / 增强对比度 / 减弱动态三套系统开关都有 CSS 回退;打字机在减弱动态下瞬出。
- 960×640 最小窗口:书架 3 列、设置左列隐藏、阅读器带不换行、统计 2 列(第三批装机后目视确认)。
