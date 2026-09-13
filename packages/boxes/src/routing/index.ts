/**
 * 路由后端（plan-image-firstclass P8-3 D2）：多路 BoxBackend facade——按 `BoxSpec.image`
 * （镜像条目 id）路由到对应后端实例，'default'/未注册 id 落既有全局后端（fallback）。
 * 「Agent 控制镜像」的本质落点：镜像条目成为 create 的第一参数，后端退为实现细节；
 * services/工具族持单一 backend 引用零改动（GuiStream/Stats/Shell/工具族照旧）。
 *
 * 所有权解析：create 时记录 boxId → 后端；跨重启的既有 Box（未知 boxId）按各路由 list()
 * 惰性扫描一次并缓存（list 本就是 boxes 视图/遥测的既有调用，无新增稳态开销）。
 * caps：返回 fallback 的声明（后端级概念无 per-box 形态；per-image caps 呈现随 P8-4 记档）。
 */
import { KernelError } from '@openbot/core'
import { BoxesErrorCodes } from '../types.js'
import type {
  BoxBackend,
  BoxCaps,
  BoxId,
  BoxInstance,
  BoxSpec,
  BoxStats,
  ExecResult,
  ExecSpec,
  PipeSession,
  PipeSpec,
  ShellOpenOptions,
  ShellSession,
  SnapshotId,
  SnapshotInfo,
} from '../types.js'

/** 路由项：目标后端 + create 时的 spec 改写（container 条目：路由 id → 实际镜像名；
 *  ssh 条目忽略 image 字段无改写） */
export interface BoxRoute {
  backend: BoxBackend
  translate?: (spec: BoxSpec) => BoxSpec
}

export interface RoutingBoxBackendOptions {
  /** 缺省后端（'default'/未注册 id 落此——既有全局装配路径） */
  fallback: BoxBackend
}

export class RoutingBoxBackend implements BoxBackend {
  /** 路由后端的 registry id（装配仍注册单一 backend——id 仅为接口完备性） */
  readonly id = 'routing'
  readonly #fallback: BoxBackend
  readonly #routes = new Map<string, BoxRoute>()
  /** boxId → 属主后端（create 时记录；跨重启惰性扫描补全） */
  readonly #ownerByBox = new Map<BoxId, BoxBackend>()

  constructor(options: RoutingBoxBackendOptions) {
    this.#fallback = options.fallback
  }

  registerRoute(id: string, route: BoxRoute): this {
    this.#routes.set(id, route)
    return this
  }

  removeRoute(id: string): this {
    this.#routes.delete(id)
    return this
  }

  hasRoute(id: string): boolean {
    return this.#routes.has(id)
  }

  caps(): BoxCaps {
    return this.#fallback.caps()
  }

  async create(spec: BoxSpec): Promise<BoxId> {
    const route = this.#routes.get(spec.image)
    const backend = route?.backend ?? this.#fallback
    const effective = route?.translate !== undefined ? route.translate(spec) : spec
    const boxId = await backend.create(effective)
    this.#ownerByBox.set(boxId, backend)
    return boxId
  }

  async exec(boxId: BoxId, spec: ExecSpec): Promise<ExecResult> {
    const owner = await this.#ownerOf(boxId)
    return owner.exec(boxId, spec)
  }

  async fsRead(boxId: BoxId, path: string): Promise<string | null> {
    const owner = await this.#ownerOf(boxId)
    return owner.fsRead(boxId, path)
  }

  async fsWrite(boxId: BoxId, path: string, content: string): Promise<void> {
    const owner = await this.#ownerOf(boxId)
    return owner.fsWrite(boxId, path, content)
  }

  async snapshot(boxId: BoxId): Promise<SnapshotId> {
    const owner = await this.#ownerOf(boxId)
    return owner.snapshot(boxId)
  }

  async stats(boxId: BoxId): Promise<BoxStats> {
    const owner = await this.#ownerOf(boxId)
    return owner.stats(boxId)
  }

  async teardown(boxId: BoxId): Promise<void> {
    const owner = await this.#ownerOf(boxId)
    await owner.teardown(boxId)
    this.#ownerByBox.delete(boxId)
  }

  async openShell(boxId: BoxId, opts?: ShellOpenOptions): Promise<ShellSession> {
    const owner = await this.#ownerOf(boxId)
    return owner.openShell!(boxId, opts)
  }

  async openPipe(boxId: BoxId, spec: PipeSpec): Promise<PipeSession> {
    const owner = await this.#ownerOf(boxId)
    if (!owner.openPipe) {
      throw new KernelError(BoxesErrorCodes.BOX_UNSUPPORTED, '该 Box 所属后端不支持常驻管道')
    }
    return owner.openPipe(boxId, spec)
  }

  async pause(boxId: BoxId): Promise<void> {
    const owner = await this.#ownerOf(boxId)
    return owner.pause!(boxId)
  }

  async resume(boxId: BoxId): Promise<void> {
    const owner = await this.#ownerOf(boxId)
    return owner.resume!(boxId)
  }

  async restore(boxId: BoxId, snapshotId: SnapshotId): Promise<void> {
    const owner = await this.#ownerOf(boxId)
    return owner.restore!(boxId, snapshotId)
  }

  /** 清单聚合：fallback + 全部路由去重合并（boxes 视图跨载体完整呈现） */
  async list(): Promise<BoxInstance[]> {
    const out = new Map<BoxId, BoxInstance>()
    for (const backend of this.#allBackends()) {
      try {
        for (const instance of await backend.list()) {
          if (!out.has(instance.boxId)) out.set(instance.boxId, instance)
        }
      } catch {
        /* 单路由后端离线——其余照常呈现（如实，不炸清单） */
      }
    }
    return [...out.values()]
  }

  /** 快照链：后端级概念（容器条目共用 fallback 的 OCI 快照仓）——如实落 fallback */
  async listSnapshots(): Promise<SnapshotInfo[]> {
    if (!this.#fallback.listSnapshots) return []
    return this.#fallback.listSnapshots()
  }

  #allBackends(): BoxBackend[] {
    return [this.#fallback, ...new Set([...this.#routes.values()].map((r) => r.backend))]
  }

  /** boxId 属主解析：create 记录优先；未知 boxId（跨重启既有 Box）按各路由 list 惰性扫描缓存 */
  async #ownerOf(boxId: BoxId): Promise<BoxBackend> {
    const hit = this.#ownerByBox.get(boxId)
    if (hit) return hit
    for (const backend of this.#allBackends()) {
      try {
        if ((await backend.list()).some((b) => b.boxId === boxId)) {
          this.#ownerByBox.set(boxId, backend)
          return backend
        }
      } catch {
        /* 该路由后端离线——继续找（如实） */
      }
    }
    throw new KernelError(BoxesErrorCodes.BOX_NOT_FOUND, `Box 不存在：${boxId}`)
  }
}
