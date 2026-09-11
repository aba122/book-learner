import type { NavItem } from 'epubjs'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { backend } from '../../backend'
import AsyncError from '../../components/AsyncError'
import Button from '../../components/Button'
import Card from '../../components/Card'
import Tag from '../../components/Tag'
import { READER_FONT_DEFAULT_IDX, READER_FONT_STEPS, READER_LINE_HEIGHTS, READER_LINE_HEIGHT_DEFAULT_IDX, READER_POSITION_DEBOUNCE_MS, READER_PREFS_KEY } from '../../config'
import { readPref, writePref } from '../../lib/prefs'
import { useBackendOperation } from '../../lib/useBackendOperation'
import { StaleResult, useAsyncResource } from '../../lib/useAsyncResource'
import type { HighlightColor, KnowledgeBlock, ReaderMark } from '../../types'
import EpubView, { type EpubHandle, type ReaderTheme, type ReaderTypography, type SelectionInfo } from './EpubView'
import MarksPanel from './MarksPanel'

const THEME_OPTIONS: { name: ReaderTheme; label: string; swatchClass: string }[] = [
  { name: 'paper', label: '纸白', swatchClass: 'bg-paper-2 border-line' },
  { name: 'sepia', label: '羊皮', swatchClass: 'bg-review-soft border-review' },
  { name: 'night', label: '夜读', swatchClass: 'bg-ink-1 border-ink-2' },
]

interface ReaderContent {
  block: KnowledgeBlock
  source: { href: string; text: string }
  url: string
  /** 首次取到的标记(含上次阅读位置);之后按本地操作维护 */
  readerMarksInit: ReaderMark[]
  /** 块锚点段(学习模式下画下划线;chapter_fallback 段无区间,跳过) */
  segments: { spineHref: string; cfiStart: string; cfiEnd: string }[]
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
  { color: 'yellow', label: '黄', swatch: 'bg-yellow-300' },
  { color: 'green', label: '绿', swatch: 'bg-green-300' },
  { color: 'blue', label: '蓝', swatch: 'bg-blue-300' },
  { color: 'pink', label: '粉', swatch: 'bg-pink-300' },
]

/** 路由参数变化即重挂载:旧 blockId 的晚到结果随旧实例卸载而作废。 */
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
  const typography: ReaderTypography = { lineHeight: READER_LINE_HEIGHTS[lineIdx], indent, overridePublisher }
  const [progress, setProgress] = useState(0)
  const [panelOpen, setPanelOpen] = useState(true)
  const [marksOpen, setMarksOpen] = useState(false)
  const [marks, setMarks] = useState<ReaderMark[] | null>(null)
  const [selection, setSelection] = useState<SelectionInfo | null>(null)
  /** 点击正文里已有高亮后弹出的操作条(BL-007):记区间 CFI */
  const [activeHighlight, setActiveHighlight] = useState<string | null>(null)
  const positionTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

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
    return { block, source, url, readerMarksInit, segments }
  }, [blockId]))
  const block = content.data?.block ?? null
  const source = content.data?.source ?? null
  const url = content.data?.url ?? null
  const initError = content.error
  const loadContent = content.reload

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') epubRef.current?.next()
      if (e.key === 'ArrowLeft') epubRef.current?.prev()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const learning = taskId !== null
  const ready = block !== null && source !== null && url !== null
  const goBack = () => (backTaskId ? navigate(`/feynman/${backTaskId}`) : navigate(-1))
  // 标记清单:内容管线里首次取到,之后按本地操作维护(不重拉整本书)
  const initialMarks = content.data?.readerMarksInit ?? []
  const currentMarks = marks ?? initialMarks
  const position = initialMarks.find(m => m.kind === 'position') ?? null
  const highlights = currentMarks.filter(m => m.kind === 'highlight' && m.cfiEnd).map(m => ({ cfiRange: m.cfiEnd as string, color: m.color }))
  const bookId = block?.bookId ?? null

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
    if (bookId === null) return
    if (positionTimer.current) clearTimeout(positionTimer.current)
    positionTimer.current = setTimeout(() => {
      backend.readerPositionSet(bookId, loc.href, loc.cfi).catch(() => {
        /* 位置写回失败只影响下次起点 */
      })
    }, READER_POSITION_DEBOUNCE_MS)
  }
  useEffect(() => () => { if (positionTimer.current) clearTimeout(positionTimer.current) }, [])

  return (
    <div className="flex h-full flex-col">
      {/* 顶栏 */}
      <div className="flex items-center gap-3 border-b border-line bg-paper-2/70 px-5 py-2.5">
        <Button
          className="px-3 py-1.5 text-xs"
          onClick={goBack}
        >
          {backTaskId ? '返回讲授' : '← 返回'}
        </Button>
        <div className="min-w-0 flex-1 text-center">
          <span className="truncate font-serif text-sm text-ink-2">
            {block ? `${block.moduleName} · ${block.title}` : '阅读'}
          </span>
        </div>
        {ready && (
          <>
            <Button className="px-3 py-1.5 text-xs" onClick={() => setTocOpen(o => !o)}>
              目录
            </Button>
            <Button className="px-3 py-1.5 text-xs" onClick={addBookmark} disabled={addMarkOp.pending.has('add')}>
              书签
            </Button>
            <Button className="px-3 py-1.5 text-xs" onClick={() => setMarksOpen(o => !o)}>
              标记
            </Button>
            <Button
              className="px-3 py-1.5 text-xs"
              aria-label="阅读设置"
              onClick={() => setSettingsOpen(o => !o)}
            >
              Aa
            </Button>
          </>
        )}
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1">
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
              theme={theme}
              typography={typography}
              initialHref={learning ? (content.data?.segments[0]?.cfiStart ?? source?.href) : (position?.cfiStart ?? source?.href)}
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
          <p className="p-10 text-sm text-ink-3">正在打开书籍…</p>
        )}

        {/* 翻页按钮;点正文左右半页翻页由 EpubView 的指针层负责(BL-009/BL-011) */}
        {ready && (
          <>
            <button
              aria-label="上一页"
              onClick={() => epubRef.current?.prev()}
              className="absolute top-1/2 left-2 z-20 -translate-y-1/2 cursor-pointer rounded-full px-3 py-2 text-xl text-ink-4 transition-colors hover:bg-paper-3 hover:text-ink-1"
            >
              ‹
            </button>
            <button
              aria-label="下一页"
              onClick={() => epubRef.current?.next()}
              className="absolute top-1/2 right-2 z-20 -translate-y-1/2 cursor-pointer rounded-full px-3 py-2 text-xl text-ink-4 transition-colors hover:bg-paper-3 hover:text-ink-1"
            >
              ›
            </button>
          </>
        )}

        {/* 已有高亮的操作条(BL-007):换色 / 取消高亮 */}
        {activeMark && (
          <div role="toolbar" aria-label="高亮操作" className="absolute top-3 left-1/2 z-30 flex -translate-x-1/2 items-center gap-2 rounded-m border border-line bg-paper-2 px-3 py-2 shadow-pop">
            <span className="max-w-48 truncate text-xs text-ink-3">{activeMark.text || '高亮'}</span>
            {HIGHLIGHT_COLORS.map(c => (
              <button
                key={c.color}
                aria-label={`改为:${c.label}`}
                aria-pressed={activeMark.color === c.color}
                disabled={recolorOp.pending.size > 0}
                onClick={() => { recolorOp.clearError('recolor'); void recolorOp.run('recolor', activeMark, c.color) }}
                className={`h-5 w-5 cursor-pointer rounded-full border border-line ${c.swatch} ${activeMark.color === c.color ? 'ring-2 ring-ink-3' : ''}`}
              />
            ))}
            <button
              className="cursor-pointer text-xs text-weak hover:underline"
              disabled={removeMarkOp.pending.size > 0}
              onClick={() => { const m = activeMark; setActiveHighlight(null); removeMarkOp.clearError('remove'); void removeMarkOp.run('remove', m) }}
            >
              取消高亮
            </button>
            <button className="cursor-pointer text-xs text-ink-4 hover:text-ink-1" onClick={() => setActiveHighlight(null)}>关闭</button>
          </div>
        )}

        {/* 选区工具条:高亮四色 */}
        {selection && (
          <div role="toolbar" aria-label="选区操作" className="absolute top-3 left-1/2 z-30 flex -translate-x-1/2 items-center gap-2 rounded-m border border-line bg-paper-2 px-3 py-2 shadow-pop">
            <span className="max-w-48 truncate text-xs text-ink-3">{selection.text || '已选中'}</span>
            {HIGHLIGHT_COLORS.map(c => (
              <button
                key={c.color}
                aria-label={`高亮:${c.label}`}
                className={`h-5 w-5 cursor-pointer rounded-full border border-line ${c.swatch}`}
                onClick={() => addHighlight(c.color)}
              />
            ))}
            <button className="cursor-pointer text-xs text-ink-4 hover:text-ink-1" onClick={() => { setSelection(null); epubRef.current?.clearSelection() }}>取消</button>
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

        {/* 目录抽屉 */}
        {tocOpen && (
          <div className="absolute inset-y-0 left-0 z-30 w-72 overflow-y-auto border-r border-line bg-paper-2 p-5 shadow-pop">
            <h2 className="mb-3 font-serif text-base font-semibold text-ink-1">目录</h2>
            <ul className="flex flex-col gap-1">
              {toc.map(item => (
                <li key={item.id ?? item.href}>
                  <button
                    className="w-full cursor-pointer rounded-s px-2 py-1.5 text-left text-sm text-ink-2 transition-colors hover:bg-paper-3 hover:text-ink-1"
                    onClick={() => {
                      epubRef.current?.display(item.href)
                      setTocOpen(false)
                    }}
                  >
                    {item.label?.trim()}
                  </button>
                </li>
              ))}
              {toc.length === 0 && <li className="text-xs text-ink-4">(本书没有目录)</li>}
            </ul>
          </div>
        )}

        {/* 设置浮层 */}
        {settingsOpen && (
          <Card className="absolute top-3 right-3 z-30 w-64 p-4 shadow-pop">
            <div className="flex items-center justify-between">
              <span className="text-xs text-ink-3">字号</span>
              <div className="flex items-center gap-2">
                <Button
                  className="px-2.5 py-1 text-xs"
                  aria-label="减小字号"
                  disabled={fontIdx === 0}
                  onClick={() => setFontIdx(i => Math.max(0, i - 1))}
                >
                  A−
                </Button>
                <span className="w-10 text-center text-xs text-ink-2 tabular-nums">
                  {READER_FONT_STEPS[fontIdx]}%
                </span>
                <Button
                  className="px-2.5 py-1 text-xs"
                  aria-label="增大字号"
                  disabled={fontIdx === READER_FONT_STEPS.length - 1}
                  onClick={() => setFontIdx(i => Math.min(READER_FONT_STEPS.length - 1, i + 1))}
                >
                  A+
                </Button>
              </div>
            </div>
            <div className="mt-4 flex items-center justify-between">
              <span className="text-xs text-ink-3">主题</span>
              <div className="flex items-center gap-2">
                {THEME_OPTIONS.map(t => (
                  <button
                    key={t.name}
                    aria-label={`主题:${t.label}`}
                    onClick={() => setTheme(t.name)}
                    className={`h-7 w-7 cursor-pointer rounded-full border-2 ${t.swatchClass} ${
                      theme === t.name ? 'ring-2 ring-new' : ''
                    }`}
                  />
                ))}
              </div>
            </div>
            <div className="mt-4 flex items-center justify-between">
              <span className="text-xs text-ink-3">行高</span>
              <div className="flex items-center gap-1">
                {READER_LINE_HEIGHTS.map((lh, i) => (
                  <button
                    key={lh}
                    aria-label={`行高:${lh}`}
                    aria-pressed={lineIdx === i}
                    onClick={() => updatePrefs({ lineIdx: i })}
                    className={`cursor-pointer rounded-s px-2 py-1 text-xs ${lineIdx === i ? 'bg-new-soft text-new' : 'text-ink-3 hover:text-ink-1'}`}
                  >
                    {lh}
                  </button>
                ))}
              </div>
            </div>
            <label className="mt-3 flex items-center justify-between text-xs text-ink-3">
              段首缩进
              <input type="checkbox" checked={indent} disabled={!overridePublisher} onChange={e => updatePrefs({ indent: e.target.checked })} />
            </label>
            <label className="mt-2 flex items-center justify-between text-xs text-ink-3">
              双页显示
              <input type="checkbox" checked={spread} onChange={e => updatePrefs({ spread: e.target.checked })} />
            </label>
            <label className="mt-2 flex items-center justify-between text-xs text-ink-3">
              覆盖出版方样式
              <input type="checkbox" checked={overridePublisher} onChange={e => updatePrefs({ overridePublisher: e.target.checked })} />
            </label>
            <p className="mt-2 text-[11px] leading-relaxed text-ink-4">关闭覆盖时只保留主题配色,字体/行高/版心交给书自带样式。</p>
          </Card>
        )}

        </div>

        {/* 学习模式侧栏(分栏,不遮翻页) */}
        {learning && ready && (
          <div className="flex shrink-0 items-stretch border-l border-line bg-paper-1">
            {panelOpen ? (
              <Card className="m-3 flex w-72 flex-col gap-3 overflow-y-auto p-5">
                <div className="flex items-center justify-between">
                  <Tag tone="new">学习模式</Tag>
                  <button
                    className="cursor-pointer text-xs text-ink-4 hover:text-ink-1"
                    onClick={() => setPanelOpen(false)}
                  >
                    收起 ›
                  </button>
                </div>
                <h2 className="font-serif text-lg font-semibold text-ink-1">{block.title}</h2>
                <p className="text-xs text-ink-3">
                  {block.moduleName} · 原文 {source?.href ?? '…'}
                </p>
                {source && (
                  <p className="line-clamp-6 border-l-2 border-line pl-3 text-xs leading-relaxed text-ink-2">
                    {source.text}
                  </p>
                )}
                <p className="text-xs leading-relaxed text-ink-3">
                  读透之后,把书合上——用自己的话讲给学生听,讲不清的地方就是漏洞。
                </p>
                <Button
                  variant="primary"
                  className="mt-auto"
                  onClick={() => navigate(`/feynman/${taskId}`)}
                >
                  开始费曼讲授
                </Button>
              </Card>
            ) : (
              <button
                className="my-auto mr-0 cursor-pointer rounded-l-m border border-line bg-paper-2 px-1.5 py-6 text-xs text-ink-3 shadow-card hover:text-ink-1"
                onClick={() => setPanelOpen(true)}
              >
                学习模式
              </button>
            )}
          </div>
        )}
      </div>

      {/* 进度条 */}
      {ready && <div className="flex items-center gap-3 border-t border-line bg-paper-2/70 px-5 py-1.5">
        <div className="h-1 flex-1 overflow-hidden rounded-full bg-paper-3">
          <div
            className="h-full rounded-full bg-review transition-[width] duration-300"
            style={{ width: `${Math.round(progress * 100)}%` }}
          />
        </div>
        <span className="text-[11px] text-ink-4 tabular-nums">{Math.round(progress * 100)}%</span>
      </div>}
    </div>
  )
}
