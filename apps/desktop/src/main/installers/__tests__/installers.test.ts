import { describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import {
  downloadInstaller,
  resolveGithubLatest,
} from '../downloader.js'
import {
  linuxInstallCommand,
  fallbackCommandText,
  strategiesFor,
  STRATEGIES,
} from '../strategies.js'
import { runInstall } from '../index.js'
import type { RuntimeStrategy } from '../strategies.js'

describe('下载器（本地源——零外网）', () => {
  it('流式下载 + sha256 校验通过；进度回调收到字节数', async () => {
    const payload = Buffer.from('openbot-installer-fixture-0123456789'.repeat(64))
    const sha = createHash('sha256').update(payload).digest('hex')
    const server = await serveOnce(payload)
    try {
      const progress: Array<{ bytes: number; total: number | null }> = []
      const r = await downloadInstaller({
        url: server.url,
        fileName: 'f.bin',
        sha256: sha,
        onProgress: (bytes, total) => progress.push({ bytes, total }),
        fetchImpl: globalThis.fetch as typeof fetch,
      })
      expect(r.verification).toBe('verified')
      expect(r.bytes).toBe(payload.length)
      expect(progress.at(-1)?.total).toBe(payload.length)
      expect(await readFile(r.filePath, 'utf-8')).toBe(payload.toString('utf-8'))
      await r.cleanup()
    } finally {
      await server.close()
    }
  })

  it('中止（signal abort）→ 取消错误 + 读泵退出（临时文件随 catch 清理）', async () => {
    // 大 payload + 慢速源：读完首块后 abort——覆盖读泵中止位
    const payload = Buffer.alloc(1024 * 1024, 7)
    let release: (() => void) | null = null
    const server = await serveSlow(payload, (finish) => (release = finish))
    try {
      const controller = new AbortController()
      const promise = downloadInstaller({
        url: server.url,
        fileName: 'f.bin',
        fetchImpl: globalThis.fetch as typeof fetch,
        signal: controller.signal,
      })
      await new Promise<void>((resolve) => setTimeout(resolve, 150))
      controller.abort()
      await expect(promise).rejects.toThrow(/CANCELED|aborted|abort/i)
    } finally {
      // TS 控制流不知道回调内已赋值（窄化为 null → never）——显式断言收尾释放
      ;(release as (() => void) | null)?.()
      await server.close()
    }
  })

  it('sha256 不匹配 → 拒绝执行（RUNTIME_CHECKSUM_MISMATCH）且清理临时文件', async () => {
    const payload = Buffer.from('tamper-me')
    const server = await serveOnce(payload)
    try {
      await expect(
        downloadInstaller({
          url: server.url,
          fileName: 'f.bin',
          sha256: 'deadbeef',
          fetchImpl: globalThis.fetch as typeof fetch,
        }),
      ).rejects.toThrow(/RUNTIME_CHECKSUM_MISMATCH/)
    } finally {
      await server.close()
    }
  })

  it('GitHub latest 解析：asset 匹配 + digest 提取；无匹配 asset 拒绝', async () => {
    const fakeFetch = (async (url: string | URL | Request) => {
      const u = String(url)
      if (u.includes('api.github.com')) {
        return new Response(
          JSON.stringify({
            tag_name: 'v9.9.9',
            assets: [
              { name: 'podman-9.9.9-setup.exe', browser_download_url: 'https://example.com/podman-9.9.9-setup.exe', digest: 'sha256:abc123' },
              { name: 'podman-9.9.9.msi', browser_download_url: 'https://example.com/x.msi' },
            ],
          }),
          { status: 200 },
        )
      }
      return new Response(null, { status: 404 })
    }) as typeof fetch
    const asset = await resolveGithubLatest('containers/podman', /^podman-[\d.]+-setup\.exe$/, fakeFetch)
    expect(asset).toMatchObject({ url: 'https://example.com/podman-9.9.9-setup.exe', sha256: 'abc123', version: 'v9.9.9' })
    await expect(resolveGithubLatest('containers/podman', /^nothing-\d+/, fakeFetch)).rejects.toThrow('未找到匹配')
  })
})

describe('策略表（v0.2.0 安装矩阵）', () => {
  it('8 个正式策略：三平台覆盖（win 3 / linux 2 / darwin 3）；id×平台唯一', () => {
    expect(STRATEGIES).toHaveLength(8)
    expect(STRATEGIES.filter((s) => s.platform === 'win32')).toHaveLength(3)
    expect(STRATEGIES.filter((s) => s.platform === 'linux')).toHaveLength(2)
    expect(STRATEGIES.filter((s) => s.platform === 'darwin')).toHaveLength(3)
    const keys = new Set(STRATEGIES.map((s) => `${s.platform}:${s.id}`))
    expect(keys.size).toBe(STRATEGIES.length)
  })

  it('Linux 发行版分支：debian 系 docker→docker.io；fedora/arch 各归位；未知发行版 null', () => {
    expect(linuxInstallCommand('docker', 'ubuntu')?.command).toEqual(['apt-get', 'install', '-y', 'docker.io'])
    expect(linuxInstallCommand('podman', 'debian')?.command).toEqual(['apt-get', 'install', '-y', 'podman'])
    expect(linuxInstallCommand('docker', 'fedora')?.command).toEqual(['dnf', 'install', '-y', 'docker'])
    expect(linuxInstallCommand('docker', 'arch')?.command).toEqual(['pacman', '-S', '--noconfirm', 'docker'])
    expect(linuxInstallCommand('docker', 'plan9')).toBeNull()
  })

  it('兜底命令全文：darwin brew 缺席含官方引导 + 安装命令；linux apt 含 update 前缀', () => {
    const brew = strategiesFor('darwin', false).find((s) => s.id === 'docker-desktop')!
    const text = fallbackCommandText(brew, '')
    expect(text).toContain('brew install --cask docker')
    expect(text).toContain('Homebrew/install')
    const apt = strategiesFor('linux', false).find((s) => s.id === 'docker')!
    expect(fallbackCommandText(apt, 'ubuntu')).toContain('sudo apt-get update && sudo apt-get install -y docker.io')
  })

  it('mock 策略：仅 includeMock 时注册（E2E 门控——mock 对称铁律）', () => {
    expect(strategiesFor(process.platform, true).some((s) => s.id === 'mock-runtime')).toBe(true)
    expect(strategiesFor(process.platform, false).some((s) => s.id === 'mock-runtime')).toBe(false)
  })
})

describe('执行器', () => {
  it('builtin 非提权：执行系统命令 → 事件序列到 done（mock-runtime 同路径）', async () => {
    const strategy: RuntimeStrategy = {
      id: 'test',
      runtime: 'Test',
      platform: process.platform,
      source: { kind: 'builtin', command: [process.execPath, '-e', 'process.exit(0)'], args: [] },
      elevation: 'none',
      locationSelectable: false,
      locationNote: '-',
      notes: [],
    }
    const phases: string[] = []
    await runInstall(strategy, { onEvent: (e) => phases.push(e.phase) })
    expect(phases.at(-1)).toBe('done')
  })

  it('darwin 无 brew（本测试环境必然缺席）→ fallback 事件带命令全文 + 抛 Homebrew 未安装', async () => {
    const strategy = strategiesFor('darwin', false).find((s) => s.id === 'colima')!
    let fallbackCommand = ''
    await expect(
      runInstall(strategy, {
        onEvent: (e) => {
          if (e.phase === 'fallback' && e.command !== undefined) fallbackCommand = e.command
        },
      }),
    ).rejects.toThrow('Homebrew')
    expect(fallbackCommand).toContain('brew install colima docker')
  })
})

/** 慢速单次源：首块送达后挂起——onReady 给出 finish（发尾块收尾）供 finally 释放连接 */
async function serveSlow(
  body: Buffer,
  onReady: (finish: () => void) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((_req, res) => {
    res.setHeader('content-length', String(body.length))
    res.write(body.subarray(0, 4096))
    onReady(() => {
      res.end(body.subarray(4096))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address() as { port: number }
  return {
    url: `http://127.0.0.1:${addr.port}/f.bin`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

/** 单次响应源（ephemeral 端口；body 预生成） */
async function serveOnce(body: Buffer): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((_req, res) => {
    res.setHeader('content-length', String(body.length))
    res.end(body)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address() as { port: number }
  return {
    url: `http://127.0.0.1:${addr.port}/f.bin`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}
