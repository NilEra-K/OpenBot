/**
 * AutomationStore + cron 纯函数（plan-backlog ②）——定时自动化：规则到点 → 以用户身份
 * 给指定 agent 发消息（复用 user lane 全管线——执行面零新路径）。
 * 持久化：全局 <root>/automations.json（规则跨 agent）；读取端兼容：损坏降级空表 + 告警。
 * cron 一期自研五段（分 时 日 月 周），不引库：支持 通配 / 步进 / 单值 / 范围 / 逗号列表——其余拒绝（稳定码）；
 * 错过的触发跳过不补跑（裁定 B——防应用关三天补三倍的量）；规则上限 16（裁定 C）。
 */
import { KernelError } from '@openbot/core'
import type { FsAdapter } from '../fs/index.js'

export const AutomationErrorCodes = {
  /** 规则字段非法（cron 解析失败/文本空超长/agentId 空） */
  STATE_AUTOMATION_INVALID: 'STATE_AUTOMATION_INVALID',
  /** 超过规则上限（裁定 C=16——朴素限流） */
  STATE_AUTOMATION_LIMIT: 'STATE_AUTOMATION_LIMIT',
  /** 规则不存在（remove/更新命中失败） */
  STATE_AUTOMATION_NOT_FOUND: 'STATE_AUTOMATION_NOT_FOUND',
} as const

/** 规则上限（裁定 C） */
export const AUTOMATION_LIMIT = 16
export const AUTOMATION_PROMPT_LIMIT = 2_000

export interface Automation {
  id: string
  /** 规则名（用户记名） */
  name: string
  /** 五段 cron：分 时 日 月 周（本机时区——桌面单机语义记档） */
  cron: string
  /** 目标 agent（触发时以用户身份发给它） */
  agentId: string
  /** 委托文本（用户预设——执行面就是一条用户消息） */
  prompt: string
  enabled: boolean
  createdAt: number
  /** 上次触发（计划时间戳——错过跳过语义下的呈现锚点）；从未跑过缺席 */
  lastRunAt?: number
}

export interface AutomationStoreOptions {
  fs: FsAdapter
  root: string
  now?: () => number
  /** id 生成（缺省时间+随机；注入可测） */
  nextId?: () => string
}

interface AutomationFile {
  version: 1
  automations: Automation[]
}

export class AutomationStore {
  readonly #fs: FsAdapter
  readonly #path: string
  readonly #now: () => number
  readonly #nextId: () => string
  #cache: Automation[] | null = null

  constructor(options: AutomationStoreOptions) {
    this.#fs = options.fs
    this.#path = `${options.root}/automations.json`
    this.#now = options.now ?? (() => 0)
    this.#nextId = options.nextId ?? (() => `a-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`)
  }

  async list(): Promise<Automation[]> {
    await this.#load()
    return this.#cache!.map((a) => ({ ...a }))
  }

  /** 新建（id 服务端生成）；校验 cron 可解析 + prompt 非空 + 上限 */
  async add(input: Omit<Automation, 'id' | 'createdAt' | 'lastRunAt'>): Promise<Automation> {
    await this.#load()
    if (this.#cache!.length >= AUTOMATION_LIMIT) {
      throw new KernelError(AutomationErrorCodes.STATE_AUTOMATION_LIMIT, `规则上限 ${AUTOMATION_LIMIT} 条（裁定 C 朴素限流）`)
    }
    const automation: Automation = {
      id: this.#nextId(),
      name: validateName(input.name),
      cron: validateCron(input.cron),
      agentId: validateAgentId(input.agentId),
      prompt: validatePrompt(input.prompt),
      enabled: input.enabled,
      createdAt: this.#now(),
    }
    this.#cache!.push(automation)
    await this.#persist()
    return { ...automation }
  }

  /** 更新（name/cron/agentId/prompt/enabled 任一；lastRunAt 不在此面——Scheduler 内部维护） */
  async update(id: string, patch: Partial<Pick<Automation, 'name' | 'cron' | 'agentId' | 'prompt' | 'enabled'>>): Promise<Automation> {
    await this.#load()
    const idx = this.#cache!.findIndex((a) => a.id === id)
    if (idx < 0) throw new KernelError(AutomationErrorCodes.STATE_AUTOMATION_NOT_FOUND, `规则不存在：${id}`)
    const cur = this.#cache![idx]!
    const next: Automation = {
      ...cur,
      ...(patch.name !== undefined ? { name: validateName(patch.name) } : {}),
      ...(patch.cron !== undefined ? { cron: validateCron(patch.cron) } : {}),
      ...(patch.agentId !== undefined ? { agentId: validateAgentId(patch.agentId) } : {}),
      ...(patch.prompt !== undefined ? { prompt: validatePrompt(patch.prompt) } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    }
    this.#cache![idx] = next
    await this.#persist()
    return { ...next }
  }

  async remove(id: string): Promise<void> {
    await this.#load()
    const before = this.#cache!.length
    this.#cache! = this.#cache!.filter((a) => a.id !== id)
    if (this.#cache!.length === before) {
      throw new KernelError(AutomationErrorCodes.STATE_AUTOMATION_NOT_FOUND, `规则不存在：${id}`)
    }
    await this.#persist()
  }

  /** Scheduler 内部：触发落 lastRunAt（不走校验面——计划时间戳是内核事实） */
  async markRun(id: string, at: number): Promise<void> {
    await this.#load()
    const idx = this.#cache!.findIndex((a) => a.id === id)
    if (idx < 0) return // 已被删除的规则触发在途——静默收敛
    this.#cache![idx] = { ...this.#cache![idx]!, lastRunAt: at }
    await this.#persist()
  }

  async #load(): Promise<void> {
    if (this.#cache !== null) return
    let automations: Automation[] = []
    try {
      const raw = await this.#fs.read(this.#path)
      if (raw !== null) {
        const parsed = JSON.parse(raw) as AutomationFile
        if (parsed && parsed.version === 1 && Array.isArray(parsed.automations)) {
          automations = parsed.automations
        } else {
          console.warn(`[openbot] automations.json 结构异常——降级空表`)
        }
      }
    } catch (err) {
      console.warn('[openbot] automations.json 读取失败——降级空表：', err instanceof Error ? err.message : err)
    }
    this.#cache = automations
  }

  async #persist(): Promise<void> {
    const file: AutomationFile = { version: 1, automations: this.#cache! }
    await this.#fs.write(this.#path, JSON.stringify(file, null, 2))
  }
}

// ---- 字段校验（stable code） ----

function validateName(name: string): string {
  const t = name.trim()
  if (t === '' || t.length > 64) throw new KernelError(AutomationErrorCodes.STATE_AUTOMATION_INVALID, '规则名为空或超过 64 字符')
  return t
}

function validateAgentId(agentId: string): string {
  const t = agentId.trim()
  if (t === '' || t.length > 128) throw new KernelError(AutomationErrorCodes.STATE_AUTOMATION_INVALID, '目标 agent 为空或超长')
  return t
}

function validatePrompt(prompt: string): string {
  const t = prompt.trim()
  if (t === '' || t.length > AUTOMATION_PROMPT_LIMIT) {
    throw new KernelError(AutomationErrorCodes.STATE_AUTOMATION_INVALID, `委托文本为空或超过 ${AUTOMATION_PROMPT_LIMIT} 字符`)
  }
  return t
}

export function validateCron(cron: string): string {
  const parts = cron.trim().split(/\s+/)
  if (parts.length !== 5) {
    throw new KernelError(AutomationErrorCodes.STATE_AUTOMATION_INVALID, `cron 须为五段「分 时 日 月 周」（收到 ${parts.length} 段）`)
  }
  const bounds: Array<[number, number]> = [
    [0, 59],
    [0, 23],
    [1, 31],
    [1, 12],
    [0, 6],
  ]
  parts.forEach((p, i) => {
    if (!parseField(p, bounds[i]!)) {
      throw new KernelError(AutomationErrorCodes.STATE_AUTOMATION_INVALID, `cron 第 ${i + 1} 段「${p}」不合法（支持 * / */n / a / a-b / a,b）`)
    }
  })
  return parts.join(' ')
}

// ---- cron 纯函数（解析 + 匹配 + 下次触发） ----

/** 一段的匹配集合（Set of 合法值；null=解析失败） */
function parseField(field: string, [lo, hi]: [number, number]): Set<number> | null {
  const out = new Set<number>()
  for (const part of field.split(',')) {
    const stepMatch = /^\*\/(\d+)$/.exec(part)
    const rangeMatch = /^(\d+)-(\d+)$/.exec(part)
    const singleMatch = /^(\d+)$/.exec(part)
    if (part === '*') {
      for (let v = lo; v <= hi; v++) out.add(v)
    } else if (stepMatch !== null) {
      const step = Number(stepMatch[1])
      if (step < 1) return null
      for (let v = lo; v <= hi; v += step) out.add(v)
    } else if (rangeMatch !== null) {
      const a = Number(rangeMatch[1])
      const b = Number(rangeMatch[2])
      if (a > b || a < lo || b > hi) return null
      for (let v = a; v <= b; v++) out.add(v)
    } else if (singleMatch !== null) {
      const v = Number(singleMatch[1])
      if (v < lo || v > hi) return null
      out.add(v)
    } else {
      return null
    }
  }
  return out
}

/** 预解析形状（Scheduler 复用——避免每分钟重解析） */
export interface ParsedCron {
  minute: Set<number>
  hour: Set<number>
  day: Set<number>
  month: Set<number>
  dow: Set<number>
}

export function parseCron(cron: string): ParsedCron | null {
  const parts = cron.trim().split(/\s+/)
  if (parts.length !== 5) return null
  const bounds: Array<[number, number]> = [
    [0, 59],
    [0, 23],
    [1, 31],
    [1, 12],
    [0, 6],
  ]
  const sets = parts.map((p, i) => parseField(p, bounds[i]!))
  if (sets.some((s) => s === null)) return null
  const [minute, hour, day, month, dow] = sets as Array<Set<number>>
  return { minute: minute!, hour: hour!, day: day!, month: month!, dow: dow! }
}

/** 匹配判定（经典 cron 日/周 OR 语义：两者都限定时任一命中即匹配） */
export function cronMatches(p: ParsedCron, at: Date): boolean {
  if (!p.minute.has(at.getMinutes()) || !p.hour.has(at.getHours()) || !p.month.has(at.getMonth() + 1)) return false
  const dayLimited = p.day.size !== 31
  const dowLimited = p.dow.size !== 7
  const dayHit = p.day.has(at.getDate())
  const dowHit = p.dow.has(at.getDay())
  if (dayLimited && dowLimited) return dayHit || dowHit
  return dayHit && dowHit
}

/**
 * 下一个触发点（epoch ms；从 fromMs 之后一分钟起逐分钟扫描）。
 * 返回 null = 规则永不触发（如「0 0 30 2 *」2 月 30 日——扫描上限 400 天找不到）。
 */
export function nextAfter(cron: string, fromMs: number): number | null {
  const p = parseCron(cron)
  if (p === null) return null
  const start = new Date(Math.floor(fromMs / 60_000) * 60_000 + 60_000)
  start.setSeconds(0, 0)
  const limitMinutes = 400 * 24 * 60
  for (let i = 0; i < limitMinutes; i++) {
    const t = new Date(start.getTime() + i * 60_000)
    if (cronMatches(p, t)) return t.getTime()
  }
  return null
}
