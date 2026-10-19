// BL-032 手机访问端到端:在 Mac 上用 Playwright 驱动本机 Chrome(无头,iPhone 尺寸)访问攻书的 HTTP 服务。
// 前提:调试版已用数据副本启动,`<数据目录>/mobile-server.json` = {enabled:true, port:7350, bind:loopback, token:'e2e0'×16}。
// 用法(Mac):cp 到 web/ 下 → `PATH=/opt/homebrew/bin:$PATH node mobile-e2e.mjs`;截图在 ~/Developer/bl-logs/mobile-shots/。
// 覆盖:配对(M2)、HTTP 加载封面与 EPUB(M2)、手机布局——标签栏、无横向溢出、动作单(M3)。
// Mac 的 sshd 禁止端口转发,Linux 端连不到 Mac 的 127.0.0.1,所以浏览器必须在 Mac 上跑。
import { chromium } from '@playwright/test'
import { mkdirSync } from 'node:fs'
const B = 'http://127.0.0.1:7350'
const TOKEN = 'e2e0'.repeat(16)
const OUT = process.env.HOME + '/Developer/bl-logs/mobile-shots'
mkdirSync(OUT, { recursive: true })
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'zh-CN' }
const errors = []
const watch = page => {
  page.on('pageerror', e => errors.push('pageerror ' + String(e)))
  page.on('console', m => { if (m.type() === 'error') errors.push('console ' + m.text()) })
}
const log = (...a) => console.log(...a)

// 1. 未配对 → 配对页;粘贴令牌 → 进 app
const ctx = await browser.newContext(phone)
const page = await ctx.newPage(); watch(page)
await page.goto(B + '/')
log('runtime meta:', await page.locator('meta[name="bl-runtime"]').getAttribute('content'))
await page.getByLabel('配对令牌').waitFor({ timeout: 15000 })
await page.screenshot({ path: OUT + '/1-pairing.png' })
await page.getByLabel('配对令牌').fill('nope')
await page.getByRole('button', { name: '连接' }).click()
log('wrong token alert:', await page.getByRole('alert').innerText())
await page.getByLabel('配对令牌').fill(TOKEN)
await page.getByRole('button', { name: '连接' }).click()
await page.getByRole('navigation', { name: '主导航' }).waitFor({ timeout: 15000 })
await page.waitForTimeout(1200)
log('today h1:', await page.locator('h1').first().innerText().catch(() => '?'))
await page.screenshot({ path: OUT + '/2-today.png' })

// 2. 书架:封面经 /files
await page.goto(B + '/library')
await page.getByRole('heading', { level: 1, name: '书架' }).waitFor({ timeout: 15000 })
await page.waitForTimeout(1500)
const covers = await page.evaluate(() => [...document.querySelectorAll('img[data-testid="book-cover"]')].map(i => [i.getAttribute('src'), i.naturalWidth]))
log('covers:', JSON.stringify(covers.slice(0, 4)))
await page.screenshot({ path: OUT + '/3-library.png' })

// 3. 阅读器:EPUB 经 /files 加载进 epub.js
const readBtn = page.getByRole('button', { name: '阅读' }).first()
await readBtn.click()
await page.waitForURL(/\/reader\//, { timeout: 15000 })
let textLen = 0
for (let i = 0; i < 30 && textLen < 50; i++) {
  await page.waitForTimeout(500)
  textLen = await page.evaluate(() => {
    const f = document.querySelector('iframe')
    return f?.contentDocument?.body?.innerText?.length ?? 0
  })
}
log('reader url:', page.url().replace(B, ''), 'iframe text length:', textLen)
await page.screenshot({ path: OUT + '/4-reader.png' })

// 4. 设置:手机上只读
await page.goto(B + '/settings')
const section = page.getByRole('region', { name: '手机访问' })
await section.waitFor({ timeout: 15000 })
log('settings mobile:', await section.getByTestId('mobile-remote').innerText())

// 5. 手机布局(M3):底部标签栏、没有侧栏、没有横向溢出;「更多操作」是贴底动作单
for (const path of ['/', '/library', '/settings', '/stats']) {
  await page.goto(B + path)
  await page.getByRole('navigation', { name: '主导航' }).waitFor({ timeout: 15000 })
  await page.waitForTimeout(1500)
  const tabs = await page.getByRole('navigation', { name: '主导航' }).getByRole('link').count()
  const scrollW = await page.evaluate(() => document.documentElement.scrollWidth)
  log(`layout ${path}: tabs ${tabs} aside ${await page.locator('aside').count()} scrollWidth ${scrollW}`)
  await page.screenshot({ path: OUT + `/5-layout${path.replaceAll('/', '-')}.png`, fullPage: false })
}
await page.goto(B + '/library')
await page.getByRole('button', { name: /的更多操作$/ }).first().click({ timeout: 15000 })
const sheet = await page.getByRole('menu').boundingBox()
log('action sheet: bottom-aligned', sheet && sheet.y > 844 / 2, 'width', Math.round(sheet?.width ?? 0))
await page.screenshot({ path: OUT + '/5-action-sheet.png' })
await page.getByRole('button', { name: '取消' }).click()

// 6. 新会话扫码地址:#pair= 直接配好,片段被清掉
const ctx2 = await browser.newContext(phone)
const p2 = await ctx2.newPage(); watch(p2)
await p2.goto(B + '/#pair=' + TOKEN)
await p2.getByRole('navigation', { name: '主导航' }).waitFor({ timeout: 15000 })
log('qr flow ok, hash after:', JSON.stringify(await p2.evaluate(() => location.hash)))

// 7. 失效的扫码地址 → 配对页带原因
const ctx3 = await browser.newContext(phone)
const p3 = await ctx3.newPage(); watch(p3)
await p3.goto(B + '/#pair=' + 'ff'.repeat(32))
await p3.getByLabel('配对令牌').waitFor({ timeout: 15000 })
log('stale qr alert:', await p3.getByRole('alert').innerText())

log('errors:', JSON.stringify(errors.filter(e => !e.includes('favicon')).slice(0, 8)))
await browser.close()
