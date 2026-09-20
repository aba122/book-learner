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

describe('脉络图面板(plan 2026-09-19,第一批)', () => {
  it('空态→生成→节点渲染→点节点改名→保存手改', async () => {
    const user = userEvent.setup()
    render(<LineagePanel bookId={1} />)

    // 空态
    const gen = await screen.findByRole('button', { name: '生成脉络图到当前进度' })

    // 生成 → 出现节点卡片与覆盖进度
    await user.click(gen)
    await waitFor(() => expect(screen.getByText('生产者社会')).toBeInTheDocument())
    expect(screen.getByText('消费者社会')).toBeInTheDocument()
    expect(screen.getByText(/覆盖到第/)).toBeInTheDocument()

    // 点节点 → 详情编辑器,标题回显
    await user.click(screen.getByText('生产者社会'))
    const titleInput = await screen.findByLabelText('节点标题')
    expect(titleInput).toHaveValue('生产者社会')

    // 改名 → 出现「保存手改」
    await user.clear(titleInput)
    await user.type(titleInput, '劳动定义身份')
    const saveBtn = await screen.findByRole('button', { name: '保存手改' })

    // 保存 → 落库、按钮消失、图上标题更新
    await user.click(saveBtn)
    await waitFor(() => expect(screen.queryByRole('button', { name: '保存手改' })).not.toBeInTheDocument())
    expect(screen.getByText('劳动定义身份')).toBeInTheDocument()

    // 落库校验:userEdited 被保留
    const saved = await mock.lineageGet(1)
    expect(saved?.graph.nodes.find(n => n.title === '劳动定义身份')?.userEdited).toBe(true)
  })

  it('删除节点后保存,节点与相连的边一并移除', async () => {
    const user = userEvent.setup()
    render(<LineagePanel bookId={1} />)
    await user.click(await screen.findByRole('button', { name: '生成脉络图到当前进度' }))
    await user.click(await screen.findByText('生产者社会'))
    await user.click(await screen.findByRole('button', { name: '删除节点' }))
    await user.click(await screen.findByRole('button', { name: '保存手改' }))
    await waitFor(() => expect(screen.queryByText('生产者社会')).not.toBeInTheDocument())
    const saved = await mock.lineageGet(1)
    expect(saved?.graph.nodes).toHaveLength(1)
    expect(saved?.graph.edges).toHaveLength(0)
  })
})
