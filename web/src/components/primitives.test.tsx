import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isModalOpen, resetModalStack } from '../lib/modalStack'
import Confirm from './Confirm'
import Dialog from './Dialog'
import EmptyState from './EmptyState'
import Field from './Field'
import IconButton from './IconButton'
import Input from './Input'
import Segmented from './Segmented'
import Toggle from './Toggle'
import Tooltip from './Tooltip'

afterEach(() => resetModalStack())

describe('Dialog(视觉改版第一批)', () => {
  function Host({ dismissible = true }: { dismissible?: boolean }) {
    const [open, setOpen] = useState(false)
    return (
      <>
        <button onClick={() => setOpen(true)}>打开</button>
        <Dialog open={open} title="标题" description="说明" dismissible={dismissible} onClose={() => setOpen(false)} footer={<button onClick={() => setOpen(false)}>好</button>}>
          <input aria-label="里面的输入" />
        </Dialog>
      </>
    )
  }
  it('role/name/description;打开时焦点进面板,html 带 data-modal-open;关闭后焦点回触发钮', async () => {
    const user = userEvent.setup()
    render(<Host />)
    const trigger = screen.getByRole('button', { name: '打开' })
    await user.click(trigger)
    const dialog = screen.getByRole('dialog', { name: '标题' })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(dialog).toHaveAccessibleDescription('说明')
    expect(isModalOpen()).toBe(true)
    expect(dialog).toHaveFocus() // 先读标题,再 Tab 进控件
    await user.tab()
    expect(screen.getByRole('button', { name: '关闭' })).toHaveFocus()
    await user.click(screen.getByRole('button', { name: '好' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(isModalOpen()).toBe(false)
    expect(trigger).toHaveFocus()
  })
  it('Tab 在面板内循环;Esc 关闭;dismissible=false 时 Esc 与遮罩无效', async () => {
    const user = userEvent.setup()
    const { unmount } = render(<Host />)
    await user.click(screen.getByRole('button', { name: '打开' }))
    await user.tab() // 面板 → 关闭钮
    await user.tab() // → 输入
    await user.tab() // → 好
    await user.tab() // → 回到关闭钮(循环)
    expect(screen.getByRole('button', { name: '关闭' })).toHaveFocus()
    await user.tab({ shift: true }) // 反向也循环
    expect(screen.getByRole('button', { name: '好' })).toHaveFocus()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    unmount()
    render(<Host dismissible={false} />)
    await user.click(screen.getByRole('button', { name: '打开' }))
    await user.keyboard('{Escape}')
    expect(screen.getByRole('dialog', { name: '标题' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '关闭' })).not.toBeInTheDocument()
  })
})

describe('Confirm(Dialog 薄壳)', () => {
  it('普通确认默认焦点在确认;danger 默认焦点在取消;取消禁用时 Esc 无效', async () => {
    const user = userEvent.setup()
    const onCancel = vi.fn()
    const { rerender } = render(<Confirm open title="删除这本书?" message="不可恢复" onConfirm={() => {}} onCancel={onCancel} danger confirmText="删除" />)
    expect(screen.getByRole('dialog', { name: '删除这本书?' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '取消' })).toHaveFocus()
    await user.keyboard('{Escape}')
    expect(onCancel).toHaveBeenCalledTimes(1)
    rerender(<Confirm open title="保存?" onConfirm={() => {}} onCancel={onCancel} cancelDisabled />)
    await user.keyboard('{Escape}')
    expect(onCancel).toHaveBeenCalledTimes(1)
  })
})

describe('Field + Input', () => {
  it('label 关联控件;hint/error 经 aria-describedby;error 带 role=alert 与 aria-invalid', () => {
    const { rerender } = render(<Field label="番茄钟(分钟)" hint="1–180">{ctl => <Input {...ctl} defaultValue="25" />}</Field>)
    const input = screen.getByLabelText('番茄钟(分钟)')
    expect(input).toHaveAccessibleDescription('1–180')
    expect(input).not.toHaveAttribute('aria-invalid')
    rerender(<Field label="番茄钟(分钟)" error="请输入正整数">{ctl => <Input {...ctl} defaultValue="x" />}</Field>)
    expect(screen.getByRole('alert')).toHaveTextContent('请输入正整数')
    expect(screen.getByLabelText('番茄钟(分钟)')).toHaveAttribute('aria-invalid', 'true')
  })
})

describe('Toggle', () => {
  it('role=switch,点击与空格切换,禁用不切', async () => {
    const user = userEvent.setup()
    function Host({ disabled = false }: { disabled?: boolean }) {
      const [on, setOn] = useState(false)
      return <Toggle checked={on} onChange={setOn} label="双页显示" disabled={disabled} />
    }
    const { unmount } = render(<Host />)
    const sw = screen.getByRole('switch', { name: '双页显示' })
    expect(sw).toHaveAttribute('aria-checked', 'false')
    await user.click(sw)
    expect(sw).toHaveAttribute('aria-checked', 'true')
    sw.focus()
    await user.keyboard(' ')
    expect(sw).toHaveAttribute('aria-checked', 'false')
    unmount()
    render(<Host disabled />)
    await user.click(screen.getByRole('switch', { name: '双页显示' }))
    expect(screen.getByRole('switch', { name: '双页显示' })).toHaveAttribute('aria-checked', 'false')
  })
})

describe('Segmented', () => {
  const opts = [
    { value: 'system', label: '跟随系统' },
    { value: 'light', label: '浅色' },
    { value: 'dark', label: '深色', ariaLabel: '深色外观' },
  ] as const
  function Host({ semantics }: { semantics: 'radio' | 'tabs' }) {
    const [v, setV] = useState<'system' | 'light' | 'dark'>('system')
    return <Segmented aria-label="外观" semantics={semantics} value={v} onChange={setV} options={[...opts]} />
  }
  it('radio 语义:radiogroup/radio + aria-checked;←/→ 移动并选中', async () => {
    const user = userEvent.setup()
    render(<Host semantics="radio" />)
    expect(screen.getByRole('radiogroup', { name: '外观' })).toBeInTheDocument()
    const first = screen.getByRole('radio', { name: '跟随系统' })
    expect(first).toHaveAttribute('aria-checked', 'true')
    first.focus()
    await user.keyboard('{ArrowRight}')
    expect(screen.getByRole('radio', { name: '浅色' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('radio', { name: '浅色' })).toHaveFocus()
    await user.keyboard('{End}')
    expect(screen.getByRole('radio', { name: '深色外观' })).toHaveAttribute('aria-checked', 'true')
  })
  it('tabs 语义:tablist/tab + aria-selected', async () => {
    const user = userEvent.setup()
    render(<Host semantics="tabs" />)
    expect(screen.getByRole('tablist', { name: '外观' })).toBeInTheDocument()
    await user.click(screen.getByRole('tab', { name: '浅色' }))
    expect(screen.getByRole('tab', { name: '浅色' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: '跟随系统' })).toHaveAttribute('aria-selected', 'false')
  })
})

describe('Tooltip + IconButton', () => {
  it('图标钮有可访问名与 sr-only 文字;聚焦即显 tooltip 并关联 aria-describedby,失焦即隐', async () => {
    const user = userEvent.setup()
    render(<IconButton icon="bookmark" label="书签" />)
    const btn = screen.getByRole('button', { name: '书签' })
    expect(btn).toHaveTextContent('书签')
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
    await act(async () => {
      btn.focus()
    })
    const tip = await screen.findByRole('tooltip')
    expect(tip).toHaveTextContent('书签')
    expect(btn).toHaveAttribute('aria-describedby', tip.id)
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument())
  })
  it('悬停延时后出现,离开即隐', async () => {
    render(
      <Tooltip content="提示文案" delay={30}>
        {t => (
          <button ref={t.setAnchor} onMouseEnter={t.onMouseEnter} onMouseLeave={t.onMouseLeave} onFocus={t.onFocus} onBlur={t.onBlur} aria-describedby={t['aria-describedby']}>
            目标
          </button>
        )}
      </Tooltip>,
    )
    const user = userEvent.setup()
    await user.hover(screen.getByRole('button', { name: '目标' }))
    expect(await screen.findByRole('tooltip')).toHaveTextContent('提示文案')
    await user.unhover(screen.getByRole('button', { name: '目标' }))
    await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument())
  })
})

describe('EmptyState', () => {
  it('标题为 h3,正文与动作可选', () => {
    render(<EmptyState icon="map" title="还没有脉络图" body="生成后可点节点改名。" action={<button>生成</button>} />)
    expect(screen.getByRole('heading', { level: 3, name: '还没有脉络图' })).toBeInTheDocument()
    expect(screen.getByText('生成后可点节点改名。')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '生成' })).toBeInTheDocument()
  })
})

describe('Tooltip 位置(2026-09-21)', () => {
  it('锚点贴着视口顶部时翻到下方,左边夹在 8px 内', async () => {
    const user = userEvent.setup()
    render(
      <Tooltip content="阅读设置" delay={0}>
        {t => (
          <button ref={t.setAnchor} aria-describedby={t['aria-describedby']} onMouseEnter={t.onMouseEnter} onMouseLeave={t.onMouseLeave} onFocus={t.onFocus} onBlur={t.onBlur}>
            Aa
          </button>
        )}
      </Tooltip>,
    )
    // jsdom 的 getBoundingClientRect 全 0:相当于钮贴在左上角
    await user.hover(screen.getByRole('button', { name: 'Aa' }))
    const tip = await screen.findByRole('tooltip')
    expect(tip.style.top).toBe('6px')
    expect(tip.style.left).toBe('8px')
  })
})
