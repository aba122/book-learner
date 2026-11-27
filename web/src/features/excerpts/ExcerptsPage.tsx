import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { backend } from '../../backend'
import AsyncError from '../../components/AsyncError'
import Button from '../../components/Button'
import Dialog from '../../components/Dialog'
import EmptyState from '../../components/EmptyState'
import Icon from '../../components/icons/Icon'
import IconButton from '../../components/IconButton'
import Input from '../../components/Input'
import Menu, { type MenuAnchor, type MenuEntry } from '../../components/Menu'
import ProgressBar from '../../components/ProgressBar'
import Skeleton from '../../components/Skeleton'
import Spinner from '../../components/Spinner'
import Textarea from '../../components/Textarea'
import ToastHost from '../../components/ToastHost'
import Toolbar, { ToolbarSpacer } from '../../components/Toolbar'
import { EXCERPT_AUTHOR_KEY, EXCERPT_POLL_MS, EXCERPT_TEXT_MAX_CHARS } from '../../config'
import { readPref, writePref } from '../../lib/prefs'
import { toast } from '../../lib/toastStore'
import { StaleResult, useAsyncResource } from '../../lib/useAsyncResource'
import { NO_HOVER_QUERY, useIsPhone, useMediaQuery } from '../../lib/useMedia'
import type { Book, Excerpt, ExcerptFocus, ExcerptJob, ExcerptLibrary } from '../../types'
import { authorInfo, groupByAuthor, isJobActive, matchesQuery, toneStyle, type AuthorGroup, type AuthorInfo, type BookEntry } from './authors'
import ExcerptCard from './ExcerptCard'
import FocusPicker from './FocusPicker'
import { FOCUS_LABEL } from './focus'

/** 作者栏「全部」 */
const ALL = '*'

interface PageData {
  books: Book[]
  library: ExcerptLibrary
}

/** 「在书中查看」经路由 state 交给阅读器(ReaderPage 读 location.state.reveal) */
export interface RevealTarget {
  href: string
  text: string
  cfi: string | null
}

const errorText = (e: unknown) => (e instanceof Error && e.message ? e.message : '操作没有完成,请重试')

function Monogram({ info, size }: { info: AuthorInfo; size: 'sm' | 'md' | 'lg' }) {
  const dim = size === 'lg' ? 'size-13 text-[24px] max-md:size-11 max-md:text-[20px]' : size === 'md' ? 'size-[30px] text-[15px]' : 'size-[22px] text-[11px]'
  return (
    <span aria-hidden style={toneStyle(info.tone)} className={`grid shrink-0 place-items-center rounded-full bg-[var(--tone-soft)] font-serif font-semibold text-[var(--tone)] ${dim}`}>
      {info.mono}
    </span>
  )
}

function MiniCover({ book, tone }: { book: Book; tone: number }) {
  const [failed, setFailed] = useState<string | null>(null)
  const src = book.coverUrl && failed !== book.coverUrl ? book.coverUrl : null
  return (
    <span style={toneStyle(tone)} className="relative grid aspect-[3/4] w-8 shrink-0 place-items-center overflow-hidden rounded-xs border border-sep bg-card font-serif text-callout text-label-2 shadow-card">
      {src ? (
        <img src={src} alt="" draggable={false} className="absolute inset-0 size-full object-cover" onError={() => setFailed(src)} />
      ) : (
        <>
          <span aria-hidden className="absolute inset-y-0 left-0 w-[3px] bg-[var(--tone)]" />
          <span aria-hidden>{[...book.title][0]}</span>
        </>
      )}
    </span>
  )
}

/** 作业状态条:排队 / 正在读 / 精选 / 失败;完成后不显示 */
function JobBanner({ entry, position, onRetry, onRegenerate }: { entry: BookEntry; position: number; onRetry: () => void; onRegenerate: () => void }) {
  const job = entry.stats?.job ?? null
  if (!job) return null
  if (job.stage === 'failed') {
    return (
      <div role="alert" className="mb-4 flex flex-wrap items-center gap-3 rounded-m bg-weak-soft px-4 py-3 text-callout text-weak">
        <Icon name="exclamation-triangle" size={15} />
        <span className="min-w-0 flex-1">整理没有完成:{job.error ?? 'AI 暂时没有回应'}</span>
        <Button size="sm" onClick={onRetry}>重试</Button>
      </div>
    )
  }
  if (job.stage === 'done') {
    if (entry.excerpts.length > 0 || job.added > 0) return null
    return (
      <div className="mb-4 flex flex-wrap items-center gap-3 rounded-m bg-inset px-4 py-3 text-callout text-label-2">
        <span className="min-w-0 flex-1">AI 没在这本书里挑到合适的句子。</span>
        <Button size="sm" variant="ghost" onClick={onRegenerate}>重新整理</Button>
      </div>
    )
  }
  const reading = job.stage === 'reading' && job.totalPieces > 0
  const label = job.stage === 'queued'
    ? (position > 0 ? `排队中,前面还有 ${position} 本` : '马上开始')
    : job.stage === 'selecting'
      ? '正在从候选里精选'
      : reading
        ? `正在读第 ${Math.min(job.nextPiece + 1, job.totalPieces)} / ${job.totalPieces} 段`
        : '正在准备'
  return (
    <div className="mb-4 flex flex-col gap-2 rounded-m bg-inset px-4 py-3" data-testid="excerpt-job">
      <div className="flex items-center gap-2.5 text-callout text-label-1">
        <Spinner size={14} />
        <span className="font-medium">{label}</span>
        <span className="ml-auto text-footnote text-label-3 max-md:hidden">整理在后台进行,离开这个页面也不会中断</span>
      </div>
      <ProgressBar
        size="sm"
        label={`整理进度:${label}`}
        value={job.stage === 'queued' ? 0 : reading ? job.nextPiece / job.totalPieces : null}
      />
    </div>
  )
}

function EditDialog({ excerpt, onClose, onSaved }: { excerpt: Excerpt; onClose: () => void; onSaved: (e: Excerpt) => void }) {
  const [text, setText] = useState(excerpt.text)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const count = [...text].length
  const tooShort = text.replace(/\s/g, '').length < 2
  const tooLong = count > EXCERPT_TEXT_MAX_CHARS
  const save = async (value: string | null) => {
    setBusy(true)
    setError(null)
    try {
      onSaved(await backend.excerptUpdate(excerpt.id, value))
    } catch (e) {
      setError(errorText(e))
      setBusy(false)
    }
  }
  return (
    <Dialog
      open
      title="编辑书摘"
      description="可以把太长的段落裁短;「在书中查看」仍按书中原文定位。"
      size="lg"
      onClose={onClose}
      closeButton={false}
      footer={
        <>
          {(excerpt.edited || text !== excerpt.originalText) && (
            <Button variant="ghost" className="mr-auto" disabled={busy} onClick={() => void save(null)}>
              恢复原文
            </Button>
          )}
          <Button disabled={busy} onClick={onClose}>取消</Button>
          <Button variant="primary" disabled={busy || tooShort || tooLong || text === excerpt.text} onClick={() => void save(text)}>
            保存
          </Button>
        </>
      }
    >
      <Textarea aria-label="书摘文字" rows={7} value={text} onChange={e => setText(e.target.value)} className="font-serif text-[15px] leading-[1.85]" />
      <div className="mt-1.5 flex justify-end text-footnote text-label-3">
        <span className={`tabular-nums ${tooLong ? 'text-weak' : ''}`}>{count} / {EXCERPT_TEXT_MAX_CHARS}</span>
      </div>
      {error && <p role="alert" className="mt-2 text-callout text-weak">{error}</p>}
    </Dialog>
  )
}

function AuthorDialog({ book, onClose, onSaved }: { book: Book; onClose: () => void; onSaved: (b: Book) => void }) {
  const [value, setValue] = useState(book.author === '待识别' ? '' : book.author)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const trimmed = value.trim()
  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      onSaved(await backend.setBookAuthor(book.id, trimmed))
    } catch (e) {
      setError(errorText(e))
      setBusy(false)
    }
  }
  return (
    <Dialog
      open
      title={`更正《${book.title}》的作者`}
      description="书摘按作者归类;改了之后书架上也显示新的作者名。"
      size="md"
      onClose={onClose}
      closeButton={false}
      footer={
        <>
          <Button disabled={busy} onClick={onClose}>取消</Button>
          <Button variant="primary" disabled={busy || trimmed.length === 0 || [...trimmed].length > 120 || trimmed === book.author} onClick={() => void save()}>
            保存
          </Button>
        </>
      }
    >
      <Input aria-label="作者" value={value} placeholder="作者名,如 齐格蒙特·鲍曼" onChange={e => setValue(e.target.value)} className="w-full" autoFocus />
      {error && <p role="alert" className="mt-2 text-callout text-weak">{error}</p>}
    </Dialog>
  )
}

/**
 * 整理对话框(BL-037):第一次整理与重新整理都在这里选按什么挑(抓观点 / 学写法);
 * 重新整理默认选中这本书上一轮的方式,改了就按新方式开一轮。
 */
function OrganizeDialog({
  entry,
  onClose,
  onConfirm,
}: {
  entry: BookEntry
  onClose: () => void
  onConfirm: (focus: ExcerptFocus, rerun: boolean) => void
}) {
  const job = entry.stats?.job ?? null
  const rerun = job !== null || (entry.stats?.aiCount ?? 0) > 0
  const [focus, setFocus] = useState<ExcerptFocus>(job?.focus ?? 'ideas')
  return (
    <Dialog
      open
      title={rerun ? `重新整理《${entry.book.title}》的书摘?` : `整理《${entry.book.title}》的书摘`}
      size="md"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" onClick={() => onConfirm(focus, rerun)}>{rerun ? '重新整理' : '开始整理'}</Button>
        </>
      }
    >
      <FocusPicker value={focus} onChange={setFocus} />
      {rerun && (
        <p className="mt-4 text-callout leading-relaxed text-label-3">
          AI 整理且你没改过的卡片会换成新的一批;改过的、你自己存的、删掉的都不受影响,删掉的也不会再出现。整理在后台进行。
        </p>
      )}
    </Dialog>
  )
}

function BookSection({
  entry,
  group,
  query,
  touch,
  position,
  onCopy,
  onReveal,
  onEdit,
  onRemove,
  onGenerate,
  onRetry,
  onRegenerate,
  onSetAuthor,
  onOpenReader,
}: {
  entry: BookEntry
  group: AuthorGroup
  query: string
  touch: boolean
  position: number
  onCopy: (e: Excerpt) => void
  onReveal: (e: Excerpt) => void
  onEdit: (e: Excerpt) => void
  onRemove: (e: Excerpt) => void
  /** 第一次整理:打开整理对话框选方式(BL-037) */
  onGenerate: () => void
  /** 失败后重试:续跑这一轮,方式不变 */
  onRetry: () => void
  onRegenerate: () => void
  onSetAuthor: () => void
  onOpenReader: (() => void) | null
}) {
  const [menuAnchor, setMenuAnchor] = useState<MenuAnchor | null>(null)
  const { book, stats } = entry
  const job = stats?.job ?? null
  const active = isJobActive(job)
  const cards = entry.excerpts.filter(e => matchesQuery(e, book.title, query))
  const ai = stats?.aiCount ?? 0
  const mine = stats?.userCount ?? 0
  const neverRun = !job && ai === 0
  const style = toneStyle(group.tone)
  if (query && cards.length === 0) return null
  const items: MenuEntry[] = [
    ...(neverRun && stats?.hasText ? [{ label: '整理这本书', icon: 'sparkles' as const, onSelect: onGenerate }] : []),
    ...(!neverRun && !active && stats?.hasText ? [{ label: '重新整理', icon: 'arrow-clockwise' as const, onSelect: onRegenerate }] : []),
    { label: '更正作者', icon: 'pencil', onSelect: onSetAuthor },
    ...(onOpenReader ? [{ label: '打开阅读器', icon: 'book-open' as const, onSelect: onOpenReader }] : []),
  ]
  return (
    <section aria-label={`《${book.title}》的书摘`} className="mb-10 max-md:mb-8">
      <div className="mb-3.5 flex items-center gap-3">
        <MiniCover book={book} tone={group.tone} />
        <div className="min-w-0 flex-1">
          <h3 className="truncate font-serif text-title3 font-semibold text-label-1">《{book.title}》</h3>
          <p className="text-subhead text-label-3 tabular-nums">
            {job ? `${FOCUS_LABEL[job.focus]} · ` : ''}
            {neverRun && mine === 0 ? '还没整理' : `AI 挑选 ${ai} · 我添加 ${mine}`}
          </p>
        </div>
        <IconButton
          icon="ellipsis-circle"
          label={`《${book.title}》的更多操作`}
          expanded={menuAnchor !== null}
          onClick={e => setMenuAnchor(cur => (cur ? null : e.currentTarget))}
        />
        <Menu open={menuAnchor !== null} onClose={() => setMenuAnchor(null)} anchor={menuAnchor} items={items} aria-label={`《${book.title}》的书摘操作`} />
      </div>
      <JobBanner entry={entry} position={position} onRetry={onRetry} onRegenerate={onRegenerate} />
      {neverRun && stats?.hasText && !query && (
        <div className="mb-4 flex flex-wrap items-center gap-3 rounded-m border border-dashed border-sep px-4 py-3 text-callout text-label-2">
          <span className="min-w-0 flex-1">AI 还没整理这本书。可以选抓观点(结论和重要段落)或学写法(写得好的段落),挑出约 50 条。</span>
          <Button size="sm" onClick={onGenerate}>
            <Icon name="sparkles" size={13} />
            整理这本书
          </Button>
        </div>
      )}
      {cards.length > 0 && (
        <div className="columns-[16rem] gap-4 max-md:columns-1" style={style}>
          {cards.map(e => (
            <ExcerptCard
              key={e.id}
              excerpt={e}
              bookTitle={book.title}
              toneStyle={style}
              touch={touch}
              actions={{ onCopy: () => onCopy(e), onReveal: () => onReveal(e), onEdit: () => onEdit(e), onRemove: () => onRemove(e) }}
            />
          ))}
        </div>
      )}
    </section>
  )
}

/**
 * 书摘页(BL-034,设计 docs/design/2026-11-25-excerpt-cards.md §6):按作者归类的书摘卡片。
 * 桌面三栏(应用侧栏 | 作者栏 | 卡片),手机作者变成顶部横滑标签;有整理作业进行时每 5 秒查一次作业,完成即刷新。
 */
export default function ExcerptsPage() {
  const navigate = useNavigate()
  const phone = useIsPhone()
  const touch = useMediaQuery(NO_HOVER_QUERY)
  const [searchParams] = useSearchParams()
  const resource = useAsyncResource(useCallback(async (isCurrent: () => boolean): Promise<PageData> => {
    const [books, library] = await Promise.all([backend.listBooks(), backend.excerptLibrary()])
    if (!isCurrent()) throw new StaleResult()
    return { books, library }
  }, []))
  const reload = resource.reload
  // 页面本地副本:删除/改字/入队先改它(即时反馈),服务端新快照到了就整体换掉(渲染期同步,不走 effect)
  const [data, setData] = useState<PageData | null>(null)
  const [synced, setSynced] = useState<PageData | null>(null)
  if (resource.data && resource.data !== synced) {
    setSynced(resource.data)
    setData(resource.data)
  }
  const dataRef = useRef(data)
  useEffect(() => {
    dataRef.current = data
  })

  const [selected, setSelected] = useState<string>(() => searchParams.get('author') ?? readPref(EXCERPT_AUTHOR_KEY) ?? ALL)
  const select = (key: string) => {
    setSelected(key)
    writePref(EXCERPT_AUTHOR_KEY, key)
  }
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<Excerpt | null>(null)
  const [authorBook, setAuthorBook] = useState<Book | null>(null)
  /** 整理对话框(BL-037):第一次整理或重新整理,在这里选方式 */
  const [organizing, setOrganizing] = useState<BookEntry | null>(null)
  const [starting, setStarting] = useState(false)

  const groups = useMemo(() => (data ? groupByAuthor(data.books, data.library.books, data.library.excerpts) : []), [data])
  const current = selected === ALL ? null : groups.find(g => g.key === selected) ?? null
  const showAll = selected === ALL || current === null
  const visible = showAll ? groups : [current]
  const total = data?.library.excerpts.length ?? 0
  const eligible = data ? data.library.books.filter(s => s.hasText && !s.job && s.aiCount === 0) : []

  // 排队位次:按入队时间排的进行中作业
  const queueOrder = useMemo(() => {
    const jobs = (data?.library.books ?? []).map(b => b.job).filter((j): j is ExcerptJob => isJobActive(j))
    return jobs.sort((a, b) => a.queuedAt.localeCompare(b.queuedAt) || a.bookId - b.bookId).map(j => j.bookId)
  }, [data])

  // 有作业进行时轮询;某本从进行中变成完成/失败 → 刷新卡片并提示
  const activeKey = queueOrder.join(',')
  useEffect(() => {
    if (!activeKey) return
    let alive = true
    const timer = setInterval(() => {
      backend
        .excerptJobs()
        .then(jobs => {
          const cur = dataRef.current
          if (!alive || !cur) return
          const byId = new Map(jobs.map(j => [j.bookId, j]))
          const finished: { book: Book | undefined; job: ExcerptJob }[] = []
          const books = cur.library.books.map(b => {
            const next = byId.get(b.bookId) ?? b.job
            if (isJobActive(b.job) && next && !isJobActive(next)) finished.push({ book: cur.books.find(x => x.id === b.bookId), job: next })
            return { ...b, job: next ?? null }
          })
          setData({ ...cur, library: { ...cur.library, books } })
          if (finished.length > 0) {
            reload()
            for (const f of finished) {
              if (f.job.stage === 'done') toast({ message: `《${f.book?.title ?? ''}》的书摘整理好了`, description: f.job.added > 0 ? `新增 ${f.job.added} 张卡片` : 'AI 没挑到合适的句子' })
              else toast({ message: `《${f.book?.title ?? ''}》的书摘没有整理完`, description: f.job.error ?? undefined })
            }
          }
        })
        .catch(() => {
          /* 轮询失败等下一轮 */
        })
    }, EXCERPT_POLL_MS)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [activeKey, reload])

  const patchJob = (job: ExcerptJob) =>
    setData(cur => (cur ? { ...cur, library: { ...cur.library, books: cur.library.books.map(b => (b.bookId === job.bookId ? { ...b, job } : b)) } } : cur))

  const generate = async (bookId: number, regenerate: boolean, focus?: ExcerptFocus) => {
    try {
      patchJob(await backend.excerptGenerate(bookId, regenerate, focus))
    } catch (e) {
      toast({ message: '没能开始整理', description: errorText(e) })
    }
  }
  const startAll = async () => {
    setStarting(true)
    let started = 0
    for (const s of eligible) {
      try {
        patchJob(await backend.excerptGenerate(s.bookId, false))
        started += 1
      } catch {
        /* 单本失败不挡其余的 */
      }
    }
    setStarting(false)
    if (started > 0) toast({ message: `开始整理 ${started} 本书的书摘`, description: '在后台逐本进行,可以先去做别的' })
  }

  const copy = (e: Excerpt) => {
    const book = data?.books.find(b => b.id === e.bookId)
    const author = authorInfo(book?.author)
    const attribution = author.key ? `——${author.name}《${book?.title ?? ''}》` : `——《${book?.title ?? ''}》`
    const write = navigator.clipboard?.writeText?.(`${e.text}\n${attribution}`)
    if (write && typeof write.then === 'function') {
      write.then(() => toast({ message: '已复制' }), () => toast({ message: '没能复制,系统不允许访问剪贴板' }))
    } else {
      toast({ message: '没能复制,系统不允许访问剪贴板' })
    }
  }
  // 有知识块 → 按块打开阅读器(与之前一样);没有地图的书按书打开(BL-036)
  const readerPath = (bookId: number) => {
    const blockId = data?.library.books.find(b => b.bookId === bookId)?.readerBlockId
    return blockId ? `/reader/${blockId}` : `/read/${bookId}`
  }
  const reveal = (e: Excerpt) => {
    const target: RevealTarget = { href: e.spineHref, text: e.originalText, cfi: e.cfi }
    navigate(readerPath(e.bookId), { state: { reveal: target } })
  }
  const remove = (e: Excerpt) => {
    const cur = dataRef.current
    if (!cur) return
    const counts = (delta: number) => (b: PageData['library']['books'][number]) =>
      b.bookId === e.bookId ? { ...b, aiCount: b.aiCount + (e.source === 'ai' ? delta : 0), userCount: b.userCount + (e.source === 'user' ? delta : 0) } : b
    setData({ ...cur, library: { books: cur.library.books.map(counts(-1)), excerpts: cur.library.excerpts.filter(x => x.id !== e.id) } })
    backend
      .excerptRemove(e.id)
      .then(() => {
        toast({
          message: '已删除',
          description: e.text.length > 18 ? `${e.text.slice(0, 18)}…` : e.text,
          action: {
            label: '撤销',
            onSelect: () => {
              backend.excerptRestore(e.id).then(() => reload(), err => toast({ message: '没能撤销', description: errorText(err) }))
            },
          },
        })
      })
      .catch(err => {
        toast({ message: '没能删除', description: errorText(err) })
        reload()
      })
  }
  const saved = (updated: Excerpt) => {
    setEditing(null)
    setData(cur => (cur ? { ...cur, library: { ...cur.library, excerpts: cur.library.excerpts.map(x => (x.id === updated.id ? updated : x)) } } : cur))
    toast({ message: updated.edited ? '已保存' : '已恢复原文' })
  }
  const authorSaved = (book: Book) => {
    setAuthorBook(null)
    setData(cur => (cur ? { ...cur, books: cur.books.map(b => (b.id === book.id ? book : b)) } : cur))
    if (selected !== ALL) select(authorInfo(book.author).key)
    toast({ message: `已改为「${authorInfo(book.author).name}」` })
  }

  const loading = data === null
  // 已有卡片或作业时,还没整理过的书用工具栏按钮;全空时由空态里的大按钮负责
  const showStartAll = eligible.length > 0 && total + queueOrder.length > 0
  const loadError = resource.error

  const authorRows = (
    <>
      <button
        type="button"
        aria-current={showAll ? 'true' : undefined}
        onClick={() => select(ALL)}
        className="flex w-full cursor-pointer items-center gap-2.5 rounded-m px-2 py-1.5 text-left transition-colors duration-[var(--dur-fast)] hover:bg-fill-hover aria-[current=true]:bg-fill-selected"
      >
        <span aria-hidden className="grid size-[30px] shrink-0 place-items-center rounded-full bg-inset text-label-2">
          <Icon name="quote" size={14} />
        </span>
        <span className="min-w-0 flex-1 truncate text-body text-label-1">全部书摘</span>
        <span className="text-subhead text-label-3 tabular-nums">{total}</span>
      </button>
      {groups.map(g => (
        <button
          key={g.key || 'unknown'}
          type="button"
          aria-current={!showAll && current?.key === g.key ? 'true' : undefined}
          onClick={() => select(g.key)}
          className="flex w-full cursor-pointer items-center gap-2.5 rounded-m px-2 py-1.5 text-left transition-colors duration-[var(--dur-fast)] hover:bg-fill-hover aria-[current=true]:bg-fill-selected"
        >
          <Monogram info={g} size="md" />
          <span className="min-w-0 flex-1 truncate text-body text-label-1">{g.name}</span>
          {g.books.some(b => isJobActive(b.stats?.job)) ? <Spinner size={14} /> : <span className="text-subhead text-label-3 tabular-nums">{g.count}</span>}
        </button>
      ))}
    </>
  )

  const authorChips = (
    <div role="group" aria-label="作者" className="flex shrink-0 gap-2 overflow-x-auto px-4 pt-1 pb-3 [scrollbar-width:none]">
      <button type="button" aria-pressed={showAll} onClick={() => select(ALL)} className="flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-full bg-inset px-3 text-callout text-label-2 aria-pressed:bg-label-1 aria-pressed:font-semibold aria-pressed:text-on-ink">
        全部 <span className="tabular-nums opacity-70">{total}</span>
      </button>
      {groups.map(g => (
        <button
          key={g.key || 'unknown'}
          type="button"
          aria-pressed={!showAll && current?.key === g.key}
          onClick={() => select(g.key)}
          className="flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-full bg-inset pr-3 pl-1 text-callout text-label-2 aria-pressed:bg-label-1 aria-pressed:font-semibold aria-pressed:text-on-ink"
        >
          <Monogram info={g} size="sm" />
          {g.name}
        </button>
      ))}
    </div>
  )

  const renderGroup = (g: AuthorGroup, hero: boolean) => {
    const books = g.books.length
    const meta = `${g.note ? `${g.note} · ` : ''}${books} 本书 · ${g.count} 张卡片`
    return (
      <div key={g.key || 'unknown'} className={hero ? '' : 'mb-4'}>
        {hero ? (
          <header className="mb-8 flex items-center gap-4 max-md:mb-6">
            <Monogram info={g} size="lg" />
            <div className="min-w-0">
              <h1 className="truncate font-serif text-large-title font-semibold tracking-[0.06em] text-label-1">{g.name}</h1>
              <p className="mt-1 text-callout text-label-3 tabular-nums">{meta}</p>
            </div>
          </header>
        ) : (
          <header className="mb-5 flex items-center gap-3 border-b border-sep pb-3">
            <Monogram info={g} size="md" />
            <h2 className="min-w-0 truncate font-serif text-title2 font-semibold tracking-[0.04em] text-label-1">{g.name}</h2>
            <span className="ml-auto shrink-0 text-subhead text-label-3 tabular-nums">{meta}</span>
          </header>
        )}
        {g.books.map(entry => (
          <BookSection
            key={entry.book.id}
            entry={entry}
            group={g}
            query={query}
            touch={touch}
            position={Math.max(0, queueOrder.indexOf(entry.book.id))}
            onCopy={copy}
            onReveal={reveal}
            onEdit={setEditing}
            onRemove={remove}
            onGenerate={() => setOrganizing(entry)}
            onRetry={() => void generate(entry.book.id, false)}
            onRegenerate={() => setOrganizing(entry)}
            onSetAuthor={() => setAuthorBook(entry.book)}
            onOpenReader={() => navigate(readerPath(entry.book.id))}
          />
        ))}
      </div>
    )
  }

  const matched = query ? visible.reduce((n, g) => n + g.books.reduce((m, b) => m + b.excerpts.filter(e => matchesQuery(e, b.book.title, query)).length, 0), 0) : -1

  let body
  if (loadError && !data) {
    body = <AsyncError error={loadError} onRetry={reload} />
  } else if (loading) {
    body = (
      <div aria-busy="true" className="columns-[16rem] gap-4">
        {[0, 1, 2, 3, 4, 5].map(i => (
          <div key={i} className="mb-4 break-inside-avoid rounded-l border border-sep bg-card p-5">
            <Skeleton lines={3 + (i % 3)} />
          </div>
        ))}
      </div>
    )
  } else if (groups.length === 0) {
    body = (
      <EmptyState
        icon="quote"
        title="还没有书摘"
        body="导入一本书后,AI 会从里面挑出约 50 句值得反复读的句子和段落,按作者整理成卡片。"
        action={<Button size="sm" onClick={() => navigate('/library')}>去书架</Button>}
      />
    )
  } else if (total === 0 && queueOrder.length === 0 && eligible.length > 0 && groups.every(g => g.books.every(b => !b.stats?.job))) {
    body = (
      <EmptyState
        icon="quote"
        title="还没有书摘"
        body={`AI 会从每本书里挑出约 50 句值得反复读的句子和段落,按作者整理成卡片。你可以删掉不喜欢的、把太长的裁短;阅读时选中文字也能存进来。`}
        action={
          <div className="flex flex-col items-center gap-2">
            <Button variant="primary" disabled={starting} onClick={() => void startAll()}>
              <Icon name="sparkles" size={14} />
              为 {eligible.length} 本书整理书摘
            </Button>
            <span className="text-footnote text-label-3">在后台逐本进行,一本书大约 5–30 分钟</span>
          </div>
        }
      />
    )
  } else {
    body = (
      <>
        {showAll && (
          <header className="mb-8 max-md:mb-5">
            <h1 className="font-serif text-large-title font-semibold tracking-wide text-label-1">书摘</h1>
            <p className="mt-1.5 text-callout text-label-3 tabular-nums">
              {groups.length} 位作者 · {total} 张卡片{queueOrder.length > 0 ? ` · ${queueOrder.length} 本正在整理` : ''}
            </p>
          </header>
        )}
        {matched === 0 && <EmptyState compact icon="magnifier" title={`没有找到含「${query.trim()}」的书摘`} />}
        {visible.map(g => renderGroup(g, !showAll))}
      </>
    )
  }

  const search = (
    <label className="relative flex items-center max-md:w-full">
      <Icon name="magnifier" size={13} className="pointer-events-none absolute left-2 text-label-3" />
      <Input size="sm" type="search" aria-label="搜索书摘" placeholder="搜索书摘、书名、标签" value={query} onChange={e => setQuery(e.target.value)} className="w-56 pl-7 max-md:w-full" />
    </label>
  )

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ToastHost />
      {/* 手机上搜索框放在作者标签下面;工具栏里没东西时整条不渲染,不留空带 */}
      {(!phone || showStartAll) && (
        <Toolbar aria-label="书摘工具栏">
          <ToolbarSpacer />
          {!phone && search}
          {showStartAll && (
            <Button size="sm" disabled={starting} onClick={() => void startAll()}>
              <Icon name="sparkles" size={13} />
              为 {eligible.length} 本书整理
            </Button>
          )}
        </Toolbar>
      )}
      {phone ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {groups.length > 0 && authorChips}
          {groups.length > 0 && <div className="px-4 pb-3">{search}</div>}
          <div className="px-4 pt-1 pb-10">{body}</div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          {groups.length > 0 && (
            <nav aria-label="作者" className="flex w-56 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-sep px-2 py-4">
              <h2 className="px-2.5 pb-2 text-subhead font-semibold tracking-[0.08em] text-label-3">作者 · {groups.length}</h2>
              {authorRows}
            </nav>
          )}
          <div className="min-w-0 flex-1 overflow-y-auto @container">
            <div className="mx-auto w-full max-w-[64rem] px-8 pt-7 pb-16">{body}</div>
          </div>
        </div>
      )}
      {editing && <EditDialog excerpt={editing} onClose={() => setEditing(null)} onSaved={saved} />}
      {authorBook && <AuthorDialog book={authorBook} onClose={() => setAuthorBook(null)} onSaved={authorSaved} />}
      {organizing && (
        <OrganizeDialog
          entry={organizing}
          onClose={() => setOrganizing(null)}
          onConfirm={(focus, rerun) => {
            const bookId = organizing.book.id
            setOrganizing(null)
            void generate(bookId, rerun, focus)
          }}
        />
      )}
    </div>
  )
}
