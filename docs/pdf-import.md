# 用 PDF 学习:先转成 EPUB(过渡方案)

攻书目前只导入 EPUB。PDF 原生导入(pdf.js 抽取、按页锚定、PDF 阅读视图)已评估但未排期,见 `IMPLEMENTATION_PLAN.md` 范围外;当前用 Calibre 把 PDF 转成 EPUB 再导入,学习闭环(地图、费曼对话、评估、调度、终评、导出)完全不受影响,差别只在阅读器里看到的是转换后的排版。

## 一次性准备

```bash
brew install --cask calibre          # 或从 https://calibre-ebook.com 下载
# 命令行工具在 app 包内;想直接敲 ebook-convert 可加到 PATH:
echo 'export PATH="/Applications/calibre.app/Contents/MacOS:$PATH"' >> ~/.zshrc
```

## 转换

```bash
ebook-convert "书名.pdf" "书名.epub" --enable-heuristics
```

- `--enable-heuristics`:合并被 PDF 分页打断的段落、去掉多余空行,中文书尤其需要。
- 页眉页脚混进正文时,用正则剔除(按本书实际文字改):`--pdf-header-regex '^第 ?\d+ ?页$' --pdf-footer-regex '^.*出版社.*$'`。
- 没有目录(EPUB 里只有一章)时,让 Calibre 按标题样式切章:`--chapter "//h:h1|//h:h2"`;或 `--chapter-mark pagebreak`。切不出来也没关系:攻书的地图生成按整章文本工作,只是"回读原文"跳转粒度会粗一些。
- 书名/作者取自 PDF 元数据;不对时加 `--title "书名" --authors "作者"`,导入后书架会按 OPF 显示。

在攻书的导入向导里直接选 PDF 也可以:它不会导入,而是显示上面这条针对该文件的命令,复制到终端执行即可。

## 已知限制

- **扫描版 PDF**(整页是图片)没有文字层,转出来是空书或只有图。需先 OCR(例如 macOS 预览/ABBYY/`ocrmypdf`)得到带文字层的 PDF 再转换。
- 双栏排版、脚注、公式常会错位或串行;转换后先在阅读器里翻几页,严重时用 `--pdf-engine` / 页眉页脚正则调一次。
- 转换后的 EPUB 没有原书的精确页码;导出的 Obsidian 笔记引用的是章节与块,不是页码。

## 验证记录(2026-09-08)

脚本 `docs/smoke/scripts/pdf-roundtrip.sh`(Mac,Calibre 9.14.0,真 codex):

- 用公版《道德經》EPUB 先转成 PDF(制造一本带文字层的 PDF,4 s,429 KB),再 `ebook-convert 道德經.pdf 道德經-from-pdf.epub --enable-heuristics`:2 s,84 KB;OPF `dc:title` 道德經、`dc:creator` Laozi 保留。
- 攻书导入向导先选 PDF:只显示转换命令,不建书;再选转换后的 EPUB:导入成功,书架 `道德經 / Laozi`,spine 6 章,AI 生成 21 个知识块(544 s,含 codex 分析),学习流程可用。
- 观察:转换后的章节名是 Calibre 的拆分文件名(`index_split_001.html`、`Start`、`LICENSE`),正文集中在其中一两章;块锚点全部为"整章回退"(回读原文跳到章首,注入整章文本)。想要更细的章节与锚点,转换时加 `--chapter`/`--level1-toc` 按标题切章,或在 Calibre 编辑器里给章节加标题后再导入。
