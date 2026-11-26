// 知识地图可选(BL-036)端到端:在 Mac 上用 Playwright 驱动本机 Chrome(无头)访问调试版攻书的 HTTP 服务,走三条新路径:
//   1) 导入 <大书.epub>,在「要生成知识地图吗?」看章数/用时 → 选「暂不生成」→ 书架卡片标「未生成地图」→「阅读」按书打开 /read/<id>
//   2) 书摘页:书名含 <书摘书名片段> 的书(没有知识地图)第一张卡「在书中查看」→ 按书打开阅读器并定位原句
//   3) 导入 <小书.epub>(暂不生成)→ 书架「更多操作 → 生成知识地图」→ 说明用时 → 生成(真 codex)→ 跳 /map/<id>
// 前提:调试版已用数据副本启动,mobile-server.json = 7350 + 令牌 'e2e0'×16(见 ~/Developer/bl-logs/optmap-app-cmd.sh)。
// 用法(Mac):cp 到 web/ 下 → `PATH=/opt/homebrew/bin:$PATH node optional-map-e2e.mjs <大书.epub> <书摘书名片段> <小书.epub>`;
//       截图在 ~/Developer/bl-logs/optmap-shots/。每步打印 `STEPn-OK …` 或 `STEPn-FAILED …`,全过打印 `OPTMAP-ALL-OK`。
import { chromium } from '@playwright/test'
import { mkdirSync } from 'node:fs'

const B = 'http://127.0.0.1:7350'
const TOKEN = 'e2e0'.repeat(16)
const [BIG, EXCERPT_BOOK, SMALL] = process.argv.slice(2)
const OUT = process.env.HOME + '/Developer/bl-logs/optmap-shots'
if (!BIG || !EXCERPT_BOOK || !SMALL) throw new Error('usage: node optional-map-e2e.mjs <big.epub> <excerpt-book-title-part> <small.epub>')
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
let failed = 0
const fail = (step, msg) => {
  failed++
  console.log(`STEP${step}-FAILED ${msg}`)
}

/** 导入并在选择这一步选「暂不生成」;返回 { title, estimate } */
async function importWithoutMap(file, type) {
  await page.goto(B + '/library')
  await page.getByRole('button', { name: '导入书籍' }).click()
  await page.getByLabel(/选择 EPUB 文件/).setInputFiles(file)
  await page.getByRole('button', { name: type }).click()
  const dialog = page.getByRole('dialog', { name: '导入书籍' })
  const started = Date.now()
  await dialog.getByText('要生成知识地图吗?').or(dialog.getByRole('alert')).first().waitFor({ timeout: 5 * 60 * 1000 })
  if (await dialog.getByRole('alert').count()) throw new Error('import failed: ' + (await dialog.getByRole('alert').first().innerText()))
  const estimate = (await dialog.getByTestId('map-estimate').innerText()).trim()
  const subtitle = (await dialog.getByText(/》· /).first().innerText()).trim()
  console.log(`[choice] ${subtitle} | ${estimate}`)
  await page.screenshot({ path: `${OUT}/choice-${type}.png` })
  await dialog.getByRole('button', { name: '暂不生成' }).click()
  await dialog.waitFor({ state: 'hidden' })
  const toast = page.getByText(/^已导入《.+》$/)
  await toast.first().waitFor({ timeout: 15000 })
  const title = (await toast.first().innerText()).replace(/^已导入《|》$/g, '')
  return { title, estimate, secs: Math.round((Date.now() - started) / 1000) }
}

// 1) 大书暂不生成 → 卡片「未生成地图」→ 阅读
try {
  const { title, estimate, secs } = await importWithoutMap(BIG, '人文·社科')
  const card = page.getByRole('article', { name: title })
  await card.getByText('未生成地图').waitFor({ timeout: 10000 })
  await page.screenshot({ path: `${OUT}/shelf.png` })
  await card.getByRole('button', { name: '阅读' }).click()
  await page.waitForURL(/\/read\/\d+/, { timeout: 15000 })
  await page.locator('iframe').first().waitFor({ timeout: 30000 })
  await page.waitForTimeout(3000)
  const heading = (await page.getByRole('toolbar', { name: '阅读器工具栏' }).innerText()).replace(/\s+/g, ' ')
  await page.screenshot({ path: `${OUT}/read-big.png` })
  console.log(`STEP1-OK title=${title} estimate="${estimate}" import_secs=${secs} url=${page.url()} toolbar="${heading.slice(0, 60)}"`)
} catch (e) {
  await page.screenshot({ path: `${OUT}/step1-failed.png` }).catch(() => {})
  fail(1, String(e).slice(0, 300))
}

// 2) 书摘页「在书中查看」(没有知识地图的书)
try {
  await page.goto(B + '/excerpts')
  const region = page.getByRole('region', { name: new RegExp(EXCERPT_BOOK) }).first()
  await region.waitFor({ timeout: 20000 })
  await region.getByRole('button', { name: '在书中查看' }).first().click()
  await page.waitForURL(/\/read\/\d+/, { timeout: 15000 })
  await page.locator('iframe').first().waitFor({ timeout: 30000 })
  await page.waitForTimeout(4000)
  const missed = await page.getByText('没在这一章找到原句的准确位置').count()
  await page.screenshot({ path: `${OUT}/reveal.png` })
  console.log(`STEP2-OK url=${page.url()} exact=${missed === 0}`)
} catch (e) {
  await page.screenshot({ path: `${OUT}/step2-failed.png` }).catch(() => {})
  fail(2, String(e).slice(0, 300))
}

// 3) 小书暂不生成 → 书架补生成(真 codex)
try {
  const { title } = await importWithoutMap(SMALL, '教材')
  await page.getByRole('button', { name: `《${title}》的更多操作` }).click()
  await page.getByRole('menuitem', { name: '生成知识地图' }).click()
  const dialog = page.getByRole('dialog', { name: '生成知识地图' })
  const estimate = (await dialog.getByTestId('map-estimate').innerText({ timeout: 60000 })).trim()
  await page.screenshot({ path: `${OUT}/generate-choice.png` })
  const started = Date.now()
  await dialog.getByRole('button', { name: '生成知识地图' }).click()
  let outcome = null
  while (Date.now() - started < 30 * 60 * 1000) {
    const hit = page.url().match(/\/map\/(\d+)/)
    if (hit) {
      outcome = { ok: true, book: hit[1] }
      break
    }
    if (await dialog.getByRole('alert').count()) {
      outcome = { ok: false, text: (await dialog.getByRole('alert').first().innerText()).replace(/\s+/g, ' ') }
      break
    }
    await page.waitForTimeout(5000)
  }
  const secs = Math.round((Date.now() - started) / 1000)
  await page.waitForTimeout(2000)
  await page.screenshot({ path: `${OUT}/map-later.png` })
  if (outcome?.ok) console.log(`STEP3-OK title=${title} estimate="${estimate}" book=${outcome.book} secs=${secs}`)
  else fail(3, `${outcome ? outcome.text : 'timeout'} secs=${secs}`)
} catch (e) {
  await page.screenshot({ path: `${OUT}/step3-failed.png` }).catch(() => {})
  fail(3, String(e).slice(0, 300))
}

console.log('errors:', errors.length ? errors.slice(0, 5) : 'none')
if (failed === 0) console.log('OPTMAP-ALL-OK')
await browser.close()
process.exit(failed === 0 ? 0 : 1)
