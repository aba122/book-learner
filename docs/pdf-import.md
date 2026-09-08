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

{ROUNDTRIP}
