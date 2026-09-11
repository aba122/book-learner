/**
 * 正文上的指针层(BL-011):WKWebView 里 epub.js 的正文 iframe 是 sandbox="allow-same-origin"(无脚本),
 * 挂在它 document 上的事件监听器根本不会被调用(合成事件也不会),所以鼠标交互全部由父文档的这一层接管:
 * - 单击(没拖、没划选、按下时无选区、没点到高亮):左半页翻上一页、右半页翻下一页;
 * - 拖动:用 caretRangeFromPoint + setBaseAndExtent 在正文里造选区(高亮工具条靠轮询 getSelection 出现,BL-006);
 * - 双击:选中一个词(WebKit Range.expand('word'));
 * - 按下时已有选区:这一下只是取消选区;
 * - 点到 epub.js 画在父文档的高亮 SVG(它是 pointer-events:none,真实点击本来就打不到):按几何命中后把 click 转发给它(BL-007 取消/换色)。
 */
import { findVisibleFrame } from './pageCurlOverlay'

export const POINTER_DRAG_PX = 4

export interface PointerLayerOptions {
  viewport: HTMLElement
  getContents: () => unknown
  onTurn: (side: 'prev' | 'next') => void
}

type CaretDoc = Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null }
type ExpandableRange = Range & { expand?: (unit: string) => void }

interface Press {
  x: number
  y: number
  doc: CaretDoc | null
  frameLeft: number
  frameTop: number
  anchor: Range | null
  hadSelection: boolean
  mark: Element | null
  dragging: boolean
}

function caretAt(doc: CaretDoc, x: number, y: number): Range | null {
  try {
    return doc.caretRangeFromPoint?.(x, y) ?? null
  } catch {
    return null
  }
}

/**
 * 指针下方是不是 epub.js 的注解(高亮/下划线):marks-pane 的 svg 是 pointer-events=none,
 * elementFromPoint 永远打不到它,所以按每个 <g> 里 <rect> 的几何范围自己判定;命中就把 click 转发给 <g>(epub.js 在它上面挂了回调)。
 */
function markUnder(viewport: HTMLElement, x: number, y: number): Element | null {
  for (const g of Array.from(viewport.querySelectorAll('svg g'))) {
    const boxes = g.querySelectorAll('rect')
    const targets: Element[] = boxes.length ? Array.from(boxes) : [g]
    for (const t of targets) {
      const r = t.getBoundingClientRect()
      if (r.width > 0 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return g
    }
  }
  return null
}

export function attachPointerLayer(layer: HTMLElement, options: PointerLayerOptions): () => void {
  let press: Press | null = null

  const locate = () => {
    const found = findVisibleFrame(options.getContents(), options.viewport)
    if (!found) return null
    const r = found.frame.getBoundingClientRect()
    return { doc: found.doc as CaretDoc, frameLeft: r.left, frameTop: r.top }
  }

  const onDown = (e: MouseEvent) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.altKey) {
      press = null
      return
    }
    const loc = locate()
    const doc = loc?.doc ?? null
    const sel = doc?.getSelection() ?? null
    const hadSelection = !!sel && !sel.isCollapsed
    if (hadSelection && !e.shiftKey) sel?.removeAllRanges()
    press = {
      x: e.clientX,
      y: e.clientY,
      doc,
      frameLeft: loc?.frameLeft ?? 0,
      frameTop: loc?.frameTop ?? 0,
      anchor: doc && loc ? caretAt(doc, e.clientX - loc.frameLeft, e.clientY - loc.frameTop) : null,
      hadSelection,
      mark: markUnder(options.viewport, e.clientX, e.clientY),
      dragging: false,
    }
    e.preventDefault() // 不让父文档自己起选区
  }

  const onMove = (e: MouseEvent) => {
    if (!press) {
      // 悬停光标:落在文字上显示 I 形
      const loc = locate()
      const r = loc ? caretAt(loc.doc, e.clientX - loc.frameLeft, e.clientY - loc.frameTop) : null
      layer.style.cursor = r && r.startContainer.nodeType === 3 ? 'text' : ''
      return
    }
    if (!press.dragging && Math.abs(e.clientX - press.x) <= POINTER_DRAG_PX && Math.abs(e.clientY - press.y) <= POINTER_DRAG_PX) return
    press.dragging = true
    if (!press.doc || !press.anchor) return
    const focus = caretAt(press.doc, e.clientX - press.frameLeft, e.clientY - press.frameTop)
    if (!focus) return
    try {
      press.doc.getSelection()?.setBaseAndExtent(press.anchor.startContainer, press.anchor.startOffset, focus.startContainer, focus.startOffset)
    } catch {
      /* 跨节点失败时忽略这一帧 */
    }
  }

  const onUp = (e: MouseEvent) => {
    const p = press
    press = null
    if (!p || e.button !== 0) return
    if (p.dragging) return // 划选完成,选区交给轮询出工具条
    if (p.hadSelection) return // 这一下只是取消选区
    if (p.mark) {
      p.mark.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: e.clientX, clientY: e.clientY }))
      return
    }
    const vr = options.viewport.getBoundingClientRect()
    options.onTurn(e.clientX < vr.left + vr.width / 2 ? 'prev' : 'next')
  }

  const onDblClick = (e: MouseEvent) => {
    const loc = locate()
    if (!loc) return
    const r = caretAt(loc.doc, e.clientX - loc.frameLeft, e.clientY - loc.frameTop) as ExpandableRange | null
    if (!r || typeof r.expand !== 'function') return
    try {
      r.expand('word')
      loc.doc.getSelection()?.setBaseAndExtent(r.startContainer, r.startOffset, r.endContainer, r.endOffset)
    } catch {
      /* 选词失败不影响阅读 */
    }
  }

  const onLeave = () => {
    if (press && !press.dragging) press = null
  }

  layer.addEventListener('mousedown', onDown)
  layer.addEventListener('mousemove', onMove)
  layer.addEventListener('mouseup', onUp)
  layer.addEventListener('dblclick', onDblClick)
  layer.addEventListener('mouseleave', onLeave)
  return () => {
    layer.removeEventListener('mousedown', onDown)
    layer.removeEventListener('mousemove', onMove)
    layer.removeEventListener('mouseup', onUp)
    layer.removeEventListener('dblclick', onDblClick)
    layer.removeEventListener('mouseleave', onLeave)
  }
}
