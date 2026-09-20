import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as backendModule from '../../../backend'
import { MockBackend } from '../../../backend/mock'
import type { Backend } from '../../../backend/types'
import LineagePanel from './LineagePanel'

vi.mock('../../../backend', () => ({ backend: null as unknown as object }))

let mock: MockBackend
beforeEach(() => {
  vi.clearAllMocks()
  mock = new MockBackend()
  ;(backendModule as unknown as { backend: Backend }).backend = mock
})
afterEach(() => vi.restoreAllMocks())

describe('脉络图面板(plan 2026-09-19)', () => {
  it('空态→生成→节点渲染(编号/分类/章节标题)→点节点改名→自动保存', async () => {
    const user = userEvent.setup()
    render(<LineagePanel bookId={1} />)
    await user.click(await screen.findByRole('button', { name: '生成脉络图到当前进度' }))
    await waitFor(() => expect(screen.getByText('生产者社会')).toBeInTheDocument())
    expect(screen.getByText('消费者社会')).toBeInTheDocument()
    // 章节标题而不是 spine 序号
    expect(screen.getByText(/覆盖到:第二章/)).toBeInTheDocument()
    expect(screen.queryByText(/覆盖到第 \d+ 章/)).not.toBeInTheDocument()
    // 阅读顺序编号与分类徽标
    expect(screen.getByText('1')).toBeInTheDocument()
    expect(screen.getByText('转折')).toBeInTheDocument()

    await user.click(screen.getByText('生产者社会'))
    const titleInput = await screen.findByLabelText('节点标题')
    expect(titleInput).toHaveValue('生产者社会')
    expect(screen.getByLabelText('节点详情')).toHaveValue('工作伦理把有纪律的劳动规定为正常生活的核心。')

    await user.clear(titleInput)
    await user.type(titleInput, '劳动定义身份')
    expect(screen.getByTestId('lineage-save-state')).toHaveTextContent('未保存')
    await waitFor(() => expect(screen.getByTestId('lineage-save-state')).toHaveTextContent('已保存'), { timeout: 3000 })
    const saved = await mock.lineageGet(1)
    expect(saved?.graph.nodes.find(n => n.title === '劳动定义身份')?.userEdited).toBe(true)
  })

  it('删除节点自动保存,节点与相连的边一并移除', async () => {
    const user = userEvent.setup()
    render(<LineagePanel bookId={1} />)
    await user.click(await screen.findByRole('button', { name: '生成脉络图到当前进度' }))
    await user.click(await screen.findByText('生产者社会'))
    await user.click(await screen.findByRole('button', { name: '删除节点' }))
    await waitFor(() => expect(screen.queryByText('生产者社会')).not.toBeInTheDocument())
    await waitFor(async () => expect((await mock.lineageGet(1))?.graph.nodes).toHaveLength(1), { timeout: 3000 })
    expect((await mock.lineageGet(1))?.graph.edges).toHaveLength(0)
  })

  it('有手改时「重新生成」先确认;取消保留手改,确定才覆盖', async () => {
    const user = userEvent.setup()
    render(<LineagePanel bookId={1} />)
    await user.click(await screen.findByRole('button', { name: '生成脉络图到当前进度' }))
    await user.click(await screen.findByText('生产者社会'))
    const titleInput = await screen.findByLabelText('节点标题')
    await user.clear(titleInput)
    await user.type(titleInput, '我的改法')
    await waitFor(() => expect(screen.getByTestId('lineage-save-state')).toHaveTextContent('已保存'), { timeout: 3000 })

    await user.click(screen.getByRole('button', { name: '重新生成' }))
    const dialog = await screen.findByRole('alertdialog', { name: '确认重新生成' })
    expect(dialog).toHaveTextContent('1 处')
    await user.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(screen.getByText('我的改法')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '重新生成' }))
    await user.click(await screen.findByRole('button', { name: '确定重新生成' }))
    await waitFor(() => expect(screen.getByText('生产者社会')).toBeInTheDocument())
    expect(screen.queryByText('我的改法')).not.toBeInTheDocument()
  })

  it('读到更后面 →「更新到最新进度」增量补节点并保留手改', async () => {
    const user = userEvent.setup()
    const first = render(<LineagePanel bookId={1} />)
    await user.click(await screen.findByRole('button', { name: '生成脉络图到当前进度' }))
    await user.click(await screen.findByText('生产者社会'))
    const titleInput = await screen.findByLabelText('节点标题')
    await user.clear(titleInput)
    await user.type(titleInput, '劳动定义身份')
    await waitFor(() => expect(screen.getByTestId('lineage-save-state')).toHaveTextContent('已保存'), { timeout: 3000 })
    expect(screen.queryByRole('button', { name: '更新到最新进度' })).not.toBeInTheDocument()
    // 往后读了 → 重开面板(挂载时取图)看到提示与按钮
    mock.lineageBehind = true
    first.unmount()
    render(<LineagePanel bookId={1} />)
    expect(await screen.findByText(/已读到「第三章/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '更新到最新进度' }))
    await waitFor(() => expect(screen.getByText('新穷人')).toBeInTheDocument())
    expect(screen.getByText('劳动定义身份')).toBeInTheDocument() // 手改保留
    expect(screen.queryByRole('button', { name: '更新到最新进度' })).not.toBeInTheDocument()
  })

  it('AI 修正:针对选中节点,改了的节点标手改', async () => {
    const user = userEvent.setup()
    render(<LineagePanel bookId={1} />)
    await user.click(await screen.findByRole('button', { name: '生成脉络图到当前进度' }))
    await user.click(await screen.findByText('消费者社会'))
    await user.click(screen.getByRole('button', { name: /让 AI 按我的理解修正/ }))
    expect(screen.getByText(/针对选中节点「消费者社会」/)).toBeInTheDocument()
    await user.type(screen.getByLabelText('修正要求'), '写得更具体')
    await user.click(screen.getByRole('button', { name: '修正' }))
    await waitFor(() => expect(screen.getByText('消费者社会(修正)')).toBeInTheDocument())
    expect(screen.getByText('生产者社会')).toBeInTheDocument()
  })

  it('详情浮层:看原文跳章、问一问带入问书', async () => {
    const user = userEvent.setup()
    const onGoto = vi.fn()
    const onAsk = vi.fn()
    render(<LineagePanel bookId={1} onGoto={onGoto} onAsk={onAsk} />)
    await user.click(await screen.findByRole('button', { name: '生成脉络图到当前进度' }))
    await user.click(await screen.findByText('生产者社会'))
    const goto = await screen.findByRole('button', { name: /看原文:第一章/ })
    await user.click(goto)
    expect(onGoto).toHaveBeenCalledWith('chap1.xhtml')
    expect(screen.getByText(/所在章节开头的节选/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /问一问这部分/ }))
    expect(onAsk).toHaveBeenCalledWith(expect.stringContaining('生产者社会'))
  })

  it('键盘:方向键按阅读顺序选节点,Esc 取消;缩放按钮改百分比', async () => {
    const user = userEvent.setup()
    render(<LineagePanel bookId={1} />)
    await user.click(await screen.findByRole('button', { name: '生成脉络图到当前进度' }))
    await screen.findByText('生产者社会')
    const canvas = screen.getByTestId('lineage-canvas')
    canvas.focus()
    await user.keyboard('{ArrowRight}')
    expect(await screen.findByRole('dialog', { name: '节点 生产者社会' })).toBeInTheDocument()
    await user.keyboard('{ArrowRight}')
    expect(await screen.findByRole('dialog', { name: '节点 消费者社会' })).toBeInTheDocument()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(screen.getByTestId('lineage-zoom')).toHaveTextContent('100%')
    await user.click(screen.getByRole('button', { name: '缩小' }))
    expect(screen.getByTestId('lineage-zoom')).toHaveTextContent('85%')
  })

  it('无手改时「重新生成」不弹确认', async () => {
    const user = userEvent.setup()
    render(<LineagePanel bookId={1} />)
    await user.click(await screen.findByRole('button', { name: '生成脉络图到当前进度' }))
    await screen.findByText('生产者社会')
    await user.click(screen.getByRole('button', { name: '重新生成' }))
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    await screen.findByText('生产者社会')
  })
})
