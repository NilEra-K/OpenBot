/**
 * 七族事件目录（内核侧类型）+ 类型化事件总线
 * 协议纯度：只含领域事实，永远没有 UI 指令；错误与状态传稳定 code（ARCHITECTURE.md §5）。
 * wire 定义见 docs/protocol.md 与 @openbot/transport（P2 网关）。
 */
import type { Lane, RunOutcomeState } from '../lifecycle/index.js'

export type EventFamily =
  | 'lifecycle'
  | 'message'
  | 'task'
  | 'box'
  | 'approval'
  | 'graph'
  | 'system'

// ---- v1 事件 payload 目录（新增字段必须向后兼容：可选或带默认） ----

export interface LifecycleQueuedPayload {
  runId: string
  agentId: string
  lane: Lane
  kind: string
  /** 是否可 steer（user lane 隐含 true） */
  steer: boolean
  /** run 在做什么的一句话事实（首条消息截断，发送侧归一；排程视图描述行消费） */
  summary?: string
}

export interface LifecycleStartedPayload {
  runId: string
  agentId: string
  lane: Lane
  kind: string
}

export interface LifecycleFinishedPayload {
  runId: string
  agentId: string
  state: RunOutcomeState
  code?: string
  attempts: number
}

export interface LifecycleEscapedPayload {
  runId: string
  agentId: string
  graceMs: number
}

export interface LifecycleReapedPayload {
  runId: string
  agentId: string
}

export interface LifecycleIdlePayload {
  agentId: string
}

/** 附件元数据（2026-10-30 v0.1.102 图片一期）：transcript 只存 meta（append-only 铁律不破），
 *  本体落 userData/attachments/<sha256>.<ext>（内容寻址——同图重传天然去重）；
 *  渲染层经 v1.attachments.read 取 dataURI 呈现缩略图 */
export interface AttachmentMeta {
  /** 内容 sha256（去重键 + 文件名前缀） */
  id: string
  /** 原文件名（展示用） */
  name: string
  /** image/*（一期只收图片——文件类语义待二期裁定） */
  mime: string
  size: number
  /** 宿主侧绝对路径（读取面恒经 v1.attachments.read 校验——渲染层不直读盘） */
  path: string
}

/** 用户消息入站（默认路由或显式 @） */
export interface MessageUserPayload {
  messageId: string
  toAgentId: string
  text: string
  /** 图片附件（v0.1.102）：随消息同链路（transcript/run/事件全链 additive） */
  attachments?: AttachmentMeta[]
}

/** 「会话掌控」事件族（sessionView 元事件写入面 → renderer 呈现刷新） */
export interface SessionRevisedPayload {
  agentId: string
  messageId: string
  text: string
  regenerate: boolean
  revisionId: string
}
export interface SessionTombstonedPayload {
  agentId: string
  messageId: string
}
export interface SessionClearedPayload {
  agentId: string
  sessionId: string
}

/** 会话压缩（会话引擎 v2 · P2）：早期轮次已摘要化——组装自 compact 记录后起算 */
export interface SessionCompactedPayload {
  sessionKey: string
  coveredSeq: number
  keptRounds: number
  trigger: 'manual' | 'auto'
}

/** agent 回复 */
export interface MessageAgentPayload {
  messageId: string
  agentId: string
  text: string
  runId?: string
  /** agent 附图（v0.1.118 截图直发）：run 期间最后一张净化截图随终答投递——呈现层持久
   *  （transcript meta + attachments 本体），历史组装仅轻注记不重发（模型不重背） */
  attachments?: AttachmentMeta[]
}

/** A2A 私聊（双侧 transcript 镜像；isRedriven 防环见 messaging） */
export interface MessageA2aPayload {
  messageId: string
  fromAgentId: string
  toAgentId: string
  text: string
  priority: boolean
  isRedriven: boolean
}

export type BoxState = 'active' | 'sleeping' | 'snapshot'

export interface BoxStatePayload {
  boxId: string
  state: BoxState
}

export interface BoxExecPayload {
  boxId: string
  runId?: string
  phase: 'started' | 'finished'
  command: string[]
  exitCode?: number
}

/** Box 资源统计（Step 6 周期遥测）：字段可选=后端不可测（缺席不造假；采样时刻即 envelope.at）。
 *  最新值语义——消费方每盒留最新，重放过期遥测幂等无害 */
export interface BoxStatsPayload {
  boxId: string
  /** CPU 百分比 [0,100]；缺席=不可测 */
  cpuPercent?: number
  /** 内存 MB；缺席=不可测 */
  memoryMb?: number
  /** 磁盘 MB；缺席=不可测 */
  diskMb?: number
}

/** 宿主资源压力（Step 6）：派生量归内核——判定在 StatsService，只在状态转移时发（ok→warn→critical→ok）。
 *  纯事实无文案（「错误文案归渲染层」的同款纪律）；重连重放幂等（投影收敛到最新态） */
export interface SystemPressurePayload {
  dimension: 'disk'
  level: 'ok' | 'warn' | 'critical'
  freeBytes: number
  totalBytes: number
}

export interface ApprovalRequestedPayload {
  approvalId: string
  runId: string
  agentId: string
  tool: string
  reason?: string
  /** 幂等键：重试不双弹窗、不双执行 */
  nonce: string
}

export interface ApprovalResolvedPayload {
  approvalId: string
  decision: 'approved' | 'denied'
  nonce: string
}

/** roster 与角色变更（steward 唯一性由 state 层排他事务强制） */
export interface SystemRosterPayload {
  agentId: string
  role: 'steward' | 'worker'
  cause: 'registered' | 'removed' | 'appointed' | 'dismissed' | 'transferred'
}

/** 远端 mirror 成员快照（P7）：按房间分组下发——host 的 memberId 是房内自增（跨房必撞，
 *  消费方按 roomId 组织命名空间）。壳级易态投影（desktop 维护，重连后 hello 重建；
 *  不持久化、不参与本地调度/建群——社交面成员而非执行面成员） */
export interface SystemRemoteMembersPayload {
  roomId: string
  members: Array<{ memberId: string; displayName: string; connected: boolean }>
}

/** GUI 接管态变化（plan-computer-use Step 5）：用户接管/交还——GUI 视图与 agent 挂起卡的信号源 */
export interface GuiTakeoverPayload {
  held: boolean
}

/** 审批模式切换（2026-09-06 预算打穿问用户 + composer 审批模式下拉）：
 *  manual=变更前确认 / auto=完全访问（SwitchableApprovalGate 热切换） */
export interface ApprovalModeChangedPayload {
  mode: 'manual' | 'auto'
}

/** 远端 mirror 消息到达（P7）：跨用户房间成员的本端对话镜像——呈现侧必须过 DOMPurify；
 *  roomId 用于归属该房间的成员（键空间 remote:<roomId>:<memberId>） */
export interface MessageRemotePayload {
  messageId: string
  roomId: string
  fromMemberId: string
  speakerKind: 'user' | 'agent'
  speakerName: string
  text: string
}

/** 群消息（P5 Step 3）：kind=user（用户群消息）/ agent（成员发言）/ sys（sysnote——建群、
 *  成员缺席、轮转收敛等系统注记）。群 = 虚拟会话对象（groupId 进 transcript 键空间） */
export interface GroupMessagePayload {
  groupId: string
  messageId: string
  kind: 'user' | 'agent' | 'sys'
  /** 'user' 或成员 agentId；sysnote 为 'system' */
  from: string
  text: string
  runId?: string
  /** 发言模式（2026-10-18 群发言模式体系；2026-10-27 v0.1.93 增 debate）：kind='user' 时在场——
   *  渲染层徽标（独立作答/汇总/点名/辩论） */
  mode?: 'independent' | 'summary' | 'mention' | 'debate'
}

/** 插件上行事件（2026-10-20 插件运行时 P1）：插件进程 → 内核 → 路由（用户通知 / 唤醒绑定 Agent）。
 *  payload 是领域事实（插件声明的 type + 任意 JSON）——呈现文案归渲染层 */
export interface PluginEventPayload {
  pluginId: string
  type: string
  payload: unknown
}

/** 运行时安装进度（2026-10-20 v0.2.0 一键安装）：download(带 percent)/verify/install/probe/done/failed/fallback。
 *  fallback 带 command 全文（Linux 无 polkit / macOS 无 brew 的如实降级——用户过目复制执行）。
 *  launch/ready（2026-10-27 v0.1.89 启动引导）：已装未跑运行时的拉起实况——launch=拉起中/等待引擎
 *  就绪（detail 带已等秒数），ready=引擎就绪终态；failed/canceled 与安装链同形复用。 */
export interface RuntimeProgressPayload {
  runtimeId: string
  phase:
    | 'download'
    | 'verify'
    | 'install'
    | 'probe'
    | 'done'
    | 'failed'
    | 'fallback'
    | 'canceled'
    | 'launch'
    | 'ready'
  percent?: number
  detail?: string
  command?: string
}

/** 沙箱引擎态跃迁（2026-10-27 v0.1.90 看门狗）：选定后端 docker/podman 的引擎 运行↔停止 变化——
 *  多 agent 长任务中引擎外部掉线的用户感知面（toast 警示/恢复告知 + 矩阵刷新）；仅跃迁触发不刷屏 */
export interface RuntimeEnginePayload {
  engine: 'docker' | 'podman'
  running: boolean
}

/** 群清单变更（P5 Step 3）：群档案增删——renderer 拉取 v1.group.list 的时机信号 */
export interface GroupStatePayload {
  groupId: string
  name: string
  cause: 'created' | 'removed'
}

/** 群上下文清空（2026-10-15 /clear 群语义）：清空点已落群流——renderer 清群呈现的时机信号 */
export interface GroupClearedPayload {
  groupId: string
}

/** 事件类型 → payload 的唯一映射（v2 破坏性变更时另起 map） */
export interface KernelEventMap {
  'v1.lifecycle.queued': LifecycleQueuedPayload
  'v1.lifecycle.started': LifecycleStartedPayload
  'v1.lifecycle.finished': LifecycleFinishedPayload
  'v1.lifecycle.escaped': LifecycleEscapedPayload
  'v1.lifecycle.reaped': LifecycleReapedPayload
  'v1.lifecycle.idle': LifecycleIdlePayload
  'v1.message.user': MessageUserPayload
  'v1.message.agent': MessageAgentPayload
  'v1.message.a2a': MessageA2aPayload
  'v1.group.message': GroupMessagePayload
  'v1.plugin.event': PluginEventPayload
  'v1.runtime.progress': RuntimeProgressPayload
  'v1.runtime.engine': RuntimeEnginePayload
  'v1.group.state': GroupStatePayload
  'v1.group.cleared': GroupClearedPayload
  'v1.box.state': BoxStatePayload
  'v1.box.exec': BoxExecPayload
  'v1.box.stats': BoxStatsPayload
  'v1.system.pressure': SystemPressurePayload
  'v1.approval.requested': ApprovalRequestedPayload
  'v1.approval.resolved': ApprovalResolvedPayload
  'v1.approval.mode-changed': ApprovalModeChangedPayload
  'v1.system.roster': SystemRosterPayload
  'v1.system.remote-members': SystemRemoteMembersPayload
  'v1.box.gui-takeover': GuiTakeoverPayload
  'v1.session.revised': SessionRevisedPayload
  'v1.session.tombstoned': SessionTombstonedPayload
  'v1.session.revived': SessionTombstonedPayload
  'v1.session.cleared': SessionClearedPayload
  'v1.session.compacted': SessionCompactedPayload
  'v1.session.resumed': { agentId: string }
  'v1.message.remote': MessageRemotePayload
}

export type KernelEventType = keyof KernelEventMap

export interface KernelEvent<T extends KernelEventType = KernelEventType> {
  /** 全局单调序号——将来 SSE Last-Event-ID 续传的钩子 */
  seq: number
  type: T
  /** 逻辑时钟 ms（注入的 now()，不读系统时钟） */
  at: number
  payload: KernelEventMap[T]
}

export type KernelEventHandler = (event: KernelEvent) => void

export interface EventBusOptions {
  now: () => number
}

/**
 * 类型化事件总线：同步分发（确定性——顺序即订阅序）、seq 单调、since(seq) 可重放。
 * 异步缓冲与跨进程转发是 transport 的事。订阅方不许抛异常（抛出=bug，直接向上暴露）。
 */
export class EventBus {
  readonly #now: () => number
  #seq = 0
  #log: KernelEvent[] = []
  #handlers = new Map<KernelEventType | '*', Set<KernelEventHandler>>()

  constructor(options: EventBusOptions) {
    this.#now = options.now
  }

  emit<T extends KernelEventType>(type: T, payload: KernelEventMap[T]): KernelEvent<T> {
    this.#seq += 1
    const event: KernelEvent<T> = { seq: this.#seq, type, at: this.#now(), payload }
    this.#log.push(event)
    this.#dispatch(type, event)
    this.#dispatch('*', event)
    return event
  }

  /** 订阅具体事件类型或 '*'（全部）；返回退订函数 */
  on(type: KernelEventType | '*', handler: KernelEventHandler): () => void {
    let set = this.#handlers.get(type)
    if (!set) {
      set = new Set()
      this.#handlers.set(type, set)
    }
    set.add(handler)
    return () => {
      set.delete(handler)
    }
  }

  /** 重放 seq 之后的事件（续传语义：since(0) = 全量） */
  since(seq: number): KernelEvent[] {
    return this.#log.filter((event) => event.seq > seq)
  }

  /** 已发出事件总数 */
  get size(): number {
    return this.#log.length
  }

  #dispatch(type: KernelEventType | '*', event: KernelEvent): void {
    const set = this.#handlers.get(type)
    if (!set) return
    // 拷贝后再遍历：允许订阅方在回调内安全退订
    for (const handler of [...set]) handler(event)
  }
}
