// Playwright 真浏览器 harness(同 cfi-smoke):抽取 spine + 小节标题 → CFI 段 + 往返还原,结果挂到 window
import { resolveBlockAnchors, restoreSegmentText } from './epub/anchors'
import { chapterPlainText, extractSpine, loadSection, openEpub } from './epub/extract'
import type { AnchorSegment, SpineChapter } from './types'

type AnchorsSmokeResult = {
  spine: SpineChapter[]
  segments: AnchorSegment[]
  restored: string[]
  multi: AnchorSegment[]
  plain: Record<string, string>
}

declare global {
  interface Window {
    __ANCHORS_SMOKE__?: AnchorsSmokeResult
    __ANCHORS_SMOKE_ERROR__?: string
  }
}

const book = await openEpub('/fixtures/sample.epub')
try {
  const spine = await extractSpine(book)
  const segments = await resolveBlockAnchors(book, [
    { spineHref: 'chap1.xhtml', hint: '需求定律' },
    { spineHref: 'chap1.xhtml', hint: '小结' },
    { spineHref: 'chap1.xhtml', hint: '小结' },
    { spineHref: 'chap2.xhtml', hint: '小结' },
    { spineHref: 'chap3.xhtml', hint: '机会成本' },
    { spineHref: 'chap3.xhtml', hint: '不存在的小节' },
    { spineHref: 'chap1.xhtml', hint: '' },
  ])
  const restored: string[] = []
  for (const seg of segments) restored.push(seg.precision === 'exact' ? await restoreSegmentText(book, seg) : '')
  const multi = await resolveBlockAnchors(book, [
    { spineHref: 'chap1.xhtml', hint: '需求定律' },
    { spineHref: 'chap2.xhtml', hint: '小结' },
  ])
  const plain: Record<string, string> = {}
  for (const href of ['chap1.xhtml', 'chap3.xhtml']) {
    const section = await loadSection(book, href)
    plain[href] = chapterPlainText(section.document)
  }
  window.__ANCHORS_SMOKE__ = { spine, segments, restored, multi, plain }
} catch (error) {
  window.__ANCHORS_SMOKE_ERROR__ = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
} finally {
  document.querySelector('#status')!.textContent = 'complete'
  book.destroy()
}
