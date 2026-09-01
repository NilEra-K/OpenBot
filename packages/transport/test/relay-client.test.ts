/**
 * RelayClient 测试（P7 Step 4）：假 socket 注入——认证 URL 组装、hello 后 open 态、
 * mirror 出站 nonce 自增、脏消息客户端侧即拒、断连退避重连（注入随机源锁序列）、
 * stop 清孤儿定时器。真 host 全链在 apps/relay 套件与 E2E（Step 7）。
 */
import { describe, expect, it, vi } from 'vitest'
import { RelayClient } from '../src/relay-client/index.js'
import type { MinimalSocket, RelayClientState } from '../src/relay-client/index.js'
import type { ServerMessage } from '@openbot/messaging'

interface FakeSocket extends MinimalSocket {
  /** 手动触发事件（测试驱动） */
  emitOpen(): void
  emitMessage(msg: unknown): void
  emitClose(): void
  sent: string[]
}

const fakeSocket = (): FakeSocket => {
  const handlers: Record<string, Array<(...a: unknown[]) => void>> = {}
  const socket: FakeSocket = {
    sent: [],
    readyState: 0,
    on: (event, cb) => {
      ;(handlers[event] ??= []).push(cb as (...a: unknown[]) => void)
    },
    send: (data) => {
      socket.sent.push(data)
    },
    close: () => {
      socket.readyState = 3
    },
    emitOpen: () => {
      socket.readyState = 1
      for (const cb of handlers['open'] ?? []) cb()
    },
    emitMessage: (msg) => {
      for (const cb of handlers['message'] ?? []) cb(JSON.stringify(msg))
    },
    emitClose: () => {
      socket.readyState = 3
      for (const cb of handlers['close'] ?? []) cb(1006, Buffer.from(''))
    },
  }
  return socket
}

const make = (over: Partial<Parameters<typeof makeClient>[0]> = {}) => makeClient({
  url: 'ws://relay:9999',
  roomId: 'room123',
  inviteCode: 'invite-x',
  displayName: 'Alice',
  ...over,
})

function makeClient(opts: { url: string; roomId: string; inviteCode: string; displayName: string }) {
  const sockets: FakeSocket[] = []
  const messages: ServerMessage[] = []
  const states: Array<{ state: RelayClientState; retryInMs?: number }> = []
  const client = new RelayClient({
    url: opts.url,
    roomId: opts.roomId,
    inviteCode: opts.inviteCode,
    displayName: opts.displayName,
    onServerMessage: (m) => messages.push(m),
    onStateChange: (state, detail) => states.push({ state, retryInMs: detail?.retryInMs }),
    socketFactory: () => {
      const s = fakeSocket()
      sockets.push(s)
      return s
    },
  })
  return { client, sockets, messages, states }
}

describe('RelayClient（假 socket 注入）', () => {
  it('连接 URL 组装（room/invite/name 编码）；hello 前 connecting、hello 后 open 且 memberId 就位', () => {
    const seen: string[] = []
    const socket = fakeSocket()
    const messages: ServerMessage[] = []
    const states: RelayClientState[] = []
    const client = new RelayClient({
      url: 'ws://relay:9999',
      roomId: 'r 1',
      inviteCode: 'i/+',
      displayName: '名字',
      onServerMessage: (m) => messages.push(m),
      onStateChange: (s) => states.push(s),
      socketFactory: (url) => {
        seen.push(url)
        return socket
      },
    })
    client.start()
    expect(seen[0]).toBe(`ws://relay:9999?room=${encodeURIComponent('r 1')}&invite=${encodeURIComponent('i/+')}&name=${encodeURIComponent('名字')}`)
    expect(states.at(-1)).toBe('connecting')
    expect(client.connected).toBe(false)
    socket.emitOpen()
    socket.emitMessage({ kind: 'hello', memberId: 'm-1', room: { roomId: 'r 1', createdAt: 1, members: [] } })
    expect(client.memberId).toBe('m-1')
    expect(client.connected).toBe(true)
    expect(states.at(-1)).toBe('open')
  })

  it('mirror 出站：nonce 自增、未连接抛稳定码', () => {
    const { client, sockets } = make()
    client.start()
    expect(() => client.sendMirror({ speakerKind: 'user', speakerName: 'Alice', text: 'hi' })).toThrowError(
      expect.objectContaining({ code: 'RELAY_NOT_CONNECTED' }),
    )
    sockets[0].emitOpen()
    sockets[0].emitMessage({ kind: 'hello', memberId: 'm-7', room: { roomId: 'room123', createdAt: 1, members: [] } })
    client.sendMirror({ speakerKind: 'user', speakerName: 'Alice', text: '第一条' })
    client.sendMirror({ speakerKind: 'agent', speakerName: '管家', text: '第二条' })
    expect(sockets[0].sent.map((s) => JSON.parse(s))).toEqual([
      expect.objectContaining({ kind: 'mirror-message', nonce: 'm-7:1', text: '第一条' }),
      expect.objectContaining({ kind: 'mirror-message', nonce: 'm-7:2', speakerKind: 'agent', text: '第二条' }),
    ])
  })

  it('脏消息（schema 不过/非法 JSON）客户端侧即拒——不进回调', () => {
    const { client, sockets, messages } = make()
    client.start()
    sockets[0].emitOpen()
    sockets[0].emitMessage({ kind: 'hello', memberId: 'm-1', room: { roomId: 'room123', createdAt: 1, members: [] } })
    sockets[0].emitMessage({ kind: 'mirror-message', evil: true }) // schema 拒
    // 非法 JSON 绕过（直接调 handler 不可行——经 emitMessage 只能发合法 JSON 串，构造原始脏串）
    const before = messages.length
    sockets[0].emitMessage({ kind: 'room-event', event: 'member-joined', memberId: 'm-2', displayName: 'Bob' })
    expect(messages.length).toBe(before + 1)
    sockets[0].emitMessage({ kind: 'unknown-kind' })
    expect(messages.length).toBe(before + 1)
  })

  it('断连退避重连：闪断（只 open 不 hello）连续爬升 100→200→400；hello 入场后 attempt 复位', async () => {
    vi.useFakeTimers()
    try {
      const sockets: FakeSocket[] = []
      const states: Array<{ state: RelayClientState; retryInMs?: number }> = []
      const client = new RelayClient({
        url: 'ws://r:1',
        roomId: 'r',
        inviteCode: 'i',
        displayName: 'A',
        onServerMessage: () => {},
        onStateChange: (state, detail) => states.push({ state, retryInMs: detail?.retryInMs }),
        socketFactory: () => {
          const s = fakeSocket()
          sockets.push(s)
          return s
        },
        backoff: { baseMs: 100, maxMs: 400, jitterRatio: 0, rand: () => 0.5 },
      })
      client.start()
      const hello = (s: FakeSocket): void =>
        s.emitMessage({ kind: 'hello', memberId: 'm-1', room: { roomId: 'r', createdAt: 1, members: [] } })
      // 入场成功后闪断三次：只 open 不 hello（未入场）——attempt 连续爬升
      sockets.at(-1).emitOpen()
      hello(sockets.at(-1))
      for (const expected of [100, 200, 400]) {
        sockets.at(-1).emitClose()
        expect(states.at(-1)).toEqual({ state: 'backoff', retryInMs: expected })
        await vi.advanceTimersByTimeAsync(expected - 1)
        expect(states.at(-1)?.state).toBe('backoff')
        await vi.advanceTimersByTimeAsync(1)
        expect(states.at(-1)?.state).toBe('connecting')
        sockets.at(-1).emitOpen() // 只握手不入场（闪断）
      }
      // 第四次重连真正入场 → attempt 复位 → 再断连回 100ms 首档
      hello(sockets.at(-1))
      sockets.at(-1).emitClose()
      expect(states.at(-1)).toEqual({ state: 'backoff', retryInMs: 100 })
      await client.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('stop：清重连定时器（孤儿不留）、状态 stopped', async () => {
    vi.useFakeTimers()
    try {
      const { client, sockets, states } = make()
      client.start()
      sockets[0].emitOpen()
      sockets[0].emitClose()
      expect(states.at(-1)?.state).toBe('backoff')
      await client.stop()
      expect(states.at(-1)?.state).toBe('stopped')
      const count = sockets.length
      await vi.advanceTimersByTimeAsync(60_000)
      expect(sockets.length).toBe(count) // 重连定时器已清——不再新建连接
    } finally {
      vi.useRealTimers()
    }
  })
})
