/**
 * transcript JSONL：append-only、崩溃安全、可 grep——源头真相
 * 铁律：只追加、永不就地改写历史（CLAUDE.md 持久化约束；崩溃后按行重放，残缺尾行丢弃）
 */
import type { FsAdapter } from '../fs/index.js'

export interface TranscriptRecord {
  /** agent 内单调递增 */
  seq: number
  /** 逻辑时钟 ms（注入） */
  at: number
  /** 记录种类（'user' | 'agent' | 'a2a-in' | 'a2a-out' | …，领域自定） */
  kind: string
  payload: unknown
}

export interface TranscriptStoreOptions {
  fs: FsAdapter
  /** 根目录；实际文件 <root>/agents/<agentId>/transcript.jsonl */
  root: string
  now: () => number
}

interface AgentState {
  records: TranscriptRecord[]
  lastSeq: number
  loaded: boolean
}

export class TranscriptStore {
  readonly #fs: FsAdapter
  readonly #root: string
  readonly #now: () => number
  readonly #cache = new Map<string, AgentState>()

  constructor(options: TranscriptStoreOptions) {
    this.#fs = options.fs
    this.#root = options.root
    this.#now = options.now
  }

  /** 追加一条记录（先落盘后返回；崩溃时至多多出残缺尾行，重放时丢弃） */
  async append(agentId: string, kind: string, payload: unknown): Promise<TranscriptRecord> {
    const state = await this.#ensure(agentId)
    const record: TranscriptRecord = { seq: state.lastSeq + 1, at: this.#now(), kind, payload }
    state.lastSeq = record.seq
    state.records.push(record)
    await this.#fs.append(this.#path(agentId), `${JSON.stringify(record)}\n`)
    return record
  }

  /** 重放该 agent 全部记录（拷贝，调用方不可变更有据可查的历史） */
  async readAll(agentId: string): Promise<TranscriptRecord[]> {
    const state = await this.#ensure(agentId)
    return [...state.records]
  }

  /** 最近 n 条（渲染层「最新会话」用，从尾往前取） */
  async readRecent(agentId: string, n: number): Promise<TranscriptRecord[]> {
    const state = await this.#ensure(agentId)
    return state.records.slice(-n)
  }

  async #ensure(agentId: string): Promise<AgentState> {
    let state = this.#cache.get(agentId)
    if (!state) {
      state = { records: [], lastSeq: 0, loaded: false }
      this.#cache.set(agentId, state)
    }
    if (state.loaded) return state
    const raw = await this.#fs.read(this.#path(agentId))
    if (raw !== null) {
      for (const line of raw.split('\n')) {
        if (line.trim() === '') continue
        // 残缺尾行（崩溃残留）直接丢弃：JSONL 容错重放
        let record: TranscriptRecord
        try {
          record = JSON.parse(line) as TranscriptRecord
        } catch {
          continue
        }
        state.records.push(record)
        state.lastSeq = Math.max(state.lastSeq, record.seq)
      }
    }
    state.loaded = true
    return state
  }

  #path(agentId: string): string {
    return `${this.#root}/agents/${agentId}/transcript.jsonl`
  }
}
