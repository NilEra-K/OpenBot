import { describe, expect, it } from 'vitest'
import { InMemoryFs, TranscriptStore } from '../src/index.js'

function makeStore() {
  let t = 0
  const fs = new InMemoryFs()
  const store = new TranscriptStore({ fs, root: 'data', now: () => t })
  return {
    fs,
    store,
    advance(ms: number): void {
      t += ms
    },
  }
}

describe('TranscriptStore', () => {
  it('append 落 JSONL：seq 单调、at 取注入时钟、一记录一行', async () => {
    const { store, fs, advance } = makeStore()
    advance(10)
    const r1 = await store.append('a1', 'user', { text: '你好' })
    advance(5)
    const r2 = await store.append('a1', 'agent', { text: '在' })
    expect(r1.seq).toBe(1)
    expect(r1.at).toBe(10)
    expect(r2.seq).toBe(2)
    expect(r2.at).toBe(15)
    const raw = fs.snapshot()['data/agents/a1/transcript.jsonl']
    expect(raw?.split('\n').filter((l) => l !== '').length).toBe(2)
    expect(raw?.split('\n')[0]).toBe(JSON.stringify(r1))
  })

  it('append-only：追加不改写既有行（前缀保持逐字节一致）', async () => {
    const { store, fs } = makeStore()
    await store.append('a1', 'user', { n: 1 })
    const before = fs.snapshot()['data/agents/a1/transcript.jsonl']
    await store.append('a1', 'user', { n: 2 })
    await store.append('a1', 'user', { n: 3 })
    const after = fs.snapshot()['data/agents/a1/transcript.jsonl']
    expect(after!.startsWith(before!)).toBe(true)
  })

  it('readAll 重放；多 agent 目录互不串扰', async () => {
    const { store } = makeStore()
    await store.append('a1', 'user', { n: 1 })
    await store.append('a2', 'user', { n: 2 })
    await store.append('a1', 'agent', { n: 3 })
    expect((await store.readAll('a1')).map((r) => r.seq)).toEqual([1, 2])
    expect((await store.readAll('a2')).map((r) => r.seq)).toEqual([1])
    expect(await store.readAll('a3')).toEqual([])
  })

  it('readRecent 取尾部 n 条', async () => {
    const { store } = makeStore()
    for (let i = 1; i <= 5; i++) await store.append('a1', 'user', { n: i })
    expect((await store.readRecent('a1', 2)).map((r) => (r.payload as { n: number }).n)).toEqual([4, 5])
    expect((await store.readRecent('a1', 99)).length).toBe(5)
  })

  it('崩溃后重开：seq 续接不重置；残缺尾行被丢弃', async () => {
    const { fs } = makeStore()
    let t = 0
    const first = new TranscriptStore({ fs, root: 'data', now: () => t })
    t = 1
    await first.append('a1', 'user', { n: 1 })
    await first.append('a1', 'user', { n: 2 })
    // 模拟崩溃：写入半行
    await fs.append('data/agents/a1/transcript.jsonl', '{"seq":3,"at":3,"ki')
    t = 100
    const second = new TranscriptStore({ fs, root: 'data', now: () => t })
    const records = await second.readAll('a1')
    expect(records.length).toBe(2)
    const r3 = await second.append('a1', 'user', { n: 3 })
    expect(r3.seq).toBe(3)
    expect(r3.at).toBe(100)
  })
})
