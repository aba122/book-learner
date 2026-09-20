import { useCallback, useState } from 'react'
import { backend } from '../../backend'
import AsyncError from '../../components/AsyncError'
import Button from '../../components/Button'
import Dialog from '../../components/Dialog'
import Skeleton from '../../components/Skeleton'
import { useAsyncResource } from '../../lib/useAsyncResource'
import { useBackendOperation } from '../../lib/useBackendOperation'
import type { Book, ExportReport } from '../../types'

/**
 * Obsidian 导出(M3 T2;视觉改版第二批改用 Dialog):预览清单(只读 SQLite 生成)→ 确认导出(增量写入目标目录)→ 结果与"在 Finder 中显示"。
 * 目标目录来自设置页"Obsidian 仓库路径";不存在时提示去设置页,不自动创建 vault 根。
 */
export default function ExportDialog({ book, onClose }: { book: Book; onClose: () => void }) {
  const preview = useAsyncResource(useCallback(() => backend.exportPreview(book.id), [book.id]))
  const [report, setReport] = useState<ExportReport | null>(null)
  const exportOp = useBackendOperation(async () => { setReport(await backend.exportObsidian(book.id)) })
  const revealOp = useBackendOperation(async () => backend.exportReveal(book.id))
  const exporting = exportOp.pending.has('export')
  const exportError = exportOp.errors.get('export')
  const revealError = revealOp.errors.get('reveal')

  return (
    <Dialog
      open
      title="导出到 Obsidian"
      description={`《${book.title}》· 学习报告、各块复述终稿与评估历史、附加环节产出,写成带属性头(frontmatter)与双链(wikilink)的 Markdown,可直接在 Obsidian 里打开。`}
      size="xl"
      closeButton={false}
      dismissible={!exporting}
      onClose={onClose}
      footer={
        preview.data === null ? undefined : report ? (
          <>
            <Button onClick={() => { revealOp.clearError('reveal'); void revealOp.run('reveal') }} disabled={revealOp.pending.has('reveal')}>在 Finder 中显示</Button>
            <Button variant="primary" onClick={onClose}>完成</Button>
          </>
        ) : (
          <>
            <Button onClick={onClose} disabled={exporting}>取消</Button>
            <Button
              variant="primary"
              disabled={exporting || !preview.data.targetExists}
              onClick={() => { exportOp.clearError('export'); void exportOp.run('export') }}
            >
              {exporting ? '导出中…' : '确认导出'}
            </Button>
          </>
        )
      }
    >
      {preview.data === null ? (
        preview.error ? <AsyncError error={preview.error} onRetry={preview.reload} variant="compact" /> : <Skeleton lines={5} />
      ) : report ? (
        <>
          <div className="rounded-m bg-inset px-4 py-3 text-body text-label-2">
            已导出到 <code className="font-mono text-label-1">{report.dir}</code>:写入 <span data-testid="export-written">{report.written}</span> 个文件,<span data-testid="export-unchanged">{report.unchanged}</span> 个未变化。
          </div>
          {revealError && <div className="mt-3"><AsyncError error={revealError} onRetry={() => void revealOp.retry('reveal')} variant="compact" /></div>}
        </>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="text-subhead text-label-2">
            目标目录:<code className="font-mono text-label-1">{preview.data.target}</code>
            {!preview.data.targetExists && (
              <span role="alert" className="ml-2 text-weak">目录不存在——先在设置页修改“Obsidian 仓库路径”或手动创建它,导出不会自动创建 vault 根目录。</span>
            )}
          </div>
          <ul data-testid="export-files" className="max-h-64 overflow-y-auto rounded-m border border-sep bg-inset px-3 py-2 font-mono text-footnote leading-relaxed text-label-1">
            {preview.data.files.map(f => <li key={f}>{f}</li>)}
          </ul>
          <p className="text-footnote text-label-3">共 {preview.data.files.length} 个文件;内容未变化的文件不会重写,目录里你自己的笔记不受影响。</p>
          {exportError && <AsyncError error={exportError} onRetry={() => void exportOp.retry('export')} variant="compact" />}
        </div>
      )}
    </Dialog>
  )
}
