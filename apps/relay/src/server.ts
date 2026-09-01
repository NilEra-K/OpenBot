/**
 * relay host：跨用户房间公网 host（P7 Step 2）——Hono 只做 HTTP 控制面（建房/健康），
 * WS 数据面用 ws 库直挂同一 http server（与 transport 环回网关同栈，不引 Hono WS 适配层）。
 * 协议语义全部来自 @openbot/messaging/xuser：预算/幂等 host 侧单一事实源（双端记账必双花）、
 * 信封 schema 拒收公网脏输入、turn-result 经 pending 表回程（requestId → 发起者 + nonce）。
 * 安全基线（一期如实朴素，缺失项记 docs/relay-protocol.md）：invite 码 256bit 熵即凭据、
 * 房间隔离（fanout 严格按房间 membership）、每成员限速、WS maxPayload 上限、TLS 终结交反代
 * （Tailscale 内天然加密隧道——P2P 优先叙事，官方不运营服务）。
 */
import { randomBytes } from 'node:crypto'
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { WebSocketServer, type WebSocket } from 'ws'
import {
  TurnBudgetLedger,
  TurnIdempotency,
  XUSER_DEFAULT_BUDGET,
  envelopeSchema,
} from '@openbot/messaging'
import type {
  MirrorMessage,
  RoomInfo,
  ServerMessage,
  TurnRequest,
  TurnResult,
  TurnBudgetConfig,
  XuserEnvelope,
} from '@openbot/messaging'

export interface RelayServerOptions {
  /** 建房令牌（env 注入；设置后 POST /api/rooms 须带 x-create-token——公网防刷房，自托管可关） */
  createToken?: string
  /** turn 预算（缺省 §3.5：10 分钟窗口 30 turn） */
  budget?: TurnBudgetConfig
  /** 房间空转回收阈值（默认 10 分钟——公网面不留常驻状态） */
  idleRoomMs?: number
  /** 每成员限速（默认 1 秒 10 条） */
  rate?: { windowMs: number; max: number }
  /** 房间成员上限（默认 8） */
  memberCap?: number
  now?: () => number
}

export interface RelayServerHandle {
  port: number
  close(): Promise<void>
}

interface MemberConn {
  memberId: string
  displayName: string
  ws: WebSocket
  /** 滑动窗口限速计数（窗口内时间戳） */
  rateHits: number[]
}

interface Room {
  roomId: string
  inviteCode: string
  createdAt: number
  lastActive: number
  memberSeq: number
  members: Map<string, MemberConn>
  ledger: TurnBudgetLedger
  idem: TurnIdempotency
  /** turn 回程表：requestId → { 发起者, 执行端, nonce, 到期 }（result 到达即清；超时随扫描清） */
  pending: Map<string, { from: string; to: string; nonce: string; expiresAt: number }>
}

const CODE_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789' // 去易混字符（0O1lI）

/** 房间码：短（公开标识，10 字符 ≈ 50bit——枚举不划算但非凭据） */
const newRoomId = (): string =>
  Array.from(randomBytes(10), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('')

/** invite 码：凭据（32 字节 base64url = 256bit 熵——一期认证模型，密钥对记档后续） */
const newInviteCode = (): string => randomBytes(32).toString('base64url')

const closeCode = {
  AUTH_FAILED: 4401,
  ROOM_NOT_FOUND: 4404,
  ROOM_FULL: 4409,
  PAYLOAD_INVALID: 4400,
  RATE_LIMITED: 4429,
} as const

export function createRelayServer(options: RelayServerOptions & { port?: number } = {}): Promise<RelayServerHandle> {
  const now = options.now ?? Date.now
  const budget = options.budget ?? XUSER_DEFAULT_BUDGET
  const idleRoomMs = options.idleRoomMs ?? 10 * 60_000
  const rate = options.rate ?? { windowMs: 1_000, max: 10 }
  const memberCap = options.memberCap ?? 8

  const rooms = new Map<string, Room>()

  const app = new Hono()
  app.get('/api/health', (c) => c.json({ ok: true, rooms: rooms.size }))
  app.post('/api/rooms', async (c) => {
    if (options.createToken !== undefined && c.req.header('x-create-token') !== options.createToken) {
      return c.json({ error: 'XUSER_AUTH_FAILED', message: '建房令牌缺失或不符' }, 401)
    }
    const roomId = newRoomId()
    const inviteCode = newInviteCode()
    rooms.set(roomId, {
      roomId,
      inviteCode,
      createdAt: now(),
      lastActive: now(),
      memberSeq: 0,
      members: new Map(),
      ledger: new TurnBudgetLedger(budget),
      idem: new TurnIdempotency(budget.windowMs),
      pending: new Map(),
    })
    return c.json({ roomId, inviteCode }, 201)
  })

  // @hono/node-server 适配（标准桥接；WS 的 upgrade 事件不被拦——wss 挂同一 server 实例）
  const server = serve({ fetch: app.fetch, port: options.port ?? 0, hostname: '0.0.0.0' })

  // ServerType 是 http1/http2 联合——实际构造是 http.Server（port 数字）；断言收窄给 ws
  const wss = new WebSocketServer({ server: server as import('node:http').Server, path: '/ws', maxPayload: 64 * 1024 })

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const roomId = url.searchParams.get('room') ?? ''
    const invite = url.searchParams.get('invite') ?? ''
    const displayName = (url.searchParams.get('name') ?? '').slice(0, 64)

    const room = rooms.get(roomId)
    if (!room || invite !== room.inviteCode || displayName === '') {
      ws.close(closeCode.ROOM_NOT_FOUND, room ? 'invite 码不符' : '房间不存在')
      return
    }
    if (room.members.size >= memberCap) {
      ws.close(closeCode.ROOM_FULL, '房间成员已满')
      return
    }

    room.memberSeq += 1
    const memberId = `m-${room.memberSeq}`
    const conn: MemberConn = { memberId, displayName, ws, rateHits: [] }
    room.members.set(memberId, conn)
    room.lastActive = now()

    send(ws, { kind: 'hello', memberId, room: roomInfo(room) })
    broadcast(room, { kind: 'room-event', event: 'member-joined', memberId, displayName }, { except: memberId })

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        ws.close(closeCode.PAYLOAD_INVALID, '二进制帧不接受')
        return
      }
      room.lastActive = now()
      if (!rateAllow(conn, now())) {
        ws.close(closeCode.RATE_LIMITED, '消息频率超限')
        return
      }
      // 公网输入不可信：JSON 解析与 schema 校验都在 try 内（ws 回调抛异常会炸进程——防线不外泄）
      let envelope: XuserEnvelope | null = null
      try {
        const parsed = envelopeSchema.safeParse(JSON.parse(String(data)))
        if (parsed.success) envelope = parsed.data as XuserEnvelope
      } catch {
        envelope = null
      }
      if (envelope === null) {
        ws.close(closeCode.PAYLOAD_INVALID, '信封不合法')
        return
      }
      // 发送者身份以连接为准（信封里的 fromMemberId 不可信——伪造面收敛）
      if ('fromMemberId' in envelope && envelope.fromMemberId !== memberId) {
        ws.close(closeCode.PAYLOAD_INVALID, 'fromMemberId 与连接身份不符')
        return
      }
      if (envelope.kind === 'mirror-message') return onMirror(room, envelope)
      if (envelope.kind === 'turn-request') return onTurnRequest(room, envelope, now())
      return onTurnResult(room, envelope, now())
    })

    ws.on('close', () => {
      room.members.delete(memberId)
      room.lastActive = now()
      if (room.members.size > 0) {
        broadcast(room, { kind: 'room-event', event: 'member-left', memberId, displayName })
      }
    })
  })

  /** mirror 消息：房间内广播（发送者除外——房间隔离的第一道：只经本房间成员表） */
  const onMirror = (room: Room, msg: MirrorMessage): void => {
    broadcast(room, msg, { except: msg.fromMemberId })
  }

  /** turn 请求：幂等 → 预算 → 路由（目标不在场如实 unreachable；重放回缓存） */
  const onTurnRequest = (room: Room, req: TurnRequest, at: number): void => {
    const requester = room.members.get(req.fromMemberId)
    if (!requester) return // 连接已断（close 竞态）——无从回程
    const key = `${req.fromMemberId}->${req.toMemberId}`
    // 幂等：已结算回缓存（重试拿同一应答）；进行中忽略（发起端在等）
    const settled = room.idem.get(req.nonce)
    if (settled !== undefined) {
      send(requester.ws, resultOf(req, { ...settled, remaining: room.ledger.peek(key, at).remaining }))
      return
    }
    if (!room.idem.start(req.nonce, at)) return
    // 预算（host 单一事实源）：耗尽不转发，直接回 budget-exhausted（拒绝不占预算）；
    // settle 缓存与首答同一份文案——重放拿同一应答
    const verdict = room.ledger.admit(key, at)
    if (!verdict.ok) {
      const exhausted = resultOf(req, {
        status: 'budget-exhausted',
        text: `窗口内 turn 预算已耗尽（${budget.maxTurns} / ${Math.round(budget.windowMs / 60_000)} 分钟）——稍后重试`,
        remaining: 0,
      })
      room.idem.settle(req.nonce, at, { status: exhausted.status, text: exhausted.text })
      send(requester.ws, exhausted)
      return
    }
    const target = room.members.get(req.toMemberId)
    if (!target) {
      room.idem.settle(req.nonce, at, { status: 'unreachable', text: '目标成员不在场' })
      send(requester.ws, resultOf(req, { status: 'unreachable', text: '目标成员不在场', remaining: verdict.remaining }))
      return
    }
    // 回程表：result 到达时找发起者 + 校验执行端身份 + settle 键（result 信封无 nonce——host 侧补记）
    room.pending.set(req.requestId, {
      from: req.fromMemberId,
      to: req.toMemberId,
      nonce: req.nonce,
      expiresAt: at + budget.windowMs,
    })
    send(target.ws, req)
  }

  /** turn 结果：pending 回程（校验执行端身份防伪造）→ settle 幂等缓存 → 转发发起者附余量 */
  const onTurnResult = (room: Room, result: TurnResult, at: number): void => {
    const pending = room.pending.get(result.requestId)
    room.pending.delete(result.requestId)
    if (!pending) return // 重复 result / 伪造 requestId——静默忽略（记档层面问题，不回包）
    if (result.fromMemberId !== pending.to) return // 执行端身份不符（伪造面收敛，不转发）
    room.idem.settle(pending.nonce, at, { status: result.status, text: result.text })
    const requester = room.members.get(pending.from)
    if (requester) {
      send(requester.ws, {
        ...result,
        remaining: room.ledger.peek(`${pending.from}->${pending.to}`, at).remaining,
      })
    }
  }

  const roomInfo = (room: Room): RoomInfo => ({
    roomId: room.roomId,
    createdAt: room.createdAt,
    members: [...room.members.values()].map((m) => ({ memberId: m.memberId, displayName: m.displayName, connected: true })),
  })

  const broadcast = (room: Room, msg: ServerMessage, opts: { except?: string } = {}): void => {
    for (const [id, m] of room.members) {
      if (id === opts.except) continue
      if (m.ws.readyState === m.ws.OPEN) m.ws.send(JSON.stringify(msg))
    }
  }

  const send = (ws: WebSocket, msg: ServerMessage): void => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg))
  }

  /** 组装回执（host 侧代答场景：unreachable/budget-exhausted——fromMemberId 是执行端位） */
  const resultOf = (req: TurnRequest, result: Pick<TurnResult, 'status' | 'text'> & Partial<Pick<TurnResult, 'remaining'>>): TurnResult => ({
    kind: 'turn-result',
    requestId: req.requestId,
    fromMemberId: req.toMemberId,
    status: result.status,
    text: result.text,
    ...(result.remaining !== undefined ? { remaining: result.remaining } : {}),
  })

  const rateAllow = (conn: MemberConn, at: number): boolean => {
    conn.rateHits = conn.rateHits.filter((t) => at - t < rate.windowMs)
    if (conn.rateHits.length >= rate.max) return false
    conn.rateHits.push(at)
    return true
  }

  // 空转回收 + pending 过期清理（30s 扫一轮——公网面不留常驻状态）
  const sweeper = setInterval(() => {
    const at = now()
    for (const room of rooms.values()) {
      if (room.members.size === 0 && at - room.lastActive > idleRoomMs) {
        rooms.delete(room.roomId)
        continue
      }
      for (const [requestId, p] of room.pending) if (at > p.expiresAt) room.pending.delete(requestId)
      room.idem.sweep(at)
    }
  }, 30_000)
  sweeper.unref()

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    const finish = (): void => {
      const addr = server.address()
      if (addr === null || typeof addr === 'string') {
        reject(new Error('监听地址异常'))
        return
      }
      resolve({
        port: addr.port,
        close: async () => {
          clearInterval(sweeper)
          for (const room of rooms.values()) for (const m of room.members.values()) m.ws.close(1001, 'host 关闭')
          wss.close()
          await new Promise<void>((r) => server.close(() => r()))
        },
      })
    }
    // serve() 立即返回但 listen 异步完成（显式端口被占时 error 事件如实抛出——端口规则的实现面）
    if (server.listening) finish()
    else server.once('listening', finish)
  })
}
