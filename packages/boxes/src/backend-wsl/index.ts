/**
 * WSL2 后端：发行版即 Box——每个 Box 一个独立发行版（rootfs 隔离），
 * `--import` 创建 / `--export` 快照 / `--terminate` 休眠 / `--unregister` 销毁 / `-d <name>` 执行。
 * caps 如实（ARCHITECTURE.md §6 矩阵）：持久化 ✓、快照 ✓（GB 级慢）、headless ✓、
 * 资源上限 ✗（全局 .wslconfig）、隔离 low（/mnt/c 直通）。
 * 地雷对照（docs/platforms.md）：wsl.exe 元信息输出 UTF-16LE（解码在 procexec 层）；
 * 命令输出字节直传（Linux 侧进程输出 UTF-8）；所有 Box 共享 vmmem（wsl --shutdown 全杀——全局地雷，UI 层告知）。
 */
import { KernelError } from '@openbot/core'
import { mkdir } from 'node:fs/promises'
import { runProcess } from '../procexec/index.js'
import type { ProcRunner } from '../procexec/index.js'
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

export const WSL_BOX_CAPS: BoxCaps = {
  persistent: true,
  snapshot: true,
  headless: true,
  resourceLimits: false,
  isolation: 'low',
}

/** WSL 发行版名前缀（list() 据此识别我们的 Box；手工发行的 distro 不碰） */
export const WSL_BOX_PREFIX = 'openbot-box-'

export const BoxesWslErrorCodes = {
  BOX_EXEC_TIMEOUT: 'BOX_EXEC_TIMEOUT',
  BOX_CREATE_FAILED: 'BOX_CREATE_FAILED',
  BOX_SNAPSHOT_FAILED: 'BOX_SNAPSHOT_FAILED',
} as const

export interface WslBoxBackendOptions {
  /** 基础 rootfs tarball 路径（create 的 --import 输入；装配方传入） */
  rootfs: string
  /** Box 发行版安装根目录（每 Box 一个子目录） */
  dir: string
  /** 快照导出目录（默认 dir/snapshots） */
  snapshotDir?: string
  /** 子进程执行器注入（默认真实 spawn；测试注入脚本化替身） */
  run?: ProcRunner
  now?: () => number
  nextBoxId?: () => BoxId
  /** Box 内默认工作目录（exec cwd 缺省值） */
  workdir?: string
}

interface WslBox {
  name: string
  spec: BoxSpec
  dir: string
  createdAt: number
}

export class WslBoxBackend implements BoxBackend {
  readonly id = 'wsl'
  readonly #rootfs: string
  readonly #dir: string
  readonly #snapshotDir: string
  readonly #run: ProcRunner
  readonly #now: () => number
  readonly #nextBoxId: () => BoxId
  readonly #workdir: string
  readonly #boxes = new Map<BoxId, WslBox>()
  #snapshotCounter = 0

  constructor(options: WslBoxBackendOptions) {
    this.#rootfs = options.rootfs
    this.#dir = options.dir
    this.#snapshotDir = options.snapshotDir ?? `${options.dir}/snapshots`
    this.#run = options.run ?? runProcess
    this.#now = options.now ?? (() => 0)
    let counter = 0
    this.#nextBoxId = options.nextBoxId ?? (() => `box-${++counter}`)
    this.#workdir = options.workdir ?? '/work'
  }

  caps(): BoxCaps {
    return { ...WSL_BOX_CAPS }
  }

  async create(spec: BoxSpec): Promise<BoxId> {
    const boxId = this.#nextBoxId()
    const name = `${WSL_BOX_PREFIX}${boxId}`
    const boxDir = `${this.#dir}/${name}`
    const r = await this.#run({
      command: ['wsl', '--import', name, boxDir, this.#rootfs, '--version', '2'],
      timeoutMs: 10 * 60_000,
      encoding: 'utf16le',
    })
    if (r.exitCode !== 0) {
      throw new KernelError(
        BoxesWslErrorCodes.BOX_CREATE_FAILED,
        `WSL 发行版导入失败（exit ${r.exitCode}）：${r.stderr.trim()}`,
      )
    }
    this.#boxes.set(boxId, { name, spec, dir: boxDir, createdAt: this.#now() })
    // 初始化工作目录：裸 rootfs 没有预设目录（真实套件实证）；顺带预热发行版（import 后处于 Stopped）
    const init = await this.#run({
      command: ['wsl', '-d', name, '--', 'mkdir', '-p', this.#workdir],
      timeoutMs: 120_000,
    })
    if (init.exitCode !== 0) {
      throw new KernelError(
        BoxesWslErrorCodes.BOX_CREATE_FAILED,
        `Box 工作目录初始化失败（exit ${init.exitCode}）：${init.stderr.trim()}`,
      )
    }
    return boxId
  }

  async exec(boxId: BoxId, spec: ExecSpec): Promise<ExecResult> {
    const box = this.#require(boxId)
    // 环境变量经 coreutils env 注入（argv 直传、零 shell 拼接，无注入面）
    const envPairs = Object.entries(spec.env ?? {}).map(([k, v]) => `${k}=${v}`)
    const command = ['wsl', '-d', box.name, '--cd', spec.cwd ?? this.#workdir]
    if (envPairs.length > 0) command.push('--', 'env', ...envPairs, '--', ...spec.command)
    else command.push('--', ...spec.command)
    const r = await this.#run({
      command,
      timeoutMs: spec.timeoutMs,
      onChunk: spec.onChunk,
    })
    if (r.timedOut) {
      throw new KernelError(
        BoxesWslErrorCodes.BOX_EXEC_TIMEOUT,
        `exec 超时（${spec.timeoutMs}ms）：${spec.command.join(' ')}`,
      )
    }
    return { exitCode: r.exitCode ?? -1, stdout: r.stdout, stderr: r.stderr }
  }

  async fsRead(boxId: BoxId, path: string): Promise<string | null> {
    const r = await this.exec(boxId, { command: ['cat', '--', path] })
    return r.exitCode === 0 ? r.stdout : null
  }

  async fsWrite(boxId: BoxId, path: string, content: string): Promise<void> {
    // base64 中转：内容经 argv 传入零引号地狱；Linux 侧 base64 -d 落盘
    const b64 = Buffer.from(content, 'utf8').toString('base64')
    const r = await this.exec(boxId, { command: ['sh', '-c', `printf %s ${b64} | base64 -d > ${shellQuote(path)}`] })
    if (r.exitCode !== 0) {
      throw new KernelError(BoxesErrorCodes.BOX_FS_WRITE_FAILED, `fsWrite 失败（exit ${r.exitCode}）：${r.stderr.trim()}`)
    }
  }

  async snapshot(boxId: BoxId): Promise<SnapshotId> {
    const box = this.#require(boxId)
    this.#snapshotCounter += 1
    const snapshotId = `snap-${this.#snapshotCounter}`
    // export 不自建目录（真实套件实证 exit -1）
    await mkdir(this.#snapshotDir, { recursive: true })
    // 终止后再导出：保证文件系统一致性（进行中写入会损坏镜像层）
    await this.#run({ command: ['wsl', '--terminate', box.name], timeoutMs: 60_000, encoding: 'utf16le' })
    const r = await this.#run({
      command: ['wsl', '--export', box.name, `${this.#snapshotDir}/${snapshotId}.tar.gz`],
      timeoutMs: 30 * 60_000,
      encoding: 'utf16le',
    })
    if (r.exitCode !== 0) {
      throw new KernelError(BoxesWslErrorCodes.BOX_SNAPSHOT_FAILED, `快照导出失败（exit ${r.exitCode}）：${r.stderr.trim()}`)
    }
    return snapshotId
  }

  async stats(_boxId: BoxId): Promise<BoxStats> {
    this.#require(_boxId)
    // caps.resourceLimits=false 的诚实对偶：WSL 无按 Box 统计（全局 vmmem 共享），
    // 如实报 0——不造假仪表（消费方按 caps 隐藏 UI）
    return { cpuPercent: 0, memoryMb: 0, diskMb: 0 }
  }

  async teardown(boxId: BoxId): Promise<void> {
    const box = this.#require(boxId)
    const r = await this.#run({ command: ['wsl', '--unregister', box.name], timeoutMs: 60_000, encoding: 'utf16le' })
    if (r.exitCode !== 0) {
      throw new KernelError(BoxesErrorCodes.BOX_NOT_FOUND, `发行版注销失败（exit ${r.exitCode}）：${r.stderr.trim()}`)
    }
    this.#boxes.delete(boxId)
  }

  async list(): Promise<BoxInstance[]> {
    // 跨重启恢复真相：发行版存在即 Box 存在（--list 输出 UTF-16LE，解码在 procexec 层）
    const r = await this.#run({ command: ['wsl', '--list', '--quiet'], encoding: 'utf16le', timeoutMs: 30_000 })
    const names = r.stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.startsWith(WSL_BOX_PREFIX))
    return names.map((name) => {
      const boxId = name.slice(WSL_BOX_PREFIX.length)
      const known = this.#boxes.get(boxId)
      return {
        boxId,
        spec: known ? { ...known.spec } : { image: 'wsl' },
        state: 'active' as const,
        createdAt: known?.createdAt ?? 0,
      }
    })
  }

  #require(boxId: BoxId): WslBox {
    const box = this.#boxes.get(boxId)
    if (!box) {
      throw new KernelError(BoxesErrorCodes.BOX_NOT_FOUND, `Box 不存在：${boxId}`)
    }
    return box
  }
}

/** POSIX 单引号包裹（单引号内的单引号用 '\'' 转义——仅用于我们内部生成的路径参数） */
function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`
}
