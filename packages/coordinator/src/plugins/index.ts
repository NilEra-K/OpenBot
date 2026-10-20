/**
 * 插件运行时服务（docs/plan-plugins.md · ARCHITECTURE.md §3.9）：
 * manifest 加载校验 + 进程生命周期（懒启动/事件源常驻/崩溃限次重启）+ MCP 工具桥接
 * （注册进 ToolRegistry，全部过审批闸门）+ 上行事件路由（用户通知 / 唤醒绑定 Agent——
 * 复用 messaging.sendUserMessage + 幂等 nonce，事件风暴不双驱）。
 * 红线：插件对 transcript 只读、不绕闸门、不发 UI 指令、不提权。
 */
import { KernelError } from '@openbot/core'
import type { EventBus } from '@openbot/core'
import type { ToolRegistry } from '@openbot/runner'
import type { ApprovalGate } from '@openbot/runner'
import { gated } from '@openbot/runner'
import { z } from 'zod'
import { McpClient } from './mcp-client.js'

export const PluginErrorCodes = {
  PLUGIN_NOT_INSTALLED: 'PLUGIN_NOT_INSTALLED',
  /** manifest 非法（schema 校验失败）——安装/启用时显式拒绝 */
  PLUGIN_MANIFEST_INVALID: 'PLUGIN_MANIFEST_INVALID',
  /** 插件进程故障（崩溃超限）——如实呈现，禁用后可重试 */
  PLUGIN_FAULTED: 'PLUGIN_FAULTED',
} as const

/** manifest 声明面（docs/plan-plugins.md §3——OpenBot 特有的一切；工具面归 MCP） */
export const manifestSchema = z.object({
  manifestVersion: z.literal(1),
  id: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,62}$/i, 'id：字母数字开头，可含点/连字符'),
  name: z.string().trim().min(1).max(24),
  version: z.string().trim().min(1).max(16),
  description: z.string().trim().max(200).default(''),
  entry: z.object({ command: z.string().min(1), args: z.array(z.string()).default([]) }),
  permissions: z.array(z.enum(['net', 'fs.host', 'screen.read', 'box'])).default([]),
  /** 事件源声明：非空 = 启用即常驻（推模型依赖进程在场） */
  events: z.array(z.object({ type: z.string().min(1).max(48) })).default([]),
  /** hooks（P2② 2026-10-20）：订阅内核事件（白名单）——经 openbot/hook 下行给插件进程 */
  hooks: z.array(z.object({ event: z.string().min(1).max(48) })).default([]),
  /** 事件唤醒的绑定 Agent（显示名；缺席 = 只通知用户） */
  agents: z.array(z.string().trim().min(1).max(24)).default([]),
})

export type PluginManifest = z.infer<typeof manifestSchema>

/** 插件运行态（v1.plugins.installed 的运行时投影） */
export interface PluginRuntimeState {
  /** stopped（已禁用/未启动）| running | faulted（崩溃超限） */
  state: 'stopped' | 'running' | 'faulted'
  /** 本内核会话内的崩溃次数（限次判据） */
  crashes: number
  faultReason?: string
}

interface PluginHandle {
  manifest: PluginManifest
  dir: string
  client: McpClient | null
  runtime: PluginRuntimeState
  /** 工具注册的注册名前缀（id 尾段——LLM 可读且合规 [a-zA-Z0-9_-]） */
  toolPrefix: string
  /** 已注册进 ToolRegistry 的桥接工具名（禁用时注销——进程回收不注销，懒拉起复用） */
  registeredToolNames: string[]
  /** 事件序号（幂等 nonce 组成） */
  eventSeq: number
  lastUsedAt: number
}

export interface PluginServiceDeps {
  bus: EventBus
  /** 工具注册表（MCP 工具桥接目标） */
  tools: ToolRegistry
  /** 审批闸门——插件工具全量过闸（第三方代码默认不信任） */
  gate: ApprovalGate
  /** 唤醒绑定 Agent 的既有消息通道（幂等 nonce 复用——automation 同款范式） */
  sendUserMessage: (input: { toAgentId: string; text: string; nonce: string }) => Promise<unknown>
  /** 显示名 → agentId 解析（agentMeta 名单——事件唤醒绑定） */
  agentIdOfName: (name: string) => string | undefined
  /** manifest JSON 读取（fs 抽象注入——测试可换内存桩） */
  readManifest: (pluginId: string) => Promise<string | null>
  /** 插件目录绝对路径（spawn 工作目录——entry 命令相对插件目录解析） */
  pluginDirOf: (pluginId: string) => string
  /** 空闲回收判定钟 */
  now: () => number
  /** 诊断留痕 */
  log: (msg: string) => void
}

/** 崩溃重启上限（每小时窗内的滑动计数——超过标记 faulted，禁用后可重试） */
const MAX_CRASHES = 3
/** 纯工具插件的空闲回收阈值（事件源/hooks 插件常驻不回收） */
const IDLE_RECYCLE_MS = 5 * 60_000

/** hooks 事件白名单（P2②）：只下行领域事实；新事件在此追加（协议纯度——不透传任意总线事件） */
const PLUGIN_HOOK_EVENTS = new Set(['v1.message.agent', 'v1.lifecycle.finished'])

export class PluginService {
  readonly #deps: PluginServiceDeps
  readonly #handles = new Map<string, PluginHandle>()
  #recycleTimer: NodeJS.Timeout | null = null

  constructor(deps: PluginServiceDeps) {
    this.#deps = deps
    // P2② hooks：白名单事件 → 声明匹配的常驻插件下行（进程在场的才发——未启动的等常驻语义拉起）
    deps.bus.on('*', (event) => {
      if (!PLUGIN_HOOK_EVENTS.has(event.type as string)) return
      for (const handle of this.#handles.values()) {
        if (handle.client === null || !handle.client.running) continue
        if (!handle.manifest.hooks.some((h) => h.event === event.type)) continue
        handle.client.notify('openbot/hook', { event: event.type, payload: event.payload })
      }
    })
  }

  /** 常驻判据：事件源（推模型）或 hooks（下行接收）——启用即拉起、不空闲回收、崩溃自动重启 */
  #resident(handle: PluginHandle): boolean {
    return handle.manifest.events.length > 0 || handle.manifest.hooks.length > 0
  }

  /** 装载已启用插件（boot）——manifest 校验失败如实跳过并留痕（不炸启动） */
  async loadInstalled(installed: Array<{ id: string; enabled: boolean }>): Promise<void> {
    for (const entry of installed) {
      if (!entry.enabled) continue
      await this.#load(entry.id).catch((err) => {
        this.#deps.log(`插件装载失败（${entry.id}）：${err instanceof Error ? err.message : String(err)}`)
      })
    }
    if (this.#handles.size > 0) this.#startRecycler()
  }

  /** 启用：装载 manifest → 事件源即拉起进程；纯工具插件懒启动（首调拉起） */
  async enable(pluginId: string): Promise<void> {
    let handle = this.#handles.get(pluginId)
    if (handle === undefined) handle = await this.#load(pluginId)
    handle.runtime = { state: 'stopped', crashes: 0 }
    if (this.#resident(handle)) await this.#ensureProcess(handle)
    this.#startRecycler()
  }

  /** 禁用：停进程 + 注销工具（台账归命令面维护——服务只管运行时） */
  async disable(pluginId: string): Promise<void> {
    const handle = this.#handles.get(pluginId)
    if (handle === undefined) return
    this.#unregisterTools(handle)
    handle.runtime = { state: 'stopped', crashes: handle.runtime.crashes }
    await handle.client?.stop()
    handle.client = null
  }

  /** 卸载清理（目录删除归命令面——服务只停运行时） */
  async shutdown(): Promise<void> {
    this.#recycleTimer && clearInterval(this.#recycleTimer)
    this.#recycleTimer = null
    for (const handle of this.#handles.values()) {
      this.#unregisterTools(handle)
      await handle.client?.stop()
      handle.client = null
      handle.runtime = { state: 'stopped', crashes: handle.runtime.crashes }
    }
  }

  /** 运行态投影（v1.plugins.installed 合并呈现） */
  states(): Array<{ id: string; state: PluginRuntimeState['state']; crashes: number; faultReason?: string }> {
    return [...this.#handles.values()].map((h) => ({
      id: h.manifest.id,
      state: h.runtime.state,
      crashes: h.runtime.crashes,
      ...(h.runtime.faultReason !== undefined ? { faultReason: h.runtime.faultReason } : {}),
    }))
  }

  async #load(pluginId: string): Promise<PluginHandle> {
    const raw = await this.#deps.readManifest(pluginId)
    if (raw === null) {
      throw new KernelError(PluginErrorCodes.PLUGIN_NOT_INSTALLED, `插件未安装（manifest 缺席）：${pluginId}`)
    }
    let manifest: PluginManifest
    try {
      manifest = manifestSchema.parse(JSON.parse(raw))
    } catch (err) {
      throw new KernelError(PluginErrorCodes.PLUGIN_MANIFEST_INVALID, `manifest 非法（${pluginId}）：${String(err)}`)
    }
    if (manifest.id !== pluginId) {
      throw new KernelError(PluginErrorCodes.PLUGIN_MANIFEST_INVALID, `manifest.id（${manifest.id}）与目录名（${pluginId}）不一致`)
    }
    const handle: PluginHandle = {
      manifest,
      dir: pluginId,
      client: null,
      runtime: { state: 'stopped', crashes: 0 },
      toolPrefix: toolPrefixOf(manifest.id),
      registeredToolNames: [],
      eventSeq: 0,
      lastUsedAt: 0,
    }
    this.#handles.set(pluginId, handle)
    return handle
  }

  /** 进程在场保证（懒启动/常驻共用）：握手 → tools/list → 注册桥接工具 */
  async #ensureProcess(handle: PluginHandle): Promise<McpClient> {
    if (handle.client !== null && handle.client.running) return handle.client
    if (handle.runtime.state === 'faulted') {
      throw new KernelError(PluginErrorCodes.PLUGIN_FAULTED, `插件故障（崩溃超限）：${handle.manifest.name}`)
    }
    const svcCall = this.#callPluginTool
    const client = new McpClient({
      command: handle.manifest.entry.command,
      args: handle.manifest.entry.args,
      cwd: this.#deps.pluginDirOf(handle.manifest.id),
      onEvent: (ev) => this.#routeEvent(handle, ev),
      onExit: (code) => this.#onCrash(handle, code),
      onStderr: (line) => this.#deps.log(`[plugin:${handle.manifest.id}] ${line}`),
    })
    await client.start()
    handle.client = client
    handle.runtime = { state: 'running', crashes: handle.runtime.crashes }
    handle.lastUsedAt = this.#deps.now()
    // 工具桥接：MCP tools → ToolRegistry（gated 包装——全部过审批闸门）。execute 经
    // #callPluginTool 懒拉起（进程被回收/未启动时重启握手，工具注册长期有效）
    const mcpTools = await client.listTools()
    for (const t of mcpTools) {
      const name = `${handle.toolPrefix}_${t.name}`
      this.#deps.tools.register(
        gated(
          {
            spec: {
              name,
              description: t.description ?? `插件 ${handle.manifest.name} 提供的工具`,
              ...(t.inputSchema !== undefined && t.inputSchema !== null ? { argsSchema: t.inputSchema as object } : {}),
            },
            async execute(_ctx, args) {
              return await svcCall(handle, t.name, args)
            },
          },
          { gate: this.#deps.gate },
        ),
      )
      handle.registeredToolNames.push(name)
    }
    this.#deps.log(`[openbot] 插件就绪：${handle.manifest.name}（工具 ${mcpTools.length} 个）`)
    return client
  }

  /** 桥接工具的执行入口（闭包经 deps 注入回本服务——懒拉起 + 计活） */
  readonly #callPluginTool = async (handle: PluginHandle, toolName: string, args: unknown): Promise<string> => {
    const client = await this.#ensureProcess(handle)
    handle.lastUsedAt = this.#deps.now()
    return await client.callTool(toolName, args)
  }

  /** 注销桥接工具（禁用/卸载——ToolRegistry 真实移除；缺席幂等） */
  #unregisterTools(handle: PluginHandle): void {
    for (const name of handle.registeredToolNames) this.#deps.tools.unregister(name)
    handle.registeredToolNames = []
  }

  /** 上行事件路由：v1.plugin.event（用户通知面）+ manifest.agents 唤醒（幂等 nonce） */
  #routeEvent(handle: PluginHandle, ev: { type: string; payload?: unknown }): void {
    handle.eventSeq += 1
    const payload =
      typeof ev.payload === 'object' && ev.payload !== null ? (ev.payload as Record<string, unknown>) : {}
    const summary = typeof payload['text'] === 'string' && payload['text'] !== '' ? payload['text'] : ev.type
    this.#deps.bus.emit('v1.plugin.event', {
      pluginId: handle.manifest.id,
      type: ev.type,
      payload: ev.payload ?? null,
    })
    // 唤醒绑定 Agent（显示名 → agentId；幂等 nonce = plugin-event:<id>:<seq>——事件风暴不双驱）
    for (const name of handle.manifest.agents) {
      const agentId = this.#deps.agentIdOfName(name)
      if (agentId === undefined) continue
      void this.#deps
        .sendUserMessage({
          toAgentId: agentId,
          text: `【插件事件 · ${handle.manifest.name}】${summary}`,
          nonce: `plugin-event:${handle.manifest.id}:${handle.eventSeq}`,
        })
        .catch((err) => {
          this.#deps.log(`[plugin:${handle.manifest.id}] 事件唤醒失败：${err instanceof Error ? err.message : String(err)}`)
        })
    }
  }

  /** 崩溃处理：限次重启（事件源插件），超限 faulted */
  #onCrash(handle: PluginHandle, code: number | null): void {
    handle.client = null
    const crashes = handle.runtime.crashes + 1
    if (crashes > MAX_CRASHES) {
      handle.runtime = { state: 'faulted', crashes, faultReason: `崩溃超限（exit ${code}）` }
      this.#deps.log(`[openbot] 插件故障标记：${handle.manifest.name}（${crashes - 1} 次重启后仍崩溃）`)
      return
    }
    handle.runtime = { state: 'stopped', crashes }
    if (this.#resident(handle)) {
      // 常驻插件（事件源/hooks）自动重启（退避 3s）
      setTimeout(() => {
        void this.#ensureProcess(handle).catch((err) => {
          this.#deps.log(`[openbot] 插件重启失败：${err instanceof Error ? err.message : String(err)}`)
        })
      }, 3000)
    }
  }

  /** 空闲回收：纯工具插件 idle 超时停进程（工具注册保留——下次调用懒拉起） */
  #startRecycler(): void {
    if (this.#recycleTimer !== null) return
    this.#recycleTimer = setInterval(() => {
      const now = this.#deps.now()
      for (const handle of this.#handles.values()) {
        if (handle.client === null || this.#resident(handle)) continue
        if (handle.lastUsedAt !== 0 && now - handle.lastUsedAt > IDLE_RECYCLE_MS) {
          this.#deps.log(`[openbot] 插件空闲回收：${handle.manifest.name}`)
          void handle.client.stop()
          handle.client = null
          handle.runtime = { state: 'stopped', crashes: handle.runtime.crashes }
        }
      }
    }, 60_000)
    this.#recycleTimer.unref?.()
  }
}

/** 工具名前缀 = id 尾段（点分隔最后一段；清洗为 [a-zA-Z0-9_-]——llm 提供商的工具名约束） */
function toolPrefixOf(id: string): string {
  const tail = id.split('.').at(-1) ?? id
  return tail.replace(/[^a-zA-Z0-9_-]/g, '_')
}
