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

    // —— ctx 任意时刻接管（P3 对齐）：无 exec 史（steward 会话、IDLE 屏）也可点开操作台——
    // boxId 来自 roster 事实（v1.system.listAgents 返回项），不依赖执行史
    await expect(page.locator('.ctx-screen')).toContainText('等待任务派发', { timeout: 15_000 })
    await expect(page.locator('.cs-hint')).toContainText('点击进入 Box 操作台')
    await page.getByRole('button', { name: /^进入 box-\d+ 操作台$/ }).click()
    await expect(page.locator('.boxops .bo-title')).toHaveText(/^box-\d+$/)
    await page.locator('.boxops').getByRole('button', { name: '返回' }).click()
    await expect(page.locator('.boxops')).toHaveCount(0)

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

    // —— 对话流聚合（P3 调整）：worker1 会话——思考块在流内（llm 增量全部轮次留痕），
    // task 卡内嵌输出区（$ 命令行 + mock 输出一体），ctx 右栏纯化为一块显示器 ——
    await expect(page.locator('.think', { hasText: '目录是空的' })).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('.task .bt-line', { hasText: '$ ls /work' })).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('.task .bt-line', { hasText: 'mock: ls /work' })).toBeVisible()
    const screen = page.locator('.ctx-screen')
    await expect(screen.filter({ hasText: '$ ls /work' })).toBeVisible()
    await expect(screen.filter({ hasText: 'mock: ls /work' })).toBeVisible()

    // —— Box 操作台：PTY 交互终端（mock 回显假终端）——点屏幕进入，键入回显，返回关闭即杀会话 ——
    await page.getByRole('button', { name: /^进入 box-\d+ 操作台$/ }).click()
    const ops = page.locator('.boxops')
    await expect(ops.locator('.bo-title')).toHaveText(/^box-\d+$/)
    await expect(ops.locator('.xterm')).toBeVisible({ timeout: 15_000 })
    // 开场提示经完整链路到达：backend mock → ShellService pty 流 → WS → term.write
    await expect(ops.locator('.bterm')).toContainText('mock shell', { timeout: 15_000 })
    await ops.locator('.bterm').click()
    await page.keyboard.type('echo OPENBOT_PTY\r')
    await expect(ops.locator('.bterm')).toContainText('mock: echo OPENBOT_PTY', { timeout: 15_000 })
    await ops.getByRole('button', { name: '返回' }).click()
    await expect(ops).toHaveCount(0)

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

    // —— 重启恢复（过程事实持久）：第二次启动同 userData——thinking/exec 记录经 loadHistory
    // 恢复为流块/exec 卡投影，worker1 会话的思考块与执行输出仍在（实况断线不补的事实对照闭环） ——
    await app.close()
    const app2 = await _electron.launch({
      args: ['.'],
      env: {
        ...process.env,
        OPENBOT_USER_DATA: userData,
        OPENBOT_EXTRA_AGENTS: 'worker1',
        OPENBOT_SANDBOX: 'mock',
      },
    })
    const page2 = await app2.firstWindow()
    try {
      await expect(page2.locator('.app')).toHaveAttribute('data-connected', 'true', { timeout: 30_000 })
      await page2.locator('.roster-item', { hasText: 'worker1' }).click()
      await expect(page2.locator('.think', { hasText: '目录是空的' })).toBeVisible({ timeout: 15_000 })
      await expect(page2.locator('.task .bt-line', { hasText: '$ ls /work' })).toBeVisible({ timeout: 15_000 })
      await expect(page2.locator('.task .bt-line', { hasText: 'mock: ls /work' })).toBeVisible()
      // ctx 屏幕同步恢复（伪流块走同一渲染路径——任意时刻接管不受重启影响）
      const screen2 = page2.locator('.ctx-screen')
      await expect(screen2.filter({ hasText: '$ ls /work' })).toBeVisible()
    } finally {
      await app2.close()
    }

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

test('中止工作中的 agent（审批挂起中打断：run aborted 收敛 + 未决审批作废）', async () => {
  const mock = await startMockOpenAi([
    // 1. steward 收用户消息 → 出 Box 抓取：触发审批闸门——run 挂起等决议（中止的稳定活跃窗口）
    {
      match: (l) => l.role === 'user' && !l.content.startsWith('[A2A'),
      toolCalls: [{ id: 'c1', name: 'host_fetch', args: { url: 'https://example.com/' } }],
    },
    // 2. 审批后的终答步——中止后不应被消费（llm 第二轮不发起的对照）
    { match: (_l, t) => t === 'host_fetch', text: '不该走到这里' },
  ])

  const userData = await mkdtemp(join(tmpdir(), 'openbot-e2e-cancel-'))
  const app = await _electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      OPENBOT_USER_DATA: userData,
      OPENBOT_SANDBOX: 'mock',
    },
  })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => console.log('[pageerror]', e.message))

  try {
    await expect(page.locator('.app')).toHaveAttribute('data-connected', 'true', { timeout: 30_000 })

    // settings：配置 provider（mock 端点）
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.getByRole('button', { name: '＋ 添加模型' }).click()
    await page.locator('#pfName').fill('E2E mock')
    await page.locator('#pfUrl').fill(`http://127.0.0.1:${mock.port}/v1`)
    await page.locator('#pfModel').fill('mock-model')
    await page.getByRole('button', { name: '保存', exact: true }).click()
    await page.locator('.cfg-row .btn', { hasText: '设为主力' }).click()

    // console：发消息 → run 进入审批挂起（弹窗出现即稳定窗口，等多久都在「工作中」）
    await page.getByRole('button', { name: '控制台', exact: true }).click()
    await page.locator('.composer-box input').fill('抓个网页')
    await page.locator('.composer-box input').press('Enter')
    const modal = page.locator('.approval-modal', { hasText: 'host_fetch' })
    await expect(modal).toBeVisible({ timeout: 30_000 })

    // 进行中单元：工作中… + 中止入口。弹窗先「稍后处理」藏掉（模态 scrim 盖住会话层；
    // run 仍挂起——内核挂起不受渲染局部态影响，中止窗口稳定）
    await modal.getByRole('button', { name: '稍后处理' }).click()
    await expect(page.locator('.approval-modal')).toHaveCount(0)
    const stop = page.locator('.m-stop')
    await expect(page.locator('.m-state', { hasText: '工作中…' })).toBeVisible({ timeout: 15_000 })
    await stop.click()
    await expect(stop).toBeDisabled()
    await expect(stop).toHaveText('正在中止…')

    // 未决审批随 run 中止被否决：流内 gate 卡收敛（revokeRun 的 resolved 事件）
    await expect(page.locator('.gate')).toHaveCount(0, { timeout: 15_000 })
    // run 以 aborted 收敛：「工作中…」消失、无终答（终答步未被消费）
    await expect(page.locator('.m-state', { hasText: '工作中…' })).toHaveCount(0, { timeout: 15_000 })
    await expect(page.locator('.m-text', { hasText: '不该走到这里' })).toHaveCount(0)
    // 排程视图：run 卡「已中止」
    await page.getByRole('button', { name: '排程', exact: true }).click()
    await expect(page.locator('.run .chip', { hasText: '已中止' })).toBeVisible({ timeout: 15_000 })
    // llm 第二轮不发起：mock 端点只收到过第一次请求
    expect(mock.requests.length).toBe(1)
  } finally {
    await app.close()
    await mock.close()
    await rm(userData, { recursive: true, force: true }).catch(() => {})
  }
})

test('Box 仪表与宿主磁盘压力角标（Step 6：stats 轮询 → 事件 → 仪表/角标）', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'openbot-e2e-stats-'))
  const app = await _electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      OPENBOT_USER_DATA: userData,
      OPENBOT_SANDBOX: 'mock',
      // warn 阈值抬高到天文数字（critical 取其半仍远超真实余量）→ 首拍即 critical 档，确定性
      OPENBOT_DISK_WARN_BYTES: String(Number.MAX_SAFE_INTEGER),
    },
  })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => console.log('[pageerror]', e.message))

  try {
    await expect(page.locator('.app')).toHaveAttribute('data-connected', 'true', { timeout: 30_000 })

    // 侧栏 Box 图标压力角标（critical 档常驻 + 脉冲）
    await expect(page.locator('.nav-item .badge-danger')).toBeVisible({ timeout: 15_000 })

    // boxes 视图：压力警示条（剩余空间事实）+ Box 卡仪表（mock 三字段全给）
    await page.getByRole('button', { name: 'Box', exact: true }).click()
    await expect(page.locator('.disk-banner.critical')).toBeVisible()
    await expect(page.locator('.disk-banner')).toContainText('磁盘空间严重不足')
    await expect(page.locator('.boxcard .gauge', { hasText: 'CPU' })).toBeVisible({ timeout: 15_000 })
    // 体积类仪表（内存/磁盘）的值带 MB/GB 档——按 gauge 标签定位取值，CPU 值是百分号不走此断言
    await expect(page.locator('.boxcard .gauge', { hasText: '内存' }).locator('.gauge-v')).toContainText(/MB|GB/)
    await expect(page.locator('.boxcard .gauge', { hasText: '磁盘' }).locator('.gauge-v')).toContainText(/MB|GB/)
  } finally {
    await app.close()
    await rm(userData, { recursive: true, force: true }).catch(() => {})
  }
})

test('壳层收尾（P4 Step 1）：状态栏真数据 + 面包屑 + 你头像 + About 版本真值', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'openbot-e2e-shell-'))
  const app = await _electron.launch({
    args: ['.'],
    env: { ...process.env, OPENBOT_USER_DATA: userData, OPENBOT_SANDBOX: 'mock' },
  })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => console.log('[pageerror]', e.message))

  try {
    await expect(page.locator('.app')).toHaveAttribute('data-connected', 'true', { timeout: 30_000 })

    // 面包屑随视图：控制台 → 切 Box 后变「Box」
    await expect(page.locator('.tb-crumb')).toHaveText('控制台')
    await page.getByRole('button', { name: 'Box', exact: true }).click()
    await expect(page.locator('.tb-crumb')).toHaveText('Box')

    // 状态栏：连接事实 + mock 沙箱事实 + 叙事行（真数据投影——不造数字）
    await expect(page.locator('.statusbar')).toContainText('内核已连接 · seq')
    await expect(page.locator('.statusbar')).toContainText('沙箱 模拟 ·')
    await expect(page.locator('.statusbar')).toContainText('本地执行 · 0 云依赖')

    // 你（本机主人）头像钉在侧栏底部
    await expect(page.locator('.rail-user')).toHaveText('你')

    // About 版本真值：package.json version 经桥到达（正则断言——版本号随提交演进不腐烂）
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await expect(page.locator('.settings')).toContainText(/v\d+\.\d+\.\d+/)
  } finally {
    await app.close()
    await rm(userData, { recursive: true, force: true }).catch(() => {})
  }
})

test('Toast 全局通道（P4 Step 2）：快照成功轻提示出现并自动消退', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'openbot-e2e-toast-'))
  const app = await _electron.launch({
    args: ['.'],
    env: { ...process.env, OPENBOT_USER_DATA: userData, OPENBOT_SANDBOX: 'mock' },
  })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => console.log('[pageerror]', e.message))

  try {
    await expect(page.locator('.app')).toHaveAttribute('data-connected', 'true', { timeout: 30_000 })

    // Box 视图触发快照（mock caps.snapshot=true）→ 成功 toast
    await page.getByRole('button', { name: 'Box', exact: true }).click()
    await page.locator('.boxcard button', { hasText: '快照' }).first().click()
    await expect(page.locator('.toast.success')).toContainText('已创建快照')

    // 2.8s 自动消退（点击即消的备选路径由单测心智覆盖——E2E 只验自动闭环）
    await expect(page.locator('.toast.success')).toHaveCount(0, { timeout: 6000 })
  } finally {
    await app.close()
    await rm(userData, { recursive: true, force: true }).catch(() => {})
  }
})
