/**
 * 七族事件目录（内核侧类型）+ 类型化事件总线
 * 协议纯度：只含领域事实，永远没有 UI 指令；错误与状态传稳定 code（ARCHITECTURE.md §5）。
 * wire 定义见 docs/protocol.md 与 @openbot/transport（P2 网关）。
 */
import type { Lane, RunOutcomeState } from '../lifecycle/index.js'

export type EventFamily =
  | 'lifecycle'
  | 'message'
  | 'task'
  | 'box'
  | 'approval'
  | 'graph'
  | 'system'

// ---- v1 事件 payload 目录（新增字段必须向后兼容：可选或带默认） ----

export interface LifecycleQueuedPayload {
  runId: string
  agentId: string
  lane: Lane
  kind: string
  /** 是否可 steer（user lane 隐含 true） */
  steer: boolean
  /** run 在做什么的一句话事实（首条消息截断，发送侧归一；排程视图描述行消费） */
  summary?: string
}

export interface LifecycleStartedPayload {
  runId: string
  agentId: string
  lane: Lane
  kind: string
}

export interface LifecycleFinishedPayload {
  runId: string
  agentId: string
  state: RunOutcomeState
  code?: string
  attempts: number
}

export interface LifecycleEscapedPayload {
  runId: string
  agentId: string
  graceMs: number
}

export interface LifecycleReapedPayload {
  runId: string
  agentId: string
}

export interface LifecycleIdlePayload {
  agentId: string
}

/** 用户消息入站（默认路由或显式 @） */
export interface MessageUserPayload {
  messageId: string
  toAgentId: string
  text: string
}

/** agent 回复 */
export interface MessageAgentPayload {
  messageId: string
  agentId: string
  text: string
  runId?: string
}

/** A2A 私聊（双侧 transcript 镜像；isRedriven 防环见 messaging） */
export interface MessageA2aPayload {
  messageId: string
  fromAgentId: string
  toAgentId: string
  text: string
  priority: boolean
  isRedriven: boolean
}

export type BoxState = 'active' | 'sleeping' | 'snapshot'

export interface BoxStatePayload {
  boxId: string
  state: BoxState
}

export interface BoxExecPayload {
  boxId: string
  runId?: string
  phase: 'started' | 'finished'
  command: string[]
  exitCode?: number
}

export interface ApprovalRequestedPayload {
  approvalId: string
  runId: string
  agentId: string
  tool: string
  reason?: string
  /** 幂等键：重试不双弹窗、不双执行 */
  nonce: string
}

export interface ApprovalResolvedPayload {
  approvalId: string
  decision: 'approved' | 'denied'
  nonce: string
}

/** roster 与角色变更（steward 唯一性由 state 层排他事务强制） */
export interface SystemRosterPayload {
  agentId: string
  role: 'steward' | 'worker'
  cause: 'registered' | 'removed' | 'appointed' | 'dismissed' | 'transferred'
}

/** 事件类型 → payload 的唯一映射（v2 破坏性变更时另起 map） */
export interface KernelEventMap {
  'v1.lifecycle.queued': LifecycleQueuedPayload
  'v1.lifecycle.started': LifecycleStartedPayload
  'v1.lifecycle.finished': LifecycleFinishedPayload
  'v1.lifecycle.escaped': LifecycleEscapedPayload
  'v1.lifecycle.reaped': LifecycleReapedPayload
  'v1.lifecycle.idle': LifecycleIdlePayload
  'v1.message.user': MessageUserPayload
  'v1.message.agent': MessageAgentPayload
  'v1.message.a2a': MessageA2aPayload
  'v1.box.state': BoxStatePayload
  'v1.box.exec': BoxExecPayload
  'v1.approval.requested': ApprovalRequestedPayload
  'v1.approval.resolved': ApprovalResolvedPayload
  'v1.system.roster': SystemRosterPayload
}

export type KernelEventType = keyof KernelEventMap

export interface KernelEvent<T extends KernelEventType = KernelEventType> {
  /** 全局单调序号——将来 SSE Last-Event-ID 续传的钩子 */
  seq: number
  type: T
  /** 逻辑时钟 ms（注入的 now()，不读系统时钟） */
  at: number
  payload: KernelEventMap[T]
}

export type KernelEventHandler = (event: KernelEvent) => void

export interface EventBusOptions {
  now: () => number
}

/**
 * 类型化事件总线：同步分发（确定性——顺序即订阅序）、seq 单调、since(seq) 可重放。
 * 异步缓冲与跨进程转发是 transport 的事。订阅方不许抛异常（抛出=bug，直接向上暴露）。
 */
export class EventBus {
  readonly #now: () => number
  #seq = 0
  #log: KernelEvent[] = []
  #handlers = new Map<KernelEventType | '*', Set<KernelEventHandler>>()

  constructor(options: EventBusOptions) {
    this.#now = options.now
  }

  emit<T extends KernelEventType>(type: T, payload: KernelEventMap[T]): KernelEvent<T> {
    this.#seq += 1
    const event: KernelEvent<T> = { seq: this.#seq, type, at: this.#now(), payload }
    this.#log.push(event)
    this.#dispatch(type, event)
    this.#dispatch('*', event)
    return event
  }

  /** 订阅具体事件类型或 '*'（全部）；返回退订函数 */
  on(type: KernelEventType | '*', handler: KernelEventHandler): () => void {
    let set = this.#handlers.get(type)
    if (!set) {
      set = new Set()
      this.#handlers.set(type, set)
    }
    set.add(handler)
    return () => {
      set.delete(handler)
    }
  }

  /** 重放 seq 之后的事件（续传语义：since(0) = 全量） */
  since(seq: number): KernelEvent[] {
    return this.#log.filter((event) => event.seq > seq)
  }

  /** 已发出事件总数 */
  get size(): number {
    return this.#log.length
  }

  #dispatch(type: KernelEventType | '*', event: KernelEvent): void {
    const set = this.#handlers.get(type)
    if (!set) return
    // 拷贝后再遍历：允许订阅方在回调内安全退订
    for (const handler of [...set]) handler(event)
  }
}
