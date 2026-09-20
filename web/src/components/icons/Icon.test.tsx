import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import Icon from './Icon'
import { ICON_PATHS, type IconName, type IconPath } from './paths'

describe('Icon(自绘 SF 风格线性图标)', () => {
  it('无 label 时是装饰:aria-hidden、无 role', () => {
    const { container } = render(<Icon name="bookmark" />)
    const svg = container.querySelector('svg')!
    expect(svg).toHaveAttribute('aria-hidden', 'true')
    expect(svg).not.toHaveAttribute('role')
    expect(svg).toHaveAttribute('data-icon', 'bookmark')
  })

  it('带 label 时是图像:role=img + 可访问名', () => {
    render(<Icon name="mic" label="语音输入" />)
    expect(screen.getByRole('img', { name: '语音输入' })).toBeInTheDocument()
  })

  it('每个图标至少一条 path,笔画不随缩放变粗;实心变体用 currentColor 填充', () => {
    for (const name of Object.keys(ICON_PATHS) as IconName[]) {
      const { container, unmount } = render(<Icon name={name} size={16} />)
      const svg = container.querySelector('svg')!
      const paths = svg.querySelectorAll('path')
      expect(paths.length, name).toBeGreaterThanOrEqual(1)
      expect(paths[0], name).toHaveAttribute('vector-effect', 'non-scaling-stroke')
      expect(svg, name).toHaveAttribute('fill', (ICON_PATHS[name] as IconPath).fill ? 'currentColor' : 'none')
      expect(svg, name).toHaveAttribute('width', '16')
      unmount()
    }
  })
})
