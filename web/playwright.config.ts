import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  use: {
    baseURL: 'http://127.0.0.1:1421',
    ...devices['Desktop Chrome'],
  },
  webServer: {
    command: 'pnpm dev --host 127.0.0.1 --port 1421',
    url: 'http://127.0.0.1:1421',
    reuseExistingServer: !process.env.CI,
  },
})
