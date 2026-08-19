/**
 * in-process bus（v1 第一载体）：命令面（异步 RPC）+ 事件面（订阅/重放）。
 * 壳只许经此处说话（ARCHITECTURE.md §2 铁律 3）——P1 是同进程直调，
 * P2 环回网关（HTTP/SSE/WS）替换承载而不换这套表面。
 * 协议纯度：命令与事件只有领域事实；错误传稳定 code（KernelError 原样透传，
 * 跨进程网关落地时再序列化为 code+message 对象）。
 */
import { KernelError } from '@openbot/core'
import type { EventBus, KernelEventHandler } from '@openbot/core'

export const TransportErrorCodes = {
  TRANSPORT_COMMAND_NOT_FOUND: 'TRANSPORT_COMMAND_NOT_FOUND',
  /** 同名命令重复注册（装配错误） */
  TRANSPORT_COMMAND_DUPLICATE: 'TRANSPORT_COMMAND_DUPLICATE',
  /** handler 拒绝非 Error 值时的兜底归类 */
  TRANSPORT_COMMAND_FAILED: 'TRANSPORT_COMMAND_FAILED',
} as const

export type CommandName = string
export type CommandHandler = (payload: unknown) => Promise<unknown>

/** 壳侧唯一表面：命令进、事件出（单向流，ARCHITECTURE.md §8） */
export interface TransportClient {
  /** 控制面调用：handler 抛 KernelError 时按 code 透传拒绝 */
  call<Res = unknown>(command: CommandName, payload?: unknown): Promise<Res>
  /** 事件订阅；返回退订函数 */
  subscribe(handler: KernelEventHandler): () => void
  /** 按 seq 重放（P1 供断线恢复；P2 对应 SSE Last-Event-ID） */
  eventsSince(seq: number): ReturnType<EventBus['since']>
}

export interface InProcessTransportOptions {
  /** 内核事件总线（coordinator 注入；seq/时间戳由它保证） */
  bus: EventBus
}

export class InProcessTransport {
  readonly #bus: EventBus
  readonly #handlers = new Map<CommandName, CommandHandler>()

  constructor(options: InProcessTransportOptions) {
    this.#bus = options.bus
  }

  /** coordinator 装配时注册命令（同名重复注册 = 装配错误，直接拒绝） */
  register(command: CommandName, handler: CommandHandler): this {
    if (this.#handlers.has(command)) {
      throw new KernelError(TransportErrorCodes.TRANSPORT_COMMAND_DUPLICATE, `命令重复注册：${command}`)
    }
    this.#handlers.set(command, handler)
    return this
  }

  has(command: CommandName): boolean {
    return this.#handlers.has(command)
  }

  listCommands(): CommandName[] {
    return [...this.#handlers.keys()].sort()
  }

  createClient(): TransportClient {
    return {
      call: <Res>(command: CommandName, payload?: unknown) =>
        this.#dispatch(command, payload) as Promise<Res>,
      subscribe: (handler: KernelEventHandler) => this.#bus.on('*', handler),
      eventsSince: (seq: number) => this.#bus.since(seq),
    }
  }

  async #dispatch(command: CommandName, payload: unknown): Promise<unknown> {
    const handler = this.#handlers.get(command)
    if (!handler) {
      throw new KernelError(TransportErrorCodes.TRANSPORT_COMMAND_NOT_FOUND, `未知命令：${command}`)
    }
    try {
      return await handler(payload ?? {})
    } catch (err) {
      if (err instanceof Error) throw err // KernelError 等按 code 原样透传
      throw new KernelError(TransportErrorCodes.TRANSPORT_COMMAND_FAILED, String(err))
    }
  }
}
