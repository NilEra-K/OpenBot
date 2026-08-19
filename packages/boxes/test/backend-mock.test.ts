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
    expect(await backend.stats(b1)).toEqual({ cpuPercent: 0, memoryMb: 0, diskMb: 0 })
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
