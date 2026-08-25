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

test('命令面板（P4 Step 3）：Ctrl K 过滤导航 + omnibox 入口 + 快速派单聚焦 + PTY 聚焦不抢键', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'openbot-e2e-palette-'))
  const app = await _electron.launch({
    args: ['.'],
    env: { ...process.env, OPENBOT_USER_DATA: userData, OPENBOT_SANDBOX: 'mock' },
  })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => console.log('[pageerror]', e.message))

  try {
    await expect(page.locator('.app')).toHaveAttribute('data-connected', 'true', { timeout: 30_000 })

    // Ctrl K 唤起 → 过滤「设置」→ Enter 导航（crumb 断言）
    await page.keyboard.press('Control+k')
    await expect(page.locator('.pal-card')).toBeVisible()
    await page.locator('.pal-input').fill('设置')
    await page.locator('.pal-input').press('Enter')
    await expect(page.locator('.tb-crumb')).toHaveText('设置')

    // omnibox 点击唤起 → Esc 关闭
    await page.locator('.omnibox').click()
    await expect(page.locator('.pal-card')).toBeVisible()
    await page.locator('.pal-input').press('Escape')
    await expect(page.locator('.pal-card')).toHaveCount(0)

    // 快速派单：过滤「派单」→ Enter → 控制台 + composer 聚焦
    await page.keyboard.press('Control+k')
    await page.locator('.pal-input').fill('派单')
    await page.locator('.pal-input').press('Enter')
    await expect(page.locator('.tb-crumb')).toHaveText('控制台')
    await expect(page.locator('.composer-box input')).toBeFocused()

    // 抢键边界：操作台 xterm 聚焦时 Ctrl K 直送 Box——面板不弹（plan-p4 设计要点）
    await page.getByRole('button', { name: 'Box', exact: true }).click()
    await page.locator('.boxcard button', { hasText: '操作台' }).first().click()
    const xterm = page.locator('.boxops .xterm')
    await expect(xterm).toBeVisible({ timeout: 15_000 })
    await xterm.click()
    await page.keyboard.press('Control+k')
    await expect(page.locator('.pal-card')).toHaveCount(0)
  } finally {
    await app.close()
    await rm(userData, { recursive: true, force: true }).catch(() => {})
  }
})

test('@提及（P4 Step 4）：补全菜单键盘流 + 单提及路由 + 消息高亮', async () => {
  // worker1 对用户消息回文本（带 @管家——覆盖 agent 回复 md 路径的名册命中高亮）
  const mock = await startMockOpenAi([
    { match: (l) => l.role === 'user' && !l.content.startsWith('[A2A'), text: '收到，@管家 已记录' },
  ])

  const userData = await mkdtemp(join(tmpdir(), 'openbot-e2e-mention-'))
  const app = await _electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      OPENBOT_USER_DATA: userData,
      OPENBOT_EXTRA_AGENTS: 'worker1',
      OPENBOT_SANDBOX: 'mock',
    },
  })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => console.log('[pageerror]', e.message))

  try {
    await expect(page.locator('.app')).toHaveAttribute('data-connected', 'true', { timeout: 30_000 })

    // —— settings：配 provider（发送链路前置） ——
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.getByRole('button', { name: '＋ 添加模型' }).click()
    await page.locator('#pfName').fill('E2E mock')
    await page.locator('#pfUrl').fill(`http://127.0.0.1:${mock.port}/v1`)
    await page.locator('#pfModel').fill('mock-model')
    await page.getByRole('button', { name: '保存', exact: true }).click()
    await page.locator('.cfg-row .btn', { hasText: '设为主力' }).click()

    // —— 菜单弹出与过滤：@ 弹全员（管家=档案名 / worker1=name 缺席回退 id）；@w 只剩 worker1 ——
    await page.getByRole('button', { name: '控制台', exact: true }).click()
    const input = page.locator('.composer-box input')
    await expect(page.locator('.sh-name')).toHaveText('管家')
    await input.fill('@')
    const menu = page.locator('.mention-menu')
    await expect(menu).toBeVisible()
    await expect(menu.locator('.m-item')).toHaveCount(2)
    await input.fill('@w')
    await expect(menu.locator('.m-item')).toHaveCount(1)
    await expect(menu.locator('.mm-name')).toHaveText('@worker1')

    // —— Enter 补全：@ 前缀替换为完整名 + 尾随空格（原型语义；不重复 @） ——
    await input.press('Enter')
    await expect(menu).toHaveCount(0)
    await expect(input).toHaveValue('@worker1 ')

    // —— Esc 关闭（菜单开时 Enter 是补全不是发送——上面已覆盖）；失焦收起 ——
    await input.fill('@')
    await expect(menu).toBeVisible()
    await input.press('Escape')
    await expect(menu).toHaveCount(0)
    await expect(input).toHaveValue('@')
    await input.fill('@')
    await expect(menu).toBeVisible()
    await page.locator('.stream-head').click()
    await expect(menu).toHaveCount(0, { timeout: 3_000 })

    // —— 单提及路由：唯一提及非当前会话对象 → 消息发 worker1 并跟随跳转 ——
    await input.fill('@worker1 收到请回话')
    await input.press('Enter')
    await expect(page.locator('.sh-name')).toHaveText('worker1')
    // 用户消息气泡内 @worker1 高亮 chip（mentionify 纯文本路径）
    const userChip = page.locator('.m.user .m-text .mention')
    await expect(userChip).toHaveText('@worker1', { timeout: 15_000 })
    // agent 回复 md 路径：@管家 命中名册档案名
    await expect(page.locator('.m-text.md .mention')).toHaveText('@管家', { timeout: 15_000 })
  } finally {
    await mock.close()
    await app.close()
    await rm(userData, { recursive: true, force: true }).catch(() => {})
  }
})

test('新建 agent 向导（P4 Step 5）：三步创建 → 名册档案色 → @提及收录 → 注册即建 Box', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'openbot-e2e-wizard-'))
  const app = await _electron.launch({
    args: ['.'],
    env: { ...process.env, OPENBOT_USER_DATA: userData, OPENBOT_SANDBOX: 'mock' },
  })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => console.log('[pageerror]', e.message))

  try {
    await expect(page.locator('.app')).toHaveAttribute('data-connected', 'true', { timeout: 30_000 })

    // —— 名册入口 → 向导（三步）——
    await page.getByRole('button', { name: '＋ 新建 agent' }).click()
    const card = page.locator('.wiz-card')
    await expect(card).toBeVisible()
    await page.locator('#wizName').fill('欧米伽')
    // 角色默认研究员；身份色默认第 4 色（断言选中态——档案色断言依赖此值）
    await expect(card.locator('.wiz-swatch.is-sel')).toHaveAttribute('aria-label', '身份色 #3987e5')
    await card.getByRole('button', { name: '下一步' }).click()
    // 步 2：模型与沙箱如实说明（裁定 B/F——不放假选项）
    await expect(card.locator('.wiz-body')).toContainText('继承全局主力')
    await expect(card.locator('.wiz-body')).toContainText('注册即建专属 Box')
    await card.getByRole('button', { name: '下一步' }).click()
    // 步 3：复核行（名字/角色/身份色/继承说明）
    await expect(card.locator('.wiz-body')).toContainText('欧米伽')
    await expect(card.locator('.wiz-body')).toContainText('研究员')
    await card.getByRole('button', { name: '创建 agent' }).click()

    // —— 创建收敛：toast + 向导关闭 + 跳新会话（sh-name 切换）——
    await expect(page.locator('.toast', { hasText: '欧米伽」已创建' })).toBeVisible({ timeout: 15_000 })
    await expect(card).toHaveCount(0)
    await expect(page.locator('.sh-name')).toHaveText('欧米伽')

    // 名册出现新成员；头像底色 = 档案色（#3987e5 → rgb 序列化）
    const item = page.locator('.roster-item', { hasText: '欧米伽' })
    await expect(item).toBeVisible()
    await expect(item.locator('.avatar')).toHaveAttribute('style', expect.stringContaining('rgb(57, 135, 229)'))

    // @提及菜单收录新成员（中文前缀过滤命中）
    const input = page.locator('.composer-box input')
    await input.fill('@欧')
    await expect(page.locator('.mention-menu .mm-name')).toHaveText('@欧米伽')

    // 注册即建专属 Box（裁定 B 语义）：Boxes 视图 1 → 2
    await page.getByRole('button', { name: 'Box', exact: true }).click()
    await expect(page.locator('.boxcard')).toHaveCount(2, { timeout: 15_000 })
  } finally {
    await app.close()
    await rm(userData, { recursive: true, force: true }).catch(() => {})
  }
})

test('名册与 stream-head（P4 Step 6）：ctx 面板收起两栏 ⇄ 三栏 + 未读徽标计数清零', async () => {
  // steward 派发 worker1 → worker1 回文本：在 steward 会话产生 worker1 的未读
  const mock = await startMockOpenAi([
    { match: (l) => l.role === 'user' && !l.content.startsWith('[A2A'), toolCalls: [{ id: 'c1', name: 'send_message', args: { toAgentId: 'worker1', text: '报数' } }] },
    { match: (l) => l.role === 'user' && l.content.startsWith('[A2A'), text: 'worker1 就位' },
    { match: (_l, t) => t === 'send_message', text: '已收到' },
  ])

  const userData = await mkdtemp(join(tmpdir(), 'openbot-e2e-roster-'))
  const app = await _electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      OPENBOT_USER_DATA: userData,
      OPENBOT_EXTRA_AGENTS: 'worker1',
      OPENBOT_SANDBOX: 'mock',
    },
  })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => console.log('[pageerror]', e.message))

  try {
    await expect(page.locator('.app')).toHaveAttribute('data-connected', 'true', { timeout: 30_000 })
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.getByRole('button', { name: '＋ 添加模型' }).click()
    await page.locator('#pfName').fill('E2E mock')
    await page.locator('#pfUrl').fill(`http://127.0.0.1:${mock.port}/v1`)
    await page.locator('#pfModel').fill('mock-model')
    await page.getByRole('button', { name: '保存', exact: true }).click()
    await page.locator('.cfg-row .btn', { hasText: '设为主力' }).click()

    // —— ctx 收起（三栏 ⇄ 两栏；aria-pressed 语义随状态翻转） ——
    await page.getByRole('button', { name: '控制台', exact: true }).click()
    const toggle = page.locator('.sh-icon[title="收起上下文面板"]')
    await expect(toggle).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('.ctx')).toBeVisible()
    await toggle.click()
    await expect(page.locator('.console')).toHaveClass(/no-ctx/)
    await expect(page.locator('.ctx')).toBeHidden()
    await expect(page.locator('.sh-icon[title="展开上下文面板"]')).toHaveAttribute('aria-pressed', 'false')
    await page.locator('.sh-icon[title="展开上下文面板"]').click()
    await expect(page.locator('.ctx')).toBeVisible()

    // —— 未读徽标：steward 会话内 worker1 回复到达 → 名册 +1 → 点击进入清零 ——
    await page.locator('.composer-box input').fill('叫 worker1 报数')
    await page.locator('.composer-box input').press('Enter')
    const worker1Badge = page.locator('.roster-item', { hasText: 'worker1' }).locator('.ri-badge')
    await expect(worker1Badge).toHaveText('1', { timeout: 30_000 })
    await page.locator('.roster-item', { hasText: 'worker1' }).click()
    await expect(worker1Badge).toHaveCount(0)
    await expect(page.locator('.sh-name')).toHaveText('worker1')
    // 进入会话后新回复不再累计（读过即清）
    await expect(page.locator('.m-text', { hasText: 'worker1 就位' })).toBeVisible({ timeout: 15_000 })
  } finally {
    await mock.close()
    await app.close()
    await rm(userData, { recursive: true, force: true }).catch(() => {})
  }
})

test('ctx Settings 档案模式（P4 Step 7）：档案 kv + 协作对象跳会话 + 空缺态如实', async () => {
  // steward 派发 worker1 → 双方回复（产生 a2a 边：档案「协作对象」的数据源）
  const mock = await startMockOpenAi([
    { match: (l) => l.role === 'user' && !l.content.startsWith('[A2A'), toolCalls: [{ id: 'c1', name: 'send_message', args: { toAgentId: 'worker1', text: '报数' } }] },
    { match: (l) => l.role === 'user' && l.content.startsWith('[A2A'), text: 'worker1 就位' },
    { match: (_l, t) => t === 'send_message', text: '已收到' },
  ])

  const userData = await mkdtemp(join(tmpdir(), 'openbot-e2e-ctxsettings-'))
  const app = await _electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      OPENBOT_USER_DATA: userData,
      OPENBOT_EXTRA_AGENTS: 'worker1',
      OPENBOT_SANDBOX: 'mock',
    },
  })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => console.log('[pageerror]', e.message))

  try {
    await expect(page.locator('.app')).toHaveAttribute('data-connected', 'true', { timeout: 30_000 })
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.getByRole('button', { name: '＋ 添加模型' }).click()
    await page.locator('#pfName').fill('E2E mock')
    await page.locator('#pfUrl').fill(`http://127.0.0.1:${mock.port}/v1`)
    await page.locator('#pfModel').fill('mock-model')
    await page.getByRole('button', { name: '保存', exact: true }).click()
    await page.locator('.cfg-row .btn', { hasText: '设为主力' }).click()

    await page.getByRole('button', { name: '控制台', exact: true }).click()
    await page.locator('.composer-box input').fill('叫 worker1 报数')
    await page.locator('.composer-box input').press('Enter')
    await expect(page.locator('.m-text', { hasText: '已收到' })).toBeVisible({ timeout: 30_000 })

    // —— 进入档案模式：ctx-top（Settings + 会话名）+ 档案 kv 四行（全真值） ——
    await page.locator('.sh-icon[title="会话档案（Settings）"]').click()
    const ctx = page.locator('.ctx')
    await expect(ctx.locator('.ctx-top-title')).toHaveText('Settings')
    await expect(ctx.locator('.ctx-top-sub')).toHaveText('管家')
    await expect(ctx.locator('.ctx-name')).toHaveText('管家')
    await expect(ctx.locator('.kv', { hasText: '角色' })).toContainText('管家（steward）')
    await expect(ctx.locator('.kv', { hasText: '模型' })).toContainText('继承全局主力（E2E mock）')
    await expect(ctx.locator('.kv', { hasText: 'Box 归属' })).toContainText(/box-\d+/)
    await expect(ctx.locator('.kv', { hasText: '权限现状' })).toContainText('出 Box 需批准（Manual 闸门）')

    // 协作对象（a2a 边投影）：worker1 行 + 计数；点击跳会话（档案模式随之重置回屏幕）
    const edge = ctx.locator('.edge-row', { hasText: 'worker1' })
    await expect(edge).toBeVisible()
    await expect(edge.locator('.cnt')).toHaveText(/×\d+/)
    await edge.click()
    await expect(page.locator('.sh-name')).toHaveText('worker1')
    await expect(page.locator('.ctx-screen')).toBeVisible()

    // 空缺态如实（记忆/自动化无数据源不放占位）；worker1 档案的协作对象也应有回边
    await page.locator('.sh-icon[title="会话档案（Settings）"]').click()
    await expect(ctx.locator('.mem-empty').first()).toContainText('后续版本')
    const backEdge = ctx.locator('.edge-row', { hasText: '管家' })
    await expect(backEdge).toBeVisible()
    await ctx.locator('.ctx-back').click()
    await expect(page.locator('.ctx-screen')).toBeVisible()
  } finally {
    await mock.close()
    await app.close()
    await rm(userData, { recursive: true, force: true }).catch(() => {})
  }
})

test('Box 休眠/唤醒（P4 Step 8）：卡按钮状态机 + toast + ctx 屏灰化同源', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'openbot-e2e-sleep-'))
  const app = await _electron.launch({
    args: ['.'],
    env: { ...process.env, OPENBOT_USER_DATA: userData, OPENBOT_SANDBOX: 'mock' },
  })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => console.log('[pageerror]', e.message))

  try {
    await expect(page.locator('.app')).toHaveAttribute('data-connected', 'true', { timeout: 30_000 })

    // —— Boxes 视图：caps 驱动按钮在位；休眠 → chip 变「休眠」 + toast ——
    await page.getByRole('button', { name: 'Box', exact: true }).click()
    const card = page.locator('.boxcard').first()
    await expect(card).toBeVisible({ timeout: 15_000 })
    await expect(card.locator('.chip', { hasText: '运行中' })).toBeVisible()
    await card.getByRole('button', { name: '休眠', exact: true }).click()
    await expect(card.locator('.chip', { hasText: '休眠' })).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('.toast', { hasText: '已休眠' })).toBeVisible()

    // —— console ctx 屏同源灰化（v1.box.state 事件单一信号源） ——
    await page.getByRole('button', { name: '控制台', exact: true }).click()
    await expect(page.locator('.ctx-screen.is-asleep')).toBeVisible()
    await expect(page.locator('.cs-live')).toContainText('休眠中')

    // —— 唤醒闭环：按钮文案随状态翻转，chip 回「运行中」，ctx 恢复 ——
    await page.getByRole('button', { name: 'Box', exact: true }).click()
    await card.getByRole('button', { name: '唤醒', exact: true }).click()
    await expect(card.locator('.chip', { hasText: '运行中' })).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('.toast', { hasText: '已唤醒' })).toBeVisible()
    await page.getByRole('button', { name: '控制台', exact: true }).click()
    await expect(page.locator('.ctx-screen.is-asleep')).toHaveCount(0)
  } finally {
    await app.close()
    await rm(userData, { recursive: true, force: true }).catch(() => {})
  }
})

test('快照链与回滚（P4 Step 9）：chips 链 + 点击详情 + 二段确认 + 回滚闭环（mock 链路）', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'openbot-e2e-restore-'))
  const app = await _electron.launch({
    args: ['.'],
    env: { ...process.env, OPENBOT_USER_DATA: userData, OPENBOT_SANDBOX: 'mock' },
  })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => console.log('[pageerror]', e.message))

  try {
    await expect(page.locator('.app')).toHaveAttribute('data-connected', 'true', { timeout: 30_000 })

    await page.getByRole('button', { name: 'Box', exact: true }).click()
    const card = page.locator('.boxcard').first()
    await expect(card).toBeVisible({ timeout: 15_000 })

    // —— 快照 ×2 → 链 chips 最近在前 ——
    await card.getByRole('button', { name: '快照', exact: true }).click()
    await expect(card.locator('.snap-chip', { hasText: 'snap-1' })).toBeVisible({ timeout: 15_000 })
    await card.getByRole('button', { name: '快照', exact: true }).click()
    await expect(card.locator('.snap-chip')).toHaveCount(2)
    expect(await card.locator('.snap-chip').first().textContent()).toBe('snap-2')

    // —— 点击 chip 展开详情（不直接触发回滚）；取消路径 ——
    await card.locator('.snap-chip', { hasText: 'snap-1' }).click()
    const detail = card.locator('.snap-detail')
    await expect(detail).toBeVisible()
    await detail.getByRole('button', { name: '从快照回滚…' }).click()
    await expect(detail.locator('.sd-confirm')).toContainText('将被快照内容替换')
    await detail.getByRole('button', { name: '取消' }).click()
    await expect(detail.locator('.sd-confirm')).toHaveCount(0)

    // —— 二段确认回滚 → toast + 详情收起 + 链仍在 ——
    await detail.getByRole('button', { name: '从快照回滚…' }).click()
    await detail.getByRole('button', { name: '确认回滚' }).click()
    await expect(page.locator('.toast', { hasText: '已回滚到 snap-1' })).toBeVisible({ timeout: 15_000 })
    await expect(detail).toHaveCount(0)
    await expect(card.locator('.snap-chip')).toHaveCount(2)
  } finally {
    await app.close()
    await rm(userData, { recursive: true, force: true }).catch(() => {})
  }
})

test('演示值清扫（P4 Step 10）：run-progress 全宽流光无假进度 + 内存/磁盘仪表只报数值', async () => {
  const mock = await startMockOpenAi([
    // 单步：host_fetch 触发审批闸门 → run 稳定挂 running（流光断言的稳定活跃窗口）
    { match: (l) => l.role === 'user', toolCalls: [{ id: 'c1', name: 'host_fetch', args: { url: 'https://example.com/' } }] },
  ])
  const userData = await mkdtemp(join(tmpdir(), 'openbot-e2e-honest-'))
  const app = await _electron.launch({
    args: ['.'],
    env: { ...process.env, OPENBOT_USER_DATA: userData, OPENBOT_SANDBOX: 'mock' },
  })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => console.log('[pageerror]', e.message))

  try {
    await expect(page.locator('.app')).toHaveAttribute('data-connected', 'true', { timeout: 30_000 })

    // 配 provider（真走 settings 命令面与 safeStorage 链路）
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.getByRole('button', { name: '＋ 添加模型' }).click()
    await page.locator('#pfName').fill('E2E mock')
    await page.locator('#pfUrl').fill(`http://127.0.0.1:${mock.port}/v1`)
    await page.locator('#pfModel').fill('mock-model')
    await page.getByRole('button', { name: '保存', exact: true }).click()
    await page.locator('.cfg-row .btn', { hasText: '设为主力' }).click()

    // 发消息 → 审批挂起（run 停在 running）；「稍后处理」收掉模态再切视图
    await page.getByRole('button', { name: '控制台', exact: true }).click()
    await page.locator('.composer-box input').fill('抓个网页')
    await page.locator('.composer-box input').press('Enter')
    const modal = page.locator('.approval-modal', { hasText: 'host_fetch' })
    await expect(modal).toBeVisible({ timeout: 30_000 })
    await modal.getByRole('button', { name: '稍后处理' }).click()

    // run-progress：indeterminate 流光——光带与轨道同宽（translateX 扫动不改宽度）；
    // 旧实现固定 64% 宽条在 reduced-motion 关动画后呈现「进度 64%」假几何，清扫
    await page.getByRole('button', { name: '排程', exact: true }).click()
    const track = page.locator('.run-progress').first()
    await expect(track).toBeVisible({ timeout: 15_000 })
    const tw = (await track.boundingBox())!.width
    const iw = (await track.locator('i').boundingBox())!.width
    expect(Math.abs(tw - iw)).toBeLessThanOrEqual(1)

    // 仪表：内存/磁盘无上限事实——不画比例条只报数值；CPU 百分比保留真比例（mock 确定值 12%）
    await page.getByRole('button', { name: 'Box', exact: true }).click()
    const memGauge = page.locator('.boxcard .gauge', { hasText: '内存' })
    const diskGauge = page.locator('.boxcard .gauge', { hasText: '磁盘' })
    await expect(memGauge).toBeVisible({ timeout: 15_000 })
    await expect(memGauge.locator('.gauge-bar')).toHaveCount(0)
    await expect(diskGauge.locator('.gauge-bar')).toHaveCount(0)
    await expect(memGauge.locator('.gauge-v')).toContainText(/MB|GB/)
    await expect(diskGauge.locator('.gauge-v')).toContainText(/MB|GB/)
    const cpuFill = page.locator('.boxcard .gauge', { hasText: 'CPU' }).locator('.gauge-fill')
    await expect(cpuFill).toBeVisible()
    await expect(cpuFill).toHaveAttribute('style', /width:\s*12%/)
  } finally {
    await mock.close()
    await app.close()
    await rm(userData, { recursive: true, force: true }).catch(() => {})
  }
})
