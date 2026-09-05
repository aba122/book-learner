import type { KnowledgeBlock, MapEditOp } from '../../types'

export interface EditEntry {
  title: string
  moduleName: string
  skipped: boolean
  block: KnowledgeBlock
}

/**
 * 编辑态与原始块列表差分为稳定 id 操作集(顺序固定:renameModule → setSkipped → reorder)。
 * 页面不推算修订号,只把 listBooks 给的 mapRevision 原样带回;无差异返回空数组(调用方跳过后端)。
 */
export function diffMapOps(blocks: KnowledgeBlock[], edits: EditEntry[]): MapEditOp[] {
  const ops: MapEditOp[] = []
  for (const from of [...new Set(blocks.map(b => b.moduleName))]) {
    const renamed = edits.filter(e => e.block.moduleName === from).map(e => e.moduleName)
    const to = renamed[0]
    if (to !== undefined && to !== from && renamed.every(n => n === to)) ops.push({ op: 'renameModule', from, to })
  }
  for (const e of edits) {
    if (e.skipped !== e.block.skipped) ops.push({ op: 'setSkipped', blockId: e.block.id, skipped: e.skipped })
  }
  const newOrder = edits.map(e => e.block.id)
  if (newOrder.some((id, i) => id !== blocks[i]?.id)) ops.push({ op: 'reorder', blockIds: newOrder })
  return ops
}
