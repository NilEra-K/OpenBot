/**
 * 内核事实 store（解耦纪律 #1：内核事实全部来自事件流与命令响应，渲染层不直改）。
 * roster/transcript 摘要/审批挂起——Step 8–9 随视图扩展（任务/Box/图谱族）。
 */
import { defineStore } from 'pinia'
import { createGatewayClient } from '../lib/gateway'
import { GatewayCommandError } from '../lib/gateway'
import type { GatewayClient, GatewayEndpoint } from '../lib/gateway'
import type { KernelEvent } from '@openbot/transport'

/** preload 注入的全局（index.cts 暴露；E2E 可在页面加载前替换） */
interface OpenbotGlobal {
  desktop: boolean
  window: { minimize(): void; toggleMaximize(): void; close(): void }
  gateway: { info(): Promise<GatewayEndpoint | null> }
}
declare global {
  interface Window {
    openbot: OpenbotGlobal
  }
}

export interface RosterEntry {
  agentId: string
  name?: string
  role: 'steward' | 'worker'
}

export interface ChatMessage {
  messageId: string
  kind: 'user' | 'agent' | 'a2a'
  from: string
  to: string
  text: string
  at: number
  /** 乐观占位：命令响应/事件到达前为 true（UI 显示发送中态） */
  pending?: boolean
  /** 发送失败（网络/领域错误）：UI 显示重试 */
  failed?: boolean
}

export interface PendingApproval {
  approvalId: string
  nonce: string
  runId: string
  agentId: string
  tool: string
  reason?: string
}

/** Box 执行卡：同键 started/finished 聚合（键 = runId，无 runId 的独立成卡） */
export interface ExecCard {
  key: string
  boxId: string
  runId?: string
  command: string[]
  phase: 'started' | 'finished'
  exitCode?: number
  at: number
}

/** 排程 run 卡（v1.lifecycle.* 事件累积；状态永远诚实） */
export interface RunCard {
  runId: string
  agentId: string
  lane: 'user' | 'agent' | 'background'
  kind: string
  /** 一句话摘要（queued 事件携带；无摘要的 run 退回显示 runId） */
  summary?: string
  state: 'queued' | 'running' | 'succeeded' | 'failed' | 'aborted' | 'escaped' | 'reaped'
  attempts: number
  code?: string
  at: number
  /** 末次状态时间 */
  updatedAt: number
}

/** Box 实例（boot 快照 + v1.box.state 事件更新） */
export interface BoxCard {
  boxId: string
  image: string
  state: 'active' | 'sleeping' | 'snapshot'
  createdAt: number
}

/** 图谱边（消息量；a2a 双向 + 用户↔agent） */
export interface GraphEdge {
  from: string
  to: string
  count: number
}

/** provider 展示形状（v1.settings.list 返回；协议保证无 key 材料） */
export interface ProviderView {
  name: string
  baseUrl: string
  model: string
  hasKey: boolean
  proxyUrl?: string
}

/** provider 表单输入（v1.settings.upsertProvider 载荷；apiKey 留空=保留原密文） */
export interface ProviderInput {
  name: string
  baseUrl: string
  model: string
  apiKey?: string
  proxyUrl?: string
}

export type SandboxPref = 'auto' | 'mock' | 'wsl' | 'docker' | 'podman'

/** 沙箱后端探测项（v1.sandbox.status 返回） */
export interface SandboxProbe {
  id: SandboxPref
  available: boolean
  reason?: string
}

/** 沙箱装配事实（v1.sandbox.status 返回；呈现用，不含任何控制指令） */
export interface SandboxStatus {
  preference: SandboxPref
  stored: SandboxPref
  backendId: SandboxPref
  wanted: SandboxPref
  reason?: string
  probes: SandboxProbe[]
  rootfsPath: string
  rootfsReady: boolean
}

/** 模块级客户端（非序列化对象不入 state） */
let client: GatewayClient | null = null
let unsubscribe: (() => void) | null = null
/** 已拉取 transcript 历史的 agent（懒加载去重；内核不重启时 SSE 重放已覆盖） */
const loadedHistory = new Set<string>()

export const useKernelStore = defineStore('kernel', {
  state: () => ({
    connected: false,
    /** 引导错误（网关不可达/装配失败）——空缺态提示的数据来源 */
    bootError: null as string | null,
    roster: [] as RosterEntry[],
    stewardId: null as string | null,
    messages: [] as ChatMessage[],
    pendingApprovals: [] as PendingApproval[],
    execs: [] as ExecCard[],
    runs: [] as RunCard[],
    boxes: [] as BoxCard[],
    edges: [] as GraphEdge[],
    /** 后端能力声明（caps 驱动 UI 按钮的依据） */
    caps: null as { persistent: boolean; snapshot: boolean; headless: boolean; resourceLimits: boolean; isolation: string } | null,
    /** settings 里已配置默认 provider（空缺态提示用） */
    providerConfigured: false,
    /** provider 档案清单（settings 视图；无 key 材料） */
    providers: [] as ProviderView[],
    defaultProvider: null as string | null,
    /** 沙箱后端装配事实（settings 视图呈现） */
    sandbox: null as SandboxStatus | null,
    lastSeq: 0,
  }),
  getters: {
    steward: (state) => state.roster.find((a) => a.agentId === state.stewardId) ?? null,
  },
  actions: {
    /** 启动接线：endpoint（preload 桥）→ 客户端 → 事件订阅 + 快照拉取 */
    async boot() {
      try {
        const endpoint = await window.openbot?.gateway?.info()
        if (!endpoint) {
          this.bootError = '内核未就绪（装配失败或非桌面环境）'
          return
        }
        client = createGatewayClient(endpoint)
        unsubscribe = client.subscribe((event) => this.onEvent(event))
        const agents = await client.call<Array<{ agentId: string; name?: string; role: string }>>('v1.system.listAgents')
        this.roster = agents.map((a) => ({ agentId: a.agentId, name: a.name, role: a.role as RosterEntry['role'] }))
        const steward = await client.call<{ agentId: string } | null>('v1.system.getSteward')
        this.stewardId = steward?.agentId ?? null
        await this.refreshSettings()
        const boxes = await client.call<Array<{ boxId: string; spec: { image: string }; state: BoxCard['state']; createdAt: number }>>('v1.boxes.list')
        this.boxes = boxes.map((b) => ({ boxId: b.boxId, image: b.spec.image, state: b.state, createdAt: b.createdAt }))
        this.caps = await client.call<NonNullable<typeof this.caps>>('v1.boxes.caps')
        await this.refreshSandbox()
        this.connected = true
      } catch (err) {
        this.bootError = err instanceof Error ? err.message : String(err)
      }
    },
    shutdown() {
      unsubscribe?.()
      unsubscribe = null
      client = null
      this.connected = false
    },
    /** 命令调用（视图 action 走这里；领域失败抛 GatewayCommandError 由视图分流文案） */
    call<T = unknown>(command: string, payload?: unknown): Promise<T> {
      if (!client) return Promise.reject(new Error('网关未连接'))
      return client.call<T>(command, payload)
    },
    /**
     * 发送用户消息（乐观更新 + nonce 幂等）：本地占位 → 命令受理（messageId 升级占位）→
     * 事件镜像去重。事件先到/响应先到两个顺序都收敛到单条正式消息（at-most-one 呈现）。
     */
    async sendUserMessage(toAgentId: string, text: string, reuseNonce?: string): Promise<void> {
      const nonce = reuseNonce ?? crypto.randomUUID()
      const placeholderId = `~${nonce}`
      if (!this.messages.some((m) => m.messageId === placeholderId)) {
        this.messages.push({ messageId: placeholderId, kind: 'user', from: 'user', to: toAgentId, text, at: Date.now(), pending: true })
      } else {
        // 重试：复用占位条目，翻回发送中态
        const idx = this.messages.findIndex((m) => m.messageId === placeholderId)
        this.messages[idx] = { ...this.messages[idx]!, pending: true, failed: false }
      }
      try {
        const acceptance = await this.call<{ messageId: string; runId: string | null; first: boolean }>(
          'v1.message.sendUser',
          { toAgentId, text, nonce },
        )
        const idx = this.messages.findIndex((m) => m.messageId === placeholderId)
        if (idx >= 0) {
          if (this.messages.some((m, i) => i !== idx && m.messageId === acceptance.messageId)) {
            this.messages.splice(idx, 1) // 事件已先到插了正式条目——移除占位
          } else {
            this.messages[idx] = { ...this.messages[idx]!, messageId: acceptance.messageId, pending: false }
          }
        }
      } catch (err) {
        const idx = this.messages.findIndex((m) => m.messageId === placeholderId)
        if (idx >= 0) this.messages[idx] = { ...this.messages[idx]!, pending: false, failed: true }
        throw err
      }
    },
    /**
     * 审批决议（弹窗/流内 gate 卡/角标共用）：成功后本地立即移除——与 SSE resolved 事件
     * 幂等双保险。传输失败（网关不可达）抛错保留条目供重试；领域失败（已决议/不存在）
     * 同样移除收敛（内核是权威），错误照抛由调用方分流文案。
     */
    async resolveApproval(nonce: string, decision: 'approved' | 'denied'): Promise<void> {
      try {
        await this.call('v1.approval.resolve', { nonce, decision })
      } catch (err) {
        if (!(err instanceof GatewayCommandError)) throw err
      }
      this.pendingApprovals = this.pendingApprovals.filter((a) => a.nonce !== nonce)
    },
    /** Box 快照（按钮按 caps.snapshot 渲染；返回快照 id 供视图反馈） */
    async snapshotBox(boxId: string): Promise<string> {
      const { snapshotId } = await this.call<{ snapshotId: string }>('v1.boxes.snapshot', { boxId })
      return snapshotId
    },
    /** 刷新 provider 配置（boot 与 settings 视图操作后调用） */
    async refreshSettings(): Promise<void> {
      const state = await this.call<{ providers: ProviderView[]; defaultProvider: string | null }>('v1.settings.list')
      this.providers = state.providers
      this.defaultProvider = state.defaultProvider
      this.providerConfigured = state.defaultProvider !== null
    },
    /** 新增/更新 provider（同名替换；apiKey 省略=保留原密文），成功后刷新配置态 */
    async upsertProvider(input: ProviderInput): Promise<void> {
      await this.call('v1.settings.upsertProvider', input)
      await this.refreshSettings()
    },
    async setDefaultProvider(name: string): Promise<void> {
      await this.call('v1.settings.setDefault', { name })
      await this.refreshSettings()
    },
    async removeProvider(name: string): Promise<void> {
      await this.call('v1.settings.removeProvider', { name })
      await this.refreshSettings()
    },
    /** 刷新沙箱后端状态（boot 与 settings 视图进入时调用） */
    async refreshSandbox(): Promise<void> {
      this.sandbox = await this.call<SandboxStatus>('v1.sandbox.status')
    },
    /** 写沙箱偏好（重启生效；成功后刷新 stored 呈现） */
    async setSandbox(pref: SandboxPref): Promise<void> {
      await this.call('v1.sandbox.set', { preference: pref })
      await this.refreshSandbox()
    },
    /**
     * 会话历史懒加载（切换会话时调用一次）：transcript 是持久真相——内核重启后 SSE 事件流为空，
     * 历史从这里恢复；与已收事件按 messageId 去重。渲染层重启（内核未重启）时 SSE since(0)
     * 已重放进程内全部事件，此处天然幂等跳过。
     */
    async loadHistory(agentId: string): Promise<void> {
      if (loadedHistory.has(agentId)) return
      loadedHistory.add(agentId)
      let records: Array<{ seq: number; at: number; kind: string; payload: unknown }>
      try {
        records = await this.call('v1.transcript.read', { agentId })
      } catch (err) {
        loadedHistory.delete(agentId) // 失败回滚标记：boot 未完成/网络抖动后允许重试
        throw err
      }
      for (const record of records) {
        const p = record.payload as { messageId?: string; text?: string; from?: string; to?: string }
        if (typeof p.messageId !== 'string' || typeof p.text !== 'string') continue
        if (this.messages.some((m) => m.messageId === p.messageId)) continue // 事件流已覆盖
        const mapped: ChatMessage | null =
          record.kind === 'user'
            ? { messageId: p.messageId, kind: 'user', from: 'user', to: agentId, text: p.text, at: record.at }
            : record.kind === 'agent'
              ? { messageId: p.messageId, kind: 'agent', from: agentId, to: 'user', text: p.text, at: record.at }
              : record.kind === 'a2a-out' && typeof p.to === 'string'
                ? { messageId: p.messageId, kind: 'a2a', from: agentId, to: p.to, text: p.text, at: record.at }
                : record.kind === 'a2a-in' && typeof p.from === 'string'
                  ? { messageId: p.messageId, kind: 'a2a', from: p.from, to: agentId, text: p.text, at: record.at }
                  : null
        if (mapped) this.messages.push(mapped)
      }
      this.messages.sort((a, b) => a.at - b.at)
    },
    /** 事件分发：内核是唯一事实源，这里只做投影 */
    onEvent(event: KernelEvent) {
      this.lastSeq = event.seq
      switch (event.type) {
        case 'v1.system.roster': {
          const { agentId, role, cause } = event.payload
          if (cause === 'removed') {
            this.roster = this.roster.filter((a) => a.agentId !== agentId)
          } else if (this.roster.some((a) => a.agentId === agentId)) {
            this.roster = this.roster.map((a) => (a.agentId === agentId ? { ...a, role } : a))
          } else {
            this.roster.push({ agentId, role })
          }
          if (role === 'steward') this.stewardId = agentId
          else if (this.stewardId === agentId) this.stewardId = null
          return
        }
        case 'v1.message.user': {
          const { messageId, toAgentId, text } = event.payload
          this.bumpEdge('user', toAgentId)
          if (this.messages.some((m) => m.messageId === messageId)) return // 响应先到已升级——去重
          // 事件先到（受理即 emit）：升级同目标的 pending 占位（顺序配对第一个）
          const idx = this.messages.findIndex((m) => m.pending && m.to === toAgentId && m.text === text)
          if (idx >= 0) {
            this.messages[idx] = { ...this.messages[idx]!, messageId, pending: false, failed: false }
          } else {
            this.messages.push({ messageId, kind: 'user', from: 'user', to: toAgentId, text, at: event.at })
          }
          return
        }
        case 'v1.message.agent':
          this.bumpEdge(event.payload.agentId, 'user')
          this.messages.push({
            messageId: event.payload.messageId,
            kind: 'agent',
            from: event.payload.agentId,
            to: 'user',
            text: event.payload.text,
            at: event.at,
          })
          return
        case 'v1.message.a2a':
          this.bumpEdge(event.payload.fromAgentId, event.payload.toAgentId)
          this.messages.push({
            messageId: event.payload.messageId,
            kind: 'a2a',
            from: event.payload.fromAgentId,
            to: event.payload.toAgentId,
            text: event.payload.text,
            at: event.at,
          })
          return
        case 'v1.approval.requested': {
          // nonce 幂等：重放/重试不双弹窗
          if (this.pendingApprovals.some((a) => a.nonce === event.payload.nonce)) return
          this.pendingApprovals.push({
            approvalId: event.payload.approvalId,
            nonce: event.payload.nonce,
            runId: event.payload.runId,
            agentId: event.payload.agentId,
            tool: event.payload.tool,
            ...(event.payload.reason !== undefined ? { reason: event.payload.reason } : {}),
          })
          return
        }
        case 'v1.approval.resolved':
          this.pendingApprovals = this.pendingApprovals.filter((a) => a.nonce !== event.payload.nonce)
          return
        case 'v1.box.exec': {
          const { boxId, runId, phase, command, exitCode } = event.payload
          const key = runId ?? `${boxId}#${event.seq}` // 无 runId 的每次 exec 独立成卡
          const idx = this.execs.findIndex((e) => e.key === key)
          if (idx >= 0) {
            this.execs[idx] = { ...this.execs[idx]!, phase, ...(exitCode !== undefined ? { exitCode } : {}) }
          } else {
            this.execs.push({ key, boxId, ...(runId !== undefined ? { runId } : {}), command, phase, at: event.at })
          }
          return
        }
        case 'v1.box.state': {
          const { boxId, state } = event.payload
          const idx = this.boxes.findIndex((b) => b.boxId === boxId)
          if (idx >= 0) this.boxes[idx] = { ...this.boxes[idx]!, state }
          else this.boxes.push({ boxId, image: '?', state, createdAt: event.at }) // 快照缺失时的兜底（box 卡补齐靠重启）
          return
        }
        case 'v1.lifecycle.queued': {
          const { runId, agentId, lane, kind, summary } = event.payload
          this.runs = this.runs.filter((r) => r.runId !== runId)
          this.runs.push({
            runId,
            agentId,
            lane,
            kind,
            summary: summary ?? undefined,
            state: 'queued',
            attempts: 0,
            at: event.at,
            updatedAt: event.at,
          })
          return
        }
        case 'v1.lifecycle.started': {
          const run = this.runs.find((r) => r.runId === event.payload.runId)
          if (run) {
            run.state = 'running'
            run.attempts += 1
            run.updatedAt = event.at
          }
          return
        }
        case 'v1.lifecycle.finished': {
          const run = this.runs.find((r) => r.runId === event.payload.runId)
          if (run) {
            run.state = event.payload.state
            run.attempts = event.payload.attempts
            if (event.payload.code !== undefined) run.code = event.payload.code
            run.updatedAt = event.at
          }
          return
        }
        case 'v1.lifecycle.escaped':
        case 'v1.lifecycle.reaped': {
          const run = this.runs.find((r) => r.runId === event.payload.runId)
          if (run) {
            run.state = event.type === 'v1.lifecycle.escaped' ? 'escaped' : 'reaped'
            run.updatedAt = event.at
          }
          return
        }
        default:
          return // 其余族（task/graph 事件）随 backlog 视图扩展
      }
    },
    /** 图谱边计数（幂等聚合） */
    bumpEdge(from: string, to: string): void {
      const edge = this.edges.find((e) => e.from === from && e.to === to)
      if (edge) edge.count += 1
      else this.edges.push({ from, to, count: 1 })
    },
  },
})
