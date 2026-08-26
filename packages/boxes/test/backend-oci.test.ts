/**
 * backend-oci 测试（P5 Step 5）：两层——
 * 1) 脚本化替身（默认跑，CI 零 Docker 依赖）：断言 docker/podman CLI 参数序列、状态机
 *    （自然唤醒/跨重启幂等）、stats 双格式解析、快照链与回滚顺序、错误语义；
 * 2) 真实套件（OPENBOT_TEST_DOCKER=1）：真 create/exec/fs/snapshot/stats/restore/teardown
 *    （Step 8 真机验收复用；镜像经 OPENBOT_TEST_IMAGE 覆盖）。
 * 与 backend-wsl 注入 ProcRunner、llm 注入 fetch 同一测试哲学（mock 对称，ARCHITECTURE.md §6）。
 */
import { afterAll, describe, expect, it } from 'vitest'
import { DockerBoxBackend } from '../src/backend-docker/index.js'
import { PodmanBoxBackend } from '../src/backend-podman/index.js'
import {
  OCI_BOX_PREFIX,
  OCI_SNAPSHOT_REPO,
  OciBoxBackend,
  memUsageToMb,
  parseOciStats,
} from '../src/backend-oci/index.js'
import { runProcess } from '../src/procexec/index.js'
import type { ProcResult, ProcRunner, ProcSpec, ShellSpawner } from '../src/procexec/index.js'

const OK: ProcResult = { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false, aborted: false }

/** 记录调用的替身执行器 */
function scripted(impl: (spec: ProcSpec) => ProcResult | Promise<ProcResult>): { run: ProcRunner; calls: ProcSpec[] } {
  const calls: ProcSpec[] = []
  const run: ProcRunner = async (spec) => {
    calls.push(spec)
    return impl(spec)
  }
  return { run, calls }
}

const last = (calls: ProcSpec[]): string[] => calls[calls.length - 1]?.command ?? []

/** ps 查询回给指定状态（missing=空输出） */
const psRespond = (state: 'up' | 'paused' | 'stopped' | 'missing') => (spec: ProcSpec): ProcResult => {
  if (spec.command.includes('ps')) {
    if (state === 'missing') return { ...OK, stdout: '' }
    const shown = state === 'up' ? 'Up 2 hours' : state === 'paused' ? 'Paused' : 'Exited (0) 5 minutes ago'
    const name = spec.command[spec.command.indexOf('--filter') + 1]?.slice('name='.length) ?? ''
    return { ...OK, stdout: `${name}\t${shown}\r\n` }
  }
  return OK
}

describe('OciBoxBackend（脚本化替身）', () => {
  it('caps 如实：persistent 弱（需卷挂载）、resourceLimits ✓、isolation medium、suspendable ✓', () => {
    const backend = new OciBoxBackend({ id: 'docker', cli: 'docker' })
    expect(backend.caps()).toMatchObject({
      persistent: false,
      resourceLimits: true,
      isolation: 'medium',
      suspendable: true,
      snapshot: true,
    })
    expect(backend.id).toBe('docker')
  })

  it('create：容器即 Box——missing 先 run -d（--cpus/--memory 上限 + sleep infinity）再初始化工作目录', async () => {
    const { run, calls } = scripted(psRespond('missing'))
    const backend = new OciBoxBackend({ id: 'docker', cli: 'docker', run })
    const box = await backend.create({ image: 'default', cpus: 2, memoryMb: 512 })
    expect(box).toBe('box-1')
    expect(calls[0]?.command).toEqual([
      'docker', 'ps', '-a', '--filter', `name=${OCI_BOX_PREFIX}box-1`, '--format', '{{.Names}}\t{{.State}}',
    ])
    expect(calls[1]?.command).toEqual([
      'docker', 'run', '-d', '--name', `${OCI_BOX_PREFIX}box-1`, '--cpus', '2', '--memory', '512m',
      'ubuntu:24.04', 'sleep', 'infinity',
    ])
    expect(calls[2]?.command).toEqual(['docker', 'exec', `${OCI_BOX_PREFIX}box-1`, 'mkdir', '-p', '/work'])
  })

  it('create 无资源上限时省略 --cpus/--memory；spec.image 非默认值透传镜像名', async () => {
    const { run, calls } = scripted(psRespond('missing'))
    const backend = new OciBoxBackend({ id: 'docker', cli: 'docker', run })
    await backend.create({ image: 'debian:12' })
    const runArgs = calls.find((c) => c.command.includes('run'))?.command
    expect(runArgs).not.toContain('--cpus')
    expect(runArgs?.slice(-3)).toEqual(['debian:12', 'sleep', 'infinity'])
  })

  it('create 幂等：容器已存在（Exited）跳过 run——自然拉起后初始化工作目录（桌面重启复用）', async () => {
    const { run, calls } = scripted(psRespond('stopped'))
    const backend = new OciBoxBackend({ id: 'docker', cli: 'docker', run })
    const box = await backend.create({ image: 'default' })
    expect(box).toBe('box-1')
    expect(calls.some((c) => c.command.includes('run') && c.command.includes('-d'))).toBe(false)
    // create 查一次 ps + ensureRunning 再查一次（先查后动与 exec 同构）——find 式断言不锁索引
    expect(calls.find((c) => c.command[1] === 'start')?.command).toEqual(['docker', 'start', `${OCI_BOX_PREFIX}box-1`])
    expect(last(calls)).toEqual(['docker', 'exec', `${OCI_BOX_PREFIX}box-1`, 'mkdir', '-p', '/work'])
  })

  it('create 失败抛 BOX_CREATE_FAILED（stderr 进 message）', async () => {
    // 定向失败：ps 放行（回 missing 走 run 路径）、仅 run 失败——一刀切失败会先炸在 ps 的
    // BOX_STATE_QUERY_FAILED，测不到创建错误码
    const { run } = scripted((spec) => {
      if (spec.command.includes('ps')) return psRespond('missing')(spec)
      return { ...OK, exitCode: 1, stderr: 'no such image' }
    })
    const backend = new OciBoxBackend({ id: 'docker', cli: 'docker', run })
    await expect(backend.create({ image: 'default' })).rejects.toMatchObject({
      code: 'BOX_CREATE_FAILED',
      message: expect.stringContaining('no such image'),
    })
  })

  it('exec：-w/-e 注入 + -- 分隔；Running 容器直通（零额外动作）', async () => {
    const { run, calls } = scripted(psRespond('up'))
    const backend = new OciBoxBackend({ id: 'docker', cli: 'docker', run })
    await backend.create({ image: 'default' })
    const r = await backend.exec('box-1', { command: ['node', '-v'], env: { K: 'V' }, cwd: '/tmp' })
    expect(r.exitCode).toBe(0)
    expect(last(calls)).toEqual([
      'docker', 'exec', '-w', '/tmp', '-e', 'K=V', `${OCI_BOX_PREFIX}box-1`, '--', 'node', '-v',
    ])
  })

  it('exec 自然唤醒：Paused 容器先 unpause、Exited 容器先 start（podman start 对运行中报错——先查后动）', async () => {
    for (const [state, action] of [
      ['paused', 'unpause'],
      ['stopped', 'start'],
    ] as const) {
      const { run, calls } = scripted(psRespond(state))
      const backend = new OciBoxBackend({ id: 'docker', cli: 'docker', run })
      await backend.create({ image: 'default' })
      await backend.exec('box-1', { command: ['true'] })
      expect(calls.find((c) => c.command[1] === action)?.command).toEqual([
        'docker', action, `${OCI_BOX_PREFIX}box-1`,
      ])
    }
  })

  it('exec 超时/中止语义：BOX_EXEC_TIMEOUT / BOX_EXEC_ABORTED（procexec 传导）', async () => {
    // 两阶段替身：create 阶段全通（box 入册），exec 阶段切超时/中止结算
    let mode: 'normal' | 'timeout' | 'abort' = 'normal'
    const run: ProcRunner = async (spec) => {
      if (spec.command.includes('ps')) return psRespond('up')(spec)
      if (mode === 'timeout') return { ...OK, exitCode: null, timedOut: true }
      if (mode === 'abort') return { ...OK, exitCode: null, aborted: true }
      return OK
    }
    const backend = new OciBoxBackend({ id: 'docker', cli: 'docker', run })
    await backend.create({ image: 'default' })
    mode = 'timeout'
    await expect(backend.exec('box-1', { command: ['x'] })).rejects.toMatchObject({ code: 'BOX_EXEC_TIMEOUT' })
    mode = 'abort'
    await expect(backend.exec('box-1', { command: ['x'] })).rejects.toMatchObject({ code: 'BOX_EXEC_ABORTED' })
  })

  it('snapshot：commit 打 openbot-snap:N 镜像标签（镜像即快照）', async () => {
    const { run, calls } = scripted(psRespond('up'))
    const backend = new OciBoxBackend({ id: 'docker', cli: 'docker', run })
    await backend.create({ image: 'default' })
    const snap = await backend.snapshot('box-1')
    expect(snap).toBe('snap-1')
    expect(last(calls)).toEqual(['docker', 'commit', `${OCI_BOX_PREFIX}box-1`, `${OCI_SNAPSHOT_REPO}:snap-1`])
  })

  it('listSnapshots：images 列 tag + inspect 补真值（Size 字节 / Created epoch）；N 降序=最近在前', async () => {
    const { run, calls } = scripted((spec) => {
      if (spec.command.includes('images')) return { ...OK, stdout: 'snap-2\r\nsnap-10\r\nsnap-1\r\n<none>\r\n' }
      if (spec.command.includes('inspect')) return { ...OK, stdout: '731545088|2026-08-26T10:00:00Z' }
      return psRespond('up')(spec)
    })
    const backend = new OciBoxBackend({ id: 'docker', cli: 'docker', run })
    const snaps = await backend.listSnapshots()
    expect(snaps.map((s) => s.snapshotId)).toEqual(['snap-10', 'snap-2', 'snap-1'])
    expect(snaps[0]).toMatchObject({ sizeBytes: 731545088, createdAt: Date.parse('2026-08-26T10:00:00Z') })
    expect(calls[0]?.command).toEqual(['docker', 'images', OCI_SNAPSHOT_REPO, '--format', '{{.Tag}}'])
    expect(calls[1]?.command).toEqual([
      'docker', 'image', 'inspect', `${OCI_SNAPSHOT_REPO}:snap-2`, '--format', '{{.Size}}|{{.Created}}',
    ])
  })

  it('restore：先校验快照镜像在场（缺失时容器原样保留）→ rm -f → run -d 重建（上限随 spec）', async () => {
    const { run, calls } = scripted(psRespond('up'))
    const backend = new OciBoxBackend({ id: 'docker', cli: 'docker', run })
    await backend.create({ image: 'default', cpus: 2, memoryMb: 512 })
    await backend.restore('box-1', 'snap-1')
    expect(calls.some((c) => c.command[1] === 'image' && c.command[2] === 'inspect')).toBe(true)
    expect(calls.find((c) => c.command[1] === 'rm')?.command).toEqual(['docker', 'rm', '-f', `${OCI_BOX_PREFIX}box-1`])
    expect(last(calls)).toEqual([
      'docker', 'run', '-d', '--name', `${OCI_BOX_PREFIX}box-1`, '--cpus', '2', '--memory', '512m',
      `${OCI_SNAPSHOT_REPO}:snap-1`, 'sleep', 'infinity',
    ])
  })

  it('restore 镜像缺失：前置拒绝（BOX_RESTORE_FAILED），容器未删', async () => {
    const { run, calls } = scripted((spec) => {
      if (spec.command.includes('image')) return { ...OK, exitCode: 1, stderr: 'not found' }
      return psRespond('up')(spec)
    })
    const backend = new OciBoxBackend({ id: 'docker', cli: 'docker', run })
    await backend.create({ image: 'default' })
    await expect(backend.restore('box-1', 'snap-1')).rejects.toMatchObject({ code: 'BOX_RESTORE_FAILED' })
    expect(calls.some((c) => c.command[1] === 'rm')).toBe(false)
  })

  it('pause/unpause + resume=确保运行（paused→unpause / stopped→start）；失败稳定码族', async () => {
    const { run, calls } = scripted(psRespond('paused'))
    const backend = new OciBoxBackend({ id: 'docker', cli: 'docker', run })
    await backend.create({ image: 'default' })
    await backend.pause('box-1')
    expect(calls.find((c) => c.command[1] === 'pause')?.command).toEqual(['docker', 'pause', `${OCI_BOX_PREFIX}box-1`])
    await backend.resume('box-1')
    expect(calls.some((c) => c.command[1] === 'unpause')).toBe(true)

    // 定向失败：ps + mkdir（create 初始化链）放行、仅 pause 失败
    const failRun: ProcRunner = async (spec) => {
      if (spec.command.includes('ps')) return psRespond('up')(spec)
      if (spec.command.includes('mkdir')) return OK
      return { ...OK, exitCode: 1, stderr: 'engine down' }
    }
    const b2 = new OciBoxBackend({ id: 'docker', cli: 'docker', run: failRun })
    await b2.create({ image: 'default' })
    await expect(b2.pause('box-1')).rejects.toMatchObject({ code: 'BOX_PAUSE_FAILED' })
  })

  it('stats：docker 样本（单行对象 CPUPerc）与 podman 样本（数组 + CPU 字段）同解；失败如实空报告', async () => {
    const dockerSample =
      '{"BlockIO":"0B / 0B","CPUPerc":"12.34%","Container":"x","ID":"abc","MemPerc":"0.6%","MemUsage":"3.1MiB / 512MiB","Name":"x","NetIO":"0B / 0B","PIDs":"5"}'
    const podmanSample = `[{"CPU":"0.500000%","MemUsage":"1.5GiB / 2GiB","Name":"x"}]`
    const { run } = scripted((spec) => {
      if (spec.command.includes('stats')) return { ...OK, stdout: dockerSample }
      return psRespond('up')(spec)
    })
    const backend = new OciBoxBackend({ id: 'docker', cli: 'docker', run })
    await backend.create({ image: 'default' })
    expect(await backend.stats('box-1')).toEqual({ cpuPercent: 12.3, memoryMb: 3 })

    expect(parseOciStats(dockerSample)).toEqual({ cpuPercent: 12.3, memoryMb: 3 })
    expect(parseOciStats(podmanSample)).toEqual({ cpuPercent: 0.5, memoryMb: 1536 })
    expect(parseOciStats('')).toEqual({})
    expect(parseOciStats('Error response from daemon')).toEqual({})

    // 定向失败：仅 stats 失败（ps + mkdir 放行——create 要走通才能测 stats 的空报告语义）
    const failRun: ProcRunner = async (spec) => {
      if (spec.command.includes('stats')) return { ...OK, exitCode: 1, stderr: 'x' }
      if (spec.command.includes('ps')) return psRespond('up')(spec)
      return OK
    }
    const b2 = new OciBoxBackend({ id: 'docker', cli: 'docker', run: failRun })
    await b2.create({ image: 'default' })
    expect(await b2.stats('box-1')).toEqual({})
  })

  it('memUsageToMb 单位族：B/KiB/MiB/GiB 与十进制变体', () => {
    expect(memUsageToMb('1.1MiB / 512MiB')).toBe(1)
    expect(memUsageToMb('2GiB / 4GiB')).toBe(2048)
    expect(memUsageToMb('512KiB / 1GiB')).toBe(1) // 0.5 MB 四舍五入为 1
    expect(memUsageToMb('1048576B')).toBe(1)
    expect(memUsageToMb('n/a')).toBeNull()
  })

  it('list：ps 模板解析（Up/Paused/Exited→三态）+ 前缀精确过滤（用户自建容器不碰）', async () => {
    // 直接构造 ps 输出（多容器混合 + 一个非前缀容器）
    const multiRun: ProcRunner = async (spec) => {
      if (spec.command.includes('ps')) {
        return {
          ...OK,
          stdout: `my-openbot-box-9\tUp 2 hours\r\n${OCI_BOX_PREFIX}box-1\tUp 30 seconds\r\n${OCI_BOX_PREFIX}box-2\tPaused\r\n${OCI_BOX_PREFIX}box-3\tExited (0) 5 minutes ago\r\n`,
        }
      }
      return OK
    }
    const backend = new OciBoxBackend({ id: 'docker', cli: 'docker', run: multiRun })
    const list = await backend.list()
    expect(list.map((b) => [b.boxId, b.state])).toEqual([
      ['box-1', 'active'],
      ['box-2', 'sleeping'],
      ['box-3', 'sleeping'],
    ])
  })

  it('openShell：exec -i + 容器内 script 分配 PTY（与 WSL 同构——Windows 侧字节管道）', async () => {
    const shells: string[][] = []
    const spawnShell: ShellSpawner = (command) => {
      shells.push(command)
      return {
        write: () => undefined,
        onOutput: () => undefined,
        onExit: (cb) => cb(0),
        kill: () => undefined,
      }
    }
    const { run } = scripted(psRespond('up'))
    const backend = new OciBoxBackend({ id: 'docker', cli: 'docker', run, spawnShell })
    await backend.create({ image: 'default' })
    const session = await backend.openShell('box-1', { cols: 120, rows: 40 })
    expect(shells[0]).toEqual([
      'docker', 'exec', '-i', `${OCI_BOX_PREFIX}box-1`,
      'script', '-qec', 'stty rows 40 cols 120; exec bash', '/dev/null',
    ])
    session.close()
  })

  it('teardown：rm -f + 注销；DockerBoxBackend 薄壳命令前缀 docker / id 一致', async () => {
    const { run, calls } = scripted(psRespond('up'))
    const backend = new DockerBoxBackend({ run })
    expect(backend.id).toBe('docker')
    await backend.create({ image: 'default' })
    await backend.teardown('box-1')
    expect(last(calls)).toEqual(['docker', 'rm', '-f', `${OCI_BOX_PREFIX}box-1`])
  })
})

// ---- 真实套件：OPENBOT_TEST_OCI=1 时才跑（默认 CI 零引擎依赖；Step 8 真机验收复用）。
// OPENBOT_TEST_CLI 选引擎（docker | podman，缺省 docker）——两壳同构底座，真机差异（stats 字段、
// start 对运行中容器的行为）在这一层暴露；镜像经 OPENBOT_TEST_IMAGE 覆盖。 ----
const REAL = process.env.OPENBOT_TEST_OCI === '1'
const CLI = process.env.OPENBOT_TEST_CLI === 'podman' ? 'podman' : 'docker'

describe(`OciBoxBackend（真实 ${CLI}）`, { skip: !REAL }, () => {
  const realOptions = { image: process.env.OPENBOT_TEST_IMAGE ?? 'ubuntu:24.04', now: Date.now }
  const backend = CLI === 'podman' ? new PodmanBoxBackend(realOptions) : new DockerBoxBackend(realOptions)

  afterAll(async () => {
    // 兜底清理：断言失败路径不残留容器与快照镜像（孤儿容器会让下轮 create 同名冲突）
    const r = await runProcess({
      command: [CLI, 'ps', '-a', '--filter', `name=${OCI_BOX_PREFIX}`, '--format', '{{.Names}}'],
      timeoutMs: 30_000,
    }).catch(() => null)
    for (const name of (r?.stdout ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
      await runProcess({ command: [CLI, 'rm', '-f', name], timeoutMs: 60_000 }).catch(() => undefined)
    }
    const imgs = await runProcess({
      command: [CLI, 'images', OCI_SNAPSHOT_REPO, '--format', '{{.Tag}}'],
      timeoutMs: 30_000,
    }).catch(() => null)
    for (const tag of (imgs?.stdout ?? '').split(/\r?\n/).map((l) => l.trim()).filter((t) => t !== '')) {
      await runProcess({ command: [CLI, 'rmi', `${OCI_SNAPSHOT_REPO}:${tag}`], timeoutMs: 60_000 }).catch(() => undefined)
    }
  })

  it('全链：create → exec（含 fs 读写）→ stats 真值 → snapshot → restore → pause/resume → teardown', async () => {
    const boxId = await backend.create({ image: 'default', cpus: 1, memoryMb: 512 })
    expect(boxId).toMatch(/^box-\d+$/)

    await backend.fsWrite(boxId, '/work/note.txt', 'hello oci')
    expect(await backend.fsRead(boxId, '/work/note.txt')).toBe('hello oci')

    const echo = await backend.exec(boxId, { command: ['cat', '/work/note.txt'] })
    expect(echo.exitCode).toBe(0)
    expect(echo.stdout).toContain('hello oci')

    const stats = await backend.stats(boxId)
    expect(stats.memoryMb).toBeGreaterThanOrEqual(0) // 真值在场（解析失败=缺字段——如实断言可失败）

    const snap = await backend.snapshot(boxId)
    expect(snap).toMatch(/^snap-\d+$/)
    const snaps = await backend.listSnapshots()
    expect(snaps.some((s) => s.snapshotId === snap)).toBe(true)

    await backend.exec(boxId, { command: ['sh', '-c', 'echo changed > /work/note.txt'] })
    await backend.restore(boxId, snap)
    expect(await backend.fsRead(boxId, '/work/note.txt')).toBe('hello oci')

    await backend.pause(boxId)
    expect((await backend.list()).find((b) => b.boxId === boxId)?.state).toBe('sleeping')
    await backend.resume(boxId)
    expect((await backend.list()).find((b) => b.boxId === boxId)?.state).toBe('active')

    await backend.teardown(boxId)
    expect((await backend.list()).some((b) => b.boxId === boxId)).toBe(false)
  })
})
