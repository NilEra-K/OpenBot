/**
 * Windows 机内 SSH 后端（plan-screen-firstclass P9-3a 裁定 A/B）：Windows 目标机
 * （VMware Windows 虚机 / 云电脑 / 云主机）装 OpenSSH Server 后即成 Box——
 * 「云电脑/VMWare 终极目标」的结构化正路（宿主屏幕是万能兜底，这条是正主）。
 *
 * **独立类而非 SshBoxBackend 的分支**：POSIX 路径 18 个测试锁死的 argv 形状零扰动；
 * Windows 变体的全部差异收口在 PS 脚本构造——
 * - exec = `powershell -NoProfile -NonInteractive -EncodedCommand <UTF-16LE b64>`
 *   （单 token 传输，对 cmd/powershell 默认 shell 双透明，零引号地狱——裁定 B）；
 * - env/cwd 内联进编码脚本（$env:K='V' / Set-Location——SSH SendEnv 本就不可依赖）；
 * - fsRead/fsWrite 走 [IO.File] 字节等价物（b64 进出，绕 32K 命令行上限走 stdin）；
 * - openShell `ssh -tt` 远端默认 PTY + powershell（Windows 无 stty——80×24 缺省记档）。
 *
 * **attach 语义（裁定 C 延续）**：create = 连通验证 + 工作目录确保 + 记账，teardown 只清账
 * **绝不触碰远端机器**；快照/休眠无 per-Box 原语，caps 如实 ✗（与 SSH 载体同矩阵——隔离
 * high：远端整机是独立机器，输入注入**不经**宿主屏幕的审批闸）。
 *
 * 参考：plan-screen-firstclass.md P9-3a、ARCHITECTURE.md §6、docs/platforms.md Windows 机内节。
 */
import { KernelError } from '@openbot/core'
import { runProcess, spawnShellProcess, spawnPipeProcess, pipeSessionOf } from '../procexec/index.js'
import type { ProcRunner, ShellSpawner, PipeSpawner } from '../procexec/index.js'
import { BoxesErrorCodes } from '../types.js'
import { BoxesSshErrorCodes, SSH_BOX_CAPS, sshBaseArgv } from '../backend-ssh/index.js'
import { psEncodeCommand, psQuote } from '../screen/win-protocol.js'
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

/** boxId 派生（win- 前缀 + 主机名净化——kernel 路由层与后端共用同一公式，跨重启稳定） */
export const windowsBoxId = (host: string): string => `win-${host.replace(/[^a-zA-Z0-9.-]/g, '-')}`

export interface SshWindowsBoxBackendOptions {
  /** 远端主机（IP/主机名） */
  host: string
  /** 端口（缺省 22） */
  port?: number
  /** 登录用户（缺省省略 user@） */
  user?: string
  /** 私钥路径（-i；key-only——BatchMode 下密码提示快速失败，裁定 D 延续） */
  keyPath?: string
  /** Box 内默认工作目录（Windows 路径；create 时确保在场） */
  workdir?: string
  /** 子进程执行器注入（测试脚本化替身） */
  run?: ProcRunner
  /** 交互进程启动器注入（测试替身断言 argv） */
  spawnShell?: ShellSpawner
  /** 管道进程启动器注入（测试替身断言 argv） */
  spawnPipe?: PipeSpawner
  now?: () => number
}

/** PS 单引号包裹（'' 转义）+ EncodedCommand 编码——exec 的**单一构造点**（单测锁死） */
export function buildWindowsScript(
  command: string[],
  opts: { cwd?: string; env?: Record<string, string> },
  workdir: string,
): string {
  const parts: string[] = [`Set-Location -LiteralPath ${psQuote(opts.cwd ?? workdir)}`]
  for (const [k, v] of Object.entries(opts.env ?? {})) parts.push(`$env:${k} = ${psQuote(v)}`)
  // & 调用操作符（PATH 解析 exe；全元素单引号 = 零词切分零展开——与容器 argv 直传语义对齐）
  parts.push(`& ${command.map(psQuote).join(' ')}`)
  // 原生 exe 退出码传导（PS cmdlet 路径 $LASTEXITCODE 可能滞留——exec 语义以原生命令为准）
  parts.push('exit $LASTEXITCODE')
  return parts.join('; ')
}

/** 远端命令行（ssh destination 之后的整串）：powershell + EncodedCommand 单 token */
export function windowsRemoteLine(script: string): string {
  return `powershell -NoProfile -NonInteractive -EncodedCommand ${psEncodeCommand(script)}`
}

export class SshWindowsBoxBackend implements BoxBackend {
  readonly id = 'ssh-windows'
  readonly #host: string
  readonly #port: number
  readonly #user: string | undefined
  readonly #keyPath: string | undefined
  readonly #workdir: string
  readonly #run: ProcRunner
  readonly #spawnShell: ShellSpawner
  readonly #spawnPipe: PipeSpawner
  readonly #now: () => number
  /** 机器即 Box：单一 boxId（win- 前缀 + 主机名净化——跨重启稳定，多 agent 复用） */
  readonly #boxId: BoxId
  #attached = false
  #spec: BoxSpec | null = null

  constructor(options: SshWindowsBoxBackendOptions) {
    this.#host = options.host
    this.#port = options.port ?? 22
    this.#user = options.user
    this.#keyPath = options.keyPath
    this.#workdir = options.workdir ?? 'C:\\openbot-work'
    this.#run = options.run ?? runProcess
    this.#spawnShell = options.spawnShell ?? spawnShellProcess
    this.#spawnPipe = options.spawnPipe ?? spawnPipeProcess
    this.#now = options.now ?? (() => 0)
    this.#boxId = windowsBoxId(options.host)
  }

  caps(): BoxCaps {
    return { ...SSH_BOX_CAPS }
  }

  /** create = attach（裁定 C）：连通验证 + 工作目录确保 + 记账；幂等（已附着零网络往返） */
  async create(spec: BoxSpec): Promise<BoxId> {
    if (this.#attached) return this.#boxId
    const r = await this.#run({
      command: [...this.#baseArgv(), windowsRemoteLine('Write-Output ok')],
      timeoutMs: 30_000,
    })
    if (r.exitCode !== 0) {
      throw new KernelError(
        BoxesSshErrorCodes.BOX_CREATE_FAILED,
        `SSH 连接失败（exit ${r.exitCode}）：${(r.stderr || r.stdout).trim()}`,
      )
    }
    const init = await this.#run({
      command: [
        ...this.#baseArgv(),
        windowsRemoteLine(`New-Item -ItemType Directory -Force -Path ${psQuote(this.#workdir)} | Out-Null; Write-Output ok`),
      ],
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
    return this.#execRaw(boxId, buildWindowsScript(spec.command, spec, this.#workdir), spec)
  }

  /** 原始 PS 脚本执行（内部面——create/fsRead 等自构脚本不走 buildWindowsScript 包装） */
  async #execRaw(
    boxId: BoxId,
    script: string,
    opts: { timeoutMs?: number; onChunk?: ExecSpec['onChunk']; signal?: AbortSignal },
  ): Promise<ExecResult> {
    const r = await this.#run({
      command: [...this.#baseArgv(), windowsRemoteLine(script)],
      timeoutMs: opts.timeoutMs,
      onChunk: opts.onChunk,
      // run 取消/抢占传导：中止即 kill 本地 ssh（连接断开 → sshd 回收会话内进程）
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    })
    if (r.aborted) {
      throw new KernelError(BoxesErrorCodes.BOX_EXEC_ABORTED, 'exec 已中止')
    }
    if (r.timedOut) {
      throw new KernelError(BoxesSshErrorCodes.BOX_EXEC_TIMEOUT, `exec 超时（${opts.timeoutMs}ms）`)
    }
    return { exitCode: r.exitCode ?? -1, stdout: r.stdout, stderr: r.stderr }
  }

  async openShell(boxId: BoxId, _opts: ShellOpenOptions = {}): Promise<ShellSession> {
    this.#require(boxId)
    // -tt 远端分配真 PTY + powershell 交互；Windows 无 stty——80×24 缺省记档（platforms.md）
    const proc = this.#spawnShell([...this.#baseArgv(['-tt']), 'powershell -NoProfile'])
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
    // -T 显式禁 PTY（二进制/行协议纯净——PTY 的 \r\n 翻转会毁帧）；stdin 保持打开（注入通道依赖）
    const argv = [...this.#baseArgv(['-T']), windowsRemoteLine(buildWindowsScript(spec.command, spec, this.#workdir))]
    return pipeSessionOf(this.#spawnPipe(argv))
  }

  async fsRead(boxId: BoxId, path: string): Promise<string | null> {
    const script = `if (Test-Path -LiteralPath ${psQuote(path)}) { [Console]::Out.Write([Convert]::ToBase64String([IO.File]::ReadAllBytes(${psQuote(path)}))) }`
    const r = await this.#execRaw(boxId, script, { timeoutMs: 60_000 })
    return r.exitCode === 0 && r.stdout !== '' ? Buffer.from(r.stdout, 'base64').toString('utf8') : null
  }

  async fsWrite(boxId: BoxId, path: string, content: string): Promise<void> {
    this.#require(boxId)
    // 内容走 stdin b64（绕 32K 命令行上限）；ReadToEnd 到 EOF 即落盘（单次往返零分块）
    const script = `$b = [Convert]::FromBase64String([Console]::In.ReadToEnd()); [IO.File]::WriteAllBytes(${psQuote(path)}, $b)`
    const b64 = Buffer.from(content, 'utf8').toString('base64')
    const r = await this.#run({
      command: [...this.#baseArgv(), windowsRemoteLine(script)],
      input: b64,
      timeoutMs: 120_000,
    })
    if (r.exitCode !== 0) {
      throw new KernelError(BoxesErrorCodes.BOX_FS_WRITE_FAILED, `fsWrite 失败（exit ${r.exitCode}）：${r.stderr.trim()}`)
    }
  }

  /** 快照无 per-Box 原语（caps.snapshot=false）——协议层兜底如实拒绝 */
  async snapshot(_boxId: BoxId): Promise<SnapshotId> {
    throw new KernelError(BoxesErrorCodes.BOX_UNSUPPORTED, 'Windows 机内载体不支持快照（caps.snapshot=false）')
  }

  /** 资源统计不适用（远端机器资源归用户/云厂商管）——如实空报告 */
  async stats(_boxId: BoxId): Promise<BoxStats> {
    return {}
  }

  /** teardown = 断开（裁定 C）：只清本侧记账，绝不触碰远端机器 */
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

  #baseArgv(extraOptions: string[] = []): string[] {
    return sshBaseArgv({ host: this.#host, port: this.#port, user: this.#user, keyPath: this.#keyPath }, extraOptions)
  }

  #require(boxId: BoxId): void {
    if (boxId !== this.#boxId || !this.#attached) {
      throw new KernelError(BoxesErrorCodes.BOX_NOT_FOUND, `Box 不存在：${boxId}`)
    }
  }
}
