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
