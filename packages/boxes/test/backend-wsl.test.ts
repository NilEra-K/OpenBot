/**
 * backend-wsl 测试：两层——
 * 1) 脚本化替身（默认跑，CI 零 WSL）：断言 wsl.exe 参数序列、错误语义、list 前缀过滤；
 * 2) 真实套件（OPENBOT_TEST_WSL=1 且 OPENBOT_TEST_ROOTFS 指向 tarball）：真 import/exec/fs/snapshot/teardown。
 * 与 llm 注入 fetch、transport 注入内存管道同一测试哲学（mock 对称，ARCHITECTURE.md §6）。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { WslBoxBackend, WSL_BOX_PREFIX } from '../src/backend-wsl/index.js'
import { runProcess } from '../src/procexec/index.js'
import type { ProcResult, ProcRunner, ProcSpec } from '../src/procexec/index.js'

const OK: ProcResult = { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false }

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
  it('create：发行版即 Box——import 参数序列确定（name/dir/rootfs/version 2），随后初始化工作目录', async () => {
    const { run, calls } = scripted(() => OK)
    const backend = new WslBoxBackend({ rootfs: 'C:/r.tar.gz', dir: 'D:/WSL', run })
    const box = await backend.create({ image: 'default' })
    expect(box).toBe('box-1')
    expect(calls[0]?.command).toEqual([
      'wsl', '--import', `${WSL_BOX_PREFIX}box-1`, `D:/WSL/${WSL_BOX_PREFIX}box-1`, 'C:/r.tar.gz', '--version', '2',
    ])
    expect(calls[1]?.command).toEqual(['wsl', '-d', `${WSL_BOX_PREFIX}box-1`, '--', 'mkdir', '-p', '/work'])
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
      'wsl', '-d', `${WSL_BOX_PREFIX}box-1`, '--cd', '/work', '--', 'env', 'K=V', '--', 'node', '-v',
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

  it('stats 如实全零（caps.resourceLimits=false 的对偶）；teardown 注销并除名', async () => {
    const { run, calls } = scripted(() => OK)
    const backend = new WslBoxBackend({ rootfs: 'C:/r.tar.gz', dir: 'D:/WSL', run })
    await backend.create({ image: 'default' })
    expect(await backend.stats('box-1')).toEqual({ cpuPercent: 0, memoryMb: 0, diskMb: 0 })
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
})
