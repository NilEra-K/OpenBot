import { describe, expect, it } from 'vitest'
import { AgentStore, InMemoryFs } from '../src/index.js'

function makeStore() {
  let t = 0
  const fs = new InMemoryFs()
  const store = new AgentStore({ fs, root: 'data', now: () => t })
  return {
    fs,
    store,
    advance(ms: number): void {
      t += ms
    },
  }
}

describe('AgentStore 名册', () => {
  it('注册默认 worker、落盘 profile.json；重名拒绝', async () => {
    const { store, fs } = makeStore()
    const p = await store.register('a1', '管家一号')
    expect(p.role).toBe('worker')
    expect(p.name).toBe('管家一号')
    const raw = fs.snapshot()['data/agents/a1/profile.json']
    expect(raw).toContain('"role": "worker"')
    await expect(store.register('a1')).rejects.toMatchObject({ code: 'STATE_AGENT_EXISTS' })
  })

  it('身份色（P4 Step 5）：register 带 color 落盘并读回；缺席时字段不出现（零迁移）', async () => {
    const { store, fs } = makeStore()
    const p = await store.register('a1', '欧米伽', '#199e70')
    expect(p.color).toBe('#199e70')
    expect(fs.snapshot()['data/agents/a1/profile.json']).toContain('"color": "#199e70"')
    const no = await store.register('a2')
    expect(no.color).toBeUndefined()
    expect(fs.snapshot()['data/agents/a2/profile.json']).not.toContain('"color"')
    // 既有档案不变：role 变更（任命/罢免）保留 color
    await store.appointSteward('a1')
    expect((await store.get('a1'))?.color).toBe('#199e70')
  })

  it('身份色读取端兼容：老 profile.json 无 color 字段加载不炸、字段缺席', async () => {
    const { fs } = makeStore()
    await fs.write(
      'data/agents/legacy/profile.json',
      `${JSON.stringify({ agentId: 'legacy', name: '旧档案', role: 'worker', createdAt: 1 }, null, 2)}\n`,
    )
    const store2 = new AgentStore({ fs, root: 'data', now: () => 0 })
    const list = await store2.list()
    expect(list).toHaveLength(1)
    expect(list[0]!.color).toBeUndefined()
    expect(list[0]!.name).toBe('旧档案')
  })

  it('唯一管家不变量：在位时第二个任命直接拒绝；同一人重复任命幂等', async () => {
    const { store } = makeStore()
    await store.register('a1')
    await store.register('a2')
    expect((await store.appointSteward('a1')).role).toBe('steward')
    await expect(store.appointSteward('a2')).rejects.toMatchObject({ code: 'STATE_STEWARD_EXISTS' })
    expect((await store.appointSteward('a1')).role).toBe('steward')
    expect((await store.findSteward())?.agentId).toBe('a1')
  })

  it('罢免 → 空缺态（findSteward 为 null）；非管家罢免拒绝', async () => {
    const { store } = makeStore()
    await store.register('a1')
    await store.register('a2')
    await store.appointSteward('a1')
    expect((await store.dismissSteward('a1')).role).toBe('worker')
    expect(await store.findSteward()).toBeNull()
    await expect(store.dismissSteward('a1')).rejects.toMatchObject({ code: 'STATE_NOT_STEWARD' })
  })

  it('转移为单事务：from → worker、to → steward', async () => {
    const { store } = makeStore()
    await store.register('a1')
    await store.register('a2')
    await store.appointSteward('a1')
    const { from, to } = await store.transferSteward('a1', 'a2')
    expect(from.role).toBe('worker')
    expect(to.role).toBe('steward')
    expect((await store.findSteward())?.agentId).toBe('a2')
    await expect(store.transferSteward('a1', 'a2')).rejects.toMatchObject({ code: 'STATE_NOT_STEWARD' })
  })

  it('删除 steward → 空缺态（不自动提拔）；删除后可再任命他人', async () => {
    const { store } = makeStore()
    await store.register('a1')
    await store.register('a2')
    await store.appointSteward('a1')
    await store.remove('a1')
    expect(await store.findSteward()).toBeNull()
    expect(await store.get('a1')).toBeNull()
    expect((await store.appointSteward('a2')).role).toBe('steward')
  })

  it('list 按 createdAt 稳定排序；崩溃后重开恢复角色', async () => {
    const { fs, store, advance } = makeStore()
    await store.register('b')
    advance(10)
    await store.register('a')
    await store.appointSteward('b')
    expect((await store.list()).map((p) => p.agentId)).toEqual(['b', 'a'])
    const reopened = new AgentStore({ fs, root: 'data', now: () => 999 })
    expect((await reopened.findSteward())?.agentId).toBe('b')
    expect((await reopened.get('a'))?.role).toBe('worker')
  })

  it('对不存在 agent 的操作统一 STATE_AGENT_NOT_FOUND', async () => {
    const { store } = makeStore()
    await expect(store.appointSteward('ghost')).rejects.toMatchObject({ code: 'STATE_AGENT_NOT_FOUND' })
    await expect(store.dismissSteward('ghost')).rejects.toMatchObject({ code: 'STATE_AGENT_NOT_FOUND' })
    await expect(store.transferSteward('ghost', 'ghost2')).rejects.toMatchObject({
      code: 'STATE_AGENT_NOT_FOUND',
    })
    await expect(store.remove('ghost')).rejects.toMatchObject({ code: 'STATE_AGENT_NOT_FOUND' })
  })

  it('排他变更锁：并发注册/任命不会产生双管家', async () => {
    const { store } = makeStore()
    await store.register('a1')
    await store.register('a2')
    const results = await Promise.allSettled([
      store.appointSteward('a1'),
      store.appointSteward('a2'),
    ])
    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected')
    expect(fulfilled.length).toBe(1)
    expect(rejected.length).toBe(1)
    expect((rejected[0] as PromiseRejectedResult).reason.code).toBe('STATE_STEWARD_EXISTS')
    expect((await store.list()).filter((p) => p.role === 'steward').length).toBe(1)
  })

  it('modelProvider 覆盖（backlog ③）：注册可选落档；setModelProvider 改写与清除（null）', async () => {
    const { store } = makeStore()
    const p1 = await store.register('agent-1', '甲', undefined, '端点B')
    expect(p1.modelProvider).toBe('端点B')
    expect((await store.list()).find((a) => a.agentId === 'agent-1')?.modelProvider).toBe('端点B')
    // 改写
    expect((await store.setModelProvider('agent-1', '端点C')).modelProvider).toBe('端点C')
    // 清除：键消失（非空串残留）
    const cleared = await store.setModelProvider('agent-1', null)
    expect(cleared.modelProvider).toBeUndefined()
    expect(JSON.stringify(cleared)).not.toContain('modelProvider')
    // 不存在稳定码
    await expect(store.setModelProvider('nope', 'x')).rejects.toMatchObject({ code: 'STATE_AGENT_NOT_FOUND' })
  })

  it('imageId 镜像绑定（P8-4）：注册可选落档（与 modelProvider 并存）；setImage 改写与清除（null）', async () => {
    const { store } = makeStore()
    const p1 = await store.register('agent-1', '甲', undefined, '端点B', 'img-1')
    expect(p1.imageId).toBe('img-1')
    expect(p1.modelProvider).toBe('端点B') // 两个覆盖维度互不干扰
    // 改写
    expect((await store.setImage('agent-1', 'img-2')).imageId).toBe('img-2')
    // 清除：键消失（非空串残留）
    const cleared = await store.setImage('agent-1', null)
    expect(cleared.imageId).toBeUndefined()
    expect(JSON.stringify(cleared)).not.toContain('imageId')
    expect(cleared.modelProvider).toBe('端点B') // 清除镜像不动模型覆盖
    // 空串等价清除；不存在稳定码
    await store.setImage('agent-1', 'img-1')
    expect((await store.setImage('agent-1', '')).imageId).toBeUndefined()
    await expect(store.setImage('nope', 'img-1')).rejects.toMatchObject({ code: 'STATE_AGENT_NOT_FOUND' })
  })
})
