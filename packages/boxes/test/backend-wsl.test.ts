/**
 * backend-wsl 测试：两层——
 * 1) 脚本化替身（默认跑，CI 零 WSL）：断言 wsl.exe 参数序列、错误语义、list 前缀过滤；
 * 2) 真实套件（OPENBOT_TEST_WSL=1 且 OPENBOT_TEST_ROOTFS 指向 tarball）：真 import/exec/fs/snapshot/teardown。
 * 与 llm 注入 fetch、transport 注入内存管道同一测试哲学（mock 对称，ARCHITECTURE.md §6）。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { WslBoxBackend, WSL_BOX_PREFIX } from '../src/backend-wsl/index.js'
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

describe('WslBoxBackend（脚本化替身）', () => {
  it('create：发行版即 Box——先查存在（--list UTF-16LE），不存在则 import + 初始化工作目录', async () => {
    const { run, calls } = scripted((spec) => {
      if (spec.command.includes('--list')) return { ...OK, stdout: 'Ubuntu\r\n' } // 无同名 Box
      return OK
    })
    const backend = new WslBoxBackend({ rootfs: 'C:/r.tar.gz', dir: 'D:/WSL', run })
    const box = await backend.create({ image: 'default' })
    expect(box).toBe('box-1')
    expect(calls[0]?.command).toEqual(['wsl', '--list', '--quiet'])
    expect(calls[0]?.encoding).toBe('utf16le') // 元命令地雷（platforms.md）
    expect(calls[1]?.command).toEqual([
      'wsl', '--import', `${WSL_BOX_PREFIX}box-1`, `D:/WSL/${WSL_BOX_PREFIX}box-1`, 'C:/r.tar.gz', '--version', '2',
    ])
    expect(calls[2]?.command).toEqual(['wsl', '-d', `${WSL_BOX_PREFIX}box-1`, '--', 'mkdir', '-p', '/work'])
  })

  it('create 单盒目录覆盖（v0.2.0 位置参数化）：spec.dir 优先于构造期全局 dir', async () => {
    const { run, calls } = scripted((spec) => {
      if (spec.command.includes('--list')) return { ...OK, stdout: 'Ubuntu\r\n' } // 无同名 Box（覆盖路径）
      return OK
    })
    const backend = new WslBoxBackend({ rootfs: 'C:/r.tar.gz', dir: 'D:/WSL', run })
    await backend.create({ image: 'default', dir: 'D:/WSL/ovr' })
    expect(calls[1]?.command).toEqual([
      'wsl', '--import', `${WSL_BOX_PREFIX}box-1`, `D:/WSL/ovr/${WSL_BOX_PREFIX}box-1`, 'C:/r.tar.gz', '--version', '2',
    ])
  })

  it('create 幂等：发行版已存在则跳过 import（桌面重启复用持久 Box）', async () => {
    const { run, calls } = scripted((spec) => {
      if (spec.command.includes('--list')) return { ...OK, stdout: `Ubuntu\r\n${WSL_BOX_PREFIX}box-1\r\n` }
      return OK
    })
    const backend = new WslBoxBackend({ rootfs: 'C:/r.tar.gz', dir: 'D:/WSL', run })
    const box = await backend.create({ image: 'default' })
    expect(box).toBe('box-1')
    expect(calls.some((c) => c.command.includes('--import'))).toBe(false)
    // 工作目录初始化照跑（mkdir -p 幂等，顺带把 Stopped 的发行版拉起）
    expect(last(calls)).toEqual(['wsl', '-d', `${WSL_BOX_PREFIX}box-1`, '--', 'mkdir', '-p', '/work'])
  })

  it('import 失败抛 BOX_CREATE_FAILED（stderr 进 message）', async () => {
    const { run } = scripted(() => ({ ...OK, exitCode: 1, stderr: 'wsl 不可用' }))
    const backend = new WslBoxBackend({ rootfs: 'C:/r.tar.gz', dir: 'D:/WSL', run })
    await expect(backend.create({ image: 'default' })).rejects.toMatchObject({
      code: 'BOX_CREATE_FAILED',
      message: expect.stringContaining('wsl 不可用'),
    })
  })

  it('exec：-d/--cd 定位、env 经 coreutils env 注入、onChunk 透传、结果聚合', async () => {
    const chunks: Array<{ stream: 'stdout' | 'stderr'; text: string }> = []
    const { run, calls } = scripted((spec) => {
      spec.onChunk?.({ stream: 'stdout', text: 'hi\n' })
      return { ...OK, stdout: 'hi\n' }
    })
    const backend = new WslBoxBackend({ rootfs: 'C:/r.tar.gz', dir: 'D:/WSL', run })
    await backend.create({ image: 'default' })
    const r = await backend.exec('box-1', {
      command: ['node', '-v'],
      env: { K: 'V' },
      onChunk: (c) => chunks.push(c),
    })
    expect(last(calls)).toEqual([
      'wsl', '-d', `${WSL_BOX_PREFIX}box-1`, '--cd', '/work', '--', 'env', 'K=V', 'node', '-v',
    ])
    expect(chunks).toEqual([{ stream: 'stdout', text: 'hi\n' }])
    expect(r).toEqual({ exitCode: 0, stdout: 'hi\n', stderr: '' })
  })

  it('exec 超时抛 BOX_EXEC_TIMEOUT（zombie 契约：执行必须有界）', async () => {
    const { run } = scripted((spec) => {
      // 只让 exec 调用超时（--cd 是 exec 专属）；create 的 import/mkdir 正常
      if (spec.command.includes('--cd')) return { ...OK, exitCode: null, timedOut: true }
      return OK
    })
    const backend = new WslBoxBackend({ rootfs: 'C:/r.tar.gz', dir: 'D:/WSL', run })
    await backend.create({ image: 'default' })
    await expect(backend.exec('box-1', { command: ['sleep', '999'], timeoutMs: 100 })).rejects.toMatchObject({
      code: 'BOX_EXEC_TIMEOUT',
    })
  })

  it('exec signal 透传给子进程执行器（run 取消/抢占的传导链）；aborted 抛 BOX_EXEC_ABORTED', async () => {
    const controller = new AbortController()
    const { run, calls } = scripted((spec) => {
      // 只让 exec 调用中止（--cd 是 exec 专属）
      if (spec.command.includes('--cd')) return { ...OK, exitCode: null, aborted: true }
      return OK
    })
    const backend = new WslBoxBackend({ rootfs: 'C:/r.tar.gz', dir: 'D:/WSL', run })
    await backend.create({ image: 'default' })
    await expect(
      backend.exec('box-1', { command: ['sleep', '999'], signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'BOX_EXEC_ABORTED' })
    const execCall = calls.find((c) => c.command.includes('--cd'))
    expect(execCall?.signal).toBe(controller.signal) // 传导链：ExecSpec.signal → ProcSpec.signal
  })

  it('fsWrite 走 base64 中转；fsRead cat 失败返回 null（不抛）', async () => {
    const { run, calls } = scripted((spec) => {
      // cat 命令模拟文件不存在
      if (spec.command.includes('cat')) return { ...OK, exitCode: 1, stderr: 'No such file' }
      return OK
    })
    const backend = new WslBoxBackend({ rootfs: 'C:/r.tar.gz', dir: 'D:/WSL', run })
    await backend.create({ image: 'default' })
    expect(await backend.fsRead('box-1', '/work/x.txt')).toBeNull()
    await backend.fsWrite('box-1', '/work/x.txt', '你好 world')
    const cmd = last(calls).join(' ')
    expect(cmd).toContain(`printf %s ${Buffer.from('你好 world', 'utf8').toString('base64')}`)
    expect(cmd).toContain("base64 -d > '/work/x.txt'")
  })

  it('snapshot：先 terminate 再 export（文件系统一致性）', async () => {
    const { run, calls } = scripted(() => OK)
    const backend = new WslBoxBackend({ rootfs: 'C:/r.tar.gz', dir: 'D:/WSL', run })
    await backend.create({ image: 'default' })
    expect(await backend.snapshot('box-1')).toBe('snap-1')
    // 倒数第二次 terminate（先停后导出）、最后 export
    expect(calls.at(-2)?.command).toEqual(['wsl', '--terminate', `${WSL_BOX_PREFIX}box-1`])
    expect(last(calls)).toEqual(['wsl', '--export', `${WSL_BOX_PREFIX}box-1`, 'D:/WSL/snapshots/snap-1.tar.gz'])
  })

  it('休眠/唤醒（P4 Step 8）：--terminate 单发行版 / exec true 自启；list 反映 sleeping；exec 自然唤醒', async () => {
    const { run, calls } = scripted((spec) => {
      if (spec.command.includes('--list')) return { ...OK, stdout: `${WSL_BOX_PREFIX}box-1\r\n` }
      return OK
    })
    const backend = new WslBoxBackend({ rootfs: 'C:/r.tar.gz', dir: 'D:/WSL', run })
    await backend.create({ image: 'default' })
    expect(backend.caps().suspendable).toBe(true)

    await backend.pause('box-1')
    expect(last(calls)).toEqual(['wsl', '--terminate', `${WSL_BOX_PREFIX}box-1`])
    expect((await backend.list()).find((b) => b.boxId === 'box-1')?.state).toBe('sleeping')

    await backend.resume('box-1')
    expect(last(calls)).toEqual(['wsl', '-d', `${WSL_BOX_PREFIX}box-1`, '--', 'true'])
    expect((await backend.list()).find((b) => b.boxId === 'box-1')?.state).toBe('active')

    // 休眠中的 exec 自然唤醒（发行版自启）——标志随真实状态清除
    await backend.pause('box-1')
    await backend.exec('box-1', { command: ['ls'] })
    expect((await backend.list()).find((b) => b.boxId === 'box-1')?.state).toBe('active')
  })

  it('休眠/唤醒失败：exit 非 0 抛稳定 code（stderr 进 message）', async () => {
    // create 相关命令成功，休眠（--terminate）/唤醒（exec true）失败——按命令分流
    const { run } = scripted((spec) => {
      if (spec.command.includes('--terminate') || spec.command.at(-1) === 'true') {
        return { ...OK, exitCode: 1, stderr: '拒绝访问' }
      }
      return OK
    })
    const backend = new WslBoxBackend({ rootfs: 'C:/r.tar.gz', dir: 'D:/WSL', run })
    await backend.create({ image: 'default' })
    await expect(backend.pause('box-1')).rejects.toMatchObject({ code: 'BOX_PAUSE_FAILED' })
    await expect(backend.resume('box-1')).rejects.toMatchObject({ code: 'BOX_RESUME_FAILED' })
  })

  it('快照链与回滚（P4 Step 9）：扫 snapshotDir 的 snap-N.tar.gz（N 降序+大小）；restore=unregister+import', async () => {
    const files = new Map<string, number>([
      ['snap-1.tar.gz', 1024 * 1024 * 100],
      ['snap-2.tar.gz', 1024 * 1024 * 300],
      ['unrelated.txt', 5],
    ])
    const { run, calls } = scripted(() => OK)
    const backend = new WslBoxBackend({
      rootfs: 'C:/r.tar.gz',
      dir: 'D:/WSL',
      run,
      listDir: async () => [...files.keys()],
      statFile: async (p) => ({ size: files.get(p.split('/').pop()!) ?? 0 }),
    })
    await backend.create({ image: 'default' })

    const chain = await backend.listSnapshots()
    expect(chain).toEqual([
      { snapshotId: 'snap-2', sizeBytes: 1024 * 1024 * 300 },
      { snapshotId: 'snap-1', sizeBytes: 1024 * 1024 * 100 },
    ])

    await backend.restore('box-1', 'snap-2')
    expect(calls.at(-2)?.command).toEqual(['wsl', '--unregister', `${WSL_BOX_PREFIX}box-1`])
    expect(last(calls)).toEqual([
      'wsl', '--import', `${WSL_BOX_PREFIX}box-1`, `D:/WSL/${WSL_BOX_PREFIX}box-1`, 'D:/WSL/snapshots/snap-2.tar.gz', '--version', '2',
    ])
  })

  it('stats 只有磁盘真值（vhdx 体积，注入替身）；CPU/内存缺席=不可测；vhdx 缺失如实空报告；teardown 注销并除名', async () => {
    const { run, calls } = scripted(() => OK)
    const vhdxSize = 2048 * 1024 * 1024
    const statFile = vi.fn(async () => ({ size: vhdxSize }))
    const backend = new WslBoxBackend({ rootfs: 'C:/r.tar.gz', dir: 'D:/WSL', run, statFile })
    await backend.create({ image: 'default' })
    expect(await backend.stats('box-1')).toEqual({ diskMb: 2048 })
    expect(statFile).toHaveBeenCalledWith('D:/WSL/openbot-box-box-1/ext4.vhdx')
    statFile.mockRejectedValueOnce(new Error('ENOENT'))
    expect(await backend.stats('box-1')).toEqual({})
    await backend.teardown('box-1')
    expect(last(calls)).toEqual(['wsl', '--unregister', `${WSL_BOX_PREFIX}box-1`])
    await expect(backend.exec('box-1', { command: ['ls'] })).rejects.toMatchObject({ code: 'BOX_NOT_FOUND' })
  })

  it('list：只认前缀名（手工发行版不碰），跨重启以 wsl --list 为真相', async () => {
    const { run, calls } = scripted((spec) => {
      if (spec.command.includes('--list')) {
        return { ...OK, stdout: 'Ubuntu\r\nopenbot-box-box-1\r\nopenbot-box-box-2\r\n' }
      }
      return OK
    })
    const backend = new WslBoxBackend({ rootfs: 'C:/r.tar.gz', dir: 'D:/WSL', run })
    const list = await backend.list()
    expect(list.map((b) => b.boxId)).toEqual(['box-1', 'box-2'])
    // --list 元信息必须声明 UTF-16LE 解码（platforms.md 地雷）
    const listCall = calls.find((c) => c.command.includes('--list'))
    expect(listCall?.encoding).toBe('utf16le')
  })

  it('openShell：script 真 PTY 包裹——初始尺寸经 -c 注入、尺寸钳制、write/onExit 转发', async () => {
    const spawned: string[][] = []
    const writes: string[] = []
    let exitForward: (code: number | null) => void = () => {}
    const spawnShell: ShellSpawner = (command) => {
      spawned.push(command)
      return {
        write: (t) => writes.push(t),
        onOutput: () => {},
        onExit: (cb) => {
          exitForward = cb
        },
        kill: () => exitForward(1),
      }
    }
    const { run } = scripted(() => OK)
    const backend = new WslBoxBackend({ rootfs: 'C:/r.tar.gz', dir: 'D:/WSL', run, spawnShell })
    await backend.create({ image: 'default' })
    expect(backend.caps().interactive).toBe(true)
    const shell = await backend.openShell('box-1', { cols: 120, rows: 40 })
    expect(spawned).toEqual([
      [
        'wsl', '-d', `${WSL_BOX_PREFIX}box-1`, '--cd', '/work', '--',
        'script', '-qec', 'stty rows 40 cols 120; exec bash', '/dev/null',
      ],
    ])
    shell.write('ls\r')
    expect(writes).toEqual(['ls\r'])
    const exits: Array<number | null> = []
    shell.onExit((code) => exits.push(code))
    shell.close()
    expect(exits).toEqual([1]) // kill 转发到会话 onExit
    // 尺寸钳制：0 → 10（下限）、999 → 200（上限）——防 0×0（裸 script 实测是 0 0，vim/top 无法工作）
    await backend.openShell('box-1', { cols: 0, rows: 999 })
    expect(spawned.at(-1)).toEqual([
      'wsl', '-d', `${WSL_BOX_PREFIX}box-1`, '--cd', '/work', '--',
      'script', '-qec', 'stty rows 200 cols 10; exec bash', '/dev/null',
    ])
    // Box 不存在的领域错误
    await expect(backend.openShell('box-9')).rejects.toMatchObject({ code: 'BOX_NOT_FOUND' })
  })
})

// ---- 真实套件：OPENBOT_TEST_WSL=1 时才跑（默认 CI 零沙箱依赖） ----
const REAL = process.env.OPENBOT_TEST_WSL === '1'
const REAL_ROOTFS = process.env.OPENBOT_TEST_ROOTFS ?? ''
const realDir = REAL ? await mkdtemp(join(tmpdir(), 'openbot-wsl-test-')) : ''

describe('WslBoxBackend（真实 WSL2）', { skip: !REAL || !REAL_ROOTFS }, () => {
  afterAll(async () => {
    if (!REAL) return
    // 兜底清理：断言失败路径不残留发行版（真实套件先行验证——孤儿发行版会让下轮 import 冲突，实证）
    const r = await runProcess({ command: ['wsl', '--list', '--quiet'], encoding: 'utf16le', timeoutMs: 30_000 })
    for (const name of r.stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith(WSL_BOX_PREFIX))) {
      await runProcess({ command: ['wsl', '--unregister', name], timeoutMs: 60_000 }).catch(() => undefined)
    }
    await rm(realDir, { recursive: true, force: true }).catch(() => {})
  })

  it('create → exec → fs → snapshot → teardown 全链路（发行版即 Box）', async () => {
    const backend = new WslBoxBackend({ rootfs: REAL_ROOTFS, dir: realDir, now: () => 0 })
    const box = await backend.create({ image: 'default' })
    expect(box).toBe('box-1')

    // exec：UTF-8 输出字节直传 + 退出码
    const r = await backend.exec(box, { command: ['sh', '-c', 'echo 你好; exit 0'] })
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toBe('你好\n')

    // fs 双向
    await backend.fsWrite(box, '/work/note.txt', 'OpenBot 真实写入')
    expect(await backend.fsRead(box, '/work/note.txt')).toBe('OpenBot 真实写入')

    // 流式
    const chunks: string[] = []
    await backend.exec(box, {
      command: ['sh', '-c', 'echo one; echo two'],
      onChunk: (c) => { if (c.stream === 'stdout') chunks.push(c.text) },
    })
    expect(chunks.join('')).toBe('one\ntwo\n')

    // 快照（terminate + export）
    const snap = await backend.snapshot(box)
    expect(snap).toBe('snap-1')

    // list 反映存活；teardown 注销
    expect((await backend.list()).map((b) => b.boxId)).toContain('box-1')
    await backend.teardown(box)
    expect((await backend.list()).map((b) => b.boxId)).not.toContain('box-1')
  }, 300_000)

  it('create 幂等（桌面重启语义）：新实例对同名发行版跳过 import 直接复用，数据保留', async () => {
    const first = new WslBoxBackend({ rootfs: REAL_ROOTFS, dir: realDir, now: () => 0 })
    const box1 = await first.create({ image: 'default' })
    expect(box1).toBe('box-1')
    await first.fsWrite(box1, '/work/keep.txt', '跨重启保留的工作区文件')

    // 重启语义：内存 Box 表丢失（新实例、id 从 box-1 重数），同名发行版仍在——
    // 复用而非 import 冲突（桌面第二次启动的硬需求），Box 内数据原样
    const second = new WslBoxBackend({ rootfs: REAL_ROOTFS, dir: realDir, now: () => 0 })
    const box2 = await second.create({ image: 'default' })
    expect(box2).toBe('box-1')
    expect(await second.fsRead(box2, '/work/keep.txt')).toBe('跨重启保留的工作区文件')
    await second.teardown(box2)
  }, 300_000)

  it('openShell：真 PTY 交互——提示符/键入回显/尺寸注入/exit 退出（script 经 wsl.exe 管道）', async () => {
    const backend = new WslBoxBackend({ rootfs: REAL_ROOTFS, dir: realDir, now: () => 0 })
    const box = await backend.create({ image: 'default' })
    const shell = await backend.openShell(box, { cols: 100, rows: 30 })
    let out = ''
    shell.onData((t) => { out += t })
    const exits: Array<number | null> = []
    shell.onExit((code) => exits.push(code))
    // 等提示符出现（bash 认为自己接着真终端的证据）
    await waitUntil(() => out.includes('#') || out.includes('$'), 20_000)

    // 键入即回显 + 命令真实执行
    shell.write('echo PTY_E2E_OK\r')
    await waitUntil(() => out.includes('PTY_E2E_OK'), 20_000) // 回显与输出都命中
    // 初始尺寸经 script -c 注入生效
    shell.write('stty size\r')
    await waitUntil(() => out.includes('30 100'), 20_000)

    // exit：会话正常退出（exit code 0）
    shell.write('exit\r')
    await waitUntil(() => exits.length > 0, 20_000)
    expect(exits[0]).toBe(0)
  }, 300_000)
})

/** 轮询等待条件成立（真机异步；超时抛错带现场） */
async function waitUntil(cond: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`等待超时（${timeoutMs}ms）`)
    await new Promise((r) => setTimeout(r, 100))
  }
}
