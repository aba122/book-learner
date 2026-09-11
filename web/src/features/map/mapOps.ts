import type { KnowledgeBlock, MapEditOp } from '../../types'

export interface EditEntry {
  title: string
  moduleName: string
  skipped: boolean
  block: KnowledgeBlock
  /** 删除(BL-002):定稿时 delete;只对没学过的块可用,其余用跳过 */
  deleted: boolean
  /** 并入某块(BL-002):目标块 id;定稿时按目标聚合成 merge{into,from} */
  mergedInto: number | null
  /** 拆分(BL-002):定稿时 split{titleA,titleB},新块由 core 插在原块之后 */
  split: { titleA: string; titleB: string } | null
}

export function newEntry(block: KnowledgeBlock): EditEntry {
  return { title: block.title, moduleName: block.moduleName, skipped: block.skipped, block, deleted: false, mergedInto: null, split: null }
}

/** 还"在场"的行:未删除、未并入(可作合并目标、可拆分) */
export const isLive = (e: EditEntry) => !e.deleted && e.mergedInto === null

/**
 * 编辑态与原始块列表差分为稳定 id 操作集。顺序固定:
 * renameModule → delete → merge → setSkipped → reorder → split。
 * delete 在 reorder 之前(reorder 必须恰好列出现存块);split 在 reorder 之后(新块 id 未知,core 插在原块之后)。
 * 页面不推算修订号,只把 listBooks 给的 mapRevision 原样带回;无差异返回空数组(调用方跳过后端)。
 */
export function diffMapOps(blocks: KnowledgeBlock[], edits: EditEntry[]): MapEditOp[] {
  const ops: MapEditOp[] = []
  for (const from of [...new Set(blocks.map(b => b.moduleName))]) {
    const renamed = edits.filter(e => e.block.moduleName === from).map(e => e.moduleName)
    const to = renamed[0]
    if (to !== undefined && to !== from && renamed.every(n => n === to)) ops.push({ op: 'renameModule', from, to })
  }
  for (const e of edits) if (e.deleted) ops.push({ op: 'delete', blockId: e.block.id })
  const mergeInto = new Map<number, number[]>()
  for (const e of edits) {
    if (e.deleted || e.mergedInto === null) continue
    const list = mergeInto.get(e.mergedInto) ?? []
    list.push(e.block.id)
    mergeInto.set(e.mergedInto, list)
  }
  for (const [into, from] of mergeInto) ops.push({ op: 'merge', into, from })
  for (const e of edits) {
    if (!isLive(e)) continue
    if (e.skipped !== e.block.skipped) ops.push({ op: 'setSkipped', blockId: e.block.id, skipped: e.skipped })
  }
  const deleted = new Set(edits.filter(e => e.deleted).map(e => e.block.id))
  const newOrder = edits.filter(e => !e.deleted).map(e => e.block.id)
  const oldOrder = blocks.map(b => b.id).filter(id => !deleted.has(id))
  if (newOrder.some((id, i) => id !== oldOrder[i])) ops.push({ op: 'reorder', blockIds: newOrder })
  for (const e of edits) {
    if (isLive(e) && e.split) ops.push({ op: 'split', blockId: e.block.id, titleA: e.split.titleA, titleB: e.split.titleB })
  }
  return ops
}
