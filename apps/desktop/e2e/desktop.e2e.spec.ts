/**
 * 桌面全链路 E2E（plan-p2 Step 11）：mock openai 端点 + 真内核 Electron——
 * settings 表单配 provider → console 发消息 → steward A2A 派发 → worker Box exec →
 * 出 Box 审批弹窗 → 批准回写 → 最终回复；tasks/graph 视图的数据痕迹。
 * userData 隔离到临时目录（OPENBOT_USER_DATA），测试数据绝不进用户真实数据区。
 */
import { test, expect, _electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startMockOpenAi } from './mock-openai'

test('右键菜单（2026-10-16 微信式自绘）：编辑区上下文项 + 全选动作全链 + Esc/外点关闭 + 兜底调试组', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'openbot-e2e-ctxmenu-'))
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

    // —— 编辑区右键：编辑项 + 调试组沉底在场（撤销无输入史不放假项） ——
    const input = page.locator('.composer-box input')
    await input.fill('菜单全选目标文字')
    await input.click({ button: 'right' })
    await expect(page.locator('.ctxmenu')).toBeVisible()
    // 坐标对账·底部场景（2026-10-16 修复回归）：输入框在视口底 → 下溢出上翻，菜单底部贴光标
    // （曾因误减 contentBounds 致菜单偏移整个窗口位、离光标很远）
    const inputBox = await input.boundingBox()
    const bottomMenu = await page.locator('.ctxmenu').boundingBox()
    expect(Math.abs(bottomMenu.y + bottomMenu.height - (inputBox.y + inputBox.height / 2))).toBeLessThanOrEqual(2)
    await expect(page.locator('.cm-item', { hasText: '全选' })).toBeVisible()
    await expect(page.locator('.cm-item', { hasText: '开发者工具' })).toBeVisible()
    await expect(page.locator('.cm-item', { hasText: '剪切' })).toHaveCount(0) // flags 显隐——无选区不放假项（撤销受 fill 的 undo 栈影响不稳,不断言）
    await page.keyboard.press('Escape')

    // —— 坐标对账·中部场景：流区中部右键 → 菜单贴合光标右下 +2px ——
    const streamBox = await page.locator('.stream').boundingBox()
    const midX = streamBox.x + streamBox.width / 2
    const midY = streamBox.y + streamBox.height / 2
    await page.mouse.click(midX, midY, { button: 'right' })
    await expect(page.locator('.ctxmenu')).toBeVisible()
    const midMenu = await page.locator('.ctxmenu').boundingBox()
    expect(Math.abs(midMenu.x - midX - 2)).toBeLessThanOrEqual(2)
    expect(Math.abs(midMenu.y - midY - 2)).toBeLessThanOrEqual(2)
    await page.keyboard.press('Escape')
    await expect(page.locator('.ctxmenu')).toHaveCount(0)

    // —— 全选动作全链：菜单点击 → preload 回传 → main webContents.selectAll → 焦点元素（防失焦关键路径） ——
    await input.press('End') // 先取消既有选区（fill 后光标在尾，无选区）
    await input.click({ button: 'right' })
    await page.locator('.cm-item', { hasText: '全选' }).click()
    const sel = await input.evaluate((el) => {
      const i = el as HTMLInputElement
      return { start: i.selectionStart, end: i.selectionEnd, len: i.value.length }
    })
    expect(sel.start).toBe(0)
    expect(sel.end).toBe(sel.len)

    // —— 流区右键（无编辑无选中）：只调试组（检查元素/重载/DevTools） ——
    await page.locator('.stream').click() // 先清 input 选区与焦点（防 selectionText 混入菜单）
    await page.locator('.stream').click({ button: 'right' })
    await expect(page.locator('.ctxmenu')).toBeVisible()
    await expect(page.locator('.cm-item')).toHaveCount(3)

    // —— Esc 关闭 + 外点关闭 ——
    await page.keyboard.press('Escape')
    await expect(page.locator('.ctxmenu')).toHaveCount(0)
    await input.click({ button: 'right' })
    await expect(page.locator('.ctxmenu')).toBeVisible()
    await page.locator('.stream-head').click()
    await expect(page.locator('.ctxmenu')).toHaveCount(0)
  } finally {
    await app.close()
    await rm(userData, { recursive: true, force: true }).catch(() => {})
  }
})

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
    // 3. worker1 收 exec 结果 → 文本完成（reasoning 供思考卡断言——v0.1.48 thinking 存真思考）
    { match: (_l, t) => t === 'exec', text: '目录是空的', reasoning: '执行结果回来了，目录是空的。' },
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
    await page.getByRole('button', { name: '＋ 添加供应商' }).click()
    await page.locator('#pfName').fill('E2E mock')
    await page.locator('#pfUrl').fill(`http://127.0.0.1:${mock.port}/v1`)
    await page.getByRole('button', { name: '＋ 添加模型' }).click()
    await page.locator('#pfModel').fill('mock-model')
    await page.locator('#pfModel').press('Enter')
    await page.getByRole('button', { name: '保存', exact: true }).click()
    await expect(page.locator('.llm-nav-item[data-provider="E2E mock"]')).toBeVisible()
    await expect(page.locator('.llm-nav-item[data-provider="E2E mock"] .llm-nav-dot.on')).toBeVisible() // 默认 = 状态点点亮
    // 沙箱后端：OPENBOT_SANDBOX=mock env 覆盖 → 装配链路落在 mock（不依赖宿主 WSL/Docker）——
    // 默认沙箱状态卡呈现（P8-4 后 UI 优化：全局偏好选择退役，per-backend 可用性 + caps）
    await page.locator('.settings-nav-item', { hasText: '容器与镜像' }).click() // 切换式导航
    await expect(page.locator('.backend-row', { hasText: '模拟' })).toBeVisible() // v0.1.53 默认沙箱卡退役——后端清单行呈现

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
    await expect(page.locator('.think', { hasText: '执行结果回来了' }).first()).toBeVisible({ timeout: 15_000 }) // v0.1.48：思考卡显示真思考（reasoning；.first 容双块镜像）
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

    // —— tasks：两个 run 的痕迹（用户消息通道的 steward + worker1） ——
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
    await page.getByRole('button', { name: '＋ 添加供应商' }).click()
    await page.locator('#pfName').fill('E2E mock')
    await page.locator('#pfUrl').fill(`http://127.0.0.1:${mock.port}/v1`)
    await page.getByRole('button', { name: '＋ 添加模型' }).click()
    await page.locator('#pfModel').fill('mock-model')
    await page.locator('#pfModel').press('Enter')
    await page.getByRole('button', { name: '保存', exact: true }).click()

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
    // llm 第二轮不发起：mock 端点只收到过第一次对话请求（会话标题请求按 title 标记排除）
    expect(mock.requests.filter((r) => !r.title).length).toBe(1)
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
    await expect(page.locator('.statusbar')).toContainText('内核已连接')
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
    await page.getByRole('button', { name: '＋ 添加供应商' }).click()
    await page.locator('#pfName').fill('E2E mock')
    await page.locator('#pfUrl').fill(`http://127.0.0.1:${mock.port}/v1`)
    await page.getByRole('button', { name: '＋ 添加模型' }).click()
    await page.locator('#pfModel').fill('mock-model')
    await page.locator('#pfModel').press('Enter')
    await page.getByRole('button', { name: '保存', exact: true }).click()

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
    await page.getByRole('button', { name: '＋ 添加供应商' }).click()
    await page.locator('#pfName').fill('E2E mock')
    await page.locator('#pfUrl').fill(`http://127.0.0.1:${mock.port}/v1`)
    await page.getByRole('button', { name: '＋ 添加模型' }).click()
    await page.locator('#pfModel').fill('mock-model')
    await page.locator('#pfModel').press('Enter')
    await page.getByRole('button', { name: '保存', exact: true }).click()

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
    // 新轮（第2轮）首位成员：即时发言（落群流——顺序轮转的第一声）；reasoning 供私聊隔离断言
    // （群轮思考卡不得出现在成员私聊——2026-10-18 群过程归群修复）
    { match: (l) => l.role === 'user' && l.content.includes('· 第2轮]') && !l.content.includes('本轮已发言'), text: '新轮第一位发言', reasoning: '群轮思考不该进私聊' },
    // 轮转后续成员（上下文含「本轮已发言」）：[pass]
    { match: (l) => l.role === 'user' && l.content.includes('本轮已发言'), text: '[pass]' },
    // 第3轮全员 [pass]：无人发言 → 收敛 sysnote（首位 pass 后上下文仍空，同此步命中）
    { match: (l) => l.role === 'user' && l.content.includes('· 第3轮]') && !l.content.includes('本轮已发言'), text: '[pass]' },
    // 第4轮（群上下文清空后）：首位成员即时发言——历史断言见用例尾（清空点前内容不进请求）
    { match: (l) => l.role === 'user' && l.content.includes('· 第4轮]') && !l.content.includes('本轮已发言'), text: '清空后首答' },
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
    await page.getByRole('button', { name: '＋ 添加供应商' }).click()
    await page.locator('#pfName').fill('E2E mock')
    await page.locator('#pfUrl').fill(`http://127.0.0.1:${mock.port}/v1`)
    await page.getByRole('button', { name: '＋ 添加模型' }).click()
    await page.locator('#pfModel').fill('mock-model')
    await page.locator('#pfModel').press('Enter')
    await page.getByRole('button', { name: '保存', exact: true }).click()

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
    // 群空态（2026-10-15 用户需求）：建群注记不即刻呈现——空态与 Agent 同款（icon + 问候语）
    await expect(page.locator('.stream .placeholder')).toContainText('我们能帮您做些什么')
    // 群徽标已移除（2026-10-18 用户裁定：无信息量）——负断言防回归；状态行回落连接态
    await expect(page.locator('.sh-status .chip')).toHaveCount(0)
    await expect(page.locator('.sh-status')).toContainText('已连接')

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
    // 建群注记开聊后随流留痕（空态语义的另一面：有实质对话即呈现）
    await expect(page.locator('.sysnote', { hasText: '群「评审组」建立' })).toBeVisible()

    // —— 第3条消息（第3轮）：全员 [pass] → 收敛 sysnote ——
    await input.fill('第三轮全员沉默')
    await input.press('Enter')
    await expect(page.locator('.sysnote', { hasText: '全员 pass，本轮收敛' })).toBeVisible({ timeout: 15_000 })

    // 旧轮响应（延迟 2.6s）settle 后被代际丢弃——不落群流
    await page.waitForTimeout(2600)
    await expect(page.locator('.stream')).not.toContainText('旧轮发言不该出现')

    // —— 群上下文清空（2026-10-15 /clear 群语义修复）：界面清空 + 成员历史真清空 ——
    await input.fill('/clear')
    await input.press('Enter')
    // 清空注记落底账不呈现——空态复现（2026-10-15 群空态语义：无实质对话即空态）
    await expect(page.locator('.stream .placeholder', { hasText: '我们能帮您做些什么' })).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('.sysnote', { hasText: '上下文已清空' })).toHaveCount(0)
    // 清空点之前的群呈现移除（旧轮消息/注记消失——transcript append-only 留证）
    await expect(page.locator('.stream')).not.toContainText('第二轮议题打断')
    await expect(page.locator('.stream')).not.toContainText('全员 pass')
    // 再发消息（第4轮）：成员请求历史不含清空点前内容（上下文真清空——mock 请求留痕对账）
    await input.fill('第四轮新话题')
    await input.press('Enter')
    await expect(page.locator('.m-text.md', { hasText: '清空后首答' })).toBeVisible({ timeout: 15_000 })
    const round4 = mock.requests.filter((r) =>
      (r.messages as Array<{ role: string; content: string }>).some((m) => m.content.includes('· 第4轮]')),
    )
    expect(round4.length).toBeGreaterThan(0)
    const round4History = round4
      .map((r) => (r.messages as Array<{ content?: string }>).map((m) => m.content ?? '').join('\n'))
      .join('\n')
    expect(round4History).not.toContain('第一轮议题')
    expect(round4History).not.toContain('新轮第一位发言')
    expect(round4History).toContain('第四轮新话题')

    // —— 名册群组节：条目在场且 active（群会话中） ——
    await expect(page.locator('.roster-sec', { hasText: '群组' })).toBeVisible()
    await expect(page.locator('.roster-item.active', { hasText: '评审组' })).toBeVisible()

    // —— ctx 群成员屏（2026-10-15 语义修正：每个 Agent 一块可控制屏幕——原「群聊无 Box」静态屏退役）+ 群档案 ——
    await expect(page.locator('.cg-screen')).toHaveCount(2) // 管家 + worker1
    await expect(page.locator('.cg-screen', { hasText: '管家' })).toBeVisible()
    await expect(page.locator('.cg-screen', { hasText: 'worker1' })).toBeVisible()
    // 提示条与私聊屏同款（2026-10-15 用户裁定对齐：cs-hint 在场——GUI 按钮受能力门不呈现在此验证不了）
    await expect(page.locator('.cg-screen .cs-hint').first()).toContainText('点击进入 Box 操作台')
    await page.getByTitle('会话档案').click()
    await expect(page.locator('.ctx-name')).toHaveText('评审组')
    await expect(page.locator('.ctx-sec', { hasText: '成员' })).toBeVisible()
    await expect(page.locator('.edge-row', { hasText: 'worker1' })).toBeVisible()
    await expect(page.locator('.ctx .kv', { hasText: '群记录上限 200 条' })).toBeVisible()
    await page.locator('.ctx-back').click()

    // —— 图谱菱形节点：群节点（ggroup 菱形）+ 群边在场 ——
    await page.getByRole('button', { name: '图谱', exact: true }).click()
    await expect(page.locator('.ggroup')).toBeVisible()
    await expect(page.locator('.gnode[aria-label*="评审组"]')).toBeVisible()

    // —— 群轮过程私聊隔离（2026-10-18 修复）：成员私聊视图零群痕迹 ——
    // 切到管家私聊（群轮首位发言人）：群消息（relay 行）、思考卡、正文预览均不在场——
    // 修复前群终答以 relay 行 + 预览气泡双重呈现、reasoning 落成员档案被投影成思考卡
    await page.getByRole('button', { name: '控制台', exact: true }).click()
    await page.locator('.roster-item', { hasText: '管家' }).first().click()
    await expect(page.locator('.sh-name')).toHaveText('管家')
    await expect(page.locator('.stream')).not.toContainText('新轮第一位发言')
    await expect(page.locator('.stream')).not.toContainText('清空后首答')
    await expect(page.locator('.stream')).not.toContainText('群轮思考不该进私聊')
    await expect(page.locator('.think')).toHaveCount(0)
    await expect(page.locator('.relay')).toHaveCount(0)
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

  // —— 第一段会话：配 provider → 新建 Agent（持久化名册）→ 与管家对话一轮（建边）——
  const app1 = await _electron.launch(launchOpts)
  const page1 = await app1.firstWindow()
  page1.on('pageerror', (e) => console.log('[pageerror]', e.message))
  try {
    await expect(page1.locator('.app')).toHaveAttribute('data-connected', 'true', { timeout: 30_000 })

    await page1.getByRole('button', { name: '设置', exact: true }).click()
    await page1.getByRole('button', { name: '＋ 添加供应商' }).click()
    await page1.locator('#pfName').fill('E2E mock')
    await page1.locator('#pfUrl').fill(`http://127.0.0.1:${mock.port}/v1`)
    await page1.getByRole('button', { name: '＋ 添加模型' }).click()
    await page1.locator('#pfModel').fill('mock-model')
    await page1.locator('#pfModel').press('Enter')
    await page1.getByRole('button', { name: '保存', exact: true }).click()

    await page1.getByRole('button', { name: '控制台', exact: true }).click()
    await page1.getByRole('button', { name: '＋ 新建 Agent' }).click()
    const card = page1.locator('.wiz-card')
    await page1.locator('#wizName').fill('恢复员')
    await card.getByRole('button', { name: '下一步' }).click()
    await card.getByRole('button', { name: '下一步' }).click()
    await card.getByRole('button', { name: '创建 Agent' }).click()
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

test('新建 Agent 向导（P4 Step 5）：三步创建 → 名册档案色 → @提及收录 → 注册即建 Box', async () => {
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
    await page.getByRole('button', { name: '＋ 新建 Agent' }).click()
    const card = page.locator('.wiz-card')
    await expect(card).toBeVisible()
    await page.locator('#wizName').fill('欧米伽')
    // 角色默认研究员；身份色默认第 4 色（断言选中态——档案色断言依赖此值）
    await expect(card.locator('.wiz-swatch.is-sel')).toHaveAttribute('aria-label', '身份色 #3987e5')
    await card.getByRole('button', { name: '下一步' }).click()
    // 步 2：模型与沙箱如实说明（裁定 B/F——不放假选项；P8-4 起沙箱镜像可选绑定）
    await expect(card.locator('.wiz-body')).toContainText('默认模型（自动）')
    await expect(card.locator('.wiz-body')).toContainText('缺省用默认沙箱')
    await expect(card.locator('.wiz-body')).toContainText('绑定已注册的镜像')
    await card.getByRole('button', { name: '下一步' }).click()
    // 步 3：复核行（名字/角色/身份色/继承说明）
    await expect(card.locator('.wiz-body')).toContainText('欧米伽')
    await expect(card.locator('.wiz-body')).toContainText('研究员')
    await card.getByRole('button', { name: '创建 Agent' }).click()

    // —— 创建收敛：toast + 向导关闭 + 跳新会话（sh-name 切换）——
    await expect(page.locator('.toast', { hasText: '欧米伽」已创建' })).toBeVisible({ timeout: 15_000 })
    await expect(card).toHaveCount(0)
    await expect(page.locator('.sh-name')).toHaveText('欧米伽')

    // 名册出现新成员；小球身体渐变 = 档案色（v0.1.65 avatar 换 grok-ball：色进 SVG 渐变 stop，
    // 不再是 .avatar 内联底色；lite 引擎渐变 stop fill 直用传入 hex）
    const item = page.locator('.roster-item', { hasText: '欧米伽' })
    await expect(item).toBeVisible()
    const avatarSvg = await item.locator('.avatar svg').evaluate((el) => el.outerHTML)
    expect(avatarSvg).toContain('#3987e5')

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
    await page.getByRole('button', { name: '＋ 添加供应商' }).click()
    await page.locator('#pfName').fill('E2E mock')
    await page.locator('#pfUrl').fill(`http://127.0.0.1:${mock.port}/v1`)
    await page.getByRole('button', { name: '＋ 添加模型' }).click()
    await page.locator('#pfModel').fill('mock-model')
    await page.locator('#pfModel').press('Enter')
    await page.getByRole('button', { name: '保存', exact: true }).click()

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
    await page.getByRole('button', { name: '＋ 添加供应商' }).click()
    await page.locator('#pfName').fill('E2E mock')
    await page.locator('#pfUrl').fill(`http://127.0.0.1:${mock.port}/v1`)
    await page.getByRole('button', { name: '＋ 添加模型' }).click()
    await page.locator('#pfModel').fill('mock-model')
    await page.locator('#pfModel').press('Enter')
    await page.getByRole('button', { name: '保存', exact: true }).click()

    await page.getByRole('button', { name: '控制台', exact: true }).click()
    await page.locator('.composer-box input').fill('叫 worker1 报数')
    await page.locator('.composer-box input').press('Enter')
    await expect(page.locator('.m-text', { hasText: '已收到' })).toBeVisible({ timeout: 30_000 })

    // —— 进入档案模式：ctx-top（会话档案）+ 档案 kv 四行（全真值） ——
    await page.locator('.sh-icon[title="会话档案"]').click()
    const ctx = page.locator('.ctx')
    await expect(ctx.locator('.ctx-top-title')).toHaveText('会话档案')
    await expect(ctx.locator('.ctx-name')).toHaveText('管家')
    await expect(ctx.locator('.kv', { hasText: '角色' })).toContainText('管家（steward）')
    await expect(ctx.locator('.kv', { hasText: '模型' })).toContainText('默认模型（E2E mock · mock-model') // v2 供应商 1:N：粒度到模型
    await expect(ctx.locator('.kv', { hasText: 'Box 归属' })).toContainText(/box-\d+/)
    await expect(ctx.locator('.kv', { hasText: '权限现状' })).toContainText('出 Box 需批准（手工审批）')

    // 协作对象（a2a 边投影）：worker1 行 + 计数；点击跳会话（档案模式随之重置回屏幕）
    const edge = ctx.locator('.edge-row', { hasText: 'worker1' })
    await expect(edge).toBeVisible()
    await expect(edge.locator('.cnt')).toHaveText(/×\d+/)
    await edge.click()
    await expect(page.locator('.sh-name')).toHaveText('worker1')
    await expect(page.locator('.ctx-screen')).toBeVisible()

    // 空缺态如实（记忆/自动化无数据源不放占位）；worker1 档案的协作对象也应有回边
    await page.locator('.sh-icon[title="会话档案"]').click()
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
    // 状态点（v0.1.36 文字徽标退役）——语义进 title：休眠 → title 文字断言
    await expect(page.locator('.cs-live')).toHaveAttribute('title', '休眠中')

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
    await page.getByRole('button', { name: '＋ 添加供应商' }).click()
    await page.locator('#pfName').fill('E2E mock')
    await page.locator('#pfUrl').fill(`http://127.0.0.1:${mock.port}/v1`)
    await page.getByRole('button', { name: '＋ 添加模型' }).click()
    await page.locator('#pfModel').fill('mock-model')
    await page.locator('#pfModel').press('Enter')
    await page.getByRole('button', { name: '保存', exact: true }).click()

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
    await page.locator('.settings-nav-item', { hasText: '数据' }).click() // 切换式导航
    await expect(page.locator('.set-sec', { hasText: '数据' })).toBeVisible()
    await expect(page.locator('.kv', { hasText: '数据目录' })).toContainText('data')
    // 会话记录（v0.1.63 中文化，原标签 transcript）：默认随数据目录——路径含 agents
    await expect(page.locator('.kv', { hasText: '会话记录' })).toContainText('agents')
    await expect(page.getByRole('button', { name: '打开数据文件夹' })).toBeVisible()

    // —— 配置两端点：默认 = E2E mock（首个自动成为默认）；坏端点 = 必然连接失败 ——
    await page.locator('.settings-nav-item', { hasText: '模型设置' }).click() // 切换式导航（从数据分节切回模型分节）
    // 先 E2E mock（首个自动成为默认——回退链的落点）再坏端点；协议分段交互随 E2E mock 表单（P4 Step 11）
    await page.getByRole('button', { name: '＋ 添加供应商' }).click()
    await page.locator('#pfName').fill('E2E mock')
    await page.locator('#pfUrl').fill(`http://127.0.0.1:${mock.port}/v1`)
    await page.getByRole('button', { name: '＋ 添加模型' }).click()
    await page.locator('#pfModel').fill('mock-model')
    await page.locator('#pfModel').press('Enter')
    // 协议分段（P4 Step 11）：切 Anthropic 再切回——表单协议面可交互（wire 层由 anthropic 单测覆盖）
    await page.locator('.proto-opt', { hasText: 'Anthropic' }).click()
    await expect(page.locator('.proto-opt.is-on', { hasText: 'Anthropic' })).toBeVisible()
    await page.locator('.proto-opt', { hasText: 'OpenAI 兼容' }).click()
    await page.getByRole('button', { name: '保存', exact: true }).click()
    await page.getByRole('button', { name: '＋ 添加供应商' }).click()
    await page.locator('#pfName').fill('坏端点')
    await page.locator('#pfUrl').fill('http://127.0.0.1:9/v1')
    await page.getByRole('button', { name: '＋ 添加模型' }).click()
    await page.locator('#pfModel').fill('x')
    await page.locator('#pfModel').press('Enter')
    await page.getByRole('button', { name: '保存', exact: true }).click()
    await expect(page.locator('.llm-nav-item[data-provider="坏端点"]')).toBeVisible()

    // —— 向导创建绑定坏端点的 Agent：上游失败自动回退到默认模型（mock） ——
    await page.getByRole('button', { name: '控制台', exact: true }).click()
    await page.getByRole('button', { name: '＋ 新建 Agent' }).click()
    const bindCard = page.locator('.wiz-card')
    await expect(bindCard).toBeVisible()
    await bindCard.locator('#wizName').fill('回退员')
    await bindCard.getByRole('button', { name: '下一步' }).click()
    await bindCard.locator('.wiz-kv', { hasText: '模型' }).locator('select').selectOption('坏端点::x') // v2 复合键：供应商::模型（存量对位——原锚镜像下拉是 v0.1.28 旧形态）
    await bindCard.getByRole('button', { name: '下一步' }).click()
    await bindCard.getByRole('button', { name: '创建 Agent' }).click()
    await expect(page.locator('.toast', { hasText: '回退员」已创建' })).toBeVisible({ timeout: 15_000 })

    // —— 发消息：绑定的坏端点连接拒绝 → 自动回退到默认模型（mock）回复 ——
    await page.locator('.composer-box input').fill('走回退')
    await page.locator('.composer-box input').press('Enter')
    await expect(page.locator('.m-text', { hasText: '回退端点回复' }).first()).toBeVisible({ timeout: 30_000 })
    // 状态栏「当轮回退」断言随独立回退档退役（0.1.27：回退统一为「绑定模型 → 默认模型」链）
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
    await page.getByRole('button', { name: '＋ 添加供应商' }).click()
    await page.locator('#pfName').fill('E2E mock')
    await page.locator('#pfUrl').fill(`http://127.0.0.1:${mock.port}/v1`)
    await page.getByRole('button', { name: '＋ 添加模型' }).click()
    await page.locator('#pfModel').fill('mock-model')
    await page.locator('#pfModel').press('Enter')
    await page.getByRole('button', { name: '保存', exact: true }).click()

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

    // box-claim：shield 形态（svg 图标 + 如实叙事在场；v0.1.49 叙事迁移——执行载体三档语义）
    await expect(page.locator('.box-claim svg')).toBeVisible()
    await expect(page.locator('.box-claim')).toContainText('执行载体')

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

    // 节点详情 kv：状态=工作中（run summary 附注不误伤前缀断言）+ 模型=默认模型（provider 真值）
    await gnodeOf('管家').click()
    const side = page.locator('.graph-side')
    await expect(side.locator('.kv', { hasText: '状态' })).toContainText('工作中')
    await expect(side.locator('.kv', { hasText: '模型' })).toContainText('默认模型（E2E mock · mock-model）')
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
    await page.locator('.settings-nav-item', { hasText: '容器与镜像' }).click() // 切换式导航

    // win 探测列表（probeAll 平台裁剪）：mock/wsl/docker/podman 在场，nspawn/utm 不探——
    // 选项集与探测区同源（探测事实驱动），两处都不得出现异平台后端
    await expect(page.locator('.backend-row', { hasText: 'systemd-nspawn' })).toHaveCount(0)
    await expect(page.locator('.backend-row', { hasText: 'UTM' })).toHaveCount(0)
    await expect(page.locator('.sandbox-probe', { hasText: 'systemd-nspawn' })).toHaveCount(0)
    await expect(page.locator('.sandbox-probe', { hasText: 'UTM' })).toHaveCount(0)
    // 本平台候选在场：WSL2 选项（探测项不问可用性——不可用时选项在、选中如实降级）
    await expect(page.locator('.backend-row', { hasText: 'WSL2' })).toHaveCount(1)
    // 探测并入列表行后（0.1.2 改版）：mock 行恒在（确定性地基），无独立探测区
    await expect(page.locator('.backend-row', { hasText: '模拟' })).toBeVisible({ timeout: 15_000 })
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
    await page1.getByRole('button', { name: '＋ 添加供应商' }).click()
    await page1.locator('#pfName').fill('E2E mock')
    await page1.locator('#pfUrl').fill(`http://127.0.0.1:${mock.port}/v1`)
    await page1.getByRole('button', { name: '＋ 添加模型' }).click()
    await page1.locator('#pfModel').fill('mock-model')
    await page1.locator('#pfModel').press('Enter')
    await page1.getByRole('button', { name: '保存', exact: true }).click()
    await page1.getByRole('button', { name: '控制台', exact: true }).click()
    await page1.locator('.composer-box input').fill('记住我的偏好')
    await page1.locator('.composer-box input').press('Enter')
    await expect(page1.locator('.m-text', { hasText: '已记住你的偏好' })).toBeVisible({ timeout: 30_000 })
    // ctx 档案：记忆节呈现该条（kind 徽标 + 文本）
    await page1.getByTitle('会话档案').click()
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
    // 新会话的系统提示（messages[0].role=system）含注入节与保存文本（标题请求按 title 标记排除）
    const later = mock.requests.slice(reqBefore).filter((r) => !r.title)
    const system = later.map((r) => r.messages[0]).find((m) => (m as { role?: string }).role === 'system')
    expect(JSON.stringify(system)).toContain('## 此前记忆')
    expect(JSON.stringify(system)).toContain(SAVED)
    // 重启后 ctx 记忆节同样在场（持久化真相）
    await page2.getByTitle('会话档案').click()
    await expect(page2.locator('.mem-row', { hasText: SAVED })).toBeVisible({ timeout: 10_000 })
  } finally {
    await app2.close()
    await mock.close()
    await rm(userData, { recursive: true, force: true }).catch(() => {})
  }
})

test('定时自动化（backlog ②）：规则创建（模态+cron 预览）→ 到点触发走用户消息通道 → ctx 呈现', async () => {
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
    await page.getByRole('button', { name: '＋ 添加供应商' }).click()
    await page.locator('#pfName').fill('E2E mock')
    await page.locator('#pfUrl').fill(`http://127.0.0.1:${mock.port}/v1`)
    await page.getByRole('button', { name: '＋ 添加模型' }).click()
    await page.locator('#pfModel').fill('mock-model')
    await page.locator('#pfModel').press('Enter')
    await page.getByRole('button', { name: '保存', exact: true }).click()

    // 新建自动化（模态：cron 预览在场）——先切到自动化分节（切换式导航）
    await page.locator('.settings-nav-item', { hasText: '自动化' }).click()
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
    await page.getByTitle('会话档案').click()
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
    await page.getByRole('button', { name: '＋ 添加供应商' }).click()
    await page.locator('#pfName').fill(name)
    await page.locator('#pfUrl').fill(`http://127.0.0.1:${port}/v1`)
    await page.getByRole('button', { name: '＋ 添加模型' }).click()
    await page.locator('#pfModel').fill('mock-model')
    await page.locator('#pfModel').press('Enter')
    await page.getByRole('button', { name: '保存', exact: true }).click()
    await expect(page.locator('.llm-nav-item[data-provider="' + name + '"]')).toBeVisible()
  }
  try {
    await expect(page.locator('.app')).toHaveAttribute('data-connected', 'true', { timeout: 30_000 })
    // 两个端点：主力-A 设为主力；覆盖-B 供选择
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await addProvider('主力A', mockA.port)
    await addProvider('覆盖B', mockB.port)

    // 向导建 agent：第二步选覆盖 B
    await page.getByRole('button', { name: '控制台', exact: true }).click()
    await page.getByRole('button', { name: '新建 Agent' }).click()
    await page.locator('#wizName').fill('专属模型员')
    await page.getByRole('button', { name: '下一步' }).click()
    await page.locator('.wiz-kv', { hasText: '模型' }).locator('select').selectOption('覆盖B::mock-model') // v2 复合键：供应商::模型（限定模型下拉——P8-4 起向导有镜像下拉）
    await expect(page.locator('.wiz-note', { hasText: '钉住所选端点' })).toBeVisible()
    await page.getByRole('button', { name: '下一步' }).click()
    await page.getByRole('button', { name: '创建 Agent' }).click()
    await expect(page.locator('.roster-item', { hasText: '专属模型员' })).toBeVisible({ timeout: 15_000 })

    // 对新 agent 发消息 → B 端点收到（A 不收该 agent 的请求）
    await page.locator('.roster-item', { hasText: '专属模型员' }).click()
    await page.locator('.composer-box input').fill('你好，走哪个端点')
    await page.locator('.composer-box input').press('Enter')
    await expect(page.locator('.m-text', { hasText: '覆盖端点的回复' })).toBeVisible({ timeout: 30_000 })
    expect(mockB.requests.length).toBeGreaterThanOrEqual(1)
    expect(mockA.requests.length).toBe(0) // 管家还没说话——A 零请求

    // ctx 档案：模型 kv 真值（覆盖：覆盖B）
    await page.getByTitle('会话档案').click()
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
      OPENBOT_GUI_CODEC: 'mjpeg', // E2E 假流是 JPEG 字节——走 mjpeg 回退引擎（h264 引擎真机验收）
    },
  })
  const page = await app.firstWindow()
  try {
    await expect(page.locator('.app')).toHaveAttribute('data-connected', 'true', { timeout: 30_000 })
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.getByRole('button', { name: '＋ 添加供应商' }).click()
    await page.locator('#pfName').fill('E2E mock')
    await page.locator('#pfUrl').fill(`http://127.0.0.1:${mock.port}/v1`)
    await page.getByRole('button', { name: '＋ 添加模型' }).click()
    await page.locator('#pfModel').fill('mock-model')
    await page.locator('#pfModel').press('Enter')
    await page.getByRole('button', { name: '保存', exact: true }).click()
    // 编辑模型勾「视觉」（v2 存量对位：supportsImages 下沉模型级——未勾则截图回喂降级文本）
    await page.locator('button[title="编辑模型"]').first().click()
    await page.locator('label.proto-opt', { hasText: '视觉' }).click()
    await page.getByRole('button', { name: '保存', exact: true }).click()
    await page.getByRole('button', { name: '控制台', exact: true }).click()
    await page.locator('.composer-box input').fill('看看桌面')
    await page.locator('.composer-box input').press('Enter')
    await expect(page.locator('.m-text', { hasText: '桌面已看到' })).toBeVisible({ timeout: 30_000 })
    // 第二轮请求（工具回喂后）的 tool 消息含 image_url part（openai-compat wire——mock 后端
    // 的 exec 输出即 base64 位——链路形状断言而非图像有效性；标题请求按 title 标记排除）
    const second = mock.requests.filter((r) => !r.title).at(-1)
    const toolMsg = second?.messages.find((m) => (m as { role?: string }).role === 'tool')
    expect(JSON.stringify(toolMsg)).toContain('image_url')
    expect(JSON.stringify(toolMsg)).toContain('data:image/jpeg;base64,')
    // GUI 视图在场（computerEnabled）+ 接管状态机走真实 UI 链路（2026-09-04 裁定：接管入口
    // 收进 BoxOps 大屏）：开 GUI 视图 → 点小屏（冒泡开操作台）→ 大屏内点视口（首笔输入置锁）
    // →「你已接管」→ 接管真值单源（ctx 小屏同源呈现）→ 交还 → 两处回落旁观
    await expect(page.locator('.gui-toggle')).toBeVisible({ timeout: 10_000 })
    await page.locator('.gui-toggle').click()
    await expect(page.locator('.ctx-screen .gui-screen')).toBeVisible()
    await expect(page.locator('.ctx-screen .gui-state')).toContainText('旁观中')
    await page.locator('.ctx-screen .gui-viewport').click({ position: { x: 100, y: 60 } })
    await expect(page.locator('.boxops')).toBeVisible()
    await page.locator('.boxops .gui-viewport').click({ position: { x: 80, y: 50 } })
    await expect(page.locator('.boxops .gui-state.is-takeover')).toContainText('你已接管', { timeout: 10_000 })
    await expect(page.locator('.ctx-screen .gui-state')).toContainText('接管中', { timeout: 10_000 })
    await page.locator('.boxops').getByRole('button', { name: '交还 agent' }).click()
    await expect(page.locator('.boxops .gui-state')).toContainText('旁观中', { timeout: 10_000 })
    await expect(page.locator('.ctx-screen .gui-state')).toContainText('旁观中', { timeout: 10_000 })
  } finally {
    await app.close()
    await mock.close()
    await rm(userData, { recursive: true, force: true }).catch(() => {})
  }
})

test('GUI 实况流（plan-computer-use 二期）：大屏接管开流 → 30fps 帧到达 → 交还降频回落轮询', async () => {
  // 零 LLM 依赖：GUI 视图入口 = computerEnabled ∩ 名册 boxId（装配即建 Box）——mock 假 ffmpeg
  // 由 OPENBOT_COMPUTER=1 联动注入（mock 后端 pipe 替身：1x1 JPEG 每 150ms 一帧）。
  // 交互链路（2026-09-04 裁定）：ctx 小屏点击冒泡开 BoxOps 大屏，接管/实况都发生在大屏内
  const userData = await mkdtemp(join(tmpdir(), 'openbot-e2e-guistream-'))
  const app = await _electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      OPENBOT_USER_DATA: userData,
      OPENBOT_SANDBOX: 'mock',
      OPENBOT_COMPUTER: '1',
      OPENBOT_GUI_CODEC: 'mjpeg', // E2E 假流是 JPEG 字节——走 mjpeg 回退引擎（h264 引擎真机验收）
    },
  })
  const page = await app.firstWindow()
  try {
    await expect(page.locator('.app')).toHaveAttribute('data-connected', 'true', { timeout: 30_000 })
    await page.getByRole('button', { name: '控制台', exact: true }).click()
    await page.locator('.roster-item', { hasText: '管家' }).click()
    // GUI 视图在场：小屏旁观态（轮询帧源、流未开——小屏永不开流）
    await expect(page.locator('.gui-toggle')).toBeVisible({ timeout: 10_000 })
    await page.locator('.gui-toggle').click()
    await expect(page.locator('.ctx-screen .gui-screen')).toBeVisible()
    await expect(page.locator('.ctx-screen .gui-screen')).toHaveAttribute('data-stream', '0')
    // 点小屏 → 冒泡开操作台大屏（gui 模式）→ 大屏内点击接管 → watch 自动开流
    await page.locator('.ctx-screen .gui-viewport').click({ position: { x: 100, y: 60 } })
    await expect(page.locator('.boxops')).toBeVisible()
    await page.locator('.boxops .gui-viewport').click({ position: { x: 80, y: 50 } })
    await expect(page.locator('.boxops .gui-state.is-takeover')).toContainText('你已接管', { timeout: 10_000 })
    await expect(page.locator('.boxops .gui-screen')).toHaveAttribute('data-stream', '1', { timeout: 10_000 })
    // 帧到达：mock 150ms/帧——data-frames 计数递增（拆帧重组 + canvas 解码画帧的全链证据）
    await expect
      .poll(async () => {
        const v = await page.locator('.boxops .gui-viewport canvas').getAttribute('data-frames')
        return Number(v ?? '0')
      }, { timeout: 10_000 })
      .toBeGreaterThanOrEqual(2)
    // 交还 agent → 停流（服务端杀 ffmpeg）→ 大屏回落旁观轮询
    await page.locator('.boxops').getByRole('button', { name: '交还 agent' }).click()
    await expect(page.locator('.boxops .gui-screen')).toHaveAttribute('data-stream', '0', { timeout: 10_000 })
    await expect(page.locator('.boxops .gui-state')).toContainText('旁观中', { timeout: 10_000 })
  } finally {
    await app.close()
    await rm(userData, { recursive: true, force: true }).catch(() => {})
  }
})

test('镜像注册表（P8-3）：CRUD 全链 + 连接测试如实报告 + 多载体并存 + 重启持久化', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'openbot-e2e-images-'))
  const app = await _electron.launch({
    args: ['.'],
    env: { ...process.env, OPENBOT_USER_DATA: userData, OPENBOT_SANDBOX: 'mock' },
  })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => console.log('[pageerror]', e.message))
  try {
    await expect(page.locator('.app')).toHaveAttribute('data-connected', 'true', { timeout: 30_000 })
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.locator('.settings-nav-item', { hasText: '镜像' }).click() // 切换式导航

    // —— 添加 SSH 条目（真实 UI 全链；不可达主机——测试按钮须如实报失败，不假装可用） ——
    await page.getByRole('button', { name: '＋ 添加镜像' }).click()
    await page.locator('#ifName').fill('VMWare Ubuntu')
    await page.locator('#ifHost').fill('192.168.99.99')
    await page.locator('#ifPort').fill('2222')
    await page.locator('#ifUser').fill('ops')
    await page.locator('#ifKey').fill('C:/keys/vm.pem')
    await page.getByRole('button', { name: '保存', exact: true }).click()
    // 行定位用 data-image-id（新库首两条目确定性 id=img-1/img-2）——hasText 子串匹配会
    // 把改名后的「VMWare Ubuntu 2」也命中（E2E 首训踩坑）
    const sshRow = page.locator('.cfg-row[data-image-id="img-1"]')
    await expect(sshRow).toBeVisible()
    await expect(sshRow).toContainText('SSH')
    await expect(sshRow).toContainText('ops@192.168.99.99:2222')

    // —— 添加容器条目（多载体并存） ——
    await page.getByRole('button', { name: '＋ 添加镜像' }).click()
    await page.locator('label.proto-opt', { hasText: '容器镜像' }).click()
    await page.locator('#ifName').fill('GUI 容器')
    await page.locator('#ifImage').fill('openbot-gui:24.04')
    await page.getByRole('button', { name: '保存', exact: true }).click()
    const cRow = page.locator('.cfg-row', { hasText: 'GUI 容器' })
    await expect(cRow).toBeVisible()
    await expect(cRow).toContainText('容器')

    // —— 连接测试如实报告：ssh 不可达 / 容器在 mock 底座不可路由 —— 红色 chip 呈现原因 ——
    await sshRow.locator('[data-role="image-test"]').click()
    await expect(sshRow.locator('.chip-danger')).toBeVisible({ timeout: 30_000 })
    await cRow.locator('[data-role="image-test"]').click()
    await expect(cRow.locator('.chip-danger')).toBeVisible({ timeout: 30_000 })
    // chip 可见文本截断 24 字——全文在 title 属性（测试报告语义断言锚 title）
    await expect(cRow.locator('.chip-danger')).toHaveAttribute('title', /不可路由/)

    // —— 编辑：改条目名（同 id 路由替换对 UI 透明） ——
    await sshRow.locator('[data-role="image-edit"]').click()
    await page.locator('#ifName').fill('VMWare Ubuntu 2')
    await page.getByRole('button', { name: '保存', exact: true }).click()
    await expect(sshRow).toBeVisible() // 同 id 行就地更新（路由替换对 UI 透明）
    await expect(sshRow).toContainText('VMWare Ubuntu 2')
    const renamed = sshRow

    // —— 删除二段确认（误触保护）；容器条目并存不受影响 ——
    const del = renamed.locator('[data-role="image-remove"]')
    await del.click()
    await expect(del).toHaveText('确认删除？')
    await del.click()
    await expect(sshRow).toHaveCount(0)
    await expect(cRow).toBeVisible()

    // —— 重启持久化（双段会话）：images.json 是真相，重启后条目仍在 ——
    await app.close()
    const app2 = await _electron.launch({
      args: ['.'],
      env: { ...process.env, OPENBOT_USER_DATA: userData, OPENBOT_SANDBOX: 'mock' },
    })
    const page2 = await app2.firstWindow()
    try {
      await expect(page2.locator('.app')).toHaveAttribute('data-connected', 'true', { timeout: 30_000 })
      await page2.getByRole('button', { name: '设置', exact: true }).click()
      await page2.locator('.settings-nav-item', { hasText: '镜像' }).click() // 切换式导航
      await expect(page2.locator('.cfg-row', { hasText: 'GUI 容器' })).toBeVisible({ timeout: 10_000 })
    } finally {
      await app2.close()
    }
  } finally {
    await app.close()
    await rm(userData, { recursive: true, force: true }).catch(() => {})
  }
})

test('宿主屏幕载体（P9-1）：注册 + 内置注入协议呈现 + 真实测试报告 + 重启持久化（E2E 不真注入——裁定 G）', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'openbot-e2e-hostscreen-'))
  const app = await _electron.launch({
    args: ['.'],
    env: { ...process.env, OPENBOT_USER_DATA: userData, OPENBOT_SANDBOX: 'mock' },
  })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => console.log('[pageerror]', e.message))
  try {
    await expect(page.locator('.app')).toHaveAttribute('data-connected', 'true', { timeout: 30_000 })
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.locator('.settings-nav-item', { hasText: '镜像' }).click()

    // —— 注册宿主屏幕条目：载体单选 → 控制协议自动切「host」（联动）→ 零连接事实保存 ——
    await page.getByRole('button', { name: '＋ 添加镜像' }).click()
    await page.locator('label.proto-opt', { hasText: '宿主屏幕' }).click()
    await expect(page.locator('span.chip', { hasText: '宿主内置注入' })).toBeVisible() // 协议段切换为固定 chip
    await page.locator('#ifName').fill('本机屏幕')
    await page.getByRole('button', { name: '保存', exact: true }).click()
    const row = page.locator('.cfg-row[data-image-id="img-1"]')
    await expect(row).toBeVisible()
    await expect(row).toContainText('宿主屏幕') // 载体 chip
    await expect(row).toContainText('本机主屏（内置注入）') // 摘要（零连接事实）

    // —— 真实测试（有桌面会话即过）：几何 + 实况档位如实报告（green chip；全文在 title） ——
    await row.locator('[data-role="image-test"]').click()
    await expect(row.locator('.chip-success')).toBeVisible({ timeout: 30_000 })
    await expect(row.locator('.chip-success')).toHaveAttribute('title', /宿主屏幕就绪.*实况流/)

    // —— 绑定 agent（真实路径：创建即 attach——backend.list 才有 box，boxes 页才有行） ——
    await page.getByRole('button', { name: '控制台', exact: true }).click()
    await page.getByRole('button', { name: '＋ 新建 Agent' }).click()
    const wizCard = page.locator('.wiz-card')
    await expect(wizCard).toBeVisible()
    await page.locator('#wizName').fill('维屏')
    await wizCard.getByRole('button', { name: '下一步' }).click()
    await wizCard.locator('.wiz-kv', { hasText: '沙箱镜像' }).locator('select').selectOption('img-1')
    await wizCard.getByRole('button', { name: '下一步' }).click()
    await wizCard.getByRole('button', { name: '创建 Agent' }).click()
    await expect(page.locator('.toast', { hasText: '维屏」已创建' })).toBeVisible({ timeout: 15_000 })

    // —— boxes 视图渲染（v0.1.36 回归补盲：宿主屏幕 box 一度因联合外 state 值炸整页——
    //     渲染层无类型检查，视图覆盖是唯一防线） ——
    await page.getByRole('button', { name: 'Box', exact: true }).click()
    await expect(page.locator('.box-name', { hasText: 'hostscreen-img-1' })).toBeVisible({ timeout: 10_000 })

    // 回设置页继续编辑往返（Boxes 视图切换后导航回落控制台）
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.locator('.settings-nav-item', { hasText: '镜像' }).click()

    // —— 编辑往返：协议 chip 恒 host（表单回填不破坏载体语义）+ 窗口绑定枚举（P9-2） ——
    await row.locator('[data-role="image-edit"]').click()
    await expect(page.locator('span.chip', { hasText: '宿主内置注入' })).toBeVisible()
    // 枚举窗口（真实 EnumWindows——桌面会话必有顶层窗口；本应用窗口标题含 OpenBot）
    await page.locator('[data-role="enum-windows"]').click()
    await expect(page.locator('#ifWindow option')).not.toHaveCount(0)
    const winOptions = await page.locator('#ifWindow option').count()
    if (winOptions > 1) {
      // 环境相关：有窗口可选则绑定（子串匹配——窗口重开同名即恢复），无则保持整屏
      const openbotOption = page.locator('#ifWindow option', { hasText: 'OpenBot' })
      if ((await openbotOption.count()) > 0) {
        await page.locator('#ifWindow').selectOption({ label: (await openbotOption.textContent())! })
        await page.getByRole('button', { name: '保存', exact: true }).click()
        await expect(row).toContainText('窗口「OpenBot', { timeout: 10_000 })
        // 改回整屏（空选项 = 清除绑定）
        await row.locator('[data-role="image-edit"]').click()
        await page.locator('#ifWindow').selectOption('')
        await page.getByRole('button', { name: '保存', exact: true }).click()
        await expect(row).toContainText('本机主屏（内置注入）', { timeout: 10_000 })
      } else {
        await page.getByRole('button', { name: '取消', exact: true }).click()
      }
    } else {
      await page.getByRole('button', { name: '取消', exact: true }).click()
    }

    // —— 重启持久化（双段会话）+ 删除二段确认 ——
    await app.close()
    const app2 = await _electron.launch({
      args: ['.'],
      env: { ...process.env, OPENBOT_USER_DATA: userData, OPENBOT_SANDBOX: 'mock' },
    })
    const page2 = await app2.firstWindow()
    try {
      await expect(page2.locator('.app')).toHaveAttribute('data-connected', 'true', { timeout: 30_000 })
      await page2.getByRole('button', { name: '设置', exact: true }).click()
      await page2.locator('.settings-nav-item', { hasText: '镜像' }).click()
      const row2 = page2.locator('.cfg-row[data-image-id="img-1"]')
      await expect(row2).toBeVisible({ timeout: 10_000 })
      await expect(row2).toContainText('宿主屏幕')
      const del = row2.locator('[data-role="image-remove"]')
      await del.click()
      await expect(del).toHaveText('确认删除？')
      await del.click()
      await expect(row2).toHaveCount(0)
    } finally {
      await app2.close()
    }
  } finally {
    await app.close()
    await rm(userData, { recursive: true, force: true }).catch(() => {})
  }
})

test('Windows 机内载体（P9-3a）：注册 + 真实测试如实报告（不可达红 chip）+ 重启持久化', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'openbot-e2e-winssh-'))
  const app = await _electron.launch({
    args: ['.'],
    env: { ...process.env, OPENBOT_USER_DATA: userData, OPENBOT_SANDBOX: 'mock' },
  })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => console.log('[pageerror]', e.message))
  try {
    await expect(page.locator('.app')).toHaveAttribute('data-connected', 'true', { timeout: 30_000 })
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.locator('.settings-nav-item', { hasText: '镜像' }).click()

    // —— 注册 Windows 条目：载体单选 → 协议自动切 win（联动）→ 连接事实保存 ——
    await page.getByRole('button', { name: '＋ 添加镜像' }).click()
    await page.locator('label.proto-opt', { hasText: 'Windows 主机' }).click()
    await expect(page.locator('label.proto-opt', { hasText: 'Win 注入' })).toBeVisible() // 协议段切换
    await page.locator('#ifName').fill('Win 虚机')
    await page.locator('#ifHost').fill('192.168.99.30')
    await page.locator('#ifUser').fill('ops')
    await page.getByRole('button', { name: '保存', exact: true }).click()
    const row = page.locator('.cfg-row[data-image-id="img-1"]')
    await expect(row).toBeVisible()
    await expect(row).toContainText('Windows') // 载体 chip
    await expect(row).toContainText('ops@192.168.99.30') // 摘要（ssh 同形）

    // —— 真实测试：不可达主机如实红 chip（EncodedCommand 连通验证真实执行） ——
    await row.locator('[data-role="image-test"]').click()
    await expect(row.locator('.chip-danger')).toBeVisible({ timeout: 30_000 })
    await expect(row.locator('.chip-danger')).toHaveAttribute('title', /连接失败|超时|失败/)

    // —— 重启持久化（双段会话）+ 删除二段确认 ——
    await app.close()
    const app2 = await _electron.launch({
      args: ['.'],
      env: { ...process.env, OPENBOT_USER_DATA: userData, OPENBOT_SANDBOX: 'mock' },
    })
    const page2 = await app2.firstWindow()
    try {
      await expect(page2.locator('.app')).toHaveAttribute('data-connected', 'true', { timeout: 30_000 })
      await page2.getByRole('button', { name: '设置', exact: true }).click()
      await page2.locator('.settings-nav-item', { hasText: '镜像' }).click()
      const row2 = page2.locator('.cfg-row[data-image-id="img-1"]')
      await expect(row2).toBeVisible({ timeout: 10_000 })
      await expect(row2).toContainText('Windows')
      const del = row2.locator('[data-role="image-remove"]')
      await del.click()
      await expect(del).toHaveText('确认删除？')
      await del.click()
      await expect(row2).toHaveCount(0)
    } finally {
      await app2.close()
    }
  } finally {
    await app.close()
    await rm(userData, { recursive: true, force: true }).catch(() => {})
  }
})

test('Android 载体（P9-3b）：注册 + 真实测试如实报告（设备未在场红 chip）+ 重启持久化', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'openbot-e2e-adb-'))
  const app = await _electron.launch({
    args: ['.'],
    env: { ...process.env, OPENBOT_USER_DATA: userData, OPENBOT_SANDBOX: 'mock' },
  })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => console.log('[pageerror]', e.message))
  try {
    await expect(page.locator('.app')).toHaveAttribute('data-connected', 'true', { timeout: 30_000 })
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.locator('.settings-nav-item', { hasText: '镜像' }).click()

    // —— 注册 Android 条目：载体单选 → 协议自动切 android → 序列号保存 ——
    await page.getByRole('button', { name: '＋ 添加镜像' }).click()
    await page.locator('label.proto-opt', { hasText: 'Android 设备' }).click()
    await expect(page.locator('label.proto-opt', { hasText: 'Android 注入' })).toBeVisible()
    await page.locator('#ifName').fill('测试手机')
    await page.locator('#ifHost').fill('FAKE-SERIAL-9999')
    await page.getByRole('button', { name: '保存', exact: true }).click()
    const row = page.locator('.cfg-row[data-image-id="img-1"]')
    await expect(row).toBeVisible()
    await expect(row).toContainText('Android')
    await expect(row).toContainText('FAKE-SERIAL-9999')

    // —— 真实测试：设备未在场（或 adb CLI 缺席）如实红 chip——失败语义环境无关断言 ——
    await row.locator('[data-role="image-test"]').click()
    await expect(row.locator('.chip-danger')).toBeVisible({ timeout: 30_000 })
    await expect(row.locator('.chip-danger')).toHaveAttribute('title', /连接失败|adb devices|未在场|进程启动失败/)

    // —— 重启持久化 + 删除二段确认 ——
    await app.close()
    const app2 = await _electron.launch({
      args: ['.'],
      env: { ...process.env, OPENBOT_USER_DATA: userData, OPENBOT_SANDBOX: 'mock' },
    })
    const page2 = await app2.firstWindow()
    try {
      await expect(page2.locator('.app')).toHaveAttribute('data-connected', 'true', { timeout: 30_000 })
      await page2.getByRole('button', { name: '设置', exact: true }).click()
      await page2.locator('.settings-nav-item', { hasText: '镜像' }).click()
      const row2 = page2.locator('.cfg-row[data-image-id="img-1"]')
      await expect(row2).toBeVisible({ timeout: 10_000 })
      await expect(row2).toContainText('Android')
      const del = row2.locator('[data-role="image-remove"]')
      await del.click()
      await expect(del).toHaveText('确认删除？')
      await del.click()
      await expect(row2).toHaveCount(0)
    } finally {
      await app2.close()
    }
  } finally {
    await app.close()
    await rm(userData, { recursive: true, force: true }).catch(() => {})
  }
})

test('可用镜像探测：扫描报告来源事实（可用性 chip + 如实原因）+ 在场镜像注册预填', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'openbot-e2e-scan-'))
  const app = await _electron.launch({
    args: ['.'],
    env: { ...process.env, OPENBOT_USER_DATA: userData, OPENBOT_SANDBOX: 'mock' },
  })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => console.log('[pageerror]', e.message))
  try {
    await expect(page.locator('.app')).toHaveAttribute('data-connected', 'true', { timeout: 30_000 })
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.locator('.settings-nav-item', { hasText: '镜像' }).click() // 切换式导航

    // —— 扫描前无结果卡（按需触发——不自动跑用户机器上的 CLI） ——
    await expect(page.locator('[data-role="image-scan-result"]')).toHaveCount(0)

    // —— 点击扫描 → 结果卡出现：来源行（≥2）各带可用性 chip（事实因机器而异——语义断言环境无关） ——
    await page.locator('[data-role="image-scan"]').click()
    const resultCard = page.locator('[data-role="image-scan-result"]')
    await expect(resultCard).toBeVisible({ timeout: 60_000 }) // WSL 冷启动放宽
    const sourceRows = page.locator('[data-role="image-source"]')
    expect(await sourceRows.count()).toBeGreaterThanOrEqual(2)
    for (let i = 0; i < await sourceRows.count(); i++) {
      await expect(sourceRows.nth(i).locator('.chip')).toHaveText(/可用|不可用/)
    }

    // —— 在场镜像行（环境相关）：有则「注册」预填模态（载体=容器、镜像名回填），无则跳过 ——
    const scanRows = page.locator('[data-role="image-scan-row"]')
    const scanCount = await scanRows.count()
    if (scanCount > 0) {
      const ref = await scanRows.first().locator('.cfg-name').innerText()
      await scanRows.first().locator('[data-role="image-register"]').click()
      const modal = page.locator('.wiz-card[role="dialog"]')
      await expect(modal).toBeVisible()
      await expect(page.locator('#ifImage')).toHaveValue(ref.trim())
      await expect(modal.locator('label.proto-opt', { hasText: '容器镜像' })).toHaveClass(/is-on/)
      await modal.getByRole('button', { name: '取消' }).click()
      await expect(modal).toHaveCount(0)
    }
  } finally {
    await app.close()
    await rm(userData, { recursive: true, force: true }).catch(() => {})
  }
})

test('Agent 绑定镜像（P8-4）：向导绑定 → ctx 档案呈现 → 重启持久 → 删条目悬空如实回默认', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'openbot-e2e-bind-'))
  const app = await _electron.launch({
    args: ['.'],
    env: { ...process.env, OPENBOT_USER_DATA: userData, OPENBOT_SANDBOX: 'mock' },
  })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => console.log('[pageerror]', e.message))

  try {
    await expect(page.locator('.app')).toHaveAttribute('data-connected', 'true', { timeout: 30_000 })

    // —— 前置：注册一个容器镜像条目（mock 底座不可路由——注册落默认沙箱，绑定持久照常） ——
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.locator('.settings-nav-item', { hasText: '镜像' }).click() // 切换式导航
    await page.getByRole('button', { name: '＋ 添加镜像' }).click()
    await page.locator('label.proto-opt', { hasText: '容器镜像' }).click()
    await page.locator('#ifName').fill('GUI 容器')
    await page.locator('#ifImage').fill('openbot-gui:24.04')
    await page.getByRole('button', { name: '保存', exact: true }).click()
    await expect(page.locator('.cfg-row', { hasText: 'GUI 容器' })).toBeVisible()

    // —— 向导绑定镜像（步 2 下拉选 GUI 容器 → 复核显示 → 创建成功） ——
    await page.getByRole('button', { name: '控制台', exact: true }).click()
    await page.getByRole('button', { name: '＋ 新建 Agent' }).click()
    const card = page.locator('.wiz-card')
    await expect(card).toBeVisible()
    await page.locator('#wizName').fill('维机')
    await card.getByRole('button', { name: '下一步' }).click()
    // 镜像下拉：缺省「默认沙箱」，绑定后向导如实说明连接语义
    await card.locator('.wiz-kv', { hasText: '沙箱镜像' }).locator('select').selectOption('img-1') // 新库首条目确定性 id
    await expect(card.locator('.wiz-body')).toContainText('注册即真实连接')
    await card.getByRole('button', { name: '下一步' }).click()
    await expect(card.locator('.wiz-body')).toContainText('镜像：GUI 容器')
    await card.getByRole('button', { name: '创建 Agent' }).click()
    await expect(page.locator('.toast', { hasText: '维机」已创建' })).toBeVisible({ timeout: 15_000 })

    // —— ctx 档案镜像 kv：条目名（载体 镜像名） ——
    await page.locator('.roster-item', { hasText: '维机' }).click()
    await page.getByTitle('会话档案').click() // ctx 切档案节（镜像 kv 所在）
    await expect(page.locator('.ctx')).toContainText('GUI 容器（容器 openbot-gui:24.04）', { timeout: 10_000 })

    // —— 重启持久化（双段会话）：绑定是档案事实，重启后 ctx 呈现不变 ——
    await app.close()
    const app2 = await _electron.launch({
      args: ['.'],
      env: { ...process.env, OPENBOT_USER_DATA: userData, OPENBOT_SANDBOX: 'mock' },
    })
    const page2 = await app2.firstWindow()
    try {
      await expect(page2.locator('.app')).toHaveAttribute('data-connected', 'true', { timeout: 30_000 })
      await page2.locator('.roster-item', { hasText: '维机' }).click()
      await page2.getByTitle('会话档案').click()
      await expect(page2.locator('.ctx')).toContainText('GUI 容器（容器 openbot-gui:24.04）', { timeout: 10_000 })

      // —— 删除镜像条目 → 重启 → 悬空如实呈现「已删除 · 回默认沙箱」（agent 存活不炸装配） ——
      await page2.getByRole('button', { name: '设置', exact: true }).click()
      await page2.locator('.settings-nav-item', { hasText: '镜像' }).click() // 切换式导航（每次进设置回落默认分节）
      const del = page2.locator('.cfg-row', { hasText: 'GUI 容器' }).locator('[data-role="image-remove"]')
      await del.click()
      await expect(del).toHaveText('确认删除？')
      await del.click()
      await expect(page2.locator('.cfg-row', { hasText: 'GUI 容器' })).toHaveCount(0)
      await app2.close()

      const app3 = await _electron.launch({
        args: ['.'],
        env: { ...process.env, OPENBOT_USER_DATA: userData, OPENBOT_SANDBOX: 'mock' },
      })
      const page3 = await app3.firstWindow()
      try {
        await expect(page3.locator('.app')).toHaveAttribute('data-connected', 'true', { timeout: 30_000 })
        // agent 仍在名册（悬空回默认不炸装配）；ctx 如实标注
        await page3.locator('.roster-item', { hasText: '维机' }).click()
        await page3.getByTitle('会话档案').click()
        await expect(page3.locator('.ctx')).toContainText('镜像已删除 · 回默认沙箱', { timeout: 10_000 })
      } finally {
        await app3.close()
      }
    } finally {
      await app2.close()
    }
  } finally {
    await app.close()
    await rm(userData, { recursive: true, force: true }).catch(() => {})
  }
})

test('载体不可达不炸启动（v0.1.40 恢复降级）：绑定离线 android 条目的 agent → 应用照常起 + 回默认沙箱', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'openbot-e2e-adbdown-'))
  // 预置持久化状态（绕过 UI——运行中注册对不可达载体会如实失败，造不出这个状态）：
  // android 条目（假序列号）+ 绑定它的 worker agent 档案
  await mkdir(join(userData, 'data', 'images'), { recursive: true }).catch(() => {})
  await mkdir(join(userData, 'data', 'agents', 'worker-offline'), { recursive: true })
  await writeFile(
    join(userData, 'data', 'images.json'),
    JSON.stringify({ version: 1, images: [{ id: 'img-1', name: '离线手机', carrier: 'android', host: 'FAKE-SERIAL-DOWN', controlProtocol: 'android', createdAt: 1 }] }, null, 2),
  )
  await writeFile(
    join(userData, 'data', 'agents', 'worker-offline', 'profile.json'),
    JSON.stringify({ agentId: 'worker-offline', name: '离线工', role: 'worker', createdAt: 1, imageId: 'img-1' }, null, 2),
  )
  // 启动——恢复循环遇到不可达载体：降级默认沙箱（告警留痕），应用必须正常起（不弹装配失败）
  const app = await _electron.launch({
    args: ['.'],
    env: { ...process.env, OPENBOT_USER_DATA: userData, OPENBOT_SANDBOX: 'mock' },
  })
  const page = await app.firstWindow()
  try {
    await expect(page.locator('.app')).toHaveAttribute('data-connected', 'true', { timeout: 30_000 })
    // agent 恢复在场且回默认沙箱（boxId 非 adb- 前缀——降级实证）
    await expect(page.locator('.roster-item', { hasText: '离线工' })).toBeVisible({ timeout: 10_000 })
    await page.locator('.roster-item', { hasText: '离线工' }).click()
    await page.getByTitle('会话档案').click()
    // 降级实证：Box 归属为默认沙箱 box（box-N 格式，非 adb- 前缀）；镜像绑定行保留
    // （档案事实——设备回场重启即恢复原载体；呈现层降级注记记为后续打磨）
    await expect(page.locator('.ctx')).toContainText('镜像离线手机', { timeout: 10_000 })
    const boxVal = (await page.locator('.ctx .kv', { hasText: 'Box 归属' }).locator('.v').innerText()).trim()
    expect(boxVal.startsWith('box-')).toBe(true)
    expect(boxVal.includes('adb-')).toBe(false)
  } finally {
    await app.close()
    await rm(userData, { recursive: true, force: true }).catch(() => {})
  }
})

test('Android 配对向导（P9-3c）：扫描入口 + 配对模态双模式骨架（环境无关——摄像头/真机态门控外）', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'openbot-e2e-adbwiz-'))
  const app = await _electron.launch({
    args: ['.'],
    env: { ...process.env, OPENBOT_USER_DATA: userData, OPENBOT_SANDBOX: 'mock' },
  })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => console.log('[pageerror]', e.message))
  try {
    await expect(page.locator('.app')).toHaveAttribute('data-connected', 'true', { timeout: 30_000 })
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.locator('.settings-nav-item', { hasText: '镜像' }).click()

    await page.getByRole('button', { name: '＋ 添加镜像' }).click()
    await page.locator('label.proto-opt', { hasText: 'Android 设备' }).click()
    // 扫描按钮在场；点击后如实（有设备列行可点 / 无设备零行——环境无关只断言不炸）
    await page.locator('[data-role="adb-scan"]').click()
    await expect(page.locator('[data-role="adb-scan"]')).toBeEnabled({ timeout: 15_000 })

    // 配对模态：双模式骨架 + 手动表单可填 + 失败如实（假地址——真 adb pair 拒绝）
    await page.locator('[data-role="adb-pair-open"]').click()
    const modal = page.locator('.adb-pair-card')
    await expect(modal).toBeVisible()
    await expect(modal.locator('.adb-scan-viewport')).toBeVisible()
    await modal.locator('label.proto-opt', { hasText: '手动输入' }).click()
    await page.locator('#adbPairTarget').fill('192.168.99.99:9999')
    await page.locator('#adbPairCode').fill('123456')
    await modal.locator('[data-role="adb-pair-submit"]').click()
    await expect(modal.locator('.form-error')).toBeVisible({ timeout: 30_000 })
    await modal.getByRole('button', { name: '取消' }).click()
    await expect(modal).toHaveCount(0)
  } finally {
    await app.close()
    await rm(userData, { recursive: true, force: true }).catch(() => {})
  }
})

test('思考双通道（v0.1.43）：reasoning 流进思考卡、正文流为 live 气泡预览、终答替换预览', async () => {
  const mock = await startMockOpenAi([
    {
      match: (last) => last.role === 'user' && last.content.includes('双通道'),
      reasoning: '先想一下思路，然后分两步。',
      text: '正文回答：双通道验证通过。',
    },
  ])
  const userData = await mkdtemp(join(tmpdir(), 'openbot-e2e-think2-'))
  const app = await _electron.launch({
    args: ['.'],
    env: { ...process.env, OPENBOT_USER_DATA: userData, OPENBOT_SANDBOX: 'mock' },
  })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => console.log('[pageerror]', e.message))
  try {
    await expect(page.locator('.app')).toHaveAttribute('data-connected', 'true', { timeout: 30_000 })
    // 配 provider 指向 mock（首段漏配导致「provider 未配置」——快照实锤）
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.getByRole('button', { name: '＋ 添加供应商' }).click()
    await page.locator('#pfName').fill('E2E mock')
    await page.locator('#pfUrl').fill(`http://127.0.0.1:${mock.port}/v1`)
    await page.getByRole('button', { name: '＋ 添加模型' }).click()
    await page.locator('#pfModel').fill('mock-model')
    await page.locator('#pfModel').press('Enter')
    await page.getByRole('button', { name: '保存', exact: true }).click()
    await expect(page.locator('.llm-nav-item[data-provider="E2E mock"] .llm-nav-dot.on')).toBeVisible()
    await page.getByRole('button', { name: '控制台', exact: true }).click()
    await page.locator('.composer-box input').fill('双通道测试')
    await page.locator('.composer-box input').press('Enter')
    // 思考卡在场（含思考内容——可折叠体内）
    const thinkCard = page.locator('.think').first()
    await expect(thinkCard).toBeVisible({ timeout: 15_000 })
    await thinkCard.locator('.think-head').click()
    await expect(thinkCard.locator('.think-body')).toContainText('先想一下思路')
    // 终答气泡（正文）到达——含正文文本
    await expect(page.locator('.m-text', { hasText: '正文回答：双通道验证通过。' })).toBeVisible({ timeout: 15_000 })
    // 终答到达后正文预览让位（无双份正文——live 预览块被去重删除）
    await expect(page.locator('[data-livemsg]')).toHaveCount(0, { timeout: 5_000 })
    // —— /clear 清空回归（2026-10-13 用户报障：思考块残屏）——过程事实（思考卡/exec 卡）
    // 随边界与消息一并移除，屏幕只剩占位文案（transcript 留证不受影响） ——
    await page.locator('.composer-box input').fill('/clear')
    await page.locator('.composer-box input').press('Enter')
    await expect(page.locator('.think')).toHaveCount(0, { timeout: 5_000 })
    await expect(page.locator('.stream-inner .m')).toHaveCount(0)
    await expect(page.locator('.stream-inner .placeholder')).toBeVisible()
  } finally {
    await app.close()
    await mock.close()
    await rm(userData, { recursive: true, force: true }).catch(() => {})
  }
})

test('会话列表（2026-10-18 改版）：标题生成 + UUID 新会话 + 相对时间 + 空会话不计入', async () => {
  const mock = await startMockOpenAi([{ match: (l) => l.role === 'user', text: '一轮回答' }])
  const userData = await mkdtemp(join(tmpdir(), 'openbot-e2e-sessions-'))
  const app = await _electron.launch({
    args: ['.'],
    env: { ...process.env, OPENBOT_USER_DATA: userData, OPENBOT_SANDBOX: 'mock' },
  })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => console.log('[pageerror]', e.message))

  try {
    await expect(page.locator('.app')).toHaveAttribute('data-connected', 'true', { timeout: 30_000 })

    // 配 provider
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.getByRole('button', { name: '＋ 添加供应商' }).click()
    await page.locator('#pfName').fill('E2E mock')
    await page.locator('#pfUrl').fill(`http://127.0.0.1:${mock.port}/v1`)
    await page.getByRole('button', { name: '＋ 添加模型' }).click()
    await page.locator('#pfModel').fill('mock-model')
    await page.locator('#pfModel').press('Enter')
    await page.getByRole('button', { name: '保存', exact: true }).click()
    await page.getByRole('button', { name: '控制台', exact: true }).click()

    const input = page.locator('.composer-box input')
    // —— 空会话 /clear：no-op（不落边界——「空会话不计入」）——
    await input.fill('/clear')
    await input.press('Enter')
    await expect(page.locator('.toast.success', { hasText: '当前会话为空——未开启新会话' })).toBeVisible({ timeout: 10_000 })

    // —— 首轮对话（标题请求被 mock 哨兵拦截，回 canned「E2E会话标题」）——
    await input.fill('帮我配置部署环境')
    await input.press('Enter')
    await expect(page.locator('.m-text', { hasText: '一轮回答' })).toBeVisible({ timeout: 15_000 })

    // —— /clear 开新会话（UUID）；新会话为空立即再 clear → no-op ——
    await input.fill('/clear')
    await input.press('Enter')
    await expect(page.locator('.toast.success', { hasText: '已开启新会话' })).toBeVisible({ timeout: 10_000 })
    await input.fill('/clear')
    await input.press('Enter')
    // 首个 no-op toast 可能仍在场——取最新一条
    await expect(page.locator('.toast.success', { hasText: '当前会话为空——未开启新会话' }).last()).toBeVisible({ timeout: 10_000 })

    // —— 第二段对话（u1 获得标题）→ /clear（u2）→ 第三段对话（current=u2）——
    // 注：/clear 清空界面——每轮回答在 DOM 中都是该段唯一一条，不走 nth 累计索引
    await input.fill('第二段话题')
    await input.press('Enter')
    await expect(page.locator('.m-text', { hasText: '一轮回答' })).toBeVisible({ timeout: 15_000 })
    await input.fill('/clear')
    await input.press('Enter')
    // 前一次「已开启新会话」toast 可能仍在场（6s 生命周期）——取最新一条
    await expect(page.locator('.toast.success', { hasText: '已开启新会话' }).last()).toBeVisible({ timeout: 10_000 })
    await input.fill('第三段话题')
    await input.press('Enter')
    await expect(page.locator('.m-text', { hasText: '一轮回答' })).toBeVisible({ timeout: 15_000 })

    // —— /resume 列表：当前段（u2）排除；两项 = u1（UUID 截短 note + 标题 + 相对时间）与 s-0 ——
    await input.fill('/resume')
    await expect(page.locator('.sm-item', { hasText: '/resume' })).toBeVisible() // cmd 级联想在场
    await page.locator('.composer-box input').press('Enter') // cmd 级选中 /resume → 进会话级
    await expect(page.locator('.slash-menu .sm-title', { hasText: '恢复会话' })).toBeVisible()
    await expect(page.locator('.sm-item .sm-label', { hasText: 'E2E会话标题' }).first()).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('.sm-item')).toHaveCount(2)
    // 首项（最近=u1）：标题 + 相对时间 + UUID 截短 note；次项（初始段）：s-0
    const first = page.locator('.sm-item').first()
    await expect(first.locator('.sm-sub')).toContainText(/条$/)
    expect((await first.locator('.sm-sub').textContent()) ?? '').toMatch(/(刚刚|分钟以前|小时以前)/)
    expect((await first.locator('.sm-note').textContent()) ?? '').toMatch(/^[0-9a-f]{8}…$/)
    await expect(page.locator('.sm-item').nth(1).locator('.sm-note')).toHaveText('s-0')

    // —— Enter 回最近会话（u1）：toast 带标题 + 第二段对话回到流内 ——
    await page.locator('.composer-box input').press('Enter')
    await expect(page.locator('.toast.success', { hasText: '已回到会话：E2E会话标题' })).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('.m.user', { hasText: '第二段话题' })).toBeVisible()
    await expect(page.locator('.m.user', { hasText: '第三段话题' })).toHaveCount(0) // u2 时间线未走分支
  } finally {
    await app.close()
    await mock.close()
    await rm(userData, { recursive: true, force: true }).catch(() => {})
  }
})

test('群聊身份与独立作答（2026-10-18）：persona 自称正确 + #讨论 并发盲答互不可见 + 徽标', async () => {
  const mock = await startMockOpenAi([
    // 独立作答：成员按身份行区分（引号精确匹配——同伴名单无引号不误撞），各回各的
    { match: (l) => l.content.includes('你是本群成员「管家」') && l.content.includes('独立作答'), text: '管家的独立观点：先定基调' },
    { match: (l) => l.content.includes('你是本群成员「欧米茄」') && l.content.includes('独立作答'), text: '欧米茄的独立观点：我有不同看法' },
    // 轮转对照（同一群）
    { match: (l) => l.content.includes('你是本群成员「管家」') && l.content.includes('轮转一下'), text: '管家轮转发言' },
    { match: (l) => l.content.includes('你是本群成员「欧米茄」') && l.content.includes('轮转一下'), text: '欧米茄轮转补充' },
  ])
  const userData = await mkdtemp(join(tmpdir(), 'openbot-e2e-groupid-'))
  const app = await _electron.launch({
    args: ['.'],
    env: { ...process.env, OPENBOT_USER_DATA: userData, OPENBOT_SANDBOX: 'mock' },
  })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => console.log('[pageerror]', e.message))

  try {
    await expect(page.locator('.app')).toHaveAttribute('data-connected', 'true', { timeout: 30_000 })

    // 配 provider
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.getByRole('button', { name: '＋ 添加供应商' }).click()
    await page.locator('#pfName').fill('E2E mock')
    await page.locator('#pfUrl').fill(`http://127.0.0.1:${mock.port}/v1`)
    await page.getByRole('button', { name: '＋ 添加模型' }).click()
    await page.locator('#pfModel').fill('mock-model')
    await page.locator('#pfModel').press('Enter')
    await page.getByRole('button', { name: '保存', exact: true }).click()

    // —— 建欧米茄（角色默认研究员——persona 自动生成；复核步可见人设行）——
    await page.getByRole('button', { name: '控制台', exact: true }).click()
    await page.getByRole('button', { name: '＋ 新建 Agent' }).click()
    const card = page.locator('.wiz-card')
    await page.locator('#wizName').fill('欧米茄')
    await card.getByRole('button', { name: '下一步' }).click()
    await card.getByRole('button', { name: '下一步' }).click()
    await expect(card.locator('.wiz-body')).toContainText('研究员')
    await card.getByRole('button', { name: '创建 Agent' }).click()
    await expect(page.locator('.toast', { hasText: '欧米茄」已创建' })).toBeVisible({ timeout: 15_000 })

    // —— 建群（管家 + 欧米茄）——
    await page.locator('.roster-new', { hasText: '建群' }).click()
    const wiz = page.locator('.wiz-card')
    await page.locator('#gwName').fill('评审组')
    await page.locator('.gw-member', { hasText: '管家' }).click()
    await page.locator('.gw-member', { hasText: '欧米茄' }).click()
    await wiz.getByRole('button', { name: /^建群/ }).click()
    await expect(page.locator('.sh-name')).toHaveText('评审组', { timeout: 10_000 })

    // —— #讨论（语法直发——不经菜单；fill 会弹 # 联想，Esc 收起再 Enter 发送）——
    const input = page.locator('.composer-box input')
    await input.fill('#讨论 各自说说')
    await input.press('Escape')
    await input.press('Enter')
    // 两员独立观点都到（并发——无需先后依赖）
    await expect(page.locator('.m-text', { hasText: '管家的独立观点' })).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('.m-text', { hasText: '欧米茄的独立观点' })).toBeVisible({ timeout: 15_000 })
    // 用户气泡带「独立作答」徽标
    await expect(page.locator('.gm-mode')).toHaveText('独立作答')

    // prompt 对账（mock 请求留痕）：两请求各带自身身份行与独立注解，均无「本轮已发言」
    const chatReqs = mock.requests.filter((r) => !r.title)
    const indep = chatReqs.filter((r) =>
      (r.messages as Array<{ content?: string }>).some((m) => m.content?.includes('各自说说')),
    )
    expect(indep).toHaveLength(2)
    const joined = indep.map((r) => (r.messages as Array<{ content?: string }>).map((m) => m.content ?? '').join('\n'))
    expect(joined.some((c) => c.includes('你是本群成员「管家」'))).toBe(true)
    expect(joined.some((c) => c.includes('你是本群成员「欧米茄」'))).toBe(true)
    for (const c of joined) {
      expect(c).toContain('独立作答')
      expect(c).not.toContain('本轮已发言')
    }

    // —— 轮转对照（普通消息）：管家先说，欧米茄 prompt 应含「本轮已发言」（锚定语义保留）——
    await input.fill('轮转一下')
    await input.press('Enter')
    await expect(page.locator('.m-text', { hasText: '管家轮转发言' })).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('.m-text', { hasText: '欧米茄轮转补充' })).toBeVisible({ timeout: 15_000 })
    const omegaRotation = mock.requests
      .filter((r) => !r.title)
      .map((r) => (r.messages as Array<{ content?: string }>).map((m) => m.content ?? '').join('\n'))
      .find((c) => c.includes('轮转一下') && c.includes('你是本群成员「欧米茄」'))
    expect(omegaRotation).toContain('本轮已发言')
  } finally {
    await app.close()
    await mock.close()
    await rm(userData, { recursive: true, force: true }).catch(() => {})
  }
})
