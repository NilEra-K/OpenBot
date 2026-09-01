/**
 * UTM 后端（macOS）：虚拟机即 Box——每个 Box 一台 UTM VM，从用户预建的**模板 VM 克隆**
 * （`utmctl clone --name`；UTM 无 rootfs 导入模型，模板在 UTM GUI 预建并预装 guest agent）。
 * `utmctl exec --cmd` 执行（guest agent 依赖）/ `clone` 快照 / `stop` 休眠 / `delete` 销毁。
 * caps 如实（依据 utmctl 实测命令面——UTMCtl.swift，CLI 即接口，没有就不声明）：
 * 持久化 ✓、快照 ✓（clone/delete 链兑现——快照本体是 VM 克隆非 tar 文件）、headless ✓
 * （**前提模板预装 guest agent**——UTM Guest Suite 全线依赖它，「无人值守：部分」的真义）、
 * 资源上限 ✗（utmctl 无配置入口——update configuration 只在 AppleScript 面）、
 * 隔离 high（VM 级）、交互 ✗（utmctl attach 未实现——源码 WARNING TODO；串口 PTTY 直连记档后置）、
 * 休眠 ✓（stop/start）。
 * 真机链路未验收（P6 裁定 B：CLI 语义单测锁死）——已知边界记 docs/platforms.md：
 * utmctl 需 GUI 登录会话（SSH 会话 errAEEventNotPermitted）；utmctl list 列格式 UUID/pad8 状态/名。
 */
import { KernelError } from '@openbot/core'
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
  SnapshotInfo,
} from '../types.js'

export const UTM_BOX_CAPS: BoxCaps = {
  persistent: true,
  snapshot: true,
  headless: true,
  resourceLimits: false,
  isolation: 'high',
  // utmctl attach 未实现（UTMCtl.swift WARNING TODO）——CLI 即接口，没有就不声明
  interactive: false,
  suspendable: true,
}

/** VM 名前缀（list() 据此识别我们的 Box；用户自建的 VM 与模板不碰） */
export const UTM_BOX_PREFIX = 'openbot-box-'

/** 快照克隆名后缀（listSnapshots 据 `${name}-snap-N` 解析快照链） */
export const UTM_SNAP_SUFFIX = '-snap-'

export const BoxesUtmErrorCodes = {
  BOX_EXEC_TIMEOUT: 'BOX_EXEC_TIMEOUT',
  BOX_CREATE_FAILED: 'BOX_CREATE_FAILED',
  BOX_SNAPSHOT_FAILED: 'BOX_SNAPSHOT_FAILED',
  BOX_PAUSE_FAILED: 'BOX_PAUSE_FAILED',
  BOX_RESUME_FAILED: 'BOX_RESUME_FAILED',
  BOX_RESTORE_FAILED: 'BOX_RESTORE_FAILED',
} as const

export interface UtmBoxBackendOptions {
  /** 模板 VM 名（UTM GUI 预建、预装 guest agent——create 的 clone 源；rootfs 导入模型不适用 UTM） */
  template: string
  /** 子进程执行器注入（默认真实 spawn；测试注入脚本化替身） */
  run?: ProcRunner
  now?: () => number
  nextBoxId?: () => BoxId
  /** Box 内默认工作目录（exec cwd 缺省值） */
  workdir?: string
}

interface UtmBox {
  name: string
  spec: BoxSpec
  createdAt: number
}

/** utmctl list 行（解析纯函数可测）：`UUID(36) status(pad8) name(可含空格)` */
export interface UtmListEntry {
  name: string
  status: string
}

/**
 * utmctl list 解析（纯函数可测）：跳表头，`/^[0-9A-F-]{36}\s+(\S+)\s+(.+)$/` 三段捕获
 * （UUID 定长 36，status 是单 token 词表 stopped/starting/started/pausing/paused/resuming/stopping，
 * name 为剩余整段——VM 名可含空格）。损坏行跳过（如实）。
 */
export function parseUtmList(stdout: string): UtmListEntry[] {
  const out: UtmListEntry[] = []
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^([0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12})\s+(\S+)\s+(.+)$/.exec(line.trim())
    if (m?.[2] !== undefined && m[3] !== undefined) {
      out.push({ name: m[3].trim(), status: m[2] })
    }
  }
  return out
}

export class UtmBoxBackend implements BoxBackend {
  readonly id = 'utm'
  readonly #template: string
  readonly #run: ProcRunner
  readonly #now: () => number
  readonly #nextBoxId: () => BoxId
  readonly #workdir: string
  readonly #boxes = new Map<BoxId, UtmBox>()
  #snapshotCounter = 0
  /** 休眠内存态：stop 置位 / start 与 exec 自然唤醒清除（重启后 VM 由 create 拉起） */
  readonly #sleeping = new Set<BoxId>()

  constructor(options: UtmBoxBackendOptions) {
    this.#template = options.template
    this.#run = options.run ?? runProcess
    this.#now = options.now ?? (() => 0)
    let counter = 0
    this.#nextBoxId = options.nextBoxId ?? (() => `box-${++counter}`)
    this.#workdir = options.workdir ?? '/work'
  }

  caps(): BoxCaps {
    return { ...UTM_BOX_CAPS }
  }

  async create(spec: BoxSpec): Promise<BoxId> {
    const boxId = this.#nextBoxId()
    const name = `${UTM_BOX_PREFIX}${boxId}`
    // 跨重启幂等：同名 VM 已存在则跳过 clone（Box 持久化真相，与 list() 同源判定）——
    // UTM 模型是模板克隆：clone 复制模板全部数据盘，rootfs tar 导入不适用
    if (!(await this.#listEntries()).some((e) => e.name === name)) {
      const r = await this.#run({
        command: ['utmctl', 'clone', this.#template, '--name', name],
        timeoutMs: 30 * 60_000,
      })
      if (r.exitCode !== 0) {
        throw new KernelError(
          BoxesUtmErrorCodes.BOX_CREATE_FAILED,
          `模板克隆失败（exit ${r.exitCode}）：${(r.stderr || r.stdout).trim()}——确认模板 VM「${this.#template}」在场（UTM GUI 预建）`,
        )
      }
    }
    this.#boxes.set(boxId, { name, spec, createdAt: this.#now() })
    await this.#ensureActive(name)
    // 初始化工作目录（exec 依赖 guest agent——模板预装是 headless 的前提，platforms.md 记档）
    const init = await this.#run({
      command: ['utmctl', 'exec', name, '--cmd', '/bin/mkdir', '-p', this.#workdir],
      timeoutMs: 120_000,
    })
    if (init.exitCode !== 0) {
      throw new KernelError(
        BoxesUtmErrorCodes.BOX_CREATE_FAILED,
        `Box 工作目录初始化失败（exit ${init.exitCode}）：${(init.stderr || init.stdout).trim()}——guest agent 未运行？（模板需预装）`,
      )
    }
    return boxId
  }

  async exec(boxId: BoxId, spec: ExecSpec): Promise<ExecResult> {
    const box = this.#require(boxId)
    // 冷 VM 自然唤醒（与显式 resume 同一机制）
    await this.#ensureActive(box.name)
    // --cmd 是 parsing:.remaining（其后所有 token 归命令）；env 经 --env 单值可重复；
    // exec 无工作目录参数——设了 cwd 才走 sh -c 包裹（quote 保护，与 nspawn 同策略）
    const envArgs = Object.entries(spec.env ?? {}).flatMap(([k, v]) => ['--env', `${k}=${v}`])
    const command = ['utmctl', 'exec', box.name, ...envArgs, '--cmd']
    if (spec.cwd !== undefined) {
      // env 经 utmctl --env 注给 /bin/sh，其 exec 的子进程继承——cwd 分支无需重复注入
      const inner = ['cd', shellQuote(spec.cwd), '&&', 'exec', ...spec.command.map(shellQuote)]
      command.push('/bin/sh', '-c', inner.join(' '))
    } else {
      command.push(...spec.command)
    }
    const r = await this.#run({
      command,
      timeoutMs: spec.timeoutMs,
      onChunk: spec.onChunk,
      // run 取消/抢占传导：外部中止即 kill utmctl 进程（与超时 kill 同型）
      ...(spec.signal !== undefined ? { signal: spec.signal } : {}),
    })
    if (r.aborted) {
      throw new KernelError(
        BoxesErrorCodes.BOX_EXEC_ABORTED,
        `exec 已中止：${spec.command.join(' ')}`,
      )
    }
    if (r.timedOut) {
      throw new KernelError(
        BoxesUtmErrorCodes.BOX_EXEC_TIMEOUT,
        `exec 超时（${spec.timeoutMs}ms）：${spec.command.join(' ')}`,
      )
    }
    // exec 会话触发的 VM 运行 = 自然唤醒——休眠标志随真实状态清除
    this.#sleeping.delete(boxId)
    return { exitCode: r.exitCode ?? -1, stdout: r.stdout, stderr: r.stderr }
  }

  async fsRead(boxId: BoxId, path: string): Promise<string | null> {
    const r = await this.exec(boxId, { command: ['/bin/cat', '--', path] })
    return r.exitCode === 0 ? r.stdout : null
  }

  async fsWrite(boxId: BoxId, path: string, content: string): Promise<void> {
    // base64 中转：内容经 argv 传入零引号地狱；guest 侧 base64 -d 落盘
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
    // 关机后再克隆：保证磁盘一致性（clone 是 VM 全量复制，运行中克隆数据盘可能不一致）
    await this.#stopIfRunning(box.name)
    const r = await this.#run({
      command: ['utmctl', 'clone', box.name, '--name', `${box.name}${UTM_SNAP_SUFFIX}${snapshotId}`],
      timeoutMs: 30 * 60_000,
    })
    if (r.exitCode !== 0) {
      throw new KernelError(
        BoxesUtmErrorCodes.BOX_SNAPSHOT_FAILED,
        `快照克隆失败（exit ${r.exitCode}）：${(r.stderr || r.stdout).trim()}`,
      )
    }
    // 快照后 Box 复电（快照语义：继续工作，非休眠）
    await this.#start(box.name)
    return snapshotId
  }

  async stats(_boxId: BoxId): Promise<BoxStats> {
    // utmctl 无资源统计命令（CLI 即接口）——全字段缺席，如实空报告（UI 按在场字段渲染不造假）
    return {}
  }

  async pause(boxId: BoxId): Promise<void> {
    const box = this.#require(boxId)
    // Box 休眠语义 = 释放 CPU/内存：stop 断电（rootfs/数据盘留在磁盘）。
    // 用 --request 优雅关机（默认 force 是断电同效但脏——快照前另有显式停机纪律）
    await this.#stopIfRunning(box.name, '--request')
    this.#sleeping.add(boxId)
  }

  async resume(boxId: BoxId): Promise<void> {
    const box = this.#require(boxId)
    // start 兼 resume（UTM 语义：start a VM or resume a suspended VM）
    await this.#start(box.name)
    this.#sleeping.delete(boxId)
  }

  /** 快照链：list 名册里 `${boxName}-snap-N` 的克隆即快照（UTM 无导出文件——克隆本体是载体） */
  async listSnapshots(): Promise<SnapshotInfo[]> {
    const entries = await this.#listEntries()
    const snaps = new Map<string, SnapshotInfo>()
    for (const { name } of entries) {
      if (!name.startsWith(UTM_BOX_PREFIX)) continue
      const m = new RegExp(`^${UTM_BOX_PREFIX}.+${UTM_SNAP_SUFFIX}(\\d+)$`).exec(name)
      if (!m) continue
      // sizeBytes 不可知（utmctl 名册无体积字段）——如实缺席
      snaps.set(`snap-${m[1]}`, { snapshotId: `snap-${m[1]}` })
    }
    return [...snaps.values()].sort((a, b) => Number(b.snapshotId.slice(5)) - Number(a.snapshotId.slice(5)))
  }

  /** 回滚：**破坏性**——delete 当前后端 VM + clone 快照回原名；失败窗口如实：
   *  delete 成功而 clone 失败时 VM 已删（快照克隆在场即数据可恢复——重新 clone 即可） */
  async restore(boxId: BoxId, snapshotId: SnapshotId): Promise<void> {
    const box = this.#require(boxId)
    const snapName = `${box.name}${UTM_SNAP_SUFFIX}${snapshotId}`
    const entries = await this.#listEntries()
    if (!entries.some((e) => e.name === snapName)) {
      throw new KernelError(
        BoxesUtmErrorCodes.BOX_RESTORE_FAILED,
        `快照不在场：${snapName}`,
      )
    }
    await this.#stopIfRunning(box.name)
    const del = await this.#run({
      command: ['utmctl', 'delete', box.name],
      timeoutMs: 10 * 60_000,
    })
    if (del.exitCode !== 0) {
      throw new KernelError(
        BoxesUtmErrorCodes.BOX_RESTORE_FAILED,
        `回滚删除失败（exit ${del.exitCode}）：${(del.stderr || del.stdout).trim()}`,
      )
    }
    const cl = await this.#run({
      command: ['utmctl', 'clone', snapName, '--name', box.name],
      timeoutMs: 30 * 60_000,
    })
    if (cl.exitCode !== 0) {
      throw new KernelError(
        BoxesUtmErrorCodes.BOX_RESTORE_FAILED,
        `回滚克隆失败（exit ${cl.exitCode}）：${(cl.stderr || cl.stdout).trim()}——VM 已删除，可用同一快照重试恢复`,
      )
    }
    this.#sleeping.delete(boxId)
  }

  async teardown(boxId: BoxId): Promise<void> {
    const box = this.#require(boxId)
    await this.#stopIfRunning(box.name)
    const r = await this.#run({
      command: ['utmctl', 'delete', box.name],
      timeoutMs: 10 * 60_000,
    })
    if (r.exitCode !== 0) {
      throw new KernelError(
        BoxesErrorCodes.BOX_NOT_FOUND,
        `VM 删除失败（exit ${r.exitCode}）：${(r.stderr || r.stdout).trim()}`,
      )
    }
    this.#boxes.delete(boxId)
  }

  async list(): Promise<BoxInstance[]> {
    // 跨重启恢复真相：VM 在名册即 Box 存在（前缀过滤——用户自建 VM 与模板不碰；
    // `${prefix}-snap-N` 的快照克隆不是 Box）
    const entries = (await this.#listEntries()).filter(
      (e) => e.name.startsWith(UTM_BOX_PREFIX) && !new RegExp(`${UTM_SNAP_SUFFIX}\\d+$`).test(e.name),
    )
    return entries.map(({ name }) => {
      const boxId = name.slice(UTM_BOX_PREFIX.length)
      const known = this.#boxes.get(boxId)
      return {
        boxId,
        spec: known ? { ...known.spec } : { image: 'utm' },
        state: (this.#sleeping.has(boxId) ? 'sleeping' : 'active') as BoxInstance['state'],
        createdAt: known?.createdAt ?? 0,
      }
    })
  }

  /** 全量 VM 名册（utmctl list；status 列在 pad8 定宽后——name 是剩余整段可含空格） */
  async #listEntries(): Promise<UtmListEntry[]> {
    const r = await this.#run({ command: ['utmctl', 'list'], timeoutMs: 30_000 })
    if (r.exitCode !== 0) return [] // utmctl/UTM app 不可用——空表如实（探测层呈现原因）
    return parseUtmList(r.stdout)
  }

  /** 冷 VM 拉起（幂等）：status 非 started（含 stopped/paused）→ start（start 兼 resume 挂起） */
  async #ensureActive(name: string): Promise<void> {
    const status = await this.#run({ command: ['utmctl', 'status', name], timeoutMs: 30_000 })
    if (status.stdout.trim() === 'started') return
    await this.#start(name)
  }

  async #start(name: string): Promise<void> {
    const r = await this.#run({ command: ['utmctl', 'start', name], timeoutMs: 120_000 })
    if (r.exitCode !== 0) {
      throw new KernelError(
        BoxesUtmErrorCodes.BOX_RESUME_FAILED,
        `VM 启动失败（exit ${r.exitCode}）：${(r.stderr || r.stdout).trim()}`,
      )
    }
  }

  /** 停机（幂等）：status 是运行态（started/starting/pausing/paused/resuming/stopping）才 stop——
   *  已 stopped 的 VM stop 会报事件错误（AppleScript 面），先查后动与 nspawn poweroff 幂等同策略 */
  async #stopIfRunning(name: string, ...style: string[]): Promise<void> {
    const status = await this.#run({ command: ['utmctl', 'status', name], timeoutMs: 30_000 })
    if (status.stdout.trim() === 'stopped') return
    const r = await this.#run({
      command: ['utmctl', 'stop', name, ...style],
      timeoutMs: 60_000,
    })
    if (r.exitCode !== 0) {
      throw new KernelError(
        BoxesUtmErrorCodes.BOX_PAUSE_FAILED,
        `VM 停机失败（exit ${r.exitCode}）：${(r.stderr || r.stdout).trim()}`,
      )
    }
  }

  #require(boxId: BoxId): UtmBox {
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
