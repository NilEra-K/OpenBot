/**
 * 子进程执行底座测试：被测进程用 node 自身（process.execPath）——
 * 零环境依赖、跨平台、确定性（与注入式测试哲学并列的「自指」测试）。
 */
import { describe, expect, it } from 'vitest'
import { isSpawnFailure, runProcess } from '../src/procexec/index.js'

const node = process.execPath

describe('runProcess', () => {
  it('捕获 stdout/stderr 与退出码', async () => {
    const r = await runProcess({
      command: [node, '-e', "console.log('out1'); console.error('err1'); process.exit(3)"],
    })
    expect(r.exitCode).toBe(3)
    expect(r.signal).toBeNull()
    expect(r.stdout).toBe('out1\n')
    expect(r.stderr).toBe('err1\n')
    expect(r.timedOut).toBe(false)
  })

  it('onChunk 流式分块回调（聚合仍完整）', async () => {
    const chunks: Array<{ stream: 'stdout' | 'stderr'; text: string }> = []
    const r = await runProcess({
      command: [node, '-e', "process.stdout.write('a'); process.stdout.write('b'); console.log('c')"],
      onChunk: (c) => chunks.push(c),
    })
    expect(r.stdout).toBe('abc\n')
    const stdoutText = chunks.filter((c) => c.stream === 'stdout').map((c) => c.text).join('')
    expect(stdoutText).toBe('abc\n')
  })

  it('超时 kill：timedOut 置位、exitCode null', async () => {
    const r = await runProcess({
      command: [node, '-e', 'setTimeout(() => {}, 10000)'],
      timeoutMs: 150,
    })
    expect(r.timedOut).toBe(true)
    expect(r.exitCode).toBeNull()
  }, 10_000)

  it('utf16le 解码：多字节跨块收敛', async () => {
    // wsl.exe 元信息输出是 UTF-16LE；模拟分块写「你a好」（每码元 2 字节，共 8 字节，
    // 块边界落在 'a' 的第二字节处——跨块多字节收敛点）
    const script =
      "const b = Buffer.from('你a好', 'utf16le'); " +
      'process.stdout.write(b.subarray(0, 3)); process.stdout.write(b.subarray(3));'
    const r = await runProcess({
      command: [node, '-e', script],
      encoding: 'utf16le',
    })
    expect(r.stdout).toBe('你a好')
  })

  it('spawn 失败抛 ProcSpawnError（isSpawnFailure 判定）', async () => {
    await expect(
      runProcess({ command: ['definitely-not-exists-xyz.openbot'] }),
    ).rejects.toSatisfy((err: unknown) => isSpawnFailure(err))
  })

  it('env 注入生效', async () => {
    const r = await runProcess({
      command: [node, '-e', "console.log(process.env.OPENBOT_PROC_TEST ?? 'unset')"],
      env: { OPENBOT_PROC_TEST: 'injected' },
    })
    expect(r.stdout.trim()).toBe('injected')
  })
})
