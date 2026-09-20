/**
 * 轻量提示(视觉改版第二批):非阻塞、自动消失。每条自带 role=status;
 * 主机在没有条目时不渲染任何 DOM(避免常驻 status 撞页面测试里的单一 status 查询)。
 */
export interface ToastItem {
  id: number
  message: string
  description?: string
  duration: number
}

type Listener = (items: ToastItem[]) => void

let items: ToastItem[] = []
let seq = 0
const listeners = new Set<Listener>()

function emit() {
  for (const fn of listeners) fn(items)
}

export function toast(input: { message: string; description?: string; duration?: number }): number {
  const id = ++seq
  items = [...items, { id, message: input.message, description: input.description, duration: input.duration ?? 4000 }]
  emit()
  return id
}

export function dismissToast(id: number): void {
  if (!items.some(t => t.id === id)) return
  items = items.filter(t => t.id !== id)
  emit()
}

export function subscribeToasts(fn: Listener): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

export function getToasts(): ToastItem[] {
  return items
}

/** 测试用 */
export function clearToasts(): void {
  items = []
  emit()
}
