import { defineConfig } from '@playwright/test'

// 桌面 E2E(_electron):串行跑——Electron 进程重,并行无收益且userData 隔离目录各自独立。
// 前置:pnpm build(main/preload tsc 产物)+ pnpm build:renderer(vite 产物)——见 package.json test:e2e 串联。
export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  workers: 1,
  retries: 0,
  reporter: [['list']],
})
