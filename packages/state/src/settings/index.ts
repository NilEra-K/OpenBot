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
  /** 供应商至少要有一个可调用模型（图例语义：添加供应商前须先添加模型） */
  SETTINGS_PROVIDER_NO_MODEL: 'SETTINGS_PROVIDER_NO_MODEL',
  /** 改名目标与其他既有档案同名（v0.1.62 renameFrom 语义）——吞并他档须显式删除，不做隐式合并 */
  SETTINGS_PROVIDER_NAME_CONFLICT: 'SETTINGS_PROVIDER_NAME_CONFLICT',
} as const

/** 协议族：openai-compat（chat completions 兼容面）/ anthropic（messages API）；缺省前者（旧档案读取端兼容） */
export type ProviderProtocol = 'openai-compat' | 'anthropic'

/** 模型条目（v2，2026-09-15 供应商 1:N 模型）：供应商（端点事实）下的一个可调用模型 */
export interface ProviderModel {
  /** 模型 ID（如 glm-5.3-flash）——供应商内唯一键 */
  id: string
  /** 视觉（图像输入）声明——从供应商级下沉到模型级（0.1.28 截图回喂格式语义随迁）；缺省 false */
  supportsImages?: boolean
}

/** 存储形状：apiKey 恒为密文 */
export interface StoredProviderProfile {
  name: string
  baseUrl: string
  /** 供应商下的模型列表（v2）——至少一个（写入端强制；旧档案迁移容错可空） */
  models: ProviderModel[]
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
 *  mac: utm→docker→podman，P6 Step 5），不可用如实回退；ssh 永不在 auto 序内（远端机器是
 *  显式 opt-in——plan-image-firstclass P8-1） */
export type SandboxPreference = 'auto' | 'mock' | 'wsl' | 'docker' | 'podman' | 'nspawn' | 'utm' | 'ssh'

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

/** 自定义角色模板（2026-10-18 用户需求：小红书运维/微商运营等用户自建档位）：
 *  name 即档位名（模板键），persona 为默认人设文案——建 Agent 时选中即预填，可微调 */
export interface RoleTemplate {
  name: string
  persona: string
}

/** 已安装插件（2026-10-19 插件视图一期：UI 壳 + 安装态管理——运行时后续接） */
export interface InstalledPlugin {
  /** 插件 id（市场清单键） */
  id: string
  name: string
  description: string
  version: string
  /** 禁用态（false=已禁用——保留安装但停用；运行时语义后续接） */
  enabled: boolean
  /** 权限声明（2026-10-20 P2①：审批弹窗呈现——安装时从 manifest 落档；additive 可选） */
  permissions?: string[]
}

export interface AppSettings {
  version: 2
  defaultProvider?: string
  /** 默认模型（v2）：defaultProvider 下的模型 id；缺省 resolve 回落该供应商 models[0] */
  defaultModel?: string
  providers: StoredProviderProfile[]
  /** 沙箱后端偏好；缺省 auto（可选字段：旧文件读取端兼容，version 不动） */
  sandbox?: SandboxPreference
  /** 跨用户房间接入（P7 多房间轮）：数组为真相；可选字段（旧文件兼容） */
  relays?: RelaySettings[]
  /** @deprecated P7 早期单房间字段——读取端兼容保留（getRelays 回退），写入走 relays */
  relay?: RelaySettings
  /** 全局回退端点（P4 Step 11）：引用 providers 内档案名；主力请求失败时本轮降级，下轮自动回主力（不粘滞） */
  fallbackProvider?: string
  /** 自定义角色模板（2026-10-18）：可选字段（旧文件兼容）；内置四角色不落库（代码内建） */
  roleTemplates?: RoleTemplate[]
  /** 已安装插件（2026-10-19 插件视图一期）：可选字段（旧文件兼容） */
  installedPlugins?: InstalledPlugin[]
  /** 沙箱数据目录全局默认（2026-10-20 v0.2.0 Box 位置参数化）：目录型后端（wsl/nspawn）
   *  的 Box 落盘根（wsl --import 安装目录的父目录）；缺席 = userData/boxes（现行为）。
   *  同日行级化（用户裁定）：per-runtime 覆盖优先（sandboxDataDirs），本字段降为 wsl2 兼容回退 */
  sandboxDataDir?: string
  /** 每运行时数据目录（2026-10-20 行级设置）：runtimeId → 目录（目录型后端生效，其余如实不可设） */
  sandboxDataDirs?: Record<string, string>
}

/** 展示形状：给 renderer/命令面，绝无 key 材料 */
export interface ProviderProfileView {
  name: string
  baseUrl: string
  models: ProviderModel[]
  hasKey: boolean
  proxyUrl?: string
  protocol?: ProviderProtocol
}

/** 解析形状：装配 provider 用，apiKey 为明文；model = 已解析的可调用模型 */
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
  /** 视觉（图像输入）声明——computer 工具族生产注册门的事实源之一（模型级，v2 起随模型走） */
  supportsImages?: boolean
}

export interface ProviderModelInput {
  id: string
  /** 视觉（图像输入）声明——缺省 false（不放假能力） */
  supportsImages?: boolean
}

export interface ProviderInput {
  name: string
  /** 改名来源（v0.1.62）：携带时按此名寻旧档（密文随档迁移），name 即新档案键；
   *  defaultProvider / fallbackProvider 引用级联更新。缺省 = 同名替换（现行为不变） */
  renameFrom?: string
  baseUrl: string
  /** 模型列表（v2）——至少一个 */
  models: ProviderModelInput[]
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

const DEFAULT_SETTINGS: AppSettings = { version: 2, providers: [] }

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
      models: structuredClone(p.models),
      hasKey: p.apiKey !== undefined && p.apiKey !== '',
      ...(p.proxyUrl !== undefined ? { proxyUrl: p.proxyUrl } : {}),
      ...(p.protocol !== undefined ? { protocol: p.protocol } : {}),
    }))
  }

  /** 解析供装配：显式 name > defaultProvider；模型 = 显式 model > 默认模型（默认供应商时）> models[0]。
   *  明文 key 只在返回值里；视觉声明随解析到的模型条目走（v2 模型级） */
  async resolve(name?: string, model?: string): Promise<ResolvedProvider> {
    const settings = await this.load()
    const targetName = name ?? settings.defaultProvider
    if (targetName === undefined) {
      throw new KernelError(SettingsErrorCodes.SETTINGS_NO_DEFAULT_PROVIDER, '未指定且未配置默认 provider')
    }
    const profile = settings.providers.find((p) => p.name === targetName)
    if (!profile) {
      throw new KernelError(SettingsErrorCodes.SETTINGS_PROVIDER_NOT_FOUND, `provider 不存在：${targetName}`)
    }
    const defaultModel = targetName === settings.defaultProvider ? settings.defaultModel : undefined
    const targetModel = model ?? defaultModel ?? profile.models[0]?.id
    const modelEntry = profile.models.find((m) => m.id === targetModel)
    if (targetModel === undefined || modelEntry === undefined) {
      throw new KernelError(
        SettingsErrorCodes.SETTINGS_PROVIDER_NO_MODEL,
        model !== undefined
          ? `provider ${targetName} 下不存在模型：${model}`
          : `provider ${targetName} 没有可调用模型——先添加模型`,
      )
    }
    return {
      name: profile.name,
      baseUrl: profile.baseUrl,
      model: modelEntry.id,
      ...(profile.apiKey ? { apiKey: this.#decrypt(profile.apiKey) } : {}),
      ...(profile.headers ? { headers: profile.headers } : {}),
      ...(profile.proxyUrl ? { proxyUrl: profile.proxyUrl } : {}),
      ...(profile.temperature !== undefined ? { temperature: profile.temperature } : {}),
      ...(profile.timeoutMs !== undefined ? { timeoutMs: profile.timeoutMs } : {}),
      ...(profile.protocol !== undefined ? { protocol: profile.protocol } : {}),
      ...(modelEntry.supportsImages !== undefined ? { supportsImages: modelEntry.supportsImages } : {}),
    }
  }

  /** 新增/更新（同名替换）；省略 apiKey 时保留既有密文。模型列表全量替换且须非空；
   *  默认模型悬空（不在新列表内）时回落首个——不产生悬空引用。
   *  改名（v0.1.62 renameFrom）：按来源名寻旧档、密文随档迁移，name 为新档案键；
   *  defaultProvider / fallbackProvider 引用级联更新（defaultModel 不动——模型 id 不变） */
  async upsert(input: ProviderInput): Promise<ProviderProfileView> {
    const models = input.models
      .map((m) => ({ id: m.id, ...(m.supportsImages !== undefined ? { supportsImages: m.supportsImages } : {}) }))
      .filter((m) => m.id !== '')
    if (models.length === 0) {
      throw new KernelError(SettingsErrorCodes.SETTINGS_PROVIDER_NO_MODEL, '供应商至少要有一个模型')
    }
    const sourceName = input.renameFrom ?? input.name
    const renamed = input.renameFrom !== undefined && input.renameFrom !== input.name
    const settings = await this.load()
    if (input.renameFrom !== undefined) {
      if (!settings.providers.some((p) => p.name === input.renameFrom)) {
        throw new KernelError(SettingsErrorCodes.SETTINGS_PROVIDER_NOT_FOUND, `provider 不存在：${input.renameFrom}`)
      }
      if (settings.providers.some((p) => p.name === input.name && p.name !== input.renameFrom)) {
        throw new KernelError(
          SettingsErrorCodes.SETTINGS_PROVIDER_NAME_CONFLICT,
          `已存在同名供应商：${input.name}——改名不吞并他档（请先删除或换名）`,
        )
      }
    }
    const existing = settings.providers.find((p) => p.name === sourceName)
    const apiKey =
      input.apiKey !== undefined && input.apiKey !== ''
        ? this.#encrypt(input.apiKey)
        : existing?.apiKey
    const profile: StoredProviderProfile = {
      name: input.name,
      baseUrl: input.baseUrl,
      models,
      ...(apiKey !== undefined ? { apiKey } : {}),
      ...(input.headers ? { headers: input.headers } : {}),
      ...(input.proxyUrl ? { proxyUrl: input.proxyUrl } : {}),
      ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      ...(input.protocol !== undefined ? { protocol: input.protocol } : {}),
    }
    const providers = settings.providers.filter((p) => p.name !== sourceName)
    providers.push(profile)
    // 首个模型自动成为默认（0.1.28 默认语义）：免一步「设为默认」操作；已有默认时不抢占；
    // 改名级联：默认/回退引用随档案键走（settings.defaultProvider 未设置时首档语义保持）
    const defaultProvider =
      renamed && settings.defaultProvider === input.renameFrom
        ? input.name
        : (settings.defaultProvider ?? input.name)
    // 默认模型随默认供应商的模型列表维护：缺省取首个；不在列表内（被改掉）回落首个
    const defaultModel =
      defaultProvider === input.name
        ? (settings.defaultModel !== undefined && models.some((m) => m.id === settings.defaultModel)
            ? settings.defaultModel
            : models[0]!.id)
        : settings.defaultModel
    const fallbackProvider =
      renamed && settings.fallbackProvider === input.renameFrom
        ? input.name
        : settings.fallbackProvider
    await this.#save({ ...settings, providers, defaultProvider, defaultModel, fallbackProvider })
    return {
      name: profile.name,
      baseUrl: profile.baseUrl,
      models: structuredClone(profile.models),
      hasKey: apiKey !== undefined,
      ...(profile.protocol !== undefined ? { protocol: profile.protocol } : {}),
    }
  }

  async remove(name: string): Promise<void> {
    const settings = await this.load()
    const providers = settings.providers.filter((p) => p.name !== name)
    const defaultProvider =
      settings.defaultProvider === name ? undefined : settings.defaultProvider
    // 默认模型随默认供应商联动清空；回退档案随删除联动清空（悬空引用会让装配层空转）
    const defaultModel = defaultProvider === undefined ? undefined : settings.defaultModel
    const fallbackProvider =
      settings.fallbackProvider === name ? undefined : settings.fallbackProvider
    await this.#save({ ...settings, providers, defaultProvider, defaultModel, fallbackProvider })
  }

  /** 设为默认（v2 粒度 = 供应商 + 模型）：model 省略取该供应商首个模型 */
  async setDefault(name: string, model?: string): Promise<void> {
    const settings = await this.load()
    const profile = settings.providers.find((p) => p.name === name)
    if (profile === undefined) {
      throw new KernelError(SettingsErrorCodes.SETTINGS_PROVIDER_NOT_FOUND, `provider 不存在：${name}`)
    }
    const targetModel = model ?? profile.models[0]?.id
    if (targetModel === undefined || !profile.models.some((m) => m.id === targetModel)) {
      throw new KernelError(SettingsErrorCodes.SETTINGS_PROVIDER_NO_MODEL, `provider ${name} 下不存在模型：${model ?? '<空>'}`)
    }
    await this.#save({ ...settings, defaultProvider: name, defaultModel: targetModel })
  }

  /** 重排供应商（左栏拖拽排序，2026-09-15）：names 须为既有档案名的全排列（同集合），否则显式拒绝 */
  async reorder(names: string[]): Promise<void> {
    const settings = await this.load()
    const byName = new Map(settings.providers.map((p) => [p.name, p]))
    const sameSet =
      names.length === settings.providers.length &&
      new Set(names).size === names.length &&
      names.every((n) => byName.has(n))
    if (!sameSet) {
      throw new KernelError(SettingsErrorCodes.SETTINGS_PROVIDER_NOT_FOUND, '重排清单与既有供应商不一致')
    }
    const providers: StoredProviderProfile[] = []
    for (const n of names) {
      const p = byName.get(n)
      if (p === undefined) throw new KernelError(SettingsErrorCodes.SETTINGS_PROVIDER_NOT_FOUND, `provider 不存在：${n}`)
      providers.push(p)
    }
    await this.#save({ ...settings, providers })
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

  /** 沙箱数据目录全局默认（v0.2.0）：null = 清除回 userData/boxes */
  async getSandboxDataDir(): Promise<string | null> {
    const settings = await this.load()
    return settings.sandboxDataDir ?? null
  }

  async setSandboxDataDir(dir: string | null): Promise<void> {
    const settings = await this.load()
    if (dir === null || dir.trim() === '') {
      const { sandboxDataDir: _drop, ...rest } = settings
      await this.#save(rest)
      return
    }
    await this.#save({ ...settings, sandboxDataDir: dir.trim() })
  }

  /** 每运行时数据目录（2026-10-20 行级化）：读取（缺席 null）；设置/清除（空串同清除） */
  async getRuntimeDataDir(runtimeId: string): Promise<string | null> {
    const settings = await this.load()
    return settings.sandboxDataDirs?.[runtimeId] ?? null
  }

  async setRuntimeDataDir(runtimeId: string, dir: string | null): Promise<void> {
    const settings = await this.load()
    const dirs = { ...(settings.sandboxDataDirs ?? {}) }
    if (dir === null || dir.trim() === '') delete dirs[runtimeId]
    else dirs[runtimeId] = dir.trim()
    await this.#save({ ...settings, sandboxDataDirs: dirs })
  }

  /** 跨用户房间接入（P7 多房间轮）：relays 数组为真相；旧文件的 relay 单字段读取时回退为
   *  单元素数组（读取端兼容，不破坏性迁移）；缺省空数组（未接入） */
  async getRelays(): Promise<RelaySettings[]> {
    const settings = await this.load()
    if (settings.relays !== undefined) return settings.relays
    if (settings.relay !== undefined) return [settings.relay]
    return []
  }

  async setRelays(relays: RelaySettings[]): Promise<void> {
    const settings = await this.load()
    // 全量替换（与沙箱偏好同语义——无增量 API）；旧 relay 字段随之清除（relays 已是真相）
    const { relay: _dropLegacy, ...rest } = settings
    await this.#save({ ...rest, relays })
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

  /** 自定义角色模板（2026-10-18）：读取（旧文件缺席 = 空清单；坏条目过滤） */
  async getRoleTemplates(): Promise<RoleTemplate[]> {
    const settings = await this.load()
    return (settings.roleTemplates ?? []).filter(
      (r) => typeof r?.name === 'string' && r.name !== '' && typeof r?.persona === 'string' && r.persona !== '',
    )
  }

  /** 新增/更新角色模板（同名覆盖）；上限 20 个（防泛滥——角色档位是精挑的不是收藏夹） */
  async upsertRoleTemplate(input: { name: string; persona: string }): Promise<RoleTemplate[]> {
    const settings = await this.load()
    const templates = (settings.roleTemplates ?? []).filter((r) => r.name !== input.name)
    if (templates.length >= 20 && (settings.roleTemplates ?? []).every((r) => r.name !== input.name)) {
      throw new KernelError('SETTINGS_ROLE_LIMIT', '自定义角色已达上限 20 个')
    }
    templates.push({ name: input.name, persona: input.persona })
    await this.#save({ ...settings, roleTemplates: templates })
    return structuredClone(templates)
  }

  /** 删除角色模板（不存在的名字幂等通过——已建 Agent 的 roleName/persona 不受影响，只是档位不再可选） */
  async removeRoleTemplate(name: string): Promise<void> {
    const settings = await this.load()
    const templates = (settings.roleTemplates ?? []).filter((r) => r.name !== name)
    await this.#save({ ...settings, roleTemplates: templates })
  }

  /** 已安装插件（2026-10-19 插件视图一期）：读取（旧文件缺席 = 空清单；坏条目过滤） */
  async getInstalledPlugins(): Promise<InstalledPlugin[]> {
    const settings = await this.load()
    return (settings.installedPlugins ?? []).filter(
      (p) =>
        typeof p?.id === 'string' && p.id !== '' &&
        typeof p?.name === 'string' &&
        typeof p?.description === 'string' &&
        typeof p?.version === 'string' &&
        typeof p?.enabled === 'boolean',
    ).map((p) => ({
      ...p,
      ...(Array.isArray(p.permissions) ? { permissions: p.permissions.filter((x) => typeof x === 'string') } : {}),
    }))
  }

  /** 安装（同 id 覆盖重装——重装即恢复启用）；卸载（幂等）；启用/禁用切换（不存在拒绝） */
  async installPlugin(input: Omit<InstalledPlugin, 'enabled'>): Promise<InstalledPlugin[]> {
    const settings = await this.load()
    const plugins = (settings.installedPlugins ?? []).filter((p) => p.id !== input.id)
    plugins.push({ ...input, enabled: true })
    await this.#save({ ...settings, installedPlugins: plugins })
    return structuredClone(plugins)
  }

  async uninstallPlugin(id: string): Promise<void> {
    const settings = await this.load()
    const plugins = (settings.installedPlugins ?? []).filter((p) => p.id !== id)
    await this.#save({ ...settings, installedPlugins: plugins })
  }

  async setPluginEnabled(id: string, enabled: boolean): Promise<InstalledPlugin[]> {
    const settings = await this.load()
    const target = (settings.installedPlugins ?? []).find((p) => p.id === id)
    if (target === undefined) {
      throw new KernelError('SETTINGS_PLUGIN_NOT_FOUND', `插件未安装：${id}`)
    }
    target.enabled = enabled
    await this.#save({ ...settings, installedPlugins: settings.installedPlugins })
    return structuredClone(settings.installedPlugins ?? [])
  }

  async #save(settings: AppSettings): Promise<void> {
    this.#cache = structuredClone(settings)
    await this.#fs.write(this.#path, `${JSON.stringify(settings, null, 2)}\n`)
  }
}

/** 模型列表规范化（v1→v2 读取端迁移核心，纯函数可测）：
 *  v2 models 数组优先（过滤坏条目）；缺失/空时回退 v1 单模型字段 model（supportsImages 随迁下沉）；
 *  两者皆无 → 空数组（读取容错——resolve 时如实报 NO_MODEL） */
function normalizeModels(p: { model?: unknown; supportsImages?: unknown; models?: unknown }): ProviderModel[] {
  if (Array.isArray(p.models)) {
    const models = p.models
      .filter((m): m is { id: string; supportsImages?: boolean } =>
        typeof m === 'object' && m !== null && typeof (m as { id?: unknown }).id === 'string' && (m as { id: string }).id !== '')
      .map((m) => ({ id: m.id, ...(m.supportsImages === true ? { supportsImages: true } : {}) }))
    if (models.length > 0) return models
  }
  if (typeof p.model === 'string' && p.model !== '') {
    return [p.supportsImages === true ? { id: p.model, supportsImages: true } : { id: p.model }]
  }
  return []
}

/** 解析容错：缺失/损坏 → 默认空设置（设置可重建，不值得为此拒启）；
 *  version 1 = 旧单模型形状——model → models[0] 下沉迁移（读取端兼容，写回即 v2，零破坏）；
 *  version 2 = 现行形状；可选字段透传。wire 类型刻意宽松（盘上文件不受编译期形状约束） */
function parseLoose(raw: string | null): AppSettings {
  if (raw === null) return structuredClone(DEFAULT_SETTINGS)
  const asStr = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)
  const asNum = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined)
  try {
    const parsed = JSON.parse(raw) as {
      version?: number
      defaultProvider?: unknown
      defaultModel?: unknown
      sandbox?: unknown
      fallbackProvider?: unknown
      relays?: RelaySettings[]
      relay?: RelaySettings
      roleTemplates?: unknown
      installedPlugins?: unknown
      providers?: Array<Record<string, unknown>>
    }
    if (parsed && (parsed.version === 1 || parsed.version === 2) && Array.isArray(parsed.providers)) {
      const providers = parsed.providers
        .filter((p) => typeof p['name'] === 'string' && typeof p['baseUrl'] === 'string')
        .map((p) => {
          const headers = typeof p['headers'] === 'object' && p['headers'] !== null ? (p['headers'] as Record<string, string>) : undefined
          const protocol = p['protocol'] === 'anthropic' || p['protocol'] === 'openai-compat' ? (p['protocol'] as ProviderProtocol) : undefined
          const profile: StoredProviderProfile = {
            name: p['name'] as string,
            baseUrl: p['baseUrl'] as string,
            models: normalizeModels(p),
            ...(asStr(p['apiKey']) !== undefined ? { apiKey: asStr(p['apiKey']) } : {}),
            ...(headers !== undefined ? { headers } : {}),
            ...(asStr(p['proxyUrl']) !== undefined ? { proxyUrl: asStr(p['proxyUrl']) } : {}),
            ...(asNum(p['temperature']) !== undefined ? { temperature: asNum(p['temperature']) } : {}),
            ...(asNum(p['timeoutMs']) !== undefined ? { timeoutMs: asNum(p['timeoutMs']) } : {}),
            ...(protocol !== undefined ? { protocol } : {}),
          }
          return profile
        })
      return {
        version: 2,
        providers,
        ...(asStr(parsed.defaultProvider) !== undefined ? { defaultProvider: asStr(parsed.defaultProvider) } : {}),
        ...(asStr(parsed.defaultModel) !== undefined ? { defaultModel: asStr(parsed.defaultModel) } : {}),
        ...(asStr(parsed.sandbox) !== undefined ? { sandbox: parsed.sandbox as SandboxPreference } : {}),
        ...(asStr(parsed.fallbackProvider) !== undefined ? { fallbackProvider: asStr(parsed.fallbackProvider) } : {}),
        ...(Array.isArray(parsed.roleTemplates)
          ? {
              roleTemplates: parsed.roleTemplates.filter(
                (r): r is RoleTemplate =>
                  typeof (r as { name?: unknown })?.name === 'string' && (r as { name: string }).name !== '' &&
                  typeof (r as { persona?: unknown })?.persona === 'string' && (r as { persona: string }).persona !== '',
              ),
            }
          : {}),
        ...(Array.isArray(parsed.installedPlugins)
          ? {
              installedPlugins: parsed.installedPlugins.filter(
                (p): p is InstalledPlugin =>
                  typeof (p as { id?: unknown })?.id === 'string' && (p as { id: string }).id !== '' &&
                  typeof (p as { name?: unknown })?.name === 'string' &&
                  typeof (p as { description?: unknown })?.description === 'string' &&
                  typeof (p as { version?: unknown })?.version === 'string' &&
                  typeof (p as { enabled?: unknown })?.enabled === 'boolean' &&
                  (!('permissions' in (p as object)) || Array.isArray((p as { permissions?: unknown }).permissions)),
              ),
            }
          : {}),
        ...(parsed.relays !== undefined ? { relays: parsed.relays } : {}),
        // P7 早期单房间字段：读兼容保留（getRelays 回退），写入走 relays
        ...(parsed.relay !== undefined ? { relay: parsed.relay } : {}),
      }
    }
  } catch {
    // 落入默认
  }
  return structuredClone(DEFAULT_SETTINGS)
}
