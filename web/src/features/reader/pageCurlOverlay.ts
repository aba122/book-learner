/**
 * 卷页翻页的 DOM 层(BL-010):
 * 1. snapshotVisiblePage:把 epub.js 当前可见的正文 iframe 文档整个克隆成 HTML(含 epub.js 注入的主题样式、分栏样式),
 *    记下它相对可视区的位置与滚动量;
 * 2. createCurlOverlay:在阅读器上盖三层——正面(快照,裁成未折区域)、纸背(同一快照的镜像,裁成已折区域,透字很淡)、
 *    以及两条沿折线的阴影带;真正的 rendition.next/prev 在快照就绪后立刻执行,新页在底下露出来。
 * 几何全部来自 pageCurl.ts。
 */
import { curlTargetNext, curlTargetPrev, easeInOut, foldFrame, polygonArea, toPolygon, type FoldFrame } from './pageCurl'

export interface PageSnapshot {
  html: string
  width: number
  height: number
  left: number
  top: number
  scrollX: number
  scrollY: number
  /** 正文 body 的背景色(纸色),取不到为空 */
  sheet: string
}

type ContentsLike = { document?: Document | null }

/** rendition.getContents() 里落在可视区内的那个正文 iframe(分页模式通常只有一个) */
export function findVisibleFrame(contents: unknown, viewport: HTMLElement): { doc: Document; win: Window; frame: HTMLElement } | null {
  const list: ContentsLike[] = Array.isArray(contents) ? (contents as ContentsLike[]) : contents ? [contents as ContentsLike] : []
  const vr = viewport.getBoundingClientRect()
  if (vr.width <= 0 || vr.height <= 0) return null
  for (const c of list) {
    const doc = c?.document
    const win = doc?.defaultView
    const frame = win?.frameElement as HTMLElement | null | undefined
    if (!doc || !win || !frame || !doc.documentElement) continue
    const r = frame.getBoundingClientRect()
    if (r.width <= 0 || r.right <= vr.left || r.left >= vr.right) continue
    return { doc, win, frame }
  }
  return null
}

export function snapshotVisiblePage(rendition: { getContents?: () => unknown }, viewport: HTMLElement): PageSnapshot | null {
  const found = findVisibleFrame(rendition.getContents?.(), viewport)
  if (!found) return null
  const { doc, win, frame } = found
  const vr = viewport.getBoundingClientRect()
  const r = frame.getBoundingClientRect()
  let sheet = ''
  try {
    const bg = win.getComputedStyle(doc.body).backgroundColor
    if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') sheet = bg
  } catch {
    /* 取不到就用默认纸色 */
  }
  return {
    html: `<!DOCTYPE html>${doc.documentElement.outerHTML}`,
    width: r.width,
    height: r.height,
    left: r.left - vr.left,
    top: r.top - vr.top,
    scrollX: win.scrollX || 0,
    scrollY: win.scrollY || 0,
    sheet,
  }
}

export interface CurlOverlay {
  /** 两层快照都加载完(或超时)后 resolve */
  ready: Promise<void>
  animate: (direction: 'next' | 'prev', mode: 'single' | 'spread', durationMs: number, lift: number) => Promise<void>
  destroy: () => void
}

const raf = (cb: (now: number) => void): number =>
  typeof requestAnimationFrame === 'function' ? requestAnimationFrame(cb) : (setTimeout(() => cb(performance.now()), 16) as unknown as number)
const cancelRaf = (id: number) => {
  if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(id)
  else clearTimeout(id)
}

function loadOf(frame: HTMLIFrameElement): Promise<void> {
  return new Promise(resolve => frame.addEventListener('load', () => resolve(), { once: true }))
}

/** 沿折线的阴影带:放在折线的 side 一侧,靠折线的边最深 */
function placeStrip(el: HTMLElement, f: FoldFrame, side: 1 | -1, depth: number, alpha: number) {
  const L = 6000
  const cx = f.mid.x + f.normal.x * side * depth / 2
  const cy = f.mid.y + f.normal.y * side * depth / 2
  el.style.width = `${L}px`
  el.style.height = `${depth}px`
  el.style.transform = `translate(${cx - L / 2}px, ${cy - depth / 2}px) rotate(${f.angle}rad)`
  // strip 的局部 +y 方向 = -normal:side=+1(折片侧)时折线在底边,side=-1 时在顶边
  el.style.background = side > 0
    ? `linear-gradient(to top, rgba(0,0,0,${alpha}), rgba(0,0,0,${alpha * 0.35}) 35%, rgba(0,0,0,0) 100%)`
    : `linear-gradient(to bottom, rgba(0,0,0,${alpha}), rgba(0,0,0,0) 100%)`
}

export function createCurlOverlay(host: HTMLElement, snap: PageSnapshot, snapshotMaxMs: number): CurlOverlay {
  const doc = host.ownerDocument
  const root = doc.createElement('div')
  root.className = 'bl-curl'
  root.setAttribute('data-testid', 'page-curl')
  const sheetColor = snap.sheet || 'var(--reader-paper-bg, #fdfaf2)'

  const mkLayer = (cls: string) => {
    const layer = doc.createElement('div')
    layer.className = `bl-curl-layer ${cls}`
    const sheet = doc.createElement('div')
    sheet.className = 'bl-curl-sheet'
    sheet.style.background = sheetColor
    const frame = doc.createElement('iframe')
    frame.setAttribute('sandbox', 'allow-same-origin')
    frame.setAttribute('aria-hidden', 'true')
    frame.tabIndex = -1
    frame.style.left = `${snap.left}px`
    frame.style.top = `${snap.top}px`
    frame.style.width = `${snap.width}px`
    frame.style.height = `${snap.height}px`
    const strip = doc.createElement('div')
    strip.className = 'bl-curl-strip'
    layer.append(sheet, frame, strip)
    return { layer, frame, strip }
  }
  const front = mkLayer('bl-curl-front')
  const flap = mkLayer('bl-curl-flap')
  root.append(front.layer, flap.layer)
  // 初始:正面盖满、纸背为空,先挂上再赋 srcdoc,load 事件才可靠
  front.layer.style.clipPath = 'none'
  flap.layer.style.clipPath = 'polygon(0 0, 0 0, 0 0)'
  host.appendChild(root)
  const loads = Promise.all([loadOf(front.frame), loadOf(flap.frame)]).then(() => undefined)
  front.frame.srcdoc = snap.html
  flap.frame.srcdoc = snap.html
  const ready = Promise.race([loads, new Promise<void>(resolve => setTimeout(resolve, snapshotMaxMs))]).then(() => {
    for (const f of [front.frame, flap.frame]) {
      try {
        f.contentWindow?.scrollTo(snap.scrollX, snap.scrollY)
      } catch {
        /* 跨域或未加载时忽略 */
      }
    }
  })

  let frameId: number | null = null
  let destroyed = false
  const animate: CurlOverlay['animate'] = (direction, mode, durationMs, lift) =>
    new Promise<void>(resolve => {
      if (destroyed) return resolve()
      const w = root.clientWidth || host.clientWidth
      const h = root.clientHeight || host.clientHeight
      // 单页:折片落到页外(书脊在页缘外);双页:落到对面那页(书脊在中线)
      const spineX = mode === 'spread' ? w / 2 : direction === 'next' ? 0 : w
      const corner = direction === 'next' ? { x: w, y: h } : { x: 0, y: h }
      const target = (t: number) => {
        const base = direction === 'next' ? curlTargetNext(w, h, t, lift) : curlTargetPrev(w, h, t, lift)
        // 轨迹终点按书脊位置缩放:单页终点在页外一整页,双页终点在对面页缘
        const endX = direction === 'next' ? 2 * spineX - w : 2 * spineX
        const startX = corner.x
        return { x: startX + (endX - startX) * t, y: base.y }
      }
      const paint = (t: number) => {
        const f = foldFrame(w, h, corner, target(t))
        if (!f) {
          front.layer.style.clipPath = 'none'
          flap.layer.style.clipPath = 'polygon(0 0, 0 0, 0 0)'
          return
        }
        const progress = polygonArea(f.flap) / (w * h)
        front.layer.style.clipPath = toPolygon(f.front)
        flap.layer.style.clipPath = toPolygon(f.flap)
        flap.layer.style.transform = `matrix(${f.matrix.map(v => v.toFixed(5)).join(',')})`
        const k = Math.sin(Math.PI * Math.min(1, progress * 1.15))
        placeStrip(flap.strip, f, 1, 90 + 60 * k, 0.22 + 0.16 * k)
        placeStrip(front.strip, f, -1, 70 + 50 * k, 0.16 + 0.14 * k)
      }
      const t0 = performance.now()
      paint(0)
      const step = (now: number) => {
        if (destroyed) return resolve()
        const t = Math.min(1, (now - t0) / durationMs)
        paint(easeInOut(t))
        if (t < 1) frameId = raf(step)
        else {
          frameId = null
          resolve()
        }
      }
      frameId = raf(step)
    })

  const destroy = () => {
    destroyed = true
    if (frameId !== null) cancelRaf(frameId)
    frameId = null
    root.remove()
  }
  return { ready, animate, destroy }
}
