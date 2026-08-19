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
}

/** 沙箱后端偏好：auto = 按探测可用性择优（wsl > docker > podman > mock），不可用如实回退 */
export type SandboxPreference = 'auto' | 'mock' | 'wsl' | 'docker' | 'podman'

export interface AppSettings {
  version: 1
  defaultProvider?: string
  providers: StoredProviderProfile[]
  /** 沙箱后端偏好；缺省 auto（可选字段：旧文件读取端兼容，version 不动） */
  sandbox?: SandboxPreference
}

/** 展示形状：给 renderer/命令面，绝无 key 材料 */
export interface ProviderProfileView {
  name: string
  baseUrl: string
  model: string
  hasKey: boolean
  proxyUrl?: string
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
    }
    const providers = settings.providers.filter((p) => p.name !== input.name)
    providers.push(profile)
    await this.#save({ ...settings, providers })
    return { name: profile.name, baseUrl: profile.baseUrl, model: profile.model, hasKey: apiKey !== undefined }
  }

  async remove(name: string): Promise<void> {
    const settings = await this.load()
    const providers = settings.providers.filter((p) => p.name !== name)
    const defaultProvider =
      settings.defaultProvider === name ? undefined : settings.defaultProvider
    await this.#save({ ...settings, providers, defaultProvider })
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
      }
    }
  } catch {
    // 落入默认
  }
  return structuredClone(DEFAULT_SETTINGS)
}
