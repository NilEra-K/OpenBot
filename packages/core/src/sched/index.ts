/**
 * 排他调度：每 agent 一个 AgentScheduler，同一时刻至多一个活跃 run；
 * 三 lane 优先级 user > agent > background，同 lane FIFO；
 * user/steer 来客可抢占非 user 活跃 run（user 活跃 run 永不被抢占）；
 * watchdog 逃逸（settled 先行结算，发送永不悬挂）与 zombie 回收（槽位保留至底层 settle）。
 * 纯逻辑零 I/O：时钟与 runId 生成均由参数注入。参考：ARCHITECTURE.md §3.1、docs/plan-p1.md Step 1。
 */
import { ErrorCodes, KernelError } from '../errors/index.js'
import type { EventBus } from '../events/index.js'
import { DEFAULT_RUN_POLICY } from '../lifecycle/index.js'
import type { Lane, RunOutcome, RunOutcomeState, RunPolicy, RunTicket } from '../lifecycle/index.js'

/** lane 取队列的固定优先顺序（user > agent > background） */
const LANE_ORDER: readonly Lane[] = ['user', 'agent', 'background']

export interface RunRequest {
  lane: Lane
  /** 领域种类（'chat' | 'a2a' | …），调度器不解释 */
  kind: string
  /** 领域负载，调度器不解释 */
  payload?: unknown
  /** priority：可抢占非 user 活跃 run（user lane 隐含 true） */
  steer?: boolean
  /** 一句话摘要（领域事实，透传进 queued 事件；调度器不解释） */
  summary?: string
  /** 覆盖调度器默认策略（只认显式定义的键） */
  policy?: Partial<RunPolicy>
}

/** 交给 execute 的活跃 run 快照 */
export interface ActiveRun {
  runId: string
  agentId: string
  lane: Lane
  kind: string
  payload: unknown
  steer: boolean
  signal: AbortSignal
}

/**
 * execute 契约：返回成功产物，或抛 KernelError（code 进结局）。
 * 必须响应 signal（被抢占/到期时及时退出）且必须有界（llm/box 调用自带超时——
 * zombie 若真死挂，槽位将一直被占，这是排他不变量的代价）。
 */
export type RunExecutor = (run: ActiveRun) => Promise<unknown>

export interface SchedulerOptions {
  agentId: string
  now: () => number
  nextRunId: () => string
  execute: RunExecutor
  /** 调度器级默认策略，可被单 run 覆盖 */
  policy?: Partial<RunPolicy>
  /** 事件出口，可选（不接则只经 settled 交付结局） */
  bus?: EventBus
}

interface QueueEntry {
  runId: string
  request: RunRequest
  policy: RunPolicy
  steer: boolean
  enqueuedAt: number
  settle: (outcome: RunOutcome) => void
  /** 是否已结算（逃逸先行 + 中止竞态下防双结算） */
  settled: boolean
}

interface ActiveSlot {
  run: ActiveRun
  entry: QueueEntry
  controller: AbortController
  startedAt: number
  /** 最近进展时刻（进展驱动 grace：touch 刷新——在动的 run 永不逃逸，2026-09-06 语义升级） */
  lastProgressAt: number
  /** 已逃逸：settled 已先行结算，等底层 settle 后回收 */
  escaped: boolean
  /** 本侧主动 abort 的原因（结算时据此覆盖结局，execute 自报的 code 不作数） */
  abortReason: 'steer' | 'deadline' | 'cancelled' | null
}

export class AgentScheduler {
  readonly agentId: string
  readonly #now: () => number
  readonly #nextRunId: () => string
  readonly #execute: RunExecutor
  /** 策略基线（热更新可变——updatePolicy；entry 入队时拷贝故在途 run 不受影响） */
  #policy: RunPolicy
  readonly #bus: EventBus | undefined
  readonly #lanes: Record<Lane, QueueEntry[]>
  #active: ActiveSlot | null = null

  constructor(options: SchedulerOptions) {
    this.agentId = options.agentId
    this.#now = options.now
    this.#nextRunId = options.nextRunId
    this.#execute = options.execute
    this.#policy = { ...DEFAULT_RUN_POLICY, ...definedEntries(options.policy) }
    this.#bus = options.bus
    this.#lanes = { user: [], agent: [], background: [] }
  }

  /** 受理（ack 义务）：同步给票据，结局经 settled 交付；立即触发抢占判定与排空 */
  enqueue(request: RunRequest): RunTicket {
    const runId = this.#nextRunId()
    const policy: RunPolicy = { ...this.#policy, ...definedEntries(request.policy) }
    let settle!: (outcome: RunOutcome) => void
    const settled = new Promise<RunOutcome>((resolve) => {
      settle = resolve
    })
    const entry: QueueEntry = {
      runId,
      request,
      policy,
      steer: request.steer === true || request.lane === 'user',
      enqueuedAt: this.#now(),
      settle,
      settled: false,
    }
    this.#lanes[request.lane].push(entry)
    const queuedPayload: import('../events/index.js').LifecycleQueuedPayload = {
      runId,
      agentId: this.agentId,
      lane: request.lane,
      kind: request.kind,
      steer: entry.steer,
    }
    // exactOptionalPropertyTypes：显式 undefined 不进 payload（向后兼容的读取端不认 undefined 键）
    if (request.summary !== undefined) queuedPayload.summary = request.summary
    this.#bus?.emit('v1.lifecycle.queued', queuedPayload)
    // 抢占判定：可 steer 来客 vs 非 user 活跃 run（user 活跃 run 永不被抢占）
    const active = this.#active
    if (active && entry.steer && active.run.lane !== 'user') {
      active.abortReason = active.abortReason ?? 'steer'
      active.controller.abort()
    }
    this.#drain(false)
    return { runId, agentId: this.agentId, acceptedAt: entry.enqueuedAt, settled }
  }

  /**
   * 进展信号（2026-09-06 语义升级——对齐 Claude Code 类 agent「在动就一直跑」的体验）：
   * execute 侧的流事件（llm chunk / exec 起止与增量 / 审批挂起）经装配方转发到这里，
   * 刷新活跃 run 的无进展计时。grace 判据从「启动后时长」改为「无进展时长」——
   * 慢任务（弱模型长思考、多轮工具循环）不再被误杀，真死挂（无任何信号）仍被兜底。
   * 不存在或不活跃的 runId 静默忽略（返回 false 供测试断言）。
   */
  touch(runId: string): boolean {
    const active = this.#active
    if (active === null || active.run.runId !== runId) return false
    if (active.escaped) return false // 已逃逸（回执已先行）——保鲜无意义
    active.lastProgressAt = this.#now()
    return true
  }

  /** 策略热更新（2026-11-01 执行预算保存即生效）：合并进本调度器的策略基线——
   *  只影响**此后入队**的 run（entry 构造时拷贝基线），在途 run 保持入队时策略
   *  （一个 run 内预算一致，中途改上限不回溯） */
  updatePolicy(partial: Partial<RunPolicy>): void {
    this.#policy = { ...this.#policy, ...definedEntries(partial) }
  }

  /** watchdog/期限心跳：由装配方驱动（真实=定时器，测试=手动推进） */
  tick(): void {    const active = this.#active
    if (!active) return
    // grace 判据 = 无进展时长（touch 刷新）；deadline 判据 = 总时长（失控循环硬限，不从进展豁免）
    const idleMs = this.#now() - active.lastProgressAt
    if (!active.escaped && idleMs > active.entry.policy.graceMs) {
      active.escaped = true
      this.#bus?.emit('v1.lifecycle.escaped', {
        runId: active.run.runId,
        agentId: this.agentId,
        graceMs: active.entry.policy.graceMs,
      })
      this.#settleEntry(active.entry, this.#outcome(active, 'escaped', ErrorCodes.RUN_GRACE_EXCEEDED))
    }
    const totalMs = this.#now() - active.startedAt
    if (totalMs > active.entry.policy.deadlineMs && !active.controller.signal.aborted) {
      if (active.abortReason === null) active.abortReason = 'deadline'
      active.controller.abort()
    }
  }

  /** 外部取消（排队中直接结算；活跃中转 abort）。不存在或已不可取消返回 false */
  cancel(runId: string): boolean {
    for (const lane of LANE_ORDER) {
      const queue = this.#lanes[lane]
      const idx = queue.findIndex((entry) => entry.runId === runId)
      if (idx >= 0) {
        const [entry] = queue.splice(idx, 1)
        if (!entry) continue
        const outcome = this.#plainOutcome(entry, 'aborted', ErrorCodes.RUN_CANCELLED)
        this.#settleEntry(entry, outcome)
        this.#bus?.emit('v1.lifecycle.finished', {
          runId,
          agentId: this.agentId,
          state: 'aborted',
          code: ErrorCodes.RUN_CANCELLED,
          attempts: 1,
        })
        return true
      }
    }
    const active = this.#active
    if (active && active.run.runId === runId && !active.controller.signal.aborted) {
      active.abortReason = active.abortReason ?? 'cancelled'
      active.controller.abort()
      return true
    }
    return false
  }

  /** 当前活跃 runId（含未回收的 zombie） */
  get activeRunId(): string | null {
    return this.#active?.run.runId ?? null
  }

  /** 各 lane 排队深度 */
  queueDepths(): Record<Lane, number> {
    return {
      user: this.#lanes.user.length,
      agent: this.#lanes.agent.length,
      background: this.#lanes.background.length,
    }
  }

  /** 无活跃且无排队 */
  get isIdle(): boolean {
    return this.#active === null && LANE_ORDER.every((lane) => this.#lanes[lane].length === 0)
  }

  #drain(fromFinish: boolean): void {
    while (this.#active === null) {
      const entry = this.#peek()
      if (!entry) {
        if (fromFinish) {
          this.#bus?.emit('v1.lifecycle.idle', { agentId: this.agentId })
        }
        return
      }
      this.#start(entry)
    }
  }

  #peek(): QueueEntry | undefined {
    for (const lane of LANE_ORDER) {
      const queue = this.#lanes[lane]
      if (queue.length > 0) return queue.shift()
    }
    return undefined
  }

  #start(entry: QueueEntry): void {
    const controller = new AbortController()
    const run: ActiveRun = {
      runId: entry.runId,
      agentId: this.agentId,
      lane: entry.request.lane,
      kind: entry.request.kind,
      payload: entry.request.payload ?? null,
      steer: entry.steer,
      signal: controller.signal,
    }
    const slot: ActiveSlot = {
      run,
      entry,
      controller,
      startedAt: this.#now(),
      lastProgressAt: this.#now(),
      escaped: false,
      abortReason: null,
    }
    this.#active = slot
    this.#bus?.emit('v1.lifecycle.started', {
      runId: run.runId,
      agentId: this.agentId,
      lane: run.lane,
      kind: run.kind,
    })
    // 同步调用 execute 但隔离同步抛（契约：返回 Promise；同步抛按失败结算）
    let promise: Promise<unknown>
    try {
      promise = this.#execute(run)
    } catch (err) {
      promise = Promise.reject(err)
    }
    void promise.then(
      (result) => this.#finish(slot, result),
      (err) => this.#finish(slot, undefined, err),
    )
  }

  #finish(slot: ActiveSlot, result?: unknown, err?: unknown): void {
    if (this.#active !== slot) return
    this.#active = null
    if (slot.escaped) {
      // zombie 回收：settled 早已以 escaped 结算（回执先行——ticket 结局不变），这里补发
      // **真实终态** finished 事件（2026-09-06 用户报障：排程卡停在「已回收」且底层成功也
      // 无人知晓）。终答消息本就由 execute 内部投递（v1.message.agent——迟到但到达），
      // 此处只修呈现层的真实终态；二次 settleEntry 幂等跳过（settled 已置位）
      this.#bus?.emit('v1.lifecycle.reaped', { runId: slot.run.runId, agentId: this.agentId })
      const outcome = this.#zombieOutcome(slot, result, err)
      this.#bus?.emit('v1.lifecycle.finished', {
        runId: slot.run.runId,
        agentId: this.agentId,
        state: outcome.state,
        ...(outcome.code !== undefined ? { code: outcome.code } : {}),
        attempts: 1,
      })
      this.#drain(true)
      return
    }
    let outcome: RunOutcome
    if (slot.abortReason === 'steer') {
      outcome = this.#outcome(slot, 'aborted', ErrorCodes.RUN_STEER)
    } else if (slot.abortReason === 'cancelled') {
      outcome = this.#outcome(slot, 'aborted', ErrorCodes.RUN_CANCELLED)
    } else if (slot.abortReason === 'deadline') {
      outcome = this.#outcome(slot, 'failed', ErrorCodes.RUN_DEADLINE)
    } else if (err !== undefined) {
      const kernelError =
        err instanceof KernelError
          ? err
          : new KernelError(ErrorCodes.RUN_INTERNAL, err instanceof Error ? err.message : String(err))
      outcome = this.#outcome(slot, 'failed', kernelError.code, undefined, kernelError.message)
    } else {
      outcome = this.#outcome(slot, 'succeeded', undefined, result)
    }
    this.#settleEntry(slot.entry, outcome)
    this.#bus?.emit('v1.lifecycle.finished', {
      runId: slot.run.runId,
      agentId: this.agentId,
      state: outcome.state,
      code: outcome.code,
      attempts: 1,
    })
    this.#drain(true)
  }

  /** zombie 底层终态（与正常分支同型，但**不二次 settle**——entry 已以 escaped 结算） */
  #zombieOutcome(slot: ActiveSlot, result?: unknown, err?: unknown): { state: RunOutcomeState; code?: string } {
    if (slot.abortReason === 'steer') return { state: 'aborted', code: ErrorCodes.RUN_STEER }
    if (slot.abortReason === 'cancelled') return { state: 'aborted', code: ErrorCodes.RUN_CANCELLED }
    if (slot.abortReason === 'deadline') return { state: 'failed', code: ErrorCodes.RUN_DEADLINE }
    if (err !== undefined) {
      const code = err instanceof KernelError ? err.code : ErrorCodes.RUN_INTERNAL
      return { state: 'failed', code }
    }
    return { state: 'succeeded' }
  }

  #settleEntry(entry: QueueEntry, outcome: RunOutcome): void {
    if (entry.settled) return
    entry.settled = true
    entry.settle(outcome)
  }

  #outcome(
    slot: ActiveSlot,
    state: RunOutcomeState,
    code?: string,
    result?: unknown,
    message?: string,
  ): RunOutcome {
    return {
      runId: slot.run.runId,
      agentId: this.agentId,
      state,
      code,
      result,
      message,
      attempts: 1,
      finishedAt: this.#now(),
    }
  }

  #plainOutcome(entry: QueueEntry, state: RunOutcomeState, code?: string): RunOutcome {
    return {
      runId: entry.runId,
      agentId: this.agentId,
      state,
      code,
      attempts: 1,
      finishedAt: this.#now(),
    }
  }
}

/** 只保留显式定义的键，避免 sparse 覆盖把策略值抹成 undefined */
function definedEntries(partial: Partial<RunPolicy> | undefined): Partial<RunPolicy> {
  if (!partial) return {}
  const out: Partial<RunPolicy> = {}
  if (partial.graceMs !== undefined) out.graceMs = partial.graceMs
  if (partial.deadlineMs !== undefined) out.deadlineMs = partial.deadlineMs
  return out
}
