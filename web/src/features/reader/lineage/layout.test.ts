import { describe, expect, it } from 'vitest'
import type { LineageGraphData } from '../../../types'
import { layout, NODE_H, PAD } from './layout'

function node(id: string, extra: Partial<{ x: number | null; y: number | null }> = {}) {
  return { id, title: id.toUpperCase(), summary: '', detail: '', kind: '', blockIds: [], spineHrefs: [], x: null, y: null, userEdited: false, ...extra }
}

describe('脉络图布局(plan 2026-09-19)', () => {
  it('空图返回零节点与内边距尺寸', () => {
    const l = layout({ nodes: [], edges: [] })
    expect(l.nodes).toHaveLength(0)
    expect(l.width).toBe(PAD * 2)
  })

  it('链式 a→b→c 按最长路径逐层下降', () => {
    const g: LineageGraphData = { nodes: [node('a'), node('b'), node('c')], edges: [{ from: 'a', to: 'b', label: '' }, { from: 'b', to: 'c', label: '' }] }
    const l = layout(g)
    const y = (id: string) => l.nodes.find(n => n.id === id)!.y
    expect(y('a')).toBeLessThan(y('b'))
    expect(y('b')).toBeLessThan(y('c'))
    expect(y('a')).toBe(PAD)
  })

  it('汇聚点取最长路径层:a→b→d 与 a→d 时 d 在 b 下方', () => {
    const g: LineageGraphData = {
      nodes: [node('a'), node('b'), node('d')],
      edges: [{ from: 'a', to: 'b', label: '' }, { from: 'b', to: 'd', label: '' }, { from: 'a', to: 'd', label: '' }],
    }
    const l = layout(g)
    const y = (id: string) => l.nodes.find(n => n.id === id)!.y
    expect(y('d')).toBeGreaterThan(y('b'))
  })

  it('用户手改坐标原样保留', () => {
    const g: LineageGraphData = { nodes: [node('a', { x: 500, y: 300 }), node('b')], edges: [{ from: 'a', to: 'b', label: '' }] }
    const l = layout(g)
    const a = l.nodes.find(n => n.id === 'a')!
    expect(a.x).toBe(500)
    expect(a.y).toBe(300)
  })

  it('成环不死循环:环内节点退化到最底层', () => {
    const g: LineageGraphData = {
      nodes: [node('a'), node('b'), node('c')],
      edges: [{ from: 'a', to: 'b', label: '' }, { from: 'b', to: 'c', label: '' }, { from: 'c', to: 'b', label: '' }],
    }
    const l = layout(g)
    expect(l.nodes).toHaveLength(3)
    // a 在顶层;b、c 同处一个环、都没被拓扑处理 → 一起退到最底层,严格低于 a
    const y = (id: string) => l.nodes.find(n => n.id === id)!.y
    expect(y('a')).toBeLessThan(y('c'))
    expect(y('b')).toBe(y('c'))
  })

  it('输出节点顺序与输入一致', () => {
    const g: LineageGraphData = { nodes: [node('a'), node('b'), node('c')], edges: [{ from: 'a', to: 'c', label: '' }] }
    expect(layout(g).nodes.map(n => n.id)).toEqual(['a', 'b', 'c'])
  })
})

describe('脉络图布局:真实高度', () => {
  it('层距按该层最高卡片算,连线锚点用节点自身高度', () => {
    const g: LineageGraphData = { nodes: [node('a'), node('b')], edges: [{ from: 'a', to: 'b', label: '' }] }
    const l = layout(g, { a: 200 })
    const a = l.nodes.find(n => n.id === 'a')!
    const b = l.nodes.find(n => n.id === 'b')!
    expect(a.h).toBe(200)
    expect(b.y).toBeGreaterThanOrEqual(a.y + 200)
    expect(b.h).toBe(NODE_H) // 没量到用默认
    expect(l.height).toBeGreaterThanOrEqual(b.y + b.h)
  })
  it('order 为阅读顺序(数组下标 +1)', () => {
    const g: LineageGraphData = { nodes: [node('x'), node('y')], edges: [] }
    expect(layout(g).nodes.map(n => n.order)).toEqual([1, 2])
  })
})
