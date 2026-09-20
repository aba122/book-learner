import { useCallback, useEffect, useRef, useState } from 'react'
import { backend } from '../../backend'
import AsyncError from '../../components/AsyncError'
import Button from '../../components/Button'
import Dialog from '../../components/Dialog'
import Markdown from '../../components/Markdown'
import Spinner from '../../components/Spinner'
import Textarea from '../../components/Textarea'
import { EXTRA_KIND_FOR_BOOK, EXTRA_STAGE, OPENER_TURN_ID } from '../../config'
import { newClientId } from '../../lib/ids'
import { useAsyncResource } from '../../lib/useAsyncResource'
import { useBackendOperation } from '../../lib/useBackendOperation'
import type { Book, ExtraOutcome, KnowledgeBlock, SessionView, TurnResult } from '../../types'
import VoiceInput from './VoiceInput'
import TranscriptLines, { StudentAvatar, type Line } from './Transcript'

/** 结束请求 id 为常量:core 按 `extra:{session}:{id}` 命名空间化,重进后同 id 即重放同一整理稿 */
const FINISH_REQUEST_ID = 'extra-finish'

interface SendArgs { clientTurnId: string; text: string; expectedVersion: number }

/** 对话框外壳(视觉改版第三批:Dialog 原语,可访问名固定「附加环节」,不可关——每个阶段自带出口按钮) */
function Shell({ title, footer, children }: { title: string; footer?: React.ReactNode; children: React.ReactNode }) {
  return (
    <Dialog open title={title} label="附加环节" size="xl" dismissible={false} footer={footer}>
      <div className="flex flex-col gap-4">{children}</div>
    </Dialog>
  )
}

/**
 * 通过后附加环节(M2 T5):按书类型出迁移应用题 / 情境化方法论 / 观点讨论。
 * 只在新块判定"通过"后出现;跳过不阻塞;对话复用回合协议(前端固定 opener 先开口)。
 */
export default function ExtraStage({ block, onDone }: { block: KnowledgeBlock; onDone: () => void }) {
  const books = useAsyncResource(useCallback(() => backend.listBooks(), []))
  if (books.data === null) {
    return (
      <Shell title="通过后的附加环节" footer={<Button onClick={onDone}>跳过</Button>}>
        {books.error ? <AsyncError error={books.error} onRetry={books.reload} variant="compact" /> : <p className="text-callout text-label-3">正在读取书籍类型…</p>}
      </Shell>
    )
  }
  const book = books.data.find(b => b.id === block.bookId)
  if (!book) {
    return (
      <Shell title="通过后的附加环节" footer={<Button onClick={onDone}>返回今日</Button>}>
        <p className="text-callout text-label-3">找不到本块所属的书,附加环节暂不可用。</p>
      </Shell>
    )
  }
  return <ExtraStageBody book={book} block={block} onDone={onDone} />
}

function ExtraStageBody({ book, block, onDone }: { book: Book; block: KnowledgeBlock; onDone: () => void }) {
  const kind = EXTRA_KIND_FOR_BOOK[book.type]
  const stage = EXTRA_STAGE[kind]
  const [phase, setPhase] = useState<'offer' | 'chat' | 'done'>('offer')
  // 每次挂载生成一次;extraStart 幂等(同块同类只有一个会话),重试沿用同一 id
  const [clientRequestId] = useState(newClientId)
  const [session, setSession] = useState<SessionView | null>(null)
  const [transcript, setTranscript] = useState<Line[]>([])
  const [version, setVersion] = useState(0)
  const [readyToEnd, setReadyToEnd] = useState(false)
  const [answers, setAnswers] = useState(0)
  const [draft, setDraft] = useState('')
  /** 语音转写结果:追加到输入框(不直接发送,可编辑) */
  const appendDraft = useCallback((text: string) => setDraft(d => (d.trim() ? `${d.trimEnd()}\n${text}` : text)), [])
  const [outcome, setOutcome] = useState<ExtraOutcome | null>(null)
  const scrollAnchor = useRef<HTMLDivElement>(null)

  const lastView = useRef<SessionView | null>(null)
  /** 需要自动开场时记下会话版本(在事件里决定,effect 只负责发送,不 setState) */
  const pendingOpener = useRef<number | null>(null)
  const startOp = useBackendOperation(
    async () => {
      lastView.current = await backend.extraStart(block.id, kind, clientRequestId)
    },
    {
      onCommitted: async () => {
        const view = lastView.current
        if (!view) return
        const done = view.transcript.filter(t => t.status === 'done')
        const hasOpener = view.transcript.some(t => t.clientTurnId === OPENER_TURN_ID)
        const needsOpener = view.state === 'open' && !hasOpener
        pendingOpener.current = needsOpener ? view.version : null
        setSession(view)
        setVersion(view.version)
        setTranscript([
          ...done.map((t): Line => ({ role: t.role, text: t.text, ...(t.clientTurnId === OPENER_TURN_ID ? { system: true } : {}) })),
          ...(needsOpener ? [{ role: 'user', text: stage.opener, system: true } as Line] : []),
        ])
        setReadyToEnd(done.filter(t => t.role === 'student').at(-1)?.readyToEnd ?? false)
        setAnswers(done.filter(t => t.role === 'user' && t.clientTurnId !== OPENER_TURN_ID).length)
        setPhase('chat')
      },
    },
  )
  const starting = startOp.pending.has('start')
  const startError = startOp.errors.get('start')

  const lastReply = useRef<TurnResult | null>(null)
  const sendOp = useBackendOperation(
    async (args: SendArgs) => {
      if (!session) return
      lastReply.current = await backend.submitTurn(session.sessionId, args.expectedVersion, args.clientTurnId, args.text)
    },
    {
      onCommitted: async (_key, args: SendArgs) => {
        const reply = lastReply.current
        if (!reply) return
        setVersion(reply.version)
        setTranscript(cur => [...cur, { role: 'student', text: reply.studentText }])
        if (reply.readyToEnd) setReadyToEnd(true)
        if (args.clientTurnId !== OPENER_TURN_ID) setAnswers(n => n + 1)
      },
    },
  )
  const thinking = sendOp.pending.has('send')
  const sendError = sendOp.errors.get('send')

  const lastOutcome = useRef<ExtraOutcome | null>(null)
  const finishOp = useBackendOperation(
    async () => {
      if (!session) return
      lastOutcome.current = await backend.extraFinish(session.sessionId, version, FINISH_REQUEST_ID)
    },
    {
      onCommitted: async () => {
        if (!lastOutcome.current) return
        setOutcome(lastOutcome.current)
        setPhase('done')
      },
    },
  )
  const finishing = finishOp.pending.has('finish')
  const finishError = finishOp.errors.get('finish')

  // 开场回合:进入空会话后以固定 id 自动提交一次(重进重放);已结束的会话直接重放整理稿。
  // 提示行已在 startOp.onCommitted 里进入对话流,这里只发送,不 setState。
  const openerSent = useRef(false)
  useEffect(() => {
    if (!session || openerSent.current) return
    openerSent.current = true
    if (session.state === 'confirmed') {
      void finishOp.run('finish')
    } else if (pendingOpener.current !== null) {
      void sendOp.run('send', { clientTurnId: OPENER_TURN_ID, text: stage.opener, expectedVersion: pendingOpener.current })
    }
  }, [session, stage.opener, sendOp, finishOp])

  useEffect(() => {
    scrollAnchor.current?.scrollIntoView?.({ behavior: 'smooth', block: 'end' })
  }, [transcript, thinking])

  const inputLocked = thinking || finishing || session === null || session.state !== 'open'
  const send = () => {
    const text = draft.trim()
    if (!text || inputLocked) return
    setTranscript(cur => [...cur, { role: 'user', text }])
    setDraft('')
    sendOp.clearError('send')
    void sendOp.run('send', { clientTurnId: newClientId(), text, expectedVersion: version })
  }
  const finish = () => {
    finishOp.clearError('finish')
    void finishOp.run('finish')
  }

  if (phase === 'offer') {
    return (
      <Shell
        title={`通过了。要不要来一道${stage.title}?`}
        footer={
          <>
            <Button onClick={onDone} disabled={starting}>跳过</Button>
            <Button variant="primary" disabled={starting} onClick={() => { startOp.clearError('start'); void startOp.run('start') }}>
              {starting ? '准备中…' : '开始'}
            </Button>
          </>
        }
      >
        <p className="text-body leading-relaxed text-label-1">{stage.intro}</p>
        <p className="text-footnote text-label-3">整理稿会归档到记忆库 books/{book.slug}/{stage.archiveFile};跳过不影响本块状态与明日计划。</p>
        {startError && <AsyncError error={startError} onRetry={() => void startOp.retry('start')} variant="compact" />}
      </Shell>
    )
  }

  if (phase === 'done' && outcome) {
    return (
      <Shell title={`${stage.title} · 已归档`} footer={<Button variant="primary" onClick={onDone}>返回今日</Button>}>
        <div className="max-h-[50vh] overflow-y-auto rounded-m bg-inset px-4 py-3 text-body leading-relaxed text-label-1">
          <Markdown text={outcome.contentMd} />
        </div>
        <p className="text-footnote text-label-3">已归档到记忆库 books/{book.slug}/{stage.archiveFile}</p>
      </Shell>
    )
  }

  return (
    <Shell
      title={`${stage.title}:${block.title}`}
      footer={
        <>
          <Button onClick={onDone} disabled={finishing}>跳过</Button>
          <Button
            variant={readyToEnd ? 'primary' : 'secondary'}
            data-ready={readyToEnd ? 'true' : 'false'}
            disabled={answers === 0 || thinking || finishing}
            onClick={finish}
          >
            {finishing ? '整理中…' : '整理并归档'}
          </Button>
        </>
      }
    >
      <div className="flex max-h-[44vh] min-h-40 flex-col gap-3 overflow-y-auto">
        <TranscriptLines lines={transcript} />
        {thinking && (
          <div className="flex items-center gap-2.5 self-start text-callout text-label-3">
            <StudentAvatar />
            <Spinner size={14} />
            <span>正在思考…</span>
          </div>
        )}
        {sendError && <div className="self-start"><AsyncError error={sendError} onRetry={() => void sendOp.retry('send')} variant="compact" /></div>}
        {finishError && <AsyncError error={finishError} onRetry={finish} variant="compact" />}
        <div ref={scrollAnchor} />
      </div>
      <div className="flex items-end gap-2 border-t border-sep pt-3">
        <VoiceInput hint={block.title} disabled={inputLocked} onText={appendDraft} />
        <Textarea
          aria-label="附加环节输入"
          rows={2}
          value={draft}
          disabled={inputLocked}
          placeholder="写下你的作答 / 看法…(Cmd/Ctrl + Enter 发送)"
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              send()
            }
          }}
          className="min-h-0 flex-1 resize-none"
        />
        <Button variant="primary" disabled={!draft.trim() || inputLocked} onClick={send}>发送</Button>
      </div>
    </Shell>
  )
}
