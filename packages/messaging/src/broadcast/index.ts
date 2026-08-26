/**
 * 广播：→全员/子集单向扇出（发起方仅用户与 steward——§3.5 扇出权限制，worker 不能扇出）。
 * 扇出是内核调度语义（plan-p5 裁定 C 的落地）：一次命令原子受理（先全量校验后投递）、
 * 统一幂等键（整体重试只回放不双发）、顺序入队（逐成员 user/agent lane）、并发执行
 * （各成员调度器独立）、无环（接收侧进普通 turn，回复走 A2A 单发——广播不再触发扇出）。
 * 零新事件族：投递复用 a2a 服务的既有受理管线（事件/transcript 镜像/lane 入队语义同源），
 * 子 nonce `${nonce}#${i}` 各自幂等——已受理条目重试 first=false 回放。
 * 参考：ARCHITECTURE.md §3.5 —— P5 实现（plan-p5 Step 1）。
 */
import { KernelError } from '@openbot/core'
import type { A2aService, MessageAcceptance } from '../a2a/index.js'

export const BroadcastErrorCodes = {
  /** 扇出权限制：广播只能由用户或在位 steward 发起（§3.5） */
  MSG_BROADCAST_FORBIDDEN: 'MSG_BROADCAST_FORBIDDEN',
  /** 广播收件列表为空（去重与发起者排除后） */
  MSG_BROADCAST_EMPTY: 'MSG_BROADCAST_EMPTY',
} as const

export interface BroadcastInput {
  /** 发起方：'user' 或 agentId（agentId 须为在位 steward） */
  from: string
  toAgentIds: string[]
  text: string
  nonce: string
}

/** 扇出受理回执：逐成员受理结果（重试回放首次值，first=任一成员首次受理） */
export interface BroadcastAcceptance {
  recipients: Array<{ agentId: string } & MessageAcceptance>
  first: boolean
}

export interface BroadcastDeps {
  /** 单发管线（受理/镜像/事件/入队语义复用；只依赖两个受理方法） */
  a2a: Pick<A2aService, 'sendUserMessage' | 'sendA2a'>
  /** 扇出权判定（发起方为 agent 时须为在位 steward；'user' 恒放行） */
  isSteward: (agentId: string) => Promise<boolean>
  /** 收件人前置校验（名册在位——未注册 agent 抛稳定码；先全量校验后投递） */
  assertAgent: (agentId: string) => void
}

export class BroadcastService {
  readonly #deps: BroadcastDeps

  constructor(deps: BroadcastDeps) {
    this.#deps = deps
  }

  /**
   * 扇出受理：校验（扇出权 → 全量收件人在位）→ 去重与发起者自排除 → 顺序逐成员投递。
   * @全员与 @多提及同一命令——UI 只构造 toAgentIds（全员=名册全量、多提及=提及者列表），
   * 「UI 层循环发送」的假广播防线写在协议层。
   */
  async broadcast(input: BroadcastInput): Promise<BroadcastAcceptance> {
    if (input.from !== 'user' && !(await this.#deps.isSteward(input.from))) {
      throw new KernelError(
        BroadcastErrorCodes.MSG_BROADCAST_FORBIDDEN,
        `广播只能由用户或管家发起（worker 不能扇出）：${input.from}`,
      )
    }
    // 去重 + 发起者自排除（@全员列表自然含全员；给自己扇出无意义且自环——无环纪律第一道）
    const recipients = [...new Set(input.toAgentIds)].filter((id) => id !== input.from)
    if (recipients.length === 0) {
      throw new KernelError(BroadcastErrorCodes.MSG_BROADCAST_EMPTY, '广播收件列表为空（去重与发起者排除后）')
    }
    // 先全量校验后投递（原子性边界：未注册成员在投递开始前拒绝——零事件零 run，不留半途扇出）
    for (const agentId of recipients) this.#deps.assertAgent(agentId)
    // 顺序受理：lane 语义随发起方（user→每成员一条定向消息；steward→A2A 扇出）；
    // 各成员调度器独立并发执行。整体幂等：子 nonce 已受理条目重试回放，不双发
    let first = false
    const results: BroadcastAcceptance['recipients'] = []
    for (const [i, agentId] of recipients.entries()) {
      const nonce = `${input.nonce}#${i}`
      const acceptance =
        input.from === 'user'
          ? await this.#deps.a2a.sendUserMessage({ toAgentId: agentId, text: input.text, nonce })
          : await this.#deps.a2a.sendA2a({ fromAgentId: input.from, toAgentId: agentId, text: input.text, nonce })
      if (acceptance.first) first = true
      results.push({ agentId, ...acceptance })
    }
    return { recipients: results, first }
  }
}
