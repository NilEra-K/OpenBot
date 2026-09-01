/**
 * 跨用户房间 E2E（plan-p7 Step 7）：真 relay host（随机端口）+ 桌面接入（env 注入房间配置）
 * + 脚本化对端 ws 客户端（第二成员——协议行为由 host 单测与本脚本共同覆盖）。
 * 全链：连接与名册远端节 → 对端 mirror 到达（含 DOMPurify 净化断言）→ 本端对话镜像外流
 * → 远端 turn-request 受理（走本地排队/审批面）→ turn-result 回程 → 同 nonce 重放拿缓存。
 * 本地优先叙事在场断言：设置页房间区块的自托管文案。
 */
import { test, expect, _electron } from '@playwright/test'
import WebSocket from 'ws'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startMockOpenAi } from './mock-openai'
// 相对路径直取 relay host 实现（playwright 转译侧加载——desktop 不声明对 relay 的运行时依赖；
// e2e 不在 tsc 项目引用内，.ts 后缀直载）
import { createRelayServer, type RelayServerHandle } from '../../relay/src/server.ts'
import type { ServerMessage, TurnResult } from '../../../packages/messaging/src/xuser/index.ts'

test('跨用户房间（P7 mirror 一期）：mirror 双向 + 净化 + 远端 turn 受理 + 幂等', async () => {
  const mock = await startMockOpenAi([
    // 桌面对端 turn 的终答步：turn-request 的 prompt 作为用户消息入队 → mock 终答
    { match: (l) => l.role === 'user', text: '远端任务完成：报告已总结' },
  ])

  const host: RelayServerHandle = await createRelayServer()
  const created = await (await fetch(`http://127.0.0.1:${host.port}/api/rooms`, { method: 'POST' })).json() as {
    roomId: string
    inviteCode: string
  }

  // 脚本化对端（第二成员）：hello 拿 memberId；收集服务端消息
  const peerMessages: ServerMessage[] = []
  const peer = new WebSocket(`ws://127.0.0.1:${host.port}/ws?room=${created.roomId}&invite=${encodeURIComponent(created.inviteCode)}&name=${encodeURIComponent('远端好友')}`)
  const peerHello = await new Promise<{ memberId: string }>((resolve, reject) => {
    peer.once('message', (data) => {
      const msg = JSON.parse(String(data)) as ServerMessage
      peerMessages.push(msg)
      if (msg.kind === 'hello') resolve({ memberId: msg.memberId })
      else reject(new Error('首条不是 hello'))
    })
    peer.once('error', reject)
  })
  peer.on('message', (data) => {
    const msg = JSON.parse(String(data)) as ServerMessage
    if (msg.kind !== 'hello') peerMessages.push(msg)
  })
  const peerSend = (obj: unknown): void => peer.send(JSON.stringify(obj))
  const peerWait = async (pred: (m: ServerMessage) => boolean, timeoutMs = 20_000): Promise<ServerMessage> => {
    const found = peerMessages.find(pred)
    if (found) return found
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('对端等待消息超时')), timeoutMs)
      const poll = setInterval(() => {
        const hit = peerMessages.find(pred)
        if (hit) {
          clearTimeout(timer)
          clearInterval(poll)
          resolve(hit)
        }
      }, 50)
    })
  }

  const userData = await mkdtemp(join(tmpdir(), 'openbot-e2e-relay-'))
  const app = await _electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      OPENBOT_USER_DATA: userData,
      OPENBOT_SANDBOX: 'mock',
      OPENBOT_RELAY_URL: `ws://127.0.0.1:${host.port}/ws`,
      OPENBOT_RELAY_ROOM: created.roomId,
      OPENBOT_RELAY_INVITE: created.inviteCode,
      OPENBOT_RELAY_NAME: '本端用户',
    },
  })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => console.log('[pageerror]', e.message))
  page.on('console', (m) => {
    const t = m.text()
    if (t.includes('[diag]')) console.log('[page]', t)
  })
  app.process().stdout?.on('data', (d) => console.log('[main]', String(d).trimEnd()))
  app.process().stderr?.on('data', (d) => console.log('[main-err]', String(d).trimEnd()))

  try {
    await expect(page.locator('.app')).toHaveAttribute('data-connected', 'true', { timeout: 30_000 })

    // 1) 桌面入房：对端收到 member-joined；桌面名册出现远端节
    await peerWait((m) => m.kind === 'room-event' && m.event === 'member-joined' && m.displayName === '本端用户')
    await expect(page.locator('.roster-item', { hasText: '远端好友' })).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('.roster-item', { hasText: '远端好友' })).toContainText('远端 mirror')

    // 2) 配 provider → console 发消息（管家会话）
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.getByRole('button', { name: '＋ 添加模型' }).click()
    await page.locator('#pfName').fill('E2E mock')
    await page.locator('#pfUrl').fill(`http://127.0.0.1:${mock.port}/v1`)
    await page.locator('#pfModel').fill('mock-model')
    await page.getByRole('button', { name: '保存', exact: true }).click()
    await page.locator('.cfg-row .btn', { hasText: '设为主力' }).click()
    await page.getByRole('button', { name: '控制台', exact: true }).click()
    await page.locator('.composer-box input').fill('本地说一句')
    await page.locator('.composer-box input').press('Enter')

    // 3) mirror 出站：对端收到本端 user 镜像与 agent 终答镜像
    await peerWait((m) => m.kind === 'mirror-message' && m.text === '本地说一句' && m.speakerKind === 'user')
    await peerWait((m) => m.kind === 'mirror-message' && m.speakerKind === 'agent' && m.text.includes('远端任务完成'))

    // 4) 对端 mirror 入站：消息归属远端成员自己的会话（P7 原型对齐——名册远端节可点开）
    peerSend({
      kind: 'mirror-message',
      nonce: `${peerHello.memberId}:1`,
      fromMemberId: peerHello.memberId,
      speakerKind: 'user',
      speakerName: '远端好友',
      text: '远端问候 <script>window.__pwned=1</script> **加粗**',
      sentAt: Date.now(),
    })
    // 名册远端节点开该成员的 mirror 会话（只读）
    await page.locator('.roster-item', { hasText: '远端好友' }).click({ timeout: 15_000 })
    const remoteCard = page.locator('.m', { hasText: '远端问候' })
    await expect(remoteCard).toBeVisible({ timeout: 15_000 })
    await expect(remoteCard).toContainText('房间 · 远端')
    await expect(remoteCard.locator('script')).toHaveCount(0) // DOMPurify 生效（§5 协议约束）
    await expect(remoteCard.locator('strong')).toHaveCount(1) // markdown 正常渲染未被误伤
    expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined()
    // 只读态：composer 禁用 + placeholder 注明 mirror
    await expect(page.locator('.composer-box input')).toBeDisabled()
    await expect(page.locator('.composer-box input')).toHaveAttribute('placeholder', /远端 mirror 会话（远端好友）· 只读/)

    // 5) 远端 turn：对端 request → 桌面受理（用户 lane + mock 终答）→ result 回程。
    // toMemberId 从对端视角的 member-joined 事件取（桌面真实 memberId）
    const desktopJoined = peerMessages.find(
      (m) => m.kind === 'room-event' && m.event === 'member-joined' && m.displayName === '本端用户',
    ) as Extract<ServerMessage, { kind: 'room-event' }> | undefined
    expect(desktopJoined?.memberId).toMatch(/^m-\d+$/)
    const desktopMemberId = desktopJoined!.memberId
    peerSend({
      kind: 'turn-request',
      nonce: `${peerHello.memberId}:2`,
      requestId: 'e2e-turn-1',
      fromMemberId: peerHello.memberId,
      toMemberId: desktopMemberId,
      prompt: '总结这份报告',
      sentAt: Date.now(),
    })
    const result = await peerWait((m): m is TurnResult => m.kind === 'turn-result' && m.requestId === 'e2e-turn-1')
    expect(result.status).toBe('ok')
    expect(result.text).toContain('远端任务完成')
    expect(result.remaining).toBeGreaterThanOrEqual(0)

    // 6) 同 nonce 重放：拿缓存的同一应答（幂等不双花）
    peerSend({
      kind: 'turn-request',
      nonce: `${peerHello.memberId}:2`,
      requestId: 'e2e-turn-1',
      fromMemberId: peerHello.memberId,
      toMemberId: desktopMemberId,
      prompt: '总结这份报告',
      sentAt: Date.now(),
    })
    const replay = await peerWait((m): m is TurnResult => m.kind === 'turn-result' && m.requestId === 'e2e-turn-1' && m !== result)
    expect(replay.text).toBe(result.text)

    // 7) rooms 视图（P7 原型对齐）：房间卡在场——成员链/事实 kv/自托管叙事；设置页不再有房间区块
    await page.getByRole('button', { name: '跨用户房间', exact: true }).click()
    await expect(page.locator('.roomcard .room-name')).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('.roomcard')).toContainText('已连接')
    await expect(page.locator('.mchip', { hasText: '你' })).toContainText('主人')
    await expect(page.locator('.mchip', { hasText: '远端好友' })).toContainText('远端 · mirror')
    await expect(page.locator('.relay-kv', { hasText: '远端成员' })).toContainText('1 名')
    await expect(page.locator('.rooms-note')).toContainText('自托管')
    // 房间设置模态（P7 多房间轮：列表 ⇄ 表单两态——卡上按钮直开该房编辑表单；Esc 逐级返回）
    await page.locator('.room-actions .btn', { hasText: '房间设置' }).click()
    await expect(page.locator('.wiz-overlay .wiz-card[aria-label="房间接入配置"]')).toBeVisible()
    await expect(page.locator('.wiz-overlay .wiz-title')).toHaveText('编辑房间')
    await expect(page.locator('.wiz-overlay input').first()).toHaveValue(/ws:\/\//)
    await page.locator('.wiz-overlay input').first().press('Escape')
    await expect(page.locator('.wiz-overlay .wiz-title')).toHaveText('房间接入')
    // 列表态无输入框（Esc 挂不上）——「关闭」按钮收模态
    await page.locator('.wiz-overlay .wiz-foot .btn', { hasText: '关闭' }).click()
    await expect(page.locator('.wiz-overlay')).toHaveCount(0)
    // 设置页收窄：房间区块不在（配置已迁 rooms 视图模态）
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await expect(page.locator('.set-sec', { hasText: '跨用户房间' })).toHaveCount(0)
  } finally {
    await app.close()
    peer.close()
    await mock.close()
    await host.close()
    await rm(userData, { recursive: true, force: true }).catch(() => {})
  }
})

test('多房间接入（P7 多房间轮）：双房并行连接 + 成员分组 + mirror 房间隔离', async () => {
  const host: RelayServerHandle = await createRelayServer()
  const createRoom = async (): Promise<{ roomId: string; inviteCode: string }> =>
    (await (await fetch(`http://127.0.0.1:${host.port}/api/rooms`, { method: 'POST' })).json()) as {
      roomId: string
      inviteCode: string
    }
  const roomA = await createRoom()
  const roomB = await createRoom()

  // userData 预写两房接入配置（settings.json——装配期读取）
  const userData = await mkdtemp(join(tmpdir(), 'openbot-e2e-relays2-'))
  await (await import('node:fs/promises')).mkdir(join(userData, 'data'), { recursive: true })
  await (await import('node:fs/promises')).writeFile(
    join(userData, 'data', 'settings.json'),
    JSON.stringify({
      version: 1,
      providers: [],
      relays: [
        { enabled: true, url: `ws://127.0.0.1:${host.port}/ws`, roomId: roomA.roomId, inviteCode: roomA.inviteCode, displayName: '本端·甲', roomName: '互助会' },
        { enabled: true, url: `ws://127.0.0.1:${host.port}/ws`, roomId: roomB.roomId, inviteCode: roomB.inviteCode, displayName: '本端·乙', roomName: '爬虫小队' },
      ],
    }),
    'utf8',
  )

  // 两对端各连一房
  const connectPeer = (room: { roomId: string; inviteCode: string }, name: string) => {
    const messages: ServerMessage[] = []
    const ws = new WebSocket(`ws://127.0.0.1:${host.port}/ws?room=${room.roomId}&invite=${encodeURIComponent(room.inviteCode)}&name=${encodeURIComponent(name)}`)
    ws.on('message', (data) => {
      const msg = JSON.parse(String(data)) as ServerMessage
      if (msg.kind !== 'hello') messages.push(msg)
    })
    return { ws, messages, send: (obj: unknown) => ws.send(JSON.stringify(obj)) }
  }
  const peerA = connectPeer(roomA, '阿尔法好友')
  const peerB = connectPeer(roomB, '小林')
  await new Promise<void>((r) => {
    let n = 0
    const done = (): void => {
      n += 1
      if (n >= 2) r()
    }
    peerA.ws.once('open', done)
    peerB.ws.once('open', done)
  })

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

    // 1) 两张房卡（各自备注名与已连接态）
    await page.getByRole('button', { name: '跨用户房间', exact: true }).click()
    await expect(page.locator('.roomcard', { hasText: '互助会' })).toContainText('已连接', { timeout: 15_000 })
    await expect(page.locator('.roomcard', { hasText: '爬虫小队' })).toContainText('已连接')

    // 2) 房 A 对端发 mirror：桌面收到（归属房 A 成员）；**房 B 对端收不到（房间隔离）**
    peerA.send({ kind: 'mirror-message', nonce: 'pa:1', fromMemberId: 'm-1', speakerKind: 'user', speakerName: '阿尔法好友', text: '房A的消息', sentAt: Date.now() })
    // 名册（控制台侧栏）：两组房名分节 + 各自成员
    await page.getByRole('button', { name: '控制台', exact: true }).click()
    await expect(page.locator('.roster-group-sub', { hasText: '互助会' })).toBeVisible()
    await expect(page.locator('.roster-group-sub', { hasText: '爬虫小队' })).toBeVisible()
    const peerANode = page.locator('.roster-item', { hasText: '阿尔法好友' })
    await expect(peerANode).toBeVisible({ timeout: 15_000 })
    await peerANode.click()
    await expect(page.locator('.m', { hasText: '房A的消息' })).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('.composer-box input')).toBeDisabled() // mirror 会话只读
    // 隔离断言：房 B 对端不收房 A 消息（host fanout 按房）
    await new Promise((r) => setTimeout(r, 300))
    expect(peerB.messages.some((m) => m.kind === 'mirror-message' && m.text === '房A的消息')).toBe(false)

    // 3) 图谱：两房远端节点在场（同 displayName 机制无碍——memberId 键空间隔离）
    await page.getByRole('button', { name: '图谱', exact: true }).click()
    await expect(page.locator('.gnode', { hasText: '阿尔法好友' })).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('.gnode', { hasText: '小林' })).toBeVisible()
  } finally {
    await app.close()
    peerA.ws.close()
    peerB.ws.close()
    await host.close()
    await rm(userData, { recursive: true, force: true }).catch(() => {})
  }
})
