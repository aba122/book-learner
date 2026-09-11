import { describe, expect, it, vi } from 'vitest'
import { attachClickToTurn, sideOf } from './clickToTurn'

function setup(width = 600) {
  const doc = document.implementation.createHTMLDocument('x')
  doc.body.innerHTML = '<p id="p">正文</p><a id="a" href="#note">注</a>'
  const viewport = document.createElement('div')
  vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue({ left: 100, width, top: 0, height: 800, right: 100 + width, bottom: 800, x: 100, y: 0, toJSON: () => ({}) })
  const onTurn = vi.fn()
  const detach = attachClickToTurn(doc, viewport, onTurn)
  const press = (x: number, upX = x, target: Element = doc.getElementById('p')!, init: MouseEventInit = {}) => {
    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: x, clientY: 300, button: 0, ...init }))
    target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: upX, clientY: 300, button: 0, ...init }))
  }
  return { doc, viewport, onTurn, detach, press }
}

describe('点正文半页翻页(BL-011)', () => {
  it('左半页 → prev,右半页 → next;iframe 没有 frameElement 时按可视区左缘换算', () => {
    const { onTurn, press } = setup()
    press(100)
    press(500)
    expect(onTurn.mock.calls.map(c => c[0])).toEqual(['prev', 'next'])
  })

  it('拖动、划选、按下时已有选区、点链接、带修饰键:都不翻', () => {
    const { doc, onTurn, press } = setup()
    press(100, 120) // 拖了 20 px
    const sel = { isCollapsed: false } as Selection
    const getSel = vi.spyOn(doc, 'getSelection').mockReturnValue(sel)
    press(100) // 松开时有选区(划选)
    getSel.mockReturnValue({ isCollapsed: true } as Selection)
    doc.getElementById('p')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 100, clientY: 300, button: 0 }))
    getSel.mockRestore()
    press(100, 100, doc.getElementById('a')!)
    press(100, 100, doc.getElementById('p')!, { metaKey: true })
    expect(onTurn).not.toHaveBeenCalled()
  })

  it('按下时已有选区:这一下只是取消选区', () => {
    const { doc, onTurn, press } = setup()
    const getSel = vi.spyOn(doc, 'getSelection')
    getSel.mockReturnValueOnce({ isCollapsed: false } as Selection).mockReturnValue({ isCollapsed: true } as Selection)
    press(100)
    expect(onTurn).not.toHaveBeenCalled()
    press(100)
    expect(onTurn).toHaveBeenCalledWith('prev')
  })

  it('detach 后不再响应;sideOf 用 frameElement 的位置换算横向滚动后的 iframe', () => {
    const { onTurn, press, detach } = setup()
    detach()
    press(500)
    expect(onTurn).not.toHaveBeenCalled()
    const viewport = document.createElement('div')
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue({ left: 0, width: 600 } as DOMRect)
    const frame = { getBoundingClientRect: () => ({ left: -600 }) }
    const doc = { defaultView: { frameElement: frame } } as unknown as Document
    // iframe 已向左滚了一页:iframe 内 x=700 落在可视区 100 处 → 左半页
    expect(sideOf(doc, viewport, 700)).toBe('prev')
    expect(sideOf(doc, viewport, 1100)).toBe('next')
  })
})
