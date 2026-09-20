import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { captureMicrophone, type CaptureFn, type Recorder } from '../../audio/pcm'
import { backend } from '../../backend'
import Button from '../../components/Button'
import Icon from '../../components/icons/Icon'
import IconButton from '../../components/IconButton'
import Spinner from '../../components/Spinner'
import { VOICE_MAX_SECONDS } from '../../config'
import { describeVoiceError, storedVoiceDevice } from './voiceSupport'

type Phase = 'idle' | 'recording' | 'transcribing'

const formatClock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`

/**
 * 语音输入(M3 T3):点击开始 → 录音(电平/计时,≤ 120 s 自动停止)→ 点击停止 → 本机 whisper 转写 →
 * 结果经 onText 填入输入框(可编辑,不直接发送)。`hint` 作为 whisper initial prompt(当前块标题)。
 */
export default function VoiceInput({
  hint,
  disabled = false,
  onText,
  capture = captureMicrophone,
  lang = 'zh',
}: {
  hint: string
  disabled?: boolean
  onText: (text: string) => void
  /** 测试注入的采集函数 */
  capture?: CaptureFn
  lang?: string
}) {
  const [phase, setPhase] = useState<Phase>('idle')
  const [error, setError] = useState<string | null>(null)
  const [level, setLevel] = useState(0)
  const [elapsed, setElapsed] = useState(0)
  const [notice, setNotice] = useState<string | null>(null)
  const recorderRef = useRef<Recorder | null>(null)
  const mounted = useRef(true)
  const stopRef = useRef<() => void>(() => {})
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      recorderRef.current?.cancel()
      recorderRef.current = null
    }
  }, [])

  useEffect(() => {
    if (phase !== 'recording') return
    const started = Date.now()
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 250)
    return () => clearInterval(timer)
  }, [phase])

  const finish = useCallback(async () => {
    const recorder = recorderRef.current
    if (!recorder) return
    recorderRef.current = null
    setPhase('transcribing')
    try {
      const pcm = await recorder.stop()
      const transcript = await backend.voiceTranscribe(pcm, lang, hint)
      if (!mounted.current) return
      if (transcript.text.trim()) {
        onText(transcript.text.trim())
        setNotice(`已填入,可编辑后发送(${transcript.seconds.toFixed(1)} 秒语音,转写用时 ${transcript.elapsed.toFixed(1)} 秒)`)
      } else {
        setNotice('没有识别出内容,请靠近麦克风再试。')
      }
    } catch (cause) {
      if (mounted.current) setError(describeVoiceError(cause))
    } finally {
      if (mounted.current) setPhase('idle')
    }
  }, [hint, lang, onText])
  // 自动停止回调经 ref 拿到最新的 finish;在提交阶段同步,不在渲染期写 ref(react/refs)
  useLayoutEffect(() => {
    stopRef.current = () => void finish()
  })

  const start = useCallback(async () => {
    setError(null)
    setNotice(null)
    setLevel(0)
    setElapsed(0)
    try {
      const recorder = await capture({
        deviceId: storedVoiceDevice(),
        onLevel: value => {
          if (mounted.current) setLevel(value)
        },
        maxSeconds: VOICE_MAX_SECONDS,
        onAutoStop: () => stopRef.current(),
      })
      if (!mounted.current) {
        recorder.cancel()
        return
      }
      recorderRef.current = recorder
      setPhase('recording')
    } catch (cause) {
      if (mounted.current) setError(describeVoiceError(cause))
    }
  }, [capture])

  const cancel = () => {
    recorderRef.current?.cancel()
    recorderRef.current = null
    setPhase('idle')
  }

  const meter = Math.min(1, level * 4)
  return (
    <div className="flex flex-col items-start gap-1" data-testid="voice-input" data-phase={phase}>
      <div className="flex items-center gap-1">
        {phase === 'recording' ? (
          <>
            <button
              type="button"
              aria-label="停止录音"
              onClick={() => void finish()}
              className="flex h-7 cursor-pointer items-center gap-2 rounded-full bg-weak-soft pr-3 pl-2.5 text-callout text-label-1 ring-1 ring-weak/40 transition-colors duration-[var(--dur-fast)] hover:ring-weak"
            >
              <span aria-hidden className="inline-block size-2 animate-pulse rounded-full bg-weak" />
              <span className="tabular-nums">{formatClock(elapsed)}</span>
              <span aria-hidden className="relative h-1 w-10 overflow-hidden rounded-full bg-card">
                <span data-testid="voice-level" className="absolute inset-y-0 left-0 rounded-full bg-weak" style={{ width: `${Math.round(meter * 100)}%` }} />
              </span>
              <Icon name="stop-fill" size={12} className="text-weak" />
            </button>
            <Button variant="ghost" size="sm" onClick={cancel}>
              取消
            </Button>
          </>
        ) : phase === 'transcribing' ? (
          <button
            type="button"
            aria-label="转写中"
            disabled
            className="flex h-7 cursor-not-allowed items-center gap-1.5 rounded-full bg-inset px-2.5 text-callout text-label-2"
          >
            <Spinner size={14} />
            转写中…
          </button>
        ) : (
          <IconButton icon="mic" label="语音输入" disabled={disabled} onClick={() => void start()} />
        )}
      </div>
      {error && (
        <span role="alert" className="max-w-md text-footnote text-weak">
          {error}
        </span>
      )}
      {notice && !error && (
        <span role="status" className="text-footnote text-label-3">
          {notice}
        </span>
      )}
    </div>
  )
}
