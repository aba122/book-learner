import { VOICE_MAX_SECONDS, VOICE_SAMPLE_RATE } from '../config'

/**
 * 语音输入的音频链路(M3 T3):麦克风 → 原始 Float32 帧(ScriptProcessor)→ 单声道 → 线性重采样到 16 kHz → i16。
 * 壳层 `voice_transcribe` 只接受 16 kHz 单声道 i16 小端 PCM;这里不经编解码器(WebKit 的 MediaRecorder 只出 mp4/aac,
 * 解码再重采样会多一跳且时长不稳),ScriptProcessor 缺失时回退到 MediaRecorder + decodeAudioData。
 */

/** 多声道取平均 */
export function downmix(channels: Float32Array[]): Float32Array {
  if (channels.length === 0) return new Float32Array(0)
  if (channels.length === 1) return channels[0]
  const length = Math.min(...channels.map(c => c.length))
  const out = new Float32Array(length)
  for (let i = 0; i < length; i += 1) {
    let sum = 0
    for (const channel of channels) sum += channel[i]
    out[i] = sum / channels.length
  }
  return out
}

/** 线性插值重采样;`fromRate === toRate` 时原样返回 */
export function resampleLinear(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (!(fromRate > 0) || !(toRate > 0)) throw new Error(`invalid sample rate ${fromRate} → ${toRate}`)
  if (fromRate === toRate || input.length === 0) return input
  const ratio = fromRate / toRate
  const length = Math.max(1, Math.round(input.length / ratio))
  const out = new Float32Array(length)
  for (let i = 0; i < length; i += 1) {
    const position = i * ratio
    const index = Math.floor(position)
    const next = Math.min(index + 1, input.length - 1)
    const frac = position - index
    out[i] = input[index] * (1 - frac) + input[next] * frac
  }
  return out
}

/** [-1, 1] → i16(四舍五入并钳位) */
export function floatToInt16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length)
  for (let i = 0; i < input.length; i += 1) {
    const v = Math.max(-1, Math.min(1, input[i]))
    out[i] = Math.round(v < 0 ? v * 32768 : v * 32767)
  }
  return out
}

/** 均方根电平(0–1),供录音时的电平提示 */
export function rms(input: Float32Array): number {
  if (input.length === 0) return 0
  let sum = 0
  for (let i = 0; i < input.length; i += 1) sum += input[i] * input[i]
  return Math.sqrt(sum / input.length)
}

/** 把若干 Float32 片段拼成一段 */
export function concatFrames(frames: Float32Array[]): Float32Array {
  const total = frames.reduce((n, f) => n + f.length, 0)
  const out = new Float32Array(total)
  let offset = 0
  for (const frame of frames) {
    out.set(frame, offset)
    offset += frame.length
  }
  return out
}

/** 任意采样率的单声道 Float32 → 壳层要求的 16 kHz i16 */
export function toPcm16k(mono: Float32Array, sampleRate: number): Int16Array {
  return floatToInt16(resampleLinear(mono, sampleRate, VOICE_SAMPLE_RATE))
}

export interface Recorder {
  /** 结束录音并返回 16 kHz i16 PCM */
  stop: () => Promise<Int16Array>
  /** 放弃录音(释放麦克风,不产出) */
  cancel: () => void
}

export interface CaptureOptions {
  deviceId: string | null
  onLevel?: (level: number) => void
  /** 达到上限自动停止(秒),默认 VOICE_MAX_SECONDS */
  maxSeconds?: number
  onAutoStop?: () => void
}

export type CaptureFn = (options: CaptureOptions) => Promise<Recorder>

function audioContextCtor(): typeof AudioContext | null {
  const w = globalThis as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }
  return w.AudioContext ?? w.webkitAudioContext ?? null
}

/** 打开麦克风并开始采集;权限/设备错误原样抛出(NotAllowedError / NotFoundError 等) */
export const captureMicrophone: CaptureFn = async ({ deviceId, onLevel, maxSeconds = VOICE_MAX_SECONDS, onAutoStop }) => {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new DOMException('当前环境没有麦克风接口', 'NotSupportedError')
  }
  const constraints: MediaStreamConstraints = {
    audio: deviceId ? { deviceId: { exact: deviceId }, echoCancellation: true, noiseSuppression: true } : { echoCancellation: true, noiseSuppression: true },
  }
  const stream = await navigator.mediaDevices.getUserMedia(constraints)
  const Ctor = audioContextCtor()
  const context = Ctor ? new Ctor() : null
  const release = () => {
    for (const track of stream.getTracks()) track.stop()
    void context?.close().catch(() => {})
  }
  const maxFrames = Math.ceil(maxSeconds * (context?.sampleRate ?? 48_000))

  if (context && typeof context.createScriptProcessor === 'function') {
    const source = context.createMediaStreamSource(stream)
    const processor = context.createScriptProcessor(4096, 1, 1)
    const frames: Float32Array[] = []
    let collected = 0
    let stopped = false
    let autoStopped = false
    processor.onaudioprocess = event => {
      if (stopped) return
      const channels: Float32Array[] = []
      for (let c = 0; c < event.inputBuffer.numberOfChannels; c += 1) channels.push(new Float32Array(event.inputBuffer.getChannelData(c)))
      const mono = downmix(channels)
      frames.push(mono)
      collected += mono.length
      onLevel?.(rms(mono))
      if (collected >= maxFrames && !autoStopped) {
        autoStopped = true
        onAutoStop?.()
      }
    }
    source.connect(processor)
    // ScriptProcessor 必须接到输出才会被驱动;经零增益节点避免回放
    const mute = context.createGain()
    mute.gain.value = 0
    processor.connect(mute)
    mute.connect(context.destination)
    const teardown = () => {
      stopped = true
      try {
        processor.disconnect()
        source.disconnect()
        mute.disconnect()
      } catch {
        /* 已断开 */
      }
      release()
    }
    return {
      stop: async () => {
        teardown()
        return toPcm16k(concatFrames(frames), context.sampleRate)
      },
      cancel: teardown,
    }
  }

  // 回退:MediaRecorder → decodeAudioData → 重采样
  if (typeof MediaRecorder === 'undefined' || !context) {
    release()
    throw new DOMException('当前环境不支持录音', 'NotSupportedError')
  }
  const recorder = new MediaRecorder(stream)
  const chunks: Blob[] = []
  recorder.ondataavailable = event => {
    if (event.data.size > 0) chunks.push(event.data)
  }
  const done = new Promise<void>(resolve => {
    recorder.onstop = () => resolve()
  })
  recorder.start(250)
  const timer = setTimeout(() => {
    if (recorder.state === 'recording') onAutoStop?.()
  }, maxSeconds * 1000)
  return {
    stop: async () => {
      clearTimeout(timer)
      if (recorder.state !== 'inactive') recorder.stop()
      await done
      const blob = new Blob(chunks, { type: recorder.mimeType })
      const decoded = await context.decodeAudioData(await blob.arrayBuffer())
      const channels: Float32Array[] = []
      for (let c = 0; c < decoded.numberOfChannels; c += 1) channels.push(decoded.getChannelData(c))
      release()
      return toPcm16k(downmix(channels), decoded.sampleRate)
    },
    cancel: () => {
      clearTimeout(timer)
      if (recorder.state !== 'inactive') recorder.stop()
      release()
    },
  }
}

/** 可用的音频输入设备(权限未授予时 label 为空) */
export async function listAudioInputs(): Promise<{ deviceId: string; label: string }[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return []
  const devices = await navigator.mediaDevices.enumerateDevices()
  return devices.filter(d => d.kind === 'audioinput').map((d, index) => ({ deviceId: d.deviceId, label: d.label || `麦克风 ${index + 1}` }))
}
