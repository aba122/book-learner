import { expect, test } from '@playwright/test'

type CfiSmokeResult = {
  href: string
  cfi: string
  restoredText: string
}

declare global {
  interface Window {
    __CFI_SMOKE__?: CfiSmokeResult
  }
}

test('round-trips an EPUB heading through a CFI', async ({ page }) => {
  await page.goto('/cfi-smoke.html')
  await expect(page).toHaveTitle('EPUB CFI smoke')

  await expect
    .poll(() => page.evaluate(() => window.__CFI_SMOKE__ ?? null), { timeout: 5_000 })
    .not.toBeNull()

  const result = await page.evaluate(() => window.__CFI_SMOKE__!)
  console.info('CFI smoke result', result)
  expect(result.href).toBe('chap1.xhtml')
  expect(result.cfi).toMatch(/^epubcfi\(/)
  expect(result.restoredText).toBe('第一章 供给与需求')
})
