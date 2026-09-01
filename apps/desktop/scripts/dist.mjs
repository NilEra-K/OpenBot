/**
 * 打包入口（P6 Step 1）：统一注入国内镜像 env（已设不覆盖）后串全链构建与 electron-builder。
 * 链序：tsc（类型检查 + workspace 包产物）→ vite renderer → esbuild main/preload 预 bundle
 * （@openbot/* 收进单文件——消解 pnpm workspace 符号链接 + electron-builder 的 node_modules
 * 收集坑，files 白名单只需 dist + resources）→ electron-builder。
 * win nsis/portable 为真机产物；linux/mac target 配置就绪、产物待设备（P6 裁定 A）。
 */
import { spawnSync } from 'node:child_process'

const env = {
  ...process.env,
  // electron 二进制与 builder 工具链（nsis/winCodeSign 等）双镜像——国内网络实测必需（CLAUDE.md 既有经验）
  ELECTRON_MIRROR: process.env.ELECTRON_MIRROR ?? 'https://npmmirror.com/mirrors/electron/',
  ELECTRON_BUILDER_BINARIES_MIRROR:
    process.env.ELECTRON_BUILDER_BINARIES_MIRROR ?? 'https://npmmirror.com/mirrors/electron-builder-binaries/',
}

const steps = [
  ['tsc 全量（类型检查 + workspace 包产物）', ['pnpm', '-w', 'run', 'build']],
  ['renderer 构建（vite）', ['pnpm', 'run', 'build:renderer']],
  ['main 预 bundle（esbuild）', ['pnpm', 'run', 'bundle:main']],
  ['preload 预 bundle（esbuild）', ['pnpm', 'run', 'bundle:preload']],
  ['electron-builder', ['electron-builder', ...process.argv.slice(2)]],
]

for (const [label, command] of steps) {
  console.log(`\n[dist] ${label}`)
  // Windows 下 pnpm/electron-builder 是 .cmd——shell:true 走 cmd，file 需整体字符串
  const r = spawnSync(command.join(' '), { stdio: 'inherit', shell: true, env })
  if (r.status !== 0) {
    console.error(`[dist] 步骤失败（exit ${r.status}）：${label}`)
    process.exit(r.status ?? 1)
  }
}

// 根治（backlog ① 坑⑩）：bundle 覆盖 tsc 的 dist/main/index.js 后，tsbuildinfo 仍认为输出
// 最新（不校验存在性/体量）——下次 tsc 增量跳过、electron 永远加载 bundle 快照。
// 删 tsbuildinfo 强制下次全量重编，恢复开发态。
import { rmSync } from 'node:fs'
rmSync(new URL('../tsconfig.tsbuildinfo', import.meta.url), { force: true })
console.log('[dist] tsbuildinfo 已清——下次 tsc 全量重编 main（防 bundle 产物占位致增量跳过）')
