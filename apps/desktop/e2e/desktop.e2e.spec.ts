/**
 * 桌面全链路 E2E（plan-p2 Step 11）：mock openai 端点 + 真内核 Electron——
 * settings 表单配 provider → console 发消息 → steward A2A 派发 → worker Box exec →
 * 出 Box 审批弹窗 → 批准回写 → 最终回复；tasks/graph 视图的数据痕迹。
 * userData 隔离到临时目录（OPENBOT_USER_DATA），测试数据绝不进用户真实数据区。
 */
import { test, expect, _electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startMockOpenAi } from './mock-openai'

test('chat → A2A → box exec + 审批弹窗（全链路）', async () => {
  const mock = await startMockOpenAi([
    // 1. steward 收用户消息 → A2A 派发给 worker1
    {
      match: (l) => l.role === 'user' && !l.content.startsWith('[A2A'),
      toolCalls: [{ id: 'c1', name: 'send_message', args: { toAgentId: 'worker1', text: '列出 /work 目录' } }],
    },
    // 2. worker1 收 A2A（content 前缀 [A2A ]）→ Box 内 exec
    {
      match: (l) => l.role === 'user' && l.content.startsWith('[A2A'),
      toolCalls: [{ id: 'c2', name: 'exec', args: { command: ['ls', '/work'] } }],
    },
    // 3. worker1 收 exec 结果 → 文本完成
    { match: (_l, t) => t === 'exec', text: '目录是空的' },
    // 4. steward 收 send_message 结果 → 出 Box 抓取（触发审批闸门）
    {
      match: (_l, t) => t === 'send_message',
      toolCalls: [{ id: 'c3', name: 'host_fetch', args: { url: 'https://example.com/' } }],
    },
    // 5. steward 收 host_fetch 结果（获批后）→ 最终回复
    { match: (_l, t) => t === 'host_fetch', text: '检查与抓取都完成了' },
  ])

  const userData = await mkdtemp(join(tmpdir(), 'openbot-e2e-'))
  const app = await _electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      OPENBOT_USER_DATA: userData,
      OPENBOT_EXTRA_AGENTS: 'worker1',
      // 沙箱固定 mock：E2E 不依赖宿主 WSL/Docker 环境（确定性；rootfs/探测也不参与断言路径）
      OPENBOT_SANDBOX: 'mock',
    },
  })
  const page = await app.firstWindow()
  page.on('console', (m) => console.log('[page]', m.type(), m.text()))
  page.on('pageerror', (e) => console.log('[pageerror]', e.message))
  app.process().stdout?.on('data', (d) => console.log('[main]', String(d).trimEnd()))
  app.process().stderr?.on('data', (d) => console.log('[main-err]', String(d).trimEnd()))

  try {
    await expect(page.locator('.app')).toHaveAttribute('data-connected', 'true', { timeout: 30_000 })

    // —— settings：表单配置 provider（真实走 v1.settings.* 命令面与 safeStorage 密文链路） ——
    // 侧栏是图标 rail,按钮文字只在 aria-label——按可访问名定位
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.getByRole('button', { name: '＋ 添加模型' }).click()
    await page.locator('#pfName').fill('E2E mock')
    await page.locator('#pfUrl').fill(`http://127.0.0.1:${mock.port}/v1`)
    await page.locator('#pfModel').fill('mock-model')
    await page.getByRole('button', { name: '保存', exact: true }).click()
    await expect(page.locator('.cfg-row', { hasText: 'E2E mock' })).toBeVisible()
    await page.locator('.cfg-row .btn', { hasText: '设为主力' }).click()
    await expect(page.locator('.cfg-row.is-primary', { hasText: 'E2E mock' })).toBeVisible()
    // 沙箱后端：OPENBOT_SANDBOX=mock env 覆盖 → 装配链路落在 mock（不依赖宿主 WSL/Docker）
    await expect(page.locator('.kv', { hasText: '当前后端' })).toContainText('模拟')

    // —— console：发消息 ——
    await page.getByRole('button', { name: '控制台', exact: true }).click()
    await page.locator('.composer-box input').fill('帮我检查工作区并抓取网页')
    await page.locator('.composer-box input').press('Enter')
    // 用户消息气泡（乐观占位已收敛为正式）
    await expect(page.locator('.m.user .m-text', { hasText: '帮我检查工作区并抓取网页' })).toBeVisible({ timeout: 15_000 })

    // A2A 中继行（steward → worker1）；worker 与 steward 并行,轮询等待
    const relay = page.locator('.relay', { hasText: 'worker1' }).first()
    await expect(relay).toBeVisible({ timeout: 30_000 })

    // 审批弹窗（全局遮罩先于其它交互出现——steward 的出 Box 请求与 worker 并行）
    const modal = page.locator('.approval-modal', { hasText: 'host_fetch' })
    await expect(modal).toBeVisible({ timeout: 30_000 })
    await modal.getByRole('button', { name: '批准' }).click()
    await expect(page.locator('.approval-modal')).toHaveCount(0, { timeout: 15_000 })

    // 弹窗关闭后点击中继行跳 worker1 会话：worker 的文本回复 + Box 执行卡（按归属 agent 过滤）
    await relay.click()
    await expect(page.locator('.m-text', { hasText: '目录是空的' })).toBeVisible({ timeout: 30_000 })
    await expect(page.locator('.task .chip', { hasText: '完成' })).toBeVisible({ timeout: 15_000 })

    // steward 最终回复（回管家会话看：点名册管家条目）
    await page.getByRole('button', { name: '控制台', exact: true }).click()
    await page.locator('.roster-item', { hasText: '管家' }).click()
    await expect(page.locator('.m-text', { hasText: '检查与抓取都完成了' }).first()).toBeVisible({ timeout: 30_000 })

    // —— tasks：两个 run 的痕迹（user lane 的 steward + agent lane 的 worker1） ——
    // run 卡描述行显示首条消息摘要（lifecycle queued 事件携带的领域事实）
    await page.getByRole('button', { name: '排程', exact: true }).click()
    await expect(page.locator('.run')).toHaveCount(2, { timeout: 15_000 })
    await expect(page.locator('.run-what', { hasText: '帮我检查工作区' })).toBeVisible()
    await expect(page.locator('.run-what', { hasText: 'A2A steward → worker1' })).toBeVisible()

    // —— graph：无向关系边（user↔steward、steward↔worker1 委派、user↔worker1 完成回复） ——
    await page.getByRole('button', { name: '图谱', exact: true }).click()
    await expect(page.locator('.gedge-g')).toHaveCount(3, { timeout: 15_000 })

    // mock 端点收到的请求数：steward×3 + worker×2（两 agent 共享 provider 的证据）
    expect(mock.requests.length).toBeGreaterThanOrEqual(5)

    // —— 一致性走查素材：五视图截图（带真实数据;目录由 OPENBOT_SHOT_DIR 控制,默认跳过） ——
    const shotDir = process.env.OPENBOT_SHOT_DIR
    if (shotDir) {
      const views: Array<[string, string]> = [
        ['console', '控制台'],
        ['tasks', '排程'],
        ['boxes', 'Box'],
        ['graph', '图谱'],
        ['settings', '设置'],
      ]
      for (const [name, label] of views) {
        await page.getByRole('button', { name: label, exact: true }).click()
        await page.waitForTimeout(400)
        await page.screenshot({ path: join(shotDir, `app-${name}.png`) })
      }
    }
  } finally {
    await app.close()
    await mock.close()
    await rm(userData, { recursive: true, force: true }).catch(() => {})
  }
})
