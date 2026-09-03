/**
 * OCI 底座（P5 Step 5）：容器即 Box——docker / podman CLI 共用一套实现（ARCHITECTURE.md §6
 * 「CLI 即接口」）。薄壳只注入命令名（backend-docker 本步 / backend-podman Step 6），
 * 差异（stats 输出形态、字段名）在解析层容错——真机行为差异靠注入层隔离（procexec 同哲学）。
 *
 * 操作映射：run -d 创建（--cpus/--memory 资源上限）/ exec 执行 / commit 快照（镜像即快照）/
 * stats --no-stream 资源统计 / pause-unpause 休眠唤醒 / rm -f 销毁 / ps -a 清单。
 *
 * caps 如实（platforms.md 矩阵）：persistent 弱（容器层存活于 Engine 生命周期，真持久需卷挂载——
 * 一期未挂，UI 弱呈现）、resourceLimits ✓（--cpus/--memory 原生）、isolation medium（namespace
 * 隔离，强于 WSL 的 /mnt/c 直通）、suspendable ✓（pause 原生）、snapshot ✓（commit——commit
 * 默认自动 pause 文件系统冻结，与 wsl 的 terminate-再-export 同一致性语义）。
 *
 * 地雷对照（docs/platforms.md）：
 * - podman start 对运行中容器报错（docker 是 no-op）——先 ps 查状态再动作，不盲调组合；
 * - docker stats --format json 输出单行对象（字段 CPUPerc），podman 输出 JSON 数组（字段 CPU）
 *   ——parseOciStats 双格式容错，注入单测锁样本；
 * - CLI 子进程方案天然屏蔽端点差异（Docker 命名管道 / podman unix socket）。
 */
import { KernelError } from '@openbot/core'
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

/** OCI 后端 caps（docker/podman 同矩阵——platforms.md 诚实版） */
export const OCI_BOX_CAPS: BoxCaps = {
  // 容器可写层随容器存在（Engine 重启容器仍在）；teardown/回滚 rm 即丢——真持久需卷挂载（一期未挂）
  persistent: false,
  snapshot: true,
  headless: true,
  resourceLimits: true,
  isolation: 'medium',
  // PTY：容器内 script 分配真终端（与 backend-wsl 同构——Windows 侧只是字节管道）；
  // 依赖镜像含 util-linux（ubuntu 默认 ✓）；Step 8 真机验收，不通用如实降 caps 记档
  interactive: true,
  suspendable: true,
}

/** 容器名前缀（list() 据此识别我们的 Box；用户自建容器不碰） */
export const OCI_BOX_PREFIX = 'openbot-box-'

/** 快照镜像仓库名（commit 产物：openbot-snap:N——镜像即快照） */
export const OCI_SNAPSHOT_REPO = 'openbot-snap'

export const BoxesOciErrorCodes = {
  BOX_EXEC_TIMEOUT: 'BOX_EXEC_TIMEOUT',
  BOX_CREATE_FAILED: 'BOX_CREATE_FAILED',
  BOX_SNAPSHOT_FAILED: 'BOX_SNAPSHOT_FAILED',
  BOX_PAUSE_FAILED: 'BOX_PAUSE_FAILED',
  BOX_RESUME_FAILED: 'BOX_RESUME_FAILED',
  BOX_RESTORE_FAILED: 'BOX_RESTORE_FAILED',
  /** 容器状态查询失败（ps 不可达——Engine 掉线等） */
  BOX_STATE_QUERY_FAILED: 'BOX_STATE_QUERY_FAILED',
} as const

export interface OciBackendOptions {
  /** 后端 id（registry 路由键）——薄壳注入（'docker' / 'podman'） */
  id: string
  /** CLI 可执行名（docker / podman）——底座差异的唯一来源 */
  cli: string
  /** 默认镜像（BoxSpec.image==='default'/'oci'/缺失时使用；其余值透传镜像名） */
  image?: string
  /** 子进程执行器注入（默认真实 spawn；测试注入脚本化替身） */
  run?: ProcRunner
  /** 交互进程启动器注入（默认真实 spawn；测试注入替身断言 argv） */
  spawnShell?: ShellSpawner
  now?: () => number
  nextBoxId?: () => BoxId
  /** Box 内默认工作目录（exec cwd 缺省值） */
  workdir?: string
}

/** 薄壳初始化参数（id/cli 由薄壳定死——调用方只给行为选项） */
export type OciShellOptions = Omit<OciBackendOptions, 'id' | 'cli'>

interface OciBox {
  name: string
  spec: BoxSpec
  createdAt: number
}

/** 容器运行态规范化（ps .State 文本前缀 → 决策态） */
type ContainerState = 'up' | 'paused' | 'stopped' | 'missing'

export class OciBoxBackend implements BoxBackend {
  readonly id: string
  readonly #cli: string
  readonly #image: string
  readonly #run: ProcRunner
  readonly #spawnShell: ShellSpawner
  readonly #now: () => number
  readonly #nextBoxId: () => BoxId
  readonly #workdir: string
  readonly #boxes = new Map<BoxId, OciBox>()
  #snapshotCounter = 0

  constructor(options: OciBackendOptions) {
    this.id = options.id
    this.#cli = options.cli
    this.#image = options.image ?? 'ubuntu:24.04'
    this.#run = options.run ?? runProcess
    this.#spawnShell = options.spawnShell ?? spawnShellProcess
    this.#now = options.now ?? (() => 0)
    let counter = 0
    this.#nextBoxId = options.nextBoxId ?? (() => `box-${++counter}`)
    this.#workdir = options.workdir ?? '/work'
  }

  caps(): BoxCaps {
    return { ...OCI_BOX_CAPS }
  }

  async create(spec: BoxSpec): Promise<BoxId> {
    const boxId = this.#nextBoxId()
    const name = `${OCI_BOX_PREFIX}${boxId}`
    const image = spec.image !== 'default' && spec.image !== 'oci' && spec.image !== '' ? spec.image : this.#image
    // 跨重启幂等：容器已存在则复用（Box 持久化真相，与 wsl --import 幂等同语义）——
    // 桌面每次启动都为名册 agent 重建 Box，无条件 run 会在第二次启动时同名冲突
    if ((await this.#stateOf(name)) === 'missing') {
      const args = [this.#cli, 'run', '-d', '--name', name]
      if (spec.cpus !== undefined) args.push('--cpus', String(spec.cpus))
      if (spec.memoryMb !== undefined) args.push('--memory', `${spec.memoryMb}m`)
      args.push(image, 'sleep', 'infinity')
      // 首次创建本地无镜像时 CLI 自动拉取（国内网络可能慢——timeout 同 wsl import 量级）
      const r = await this.#run({ command: args, timeoutMs: 10 * 60_000 })
      if (r.exitCode !== 0) {
        throw new KernelError(
          BoxesOciErrorCodes.BOX_CREATE_FAILED,
          `容器创建失败（exit ${r.exitCode}）：${(r.stderr || r.stdout).trim()}`,
        )
      }
    } else {
      // Engine 重启后容器可能 Exited——自然拉起（休眠语义）
      await this.#ensureRunning(name)
    }
    // 初始化工作目录：镜像无预设目录（mkdir -p 幂等；已存在的容器同样安全）
    const init = await this.#cliRun(['exec', name, 'mkdir', '-p', this.#workdir], 120_000)
    if (init.exitCode !== 0) {
      throw new KernelError(
        BoxesOciErrorCodes.BOX_CREATE_FAILED,
        `Box 工作目录初始化失败（exit ${init.exitCode}）：${init.stderr.trim()}`,
      )
    }
    this.#boxes.set(boxId, { name, spec, createdAt: this.#now() })
    return boxId
  }

  async exec(boxId: BoxId, spec: ExecSpec): Promise<ExecResult> {
    const box = this.#require(boxId)
    // 自然唤醒（WSL 语义对等）：Paused→unpause / Exited→start（先查后动——podman start 对运行中
    // 容器报错而 docker 是 no-op，盲调组合有 CLI 差异地雷）
    await this.#ensureRunning(box.name)
    const command = [this.#cli, 'exec', '-w', spec.cwd ?? this.#workdir]
    for (const [k, v] of Object.entries(spec.env ?? {})) command.push('-e', `${k}=${v}`)
    // 坑⑮（CLI 方言，podman 真机首证）：不带 '--' 分隔符——docker CLI 认它为选项结束符，
    // podman/crun 原样传给运行时当可执行名（"crun: executable file `--` not found"）；脚本化
    // 单测 mock 的 ProcRunner 抓不到此层（v0.0.26 记档「真机剩余风险」的应验）。容器名在前
    // 命令在后本无歧义（首元素是程序名不以 - 开头）——与 WSL env 的坑⑭同族修法：去掉 --
    command.push(box.name, ...spec.command)
    const r = await this.#run({
      command,
      timeoutMs: spec.timeoutMs,
      onChunk: spec.onChunk,
      // run 取消/抢占传导：外部中止即 kill CLI 进程（与超时 kill 同型）
      ...(spec.signal !== undefined ? { signal: spec.signal } : {}),
    })
    if (r.aborted) {
      throw new KernelError(BoxesErrorCodes.BOX_EXEC_ABORTED, `exec 已中止：${spec.command.join(' ')}`)
    }
    if (r.timedOut) {
      throw new KernelError(
        BoxesOciErrorCodes.BOX_EXEC_TIMEOUT,
        `exec 超时（${spec.timeoutMs}ms）：${spec.command.join(' ')}`,
      )
    }
    return { exitCode: r.exitCode ?? -1, stdout: r.stdout, stderr: r.stderr }
  }

  async openShell(boxId: BoxId, opts: ShellOpenOptions = {}): Promise<ShellSession> {
    const box = this.#require(boxId)
    await this.#ensureRunning(box.name)
    // PTY 在容器内：script 给 bash 分配真终端，Windows 侧只是字节管道（零原生模块，与 WSL 同构）；
    // -i 不带 -t（-t 需要宿主终端，字节管道下不可用）；尺寸边界钳制（防 0×0）
    const cols = Math.min(Math.max(Math.trunc(opts.cols ?? 100), 10), 500)
    const rows = Math.min(Math.max(Math.trunc(opts.rows ?? 30), 4), 200)
    const proc = this.#spawnShell([
      this.#cli, 'exec', '-i', box.name,
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
    // base64 中转：内容经 argv 传入零引号地狱；容器侧 base64 -d 落盘（与 wsl 同款）
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
    // commit 默认自动 pause 文件系统再提交（docker/podman 同语义）——运行中容器的快照一致性
    // 由 CLI 保证，与 wsl 的 terminate-再-export 等价，无需额外暂停
    const r = await this.#cliRun(
      ['commit', box.name, `${OCI_SNAPSHOT_REPO}:${snapshotId}`],
      10 * 60_000,
    )
    if (r.exitCode !== 0) {
      throw new KernelError(
        BoxesOciErrorCodes.BOX_SNAPSHOT_FAILED,
        `快照提交失败（exit ${r.exitCode}）：${(r.stderr || r.stdout).trim()}`,
      )
    }
    return snapshotId
  }

  async stats(boxId: BoxId): Promise<BoxStats> {
    const box = this.#require(boxId)
    // cpuPercent/memoryMb 真值（P5 Step 7 仪表解锁的数据源）；WSL 维持如实缺席（对照纪律）
    const r = await this.#cliRun(['stats', '--no-stream', '--format', 'json', box.name], 30_000)
    if (r.exitCode !== 0) return {} // Engine 瞬时不可达：如实空报告（同 wsl stats 的 catch 语义）
    return parseOciStats(r.stdout)
  }

  async pause(boxId: BoxId): Promise<void> {
    const box = this.#require(boxId)
    const r = await this.#cliRun(['pause', box.name], 60_000)
    if (r.exitCode !== 0) {
      throw new KernelError(
        BoxesOciErrorCodes.BOX_PAUSE_FAILED,
        `容器休眠失败（exit ${r.exitCode}）：${(r.stderr || r.stdout).trim()}`,
      )
    }
  }

  async resume(boxId: BoxId): Promise<void> {
    const box = this.#require(boxId)
    // 唤醒 = 确保运行：Paused→unpause / Exited→start（同一「拉起」语义，exec 自然唤醒同路径）
    await this.#ensureRunning(box.name)
  }

  /** 快照链（P4 Step 9 接口）：images 列 tag + inspect 补真值（Size 字节 / Created RFC3339） */
  async listSnapshots(): Promise<SnapshotInfo[]> {
    const r = await this.#cliRun(['images', OCI_SNAPSHOT_REPO, '--format', '{{.Tag}}'], 30_000)
    if (r.exitCode !== 0) return [] // 仓库不存在=尚无快照（如实空链）
    const tags = r.stdout
      .split(/\r?\n/)
      .map((t) => t.trim())
      .filter((t) => /^snap-\d+$/.test(t))
    const infos: SnapshotInfo[] = []
    for (const tag of tags) {
      const info: SnapshotInfo = { snapshotId: tag }
      const ir = await this.#cliRun(
        ['image', 'inspect', `${OCI_SNAPSHOT_REPO}:${tag}`, '--format', '{{.Size}}|{{.Created}}'],
        30_000,
      )
      if (ir.exitCode === 0) {
        const [size, created] = ir.stdout.trim().split('|')
        const n = Number(size)
        if (Number.isFinite(n) && n > 0) info.sizeBytes = n
        const t = Date.parse(created ?? '')
        if (Number.isFinite(t)) info.createdAt = t
      }
      infos.push(info)
    }
    return infos.sort((a, b) => Number(b.snapshotId.slice(5)) - Number(a.snapshotId.slice(5)))
  }

  /** 回滚（P4 Step 9 接口）：**破坏性**——容器删除后从快照镜像重建。
   *  顺序保安全：先校验快照镜像在场再删容器（镜像缺失时容器原样保留——失败窗口比 wsl 版更小） */
  async restore(boxId: BoxId, snapshotId: SnapshotId): Promise<void> {
    const box = this.#require(boxId)
    if (!/^snap-\d+$/.test(snapshotId)) {
      throw new KernelError(BoxesOciErrorCodes.BOX_RESTORE_FAILED, `非法快照 id：${snapshotId}`)
    }
    const image = `${OCI_SNAPSHOT_REPO}:${snapshotId}`
    const chk = await this.#cliRun(['image', 'inspect', image, '--format', '{{.Id}}'], 30_000)
    if (chk.exitCode !== 0) {
      throw new KernelError(BoxesOciErrorCodes.BOX_RESTORE_FAILED, `快照镜像不存在：${image}`)
    }
    const rm = await this.#cliRun(['rm', '-f', box.name], 60_000)
    if (rm.exitCode !== 0) {
      throw new KernelError(
        BoxesOciErrorCodes.BOX_RESTORE_FAILED,
        `回滚删除容器失败（exit ${rm.exitCode}）：${(rm.stderr || rm.stdout).trim()}`,
      )
    }
    const args = [this.#cli, 'run', '-d', '--name', box.name]
    if (box.spec.cpus !== undefined) args.push('--cpus', String(box.spec.cpus))
    if (box.spec.memoryMb !== undefined) args.push('--memory', `${box.spec.memoryMb}m`)
    args.push(image, 'sleep', 'infinity')
    const run = await this.#run({ command: args, timeoutMs: 10 * 60_000 })
    if (run.exitCode !== 0) {
      throw new KernelError(
        BoxesOciErrorCodes.BOX_RESTORE_FAILED,
        `回滚重建容器失败（exit ${run.exitCode}）：${(run.stderr || run.stdout).trim()}——容器已删除，可用同一快照重试恢复`,
      )
    }
  }

  async teardown(boxId: BoxId): Promise<void> {
    const box = this.#require(boxId)
    const r = await this.#cliRun(['rm', '-f', box.name], 60_000)
    if (r.exitCode !== 0) {
      throw new KernelError(
        BoxesErrorCodes.BOX_NOT_FOUND,
        `容器删除失败（exit ${r.exitCode}）：${(r.stderr || r.stdout).trim()}`,
      )
    }
    this.#boxes.delete(boxId)
  }

  async list(): Promise<BoxInstance[]> {
    // 跨重启恢复真相：容器存在即 Box 存在（前缀精确过滤——用户自建容器不碰）
    const r = await this.#cliRun(
      ['ps', '-a', '--filter', `name=${OCI_BOX_PREFIX}`, '--format', '{{.Names}}\t{{.State}}'],
      30_000,
    )
    if (r.exitCode !== 0) {
      throw new KernelError(
        BoxesOciErrorCodes.BOX_STATE_QUERY_FAILED,
        `容器清单查询失败（exit ${r.exitCode}）：${(r.stderr || r.stdout).trim()}`,
      )
    }
    const out: BoxInstance[] = []
    for (const line of r.stdout.split(/\r?\n/)) {
      const [name, state] = line.trim().split('\t')
      if (name === undefined || state === undefined || !name.startsWith(OCI_BOX_PREFIX)) continue
      const boxId = name.slice(OCI_BOX_PREFIX.length)
      const known = this.#boxes.get(boxId)
      const st = state.toLowerCase()
      // 三态映射：Up→active；Paused/Exited→sleeping（资源已释放态，均可自然唤醒）
      const mapped = st.startsWith('up') ? 'active' : 'sleeping'
      out.push({
        boxId,
        spec: known ? { ...known.spec } : { image: this.id },
        state: mapped,
        createdAt: known?.createdAt ?? 0,
      })
    }
    return out
  }

  /** 容器运行态（ps 单容器查询；--filter 是子串匹配——JS 侧精确名过滤） */
  async #stateOf(name: string): Promise<ContainerState> {
    const r = await this.#cliRun(
      ['ps', '-a', '--filter', `name=${name}`, '--format', '{{.Names}}\t{{.State}}'],
      30_000,
    )
    if (r.exitCode !== 0) {
      throw new KernelError(
        BoxesOciErrorCodes.BOX_STATE_QUERY_FAILED,
        `容器状态查询失败（exit ${r.exitCode}）：${(r.stderr || r.stdout).trim()}`,
      )
    }
    for (const line of r.stdout.split(/\r?\n/)) {
      const [n, state] = line.trim().split('\t')
      if (n !== name || state === undefined) continue
      const st = state.toLowerCase()
      if (st.startsWith('up')) return 'up'
      if (st.startsWith('paused')) return 'paused'
      return 'stopped' // exited / created / dead
    }
    return 'missing'
  }

  /** 确保运行（自然唤醒路径）：Paused→unpause / stopped→start / up→直通；missing=容器丢失如实报错 */
  async #ensureRunning(name: string): Promise<void> {
    const st = await this.#stateOf(name)
    if (st === 'up') return
    if (st === 'missing') {
      throw new KernelError(BoxesErrorCodes.BOX_NOT_FOUND, `容器不存在：${name}`)
    }
    const action = st === 'paused' ? 'unpause' : 'start'
    const r = await this.#cliRun([action, name], st === 'paused' ? 60_000 : 120_000)
    if (r.exitCode !== 0) {
      throw new KernelError(
        BoxesOciErrorCodes.BOX_RESUME_FAILED,
        `容器唤醒失败（${action}，exit ${r.exitCode}）：${(r.stderr || r.stdout).trim()}`,
      )
    }
  }

  /** 内部 CLI 直调（管理操作——无 exec 的超时/中止语义包装） */
  #cliRun(args: string[], timeoutMs?: number) {
    return this.#run({ command: [this.#cli, ...args], timeoutMs })
  }

  #require(boxId: BoxId): OciBox {
    const box = this.#boxes.get(boxId)
    if (!box) {
      throw new KernelError(BoxesErrorCodes.BOX_NOT_FOUND, `Box 不存在：${boxId}`)
    }
    return box
  }
}

/**
 * stats 输出解析（docker/podman 双格式容错——真机差异靠此层隔离，注入单测锁样本）：
 * docker stats --no-stream --format json → 单行对象（CPUPerc "0.15%" / MemUsage "1.1MiB / 512MiB"）；
 * podman 同命令 → JSON 数组且字段名 CPU（无 Perc 后缀）。解析失败返回 {}（如实空报告）。
 */
export function parseOciStats(stdout: string): BoxStats {
  const obj = parseStatsObject(stdout)
  if (obj === null) return {}
  const out: BoxStats = {}
  const cpuRaw = obj['CPUPerc'] ?? obj['CPU']
  if (typeof cpuRaw === 'string') {
    const v = Number.parseFloat(cpuRaw.replace('%', ''))
    if (Number.isFinite(v)) out.cpuPercent = Math.round(v * 10) / 10
  }
  const memRaw = obj['MemUsage']
  if (typeof memRaw === 'string') {
    const mb = memUsageToMb(memRaw)
    if (mb !== null) out.memoryMb = mb
  }
  return out
}

/** JSON 容错解析：对象 / 数组取首元素 / 多行对象（docker 某些版本逐行输出）取首个可解析行 */
function parseStatsObject(stdout: string): Record<string, unknown> | null {
  const t = stdout.trim()
  if (t === '') return null
  const pick = (v: unknown): Record<string, unknown> | null =>
    typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  try {
    const v = JSON.parse(t) as unknown
    if (Array.isArray(v)) return pick(v[0])
    return pick(v)
  } catch {
    for (const line of t.split(/\r?\n/)) {
      const lt = line.trim()
      if (lt === '') continue
      try {
        const hit = pick(JSON.parse(lt) as unknown)
        if (hit !== null) return hit
      } catch {
        /* 下一行 */
      }
    }
    return null
  }
}

/** MemUsage "1.1MiB / 512MiB" → MB 数（斜杠前段 + 1024 基单位换算；失败 null） */
export function memUsageToMb(usage: string): number | null {
  const head = usage.split('/')[0]?.trim() ?? ''
  const m = /^([\d.]+)\s*(B|KiB|MiB|GiB|KB|MB|GB|kB)?$/.exec(head)
  if (!m) return null
  const v = Number.parseFloat(m[1]!)
  if (!Number.isFinite(v)) return null
  switch (m[2]) {
    case 'B':
      return Math.round(v / (1024 * 1024))
    case 'KiB':
    case 'kB':
    case 'KB':
      return Math.round(v / 1024)
    case 'GiB':
      return Math.round(v * 1024)
    case 'GB':
      return Math.round(v * 1000)
    default:
      return Math.round(v) // MiB / MB / 无单位按 MB
  }
}

/** POSIX 单引号包裹（单引号内的单引号用 '\'' 转义——仅用于我们内部生成的路径参数） */
function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`
}
