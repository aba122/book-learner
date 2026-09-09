import type { Book } from 'epubjs'
import type { Backend } from '../backend/types'
import type { AnchorSegment } from '../types'
import { resolveBlockAnchors } from './anchors'
import { EXTRACT_YIELD_EVERY, yieldToMain } from './extract'

export interface AnchorBackfillProgress {
  done: number
  total: number
}
export interface AnchorBackfillReport {
  /** 本次解析并写回的块数 */
  resolved: number
  /** 已是精确锚点、无需处理的块数 */
  skipped: number
  /** 解析或写回失败的块数(不阻塞导入,回读原文退回整章) */
  failed: number
}

/**
 * 锚点回填(BL-001):地图落库时每块只有 `chapter_fallback` 段(hint = 小节标题),这里在 JS 侧用 epub.js 把
 * 小节标题解析成精确的两点 CFI 并经 `setAnchorSegments` 写回。幂等:已全是 `exact` 的块跳过;单块失败不影响其它块。
 */
export async function anchorBlocks(
  book: Book,
  blocks: readonly { id: number }[],
  backend: Pick<Backend, 'listAnchors' | 'setAnchorSegments'>,
  onProgress?: (p: AnchorBackfillProgress) => void,
): Promise<AnchorBackfillReport> {
  const report: AnchorBackfillReport = { resolved: 0, skipped: 0, failed: 0 }
  let done = 0
  for (const block of blocks) {
    try {
      const existing = await backend.listAnchors(block.id)
      if (existing.length === 0 || existing.every(s => s.precision === 'exact')) {
        report.skipped += 1
      } else {
        const hints = existing.map(s => ({ spineHref: s.spineHref, hint: s.hint }))
        const segments: AnchorSegment[] = await resolveBlockAnchors(book, hints)
        await backend.setAnchorSegments(block.id, segments)
        report.resolved += 1
      }
    } catch (error) {
      report.failed += 1
      console.error('[anchors] block', block.id, 'backfill failed:', error instanceof Error ? error.message : String(error))
    }
    done += 1
    onProgress?.({ done, total: blocks.length })
    if (done % EXTRACT_YIELD_EVERY === 0) await yieldToMain()
  }
  return report
}
