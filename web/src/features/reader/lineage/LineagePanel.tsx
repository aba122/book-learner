import { useCallback, useEffect, useRef, useState } from 'react'
import { backend } from '../../../backend'
import { BackendError } from '../../../backend/errors'
import Button from '../../../components/Button'
import { LINEAGE_AUTOSAVE_MS } from '../../../config'
import type { LineageGraph, LineageGraphData, LineageNode } from '../../../types'
import LineageGraphView from './LineageGraph'

const errorText = (e: unknown) => (e instanceof BackendError ? e.message : e instanceof Error ? e.message : '操作失败,请重试。')

interface Props {
  bookId: number
}
type SaveState = 'idle' | 'pending' | 'saving' | 'saved' | 'error'

/**
 * 「脉络图」面板(plan 2026-09-19):
 * 按阅读进度手动生成节点-连线图;点节点改名/改摘要/改详情/删节点,改动自动保存(防抖,离开时补写);
 * 有手改时「重新生成」先确认。增量更新、AI 修正、看原文、问一问为第二批。
 */
export default function LineagePanel({ bookId }: Props) {
  const [graph, setGraph] = useState<LineageGraph | null>(null)
  const [working, setWorking] = useState<LineageGraphData | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [confirmRegen, setConfirmRegen] = useState(false)
  /** 待写的最新手改;定时器到点或卸载时写库 */
  const pending = useRef<LineageGraphData | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const apply = useCallback((g: LineageGraph | null) => {
    setGraph(g)
    setWorking(g ? structuredClone(g.graph) : null)
    setSaveState('idle')
  }, [])

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

  // 生成中计时(只在 busy 时开定时器)
  useEffect(() => {
    if (!busy) return
    const t = setInterval(() => setElapsed(e => e + 1), 1000)
    return () => clearInterval(t)
  }, [busy])

  const flush = useCallback(async () => {
    const data = pending.current
    if (!data) return
    pending.current = null
    setSaveState('saving')
    try {
      const g = await backend.lineageSave(bookId, data)
      // 只更新元信息;working 以本地为准(服务端会清掉正在改成空的标题,别把它从画布上抹掉)
      setGraph(g)
      setSaveState(pending.current ? 'pending' : 'saved')
    } catch (e) {
      setSaveState('error')
      setError(errorText(e))
    }
  }, [bookId])
  const scheduleSave = useCallback(
    (next: LineageGraphData) => {
      setWorking(next)
      pending.current = next
      setSaveState('pending')
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => void flush(), LINEAGE_AUTOSAVE_MS)
    },
    [flush],
  )
  // 卸载(离开阅读器)时补写未落库的手改
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
      const data = pending.current
      if (data) void backend.lineageSave(bookId, data).catch(() => {})
    },
    [bookId],
  )

  const hasHandEdits = () => pending.current !== null || (working?.nodes.some(n => n.userEdited) ?? false)

  const generate = async (force = false) => {
    if (!force && hasHandEdits()) {
      setConfirmRegen(true)
      return
    }
    setConfirmRegen(false)
    if (timer.current) clearTimeout(timer.current)
    pending.current = null
    setBusy(true)
    setElapsed(0)
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

  const patchSelected = (patch: Partial<LineageNode>) => {
    if (!working || !selectedId) return
    scheduleSave({ ...working, nodes: working.nodes.map(n => (n.id === selectedId ? { ...n, ...patch, userEdited: true } : n)) })
  }
  const deleteSelected = () => {
    if (!working || !selectedId) return
    scheduleSave({
      nodes: working.nodes.filter(n => n.id !== selectedId),
      edges: working.edges.filter(e => e.from !== selectedId && e.to !== selectedId),
    })
    setSelectedId(null)
  }

  const selected = working?.nodes.find(n => n.id === selectedId) ?? null
  const behind = graph !== null && graph.currentSeq > graph.upToSeq
  const chapterLabel = (title: string, seq: number) => title.trim() || `第 ${seq + 1} 节`

  if (loading) return <p className="p-4 text-sm text-ink-3">载入脉络图…</p>

  const generating = (
    <div className="flex flex-col gap-3 p-4" data-testid="lineage-skeleton" aria-live="polite">
      <p className="text-sm text-ink-2">正在梳理已读内容… {elapsed}s</p>
      <p className="text-xs text-ink-4">AI 通常需要 20–60 秒;收起面板也不会中断。</p>
      {[0, 1, 2].map(i => (
        <div key={i} className="animate-pulse rounded-m border border-line bg-paper-2 p-3">
          <div className="mb-2 h-3 w-1/3 rounded bg-paper-3" />
          <div className="h-3 w-4/5 rounded bg-paper-3" />
        </div>
      ))}
    </div>
  )

  if (!graph || !working) {
    if (busy) return generating
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-4xl" aria-hidden>🗺</p>
        <p className="text-sm font-medium text-ink-1">还没有脉络图</p>
        <p className="max-w-xs text-xs leading-relaxed text-ink-3">
          让 AI 把你从开头读到当前进度的内容,梳理成一张逻辑清晰的脉络图。生成后可点每个节点改名、改摘要,改动自动保存。
        </p>
        {error && <p className="text-xs text-weak" role="alert">{error}</p>}
        <Button variant="primary" disabled={busy} onClick={() => void generate()}>
          生成脉络图到当前进度
        </Button>
      </div>
    )
  }

  const saveHint =
    saveState === 'pending' ? '未保存…' : saveState === 'saving' ? '保存中…' : saveState === 'saved' ? '已保存' : saveState === 'error' ? '保存失败' : ''

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 text-xs text-ink-3">
          <p className="truncate">覆盖到:{chapterLabel(graph.upToTitle, graph.upToSeq)}</p>
          {behind && <p className="truncate text-new">已读到「{chapterLabel(graph.currentTitle, graph.currentSeq)}」,可重新生成到最新进度</p>}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {saveHint && <span className={`text-[11px] ${saveState === 'error' ? 'text-weak' : 'text-ink-4'}`} data-testid="lineage-save-state">{saveHint}</span>}
          <button className="cursor-pointer text-xs text-ink-4 hover:text-ink-1 disabled:cursor-default disabled:opacity-50" disabled={busy} onClick={() => void generate()}>
            {behind ? '重新生成到最新进度' : '重新生成'}
          </button>
        </div>
      </div>
      {confirmRegen && (
        <div className="flex items-center justify-between gap-2 rounded-m border border-warn/50 bg-paper-2 px-3 py-2 text-xs" role="alertdialog" aria-label="确认重新生成">
          <span className="text-ink-2">重新生成会覆盖你的手改({working.nodes.filter(n => n.userEdited).length} 处)。</span>
          <span className="flex shrink-0 gap-2">
            <button className="cursor-pointer text-ink-4 hover:text-ink-1" onClick={() => setConfirmRegen(false)}>取消</button>
            <button className="cursor-pointer font-medium text-warn hover:underline" onClick={() => void generate(true)}>确定重新生成</button>
          </span>
        </div>
      )}
      {error && <p className="text-xs text-weak" role="alert">{error}</p>}
      {busy ? (
        generating
      ) : working.nodes.length === 0 ? (
        <p className="flex-1 p-4 text-sm text-ink-3">这张图暂时没有节点,点「重新生成」试试。</p>
      ) : (
        <LineageGraphView graph={working} selectedId={selectedId} onSelect={n => setSelectedId(n.id)} />
      )}
      {selected && !busy && (
        <div className="rounded-m border border-line bg-paper-2 p-3" data-testid="lineage-detail">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-medium text-ink-4">编辑节点{selected.kind && ` · ${selected.kind}`}</span>
            <button className="cursor-pointer text-xs text-ink-4 hover:text-ink-1" onClick={() => setSelectedId(null)}>
              关闭
            </button>
          </div>
          <input
            className="mb-2 w-full rounded-s border border-line bg-paper-1 px-2 py-1 text-sm text-ink-1 outline-none focus:border-new"
            value={selected.title}
            aria-label="节点标题"
            onChange={e => patchSelected({ title: e.target.value })}
          />
          <textarea
            className="mb-2 h-12 w-full resize-none rounded-s border border-line bg-paper-1 px-2 py-1 text-xs leading-relaxed text-ink-2 outline-none focus:border-new"
            value={selected.summary}
            aria-label="节点摘要"
            placeholder="一句话摘要(卡片上显示)"
            onChange={e => patchSelected({ summary: e.target.value })}
          />
          <textarea
            className="mb-2 h-20 w-full resize-none rounded-s border border-line bg-paper-1 px-2 py-1 text-xs leading-relaxed text-ink-2 outline-none focus:border-new"
            value={selected.detail}
            aria-label="节点详情"
            placeholder="展开说说这部分讲了什么…"
            onChange={e => patchSelected({ detail: e.target.value })}
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
