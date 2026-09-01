/**
 * 打包产物 E2E（plan-p6 Step 2）：_electron.launch(executablePath) 直接打 electron-builder 产物
 * （win-unpacked——与安装后 exe 同一 asar 内容）——验证打包态全链：预 bundle main 起真内核、
 * 环回网关连、renderer 文件协议加载、settings 表单配 mock provider、console 一轮端到端回复。
 * 产物不在场（未跑 pnpm dist / CI）时整文件 skip——不挡常规回归。
 * 与开发态用例同构注入 OPENBOT_USER_DATA（临时目录隔离）+ OPENBOT_SANDBOX=mock。
 */
import { test, expect, _electron } from '@playwright/test'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { startMockOpenAi } from './mock-openai'

// 产物路径：默认 win-unpacked；OPENBOT_PACKAGED_EXE 覆盖（如指向 nsis 安装后的 exe——安装产物同验）
const EXE = process.env.OPENBOT_PACKAGED_EXE
  ? resolve(process.env.OPENBOT_PACKAGED_EXE)
  : join(import.meta.dirname, '..', 'release', 'win-unpacked', 'OpenBot.exe')

test.skip(!existsSync(EXE), '打包产物不在场——先跑 pnpm dist（plan-p6 裁定：win 为唯一真机产物）')

test('打包产物（win-unpacked）：真内核装配 + mock provider 端到端一轮', async () => {
  const mock = await startMockOpenAi([
    // 用户消息 → steward 直答（最小链路：不涉 A2A/Box，专验打包态装配与网关链路）
    { match: (l) => l.role === 'user', text: '打包产物冒烟回复' },
  ])

  const userData = await mkdtemp(join(tmpdir(), 'openbot-e2e-packaged-'))
  const app = await _electron.launch({
    executablePath: EXE,
    env: {
      ...process.env,
      OPENBOT_USER_DATA: userData,
      OPENBOT_SANDBOX: 'mock',
    },
  })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => console.log('[pageerror]', e.message))
  app.process().stdout?.on('data', (d) => console.log('[main]', String(d).trimEnd()))
  app.process().stderr?.on('data', (d) => console.log('[main-err]', String(d).trimEnd()))

  try {
    // 网关连上（打包态 renderer 文件协议加载 + preload 桥 + 环回网关全链）
    await expect(page.locator('.app')).toHaveAttribute('data-connected', 'true', { timeout: 30_000 })

    // settings：表单配 provider（打包态 settings/safeStorage 密文链路同验）
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.getByRole('button', { name: '＋ 添加模型' }).click()
    await page.locator('#pfName').fill('E2E mock')
    await page.locator('#pfUrl').fill(`http://127.0.0.1:${mock.port}/v1`)
    await page.locator('#pfModel').fill('mock-model')
    await page.getByRole('button', { name: '保存', exact: true }).click()
    await page.locator('.cfg-row .btn', { hasText: '设为主力' }).click()

    // console：发消息 → mock 回复到达（打包态 LLM 客户端 fetch 路径）
    await page.getByRole('button', { name: '控制台', exact: true }).click()
    await page.locator('.composer-box input').fill('打包冒烟')
    await page.locator('.composer-box input').press('Enter')
    await expect(page.locator('.m-text', { hasText: '打包产物冒烟回复' })).toBeVisible({ timeout: 30_000 })
  } finally {
    await app.close()
    await mock.close()
    await rm(userData, { recursive: true, force: true })
  }
})
