/**
 * WSL2 后端：发行版即 Box——每个 Box 一个独立发行版（rootfs 隔离），
 * `--import` 创建 / `--export` 快照 / `--terminate` 休眠 / `--unregister` 销毁 / `-d <name>` 执行。
 * caps 如实（ARCHITECTURE.md §6 矩阵）：持久化 ✓、快照 ✓（GB 级慢）、headless ✓、
 * 资源上限 ✗（全局 .wslconfig）、隔离 low（/mnt/c 直通）。
 * 地雷对照（docs/platforms.md）：wsl.exe 元信息输出 UTF-16LE（解码在 procexec 层）；
 * 命令输出字节直传（Linux 侧进程输出 UTF-8）；所有 Box 共享 vmmem（wsl --shutdown 全杀——全局地雷，UI 层告知）。
 */
import { KernelError } from '@openbot/core'
import { mkdir, stat } from 'node:fs/promises'
import { readdir } from 'node:fs/promises'
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

export const WSL_BOX_CAPS: BoxCaps = {
  persistent: true,
  snapshot: true,
  headless: true,
  resourceLimits: false,
  isolation: 'low',
  // PTY：Box 内 script 分配真终端（2026-08-20 实测——bash 全套 readline/颜色/转义序列存活）
  interactive: true,
  // 休眠：--terminate 单发行版（vmmem 共享但发行版独立——互不波及；--shutdown 全杀地雷永不触碰）
  suspendable: true,
}

/** WSL 发行版名前缀（list() 据此识别我们的 Box；手工发行的 distro 不碰） */
export const WSL_BOX_PREFIX = 'openbot-box-'

export const BoxesWslErrorCodes = {
  BOX_EXEC_TIMEOUT: 'BOX_EXEC_TIMEOUT',
  BOX_CREATE_FAILED: 'BOX_CREATE_FAILED',
  BOX_SNAPSHOT_FAILED: 'BOX_SNAPSHOT_FAILED',
  BOX_PAUSE_FAILED: 'BOX_PAUSE_FAILED',
  BOX_RESUME_FAILED: 'BOX_RESUME_FAILED',
  BOX_RESTORE_FAILED: 'BOX_RESTORE_FAILED',
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
  /** 交互进程启动器注入（默认真实 spawn；测试注入替身断言 argv） */
  spawnShell?: ShellSpawner
  now?: () => number
  nextBoxId?: () => BoxId
  /** Box 内默认工作目录（exec cwd 缺省值） */
  workdir?: string
  /** vhdx 体积查询（stats 的磁盘真值；注入可测——替身套件零真实文件系统） */
  statFile?: (path: string) => Promise<{ size: number }>
  /** 快照目录列举（P4 Step 9 快照链；注入可测） */
  listDir?: (path: string) => Promise<string[]>
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
  readonly #spawnShell: ShellSpawner
  readonly #statFile: (path: string) => Promise<{ size: number }>
  readonly #listDir: (path: string) => Promise<string[]>
  readonly #now: () => number
  readonly #nextBoxId: () => BoxId
  readonly #workdir: string
  readonly #boxes = new Map<BoxId, WslBox>()
  #snapshotCounter = 0
  /** 休眠内存态（P4 Step 8）：pause 置位 / resume 与 exec 自然唤醒清除；重启后发行版由 create 拉起 */
  readonly #sleeping = new Set<BoxId>()

  constructor(options: WslBoxBackendOptions) {
    this.#rootfs = options.rootfs
    this.#dir = options.dir
    this.#snapshotDir = options.snapshotDir ?? `${options.dir}/snapshots`
    this.#run = options.run ?? runProcess
    this.#spawnShell = options.spawnShell ?? spawnShellProcess
    this.#statFile = options.statFile ?? stat
    this.#listDir = options.listDir ?? readdir
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
    // 跨重启幂等：发行版已存在则复用（Box 持久化真相，与 list() 同源判定）——
    // 桌面每次启动都为名册 agent 重建 Box，无条件 --import 会在第二次启动时同名冲突
    if (!(await this.#listNames()).includes(name)) {
      // --import 不自建父目录（与 --export 同款地雷；实证 exit 4294967295 且 stderr 空）
      await mkdir(this.#dir, { recursive: true })
      const r = await this.#run({
        command: ['wsl', '--import', name, boxDir, this.#rootfs, '--version', '2'],
        timeoutMs: 10 * 60_000,
        encoding: 'utf16le',
      })
      if (r.exitCode !== 0) {
        throw new KernelError(
          BoxesWslErrorCodes.BOX_CREATE_FAILED,
          `WSL 发行版导入失败（exit ${r.exitCode}）：${(r.stderr || r.stdout).trim()}`,
        )
      }
    }
    this.#boxes.set(boxId, { name, spec, dir: boxDir, createdAt: this.#now() })
    // 初始化工作目录：裸 rootfs 没有预设目录（真实套件实证）；顺带预热发行版（import 后处于 Stopped）；
    // 已存在的发行版同样安全（mkdir -p 幂等，还把 Stopped 的发行版拉起）
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
      // run 取消/抢占传导：外部中止即 kill wsl.exe 进程（与超时 kill 同型）
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
        BoxesWslErrorCodes.BOX_EXEC_TIMEOUT,
        `exec 超时（${spec.timeoutMs}ms）：${spec.command.join(' ')}`,
      )
    }
    // exec 触发发行版自启 = 自然唤醒（与显式 resume 同一机制）——休眠标志随真实状态清除
    this.#sleeping.delete(boxId)
    return { exitCode: r.exitCode ?? -1, stdout: r.stdout, stderr: r.stderr }
  }

  async openShell(boxId: BoxId, opts: ShellOpenOptions = {}): Promise<ShellSession> {
    const box = this.#require(boxId)
    // PTY 在 Linux 侧：script 给 bash 分配真终端，Windows 侧只是字节管道（零原生模块）。
    // 初始尺寸经 script -c 命令行注入（stty 不经 readline、不回显不污染屏幕），exec bash 接管会话；
    // 尺寸边界钳制（防 0×0——实测裸 script 是 0 0，vim/top 无法工作）
    const cols = Math.min(Math.max(Math.trunc(opts.cols ?? 100), 10), 500)
    const rows = Math.min(Math.max(Math.trunc(opts.rows ?? 30), 4), 200)
    const proc = this.#spawnShell([
      'wsl', '-d', box.name, '--cd', this.#workdir, '--',
      'script', '-qec', `stty rows ${rows} cols ${cols}; exec bash`, '/dev/null',
    ])
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
      throw new KernelError(
        BoxesWslErrorCodes.BOX_SNAPSHOT_FAILED,
        `快照导出失败（exit ${r.exitCode}）：${(r.stderr || r.stdout).trim()}`,
      )
    }
    return snapshotId
  }

  async stats(boxId: BoxId): Promise<BoxStats> {
    const box = this.#require(boxId)
    // 发行版即 Box：无 per-distro CPU/内存 API（发行版共享 vmmem，caps 如实不声明）——
    // 唯一可测真值是磁盘：--import 目标目录的 ext4.vhdx 体积即该 Box 磁盘占用（宿主侧 stat，零 Box 内开销）。
    // 字段缺席=不可测（BoxStats 可选化语义），UI 按在场字段渲染不造假
    try {
      const st = await this.#statFile(`${box.dir}/ext4.vhdx`)
      return { diskMb: Math.round(st.size / (1024 * 1024)) }
    } catch {
      // vhdx 尚未生成/不可读（快照恢复中等）：如实空报告
      return {}
    }
  }

  async pause(boxId: BoxId): Promise<void> {
    const box = this.#require(boxId)
    // 单发行版休眠（platforms.md：--terminate 只影响该发行版；--shutdown 全杀地雷永不触碰）
    const r = await this.#run({ command: ['wsl', '--terminate', box.name], timeoutMs: 60_000, encoding: 'utf16le' })
    if (r.exitCode !== 0) {
      throw new KernelError(
        BoxesWslErrorCodes.BOX_PAUSE_FAILED,
        `发行版休眠失败（exit ${r.exitCode}）：${(r.stderr || r.stdout).trim()}`,
      )
    }
    this.#sleeping.add(boxId)
  }

  async resume(boxId: BoxId): Promise<void> {
    const box = this.#require(boxId)
    // 轻量 exec 触发发行版自启（休眠中的任何 exec 同样自然唤醒——同一机制，显式唤醒只是补一个入口）
    const r = await this.#run({ command: ['wsl', '-d', box.name, '--', 'true'], timeoutMs: 120_000 })
    if (r.exitCode !== 0) {
      throw new KernelError(
        BoxesWslErrorCodes.BOX_RESUME_FAILED,
        `发行版唤醒失败（exit ${r.exitCode}）：${r.stderr.trim()}`,
      )
    }
    this.#sleeping.delete(boxId)
  }

  /** 快照链（P4 Step 9）：扫 snapshotDir 的 snap-N.tar.gz（既有命名约定，state 零新增）；N 降序=最近在前 */
  async listSnapshots(): Promise<SnapshotInfo[]> {
    let names: string[]
    try {
      names = await this.#listDir(this.#snapshotDir)
    } catch {
      return [] // 目录不存在=尚无快照（如实空链）
    }
    const infos: SnapshotInfo[] = []
    for (const name of names) {
      const m = /^snap-(\d+)\.tar\.gz$/.exec(name)
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

  /** 回滚（P4 Step 9）：**破坏性**——unregister 当前后端 + import 快照 tar；失败窗口如实：
   *  unregister 成功而 import 失败时发行版已注销（快照 tar 在即数据可恢复——重新 import 即可） */
  async restore(boxId: BoxId, snapshotId: SnapshotId): Promise<void> {
    const box = this.#require(boxId)
    const tar = `${this.#snapshotDir}/${snapshotId}.tar.gz`
    const un = await this.#run({ command: ['wsl', '--unregister', box.name], timeoutMs: 60_000, encoding: 'utf16le' })
    if (un.exitCode !== 0) {
      throw new KernelError(
        BoxesWslErrorCodes.BOX_RESTORE_FAILED,
        `回滚注销失败（exit ${un.exitCode}）：${(un.stderr || un.stdout).trim()}`,
      )
    }
    const im = await this.#run({
      command: ['wsl', '--import', box.name, box.dir, tar, '--version', '2'],
      timeoutMs: 10 * 60_000,
      encoding: 'utf16le',
    })
    if (im.exitCode !== 0) {
      throw new KernelError(
        BoxesWslErrorCodes.BOX_RESTORE_FAILED,
        `回滚导入失败（exit ${im.exitCode}）：${(im.stderr || im.stdout).trim()}——发行版已注销，可用同一快照重试恢复`,
      )
    }
    this.#sleeping.delete(boxId) // import 后发行版处于 Stopped，语义上等同可唤醒的休眠档——清除标志交给下一次 exec/create 拉起
  }

  async teardown(boxId: BoxId): Promise<void> {    const box = this.#require(boxId)
    const r = await this.#run({ command: ['wsl', '--unregister', box.name], timeoutMs: 60_000, encoding: 'utf16le' })
    if (r.exitCode !== 0) {
      throw new KernelError(
        BoxesErrorCodes.BOX_NOT_FOUND,
        `发行版注销失败（exit ${r.exitCode}）：${(r.stderr || r.stdout).trim()}`,
      )
    }
    this.#boxes.delete(boxId)
  }

  async list(): Promise<BoxInstance[]> {
    // 跨重启恢复真相：发行版存在即 Box 存在（前缀过滤——手工发行的 distro 不碰）
    const names = (await this.#listNames()).filter((n) => n.startsWith(WSL_BOX_PREFIX))
    return names.map((name) => {
      const boxId = name.slice(WSL_BOX_PREFIX.length)
      const known = this.#boxes.get(boxId)
      return {
        boxId,
        spec: known ? { ...known.spec } : { image: 'wsl' },
        state: (this.#sleeping.has(boxId) ? 'sleeping' : 'active') as BoxInstance['state'],
        createdAt: known?.createdAt ?? 0,
      }
    })
  }

  /** 全量发行版名（--list --quiet；元命令输出 UTF-16LE，解码在 procexec 层） */
  async #listNames(): Promise<string[]> {
    const r = await this.#run({ command: ['wsl', '--list', '--quiet'], encoding: 'utf16le', timeoutMs: 30_000 })
    return r.stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l !== '')
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
