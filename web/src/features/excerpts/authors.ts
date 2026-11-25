import type { CSSProperties } from 'react'
import type { Book, Excerpt, ExcerptBookStats, ExcerptJob } from '../../types'

/**
 * 作者归类(BL-034,设计 §6.1):`book.author` 来自 OPF,很乱——`(英)齐格蒙特·鲍曼`、
 * `西格蒙德·弗洛伊德(Sigmund Freud)`、`孙武 著`、`待识别`。归一成同一个键,注记(国别/原名)另存。
 */
export interface AuthorInfo {
  /** 归一键(空串 = 未识别作者) */
  key: string
  /** 显示名 */
  name: string
  /** 注记:国别/朝代、原名(「英」「Sigmund Freud」),用 · 连接 */
  note: string
  /** 徽记字:间隔号后最后一段的首字(鲍、弗);拉丁名取姓的首字母 */
  mono: string
  /** 作者色 1–6(0 = 未识别作者,用中性色) */
  tone: number
}

export const UNKNOWN_AUTHOR = '未识别作者'
export const AUTHOR_TONES = 6

const LEADING_NOTE = /^\s*[(（[［【〔]\s*([^)）\]］】〕]{1,8})\s*[)）\]］】〕]\s*/
const TRAILING_NOTE = /\s*[(（]\s*([^)）]{1,60})\s*[)）]\s*$/
const ROLE = /\s*(?:等\s*)?(?:原著|编著|主编|编译|撰|著|编|译|绘)\s*$/
const SEPARATOR = /\s*(?:、|，|,|;|；|\/|／|&|＆|\band\b)\s*/

/** 作者键 → 作者色(稳定哈希) */
export function toneFor(key: string): number {
  if (!key) return 0
  let h = 0
  for (const ch of key) h = (h * 31 + (ch.codePointAt(0) ?? 0)) >>> 0
  return (h % AUTHOR_TONES) + 1
}

export function authorInfo(raw: string | null | undefined): AuthorInfo {
  const unknown: AuthorInfo = { key: '', name: UNKNOWN_AUTHOR, note: '', mono: '?', tone: 0 }
  let s = (raw ?? '').trim()
  if (!s || s === '待识别' || /^unknown$/i.test(s)) return unknown
  const notes: string[] = []
  const lead = s.match(LEADING_NOTE)
  if (lead) {
    notes.push(lead[1].trim())
    s = s.slice(lead[0].length)
  }
  s = s.replace(ROLE, '')
  const trail = s.match(TRAILING_NOTE)
  if (trail && trail.index !== undefined && trail.index > 0) {
    notes.push(trail[1].trim())
    s = s.slice(0, trail.index)
  }
  s = s.replace(ROLE, '').trim()
  const first = s.split(SEPARATOR).map(x => x.trim()).find(Boolean) ?? ''
  const name = first
    .replace(/[•‧・･]/g, '·')
    .replace(/\s*·\s*/g, '·')
    .replace(/\s+/g, ' ')
    .trim()
  if (!name) return unknown
  const key = name.toLowerCase().replace(/[\s·.]/g, '')
  const lastPart = name.split('·').filter(Boolean).at(-1) ?? name
  const mono = /^[A-Za-z]/.test(lastPart)
    ? (lastPart.split(/\s+/).filter(Boolean).at(-1) ?? lastPart).charAt(0).toUpperCase()
    : [...lastPart][0] ?? '?'
  return { key, name, note: notes.join(' · '), mono, tone: toneFor(key) }
}

/** 作者色的 CSS 变量(组件里用 text-[var(--tone)] / bg-[var(--tone-soft)]) */
export function toneStyle(tone: number): CSSProperties {
  if (tone <= 0) return { '--tone': 'var(--label-3)', '--tone-soft': 'var(--surface-inset)' } as CSSProperties
  return { '--tone': `var(--author-${tone})`, '--tone-soft': `var(--author-${tone}-soft)` } as CSSProperties
}

export function isJobActive(job: ExcerptJob | null | undefined): boolean {
  return !!job && (job.stage === 'queued' || job.stage === 'reading' || job.stage === 'selecting')
}

export interface BookEntry {
  book: Book
  stats: ExcerptBookStats | null
  excerpts: Excerpt[]
}

export interface AuthorGroup extends AuthorInfo {
  books: BookEntry[]
  /** 卡片总数 */
  count: number
}

/**
 * 按作者分组:只收有卡片、有作业或有正文可整理的书;组按首本书的导入顺序排,未识别作者排最后;
 * 组内书按导入顺序,注记取第一个非空的。
 */
export function groupByAuthor(books: Book[], stats: ExcerptBookStats[], excerpts: Excerpt[]): AuthorGroup[] {
  const statsById = new Map(stats.map(s => [s.bookId, s]))
  const byBook = new Map<number, Excerpt[]>()
  for (const e of excerpts) {
    const list = byBook.get(e.bookId)
    if (list) list.push(e)
    else byBook.set(e.bookId, [e])
  }
  const groups = new Map<string, AuthorGroup>()
  for (const book of [...books].sort((a, b) => a.id - b.id)) {
    const st = statsById.get(book.id) ?? null
    const cards = byBook.get(book.id) ?? []
    if (cards.length === 0 && !st?.job && !st?.hasText) continue
    const info = authorInfo(book.author)
    let group = groups.get(info.key)
    if (!group) {
      group = { ...info, books: [], count: 0 }
      groups.set(info.key, group)
    } else if (!group.note && info.note) {
      group.note = info.note
    }
    group.books.push({ book, stats: st, excerpts: cards })
    group.count += cards.length
  }
  return [...groups.values()].sort((a, b) => Number(a.key === '') - Number(b.key === ''))
}

/** 搜索:文字、标签、章节、书名(不区分大小写) */
export function matchesQuery(e: Excerpt, bookTitle: string, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return [e.text, e.tag, e.chapterTitle, bookTitle].some(field => field.toLowerCase().includes(q))
}
