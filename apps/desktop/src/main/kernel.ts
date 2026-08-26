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
import { app, safeStorage } from 'electron'
import { z } from 'zod'
import { KernelError } from '@openbot/core'
import { stat, statfs } from 'node:fs/promises'
import { assembleKernel, chooseBackend } from '@openbot/coordinator'
import type { AssembledKernel, ChooseResult, DiskFact } from '@openbot/coordinator'
import { startGateway } from '@openbot/transport'
import type { GatewayHandle } from '@openbot/transport'
import { NodeFs, SettingsStore } from '@openbot/state'
import type { SandboxPreference } from '@openbot/state'
import { LlmError, LlmErrorCodes, OpenAiCompatProvider, AnthropicProvider } from '@openbot/llm'
import type { ChatProvider, ChatRequest, ChatResponse } from '@openbot/llm'
import type { ResolvedProvider } from '@openbot/state'
import { ManualApprovalGate } from '@openbot/runner'
import { DockerBoxBackend, MockBoxBackend, PodmanBoxBackend, WslBoxBackend, probeAll, runProcess } from '@openbot/boxes'
import type { BackendProbe, BoxBackend, BoxStats } from '@openbot/boxes'

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

const providerInputSchema = z.object({
  name: z.string().min(1),
  baseUrl: z.string().url(),
  model: z.string().min(1),
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
const resolveSchema = z.object({
  nonce: z.string().min(1),
  decision: z.enum(['approved', 'denied']),
})
const sandboxPrefSchema = z.enum(['auto', 'mock', 'wsl', 'docker', 'podman'])
const sandboxSetSchema = z.object({ preference: sandboxPrefSchema })
/** 注册 agent（P4 Step 5）：name 必填（去空白 1-24 字）；color hex6 可选；role 默认 worker（steward 走任命事务语义） */
const registerAgentSchema = z.object({
  name: z.string().trim().min(1).max(24),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
  role: z.enum(['steward', 'worker']).optional(),
})
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

/** 装配桌面内核（app ready 后调用；safeStorage 依赖 ready 状态） */
export async function assembleDesktop(): Promise<DesktopKernel> {
  // NodeFs 路径约定 posix 风格（Windows 同样接受 '/'）
  const userDataRoot = app.getPath('userData').replaceAll('\\', '/')
  const dataRoot = `${userDataRoot}/data`
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
  // OCI 默认镜像（P5 Step 5/6）：env 按后端分别覆盖（国内网络/私有 registry 确定性）
  const dockerImage = process.env.OPENBOT_DOCKER_IMAGE ?? 'ubuntu:24.04'
  const podmanImage = process.env.OPENBOT_PODMAN_IMAGE ?? 'ubuntu:24.04'
  const probes = await probeAll(runProcess)
  const chosen = chooseBackend(preference, probes, {
    wslRootfs: rootfsReady,
    // docker/podman 随 P5 Step 5/6 兑现（OCI 底座 + 同构薄壳）——四后端矩阵齐
    implemented: ['mock', 'wsl', 'docker', 'podman'],
  })
  const backend: BoxBackend =
    chosen.backendId === 'wsl'
      ? new WslBoxBackend({ rootfs: rootfsPath, dir: `${userDataRoot}/boxes`, now: Date.now })
      : chosen.backendId === 'docker'
        ? new DockerBoxBackend({ image: dockerImage, now: Date.now })
        : chosen.backendId === 'podman'
          ? new PodmanBoxBackend({ image: podmanImage, now: Date.now })
          : new MockBoxBackend({ now: Date.now, ...mockStatsEnv() })
  // stored 初值现读；status 命令每次现读（set 后无需改内存——重启才生效，呈现以 settings 为真相）
  const sandboxStatus: SandboxStatus = {
    preference,
    stored: await settings.getSandbox(),
    chosen,
    probes,
    rootfsPath,
    rootfsReady,
  }

  let approvalGate!: ManualApprovalGate
  const kernel = assembleKernel({
    fs,
    root: dataRoot,
    backend,
    // 真实时钟：确定性断言只存在于内核测试与 CLI（plan-p2 风险与地雷）
    approvalGateFactory: (deps) => {
      approvalGate = new ManualApprovalGate(deps)
      return approvalGate
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

  /** 档案 → provider 实现（P4 Step 11）：protocol 分支 anthropic（messages API）/ openai-compat 缺省 */
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
    return resolved.protocol === 'anthropic'
      ? new AnthropicProvider({ config })
      : new OpenAiCompatProvider({ config })
  }

  /** settings 变更后热切换 provider 与回退实现（明文 key 只在本进程内存中存在） */
  const applyProvider = async (): Promise<void> => {
    try {
      provider.swap(buildProvider(await settings.resolve()))
    } catch {
      provider.clear() // 无默认 provider / 解析失败 → 空缺态（chat 抛 LLM_NO_PROVIDER，UI 引导配置）
    }
    try {
      const fallbackName = await settings.getFallback()
      provider.swapFallback(fallbackName === null ? null : buildProvider(await settings.resolve(fallbackName)))
    } catch {
      provider.swapFallback(null) // 回退档案解析失败 → 无回退（主力路径不受影响）
    }
  }

  // ---- 命令面扩展（壳装配职责：CLI/E2E 用 Auto 闸门时不需要这些命令） ----
  kernel.transport
    .register('v1.settings.list', async () => {
      // 展示清单（无 key 材料）+ 当前默认与回退（renderer 空缺态判断）
      const providers = await settings.list()
      const current = await settings.load()
      return {
        providers,
        defaultProvider: current.defaultProvider ?? null,
        fallbackProvider: current.fallbackProvider ?? null,
      }
    })
    .register('v1.settings.upsertProvider', async (payload) => {
      const view = await settings.upsert(providerInputSchema.parse(payload))
      await applyProvider() // 同名=default 或无默认时也可能切换，统一重应用
      return view
    }, providerInputSchema)
    .register('v1.settings.setDefault', async (payload) => {
      await settings.setDefault(nameSchema.parse(payload).name)
      await applyProvider()
      return { ok: true }
    }, nameSchema)
    .register('v1.settings.removeProvider', async (payload) => {
      await settings.remove(nameSchema.parse(payload).name)
      await applyProvider()
      return { ok: true }
    }, nameSchema)
    // 回退端点（P4 Step 11）：引用校验在 settings 层；null = 清除；热切换立即生效
    .register('v1.settings.setFallback', async (payload) => {
      await settings.setFallback(setFallbackSchema.parse(payload).name)
      await applyProvider()
      return { ok: true }
    }, setFallbackSchema)
    // LLM 生效事实（状态栏「当轮生效端点」）：activeLane = 最近一轮成功响应实际走的通道
    .register('v1.settings.llmStatus', async () => ({
      configured: provider.configured,
      activeLane: provider.activeLane,
      primary: (await settings.load()).defaultProvider ?? null,
      fallback: await settings.getFallback(),
    }))
    .register('v1.approval.resolve', async (payload) => {
      const { nonce, decision } = resolveSchema.parse(payload)
      return { approved: await approvalGate.resolve(nonce, decision) }
    }, resolveSchema)
    .register('v1.approval.pending', async () => approvalGate.pending())
    // 审批闸门模式（P4 Step 7 档案事实）：桌面装配固定 Manual——出 Box 需用户批准（如实呈现） */
    .register('v1.approval.mode', async () => ({ mode: 'manual' as const }))
    // caps 驱动 UI：按钮渲染依据后端能力声明（永不出现「UI 有按钮但后端不支持」）
    .register('v1.boxes.caps', async () => kernel.backend.caps())
    // 沙箱后端：状态呈现 + 偏好写入（重启生效——后端选择是装配期决策，不热切换）
    .register('v1.sandbox.status', async () => ({
      preference: sandboxStatus.preference,
      stored: await settings.getSandbox(),
      backendId: sandboxStatus.chosen.backendId,
      wanted: sandboxStatus.chosen.wanted,
      ...(sandboxStatus.chosen.reason !== undefined ? { reason: sandboxStatus.chosen.reason } : {}),
      probes: sandboxStatus.probes,
      rootfsPath: sandboxStatus.rootfsPath,
      rootfsReady: sandboxStatus.rootfsReady,
    }))
    .register('v1.sandbox.set', async (payload) => {
      const { preference: pref } = sandboxSetSchema.parse(payload)
      await settings.setSandbox(pref)
      return { ok: true, restartRequired: true }
    }, sandboxSetSchema)
    // 注册 agent（P4 Step 5）：经装配 addAgent（名册+调度器+专属 Box+turn 接线）；
    // llm 共享 SwitchableChatProvider——主力模型切换对全部 agent 生效（与启动装配同语义）
    .register('v1.system.registerAgent', async (payload) => {
      const { name, color, role } = registerAgentSchema.parse(payload)
      // 管家前置检查：在位时直接拒绝（不创建半成品 agent；任命事务由 addAgent 兜底不变量）
      if (role === 'steward' && (await kernel.agentStore.findSteward()) !== null) {
        throw new KernelError('STATE_STEWARD_EXISTS', '管家已在位（须先罢免或转移）')
      }
      // agentId 服务端生成：agent-N（名册内既有同前缀序号递增；单用户桌面应用无并发竞争）
      const ids = new Set((await kernel.agentStore.list()).map((a) => a.agentId))
      let n = 1
      while (ids.has(`agent-${n}`)) n++
      const agentId = `agent-${n}`
      await kernel.addAgent({ agentId, name, color, llm: provider, steward: role === 'steward' })
      return { agentId, name, role: role ?? 'worker', ...(color !== undefined ? { color } : {}) }
    }, registerAgentSchema)

  await applyProvider()
  await kernel.addAgent({ agentId: 'steward', name: '管家', llm: provider, steward: true })

  // 装配配置（E2E/演示用）：附加 worker agent——A2A 需要至少两名成员；共享同一
  // SwitchableChatProvider（主力模型切换对管家与全部 agent 生效，符合设置页语义）。
  const extraAgents = (process.env.OPENBOT_EXTRA_AGENTS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
  for (const agentId of extraAgents) {
    await kernel.addAgent({ agentId, llm: provider })
  }

  const gateway = await startGateway({
    transport: kernel.transport,
    bus: kernel.bus,
    // WS /stream 连接登记：run 实况（hub）与 PTY 会话流（shellService）并联；断连各自惰性清理
    onStreamSession: (session) => {
      kernel.streamHub.attach(session)
      kernel.shellService.attach(session)
    },
  })
  const replayed = await approvalGate.replayPending()
  kernel.startWatchdog()
  kernel.statsService.start() // Box 遥测 + 宿主磁盘压力轮询（Step 6）

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
      kernel.statsService.stop()
      kernel.stopWatchdog()
      await gateway.close()
    },
  }
}
