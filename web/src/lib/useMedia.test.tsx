import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { stubMatchMedia } from '../test/media'
import { PHONE_QUERY, useIsPhone } from './useMedia'

function Probe() {
  return <p>{useIsPhone() ? 'phone' : 'desktop'}</p>
}

describe('useIsPhone(BL-032 M3)', () => {
  afterEach(() => vi.unstubAllGlobals())
  it('没有 matchMedia(jsdom)按桌面;命中手机断点为真', () => {
    const { unmount } = render(<Probe />)
    expect(screen.getByText('desktop')).toBeInTheDocument()
    unmount()
    stubMatchMedia([PHONE_QUERY])
    render(<Probe />)
    expect(screen.getByText('phone')).toBeInTheDocument()
  })
})
