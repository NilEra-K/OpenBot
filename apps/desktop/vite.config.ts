/**
 * renderer 构建链（plan-p2 Step 7）：单独 Vite——main/preload 维持纯 tsc，不引入 electron-vite 全家桶。
 * dev：`pnpm dev:renderer` 起 5183（显式端口，占用即失败——遵守 CLAUDE.md 端口规则），
 *      `OPENBOT_RENDERER_URL=http://127.0.0.1:5183 pnpm start` 让 main 加载 dev server（HMR）。
 * build：产物出 dist/renderer，由 main 以文件协议加载（base './' 相对路径）。
 */
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  root: 'src/renderer',
  base: './',
  plugins: [vue()],
  server: { port: 5183, strictPort: true },
  build: { outDir: '../../dist/renderer', emptyOutDir: true },
})
