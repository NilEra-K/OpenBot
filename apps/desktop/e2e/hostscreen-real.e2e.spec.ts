/**
 * 宿主屏幕真机门控套件（plan-screen-firstclass P9-1，裁定 G）：真实 desktopCapturer 截帧 →
 * HostScreenControl L0/L1 实况流 → 接管注入通道（SendInput 真实注入）的全链实证。
 *
 * 门控：OPENBOT_TEST_HOSTSCREEN=1 才运行（默认跳过——本套件会真实移动/点击你的鼠标）。
 * 隔离纪律：不依赖任何外部设备（宿主屏幕就是目标）；mock 沙箱 + 绑定 host-screen 条目的
 * 独立 agent——不触碰既有容器/SSH 载体。
 * 流畅度记档（纪律 1）：实测 fps 打到 stdout——真机验收时回填 plan-screen-firstclass 分层表。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect, _electron } from '@playwright/test'

test.skip(process.env.OPENBOT_TEST_HOSTSCREEN !== '1', '门控：OPENBOT_TEST_HOSTSCREEN=1 时才跑（会真实注入键鼠——需人在场监督）')

test('宿主屏幕真机全链：注册 → 绑定 → GUI 实况真帧 → 接管注入', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'openbot-e2e-hsreal-'))
  const app = await _electron.launch({
    args: ['.'],
    env: { ...process.env, OPENBOT_USER_DATA: userData, OPENBOT_SANDBOX: 'mock' }, // 无 OPENBOT_COMPUTER——生产门走宿主屏幕条目在场
  })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => console.log('[pageerror]', e.message))
  try {
    await expect(page.locator('.app')).toHaveAttribute('data-connected', 'true', { timeout: 30_000 })

    // —— 注册宿主屏幕条目 ——
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.locator('.settings-nav-item', { hasText: '镜像' }).click()
    await page.getByRole('button', { name: '＋ 添加镜像' }).click()
    await page.locator('label.proto-opt', { hasText: '宿主屏幕' }).click()
    await page.locator('#ifName').fill('本机屏幕')
    await page.getByRole('button', { name: '保存', exact: true }).click()
    await expect(page.locator('.cfg-row[data-image-id="img-1"]')).toBeVisible()
    // 实况档位实测打点（三档如实——L1 ffmpeg / L2 帧泵 / L0 轮询，回填记档依据）
    await page.locator('[data-role="image-test"]').click()
    await expect(page.locator('.cfg-row[data-image-id="img-1"] .chip-success')).toBeVisible({ timeout: 30_000 })
    console.log('[hostscreen-real] 实况档位：', await page.locator('.cfg-row[data-image-id="img-1"] .chip-success').getAttribute('title'))

    // —— 向导绑定（注册即连接——宿主屏幕 attach 零副作用，创建必成功） ——
    await page.getByRole('button', { name: '控制台', exact: true }).click()
    await page.getByRole('button', { name: '＋ 新建 Agent' }).click()
    const card = page.locator('.wiz-card')
    await expect(card).toBeVisible()
    await page.locator('#wizName').fill('维屏')
    await card.getByRole('button', { name: '下一步' }).click()
    await card.locator('.wiz-kv', { hasText: '沙箱镜像' }).locator('select').selectOption('img-1')
    await card.getByRole('button', { name: '下一步' }).click()
    await expect(card.locator('.wiz-body')).toContainText('镜像：本机屏幕')
    await card.getByRole('button', { name: '创建 Agent' }).click()
    await expect(page.locator('.toast', { hasText: '维屏」已创建' })).toBeVisible({ timeout: 15_000 })

    // —— GUI 视图（生产门：宿主屏幕条目在场即注册 computer 工具族——无需 OPENBOT_COMPUTER） ——
    await page.locator('.roster-item', { hasText: '维屏' }).click()
    await expect(page.locator('.gui-toggle')).toBeVisible({ timeout: 10_000 })
    await page.locator('.gui-toggle').click()
    await expect(page.locator('.ctx-screen .gui-screen')).toBeVisible()
    // 真实 desktopCapturer 帧（小屏 = gui.frame 轮询帧源——只断言到达，帧率测不得）：
    const framesOf = async (sel: string): Promise<number> =>
      Number((await page.locator(sel).getAttribute('data-frames')) ?? '0')
    await expect
      .poll(async () => framesOf('.ctx-screen .gui-viewport canvas'), { timeout: 30_000 })
      .toBeGreaterThanOrEqual(2)

    // —— 大屏接管：真实注入通道建立（SendInput）+ 实况流帧续到 ——
    await page.locator('.ctx-screen .gui-viewport').click({ position: { x: 100, y: 60 } }) // 注意：接管点击会真实注入
    await expect(page.locator('.boxops')).toBeVisible()
    await page.locator('.boxops .gui-viewport').click({ position: { x: 80, y: 50 } }) // 真实注入：鼠标移到流对应位置
    await expect(page.locator('.boxops .gui-state.is-takeover')).toContainText('你已接管', { timeout: 10_000 })
    await expect(page.locator('.boxops .gui-screen')).toHaveAttribute('data-stream', '1', { timeout: 10_000 })
    await expect
      .poll(async () => framesOf('.boxops .gui-viewport canvas'), { timeout: 30_000 })
      .toBeGreaterThanOrEqual(2)
    console.log('[hostscreen-real] 接管实况流帧到达——注入通道已在场（SendInput 已派发真实键鼠事件）')
    // 流畅度实测（纪律 1——实测回填依据）：**大屏真流** 5s 窗口帧计数（小屏是 gui.frame
    // 轮询源——首轮验收 0.6fps 实为轮询周期，测不得）
    const f0 = await framesOf('.boxops .gui-viewport canvas')
    await page.waitForTimeout(5_000)
    const f1 = await framesOf('.boxops .gui-viewport canvas')
    const fps = ((f1 - f0) / 5).toFixed(1)
    console.log(`[hostscreen-real] 实况真流帧率实测：${fps} fps（窗口 5s，帧 ${f0}→${f1}）`)

    // —— 交还 agent → 停流 ——
    await page.locator('.boxops').getByRole('button', { name: '交还 agent' }).click()
    await expect(page.locator('.boxops .gui-screen')).toHaveAttribute('data-stream', '0', { timeout: 10_000 })
  } finally {
    await app.close()
    await rm(userData, { recursive: true, force: true }).catch(() => {})
  }
})
