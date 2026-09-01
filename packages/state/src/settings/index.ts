/**
 * 应用级设置：provider 档案（baseUrl/model/key/代理）、默认 provider——平铺 JSON（<root>/settings.json）。
 * API key 密文落盘、明文只在进程内：加密/解密经注入回调（桌面接 Electron safeStorage/DPAPI，测试恒等）。
 * 跨边界不给密钥：list()/展示形状只带 hasKey，key 材料永不出本模块。
 * schema 演进：版本号 + 读取端兼容（CLAUDE.md 持久化约束）。
 */
import { KernelError } from '@openbot/core'
import type { FsAdapter } from '../fs/index.js'

export const SettingsErrorCodes = {
  SETTINGS_PROVIDER_NOT_FOUND: 'SETTINGS_PROVIDER_NOT_FOUND',
  SETTINGS_NO_DEFAULT_PROVIDER: 'SETTINGS_NO_DEFAULT_PROVIDER',
} as const

/** 协议族：openai-compat（chat completions 兼容面）/ anthropic（messages API）；缺省前者（旧档案读取端兼容） */
export type ProviderProtocol = 'openai-compat' | 'anthropic'

/** 存储形状：apiKey 恒为密文 */
export interface StoredProviderProfile {
  name: string
  baseUrl: string
  model: string
  /** 密文（加密回调的输出原样） */
  apiKey?: string
  headers?: Record<string, string>
  proxyUrl?: string
  temperature?: number
  timeoutMs?: number
  /** 协议族（P4 Step 11）；缺省 openai-compat */
  protocol?: ProviderProtocol
}

/** 沙箱后端偏好：auto = 按平台序择优（win: wsl→docker→podman / linux: nspawn→docker→podman /
 *  mac: utm→docker→podman，P6 Step 5），不可用如实回退 */
export type SandboxPreference = 'auto' | 'mock' | 'wsl' | 'docker' | 'podman' | 'nspawn' | 'utm'

/** 跨用户房间接入（P7）：mirror 一期——本端对话镜像外流 + 远端 turn-request 受控进入。
 *  enabled 且 url/roomId/inviteCode 非空才装配（装配期决策，改动重启生效——与沙箱偏好同语义） */
export interface RelaySettings {
  enabled: boolean
  /** host WS 地址（ws://host:port） */
  url: string
  roomId: string
  inviteCode: string
  /** 本端在房间的呈现名 */
  displayName: string
  /** 房间备注名（可选——呈现层记名，缺省显示房间码） */
  roomName?: string
}

export interface AppSettings {
  version: 1
  defaultProvider?: string
  providers: StoredProviderProfile[]
  /** 沙箱后端偏好；缺省 auto（可选字段：旧文件读取端兼容，version 不动） */
  sandbox?: SandboxPreference
  /** 跨用户房间接入（P7）；可选字段（旧文件兼容） */
  relay?: RelaySettings
  /** 全局回退端点（P4 Step 11）：引用 providers 内档案名；主力请求失败时本轮降级，下轮自动回主力（不粘滞） */
  fallbackProvider?: string
}

/** 展示形状：给 renderer/命令面，绝无 key 材料 */
export interface ProviderProfileView {
  name: string
  baseUrl: string
  model: string
  hasKey: boolean
  proxyUrl?: string
  protocol?: ProviderProtocol
}

/** 解析形状：装配 provider 用，apiKey 为明文 */
export interface ResolvedProvider {
  name: string
  baseUrl: string
  model: string
  apiKey?: string
  headers?: Record<string, string>
  proxyUrl?: string
  temperature?: number
  timeoutMs?: number
  protocol?: ProviderProtocol
}

export interface ProviderInput {
  name: string
  baseUrl: string
  model: string
  /** 明文 key；提供则加密后落盘，省略则保留原密文（改配置不动 key） */
  apiKey?: string
  headers?: Record<string, string>
  proxyUrl?: string
  temperature?: number
  timeoutMs?: number
  protocol?: ProviderProtocol
}

export interface SettingsStoreOptions {
  fs: FsAdapter
  root: string
  /** 密文回调：桌面 safeStorage，测试恒等 */
  encrypt?: (plain: string) => string
  decrypt?: (cipher: string) => string
}

const DEFAULT_SETTINGS: AppSettings = { version: 1, providers: [] }

export class SettingsStore {
  readonly #fs: FsAdapter
  readonly #path: string
  readonly #encrypt: (plain: string) => string
  readonly #decrypt: (cipher: string) => string
  #cache: AppSettings | null = null

  constructor(options: SettingsStoreOptions) {
    this.#fs = options.fs
    this.#path = `${options.root}/settings.json`
    this.#encrypt = options.encrypt ?? ((plain) => plain)
    this.#decrypt = options.decrypt ?? ((cipher) => cipher)
  }

  async load(): Promise<AppSettings> {
    if (this.#cache) return structuredClone(this.#cache)
    const raw = await this.#fs.read(this.#path)
    this.#cache = parseLoose(raw)
    return structuredClone(this.#cache)
  }

  /** 展示清单（无 key 材料） */
  async list(): Promise<ProviderProfileView[]> {
    const settings = await this.load()
    return settings.providers.map((p) => ({
      name: p.name,
      baseUrl: p.baseUrl,
      model: p.model,
      hasKey: p.apiKey !== undefined && p.apiKey !== '',
      ...(p.proxyUrl !== undefined ? { proxyUrl: p.proxyUrl } : {}),
      ...(p.protocol !== undefined ? { protocol: p.protocol } : {}),
    }))
  }

  /** 解析供装配：显式 name > defaultProvider；明文 key 只在返回值里 */
  async resolve(name?: string): Promise<ResolvedProvider> {
    const settings = await this.load()
    const targetName = name ?? settings.defaultProvider
    if (targetName === undefined) {
      throw new KernelError(SettingsErrorCodes.SETTINGS_NO_DEFAULT_PROVIDER, '未指定且未配置默认 provider')
    }
    const profile = settings.providers.find((p) => p.name === targetName)
    if (!profile) {
      throw new KernelError(SettingsErrorCodes.SETTINGS_PROVIDER_NOT_FOUND, `provider 不存在：${targetName}`)
    }
    return {
      name: profile.name,
      baseUrl: profile.baseUrl,
      model: profile.model,
      ...(profile.apiKey ? { apiKey: this.#decrypt(profile.apiKey) } : {}),
      ...(profile.headers ? { headers: profile.headers } : {}),
      ...(profile.proxyUrl ? { proxyUrl: profile.proxyUrl } : {}),
      ...(profile.temperature !== undefined ? { temperature: profile.temperature } : {}),
      ...(profile.timeoutMs !== undefined ? { timeoutMs: profile.timeoutMs } : {}),
      ...(profile.protocol !== undefined ? { protocol: profile.protocol } : {}),
    }
  }

  /** 新增/更新（同名替换）；省略 apiKey 时保留既有密文 */
  async upsert(input: ProviderInput): Promise<ProviderProfileView> {
    const settings = await this.load()
    const existing = settings.providers.find((p) => p.name === input.name)
    const apiKey =
      input.apiKey !== undefined && input.apiKey !== ''
        ? this.#encrypt(input.apiKey)
        : existing?.apiKey
    const profile: StoredProviderProfile = {
      name: input.name,
      baseUrl: input.baseUrl,
      model: input.model,
      ...(apiKey !== undefined ? { apiKey } : {}),
      ...(input.headers ? { headers: input.headers } : {}),
      ...(input.proxyUrl ? { proxyUrl: input.proxyUrl } : {}),
      ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      ...(input.protocol !== undefined ? { protocol: input.protocol } : {}),
    }
    const providers = settings.providers.filter((p) => p.name !== input.name)
    providers.push(profile)
    await this.#save({ ...settings, providers })
    return {
      name: profile.name,
      baseUrl: profile.baseUrl,
      model: profile.model,
      hasKey: apiKey !== undefined,
      ...(profile.protocol !== undefined ? { protocol: profile.protocol } : {}),
    }
  }

  async remove(name: string): Promise<void> {
    const settings = await this.load()
    const providers = settings.providers.filter((p) => p.name !== name)
    const defaultProvider =
      settings.defaultProvider === name ? undefined : settings.defaultProvider
    // 回退档案随删除联动清空（悬空引用会让装配层空转）；undefined 键序列化时自然消失
    const fallbackProvider =
      settings.fallbackProvider === name ? undefined : settings.fallbackProvider
    await this.#save({ ...settings, providers, defaultProvider, fallbackProvider })
  }

  async setDefault(name: string): Promise<void> {
    const settings = await this.load()
    if (!settings.providers.some((p) => p.name === name)) {
      throw new KernelError(SettingsErrorCodes.SETTINGS_PROVIDER_NOT_FOUND, `provider 不存在：${name}`)
    }
    await this.#save({ ...settings, defaultProvider: name })
  }

  /** 沙箱后端偏好（缺省 auto） */
  async getSandbox(): Promise<SandboxPreference> {
    const settings = await this.load()
    return settings.sandbox ?? 'auto'
  }

  async setSandbox(pref: SandboxPreference): Promise<void> {
    const settings = await this.load()
    await this.#save({ ...settings, sandbox: pref })
  }

  /** 跨用户房间接入（P7）：缺省未启用（enabled=false 且字段空——旧文件读取端兼容，version 不动） */
  async getRelay(): Promise<RelaySettings> {
    const settings = await this.load()
    return settings.relay ?? { enabled: false, url: '', roomId: '', inviteCode: '', displayName: '' }
  }

  async setRelay(relay: RelaySettings): Promise<void> {
    const settings = await this.load()
    await this.#save({ ...settings, relay })
  }

  /** 回退端点档案名（null = 清除）；引用不存在的档案时拒绝（悬空引用属配置错误，显式失败） */
  async setFallback(name: string | null): Promise<void> {
    const settings = await this.load()
    if (name !== null && !settings.providers.some((p) => p.name === name)) {
      throw new KernelError(SettingsErrorCodes.SETTINGS_PROVIDER_NOT_FOUND, `provider 不存在：${name}`)
    }
    if (name === null) {
      const { fallbackProvider: _drop, ...rest } = settings
      await this.#save(rest)
      return
    }
    await this.#save({ ...settings, fallbackProvider: name })
  }

  async getFallback(): Promise<string | null> {
    const settings = await this.load()
    return settings.fallbackProvider ?? null
  }

  async #save(settings: AppSettings): Promise<void> {
    this.#cache = structuredClone(settings)
    await this.#fs.write(this.#path, `${JSON.stringify(settings, null, 2)}\n`)
  }
}

/** 解析容错：缺失/损坏/版本不识 → 默认空设置（设置可重建，不值得为此拒启）；可选字段透传（读取端兼容） */
function parseLoose(raw: string | null): AppSettings {
  if (raw === null) return structuredClone(DEFAULT_SETTINGS)
  try {
    const parsed = JSON.parse(raw) as AppSettings
    if (parsed && parsed.version === 1 && Array.isArray(parsed.providers)) {
      return {
        version: 1,
        providers: parsed.providers,
        ...(parsed.defaultProvider !== undefined ? { defaultProvider: parsed.defaultProvider } : {}),
        ...(parsed.sandbox !== undefined ? { sandbox: parsed.sandbox } : {}),
        ...(parsed.fallbackProvider !== undefined ? { fallbackProvider: parsed.fallbackProvider } : {}),
      }
    }
  } catch {
    // 落入默认
  }
  return structuredClone(DEFAULT_SETTINGS)
}
