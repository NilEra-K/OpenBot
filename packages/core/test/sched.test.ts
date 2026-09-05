import { describe, expect, it } from 'vitest'
import {
  AgentScheduler,
  EventBus,
  KernelError,
} from '../src/index.js'
import type { ActiveRun, KernelEvent, RunExecutor, RunTicket } from '../src/index.js'

/** 受控 execute：每个 run 挂一个门闩，测试手动放行/抛错；abort 转为拒绝 */
interface Gate {
  run: ActiveRun
  resolve: (result?: unknown) => void
  reject: (err: unknown) => void
}

function makeHarness(executeOverride?: RunExecutor) {
  let t = 0
  let counter = 0
  const events: KernelEvent[] = []
  const bus = new EventBus({ now: () => t })
  bus.on('*', (e) => events.push(e))
  const gates: Gate[] = []
  const gated: RunExecutor = (run) =>
    new Promise((resolve, reject) => {
      gates.push({ run, resolve, reject })
      run.signal.addEventListener('abort', () =>
        reject(new KernelError('TEST_ABORTED', '测试模拟中止')),
      )
    })
  const scheduler = new AgentScheduler({
    agentId: 'a1',
    now: () => t,
    nextRunId: () => `run-${++counter}`,
    execute: executeOverride ?? gated,
    bus,
  })
  return {
    scheduler,
    events,
    gates,
    now: () => t,
    advance(ms: number): void {
      t += ms
      scheduler.tick()
    },
  }
}

const types = (events: KernelEvent[], type: KernelEvent['type']): string[] =>
  events.filter((e) => e.type === type).map((e) => (e.payload as { runId: string }).runId)

describe('AgentScheduler 排他与优先级', () => {
  it('user 来客抢占 background 活跃 run（RUN_STEER），其后按 lane 优先级接棒', async () => {
    const started: string[] = []
    const harness = makeHarness(async (run) => {
      started.push(run.runId)
      return `ok:${run.kind}`
    })
    const r1 = harness.scheduler.enqueue({ lane: 'background', kind: 'bg' })
    const r2 = harness.scheduler.enqueue({ lane: 'agent', kind: 'a2a' })
    const r3 = harness.scheduler.enqueue({ lane: 'user', kind: 'chat' })
    const [o1, o2, o3] = await Promise.all([r1.settled, r2.settled, r3.settled])
    // r1 先到先跑，但被 user r3 抢占；r3 结束后 agent r2 接棒
    expect(started).toEqual(['run-1', 'run-3', 'run-2'])
    expect(o1.state).toBe('aborted')
    expect(o1.code).toBe('RUN_STEER')
    expect(o2.state).toBe('succeeded')
    expect(o3.state).toBe('succeeded')
  })

  it('排他不变量：前一个 run 结算后下一个才启动', async () => {
    const harness = makeHarness()
    const r1 = harness.scheduler.enqueue({ lane: 'user', kind: 'chat' })
    const r2 = harness.scheduler.enqueue({ lane: 'user', kind: 'chat' })
    expect(harness.scheduler.activeRunId).toBe('run-1')
    expect(harness.gates[0]?.run.runId).toBe('run-1')
    harness.gates[0]?.resolve('first')
    await r1.settled
    expect(harness.scheduler.activeRunId).toBe('run-2')
    harness.gates[1]?.resolve('second')
    await r2.settled
    expect(types(harness.events, 'v1.lifecycle.started')).toEqual(['run-1', 'run-2'])
    expect(harness.events.at(-1)?.type).toBe('v1.lifecycle.idle')
  })

  it('user 来客抢占 agent 活跃 run（RUN_STEER），且抢占后仍先结算旧 run 再启动新 run', async () => {
    const harness = makeHarness()
    const r1 = harness.scheduler.enqueue({ lane: 'agent', kind: 'a2a' })
    const r2 = harness.scheduler.enqueue({ lane: 'user', kind: 'chat' })
    const o1 = await r1.settled
    expect(o1.state).toBe('aborted')
    expect(o1.code).toBe('RUN_STEER')
    expect(harness.scheduler.activeRunId).toBe('run-2')
    // 排他：finished(run-1) 先于 started(run-2)
    const timeline = harness.events
      .filter((e) => e.type === 'v1.lifecycle.finished' || e.type === 'v1.lifecycle.started')
      .map((e) => `${e.type}:${(e.payload as { runId: string }).runId}`)
    expect(timeline).toEqual([
      'v1.lifecycle.started:run-1',
      'v1.lifecycle.finished:run-1',
      'v1.lifecycle.started:run-2',
    ])
    harness.gates[1]?.resolve()
    await r2.settled
  })

  it('user 活跃 run 永不被抢占（后来的 user 只能排队）', async () => {
    const harness = makeHarness()
    const r1 = harness.scheduler.enqueue({ lane: 'user', kind: 'chat' })
    const r2 = harness.scheduler.enqueue({ lane: 'user', kind: 'chat' })
    expect(harness.gates[0]?.run.signal.aborted).toBe(false)
    expect(harness.scheduler.activeRunId).toBe('run-1')
    harness.gates[0]?.resolve()
    await r1.settled
    expect(harness.scheduler.activeRunId).toBe('run-2')
    harness.gates[1]?.resolve()
    await r2.settled
  })

  it('普通 agent 来客不抢占 background；steer 来客才抢', async () => {
    const harness = makeHarness()
    const r1 = harness.scheduler.enqueue({ lane: 'background', kind: 'task' })
    harness.scheduler.enqueue({ lane: 'agent', kind: 'a2a' })
    expect(harness.gates[0]?.run.signal.aborted).toBe(false)
    harness.gates[0]?.resolve()
    await r1.settled
    // 第二轮：steer 抢占
    const harness2 = makeHarness()
    const b1 = harness2.scheduler.enqueue({ lane: 'background', kind: 'task' })
    const s1 = harness2.scheduler.enqueue({ lane: 'agent', kind: 'a2a', steer: true })
    const ob1 = await b1.settled
    expect(ob1.state).toBe('aborted')
    expect(ob1.code).toBe('RUN_STEER')
    harness2.gates[1]?.resolve()
    await s1.settled
  })
})

describe('AgentScheduler watchdog 与期限', () => {
  it('grace 超限：settled 立即以 escaped 结算（发送永不悬挂），槽位保留至 zombie 回收', async () => {
    const harness = makeHarness()
    const r1 = harness.scheduler.enqueue({
      lane: 'background',
      kind: 'task',
      policy: { graceMs: 1_000, deadlineMs: 60_000 },
    })
    harness.advance(1_001)
    const o1 = await r1.settled
    expect(o1.state).toBe('escaped')
    expect(o1.code).toBe('RUN_GRACE_EXCEEDED')
    expect(harness.events.some((e) => e.type === 'v1.lifecycle.escaped')).toBe(true)
    // zombie 仍占槽位：排他不变量不许破
    expect(harness.scheduler.activeRunId).toBe('run-1')
    const r2 = harness.scheduler.enqueue({ lane: 'background', kind: 'task' })
    expect(harness.scheduler.activeRunId).toBe('run-1')
    // zombie 最终 settle → reaped → r2 接棒
    harness.gates[0]?.reject(new KernelError('TEST_ABORTED'))
    // 冲刷微任务：让 #finish → reaped → drain → #start(r2) 跑完，门闩 2 才存在
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    harness.gates[1]?.resolve()
    await r2.settled
    expect(harness.events.some((e) => e.type === 'v1.lifecycle.reaped')).toBe(true)
    expect(types(harness.events, 'v1.lifecycle.started')).toEqual(['run-1', 'run-2'])
  })

  it('deadline 超限：abort 并按 RUN_DEADLINE 失败结算（execute 自报 code 不作数）', async () => {
    const harness = makeHarness()
    const r1 = harness.scheduler.enqueue({
      lane: 'background',
      kind: 'task',
      policy: { graceMs: 60_000, deadlineMs: 2_000 },
    })
    harness.advance(2_001)
    const o1 = await r1.settled
    expect(o1.state).toBe('failed')
    expect(o1.code).toBe('RUN_DEADLINE')
  })

  it('先逃逸后到期：只结算一次，结局保持 escaped', async () => {
    const harness = makeHarness()
    const r1 = harness.scheduler.enqueue({
      lane: 'background',
      kind: 'task',
      policy: { graceMs: 1_000, deadlineMs: 2_000 },
    })
    harness.advance(3_000) // 同一次 tick 内先过 grace 再过 deadline
    const o1 = await r1.settled
    expect(o1.state).toBe('escaped')
    harness.gates[0]?.reject(new KernelError('TEST_ABORTED'))
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    // zombie 回收补发**真实终态** finished（2026-09-06：deadline abort → failed/RUN_DEADLINE）
    const finished = harness.events.find((e) => e.type === 'v1.lifecycle.finished')
    expect(finished).toBeTruthy()
    expect(finished!.payload.state).toBe('failed')
    expect((finished!.payload as { code?: string }).code).toBe('RUN_DEADLINE')
    expect(harness.scheduler.isIdle).toBe(true)
  })

  it('进展驱动 grace：touch 保鲜——在动的 run 永不逃逸，停止进展后才超窗（2026-09-06 语义升级）', async () => {
    const harness = makeHarness()
    const r1 = harness.scheduler.enqueue({
      lane: 'background',
      kind: 'task',
      policy: { graceMs: 1_000, deadlineMs: 60_000 },
    })
    // 持续进展：每推进 500ms（<grace 1000）touch 一次——3 秒后依然在跑
    for (let t = 0; t < 6; t++) {
      harness.advance(500)
      harness.scheduler.tick()
      const settled = await Promise.race([r1.settled.then(() => true), Promise.resolve(false)])
      expect(settled, `第 ${t + 1} 步不应逃逸`).toBe(false)
      expect(harness.scheduler.touch('run-1')).toBe(true)
    }
    harness.advance(500)
    harness.scheduler.tick()
    expect(harness.scheduler.activeRunId).toBe('run-1') // 有进展不逃逸
    // 停止 touch：无进展超窗 → 逃逸（回执先行）
    harness.advance(1_001)
    expect((await r1.settled).state).toBe('escaped')
    // touch 非活跃/不存在 runId：静默 false
    expect(harness.scheduler.touch('run-1')).toBe(false) // 已逃逸——不再有意义
    expect(harness.scheduler.touch('run-nope')).toBe(false)
    harness.gates[0]?.resolve()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  })

  it('zombie 真实终态补发：底层成功 → finished succeeded（呈现层不再停在「已回收」）', async () => {
    const harness = makeHarness()
    const r1 = harness.scheduler.enqueue({
      lane: 'background',
      kind: 'task',
      policy: { graceMs: 1_000, deadlineMs: 60_000 },
    })
    harness.advance(1_001)
    expect((await r1.settled).state).toBe('escaped') // 回执先行
    harness.gates[0]?.resolve('late-answer') // 底层迟到成功
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(harness.events.some((e) => e.type === 'v1.lifecycle.reaped')).toBe(true)
    const finished = harness.events.find((e) => e.type === 'v1.lifecycle.finished')
    expect(finished).toBeTruthy()
    expect(finished!.payload.state).toBe('succeeded') // 真实终态（不再沉默）
    expect(harness.scheduler.isIdle).toBe(true)
  })
})

describe('AgentScheduler 取消与错误归类', () => {
  it('取消排队中的 run：立即 aborted/RUN_CANCELLED，不再启动', async () => {
    const harness = makeHarness()
    const r1 = harness.scheduler.enqueue({ lane: 'user', kind: 'chat' })
    const r2 = harness.scheduler.enqueue({ lane: 'user', kind: 'chat' })
    expect(harness.scheduler.cancel('run-2')).toBe(true)
    const o2 = await r2.settled
    expect(o2.state).toBe('aborted')
    expect(o2.code).toBe('RUN_CANCELLED')
    expect(types(harness.events, 'v1.lifecycle.started')).toEqual(['run-1'])
    harness.gates[0]?.resolve()
    await r1.settled
  })

  it('取消活跃 run：经 abort 结算 aborted/RUN_CANCELLED', async () => {
    const harness = makeHarness()
    const r1 = harness.scheduler.enqueue({ lane: 'user', kind: 'chat' })
    expect(harness.scheduler.cancel('run-1')).toBe(true)
    const o1 = await r1.settled
    expect(o1.state).toBe('aborted')
    expect(o1.code).toBe('RUN_CANCELLED')
    expect(harness.scheduler.isIdle).toBe(true)
  })

  it('取消不存在的 run 返回 false', () => {
    const harness = makeHarness()
    expect(harness.scheduler.cancel('run-404')).toBe(false)
  })

  it('execute 抛 KernelError：code 原样进结局；非 KernelError 归类 RUN_INTERNAL', async () => {
    const h1 = makeHarness(async () => {
      throw new KernelError('BOX_TIMEOUT', '模拟沙箱超时')
    })
    const o1 = await h1.scheduler.enqueue({ lane: 'user', kind: 'chat' }).settled
    expect(o1.state).toBe('failed')
    expect(o1.code).toBe('BOX_TIMEOUT')

    const boom = (): Promise<unknown> => {
      throw new Error('boom')
    }
    const h2 = makeHarness(boom)
    const o2 = await h2.scheduler.enqueue({ lane: 'user', kind: 'chat' }).settled
    expect(o2.state).toBe('failed')
    expect(o2.code).toBe('RUN_INTERNAL')
    expect(o2.message).toBe('boom')
  })

  it('受理即回票据（ack 义务）：runId 确定性、acceptedAt 取注入时钟', () => {
    const harness = makeHarness()
    const r1: RunTicket = harness.scheduler.enqueue({ lane: 'user', kind: 'chat' })
    expect(r1.runId).toBe('run-1')
    expect(r1.agentId).toBe('a1')
    expect(r1.acceptedAt).toBe(0)
    harness.gates[0]?.resolve()
  })

  it('summary 透传进 queued 事件；未带则键不出现（向后兼容读取端）', async () => {
    const harness = makeHarness(async () => 'ok')
    harness.scheduler.enqueue({ lane: 'user', kind: 'chat', summary: '帮我检查工作区' })
    harness.scheduler.enqueue({ lane: 'background', kind: 'task' })
    const queued = harness.events.filter((e) => e.type === 'v1.lifecycle.queued')
    expect(queued[0]?.payload).toMatchObject({ runId: 'run-1', summary: '帮我检查工作区' })
    expect(queued[1]?.payload).not.toHaveProperty('summary')
  })
})
