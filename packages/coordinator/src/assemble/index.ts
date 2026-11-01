/**
 * 装配根：把 core/state/llm/boxes/messaging/runner/transport 装配成可用系统。
 * 全项目唯一被允许全知的包（ARCHITECTURE.md §2 铁律 2）——业务代码不横向装配。
 * 确定性：时钟与 id 工厂在此集中供应；默认真实时钟（生产），CLI/测试注入确定性时钟。
 */
import { AgentScheduler, EventBus, KernelError } from '@openbot/core'
import type { LifecycleFinishedPayload, RunExecutor } from '@openbot/core'
import type { ApprovalRequestedPayload, RunPolicy } from '@openbot/core'
import { AgentStore, IdempotencyLedger, InMemoryFs, TranscriptStore, formatMemoryPrompt } from '@openbot/state'
import type { AgentProfile, FsAdapter, MemoryStore } from '@openbot/state'
import { MockChatProvider } from '@openbot/llm'
import type { ChatProvider } from '@openbot/llm'
import { BoxRegistry, BoxesErrorCodes, MockBoxBackend, X11ScreenControl } from '@openbot/boxes'
import type { BoxBackend, ScreenControl } from '@openbot/boxes'
import { A2aService, BroadcastService, GroupService } from '@openbot/messaging'
import { AutoApprovalGate, computerTools, execTool, gated, hostFetchTool, recallMemoryTool, saveMemoryTool, sendMessageTool, sendBroadcastTool, ToolRegistry, TurnRunner, ATTACHMENT_BUDGET_1M, ATTACHMENT_BUDGET_128K, compactSession } from '@openbot/runner'
import type { GuiTakeoverLock, RunStreamEvent } from '@openbot/runner'
import type { ApprovalGate } from '@openbot/runner'
import { InProcessTransport } from '@openbot/transport'
import { StreamHub } from '../stream-hub/index.js'
import { ShellService } from '../shell-service/index.js'
import { GuiStreamService } from '../gui-stream/index.js'
import { StatsService } from '../stats-service/index.js'
import type { DiskProbe } from '../stats-service/index.js'
import { sessionSegments } from './session-segments.js'
import { PluginService } from '../plugins/index.js'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'

export interface AssembleOptions {
  /** 持久化适配；默认内存（CLI 冒烟/测试），桌面装配用 NodeFs */
  fs?: FsAdapter
  /** 数据根目录，默认 'data' */
  root?: string
  /**
   * 会话记录（transcript）独立根目录（v0.1.63）：缺省随 root（<root>/agents——现行为
   * 零变化）；桌面装配经 transcript-root.txt 标记注入，CLI/测试不感知
   */
  transcriptRoot?: string
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
  /**
   * 记忆存储（backlog ①）：注入即启用——注册 save/recall 工具 + systemPrompt 每轮拼
   * 「此前记忆」（读内存缓存）。缺省不启用（CLI 冒烟最小面）。
   */
  memory?: Pick<MemoryStore, 'append' | 'list' | 'listSync' | 'ensureLoaded'>
  /**
   * computer-use 工具族（plan-computer-use Step 4/5）：注入即注册 computer_* 工具族
   * （沙箱 GUI 操作）。注册门（工具集探测 ∩ provider 支持图像——P8-2 生产门）在装配方
   * 判定，可后置注册（kernel.tools + kernel.onStream 暴露面）；coordinator 只认锁与
   * ScreenControl 接口。lock.waitTurn 在每个动作前等待（用户接管挂起）。
   */
  computer?: { lock: Pick<GuiTakeoverLock, 'waitTurn'> }
  /**
   * 桌面控制适配器覆盖（plan-screen-firstclass P9-1）：缺省装配 X11 单实例（既有行为）；
   * desktop 传 ScreenControlRouter（按 boxId 分发 X11/宿主屏幕）——消费方零感知。
   */
  screen?: ScreenControl
  maxToolRounds?: number
  /** run 策略覆盖（2026-09-06 进展驱动 grace 语义）：装配方按产品形态调——desktop 上调
   *  （慢模型长轮次不被误杀），CLI/测试缺省 DEFAULT_RUN_POLICY */
  runPolicy?: Partial<RunPolicy>
  /**
   * 附件本体读取（v0.1.102 图片一期，desktop 注入——FsAdapter 只读 utf8 故走专用通道）：
   * 用户消息图片附件 → ContentPart image。缺席 = 无文件系统装配（CLI/测试）——附件一律
   * 文本降级注记（TurnRunner.loadAttachment 同语义）。
   */
  loadAttachment?: (meta: { path: string; mime: string }) => Promise<{ base64: string; text?: string; mime?: string } | null>
  /**
   * 用量采集（会话引擎 v2 · P1）：runner 每轮 chat 带 usage 则上报——desktop 落
   * data/agents/<id>/usage.jsonl（水位/密度校准数据源）。缺席 = 无文件系统（CLI/测试不采）
   */
  recordUsage?: (agentId: string, usage: { promptTokens: number; completionTokens: number }, model: string) => void
  /** agent 附图落盘（v0.1.118 截图直发）：run 最后一张净化截图随终答投递（呈现层持久） */
  saveAgentImage?: (agentId: string, image: { base64: string; mime: string }) => Promise<import('@openbot/core').AttachmentMeta | null>
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
  /**
   * 会话标题生成（2026-10-18 /resume 列表改进）：注入即启用——当前段首条用户消息后，
   * 用该 agent 的模型客户端异步生成 ≤20 字标题（session-title 记录留档；失败静默，
   * 列表回退首问截断）。缺省不启用（CLI/测试最小面——mock 步骤不被额外请求打扰）。
   */
  sessionTitles?: boolean
}

export interface AgentRegistration {
  agentId: string
  name?: string
  /** 身份色（hex，P4 Step 5 档案事实；缺席由渲染端回退哈希派生） */
  color?: string
  /** 模型覆盖档案名（backlog ③）：落 profile 持久；llm 实例由装配方按此构造（分流在 desktop） */
  modelProvider?: string
  /** 镜像绑定（plan-image-firstclass P8-4）：引用镜像条目 id——backend 按 spec.image 路由
   *  （RoutingBoxBackend）；未指定 'default' 落全局后端 */
  imageId?: string
  /** 人设（2026-10-18 身份修复）：身份描述一句话——注入系统提示词与群轮 prompt */
  persona?: string
  /** 角色档位名（2026-10-18 自定义角色）：呈现留档（权限语义在 steward 标志） */
  roleName?: string
  /** Box 数据目录单盒覆盖（2026-10-20 v0.2.0）：目录型后端落盘位置——全局默认见 settings.sandboxDataDir */
  dataDir?: string
  /** 该 agent 的模型客户端；未提供时用空脚本 mock（首个 turn 即显式报脚本耗尽） */
  llm?: ChatProvider
  /** 注册后立即任命为管家（走标准任命事务：他人在位时如实拒绝） */
  steward?: boolean
}

/** 装配产物：壳经 transport 拿客户端；测试/CLI 经辅助面观察与驱动 */
export interface AssembledKernel {
  readonly bus: EventBus
  /** 记忆存储（backlog ①；未注入 memory 选项时为 undefined——CLI 冒烟最小面） */
  readonly memory: AssembleOptions['memory']
  readonly transport: InProcessTransport
  readonly agentStore: AgentStore
  readonly transcript: TranscriptStore
  /** 工具注册表（壳侧后置注册 computer 工具族——P8-2 生产门探测需要 Box 先在场） */
  readonly tools: ToolRegistry
  /** 插件运行时（P1）：装载/启停/工具桥接/事件路由（docs/plan-plugins.md） */
  readonly plugins: PluginService
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
  /** GUI 桌面实况流（30fps mjpeg）管理与分发（gateway 回调三件套并联 attach + onStreamPause） */
  readonly guiStream: GuiStreamService
  /** 桌面控制适配器（plan-image-firstclass P8-2）：工具族/实况/gui 命令面共用的单一实例
   *  （几何缓存单源）——壳侧后置注册 computer 工具族与 gui 命令面换调都用它 */
  readonly screen: ScreenControl
  /** run 实况汇聚回调（壳侧后置注册 computer 工具族时回填同一依赖——与装配内注册同源） */
  readonly onStream: (event: RunStreamEvent) => void
  /** Box 统计轮询与宿主磁盘压力判定（Step 6；生产经 startStats 定时驱动） */
  readonly statsService: StatsService
  readonly schedulers: ReadonlyMap<string, AgentScheduler>
  /** 注册 agent：名册 + 调度器 + 专属 Box + turn 引擎接线 */
  addAgent(registration: AgentRegistration): Promise<void>
  /** 更新人设（2026-10-18）：档案持久 + 身份元信息热更（提示词即时生效） */
  setPersona(agentId: string, persona: string | null): Promise<AgentProfile>
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
  const transcript = new TranscriptStore({ fs, root: options.transcriptRoot ?? root, now })
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
  /** agent 身份元信息（2026-10-18 P1 身份修复：全局「你是管家」提示词致 worker 自认管家）：
   *  addAgent 登记（档案真相——role 从 agentStore 读，含重启恢复），任命事务经 roster 事件随动 */
  const agentMeta = new Map<string, { name: string; persona?: string; role: 'steward' | 'worker' }>()
  bus.on('v1.system.roster', (event) => {
    const payload = event.payload as { agentId: string; role?: unknown }
    const meta = agentMeta.get(payload.agentId)
    if (meta !== undefined && (payload.role === 'steward' || payload.role === 'worker')) {
      meta.role = payload.role
    }
  })
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
    // 汇总人管家优先（2026-10-18 #汇总）：agentMeta 角色注入
    roleOf: (agentId) => agentMeta.get(agentId)?.role,
    // @提及双命中面（2026-10-19）：@agentId 与 @显示名 都路由——agentMeta 名注入
    nameOf: (agentId) => agentMeta.get(agentId)?.name,
  })
  void groups.load().catch(() => {}) // 启动恢复群清单（fire-and-forget：失败=空清单如实）

  const gate: ApprovalGate =
    options.approvalGateFactory?.({ bus, ledger }) ??
    options.approvalGate ??
    new AutoApprovalGate({ bus, ledger, now, nextApprovalId })
  // 审批挂起也是「有理由的停」：请求即保鲜一次（等待起点不计入无进展）；批准后 run 继续
  // 产生流信号自然续鲜。等待超 graceMs 仍会逃逸（发送永不悬挂语义不变）——但结果迟到必达
  // （终答由 execute 内部投递），且逃逸/终态经渲染层 toast 与排程卡全量透明
  bus.on('v1.approval.requested', (event) => {
    const { agentId, runId } = event.payload as ApprovalRequestedPayload
    schedulers.get(agentId)?.touch(runId)
  })
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
  // 桌面控制适配器（plan-image-firstclass P8-2 接口化）：X11 适配器为缺省实现——display
  // 装配参数化（env OPENBOT_GUI_DISPLAY 由装配读取传入，B3；P8-3 起由镜像条目接管）；
  // P9-1 起装配方可注入 ScreenControlRouter（按 boxId 分发 X11/宿主屏幕）——消费方零感知。
  // 工具族/实况服务/gui 命令面三方共用同一实例（几何缓存单源）
  const screen =
    options.screen ??
    new X11ScreenControl({
      host: backend,
      ...(process.env.OPENBOT_GUI_DISPLAY !== undefined ? { display: process.env.OPENBOT_GUI_DISPLAY } : {}),
    })
  // GUI 桌面实况（三期双引擎）：采集经适配器（Box 内 ffmpeg 管道，帧字节直出），
  // 帧走 WS /stream 的 gui 帧型；编码引擎 env OPENBOT_GUI_CODEC 覆盖（缺省 h264——
  // x264 zerolatency + WebCodecs 硬解；'mjpeg' 回退一期路径）
  const guiStream = new GuiStreamService({
    screen,
    ...(process.env.OPENBOT_GUI_CODEC === 'mjpeg' ? { codec: 'mjpeg' as const } : {}),
  })
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
  // run 实况汇聚：llm 增量与 exec 输出同型汇入 hub（无 WS 订阅者时丢弃——turn 不受渲染层影响）
  // 双职责：同一事件流刷新调度器的无进展计时（进展驱动 grace——在动的 run 永不逃逸）
  const onStream = (event: Parameters<StreamHub['handle']>[0]): void => {
    streamHub.handle(event)
    schedulers.get(event.agentId)?.touch(event.runId)
  }
  const tools = new ToolRegistry()
    .register(execTool({ backend, bus, onStream, transcript }))
    .register(sendMessageTool(messaging))
    .register(sendBroadcastTool(broadcast))
    .register(gated(hostFetchTool(), { gate }))

  // 记忆（backlog ①）：注入即启用——save/recall 工具 + systemPrompt 每轮求值时拼「此前记忆」
  // （TurnRunner 的函数形态 systemPrompt 每 turn 同步调用——读 MemoryStore 内存缓存，
  // save_memory 落缓存后下一轮自动带上；agent 注册路径经 ensureLoaded 预载）
  const memory = options.memory
  if (memory !== undefined) {
    tools.register(saveMemoryTool({ memory })).register(recallMemoryTool({ memory }))
  }
  // computer-use 工具族（plan-computer-use）：注入即注册（生产门可后置——kernel.tools +
  // kernel.onStream 暴露面供装配方探测后注册）；只认 ScreenControl 接口（P8-2 接口化）
  if (options.computer !== undefined) {
    for (const tool of computerTools({ backend, bus, onStream, transcript, screen, lock: options.computer.lock })) {
      tools.register(tool)
    }
  }
  const basePrompt = options.systemPrompt
  // 身份分流（2026-10-18 P1 修复：此前全局一句「你是 OpenBot 管家」——worker（欧米茄/阿尔法）
  // 全部自认管家）。管家与未登记 agent 沿用基础词；worker 以自身名字+persona 开场并明确边界
  const identityPrompt = (agentId: string): string => {
    const meta = agentMeta.get(agentId)
    const base = typeof basePrompt === 'function' ? basePrompt(agentId) : basePrompt
    if (meta === undefined || meta.role === 'steward') return base ?? ''
    const persona = meta.persona !== undefined && meta.persona !== '' ? `（${meta.persona}）` : ''
    return `你是「${meta.name}」${persona}，OpenBot 团队的成员——不是管家，也不是其他成员。` +
      `始终以「${meta.name}」第一人称自称，不得自称或冒充管家及其他成员。用简洁中文回复。`
  }
  const systemPrompt: string | ((agentId: string) => string) =
    memory === undefined
      ? identityPrompt
      : (agentId: string): string => {
          const base = identityPrompt(agentId)
          const section = formatMemoryPrompt(memory.listSync(agentId))
          return section === '' ? base : `${base}\n\n${section}`
        }

  // 插件运行时（2026-10-20 P1，docs/plan-plugins.md）：manifest 装载 + MCP 桥接 + 上行事件
  // 路由。唤醒绑定 Agent 复用 messaging.sendUserMessage（幂等 nonce 同 automation 范式）
  const plugins = new PluginService({
    bus,
    tools,
    gate,
    sendUserMessage: (input) => messaging.sendUserMessage(input),
    agentIdOfName: (name) => {
      for (const [id, meta] of agentMeta) {
        if (meta.name === name) return id
      }
      return undefined
    },
    readManifest: async (pluginId) => fs.read(`${root}/plugins/${pluginId}/manifest.json`),
    pluginDirOf: (pluginId) => `${root}/plugins/${pluginId}`,
    now,
    log: (msg) => console.log(msg),
  })

  // 会话压缩（v2 · P2/P3）：Compactor 依赖（llmOf/transcript 与 runner 同源）；自动触发防重入
  const compactDeps = () => ({
    transcript,
    llmOf: (agentId: string) => llms.get(agentId) ?? new MockChatProvider({ steps: [] }),
    nextRunId: () => `compact-${++runCounter}`,
  })
  const compacting = new Set<string>() // sessionKey 防重入（自动触发并发保护）
  const runner = new TurnRunner({
    bus,
    transcript,
    // 时钟（v0.1.113 顺序修复）：与 transcript envelope at 同源——thinking startedAt 量纲一致
    now,
    // 窗口档位（会话引擎 v2 · P2）：模型 context1M 声明 → 1M；缺省 128k
    windowTokensOf: (agentId) => (llms.get(agentId)?.capabilities?.context1M === true ? 1_000_000 : 128_000),
    // 自动 compact（P3 · 默认开——用户裁定）：级③压力信号 → 异步压缩（防重入；失败静默下轮再试）
    onContextPressure: (agentId, sessionKey) => {
      if (compacting.has(sessionKey)) return
      compacting.add(sessionKey)
      void compactSession(compactDeps(), agentId, sessionKey, { trigger: 'auto' })
        .then((r) => {
          if (r !== null) {
            bus.emit('v1.session.compacted', { sessionKey, coveredSeq: r.coveredSeq, keptRounds: r.keptRecords, trigger: 'auto' })
          }
        })
        .catch(() => {})
        .finally(() => {
          compacting.delete(sessionKey)
        })
    },
    llmOf: (agentId) => llms.get(agentId) ?? new MockChatProvider({ steps: [] }),
    // 视觉能力（P8-4 后 UI 优化）：截图回喂分流——provider.capabilities.supportsImages 决定
    // 图像 part 或文本降级（未声明按有视觉处理——向后兼容）
    supportsImagesOf: (agentId) => llms.get(agentId)?.capabilities?.supportsImages === true,
    // 附件注入预算随模型窗口档位（v0.1.111 1M 勾选）：声明 1M → 1.4M 字符；缺省 128k 档
    attachmentBudgetOf: (agentId) =>
      llms.get(agentId)?.capabilities?.context1M === true ? ATTACHMENT_BUDGET_1M : ATTACHMENT_BUDGET_128K,
    // 附件本体读取（v0.1.102）：desktop 注入的文件系统通道原样透传（缺席=文本降级）
    ...(options.loadAttachment !== undefined ? { loadAttachment: options.loadAttachment } : {}),
    ...(options.recordUsage !== undefined ? { recordUsage: options.recordUsage } : {}),
    ...(options.saveAgentImage !== undefined ? { saveAgentImage: options.saveAgentImage } : {}),
    tools,
    boxOf: (agentId) => boxes.get(agentId) ?? null,
    nextMessageId,
    systemPrompt,
    // 身份元信息（2026-10-18 身份修复）：群轮 prompt 注入成员自称与同伴名单
    agentMetaOf: (agentId) => agentMeta.get(agentId),
    maxToolRounds: options.maxToolRounds,
    // 审批闸门（2026-09-06 预算打穿问用户）：复用同一授权通道——desktop 弹窗询问 /
    // CLI AutoApprovalGate 自动续期（总时长 deadline 兜底失控）
    gate,
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

  // ---- 会话标题异步生成（2026-10-18 /resume 列表改进；同日裁定改为**首答后**生成——
  //  问+答一起总结更准）：段内首条 agent 回复落地时触发一次，小请求独立于对话流（无工具无流）；
  //  session-title 记录留档。fire-and-forget——不阻塞消息流，失败静默（列表回退首问截断）
  const SESSION_TITLE_SENTINEL = '你是会话标题生成器'
  const generateSessionTitle = async (agentId: string): Promise<void> => {
    const llm = llms.get(agentId)
    if (llm === undefined) return
    const records = await transcript.readAll(agentId)
    const current = sessionSegments(records).find((s) => s.current)
    // 首答后判据：段内已有 agent 回复（firstAgentText）且未生成过标题
    if (current === undefined || current.title !== undefined || current.firstAgentText === '') return
    try {
      const response = await llm.chat({
        system:
          `${SESSION_TITLE_SENTINEL}。用不超过 20 个字概括下面这轮问答的工作主题，` +
          '直接输出标题本身——不要引号、不要句号、不要任何解释。',
        messages: [{ role: 'user', content: `用户问：${current.firstText}\n助手答：${current.firstAgentText}` }],
      })
      const title = (response.text ?? '').trim().replace(/["'「」『』。]/g, '').slice(0, 24)
      if (title === '') return
      await transcript.append(agentId, 'session-title', { sessionId: current.sessionId, title })
    } catch {
      // 标题是锦上添花：失败/超时静默（agent 的 provider 异常不该影响对话流）
    }
  }
  if (options.sessionTitles === true) {
    bus.on('v1.message.agent', (event) => {
      void generateSessionTitle((event.payload as { agentId: string }).agentId)
    })
  }

  // ---- 命令目录（P1）：协议纯度——只有领域命令，无 UI 指令 ----
  transport
    .register('v1.system.ping', async () => ({ pong: true }))
    // 返回项带该 agent 的专属 Box 归属（addAgent 注册即 create 的领域事实；ctx 任意时刻接管的信号源）
    .register('v1.system.listAgents', async () => {
      const agents = await agentStore.list()
      return agents.map((agent) => ({ ...agent, boxId: boxes.get(agent.agentId) ?? null }))
    })
    // ---- 图谱边聚合（P5 后修复：重启重建）——transcript 是 append-only 底账，此处只读聚合。
    //      计数语义与 renderer 实时 bumpEdge 逐 kind 对齐（事件等价物计数）：user 出信 +1(user→agent)、
    //      agent 终答 +1(agent→user)、a2a-out +1(from→to)（接收侧 a2a-in 是同次投递镜像不重复计）、
    //      group-user/group-agent +1(成员→群)；thinking/group-sys 非消息事件等价物不计。
    //      键空间 = agentStore ∪ 群档案（id 均服务端生成无空格——聚合键用空格拼接安全） ----
    .register('v1.graph.edges', async () => {
      const counts = new Map<string, number>()
      const bump = (from: string, to: string): void => {
        const key = `${from} ${to}`
        counts.set(key, (counts.get(key) ?? 0) + 1)
      }
      const keys = [
        ...(await agentStore.list()).map((a) => a.agentId),
        ...(await groups.list()).map((g) => g.groupId),
      ]
      for (const key of keys) {
        for (const rec of await transcript.readAll(key)) {
          const p = rec.payload as Record<string, unknown>
          if (rec.kind === 'user') bump('user', key)
          else if (rec.kind === 'agent') bump(key, 'user')
          else if (rec.kind === 'a2a-out' && typeof p.to === 'string') bump(key, p.to)
          else if (rec.kind === 'group-user') bump('user', key)
          else if (rec.kind === 'group-agent' && typeof p.from === 'string') bump(p.from, key)
        }
      }
      return [...counts.entries()].map(([key, count]) => {
        const [from, to] = key.split(' ')
        return { from: from ?? '', to: to ?? '', count }
      })
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
      messaging.sendUserMessage(
        payload as {
          toAgentId: string
          text: string
          nonce: string
          sessionRef?: { agentId: string; sessionId: string | null }
          attachments?: import('@openbot/core').AttachmentMeta[]
        },
      ),
    )
    // ---- 「会话掌控」命令族（sessionView 元事件的写入面；组装解释在 runner） ----
    // 编辑用户消息：append revision（regenerate=true 额外重驱——enqueue user lane chat，
    // originMessageId=目标消息：组装剔除旧位置，userMessage 带新文本，revision 替换后流内一致）
    .register('v1.session.editMessage', async (payload) => {
      const { agentId, messageId, text, regenerate } = payload as {
        agentId: string; messageId: string; text: string; regenerate?: boolean
      }
      if (text.trim() === '') throw new KernelError('STATE_AGENT_NOT_FOUND', '修订文本不能为空')
      const rec = await transcript.append(agentId, 'revision', { messageId, text, regenerate: regenerate === true })
      if (regenerate === true) {
        const scheduler = schedulers.get(agentId)
        if (scheduler === undefined) throw new KernelError('STATE_AGENT_NOT_FOUND', 'agent 不存在')
        scheduler.enqueue({ lane: 'user', kind: 'chat', payload: { messageId, text }, summary: '编辑后重新生成' })
      }
      bus.emit('v1.session.revised', { agentId, messageId, text, regenerate: regenerate === true, revisionId: String(rec.seq) })
      return { ok: true }
    })
    // agent 回复移出/恢复上下文（tombstone/revive——物理保留，组装跳过）
    .register('v1.session.tombstone', async (payload) => {
      const { agentId, messageId } = payload as { agentId: string; messageId: string }
      await transcript.append(agentId, 'tombstone', { messageId })
      bus.emit('v1.session.tombstoned', { agentId, messageId })
      return { ok: true }
    })
    .register('v1.session.revive', async (payload) => {
      const { agentId, messageId } = payload as { agentId: string; messageId: string }
      await transcript.append(agentId, 'revive', { messageId })
      bus.emit('v1.session.revived', { agentId, messageId })
      return { ok: true }
    })
    // 会话压缩（会话引擎 v2 · P2）：手动 /compact 底座——sessionKey 通吃私聊（agentId）与
    // 群聊（groupId）；活动段过短诚实跳过（skipped）。摘要生成是独立 llm 调用（一次成本全程受益）
    .register('v1.session.compact', async (payload) => {
      const { agentId, groupId, focus } = payload as { agentId?: string; groupId?: string; focus?: string }
      const sessionKey = groupId ?? agentId
      if (sessionKey === undefined || sessionKey === '') {
        throw new KernelError('STATE_AGENT_NOT_FOUND', '缺少 agentId 或 groupId')
      }
      if (compacting.has(sessionKey)) return { skipped: true, reason: 'in-progress' as const }
      compacting.add(sessionKey)
      try {
        const r = await compactSession(compactDeps(), agentId ?? sessionKey, sessionKey, {
          trigger: 'manual',
          ...(focus !== undefined && focus !== '' ? { focus } : {}),
        })
        if (r !== null) {
          bus.emit('v1.session.compacted', { sessionKey, coveredSeq: r.coveredSeq, keptRounds: r.keptRecords, trigger: 'manual' })
          return { skipped: false as const, coveredSeq: r.coveredSeq, keptRecords: r.keptRecords }
        }
        return { skipped: true as const }
      } finally {
        compacting.delete(sessionKey)
      }
    })
    // /clear：开新 session（sessionId=UUID，2026-10-18 改版；在跑 run 由 renderer 先 cancel——v1.scheduler.cancel 既有面）。
    // 空会话 no-op（2026-10-18 用户裁定「空会话不计入」）：当前段无消息时不落边界——连续 /clear 只计首条
    .register('v1.session.clear', async (payload) => {
      const { agentId } = payload as { agentId: string }
      const records = await transcript.readAll(agentId)
      const current = sessionSegments(records).find((s) => s.current)
      if (current !== undefined && current.messageCount === 0) {
        return { sessionId: current.sessionId, skipped: true }
      }
      const sessionId = randomUUID()
      await transcript.append(agentId, 'session-start', { sessionId })
      bus.emit('v1.session.cleared', { agentId, sessionId })
      return { sessionId }
    })
    // /resume：抵消最近一次 clear（组装回上一会话）
    .register('v1.session.resume', async (payload) => {
      const { agentId, sessionId } = payload as { agentId: string; sessionId?: string }
      const records = await transcript.readAll(agentId)
      if (!records.some((r) => r.kind === 'session-start')) {
        throw new KernelError('STATE_AGENT_NOT_FOUND', '没有可恢复的已清空会话')
      }
      if (sessionId !== undefined) {
        // 目标会话必须真实在场（悬空拒绝——用户当下反馈）
        if (!records.some((r) => r.kind === 'session-start' && (r.payload as { sessionId?: string }).sessionId === sessionId)) {
          throw new KernelError('STATE_AGENT_NOT_FOUND', '会话不存在')
        }
      }
      await transcript.append(agentId, 'session-resume', { ...(sessionId !== undefined ? { sessionId } : {}) })
      bus.emit('v1.session.resumed', { agentId, ...(sessionId !== undefined ? { sessionId } : {}) })
      return { ok: true }
    })
    // 会话清单（composer 引用选择器与 /resume 选择级数据源）：sessionSegments 段扫描
    // （栈语义——resume 回溯续写归旧会话）。空会话不计入（2026-10-18 用户裁定）：非当前段
    // 且无消息不返回；当前段恒返回（resume 级本就排除 current）
    .register('v1.session.list', async (payload) => {
      const { agentId } = payload as { agentId: string }
      const records = await transcript.readAll(agentId)
      const sessions = sessionSegments(records)
        .filter((s) => s.current || s.messageCount > 0)
        .map(({ sessionId, messageCount, firstText, lastAt, title, current }) => ({
          ...(title !== undefined ? { title } : {}),
          sessionId,
          messageCount,
          firstText,
          lastAt,
          current,
        }))
      return { sessions }
    })
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
      'v1.group.clear',
      async (payload) => {
        const { groupId } = groupClearSchema.parse(payload)
        return groups.clearContext({ groupId })
      },
      groupClearSchema,
    )
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
    memory,
    agentStore,
    transcript,
    ledger,
    approvalGate: gate,
    backend,
    registry,
    messaging,
    broadcast,
    groups,
    tools,
    plugins,
    streamHub,
    shellService,
    guiStream,
    screen,
    onStream,
    statsService,
    schedulers,
    async addAgent(registration) {
      // 重启幂等：名册已有此 agent（持久化态）则只重建内存态（调度器/Box/llm），不重复注册
      const registered = (await agentStore.list()).some((a) => a.agentId === registration.agentId)
      if (!registered) {
        await agentStore.register(registration.agentId, registration.name, registration.color, registration.modelProvider, registration.imageId, registration.persona, registration.roleName)
      }
      // 身份元信息登记（2026-10-18 身份修复）：档案真相（role 含任命态；重启恢复路径同源）
      const stored = await agentStore.get(registration.agentId)
      agentMeta.set(registration.agentId, {
        name: registration.name ?? stored?.name ?? registration.agentId,
        ...(registration.persona !== undefined && registration.persona.trim() !== '' ? { persona: registration.persona.trim() } : {}),
        role: stored?.role ?? (registration.steward === true ? 'steward' : 'worker'),
      })
      // 记忆预载（backlog ①）：listSync 注入路径的缓存就绪（append 后自动最新）
      if (memory !== undefined) await memory.ensureLoaded(registration.agentId)
      llms.set(registration.agentId, registration.llm ?? new MockChatProvider({ steps: [] }))
      // 默认限额档（P5 Step 7 色档分母 + OCI 后端 --cpus/--memory 落地）：工程默认 2 核 / 2GB——
      // caps.resourceLimits=false 的后端（wsl）如实忽略；mock 忽略（但 spec 留档供 renderer 呈现上限）。
      // 镜像绑定（P8-4）：image = 绑定条目 id——RoutingBoxBackend 按它分发到对应后端实例；
      // 未绑定/悬空落 'default'（全局后端——悬空告警在装配方恢复循环）
      const boxId = await backend.create({
        image: registration.imageId ?? 'default',
        cpus: 2,
        memoryMb: 2048,
        ...(registration.dataDir !== undefined && registration.dataDir !== '' ? { dir: registration.dataDir } : {}),
      })
      boxes.set(registration.agentId, boxId)
      const scheduler = new AgentScheduler({
        agentId: registration.agentId,
        now,
        nextRunId: () => `${registration.agentId}-run-${bootPrefix}-${++runCounter}`,
        bus,
        ...(options.runPolicy !== undefined ? { policy: options.runPolicy } : {}),
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
    /** 更新人设（2026-10-18 身份修复）：落档案 + agentMeta 热更（提示词即时生效——
     *  与 setModelProvider 的重启语义不同，persona 只进 prompt 无实例态） */
    async setPersona(agentId: string, persona: string | null) {
      const profile = await agentStore.setPersona(agentId, persona)
      const meta = agentMeta.get(agentId)
      if (meta !== undefined) {
        if (profile.persona !== undefined) meta.persona = profile.persona
        else delete meta.persona
      }
      return { ...profile }
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

/** 群上下文清空（2026-10-15 /clear 群语义）：清空点落群流 + 在途轮作废 */
const groupClearSchema = z.object({ groupId: z.string().min(1) })
