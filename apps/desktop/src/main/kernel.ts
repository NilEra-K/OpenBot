/**
 * 桌面装配（plan-p2 Step 6）：真内核进 Electron main——ARCHITECTURE.md §2 装配例外
 * （main 进程可 import coordinator/llm），renderer 业务面零内核 import（只走网关）。
 *
 * 职责：
 * - assembleKernel：NodeFs → userData/data、真实时钟、watchdog 定时驱动、ManualApprovalGate
 * - 环回网关（随机端口 + 一次性 token，经 ipc → preload → renderer 内存链路，不落盘）
 * - settings 命令面 + provider 热切换（key 密文经 safeStorage；系统加密不可用时 base64 降级并标前缀）
 * - 崩溃恢复：审批账本 pending 项重发 requested 事件（UI 重新弹窗）
 */
import { app, safeStorage } from 'electron'
import { z } from 'zod'
import { assembleKernel } from '@openbot/coordinator'
import type { AssembledKernel } from '@openbot/coordinator'
import { startGateway } from '@openbot/transport'
import type { GatewayHandle } from '@openbot/transport'
import { NodeFs, SettingsStore } from '@openbot/state'
import { LlmError, OpenAiCompatProvider } from '@openbot/llm'
import type { ChatProvider, ChatRequest, ChatResponse } from '@openbot/llm'
import { ManualApprovalGate } from '@openbot/runner'

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

export interface DesktopKernel {
  readonly kernel: AssembledKernel
  readonly gateway: GatewayHandle
  readonly settings: SettingsStore
  readonly provider: SwitchableChatProvider
  readonly approvalGate: ManualApprovalGate
  dispose(): Promise<void>
}

/** 装配桌面内核（app ready 后调用；safeStorage 依赖 ready 状态） */
export async function assembleDesktop(): Promise<DesktopKernel> {
  // NodeFs 路径约定 posix 风格（Windows 同样接受 '/'）
  const dataRoot = `${app.getPath('userData')}/data`.replaceAll('\\', '/')
  const fs = new NodeFs()
  const settings = new SettingsStore({ fs, root: dataRoot, encrypt: encryptKey, decrypt: decryptKey })
  const provider = new SwitchableChatProvider()

  let approvalGate!: ManualApprovalGate
  const kernel = assembleKernel({
    fs,
    root: dataRoot,
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
    .register('v1.settings.list', async () => settings.list())
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

  await applyProvider()
  await kernel.addAgent({ agentId: 'steward', name: '管家', llm: provider, steward: true })

  const gateway = await startGateway({ transport: kernel.transport, bus: kernel.bus })
  const replayed = await approvalGate.replayPending()
  kernel.startWatchdog()

  console.log(`[openbot] 内核就绪：网关 127.0.0.1:${gateway.port}；provider ${provider.configured ? '已配置' : '空缺（settings 配置后生效）'}；恢复审批 ${replayed} 条`)

  return {
    kernel,
    gateway,
    settings,
    provider,
    approvalGate,
    async dispose() {
      kernel.stopWatchdog()
      await gateway.close()
    },
  }
}
