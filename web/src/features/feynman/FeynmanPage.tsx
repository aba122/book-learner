import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { backend } from '../../backend'
import { BackendError } from '../../backend/errors'
import AsyncError from '../../components/AsyncError'
import Button from '../../components/Button'
import Confirm from '../../components/Confirm'
import EmptyState from '../../components/EmptyState'
import IconButton from '../../components/IconButton'
import PageHeader from '../../components/PageHeader'
import Skeleton from '../../components/Skeleton'
import Spinner from '../../components/Spinner'
import Tag from '../../components/Tag'
import Textarea from '../../components/Textarea'
import Toolbar from '../../components/Toolbar'
import { FEYNMAN_SOURCE_KEY, KIND_LABEL, OPENER_TEXT, OPENER_TURN_ID, SESSION_HINT, TYPEWRITER_CHAR_MS } from '../../config'
import { newClientId } from '../../lib/ids'
import { localCalendarDate } from '../../lib/localDate'
import { useReducedMotion } from '../../lib/motion'
import { readPref, writePref } from '../../lib/prefs'
import { StaleResult, useAsyncResource } from '../../lib/useAsyncResource'
import { useBackendOperation } from '../../lib/useBackendOperation'
import type { DailyTask, EvalResult, EvaluationView, KnowledgeBlock, SessionView, TurnResult } from '../../types'
import EvalCard from './EvalCard'
import ExtraStage from './ExtraStage'
import TranscriptLines, { STUDENT_BUBBLE, StudentAvatar, USER_BUBBLE, type Line } from './Transcript'
import VoiceInput from './VoiceInput'

/**
 * 评估/判定的请求 id 为每会话常量:core 按 `eval:{session}:{id}` / `verdict:{session}:{id}` 命名空间化,
 * 跨会话不冲突;重挂载后仍是"同 id 重试",评估中断(evaluating)也能续跑而非冲突。
 */
const EVAL_REQUEST_ID = 'eval'
const VERDICT_REQUEST_ID = 'verdict'

interface TeachingSession {
  task: DailyTask
  block: KnowledgeBlock
  source: { href: string; text: string }
  view: SessionView
}
interface SendArgs { clientTurnId: string; text: string; expectedVersion: number }
interface PendingTurn { clientTurnId: string; text: string }

const PENDING_TURN_NOTICE = () =>
  new BackendError({ code: 'io_failure', message: '上次发送未完成,学生还没有回复', retryable: true })

export default function FeynmanPage() {
  const { taskId: taskIdParam } = useParams()
  const taskId = Number(taskIdParam)
  const navigate = useNavigate()
  const [today] = useState(localCalendarDate)
  // 每次挂载生成一次;startOrResumeSession 幂等,重试初始化复用同一 id 不会产生第二个会话
  const [clientRequestId] = useState(newClientId)

  // 初始化管线:队列→块→原文→会话(resume 或新建),任一步失败均可重试;卸载/重载后不继续后续步骤
  const init = useAsyncResource(useCallback(async (isCurrent: () => boolean): Promise<TeachingSession> => {
    const queue = await backend.todayQueue(today)
    if (!isCurrent()) throw new StaleResult()
    const task = queue.find(x => x.id === taskId)
    if (!task) {
      throw new BackendError({
        code: 'not_found',
        message: '今天的队列中没有找到这项学习任务',
        retryable: false,
      })
    }
    const block = await backend.getBlock(task.blockId)
    if (!isCurrent()) throw new StaleResult()
    const source = await backend.blockSource(task.blockId)
    if (!isCurrent()) throw new StaleResult()
    const view = await backend.startOrResumeSession(task.id, clientRequestId, today)
    if (!isCurrent()) throw new StaleResult()
    return { task, block, source, view }
  }, [taskId, today, clientRequestId]))

  if (init.data === null) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <Toolbar aria-label="讲授工具栏" />
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-[40rem] px-8 pt-6 pb-16">
            <PageHeader title="准备费曼讲授" subtitle="正在读取今日任务、原文和讲授上下文,准备好后即可开始讲授。" />
            {init.error ? (
              <AsyncError error={init.error} onRetry={init.reload} />
            ) : (
              <div aria-busy="true" className="rounded-l border border-sep bg-card p-4">
                <Skeleton lines={4} />
              </div>
            )}
            <div className="mt-6 flex justify-end">
              <Button onClick={() => navigate('/')}>返回今日</Button>
            </div>
          </div>
        </div>
      </div>
    )
  }
  // 以 sessionId 为 key:服务端视图变化即重挂载并从视图水合,页面不在 effect 里 setState
  return <TeachingRoom key={init.data.view.sessionId} session={init.data} today={today} taskId={taskId} />
}

function fromView(view: SessionView) {
  const done = view.transcript.filter(t => t.status === 'done')
  const pending = view.transcript.find(t => t.role === 'user' && t.status === 'pending')
  return {
    transcript: done.map((t): Line => ({
      role: t.role,
      text: t.text,
      ...(t.clientTurnId === OPENER_TURN_ID ? { system: true } : {}),
    })),
    readyToEnd: done.filter(t => t.role === 'student').at(-1)?.readyToEnd ?? false,
    evalResult: view.state === 'evaluated' ? view.eval : null,
    pendingTurn: pending?.clientTurnId ? { clientTurnId: pending.clientTurnId, text: pending.text } : null,
  }
}

function TeachingRoom({ session, today, taskId }: { session: TeachingSession; today: string; taskId: number }) {
  const navigate = useNavigate()
  const { task, block, source, view } = session
  const sessionId = view.sessionId
  const evaluating = view.state === 'evaluating' // 上次评估中断:只允许"继续评估"或放弃

  const [hydrated] = useState(() => fromView(view))
  // 快问会话(review/retest):core 协议要求用户先开口;进入空会话时以固定 id 自动提交开场回合,
  // 开场提示行直接作为初始对话流(不在 effect 里 setState),发送由下方 effect 触发一次。
  const quiz = view.kind === 'review' || view.kind === 'retest'
  const openerText = OPENER_TEXT[view.kind]
  const needsOpener =
    quiz && openerText !== undefined && hydrated.transcript.length === 0 && hydrated.pendingTurn === null && view.state === 'open'
  const [transcript, setTranscript] = useState<Line[]>(() =>
    needsOpener && openerText !== undefined
      ? [...hydrated.transcript, { role: 'user', text: openerText, system: true }]
      : hydrated.transcript,
  )
  const [version, setVersion] = useState(view.version)
  const [readyToEnd, setReadyToEnd] = useState(hydrated.readyToEnd)
  const [evalResult, setEvalResult] = useState<EvalResult | null>(hydrated.evalResult)
  const [pendingTurn, setPendingTurn] = useState<PendingTurn | null>(hydrated.pendingTurn)
  const [draft, setDraft] = useState('')
  /** 语音转写结果:追加到输入框(不直接发送,可编辑) */
  const appendDraft = useCallback((text: string) => setDraft(d => (d.trim() ? `${d.trimEnd()}\n${text}` : text)), [])
  const [typing, setTyping] = useState<string | null>(null)
  const [typingKey, setTypingKey] = useState(0)
  const typingFull = useRef('')
  const [abandonOpen, setAbandonOpen] = useState(false)
  // 原文参考栏开/收:每台设备记住(默认开);HIG 侧栏可隐藏
  const [sourceOpen, setSourceOpenState] = useState(() => readPref(FEYNMAN_SOURCE_KEY) !== 'closed')
  const setSourceOpen = (open: boolean) => {
    setSourceOpenState(open)
    writePref(FEYNMAN_SOURCE_KEY, open ? 'open' : 'closed')
  }
  const reducedMotion = useReducedMotion()
  const scrollAnchor = useRef<HTMLDivElement>(null)

  // 发送:id 在触发时生成一次进入 args,重试(hook 复用 lastArgs)即同 id、同旧版本 → 服务端重放/续跑
  const lastReply = useRef<TurnResult | null>(null)
  const sendOp = useBackendOperation(
    async (args: SendArgs) => {
      lastReply.current = await backend.submitTurn(sessionId, args.expectedVersion, args.clientTurnId, args.text)
    },
    {
      onCommitted: async () => {
        const reply = lastReply.current
        if (!reply) return
        setVersion(reply.version)
        typingFull.current = reply.studentText
        // 减弱动态:不打字机,首拍直接出全文(下方"渐显完成"effect 会把它落入对话流)
        setTyping(reducedMotion ? reply.studentText : '')
        setTypingKey(k => k + 1)
        if (reply.readyToEnd) setReadyToEnd(true)
      },
    },
  )
  const thinking = sendOp.pending.has('send')
  const sendError = sendOp.errors.get('send')

  // 结束讲授 / 继续评估:同会话常量 id,失败留在对话页可重试
  const lastEval = useRef<EvaluationView | null>(null)
  const endOp = useBackendOperation(
    async () => {
      lastEval.current = await backend.requestEvaluation(sessionId, EVAL_REQUEST_ID)
    },
    {
      onCommitted: async () => {
        const result = lastEval.current
        if (!result) return
        setEvalResult(result.eval)
        setVersion(result.version)
      },
    },
  )
  const ending = endOp.pending.has('end')
  const endError = endOp.errors.get('end')

  // 确认判定:单次原子操作(会话/块/薄弱点/复习/任务/投影都在 core 一个事务里),不再有 completeTask 第二步;
  // 新块判定"通过"后先给附加环节(M2 T5),其余情况直接回今日
  const [extraOffer, setExtraOffer] = useState(false)
  const confirmOp = useBackendOperation(
    async (pass: boolean) => {
      await backend.confirmSessionVerdict(sessionId, version, VERDICT_REQUEST_ID, pass, today)
    },
    {
      onCommitted: async (_key, pass: boolean) => {
        if (pass && task.kind === 'new') setExtraOffer(true)
        else navigate('/')
      },
    },
  )
  const confirming = confirmOp.pending.has('confirm')
  const confirmError = confirmOp.errors.get('confirm')

  // 放弃:显式状态迁移(用水合/最新版本),失败留在页面
  const abandonOp = useBackendOperation(
    async () => {
      await backend.abandonSession(sessionId, version)
    },
    { onCommitted: async () => navigate('/') },
  )
  const abandoning = abandonOp.pending.has('abandon')
  const abandonError = abandonOp.errors.get('abandon')
  const anyPending = thinking || ending || confirming || abandoning

  // 打字机:interval 单独按轮次启动,批量推进也能整段渐显
  useEffect(() => {
    if (typingKey === 0) return
    const id = setInterval(() => {
      setTyping(cur => {
        if (cur === null || cur.length >= typingFull.current.length) return cur
        return typingFull.current.slice(0, cur.length + 1)
      })
    }, TYPEWRITER_CHAR_MS)
    return () => clearInterval(id)
  }, [typingKey])

  // 渐显完成 → 落入对话流
  useEffect(() => {
    if (typing !== null && typingFull.current && typing.length >= typingFull.current.length) {
      setTranscript(cur => [...cur, { role: 'student', text: typingFull.current }])
      setTyping(null)
    }
  }, [typing])

  useEffect(() => {
    scrollAnchor.current?.scrollIntoView?.({ behavior: 'smooth', block: 'end' })
  }, [transcript, typing, thinking])

  const busy = thinking || typing !== null
  const inputLocked = busy || evaluating || pendingTurn !== null || evalResult !== null

  // 开场回合只在本次挂载发送一次;重试/重放由 hook 与服务端幂等 id 保证
  const openerSent = useRef(false)
  useEffect(() => {
    if (!needsOpener || openerText === undefined || openerSent.current) return
    openerSent.current = true
    void sendOp.run('send', { clientTurnId: OPENER_TURN_ID, text: openerText, expectedVersion: view.version })
  }, [needsOpener, openerText, view.version, sendOp])

  const send = () => {
    const text = draft.trim()
    if (!text || inputLocked) return
    setTranscript(cur => [...cur, { role: 'user', text }])
    setDraft('')
    sendOp.clearError('send')
    void sendOp.run('send', { clientTurnId: newClientId(), text, expectedVersion: version })
  }

  // 水合出的 pending 回合:原 id + 水合版本续跑;先落入对话流,失败后与普通发送失败同样可重试
  const retryPending = () => {
    if (!pendingTurn || busy) return
    const { clientTurnId, text } = pendingTurn
    setPendingTurn(null)
    setTranscript(cur => [...cur, { role: 'user', text, ...(clientTurnId === OPENER_TURN_ID ? { system: true } : {}) }])
    sendOp.clearError('send')
    void sendOp.run('send', { clientTurnId, text, expectedVersion: version })
  }

  const endTeaching = () => {
    endOp.clearError('end')
    void endOp.run('end')
  }

  const decide = (pass: boolean) => {
    confirmOp.clearError('confirm')
    void confirmOp.run('confirm', pass)
  }

  const abandon = () => {
    setAbandonOpen(false)
    abandonOp.clearError('abandon')
    void abandonOp.run('abandon')
  }

  const endLabel = evaluating ? (ending ? '评估中…' : '继续评估') : ending ? '评估中…' : '结束讲授'

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Toolbar aria-label="讲授工具栏">
        <IconButton icon="sidebar-left" label="原文参考" active={sourceOpen} onClick={() => setSourceOpen(!sourceOpen)} className="-ml-1" />
        <Tag tone={task.kind === 'new' ? 'new' : 'weak'} className="ml-1 shrink-0">{KIND_LABEL[task.kind]}</Tag>
        <h1 className="min-w-0 flex-1 truncate font-serif text-body font-semibold text-label-1">
          {quiz ? '复习' : '讲授'}:{block.title}
        </h1>
        {SESSION_HINT[view.kind] && (
          <span className="hidden max-w-64 truncate text-footnote text-label-3 @xl:inline">{SESSION_HINT[view.kind]}</span>
        )}
        <Button size="sm" onClick={() => navigate(`/reader/${block.id}?back=${taskId}`)}>
          回读原文
        </Button>
        <Button
          size="sm"
          variant={readyToEnd || evaluating ? 'primary' : 'secondary'}
          data-ready={readyToEnd ? 'true' : 'false'}
          disabled={ending || pendingTurn !== null}
          onClick={endTeaching}
        >
          {endLabel}
        </Button>
        <Button size="sm" disabled={anyPending} onClick={() => setAbandonOpen(true)}>
          放弃本次
        </Button>
      </Toolbar>

      {(endError || abandonError) && (
        <div className="flex flex-col gap-2 border-b border-sep bg-content px-6 py-3">
          {endError && <AsyncError error={endError} onRetry={() => void endOp.retry('end')} variant="compact" />}
          {abandonError && (
            <AsyncError error={abandonError} onRetry={() => void abandonOp.retry('abandon')} variant="compact" />
          )}
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {/* 左:可隐藏的原文参考栏 */}
        {sourceOpen && (
          <aside aria-label="原文参考" className="flex w-72 shrink-0 flex-col border-r border-sep bg-inset/50">
            <h2 className="px-4 pt-4 pb-2 text-footnote font-medium text-label-3">原文参考</h2>
            <p className="min-h-0 flex-1 overflow-y-auto px-4 font-reading text-body leading-loose text-label-1">{source.text}</p>
            <p className="border-t border-sep px-4 py-3 text-footnote leading-relaxed text-label-3">
              尽量先不看参考;卡住了再瞄一眼,讲完记得把它收起来。
            </p>
          </aside>
        )}

        {/* 中:对话 */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
            <div className="mx-auto flex max-w-2xl flex-col gap-4">
              {transcript.length === 0 && pendingTurn === null && typing === null && !thinking && (
                <EmptyState
                  compact
                  emoji="🪑"
                  title="你的学生已经坐好了。"
                  body={`用自己的话,把「${block.title}」讲给 TA 听——讲不清的地方,就是要回补的漏洞。`}
                  className="py-8"
                />
              )}
              <TranscriptLines lines={transcript} />
              {pendingTurn && (
                <div className="flex flex-col items-end gap-2 self-end">
                  <div className={`${USER_BUBBLE} opacity-80`}>{pendingTurn.text}</div>
                  <AsyncError error={PENDING_TURN_NOTICE()} onRetry={retryPending} variant="compact" />
                </div>
              )}
              {thinking && (
                <div className="flex items-center gap-2.5 self-start text-callout text-label-3">
                  <StudentAvatar />
                  <Spinner size={14} />
                  <span>学生思考中…</span>
                </div>
              )}
              {typing !== null && !thinking && (
                <div className="flex items-start gap-2.5 self-start">
                  <StudentAvatar />
                  <div className={STUDENT_BUBBLE}>
                    {typing}
                    <span className="animate-pulse text-label-3">▍</span>
                  </div>
                </div>
              )}
              {sendError && (
                <div className="self-start">
                  <AsyncError error={sendError} onRetry={() => void sendOp.retry('send')} variant="compact" />
                </div>
              )}
              <div ref={scrollAnchor} />
            </div>
          </div>

          <div className="border-t border-sep bg-content px-6 py-3">
            <div className="mx-auto flex max-w-2xl items-end gap-2">
              <VoiceInput hint={block.title} disabled={inputLocked} onText={appendDraft} />
              <Textarea
                aria-label="复述输入"
                rows={2}
                value={draft}
                disabled={inputLocked}
                placeholder={
                  evaluating
                    ? '上次评估被中断,请点"继续评估"'
                    : pendingTurn
                      ? '上一条还没送达,先重试发送'
                      : '用自己的话讲给学生听…(Cmd/Ctrl + Enter 发送)'
                }
                onChange={e => setDraft(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault()
                    send()
                  }
                }}
                className="min-h-0 flex-1 resize-none"
              />
              <Button variant="primary" disabled={!draft.trim() || inputLocked} onClick={send}>
                发送
              </Button>
            </div>
          </div>
        </div>
      </div>

      {extraOffer && <ExtraStage block={block} onDone={() => navigate('/')} />}
      {evalResult && !extraOffer && (
        <EvalCard
          result={evalResult}
          onConfirm={decide}
          error={confirmError ?? null}
          onRetry={() => void confirmOp.retry('confirm')}
          busy={confirming}
          confirmDisabled={confirmError?.retryable === false}
        />
      )}
      <Confirm
        open={abandonOpen}
        title="放弃这次讲授?"
        message="本次对话不会计入评估,知识块状态保持不变。"
        confirmText="放弃"
        cancelText="继续讲"
        danger
        onConfirm={abandon}
        onCancel={() => setAbandonOpen(false)}
      />
    </div>
  )
}
