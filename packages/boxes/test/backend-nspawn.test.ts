/**
 * backend-nspawn 测试：两层——
 * 1) 脚本化替身（默认跑，CI 零 systemd 环境）：断言 machinectl/systemctl 参数序列、错误语义、
 *    list 前缀过滤、caps 如实（resourceLimits=true 与 wsl 的差异点）；
 * 2) 真实套件（OPENBOT_TEST_NSPAWN=1 且 OPENBOT_TEST_ROOTFS 指向 tarball，Linux 真机 + machinectl
 *    写授权）：真 import-tar/shell exec/fs/export-tar/remove——机器条件就绪即参数化复跑（P5 OCI 模式）。
 * 与 backend-wsl/backend-oci 同一测试哲学（mock 对称，ARCHITECTURE.md §6）。
 */
import { describe, expect, it } from 'vitest'
import { NspawnBoxBackend, NSPAWN_BOX_CAPS, NSPAWN_BOX_PREFIX } from '../src/backend-nspawn/index.js'
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
const cmd = (calls: ProcSpec[], ...fragments: string[]): ProcSpec | undefined =>
  calls.find((c) => fragments.every((f) => c.command.includes(f)))

const make = (run: ProcRunner, extra: Partial<ConstructorParameters<typeof NspawnBoxBackend>[0]> = {}) =>
  new NspawnBoxBackend({ rootfs: '/rootfs.tar', snapshotDir: '/snaps', run, ...extra })

describe('NspawnBoxBackend（脚本化替身）', () => {
  it('caps 如实：resourceLimits=true（set-property 真落 cgroup——与 wsl 的关键差异）、隔离 medium', () => {
    expect(NSPAWN_BOX_CAPS.resourceLimits).toBe(true)
    expect(NSPAWN_BOX_CAPS.isolation).toBe('medium')
    expect(new NspawnBoxBackend({ rootfs: '/r.tar', snapshotDir: '/s', run: scripted(() => OK).run }).caps()).toEqual(NSPAWN_BOX_CAPS)
  })

  it('create：机器即 Box——先查存在（list --no-legend），不存在则 import-tar（特权前缀）→ 拉起 → 初始化工作目录', async () => {
    const { run, calls } = scripted((spec) => {
      if (spec.command.includes('list')) return { ...OK, stdout: 'host1\n' } // 无同名机器
      if (spec.command.includes('is-active')) return { ...OK, exitCode: 3 } // inactive → 触发拉起
      return OK
    })
    const backend = make(run)
    const box = await backend.create({ image: 'default', cpus: 2, memoryMb: 2048 })
    expect(box).toBe('box-1')
    expect(calls[0]?.command).toEqual(['machinectl', 'list', '--no-legend', '--no-pager'])
    expect(cmd(calls, 'import-tar')?.command).toEqual([
      'machinectl', 'import-tar', '/rootfs.tar', `${NSPAWN_BOX_PREFIX}box-1`,
    ])
    // 冷机拉起：is-active 判定先行（exit 非 0 = 关机）→ start
    expect(cmd(calls, 'is-active')?.command).toEqual(['systemctl', 'is-active', `machine-${NSPAWN_BOX_PREFIX}box-1.scope`])
    expect(cmd(calls, 'start')?.command).toEqual(['machinectl', 'start', `${NSPAWN_BOX_PREFIX}box-1`])
    expect(cmd(calls, '/bin/mkdir')?.command).toEqual([
      'machinectl', 'shell', '--quiet', `root@${NSPAWN_BOX_PREFIX}box-1`, '/bin/mkdir', '-p', '/work',
    ])
    // 资源上限（caps 兑现）：scope 单元 set-property
    expect(cmd(calls, 'set-property')?.command).toEqual([
      'systemctl', 'set-property', `machine-${NSPAWN_BOX_PREFIX}box-1.scope`, 'CPUQuota=200%', 'MemoryMax=2048M',
    ])
  })

  it('create 幂等：机器已存在跳过 import；已 running 则跳过 start（is-active exit 0）', async () => {
    const { run, calls } = scripted((spec) => {
      if (spec.command.includes('list')) return { ...OK, stdout: `host1\n${NSPAWN_BOX_PREFIX}box-1\n` }
      if (spec.command.includes('is-active')) return OK // running
      return OK
    })
    const backend = make(run)
    await backend.create({ image: 'default' })
    expect(calls.some((c) => c.command.includes('import-tar'))).toBe(false)
    expect(calls.some((c) => c.command.includes('start'))).toBe(false)
  })

  it('特权前缀注入：privilegePrefix 加在写操作（import/start/set-property）前、读操作（list/is-active）不加', async () => {
    const { run, calls } = scripted((spec) => {
      if (spec.command.includes('list')) return { ...OK, stdout: '\n' }
      if (spec.command.includes('is-active')) return { ...OK, exitCode: 3 } // inactive → start 带 sudo
      return OK
    })
    const backend = make(run, { privilegePrefix: ['sudo'] })
    await backend.create({ image: 'default', cpus: 1 })
    expect(cmd(calls, 'import-tar')?.command[0]).toBe('sudo')
    expect(cmd(calls, 'start')?.command[0]).toBe('sudo')
    expect(cmd(calls, 'set-property')?.command[0]).toBe('sudo')
    expect(cmd(calls, 'list')?.command[0]).toBe('machinectl')
    expect(cmd(calls, 'is-active')?.command[0]).toBe('systemctl')
  })

  it('import 失败抛 BOX_CREATE_FAILED（stderr 进 message）', async () => {
    const { run } = scripted((spec) => {
      if (spec.command.includes('list')) return { ...OK, stdout: '\n' }
      if (spec.command.includes('import-tar')) return { ...OK, exitCode: 1, stderr: 'polkit 拒绝' }
      return OK
    })
    await expect(make(run).create({ image: 'default' })).rejects.toMatchObject({
      code: 'BOX_CREATE_FAILED',
      message: expect.stringContaining('polkit 拒绝'),
    })
  })

  it('exec：无 cwd 时 argv 直传 + env 经 /usr/bin/env；onChunk 透传、结果聚合', async () => {
    const chunks: Array<{ stream: 'stdout' | 'stderr'; text: string }> = []
    const { run, calls } = scripted((spec) => {
      if (spec.command.includes('list')) return { ...OK, stdout: '\n' }
      if (spec.command.at(-1) === 'node' || spec.command.includes('-v')) {
        spec.onChunk?.({ stream: 'stdout', text: 'hi\n' })
        return { ...OK, stdout: 'hi\n' }
      }
      return OK
    })
    const backend = make(run)
    await backend.create({ image: 'default' })
    const r = await backend.exec('box-1', {
      command: ['node', '-v'],
      env: { K: 'V' },
      onChunk: (c) => chunks.push(c),
    })
    expect(last(calls)).toEqual([
      'machinectl', 'shell', '--quiet', `root@${NSPAWN_BOX_PREFIX}box-1`, '/usr/bin/env', 'K=V', '--', 'node', '-v',
    ])
    expect(chunks).toEqual([{ stream: 'stdout', text: 'hi\n' }])
    expect(r).toEqual({ exitCode: 0, stdout: 'hi\n', stderr: '' })
  })

  it('exec 带 cwd：machinectl 无工作目录参数——sh -c 包裹（quote 保护，无注入面）', async () => {
    const { run, calls } = scripted((spec) => {
      if (spec.command.includes('list')) return { ...OK, stdout: '\n' }
      return OK
    })
    const backend = make(run)
    await backend.create({ image: 'default' })
    await backend.exec('box-1', { command: ['ls'], cwd: `/work's dir` })
    const shell = last(calls)
    expect(shell).toEqual([
      'machinectl', 'shell', '--quiet', `root@${NSPAWN_BOX_PREFIX}box-1`,
      '/bin/sh', '-c', `cd '/work'\\''s dir' && exec 'ls'`,
    ])
    // env 与 cwd 同场：/usr/bin/env 注入（exec builtin 无 -- 参数）
    await backend.exec('box-1', { command: ['ls'], cwd: '/work', env: { K: 'V' } })
    expect(last(calls).at(-1)).toContain('/usr/bin/env')
  })

  it('exec 超时抛 BOX_EXEC_TIMEOUT；signal 透传、aborted 抛 BOX_EXEC_ABORTED（zombie 契约与取消传导）', async () => {
    const controller = new AbortController()
    // exec 调用经 timeoutMs/signal 特征判定（shell --quiet 非独有——create 的 mkdir 同形）
    const { run } = scripted((spec) => {
      if (spec.command.includes('list')) return { ...OK, stdout: '\n' }
      if (spec.timeoutMs === 100) return { ...OK, exitCode: null, timedOut: true }
      return OK
    })
    const backend = make(run)
    await backend.create({ image: 'default' })
    await expect(backend.exec('box-1', { command: ['sleep', '999'], timeoutMs: 100 })).rejects.toMatchObject({
      code: 'BOX_EXEC_TIMEOUT',
    })
    const { run: run2, calls: calls2 } = scripted((spec) => {
      if (spec.command.includes('list')) return { ...OK, stdout: '\n' }
      if (spec.signal !== undefined) return { ...OK, exitCode: null, aborted: true }
      return OK
    })
    const backend2 = make(run2)
    await backend2.create({ image: 'default' })
    await expect(backend2.exec('box-1', { command: ['sleep', '999'], signal: controller.signal })).rejects.toMatchObject({
      code: 'BOX_EXEC_ABORTED',
    })
    const execCall = calls2.find((c) => c.signal === controller.signal)
    expect(execCall?.signal).toBe(controller.signal) // 传导链：ExecSpec.signal → ProcSpec.signal
  })

  it('fsWrite 走 base64 中转；fsRead cat 失败返回 null（不抛）', async () => {
    const { run, calls } = scripted((spec) => {
      if (spec.command.includes('list')) return { ...OK, stdout: '\n' }
      if (spec.command.includes('/bin/cat')) return { ...OK, exitCode: 1, stderr: 'No such file' }
      return OK
    })
    const backend = make(run)
    await backend.create({ image: 'default' })
    expect(await backend.fsRead('box-1', '/work/x.txt')).toBeNull()
    await backend.fsWrite('box-1', '/work/x.txt', '内容')
    const write = last(calls).join(' ')
    expect(write).toContain(`root@${NSPAWN_BOX_PREFIX}box-1`)
    expect(write).toContain('base64 -d')
  })

  it('snapshot：先 poweroff（一致性）再 export-tar 裸 tar；listSnapshots 扫目录 N 降序带体积', async () => {
    const { run, calls } = scripted((spec) => {
      if (spec.command.includes('list')) return { ...OK, stdout: '\n' }
      return OK
    })
    const backend = make(run, {
      listDir: async () => ['snap-2.tar', 'snap-1.tar', 'unrelated.txt'],
      statFile: async (p) => ({ size: p.endsWith('snap-1.tar') ? 100 : 200 }),
    })
    await backend.create({ image: 'default' })
    const id = await backend.snapshot('box-1')
    expect(id).toBe('snap-1')
    const idxPoweroff = calls.findIndex((c) => c.command.includes('poweroff'))
    const idxExport = calls.findIndex((c) => c.command.includes('export-tar'))
    expect(idxPoweroff).toBeGreaterThanOrEqual(0)
    expect(idxExport).toBeGreaterThan(idxPoweroff) // 关机先于导出（一致性）
    expect(cmd(calls, 'export-tar')?.command).toEqual([
      'machinectl', 'export-tar', `${NSPAWN_BOX_PREFIX}box-1`, '/snaps/snap-1.tar',
    ])
    const chain = await backend.listSnapshots()
    expect(chain).toEqual([
      { snapshotId: 'snap-2', sizeBytes: 200 },
      { snapshotId: 'snap-1', sizeBytes: 100 },
    ])
  })

  it('restore：poweroff → remove → import-tar 快照（破坏性语义）', async () => {
    const { run, calls } = scripted((spec) => {
      if (spec.command.includes('list')) return { ...OK, stdout: '\n' }
      return OK
    })
    const backend = make(run)
    await backend.create({ image: 'default' })
    await backend.restore('box-1', 'snap-3')
    // restore 的三笔是尾段（create 的 import 在前）——import 断言取尾笔（快照 tar 而非 rootfs）
    const order = calls.slice(-3).map((c) => c.command.filter((f) => ['poweroff', 'remove', 'import-tar'].includes(f))[0])
    expect(order).toEqual(['poweroff', 'remove', 'import-tar'])
    expect(calls.at(-1)?.command).toEqual([
      'machinectl', 'import-tar', '/snaps/snap-3.tar', `${NSPAWN_BOX_PREFIX}box-1`,
    ])
  })

  it('stats：MemoryCurrent 字节→MB + du 磁盘；cpuPercent 如实缺席（累计纳秒无百分比真相）', async () => {
    const { run } = scripted((spec) => {
      if (spec.command.includes('list')) return { ...OK, stdout: '\n' }
      if (spec.command.includes('MemoryCurrent')) return { ...OK, stdout: '1073741824\n' } // 1 GiB
      return OK
    })
    const backend = make(run, { diskUsageMb: async () => 512 })
    await backend.create({ image: 'default' })
    const s = await backend.stats('box-1')
    expect(s).toEqual({ memoryMb: 1024, diskMb: 512 })
  })

  it('pause/resume：poweroff/start + sleeping 态投影到 list；exec 自然唤醒清除', async () => {
    const { run, calls } = scripted((spec) => {
      if (spec.command.includes('list')) return { ...OK, stdout: `${NSPAWN_BOX_PREFIX}box-1\n` }
      if (spec.command.includes('is-active')) return { ...OK, exitCode: 3 } // inactive
      return OK
    })
    const backend = make(run)
    await backend.create({ image: 'default' })
    await backend.pause('box-1')
    expect(cmd(calls, 'poweroff')?.command).toEqual(['machinectl', 'poweroff', `${NSPAWN_BOX_PREFIX}box-1`])
    expect((await backend.list()).find((b) => b.boxId === 'box-1')?.state).toBe('sleeping')
    await backend.resume('box-1')
    expect(cmd(calls, 'start')?.command).toEqual(['machinectl', 'start', `${NSPAWN_BOX_PREFIX}box-1`])
    expect((await backend.list()).find((b) => b.boxId === 'box-1')?.state).toBe('active')
  })

  it('poweroff 幂等：已关机（stderr 含 not active）不算失败', async () => {
    const { run } = scripted((spec) => {
      if (spec.command.includes('list')) return { ...OK, stdout: '\n' }
      if (spec.command.includes('poweroff')) return { ...OK, exitCode: 1, stderr: 'Machine is not active' }
      return OK
    })
    const backend = make(run)
    await backend.create({ image: 'default' })
    await expect(backend.pause('box-1')).resolves.toBeUndefined()
  })

  it('teardown：poweroff → remove；list 前缀过滤（手工 machine 不碰）+ 跨重启恢复', async () => {
    const { run, calls } = scripted((spec) => {
      if (spec.command.includes('list')) return { ...OK, stdout: `host1\n${NSPAWN_BOX_PREFIX}box-1\n${NSPAWN_BOX_PREFIX}box-2\n` }
      return OK
    })
    const backend = make(run)
    await backend.create({ image: 'default' }) // box-1
    const boxes = await backend.list()
    expect(boxes.map((b) => b.boxId).sort()).toEqual(['box-1', 'box-2']) // host1 被前缀过滤
    expect(boxes.find((b) => b.boxId === 'box-1')?.spec.image).toBe('default') // 内存态 spec
    expect(boxes.find((b) => b.boxId === 'box-2')?.spec.image).toBe('nspawn') // 跨重启恢复的未知 spec 如实
    await backend.teardown('box-1')
    const order = calls.slice(-2).map((c) => c.command.filter((f) => ['poweroff', 'remove'].includes(f))[0])
    expect(order).toEqual(['poweroff', 'remove'])
  })

  it('openShell：machinectl shell argv 直传（PTY 边界真机待验——platforms.md 记档）', async () => {
    const spawned: string[][] = []
    const spawnShell: ShellSpawner = (command) => {
      spawned.push(command)
      return {
        write: () => {},
        onOutput: () => {},
        onExit: () => {},
        kill: () => {},
      }
    }
    const { run } = scripted((spec) => {
      if (spec.command.includes('list')) return { ...OK, stdout: '\n' }
      return OK
    })
    const backend = make(run, { spawnShell })
    await backend.create({ image: 'default' })
    const session = await backend.openShell('box-1')
    session.close()
    expect(spawned[0]).toEqual(['machinectl', 'shell', `root@${NSPAWN_BOX_PREFIX}box-1`])
  })

  it('Box 不存在抛 BOX_NOT_FOUND', async () => {
    const { run } = scripted(() => OK)
    await expect(make(run).exec('box-9', { command: ['true'] })).rejects.toMatchObject({ code: 'BOX_NOT_FOUND' })
  })
})

/** 真实套件（Linux 真机 + machinectl 写授权 + rootfs tarball；默认 skip） */
const real = process.env.OPENBOT_TEST_NSPAWN === '1'
const rootfs = process.env.OPENBOT_TEST_ROOTFS
describe('NspawnBoxBackend（真实套件）', { skip: !(real && rootfs) }, () => {
  it('import-tar → shell exec → fsWrite/fsRead → export-tar → remove 全链', async () => {
    const backend = new NspawnBoxBackend({
      rootfs: rootfs!,
      snapshotDir: `/tmp/openbot-nspawn-test-${Date.now()}`,
    })
    const box = await backend.create({ image: 'default' })
    const r = await backend.exec(box, { command: ['/bin/echo', 'nspawn-ok'] })
    expect(r.exitCode).toBe(0)
    expect(r.stdout.trim()).toBe('nspawn-ok')
    await backend.fsWrite(box, '/work/x.txt', 'hello')
    expect(await backend.fsRead(box, '/work/x.txt')).toBe('hello')
    await backend.snapshot(box)
    expect((await backend.listSnapshots()).length).toBe(1)
    await backend.teardown(box)
  })
})
