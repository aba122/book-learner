import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { backend } from '../../backend'
import { normalizeBackendError, type BackendError } from '../../backend/errors'
import AsyncError from '../../components/AsyncError'
import Button from '../../components/Button'
import Card from '../../components/Card'
import type { BookType } from '../../types'

const TYPES: { type: BookType; label: string; desc: string }[] = [
  { type: 'textbook', label: '教材', desc: '概念层层递进,依赖严格,逐块攻克后向前推进' },
  { type: 'methodology', label: '方法论', desc: '原则与案例并行,重在迁移到自己的场景' },
  { type: 'humanities', label: '人文·社科', desc: '主题与脉络优先,重理解、联结与观点' },
]

interface ImportAttempt {
  file: File
  type: BookType
  bookId?: number
}

export default function ImportWizard({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate()
  const [file, setFile] = useState<File | null>(null)
  const [progress, setProgress] = useState<string | null>(null)
  const [failure, setFailure] = useState<BackendError | null>(null)
  const [attempt, setAttempt] = useState<ImportAttempt | null>(null)
  const [busy, setBusy] = useState(false)
  const inFlight = useRef(false)
  const generation = useRef(0)
  const mounted = useRef(false)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      generation.current += 1
      inFlight.current = false
    }
  }, [])

  if (!open) return null

  const close = () => {
    if (inFlight.current) return
    generation.current += 1
    setFile(null)
    setProgress(null)
    setFailure(null)
    setAttempt(null)
    setBusy(false)
    onClose()
  }

  const runAttempt = async (captured: ImportAttempt) => {
    if (inFlight.current) return
    inFlight.current = true
    const currentGeneration = ++generation.current
    let nextAttempt = captured
    setAttempt(captured)
    setFailure(null)
    setBusy(true)
    setProgress(captured.bookId === undefined ? '正在导入书籍…' : '正在生成知识地图…')
    try {
      let bookId = captured.bookId
      if (bookId === undefined) {
        const imported = await backend.importEpub(captured.file, captured.type)
        if (!mounted.current || currentGeneration !== generation.current) return
        bookId = imported.bookId
        nextAttempt = { ...captured, bookId }
        setAttempt(nextAttempt)
      }
      await backend.generateMap(bookId, message => {
        if (mounted.current && currentGeneration === generation.current) setProgress(message)
      })
      if (!mounted.current || currentGeneration !== generation.current) return
      navigate(`/map/${bookId}`)
    } catch (error) {
      if (!mounted.current || currentGeneration !== generation.current) return
      setAttempt(nextAttempt)
      setFailure(normalizeBackendError(error))
      setProgress(null)
    } finally {
      if (currentGeneration === generation.current) {
        inFlight.current = false
        if (mounted.current) setBusy(false)
      }
    }
  }

  const chooseType = (type: BookType) => {
    if (!file) return
    void runAttempt({ file, type })
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="导入书籍"
      className="fixed inset-0 z-50 flex items-center justify-center"
    >
      <div className="absolute inset-0 bg-ink-1/25" onClick={busy ? undefined : close} />
      <Card className="relative w-130 max-w-[92vw] p-8 shadow-pop">
        {busy ? (
          <div className="py-6 text-center">
            <div
              aria-hidden
              className="mx-auto mb-5 h-8 w-8 animate-spin rounded-full border-2 border-line border-t-new"
            />
            <p className="font-serif text-lg text-ink-1">{progress ?? '正在处理…'}</p>
            <p className="mt-2 text-xs text-ink-3">AI 正在通读目录并拆分知识块,请稍候</p>
          </div>
        ) : failure && attempt ? (
          <>
            <h2 className="font-serif text-xl font-semibold text-ink-1">导入未完成</h2>
            <p className="mt-1 text-sm text-ink-3">
              《{attempt.file.name.replace(/\.epub$/i, '')}》· {TYPES.find(t => t.type === attempt.type)?.label}
            </p>
            <div className="mt-6">
              <AsyncError error={failure} onRetry={() => void runAttempt(attempt)} />
            </div>
            <div className="mt-5 flex justify-end">
              <Button onClick={close}>关闭</Button>
            </div>
          </>
        ) : !file ? (
          <>
            <h2 className="font-serif text-xl font-semibold text-ink-1">导入 EPUB</h2>
            <p className="mt-1 text-sm text-ink-3">选择一本书,交给 AI 拆分知识地图</p>
            <label className="mt-6 block cursor-pointer rounded-l border-2 border-dashed border-line bg-paper-1 px-6 py-12 text-center transition-colors hover:border-new hover:bg-paper-3/40">
              <span className="font-serif text-lg text-ink-2">选择 EPUB 文件</span>
              <span className="mt-1 block text-xs text-ink-4">点击浏览本机文件(.epub)</span>
              <input
                type="file"
                accept=".epub"
                className="sr-only"
                onChange={e => setFile(e.target.files?.[0] ?? null)}
              />
            </label>
            <div className="mt-5 flex justify-end">
              <Button onClick={close}>取消</Button>
            </div>
          </>
        ) : (
          <>
            <h2 className="font-serif text-xl font-semibold text-ink-1">这是哪一类书?</h2>
            <p className="mt-1 text-sm text-ink-3">
              《{file.name.replace(/\.epub$/i, '')}》——类型决定拆块与讲授的模板
            </p>
            <div className="mt-6 flex flex-col gap-3">
              {TYPES.map(t => (
                <button
                  key={t.type}
                  aria-label={t.label}
                  onClick={() => chooseType(t.type)}
                  className="cursor-pointer rounded-m border border-line bg-paper-1 px-5 py-4 text-left transition-colors hover:border-new hover:bg-paper-3/40"
                >
                  <span className="font-serif text-base font-medium text-ink-1">{t.label}</span>
                  <span className="mt-0.5 block text-xs leading-relaxed text-ink-3">{t.desc}</span>
                </button>
              ))}
            </div>
            <div className="mt-5 flex justify-between">
              <Button onClick={() => setFile(null)}>重选文件</Button>
              <Button onClick={close}>取消</Button>
            </div>
          </>
        )}
      </Card>
    </div>
  )
}
