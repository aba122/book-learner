import { useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { backend } from '../../backend'
import { BackendError } from '../../backend/errors'
import AsyncError from '../../components/AsyncError'
import Button from '../../components/Button'
import Card from '../../components/Card'
import { extractSpine, openEpub } from '../../epub/extract'
import { newClientId } from '../../lib/ids'
import { useBackendOperation } from '../../lib/useBackendOperation'
import type { BookType, SpineChapter } from '../../types'
import { progressLabel } from './importProgress'

const TYPES: { type: BookType; label: string; desc: string }[] = [
  { type: 'textbook', label: '教材', desc: '概念层层递进,依赖严格,逐块攻克后向前推进' },
  { type: 'methodology', label: '方法论', desc: '原则与案例并行,重在迁移到自己的场景' },
  { type: 'humanities', label: '人文·社科', desc: '主题与脉络优先,重理解、联结与观点' },
]

interface ImportAttempt {
  file: File
  type: BookType
  /** 地图作业 id:选类型时生成一次,重试复用(runMapJob 同 jobId 幂等) */
  jobId: string
  bookId?: number
  chapters?: SpineChapter[]
}

/** EPUB 抽取在 JS 侧(ADR-0004):解析失败是内容问题,不可重试 */
async function extractChapters(file: File, onProgress: (label: string) => void): Promise<SpineChapter[]> {
  let book: Awaited<ReturnType<typeof openEpub>> | null = null
  try {
    book = await openEpub(await file.arrayBuffer())
    return await extractSpine(book, p => onProgress(`正在抽取章节文本 ${p.done}/${p.total}:${p.title}`))
  } catch {
    throw new BackendError({ code: 'invalid_request', message: '无法解析这个 EPUB 文件', retryable: false })
  } finally {
    book?.destroy()
  }
}

export default function ImportWizard({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate()
  const [file, setFile] = useState<File | null>(null)
  /** 选到 PDF:不导入,提示先用 Calibre 转成 EPUB(PDF 原生导入见 IMPLEMENTATION_PLAN 范围外) */
  const [pdfName, setPdfName] = useState<string | null>(null)
  const [progress, setProgress] = useState<string | null>(null)
  const [attempt, setAttempt] = useState<ImportAttempt | null>(null)
  const importedBookId = useRef<number | null>(null)

  // 导入 → 抽取 spine → storeSpine → 地图作业(进度)为一个操作;每步成果记进 attempt,失败重试只重跑未完成的步骤
  const importOp = useBackendOperation(
    async (captured: ImportAttempt) => {
      let { bookId, chapters } = captured
      if (bookId === undefined) {
        setProgress('正在导入书籍…')
        bookId = (await backend.importEpub(captured.file, captured.type)).bookId
        setAttempt({ ...captured, bookId })
      }
      if (chapters === undefined) {
        setProgress('正在抽取章节文本…')
        chapters = await extractChapters(captured.file, setProgress)
        setAttempt({ ...captured, bookId, chapters })
      }
      await backend.storeSpine(bookId, chapters)
      setProgress('正在生成知识地图…')
      await backend.runMapJob(bookId, captured.jobId, p => setProgress(progressLabel(p)))
      importedBookId.current = bookId
    },
    {
      onCommitted: async () => {
        if (importedBookId.current !== null) navigate(`/map/${importedBookId.current}`)
      },
    },
  )
  const busy = importOp.pending.has('import')
  const failure = importOp.errors.get('import')

  if (!open) return null

  const close = () => {
    if (busy) return
    importOp.clearError('import')
    setFile(null)
    setProgress(null)
    setAttempt(null)
    onClose()
  }

  const runAttempt = (captured: ImportAttempt) => {
    importOp.clearError('import')
    setAttempt(captured)
    void importOp.run('import', captured)
  }

  const chooseType = (type: BookType) => {
    if (!file) return
    runAttempt({ file, type, jobId: newClientId() })
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
              <AsyncError error={failure} onRetry={() => runAttempt(attempt)} />
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
              <span className="mt-1 block text-xs text-ink-4">点击浏览本机文件(.epub;PDF 请先转成 EPUB)</span>
              <input
                type="file"
                accept=".epub,.pdf"
                className="sr-only"
                onChange={e => {
                  const picked = e.target.files?.[0] ?? null
                  if (picked && /\.pdf$/i.test(picked.name)) {
                    setPdfName(picked.name)
                    setFile(null)
                  } else {
                    setPdfName(null)
                    setFile(picked)
                  }
                }}
              />
            </label>
            {pdfName && (
              <div role="alert" className="mt-4 rounded-m bg-paper-3/60 px-4 py-3 text-sm leading-relaxed text-ink-2">
                《{pdfName.replace(/\.pdf$/i, '')}》是 PDF。攻书目前只读 EPUB,请先用 Calibre 转换后再导入(终端执行):
                <code className="mt-2 block select-all rounded-s bg-paper-1 px-3 py-2 text-xs text-ink-1">
                  ebook-convert "{pdfName}" "{pdfName.replace(/\.pdf$/i, '')}.epub" --enable-heuristics
                </code>
                <span className="mt-2 block text-xs text-ink-4">扫描版 PDF 没有文字层,需先 OCR;转换说明与常见问题见仓库 docs/pdf-import.md。</span>
              </div>
            )}
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
