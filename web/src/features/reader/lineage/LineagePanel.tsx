import { useCallback, useEffect, useState } from 'react'
import { backend } from '../../../backend'
import { BackendError } from '../../../backend/errors'
import Button from '../../../components/Button'
import type { LineageGraph, LineageGraphData, LineageNode } from '../../../types'
import LineageGraphView from './LineageGraph'

const errorText = (e: unknown) => (e instanceof BackendError ? e.message : e instanceof Error ? e.message : '操作失败,请重试。')

interface Props {
  bookId: number
}

/**
 * 「脉络图」面板(plan 2026-09-19,第一批):
 * 按阅读进度手动生成节点-连线图;看图;点节点改名/改摘要/删节点并「保存手改」。
 * 增量更新、AI 按理解修正、看原文、问一问为第二批。
 */
export default function LineagePanel({ bookId }: Props) {
  const [graph, setGraph] = useState<LineageGraph | null>(null)
  const [working, setWorking] = useState<LineageGraphData | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)

  const apply = useCallback((g: LineageGraph | null) => {
    setGraph(g)
    setWorking(g ? structuredClone(g.graph) : null)
    setDirty(false)
  }, [])

  // 挂载/切书时载入当前图;避免在 effect 里同步 setState(先 await 再落状态)
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const g = await backend.lineageGet(bookId)
        if (!alive) return
        setSelectedId(null)
        apply(g)
        setError(null)
      } catch (e) {
        if (alive) setError(errorText(e))
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [bookId, apply])

  const generate = async () => {
    setBusy(true)
    setError(null)
    setSelectedId(null)
    try {
      apply(await backend.lineageGenerate(bookId))
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  const save = async () => {
    if (!working) return
    setBusy(true)
    setError(null)
    try {
      apply(await backend.lineageSave(bookId, working))
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  const patchSelected = (patch: Partial<LineageNode>) => {
    if (!working || !selectedId) return
    setWorking({ ...working, nodes: working.nodes.map(n => (n.id === selectedId ? { ...n, ...patch, userEdited: true } : n)) })
    setDirty(true)
  }
  const deleteSelected = () => {
    if (!working || !selectedId) return
    setWorking({
      nodes: working.nodes.filter(n => n.id !== selectedId),
      edges: working.edges.filter(e => e.from !== selectedId && e.to !== selectedId),
    })
    setSelectedId(null)
    setDirty(true)
  }

  const selected = working?.nodes.find(n => n.id === selectedId) ?? null
  const behind = graph !== null && graph.currentSeq > graph.upToSeq

  if (loading) return <p className="p-4 text-sm text-ink-3">载入脉络图…</p>

  if (!graph || !working) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-4xl" aria-hidden>🗺</p>
        <p className="text-sm font-medium text-ink-1">还没有脉络图</p>
        <p className="max-w-xs text-xs leading-relaxed text-ink-3">
          让 AI 把你从开头读到当前进度的内容,梳理成一张逻辑清晰的脉络图。生成后可点每个节点改名、改摘要并保存。
        </p>
        {error && <p className="text-xs text-weak">{error}</p>}
        <Button variant="primary" disabled={busy} onClick={() => void generate()}>
          {busy ? '生成中…' : '生成脉络图到当前进度'}
        </Button>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-ink-3">
          覆盖到第 {graph.upToSeq + 1} 章{behind && <span className="text-new">(已读到第 {graph.currentSeq + 1} 章,可重新生成)</span>}
        </p>
        <div className="flex items-center gap-2">
          {dirty && (
            <Button variant="primary" disabled={busy} onClick={() => void save()}>
              {busy ? '保存中…' : '保存手改'}
            </Button>
          )}
          <button className="cursor-pointer text-xs text-ink-4 hover:text-ink-1" disabled={busy} onClick={() => void generate()}>
            {busy ? '生成中…' : behind ? '重新生成到最新进度' : '重新生成'}
          </button>
        </div>
      </div>
      {error && <p className="text-xs text-weak">{error}</p>}
      {working.nodes.length === 0 ? (
        <p className="flex-1 p-4 text-sm text-ink-3">这张图暂时没有节点,点「重新生成」试试。</p>
      ) : (
        <LineageGraphView graph={working} selectedId={selectedId} onSelect={n => setSelectedId(n.id)} />
      )}
      {selected && (
        <div className="rounded-m border border-line bg-paper-2 p-3" data-testid="lineage-detail">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-medium text-ink-4">编辑节点</span>
            <button className="cursor-pointer text-xs text-ink-4 hover:text-ink-1" onClick={() => setSelectedId(null)}>
              关闭
            </button>
          </div>
          <input
            className="mb-2 w-full rounded-s border border-line bg-paper-1 px-2 py-1 text-sm text-ink-1"
            value={selected.title}
            aria-label="节点标题"
            onChange={e => patchSelected({ title: e.target.value })}
          />
          <textarea
            className="mb-2 h-20 w-full resize-none rounded-s border border-line bg-paper-1 px-2 py-1 text-xs leading-relaxed text-ink-2"
            value={selected.summary}
            aria-label="节点摘要"
            placeholder="这一部分讲了什么…"
            onChange={e => patchSelected({ summary: e.target.value })}
          />
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-ink-4">「看原文」「问一问这部分」将在下一批加入</span>
            <button className="cursor-pointer text-xs text-weak hover:underline" onClick={deleteSelected}>
              删除节点
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
