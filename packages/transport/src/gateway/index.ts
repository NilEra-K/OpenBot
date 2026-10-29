/**
 * 环回网关：壳与内核之间唯一的网络边界（ARCHITECTURE.md §3.7、§5；docs/protocol.md）。
 * 三通道之二落地（P2）：POST /api/* 控制面 + GET /events SSE 事件流；
 * WS /stream 数据面协议见 stream-protocol（P3 接真实信号源）。
 *
 * 安全三件套：仅绑 127.0.0.1 随机端口；bearer token（POST 走 Authorization，SSE 走 ?token= 查询参数
 * ——EventSource 无法自定义头）；Host 头校验防 DNS rebinding。token 每次启动随机生成，只活在内存链路。
 *
 * 错误语义分层：命令的**领域失败**是正常结果——HTTP 200 + {ok:false,error:{code,message}}；
 * 传输层失败（鉴权/路由/编解码）才用 HTTP 4xx/5xx。渲染层永远解析 envelope，不猜状态码。
 */
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import type { Socket } from 'node:net'
import { WebSocketServer, type WebSocket } from 'ws'
import type { EventBus, KernelEvent, KernelEventHandler } from '@openbot/core'
import type { InProcessTransport } from '../bus/index.js'
import { StreamSession, type StreamWire } from '../stream-protocol/index.js'

export const GatewayErrorCodes = {
  TRANSPORT_UNAUTHORIZED: 'TRANSPORT_UNAUTHORIZED',
  TRANSPORT_FORBIDDEN_HOST: 'TRANSPORT_FORBIDDEN_HOST',
  TRANSPORT_BAD_REQUEST: 'TRANSPORT_BAD_REQUEST',
  TRANSPORT_PAYLOAD_TOO_LARGE: 'TRANSPORT_PAYLOAD_TOO_LARGE',
  TRANSPORT_NOT_FOUND: 'TRANSPORT_NOT_FOUND',
  TRANSPORT_METHOD_NOT_ALLOWED: 'TRANSPORT_METHOD_NOT_ALLOWED',
} as const

// 请求体上限（v0.1.104 附件修正）：附件上传走 base64（×4/3 膨胀）——8MB 文件 ≈ 10.7MB 载荷，
// 旧 2MB 上限致 TRANSPORT_PAYLOAD_TOO_LARGE（用户报障）。网关恒环回（随机端口 + 一次性
// token，renderer→main 同机单用户）——非公网面，12MB 上限覆盖附件上限 + JSON 包裹余量。
const MAX_BODY_BYTES = 12 * 1024 * 1024
const SSE_HEARTBEAT_MS = 15_000

export interface GatewayOptions {
  transport: InProcessTransport
  bus: EventBus
  /** 固定端口（测试注入）；缺省随机（生产路径，不受端口占用约束） */
  port?: number
  /** 固定 token（测试注入）；缺省每次启动随机 */
  token?: string
  /** WS /stream 每连接注入回调（回环自测注入 PAUSE 时机；P3 接真实信号源路由） */
  onStreamSession?: (session: StreamSession) => void
  /** 接收方对向信号转发（gui 实况流的背压即降帧依赖它：RESUME 时信号源补发最新帧） */
  onStreamPause?: (session: StreamSession, streamId: number | 0, paused: boolean) => void
}

export interface GatewayHandle {
  readonly port: number
  readonly token: string
  close(): Promise<void>
}

export async function startGateway(options: GatewayOptions): Promise<GatewayHandle> {
  const { transport, bus } = options
  const token = options.token ?? randomBytes(24).toString('hex')

  const server = createServer((req, res) => {
    void handleRequest(req, res, { transport, bus, token }).catch((err: unknown) => {
      // 兜底：handleRequest 内部已处理一切预期路径，这里是防御性日志位（不留敏感信息）
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { code: 'TRANSPORT_INTERNAL', message: String(err) } }))
    })
  })
  // 记录连接：SSE 长连接会让 server.close() 永等——关闭时主动销毁
  const sockets = new Set<Socket>()
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })

  // WS /stream 数据面：noServer 模式挂 upgrade（Host 校验 + ?token= 鉴权，同 SSE）
  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, socket, head) => {
    const host = req.headers.host ?? ''
    // upgrade 的 socket 类型标注为 Duplex，实际是 net.Socket（可取本地端口）
    const localPort = ((socket as Socket).address() as AddressInfo).port
    if (!isLocalHost(host, localPort)) {
      socket.destroy()
      return
    }
    const url = new URL(req.url ?? '/', `http://${host}`)
    if (url.pathname !== '/stream' || url.searchParams.get('token') !== token) {
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      attachStreamReceiver(ws, options.onStreamSession, options.onStreamPause)
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, '127.0.0.1', () => resolve())
  })
  const port = (server.address() as AddressInfo).port

  return {
    port,
    token,
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const socket of sockets) socket.destroy()
        wss.close(() => server.close((err) => (err ? reject(err) : resolve())))
      }),
  }
}

/** ws → 传输线适配（binary message 边界即协议帧边界） */
function wsWire(ws: WebSocket): StreamWire {
  return {
    send: (data) => ws.send(data),
    onMessage: (cb) =>
      ws.on('message', (data, isBinary) => {
        if (!isBinary) return // 协议只收二进制帧；文本帧忽略（防御）
        cb(data as Buffer)
      }),
    onClose: (cb) => ws.on('close', () => cb()),
    close: () => ws.close(),
  }
}

/**
 * 网关默认接收器：跑满状态机校验（序号连续/未知流/重复流），流 END/ABORT 时回 ACK
 * （END 帧序号即该流最高连续序号——端到端丢帧可见）；协议违规 → 断连。
 * onStreamSession 可注入测试钩子（如特定时机 PAUSE）；P3 换真实信号源路由。
 */
function attachStreamReceiver(
  ws: WebSocket,
  onSession?: (session: StreamSession) => void,
  onStreamPause?: (session: StreamSession, streamId: number | 0, paused: boolean) => void,
): void {
  const wire = wsWire(ws)
  const session = new StreamSession(wire, {
    onEnd: (streamId, seq) => session.sendAck(streamId, seq),
    onAbort: (streamId, seq) => session.sendAck(streamId, seq),
    onViolation: () => wire.close(),
    ...(onStreamPause !== undefined
      ? { onPauseChanged: (streamId: number | 0, paused: boolean) => onStreamPause(session, streamId, paused) }
      : {}),
  })
  onSession?.(session)
}

interface GatewayContext {
  transport: InProcessTransport
  bus: EventBus
  token: string
}

async function handleRequest(req: IncomingMessage, res: ServerResponse, ctx: GatewayContext): Promise<void> {
  const host = req.headers.host ?? ''
  const port = (req.socket.address() as AddressInfo).port
  if (!isLocalHost(host, port)) {
    return jsonError(res, 403, GatewayErrorCodes.TRANSPORT_FORBIDDEN_HOST, `非法 Host：${host}`)
  }
  const url = new URL(req.url ?? '/', `http://${host}`)

  // CORS：renderer 从 file:// 或 dev server（5183）跨源访问环回网关——预检直接放行。
  // 环回安全模型靠一次性 token（仅内存），不靠 origin；无 token 的跨源请求一律 401，无泄露面。
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders(req))
    res.end()
    return
  }

  if (url.pathname === '/events') {
    if (req.method !== 'GET') {
      return jsonError(res, 405, GatewayErrorCodes.TRANSPORT_METHOD_NOT_ALLOWED, '事件流仅支持 GET')
    }
    const queryToken = url.searchParams.get('token')
    if (queryToken !== ctx.token) {
      return jsonError(res, 401, GatewayErrorCodes.TRANSPORT_UNAUTHORIZED, 'token 缺失或不符')
    }
    return serveEvents(req, res, ctx)
  }

  if (url.pathname.startsWith('/api/')) {
    if (req.method !== 'POST') {
      return jsonError(res, 405, GatewayErrorCodes.TRANSPORT_METHOD_NOT_ALLOWED, '控制面仅支持 POST')
    }
    const auth = req.headers.authorization
    if (auth !== `Bearer ${ctx.token}`) {
      return jsonError(res, 401, GatewayErrorCodes.TRANSPORT_UNAUTHORIZED, 'bearer 缺失或不符')
    }
    const command = decodeURIComponent(url.pathname.slice('/api/'.length))
    const body = await readBody(req, res)
    if (body === null) return
    let payload: unknown
    try {
      payload = body.length === 0 ? {} : JSON.parse(body)
    } catch {
      return jsonError(res, 400, GatewayErrorCodes.TRANSPORT_BAD_REQUEST, '请求体不是合法 JSON')
    }
    try {
      const result = await ctx.transport.dispatch(command, payload)
      jsonHead(res, 200, corsHeaders(req))
      res.end(JSON.stringify({ ok: true, result }))
    } catch (err) {
      // 领域失败是正常结果：envelope 承载稳定 code
      const code = errorCodeOf(err) ?? 'TRANSPORT_COMMAND_FAILED'
      const message = err instanceof Error ? err.message : String(err)
      jsonHead(res, 200, corsHeaders(req))
      res.end(JSON.stringify({ ok: false, error: { code, message } }))
    }
    return
  }

  return jsonError(res, 404, GatewayErrorCodes.TRANSPORT_NOT_FOUND, `未知路径：${url.pathname}`)
}

/** CORS 响应头：回显申请的头（Authorization/Content-Type/Last-Event-ID）；源任意（token 才是鉴权面） */
function corsHeaders(req: IncomingMessage): Record<string, string> {
  const requested = req.headers['access-control-request-headers']
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers':
      typeof requested === 'string' && requested.length > 0 ? requested : 'Authorization, Content-Type, Last-Event-ID',
  }
}

/** SSE：先按 Last-Event-ID 补发，再实时订阅；断连即退订 */
function serveEvents(req: IncomingMessage, res: ServerResponse, ctx: GatewayContext): void {
  jsonHead(res, 200, {
    ...corsHeaders(req),
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  // 初始注释行：立即冲出首个字节——防中间层缓冲，也让客户端流在连接期即激活
  // （实测 undici fetch 若连接时 body 零字节，后续实时数据无法流入 reader）
  res.write(':ok\n\n')
  const write = (event: KernelEvent): void => {
    res.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`)
  }
  const lastId = Number(req.headers['last-event-id'] ?? 0)
  const from = Number.isFinite(lastId) && lastId > 0 ? lastId : 0
  for (const event of ctx.bus.since(from)) write(event)
  const handler: KernelEventHandler = (event) => write(event)
  const off = ctx.bus.on('*', handler)
  const heartbeat = setInterval(() => {
    res.write(':ka\n\n')
  }, SSE_HEARTBEAT_MS)
  heartbeat.unref?.()
  req.on('close', () => {
    off()
    clearInterval(heartbeat)
  })
}

function isLocalHost(host: string, port: number): boolean {
  // 合法 Host：127.0.0.1:<port> / localhost:<port> / [::1]:<port>——防 DNS rebinding
  return host === `127.0.0.1:${port}` || host === `localhost:${port}` || host === `[::1]:${port}`
}

async function readBody(req: IncomingMessage, res: ServerResponse): Promise<string | null> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY_BYTES) {
      jsonError(res, 413, GatewayErrorCodes.TRANSPORT_PAYLOAD_TOO_LARGE, `请求体超过 ${MAX_BODY_BYTES} 字节`)
      req.destroy()
      return null
    }
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function jsonHead(res: ServerResponse, status: number, extra?: Record<string, string>): void {
  res.writeHead(status, { 'Content-Type': 'application/json', ...extra })
}

function jsonError(res: ServerResponse, status: number, code: string, message: string): void {
  jsonHead(res, status)
  res.end(JSON.stringify({ error: { code, message } }))
}

/** 提取错误的稳定 code（KernelError/LlmError 等带 code 的 Error 子类） */
function errorCodeOf(err: unknown): string | null {
  if (err instanceof Error) {
    const code = (err as unknown as { code?: unknown }).code
    if (typeof code === 'string') return code
  }
  return null
}
