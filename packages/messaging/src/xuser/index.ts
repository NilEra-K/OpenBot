/**
 * 跨用户房间（P7）：CrossUserRelay 的协议层——信封（zod）、预算账本、nonce 幂等表、退避策略。
 * §3.5 协议保留行的兑现：turn-request/result（远端触达本端执行面的唯一通道——mirror 一期
 * 语义，远端不能投递任意消息）、10 分钟窗口 30 turn 预算（host 侧账本单一事实源——双端记账
 * 必双花）、不可达退避（指数 + jitter）、nonce 幂等（重放不双花）。
 * 纯函数/纯类零 IO：host（apps/relay）与桌面接入（RelayClient）两侧共享同一语义，
 * 时钟与随机源注入可测（客户端时钟不可信——预算判定只发生在 host 侧）。
 * 参考：ARCHITECTURE.md §3.5、PRODUCT.md「hosted/mirror、远端 mirror 成员、预算、幂等」。
 */
import { z } from 'zod'

export const XuserErrorCodes = {
  /** 房间不存在（码错误或已回收） */
  XUSER_ROOM_NOT_FOUND: 'XUSER_ROOM_NOT_FOUND',
  /** invite 码/成员凭据校验失败 */
  XUSER_AUTH_FAILED: 'XUSER_AUTH_FAILED',
  /** 预算耗尽（窗口内 turn 数达上限） */
  XUSER_BUDGET_EXHAUSTED: 'XUSER_BUDGET_EXHAUSTED',
  /** 限速（消息频率超限） */
  XUSER_RATE_LIMITED: 'XUSER_RATE_LIMITED',
  /** 线上信封不合法（schema 拒收——公网输入不可信的第一道防线） */
  XUSER_PAYLOAD_INVALID: 'XUSER_PAYLOAD_INVALID',
} as const

/** 预算缺省（§3.5 原文：10 分钟窗口 30 turn） */
export const XUSER_DEFAULT_BUDGET = { windowMs: 10 * 60_000, maxTurns: 30 } as const

// ---- 线上信封（host 与两端共享的协议形状；strict 拒未知字段） ----

/** 标识形状：memberId/requestId/nonce 都是短 ASCII（防注入与膨胀） */
const idShape = z.string().regex(/^[a-zA-Z0-9:_#-]{1,128}$/)
/** 文本上限：单条 8k 字符（公网面的消息大小纪律之一） */
const textShape = z.string().min(1).max(8_000)

/** mirror 消息（端 → 房间广播）：本端对话事件的只读镜像 */
export const mirrorMessageSchema = z
  .object({
    kind: z.literal('mirror-message'),
    nonce: idShape,
    fromMemberId: idShape,
    /** 发言者：'user' 或本端 agent 显示名（远端呈现用——不带本地 agentId 内部标识） */
    speakerKind: z.enum(['user', 'agent']),
    speakerName: z.string().min(1).max(64),
    text: textShape,
    /** 发送端时间戳（仅呈现排序用；预算判定一律 host 时钟） */
    sentAt: z.number().int().nonnegative(),
  })
  .strict()

/** turn 请求（端 A → host 路由 → 端 B）：远端触达 B 端执行面的唯一通道 */
export const turnRequestSchema = z
  .object({
    kind: z.literal('turn-request'),
    nonce: idShape,
    /** turn 生命周期 id（result 配对键） */
    requestId: idShape,
    fromMemberId: idShape,
    toMemberId: idShape,
    prompt: textShape,
    /** 期望 agent 显示名（可选——B 端 steward 调度参考，不构成特权路由） */
    agentHint: z.string().min(1).max(64).optional(),
    sentAt: z.number().int().nonnegative(),
  })
  .strict()

/** turn 结果（端 B → host 路由 → 端 A）：status 是领域事实，文案归发起端渲染 */
export const turnResultSchema = z
  .object({
    kind: z.literal('turn-result'),
    requestId: idShape,
    fromMemberId: idShape,
    status: z.enum(['ok', 'rejected', 'timeout', 'budget-exhausted', 'unreachable']),
    text: textShape,
    /** 请求方向余量（host 随 result 下发——客户端不本地推算） */
    remaining: z.number().int().nonnegative().optional(),
  })
  .strict()

export const envelopeSchema = z.discriminatedUnion('kind', [
  mirrorMessageSchema,
  turnRequestSchema,
  turnResultSchema,
])

export type MirrorMessage = z.infer<typeof mirrorMessageSchema>
export type TurnRequest = z.infer<typeof turnRequestSchema>
export type TurnResult = z.infer<typeof turnResultSchema>
export type XuserEnvelope = z.infer<typeof envelopeSchema>
export type TurnResultStatus = TurnResult['status']

// ---- server → client 消息（host 单向下发；客户端不构造——schema 供客户端侧校验用） ----

/** 入场回执：自身 memberId + 房间全量（成员快照） */
export const helloSchema = z
  .object({
    kind: z.literal('hello'),
    memberId: idShape,
    room: z.object({
      roomId: z.string().min(1),
      createdAt: z.number().int().nonnegative(),
      members: z.array(
        z.object({
          memberId: idShape,
          displayName: z.string().min(1).max(64),
          connected: z.boolean(),
        }),
      ),
    }),
  })
  .strict()

/** 成员在场变化（远端 mirror 成员的名册投影源） */
export const roomEventSchema = z
  .object({
    kind: z.literal('room-event'),
    event: z.enum(['member-joined', 'member-left']),
    memberId: idShape,
    displayName: z.string().min(1).max(64),
  })
  .strict()

export const serverMessageSchema = z.discriminatedUnion('kind', [
  helloSchema,
  roomEventSchema,
  mirrorMessageSchema,
  turnRequestSchema,
  turnResultSchema,
])

export type Hello = z.infer<typeof helloSchema>
export type RoomEvent = z.infer<typeof roomEventSchema>
export type ServerMessage = z.infer<typeof serverMessageSchema>

// ---- 房间与成员（host 侧状态的形状；客户端呈现同源） ----

export interface RoomMemberInfo {
  memberId: string
  displayName: string
  connected: boolean
}

export interface RoomInfo {
  roomId: string
  createdAt: number
  members: RoomMemberInfo[]
}

// ---- 预算账本（host 单一事实源） ----

export interface TurnBudgetConfig {
  windowMs: number
  maxTurns: number
}

export interface BudgetVerdict {
  ok: boolean
  /** 窗口内剩余可发起数（耗尽为 0） */
  remaining: number
}

/**
 * 滚动窗口预算：每「请求方向」（`fromMemberId->toMemberId`）独立计数——
 * 防单成员对单端滥用；互不同方向的预算互不挤占。
 * admit 是唯一写入口（判定与记录原子）；now 一律 host 时钟。
 */
export class TurnBudgetLedger {
  readonly #config: TurnBudgetConfig
  readonly #hits = new Map<string, number[]>()

  constructor(config: TurnBudgetConfig = XUSER_DEFAULT_BUDGET) {
    this.#config = config
  }

  /** 判定并记账：窗口外时间戳先行滚出 → 余量判定 → 命中追加。耗尽时不记录（拒绝不占预算） */
  admit(key: string, now: number): BudgetVerdict {
    const verdict = this.peek(key, now)
    if (!verdict.ok) return verdict
    const hits = this.#sweep(key, now)
    hits.push(now)
    this.#hits.set(key, hits)
    return { ok: true, remaining: verdict.remaining - 1 }
  }

  /** 只读查询余量（result 随附下发用） */
  peek(key: string, now: number): BudgetVerdict {
    const hits = this.#sweep(key, now)
    const used = hits.length
    return { ok: used < this.#config.maxTurns, remaining: Math.max(0, this.#config.maxTurns - used) }
  }

  /** 滚出窗口外时间戳（就地清理，返回窗口内命中序列） */
  #sweep(key: string, now: number): number[] {
    const hits = (this.#hits.get(key) ?? []).filter((t) => now - t < this.#config.windowMs)
    if (hits.length === 0) this.#hits.delete(key)
    else this.#hits.set(key, hits)
    return hits
  }
}

// ---- nonce 幂等表（host 侧） ----

/** 已结算的 turn 结果（重放同 nonce 直接回缓存——发起端重试拿到同一应答） */
export interface SettledTurn {
  status: TurnResultStatus
  text: string
}

/**
 * turn-request 的结算账：start 占位（首见 true）→ settle 落缓存。
 * 条目保留窗口时长后可清（重放语义与预算窗口对齐）；未结算的占位同样随清理释放
 * （执行端崩溃留下的悬空占位不永久阻塞该 nonce）。
 */
export class TurnIdempotency {
  readonly #retainMs: number
  readonly #started = new Map<string, number>()
  readonly #settled = new Map<string, { at: number; result: SettledTurn }>()

  constructor(retainMs: number = XUSER_DEFAULT_BUDGET.windowMs) {
    this.#retainMs = retainMs
  }

  /** 首见占位（true=首次受理；false=重放——调用方查缓存回放） */
  start(nonce: string, now: number): boolean {
    this.sweep(now)
    if (this.#started.has(nonce) || this.#settled.has(nonce)) return false
    this.#started.set(nonce, now)
    return true
  }

  settle(nonce: string, now: number, result: SettledTurn): void {
    this.#settled.set(nonce, { at: now, result })
    this.#started.delete(nonce)
  }

  /** 已结算结果（重放回放）；未结算返回 undefined（进行中或未知） */
  get(nonce: string): SettledTurn | undefined {
    return this.#settled.get(nonce)?.result
  }

  /** 滚出保留期外的结算与占位（调用方周期或随手上清） */
  sweep(now: number): void {
    for (const [nonce, at] of this.#started) if (now - at > this.#retainMs) this.#started.delete(nonce)
    for (const [nonce, entry] of this.#settled) if (now - entry.at > this.#retainMs) this.#settled.delete(nonce)
  }
}

// ---- 不可达退避（指数 + jitter——host 断连时客户端重连、出站请求重试共用） ----

export interface BackoffOptions {
  /** 首次延迟基数（默认 1s） */
  baseMs?: number
  /** 延迟上限（默认 5min——重连风暴上限的一半纪律） */
  maxMs?: number
  /** 乘性抖动幅度 [0,1)（默认 0.2——多客户端同时断连不打挂 host 的关键） */
  jitterRatio?: number
  /** 随机源注入（可测；默认 Math.random） */
  rand?: () => number
}

/**
 * 第 attempt 次失败后的下次重试延迟（attempt 从 1 起）：
 * `min(base * 2^(attempt-1), max) * (1 + jitterRatio * (2*rand - 1))` —— 指数爬升封顶 +
 * 对称乘性抖动。纯函数：host/客户端两侧同一策略（语义同源不二套）。
 */
export function backoffDelay(attempt: number, options: BackoffOptions = {}): number {
  const baseMs = options.baseMs ?? 1_000
  const maxMs = options.maxMs ?? 5 * 60_000
  const jitterRatio = options.jitterRatio ?? 0.2
  const rand = options.rand ?? Math.random
  const step = Math.min(baseMs * 2 ** Math.max(0, attempt - 1), maxMs)
  const jitter = 1 + jitterRatio * (2 * rand() - 1)
  return Math.max(0, Math.round(step * jitter))
}
