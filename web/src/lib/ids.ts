/** 与 core `orchestrate::validate_client_id` 一致:非空、≤64、仅 [A-Za-z0-9._-] */
export const CLIENT_ID_RE = /^[A-Za-z0-9._-]{1,64}$/

function fallbackId(): string {
  const time = Date.now().toString(36)
  const rand = Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 12)
  return `${time}-${rand}`
}

/**
 * 非幂等写操作的客户端 id:在**触发时生成一次**并进入操作 args,重试复用同一 id(服务端重放/续跑)。
 * 页面不得为重试重新生成。
 */
export function newClientId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  const id = typeof c?.randomUUID === 'function' ? c.randomUUID() : fallbackId()
  if (!CLIENT_ID_RE.test(id)) throw new Error('generated client id violates contract')
  return id
}

export function isClientId(value: string): boolean {
  return CLIENT_ID_RE.test(value)
}
