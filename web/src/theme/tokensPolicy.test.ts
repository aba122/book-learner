import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 令牌政策棘轮(视觉改版第一批):
 * label-4(别名 ink-4,#b6ab95 on #f6f1e6 ≈ 2.0:1)只准装饰,不准出现在可点元素上。
 * 基线 17 处(2026-09-20);第二批后剩 2(费曼页,第三批收 0)。只许往下压,不许往上加。
 */
const MAX_INTERACTIVE_LABEL4_LINES = 2

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (p.endsWith('.tsx') && !p.endsWith('.test.tsx')) out.push(p)
  }
  return out
}

describe('令牌政策', () => {
  it('可点元素不用 label-4/ink-4 文字色(棘轮)', () => {
    const src = join(__dirname, '..')
    const hits: string[] = []
    for (const file of walk(src)) {
      readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        if (line.includes('cursor-pointer') && /text-(ink|label)-4\b/.test(line)) hits.push(`${file.slice(src.length + 1)}:${i + 1}`)
      })
    }
    expect(hits.length, `label-4 用在可点元素上的行:\n${hits.join('\n')}`).toBeLessThanOrEqual(MAX_INTERACTIVE_LABEL4_LINES)
  })

  it('组件不硬编码 Tailwind 调色板色(规则 3)', () => {
    const src = join(__dirname, '..')
    const hits: string[] = []
    const palette = /\b(bg|text|border|stroke|fill|ring)-(red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone|white|black)(-\d{2,3})?\b/
    for (const file of walk(src)) {
      readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        if (palette.test(line)) hits.push(`${file.slice(src.length + 1)}:${i + 1}`)
      })
    }
    expect(hits, '硬编码调色板色').toEqual([])
  })
})
