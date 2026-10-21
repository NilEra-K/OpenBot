/**
 * 运行时安装包下载器（docs/plan-v020-runtime-install.md §2）：
 * 流式落盘（临时目录）+ 进度回调 + sha256 流式哈希。校验失败删除文件并抛错——绝不执行。
 * https 直链与 GitHub release asset 通用；E2E/单测可注入 file:// 本地源。
 */
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export const InstallerErrorCodes = {
  RUNTIME_DOWNLOAD_FAILED: 'RUNTIME_DOWNLOAD_FAILED',
  /** sha256 校验失败——删除已下载文件，拒绝执行（安全红线） */
  RUNTIME_CHECKSUM_MISMATCH: 'RUNTIME_CHECKSUM_MISMATCH',
} as const

export interface DownloadOptions {
  url: string
  /** 期望 sha256（hex）——提供则强校验，缺席如实跳过（滚动直链场景，调用方负责披露） */
  sha256?: string
  fileName: string
  onProgress?: (bytes: number, totalBytes: number | null) => void
  /** 注入式源（测试 file:// 本地源；缺省全局 fetch） */
  fetchImpl?: typeof fetch
  /** 取消信号（2026-10-20 用户报障：流量敏感客户须能中止）——abort 即清临时文件并抛 CANCELED */
  signal?: AbortSignal
}

/** 取消错误（与网络/校验失败区分——收敛为 canceled 事件不误报 failed） */
export class DownloadCanceledError extends Error {
  constructor() {
    super('RUNTIME_INSTALL_CANCELED')
    this.name = 'DownloadCanceledError'
  }
}

/** 取消错误判定（abort 会以多种形态冒泡——统一识别） */
export function downloadCanceledErrorOf(err: unknown): DownloadCanceledError | null {
  if (err instanceof DownloadCanceledError) return err
  const name = (err as { name?: string })?.name
  if (name === 'AbortError' || name === 'DownloadCanceledError') return new DownloadCanceledError()
  return null
}

export interface DownloadResult {
  filePath: string
  bytes: number
  sha256: string
  /** 校验状态：verified（提供了期望且匹配）/ skipped（未提供期望——如实标注） */
  verification: 'verified' | 'skipped'
  /** 清理临时文件（执行完/失败后由调用方收尾） */
  cleanup: () => Promise<void>
}

/** sha256 在下载管道中边读边算（见 downloadInstaller 手动泵——零额外读盘） */
export async function downloadInstaller(options: DownloadOptions): Promise<DownloadResult> {
  const dir = await mkdtemp(join(tmpdir(), 'openbot-installer-'))
  const filePath = join(dir, options.fileName)
  const hash = createHash('sha256')
  let bytes = 0
  try {
    const fetchImpl = options.fetchImpl ?? (globalThis.fetch as typeof fetch)
    if (options.signal?.aborted) throw new DownloadCanceledError()
    const res = await fetchImpl(options.url, ...(options.signal !== undefined ? [{ signal: options.signal }] : []))
    if (!res.ok || res.body === null) {
      throw new Error(`下载失败（HTTP ${res.status}）：${options.url}`)
    }
    const totalHeader = res.headers.get('content-length')
    const totalBytes = totalHeader !== null ? Number(totalHeader) : null
    const reader = res.body.getReader()
    const out = createWriteStream(filePath)
    // 手动泵：边读边写边算（web ReadableStream → Node Writable 桥）
    try {
      for (;;) {
        if (options.signal?.aborted) throw new DownloadCanceledError()
        const { done, value } = await reader.read()
        if (done) break
        if (value) {
          bytes += value.byteLength
          hash.update(value)
          if (!out.write(Buffer.from(value))) {
            await new Promise<void>((resolve) => out.once('drain', resolve))
          }
          options.onProgress?.(bytes, totalBytes)
        }
      }
      await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())))
    } catch (err) {
      out.destroy()
      throw err
    }
    const actual = hash.digest('hex')
    if (options.sha256 !== undefined) {
      const expected = options.sha256.toLowerCase().replace(/^sha256:/, '')
      if (actual !== expected) {
        await rm(dir, { recursive: true, force: true })
        throw new Error(`${InstallerErrorCodes.RUNTIME_CHECKSUM_MISMATCH}：期望 ${expected}，实际 ${actual}`)
      }
    }
    const size = await stat(filePath)
    const cleanup = async (): Promise<void> => {
      await rm(dir, { recursive: true, force: true })
    }
    return {
      filePath,
      bytes: size.size,
      sha256: actual,
      verification: options.sha256 !== undefined ? 'verified' : 'skipped',
      cleanup,
    }
  } catch (err) {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
    throw err
  }
}

/** GitHub Releases latest 解析（Podman win）：API → 目标 asset 的下载直链 + digest（sha256） */
export interface GithubAsset {
  url: string
  sha256: string | null
  version: string
}

export async function resolveGithubLatest(
  repo: string,
  assetPattern: RegExp,
  fetchImpl?: typeof fetch,
): Promise<GithubAsset> {
  const impl = fetchImpl ?? (globalThis.fetch as typeof fetch)
  const res = await impl(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json' },
  })
  if (!res.ok) throw new Error(`GitHub API 失败（HTTP ${res.status}）`)
  const payload = (await res.json()) as {
    tag_name?: string
    assets?: Array<{ name?: string; browser_download_url?: string; digest?: string }>
  }
  const asset = payload.assets?.find((a) => typeof a.name === 'string' && assetPattern.test(a.name))
  if (asset?.browser_download_url === undefined) throw new Error('未找到匹配的 release asset')
  const digest = typeof asset.digest === 'string' ? asset.digest.replace(/^sha256:/, '') : null
  return { url: asset.browser_download_url, sha256: digest, version: payload.tag_name ?? '?' }
}
