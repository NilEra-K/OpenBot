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
import { failureText } from '../lib/llm-failure'
import type { GatewayClient, GatewayEndpoint } from '../lib/gateway'
import type { StreamClient } from '../lib/stream'
import type { KernelEvent } from '@openbot/transport'

/** 群上下文清空点标记（2026-10-15 /clear 群语义）——与 @openbot/messaging
 *  GROUP_CONTEXT_CLEAR_MARKER 同源字面量（renderer 不直依赖内核包；改内核侧须同步此处） */
const GROUP_CONTEXT_CLEAR_MARKER = 'context-clear'

/** 右键菜单上下文（main context-menu params 精简；坐标已由 main 换算为页面坐标） */
export interface ContextMenuPayload {
  x: number
  y: number
  isEditable: boolean
  canUndo: boolean
  canCut: boolean
  canCopy: boolean
  canPaste: boolean
  canSelectAll: boolean
  selectionText: string
  linkURL: string
}

/** 右键菜单动作（renderer 自绘菜单回传 main 执行——编辑动作须由 webContents 施于焦点元素） */
export type MenuAction =
  | 'undo'
  | 'cut'
  | 'copy'
  | 'paste'
  | 'selectAll'
  | 'copyLink'
  | 'openLink'
  | 'inspect'
  | 'reload'
  | 'devtools'

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
  menu: {
    /** 订阅右键菜单请求（main 转发 context-menu 上下文，坐标为页面坐标）；返回退订函数 */
    onContextMenu(cb: (payload: ContextMenuPayload) => void): () => void
    /** 菜单动作回传 main 执行（url 链接项 / x,y 检查元素定位） */
    action(action: MenuAction, payload?: { url?: string; x?: number; y?: number }): void
  }
  app: {
    version(): Promise<string>
    /** 数据路径（设置页数据区块）：userData / data / transcript 目录 + 会话记录标记原值（null = 随数据目录） */
    paths(): Promise<{ userData: string; data: string; transcript: string; transcriptRoot: string | null }>
    /** 打开数据文件夹（白名单限定 userData 内；返回错误消息，空串 = 成功） */
    openPath(path: string): Promise<string>
    /** 目录选择对话框（v0.1.63）：系统原生选目录（Win 资源管理器 / mac 访达）；取消返回 null */
    pickDirectory(title: string): Promise<string | null>
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
  /** 人设（2026-10-18 身份修复）：ctx 档案可编辑（即时生效）；缺席=身份行只带名字 */
  persona?: string
  /** 角色档位名（2026-10-18 自定义角色）：呈现留档（内置四角色或用户模板名） */
  roleName?: string
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
  /** 群发言模式（2026-10-18 模式体系）：group-user 在场——徽标（独立作答/汇总/点名） */
  groupMode?: 'independent' | 'summary' | 'mention' | 'debate'
  /** 图片附件（v0.1.102 一期）：user 消息在场——气泡缩略图行（dataURI 经 attachmentUri 取）。
   *  v0.1.118：agent 消息同构（截图直发——run 最后一张净化截图随终答） */
  attachments?: AttachmentMeta[]
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
  /** 失败原因原文（v0.1.113：llm abort 流 err.message——含端点诊断如 `HTTP 400: ...`；
   *  onStreamEnd 捕获。失败轮无产出块时原文只在这里，toast/过程条人话呈现取用） */
  abortReason?: string
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

/** 附件元数据（v0.1.102 图片一期——与内核协议同形） */
export interface AttachmentMeta {
  id: string
  name: string
  mime: string
  size: number
  path: string
}

/** 供应商下的模型条目（v2 供应商 1:N 模型，2026-09-15） */
export interface ProviderModelView {
  /** 模型 ID（供应商内唯一键） */
  id: string
  /** 视觉（图像输入）声明——模型级（0.1.28 截图回喂格式语义随模型走） */
  supportsImages?: boolean
  /** 1M 上下文档位（v0.1.111 附件注入预算）：勾选=1M 档；缺省 128k 档 */
  context1M?: boolean
}

/** provider 展示形状（v1.settings.list 返回；协议保证无 key 材料） */
export interface ProviderView {
  name: string
  baseUrl: string
  /** 供应商下的模型列表（至少一个） */
  models: ProviderModelView[]
  hasKey: boolean
  proxyUrl?: string
  /** 协议族（P4 Step 11）：缺省 openai-compat */
  protocol?: 'openai-compat' | 'anthropic'
}

/** 镜像条目（plan-image-firstclass P8-3；P9-1 起加 host-screen；v1.images.* 载荷——Agent 绑定镜像而非后端） */
export interface ImageEntryView {
  id: string
  name: string
  carrier: 'container' | 'ssh' | 'host-screen' | 'windows' | 'android'
  image?: string
  host?: string
  port?: number
  user?: string
  keyPath?: string
  controlProtocol: 'x11' | 'none' | 'host' | 'win' | 'android'
  display?: string
  /** carrier=host-screen：绑定窗口标题子串（P9-2；空缺=整屏） */
  windowTitle?: string
  createdAt: number
}

/** 镜像表单输入（add/update 共用形状；连接事实按载体分形状校验在内核 zod） */
export interface ImageInputView {
  name: string
  carrier: 'container' | 'ssh' | 'host-screen' | 'windows' | 'android'
  windowTitle?: string
  image?: string
  host?: string
  port?: number
  user?: string
  keyPath?: string
  controlProtocol: 'x11' | 'none' | 'host' | 'win' | 'android'
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

/** provider 表单输入（v1.settings.upsertProvider 载荷；apiKey 留空=保留原密文；模型列表至少一个） */
export interface ProviderInput {
  name: string
  /** 改名来源（v0.1.62 编辑态携带）：内核按此名寻旧档迁移密文并级联默认/回退引用；缺省 = 同名替换 */
  renameFrom?: string
  baseUrl: string
  models: ProviderModelView[]
  apiKey?: string
  proxyUrl?: string
  protocol?: 'openai-compat' | 'anthropic'
}

/** LLM 生效事实（v1.settings.llmStatus；状态栏「当轮生效端点」投影） */
export interface LlmStatus {
  configured: boolean
  /** 最近一轮成功响应实际走的通道；null = 尚无成功轮 */
  activeLane: 'primary' | 'fallback' | null
  primary: string | null
  /** 默认供应商下生效的模型 id（v2 供应商 1:N 模型） */
  primaryModel?: string | null
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
  /** llm 流类（v0.1.43 双通道）：true=思考增量（thinking_delta/reasoning_content）；缺席=正文。
   *  exec 流无此字段 */
  think?: boolean
  /** 流代际（hub 每次 open 递增）：块的身份标识——chunk 续写与 end 关块均按此精确配对
   *  （v0.1.121 身份配对：不同流的 chunk 结构上不可能写进旧块）；llm 惰性建块从 record 取 */
  seq: number
  /** exec 流：命令行与所属 Box；llm 流：轮次序号 */
  command?: string[]
  boxId?: string
  round?: number
  stdout: string
  stderr: string
  state: 'live' | 'end' | 'abort'
  abortReason?: string
  /** 思考块时长（v0.1.113 思考头改版）：live→end 转换时算得（now - at）；
   *  历史回放块无此值（起点未存）——头部不显时长（诚实降级） */
  durationMs?: number
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
    /** 附件缩略 dataURI 缓存（v0.1.102——id → data:image/...;base64,；气泡/待发条共用） */
    attCache: {} as Record<string, string>,
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
    /** 自定义角色模板（2026-10-18）：boot 拉取 + 向导保存/删除后刷新（内置四角色在渲染层内建） */
    roleTemplates: [] as Array<{ name: string; persona: string }>,
    /** 运行时安装器清单（2026-10-20 v0.2.0；同日矩阵化——全平台返回；2026-10-21 位置可选布尔细分；
     *  2026-10-27 v0.1.89 状态分层：available 布尔退役 → installState（装没装）× engineState（跑没跑）
     *  + note 稳定码 + launchSupported 启动声明）：boot/安装完成/启动就绪后刷新（主进程调用时活探测） */
    runtimeInstallers: [] as Array<{
      id: string
      runtime: string
      platform: string
      supported: boolean
      sourceKind: string
      elevation: string
      installDirSelectable: boolean
      dataDirSelectable: boolean
      locationNote: string
      notes: string[]
      installState: 'absent' | 'installed' | 'unknown' | null
      engineState: 'running' | 'stopped' | 'unknown' | null
      /** 引擎未跑细分事实（machine-missing = podman 无 machine——start 必败，UI 分流「需初始化」；
       *  feature-off = wsl.exe 在场但组件未启用——一键安装即修复（v0.1.91） */
      note?: 'machine-missing' | 'feature-off'
      launchSupported: boolean
      /** 启动提权面（2026-10-27 v0.1.90）：polkit → UI 先弹启动确认模态（提权透明红线）；none 一键直启 */
      launchElevation: 'none' | 'polkit'
    }>,
    /** 安装实况（事件驱动：runtimeId → 最新 phase/percent/detail/兜底命令） */
    runtimeProgress: {} as Record<string, { phase: string; percent?: number; detail?: string; command?: string }>,
    /** 插件工具授权记忆（2026-10-20 P2①：会话内同插件同工具不再弹审批——批一次记住） */
    rememberedPluginTools: [] as string[],
    /** 插件市场清单（2026-10-19 插件视图一期）：v1.plugins.market（内核内置源，将来接真实源） */
    pluginMarket: [] as Array<{ id: string; name: string; description: string; version: string }>,
    /** 已安装插件（2026-10-19；2026-10-20 增运行态）：boot 拉取 + 安装/卸载/启停后随命令返回刷新 */
    installedPlugins: [] as Array<{
      id: string
      name: string
      description: string
      version: string
      enabled: boolean
      runtime?: { state: 'stopped' | 'running' | 'faulted'; crashes: number; faultReason?: string }
    }>,
    /** 群终答 runId 集合（群轮过程私聊隔离的判据）：群流装载（group-agent 记录）与
     *  v1.group.message 实况收集——识别「成员档案里的遗留群轮过程记录」（新数据已落群流） */
    groupRunIds: [] as string[],
    /** 已终答 runId 集合（v0.1.122 迟到碎片根治）：终答事件（含回放）到达即记录——WS 流与
     *  事件总线是两条独立通道，终答可先于流式尾部 chunk 到达（真机实证：碎片晚 9.5s），
     *  此后晚到的该 run chunk 一律不建块（内容已由终答消息完整承载，碎片只会残留） */
    finalizedRunIds: [] as string[],
    messages: [] as ChatMessage[],
    pendingApprovals: [] as PendingApproval[],
    execs: [] as ExecCard[],
    runs: [] as RunCard[],
    boxes: [] as BoxCard[],
    /** 会话边界（「会话掌控」boot/实时收集）：agentId → [{at, sessionId}]——ConsoleView 折叠呈现 */
    sessionBoundaries: {} as Record<string, Array<{ at: number; sessionId: string }>>,
    edges: [] as GraphEdge[],
    /** 后端能力声明（caps 驱动 UI 按钮的依据） */
    caps: null as { persistent: boolean; snapshot: boolean; headless: boolean; resourceLimits: boolean; isolation: string; interactive: boolean; suspendable: boolean } | null,
    /** settings 里已配置默认 provider（空缺态提示用） */
    providerConfigured: false,
    /** provider 档案清单（settings 视图；无 key 材料） */
    providers: [] as ProviderView[],
    defaultProvider: null as string | null,
    /** 默认模型 id（v2 供应商 1:N 模型：defaultProvider 下的生效模型；null = 缺省取首个） */
    defaultModel: null as string | null,
    /** 工具轮预算（2026-11-01 可配置化）：run 单次工具循环轮数上限——装配期决策，设置后重启生效 */
    maxToolRounds: 16,
    /** run 总时长上限（分钟；2026-11-01 用户裁定去硬兜底）：0 = 无限制——装配期决策，重启生效 */
    runDeadlineMin: 0,
    /** 回退端点档案名（P4 Step 11；null = 未设置） */
    fallbackProvider: null as string | null,
    /** LLM 生效事实（状态栏投影；activeLane = 最近一轮成功响应实际走的通道） */
    llmStatus: null as LlmStatus | null,
    /** 上下文水位（会话引擎 v2 · P1）：最近 usage 实测——composer 角落计量条数据源 */
    contextUsage: null as { at: number; model: string; promptTokens: number; completionTokens: number; agentId: string } | null,
    /** compact 注记（会话引擎 v2 · P2）：会话流系统行（内存态即时反馈；sessionKey 过滤归属） */
    sessionNotes: [] as Array<{ at: number; sessionKey: string; text: string }>,
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
    /** 群轮 run 判定（私聊视图过滤——群轮的消息与过程只归群）：当前会话实况 run 走生命周期
     *  kind（v1.lifecycle.queued 带 kind='group'）；历史/遗留 run 走群终答 runId 集合
     *  （群流 group-agent 记录精确比对——runId 的 boot 前缀是启动批次号，同批私聊/群轮
     *  共用，不能按前缀判） */
    isGroupRun(state): (runId: string) => boolean {
      return (runId: string): boolean =>
        state.runs.some((r) => r.runId === runId && r.kind === 'group') || state.groupRunIds.includes(runId)
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
          onDisconnect: () => this.onStreamsDisconnected(),
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
        await this.refreshRuntimeInstallers()
        await this.refreshGroups()
        await this.refreshRoleTemplates()
        await this.refreshPlugins()
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
      const agents = await this.call<Array<{ agentId: string; name?: string; role: string; color?: string; modelProvider?: string; imageId?: string; boxId?: string | null; persona?: string; roleName?: string }>>('v1.system.listAgents')
      this.roster = agents.map((a) => ({
        agentId: a.agentId,
        name: a.name,
        role: a.role as RosterEntry['role'],
        color: a.color,
        ...(a.modelProvider !== undefined ? { modelProvider: a.modelProvider } : {}),
        ...(a.imageId !== undefined ? { imageId: a.imageId } : {}),
        boxId: a.boxId ?? null,
        ...(a.persona !== undefined ? { persona: a.persona } : {}),
        ...(a.roleName !== undefined ? { roleName: a.roleName } : {}),
      }))
    },
    /** 更新人设（2026-10-18）：即时生效（提示词每轮取档案真相）——成功后重拉名册 */
    async setPersona(agentId: string, persona: string | null): Promise<void> {
      await this.call('v1.system.setPersona', { agentId, persona })
      await this.refreshRoster()
    },
    /** 注册 agent（P4 Step 5）：命令面受理（name/color/role）→ 重拉名册 → 返回 agentId（向导跳会话用） */
    async registerAgent(input: { name: string; color?: string; role?: 'steward' | 'worker'; modelProvider?: string; imageId?: string; persona?: string; roleName?: string; dataDir?: string }): Promise<string> {
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
    async previewCron(cron: string): Promise<{ nextAt: number | null; upcomingAt: number[]; readable: string }> {
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
    /** 自定义角色模板（2026-10-18）：向导档位数据源 */
    async refreshRoleTemplates(): Promise<void> {
      const r = await this.call<{ templates: Array<{ name: string; persona: string }> }>('v1.roles.list')
      this.roleTemplates = r.templates
    },
    async upsertRoleTemplate(name: string, persona: string): Promise<void> {
      const r = await this.call<{ templates: Array<{ name: string; persona: string }> }>('v1.roles.upsert', { name, persona })
      this.roleTemplates = r.templates
    },
    async removeRoleTemplate(name: string): Promise<void> {
      await this.call('v1.roles.remove', { name })
      await this.refreshRoleTemplates()
    },
    /** 插件（2026-10-19 插件视图一期）：双清单 + 安装/卸载/启停 */
    async refreshPlugins(): Promise<void> {
      const [market, installed] = await Promise.all([
        this.call<{ plugins: Array<{ id: string; name: string; description: string; version: string }> }>('v1.plugins.market'),
        this.call<{ plugins: typeof this.installedPlugins }>('v1.plugins.installed'),
      ])
      this.pluginMarket = market.plugins
      this.installedPlugins = installed.plugins
    },
    async installPlugin(plugin: { id: string; name: string; description: string; version: string }): Promise<void> {
      const r = await this.call<{ plugins: typeof this.installedPlugins }>('v1.plugins.install', plugin)
      this.installedPlugins = r.plugins
    },
    async uninstallPlugin(id: string): Promise<void> {
      await this.call('v1.plugins.uninstall', { id })
      this.installedPlugins = this.installedPlugins.filter((p) => p.id !== id)
    },
    async setPluginEnabled(id: string, enabled: boolean): Promise<void> {
      const r = await this.call<{ plugins: typeof this.installedPlugins }>('v1.plugins.setEnabled', { id, enabled })
      this.installedPlugins = r.plugins
    },
    /** 建群（成员名册在位校验在内核）→ 刷新清单，返回 groupId（跳群会话用） */
    async createGroup(name: string, memberAgentIds: string[]): Promise<string> {
      const created = await this.call<GroupEntry>('v1.group.create', { name, memberAgentIds })
      await this.refreshGroups()
      return created.groupId
    },
    /** 群消息（P5 Step 4）：乐观更新 + nonce 幂等（与用户消息同款收敛）。
     *  独立作答（2026-10-18）：`#讨论 ` 前缀内核解析——占位即剥离前缀呈现并带「独立」徽标
     *  （正则与内核 GROUP_INDEPENDENT_PREFIX 同源——改此处须同步 messaging/group） */
    async sendGroupMessage(groupId: string, text: string, reuseNonce?: string): Promise<void> {
      const nonce = reuseNonce ?? crypto.randomUUID()
      const placeholderId = `~${nonce}`
      const modeMatch = text.match(/^#(讨论|独立|汇总|点名|辩论)\s+/)
      const shown = modeMatch !== null ? text.slice(modeMatch[0].length) : text
      if (!this.messages.some((m) => m.messageId === placeholderId)) {
        this.messages.push({ messageId: placeholderId, kind: 'group-user', from: 'user', to: groupId, text: shown, at: Date.now(), groupId, ...(modeMatch !== null ? { groupMode: modeMatch[1] === '讨论' || modeMatch[1] === '独立' ? ('independent' as const) : modeMatch[1] === '辩论' ? ('debate' as const) : (modeMatch[1] as 'summary' | 'mention') } : {}), pending: true })
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
     * 附件（v0.1.102）：本体已先经 uploadAttachment 落盘——此处只随消息带 meta（零字节搬运）。
     */
    async sendUserMessage(toAgentId: string, text: string, reuseNonce?: string, sessionRef?: { agentId: string; sessionId: string | null }, attachments?: AttachmentMeta[]): Promise<void> {
      const nonce = reuseNonce ?? crypto.randomUUID()
      const placeholderId = `~${nonce}`
      const atts = attachments !== undefined && attachments.length > 0 ? attachments : undefined
      // 附件缩略预取（v0.1.102）：气泡渲染不等网络——发送/事件/历史三路径同款
      if (atts !== undefined) for (const a of atts) void this.attachmentUri(a.id, a.mime).catch(() => {})
      if (!this.messages.some((m) => m.messageId === placeholderId)) {
        this.messages.push({ messageId: placeholderId, kind: 'user', from: 'user', to: toAgentId, text, at: Date.now(), pending: true, ...(sessionRef !== undefined ? { sessionRef } : {}), ...(atts !== undefined ? { attachments: atts } : {}) })
      } else {
        // 重试：复用占位条目，翻回发送中态
        const idx = this.messages.findIndex((m) => m.messageId === placeholderId)
        this.messages[idx] = { ...this.messages[idx]!, pending: true, failed: false }
      }
      try {
        const acceptance = await this.call<{ messageId: string; runId: string | null; first: boolean }>(
          'v1.message.sendUser',
          { toAgentId, text, nonce, ...(sessionRef !== undefined ? { sessionRef } : {}), ...(atts !== undefined ? { attachments: atts } : {}) },
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
    /** 图片附件上传（v0.1.102 一期）：base64 上行 → 壳层 sha256 落盘（内容寻址去重）→ meta */
    async uploadAttachment(name: string, mime: string, dataBase64: string): Promise<AttachmentMeta> {
      return this.call('v1.attachments.upload', { name, mime, dataBase64 })
    },
    /** 附件缩略 dataURI（内存缓存——气泡与待发条共用；读面恒经内核附件目录校验） */
    async attachmentUri(id: string, mime: string): Promise<string> {
      if (this.attCache[id] !== undefined) return this.attCache[id]
      const r = await this.call<{ dataBase64: string; mime: string }>('v1.attachments.read', { id })
      const uri = `data:${mime};base64,${r.dataBase64}`
      this.attCache = { ...this.attCache, [id]: uri }
      return uri
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
    /** 工具名 → 所属插件（P2①：前缀= id 尾段_——桥接注册同款命名） */
    pluginOfTool(tool: string): { id: string; name: string; permissions?: string[] } | null {
      for (const p of this.installedPlugins) {
        const prefix = `${(p.id.split('.').at(-1) ?? p.id).replace(/[^a-zA-Z0-9_-]/g, '_')}_`
        if (tool.startsWith(prefix)) return { id: p.id, name: p.name, permissions: (p as { permissions?: string[] }).permissions }
      }
      return null
    },
    /** 会话内记住该插件工具的批准（P2①） */
    rememberPluginTool(tool: string): void {
      if (!this.rememberedPluginTools.includes(tool)) this.rememberedPluginTools.push(tool)
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
    /** 「会话掌控」命令族（v1.session.*——组装解释在内核 sessionView） */
    async sessionEdit(agentId: string, messageId: string, text: string, regenerate: boolean): Promise<void> {
      await this.call('v1.session.editMessage', { agentId, messageId, text, regenerate })
    },
    async sessionTombstone(agentId: string, messageId: string): Promise<void> {
      await this.call('v1.session.tombstone', { agentId, messageId })
    },
    async sessionRevive(agentId: string, messageId: string): Promise<void> {
      await this.call('v1.session.revive', { agentId, messageId })
    },
    async sessionClear(agentId: string): Promise<{ sessionId: string; skipped?: boolean }> {
      // 在跑 run 先中止（clear = 新会话开始——旧话题的进行中工作不再继续）
      for (const r of this.runs.filter((x) => x.agentId === agentId && (x.state === 'queued' || x.state === 'running'))) {
        await this.cancelRun(agentId, r.runId).catch(() => {})
      }
      // skipped=true：当前段为空——内核未落边界（2026-10-18「空会话不计入」裁定）
      return await this.call<{ sessionId: string; skipped?: boolean }>('v1.session.clear', { agentId })
    },
    /** 群上下文清空（2026-10-15 /clear 群语义）：清空点落群流 + 在途轮作废（内核侧）；
     *  呈现清空走 v1.group.cleared 事件（与私聊 v1.session.cleared 同款实时路径） */
    async groupClear(groupId: string): Promise<void> {
      await this.call('v1.group.clear', { groupId })
    },
    async sessionResume(agentId: string, sessionId?: string): Promise<void> {
      await this.call('v1.session.resume', { agentId, ...(sessionId !== undefined ? { sessionId } : {}) })
    },
    async listSessions(agentId: string): Promise<Array<{ sessionId: string; messageCount: number; firstText: string; lastAt: number; current: boolean; title?: string }>> {
      const r = await this.call<{ sessions: Array<{ sessionId: string; messageCount: number; firstText: string; lastAt: number; current: boolean; title?: string }> }>('v1.session.list', { agentId })
      return r.sessions
    },
    /** 刷新 provider 配置（boot 与 settings 视图操作后调用） */
    async refreshSettings(): Promise<void> {
      const state = await this.call<{ providers: ProviderView[]; defaultProvider: string | null; defaultModel: string | null; fallbackProvider: string | null; maxToolRounds: number; runDeadlineMin: number }>('v1.settings.list')
      this.providers = state.providers
      this.defaultProvider = state.defaultProvider
      this.defaultModel = state.defaultModel
      this.fallbackProvider = state.fallbackProvider
      this.providerConfigured = state.defaultProvider !== null
      this.maxToolRounds = state.maxToolRounds
      this.runDeadlineMin = state.runDeadlineMin
    },
    /** 工具轮预算落盘（2026-11-01 设置页策略区）：装配期决策——重启生效（与沙箱偏好同语义） */
    async setMaxToolRounds(rounds: number): Promise<void> {
      await this.call('v1.settings.setMaxToolRounds', { rounds })
      this.maxToolRounds = rounds
    },
    /** run 总时长上限落盘（分钟；0 = 无限制）：同预算语义——重启生效 */
    async setRunDeadline(minutes: number): Promise<void> {
      await this.call('v1.settings.setRunDeadline', { minutes })
      this.runDeadlineMin = minutes
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
    async setDefaultProvider(name: string, model?: string): Promise<void> {
      await this.call('v1.settings.setDefault', { name, ...(model !== undefined ? { model } : {}) })
      await this.refreshSettings()
    },
    async removeProvider(name: string): Promise<void> {
      await this.call('v1.settings.removeProvider', { name })
      await this.refreshSettings()
    },
    /** 供应商重排（左栏拖拽排序）：names 全量清单，顺序即落盘顺序 */
    async reorderProviders(names: string[]): Promise<void> {
      await this.call('v1.settings.reorderProviders', { names })
      await this.refreshSettings()
    },
    /** 模型可调用性测试（模型行「测试」图标）：真实最小请求，如实报告耗时/失败原因 */
    async testModel(input: { name?: string; model: string; baseUrl?: string; apiKey?: string; protocol?: 'openai-compat' | 'anthropic' }): Promise<{ ok: boolean; detail?: string; reason?: string }> {
      return await this.call('v1.settings.testModel', input)
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
    /** 上下文水位（会话引擎 v2 · P1）：当前会话 agent 最近一次 usage 实测 / 窗口档位。
     *  数据源 usage.jsonl 尾行（遥测不进事件总线——轮询/会话切换时拉取）；无记录返回 null；
     *  未连接/无记录静默为 null（启动竞态不刷屏——连接就绪与终答落地钩子会补刷） */
    async refreshContextUsage(agentId: string): Promise<void> {
      try {
        const u = await this.call<{ at: number; model: string; promptTokens: number; completionTokens: number } | null>(
          'v1.usage.latest',
          { agentId },
        )
        this.contextUsage = u === null ? null : { ...u, agentId }
      } catch {
        this.contextUsage = null
      }
    },
    /** 会话压缩（会话引擎 v2 · P2 · /compact）：早期轮次摘要化；sessionKey 通吃私聊/群聊 */
    async sessionCompact(input: { agentId: string; groupId?: string }): Promise<{ skipped: boolean; reason?: 'in-progress'; keptRecords?: number }> {
      return this.call('v1.session.compact', { agentId: input.agentId, ...(input.groupId !== undefined ? { groupId: input.groupId } : {}) })
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
    /** 沙箱数据目录全局默认（2026-10-20 v0.2.0）：null=回 userData/boxes；重启生效 */
    async setSandboxDataDir(dir: string | null): Promise<void> {
      await this.call('v1.sandbox.setDataDir', { dir })
    },
    /** 行级数据目录（2026-10-20）：目录型运行时（wsl2/nspawn）各自设置；读取全部（呈现） */
    async setRuntimeDataDir(runtimeId: 'wsl2' | 'nspawn', dir: string | null): Promise<void> {
      await this.call('v1.sandbox.setRuntimeDir', { runtimeId, dir })
    },
    async getRuntimeDirs(): Promise<{ wsl2: string | null; nspawn: string | null }> {
      const r = await this.call<{ dirs: { wsl2: string | null; nspawn: string | null } }>('v1.sandbox.getRuntimeDirs')
      return r.dirs
    },
    /** 运行时一键安装（2026-10-20 v0.2.0）：受理即返——进度走 v1.runtime.progress 事件 */
    async refreshRuntimeInstallers(): Promise<void> {
      const r = await this.call<{ installers: typeof this.runtimeInstallers }>('v1.runtime.list')
      this.runtimeInstallers = r.installers
    },
    /** 运行时一键安装（2026-10-20 v0.2.0）：受理即返——进度走 v1.runtime.progress 事件；
     *  位置参数（2026-10-21）：空串省略（= 不传——留空用默认），非空经命令面旗标校验 */
    async installRuntime(
      runtimeId: string,
      opts?: { installDir?: string; dataDir?: string },
    ): Promise<void> {
      const installDir = opts?.installDir?.trim()
      const dataDir = opts?.dataDir?.trim()
      await this.call('v1.runtime.install', {
        runtimeId,
        ...(installDir ? { installDir } : {}),
        ...(dataDir ? { dataDir } : {}),
      })
    },
    /** 取消在途安装（2026-10-20 流量敏感客户）：下载中止清临时文件、子进程即杀 */
    async cancelRuntimeInstall(): Promise<void> {
      await this.call('v1.runtime.cancel', {})
    },
    /** 启动已装未跑的运行时（2026-10-27 v0.1.89）：受理即返——实况走 v1.runtime.progress
     *  的 launch/ready 相位（行内启动中态 + 取消等待）；DD 默认位解析让装完即启免重启应用 */
    async launchRuntime(runtimeId: string): Promise<void> {
      await this.call('v1.runtime.launch', { runtimeId })
    },
    /** 取消启动等待（2026-10-27 裁定：停轮询不杀已拉起的程序——DD 桌面应用照常完成启动） */
    async cancelRuntimeLaunch(runtimeId: string): Promise<void> {
      await this.call('v1.runtime.cancel', { runtimeId })
    },
    /** 数据目录设置（UI 优化 0.1.26）：切换自动迁移全家（v0.1.64——两阶段安全搬运）；
     *  返回迁移文件数；null = 恢复默认（同样自动迁回） */
    async setDataRoot(path: string | null): Promise<{ moved: number }> {
      return await this.call<{ moved: number }>('v1.system.setDataRoot', { path })
    },
    /** 会话记录目录独立设置（v0.1.63）：切换自动迁移（只搬 transcript.jsonl，档案/记忆不动）；
     *  返回迁移文件数；null = 回数据目录内（同样自动迁回） */
    async setTranscriptRoot(path: string | null): Promise<{ moved: number }> {
      return await this.call<{ moved: number }>('v1.system.setTranscriptRoot', { path })
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
    /** 宿主屏幕顶层窗口清单（P9-2——设置页绑定窗口下拉的事实源；按需枚举零常驻开销） */
    /** Android 在场设备扫描（P9-3c——智能恢复优先发现面：USB/已连 wifi/mDNS） */
    async scanAdbDevices(): Promise<Array<{ serial: string; state: string; product: string; model: string }>> {
      const state = await this.call<{ ok: boolean; devices?: Array<{ serial: string; state: string; product: string; model: string }>; reason?: string }>('v1.adb.devices')
      if (!state.ok || state.devices === undefined) {
        throw new Error(state.reason ?? 'adb 设备扫描失败')
      }
      return state.devices
    },
    /** Android 无线配对（配对码——扫码服务名或手动 ip:配对端口） */
    async adbPair(target: string, code: string): Promise<void> {
      const r = await this.call<{ ok: boolean; reason?: string }>('v1.adb.pair', { target, code })
      if (!r.ok) throw new Error(r.reason ?? '配对失败')
    },
    async listHostWindows(): Promise<Array<{ title: string; x: number; y: number; width: number; height: number }>> {
      const state = await this.call<{ windows: Array<{ title: string; x: number; y: number; width: number; height: number }> }>('v1.hostscreen.windows')
      return state.windows
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
      // 「会话掌控」元事件状态（boot 单遍收集——实时事件在事件流分支维护同款）
      const bootTombstoned = new Set<string>()
      const bootRevisions = new Map<string, string>()
      const bootBoundaries: Array<{ at: number; sessionId: string }> = []
      // resume 未走分支的失效区间（目标回溯专用）：[目标之后首边界, resume 点)——组装侧
      // sessionView deadRanges 的呈现镜像（定向 resume 回退多级时，中间时间线已失效）
      const bootDeadRanges: Array<[number, number]> = []
      for (const record of records) {
        if (record.kind === 'tombstone') bootTombstoned.add(String((record.payload as Record<string, unknown>)['messageId'] ?? ''))
        else if (record.kind === 'revive') bootTombstoned.delete(String((record.payload as Record<string, unknown>)['messageId'] ?? ''))
        else if (record.kind === 'revision') {
          const rp = record.payload as Record<string, unknown>
          if (typeof rp['messageId'] === 'string' && typeof rp['text'] === 'string') bootRevisions.set(rp['messageId'], rp['text'])
        } else if (record.kind === 'session-start') {
          bootBoundaries.push({ at: record.at, sessionId: String((record.payload as Record<string, unknown>)['sessionId'] ?? 's-?') })
        } else if (record.kind === 'session-resume') {
          // 组装侧 sessionView 同构：缺省弹栈；带目标截栈到目标（目标之后首边界起、到本
          // resume 点的记录失效——此前只弹栈，定向回退多级时未走分支消息被时间窗误投影）
          const target = (record.payload as Record<string, unknown>)['sessionId']
          if (typeof target !== 'string') {
            bootBoundaries.pop()
          } else {
            const idx = bootBoundaries.findIndex((b) => b.sessionId === target)
            if (idx >= 0) {
              const later = bootBoundaries[idx + 1]
              if (later !== undefined) bootDeadRanges.push([later.at, record.at])
              bootBoundaries.length = idx + 1
            }
          }
        }
      }
      if (bootBoundaries.length > 0) this.sessionBoundaries[agentId] = bootBoundaries
      // 群键判定（本调用是群装载还是成员装载）：群键的过程记录（新语义：群轮 thinking/exec
      // 落群流）不投影——群视图无过程卡（v0.1.73 裁定），且 exec 卡按 runId 前缀会被成员
      // 私聊拾取（agentOfRun 剥前缀），必须在此拦下
      const isGroupKey = this.groups.some((g) => g.groupId === agentId)
      // 群流先行装载（遗留清扫判据）：成员档案含过程记录（thinking/exec）时先把全部群
      // transcript 拉齐——旧数据群轮过程曾落成员档案，须以群流 group-agent 记录的 runId
      // 识别（boot 时序保证群清单先于 connected，本调用必在其后；新数据群轮过程已落群流，
      // 此步对纯新数据是空转幂等）
      if (!isGroupKey && records.some((r) => r.kind === 'thinking' || r.kind === 'exec')) {
        await Promise.all(this.groups.map((g) => this.loadHistory(g.groupId).catch(() => {})))
      }
      // 界面直接清空（v0.1.50 用户裁定）：有效窗口 = 最后边界之后——更早的消息不投影到呈现层
      // （transcript append-only 留证；与实时 cleared 事件的 filter 同款语义）。
      // 群键叠加清空点窗口（2026-10-15 /clear 群语义）：最后 group-sys 清空点之后才投影
      // （agent 键无 marker 记录，扫描无害——两窗口取交集即 max）
      let groupClearAt = Number.NEGATIVE_INFINITY
      for (const record of records) {
        if (record.kind === 'group-sys' && (record.payload as Record<string, unknown>)['marker'] === GROUP_CONTEXT_CLEAR_MARKER) {
          groupClearAt = record.at
        }
      }
      const windowStartAt = Math.max(
        bootBoundaries.length > 0 ? bootBoundaries[bootBoundaries.length - 1]!.at : Number.NEGATIVE_INFINITY,
        groupClearAt,
      )
      // 群终答 runId 收集（isGroupRun 历史判据的装载来源）：**全量扫描**——不受呈现窗口
      // 限制（清空点/会话边界之前的群终答仍是「该 run 是群轮」的判据；窗口只是呈现语义——
      // 目验实证：放在窗口过滤后，/clear 过的群收集数为零，清扫失效）
      if (isGroupKey) {
        for (const record of records) {
          if (record.kind !== 'group-agent') continue
          const rid = (record.payload as Record<string, unknown>)['runId']
          if (typeof rid === 'string' && !this.groupRunIds.includes(rid)) this.groupRunIds.push(rid)
        }
      }
      for (const m of this.messages) {
        if (bootTombstoned.has(m.messageId)) m.tombstoned = true
        const revised = bootRevisions.get(m.messageId)
        if (revised !== undefined && m.kind === 'user') m.text = revised
      }
      for (const record of records) {
        if (record.at < windowStartAt) continue // 清空呈现：边界之前的记录不投影（含过程事实）
        // resume 未走分支的失效区间：目标回溯截栈时，中间时间线不投影（deadRanges 同款）
        if (bootDeadRanges.some(([from, to]) => record.at >= from && record.at < to)) continue
        const p = record.payload as Record<string, unknown>
        // 群键的过程记录（群轮 thinking/exec 落群流的新语义）不投影——群视图无过程卡，
        // exec 卡按 runId 前缀会被成员私聊拾取（agentOfRun 剥前缀），必须在此拦下
        if (isGroupKey && (record.kind === 'thinking' || record.kind === 'exec')) continue
        // ---- 过程事实恢复（thinking/exec 记录）：投影为已结束的伪流块与 exec 卡——
        // 渲染层 streamUnits/execStreamsOf 零改动复用；实况块在场时跳过（按 runId+维度去重，
        // renderer 刷新而内核还活的场景不双计；与消息 messageId 去重同款哲学） ----
        if (record.kind === 'thinking') {
          if (typeof p['runId'] !== 'string' || typeof p['text'] !== 'string') continue
          if (p['text'] === '') continue // 无思考轮（v0.1.48 空串留痕）——不投影
          if (this.isGroupRun(p['runId'])) continue // 群轮过程（遗留数据）——成员私聊视图不投影
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
            think: true, // v0.1.48 修正：thinking 记录恢复为思考卡（此前无标记被当正文预览+幂等让位隐藏——重启思考消失的渲染层根因）
            seq: record.seq,
            ...(round !== undefined ? { round } : {}),
            stdout: p['text'],
            stderr: '',
            state: 'end',
            at: typeof p['startedAt'] === 'number' ? p['startedAt'] : record.at, // v0.1.113 顺序修复：优先轮开始时刻（落盘 at 在轮末，晚于轮内 exec——回放会把思考挤到工具后）
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
          if (this.isGroupRun(p['runId'])) continue // 群轮过程（遗留数据）——成员私聊视图不投影
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
        // 终答 runId 收集（v0.1.122）：回放路径与事件路径幂等合流（事件先到已记档）——
        // 重启回放后同 run 的晚到碎片同样掐断（私聊 agent 与群 group-agent 两键统一）
        if ((record.kind === 'agent' || record.kind === 'group-agent') && typeof p['runId'] === 'string' && !this.finalizedRunIds.includes(p['runId'])) {
          this.finalizedRunIds.push(p['runId'])
        }
        if (this.messages.some((m) => m.messageId === msg.messageId)) continue // 事件流已覆盖
        const msgAtts = (p as { attachments?: AttachmentMeta[] }).attachments // user 与 agent（v0.1.118 附图）同构
        if (msgAtts !== undefined) for (const a of msgAtts) void this.attachmentUri(a.id, a.mime).catch(() => {})
        const mapped: ChatMessage | null =
          record.kind === 'user'
            ? { messageId: msg.messageId, kind: 'user', from: 'user', to: agentId, text: msg.text, at: record.at, ...(msgAtts !== undefined ? { attachments: msgAtts } : {}) }
            : record.kind === 'agent'
              ? { messageId: msg.messageId, kind: 'agent', from: agentId, to: 'user', text: msg.text, at: record.at, ...(msgAtts !== undefined ? { attachments: msgAtts } : {}) }
              : record.kind === 'a2a-out' && typeof msg.to === 'string'
                ? { messageId: msg.messageId, kind: 'a2a', from: agentId, to: msg.to, text: msg.text, at: record.at }
                : record.kind === 'a2a-in' && typeof msg.from === 'string'
                  ? { messageId: msg.messageId, kind: 'a2a', from: msg.from, to: agentId, text: msg.text, at: record.at }
                  : record.kind === 'group-user'
                    ? { messageId: msg.messageId, kind: 'group-user', from: 'user', to: agentId, text: msg.text, at: record.at, groupId: agentId, ...(p['mode'] === 'independent' || p['mode'] === 'summary' || p['mode'] === 'mention' || p['mode'] === 'debate' ? { groupMode: p['mode'] as 'independent' | 'summary' | 'mention' | 'debate' } : {}) }
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
          const atts = (event.payload as { attachments?: AttachmentMeta[] }).attachments
          if (atts !== undefined) for (const a of atts) void this.attachmentUri(a.id, a.mime).catch(() => {})
          this.bumpEdge('user', toAgentId)
          if (this.messages.some((m) => m.messageId === messageId)) return // 响应先到已升级——去重
          // 事件先到（受理即 emit）：升级同目标的 pending 占位（顺序配对第一个）
          const idx = this.messages.findIndex((m) => m.pending && m.to === toAgentId && m.text === text)
          if (idx >= 0) {
            this.messages[idx] = { ...this.messages[idx]!, messageId, pending: false, failed: false }
          } else {
            this.messages.push({ messageId, kind: 'user', from: 'user', to: toAgentId, text, at: event.at, ...(atts !== undefined ? { attachments: atts } : {}) })
          }
          return
        }
        case 'v1.session.revised': {
          // 编辑用户消息：本地文本即时更新（tombstone 无关——user 消息不可 tombstone）
          const m = this.messages.find((x) => x.messageId === event.payload.messageId)
          if (m !== undefined && m.kind === 'user') m.text = event.payload.text
          return
        }
        case 'v1.session.tombstoned': {
          const m = this.messages.find((x) => x.messageId === event.payload.messageId)
          if (m !== undefined) m.tombstoned = true
          return
        }
        case 'v1.session.revived': {
          const m = this.messages.find((x) => x.messageId === event.payload.messageId)
          if (m !== undefined) m.tombstoned = false
          return
        }
        case 'v1.session.compacted': {
          // 会话引擎 v2 · P2：compact 注记（内存态——即时反馈；摘要层本体在 transcript 持久）
          this.sessionNotes.push({
            at: event.at,
            sessionKey: event.payload.sessionKey,
            text: `已压缩：早期对话摘要化（保留近 ${event.payload.keptRounds} 条原文）——摘要承接长期记忆`,
          })
          if (event.payload.trigger === 'auto') {
            useToastStore().push('上下文已满——已自动压缩早期对话（下一轮起以摘要承接）', 'info', 6_000)
          }
          return
        }
        case 'v1.session.cleared': {
          const b = this.sessionBoundaries[event.payload.agentId] ?? []
          b.push({ at: event.at, sessionId: event.payload.sessionId })
          this.sessionBoundaries[event.payload.agentId] = b
          // 界面直接清空（v0.1.50 用户裁定：不折叠）——边界之前的消息从呈现层移除
          // （transcript append-only 留证；boot 恢复同款过滤，见 loadHistory）
          this.messages = this.messages.filter((m) => m.at >= event.at)
          // 过程事实同窗口语义（2026-10-13 用户报障 /clear 后思考块残屏）：思考块/正文预览
          // （streams）与 exec 卡（execs）随边界一并移除——此前只清 messages 残屏；boot 路径
          // 本就按边界跳过全部记录（loadHistory），此处补齐实时路径。resume 重放不受影响
          // （loadHistory 按去重规则重新投影，状态等价）
          const clearedAgent = event.payload.agentId
          this.streams = this.streams.filter((s) => s.agentId !== clearedAgent || s.at >= event.at)
          this.execs = this.execs.filter(
            (e) => e.runId?.split('-run-')[0] !== clearedAgent || e.at >= event.at,
          )
          return
        }
        case 'v1.session.resumed': {
          // 回到历史会话 = 该 agent 呈现按 transcript 全量重投影（boot 同款：栈弹栈/目标回溯
          // 由 loadHistory 重放边界记录吸收）。此前只重拉不清理——resume 目标之后「未走分支」
          // 的消息/过程残屏（目标回溯时手写 pop 也与组装侧栈语义脱钩）；先清再投影，等价 boot
          const agentId = event.payload.agentId
          delete this.sessionBoundaries[agentId] // loadHistory 依记录重放重建（缺席即无边界）
          this.messages = this.messages.filter(
            (m) => !((m.kind === 'user' || m.kind === 'agent') && (m.to === agentId || m.from === agentId)),
          )
          // 过程事实同清（对齐 cleared 窗口语义）：已结束块/exec 卡按重投影窗口回归；
          // live 块如实保留（在跑 run 的实况不因会话切换丢帧）
          this.streams = this.streams.filter((s) => s.agentId !== agentId || s.state === 'live')
          this.execs = this.execs.filter((e) => e.runId?.split('-run-')[0] !== agentId || e.phase !== 'finished')
          loadedHistory.delete(agentId)
          void this.loadHistory(agentId).catch(() => {})
          return
        }
        case 'v1.message.agent':
          this.bumpEdge(event.payload.agentId, 'user')
          // agent 附图预取（v0.1.118 修复：事件路径缺预取致气泡缩略空白——与 user 发送/
          // 历史回放同款：气泡渲染不等网络）
          if (event.payload.attachments !== undefined) {
            for (const a of event.payload.attachments) void this.attachmentUri(a.id, a.mime).catch(() => {})
          }
          this.messages.push({
            messageId: event.payload.messageId,
            kind: 'agent',
            from: event.payload.agentId,
            to: 'user',
            text: event.payload.text,
            at: event.at,
            // agent 附图（v0.1.118 截图直发）：呈现层持久（transcript 回放同款投影）
            ...(event.payload.attachments !== undefined ? { attachments: event.payload.attachments } : {}),
          })
          // 正文预览块让位真消息（v0.1.43）：终答事件可先于流 end 到达（事件时序）——不看 state
          // 直接删（live/end 都删；流 end 随后到达时块已除名，onStreamEnd 无操作）；思考块保留。
          // v0.1.122 补漏：事件也可能先于流式**尾部 chunk**到达——删除只扫得到当时在场的块，
          // 晚到的碎片会另建新块（真机实证「图片？」碎片晚终答 9.5s 残留）——runId 记档，
          // onStreamChunk 据此掐死「终答后再建块」
          if (typeof event.payload.runId === 'string' && !this.finalizedRunIds.includes(event.payload.runId)) {
            this.finalizedRunIds.push(event.payload.runId)
          }
          this.streams = this.streams.filter(
            (b) => !(b.agentId === event.payload.agentId && b.stream === 'llm' && b.think !== true),
          )
          return
        case 'v1.runtime.progress': {
          // v0.2.0 一键安装实况 + v0.1.89 启动实况（launch 等待已等秒数 / ready 就绪终态）；
          // done/failed/ready 后刷新探测+清单（ready → engineState 翻 running，行转「已可用」）
          const p = event.payload
          this.runtimeProgress = { ...this.runtimeProgress, [p.runtimeId]: { phase: p.phase, ...(p.percent !== undefined ? { percent: p.percent } : {}), ...(p.detail !== undefined ? { detail: p.detail } : {}), ...(p.command !== undefined ? { command: p.command } : {}) } }
          if (p.phase === 'done' || p.phase === 'failed' || p.phase === 'ready') {
            if (p.phase === 'failed') {
              // 稳定码前缀分流文案（同一通道承载安装/启动两条链）
              const launchFail = (p.detail ?? '').startsWith('RUNTIME_LAUNCH')
              useToastStore().push(`${launchFail ? '运行时启动失败' : '运行时安装失败'}：${p.detail ?? '未知原因'}`, 'danger')
            }
            // 就绪成功面（v0.1.90）：后台等待转就绪也有感知（不只失败有 toast）
            if (p.phase === 'ready') {
              const name = this.runtimeInstallers.find((i) => i.id === p.runtimeId)?.runtime ?? p.runtimeId
              useToastStore().push(`运行时已就绪：${name}`, 'success')
            }
            // 刷新 fire-and-forget（onEvent 是同步投影——SSE 后续事件自然对齐）
            void this.refreshSandbox().catch(() => {})
            void this.refreshRuntimeInstallers().catch(() => {})
          }
          return
        }
        case 'v1.runtime.engine': {
          // 引擎看门狗跃迁（v0.1.90）：掉线警示/恢复告知 + 矩阵同步（超出设置页的鲜度兜底）
          const p = event.payload
          const label = p.engine === 'docker' ? 'Docker' : 'Podman'
          useToastStore().push(
            p.running ? `沙箱引擎已恢复：${label}` : `沙箱引擎已停止：${label}——容器操作将失败`,
            p.running ? 'success' : 'danger',
          )
          void this.refreshRuntimeInstallers().catch(() => {})
          return
        }
        case 'v1.plugin.event': {
          // 插件上行事件（2026-10-20 P1）：toast 用户通知面（唤醒 Agent 在内核侧已走消息通道）
          const p = event.payload
          const name = this.installedPlugins.find((i) => i.id === p.pluginId)?.name ?? p.pluginId
          const text =
            typeof p.payload === 'object' && p.payload !== null && typeof (p.payload as { text?: unknown }).text === 'string'
              ? (p.payload as { text: string }).text
              : p.type
          useToastStore().push(`插件事件 · ${name}：${text}`, 'info')
          return
        }
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
          // 群终答 runId 收集（isGroupRun 历史判据的实况来源——成员档案遗留群轮过程记录的识别）
          if (p.kind === 'agent' && typeof p.runId === 'string' && !this.groupRunIds.includes(p.runId)) {
            this.groupRunIds.push(p.runId)
          }
          if (this.messages.some((m) => m.messageId === p.messageId)) return
          this.messages.push({
            messageId: p.messageId,
            kind: p.kind === 'user' ? 'group-user' : p.kind === 'agent' ? 'group-agent' : 'group-sys',
            from: p.from,
            to: p.groupId,
            text: p.text,
            at: event.at,
            groupId: p.groupId,
            ...(p.kind === 'user' && (p.mode === 'independent' || p.mode === 'summary' || p.mode === 'mention' || p.mode === 'debate')
            ? { groupMode: p.mode }
            : {}),
          })
          // 正文预览块让位（同 v1.message.agent 语义）：成员群终答到达即清其正文 live 块——
          // 群轮正文的家在群流（此前缺失致同一句话在成员私聊呈现两遍：预览气泡 + relay 行）。
          // runId 记档（v0.1.122 同 v1.message.agent：掐死终答后晚到碎片另建块）
          if (p.kind === 'agent') {
            if (typeof p.runId === 'string' && !this.finalizedRunIds.includes(p.runId)) {
              this.finalizedRunIds.push(p.runId)
            }
            this.streams = this.streams.filter(
              (b) => !(b.agentId === p.from && b.stream === 'llm' && b.think !== true),
            )
          }
          return
        }
        case 'v1.group.cleared': {
          // 群上下文清空（2026-10-15 /clear 群语义）：界面直接清空（对齐 v1.session.cleared
          // 裁定：不折叠）——清空点之前的群呈现移除（transcript append-only 留证；boot 恢复
          // 同款过滤见 loadHistory；过程事实归 agent 流不随群清）
          this.messages = this.messages.filter((m) => m.groupId !== event.payload.groupId || m.at >= event.at)
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
          // 插件工具授权记忆（P2①）：本会话批过 → 自动放行不弹窗（内核账本照落——审计不缺）
          if (this.rememberedPluginTools.includes(event.payload.tool)) {
            void this.resolveApproval(event.payload.nonce, 'approved').catch(() => {})
            return
          }
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
            // v0.1.113：人话 + 端点原文摘录（原文经 abort 流先/后到达——后到时过程条仍会补显）
            const run = this.runs.find((r) => r.runId === event.payload.runId)
            useToastStore().push(`${name} 执行失败：${failureText(event.payload.code, run?.abortReason)}`, 'danger', 8_000)
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
      // llm 流不预开块（v0.1.43）：一个 open 对应 think/text 双通道——首 chunk 按 th 开对应块
      if (meta.stream === 'llm') return
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
      record: { agentId: string; runId: string; stream: 'llm' | 'exec'; seq: number },
      chunk: { t: string; ch?: 'stdout' | 'stderr'; th?: boolean },
    ): void {
      if (record.stream === 'llm') {
        // 终答后晚到**正文**碎片掐断（v0.1.122）：终答事件先于流式尾部 chunk 到达时（两通道
        // 独立竞速，真机实证碎片晚 9.5s），正文已由终答消息完整承载——晚到正文 chunk 不建块
        // （建了就是无主残留：「图片？」半段气泡报障实锤）。思考通道不掐：终答后到达的思考
        // 卡是过程事实（v0.1.43「思考块保留」语义——E2E 思考双通道用例实证此路径常态存在）
        if (chunk.th !== true && this.finalizedRunIds.includes(record.runId)) return
        // llm 双通道（v0.1.43）：th=true → 思考块 / 缺省 → 正文块（live 预览气泡）。
        // open 不预开——首 chunk 惰性建，th 交替时各自续写已有通道块。
        // 身份配对（v0.1.121）：find 以流代际 seq 为准——断线吞 end 后旧块即使滞留 live，
        // 新流（新 seq）也绝不续写进它（「旧正文＋终答」拼接残留的结构根除）
        let block = [...this.streams].reverse().find(
          (s) =>
            s.runId === record.runId &&
            s.stream === 'llm' &&
            s.state === 'live' &&
            s.seq === record.seq &&
            (s.think === true) === (chunk.th === true),
        )
        if (block === undefined) {
          block = {
            key: `${record.runId}:llm${chunk.th === true ? ':think' : ':text'}:${Date.now()}`,
            agentId: record.agentId,
            runId: record.runId,
            stream: 'llm',
            seq: record.seq,
            stdout: '',
            stderr: '',
            state: 'live',
            at: Date.now(),
            ...(chunk.th === true ? { think: true } : {}),
          }
          this.streams.push(block)
        }
        block.stdout += chunk.t
        return
      }
      const block = [...this.streams].reverse().find(
        (s) => s.runId === record.runId && s.stream === record.stream && s.state === 'live' && s.seq === record.seq,
      )
      if (!block) return
      if (chunk.ch === 'stderr') block.stderr += chunk.t
      else block.stdout += chunk.t
    },

    onStreamEnd(record: { agentId: string; runId: string; stream: 'llm' | 'exec'; seq: number }, reason?: string): void {
      // 失败原因原文归档到 run（v0.1.113）：失败轮往往无产出块（llm 块惰性建）——原文若只标
      // 块必丢；存 run 上供 toast/过程条人话呈现（llm.abort 的 reason=err.message 含端点诊断）
      if (reason !== undefined) {
        const run = this.runs.find((r) => r.runId === record.runId)
        if (run !== undefined && run.abortReason === undefined) run.abortReason = reason
      }
      // llm 双通道（v0.1.43）：关闭该流全部 live 块（同一流 seq 的 think 与 text 各一）。
      // v0.1.121 起按 seq 精确配对——同 run 其它代际的滞留块（断线封块漏网等）不被误关
      const live = this.streams.filter(
        (s) => s.runId === record.runId && s.stream === record.stream && s.seq === record.seq && s.state === 'live',
      )
      for (const block of live) {
        block.state = reason === undefined ? 'end' : 'abort'
        // 思考块时长回写（v0.1.113 思考头「已思考 · Ns」）——此刻即结束时刻
        if (block.think === true && block.durationMs === undefined) block.durationMs = Date.now() - block.at
        if (reason !== undefined) block.abortReason = reason
      }
    },

    /** 流连接断开（v0.1.121 拼接残留根治·其一）：全量 live 块就地封存（state 置 end）——hub
     *  语义「流只发给 open 时刻已连接的会话」，重连后旧流的 end 不会补发；不封则 live 永久
     *  滞留（「生成中…」假活态）。续写错位由其二（onStreamChunk 的 seq 身份配对）结构根除，
     *  本封存退居呈现语义：让假活态立即消失。置 end 而非 abort：断线不等于失败，已收内容
     *  如实保留（丢尾前缀由 isPreviewDup 让位收尾） */
    onStreamsDisconnected(): void {
      for (const block of this.streams) {
        if (block.state !== 'live') continue
        block.state = 'end'
        if (block.think === true && block.durationMs === undefined) block.durationMs = Date.now() - block.at
      }
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
