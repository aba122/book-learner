import { useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { backend } from '../../backend'
import { BackendError } from '../../backend/errors'
import AsyncError from '../../components/AsyncError'
import Button from '../../components/Button'
import Dialog from '../../components/Dialog'
import Icon from '../../components/icons/Icon'
import ProgressBar from '../../components/ProgressBar'
import { anchorBlocks } from '../../epub/anchorBlocks'
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

/**
 * 导入向导(视觉改版第二批):Dialog 原语(忙态不可关);拖放区可键盘触发;
 * 三种书型是大行按钮;忙态用不定进度条 + 进度文案(文案钉在测试里,不改)。
 */
export default function ImportWizard({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate()
  const [file, setFile] = useState<File | null>(null)
  /** 选到 PDF:不导入,提示先用 Calibre 转成 EPUB(PDF 原生导入见 IMPLEMENTATION_PLAN 范围外) */
  const [pdfName, setPdfName] = useState<string | null>(null)
  const [progress, setProgress] = useState<string | null>(null)
  const [attempt, setAttempt] = useState<ImportAttempt | null>(null)
  const importedBookId = useRef<number | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

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
      const blocks = await backend.runMapJob(bookId, captured.jobId, p => setProgress(progressLabel(p)))
      // 锚点回填(BL-001):把每块的小节标题解析成精确 CFI 写回;失败只退回整章,不阻塞导入
      setProgress(`正在定位原文 0/${blocks.length}`)
      let book: Awaited<ReturnType<typeof openEpub>> | null = null
      try {
        book = await openEpub(await captured.file.arrayBuffer())
        const report = await anchorBlocks(book, blocks, backend, p => setProgress(`正在定位原文 ${p.done}/${p.total}`))
        if (report.failed > 0) console.error('[anchors] backfill incomplete:', report)
      } catch (error) {
        console.error('[anchors] backfill skipped:', error instanceof Error ? error.message : String(error))
      } finally {
        book?.destroy()
      }
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

  const close = () => {
    if (busy) return
    importOp.clearError('import')
    setFile(null)
    setPdfName(null)
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

  const stage = busy ? 'busy' : failure && attempt ? 'failed' : !file ? 'pick' : 'type'
  const title = stage === 'busy' ? '导入书籍' : stage === 'failed' ? '导入未完成' : stage === 'pick' ? '导入 EPUB' : '这是哪一类书?'
  const description =
    stage === 'failed' && attempt
      ? `《${attempt.file.name.replace(/\.epub$/i, '')}》· ${TYPES.find(t => t.type === attempt.type)?.label}`
      : stage === 'pick'
        ? '选择一本书,交给 AI 拆分知识地图'
        : stage === 'type' && file
          ? `《${file.name.replace(/\.epub$/i, '')}》——类型决定拆块与讲授的模板`
          : undefined

  return (
    <Dialog
      open={open}
      title={title}
      label="导入书籍"
      closeButton={false}
      description={description}
      size="lg"
      dismissible={!busy}
      onClose={close}
      footer={
        stage === 'failed' ? (
          <Button onClick={close}>关闭</Button>
        ) : stage === 'pick' ? (
          <Button onClick={close}>取消</Button>
        ) : stage === 'type' ? (
          <>
            <Button onClick={() => setFile(null)}>重选文件</Button>
            <Button onClick={close}>取消</Button>
          </>
        ) : undefined
      }
    >
      {stage === 'busy' ? (
        <div className="py-4" aria-busy="true">
          <ProgressBar label="导入进度" value={null} />
          <p className="mt-4 font-serif text-title3 text-label-1">{progress ?? '正在处理…'}</p>
          <p className="mt-1 text-callout text-label-3">AI 正在通读目录并拆分知识块,请稍候</p>
        </div>
      ) : stage === 'failed' && failure && attempt ? (
        <AsyncError error={failure} onRetry={() => runAttempt(attempt)} />
      ) : stage === 'pick' ? (
        <>
          <label
            tabIndex={0}
            onKeyDown={e => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                fileInput.current?.click()
              }
            }}
            className="flex cursor-pointer flex-col items-center gap-2 rounded-l border-2 border-dashed border-sep bg-inset px-6 py-10 text-center transition-colors duration-[var(--dur-fast)] hover:border-accent focus-visible:border-accent"
          >
            <Icon name="doc-plus" size={28} className="text-label-3" />
            <span className="font-serif text-title3 text-label-1">选择 EPUB 文件</span>
            <span className="text-footnote text-label-3">点击浏览本机文件(.epub;PDF 请先转成 EPUB)</span>
            <input
              ref={fileInput}
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
            <div role="alert" className="mt-4 rounded-m bg-inset px-4 py-3 text-body leading-relaxed text-label-2">
              《{pdfName.replace(/\.pdf$/i, '')}》是 PDF。攻书目前只读 EPUB,请先用 Calibre 转换后再导入(终端执行):
              <code className="mt-2 block select-all rounded-s bg-card px-3 py-2 font-mono text-footnote text-label-1">
                ebook-convert "{pdfName}" "{pdfName.replace(/\.pdf$/i, '')}.epub" --enable-heuristics
              </code>
              <span className="mt-2 block text-footnote text-label-3">扫描版 PDF 没有文字层,需先 OCR;转换说明与常见问题见仓库 docs/pdf-import.md。</span>
            </div>
          )}
        </>
      ) : (
        <div className="flex flex-col gap-2">
          {TYPES.map(t => (
            <button
              key={t.type}
              type="button"
              aria-label={t.label}
              onClick={() => chooseType(t.type)}
              className="cursor-pointer rounded-m border border-sep bg-card px-4 py-3 text-left transition-colors duration-[var(--dur-fast)] hover:border-accent hover:bg-fill-hover"
            >
              <span className="font-serif text-title3 font-medium text-label-1">{t.label}</span>
              <span className="mt-0.5 block text-callout leading-relaxed text-label-2">{t.desc}</span>
            </button>
          ))}
        </div>
      )}
    </Dialog>
  )
}
