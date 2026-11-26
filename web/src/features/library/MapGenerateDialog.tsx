import { useCallback, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { backend } from '../../backend'
import AsyncError from '../../components/AsyncError'
import Button from '../../components/Button'
import Dialog from '../../components/Dialog'
import ProgressBar from '../../components/ProgressBar'
import { newClientId } from '../../lib/ids'
import { useAsyncResource } from '../../lib/useAsyncResource'
import { useBackendOperation } from '../../lib/useBackendOperation'
import type { Book, SpineChapter } from '../../types'
import MapChoice from './MapChoice'
import { extractChapters, generateMap } from './mapJob'

/**
 * 书架「生成知识地图」(BL-036):给导入时没生成地图的书补生成。
 * 打开先从受管 EPUB 抽取章节(数章节、估用时),停在与导入向导相同的说明;确认后跑同一套地图流程
 * (章节没写入过的 staged 书先写入),完成跳地图页。生成中不可关(与导入向导一致)。
 */
export default function MapGenerateDialog({ book, onClose }: { book: Book; onClose: () => void }) {
  const navigate = useNavigate()
  const [progress, setProgress] = useState<string | null>(null)
  /** 地图作业 id:每次打开生成一次,失败重试复用(runMapJob 同 jobId 幂等) */
  const [jobId] = useState(newClientId)
  const chapters = useAsyncResource(
    useCallback(() => extractChapters(() => backend.epubUrl(book.id), setProgress), [book.id]),
  )
  const mapOp = useBackendOperation(
    async (list: SpineChapter[]) => {
      if (book.importState === 'staged') await backend.storeSpine(book.id, list)
      await generateMap(book.id, jobId, () => backend.epubUrl(book.id), setProgress)
    },
    { onCommitted: async () => navigate(`/map/${book.id}`) },
  )
  const generating = mapOp.pending.has('map')
  const mapError = mapOp.errors.get('map')
  const list = chapters.data
  const run = () => {
    if (!list) return
    mapOp.clearError('map')
    void mapOp.run('map', list)
  }

  return (
    <Dialog
      open
      title={mapError ? '知识地图没有生成' : '生成知识地图'}
      label="生成知识地图"
      closeButton={false}
      description={`《${book.title}》`}
      size="lg"
      dismissible={!generating}
      onClose={onClose}
      footer={
        generating ? undefined : mapError ? (
          <Button onClick={onClose}>关闭</Button>
        ) : (
          <>
            <Button onClick={onClose}>取消</Button>
            <Button variant="primary" disabled={!list} onClick={run}>生成知识地图</Button>
          </>
        )
      }
    >
      {generating || (!list && !chapters.error) ? (
        <div className="py-4" aria-busy="true">
          <ProgressBar label={generating ? '生成进度' : '读取进度'} value={null} />
          <p className="mt-4 font-serif text-title3 text-label-1">{progress ?? '正在读取这本书…'}</p>
          {generating && <p className="mt-1 text-callout text-label-3">AI 正在逐章拆分知识块,生成期间请保持攻书开着</p>}
        </div>
      ) : mapError ? (
        <AsyncError error={mapError} onRetry={run} />
      ) : chapters.error ? (
        <AsyncError error={chapters.error} onRetry={chapters.reload} />
      ) : list ? (
        <MapChoice chapters={list} />
      ) : null}
    </Dialog>
  )
}
