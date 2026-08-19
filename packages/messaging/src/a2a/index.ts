/**
 * A2A 私聊与用户入站定向消息：对称唤醒、priority steer、DM 抢占后 at-least-once 重驱
 * （isRedriven 防环）、双侧 transcript 镜像、幂等账本零双发。
 * 用户消息与 A2A 同为 1:1 定向消息，共用受理管线；群聊/广播/subagent 见各自模块。
 * 参考：ARCHITECTURE.md §3.5 —— P1 实现。
 */
import { KernelError } from '@openbot/core'
import type { AgentScheduler, EventBus, RunTicket } from '@openbot/core'
import { digestOf } from '@openbot/state'
import type { IdempotencyLedger, TranscriptStore } from '@openbot/state'

export const MessagingErrorCodes = {
  /** A2A 不允许发给自己 */
  MSG_SELF_SEND: 'MSG_SELF_SEND',
  /** 重驱后的 run 再次被 steer：at-least-once 机会已用完（防环截止） */
  MSG_REDRIVE_EXHAUSTED: 'MSG_REDRIVE_EXHAUSTED',
  /** 重驱入队本身失败（如调度器已销毁） */
  MSG_REDRIVE_FAILED: 'MSG_REDRIVE_FAILED',
} as const

/** user lane run 负载（runner 解释执行） */
export interface UserChatRunPayload {
  messageId: string
  text: string
}

/** agent lane run 负载（runner 解释执行） */
export interface A2aRunPayload {
  messageId: string
  fromAgentId: string
  text: string
  priority: boolean
  isRedriven: boolean
}

export interface A2aDeps {
  bus: EventBus
  now: () => number
  nextMessageId: () => string
  transcript: TranscriptStore
  ledger: IdempotencyLedger
  /** 目标 agent 的调度器（coordinator 装配；未注册 agent 由装配方抛错） */
  schedulerOf: (agentId: string) => AgentScheduler
}

export interface SendUserMessageInput {
  toAgentId: string
  text: string
  /** 调用方幂等键（transport 层生成，重试同键） */
  nonce: string
}

export interface SendA2aInput {
  fromAgentId: string
  toAgentId: string
  text: string
  priority?: boolean
  nonce: string
}

/** 受理回执：first=false 表示重试回放（未双发），runId 取首次受理值 */
export interface MessageAcceptance {
  messageId: string
  runId: string | null
  first: boolean
}

export class A2aService {
  readonly #deps: A2aDeps
  /** 重驱链路的诊断记录（fire-and-forget 分支不静默吞错） */
  readonly failures: KernelError[] = []

  constructor(deps: A2aDeps) {
    this.#deps = deps
  }

  /** 用户 → agent（默认路由后的定向投递；user lane，永不抢他人也不被抢） */
  async sendUserMessage(input: SendUserMessageInput): Promise<MessageAcceptance> {
    const { bus, transcript, ledger, schedulerOf, nextMessageId, now } = this.#deps
    const digest = digestOf({ to: input.toAgentId, text: input.text })
    const begin = await ledger.begin(`user:${input.nonce}`, digest)
    if (!begin.first) {
      const stored = begin.entry.outcome as MessageAcceptance | undefined
      return stored ? { ...stored, first: false } : { messageId: '', runId: null, first: false }
    }
    const messageId = nextMessageId()
    await transcript.append(input.toAgentId, 'user', { messageId, text: input.text, at: now() })
    bus.emit('v1.message.user', { messageId, toAgentId: input.toAgentId, text: input.text })
    const ticket: RunTicket = schedulerOf(input.toAgentId).enqueue({
      lane: 'user',
      kind: 'chat',
      payload: { messageId, text: input.text } satisfies UserChatRunPayload,
    })
    const acceptance: MessageAcceptance = { messageId, runId: ticket.runId, first: true }
    await ledger.commit(`user:${input.nonce}`, acceptance)
    return acceptance
  }

  /** agent → agent 私聊：fire-and-forget——受理（账本+镜像+唤醒）即返回，执行异步 */
  async sendA2a(input: SendA2aInput): Promise<MessageAcceptance> {
    if (input.fromAgentId === input.toAgentId) {
      throw new KernelError(MessagingErrorCodes.MSG_SELF_SEND, `不能给自己发 A2A：${input.fromAgentId}`)
    }
    const { bus, transcript, ledger, schedulerOf, nextMessageId, now } = this.#deps
    const priority = input.priority === true
    const digest = digestOf({ from: input.fromAgentId, to: input.toAgentId, text: input.text, priority })
    const begin = await ledger.begin(`a2a:${input.nonce}`, digest)
    if (!begin.first) {
      const stored = begin.entry.outcome as MessageAcceptance | undefined
      return stored ? { ...stored, first: false } : { messageId: '', runId: null, first: false }
    }
    const messageId = nextMessageId()
    // 双侧 transcript 镜像：发送侧 a2a-out、接收侧 a2a-in
    await transcript.append(input.fromAgentId, 'a2a-out', {
      messageId,
      to: input.toAgentId,
      text: input.text,
      priority,
      at: now(),
    })
    await transcript.append(input.toAgentId, 'a2a-in', {
      messageId,
      from: input.fromAgentId,
      text: input.text,
      priority,
      at: now(),
    })
    bus.emit('v1.message.a2a', {
      messageId,
      fromAgentId: input.fromAgentId,
      toAgentId: input.toAgentId,
      text: input.text,
      priority,
      isRedriven: false,
    })
    const payload: A2aRunPayload = {
      messageId,
      fromAgentId: input.fromAgentId,
      text: input.text,
      priority,
      isRedriven: false,
    }
    const ticket = schedulerOf(input.toAgentId).enqueue({
      lane: 'agent',
      kind: 'a2a',
      steer: priority,
      payload,
    })
    this.#watchSteer(input.toAgentId, payload, ticket)
    const acceptance: MessageAcceptance = { messageId, runId: ticket.runId, first: true }
    await ledger.commit(`a2a:${input.nonce}`, acceptance)
    return acceptance
  }

  /**
   * fire-and-forget（显式语义，架构允许的例外）：run 被 priority DM 抢占（RUN_STEER）后
   * at-least-once 重驱一次；isRedriven=true 的 run 再被抢即截止（防环）。
   */
  #watchSteer(toAgentId: string, payload: A2aRunPayload, ticket: RunTicket): void {
    void ticket.settled.then((outcome) => {
      if (outcome.state !== 'aborted' || outcome.code !== 'RUN_STEER') return
      if (payload.isRedriven) {
        this.failures.push(
          new KernelError(
            MessagingErrorCodes.MSG_REDRIVE_EXHAUSTED,
            `消息 ${payload.messageId} 重驱后再次被抢占，不再重驱（防环）`,
          ),
        )
        return
      }
      try {
        const redriven: A2aRunPayload = { ...payload, isRedriven: true }
        const next = this.#deps.schedulerOf(toAgentId).enqueue({
          lane: 'agent',
          kind: 'a2a',
          steer: redriven.priority,
          payload: redriven,
        })
        this.#watchSteer(toAgentId, redriven, next)
      } catch (err) {
        this.failures.push(
          err instanceof KernelError
            ? err
            : new KernelError('MSG_REDRIVE_FAILED', String(err)),
        )
      }
    })
  }
}
