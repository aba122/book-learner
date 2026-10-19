import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UNPAIRED_EVENT } from '../../backend/http'
import MobileGate from './MobileGate'

const TOKEN = 'ab'.repeat(32)
let paired = false
let up = true
const calls: { url: string; body?: unknown }[] = []

beforeEach(() => {
  paired = false
  up = true
  calls.length = 0
  window.history.replaceState(null, '', '/')
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ url, body })
    if (!up) throw new TypeError('Failed to fetch')
    if (url === '/api/ping') return new Response(JSON.stringify({ version: '0.1.0', gitSha: 'x', paired }), { status: 200 })
    if (url === '/api/pair') {
      if (body?.token === TOKEN) {
        paired = true
        return new Response(null, { status: 204 })
      }
      return new Response(JSON.stringify({ code: 'unauthorized' }), { status: 401 })
    }
    return new Response('{}', { status: 404 })
  }))
})
afterEach(() => vi.unstubAllGlobals())

const renderGate = () => render(<MobileGate><p>攻书主界面</p></MobileGate>)

describe('手机访问 · 配对门(BL-032 M2)', () => {
  it('已配对直接进 app', async () => {
    paired = true
    renderGate()
    expect(await screen.findByText('攻书主界面')).toBeInTheDocument()
  })

  it('未配对显示配对页;错令牌提示,对令牌进 app', async () => {
    renderGate()
    const input = await screen.findByLabelText('配对令牌')
    expect(screen.getByRole('main', { name: '连接 Mac 上的攻书' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '连接' })).toBeDisabled()
    fireEvent.change(input, { target: { value: 'nope' } })
    fireEvent.click(screen.getByRole('button', { name: '连接' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('令牌不对')
    fireEvent.change(input, { target: { value: ` ${TOKEN} ` } })
    fireEvent.click(screen.getByRole('button', { name: '连接' }))
    expect(await screen.findByText('攻书主界面')).toBeInTheDocument()
    expect(calls.filter(c => c.url === '/api/pair').map(c => (c.body as { token: string }).token)).toEqual(['nope', TOKEN])
  })

  it('扫码地址带 #pair=令牌:先配对并清掉片段,再进 app', async () => {
    window.history.replaceState(null, '', `/#pair=${TOKEN}`)
    renderGate()
    expect(await screen.findByText('攻书主界面')).toBeInTheDocument()
    expect(window.location.hash).toBe('')
    expect(calls.map(c => c.url)).toEqual(['/api/pair', '/api/ping'])
  })

  it('连不上 Mac 显示离线与重试;恢复后进 app', async () => {
    up = false
    paired = true
    renderGate()
    expect(await screen.findByRole('alert')).toHaveTextContent('连不上 Mac 上的攻书')
    up = true
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(await screen.findByText('攻书主界面')).toBeInTheDocument()
  })

  it('运行中任一请求 401(令牌被换)→ 回到配对页并说明原因', async () => {
    paired = true
    renderGate()
    await screen.findByText('攻书主界面')
    act(() => {
      window.dispatchEvent(new Event(UNPAIRED_EVENT))
    })
    await waitFor(() => expect(screen.queryByText('攻书主界面')).toBeNull())
    expect(screen.getByRole('alert')).toHaveTextContent('令牌换过了')
  })
})
