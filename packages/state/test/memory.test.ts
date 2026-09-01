/**
 * MemoryStore 测试（backlog ① Step 1）：读写往返/条目校验/损坏降级/注入 id·时钟。
 * 与 agent-store/settings 同一 InMemoryFs 哲学——零真实文件系统。
 */
import { describe, expect, it } from 'vitest'
import { InMemoryFs } from '../src/fs/index.js'
import { MemoryStore, MEMORY_TEXT_LIMIT, formatMemoryPrompt } from '../src/memory/index.js'

const make = () => {
  const fs = new InMemoryFs()
  let seq = 0
  const store = new MemoryStore({
    fs,
    root: 'data',
    nextId: () => `m-${++seq}`,
    now: () => 1_000 + seq,
  })
  return { fs, store }
}

describe('MemoryStore', () => {
  it('未初始化的 agent 返回空数组（记忆目录按需创建——不预建空文件）', async () => {
    const { store, fs } = make()
    expect(await store.list('agent-1')).toEqual([])
    expect(fs.snapshot()['data/agents/agent-1/memory.json']).toBeUndefined()
  })

  it('append 落盘并读回（旧→新序；kind 与 sourceMessageId 可选字段如实在场）', async () => {
    const { store, fs } = make()
    const a = await store.append('agent-1', '用户偏好深色主题', '偏好')
    const b = await store.append('agent-1', '部署脚本在 /work/deploy.sh', '事实', 'msg-9')
    expect(await store.list('agent-1')).toEqual([a, b])
    // 盘上 JSON 结构（version 1 + entries）
    const raw = JSON.parse(fs.snapshot()['data/agents/agent-1/memory.json'] as string)
    expect(raw).toEqual({ version: 1, entries: [a, b] })
    // 重启恢复：新 store 实例（同 fs）读同一文件
    const reborn = new MemoryStore({ fs: make().fs, root: 'nope' }) // 不同根验证隔离
    expect(await reborn.list('agent-1')).toEqual([])
  })

  it('重启恢复：同根新实例读回既有条目', async () => {
    const { fs, store } = make()
    await store.append('agent-1', '跨会话要记住的事实', '事实')
    const reborn = new MemoryStore({ fs, root: 'data' })
    expect(await reborn.list('agent-1')).toEqual([
      expect.objectContaining({ text: '跨会话要记住的事实', kind: '事实' }),
    ])
  })

  it('条目校验：空文本/超长拒绝（稳定码）；首尾空白裁剪', async () => {
    const { store } = make()
    await expect(store.append('agent-1', '   ')).rejects.toMatchObject({ code: 'STATE_MEMORY_INVALID' })
    await expect(store.append('agent-1', 'x'.repeat(MEMORY_TEXT_LIMIT + 1))).rejects.toMatchObject({
      code: 'STATE_MEMORY_INVALID',
    })
    const entry = await store.append('agent-1', '  有效内容  ')
    expect(entry.text).toBe('有效内容')
  })

  it('损坏文件降级空表（console 告警不抛——手改/断电不该带崩会话）', async () => {
    const { fs, store } = make()
    await fs.write('data/agents/agent-1/memory.json', '{broken json')
    expect(await store.list('agent-1')).toEqual([])
    // 降级后 append 正常工作（从空表续写）
    const entry = await store.append('agent-1', '降级后的第一条')
    expect(await store.list('agent-1')).toEqual([entry])
  })

  it('多 agent 目录天然隔离', async () => {
    const { store } = make()
    await store.append('agent-1', '甲的记忆')
    await store.append('agent-2', '乙的记忆')
    expect((await store.list('agent-1')).map((e) => e.text)).toEqual(['甲的记忆'])
    expect((await store.list('agent-2')).map((e) => e.text)).toEqual(['乙的记忆'])
  })

  it('listSync：ensureLoaded/append 后同步读缓存；未加载返回空（该轮不注入的降级）', async () => {
    const { store } = make()
    expect(store.listSync('agent-1')).toEqual([]) // 未加载
    await store.ensureLoaded('agent-1')
    expect(store.listSync('agent-1')).toEqual([])
    await store.append('agent-1', '写后即可见', '偏好')
    expect(store.listSync('agent-1')).toEqual([expect.objectContaining({ text: '写后即可见', kind: '偏好' })])
  })
})

describe('formatMemoryPrompt（注入节纯函数——裁定 A 字符预算）', () => {
  const E = (text: string, kind: '事实' | '偏好' | '技能' = '事实') => ({ kind, text })

  it('空表返回空串（不注入空节）；有条目拼「## 此前记忆」与逐行', () => {
    expect(formatMemoryPrompt([])).toBe('')
    const out = formatMemoryPrompt([E('甲'), E('乙', '偏好')])
    expect(out).toContain('## 此前记忆')
    expect(out).toContain('- [事实] 甲')
    expect(out).toContain('- [偏好] 乙')
  })

  it('超预算从最旧截断 + 尾标注入条数（新记忆权重高）', () => {
    const entries = Array.from({ length: 5 }, (_, i) => E(`条目${i}${'x'.repeat(80)}`))
    const out = formatMemoryPrompt(entries, 200)
    expect(out).toContain('条目4') // 最新的保留
    expect(out).not.toContain('条目0') // 最旧的截掉
    expect(out).toMatch(/更早的 \d+ 条未注入/)
  })
})
