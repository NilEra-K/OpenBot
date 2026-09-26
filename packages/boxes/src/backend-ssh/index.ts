/**
 * SSH 后端（plan-image-firstclass P8-1 阶段一）：机器即 Box——SSH 可达的 Linux 主机/虚机
 * （VMWare、云主机）原样接入，现有 exec/fs/PTY/管道与 GUI 能力零改动工作。
 * 「CLI 即接口」的 SSH 版：Windows 10+ 自带 OpenSSH 客户端，与 wsl.exe 同构，零 npm 依赖。
 *
 * **attach 语义（裁定 C）**：远端机器是用户资产——create = 连通验证 + 记账（附工作目录
 * 初始化），teardown = 断开记账，**绝不销毁远端**；快照/休眠无 per-Box 原语，caps 如实 ✗
 * （vmrun 生命周期组合后端随 P8-5 兑现）。同一后端实例对应一台机器 → 单一 boxId（多 agent
 * 复用同一载体；跨重启 boxId 确定性派生自主机名）。
 *
 * 命令构造：argv 经 POSIX 单引号转义拼成一条远端 sh 串（单元素直传 ssh——本地零 shell 零
 * 注入面；远端登录 shell 解释），env 以 K='V' 前缀注入（SSH SendEnv 受服务端 AcceptEnv
 * 限制，不可依赖）。远端串只含单引号不含双引号（Windows ssh.exe 对嵌入双引号的 argv 再
 * 切分有历史怪癖——单引号串规避）。
 *
 * 超时/中止杀的是本地 ssh 进程——连接断开时 sshd 回收会话内进程（短命令天然收口）；常驻
 * 采集（ffmpeg/注入 sh）的孤儿补刀走 pidfile 模式，由 GuiStreamService 既有 exec 通道完成，
 * 本后端无需特殊处理。
 *
 * 参考：plan-image-firstclass.md P8-1、ARCHITECTURE.md §6、docs/platforms.md SSH 节。
 */
import { KernelError } from '@openbot/core'
import { runProcess, spawnShellProcess, spawnPipeProcess, pipeSessionOf } from '../procexec/index.js'
import type { ProcRunner, ShellSpawner, PipeSpawner } from '../procexec/index.js'
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
} from '../types.js'

/** SSH 载体 caps（platforms.md 矩阵）：隔离 high（整机 VM 级）；snapshot/suspendable 随
 *  P8-5 vmrun 组合后端兑现；resourceLimits 不适用（远端机器资源归用户/云厂商管） */
export const SSH_BOX_CAPS: BoxCaps = {
  persistent: true, // 机器是用户资产，跨应用重启仍在（attach 语义）
  snapshot: false,
  headless: true,
  resourceLimits: false,
  isolation: 'high',
  interactive: true, // ssh -tt 真 PTY（远端 sshd 分配，零本地终端依赖）
  suspendable: false,
}

export const BoxesSshErrorCodes = {
  BOX_EXEC_TIMEOUT: 'BOX_EXEC_TIMEOUT',
  BOX_CREATE_FAILED: 'BOX_CREATE_FAILED',
} as const

export interface SshBoxBackendOptions {
  /** 远端主机（IP/主机名；IPv6 建议用方括号字面量进 host 串） */
  host: string
  /** 端口（缺省 22） */
  port?: number
  /** 登录用户（缺省省略 user@——交给 ~/.ssh/config 与当前用户） */
  user?: string
  /** 私钥路径（-i；缺省走 ssh 默认密钥链。密钥口令不受支持——BatchMode 下快速失败，裁定 D） */
  keyPath?: string
  /** Box 内默认工作目录（exec cwd 缺省值；create 时 mkdir -p） */
  workdir?: string
  /** 子进程执行器注入（默认真实 spawn；测试注入脚本化替身） */
  run?: ProcRunner
  /** 交互进程启动器注入（默认真实 spawn；测试注入替身断言 argv） */
  spawnShell?: ShellSpawner
  /** 管道进程启动器注入（默认真实 spawn；测试注入替身断言 argv） */
  spawnPipe?: PipeSpawner
  now?: () => number
}

/** POSIX 单引号包裹（单引号内的单引号用 '\'' 转义——远端串与路径参数共用；坑⑫同款：
 *  转义序列只经普通字符串构造，不经反引号模板字面量） */
export function sshQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`
}

/** argv → 远端 sh 串（exec/openPipe 共用的单一构造点）：cd 前缀 + env K='V' 前缀 + 全元素
 *  单引号转义。全元素加引号同时消灭词切分与 glob 展开（与容器 exec 的 argv 直传语义对齐——
 *  远端 shell 只做引号解析，不做文件名展开） */
export function buildRemoteScript(
  command: string[],
  opts: { cwd?: string; env?: Record<string, string> },
  workdir: string,
): string {
  const parts: string[] = [`cd ${sshQuote(opts.cwd ?? workdir)}`]
  for (const [k, v] of Object.entries(opts.env ?? {})) parts.push(`${k}=${sshQuote(v)}`)
  for (const arg of command) parts.push(sshQuote(arg))
  return parts.join(' ')
}

/** ssh 基础 argv（两载体共用——POSIX 与 Windows 机内同构；选项全在 destination 之前）。
 *  BatchMode=yes：密码/口令提示一律快速失败（key-only，裁定 D）；accept-new：首连自动
 *  接受新主机键（known_hosts 仍防中途变脸）；ConnectTimeout 只覆盖 TCP 连接段 */
export function sshBaseArgv(
  target: { host: string; port?: number; user?: string; keyPath?: string },
  extraOptions: string[] = [],
): string[] {
  const argv = [
    'ssh',
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=accept-new',
    '-o',
    'ConnectTimeout=10',
    ...extraOptions,
  ]
  if (target.port !== undefined && target.port !== 22) argv.push('-p', String(target.port))
  if (target.keyPath !== undefined) argv.push('-i', target.keyPath)
  argv.push(target.user !== undefined && target.user !== '' ? `${target.user}@${target.host}` : target.host)
  return argv
}

export class SshBoxBackend implements BoxBackend {
  readonly id = 'ssh'
  readonly #host: string
  readonly #port: number
  readonly #user: string | undefined
  readonly #keyPath: string | undefined
  readonly #workdir: string
  readonly #run: ProcRunner
  readonly #spawnShell: ShellSpawner
  readonly #spawnPipe: PipeSpawner
  readonly #now: () => number
  /** 机器即 Box：单一 boxId（主机名净化派生——跨重启稳定，多 agent 复用同一载体） */
  readonly #boxId: BoxId
  #attached = false
  #spec: BoxSpec | null = null

  constructor(options: SshBoxBackendOptions) {
    this.#host = options.host
    this.#port = options.port ?? 22
    this.#user = options.user
    this.#keyPath = options.keyPath
    this.#workdir = options.workdir ?? '/work'
    this.#run = options.run ?? runProcess
    this.#spawnShell = options.spawnShell ?? spawnShellProcess
    this.#spawnPipe = options.spawnPipe ?? spawnPipeProcess
    this.#now = options.now ?? (() => 0)
    this.#boxId = `ssh-${options.host.replace(/[^a-zA-Z0-9.-]/g, '-')}`
  }

  caps(): BoxCaps {
    return { ...SSH_BOX_CAPS }
  }

  /** create = attach（裁定 C）：连通验证 + 工作目录初始化 + 记账；幂等（已附着零网络往返）。
   *  spec.image 无载体意义（SSH 机器不从镜像创建）——如实忽略记档（P8-3 路由层消费该字段） */
  async create(spec: BoxSpec): Promise<BoxId> {
    if (this.#attached) return this.#boxId
    const r = await this.#run({ command: [...this.#baseArgv(), 'true'], timeoutMs: 30_000 })
    if (r.exitCode !== 0) {
      throw new KernelError(
        BoxesSshErrorCodes.BOX_CREATE_FAILED,
        `SSH 连接失败（exit ${r.exitCode}）：${(r.stderr || r.stdout).trim()}`,
      )
    }
    const init = await this.#run({
      command: [...this.#baseArgv(), `mkdir -p ${sshQuote(this.#workdir)}`],
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
      command: [...this.#baseArgv(), buildRemoteScript(spec.command, spec, this.#workdir)],
      timeoutMs: spec.timeoutMs,
      onChunk: spec.onChunk,
      // run 取消/抢占传导：外部中止即 kill 本地 ssh 进程（连接断开 → sshd 回收会话内进程）
      ...(spec.signal !== undefined ? { signal: spec.signal } : {}),
    })
    if (r.aborted) {
      throw new KernelError(BoxesErrorCodes.BOX_EXEC_ABORTED, `exec 已中止：${spec.command.join(' ')}`)
    }
    if (r.timedOut) {
      throw new KernelError(
        BoxesSshErrorCodes.BOX_EXEC_TIMEOUT,
        `exec 超时（${spec.timeoutMs}ms）：${spec.command.join(' ')}`,
      )
    }
    return { exitCode: r.exitCode ?? -1, stdout: r.stdout, stderr: r.stderr }
  }

  async openShell(boxId: BoxId, opts: ShellOpenOptions = {}): Promise<ShellSession> {
    this.#require(boxId)
    // PTY 在远端：-tt 强制分配（本地无终端）；stty 注入尺寸后 exec bash 接管会话
    // （与 wsl/oci 的 script 方案同构——ssh -tt 直接给真 PTY，无需 script 包裹）；
    // 尺寸边界钳制（防 0×0）
    const cols = Math.min(Math.max(Math.trunc(opts.cols ?? 100), 10), 500)
    const rows = Math.min(Math.max(Math.trunc(opts.rows ?? 30), 4), 200)
    const proc = this.#spawnShell([
      ...this.#baseArgv(['-tt']),
      `stty rows ${rows} cols ${cols}; exec bash`,
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

  async openPipe(boxId: BoxId, spec: PipeSpec): Promise<PipeSession> {
    this.#require(boxId)
    // -T 显式禁 PTY（二进制纯净——PTY 的 \r\n 翻转会毁 jpeg 帧）；stdin 保持打开
    // （常驻 `sh -s` 行式注入通道依赖；采集进程 -nostdin 自兜底）
    const argv = [
      ...this.#baseArgv(['-T']),
      buildRemoteScript(spec.command, spec, this.#workdir),
    ]
    return pipeSessionOf(this.#spawnPipe(argv))
  }

  async fsRead(boxId: BoxId, path: string): Promise<string | null> {
    const r = await this.exec(boxId, { command: ['cat', '--', path] })
    return r.exitCode === 0 ? r.stdout : null
  }

  async fsWrite(boxId: BoxId, path: string, content: string): Promise<void> {
    this.#require(boxId)
    // 内容走 stdin（procexec input 泵送）——base64 不进 argv，绕 Windows 32K 命令行上限；
    // 远端 `base64 -d > path` 读到 stdin EOF 即完成落盘（单次往返，零分块）
    const b64 = Buffer.from(content, 'utf8').toString('base64')
    const r = await this.#run({
      command: [...this.#baseArgv(), `base64 -d > ${sshQuote(path)}`],
      input: b64,
      timeoutMs: 120_000,
    })
    if (r.exitCode !== 0) {
      throw new KernelError(
        BoxesErrorCodes.BOX_FS_WRITE_FAILED,
        `fsWrite 失败（exit ${r.exitCode}）：${r.stderr.trim()}`,
      )
    }
  }

  /** 快照无 per-Box 原语（caps.snapshot=false）——协议层兜底如实拒绝（vmrun 链随 P8-5） */
  async snapshot(_boxId: BoxId): Promise<SnapshotId> {
    throw new KernelError(BoxesErrorCodes.BOX_UNSUPPORTED, 'SSH 载体不支持快照（caps.snapshot=false）')
  }

  /** 资源统计不适用（远端机器资源归用户/云厂商管）——如实空报告（字段缺席=不可测） */
  async stats(_boxId: BoxId): Promise<BoxStats> {
    return {}
  }

  /** teardown = 断开（裁定 C）：只清本侧记账，**绝不触碰远端机器** */
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

  /** ssh 基础 argv（共享构造 sshBaseArgv——Windows 机内后端逐字节同一套选项语义） */
  #baseArgv(extraOptions: string[] = []): string[] {
    return sshBaseArgv({ host: this.#host, port: this.#port, user: this.#user, keyPath: this.#keyPath }, extraOptions)
  }

  #require(boxId: BoxId): void {
    if (boxId !== this.#boxId || !this.#attached) {
      throw new KernelError(BoxesErrorCodes.BOX_NOT_FOUND, `Box 不存在：${boxId}`)
    }
  }
}
