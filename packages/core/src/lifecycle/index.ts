/**
 * RunLifecycle：run 状态机、受理票据（ack 义务）、期限/逃逸/重试策略（纯数据与纯函数）
 * 参考：ARCHITECTURE.md §3.1；docs/plan-p1.md Step 1 设计要点。
 */

/** 排他调度三 lane：用户消息永远最先；同 lane FIFO */
export type Lane = 'user' | 'agent' | 'background'

/** run 终态（调度器视角的四种结局） */
export type RunOutcomeState = 'succeeded' | 'failed' | 'aborted' | 'escaped'

/** run 全状态（含中间态，供事件与查询用） */
export type RunState = 'queued' | 'running' | RunOutcomeState

/** run 结局。code 是稳定契约；message 仅进程内诊断，不进事件、不落盘 */
export interface RunOutcome {
  runId: string
  agentId: string
  state: RunOutcomeState
  /** 失败/中止/逃逸时的稳定错误 code */
  code?: string
  /** 进程内诊断信息（协议纯度：文案不进协议） */
  message?: string
  /** execute 的成功产物（领域自定义） */
  result?: unknown
  /** 重试计数：调度器恒为 1（无自动重试），重试循环归 runner，回喂时累加 */
  attempts: number
  finishedAt: number
}

/** 受理回执（ack 义务）：enqueue 同步返回，发送方永不悬挂；durable acceptance 由 state 账本落实 */
export interface RunAck {
  runId: string
  agentId: string
  acceptedAt: number
}

/** 受理票据 = 回执 + 结局交付 */
export interface RunTicket extends RunAck {
  settled: Promise<RunOutcome>
}

/** 期限与逃逸窗口：策略是数据，watchdog 驱动归装配方（真实=定时器，测试=手动 tick）。
 *  grace 判据为**无进展时长**（scheduler.touch 刷新——流事件/审批挂起都算进展；
 *  2026-09-06 语义升级：在动的 run 永不逃逸，对齐「停止只因为完成/报错/用户」的体验）；
 *  deadline 仍为总时长硬限（失控循环的终极兜底） */
export interface RunPolicy {
  /** watchdog 逃逸窗口：**无进展**超限后 settled 立即结算（发送永不悬挂），底层标记 zombie 等回收 */
  graceMs: number
  /** 硬期限：启动起总时长超限 abort，failed/RUN_DEADLINE */
  deadlineMs: number
}

export const DEFAULT_RUN_POLICY: RunPolicy = {
  graceMs: 120_000,
  deadlineMs: 600_000,
}

/** 重试策略：数据 + 纯函数；重试循环归 runner（调度器不自动重试） */
export interface RetryPolicy {
  maxRetries: number
  /** 第 attempt 次（1 起）重试前的等待毫秒；越界取末位 */
  backoffMs: number[]
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = { maxRetries: 0, backoffMs: [] }

/** 仅失败可重试；aborted 的续命是 messaging 的 at-least-once 重驱，不叫重试 */
export function shouldRetry(outcome: RunOutcome, policy: RetryPolicy): boolean {
  return outcome.state === 'failed' && outcome.attempts <= policy.maxRetries
}

/** 第 attempt 次（1 起）重试前应等待的毫秒数 */
export function nextRetryDelayMs(attempt: number, policy: RetryPolicy): number {
  if (policy.backoffMs.length === 0) return 0
  const idx = Math.min(Math.max(attempt - 1, 0), policy.backoffMs.length - 1)
  return policy.backoffMs[idx] ?? 0
}
