import { afterEach, describe, expect, it, vi } from 'vitest'
import { CLIENT_ID_RE, newClientId } from './ids'

describe('newClientId', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('符合 core validate_client_id 规则(≤64,仅 [A-Za-z0-9._-])且两次不同', () => {
    const a = newClientId()
    const b = newClientId()
    expect(a).toMatch(CLIENT_ID_RE)
    expect(a.length).toBeLessThanOrEqual(64)
    expect(a).not.toBe(b)
  })

  it('crypto.randomUUID 不可用时回退仍满足同样规则', () => {
    vi.stubGlobal('crypto', {})
    const a = newClientId()
    expect(a).toMatch(CLIENT_ID_RE)
    expect(a.length).toBeLessThanOrEqual(64)
    expect(a).not.toBe(newClientId())
  })
})
