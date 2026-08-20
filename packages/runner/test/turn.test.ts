import { describe, expect, it } from 'vitest'
import { AgentScheduler, EventBus, KernelError } from '@openbot/core'
import type { KernelEvent, RunExecutor } from '@openbot/core'
import { IdempotencyLedger, InMemoryFs, TranscriptStore } from '@openbot/state'
import { A2aService } from '@openbot/messaging'
import { MockChatProvider } from '@openbot/llm'
import type { MockStep } from '@openbot/llm'
import { MockBoxBackend } from '@openbot/boxes'
import type { ExecResult, ExecSpec } from '@openbot/boxes'
import {
  AutoApprovalGate,
  execTool,
  gated,
  hostFetchTool,
  sendMessageTool,
  ToolRegistry,
  TurnRunner,
} from '../src/index.js'
import type { RunStreamEvent } from '../src/index.js'

interface HarnessOptions {
  maxToolRounds?: number
  boxOf?: (agentId: string) => string | null
  onStream?: (event: RunStreamEvent) => void
  /** mock 后端 exec 行为注入（慢 exec 模拟子进程长跑——中止传导的编排位） */
  exec?: (boxId: string, spec: ExecSpec) => ExecResult | Promise<ExecResult>
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
  const backend = new MockBoxBackend({ now: () => t, ...(options.exec ? { exec: options.exec } : {}) })
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
    .register(execTool({ backend, bus, onStream: options.onStream, transcript }))
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
    onStream: options.onStream,
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

/** 轮询等待条件成立（异步编排窗口；超时抛错） */
async function waitUntil(cond: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`等待超时（${timeoutMs}ms）`)
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
  }
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
    // 过程事实穿插：user → thinking(轮1) → exec → thinking(轮2,终答) → agent
    expect(records.map((r) => r.kind)).toEqual(['user', 'thinking', 'exec', 'thinking', 'agent'])
    expect(records[4]?.payload).toMatchObject({ text: '装好了', replyTo: acc.messageId })
    expect(kinds(h.events, 'v1.box.exec')).toBe(2) // started + finished
    expect(kinds(h.events, 'v1.message.agent')).toBe(1)
  })

  it('过程事实：thinking（final 区分轮次）与 exec（命令/exitCode/输出）在完成点写入', async () => {
    const h = makeHarness({
      a1: [
        { text: '先查一下版本', toolCalls: [{ id: 'c1', name: 'exec', args: { command: ['node', '-v'] } }] },
        { text: '装好了' },
      ],
    })
    const a1 = await h.register('a1')
    await h.messaging.sendUserMessage({ toAgentId: 'a1', text: '装环境', nonce: 'n1' })
    await waitIdle([a1])

    const records = await h.transcript.readAll('a1')
    expect(records.map((r) => r.kind)).toEqual(['user', 'thinking', 'exec', 'thinking', 'agent'])
    expect(records[1]?.payload).toMatchObject({ round: 1, text: '先查一下版本', final: false })
    expect(records[2]?.payload).toMatchObject({
      command: ['node', '-v'],
      exitCode: 0,
      stdout: 'mock: node -v',
      stderr: '',
    })
    expect(records[3]?.payload).toMatchObject({ round: 2, text: '装好了', final: true })
  })

  it('过程事实截断：超长思考与输出加尾标（诚实标记不静默丢）', async () => {
    const h = makeHarness({ a1: [{ text: 'x'.repeat(20_000) }] })
    const a1 = await h.register('a1')
    await h.messaging.sendUserMessage({ toAgentId: 'a1', text: '说说', nonce: 'n1' })
    await waitIdle([a1])

    const think = (await h.transcript.readAll('a1')).find((r) => r.kind === 'thinking')
    const text = (think?.payload as { text: string }).text
    expect(text.endsWith('[…超长已截断]')).toBe(true)
    expect(text.length).toBeLessThanOrEqual(8_000 + '[…超长已截断]'.length + 1)
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
    expect((await h.transcript.readAll('a1'))[2]?.payload).toMatchObject({ text: '换了个办法' })
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
    // 没有终答消息；过程记录保留至预算爆点（轮 3 的 thinking 已写、工具未执行）
    expect((await h.transcript.readAll('a1')).map((r) => r.kind)).toEqual([
      'user',
      'thinking',
      'exec',
      'thinking',
      'exec',
      'thinking',
    ])
  })

  it('exec 进行中取消：后端杀命令、aborted 事实落盘、run 以 aborted/RUN_CANCELLED 结算', async () => {
    // 慢 exec（永不返回——真实后端对应子进程长跑）；cancel 后 mock 响应 signal 抛 BOX_EXEC_ABORTED
    const h = makeHarness(
      {
        a1: [
          { toolCalls: [{ id: 'c1', name: 'exec', args: { command: ['sleep', '999'] } }] },
          { text: '不该走到终答' },
        ],
      },
      { exec: () => new Promise<ExecResult>(() => {}) },
    )
    const a1 = await h.register('a1')
    await h.messaging.sendUserMessage({ toAgentId: 'a1', text: '长任务', nonce: 'n1' })
    await waitUntil(() => h.backend.calls.length === 1, 2_000) // exec 已开始（取消的活跃窗口）

    expect(a1.cancel('a1-run-1')).toBe(true)
    await waitIdle([a1])

    const finished = h.events.find((e) => e.type === 'v1.lifecycle.finished')
    expect(finished?.payload).toMatchObject({ state: 'aborted', code: 'RUN_CANCELLED' })
    // 轮间检查点：llm 第二轮不再发起（脚本第二步未消费——工具回喂后立即终止）
    expect(h.llms.get('a1')!.requests.length).toBe(1)
    // exec 的中止也是事实：transcript 落 aborted 记录（重启后呈现同样诚实）
    const execRecord = (await h.transcript.readAll('a1')).find((r) => r.kind === 'exec')
    expect(execRecord?.payload).toMatchObject({ command: ['sleep', '999'], aborted: true })
    expect((execRecord?.payload as { reason?: string }).reason).toContain('中止')
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

    // a1：user → thinking(委派轮) → a2a-out → thinking(终答轮) → agent；a2：a2a-in → thinking → exec → thinking → agent
    expect((await h.transcript.readAll('a1')).map((r) => r.kind)).toEqual(['user', 'thinking', 'a2a-out', 'thinking', 'agent'])
    expect((await h.transcript.readAll('a2')).map((r) => r.kind)).toEqual(['a2a-in', 'thinking', 'exec', 'thinking', 'agent'])
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

// ---------------------------------------------------------------------------
// run 流事件（onStream）——llm 增量与 exec 实况同型上报（流是实况、聚合是事实）
// ---------------------------------------------------------------------------

describe('TurnRunner 流事件（onStream）', () => {
  /** 归一形状（省 agentId/runId，断言关注序列与载荷） */
  const shape = (e: RunStreamEvent) => ({
    type: e.type,
    stream: e.stream,
    ...(e.meta ?? {}),
    ...(e.text !== undefined ? { text: e.text } : {}),
    ...(e.channel !== undefined ? { channel: e.channel } : {}),
    ...(e.exitCode !== undefined ? { exitCode: e.exitCode } : {}),
  })

  it('全序列：llm 轮1(工具调用,零 chunk) → exec open/chunk/end → llm 轮2 增量 → end', async () => {
    const events: RunStreamEvent[] = []
    const h = makeHarness(
      {
        a1: [
          { toolCalls: [{ id: 'c1', name: 'exec', args: { command: ['node', '-v'] } }] },
          { text: '装好了' },
        ],
      },
      { onStream: (e) => events.push(e) },
    )
    const a1 = await h.register('a1')
    await h.messaging.sendUserMessage({ toAgentId: 'a1', text: '装环境', nonce: 'n1' })
    await waitIdle([a1])

    // agentId/runId 全序列一致
    expect(events.every((e) => e.agentId === 'a1' && e.runId === 'a1-run-1')).toBe(true)
    expect(events.map(shape)).toEqual([
      { type: 'open', stream: 'llm', round: 1 },
      { type: 'end', stream: 'llm' }, // 纯工具调用轮：零 chunk，chat 返回即收流
      { type: 'open', stream: 'exec', command: ['node', '-v'], boxId: 'box-1' },
      { type: 'chunk', stream: 'exec', text: 'mock: node -v', channel: 'stdout' },
      { type: 'end', stream: 'exec', exitCode: 0 },
      { type: 'open', stream: 'llm', round: 2 },
      { type: 'chunk', stream: 'llm', text: '装好了' }, // mock 定长 3 码元拆块
      { type: 'end', stream: 'llm' },
    ])
  })

  it('llm 失败：abort 带原因（run 照常失败，流如实中止）', async () => {
    const events: RunStreamEvent[] = []
    const h = makeHarness({ a1: [{ text: '第一步' }] }, { onStream: (e) => events.push(e) })
    const a1 = await h.register('a1')
    await h.messaging.sendUserMessage({ toAgentId: 'a1', text: 'q1', nonce: 'n1' })
    await waitIdle([a1])
    // 第二次 chat 脚本耗尽 → 第二个 run 的 llm 流 open 后 abort
    await h.messaging.sendUserMessage({ toAgentId: 'a1', text: 'q2', nonce: 'n2' })
    await waitIdle([a1])
    const second = events.filter((e) => e.runId === 'a1-run-2')
    expect(second.map(shape)).toEqual([
      { type: 'open', stream: 'llm', round: 1 },
      { type: 'abort', stream: 'llm' },
    ])
    expect(second.at(-1)?.reason).toContain('脚本')
  })

  it('无 onStream：流事件不发，过程记录照写（回归）', async () => {
    const h = makeHarness({
      a1: [{ text: '直接回答' }],
    })
    const a1 = await h.register('a1')
    await h.messaging.sendUserMessage({ toAgentId: 'a1', text: 'q', nonce: 'n1' })
    await waitIdle([a1])
    const records = await h.transcript.readAll('a1')
    expect(records.map((r) => r.kind)).toEqual(['user', 'thinking', 'agent'])
  })
})
