/**
 * 审批流：出 Box 操作先过闸，事件往返 renderer（P2 弹窗），nonce 幂等不双弹窗、不双执行
 * （复用 state 幂等账本——原版账本设计为 OpenBot 闸门服务，架构继承里最划算的回收）。
 * P1 提供 AutoApprovalGate（CLI/测试：自动批准但全链路照记）与 StaticApprovalGate（测试编排拒绝路径）。
 */
import { KernelError } from '@openbot/core'
import type { EventBus } from '@openbot/core'
import { digestOf } from '@openbot/state'
import type { IdempotencyLedger } from '@openbot/state'

export const ApprovalErrorCodes = {
  APPROVAL_DENIED: 'APPROVAL_DENIED',
} as const

export type ApprovalDecision = 'approved' | 'denied'

/** 闸门请求（run 层拦截时组装） */
export interface ApprovalRequest {
  runId: string
  agentId: string
  tool: string
  reason?: string
  /** 幂等键：同一逻辑操作重试不双弹窗——由 originMessageId + toolCallId 派生 */
  nonce: string
}

export interface ApprovalGate {
  /** true=放行；false=拒绝（工具收到 APPROVAL_DENIED） */
  request(request: ApprovalRequest): Promise<boolean>
}

export interface AutoApprovalGateDeps {
  bus: EventBus
  ledger: IdempotencyLedger
  now: () => number
  nextApprovalId: () => string
}

/** CLI 模式闸门：不等人，但事件与账本一步不少——P2 换成弹窗实现，接口不动 */
export class AutoApprovalGate implements ApprovalGate {
  readonly #deps: AutoApprovalGateDeps

  constructor(deps: AutoApprovalGateDeps) {
    this.#deps = deps
  }

  async request(request: ApprovalRequest): Promise<boolean> {
    const { bus, ledger, nextApprovalId } = this.#deps
    const digest = digestOf({ runId: request.runId, agentId: request.agentId, tool: request.tool })
    const begin = await ledger.begin(`approval:${request.nonce}`, digest)
    if (!begin.first) {
      // 重试回放：账本已记首次决定，不再发事件、不再决策
      return begin.entry.outcome === true
    }
    const approvalId = nextApprovalId()
    bus.emit('v1.approval.requested', {
      approvalId,
      runId: request.runId,
      agentId: request.agentId,
      tool: request.tool,
      reason: request.reason,
      nonce: request.nonce,
    })
    const approved = true
    await ledger.commit(`approval:${request.nonce}`, approved)
    bus.emit('v1.approval.resolved', { approvalId, decision: 'approved', nonce: request.nonce })
    return approved
  }
}

/** 静态决定闸门：测试编排拒绝/放行路径用 */
export class StaticApprovalGate implements ApprovalGate {
  readonly #decision: boolean

  constructor(decision: boolean) {
    this.#decision = decision
  }

  async request(): Promise<boolean> {
    return this.#decision
  }
}

/** 拒绝时工具侧收到的稳定错误（转成工具回喂文本，模型可见） */
export function approvalDenied(request: ApprovalRequest): KernelError {
  return new KernelError(
    ApprovalErrorCodes.APPROVAL_DENIED,
    `出 Box 操作未获批准：${request.tool}（run ${request.runId}）`,
  )
}
