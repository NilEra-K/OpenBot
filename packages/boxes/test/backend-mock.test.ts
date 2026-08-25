import { describe, expect, it } from 'vitest'
import { BoxRegistry, MockBoxBackend } from '../src/index.js'
import type { ExecResult } from '../src/index.js'

describe('MockBoxBackend', () => {
  it('create/exec：默认 exec 结果可预测，调用序列留痕（含注入时钟）', async () => {
    let t = 0
    const backend = new MockBoxBackend({ now: () => t })
    const box = await backend.create({ image: 'default' })
    expect(box).toBe('box-1')
    t = 5
    const result = await backend.exec(box, { command: ['node', '-v'] })
    expect(result).toEqual({ exitCode: 0, stdout: 'mock: node -v', stderr: '' })
    expect(backend.calls).toEqual([{ boxId: 'box-1', spec: { command: ['node', '-v'] }, at: 5 }])
  })

  it('自定义 exec 行为：模拟失败/输出可编排', async () => {
    const fail: ExecResult = { exitCode: 1, stdout: '', stderr: 'boom' }
    const backend = new MockBoxBackend({ exec: (_box, spec) => (spec.command[0] === 'bad' ? fail : { exitCode: 0, stdout: 'ok', stderr: '' }) })
    const box = await backend.create({ image: 'default' })
    expect((await backend.exec(box, { command: ['bad'] })).exitCode).toBe(1)
    expect((await backend.exec(box, { command: ['good'] })).stdout).toBe('ok')
  })

  it('exec 中止语义对称：signal abort 不等注入实现、立即抛 BOX_EXEC_ABORTED', async () => {
    // 永不 resolve 的注入实现——真实后端对应「子进程长跑」，中止必须立即生效
    const backend = new MockBoxBackend({
      exec: () => new Promise<ExecResult>(() => {}),
    })
    const box = await backend.create({ image: 'default' })
    const controller = new AbortController()
    const pending = backend.exec(box, { command: ['sleep', '999'], signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'BOX_EXEC_ABORTED' })
  })

  it('exec 已 aborted 的 signal：请求即抛，不进注入实现', async () => {
    let implRan = false
    const backend = new MockBoxBackend({
      exec: () => {
        implRan = true
        return { exitCode: 0, stdout: 'late', stderr: '' }
      },
    })
    const box = await backend.create({ image: 'default' })
    const controller = new AbortController()
    controller.abort()
    await expect(
      backend.exec(box, { command: ['ls'], signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'BOX_EXEC_ABORTED' })
    expect(implRan).toBe(false)
  })

  it('fs 读写按 Box 隔离；未写返回 null', async () => {
    const backend = new MockBoxBackend()
    const b1 = await backend.create({ image: 'default' })
    const b2 = await backend.create({ image: 'default' })
    await backend.fsWrite(b1, '/work/a.txt', '内容')
    expect(await backend.fsRead(b1, '/work/a.txt')).toBe('内容')
    expect(await backend.fsRead(b2, '/work/a.txt')).toBeNull()
    expect(backend.filesOf(b2)).toEqual({})
  })

  it('snapshot 返回确定性 id；stats/list 如实上报', async () => {
    let t = 0
    const backend = new MockBoxBackend({ now: () => t })
    t = 1
    const b1 = await backend.create({ image: 'default' })
    t = 2
    const b2 = await backend.create({ image: 'default', cpus: 2 })
    expect(await backend.snapshot(b1)).toBe('snap-1')
    expect(await backend.snapshot(b2)).toBe('snap-2')
    expect(await backend.stats(b1)).toEqual({ cpuPercent: 12, memoryMb: 256, diskMb: 1200 })
    expect(await backend.list()).toEqual([
      { boxId: 'box-1', spec: { image: 'default' }, state: 'active', createdAt: 1 },
      { boxId: 'box-2', spec: { image: 'default', cpus: 2 }, state: 'active', createdAt: 2 },
    ])
  })

  it('teardown 后操作一律 BOX_NOT_FOUND', async () => {
    const backend = new MockBoxBackend()
    const box = await backend.create({ image: 'default' })
    await backend.teardown(box)
    await expect(backend.exec(box, { command: ['ls'] })).rejects.toMatchObject({ code: 'BOX_NOT_FOUND' })
    await expect(backend.fsRead(box, '/x')).rejects.toMatchObject({ code: 'BOX_NOT_FOUND' })
    await expect(backend.teardown(box)).rejects.toMatchObject({ code: 'BOX_NOT_FOUND' })
  })

  it('caps 返回副本：外部改动不污染后端声明', () => {
    const backend = new MockBoxBackend()
    const caps = backend.caps()
    caps.snapshot = false
    expect(backend.caps().snapshot).toBe(true)
    expect(backend.caps().isolation).toBe('low')
  })

  it('onChunk 流式对称：结果按行拆块回调，聚合不变（真实后端逐块到达的语义镜像）', async () => {
    const backend = new MockBoxBackend({
      exec: () => ({ exitCode: 0, stdout: 'line1\nline2\n', stderr: 'warn\n' }),
    })
    const box = await backend.create({ image: 'default' })
    const chunks: Array<{ stream: 'stdout' | 'stderr'; text: string }> = []
    const result = await backend.exec(box, {
      command: ['sh', '-c', 'whatever'],
      onChunk: (c) => chunks.push(c),
    })
    expect(chunks).toEqual([
      { stream: 'stdout', text: 'line1\n' },
      { stream: 'stdout', text: 'line2\n' },
      { stream: 'stderr', text: 'warn\n' },
    ])
    expect(result).toEqual({ exitCode: 0, stdout: 'line1\nline2\n', stderr: 'warn\n' })
  })

  it('openShell 回显假终端：提示符/键入回显/假输出/exit 退出（E2E 全链路的地基）', async () => {
    const backend = new MockBoxBackend()
    const box = await backend.create({ image: 'default' })
    expect(backend.caps().interactive).toBe(true)
    const shell = await backend.openShell(box)
    const out: string[] = []
    shell.onData((t) => out.push(t))
    const exits: Array<number | null> = []
    shell.onExit((code) => exits.push(code))
    const flush = async (): Promise<void> => {
      for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0))
    }
    await flush()
    // 开场提示（回显式假终端的诚实身份声明）
    expect(out.join('')).toContain('mock shell')
    shell.write('ls /work\r')
    await flush()
    const text = out.join('')
    expect(text).toContain('ls /work') // 键入回显（真 PTY 由远端 bash 做，mock 自己做）
    expect(text).toContain('mock: ls /work') // 「执行」假输出
    expect(text).toContain('$ ') // 新提示符
    // exit 命令：正常退出
    shell.write('exit\r')
    await flush()
    expect(exits).toEqual([0])
    // close 幂等；退出后 write 静默丢弃
    shell.close()
    shell.write('anything\r')
    await flush()
    expect(exits).toEqual([0])
  })

  it('openShell 退格擦除（\\u007f → \\b 空格 \\b）与 BOX_NOT_FOUND', async () => {
    const backend = new MockBoxBackend()
    const box = await backend.create({ image: 'default' })
    const shell = await backend.openShell(box)
    const out: string[] = []
    shell.onData((t) => out.push(t))
    const flush = async (): Promise<void> => {
      for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0))
    }
    await flush()
    out.length = 0
    shell.write('ab')
    shell.write('\u007f')
    shell.write('c\r')
    await flush()
    const text = out.join('')
    expect(text).toContain('ac\r\n') // 退格吃掉 b 后回车
    expect(text).not.toContain('abc')
    expect(text).toContain('\b \b') // 擦除序列
    await expect(backend.openShell('box-9')).rejects.toMatchObject({ code: 'BOX_NOT_FOUND' })
  })
})

describe('BoxRegistry', () => {
  it('注册/获取/未注册报错', () => {
    const registry = new BoxRegistry().register(new MockBoxBackend())
    expect(registry.get('mock').id).toBe('mock')
    expect(() => registry.get('wsl')).toThrowError(/未注册的后端：wsl/)
    expect(() => registry.get('wsl')).toThrowError(expect.objectContaining({ code: 'BOX_BACKEND_NOT_FOUND' }))
    expect(registry.list().map((b) => b.id)).toEqual(['mock'])
  })
})
