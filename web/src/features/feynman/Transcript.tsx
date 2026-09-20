import type { ChatMessage } from '../../types'

/** 对话流一行:opener 回合(快问/附加环节开场)标记为 system,渲染为居中提示而非用户气泡 */
export type Line = ChatMessage & { system?: boolean }

export function StudentAvatar() {
  return (
    <span
      aria-hidden
      className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-new-soft font-serif text-footnote font-medium text-new"
    >
      生
    </span>
  )
}

/** 用户气泡:反白墨色(产品签名,对比 15:1) */
export const USER_BUBBLE = 'max-w-md rounded-m rounded-br-s bg-label-1 px-4 py-2.5 text-body leading-relaxed text-on-ink'
/** 学生气泡:卡面 + 细描边 */
export const STUDENT_BUBBLE = 'max-w-md rounded-m rounded-tl-s bg-card px-4 py-2.5 text-body leading-relaxed text-label-1 ring-1 ring-sep/70'

/** 已落定的回合(用户气泡 / 学生气泡 / 系统提示条);渐显中的回复与思考态由调用方另行渲染 */
export default function TranscriptLines({ lines }: { lines: Line[] }) {
  return (
    <>
      {lines.map((m, i) =>
        m.system ? (
          <div key={i} className="self-center rounded-full bg-inset px-3 py-1 text-footnote text-label-3">
            {m.text}
          </div>
        ) : m.role === 'user' ? (
          <div key={i} className="self-end">
            <div className={USER_BUBBLE}>{m.text}</div>
          </div>
        ) : (
          <div key={i} className="flex items-start gap-2.5 self-start">
            <StudentAvatar />
            <div className={STUDENT_BUBBLE}>{m.text}</div>
          </div>
        ),
      )}
    </>
  )
}
