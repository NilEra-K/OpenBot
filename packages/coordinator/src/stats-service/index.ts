/**
 * StatsService：Box 资源统计轮询与宿主磁盘压力判定（plan-p3 Step 6，装配根职责）。
 * - poll()：逐盒 backend.stats() → `v1.box.stats` 事件（最新值遥测；单盒失败不拖累他盒）
 * - 宿主磁盘探针（注入，desktop main 用 fs.statfs 实现）→ 压力判定（**派生量归内核**：
 *   进协议的告警语义只能在这里定）→ `v1.system.pressure`——只在状态转移时发（ok→warn→critical→ok），
 *   重连重放幂等；探针失败静默跳过（无数据不发事件，如实）
 * - 阈值：warn 8GiB / critical 3GiB（可注入覆盖——E2E 经 OPENBOT_DISK_WARN_BYTES 确定性驱动）
 * - 定时器模式对齐 watchdog：定时只驱动轮询，确定性路径（测试）手动 poll()
 */
import { EventBus } from '@openbot/core'
import type { BoxBackend, BoxId } from '@openbot/boxes'
import type { SystemPressurePayload } from '@openbot/core'

/** 宿主磁盘事实（探针返回形状；测量属装配方——coordinator 只消费与判定） */
export interface DiskFact {
  freeBytes: number
  totalBytes: number
}

export type DiskProbe = () => Promise<DiskFact | null>

const GIB = 1024 * 1024 * 1024

export interface StatsServiceOptions {
  backend: BoxBackend
  /** 在册 Box 清单（装配层的 agentId→boxId 映射读取——零子进程开销，与 backend.list 的跨重启真相分工） */
  boxIds: () => Iterable<BoxId>
  bus: EventBus
  /** 宿主磁盘探针（注入；不可用可不传——压力判定整体降级为不发） */
  diskProbe?: DiskProbe
  /** 压力阈值（默认 warn 8GiB / critical 3GiB） */
  warnBytes?: number
  criticalBytes?: number
}

export class StatsService {
  readonly #backend: BoxBackend
  readonly #boxIds: () => Iterable<BoxId>
  readonly #bus: EventBus
  readonly #diskProbe: DiskProbe | undefined
  readonly #warnBytes: number
  readonly #criticalBytes: number
  #pressureLevel: SystemPressurePayload['level'] | null = null
  #timer: ReturnType<typeof setInterval> | null = null

  constructor(options: StatsServiceOptions) {
    this.#backend = options.backend
    this.#boxIds = options.boxIds
    this.#bus = options.bus
    this.#diskProbe = options.diskProbe
    this.#warnBytes = options.warnBytes ?? 8 * GIB
    this.#criticalBytes = options.criticalBytes ?? 3 * GIB
  }

  /** 当前压力档（尚未判定过为 null——测试与状态机断言用） */
  get pressureLevel(): SystemPressurePayload['level'] | null {
    return this.#pressureLevel
  }

  /** 单轮轮询（定时器与测试共用入口；永不抛——单点失败如实跳过该点） */
  async poll(): Promise<void> {
    for (const boxId of this.#boxIds()) {
      try {
        const stats = await this.#backend.stats(boxId)
        this.#bus.emit('v1.box.stats', { boxId, ...stats })
      } catch {
        // 该盒不可测（已注销/后端报错）：跳过——缺席语义在字段层，不造空事件
      }
    }
    if (this.#diskProbe === undefined) return
    let fact: DiskFact | null = null
    try {
      fact = await this.#diskProbe()
    } catch {
      return // 探针失败：无数据不发（保持上一判定）
    }
    if (fact === null) return
    const level: SystemPressurePayload['level'] =
      fact.freeBytes <= this.#criticalBytes
        ? 'critical'
        : fact.freeBytes <= this.#warnBytes
          ? 'warn'
          : 'ok'
    if (level !== this.#pressureLevel) {
      this.#pressureLevel = level
      this.#bus.emit('v1.system.pressure', {
        dimension: 'disk',
        level,
        freeBytes: fact.freeBytes,
        totalBytes: fact.totalBytes,
      })
    }
  }

  /** 启动定时轮询（幂等；timer unref——不阻止进程退出）。先立即拍一轮：开机即有数据，不等首个间隔 */
  start(intervalMs = 10_000): void {
    if (this.#timer !== null) return
    void this.poll()
    this.#timer = setInterval(() => void this.poll(), intervalMs)
    this.#timer.unref?.()
  }

  stop(): void {
    if (this.#timer === null) return
    clearInterval(this.#timer)
    this.#timer = null
  }
}
