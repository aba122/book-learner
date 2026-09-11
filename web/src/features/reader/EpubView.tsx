import ePub, { type Book, type Rendition } from 'epubjs'
import type { NavItem } from 'epubjs'
import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react'
import { READER_PAGE_CURL_LIFT, READER_PAGE_CURL_MS, READER_PAGE_SNAPSHOT_MAX_MS, READER_SELECTION_POLL_MS } from '../../config'
import { attachPointerLayer } from './pointerLayer'
import { createCurlOverlay, snapshotVisiblePage, type CurlOverlay } from './pageCurlOverlay'
import { DEFAULT_TYPOGRAPHY, HIGHLIGHT_FILL, rangeCfiFromPoints, readerThemes, type SectionLike, type ViewLike } from './readerThemes'

export interface EpubHandle {
  next: () => void
  prev: () => void
  /** 章节 href 或 CFI */
  display: (target: string) => void
  /** 当前页起点 CFI 与章节 href(未定位时为 null) */
  currentLocation: () => { cfi: string; href: string } | null
  /** 清掉正文里的选区(高亮已建/工具条取消后;不清的话下一次单击只会被当成取消选区) */
  clearSelection: () => void
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

/** epub.js Contents 在选区轮询里用到的子集 */
interface SelectionContents {
  window?: Window
  cfiFromRange: (range: Range) => string
}

/** 系统「减少动态效果」:不卷页,直接换页 */
const prefersReducedMotion = () =>
  typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

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
    /** 双页(BL-008):epub.js spread auto/none */
    spread?: boolean
    /** 点击正文里已有的高亮(注解 SVG 在父文档,可收到点击;BL-007) */
    onHighlightClicked?: (cfiRange: string) => void
  }
>(function EpubView(
  { url, fontSizePct, theme, typography = DEFAULT_TYPOGRAPHY, initialHref, highlights, blockSegments, onToc, onProgress, onSelected, onRelocated, spread = false, onHighlightClicked },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null)
  // 首屏骨架:rendition 首次 rendered 前显示,避免空白等待(T6.1)
  const [ready, setReady] = useState(false)
  // 卷页翻页(BL-010):正在卷时 data-turning 标方向;快照层由 pageCurlOverlay 管
  const [turning, setTurning] = useState<'next' | 'prev' | null>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const curlRef = useRef<CurlOverlay | null>(null)
  const onHighlightClickedRef = useRef(onHighlightClicked)
  // 指针层(BL-011):正文 iframe 无脚本、监听器不会被调用,鼠标交互由父文档的这一层接管;turn 经 ref 调用(声明在后面)
  const turnRef = useRef<(direction: 'next' | 'prev') => void>(() => {})
  const pointerRef = useRef<HTMLDivElement>(null)
  const spreadRef = useRef(spread)
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
    onHighlightClickedRef.current = onHighlightClicked
    spreadRef.current = spread
  })

  useEffect(() => {
    if (!containerRef.current) return
    const book = ePub(url)
    bookRef.current = book
    const rendition = book.renderTo(containerRef.current, {
      width: '100%',
      height: '100%',
      flow: 'paginated',
      // 双页不在这里给:renderTo 用 'auto' 或 start 前调 rendition.spread() 都会让 epub.js 不挂视图(Mac 实测)
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
    // 选区:epub.js 的 selected 依赖 iframe 文档的 selectionchange,WKWebView 里 sandbox 无脚本的 iframe 不派发它
    // (BL-006 实测 0 次),故保留该监听的同时按固定间隔轮询各 contents 的 getSelection(),算出区间 CFI 后上报。
    const lastSelectionCfi = { current: null as string | null }
    const emitSelection = (cfiRange: string, text: string, href: string) => {
      if (cfiRange === lastSelectionCfi.current) return
      lastSelectionCfi.current = cfiRange
      onSelectedRef.current?.({ cfiRange, text, href })
    }
    rendition.on('selected', (cfiRange: string, contents: { window?: Window; section?: { href?: string } }) => {
      const text = contents?.window?.getSelection?.()?.toString().trim() ?? ''
      const href = lastLocation.current?.href ?? contents?.section?.href ?? ''
      emitSelection(cfiRange, text, href)
    })
    const pollSelection = () => {
      const contentsList = (rendition as unknown as { getContents?: () => unknown }).getContents?.()
      const list = (Array.isArray(contentsList) ? contentsList : contentsList ? [contentsList] : []) as SelectionContents[]
      let found = false
      for (const contents of list) {
        try {
          const sel = contents.window?.getSelection?.()
          if (!sel || sel.isCollapsed || sel.rangeCount === 0) continue
          const text = sel.toString().trim()
          if (!text) continue
          const cfiRange = contents.cfiFromRange(sel.getRangeAt(0))
          if (!cfiRange) continue
          found = true
          emitSelection(cfiRange, text, lastLocation.current?.href ?? '')
          break
        } catch {
          /* 选区跨章或 iframe 已卸载时忽略 */
        }
      }
      if (!found) lastSelectionCfi.current = null
    }
    const selectionTimer = setInterval(pollSelection, READER_SELECTION_POLL_MS)
    const detachPointer = pointerRef.current && containerRef.current
      ? attachPointerLayer(pointerRef.current, { viewport: containerRef.current, getContents: () => rendition.getContents?.(), onTurn: side => turnRef.current(side) })
      : () => {}
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
      clearInterval(selectionTimer)
      detachPointer()
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

  // 双页(BL-008):只在首屏 rendered 之后按需调 rendition.spread('auto'|'none')——start 前调用会让 epub.js
  // 不挂视图(Mac 实测 iframe 为空、next() 报 manager undefined);运行时切换 epub.js 只重排现有视图,无需重显示。
  const spreadApplied = useRef(false)
  useEffect(() => {
    if (!ready) {
      spreadApplied.current = false // rendition 重建后从单页起
      return
    }
    if (spreadApplied.current === spread) return
    spreadApplied.current = spread
    const rendition = rendRef.current as unknown as { spread?: (mode: string) => void } | null
    rendition?.spread?.(spread ? 'auto' : 'none')
  }, [spread, ready])

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
        rendition.annotations.highlight(cfi, {}, () => onHighlightClickedRef.current?.(cfi), 'bl-highlight', {
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

  const navigate = (direction: 'next' | 'prev') =>
    Promise.resolve(direction === 'next' ? rendRef.current?.next() : rendRef.current?.prev()).catch(() => undefined)
  const turn = (direction: 'next' | 'prev') => {
    // 正在卷:忽略连点(纸书也翻不了两页)
    if (curlRef.current) return
    const rendition = rendRef.current
    const host = hostRef.current
    const viewport = containerRef.current
    if (!rendition || !host || !viewport || prefersReducedMotion()) {
      void navigate(direction)
      return
    }
    // 拿不到当前页快照(还没渲染/多视图)就直接换页,不卷
    const snap = snapshotVisiblePage(rendition, viewport)
    if (!snap) {
      void navigate(direction)
      return
    }
    const overlay = createCurlOverlay(host, snap, READER_PAGE_SNAPSHOT_MAX_MS)
    curlRef.current = overlay
    setTurning(direction)
    void overlay.ready
      .then(() => {
        // 快照已盖在上面,此刻换页不可见;新页在纸下露出
        void navigate(direction)
        return overlay.animate(direction, spreadRef.current ? 'spread' : 'single', READER_PAGE_CURL_MS, READER_PAGE_CURL_LIFT)
      })
      .finally(() => {
        overlay.destroy()
        if (curlRef.current === overlay) {
          curlRef.current = null
          setTurning(null)
        }
      })
  }
  useLayoutEffect(() => {
    turnRef.current = turn
  })
  useEffect(() => () => { curlRef.current?.destroy() }, [])

  useImperativeHandle(ref, () => ({
    next: () => turn('next'),
    prev: () => turn('prev'),
    display: target => void rendRef.current?.display(target),
    currentLocation: () => lastLocation.current,
    clearSelection: () => {
      const raw = rendRef.current?.getContents?.() as unknown
      const list = Array.isArray(raw) ? raw : raw ? [raw] : []
      for (const c of list as { window?: Window; document?: Document }[]) {
        try {
          ;(c.window ?? c.document?.defaultView)?.getSelection()?.removeAllRanges()
        } catch {
          /* iframe 已卸载时忽略 */
        }
      }
      lastSelectionCfi.current = null
    },
  }))

  return (
    <div ref={hostRef} className="relative h-full w-full" data-testid="epub-book" data-turning={turning ?? undefined}>
      <div ref={containerRef} className="h-full w-full" data-testid="epub-container" />
      <div ref={pointerRef} className="bl-pointer" data-testid="pointer-layer" aria-hidden />
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
