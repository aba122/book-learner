import { describe, expect, it, vi } from 'vitest'
import { attachPointerLayer } from './pointerLayer'

/** 造一个"可视正文 iframe":真 iframe(有 defaultView.frameElement),文档里一段文字;caretRangeFromPoint 是 WebKit 私有 API,这里桩掉 */
function setup() {
  const frame = document.createElement('iframe')
  document.body.appendChild(frame)
  const doc = frame.contentDocument! as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null }
  doc.body.innerHTML = '<p id="p">当需求量等于供给量时,市场处于均衡。</p>'
  const text = doc.getElementById('p')!.firstChild!
  const rect = (left: number, width: number) => ({ left, width, right: left + width, top: 0, bottom: 800, height: 800, x: left, y: 0, toJSON: () => ({}) }) as DOMRect
  vi.spyOn(frame, 'getBoundingClientRect').mockReturnValue(rect(0, 600))
  const viewport = document.createElement('div')
  vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(rect(0, 600))
  const layer = document.createElement('div')
  document.body.appendChild(layer)
  // caretRangeFromPoint:x 每 20px 一个字符
  doc.caretRangeFromPoint = (x: number) => {
    const r = doc.createRange()
    const off = Math.max(0, Math.min(text.textContent!.length, Math.round(x / 20)))
    r.setStart(text, off)
    r.setEnd(text, off)
    ;(r as Range & { expand?: (u: string) => void }).expand = vi.fn(() => { r.setStart(text, 0); r.setEnd(text, 3) })
    return r
  }
  const sel = doc.getSelection()!
  const setBase = vi.spyOn(sel, 'setBaseAndExtent')
  const removeAll = vi.spyOn(sel, 'removeAllRanges')
  const onTurn = vi.fn()
  const detach = attachPointerLayer(layer, { viewport, getContents: () => [{ document: doc }], onTurn })
  const ev = (type: string, x: number, init: MouseEventInit = {}) => layer.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: 300, button: 0, ...init }))
  return { doc, sel, setBase, removeAll, onTurn, detach, ev, layer, frame, viewport }
}

describe('正文指针层(BL-011)', () => {
  it('单击:左半页 prev、右半页 next;拖动:用 caretRangeFromPoint 造选区且不翻页', () => {
    const { ev, onTurn, setBase, detach, frame } = setup()
    ev('mousedown', 100); ev('mouseup', 100)
    ev('mousedown', 500); ev('mouseup', 500)
    expect(onTurn.mock.calls.map(c => c[0])).toEqual(['prev', 'next'])
    ev('mousedown', 100); ev('mousemove', 160); ev('mousemove', 200); ev('mouseup', 200)
    expect(setBase).toHaveBeenCalled()
    const last = setBase.mock.calls.at(-1)!
    expect([last[1], last[3]]).toEqual([5, 10])
    expect(onTurn).toHaveBeenCalledTimes(2)
    detach(); frame.remove()
  })

  it('按下时已有选区:只取消选区不翻页;之后再单击才翻', () => {
    const { ev, onTurn, sel, removeAll, doc, detach, frame } = setup()
    const r = doc.caretRangeFromPoint!(0, 0)!
    r.setEnd(r.startContainer, 6)
    sel.removeAllRanges(); sel.addRange(r)
    removeAll.mockClear()
    ev('mousedown', 500); ev('mouseup', 500)
    expect(removeAll).toHaveBeenCalledTimes(1)
    expect(onTurn).not.toHaveBeenCalled()
    ev('mousedown', 500); ev('mouseup', 500)
    expect(onTurn).toHaveBeenCalledWith('next')
    detach(); frame.remove()
  })

  it('双击选词(Range.expand);修饰键/右键不翻页;点到 epub.js 高亮 SVG 时转发 click', () => {
    const { ev, onTurn, setBase, layer, detach, frame, sel, viewport } = setup()
    ev('dblclick', 100)
    expect(setBase).toHaveBeenLastCalledWith(expect.anything(), 0, expect.anything(), 3)
    sel.removeAllRanges() // 选词后清掉,后面的单击才不会被当成"取消选区"
    ev('mousedown', 500, { metaKey: true }); ev('mouseup', 500, { metaKey: true })
    ev('mousedown', 500, { button: 2 }); ev('mouseup', 500, { button: 2 })
    expect(onTurn).not.toHaveBeenCalled()
    // epub.js 的注解画板 svg 是 pointer-events:none,elementFromPoint 打不到;按 <rect> 几何命中
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('pointer-events', 'none')
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g')
    g.setAttribute('class', 'bl-highlight')
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
    vi.spyOn(rect, 'getBoundingClientRect').mockReturnValue({ left: 480, right: 560, top: 290, bottom: 310, width: 80, height: 20 } as DOMRect)
    g.appendChild(rect); svg.appendChild(g); viewport.appendChild(svg)
    const clicked = vi.fn(); g.addEventListener('click', clicked)
    ev('mousedown', 500); ev('mouseup', 500) // (500,300) 落在 rect 里
    expect(clicked).toHaveBeenCalledTimes(1)
    expect(onTurn).not.toHaveBeenCalled()
    ev('mousedown', 300); ev('mouseup', 300) // rect 外:照常翻页
    expect(onTurn).toHaveBeenCalledWith('prev')
    expect(layer.style.pointerEvents).toBe('')
    detach(); frame.remove()
  })
})
