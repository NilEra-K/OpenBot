/**
 * 幂等账本：clientNonce + inputDigest——发送、任务提交、闸门审批三链路共用
 * （ARCHITECTURE.md §3.2、§3.6：账本被复用于审批闸门，重试不双弹窗、不双执行）。
 * begin 即 durable acceptance（发送与执行解耦）；commit 记录首次结局，重试直接回放。
 * nonce 由调用方生成并保证全局唯一（建议前缀分链路：'msg:' / 'task:' / 'approval:'）。
 */
import { KernelError } from '@openbot/core'
import type { FsAdapter } from '../fs/index.js'

export const LedgerErrorCodes = {
  /** 同一 nonce 换了输入——疑似重放错配，拒绝 */
  LEDGER_DIGEST_MISMATCH: 'LEDGER_DIGEST_MISMATCH',
  /** commit 了从未 begin 过的 nonce */
  LEDGER_NONCE_NOT_FOUND: 'LEDGER_NONCE_NOT_FOUND',
} as const

export type LedgerStatus = 'pending' | 'done'

export interface LedgerEntry {
  nonce: string
  digest: string
  status: LedgerStatus
  /** 首次执行结局（重试回放用） */
  outcome?: unknown
  at: number
}

export interface LedgerBeginResult {
  /** true = 首次受理（应执行）；false = 重试（不可再执行，等/取首次结局） */
  first: boolean
  entry: LedgerEntry
}

export interface IdempotencyLedgerOptions {
  fs: FsAdapter
  root: string
  now: () => number
  /** 分账本名（默认 'default'）；nonce 全局唯一时分不分文件皆可 */
  name?: string
}

export class IdempotencyLedger {
  readonly #fs: FsAdapter
  readonly #now: () => number
  readonly #path: string
  readonly #entries = new Map<string, LedgerEntry>()
  #loaded = false

  constructor(options: IdempotencyLedgerOptions) {
    this.#fs = options.fs
    this.#now = options.now
    this.#path = `${options.root}/ledger/${options.name ?? 'default'}.jsonl`
  }

  /**
   * 受理：durable acceptance。同 nonce 同 digest 重试返回 first:false（零双发）；
   * 同 nonce 不同 digest 抛 LEDGER_DIGEST_MISMATCH。
   */
  async begin(nonce: string, digest: string): Promise<LedgerBeginResult> {
    await this.#load()
    const existing = this.#entries.get(nonce)
    if (existing) {
      if (existing.digest !== digest) {
        throw new KernelError(
          LedgerErrorCodes.LEDGER_DIGEST_MISMATCH,
          `nonce 已用于不同输入：${nonce}`,
        )
      }
      return { first: false, entry: { ...existing } }
    }
    const entry: LedgerEntry = { nonce, digest, status: 'pending', at: this.#now() }
    this.#entries.set(nonce, entry)
    await this.#fs.append(this.#path, `${JSON.stringify(entry)}\n`)
    return { first: true, entry: { ...entry } }
  }

  /** 提交首次结局；重复 commit 幂等（append-only，首次结局不被改写） */
  async commit(nonce: string, outcome: unknown): Promise<LedgerEntry> {
    await this.#load()
    const existing = this.#entries.get(nonce)
    if (!existing) {
      throw new KernelError(LedgerErrorCodes.LEDGER_NONCE_NOT_FOUND, `未知 nonce：${nonce}`)
    }
    if (existing.status === 'done') return { ...existing }
    const entry: LedgerEntry = { ...existing, status: 'done', outcome }
    this.#entries.set(nonce, entry)
    await this.#fs.append(this.#path, `${JSON.stringify(entry)}\n`)
    return { ...entry }
  }

  async lookup(nonce: string): Promise<LedgerEntry | null> {
    await this.#load()
    const entry = this.#entries.get(nonce)
    return entry ? { ...entry } : null
  }

  /** 前缀过滤的挂起项（崩溃恢复扫描用；如审批闸门 'approval:' 前缀——重启后重发 requested） */
  async listPending(prefix?: string): Promise<LedgerEntry[]> {
    await this.#load()
    const result: LedgerEntry[] = []
    for (const entry of this.#entries.values()) {
      if (entry.status !== 'pending') continue
      if (prefix !== undefined && !entry.nonce.startsWith(prefix)) continue
      result.push({ ...entry })
    }
    return result
  }

  async #load(): Promise<void> {
    if (this.#loaded) return
    const raw = await this.#fs.read(this.#path)
    if (raw !== null) {
      for (const line of raw.split('\n')) {
        if (line.trim() === '') continue
        let entry: LedgerEntry
        try {
          entry = JSON.parse(line) as LedgerEntry
        } catch {
          continue
        }
        // 重放语义：同 nonce 后行覆盖前行（pending → done）
        this.#entries.set(entry.nonce, entry)
      }
    }
    this.#loaded = true
  }
}

/**
 * 输入摘要：P1 用稳定序列化（键序即调用方书写序）；接入真实多方输入时换 sha256。
 * 只要「同一调用点对同一输入产出同一字符串」，账本语义即成立。
 */
export function digestOf(input: unknown): string {
  return JSON.stringify(input) ?? 'null'
}
