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
    // 过渡态（disabled +「正在中止…」）不单独断言：revokeRun 对审批挂起的 run（无在途
    // LLM 调用）收敛可快于 Vue 渲染拍——过渡态一帧即逝（P6 实测 flaky 根因）；收敛语义
    // 由下方终态断言完整覆盖（gate 消失/工作中消失/无终答/排程卡已中止）

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

    // —— 菜单弹出与过滤：@ 弹全员（P5 Step 2 起 @全员广播项置顶：全员+管家+worker1 三项；
    //     管家=档案名 / worker1=name 缺席回退 id）；@w 只剩 worker1（全员项不匹配 w） ——
    await page.getByRole('button', { name: '控制台', exact: true }).click()
    const input = page.locator('.composer-box input')
    await expect(page.locator('.sh-name')).toHaveText('管家')
    await input.fill('@')
    const menu = page.locator('.mention-menu')
    await expect(menu).toBeVisible()
    await expect(menu.locator('.m-item')).toHaveCount(3)
    await expect(menu.locator('.m-item').first().locator('.mm-name')).toHaveText('@全员')
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

test('广播扇出（P5 Step 2）：@全员补全 → 内核 fanout 全员到达 + toast + 多提及扇出 + 图谱边同源', async () => {
  const mock = await startMockOpenAi([
    // 管家与 worker1 各自的广播回复（共用端点：user 消息回固定文本——两 run 各取一次）
    { match: (l) => l.role === 'user', text: '收到广播' },
  ])
  const userData = await mkdtemp(join(tmpdir(), 'openbot-e2e-fanout-'))
  const app = await _electron.launch({
    args: ['.'],
    env: { ...process.env, OPENBOT_USER_DATA: userData, OPENBOT_EXTRA_AGENTS: 'worker1', OPENBOT_SANDBOX: 'mock' },
  })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => console.log('[pageerror]', e.message))

  try {
    await expect(page.locator('.app')).toHaveAttribute('data-connected', 'true', { timeout: 30_000 })

    // 配 provider
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.getByRole('button', { name: '＋ 添加模型' }).click()
    await page.locator('#pfName').fill('E2E mock')
    await page.locator('#pfUrl').fill(`http://127.0.0.1:${mock.port}/v1`)
    await page.locator('#pfModel').fill('mock-model')
    await page.getByRole('button', { name: '保存', exact: true }).click()
    await page.locator('.cfg-row .btn', { hasText: '设为主力' }).click()

    // —— @全员补全（P5 Step 2）：@全 弹菜单（全员项首位）→ Enter 补全尾随空格 → 追加文本发送 ——
    await page.getByRole('button', { name: '控制台', exact: true }).click()
    const input = page.locator('.composer-box input')
    await input.fill('@全')
    const menu = page.locator('.mention-menu')
    await expect(menu).toBeVisible()
    await expect(menu.locator('.m-item').first().locator('.mm-name')).toHaveText('@全员')
    await input.press('Enter')
    await expect(input).toHaveValue('@全员 ')
    await input.pressSequentially('各自查收')
    await input.press('Enter')

    // 扇出受理回执 → toast（一次命令原子扇出，非 UI 循环；hasText 过滤避开设置页残留 toast）
    await expect(page.locator('.toast.success', { hasText: '已广播给 2 人' })).toBeVisible({ timeout: 15_000 })

    // —— 到达面 1：worker1 会话（名册切换）——广播文本在场 + worker1 回复到达（md 路径） ——
    await page.locator('.roster-item', { hasText: 'worker1' }).click()
    await expect(page.locator('.m.user', { hasText: '各自查收' })).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('.m-text.md', { hasText: '收到广播' })).toBeVisible({ timeout: 15_000 })

    // —— 到达面 2：管家会话——同样收到广播与回复（顺序入队并发执行，两 run 独立） ——
    await page.locator('.roster-item', { hasText: '管家' }).click()
    await expect(page.locator('.m.user', { hasText: '各自查收' })).toBeVisible()
    await expect(page.locator('.m-text.md', { hasText: '收到广播' })).toBeVisible({ timeout: 15_000 })

    // —— 多提及扇出（@a @b 同一条 → fanout 提及者列表）：两成员各自收到 ——
    await input.fill('@worker1 @管家 多提及查收')
    await input.press('Enter')
    await expect(page.locator('.toast.success', { hasText: '已广播给' }).last()).toBeVisible({ timeout: 15_000 })

    // —— 图谱边同源：user↔worker1 与 user↔管家 两对关系由事件流自然驱动 ——
    await page.getByRole('button', { name: '图谱', exact: true }).click()
    await expect(page.locator('.graph-sum')).toContainText('2 对关系')
  } finally {
    await mock.close()
    await app.close()
    await rm(userData, { recursive: true, force: true }).catch(() => {})
  }
})

test('群聊（P5 Step 4）：建群 → 轮转发言 → supersede 丢弃旧轮 → 全员 pass 收敛 → 群组节/ctx 群档案/菱形节点在场', async () => {
  const mock = await startMockOpenAi([
    // 旧轮（第1轮）成员响应：延迟中用户插话 → supersede；settle 后代际不匹配被内核静默丢弃
    { match: (l) => l.role === 'user' && l.content.includes('· 第1轮]'), delayMs: 2600, text: '旧轮发言不该出现' },
    // 新轮（第2轮）首位成员：即时发言（落群流——顺序轮转的第一声）
    { match: (l) => l.role === 'user' && l.content.includes('· 第2轮]') && !l.content.includes('本轮已发言'), text: '新轮第一位发言' },
    // 轮转后续成员（上下文含「本轮已发言」）：[pass]
    { match: (l) => l.role === 'user' && l.content.includes('本轮已发言'), text: '[pass]' },
    // 第3轮全员 [pass]：无人发言 → 收敛 sysnote（首位 pass 后上下文仍空，同此步命中）
    { match: (l) => l.role === 'user' && l.content.includes('· 第3轮]') && !l.content.includes('本轮已发言'), text: '[pass]' },
  ])
  const userData = await mkdtemp(join(tmpdir(), 'openbot-e2e-group-'))
  const app = await _electron.launch({
    args: ['.'],
    env: { ...process.env, OPENBOT_USER_DATA: userData, OPENBOT_EXTRA_AGENTS: 'worker1', OPENBOT_SANDBOX: 'mock' },
  })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => console.log('[pageerror]', e.message))

  try {
    await expect(page.locator('.app')).toHaveAttribute('data-connected', 'true', { timeout: 30_000 })

    // 配 provider
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.getByRole('button', { name: '＋ 添加模型' }).click()
    await page.locator('#pfName').fill('E2E mock')
    await page.locator('#pfUrl').fill(`http://127.0.0.1:${mock.port}/v1`)
    await page.locator('#pfModel').fill('mock-model')
    await page.getByRole('button', { name: '保存', exact: true }).click()
    await page.locator('.cfg-row .btn', { hasText: '设为主力' }).click()

    // —— 建群：名册「＋ 建群」→ 群名 + 勾选管家与 worker1 → 创建（内核 sysnote 落群流）→ 跳群会话 ——
    await page.getByRole('button', { name: '控制台', exact: true }).click()
    await page.locator('.roster-new', { hasText: '建群' }).click()
    const wiz = page.locator('.wiz-card')
    await expect(wiz).toBeVisible()
    await page.locator('#gwName').fill('评审组')
    await page.locator('.gw-member', { hasText: '管家' }).click()
    await page.locator('.gw-member', { hasText: 'worker1' }).click()
    await wiz.getByRole('button', { name: /^建群/ }).click()

    await expect(page.locator('.sh-name')).toHaveText('评审组', { timeout: 10_000 })
    await expect(page.locator('.sysnote').first()).toContainText('群「评审组」建立')
    await expect(page.locator('.sh-status .chip')).toContainText('群聊 · 2 成员')

    // —— 第1条消息（第1轮，成员响应慢 2.6s）→ 400ms 后插话第2条：supersede ——
    const input = page.locator('.composer-box input')
    await input.fill('第一轮议题')
    await input.press('Enter')
    await page.waitForTimeout(400) // 首成员 turn 已受理（慢响应在途）
    await input.fill('第二轮议题打断')
    await input.press('Enter')

    // supersede 注记 + 新轮首位成员发言（群聊流 md 路径）+ 用户两条气泡在场
    await expect(page.locator('.sysnote', { hasText: '用户插话，本轮重新开始' })).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('.m-text.md', { hasText: '新轮第一位发言' })).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('.m.user', { hasText: '第二轮议题打断' })).toBeVisible()
    await expect(page.locator('.m.user', { hasText: '第一轮议题' })).toBeVisible()

    // —— 第3条消息（第3轮）：全员 [pass] → 收敛 sysnote ——
    await input.fill('第三轮全员沉默')
    await input.press('Enter')
    await expect(page.locator('.sysnote', { hasText: '全员 pass，本轮收敛' })).toBeVisible({ timeout: 15_000 })

    // 旧轮响应（延迟 2.6s）settle 后被代际丢弃——不落群流
    await page.waitForTimeout(2600)
    await expect(page.locator('.stream')).not.toContainText('旧轮发言不该出现')

    // —— 名册群组节：条目在场且 active（群会话中） ——
    await expect(page.locator('.roster-sec', { hasText: '群组' })).toBeVisible()
    await expect(page.locator('.roster-item.active', { hasText: '评审组' })).toBeVisible()

    // —— ctx 群状态屏（群无 Box 如实）+ 群档案（成员行 + 轮转边界 kv） ——
    await expect(page.locator('.ctx-screen.is-static')).toContainText('群聊无 Box')
    await page.getByTitle('会话档案（Settings）').click()
    await expect(page.locator('.ctx-name')).toHaveText('评审组')
    await expect(page.locator('.ctx-sec', { hasText: '成员' })).toBeVisible()
    await expect(page.locator('.edge-row', { hasText: 'worker1' })).toBeVisible()
    await expect(page.locator('.ctx .kv', { hasText: '群记录上限 200 条' })).toBeVisible()
    await page.locator('.ctx-back').click()

    // —— 图谱菱形节点：群节点（ggroup 菱形）+ 群边在场 ——
    await page.getByRole('button', { name: '图谱', exact: true }).click()
    await expect(page.locator('.ggroup')).toBeVisible()
    await expect(page.locator('.gnode[aria-label*="评审组"]')).toBeVisible()
  } finally {
    await mock.close()
    await app.close()
    await rm(userData, { recursive: true, force: true }).catch(() => {})
  }
})

test('重启恢复（P5 后修复）：自建 agent 调度器重建（建群可用）+ 图谱边从 transcript 底账重建', async () => {
  const mock = await startMockOpenAi([
    { match: (l) => l.role === 'user', text: '会话恢复确认' },
  ])
  const userData = await mkdtemp(join(tmpdir(), 'openbot-e2e-restart-'))
  const launchOpts = {
    args: ['.'] as const,
    env: { ...process.env, OPENBOT_USER_DATA: userData, OPENBOT_SANDBOX: 'mock' },
  }

  // —— 第一段会话：配 provider → 新建 agent（持久化名册）→ 与管家对话一轮（建边）——
  const app1 = await _electron.launch(launchOpts)
  const page1 = await app1.firstWindow()
  page1.on('pageerror', (e) => console.log('[pageerror]', e.message))
  try {
    await expect(page1.locator('.app')).toHaveAttribute('data-connected', 'true', { timeout: 30_000 })

    await page1.getByRole('button', { name: '设置', exact: true }).click()
    await page1.getByRole('button', { name: '＋ 添加模型' }).click()
    await page1.locator('#pfName').fill('E2E mock')
    await page1.locator('#pfUrl').fill(`http://127.0.0.1:${mock.port}/v1`)
    await page1.locator('#pfModel').fill('mock-model')
    await page1.getByRole('button', { name: '保存', exact: true }).click()
    await page1.locator('.cfg-row .btn', { hasText: '设为主力' }).click()

    await page1.getByRole('button', { name: '控制台', exact: true }).click()
    await page1.getByRole('button', { name: '＋ 新建 agent' }).click()
    const card = page1.locator('.wiz-card')
    await page1.locator('#wizName').fill('恢复员')
    await card.getByRole('button', { name: '下一步' }).click()
    await card.getByRole('button', { name: '下一步' }).click()
    await card.getByRole('button', { name: '创建 agent' }).click()
    await expect(page1.locator('.toast', { hasText: '恢复员」已创建' })).toBeVisible({ timeout: 15_000 })

    // 与管家对话一轮：用户出信 + 管家终答 → user↔管家两条有向边（图谱底账素材）
    await page1.locator('.roster-item', { hasText: '管家' }).click()
    const input1 = page1.locator('.composer-box input')
    await input1.fill('重启前的对话')
    await input1.press('Enter')
    await expect(page1.locator('.m-text.md', { hasText: '会话恢复确认' })).toBeVisible({ timeout: 15_000 })
  } finally {
    await app1.close()
  }

  // —— 第二段会话（同 userData 重启）：修复 2 名册重建 + 修复 4 图谱边底账重建 ——
  const app2 = await _electron.launch(launchOpts)
  const page2 = await app2.firstWindow()
  page2.on('pageerror', (e) => console.log('[pageerror]', e.message))
  try {
    await expect(page2.locator('.app')).toHaveAttribute('data-connected', 'true', { timeout: 30_000 })

    // 图谱边从 transcript 聚合重建：一轮对话 = user↔管家 1 对 · 2 条（出信 + 终答——count 聚合同数）
    await page2.getByRole('button', { name: '图谱', exact: true }).click()
    await expect(page2.locator('.graph-sum')).toContainText('1 对关系', { timeout: 15_000 })
    await expect(page2.locator('.graph-sum')).toContainText('2 条消息')

    // 自建 agent 建群：调度器已重建——不再「未注册 agent」，创建成功跳群会话
    await page2.getByRole('button', { name: '控制台', exact: true }).click()
    await page2.locator('.roster-new', { hasText: '建群' }).click()
    await page2.locator('#gwName').fill('重启验证组')
    await page2.locator('.gw-member', { hasText: '恢复员' }).click()
    await page2.locator('.wiz-card').getByRole('button', { name: /^建群/ }).click()
    await expect(page2.locator('.sh-name')).toHaveText('重启验证组', { timeout: 10_000 })
    await expect(page2.locator('.wiz-error')).toHaveCount(0) // 未注册 agent 错误不再出现
  } finally {
    await app2.close()
    await mock.close()
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
    await expect(ctx.locator('.mem-empty').first()).toContainText('尚无记忆')
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

test('演示值清扫（P4 Step 10 → P5 Step 7 限额解锁）：run-progress 流光 + 内存限额比例条 + 磁盘只报数值', async () => {
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

    // 仪表（P5 Step 7 行为变更）：内存比例条随默认限额解锁（spec.memoryMb=2048 真分母 + mock 256MB
    // → 12.5% 常规色，非 warn）；磁盘无上限事实维持只报数值；CPU 百分比真比例（mock 确定值 12%）
    await page.getByRole('button', { name: 'Box', exact: true }).click()
    const memGauge = page.locator('.boxcard .gauge', { hasText: '内存' })
    const diskGauge = page.locator('.boxcard .gauge', { hasText: '磁盘' })
    await expect(memGauge).toBeVisible({ timeout: 15_000 })
    await expect(memGauge.locator('.gauge-bar')).toHaveCount(1) // 上限在场 → 真比例条（P4 断言 0 已过时）
    await expect(memGauge).not.toHaveClass(/gauge-warn/) // 12.5% 常规档
    await expect(memGauge.locator('.gauge-v')).toContainText(/\/ 2\.0 GB/) // 文案带真实上限
    await expect(diskGauge.locator('.gauge-bar')).toHaveCount(0) // 磁盘无上限事实——只报数值不动摇
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

test('warn 色档（P5 Step 7）：高值仪表转警示色 + 内存用量按限额真分母（OPENBOT_MOCK_CPU/MEM 注入）', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'openbot-e2e-warn-'))
  const app = await _electron.launch({
    args: ['.'],
    // CPU 87%（≥80 warn）/ 内存 1900MB ÷ 2048MB 限额 ≈ 92.8%（warn）——mock 确定性注入（不涉 LLM 链路）
    env: {
      ...process.env,
      OPENBOT_USER_DATA: userData,
      OPENBOT_SANDBOX: 'mock',
      OPENBOT_MOCK_CPU: '87',
      OPENBOT_MOCK_MEM: '1900',
    },
  })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => console.log('[pageerror]', e.message))

  try {
    await expect(page.locator('.app')).toHaveAttribute('data-connected', 'true', { timeout: 30_000 })
    await page.getByRole('button', { name: 'Box', exact: true }).click()

    // CPU：87% ≥ 80 → gauge-warn 色档 + width 87%
    const cpuGauge = page.locator('.boxcard .gauge', { hasText: 'CPU' })
    await expect(cpuGauge).toBeVisible({ timeout: 15_000 })
    await expect(cpuGauge).toHaveClass(/gauge-warn/)
    await expect(cpuGauge.locator('.gauge-fill')).toHaveAttribute('style', /width:\s*87%/)

    // 内存：1900/2048 ≈ 92.7734%（Vue 按完整精度下发 width）→ warn 档；文案「1.9 GB / 2.0 GB」用量带真实上限
    const memGauge = page.locator('.boxcard .gauge', { hasText: '内存' })
    await expect(memGauge).toHaveClass(/gauge-warn/)
    await expect(memGauge.locator('.gauge-fill')).toHaveAttribute('style', /width:\s*92\.77\d*%/)
    await expect(memGauge.locator('.gauge-v')).toContainText('1.9 GB / 2.0 GB')
  } finally {
    await app.close()
    await rm(userData, { recursive: true, force: true }).catch(() => {})
  }
})

test('断网回退端点 + 数据区块（P4 Step 11）：主力失败自动降级 → 回复到达 + 状态栏当轮回退 + 路径在场', async () => {
  const mock = await startMockOpenAi([
    // 回退端点单步文本终答（主力连不上，请求只会在回退侧出现）
    { match: (l) => l.role === 'user', text: '回退端点回复' },
  ])
  const userData = await mkdtemp(join(tmpdir(), 'openbot-e2e-fallback-'))
  const app = await _electron.launch({
    args: ['.'],
    env: { ...process.env, OPENBOT_USER_DATA: userData, OPENBOT_SANDBOX: 'mock' },
  })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => console.log('[pageerror]', e.message))

  try {
    await expect(page.locator('.app')).toHaveAttribute('data-connected', 'true', { timeout: 30_000 })

    // —— 数据区块（裁定 E 一期只读）：路径指向本 userData、打开按钮在场（不点击——会真开资源管理器） ——
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await expect(page.locator('.set-sec', { hasText: '数据' })).toBeVisible()
    await expect(page.locator('.kv', { hasText: '数据目录' })).toContainText('data')
    await expect(page.locator('.kv', { hasText: 'transcript' })).toContainText('agents')
    await expect(page.getByRole('button', { name: '打开数据文件夹' })).toBeVisible()

    // —— 配置两端点：主力 = 必然连接失败端口；回退 = E2E mock ——
    await page.getByRole('button', { name: '＋ 添加模型' }).click()
    await page.locator('#pfName').fill('坏端点')
    await page.locator('#pfUrl').fill('http://127.0.0.1:9/v1')
    await page.locator('#pfModel').fill('x')
    await page.getByRole('button', { name: '保存', exact: true }).click()
    await page.getByRole('button', { name: '＋ 添加模型' }).click()
    await page.locator('#pfName').fill('E2E mock')
    await page.locator('#pfUrl').fill(`http://127.0.0.1:${mock.port}/v1`)
    await page.locator('#pfModel').fill('mock-model')
    // 协议分段（P4 Step 11）：切 Anthropic 再切回——表单协议面可交互（wire 层由 anthropic 单测覆盖）
    await page.locator('.proto-opt', { hasText: 'Anthropic' }).click()
    await expect(page.locator('.proto-opt.is-on', { hasText: 'Anthropic' })).toBeVisible()
    await page.locator('.proto-opt', { hasText: 'OpenAI 兼容' }).click()
    await page.getByRole('button', { name: '保存', exact: true }).click()
    await expect(page.locator('.cfg-row', { hasText: '坏端点' })).toBeVisible()

    await page.locator('.cfg-row', { hasText: '坏端点' }).locator('.btn', { hasText: '设为主力' }).click()
    await page.locator('.cfg-row', { hasText: 'E2E mock' }).locator('.btn', { hasText: '设为回退' }).click()
    await expect(page.locator('.cfg-row', { hasText: 'E2E mock' }).locator('.chip', { hasText: '回退' })).toBeVisible()

    // —— 发消息：主力连接拒绝 → 本轮自动降级 → 回退端点回复到达 ——
    await page.getByRole('button', { name: '控制台', exact: true }).click()
    await page.locator('.composer-box input').fill('走回退')
    await page.locator('.composer-box input').press('Enter')
    await expect(page.locator('.m-text', { hasText: '回退端点回复' }).first()).toBeVisible({ timeout: 30_000 })

    // 状态栏如实（P4 Step 11）：当轮生效端点 = 回退
    await expect(page.locator('.statusbar')).toContainText('当轮回退', { timeout: 10_000 })
  } finally {
    await mock.close()
    await app.close()
    await rm(userData, { recursive: true, force: true }).catch(() => {})
  }
})

test('Boxes/图谱小项（P4 Step 12）：归属 chip + box-claim shield + 节点状态点 + hover 退隐 + 详情 kv', async () => {
  const mock = await startMockOpenAi([
    // 单步：host_fetch 触发审批闸门 → run 稳定挂 running（归属 chip / 状态点的稳定工作中事实源）
    { match: (l) => l.role === 'user', toolCalls: [{ id: 'c1', name: 'host_fetch', args: { url: 'https://example.com/' } }] },
  ])
  const userData = await mkdtemp(join(tmpdir(), 'openbot-e2e-p4s12-'))
  const app = await _electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      OPENBOT_USER_DATA: userData,
      // 第二节点：worker1 无消息无边——hover 退隐断言的「无关节点」来源（免走向导）
      OPENBOT_EXTRA_AGENTS: 'worker1',
      OPENBOT_SANDBOX: 'mock',
    },
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

    // 发消息 → 审批挂起（run 稳定 running）；「稍后处理」收掉模态
    await page.getByRole('button', { name: '控制台', exact: true }).click()
    await page.locator('.composer-box input').fill('抓个网页')
    await page.locator('.composer-box input').press('Enter')
    const modal = page.locator('.approval-modal', { hasText: 'host_fetch' })
    await expect(modal).toBeVisible({ timeout: 30_000 })
    await modal.getByRole('button', { name: '稍后处理' }).click()

    // —— Box 卡归属 chip（roster.boxId × runs 投影）：管家工作中 + stat-dot 身份色在场 ——
    await page.getByRole('button', { name: 'Box', exact: true }).click()
    const ownerChip = page.locator('.boxcard .chip', { hasText: '管家工作中' })
    await expect(ownerChip).toBeVisible({ timeout: 15_000 })
    await expect(ownerChip.locator('.stat-dot')).toBeVisible()

    // box-claim：shield 形态（svg 图标 + 如实叙事在场）
    await expect(page.locator('.box-claim svg')).toBeVisible()
    await expect(page.locator('.box-claim')).toContainText('本机云电脑')

    // —— 图谱状态点（runs 投影）：管家 working（run 挂起中）/ worker1 idle ——
    await page.getByRole('button', { name: '图谱', exact: true }).click()
    const gnodeOf = (label: string) => page.locator('.graph-canvas .gnode', { hasText: label })
    await expect(gnodeOf('管家').locator('.gstatus.working')).toBeVisible({ timeout: 15_000 })
    await expect(gnodeOf('worker1').locator('.gstatus.idle')).toBeVisible()

    // hover 退隐：悬停无关系的 worker1 → 非邻接的 user/管家淡出，自身保持
    await gnodeOf('worker1').hover()
    await expect(gnodeOf('你')).toHaveClass(/is-dim/)
    await expect(gnodeOf('管家')).toHaveClass(/is-dim/)
    await expect(gnodeOf('worker1')).not.toHaveClass(/is-dim/)
    // 移开回落：无聚焦态时全亮（hover 清空）
    await page.locator('.graph-canvas').hover({ position: { x: 8, y: 8 } })
    await expect(gnodeOf('你')).not.toHaveClass(/is-dim/)

    // 节点详情 kv：状态=工作中（run summary 附注不误伤前缀断言）+ 模型=继承全局主力（provider 真值）
    await gnodeOf('管家').click()
    const side = page.locator('.graph-side')
    await expect(side.locator('.kv', { hasText: '状态' })).toContainText('工作中')
    await expect(side.locator('.kv', { hasText: '模型' })).toContainText('继承全局主力（E2E mock · mock-model）')
  } finally {
    await mock.close()
    await app.close()
    await rm(userData, { recursive: true, force: true }).catch(() => {})
  }
})

test('平台裁剪（P6 Step 5）：win 上 nspawn/UTM 不出现——探测列表即 UI 呈现源，零 if 平台特判', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'openbot-e2e-platform-'))
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
    await page.getByRole('button', { name: '设置', exact: true }).click()

    // win 探测列表（probeAll 平台裁剪）：mock/wsl/docker/podman 在场，nspawn/utm 不探——
    // 选项集与探测区同源（探测事实驱动），两处都不得出现异平台后端
    await expect(page.locator('.sandbox-row', { hasText: 'systemd-nspawn' })).toHaveCount(0)
    await expect(page.locator('.sandbox-row', { hasText: 'UTM' })).toHaveCount(0)
    await expect(page.locator('.sandbox-probe', { hasText: 'systemd-nspawn' })).toHaveCount(0)
    await expect(page.locator('.sandbox-probe', { hasText: 'UTM' })).toHaveCount(0)
    // 本平台候选在场：WSL2 选项（探测项不问可用性——不可用时选项在、选中如实降级）
    await expect(page.locator('.sandbox-row', { hasText: 'WSL2' })).toHaveCount(1)
    // 探测并入列表行后（0.1.2 改版）：mock 行恒在（确定性地基），无独立探测区
    await expect(page.locator('.sandbox-row', { hasText: '模拟' })).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('.sandbox-probe')).toHaveCount(0)
  } finally {
    await app.close()
    await rm(userData, { recursive: true, force: true }).catch(() => {})
  }
})

test('记忆（backlog ①）：save_memory 落盘 → 重启注入新会话系统提示 → ctx 档案呈现', async () => {
  const SAVED = '用户偏好深色主题与简洁回复'
  const mock = await startMockOpenAi([
    // 第一段：管家收到「记住我的偏好」→ 调 save_memory → 终答（剧本按首命中取——两段 user 消息按内容区分）
    {
      match: (l) => l.role === 'user' && l.content === '记住我的偏好',
      toolCalls: [{ id: 'c1', name: 'save_memory', args: { text: SAVED, kind: '偏好' } }],
    },
    { match: (_l, t) => t === 'save_memory', text: '已记住你的偏好。' },
    // 第二段（重启后）：新会话开场——终答即可（系统提示断言走 mock.requests 留痕）
    { match: (l) => l.role === 'user' && l.content === '新会话开场', text: '重启后的新对话' },
  ])
  const userData = await mkdtemp(join(tmpdir(), 'openbot-e2e-memory-'))
  const launchOpts = {
    args: ['.'] as const,
    env: { ...process.env, OPENBOT_USER_DATA: userData, OPENBOT_SANDBOX: 'mock' },
  }

  // 第一段：对话中 save_memory
  const app1 = await _electron.launch(launchOpts)
  const page1 = await app1.firstWindow()
  try {
    await expect(page1.locator('.app')).toHaveAttribute('data-connected', 'true', { timeout: 30_000 })
    // 配 provider（mock 端点）——其余用例同款
    await page1.getByRole('button', { name: '设置', exact: true }).click()
    await page1.getByRole('button', { name: '＋ 添加模型' }).click()
    await page1.locator('#pfName').fill('E2E mock')
    await page1.locator('#pfUrl').fill(`http://127.0.0.1:${mock.port}/v1`)
    await page1.locator('#pfModel').fill('mock-model')
    await page1.getByRole('button', { name: '保存', exact: true }).click()
    await page1.locator('.cfg-row .btn', { hasText: '设为主力' }).click()
    await page1.getByRole('button', { name: '控制台', exact: true }).click()
    await page1.locator('.composer-box input').fill('记住我的偏好')
    await page1.locator('.composer-box input').press('Enter')
    await expect(page1.locator('.m-text', { hasText: '已记住你的偏好' })).toBeVisible({ timeout: 30_000 })
    // ctx 档案：记忆节呈现该条（kind 徽标 + 文本）
    await page1.getByTitle('会话档案（Settings）').click()
    await expect(page1.locator('.mem-row', { hasText: SAVED })).toBeVisible({ timeout: 10_000 })
    await expect(page1.locator('.mem-row .mem-kind', { hasText: '偏好' })).toBeVisible()
  } finally {
    await app1.close()
  }

  // 第二段：重启（同 userData）→ 新对话 → 系统提示注入「此前记忆」
  const app2 = await _electron.launch(launchOpts)
  const page2 = await app2.firstWindow()
  try {
    await expect(page2.locator('.app')).toHaveAttribute('data-connected', 'true', { timeout: 30_000 })
    const reqBefore = mock.requests.length
    await page2.locator('.composer-box input').fill('新会话开场')
    await page2.locator('.composer-box input').press('Enter')
    await expect(page2.locator('.m-text', { hasText: '重启后的新对话' })).toBeVisible({ timeout: 30_000 })
    // 新会话的系统提示（messages[0].role=system）含注入节与保存文本
    const later = mock.requests.slice(reqBefore)
    const system = later.map((r) => r.messages[0]).find((m) => (m as { role?: string }).role === 'system')
    expect(JSON.stringify(system)).toContain('## 此前记忆')
    expect(JSON.stringify(system)).toContain(SAVED)
    // 重启后 ctx 记忆节同样在场（持久化真相）
    await page2.getByTitle('会话档案（Settings）').click()
    await expect(page2.locator('.mem-row', { hasText: SAVED })).toBeVisible({ timeout: 10_000 })
  } finally {
    await app2.close()
    await mock.close()
    await rm(userData, { recursive: true, force: true }).catch(() => {})
  }
})

test('定时自动化（backlog ②）：规则创建（模态+cron 预览）→ 到点触发走 user lane → ctx 呈现', async () => {
  const mock = await startMockOpenAi([
    // 自动化触发的委托消息（user 消息进管家会话）→ 终答
    { match: (l) => l.role === 'user' && l.content === '汇报昨天的任务', text: '自动化完成：昨日无事发生' },
  ])
  const userData = await mkdtemp(join(tmpdir(), 'openbot-e2e-auto-'))
  const app = await _electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      OPENBOT_USER_DATA: userData,
      OPENBOT_SANDBOX: 'mock',
      OPENBOT_AUTOMATION_INTERVAL: '1000', // 扫描周期缩到 1s（E2E 确定性）
    },
  })
  const page = await app.firstWindow()
  try {
    await expect(page.locator('.app')).toHaveAttribute('data-connected', 'true', { timeout: 30_000 })
    // 配 provider
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.getByRole('button', { name: '＋ 添加模型' }).click()
    await page.locator('#pfName').fill('E2E mock')
    await page.locator('#pfUrl').fill(`http://127.0.0.1:${mock.port}/v1`)
    await page.locator('#pfModel').fill('mock-model')
    await page.getByRole('button', { name: '保存', exact: true }).click()
    await page.locator('.cfg-row .btn', { hasText: '设为主力' }).click()

    // 新建自动化（模态：cron 预览在场）
    await page.getByRole('button', { name: '＋ 新建', exact: true }).click()
    await expect(page.locator('.wiz-overlay .wiz-title')).toHaveText('新建自动化')
    await page.locator('.wiz-overlay input.mono').fill('* * * * *')
    await expect(page.locator('.cron-preview')).toContainText('下次触发', { timeout: 10_000 })
    await page.locator('.wiz-overlay input').first().fill('每分钟汇报')
    await page.locator('.wiz-overlay textarea').fill('汇报昨天的任务')
    await page.getByRole('button', { name: '保存', exact: true }).click()
    await expect(page.locator('.setrow', { hasText: '每分钟汇报' })).toBeVisible({ timeout: 10_000 })

    // 到点触发（1s 扫描 + 最长 70s 等下一个分钟边界）：管家会话收到委托并回复
    await page.getByRole('button', { name: '控制台', exact: true }).click()
    await expect(page.locator('.m-text', { hasText: '自动化完成：昨日无事发生' })).toBeVisible({ timeout: 75_000 })
    // 委托文本在管家会话内（user 消息形态）
    await expect(page.locator('.m.user .m-text', { hasText: '汇报昨天的任务' })).toBeVisible()

    // ctx 档案：自动化节呈现该规则
    await page.getByTitle('会话档案（Settings）').click()
    await expect(page.locator('.mem-row', { hasText: '每分钟汇报' })).toBeVisible()
  } finally {
    await app.close()
    await mock.close()
    await rm(userData, { recursive: true, force: true }).catch(() => {})
  }
})

test('per-agent 模型覆盖（backlog ③）：向导选覆盖端点 → 该 agent 走第二端点（双 mock 断言分流）+ ctx 真值', async () => {
  // 双端点：主力 A（管家继承）；覆盖 B（新 agent 钉住）
  const mockA = await startMockOpenAi([{ match: (l) => l.role === 'user', text: '主力端点的回复' }])
  const mockB = await startMockOpenAi([{ match: (l) => l.role === 'user', text: '覆盖端点的回复' }])
  const userData = await mkdtemp(join(tmpdir(), 'openbot-e2e-override-'))
  const app = await _electron.launch({
    args: ['.'],
    env: { ...process.env, OPENBOT_USER_DATA: userData, OPENBOT_SANDBOX: 'mock' },
  })
  const page = await app.firstWindow()
  const addProvider = async (name: string, port: number): Promise<void> => {
    await page.getByRole('button', { name: '＋ 添加模型' }).click()
    await page.locator('#pfName').fill(name)
    await page.locator('#pfUrl').fill(`http://127.0.0.1:${port}/v1`)
    await page.locator('#pfModel').fill('mock-model')
    await page.getByRole('button', { name: '保存', exact: true }).click()
    await expect(page.locator('.cfg-row', { hasText: name })).toBeVisible()
  }
  try {
    await expect(page.locator('.app')).toHaveAttribute('data-connected', 'true', { timeout: 30_000 })
    // 两个端点：主力-A 设为主力；覆盖-B 供选择
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await addProvider('主力A', mockA.port)
    await page.locator('.cfg-row', { hasText: '主力A' }).locator('.btn', { hasText: '设为主力' }).click()
    await addProvider('覆盖B', mockB.port)

    // 向导建 agent：第二步选覆盖 B
    await page.getByRole('button', { name: '控制台', exact: true }).click()
    await page.getByRole('button', { name: '新建 agent' }).click()
    await page.locator('#wizName').fill('专属模型员')
    await page.getByRole('button', { name: '下一步' }).click()
    await page.locator('.wiz-select').selectOption('覆盖B')
    await expect(page.locator('.wiz-note', { hasText: '钉住所选端点' })).toBeVisible()
    await page.getByRole('button', { name: '下一步' }).click()
    await page.getByRole('button', { name: '创建 agent' }).click()
    await expect(page.locator('.roster-item', { hasText: '专属模型员' })).toBeVisible({ timeout: 15_000 })

    // 对新 agent 发消息 → B 端点收到（A 不收该 agent 的请求）
    await page.locator('.roster-item', { hasText: '专属模型员' }).click()
    await page.locator('.composer-box input').fill('你好，走哪个端点')
    await page.locator('.composer-box input').press('Enter')
    await expect(page.locator('.m-text', { hasText: '覆盖端点的回复' })).toBeVisible({ timeout: 30_000 })
    expect(mockB.requests.length).toBeGreaterThanOrEqual(1)
    expect(mockA.requests.length).toBe(0) // 管家还没说话——A 零请求

    // ctx 档案：模型 kv 真值（覆盖：覆盖B）
    await page.getByTitle('会话档案（Settings）').click()
    await expect(page.locator('.ctx .kv', { hasText: '模型' })).toContainText('覆盖：覆盖B')

    // 对照：管家（继承）对话 → A 端点
    await page.locator('.ctx-back').click()
    await page.locator('.roster-item', { hasText: '管家' }).click()
    await page.locator('.composer-box input').fill('管家走主力')
    await page.locator('.composer-box input').press('Enter')
    await expect(page.locator('.m-text', { hasText: '主力端点的回复' })).toBeVisible({ timeout: 30_000 })
    expect(mockA.requests.length).toBeGreaterThanOrEqual(1)
  } finally {
    await app.close()
    await mockA.close()
    await mockB.close()
    await rm(userData, { recursive: true, force: true }).catch(() => {})
  }
})

test('computer-use（plan-computer-use）：工具注册门 + 截图回喂 image part + 接管锁状态机', async () => {
  const mock = await startMockOpenAi([
    // 第一轮：调 computer_screenshot →（工具回喂图）第二轮断言收到 image part 后终答
    {
      match: (l) => l.role === 'user' && l.content === '看看桌面',
      toolCalls: [{ id: 'c1', name: 'computer_screenshot', args: {} }],
    },
    { match: (_l, t) => t === 'computer_screenshot', text: '桌面已看到（mock 容器）' },
  ])
  const userData = await mkdtemp(join(tmpdir(), 'openbot-e2e-computer-'))
  const app = await _electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      OPENBOT_USER_DATA: userData,
      OPENBOT_SANDBOX: 'mock',
      OPENBOT_COMPUTER: '1', // 工具族注册门（E2E 显式开）
    },
  })
  const page = await app.firstWindow()
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
    await page.locator('.composer-box input').fill('看看桌面')
    await page.locator('.composer-box input').press('Enter')
    await expect(page.locator('.m-text', { hasText: '桌面已看到' })).toBeVisible({ timeout: 30_000 })
    // 第二轮请求（工具回喂后）的 tool 消息含 image_url part（openai-compat wire——mock 后端
    // 的 exec 输出即 base64 位——链路形状断言而非图像有效性）
    const second = mock.requests.at(-1)
    const toolMsg = second?.messages.find((m) => (m as { role?: string }).role === 'tool')
    expect(JSON.stringify(toolMsg)).toContain('image_url')
    expect(JSON.stringify(toolMsg)).toContain('data:image/jpeg;base64,')
    // GUI 视图在场（computerEnabled）+ 接管状态机走真实 UI 链路：
    // 开 GUI 视图 → 点视口（mousedown = 用户输入 → 内核置锁）→「你已接管」→ 交还 → 回落
    await expect(page.locator('.gui-toggle')).toBeVisible({ timeout: 10_000 })
    await page.locator('.gui-toggle').click()
    await expect(page.locator('.gui-screen')).toBeVisible()
    await expect(page.locator('.gui-state')).toContainText('旁观中')
    await page.locator('.gui-viewport').click({ position: { x: 100, y: 60 } })
    await expect(page.locator('.gui-state.is-takeover')).toContainText('你已接管', { timeout: 10_000 })
    await page.getByRole('button', { name: '交还 agent' }).click()
    await expect(page.locator('.gui-state')).toContainText('旁观中', { timeout: 10_000 })
  } finally {
    await app.close()
    await mock.close()
    await rm(userData, { recursive: true, force: true }).catch(() => {})
  }
})
