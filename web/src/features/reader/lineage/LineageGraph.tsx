import { useCallback, useEffect, useRef, useState } from 'react'
import type { LineageGraphData, LineageNode } from '../../../types'
import { layout, NODE_W } from './layout'

interface Props {
  graph: LineageGraphData
  selectedId: string | null
  onSelect: (node: LineageNode) => void
}

/** 节点性质 → 左侧色条与徽标色(用现有主题令牌;未知性质用中性色) */
const KIND_STYLE: Record<string, { bar: string; badge: string }> = {
  阶段: { bar: 'border-l-new', badge: 'text-new' },
  主题: { bar: 'border-l-review', badge: 'text-review' },
  概念: { bar: 'border-l-ok', badge: 'text-ok' },
  转折: { bar: 'border-l-warn', badge: 'text-warn' },
  事件: { bar: 'border-l-weak', badge: 'text-weak' },
}
const KIND_DEFAULT = { bar: 'border-l-ink-4', badge: 'text-ink-4' }

/**
 * 自绘脉络图(plan 2026-09-19,不引第三方库):
 * 连线用底层 SVG(贝塞尔 + 箭头,标签带纸色描边),节点用绝对定位的 HTML 卡片叠在上面。
 * 卡片高度按内容自适应:渲染后量 DOM 高度回传给布局,层距与连线锚点都按真实高度算。
 */
export default function LineageGraph({ graph, selectedId, onSelect }: Props) {
  const [heights, setHeights] = useState<Record<string, number>>({})
  const observers = useRef(new Map<string, ResizeObserver>())
  /** 卡片挂载即量高、内容变化(ResizeObserver)再量;jsdom 无 RO 时只量一次 */
  const measure = useCallback((el: HTMLButtonElement | null) => {
    if (!el) return
    const id = el.dataset.id ?? ''
    const put = (h: number) => setHeights(prev => (prev[id] === h ? prev : { ...prev, [id]: h }))
    put(el.offsetHeight)
    if (typeof ResizeObserver === 'undefined') return
    observers.current.get(id)?.disconnect()
    const ro = new ResizeObserver(() => put(el.offsetHeight))
    ro.observe(el)
    observers.current.set(id, ro)
  }, [])
  useEffect(() => {
    const map = observers.current
    return () => {
      for (const ro of map.values()) ro.disconnect()
      map.clear()
    }
  }, [])

  const { nodes, width, height } = layout(graph, heights)
  const pos = new Map(nodes.map(n => [n.id, n]))
  return (
    <div className="min-h-0 flex-1 overflow-auto rounded-m border border-line bg-paper-1" data-testid="lineage-canvas">
      <div className="relative" style={{ width, height }}>
        <svg className="pointer-events-none absolute inset-0" width={width} height={height} aria-hidden>
          <defs>
            <marker id="bl-lineage-arrow" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto">
              <path d="M0,0 L7,3 L0,6 Z" fill="var(--ink-4)" />
            </marker>
          </defs>
          {graph.edges.map((e, i) => {
            const a = pos.get(e.from)
            const b = pos.get(e.to)
            if (!a || !b) return null
            const x1 = a.x + NODE_W / 2
            const y1 = a.y + a.h
            const x2 = b.x + NODE_W / 2
            const y2 = b.y
            const my = (y1 + y2) / 2
            return (
              <g key={`${e.from}-${e.to}-${i}`}>
                <path
                  d={`M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}`}
                  fill="none"
                  stroke="var(--ink-4)"
                  strokeWidth={1.5}
                  markerEnd="url(#bl-lineage-arrow)"
                />
                {e.label && (
                  <text
                    x={(x1 + x2) / 2}
                    y={my + 3}
                    textAnchor="middle"
                    fill="var(--ink-2)"
                    stroke="var(--paper-1)"
                    strokeWidth={4}
                    strokeLinejoin="round"
                    style={{ paintOrder: 'stroke', font: '500 10.5px var(--font-sans)' }}
                  >
                    {e.label}
                  </text>
                )}
              </g>
            )
          })}
        </svg>
        {nodes.map(n => {
          const ks = KIND_STYLE[n.kind] ?? KIND_DEFAULT
          const selected = selectedId === n.id
          return (
            <button
              key={n.id}
              ref={measure}
              data-id={n.id}
              type="button"
              aria-pressed={selected}
              onClick={() => onSelect(n)}
              style={{ left: n.x, top: n.y, width: NODE_W }}
              className={`absolute flex cursor-pointer flex-col gap-1 rounded-m border border-l-4 p-2.5 text-left shadow-card transition-all hover:-translate-y-0.5 ${ks.bar} ${selected ? 'border-new bg-new-soft ring-2 ring-new/40' : 'border-line bg-paper-2 hover:border-new'}`}
            >
              <span className="flex items-center gap-1.5 text-[10px] font-medium tracking-wide">
                <span className="rounded-full bg-paper-3 px-1.5 text-ink-3">{n.order}</span>
                {n.kind && <span className={ks.badge}>{n.kind}</span>}
                {n.userEdited && <span className="ml-auto text-ink-4" title="手改过">✎</span>}
              </span>
              <span className="text-sm font-semibold leading-snug text-ink-1">{n.title}</span>
              {n.summary && <span className="text-xs leading-snug text-ink-3">{n.summary}</span>}
            </button>
          )
        })}
      </div>
    </div>
  )
}
