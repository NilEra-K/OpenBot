/**
 * 运行时安装执行器（docs/plan-v020-runtime-install.md §1）：按策略 source 型分派——
 * builtin（提权执行系统命令）/ direct+github-latest（下载→校验→静默装）/ package-manager
 * （Linux pkexec / macOS brew；失败回退命令生成）。进度经回调上抛（命令面转事件）。
 * 提权透明：Windows UAC 由系统弹（用户取消 = 1223 如实收敛）；Linux pkexec 无 agent 同理回退。
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile } from 'node:fs/promises'
import type { RuntimeStrategy } from './strategies.js'
import { fallbackCommandText, linuxInstallCommand } from './strategies.js'
import { downloadInstaller, downloadCanceledErrorOf, resolveGithubLatest } from './downloader.js'

const execFileAsync = promisify(execFile)

export const InstallerErrorCodeText = {
  CANCELED: '用户取消了系统授权（未做任何更改）',
  NO_POLKIT_AGENT: '系统无 polkit 图形授权组件（pkexec 不可用）',
} as const

export type InstallPhase = 'download' | 'verify' | 'install' | 'probe' | 'done' | 'failed' | 'fallback' | 'canceled'

export interface InstallEvents {
  /** phase: download(带 percent)/verify/install/probe/done/failed/fallback */
  onEvent: (payload: { phase: InstallPhase; percent?: number; detail?: string; command?: string }) => void
}

/** Windows 提权执行：PowerShell Start-Process -Verb RunAs -Wait -PassThru（UAC 系统弹） */
async function runElevatedWindows(
  filePath: string,
  args: string[],
  events: InstallEvents,
  signal?: AbortSignal,
): Promise<void> {
  events.onEvent({ phase: 'install', detail: '等待系统授权（UAC）…' })
  // -PassThru 取退出码；UAC 取消 → Start-Process 抛异常（ERROR_CANCELLED 1223）
  const psArgs = [
    '-NoProfile',
    '-Command',
    `$ErrorActionPreference='Stop'; try { $p = Start-Process -FilePath ${psQuote(filePath)} -ArgumentList ${args
      .map((a) => psQuote(a))
      .join(',')} -Verb RunAs -Wait -PassThru; exit $p.ExitCode } catch { exit 1223 }`,
  ]
  const { stdout, stderr } = await execFileAsync('powershell.exe', psArgs, execOpts(signal, 30 * 60_000))
  const out = `${stdout}${stderr}`.trim()
  if (out !== '') events.onEvent({ phase: 'install', detail: out.slice(0, 300) })
}

/** PowerShell 单引号字面量安全引 */
function psQuote(s: string): string {
  return `'${s.replaceAll("'", "''")}'`
}

async function readFileTrim(path: string): Promise<string> {
  return (await readFile(path, 'utf-8')).trim()
}

/** /etc/os-release 的 ID 字段（发行版判定；读取失败 → 空 → 走回退） */
async function linuxOsId(): Promise<string> {
  try {
    const content = await readFileTrim('/etc/os-release')
    const line = content.split('\n').find((l) => l.startsWith('ID='))
    return line === undefined ? '' : line.slice(3).trim().replaceAll('"', '')
  } catch {
    return ''
  }
}

export interface InstallDeps {
  /** 探测重跑（安装后验证；缺席则跳过 probe 阶段） */
  reprobe?: () => Promise<void>
  fetchImpl?: typeof fetch
  /** 取消信号（2026-10-20：下载/子进程全链可中止——流量敏感客户） */
  signal?: AbortSignal
}

/** exec 选项工厂：signal 在场即挂（Node execFile 原生支持——中止杀子进程） */
function execOpts(signal: AbortSignal | undefined, timeoutMs: number): { timeout: number; signal?: AbortSignal } {
  return { timeout: timeoutMs, ...(signal !== undefined ? { signal } : {}) }
}

export async function runInstall(
  strategy: RuntimeStrategy,
  events: InstallEvents,
  deps: InstallDeps = {},
): Promise<void> {
  try {
    await runInstallInner(strategy, events, deps)
  } catch (err) {
    // 取消收敛（2026-10-20 用户报障）：abort 以 CanceledError/AbortError/子进程被杀多种形态
    // 冒泡——统一转 canceled 事件（不误报 failed）；其余照抛由调用方落 failed
    if (downloadCanceledErrorOf(err) !== null || deps.signal?.aborted === true) {
      events.onEvent({ phase: 'canceled', detail: '已取消——未做任何更改' })
      return
    }
    throw err
  }
}

async function runInstallInner(
  strategy: RuntimeStrategy,
  events: InstallEvents,
  deps: InstallDeps,
): Promise<void> {
  const signal = deps.signal
  const source = strategy.source

  if (source.kind === 'builtin') {
    // WSL2 / mock：直接（按需提权）执行系统命令
    if (strategy.elevation === 'uac') {
      await runElevatedWindows(source.command.join(' '), source.args, events, signal)
    } else {
      events.onEvent({ phase: 'install', detail: `执行：${source.command.join(' ')}` })
      await execFileAsync(source.command[0]!, source.command.slice(1), {
        ...execOpts(signal, 30 * 60_000),
        ...(source.env !== undefined ? { env: { ...process.env, ...source.env } } : {}),
      })
    }
  } else if (source.kind === 'direct' || source.kind === 'github-latest') {
    // 下载 → 校验 → 静默装（Windows 提权）
    let url = ''
    let sha256: string | undefined
    let fileName = ''
    if (source.kind === 'github-latest') {
      events.onEvent({ phase: 'download', percent: 0, detail: `解析 ${source.repo} 最新版…` })
      const asset = await resolveGithubLatest(source.repo, source.assetPattern, deps.fetchImpl)
      url = asset.url
      sha256 = asset.sha256 ?? undefined
      fileName = url.split('/').pop() ?? 'installer.bin'
      events.onEvent({ phase: 'download', percent: 0, detail: `最新版 ${asset.version}（${fileName}）` })
    } else {
      url = source.url
      sha256 = source.sha256
      fileName = source.fileName
    }
    void 0 // 分支闭合（两型都赋 url）
    if (sha256 === undefined) {
      events.onEvent({ phase: 'verify', detail: '官方滚动直链：无预置哈希（TLS 传输，如实披露）' })
    }
    events.onEvent({ phase: 'download', percent: 0 })
    const downloaded = await downloadInstaller({
      url,
      fileName,
      ...(sha256 !== undefined ? { sha256 } : {}),
      fetchImpl: deps.fetchImpl,
      ...(signal !== undefined ? { signal } : {}),
      onProgress: (bytes, total) => {
        const percent = total !== null && total > 0 ? Math.round((bytes / total) * 100) : undefined
        events.onEvent({ phase: 'download', ...(percent !== undefined ? { percent } : {}), detail: `${mb(bytes)} MB` })
      },
    })
    try {
      if (downloaded.verification === 'verified') {
        events.onEvent({ phase: 'verify', detail: `sha256 校验通过（${downloaded.sha256.slice(0, 12)}…）` })
      }
      await runElevatedWindows(downloaded.filePath, source.installerArgs, events, signal)
    } finally {
      await downloaded.cleanup().catch(() => {})
    }
  } else if (source.kind === 'package-manager') {
    if (strategy.platform === 'linux') {
      const osId = await linuxOsId()
      const resolved = linuxInstallCommand(source.package, osId)
      if (resolved === null) {
        const text = fallbackCommandText(strategy, osId)
        events.onEvent({ phase: 'fallback', command: text })
        throw new Error('未知发行版——已生成手动安装命令（见面板）')
      }
      events.onEvent({ phase: 'install', detail: `pkexec ${resolved.command.join(' ')}（系统将弹授权框）…` })
      try {
        // pkexec：polkit 图形授权（等价 UAC 体验）；126/127 = 无 agent/不可用 → 回退
        await execFileAsync('pkexec', resolved.command, execOpts(signal, 30 * 60_000))
      } catch (err) {
        const code = (err as { code?: number }).code
        const text = fallbackCommandText(strategy, osId)
        if (code === 126 || code === 127) {
          events.onEvent({ phase: 'fallback', command: text })
          throw new Error(InstallerErrorCodeText.NO_POLKIT_AGENT)
        }
        if (/cancel|denied|dismiss/i.test(String((err as { stderr?: string }).stderr ?? ''))) {
          throw new Error(InstallerErrorCodeText.CANCELED)
        }
        events.onEvent({ phase: 'fallback', command: text })
        throw err instanceof Error ? err : new Error(String(err))
      }
    } else if (strategy.platform === 'darwin') {
      // brew 在场检测 → 安装；缺席 → 官方引导回退
      try {
        await execFileAsync('brew', ['--version'], execOpts(signal, 15_000))
      } catch {
        events.onEvent({ phase: 'fallback', command: fallbackCommandText(strategy, '') })
        throw new Error('Homebrew 未安装——已生成官方安装引导（见面板）')
      }
      events.onEvent({ phase: 'install', detail: `brew install ${source.cask === true ? '--cask ' : ''}${source.package}…` })
      await execFileAsync(
        'brew',
        ['install', ...(source.cask === true ? ['--cask'] : []), ...source.package.split(' ')],
        execOpts(signal, 30 * 60_000),
      )
    }
  }

  // 安装后验证：探测重跑（缺席跳过——探测事实归沙箱面）
  if (deps.reprobe !== undefined) {
    events.onEvent({ phase: 'probe', detail: '重新探测…' })
    await deps.reprobe()
  }
  events.onEvent({ phase: 'done' })
}

function mb(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1)
}
