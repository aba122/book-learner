import { useCallback, useState } from 'react'
import { backend } from '../../backend'
import AsyncError from '../../components/AsyncError'
import Button from '../../components/Button'
import EmptyState from '../../components/EmptyState'
import IconButton from '../../components/IconButton'
import Skeleton from '../../components/Skeleton'
import { useAsyncResource } from '../../lib/useAsyncResource'
import LineageGraphView from '../reader/lineage/LineageGraph'

const chapterLabel = (title: string, seq: number) => title.trim() || `第 ${seq + 1} 节`

interface Props {
  bookId: number
  /** 空态「去阅读器生成」:与「回读原文」同一去处 */
  onGoReader: () => void
}

/**
 * 费曼页右侧「脉络图」栏(BL-029):只读展示阅读时在阅读器里生成的这本书的脉络图,
 * 讲授时对照全书脉络;点节点看摘要与详情。生成/更新/修正/手改仍在阅读器右栏。
 */
export default function LineageAside({ bookId, onGoReader }: Props) {
  // 包一层:lineageGet 的 null 表示"还没生成",要与 hook 的"未加载"区分
  const res = useAsyncResource(useCallback(async () => ({ graph: await backend.lineageGet(bookId) }), [bookId]))
  const graph = res.data?.graph ?? null
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const selected = graph?.graph.nodes.find(n => n.id === selectedId) ?? null
  const selectedOrder = selected && graph ? graph.graph.nodes.indexOf(selected) + 1 : 0
  const behind = graph !== null && graph.currentSeq > graph.upToSeq

  let body
  if (res.loading) {
    body = (
      <div aria-busy="true" className="p-4">
        <Skeleton lines={4} />
      </div>
    )
  } else if (res.error) {
    body = (
      <div className="p-3">
        <AsyncError error={res.error} onRetry={() => void res.reload()} variant="compact" />
      </div>
    )
  } else if (!graph || graph.graph.nodes.length === 0) {
    body = (
      <EmptyState
        compact
        icon="map"
        title="还没有脉络图"
        body="在阅读器右栏「脉络图」里生成到当前进度后,讲授时就能在这里对照。"
        action={
          <Button size="sm" onClick={onGoReader}>
            去阅读器生成
          </Button>
        }
        className="flex-1"
      />
    )
  } else {
    body = (
      <>
        <div className="px-3 pb-1 text-footnote text-label-3">
          <p className="truncate">覆盖到:{chapterLabel(graph.upToTitle, graph.upToSeq)}</p>
          {behind && <p className="truncate">已读到「{chapterLabel(graph.currentTitle, graph.currentSeq)}」,可在阅读器里更新</p>}
        </div>
        <div className="relative flex min-h-0 flex-1 flex-col px-3 pb-3">
          <LineageGraphView graph={graph.graph} selectedId={selectedId} onSelect={n => setSelectedId(n.id)} onDeselect={() => setSelectedId(null)} />
          {selected && (
            <div
              className="absolute inset-x-4 bottom-4 z-10 max-h-[60%] overflow-y-auto rounded-m bg-card p-3 shadow-popover ring-1 ring-sep/60"
              role="dialog"
              aria-label={`节点 ${selected.title}`}
              data-testid="feynman-lineage-detail"
            >
              <div className="mb-1 flex items-center justify-between">
                <span className="text-footnote font-medium text-label-3">
                  节点 {selectedOrder}
                  {selected.kind && ` · ${selected.kind}`}
                </span>
                <IconButton icon="xmark" size="sm" label="关闭" onClick={() => setSelectedId(null)} />
              </div>
              <p className="text-body font-semibold leading-snug text-label-1">{selected.title}</p>
              {selected.summary && <p className="mt-1 text-callout leading-relaxed text-label-2">{selected.summary}</p>}
              {selected.detail && <p className="mt-1 text-callout leading-relaxed text-label-3">{selected.detail}</p>}
            </div>
          )}
        </div>
      </>
    )
  }

  return (
    <aside aria-label="脉络图" className="flex w-96 shrink-0 flex-col border-l border-sep bg-inset/50">
      <h2 className="px-4 pt-4 pb-2 text-footnote font-medium text-label-3">脉络图</h2>
      {body}
    </aside>
  )
}
