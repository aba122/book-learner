import type { ReactNode } from 'react'
import { useIsPhone } from '../lib/useMedia'
import { useSession } from '../store'
import IconButton from './IconButton'

/**
 * 工具栏带(视觉改版第一批):每个页面根渲染一条,52px,与透明标题栏一体,整条是拖动区;
 * 侧栏折叠时自动在最左给出「显示侧栏」(左留 64px 让开红绿灯)。没有命令的页也渲染空带。
 */
export default function Toolbar({ 'aria-label': ariaLabel, className = '', children }: { 'aria-label': string; className?: string; children?: ReactNode }) {
  const collapsed = useSession(s => s.sidebarCollapsed)
  const toggleSidebar = useSession(s => s.toggleSidebar)
  // 手机(BL-032 M3):没有侧栏(底部标签栏),带高 44、无红绿灯让位
  const phone = useIsPhone()
  const sidebarButton = collapsed && !phone
  return (
    <div
      role="toolbar"
      aria-label={ariaLabel}
      data-tauri-drag-region
      className={`flex h-13 shrink-0 items-center gap-1 border-b border-sep bg-content px-3 @container max-md:h-11 max-md:px-2 ${sidebarButton ? 'pl-[72px]' : ''} ${className}`}
    >
      {sidebarButton && <IconButton icon="sidebar-left" label="显示侧栏" onClick={toggleSidebar} className="-ml-1 mr-1" />}
      {children}
    </div>
  )
}

/** 工具栏分隔线 */
export function ToolbarDivider() {
  return <span aria-hidden className="mx-1 h-4 w-px bg-sep" />
}

/** 工具栏弹性间隔 */
export function ToolbarSpacer() {
  return <span aria-hidden data-tauri-drag-region className="flex-1" />
}
