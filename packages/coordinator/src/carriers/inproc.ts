/**
 * Carrier 接口与 InProcessCarrier：v1 默认载体，直接函数调用——
 * 「拆进程是部署开关，不是架构手术」（ARCHITECTURE.md §1）。kernel 代码永远不知道
 * 自己跑在哪种载体上；UtilityProcessCarrier 落地时补退出码契约 + 指数退避（supervise）。
 */
import type { KernelEventHandler } from '@openbot/core'
import type { AssembledKernel } from '../assemble/index.js'

/** 载体抽象：transport 与壳之间的部署开关 */
export interface Carrier {
  start(): Promise<void>
  request<Res = unknown>(command: string, payload?: unknown): Promise<Res>
  subscribeEvents(handler: KernelEventHandler): () => void
  stop(): Promise<void>
}

export interface InProcessCarrierOptions {
  /** watchdog 心跳间隔；省略则不自动驱动（确定性场景用手动 tick） */
  watchdogIntervalMs?: number
}

export class InProcessCarrier implements Carrier {
  readonly #kernel: AssembledKernel
  readonly #client: ReturnType<AssembledKernel['transport']['createClient']>
  readonly #watchdogIntervalMs: number | undefined

  constructor(kernel: AssembledKernel, options: InProcessCarrierOptions = {}) {
    this.#kernel = kernel
    this.#client = kernel.transport.createClient()
    this.#watchdogIntervalMs = options.watchdogIntervalMs
  }

  async start(): Promise<void> {
    if (this.#watchdogIntervalMs !== undefined) {
      this.#kernel.startWatchdog(this.#watchdogIntervalMs)
    }
  }

  request<Res = unknown>(command: string, payload?: unknown): Promise<Res> {
    return this.#client.call<Res>(command, payload)
  }

  subscribeEvents(handler: KernelEventHandler): () => void {
    return this.#client.subscribe(handler)
  }

  async stop(): Promise<void> {
    this.#kernel.stopWatchdog()
  }
}
