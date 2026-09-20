import type { LineageGraphData, LineageNode } from '../../../types'

/** 卡片尺寸与层间距(纯常量,供布局与 SVG 连线共享) */
export const NODE_W = 190
export const NODE_H = 88
export const GAP_X = 44
export const GAP_Y = 76
export const PAD = 24

export interface PositionedNode extends LineageNode {
  x: number
  y: number
}
export interface Layout {
  nodes: PositionedNode[]
  width: number
  height: number
}

/**
 * 分层 DAG 布局(纯函数,plan 2026-09-19):
 * - 按 edges 用最长路径给每个节点定层(Kahn 拓扑序松弛),同层横向居中铺开;
 * - 用户手改过的坐标(x/y 非空)原样保留;
 * - 对成环节点退化到最底层,绝不死循环。
 */
export function layout(graph: LineageGraphData): Layout {
  const nodes = graph.nodes
  if (nodes.length === 0) return { nodes: [], width: PAD * 2, height: PAD * 2 }

  const order = new Map(nodes.map((n, i) => [n.id, i]))
  const edges = graph.edges.filter(e => order.has(e.from) && order.has(e.to) && e.from !== e.to)
  const indeg = new Map<string, number>(nodes.map(n => [n.id, 0]))
  const adj = new Map<string, string[]>(nodes.map(n => [n.id, []]))
  for (const e of edges) {
    adj.get(e.from)!.push(e.to)
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1)
  }

  // Kahn 拓扑 + 最长路径分层:队列出的节点层已定,再松弛后继
  const layer = new Map<string, number>(nodes.map(n => [n.id, 0]))
  const left = new Map(indeg)
  const queue = nodes.filter(n => (indeg.get(n.id) ?? 0) === 0).map(n => n.id)
  const seen = new Set<string>()
  while (queue.length > 0) {
    const u = queue.shift()!
    seen.add(u)
    for (const v of adj.get(u) ?? []) {
      layer.set(v, Math.max(layer.get(v) ?? 0, (layer.get(u) ?? 0) + 1))
      left.set(v, (left.get(v) ?? 0) - 1)
      if ((left.get(v) ?? 0) === 0) queue.push(v)
    }
  }
  // 环里没被处理到的节点:放到已定层的最底下一层,保持出现顺序
  let maxSeen = 0
  for (const n of nodes) if (seen.has(n.id)) maxSeen = Math.max(maxSeen, layer.get(n.id) ?? 0)
  for (const n of nodes) if (!seen.has(n.id)) layer.set(n.id, maxSeen + 1)

  const byLayer = new Map<number, LineageNode[]>()
  for (const n of nodes) {
    const l = layer.get(n.id) ?? 0
    const row = byLayer.get(l)
    if (row) row.push(n)
    else byLayer.set(l, [n])
  }
  let maxCols = 1
  for (const row of byLayer.values()) maxCols = Math.max(maxCols, row.length)

  const positioned: PositionedNode[] = []
  for (const [l, row] of byLayer) {
    const offset = (maxCols - row.length) / 2
    row.forEach((n, i) => {
      positioned.push({
        ...n,
        x: n.x ?? PAD + (offset + i) * (NODE_W + GAP_X),
        y: n.y ?? PAD + l * (NODE_H + GAP_Y),
      })
    })
  }
  positioned.sort((a, z) => (order.get(a.id) ?? 0) - (order.get(z.id) ?? 0))

  const width = Math.max(...positioned.map(n => n.x + NODE_W)) + PAD
  const height = Math.max(...positioned.map(n => n.y + NODE_H)) + PAD
  return { nodes: positioned, width, height }
}
