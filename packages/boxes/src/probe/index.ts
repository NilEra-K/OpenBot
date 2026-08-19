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
    return { id, available: false, reason: `${command[0]} 探测退出码 ${r.exitCode}：${(r.stderr || r.stdout).trim()}` }
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

/** Docker：docker version（守护进程未起时 Client 段仍在——CLI 存在即可用候选） */
export const probeDocker = (run: ProcRunner): Promise<BackendProbe> =>
  probeCli('docker', ['docker', 'version', '--format', '{{.Client.Version}}'], run)

/**
 * Podman：CLI 存在性探底（podman --version）。
 * Windows 上还需 machine 处于运行态才真正可用——machine 运行态校验随 Step 4（OCI 后端）落地，
 * 此处 available 语义 = CLI 可调用；Step 4 起收紧。
 */
export const probePodman = (run: ProcRunner): Promise<BackendProbe> =>
  probeCli('podman', ['podman', '--version'], run)

export const MOCK_PROBE: BackendProbe = { id: 'mock', available: true }

/** 全量探测（设置页与装配共用）；mock 恒可用（CI 确定性地基） */
export const probeAll = async (run: ProcRunner): Promise<BackendProbe[]> =>
  [MOCK_PROBE, await probeWsl(run), await probeDocker(run), await probePodman(run)]
