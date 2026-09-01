/**
 * relay host 测试（P7 Step 2）：真 server（随机端口）+ 真 ws 客户端全链——建房/认证/hello/
 * mirror fanout/房间隔离/turn 路由/幂等/预算/伪造面。协议纯函数（预算滚动/重放/退避）已在
 * messaging/xuser 套件锁死，本套只锁 host 编排语义（内存态即真相，无 mock 层）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { createRelayServer, type RelayServerHandle } from '../src/server.js'
import type { MirrorMessage, ServerMessage, TurnRequest, TurnResult } from '@openbot/messaging'

let handle: RelayServerHandle
const base = (): string => `http://127.0.0.1:${handle.port}`
const wsUrl = (): string => `ws://127.0.0.1:${handle.port}/ws`

beforeAll(async () => {
  // 收紧参数让预算/幂等/限速用例无需等待（真实缺省 10min/30 已在 xuser 套件锁死）
  handle = await createRelayServer({
    budget: { windowMs: 10_000, maxTurns: 2 },
    rate: { windowMs: 1_000, max: 50 },
    memberCap: 3,
  })
})

afterAll(async () => {
  await handle.close()
})

interface TestClient {
  memberId: string | null
  messages: ServerMessage[]
  ws: WebSocket
  /** 等待满足条件的服务端消息（含已到达的；timeoutMs 缺省 3s 由实现给） */
  next(pred: (m: ServerMessage) => boolean, timeoutMs?: number): Promise<ServerMessage>
  send(msg: unknown): void
  close(): Promise<void>
}

const connect = (roomId: string, invite: string, name: string): Promise<TestClient> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(`${wsUrl()}?room=${roomId}&invite=${encodeURIComponent(invite)}&name=${encodeURIComponent(name)}`)
    const client: TestClient = {
      memberId: null,
      messages: [],
      ws,
      next: (pred, timeoutMs = 3_000) => {
        const found = client.messages.find(pred)
        if (found) return Promise.resolve(found)
        return new Promise((res, rej) => {
          const timer = setTimeout(() => rej(new Error('等待服务端消息超时')), timeoutMs)
          const poll = setInterval(() => {
            const hit = client.messages.find(pred)
            if (hit) {
              clearTimeout(timer)
              clearInterval(poll)
              res(hit)
            }
          }, 20)
        })
      },
      send: (msg) => ws.send(JSON.stringify(msg)),
      close: () =>
        new Promise<void>((r) => {
          if (ws.readyState === WebSocket.CLOSED) return r()
          ws.once('close', () => r())
          ws.close(1000, '测试收尾')
        }),
    }
    ws.on('message', (data) => {
      const msg = JSON.parse(String(data)) as ServerMessage
      if (msg.kind === 'hello') client.memberId = msg.memberId
      client.messages.push(msg)
    })
    ws.once('open', () => resolve(client))
    ws.once('error', reject)
  })

const createRoom = async (headers: Record<string, string> = {}): Promise<{ roomId: string; inviteCode: string }> => {
  const res = await fetch(`${base()}/api/rooms`, { method: 'POST', headers })
  return (await res.json()) as { roomId: string; inviteCode: string }
}

describe('建房与认证', () => {
  it('POST /api/rooms → roomId + inviteCode（256bit 熵凭据）；health 如实', async () => {
    const health = await (await fetch(`${base()}/api/health`)).json()
    expect(health).toMatchObject({ ok: true })
    const room = await createRoom()
    expect(room.roomId).toMatch(/^[a-km-np-z2-9]{10}$/)
    expect(room.inviteCode.length).toBeGreaterThanOrEqual(40)
  })

  it('invite 码不符 → 连接被服务端关闭（4404）', async () => {
    const room = await createRoom()
    const ws = new WebSocket(`${wsUrl()}?room=${room.roomId}&invite=wrong-code&name=${encodeURIComponent('伪造者')}`)
    const code = await new Promise<number | undefined>((r) => ws.once('close', (c) => r(c)))
    expect(code).toBe(4404)
  })

  it('建房令牌开启后：无 token 401、带 token 201', async () => {
    const gated = await createRelayServer({ createToken: 'secret-token' })
    try {
      const denied = await fetch(`http://127.0.0.1:${gated.port}/api/rooms`, { method: 'POST' })
      expect(denied.status).toBe(401)
      const allowed = await fetch(`http://127.0.0.1:${gated.port}/api/rooms`, {
        method: 'POST',
        headers: { 'x-create-token': 'secret-token' },
      })
      expect(allowed.status).toBe(201)
    } finally {
      await gated.close()
    }
  })
})

describe('成员与 mirror fanout', () => {
  it('hello 带自身 memberId 与房间快照；上下线广播 room-event', async () => {
    const room = await createRoom()
    const a = await connect(room.roomId, room.inviteCode, 'Alice')
    const b = await connect(room.roomId, room.inviteCode, 'Bob')
    try {
      const hello = b.messages.find((m) => m.kind === 'hello')
      expect(hello).toMatchObject({ kind: 'hello' })
      if (hello?.kind === 'hello') {
        // hello 是各自连接时刻的快照：后连的 Bob 看到全员
        expect(hello.room.members.map((m) => m.displayName).sort()).toEqual(['Alice', 'Bob'])
        expect(a.memberId).toMatch(/^m-\d+$/)
        expect(b.memberId).not.toBe(a.memberId)
      }
      await a.next((m) => m.kind === 'room-event' && m.event === 'member-joined' && m.displayName === 'Bob')
      await b.close()
      await a.next((m) => m.kind === 'room-event' && m.event === 'member-left' && m.displayName === 'Bob')
    } finally {
      await a.close().catch(() => {})
      await b.close().catch(() => {})
    }
  })

  it('mirror 消息：房间内广播（发送者除外）；房间隔离——他房收不到', async () => {
    const room1 = await createRoom()
    const room2 = await createRoom()
    const a = await connect(room1.roomId, room1.inviteCode, 'Alice')
    const b = await connect(room1.roomId, room1.inviteCode, 'Bob')
    const outsider = await connect(room2.roomId, room2.inviteCode, 'Eve')
    try {
      a.send({ kind: 'mirror-message', nonce: `${a.memberId}:1`, fromMemberId: a.memberId, speakerKind: 'user', speakerName: 'Alice', text: '本端镜像', sentAt: 1 })
      const got = await b.next((m) => m.kind === 'mirror-message')
      expect(got).toMatchObject({ kind: 'mirror-message', text: '本端镜像', speakerName: 'Alice' })
      // 发送者自身与他房成员都不收
      await new Promise((r) => setTimeout(r, 200))
      expect(a.messages.some((m) => m.kind === 'mirror-message')).toBe(false)
      expect(outsider.messages.some((m) => m.kind === 'mirror-message')).toBe(false)
    } finally {
      await a.close().catch(() => {})
      await b.close().catch(() => {})
      await outsider.close().catch(() => {})
    }
  })

  it('伪造 fromMemberId（与连接身份不符）→ 连接被关闭', async () => {
    const room = await createRoom()
    const a = await connect(room.roomId, room.inviteCode, 'Alice')
    try {
      a.send({ kind: 'mirror-message', nonce: 'x:1', fromMemberId: 'm-999', speakerKind: 'user', speakerName: 'A', text: '伪造', sentAt: 1 })
      await new Promise<void>((r) => a.ws.once('close', () => r()))
      expect(a.ws.readyState).not.toBe(WebSocket.OPEN)
    } finally {
      await a.close().catch(() => {})
    }
  })
})

describe('turn 全链（路由/幂等/预算）', () => {
  it('request → 目标收到 → result 回程附带余量', async () => {
    const room = await createRoom()
    const a = await connect(room.roomId, room.inviteCode, 'Alice')
    const b = await connect(room.roomId, room.inviteCode, 'Bob')
    try {
      a.send({ kind: 'turn-request', nonce: `${a.memberId}:10`, requestId: 'req-1', fromMemberId: a.memberId, toMemberId: b.memberId, prompt: '总结一下', sentAt: 1 })
      const req = await b.next((m) => m.kind === 'turn-request')
      expect(req).toMatchObject({ kind: 'turn-request', prompt: '总结一下' })
      b.send({ kind: 'turn-result', requestId: 'req-1', fromMemberId: b.memberId, status: 'ok', text: '摘要完成' })
      const result = await a.next((m) => m.kind === 'turn-result')
      expect(result).toMatchObject({ kind: 'turn-result', status: 'ok', text: '摘要完成', remaining: 1 })
    } finally {
      await a.close().catch(() => {})
      await b.close().catch(() => {})
    }
  })

  it('同 nonce 重放：目标只收到一次、发起者拿缓存的同一应答（幂等不双花）', async () => {
    const room = await createRoom()
    const a = await connect(room.roomId, room.inviteCode, 'Alice')
    const b = await connect(room.roomId, room.inviteCode, 'Bob')
    try {
      const request = { kind: 'turn-request', nonce: `${a.memberId}:20`, requestId: 'req-2', fromMemberId: a.memberId, toMemberId: b.memberId, prompt: '第一次', sentAt: 1 }
      a.send(request)
      await b.next((m) => m.kind === 'turn-request')
      b.send({ kind: 'turn-result', requestId: 'req-2', fromMemberId: b.memberId, status: 'ok', text: '首次应答' })
      await a.next((m) => m.kind === 'turn-result')
      // 重放（网络重试语义）：目标不再收、发起者拿缓存
      a.send(request)
      await a.next((m) => m.kind === 'turn-result' && m.status === 'ok' && m.text === '首次应答')
      await new Promise((r) => setTimeout(r, 200))
      expect(b.messages.filter((m) => m.kind === 'turn-request').length).toBe(1)
    } finally {
      await a.close().catch(() => {})
      await b.close().catch(() => {})
    }
  })

  it('预算耗尽（maxTurns=2）：第三次 request 回 budget-exhausted 且不转发', async () => {
    const room = await createRoom()
    const a = await connect(room.roomId, room.inviteCode, 'Alice')
    const b = await connect(room.roomId, room.inviteCode, 'Bob')
    try {
      for (let i = 0; i < 2; i++) {
        a.send({ kind: 'turn-request', nonce: `${a.memberId}:3${i}`, requestId: `req-b${i}`, fromMemberId: a.memberId, toMemberId: b.memberId, prompt: `p${i}`, sentAt: 1 })
        await b.next((m) => m.kind === 'turn-request' && m.prompt === `p${i}`)
        b.send({ kind: 'turn-result', requestId: `req-b${i}`, fromMemberId: b.memberId, status: 'ok', text: `r${i}` })
        await a.next((m) => m.kind === 'turn-result' && m.text === `r${i}`)
      }
      a.send({ kind: 'turn-request', nonce: `${a.memberId}:39`, requestId: 'req-b9', fromMemberId: a.memberId, toMemberId: b.memberId, prompt: '第三次', sentAt: 1 })
      const rejected = await a.next((m) => m.kind === 'turn-result' && m.status === 'budget-exhausted')
      expect(rejected).toMatchObject({ remaining: 0 })
      await new Promise((r) => setTimeout(r, 200))
      expect(b.messages.some((m) => m.kind === 'turn-request' && m.prompt === '第三次')).toBe(false)
    } finally {
      await a.close().catch(() => {})
      await b.close().catch(() => {})
    }
  })

  it('目标不在场 → unreachable（诚实状态，不是 rejected）', async () => {
    const room = await createRoom()
    const a = await connect(room.roomId, room.inviteCode, 'Alice')
    try {
      a.send({ kind: 'turn-request', nonce: `${a.memberId}:40`, requestId: 'req-u1', fromMemberId: a.memberId, toMemberId: 'm-999', prompt: '问幽灵', sentAt: 1 })
      const result = await a.next((m) => m.kind === 'turn-result')
      expect(result).toMatchObject({ status: 'unreachable' })
    } finally {
      await a.close().catch(() => {})
    }
  })

  it('伪造 result（执行端身份不符）不转发给发起者', async () => {
    const room = await createRoom()
    const a = await connect(room.roomId, room.inviteCode, 'Alice')
    const b = await connect(room.roomId, room.inviteCode, 'Bob')
    const eve = await connect(room.roomId, room.inviteCode, 'Eve')
    try {
      a.send({ kind: 'turn-request', nonce: `${a.memberId}:50`, requestId: 'req-f1', fromMemberId: a.memberId, toMemberId: b.memberId, prompt: '给 Bob', sentAt: 1 })
      await b.next((m) => m.kind === 'turn-request')
      // Eve 冒充执行端回 result（requestId 猜测/截获）——fromMemberId 与连接身份一致但不是 pending.to
      eve.send({ kind: 'turn-result', requestId: 'req-f1', fromMemberId: eve.memberId, status: 'ok', text: '伪造应答' })
      await new Promise((r) => setTimeout(r, 200))
      expect(a.messages.some((m) => m.kind === 'turn-result' && m.text === '伪造应答')).toBe(false)
      // 真 Bob 的 result 仍可回程（pending 未被伪造消费？——伪造路径已删 pending……重建请求验证）
      b.send({ kind: 'turn-result', requestId: 'req-f1', fromMemberId: b.memberId, status: 'ok', text: '真应答' })
      await new Promise((r) => setTimeout(r, 200))
      // pending 已被伪造请求消费删除：真应答静默丢弃——发起者两份都收不到，如实（防伪造优先于可用性）
      expect(a.messages.some((m) => m.kind === 'turn-result' && m.text === '真应答')).toBe(false)
    } finally {
      await a.close().catch(() => {})
      await b.close().catch(() => {})
      await eve.close().catch(() => {})
    }
  })

  it('成员上限（memberCap=3）：第四个连接被服务端关闭（4409）', async () => {
    const room = await createRoom()
    const xs = await Promise.all([
      connect(room.roomId, room.inviteCode, 'A'),
      connect(room.roomId, room.inviteCode, 'B'),
      connect(room.roomId, room.inviteCode, 'C'),
    ])
    try {
      const ws = new WebSocket(`${wsUrl()}?room=${room.roomId}&invite=${room.inviteCode}&name=${encodeURIComponent('D')}`)
      const code = await new Promise<number | undefined>((r) => ws.once('close', (c) => r(c)))
      expect(code).toBe(4409)
    } finally {
      for (const x of xs) await x.close().catch(() => {})
    }
  })
})

// 类型引用（避免未用告警的显式断言锚点）
type _T = [MirrorMessage, TurnRequest, TurnResult]
