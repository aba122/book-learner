import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

// vitest 未开 globals,RTL 的自动 cleanup 不会注册,这里显式挂上
afterEach(cleanup)
