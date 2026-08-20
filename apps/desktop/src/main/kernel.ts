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
import { stat } from 'node:fs/promises'
import { assembleKernel, chooseBackend } from '@openbot/coordinator'
import type { AssembledKernel, ChooseResult } from '@openbot/coordinator'
import { startGateway } from '@openbot/transport'
import type { GatewayHandle } from '@openbot/transport'
import { NodeFs, SettingsStore } from '@openbot/state'
import type { SandboxPreference } from '@openbot/state'
import { LlmError, OpenAiCompatProvider } from '@openbot/llm'
import type { ChatProvider, ChatRequest, ChatResponse } from '@openbot/llm'
import { ManualApprovalGate } from '@openbot/runner'
import { MockBoxBackend, WslBoxBackend, probeAll, runProcess } from '@openbot/boxes'
import type { BackendProbe, BoxBackend } from '@openbot/boxes'

// ---- provider 热切换：settings 变更后替换底层实现，steward 的引用不变 ----

export class SwitchableChatProvider implements ChatProvider {
  #current: ChatProvider | null = null

  swap(next: ChatProvider): void {
    this.#current = next
  }

  clear(): void {
    this.#current = null
  }

  get configured(): boolean {
    return this.#current !== null
  }

  async chat(request: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
    if (!this.#current) {
      // 稳定 code：UI 据此引导去 settings 配置 provider
      throw new LlmError('LLM_NO_PROVIDER', '尚未配置 LLM provider——请在设置视图配置后重试')
    }
    return this.#current.chat(request, signal)
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
})
const nameSchema = z.object({ name: z.string().min(1) })
const resolveSchema = z.object({
  nonce: z.string().min(1),
  decision: z.enum(['approved', 'denied']),
})
const sandboxPrefSchema = z.enum(['auto', 'mock', 'wsl', 'docker', 'podman'])
const sandboxSetSchema = z.object({ preference: sandboxPrefSchema })
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
  const probes = await probeAll(runProcess)
  const chosen = chooseBackend(preference, probes, {
    wslRootfs: rootfsReady,
    // docker/podman 属 Step 4（OCI 后端）：CLI 在也不选——诚实降级带原因
    implemented: ['mock', 'wsl'],
  })
  const backend: BoxBackend =
    chosen.backendId === 'wsl'
      ? new WslBoxBackend({ rootfs: rootfsPath, dir: `${userDataRoot}/boxes`, now: Date.now })
      : new MockBoxBackend({ now: Date.now })
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
  })

  /** settings 变更后热切换 provider（明文 key 只在本进程内存中存在） */
  const applyProvider = async (): Promise<void> => {
    try {
      const resolved = await settings.resolve()
      provider.swap(
        new OpenAiCompatProvider({
          config: {
            baseUrl: resolved.baseUrl,
            model: resolved.model,
            ...(resolved.apiKey ? { apiKey: resolved.apiKey } : {}),
            ...(resolved.headers ? { headers: resolved.headers } : {}),
            ...(resolved.proxyUrl ? { proxyUrl: resolved.proxyUrl } : {}),
            ...(resolved.temperature !== undefined ? { temperature: resolved.temperature } : {}),
            ...(resolved.timeoutMs !== undefined ? { timeoutMs: resolved.timeoutMs } : {}),
          },
        }),
      )
    } catch {
      provider.clear() // 无默认 provider / 解析失败 → 空缺态（chat 抛 LLM_NO_PROVIDER，UI 引导配置）
    }
  }

  // ---- 命令面扩展（壳装配职责：CLI/E2E 用 Auto 闸门时不需要这些命令） ----
  kernel.transport
    .register('v1.settings.list', async () => {
      // 展示清单（无 key 材料）+ 当前默认（renderer 空缺态判断）
      const providers = await settings.list()
      const current = await settings.load()
      return { providers, defaultProvider: current.defaultProvider ?? null }
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
    .register('v1.approval.resolve', async (payload) => {
      const { nonce, decision } = resolveSchema.parse(payload)
      return { approved: await approvalGate.resolve(nonce, decision) }
    }, resolveSchema)
    .register('v1.approval.pending', async () => approvalGate.pending())
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
    // WS /stream 连接登记进 hub（run 实况分发；断连由 hub 惰性清理）
    onStreamSession: (session) => kernel.streamHub.attach(session),
  })
  const replayed = await approvalGate.replayPending()
  kernel.startWatchdog()

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
      kernel.stopWatchdog()
      await gateway.close()
    },
  }
}
