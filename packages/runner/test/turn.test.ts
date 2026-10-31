import { describe, expect, it } from 'vitest'
import { AgentScheduler, EventBus, KernelError } from '@openbot/core'
import type { KernelEvent, RunExecutor } from '@openbot/core'
import { IdempotencyLedger, InMemoryFs, TranscriptStore } from '@openbot/state'
import { A2aService, BroadcastService, GroupService } from '@openbot/messaging'
import { MockChatProvider } from '@openbot/llm'
import type { MockStep } from '@openbot/llm'
import { MockBoxBackend } from '@openbot/boxes'
import type { ExecResult, ExecSpec } from '@openbot/boxes'
import type { Tool } from '../src/index.js'
import {
  AutoApprovalGate,
  execTool,
  gated,
  hostFetchTool,
  sendMessageTool,
  sendBroadcastTool,
  StaticApprovalGate,
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
  /** 审批闸门注入（预算打穿问用户——批准续期/拒绝收尾的编排位） */
  gate?: import('../src/index.js').ApprovalGate
  /** 额外工具注入（P8-4 截图分流测试：返回含图 ToolResult 的自定义工具） */
  extraTool?: import('../src/index.js').Tool
  /** 每 agent 视觉能力（截图回喂分流——缺席=有视觉） */
  supportsImagesOf?: (agentId: string) => boolean
  /** 身份元信息（2026-10-18 身份修复）：群轮 prompt 注入自称与名单；缺席回落 agentId */
  agentMetaOf?: (agentId: string) => { name: string; persona?: string } | undefined
  /** 附件本体读取（v0.1.113 附件注入测试：内存 Map 或函数注入） */
  loadAttachment?: (meta: { path: string; mime: string }) => Promise<{ base64: string; text?: string } | null>
  /** 附件注入预算（v0.1.113：缺省 128k 档） */
  attachmentBudgetOf?: (agentId: string) => number
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
  // 广播（P5 Step 2）：steward 集合由测试标记（扇出权事实）——工具面与内核同一校验路径
  const stewards = new Set<string>()
  const broadcast = new BroadcastService({
    a2a: messaging,
    isSteward: async (agentId) => stewards.has(agentId),
    assertAgent: (agentId) => {
      if (!schedulers.has(agentId)) throw new KernelError('STATE_AGENT_NOT_FOUND', `未注册 agent：${agentId}`)
    },
  })

  const gate = new AutoApprovalGate({ bus, ledger, now: () => t, nextApprovalId: () => `appr-${++approvalCounter}` })
  // 群聊编排（P5 Step 3）：真 transcript/ledger/schedulerOf——群 turn 经 run.kind 'group' 回到本 runner
  const groups = new GroupService({
    bus,
    now: () => t,
    nextMessageId: () => `msg-${++msgCounter}`,
    transcript,
    ledger,
    fs,
    root: 'data',
    schedulerOf: (agentId) => {
      const s = schedulers.get(agentId)
      if (!s) throw new KernelError('STATE_AGENT_NOT_FOUND', `未注册 agent：${agentId}`)
      return s
    },
  })
  const tools = new ToolRegistry()
    .register(execTool({ backend, bus, onStream: options.onStream, transcript }))
    .register(sendMessageTool(messaging))
    .register(sendBroadcastTool(broadcast))
    .register(gated(hostFetchTool(), { gate }))
  if (options.extraTool) tools.register(options.extraTool)

  const runner = new TurnRunner({
    bus,
    transcript,
    now: () => t, // 与 harness transcript 同源 mock 时钟（v0.1.113 startedAt 量纲一致）
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
    gate: options.gate,
    onStream: options.onStream,
    ...(options.supportsImagesOf !== undefined ? { supportsImagesOf: options.supportsImagesOf } : {}),
    ...(options.agentMetaOf !== undefined ? { agentMetaOf: options.agentMetaOf } : {}),
    ...(options.loadAttachment !== undefined ? { loadAttachment: options.loadAttachment } : {}),
    ...(options.attachmentBudgetOf !== undefined ? { attachmentBudgetOf: options.attachmentBudgetOf } : {}),
    // 与 assemble 同构（P5 Step 4 修复）：supersede 旧轮终答写入前拦截
    isGroupTurnStale: (p) => groups.isStale(p),
  })
  executeRef.current = runner.execute

  return {
    bus,
    events,
    transcript,
    backend,
    llms,
    stewards,
    register: async (agentId: string) => {
      schedulers.set(agentId, makeScheduler(agentId))
      boxes.set(agentId, await backend.create({ image: 'default' }))
      return schedulers.get(agentId)!
    },
    messaging,
    groups,
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
        { text: '先查一下版本', reasoning: '用户要装环境，先确认版本。', toolCalls: [{ id: 'c1', name: 'exec', args: { command: ['node', '-v'] } }] },
        { text: '装好了' },
      ],
    })
    const a1 = await h.register('a1')
    await h.messaging.sendUserMessage({ toAgentId: 'a1', text: '装环境', nonce: 'n1' })
    await waitIdle([a1])

    const records = await h.transcript.readAll('a1')
    expect(records.map((r) => r.kind)).toEqual(['user', 'thinking', 'exec', 'thinking', 'agent'])
    expect(records[1]?.payload).toMatchObject({ round: 1, text: '用户要装环境，先确认版本。', final: false }) // v0.1.48：thinking 存真思考（reasoning 聚合）
    expect(records[2]?.payload).toMatchObject({
      command: ['node', '-v'],
      exitCode: 0,
      stdout: 'mock: node -v',
      stderr: '',
    })
    expect(records[3]?.payload).toMatchObject({ round: 2, text: '', final: true }) // v0.1.48：终答文本的家在 agent 消息
  })

  it('过程事实截断：超长思考与输出加尾标（诚实标记不静默丢）', async () => {
    const h = makeHarness({ a1: [{ text: '终答', reasoning: 'x'.repeat(20_000) }] })
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
    const recs2 = await h.transcript.readAll('a1')
    expect(recs2.find((r) => r.kind === 'agent')?.payload).toMatchObject({ text: '换了个办法' })
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

  it('工具轮次预算耗尽：收尾轮强制文本交代（终答投递）+ run 仍 failed/RUN_TOOL_BUDGET_EXCEEDED', async () => {
    const loopStep: MockStep = { toolCalls: [{ id: 'c', name: 'exec', args: { command: ['ls'] } }] }
    // 4 步剧本：前 3 次 chat 全要工具（round 1..3，预算 2 在 round 3 打穿）→ 第 4 次 chat 是收尾轮
    const h = makeHarness(
      { a1: [loopStep, loopStep, loopStep, { text: '已列出目录但任务未完成：预算用完了' }] },
      { maxToolRounds: 2 },
    )
    const a1 = await h.register('a1')
    await h.messaging.sendUserMessage({ toAgentId: 'a1', text: '循环', nonce: 'n1' })
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
    expect(a1.isIdle).toBe(true)
    const finished = h.events.find((e) => e.type === 'v1.lifecycle.finished')
    expect(finished?.payload).toMatchObject({ state: 'failed', code: 'RUN_TOOL_BUDGET_EXCEEDED' })
    // 收尾终答进会话（用户拿到解释——2026-09-06 报障的根治）
    const finalMsg = h.events.find((e) => e.type === 'v1.message.agent')
    expect(finalMsg?.payload).toMatchObject({ agentId: 'a1', text: '已列出目录但任务未完成：预算用完了' })
    // 收尾轮禁用工具（tools 空数组进 wire——模型物理上无法继续调工具）
    const wrapupReq = h.llms.get('a1')!.requests.at(-1)!
    expect(wrapupReq.tools).toEqual([])
    expect(JSON.stringify(wrapupReq.messages)).toContain('预算')
    // transcript：轮 3 的工具未执行（预算检查在执行前）——爆点后追加收尾 thinking + agent 终答
    expect((await h.transcript.readAll('a1')).map((r) => r.kind)).toEqual([
      'user',
      'thinking',
      'exec',
      'thinking',
      'exec',
      'thinking',
      'thinking',
      'agent',
    ])
  })

  it('预算预警：最后可用轮的工具结果后注入收尾提示（软着陆——引导模型主动总结）', async () => {
    const h = makeHarness(
      {
        a1: [
          { toolCalls: [{ id: 'c1', name: 'exec', args: { command: ['ls'] } }] },
          { text: '只做了一步，直接总结' },
        ],
      },
      { maxToolRounds: 1 },
    )
    await h.register('a1')
    await h.messaging.sendUserMessage({ toAgentId: 'a1', text: '干活', nonce: 'n2' })
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
    // 第 2 次 chat（工具结果回喂后）应带预警 user 消息——引导模型在第 1 轮预算内收尾
    const secondReq = h.llms.get('a1')!.requests[1]!
    expect(secondReq.messages.some((m) => m.role === 'user' && m.content.includes('用到最后 1 轮'))).toBe(true)
  })

  it('预算打穿先问用户：批准 = 续期原地继续（上下文零损失，工具照常执行）', async () => {
    const loopStep: MockStep = { toolCalls: [{ id: 'c', name: 'exec', args: { command: ['ls'] } }] }
    // 3 步工具 + 第 4 步文本终答（预算 2——第 3 轮打穿 → 审批批准续期 → 继续执行 → 4 步终答）
    const h = makeHarness(
      { a1: [loopStep, loopStep, loopStep, { text: '续期后完成：目录已全部列出' }] },
      { maxToolRounds: 2, gate: new StaticApprovalGate(true) },
    )
    const a1 = await h.register('a1')
    await h.messaging.sendUserMessage({ toAgentId: 'a1', text: '多列几轮', nonce: 'n3' })
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
    expect(a1.isIdle).toBe(true)
    // run 成功 + 终答投递（原地继续——不是收尾交代）
    const finished = h.events.find((e) => e.type === 'v1.lifecycle.finished')
    expect(finished?.payload).toMatchObject({ state: 'succeeded' })
    expect(h.events.find((e) => e.type === 'v1.message.agent')?.payload).toMatchObject({
      text: '续期后完成：目录已全部列出',
    })
    // 3 轮工具全部执行（批准前 1 轮 + 续期后 2 轮——上下文零损失的续期语义）
    expect((await h.transcript.readAll('a1')).filter((r) => r.kind === 'exec')).toHaveLength(3)
  })

  it('预算打穿先问用户：拒绝 = 收尾轮交代（failed + 终答解释进会话）', async () => {
    const loopStep: MockStep = { toolCalls: [{ id: 'c', name: 'exec', args: { command: ['ls'] } }] }
    const h = makeHarness(
      { a1: [loopStep, loopStep, loopStep, { text: '交代：列了两轮目录，还差统计没做' }] },
      { maxToolRounds: 2, gate: new StaticApprovalGate(false) },
    )
    await h.register('a1')
    await h.messaging.sendUserMessage({ toAgentId: 'a1', text: '循环', nonce: 'n4' })
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
    const finished = h.events.find((e) => e.type === 'v1.lifecycle.finished')
    expect(finished?.payload).toMatchObject({ state: 'failed', code: 'RUN_TOOL_BUDGET_EXCEEDED' })
    // 拒绝 → 收尾终答照常投递（用户知道卡在哪）
    expect(h.events.find((e) => e.type === 'v1.message.agent')?.payload).toMatchObject({
      text: '交代：列了两轮目录，还差统计没做',
    })
    // 收尾轮禁用工具（tools=[] 进 wire）
    const wrapupReq = h.llms.get('a1')!.requests.at(-1)!
    expect(wrapupReq.tools).toEqual([])
  })

  it('AutoApprovalGate（CLI 缺省）：预算打穿自动续期继续（总时长 deadline 兜底失控）', async () => {
    const loopStep: MockStep = { toolCalls: [{ id: 'c', name: 'exec', args: { command: ['ls'] } }] }
    const h = makeHarness(
      {
        a1: [loopStep, loopStep, loopStep, loopStep, { text: '自动续期后完成' }],
      },
      {
        maxToolRounds: 2,
        gate: new AutoApprovalGate({
          bus: new EventBus({ now: () => 0 }),
          ledger: new IdempotencyLedger({ fs: new InMemoryFs(), root: 'data-auto', now: () => 0 }),
          now: () => 0,
          nextApprovalId: () => 'appr-auto-1',
        }),
      },
    )
    const a1 = await h.register('a1')
    await h.messaging.sendUserMessage({ toAgentId: 'a1', text: '连续干活', nonce: 'n5' })
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
    expect(h.events.find((e) => e.type === 'v1.lifecycle.finished')?.payload).toMatchObject({ state: 'succeeded' })
    expect((await h.transcript.readAll('a1')).filter((r) => r.kind === 'exec')).toHaveLength(4)
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

  it('send_broadcast（P5 Step 2）：steward 工具扇出全员——逐成员 a2a 事件与入信；worker 调用被内核扇出权拒绝', async () => {
    const h = makeHarness({
      st: [
        { toolCalls: [{ id: 'c1', name: 'send_broadcast', args: { toAgentIds: ['w1', 'w2'], text: '分头去做' } }] },
        { text: '已通知全员' },
      ],
      w1: [{ text: 'w1 收到' }],
      w2: [
        // worker 也尝试扇出（LLM 可调）——内核 MSG_BROADCAST_FORBIDDEN 拒绝，错误回喂后终答
        { toolCalls: [{ id: 'c9', name: 'send_broadcast', args: { toAgentIds: ['w1'], text: '我也广播' } }] },
        { text: '我不能广播' },
      ],
    })
    const st = await h.register('st')
    const w1 = await h.register('w1')
    const w2 = await h.register('w2')
    h.stewards.add('st')
    await h.messaging.sendUserMessage({ toAgentId: 'st', text: '通知大家', nonce: 'n1' })
    await waitIdle([st, w1, w2])

    // steward 扇出落达：w1/w2 各一条入信 + 两条 a2a 事件
    expect((await h.transcript.readAll('w1'))[0]?.kind).toBe('a2a-in')
    expect((await h.transcript.readAll('w2'))[0]?.kind).toBe('a2a-in')
    expect(kinds(h.events, 'v1.message.a2a')).toBe(2)
    // w2 的 worker 扇出被拒：无第三条 a2a（错误回喂后 w2 终答），w1 仍只有一条入信
    //（w1 transcript 另有自己的 thinking/agent 终答记录——只数 a2a-in）
    const w2Provider = h.llms.get('w2')!
    const w2Second = w2Provider.requests[1]?.messages ?? []
    expect(w2Second[w2Second.length - 1]?.content).toContain('worker 不能扇出')
    expect((await h.transcript.readAll('w1')).filter((r) => r.kind === 'a2a-in')).toHaveLength(1)
  })

  it('群轮转全链（P5 Step 3）：用户群消息 → 成员依序 turn → 终答写群流（私聊零污染）+ [pass] 不落', async () => {
    const h = makeHarness({
      a1: [{ text: 'a1 的群发言' }],
      a2: [{ text: '[pass]' }],
    })
    const s1 = await h.register('a1')
    const s2 = await h.register('a2')
    const group = await h.groups.createGroup({ name: '项目组', memberAgentIds: ['a1', 'a2'] })
    await h.groups.sendUserMessage({ groupId: group.groupId, text: '各自说说', nonce: 'n1' })
    await waitIdle([s1, s2])

    // 群流：建群 sys + user + a1 发言 + a2 pass 注记（2026-10-15 pass 可见化——[pass] 本身不落群流）；
    // 群轮 thinking 过程记录随终答同落群流（2026-10-18 群过程归群——成员档案零群痕迹）
    expect((await h.transcript.readAll(group.groupId)).map((r) => r.kind)).toEqual([
      'group-sys',
      'group-user',
      'thinking',
      'group-agent',
      'thinking',
      'group-sys',
    ])
    const groupRecords = await h.transcript.readAll(group.groupId)
    expect((groupRecords[5]?.payload as { text: string }).text).toBe('a2 本轮 pass')
    const agentRecord = groupRecords[3]?.payload as { from: string; text: string }
    expect(agentRecord).toMatchObject({ from: 'a1', text: 'a1 的群发言' })
    // 私聊流零污染：群里说的话不出现在 1:1 会话，过程（thinking/exec）也归群流——成员档案
    // 零群痕迹（2026-10-18 修正：此前群轮 thinking 落成员档案，重启后被投影成私聊孤儿思考卡）
    expect((await h.transcript.readAll('a1')).filter((r) => ['agent', 'thinking', 'exec'].includes(r.kind))).toHaveLength(0)
    // 事件族：group.message = sys + user + agent + a2 pass 注记（2026-10-15 pass 可见化——[pass] 本身不发）
    expect(h.events.filter((e) => e.type === 'v1.group.message')).toHaveLength(4)
    // a2 的 turn 输入：群前缀 + a1 已发言上下文（轮转传递）+ [pass] 指令
    const p2 = h.llms.get('a2')!
    const last = p2.requests[0]?.messages.at(-1)?.content ?? ''
    expect(last).toContain(`[群 ${group.groupId}`)
    expect(last).toContain('a1 的群发言')
    expect(last).toContain('[pass]')
  })

  it('群轮工具调用：exec 过程记录落群流（ToolContext.sessionKey——成员档案零群痕迹）', async () => {
    const h = makeHarness({
      a1: [
        { toolCalls: [{ id: 'c1', name: 'exec', args: { command: ['node', '-v'] } }] },
        { text: '群里执行完成' },
      ],
    })
    const a1 = await h.register('a1')
    const group = await h.groups.createGroup({ name: '工具群', memberAgentIds: ['a1'] })
    await h.groups.sendUserMessage({ groupId: group.groupId, text: '跑个命令', nonce: 'n1' })
    await waitIdle([a1])

    // 群流：exec 过程记录落群（runId 前缀仍是成员——渲染层 isGroupRun 按群终答 runId 判）
    const groupRecords = await h.transcript.readAll(group.groupId)
    const execRecord = groupRecords.find((r) => r.kind === 'exec')?.payload as { runId: string; command: string[] }
    expect(execRecord).toMatchObject({ command: ['node', '-v'] })
    expect(execRecord.runId).toMatch(/^a1-run-/)
    // 成员档案：消息与过程（thinking/exec）双零群痕迹
    expect(await h.transcript.readAll('a1')).toHaveLength(0)
  })

  it('supersede 写入拦截（P5 Step 4 修复）：旧代际 turn 终答不落群流不发事件（防线在写入点）', async () => {
    const h = makeHarness({
      a1: [{ text: '第一轮发言' }, { text: '第二轮发言' }, { text: '迟到发言不该出现' }],
    })
    const s1 = await h.register('a1')
    const group = await h.groups.createGroup({ name: 'g', memberAgentIds: ['a1'] })
    // 两条消息：gen 推进到 2（两轮发言各消费一个 step 正常落流）
    await h.groups.sendUserMessage({ groupId: group.groupId, text: '第一轮', nonce: 'n1' })
    await waitIdle([s1])
    await h.groups.sendUserMessage({ groupId: group.groupId, text: '第二轮', nonce: 'n2' })
    await waitIdle([s1])

    // 手动入队「旧代际」group run——模拟第1轮 turn 在第2条消息后才 settle 的在途时序
    // （E2E 实测抓到的缺陷路径：编排层 onSettled 拦不住先行的 transcript/事件写入）
    const ticket = s1.enqueue({
      lane: 'agent',
      kind: 'group',
      payload: {
        messageId: 'msg-stale',
        groupId: group.groupId,
        gen: 1,
        round: 1,
        text: '第一轮',
        context: [],
        mentioned: [],
      },
      summary: '旧代际在途 turn（supersede 写入拦截）',
    })
    await ticket.settled

    // 旧轮终答静默丢弃：群流 group-agent 只有各轮正常发言——「迟到发言」不落
    const texts = (await h.transcript.readAll(group.groupId))
      .filter((r) => r.kind === 'group-agent')
      .map((r) => (r.payload as { text: string }).text)
    expect(texts).toEqual(['第一轮发言', '第二轮发言'])
    // 事件族同样拦截：agent 发言事件只有两条
    const agentEvents = h.events.filter(
      (e) => e.type === 'v1.group.message' && (e.payload as { kind: string }).kind === 'agent',
    )
    expect(agentEvents).toHaveLength(2)
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

describe('截图回喂分流（P8-4 后 UI 优化）：GUI 工具注册只看环境，模型视觉只决定回喂格式', () => {
  const IMG = { base64: 'aW1n', mime: 'image/jpeg' }
  const screenshotTool = (): Tool => ({
    spec: { name: 'computer_screenshot' },
    execute: async () => ({ text: '已截图。截图 1:1', image: IMG }),
  })

  it('有视觉（缺席=视为有视觉，向后兼容）：tool 消息含 image part', async () => {
    const h = makeHarness(
      {
        a1: [
          { toolCalls: [{ id: 'c1', name: 'computer_screenshot', args: {} }] },
          { text: '看完了' },
        ],
      },
      { extraTool: screenshotTool() },
    )
    const a1 = await h.register('a1')
    await h.messaging.sendUserMessage({ toAgentId: 'a1', text: '截图', nonce: 'n1' })
    await waitIdle([a1])
    const toolMsg = h.llms.get('a1')!.requests[1].messages.find((m) => m.role === 'tool') // 工具结果在第二轮 chat 的 messages 里
    expect(toolMsg?.content).toEqual([
      { type: 'text', text: '已截图。截图 1:1' },
      { type: 'image', image: IMG },
    ])
  })

  it('无视觉（supportsImagesOf=false）：image part 降级为文本说明（部分端点对 image part 会 400）', async () => {
    const h = makeHarness(
      {
        a1: [
          { toolCalls: [{ id: 'c1', name: 'computer_screenshot', args: {} }] },
          { text: '拍好了' },
        ],
      },
      { extraTool: screenshotTool(), supportsImagesOf: () => false },
    )
    const a1 = await h.register('a1')
    await h.messaging.sendUserMessage({ toAgentId: 'a1', text: '截图', nonce: 'n1' })
    await waitIdle([a1])
    const toolMsg = h.llms.get('a1')!.requests[1].messages.find((m) => m.role === 'tool') // 工具结果在第二轮 chat 的 messages 里
    expect(typeof toolMsg?.content).toBe('string')
    expect(toolMsg?.content as string).toContain('已截图。截图 1:1')
    expect(toolMsg?.content as string).toContain('无视觉能力')
    expect(JSON.stringify(toolMsg?.content)).not.toContain('"type":"image"')
  })
})

describe('群聊身份与独立作答（2026-10-18：身份修复 + #讨论 模式）', () => {
  const meta = {
    a1: { name: '欧米茄', persona: '团队的研究员' },
    a2: { name: '阿尔法' },
  }

  it('独立作答全链：#讨论 前缀 → 全员作答落群流、prompt 无「本轮已发言」、带独立注解与身份行', async () => {
    const h = makeHarness(
      {
        a1: [{ text: '欧米茄的独立观点' }],
        a2: [{ text: '阿尔法的独立观点' }],
      },
      { agentMetaOf: (id) => meta[id as keyof typeof meta] },
    )
    const a1 = await h.register('a1')
    const a2 = await h.register('a2')
    const group = await h.groups.createGroup({ name: '评审组', memberAgentIds: ['a1', 'a2'] })
    await h.groups.sendUserMessage({ groupId: group.groupId, text: '#讨论 各自说说看法', nonce: 'n1' })
    await waitIdle([a1, a2])

    // 两员均落群流（各一次）
    const texts = (await h.transcript.readAll(group.groupId))
      .filter((r) => r.kind === 'group-agent')
      .map((r) => (r.payload as { text: string }).text)
      .sort()
    expect(texts).toEqual(['欧米茄的独立观点', '阿尔法的独立观点'])

    // prompt 实证：身份行 + 成员名单 + 独立注解；无「本轮已发言」（互不可见）
    const prompts = [...h.llms.get('a1')!.requests, ...h.llms.get('a2')!.requests]
      .map((r) => r.messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n'))
      .filter((c) => c.includes('各自说说看法'))
    expect(prompts).toHaveLength(2)
    for (const content of prompts) {
      expect(content).toContain('你是本群成员「')
      expect(content).toContain('本群成员：欧米茄、阿尔法')
      expect(content).toContain('独立作答')
      expect(content).not.toContain('本轮已发言')
    }
    // 欧米茄的 prompt 带自身 persona；阿尔法无 persona 只带名字
    const omega = prompts.find((c) => c.includes('（团队的研究员）'))
    expect(omega).toBeDefined()
    // 前缀剥离：group-user 文本不带 #讨论
    const userRec = (await h.transcript.readAll(group.groupId)).find((r) => r.kind === 'group-user')
    expect((userRec?.payload as { text: string; mode?: string })).toMatchObject({ text: '各自说说看法', mode: 'independent' })
  })

  it('轮转模式（缺省）：上下文传递保留，身份行同样在场', async () => {
    const h = makeHarness(
      { a1: [{ text: '先说' }], a2: [{ text: '后说' }] },
      { agentMetaOf: (id) => meta[id as keyof typeof meta] },
    )
    const a1 = await h.register('a1')
    const a2 = await h.register('a2')
    const group = await h.groups.createGroup({ name: 'g', memberAgentIds: ['a1', 'a2'] })
    await h.groups.sendUserMessage({ groupId: group.groupId, text: '按顺序说', nonce: 'n1' })
    await waitIdle([a1, a2])

    const a2Prompt = h.llms.get('a2')!.requests[0]?.messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n') ?? ''
    expect(a2Prompt).toContain('本轮已发言：\na1：先说') // 轮转上下文保留（与独立模式对照）
    expect(a2Prompt).toContain('你是本群成员「阿尔法」')
  })
})

describe('附件注入（v0.1.113 预算双语双计 + 大文件预览）', () => {
  const zh = (n: number): string => '汉'.repeat(n) // n 汉字（UTF-8 3 字节/字）
  const att = (id: string, name: string, size: number) => [{ id, name, mime: 'text/csv', size, path: `/tmp/${id}.csv` }]
  const userPrompt = (h: ReturnType<typeof makeHarness>): string => {
    const m = h.llms.get('a1')!.requests[0]?.messages[1]
    return typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content)
  }

  it('小文件（估算 ≤ 预算/4）全文注入——1000 汉字 est=1260 < 89600/4', async () => {
    const h = makeHarness({ a1: [{ text: '收到' }] }, { loadAttachment: async () => ({ base64: '', text: zh(1000) }) })
    const a1 = await h.register('a1')
    await h.messaging.sendUserMessage({ toAgentId: 'a1', text: '看文件', nonce: 'n1', attachments: att('x1', '小.csv', 3000) })
    await waitIdle([a1])
    expect(userPrompt(h)).toContain(zh(1000))
  })

  it('中文大文件（字节项主导：100k 汉字 est≈126k）→ 头部预览 + 分块索引 + 读取指引，不注全文', async () => {
    const h = makeHarness(
      { a1: [{ text: '收到' }] },
      { loadAttachment: async () => ({ base64: '', text: zh(100_000) }) },
    )
    const a1 = await h.register('a1')
    await h.messaging.sendUserMessage({ toAgentId: 'a1', text: '看文件', nonce: 'n1', attachments: att('big', '大.csv', 300_000) })
    await waitIdle([a1])
    const p = userPrompt(h)
    expect(p).toContain('超出全文注入档')
    expect(p).toContain('[取全文]')
    expect(p).toContain('块 1（字符 1-4000）')
    expect(p).toContain('sed -n')
    expect(p).toContain(zh(2000)) // 头部 2000 字符在场
    expect(p).not.toContain(zh(2001)) // 第 2001 字起不在（全文未注入）
  })

  it('英文长文件同口径（字符项主导：100k 字符 est=50k）→ 同样转预览（口径统一按估算 token）', async () => {
    const h = makeHarness(
      { a1: [{ text: '收到' }] },
      { loadAttachment: async () => ({ base64: '', text: 'a'.repeat(100_000) }) },
    )
    const a1 = await h.register('a1')
    await h.messaging.sendUserMessage({ toAgentId: 'a1', text: '看文件', nonce: 'n1', attachments: att('en', 'big.txt', 100_000) })
    await waitIdle([a1])
    expect(userPrompt(h)).toContain('超出全文注入档')
  })

  it('预算尽 → 预览兜底（attachmentBudgetOf 注入小预算：300 汉字 est≈378 > 1000/4）', async () => {
    const h = makeHarness(
      { a1: [{ text: '收到' }] },
      { attachmentBudgetOf: () => 1000, loadAttachment: async () => ({ base64: '', text: zh(300) }) },
    )
    const a1 = await h.register('a1')
    await h.messaging.sendUserMessage({ toAgentId: 'a1', text: '看文件', nonce: 'n1', attachments: att('y1', '中.csv', 900) })
    await waitIdle([a1])
    const p = userPrompt(h)
    expect(p).toContain('超出全文注入档')
    expect(p).toContain(zh(300)) // 预览头部含全文（300 < 头部 2000 上限）
  })

  it('多附件：全文件扣减预算后，后续超档文件转预览', async () => {
    const texts = new Map([['/tmp/m1.csv', zh(1000)], ['/tmp/m2.csv', zh(100_000)]])
    const h = makeHarness(
      { a1: [{ text: '收到' }] },
      {
        loadAttachment: async ({ path }) => ({ base64: '', text: texts.get(path) ?? '' }),
        attachmentBudgetOf: () => 89_600,
      },
    )
    const a1 = await h.register('a1')
    await h.messaging.sendUserMessage({
      toAgentId: 'a1', text: '看文件', nonce: 'n1',
      attachments: [
        { id: 'm1', name: '小.csv', mime: 'text/csv', size: 3000, path: '/tmp/m1.csv' },
        { id: 'm2', name: '大.csv', mime: 'text/csv', size: 300_000, path: '/tmp/m2.csv' },
      ],
    })
    await waitIdle([a1])
    const p = userPrompt(h)
    expect(p).toContain(zh(1000)) // 小文件全文
    expect(p).toContain('超出全文注入档') // 大文件预览
  })
})
