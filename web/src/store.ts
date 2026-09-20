import { create } from 'zustand'
import { SIDEBAR_KEY, THEME_KEY } from './config'

/** 外观偏好:跟随系统 / 手动浅色 / 手动深色(HIG:不做 app 级开关,手动覆盖放设置页) */
export type ThemePreference = 'system' | 'light' | 'dark'
/** 已解析的外观(阅读器 BL-013 耦合与测试都按这个值) */
export type Theme = 'light' | 'dark'

/** 仅跨页会话状态;领域数据一律走 backend 契约,不入 store。 */
interface SessionState {
  activeBookId: number | null
  currentTaskId: number | null
  theme: Theme
  themePreference: ThemePreference
  sidebarCollapsed: boolean
  /** 一次性跨页提示(如:评估已保存但任务状态同步失败),由目标页展示后清除 */
  pendingNotice: string | null
  setActiveBookId: (id: number | null) => void
  setPendingNotice: (notice: string | null) => void
  setCurrentTaskId: (id: number | null) => void
  setTheme: (preference: ThemePreference) => void
  toggleSidebar: () => void
}

const DARK_QUERY = '(prefers-color-scheme: dark)'

/** 存储里只有 light|dark 表示手动覆盖;缺失或非法值 = 跟随系统(BL-003 的持久化键不变) */
function readPreference(): ThemePreference {
  try {
    const raw = localStorage.getItem(THEME_KEY)
    return raw === 'dark' || raw === 'light' ? raw : 'system'
  } catch {
    return 'system'
  }
}
function systemDark(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(DARK_QUERY).matches
}
function resolve(preference: ThemePreference): Theme {
  return preference === 'system' ? (systemDark() ? 'dark' : 'light') : preference
}
function applyTheme(theme: Theme) {
  document.documentElement.setAttribute('data-theme', theme)
}
function readSidebar(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_KEY) === 'collapsed'
  } catch {
    return false
  }
}

const initialPreference = readPreference()
const initialTheme = resolve(initialPreference)
applyTheme(initialTheme)

export const useSession = create<SessionState>((set, get) => ({
  activeBookId: null,
  currentTaskId: null,
  theme: initialTheme,
  themePreference: initialPreference,
  sidebarCollapsed: readSidebar(),
  pendingNotice: null,
  setActiveBookId: activeBookId => set({ activeBookId }),
  setPendingNotice: pendingNotice => set({ pendingNotice }),
  setCurrentTaskId: currentTaskId => set({ currentTaskId }),
  setTheme: preference => {
    const theme = resolve(preference)
    applyTheme(theme)
    try {
      if (preference === 'system') localStorage.removeItem(THEME_KEY)
      else localStorage.setItem(THEME_KEY, preference)
    } catch {
      /* 无持久化时只在本次生效 */
    }
    set({ themePreference: preference, theme })
  },
  toggleSidebar: () => {
    const sidebarCollapsed = !get().sidebarCollapsed
    try {
      localStorage.setItem(SIDEBAR_KEY, sidebarCollapsed ? 'collapsed' : 'open')
    } catch {
      /* 同上 */
    }
    set({ sidebarCollapsed })
  },
}))

// 跟随系统时,系统外观切换即刻生效(不重载)
if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
  window.matchMedia(DARK_QUERY).addEventListener('change', () => {
    if (useSession.getState().themePreference !== 'system') return
    const theme = resolve('system')
    applyTheme(theme)
    useSession.setState({ theme })
  })
}
