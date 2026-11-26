// 导入端到端(BL-035):在 Mac 上用 Playwright 驱动本机 Chrome(无头)访问调试版攻书的 HTTP 服务,
// 走一遍真实的导入向导:选文件 → 选类型 → 上传分块 / 校验 / 抽章节 →「要生成知识地图吗?」选生成(BL-036)→ 生成知识地图(真 codex)→ 跳到地图页。
// 选「暂不生成」的路径见 optional-map-e2e.mjs。
// 前提:调试版已用数据副本启动,mobile-server.json = 7350 + 令牌 'e2e0'×16(见 ~/Developer/bl-logs/batch-app-cmd.sh)。
// 用法(Mac):cp 到 web/ 下 → `PATH=/opt/homebrew/bin:$PATH node import-e2e.mjs <epub 路径> [类型按钮名,默认 人文·社科]`;
//       截图在 ~/Developer/bl-logs/import-shots/。成功打印 `IMPORT-OK book=<id>`,失败打印 `IMPORT-FAILED <提示>` 并退出 1。
// 地图逐章调 codex(每章约 45 s),章节多的书要等很久,所以最多等 90 分钟;浏览器关掉后壳层的地图作业照样跑完。
import { chromium } from '@playwright/test'
import { mkdirSync } from 'node:fs'

const B = 'http://127.0.0.1:7350'
const TOKEN = 'e2e0'.repeat(16)
const FILE = process.argv[2]
const TYPE = process.argv[3] ?? '人文·社科'
const OUT = process.env.HOME + '/Developer/bl-logs/import-shots'
if (!FILE) throw new Error('usage: node import-e2e.mjs <epub> [type]')
mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2, locale: 'zh-CN' })
const pair = await ctx.request.post(B + '/api/pair', { data: { token: TOKEN } })
if (!pair.ok()) throw new Error('pair failed ' + pair.status())
const page = await ctx.newPage()
const errors = []
page.on('pageerror', e => errors.push('pageerror ' + String(e)))
page.on('console', m => {
  if (m.type() === 'error') errors.push('console ' + m.text())
})

await page.goto(B + '/library')
await page.getByRole('button', { name: '导入书籍' }).click()
await page.getByLabel(/选择 EPUB 文件/).setInputFiles(FILE)
await page.getByRole('button', { name: TYPE }).click()
const started = Date.now()
const dialog = page.getByRole('dialog')
// BL-036:抽完章节先问要不要生成地图;导入失败则直接出 alert(下面的循环会接住)
await dialog.getByText('要生成知识地图吗?').or(dialog.getByRole('alert')).first().waitFor({ timeout: 5 * 60 * 1000 })
if (!(await dialog.getByRole('alert').count())) {
  console.log(`[${Math.round((Date.now() - started) / 1000)}s] ${(await dialog.getByTestId('map-estimate').innerText()).trim()}`)
  await dialog.getByRole('button', { name: '生成知识地图' }).click()
}

// 进度文案每 15 s 打一次;成功 = 跳到 /map/<id>,失败 = 对话框里出现 alert
let last = ''
let outcome = null
while (Date.now() - started < 90 * 60 * 1000) {
  const url = page.url()
  const hit = url.match(/\/map\/(\d+)/)
  if (hit) {
    outcome = { ok: true, book: hit[1] }
    break
  }
  const alert = dialog.getByRole('alert')
  if (await alert.count()) {
    outcome = { ok: false, text: (await alert.first().innerText()).replace(/\s+/g, ' ') }
    break
  }
  const progress = (await dialog.locator('p').first().innerText().catch(() => '')).trim()
  if (progress && progress !== last) {
    console.log(`[${Math.round((Date.now() - started) / 1000)}s] ${progress}`)
    last = progress
  }
  await page.waitForTimeout(15000)
}
const secs = Math.round((Date.now() - started) / 1000)
if (outcome?.ok) {
  await page.waitForTimeout(2000)
  await page.screenshot({ path: `${OUT}/map.png` })
  console.log(`IMPORT-OK book=${outcome.book} secs=${secs} url=${page.url()}`)
} else {
  await page.screenshot({ path: `${OUT}/failed.png` })
  console.log(`IMPORT-FAILED ${outcome ? outcome.text : 'timeout'} secs=${secs}`)
}
console.log('errors:', errors.length ? errors.slice(0, 5) : 'none')
await browser.close()
process.exit(outcome?.ok ? 0 : 1)
