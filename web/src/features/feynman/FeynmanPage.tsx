import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { backend } from '../../backend'
import { BackendError } from '../../backend/errors'
import AsyncError from '../../components/AsyncError'
import Button from '../../components/Button'
import Card from '../../components/Card'
import Confirm from '../../components/Confirm'
import Tag from '../../components/Tag'
import { KIND_LABEL, TYPEWRITER_CHAR_MS } from '../../config'
import { newClientId } from '../../lib/ids'
import { localCalendarDate } from '../../lib/localDate'
import { StaleResult, useAsyncResource } from '../../lib/useAsyncResource'
import { useBackendOperation } from '../../lib/useBackendOperation'
import type { ChatMessage, DailyTask, EvalResult, EvaluationView, KnowledgeBlock, SessionView, TurnResult } from '../../types'
import EvalCard from './EvalCard'

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
      <div className="flex h-full items-center justify-center px-8 py-12">
        <Card className="w-full max-w-xl p-8">
          <h1 className="font-serif text-xl font-semibold text-ink-1">准备费曼讲授</h1>
          <p className="mt-2 text-sm leading-relaxed text-ink-3">
            正在读取今日任务、原文和讲授上下文。会话就绪后才会开放输入。
          </p>
          <div className="mt-6">
            {init.error ? (
              <AsyncError error={init.error} onRetry={init.reload} />
            ) : (
              <p className="text-sm text-ink-3">正在准备讲授…</p>
            )}
          </div>
          <div className="mt-6 flex justify-end">
            <Button onClick={() => navigate('/')}>返回今日</Button>
          </div>
        </Card>
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
    transcript: done.map((t): ChatMessage => ({ role: t.role, text: t.text })),
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
  const [transcript, setTranscript] = useState<ChatMessage[]>(hydrated.transcript)
  const [version, setVersion] = useState(view.version)
  const [readyToEnd, setReadyToEnd] = useState(hydrated.readyToEnd)
  const [evalResult, setEvalResult] = useState<EvalResult | null>(hydrated.evalResult)
  const [pendingTurn, setPendingTurn] = useState<PendingTurn | null>(hydrated.pendingTurn)
  const [draft, setDraft] = useState('')
  const [typing, setTyping] = useState<string | null>(null)
  const [typingKey, setTypingKey] = useState(0)
  const typingFull = useRef('')
  const [abandonOpen, setAbandonOpen] = useState(false)
  const [sourceOpen, setSourceOpen] = useState(true)
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
        setTyping('')
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

  // 确认判定:单次原子操作(会话/块/薄弱点/复习/任务/投影都在 core 一个事务里),不再有 completeTask 第二步
  const confirmOp = useBackendOperation(
    async (pass: boolean) => {
      await backend.confirmSessionVerdict(sessionId, version, VERDICT_REQUEST_ID, pass, today)
    },
    { onCommitted: async () => navigate('/') },
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
    setTranscript(cur => [...cur, { role: 'user', text }])
    sendOp.clearError('send')
    void sendOp.run('send', { clientTurnId, text, expectedVersion: version })
  }

  const endTeaching = () => {
    endOp.clearError('end')
    void endOp.run('end')
  }

  const confirmVerdict = (pass: boolean) => {
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
    <div className="flex h-full">
      {/* 左:可折叠原文参考 */}
      {sourceOpen ? (
        <aside className="flex w-72 shrink-0 flex-col border-r border-line bg-paper-2/60 p-5">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-xs font-medium tracking-wide text-ink-3">原文参考</h2>
            <button
              className="cursor-pointer text-xs text-ink-4 hover:text-ink-1"
              onClick={() => setSourceOpen(false)}
            >
              ‹ 收起
            </button>
          </div>
          <p className="overflow-y-auto text-sm leading-loose text-ink-2">{source.text}</p>
          <p className="mt-4 border-t border-line pt-3 text-xs leading-relaxed text-ink-4">
            尽量先不看参考;卡住了再瞄一眼,讲完记得把它折起来。
          </p>
        </aside>
      ) : (
        <button
          className="shrink-0 cursor-pointer border-r border-line bg-paper-2/60 px-1.5 text-xs text-ink-3 hover:text-ink-1"
          onClick={() => setSourceOpen(true)}
        >
          原文
        </button>
      )}

      {/* 中:对话 */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-line bg-paper-2/70 px-6 py-3">
          <Tag tone={task.kind === 'new' ? 'new' : 'weak'}>{KIND_LABEL[task.kind]}</Tag>
          <h1 className="min-w-0 flex-1 truncate font-serif text-base font-semibold text-ink-1">
            讲授:{block.title}
          </h1>
          <Button
            className="px-3 py-1.5 text-xs"
            onClick={() => navigate(`/reader/${block.id}?back=${taskId}`)}
          >
            回读原文
          </Button>
          <Button
            variant={readyToEnd || evaluating ? 'primary' : 'ghost'}
            data-ready={readyToEnd ? 'true' : 'false'}
            className="px-3 py-1.5 text-xs"
            disabled={ending || pendingTurn !== null}
            onClick={endTeaching}
          >
            {endLabel}
          </Button>
          <Button
            className="px-3 py-1.5 text-xs"
            disabled={anyPending}
            onClick={() => setAbandonOpen(true)}
          >
            放弃本次
          </Button>
        </header>

        {(endError || abandonError) && (
          <div className="flex flex-col gap-2 border-b border-line bg-paper-2/70 px-6 py-3">
            {endError && <AsyncError error={endError} onRetry={() => void endOp.retry('end')} variant="compact" />}
            {abandonError && (
              <AsyncError error={abandonError} onRetry={() => void abandonOp.retry('abandon')} variant="compact" />
            )}
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
          <div className="mx-auto flex max-w-2xl flex-col gap-4">
            {transcript.length === 0 && pendingTurn === null && typing === null && !thinking && (
              <div className="rounded-m bg-paper-3/50 px-5 py-4 text-sm leading-relaxed text-ink-3">
                你的学生已经坐好了。用自己的话,把「{block.title}
                」讲给 TA 听——讲不清的地方,就是要回补的漏洞。
              </div>
            )}
            {transcript.map((m, i) =>
              m.role === 'user' ? (
                <div key={i} className="self-end">
                  <div className="max-w-md rounded-m rounded-br-s bg-ink-1 px-4 py-2.5 text-sm leading-relaxed text-paper-2">
                    {m.text}
                  </div>
                </div>
              ) : (
                <div key={i} className="flex items-start gap-2.5 self-start">
                  <span
                    aria-hidden
                    className="mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-new-soft font-serif text-xs text-new"
                  >
                    生
                  </span>
                  <div className="max-w-md rounded-m rounded-tl-s border border-line bg-paper-2 px-4 py-2.5 text-sm leading-relaxed text-ink-1 shadow-card">
                    {m.text}
                  </div>
                </div>
              ),
            )}
            {pendingTurn && (
              <div className="flex flex-col items-end gap-2 self-end">
                <div className="max-w-md rounded-m rounded-br-s bg-ink-1 px-4 py-2.5 text-sm leading-relaxed text-paper-2 opacity-80">
                  {pendingTurn.text}
                </div>
                <AsyncError error={PENDING_TURN_NOTICE()} onRetry={retryPending} variant="compact" />
              </div>
            )}
            {thinking && (
              <div className="flex items-center gap-2.5 self-start text-sm text-ink-3">
                <span
                  aria-hidden
                  className="flex h-7 w-7 items-center justify-center rounded-full bg-new-soft font-serif text-xs text-new"
                >
                  生
                </span>
                学生思考中<span className="animate-pulse">…</span>
              </div>
            )}
            {typing !== null && !thinking && (
              <div className="flex items-start gap-2.5 self-start">
                <span
                  aria-hidden
                  className="mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-new-soft font-serif text-xs text-new"
                >
                  生
                </span>
                <div className="max-w-md rounded-m rounded-tl-s border border-line bg-paper-2 px-4 py-2.5 text-sm leading-relaxed text-ink-1 shadow-card">
                  {typing}
                  <span className="animate-pulse text-ink-4">▍</span>
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

        <div className="border-t border-line bg-paper-2/70 px-6 py-4">
          <div className="mx-auto flex max-w-2xl items-end gap-3">
            <button
              disabled
              title="语音输入 Mac 版可用"
              className="cursor-not-allowed rounded-m border border-line px-3 py-2 text-sm text-ink-4 opacity-60"
            >
              🎙
            </button>
            <textarea
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
              className="min-h-0 flex-1 resize-none rounded-m border border-line bg-paper-1 px-4 py-2.5 text-sm leading-relaxed text-ink-1 placeholder:text-ink-4 disabled:opacity-60"
            />
            <Button variant="primary" disabled={!draft.trim() || inputLocked} onClick={send}>
              发送
            </Button>
          </div>
        </div>
      </div>

      {evalResult && (
        <EvalCard
          result={evalResult}
          onConfirm={confirmVerdict}
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
