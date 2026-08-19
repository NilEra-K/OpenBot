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
})
