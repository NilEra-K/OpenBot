import { defineConfig } from 'vitest/config'

// 根 vitest：内核测试全在 packages/*/test。apps/desktop/e2e 是 Playwright _electron 套件
// （test() 语义不同,vitest 收集即失败）——显式排除,归 `pnpm --filter desktop test:e2e` 跑。
export default defineConfig({
  test: {
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/cypress/**',
      '**/.{idea,git,cache,output,temp}/**',
      '**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build,eslint,prettier}.config.*',
      'apps/desktop/e2e/**',
    ],
  },
})
