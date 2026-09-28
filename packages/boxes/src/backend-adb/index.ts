/**
 * Android adb 后端（plan-screen-firstclass P9-3b）：Android 设备（USB 调试 / wifi adb）即
 * Box——adb 之于 Android ≈ SSH 之于 Windows：exec 通道 + 设备内建工具（screencap/input/
 * screenrecord），设备端零预装。
 *
 * **Android 是 POSIX**（mksh）：远端脚本构造 / fs 读写直接复用 backend-ssh 的
 * buildRemoteScript + sshQuote + stdin b64 模式（设备端 toybox base64/cat 齐备）；工作目录
 * 用 /data/local/tmp/openbot（adb shell 免 root 可写的标准位）。
 *
 * **attach 语义（裁定 C 延续）**：设备是用户资产——create = 连通验证 + 工作目录确保 + 记账，
 * teardown 只清账；整机 isolation high——注入不经本机审批闸；caps 与 SSH 同矩阵
 * （interactive ✓ = `adb -tt shell` 真 PTY）。
 *
 * 参考：plan-screen-firstclass.md P9-3b、ARCHITECTURE.md §6、docs/platforms.md Android 节。
 */
import { KernelError } from '@openbot/core'
import { runProcess, spawnShellProcess, spawnPipeProcess, pipeSessionOf } from '../procexec/index.js'
import type { ProcRunner, ShellSpawner, PipeSpawner } from '../procexec/index.js'
import { BoxesErrorCodes } from '../types.js'
import { BoxesSshErrorCodes, SSH_BOX_CAPS, buildRemoteScript, sshQuote } from '../backend-ssh/index.js'
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
} from '../types.js'

export interface AdbBoxBackendOptions {
  /** 设备序列号（USB）或 wifi 地址（`192.168.1.x:5555`——adb connect 后同为 -s 目标） */
  host: string
  /** Box 内默认工作目录（Android 免 root 可写标准位） */
  workdir?: string
  /** 子进程执行器注入（测试脚本化替身） */
  run?: ProcRunner
  /** 交互进程启动器注入（测试替身断言 argv） */
  spawnShell?: ShellSpawner
  /** 管道进程启动器注入（测试替身断言 argv） */
  spawnPipe?: PipeSpawner
  now?: () => number
}

/** boxId 派生（adb- 前缀 + 序列号净化——kernel 路由层与后端共用，跨重启稳定） */
export const adbBoxId = (host: string): string => `adb-${host.replace(/[^a-zA-Z0-9.-]/g, '-')}`

/** adb 基础 argv：-s 选定目标设备（多设备并存互不串线；wire/wifi 地址同为 -s 目标） */
export function adbBaseArgv(host: string, extra: string[] = []): string[] {
  return ['adb', '-s', host, ...extra]
}

export class AdbBoxBackend implements BoxBackend {
  readonly id = 'adb'
  readonly #host: string
  readonly #workdir: string
  readonly #run: ProcRunner
  readonly #spawnShell: ShellSpawner
  readonly #spawnPipe: PipeSpawner
  readonly #now: () => number
  readonly #boxId: BoxId
  #attached = false
  #spec: BoxSpec | null = null

  constructor(options: AdbBoxBackendOptions) {
    this.#host = options.host
    this.#workdir = options.workdir ?? '/data/local/tmp/openbot'
    this.#run = options.run ?? runProcess
    this.#spawnShell = options.spawnShell ?? spawnShellProcess
    this.#spawnPipe = options.spawnPipe ?? spawnPipeProcess
    this.#now = options.now ?? (() => 0)
    this.#boxId = adbBoxId(options.host)
  }

  caps(): BoxCaps {
    return { ...SSH_BOX_CAPS }
  }

  /** create = attach（裁定 C）：连通验证 + 工作目录确保 + 记账；幂等（已附着零网络往返） */
  async create(spec: BoxSpec): Promise<BoxId> {
    if (this.#attached) return this.#boxId
    const r = await this.#run({
      command: [...adbBaseArgv(this.#host, ['shell']), 'echo ok'],
      timeoutMs: 30_000,
    })
    if (r.exitCode !== 0 || !r.stdout.includes('ok')) {
      const detail = (r.stderr || r.stdout).trim() || '设备未在场'
      throw new KernelError(BoxesSshErrorCodes.BOX_CREATE_FAILED, `adb 连接失败（exit ${r.exitCode}）：${detail}——请用 adb devices 核对序列号`)
    }
    const init = await this.#run({
      command: [...adbBaseArgv(this.#host, ['shell']), `mkdir -p ${sshQuote(this.#workdir)}`],
      timeoutMs: 60_000,
    })
    if (init.exitCode !== 0) {
      throw new KernelError(
        BoxesSshErrorCodes.BOX_CREATE_FAILED,
        `Box 工作目录初始化失败（exit ${init.exitCode}）：${init.stderr.trim()}`,
      )
    }
    this.#attached = true
    this.#spec = { ...spec }
    return this.#boxId
  }

  async exec(boxId: BoxId, spec: ExecSpec): Promise<ExecResult> {
    this.#require(boxId)
    const r = await this.#run({
      command: [...adbBaseArgv(this.#host, ['shell']), buildRemoteScript(spec.command, spec, this.#workdir)],
      timeoutMs: spec.timeoutMs,
      onChunk: spec.onChunk,
      ...(spec.signal !== undefined ? { signal: spec.signal } : {}),
    })
    if (r.aborted) {
      throw new KernelError(BoxesErrorCodes.BOX_EXEC_ABORTED, `exec 已中止：${spec.command.join(' ')}`)
    }
    if (r.timedOut) {
      throw new KernelError(BoxesSshErrorCodes.BOX_EXEC_TIMEOUT, `exec 超时（${spec.timeoutMs}ms）：${spec.command.join(' ')}`)
    }
    return { exitCode: r.exitCode ?? -1, stdout: r.stdout, stderr: r.stderr }
  }

  async openShell(boxId: BoxId, _opts: ShellOpenOptions = {}): Promise<ShellSession> {
    this.#require(boxId)
    // -t 强制分配 PTY（设备端 mksh 交互）；Windows 无 stty 等价物——80×24 缺省记档
    const proc = this.#spawnShell([...adbBaseArgv(this.#host, ['-tt', 'shell'])])
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

  async openPipe(boxId: BoxId, spec: PipeSpec): Promise<PipeSession> {
    this.#require(boxId)
    // adb shell 无 -T/-t 分化——stdout 二进制纯净性由采集命令自保（screenrecord 原始字节直出；
    // 若设备端 sh 引入 \r\n 翻损由消费方容错——b64 行帧方案不受影响）
    const argv = [...adbBaseArgv(this.#host, ['shell']), buildRemoteScript(spec.command, spec, this.#workdir)]
    return pipeSessionOf(this.#spawnPipe(argv))
  }

  async fsRead(boxId: BoxId, path: string): Promise<string | null> {
    const r = await this.exec(boxId, { command: ['cat', path] })
    return r.exitCode === 0 ? r.stdout : null
  }

  async fsWrite(boxId: BoxId, path: string, content: string): Promise<void> {
    this.#require(boxId)
    // 内容走 stdin b64（toybox base64 -d 设备端齐备）；读 EOF 即落盘
    const b64 = Buffer.from(content, 'utf8').toString('base64')
    const r = await this.#run({
      command: [...adbBaseArgv(this.#host, ['shell']), `base64 -d > ${sshQuote(path)}`],
      input: b64,
      timeoutMs: 120_000,
    })
    if (r.exitCode !== 0) {
      throw new KernelError(BoxesErrorCodes.BOX_FS_WRITE_FAILED, `fsWrite 失败（exit ${r.exitCode}）：${r.stderr.trim()}`)
    }
  }

  /** 快照无 per-Box 原语（caps.snapshot=false）——协议层兜底如实拒绝 */
  async snapshot(_boxId: BoxId): Promise<SnapshotId> {
    throw new KernelError(BoxesErrorCodes.BOX_UNSUPPORTED, 'Android 载体不支持快照（caps.snapshot=false）')
  }

  /** 资源统计不适用（设备资源归用户管）——如实空报告 */
  async stats(_boxId: BoxId): Promise<BoxStats> {
    return {}
  }

  /** teardown = 断开（裁定 C）：只清本侧记账，绝不触碰设备 */
  async teardown(boxId: BoxId): Promise<void> {
    this.#require(boxId)
    this.#attached = false
    this.#spec = null
  }

  async list(): Promise<BoxInstance[]> {
    if (!this.#attached || this.#spec === null) return []
    return [
      {
        boxId: this.#boxId,
        spec: { ...this.#spec },
        state: 'active',
        createdAt: this.#now(),
      },
    ]
  }

  #require(boxId: BoxId): void {
    if (boxId !== this.#boxId || !this.#attached) {
      throw new KernelError(BoxesErrorCodes.BOX_NOT_FOUND, `Box 不存在：${boxId}`)
    }
  }
}
