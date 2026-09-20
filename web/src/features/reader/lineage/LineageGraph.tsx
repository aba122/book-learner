import type { LineageGraphData, LineageNode } from '../../../types'
import { layout, NODE_H, NODE_W } from './layout'

interface Props {
  graph: LineageGraphData
  selectedId: string | null
  onSelect: (node: LineageNode) => void
}

/**
 * 自绘脉络图(plan 2026-09-19,不引第三方库):
 * 连线用底层 SVG(贝塞尔 + 箭头),节点用绝对定位的 HTML 卡片叠在上面(便于文本换行与点击)。
 * 主题感知:SVG 用 CSS 变量,卡片用 tailwind 令牌。
 */
export default function LineageGraph({ graph, selectedId, onSelect }: Props) {
  const { nodes, width, height } = layout(graph)
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
            const y1 = a.y + NODE_H
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
                  <text x={(x1 + x2) / 2} y={my - 3} textAnchor="middle" fill="var(--ink-3)" style={{ font: '500 10px var(--font-sans)' }}>
                    {e.label}
                  </text>
                )}
              </g>
            )
          })}
        </svg>
        {nodes.map(n => (
          <button
            key={n.id}
            type="button"
            onClick={() => onSelect(n)}
            style={{ left: n.x, top: n.y, width: NODE_W, minHeight: NODE_H }}
            className={`absolute flex cursor-pointer flex-col gap-1 rounded-m border p-2.5 text-left shadow-card transition-colors ${selectedId === n.id ? 'border-new bg-new-soft' : 'border-line bg-paper-2 hover:border-new'}`}
          >
            {n.kind && <span className="text-[10px] font-medium tracking-wide text-ink-4">{n.kind}</span>}
            <span className="text-sm font-semibold leading-snug text-ink-1">{n.title}</span>
            {n.summary && <span className="line-clamp-3 text-xs leading-snug text-ink-3">{n.summary}</span>}
          </button>
        ))}
      </div>
    </div>
  )
}
