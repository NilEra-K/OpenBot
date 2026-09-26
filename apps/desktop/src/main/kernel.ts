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
import { app, desktopCapturer, safeStorage, screen as electronScreen } from 'electron'
import { z } from 'zod'
import { KernelError } from '@openbot/core'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { stat, statfs } from 'node:fs/promises'
import { assembleKernel, chooseBackend } from '@openbot/coordinator'
import type { AssembledKernel, ChooseResult, DiskFact } from '@openbot/coordinator'
import { startGateway, RelayClient } from '@openbot/transport'
import type { GatewayHandle } from '@openbot/transport'
import type { LifecycleFinishedPayload, MessageAgentPayload, MessageUserPayload } from '@openbot/core'
import { NodeFs, SettingsStore, MemoryStore, AutomationStore, ImageStore, nextAfter } from '@openbot/state'
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
  UtmBoxBackend,
  RoutingBoxBackend,
  WslBoxBackend,
  HostScreenBoxBackend,
  HostScreenControl,
  ScreenControlRouter,
  X11ScreenControl,
  HOST_SCREEN_BOX_ID,
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
})
const providerInputSchema = z.object({
  name: z.string().min(1),
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
  carrier: z.enum(['container', 'ssh', 'host-screen']),
  image: z.string().trim().min(1).max(200).optional(),
  host: z.string().trim().min(1).max(200).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  user: z.string().trim().min(1).max(64).optional(),
  keyPath: z.string().trim().min(1).max(500).optional(),
  controlProtocol: z.enum(['x11', 'none', 'host']),
  display: z.string().trim().max(40).optional(),
})
const imageInputSchema = imageInputBase.superRefine((v, ctx) => {
  if (v.carrier === 'container' && (v.image === undefined || v.image === '')) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['image'], message: '容器镜像条目须指定镜像名' })
  }
  if (v.carrier === 'ssh' && (v.host === undefined || v.host === '')) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['host'], message: 'SSH 镜像条目须指定主机地址' })
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

/** 装配桌面内核（app ready 后调用；safeStorage 依赖 ready 状态） */
export async function assembleDesktop(): Promise<DesktopKernel> {
  // NodeFs 路径约定 posix 风格（Windows 同样接受 '/'）
  const userDataRoot = app.getPath('userData').replaceAll('\\', '/')
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
  const probes = await probeAll(runProcess, platform, sshOpts)
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
  const backend: BoxBackend =
    chosen.backendId === 'wsl'
      ? new WslBoxBackend({ rootfs: rootfsPath, dir: `${userDataRoot}/boxes`, now: Date.now })
      : chosen.backendId === 'docker'
        ? new DockerBoxBackend({ image: dockerImage, now: Date.now })
        : chosen.backendId === 'podman'
          ? new PodmanBoxBackend({ image: podmanImage, now: Date.now })
          : chosen.backendId === 'nspawn'
            ? new NspawnBoxBackend({
                rootfs: nspawnRootfsPath,
                snapshotDir: `${userDataRoot}/boxes/nspawn-snapshots`,
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
  // 镜像注册表（plan-image-firstclass P8-3）：镜像条目获得一等公民地位——Agent 绑定镜像
  // 而非后端（绑定随 P8-4）。路由后端包一层多路 facade：镜像条目 id → 后端实例（container
  // 条目复用全局 OCI 底座、create 时把路由 id 改写为实际镜像名；ssh 条目独立 SshBoxBackend）。
  // 路由表运行时可变（add/remove 即时生效——按调用分发无状态，与沙箱偏好的装配期决策不同）
  const imageStore = new ImageStore({ fs, root: dataRoot, now: Date.now })
  const routingBackend = new RoutingBoxBackend({ fallback: backend })
  // ---- 宿主屏幕载体（plan-screen-firstclass P9-1）----
  // 纯屏幕 Box（记账面）+ 内置注入适配器 + 路由器：kernel.screen 按 boxId 分发（宿主屏幕 →
  // HostScreenControl；其余 → X11 经 routedBackend exec）——消费方（工具族/实况/gui 命令面）
  // 零载体感知。Electron 面（desktopCapturer/screen API）收口 bridge 注入，boxes 零 electron 依赖。
  const hostScreenBackend = new HostScreenBoxBackend({ now: Date.now })
  let hasHostScreenRoute = false
  const hostScreenBridge: HostScreenBridge = {
    // 主屏物理像素（DIP × scaleFactor——desktopCapturer 采集与 SendInput 同一坐标系）
    geometry: () => {
      try {
        const d = electronScreen.getPrimaryDisplay()
        return { width: Math.round(d.size.width * d.scaleFactor), height: Math.round(d.size.height * d.scaleFactor) }
      } catch {
        return null // 桌面会话不可用——如实（act/采集路径各自给出可见错误）
      }
    },
    captureFrame: async ({ maxWidth, quality }) => {
      const geo = (() => {
        try {
          const d = electronScreen.getPrimaryDisplay()
          return { width: Math.round(d.size.width * d.scaleFactor), height: Math.round(d.size.height * d.scaleFactor) }
        } catch {
          return null
        }
      })()
      if (geo === null) throw new KernelError('SCREEN_CAPTURE_FAILED', '桌面会话不可用——无法采集主屏')
      const width = Math.min(maxWidth, geo.width)
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width, height: Math.max(1, Math.round((geo.height * width) / geo.width)) },
      })
      const img = sources[0]?.thumbnail
      if (img === undefined || img.isEmpty()) {
        throw new KernelError('SCREEN_CAPTURE_FAILED', '无可用屏幕采集源（thumbnail 为空）')
      }
      const size = img.getSize()
      return { bytes: new Uint8Array(img.toJPEG(quality)), width: size.width, height: size.height }
    },
  }
  const hostScreenControl = new HostScreenControl({ bridge: hostScreenBridge })
  const x11ScreenControl = new X11ScreenControl({
    host: routingBackend,
    ...(process.env.OPENBOT_GUI_DISPLAY !== undefined ? { display: process.env.OPENBOT_GUI_DISPLAY } : {}),
  })
  const screenRouter = new ScreenControlRouter({
    resolve: (boxId) => (boxId === HOST_SCREEN_BOX_ID ? hostScreenControl : x11ScreenControl),
    adapters: [x11ScreenControl, hostScreenControl],
  })
  /** 宿主 ffmpeg 在场性（v1.images.test 报告 L1/L0 档位——探测一次即时结算，不缓存跨调用） */
  const probeHostFfmpeg = async (): Promise<boolean> => {
    try {
      return (await runProcess({ command: ['ffmpeg', '-version'], timeoutMs: 5_000 })).exitCode === 0
    } catch {
      return false
    }
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
      // 多条目共享同一台「屏幕设备」（一期恒主屏）——同一后端实例记账多对一
      routingBackend.registerRoute(entry.id, { backend: hostScreenBackend })
      hasHostScreenRoute = true
    } else if (chosen.backendId === 'docker' || chosen.backendId === 'podman') {
      routingBackend.registerRoute(entry.id, {
        backend,
        translate: (spec) => ({ ...spec, image: entry.image ?? dockerImage }),
      })
    }
    // 非 OCI 底座上的 container 条目：不注册路由（v1.images.test 如实报告不可路由）
  }
  for (const entry of await imageStore.list()) registerImageRoute(entry)
  /** 连接测试（D3——v1.images.test 的探测报告，如实不造假）：
   *  ssh = 真实 attach（连通验证 + 工作目录）→ x11 协议加测 GUI 工具集 → 断开；
   *  container = 按 CLI 查镜像在场（docker inspect / podman exists）；底座非 OCI 如实报告不可路由 */
  const testImageEntry = async (entry: ImageEntry): Promise<{ ok: boolean; detail?: string; reason?: string }> => {
    if (entry.carrier === 'host-screen') {
      // 宿主屏幕：几何 + ffmpeg 档位报告（L0/L1 如实——无真实注入，测试零副作用）
      const geo = hostScreenBridge.geometry()
      if (geo === null) {
        return { ok: false, reason: '宿主屏幕几何不可用（桌面会话未就绪）' }
      }
      const ff = await probeHostFfmpeg()
      return {
        ok: true,
        detail: `宿主屏幕就绪（主屏 ${geo.width}×${geo.height} 物理像素）；实况流 ${
          ff ? 'h264（ffmpeg 在场）' : 'mjpeg 轮询（ffmpeg 缺席——安装后自动升级）'
        }`,
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
    if (chosen.backendId !== 'docker' && chosen.backendId !== 'podman') {
      return { ok: false, reason: '当前沙箱后端不是 Docker/Podman——容器镜像条目不可路由（设置页切换后端后重试）' }
    }
    const cli = chosen.backendId
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
  const kernel = assembleKernel({
    fs,
    root: dataRoot,
    // 镜像路由后端（P8-3）：镜像条目 id → 后端实例的多路 facade——services/工具族零改动
    backend: routedBackend,
    // 桌面控制路由器（P9-1）：按 boxId 分发 X11/宿主屏幕——coordinator 内置 X11 缺省面被覆盖
    screen: screenRouter,
    // save/recall 工具 + 会话装配「此前记忆」注入（每轮同步读缓存；addAgent 预载）
    memory: memoryStore,
    // run 策略上调（2026-09-06 进展驱动 grace 语义）：无进展 5 分钟才逃逸（慢模型长思考/
    // 多轮工具循环在动就不算停滞）、总时长 15 分钟硬限兜底失控——CLI/测试保持内核缺省
    runPolicy: { graceMs: 300_000, deadlineMs: 900_000 },
    // 工具轮预算上调（8→16）：复杂任务（装环境/多文件/调试）合法轮数多——配合收尾轮机制
    // （预算打穿时模型仍会交代进展），不再无声失败
    maxToolRounds: 16,
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
      }
    })
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
    // cron 预览（模态输入即时反馈——解析单一来源在内核，renderer 不 import 内核包）
    .register('v1.automations.preview', async (payload) => {
      const { cron } = z.object({ cron: z.string() }).parse(payload)
      const next = nextAfter(cron, Date.now())
      return { nextAt: next, readable: next === null ? '该规则永不触发（如 2 月 30 日）' : new Date(next).toLocaleString('zh-CN') }
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
      await imageStore.remove(id)
      routingBackend.removeRoute(id)
      return { ok: true }
    }, z.object({ id: z.string() }))
    .register('v1.images.test', async (payload) => {
      const { id } = z.object({ id: z.string() }).parse(payload)
      const entry = await imageStore.get(id)
      if (entry === null) throw new KernelError('STATE_IMAGE_NOT_FOUND', `镜像条目不存在：${id}`)
      return testImageEntry(entry)
    }, z.object({ id: z.string() }))
    // 可用镜像探测（2026-09-14）：环境里实际在场的镜像清单（宿主 docker/podman + WSL 发行版内
    // docker）——注册表只含手动条目，此命令补「用户无从得知有哪些镜像」的发现面。
    // 按需触发（设置页按钮），只报告事实不自动入库；装配期已就绪的 platform 从作用域注入
    .register('v1.images.scan', async () => ({ sources: await scanEnvImages({ run: runProcess, platform }) }))
    .register('v1.sandbox.status', async () => ({
      preference: sandboxStatus.preference,
      stored: await settings.getSandbox(),
      backendId: sandboxStatus.chosen.backendId,
      wanted: sandboxStatus.chosen.wanted,
      ...(sandboxStatus.chosen.reason !== undefined ? { reason: sandboxStatus.chosen.reason } : {}),
      probes: sandboxStatus.probes,
      rootfsPath: sandboxStatus.rootfsPath,
      rootfsReady: sandboxStatus.rootfsReady,
      backendCaps: sandboxStatus.backendCaps,
    }))
    .register('v1.sandbox.set', async (payload) => {
      const { preference: pref } = sandboxSetSchema.parse(payload)
      await settings.setSandbox(pref)
      return { ok: true, restartRequired: true }
    }, sandboxSetSchema)
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
      const { name, color, role, modelProvider, imageId } = registerAgentSchema.parse(payload)
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
    .register('v1.system.setDataRoot', async (payload) => {
      const { path } = z
        .object({ path: z.string().trim().min(1).max(500).nullable() })
        .parse(payload)
      if (path === null || path === '') {
        await fs.write(dataRootMarker, '')
        return { ok: true, restartRequired: true }
      }
      if (!/^[a-zA-Z]:[\\/]/.test(path) && !path.startsWith('/')) {
        throw new KernelError('STATE_DATA_ROOT_INVALID', `须为绝对路径（如 D:\\OpenBotData）：${path}`)
      }
      try {
        await fs.write(`${path}/.openbot-root-probe`, '1')
        await fs.remove(`${path}/.openbot-root-probe`)
      } catch (err) {
        throw new KernelError('STATE_DATA_ROOT_INVALID', `目录不可用：${err instanceof Error ? err.message : String(err)}`)
      }
      await fs.write(dataRootMarker, path)
      return { ok: true, restartRequired: true }
    }, z.object({ path: z.string().trim().min(1).max(500).nullable() }))

  await applyProvider()
  await kernel.addAgent({ agentId: 'steward', name: '管家', llm: provider, steward: true })

  // boot 恢复持久化名册的运行时态（P5 后修复）：agentStore 是唯一真相，但调度器/Box/llm 是内存态——
  // 重启后不重建则自建 agent「名册在、调度器无」：建群/发消息按 STATE_AGENT_NOT_FOUND 拒绝。
  // addAgent 幂等分支只重建内存态（名册不重复写）；steward 已上方装配（跳过防 mock 后端二次建 Box）
  for (const profile of await kernel.agentStore.list()) {
    if (profile.agentId === 'steward') continue
    // 镜像绑定恢复（P8-4）：悬空（条目已删）静默回默认 + 告警留痕——modelProvider 悬空双语义同款；
    // 绑定在场则 create 直接落对应载体（路由后端按 id 分发——不可达机器在此如实失败并冒泡）
    let imageId: string | undefined
    if (profile.imageId !== undefined) {
      if ((await imageStore.get(profile.imageId)) !== null) {
        imageId = profile.imageId
      } else {
        console.warn(`[openbot] agent ${profile.agentId} 绑定的镜像条目 ${profile.imageId} 已删除——回默认沙箱`)
      }
    }
    await kernel.addAgent({
      agentId: profile.agentId,
      name: profile.name,
      ...(profile.color !== undefined ? { color: profile.color } : {}),
      // 模型覆盖（backlog ③）：恢复路径悬空静默回继承（告警留痕）——档案可能已被删除
      llm: await providerOfAgent(profile.modelProvider, true),
      ...(imageId !== undefined ? { imageId } : {}),
      steward: profile.role === 'steward',
    })
  }

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
  // 宿主屏幕分支（P9-1）：条目在场即开注册——内置注入不依赖 X11 工具集（跳过探测）。
  // 门语义仍是装配期布尔（全局门）：运行中新注册的宿主屏幕条目重启后才生效（与 X11 门一致）。
  if (!computerEnabled && hasHostScreenRoute) {
    computerEnabled = true
    console.log('[openbot] computer 工具族已注册：宿主屏幕条目在场（内置注入，无需 X11 工具集）')
  }
  if (computerEnabled) {
    for (const tool of computerTools({
      backend: routedBackend, // 路由面——P8-4 起 agent 绑定的镜像 Box 也能 exec 到位
      bus: kernel.bus,
      onStream: kernel.onStream,
      transcript: kernel.transcript,
      screen: kernel.screen,
      lock: guiLock,
      // 载体级动作闸（P9-1 裁定 F）：宿主屏幕上 computer 动作恒过审批闸——「Box 内自由」
      // 在用户本机屏幕上不成立；截图不进闸（注册条目本身即「可看」的授权，注入才是主权面）
      actionGate: {
        gate: switchableGate,
        appliesTo: (boxId: string) => boxId === HOST_SCREEN_BOX_ID,
        reason: () => '宿主屏幕输入注入——agent 将在你的本机屏幕上执行鼠标/键盘动作',
      },
    })) {
      kernel.tools.register(tool)
    }
    console.log('[openbot] computer 工具族已注册（GUI 工具集探测 ∩ 视觉 provider——生产门兑现）')
  }

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
      kernel.screen.dispose?.() // 杀全部常驻注入通道（P8-2 起内聚适配器——同款孤儿纪律）
      kernel.statsService.stop()
      kernel.stopWatchdog()
      clearInterval(automationTimer) // Scheduler 孤儿定时器不留
      for (const { client } of relays) await client.stop() // 断全部房间连接（清重连定时器——孤儿不留）
      await gateway.close()
    },
  }
}
