import { describe, expect, it } from 'vitest'
import { AgentScheduler, EventBus, KernelError } from '@openbot/core'
import type { ActiveRun, KernelEvent } from '@openbot/core'
import { IdempotencyLedger, InMemoryFs, TranscriptStore } from '@openbot/state'
import { A2aService, BroadcastService } from '../src/index.js'

/** 门：挂起 run 模拟执行中（广播受理返回时全部 run 已入队未结算） */
interface Gate {
  run: ActiveRun
  resolve: (result?: unknown) => void
}

function makeHarness() {
  let t = 0
  let msgCounter = 0
  let runCounter = 0
  const fs = new InMemoryFs()
  const bus = new EventBus({ now: () => t })
  const events: KernelEvent[] = []
  bus.on('*', (e) => events.push(e))
  const transcript = new TranscriptStore({ fs, root: 'data', now: () => t })
  const ledger = new IdempotencyLedger({ fs, root: 'data', now: () => t })
  const gates: Gate[] = []
  const schedulers = new Map<string, AgentScheduler>()
  const makeScheduler = (agentId: string): AgentScheduler =>
    new AgentScheduler({
      agentId,
      now: () => t,
      nextRunId: () => `${agentId}-run-${++runCounter}`,
      bus,
      execute: (run) =>
        new Promise((resolve) => {
          gates.push({ run, resolve })
          run.signal.addEventListener('abort', () => resolve(undefined))
        }),
    })
  const a2a = new A2aService({
    bus,
    now: () => t,
    nextMessageId: () => `msg-${++msgCounter}`,
    transcript,
    ledger,
    schedulerOf: (agentId) => {
      const s = schedulers.get(agentId)
      if (!s) throw new KernelError('STATE_AGENT_NOT_FOUND', `未注册 agent：${agentId}`)
      return s
    },
  })
  /** 扇出权事实：名册外的固定 steward 集合（测扇出权分支，不引入 store 依赖） */
  const stewards = new Set<string>()
  const service = new BroadcastService({
    a2a,
    isSteward: async (agentId) => stewards.has(agentId),
    assertAgent: (agentId) => {
      if (!schedulers.has(agentId)) throw new KernelError('STATE_AGENT_NOT_FOUND', `未注册 agent：${agentId}`)
    },
  })
  return {
    service,
    events,
    gates,
    transcript,
    stewards,
    register: (agentId: string) => {
      const s = makeScheduler(agentId)
      schedulers.set(agentId, s)
      return s
    },
    settle: () => {
      for (const g of gates) g.resolve()
    },
    flush: () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
  }
}

describe('BroadcastService 扇出权', () => {
  it('worker 发起拒绝：MSG_BROADCAST_FORBIDDEN，零事件零 run', async () => {
    const h = makeHarness()
    h.register('w1')
    h.register('w2')
    await expect(
      h.service.broadcast({ from: 'w1', toAgentIds: ['w2'], text: 'x', nonce: 'n1' }),
    ).rejects.toMatchObject({ code: 'MSG_BROADCAST_FORBIDDEN' })
    expect(h.events.length).toBe(0)
    expect(h.gates.length).toBe(0)
  })

  it('不在位的名誉 steward 同样拒绝（isSteward 查在位事实）', async () => {
    const h = makeHarness()
    h.register('a')
    await expect(
      h.service.broadcast({ from: 'ex-steward', toAgentIds: ['a'], text: 'x', nonce: 'n1' }),
    ).rejects.toMatchObject({ code: 'MSG_BROADCAST_FORBIDDEN' })
  })
})

describe('BroadcastService 用户扇出（@全员/@多提及）', () => {
  it('N 成员逐个定向投递：N 条 v1.message.user + 各自 transcript user 记录 + N 个 user lane run', async () => {
    const h = makeHarness()
    h.register('a1')
    h.register('a2')
    h.register('a3')
    const acc = await h.service.broadcast({ from: 'user', toAgentIds: ['a1', 'a2', 'a3'], text: '全员注意', nonce: 'n1' })
    expect(acc.first).toBe(true)
    expect(acc.recipients.map((r) => r.agentId)).toEqual(['a1', 'a2', 'a3'])
    // 零新事件族：逐成员复用 v1.message.user（toAgentId 各异）
    const userEvents = h.events.filter((e) => e.type === 'v1.message.user')
    expect(userEvents).toHaveLength(3)
    expect(new Set(userEvents.map((e) => (e.payload as { toAgentId: string }).toAgentId))).toEqual(
      new Set(['a1', 'a2', 'a3']),
    )
    // transcript：每成员各一条入信
    for (const id of ['a1', 'a2', 'a3']) {
      const records = await h.transcript.readAll(id)
      expect(records).toHaveLength(1)
      expect(records[0]?.kind).toBe('user')
    }
    // 顺序入队（lane 随发起方=user）+ 各成员独立（并发执行的前提）
    expect(h.gates.map((g) => g.run.lane)).toEqual(['user', 'user', 'user'])
    expect(h.gates.map((g) => g.run.agentId)).toEqual(['a1', 'a2', 'a3'])
    h.settle()
    await h.flush()
  })

  it('幂等：同 nonce 整体重试全部回放（first=false），零新事件零新 run', async () => {
    const h = makeHarness()
    h.register('a1')
    h.register('a2')
    const first = await h.service.broadcast({ from: 'user', toAgentIds: ['a1', 'a2'], text: '只发一次', nonce: 'n1' })
    expect(first.first).toBe(true)
    const before = { events: h.events.length, gates: h.gates.length }
    const retry = await h.service.broadcast({ from: 'user', toAgentIds: ['a1', 'a2'], text: '只发一次', nonce: 'n1' })
    expect(retry.first).toBe(false)
    expect(retry.recipients.map((r) => r.messageId)).toEqual(first.recipients.map((r) => r.messageId))
    expect(h.events.length).toBe(before.events)
    expect(h.gates.length).toBe(before.gates)
    h.settle()
    await h.flush()
  })
})

describe('BroadcastService steward 扇出', () => {
  it('A2A 语义扇出：双侧镜像 + v1.message.a2a + agent lane run', async () => {
    const h = makeHarness()
    h.register('steward')
    h.register('w1')
    h.register('w2')
    h.stewards.add('steward')
    const acc = await h.service.broadcast({ from: 'steward', toAgentIds: ['w1', 'w2'], text: '分头去做', nonce: 'n1' })
    expect(acc.recipients).toHaveLength(2)
    // 发起者出信镜像 ×2 + 各成员入信
    const out = await h.transcript.readAll('steward')
    expect(out.filter((r) => r.kind === 'a2a-out')).toHaveLength(2)
    for (const id of ['w1', 'w2']) {
      expect((await h.transcript.readAll(id))[0]?.kind).toBe('a2a-in')
    }
    const a2aEvents = h.events.filter((e) => e.type === 'v1.message.a2a')
    expect(a2aEvents).toHaveLength(2)
    expect(h.gates.every((g) => g.run.lane === 'agent')).toBe(true)
    h.settle()
    await h.flush()
  })
})

describe('BroadcastService 原子性与收件整形', () => {
  it('先全量校验后投递：任一成员未注册则整体拒绝，零事件零 run（不留半途扇出）', async () => {
    const h = makeHarness()
    h.register('a1')
    await expect(
      h.service.broadcast({ from: 'user', toAgentIds: ['a1', 'ghost'], text: 'x', nonce: 'n1' }),
    ).rejects.toMatchObject({ code: 'STATE_AGENT_NOT_FOUND' })
    expect(h.events.length).toBe(0)
    expect(h.gates.length).toBe(0)
    // a1 未被投递（transcript 空）
    expect(await h.transcript.readAll('a1')).toHaveLength(0)
  })

  it('去重 + 发起者自排除：@全员列表含重复与 steward 自己 → 只投其余成员', async () => {
    const h = makeHarness()
    h.register('steward')
    h.register('w1')
    h.register('w2')
    h.stewards.add('steward')
    const acc = await h.service.broadcast({
      from: 'steward',
      toAgentIds: ['steward', 'w1', 'w1', 'w2'],
      text: '全员注意',
      nonce: 'n1',
    })
    expect(acc.recipients.map((r) => r.agentId)).toEqual(['w1', 'w2'])
    // 自排除=发起者无入信无 run（出信镜像照常——w1/w2 各一条 a2a-out）
    const stewardRecords = await h.transcript.readAll('steward')
    expect(stewardRecords.filter((r) => r.kind === 'a2a-out')).toHaveLength(2)
    expect(stewardRecords.some((r) => r.kind === 'a2a-in')).toBe(false)
    expect(h.gates.every((g) => g.run.agentId !== 'steward')).toBe(true)
    h.settle()
    await h.flush()
  })

  it('排除后收件为空：MSG_BROADCAST_EMPTY', async () => {
    const h = makeHarness()
    h.register('a1')
    await expect(
      h.service.broadcast({ from: 'a1', toAgentIds: ['a1'], text: 'x', nonce: 'n1' }),
    ).rejects.toMatchObject({ code: 'MSG_BROADCAST_FORBIDDEN' }) // a1 非 steward，扇出权先拒绝
    h.stewards.add('a1')
    await expect(
      h.service.broadcast({ from: 'a1', toAgentIds: ['a1', 'a1'], text: 'x', nonce: 'n2' }),
    ).rejects.toMatchObject({ code: 'MSG_BROADCAST_EMPTY' })
  })
})
