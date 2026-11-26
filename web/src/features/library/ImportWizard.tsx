import { useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { backend } from '../../backend'
import { BackendError } from '../../backend/errors'
import AsyncError from '../../components/AsyncError'
import Button from '../../components/Button'
import Dialog from '../../components/Dialog'
import Icon from '../../components/icons/Icon'
import ProgressBar from '../../components/ProgressBar'
import { newClientId } from '../../lib/ids'
import { useBackendOperation } from '../../lib/useBackendOperation'
import type { BookType, SpineChapter } from '../../types'
import MapChoice from './MapChoice'
import { enqueueExcerpts, extractChapters, generateMap } from './mapJob'

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
  /** 章节已写入(storeSpine 完成):向导停在「要生成知识地图吗?」(BL-036) */
  stored?: boolean
  /** 书里的书名(壳层导入时取自 OPF);拿不到就用文件名 */
  title?: string
}

/** 选择这一步与失败时显示的书名:优先书里的书名(z-library 的文件名带一长串后缀) */
const bookName = (attempt: ImportAttempt) => attempt.title ?? attempt.file.name.replace(/\.epub$/i, '')

/**
 * 壳层导入校验失败(不是 EPUB、压缩包损坏、超过 200 MB)经 IPC 只剩固定文案「请求内容无效」(F8:不透传内部原因),
 * 向导里换成看得懂的说法(BL-035)
 */
const IMPORT_REJECTED = '这个文件导入不了:它不是有效的 EPUB,或者文件已损坏、超过 200 MB'

async function importFile(file: File, type: BookType): Promise<number> {
  try {
    return (await backend.importEpub(file, type)).bookId
  } catch (error) {
    if (error instanceof BackendError && error.code === 'invalid_request' && error.message === '请求内容无效') {
      throw new BackendError({ code: 'invalid_request', message: IMPORT_REJECTED, retryable: false })
    }
    throw error
  }
}

/**
 * 导入向导(视觉改版第二批):Dialog 原语(忙态不可关);拖放区可键盘触发;
 * 三种书型是大行按钮;忙态用不定进度条 + 进度文案(文案钉在测试里,不改)。
 * 知识地图可选(BL-036):抽完章节先问「要生成知识地图吗?」(章数、字数、预计用时);
 * 「暂不生成」或在这一步关掉 → 书留在书架上(能阅读、问书、整理书摘),书摘照常入队,以后可在书架补生成。
 */
export default function ImportWizard({
  open,
  onClose,
  onImportedWithoutMap,
}: {
  open: boolean
  onClose: () => void
  /** 章节已入库、没有生成地图就离开了向导(暂不生成 / 在选择这一步关掉 / 地图失败后关闭) */
  onImportedWithoutMap?: (bookId: number, title: string | undefined) => void
}) {
  const navigate = useNavigate()
  const [file, setFile] = useState<File | null>(null)
  /** 选到 PDF:不导入,提示先用 Calibre 转成 EPUB(PDF 原生导入见 IMPLEMENTATION_PLAN 范围外) */
  const [pdfName, setPdfName] = useState<string | null>(null)
  const [progress, setProgress] = useState<string | null>(null)
  const [attempt, setAttempt] = useState<ImportAttempt | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  // 第一段:导入 → 抽取 spine → storeSpine;每步成果记进 attempt,失败重试只重跑未完成的步骤
  const importOp = useBackendOperation(async (captured: ImportAttempt) => {
    let { bookId, chapters } = captured
    if (bookId === undefined) {
      setProgress('正在导入书籍…')
      bookId = await importFile(captured.file, captured.type)
      setAttempt({ ...captured, bookId })
    }
    if (chapters === undefined) {
      setProgress('正在抽取章节文本…')
      chapters = await extractChapters(() => captured.file.arrayBuffer(), setProgress)
      setAttempt({ ...captured, bookId, chapters })
    }
    await backend.storeSpine(bookId, chapters)
    const title = captured.title ?? (await backend.listBooks().catch(() => [])).find(b => b.id === bookId)?.title
    setAttempt({ ...captured, bookId, chapters, stored: true, title })
  })
  // 第二段(选了「生成知识地图」):地图作业(进度)→ 书摘入队 → 锚点回填 → 跳地图页
  const mapOp = useBackendOperation(
    (captured: ImportAttempt) => generateMap(captured.bookId!, captured.jobId, () => captured.file.arrayBuffer(), setProgress),
    { onCommitted: async (_key, captured) => navigate(`/map/${captured.bookId}`) },
  )
  const importing = importOp.pending.has('import')
  const busy = importing || mapOp.pending.has('map')
  const importFailure = importOp.errors.get('import')
  const failure = importFailure ?? mapOp.errors.get('map')

  const close = () => {
    if (busy) return
    const leftWithoutMap = attempt?.stored && attempt.bookId !== undefined ? attempt.bookId : null
    const leftTitle = attempt?.title
    importOp.clearError('import')
    mapOp.clearError('map')
    setFile(null)
    setPdfName(null)
    setProgress(null)
    setAttempt(null)
    if (leftWithoutMap !== null) {
      enqueueExcerpts(leftWithoutMap)
      onImportedWithoutMap?.(leftWithoutMap, leftTitle)
    }
    onClose()
  }

  const runImport = (captured: ImportAttempt) => {
    importOp.clearError('import')
    setAttempt(captured)
    void importOp.run('import', captured)
  }
  const runMap = (captured: ImportAttempt) => {
    mapOp.clearError('map')
    void mapOp.run('map', captured)
  }

  const chooseType = (type: BookType) => {
    if (!file) return
    runImport({ file, type, jobId: newClientId() })
  }

  const stage = busy ? 'busy' : failure && attempt ? 'failed' : attempt?.stored ? 'choose' : !file ? 'pick' : 'type'
  const title =
    stage === 'busy'
      ? '导入书籍'
      : stage === 'failed'
        ? importFailure ? '导入未完成' : '知识地图没有生成'
        : stage === 'choose'
          ? '要生成知识地图吗?'
          : stage === 'pick'
            ? '导入 EPUB'
            : '这是哪一类书?'
  const description =
    (stage === 'failed' || stage === 'choose') && attempt
      ? `《${bookName(attempt)}》· ${TYPES.find(t => t.type === attempt.type)?.label}`
      : stage === 'pick'
        ? '选择一本书导入书架;知识地图可以导入时生成,也可以以后再生成'
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
        ) : stage === 'choose' && attempt ? (
          <>
            <Button onClick={close}>暂不生成</Button>
            <Button variant="primary" onClick={() => runMap(attempt)}>生成知识地图</Button>
          </>
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
          <p className="mt-1 text-callout text-label-3">
            {importing ? '正在读取这本书,稍候就好' : 'AI 正在逐章拆分知识块,生成期间请保持攻书开着'}
          </p>
        </div>
      ) : stage === 'failed' && failure && attempt ? (
        <AsyncError error={failure} onRetry={() => (importFailure ? runImport(attempt) : runMap(attempt))} />
      ) : stage === 'choose' && attempt?.chapters ? (
        <MapChoice chapters={attempt.chapters} />
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
