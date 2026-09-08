import ePub, { type Book, type NavItem } from 'epubjs'
import type { SpineChapter } from '../types'
import { normalizeText } from './headings'

/** epub.js Section 在本模块用到的子集(typings 不完整,收敛在此) */
export interface SectionLike {
  href: string
  document: Document
  load: (request: unknown) => Promise<unknown>
  unload: () => void
  cfiFromRange: (range: Range) => string
}

/** 打开 EPUB(File.arrayBuffer() 或 URL),等待包文档解析完成;调用方负责 destroy() */
export async function openEpub(source: ArrayBuffer | string): Promise<Book> {
  const book = ePub(source as string)
  await book.ready
  return book
}

/** 顺序遍历 spine(typings 无 spineItems,只有 each) */
export function spineSections(book: Book): SectionLike[] {
  const out: SectionLike[] = []
  ;(book.spine as unknown as { each: (cb: (s: SectionLike) => void) => void }).each(s => out.push(s))
  return out
}

/** 取并加载某章 section;href 不在 spine 中 → 抛 Error */
export async function loadSection(book: Book, href: string): Promise<SectionLike> {
  const section = book.spine.get(href) as unknown as SectionLike | null
  if (!section) throw new Error(`spine section ${href} missing`)
  await section.load(book.load.bind(book))
  return section
}

const LEAF_BLOCKS = new Set(['p', 'li', 'blockquote', 'pre', 'td', 'th', 'dd', 'dt', 'figcaption', 'caption'])
const CONTAINERS = new Set(['div', 'section', 'article', 'main', 'aside', 'header', 'footer', 'nav', 'ul', 'ol', 'dl', 'table', 'tbody', 'thead', 'tr', 'figure', 'body'])

/** 章文本(保留标题层级:h1 → "# ",h2 → "## "…);段落以空行分隔 */
export function chapterMarkdownText(doc: Document): string {
  const paragraphs: string[] = []
  const visit = (el: Element) => {
    const tag = el.tagName.toLowerCase()
    const level = /^h[1-6]$/.test(tag) ? Number(tag[1]) : 0
    if (level > 0) {
      const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim()
      if (text) paragraphs.push(`${'#'.repeat(level)} ${text}`)
      return
    }
    if (CONTAINERS.has(tag) && !LEAF_BLOCKS.has(tag)) {
      for (const child of Array.from(el.children)) visit(child)
      // 容器直接持有的文本(无子元素包裹)也不丢
      const direct = Array.from(el.childNodes)
        .filter(n => n.nodeType === Node.TEXT_NODE)
        .map(n => n.textContent ?? '')
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()
      if (direct) paragraphs.push(direct)
      return
    }
    const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim()
    if (text) paragraphs.push(text)
  }
  visit(doc.body)
  return normalizeText(paragraphs.join('\n'))
}

/** 整章纯文本(不带 "# " 标记):fallback 锚点段与 harness 断言都用它 */
export function chapterPlainText(doc: Document): string {
  return normalizeText(doc.body.textContent ?? '')
}

function stripFragment(href: string): string {
  return href.split('#')[0]
}

function findTocTitle(toc: NavItem[], href: string): string | null {
  for (const item of toc) {
    const itemHref = stripFragment(item.href ?? '')
    if (itemHref === href || itemHref.endsWith(`/${href}`) || href.endsWith(`/${itemHref}`)) {
      const label = item.label?.trim()
      if (label) return label
    }
    const nested = item.subitems ? findTocTitle(item.subitems, href) : null
    if (nested) return nested
  }
  return null
}

/**
 * 有序 spine 抽取:每章 { idx, href, title, text }。title = TOC label(href 匹配)?? 首个 h1..h3 ?? href;
 * text 带标题层级标记;同一 href 重复出现只保留首个;idx 为去重后序号;每章抽取后 unload。
 */
/** 每抽取这么多章让出一次主线程(抽取依赖 epub.js 的 section.document DOM,进不了 Worker) */
export const EXTRACT_YIELD_EVERY = 6

/** 让出主线程:优先 scheduler.yield(),否则 setTimeout(0);让进度条与取消按钮有机会绘制 */
export async function yieldToMain(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler
  if (scheduler?.yield) {
    await scheduler.yield()
    return
  }
  await new Promise<void>(resolve => setTimeout(resolve, 0))
}

export interface ExtractProgress {
  /** 已完成的章数(1 起) */
  done: number
  total: number
  title: string
}

export async function extractSpine(book: Book, onProgress?: (p: ExtractProgress) => void): Promise<SpineChapter[]> {
  const nav = await book.loaded.navigation
  const toc = nav.toc ?? []
  const chapters: SpineChapter[] = []
  const seen = new Set<string>()
  const sections = spineSections(book)
  let processed = 0
  for (const section of sections) {
    const href = stripFragment(section.href)
    if (seen.has(href)) continue
    seen.add(href)
    await section.load(book.load.bind(book))
    const doc = section.document
    const heading = doc.querySelector('h1, h2, h3')?.textContent?.replace(/\s+/g, ' ').trim()
    const title = findTocTitle(toc, href) ?? (heading || href)
    chapters.push({ idx: chapters.length, href, title, text: chapterMarkdownText(doc) })
    section.unload()
    processed += 1
    onProgress?.({ done: processed, total: sections.length, title })
    if (processed % EXTRACT_YIELD_EVERY === 0) await yieldToMain()
  }
  return chapters
}
