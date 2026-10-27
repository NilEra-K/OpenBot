import { defineConfig } from '@playwright/test'

// 桌面 E2E(_electron)：用例级并行（2026-10-27 v0.1.94 实测数据推翻旧「串行无收益」裁定——
// 旧裁定对**文件级**并行成立：45 例集中在单文件，workers 只按文件分片，实测 4.7m≈串行 4.5-4.8m；
// fullyParallel 用例级分片后共 4 轮 44 过零 flake：workers=2 → 3.1m×2 轮；workers=4 → 3.1m×2 轮
// ——机器在 ~2 条有效并发饱和，4 档同耗翻倍负载 → 默认 2。临时改档：pnpm exec playwright
// test --workers=1（CLI 原生覆盖，不改本文件）。结构性前提：每用例独立 Electron 实例 +
// mkdtemp userData + 临时端口 mock（无共享态）。
// 前置:pnpm build(main/preload tsc 产物)+ pnpm build:renderer(vite 产物)——见 package.json test:e2e 串联。
export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  workers: 2,
  retries: 0,
  reporter: [['list']],
  fullyParallel: true,
})
