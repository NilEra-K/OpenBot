/**
 * 可用镜像探测测试（2026-09-14）：解析器纯函数 + scanEnvImages 三来源编排替身单测
 * （ProcRunner 注入，probe/backend 同哲学）。锁定语义：
 * - 解析容错：TSV 四列、悬空层（<none>）过滤、坏行跳过不拖累其余行；
 * - 如实报告：spawn 失败 = CLI 未装、exit 非 0 = 引擎未运行（带指引），不造假可用；
 * - 故障隔离与平台门控：单源失败他源照常结算；wsl-docker 仅 win32（undefined=测试全开）。
 */
import { describe, expect, it } from 'vitest'
import { OCI_IMAGES_FORMAT, parseOciImageLines, scanEnvImages } from '../src/images/index.js'
import type { ProcResult, ProcRunner, ProcSpec } from '../src/procexec/index.js'

const OK: ProcResult = { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false, aborted: false }

/** docker images 实测形态（四列 TSV + 悬空层 + 空行混排） */
const DOCKER_IMAGES = [
  'ubuntu\t24.04\t78.1MB\t2 weeks ago',
  'openbot-gui\t24.04\t1.25GB\t3 days ago',
  '<none>\t<none>\t0B\t3 days ago', // 悬空层（build 中间产物）
  '', // 尾部空行
  'hello-world\tlatest\t13.3kB\t5 months ago',
].join('\n')

describe('parseOciImageLines（纯函数）', () => {
  it('docker 形态：四列 TSV → ref/repository/tag/size/created，悬空层与空行过滤', () => {
    expect(parseOciImageLines(DOCKER_IMAGES)).toEqual([
      { ref: 'ubuntu:24.04', repository: 'ubuntu', tag: '24.04', size: '78.1MB', created: '2 weeks ago' },
      { ref: 'openbot-gui:24.04', repository: 'openbot-gui', tag: '24.04', size: '1.25GB', created: '3 days ago' },
      { ref: 'hello-world:latest', repository: 'hello-world', tag: 'latest', size: '13.3kB', created: '5 months ago' },
    ])
  })

  it('坏行跳过：缺列/仓库缺 tag 的行不影响其余行', () => {
    const out = parseOciImageLines(['only-repo', 'a\t1.0\t10MB\tnow', 'x\t', ''].join('\n'))
    expect(out).toEqual([{ ref: 'a:1.0', repository: 'a', tag: '1.0', size: '10MB', created: 'now' }])
  })

  it('有 tag 无 size/created 的两列行：size/created 缺席（可选字段）', () => {
    expect(parseOciImageLines('ubuntu\t24.04')).toEqual([{ ref: 'ubuntu:24.04', repository: 'ubuntu', tag: '24.04' }])
  })

  it('空输出（引擎在跑但没拉过镜像）→ 空数组', () => {
    expect(parseOciImageLines('')).toEqual([])
  })
})

/** 按来源固定应答的替身：docker/podman/wsl 各自命中，未覆盖即抛（防静默造假） */
const respondScan = (impl: {
  docker?: ProcResult | Error
  podman?: ProcResult | Error
  wsl?: ProcResult | Error
}): ProcRunner => async (spec: ProcSpec) => {
  const hit = spec.command[0] === 'docker'
    ? impl.docker
    : spec.command[0] === 'podman'
      ? impl.podman
      : spec.command[0] === 'wsl'
        ? impl.wsl
        : undefined
  if (hit === undefined) throw new Error(`替身未覆盖命令：${spec.command.join(' ')}`)
  if (hit instanceof Error) throw hit
  return hit
}

/** spawn 失败替身（isSpawnFailure 按错误名 ProcSpawnError 判「CLI 未安装」——真实 spawn 同名） */
const spawnFail = (cli: string): Error => Object.assign(new Error(`spawn ${cli} ENOENT`), { name: 'ProcSpawnError' })

describe('scanEnvImages（三来源编排）', () => {
  it('全可用：docker/podman/wsl 各自如实带清单；images 格式模板四列 TSV', async () => {
    expect(OCI_IMAGES_FORMAT).toBe('{{.Repository}}\t{{.Tag}}\t{{.Size}}\t{{.CreatedSince}}')
    const sources = await scanEnvImages({
      run: respondScan({
        docker: { ...OK, stdout: DOCKER_IMAGES },
        podman: { ...OK, stdout: 'a\t1.0\t10MB\tnow\nb\t2.0\t20MB\tnow' },
        wsl: { ...OK, stdout: 'w\t3.0\t30MB\tnow' },
      }),
    })
    expect(sources.map((s) => s.source)).toEqual(['docker', 'podman', 'wsl-docker'])
    expect(sources[0]).toMatchObject({ ok: true, images: [{ ref: 'ubuntu:24.04' }, { ref: 'openbot-gui:24.04' }, { ref: 'hello-world:latest' }] })
    expect(sources[1]).toMatchObject({ ok: true, images: [{ ref: 'a:1.0' }, { ref: 'b:2.0' }] })
    expect(sources[2]).toMatchObject({ ok: true, images: [{ ref: 'w:3.0' }] })
  })

  it('如实失败：spawn 失败 = CLI 未装；exit 非 0 = 带原始输出与指引；空清单是合法可用', async () => {
    const sources = await scanEnvImages({
      run: respondScan({
        docker: spawnFail('docker'),
        podman: { ...OK, exitCode: 125, stderr: 'Cannot connect to Podman. podman machine start' },
        wsl: { ...OK, stdout: '' },
      }),
    })
    expect(sources[0]).toMatchObject({ source: 'docker', ok: false, reason: 'docker 未安装或不在 PATH' })
    expect(sources[1]?.ok).toBe(false)
    expect(sources[1]?.reason).toContain('退出码 125')
    expect(sources[1]?.reason).toContain('podman machine start')
    expect(sources[2]).toEqual({ source: 'wsl-docker', ok: true, images: [] })
  })

  it('故障隔离：单源失败不拖累他源；wsl 自身报错（utf16 乱码含 NUL）清洗后如实呈现', async () => {
    const sources = await scanEnvImages({
      run: respondScan({
        docker: { ...OK, stdout: DOCKER_IMAGES },
        podman: spawnFail('podman'),
        wsl: { ...OK, exitCode: 4294967295, stderr: '没有已安装的分发版\u0000' },
      }),
    })
    expect(sources[0]?.ok).toBe(true)
    expect(sources[1]).toMatchObject({ source: 'podman', ok: false, reason: 'podman 未安装或不在 PATH' })
    expect(sources[2]?.ok).toBe(false)
    expect(sources[2]?.reason).not.toContain('\u0000')
    expect(sources[2]?.reason).toContain('退出码')
  })

  it('平台门控：linux/darwin 不追查 wsl 来源（CLI 必然不在，跑了也是噪音）', async () => {
    for (const platform of ['linux', 'darwin']) {
      const sources = await scanEnvImages({
        platform,
        run: respondScan({ docker: { ...OK }, podman: { ...OK } }),
      })
      expect(sources.map((s) => s.source)).toEqual(['docker', 'podman'])
    }
    const win32 = await scanEnvImages({
      platform: 'win32',
      run: respondScan({ docker: { ...OK }, podman: { ...OK }, wsl: { ...OK } }),
    })
    expect(win32.map((s) => s.source)).toEqual(['docker', 'podman', 'wsl-docker'])
  })
})
