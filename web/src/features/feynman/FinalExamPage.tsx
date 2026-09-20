import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { backend } from '../../backend'
import { BackendError } from '../../backend/errors'
import AsyncError from '../../components/AsyncError'
import Button from '../../components/Button'
import Card from '../../components/Card'
import Markdown from '../../components/Markdown'
import PageHeader from '../../components/PageHeader'
import Skeleton from '../../components/Skeleton'
import Spinner from '../../components/Spinner'
import Tag from '../../components/Tag'
import Textarea from '../../components/Textarea'
import Toolbar, { ToolbarSpacer } from '../../components/Toolbar'
import { FINAL_EXAM_MIN_ANSWERS, FINAL_EXAM_REQUEST_ID, OPENER_TEXT, OPENER_TURN_ID, SESSION_HINT } from '../../config'
import { newClientId } from '../../lib/ids'
import { StaleResult, useAsyncResource } from '../../lib/useAsyncResource'
import { useBackendOperation } from '../../lib/useBackendOperation'
import type { Book, FinalReport, SessionView, TurnResult } from '../../types'
import TranscriptLines, { StudentAvatar, type Line } from './Transcript'
import VoiceInput from './VoiceInput'

interface SendArgs { clientTurnId: string; text: string; expectedVersion: number }
interface ExamSession { book: Book; view: SessionView }

const OPENER = OPENER_TEXT.final_exam ?? '请开始终评'

/**
 * 整书终评(M3 T1):全部块通过后从地图页进入。opener 由前端固定文案先开口(同快问),
 * AI 先追问全书框架、再出跨章综合题;≥2 次作答后可"生成学习报告",报告写 artifact 并把书标为已学完。
 */
export default function FinalExamPage() {
  const { bookId: bookIdParam } = useParams()
  const bookId = Number(bookIdParam)
  const navigate = useNavigate()
  const [clientRequestId] = useState(newClientId)
  const init = useAsyncResource(useCallback(async (isCurrent: () => boolean): Promise<ExamSession> => {
    const books = await backend.listBooks()
    if (!isCurrent()) throw new StaleResult()
    const book = books.find(b => b.id === bookId)
    if (!book) throw new BackendError({ code: 'not_found', message: '这本书已不在书架上', retryable: false })
    const view = await backend.finalExamStart(bookId, clientRequestId)
    if (!isCurrent()) throw new StaleResult()
    return { book, view }
  }, [bookId, clientRequestId]))

  if (init.data === null) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <Toolbar aria-label="终评工具栏" />
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-[40rem] px-8 pt-6 pb-16">
            <PageHeader title="整书终评" subtitle="先讲全书框架,再答跨章节综合题" />
            {init.error
              ? <AsyncError error={init.error} onRetry={init.reload} />
              : <div aria-busy="true" className="rounded-l border border-sep bg-card p-4"><Skeleton lines={4} /></div>}
            <div className="mt-6 flex justify-end"><Button onClick={() => navigate('/library')}>返回书架</Button></div>
          </div>
        </div>
      </div>
    )
  }
  return <ExamRoom key={init.data.view.sessionId} session={init.data} />
}

function ExamRoom({ session }: { session: ExamSession }) {
  const navigate = useNavigate()
  const { book, view } = session
  const sessionId = view.sessionId
  const done = view.transcript.filter(t => t.status === 'done')
  const needsOpener = view.state === 'open' && !view.transcript.some(t => t.clientTurnId === OPENER_TURN_ID)
  const [transcript, setTranscript] = useState<Line[]>(() => [
    ...done.map((t): Line => ({ role: t.role, text: t.text, ...(t.clientTurnId === OPENER_TURN_ID ? { system: true } : {}) })),
    ...(needsOpener ? [{ role: 'user', text: OPENER, system: true } as Line] : []),
  ])
  const [version, setVersion] = useState(view.version)
  const [readyToEnd, setReadyToEnd] = useState(done.filter(t => t.role === 'student').at(-1)?.readyToEnd ?? false)
  const [answers, setAnswers] = useState(done.filter(t => t.role === 'user' && t.clientTurnId !== OPENER_TURN_ID).length)
  const [draft, setDraft] = useState('')
  /** 语音转写结果:追加到输入框(不直接发送,可编辑) */
  const appendDraft = useCallback((text: string) => setDraft(d => (d.trim() ? `${d.trimEnd()}\n${text}` : text)), [])
  const [report, setReport] = useState<FinalReport | null>(null)
  const scrollAnchor = useRef<HTMLDivElement>(null)

  const lastReply = useRef<TurnResult | null>(null)
  const sendOp = useBackendOperation(
    async (args: SendArgs) => {
      lastReply.current = await backend.submitTurn(sessionId, args.expectedVersion, args.clientTurnId, args.text)
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

  const lastReport = useRef<FinalReport | null>(null)
  const finishOp = useBackendOperation(
    async () => {
      lastReport.current = await backend.finalExamFinish(sessionId, version, FINAL_EXAM_REQUEST_ID)
    },
    { onCommitted: async () => { if (lastReport.current) setReport(lastReport.current) } },
  )
  const finishing = finishOp.pending.has('finish')
  const finishError = finishOp.errors.get('finish')

  // 开场只发一次;已结束的会话直接以常量 id 重放报告(effect 不 setState)
  const openerSent = useRef(false)
  useEffect(() => {
    if (openerSent.current) return
    openerSent.current = true
    if (view.state === 'confirmed') void finishOp.run('finish')
    else if (needsOpener) void sendOp.run('send', { clientTurnId: OPENER_TURN_ID, text: OPENER, expectedVersion: view.version })
  }, [view.state, view.version, needsOpener, sendOp, finishOp])

  useEffect(() => {
    scrollAnchor.current?.scrollIntoView?.({ behavior: 'smooth', block: 'end' })
  }, [transcript, thinking])

  const inputLocked = thinking || finishing || view.state !== 'open' || report !== null
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

  if (report) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <Toolbar aria-label="终评工具栏">
          <ToolbarSpacer />
          <Button size="sm" variant="primary" onClick={() => navigate('/library')}>返回书架</Button>
        </Toolbar>
        <div className="min-h-0 flex-1 overflow-y-auto @container">
          <div className="mx-auto w-full max-w-[48rem] px-8 pt-6 pb-16">
            <PageHeader
              title={`学习报告:${book.title}`}
              subtitle={`总体掌握度 ${report.overall}/5 · 最强:${report.strongestModule} · 最弱:${report.weakestModule}`}
            />
            <Card className="p-6">
              <div className="mb-4 flex items-center gap-3">
                <Tag tone="ok">已学完</Tag>
                <span data-testid="final-overall" role="img" aria-label={`${report.overall} 星`} className="text-callout tracking-wider text-review">
                  {'★'.repeat(report.overall)}<span className="text-label-4">{'☆'.repeat(Math.max(0, 5 - report.overall))}</span>
                </span>
              </div>
              <div className="font-reading text-body leading-relaxed text-label-1">
                <Markdown text={report.contentMd.split('\n').slice(1).join('\n').trim()} />
              </div>
              <p className="mt-5 border-t border-sep pt-3 text-footnote text-label-3">报告已写入学习档案,并归档到记忆库 books/{book.slug}/_report.md;本书已标记为已学完(间隔复习照常)。</p>
            </Card>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Toolbar aria-label="终评工具栏">
        <Tag tone="new" className="shrink-0">整书终评</Tag>
        <h1 className="min-w-0 flex-1 truncate font-serif text-body font-semibold text-label-1">
          终评:{book.title}
        </h1>
        <span className="hidden max-w-64 truncate text-footnote text-label-3 @xl:inline">{SESSION_HINT.final_exam}</span>
        <Button
          size="sm"
          variant={readyToEnd ? 'primary' : 'secondary'}
          data-ready={readyToEnd ? 'true' : 'false'}
          disabled={answers < FINAL_EXAM_MIN_ANSWERS || thinking || finishing}
          onClick={finish}
        >
          {finishing ? '生成报告中…' : '生成学习报告'}
        </Button>
        <Button size="sm" disabled={finishing} onClick={() => navigate(`/map/${book.id}`)}>回到地图</Button>
      </Toolbar>
      {finishError && (
        <div className="border-b border-sep bg-content px-6 py-3">
          <AsyncError error={finishError} onRetry={finish} variant="compact" />
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto flex max-w-2xl flex-col gap-4">
          <TranscriptLines lines={transcript} />
          {thinking && (
            <div className="flex items-center gap-2.5 self-start text-callout text-label-3">
              <StudentAvatar />
              <Spinner size={14} />
              <span>考官思考中…</span>
            </div>
          )}
          {sendError && <div className="self-start"><AsyncError error={sendError} onRetry={() => void sendOp.retry('send')} variant="compact" /></div>}
          <div ref={scrollAnchor} />
        </div>
      </div>
      <div className="border-t border-sep bg-content px-6 py-3">
        <div className="mx-auto flex max-w-2xl items-end gap-2">
          <VoiceInput hint={book.title} disabled={inputLocked} onText={appendDraft} />
          <Textarea
            aria-label="终评输入"
            rows={2}
            value={draft}
            disabled={inputLocked}
            placeholder="讲出全书框架 / 回答综合题…(Cmd/Ctrl + Enter 发送)"
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
      </div>
    </div>
  )
}
