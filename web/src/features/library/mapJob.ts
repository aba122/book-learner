import { backend } from '../../backend'
import { BackendError } from '../../backend/errors'
import { anchorBlocks } from '../../epub/anchorBlocks'
import { extractSpine, openEpub } from '../../epub/extract'
import type { ExcerptFocus, SpineChapter } from '../../types'
import { progressLabel } from './importProgress'

/**
 * 知识地图可选(BL-036):导入向导与书架「生成知识地图」共用的地图流程与用时估算。
 * 地图逐章调一次 AI 再合并一次;实测 71 章 54 分钟,约 45 秒一章。估算只用来让用户决定生不生成。
 */
export const MAP_SECONDS_PER_CHAPTER = 45
/** 合并一步的大致用时(分钟) */
const MAP_MERGE_MINUTES = 2

export function estimateMapMinutes(chapterCount: number): number {
  const raw = Math.ceil((chapterCount * MAP_SECONDS_PER_CHAPTER) / 60) + MAP_MERGE_MINUTES
  return raw >= 20 ? Math.round(raw / 5) * 5 : raw
}

/** 「约 55 分钟」「约 1.5 小时」 */
export function formatEstimate(minutes: number): string {
  if (minutes < 60) return `约 ${minutes} 分钟`
  return `约 ${Math.round(minutes / 30) / 2} 小时`
}

/** 「15.4 万字」「8600 字」 */
export function formatCharCount(chapters: readonly SpineChapter[]): string {
  const chars = chapters.reduce((sum, c) => sum + c.text.length, 0)
  return chars >= 10000 ? `${(chars / 10000).toFixed(1)} 万字` : `${chars} 字`
}

/**
 * EPUB 抽取在 JS 侧(ADR-0004):解析失败是内容问题,不可重试。
 * 取源(读文件 / 取受管 EPUB 地址)放在 try 外,取源本身的错误按原样(可重试性)抛出。
 */
export async function extractChapters(
  source: () => Promise<ArrayBuffer | string>,
  onProgress: (label: string) => void,
): Promise<SpineChapter[]> {
  const data = await source()
  let book: Awaited<ReturnType<typeof openEpub>> | null = null
  try {
    book = await openEpub(data)
    return await extractSpine(book, p => onProgress(`正在抽取章节文本 ${p.done}/${p.total}:${p.title}`))
  } catch {
    throw new BackendError({ code: 'invalid_request', message: '无法解析这个 EPUB 文件', retryable: false })
  } finally {
    book?.destroy()
  }
}

/** 书摘(BL-034)入队:失败不影响导入与地图,书摘页可再点「整理」。`focus`(BL-037)只对第一次整理生效 */
export function enqueueExcerpts(bookId: number, focus?: ExcerptFocus): void {
  backend
    .excerptGenerate(bookId, false, focus)
    .catch(error => console.error('[excerpts] enqueue failed:', error instanceof Error ? error.message : String(error)))
}

/**
 * 生成知识地图:地图作业(进度文案)→ 入队整理书摘 → 回填锚点(BL-001,失败只退回整章,不阻塞)。
 * `jobId` 由调用方生成一次、重试复用(runMapJob 同 jobId 幂等)。
 */
export async function generateMap(
  bookId: number,
  jobId: string,
  epubSource: () => Promise<ArrayBuffer | string>,
  onProgress: (label: string) => void,
  excerptFocus?: ExcerptFocus,
): Promise<void> {
  onProgress('正在生成知识地图…')
  const blocks = await backend.runMapJob(bookId, jobId, p => onProgress(progressLabel(p)))
  enqueueExcerpts(bookId, excerptFocus)
  onProgress(`正在定位原文 0/${blocks.length}`)
  let book: Awaited<ReturnType<typeof openEpub>> | null = null
  try {
    book = await openEpub(await epubSource())
    const report = await anchorBlocks(book, blocks, backend, p => onProgress(`正在定位原文 ${p.done}/${p.total}`))
    if (report.failed > 0) console.error('[anchors] backfill incomplete:', report)
  } catch (error) {
    console.error('[anchors] backfill skipped:', error instanceof Error ? error.message : String(error))
  } finally {
    book?.destroy()
  }
}
