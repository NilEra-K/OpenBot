import { describe, expect, it } from 'vitest'
import { MockChatProvider } from '@openbot/llm'
import type { MockStep } from '@openbot/llm'
import { MockBoxBackend } from '@openbot/boxes'
import { RoutingBoxBackend } from '@openbot/boxes'
import type { BoxBackend } from '@openbot/boxes'
import { ManualApprovalGate } from '@openbot/runner'
import { InMemoryFs } from '@openbot/state'
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

  it('transcriptRoot 独立根（v0.1.63）：会话记录落独立目录，数据根下不再有 agents/', async () => {
    const fs = new InMemoryFs()
    const kernel = assembleKernel({
      fs,
      root: 'data',
      transcriptRoot: 't-dir',
      now: () => 0,
      bootPrefix: 'tr',
      systemPrompt: '你是 OpenBot agent',
    })
    const client = kernel.transport.createClient()
    await kernel.addAgent({
      agentId: 'a1',
      llm: new MockChatProvider({ steps: [{ text: '好' }] }),
    })
    await client.call('v1.message.sendUser', { toAgentId: 'a1', text: '你好', nonce: 'tr-1' })
    await waitIdle(kernel)
    // 会话记录迁独立根（<transcriptRoot>/agents/<agentId>/transcript.jsonl——保持同构布局）；
    // 数据根的 agent 目录只剩档案（agents/<id>/ 是 profile/memory/transcript 共用布局）
    const files = Object.keys(fs.snapshot())
    expect(files).toContain('t-dir/agents/a1/transcript.jsonl')
    expect(files).toContain('data/agents/a1/profile.json')
    expect(files).not.toContain('data/agents/a1/transcript.jsonl')
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

  it('v1.message.fanout（P5 Step 1）：steward 扇出命令面全链（去重/零新事件族）+ worker 扇出权拒绝', async () => {
    const kernel = makeKernel()
    const client = kernel.transport.createClient()
    const events: KernelEvent[] = []
    client.subscribe((e) => events.push(e))
    await kernel.addAgent({ agentId: 'st', steward: true })
    await kernel.addAgent({ agentId: 'w1' })
    await kernel.addAgent({ agentId: 'w2' })

    // steward 扇出（收件含重复与 steward 自己——服务层去重 + 发起者自排除）
    const acc = await client.call<{ recipients: Array<{ agentId: string }>; first: boolean }>('v1.message.fanout', {
      from: 'st',
      toAgentIds: ['w1', 'w2', 'w1', 'st'],
      text: '分头去做',
      nonce: 'n1',
    })
    expect(acc.recipients.map((r) => r.agentId)).toEqual(['w1', 'w2'])
    expect(acc.first).toBe(true)
    await waitIdle(kernel)
    // 零新事件族：逐成员复用 v1.message.a2a
    expect(events.filter((e) => e.type === 'v1.message.a2a')).toHaveLength(2)

    // worker 发起扇出：稳定码拒绝（扇出权仅用户与 steward——§3.5）
    await expect(
      client.call('v1.message.fanout', { from: 'w1', toAgentIds: ['w2'], text: 'x', nonce: 'n2' }),
    ).rejects.toMatchObject({ code: 'MSG_BROADCAST_FORBIDDEN' })

    // zod wire 校验：空收件列表拒绝
    await expect(
      client.call('v1.message.fanout', { from: 'user', toAgentIds: [], text: 'x', nonce: 'n3' }),
    ).rejects.toThrow()
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

describe('addAgent 镜像绑定（plan-image-firstclass P8-4）：create 按 imageId 经路由后端分发', () => {
  /** 记录型替身后端（create 返回确定性 boxId——分发断言的观察面） */
  function fakeBackend(id: string): BoxBackend {
    let n = 0
    return {
      id,
      caps: () => ({ persistent: true, snapshot: false, headless: true, resourceLimits: false, isolation: 'high', interactive: true, suspendable: false }),
      create: async (spec) => `${id}-box-${++n}`,
      exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      fsRead: async () => null,
      fsWrite: async () => undefined,
      snapshot: async () => 'snap-1',
      stats: async () => ({}),
      teardown: async () => undefined,
      list: async () => [],
    }
  }

  it('绑定 agent 的 Box 落对应后端、未绑定落 fallback（互不串线）；imageId 落 profile 持久', async () => {
    const fallback = fakeBackend('fb')
    const vm = fakeBackend('vm')
    const routing = new RoutingBoxBackend({ fallback })
    routing.registerRoute('img-vm', { backend: vm })
    const kernel = assembleKernel({ backend: routing, now: () => 0, bootPrefix: 't', systemPrompt: 'x' })
    await kernel.addAgent({ agentId: 'a-default', llm: new MockChatProvider({ steps: [] }) })
    await kernel.addAgent({ agentId: 'a-vm', imageId: 'img-vm', llm: new MockChatProvider({ steps: [] }) })

    // listAgents 的 boxId 归属：未绑定 → fallback 后端；绑定 → 镜像后端（A 的 box 不在 B）
    const client = kernel.transport.createClient()
    const agents = await client.call<Array<{ agentId: string; boxId: string | null }>>('v1.system.listAgents')
    expect(agents.find((a) => a.agentId === 'a-default')?.boxId).toBe('fb-box-1')
    expect(agents.find((a) => a.agentId === 'a-vm')?.boxId).toBe('vm-box-1')
    expect(agents.find((a) => a.agentId === 'a-vm')?.imageId).toBe('img-vm') // profile 透传
    // profile 持久：agentStore 是唯一真相
    expect((await kernel.agentStore.list()).find((a) => a.agentId === 'a-vm')?.imageId).toBe('img-vm')
  })

  it('未注册的 imageId（悬空/无路由）落 fallback——不炸装配（恢复路径静默回默认语义）', async () => {
    const fallback = fakeBackend('fb')
    const routing = new RoutingBoxBackend({ fallback })
    const kernel = assembleKernel({ backend: routing, now: () => 0, bootPrefix: 't', systemPrompt: 'x' })
    await kernel.addAgent({ agentId: 'a-dangling', imageId: 'img-gone', llm: new MockChatProvider({ steps: [] }) })
    const agents = await kernel.transport.createClient().call<Array<{ agentId: string; boxId: string | null }>>('v1.system.listAgents')
    expect(agents.find((a) => a.agentId === 'a-dangling')?.boxId).toBe('fb-box-1')
  })
})

describe('会话语义（2026-10-18 /resume 列表改进：UUID + 空会话不计入 + 标题）', () => {
  /** 按请求形状分派的桩 provider（标题请求走哨兵 system——与对话请求区分，时序无关） */
  const shapeStub = (title: string, answer: string) =>
    ({
      chat: async (request: { system?: string }) => ({
        text: request.system?.includes('会话标题生成器') === true ? title : answer,
        toolCalls: [],
        meta: { model: 'stub' },
      }),
    }) as import('@openbot/llm').ChatProvider

  it('/clear 空会话 no-op：不落边界（skipped）；有消息后生成 UUID；连续 clear 只计首条', async () => {
    const kernel = makeKernel()
    const client = kernel.transport.createClient()
    await kernel.addAgent({ agentId: 'a1', llm: shapeStub('测试标题', '好的') })

    // 全新 agent：当前段为空 → skipped，零边界
    const r0 = await client.call<{ sessionId: string; skipped?: boolean }>('v1.session.clear', { agentId: 'a1' })
    expect(r0.skipped).toBe(true)
    expect(
      (await client.call<Array<{ kind: string }>>('v1.transcript.read', { agentId: 'a1' })).filter((r) => r.kind === 'session-start'),
    ).toHaveLength(0)

    // 有消息后 clear：sessionId 为 UUID
    await client.call('v1.message.sendUser', { toAgentId: 'a1', text: '帮我把项目打包', nonce: 'c1' })
    await waitIdle(kernel)
    const r1 = await client.call<{ sessionId: string; skipped?: boolean }>('v1.session.clear', { agentId: 'a1' })
    expect(r1.skipped).toBeUndefined()
    expect(r1.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)

    // 新段为空立即再 clear → skipped；边界仍只一条
    const r2 = await client.call<{ sessionId: string; skipped?: boolean }>('v1.session.clear', { agentId: 'a1' })
    expect(r2.skipped).toBe(true)
    expect(
      (await client.call<Array<{ kind: string }>>('v1.transcript.read', { agentId: 'a1' })).filter((r) => r.kind === 'session-start'),
    ).toHaveLength(1)
  })

  it('v1.session.list：空段不返回（含连续 clear 遗留）；resume 回溯后续写归旧会话；当前段恒在', async () => {
    const kernel = makeKernel()
    const client = kernel.transport.createClient()
    await kernel.addAgent({ agentId: 'a1', llm: shapeStub('测试标题', '好的') })

    await client.call('v1.message.sendUser', { toAgentId: 'a1', text: '一问', nonce: 'l1' })
    await waitIdle(kernel)
    const { sessionId: u1 } = await client.call<{ sessionId: string }>('v1.session.clear', { agentId: 'a1' })
    await client.call('v1.session.clear', { agentId: 'a1' }) // 空段 no-op（不产生条目）
    await client.call('v1.message.sendUser', { toAgentId: 'a1', text: '二问', nonce: 'l2' })
    await waitIdle(kernel)
    await client.call('v1.session.resume', { agentId: 'a1' }) // 弹栈回初始段
    await client.call('v1.message.sendUser', { toAgentId: 'a1', text: '三问', nonce: 'l3' })
    await waitIdle(kernel)

    const { sessions } = await client.call<{ sessions: Array<{ sessionId: string; messageCount: number; current: boolean; firstText: string }> }>(
      'v1.session.list',
      { agentId: 'a1' },
    )
    // 初始段（一问一答 + resume 后三问一答，current）与新会话（二问一答）各一条——无空段
    expect(sessions.map((s) => [s.sessionId, s.messageCount, s.current])).toEqual([
      ['s-0', 4, true],
      [u1, 2, false],
    ])
  })

  it('会话标题（sessionTitles）：首问后异步生成 session-title 留档，list 携带；缺省关闭零打扰', async () => {
    const kernel = assembleKernel({ now: () => 0, bootPrefix: 't', systemPrompt: 'x', sessionTitles: true })
    const client = kernel.transport.createClient()
    await kernel.addAgent({ agentId: 'a1', llm: shapeStub('打包部署小助手', '好的') })

    await client.call('v1.message.sendUser', { toAgentId: 'a1', text: '帮我把这个项目打包', nonce: 't1' })
    await waitIdle(kernel)
    // 标题是受理后 fire-and-forget：轮询留痕（失败静默——此处桩恒成功）
    let titled = false
    for (let i = 0; i < 200 && !titled; i++) {
      const records = await client.call<Array<{ kind: string; payload: unknown }>>('v1.transcript.read', { agentId: 'a1' })
      titled = records.some((r) => r.kind === 'session-title')
      if (!titled) await new Promise<void>((resolve) => setTimeout(resolve, 5))
    }
    expect(titled).toBe(true)
    const { sessions } = await client.call<{ sessions: Array<{ sessionId: string; current: boolean; title?: string }> }>(
      'v1.session.list',
      { agentId: 'a1' },
    )
    expect(sessions.find((s) => s.current)?.title).toBe('打包部署小助手')

    // 缺省关闭（makeKernel 无 sessionTitles）：同等流量零 session-title 记录
    const kernelOff = makeKernel()
    const clientOff = kernelOff.transport.createClient()
    await kernelOff.addAgent({ agentId: 'a1', llm: shapeStub('不该出现', '好的') })
    await clientOff.call('v1.message.sendUser', { toAgentId: 'a1', text: '普通一问', nonce: 't2' })
    await waitIdle(kernelOff)
    await new Promise<void>((resolve) => setTimeout(resolve, 50))
    expect(
      (await clientOff.call<Array<{ kind: string }>>('v1.transcript.read', { agentId: 'a1' })).some((r) => r.kind === 'session-title'),
    ).toBe(false)
  })
})

describe('身份分流（2026-10-18 P1 修复：全局「你是管家」致 worker 自认管家）', () => {
  it('worker 系统提示词带自身名字+persona 且不含管家词；管家沿用基础词；persona 落档案', async () => {
    const kernel = assembleKernel({ now: () => 0, bootPrefix: 't', systemPrompt: '你是 OpenBot 管家——测试基础词' })
    const client = kernel.transport.createClient()
    const w1 = new MockChatProvider({ steps: [{ text: '我是欧米茄' }] })
    const st1 = new MockChatProvider({ steps: [{ text: '我是管家' }] })
    await kernel.addAgent({ agentId: 'w1', name: '欧米茄', persona: '团队的研究员', roleName: '小红书运维', llm: w1 })
    await kernel.addAgent({ agentId: 'st1', name: '大管家', steward: true, llm: st1 })

    await client.call('v1.message.sendUser', { toAgentId: 'w1', text: '你是谁', nonce: 'id1' })
    await waitIdle(kernel)
    const w1System = w1.requests[0]?.messages[0]?.content ?? ''
    expect(w1System).toContain('「欧米茄」')
    expect(w1System).toContain('团队的研究员')
    expect(w1System).toContain('不是管家')
    expect(w1System).not.toContain('你是 OpenBot 管家——测试基础词')

    await client.call('v1.message.sendUser', { toAgentId: 'st1', text: '你是谁', nonce: 'id2' })
    await waitIdle(kernel)
    expect(st1.requests[0]?.messages[0]?.content).toBe('你是 OpenBot 管家——测试基础词')

    // persona/roleName 持久（档案真相——重启恢复路径同源）
    expect((await kernel.agentStore.get('w1'))?.persona).toBe('团队的研究员')
    expect((await kernel.agentStore.get('w1'))?.roleName).toBe('小红书运维')
    expect((await kernel.agentStore.get('st1'))?.role).toBe('steward')
  })
})
