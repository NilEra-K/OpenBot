import { describe, expect, it } from 'vitest'
import { MockChatProvider } from '@openbot/llm'
import type { MockStep } from '@openbot/llm'
import { MockBoxBackend } from '@openbot/boxes'
import { ManualApprovalGate } from '@openbot/runner'
import { assembleKernel, InProcessCarrier } from '../src/index.js'
import type { AssembledKernel } from '../src/index.js'
import type { KernelEvent } from '@openbot/core'

function makeKernel(): AssembledKernel {
  return assembleKernel({ now: () => 0, bootPrefix: 't', systemPrompt: '你是 OpenBot agent' })
}

async function waitIdle(kernel: AssembledKernel): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if ([...kernel.schedulers.values()].every((s) => s.isIdle)) return
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('等待调度器空闲超时')
}

describe('assembleKernel 全链路（经 transport 客户端驱动，壳视角）', () => {
  it('chat → A2A → box exec(mock)：双侧 transcript、事件流、Box 清单', async () => {
    const kernel = makeKernel()
    const client = kernel.transport.createClient()
    const events: KernelEvent[] = []
    client.subscribe((e) => events.push(e))

    await kernel.addAgent({
      agentId: 'a1',
      steward: true,
      llm: new MockChatProvider({
        steps: [
          { toolCalls: [{ id: 'c1', name: 'send_message', args: { toAgentId: 'a2', text: '查一下目录' } }] },
          { text: '已让 a2 去查' },
        ],
      }),
    })
    await kernel.addAgent({
      agentId: 'a2',
      llm: new MockChatProvider({
        steps: [
          { toolCalls: [{ id: 'c1', name: 'exec', args: { command: ['ls', '/work'] } }] },
          { text: '查完了：目录是空的' },
        ],
      }),
    })

    expect(await client.call<{ pong: boolean }>('v1.system.ping')).toEqual({ pong: true })
    const acceptance = await client.call<{ messageId: string; runId: string; first: boolean }>(
      'v1.message.sendUser',
      { toAgentId: 'a1', text: '帮我查目录', nonce: 'demo-1' },
    )
    expect(acceptance.first).toBe(true)
    await waitIdle(kernel)

    const t1 = await client.call<{ kind: string }[]>('v1.transcript.read', { agentId: 'a1' })
    const t2 = await client.call<{ kind: string }[]>('v1.transcript.read', { agentId: 'a2' })
    // 过程事实穿插（thinking/exec）：a1 委派轮、a2 执行轮各带思考记录
    expect(t1.map((r) => r.kind)).toEqual(['user', 'thinking', 'a2a-out', 'thinking', 'agent'])
    expect(t2.map((r) => r.kind)).toEqual(['a2a-in', 'thinking', 'exec', 'thinking', 'agent'])

    const boxes = await client.call<{ boxId: string }[]>('v1.boxes.list')
    expect(boxes.map((b) => b.boxId)).toEqual(['box-1', 'box-2'])

    const types = events.map((e) => e.type)
    expect(types).toContain('v1.message.user')
    expect(types).toContain('v1.message.a2a')
    expect(types.filter((t) => t === 'v1.message.agent').length).toBe(2)
    expect(types.filter((t) => t === 'v1.box.exec').length).toBe(2)
    // 事件 seq 单调
    const seqs = events.map((e) => e.seq)
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
  })

  it('幂等重发：同 nonce 经 transport 重试零双发', async () => {
    const kernel = makeKernel()
    const client = kernel.transport.createClient()
    await kernel.addAgent({
      agentId: 'a1',
      llm: new MockChatProvider({ steps: [{ text: '收到' }] }),
    })
    const first = await client.call<{ messageId: string; first: boolean }>('v1.message.sendUser', {
      toAgentId: 'a1',
      text: '你好',
      nonce: 'n1',
    })
    const retry = await client.call<{ messageId: string; first: boolean }>('v1.message.sendUser', {
      toAgentId: 'a1',
      text: '你好',
      nonce: 'n1',
    })
    expect(first.first).toBe(true)
    expect(retry).toEqual({ messageId: first.messageId, runId: retry.runId, first: false })
    await waitIdle(kernel)
    const records = await client.call<{ kind: string }[]>('v1.transcript.read', { agentId: 'a1' })
    expect(records.map((r) => r.kind)).toEqual(['user', 'thinking', 'agent'])
  })
})

describe('assembleKernel 组织模型命令', () => {
  it('steward 任命/罢免走命令与事件；在位再任命如实拒绝', async () => {
    const kernel = makeKernel()
    const client = kernel.transport.createClient()
    const events: KernelEvent[] = []
    client.subscribe((e) => events.push(e))
    await kernel.addAgent({ agentId: 'a1', steward: true })
    await kernel.addAgent({ agentId: 'a2' })

    const steward = await client.call<{ agentId: string } | null>('v1.system.getSteward')
    expect(steward?.agentId).toBe('a1')
    await expect(
      client.call('v1.system.appointSteward', { agentId: 'a2' }),
    ).rejects.toMatchObject({ code: 'STATE_STEWARD_EXISTS' })
    const dismissed = await client.call<{ role: string }>('v1.system.dismissSteward', { agentId: 'a1' })
    expect(dismissed.role).toBe('worker')
    const appointed = await client.call<{ role: string }>('v1.system.appointSteward', { agentId: 'a2' })
    expect(appointed.role).toBe('steward')

    const roster = events.filter((e) => e.type === 'v1.system.roster').map((e) => e.payload)
    expect(roster).toEqual([
      { agentId: 'a1', role: 'worker', cause: 'registered' },
      { agentId: 'a1', role: 'steward', cause: 'appointed' },
      { agentId: 'a2', role: 'worker', cause: 'registered' },
      { agentId: 'a1', role: 'worker', cause: 'dismissed' },
      { agentId: 'a2', role: 'steward', cause: 'appointed' },
    ])
  })

  it('listAgents 返回项带专属 Box 归属（注册即创建的领域事实）', async () => {
    const kernel = makeKernel()
    const client = kernel.transport.createClient()
    await kernel.addAgent({ agentId: 'a1', steward: true })
    await kernel.addAgent({ agentId: 'a2' })

    const agents = await client.call<Array<{ agentId: string; role: string; boxId: string | null }>>(
      'v1.system.listAgents',
    )
    expect(agents.map((a) => a.agentId).sort()).toEqual(['a1', 'a2'])
    for (const agent of agents) {
      // 注册即 create：归属必然存在且各 agent 独立（ctx 任意时刻接管的信号源）
      expect(agent.boxId).toMatch(/^box-/)
      expect(agents.filter((a) => a.boxId === agent.boxId)).toHaveLength(1)
    }
  })

  it('身份色透传（P4 Step 5）：addAgent 带 color 落档案；缺席不出现字段（读取端兼容）', async () => {
    const kernel = makeKernel()
    const client = kernel.transport.createClient()
    await kernel.addAgent({ agentId: 'colored', name: '欧米伽', color: '#199e70' })
    await kernel.addAgent({ agentId: 'plain', name: '无色者' })

    const agents = await client.call<Array<{ agentId: string; color?: string }>>('v1.system.listAgents')
    expect(agents.find((a) => a.agentId === 'colored')?.color).toBe('#199e70')
    expect(agents.find((a) => a.agentId === 'plain')?.color).toBeUndefined()
    // 任命等角色变更保留档案色（profile 全量落盘）
    await kernel.agentStore.appointSteward('colored')
    expect((await kernel.agentStore.get('colored'))?.color).toBe('#199e70')
  })

  it('未知 agent 命令：STATE_AGENT_NOT_FOUND 按 code 透传', async () => {
    const kernel = makeKernel()
    const client = kernel.transport.createClient()
    await expect(
      client.call('v1.message.sendUser', { toAgentId: 'ghost', text: 'x', nonce: 'n' }),
    ).rejects.toMatchObject({ code: 'STATE_AGENT_NOT_FOUND' })
    await expect(client.call('v1.scheduler.stats', { agentId: 'ghost' })).rejects.toMatchObject({
      code: 'STATE_AGENT_NOT_FOUND',
    })
  })
})

describe('assembleKernel Box 命令', () => {
  it('v1.boxes.snapshot：mock 后端返回快照 id；不存在的 Box 按 code 拒绝', async () => {
    const kernel = makeKernel()
    const client = kernel.transport.createClient()
    await kernel.addAgent({ agentId: 'a1' })
    const boxes = await client.call<{ boxId: string }[]>('v1.boxes.list')
    const snap = await client.call<{ boxId: string; snapshotId: string }>('v1.boxes.snapshot', {
      boxId: boxes[0]!.boxId,
    })
    expect(snap.boxId).toBe(boxes[0]!.boxId)
    expect(snap.snapshotId).toMatch(/^snap-\d+$/)
    await expect(client.call('v1.boxes.snapshot', { boxId: 'ghost' })).rejects.toMatchObject({
      code: 'BOX_NOT_FOUND',
    })
  })

  it('v1.boxes.pause/resume（P4 Step 8）：状态经 v1.box.state 事件下发（零新事件族）+ list 反映', async () => {
    const kernel = makeKernel()
    const client = kernel.transport.createClient()
    const events: KernelEvent[] = []
    client.subscribe((e) => events.push(e))
    await kernel.addAgent({ agentId: 'a1' })
    const boxId = (await client.call<{ boxId: string }[]>('v1.boxes.list'))[0]!.boxId

    const paused = await client.call<{ boxId: string; state: string }>('v1.boxes.pause', { boxId })
    expect(paused.state).toBe('sleeping')
    const resumed = await client.call<{ boxId: string; state: string }>('v1.boxes.resume', { boxId })
    expect(resumed.state).toBe('active')

    // 复用既有 v1.box.state 事件族（协议零新增）
    const states = events.filter((e) => e.type === 'v1.box.state').map((e) => e.payload)
    expect(states).toContainEqual({ boxId, state: 'sleeping' })
    expect(states).toContainEqual({ boxId, state: 'active' })
    expect((await client.call<Array<{ state: string }>>('v1.boxes.list')).find((b) => b.boxId === boxId)?.state).toBe('active')
  })

  it('v1.boxes.listSnapshots/restore（P4 Step 9）：链事实下发 + restore 前后 v1.box.state 转移（零新事件族）', async () => {
    const kernel = makeKernel()
    const client = kernel.transport.createClient()
    const events: KernelEvent[] = []
    client.subscribe((e) => events.push(e))
    await kernel.addAgent({ agentId: 'a1' })
    const boxId = (await client.call<{ boxId: string }[]>('v1.boxes.list'))[0]!.boxId
    await client.call('v1.boxes.snapshot', { boxId })
    await client.call('v1.boxes.snapshot', { boxId })

    const chain = await client.call<Array<{ snapshotId: string }>>('v1.boxes.listSnapshots')
    expect(chain.map((s) => s.snapshotId)).toEqual(['snap-2', 'snap-1'])

    events.length = 0
    const r = await client.call<{ state: string }>('v1.boxes.restore', { boxId, snapshotId: 'snap-1' })
    expect(r.state).toBe('active')
    // 回滚中不可用（sleeping 档复用）→ 完成回 active
    const states = events.filter((e) => e.type === 'v1.box.state').map((e) => e.payload)
    expect(states).toEqual([
      { boxId, state: 'sleeping' },
      { boxId, state: 'active' },
    ])
    await expect(client.call('v1.boxes.restore', { boxId, snapshotId: 'snap-99' })).rejects.toMatchObject({
      code: 'BOX_NOT_FOUND',
    })
  })

  it('caps.suspendable=false 的后端：pause 按 BOX_NOT_SUSPENDABLE 拒绝（协议层兜底——UI 按 caps 不渲染按钮）', async () => {
    // mock 本身支持休眠——此用例验证命令面门禁：caps 声明不支持即如实拒绝
    const capped = Object.assign(new MockBoxBackend(), {
      pause: undefined,
      resume: undefined,
      caps: () => ({
        persistent: true, snapshot: true, headless: true, resourceLimits: true,
        isolation: 'low' as const, interactive: true, suspendable: false,
      }),
    }) as never
    const kernel = assembleKernel({ now: () => 0, backend: capped })
    const client = kernel.transport.createClient()
    await kernel.addAgent({ agentId: 'a1' })
    const boxId = (await client.call<{ boxId: string }[]>('v1.boxes.list'))[0]!.boxId
    await expect(client.call('v1.boxes.pause', { boxId })).rejects.toMatchObject({
      code: 'BOX_NOT_SUSPENDABLE',
    })
  })
})

describe('assembleKernel 用户中止（打断工作中的 agent）', () => {
  it('审批挂起中取消：run 以 aborted 结算、未决审批按 denied 落账（resolved 事件收敛 UI 卡）', async () => {
    // 桌面同款 ManualApprovalGate（挂起式）——审批死锁路径的真实装配
    let gateRef: import('@openbot/runner').ManualApprovalGate | null = null
    const kernel = assembleKernel({
      now: () => 0,
      bootPrefix: 't',
      approvalGateFactory: (deps) => {
        gateRef = new ManualApprovalGate(deps)
        return gateRef
      },
    })
    const client = kernel.transport.createClient()
    const events: KernelEvent[] = []
    client.subscribe((e) => events.push(e))
    await kernel.addAgent({
      agentId: 'a1',
      llm: new MockChatProvider({
        steps: [
          { toolCalls: [{ id: 'c1', name: 'host_fetch', args: { url: 'https://example.com' } }] },
          { text: '不该走到终答' },
        ],
      }),
    })
    const acceptance = await client.call<{ runId: string }>('v1.message.sendUser', {
      toAgentId: 'a1',
      text: '取个网页',
      nonce: 'n-abort-1',
    })
    // 等审批挂起出现（run 卡在 gate.request 的死锁窗口——本次修复的目标场景）
    for (let i = 0; i < 200 && gateRef!.pending().length === 0; i++) {
      await new Promise<void>((r) => setTimeout(r, 5))
    }
    expect(gateRef!.pending()).toHaveLength(1)

    expect(await client.call<{ ok: boolean }>('v1.scheduler.cancel', { agentId: 'a1', runId: acceptance.runId })).toEqual({ ok: true })
    await waitIdle(kernel)

    const finished = events.find((e) => e.type === 'v1.lifecycle.finished')
    expect(finished?.payload).toMatchObject({ state: 'aborted', code: 'RUN_CANCELLED' })
    // 未决审批随 run 中止被否决：resolved(denied) 事件发出（UI 卡收敛）、账本落定
    const resolved = events.find((e) => e.type === 'v1.approval.resolved')
    expect(resolved?.payload).toMatchObject({ decision: 'denied' })
    expect(gateRef!.pending()).toHaveLength(0)
    // 终答不发生（llm 第二步未消费）
    expect(events.filter((e) => e.type === 'v1.message.agent')).toHaveLength(0)
  })

  it('取消不存在/已结算的 run：SCHED_RUN_NOT_CANCELLABLE 按 code 拒绝', async () => {
    const kernel = makeKernel()
    const client = kernel.transport.createClient()
    await kernel.addAgent({ agentId: 'a1' })
    await expect(
      client.call('v1.scheduler.cancel', { agentId: 'a1', runId: 'ghost-run' }),
    ).rejects.toMatchObject({ code: 'SCHED_RUN_NOT_CANCELLABLE' })
  })
})

describe('InProcessCarrier（部署开关缝）', () => {
  it('start/stop 生命周期 + request/subscribe 透传', async () => {
    const kernel = makeKernel()
    const carrier = new InProcessCarrier(kernel)
    await carrier.start()
    const seen: string[] = []
    const off = carrier.subscribeEvents((e) => seen.push(e.type))
    expect(await carrier.request<{ pong: boolean }>('v1.system.ping')).toEqual({ pong: true })
    off()
    await carrier.stop()
    expect(kernel.transport.has('v1.system.ping')).toBe(true)
  })
})
