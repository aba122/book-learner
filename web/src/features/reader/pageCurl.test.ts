import { describe, expect, it } from 'vitest'
import { clipHalfPlane, curlTargetNext, curlTargetPrev, foldFrame, polygonArea, toPolygon } from './pageCurl'

describe('纸质卷页几何(BL-010)', () => {
  it('右下角折到页面中心:折线是中垂线,正面 + 折片面积守恒,折片镜像后落在未折一侧', () => {
    const f = foldFrame(400, 600, { x: 400, y: 600 }, { x: 200, y: 300 })!
    expect(f.mid).toEqual({ x: 300, y: 450 })
    expect(polygonArea(f.front) + polygonArea(f.flap)).toBeCloseTo(400 * 600, 3)
    expect(f.folded).toBeGreaterThan(0)
    // 角点 C 经镜像矩阵落到 P
    const [a, b, c, d, e, g] = f.matrix
    const px = a * 400 + c * 600 + e
    const py = b * 400 + d * 600 + g
    expect(px).toBeCloseTo(200, 6)
    expect(py).toBeCloseTo(300, 6)
    // 折线上的点镜像后不动
    const mx = a * f.mid.x + c * f.mid.y + e
    const my = b * f.mid.x + d * f.mid.y + g
    expect(mx).toBeCloseTo(f.mid.x, 6)
    expect(my).toBeCloseTo(f.mid.y, 6)
  })

  it('没动(target=corner)返回 null;整页折过去时正面为空、folded≈1', () => {
    expect(foldFrame(400, 600, { x: 400, y: 600 }, { x: 400, y: 600 })).toBeNull()
    const f = foldFrame(400, 600, { x: 400, y: 600 }, { x: -400, y: 600 })!
    expect(polygonArea(f.front)).toBeCloseTo(0, 6)
    expect(f.folded).toBeCloseTo(1, 6)
    expect(toPolygon([])).toBe('polygon(0 0, 0 0, 0 0)')
    expect(toPolygon(f.flap)).toMatch(/^polygon\(.*px\)$/)
  })

  it('半平面裁剪:垂直折线 x=100 把 400×600 矩形切成两块', () => {
    const rect = [{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 600 }, { x: 0, y: 600 }]
    const left = clipHalfPlane(rect, { x: 100, y: 0 }, { x: 1, y: 0 }, false)
    const right = clipHalfPlane(rect, { x: 100, y: 0 }, { x: 1, y: 0 }, true)
    expect(polygonArea(left)).toBeCloseTo(100 * 600, 6)
    expect(polygonArea(right)).toBeCloseTo(300 * 600, 6)
  })

  it('轨迹:next 从右下角出发甩到左侧页外,prev 镜像;中途有抬升', () => {
    expect(curlTargetNext(400, 600, 0)).toEqual({ x: 400, y: 600 })
    expect(curlTargetNext(400, 600, 1).x).toBeCloseTo(-400, 6)
    expect(curlTargetNext(400, 600, 0.5).y).toBeLessThan(600)
    expect(curlTargetPrev(400, 600, 0)).toEqual({ x: 0, y: 600 })
    expect(curlTargetPrev(400, 600, 1).x).toBeCloseTo(800, 6)
    // 单调折进去:面积随 t 递增
    const areas = [0.1, 0.3, 0.5, 0.7, 0.9].map(t => foldFrame(400, 600, { x: 400, y: 600 }, curlTargetNext(400, 600, t))!.folded)
    for (let i = 1; i < areas.length; i++) expect(areas[i]).toBeGreaterThan(areas[i - 1])
  })
})
