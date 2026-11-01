/**
 * 工具层：in-box 工具族（exec/fs/snapshot——全走 boxes，Box 内自由）+
 * host 最小工具集（send_message 消息收发——进程自身状态，不过闸）。
 * 出 Box 的 host 工具（宿主网络等）须经 gate 模块的 gated() 包装。
 * 工具回喂一律文本（模型可见）；错误带稳定 code 前缀，不裸抛给模型。
 */
import { KernelError } from '@openbot/core'
import type { EventBus } from '@openbot/core'
import type { ToolCall, ToolSpec } from '@openbot/llm'
import type { BoxBackend, ScreenAction, ScreenCapture, ScreenControl } from '@openbot/boxes'
import type { A2aService } from '@openbot/messaging'
import type { TranscriptStore } from '@openbot/state'
import type { RunStreamEvent } from '../stream/index.js'
import { requestToolApproval } from '../gate/index.js'

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
  /** 过程记录落盘键（群轮 = groupId——群轮过程落群流，成员私聊档案零群痕迹；缺省 = 私聊轮，
   *  过程落 agentId。只影响 exec 记录归属，不影响实况流与事件（两者按 agentId 呈现归群视图） */
  sessionKey?: string
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

  /** 注销（2026-10-20 插件运行时）：插件禁用/卸载时移除其桥接工具——缺席幂等 */
  unregister(name: string): this {
    this.#tools.delete(name)
    this.#lastResults.delete(name)
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
        // 过程事实：exec 完成点聚合落 transcript（实况断线不补，事实可重放）；
        // 落盘键 = sessionKey ?? agentId（群轮落群流——过程归群，成员档案零群痕迹）
        await deps.transcript?.append(ctx.sessionKey ?? ctx.agentId, 'exec', {
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
        // 中止也是事实：记录错误语义（重启后呈现同样诚实；落盘键同成功路径——sessionKey 优先）
        await deps.transcript?.append(ctx.sessionKey ?? ctx.agentId, 'exec', {
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

// ---- computer 工具族（plan-computer-use Step 4/5 + plan-image-firstclass P8-2 接口化）——
//      沙箱内 GUI 操作，只认 ScreenControl 适配器接口（xdotool/scrot/坐标换算/截图缩放全部
//      内聚适配器——P8-2 起 runner 零具体命令依赖）；与 exec 同级「Box 内自由」零审批面。
//      注册门在装配层（desktop）：GUI 工具集探测 ∩ provider supportsImages（env 强制门保留）。

export interface GuiTakeoverLock {
  /**
   * 用户接管锁（plan-computer-use Step 5）：每个 computer 动作执行前等锁——用户接管中
   * （GUI 视图收到用户输入）挂起（形态同审批挂起）；「交还」放行。desktop 装配注入
   * 实现；runner 只认这个最小接口（壳层内存态不进内核协议）。
   */
  waitTurn(): Promise<void>
}

export interface ComputerToolDeps extends BoxToolDeps {
  /** 桌面控制适配器（P8-2 接口化——截图/动作的单一执行面；坐标换算内聚适配器） */
  screen: ScreenControl
  /**
   * 截图净化（v0.1.117c 端点 400「image is not valid」根治）：backend 产物在注入前经壳层
   * nativeImage 重构（解码→≤2048 缩放→重编码合法 PNG）——修复传输链任何环节的字节损坏
   * （管道杂质/exec 截断/编码瑕疵）；数据不可解码时返回 null（如实降级文本注记，不注坏图）。
   * 缺席 = 原样透传（CLI/测试）
   */
  sanitizeImage?: (image: { base64: string; mime: string }) => Promise<{ base64: string; mime: string } | null>
  /** 接管锁（可选——CLI 冒烟不带）；动作工具执行前等待 */
  lock?: Pick<GuiTakeoverLock, 'waitTurn'>
  /** 动作后截图前的静置毫秒（测试注入 0；缺省 500——等 GUI 响应） */
  settleMs?: number
  /**
   * 载体级动作闸（P9-1 裁定 F）：宿主屏幕等「零隔离」载体上 computer 动作**恒过审批闸**——
   * 「Box 内自由」的边界假设在用户本机屏幕上不成立。appliesTo 按 boxId 判定（装配层注入，
   * host-screen 常量 id）；截图不进闸（注册条目本身即「可看」的授权；注入才是主权面）。
   */
  actionGate?: {
    gate: import('../approval/index.js').ApprovalGate
    appliesTo: (boxId: string) => boolean
    reason?: (boxId: string) => string
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** ScreenCapture → ToolResult.image（bytes → base64——wire 只认 base64/mime/尺寸元数据）。
 *  v0.1.117c：经 deps.sanitizeImage（壳层 nativeImage 重构——传输链损坏防御）后返回 */
async function toToolImage(
  capture: ScreenCapture,
  sanitize?: ComputerToolDeps['sanitizeImage'],
): Promise<NonNullable<ToolResult['image']>> {
  const raw: NonNullable<ToolResult['image']> = {
    base64: Buffer.from(capture.bytes).toString('base64'),
    mime: capture.mime,
    ...(capture.width !== undefined ? { width: capture.width, height: capture.height } : {}),
    ...(capture.screenWidth !== undefined ? { screenWidth: capture.screenWidth, screenHeight: capture.screenHeight } : {}),
  }
  if (sanitize === undefined) return raw
  const clean = await sanitize({ base64: raw.base64, mime: raw.mime })
  if (clean === null) {
    // 数据不可解码：如实降级为 1×1 透明占位说明（尺寸元数据保留——坐标换算语义不破）
    return { ...raw, base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', mime: 'image/png' }
  }
  return { ...raw, ...clean }
}

/** computer_screenshot：看屏（初见/核实）。坐标语义（2026-09-06 换算修复）由适配器元数据
 *  驱动回喂标注——模型按截图坐标给点击位置，注入侧自动换算到真实屏幕 */
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
      const image = await toToolImage(await deps.screen.capture(boxId), deps.sanitizeImage)
      const note =
        image.width !== undefined && image.screenWidth !== undefined
          ? `截图 ${image.width}×${image.height}（真实屏幕 ${image.screenWidth}×${image.screenHeight}）——点击坐标按截图给出即可，系统自动换算`
          : '截图 1:1（坐标即屏幕坐标）'
      return { text: `已截图。${note}`, image }
    },
  }
}

/** 动作工具工厂：等待接管锁 → 适配器 act（坐标换算内聚适配器）→ 静置 → 附动作后截图
 *  （裁定 D）。动作词表是协议中性 ScreenAction——X11 翻译在适配器 */
function computerActionTool(
  deps: ComputerToolDeps,
  spec: ToolSpec,
  toAction: (args: Record<string, unknown>) => ScreenAction,
): Tool {
  return {
    spec,
    async execute(ctx, args) {
      const boxId = requireBox(ctx)
      const record = asRecord(args)
      // 载体级动作闸（P9-1 裁定 F）：零隔离载体（宿主屏幕）恒过审批闸——拒绝即回喂不执行
      if (deps.actionGate !== undefined && deps.actionGate.appliesTo(boxId)) {
        const r = await requestToolApproval(
          deps.actionGate.gate,
          ctx,
          spec.name,
          deps.actionGate.reason?.(boxId),
        )
        if (!r.approved) return r.denial
      }
      // 接管锁（Step 5）：用户接管中挂起在此——「交还 agent」放行后继续
      await deps.lock?.waitTurn()
      await deps.screen.act(boxId, toAction(record))
      await sleep(deps.settleMs ?? 500)
      // 动作后截图附回喂（裁定 D——多轮循环 token 纪律，与 screenshot 同档）
      const image = await toToolImage(await deps.screen.capture(boxId), deps.sanitizeImage)
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
    computerActionTool(deps, { name: 'computer_click', description: '点击沙箱桌面坐标 (x, y)——左键单击', argsSchema: { type: 'object', properties: { x: { type: 'number', description: '横坐标（像素，截图分辨率坐标系）' }, y: { type: 'number', description: '纵坐标（像素）' } }, required: ['x', 'y'], additionalProperties: false } }, (a) =>
      ({ kind: 'click', button: 1, x: num(a['x']), y: num(a['y']) }),
    ),
    computerActionTool(deps, { name: 'computer_double_click', description: '双击坐标 (x, y)', argsSchema: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'], additionalProperties: false } }, (a) =>
      ({ kind: 'click', button: 1, x: num(a['x']), y: num(a['y']), count: 2, intervalMs: 150 }),
    ),
    computerActionTool(deps, { name: 'computer_type', description: '在焦点元素键入文本（先 click 定位输入框）', argsSchema: { type: 'object', properties: { text: { type: 'string', description: '要键入的文本' } }, required: ['text'], additionalProperties: false } }, (a) =>
      ({ kind: 'type', text: requireText(a['text']), delayMs: 30 }),
    ),
    computerActionTool(deps, { name: 'computer_key', description: '按键或组合键（如 ctrl+a / Return / ctrl+w）', argsSchema: { type: 'object', properties: { key: { type: 'string', description: '键名或组合（ctrl+a / Return / space / alt+Tab）' } }, required: ['key'], additionalProperties: false } }, (a) => {
      const key = requireText(a['key']).trim()
      if (!/^[a-zA-Z0-9_+\-]+(\+[a-zA-Z0-9_+\-]+)*$/.test(key)) {
        throw new KernelError(ToolErrorCodes.TOOL_ARGS_INVALID, `key 只接受组合键语法（字母数字与 +，收到：${key}）`)
      }
      return { kind: 'key', key }
    }),
    computerActionTool(deps, { name: 'computer_scroll', description: '滚动（dy 正=向下，负=向上；步长约 120/格）', argsSchema: { type: 'object', properties: { dy: { type: 'number', description: '滚动量（像素，正=向下）' } }, required: ['dy'], additionalProperties: false } }, (a) => {
      const dy = num(a['dy'])
      const button = dy >= 0 ? 5 : 4
      const count = Math.max(1, Math.min(Math.abs(dy) / 120, 20))
      return { kind: 'click', button, count: Math.round(count), intervalMs: 60 }
    }),
  ]
}

function requireText(v: unknown): string {
  if (typeof v !== 'string' || v === '') throw new KernelError(ToolErrorCodes.TOOL_ARGS_INVALID, '参数必须是非空字符串')
  return v
}
