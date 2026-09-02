import ePub from 'epubjs'

type CfiSmokeResult = {
  href: string
  cfi: string
  restoredText: string
}

declare global {
  interface Window {
    __CFI_SMOKE__?: CfiSmokeResult
  }
}

const book = ePub('/fixtures/sample.epub')

try {
  await book.ready
  const section = book.spine.get('chap1.xhtml')
  if (!section) throw new Error('fixture spine chap1.xhtml missing')

  await section.load(book.load.bind(book))
  const heading = section.document.querySelector('h1')
  if (!heading) throw new Error('fixture h1 missing')
  const headingText = heading.firstChild
  if (!headingText || headingText.nodeType !== Node.TEXT_NODE) {
    throw new Error('fixture h1 text node missing')
  }

  const range = section.document.createRange()
  range.setStart(headingText, 0)
  range.setEnd(headingText, headingText.textContent?.length ?? 0)
  const cfi = section.cfiFromRange(range)
  const restored = await book.getRange(cfi)

  window.__CFI_SMOKE__ = {
    href: section.href,
    cfi,
    restoredText: restored.toString(),
  }
  document.querySelector('#status')!.textContent = 'complete'
} finally {
  book.destroy()
}
