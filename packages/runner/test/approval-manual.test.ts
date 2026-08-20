import { describe, expect, it } from 'vitest'
import { EventBus } from '@openbot/core'
import type { KernelEvent } from '@openbot/core'
import { IdempotencyLedger, InMemoryFs } from '@openbot/state'
import { ManualApprovalGate } from '../src/index.js'
import type { ApprovalRequest } from '../src/index.js'

function makeGate() {
  const fs = new InMemoryFs()
  const bus = new EventBus({ now: () => 0 })
  const events: KernelEvent[] = []
  bus.on('*', (e) => events.push(e))
  const ledger = new IdempotencyLedger({ fs, root: 'data', now: () => 0 })
  const gate = new ManualApprovalGate({ bus, ledger })
  return { fs, bus, events, ledger, gate }
}

const req = (nonce: string): ApprovalRequest => ({
  runId: 'run-1',
  agentId: 'a1',
  tool: 'host_fetch',
  nonce,
})

describe('ManualApprovalGate', () => {
  it('request 挂起至决议：批准/拒绝路径 + 事件对 + 账本落定', async () => {
    const { gate, events, ledger } = makeGate()
    const p1 = gate.request(req('m1:c1'))
    await new Promise<void>((r) => setTimeout(r, 0))
    expect(gate.pending().map((p) => p.nonce)).toEqual(['m1:c1'])
    expect(await gate.resolve('m1:c1', 'approved')).toBe(true)
    expect(await p1).toBe(true)
    expect(gate.pending()).toEqual([])
    expect((await ledger.lookup('approval:m1:c1'))?.outcome).toBe(true)
    expect(events.map((e) => e.type)).toEqual([
      'v1.approval.requested',
      'v1.approval.resolved',
    ])

    const h2 = makeGate()
    const p2 = h2.gate.request(req('m2:c1'))
    expect(await h2.gate.resolve('m2:c1', 'denied')).toBe(false)
    expect(await p2).toBe(false)
    expect((await h2.ledger.lookup('approval:m2:c1'))?.outcome).toBe(false)
  })

  it('requested 事件的 approvalId 由 nonce 派生（确定性）', async () => {
    const { gate, events } = makeGate()
    const p = gate.request(req('m9:c1'))
    await new Promise<void>((r) => setTimeout(r, 0))
    const requested = events.find((e) => e.type === 'v1.approval.requested')
    expect(requested?.payload).toMatchObject({ approvalId: 'appr-m9:c1', nonce: 'm9:c1', tool: 'host_fetch' })
    await gate.resolve('m9:c1', 'approved')
    await p
  })

  it('重复 resolve 幂等：只发一次 resolved，账本首决不变', async () => {
    const { gate, events } = makeGate()
    const p = gate.request(req('m3:c1'))
    await gate.resolve('m3:c1', 'approved')
    expect(await gate.resolve('m3:c1', 'denied')).toBe(true) // 回放首决，不翻转
    expect(await p).toBe(true)
    expect(events.filter((e) => e.type === 'v1.approval.resolved').length).toBe(1)
  })

  it('已决议的 nonce 再 request：直接回放决定，不再弹窗', async () => {
    const { gate, events } = makeGate()
    const p1 = gate.request(req('m4:c1'))
    await gate.resolve('m4:c1', 'approved')
    await p1
    const requestedCount = events.filter((e) => e.type === 'v1.approval.requested').length
    expect(await gate.request(req('m4:c1'))).toBe(true)
    expect(events.filter((e) => e.type === 'v1.approval.requested').length).toBe(requestedCount)
  })

  it('并发同 nonce：并到同一等待，单次弹窗', async () => {
    const { gate, events } = makeGate()
    const p1 = gate.request(req('m5:c1'))
    const p2 = gate.request(req('m5:c1'))
    await gate.resolve('m5:c1', 'approved')
    expect(await Promise.all([p1, p2])).toEqual([true, true])
    expect(events.filter((e) => e.type === 'v1.approval.requested').length).toBe(1)
  })

  it('崩溃恢复：重启后同 nonce 再 request 重发事件再挂起；决议后回放', async () => {
    const h1 = makeGate()
    const p1 = h1.gate.request(req('m6:c1'))
    // 模拟进程重启：等待 promise 丢失（不 resolve p1），账本留在 pending
    const h2 = makeGateFrom(h1.fs)
    const p2 = h2.gate.request(req('m6:c1'))
    await new Promise<void>((r) => setTimeout(r, 0))
    expect(h2.gate.pending().length).toBe(1)
    expect(h2.events.filter((e) => e.type === 'v1.approval.requested').length).toBe(1)
    expect(await h2.gate.resolve('m6:c1', 'approved')).toBe(true)
    expect(await p2).toBe(true)
    // 再重启再请求：已决议 → 直接回放
    const h3 = makeGateFrom(h1.fs)
    expect(await h3.gate.request(req('m6:c1'))).toBe(true)
    expect(h3.events.filter((e) => e.type === 'v1.approval.requested').length).toBe(0)
    void p1 // 原 promise 永挂起（旧进程已死）——不影响新进程
  })

  it('resolve 未知 nonce：APPROVAL_NOT_FOUND', async () => {
    const { gate } = makeGate()
    await expect(gate.resolve('ghost:c1', 'approved')).rejects.toMatchObject({
      code: 'APPROVAL_NOT_FOUND',
    })
  })

  it('revokeRun：run 中止善后——该 run 的挂起审批按 denied 落账、等待方唤醒、resolved 事件照发', async () => {
    const { gate, events, ledger } = makeGate()
    const p1 = gate.request(req('m8:c1')) // run-1
    const p2 = gate.request({ ...req('m8:c2'), runId: 'run-2' }) // 其他 run 的不受牵连
    await new Promise<void>((r) => setTimeout(r, 0))
    expect(await gate.revokeRun('run-1')).toBe(1)
    expect(await p1).toBe(false) // 等待方被唤醒（否决）
    expect((await ledger.lookup('approval:m8:c1'))?.outcome).toBe(false) // 账本落定
    const resolved = events.filter((e) => e.type === 'v1.approval.resolved')
    expect(resolved.map((e) => e.payload.nonce)).toEqual(['m8:c1'])
    expect(resolved[0]!.payload).toMatchObject({ decision: 'denied' }) // UI 卡自然收敛
    expect(gate.pending().map((p) => p.nonce)).toEqual(['m8:c2']) // run-2 的照挂
    expect(await gate.revokeRun('run-1')).toBe(0) // 幂等：无遗留返回 0
    await gate.resolve('m8:c2', 'approved') // 收尾不泄漏
    expect(await p2).toBe(true)
  })

  it('revokeRun 后再决议：幂等回放首决（denied），不翻转', async () => {
    const { gate } = makeGate()
    const p = gate.request(req('m8:c9'))
    await gate.revokeRun('run-1')
    expect(await gate.resolve('m8:c9', 'approved')).toBe(false) // 回放 revoked 首决
    expect(await p).toBe(false)
  })

  it('replayPending：装配时扫账本重发 requested（UI 重弹窗），决议后落账本', async () => {
    const h1 = makeGate()
    void h1.gate.request(req('m7:c1'))
    void h1.gate.request(req('m7:c2'))
    await h1.gate.resolve('m7:c2', 'denied')
    // 重启：新 gate + replayPending
    const h2 = makeGateFrom(h1.fs)
    const replayed = await h2.gate.replayPending()
    expect(replayed).toBe(1) // 只剩 m7:c1（m7:c2 已决议）
    const requested = h2.events.filter((e) => e.type === 'v1.approval.requested')
    expect(requested.map((e) => e.payload.nonce)).toEqual(['m7:c1'])
    expect(requested[0]!.payload).toMatchObject({ runId: 'run-1', agentId: 'a1', tool: 'host_fetch' })
    // 重放的审批经 resolve 命令照常落账本（不重建进程内挂起）
    expect(await h2.gate.resolve('m7:c1', 'approved')).toBe(true)
    expect(await h2.gate.replayPending()).toBe(0)
  })
})

function makeGateFrom(fs: InMemoryFs) {
  const bus = new EventBus({ now: () => 0 })
  const events: KernelEvent[] = []
  bus.on('*', (e) => events.push(e))
  const ledger = new IdempotencyLedger({ fs, root: 'data', now: () => 0 })
  return { bus, events, gate: new ManualApprovalGate({ bus, ledger }) }
}
