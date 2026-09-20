/**
 * 模态栈(视觉改版第一批):有对话框打开时在 <html> 打 `data-modal-open`,
 * 供全局键盘监听(如阅读器 ←/→ 翻页)让路。多个对话框叠开时按计数维护。
 */
let depth = 0

export const MODAL_OPEN_ATTR = 'data-modal-open'

export function pushModal(): void {
  depth += 1
  document.documentElement.setAttribute(MODAL_OPEN_ATTR, String(depth))
}

export function popModal(): void {
  depth = Math.max(0, depth - 1)
  if (depth === 0) document.documentElement.removeAttribute(MODAL_OPEN_ATTR)
  else document.documentElement.setAttribute(MODAL_OPEN_ATTR, String(depth))
}

export function isModalOpen(): boolean {
  return document.documentElement.hasAttribute(MODAL_OPEN_ATTR)
}

/** 测试用:重置计数 */
export function resetModalStack(): void {
  depth = 0
  document.documentElement.removeAttribute(MODAL_OPEN_ATTR)
}
