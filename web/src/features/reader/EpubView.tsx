import ePub, { type Book, type Rendition } from 'epubjs'
import type { NavItem } from 'epubjs'
import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react'
import { DEFAULT_TYPOGRAPHY, HIGHLIGHT_FILL, rangeCfiFromPoints, readerThemes, type SectionLike, type ViewLike } from './readerThemes'

export interface EpubHandle {
  next: () => void
  prev: () => void
  /** 章节 href 或 CFI */
  display: (target: string) => void
  /** 当前页起点 CFI 与章节 href(未定位时为 null) */
  currentLocation: () => { cfi: string; href: string } | null
}

export type ReaderTheme = 'paper' | 'sepia' | 'night'

export interface ReaderTypography {
  /** 行高(1.5 / 1.8 / 2.1) */
  lineHeight: number
  /** 段首缩进 */
  indent: boolean
  /** 覆盖出版方样式:注入字体栈/行高/两端对齐/版心;关闭时只注入主题色 */
  overridePublisher: boolean
}

export interface HighlightAnnotation {
  /** 区间 CFI(epub.js annotations 只接受区间) */
  cfiRange: string
  color: string
}

export interface BlockSegment {
  spineHref: string
  cfiStart: string
  cfiEnd: string
}

export interface SelectionInfo {
  cfiRange: string
  text: string
  href: string
}

const EpubView = forwardRef<
  EpubHandle,
  {
    url: string
    fontSizePct: string
    theme: ReaderTheme
    typography?: ReaderTypography
    initialHref?: string
    highlights?: HighlightAnnotation[]
    blockSegments?: BlockSegment[]
    onToc?: (toc: NavItem[]) => void
    onProgress?: (fraction: number) => void
    onSelected?: (selection: SelectionInfo) => void
    onRelocated?: (location: { cfi: string; href: string }) => void
  }
>(function EpubView(
  { url, fontSizePct, theme, typography = DEFAULT_TYPOGRAPHY, initialHref, highlights, blockSegments, onToc, onProgress, onSelected, onRelocated },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null)
  // 首屏骨架:rendition 首次 rendered 前显示,避免空白等待(T6.1)
  const [ready, setReady] = useState(false)
  const bookRef = useRef<Book | null>(null)
  const rendRef = useRef<Rendition | null>(null)
  const appliedHighlights = useRef<Set<string>>(new Set())
  const appliedSegments = useRef<Set<string>>(new Set())
  const lastLocation = useRef<{ cfi: string; href: string } | null>(null)
  // 最新回调与数据经 ref 供 epub 事件使用;在提交阶段同步,不在渲染期写 ref(react/refs)
  const onTocRef = useRef(onToc)
  const onProgressRef = useRef(onProgress)
  const onSelectedRef = useRef(onSelected)
  const onRelocatedRef = useRef(onRelocated)
  const initialHrefRef = useRef(initialHref)
  const typographyRef = useRef(typography)
  const themeRef = useRef(theme)
  const segmentsRef = useRef(blockSegments)
  useLayoutEffect(() => {
    onTocRef.current = onToc
    onProgressRef.current = onProgress
    onSelectedRef.current = onSelected
    onRelocatedRef.current = onRelocated
    initialHrefRef.current = initialHref
    typographyRef.current = typography
    themeRef.current = theme
    segmentsRef.current = blockSegments
  })

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
    appliedHighlights.current = new Set()
    appliedSegments.current = new Set()
    setReady(false)
    for (const [name, styles] of Object.entries(readerThemes(typographyRef.current))) {
      rendition.themes.register(name, styles)
    }
    rendition.themes.select(themeRef.current)
    rendition.display(initialHrefRef.current || undefined)
    book.loaded.navigation.then(nav => onTocRef.current?.(nav.toc))
    rendition.on('selected', (cfiRange: string, contents: { window?: Window; section?: { href?: string } }) => {
      const text = contents?.window?.getSelection?.()?.toString().trim() ?? ''
      const href = lastLocation.current?.href ?? contents?.section?.href ?? ''
      onSelectedRef.current?.({ cfiRange, text, href })
    })
    // 学习模式:该章渲染后把块锚点的两点 CFI 组合成区间并加下划线(多段块每段一条)
    rendition.on('rendered', (section: SectionLike, view: ViewLike) => {
      setReady(true)
      const doc = view?.contents?.document
      if (!doc) return
      for (const seg of segmentsRef.current ?? []) {
        if (seg.spineHref !== section.href) continue
        const key = `${seg.spineHref}|${seg.cfiStart}|${seg.cfiEnd}`
        if (appliedSegments.current.has(key)) continue
        const cfiRange = rangeCfiFromPoints(section, doc, seg.cfiStart, seg.cfiEnd)
        if (!cfiRange) continue
        try {
          rendition.annotations.underline(cfiRange, {}, undefined, 'bl-block', { stroke: 'rgba(120, 90, 40, 0.55)', 'stroke-width': '2px' })
          appliedSegments.current.add(key)
        } catch {
          /* 注解失败不影响阅读 */
        }
      }
    })
    // 进度与位置:relocated 给出当前页起点;locations 就绪后按 CFI 百分比汇报
    rendition.on('relocated', (location: { start: { cfi: string; href: string } }) => {
      const cfi = location?.start?.cfi
      const href = location?.start?.href ?? ''
      if (cfi) {
        lastLocation.current = { cfi, href }
        onRelocatedRef.current?.({ cfi, href })
      }
      try {
        const pct = book.locations.percentageFromCfi(cfi)
        if (typeof pct === 'number') onProgressRef.current?.(pct)
      } catch {
        /* locations 不可用时静默 */
      }
    })
    book.ready
      ?.then(() => book.locations?.generate(600))
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
      lastLocation.current = null
    }
  }, [url])

  useEffect(() => {
    rendRef.current?.themes.fontSize(fontSizePct)
  }, [fontSizePct])

  // 主题或排版开关变化:重注册三套主题并重新选中(epub.js 会重新注入到 iframe)
  useEffect(() => {
    const rendition = rendRef.current
    if (!rendition) return
    for (const [name, styles] of Object.entries(readerThemes(typography))) {
      rendition.themes.register(name, styles)
    }
    rendition.themes.select(theme)
  }, [theme, typography])

  // 高亮同步:新增的加、消失的删(按区间 CFI)
  useEffect(() => {
    const rendition = rendRef.current
    if (!rendition) return
    const wanted = new Map((highlights ?? []).map(h => [h.cfiRange, h]))
    for (const cfi of Array.from(appliedHighlights.current)) {
      if (!wanted.has(cfi)) {
        try {
          rendition.annotations.remove(cfi, 'highlight')
        } catch {
          /* 已不存在 */
        }
        appliedHighlights.current.delete(cfi)
      }
    }
    for (const [cfi, h] of wanted) {
      if (appliedHighlights.current.has(cfi)) continue
      try {
        rendition.annotations.highlight(cfi, {}, undefined, 'bl-highlight', {
          fill: HIGHLIGHT_FILL[h.color] ?? HIGHLIGHT_FILL.yellow,
          'fill-opacity': '1',
          'mix-blend-mode': 'multiply',
        })
        appliedHighlights.current.add(cfi)
      } catch {
        /* 区间不在当前章节时 epub.js 会在渲染到该章时补画 */
      }
    }
  }, [highlights])

  useImperativeHandle(ref, () => ({
    next: () => void rendRef.current?.next(),
    prev: () => void rendRef.current?.prev(),
    display: target => void rendRef.current?.display(target),
    currentLocation: () => lastLocation.current,
  }))

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="h-full w-full" data-testid="epub-container" />
      {!ready && (
        <div data-testid="epub-skeleton" className="pointer-events-none absolute inset-0 flex flex-col gap-3 px-16 py-14" aria-hidden>
          <div className="h-5 w-1/3 animate-pulse rounded-s bg-paper-3" />
          {[92, 100, 96, 88, 100, 70].map((w, i) => (
            <div key={i} className="h-3.5 animate-pulse rounded-s bg-paper-3" style={{ width: `${w}%` }} />
          ))}
        </div>
      )}
    </div>
  )
})

export default EpubView
