/** 轻量 Markdown 解析(BL-015):纯函数,供 markdown.tsx 渲染与单测使用。不含 JSX。 */
export type Inline = { text: string; bold?: boolean; italic?: boolean; code?: boolean; href?: string }

const TOKEN = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\)|(?:\*|_)[^*_]+(?:\*|_))/g

/** 把一行文本切成行内片段(粗/斜/码/链接) */
export function parseInline(line: string): Inline[] {
  const out: Inline[] = []
  let last = 0
  for (const m of line.matchAll(TOKEN)) {
    const idx = m.index ?? 0
    if (idx > last) out.push({ text: line.slice(last, idx) })
    const tok = m[0]
    if (tok.startsWith('**')) out.push({ text: tok.slice(2, -2), bold: true })
    else if (tok.startsWith('`')) out.push({ text: tok.slice(1, -1), code: true })
    else if (tok.startsWith('[')) {
      const cut = tok.indexOf('](')
      out.push({ text: tok.slice(1, cut), href: tok.slice(cut + 2, -1) })
    } else out.push({ text: tok.slice(1, -1), italic: true })
    last = idx + tok.length
  }
  if (last < line.length) out.push({ text: line.slice(last) })
  return out
}

export type Block =
  | { kind: 'h'; level: number; text: string }
  | { kind: 'p'; lines: string[] }
  | { kind: 'ul'; items: string[] }
  | { kind: 'ol'; items: string[] }
  | { kind: 'quote'; lines: string[] }
  | { kind: 'code'; text: string }

/** 行 → 块 */
export function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n')
  const blocks: Block[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (line.trim() === '') { i++; continue }
    if (line.trim().startsWith('```')) {
      const body: string[] = []
      i++
      while (i < lines.length && !lines[i].trim().startsWith('```')) { body.push(lines[i]); i++ }
      i++
      blocks.push({ kind: 'code', text: body.join('\n') })
      continue
    }
    const h = /^(#{1,3})\s+(.*)$/.exec(line)
    if (h) { blocks.push({ kind: 'h', level: h[1].length, text: h[2].trim() }); i++; continue }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*[-*]\s+/, '')); i++ }
      blocks.push({ kind: 'ul', items })
      continue
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*\d+\.\s+/, '')); i++ }
      blocks.push({ kind: 'ol', items })
      continue
    }
    if (/^\s*>\s?/.test(line)) {
      const body: string[] = []
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) { body.push(lines[i].replace(/^\s*>\s?/, '')); i++ }
      blocks.push({ kind: 'quote', lines: body })
      continue
    }
    const para: string[] = []
    while (
      i < lines.length && lines[i].trim() !== '' &&
      !/^(#{1,3})\s+/.test(lines[i]) && !/^\s*[-*]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i]) && !/^\s*>\s?/.test(lines[i]) && !lines[i].trim().startsWith('```')
    ) { para.push(lines[i]); i++ }
    blocks.push({ kind: 'p', lines: para })
  }
  return blocks
}
