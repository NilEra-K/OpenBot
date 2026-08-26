/**
 * 沙箱后端探测：CLI 存在性与基本可用性——装配决策与设置页状态的事实源。
 * 结果如实（不可用必带 reason，UI 呈现原因不静默假装）；ProcRunner 注入可测
 * （与 backend 实现同一测试哲学）。参考：ARCHITECTURE.md §6 caps 驱动 UI。
 */
import { isSpawnFailure } from '../procexec/index.js'
import type { ProcRunner } from '../procexec/index.js'

export type SandboxBackendId = 'mock' | 'wsl' | 'docker' | 'podman'

export interface BackendProbe {
  id: SandboxBackendId
  available: boolean
  /** 不可用原因（如实呈现给用户；available 时省略） */
  reason?: string
}

const probeCli = async (
  id: SandboxBackendId,
  command: string[],
  run: ProcRunner,
  encoding?: 'utf16le',
  unavailableNote?: string,
): Promise<BackendProbe> => {
  try {
    const r = await run({ command, encoding, timeoutMs: 15_000 })
    if (r.exitCode === 0) return { id, available: true }
    // exit 非 0（如 docker info 在 Engine 停止时）同样拼指引——CLI 在但服务未起是最常见不可用态
    const detail = `${command[0]} 探测退出码 ${r.exitCode}：${(r.stderr || r.stdout).trim()}`
    return { id, available: false, reason: unavailableNote ? `${detail}（${unavailableNote}）` : detail }
  } catch (err) {
    const reason = isSpawnFailure(err)
      ? `${command[0]} 未安装或不在 PATH`
      : err instanceof Error
        ? err.message
        : String(err)
    return { id, available: false, reason: unavailableNote ? `${reason}（${unavailableNote}）` : reason }
  }
}

/** WSL：wsl --status（元信息输出 UTF-16LE） */
export const probeWsl = (run: ProcRunner): Promise<BackendProbe> =>
  probeCli('wsl', ['wsl', '--status'], run, 'utf16le')

/**
 * Docker（P5 Step 5 收紧）：docker info 的 Server 段——Engine 未运行（Docker Desktop 未启动）时
 * exit 非 0，available=false 带指引（旧探法 docker version 的 Client 段 CLI 在即通过——太宽松）。
 */
export const probeDocker = (run: ProcRunner): Promise<BackendProbe> =>
  probeCli(
    'docker',
    ['docker', 'info', '--format', '{{.ServerVersion}}'],
    run,
    undefined,
    'Docker Engine 未运行——启动 Docker Desktop 后重试',
  )

/**
 * Podman（P5 Step 6 收紧）：machine 运行态校验——`podman machine list --format json` 解析
 * Running 字段（实测 6.0.1：machine 停止时 exit 仍是 0，且 `podman info` 返回 client 侧信息
 * ——两者都探不出运行态，必须解析 machine list）。CLI 缺席/无 machine/全停均如实不可用。
 */
export const probePodman = (run: ProcRunner): Promise<BackendProbe> => {
  const command = ['podman', 'machine', 'list', '--format', 'json']
  return run({ command, timeoutMs: 15_000 })
    .then((r): BackendProbe => {
      if (r.exitCode !== 0) {
        return { id: 'podman', available: false, reason: `podman 探测退出码 ${r.exitCode}：${(r.stderr || r.stdout).trim()}` }
      }
      const machines = parseMachineList(r.stdout)
      if (machines === null) {
        return { id: 'podman', available: false, reason: `podman machine list 输出无法解析：${r.stdout.trim().slice(0, 120)}` }
      }
      if (machines.some((m) => m.running)) return { id: 'podman', available: true }
      return {
        id: 'podman',
        available: false,
        reason: machines.length === 0 ? '尚无 podman machine——先 podman machine init' : 'podman machine 未运行——podman machine start 后重试',
      }
    })
    .catch((err: unknown): BackendProbe => {
      const reason = isSpawnFailure(err)
        ? 'podman 未安装或不在 PATH'
        : err instanceof Error
          ? err.message
          : String(err)
      return { id: 'podman', available: false, reason }
    })
}

/** machine list 的最小事实（探测只关心运行态） */
export interface MachineListEntry {
  name: string
  running: boolean
}

/**
 * machine list JSON 解析（纯函数可测）：数组 → 逐项取 Name/Running；
 * 非数组 / 字段异常 / JSON 损坏 → null（调用方如实报不可用）。
 * 实测样本（podman 6.0.1，machine 从未启动）：
 * `[{"Name":"podman-machine-default","Default":true,"Running":false,"Starting":false,...}]`
 */
export function parseMachineList(stdout: string): MachineListEntry[] | null {
  const t = stdout.trim()
  if (t === '') return null
  try {
    const v = JSON.parse(t) as unknown
    if (!Array.isArray(v)) return null
    const out: MachineListEntry[] = []
    for (const item of v) {
      if (typeof item !== 'object' || item === null) return null
      const rec = item as Record<string, unknown>
      if (typeof rec['Name'] !== 'string' || typeof rec['Running'] !== 'boolean') return null
      out.push({ name: rec['Name'], running: rec['Running'] })
    }
    return out
  } catch {
    return null
  }
}

export const MOCK_PROBE: BackendProbe = { id: 'mock', available: true }

/** 全量探测（设置页与装配共用）；mock 恒可用（CI 确定性地基） */
export const probeAll = async (run: ProcRunner): Promise<BackendProbe[]> =>
  [MOCK_PROBE, await probeWsl(run), await probeDocker(run), await probePodman(run)]
