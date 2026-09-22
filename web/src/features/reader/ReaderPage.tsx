import type { NavItem } from 'epubjs'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { backend } from '../../backend'
import AsyncError from '../../components/AsyncError'
import Button from '../../components/Button'
import Checkbox from '../../components/Checkbox'
import Icon from '../../components/icons/Icon'
import IconButton from '../../components/IconButton'
import Popover from '../../components/Popover'
import ProgressBar from '../../components/ProgressBar'
import Segmented, { type SegmentedOption } from '../../components/Segmented'
import Skeleton from '../../components/Skeleton'
import Toolbar, { ToolbarDivider } from '../../components/Toolbar'
import { READER_FONT_DEFAULT_IDX, READER_FONT_STEPS, READER_LINE_HEIGHTS, READER_LINE_HEIGHT_DEFAULT_IDX, READER_POSITION_DEBOUNCE_MS, READER_PREFS_KEY } from '../../config'
import { readPref, writePref } from '../../lib/prefs'
import { useBackendOperation } from '../../lib/useBackendOperation'
import { useReadingClock } from '../../lib/useReadingClock'
import { useSession } from '../../store'
import { StaleResult, useAsyncResource } from '../../lib/useAsyncResource'
import type { HighlightColor, KnowledgeBlock, ReaderMark } from '../../types'
import EpubView, { type EpubHandle, type ReaderTheme, type ReaderTypography, type SelectionInfo } from './EpubView'
import MarksPanel from './MarksPanel'
import ReadingChatPanel from './ReadingChatPanel'
import LineagePanel from './lineage/LineagePanel'
import { isModalOpen } from '../../lib/modalStack'

const THEME_OPTIONS: { name: ReaderTheme; label: string; swatchClass: string }[] = [
  { name: 'paper', label: '纸白', swatchClass: 'bg-card border-sep-strong' },
  { name: 'sepia', label: '羊皮', swatchClass: 'bg-review-soft border-review' },
  { name: 'night', label: '夜读', swatchClass: 'bg-label-1 border-label-2' },
]

interface ReaderContent {
  block: KnowledgeBlock
  source: { href: string; text: string }
  url: string
  /** 首次取到的标记(含上次阅读位置);之后按本地操作维护 */
  readerMarksInit: ReaderMark[]
  /** 块锚点段(学习模式下画下划线;chapter_fallback 段无区间,跳过) */
  segments: { spineHref: string; cfiStart: string; cfiEnd: string }[]
  /** 本块锚点覆盖的章节 href(问书按它判定发问是否落在本块) */
  anchorHrefs: string[]
}

interface ReaderPrefs {
  fontIdx: number
  theme: ReaderTheme
  lineIdx: number
  indent: boolean
  overridePublisher: boolean
  /** 双页(BL-008) */
  spread: boolean
}

const DEFAULT_PREFS: ReaderPrefs = { fontIdx: READER_FONT_DEFAULT_IDX, theme: 'paper', lineIdx: READER_LINE_HEIGHT_DEFAULT_IDX, indent: true, overridePublisher: true, spread: false }

function loadPrefs(): ReaderPrefs {
  try {
    const raw = readPref(READER_PREFS_KEY)
    if (!raw) return DEFAULT_PREFS
    const parsed = JSON.parse(raw) as Partial<ReaderPrefs>
    const fontIdx = Number.isInteger(parsed.fontIdx) && parsed.fontIdx! >= 0 && parsed.fontIdx! < READER_FONT_STEPS.length ? parsed.fontIdx! : DEFAULT_PREFS.fontIdx
    const lineIdx = Number.isInteger(parsed.lineIdx) && parsed.lineIdx! >= 0 && parsed.lineIdx! < READER_LINE_HEIGHTS.length ? parsed.lineIdx! : DEFAULT_PREFS.lineIdx
    const theme = parsed.theme === 'sepia' || parsed.theme === 'night' ? parsed.theme : 'paper'
    return { fontIdx, lineIdx, theme, indent: parsed.indent ?? true, overridePublisher: parsed.overridePublisher ?? true, spread: parsed.spread === true }
  } catch {
    return DEFAULT_PREFS
  }
}

const HIGHLIGHT_COLORS: { color: HighlightColor; label: string; swatch: string }[] = [
  { color: 'yellow', label: '黄', swatch: 'bg-hl-yellow' },
  { color: 'green', label: '绿', swatch: 'bg-hl-green' },
  { color: 'blue', label: '蓝', swatch: 'bg-hl-blue' },
  { color: 'pink', label: '粉', swatch: 'bg-hl-pink' },
]

type SideTab = 'learn' | 'chat' | 'lineage'

/** 浮在正文上的操作条(选区 / 已有高亮) */
const FLOAT_BAR = 'absolute top-3 left-1/2 z-30 flex -translate-x-1/2 items-center gap-1.5 rounded-m bg-popover px-2 py-1.5 shadow-popover ring-1 ring-sep/60'
/** 翻页圆钮:悬停正文或键盘聚焦时显现(点正文左右半页与 ←/→ 也能翻) */
const NAV_BTN = 'absolute top-1/2 z-20 flex size-9 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full bg-card/90 text-label-2 opacity-0 shadow-card ring-1 ring-sep/60 transition-opacity duration-[var(--dur-fast)] group-hover:opacity-100 hover:text-label-1 focus-visible:opacity-100'

/**
 * 阅读器(视觉改版第二批):工具栏带(返回 · 标题 · 目录/书签/标记/阅读设置 · 放大/收起侧栏),
 * 目录与阅读设置是锚定浮层;右栏是平铺检视列(分段控件切 学习模式/问书/脉络图);
 * 路由参数变化即重挂载:旧 blockId 的晚到结果随旧实例卸载而作废。
 */
export default function ReaderPage() {
  const { blockId: blockIdParam } = useParams()
  const blockId = Number(blockIdParam)
  return <ReaderPageContent key={blockId} blockId={blockId} />
}

function ReaderPageContent({ blockId }: { blockId: number }) {
  const [searchParams] = useSearchParams()
  const taskId = searchParams.get('task')
  const backTaskId = searchParams.get('back')
  const navigate = useNavigate()

  const epubRef = useRef<EpubHandle>(null)
  const [toc, setToc] = useState<NavItem[]>([])
  const [tocOpen, setTocOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [tocAnchor, setTocAnchor] = useState<HTMLElement | null>(null)
  const [settingsAnchor, setSettingsAnchor] = useState<HTMLElement | null>(null)
  const [prefs, setPrefs] = useState<ReaderPrefs>(loadPrefs)
  const { fontIdx, theme, lineIdx, indent, overridePublisher, spread } = prefs
  const updatePrefs = (patch: Partial<ReaderPrefs>) => {
    setPrefs(cur => {
      const next = { ...cur, ...patch }
      writePref(READER_PREFS_KEY, JSON.stringify(next))
      return next
    })
  }
  const setFontIdx = (next: number | ((cur: number) => number)) => updatePrefs({ fontIdx: typeof next === 'function' ? next(fontIdx) : next })
  const setTheme = (next: ReaderTheme) => updatePrefs({ theme: next })
  // BL-013:app「夜读模式」(data-theme=dark)驱动正文主题,否则用阅读设置里的主题
  const appTheme = useSession(s => s.theme)
  const effectiveTheme: ReaderTheme = appTheme === 'dark' ? 'night' : theme
  const typography: ReaderTypography = { lineHeight: READER_LINE_HEIGHTS[lineIdx], indent, overridePublisher }
  const [progress, setProgress] = useState(0)
  const [panelOpen, setPanelOpen] = useState(true)
  /** 右栏标签(spec 2026-09-16):有任务默认学习模式,否则只有「问书」 */
  const [sideTab, setSideTab] = useState<SideTab>(taskId !== null ? 'learn' : 'chat')
  /** BL-014:问书面板加宽切换 */
  const [chatWide, setChatWide] = useState(false)
  /** 脉络图默认放大(图需要横向空间),与问书的宽窄各记各的 */
  const [lineageWide, setLineageWide] = useState(true)
  const wide = sideTab === 'chat' ? chatWide : lineageWide
  const setWide = sideTab === 'chat' ? setChatWide : setLineageWide
  const [quoteDraft, setQuoteDraft] = useState<string | null>(null)
  const [currentHref, setCurrentHref] = useState('')
  const [marksOpen, setMarksOpen] = useState(false)
  const [marks, setMarks] = useState<ReaderMark[] | null>(null)
  const [selection, setSelection] = useState<SelectionInfo | null>(null)
  /** 点击正文里已有高亮后弹出的操作条(BL-007):记区间 CFI */
  const [activeHighlight, setActiveHighlight] = useState<string | null>(null)
  const positionTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** BL-018:防抖待写的最后阅读位置;卸载/切书时补写,避免丢最后一页 */
  const pendingPos = useRef<{ href: string; cfi: string } | null>(null)

  // 内容管线:块 → (原文 ‖ epub 地址),全部成功后才原子发布
  const content = useAsyncResource(useCallback(async (isCurrent: () => boolean): Promise<ReaderContent> => {
    const block = await backend.getBlock(blockId)
    if (!isCurrent()) throw new StaleResult()
    const [source, url, readerMarksInit, anchors] = await Promise.all([
      backend.blockSource(blockId),
      backend.epubUrl(block.bookId),
      backend.readerMarkList(block.bookId),
      backend.listAnchors(blockId),
    ])
    if (!isCurrent()) throw new StaleResult()
    const segments = anchors
      .filter(a => a.precision === 'exact')
      .map(a => ({ spineHref: a.spineHref, cfiStart: a.cfiStart, cfiEnd: a.cfiEnd }))
    const anchorHrefs = [...new Set(anchors.map(a => a.spineHref))]
    return { block, source, url, readerMarksInit, segments, anchorHrefs }
  }, [blockId]))
  const block = content.data?.block ?? null
  const source = content.data?.source ?? null
  const url = content.data?.url ?? null
  const initError = content.error
  const loadContent = content.reload

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // BL-020:焦点在输入框/文本域/可编辑处时,方向键用于移动光标,不翻页
      const el = e.target as HTMLElement | null
      const tag = el?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el?.isContentEditable) return
      // 脉络图画布用方向键选节点(它会 preventDefault),不翻页
      if (e.defaultPrevented) return
      // 焦点在浮层/菜单里(阅读设置、目录、书架菜单等)时不翻页
      if (el?.closest?.('[role="dialog"],[role="menu"]')) return
      // 有对话框开着(components/Dialog 在 <html> 打 data-modal-open)时不翻页
      if (isModalOpen()) return
      if (e.key === 'ArrowRight') epubRef.current?.next()
      if (e.key === 'ArrowLeft') epubRef.current?.prev()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // BL-012:正文选区靠指针层造(见 pointerLayer),原生 Cmd/Ctrl+C 复制不到;这里接管复制当前选区文本
  const copySelection = useCallback((text: string) => {
    if (!text) return
    const write = navigator.clipboard?.writeText?.(text)
    if (write && typeof write.catch === 'function') {
      write.catch(() => {
        /* 无剪贴板权限时静默;用户可再试或用系统菜单 */
      })
    }
  }, [])
  useEffect(() => {
    const onCopyKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'c' || e.key === 'C') && selection?.text) {
        copySelection(selection.text)
      }
    }
    window.addEventListener('keydown', onCopyKey)
    return () => window.removeEventListener('keydown', onCopyKey)
  }, [selection, copySelection])

  const learning = taskId !== null
  const ready = block !== null && source !== null && url !== null
  const goBack = () => (backTaskId ? navigate(`/feynman/${backTaskId}`) : navigate(-1))
  // 标记清单:内容管线里首次取到,之后按本地操作维护(不重拉整本书)
  const initialMarks = content.data?.readerMarksInit ?? []
  const currentMarks = marks ?? initialMarks
  const position = initialMarks.find(m => m.kind === 'position') ?? null
  // 起始定位(BL-018):回读原文(?back)强制到本块原文;否则优先回到上次阅读位置;都没有再按模式给块首/书首
  const blockStart = content.data?.segments[0]?.cfiStart ?? source?.href
  const initialHref = backTaskId ? blockStart : (position?.cfiStart ?? (learning ? blockStart : source?.href))
  const highlights = currentMarks.filter(m => m.kind === 'highlight' && m.cfiEnd).map(m => ({ cfiRange: m.cfiEnd as string, color: m.color }))
  const bookId = block?.bookId ?? null
  // 阅读时长(BL-025):书打开后开始计;可见且有操作才算
  useReadingClock(bookId, ready)

  const addMarkOp = useBackendOperation(async (mark: Parameters<typeof backend.readerMarkAdd>[1]) => {
    if (bookId === null) return
    const created = await backend.readerMarkAdd(bookId, mark)
    setMarks(cur => [...(cur ?? initialMarks).filter(m => m.id !== created.id), created])
  })
  const removeMarkOp = useBackendOperation(async (mark: ReaderMark) => {
    await backend.readerMarkRemove(mark.id)
    setMarks(cur => (cur ?? initialMarks).filter(m => m.id !== mark.id))
  })
  const recolorOp = useBackendOperation(async (mark: ReaderMark, color: HighlightColor) => {
    const updated = await backend.readerMarkUpdate(mark.id, null, color)
    setMarks(cur => (cur ?? initialMarks).map(m => (m.id === updated.id ? updated : m)))
  })
  const markError = addMarkOp.errors.get('add') ?? removeMarkOp.errors.get('remove') ?? recolorOp.errors.get('recolor')
  const activeMark = activeHighlight ? (marks ?? initialMarks).find(m => m.kind === 'highlight' && m.cfiStart === activeHighlight) ?? null : null

  const addBookmark = () => {
    const loc = epubRef.current?.currentLocation()
    if (!loc || bookId === null) return
    addMarkOp.clearError('add')
    void addMarkOp.run('add', { kind: 'bookmark', spineHref: loc.href, cfiStart: loc.cfi, text: block ? `${block.moduleName} · ${block.title}` : loc.href })
  }
  const addHighlight = (color: HighlightColor) => {
    if (!selection || bookId === null) return
    const sel = selection
    setSelection(null)
    epubRef.current?.clearSelection()
    addMarkOp.clearError('add')
    // 区间 CFI 存在 cfiEnd;cfiStart 记同一区间起点(epub.js annotations 按区间工作)
    void addMarkOp.run('add', { kind: 'highlight', spineHref: sel.href, cfiStart: sel.cfiRange, cfiEnd: sel.cfiRange, text: sel.text.slice(0, 400), color })
  }
  const onRelocated = (loc: { cfi: string; href: string }) => {
    setCurrentHref(loc.href)
    if (bookId === null) return
    pendingPos.current = { href: loc.href, cfi: loc.cfi }
    if (positionTimer.current) clearTimeout(positionTimer.current)
    positionTimer.current = setTimeout(() => {
      pendingPos.current = null
      backend.readerPositionSet(bookId, loc.href, loc.cfi).catch(() => {
        /* 位置写回失败只影响下次起点 */
      })
    }, READER_POSITION_DEBOUNCE_MS)
  }
  // 卸载/切书:清定时器并把待写位置立即补写(BL-018:翻页后 800ms 内点返回也不丢位置)
  useEffect(() => () => {
    if (positionTimer.current) clearTimeout(positionTimer.current)
    const p = pendingPos.current
    if (p && bookId !== null) {
      pendingPos.current = null
      backend.readerPositionSet(bookId, p.href, p.cfi).catch(() => {})
    }
  }, [bookId])

  const sideTabName = sideTab === 'learn' ? '学习模式' : sideTab === 'lineage' ? '脉络图' : '问书'
  const tabOptions: SegmentedOption<SideTab>[] = [
    ...(learning ? [{ value: 'learn' as const, label: '学习模式', icon: 'book-closed' as const, controls: 'reader-learn-panel' }] : []),
    { value: 'chat', label: '问书', icon: 'quote-bubble', controls: 'reader-chat-panel' },
    { value: 'lineage', label: '脉络图', icon: 'map', controls: 'reader-lineage-panel' },
  ]
  const progressPct = Math.round(progress * 100)

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Toolbar aria-label="阅读器工具栏">
        {backTaskId ? (
          <Button size="sm" onClick={goBack}>返回讲授</Button>
        ) : (
          <IconButton icon="chevron-left" label="返回" onClick={goBack} />
        )}
        <div data-tauri-drag-region className="min-w-0 flex-1 px-2 text-center">
          <span className="block truncate font-serif text-body font-semibold text-label-1">
            {block ? `${block.moduleName} · ${block.title}` : '阅读'}
          </span>
        </div>
        {ready && (
          <>
            <IconButton ref={setTocAnchor} icon="list-bullet" label="目录" aria-haspopup="dialog" expanded={tocOpen} onClick={() => setTocOpen(o => !o)} />
            <IconButton icon="bookmark" label="书签" onClick={addBookmark} disabled={addMarkOp.pending.has('add')} />
            <IconButton icon="highlighter" label="标记" expanded={marksOpen} onClick={() => setMarksOpen(o => !o)} />
            <IconButton ref={setSettingsAnchor} icon="text-size" label="阅读设置" aria-haspopup="dialog" expanded={settingsOpen} onClick={() => setSettingsOpen(o => !o)} />
            <ToolbarDivider />
            {panelOpen && sideTab !== 'learn' && (
              <IconButton
                icon={wide ? 'arrows-collapse' : 'arrows-expand'}
                label={`${wide ? '收窄' : '放大'}${sideTab === 'chat' ? '对话' : ''}`}
                onClick={() => setWide(w => !w)}
              />
            )}
            <IconButton icon="sidebar-right" label={panelOpen ? '收起侧栏' : '展开侧栏'} onClick={() => setPanelOpen(o => !o)} />
          </>
        )}
      </Toolbar>

      <div className="flex min-h-0 flex-1">
        <div className="group relative min-w-0 flex-1">
          {/* 正文 */}
          {initError ? (
            <div className="p-10">
              <AsyncError error={initError} onRetry={loadContent} />
            </div>
          ) : ready ? (
            <div className={`mx-auto h-full w-full ${spread ? 'max-w-[80em]' : 'max-w-[38em]'}`} data-testid="reader-column">
              <EpubView
                ref={epubRef}
                url={url}
                fontSizePct={`${READER_FONT_STEPS[fontIdx]}%`}
                theme={effectiveTheme}
                typography={typography}
                initialHref={initialHref}
                highlights={highlights}
                blockSegments={learning ? content.data?.segments : undefined}
                onToc={setToc}
                onProgress={setProgress}
                onSelected={sel => { setActiveHighlight(null); setSelection(sel) }}
                onRelocated={onRelocated}
                spread={spread}
                onHighlightClicked={cfi => { setSelection(null); setActiveHighlight(cfi) }}
              />
            </div>
          ) : (
            <div aria-busy="true" className="mx-auto max-w-[38em] px-10 py-12">
              <Skeleton lines={9} />
            </div>
          )}

          {/* 翻页按钮;点正文左右半页翻页由 EpubView 的指针层负责(BL-009/BL-011) */}
          {ready && (
            <>
              <button type="button" aria-label="上一页" onClick={() => epubRef.current?.prev()} className={`${NAV_BTN} left-3`}>
                <Icon name="chevron-left" size={18} />
              </button>
              <button type="button" aria-label="下一页" onClick={() => epubRef.current?.next()} className={`${NAV_BTN} right-3`}>
                <Icon name="chevron-right" size={18} />
              </button>
            </>
          )}

          {/* 已有高亮的操作条(BL-007):换色 / 取消高亮 */}
          {activeMark && (
            <div role="toolbar" aria-label="高亮操作" className={FLOAT_BAR}>
              <span className="max-w-48 truncate px-1 text-footnote text-label-3">{activeMark.text || '高亮'}</span>
              {HIGHLIGHT_COLORS.map(c => (
                <button
                  key={c.color}
                  type="button"
                  aria-label={`改为:${c.label}`}
                  aria-pressed={activeMark.color === c.color}
                  disabled={recolorOp.pending.size > 0}
                  onClick={() => { recolorOp.clearError('recolor'); void recolorOp.run('recolor', activeMark, c.color) }}
                  className={`size-5 cursor-pointer rounded-full ring-offset-1 ring-offset-popover ${c.swatch} ${activeMark.color === c.color ? 'ring-2 ring-accent' : 'ring-1 ring-sep-strong/60 hover:ring-accent/60'}`}
                />
              ))}
              <button
                type="button"
                className="cursor-pointer rounded-s px-2 py-1 text-callout font-medium text-weak hover:bg-weak-soft disabled:cursor-not-allowed disabled:opacity-40"
                disabled={removeMarkOp.pending.size > 0}
                onClick={() => { const m = activeMark; setActiveHighlight(null); removeMarkOp.clearError('remove'); void removeMarkOp.run('remove', m) }}
              >
                取消高亮
              </button>
              <IconButton icon="xmark" label="关闭" size="sm" onClick={() => setActiveHighlight(null)} />
            </div>
          )}

          {/* 选区工具条:高亮四色 / 复制 / 问 AI */}
          {selection && (
            <div role="toolbar" aria-label="选区操作" className={FLOAT_BAR}>
              <span className="max-w-48 truncate px-1 text-footnote text-label-3">{selection.text || '已选中'}</span>
              {HIGHLIGHT_COLORS.map(c => (
                <button
                  key={c.color}
                  type="button"
                  aria-label={`高亮:${c.label}`}
                  className={`size-5 cursor-pointer rounded-full ring-1 ring-sep-strong/60 ring-offset-1 ring-offset-popover hover:ring-accent/60 ${c.swatch}`}
                  onClick={() => addHighlight(c.color)}
                />
              ))}
              <Button variant="ghost" size="sm" aria-label="复制" onClick={() => { copySelection(selection.text); setSelection(null); epubRef.current?.clearSelection() }}>
                复制
              </Button>
              <Button
                variant="ghost"
                size="sm"
                aria-label="问 AI"
                onClick={() => {
                  setQuoteDraft(selection.text)
                  setSideTab('chat')
                  setPanelOpen(true)
                  setSelection(null)
                  epubRef.current?.clearSelection()
                }}
              >
                <Icon name="quote-bubble" size={14} />
                问 AI
              </Button>
              <IconButton icon="xmark" label="取消" size="sm" onClick={() => { setSelection(null); epubRef.current?.clearSelection() }} />
            </div>
          )}
          {markError && (
            <div className="absolute top-14 left-1/2 z-30 -translate-x-1/2">
              <AsyncError error={markError} variant="compact" />
            </div>
          )}
          {marksOpen && ready && (
            <MarksPanel
              marks={currentMarks}
              onJump={mark => { epubRef.current?.display(mark.kind === 'highlight' ? (mark.cfiEnd ?? mark.cfiStart) : mark.cfiStart); setMarksOpen(false) }}
              onRemove={mark => { removeMarkOp.clearError('remove'); void removeMarkOp.run('remove', mark) }}
              onClose={() => setMarksOpen(false)}
            />
          )}
        </div>

        {/* 右栏:平铺检视列。有任务 → 学习模式/问书/脉络图;无任务 → 问书/脉络图 */}
        {ready && (
          <div className="flex shrink-0 items-stretch">
            {!panelOpen && (
              <button
                type="button"
                className="my-auto cursor-pointer rounded-l-m border border-r-0 border-sep bg-card px-1.5 py-5 text-footnote text-label-2 shadow-card transition-colors duration-[var(--dur-fast)] [writing-mode:vertical-rl] hover:text-label-1"
                onClick={() => setPanelOpen(true)}
              >
                {sideTabName}
              </button>
            )}
            {/* BL-017:收起只隐藏、不卸载,进行中的问书对话与「思考中」跨收起保留 */}
            <div hidden={!panelOpen} className="flex">
              <aside
                aria-label="阅读辅助"
                className={`flex min-h-0 flex-col border-l border-sep bg-content ${sideTab === 'learn' ? 'w-72' : wide ? 'w-[40rem] max-w-[78vw]' : 'w-96'}`}
              >
                <div className="flex h-11 shrink-0 items-center border-b border-sep px-3">
                  <Segmented<SideTab> semantics="tabs" aria-label="侧栏" value={sideTab} onChange={setSideTab} options={tabOptions} />
                </div>
                {learning && (
                  <div id="reader-learn-panel" role="tabpanel" aria-label="学习模式" hidden={sideTab !== 'learn'} className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4" data-testid="learn-panel">
                    <h2 className="font-serif text-title3 font-semibold text-label-1">{block.title}</h2>
                    <p className="text-footnote text-label-3">
                      {block.moduleName} · 原文 {source?.href ?? '…'}
                    </p>
                    {source && (
                      <p className="line-clamp-6 border-l-2 border-sep pl-3 text-callout leading-relaxed text-label-2">
                        {source.text}
                      </p>
                    )}
                    <p className="text-callout leading-relaxed text-label-3">
                      读透之后,把书合上——用自己的话讲给学生听,讲不清的地方就是漏洞。
                    </p>
                    <Button variant="primary" className="mt-auto" onClick={() => navigate(`/feynman/${taskId}`)}>
                      开始费曼讲授
                    </Button>
                  </div>
                )}
                <div id="reader-chat-panel" role="tabpanel" aria-label="问书" hidden={sideTab !== 'chat'} className="flex min-h-0 flex-1 flex-col p-3" data-testid="chat-panel">
                  <ReadingChatPanel
                    bookId={block.bookId}
                    currentHref={currentHref || position?.spineHref || source.href}
                    blockIdForHref={href => (content.data?.anchorHrefs.includes(href) ? blockId : null)}
                    quoteDraft={quoteDraft}
                    onQuoteConsumed={() => setQuoteDraft(null)}
                  />
                </div>
                {/* 脉络图(plan 2026-09-19):按进度合成图;收起只隐藏、不卸载,保留手改草稿 */}
                <div id="reader-lineage-panel" role="tabpanel" aria-label="脉络图" hidden={sideTab !== 'lineage'} className="flex min-h-0 flex-1 flex-col p-3" data-testid="lineage-panel">
                  <LineagePanel
                    bookId={block.bookId}
                    onGoto={href => epubRef.current?.display(href)}
                    onAsk={text => {
                      setQuoteDraft(text)
                      setSideTab('chat')
                    }}
                  />
                </div>
              </aside>
            </div>
          </div>
        )}
      </div>

      {/* 进度条 */}
      {ready && (
        <div className="flex shrink-0 items-center gap-3 border-t border-sep bg-content px-4 py-1.5">
          <ProgressBar value={progress} size="sm" label="阅读进度" />
          <span className="w-8 text-right text-footnote text-label-3 tabular-nums">{progressPct}%</span>
        </div>
      )}

      {/* 目录浮层 */}
      <Popover open={tocOpen} onClose={() => setTocOpen(false)} anchor={tocAnchor} aria-label="目录" placement="bottom-end" className="w-72 p-1">
        <h2 className="px-2 pt-1.5 pb-1 font-serif text-subhead font-semibold text-label-3">目录</h2>
        <ul className="flex flex-col">
          {toc.map(item => (
            <li key={item.id ?? item.href}>
              <button
                type="button"
                className="flex h-7 w-full cursor-pointer items-center rounded-s px-2 text-left text-body text-label-1 transition-colors duration-[var(--dur-fast)] hover:bg-fill-hover"
                onClick={() => {
                  epubRef.current?.display(item.href)
                  setTocOpen(false)
                }}
              >
                <span className="truncate">{item.label?.trim()}</span>
              </button>
            </li>
          ))}
          {toc.length === 0 && <li className="px-2 py-1.5 text-footnote text-label-3">本书没有目录</li>}
        </ul>
      </Popover>

      {/* 阅读设置浮层 */}
      <Popover open={settingsOpen} onClose={() => setSettingsOpen(false)} anchor={settingsAnchor} aria-label="阅读设置" placement="bottom-end" className="w-72 p-4">
        <div className="flex items-center justify-between">
          <span className="text-callout text-label-2">字号</span>
          <div className="flex items-center gap-1">
            <Button size="sm" aria-label="减小字号" className="w-8 px-0 font-serif" disabled={fontIdx === 0} onClick={() => setFontIdx(i => Math.max(0, i - 1))}>
              A−
            </Button>
            <span className="w-11 text-center text-footnote text-label-2 tabular-nums">{READER_FONT_STEPS[fontIdx]}%</span>
            <Button
              size="sm"
              aria-label="增大字号"
              className="w-8 px-0 font-serif"
              disabled={fontIdx === READER_FONT_STEPS.length - 1}
              onClick={() => setFontIdx(i => Math.min(READER_FONT_STEPS.length - 1, i + 1))}
            >
              A+
            </Button>
          </div>
        </div>
        <div className="mt-3 flex items-center justify-between">
          <span className="text-callout text-label-2">主题</span>
          <div className="flex items-center gap-2">
            {THEME_OPTIONS.map(t => (
              <button
                key={t.name}
                type="button"
                aria-label={`主题:${t.label}`}
                aria-pressed={theme === t.name}
                onClick={() => setTheme(t.name)}
                className={`size-6 cursor-pointer rounded-full border ring-offset-2 ring-offset-popover transition-shadow duration-[var(--dur-fast)] ${t.swatchClass} ${theme === t.name ? 'ring-2 ring-accent' : 'hover:ring-2 hover:ring-accent/40'}`}
              />
            ))}
          </div>
        </div>
        <div className="mt-3 flex items-center justify-between">
          <span className="text-callout text-label-2">行高</span>
          <div role="group" aria-label="行高" className="inline-flex gap-0.5 rounded-m bg-inset p-0.5">
            {READER_LINE_HEIGHTS.map((lh, i) => (
              <button
                key={lh}
                type="button"
                aria-label={`行高:${lh}`}
                aria-pressed={lineIdx === i}
                onClick={() => updatePrefs({ lineIdx: i })}
                className={`h-5 cursor-pointer rounded-s px-2 text-footnote font-medium tabular-nums transition-colors duration-[var(--dur-fast)] ${lineIdx === i ? 'bg-card text-label-1 shadow-card' : 'text-label-2 hover:text-label-1'}`}
              >
                {lh}
              </button>
            ))}
          </div>
        </div>
        <div className="mt-3 flex flex-col gap-2 border-t border-sep pt-3">
          <Checkbox label="段首缩进" checked={indent} disabled={!overridePublisher} onChange={e => updatePrefs({ indent: e.target.checked })} />
          <Checkbox label="双页显示" checked={spread} onChange={e => updatePrefs({ spread: e.target.checked })} />
          <Checkbox label="覆盖出版方样式" checked={overridePublisher} onChange={e => updatePrefs({ overridePublisher: e.target.checked })} />
        </div>
        <p className="mt-2 text-footnote leading-relaxed text-label-3">关闭覆盖时只保留主题配色,字体/行高/版心交给书自带样式。</p>
      </Popover>
    </div>
  )
}
