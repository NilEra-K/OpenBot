/**
 * turn 执行引擎：调度器 execute 回调的实现——chat（用户消息）与 a2a（私聊唤醒）两种 run。
 * 工具循环：llm 回 toolCalls → 逐个执行 → 结果回喂 → 直到无命令（终答）或预算耗尽。
 * transcript 只记领域消息（user/agent/a2a），工具往返留在 turn 内（详细任务日志归 v1.task，后续）。
 * 参考：ARCHITECTURE.md §3.6。
 */
import { KernelError } from '@openbot/core'
import type { ActiveRun, EventBus, RunExecutor } from '@openbot/core'
import type { TranscriptStore } from '@openbot/state'
import type { A2aRunPayload, UserChatRunPayload } from '@openbot/messaging'
import { LlmError } from '@openbot/llm'
import type { ChatMessage, ChatProvider } from '@openbot/llm'
import type { RunStreamEvent } from '../stream/index.js'
import type { ToolContext, ToolRegistry } from '../tools/index.js'

export const RunnerErrorCodes = {
  RUN_KIND_UNKNOWN: 'RUN_KIND_UNKNOWN',
  /** 工具轮次预算耗尽（防失控循环） */
  RUN_TOOL_BUDGET_EXCEEDED: 'RUN_TOOL_BUDGET_EXCEEDED',
  /** llm 抛出非 LlmError 的未知错误 */
  LLM_FAILED: 'LLM_FAILED',
} as const

export const DEFAULT_MAX_TOOL_ROUNDS = 8

export interface TurnRunnerDeps {
  bus: EventBus
  transcript: TranscriptStore
  /** 每 agent 的模型客户端（coordinator 装配时注入） */
  llmOf: (agentId: string) => ChatProvider
  tools: ToolRegistry
  /** 每 agent 绑定的 Box（null = 无沙箱，in-box 工具报 TOOL_NO_BOX） */
  boxOf: (agentId: string) => string | null
  nextMessageId: () => string
  systemPrompt?: string | ((agentId: string) => string)
  maxToolRounds?: number
  /**
   * run 实况上报（装配注入，接 WS /stream；不进事件总线）：
   * llm 轮次 open/chunk/end（onText 增量）；exec 流由工具层（BoxToolDeps.onStream）同型上报。
   */
  onStream?: (event: RunStreamEvent) => void
}

interface TurnInput {
  userMessage: ChatMessage
  originMessageId: string
}

export class TurnRunner {
  readonly #deps: TurnRunnerDeps

  constructor(deps: TurnRunnerDeps) {
    this.#deps = deps
  }

  /** 直接作为 AgentSchedulerOptions.execute 使用 */
  readonly execute: RunExecutor = async (run: ActiveRun) => {
    if (run.kind === 'chat') {
      const payload = run.payload as UserChatRunPayload
      return this.#runTurn(run, {
        userMessage: { role: 'user', content: payload.text },
        originMessageId: payload.messageId,
      })
    }
    if (run.kind === 'a2a') {
      const payload = run.payload as A2aRunPayload
      const prefix = payload.isRedriven ? `[A2A ${payload.fromAgentId}·重驱]` : `[A2A ${payload.fromAgentId}]`
      return this.#runTurn(run, {
        userMessage: { role: 'user', content: `${prefix} ${payload.text}` },
        originMessageId: payload.messageId,
      })
    }
    throw new KernelError(RunnerErrorCodes.RUN_KIND_UNKNOWN, `未知 run 种类：${run.kind}`)
  }

  async #runTurn(run: ActiveRun, input: TurnInput): Promise<{ text: string }> {
    const { agentId } = run
    // 入站消息在受理时已落 transcript（durable acceptance）；组装历史时剔除，避免同消息双计
    const history = toChatMessages(
      (await this.#deps.transcript.readAll(agentId)).filter(
        (record) => messageIdOf(record.payload) !== input.originMessageId,
      ),
    )
    const messages: ChatMessage[] = []
    const system = typeof this.#deps.systemPrompt === 'function' ? this.#deps.systemPrompt(agentId) : this.#deps.systemPrompt
    if (system) messages.push({ role: 'system', content: system })
    messages.push(...history, input.userMessage)

    const maxRounds = this.#deps.maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS
    const emitStream = this.#deps.onStream
    const emit = (event: Omit<RunStreamEvent, 'agentId' | 'runId'>): void => {
      emitStream?.({ ...event, agentId, runId: run.runId })
    }
    let round = 0 // 工具轮计数（预算判据，语义不变）
    let chatRound = 0 // chat 序号（llm 流事件标注，含终答轮）
    for (;;) {
      // llm 流：open（轮次序号）→ onText 增量 chunk → end/abort（聚合终态语义在 chat 返回值里）
      chatRound += 1
      emit({ type: 'open', stream: 'llm', meta: { round: chatRound } })
      let response: Awaited<ReturnType<ChatProvider['chat']>>
      try {
        response = await this.#chat(
          agentId,
          messages,
          run.signal,
          emitStream ? (delta) => emit({ type: 'chunk', stream: 'llm', text: delta }) : undefined,
        )
        emit({ type: 'end', stream: 'llm' })
      } catch (err) {
        emit({ type: 'abort', stream: 'llm', reason: err instanceof Error ? err.message : String(err) })
        throw err
      }
      if (response.toolCalls.length === 0) {
        const text = response.text ?? ''
        const messageId = this.#deps.nextMessageId()
        await this.#deps.transcript.append(agentId, 'agent', {
          messageId,
          text,
          replyTo: input.originMessageId,
          runId: run.runId,
        })
        this.#deps.bus.emit('v1.message.agent', { messageId, agentId, text, runId: run.runId })
        return { text }
      }
      round += 1
      if (round > maxRounds) {
        throw new KernelError(
          RunnerErrorCodes.RUN_TOOL_BUDGET_EXCEEDED,
          `工具轮次超过预算 ${maxRounds}（run ${run.runId}）`,
        )
      }
      messages.push({ role: 'assistant', content: response.text ?? '', toolCalls: response.toolCalls })
      const boxId = this.#deps.boxOf(agentId)
      for (const call of response.toolCalls) {
        const ctx: ToolContext = {
          agentId,
          runId: run.runId,
          originMessageId: input.originMessageId,
          toolCallId: call.id,
          boxId,
          signal: run.signal,
        }
        const result = await this.#deps.tools.execute(ctx, call)
        messages.push({ role: 'tool', content: result, toolCallId: call.id })
      }
    }
  }

  /** 边界转换：LlmError → 同 code 的 KernelError；未知异常归类 LLM_FAILED */
  async #chat(agentId: string, messages: ChatMessage[], signal: AbortSignal, onText?: (delta: string) => void) {
    try {
      return await this.#deps.llmOf(agentId).chat(
        { messages, tools: this.#deps.tools.specs(), ...(onText ? { onText } : {}) },
        signal,
      )
    } catch (err) {
      if (err instanceof KernelError) throw err
      if (err instanceof LlmError) throw new KernelError(err.code, err.message)
      throw new KernelError(RunnerErrorCodes.LLM_FAILED, err instanceof Error ? err.message : String(err))
    }
  }
}

/** 取 transcript 记录携带的消息 id（无则 null） */
function messageIdOf(payload: unknown): string | null {
  if (typeof payload === 'object' && payload !== null) {
    const id = (payload as Record<string, unknown>)['messageId']
    if (typeof id === 'string') return id
  }
  return null
}

/** transcript 记录 → 会话历史（只映射领域消息；工具往返不入历史） */
export function toChatMessages(records: { kind: string; payload: unknown }[]): ChatMessage[] {  const messages: ChatMessage[] = []
  for (const record of records) {
    const payload = typeof record.payload === 'object' && record.payload !== null ? (record.payload as Record<string, unknown>) : {}
    const text = typeof payload['text'] === 'string' ? payload['text'] : ''
    if (record.kind === 'user') {
      messages.push({ role: 'user', content: text })
    } else if (record.kind === 'agent') {
      messages.push({ role: 'assistant', content: text })
    } else if (record.kind === 'a2a-in') {
      const from = typeof payload['from'] === 'string' ? payload['from'] : '?'
      messages.push({ role: 'user', content: `[A2A ${from}] ${text}` })
    } else if (record.kind === 'a2a-out') {
      const to = typeof payload['to'] === 'string' ? payload['to'] : '?'
      messages.push({ role: 'assistant', content: `[A2A → ${to}] ${text}` })
    }
  }
  return messages
}
