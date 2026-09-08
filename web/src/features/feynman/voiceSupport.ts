import { BackendError } from '../../backend/errors'
import { VOICE_DEVICE_KEY } from '../../config'

/** 权限/设备错误 → 用户可行动的文案;后端错误用其 message */
export function describeVoiceError(error: unknown): string {
  if (error instanceof BackendError) return error.message
  const name = (error as { name?: string } | null)?.name ?? ''
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return '麦克风权限被拒绝:请在 系统设置 → 隐私与安全性 → 麦克风 里允许攻书,然后重试。'
    case 'NotFoundError':
    case 'OverconstrainedError':
      return '没有找到可用的麦克风(检查输入设备或设置页的设备选择)。'
    case 'NotReadableError':
      return '麦克风被其它应用占用,请稍后重试。'
    case 'NotSupportedError':
      return (error as { message?: string }).message || '当前环境不支持录音。'
    default:
      return (error as { message?: string } | null)?.message || '录音失败,请重试。'
  }
}

export function storedVoiceDevice(): string | null {
  try {
    return localStorage.getItem(VOICE_DEVICE_KEY)
  } catch {
    return null
  }
}
