/**
 * 宿主屏幕后端（plan-screen-firstclass P9-1）：把宿主屏幕注册为 Box 的记账面——
 * **纯屏幕载体**：只支持「看屏 + 注入」（ScreenControl 面由 HostScreenControl 承担），
 * 无命令执行/文件/PTY/管道面（exec/fs/openShell/openPipe 稳定码拒绝——如实不造假，
 * caps 与接口永不背离）。create=attach 语义（裁定 C 延续）：屏幕预存在，create 只记账、
 * 零外部副作用；teardown 只清账，绝不触碰用户的桌面会话。
 *
 * 一期恒主屏 = 单实例单 boxId（HOST_SCREEN_BOX_ID，跨重启稳定）；多个 host-screen 镜像条目
 * 共享同一台「屏幕设备」——路由层多对一注册本后端。
 */
import { KernelError } from '@openbot/core'
import { BoxesErrorCodes } from '../types.js'
import type {
  BoxBackend,
  BoxCaps,
  BoxId,
  BoxInstance,
  BoxInstanceState,
  BoxSpec,
  BoxStats,
  ExecResult,
  ExecSpec,
  SnapshotId,
} from '../types.js'
import { HOST_SCREEN_BOX_ID } from '../screen/host-screen.js'

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
  /** 在册记账（create 幂等——单屏设备重复 create 零副作用） */
  #attached = false

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

  async create(_spec: BoxSpec): Promise<BoxId> {
    this.#attached = true
    return HOST_SCREEN_BOX_ID
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

  async teardown(_box: BoxId): Promise<void> {
    this.#attached = false // 只清本侧记账——绝不触碰桌面会话（裁定 C：绝不销毁远端）
  }

  async list(): Promise<BoxInstance[]> {
    if (!this.#attached) return []
    return [
      {
        boxId: HOST_SCREEN_BOX_ID,
        spec: { image: HOST_SCREEN_BOX_ID },
        state: 'running' as BoxInstanceState,
        createdAt: this.#now(),
      },
    ]
  }

  // 可选能力一律不实现（openShell/openPipe/pause/resume/listSnapshots）——
  // caps.interactive/suspendable/snapshot 均 false，接口与 caps 永不背离
}

