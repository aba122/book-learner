import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as backendModule from '../../backend'
import { MockBackend } from '../../backend/mock'
import type { Backend } from '../../backend/types'
import type { KnowledgeBlock } from '../../types'
import LibraryPage from './LibraryPage'

vi.mock('../../backend', () => ({ backend: null as unknown as object }))

beforeEach(() => {
  ;(backendModule as unknown as { backend: Backend }).backend = new MockBackend()
})

afterEach(() => {
  vi.restoreAllMocks()
})

function Probe() {
  const loc = useLocation()
  return <div data-testid="loc">{loc.pathname + loc.search}</div>
}

function renderLibrary() {
  return render(
    <MemoryRouter initialEntries={['/library']}>
      <Routes>
        <Route path="/library" element={<LibraryPage />} />
        <Route path="*" element={null} />
      </Routes>
      <Probe />
    </MemoryRouter>,
  )
}

describe('书架页', () => {
  it('渲染种子书与"主攻中"状态徽标', async () => {
    renderLibrary()
    expect(await screen.findByText('微观经济学')).toBeInTheDocument()
    expect(screen.getByText('主攻中')).toBeInTheDocument()
  })

  it('导入向导:上传文件→选"教材"→显示进度→完成跳 /map/:bookId', async () => {
    const user = userEvent.setup()
    let resolveMap!: (v: KnowledgeBlock[]) => void
    vi.spyOn(backendModule.backend, 'generateMap').mockImplementation(
      async (_bookId, onProgress) => {
        onProgress?.('正在解析 EPUB 目录…')
        return new Promise<KnowledgeBlock[]>(res => {
          resolveMap = res
        })
      },
    )
    renderLibrary()
    await user.click(await screen.findByRole('button', { name: '导入书籍' }))

    const input = screen.getByLabelText(/选择 EPUB 文件/)
    await user.upload(input, new File(['epub'], '深度工作.epub', { type: 'application/epub+zip' }))

    await user.click(await screen.findByRole('button', { name: '教材' }))

    expect(await screen.findByText('正在解析 EPUB 目录…')).toBeInTheDocument()

    resolveMap([])
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent('/map/2'))
  })
})
