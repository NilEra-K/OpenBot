/**
 * 内核事实 store（解耦纪律 #1：内核事实全部来自事件流与命令响应，渲染层不直改）。
 * roster/transcript 摘要/审批挂起——Step 8–9 随视图扩展（任务/Box/图谱族）。
 */
import { defineStore } from 'pinia'
import { createGatewayClient } from '../lib/gateway'
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
}

export interface PendingApproval {
  approvalId: string
  nonce: string
  runId: string
  agentId: string
  tool: string
  reason?: string
}

/** 模块级客户端（非序列化对象不入 state） */
let client: GatewayClient | null = null
let unsubscribe: (() => void) | null = null

export const useKernelStore = defineStore('kernel', {
  state: () => ({
    connected: false,
    /** 引导错误（网关不可达/装配失败）——空缺态提示的数据来源 */
    bootError: null as string | null,
    roster: [] as RosterEntry[],
    stewardId: null as string | null,
    messages: [] as ChatMessage[],
    pendingApprovals: [] as PendingApproval[],
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
        case 'v1.message.user':
          this.messages.push({
            messageId: event.payload.messageId,
            kind: 'user',
            from: 'user',
            to: event.payload.toAgentId,
            text: event.payload.text,
            at: event.at,
          })
          return
        case 'v1.message.agent':
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
        default:
          return // 其余族（box/task/graph/lifecycle）Step 8–9 随视图扩展
      }
    },
  },
})
