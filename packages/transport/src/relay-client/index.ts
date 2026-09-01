/**
 * RelayClient（P7 Step 4）：桌面端到 relay host 的出站连接——认证加入（invite 码）、
 * 服务端消息回调、mirror 出站（nonce 内部自增）、断连退避重连（与 host 侧同一 backoffDelay
 * 纯函数——语义同源不二套）。纯传输件：不解析领域语义、不碰本地事件（桥接是装配层职责）。
 * WebSocket 实现注入（默认 ws 库）——测试可挂假 server；退避随机源注入可测。
 * 参考：ARCHITECTURE.md §5（远端内容呈现必过 DOMPurify——那是渲染层职责，此处只透传）。
 */
import WebSocket from 'ws'
import { KernelError } from '@openbot/core'
import { backoffDelay, serverMessageSchema } from '@openbot/messaging'
import type { BackoffOptions, MirrorMessage, ServerMessage, TurnResult } from '@openbot/messaging'

export const RelayClientErrorCodes = {
  /** 未连接状态下发送（调用方决定重试时机——mirror 丢弃记档） */
  RELAY_NOT_CONNECTED: 'RELAY_NOT_CONNECTED',
} as const

export type RelayClientState = 'connecting' | 'open' | 'backoff' | 'stopped'

export interface RelayClientOptions {
  /** host WS 地址（ws://host:port） */
  url: string
  roomId: string
  inviteCode: string
  displayName: string
  /** 服务端消息到达（已过 schema 校验——脏消息在客户端侧即拒，不进桥接） */
  onServerMessage: (msg: ServerMessage) => void
  /** 连接状态转移（UI/日志呈现；backoff 态带下次重试延迟） */
  onStateChange: (state: RelayClientState, detail?: { retryInMs?: number }) => void
  /** 退避参数（缺省 baseMs 1s / maxMs 5min / jitter 0.2——与 host 侧同源） */
  backoff?: BackoffOptions
  /** WebSocket 构造器注入（默认 ws 库；测试挂假实现） */
  socketFactory?: (url: string) => MinimalSocket
}

/** ws 的最小表面（注入用） */
export interface MinimalSocket {
  on(event: 'open', cb: () => void): void
  on(event: 'message', cb: (data: unknown) => void): void
  on(event: 'close', cb: (code: number, reason: Buffer) => void): void
  on(event: 'error', cb: (err: Error) => void): void
  send(data: string): void
  close(code?: number, reason?: string): void
  readonly readyState: number
}

const OPEN = 1 // wsreadyState 常量（注入实现对齐）

export class RelayClient {
  readonly #options: RelayClientOptions
  readonly #socketFactory: (url: string) => MinimalSocket
  #socket: MinimalSocket | null = null
  #memberId: string | null = null
  #mirrorSeq = 0
  #attempt = 0
  #stopped = false
  #retryTimer: ReturnType<typeof setTimeout> | null = null

  constructor(options: RelayClientOptions) {
    this.#options = options
    this.#socketFactory = options.socketFactory ?? ((url) => new WebSocket(url) as unknown as MinimalSocket)
  }

  get memberId(): string | null {
    return this.#memberId
  }

  get connected(): boolean {
    return this.#socket !== null && this.#socket.readyState === OPEN && this.#memberId !== null
  }

  /** 启动连接循环（幂等；stop 后不可复用） */
  start(): void {
    if (this.#stopped || this.#socket !== null) return
    this.#connect()
  }

  /** 停止并等待收尾（进行中的重连定时器一并清除——孤儿定时器不留） */
  async stop(): Promise<void> {
    this.#stopped = true
    if (this.#retryTimer !== null) {
      clearTimeout(this.#retryTimer)
      this.#retryTimer = null
    }
    const socket = this.#socket
    this.#socket = null
    this.#memberId = null
    if (socket !== null && socket.readyState === OPEN) {
      await new Promise<void>((resolve) => {
        socket.on('close', () => resolve())
        socket.close(1000, '客户端停止')
        setTimeout(resolve, 3_000).unref?.() // 对端不回 close 帧的兜底
      })
    }
    this.#options.onStateChange('stopped')
  }

  /** mirror 出站（nonce 内部自增幂等键）；未连接抛稳定码（调用方记档丢弃——mirror 是易态镜像非账务） */
  sendMirror(input: Pick<MirrorMessage, 'speakerKind' | 'speakerName' | 'text'>): void {
    if (!this.connected || this.#memberId === null) {
      throw new KernelError(RelayClientErrorCodes.RELAY_NOT_CONNECTED, 'relay 未连接——mirror 未发出')
    }
    this.#mirrorSeq += 1
    this.#socket?.send(
      JSON.stringify({
        kind: 'mirror-message',
        nonce: `${this.#memberId}:${this.#mirrorSeq}`,
        fromMemberId: this.#memberId,
        speakerKind: input.speakerKind,
        speakerName: input.speakerName,
        text: input.text,
        sentAt: Date.now(),
      }),
    )
  }

  /** turn-result 出站（inbound turn 的回程——requestId 与到达的 turn-request 配对）；未连接抛稳定码 */
  sendTurnResult(input: Pick<TurnResult, 'requestId' | 'status' | 'text'>): void {
    if (!this.connected || this.#memberId === null) {
      throw new KernelError(RelayClientErrorCodes.RELAY_NOT_CONNECTED, 'relay 未连接——turn-result 未发出')
    }
    this.#socket?.send(
      JSON.stringify({
        kind: 'turn-result',
        requestId: input.requestId,
        fromMemberId: this.#memberId,
        status: input.status,
        text: input.text,
      }),
    )
  }

  #connect(): void {
    if (this.#stopped) return
    const url = `${this.#options.url}?room=${encodeURIComponent(this.#options.roomId)}&invite=${encodeURIComponent(this.#options.inviteCode)}&name=${encodeURIComponent(this.#options.displayName)}`
    this.#options.onStateChange('connecting')
    const socket = this.#socketFactory(url)
    this.#socket = socket

    socket.on('message', (data) => {
      // 脏消息客户端侧即拒（schema 同 host 侧——两端一条校验线）
      let msg: ServerMessage | null = null
      try {
        const parsed = serverMessageSchema.safeParse(JSON.parse(String(data)))
        if (parsed.success) msg = parsed.data
      } catch {
        msg = null
      }
      if (msg === null) return
      if (msg.kind === 'hello') {
        this.#memberId = msg.memberId
        this.#attempt = 0 // 真正成功 = 入场（hello）——闪断循环不反复以首档退避打 host
        this.#options.onStateChange('open')
      }
      this.#options.onServerMessage(msg)
    })

    socket.on('close', () => {
      this.#socket = null
      this.#memberId = null
      if (this.#stopped) return
      // 不可达退避：指数 + jitter（与 host 侧同一纯函数）
      this.#attempt += 1
      const delayMs = backoffDelay(this.#attempt, this.#options.backoff)
      this.#options.onStateChange('backoff', { retryInMs: delayMs })
      this.#retryTimer = setTimeout(() => {
        this.#retryTimer = null
        this.#connect()
      }, delayMs)
    })

    socket.on('error', () => {
      // ws 错误后必随 close（重连逻辑收敛在 close 一处）
    })
  }
}
