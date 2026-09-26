/**
 * 宿主屏幕后端（plan-screen-firstclass P9-1/P9-2）：把宿主屏幕注册为 Box 的记账面——
 * **纯屏幕载体**：只支持「看屏 + 注入」（ScreenControl 面由 HostScreenControl 承担），
 * 无命令执行/文件/PTY/管道面（exec/fs/openShell/openPipe 稳定码拒绝——如实不造假，
 * caps 与接口永不背离）。create=attach 语义（裁定 C 延续）：屏幕预存在，create 只记账、
 * 零外部副作用；teardown 只清账，绝不触碰用户的桌面会话。
 *
 * P9-2 起每条目一 box（`hostscreen-<entryId>`，跨重启稳定）：窗口绑定条目是**不同的桌面面**
 * （几何/截屏/注入域各归窗口矩形），记账与路由按条目区分；整屏条目同规则（一个条目一块
 * 「屏」——多条整屏条目仍指向同一物理主屏，互不干扰）。
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
  SnapshotId,
} from '../types.js'
import { hostScreenBoxId, isHostScreenBoxId } from '../screen/host-screen.js'

/** 纯屏幕载体的统一拒绝话术（稳定码 BOX_UNSUPPORTED——caps 门禁的协议层兜底惯例） */
function rejectExec(): never {
  throw new KernelError(
    BoxesErrorCodes.BOX_UNSUPPORTED,
    '宿主屏幕是纯屏幕载体（只支持看屏与输入注入）——无命令执行面；命令行任务请绑定容器/SSH 镜像',
  )
}

export interface HostScreenBoxBackendOptions {
  now?: () => number
}

export class HostScreenBoxBackend implements BoxBackend {
  readonly id = 'hostscreen'
  readonly #now: () => number
  /** 在册记账（条目 id 集合——create 幂等，重复 create 同一条目零副作用） */
  readonly #attached = new Set<string>()

  constructor(options: HostScreenBoxBackendOptions = {}) {
    this.#now = options.now ?? (() => 0)
  }

  caps(): BoxCaps {
    return {
      persistent: true, // 屏幕预存在且跨重启在场（attach 语义）
      snapshot: false,
      headless: false, // 屏幕载体的本体就是可见桌面——无 headless 形态
      resourceLimits: false,
      isolation: 'low', // 联合不含 'none'（呈现端零波及）——「零隔离（用户本机）」语义由 UI/文档注明
      interactive: false, // 无 PTY（无 shell 可开）
      suspendable: false, // 用户的桌面会话不可被 OpenBot 休眠
    }
  }

  async create(spec: BoxSpec): Promise<BoxId> {
    const boxId = hostScreenBoxId(spec.image) // spec.image = 路由 id（镜像条目 id）
    this.#attached.add(boxId)
    return boxId
  }

  async exec(_box: BoxId, _cmd: ExecSpec): Promise<ExecResult> {
    rejectExec()
  }

  async fsRead(_box: BoxId, _path: string): Promise<string | null> {
    rejectExec()
  }

  async fsWrite(_box: BoxId, _path: string, _content: string): Promise<void> {
    rejectExec()
  }

  async snapshot(_box: BoxId): Promise<SnapshotId> {
    rejectExec()
  }

  async stats(_box: BoxId): Promise<BoxStats> {
    return {} // 屏幕载体无 CPU/内存面可测——如实全缺省
  }

  async teardown(box: BoxId): Promise<void> {
    this.#attached.delete(box) // 只清本侧记账——绝不触碰桌面会话（裁定 C：绝不销毁远端）
  }

  async list(): Promise<BoxInstance[]> {
    return [...this.#attached].map((boxId) => ({
      boxId,
      spec: { image: isHostScreenBoxId(boxId) ? boxId.slice('hostscreen-'.length) : boxId },
      state: 'active', // attach 后即在运行（v0.1.36 修：曾误写 'running' as 联合外值——boxes 视图 stateChip switch 无 default 直接炸）
      createdAt: this.#now(),
    }))
  }

  // 可选能力一律不实现（openShell/openPipe/pause/resume/listSnapshots）——
  // caps.interactive/suspendable/snapshot 均 false，接口与 caps 永不背离
}
