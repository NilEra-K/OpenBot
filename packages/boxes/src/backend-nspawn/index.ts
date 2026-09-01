/**
 * systemd-nspawn 后端（Linux）：机器即 Box——每个 Box 一个 nspawn 容器（rootfs 隔离于
 * /var/lib/machines），`machinectl import-tar` 创建 / `export-tar` 快照 / `poweroff` 休眠 /
 * `remove` 销毁 / `shell` 执行。与 backend-wsl 同为「rootfs tar 导入」心智（ARCHITECTURE.md §6 CLI 即接口）。
 * caps 如实（矩阵行）：持久化 ✓（/var/lib/machines）、快照 ✓（tar 导出）、headless ✓、
 * 资源上限 ✓（systemctl set-property 的 CPUQuota/MemoryMax——容器 scope 单元真落 cgroup）、
 * 隔离 medium（无宿主盘直通；容器逃逸面强于 WSL 但弱于 OCI 沙箱）。
 * 真机链路未验收（P6 裁定 B：CLI 语义单测锁死，nspawn 真机只验版本行为漂移）——已知边界记
 * docs/platforms.md：machinectl 写操作（import/remove/export/poweroff/set-property）需 root/polkit
 * 授权（无人值守要求 sudo NOPASSWD 或 polkit 规则，特权前缀经 options.privilegePrefix 注入）；
 * shell 的 PTY 分配边界同样待真机实测。
 */
import { KernelError } from '@openbot/core'
import { mkdir, readdir, stat } from 'node:fs/promises'
import { runProcess, spawnShellProcess } from '../procexec/index.js'
import type { ProcRunner, ShellSpawner } from '../procexec/index.js'
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
  ShellOpenOptions,
  ShellSession,
  SnapshotId,
  SnapshotInfo,
} from '../types.js'

export const NSPAWN_BOX_CAPS: BoxCaps = {
  persistent: true,
  snapshot: true,
  headless: true,
  // 与 OCI 同级真落 cgroup（scope 单元的 CPUQuota/MemoryMax——set-property 持久化到 system.control）
  resourceLimits: true,
  isolation: 'medium',
  // PTY：machinectl shell 自带终端转发（宿主侧 PTY 分配边界真机待验——platforms.md 记档）
  interactive: true,
  // 休眠：poweroff 单容器（rootfs 留 /var/lib/machines；与 wsl --terminate 同语义）
  suspendable: true,
}

/** 机器名前缀（list() 据此识别我们的 Box；systemd 系统上手工管理的 machine 不碰） */
export const NSPAWN_BOX_PREFIX = 'openbot-box-'

export const BoxesNspawnErrorCodes = {
  BOX_EXEC_TIMEOUT: 'BOX_EXEC_TIMEOUT',
  BOX_CREATE_FAILED: 'BOX_CREATE_FAILED',
  BOX_SNAPSHOT_FAILED: 'BOX_SNAPSHOT_FAILED',
  BOX_PAUSE_FAILED: 'BOX_PAUSE_FAILED',
  BOX_RESUME_FAILED: 'BOX_RESUME_FAILED',
  BOX_RESTORE_FAILED: 'BOX_RESTORE_FAILED',
} as const

export interface NspawnBoxBackendOptions {
  /** 基础 rootfs tarball 路径（create 的 import-tar 输入；装配方传入） */
  rootfs: string
  /** 快照导出目录（默认 userData 侧 boxes/snapshots——机器本体固定在 /var/lib/machines） */
  snapshotDir: string
  /** 机器存储根目录（stats 的磁盘真值 du 目标；默认 machinectl 约定路径） */
  machinesDir?: string
  /** 特权命令前缀（import/remove/export/poweroff/start/set-property 需 root/polkit；
   *  默认无前缀——真机环境按授权策略注入（sudo / pkexec），platforms.md 记档） */
  privilegePrefix?: string[]
  /** 子进程执行器注入（默认真实 spawn；测试注入脚本化替身） */
  run?: ProcRunner
  /** 交互进程启动器注入（默认真实 spawn；测试注入替身断言 argv） */
  spawnShell?: ShellSpawner
  now?: () => number
  nextBoxId?: () => BoxId
  /** Box 内默认工作目录（exec cwd 缺省值） */
  workdir?: string
  /** 目录体积查询（stats 的磁盘真值——du -sm 输出解析；注入可测） */
  diskUsageMb?: (path: string) => Promise<number>
  /** 快照目录列举（注入可测——替身套件零真实文件系统） */
  listDir?: (path: string) => Promise<string[]>
  /** 文件 stat（快照体积真值；注入可测） */
  statFile?: (path: string) => Promise<{ size: number }>
}

interface NspawnBox {
  name: string
  spec: BoxSpec
  createdAt: number
}

export class NspawnBoxBackend implements BoxBackend {
  readonly id = 'nspawn'
  readonly #rootfs: string
  readonly #snapshotDir: string
  readonly #machinesDir: string
  readonly #privilege: string[]
  readonly #run: ProcRunner
  readonly #spawnShell: ShellSpawner
  readonly #diskUsageMb: (path: string) => Promise<number>
  readonly #listDir: (path: string) => Promise<string[]>
  readonly #statFile: (path: string) => Promise<{ size: number }>
  readonly #now: () => number
  readonly #nextBoxId: () => BoxId
  readonly #workdir: string
  readonly #boxes = new Map<BoxId, NspawnBox>()
  #snapshotCounter = 0
  /** 休眠内存态：poweroff 置位 / start 与 exec 自然唤醒清除（重启后机器由 create 拉起） */
  readonly #sleeping = new Set<BoxId>()

  constructor(options: NspawnBoxBackendOptions) {
    this.#rootfs = options.rootfs
    this.#snapshotDir = options.snapshotDir
    this.#machinesDir = options.machinesDir ?? '/var/lib/machines'
    this.#privilege = options.privilegePrefix ?? []
    this.#run = options.run ?? runProcess
    this.#spawnShell = options.spawnShell ?? spawnShellProcess
    this.#diskUsageMb =
      options.diskUsageMb ??
      (async (path) => {
        // du -sm：目录递归体积 MB（机器目录即 Box 磁盘真值；--apparent-size 对稀疏文件更贴近逻辑占用）
        const r = await runProcess({ command: ['du', '-sm', '--apparent-size', path], timeoutMs: 60_000 })
        if (r.exitCode !== 0) throw new Error(`du 失败（exit ${r.exitCode}）：${r.stderr.trim()}`)
        return Number.parseInt((r.stdout.match(/^(\d+)/) ?? [])[0] ?? '', 10)
      })
    this.#now = options.now ?? (() => 0)
    this.#listDir = options.listDir ?? readdir
    this.#statFile = options.statFile ?? stat
    let counter = 0
    this.#nextBoxId = options.nextBoxId ?? (() => `box-${++counter}`)
    this.#workdir = options.workdir ?? '/work'
  }

  caps(): BoxCaps {
    return { ...NSPAWN_BOX_CAPS }
  }

  async create(spec: BoxSpec): Promise<BoxId> {
    const boxId = this.#nextBoxId()
    const name = `${NSPAWN_BOX_PREFIX}${boxId}`
    // 跨重启幂等：机器已存在则跳过 import（Box 持久化真相，与 list() 同源判定）——
    // 桌面每次启动都为名册 agent 重建 Box，无条件 import-tar 会在第二次启动时同名冲突
    if (!(await this.#listNames()).includes(name)) {
      await mkdir(this.#snapshotDir, { recursive: true })
      const r = await this.#run({
        command: [...this.#privilege, 'machinectl', 'import-tar', this.#rootfs, name],
        timeoutMs: 10 * 60_000,
      })
      if (r.exitCode !== 0) {
        throw new KernelError(
          BoxesNspawnErrorCodes.BOX_CREATE_FAILED,
          `机器导入失败（exit ${r.exitCode}）：${(r.stderr || r.stdout).trim()}`,
        )
      }
    }
    this.#boxes.set(boxId, { name, spec, createdAt: this.#now() })
    // 拉起 + 初始化工作目录：裸 rootfs 没有预设目录；已 running 的机器 start 报 already-active
    // 不算失败（is-active 先行判定，幂等语义由 ensureActive 保证）
    await this.#ensureActive(name)
    const init = await this.#run({
      command: ['machinectl', 'shell', '--quiet', `root@${name}`, '/bin/mkdir', '-p', this.#workdir],
      timeoutMs: 120_000,
    })
    if (init.exitCode !== 0) {
      throw new KernelError(
        BoxesNspawnErrorCodes.BOX_CREATE_FAILED,
        `Box 工作目录初始化失败（exit ${init.exitCode}）：${(init.stderr || init.stdout).trim()}`,
      )
    }
    // 资源上限（caps.resourceLimits=true 的兑现）：scope 单元 set-property——真落 cgroup 且跨启动持久
    const limits: string[] = []
    if (spec.cpus !== undefined) limits.push(`CPUQuota=${Math.round(spec.cpus * 100)}%`)
    if (spec.memoryMb !== undefined) limits.push(`MemoryMax=${spec.memoryMb}M`)
    if (limits.length > 0) {
      const r = await this.#run({
        command: [...this.#privilege, 'systemctl', 'set-property', `machine-${name}.scope`, ...limits],
        timeoutMs: 30_000,
      })
      if (r.exitCode !== 0) {
        throw new KernelError(
          BoxesNspawnErrorCodes.BOX_CREATE_FAILED,
          `资源上限设置失败（exit ${r.exitCode}）：${(r.stderr || r.stdout).trim()}`,
        )
      }
    }
    return boxId
  }

  async exec(boxId: BoxId, spec: ExecSpec): Promise<ExecResult> {
    const box = this.#require(boxId)
    // 冷容器自然唤醒（与显式 resume 同一机制）
    await this.#ensureActive(box.name)
    // 环境变量经 coreutils env 注入（argv 直传、零 shell 拼接，无注入面）；
    // cwd 无法 argv 化（machinectl shell 无工作目录参数）——设了 cwd 才走 sh -c 包裹（quote 保护）
    const envPairs = Object.entries(spec.env ?? {}).map(([k, v]) => `${k}=${v}`)
    const command = ['machinectl', 'shell', '--quiet', `root@${box.name}`]
    if (spec.cwd !== undefined) {
      // POSIX exec builtin 无 -- 参数——env 注入经 /usr/bin/env，命令参数各自 quote
      const inner = [
        'cd', shellQuote(spec.cwd), '&&', 'exec',
        ...(envPairs.length > 0 ? ['/usr/bin/env', ...envPairs.map(shellQuote)] : []),
        ...spec.command.map(shellQuote),
      ]
      command.push('/bin/sh', '-c', inner.join(' '))
    } else if (envPairs.length > 0) {
      command.push('/usr/bin/env', ...envPairs, '--', ...spec.command)
    } else {
      command.push(...spec.command)
    }
    const r = await this.#run({
      command,
      timeoutMs: spec.timeoutMs,
      onChunk: spec.onChunk,
      // run 取消/抢占传导：外部中止即 kill 进程（与超时 kill 同型）
      ...(spec.signal !== undefined ? { signal: spec.signal } : {}),
    })
    if (r.aborted) {
      // 用户打断工作中的 agent 的传导终点——与超时同型抛错，工具层落 aborted 事实
      throw new KernelError(
        BoxesErrorCodes.BOX_EXEC_ABORTED,
        `exec 已中止：${spec.command.join(' ')}`,
      )
    }
    if (r.timedOut) {
      throw new KernelError(
        BoxesNspawnErrorCodes.BOX_EXEC_TIMEOUT,
        `exec 超时（${spec.timeoutMs}ms）：${spec.command.join(' ')}`,
      )
    }
    // shell 会话触发的机器运行 = 自然唤醒——休眠标志随真实状态清除
    this.#sleeping.delete(boxId)
    return { exitCode: r.exitCode ?? -1, stdout: r.stdout, stderr: r.stderr }
  }

  async openShell(boxId: BoxId, _opts: ShellOpenOptions = {}): Promise<ShellSession> {
    const box = this.#require(boxId)
    // machinectl shell 自带终端转发与容器内 PTY 分配（宿主侧边界真机待验——platforms.md 记档）；
    // 初始尺寸参数无 argv 通道（machinectl 无 stty 前置钩子），容器内 shell 自行接管
    await this.#ensureActive(box.name)
    const proc = this.#spawnShell(['machinectl', 'shell', `root@${box.name}`])
    let dataCb: ((text: string) => void) | null = null
    let exitCb: ((code: number | null) => void) | null = null
    proc.onOutput((text) => dataCb?.(text))
    proc.onExit((code) => exitCb?.(code))
    return {
      write: (text) => proc.write(text),
      onData: (cb) => {
        dataCb = cb
      },
      onExit: (cb) => {
        exitCb = cb
      },
      close: () => proc.kill(),
    }
  }

  async fsRead(boxId: BoxId, path: string): Promise<string | null> {
    const r = await this.exec(boxId, { command: ['/bin/cat', '--', path] })
    return r.exitCode === 0 ? r.stdout : null
  }

  async fsWrite(boxId: BoxId, path: string, content: string): Promise<void> {
    // base64 中转：内容经 argv 传入零引号地狱；容器侧 base64 -d 落盘
    const b64 = Buffer.from(content, 'utf8').toString('base64')
    const r = await this.exec(boxId, {
      command: ['/bin/sh', '-c', `printf %s ${b64} | base64 -d > ${shellQuote(path)}`],
    })
    if (r.exitCode !== 0) {
      throw new KernelError(BoxesErrorCodes.BOX_FS_WRITE_FAILED, `fsWrite 失败（exit ${r.exitCode}）：${r.stderr.trim()}`)
    }
  }

  async snapshot(boxId: BoxId): Promise<SnapshotId> {
    const box = this.#require(boxId)
    this.#snapshotCounter += 1
    const snapshotId = `snap-${this.#snapshotCounter}`
    await mkdir(this.#snapshotDir, { recursive: true })
    // 关机后再导出：保证文件系统一致性（进行中写入会损坏镜像层）
    await this.#poweroff(box.name)
    const r = await this.#run({
      command: [...this.#privilege, 'machinectl', 'export-tar', box.name, `${this.#snapshotDir}/${snapshotId}.tar`],
      timeoutMs: 30 * 60_000,
    })
    if (r.exitCode !== 0) {
      throw new KernelError(
        BoxesNspawnErrorCodes.BOX_SNAPSHOT_FAILED,
        `快照导出失败（exit ${r.exitCode}）：${(r.stderr || r.stdout).trim()}`,
      )
    }
    return snapshotId
  }

  async stats(boxId: BoxId): Promise<BoxStats> {
    const box = this.#require(boxId)
    // cgroup 真值（systemctl show）：MemoryCurrent 字节→MB；CPU 只有累计纳秒（CPUUsageNSec）无百分比
    // 真相——cpuPercent 如实缺席。磁盘：机器目录 du 递归体积（rootfs 稀疏文件用 apparent-size 贴近逻辑占用）
    const stats: BoxStats = {}
    try {
      const mem = await this.#run({
        command: ['systemctl', 'show', `machine-${box.name}.scope`, '-p', 'MemoryCurrent', '--value'],
        timeoutMs: 15_000,
      })
      const bytes = Number.parseInt(mem.stdout.trim(), 10)
      if (mem.exitCode === 0 && Number.isFinite(bytes) && bytes > 0) {
        stats.memoryMb = Math.round(bytes / (1024 * 1024))
      }
    } catch {
      /* 单元不可知（机器已关机等）——字段缺席，如实 */
    }
    try {
      stats.diskMb = await this.#diskUsageMb(`${this.#machinesDir}/${box.name}`)
    } catch {
      /* 目录不可读——字段缺席，如实 */
    }
    return stats
  }

  async pause(boxId: BoxId): Promise<void> {
    const box = this.#require(boxId)
    await this.#poweroff(box.name)
    this.#sleeping.add(boxId)
  }

  async resume(boxId: BoxId): Promise<void> {
    const box = this.#require(boxId)
    const r = await this.#run({
      command: [...this.#privilege, 'machinectl', 'start', box.name],
      timeoutMs: 120_000,
    })
    if (r.exitCode !== 0) {
      throw new KernelError(
        BoxesNspawnErrorCodes.BOX_RESUME_FAILED,
        `机器唤醒失败（exit ${r.exitCode}）：${(r.stderr || r.stdout).trim()}`,
      )
    }
    this.#sleeping.delete(boxId)
  }

  /** 快照链：扫 snapshotDir 的 snap-N.tar（无 gz——export-tar 默认裸 tar；N 降序=最近在前） */
  async listSnapshots(): Promise<SnapshotInfo[]> {
    let names: string[]
    try {
      names = await this.#listDir(this.#snapshotDir)
    } catch {
      return [] // 目录不存在=尚无快照（如实空链）
    }
    const infos: SnapshotInfo[] = []
    for (const name of names) {
      const m = /^snap-(\d+)\.tar$/.exec(name)
      if (!m) continue
      const info: SnapshotInfo = { snapshotId: `snap-${m[1]}` }
      try {
        const st = await this.#statFile(`${this.#snapshotDir}/${name}`)
        info.sizeBytes = st.size
      } catch {
        /* 大小不可知即缺席（如实） */
      }
      infos.push(info)
    }
    return infos.sort((a, b) => Number(b.snapshotId.slice(5)) - Number(a.snapshotId.slice(5)))
  }

  /** 回滚：**破坏性**——remove 当前后端 + import-tar 快照；失败窗口如实：
   *  remove 成功而 import 失败时机器已删（快照 tar 在即数据可恢复——重新 import 即可） */
  async restore(boxId: BoxId, snapshotId: SnapshotId): Promise<void> {
    const box = this.#require(boxId)
    const tar = `${this.#snapshotDir}/${snapshotId}.tar`
    await this.#poweroff(box.name)
    const rm = await this.#run({
      command: [...this.#privilege, 'machinectl', 'remove', box.name],
      timeoutMs: 10 * 60_000,
    })
    if (rm.exitCode !== 0) {
      throw new KernelError(
        BoxesNspawnErrorCodes.BOX_RESTORE_FAILED,
        `回滚注销失败（exit ${rm.exitCode}）：${(rm.stderr || rm.stdout).trim()}`,
      )
    }
    const im = await this.#run({
      command: [...this.#privilege, 'machinectl', 'import-tar', tar, box.name],
      timeoutMs: 10 * 60_000,
    })
    if (im.exitCode !== 0) {
      throw new KernelError(
        BoxesNspawnErrorCodes.BOX_RESTORE_FAILED,
        `回滚导入失败（exit ${im.exitCode}）：${(im.stderr || im.stdout).trim()}——机器已删除，可用同一快照重试恢复`,
      )
    }
    this.#sleeping.delete(boxId) // import 后机器处于关机态，语义上等同可唤醒的休眠档
  }

  async teardown(boxId: BoxId): Promise<void> {
    const box = this.#require(boxId)
    await this.#poweroff(box.name)
    const r = await this.#run({
      command: [...this.#privilege, 'machinectl', 'remove', box.name],
      timeoutMs: 10 * 60_000,
    })
    if (r.exitCode !== 0) {
      throw new KernelError(
        BoxesErrorCodes.BOX_NOT_FOUND,
        `机器删除失败（exit ${r.exitCode}）：${(r.stderr || r.stdout).trim()}`,
      )
    }
    this.#boxes.delete(boxId)
  }

  async list(): Promise<BoxInstance[]> {
    // 跨重启恢复真相：机器存在即 Box 存在（前缀过滤——手工管理的 machine 不碰）
    const names = (await this.#listNames()).filter((n) => n.startsWith(NSPAWN_BOX_PREFIX))
    return names.map((name) => {
      const boxId = name.slice(NSPAWN_BOX_PREFIX.length)
      const known = this.#boxes.get(boxId)
      return {
        boxId,
        spec: known ? { ...known.spec } : { image: 'nspawn' },
        state: (this.#sleeping.has(boxId) ? 'sleeping' : 'active') as BoxInstance['state'],
        createdAt: known?.createdAt ?? 0,
      }
    })
  }

  /** 全量机器名（machinectl list --no-legend 第一列；systemd 系统默认 UTF-8 无解码地雷） */
  async #listNames(): Promise<string[]> {
    const r = await this.#run({
      command: ['machinectl', 'list', '--no-legend', '--no-pager'],
      timeoutMs: 30_000,
    })
    if (r.exitCode !== 0) {
      return [] // machinectl 不可用（systemd 环境缺失）——空表如实（探测层呈现原因）
    }
    return r.stdout
      .split(/\r?\n/)
      .map((l) => l.trim().split(/\s+/)[0] ?? '')
      .filter((n) => n !== '')
  }

  /** 冷容器拉起（幂等）：is-active 判定先行——running 时跳过 start（machinectl start 对已运行机器报错） */
  async #ensureActive(name: string): Promise<void> {
    const active = await this.#run({
      command: ['systemctl', 'is-active', `machine-${name}.scope`],
      timeoutMs: 15_000,
    })
    if (active.exitCode === 0) return
    const start = await this.#run({
      command: [...this.#privilege, 'machinectl', 'start', name],
      timeoutMs: 120_000,
    })
    if (start.exitCode !== 0) {
      throw new KernelError(
        BoxesNspawnErrorCodes.BOX_CREATE_FAILED,
        `机器启动失败（exit ${start.exitCode}）：${(start.stderr || start.stdout).trim()}`,
      )
    }
  }

  async #poweroff(name: string): Promise<void> {
    const r = await this.#run({
      command: [...this.#privilege, 'machinectl', 'poweroff', name],
      timeoutMs: 60_000,
    })
    // 已关机的机器 poweroff 报错不算失败（幂等语义——快照/teardown 前置关机常遇）
    if (r.exitCode !== 0 && !(r.stderr || r.stdout).includes('not active')) {
      throw new KernelError(
        BoxesNspawnErrorCodes.BOX_PAUSE_FAILED,
        `机器关机失败（exit ${r.exitCode}）：${(r.stderr || r.stdout).trim()}`,
      )
    }
  }

  #require(boxId: BoxId): NspawnBox {
    const box = this.#boxes.get(boxId)
    if (!box) {
      throw new KernelError(BoxesErrorCodes.BOX_NOT_FOUND, `Box 不存在：${boxId}`)
    }
    return box
  }
}

/** POSIX 单引号包裹（单引号内的单引号用 '\'' 转义——仅用于我们内部生成的路径/参数） */
function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`
}
