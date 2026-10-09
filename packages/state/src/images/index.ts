/**
 * ImageStore（plan-image-firstclass P8-3 D1）——镜像注册表：镜像获得一等公民地位。
 * 条目 = 载体类型（容器镜像 / SSH 主机，vmware 随 P8-5）+ 连接信息 + 控制协议 + 显示地址；
 * Agent 绑定镜像条目而非后端实例（绑定随 P8-4，注册表先立）。
 * 持久化：全局 <root>/images.json；读取端兼容：损坏降级空表 + 告警（automations 同哲学）；
 * 条目上限 16（裁定 F——载体种类天然多：本地容器 + 多虚机 + 云）。
 * 凭据位（D4）：一期 SSH key 路径明文引用（裁定 D key-only——密码方式 Windows 工具链不成立）；
 * 密码/guest 凭据字段位预留（扩展走 version+读取端兼容，safeStorage 密文回调位同 SettingsStore）。
 */
import { KernelError } from '@openbot/core'
import type { FsAdapter } from '../fs/index.js'

export const ImageErrorCodes = {
  /** 条目字段非法（id 形状/名称空超长/连接事实缺失/协议枚举外） */
  STATE_IMAGE_INVALID: 'STATE_IMAGE_INVALID',
  /** 超过条目上限（裁定 F=16——朴素限流） */
  STATE_IMAGE_LIMIT: 'STATE_IMAGE_LIMIT',
  /** 条目不存在（remove/更新命中失败） */
  STATE_IMAGE_NOT_FOUND: 'STATE_IMAGE_NOT_FOUND',
} as const

/** 条目上限（裁定 F） */
export const IMAGE_LIMIT = 16
export const IMAGE_NAME_LIMIT = 64

/** 载体类型（P8-3：容器镜像 / SSH 主机；P9-1 宿主屏幕；P9-3a Windows 主机；P9-3b
 *  Android 设备——adb 可达，screencap/input/screenrecord 设备内建工具） */
export type ImageCarrier = 'container' | 'ssh' | 'host-screen' | 'windows' | 'android'

/** 控制协议（桌面控制适配器的选择依据；'none' = 纯 exec 载体——无 GUI 面；
 *  'host' = 宿主内置注入；'win' = Windows 机内注入；'android' = Android 注入
 *  （P9-3b 专属——input 命令 over adb，独立设备不经本机审批闸） */
export type ImageControlProtocol = 'x11' | 'none' | 'host' | 'win' | 'android'

export interface ImageEntry {
  /** 路由键（BoxSpec.image 消费——addAgent 绑定后 per-agent create 的第一参数） */
  id: string
  /** 呈现名（用户记名） */
  name: string
  carrier: ImageCarrier
  /** carrier=container：OCI 镜像名（如 openbot-gui:24.04） */
  image?: string
  /** carrier=ssh：连接事实（裁定 D key-only——keyPath 引用宿主私钥文件） */
  host?: string
  port?: number
  user?: string
  keyPath?: string
  controlProtocol: ImageControlProtocol
  /** X 显示地址（controlProtocol=x11 时；缺省装配默认——P8-2 B3 镜像条目接管位） */
  display?: string
  /** carrier=host-screen：绑定窗口标题子串（P9-2 裁定 B；空缺=整屏。窗口重开同名即恢复） */
  windowTitle?: string
  /** carrier=container：OCI 运行时显式声明（v0.1.53 用户裁定「不自动找路」）——docker/podman；
   *  缺省读取端回退 docker 优先探测（旧条目一次性迁移语义，编辑保存后带上） */
  runtime?: 'docker' | 'podman'
  createdAt: number
}

export interface ImageInput {
  name: string
  carrier: ImageCarrier
  image?: string
  host?: string
  port?: number
  user?: string
  keyPath?: string
  controlProtocol: ImageControlProtocol
  display?: string
  windowTitle?: string
  runtime?: 'docker' | 'podman'
}

export interface ImageStoreOptions {
  fs: FsAdapter
  root: string
  now?: () => number
  /** id 生成（缺省 img-N 自增扫描；注入可测） */
  nextImageId?: () => string
}

interface ImageFile {
  version: 1
  images: ImageEntry[]
}

const DEFAULT_FILE: ImageFile = { version: 1, images: [] }

/** 损坏/缺失降级：空表 + 告警（automations/settings 同哲学——不炸装配） */
function parseLoose(raw: string | null): ImageFile {
  if (raw === null) return { version: 1, images: [] }
  try {
    const parsed = JSON.parse(raw) as ImageFile
    if (parsed && parsed.version === 1 && Array.isArray(parsed.images)) {
      return { version: 1, images: parsed.images }
    }
  } catch {
    // 落入默认
  }
  console.warn('[openbot] images.json 无法解析——按空镜像注册表运行（原文件保留待人工检查）')
  return { version: 1, images: [] }
}

/** 条目校验（写入路径的单一事实源；连接事实按 carrier 分形状——zod 校验在命令面，此处兜底） */
function validateEntry(entry: ImageEntry): void {
  if (!/^img-[a-z0-9-]+$/.test(entry.id)) {
    throw new KernelError(ImageErrorCodes.STATE_IMAGE_INVALID, `镜像 id 非法：${entry.id}`)
  }
  if (entry.name === '' || entry.name.length > IMAGE_NAME_LIMIT) {
    throw new KernelError(ImageErrorCodes.STATE_IMAGE_INVALID, `镜像名须为 1-${IMAGE_NAME_LIMIT} 字`)
  }
  if (entry.carrier === 'container') {
    if (entry.image === undefined || entry.image === '') {
      throw new KernelError(ImageErrorCodes.STATE_IMAGE_INVALID, '容器镜像条目须指定镜像名')
    }
    if (entry.controlProtocol !== 'x11' && entry.controlProtocol !== 'none') {
      throw new KernelError(ImageErrorCodes.STATE_IMAGE_INVALID, '容器载体控制协议只接受 x11/none')
    }
  } else if (entry.carrier === 'ssh' || entry.carrier === 'windows') {
    // ssh 与 windows 同形连接事实（host/port/user/keyPath）；协议枚举按载体分
    if (entry.host === undefined || entry.host === '') {
      throw new KernelError(ImageErrorCodes.STATE_IMAGE_INVALID, '镜像条目须指定主机地址')
    }
    if (entry.port !== undefined && (!Number.isInteger(entry.port) || entry.port < 1 || entry.port > 65535)) {
      throw new KernelError(ImageErrorCodes.STATE_IMAGE_INVALID, `端口非法：${entry.port}`)
    }
    if (entry.carrier === 'ssh' && entry.controlProtocol !== 'x11' && entry.controlProtocol !== 'none') {
      throw new KernelError(ImageErrorCodes.STATE_IMAGE_INVALID, 'SSH 载体控制协议只接受 x11/none')
    }
    if (entry.carrier === 'windows' && entry.controlProtocol !== 'win' && entry.controlProtocol !== 'none') {
      throw new KernelError(ImageErrorCodes.STATE_IMAGE_INVALID, 'Windows 载体控制协议只接受 win/none')
    }
  } else if (entry.carrier === 'android') {
    // android（P9-3b）：连接事实 = host（设备序列号或 wifi 地址 ip:port）；协议 android/none
    if (entry.host === undefined || entry.host === '') {
      throw new KernelError(ImageErrorCodes.STATE_IMAGE_INVALID, 'Android 镜像条目须指定设备序列号或 wifi 地址')
    }
    if (entry.controlProtocol !== 'android' && entry.controlProtocol !== 'none') {
      throw new KernelError(ImageErrorCodes.STATE_IMAGE_INVALID, 'Android 载体控制协议只接受 android/none')
    }
  } else {
    // host-screen（P9-1）：纯屏幕载体——连接事实为零（一期恒主屏），控制协议恒 host
    if (entry.controlProtocol !== 'host') {
      throw new KernelError(ImageErrorCodes.STATE_IMAGE_INVALID, '宿主屏幕载体控制协议恒为 host（内置注入）')
    }
    if (entry.windowTitle !== undefined && (entry.windowTitle === '' || entry.windowTitle.length > 200)) {
      throw new KernelError(ImageErrorCodes.STATE_IMAGE_INVALID, '绑定窗口标题须为 1-200 字（空缺=整屏）')
    }
    // runtime 是 container 专属事实（此处已 narrow 到 host-screen 分支——他在场即非法；
    // container 分支在前序已自行校验值域，update 收尾对他载体一律清除）
    if (entry.runtime !== undefined) {
      throw new KernelError(ImageErrorCodes.STATE_IMAGE_INVALID, '运行时声明只接受 container 载体')
    }
  }
}

export class ImageStore {
  readonly #fs: FsAdapter
  readonly #path: string
  readonly #now: () => number
  readonly #nextImageId: () => string
  #cache: ImageFile | null = null
  /** img-N 自增游标（懒播种：首用时扫存量条目取最大 N——跨重启不撞号） */
  #counter = 0
  #counterSeeded = false

  constructor(options: ImageStoreOptions) {
    this.#fs = options.fs
    this.#path = `${options.root}/images.json`
    this.#now = options.now ?? (() => 0)
    this.#nextImageId = options.nextImageId ?? (() => `img-${++this.#counter}`)
  }

  /** 播种自增游标（只一次）：存量 img-N 的最大 N */
  async #seedCounter(): Promise<void> {
    if (this.#counterSeeded) return
    this.#counterSeeded = true
    for (const e of (await this.#load()).images) {
      const n = Number(e.id.slice(4))
      if (Number.isFinite(n) && n > this.#counter) this.#counter = n
    }
  }

  async #load(): Promise<ImageFile> {
    if (this.#cache) return this.#cache
    const raw = await this.#fs.read(this.#path)
    this.#cache = parseLoose(raw)
    return this.#cache
  }

  async #save(file: ImageFile): Promise<void> {
    this.#cache = file
    await this.#fs.write(this.#path, `${JSON.stringify(file, null, 2)}\n`)
  }

  async list(): Promise<ImageEntry[]> {
    return structuredClone((await this.#load()).images)
  }

  async get(id: string): Promise<ImageEntry | null> {
    const hit = (await this.#load()).images.find((e) => e.id === id)
    return hit ? structuredClone(hit) : null
  }

  /** 新增（id 服务端生成 img-N；上限 16 如实拒绝） */
  async add(input: ImageInput): Promise<ImageEntry> {
    const file = await this.#load()
    if (file.images.length >= IMAGE_LIMIT) {
      throw new KernelError(ImageErrorCodes.STATE_IMAGE_LIMIT, `镜像条目已达上限（${IMAGE_LIMIT}）`)
    }
    await this.#seedCounter()
    const existing = new Set(file.images.map((e) => e.id))
    let id = this.#nextImageId()
    while (existing.has(id)) id = `img-${++this.#counter}`
    const entry: ImageEntry = {
      id,
      name: input.name,
      carrier: input.carrier,
      ...(input.image !== undefined ? { image: input.image } : {}),
      ...(input.host !== undefined ? { host: input.host } : {}),
      ...(input.port !== undefined ? { port: input.port } : {}),
      ...(input.user !== undefined ? { user: input.user } : {}),
      ...(input.keyPath !== undefined ? { keyPath: input.keyPath } : {}),
      controlProtocol: input.controlProtocol,
      ...(input.display !== undefined && input.display !== '' ? { display: input.display } : {}),
      ...(input.windowTitle !== undefined && input.windowTitle !== '' ? { windowTitle: input.windowTitle } : {}),
    // runtime 无条件落盘：错配（非 container 载体）由 validateEntry 显式拒绝——不静默丢弃
    ...(input.runtime !== undefined ? { runtime: input.runtime } : {}),
      createdAt: this.#now(),
    }
    validateEntry(entry)
    file.images.push(entry)
    await this.#save(file)
    return structuredClone(entry)
  }

  /** 更新（id 不变；字段全量替换——同 automations 语义） */
  async update(id: string, patch: Partial<ImageInput>): Promise<ImageEntry> {
    const file = await this.#load()
    const entry = file.images.find((e) => e.id === id)
    if (!entry) {
      throw new KernelError(ImageErrorCodes.STATE_IMAGE_NOT_FOUND, `镜像条目不存在：${id}`)
    }
    // 连接事实同形组（P9-3a/P9-3b）：ssh↔windows 互切保留 host/port/user/keyPath；
    // android 仅保留 host（序列号/wifi 地址）；跨组切换清除——字段对目标载体无意义
    const remoteLike = (c: ImageCarrier): boolean => c === 'ssh' || c === 'windows' || c === 'android'
    const sshLike = (c: ImageCarrier): boolean => c === 'ssh' || c === 'windows'
    const target = patch.carrier ?? entry.carrier
    const keepConnection = patch.carrier === undefined || (remoteLike(entry.carrier) && remoteLike(target))
    const keepSshFacts = patch.carrier === undefined || (sshLike(entry.carrier) && sshLike(target))
    const next: ImageEntry = {
      ...entry,
      name: patch.name ?? entry.name,
      carrier: target,
      image: patch.image ?? (keepConnection ? entry.image : undefined),
      host: patch.host ?? (keepConnection ? entry.host : undefined),
      port: patch.port ?? (keepSshFacts ? entry.port : undefined),
      user: patch.user ?? (keepSshFacts ? entry.user : undefined),
      keyPath: patch.keyPath ?? (keepSshFacts ? entry.keyPath : undefined),
      controlProtocol: patch.controlProtocol ?? entry.controlProtocol,
      display: patch.display !== undefined ? (patch.display === '' ? undefined : patch.display) : entry.display,
      // 窗口绑定随载体切换清除（host-screen 专属事实）；空串 = 清除回整屏
      windowTitle:
        patch.windowTitle !== undefined
          ? patch.windowTitle === ''
            ? undefined
            : patch.windowTitle
          : entry.windowTitle,
    }
    if (next.image === undefined) delete (next as Partial<ImageEntry>).image
    if (next.host === undefined) delete (next as Partial<ImageEntry>).host
    if (next.port === undefined) delete (next as Partial<ImageEntry>).port
    if (next.user === undefined) delete (next as Partial<ImageEntry>).user
    if (next.keyPath === undefined) delete (next as Partial<ImageEntry>).keyPath
    if (next.display === undefined) delete (next as Partial<ImageEntry>).display
    // 窗口绑定是 host-screen 专属事实——他载体一律清除（切载体即失效）
    if (next.carrier !== 'host-screen') delete (next as Partial<ImageEntry>).windowTitle
    if (next.carrier !== 'container') delete (next as Partial<ImageEntry>).runtime
    if (next.windowTitle === undefined) delete (next as Partial<ImageEntry>).windowTitle
    validateEntry(next)
    file.images.splice(file.images.indexOf(entry), 1, next)
    await this.#save(file)
    return structuredClone(next)
  }

  async remove(id: string): Promise<void> {
    const file = await this.#load()
    const before = file.images.length
    file.images = file.images.filter((e) => e.id !== id)
    if (file.images.length === before) {
      throw new KernelError(ImageErrorCodes.STATE_IMAGE_NOT_FOUND, `镜像条目不存在：${id}`)
    }
    await this.#save(file)
  }
}
