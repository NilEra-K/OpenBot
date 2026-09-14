/**
 * 内核事实 store（解耦纪律 #1：内核事实全部来自事件流与命令响应，渲染层不直改）。
 * roster/transcript 摘要/审批挂起——Step 8–9 随视图扩展（任务/Box/图谱族）。
 */
import { defineStore } from 'pinia'
import { createGatewayClient } from '../lib/gateway'
import { GatewayCommandError } from '../lib/gateway'
import { connectRunStreams } from '../lib/stream'
import { agentColor } from '../lib/agent-color'
import { useToastStore } from './toast'
import type { GatewayClient, GatewayEndpoint } from '../lib/gateway'
import type { StreamClient } from '../lib/stream'
import type { KernelEvent } from '@openbot/transport'

/** preload 注入的全局（index.cts 暴露；E2E 可在页面加载前替换） */
interface OpenbotGlobal {
  desktop: boolean
  window: {
    minimize(): void
    toggleMaximize(): void
    close(): void
    /** 当前最大化状态（加载/重载后的初始同步） */
    isMaximized(): Promise<boolean>
    /** 订阅最大化状态变化；返回退订函数 */
    onMaximizeChange(cb: (maximized: boolean) => void): () => void
  }
  gateway: { info(): Promise<GatewayEndpoint | null> }
  app: {
    version(): Promise<string>
    /** 数据路径（设置页数据区块）：userData / data / transcript 目录 */
    paths(): Promise<{ userData: string; data: string; transcript: string }>
    /** 打开数据文件夹（白名单限定 userData 内；返回错误消息，空串 = 成功） */
    openPath(path: string): Promise<string>
  }
}
declare global {
  interface Window {
    openbot: OpenbotGlobal
  }
}

export interface RosterEntry {
  agentId: string
  name?: string
  role: 'steward' | 'worker'
  /** 身份色（P4 Step 5 档案事实；缺席回退哈希派生——colorOf 统一取色）。
   *  可选：roster 事件 push 的新 agent（运行中注册）档案字段未知，待下次快照刷新。 */
  color?: string
  /** 模型覆盖档案名（backlog ③）；缺席=继承全局主力 */
  modelProvider?: string
  /** 镜像绑定条目 id（plan-image-firstclass P8-4）；缺席=默认沙箱；悬空（条目已删）装配层如实回默认 */
  imageId?: string
  /** 该 agent 的专属 Box（v1.system.listAgents 返回；注册即创建——ctx 任意时刻可接管的信号源）。
   *  可选：roster 事件 push 的新 agent（运行中注册）归属未知，待下次快照刷新。 */
  boxId?: string | null
}

export interface ChatMessage {
  messageId: string
  kind: 'user' | 'agent' | 'a2a' | 'group-user' | 'group-agent' | 'group-sys' | 'remote'
  from: string
  to: string
  text: string
  at: number
  /** 群消息（P5 Step 4）：所属群——群会话流按此过滤 */
  groupId?: string
  /** 乐观占位：命令响应/事件到达前为 true（UI 显示发送中态） */
  pending?: boolean
  /** 发送失败（网络/领域错误）：UI 显示重试 */
  failed?: boolean
  /** 远端 mirror 消息（P7）：呈现署名（渲染走同一 markdown+DOMPurify 链——远端内容必净化） */
  speakerName?: string
}

/** 群档案（P5 Step 4，v1.group.list 返回） */
export interface GroupEntry {
  groupId: string
  name: string
  members: string[]
  createdAt: number
}

/** 跨用户房间接入状态（P7 多房间轮）：settings 全量 + 各房连接态 */
export interface RelayRoomStatus {
  enabled: boolean
  url: string
  roomId: string
  inviteCode: string
  displayName: string
  roomName?: string
  connected: boolean
}

/** 定时自动化规则（backlog ②）：v1.automations.list 返回形状 */
export interface AutomationRow {
  id: string
  name: string
  cron: string
  agentId: string
  prompt: string
  enabled: boolean
  createdAt: number
  lastRunAt?: number
  /** 下次触发预览（epoch ms；null=禁用或永不触发） */
  nextAt: number | null
}

export interface PendingApproval {
  approvalId: string
  nonce: string
  runId: string
  agentId: string
  tool: string
  reason?: string
}

/** Box 执行卡：同键 started/finished 聚合（键 = runId，无 runId 的独立成卡） */
export interface ExecCard {
  key: string
  boxId: string
  runId?: string
  command: string[]
  phase: 'started' | 'finished'
  exitCode?: number
  at: number
}

/** 排程 run 卡（v1.lifecycle.* 事件累积；状态永远诚实） */
export interface RunCard {
  runId: string
  agentId: string
  lane: 'user' | 'agent' | 'background'
  kind: string
  /** 一句话摘要（queued 事件携带；无摘要的 run 退回显示 runId） */
  summary?: string
  state: 'queued' | 'running' | 'succeeded' | 'failed' | 'aborted' | 'escaped' | 'reaped'
  attempts: number
  code?: string
  at: number
  /** 末次状态时间 */
  updatedAt: number
}

/** Box 实例（boot 快照 + v1.box.state 事件更新） */
export interface BoxCard {
  boxId: string
  image: string
  state: 'active' | 'sleeping' | 'snapshot'
  createdAt: number
  /** 资源限额（spec 留档——色档分母；resourceLimits=false 的后端创建时也不落，如实缺席） */
  cpus?: number
  memoryMb?: number
}

/** 图谱边（消息量；a2a 双向 + 用户↔agent） */
export interface GraphEdge {
  from: string
  to: string
  count: number
}

/** provider 展示形状（v1.settings.list 返回；协议保证无 key 材料） */
export interface ProviderView {
  name: string
  baseUrl: string
  model: string
  hasKey: boolean
  proxyUrl?: string
  /** 协议族（P4 Step 11）：缺省 openai-compat */
  protocol?: 'openai-compat' | 'anthropic'
  /** 视觉（图像输入）声明——computer 工具族生产注册门的事实源之一 */
  supportsImages?: boolean
}

/** 镜像条目（plan-image-firstclass P8-3；v1.images.* 载荷——Agent 绑定镜像而非后端，绑定随 P8-4） */
export interface ImageEntryView {
  id: string
  name: string
  carrier: 'container' | 'ssh'
  image?: string
  host?: string
  port?: number
  user?: string
  keyPath?: string
  controlProtocol: 'x11' | 'none'
  display?: string
  createdAt: number
}

/** 镜像表单输入（add/update 共用形状；连接事实按载体分形状校验在内核 zod） */
export interface ImageInputView {
  name: string
  carrier: 'container' | 'ssh'
  image?: string
  host?: string
  port?: number
  user?: string
  keyPath?: string
  controlProtocol: 'x11' | 'none'
  display?: string
}

/** 镜像连接测试结果（如实报告——ok=true 时 detail 说明探测到的事实） */
export interface ImageTestResult {
  ok: boolean
  detail?: string
  reason?: string
}

/** 可用镜像探测（2026-09-14）：扫描到的单条镜像（CLI 行事实，ref 可直接注册） */
export interface ScannedImageView {
  ref: string
  repository: string
  tag: string
  size?: string
  created?: string
}

/** 可用镜像探测的单来源结果（如实报告：不可用必带 reason） */
export interface ImageScanSourceView {
  source: 'docker' | 'podman' | 'wsl-docker'
  ok: boolean
  images?: ScannedImageView[]
  reason?: string
}

/** provider 表单输入（v1.settings.upsertProvider 载荷；apiKey 留空=保留原密文） */
export interface ProviderInput {
  name: string
  baseUrl: string
  model: string
  apiKey?: string
  proxyUrl?: string
  protocol?: 'openai-compat' | 'anthropic'
  /** 视觉（图像输入）声明（P8-2）——缺省 false */
  supportsImages?: boolean
}

/** LLM 生效事实（v1.settings.llmStatus；状态栏「当轮生效端点」投影） */
export interface LlmStatus {
  configured: boolean
  /** 最近一轮成功响应实际走的通道；null = 尚无成功轮 */
  activeLane: 'primary' | 'fallback' | null
  primary: string | null
  fallback: string | null
}

export type SandboxPref = 'auto' | 'mock' | 'wsl' | 'docker' | 'podman' | 'ssh'

/** 沙箱后端探测项（v1.sandbox.status 返回） */
export interface SandboxProbe {
  id: SandboxPref
  available: boolean
  reason?: string
}

/** 沙箱装配事实（v1.sandbox.status 返回；呈现用，不含任何控制指令） */
export interface SandboxStatus {
  preference: SandboxPref
  stored: SandboxPref
  backendId: SandboxPref
  wanted: SandboxPref
  reason?: string
  probes: SandboxProbe[]
  rootfsPath: string
  rootfsReady: boolean
}

/** 流实况块（ctx 屏幕与 Box 操作台的渲染单元；流是实况不进事件总线——断线不补，只有当下） */
export interface LiveStreamBlock {
  key: string
  agentId: string
  runId: string
  stream: 'llm' | 'exec'
  seq: number
  /** exec 流：命令行与所属 Box；llm 流：轮次序号 */
  command?: string[]
  boxId?: string
  round?: number
  stdout: string
  stderr: string
  state: 'live' | 'end' | 'abort'
  abortReason?: string
  at: number
}

/** 模块级客户端（非序列化对象不入 state） */
let client: GatewayClient | null = null
let streamClient: StreamClient | null = null
let unsubscribe: (() => void) | null = null
/** pty 会话事件订阅者（终端组件挂载注册、卸载退订——实况只发给在看的眼睛） */
type PtyListener = (ev: { type: 'open' | 'data' | 'end'; shellId: string; boxId: string; text?: string }) => void
const ptyListeners = new Set<PtyListener>()
/** gui 流事件订阅者（GuiScreen 挂载注册、卸载退订——实况只发给在看的眼睛） */
export type GuiStreamListener = (
  ev: { type: 'open' | 'data' | 'end'; boxId: string; codec?: 'h264' | 'mjpeg'; streamId?: number; chunk?: Uint8Array; reason?: string },
) => void
const guiListeners = new Set<GuiStreamListener>()
/** 已拉取 transcript 历史的 agent（懒加载去重；内核不重启时 SSE 重放已覆盖） */
const loadedHistory = new Set<string>()

export const useKernelStore = defineStore('kernel', {
  state: () => ({
    connected: false,
    /** 引导错误（网关不可达/装配失败）——空缺态提示的数据来源 */
    bootError: null as string | null,
    roster: [] as RosterEntry[],
    /** 远端 mirror 成员（P7 多房间轮）：按房间分组（v1.system.remote-members 事件按 roomId 下发；
     *  键空间 remote:<roomId>:<memberId>——host 的 memberId 是房内自增跨房必撞） */
    remoteRooms: [] as Array<{ roomId: string; members: Array<{ memberId: string; displayName: string; connected: boolean }> }>,
    /** 跨用户房间接入状态（P7 多房间轮）：settings 全量 + env 叠加路，各房连接态实时 */
    relays: [] as RelayRoomStatus[],
    /** 定时自动化（backlog ②）：规则 + 下次触发预览（nextAt null=禁用/永不触发） */
    automations: [] as AutomationRow[],
    stewardId: null as string | null,
    /** 群清单（P5 Step 4）：boot 与 v1.group.state 事件时刷新 */
    groups: [] as GroupEntry[],
    messages: [] as ChatMessage[],
    pendingApprovals: [] as PendingApproval[],
    execs: [] as ExecCard[],
    runs: [] as RunCard[],
    boxes: [] as BoxCard[],
    edges: [] as GraphEdge[],
    /** 后端能力声明（caps 驱动 UI 按钮的依据） */
    caps: null as { persistent: boolean; snapshot: boolean; headless: boolean; resourceLimits: boolean; isolation: string; interactive: boolean; suspendable: boolean } | null,
    /** settings 里已配置默认 provider（空缺态提示用） */
    providerConfigured: false,
    /** provider 档案清单（settings 视图；无 key 材料） */
    providers: [] as ProviderView[],
    defaultProvider: null as string | null,
    /** 回退端点档案名（P4 Step 11；null = 未设置） */
    fallbackProvider: null as string | null,
    /** LLM 生效事实（状态栏投影；activeLane = 最近一轮成功响应实际走的通道） */
    llmStatus: null as LlmStatus | null,
    /** 沙箱后端装配事实（settings 视图呈现） */
    sandbox: null as SandboxStatus | null,
    /** 镜像注册表（P8-3；settings 视图呈现与管理） */
    images: [] as ImageEntryView[],
    /** 镜像清单已加载（ctx 档案悬空判定的前提——未加载不误报「已删除」） */
    imagesLoaded: false,
    /** 可用镜像探测结果（settings 视图按需扫描；null = 从未扫过） */
    imageScan: null as ImageScanSourceView[] | null,
    /** 扫描进行中（按钮防重入 + 文案切换） */
    imageScanning: false,
    /** Box 资源统计（Step 6）：每盒最新值；字段缺席=后端不可测（WSL 只有磁盘） */
    boxStats: {} as Record<string, { cpuPercent?: number; memoryMb?: number; diskMb?: number; at: number }>,
    /** 快照链（P4 Step 9）：全局快照目录事实（最近在前）；caps.snapshot=false 时空链 */
    snapshots: [] as Array<{ snapshotId: string; sizeBytes?: number; createdAt?: number }>,
    /** 宿主磁盘压力（Step 6）：null=无压力/未知；warn/critical 档事实（文案归视图层） */
    pressure: null as { level: 'warn' | 'critical'; freeBytes: number; totalBytes: number } | null,
    /** GUI 接管真值（main 内存态经 v1.box.gui-takeover 广播；ctx 小屏/BoxOps 大屏两实例同源） */
    guiTakeover: false,
    /** 审批闸门模式（P4 Step 7 档案事实）：manual=出 Box 需批准（桌面装配固定值，如实呈现） */
    approvalMode: 'manual' as 'manual' | 'auto',
    /** run 实况流块（ctx 面板；容量有限——只保留最近） */
    streams: [] as LiveStreamBlock[],
    lastSeq: 0,
  }),
  getters: {
    steward: (state) => state.roster.find((a) => a.agentId === state.stewardId) ?? null,
    /** 统一取色（P4 Step 5）：档案色优先、缺席回退 agentId 哈希派生——
     *  头像/署名/图谱节点/提及菜单同源；既有 agent 零迁移观感不变 */
    colorOf(state): (agentId: string) => string {
      return (agentId: string): string =>
        state.roster.find((a) => a.agentId === agentId)?.color ?? agentColor(agentId)
    },
  },
  actions: {
    /** 启动接线：endpoint（preload 桥）→ 客户端 → 事件订阅 + 快照拉取 */
    async boot() {
      try {
        const endpoint = await window.openbot?.gateway?.info()
        if (!endpoint) {
          this.bootError = '内核未就绪（装配失败或非桌面环境）'
          return
        }
        client = createGatewayClient(endpoint)
        // 图谱边底账先行（P5 后修复）：transcript 聚合在订阅事件**之前**落地——其后到达的消息
        // 事件实时叠加，次序天然正确（快照覆盖/事件迟到重复两类竞态一并消解）
        this.edges = await client.call<Array<{ from: string; to: string; count: number }>>('v1.graph.edges')
        unsubscribe = client.subscribe((event) => this.onEvent(event))
        // run 实况流（WS /stream）：断线自动重连、不补历史（事实走 SSE 事件流）；
        // pty 会话流同线 multiplex（终端组件经 onPtyEvent 订阅）
        streamClient = connectRunStreams(endpoint, {
          onOpen: (meta) => this.onStreamOpen(meta),
          onChunk: (record, chunk) => this.onStreamChunk(record, chunk),
          onEnd: (record, reason) => this.onStreamEnd(record, reason),
          onPtyOpen: (meta) => this.dispatchPty({ type: 'open', ...meta }),
          onPtyData: (meta, text) => this.dispatchPty({ type: 'data', ...meta, text }),
          onPtyEnd: (meta) => this.dispatchPty({ type: 'end', ...meta }),
          onGuiOpen: (meta) => this.dispatchGui({ type: 'open', boxId: meta.boxId, codec: meta.codec, streamId: meta.streamId }),
          onGuiData: (meta, chunk) => this.dispatchGui({ type: 'data', boxId: meta.boxId, streamId: meta.streamId, chunk }),
          onGuiEnd: (meta, reason) => this.dispatchGui({ type: 'end', boxId: meta.boxId, reason }),
        })
        await this.refreshRoster()
        const steward = await client.call<{ agentId: string } | null>('v1.system.getSteward')
        this.stewardId = steward?.agentId ?? null
        this.approvalMode = (await client.call<{ mode: 'manual' | 'auto' }>('v1.approval.mode')).mode
        await this.refreshSettings()
        await this.refreshLlmStatus()
        await this.refreshRelay()
        const boxes = await client.call<Array<{ boxId: string; spec: { image: string; cpus?: number; memoryMb?: number }; state: BoxCard['state']; createdAt: number }>>('v1.boxes.list')
        this.boxes = boxes.map((b) => ({
          boxId: b.boxId,
          image: b.spec.image,
          state: b.state,
          createdAt: b.createdAt,
          ...(b.spec.cpus !== undefined ? { cpus: b.spec.cpus } : {}),
          ...(b.spec.memoryMb !== undefined ? { memoryMb: b.spec.memoryMb } : {}),
        }))
        this.caps = await client.call<NonNullable<typeof this.caps>>('v1.boxes.caps')
        if (this.caps?.snapshot) await this.refreshSnapshots()
        await this.refreshSandbox()
        await this.refreshGroups()
        this.connected = true
      } catch (err) {
        this.bootError = err instanceof Error ? err.message : String(err)
      }
    },
    shutdown() {
      unsubscribe?.()
      unsubscribe = null
      streamClient?.close()
      streamClient = null
      client = null
      this.connected = false
    },
    /** 命令调用（视图 action 走这里；领域失败抛 GatewayCommandError 由视图分流文案） */
    call<T = unknown>(command: string, payload?: unknown): Promise<T> {
      if (!client) return Promise.reject(new Error('网关未连接'))
      return client.call<T>(command, payload)
    },
    /** 名册快照重拉（boot 与注册后共用——roster 事件只带 agentId/role，档案字段以快照为准） */
    async refreshRoster(): Promise<void> {
      const agents = await this.call<Array<{ agentId: string; name?: string; role: string; color?: string; modelProvider?: string; imageId?: string; boxId?: string | null }>>('v1.system.listAgents')
      this.roster = agents.map((a) => ({
        agentId: a.agentId,
        name: a.name,
        role: a.role as RosterEntry['role'],
        color: a.color,
        ...(a.modelProvider !== undefined ? { modelProvider: a.modelProvider } : {}),
        ...(a.imageId !== undefined ? { imageId: a.imageId } : {}),
        boxId: a.boxId ?? null,
      }))
    },
    /** 注册 agent（P4 Step 5）：命令面受理（name/color/role）→ 重拉名册 → 返回 agentId（向导跳会话用） */
    async registerAgent(input: { name: string; color?: string; role?: 'steward' | 'worker'; modelProvider?: string; imageId?: string }): Promise<string> {
      const created = await this.call<{ agentId: string }>('v1.system.registerAgent', input)
      await this.refreshRoster()
      return created.agentId
    },
    /** 跨用户房间接入（P7 多房间轮）：状态快照与全量写入（重启生效——装配期决策） */
    async refreshRelay(): Promise<void> {
      const r = await this.call<{ relays: RelayRoomStatus[] }>('v1.relay.status')
      this.relays = r.relays
    },
    async setRelays(input: Omit<RelayRoomStatus, 'connected'>[]): Promise<void> {
      await this.call('v1.relay.set', { relays: input })
      await this.refreshRelay()
    },
    // ---- 定时自动化（backlog ②）----
    async refreshAutomations(): Promise<void> {
      const r = await this.call<{ automations: AutomationRow[] }>('v1.automations.list')
      this.automations = r.automations
    },
    async addAutomation(input: Omit<AutomationRow, 'id' | 'createdAt' | 'lastRunAt' | 'nextAt'>): Promise<void> {
      await this.call('v1.automations.add', input)
      await this.refreshAutomations()
    },
    async updateAutomation(id: string, patch: Partial<Omit<AutomationRow, 'id' | 'createdAt' | 'lastRunAt' | 'nextAt'>>): Promise<void> {
      await this.call('v1.automations.update', { id, ...patch })
      await this.refreshAutomations()
    },
    async removeAutomation(id: string): Promise<void> {
      await this.call('v1.automations.remove', { id })
      await this.refreshAutomations()
    },
    /** cron 输入即时预览（解析在内核——单一来源） */
    async previewCron(cron: string): Promise<{ nextAt: number | null; readable: string }> {
      return this.call('v1.automations.preview', { cron })
    },
    /** Box 休眠/唤醒（P4 Step 8）：状态转移经 v1.box.state 事件回放（boxes/ctx 灰化同一信号源） */
    async pauseBox(boxId: string): Promise<void> {
      await this.call('v1.boxes.pause', { boxId })
    },
    async resumeBox(boxId: string): Promise<void> {
      await this.call('v1.boxes.resume', { boxId })
    },
    /** 快照链重拉（P4 Step 9）：snapshot/restore 成功后由调用方刷新 */
    async refreshSnapshots(): Promise<void> {
      this.snapshots = await this.call<Array<{ snapshotId: string; sizeBytes?: number; createdAt?: number }>>(
        'v1.boxes.listSnapshots',
      )
    },
    /** 回滚（破坏性——UI 负责二段确认）；状态转移经 v1.box.state 事件回放 */
    async restoreBox(boxId: string, snapshotId: string): Promise<void> {
      await this.call('v1.boxes.restore', { boxId, snapshotId })
      await this.refreshSnapshots()
    },
    /** 广播扇出（P5 Step 2）：@全员与 @多提及同一命令——UI 只构造收件列表，扇出调度在内核
     *  （worker 经此命令发起会被 MSG_BROADCAST_FORBIDDEN 拒绝——用户态恒 from='user'） */
    async fanoutMessage(toAgentIds: string[], text: string): Promise<{ recipients: Array<{ agentId: string }>; first: boolean }> {
      const acceptance = await this.call<{ recipients: Array<{ agentId: string }>; first: boolean }>('v1.message.fanout', {
        from: 'user',
        toAgentIds,
        text,
        nonce: crypto.randomUUID(),
      })
      return acceptance
    },
    /** 群清单重拉（P5 Step 4：boot 与 v1.group.state 事件时） */
    async refreshGroups(): Promise<void> {
      this.groups = await this.call<GroupEntry[]>('v1.group.list')
    },
    /** 建群（成员名册在位校验在内核）→ 刷新清单，返回 groupId（跳群会话用） */
    async createGroup(name: string, memberAgentIds: string[]): Promise<string> {
      const created = await this.call<GroupEntry>('v1.group.create', { name, memberAgentIds })
      await this.refreshGroups()
      return created.groupId
    },
    /** 群消息（P5 Step 4）：乐观更新 + nonce 幂等（与用户消息同款收敛） */
    async sendGroupMessage(groupId: string, text: string, reuseNonce?: string): Promise<void> {
      const nonce = reuseNonce ?? crypto.randomUUID()
      const placeholderId = `~${nonce}`
      if (!this.messages.some((m) => m.messageId === placeholderId)) {
        this.messages.push({ messageId: placeholderId, kind: 'group-user', from: 'user', to: groupId, text, at: Date.now(), groupId, pending: true })
      }
      try {
        const acceptance = await this.call<{ messageId: string }>('v1.group.send', { groupId, text, nonce })
        const idx = this.messages.findIndex((m) => m.messageId === placeholderId)
        if (idx >= 0) {
          if (this.messages.some((m, i) => i !== idx && m.messageId === acceptance.messageId)) {
            this.messages.splice(idx, 1) // 事件已先到
          } else {
            this.messages[idx] = { ...this.messages[idx]!, messageId: acceptance.messageId, pending: false }
          }
        }
      } catch (err) {
        const idx = this.messages.findIndex((m) => m.messageId === placeholderId)
        if (idx >= 0) this.messages[idx] = { ...this.messages[idx]!, pending: false, failed: true }
        throw err
      }
    },
    /**
     * 发送用户消息（乐观更新 + nonce 幂等）：本地占位 → 命令受理（messageId 升级占位）→
     * 事件镜像去重。事件先到/响应先到两个顺序都收敛到单条正式消息（at-most-one 呈现）。
     */
    async sendUserMessage(toAgentId: string, text: string, reuseNonce?: string): Promise<void> {
      const nonce = reuseNonce ?? crypto.randomUUID()
      const placeholderId = `~${nonce}`
      if (!this.messages.some((m) => m.messageId === placeholderId)) {
        this.messages.push({ messageId: placeholderId, kind: 'user', from: 'user', to: toAgentId, text, at: Date.now(), pending: true })
      } else {
        // 重试：复用占位条目，翻回发送中态
        const idx = this.messages.findIndex((m) => m.messageId === placeholderId)
        this.messages[idx] = { ...this.messages[idx]!, pending: true, failed: false }
      }
      try {
        const acceptance = await this.call<{ messageId: string; runId: string | null; first: boolean }>(
          'v1.message.sendUser',
          { toAgentId, text, nonce },
        )
        const idx = this.messages.findIndex((m) => m.messageId === placeholderId)
        if (idx >= 0) {
          if (this.messages.some((m, i) => i !== idx && m.messageId === acceptance.messageId)) {
            this.messages.splice(idx, 1) // 事件已先到插了正式条目——移除占位
          } else {
            this.messages[idx] = { ...this.messages[idx]!, messageId: acceptance.messageId, pending: false }
          }
        }
      } catch (err) {
        const idx = this.messages.findIndex((m) => m.messageId === placeholderId)
        if (idx >= 0) this.messages[idx] = { ...this.messages[idx]!, pending: false, failed: true }
        throw err
      }
    },
    /**
     * 审批决议（弹窗/流内 gate 卡/角标共用）：成功后本地立即移除——与 SSE resolved 事件
     * 幂等双保险。传输失败（网关不可达）抛错保留条目供重试；领域失败（已决议/不存在）
     * 同样移除收敛（内核是权威），错误照抛由调用方分流文案。
     */
    async resolveApproval(nonce: string, decision: 'approved' | 'denied'): Promise<void> {
      try {
        await this.call('v1.approval.resolve', { nonce, decision })
      } catch (err) {
        if (!(err instanceof GatewayCommandError)) throw err
      }
      this.pendingApprovals = this.pendingApprovals.filter((a) => a.nonce !== nonce)
    },
    /** Box 快照（按钮按 caps.snapshot 渲染；返回快照 id 供视图反馈） */
    async snapshotBox(boxId: string): Promise<string> {
      const { snapshotId } = await this.call<{ snapshotId: string }>('v1.boxes.snapshot', { boxId })
      if (this.caps?.snapshot) await this.refreshSnapshots()
      return snapshotId
    },
    /** 中止 run（打断工作中的 agent）：排队中直接结算，活跃中经 AbortSignal 传播 */
    async cancelRun(agentId: string, runId: string): Promise<void> {
      await this.call('v1.scheduler.cancel', { agentId, runId })
    },
    /** 刷新 provider 配置（boot 与 settings 视图操作后调用） */
    async refreshSettings(): Promise<void> {
      const state = await this.call<{ providers: ProviderView[]; defaultProvider: string | null; fallbackProvider: string | null }>('v1.settings.list')
      this.providers = state.providers
      this.defaultProvider = state.defaultProvider
      this.fallbackProvider = state.fallbackProvider
      this.providerConfigured = state.defaultProvider !== null
    },
    /** 新增/更新 provider（同名替换；apiKey 省略=保留原密文），成功后刷新配置态 */
    async upsertProvider(input: ProviderInput): Promise<void> {
      await this.call('v1.settings.upsertProvider', input)
      await this.refreshSettings()
    },
    /** 审批模式热切换（2026-09-06 composer 审批模式下拉）：manual=变更前确认 / auto=完全访问 */
    async setApprovalMode(mode: 'manual' | 'auto'): Promise<void> {
      await this.call('v1.approval.setMode', { mode })
      this.approvalMode = mode
    },
    async setDefaultProvider(name: string): Promise<void> {
      await this.call('v1.settings.setDefault', { name })
      await this.refreshSettings()
    },
    async removeProvider(name: string): Promise<void> {
      await this.call('v1.settings.removeProvider', { name })
      await this.refreshSettings()
    },
    /** 设置/清除回退端点（P4 Step 11；null = 清除；主力失败本轮降级、下轮自动回主力） */
    async setFallbackProvider(name: string | null): Promise<void> {
      await this.call('v1.settings.setFallback', { name })
      await this.refreshSettings()
      await this.refreshLlmStatus()
    },
    /** LLM 生效事实（activeLane 随每轮对话变化；App 层在消息落地后拉取） */
    async refreshLlmStatus(): Promise<void> {
      this.llmStatus = await this.call<LlmStatus>('v1.settings.llmStatus')
    },
    /** 刷新沙箱后端状态（boot 与 settings 视图进入时调用） */
    async refreshSandbox(): Promise<void> {
      this.sandbox = await this.call<SandboxStatus>('v1.sandbox.status')
    },
    /** 写沙箱偏好（重启生效；成功后刷新 stored 呈现） */
    async setSandbox(pref: SandboxPref): Promise<void> {
      await this.call('v1.sandbox.set', { preference: pref })
      await this.refreshSandbox()
    },
    /** 数据目录设置（UI 优化 0.1.26，用户需求）：写标记文件重启生效（旧数据不自动迁移） */
    async setDataRoot(path: string | null): Promise<void> {
      await this.call('v1.system.setDataRoot', { path })
    },
    /** 镜像注册表（P8-3）：刷新/增改删/连接测试——add/update 后服务端即时维护路由表 */
    async refreshImages(): Promise<void> {
      const state = await this.call<{ images: ImageEntryView[] }>('v1.images.list')
      this.images = state.images
      this.imagesLoaded = true
    },
    async addImage(input: ImageInputView): Promise<ImageEntryView> {
      const state = await this.call<{ image: ImageEntryView }>('v1.images.add', input)
      await this.refreshImages()
      return state.image
    },
    async updateImage(id: string, patch: Partial<ImageInputView>): Promise<ImageEntryView> {
      const state = await this.call<{ image: ImageEntryView }>('v1.images.update', { id, ...patch })
      await this.refreshImages()
      return state.image
    },
    async removeImage(id: string): Promise<void> {
      await this.call('v1.images.remove', { id })
      await this.refreshImages()
    },
    async testImage(id: string): Promise<ImageTestResult> {
      return await this.call<ImageTestResult>('v1.images.test', { id })
    },
    /** 可用镜像探测（按需——设置页按钮触发；只报告事实，注册仍走 addImage 全链） */
    async scanImages(): Promise<void> {
      if (this.imageScanning) return
      this.imageScanning = true
      try {
        const state = await this.call<{ sources: ImageScanSourceView[] }>('v1.images.scan')
        this.imageScan = state.sources
      } finally {
        this.imageScanning = false
      }
    },
    /**
     * 会话历史懒加载（切换会话时调用一次）：transcript 是持久真相——内核重启后 SSE 事件流为空，
     * 历史从这里恢复；与已收事件按 messageId 去重。渲染层重启（内核未重启）时 SSE since(0)
     * 已重放进程内全部事件，此处天然幂等跳过。
     */
    async loadHistory(agentId: string): Promise<void> {
      if (loadedHistory.has(agentId)) return
      loadedHistory.add(agentId)
      let records: Array<{ seq: number; at: number; kind: string; payload: unknown }>
      try {
        records = await this.call('v1.transcript.read', { agentId })
      } catch (err) {
        loadedHistory.delete(agentId) // 失败回滚标记：boot 未完成/网络抖动后允许重试
        throw err
      }
      for (const record of records) {
        const p = record.payload as Record<string, unknown>
        // ---- 过程事实恢复（thinking/exec 记录）：投影为已结束的伪流块与 exec 卡——
        // 渲染层 streamUnits/execStreamsOf 零改动复用；实况块在场时跳过（按 runId+维度去重，
        // renderer 刷新而内核还活的场景不双计；与消息 messageId 去重同款哲学） ----
        if (record.kind === 'thinking') {
          if (typeof p['runId'] !== 'string' || typeof p['text'] !== 'string') continue
          const round = typeof p['round'] === 'number' ? p['round'] : undefined
          if (
            this.streams.some(
              (s) => s.runId === p['runId'] && s.stream === 'llm' && (s.round ?? undefined) === round,
            )
          ) {
            continue
          }
          this.streams.push({
            key: `h-${agentId}-${record.seq}`,
            agentId,
            runId: p['runId'],
            stream: 'llm',
            seq: record.seq,
            ...(round !== undefined ? { round } : {}),
            stdout: p['text'],
            stderr: '',
            state: 'end',
            at: record.at,
          })
          continue
        }
        if (record.kind === 'exec') {
          if (
            typeof p['runId'] !== 'string' ||
            typeof p['boxId'] !== 'string' ||
            !Array.isArray(p['command'])
          ) {
            continue
          }
          const command = p['command'] as string[]
          if (!this.execs.some((c) => c.key === p['runId'])) {
            this.execs.push({
              key: p['runId'],
              boxId: p['boxId'],
              runId: p['runId'],
              command,
              phase: 'finished',
              ...(typeof p['exitCode'] === 'number' ? { exitCode: p['exitCode'] } : {}),
              at: record.at,
            })
          }
          // 同 run 多次 exec：按命令行区分去重（实况块在场优先）
          const cmdKey = command.join(' ')
          if (
            !this.streams.some(
              (s) => s.runId === p['runId'] && s.stream === 'exec' && (s.command?.join(' ') ?? null) === cmdKey,
            )
          ) {
            const aborted = p['aborted'] === true
            this.streams.push({
              key: `h-${agentId}-${record.seq}`,
              agentId,
              runId: p['runId'],
              stream: 'exec',
              seq: record.seq,
              command,
              boxId: p['boxId'],
              stdout: typeof p['stdout'] === 'string' ? p['stdout'] : '',
              stderr: typeof p['stderr'] === 'string' ? p['stderr'] : '',
              state: aborted ? 'abort' : 'end',
              ...(aborted && typeof p['reason'] === 'string' ? { abortReason: p['reason'] } : {}),
              at: record.at,
            })
          }
          continue
        }
        // ---- 领域消息映射（user/agent/a2a + 群 kinds——P5 Step 4；agentId 参数即会话键，群传 groupId） ----
        const msg = p as { messageId?: string; text?: string; from?: string; to?: string }
        if (typeof msg.messageId !== 'string' || typeof msg.text !== 'string') continue
        if (this.messages.some((m) => m.messageId === msg.messageId)) continue // 事件流已覆盖
        const mapped: ChatMessage | null =
          record.kind === 'user'
            ? { messageId: msg.messageId, kind: 'user', from: 'user', to: agentId, text: msg.text, at: record.at }
            : record.kind === 'agent'
              ? { messageId: msg.messageId, kind: 'agent', from: agentId, to: 'user', text: msg.text, at: record.at }
              : record.kind === 'a2a-out' && typeof msg.to === 'string'
                ? { messageId: msg.messageId, kind: 'a2a', from: agentId, to: msg.to, text: msg.text, at: record.at }
                : record.kind === 'a2a-in' && typeof msg.from === 'string'
                  ? { messageId: msg.messageId, kind: 'a2a', from: msg.from, to: agentId, text: msg.text, at: record.at }
                  : record.kind === 'group-user'
                    ? { messageId: msg.messageId, kind: 'group-user', from: 'user', to: agentId, text: msg.text, at: record.at, groupId: agentId }
                    : record.kind === 'group-agent' && typeof msg.from === 'string'
                      ? { messageId: msg.messageId, kind: 'group-agent', from: msg.from, to: agentId, text: msg.text, at: record.at, groupId: agentId }
                      : record.kind === 'group-sys'
                        ? { messageId: msg.messageId, kind: 'group-sys', from: 'system', to: agentId, text: msg.text, at: record.at, groupId: agentId }
                        : null
        if (mapped) this.messages.push(mapped)
      }
      this.messages.sort((a, b) => a.at - b.at)
      this.trimStreamsLocal()
    },
    /** 事件分发：内核是唯一事实源，这里只做投影 */
    onEvent(event: KernelEvent) {
      this.lastSeq = event.seq
      switch (event.type) {
        case 'v1.system.roster': {
          const { agentId, role, cause } = event.payload
          if (cause === 'removed') {
            this.roster = this.roster.filter((a) => a.agentId !== agentId)
          } else if (this.roster.some((a) => a.agentId === agentId)) {
            this.roster = this.roster.map((a) => (a.agentId === agentId ? { ...a, role } : a))
          } else {
            this.roster.push({ agentId, role })
          }
          if (role === 'steward') this.stewardId = agentId
          else if (this.stewardId === agentId) this.stewardId = null
          return
        }
        case 'v1.message.user': {
          const { messageId, toAgentId, text } = event.payload
          this.bumpEdge('user', toAgentId)
          if (this.messages.some((m) => m.messageId === messageId)) return // 响应先到已升级——去重
          // 事件先到（受理即 emit）：升级同目标的 pending 占位（顺序配对第一个）
          const idx = this.messages.findIndex((m) => m.pending && m.to === toAgentId && m.text === text)
          if (idx >= 0) {
            this.messages[idx] = { ...this.messages[idx]!, messageId, pending: false, failed: false }
          } else {
            this.messages.push({ messageId, kind: 'user', from: 'user', to: toAgentId, text, at: event.at })
          }
          return
        }
        case 'v1.message.agent':
          this.bumpEdge(event.payload.agentId, 'user')
          this.messages.push({
            messageId: event.payload.messageId,
            kind: 'agent',
            from: event.payload.agentId,
            to: 'user',
            text: event.payload.text,
            at: event.at,
          })
          return
        case 'v1.message.a2a':
          this.bumpEdge(event.payload.fromAgentId, event.payload.toAgentId)
          this.messages.push({
            messageId: event.payload.messageId,
            kind: 'a2a',
            from: event.payload.fromAgentId,
            to: event.payload.toAgentId,
            text: event.payload.text,
            at: event.at,
          })
          return
        case 'v1.group.message': {
          // 群边投影（P5 Step 4）：user/agent 消息计入「会话对象↔群」关系（菱形节点数据源）；
          // sys 注记非对话不计。bumpEdge 先于事件去重——响应先到路径同 v1.message.user 语义
          const p = event.payload
          if (p.kind === 'user') this.bumpEdge('user', p.groupId)
          else if (p.kind === 'agent') this.bumpEdge(p.from, p.groupId)
          if (this.messages.some((m) => m.messageId === p.messageId)) return
          this.messages.push({
            messageId: p.messageId,
            kind: p.kind === 'user' ? 'group-user' : p.kind === 'agent' ? 'group-agent' : 'group-sys',
            from: p.from,
            to: p.groupId,
            text: p.text,
            at: event.at,
            groupId: p.groupId,
          })
          return
        }
        case 'v1.group.state':
          void this.refreshGroups() // 群清单变更（created/removed）——拉快照为准
          return
        case 'v1.system.remote-members': {
          // 远端成员快照（P7 多房间轮）：按 roomId upsert（最新值语义——重放幂等收敛）
          const p = event.payload
          const idx = this.remoteRooms.findIndex((r) => r.roomId === p.roomId)
          if (idx >= 0) this.remoteRooms[idx] = { roomId: p.roomId, members: p.members.map((m) => ({ ...m })) }
          else this.remoteRooms.push({ roomId: p.roomId, members: p.members.map((m) => ({ ...m })) })
          return
        }
        case 'v1.message.remote': {
          // 远端 mirror 消息（P7 多房间轮）：归属该房成员自己的会话（键空间 remote:<roomId>:<memberId>）
          const p = event.payload
          this.bumpEdge('user', `remote:${p.roomId}:${p.fromMemberId}`)
          this.messages.push({
            messageId: p.messageId,
            kind: 'remote',
            from: `remote:${p.roomId}:${p.fromMemberId}`,
            to: 'user',
            text: p.text,
            at: event.at,
            speakerName: p.speakerName,
          })
          return
        }
        case 'v1.approval.requested': {
          // nonce 幂等：重放/重试不双弹窗
          if (this.pendingApprovals.some((a) => a.nonce === event.payload.nonce)) return
          this.pendingApprovals.push({
            approvalId: event.payload.approvalId,
            nonce: event.payload.nonce,
            runId: event.payload.runId,
            agentId: event.payload.agentId,
            tool: event.payload.tool,
            ...(event.payload.reason !== undefined ? { reason: event.payload.reason } : {}),
          })
          return
        }
        case 'v1.approval.resolved':
          this.pendingApprovals = this.pendingApprovals.filter((a) => a.nonce !== event.payload.nonce)
          return
        case 'v1.box.exec': {
          const { boxId, runId, phase, command, exitCode } = event.payload
          const key = runId ?? `${boxId}#${event.seq}` // 无 runId 的每次 exec 独立成卡
          const idx = this.execs.findIndex((e) => e.key === key)
          if (idx >= 0) {
            this.execs[idx] = { ...this.execs[idx]!, phase, ...(exitCode !== undefined ? { exitCode } : {}) }
          } else {
            this.execs.push({ key, boxId, ...(runId !== undefined ? { runId } : {}), command, phase, at: event.at })
          }
          return
        }
        case 'v1.box.state': {
          const { boxId, state } = event.payload
          const idx = this.boxes.findIndex((b) => b.boxId === boxId)
          if (idx >= 0) this.boxes[idx] = { ...this.boxes[idx]!, state }
          else this.boxes.push({ boxId, image: '?', state, createdAt: event.at }) // 快照缺失时的兜底（box 卡补齐靠重启）
          return
        }
        case 'v1.box.stats': {
          // 最新值语义：每盒留最新（重放过期遥测幂等收敛）；字段缺席=后端不可测，如实保留缺席
          const { boxId, ...fields } = event.payload
          this.boxStats[boxId] = { ...fields, at: event.at }
          return
        }
        case 'v1.box.gui-takeover': {
          // 接管真值单源（main 内存态经事件广播）——ctx 小屏与 BoxOps 大屏两个 GuiScreen 实例同源呈现
          this.guiTakeover = event.payload.held
          return
        }
        case 'v1.system.pressure': {
          // 压力投影：ok 归零（角标消退）；纯事实，文案组合归视图层
          const { level, freeBytes, totalBytes } = event.payload
          this.pressure = level === 'ok' ? null : { level, freeBytes, totalBytes }
          return
        }
        case 'v1.lifecycle.queued': {
          const { runId, agentId, lane, kind, summary } = event.payload
          this.runs = this.runs.filter((r) => r.runId !== runId)
          this.runs.push({
            runId,
            agentId,
            lane,
            kind,
            summary: summary ?? undefined,
            state: 'queued',
            attempts: 0,
            at: event.at,
            updatedAt: event.at,
          })
          return
        }
        case 'v1.lifecycle.started': {
          const run = this.runs.find((r) => r.runId === event.payload.runId)
          if (run) {
            run.state = 'running'
            run.attempts += 1
            run.updatedAt = event.at
          }
          return
        }
        case 'v1.lifecycle.finished': {
          const run = this.runs.find((r) => r.runId === event.payload.runId)
          if (run) {
            run.state = event.payload.state
            run.attempts = event.payload.attempts
            if (event.payload.code !== undefined) run.code = event.payload.code
            run.updatedAt = event.at
          }
          // 失败即时透明（2026-09-06 用户建议「错误时让 Agent 回复具体原因」的兜底层）：
          // 预算耗尽类失败已有收尾终答（模型交代进展）进会话；此处补其余失败类型的可见性
          // （网络错误等无终答场景——code 至少让用户知道哪类问题）
          if (event.payload.state === 'failed') {
            const name = this.roster.find((a) => a.agentId === event.payload.agentId)?.name ?? event.payload.agentId
            useToastStore().push(`${name} 的执行失败（${event.payload.code ?? '未知原因'}）`, 'danger', 6_000)
          }
          return
        }
        case 'v1.lifecycle.escaped':
        case 'v1.lifecycle.reaped': {
          const run = this.runs.find((r) => r.runId === event.payload.runId)
          if (run) {
            run.state = event.type === 'v1.lifecycle.escaped' ? 'escaped' : 'reaped'
            run.updatedAt = event.at
          }
          // 逃逸即时透明（2026-09-06 用户报障「思考半天静默回收」）：toast 说明原因与后果
          // ——不再让用户去排程界面才发现。终答由内核 execute 内部投递（迟到但到达）
          if (event.type === 'v1.lifecycle.escaped') {
            const name = this.roster.find((a) => a.agentId === event.payload.agentId)?.name ?? event.payload.agentId
            const graceSec = Math.round(event.payload.graceMs / 1000)
            useToastStore().push(
              `${name} 的执行超过 ${graceSec} 秒无进展，已转入后台——完成后结果仍会送达`,
              'danger',
              6_000,
            )
          }
          return
        }
        default:
          return // 其余族（task/graph 事件）随 backlog 视图扩展
      }
    },
    /** 图谱边计数（幂等聚合） */
    bumpEdge(from: string, to: string): void {
      const edge = this.edges.find((e) => e.from === from && e.to === to)
      if (edge) edge.count += 1
      else this.edges.push({ from, to, count: 1 })
    },
    // ---- run 实况流（ctx 面板；流是实况不进事件总线） ----

    /** 容量上限：超出时优先淘汰最旧的已结束块（进行中的永不淘汰） */
    trimStreamsLocal(): void {
      if (this.streams.length <= 80) return
      const finished = this.streams.filter((s) => s.state !== 'live')
      let toDrop = this.streams.length - 80
      const dropKeys = new Set<string>()
      for (const block of finished) {
        if (toDrop <= 0) break
        dropKeys.add(block.key)
        toDrop -= 1
      }
      this.streams = this.streams.filter((s) => !dropKeys.has(s.key))
    },

    onStreamOpen(meta: NonNullable<import('../lib/stream').RunStreamOpenMeta['meta']>): void {
      const key = `${meta.runId}:${meta.stream}:${meta.seq}`
      if (this.streams.some((s) => s.key === key)) return // 防重（重连竞态）
      this.streams.push({
        key,
        agentId: meta.agentId,
        runId: meta.runId,
        stream: meta.stream,
        seq: meta.seq,
        ...(meta.command !== undefined ? { command: meta.command } : {}),
        ...(meta.boxId !== undefined ? { boxId: meta.boxId } : {}),
        ...(meta.round !== undefined ? { round: meta.round } : {}),
        stdout: '',
        stderr: '',
        state: 'live',
        at: Date.now(),
      })
      this.trimStreamsLocal()
    },

    onStreamChunk(
      record: { agentId: string; runId: string; stream: 'llm' | 'exec' },
      chunk: { t: string; ch?: 'stdout' | 'stderr' },
    ): void {
      // 同 run 同类的最新块（hub 与 renderer 同一路由语义）
      const block = [...this.streams].reverse().find(
        (s) => s.runId === record.runId && s.stream === record.stream && s.state === 'live',
      )
      if (!block) return
      if (chunk.ch === 'stderr') block.stderr += chunk.t
      else block.stdout += chunk.t
    },

    onStreamEnd(record: { agentId: string; runId: string; stream: 'llm' | 'exec' }, reason?: string): void {
      const block = [...this.streams].reverse().find(
        (s) => s.runId === record.runId && s.stream === record.stream && s.state === 'live',
      )
      if (!block) return
      block.state = reason === undefined ? 'end' : 'abort'
      if (reason !== undefined) block.abortReason = reason
    },

    // ---- PTY 会话（操作台终端；键入走命令面，输出走 /stream 的 pty 流） ----

    /** 终端组件订阅会话事件（返回退订函数） */
    onPtyEvent(listener: PtyListener): () => void {
      ptyListeners.add(listener)
      return () => ptyListeners.delete(listener)
    },

    dispatchPty(ev: { type: 'open' | 'data' | 'end'; shellId: string; boxId: string; text?: string }): void {
      for (const listener of ptyListeners) listener(ev)
    },

    // ---- GUI 实况流（plan-computer-use 二期；帧走 /stream 的 gui 帧型，mjpeg 原始字节） ----

    /** gui 流事件订阅（GuiScreen 挂载注册、卸载退订） */
    onGuiStreamEvent(listener: GuiStreamListener): () => void {
      guiListeners.add(listener)
      return () => guiListeners.delete(listener)
    },

    /** 接管真值乐观置位（首笔输入零延迟呈现；v1.box.gui-takeover 事件幂等收敛同值） */
    setGuiTakeover(held: boolean): void {
      this.guiTakeover = held
    },

    dispatchGui(ev: { type: 'open' | 'data' | 'end'; boxId: string; codec?: 'h264' | 'mjpeg'; streamId?: number; chunk?: Uint8Array; reason?: string }): void {
      // 孤儿纪律（渲染层侧）：流开着但没有任何观看组件（重载后无人接管）——立即停采集，
      // 不让 ffmpeg 白跑（主进程没有「零订阅者自动停」语义——重连回放依赖它）
      if (guiListeners.size === 0 && ev.type === 'open') {
        void this.call('v1.box.gui.stream.stop', { boxId: ev.boxId }).catch(() => {})
        return
      }
      for (const listener of guiListeners) listener(ev)
    },

    /** 背压对向信号（GuiScreen 解码堆积时暂停服务端发送——背压即降帧） */
    guiStreamPause(streamId: number): void {
      streamClient?.pause(streamId)
    },

    guiStreamResume(streamId: number): void {
      streamClient?.resume(streamId)
    },

    /** 起会话（操作台打开时调用；尺寸与后端钳制约定一致） */
    async shellOpen(boxId: string, opts?: { cols?: number; rows?: number }): Promise<string> {
      const { shellId } = await this.call<{ shellId: string }>('v1.boxes.shellOpen', {
        boxId,
        ...(opts?.cols !== undefined ? { cols: opts.cols } : {}),
        ...(opts?.rows !== undefined ? { rows: opts.rows } : {}),
      })
      return shellId
    },

    /** 键入（xterm onData 直传——含控制字符与转义序列） */
    async shellWrite(shellId: string, data: string): Promise<void> {
      await this.call('v1.boxes.shellWrite', { shellId, data })
    },

    /** 杀会话（操作台关闭时调用；幂等——已退出不报错） */
    async shellClose(shellId: string): Promise<void> {
      try {
        await this.call('v1.boxes.shellClose', { shellId })
      } catch (err) {
        if (!(err instanceof GatewayCommandError)) throw err // 领域失败（已退出）静默；传输失败照抛
      }
    },
  },
})
