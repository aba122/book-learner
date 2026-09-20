import { useEffect } from 'react'
import { BrowserRouter, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { backend } from './backend'
import Icon from './components/icons/Icon'
import type { IconName } from './components/icons/paths'
import IconButton from './components/IconButton'
import FeynmanPage from './features/feynman/FeynmanPage'
import FinalExamPage from './features/feynman/FinalExamPage'
import LibraryPage from './features/library/LibraryPage'
import MapPage from './features/map/MapPage'
import ReaderPage from './features/reader/ReaderPage'
import SettingsPage from './features/settings/SettingsPage'
import StatsPage from './features/stats/StatsPage'
import TodayPage from './features/today/TodayPage'
import { useSession } from './store'

/** 路由切换写进 app 日志(target client),用于回溯用户操作时间线;只记路径,不记参数以外的内容 */
function RouteLogger() {
  const location = useLocation()
  useEffect(() => {
    void backend.logClientEvent('info', 'route', { path: location.pathname + location.search })
  }, [location.pathname, location.search])
  return null
}

/** 原生菜单栏动作(设置… ⌘, / 隐藏·显示侧栏 ⌃⌘S)→ 路由 / 侧栏状态;浏览器 mock 用同样快捷键 */
function MenuActions() {
  const navigate = useNavigate()
  const toggleSidebar = useSession(s => s.toggleSidebar)
  useEffect(() => {
    let dispose: (() => void) | null = null
    let alive = true
    void backend
      .subscribeMenu(action => {
        if (action === 'open-settings') navigate('/settings')
        else if (action === 'toggle-sidebar') toggleSidebar()
      })
      .then(off => {
        if (alive) dispose = off
        else off()
      })
      .catch(() => {})
    return () => {
      alive = false
      dispose?.()
    }
  }, [navigate, toggleSidebar])
  return null
}

/**
 * 侧栏(视觉改版第一批):顶部 52px 是标题栏带(透明标题栏下红绿灯落在这里,整条可拖动窗口);
 * 图标 + 文字导航,选中态中性填充 + 强调色图标(三任务色只标数据);底部不放任何操作;
 * 原生材质从 bg-sidebar 半透明纸色下透出;可隐藏(⌃⌘S / 菜单 / 右上按钮)。
 */
function Sidebar() {
  const activeBookId = useSession(s => s.activeBookId)
  const collapsed = useSession(s => s.sidebarCollapsed)
  const toggleSidebar = useSession(s => s.toggleSidebar)

  const items: { to: string; label: string; icon: IconName; end: boolean }[] = [
    { to: '/', label: '今日学习', icon: 'sun', end: true },
    { to: '/library', label: '书架', icon: 'books', end: true },
    { to: activeBookId ? `/map/${activeBookId}` : '/library', label: '知识地图', icon: 'map', end: false },
    { to: '/stats', label: '统计', icon: 'chart-bar', end: true },
    { to: '/settings', label: '设置', icon: 'gear', end: true },
  ]

  return (
    <aside aria-label="侧栏" hidden={collapsed} className="relative flex w-60 shrink-0 flex-col bg-sidebar">
      <div data-tauri-drag-region className="h-13 shrink-0" />
      <IconButton icon="sidebar-left" label="隐藏侧栏" onClick={toggleSidebar} className="absolute top-3 right-2" />
      <div className="px-5 pb-3">
        <span className="font-serif text-title2 font-semibold tracking-[0.3em] text-label-1">攻书</span>
      </div>
      <nav aria-label="主导航" className="flex flex-col gap-0.5 px-3">
        {items.map(item => (
          <NavLink
            key={item.label}
            to={item.to}
            end={item.end}
            className={({ isActive }) =>
              `group flex h-7 items-center gap-2.5 rounded-s px-2 text-body transition-colors duration-[var(--dur-fast)] ${
                isActive ? 'bg-fill-selected font-medium text-label-1' : 'text-label-2 hover:bg-fill-hover hover:text-label-1'
              }`
            }
          >
            {({ isActive }) => (
              <>
                <Icon name={item.icon} size={16} className={isActive ? 'text-accent' : 'text-label-3 group-hover:text-label-2'} />
                {item.label}
              </>
            )}
          </NavLink>
        ))}
      </nav>
    </aside>
  )
}

export default function App() {
  const setActiveBookId = useSession(s => s.setActiveBookId)

  useEffect(() => {
    let alive = true
    void backend.listBooks()
      .then(books => {
        if (!alive) return
        const active = books.find(b => b.status === 'active')
        if (active) setActiveBookId(active.id)
      })
      // Active-book discovery is non-critical: route-level loaders own visible errors.
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [setActiveBookId])

  return (
    <BrowserRouter>
      <RouteLogger />
      <MenuActions />
      <div className="flex h-full">
        <Sidebar />
        {/* 主区不透明。每个页面自己渲染 52px 的 Toolbar 带(components/Toolbar)作为拖动区与标题栏延伸 */}
        <main className="flex min-w-0 flex-1 flex-col overflow-hidden bg-content">
          <Routes>
            <Route path="/" element={<TodayPage />} />
            <Route path="/library" element={<LibraryPage />} />
            <Route path="/map/:bookId" element={<MapPage />} />
            <Route path="/reader/:blockId" element={<ReaderPage />} />
            <Route path="/feynman/:taskId" element={<FeynmanPage />} />
            <Route path="/final/:bookId" element={<FinalExamPage />} />
            <Route path="/stats" element={<StatsPage />} />
            <Route path="/settings" element={<SettingsPage />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  )
}
