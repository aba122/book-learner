// 生成微型合法 EPUB3 fixture:node web/scripts/make-fixture-epub.mjs
// 章节 href(chap1..3.xhtml)与 MockBackend.blockSource 的返回值保持一致。
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import JSZip from 'jszip'

const outPath = join(dirname(fileURLToPath(import.meta.url)), '../public/fixtures/sample.epub')

const xhtml = (title, paras) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh-CN" lang="zh-CN">
<head><title>${title}</title></head>
<body>
<h1>${title}</h1>
${paras.map(p => `<p>${p}</p>`).join('\n')}
</body>
</html>`

const chapters = [
  {
    href: 'chap1.xhtml',
    title: '第一章 供给与需求',
    paras: [
      '市场由买者与卖者的相互作用构成。买者的购买意愿与能力汇成需求,卖者的出售意愿与能力汇成供给,两股力量在价格上相遇。',
      '需求定律说的是:在其他条件不变时,价格上升,需求量下降。这条向右下方倾斜的曲线,是经济学里最先学、也最常被误读的一条线。',
      '当价格暂时偏离均衡,过剩或短缺会把它拉回来。均衡不是静止,而是无数次微小调整的结果——价格是市场的语言。',
      '弹性衡量反应的灵敏程度:价格变动百分之一,需求量变动百分之几。它决定了降价究竟是让收入增加,还是让收入流失。',
    ],
  },
  {
    href: 'chap2.xhtml',
    title: '第二章 消费者选择',
    paras: [
      '效用是满足感的度量。第一杯水价值连城,第十杯水弃之不惜——边际效用递减,是理解消费行为的钥匙。',
      '无差异曲线描绘"同样满意"的组合;预算线框定"买得起"的范围。最优选择发生在两者相切之处:意愿与能力达成和解。',
      '收入变动时,人们沿着新的预算线重新安放欲望;价格变动时,替代效应与收入效应一明一暗,共同改写购物篮。',
    ],
  },
  {
    href: 'chap3.xhtml',
    title: '第三章 生产与成本',
    paras: [
      '生产函数把投入变成产出。短期里总有些要素动弹不得,于是边际产量先升后降——这是短期成本曲线呈 U 形的根源。',
      '会计师看账面成本,经济学家看机会成本:放弃的最好选择,才是真正的代价。利润的定义因此而不同。',
      '长期里一切要素皆可调整,规模经济与规模不经济决定企业的边界。完全竞争市场中,价格最终被压向长期平均成本的最低点。',
    ],
  },
]

const containerXml = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`

const navXhtml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="zh-CN" lang="zh-CN">
<head><title>目录</title></head>
<body>
<nav epub:type="toc" id="toc">
  <h1>目录</h1>
  <ol>
${chapters.map(c => `    <li><a href="${c.href}">${c.title}</a></li>`).join('\n')}
  </ol>
</nav>
</body>
</html>`

const contentOpf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid" xml:lang="zh-CN">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">urn:uuid:book-learner-fixture-0001</dc:identifier>
    <dc:title>示例书:市场的秩序</dc:title>
    <dc:language>zh-CN</dc:language>
    <dc:creator>book-learner</dc:creator>
    <meta property="dcterms:modified">2026-08-30T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
${chapters.map((c, i) => `    <item id="c${i + 1}" href="${c.href}" media-type="application/xhtml+xml"/>`).join('\n')}
  </manifest>
  <spine>
${chapters.map((_, i) => `    <itemref idref="c${i + 1}"/>`).join('\n')}
  </spine>
</package>`

const zip = new JSZip()
// mimetype 必须为首个条目且不压缩
zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' })
zip.file('META-INF/container.xml', containerXml)
zip.file('OEBPS/content.opf', contentOpf)
zip.file('OEBPS/nav.xhtml', navXhtml)
for (const c of chapters) zip.file(`OEBPS/${c.href}`, xhtml(c.title, c.paras))

const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
await mkdir(dirname(outPath), { recursive: true })
await writeFile(outPath, buf)
console.log(`written: ${outPath} (${buf.length} bytes)`)
