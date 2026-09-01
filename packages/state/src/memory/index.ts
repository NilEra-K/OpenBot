/**
 * MemoryStore：agent 记忆（plan-backlog ①）——每 agent 独立 memory.json。
 * 语义边界（与 transcript 纪律明确区分并记档 plan-backlog）：transcript 是 append-only
 * 账本永不改写；**memory.json 是可演化的工作集**——agent 的自我笔记（一期只增不删，
 * 整理工具等真实遗忘需求再加——裁定 B）。读取端兼容：损坏文件降级空表 + console 告警
 * （不炸会话——手改/断电的记忆不该带崩 agent）。
 * 条目形状：{id, text, kind, createdAt, sourceMessageId?}——kind 是 agent 自分类
 * （事实/偏好/技能），呈现层照实展示不解释。
 */
import { KernelError } from '@openbot/core'
import type { FsAdapter } from '../fs/index.js'

export const MemoryErrorCodes = {
  /** 记忆条目文本为空或超长 */
  STATE_MEMORY_INVALID: 'STATE_MEMORY_INVALID',
} as const

/** 记忆条目单条上限（字符）——工具描述同步告知 agent（防爆库） */
export const MEMORY_TEXT_LIMIT = 500

export type MemoryKind = '事实' | '偏好' | '技能'

export interface MemoryEntry {
  id: string
  /** 一句自然语言（工具约定：重要事实才存、每条一句） */
  text: string
  kind: MemoryKind
  createdAt: number
  /** 来源消息（transcript 可溯源；工具调用上下文缺席则省略） */
  sourceMessageId?: string
}

export interface MemoryStoreOptions {
  fs: FsAdapter
  /** state root（与 AgentStore 同根——文件落 <root>/agents/<agentId>/memory.json） */
  root: string
  /** 条目 id 生成（缺省自增 m-1..n；注入可测） */
  nextId?: () => string
  now?: () => number
}

interface MemoryFile {
  version: 1
  entries: MemoryEntry[]
}

export class MemoryStore {
  readonly #fs: FsAdapter
  readonly #root: string
  readonly #nextId: () => string
  readonly #now: () => number
  #cache = new Map<string, MemoryEntry[]>()
  #loadedDirs = new Set<string>()

  constructor(options: MemoryStoreOptions) {
    this.#fs = options.fs
    this.#root = options.root
    this.#nextId = options.nextId ?? (() => `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`)
    this.#now = options.now ?? (() => 0)
  }

  /** 该 agent 的全部记忆（旧→新；未初始化的 agent 返回空数组——记忆目录按需创建） */
  async list(agentId: string): Promise<MemoryEntry[]> {
    await this.#load(agentId)
    return this.#cache.get(agentId)!.map((e) => ({ ...e }))
  }

  /** 预载到内存缓存（装配/addAgent 时调一次——此后 listSync 可同步读） */
  async ensureLoaded(agentId: string): Promise<void> {
    await this.#load(agentId)
  }

  /**
   * 同步读（systemPrompt 注入路径是同步签名——TurnRunner 的 (agentId)=>string）：
   * 读内存缓存（ensureLoaded/append 后即最新）；未加载的 agent 返回空（该轮不注入，
   * 下一轮 ensureLoaded 生效后自然带上——降级不阻塞）。
   */
  listSync(agentId: string): MemoryEntry[] {
    return (this.#cache.get(agentId) ?? []).map((e) => ({ ...e }))
  }

  /**
   * 追加一条（一期唯一写路径——裁定 B 只增不删）。不做去重（LLM 重复保存是预期噪声）；
   * 文本校验（空/超长拒绝——稳定码）。
   */
  async append(agentId: string, text: string, kind: MemoryKind = '事实', sourceMessageId?: string): Promise<MemoryEntry> {
    const trimmed = text.trim()
    if (trimmed === '' || trimmed.length > MEMORY_TEXT_LIMIT) {
      throw new KernelError(
        MemoryErrorCodes.STATE_MEMORY_INVALID,
        `记忆文本为空或超过 ${MEMORY_TEXT_LIMIT} 字符（当前 ${trimmed.length}）`,
      )
    }
    await this.#load(agentId)
    const entry: MemoryEntry = {
      id: this.#nextId(),
      text: trimmed,
      kind,
      createdAt: this.#now(),
      ...(sourceMessageId !== undefined ? { sourceMessageId } : {}),
    }
    const entries = this.#cache.get(agentId)!
    entries.push(entry)
    await this.#persist(agentId)
    return { ...entry }
  }

  /** #load：读 <root>/agents/<agentId>/memory.json；损坏降级空表（console 告警不抛） */
  async #load(agentId: string): Promise<void> {
    if (this.#loadedDirs.has(agentId)) return
    const path = this.#pathOf(agentId)
    let entries: MemoryEntry[] = []
    try {
      const raw = await this.#fs.read(path)
      if (raw !== null) {
        const parsed = JSON.parse(raw) as MemoryFile
        if (parsed && parsed.version === 1 && Array.isArray(parsed.entries)) {
          entries = parsed.entries
        } else {
          console.warn(`[openbot] memory.json 结构异常（${path}）——降级空表`)
        }
      }
    } catch (err) {
      console.warn(`[openbot] memory.json 读取失败（${path}）——降级空表：`, err instanceof Error ? err.message : err)
    }
    this.#cache.set(agentId, entries)
    this.#loadedDirs.add(agentId)
  }

  async #persist(agentId: string): Promise<void> {
    const file: MemoryFile = { version: 1, entries: this.#cache.get(agentId)! }
    await this.#fs.write(this.#pathOf(agentId), JSON.stringify(file, null, 2))
  }

  #pathOf(agentId: string): string {
    return `${this.#root}/agents/${agentId}/memory.json`
  }
}

/**
 * 会话装配的记忆注入节（backlog ① 裁定 A=字符预算）：`## 此前记忆` + 每行 `- [kind] text`。
 * 超预算从最旧截断（新记忆权重高——最近的行为模式更可能有效）+ 尾标注入条数（诚实截断）。
 * 空表返回空串（无记忆不注入空节——省 token）。纯函数可测；措辞是「你此前的笔记」
 * （记忆是 agent 自述工作集不是已验证事实——不冒充客观事实）。
 */
export function formatMemoryPrompt(entries: Array<Pick<MemoryEntry, 'kind' | 'text'>>, budgetChars = 2_000): string {
  if (entries.length === 0) return ''
  const lines: string[] = []
  let used = 0
  let taken = 0
  for (let i = entries.length - 1; i >= 0; i--) {
    const line = `- [${entries[i]!.kind}] ${entries[i]!.text}`
    if (used + line.length > budgetChars && taken > 0) break
    lines.unshift(line)
    used += line.length
    taken += 1
  }
  const omitted = entries.length - taken
  return ['## 此前记忆（你自己的笔记，可能过时，可召回核实）', ...lines, ...(omitted > 0 ? [`（更早的 ${omitted} 条未注入）`] : [])].join('\n')
}
