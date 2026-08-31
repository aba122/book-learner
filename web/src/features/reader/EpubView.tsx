import ePub, { type Book, type Rendition } from 'epubjs'
import type { NavItem } from 'epubjs'
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'

export interface EpubHandle {
  next: () => void
  prev: () => void
  display: (href: string) => void
}

export type ReaderTheme = 'paper' | 'sepia' | 'night'

/** 从 tokens.css 读取阅读器主题(epub 在 iframe 中渲染,需要具体值) */
function readerThemes() {
  const css = getComputedStyle(document.documentElement)
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback
  const lineHeight = v('--reading-line-height', '1.9')
  const fontSans = v('--font-sans', 'sans-serif')
  const theme = (bg: string, ink: string) => ({
    body: {
      background: bg,
      color: ink,
      'line-height': lineHeight,
      'font-family': fontSans,
      padding: '0 8%',
    },
    'h1, h2, h3': { color: ink },
    p: { 'text-indent': '2em', margin: '0.6em 0' },
  })
  return {
    paper: theme(v('--reader-paper-bg', '#fdfaf2'), v('--reader-paper-ink', '#221c14')),
    sepia: theme(v('--reader-sepia-bg', '#f2e5c9'), v('--reader-sepia-ink', '#463922')),
    night: theme(v('--reader-night-bg', '#171512'), v('--reader-night-ink', '#cfc6b3')),
  }
}

const EpubView = forwardRef<
  EpubHandle,
  {
    url: string
    fontSizePct: string
    theme: ReaderTheme
    initialHref?: string
    onToc?: (toc: NavItem[]) => void
    onProgress?: (fraction: number) => void
  }
>(function EpubView({ url, fontSizePct, theme, initialHref, onToc, onProgress }, ref) {
  const containerRef = useRef<HTMLDivElement>(null)
  const bookRef = useRef<Book | null>(null)
  const rendRef = useRef<Rendition | null>(null)
  const onTocRef = useRef(onToc)
  const onProgressRef = useRef(onProgress)
  onTocRef.current = onToc
  onProgressRef.current = onProgress
  const initialHrefRef = useRef(initialHref)
  initialHrefRef.current = initialHref

  useEffect(() => {
    if (!containerRef.current) return
    const book = ePub(url)
    bookRef.current = book
    const rendition = book.renderTo(containerRef.current, {
      width: '100%',
      height: '100%',
      flow: 'paginated',
      spread: 'none',
      allowScriptedContent: false,
    })
    rendRef.current = rendition
    for (const [name, styles] of Object.entries(readerThemes())) {
      rendition.themes.register(name, styles)
    }
    rendition.display(initialHrefRef.current || undefined)
    book.loaded.navigation.then(nav => onTocRef.current?.(nav.toc))
    // 进度:locations 就绪后按 CFI 百分比汇报
    book.ready
      ?.then(() => book.locations?.generate(600))
      .then(() => {
        rendition.on('relocated', (location: { start: { cfi: string } }) => {
          try {
            const pct = book.locations.percentageFromCfi(location.start.cfi)
            if (typeof pct === 'number') onProgressRef.current?.(pct)
          } catch {
            /* locations 不可用时静默 */
          }
        })
      })
      .catch(() => {})

    const onResize = () => {
      try {
        ;(rendition as unknown as { resize?: () => void }).resize?.()
      } catch {
        /* 已销毁 */
      }
    }
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      book.destroy()
      bookRef.current = null
      rendRef.current = null
    }
  }, [url])

  useEffect(() => {
    rendRef.current?.themes.fontSize(fontSizePct)
  }, [fontSizePct])

  useEffect(() => {
    rendRef.current?.themes.select(theme)
  }, [theme])

  useImperativeHandle(ref, () => ({
    next: () => void rendRef.current?.next(),
    prev: () => void rendRef.current?.prev(),
    display: href => void rendRef.current?.display(href),
  }))

  return <div ref={containerRef} className="h-full w-full" data-testid="epub-container" />
})

export default EpubView
