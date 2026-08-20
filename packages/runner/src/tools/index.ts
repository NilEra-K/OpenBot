/**
 * 工具层：in-box 工具族（exec/fs/snapshot——全走 boxes，Box 内自由）+
 * host 最小工具集（send_message 消息收发——进程自身状态，不过闸）。
 * 出 Box 的 host 工具（宿主网络等）须经 gate 模块的 gated() 包装。
 * 工具回喂一律文本（模型可见）；错误带稳定 code 前缀，不裸抛给模型。
 */
import { KernelError } from '@openbot/core'
import type { EventBus } from '@openbot/core'
import type { ToolCall, ToolSpec } from '@openbot/llm'
import type { BoxBackend } from '@openbot/boxes'
import type { A2aService } from '@openbot/messaging'
import type { TranscriptStore } from '@openbot/state'
import type { RunStreamEvent } from '../stream/index.js'

export const ToolErrorCodes = {
  TOOL_NOT_FOUND: 'TOOL_NOT_FOUND',
  TOOL_ARGS_INVALID: 'TOOL_ARGS_INVALID',
  TOOL_NO_BOX: 'TOOL_NO_BOX',
} as const

/** 过程文本持久上限（防 transcript 撑爆；截断加尾标——诚实标记不静默丢） */
export const MAX_THINKING_CHARS = 8_000
export const MAX_EXEC_OUTPUT_CHARS = 16_000

/** 持久截断：超长文本截断并加尾标（turn 与工具层共用） */
export function truncateForTranscript(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n[…超长已截断]`
}

/** 工具执行上下文：turn 引擎组装，工具不得越权取其他信息 */
export interface ToolContext {
  agentId: string
  runId: string
  /** 触发本 turn 的消息 id（闸门/发送幂等键的稳定来源：redrive 后不变） */
  originMessageId: string
  /** 当前工具调用 id */
  toolCallId: string
  /** 该 agent 绑定的 Box；null = 无沙箱，in-box 工具报 TOOL_NO_BOX */
  boxId: string | null
  signal: AbortSignal
}

export interface Tool {
  spec: ToolSpec
  execute(ctx: ToolContext, args: unknown): Promise<string>
}

export class ToolRegistry {
  readonly #tools = new Map<string, Tool>()

  register(tool: Tool): this {
    this.#tools.set(tool.spec.name, tool)
    return this
  }

  specs(): ToolSpec[] {
    return [...this.#tools.values()].map((t) => ({ ...t.spec }))
  }

  has(name: string): boolean {
    return this.#tools.has(name)
  }

  /** 统一入口：未知工具与执行错误都转成回喂文本（模型可见），不让 turn 崩 */
  async execute(ctx: ToolContext, call: ToolCall): Promise<string> {
    const tool = this.#tools.get(call.name)
    if (!tool) {
      return `错误 ${ToolErrorCodes.TOOL_NOT_FOUND}: 未知工具 ${call.name}`
    }
    try {
      return await tool.execute(ctx, call.args)
    } catch (err) {
      const ke = err instanceof KernelError ? err : new KernelError('TOOL_FAILED', String(err))
      return `错误 ${ke.code}: ${ke.message}`
    }
  }
}

// ---- 参数解析小工具（宽松校验，出错给模型可读反馈） ----

function asRecord(args: unknown): Record<string, unknown> {
  return typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {}
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  if (typeof value !== 'string') {
    throw new KernelError(ToolErrorCodes.TOOL_ARGS_INVALID, `参数 ${key} 必须是字符串`)
  }
  return value
}

function requireBox(ctx: ToolContext): string {
  if (ctx.boxId === null) {
    throw new KernelError(ToolErrorCodes.TOOL_NO_BOX, '本 agent 未绑定 Box')
  }
  return ctx.boxId
}

// ---- in-box 工具族 ----

export interface BoxToolDeps {
  backend: BoxBackend
  bus: EventBus
  /** run 实况上报（装配注入，与 TurnRunner 的 onStream 同型汇流——经 WS /stream，不进事件总线） */
  onStream?: (event: RunStreamEvent) => void
  /** 过程事实持久（可选注入——exec 完成点聚合落 transcript，重启后对话流可恢复） */
  transcript?: TranscriptStore
}

/** exec：Box 内执行命令（Box 内自由，不过闸）。输出增量经 onStream 实况上报（stdout/stderr 通道） */
export function execTool(deps: BoxToolDeps): Tool {
  return {
    spec: { name: 'exec', description: '在沙箱 Box 内执行命令（安全，无需审批）' },
    async execute(ctx, args) {
      const record = asRecord(args)
      const command = record['command']
      if (!Array.isArray(command) || command.length === 0 || !command.every((c) => typeof c === 'string')) {
        throw new KernelError(ToolErrorCodes.TOOL_ARGS_INVALID, '参数 command 必须是非空字符串数组')
      }
      const boxId = requireBox(ctx)
      const cwd = typeof record['cwd'] === 'string' ? record['cwd'] : undefined
      const emit = deps.onStream
      emit?.({
        type: 'open',
        agentId: ctx.agentId,
        runId: ctx.runId,
        stream: 'exec',
        meta: { command, ...(boxId !== null ? { boxId } : {}) },
      })
      deps.bus.emit('v1.box.exec', { boxId, runId: ctx.runId, phase: 'started', command })
      try {
        const result = await deps.backend.exec(boxId, {
          command,
          cwd,
          timeoutMs: 30_000,
          // run 取消/抢占传导：中止即杀 Box 内命令（用户打断工作中的 agent 的信号终点）
          signal: ctx.signal,
          ...(emit
            ? {
                onChunk: (c) =>
                  emit({ type: 'chunk', agentId: ctx.agentId, runId: ctx.runId, stream: 'exec', text: c.text, channel: c.stream }),
              }
            : {}),
        })
        deps.bus.emit('v1.box.exec', {
          boxId,
          runId: ctx.runId,
          phase: 'finished',
          command,
          exitCode: result.exitCode,
        })
        emit?.({ type: 'end', agentId: ctx.agentId, runId: ctx.runId, stream: 'exec', exitCode: result.exitCode })
        // 过程事实：exec 完成点聚合落 transcript（实况断线不补，事实可重放）
        await deps.transcript?.append(ctx.agentId, 'exec', {
          runId: ctx.runId,
          boxId,
          command,
          exitCode: result.exitCode,
          stdout: truncateForTranscript(result.stdout, MAX_EXEC_OUTPUT_CHARS),
          stderr: truncateForTranscript(result.stderr, MAX_EXEC_OUTPUT_CHARS),
        })
        return [`exit=${result.exitCode}`, result.stdout, result.stderr].filter((s) => s !== '').join('\n')
      } catch (err) {
        emit?.({
          type: 'abort',
          agentId: ctx.agentId,
          runId: ctx.runId,
          stream: 'exec',
          reason: err instanceof Error ? err.message : String(err),
        })
        // 中止也是事实：记录错误语义（重启后呈现同样诚实）
        await deps.transcript?.append(ctx.agentId, 'exec', {
          runId: ctx.runId,
          boxId,
          command,
          aborted: true,
          reason: err instanceof Error ? err.message : String(err),
        })
        throw err
      }
    },
  }
}

/** fs_write：Box 内写文件 */
export function fsWriteTool(deps: BoxToolDeps): Tool {
  return {
    spec: { name: 'fs_write', description: '在沙箱 Box 内写文件（安全，无需审批）' },
    async execute(ctx, args) {
      const record = asRecord(args)
      const path = requireString(record, 'path')
      const content = requireString(record, 'content')
      const boxId = requireBox(ctx)
      await deps.backend.fsWrite(boxId, path, content)
      return `已写入 ${path}（${content.length} 字符）`
    },
  }
}

/** fs_read：Box 内读文件 */
export function fsReadTool(deps: BoxToolDeps): Tool {
  return {
    spec: { name: 'fs_read', description: '在沙箱 Box 内读文件（安全，无需审批）' },
    async execute(ctx, args) {
      const record = asRecord(args)
      const path = requireString(record, 'path')
      const boxId = requireBox(ctx)
      const content = await deps.backend.fsRead(boxId, path)
      if (content === null) return `文件不存在：${path}`
      return content
    },
  }
}

// ---- host 最小工具集（进程自身状态，不过闸） ----

/** send_message：给其他 agent 发 A2A 私聊（priority 可选）。幂等键派生自 originMessageId+toolCallId */
export function sendMessageTool(messaging: A2aService): Tool {
  return {
    spec: { name: 'send_message', description: '给另一个 agent 发私聊消息（可设 priority 抢占对方非用户工作）' },
    async execute(ctx, args) {
      const record = asRecord(args)
      const toAgentId = requireString(record, 'toAgentId')
      const text = requireString(record, 'text')
      const priority = record['priority'] === true
      const acceptance = await messaging.sendA2a({
        fromAgentId: ctx.agentId,
        toAgentId,
        text,
        priority,
        nonce: `${ctx.originMessageId}:${ctx.toolCallId}`,
      })
      return acceptance.first
        ? `已送达 ${toAgentId}（消息 ${acceptance.messageId}，run ${acceptance.runId}）`
        : `重复发送已忽略（消息 ${acceptance.messageId} 原已受理）`
    },
  }
}

/** host_fetch：宿主网络访问桩——出 Box 操作，必须过闸（gated 包装后注册） */
export function hostFetchTool(): Tool {
  return {
    spec: { name: 'host_fetch', description: '从宿主机访问网络（需要用户审批）' },
    async execute(_ctx, args) {
      const record = asRecord(args)
      const url = requireString(record, 'url')
      // P1 桩：审批机制的真实演示位；真实实现随 P2/P3 接入
      return `宿主网络桩：已获批准访问 ${url}（P1 返回模拟内容）`
    },
  }
}
