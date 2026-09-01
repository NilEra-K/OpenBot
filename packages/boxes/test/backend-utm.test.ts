/**
 * backend-utm 测试：两层——
 * 1) 脚本化替身（默认跑，CI 零 macOS/UTM）：断言 utmctl 参数序列（clone 模板模型、exec --cmd
 *    remaining 语义、--env 注入）、错误语义、parseUtmList 纯函数、caps 如实（不夸大边界）；
 * 2) 真实套件（OPENBOT_TEST_UTM=1 且 OPENBOT_TEST_TEMPLATE 指向预建模板 VM 名，mac 真机 +
 *    GUI 登录会话）：真 clone/exec/fs/snapshot/delete——机器条件就绪即参数化复跑（P5 OCI 模式）。
 * 与 backend-wsl/backend-nspawn 同一测试哲学（mock 对称，ARCHITECTURE.md §6）。
 */
import { describe, expect, it } from 'vitest'
import { UtmBoxBackend, UTM_BOX_PREFIX, UTM_SNAP_SUFFIX, UTM_BOX_CAPS, parseUtmList } from '../src/backend-utm/index.js'
import { runProcess } from '../src/procexec/index.js'
import type { ProcResult, ProcRunner, ProcSpec } from '../src/procexec/index.js'

const OK: ProcResult = { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false, aborted: false }

/** 记录调用的替身执行器；statusOf 决定 utmctl status 输出（幂等先查后动的状态源） */
function scripted(
  impl: (spec: ProcSpec) => ProcResult | Promise<ProcResult>,
): { run: ProcRunner; calls: ProcSpec[] } {
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

const make = (run: ProcRunner) => new UtmBoxBackend({ template: 'openbot-template', run })

describe('UtmBoxBackend（脚本化替身）', () => {
  it('caps 如实不夸大：interactive=false（utmctl attach 未实现）、resourceLimits=false（CLI 无配置入口）、isolation=high（VM 级）', () => {
    expect(UTM_BOX_CAPS.interactive).toBe(false)
    expect(UTM_BOX_CAPS.resourceLimits).toBe(false)
    expect(UTM_BOX_CAPS.isolation).toBe('high')
    expect(make(scripted(() => OK).run).caps()).toEqual(UTM_BOX_CAPS)
  })

  it('parseUtmList（纯函数）：表头跳过、name 含空格整段保留、非 UUID 行跳过', () => {
    const stdout = [
      'UUID                                 Status   Name',
      '5D419106-2824-4FED-BFE1-24A7F7E253D8 started  Ubuntu 24.04',
      '5D419106-2824-4FED-BFE1-24A7F7E253D9 stopped  openbot-box-box-1',
      'garbage line',
      '',
    ].join('\n')
    expect(parseUtmList(stdout)).toEqual([
      { name: 'Ubuntu 24.04', status: 'started' },
      { name: 'openbot-box-box-1', status: 'stopped' },
    ])
  })

  it('create：VM 即 Box——先查名册，不在场则 clone 模板 --name → 拉起 → 初始化工作目录', async () => {
    const { run, calls } = scripted((spec) => {
      if (spec.command.includes('list')) return { ...OK, stdout: 'UUID  Status  Name\n' } // 名册空
      if (spec.command.includes('status')) return { ...OK, stdout: 'stopped\n' } // 冷机 → 拉起
      return OK
    })
    const backend = make(run)
    const box = await backend.create({ image: 'default' })
    expect(box).toBe('box-1')
    expect(calls[0]?.command).toEqual(['utmctl', 'list'])
    expect(cmd(calls, 'clone')?.command).toEqual([
      'utmctl', 'clone', 'openbot-template', '--name', `${UTM_BOX_PREFIX}box-1`,
    ])
    expect(cmd(calls, 'start')?.command).toEqual(['utmctl', 'start', `${UTM_BOX_PREFIX}box-1`])
    expect(cmd(calls, '--cmd')?.command).toEqual([
      'utmctl', 'exec', `${UTM_BOX_PREFIX}box-1`, '--cmd', '/bin/mkdir', '-p', '/work',
    ])
  })

  it('create 幂等：同名 VM 在场跳过 clone；status started 跳过 start', async () => {
    const { run, calls } = scripted((spec) => {
      if (spec.command.includes('list')) {
        return { ...OK, stdout: `UUID  Status  Name\n5D41-xxxx started  ${UTM_BOX_PREFIX}box-1\n`.replace('5D41-xxxx', '5D419106-2824-4FED-BFE1-24A7F7E253D8') }
      }
      if (spec.command.includes('status')) return { ...OK, stdout: 'started\n' }
      return OK
    })
    await make(run).create({ image: 'default' })
    expect(calls.some((c) => c.command.includes('clone'))).toBe(false)
    expect(calls.some((c) => c.command.includes('start'))).toBe(false)
    // 工作目录初始化照跑（幂等）
    expect(cmd(calls, '--cmd')).toBeDefined()
  })

  it('clone 失败抛 BOX_CREATE_FAILED（stderr 进 message，带模板名指引）', async () => {
    const { run } = scripted((spec) => {
      if (spec.command.includes('list')) return { ...OK, stdout: '' }
      if (spec.command.includes('clone')) return { ...OK, exitCode: 1, stderr: 'Virtual machine not found.' }
      return OK
    })
    await expect(make(run).create({ image: 'default' })).rejects.toMatchObject({
      code: 'BOX_CREATE_FAILED',
      message: expect.stringContaining('openbot-template'),
    })
  })

  it('exec：--cmd remaining 语义 + --env 单值可重复；onChunk 透传、结果聚合', async () => {
    const chunks: Array<{ stream: 'stdout' | 'stderr'; text: string }> = []
    const { run, calls } = scripted((spec) => {
      if (spec.command.includes('list')) return { ...OK, stdout: '' }
      if (spec.command.includes('status')) return { ...OK, stdout: 'started\n' }
      if (spec.command.includes('--cmd')) {
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
      'utmctl', 'exec', `${UTM_BOX_PREFIX}box-1`, '--env', 'K=V', '--cmd', 'node', '-v',
    ])
    expect(chunks).toEqual([{ stream: 'stdout', text: 'hi\n' }])
    expect(r).toEqual({ exitCode: 0, stdout: 'hi\n', stderr: '' })
  })

  it('exec 带 cwd：utmctl exec 无工作目录参数——sh -c 包裹（quote 保护；env 经 --env 注给 sh 由子进程继承）', async () => {
    const { run, calls } = scripted((spec) => {
      if (spec.command.includes('list')) return { ...OK, stdout: '' }
      if (spec.command.includes('status')) return { ...OK, stdout: 'started\n' }
      return OK
    })
    const backend = make(run)
    await backend.create({ image: 'default' })
    await backend.exec('box-1', { command: ['ls'], cwd: `/work's dir`, env: { K: 'V' } })
    expect(last(calls)).toEqual([
      'utmctl', 'exec', `${UTM_BOX_PREFIX}box-1`, '--env', 'K=V', '--cmd',
      '/bin/sh', '-c', `cd '/work'\\''s dir' && exec 'ls'`,
    ])
  })

  it('exec 超时抛 BOX_EXEC_TIMEOUT；signal 透传、aborted 抛 BOX_EXEC_ABORTED', async () => {
    const controller = new AbortController()
    const { run } = scripted((spec) => {
      if (spec.command.includes('list')) return { ...OK, stdout: '' }
      if (spec.command.includes('status')) return { ...OK, stdout: 'started\n' }
      if (spec.timeoutMs === 100) return { ...OK, exitCode: null, timedOut: true }
      return OK
    })
    const backend = make(run)
    await backend.create({ image: 'default' })
    await expect(backend.exec('box-1', { command: ['sleep', '999'], timeoutMs: 100 })).rejects.toMatchObject({
      code: 'BOX_EXEC_TIMEOUT',
    })
    const { run: run2, calls: calls2 } = scripted((spec) => {
      if (spec.command.includes('list')) return { ...OK, stdout: '' }
      if (spec.command.includes('status')) return { ...OK, stdout: 'started\n' }
      if (spec.signal !== undefined) return { ...OK, exitCode: null, aborted: true }
      return OK
    })
    const backend2 = make(run2)
    await backend2.create({ image: 'default' })
    await expect(backend2.exec('box-1', { command: ['sleep', '999'], signal: controller.signal })).rejects.toMatchObject({
      code: 'BOX_EXEC_ABORTED',
    })
    expect(calls2.find((c) => c.signal === controller.signal)?.signal).toBe(controller.signal)
  })

  it('fsWrite 走 base64 中转；fsRead cat 失败返回 null（不抛）', async () => {
    const { run, calls } = scripted((spec) => {
      if (spec.command.includes('list')) return { ...OK, stdout: '' }
      if (spec.command.includes('status')) return { ...OK, stdout: 'started\n' }
      if (spec.command.includes('/bin/cat')) return { ...OK, exitCode: 1, stderr: 'No such file' }
      return OK
    })
    const backend = make(run)
    await backend.create({ image: 'default' })
    expect(await backend.fsRead('box-1', '/work/x.txt')).toBeNull()
    await backend.fsWrite('box-1', '/work/x.txt', '内容')
    expect(last(calls).join(' ')).toContain('base64 -d')
  })

  it('snapshot：stop（一致性）→ clone 快照名 → start 回来；listSnapshots 名册解析且快照克隆不进 Box 表', async () => {
    const roster = `UUID  Status  Name\n5D419106-2824-4FED-BFE1-24A7F7E253D8 started  ${UTM_BOX_PREFIX}box-1\n5D419106-2824-4FED-BFE1-24A7F7E253D9 stopped  ${UTM_BOX_PREFIX}box-1${UTM_SNAP_SUFFIX}snap-1\n`
    const { run, calls } = scripted((spec) => {
      if (spec.command.includes('list')) return { ...OK, stdout: roster }
      if (spec.command.includes('status')) return { ...OK, stdout: 'started\n' }
      return OK
    })
    const backend = make(run)
    await backend.create({ image: 'default' })
    const id = await backend.snapshot('box-1')
    expect(id).toBe('snap-1')
    const idxStop = calls.findIndex((c) => c.command.includes('stop'))
    const idxClone = calls.findIndex((c) => c.command.includes('clone') && c.command.some((a) => a.includes(`${UTM_SNAP_SUFFIX}snap-1`)))
    const idxStart = calls.findIndex((c) => c.command.includes('start'))
    expect(idxStop).toBeGreaterThanOrEqual(0)
    expect(idxClone).toBeGreaterThan(idxStop) // 关机先于克隆（一致性）
    expect(idxStart).toBeGreaterThan(idxClone) // 快照后复电
    expect(cmd(calls, 'clone')?.command).toEqual([
      'utmctl', 'clone', `${UTM_BOX_PREFIX}box-1`, '--name', `${UTM_BOX_PREFIX}box-1${UTM_SNAP_SUFFIX}snap-1`,
    ])
    const chain = await backend.listSnapshots()
    expect(chain).toEqual([{ snapshotId: 'snap-1' }]) // sizeBytes 不可知如实缺席
    expect((await backend.list()).map((b) => b.boxId)).toEqual(['box-1']) // 快照克隆不是 Box
  })

  it('restore：快照不在场如实抛；在场走 stop → delete 原名 → clone 回原名', async () => {
    const { run } = scripted((spec) => {
      if (spec.command.includes('list')) return { ...OK, stdout: '' }
      return OK
    })
    const backend = make(run)
    await backend.create({ image: 'default' })
    await expect(backend.restore('box-1', 'snap-9')).rejects.toMatchObject({ code: 'BOX_RESTORE_FAILED' })

    const roster = `UUID  Status  Name\n5D419106-2824-4FED-BFE1-24A7F7E253D8 stopped  ${UTM_BOX_PREFIX}box-1${UTM_SNAP_SUFFIX}snap-3\n`
    const { run: run2, calls } = scripted((spec) => {
      if (spec.command.includes('list')) return { ...OK, stdout: roster }
      if (spec.command.includes('status')) return { ...OK, stdout: 'started\n' }
      return OK
    })
    const backend2 = make(run2)
    await backend2.create({ image: 'default' })
    await backend2.restore('box-1', 'snap-3')
    expect(cmd(calls, 'delete')?.command).toEqual(['utmctl', 'delete', `${UTM_BOX_PREFIX}box-1`])
    expect(calls.at(-1)?.command).toEqual([
      'utmctl', 'clone', `${UTM_BOX_PREFIX}box-1${UTM_SNAP_SUFFIX}snap-3`, '--name', `${UTM_BOX_PREFIX}box-1`,
    ])
  })

  it('pause/resume：stop --request（优雅关机）/ start；sleeping 态投影到 list', async () => {
    const roster = `UUID  Status  Name\n5D419106-2824-4FED-BFE1-24A7F7E253D8 started  ${UTM_BOX_PREFIX}box-1\n`
    const { run, calls } = scripted((spec) => {
      if (spec.command.includes('list')) return { ...OK, stdout: roster }
      if (spec.command.includes('status')) return { ...OK, stdout: 'started\n' }
      return OK
    })
    const backend = make(run)
    await backend.create({ image: 'default' })
    await backend.pause('box-1')
    expect(cmd(calls, 'stop')?.command).toEqual(['utmctl', 'stop', `${UTM_BOX_PREFIX}box-1`, '--request'])
    expect((await backend.list()).find((b) => b.boxId === 'box-1')?.state).toBe('sleeping')
    await backend.resume('box-1')
    expect(cmd(calls, 'start')?.command).toEqual(['utmctl', 'start', `${UTM_BOX_PREFIX}box-1`])
    expect((await backend.list()).find((b) => b.boxId === 'box-1')?.state).toBe('active')
  })

  it('stop 幂等：status 已 stopped 跳过 stop（AppleScript 面对停机会报事件错误——先查后动）', async () => {
    const { run, calls } = scripted((spec) => {
      if (spec.command.includes('list')) return { ...OK, stdout: '' }
      if (spec.command.includes('status')) return { ...OK, stdout: 'stopped\n' }
      return OK
    })
    const backend = make(run)
    await backend.create({ image: 'default' })
    await expect(backend.pause('box-1')).resolves.toBeUndefined()
    expect(calls.some((c) => c.command.includes('stop'))).toBe(false)
  })

  it('stats：utmctl 无资源统计命令——全字段缺席的空报告（UI 按在场字段渲染不造假）', async () => {
    const { run } = scripted((spec) => {
      if (spec.command.includes('list')) return { ...OK, stdout: '' }
      return OK
    })
    const backend = make(run)
    await backend.create({ image: 'default' })
    expect(await backend.stats('box-1')).toEqual({})
  })

  it('teardown：stop → delete；list 前缀过滤（模板与自建 VM 不碰）', async () => {
    const roster = `UUID  Status  Name\n5D419106-2824-4FED-BFE1-24A7F7E253D8 started  openbot-template\n5D419106-2824-4FED-BFE1-24A7F7E253D9 started  ${UTM_BOX_PREFIX}box-2\n`
    const { run, calls } = scripted((spec) => {
      if (spec.command.includes('list')) return { ...OK, stdout: roster }
      if (spec.command.includes('status')) return { ...OK, stdout: 'started\n' }
      return OK
    })
    const backend = make(run)
    await backend.create({ image: 'default' }) // box-1
    expect((await backend.list()).map((b) => b.boxId)).toEqual(['box-2']) // 模板不进 Box 表；未知 spec 如实
    expect((await backend.list()).find((b) => b.boxId === 'box-2')?.spec.image).toBe('utm')
    await backend.teardown('box-1')
    expect(calls.at(-1)?.command).toEqual(['utmctl', 'delete', `${UTM_BOX_PREFIX}box-1`])
    const idxStop = calls.findIndex((c) => c.command.includes('stop'))
    expect(idxStop).toBeGreaterThan(-1)
  })

  it('Box 不存在抛 BOX_NOT_FOUND', async () => {
    await expect(make(scripted(() => OK).run).exec('box-9', { command: ['true'] })).rejects.toMatchObject({
      code: 'BOX_NOT_FOUND',
    })
  })
})

/** 真实套件（mac 真机 + GUI 登录会话 + UTM 预建模板；默认 skip） */
const real = process.env.OPENBOT_TEST_UTM === '1'
const template = process.env.OPENBOT_TEST_TEMPLATE
describe('UtmBoxBackend（真实套件）', { skip: !(real && template) }, () => {
  it('clone 模板 → exec → fsWrite/fsRead → snapshot → restore → delete 全链', async () => {
    const backend = new UtmBoxBackend({ template: template! })
    const box = await backend.create({ image: 'default' })
    const r = await backend.exec(box, { command: ['/bin/echo', 'utm-ok'] })
    expect(r.exitCode).toBe(0)
    expect(r.stdout.trim()).toBe('utm-ok')
    await backend.fsWrite(box, '/work/x.txt', 'hello')
    expect(await backend.fsRead(box, '/work/x.txt')).toBe('hello')
    const snap = await backend.snapshot(box)
    expect((await backend.listSnapshots()).some((s) => s.snapshotId === snap)).toBe(true)
    await backend.exec(box, { command: ['/bin/sh', '-c', 'echo changed > /work/x.txt'] })
    await backend.restore(box, snap)
    expect(await backend.fsRead(box, '/work/x.txt')).toBe('hello')
    await backend.teardown(box)
    // 快照克隆清理（restore/teardown 不自动删快照——真机套件显式收尾；克隆不在 Box 内存态，直清 utmctl）
    for (const s of await backend.listSnapshots()) {
      await runProcess({
        command: ['utmctl', 'delete', `${UTM_BOX_PREFIX}${box}${UTM_SNAP_SUFFIX}${s.snapshotId}`],
        timeoutMs: 10 * 60_000,
      })
    }
  })
})
