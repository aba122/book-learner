import type { ChatMessage } from '../../types'

/** 对话流一行:opener 回合(快问/附加环节开场)标记为 system,渲染为居中提示而非用户气泡 */
export type Line = ChatMessage & { system?: boolean }

export function StudentAvatar() {
  return (
    <span
      aria-hidden
      className="mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-new-soft font-serif text-xs text-new"
    >
      生
    </span>
  )
}

/** 已落定的回合(用户气泡 / 学生气泡 / 系统提示条);渐显中的回复与思考态由调用方另行渲染 */
export default function TranscriptLines({ lines }: { lines: Line[] }) {
  return (
    <>
      {lines.map((m, i) =>
        m.system ? (
          <div key={i} className="self-center rounded-full bg-paper-3/60 px-3 py-1 text-xs text-ink-4">
            {m.text}
          </div>
        ) : m.role === 'user' ? (
          <div key={i} className="self-end">
            <div className="max-w-md rounded-m rounded-br-s bg-ink-1 px-4 py-2.5 text-sm leading-relaxed text-paper-2">
              {m.text}
            </div>
          </div>
        ) : (
          <div key={i} className="flex items-start gap-2.5 self-start">
            <StudentAvatar />
            <div className="max-w-md rounded-m rounded-tl-s border border-line bg-paper-2 px-4 py-2.5 text-sm leading-relaxed text-ink-1 shadow-card">
              {m.text}
            </div>
          </div>
        ),
      )}
    </>
  )
}
