import { describe, expect, it } from 'vitest'
import { AgentScheduler, EventBus } from '@openbot/core'
import type { ActiveRun, KernelEvent } from '@openbot/core'
import { IdempotencyLedger, InMemoryFs, TranscriptStore } from '@openbot/state'
import { A2aService } from '../src/index.js'

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
  const seenPayloads: unknown[] = []
  const schedulers = new Map<string, AgentScheduler>()
  const makeScheduler = (agentId: string): AgentScheduler =>
    new AgentScheduler({
      agentId,
      now: () => t,
      nextRunId: () => `${agentId}-run-${++runCounter}`,
      bus,
      execute: (run) =>
        new Promise((resolve, reject) => {
          seenPayloads.push(run.payload)
          gates.push({ run, resolve })
          // 被抢占时放行 promise：模拟真实 execute 响应 signal
          run.signal.addEventListener('abort', () => reject(new Error(`中止:${run.runId}`)))
        }),
    })
  const service = new A2aService({
    bus,
    now: () => t,
    nextMessageId: () => `msg-${++msgCounter}`,
    transcript,
    ledger,
    schedulerOf: (agentId) => {
      const s = schedulers.get(agentId)
      if (!s) throw new Error(`未注册 agent：${agentId}`)
      return s
    },
  })
  return {
    service,
    events,
    gates,
    seenPayloads,
    transcript,
    register: (agentId: string) => {
      const s = makeScheduler(agentId)
      schedulers.set(agentId, s)
      return s
    },
    flush: () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
  }
}

describe('A2aService 用户入站', () => {
  it('受理链：transcript 落 user 记录、发 v1.message.user、唤醒 user lane run', async () => {
    const h = makeHarness()
    h.register('a1')
    const acc = await h.service.sendUserMessage({ toAgentId: 'a1', text: '你好', nonce: 'n1' })
    expect(acc).toEqual({ messageId: 'msg-1', runId: 'a1-run-1', first: true })
    const records = await h.transcript.readAll('a1')
    expect(records[0]?.kind).toBe('user')
    expect(records[0]?.payload).toEqual({ messageId: 'msg-1', text: '你好', at: 0 })
    expect(h.events.some((e) => e.type === 'v1.message.user')).toBe(true)
    expect(h.gates[0]?.run.lane).toBe('user')
    h.gates[0]?.resolve()
    await h.flush()
  })

  it('幂等：同 nonce 重试零双发，回放首次受理回执', async () => {
    const h = makeHarness()
    h.register('a1')
    const first = await h.service.sendUserMessage({ toAgentId: 'a1', text: '你好', nonce: 'n1' })
    const retry = await h.service.sendUserMessage({ toAgentId: 'a1', text: '你好', nonce: 'n1' })
    expect(retry).toEqual({ ...first, first: false })
    expect((await h.transcript.readAll('a1')).length).toBe(1)
    expect(h.gates.length).toBe(1)
    h.gates[0]?.resolve()
  })

  it('同 nonce 不同内容：账本拒绝（重放错配防御）', async () => {
    const h = makeHarness()
    h.register('a1')
    await h.service.sendUserMessage({ toAgentId: 'a1', text: '你好', nonce: 'n1' })
    await expect(
      h.service.sendUserMessage({ toAgentId: 'a1', text: '改口了', nonce: 'n1' }),
    ).rejects.toMatchObject({ code: 'LEDGER_DIGEST_MISMATCH' })
    h.gates[0]?.resolve()
  })
})

describe('A2aService 私聊', () => {
  it('双侧 transcript 镜像 + 事件 + 接收方 agent lane 唤醒', async () => {
    const h = makeHarness()
    h.register('a1')
    h.register('a2')
    const acc = await h.service.sendA2a({ fromAgentId: 'a1', toAgentId: 'a2', text: '搭把手', nonce: 'n1' })
    expect(acc.first).toBe(true)
    const out = await h.transcript.readAll('a1')
    const inbox = await h.transcript.readAll('a2')
    expect(out[0]?.kind).toBe('a2a-out')
    expect(inbox[0]?.kind).toBe('a2a-in')
    expect((inbox[0]?.payload as { from: string }).from).toBe('a1')
    const evt = h.events.find((e) => e.type === 'v1.message.a2a')
    expect(evt?.payload).toEqual({
      messageId: 'msg-1',
      fromAgentId: 'a1',
      toAgentId: 'a2',
      text: '搭把手',
      priority: false,
      isRedriven: false,
    })
    expect(h.gates[0]?.run.agentId).toBe('a2')
    expect(h.gates[0]?.run.lane).toBe('agent')
    h.gates[0]?.resolve()
    await h.flush()
  })

  it('给自己发 A2A：MSG_SELF_SEND；幂等重试零双发', async () => {
    const h = makeHarness()
    h.register('a1')
    h.register('a2')
    await expect(
      h.service.sendA2a({ fromAgentId: 'a1', toAgentId: 'a1', text: '自言自语', nonce: 'n0' }),
    ).rejects.toMatchObject({ code: 'MSG_SELF_SEND' })
    await h.service.sendA2a({ fromAgentId: 'a1', toAgentId: 'a2', text: '一次', nonce: 'n1' })
    const retry = await h.service.sendA2a({ fromAgentId: 'a1', toAgentId: 'a2', text: '一次', nonce: 'n1' })
    expect(retry.first).toBe(false)
    expect(h.gates.length).toBe(1)
    h.gates[0]?.resolve()
    await h.flush()
  })

  it('priority steer：抢占接收方正在跑的 background 工作', async () => {
    const h = makeHarness()
    const a2 = h.register('a2')
    h.register('a1')
    const bg = a2.enqueue({ lane: 'background', kind: 'task', payload: { n: 1 } })
    await h.service.sendA2a({ fromAgentId: 'a1', toAgentId: 'a2', text: '急事', priority: true, nonce: 'n1' })
    const oBg = await bg.settled
    expect(oBg.state).toBe('aborted')
    expect(oBg.code).toBe('RUN_STEER')
    h.gates[1]?.resolve()
    await h.flush()
  })

  it('at-least-once 重驱：被抢的 A2A run 以 isRedriven=true 重驱一次', async () => {
    const h = makeHarness()
    const a2 = h.register('a2')
    h.register('a1')
    // 消息 A 先到，a2 开始处理（gated 挂起）
    await h.service.sendA2a({ fromAgentId: 'a1', toAgentId: 'a2', text: 'A', nonce: 'nA' })
    expect(h.gates.length).toBe(1)
    // 消息 B（priority）抢占 A
    await h.service.sendA2a({ fromAgentId: 'a1', toAgentId: 'a2', text: 'B', priority: true, nonce: 'nB' })
    h.gates[1]?.resolve() // B 完成
    await h.flush()
    // A 以 isRedriven=true 重驱
    expect(h.gates.length).toBe(3)
    const redriven = h.gates[2]?.run.payload as { text: string; isRedriven: boolean }
    expect(redriven.text).toBe('A')
    expect(redriven.isRedriven).toBe(true)
    h.gates[2]?.resolve()
    await h.flush()
    expect(a2.isIdle).toBe(true)
  })

  it('防环：重驱后的 run 再被抢不再重驱，记 MSG_REDRIVE_EXHAUSTED', async () => {
    const h = makeHarness()
    h.register('a2')
    h.register('a1')
    await h.service.sendA2a({ fromAgentId: 'a1', toAgentId: 'a2', text: 'A', nonce: 'nA' })
    await h.service.sendA2a({ fromAgentId: 'a1', toAgentId: 'a2', text: 'B', priority: true, nonce: 'nB' })
    h.gates[1]?.resolve() // B 完成，A 重驱挂起
    await h.flush()
    expect(h.gates.length).toBe(3)
    // C（priority）抢占重驱中的 A
    await h.service.sendA2a({ fromAgentId: 'a1', toAgentId: 'a2', text: 'C', priority: true, nonce: 'nC' })
    h.gates[3]?.resolve() // C 完成
    await h.flush()
    expect(h.gates.length).toBe(4) // 没有第二次重驱
    expect(h.service.failures.map((f) => f.code)).toEqual(['MSG_REDRIVE_EXHAUSTED'])
  })
})
