import { EpubCFI, type Book } from 'epubjs'
import type { AnchorSegment } from '../types'
import { chapterPlainText, loadSection, type SectionLike } from './extract'
import { normalizeText, pickHeading, segmentEnd, type HeadingCandidate } from './headings'

export interface AnchorHint {
  spineHref: string
  /** 原文小节标题(core 从 source_section "{href}#{小节标题}" 拆出);空串 → 整章 */
  hint: string
}

const HEADING_SELECTOR = 'h1, h2, h3, h4, h5, h6'

interface HeadingElement {
  el: Element
  cand: HeadingCandidate
}

function headingElements(doc: Document): HeadingElement[] {
  return Array.from(doc.querySelectorAll(HEADING_SELECTOR)).map((el, index) => ({
    el,
    cand: { index, level: Number(el.tagName.slice(1)) || 6, text: el.textContent ?? '' },
  }))
}

/** 子树中首个/末个非空文本节点(没有则任意文本节点,再没有 → null) */
function edgeTextNode(doc: Document, root: Node, last: boolean): Text | null {
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let fallback: Text | null = null
  let found: Text | null = null
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text
    fallback ??= text
    if ((text.textContent ?? '').trim()) {
      found = text
      if (!last) break
    }
  }
  return found ?? fallback
}

/** 折叠在 (node, offset) 的点 CFI(不是 epub.js 的区间 CFI) */
function pointCfi(section: SectionLike, doc: Document, node: Node, offset: number): string {
  const range = doc.createRange()
  range.setStart(node, offset)
  range.collapse(true)
  return section.cfiFromRange(range)
}

interface Point { node: Node; offset: number }

function segmentFor(section: SectionLike, doc: Document, start: Point, end: Point, hint: string, precision: AnchorSegment['precision'], text?: string): AnchorSegment {
  const range = doc.createRange()
  range.setStart(start.node, start.offset)
  range.setEnd(end.node, end.offset)
  return {
    spineHref: section.href,
    cfiStart: pointCfi(section, doc, start.node, start.offset),
    cfiEnd: pointCfi(section, doc, end.node, end.offset),
    precision,
    hint,
    text: text ?? normalizeText(range.toString()),
  }
}

function chapterEnd(doc: Document): Point {
  const lastText = edgeTextNode(doc, doc.body, true)
  return lastText
    ? { node: lastText, offset: lastText.textContent?.length ?? 0 }
    : { node: doc.body, offset: doc.body.childNodes.length }
}

function chapterStart(doc: Document): Point {
  const firstText = edgeTextNode(doc, doc.body, false)
  return firstText ? { node: firstText, offset: 0 } : { node: doc.body, offset: 0 }
}

/**
 * 小节标题 → 有序多段锚点(TECH_DESIGN §7.2):命中标题则 [标题起, 下一同级/更高级标题起) 为 exact 段;
 * hint 为空或未命中 → 整章 chapter_fallback(文本 = chapterPlainText)。同一调用内同章同 hint 多次按出现顺序消费。
 * href 不在 spine → 抛 Error(调用方决定如何回退)。
 */
export async function resolveBlockAnchors(book: Book, hints: AnchorHint[]): Promise<AnchorSegment[]> {
  const used = new Map<string, Set<number>>()
  const out: AnchorSegment[] = []
  for (const { spineHref, hint } of hints) {
    const section = await loadSection(book, spineHref)
    const doc = section.document
    const heads = headingElements(doc)
    const usedSet = used.get(spineHref) ?? new Set<number>()
    used.set(spineHref, usedSet)
    const picked = pickHeading(hint, heads.map(h => h.cand), usedSet)
    if (!picked) {
      out.push(segmentFor(section, doc, chapterStart(doc), chapterEnd(doc), hint, 'chapter_fallback', chapterPlainText(doc)))
      continue
    }
    usedSet.add(picked.index)
    const startEl = heads[picked.index].el
    const startText = edgeTextNode(doc, startEl, false)
    const start: Point = startText ? { node: startText, offset: 0 } : { node: startEl, offset: 0 }
    const endCand = segmentEnd(picked, heads.map(h => h.cand))
    let end: Point
    if (endCand) {
      const endEl = heads[endCand.index].el
      const endText = edgeTextNode(doc, endEl, false)
      end = endText ? { node: endText, offset: 0 } : { node: endEl, offset: 0 }
    } else {
      end = chapterEnd(doc)
    }
    out.push(segmentFor(section, doc, start, end, hint, 'exact'))
  }
  return out
}

/**
 * 往返还原:两个点 CFI 各自 toRange 得到折叠 Range,组合为一个 Range 后取归一化文本。
 * (book.getRange 只接受单个区间 CFI,不能直接用。)
 */
export async function restoreSegmentText(book: Book, seg: AnchorSegment): Promise<string> {
  const section = await loadSection(book, seg.spineHref)
  const doc = section.document
  const start = new EpubCFI(seg.cfiStart).toRange(doc)
  const end = new EpubCFI(seg.cfiEnd).toRange(doc)
  if (!start || !end) throw new Error('CFI does not resolve in this chapter')
  const range = doc.createRange()
  range.setStart(start.startContainer, start.startOffset)
  range.setEnd(end.startContainer, end.startOffset)
  return normalizeText(range.toString())
}
