import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { InMemoryFs, NodeFs } from '../src/index.js'

describe('InMemoryFs', () => {
  it('read/write/append/remove 与目录列举', async () => {
    const fs = new InMemoryFs()
    expect(await fs.read('a/b.txt')).toBeNull()
    await fs.write('a/b.txt', 'one')
    await fs.append('a/b.txt', 'two')
    expect(await fs.read('a/b.txt')).toBe('onetwo')
    await fs.write('a/c/d.txt', 'x')
    expect(await fs.list('a')).toEqual(['b.txt', 'c'])
    expect(await fs.list('a/c')).toEqual(['d.txt'])
    await fs.remove('a/b.txt')
    expect(await fs.read('a/b.txt')).toBeNull()
    expect(await fs.list('nope')).toEqual([])
  })
})

describe('NodeFs（临时目录往返）', () => {
  const dirs: string[] = []
  afterAll(async () => {
    await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })))
  })

  it('与 InMemoryFs 行为对称：read null、append 追加、remove 幂等、list 排序', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openbot-state-'))
    dirs.push(dir)
    const fs = new NodeFs()
    const file = `${dir}/agents/a1/transcript.jsonl`
    expect(await fs.read(file)).toBeNull()
    await fs.append(file, '{"seq":1}\n')
    await fs.append(file, '{"seq":2}\n')
    expect(await fs.read(file)).toBe('{"seq":1}\n{"seq":2}\n')
    expect(await fs.list(`${dir}/agents`)).toEqual(['a1'])
    await fs.remove(file)
    await fs.remove(file) // 不存在不报错
    expect(await fs.read(file)).toBeNull()
  })
})
