/**
 * 运行时启动器（v0.1.89 已装未跑拉起；v0.1.90 跨平台补齐 + 提权链）：按策略 launch 型分派——
 * app（win DD detached 拉起）/ cli（podman machine start、colima start、systemctl start docker——
 * polkit 经 pkexec 包裹，UI 侧先弹确认模态）/ open-app（mac open -a）/ mock（E2E 内存等待）。
 * 引擎就绪轮询 2.5s/5min 如实收敛。取消 = 停等待：DD detached 已拉起进程不杀（裁定）；
 * cli 子进程随 abort 即杀（如实文案区分）。
 * 路径解析三通道（PATH 继承坑——新装后本进程 where 找不到 CLI；mac GUI 进程 PATH 不含 brew 位）：
 * PATH 优先 → 策略 defaultCliPaths / 探测通道回退表 → 双缺如实 RUNTIME_LAUNCH_FAILED。
 * 全部依赖注入（ProcRunner/exists/spawnApp/时长）可单测。
 */
import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { parseMachineList } from '@openbot/boxes'
import type { ProcRunner, ProcResult } from '@openbot/boxes'
import { DOCKER_DESKTOP_WIN_ROOT, PODMAN_WIN_EXE } from './strategies.js'
import type { RuntimeStrategy } from './strategies.js'

export type LaunchPhase = 'launch' | 'ready' | 'canceled'

export interface LaunchEvents {
  onEvent: (payload: { phase: LaunchPhase; detail?: string }) => void
}

/** 就绪轮询缺省节奏（裁定：2–3s 间隔 / 5 分钟超时如实收敛） */
export const LAUNCH_POLL_INTERVAL_MS = 2_500
export const LAUNCH_POLL_TIMEOUT_MS = 5 * 60_000
/** mock 启动停留（E2E 断言窗口——mock 对称不触真系统） */
export const MOCK_LAUNCH_DELAY_MS = 3_000

export interface LaunchDeps {
  run: ProcRunner
  signal?: AbortSignal
  /** 路径在场检查（默认 existsSync——注入可测） */
  exists?: (p: string) => boolean
  /** 拉起桌面应用/open（默认 detached spawn 不等待——注入可测） */
  spawnApp?: (command: string[]) => void
  pollIntervalMs?: number
  pollTimeoutMs?: number
  mockDelayMs?: number
}

/** 就绪探测通道的 CLI 默认位回退表（实现细节不进策略声明——exists 按序探测，跨平台路径天然互不误命中：
 *  win 位只在 win 在场；brew 双位 = Apple Silicon /opt/homebrew + Intel /usr/local；/usr/bin 恒在 PATH 保险） */
export const READY_CLI_FALLBACKS: Record<'docker' | 'podman' | 'colima', string[]> = {
  docker: [`${DOCKER_DESKTOP_WIN_ROOT}\\resources\\bin\\docker.exe`, '/usr/local/bin/docker', '/opt/homebrew/bin/docker', '/usr/bin/docker'],
  podman: [PODMAN_WIN_EXE, '/opt/homebrew/bin/podman', '/usr/local/bin/podman'],
  colima: ['/opt/homebrew/bin/colima', '/usr/local/bin/colima'],
}

/** where 首行（PATH 定位；失败/缺席 → null） */
async function whereFirst(run: ProcRunner, name: string): Promise<string | null> {
  try {
    const r = await run({ command: ['where', name], timeoutMs: 10_000 })
    if (r.exitCode !== 0) return null
    const first = r.stdout.trim().split(/\r?\n/)[0]?.trim()
    return first !== undefined && first !== '' ? first : null
  } catch {
    return null
  }
}

/** CLI 在场（--version exit 0——不碰引擎态） */
async function cliOnPath(run: ProcRunner, name: string): Promise<boolean> {
  try {
    return (await run({ command: [name, '--version'], timeoutMs: 10_000 })).exitCode === 0
  } catch {
    return false
  }
}

/** CLI 解析：PATH 优先 → 默认安装位回退（多路径按序取首个在场） */
export async function resolveCli(
  run: ProcRunner,
  name: string,
  fallbackPaths: string[],
  exists: (p: string) => boolean,
): Promise<string | null> {
  if (await cliOnPath(run, name)) return name
  for (const p of fallbackPaths) if (exists(p)) return p
  return null
}

/** CLI 路径 → DD 安装根：官方布局 docker.exe 在 <root>\resources\bin\ —— bin 上两级即 root */
export function deriveDesktopRoot(cliExePath: string): string {
  return resolve(dirname(cliExePath), '..', '..')
}

/** Docker Desktop.exe 定位（win）：PATH 上 docker 推导（尊重自选安装位）→ 官方默认安装位回退 → null */
export async function resolveDockerDesktopExe(
  run: ProcRunner,
  exists: (p: string) => boolean,
  defaultRoot: string,
): Promise<string | null> {
  const cli = await whereFirst(run, 'docker')
  if (cli !== null) {
    const derived = join(deriveDesktopRoot(cli), 'Docker Desktop.exe')
    if (exists(derived)) return derived
  }
  const fallback = join(defaultRoot, 'Docker Desktop.exe')
  return exists(fallback) ? fallback : null
}

/** 引擎就绪三态（v0.1.90）：unknown = 探测通道异常（CLI 不可寻/命令异常）≠ stopped——
 *  看门狗对 unknown 不触发跃迁（不误报掉线）；就绪轮询把 unknown 当未就绪继续等 */
export type EngineReadyState = 'ready' | 'stopped' | 'unknown'

/** 就绪探测通道（探测 CLI 自解析：PATH → READY_CLI_FALLBACKS 回退——cli/open-app 型与看门狗共用） */
export async function engineReadyOf(
  run: ProcRunner,
  check: 'docker-info' | 'podman-machine' | 'colima-status',
  exists: (p: string) => boolean,
): Promise<EngineReadyState> {
  if (check === 'docker-info') {
    const cli = await resolveCli(run, 'docker', READY_CLI_FALLBACKS.docker, exists)
    if (cli === null) return 'unknown'
    try {
      const r = await run({ command: [cli, 'info', '--format', '{{.ServerVersion}}'], timeoutMs: 10_000 })
      return r.exitCode === 0 ? 'ready' : 'stopped'
    } catch {
      return 'unknown'
    }
  }
  if (check === 'podman-machine') {
    const cli = await resolveCli(run, 'podman', READY_CLI_FALLBACKS.podman, exists)
    if (cli === null) return 'unknown'
    try {
      const r = await run({ command: [cli, 'machine', 'list', '--format', 'json'], timeoutMs: 10_000 })
      if (r.exitCode !== 0) return 'unknown'
      const machines = parseMachineList(r.stdout)
      if (machines === null) return 'unknown'
      return machines.some((m) => m.running) ? 'ready' : 'stopped'
    } catch {
      return 'unknown'
    }
  }
  // colima status：exit 0 = 运行中（非 0 = 未运行/未初始化）
  const cli = await resolveCli(run, 'colima', READY_CLI_FALLBACKS.colima, exists)
  if (cli === null) return 'unknown'
  try {
    return (await run({ command: [cli, 'status'], timeoutMs: 10_000 })).exitCode === 0 ? 'ready' : 'stopped'
  } catch {
    return 'unknown'
  }
}

/** win DD app 型的轻量就绪判据（已解析 cli——轮询每轮不重复解析；probeDocker 同判据） */
async function engineDockerReady(run: ProcRunner, cli: string): Promise<boolean> {
  try {
    return (await run({ command: [cli, 'info', '--format', '{{.ServerVersion}}'], timeoutMs: 10_000 })).exitCode === 0
  } catch {
    return false
  }
}

/** 就绪轮询（纯依赖注入）：间隔探测到 ready / 超时 / abort；onWait 每轮上抛已等秒数（实况 detail） */
export async function pollEngineReady(
  probe: () => Promise<boolean>,
  opts: { intervalMs: number; timeoutMs: number; signal?: AbortSignal; onWait?: (elapsedSec: number) => void },
): Promise<'ready' | 'timeout' | 'canceled'> {
  const start = Date.now()
  for (;;) {
    if (opts.signal?.aborted === true) return 'canceled'
    if (await probe()) return 'ready'
    const elapsed = Date.now() - start
    if (elapsed >= opts.timeoutMs) return 'timeout'
    opts.onWait?.(Math.floor(elapsed / 1000))
    await sleep(opts.intervalMs, opts.signal)
  }
}

/** 可中止等待（signal 触发即提前返回——轮询循环顶部收敛 canceled） */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((res) => {
    if (signal?.aborted === true) {
      res()
      return
    }
    const done = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      res()
    }
    const timer = setTimeout(done, ms)
    signal?.addEventListener('abort', done, { once: true })
  })
}

/** 默认拉起：detached + stdio ignore + unref（GUI 应用/open 自有生命周期——本进程退出不连带） */
function defaultSpawnApp(command: string[]): void {
  spawn(command[0]!, command.slice(1), { detached: true, stdio: 'ignore' }).unref()
}

/** 启动子命令结算：abort → canceled（事件内收敛）；polkit 无 agent（126/127）→ 带手动命令指引的
 *  稳定失败；授权取消（stderr cancel/denied/dismiss）→ canceled 如实；exit 非 0 → 抛错（stderr 如实） */
function settleStartRun(
  r: ProcResult,
  label: string,
  polkit: boolean,
  signal: AbortSignal | undefined,
  events: LaunchEvents,
): 'canceled' | undefined {
  if (signal?.aborted === true || r.aborted) {
    events.onEvent({ phase: 'canceled', detail: '已取消等待——启动命令已中止' })
    return 'canceled'
  }
  if (polkit && (r.exitCode === 126 || r.exitCode === 127)) {
    throw new Error(`RUNTIME_LAUNCH_FAILED：系统无 polkit 图形授权组件（pkexec 不可用）——请手动执行：sudo ${label}`)
  }
  if (r.exitCode !== 0 && /cancel|denied|dismiss/i.test(r.stderr)) {
    events.onEvent({ phase: 'canceled', detail: '已取消系统授权——未做任何更改' })
    return 'canceled'
  }
  if (r.exitCode !== 0) {
    const out = (r.stderr || r.stdout).trim().slice(0, 200)
    throw new Error(`RUNTIME_LAUNCH_FAILED：${label} 失败（exit ${r.exitCode}）：${out}`)
  }
  return undefined
}

/** 轮询到就绪并收敛事件：ready / canceled（事件内收敛）；超时抛错（调用方落 failed） */
async function pollToReady(
  probe: () => Promise<boolean>,
  events: LaunchEvents,
  deps: LaunchDeps,
  timeoutHint: string,
): Promise<'ready' | 'canceled'> {
  const intervalMs = deps.pollIntervalMs ?? LAUNCH_POLL_INTERVAL_MS
  const timeoutMs = deps.pollTimeoutMs ?? LAUNCH_POLL_TIMEOUT_MS
  const outcome = await pollEngineReady(probe, {
    intervalMs,
    timeoutMs,
    ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
    onWait: (sec) =>
      events.onEvent({ phase: 'launch', detail: `等待引擎就绪…（已等 ${sec} 秒，最长 ${Math.round(timeoutMs / 1000)} 秒）` }),
  })
  if (outcome === 'ready') {
    events.onEvent({ phase: 'ready', detail: '引擎已就绪' })
    return 'ready'
  }
  if (outcome === 'canceled') {
    events.onEvent({ phase: 'canceled', detail: '已取消等待——已拉起的程序不受影响' })
    return 'canceled'
  }
  throw new Error(`RUNTIME_LAUNCH_FAILED：等待引擎就绪超时（${Math.round(timeoutMs / 60_000)} 分钟）——${timeoutHint}`)
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && /abort/i.test(err.name)
}

/**
 * 拉起并等待就绪：事件 launch（实况 detail）→ ready | canceled（事件内收敛）| 抛错（调用方落 failed）。
 * 返回终态供调用方记账（mock 台账只在 ready 置位——canceled 不算运行）。
 */
export async function runLaunch(
  strategy: RuntimeStrategy,
  events: LaunchEvents,
  deps: LaunchDeps,
): Promise<'ready' | 'canceled'> {
  const exists = deps.exists ?? existsSync
  const signal = deps.signal
  const launch = strategy.launch
  try {
    if (launch?.kind === 'mock') {
      events.onEvent({ phase: 'launch', detail: 'Mock 引擎启动中（E2E）…' })
      await sleep(deps.mockDelayMs ?? MOCK_LAUNCH_DELAY_MS, signal)
      if (signal?.aborted === true) {
        events.onEvent({ phase: 'canceled', detail: '已取消等待——未做任何更改' })
        return 'canceled'
      }
      events.onEvent({ phase: 'ready', detail: '引擎已就绪' })
      return 'ready'
    }
    if (launch?.kind === 'app') {
      const exe = await resolveDockerDesktopExe(deps.run, exists, launch.defaultRoot)
      if (exe === null) {
        throw new Error('RUNTIME_LAUNCH_FAILED：未找到 Docker Desktop.exe——请从开始菜单手动启动')
      }
      ;(deps.spawnApp ?? defaultSpawnApp)([exe])
      events.onEvent({
        phase: 'launch',
        detail: '已拉起 Docker Desktop——等待引擎就绪（首次启动需完成初始化，可能需数分钟）…',
      })
      // CLI 探测通道：PATH 优先，回退按已定位 exe 反推官方 bin 布局（同根必同布局）
      const cli =
        (await resolveCli(deps.run, 'docker', READY_CLI_FALLBACKS.docker, exists)) ??
        join(dirname(exe), 'resources', 'bin', 'docker.exe')
      return await pollToReady(
        () => engineDockerReady(deps.run, cli),
        events,
        deps,
        'Docker Desktop 可能仍在初始化——完成后状态会自动更新，也可稍后重试启动',
      )
    }
    if (launch?.kind === 'open-app') {
      ;(deps.spawnApp ?? defaultSpawnApp)(['open', '-a', launch.appName])
      events.onEvent({
        phase: 'launch',
        detail: `已拉起 ${launch.appName}——等待引擎就绪（首次启动需完成初始化，可能需数分钟）…`,
      })
      return await pollToReady(
        async () => (await engineReadyOf(deps.run, launch.readyCheck, exists)) === 'ready',
        events,
        deps,
        '应用可能仍在初始化——完成后状态会自动更新，也可稍后重试启动',
      )
    }
    if (launch?.kind === 'cli') {
      const cli = await resolveCli(deps.run, launch.cli, launch.defaultCliPaths ?? [], exists)
      if (cli === null) {
        throw new Error(`RUNTIME_LAUNCH_FAILED：未找到 ${launch.cli} CLI——请确认已安装`)
      }
      const label = `${cli} ${launch.startArgs.join(' ')}`
      const polkit = launch.elevation === 'polkit'
      const timeoutMs = deps.pollTimeoutMs ?? LAUNCH_POLL_TIMEOUT_MS
      const command = polkit ? ['pkexec', cli, ...launch.startArgs] : [cli, ...launch.startArgs]
      events.onEvent({
        phase: 'launch',
        detail: polkit
          ? `pkexec ${label}（系统将弹授权框）…`
          : `${label}${launch.startArgs.includes('start') ? '（首次启动可能需数分钟）…' : '…'}`,
      })
      const r = await deps.run({ command, timeoutMs, ...(signal !== undefined ? { signal } : {}) })
      const settled = settleStartRun(r, label, polkit, signal, events)
      if (settled === 'canceled') return 'canceled'
      return await pollToReady(
        async () => (await engineReadyOf(deps.run, launch.readyCheck, exists)) === 'ready',
        events,
        deps,
        '引擎可能仍在启动——完成后状态会自动更新',
      )
    }
    throw new Error('RUNTIME_LAUNCH_NOT_SUPPORTED：该运行时未声明应用内启动')
  } catch (err) {
    if (deps.signal?.aborted === true || isAbortError(err)) {
      events.onEvent({ phase: 'canceled', detail: '已取消等待——已拉起的程序不受影响' })
      return 'canceled'
    }
    throw err
  }
}
