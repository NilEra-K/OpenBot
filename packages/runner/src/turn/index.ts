/**
 * turn 执行引擎：调度器 execute 回调的实现——chat（用户消息）与 a2a（私聊唤醒）两种 run。
 * 工具循环：llm 回 toolCalls → 逐个执行 → 结果回喂 → 直到无命令（终答）或预算耗尽。
 * transcript 记领域消息（user/agent/a2a）与过程事实（thinking/exec——完成点聚合落盘，
 * 重启后对话流可恢复；不进 llm 历史）。参考：ARCHITECTURE.md §3.6/§7。
 */
import { KernelError } from '@openbot/core'
import type { ActiveRun, EventBus, RunExecutor } from '@openbot/core'
import type { TranscriptStore } from '@openbot/state'
import type { A2aRunPayload, GroupTurnPayload, UserChatRunPayload } from '@openbot/messaging'
import { GROUP_PASS_TOKEN } from '@openbot/messaging'
import { LlmError } from '@openbot/llm'
import type { ChatMessage, ChatProvider } from '@openbot/llm'
import type { RunStreamEvent } from '../stream/index.js'
import type { ToolContext, ToolRegistry } from '../tools/index.js'
import { MAX_THINKING_CHARS, truncateForTranscript } from '../tools/index.js'

export const RunnerErrorCodes = {
  RUN_KIND_UNKNOWN: 'RUN_KIND_UNKNOWN',
  /** 工具轮次预算耗尽（防失控循环） */
  RUN_TOOL_BUDGET_EXCEEDED: 'RUN_TOOL_BUDGET_EXCEEDED',
  /** llm 抛出非 LlmError 的未知错误 */
  LLM_FAILED: 'LLM_FAILED',
  /** run 已被外部中止（用户打断/抢占）——轮间检查点的快速终止 */
  RUN_ABORTED: 'RUN_ABORTED',
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
  /**
   * 群轮转代际过期判定（P5 Step 4 修复，装配注入 = GroupService.isStale）：
   * supersede 后旧轮 turn 的终答写入前拦截——不落群流不发事件（静默丢弃）。
   * 缺席时（测试最小注入）不做拦截——写入与编排层代际判定（onSettled）双层防线。
   */
  isGroupTurnStale?: (payload: GroupTurnPayload) => boolean
}

interface TurnInput {
  userMessage: ChatMessage
  originMessageId: string
  /**
   * 会话归属（P5 Step 3 群聊）：在场时历史与终答都走群流（transcript 键=groupId、
   * 终答 kind=group-agent、事件=v1.group.message）；缺席=默认 agent 私聊流。
   * 过程事实（thinking/exec）仍记 agentId——过程归 agent，消息归群。
   * stale（P5 Step 4）：终答写入前判定——true=旧轮被 supersede，静默丢弃。
   */
  session?: {
    groupId: string
    emitFinal: (messageId: string, text: string, runId: string) => void
    stale?: () => boolean
  }
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
    // 群成员轮转（§3.6 GroupMemberRunner 语义）：历史=群流，终答写群流
    if (run.kind === 'group') {
      const payload = run.payload as GroupTurnPayload
      const ctx = payload.context.length > 0 ? `本轮已发言：\n${payload.context.join('\n')}\n\n` : ''
      const mentioned = payload.mentioned.length > 0 ? `（点名：${payload.mentioned.join('、')}）` : ''
      return this.#runTurn(run, {
        userMessage: {
          role: 'user',
          content: `[群 ${payload.groupId} · 第${payload.round}轮]${mentioned} ${payload.text}\n${ctx}（群聊轮转：若无补充请只回复 ${'[pass]'}）`,
        },
        originMessageId: payload.messageId,
        session: {
          groupId: payload.groupId,
          emitFinal: (messageId, text, runId) => {
            this.#deps.bus.emit('v1.group.message', {
              groupId: payload.groupId,
              messageId,
              kind: 'agent',
              from: run.agentId,
              text,
              runId,
            })
          },
          // 代际过期（supersede）终答静默丢弃——写入前判定（E2E 实测：编排层 onSettled
          // 拦不住先行的 transcript/事件写入——防线必须前移到写入点）
          stale: () => this.#deps.isGroupTurnStale?.(payload) === true,
        },
      })
    }
    throw new KernelError(RunnerErrorCodes.RUN_KIND_UNKNOWN, `未知 run 种类：${run.kind}`)
  }

  async #runTurn(run: ActiveRun, input: TurnInput): Promise<{ text: string }> {
    const { agentId } = run
    // 入站消息在受理时已落 transcript（durable acceptance）；组装历史时剔除，避免同消息双计。
    // 会话键：群 turn 读群流（群历史），私聊 turn 读 agent 流
    const sessionKey = input.session?.groupId ?? agentId
    const history = toChatMessages(
      (await this.#deps.transcript.readAll(sessionKey)).filter(
        (record) => messageIdOf(record.payload) !== input.originMessageId,
      ),
      agentId,
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
      // 轮间中止检查点：工具已返回但 run 已被取消/抢占时立即终止——不再发起下一轮 llm
      // （exec 由后端 signal 杀进程；此检查点兜住审批等不感知 signal 的等待返回后的收尾）
      if (run.signal.aborted) {
        throw new KernelError(RunnerErrorCodes.RUN_ABORTED, `run 已中止（run ${run.runId}）`)
      }
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
      // 过程事实：本轮思考落 transcript（中间轮与终答轮都记、final 区分——终答文本在
      // thinking 与 agent 消息各存一份，一致性优先；toChatMessages 不映射此 kind，不进 llm 历史）
      await this.#deps.transcript.append(agentId, 'thinking', {
        runId: run.runId,
        round: chatRound,
        text: truncateForTranscript(response.text ?? '', MAX_THINKING_CHARS),
        final: response.toolCalls.length === 0,
      })
      if (response.toolCalls.length === 0) {
        const text = response.text ?? ''
        // 群轮转 [pass]：标准静默 token——不落群流不发事件（GroupService settle 判定缺席）
        if (input.session && text.trim() === GROUP_PASS_TOKEN) {
          return { text }
        }
        const messageId = this.#deps.nextMessageId()
        if (input.session) {
          // supersede（P5 Step 4 修复）：旧轮终答静默丢弃——不写群 transcript 不发事件
          // （turn 本身正常 finish；编排层 onSettled 同判兜底）
          if (input.session.stale?.()) return { text }
          // 群终答：写群流（kind=group-agent，成员身份在 from 字段）+ v1.group.message；
          // agent 私聊流零污染（群里说的话不出现在 1:1 会话）
          await this.#deps.transcript.append(input.session.groupId, 'group-agent', {
            messageId,
            from: agentId,
            text,
            replyTo: input.originMessageId,
            runId: run.runId,
          })
          input.session.emitFinal(messageId, text, run.runId)
        } else {
          await this.#deps.transcript.append(agentId, 'agent', {
            messageId,
            text,
            replyTo: input.originMessageId,
            runId: run.runId,
          })
          this.#deps.bus.emit('v1.message.agent', { messageId, agentId, text, runId: run.runId })
        }
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
        // 含图回喂（plan-computer-use Step 3）：content parts（text+image）给多模态模型；
        // 纯文本结果零变化（string 快路径）
        messages.push({
          role: 'tool',
          content:
            typeof result === 'string'
              ? result
              : [
                  { type: 'text' as const, text: result.text },
                  { type: 'image' as const, image: result.image },
                ],
          toolCallId: call.id,
        })
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

/** transcript 记录 → 会话历史（只映射领域消息；工具往返不入历史）。
 *  viewerId（P5 Step 3）：群流映射的视角成员——自己发言=assistant、他人发言=user 带前缀；私聊流不依赖 */
export function toChatMessages(records: { kind: string; payload: unknown }[], viewerId?: string): ChatMessage[] {  const messages: ChatMessage[] = []
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
    } else if (record.kind === 'group-user') {
      messages.push({ role: 'user', content: text })
    } else if (record.kind === 'group-agent') {
      const from = typeof payload['from'] === 'string' ? payload['from'] : '?'
      if (viewerId !== undefined && from === viewerId) {
        messages.push({ role: 'assistant', content: text })
      } else {
        messages.push({ role: 'user', content: `[群 ${from}] ${text}` })
      }
    }
    // group-sys：系统注记不入 llm 历史
  }
  return messages
}
