import { describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { ProcResult, ProcRunner, ProcSpec } from '@openbot/boxes'
import {
  downloadInstaller,
  resolveGithubLatest,
} from '../downloader.js'
import {
  linuxInstallCommand,
  fallbackCommandText,
  strategiesFor,
  STRATEGIES,
  DOCKER_DESKTOP_WIN_ROOT,
  PODMAN_WIN_EXE,
} from '../strategies.js'
import { runInstall, assembleLocationArgs, buildLaunchPlan } from '../index.js'
import {
  probeDockerLayered,
  probePodmanLayered,
  probeWslLayered,
} from '../layered.js'
import {
  deriveDesktopRoot,
  resolveDockerCli,
  resolveDockerDesktopExe,
  resolvePodmanCli,
  pollEngineReady,
  runLaunch,
} from '../launcher.js'
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

  it('位置旗标矩阵（2026-10-21 三术语）：DD win 双旗标 / Podman win MSI INSTALLDIR / 其余无可选', () => {
    const dd = STRATEGIES.find((s) => s.platform === 'win32' && s.id === 'docker-desktop')!
    expect(dd.locationFlags).toEqual({ installDir: '--installation-dir=', dataDir: '--wsl-default-data-root=' })
    const podWin = STRATEGIES.find((s) => s.platform === 'win32' && s.id === 'podman')!
    expect(podWin.locationFlags).toEqual({ installDir: 'INSTALLDIR=' })
    expect(podWin.source).toMatchObject({ launcher: 'msiexec' })
    // v6 起官方只发 MSI（旧 setup.exe 资产已不存在——2026-10-21 核实 v6.1.4）
    expect((podWin.source as { assetPattern: RegExp }).assetPattern.test('podman-installer-windows-amd64.msi')).toBe(true)
    expect((podWin.source as { assetPattern: RegExp }).assetPattern.test('podman-6.1.4-setup.exe')).toBe(false)
    for (const s of STRATEGIES.filter((x) => x.platform !== 'win32')) {
      expect(s.locationFlags).toBeUndefined()
    }
  })

  it('位置参数组装：声明且传值 → 单参 <flag><值>；未传 → 空参；未声明而传值 → 拒绝', () => {
    const dd = STRATEGIES.find((s) => s.platform === 'win32' && s.id === 'docker-desktop')!
    expect(assembleLocationArgs(dd, { installDir: 'D:\\Docker', dataDir: 'E:\\DockerData' })).toEqual([
      '--installation-dir=D:\\Docker',
      '--wsl-default-data-root=E:\\DockerData',
    ])
    expect(assembleLocationArgs(dd, {})).toEqual([])
    // wsl2 未声明任何位置旗标——传安装位置必须拒（不静默装到默认位置）
    const wsl2 = STRATEGIES.find((s) => s.id === 'wsl2')!
    expect(() => assembleLocationArgs(wsl2, { installDir: 'D:\\W' })).toThrow(/RUNTIME_LOCATION_NOT_SUPPORTED/)
  })

  it('拉起形态：launcher=msiexec → msiexec.exe /package 前置；缺省 → 直接执行安装包', () => {
    expect(buildLaunchPlan({ launcher: 'msiexec' }, 'C:\\t\\p.msi', ['/quiet', 'ALLUSERS=1'])).toEqual({
      command: 'msiexec.exe',
      args: ['/package', 'C:\\t\\p.msi', '/quiet', 'ALLUSERS=1'],
    })
    expect(buildLaunchPlan({}, 'C:\\t\\setup.exe', ['install', '--quiet'])).toEqual({
      command: 'C:\\t\\setup.exe',
      args: ['install', '--quiet'],
    })
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
      locationNote: '-',
      notes: [],
    }
    const phases: string[] = []
    await runInstall(strategy, { onEvent: (e) => phases.push(e.phase) })
    expect(phases.at(-1)).toBe('done')
  })

  it('builtin 位置旗标链（2026-10-21）：installDir 追加为尾参 → 执行 detail 含旗标值', async () => {
    const strategy: RuntimeStrategy = {
      id: 'test',
      runtime: 'Test',
      platform: process.platform,
      source: { kind: 'builtin', command: [process.execPath, '-e', 'process.exit(0)'], args: [] },
      elevation: 'none',
      locationFlags: { installDir: 'MOCK_INSTALL_DIR=' },
      locationNote: '-',
      notes: [],
    }
    const details: string[] = []
    await runInstall(strategy, { onEvent: (e) => { if (e.detail !== undefined) details.push(e.detail) } }, { installDir: 'D:\\e2e' })
    expect(details.some((d) => d.includes('MOCK_INSTALL_DIR=D:\\e2e'))).toBe(true)
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

// ---- 状态分层探测（v0.1.89：装没装 × 跑没跑）----
// ProcRunner 替身：按命令整串路由（layered/launcher 的探测命令带全路径——按 join 结果匹配）；
// 值为 Error 时原样抛（Object.assign name:'ProcSpawnError' 模拟 CLI 缺席——isSpawnFailure 同判据）
const R = (over: Partial<ProcResult> = {}): ProcResult => ({
  exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false, aborted: false, ...over,
})
const spawnMissing = (cli: string): Error => Object.assign(new Error(`${cli} 未安装或不在 PATH`), { name: 'ProcSpawnError' })
const reply = (map: Record<string, ProcResult | Error>): ProcRunner => async (spec: ProcSpec) => {
  const key = spec.command.join(' ')
  const hit = map[key]
  if (hit === undefined) throw new Error(`替身未覆盖命令：${key}`)
  if (hit instanceof Error) throw hit
  return hit
}

describe('状态分层探测（v0.1.89：装没装 × 跑没跑）', () => {
  it('docker：CLI 与 DD exe 双缺 → absent；DD exe 在场但 CLI 不可寻（装完未重启应用）→ installed/unknown', async () => {
    expect(await probeDockerLayered(reply({}), null, null)).toEqual({ installState: 'absent', engineState: 'unknown' })
    expect(await probeDockerLayered(reply({}), null, `${DOCKER_DESKTOP_WIN_ROOT}\\Docker Desktop.exe`)).toEqual({
      installState: 'installed',
      engineState: 'unknown',
    })
  })

  it('docker：CLI 在场引擎停（info exit 1——真机报障场景：DD 已装未开）→ installed/stopped；引擎跑 → running', async () => {
    const stopped = reply({ 'docker info --format {{.ServerVersion}}': R({ exitCode: 1, stderr: 'error during connect' }) })
    expect(await probeDockerLayered(stopped, 'docker', null)).toEqual({ installState: 'installed', engineState: 'stopped' })
    const running = reply({ 'docker info --format {{.ServerVersion}}': R({ stdout: '27.3.1' }) })
    expect(await probeDockerLayered(running, 'docker', null)).toEqual({ installState: 'installed', engineState: 'running' })
  })

  it('podman：CLI 缺席 → absent；无 machine → stopped + machine-missing（start 必败的如实细分）；Running → running', async () => {
    expect(await probePodmanLayered(reply({}), null)).toEqual({ installState: 'absent', engineState: 'unknown' })
    const empty = reply({ 'podman machine list --format json': R({ stdout: '[]' }) })
    expect(await probePodmanLayered(empty, 'podman')).toEqual({
      installState: 'installed',
      engineState: 'stopped',
      note: 'machine-missing',
    })
    const up = reply({ 'podman machine list --format json': R({ stdout: '[{"Name":"podman-machine-default","Running":true}]' }) })
    expect(await probePodmanLayered(up, 'podman')).toEqual({ installState: 'installed', engineState: 'running' })
  })

  it('wsl：--status 过 → installed/running（按需内核特性无独立引擎）；不过 → absent', async () => {
    expect(await probeWslLayered(reply({ 'wsl --status': R() }))).toEqual({ installState: 'installed', engineState: 'running' })
    expect(await probeWslLayered(reply({ 'wsl --status': R({ exitCode: 1, stderr: '未安装' }) }))).toEqual({
      installState: 'absent',
      engineState: 'unknown',
    })
  })
})

describe('启动器（v0.1.89：路径解析 + 拉起 + 就绪轮询）', () => {
  it('deriveDesktopRoot：CLI bin 上两级 = DD 安装根（官方布局 resources\\bin；自选安装位同样成立）', () => {
    expect(deriveDesktopRoot(`${DOCKER_DESKTOP_WIN_ROOT}\\resources\\bin\\docker.exe`)).toBe(DOCKER_DESKTOP_WIN_ROOT)
    expect(deriveDesktopRoot('D:\\Apps\\Docker\\Docker\\resources\\bin\\docker.exe')).toBe('D:\\Apps\\Docker\\Docker')
  })

  it('CLI/exe 解析：PATH 优先；PATH 缺席回退官方默认位（新装后本进程 PATH 未含）；双缺 null 如实', async () => {
    const DD_CLI = `${DOCKER_DESKTOP_WIN_ROOT}\\resources\\bin\\docker.exe`
    expect(
      await resolveDockerCli(reply({ 'docker --version': R({ stdout: 'Docker version 27.3.1' }) }), () => false, DOCKER_DESKTOP_WIN_ROOT),
    ).toBe('docker')
    expect(
      await resolveDockerCli(reply({ 'docker --version': spawnMissing('docker') }), (p) => p === DD_CLI, DOCKER_DESKTOP_WIN_ROOT),
    ).toBe(DD_CLI)
    expect(
      await resolvePodmanCli(reply({ 'podman --version': spawnMissing('podman') }), (p) => p === PODMAN_WIN_EXE, PODMAN_WIN_EXE),
    ).toBe(PODMAN_WIN_EXE)
    // exe 定位：where 命中推导（自选安装位）优先；where 缺席回退默认位；双缺 null
    const whereHit = reply({ 'where docker': R({ stdout: 'C:\\Custom\\Docker\\resources\\bin\\docker.exe\r\n' }) })
    expect(
      await resolveDockerDesktopExe(whereHit, (p) => p === 'C:\\Custom\\Docker\\Docker Desktop.exe', DOCKER_DESKTOP_WIN_ROOT),
    ).toBe('C:\\Custom\\Docker\\Docker Desktop.exe')
    const nothing = reply({ 'where docker': R({ exitCode: 1 }) })
    expect(await resolveDockerDesktopExe(nothing, () => false, DOCKER_DESKTOP_WIN_ROOT)).toBeNull()
    expect(await resolveDockerCli(reply({ 'docker --version': spawnMissing('docker') }), () => false, DOCKER_DESKTOP_WIN_ROOT)).toBeNull()
  })

  it('pollEngineReady：立即可用 → ready；持续不可用 → timeout；abort → canceled（短周期实测）', async () => {
    expect(await pollEngineReady(async () => true, { intervalMs: 10, timeoutMs: 200 })).toBe('ready')
    expect(await pollEngineReady(async () => false, { intervalMs: 5, timeoutMs: 30 })).toBe('timeout')
    const c = new AbortController()
    setTimeout(() => c.abort(), 10)
    expect(await pollEngineReady(async () => false, { intervalMs: 5, timeoutMs: 5_000, signal: c.signal })).toBe('canceled')
  })

  it('runLaunch mock（E2E 对称）：launch → 短停留 → ready；中途 abort → canceled 不误报失败', async () => {
    const mock = strategiesFor(process.platform, true).find((s) => s.id === 'mock-runtime')!
    const phases: string[] = []
    const ok = await runLaunch(mock, { onEvent: (e) => phases.push(e.phase) }, { run: reply({}), mockDelayMs: 20 })
    expect(ok).toBe('ready')
    expect(phases).toEqual(['launch', 'ready'])
    const c = new AbortController()
    setTimeout(() => c.abort(), 10)
    const phases2: string[] = []
    const canceled = await runLaunch(mock, { onEvent: (e) => phases2.push(e.phase) }, { run: reply({}), mockDelayMs: 200, signal: c.signal })
    expect(canceled).toBe('canceled')
    expect(phases2).toEqual(['launch', 'canceled'])
  })

  it('runLaunch app（DD）：推导 exe 拉起（spawnApp 注入捕获）→ 轮询到 ready；exe 双缺 → RUNTIME_LAUNCH_FAILED', async () => {
    const dd = STRATEGIES.find((s) => s.platform === 'win32' && s.id === 'docker-desktop')!
    const ddExe = `${DOCKER_DESKTOP_WIN_ROOT}\\Docker Desktop.exe`
    const run = reply({
      'where docker': R({ stdout: `${DOCKER_DESKTOP_WIN_ROOT}\\resources\\bin\\docker.exe` }),
      'docker --version': R({ stdout: 'Docker version 27.3.1' }),
      'docker info --format {{.ServerVersion}}': R({ stdout: '27.3.1' }),
    })
    const spawned: string[] = []
    const outcome = await runLaunch(
      dd,
      { onEvent: () => {} },
      { run, exists: (p) => p === ddExe, spawnApp: (exe) => spawned.push(exe), pollIntervalMs: 10, pollTimeoutMs: 1_000 },
    )
    expect(outcome).toBe('ready')
    expect(spawned).toEqual([ddExe])
    await expect(
      runLaunch(
        dd,
        { onEvent: () => {} },
        { run: reply({ 'where docker': R({ exitCode: 1 }) }), exists: () => false, pollIntervalMs: 10, pollTimeoutMs: 200 },
      ),
    ).rejects.toThrow(/RUNTIME_LAUNCH_FAILED/)
  })

  it('runLaunch machine-start（Podman）：start → 轮询 Running → ready；start 退非 0 → RUNTIME_LAUNCH_FAILED（stderr 如实）', async () => {
    const pod = STRATEGIES.find((s) => s.platform === 'win32' && s.id === 'podman')!
    const ok = await runLaunch(
      pod,
      { onEvent: () => {} },
      {
        run: reply({
          'podman --version': R({ stdout: 'podman version 6.1.4' }),
          'podman machine start': R(),
          'podman machine list --format json': R({ stdout: '[{"Name":"podman-machine-default","Running":true}]' }),
        }),
        exists: () => false,
        pollIntervalMs: 10,
        pollTimeoutMs: 500,
      },
    )
    expect(ok).toBe('ready')
    await expect(
      runLaunch(
        pod,
        { onEvent: () => {} },
        {
          run: reply({
            'podman --version': R({ stdout: 'podman version 6.1.4' }),
            'podman machine start': R({ exitCode: 125, stderr: 'VM does not exist' }),
          }),
          exists: () => false,
          pollIntervalMs: 10,
          pollTimeoutMs: 200,
        },
      ),
    ).rejects.toThrow(/RUNTIME_LAUNCH_FAILED.*VM does not exist/)
  })
})

describe('launch 声明矩阵（2026-10-27 声明制——未声明不显示启动钮）', () => {
  it('win：DD=app（官方默认位）、Podman=machine-start；其余（wsl2/linux/mac 全部）未声明（backlog）；mock 仅 E2E 声明', () => {
    const dd = STRATEGIES.find((s) => s.platform === 'win32' && s.id === 'docker-desktop')!
    expect(dd.launch).toEqual({ kind: 'app', exeName: 'Docker Desktop.exe', defaultRoot: DOCKER_DESKTOP_WIN_ROOT })
    const pod = STRATEGIES.find((s) => s.platform === 'win32' && s.id === 'podman')!
    expect(pod.launch).toEqual({ kind: 'machine-start', defaultCliPath: PODMAN_WIN_EXE })
    for (const s of STRATEGIES.filter((x) => !(x.platform === 'win32' && (x.id === 'docker-desktop' || x.id === 'podman')))) {
      expect(s.launch).toBeUndefined()
    }
    expect(strategiesFor(process.platform, true).find((s) => s.id === 'mock-runtime')!.launch).toEqual({ kind: 'mock' })
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
