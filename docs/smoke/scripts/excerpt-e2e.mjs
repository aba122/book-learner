// BL-034 书摘端到端:在 Mac 上用 Playwright 驱动本机 Chrome(无头)访问调试版攻书的 HTTP 服务。
// 前提:调试版已用数据副本启动(~/Developer/bl-logs/excerpt-app-cmd.sh:mobile-server.json = 7350 + 令牌 'e2e0'×16),
//       且至少一本书的书摘已由真 codex 整理完(curl POST /api/excerpt_generate 入队,后台线程跑完)。
// 用法(Mac):cp 到 web/ 下 → `PATH=/opt/homebrew/bin:$PATH node excerpt-e2e.mjs`;截图在 ~/Developer/bl-logs/excerpt-shots/。
// 覆盖:书摘页(桌面 日/夜、作者视图、悬停动作)、「在书中查看」用真 EPUB 定位并闪烁、阅读器「存为书摘」、手机布局与动作单。
import { chromium } from '@playwright/test'
import { mkdirSync } from 'node:fs'

const B = 'http://127.0.0.1:7350'
const TOKEN = 'e2e0'.repeat(16)
const OUT = process.env.HOME + '/Developer/bl-logs/excerpt-shots'
mkdirSync(OUT, { recursive: true })
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const errors = []
const log = (...a) => console.log(...a)

async function open(viewport, theme, extra = {}) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2, locale: 'zh-CN', colorScheme: theme, ...extra })
  await ctx.addInitScript(t => {
    try {
      localStorage.setItem('bookLearner.theme', t)
      localStorage.removeItem('bookLearner.excerptAuthor')
    } catch {
      /* 无痕时忽略 */
    }
  }, theme)
  const pair = await ctx.request.post(B + '/api/pair', { data: { token: TOKEN } })
  if (!pair.ok()) throw new Error('pair failed ' + pair.status())
  const page = await ctx.newPage()
  page.on('pageerror', e => errors.push('pageerror ' + String(e)))
  page.on('console', m => {
    if (m.type() === 'error') errors.push('console ' + m.text())
  })
  return { ctx, page }
}

async function waitReaderText(page) {
  let len = 0
  for (let i = 0; i < 40 && len < 50; i++) {
    await page.waitForTimeout(500)
    len = await page.evaluate(() => document.querySelector('iframe')?.contentDocument?.body?.innerText?.length ?? 0)
  }
  return len
}

const desktop = { width: 1280, height: 860 }

// 1. 全部书摘(日 / 夜)
for (const theme of ['light', 'dark']) {
  const { ctx, page } = await open(desktop, theme)
  await page.goto(B + '/excerpts')
  await page.locator('[data-testid="excerpt-card"]').first().waitFor({ timeout: 20000 })
  await page.waitForTimeout(1000)
  log(`all-${theme}: cards=${await page.locator('[data-testid="excerpt-card"]').count()} h-overflow=${await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)}`)
  await page.screenshot({ path: `${OUT}/1-all-${theme}.png` })
  await ctx.close()
}

// 2. 作者视图 → 悬停 → 在书中查看(真 EPUB 定位 + 闪烁)→ 阅读器里存为书摘
{
  const { ctx, page } = await open(desktop, 'light')
  await page.goto(B + '/excerpts')
  await page.locator('[data-testid="excerpt-card"]').first().waitFor({ timeout: 20000 })
  const nav = page.getByRole('navigation', { name: '作者' })
  log('authors:', JSON.stringify(await nav.getByRole('button').allInnerTexts()))
  await nav.getByRole('button').nth(1).click()
  await page.waitForTimeout(800)
  log('author h1:', await page.locator('h1').first().innerText())
  await page.screenshot({ path: `${OUT}/2-author.png` })
  const card = page.locator('[data-testid="excerpt-card"]').nth(2)
  await card.scrollIntoViewIfNeeded()
  await card.hover()
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${OUT}/3-hover.png` })
  const quote = await card.locator('blockquote').innerText()
  await card.getByRole('button', { name: '在书中查看' }).click()
  await page.waitForURL(/\/reader\//, { timeout: 15000 })
  const len = await waitReaderText(page)
  let flash = 0
  for (let i = 0; i < 10 && flash === 0; i++) {
    await page.waitForTimeout(300)
    flash = await page.evaluate(() => document.querySelectorAll('.bl-flash').length)
  }
  await page.waitForTimeout(300)
  await page.screenshot({ path: `${OUT}/4-reveal.png` })
  const notFound = await page.getByText('没在这一章找到原句的准确位置').count()
  log(`reveal: quote="${quote.slice(0, 24)}…" iframe-text=${len} flash-marks=${flash} not-found-toast=${notFound}`)

  // 在正文里程序化选中一段(指针层造选区的结果同样落在 iframe 的 getSelection 上,EpubView 每 300 ms 轮询)
  const picked = await page.evaluate(() => {
    const doc = document.querySelector('iframe')?.contentDocument
    if (!doc) return ''
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT)
    let node = walker.nextNode()
    while (node && node.textContent.trim().length < 40) node = walker.nextNode()
    if (!node) return ''
    const start = node.textContent.search(/\S/)
    const range = doc.createRange()
    range.setStart(node, start)
    range.setEnd(node, Math.min(node.textContent.length, start + 28))
    const sel = doc.getSelection()
    sel.removeAllRanges()
    sel.addRange(range)
    return range.toString()
  })
  const toolbar = page.getByRole('toolbar', { name: '选区操作' })
  await toolbar.waitFor({ timeout: 6000 })
  await page.screenshot({ path: `${OUT}/5-toolbar.png` })
  await toolbar.getByRole('button', { name: '存为书摘' }).click()
  const status = page.getByRole('status').filter({ hasText: '书摘' }).first()
  await status.waitFor({ timeout: 8000 })
  log(`save: picked="${picked}" toast="${(await status.innerText()).replace(/\n/g, ' | ')}"`)
  await page.screenshot({ path: `${OUT}/6-saved.png` })
  await ctx.close()
}

// 3. 手机:作者标签横滑、单列卡片、「⋯」动作单
{
  const { ctx, page } = await open({ width: 390, height: 844 }, 'light', { isMobile: true, hasTouch: true })
  await page.goto(B + '/excerpts')
  await page.locator('[data-testid="excerpt-card"]').first().waitFor({ timeout: 20000 })
  await page.waitForTimeout(800)
  log(`phone: h-overflow=${await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)}`)
  await page.screenshot({ path: `${OUT}/7-phone.png` })
  await page.locator('[data-testid="excerpt-card"]').first().getByRole('button', { name: '这条书摘的更多操作' }).click()
  await page.waitForTimeout(500)
  await page.screenshot({ path: `${OUT}/8-phone-sheet.png` })
  await ctx.close()
}

log('errors:', errors.length ? JSON.stringify(errors.slice(0, 6)) : 'none')
await browser.close()
