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
  image?: {
    base64: string
    mime: string
    /** 截图坐标空间（缩放后尺寸）——computer 坐标换算的「模型侧」依据；缺席=未缩放（比例 1） */
    width?: number
    height?: number
    /** 真实屏幕尺寸——换算的「注入侧」目标空间 */
    screenWidth?: number
    screenHeight?: number
  }
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

/** exec：Box 内执行命令（Box 内自由，不过闸）。输出增量经 onStream 实况上报（stdout/stderr 通道）。
 *  argsSchema（v0.1.14，与 v0.1.8 computer_* 同族修法）：argv 结构进 wire——弱模型把自然语言
 *  当 command 传（「用命令行打开新终端」）反复错撞穿工具轮预算 → watchdog zombie 逃逸（用户
 *  实测报障）。schema + 自纠化错误反馈双管齐下 */
export function execTool(deps: BoxToolDeps): Tool {
  return {
    spec: {
      name: 'exec',
      // 工具选择指引（2026-09-05 用户问「模型怎么知道走终端还是 GUI」）：工具描述是模型
      // 每轮都看的信号源——两族互指，不污染全局提示词；computer 不在场时这些字不占上下文
      description:
        '在沙箱 Box 内执行命令（安全，无需审批）。命令行能完成的操作（跑命令/装包/读写文件/git）' +
        '优先用本工具——快且稳；必须看画面或点图形界面的操作才用 computer_* 族（如浏览器登录、GUI 应用）',
      argsSchema: {
        type: 'object',
        properties: {
          command: {
            type: 'array',
            items: { type: 'string' },
            description:
              'argv 数组：程序名在前、参数在后，每项一个词。例 ["ls","-la","/work"]、["xdotool","key","Return"]。' +
              '不收自然语言句子（「打开终端」✗）；管道/重定向等 shell 语法用 ["sh","-c","cat a | grep b"] 包裹；' +
              '多条命令拆成多次调用',
          },
          cwd: { type: 'string', description: '工作目录（可选，缺省 /work）' },
        },
        required: ['command'],
        additionalProperties: false,
      },
    },
    async execute(ctx, args) {
      const record = asRecord(args)
      const command = record['command']
      if (!Array.isArray(command) || command.length === 0 || !command.every((c) => typeof c === 'string')) {
        // 自纠化反馈（对齐 save_memory 的「收到：xxx」先例）：回显实际传入 + 正确示例 + sh -c 指路
        // ——模型一轮自纠，不再盲猜重试（重试烧工具轮预算，撞穿即 RUN_TOOL_BUDGET_EXCEEDED）
        const received = JSON.stringify(command ?? record['command'] ?? args)?.slice(0, 200) ?? '（无）'
        throw new KernelError(
          ToolErrorCodes.TOOL_ARGS_INVALID,
          `参数 command 必须是非空字符串数组（argv 形如 ["ls","-la","/work"]；收到：${received}）。` +
            `若是整串 shell 命令请改传 ["sh","-c","<原命令>"]；若是意图描述请先想出具体命令再调用`,
        )
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
    spec: {
      name: 'fs_write',
      description: '在沙箱 Box 内写文件（安全，无需审批）',
      argsSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '绝对路径，如 /work/main.py' },
          content: { type: 'string', description: '完整文件内容（整文件覆盖写）' },
        },
        required: ['path', 'content'],
        additionalProperties: false,
      },
    },
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
    spec: {
      name: 'fs_read',
      description: '在沙箱 Box 内读文件（安全，无需审批）',
      argsSchema: {
        type: 'object',
        properties: { path: { type: 'string', description: '绝对路径，如 /work/main.py' } },
        required: ['path'],
        additionalProperties: false,
      },
    },
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
    spec: {
      name: 'send_message',
      description: '给另一个 agent 发私聊消息（可设 priority 抢占对方非用户工作）',
      argsSchema: {
        type: 'object',
        properties: {
          toAgentId: { type: 'string', description: '收件 agent id（名册中的 id，如 worker1）' },
          text: { type: 'string', description: '消息正文（完整一句委托或答复）' },
          priority: { type: 'boolean', description: '抢占对方当前非用户工作（可选，缺省 false）' },
        },
        required: ['toAgentId', 'text'],
        additionalProperties: false,
      },
    },
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
      argsSchema: {
        type: 'object',
        properties: {
          toAgentIds: {
            type: 'array',
            items: { type: 'string' },
            description: '收件 agent id 列表，如 ["worker1","worker2"]',
          },
          text: { type: 'string', description: '广播正文' },
        },
        required: ['toAgentIds', 'text'],
        additionalProperties: false,
      },
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
    spec: {
      name: 'host_fetch',
      description: '从宿主机访问网络（需要用户审批）',
      argsSchema: {
        type: 'object',
        properties: { url: { type: 'string', description: '完整 URL，含协议（https://…）' } },
        required: ['url'],
        additionalProperties: false,
      },
    },
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
      argsSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '记忆正文（一句话）' },
          kind: { type: 'string', enum: ['事实', '偏好', '技能'], description: '记忆类型（可选，缺省=事实）' },
        },
        required: ['text'],
        additionalProperties: false,
      },
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
      argsSchema: {
        type: 'object',
        properties: { query: { type: 'string', description: '子串过滤（可选，缺省返回全部）' } },
        additionalProperties: false,
      },
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

/** 屏幕几何缓存（per boxId——桌面尺寸会话内不变；2026-09-06 坐标换算引入） */
const screenGeoCache = new Map<string, { width: number; height: number }>()

const guiDisplay = (): string => process.env.OPENBOT_GUI_DISPLAY ?? '127.0.0.1:2'

/** 查询 Box 桌面屏幕几何（xdotool getdisplaygeometry → "W H"）；失败 null（如实，换算跳过） */
async function screenGeometryOf(backend: BoxToolDeps['backend'], boxId: string): Promise<{ width: number; height: number } | null> {
  const hit = screenGeoCache.get(boxId)
  if (hit) return hit
  try {
    const r = await backend.exec(boxId, { command: ['xdotool', 'getdisplaygeometry'], timeoutMs: 5_000, env: { DISPLAY: guiDisplay() } })
    if (r.exitCode !== 0) return null
    const m = /^(\d+)\s+(\d+)$/.exec(r.stdout.trim())
    if (m === null) return null
    const width = Number(m[1])
    const height = Number(m[2])
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 16 || height < 16) return null
    const geo = { width, height }
    screenGeoCache.set(boxId, geo)
    return geo
  } catch {
    return null
  }
}

/** 坐标换算比（v0.1.17 根治「视觉模型点不准」）：截图缩到 1280 宽（token 纪律）而屏幕是
 *  1080p——模型按它看到的 1280×720 图报坐标，注入必须乘 屏幕/截图 比例（1920/1280=1.5），
 *  否则系统性偏左上 1/3（v0.1.10 屏幕升 1080p 后隐含「截图=屏幕坐标同源」假设破裂，用户实测
 *  「总是无法正确点击位置」的根因）。屏幕宽 ≤1280 时不缩放（比例 1，一期行为）；
 *  几何查不到（DISPLAY 未就绪等）null——降级不换算（同现状，不更糟） */
async function coordScaleOf(backend: BoxToolDeps['backend'], boxId: string): Promise<number | null> {
  const geo = await screenGeometryOf(backend, boxId)
  if (geo === null || geo.width <= 1280) return null
  return geo.width / 1280
}

/** 默认截图：scrot 全屏 → convert 缩 1280 宽 jpg（token 纪律）；返回截图坐标空间与屏幕
 *  真实尺寸（回喂文本标注坐标系语义——模型知道自己工作在缩放坐标系） */
async function captureScreen(backend: BoxToolDeps['backend'], boxId: string): Promise<NonNullable<ToolResult['image']>> {
  // 唯一临时文件（2026-09-06 用户报障 convert IDAT CRC error——固定文件名下并发 scrot 覆盖
  // 正在读的文件 → 半写 PNG；$$ = sh 进程 pid 每次 exec 天然隔离，用后清理）
  const geo = await screenGeometryOf(backend, boxId).catch(() => null)
  const r = await backend.exec(boxId, {
    command: [
      'sh', '-c',
      `f=/tmp/.openbot-shot-$$.png; g=/tmp/.openbot-shot-$$.jpg; ` +
        `scrot -o "$f" && convert "$f" -resize '1280x>' -quality 80 "$g" && base64 -w0 "$g"; rm -f "$f" "$g"`,
    ],
    timeoutMs: 15_000,
    env: { DISPLAY: guiDisplay() },
  })
  if (r.exitCode !== 0) throw new KernelError('COMPUTER_CAPTURE_FAILED', `截图失败（exit ${r.exitCode}）：${r.stderr.trim()}`)
  const b64 = r.stdout.trim()
  if (b64 === '') throw new KernelError('COMPUTER_CAPTURE_FAILED', '截图输出为空（DISPLAY 未就绪或 scrot 不在场）')
  if (geo === null || geo.width <= 1280) return { base64: b64, mime: 'image/jpeg' }
  // '1280x>' 缩放规则：仅宽 >1280 时缩，纵横比保持——缩后尺寸纯计算（零额外 exec）
  const width = 1280
  const height = Math.round((geo.height * width) / geo.width)
  return { base64: b64, mime: 'image/jpeg', width, height, screenWidth: geo.width, screenHeight: geo.height }
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

/** computer_screenshot：看屏（初见/核实）。坐标语义（2026-09-06 换算修复）：截图缩到 1280 宽时
 *  回喂文本标注两端尺寸——模型按截图坐标给点击位置，注入侧自动换算到真实屏幕 */
export function computerScreenshotTool(deps: ComputerToolDeps): Tool {
  return {
    spec: {
      name: 'computer_screenshot',
      // 选择指引 + 接管指引（plan Step 4 的「认证/登录场景请用户接管」在此落地）：
      // 命令行优先的反向指引 + 登录/认证类主动引导用户去 GUI 视图接管（不瞎点密码框）
      description:
        '截取沙箱桌面全屏（返回图像）。坐标语义：按**截图分辨率**给出点击坐标（回喂文本会标注是否缩放，系统自动换算到真实屏幕）。初次看屏或核实状态时用。' +
        '命令行可完成的操作优先用 exec 工具——本族留给必须看画面/点界面的场景；' +
        '遇到登录/认证/验证码页面，回复引导用户在 GUI 视图接管手动完成，不要代输凭据',
      argsSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    async execute(ctx) {
      const boxId = requireBox(ctx)
      const image = (await (deps.capture?.(boxId) ?? captureScreen(deps.backend, boxId)))!
      const note =
        image.width !== undefined && image.screenWidth !== undefined
          ? `截图 ${image.width}×${image.height}（真实屏幕 ${image.screenWidth}×${image.screenHeight}）——点击坐标按截图给出即可，系统自动换算`
          : '截图 1:1（坐标即屏幕坐标）'
      return { text: `已截图。${note}`, image }
    },
  }
}

/** 动作工具工厂：等待接管锁 → xdotool 动作（坐标类按 scale 换算到真实屏幕）→ 静置 →
 *  附动作后截图（裁定 D）。buildScript 第二参 = 坐标换算比（null=不缩放或几何查询失败降级）
 *  ——只坐标类动作消费它（type/key/scroll 无坐标语义） */
function computerActionTool(
  deps: ComputerToolDeps,
  spec: ToolSpec,
  buildScript: (args: Record<string, unknown>, scale: number | null) => string,
): Tool {
  return {
    spec,
    async execute(ctx, args) {
      const boxId = requireBox(ctx)
      const record = asRecord(args)
      // 接管锁（Step 5）：用户接管中挂起在此——「交还 agent」放行后继续
      await deps.lock?.waitTurn()
      // 坐标换算（2026-09-06）：截图 1280 宽 / 屏幕 1080p 的 1.5 倍映射在此落地
      const scale = await coordScaleOf(deps.backend, boxId)
      const act = deps.act ?? ((id, argv) => actXdotool(deps.backend, id, argv.join(' ')))
      await act(boxId, [buildScript(record, scale)])
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
    computerActionTool(deps, { name: 'computer_click', description: '点击沙箱桌面坐标 (x, y)——左键单击', argsSchema: { type: 'object', properties: { x: { type: 'number', description: '横坐标（像素，截图分辨率坐标系）' }, y: { type: 'number', description: '纵坐标（像素）' } }, required: ['x', 'y'], additionalProperties: false } }, (a, scale) =>
      `xdotool mousemove ${Math.round(num(a['x']) * (scale ?? 1))} ${Math.round(num(a['y']) * (scale ?? 1))} click 1`,
    ),
    computerActionTool(deps, { name: 'computer_double_click', description: '双击坐标 (x, y)', argsSchema: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'], additionalProperties: false } }, (a, scale) =>
      `xdotool mousemove ${Math.round(num(a['x']) * (scale ?? 1))} ${Math.round(num(a['y']) * (scale ?? 1))} click --repeat 2 --delay 150 1`,
    ),
    computerActionTool(deps, { name: 'computer_type', description: '在焦点元素键入文本（先 click 定位输入框）', argsSchema: { type: 'object', properties: { text: { type: 'string', description: '要键入的文本' } }, required: ['text'], additionalProperties: false } }, (a) => {
      const text = requireText(a['text'])
      return `xdotool type --delay 30 -- ${shQuote(text)}`
    }),
    computerActionTool(deps, { name: 'computer_key', description: '按键或组合键（如 ctrl+a / Return / ctrl+w）', argsSchema: { type: 'object', properties: { key: { type: 'string', description: '键名或组合（ctrl+a / Return / space / alt+Tab）' } }, required: ['key'], additionalProperties: false } }, (a) => {
      const key = requireText(a['key']).trim()
      if (!/^[a-zA-Z0-9_+\-]+(\+[a-zA-Z0-9_+\-]+)*$/.test(key)) {
        throw new KernelError(ToolErrorCodes.TOOL_ARGS_INVALID, `key 只接受组合键语法（字母数字与 +，收到：${key}）`)
      }
      return `xdotool key ${key}`
    }),
    computerActionTool(deps, { name: 'computer_scroll', description: '滚动（dy 正=向下，负=向上；步长约 120/格）', argsSchema: { type: 'object', properties: { dy: { type: 'number', description: '滚动量（像素，正=向下）' } }, required: ['dy'], additionalProperties: false } }, (a) => {
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
