import type { ReactNode } from 'react'
import { type Inline, parseBlocks, parseInline } from '../lib/markdownParse'

/** 轻量 Markdown 渲染(BL-015):把解析结果渲染成 React 元素,不用 dangerouslySetInnerHTML(React 自动转义)。 */

function Inlines({ parts }: { parts: Inline[] }): ReactNode {
  return (
    <>
      {parts.map((p, i) => {
        if (p.code) return <code key={i} className="rounded-s bg-inset px-1 py-0.5 font-mono text-[0.85em] text-label-1">{p.text}</code>
        if (p.href) return <a key={i} href={p.href} target="_blank" rel="noreferrer" className="text-new underline">{p.text}</a>
        if (p.bold) return <strong key={i} className="font-semibold text-label-1">{p.text}</strong>
        if (p.italic) return <em key={i}>{p.text}</em>
        return <span key={i}>{p.text}</span>
      })}
    </>
  )
}


function withBreaks(lines: string[]): ReactNode {
  return lines.map((ln, i) => (
    <span key={i}>
      {i > 0 && <br />}
      <Inlines parts={parseInline(ln)} />
    </span>
  ))
}

/** 渲染 Markdown 文本为排版后的元素;供问书 AI 回复使用 */
export default function Markdown({ text }: { text: string }): ReactNode {
  const blocks = parseBlocks(text)
  return (
    <div className="bl-md flex flex-col gap-2 leading-relaxed">
      {blocks.map((b, i) => {
        switch (b.kind) {
          case 'h':
            return (
              <p key={i} className={`font-semibold text-label-1 ${b.level === 1 ? 'text-[1.05em]' : 'text-[0.98em]'}`}>
                <Inlines parts={parseInline(b.text)} />
              </p>
            )
          case 'ul':
            return (
              <ul key={i} className="ml-4 list-disc space-y-1">
                {b.items.map((it, j) => <li key={j}><Inlines parts={parseInline(it)} /></li>)}
              </ul>
            )
          case 'ol':
            return (
              <ol key={i} className="ml-4 list-decimal space-y-1">
                {b.items.map((it, j) => <li key={j}><Inlines parts={parseInline(it)} /></li>)}
              </ol>
            )
          case 'quote':
            return (
              <blockquote key={i} className="border-l-2 border-sep pl-3 text-label-2">
                {withBreaks(b.lines)}
              </blockquote>
            )
          case 'code':
            return (
              <pre key={i} className="overflow-x-auto rounded-s bg-inset p-2 font-mono text-[0.82em] text-label-1">
                <code>{b.text}</code>
              </pre>
            )
          default:
            return <p key={i}>{withBreaks(b.lines)}</p>
        }
      })}
    </div>
  )
}
