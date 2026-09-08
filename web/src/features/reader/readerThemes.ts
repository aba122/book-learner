import { EpubCFI } from 'epubjs'
import type { ReaderTypography } from './EpubView'

/** 未传排版偏好时的默认(覆盖出版方样式、行高 1.8、段首缩进) */
export const DEFAULT_TYPOGRAPHY: ReaderTypography = { lineHeight: 1.8, indent: true, overridePublisher: true }

export const HIGHLIGHT_FILL: Record<string, string> = {
  yellow: 'rgba(250, 204, 21, 0.45)',
  green: 'rgba(74, 222, 128, 0.4)',
  blue: 'rgba(96, 165, 250, 0.4)',
  pink: 'rgba(244, 114, 182, 0.4)',
}

/** 从 tokens.css 读取阅读器主题(epub 在 iframe 中渲染,需要具体值);排版规则按开关注入 */
export function readerThemes(typography: ReaderTypography) {
  const css = getComputedStyle(document.documentElement)
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback
  const fontStack = v('--font-reading', '"Songti SC", "Noto Serif CJK SC", "PingFang SC", serif')
  const theme = (bg: string, ink: string) => {
    const base: Record<string, Record<string, string>> = {
      body: { background: bg, color: ink },
      'h1, h2, h3': { color: ink },
    }
    if (!typography.overridePublisher) return base
    return {
      ...base,
      body: {
        ...base.body,
        'line-height': String(typography.lineHeight),
        'font-family': fontStack,
        'text-align': 'justify',
        'text-autospace': 'normal',
        padding: '0 8%',
      },
      p: { 'text-indent': typography.indent ? '2em' : '0', margin: '0.6em 0' },
    }
  }
  return {
    paper: theme(v('--reader-paper-bg', '#fdfaf2'), v('--reader-paper-ink', '#221c14')),
    sepia: theme(v('--reader-sepia-bg', '#f2e5c9'), v('--reader-sepia-ink', '#463922')),
    night: theme(v('--reader-night-bg', '#171512'), v('--reader-night-ink', '#cfc6b3')),
  }
}

export type SectionLike = { href: string; cfiFromRange: (range: Range) => string }
export type ViewLike = { contents?: { document?: Document } }

/** 两个点 CFI 组合为区间 CFI(块锚点存的是折叠点;annotations 只接受区间) */
export function rangeCfiFromPoints(section: SectionLike, doc: Document, cfiStart: string, cfiEnd: string): string | null {
  try {
    const start = new EpubCFI(cfiStart).toRange(doc)
    const end = new EpubCFI(cfiEnd).toRange(doc)
    if (!start || !end) return null
    const range = doc.createRange()
    range.setStart(start.startContainer, start.startOffset)
    range.setEnd(end.startContainer, end.startOffset)
    return section.cfiFromRange(range)
  } catch {
    return null
  }
}

