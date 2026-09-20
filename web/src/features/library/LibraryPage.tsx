import { useCallback, useState, type MouseEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { backend } from '../../backend'
import AsyncError from '../../components/AsyncError'
import Button from '../../components/Button'
import Confirm from '../../components/Confirm'
import EmptyState from '../../components/EmptyState'
import Icon from '../../components/icons/Icon'
import IconButton from '../../components/IconButton'
import Menu, { type MenuAnchor, type MenuEntry } from '../../components/Menu'
import PageHeader from '../../components/PageHeader'
import Skeleton from '../../components/Skeleton'
import Tag from '../../components/Tag'
import ToastHost from '../../components/ToastHost'
import Toolbar, { ToolbarSpacer } from '../../components/Toolbar'
import { localCalendarDate } from '../../lib/localDate'
import { toast } from '../../lib/toastStore'
import { useAsyncResource } from '../../lib/useAsyncResource'
import { useBackendOperation } from '../../lib/useBackendOperation'
import { useSession } from '../../store'
import type { Book, BookStatus } from '../../types'
import ExportDialog from './ExportDialog'
import ImportWizard from './ImportWizard'

const STATUS_LABEL: Record<BookStatus, string> = {
  active: '主攻中',
  paused: '已暂停',
  finished: '已学完',
}
/** 非主攻书的说明:计划冻结不产新块,到期复习照常汇入今日队列(PRODUCT_SPEC §5) */
const STATUS_NOTE: Partial<Record<BookStatus, string>> = {
  paused: '计划冻结 · 复习照常',
  finished: '复习照常 · 不再主攻',
}

/* 封面签名:首字 + 书脊色条(按书名首字符稳定取三任务色之一;数据色在这里只作装饰) */
const SPINE = ['bg-new', 'bg-review', 'bg-weak']

/**
 * 书架(视觉改版第二批):工具栏带放「导入书籍」;栅格按容器自适应;卡片操作收进「更多操作」菜单
 * (右键同一个菜单),只留「阅读」为直接按钮;删除后 toast;空态/加载态用原语。
 */
export default function LibraryPage() {
  const navigate = useNavigate()
  const setActiveBookId = useSession(s => s.setActiveBookId)
  const [wizardOpen, setWizardOpen] = useState(false)
  const [switchTarget, setSwitchTarget] = useState<Book | null>(null)
  const [finishTarget, setFinishTarget] = useState<Book | null>(null)
  const [exportTarget, setExportTarget] = useState<Book | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Book | null>(null)
  /** 「更多操作」菜单:按钮点击锚定按钮,右键锚定坐标 */
  const [menu, setMenu] = useState<{ book: Book; anchor: MenuAnchor } | null>(null)

  const books = useAsyncResource(useCallback(async () => {
    const list = await backend.listBooks()
    return [...list].sort((a, z) => Number(z.status === 'active') - Number(a.status === 'active'))
  }, []))

  const switchOp = useBackendOperation(
    (bookId: number) => backend.setActiveBook(bookId),
    {
      onCommitted: async (_key, bookId) => {
        setActiveBookId(bookId)
        setSwitchTarget(null)
        void books.reload()
      },
    },
  )
  const switching = switchOp.pending.has('switch')
  const switchError = switchOp.errors.get('switch')

  const finishOp = useBackendOperation(
    (bookId: number) => backend.finishBook(bookId),
    {
      onCommitted: async () => {
        setFinishTarget(null)
        void books.reload()
      },
    },
  )
  const finishing = finishOp.pending.has('finish')
  const finishError = finishOp.errors.get('finish')
  const confirmFinish = () => {
    if (!finishTarget) return
    finishOp.clearError('finish')
    void finishOp.run('finish', finishTarget.id)
  }

  const deleteOp = useBackendOperation(
    (book: Book) => backend.deleteBook(book.id, localCalendarDate()),
    {
      onCommitted: async (_key, book) => {
        if (book.status === 'active') setActiveBookId(null)
        setDeleteTarget(null)
        toast({ message: `已删除《${book.title}》`, description: '删除前已更新今日快照,可在设置页恢复。' })
        void books.reload()
      },
    },
  )
  const deleting = deleteOp.pending.has('delete')
  const deleteError = deleteOp.errors.get('delete')
  const confirmDelete = () => {
    if (!deleteTarget) return
    deleteOp.clearError('delete')
    void deleteOp.run('delete', deleteTarget)
  }

  // 主攻书与已学完的书直接看地图;暂停的书需确认切换
  const open = (book: Book) => {
    if (book.status === 'active' || book.status === 'finished') navigate(`/map/${book.id}`)
    else {
      switchOp.clearError('switch')
      setSwitchTarget(book)
    }
  }

  // 「阅读」:直接打开阅读器读这本书(不带任务),右栏默认「问书」;定位到该书第一个知识块
  const readOp = useBackendOperation(async (book: Book) => {
    const blocks = await backend.listBlocks(book.id)
    const first = [...blocks].sort((a, z) => a.seq - z.seq)[0]
    if (first) navigate(`/reader/${first.id}`)
  })

  const confirmSwitch = () => {
    if (!switchTarget) return
    switchOp.clearError('switch')
    void switchOp.run('switch', switchTarget.id)
  }

  const cancelSwitch = () => {
    if (switching) return
    switchOp.clearError('switch')
    setSwitchTarget(null)
  }

  const menuItems = (book: Book): MenuEntry[] => [
    { label: '导出到 Obsidian', icon: 'square-arrow-up', onSelect: () => setExportTarget(book) },
    ...(book.status !== 'finished'
      ? [{ label: '标记为已学完', icon: 'checkmark-seal' as const, onSelect: () => { finishOp.clearError('finish'); setFinishTarget(book) } }]
      : []),
    { separator: true as const },
    { label: '删除', ariaLabel: `删除《${book.title}》`, icon: 'trash', danger: true, onSelect: () => { deleteOp.clearError('delete'); setDeleteTarget(book) } },
  ]
  const onContextMenu = (book: Book) => (e: MouseEvent) => {
    e.preventDefault()
    setMenu({ book, anchor: { x: e.clientX, y: e.clientY } })
  }

  const list = books.data

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Toolbar aria-label="书架工具栏">
        <ToolbarSpacer />
        <Button variant="primary" size="sm" onClick={() => setWizardOpen(true)}>
          <Icon name="plus" size={14} />
          导入书籍
        </Button>
      </Toolbar>
      <div className="min-h-0 flex-1 overflow-y-auto @container">
        <div className="mx-auto w-full max-w-[56rem] px-8 pt-6 pb-16">
          <PageHeader title="书架" subtitle="一次只主攻一本;其余的书在此静候" />

          {books.error && list !== null && (
            <div className="mb-6">
              <AsyncError error={books.error} onRetry={books.reload} variant="compact" />
            </div>
          )}

          {books.error && list === null ? (
            <AsyncError error={books.error} onRetry={books.reload} />
          ) : list === null ? (
            <div aria-busy="true" className="grid grid-cols-[repeat(auto-fill,minmax(10.5rem,1fr))] gap-x-6 gap-y-8">
              {[0, 1, 2, 3].map(i => (
                <div key={i} className="flex flex-col gap-2.5">
                  <div className="aspect-[3/4] animate-pulse rounded-m bg-fill-active" />
                  <Skeleton lines={2} />
                </div>
              ))}
            </div>
          ) : list.length === 0 ? (
            <EmptyState
              icon="book-closed"
              title="书架还空着——导入一本 EPUB 开始。"
              body="导入后 AI 会先拆出知识地图,再一块一块地攻克。"
              action={
                <Button size="sm" onClick={() => setWizardOpen(true)}>
                  导入 EPUB
                </Button>
              }
            />
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(10.5rem,1fr))] gap-x-6 gap-y-8">
              {list.map(book => (
                <article key={book.id} aria-label={book.title} className="group flex flex-col" onContextMenu={onContextMenu(book)}>
                  <button
                    type="button"
                    aria-label={`打开《${book.title}》`}
                    onClick={() => open(book)}
                    className="w-full cursor-pointer rounded-m text-left"
                  >
                    <div
                      className={`relative flex aspect-[3/4] items-center justify-center overflow-hidden rounded-m border border-sep bg-card shadow-card transition-shadow duration-[var(--dur-base)] group-hover:shadow-popover ${
                        book.status === 'active' ? 'ring-2 ring-accent ring-offset-2 ring-offset-content' : ''
                      }`}
                    >
                      <span aria-hidden className={`absolute inset-y-0 left-0 w-1.5 ${SPINE[(book.title.codePointAt(0) ?? 0) % SPINE.length]}`} />
                      <span aria-hidden className="font-serif text-[44px] font-semibold text-label-2">
                        {[...book.title][0]}
                      </span>
                    </div>
                    <div className="mt-2.5 flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate font-serif text-headline text-label-1">{book.title}</div>
                        <div className="truncate text-subhead text-label-2">{book.author}</div>
                      </div>
                      {book.importState === 'staged' || book.importState === 'extracted' ? (
                        <Tag tone="weak" className="shrink-0">导入未完成</Tag>
                      ) : (
                        <Tag tone={book.status === 'active' ? 'new' : 'neutral'} className="shrink-0">
                          {STATUS_LABEL[book.status]}
                        </Tag>
                      )}
                    </div>
                  </button>
                  <div className="mt-2 flex items-center justify-between gap-2">
                    {book.importState === 'mapped' || book.importState === 'ready' ? (
                      <Button
                        size="sm"
                        disabled={readOp.pending.size > 0}
                        onClick={() => { readOp.clearError('read'); void readOp.run('read', book) }}
                      >
                        阅读
                      </Button>
                    ) : (
                      <span />
                    )}
                    <IconButton
                      icon="ellipsis-circle"
                      label={`《${book.title}》的更多操作`}
                      aria-haspopup="menu"
                      aria-expanded={menu?.book.id === book.id}
                      onClick={e => setMenu({ book, anchor: e.currentTarget })}
                    />
                  </div>
                  {STATUS_NOTE[book.status] && <p className="mt-1 text-footnote text-label-3">{STATUS_NOTE[book.status]}</p>}
                </article>
              ))}
            </div>
          )}
        </div>
      </div>

      <Menu
        open={menu !== null}
        onClose={() => setMenu(null)}
        anchor={menu?.anchor ?? null}
        aria-label={menu ? `《${menu.book.title}》的操作` : '操作'}
        items={menu ? menuItems(menu.book) : []}
      />
      <ToastHost />
      <ImportWizard open={wizardOpen} onClose={() => setWizardOpen(false)} />
      <Confirm
        open={switchTarget !== null}
        title="切换主攻书?"
        message={`当前进行中的书会暂停(计划冻结、复习照常),《${switchTarget?.title ?? ''}》将成为唯一主攻书。今日队列明天起按新书生成。`}
        confirmText={switching ? '切换中…' : '切换'}
        confirmDisabled={switching}
        cancelDisabled={switching}
        onConfirm={confirmSwitch}
        onCancel={cancelSwitch}
      >
        {switchError && <AsyncError error={switchError} onRetry={confirmSwitch} variant="compact" />}
      </Confirm>
      {exportTarget && <ExportDialog book={exportTarget} onClose={() => setExportTarget(null)} />}
      <Confirm
        open={deleteTarget !== null}
        title={`删除《${deleteTarget?.title ?? ''}》?`}
        message="将删除这本书的知识地图、学习记录、薄弱点、复习排期、标记与产出,记忆库里它的目录也会移除(git 记录一次提交)。删除前会更新今日快照,可在设置页恢复到删除前。"
        confirmText={deleting ? '删除中…' : '删除'}
        cancelText="取消"
        danger
        confirmDisabled={deleting}
        cancelDisabled={deleting}
        onConfirm={confirmDelete}
        onCancel={() => { if (!deleting) setDeleteTarget(null) }}
      >
        {deleteError && <AsyncError error={deleteError} onRetry={confirmDelete} variant="compact" />}
      </Confirm>
      <Confirm
        open={finishTarget !== null}
        title="标记为已学完?"
        message={`《${finishTarget?.title ?? ''}》的学习计划将冻结,不再安排新块;已排定的间隔复习照常进入今日队列。之后不能再把它设为主攻书。`}
        confirmText={finishing ? '处理中…' : '标记为已学完'}
        confirmDisabled={finishing}
        cancelDisabled={finishing}
        onConfirm={confirmFinish}
        onCancel={() => { if (!finishing) setFinishTarget(null) }}
      >
        {finishError && <AsyncError error={finishError} onRetry={confirmFinish} variant="compact" />}
      </Confirm>
    </div>
  )
}
