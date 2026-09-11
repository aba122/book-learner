/**
 * 点正文左半页翻上一页、右半页翻下一页(BL-011)。
 * 正文在 epub.js 的 iframe 里,事件只能挂在它的 document 上;只认"没拖动、没划选、没点链接"的单击,
 * 免得抢掉划选高亮(BL-006)与脚注链接。iframe 在分页模式下比可视区宽(容器横向滚动),
 * 所以用 frameElement 的位置把 clientX 换算到父文档,再和可视区中线比。
 */
export const CLICK_TURN_MAX_MOVE_PX = 8

export type TurnSide = 'prev' | 'next'

export function sideOf(doc: Document, viewport: HTMLElement, clientX: number): TurnSide {
  const frame = doc.defaultView?.frameElement as Element | null | undefined
  const viewportRect = viewport.getBoundingClientRect()
  const frameLeft = frame ? frame.getBoundingClientRect().left : viewportRect.left
  const x = frameLeft + clientX
  return x < viewportRect.left + viewportRect.width / 2 ? 'prev' : 'next'
}

export function attachClickToTurn(doc: Document, viewport: HTMLElement, onTurn: (side: TurnSide) => void): () => void {
  let start: { x: number; y: number; hadSelection: boolean } | null = null
  const onDown = (e: MouseEvent) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) {
      start = null
      return
    }
    const sel = doc.getSelection()
    start = { x: e.clientX, y: e.clientY, hadSelection: !!sel && !sel.isCollapsed }
  }
  const onUp = (e: MouseEvent) => {
    const s = start
    start = null
    if (!s || e.button !== 0) return
    // 拖动 / 划选:不翻
    if (Math.abs(e.clientX - s.x) > CLICK_TURN_MAX_MOVE_PX || Math.abs(e.clientY - s.y) > CLICK_TURN_MAX_MOVE_PX) return
    const sel = doc.getSelection()
    if (sel && !sel.isCollapsed) return
    // 按下时已有选区:这一下是取消选区,不翻
    if (s.hadSelection) return
    const target = e.target as Element | null
    if (target && typeof target.closest === 'function' && target.closest('a[href]')) return
    onTurn(sideOf(doc, viewport, e.clientX))
  }
  doc.addEventListener('mousedown', onDown)
  doc.addEventListener('mouseup', onUp)
  return () => {
    doc.removeEventListener('mousedown', onDown)
    doc.removeEventListener('mouseup', onUp)
  }
}
