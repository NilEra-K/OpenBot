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
  /** resolve 了从未受理过的审批 */
  APPROVAL_NOT_FOUND: 'APPROVAL_NOT_FOUND',
  /** 审批等待中 run 被中止——审批作废（不视为 denied，也不视为 approved） */
  APPROVAL_RUN_ABORTED: 'APPROVAL_RUN_ABORTED',
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
  /**
   * run 中止善后（可选实现）：该 run 的挂起审批按 denied 落账并唤醒等待方——
   * 用户中止 run = 否决其未决请求（审批卡随 resolved 事件自然收敛，账本不孤儿、重启不重放）。
   * 返回处理条数。
   */
  revokeRun?(runId: string): Promise<number>
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

export interface ManualApprovalGateDeps {
  bus: EventBus
  ledger: IdempotencyLedger
}

interface PendingApproval {
  request: ApprovalRequest
  settled: Promise<boolean>
  settle: (approved: boolean) => void
}

/**
 * 挂起式闸门（桌面装配用）：request() 挂起至 resolve()（审批弹窗回写）——
 * 挂起不设闸门侧超时；run 中止的解锁走 gated() 的 signal race + 装配层 revokeRun 善后
 * （deadlineMs 只 abort signal，叫不醒本挂起——勿再依赖 deadline 兜底）。
 * 幂等与崩溃恢复：账本 pending + 重启后再次 request 同 nonce → 重发 requested 事件再挂起；
 * 已决议的 nonce → 直接回放首次决定，不再弹窗。approvalId 由 nonce 确定性派生（重发同 id）。
 */
export class ManualApprovalGate implements ApprovalGate {
  readonly #deps: ManualApprovalGateDeps
  readonly #pending = new Map<string, PendingApproval>()
  /** 排他锁：begin+suspend 与 resolve 串行——防并发同 nonce 双重挂起/先决议后受理 */
  #lock: Promise<unknown> = Promise.resolve()

  constructor(deps: ManualApprovalGateDeps) {
    this.#deps = deps
  }

  async request(request: ApprovalRequest): Promise<boolean> {
    // 临界区只做 begin + 挂起建立（不等待决议本身——否则 resolve 拿不到锁，死锁）
    let settled: Promise<boolean> | undefined
    let replay: boolean | undefined
    await this.#withLock(async () => {
      const key = `approval:${request.nonce}`
      const digest = digestOf({
        runId: request.runId,
        agentId: request.agentId,
        tool: request.tool,
      })
      const begin = await this.#deps.ledger.begin(key, digest)
      if (!begin.first) {
        // 已决议：回放首次决定（重试不双弹窗、不双执行）
        if (begin.entry.outcome !== undefined) {
          replay = begin.entry.outcome === true
          return
        }
        // 并发同 nonce：并到同一等待
        const existing = this.#pending.get(request.nonce)
        if (existing) {
          settled = existing.settled
          return
        }
      }
      settled = this.#suspend(request)
    })
    if (settled !== undefined) return settled
    if (replay !== undefined) return replay
    throw new KernelError('APPROVAL_INTERNAL', 'request 临界区未产出结果（不可达）')
  }

  /** 决议回写（v1.approval.resolve 命令的目标）：账本落定 + 唤醒等待方 + resolved 事件 */
  async resolve(nonce: string, decision: ApprovalDecision): Promise<boolean> {
    return this.#withLock(() => this.#resolveLocked(nonce, decision))
  }

  /** run 中止善后（ApprovalGate.revokeRun）：该 run 的挂起审批按 denied 落账——用户主权传导 */
  async revokeRun(runId: string): Promise<number> {
    return this.#withLock(async () => {
      const targets = [...this.#pending.values()].filter((p) => p.request.runId === runId)
      for (const target of targets) {
        await this.#resolveLocked(target.request.nonce, 'denied')
      }
      return targets.length
    })
  }

  /** 当前挂起中的审批（UI/测试观察面） */
  pending(): ApprovalRequest[] {
    return [...this.#pending.values()].map((p) => p.request)
  }

  /**
   * 崩溃恢复：扫账本 'approval:' 前缀的 pending 项，重发 requested 事件让 UI 重新弹窗
   * （原 run 已死不重建挂起——决议经 resolve 命令照常落账本；digest 恢复事件负载）。
   * 装配时调用一次；返回重放条数。
   */
  async replayPending(): Promise<number> {
    const entries = await this.#deps.ledger.listPending('approval:')
    for (const entry of entries) {
      const nonce = entry.nonce.slice('approval:'.length)
      if (this.#pending.has(nonce)) continue
      let info: { runId?: string; agentId?: string; tool?: string } = {}
      try {
        info = JSON.parse(entry.digest) as typeof info
      } catch {
        // 坏 digest 行如实带 '? '（决议不受影响——账本 nonce 仍是唯一真相）
      }
      this.#deps.bus.emit('v1.approval.requested', {
        approvalId: approvalIdOf(nonce),
        runId: info.runId ?? '?',
        agentId: info.agentId ?? '?',
        tool: info.tool ?? '?',
        nonce,
      })
    }
    return entries.length
  }

  async #resolveLocked(nonce: string, decision: ApprovalDecision): Promise<boolean> {
    const key = `approval:${nonce}`
    const existing = await this.#deps.ledger.lookup(key)
    if (!existing) {
      throw new KernelError(ApprovalErrorCodes.APPROVAL_NOT_FOUND, `未受理过的审批：${nonce}`)
    }
    const approved = decision === 'approved'
    const wasPending = existing.status === 'pending'
    // commit 幂等：已决议时返回首决并落盘不变——回放语义以账本为唯一真相
    const committed = await this.#deps.ledger.commit(key, approved)
    const pending = this.#pending.get(nonce)
    pending?.settle(committed.outcome === true)
    if (wasPending) {
      // 只在首次落定时发事件；重复 resolve 幂等静默（账本已保真）
      this.#deps.bus.emit('v1.approval.resolved', {
        approvalId: approvalIdOf(nonce),
        decision: committed.outcome === true ? 'approved' : 'denied',
        nonce,
      })
    }
    return committed.outcome === true
  }

  #suspend(request: ApprovalRequest): Promise<boolean> {
    let settle!: (approved: boolean) => void
    const settled = new Promise<boolean>((resolve) => {
      settle = resolve
    })
    this.#pending.set(request.nonce, { request, settled, settle })
    void settled.then(() => this.#pending.delete(request.nonce))
    this.#deps.bus.emit('v1.approval.requested', {
      approvalId: approvalIdOf(request.nonce),
      runId: request.runId,
      agentId: request.agentId,
      tool: request.tool,
      reason: request.reason,
      nonce: request.nonce,
    })
    return settled
  }

  async #withLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#lock.then(fn, fn)
    this.#lock = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }
}

/** approvalId 由 nonce 派生：崩溃重发同 id，UI 按 nonce 去重天然成立 */
function approvalIdOf(nonce: string): string {
  return `appr-${nonce}`
}

/** 拒绝时工具侧收到的稳定错误（转成工具回喂文本，模型可见） */
export function approvalDenied(request: ApprovalRequest): KernelError {
  return new KernelError(
    ApprovalErrorCodes.APPROVAL_DENIED,
    `出 Box 操作未获批准：${request.tool}（run ${request.runId}）`,
  )
}

// ---- 可切换闸门（2026-09-06 预算打穿问用户 + composer 审批模式热切换） ----

export type ApprovalMode = 'manual' | 'auto'

export interface SwitchableApprovalGateDeps {
  /** 手动内件（变更前确认——弹窗等用户决议，如 ManualApprovalGate） */
  manual: ApprovalGate
  /** 自动内件（完全访问——自动批准账本照记，如 AutoApprovalGate） */
  auto: ApprovalGate
  bus: EventBus
}

/**
 * 可切换闸门：request 按**当前模式**委托给内件（manual=变更前确认 / auto=完全访问）。
 * 热切换由 composer 的审批模式下拉驱动（setMode）；幂等账本在内件各自持有（Auto 内建、
 * Manual 由装配注入同一 ledger）——切换不丢已决议记录。
 * revokeRun：两个内件都善后（挂起请求可能散在两侧——切换前发起的挂在旧内件，幂等）。
 * auto 模式下 TurnRunner 的工具预算询问自动获批续期（「完全访问=减少确认次数」的语义自洽）。
 */
export class SwitchableApprovalGate implements ApprovalGate {
  #mode: ApprovalMode
  readonly #manual: ApprovalGate
  readonly #auto: ApprovalGate
  readonly #bus: EventBus

  constructor(deps: SwitchableApprovalGateDeps & { mode?: ApprovalMode }) {
    this.#manual = deps.manual
    this.#auto = deps.auto
    this.#bus = deps.bus
    this.#mode = deps.mode ?? 'manual'
  }

  get mode(): ApprovalMode {
    return this.#mode
  }

  setMode(mode: ApprovalMode): void {
    this.#mode = mode
    this.#bus.emit('v1.approval.mode-changed', { mode })
  }

  async request(request: ApprovalRequest): Promise<boolean> {
    const inner = this.#mode === 'auto' ? this.#auto : this.#manual
    return inner.request(request)
  }

  async revokeRun(runId: string): Promise<number> {
    let n = 0
    if (this.#manual.revokeRun) n += await this.#manual.revokeRun(runId)
    if (this.#auto.revokeRun) n += await this.#auto.revokeRun(runId)
    return n
  }
}
