# Design review: book-learner(攻书)— 基线(2026-09-20,装机版 `755d6e6`)

审查工具:`apple-design` skill(HIG 122 页,2026-06 版)。平台 macOS 26.6,框架 Tauri 2 + React 18 + Tailwind v4。审查对象:代码(令牌、组件、八个页面)+ 真机观察;对比度均按十六进制值计算,不是估的。此报告是视觉改版三批的**验收基线**:每批合并后复审,Critical 清零、High 递减为通过条件。

### Summary

一个自用的“读书深学”工具,论点清楚:暖纸色 + 宋体标题的“书斋”,三任务色(赤/琥珀/靛)作为日程的脊梁。令牌层做得对(全部颜色只在 `tokens.css`),组件层薄,窗口 chrome 完全是默认网页态。总评:**Critical issues**——三级文字与复习色的对比度低于 4.5:1 却大量用作正文与可点元素;对话框没有键盘出口与焦点管理。会被记住的一点:任务卡 4 px 左色条 + 宋体标题压在纸上。

### Critical

- **三级文字色 `--ink-3` #857a68 在页面底 #f6f1e6 上 3.74:1、在卡面 #fdfaf2 上 4.04:1;四级 `--ink-4` #b6ab95 只有 2.02:1,却用在书架四个操作、阅读器「收起/放大」、脉络图「重新生成」上。复习色 `--c-review` #a8741f 作文字 3.60:1。**
  - Why:`accessibility.md › Vision`:“Up to 17 pts | All | 4.5:1”。`typography.md › Ensuring legibility`:macOS 默认 13 pt、最小 10 pt。
  - Fix:三级改 #6b6150(5.4:1),复习色改 #8c5f12(5.0:1),四级只准装饰(`aria-hidden`、分隔、占位),可点元素最低用三级;用 `tokensPolicy.test` 棘轮把 `cursor-pointer` + `text-ink-4` 的行数压到 0。
- **8 个 `role="dialog"` 都没有焦点陷阱、焦点还原和 Esc;遮罩是无角色的 `<div onClick>`;阅读器全局 ←/→ 在弹窗打开时仍翻页。**
  - Why:`accessibility.md › Mobility`:“Let people use the keyboard alone to navigate and interact with your app.” 模态必须有明显出口(`modality.md`,判断)。
  - Fix:一个 `Dialog` 原语(portal、`aria-modal`、Tab 循环、Esc、还原焦点、`data-modal-open`),七个手写模态与 `Confirm` 全部迁过去;阅读器翻页监听检查 `data-modal-open`。
- **`outline-none focus:border-new` 抹掉全局焦点环**(`SettingsPage.tsx:254`、`LineagePanel.tsx` 4 处),1 px 边色变化不足以作焦点指示。
  - Why:同上 `accessibility.md › Mobility`(Full Keyboard Access)。
  - Fix:`Input/Textarea` 原语用 `focus-visible:ring-[3px] ring-accent/35`,删掉 `outline-none`。

### Improvements

- **High · 窗口 chrome 是默认网页态**:`tauri.conf.json` 无 `titleBarStyle/hiddenTitle/transparent/windowEffects`,标题栏与内容割裂,没有工具栏、没有材质;无原生菜单栏(只有托盘两项)。
  - Why:`toolbars.md › Desktop (macOS)`:“the toolbar resides in the frame at the top of a window, either below or integrated with the title bar… toolbar items don't include a bezel.” `the-menu-bar.md › View menu`:“Provide a View menu even if your app supports only a subset of the standard view functions.” `toolbars.md › Desktop (macOS)`:“Make every toolbar item available as a command in the menu bar.”
  - Fix:`titleBarStyle: Overlay + hiddenTitle + trafficLightPosition {14,20} + transparent + windowEffects sidebar + macOSPrivateApi`;`capabilities` 加 `core:window:allow-start-dragging`;`lib.rs` 建 攻书/编辑/显示/窗口/帮助 菜单(⌘, 设置、⌃⌘S 侧栏、⌘W)。
- **High · app 级外观开关**:侧栏底部「◐ 夜读模式」按钮,不跟随系统。
  - Why:`dark-mode.md › Best practices`:“Avoid offering an app-specific appearance setting… they may think your app is broken.”
  - Fix:`themePreference: system|light|dark`,默认 system 走 `prefers-color-scheme`;手动覆盖放设置页「外观」;删侧栏按钮。
- **High · 侧栏用“薄弱”红作当前页刻线;阅读器选中 tab 用“新学”靛实心填色。**
  - Why:`color.md › Best practices`:“Avoid using the same color to mean different things.”
  - Fix:三任务色只标数据(色条/标签/书脊/图表);选中态用中性 `fill-selected`,强调交给系统 `AccentColor`(`@supports (color: AccentColor)`,回退 #3b5aa6,5.8:1)。
- **High · 四个高亮色硬编码**(`ReaderPage.tsx:63-68`、`MarksPanel.tsx:4-9` 的 `bg-yellow-300` 等;`readerThemes.ts:7-12` rgba),暗色下不适配,也违反仓库自己的“视觉单点”规则。
  - Why:`color.md › Best practices`:“Avoid hard-coding system color values in your app.”;`web/ARCHITECTURE.md` 规则 3。
  - Fix:`--hl-yellow/green/blue/pink` + `--hl-alpha` 亮/暗两套;`highlightFill()` 读令牌。
- **High · 设置页离系统设置惯例最远**:六张卡、原生未样式化 radio/select/number、没有分区导航;设置不能从 App 菜单 ⌘, 打开。
  - Why:`settings.md › Best practices`:“people often use the standard Command-Comma (,) keyboard shortcut”;`settings.md › Desktop (macOS)`:“Include a settings item in the App menu.”
  - Fix:菜单 ⌘, 直达;页内左列分区 + 分组内嵌列表(行 44 px);`Field/Input/Select/Segmented` 原语。
- **Medium · 组件层缺中间层**:无 Dialog/Input/Segmented/Tooltip/Toast/Menu/Popover/EmptyState/Skeleton;7 个模态宽度(w-88/110/130/150)与遮罩(/25、/30)各异;`inputCls` 字符串在两处重复;31 处 `title=` 当提示。
  - Why:`layout.md › Best practices`(一致性);判断。
  - Fix:第一批建原语,二三批逐页替换。
- **Medium · 零图标、UI 字体栈无系统字体**:五个导航项与所有按钮都是纯文字;`--font-sans` 以 PingFang 起头,没有 `-apple-system`/SF,控件字形与原生不匹配;真正的 emoji 只有 💬🗺🎙,其余是 ★☆✎◐◑‹›等字形。
  - Why:`sidebars.md › Best practices`:“Consider using familiar symbols to represent items in the sidebar.”;`typography.md › Using system fonts`。
  - Fix:自绘 SF 风格线性图标集(1.5 px 笔画,`non-scaling-stroke`);`--font-sans: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC"…`。
- **Medium · 减弱动态只在卷页处生效**:6 处 `animate-pulse`、打字机、3 处 smooth scroll 不受控。
  - Why:`motion.md › Best practices`:“Make motion optional.”
  - Fix:全局 `prefers-reduced-motion` 守卫(`*:not([data-motion-essential])`),打字机在减弱动态时首拍出全文。
- **Medium · 番茄钟是右下角浮动卡**(`fixed right-8 bottom-8`)。
  - Why:`sidebars.md › Desktop (macOS)`/`layout.md` 判断:“Avoid placing controls or critical information at the bottom of a window”(用户常把窗口底边推出屏幕)。
  - Fix:移到顶部工具栏带的倒计时胶囊。
- **Medium · 加载态是裸文字**(「正在取回今日队列…」「正在展开地图…」),只有阅读器有骨架。
  - Why:`loading.md`(判断:先出现占位再填充)。
  - Fix:`Skeleton` + `aria-busy`。
- **Low · 书架栅格断点反向**(`grid-cols-3 sm:grid-cols-4`,桌面恒为 4 列);侧栏占宽后视口断点失真。
  - Fix:容器查询 + `auto-fill minmax(10.5rem,1fr)`。
- **Low · favicon 仍是 Vite 紫色闪电;`--font-reading` 被引用却未声明;死令牌 `--reading-max-width/--reading-line-height`。**

### Craft notes

- **论点与签名(High,正面)**:“纸感书斋”有产品理由——它是书;宋体字标/标题压在暖纸上是这个 app 唯一会被记住的东西,保留。三任务色作为日程脊梁是真正“结构编码信息”的例子(左色条、标签、书脊、图表系列),保留但收回到只标数据。
- **模板风险(Medium)**:“暖奶油 + 衬线 + 赤陶”正是 skill 点名的三种生成式模板之一;区别在于我们的衬线是宋体、赤色是“薄弱”语义而非装饰。守住这条线:强调色不用赤陶,用系统 accent;纸纹肌理去掉(在原生材质下像“脏”,在暗色里是噪点)。
- **大胆只花在一处(Medium)**:现在的“大胆”分散在纸纹、赤色刻线、靛色 tab 填色、番茄钟浮动卡上;改版后集中到“宋体标题 + 三色数据条”,其余安静。
- **删一件配饰**:纸纹。

### What works

- `tokens.css` 单点视觉、`@theme inline` 映射、`[data-theme]` 切换的骨架——改版只需重写这一个文件就能让全站对比度达标。
- `TaskCard` 的 4 px 左色条 + Tag + 宋体标题;书架“首字 + 书脊色条”合成封面;费曼页反白墨色用户气泡(16.2:1)。
- `aria-label` 58 处、`role=dialog` 8 处、全局 2 px `:focus-visible` 环——可达性底子在。
- 测试以角色 + 可访问名查询为主(约 80 个中文名、45 个 testid),改版可以自由动布局与颜色。
- 阅读器卷页动画已尊重 `prefers-reduced-motion`。

### Platform notes

- Tauri 2.11 已把 `window-vibrancy` 作为传递依赖,`windowEffects` 纯配置即可拿到原生 `NSVisualEffectView` 侧栏材质;`transparent: true` 在 macOS 需要 `macOSPrivateApi: true`;`data-tauri-drag-region` 需要 `core:window:allow-start-dragging` 权限(当前 `capabilities/default.json` 没有)。
- 减少透明度 / 增强对比度:AppKit 材质会自动变不透明,但 CSS 层的 `--surface-sidebar`、分隔线、三级字要各自响应 `prefers-reduced-transparency` / `prefers-contrast: more`。
- WKWebView 一旦出现 `::-webkit-scrollbar` 规则就退回常显经典滚动条,不要自定义滚动条。
- 调试自动化桥按 `innerText` 点按钮,图标按钮必须内含 sr-only 文字。
