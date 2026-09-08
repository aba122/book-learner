import { useCallback, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { backend } from '../../backend'
import AsyncError from '../../components/AsyncError'
import Button from '../../components/Button'
import Confirm from '../../components/Confirm'
import PageHeader from '../../components/PageHeader'
import Tag from '../../components/Tag'
import { useAsyncResource } from '../../lib/useAsyncResource'
import { useBackendOperation } from '../../lib/useBackendOperation'
import { useSession } from '../../store'
import type { Book, BookStatus } from '../../types'
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

/* 封面色:按书名首字符稳定取三任务色之一,纸上仅作书脊点缀 */
const SPINE = ['bg-new', 'bg-review', 'bg-weak']

export default function LibraryPage() {
  const navigate = useNavigate()
  const setActiveBookId = useSession(s => s.setActiveBookId)
  const [wizardOpen, setWizardOpen] = useState(false)
  const [switchTarget, setSwitchTarget] = useState<Book | null>(null)
  const [finishTarget, setFinishTarget] = useState<Book | null>(null)

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

  // 主攻书与已学完的书直接看地图;暂停的书需确认切换
  const open = (book: Book) => {
    if (book.status === 'active' || book.status === 'finished') navigate(`/map/${book.id}`)
    else {
      switchOp.clearError('switch')
      setSwitchTarget(book)
    }
  }

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

  const list = books.data

  return (
    <div className="mx-auto max-w-4xl px-10 py-12">
      <PageHeader
        title="书架"
        subtitle="一次只主攻一本;其余的书在此静候"
        actions={
          <Button variant="primary" onClick={() => setWizardOpen(true)}>
            导入书籍
          </Button>
        }
      />

      {books.error && list !== null && (
        <div className="mb-6">
          <AsyncError error={books.error} onRetry={books.reload} variant="compact" />
        </div>
      )}

      {books.error && list === null ? (
        <AsyncError error={books.error} onRetry={books.reload} />
      ) : list === null ? (
        <p className="text-sm text-ink-3">正在打开书架…</p>
      ) : list.length === 0 ? (
        <p className="text-sm text-ink-3">书架还空着——导入一本 EPUB 开始。</p>
      ) : (
        <div className="grid grid-cols-3 gap-6 sm:grid-cols-4">
          {list.map(book => (
            <div key={book.id} className="group">
            <button
              onClick={() => open(book)}
              className="w-full cursor-pointer text-left"
            >
              <div
                className={`relative flex aspect-[3/4] items-center justify-center overflow-hidden rounded-m border border-line bg-paper-2 shadow-card transition-shadow group-hover:shadow-pop ${
                  book.status === 'active' ? 'ring-2 ring-new/50' : ''
                }`}
              >
                <span
                  aria-hidden
                  className={`absolute inset-y-0 left-0 w-1.5 ${SPINE[(book.title.codePointAt(0) ?? 0) % SPINE.length]}`}
                />
                <span className="font-serif text-5xl font-semibold text-ink-2">
                  {[...book.title][0]}
                </span>
              </div>
              <div className="mt-2.5 flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate font-serif text-sm font-medium text-ink-1">
                    {book.title}
                  </div>
                  <div className="truncate text-xs text-ink-4">{book.author}</div>
                </div>
                <Tag tone={book.status === 'active' ? 'new' : 'neutral'} className="shrink-0">
                  {STATUS_LABEL[book.status]}
                </Tag>
              </div>
            </button>
            <div className="mt-1 flex items-center justify-between gap-2 text-xs text-ink-4">
              <span>{STATUS_NOTE[book.status] ?? ''}</span>
              {book.status !== 'finished' && (
                <button
                  className="cursor-pointer text-ink-4 underline-offset-2 hover:text-ink-2 hover:underline"
                  onClick={() => { finishOp.clearError('finish'); setFinishTarget(book) }}
                >
                  标记为已学完
                </button>
              )}
            </div>
            </div>
          ))}
        </div>
      )}

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
        {switchError && (
          <div className="mt-4">
            <AsyncError error={switchError} onRetry={confirmSwitch} variant="compact" />
          </div>
        )}
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
        {finishError && (
          <div className="mt-4">
            <AsyncError error={finishError} onRetry={confirmFinish} variant="compact" />
          </div>
        )}
      </Confirm>
    </div>
  )
}
