import type { Book } from 'epubjs'
import { spineSections, type SectionLike } from '../../epub/extract'
import type { HighlightColor, NewReaderMark, ReaderMark, WereadLocateStatus, WereadNotes } from '../../types'

/** 定位用的章节抽象:真实为 epub.js Section(`search` 跨最多 5 个文本节点做精确子串);测试注入假的 */
export interface SearchSection {
  href: string
  load: () => Promise<void>
  unload: () => void
  search: (query: string) => { cfi: string }[]
}

/** 定位落库要用到的后端子集 */
export interface LocateBackend {
  wereadLocate: (
    kind: 'mark' | 'thought', id: string, status: WereadLocateStatus, localBookId: number, mark: NewReaderMark | null, attachTo: number | null,
  ) => Promise<ReaderMark | null>
}

export interface LocateSummary { located: number; partial: number; missing: number; attached: number }

/** 还没定位的条数(划线 + 想法);书架卡片用 */
export const pendingNotes = (n: WereadNotes) => n.pendingCount + n.thoughts.filter(t => t.locateStatus === 'pending').length

/** 微信读书 colorStyle(0–4,含义未公开)→ 本地四色,按顺序循环 */
const COLORS: HighlightColor[] = ['yellow', 'green', 'blue', 'pink']
export const wereadColor = (colorStyle: number): HighlightColor => COLORS[((colorStyle % COLORS.length) + COLORS.length) % COLORS.length]

const EDGE_PUNCT = /^[\s\p{P}\p{S}]+|[\s\p{P}\p{S}]+$/gu
const PREFIX_LENGTHS = [40, 20]

/**
 * 查找候选(依次尝试):全文(空白折叠)→ 去首尾标点后的前 40 / 20 字前缀(只在比全文短时)。
 * 第一个命中即全文命中(located),之后的命中算 partial。
 */
export function candidates(text: string): string[] {
  const full = text.replace(/\s+/g, ' ').trim()
  if (!full) return []
  const core = full.replace(EDGE_PUNCT, '')
  const out = [full]
  for (const n of PREFIX_LENGTHS) {
    const prefix = [...core].slice(0, n).join('').replace(EDGE_PUNCT, '')
    if (prefix.length >= 4 && prefix.length < full.length && !out.includes(prefix)) out.push(prefix)
  }
  return out
}

interface Hit { href: string; cfi: string; partial: boolean }

/** 在一章里按候选顺序找;返回第一个命中(候选序号 > 0 即 partial) */
function findIn(section: SearchSection, text: string): Hit | null {
  const list = candidates(text)
  for (let i = 0; i < list.length; i++) {
    const matches = section.search(list[i])
    if (matches.length > 0 && matches[0].cfi) return { href: section.href, cfi: matches[0].cfi, partial: i > 0 }
  }
  return null
}

/**
 * 把待定位的划线/想法在本地 EPUB 里找出来并落库(BL-030 第二批,设计 §10):
 * 按 spine 顺序逐章加载、对每条未定位的原文做查找(先全文再前缀),找到的建成本地高亮(source=weread,幂等);
 * 想法:range 与某条划线相同 → 挂到该高亮当批注;有 abstract 但无对应划线 → 用 abstract 定位成带批注的高亮;
 * 无原文的整本/章节点评 → 不进阅读器(只记 missing,记忆库里仍有)。
 */
export async function locateWereadNotes(
  localBookId: number,
  notes: WereadNotes,
  sections: SearchSection[],
  backend: LocateBackend,
  onProgress?: (done: number, total: number) => void,
): Promise<LocateSummary> {
  const marks = notes.marks.filter(m => m.locateStatus === 'pending')
  const thoughts = notes.thoughts.filter(t => t.locateStatus === 'pending')
  const summary: LocateSummary = { located: 0, partial: 0, missing: 0, attached: 0 }
  const total = marks.length + thoughts.length
  let done = 0
  const tick = () => onProgress?.(++done, total)
  if (total === 0) return summary

  // 想法里需要自己定位的(没有同 range 划线、但有原文)
  const markKey = (chapterUid: number, range: string) => `${chapterUid}:${range}`
  const knownMarkIds = new Map<string, number>()
  for (const m of notes.marks) if (m.localMarkId !== null) knownMarkIds.set(markKey(m.chapterUid, m.range), m.localMarkId)
  const pendingMarkKeys = new Set(marks.map(m => markKey(m.chapterUid, m.range)))
  const standaloneThoughts = thoughts.filter(t => t.abstractText.trim() && !knownMarkIds.has(markKey(t.chapterUid, t.range)) && !pendingMarkKeys.has(markKey(t.chapterUid, t.range)))

  // 逐章查找(每章只加载一次)
  const markHits = new Map<string, Hit>()
  const thoughtHits = new Map<string, Hit>()
  for (const section of sections) {
    const needMarks = marks.filter(m => !markHits.has(m.bookmarkId))
    const needThoughts = standaloneThoughts.filter(t => !thoughtHits.has(t.reviewId))
    if (needMarks.length === 0 && needThoughts.length === 0) break
    try {
      await section.load()
      for (const m of needMarks) {
        const hit = findIn(section, m.markText)
        if (hit) markHits.set(m.bookmarkId, hit)
      }
      for (const t of needThoughts) {
        const hit = findIn(section, t.abstractText)
        if (hit) thoughtHits.set(t.reviewId, hit)
      }
    } finally {
      section.unload()
    }
  }

  // 划线落库
  for (const m of marks) {
    const hit = markHits.get(m.bookmarkId)
    if (hit) {
      const created = await backend.wereadLocate('mark', m.bookmarkId, hit.partial ? 'partial' : 'located', localBookId, {
        kind: 'highlight', spineHref: hit.href, cfiStart: hit.cfi, cfiEnd: hit.cfi, text: m.markText.slice(0, 400), color: wereadColor(m.colorStyle),
      }, null)
      if (created) knownMarkIds.set(markKey(m.chapterUid, m.range), created.id)
      summary[hit.partial ? 'partial' : 'located']++
    } else {
      await backend.wereadLocate('mark', m.bookmarkId, 'missing', localBookId, null, null)
      summary.missing++
    }
    tick()
  }
  // 想法落库
  for (const t of thoughts) {
    const attachTo = knownMarkIds.get(markKey(t.chapterUid, t.range))
    if (attachTo !== undefined) {
      await backend.wereadLocate('thought', t.reviewId, 'located', localBookId, null, attachTo)
      summary.attached++
    } else {
      const hit = thoughtHits.get(t.reviewId)
      if (hit) {
        await backend.wereadLocate('thought', t.reviewId, hit.partial ? 'partial' : 'located', localBookId, {
          kind: 'highlight', spineHref: hit.href, cfiStart: hit.cfi, cfiEnd: hit.cfi, text: t.abstractText.slice(0, 400), color: 'yellow', note: t.content,
        }, null)
        summary[hit.partial ? 'partial' : 'located']++
      } else {
        await backend.wereadLocate('thought', t.reviewId, 'missing', localBookId, null, null)
        summary.missing++
      }
    }
    tick()
  }
  return summary
}

/** epub.js Book → 可查找的章节列表(`search` 是 epub.js Section 的方法,typings 里没有) */
export function epubSearchSections(book: Book): SearchSection[] {
  return spineSections(book).map(section => {
    const s = section as SectionLike & { search?: (query: string) => { cfi: string }[] }
    return {
      href: s.href,
      load: async () => { await s.load(book.load.bind(book)) },
      unload: () => s.unload(),
      search: query => (typeof s.search === 'function' ? s.search(query) : []),
    }
  })
}
