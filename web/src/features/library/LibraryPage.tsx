import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { backend } from '../../backend'
import { normalizeBackendError, type BackendError } from '../../backend/errors'
import AsyncError from '../../components/AsyncError'
import Button from '../../components/Button'
import Confirm from '../../components/Confirm'
import PageHeader from '../../components/PageHeader'
import Tag from '../../components/Tag'
import { useSession } from '../../store'
import type { Book, BookStatus } from '../../types'
import ImportWizard from './ImportWizard'

const STATUS_LABEL: Record<BookStatus, string> = {
  active: '主攻中',
  paused: '暂候',
  finished: '已读完',
}

/* 封面色:按书名首字符稳定取三任务色之一,纸上仅作书脊点缀 */
const SPINE = ['bg-new', 'bg-review', 'bg-weak']

export default function LibraryPage() {
  const navigate = useNavigate()
  const setActiveBookId = useSession(s => s.setActiveBookId)
  const [books, setBooks] = useState<Book[] | null>(null)
  const [wizardOpen, setWizardOpen] = useState(false)
  const [switchTarget, setSwitchTarget] = useState<Book | null>(null)
  const [booksError, setBooksError] = useState<BackendError | null>(null)
  const [switchError, setSwitchError] = useState<BackendError | null>(null)
  const [switching, setSwitching] = useState(false)
  const mounted = useRef(false)
  const listGeneration = useRef(0)
  const switchGeneration = useRef(0)
  const switchGuard = useRef(false)

  const reload = useCallback(async () => {
    if (!mounted.current) return false
    const generation = ++listGeneration.current
    setBooksError(null)
    try {
      const list = await backend.listBooks()
      if (!mounted.current || generation !== listGeneration.current) return false
      setBooks([...list].sort((a, z) => Number(z.status === 'active') - Number(a.status === 'active')))
      return true
    } catch (error) {
      if (!mounted.current || generation !== listGeneration.current) return false
      setBooksError(normalizeBackendError(error))
      return false
    }
  }, [])

  useEffect(() => {
    mounted.current = true
    void reload()
    return () => {
      mounted.current = false
      listGeneration.current += 1
      switchGeneration.current += 1
      switchGuard.current = false
    }
  }, [reload])

  const open = (book: Book) => {
    if (book.status === 'active') navigate(`/map/${book.id}`)
    else {
      setSwitchError(null)
      setSwitchTarget(book)
    }
  }

  const confirmSwitch = async () => {
    if (!switchTarget || switchGuard.current) return
    const target = switchTarget
    const generation = ++switchGeneration.current
    switchGuard.current = true
    setSwitching(true)
    setSwitchError(null)
    try {
      await backend.setActiveBook(target.id)
      if (!mounted.current || generation !== switchGeneration.current) return
      setActiveBookId(target.id)
      setSwitchTarget(null)
      void reload()
    } catch (error) {
      if (!mounted.current || generation !== switchGeneration.current) return
      setSwitchError(normalizeBackendError(error))
    } finally {
      if (generation === switchGeneration.current) {
        switchGuard.current = false
        if (mounted.current) setSwitching(false)
      }
    }
  }

  const cancelSwitch = () => {
    if (switchGuard.current) return
    setSwitchError(null)
    setSwitchTarget(null)
  }

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

      {booksError && books !== null && (
        <div className="mb-6">
          <AsyncError error={booksError} onRetry={reload} variant="compact" />
        </div>
      )}

      {booksError && books === null ? (
        <AsyncError error={booksError} onRetry={reload} />
      ) : books === null ? (
        <p className="text-sm text-ink-3">正在打开书架…</p>
      ) : books.length === 0 ? (
        <p className="text-sm text-ink-3">书架还空着——导入一本 EPUB 开始。</p>
      ) : (
        <div className="grid grid-cols-3 gap-6 sm:grid-cols-4">
          {books.map(book => (
            <button
              key={book.id}
              onClick={() => open(book)}
              className="group cursor-pointer text-left"
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
          ))}
        </div>
      )}

      <ImportWizard open={wizardOpen} onClose={() => setWizardOpen(false)} />
      <Confirm
        open={switchTarget !== null}
        title="切换主攻书?"
        message={`当前进行中的书会暂停,《${switchTarget?.title ?? ''}》将成为唯一主攻书。今日队列明天起按新书生成。`}
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
    </div>
  )
}
