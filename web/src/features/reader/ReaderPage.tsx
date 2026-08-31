import type { NavItem } from 'epubjs'
import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { backend } from '../../backend'
import Button from '../../components/Button'
import Card from '../../components/Card'
import Tag from '../../components/Tag'
import { READER_FONT_DEFAULT_IDX, READER_FONT_STEPS } from '../../config'
import type { KnowledgeBlock } from '../../types'
import EpubView, { type EpubHandle, type ReaderTheme } from './EpubView'

const THEME_OPTIONS: { name: ReaderTheme; label: string; swatchClass: string }[] = [
  { name: 'paper', label: '纸白', swatchClass: 'bg-paper-2 border-line' },
  { name: 'sepia', label: '羊皮', swatchClass: 'bg-review-soft border-review' },
  { name: 'night', label: '夜读', swatchClass: 'bg-ink-1 border-ink-2' },
]

export default function ReaderPage() {
  const { blockId: blockIdParam } = useParams()
  const blockId = Number(blockIdParam)
  const [searchParams] = useSearchParams()
  const taskId = searchParams.get('task')
  const backTaskId = searchParams.get('back')
  const navigate = useNavigate()

  const epubRef = useRef<EpubHandle>(null)
  const [url, setUrl] = useState<string | null>(null)
  const [block, setBlock] = useState<KnowledgeBlock | null>(null)
  const [source, setSource] = useState<{ href: string; text: string } | null>(null)
  const [toc, setToc] = useState<NavItem[]>([])
  const [tocOpen, setTocOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [fontIdx, setFontIdx] = useState(READER_FONT_DEFAULT_IDX)
  const [theme, setTheme] = useState<ReaderTheme>('paper')
  const [progress, setProgress] = useState(0)
  const [panelOpen, setPanelOpen] = useState(true)

  useEffect(() => {
    let alive = true
    ;(async () => {
      const b = await backend.getBlock(blockId)
      if (!alive) return
      setBlock(b)
      const [src, epub] = await Promise.all([
        backend.blockSource(blockId),
        backend.epubUrl(b.bookId),
      ])
      if (!alive) return
      setSource(src)
      setUrl(epub)
    })()
    return () => {
      alive = false
    }
  }, [blockId])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') epubRef.current?.next()
      if (e.key === 'ArrowLeft') epubRef.current?.prev()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const learning = taskId !== null

  return (
    <div className="flex h-full flex-col">
      {/* 顶栏 */}
      <div className="flex items-center gap-3 border-b border-line bg-paper-2/70 px-5 py-2.5">
        <Button
          className="px-3 py-1.5 text-xs"
          onClick={() => (backTaskId ? navigate(`/feynman/${backTaskId}`) : navigate(-1))}
        >
          {backTaskId ? '返回讲授' : '← 返回'}
        </Button>
        <div className="min-w-0 flex-1 text-center">
          <span className="truncate font-serif text-sm text-ink-2">
            {block ? `${block.moduleName} · ${block.title}` : '阅读'}
          </span>
        </div>
        <Button className="px-3 py-1.5 text-xs" onClick={() => setTocOpen(o => !o)}>
          目录
        </Button>
        <Button
          className="px-3 py-1.5 text-xs"
          aria-label="阅读设置"
          onClick={() => setSettingsOpen(o => !o)}
        >
          Aa
        </Button>
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1">
        {/* 正文 */}
        {url ? (
          <EpubView
            ref={epubRef}
            url={url}
            fontSizePct={`${READER_FONT_STEPS[fontIdx]}%`}
            theme={theme}
            initialHref={source?.href}
            onToc={setToc}
            onProgress={setProgress}
          />
        ) : (
          <p className="p-10 text-sm text-ink-3">正在打开书籍…</p>
        )}

        {/* 翻页 */}
        <button
          aria-label="上一页"
          onClick={() => epubRef.current?.prev()}
          className="absolute top-1/2 left-2 -translate-y-1/2 cursor-pointer rounded-full px-3 py-2 text-xl text-ink-4 transition-colors hover:bg-paper-3 hover:text-ink-1"
        >
          ‹
        </button>
        <button
          aria-label="下一页"
          onClick={() => epubRef.current?.next()}
          className="absolute top-1/2 right-2 -translate-y-1/2 cursor-pointer rounded-full px-3 py-2 text-xl text-ink-4 transition-colors hover:bg-paper-3 hover:text-ink-1"
        >
          ›
        </button>

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
          </Card>
        )}

        </div>

        {/* 学习模式侧栏(分栏,不遮翻页) */}
        {learning && block && (
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
      <div className="flex items-center gap-3 border-t border-line bg-paper-2/70 px-5 py-1.5">
        <div className="h-1 flex-1 overflow-hidden rounded-full bg-paper-3">
          <div
            className="h-full rounded-full bg-review transition-[width] duration-300"
            style={{ width: `${Math.round(progress * 100)}%` }}
          />
        </div>
        <span className="text-[11px] text-ink-4 tabular-nums">{Math.round(progress * 100)}%</span>
      </div>
    </div>
  )
}
