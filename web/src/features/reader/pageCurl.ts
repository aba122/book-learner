/**
 * 纸质卷页几何(BL-010):把一页纸沿一条折线对折——折线是"被抓起的页角 C"与"它当前落点 P"的中垂线。
 * 折过去的那部分(靠 C 的半平面)在屏幕上看到的是纸背,位置是它关于折线的镜像;其余部分仍显示正面。
 * 纯几何,不碰 DOM:给出正面/纸背的 clip-path 多边形、纸背的镜像矩阵、两条沿折线的阴影带。
 * 坐标:页面左上角为原点,x 向右,y 向下,单位 px。
 */
export interface Pt { x: number; y: number }
export interface FoldFrame {
  /** 正面仍可见区域(页面矩形 ∩ 未折半平面) */
  front: Pt[]
  /** 已折过去的区域(页面坐标,尚未镜像);纸背层在自身坐标里按它裁剪,再整体套 matrix */
  flap: Pt[]
  /** 关于折线的镜像变换,CSS `matrix(a,b,c,d,e,f)`,transform-origin 须为 0 0 */
  matrix: [number, number, number, number, number, number]
  /** 折线中点与方向角(弧度,沿折线) */
  mid: Pt
  angle: number
  /** 折线法线(指向已折一侧) */
  normal: Pt
  /** 已折面积占比 0..1,用于按进度调阴影强度 */
  folded: number
}

const rectPolygon = (w: number, h: number): Pt[] => [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }]

/** 用半平面 (p - mid)·n <= 0(keepNegative)或 >= 0 裁剪凸多边形(Sutherland–Hodgman 单边) */
export function clipHalfPlane(poly: Pt[], mid: Pt, n: Pt, keepPositive: boolean): Pt[] {
  const side = (p: Pt) => (p.x - mid.x) * n.x + (p.y - mid.y) * n.y
  const inside = (p: Pt) => (keepPositive ? side(p) >= 0 : side(p) <= 0)
  const out: Pt[] = []
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]
    const b = poly[(i + 1) % poly.length]
    const ia = inside(a)
    const ib = inside(b)
    if (ia) out.push(a)
    if (ia !== ib) {
      const sa = side(a)
      const sb = side(b)
      const t = sa / (sa - sb)
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })
    }
  }
  return out
}

export function polygonArea(poly: Pt[]): number {
  let s = 0
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]
    const b = poly[(i + 1) % poly.length]
    s += a.x * b.y - b.x * a.y
  }
  return Math.abs(s) / 2
}

/** 页角 corner 被抓到 target 时的一帧;target 与 corner 重合(还没动)时返回 null */
export function foldFrame(w: number, h: number, corner: Pt, target: Pt): FoldFrame | null {
  const dx = corner.x - target.x
  const dy = corner.y - target.y
  const len = Math.hypot(dx, dy)
  if (len < 0.5) return null
  const normal = { x: dx / len, y: dy / len }
  const mid = { x: (corner.x + target.x) / 2, y: (corner.y + target.y) / 2 }
  const rect = rectPolygon(w, h)
  const front = clipHalfPlane(rect, mid, normal, false)
  const flap = clipHalfPlane(rect, mid, normal, true)
  // 关于直线 (p - mid)·n = 0 的反射:p' = p - 2((p - mid)·n) n
  const k = 2 * (mid.x * normal.x + mid.y * normal.y)
  const matrix: FoldFrame['matrix'] = [
    1 - 2 * normal.x * normal.x,
    -2 * normal.x * normal.y,
    -2 * normal.x * normal.y,
    1 - 2 * normal.y * normal.y,
    k * normal.x,
    k * normal.y,
  ]
  const angle = Math.atan2(normal.x, -normal.y) // 折线方向 d = (-n.y, n.x)
  return { front, flap, matrix, mid, angle, normal, folded: polygonArea(flap) / (w * h) }
}

/** 向后翻(next):右下角被抓起,沿弧线甩到页面左侧之外;t∈[0,1] */
export function curlTargetNext(w: number, h: number, t: number, lift = 0.55): Pt {
  return { x: w - 2 * w * t, y: h - h * lift * Math.sin(Math.PI * t) }
}
/** 向前翻(prev):左下角被抓起,甩到右侧之外 */
export function curlTargetPrev(w: number, h: number, t: number, lift = 0.55): Pt {
  return { x: 2 * w * t, y: h - h * lift * Math.sin(Math.PI * t) }
}

export const toPolygon = (poly: Pt[]): string =>
  poly.length < 3 ? 'polygon(0 0, 0 0, 0 0)' : `polygon(${poly.map(p => `${p.x.toFixed(2)}px ${p.y.toFixed(2)}px`).join(', ')})`

/** 翻页缓动:起手慢、中段快、落下慢 */
export const easeInOut = (t: number): number => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2)
