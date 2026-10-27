/**
 * 运行时启动器（v0.1.89 docs/plan-v020-runtime-install.md §5c）：已装未跑运行时的应用内拉起
 * + 引擎就绪轮询。win 先行（DD 桌面应用 detached 拉起 / podman machine start 子命令），
 * linux/mac backlog（策略未声明 launch 即无启动钮）。取消 = 停等待：DD detached 已拉起进程
 * 不杀（用户裁定）；machine-start 子进程随 abort 即杀（如实文案区分）。
 * 路径解析三通道（PATH 继承坑——新装后本进程 where 找不到 CLI）：where 优先 → 推导/官方默认
 * 安装位回退 → 双缺如实 RUNTIME_LAUNCH_FAILED。全部依赖注入（ProcRunner/exists/spawnApp/时长）可单测。
 */
import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { parseMachineList } from '@openbot/boxes'
import type { ProcRunner } from '@openbot/boxes'
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
  /** 拉起桌面应用（默认 detached spawn 不等待——注入可测） */
  spawnApp?: (exePath: string) => void
  pollIntervalMs?: number
  pollTimeoutMs?: number
  mockDelayMs?: number
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

/** docker CLI 解析：PATH 优先 → DD 官方默认安装位回退（不重启应用即可探测/启动） */
export async function resolveDockerCli(
  run: ProcRunner,
  exists: (p: string) => boolean,
  defaultRoot: string,
): Promise<string | null> {
  if (await cliOnPath(run, 'docker')) return 'docker'
  const p = join(defaultRoot, 'resources', 'bin', 'docker.exe')
  return exists(p) ? p : null
}

/** podman CLI 解析：PATH 优先 → 官方默认安装位回退（MSI 默认 INSTALLDIR） */
export async function resolvePodmanCli(
  run: ProcRunner,
  exists: (p: string) => boolean,
  defaultCliPath: string,
): Promise<string | null> {
  if (await cliOnPath(run, 'podman')) return 'podman'
  return exists(defaultCliPath) ? defaultCliPath : null
}

/** CLI 路径 → DD 安装根：官方布局 docker.exe 在 <root>\resources\bin\ —— bin 上两级即 root */
export function deriveDesktopRoot(cliExePath: string): string {
  return resolve(dirname(cliExePath), '..', '..')
}

/** Docker Desktop.exe 定位：PATH 上 docker 推导（尊重自选安装位）→ 官方默认安装位回退 → null */
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

/** 默认拉起：detached + stdio ignore + unref（GUI 应用自有生命周期——本进程退出不连带） */
function defaultSpawnApp(exePath: string): void {
  spawn(exePath, { detached: true, stdio: 'ignore' }).unref()
}

/** 引擎就绪判据（与 layered 探测同命令——docker info Server 段 / machine list Running） */
async function engineDockerReady(run: ProcRunner, cli: string): Promise<boolean> {
  try {
    return (await run({ command: [cli, 'info', '--format', '{{.ServerVersion}}'], timeoutMs: 10_000 })).exitCode === 0
  } catch {
    return false
  }
}

async function enginePodmanReady(run: ProcRunner, cli: string): Promise<boolean> {
  try {
    const r = await run({ command: [cli, 'machine', 'list', '--format', 'json'], timeoutMs: 10_000 })
    if (r.exitCode !== 0) return false
    const machines = parseMachineList(r.stdout)
    return machines !== null && machines.some((m) => m.running)
  } catch {
    return false
  }
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
      ;(deps.spawnApp ?? defaultSpawnApp)(exe)
      events.onEvent({
        phase: 'launch',
        detail: '已拉起 Docker Desktop——等待引擎就绪（首次启动需完成初始化，可能需数分钟）…',
      })
      // CLI 探测通道：PATH 优先，回退按已定位 exe 反推官方 bin 布局（同根必同布局）
      const cli =
        (await resolveDockerCli(deps.run, exists, launch.defaultRoot)) ??
        join(dirname(exe), 'resources', 'bin', 'docker.exe')
      return await pollToReady(
        () => engineDockerReady(deps.run, cli),
        events,
        deps,
        'Docker Desktop 可能仍在初始化——完成后状态会自动更新，也可稍后重试启动',
      )
    }
    if (launch?.kind === 'machine-start') {
      const cli = await resolvePodmanCli(deps.run, exists, launch.defaultCliPath)
      if (cli === null) {
        throw new Error('RUNTIME_LAUNCH_FAILED：未找到 podman CLI——请确认已安装')
      }
      events.onEvent({ phase: 'launch', detail: 'podman machine start（首次启动可能需数分钟）…' })
      const timeoutMs = deps.pollTimeoutMs ?? LAUNCH_POLL_TIMEOUT_MS
      const r = await deps.run({
        command: [cli, 'machine', 'start'],
        timeoutMs,
        ...(signal !== undefined ? { signal } : {}),
      })
      // 取消即杀 machine start 子进程（VM 引导中止）——与 DD「已拉起进程不杀」如实区分
      if (signal?.aborted === true || r.aborted) {
        events.onEvent({ phase: 'canceled', detail: '已取消等待——启动命令已中止' })
        return 'canceled'
      }
      if (r.exitCode !== 0) {
        const out = (r.stderr || r.stdout).trim().slice(0, 200)
        throw new Error(`RUNTIME_LAUNCH_FAILED：podman machine start 失败（exit ${r.exitCode}）：${out}`)
      }
      return await pollToReady(
        () => enginePodmanReady(deps.run, cli),
        events,
        deps,
        'machine 可能仍在启动——完成后状态会自动更新',
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
