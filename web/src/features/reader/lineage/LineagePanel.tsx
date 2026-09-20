import { useCallback, useEffect, useRef, useState } from 'react'
import { backend } from '../../../backend'
import { BackendError } from '../../../backend/errors'
import Button from '../../../components/Button'
import { LINEAGE_AUTOSAVE_MS } from '../../../config'
import type { LineageGraph, LineageGraphData, LineageNode, LineageNodeSource } from '../../../types'
import LineageGraphView from './LineageGraph'

const errorText = (e: unknown) => (e instanceof BackendError ? e.message : e instanceof Error ? e.message : '操作失败,请重试。')

interface Props {
  bookId: number
  /** 「看原文」:让阅读器跳到该章 */
  onGoto?: (href: string) => void
  /** 「问一问这部分」:把节点内容带进问书的引用区 */
  onAsk?: (text: string) => void
}
type SaveState = 'idle' | 'pending' | 'saving' | 'saved' | 'error'
type Busy = null | 'generate' | 'update' | 'revise'
const BUSY_LABEL: Record<Exclude<Busy, null>, string> = {
  generate: '正在梳理已读内容…',
  update: '正在把新读的章节接进图里…',
  revise: '正在按你的理解修正…',
}

/**
 * 「脉络图」面板(plan 2026-09-19):
 * 按阅读进度生成节点-连线图;改动自动保存(防抖,离开时补写);有手改时「重新生成」先确认。
 * 第二批:读到更后面时「更新到最新进度」(增量、保留手改);「让 AI 按我的理解修正」(可只针对选中节点);
 * 节点详情浮层里「看原文」跳章、「问一问这部分」接问书;画布可缩放、方向键选节点。
 */
export default function LineagePanel({ bookId, onGoto, onAsk }: Props) {
  const [graph, setGraph] = useState<LineageGraph | null>(null)
  const [working, setWorking] = useState<LineageGraphData | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<Busy>(null)
  const [elapsed, setElapsed] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [confirmRegen, setConfirmRegen] = useState(false)
  const [reviseOpen, setReviseOpen] = useState(false)
  const [reviseText, setReviseText] = useState('')
  const [source, setSource] = useState<{ id: string; data: LineageNodeSource } | null>(null)
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

  // 选中节点 → 取「看原文」信息(图变了也重取)
  const updatedAt = graph?.updatedAt ?? ''
  useEffect(() => {
    if (!selectedId) return
    let alive = true
    void backend
      .lineageNodeSource(bookId, selectedId)
      .then(data => {
        if (alive) setSource({ id: selectedId, data })
      })
      .catch(() => {
        if (alive) setSource(null)
      })
    return () => {
      alive = false
    }
  }, [bookId, selectedId, updatedAt])

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

  /** 跑一次 AI 动作:先清掉待写手改(否则旧图会覆盖新图 / 和生成锁冲突) */
  const runAi = async (kind: Exclude<Busy, null>, fn: () => Promise<LineageGraph>) => {
    if (timer.current) clearTimeout(timer.current)
    pending.current = null
    setBusy(kind)
    setElapsed(0)
    setError(null)
    try {
      apply(await fn())
      return true
    } catch (e) {
      setError(errorText(e))
      return false
    } finally {
      setBusy(null)
    }
  }
  const generate = async (force = false) => {
    if (!force && hasHandEdits()) {
      setConfirmRegen(true)
      return
    }
    setConfirmRegen(false)
    setSelectedId(null)
    await runAi('generate', () => backend.lineageGenerate(bookId))
  }
  const update = () => runAi('update', () => backend.lineageUpdate(bookId))
  const revise = async () => {
    const text = reviseText.trim()
    if (!text) return
    const ok = await runAi('revise', () => backend.lineageRevise(bookId, selectedId, text))
    if (ok) {
      setReviseText('')
      setReviseOpen(false)
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
  const selectedOrder = selected && working ? working.nodes.indexOf(selected) + 1 : 0
  const behind = graph !== null && graph.currentSeq > graph.upToSeq
  const chapterLabel = (title: string, seq: number) => title.trim() || `第 ${seq + 1} 节`

  if (loading) return <p className="p-4 text-sm text-ink-3">载入脉络图…</p>

  const generating = busy && (
    <div className="flex flex-col gap-3 p-4" data-testid="lineage-skeleton" aria-live="polite">
      <p className="text-sm text-ink-2">
        {BUSY_LABEL[busy]} {elapsed}s
      </p>
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
        <Button variant="primary" disabled={!!busy} onClick={() => void generate()}>
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
          {behind && <p className="truncate text-new">已读到「{chapterLabel(graph.currentTitle, graph.currentSeq)}」</p>}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {saveHint && <span className={`text-[11px] ${saveState === 'error' ? 'text-weak' : 'text-ink-4'}`} data-testid="lineage-save-state">{saveHint}</span>}
          {behind && (
            <Button variant="primary" disabled={!!busy} onClick={() => void update()}>
              更新到最新进度
            </Button>
          )}
          <button className="cursor-pointer text-xs text-ink-4 hover:text-ink-1 disabled:cursor-default disabled:opacity-50" disabled={!!busy} onClick={() => void generate()}>
            重新生成
          </button>
        </div>
      </div>
      {confirmRegen && (
        <div className="flex items-center justify-between gap-2 rounded-m border border-warn/50 bg-paper-2 px-3 py-2 text-xs" role="alertdialog" aria-label="确认重新生成">
          <span className="text-ink-2">
            重新生成会覆盖你的手改({working.nodes.filter(n => n.userEdited).length} 处)。{behind && '只想接上新章节的话,用「更新到最新进度」。'}
          </span>
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
        <div className="relative flex min-h-0 flex-1 flex-col">
          <LineageGraphView graph={working} selectedId={selectedId} onSelect={n => setSelectedId(n.id)} onDeselect={() => setSelectedId(null)} />
          {selected && (
            <div className="absolute inset-x-1 bottom-1 z-10 max-h-[60%] overflow-y-auto rounded-m border border-line bg-paper-2 p-3 shadow-card" data-testid="lineage-detail" role="dialog" aria-label={`节点 ${selected.title}`}>
              <div className="mb-2 flex items-center justify-between">
                <span className="text-xs font-medium text-ink-4">
                  节点 {selectedOrder}
                  {selected.kind && ` · ${selected.kind}`}
                  {selected.userEdited && ' · ✎ 手改过'}
                </span>
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
                className="mb-2 h-16 w-full resize-none rounded-s border border-line bg-paper-1 px-2 py-1 text-xs leading-relaxed text-ink-2 outline-none focus:border-new"
                value={selected.detail}
                aria-label="节点详情"
                placeholder="展开说说这部分讲了什么…"
                onChange={e => patchSelected({ detail: e.target.value })}
              />
              {source?.id === selected.id && (source.data.hrefs.length > 0 || source.data.excerpt) && (
                <div className="mb-2 rounded-s border border-line bg-paper-1 p-2 text-xs">
                  <div className="mb-1 flex flex-wrap items-center gap-1">
                    <span className="text-ink-4">原文:</span>
                    {source.data.hrefs.map(h => (
                      <button
                        key={h.href}
                        className="cursor-pointer rounded-s bg-paper-3 px-1.5 py-0.5 text-ink-2 hover:text-new disabled:cursor-default disabled:opacity-50"
                        disabled={!onGoto}
                        onClick={() => onGoto?.(h.href)}
                      >
                        看原文:{h.title || h.href}
                      </button>
                    ))}
                    {source.data.blocks.map(b => (
                      <span key={b.id} className="rounded-s border border-line px-1.5 py-0.5 text-ink-3">块 #{b.id} {b.title}</span>
                    ))}
                  </div>
                  {source.data.excerpt && <p className="line-clamp-4 leading-relaxed text-ink-3">{source.data.excerpt}</p>}
                </div>
              )}
              <div className="flex items-center justify-between">
                <button
                  className="cursor-pointer text-xs text-new hover:underline disabled:cursor-default disabled:opacity-50"
                  disabled={!onAsk}
                  onClick={() => onAsk?.([selected.title, selected.summary, selected.detail].filter(Boolean).join('\n'))}
                >
                  💬 问一问这部分
                </button>
                <button className="cursor-pointer text-xs text-weak hover:underline" onClick={deleteSelected}>
                  删除节点
                </button>
              </div>
            </div>
          )}
        </div>
      )}
      {!busy && (
        <div className="rounded-m border border-line bg-paper-2 px-3 py-2 text-xs">
          <button className="flex w-full cursor-pointer items-center justify-between text-ink-2 hover:text-ink-1" aria-expanded={reviseOpen} onClick={() => setReviseOpen(o => !o)}>
            <span>✎ 让 AI 按我的理解修正</span>
            <span className="text-ink-4">{reviseOpen ? '收起' : '展开'}</span>
          </button>
          {reviseOpen && (
            <div className="mt-2 flex flex-col gap-2">
              <p className="text-[11px] text-ink-4">
                {selected ? `针对选中节点「${selected.title}」;取消选中则针对整张图。` : '针对整张图;先点一个节点可只改它。'}
              </p>
              <textarea
                className="h-16 w-full resize-none rounded-s border border-line bg-paper-1 px-2 py-1 text-xs leading-relaxed text-ink-1 outline-none focus:border-new"
                value={reviseText}
                aria-label="修正要求"
                placeholder="例如:把「消费者社会」拆成两个阶段;这两个节点其实是因果关系…"
                onChange={e => setReviseText(e.target.value)}
              />
              <div className="flex justify-end">
                <Button variant="primary" disabled={!reviseText.trim()} onClick={() => void revise()}>
                  修正
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
