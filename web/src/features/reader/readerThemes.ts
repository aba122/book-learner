import { EpubCFI } from 'epubjs'
import type { ReaderTypography } from './EpubView'

/** 未传排版偏好时的默认(覆盖出版方样式、行高 1.8、段首缩进) */
export const DEFAULT_TYPOGRAPHY: ReaderTypography = { lineHeight: 1.8, indent: true, overridePublisher: true }

/** 高亮四色的回退值(tokens.css 读不到时,如 jsdom);真实值来自 --hl-* 与 --hl-alpha,亮/暗各一套 */
const HL_FALLBACK: Record<string, string> = { yellow: '#f2cf5b', green: '#a3d391', blue: '#9cc0ea', pink: '#f0a9c6' }

function tokenValue(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback
}

/** 高亮填充色(epub iframe 内需要具体值):`--hl-<color>` 按 `--hl-alpha` 取半透明 */
export function highlightFill(color: string): string {
  const key = color in HL_FALLBACK ? color : 'yellow'
  const hex = tokenValue(`--hl-${key}`, HL_FALLBACK[key])
  const alpha = tokenValue('--hl-alpha', '50%')
  return `color-mix(in srgb, ${hex} ${alpha}, transparent)`
}

/** 知识块原文范围的下划线色(EpubView 注解) */
export function blockUnderlineStroke(): string {
  return tokenValue('--reader-block-underline', 'rgb(120 90 40 / 0.55)')
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

