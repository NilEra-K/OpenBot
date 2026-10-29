/**
 * A2A 私聊与用户入站定向消息：对称唤醒、priority steer、DM 抢占后 at-least-once 重驱
 * （isRedriven 防环）、双侧 transcript 镜像、幂等账本零双发。
 * 用户消息与 A2A 同为 1:1 定向消息，共用受理管线；群聊/广播/subagent 见各自模块。
 * 参考：ARCHITECTURE.md §3.5 —— P1 实现。
 */
import { KernelError } from '@openbot/core'
import type { AgentScheduler, EventBus, RunTicket } from '@openbot/core'
import type { AttachmentMeta } from '@openbot/core'
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

/** run 摘要截断上限（UTF-16 码元，与 renderer 显示宽度大致对齐） */
const SUMMARY_LIMIT = 80

/** 首条消息文本 → 一句话摘要（归一空白、截断加省略号——领域事实，进 queued 事件） */
export function summarizeRun(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= SUMMARY_LIMIT ? flat : `${flat.slice(0, SUMMARY_LIMIT)}…`
}

/** user lane run 负载（runner 解释执行） */
export interface UserChatRunPayload {
  messageId: string
  text: string
  /** 引用会话（「会话掌控」）：runner 组装注入（同 SendUserMessageInput.sessionRef） */
  sessionRef?: { agentId: string; sessionId: string | null }
  /** 图片附件（v0.1.102）：runner 按模型视觉能力注入 image part 或文本降级 */
  attachments?: AttachmentMeta[]
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
  /** 引用会话（「会话掌控」composer 引用按钮）：随消息落盘 + run payload——组装层注入被引
   *  会话内容（TurnRunner.#injectSessionRefs） */
  sessionRef?: { agentId: string; sessionId: string | null }
  /** 图片附件（v0.1.102 一期）：meta 随消息全链流动（transcript/run/事件）——本体已先经
   *  v1.attachments.upload 落盘（内容寻址），此处零字节搬运 */
  attachments?: AttachmentMeta[]
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
    const attachments = input.attachments !== undefined && input.attachments.length > 0 ? input.attachments : undefined
    const digest = digestOf({ to: input.toAgentId, text: input.text, att: attachments?.map((a) => a.id) ?? [] })
    const begin = await ledger.begin(`user:${input.nonce}`, digest)
    if (!begin.first) {
      const stored = begin.entry.outcome as MessageAcceptance | undefined
      return stored ? { ...stored, first: false } : { messageId: '', runId: null, first: false }
    }
    const messageId = nextMessageId()
    await transcript.append(input.toAgentId, 'user', {
      messageId,
      text: input.text,
      at: now(),
      ...(input.sessionRef !== undefined ? { sessionRef: input.sessionRef } : {}),
      // 附件 meta 随记录落盘（v0.1.102）：本体不进 transcript（append-only 只存事实引用）
      ...(attachments !== undefined ? { attachments } : {}),
    })
    bus.emit('v1.message.user', {
      messageId,
      toAgentId: input.toAgentId,
      text: input.text,
      ...(input.sessionRef !== undefined ? { sessionRef: input.sessionRef } : {}),
      ...(attachments !== undefined ? { attachments } : {}),
    })
    const ticket: RunTicket = schedulerOf(input.toAgentId).enqueue({
      lane: 'user',
      kind: 'chat',
      payload: {
        messageId,
        text: input.text,
        ...(input.sessionRef !== undefined ? { sessionRef: input.sessionRef } : {}),
        ...(attachments !== undefined ? { attachments } : {}),
      } satisfies UserChatRunPayload,
      summary: summarizeRun(input.text),
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
      summary: summarizeRun(`A2A ${input.fromAgentId} → ${input.toAgentId}：${input.text}`),
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
          summary: summarizeRun(`A2A ${payload.fromAgentId} → ${toAgentId}：${payload.text}`),
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
