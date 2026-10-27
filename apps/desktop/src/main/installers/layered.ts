/**
 * 运行时状态分层探测（v0.1.89 docs/plan-v020-runtime-install.md §5c）：装没装 × 跑没跑。
 * 旧单布尔 available 把「CLI 在但引擎停」压成不可用——真机已装 Docker Desktop 而引擎未跑时，
 * 设置页矩阵行误显「一键安装」（用户报障根因）。本模块只出领域事实（状态 + 稳定码 note），
 * 文案归渲染层；ProcRunner 注入可测（与 packages/boxes probe 同哲学——探测事实源）。
 * CLI 参数由调用方先经 launcher.resolve* 解析（PATH 优先 → 官方默认安装位回退——新装后
 * 本进程 PATH 未含 CLI，探测与启动共用同一解析，事实一致）。
 */
import { parseMachineList } from '@openbot/boxes'
import type { ProcRunner } from '@openbot/boxes'

export type InstallState = 'absent' | 'installed' | 'unknown'
export type EngineState = 'running' | 'stopped' | 'unknown'
/** 引擎未跑的细分事实（渲染层映射文案）：machine-missing = podman 已装但尚无 machine（start 必败） */
export type EngineNote = 'machine-missing'

export interface LayeredProbeResult {
  installState: InstallState
  engineState: EngineState
  note?: EngineNote
}

/**
 * Docker 分层：CLI（或 DD 桌面端）在场 → installed；引擎态 = docker info Server 段
 * （probeDocker 同判据——Engine 停止时 exit 非 0）。CLI 不可寻但 DD exe 在场（装完未重启
 * 应用且装在默认位外）→ engineState unknown 如实（探测通道缺席，不猜）。
 */
export async function probeDockerLayered(
  run: ProcRunner,
  cli: string | null,
  desktopExe: string | null,
): Promise<LayeredProbeResult> {
  if (cli === null) {
    return desktopExe !== null
      ? { installState: 'installed', engineState: 'unknown' }
      : { installState: 'absent', engineState: 'unknown' }
  }
  try {
    const info = await run({ command: [cli, 'info', '--format', '{{.ServerVersion}}'], timeoutMs: 10_000 })
    return { installState: 'installed', engineState: info.exitCode === 0 ? 'running' : 'stopped' }
  } catch {
    // CLI 已由 resolveDockerCli 验证可用——info 异常按引擎未跑收敛（Engine 停止 exit 非 0 是常态）
    return { installState: 'installed', engineState: 'stopped' }
  }
}

/**
 * Podman 分层：machine list 的 Running 字段判引擎态（probePodman 同判据——podman info 返回
 * client 侧信息探不出运行态）。空列表 → stopped + machine-missing（start 必败，UI 分流「需初始化」）；
 * 输出异常/无法解析 → unknown 如实。
 * linux 例外（v0.1.90 修正 v0.1.89 遗留 bug）：linux podman 是 daemonless——无 machine 概念、
 * 无守护进程可启，CLI 在场即恒可用；machine list 探测在 linux 会误报「需初始化」。
 */
export async function probePodmanLayered(
  run: ProcRunner,
  cli: string | null,
  platform: NodeJS.Platform,
): Promise<LayeredProbeResult> {
  if (cli === null) return { installState: 'absent', engineState: 'unknown' }
  if (platform === 'linux') return { installState: 'installed', engineState: 'running' }
  try {
    const r = await run({ command: [cli, 'machine', 'list', '--format', 'json'], timeoutMs: 10_000 })
    if (r.exitCode !== 0) return { installState: 'installed', engineState: 'unknown' }
    const machines = parseMachineList(r.stdout)
    if (machines === null) return { installState: 'installed', engineState: 'unknown' }
    if (machines.some((m) => m.running)) return { installState: 'installed', engineState: 'running' }
    return machines.length === 0
      ? { installState: 'installed', engineState: 'stopped', note: 'machine-missing' }
      : { installState: 'installed', engineState: 'stopped' }
  } catch {
    return { installState: 'installed', engineState: 'unknown' }
  }
}

/** WSL2 分层：wsl --status 过 = 组件可用（按需启动的内核特性，无独立引擎可启——直映射 running）；
 *  不过（未启用/未装）= absent（一键 wsl --install 即修复路径，与旧 available=false 同分流） */
export async function probeWslLayered(run: ProcRunner): Promise<LayeredProbeResult> {
  try {
    const r = await run({ command: ['wsl', '--status'], timeoutMs: 10_000, encoding: 'utf16le' })
    if (r.exitCode === 0) return { installState: 'installed', engineState: 'running' }
    return { installState: 'absent', engineState: 'unknown' }
  } catch {
    return { installState: 'absent', engineState: 'unknown' }
  }
}
