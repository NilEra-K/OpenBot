import { describe, expect, it } from 'vitest'
import { AgentScheduler, EventBus, KernelError } from '@openbot/core'
import type { KernelEvent, RunExecutor } from '@openbot/core'
import { IdempotencyLedger, InMemoryFs, TranscriptStore } from '@openbot/state'
import { A2aService } from '@openbot/messaging'
import { MockChatProvider } from '@openbot/llm'
import type { MockStep } from '@openbot/llm'
import { MockBoxBackend } from '@openbot/boxes'
import {
  AutoApprovalGate,
  execTool,
  gated,
  hostFetchTool,
  sendMessageTool,
  ToolRegistry,
  TurnRunner,
} from '../src/index.js'

interface HarnessOptions {
  maxToolRounds?: number
  boxOf?: (agentId: string) => string | null
}

function makeHarness(llmSteps: Record<string, readonly MockStep[]>, options: HarnessOptions = {}) {
  let t = 0
  let msgCounter = 0
  let runCounter = 0
  let approvalCounter = 0
  const fs = new InMemoryFs()
  const bus = new EventBus({ now: () => t })
  const events: KernelEvent[] = []
  bus.on('*', (e) => events.push(e))
  const transcript = new TranscriptStore({ fs, root: 'data', now: () => t })
  const ledger = new IdempotencyLedger({ fs, root: 'data', now: () => t })
  const llms = new Map<string, MockChatProvider>(
    Object.entries(llmSteps).map(([agentId, steps]) => [agentId, new MockChatProvider({ steps })]),
  )
  const backend = new MockBoxBackend({ now: () => t })
  const boxes = new Map<string, string>()

  const executeRef: { current: RunExecutor | null } = { current: null }
  const schedulers = new Map<string, AgentScheduler>()
  const makeScheduler = (agentId: string) =>
    new AgentScheduler({
      agentId,
      now: () => t,
      nextRunId: () => `${agentId}-run-${++runCounter}`,
      bus,
      execute: (run) => {
        if (!executeRef.current) return Promise.reject(new KernelError('RUN_INTERNAL', 'turn 引擎未装配'))
        return executeRef.current(run)
      },
    })

  const messaging = new A2aService({
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

  const gate = new AutoApprovalGate({ bus, ledger, now: () => t, nextApprovalId: () => `appr-${++approvalCounter}` })
  const tools = new ToolRegistry()
    .register(execTool({ backend, bus }))
    .register(sendMessageTool(messaging))
    .register(gated(hostFetchTool(), { gate }))

  const runner = new TurnRunner({
    bus,
    transcript,
    llmOf: (agentId) => {
      const p = llms.get(agentId)
      if (!p) throw new KernelError('LLM_FAILED', `agent 无模型：${agentId}`)
      return p
    },
    tools,
    boxOf: options.boxOf ?? ((agentId) => boxes.get(agentId) ?? null),
    nextMessageId: () => `msg-${++msgCounter}`,
    systemPrompt: '你是 OpenBot 测试 agent',
    maxToolRounds: options.maxToolRounds,
  })
  executeRef.current = runner.execute

  return {
    bus,
    events,
    transcript,
    backend,
    llms,
    register: async (agentId: string) => {
      schedulers.set(agentId, makeScheduler(agentId))
      boxes.set(agentId, await backend.create({ image: 'default' }))
      return schedulers.get(agentId)!
    },
    messaging,
  }
}

async function waitIdle(schedulers: { isIdle: boolean }[]): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (schedulers.every((s) => s.isIdle)) return
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('等待调度器空闲超时')
}

const kinds = (events: KernelEvent[], type: KernelEvent['type']): number =>
  events.filter((e) => e.type === type).length

describe('TurnRunner chat（工具循环）', () => {
  it('exec 工具：box 调用留痕、结果回喂模型、终答落 transcript 与事件', async () => {
    const h = makeHarness({
      a1: [
        { toolCalls: [{ id: 'c1', name: 'exec', args: { command: ['node', '-v'] } }] },
        { text: '装好了' },
      ],
    })
    const a1 = await h.register('a1')
    const acc = await h.messaging.sendUserMessage({ toAgentId: 'a1', text: '装环境', nonce: 'n1' })
    expect(acc.first).toBe(true)
    await waitIdle([a1])

    expect(h.backend.calls.map((c) => c.spec.command)).toEqual([['node', '-v']])
    const provider = h.llms.get('a1')!
    // 第一步：system + user；第二步：追加了 assistant(toolCalls) + tool 结果
    expect(provider.requests[0]?.messages.map((m) => m.role)).toEqual(['system', 'user'])
    expect(provider.requests[0]?.messages[1]?.content).toBe('装环境')
    const second = provider.requests[1]?.messages ?? []
    expect(second[second.length - 1]?.role).toBe('tool')
    expect(second[second.length - 1]?.content).toBe('exit=0\nmock: node -v')

    const records = await h.transcript.readAll('a1')
    expect(records.map((r) => r.kind)).toEqual(['user', 'agent'])
    expect(records[1]?.payload).toMatchObject({ text: '装好了', replyTo: acc.messageId })
    expect(kinds(h.events, 'v1.box.exec')).toBe(2) // started + finished
    expect(kinds(h.events, 'v1.message.agent')).toBe(1)
  })

  it('未知工具：错误文本回喂（turn 不崩），模型可继续终答', async () => {
    const h = makeHarness({
      a1: [
        { toolCalls: [{ id: 'c1', name: '不存在的工具', args: {} }] },
        { text: '换了个办法' },
      ],
    })
    const a1 = await h.register('a1')
    await h.messaging.sendUserMessage({ toAgentId: 'a1', text: '试试', nonce: 'n1' })
    await waitIdle([a1])
    const provider = h.llms.get('a1')!
    const second = provider.requests[1]?.messages ?? []
    expect(second[second.length - 1]?.content).toContain('错误 TOOL_NOT_FOUND')
    expect((await h.transcript.readAll('a1'))[1]?.payload).toMatchObject({ text: '换了个办法' })
  })

  it('无 Box 的 agent：in-box 工具报 TOOL_NO_BOX（回喂文本）', async () => {
    const h = makeHarness(
      {
        a1: [
          { toolCalls: [{ id: 'c1', name: 'exec', args: { command: ['ls'] } }] },
          { text: '没沙箱，作罢' },
        ],
      },
      { boxOf: () => null },
    )
    const a1 = await h.register('a1')
    await h.messaging.sendUserMessage({ toAgentId: 'a1', text: '跑一下', nonce: 'n1' })
    await waitIdle([a1])
    const provider = h.llms.get('a1')!
    const second = provider.requests[1]?.messages ?? []
    expect(second[second.length - 1]?.content).toContain('TOOL_NO_BOX')
    expect(h.backend.calls.length).toBe(0)
  })

  it('工具轮次预算耗尽：run 以 RUN_TOOL_BUDGET_EXCEEDED 失败', async () => {
    const loopStep: MockStep = { toolCalls: [{ id: 'c', name: 'exec', args: { command: ['ls'] } }] }
    const h = makeHarness({ a1: [loopStep, loopStep, loopStep] }, { maxToolRounds: 2 })
    const a1 = await h.register('a1')
    await h.messaging.sendUserMessage({ toAgentId: 'a1', text: '循环', nonce: 'n1' })
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
    expect(a1.isIdle).toBe(true)
    const finished = h.events.find((e) => e.type === 'v1.lifecycle.finished')
    expect(finished?.payload).toMatchObject({ state: 'failed', code: 'RUN_TOOL_BUDGET_EXCEEDED' })
    // 没有终答：transcript 只有 user 记录
    expect((await h.transcript.readAll('a1')).map((r) => r.kind)).toEqual(['user'])
  })
})

describe('TurnRunner A2A 链路（chat → send_message → 对端 turn → box exec）', () => {
  it('全链路：a1 转委派 a2，a2 在 Box 里执行后终答', async () => {
    const h = makeHarness({
      a1: [
        { toolCalls: [{ id: 'c1', name: 'send_message', args: { toAgentId: 'a2', text: '查一下目录' } }] },
        { text: '已让 a2 去查' },
      ],
      a2: [
        { toolCalls: [{ id: 'c1', name: 'exec', args: { command: ['ls', '/work'] } }] },
        { text: '查完了：目录是空的' },
      ],
    })
    const a1 = await h.register('a1')
    const a2 = await h.register('a2')
    await h.messaging.sendUserMessage({ toAgentId: 'a1', text: '帮我查目录', nonce: 'n1' })
    await waitIdle([a1, a2])

    // a1：user + a2a-out + agent 终答；a2：a2a-in + agent 终答
    expect((await h.transcript.readAll('a1')).map((r) => r.kind)).toEqual(['user', 'a2a-out', 'agent'])
    expect((await h.transcript.readAll('a2')).map((r) => r.kind)).toEqual(['a2a-in', 'agent'])
    // a2 的入站提示带 A2A 前缀，且在 a2 的 Box（box-2）执行
    const p2 = h.llms.get('a2')!
    expect(p2.requests[0]?.messages[1]?.content).toBe('[A2A a1] 查一下目录')
    expect(h.backend.calls[0]?.boxId).toBe('box-2')
    expect(h.backend.calls[0]?.spec.command).toEqual(['ls', '/work'])
    // 双侧终答都进入事件流
    expect(kinds(h.events, 'v1.message.agent')).toBe(2)
    expect(kinds(h.events, 'v1.message.a2a')).toBe(1)
  })

  it('host_fetch 过闸（CLI 自动批准）：审批事件对 + 桩回喂', async () => {
    const h = makeHarness({
      a1: [
        { toolCalls: [{ id: 'c1', name: 'host_fetch', args: { url: 'https://example.com' } }] },
        { text: '拿到了' },
      ],
    })
    const a1 = await h.register('a1')
    await h.messaging.sendUserMessage({ toAgentId: 'a1', text: '取个网页', nonce: 'n1' })
    await waitIdle([a1])
    expect(kinds(h.events, 'v1.approval.requested')).toBe(1)
    expect(kinds(h.events, 'v1.approval.resolved')).toBe(1)
    const provider = h.llms.get('a1')!
    const second = provider.requests[1]?.messages ?? []
    expect(second[second.length - 1]?.content).toContain('宿主网络桩')
  })
})
