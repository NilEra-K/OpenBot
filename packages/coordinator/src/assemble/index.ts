/**
 * 装配根：把 core/state/llm/boxes/messaging/runner/transport 装配成可用系统。
 * 全项目唯一被允许全知的包（ARCHITECTURE.md §2 铁律 2）——业务代码不横向装配。
 * 确定性：时钟与 id 工厂在此集中供应；默认真实时钟（生产），CLI/测试注入确定性时钟。
 */
import { AgentScheduler, EventBus, KernelError } from '@openbot/core'
import type { LifecycleFinishedPayload, RunExecutor } from '@openbot/core'
import { AgentStore, IdempotencyLedger, InMemoryFs, TranscriptStore } from '@openbot/state'
import type { FsAdapter } from '@openbot/state'
import { MockChatProvider } from '@openbot/llm'
import type { ChatProvider } from '@openbot/llm'
import { BoxRegistry, BoxesErrorCodes, MockBoxBackend } from '@openbot/boxes'
import type { BoxBackend } from '@openbot/boxes'
import { A2aService, BroadcastService, GroupService } from '@openbot/messaging'
import { AutoApprovalGate, execTool, gated, hostFetchTool, sendMessageTool, sendBroadcastTool, ToolRegistry, TurnRunner } from '@openbot/runner'
import type { ApprovalGate } from '@openbot/runner'
import { InProcessTransport } from '@openbot/transport'
import { StreamHub } from '../stream-hub/index.js'
import { ShellService } from '../shell-service/index.js'
import { StatsService } from '../stats-service/index.js'
import type { DiskProbe } from '../stats-service/index.js'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'

export interface AssembleOptions {
  /** 持久化适配；默认内存（CLI 冒烟/测试），桌面装配用 NodeFs */
  fs?: FsAdapter
  /** 数据根目录，默认 'data' */
  root?: string
  /** 时钟；默认真实 Date.now()（生产）。确定性冒烟注入固定/步进时钟 */
  now?: () => number
  /** 沙箱后端；默认 mock（P3 换 wsl/docker） */
  backend?: BoxBackend
  /** 出 Box 闸门；默认 AutoApprovalGate（CLI 自动批准、账本照记） */
  approvalGate?: ApprovalGate
  /**
   * 闸门工厂：需要内核内部构件（bus/ledger）构造闸门时用（桌面 ManualApprovalGate 的
   * resolve 命令需要持有实例）。与 approvalGate 二选一，同时给出时工厂优先。
   */
  approvalGateFactory?: (deps: { bus: EventBus; ledger: IdempotencyLedger }) => ApprovalGate
  systemPrompt?: string | ((agentId: string) => string)
  maxToolRounds?: number
  /**
   * 实例前缀：跨重启的 id 唯一性（msg/run/appr id 重启后不从零重数——历史去重的正确性前提）。
   * 默认每次启动随机；确定性冒烟（CLI）注入固定值。
   */
  bootPrefix?: string
  /** StatsService 配置（Step 6）：宿主磁盘探针与压力阈值（探针由装配方注入——测量属壳） */
  stats?: {
    diskProbe?: DiskProbe
    warnBytes?: number
    criticalBytes?: number
  }
}

export interface AgentRegistration {
  agentId: string
  name?: string
  /** 身份色（hex，P4 Step 5 档案事实；缺席由渲染端回退哈希派生） */
  color?: string
  /** 该 agent 的模型客户端；未提供时用空脚本 mock（首个 turn 即显式报脚本耗尽） */
  llm?: ChatProvider
  /** 注册后立即任命为管家（走标准任命事务：他人在位时如实拒绝） */
  steward?: boolean
}

/** 装配产物：壳经 transport 拿客户端；测试/CLI 经辅助面观察与驱动 */
export interface AssembledKernel {
  readonly bus: EventBus
  readonly transport: InProcessTransport
  readonly agentStore: AgentStore
  readonly transcript: TranscriptStore
  /** 幂等账本（审批恢复扫描等观察面） */
  readonly ledger: IdempotencyLedger
  /** 实际装配的出 Box 闸门（Manual 时壳侧可拿引用注册 resolve 命令） */
  readonly approvalGate: ApprovalGate
  readonly backend: BoxBackend
  readonly registry: BoxRegistry
  readonly messaging: A2aService
  /** 广播扇出（P5 Step 1）：@全员与 @多提及同一命令——UI 只构造收件列表，扇出调度在内核 */
  readonly broadcast: BroadcastService
  /** 群聊编排（P5 Step 3）：有界轮转 + supersede（leaderless） */
  readonly groups: GroupService
  /** run 实况汇聚（壳把 gateway 的 WS 会话 attach 进来；流是实况不进事件总线） */
  readonly streamHub: StreamHub
  /** 交互式 shell 会话（PTY）管理与流分发（gateway 回调与 streamHub 并联 attach） */
  readonly shellService: ShellService
  /** Box 统计轮询与宿主磁盘压力判定（Step 6；生产经 startStats 定时驱动） */
  readonly statsService: StatsService
  readonly schedulers: ReadonlyMap<string, AgentScheduler>
  /** 注册 agent：名册 + 调度器 + 专属 Box + turn 引擎接线 */
  addAgent(registration: AgentRegistration): Promise<void>
  /** watchdog 手动驱动（测试/确定性冒烟用；生产经 startWatchdog） */
  tick(): void
  /** 启动 watchdog 定时驱动（真实时钟场景） */
  startWatchdog(intervalMs?: number): void
  stopWatchdog(): void
}

export function assembleKernel(options: AssembleOptions = {}): AssembledKernel {
  const now = options.now ?? Date.now
  const fs = options.fs ?? new InMemoryFs()
  const root = options.root ?? 'data'

  const bus = new EventBus({ now })
  const transport = new InProcessTransport({ bus })
  const agentStore = new AgentStore({ fs, root, now })
  const transcript = new TranscriptStore({ fs, root, now })
  const ledger = new IdempotencyLedger({ fs, root, now })
  const backend = options.backend ?? new MockBoxBackend({ now })
  const registry = new BoxRegistry().register(backend)

  let msgCounter = 0
  let approvalCounter = 0
  // 跨重启唯一：同进程单调 + 启动前缀隔离（重启后历史里的 msg-xxx-1 不会与新发的冲突）
  const bootPrefix = options.bootPrefix ?? randomUUID().slice(0, 8)
  const nextMessageId = (): string => `msg-${bootPrefix}-${++msgCounter}`
  const nextApprovalId = (): string => `appr-${bootPrefix}-${++approvalCounter}`

  const schedulers = new Map<string, AgentScheduler>()
  const boxes = new Map<string, string>()
  const llms = new Map<string, ChatProvider>()
  // turn 引擎延后接线（依赖 messaging/tools，而它们又依赖调度器）——holder 打破构造环
  const executeRef: { current: RunExecutor | null } = { current: null }
  let runCounter = 0

  const messaging = new A2aService({
    bus,
    now,
    nextMessageId,    transcript,
    ledger,
    schedulerOf: (agentId) => {
      const scheduler = schedulers.get(agentId)
      if (!scheduler) throw new AgentSchedulerMissingError(agentId)
      return scheduler
    },
  })

  // 广播扇出（P5 Step 1）：薄层复用单发管线（子 nonce 各自幂等）；扇出权与收件前置校验在此
  const broadcast = new BroadcastService({
    a2a: messaging,
    isSteward: async (agentId) => (await agentStore.findSteward())?.agentId === agentId,
    assertAgent: (agentId) => {
      if (!schedulers.has(agentId)) throw new AgentSchedulerMissingError(agentId)
    },
  })

  // 群聊编排（P5 Step 3）：有界轮转 + supersede；成员 turn 经 run.kind 'group' 走 TurnRunner
  const groups = new GroupService({
    bus,
    now,
    nextMessageId,
    transcript,
    ledger,
    fs,
    root,
    schedulerOf: (agentId) => {
      const scheduler = schedulers.get(agentId)
      if (!scheduler) throw new AgentSchedulerMissingError(agentId)
      return scheduler
    },
  })
  void groups.load().catch(() => {}) // 启动恢复群清单（fire-and-forget：失败=空清单如实）

  const gate: ApprovalGate =
    options.approvalGateFactory?.({ bus, ledger }) ??
    options.approvalGate ??
    new AutoApprovalGate({ bus, ledger, now, nextApprovalId })
  // run 中止的审批善后（用户主权传导）：中止即否决该 run 的未决审批——gated() 的 signal race
  // 唤醒等待方，revokeRun 把账本按 denied 落定（resolved 事件让 UI 卡收敛，重启不重放孤儿审批）
  bus.on('v1.lifecycle.finished', (event) => {
    // on 的 handler 收全量事件类型（无 per-type 重载）：显式按 payload 形状收窄
    const { state, runId } = event.payload as LifecycleFinishedPayload
    if (state === 'aborted' && gate.revokeRun) {
      void gate.revokeRun(runId).catch(() => {})
    }
  })
  // run 实况汇聚：llm 增量与 exec 输出同型汇入 hub（无 WS 订阅者时丢弃——turn 不受渲染层影响）
  const streamHub = new StreamHub()
  // 交互式 shell（PTY）：用户亲手操作，不经 run/审批/预算——与 agent exec 路线完全分离
  const shellService = new ShellService({ backend })
  // Box 统计轮询与宿主磁盘压力判定（Step 6）：盒清单读装配层映射——零子进程开销；
  // backend.list 的跨重启真相职责不变（两者分工：在册盒遥测 vs 全盘发现）
  const statsService = new StatsService({
    backend,
    bus,
    boxIds: () => [...boxes.values()],
    ...(options.stats?.diskProbe !== undefined ? { diskProbe: options.stats.diskProbe } : {}),
    ...(options.stats?.warnBytes !== undefined ? { warnBytes: options.stats.warnBytes } : {}),
    ...(options.stats?.criticalBytes !== undefined ? { criticalBytes: options.stats.criticalBytes } : {}),
  })
  const onStream = (event: Parameters<StreamHub['handle']>[0]): void => streamHub.handle(event)
  const tools = new ToolRegistry()
    .register(execTool({ backend, bus, onStream, transcript }))
    .register(sendMessageTool(messaging))
    .register(sendBroadcastTool(broadcast))
    .register(gated(hostFetchTool(), { gate }))

  const runner = new TurnRunner({
    bus,
    transcript,
    llmOf: (agentId) => llms.get(agentId) ?? new MockChatProvider({ steps: [] }),
    tools,
    boxOf: (agentId) => boxes.get(agentId) ?? null,
    nextMessageId,
    systemPrompt: options.systemPrompt,
    maxToolRounds: options.maxToolRounds,
    onStream,
    // 群轮转代际过期判定（P5 Step 4 修复）：supersede 后旧轮终答写入前拦截（GroupService 同判兜底）
    isGroupTurnStale: (p) => groups.isStale(p),
  })
  executeRef.current = runner.execute

  /** 休眠/唤醒门禁（P4 Step 8）：caps.suspendable=false 如实拒绝（协议层兜底——UI 按 caps 不渲染按钮） */
  const suspendGate = async (op: 'pause' | 'resume', boxId: string): Promise<void> => {
    const impl = op === 'pause' ? backend.pause : backend.resume
    if (!backend.caps().suspendable || impl === undefined) {
      throw new KernelError(BoxesErrorCodes.BOX_NOT_SUSPENDABLE, `后端 ${backend.id} 不支持休眠/唤醒`)
    }
    await impl.call(backend, boxId)
  }

  // ---- 命令目录（P1）：协议纯度——只有领域命令，无 UI 指令 ----
  transport
    .register('v1.system.ping', async () => ({ pong: true }))
    // 返回项带该 agent 的专属 Box 归属（addAgent 注册即 create 的领域事实；ctx 任意时刻接管的信号源）
    .register('v1.system.listAgents', async () => {
      const agents = await agentStore.list()
      return agents.map((agent) => ({ ...agent, boxId: boxes.get(agent.agentId) ?? null }))
    })
    .register('v1.system.getSteward', async () => agentStore.findSteward())
    .register('v1.system.appointSteward', async (payload) => {
      const { agentId } = payload as { agentId: string }
      const profile = await agentStore.appointSteward(agentId)
      bus.emit('v1.system.roster', { agentId, role: 'steward', cause: 'appointed' })
      return profile
    })
    .register('v1.system.dismissSteward', async (payload) => {
      const { agentId } = payload as { agentId: string }
      const profile = await agentStore.dismissSteward(agentId)
      bus.emit('v1.system.roster', { agentId, role: 'worker', cause: 'dismissed' })
      return profile
    })
    .register('v1.message.sendUser', async (payload) =>
      messaging.sendUserMessage(payload as { toAgentId: string; text: string; nonce: string }),
    )
    .register('v1.message.sendA2a', async (payload) =>
      messaging.sendA2a(
        payload as { fromAgentId: string; toAgentId: string; text: string; priority?: boolean; nonce: string },
      ),
    )
    // ---- 广播扇出（P5 Step 1）：@全员与 @多提及同一命令——UI 只构造 toAgentIds，扇出调度在内核；
    //      发起方 'user' 或在位 steward（worker 拒绝稳定码）；零新事件族（投递复用既有消息事件） ----
    .register(
      'v1.message.fanout',
      async (payload) => {
        const { from, toAgentIds, text, nonce } = fanoutSchema.parse(payload)
        return broadcast.broadcast({ from, toAgentIds, text, nonce })
      },
      fanoutSchema,
    )
    // ---- 群聊（P5 Step 3）：建群/清单/用户消息（触发有界轮转）；群历史读取复用 v1.transcript.read
    //      （群=虚拟会话对象，groupId 即键）——零新增读取命令 ----
    .register(
      'v1.group.create',
      async (payload) => {
        const { name, memberAgentIds } = groupCreateSchema.parse(payload)
        return groups.createGroup({ name, memberAgentIds })
      },
      groupCreateSchema,
    )
    .register('v1.group.list', async () => groups.list())
    .register(
      'v1.group.send',
      async (payload) => {
        const { groupId, text, nonce } = groupSendSchema.parse(payload)
        return groups.sendUserMessage({ groupId, text, nonce })
      },
      groupSendSchema,
    )
    .register('v1.transcript.read', async (payload) =>
      transcript.readAll((payload as { agentId: string }).agentId),
    )
    .register('v1.boxes.list', async () => backend.list())
    // caps.snapshot=true 的后端才提供（UI 按 caps 渲染按钮，永不出现「有按钮但后端不支持」）
    .register('v1.boxes.snapshot', async (payload) => {
      const { boxId } = payload as { boxId: string }
      const snapshotId = await backend.snapshot(boxId)
      return { boxId, snapshotId }
    })
    // ---- 休眠/唤醒（P4 Step 8）：状态转移复用既有 v1.box.state 事件族（零新事件）——
    //      UI 的 Box 卡与 ctx 屏灰化都消费同一事件，命令面只做 caps 门禁与事实下发
    .register('v1.boxes.pause', async (payload) => {
      const { boxId } = boxIdSchema.parse(payload)
      await suspendGate('pause', boxId)
      bus.emit('v1.box.state', { boxId, state: 'sleeping' })
      return { boxId, state: 'sleeping' as const }
    }, boxIdSchema)
    .register('v1.boxes.resume', async (payload) => {
      const { boxId } = boxIdSchema.parse(payload)
      await suspendGate('resume', boxId)
      bus.emit('v1.box.state', { boxId, state: 'active' })
      return { boxId, state: 'active' as const }
    }, boxIdSchema)
    // ---- 快照链与回滚（P4 Step 9）：restore 是快照能力的延伸（caps.snapshot 门禁）；
    //      状态转移复用 v1.box.state（restoring 复用 sleeping 档=不可用，成功后 active）
    .register('v1.boxes.listSnapshots', async () => {
      if (backend.listSnapshots === undefined) {
        throw new KernelError(BoxesErrorCodes.BOX_UNSUPPORTED, `后端 ${backend.id} 不支持快照链`)
      }
      return backend.listSnapshots()
    })
    .register('v1.boxes.restore', async (payload) => {
      const { boxId, snapshotId } = restoreSchema.parse(payload)
      if (backend.restore === undefined || !backend.caps().snapshot) {
        throw new KernelError(BoxesErrorCodes.BOX_UNSUPPORTED, `后端 ${backend.id} 不支持回滚`)
      }
      bus.emit('v1.box.state', { boxId, state: 'sleeping' }) // 回滚中不可用（sleeping 档复用）
      await backend.restore(boxId, snapshotId)
      bus.emit('v1.box.state', { boxId, state: 'active' })
      return { boxId, snapshotId, state: 'active' as const }
    }, restoreSchema)
    // ---- 交互式 shell（PTY，plan-p3 Step 10）：键入走命令面（每键几字节），输出走 WS /stream ----
    .register(
      'v1.boxes.shellOpen',
      async (payload) => {
        const { boxId, cols, rows } = shellOpenSchema.parse(payload)
        return shellService.open(boxId, { ...(cols !== undefined ? { cols } : {}), ...(rows !== undefined ? { rows } : {}) })
      },
      shellOpenSchema,
    )
    .register(
      'v1.boxes.shellWrite',
      async (payload) => {
        const { shellId, data } = shellWriteSchema.parse(payload)
        shellService.write(shellId, data)
        return { ok: true }
      },
      shellWriteSchema,
    )
    .register(
      'v1.boxes.shellClose',
      async (payload) => {
        const { shellId } = shellIdSchema.parse(payload)
        shellService.close(shellId)
        return { ok: true }
      },
      shellIdSchema,
    )
    .register('v1.scheduler.stats', async (payload) => {
      const scheduler = schedulers.get((payload as { agentId: string }).agentId)
      if (!scheduler) throw new AgentSchedulerMissingError((payload as { agentId: string }).agentId)
      return {
        activeRunId: scheduler.activeRunId,
        isIdle: scheduler.isIdle,
        queueDepths: scheduler.queueDepths(),
      }
    })
    // 用户中止（打断工作中的 agent）：排队中直接结算 aborted，活跃中经 AbortSignal 传播
    // （execute 契约要求响应 signal——llm/exec 链路均已接线）
    .register(
      'v1.scheduler.cancel',
      async (payload) => {
        const { agentId, runId } = schedulerCancelSchema.parse(payload)
        const scheduler = schedulers.get(agentId)
        if (!scheduler) throw new AgentSchedulerMissingError(agentId)
        if (!scheduler.cancel(runId)) {
          throw new KernelError('SCHED_RUN_NOT_CANCELLABLE', `run 不存在或已不可中止：${runId}`)
        }
        return { ok: true }
      },
      schedulerCancelSchema,
    )

  let watchdogTimer: ReturnType<typeof setInterval> | null = null

  return {
    bus,
    transport,
    agentStore,
    transcript,
    ledger,
    approvalGate: gate,
    backend,
    registry,
    messaging,
    broadcast,
    groups,
    streamHub,
    shellService,
    statsService,
    schedulers,
    async addAgent(registration) {
      // 重启幂等：名册已有此 agent（持久化态）则只重建内存态（调度器/Box/llm），不重复注册
      const registered = (await agentStore.list()).some((a) => a.agentId === registration.agentId)
      if (!registered) {
        await agentStore.register(registration.agentId, registration.name, registration.color)
      }
      llms.set(registration.agentId, registration.llm ?? new MockChatProvider({ steps: [] }))
      const boxId = await backend.create({ image: 'default' })
      boxes.set(registration.agentId, boxId)
      const scheduler = new AgentScheduler({
        agentId: registration.agentId,
        now,
        nextRunId: () => `${registration.agentId}-run-${bootPrefix}-${++runCounter}`,
        bus,
        execute: (run) => {
          if (!executeRef.current) {
            return Promise.reject(new AgentSchedulerMissingError(registration.agentId))
          }
          return executeRef.current(run)
        },
      })
      schedulers.set(registration.agentId, scheduler)
      bus.emit('v1.system.roster', {
        agentId: registration.agentId,
        role: 'worker',
        cause: 'registered',
      })
      bus.emit('v1.box.state', { boxId, state: 'active' })
      if (registration.steward) {
        await agentStore.appointSteward(registration.agentId)
        bus.emit('v1.system.roster', {
          agentId: registration.agentId,
          role: 'steward',
          cause: 'appointed',
        })
      }
    },
    tick() {
      for (const scheduler of schedulers.values()) scheduler.tick()
    },
    startWatchdog(intervalMs = 1_000) {
      if (watchdogTimer !== null) return
      // 定时器仅驱动 watchdog 判定，不参与任何确定性路径（测试用手动 tick）
      watchdogTimer = setInterval(() => this.tick(), intervalMs)
      watchdogTimer.unref?.()
    },
    stopWatchdog() {
      if (watchdogTimer === null) return
      clearInterval(watchdogTimer)
      watchdogTimer = null
    },
  }
}

/** 调度器缺失：装配/命令时序错误的兜底（稳定 code） */
export class AgentSchedulerMissingError extends KernelError {
  constructor(agentId: string) {
    super('STATE_AGENT_NOT_FOUND', `未注册 agent：${agentId}`)
    this.name = 'AgentSchedulerMissingError'
  }
}

// ---- shell 命令族 wire 校验（zod；与 desktop 命令面同一模式） ----

const shellOpenSchema = z.object({
  boxId: z.string().min(1),
  cols: z.number().int().positive().optional(),
  rows: z.number().int().positive().optional(),
})
const shellWriteSchema = z.object({
  shellId: z.string().min(1),
  /** 键入（含控制字符与转义序列，原样进 PTY） */
  data: z.string(),
})
const shellIdSchema = z.object({ shellId: z.string().min(1) })
const schedulerCancelSchema = z.object({ agentId: z.string().min(1), runId: z.string().min(1) })
const boxIdSchema = z.object({ boxId: z.string().min(1) })
const restoreSchema = z.object({ boxId: z.string().min(1), snapshotId: z.string().min(1) })
/** 广播扇出（P5 Step 1）：from='user' 或 agentId；收件非空（去重/排除在服务层） */
const fanoutSchema = z.object({
  from: z.string().min(1),
  toAgentIds: z.array(z.string().min(1)).min(1),
  text: z.string().min(1),
  nonce: z.string().min(1),
})
/** 群聊（P5 Step 3）：成员非空去重在服务层 */
const groupCreateSchema = z.object({
  name: z.string().min(1),
  memberAgentIds: z.array(z.string().min(1)).min(1),
})
const groupSendSchema = z.object({ groupId: z.string().min(1), text: z.string().min(1), nonce: z.string().min(1) })
