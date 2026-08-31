import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as backendModule from '../../backend'
import { MockBackend } from '../../backend/mock'
import type { Backend } from '../../backend/types'
import StatsPage from './StatsPage'

vi.mock('../../backend', () => ({ backend: null as unknown as object }))

beforeEach(() => {
  ;(backendModule as unknown as { backend: Backend }).backend = new MockBackend()
})

describe('统计页', () => {
  it('渲染 stats() 全部指标', async () => {
    render(<StatsPage />)
    expect(await screen.findByText('2/12')).toBeInTheDocument()
    expect(screen.getByTestId('stat-streak')).toHaveTextContent('3')
    expect(screen.getByTestId('stat-minutes')).toHaveTextContent('0')
    expect(screen.getByTestId('stat-weak-open')).toHaveTextContent('1')
    expect(screen.getByTestId('stat-weak-fixed')).toHaveTextContent('1')
  })
})
