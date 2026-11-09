/**
 * 桌面装配（plan-p2 Step 6 + plan-p3 Step 5）：真内核进 Electron main——ARCHITECTURE.md §2 装配例外
 * （main 进程可 import coordinator/llm/boxes），renderer 业务面零内核 import（只走网关）。
 *
 * 职责：
 * - assembleKernel：NodeFs → userData/data、真实时钟、watchdog 定时驱动、ManualApprovalGate
 * - 沙箱后端装配选择（plan-p3 Step 5）：偏好（settings，env OPENBOT_SANDBOX 覆盖供 E2E）× CLI 探测
 *   × 实现白名单 → chooseBackend；wsl 时 WslBoxBackend（rootfs 落 userData），否则 mock 诚实降级
 * - 环回网关（随机端口 + 一次性 token，经 ipc → preload → renderer 内存链路，不落盘）
 * - settings 命令面 + provider 热切换（key 密文经 safeStorage；系统加密不可用时 base64 降级并标前缀）
 * - 崩溃恢复：审批账本 pending 项重发 requested 事件（UI 重新弹窗）
 */
import { app, desktopCapturer, nativeImage, Notification, safeStorage, screen as electronScreen } from 'electron'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { KernelError } from '@openbot/core'
import { appendFileSync, copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, rmdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { stat, statfs } from 'node:fs/promises'
import { assembleKernel, chooseBackend } from '@openbot/coordinator'
import type { AssembledKernel, ChooseResult, DiskFact } from '@openbot/coordinator'
import { startGateway, RelayClient } from '@openbot/transport'
import type { GatewayHandle } from '@openbot/transport'
import type { LifecycleFinishedPayload, MessageAgentPayload, MessageUserPayload } from '@openbot/core'
import { NodeFs, SettingsStore, MemoryStore, AutomationStore, ImageStore, nextAfter } from '@openbot/state'
import { manifestSchema } from '@openbot/coordinator'
import { STRATEGIES, strategiesFor, DOCKER_DESKTOP_WIN_ROOT, DOCKER_APP_MAC } from './installers/strategies.js'
import { runInstall } from './installers/index.js'
import { runLaunch, resolveDockerDesktopExe, resolveCli, READY_CLI_FALLBACKS } from './installers/launcher.js'
import { createEngineWatchdog } from './installers/watchdog.js'
import type { EngineWatchdogHandle } from './installers/watchdog.js'
import { probeDockerLayered, probePodmanLayered, probeWslLayered } from './installers/layered.js'
import type { LayeredProbeResult, InstallState, EngineState, EngineNote } from './installers/layered.js'
import type { RuntimeStrategy } from './installers/strategies.js'
import type { SandboxPreference, RelaySettings, ImageEntry } from '@openbot/state'
import { LlmError, LlmErrorCodes, OpenAiCompatProvider, AnthropicProvider } from '@openbot/llm'
import type { ChatProvider, ChatRequest, ChatResponse, ProviderCapabilities } from '@openbot/llm'
import type { ResolvedProvider } from '@openbot/state'
import { AutoApprovalGate, ManualApprovalGate, SwitchableApprovalGate } from '@openbot/runner'
import {
  DockerBoxBackend,
  MockBoxBackend,
  NspawnBoxBackend,
  PodmanBoxBackend,
  SshBoxBackend,
  SshWindowsBoxBackend,
  SshWindowsScreenControl,
  AdbBoxBackend,
  AdbScreenControl,
  AdbDiscovery,
  adbBoxId,
  UtmBoxBackend,
  RoutingBoxBackend,
  WslBoxBackend,
  HostScreenBoxBackend,
  HostScreenControl,
  ScreenControlRouter,
  X11ScreenControl,
  entryIdOfBoxId,
  isHostScreenBoxId,
  windowsBoxId,
  MOCK_BOX_CAPS,
  NSPAWN_BOX_CAPS,
  OCI_BOX_CAPS,
  SSH_BOX_CAPS,
  UTM_BOX_CAPS,
  WSL_BOX_CAPS,
  probeAll,
  probeX11Toolset,
  runProcess,
  scanEnvImages,
} from '@openbot/boxes'
import type {
  BackendProbe,
  BoxBackend,
  BoxCaps,
  BoxStats,
  HostScreenBridge,
  PipeSession,
  PipeSpec,
  ScreenAction,
} from '@openbot/boxes'
import { computerTools } from '@openbot/runner'
import { startHostScreenFramePump } from './hostscreen-pump.js'

// ---- provider 热切换：settings 变更后替换底层实现，steward 的引用不变 ----

/** 可回退错误类（P4 Step 11）：传输层/服务端过载——网络失败、超时、429、5xx；
 *  配置类 4xx 换端点无济于事、用户中止绝不能重跑，都不回退 */
function isRetriableLlmError(err: unknown): boolean {
  if (!(err instanceof LlmError)) return false
  if (err.code === LlmErrorCodes.LLM_REQUEST_FAILED || err.code === LlmErrorCodes.LLM_TIMEOUT) return true
  const http = /^LLM_HTTP_(\d+)$/.exec(err.code)
  if (!http) return false
  const status = Number(http[1])
  return status === 429 || status >= 500
}

export class SwitchableChatProvider implements ChatProvider {
  #current: ChatProvider | null = null
  #fallback: ChatProvider | null = null
  /** 最近一轮成功响应实际走的通道（状态栏「当轮生效端点」事实；null = 尚无成功轮） */
  #activeLane: 'primary' | 'fallback' | null = null

  /** 能力透传（P8-4 后 UI 优化）：跟随当前主力实现——TurnRunner 截图回喂分流按它判定 */
  get capabilities(): ProviderCapabilities {
    return this.#current?.capabilities ?? {}
  }

  swap(next: ChatProvider): void {
    this.#current = next
  }

  /** 回退实现（null = 清除回退）；与主力独立热切换 */
  swapFallback(next: ChatProvider | null): void {
    this.#fallback = next
  }

  clear(): void {
    this.#current = null
  }

  get configured(): boolean {
    return this.#current !== null
  }

  get activeLane(): 'primary' | 'fallback' | null {
    return this.#activeLane
  }

  async chat(request: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
    if (!this.#current) {
      // 稳定 code：UI 据此引导去 settings 配置 provider
      throw new LlmError('LLM_NO_PROVIDER', '尚未配置 LLM provider——请在设置视图配置后重试')
    }
    // onText 计数包装：主力流中途失败（已推送部分增量）时不回退——重跑会导致文本重复推送
    let emitted = false
    const wrapped: ChatRequest = request.onText
      ? { ...request, onText: (delta) => { emitted = true; request.onText!(delta) } }
      : request
    try {
      const response = await this.#current.chat(wrapped, signal)
      this.#activeLane = 'primary'
      return response
    } catch (err) {
      // 回退是 per-request 降级不粘滞：每轮仍先试主力（主力恢复无需显式切回）；
      // 回退也失败时抛主力原错（根因诊断价值高于回退侧表象）
      if (!this.#fallback || emitted || signal?.aborted || !isRetriableLlmError(err)) throw err
      const response = await this.#fallback.chat(request, signal)
      this.#activeLane = 'fallback'
      return response
    }
  }
}

// ---- key 密文回调：safeStorage 优先，不可用时 base64 降级（前缀区分，解密端兼容两者） ----

const PREFIX_SAFE = 'v1:' // safeStorage 加密（Windows 走 DPAPI）
const PREFIX_B64 = 'b64:' // 降级可逆编码（明文易取，仅保格式稳定；加密不可用的系统上兜底）

function encryptKey(plain: string): string {
  if (safeStorage.isEncryptionAvailable()) {
    return PREFIX_SAFE + safeStorage.encryptString(plain).toString('base64')
  }
  return PREFIX_B64 + Buffer.from(plain, 'utf8').toString('base64')
}

function decryptKey(cipher: string): string {
  if (cipher.startsWith(PREFIX_SAFE)) {
    return safeStorage.decryptString(Buffer.from(cipher.slice(PREFIX_SAFE.length), 'base64'))
  }
  if (cipher.startsWith(PREFIX_B64)) {
    return Buffer.from(cipher.slice(PREFIX_B64.length), 'base64').toString('utf8')
  }
  return cipher // 未知格式原样返回（读取端兼容）
}

// ---- 命令面 zod schema（wire 校验；renderer 表单即此形状） ----

const providerModelSchema = z.object({
  id: z.string().min(1),
  /** 视觉（图像输入）声明——模型级（v2，0.1.28 截图回喂格式语义随模型走）：缺省 false */
  supportsImages: z.boolean().optional(),
  /** 1M 上下文档位（v0.1.111 附件注入预算）：勾选=1M 档；缺省 128k 档 */
  context1M: z.boolean().optional(),
})
const providerInputSchema = z.object({
  name: z.string().min(1),
  /** 改名来源（v0.1.62）：携带时按此名寻旧档（密文随档迁移）、引用级联；缺省 = 同名替换 */
  renameFrom: z.string().min(1).optional(),
  baseUrl: z.string().url(),
  /** 模型列表（v2 供应商 1:N 模型，2026-09-15）：至少一个——图例语义「添加供应商前先添加模型」 */
  models: z.array(providerModelSchema).min(1),
  apiKey: z.string().optional(),
  proxyUrl: z.string().optional(),
  temperature: z.number().optional(),
  timeoutMs: z.number().int().positive().optional(),
  /** 协议族（P4 Step 11）：缺省 openai-compat（旧档案读取端兼容） */
  protocol: z.enum(['openai-compat', 'anthropic']).optional(),
})
/** 回退端点设置（P4 Step 11）：null = 清除回退 */
const setFallbackSchema = z.object({ name: z.string().min(1).nullable() })
const nameSchema = z.object({ name: z.string().min(1) })
/** 设为默认（v2 粒度 = 供应商 + 模型）：model 省略取该供应商首个模型 */
const setDefaultSchema = z.object({ name: z.string().min(1), model: z.string().min(1).optional() })
/** 供应商重排（左栏拖拽排序）：全量名称清单 */
const reorderProvidersSchema = z.object({ names: z.array(z.string().min(1)).min(1) })
/** 模型可调用性测试（模型行「测试」图标）：存档模式（name+model，key 从档案解密）/ 草稿模式（表单未存档，直传端点事实） */
const testModelSchema = z.object({
  name: z.string().min(1).optional(),
  model: z.string().min(1),
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  protocol: z.enum(['openai-compat', 'anthropic']).optional(),
})
const resolveSchema = z.object({
  nonce: z.string().min(1),
  decision: z.enum(['approved', 'denied']),
})
const sandboxPrefSchema = z.enum(['auto', 'mock', 'wsl', 'docker', 'podman', 'nspawn', 'utm', 'ssh'])
const sandboxSetSchema = z.object({ preference: sandboxPrefSchema })
const relayEntrySchema = z.object({
  enabled: z.boolean(),
  url: z.string().max(512),
  roomId: z.string().max(128),
  inviteCode: z.string().max(512),
  displayName: z.string().max(64),
  roomName: z.string().max(64).optional(),
})
const relaySetSchema = z.object({ relays: z.array(relayEntrySchema).max(8) })
const automationInputSchema = z.object({
  name: z.string().min(1).max(64),
  cron: z.string().min(1).max(64),
  agentId: z.string().min(1).max(128),
  prompt: z.string().min(1).max(2_000),
  enabled: z.boolean(),
})
const automationPatchSchema = automationInputSchema.partial().extend({ id: z.string() })
/** 镜像条目（plan-image-firstclass P8-3）：连接事实按载体分形状——container 须 image、
 *  ssh 须 host（superRefine 校验；state 层 validateEntry 二道兜底）。
 *  坑：zod 4 的 .partial() 运行时禁止含 refinement 的 schema（类型面却放行——typecheck 拦不住，
 *  真机首训「内核装配失败」弹窗）——基础 object 单独成常量，partial 从它派生；
 *  patch 不带 carrier 条件校验（部分载荷由 store 层 update 合并后 validateEntry 兜底） */
const imageInputBase = z.object({
  name: z.string().trim().min(1).max(64),
  carrier: z.enum(['container', 'ssh', 'host-screen', 'windows', 'android']),
  image: z.string().trim().min(1).max(200).optional(),
  host: z.string().trim().min(1).max(200).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  user: z.string().trim().min(1).max(64).optional(),
  keyPath: z.string().trim().min(1).max(500).optional(),
  controlProtocol: z.enum(['x11', 'none', 'host', 'win', 'android']),
  display: z.string().trim().max(40).optional(),
  /** host-screen 专属（P9-2 裁定 B）：绑定窗口标题子串；空缺=整屏 */
  windowTitle: z.string().trim().max(200).optional(),
})
const imageInputSchema = imageInputBase.superRefine((v, ctx) => {
  if (v.carrier === 'container' && (v.image === undefined || v.image === '')) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['image'], message: '容器镜像条目须指定镜像名' })
  }
  if (v.carrier === 'ssh' && (v.host === undefined || v.host === '')) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['host'], message: 'SSH 镜像条目须指定主机地址' })
  }
  if (v.carrier === 'windows' && (v.host === undefined || v.host === '')) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['host'], message: 'Windows 镜像条目须指定主机地址' })
  }
  if (v.carrier === 'windows' && v.controlProtocol !== 'win' && v.controlProtocol !== 'none') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['controlProtocol'], message: 'Windows 载体控制协议只接受 win/none' })
  }
  if (v.carrier === 'android') {
    if (v.host === undefined || v.host === '') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['host'], message: 'Android 镜像条目须指定设备序列号或 wifi 地址' })
    }
    if (v.controlProtocol !== 'android' && v.controlProtocol !== 'none') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['controlProtocol'], message: 'Android 载体控制协议只接受 android/none' })
    }
  }
  if (v.carrier === 'host-screen' && v.controlProtocol !== 'host') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['controlProtocol'], message: '宿主屏幕载体控制协议恒为 host（内置注入）' })
  }
})
const imagePatchSchema = imageInputBase.partial().extend({ id: z.string() })
/** 注册 agent（P4 Step 5）：name 必填（去空白 1-24 字）；color hex6 可选；role 默认 worker（steward 走任命事务语义） */
const registerAgentSchema = z.object({
  name: z.string().trim().min(1).max(24),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
  /** 人设（2026-10-18 身份修复）：身份描述一句话——注入系统提示词（群聊不冒充管家） */
  persona: z.string().trim().min(1).max(500).optional(),
  /** 角色档位名（2026-10-18 自定义角色）：呈现留档 */
  roleName: z.string().trim().min(1).max(12).optional(),
  /** Box 数据目录单盒覆盖（2026-10-20 v0.2.0）：目录型后端落盘位置 */
  dataDir: z.string().trim().min(1).max(300).optional(),
  /** 模型覆盖档案名（backlog ③）：可选——引用 providers 档案；悬空显式拒绝（命令面） */
  modelProvider: z.string().trim().min(1).max(64).optional(),
  /** 镜像绑定（P8-4）：可选——引用镜像条目 id；悬空显式拒绝（命令面） */
  imageId: z.string().trim().min(1).max(32).optional(),
  role: z.enum(['steward', 'worker']).optional(),
})
/** 桌面输入动作批次（P8-2 接口化——协议中性词表，renderer 不再拼 xdotool 串；
 *  坐标为真实屏幕坐标语义；button 沿用 X 编号 1=左 2=中 3=右 4=滚轮上 5=滚轮下） */
const screenActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('move'), x: z.number(), y: z.number() }),
  z.object({ kind: z.literal('down'), button: z.number().int().min(1).max(5) }),
  z.object({ kind: z.literal('up'), button: z.number().int().min(1).max(5) }),
  z.object({
    kind: z.literal('click'),
    button: z.number().int().min(1).max(5),
    x: z.number().optional(),
    y: z.number().optional(),
    count: z.number().int().min(1).max(20).optional(),
    intervalMs: z.number().int().min(0).max(500).optional(),
  }),
  z.object({ kind: z.literal('key'), key: z.string().min(1).max(40) }),
  z.object({ kind: z.literal('type'), text: z.string().min(1).max(500), delayMs: z.number().int().min(0).max(200).optional() }),
])
const guiInputSchema = z.object({ boxId: z.string(), actions: z.array(screenActionSchema).min(1).max(64) })

/** 沙箱装配事实（status 命令与 UI 呈现的单一来源；main 内存态，重启随装配重算） */
export interface SandboxStatus {
  /** 沙箱数据目录全局默认（v0.2.0）：缺席 = userData/boxes */
  sandboxDataDir?: string
  /** 生效偏好（env 覆盖后的值——装配决策用的就是它） */
  preference: SandboxPreference
  /** 持久化偏好（settings.json 里的值；与 preference 不等即存在 env 覆盖） */
  stored: SandboxPreference
  /** 装配选择结果（backendId/reason） */
  chosen: ChooseResult
  /** CLI 探测结果（设置页后端清单） */
  probes: BackendProbe[]
  /** WSL 基础镜像查找路径与就绪与否（未就绪时 UI 引导用户放置） */
  rootfsPath: string
  rootfsReady: boolean
  /** 每后端能力声明（P8-4 后 UI 优化）：id → caps——per-backend 呈现的事实源 */
  backendCaps: Record<string, BoxCaps>
}

export interface DesktopKernel {
  readonly kernel: AssembledKernel
  readonly gateway: GatewayHandle
  readonly settings: SettingsStore
  readonly provider: SwitchableChatProvider
  readonly approvalGate: ManualApprovalGate
  readonly sandbox: SandboxStatus
  dispose(): Promise<void>
}

/** 文件存在性（rootfs 是 GB 级二进制——FsAdapter.read 会整读成串，main 装配层直接 stat） */
async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** 宿主磁盘探针（Step 6 压力判定的事实源）：statfs userData 所在卷——
 *  Box 的 vhdx、transcript、快照全落此卷，它的余量即系统的「 sandbox 预算」 */
const hostDiskProbe = (path: string) => async (): Promise<DiskFact | null> => {
  try {
    const st = await statfs(path)
    return { freeBytes: st.bavail * st.bsize, totalBytes: st.blocks * st.bsize }
  } catch {
    return null // 测不到不发事件（压力判定保持上一档——如实）
  }
}

/** mock stats 的 env 注入（P5 Step 7 色档 E2E 的确定性来源）：OPENBOT_MOCK_CPU/MEM/DISK——
 *  数字合法才注入对应字段（非法/缺席 = 缺省确定值 {12/256/1200}，既有 E2E 断言不动） */
function mockStatsEnv(): { stats?: BoxStats } {
  const cpu = Number(process.env.OPENBOT_MOCK_CPU)
  const mem = Number(process.env.OPENBOT_MOCK_MEM)
  const disk = Number(process.env.OPENBOT_MOCK_DISK)
  const stats: BoxStats = {}
  if (Number.isFinite(cpu)) stats.cpuPercent = cpu
  if (Number.isFinite(mem)) stats.memoryMb = mem
  if (Number.isFinite(disk)) stats.diskMb = disk
  return Object.keys(stats).length > 0 ? { stats } : {}
}

/** mock 假 ffmpeg（GUI 实况流 E2E/演示）：OPENBOT_COMPUTER=1 时给 mock 后端注入周期吐帧的
 *  假采集管道——真 ffmpeg 在 Box 内（backend.openPipe 直出帧字节），mock 只演同一条帧流：
 *  1x1 JPEG 每 150ms 一帧（约 6-7fps 的确定性低速帧，够断言「流开、帧到、停流」，不灌爆） */
const MOCK_GUI_JPEG_BASE64 =
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q=='

function mockGuiPipe(): ((boxId: string, spec: PipeSpec) => PipeSession) | undefined {
  if (process.env.OPENBOT_COMPUTER !== '1') return undefined
  const frame = new Uint8Array(Buffer.from(MOCK_GUI_JPEG_BASE64, 'base64'))
  return () => {
    let dataCb: ((chunk: Uint8Array) => void) | null = null
    let exitCb: ((code: number | null) => void) | null = null
    let closed = false
    const timer = setInterval(() => {
      if (!closed && dataCb !== null) dataCb(frame)
    }, 150)
    timer.unref?.()
    return {
      onData: (cb) => {
        dataCb = cb
      },
      onExit: (cb) => {
        exitCb = cb
      },
      stderrTail: () => '',
      write: (_line) => {
        /* 假 ffmpeg 不吃输入 */
      },
      close: () => {
        if (closed) return
        closed = true
        clearInterval(timer)
        exitCb?.(0)
      },
    }
  }
}

/** 会话记录迁移（v0.1.63 自动迁移）：旧根 → 新根，只搬 agents/<id>/transcript.jsonl——
 *  同目录的 profile.json/memory.json 归数据目录侧 store，永不动。两阶段：
 *  ①全量复制（任一失败抛出——旧根无损、标记不写、未切换）；②全部成功后删源 + 清空目录
 *  （删源/清目录失败仅留冗余，无害——任何时刻至少一侧全量） */
function migrateTranscripts(oldRoot: string, newRoot: string): number {
  const oldAgents = `${oldRoot.replaceAll('\\', '/')}/agents`
  const newAgents = `${newRoot.replaceAll('\\', '/')}/agents`
  if (!existsSync(oldAgents)) return 0
  const migrated: Array<{ src: string; srcDir: string }> = []
  for (const entry of readdirSync(oldAgents)) {
    const src = `${oldAgents}/${entry}/transcript.jsonl`
    if (!existsSync(src)) continue
    mkdirSync(`${newAgents}/${entry}`, { recursive: true })
    copyFileSync(src, `${newAgents}/${entry}/transcript.jsonl`)
    migrated.push({ src, srcDir: `${oldAgents}/${entry}` })
  }
  for (const m of migrated) {
    try {
      rmSync(m.src)
    } catch {
      /* 文件占用等——冗余副本留旧位（未读），无害 */
    }
  }
  // 尽力清空搬空的 agent 目录；目录非空（profile/memory 在场）自然保留
  for (const m of migrated) {
    try {
      rmdirSync(m.srcDir)
    } catch {
      /* 非空或占用 */
    }
  }
  return migrated.length
}

/** 数据目录迁移（v0.1.64 自动迁移）：旧目录全家（settings/agent 档案/记忆/账本/transcript——
 *  所有 store 落盘物）→ 新目录；transcript 已独立（data 外）时不在其中，自然不受影响。
 *  两阶段：①cpSync 全量复制（任一失败抛——旧目录无损、标记不写、未切换；目标同名覆盖，
 *  当前数据是真相）；②全部成功后清空旧目录顶层（失败仅留冗余，无害） */
function migrateDataDir(oldDir: string, newDir: string): number {
  if (!existsSync(oldDir)) return 0
  mkdirSync(newDir, { recursive: true })
  const countFiles = (dir: string): number => {
    let n = 0
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) n += countFiles(`${dir}/${e.name}`)
      else n++
    }
    return n
  }
  const files = countFiles(oldDir)
  cpSync(oldDir, newDir, { recursive: true })
  for (const entry of readdirSync(oldDir)) {
    try {
      rmSync(`${oldDir}/${entry}`, { recursive: true, force: true })
    } catch {
      /* 文件占用等——冗余留旧位（标记已指向新目录，不再读），无害 */
    }
  }
  return files
}

/** 装配桌面内核（app ready 后调用；safeStorage 依赖 ready 状态） */
export async function assembleDesktop(): Promise<DesktopKernel> {
  // NodeFs 路径约定 posix 风格（Windows 同样接受 '/'）
  const userDataRoot = app.getPath('userData').replaceAll('\\', '/')

  /** 文本类附件判定（v0.1.102 二期）：mime 前缀 text/ + 常见结构化/代码扩展名——
   *  此类 ≤200KB 注入全文（超限截断加注记），其余存档给路径 */
  const TEXTUAL_EXTS = new Set([
    'txt', 'md', 'markdown', 'json', 'xml', 'yml', 'yaml', 'toml', 'csv', 'ini', 'env',
    'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'c', 'h',
    'cpp', 'hpp', 'cs', 'php', 'sh', 'bash', 'zsh', 'ps1', 'sql', 'html', 'css', 'scss', 'vue', 'log',
  ])
  const isTextualAttachment = (mime: string, path: string): boolean => {
    if (mime.startsWith('text/')) return true
    if (mime === 'application/json' || mime === 'application/xml' || mime === 'application/yaml' || mime === 'application/toml') return true
    const ext = path.includes('.') ? (path.split('.').pop() ?? '').toLowerCase() : ''
    return TEXTUAL_EXTS.has(ext)
  }

  // 数据目录可自定义（UI 优化 0.1.26，用户需求）：userData 根下 data-root.txt 标记承载覆盖路径
  // （标记在数据目录之外——settings.json 随数据目录走，不能自举）；目录探测（建目录+写删探针）
  // 失败如实回退默认。标记读写走 node:fs（userData 根不归数据目录的 NodeFs 实例管）
  const dataRootMarker = `${userDataRoot}/data-root.txt`
  let dataRoot = `${userDataRoot}/data`
  try {
    const custom = (existsSync(dataRootMarker) ? readFileSync(dataRootMarker, 'utf8') : '').trim()
    if (custom !== '') {
      mkdirSync(custom, { recursive: true })
      rmSync(`${custom}/.openbot-root-probe`, { force: true })
      writeFileSync(`${custom}/.openbot-root-probe`, '1')
      rmSync(`${custom}/.openbot-root-probe`, { force: true })
      dataRoot = custom
    }
  } catch (err) {
    // 无标记（ENOENT）= 用户从未自定义——静默走默认；真错误才告警
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      console.warn('[openbot] 自定义数据目录标记读取失败——回退默认目录：', err)
    }
    dataRoot = `${userDataRoot}/data`
  }
  const fs = new NodeFs()
  const settings = new SettingsStore({ fs, root: dataRoot, encrypt: encryptKey, decrypt: decryptKey })
  // 会话记录（transcript）目录独立设置（v0.1.63，用户需求）：transcript-root.txt 标记——同
  // data-root 模式（探测失败如实回退数据目录内）；标记值为 TranscriptStore 的 root，文件落
  // <root>/agents/<agentId>/transcript.jsonl（与数据目录内布局同构）。旧数据不自动迁移
  const transcriptRootMarker = `${userDataRoot}/transcript-root.txt`
  let transcriptRootOverride: string | undefined
  try {
    const customT = (existsSync(transcriptRootMarker) ? readFileSync(transcriptRootMarker, 'utf8') : '').trim()
    if (customT !== '') {
      mkdirSync(customT, { recursive: true })
      rmSync(`${customT}/.openbot-root-probe`, { force: true })
      writeFileSync(`${customT}/.openbot-root-probe`, '1')
      rmSync(`${customT}/.openbot-root-probe`, { force: true })
      transcriptRootOverride = customT
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      console.warn('[openbot] 自定义会话记录目录标记读取失败——回退数据目录内：', err)
    }
    transcriptRootOverride = undefined
  }
  const provider = new SwitchableChatProvider()

  // ---- 沙箱后端选择（plan-p3 Step 5）：偏好 × 探测 × 实现白名单 → 诚实降级 ----
  // env OPENBOT_SANDBOX 覆盖持久化偏好（E2E/演示确定性：mock 隔离真实子系统）；枚举外值忽略
  const envPref = sandboxPrefSchema.safeParse(process.env.OPENBOT_SANDBOX)
  const preference = envPref.success ? envPref.data : await settings.getSandbox()
  // rootfs 查找顺序：env OPENBOT_WSL_ROOTFS > userData/box-rootfs.tar.gz
  const rootfsPath = process.env.OPENBOT_WSL_ROOTFS ?? `${userDataRoot}/box-rootfs.tar.gz`
  const rootfsReady = await fileExists(rootfsPath)
  // nspawn 同一「rootfs 导入」模型（P6 Step 3）：env 独立覆盖，缺省与 wsl 共用同一 tarball
  const nspawnRootfsPath = process.env.OPENBOT_NSPAWN_ROOTFS ?? `${userDataRoot}/box-rootfs.tar.gz`
  const nspawnRootfsReady = await fileExists(nspawnRootfsPath)
  // OCI 默认镜像（P5 Step 5/6）：env 按后端分别覆盖（国内网络/私有 registry 确定性）
  const dockerImage = process.env.OPENBOT_DOCKER_IMAGE ?? 'ubuntu:24.04'
  const podmanImage = process.env.OPENBOT_PODMAN_IMAGE ?? 'ubuntu:24.04'
  // UTM 模板 VM 名（P6 Step 4：UTM 是模板克隆模型，无 rootfs 导入——模板在 UTM GUI 预建）
  const utmTemplate = process.env.OPENBOT_UTM_TEMPLATE ?? 'openbot-template'
  // SSH 载体连接事实（plan-image-firstclass P8-1，裁定 B env 接入）：host 缺席时探测只验
  // CLI 在场，sshReady=false 防 auto/显式偏好误选（chooseBackend 如实回退 mock 带原因）
  const sshHost = process.env.OPENBOT_SSH_HOST ?? ''
  const sshPortRaw = Number(process.env.OPENBOT_SSH_PORT)
  const sshPort = Number.isFinite(sshPortRaw) && sshPortRaw > 0 ? sshPortRaw : 22
  const sshUser = process.env.OPENBOT_SSH_USER
  const sshKeyPath = process.env.OPENBOT_SSH_KEY
  const sshOpts =
    sshHost !== ''
      ? {
          host: sshHost,
          port: sshPort,
          ...(sshUser !== undefined && sshUser !== '' ? { user: sshUser } : {}),
          ...(sshKeyPath !== undefined && sshKeyPath !== '' ? { keyPath: sshKeyPath } : {}),
        }
      : undefined
  // 平台化探测与择优序（P6 Step 5）：win 只探 wsl、linux 只探 nspawn、mac 只探 utm——
  // 异平台 CLI 必然不在，跑了也是噪音；auto 序随之（win wsl 主力/linux nspawn 优先/mac utm 优先）；
  // ssh 三平台皆可能在场照探（P8-1），且永不在 auto 序内——远端机器是显式 opt-in
  const platform = process.platform
  const _bootT0 = Date.now()
  const _lap = (tag: string): void => console.log(`[openbot] 启动耗时 ${Date.now() - _bootT0}ms @${tag}`)
  _lap('begin-probes')
  const probes = await probeAll(runProcess, platform, sshOpts)
  _lap('probes-done')
  const platformOrder: Record<string, Array<'wsl' | 'docker' | 'podman' | 'nspawn' | 'utm'>> = {
    win32: ['wsl', 'docker', 'podman'],
    linux: ['nspawn', 'docker', 'podman'],
    darwin: ['utm', 'docker', 'podman'],
  }
  const chosen = chooseBackend(preference, probes, {
    wslRootfs: rootfsReady,
    nspawnRootfs: nspawnRootfsReady,
    sshReady: sshHost !== '',
    // nspawn/utm 随 P6 Step 3/4 兑现、ssh 随 plan-image-firstclass P8-1 兑现——CLI 语义单测
    // 锁死，真机链路经 OPENBOT_TEST_SSH 门控套件验收
    implemented: ['mock', 'wsl', 'docker', 'podman', 'nspawn', 'utm', 'ssh'],
    order: platformOrder[platform] ?? ['wsl', 'docker', 'podman'],
  })
  const mockPipe = mockGuiPipe()
  // ---- 装配期后端可用性预检（v0.1.51 用户裁定：沙箱故障绝不炸启动——生产事故级防线）----
  // 探测（probes）只验 CLI 在场；create 才暴露真实故障（vhdx 挂载失败/守护进程僵死/权限）。
  // 真实 create+teardown 探测：失败 → 告警 + 全局后端降级 mock（应用照常起，状态栏如实「模拟」）。
  // 沙箱数据目录（2026-10-20 v0.2.0；同日行级化）：per-runtime 优先（wsl2/nspawn），
  // legacy 全局 sandboxDataDir 降为 wsl2 兼容回退——缺席 userData/boxes
  const wslDataDir =
    (await settings.getRuntimeDataDir('wsl2')) ?? (await settings.getSandboxDataDir()) ?? `${userDataRoot}/boxes`
  const nspawnDataDir = (await settings.getRuntimeDataDir('nspawn')) ?? `${userDataRoot}/boxes`
  const sandboxDataDir = wslDataDir // nspawn 快照单独取（下行），此名保留给快照表达式引用处
  let backend: BoxBackend =
    chosen.backendId === 'wsl'
      ? new WslBoxBackend({ rootfs: rootfsPath, dir: wslDataDir, now: Date.now })
      : chosen.backendId === 'docker'
        ? new DockerBoxBackend({ image: dockerImage, now: Date.now })
        : chosen.backendId === 'podman'
          ? new PodmanBoxBackend({ image: podmanImage, now: Date.now })
          : chosen.backendId === 'nspawn'
            ? new NspawnBoxBackend({
                rootfs: nspawnRootfsPath,
                snapshotDir: `${nspawnDataDir}/nspawn-snapshots`,
                // 特权前缀默认无（polkit/sudo NOPASSWD 是部署策略——platforms.md 记档，真机调优后置）
                now: Date.now,
              })
            : chosen.backendId === 'utm'
              ? new UtmBoxBackend({ template: utmTemplate, now: Date.now })
              : chosen.backendId === 'ssh'
                ? new SshBoxBackend({
                    host: sshOpts!.host,
                    port: sshOpts!.port,
                    ...(sshOpts!.user !== undefined ? { user: sshOpts!.user } : {}),
                    ...(sshOpts!.keyPath !== undefined ? { keyPath: sshOpts!.keyPath } : {}),
                    workdir: '/work',
                    now: Date.now,
                  })
                : new MockBoxBackend({ now: Date.now, ...mockStatsEnv(), ...(mockPipe !== undefined ? { pipe: mockPipe } : {}) })
  if (chosen.backendId !== 'mock') {
    _lap('preflight-begin')
    // 轻量化（v0.1.57）：已有 Box 用发行版 exec true 探活（毫秒级）；仅零 Box 才真
    // import probe——首启保护不变，常态启动不再重复解压 1.27GB rootfs（实测 21.5s 纯浪费）。
    // v0.1.117d 韧化（用户真机实锤「Box 不存在：box-4」→ 整启动被降级 mock）：单盒账实不符
    // （发行版瞬时缺席/wsl -l 时序波动）≠ 后端坏——逐盒探活，NOT_FOUND 跳过换下一个；
    // 全部缺席 → probe create 通路验真；仅真执行故障（超时/VM 挂死）才降级 mock
    try {
      const existing = await backend.list()
      let probed = false
      for (const box of existing) {
        try {
          await backend.exec(box.boxId, { command: ['true'], timeoutMs: 120_000 })
          probed = true
          break
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          if (msg.includes('Box 不存在')) {
            console.warn(`[openbot] 预检跳过 ${box.boxId}（账实不符——发行版缺席，非后端故障）`)
            continue
          }
          throw err
        }
      }
      if (!probed && existing.length === 0) {
        const probeBox = await backend.create({ image: 'backend-probe' })
        await backend.teardown(probeBox)
      }
      _lap('preflight-done')
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      console.warn(`[openbot] 沙箱后端（${chosen.backendId}）预检失败——本次启动降级模拟环境：${reason}`)
      backend = new MockBoxBackend({ now: Date.now, ...mockStatsEnv(), ...(mockPipe !== undefined ? { pipe: mockPipe } : {}) })
    }
  }
  // 镜像注册表（plan-image-firstclass P8-3）：镜像条目获得一等公民地位——Agent 绑定镜像
  // 而非后端（绑定随 P8-4）。路由后端包一层多路 facade：镜像条目 id → 后端实例（container
  // 条目复用全局 OCI 底座、create 时把路由 id 改写为实际镜像名；ssh 条目独立 SshBoxBackend）。
  // 路由表运行时可变（add/remove 即时生效——按调用分发无状态，与沙箱偏好的装配期决策不同）
  const imageStore = new ImageStore({ fs, root: dataRoot, now: Date.now })
  const routingBackend = new RoutingBoxBackend({ fallback: backend })
  // ---- 宿主屏幕载体（plan-screen-firstclass P9-1/P9-2）----
  // 纯屏幕 Box（记账面）+ 内置注入适配器 + 路由器：kernel.screen 按 boxId 分发（宿主屏幕 →
  // HostScreenControl；其余 → X11 经 routedBackend exec）——消费方（工具族/实况/gui 命令面）
  // 零载体感知。Electron 面（desktopCapturer/screen API/帧泵）收口 bridge 注入，boxes 零
  // electron 依赖。P9-2 起每条目一 box 一适配器（窗口绑定条目是不同的桌面面）。
  const hostScreenBackend = new HostScreenBoxBackend({ now: Date.now })
  let hasHostScreenRoute = false
  /** 网关开启标记（P9-3a 真机验收修正）：开启后 registerImageRoute 的在场性门可运行时
   *  翻转（ensureComputerTools 补注册）——装配期的注册归装配尾段静态分支（switchableGate 时序） */
  let gatewayStarted = false
  const hostScreenControls = new Map<string, HostScreenControl>()
  const primaryPhysical = (): { width: number; height: number } | null => {
    try {
      const d = electronScreen.getPrimaryDisplay()
      return { width: Math.round(d.size.width * d.scaleFactor), height: Math.round(d.size.height * d.scaleFactor) }
    } catch {
      return null // 桌面会话不可用——如实（act/采集路径各自给出可见错误）
    }
  }
  const hostScreenBridge: HostScreenBridge = {
    // 主屏物理像素（DIP × scaleFactor——desktopCapturer 采集与 SendInput 同一坐标系）
    geometry: () => primaryPhysical(),
    captureFrame: async ({ maxWidth, quality, crop, png }) => {
      const geo = primaryPhysical()
      if (geo === null) throw new KernelError('SCREEN_CAPTURE_FAILED', '桌面会话不可用——无法采集主屏')
      const width = Math.min(maxWidth, geo.width)
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width, height: Math.max(1, Math.round((geo.height * width) / geo.width)) },
      })
      let img = sources[0]?.thumbnail
      if (img === undefined || img.isEmpty()) {
        throw new KernelError('SCREEN_CAPTURE_FAILED', '无可用屏幕采集源（thumbnail 为空）')
      }
      if (crop !== undefined) {
        // 窗口绑定裁剪（P9-2）：物理像素矩形 → 缩略图坐标（缩略图按 width/geo.width 缩放）
        const k = img.getSize().width / geo.width
        const rx = Math.max(0, Math.round(crop.x * k))
        const ry = Math.max(0, Math.round(crop.y * k))
        const rw = Math.min(Math.round(crop.width * k), img.getSize().width - rx)
        const rh = Math.min(Math.round(crop.height * k), img.getSize().height - ry)
        if (rw <= 0 || rh <= 0) throw new KernelError('SCREEN_CAPTURE_FAILED', '绑定窗口区域不在屏幕内（可能已最小化）')
        img = img.crop({ x: rx, y: ry, width: rw, height: rh }) // 普通 Rectangle 形状对象
        if (img.isEmpty()) throw new KernelError('SCREEN_CAPTURE_FAILED', '窗口裁剪后为空（窗口不可见？）')
      }
      const size = img.getSize()
      // png（v0.1.117）：静态截图回喂走 PNG（端点对 jpeg 报 unsupported image 400）；
      // 缺省 jpeg 保持——GUI 视频流（mjpeg）依赖
      return { bytes: new Uint8Array(png === true ? img.toPNG() : img.toJPEG(quality)), width: size.width, height: size.height }
    },
    // L2 零依赖帧泵（P9-2 裁定 D）：隐藏窗口 getUserMedia → JPEG 帧序列（mjpeg 管线直用）
    startFrameStream: (onFrame) => startHostScreenFramePump({ maxWidth: 1600, onFrame }),
  }
  /** 每条目一适配器（窗口绑定 per-entry；同 id 重注册 = 替换旧实例——windowTitle 可能已改） */
  const hostScreenControlFor = (entry: ImageEntry): HostScreenControl => {
    const existing = hostScreenControls.get(entry.id)
    if (existing !== undefined) return existing
    const ctrl = new HostScreenControl({
      bridge: hostScreenBridge,
      ...(entry.windowTitle !== undefined ? { windowTitle: entry.windowTitle } : {}),
    })
    hostScreenControls.set(entry.id, ctrl)
    return ctrl
  }
  // Windows 机内（P9-3a）：per-entry 后端 + 屏幕适配器（boxId = win-<host> 同主机共享桌面面）
  let hasWindowsRoute = false
  const winBackends = new Map<string, SshWindowsBoxBackend>()
  const winScreens = new Map<string, SshWindowsScreenControl>()
  // Android 设备（P9-3b）：per-entry 后端 + 屏幕适配器（boxId = adb-<serial> 同设备共享）
  let hasAndroidRoute = false
  const adbBackends = new Map<string, AdbBoxBackend>()
  const adbScreens = new Map<string, AdbScreenControl>()
  const x11ScreenControl = new X11ScreenControl({
    host: routingBackend,
    ...(process.env.OPENBOT_GUI_DISPLAY !== undefined ? { display: process.env.OPENBOT_GUI_DISPLAY } : {}),
  })
  const screenRouter = new ScreenControlRouter({
    resolve: (boxId) => {
      const entryId = entryIdOfBoxId(boxId)
      const hit = entryId !== null ? hostScreenControls.get(entryId) : undefined
      return hit ?? winScreens.get(boxId) ?? adbScreens.get(boxId) ?? x11ScreenControl
    },
    adapters: () => [x11ScreenControl, ...hostScreenControls.values(), ...winScreens.values(), ...adbScreens.values()],
  })
  /** 窗口清单探测（v1.hostscreen.windows——懒建单例通道，随应用退出 dispose） */
  let windowProbe: HostScreenControl | null = null
  /** 宿主 ffmpeg 在场性已内聚 HostScreenControl.streamTier（P9-2 三档判定单一来源） */
  /** per-CLI OCI 后端（v0.1.52 容器条目解耦全局后端）：docker 优先、podman 次之；
   * 惰性构造缓存（无状态 facade，一个 CLI 一个实例）。mock 强制沙箱（E2E 隔离）返回 null
   *  ——不真建容器，OPENBOT_SANDBOX=mock 语义不变。CLI 均不在场也返回 null（test 如实报） */
  const ociBackends = new Map<'docker' | 'podman', BoxBackend>()
  const ociBackendFor = (declared?: 'docker' | 'podman'): BoxBackend | null => {
    if (chosen.backendId === 'mock') return null // E2E 强制沙箱隔离纪律——不真建容器
    // v0.1.53 用户裁定「不自动找路」：条目显式声明 runtime 按声明走；缺省（旧条目）回退 docker 优先探测（一次性迁移语义——编辑保存后带上声明）
    const pick: 'docker' | 'podman' | null =
      declared !== undefined ? declared : probes.find((x) => x.id === 'docker')?.available
        ? 'docker'
        : probes.find((x) => x.id === 'podman')?.available
          ? 'podman'
          : null
    if (pick === null) return null
    let hit = ociBackends.get(pick)
    if (hit === undefined) {
      hit = pick === 'docker' ? new DockerBoxBackend({ image: dockerImage, now: Date.now }) : new PodmanBoxBackend({ image: podmanImage, now: Date.now })
      ociBackends.set(pick, hit)
    }
    return hit
  }

  const registerImageRoute = (entry: ImageEntry): void => {
    if (entry.carrier === 'ssh') {
      routingBackend.registerRoute(entry.id, {
        backend: new SshBoxBackend({
          host: entry.host ?? '',
          ...(entry.port !== undefined ? { port: entry.port } : {}),
          ...(entry.user !== undefined ? { user: entry.user } : {}),
          ...(entry.keyPath !== undefined ? { keyPath: entry.keyPath } : {}),
          workdir: '/work',
          now: Date.now,
        }),
      })
    } else if (entry.carrier === 'host-screen') {
      // P9-2：每条目一 box 一适配器（窗口绑定 per-entry）；同 id 重注册替换旧适配器
      const old = hostScreenControls.get(entry.id)
      if (old !== undefined) {
        old.dispose()
        hostScreenControls.delete(entry.id)
      }
      hostScreenControlFor(entry)
      routingBackend.registerRoute(entry.id, { backend: hostScreenBackend })
      hasHostScreenRoute = true
      if (gatewayStarted) ensureComputerTools('宿主屏幕条目运行中注册（内置注入）')
    } else if (entry.carrier === 'windows') {
      // Windows 机内（P9-3a）：per-entry 后端（同主机 boxId 收敛——同一桌面面同一适配器）
      const boxId = windowsBoxId(entry.host ?? '')
      let backend = winBackends.get(boxId)
      if (backend === undefined) {
        backend = new SshWindowsBoxBackend({
          host: entry.host ?? '',
          ...(entry.port !== undefined ? { port: entry.port } : {}),
          ...(entry.user !== undefined ? { user: entry.user } : {}),
          ...(entry.keyPath !== undefined ? { keyPath: entry.keyPath } : {}),
          workdir: 'C:\\openbot-work',
          now: Date.now,
        })
        winBackends.set(boxId, backend)
      }
      if (!winScreens.has(boxId)) {
        winScreens.set(boxId, new SshWindowsScreenControl({ host: backend }))
      }
      routingBackend.registerRoute(entry.id, { backend })
      if (entry.controlProtocol === 'win') {
        hasWindowsRoute = true
        if (gatewayStarted) ensureComputerTools('Windows 机内条目运行中注册（PowerShell SendInput）')
      }
    } else if (entry.carrier === 'android') {
      // Android 设备（P9-3b）：per-entry 后端 + 屏幕适配器（同序列号收敛——同一设备面）
      const boxId = adbBoxId(entry.host ?? '')
      let backend = adbBackends.get(boxId)
      if (backend === undefined) {
        backend = new AdbBoxBackend({ host: entry.host ?? '', now: Date.now })
        adbBackends.set(boxId, backend)
      }
      if (!adbScreens.has(boxId)) {
        adbScreens.set(boxId, new AdbScreenControl({ host: backend }))
      }
      routingBackend.registerRoute(entry.id, { backend })
      if (entry.controlProtocol === 'android') {
        hasAndroidRoute = true
        if (gatewayStarted) ensureComputerTools('Android 设备条目运行中注册（input 注入）')
      }
    } else if (entry.carrier === 'container') {
      // 容器条目解耦全局后端（v0.1.52 用户裁定「不再选默认沙箱，最终选屏幕」）：按 CLI 探测
      // 构造 per-CLI OCI 后端（docker 优先），不要求全局默认后端是 OCI——wsl 默认下绑 GUI 容器
      // 镜像照样路由（屏幕在容器内）。mock 强制沙箱（E2E 隔离）不做 per-CLI 路由——不真建容器。
      const oci = ociBackendFor(entry.runtime)
      if (oci !== null) {
        routingBackend.registerRoute(entry.id, {
          backend: oci,
          translate: (spec) => ({ ...spec, image: entry.image ?? dockerImage }),
        })
      }
      // docker/podman CLI 均不在场：不注册路由（v1.images.test 如实报告不可路由）
    }
  }
  for (const entry of await imageStore.list()) registerImageRoute(entry)
  /** 连接测试（D3——v1.images.test 的探测报告，如实不造假）：
   *  ssh = 真实 attach（连通验证 + 工作目录）→ x11 协议加测 GUI 工具集 → 断开；
   *  container = 按 CLI 查镜像在场（docker inspect / podman exists）；底座非 OCI 如实报告不可路由 */
  const testImageEntry = async (entry: ImageEntry): Promise<{ ok: boolean; detail?: string; reason?: string }> => {
    if (entry.carrier === 'host-screen') {
      // 宿主屏幕：几何（窗口绑定=窗口矩形）+ 实况三档如实报告（无真实注入，测试零副作用）
      const ctrl = hostScreenControlFor(entry)
      const geo = await ctrl.geometry(entry.id)
      if (geo === null) {
        return {
          ok: false,
          reason:
            entry.windowTitle !== undefined
              ? `绑定窗口未在场（标题含「${entry.windowTitle}」）`
              : '宿主屏幕几何不可用（桌面会话未就绪）',
        }
      }
      const tier = await ctrl.streamTier()
      const tierText =
        tier === 'l1'
          ? 'h264（L1·ffmpeg 在场）'
          : tier === 'l2'
            ? 'mjpeg 帧泵（L2·零依赖）'
            : 'mjpeg 轮询（L0·兜底）'
      const surface = entry.windowTitle !== undefined ? `窗口「${entry.windowTitle}」 ${geo.width}×${geo.height}` : `主屏 ${geo.width}×${geo.height}`
      return { ok: true, detail: `宿主屏幕就绪（${surface} 物理像素）；实况流 ${tierText}` }
    }
    if (entry.carrier === 'windows') {
      // Windows 机内（P9-3a）：真实 attach（连通 + 工作目录）→ win 协议加测屏幕几何
      // （PS 截屏能力随连通+桌面会话在场即成立——如实报告）→ 断开（零远端副作用）
      const probe = new SshWindowsBoxBackend({
        host: entry.host ?? '',
        ...(entry.port !== undefined ? { port: entry.port } : {}),
        ...(entry.user !== undefined ? { user: entry.user } : {}),
        ...(entry.keyPath !== undefined ? { keyPath: entry.keyPath } : {}),
        workdir: 'C:\\openbot-work',
        now: Date.now,
      })
      try {
        const boxId = await probe.create({ image: entry.id })
        let detail = 'Windows 主机连接正常（PowerShell 就绪）'
        if (entry.controlProtocol === 'win') {
          const probeScreen = new SshWindowsScreenControl({ host: probe })
          const geo = await probeScreen.geometry(boxId)
          detail +=
            geo !== null
              ? `；屏幕 ${geo.width}×${geo.height}（注入能力就绪——SendInput）`
              : '；屏幕几何不可得（桌面会话未登录或 PS 受限——注入能力待真机核）'
        }
        await probe.teardown(boxId)
        return { ok: true, detail }
      } catch (err) {
        return { ok: false, reason: (err instanceof Error ? err.message : String(err)).slice(0, 200) }
      }
    }
    if (entry.carrier === 'android') {
      // Android 设备（P9-3b）：真实 attach（adb 连通 + 工作目录）→ android 协议加测屏幕几何
      const probe = new AdbBoxBackend({ host: entry.host ?? '', now: Date.now })
      try {
        const boxId = await probe.create({ image: entry.id })
        let detail = 'Android 设备连接正常（adb 就绪）'
        if (entry.controlProtocol === 'android') {
          const probeScreen = new AdbScreenControl({ host: probe })
          const geo = await probeScreen.geometry(boxId)
          detail +=
            geo !== null
              ? `；屏幕 ${geo.width}×${geo.height}（注入能力就绪——input 命令）`
              : '；屏幕几何不可得（wm size 失败——设备碎片化或未点亮）'
        }
        await probe.teardown(boxId)
        return { ok: true, detail }
      } catch (err) {
        return { ok: false, reason: (err instanceof Error ? err.message : String(err)).slice(0, 200) }
      }
    }
    if (entry.carrier === 'ssh') {
      const probe = new SshBoxBackend({
        host: entry.host ?? '',
        ...(entry.port !== undefined ? { port: entry.port } : {}),
        ...(entry.user !== undefined ? { user: entry.user } : {}),
        ...(entry.keyPath !== undefined ? { keyPath: entry.keyPath } : {}),
        workdir: '/work',
        now: Date.now,
      })
      try {
        const boxId = await probe.create({ image: entry.id })
        let detail = 'SSH 连接正常'
        if (entry.controlProtocol === 'x11') {
          const toolset = await probeX11Toolset(probe, boxId)
          detail += toolset ? '；GUI 工具集在场（xdotool/scrot）' : '；GUI 工具集未检出（可在远端跑 tools/provision-gui.sh）'
        }
        await probe.teardown(boxId)
        return { ok: true, detail }
      } catch (err) {
        return { ok: false, reason: (err instanceof Error ? err.message : String(err)).slice(0, 200) }
      }
    }
    // 容器条目（v0.1.52 解耦全局后端）：per-CLI 查镜像在场（docker 优先——同 registerImageRoute
    // 路由源）；mock 强制沙箱（E2E 隔离）/ CLI 均不在场 如实报告不可路由
    if (entry.carrier === 'container' && ociBackendFor() === null) {
      return { ok: false, reason: 'Docker/Podman CLI 均不可用——容器镜像条目不可路由（安装后重试）' }
    }
    const cli = entry.carrier === 'container'
      ? (probes.find((x) => x.id === 'docker')?.available ? 'docker' : 'podman')
      : '' // 非 container 载体已在前序分支 return，此分支恒为 container——类型收窄保持 args 分支简单
    const args = cli === 'podman' ? ['image', 'exists', entry.image ?? ''] : ['image', 'inspect', entry.image ?? '']
    try {
      const r = await runProcess({ command: [cli, ...args], timeoutMs: 20_000 })
      return r.exitCode === 0
        ? { ok: true, detail: `镜像在场（${cli}）：${entry.image}` }
        : { ok: false, reason: `镜像不存在（${cli}）：${entry.image}——先构建或拉取` }
    } catch (err) {
      return { ok: false, reason: `镜像查询失败：${err instanceof Error ? err.message : String(err)}` }
    }
  }
  const routedBackend: BoxBackend = routingBackend
  // stored 初值现读；status 命令每次现读（set 后无需改内存——重启才生效，呈现以 settings 为真相）
  // 每后端 caps 表（P8-4 后 UI 优化）：per-backend 呈现的事实源（常量即声明，零构造开销）
  /** 运行时安装单并发守卫（v0.2.0 一键安装）+ 取消控制器（2026-10-20 流量敏感客户） */
  let runtimeInstallBusy = false
  let runtimeInstallAbort: AbortController | null = null
  /** 启动等待单飞（2026-10-27 v0.1.89）：per-runtime 在途守卫 + 取消控制器
   *  （取消 = 停轮询——DD detached 已拉起进程不杀；machine-start 子进程随 abort 即杀） */
  const runtimeLaunchBusy = new Set<string>()
  const runtimeLaunchAborts = new Map<string, AbortController>()
  /** mock-runtime 生命周期台账（E2E 对称，2026-10-27）：装完即 installed / launch ready 即 running
   *  ——模拟 DD 完整生命周期；在事件回调内同步置位（早于渲染层刷新拉取，免竞态读到旧态）。
   *  mock-runtime-mm（v0.1.130 vmnotfound 用例）：装完 installed + 恒 stopped + machine-missing
   *  note——podman 全新安装形态的 mock 对称（done 模态/行状态的「需初始化」分流断言源） */
  let mockRuntimeInstalled = false
  let mockRuntimeEngineRunning = false
  let mockRuntimeMmInstalled = false
  /** 引擎看门狗（2026-10-27 v0.1.90）：选定后端 docker/podman 时周期探测——外部掉线/恢复
   *  经 v1.runtime.engine 跃迁通知；随应用退出 stop（孤儿定时器不留） */
  let engineWatchdog: EngineWatchdogHandle | null = null
  const sandboxStatus: SandboxStatus = {
    preference,
    stored: await settings.getSandbox(),
    chosen,
    probes,
    rootfsPath,
    rootfsReady,
    backendCaps: {
      wsl: WSL_BOX_CAPS,
      docker: OCI_BOX_CAPS,
      podman: OCI_BOX_CAPS,
      nspawn: NSPAWN_BOX_CAPS,
      utm: UTM_BOX_CAPS,
      ssh: SSH_BOX_CAPS,
      mock: MOCK_BOX_CAPS,
    },
  }

  let approvalGate!: ManualApprovalGate
  /** 可切换审批闸门（2026-09-06 预算打穿问用户 + composer 审批模式下拉）：
   *  manual=变更前确认（ManualApprovalGate 弹窗）/ auto=完全访问（AutoApprovalGate 自动批准
   *  账本照记）；composer 下拉热切换（setMode），默认 manual（安全默认） */
  let switchableGate!: SwitchableApprovalGate
  // 记忆存储（backlog ①）：单一实例供装配（工具+注入）与命令面共用
  const memoryStore = new MemoryStore({ fs, root: dataRoot })
  // 定时自动化（backlog ②）：Scheduler 扫描到点 → 以用户身份发消息（复用 user lane 全管线）。
  // 错过跳过（裁定 B——nextAfter 从上次触发点向前找，应用关闭期间的自然跳过）；托盘常驻是运行前提
  const automationStore = new AutomationStore({ fs, root: dataRoot, now: Date.now })
  /** 插件市场官方目录（内置索引——app 资源内；P2 接远端 URL 索引） */
  const pluginsMarketDir = `${app.getAppPath()}/resources/plugins`

  // ---- computer-use 接管锁（plan-computer-use Step 5）：壳层内存态，不进内核协议 ----
  // 用户接管中：computer 动作工具的 waitTurn 挂起（形态同审批挂起）；「交还」放行。
  // 锁状态经事件下发（GUI 视图呈现「你已接管」+ agent 挂起卡）
  let takeoverWaiters: Array<() => void> = []
  let takeoverHeld = false
  const guiLock = {
    waitTurn: async (): Promise<void> => {
      if (!takeoverHeld) return
      console.log('[openbot] computer-use：用户接管中——agent 动作挂起')
      await new Promise<void>((resolve) => takeoverWaiters.push(resolve))
    },
  }
  const guiTakeover = (held: boolean): void => {
    takeoverHeld = held
    kernel.bus.emit('v1.box.gui-takeover', { held })
    if (!held) {
      const waiters = takeoverWaiters
      takeoverWaiters = []
      for (const w of waiters) w()
      console.log('[openbot] computer-use：已交还 agent——挂起动作继续')
    }
  }
  // 注册门（plan-image-firstclass P8-2 C4 生产门兑现）：env OPENBOT_COMPUTER=1 是强制门
  //（E2E/显式开启）；生产门 = GUI 工具集探测 ∩ 主力 provider 视觉声明，在名册装配后探测
  // 注册（见下方 addAgent 之后——探测需要 Box 在场）。enabled 是运行时可变事实（v1.box.gui.state）
  let computerEnabled = process.env.OPENBOT_COMPUTER === '1'
  /** 工具族已注册标记（ensureComputerTools 幂等判据——与使能判据分离，v0.1.38 回归修复） */
  let computerRegistered = false
  // 执行预算（2026-11-01 设置页策略区）：装配期读一次（改动重启生效——与沙箱偏好同语义）
  const maxToolRoundsCfg = await settings.getMaxToolRounds()
  const runDeadlineMin = await settings.getRunDeadlineMin()
  const kernel = assembleKernel({
    fs,
    root: dataRoot,
    // 附件本体读取（v0.1.102 图片一期）：FsAdapter 只读 utf8——图片 base64 走 node:fs 直读；
    // 读取面恒限 attachments 目录（渲染层传来的 path 先校验再读——不开放任意盘读）
    loadAttachment: (meta) => {
      const dir = `${userDataRoot}/attachments`
      const resolved = resolve(meta.path).replaceAll('\\', '/')
      if (!resolved.startsWith(`${dir}/`)) return Promise.resolve(null)
      try {
        const bytes = readFileSync(resolved)
        // 图片预压缩（v0.1.115b 图片 400 报障根治）：最长边 >2048 等比缩放（nativeImage——
        // Electron 内置零依赖）。3200 万像素级原图超视觉端点分辨率上限被首发即拒
        // （.messages[N].image[0] 400——用户实测 4762×6735）；缩放统一转 PNG（mime 同步
        // 修正，防 PNG 数据标原 mime 被拒）。2048 长边在视觉理解与各端点安全区之间；
        // 原图仍在盘（存档/全览不受影响）
        if (meta.mime.startsWith('image/')) {
          const img = nativeImage.createFromPath(resolved)
          const { width, height } = img.getSize()
          const MAX_EDGE = 2048
          if (width > MAX_EDGE || height > MAX_EDGE) {
            const scale = MAX_EDGE / Math.max(width, height)
            const resized = img.resize({ width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) })
            return Promise.resolve({ base64: resized.toPNG().toString('base64'), mime: 'image/png' })
          }
        }
        const base64 = bytes.toString('base64')
        // 文本类（二期）：一并给 utf8 文本（runner 注入用——解码归壳层，runner 保持环境无关）
        const text = isTextualAttachment(meta.mime, meta.path) ? bytes.toString('utf8') : undefined
        return Promise.resolve({ base64, ...(text !== undefined ? { text } : {}) })
      } catch {
        return Promise.resolve(null)
      }
    },
    // agent 附图落盘（v0.1.118 截图直发）：run 最后一张净化截图随终答——与上传同款
    // sha256 内容寻址（同图零拷贝去重）；命名截图时间戳（用户气泡呈现原名）
    saveAgentImage: async (agentId, image) => {
      try {
        const bytes = Buffer.from(image.base64, 'base64')
        if (bytes.length === 0 || bytes.length > 8 * 1024 * 1024) return null
        const dir = `${userDataRoot}/attachments`
        mkdirSync(dir, { recursive: true })
        const id = createHash('sha256').update(bytes).digest('hex')
        const ext = image.mime === 'image/png' ? 'png' : image.mime === 'image/jpeg' ? 'jpg' : 'bin'
        const path = `${dir}/${id}.${ext}`
        if (!existsSync(path)) writeFileSync(path, bytes)
        const ts = new Date()
        const pad = (n: number): string => String(n).padStart(2, '0')
        const name = `截图-${ts.getFullYear()}${pad(ts.getMonth() + 1)}${pad(ts.getDate())}-${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}.${ext}`
        return { id, name, mime: image.mime, size: bytes.length, path }
      } catch {
        return null // 落盘失败如实不带附件（终答照常投递）
      }
    },
    // 用量采集落盘（会话引擎 v2 · P1 UsageLedger）：runner 上报 → data/agents/<id>/usage.jsonl
    // append（水位条/密度校准数据源；usage 是遥测——不进事件总线，读取走 v1.usage.latest 命令）
    recordUsage: (agentId, usage, model) => {
      try {
        const dir = `${userDataRoot}/data/agents/${agentId}`
        mkdirSync(dir, { recursive: true })
        appendFileSync(
          `${dir}/usage.jsonl`,
          `${JSON.stringify({ at: Date.now(), model, ...usage })}\n`,
        )
      } catch {
        // 采集失败静默（遥测不阻塞主链路）
      }
    },
    // 附件注入预算分档（v0.1.111）：随模型窗口档位（capabilities.context1M）——在 coordinator
    // 装配处与 supportsImagesOf 同位直算（llms 能力注册表在那），desktop 不另注入
    // 会话记录独立根（v0.1.63）：缺省 undefined = 随 dataRoot（现行为零变化）
    transcriptRoot: transcriptRootOverride,
    // 镜像路由后端（P8-3）：镜像条目 id → 后端实例的多路 facade——services/工具族零改动
    backend: routedBackend,
    // 桌面控制路由器（P9-1）：按 boxId 分发 X11/宿主屏幕——coordinator 内置 X11 缺省面被覆盖
    screen: screenRouter,
    // save/recall 工具 + 会话装配「此前记忆」注入（每轮同步读缓存；addAgent 预载）
    memory: memoryStore,
    // run 策略（2026-09-06 进展驱动 grace 语义；2026-11-02 时长三段值域）：grace = 无进展
    // 5 分钟才逃逸（慢模型长思考/多轮工具循环在动就不算停滞——保留，真卡死的检测）；
    // deadline = 总时长上限——settings -1 = 无限制（缺省，→ Infinity：sched 的 deadline
    // 判定是比较式非定时器，永假天然不触发，内核零改动）；0 为旧语义（无限制）一并归一
    runPolicy: { graceMs: 300_000, deadlineMs: runDeadlineMin <= 0 ? Number.POSITIVE_INFINITY : runDeadlineMin * 60_000 },
    // 工具轮预算（2026-11-02 三段值域：-1 无限制 / 0 禁用工具 / 1~1024 轮数）：复杂任务
    // （装环境/多文件/调试）合法轮数多——非零上限打穿时经审批闸门问用户续期 + 收尾轮交代，
    // 不再无声失败。-1 → Infinity（round > Infinity 永假，内核零改动）；0 原样传 runner
    // （LLM 请求不带工具定义——真禁用）。装配期读一次 + 设置命令热应用，两路幂等
    maxToolRounds: maxToolRoundsCfg === -1 ? Number.POSITIVE_INFINITY : maxToolRoundsCfg,
    // 真实时钟：确定性断言只存在于内核测试与 CLI（plan-p2 风险与地雷）
    approvalGateFactory: (deps) => {
      approvalGate = new ManualApprovalGate(deps)
      // 可切换包装（manual 内件 = factory 产物；auto 内件共用 bus/ledger——幂等账本同一份）
      const autoSeq = { n: 0 }
      switchableGate = new SwitchableApprovalGate({
        manual: approvalGate,
        auto: new AutoApprovalGate({
          bus: deps.bus,
          ledger: deps.ledger,
          now: Date.now,
          nextApprovalId: () => `appr-switch-auto-${++autoSeq.n}`,
        }),
        bus: deps.bus,
        mode: 'manual',
      })
      return switchableGate
    },
    systemPrompt: '你是 OpenBot 管家——本机多 agent 社交控制台的默认对话者，用简洁中文回复。',
    // 会话标题（2026-10-18 /resume 列表改进）：首问后异步 ≤20 字总结（session-title 留档）
    sessionTitles: true,
    // Step 6：宿主磁盘探针（fs.statfs userData 所在卷）+ 压力阈值。
    // env OPENBOT_DISK_WARN_BYTES 覆盖 warn 阈值（E2E 确定性驱动压力角标；critical 取其半→可直达 critical 档）
    stats: (() => {
      const warn = process.env.OPENBOT_DISK_WARN_BYTES
      return {
        diskProbe: hostDiskProbe(userDataRoot),
        ...(warn !== undefined && Number.isFinite(Number(warn))
          ? { warnBytes: Number(warn), criticalBytes: Math.floor(Number(warn) / 2) }
          : {}),
      }
    })(),
  })

  // 引擎看门狗（2026-10-27 v0.1.90）：选定后端 docker/podman 时周期探测——外部掉线/恢复经
  // v1.runtime.engine 跃迁通知（toast + 矩阵刷新）；仅跃迁触发不刷屏，boot 基线 = 装配期可用。
  // E2E（mock 后端）不装配——确定性不受真机引擎态影响
  const backendEngine =
    sandboxStatus.chosen.backendId === 'docker' || sandboxStatus.chosen.backendId === 'podman'
      ? (sandboxStatus.chosen.backendId as 'docker' | 'podman')
      : null
  if (backendEngine !== null) {
    engineWatchdog = createEngineWatchdog({
      engine: backendEngine,
      run: runProcess,
      exists: existsSync,
      onTransition: (running) => {
        kernel.bus.emit('v1.runtime.engine', { engine: backendEngine, running })
      },
    })
  }

  // GUI 注入常驻通道随 P8-2 接口化迁入 X11ScreenControl（kernel.screen.inputChannel）——
  // 惰性建立/随 Box 失效重建/进程退出自动除名/dispose 兜底杀（孤儿纪律）全部内聚适配器；
  // 通道不可用时命令面回退逐动作 act（与既有回退语义一致）。

  /**
   * 模型覆盖分流（backlog ③）：档案名指定 → 静态 provider 实例（resolve 时构造——运行中档案
   * 改 key 不热跟随，重启生效记档）；未指定 → 全局 SwitchableChatProvider（主力切换随动）。
   * 恢复路径悬空（档案被删）→ 告警 + 回继承（不炸装配——与沙箱 mock 回退同哲学）；
   * 命令路径悬空 → 显式拒绝（用户当下反馈，不静默）。
   */
  const providerOfAgent = async (modelProvider: string | undefined, silentFallback: boolean): Promise<ChatProvider> => {
    if (modelProvider === undefined || modelProvider === '') return provider
    try {
      const { provider: name, model } = splitModelRef(modelProvider)
      const own = buildProvider(await settings.resolve(name, model))
      // 绑定模型的 Agent（0.1.28 默认语义）：主=X；X 上游失败（额度/过期等可重试错误）→
      // 自动回退到默认模型实例（provider 原地热更，包装层自动跟随新默认）
      const wrapped = new SwitchableChatProvider()
      wrapped.swap(own)
      wrapped.swapFallback(provider)
      return wrapped
    } catch (err) {
      const msg = `模型覆盖档案「${modelProvider}」不可用（${err instanceof Error ? err.message : String(err)}）`
      if (silentFallback) {
        console.warn(`[openbot] ${msg}——回继承全局主力`)
        return provider
      }
      throw new KernelError('SETTINGS_PROVIDER_NOT_FOUND', msg)
    }
  }

  /** 模型引用拆分（v2 供应商 1:N 模型）：'供应商::模型' 复合键——agent 覆盖粒度落到模型级；
   *  无 '::' = 旧值纯供应商名（读取端兼容：解析取该供应商默认模型，老 agent 零迁移） */
  const splitModelRef = (ref: string): { provider: string; model?: string } => {
    const idx = ref.indexOf('::')
    if (idx === -1) return { provider: ref }
    return { provider: ref.slice(0, idx), model: ref.slice(idx + 2) }
  }

  /** 档案 → provider 实现（P4 Step 11）：protocol 分支 anthropic（messages API）/ openai-compat 缺省。
   *  视觉声明（P8-4 后语义：只决定截图回喂格式——图像 part 或文本降级，不再决定 GUI 注册门） */
  const buildProvider = (resolved: ResolvedProvider): ChatProvider => {
    const config = {
      baseUrl: resolved.baseUrl,
      model: resolved.model,
      ...(resolved.apiKey ? { apiKey: resolved.apiKey } : {}),
      ...(resolved.headers ? { headers: resolved.headers } : {}),
      ...(resolved.proxyUrl ? { proxyUrl: resolved.proxyUrl } : {}),
      ...(resolved.temperature !== undefined ? { temperature: resolved.temperature } : {}),
      ...(resolved.timeoutMs !== undefined ? { timeoutMs: resolved.timeoutMs } : {}),
    }
    const capabilities = {
      ...(resolved.supportsImages !== undefined ? { supportsImages: resolved.supportsImages } : {}),
      ...(resolved.context1M !== undefined ? { context1M: resolved.context1M } : {}),
      // 工具截图回喂形态（v0.1.116b 400 修复）：anthropic 协议原生 tool_result 带图（官方
      // computer use 形态）；openai 面规范 tool content 仅文本——截图挪循环后 user 消息
      ...(resolved.protocol === 'anthropic' ? { toolResultImages: true } : {}),
    }
    return resolved.protocol === 'anthropic'
      ? new AnthropicProvider({ config, capabilities })
      : new OpenAiCompatProvider({ config, capabilities })
  }

  /** settings 变更后热切换 provider 与回退实现（明文 key 只在本进程内存中存在） */
  const applyProvider = async (): Promise<void> => {
    try {
      provider.swap(buildProvider(await settings.resolve()))
    } catch {
      provider.clear() // 无默认 provider / 解析失败 → 空缺态（chat 抛 LLM_NO_PROVIDER，UI 引导配置）
    }
    // 独立回退档退役（0.1.28 默认语义）：回退统一走「默认模型」——绑定模型的 Agent 由
    // providerOfAgent 包装层落到默认实例（provider.swap 原地热更，包装层自动跟随）
    provider.swapFallback(null)
  }

  // ---- 命令面扩展（壳装配职责：CLI/E2E 用 Auto 闸门时不需要这些命令） ----
  /** 安装台账 + 运行态合并视图（installed/install/setEnabled 三处同款——2026-10-20 插件运行时） */
  const installedWithRuntime = async (): Promise<Array<{ id: string; name: string; description: string; version: string; enabled: boolean; runtime: { state: 'stopped' | 'running' | 'faulted'; crashes: number; faultReason?: string } }>> => {
    const installed = await settings.getInstalledPlugins()
    const states = new Map(kernel.plugins.states().map((st) => [st.id, st]))
    return installed.map((p) => ({
      ...p,
      runtime: states.get(p.id) ?? { state: 'stopped', crashes: 0 },
    }))
  }

  kernel.transport
    .register('v1.settings.list', async () => {
      // 展示清单（无 key 材料）+ 当前默认（供应商+模型）与回退（renderer 空缺态判断）
      const providers = await settings.list()
      const current = await settings.load()
      return {
        providers,
        defaultProvider: current.defaultProvider ?? null,
        defaultModel: current.defaultModel ?? null,
        fallbackProvider: current.fallbackProvider ?? null,
        maxToolRounds: await settings.getMaxToolRounds(),
        runDeadlineMin: await settings.getRunDeadlineMin(),
        systemNotify: await settings.getSystemNotify(),
      }
    })
    // 工具轮预算（2026-11-02 三段值域）：-1 = 无限制 / 0 = 禁用工具 / 1~1024 = 轮数；
    // 落盘即热应用（kernel.setRunBudget 突变 turn deps——新任务立即生效，在途保持原预算）
    .register('v1.settings.setMaxToolRounds', async (payload) => {
      const { rounds } = z.object({ rounds: z.number().int().min(-1).max(1024) }).parse(payload)
      await settings.setMaxToolRounds(rounds)
      kernel.setRunBudget({
        maxToolRounds: rounds === -1 ? Number.POSITIVE_INFINITY : rounds,
      })
      return { ok: true, rounds }
    }, z.object({ rounds: z.number().int().min(-1).max(1024) }))
    // run 总时长上限（2026-11-02 三段值域）：-1 = 无限制（缺省）/ 1~1440 分钟；落盘即热应用
    .register('v1.settings.setRunDeadline', async (payload) => {
      const { minutes } = z.object({ minutes: z.number().int().min(-1).max(1440) }).parse(payload)
      await settings.setRunDeadlineMin(minutes)
      kernel.setRunBudget({ deadlineMs: minutes === -1 ? Number.POSITIVE_INFINITY : minutes * 60_000 })
      return { ok: true, minutes }
    }, z.object({ minutes: z.number().int().min(-1).max(1440) }))
    .register('v1.settings.upsertProvider', async (payload) => {
      const view = await settings.upsert(providerInputSchema.parse(payload))
      await applyProvider() // 同名=default 或无默认时也可能切换，统一重应用
      return view
    }, providerInputSchema)
    .register('v1.settings.setDefault', async (payload) => {
      const { name, model } = setDefaultSchema.parse(payload)
      await settings.setDefault(name, model)
      await applyProvider()
      return { ok: true }
    }, setDefaultSchema)
    .register('v1.settings.removeProvider', async (payload) => {
      await settings.remove(nameSchema.parse(payload).name)
      await applyProvider()
      return { ok: true }
    }, nameSchema)
    // ---- 自定义角色模板（2026-10-18 用户需求：小红书运维/微商运营等用户自建档位）----
    // 内置四角色在渲染层内建不落库；用户模板存 settings.roleTemplates（additive 旧文件兼容）
    .register('v1.roles.list', async () => ({ templates: await settings.getRoleTemplates() }))
    .register(
      'v1.roles.upsert',
      async (payload) => {
        const input = z
          .object({ name: z.string().trim().min(1).max(12), persona: z.string().trim().min(1).max(500) })
          .parse(payload)
        return { templates: await settings.upsertRoleTemplate(input) }
      },
      z.object({ name: z.string().trim().min(1).max(12), persona: z.string().trim().min(1).max(500) }),
    )
    .register('v1.roles.remove', async (payload) => {
      await settings.removeRoleTemplate(nameSchema.parse(payload).name)
      return { ok: true }
    }, nameSchema)
    // ---- 插件运行时（2026-10-20 P1，docs/plan-plugins.md）：市场=resources 官方目录扫描，
    //      安装=拷贝到 <dataRoot>/plugins/<id>/ + 台账 + 启用；启停接 PluginService 进程管理 ----
    .register('v1.plugins.market', async () => {
      const plugins = []
      for (const id of await fs.list(pluginsMarketDir)) {
        const raw = await fs.read(`${pluginsMarketDir}/${id}/manifest.json`)
        if (raw === null) continue
        try {
          const m = manifestSchema.parse(JSON.parse(raw))
          if (m.id !== id) {
            console.warn(`[openbot] 市场插件目录名（${id}）与 manifest.id（${m.id}）不一致，跳过——目录名必须等于 id`)
            continue
          }
          plugins.push({ id: m.id, name: m.name, description: m.description, version: m.version, permissions: m.permissions })
        } catch {
          console.warn(`[openbot] 市场插件 manifest 非法，跳过：${id}`)
        }
      }
      return { plugins }
    })
    .register('v1.plugins.installed', async () => ({ plugins: await installedWithRuntime() }))
    .register('v1.plugins.install', async (payload) => {
      const { id } = z.object({ id: z.string().trim().min(1).max(64) }).parse(payload)
      // 拷贝市场目录 → <dataRoot>/plugins/<id>/（文件级：manifest + 同目录全部文件）
      const entries = await fs.list(`${pluginsMarketDir}/${id}`)
      if (!entries.includes('manifest.json')) {
        throw new KernelError('PLUGIN_NOT_INSTALLED', `市场插件不存在：${id}`)
      }
      for (const f of entries) {
        const content = await fs.read(`${pluginsMarketDir}/${id}/${f}`)
        if (content !== null) await fs.write(`${dataRoot}/plugins/${id}/${f}`, content)
      }
      const m = manifestSchema.parse(JSON.parse((await fs.read(`${dataRoot}/plugins/${id}/manifest.json`)) ?? '{}'))
      await settings.installPlugin({ id: m.id, name: m.name, description: m.description, version: m.version, permissions: m.permissions })
      await kernel.plugins.enable(m.id)
      return { plugins: await installedWithRuntime() }
    }, z.object({ id: z.string().trim().min(1).max(64) }))
    .register('v1.plugins.uninstall', async (payload) => {
      const { id } = z.object({ id: z.string().trim().min(1).max(64) }).parse(payload)
      await kernel.plugins.disable(id)
      await settings.uninstallPlugin(id)
      // 目录清理（文件级遍历 + 目录兜底）
      for (const f of await fs.list(`${dataRoot}/plugins/${id}`)) {
        await fs.remove(`${dataRoot}/plugins/${id}/${f}`)
      }
      await fs.remove(`${dataRoot}/plugins/${id}`)
      return { ok: true }
    }, z.object({ id: z.string().trim().min(1).max(64) }))
    .register(
      'v1.plugins.setEnabled',
      async (payload) => {
        const { id, enabled } = z.object({ id: z.string().trim().min(1).max(64), enabled: z.boolean() }).parse(payload)
        await settings.setPluginEnabled(id, enabled)
        if (enabled) await kernel.plugins.enable(id)
        else await kernel.plugins.disable(id)
        return { plugins: await installedWithRuntime() }
      },
      z.object({ id: z.string().trim().min(1).max(64), enabled: z.boolean() }),
    )
    // 供应商重排（左栏拖拽排序）：names 全量清单须与既有档案同集合（settings 层校验）；顺序不影响 provider 实例，无需热切换
    .register('v1.settings.reorderProviders', async (payload) => {
      await settings.reorder(reorderProvidersSchema.parse(payload).names)
      return { ok: true }
    }, reorderProvidersSchema)
    // 模型可调用性测试（模型行「测试」图标）：真实最小请求（ping）——如实报告耗时/失败原因，不假装可用。
    // 存档模式走 settings.resolve（key 解密）；草稿模式（表单未存档）直传端点事实。20s 超时上限
    .register('v1.settings.testModel', async (payload) => {
      const p = testModelSchema.parse(payload)
      let resolved: ResolvedProvider
      if (p.name !== undefined) {
        resolved = await settings.resolve(p.name, p.model)
      } else {
        if (p.baseUrl === undefined) {
          throw new KernelError('SETTINGS_PROVIDER_NOT_FOUND', '草稿探测缺少端点——先填写 Base URL')
        }
        resolved = {
          name: 'draft',
          baseUrl: p.baseUrl,
          model: p.model,
          ...(p.apiKey !== undefined ? { apiKey: p.apiKey } : {}),
          ...(p.protocol !== undefined ? { protocol: p.protocol } : {}),
        }
      }
      const tester = buildProvider({ ...resolved, timeoutMs: 20_000 })
      const t0 = Date.now()
      try {
        await tester.chat({ messages: [{ role: 'user', content: 'ping' }] })
        return { ok: true, detail: `模型可调用（${Date.now() - t0}ms）` }
      } catch (err) {
        return { ok: false, reason: (err instanceof Error ? err.message : String(err)).slice(0, 200) }
      }
    }, testModelSchema)
    // 回退端点（P4 Step 11）：引用校验在 settings 层；null = 清除；热切换立即生效
    .register('v1.settings.setFallback', async (payload) => {
      await settings.setFallback(setFallbackSchema.parse(payload).name)
      await applyProvider()
      return { ok: true }
    }, setFallbackSchema)
    // LLM 生效事实（状态栏「当轮生效端点」）：activeLane = 最近一轮成功响应实际走的通道；
    // primaryModel = 默认供应商下生效的模型 id（v2 供应商 1:N 模型——呈现「供应商 · 模型」）
    .register('v1.settings.llmStatus', async () => {
      const current = await settings.load()
      return {
        configured: provider.configured,
        activeLane: provider.activeLane,
        primary: current.defaultProvider ?? null,
        primaryModel: current.defaultModel ?? null,
        fallback: await settings.getFallback(),
      }
    })
    .register('v1.approval.resolve', async (payload) => {
      const { nonce, decision } = resolveSchema.parse(payload)
      return { approved: await approvalGate.resolve(nonce, decision) }
    }, resolveSchema)
    .register('v1.approval.pending', async () => approvalGate.pending())
    // 审批闸门模式（P4 Step 7 档案事实）：桌面装配固定 Manual——出 Box 需用户批准（如实呈现） */
    .register('v1.approval.mode', async () => ({ mode: switchableGate.mode }))
    // 审批模式热切换（2026-09-06 composer 审批模式下拉）：manual=变更前确认 / auto=完全访问。
    // 内存态（重启回 manual 安全默认——记档）；经 bus 事件广播（composer chip 同步）
    .register('v1.approval.setMode', async (payload) => {
      const { mode } = z.object({ mode: z.enum(['manual', 'auto']) }).parse(payload)
      switchableGate.setMode(mode)
      return { ok: true, mode }
    }, z.object({ mode: z.enum(['manual', 'auto']) }))
    // caps 驱动 UI：按钮渲染依据后端能力声明（永不出现「UI 有按钮但后端不支持」）
    .register('v1.boxes.caps', async () => kernel.backend.caps())
    // 沙箱后端：状态呈现 + 偏好写入（重启生效——后端选择是装配期决策，不热切换）
    // ---- computer-use GUI 面（plan-computer-use Step 5/6）：帧拉取/用户注入/交还 ----
    // frame：独立截图（旁观视图兜底帧——agent 空闲时画面也能动；agent 动作时的帧由工具回喂
    // 截图经 lastImageOf 提供，零额外开销）。input：用户鼠标/键盘——首笔即接管（锁挂起 agent
    // 下一个动作）；注入走与 agent 同一条 xdotool 通路。release：交还。
    .register('v1.box.gui.frame', async (payload) => {
      const { boxId } = z.object({ boxId: z.string() }).parse(payload)
      // UI 档截图经适配器（P8-2）：1920 宽 q85（2026-09-04 用户反馈「初模糊后清晰」——
      // 实况流原生分辨率的落差消解；UI 视图帧无 token 纪律）+ 光标入画 + 唯一临时文件
      try {
        const capture = await kernel.screen.capture(boxId, { maxWidth: 1920, quality: 85, pointer: true })
        return { image: { base64: Buffer.from(capture.bytes).toString('base64'), mime: capture.mime } }
      } catch (err) {
        return { image: null, reason: `截图失败：${(err instanceof Error ? err.message : String(err)).slice(0, 120) }` }
      }
    }, z.object({ boxId: z.string() }))
    .register('v1.box.gui.input', async (payload) => {
      // 结构化动作批次（P8-2 接口化——renderer 不再拼 xdotool 串；坐标为真实屏幕坐标语义，
      // 常驻通道原样注入）。首笔用户输入即接管（挂起 agent 下一个动作）
      const { boxId, actions } = guiInputSchema.parse(payload)
      if (!takeoverHeld) guiTakeover(true)
      // 常驻通道优先（行式写入 sh -s——容器内逐行执行，天然串行合并突发）；不可用回退逐动作 act
      const channel = kernel.screen.inputChannel !== undefined ? await kernel.screen.inputChannel(boxId) : null
      if (channel !== null) {
        channel.write(actions)
        return { ok: true }
      }
      let ok = true
      for (const action of actions) {
        try {
          await kernel.screen.act(boxId, action)
        } catch {
          ok = false
        }
      }
      return { ok }
    }, guiInputSchema)
    .register('v1.box.gui.release', async () => {
      guiTakeover(false)
      return { ok: true }
    })
    .register('v1.box.gui.state', async () => ({ enabled: computerEnabled, takeover: takeoverHeld }))
    // GUI 实况流（plan-computer-use 二期）：开流/停流命令（帧走 WS /stream 的 gui 帧型）。
    // 开流策略（裁定 B）由渲染层驱动——接管时才开高频流，旁观 1.5s 轮询兜底；
    // 生命周期（裁定 C）随视图开关——unmount 必停，孤儿 ffmpeg 由 service dispose 兜底
    .register('v1.box.gui.stream.start', async (payload) => {
      const { boxId } = z.object({ boxId: z.string() }).parse(payload)
      return kernel.guiStream.start(boxId)
    }, z.object({ boxId: z.string() }))
    .register('v1.box.gui.stream.stop', async (payload) => {
      const { boxId } = z.object({ boxId: z.string() }).parse(payload)
      kernel.guiStream.stop(boxId)
      return { ok: true }
    }, z.object({ boxId: z.string() }))
    // 记忆（backlog ①）：ctx 档案呈现拉取（写路径只在 agent 工具——用户不可直接编辑）
    .register('v1.memory.list', async (payload) => {
      const { agentId } = z.object({ agentId: z.string() }).parse(payload)
      return { entries: await memoryStore.list(agentId) }
    }, z.object({ agentId: z.string() }))
    // 定时自动化（backlog ②）：CRUD + 下次触发预览（防 cron 写错——列表即带 nextAt）
    .register('v1.automations.list', async () => {
      const automations = await automationStore.list()
      const now = Date.now()
      return {
        automations: await Promise.all(
          automations.map(async (a) => ({
            ...a,
            nextAt: a.enabled ? nextAfter(a.cron, Math.max(a.lastRunAt ?? 0, now - 60_000)) : null,
          })),
        ),
      }
    })
    .register('v1.automations.add', async (payload) => {
      const input = automationInputSchema.parse(payload)
      return { automation: await automationStore.add(input) }
    }, automationInputSchema)
    .register('v1.automations.update', async (payload) => {
      const { id, ...patch } = automationPatchSchema.parse(payload)
      return { automation: await automationStore.update(id, patch) }
    }, automationPatchSchema)
    .register('v1.automations.remove', async (payload) => {
      const { id } = z.object({ id: z.string() }).parse(payload)
      await automationStore.remove(id)
      return { ok: true }
    }, z.object({ id: z.string() }))
    // cron 预览（模态输入即时反馈——解析单一来源在内核，renderer 不 import 内核包）。
    // upcomingAt（v0.1.96 表单生成器配套）：首触发之后的 3 次时刻（原始 ms——渲染层排版；
    // 周期规则的心智模型一目了然）
    .register('v1.automations.preview', async (payload) => {
      const { cron } = z.object({ cron: z.string() }).parse(payload)
      const next = nextAfter(cron, Date.now())
      const upcomingAt: number[] = []
      let cursor = next
      while (cursor !== null && upcomingAt.length < 3) {
        cursor = nextAfter(cron, cursor)
        if (cursor !== null) upcomingAt.push(cursor)
      }
      return { nextAt: next, upcomingAt, readable: next === null ? '该规则永不触发（如 2 月 30 日）' : new Date(next).toLocaleString('zh-CN') }
    }, z.object({ cron: z.string() }))
    // 镜像注册表（plan-image-firstclass P8-3 D3）：CRUD + 连接测试（test = 连通/镜像在场 +
    // GUI 工具集探测的如实报告）。add/update 即时维护路由表（按调用分发，无需重启）
    .register('v1.images.list', async () => ({ images: await imageStore.list() }))
    .register('v1.images.add', async (payload) => {
      const input = imageInputSchema.parse(payload)
      const entry = await imageStore.add(input)
      registerImageRoute(entry)
      return { image: entry }
    }, imageInputSchema)
    .register('v1.images.update', async (payload) => {
      const { id, ...patch } = imagePatchSchema.parse(payload)
      const entry = await imageStore.update(id, patch)
      registerImageRoute(entry) // 同 id 重注册 = 路由替换（连接事实/协议即时生效）
      return { image: entry }
    }, imagePatchSchema)
    .register('v1.images.remove', async (payload) => {
      const { id } = z.object({ id: z.string() }).parse(payload)
      const entry = await imageStore.get(id) // 先取条目（remove 后不可查——载体分支需要它）
      await imageStore.remove(id)
      routingBackend.removeRoute(id)
      // P9-2/P9-3a：宿主屏幕/Windows 条目删除 → 同步清其适配器（常驻通道——孤儿纪律）
      if (entry?.carrier === 'host-screen') {
        const gone = hostScreenControls.get(id)
        if (gone !== undefined) {
          gone.dispose()
          hostScreenControls.delete(id)
        }
      }
      if (entry?.carrier === 'windows' && entry.host !== undefined) {
        const bid = windowsBoxId(entry.host)
        const stillBound = (await imageStore.list()).some(
          (e) => e.carrier === 'windows' && windowsBoxId(e.host ?? '') === bid,
        )
        if (!stillBound) {
          winScreens.get(bid)?.dispose()
          winScreens.delete(bid)
          winBackends.delete(bid)
        }
      }
      if (entry?.carrier === 'android' && entry.host !== undefined) {
        const bid = adbBoxId(entry.host)
        const stillBound = (await imageStore.list()).some(
          (e) => e.carrier === 'android' && adbBoxId(e.host ?? '') === bid,
        )
        if (!stillBound) {
          adbScreens.get(bid)?.dispose()
          adbScreens.delete(bid)
          adbBackends.delete(bid)
        }
      }
      return { ok: true }
    }, z.object({ id: z.string() }))
    .register('v1.images.test', async (payload) => {
      const { id } = z.object({ id: z.string() }).parse(payload)
      const entry = await imageStore.get(id)
      if (entry === null) throw new KernelError('STATE_IMAGE_NOT_FOUND', `镜像条目不存在：${id}`)
      return testImageEntry(entry)
    }, z.object({ id: z.string() }))
    // 宿主屏幕窗口清单（plan-screen-firstclass P9-2 裁定 E）：设置页绑定窗口下拉的事实源——
    // EnumWindows 全量顶层窗口（标题子串匹配由用户在表单选定）。懒建单例 PS 通道，零注入面
    .register('v1.hostscreen.windows', async () => {
      windowProbe ??= new HostScreenControl({ bridge: hostScreenBridge })
      return { windows: await windowProbe.listWindows() }
    })
    // Android 设备发现与配对（plan-screen-firstclass P9-3c）：智能恢复优先的发现面——
    // devices 列在场设备（USB/已连 wifi/mDNS），pair 走配对码（扫码 WIFI:S:..;P:..;;
    // 解析出的服务名或手动 ip:配对端口）；只报告事实与执行配对，建条目仍走 v1.images.add
    .register('v1.adb.devices', async () => {
      const d = new AdbDiscovery()
      try {
        return { ok: true, devices: await d.listDevices() }
      } catch (err) {
        return { ok: false, reason: (err instanceof Error ? err.message : String(err)).slice(0, 200) }
      }
    })
    .register('v1.adb.pair', async (payload) => {
      const { target, code } = z.object({ target: z.string().trim().min(1).max(200), code: z.string().trim().min(4).max(8) }).parse(payload)
      const d = new AdbDiscovery()
      const fail = await d.pair(target, code)
      if (fail !== null) return { ok: false, reason: fail }
      // 配对成功 → mDNS 即将广播；对 ip:port 形态顺手 connect（服务名形态由 adb pair 已连）
      if (target.includes(':')) {
        await d.connect(target).catch(() => {})
      }
      return { ok: true }
    }, z.object({ target: z.string().trim().min(1).max(200), code: z.string().trim().min(4).max(8) }))
    // 可用镜像探测（2026-09-14）：环境里实际在场的镜像清单（宿主 docker/podman + WSL 发行版内
    // docker）——注册表只含手动条目，此命令补「用户无从得知有哪些镜像」的发现面。
    // 按需触发（设置页按钮），只报告事实不自动入库；装配期已就绪的 platform 从作用域注入
    .register('v1.images.scan', async () => ({ sources: await scanEnvImages({ run: runProcess, platform }) }))
    // ---- 附件（2026-10-30 v0.1.102 一期图片；同日二期文件类）：上传落盘（内容寻址去重）+
    // 读取（dataURI 呈现）。本体落 userData/attachments/<sha256>.<ext>——transcript 只存 meta
    // （append-only 铁律）；读取面恒限附件目录（不开放任意盘读）。
    // 二期语义（作者默认裁定）：文本类（text/*、json/xml/yaml/toml/csv、代码扩展名）≤200KB
    // 注入全文、超出截断加注记；图片 ≤8MB 视觉注入；其余 ≤8MB 存档（消息给路径，agent 工具读） ----
    // 用量水位（会话引擎 v2 · P1）：最近一条 usage 记录（读取面恒限 data/agents/<id>/usage.jsonl）
    .register('v1.usage.latest', async (payload) => {
      const { agentId } = z.object({ agentId: z.string().min(1).max(120) }).parse(payload)
      const file = `${userDataRoot}/data/agents/${agentId}/usage.jsonl`
      if (!existsSync(file)) return null
      const lines = readFileSync(file, 'utf8').trim().split('\n')
      const last = lines.at(-1)
      if (last === undefined || last === '') return null
      try {
        return JSON.parse(last) as { at: number; model: string; promptTokens: number; completionTokens: number }
      } catch {
        return null
      }
    })
    .register('v1.attachments.upload', async (payload) => {
      const { name, mime, dataBase64 } = z
        .object({
          name: z.string().trim().min(1).max(200),
          mime: z.string().trim().min(3).max(120),
          dataBase64: z.string().min(4).max(12_000_000),
        })
        .parse(payload)
      const bytes = Buffer.from(dataBase64, 'base64')
      if (bytes.length > 8 * 1024 * 1024) {
        throw new KernelError('ATTACHMENT_TOO_LARGE', `附件超过上限 8MB（${(bytes.length / 1024 / 1024).toFixed(1)}MB）`)
      }
      const dir = `${userDataRoot}/attachments`
      mkdirSync(dir, { recursive: true })
      const id = createHash('sha256').update(bytes).digest('hex')
      // 扩展名：图片按 mime 映射（读命令反查 mime 用）；其余保留原文件扩展名（语法信息）
      const imgExt = mime === 'image/png' ? 'png' : mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : mime === 'image/gif' ? 'gif' : undefined
      const nameExt = name.includes('.') ? (name.split('.').pop() ?? '') : ''
      const ext = imgExt ?? (nameExt !== '' ? nameExt.replace(/[^a-z0-9]/gi, '').slice(0, 8).toLowerCase() : 'bin')
      const path = `${dir}/${id}.${ext}`
      if (!existsSync(path)) writeFileSync(path, bytes) // 内容寻址：同文件重传零拷贝去重
      return { id, name, mime, size: bytes.length, path }
    }, z.object({
      name: z.string().trim().min(1).max(200),
      mime: z.string().trim().min(3).max(120),
      dataBase64: z.string().min(4).max(12_000_000),
    }))
    .register('v1.attachments.read', async (payload) => {
      const { id } = z.object({ id: z.string().regex(/^[0-9a-f]{64}$/) }).parse(payload)
      const dir = `${userDataRoot}/attachments`
      const hit = readdirSync(dir).find((f) => f.startsWith(id))
      if (hit === undefined) throw new KernelError('ATTACHMENT_NOT_FOUND', `附件不存在：${id.slice(0, 12)}…`)
      const ext = hit.split('.').pop() ?? 'img'
      const mime = ext === 'png' ? 'image/png' : ext === 'jpg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : ext === 'gif' ? 'image/gif' : 'image/png'
      return { dataBase64: readFileSync(`${dir}/${hit}`).toString('base64'), mime }
    }, z.object({ id: z.string().regex(/^[0-9a-f]{64}$/) }))
    .register('v1.sandbox.status', async () => ({
      ...(await settings.getSandboxDataDir()) !== null ? { sandboxDataDir: await settings.getSandboxDataDir() } : {},
      preference: sandboxStatus.preference,
      stored: await settings.getSandbox(),
      backendId: sandboxStatus.chosen.backendId,
      wanted: sandboxStatus.chosen.wanted,
      ...(sandboxStatus.chosen.reason !== undefined ? { reason: sandboxStatus.chosen.reason } : {}),
      // 探测卡一致性（2026-10-27 v0.1.91）：现探现返回（其他载体行/imageForm 拿到活事实——
      // 与 v1.runtime.list 同鲜度）；内部 sandboxStatus.probes 保留 boot 装配事实不动
      // （chooseBackend 是构造期判定，两套语义各司其职）。并行 ~6 探测秒级幂等
      probes: await probeAll(runProcess, platform, sshOpts),
      rootfsPath: sandboxStatus.rootfsPath,
      rootfsReady: sandboxStatus.rootfsReady,
      backendCaps: sandboxStatus.backendCaps,
    }))
    .register('v1.sandbox.set', async (payload) => {
      const { preference: pref } = sandboxSetSchema.parse(payload)
      await settings.setSandbox(pref)
      return { ok: true, restartRequired: true }
    }, sandboxSetSchema)
    // ---- 运行时一键安装（2026-10-20 v0.2.0，docs/plan-v020-runtime-install.md）----
    // 安装器属壳层职责（装宿主系统软件不进内核域）；单并发；进度走 v1.runtime.progress
    // 可用性映射：探测 id → 运行时（wsl/docker/podman；colima 归 docker 探测面）
    // 沙箱数据目录全局默认（2026-10-20 v0.2.0）：null=回 userData/boxes；重启生效（构造期事实）
    .register('v1.sandbox.setDataDir', async (payload) => {
      const { dir } = z.object({ dir: z.string().trim().min(1).max(300).nullable() }).parse(payload)
      await settings.setSandboxDataDir(dir)
      return { ok: true, restartRequired: true }
    }, z.object({ dir: z.string().trim().min(1).max(300).nullable() }))
    // 行级数据目录（2026-10-20 用户裁定：每运行时各自的目录）：runtimeId 白名单（目录型）；
    // 其余运行时稳定码拒绝（UI 点击 ⚙ 已分流，此处兜底）
    .register('v1.sandbox.setRuntimeDir', async (payload) => {
      const { runtimeId, dir } = z
        .object({ runtimeId: z.enum(['wsl2', 'nspawn']), dir: z.string().trim().min(1).max(300).nullable() })
        .parse(payload)
      await settings.setRuntimeDataDir(runtimeId, dir)
      return { ok: true, restartRequired: true }
    }, z.object({ runtimeId: z.enum(['wsl2', 'nspawn']), dir: z.string().trim().min(1).max(300).nullable() }))
    .register('v1.sandbox.getRuntimeDirs', async () => ({
      dirs: {
        wsl2: (await settings.getRuntimeDataDir('wsl2')) ?? (await settings.getSandboxDataDir()),
        nspawn: await settings.getRuntimeDataDir('nspawn'),
      },
    }))
    .register('v1.runtime.list', async () => {
      // 2026-10-20 矩阵化（用户裁定）：返回**全部平台**策略——渲染层按运行时分组拼矩阵，
      // 本系统能装的高亮给按钮、其他系统如实标「不支持」。
      // 2026-10-27 v0.1.89 状态分层：旧 available 单布尔退役（压平了装没装×跑没跑——已装 DD
      // 引擎未跑误显「一键安装」的根因）——改 installState × engineState 两维，且**调用时活探测**
      // （旧实现读构造期探测快照，安装/启动后不更新——done 模态「重启应用后即可」文案的根因）。
      // 探测目标去重并行；win 的 CLI 解析带官方默认安装位回退（PATH 启动时继承——新装后未含）。
      const e2e = process.env.OPENBOT_E2E === '1'
      const strategies = [...strategiesFor(process.platform, e2e), ...STRATEGIES.filter((st) => st.platform !== process.platform)]
      const exists = (p: string): boolean => existsSync(p)
      const targets = new Set<string>()
      for (const st of strategies) {
        if (st.platform !== process.platform) continue
        // 探测目标映射：wsl2→wsl；docker-desktop(非 mac)/docker/colima→docker；podman→podman
        if (st.id === 'wsl2') targets.add('wsl')
        else if (st.id === 'docker-desktop' || st.id === 'docker' || st.id === 'colima') targets.add('docker')
        else if (st.id === 'podman') targets.add('podman')
      }
      const layered = new Map<string, LayeredProbeResult>()
      await Promise.all(
        [...targets].map(async (t) => {
          if (t === 'wsl') {
            layered.set('wsl', await probeWslLayered(runProcess))
          } else if (t === 'docker') {
            const cli = await resolveCli(runProcess, 'docker', READY_CLI_FALLBACKS.docker, exists)
            // DD exe 在场只对 win 有意义（CLI 不可寻时兜底 installed 判定）；他平台 docker 走 PATH 面
            const exe = process.platform === 'win32' ? await resolveDockerDesktopExe(runProcess, exists, DOCKER_DESKTOP_WIN_ROOT) : null
            layered.set('docker', await probeDockerLayered(runProcess, cli, exe))
          } else if (t === 'podman') {
            layered.set('podman', await probePodmanLayered(runProcess, await resolveCli(runProcess, 'podman', READY_CLI_FALLBACKS.podman, exists), process.platform))
          }
        }),
      )
      // 缺席目标兜底（目标集由本平台策略推导，恒在场——纯类型完备）
      const probeOf = (key: string): LayeredProbeResult => layered.get(key) ?? { installState: 'unknown', engineState: 'unknown' }
      return {
        installers: strategies.map((st) => {
          // 他平台 null（无探测面）；本平台无探测面（mac brew 行）= unknown 如实
          let installState: InstallState | null = null
          let engineState: EngineState | null = null
          let note: EngineNote | undefined
          if (st.platform === process.platform) {
            if (st.id === 'mock-runtime') {
              installState = mockRuntimeInstalled ? 'installed' : 'absent'
              engineState = mockRuntimeEngineRunning ? 'running' : 'stopped'
            } else if (st.id === 'mock-runtime-mm') {
              // v0.1.130：装完 installed + 恒 stopped + machine-missing（无 machine 的 start 必败形态）
              installState = mockRuntimeMmInstalled ? 'installed' : 'absent'
              engineState = 'stopped'
              if (mockRuntimeMmInstalled) note = 'machine-missing'
            } else if (st.id === 'wsl2') {
              const p = probeOf('wsl')
              ;({ installState, engineState } = p)
              note = p.note
            } else if (st.id === 'podman') {
              const p = probeOf('podman')
              ;({ installState, engineState } = p)
              note = p.note
            } else if (st.id === 'docker-desktop' && st.platform === 'darwin') {
              // mac DD（v0.1.90）：应用在场（brew cask 默认位）即 installed——brew 面无法经 CLI
              // 判装没装；引擎态如实用 docker 探测面（DD/colima 共用 docker CLI——同一引擎事实）
              installState = exists(DOCKER_APP_MAC) ? 'installed' : 'unknown'
              ;({ engineState } = probeOf('docker'))
            } else if (st.id === 'docker' || st.id === 'colima' || st.id === 'docker-desktop') {
              ;({ installState, engineState } = probeOf('docker'))
            } else {
              installState = 'unknown'
              engineState = 'unknown'
            }
          }
          return {
            id: st.id,
            runtime: st.runtime,
            platform: st.platform,
            supported: st.platform === process.platform,
            sourceKind: st.source.kind,
            elevation: st.elevation,
            // 位置可选事实（2026-10-21 位置旗标）：只透传布尔——旗标字面量属执行器实现细节不进协议
            installDirSelectable: st.locationFlags?.installDir !== undefined,
            dataDirSelectable: st.locationFlags?.dataDir !== undefined,
            locationNote: st.locationNote,
            notes: st.notes,
            // 分层事实（2026-10-27）：installState=装没装（CLI/默认位判定）；engineState=跑没跑
            // （docker info/machine list；absent 不探测 → unknown）；note 稳定码（渲染层映射文案）
            installState,
            engineState,
            ...(note !== undefined ? { note } : {}),
            // 启动声明制（未声明不显示启动钮）：透传布尔 + 提权面（polkit → UI 先弹启动确认模态）
            launchSupported: st.launch !== undefined,
            launchElevation: st.launch?.elevation === 'polkit' ? 'polkit' : 'none',
          }
        }),
      }
    })
    .register('v1.runtime.install', async (payload) => {
      const { runtimeId, installDir, dataDir } = z
        .object({
          runtimeId: z.string().trim().min(1).max(32),
          installDir: z.string().trim().min(1).max(300).optional(),
          dataDir: z.string().trim().min(1).max(300).optional(),
        })
        .parse(payload)
      if (runtimeInstallBusy) {
        throw new KernelError('RUNTIME_INSTALL_BUSY', '已有安装进行中——等它完成再试')
      }
      const e2e = process.env.OPENBOT_E2E === '1'
      const strategy = strategiesFor(process.platform, e2e).find((st) => st.id === runtimeId)
      if (strategy === undefined) {
        throw new KernelError('RUNTIME_NOT_FOUND', `当前平台无此运行时安装器：${runtimeId}`)
      }
      // 位置旗标前置校验（2026-10-21）：上游不支持的位置不给「选了却装到别处」的静默假象
      if (installDir !== undefined && strategy.locationFlags?.installDir === undefined) {
        throw new KernelError('RUNTIME_LOCATION_NOT_SUPPORTED', '该运行时的安装位置不可自选')
      }
      if (dataDir !== undefined && strategy.locationFlags?.dataDir === undefined) {
        throw new KernelError('RUNTIME_LOCATION_NOT_SUPPORTED', '该运行时的容器数据位置不可自选')
      }
      runtimeInstallBusy = true
      const abort = new AbortController()
      runtimeInstallAbort = abort
      // fire-and-forget：命令即返受理，链路进度/终态走事件（下载分钟级不该占命令通道）
      void (async () => {
        try {
          await runInstall(strategy, {
            onEvent: (ev) => {
              // mock 台账在 done 事件回调内同步置位（早于渲染层刷新拉取——免竞态读到旧态）
              if (ev.phase === 'done' && strategy.id === 'mock-runtime') mockRuntimeInstalled = true
              if (ev.phase === 'done' && strategy.id === 'mock-runtime-mm') mockRuntimeMmInstalled = true
              kernel.bus.emit('v1.runtime.progress', { runtimeId: strategy.id, ...ev })
            },
          }, {
            signal: abort.signal,
            ...(installDir !== undefined ? { installDir } : {}),
            ...(dataDir !== undefined ? { dataDir } : {}),
          })
        } catch (err) {
          kernel.bus.emit('v1.runtime.progress', {
            runtimeId: strategy.id,
            phase: 'failed',
            detail: err instanceof Error ? err.message : String(err),
          })
        } finally {
          runtimeInstallBusy = false
          runtimeInstallAbort = null
        }
      })()
      return { ok: true }
    }, z.object({
      runtimeId: z.string().trim().min(1).max(32),
      installDir: z.string().trim().min(1).max(300).optional(),
      dataDir: z.string().trim().min(1).max(300).optional(),
    }))
    // 取消安装（2026-10-20 用户报障：下载无法取消对流量敏感客户不友好）——abort 在途
    // 任务（下载清临时文件、子进程即杀）；非在途幂等通过（无操作）
    // 2026-10-27 扩可选 runtimeId：在场 = 取消该运行时的启动等待（停轮询；DD 已拉起进程
    // 不杀）；缺席 = 取消在途安装（原语义——兼容既有调用）
    .register('v1.runtime.cancel', async (payload) => {
      const { runtimeId } = z.object({ runtimeId: z.string().trim().min(1).max(32).optional() }).parse(payload ?? {})
      if (runtimeId !== undefined) runtimeLaunchAborts.get(runtimeId)?.abort()
      else runtimeInstallAbort?.abort()
      return { ok: true }
    }, z.object({ runtimeId: z.string().trim().min(1).max(32).optional() }))
    // ---- 启动引导（2026-10-27 v0.1.89 状态分层：已装未跑 → 应用内拉起 + 就绪轮询）----
    // 受理即返（就绪等待分钟级不占命令通道）；实况/终态走 v1.runtime.progress 的
    // launch/ready 相位；轮询节奏与取消语义见 installers/launcher.ts（裁定 2.5s/5min）
    .register('v1.runtime.launch', async (payload) => {
      const { runtimeId } = z.object({ runtimeId: z.string().trim().min(1).max(32) }).parse(payload)
      if (runtimeLaunchBusy.has(runtimeId)) {
        throw new KernelError('RUNTIME_LAUNCH_BUSY', '该运行时已在启动中——等它完成或先取消等待')
      }
      const e2e = process.env.OPENBOT_E2E === '1'
      const strategy = strategiesFor(process.platform, e2e).find((st) => st.id === runtimeId)
      if (strategy === undefined) {
        throw new KernelError('RUNTIME_NOT_FOUND', `当前平台无此运行时：${runtimeId}`)
      }
      if (strategy.launch === undefined) {
        throw new KernelError('RUNTIME_LAUNCH_NOT_SUPPORTED', '该运行时未声明应用内启动——请在应用外启动')
      }
      runtimeLaunchBusy.add(runtimeId)
      const abort = new AbortController()
      runtimeLaunchAborts.set(runtimeId, abort)
      void (async () => {
        try {
          await runLaunch(strategy, {
            onEvent: (ev) => {
              // mock 台账同步置位（同 install done——免竞态）
              if (ev.phase === 'ready' && strategy.id === 'mock-runtime') mockRuntimeEngineRunning = true
              kernel.bus.emit('v1.runtime.progress', { runtimeId: strategy.id, ...ev })
            },
          }, { run: runProcess, signal: abort.signal, exists: existsSync })
        } catch (err) {
          kernel.bus.emit('v1.runtime.progress', {
            runtimeId: strategy.id,
            phase: 'failed',
            detail: err instanceof Error ? err.message : String(err),
          })
        } finally {
          runtimeLaunchBusy.delete(runtimeId)
          runtimeLaunchAborts.delete(runtimeId)
        }
      })()
      return { ok: true }
    }, z.object({ runtimeId: z.string().trim().min(1).max(32) }))
    // 跨用户房间（P7 多房间轮）：状态呈现（settings 全量 + env 叠加路的连接态）+ 配置全量写入
    .register('v1.relay.status', async () => {
      const stored = await settings.getRelays()
      const all = [...stored]
      for (const { cfg } of relays) {
        if (!all.some((c) => c.roomId === cfg.roomId)) all.push(cfg) // env 叠加路（不在 settings）
      }
      return {
        relays: all.map((c) => ({
          ...c,
          connected: relays.some((r) => r.cfg.roomId === c.roomId && r.client.connected),
        })),
      }
    })
    .register('v1.relay.set', async (payload) => {
      const input = relaySetSchema.parse(payload)
      await settings.setRelays(input.relays)
      return { ok: true, restartRequired: true }
    }, relaySetSchema)
    // 注册 agent（P4 Step 5）：经装配 addAgent（名册+调度器+专属 Box+turn 接线）；
    // llm 共享 SwitchableChatProvider——主力模型切换对全部 agent 生效（与启动装配同语义）
    .register('v1.system.registerAgent', async (payload) => {
      const { name, color, role, modelProvider, imageId, persona, roleName, dataDir } = registerAgentSchema.parse(payload)
      // 管家前置检查：在位时直接拒绝（不创建半成品 agent；任命事务由 addAgent 兜底不变量）
      if (role === 'steward' && (await kernel.agentStore.findSteward()) !== null) {
        throw new KernelError('STATE_STEWARD_EXISTS', '管家已在位（须先罢免或转移）')
      }
      // agentId 服务端生成：agent-N（名册内既有同前缀序号递增；单用户桌面应用无并发竞争）
      const ids = new Set((await kernel.agentStore.list()).map((a) => a.agentId))
      let n = 1
      while (ids.has(`agent-${n}`)) n++
      const agentId = `agent-${n}`
      // 镜像绑定悬空在此显式拒绝（用户当下反馈——与模型覆盖同语义）；绑定后 Box 由路由后端
      // 分发到对应载体（创建即真实连接——不可达的机器注册如实失败）
      if (imageId !== undefined && (await imageStore.get(imageId)) === null) {
        throw new KernelError('STATE_IMAGE_NOT_FOUND', `镜像条目不存在：${imageId}`)
      }
      // 覆盖悬空在此显式拒绝（用户当下反馈）；分流实例与档案持久同步落
      await kernel.addAgent({
        agentId,
        name,
        color,
        ...(modelProvider !== undefined ? { modelProvider } : {}),
        ...(imageId !== undefined ? { imageId } : {}),
        ...(persona !== undefined ? { persona } : {}),
        ...(roleName !== undefined ? { roleName } : {}),
        ...(dataDir !== undefined ? { dataDir } : {}),
        llm: await providerOfAgent(modelProvider, false),
        steward: role === 'steward',
      })
      return { agentId, name, role: role ?? 'worker', ...(color !== undefined ? { color } : {}) }
    }, registerAgentSchema)
    // 模型覆盖改写（backlog ③）：null=清除回继承；悬空显式拒绝；重启生效（llm 实例是装配期构造）
    .register('v1.system.setModelProvider', async (payload) => {
      const { agentId, modelProvider } = z
        .object({ agentId: z.string().min(1), modelProvider: z.string().trim().min(1).max(64).nullable() })
        .parse(payload)
      // 悬空校验：'供应商::模型' 复合键拆分后解析（旧值纯供应商名同款兼容）→ SETTINGS_* 稳定码如实抛
      if (modelProvider !== null) {
        const { provider: name, model } = splitModelRef(modelProvider)
        await settings.resolve(name, model)
      }
      await kernel.agentStore.setModelProvider(agentId, modelProvider)
      return { ok: true, restartRequired: true }
    }, z.object({ agentId: z.string().min(1), modelProvider: z.string().trim().min(1).max(64).nullable() }))
    // 人设改写（2026-10-18 身份修复）：null=清除；**即时生效**（提示词每轮取档案真相——
    // 与模型/镜像改写的重启语义不同，无实例态需要重建）
    .register('v1.system.setPersona', async (payload) => {
      const { agentId, persona } = z
        .object({ agentId: z.string().min(1), persona: z.string().trim().min(1).max(500).nullable() })
        .parse(payload)
      await kernel.setPersona(agentId, persona)
      return { ok: true }
    }, z.object({ agentId: z.string().min(1), persona: z.string().trim().min(1).max(500).nullable() }))
    // 镜像绑定改写（P8-4）：null=清除回默认沙箱；悬空显式拒绝；重启生效（Box 是装配期创建——
    // 与模型覆盖同语义；改绑后的下一次应用重启把 agent 的 Box 落到新载体）
    .register('v1.system.setImage', async (payload) => {
      const { agentId, imageId } = z
        .object({ agentId: z.string().min(1), imageId: z.string().trim().min(1).max(32).nullable() })
        .parse(payload)
      if (imageId !== null && (await imageStore.get(imageId)) === null) {
        throw new KernelError('STATE_IMAGE_NOT_FOUND', `镜像条目不存在：${imageId}`)
      }
      await kernel.agentStore.setImage(agentId, imageId)
      return { ok: true, restartRequired: true }
    }, z.object({ agentId: z.string().min(1), imageId: z.string().trim().min(1).max(32).nullable() }))
    // 数据目录设置（UI 优化 0.1.26，用户需求）：写 userData 根下 data-root.txt 标记（重启生效；
    // 旧目录数据不自动迁移）。轻校验绝对路径形状；探测写删验证目录可用——失败如实拒绝
    // 数据目录设置（UI 优化 0.1.26，用户需求）：写 userData 根下 data-root.txt 标记（重启生效）。
    // 切换自动迁移（v0.1.64 用户需求）：两阶段全家搬迁（见 migrateDataDir）；恢复默认同逻辑迁回。
    // 轻校验绝对路径形状；探测写删验证目录可用——失败如实拒绝（未切换、旧数据无损）
    .register('v1.system.setDataRoot', async (payload) => {
      const { path } = z
        .object({ path: z.string().trim().min(1).max(500).nullable() })
        .parse(payload)
      const toDefault = path === null || path === ''
      const target = toDefault ? `${userDataRoot}/data` : path.replaceAll('\\', '/')
      if (!toDefault) {
        if (!/^[a-zA-Z]:[\\/]/.test(path) && !path.startsWith('/')) {
          throw new KernelError('STATE_DATA_ROOT_INVALID', `须为绝对路径（如 D:\\OpenBotData）：${path}`)
        }
        try {
          await fs.write(`${target}/.openbot-root-probe`, '1')
          await fs.remove(`${target}/.openbot-root-probe`)
        } catch (err) {
          throw new KernelError('STATE_DATA_ROOT_INVALID', `目录不可用：${err instanceof Error ? err.message : String(err)}`)
        }
      }
      const norm = (p: string): string => p.replaceAll('\\', '/').replace(/\/+$/, '')
      let moved = 0
      if (norm(dataRoot) !== norm(target)) {
        try {
          moved = migrateDataDir(dataRoot, target)
        } catch (err) {
          throw new KernelError(
            'STATE_DATA_MIGRATE_FAILED',
            `数据目录迁移失败（未切换，原目录数据无损）：${err instanceof Error ? err.message : String(err)}`,
          )
        }
      }
      await fs.write(dataRootMarker, toDefault ? '' : path)
      return { ok: true, moved, restartRequired: true }
    }, z.object({ path: z.string().trim().min(1).max(500).nullable() }))
    // 会话记录目录独立设置（v0.1.63，用户需求）：写 transcript-root.txt 标记（重启生效）。
    // null/空 = 清除标记回数据目录内；轻校验与探测同 setDataRoot。
    // 切换自动迁移（v0.1.63 用户需求）：只搬 agents/<id>/transcript.jsonl——同目录的
    // profile.json/memory.json 归 AgentStore/MemoryStore（数据目录管），绝不能动。
    // 两阶段安全搬运：先全量复制（任一失败即抛——旧根无损、标记不写、未切换），
    // 全部成功后才删源 + 写标记（删源失败仅留冗余副本，无害——任何时刻至少一侧全量）
    .register('v1.system.setTranscriptRoot', async (payload) => {
      const { path } = z
        .object({ path: z.string().trim().min(1).max(500).nullable() })
        .parse(payload)
      const toDefault = path === null || path === ''
      const targetRoot = toDefault ? dataRoot : path.replaceAll('\\', '/')
      if (!toDefault) {
        if (!/^[a-zA-Z]:[\\/]/.test(path) && !path.startsWith('/')) {
          throw new KernelError('STATE_DATA_ROOT_INVALID', `须为绝对路径（如 D:\\OpenBotTranscript）：${path}`)
        }
        try {
          await fs.write(`${targetRoot}/.openbot-root-probe`, '1')
          await fs.remove(`${targetRoot}/.openbot-root-probe`)
        } catch (err) {
          throw new KernelError('STATE_DATA_ROOT_INVALID', `目录不可用：${err instanceof Error ? err.message : String(err)}`)
        }
      }
      // 旧根 = 现标记值（非空时）?? 数据目录——与装配端读取同一真相
      let prevRoot = dataRoot
      try {
        const prev = (existsSync(transcriptRootMarker) ? readFileSync(transcriptRootMarker, 'utf8') : '').trim()
        if (prev !== '') prevRoot = prev.replaceAll('\\', '/')
      } catch {
        /* 读不到标记——按数据目录内处理 */
      }
      const norm = (p: string): string => p.replaceAll('\\', '/').replace(/\/+$/, '')
      let moved = 0
      if (norm(prevRoot) !== norm(targetRoot)) {
        try {
          moved = migrateTranscripts(prevRoot, targetRoot)
        } catch (err) {
          throw new KernelError(
            'STATE_TRANSCRIPT_MIGRATE_FAILED',
            `会话记录迁移失败（未切换，原目录数据无损）：${err instanceof Error ? err.message : String(err)}`,
          )
        }
      }
      await fs.write(transcriptRootMarker, toDefault ? '' : path)
      return { ok: true, moved, restartRequired: true }
    }, z.object({ path: z.string().trim().min(1).max(500).nullable() }))

  await applyProvider()
  _lap('assemble-done')
  await kernel.addAgent({ agentId: 'steward', name: '管家', llm: provider, steward: true })
  _lap('steward-added')

  // boot 恢复持久化名册的运行时态（P5 后修复）：agentStore 是唯一真相，但调度器/Box/llm 是内存态——
  // 重启后不重建则自建 agent「名册在、调度器无」：建群/发消息按 STATE_AGENT_NOT_FOUND 拒绝。
  // addAgent 幂等分支只重建内存态（名册不重复写）；steward 已上方装配（跳过防 mock 后端二次建 Box）
  _lap('restore-begin')
  // 恢复并行化（v0.1.57）：各 agent 的 create（mkdir 预热）互不冲突，VM 冷启动成本
  // 一次分摊；失败各自降级不拖累他人（原串行 4.5s×N）
  const restoreOne = async (profile: { agentId: string; name: string; color?: string; modelProvider?: string; imageId?: string; role: string }): Promise<void> => {
    if (profile.agentId === 'steward') return
    // 镜像绑定恢复（P8-4）：悬空（条目已删）静默回默认 + 告警留痕——modelProvider 悬空双语义同款；
    // **载体不可达同样降级**（v0.1.40 真机实锤：android/ssh/win 设备临时不在场炸掉整个应用
    // 启动——桌面单机语义下不可接受）：恢复路径 create 失败 → 告警 + 回默认沙箱重试（绑定
    // 保留在档案里，设备回场重启即恢复原载体）。运行中注册（addAgent 命令路径）失败仍冒泡——
    // 用户当下操作要真实反馈
    let imageId: string | undefined
    if (profile.imageId !== undefined) {
      if ((await imageStore.get(profile.imageId)) !== null) {
        imageId = profile.imageId
      } else {
        console.warn(`[openbot] agent ${profile.agentId} 绑定的镜像条目 ${profile.imageId} 已删除——回默认沙箱`)
      }
    }
    _lap('restore-pre:' + profile.agentId)
    const restored = {
      agentId: profile.agentId,
      name: profile.name,
      ...(profile.color !== undefined ? { color: profile.color } : {}),
      // 模型覆盖（backlog ③）：恢复路径悬空静默回继承（告警留痕）——档案可能已被删除
      llm: await providerOfAgent(profile.modelProvider, true),
      steward: profile.role === 'steward',
    }
    if (imageId === undefined) {
      await kernel.addAgent(restored)
      return
    }
    try {
      await kernel.addAgent({ ...restored, imageId })
    } catch (err) {
      const entry = await imageStore.get(imageId)
      console.warn(
        `[openbot] agent ${profile.agentId} 绑定的镜像「${entry?.name ?? imageId}」载体不可达（${err instanceof Error ? err.message.slice(0, 120) : String(err)}）——本次启动回默认沙箱（绑定保留，设备回场重启即恢复）`,
      )
      await kernel.addAgent(restored)
    }
  }
  await Promise.all((await kernel.agentStore.list()).map((profile) => restoreOne(profile)))
  _lap('restore-done')

  // 装配配置（E2E/演示用）：附加 worker agent——A2A 需要至少两名成员；共享同一
  // SwitchableChatProvider（主力模型切换对管家与全部 agent 生效，符合设置页语义）。
  const extraAgents = (process.env.OPENBOT_EXTRA_AGENTS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
  for (const agentId of extraAgents) {
    await kernel.addAgent({ agentId, llm: provider })
  }

  // ---- GUI 生产注册门（P8-4 后门语义修正，用户裁定）：env 强制门之外，生产门 =
  // GUI 工具集探测（B2——Box 内 xdotool/scrot 在场）∩ 真实后端（mock 的 exec 应答恒成功，
  // 探测不构成事实）。**模型视觉不进注册门**——GUI 能力是环境（Box/镜像）的属性，与模型
  // 无关；模型视觉只决定截图回喂格式（TurnRunner.supportsImagesOf 分流：无视觉降级为文本）。
  // 探测需要 Box 在场，故在名册装配后、网关开启前执行——注册先于任何对话（工具 specs 进
  // 首轮请求）。探测失败如实 console 留痕。
  if (!computerEnabled && chosen.backendId !== 'mock') {
    const probeBoxId = (await routedBackend.list())[0]?.boxId
    if (probeBoxId !== undefined) {
      computerEnabled = await probeX11Toolset(backend, probeBoxId)
      if (!computerEnabled) {
        console.log('[openbot] computer 工具族未注册：Box 内 GUI 工具集（xdotool/scrot）探测未通过')
      }
    }
  }
  // 宿主屏幕/Windows 机内分支（P9-1/P9-3a）：条目在场即开注册——内置注入不依赖 X11 工具集。
  // **门是运行时可翻转**（P9-3a 真机验收修正：装配期布尔让运行中注册的条目重启才生效——
  // 在场性门天然可运行时翻转）：registerImageRoute 在网关开启后发现首批条目时调
  // ensureComputerTools 补注册（幂等）；装配期仍走下方静态分支（switchableGate 时序）。
  const ensureComputerTools = (reason: string): void => {
    // 幂等判据 = 已注册（非已使能）——v0.1.37 修：曾用 computerEnabled 判据把 env 强制门与
    // X11 探测两条路径挡在注册外（使能 true 即 return，工具永不注册——TOOL_NOT_FOUND）
    if (computerRegistered) return
    computerRegistered = true
    computerEnabled = true
    for (const tool of computerTools({
      backend: routedBackend, // 路由面——P8-4 起 agent 绑定的镜像 Box 也能 exec 到位
      bus: kernel.bus,
      onStream: kernel.onStream,
      transcript: kernel.transcript,
      screen: kernel.screen,
      // 截图净化（v0.1.117c 端点 400「image is not valid」根治）：nativeImage 解码 → ≤2048
      // 缩放 → 重编码合法 PNG——修复传输链任何环节的字节损坏；不可解码返回 null（1×1
      // 占位降级，如实不注坏图）
      sanitizeImage: async (img) => {
        try {
          const decoded = nativeImage.createFromBuffer(Buffer.from(img.base64, 'base64'))
          if (decoded.isEmpty()) return null
          const { width, height } = decoded.getSize()
          const MAX_EDGE = 2048
          if (width > MAX_EDGE || height > MAX_EDGE) {
            const k = MAX_EDGE / Math.max(width, height)
            return {
              base64: decoded.resize({ width: Math.round(width * k), height: Math.round(height * k) }).toPNG().toString('base64'),
              mime: 'image/png',
            }
          }
          return { base64: decoded.toPNG().toString('base64'), mime: 'image/png' }
        } catch {
          return null
        }
      },
      lock: guiLock,
      // 载体级动作闸（P9-1 裁定 F；P9-2 前缀判定——每条目一 box）：宿主屏幕上 computer
      // 动作恒过审批闸——「Box 内自由」在用户本机屏幕上不成立；截图不进闸（注册条目本身
      // 即「可看」的授权，注入才是主权面）
      actionGate: {
        gate: switchableGate,
        appliesTo: (boxId: string) => isHostScreenBoxId(boxId),
        reason: () => '宿主屏幕输入注入——agent 将在你的本机屏幕上执行鼠标/键盘动作',
      },
    })) {
      kernel.tools.register(tool)
    }
    console.log(`[openbot] computer 工具族已注册：${reason}`)
  }
  if (!computerEnabled && hasHostScreenRoute) {
    ensureComputerTools('宿主屏幕条目在场（内置注入，无需 X11 工具集）')
  }
  if (!computerEnabled && hasWindowsRoute) {
    ensureComputerTools('Windows 机内条目在场（PowerShell SendInput）')
  }
  // Android 设备分支（P9-3b）：android 协议条目在场即开注册（input/screenrecord 设备内建，
  // 无需设备端预装；设备碎片化能力差异由 v1.images.test 如实报告）
  if (!computerEnabled && hasAndroidRoute) {
    ensureComputerTools('Android 设备条目在场（input 注入）')
  }
  if (computerEnabled) {
    ensureComputerTools('装配期注册门通过（env 强制 / X11 探测 / 在场性条目）')
  }

  gatewayStarted = true // 网关已开——此后 registerImageRoute 的在场性门可运行时补注册

  const gateway = await startGateway({
    transport: kernel.transport,
    bus: kernel.bus,
    // WS /stream 连接登记：run 实况（hub）与 PTY 会话流（shellService）、GUI 实况（guiStream）
    // 三源并联；断连各自惰性清理。对向 PAUSE/RESUME 转发给 gui 流（背压即降帧的信号源）
    onStreamSession: (session) => {
      kernel.streamHub.attach(session)
      kernel.shellService.attach(session)
      kernel.guiStream.attach(session)
    },
    onStreamPause: (session, streamId, paused) => kernel.guiStream.onRemotePause(session, streamId, paused),
  })
  const replayed = await approvalGate.replayPending()
  // 插件运行时装载（boot）：已启用插件装载 manifest；事件源即常驻（docs/plan-plugins.md §5）
  await kernel.plugins
    .loadInstalled((await settings.getInstalledPlugins()).filter((p) => p.enabled))
    .catch(() => {})
  kernel.startWatchdog()
  kernel.statsService.start() // Box 遥测 + 宿主磁盘压力轮询（Step 6）

  // ---- 定时自动化 Scheduler（backlog ②）：扫描到点 → sendUserMessage（user lane 全管线继承） ----
  // 间隔默认 30s（env OPENBOT_AUTOMATION_INTERVAL 覆盖供 E2E 短周期）；触发幂等键
  // automation:<id>:<计划时间戳>——Scheduler 竞态下同一计划点不双发；agent 不在/受理失败
  // 照 markRun（每计划点只试一次，错误在 console 留痕——不无限重试打日志）
  const automationIntervalMs = Number(process.env.OPENBOT_AUTOMATION_INTERVAL)
  const automationTimer = setInterval(
    () => {
      void (async () => {
        const now = Date.now()
        for (const rule of await automationStore.list()) {
          if (!rule.enabled) continue
          const ref = Math.max(rule.lastRunAt ?? 0, now - 2 * (automationIntervalMs || 30_000))
          const fireAt = nextAfter(rule.cron, ref)
          if (fireAt === null || fireAt > now) continue
          await automationStore.markRun(rule.id, fireAt)
          try {
            await kernel.messaging.sendUserMessage({
              toAgentId: rule.agentId,
              text: rule.prompt,
              nonce: `automation:${rule.id}:${fireAt}`,
            })
            console.log(`[openbot] 自动化触发：${rule.name}（${rule.agentId} @ ${new Date(fireAt).toLocaleString('zh-CN')}）`)
          } catch (err) {
            console.error(`[openbot] 自动化触发失败（${rule.name}）：`, err instanceof Error ? err.message : err)
          }
        }
      })()
    },
    Number.isFinite(automationIntervalMs) && automationIntervalMs >= 200 ? automationIntervalMs : 30_000,
  )
  automationTimer.unref()

  // ---- 跨用户房间接入（P7 多房间轮）：relays 数组并行连接 ----
  // settings.relays（P7 早期 relay 单字段读取端兼容回退）+ env 单组叠加（E2E/无头通道）。
  // 装配期决策（改动重启生效）；远端成员是壳级易态投影（hello 重建、不持久化）。
  // 键空间纪律：host 的 memberId/requestId 是房内自增（跨房必撞）——事件带 roomId、
  // turn 配对键与 nonce 一律 `<roomId>:<id>` 前缀
  const relayConfigs = (await settings.getRelays()).filter(
    (c) => c.enabled && c.url !== '' && c.roomId !== '' && c.inviteCode !== '',
  )
  if (
    process.env.OPENBOT_RELAY_URL !== undefined &&
    process.env.OPENBOT_RELAY_ROOM !== undefined &&
    process.env.OPENBOT_RELAY_INVITE !== undefined
  ) {
    relayConfigs.push({
      enabled: true,
      url: process.env.OPENBOT_RELAY_URL,
      roomId: process.env.OPENBOT_RELAY_ROOM,
      inviteCode: process.env.OPENBOT_RELAY_INVITE,
      displayName: process.env.OPENBOT_RELAY_NAME ?? 'OpenBot 用户',
    })
  }

  /** agent 名缓存（mirror 出站署名用；名册事件刷新） */
  const agentNames = new Map<string, string>()
  const refreshAgentNames = async (): Promise<void> => {
    for (const a of await kernel.agentStore.list()) agentNames.set(a.agentId, a.name)
  }
  await refreshAgentNames()
  kernel.bus.on('v1.system.roster', () => {
    void refreshAgentNames()
  })

  // ---- 系统通知（2026-11-02 用户需求）：Agent run 终态经系统通知提醒 ----
  // Electron Notification 三平台统一路径（win/mac/linux）。平台容错如实降级：Linux 依赖
  // 桌面通知服务（D-Bus org.freedesktop.Notifications——WM-only 环境缺席）；macOS 开发态
  // 未打包（无 bundle id）系统可能不显示——isSupported + try/catch 双保险静默。
  // 内存 flag 保存即热生效（与执行预算同款）；点击聚焦窗口待壳层注入回调（backlog）
  let systemNotify = await settings.getSystemNotify()
  /** 各 agent 最近终答截断（通知正文——finished 事件不含文本，缓存于 message.agent） */
  const lastAgentText = new Map<string, string>()
  kernel.bus.on('v1.message.agent', (event) => {
    const { agentId, text } = event.payload as { agentId: string; text: string }
    lastAgentText.set(agentId, text.length > 120 ? `${text.slice(0, 120)}…` : text)
    if (lastAgentText.size > 50) {
      const oldest = lastAgentText.keys().next().value
      if (oldest !== undefined) lastAgentText.delete(oldest)
    }
  })
  kernel.bus.on('v1.lifecycle.finished', (event) => {
    if (!systemNotify || !Notification.isSupported()) return
    const { state, agentId } = event.payload as LifecycleFinishedPayload
    const outcome =
      state === 'succeeded'
        ? '任务完成'
        : state === 'failed'
          ? '执行失败'
          : state === 'aborted'
            ? '已中止'
            : state === 'escaped'
              ? '已转后台'
              : '已结束'
    try {
      new Notification({
        title: `${agentNames.get(agentId) ?? agentId} · ${outcome}`,
        body: lastAgentText.get(agentId) ?? '',
      }).show()
    } catch {
      /* 平台通知服务缺席——如实静默（不打断主链路） */
    }
  })
  kernel.transport.register('v1.settings.setSystemNotify', async (payload) => {
    const { enabled } = z.object({ enabled: z.boolean() }).parse(payload)
    await settings.setSystemNotify(enabled)
    systemNotify = enabled // 热生效（内存 flag——下一个终态即生效）
    return { ok: true, enabled }
  }, z.object({ enabled: z.boolean() }))

  /** inbound turn 终答配对：`<roomId>:<requestId>` → { 执行 agentId, 回程房间 }（FIFO 消费） */
  const pendingTurns = new Map<string, { roomId: string; agentId: string }>()

  const relays = relayConfigs.map((cfg) => {
    /** 本房远端成员表（memberId 房内命名——事件带 roomId 由消费方组织命名空间） */
    const members = new Map<string, { memberId: string; displayName: string; connected: boolean }>()
    const publishMembers = (): void => {
      kernel.bus.emit('v1.system.remote-members', { roomId: cfg.roomId, members: [...members.values()] })
    }
    const client = new RelayClient({
      url: cfg.url,
      roomId: cfg.roomId,
      inviteCode: cfg.inviteCode,
      displayName: cfg.displayName === '' ? 'OpenBot 用户' : cfg.displayName,
      onServerMessage: (msg) => {
        if (msg.kind === 'hello') {
          members.clear()
          for (const m of msg.room.members) {
            if (m.memberId !== msg.memberId) members.set(m.memberId, { ...m, connected: true })
          }
          publishMembers()
        } else if (msg.kind === 'room-event') {
          if (msg.event === 'member-joined') {
            members.set(msg.memberId, { memberId: msg.memberId, displayName: msg.displayName, connected: true })
          } else {
            members.delete(msg.memberId)
          }
          publishMembers()
        } else if (msg.kind === 'mirror-message') {
          kernel.bus.emit('v1.message.remote', {
            messageId: msg.nonce,
            roomId: cfg.roomId,
            fromMemberId: msg.fromMemberId,
            speakerKind: msg.speakerKind,
            speakerName: msg.speakerName,
            text: msg.text,
          })
        } else if (msg.kind === 'turn-request') {
          // 受控进入（P7 裁定 D）：请求文本作为用户消息入队——lane 排队与审批闸门照走，零新特权路径
          void (async () => {
            const agents = await kernel.agentStore.list()
            const hinted = msg.agentHint !== undefined ? agents.find((a) => a.name === msg.agentHint) : undefined
            const target = hinted ?? agents.find((a) => a.role === 'steward')
            if (target === undefined) {
              client.sendTurnResult({ requestId: msg.requestId, status: 'rejected', text: '本端名册为空——无法受理远端 turn' })
              return
            }
            pendingTurns.set(`${cfg.roomId}:${msg.requestId}`, { roomId: cfg.roomId, agentId: target.agentId })
            await kernel.messaging.sendUserMessage({
              toAgentId: target.agentId,
              text: msg.prompt,
              nonce: `remote-turn:${cfg.roomId}:${msg.requestId}`,
            })
          })().catch((err) => {
            console.error('[openbot] 远端 turn 受理失败：', err)
            try {
              client.sendTurnResult({ requestId: msg.requestId, status: 'rejected', text: '受理失败（见本端日志）' })
            } catch {
              /* 断连竞态——host 侧 pending 过期兜底 */
            }
          })
        }
        // turn-result 到达 = 本端发起请求的应答——一期本端无发起入口（协议对称，UI 入口记档后续）
      },
      onStateChange: (state, detail) => {
        console.log(`[openbot] relay(${cfg.roomName ?? cfg.roomId}) ${state}${detail?.retryInMs !== undefined ? `（${detail.retryInMs}ms 后重试）` : ''}`)
      },
    })
    return { cfg, client }
  })

  for (const { client } of relays) client.start()

  if (relays.length > 0) {
    /** 出站镜像到所有已连接房间（v1.message.remote 是独立键——远端来的不再镜像，天然不回环）；
     *  user 署名按各房自己的呈现名（一端多房时在每房的名字可不同） */
    const mirrorTo = (speakerKind: 'user' | 'agent', text: string, speakerOf: (cfg: RelaySettings) => string): void => {
      for (const { cfg, client } of relays) {
        if (!client.connected) continue
        try {
          client.sendMirror({ speakerKind, speakerName: speakerOf(cfg), text })
        } catch {
          /* 断连竞态——易态镜像丢弃不记账务 */
        }
      }
    }
    kernel.bus.on('v1.message.user', (event) => {
      const { text } = event.payload as MessageUserPayload
      mirrorTo('user', text, (cfg) => (cfg.displayName === '' ? '你' : cfg.displayName))
    })
    // agent 终答：mirror 出站 + inbound turn 的 result 配对（一个 handler 两个职责——同源事件）
    kernel.bus.on('v1.message.agent', (event) => {
      const { agentId, text } = event.payload as MessageAgentPayload
      mirrorTo('agent', text, () => agentNames.get(agentId) ?? agentId)
      for (const [key, pending] of pendingTurns) {
        if (pending.agentId === agentId) {
          pendingTurns.delete(key)
          const target = relays.find((r) => r.cfg.roomId === pending.roomId)
          try {
            target?.client.sendTurnResult({ requestId: key.slice(pending.roomId.length + 1), status: 'ok', text })
          } catch {
            /* 断连竞态——发起端超时语义兜底 */
          }
          break
        }
      }
    })
    // run 非正常收敛（failed/aborted/escaped）：pending turn 如实回 rejected（终答不会再到）
    kernel.bus.on('v1.lifecycle.finished', (event) => {
      const { state, agentId, code } = event.payload as LifecycleFinishedPayload
      if (state === 'succeeded') return
      for (const [key, pending] of pendingTurns) {
        if (pending.agentId === agentId) {
          pendingTurns.delete(key)
          const target = relays.find((r) => r.cfg.roomId === pending.roomId)
          try {
            target?.client.sendTurnResult({
              requestId: key.slice(pending.roomId.length + 1),
              status: 'rejected',
              text: `执行未完成（${state}${code !== undefined ? `：${code}` : ''}）`,
            })
          } catch {
            /* 断连竞态 */
          }
          break
        }
      }
    })
  }

  const sandboxNote =
    chosen.backendId === chosen.wanted || chosen.wanted === 'mock'
      ? chosen.backendId
      : `${chosen.backendId}（${chosen.reason ?? '降级'}）`
  console.log(
    `[openbot] 内核就绪：网关 127.0.0.1:${gateway.port}；provider ${provider.configured ? '已配置' : '空缺（settings 配置后生效）'}；沙箱 ${sandboxNote}；恢复审批 ${replayed} 条`,
  )

  return {
    kernel,
    gateway,
    settings,
    provider,
    approvalGate,
    sandbox: sandboxStatus,
    async dispose() {
      kernel.shellService.dispose() // 杀全部 PTY 会话（不留后台 shell）
      kernel.guiStream.dispose() // 杀全部 GUI 采集管道（不留后台 ffmpeg——孤儿纪律同款）
      kernel.screen.dispose?.() // 杀全部常驻注入通道（P8-2 起内聚适配器——同款孤儿纪律；P9-2 路由器动态清单含 per-entry 宿主屏幕适配器）
      windowProbe?.dispose() // 窗口清单探测通道（v1.hostscreen.windows 单例）
      kernel.statsService.stop()
      kernel.stopWatchdog()
      engineWatchdog?.stop() // 引擎看门狗定时器（v0.1.90——孤儿不留）
      clearInterval(automationTimer) // Scheduler 孤儿定时器不留
      for (const { client } of relays) await client.stop() // 断全部房间连接（清重连定时器——孤儿不留）
      await gateway.close()
    },
  }
}
