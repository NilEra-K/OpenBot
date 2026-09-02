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

/** 工具结果（plan-computer-use Step 3）：纯文本快路径；图像在场（computer 截图）时
 *  TurnRunner 组装 content parts 回喂多模态模型 */
export interface ToolResult {
  text: string
  image?: { base64: string; mime: string }
}

export interface Tool {
  spec: ToolSpec
  execute(ctx: ToolContext, args: unknown): Promise<string | ToolResult>
}

export class ToolRegistry {
  readonly #tools = new Map<string, Tool>()
  readonly #lastResults = new Map<string, ToolResult>()

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
  async execute(ctx: ToolContext, call: ToolCall): Promise<string | ToolResult> {
    const tool = this.#tools.get(call.name)
    if (!tool) {
      return `错误 ${ToolErrorCodes.TOOL_NOT_FOUND}: 未知工具 ${call.name}`
    }
    try {
      const result = await tool.execute(ctx, call.args)
      if (typeof result !== 'string') this.#lastResults.set(call.name, result)
      return result
    } catch (err) {
      const ke = err instanceof KernelError ? err : new KernelError('TOOL_FAILED', String(err))
      return `错误 ${ke.code}: ${ke.message}`
    }
  }

  /** 最近一次含图结果（GUI 旁观视图的帧源——agent 视角截图；plan-computer-use Step 6） */
  lastImageOf(toolName: string): { base64: string; mime: string } | undefined {
    return this.#lastResults.get(toolName)?.image
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

/** send_broadcast：向多个 agent 扇出广播（仅 steward——扇出权在内核 BroadcastService 校验兜底，
 *  worker 调用按 MSG_BROADCAST_FORBIDDEN 如实报错）。幂等键派生自 originMessageId+toolCallId */
export function sendBroadcastTool(broadcast: Pick<import('@openbot/messaging').BroadcastService, 'broadcast'>): Tool {
  return {
    spec: {
      name: 'send_broadcast',
      description: '向多个 agent 广播消息（扇出调度，仅管家可用；toAgentIds 传收件列表）',
    },
    async execute(ctx, args) {
      const record = asRecord(args)
      const toAgentIds = Array.isArray(record['toAgentIds']) ? record['toAgentIds'].map(String) : []
      const text = requireString(record, 'text')
      const acceptance = await broadcast.broadcast({
        from: ctx.agentId,
        toAgentIds,
        text,
        nonce: `${ctx.originMessageId}:${ctx.toolCallId}`,
      })
      return acceptance.first
        ? `已扇出 ${acceptance.recipients.length} 人（${acceptance.recipients.map((r) => r.agentId).join('、')}）`
        : '重复发送已忽略（原已受理）'
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

// ---- 记忆工具族（backlog ① Step 2）——进程自身状态，不过闸（记忆是 agent 自己的工作集，
//      不属「出 Box」概念面；save 的校验在 MemoryStore 侧） ----

export interface MemoryToolDeps {
  /** 每代理记忆存储（装配注入） */
  memory: Pick<import('@openbot/state').MemoryStore, 'append' | 'list'>
}

/** save_memory：agent 自存一条记忆（跨会话保留；会话装配时自动注入新会话） */
export function saveMemoryTool(deps: MemoryToolDeps): Tool {
  return {
    spec: {
      name: 'save_memory',
      description:
        '保存一条跨会话记忆（重要事实才存：每条一句自然语言，重复保存无害但不鼓励）。kind 三选一：事实/偏好/技能（缺省=事实）',
    },
    async execute(ctx, args) {
      const record = asRecord(args)
      const text = requireString(record, 'text')
      const kindRaw = typeof record['kind'] === 'string' ? record['kind'] : '事实'
      if (kindRaw !== '事实' && kindRaw !== '偏好' && kindRaw !== '技能') {
        throw new KernelError(ToolErrorCodes.TOOL_ARGS_INVALID, `参数 kind 必须是 事实/偏好/技能 之一（收到：${kindRaw}）`)
      }
      const entry = await deps.memory.append(ctx.agentId, text, kindRaw, ctx.originMessageId)
      return `已记住 [${entry.kind}] ${entry.text}`
    },
  }
}

/** recall_memory：回忆既有记忆（query 可选——子串过滤；新→旧序，上限 50 条） */
export function recallMemoryTool(deps: MemoryToolDeps): Tool {
  return {
    spec: {
      name: 'recall_memory',
      description: '回忆你此前保存的记忆（可带 query 过滤；无记忆时返回空提示）',
    },
    async execute(ctx, args) {
      const record = asRecord(args)
      const query = typeof record['query'] === 'string' ? record['query'] : undefined
      let entries = await deps.memory.list(ctx.agentId)
      if (query !== undefined && query !== '') {
        entries = entries.filter((e) => e.text.includes(query) || e.kind.includes(query))
      }
      if (entries.length === 0) {
        return query !== undefined ? `没有匹配「${query}」的记忆` : '还没有任何记忆'
      }
      const lines = entries
        .slice(-50)
        .reverse()
        .map((e) => `[${e.kind}] ${e.text}`)
      return `共 ${entries.length} 条（新→旧）：\n${lines.join('\n')}`
    },
  }
}

// ---- computer 工具族（plan-computer-use Step 4/5）——沙箱内 GUI 操作，CLI 即接口
//      （xdotool/scrot 全部经 boxes.exec，后端零改动）；与 exec 同级「Box 内自由」零审批面。
//      注册门在装配层（desktop）：GUI 模板在场 ∩ 主力 provider supportsImages——不满足不注册。

export interface GuiTakeoverLock {
  /**
   * 用户接管锁（plan-computer-use Step 5）：每个 computer 动作执行前等锁——用户接管中
   * （GUI 视图收到用户输入）挂起（形态同审批挂起）；「交还 agent」放行。desktop 装配注入
   * 实现；runner 只认这个最小接口（壳层内存态不进内核协议）。
   */
  waitTurn(): Promise<void>
}

export interface ComputerToolDeps extends BoxToolDeps {
  /** GUI 显示地址（exec 环境注入——WSLg 在场时 Xvfb 走 TCP 环回如 127.0.0.1:2；缺省 :0） */
  display?: string
  /** 接管锁（可选——CLI 冒烟不带）；动作工具执行前等待 */
  lock?: Pick<GuiTakeoverLock, 'waitTurn'>
  /** 截图实现注入（默认真跑 scrot；测试/mock 注入替身） */
  capture?: (boxId: string) => Promise<ToolResult['image']>
  /** 动作执行注入（默认真跑 xdotool；测试/mock 注入替身记 argv） */
  act?: (boxId: string, argv: string[]) => Promise<void>
  /** 等待 GUI 响应（动作后截图前的静置毫秒；测试注入 0） */
  settleMs?: number
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** 默认截图：scrot 全屏 → convert 缩放 1280 宽 jpg（token 纪律：jpg 比省一个量级） */
async function captureScreen(backend: BoxToolDeps['backend'], boxId: string): Promise<ToolResult['image']> {
  const shot = '/tmp/.openbot-shot.jpg'
  const r = await backend.exec(boxId, {
    command: [
      'sh', '-c',
      `scrot -o /tmp/.openbot-shot.png && convert /tmp/.openbot-shot.png -resize '1280x>' -quality 80 ${shot} && base64 -w0 ${shot}`,
    ],
    timeoutMs: 15_000,
    env: { DISPLAY: process.env.OPENBOT_GUI_DISPLAY ?? '127.0.0.1:2' },
  })
  if (r.exitCode !== 0) throw new KernelError('COMPUTER_CAPTURE_FAILED', `截图失败（exit ${r.exitCode}）：${r.stderr.trim()}`)
  const b64 = r.stdout.trim()
  if (b64 === '') throw new KernelError('COMPUTER_CAPTURE_FAILED', '截图输出为空（DISPLAY 未就绪或 scrot 不在场）')
  return { base64: b64, mime: 'image/jpeg' }
}

/** 默认动作：xdotool 经 sh -c（组合键等 shell 语义）；命令由本层构造（非用户输入拼 shell——
 *  type 文本经单引号转义） */
async function actXdotool(backend: BoxToolDeps['backend'], boxId: string, script: string): Promise<void> {
  const r = await backend.exec(boxId, { command: ['sh', '-c', script], timeoutMs: 10_000, env: { DISPLAY: process.env.OPENBOT_GUI_DISPLAY ?? '127.0.0.1:2' } })
  if (r.exitCode !== 0) throw new KernelError('COMPUTER_ACT_FAILED', `xdotool 失败（exit ${r.exitCode}）：${r.stderr.trim()}`)
}

/** sh 单引号转义（computer_type 的用户文本——' 变 '\''） */
function shQuote(s: string): string {
  const BS = String.fromCharCode(92) // 反斜杠（多层引号转义地狱的字面绕行）
  const esc = "'\\''" // ''\'''
  return `'${s.replaceAll("'", esc)}'`
}

/** computer_screenshot：看屏（初见/核实；坐标空间即截图分辨率——模型所见即可点） */
export function computerScreenshotTool(deps: ComputerToolDeps): Tool {
  return {
    spec: {
      name: 'computer_screenshot',
      description: '截取沙箱桌面全屏（返回图像）。坐标语义：截图分辨率即点击坐标系。初次看屏或核实状态时用。',
    },
    async execute(ctx) {
      const boxId = requireBox(ctx)
      const image = await (deps.capture?.(boxId) ?? captureScreen(deps.backend, boxId))
      return { text: '已截图（见图像）', image }
    },
  }
}

/** 动作工具工厂：等待接管锁 → xdotool 动作 → 静置 → 附动作后截图（裁定 D） */
function computerActionTool(
  deps: ComputerToolDeps,
  spec: ToolSpec,
  buildScript: (args: Record<string, unknown>) => string,
): Tool {
  return {
    spec,
    async execute(ctx, args) {
      const boxId = requireBox(ctx)
      const record = asRecord(args)
      // 接管锁（Step 5）：用户接管中挂起在此——「交还 agent」放行后继续
      await deps.lock?.waitTurn()
      const act = deps.act ?? ((id, argv) => actXdotool(deps.backend, id, argv.join(' ')))
      await act(boxId, [buildScript(record)])
      await sleep(deps.settleMs ?? 500)
      // 动作后截图附回喂（960 宽降一档——多轮循环 token 纪律）
      const image = await (deps.capture?.(boxId) ?? captureScreen(deps.backend, boxId))
      return { text: '动作已执行（见动作后截图）', image }
    },
  }
}

/** computer 工具族全套（装配层按注册门条件注册） */
export function computerTools(deps: ComputerToolDeps): Tool[] {
  const num = (v: unknown): number => {
    const n = typeof v === 'number' ? v : Number(v)
    if (!Number.isFinite(n)) throw new KernelError(ToolErrorCodes.TOOL_ARGS_INVALID, '坐标必须是数字')
    return Math.round(n)
  }
  return [
    computerScreenshotTool(deps),
    computerActionTool(deps, { name: 'computer_click', description: '点击沙箱桌面坐标 (x, y)——左键单击' }, (a) =>
      `xdotool mousemove ${num(a['x'])} ${num(a['y'])} click 1`,
    ),
    computerActionTool(deps, { name: 'computer_double_click', description: '双击坐标 (x, y)' }, (a) =>
      `xdotool mousemove ${num(a['x'])} ${num(a['y'])} click --repeat 2 --delay 150 1`,
    ),
    computerActionTool(deps, { name: 'computer_type', description: '在焦点元素键入文本（先 click 定位输入框）' }, (a) => {
      const text = requireText(a['text'])
      return `xdotool type --delay 30 -- ${shQuote(text)}`
    }),
    computerActionTool(deps, { name: 'computer_key', description: '按键或组合键（如 ctrl+a / Return / ctrl+w）' }, (a) => {
      const key = requireText(a['key']).trim()
      if (!/^[a-zA-Z0-9_+\-]+(\+[a-zA-Z0-9_+\-]+)*$/.test(key)) {
        throw new KernelError(ToolErrorCodes.TOOL_ARGS_INVALID, `key 只接受组合键语法（字母数字与 +，收到：${key}）`)
      }
      return `xdotool key ${key}`
    }),
    computerActionTool(deps, { name: 'computer_scroll', description: '滚动（dy 正=向下，负=向上；步长约 120/格）' }, (a) => {
      const dy = num(a['dy'])
      const btn = dy >= 0 ? 5 : 4
      const steps = Math.max(1, Math.min(Math.abs(dy) / 120, 20))
      return `xdotool click --repeat ${Math.round(steps)} --delay 60 ${btn}`
    }),
  ]
}

function requireText(v: unknown): string {
  if (typeof v !== 'string' || v === '') throw new KernelError(ToolErrorCodes.TOOL_ARGS_INVALID, '参数必须是非空字符串')
  return v
}
