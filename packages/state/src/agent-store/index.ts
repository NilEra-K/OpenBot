/**
 * agent 名册与目录：profile.json（含 role：steward 管家 / worker 工人，默认 worker）
 * 任命/罢免/转移为排他事务（内存互斥锁串行）——全局唯一 steward 不变量在此强制：
 * 同一名册内第二个任命直接拒绝（ARCHITECTURE.md §3.2、§3.5）。
 * 本模块只管存储不变量，不发事件（v1.system.roster 由上层接线发出）。
 */
import { KernelError } from '@openbot/core'
import type { FsAdapter } from '../fs/index.js'

export const AgentStoreErrorCodes = {
  STATE_AGENT_EXISTS: 'STATE_AGENT_EXISTS',
  STATE_AGENT_NOT_FOUND: 'STATE_AGENT_NOT_FOUND',
  /** 唯一管家不变量：已有 steward 时再任命直接拒绝（用户须先 dismiss/transfer） */
  STATE_STEWARD_EXISTS: 'STATE_STEWARD_EXISTS',
  STATE_NOT_STEWARD: 'STATE_NOT_STEWARD',
} as const

export type AgentRole = 'steward' | 'worker'

export interface AgentProfile {
  agentId: string
  name: string
  role: AgentRole
  createdAt: number
  /** 身份色（hex，P4 Step 5）：可选——缺席由渲染端回退哈希派生色（版本号+读取端兼容，零迁移） */
  color?: string
  /** 模型覆盖（backlog ③）：引用 providers 档案名——未指定继承全局主力；悬空在装配层
   *  如实降级回继承（不炸装配——与沙箱 mock 回退同哲学）；版本号+读取端兼容零迁移 */
  modelProvider?: string
  /** 镜像绑定（plan-image-firstclass P8-4）：引用镜像条目 id——未指定用默认沙箱；悬空在
   *  装配层如实降级回默认（console 告警——modelProvider 悬空双语义同款）；版本号+读取端兼容 */
  imageId?: string
  /** 人设（2026-10-18 身份修复）：身份描述一句话——注入系统提示词（自称/职责边界），
   *  群聊不再冒充管家；可选，版本号+读取端兼容零迁移 */
  persona?: string
  /** 角色档位名（2026-10-18 自定义角色）：创建时选中的档位（内置四角色或用户模板）——
   *  呈现用（ctx 档案/名册）；权限语义恒在 role 字段；可选，零迁移 */
  roleName?: string
}

export interface AgentStoreOptions {
  fs: FsAdapter
  root: string
  now: () => number
}

export class AgentStore {
  readonly #fs: FsAdapter
  readonly #root: string
  readonly #now: () => number
  readonly #profiles = new Map<string, AgentProfile>()
  #loaded = false
  /** 排他变更锁：所有变更类操作串行（async 互斥，不变量检查与落盘不与他人交错） */
  #lock: Promise<unknown> = Promise.resolve()

  constructor(options: AgentStoreOptions) {
    this.#fs = options.fs
    this.#root = options.root
    this.#now = options.now
  }

  /** 注册：一律 worker（steward 只能经任命事务产生）；重名拒绝；color/persona 可选（身份档案事实） */
  async register(agentId: string, name?: string, color?: string, modelProvider?: string, imageId?: string, persona?: string, roleName?: string): Promise<AgentProfile> {
    return this.#withLock(async () => {
      await this.#load()
      if (this.#profiles.has(agentId)) {
        throw new KernelError(AgentStoreErrorCodes.STATE_AGENT_EXISTS, `agent 已存在：${agentId}`)
      }
      const profile: AgentProfile = {
        agentId,
        name: name ?? agentId,
        role: 'worker',
        createdAt: this.#now(),
        ...(color !== undefined ? { color } : {}),
        ...(modelProvider !== undefined && modelProvider !== '' ? { modelProvider } : {}),
        ...(imageId !== undefined && imageId !== '' ? { imageId } : {}),
        ...(persona !== undefined && persona.trim() !== '' ? { persona: persona.trim() } : {}),
        ...(roleName !== undefined && roleName.trim() !== '' ? { roleName: roleName.trim() } : {}),
      }
      this.#profiles.set(agentId, profile)
      await this.#persist(profile)
      return { ...profile }
    })
  }

  /** 更新模型覆盖（backlog ③）：null = 清除（回继承全局主力） */
  async setModelProvider(agentId: string, modelProvider: string | null): Promise<AgentProfile> {
    return this.#withLock(async () => {
      await this.#load()
      const profile = this.#profiles.get(agentId)
      if (!profile) {
        throw new KernelError(AgentStoreErrorCodes.STATE_AGENT_NOT_FOUND, `agent 不存在：${agentId}`)
      }
      const next: AgentProfile =
        modelProvider === null || modelProvider === ''
          ? (() => {
              const { modelProvider: _drop, ...rest } = profile
              return rest
            })()
          : { ...profile, modelProvider }
      this.#profiles.set(agentId, next)
      await this.#persist(next)
      return { ...next }
    })
  }

  /** 更新人设（2026-10-18 身份修复）：null = 清除；即时生效（提示词每轮取档案真相） */
  async setPersona(agentId: string, persona: string | null): Promise<AgentProfile> {
    return this.#withLock(async () => {
      await this.#load()
      const profile = this.#profiles.get(agentId)
      if (!profile) {
        throw new KernelError(AgentStoreErrorCodes.STATE_AGENT_NOT_FOUND, `agent 不存在：${agentId}`)
      }
      const next: AgentProfile =
        persona === null || persona.trim() === ''
          ? (() => {
              const { persona: _drop, ...rest } = profile
              return rest
            })()
          : { ...profile, persona: persona.trim() }
      this.#profiles.set(agentId, next)
      await this.#persist(next)
      return { ...next }
    })
  }

  /** 更新镜像绑定（P8-4）：null = 清除（回默认沙箱） */
  async setImage(agentId: string, imageId: string | null): Promise<AgentProfile> {
    return this.#withLock(async () => {
      await this.#load()
      const profile = this.#profiles.get(agentId)
      if (!profile) {
        throw new KernelError(AgentStoreErrorCodes.STATE_AGENT_NOT_FOUND, `agent 不存在：${agentId}`)
      }
      const next: AgentProfile =
        imageId === null || imageId === ''
          ? (() => {
              const { imageId: _drop, ...rest } = profile
              return rest
            })()
          : { ...profile, imageId }
      this.#profiles.set(agentId, next)
      await this.#persist(next)
      return { ...next }
    })
  }

  /** 删除：steward 被删除 → 名册进入空缺态（不自动提拔，用户主权） */
  async remove(agentId: string): Promise<void> {
    return this.#withLock(async () => {
      await this.#load()
      if (!this.#profiles.has(agentId)) {
        throw new KernelError(AgentStoreErrorCodes.STATE_AGENT_NOT_FOUND, `agent 不存在：${agentId}`)
      }
      this.#profiles.delete(agentId)
      await this.#fs.remove(this.#path(agentId))
    })
  }

  async get(agentId: string): Promise<AgentProfile | null> {
    await this.#load()
    const profile = this.#profiles.get(agentId)
    return profile ? { ...profile } : null
  }

  async list(): Promise<AgentProfile[]> {
    await this.#load()
    return [...this.#profiles.values()]
      .map((p) => ({ ...p }))
      .sort((a, b) => (a.createdAt !== b.createdAt ? a.createdAt - b.createdAt : a.agentId < b.agentId ? -1 : 1))
  }

  /** 任命 steward：他人已在位直接拒绝；同一人重复任命幂等 */
  async appointSteward(agentId: string): Promise<AgentProfile> {
    return this.#withLock(async () => {
      await this.#load()
      const profile = this.#require(agentId)
      if (profile.role === 'steward') return { ...profile }
      const current = this.#findSteward()
      if (current) {
        throw new KernelError(
          AgentStoreErrorCodes.STATE_STEWARD_EXISTS,
          `管家已在位：${current.agentId}（须先罢免或转移）`,
        )
      }
      return this.#setRole(agentId, 'steward')
    })
  }

  /** 罢免 → 空缺态 */
  async dismissSteward(agentId: string): Promise<AgentProfile> {
    return this.#withLock(async () => {
      await this.#load()
      const profile = this.#require(agentId)
      if (profile.role !== 'steward') {
        throw new KernelError(AgentStoreErrorCodes.STATE_NOT_STEWARD, `${agentId} 不是管家`)
      }
      return this.#setRole(agentId, 'worker')
    })
  }

  /** 转移：单事务内 from → worker、to → steward（不变量全程不破）
   *  崩溃窗口说明：先落 from=worker 再落 to=steward——中途崩溃最多退化为空缺态，绝不出现双管家 */
  async transferSteward(fromAgentId: string, toAgentId: string): Promise<{ from: AgentProfile; to: AgentProfile }> {
    return this.#withLock(async () => {
      await this.#load()
      const from = this.#require(fromAgentId)
      const to = this.#require(toAgentId)
      if (from.role !== 'steward') {
        throw new KernelError(AgentStoreErrorCodes.STATE_NOT_STEWARD, `${fromAgentId} 不是管家`)
      }
      if (to.role === 'steward') return { from: { ...from }, to: { ...to } }
      const fromUpdated = await this.#setRole(fromAgentId, 'worker')
      const toUpdated = await this.#setRole(toAgentId, 'steward')
      return { from: fromUpdated, to: toUpdated }
    })
  }

  /** 当前 steward（空缺返回 null——空缺态由上层提示用户任命） */
  async findSteward(): Promise<AgentProfile | null> {
    await this.#load()
    const found = this.#findSteward()
    return found ? { ...found } : null
  }

  #findSteward(): AgentProfile | null {
    for (const profile of this.#profiles.values()) {
      if (profile.role === 'steward') return profile
    }
    return null
  }

  /** 排他变更锁临界区：变更串行执行；前序失败不阻断后续（错误只抛给各自调用方） */
  async #withLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#lock.then(fn, fn)
    this.#lock = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  #require(agentId: string): AgentProfile {
    const profile = this.#profiles.get(agentId)
    if (!profile) {
      throw new KernelError(AgentStoreErrorCodes.STATE_AGENT_NOT_FOUND, `agent 不存在：${agentId}`)
    }
    return profile
  }

  async #setRole(agentId: string, role: AgentRole): Promise<AgentProfile> {
    const profile = this.#require(agentId)
    const updated: AgentProfile = { ...profile, role }
    this.#profiles.set(agentId, updated)
    // 先写盘再返回：变更即持久
    await this.#persist(updated)
    return { ...updated }
  }

  async #persist(profile: AgentProfile): Promise<void> {
    await this.#fs.write(this.#path(profile.agentId), `${JSON.stringify(profile, null, 2)}\n`)
  }

  async #load(): Promise<void> {
    if (this.#loaded) return
    const agentsDir = `${this.#root}/agents`
    for (const agentId of await this.#fs.list(agentsDir)) {
      const raw = await this.#fs.read(`${agentsDir}/${agentId}/profile.json`)
      if (raw === null) continue
      try {
        const profile = JSON.parse(raw) as AgentProfile
        if (profile && typeof profile.agentId === 'string') {
          this.#profiles.set(profile.agentId, profile)
        }
      } catch {
        // 残缺 profile 跳过（重放容错，与 transcript 同策略）
      }
    }
    this.#loaded = true
  }

  #path(agentId: string): string {
    return `${this.#root}/agents/${agentId}/profile.json`
  }
}
