/**
 * 装配根：把 core/state/llm/boxes/messaging/runner/transport 装配成可用系统。
 * 全项目唯一被允许全知的包（ARCHITECTURE.md §2 铁律 2）——业务代码不横向装配。
 * 确定性：时钟与 id 工厂在此集中供应；默认真实时钟（生产），CLI/测试注入确定性时钟。
 */
import { AgentScheduler, EventBus, KernelError } from '@openbot/core'
import type { RunExecutor } from '@openbot/core'
import { AgentStore, IdempotencyLedger, InMemoryFs, TranscriptStore } from '@openbot/state'
import type { FsAdapter } from '@openbot/state'
import { MockChatProvider } from '@openbot/llm'
import type { ChatProvider } from '@openbot/llm'
import { BoxRegistry, MockBoxBackend } from '@openbot/boxes'
import type { BoxBackend } from '@openbot/boxes'
import { A2aService } from '@openbot/messaging'
import { AutoApprovalGate, execTool, gated, hostFetchTool, sendMessageTool, ToolRegistry, TurnRunner } from '@openbot/runner'
import type { ApprovalGate } from '@openbot/runner'
import { InProcessTransport } from '@openbot/transport'

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
}

export interface AgentRegistration {
  agentId: string
  name?: string
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
  const nextMessageId = (): string => `msg-${++msgCounter}`
  const nextApprovalId = (): string => `appr-${++approvalCounter}`

  const schedulers = new Map<string, AgentScheduler>()
  const boxes = new Map<string, string>()
  const llms = new Map<string, ChatProvider>()
  // turn 引擎延后接线（依赖 messaging/tools，而它们又依赖调度器）——holder 打破构造环
  const executeRef: { current: RunExecutor | null } = { current: null }
  let runCounter = 0

  const messaging = new A2aService({
    bus,
    now,
    nextMessageId,
    transcript,
    ledger,
    schedulerOf: (agentId) => {
      const scheduler = schedulers.get(agentId)
      if (!scheduler) throw new AgentSchedulerMissingError(agentId)
      return scheduler
    },
  })

  const gate =
    options.approvalGateFactory?.({ bus, ledger }) ??
    options.approvalGate ??
    new AutoApprovalGate({ bus, ledger, now, nextApprovalId })
  const tools = new ToolRegistry()
    .register(execTool({ backend, bus }))
    .register(sendMessageTool(messaging))
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
  })
  executeRef.current = runner.execute

  // ---- 命令目录（P1）：协议纯度——只有领域命令，无 UI 指令 ----
  transport
    .register('v1.system.ping', async () => ({ pong: true }))
    .register('v1.system.listAgents', async () => agentStore.list())
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
    .register('v1.transcript.read', async (payload) =>
      transcript.readAll((payload as { agentId: string }).agentId),
    )
    .register('v1.boxes.list', async () => backend.list())
    .register('v1.scheduler.stats', async (payload) => {
      const scheduler = schedulers.get((payload as { agentId: string }).agentId)
      if (!scheduler) throw new AgentSchedulerMissingError((payload as { agentId: string }).agentId)
      return {
        activeRunId: scheduler.activeRunId,
        isIdle: scheduler.isIdle,
        queueDepths: scheduler.queueDepths(),
      }
    })

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
    schedulers,
    async addAgent(registration) {
      // 重启幂等：名册已有此 agent（持久化态）则只重建内存态（调度器/Box/llm），不重复注册
      const registered = (await agentStore.list()).some((a) => a.agentId === registration.agentId)
      if (!registered) {
        await agentStore.register(registration.agentId, registration.name)
      }
      llms.set(registration.agentId, registration.llm ?? new MockChatProvider({ steps: [] }))
      const boxId = await backend.create({ image: 'default' })
      boxes.set(registration.agentId, boxId)
      const scheduler = new AgentScheduler({
        agentId: registration.agentId,
        now,
        nextRunId: () => `${registration.agentId}-run-${++runCounter}`,
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
