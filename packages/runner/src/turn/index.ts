import { extractSession, sessionView } from './session-view.js'
/**
 * turn 执行引擎：调度器 execute 回调的实现——chat（用户消息）与 a2a（私聊唤醒）两种 run。
 * 工具循环：llm 回 toolCalls → 逐个执行 → 结果回喂 → 直到无命令（终答）或预算耗尽。
 * transcript 记领域消息（user/agent/a2a）与过程事实（thinking/exec——完成点聚合落盘，
 * 重启后对话流可恢复；不进 llm 历史）。参考：ARCHITECTURE.md §3.6/§7。
 */
import { KernelError } from '@openbot/core'
import type { ActiveRun, EventBus, RunExecutor } from '@openbot/core'
import type { TranscriptStore } from '@openbot/state'
import type { A2aRunPayload, GroupTurnPayload, UserChatRunPayload } from '@openbot/messaging'
import { GROUP_CONTEXT_CLEAR_MARKER, GROUP_PASS_TOKEN } from '@openbot/messaging'
import { LlmError } from '@openbot/llm'
import type { ChatMessage, ChatProvider, ContentPart, ToolSpec } from '@openbot/llm'
import type { RunStreamEvent } from '../stream/index.js'
import type { ToolContext, ToolRegistry } from '../tools/index.js'
import { MAX_THINKING_CHARS, truncateForTranscript } from '../tools/index.js'

export const RunnerErrorCodes = {
  RUN_KIND_UNKNOWN: 'RUN_KIND_UNKNOWN',
  /** 工具轮次预算耗尽（防失控循环） */
  RUN_TOOL_BUDGET_EXCEEDED: 'RUN_TOOL_BUDGET_EXCEEDED',
  /** llm 抛出非 LlmError 的未知错误 */
  LLM_FAILED: 'LLM_FAILED',
  /** run 已被外部中止（用户打断/抢占）——轮间检查点的快速终止 */
  RUN_ABORTED: 'RUN_ABORTED',
} as const

export const DEFAULT_MAX_TOOL_ROUNDS = 8

/** session 内组装窗口上限（「会话掌控」裁定 D）：最近 N 条领域消息——会话再长不无限累积 */
const SESSION_WINDOW_MESSAGES = 50
/** 附件总预算缺省（v0.1.113 双语修正）：128k 档 = 128×1000 token × 70% ≈ 89.6k 估算 token */
export const ATTACHMENT_BUDGET_128K = 89_600
/** 1M 档预算（模型勾选「1M」后）：1M×1000 × 70% = 700k 估算 token */
export const ATTACHMENT_BUDGET_1M = 700_000

/**
 * token 估算（v0.1.113 双语修正——2026-10-31 用户 400 报障根因修复）：max(字符×0.5, 字节×0.42)。
 * 中文由字节项主导（UTF-8 3 字节/字 → ≈1.26 token/字，贴主流中文 tokenizer ~1.5 的保守侧）；
 * 英文由字符项主导（≈0.5 token/字符，较真实 ~0.3 保守 1.7 倍）。
 * v0.1.111 曾按「2 字符/token」英文假设以字符数直做预算——中文密度高 3 倍被低估，
 * 1.4M 中文字符 ≈ 2M+ token 打爆 1M 窗口端点（HTTP 400 实锤）。
 */
const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length
const estTokens = (text: string): number => Math.max(text.length * 0.5, utf8Bytes(text) * 0.42)

/** 全文注入阈值（v0.1.113 层二）：单文件估算 ≤ 预算/4 才全量；超出转「头部预览 + 分块索引」
 *  ——「全文抱着」改「知道有什么、去哪拿」：任意窗口档位永不超窗，全文由 agent exec 分段读取 */
const PREVIEW_INVOKE_FACTOR = 4
const PREVIEW_HEAD_CHARS = 2000
const PREVIEW_CHUNK_CHARS = 4000
const PREVIEW_MAX_INDEX = 12

/**
 * 大文件预览块（v0.1.113 层二）：头部 + 行数 + 分块索引（每块首行摘样）+ exec 分段读取指引。
 * 模型「知道有什么、去哪拿」，全文按需分段读取——任意窗口档位永不超窗（工业方案同款哲学：
 * ChatGPT/Claude 客户端均不全文硬塞，按需取片段）。
 */
function previewBlock(name: string, path: string, size: number, full: string, est: number): string {
  const lines = full.split('\n').length
  const head = full.slice(0, PREVIEW_HEAD_CHARS)
  const totalChunks = Math.ceil(full.length / PREVIEW_CHUNK_CHARS)
  const index: string[] = []
  for (let i = 0; i < full.length && index.length < PREVIEW_MAX_INDEX; i += PREVIEW_CHUNK_CHARS) {
    const firstLine = (full.slice(i).match(/^.*$/m)?.[0] ?? '').slice(0, 40)
    index.push(`  块 ${index.length + 1}（字符 ${i + 1}-${Math.min(i + PREVIEW_CHUNK_CHARS, full.length)}）：${firstLine}`)
  }
  if (totalChunks > PREVIEW_MAX_INDEX) index.push(`  …（余 ${totalChunks - PREVIEW_MAX_INDEX} 块略——按块号 × ${PREVIEW_CHUNK_CHARS} 定位）`)
  return [
    `--- 附件 ${name}（${(size / 1024).toFixed(1)}KB · ${lines} 行 · 估算 ~${Math.max(1, Math.round(est / 1000))}k token——超出全文注入档，以下为预览）---`,
    head,
    head.length < full.length ? '…（预览截断）' : '',
    `[结构] 全文 ${full.length} 字符 / ${totalChunks} 块（每块 ${PREVIEW_CHUNK_CHARS} 字符）：`,
    ...index,
    `[取全文] 文件已存档：${path}`,
    `  用 exec 分段读取，如：sed -n '1,100p' "${path}"（按块号 × ${PREVIEW_CHUNK_CHARS} ÷ 平均行长换算行号，或 head -c 字节数）`,
    '--- 附件预览完 ---',
  ]
    .filter((line) => line !== '')
    .join('\n')
}

/** 引用会话注入预算（字符）：尾部优先 + 总量提示（记忆注入同哲学） */
const SESSION_REF_CHAR_BUDGET = 4000

export interface TurnRunnerDeps {
  bus: EventBus
  transcript: TranscriptStore
  /** 每 agent 的模型客户端（coordinator 装配时注入） */
  llmOf: (agentId: string) => ChatProvider
  tools: ToolRegistry
  /** 每 agent 绑定的 Box（null = 无沙箱，in-box 工具报 TOOL_NO_BOX） */
  boxOf: (agentId: string) => string | null
  nextMessageId: () => string
  systemPrompt?: string | ((agentId: string) => string)
  maxToolRounds?: number
  /**
   * 附件注入预算（v0.1.111 上下文档位）：模型声明 1M 档 → ~1.4M 字符；缺省 128k 档 → ~180k 字符
   *  （窗口k × 1000 token × 2 字符/token × 70% 余量留给历史/系统/作答）。缺省函数 = 128k 档。
   *  背景：v0.1.103 逐文件 200k 无总量——4 个大文件 ≈ 64 万字符打爆 128k 档端点（用户 400 报障实测）
   */
  attachmentBudgetOf?: (agentId: string) => number
  /**
   * 附件本体读取（v0.1.102 图片一期，装配注入——FsAdapter 只读 utf8 故走专用 dep）：
   * 用户消息图片附件 → ContentPart image（base64）；文本类附件附带 utf8 文本（二期——
   * runner 保持环境无关，解码归壳层）。null = 文件缺失/不可读——如实降级为文本注记
   * （不静默丢附件）。缺席 = 装配无文件系统（CLI/测试）——附件一律文本注记
   */
  loadAttachment?: (meta: { path: string; mime: string }) => Promise<{ base64: string; text?: string } | null>
  /**
   * 审批闸门（可选——2026-09-06 预算打穿问用户）：在场时工具轮预算打穿**不再自作主张终止**，
   * 经闸门发起「预算续期」授权请求（tool='tool_budget'，弹窗/自动批准按装配方实现）——
   * 批准=预算续期原地继续（上下文零损失）；拒绝=走收尾轮交代后结束。缺席时维持收尾轮直接结束。
   */
  gate?: import('../approval/index.js').ApprovalGate
  /**
   * run 实况上报（装配注入，接 WS /stream；不进事件总线）：
   * llm 轮次 open/chunk/end（onText 增量）；exec 流由工具层（BoxToolDeps.onStream）同型上报。
   */
  onStream?: (event: RunStreamEvent) => void
  /** 时钟（v0.1.113 顺序修复）：thinking 记录 startedAt 须与 transcript envelope at 同源
   *  （装配注入 assemble 的统一 now；测试 mock 时钟注入——真实 Date.now 与 mock at 量纲错位会乱序）。缺省 Date.now */
  now?: () => number
  /**
   * 每 agent 的视觉能力（P8-4 后 UI 优化，可选注入）：截图回喂分流——有视觉喂 image part，
   * 无视觉降级为文本说明（部分端点对 image part 会 400）。缺席 = 视为有视觉（向后兼容）。
   */
  supportsImagesOf?: (agentId: string) => boolean
  /**
   * 群轮转代际过期判定（P5 Step 4 修复，装配注入 = GroupService.isStale）：
   * supersede 后旧轮 turn 的终答写入前拦截——不落群流不发事件（静默丢弃）。
   * 缺席时（测试最小注入）不做拦截——写入与编排层代际判定（onSettled）双层防线。
   */
  isGroupTurnStale?: (payload: GroupTurnPayload) => boolean
  /**
   * agent 身份元信息（2026-10-18 身份修复，装配注入）：群轮 prompt 注入成员自称与
   * 同伴名单（只报名字）——成员不再自认管家。缺省时回落 agentId（行为向后兼容）。
   */
  agentMetaOf?: (agentId: string) => { name: string; persona?: string } | undefined
}

interface TurnInput {
  userMessage: ChatMessage
  originMessageId: string
  /**
   * 会话归属（P5 Step 3 群聊）：在场时历史与终答都走群流（transcript 键=groupId、
   * 终答 kind=group-agent、事件=v1.group.message）；缺席=默认 agent 私聊流。
   * 过程事实（thinking/exec）仍记 agentId——过程归 agent，消息归群。
   * stale（P5 Step 4）：终答写入前判定——true=旧轮被 supersede，静默丢弃。
   */
  session?: {
    groupId: string
    emitFinal: (messageId: string, text: string, runId: string) => void
    stale?: () => boolean
  }
}

export class TurnRunner {
  readonly #deps: TurnRunnerDeps

  constructor(deps: TurnRunnerDeps) {
    this.#deps = deps
  }

  /** 直接作为 AgentSchedulerOptions.execute 使用 */
  readonly execute: RunExecutor = async (run: ActiveRun) => {
    if (run.kind === 'chat') {
      const payload = run.payload as UserChatRunPayload
      return this.#runTurn(run, {
        userMessage: { role: 'user', content: await this.#userContent(run.agentId, payload) },
        originMessageId: payload.messageId,
      })
    }
    if (run.kind === 'a2a') {
      const payload = run.payload as A2aRunPayload
      const prefix = payload.isRedriven ? `[A2A ${payload.fromAgentId}·重驱]` : `[A2A ${payload.fromAgentId}]`
      return this.#runTurn(run, {
        userMessage: { role: 'user', content: `${prefix} ${payload.text}` },
        originMessageId: payload.messageId,
      })
    }
    // 群成员轮转（§3.6 GroupMemberRunner 语义）：历史=群流，终答写群流
    if (run.kind === 'group') {
      const payload = run.payload as GroupTurnPayload
      // 身份注入（2026-10-18 P1 修复：群聊成员自认管家）：自称 + 同伴名单（只报名字）；
      // 模式注入（P2 修复）：独立作答不注入「本轮已发言」——各抒己见互不可见
      const meta = this.#deps.agentMetaOf?.(run.agentId)
      const nameOfPeer = (id: string): string => this.#deps.agentMetaOf?.(id)?.name ?? id
      const identity =
        meta !== undefined
          ? `你是本群成员「${meta.name}」${meta.persona !== undefined && meta.persona !== '' ? `（${meta.persona}）` : ''}——不是管家，也不是其他成员，以「${meta.name}」自称。`
          : ''
      const peers = payload.memberIds !== undefined ? `本群成员：${payload.memberIds.map(nameOfPeer).join('、')}。` : ''
      const ctx = payload.context.length > 0 ? `本轮已发言：\n${payload.context.join('\n')}\n\n` : ''
      // 点名显示名（2026-10-19）：经 agentMetaOf 解析——成员读到的是同伴名字而非 agentId
      const mentioned =
        payload.mentioned.length > 0 ? `（点名：${payload.mentioned.map(nameOfPeer).join('、')}）` : ''
      const modeNote =
        payload.mode === 'independent'
          ? `（独立作答：本轮各成员分别独立作答、互不可见——给出你自己的观点，不要试图猜测或引用他人）`
          : payload.mode === 'summary'
            ? `（本轮汇总：你是汇总人——综合上方各成员的独立观点，给出收敛的结论：共识、分歧与建议；直接面向用户成文）`
            : payload.mode === 'debate' && payload.debate !== undefined
              ? payload.debate.phase === 'opening'
                ? `（辩论·${payload.debate.stance === 'pro' ? '正方' : '反方'}立场：本场辩论中你是${payload.debate.stance === 'pro' ? '正方' : '反方'}，对立${payload.debate.stance === 'pro' ? '反方' : '正方'}是 ${nameOfPeer(payload.debate.opponent)}——就话题亮明你方立场并给出论据，坚定为你方辩护，不要替对方让步）`
                : payload.debate.phase === 'rebuttal'
                  ? `（辩论·驳斥轮：针对「本轮已发言」中 ${nameOfPeer(payload.debate.opponent)} 的最新发言进行驳斥——指出薄弱点、正面回应质疑、强化你方立场；保持交锋礼节，不人身攻击）`
                  : `（辩论·中立汇总：你是本场辩论的汇总人——中立呈现双方立场、交锋中的关键分歧点与各自最有力的论据；不判胜负，把判断留给用户）`
              : `（群聊轮转：仅当你确实无话可说时才回复 ${'[pass]'}；用户要求每位成员回应或点名你时必须直接回应，不要因他人已发言而 ${'[pass]'}）`
      const toolNote = `回答前可先用工具查证或计算，再下结论。`
      return this.#runTurn(run, {
        userMessage: {
          role: 'user',
          content: `${identity}${peers}[群 ${payload.groupId} · 第${payload.round}轮]${mentioned} ${payload.text}\n${ctx}${modeNote}${toolNote}`,
        },
        originMessageId: payload.messageId,
        session: {
          groupId: payload.groupId,
          emitFinal: (messageId, text, runId) => {
            this.#deps.bus.emit('v1.group.message', {
              groupId: payload.groupId,
              messageId,
              kind: 'agent',
              from: run.agentId,
              text,
              runId,
            })
          },
          // 代际过期（supersede）终答静默丢弃——写入前判定（E2E 实测：编排层 onSettled
          // 拦不住先行的 transcript/事件写入——防线必须前移到写入点）
          stale: () => this.#deps.isGroupTurnStale?.(payload) === true,
        },
      })
    }
    throw new KernelError(RunnerErrorCodes.RUN_KIND_UNKNOWN, `未知 run 种类：${run.kind}`)
  }

  /**
   * 引用会话注入（「会话掌控」）：user 消息携带 sessionRef {agentId, sessionId} 时，把被引
   * 会话内容（sessionView 变换后的有效流 + 字符预算截断）注入为该消息文本前缀——用户显式
   * 引用（composer 引用按钮），所见即所引。注入发生在组装层（本轮上下文），transcript 原文
   * 不变（payload.sessionRef 留痕，重放组装自然复现）。
   */
  async #injectSessionRefs(
    viewerId: string,
    records: { kind: string; payload: unknown; at?: number }[],
  ): Promise<{ kind: string; payload: unknown; at?: number }[]> {
    let touched = false
    const out = await Promise.all(
      records.map(async (record) => {
        if (record.kind !== 'user' && record.kind !== 'group-user') return record
        const payload =
          typeof record.payload === 'object' && record.payload !== null ? (record.payload as Record<string, unknown>) : {}
        const ref = payload['sessionRef']
        if (typeof ref !== 'object' || ref === null) return record
        const refAgentId = (ref as Record<string, unknown>)['agentId']
        const refSessionId = (ref as Record<string, unknown>)['sessionId']
        if (typeof refAgentId !== 'string' || typeof refSessionId !== 'string') return record
        // 取被引 session 指定段（元事件变换后注入——tombstone/revision 语义在被引侧同样生效）
        const refView = sessionView(extractSession(await this.#deps.transcript.readAll(refAgentId), refSessionId))
        const lines: string[] = []
        for (const m of refView.records) {
          const p = typeof m.payload === 'object' && m.payload !== null ? (m.payload as Record<string, unknown>) : {}
          const text = typeof p['text'] === 'string' ? p['text'] : ''
          const who = m.kind === 'agent' || m.kind === 'group-agent' ? 'agent' : 'user'
          lines.push(`${who === 'agent' ? refAgentId : '用户'}：${text}`)
        }
        const full = lines.join('\n')
        const clipped = full.length > SESSION_REF_CHAR_BUDGET ? `${full.slice(full.length - SESSION_REF_CHAR_BUDGET)}\n（前文已截断，共 ${full.length} 字符）` : full
        const original = typeof payload['text'] === 'string' ? payload['text'] : ''
        const injected = `[@引用会话 ${refAgentId} · ${refSessionId}]\n${clipped}\n---\n${original}`
        touched = true
        return { ...record, payload: { ...payload, text: injected } }
      }),
    )
    void viewerId
    void touched
    return out
  }

  /**
   * 用户消息内容（v0.1.102 一期图片 + 二期文件类）：无附件 = 纯文本快路径（既有零变化）。
   * 分型注入：图片——模型有视觉=ImagePart、无视觉=不可读注记（与截图回喂降级同语义）；
   * 文本类（loadAttachment 附带 text）——≤200KB 全文代码块注入、超出截断加注记；
   * 其余——存档注记（路径+大小，agent 可用工具读取——宿主读恒过审批）。
   * 读取失败一律如实文本注记（不静默丢附件）。
   */
  async #userContent(agentId: string, payload: UserChatRunPayload): Promise<string | ContentPart[]> {
    const attachments = payload.attachments
    if (attachments === undefined || attachments.length === 0) return payload.text
    const vision = this.#deps.supportsImagesOf?.(agentId) ?? true
    // 总预算（v0.1.113 双语修正）：模型窗口档位 × 70%，单位 = 估算 token（estTokens——
    // 字符/字节双计，中文密度按字节项安全放大）；预算尽或单文件超全文档位 → 预览块
    let budget = this.#deps.attachmentBudgetOf?.(agentId) ?? ATTACHMENT_BUDGET_128K
    const parts: ContentPart[] = [{ type: 'text', text: payload.text !== '' ? payload.text : '（附件）' }]
    for (const att of attachments) {
      const loaded = (await this.#deps.loadAttachment?.({ path: att.path, mime: att.mime })) ?? null
      if (loaded === null) {
        parts.push({ type: 'text', text: `（附件 ${att.name} 读取失败——文件可能已被清理）` })
        continue
      }
      if (att.mime.startsWith('image/')) {
        if (vision) parts.push({ type: 'image', image: { base64: loaded.base64, mime: att.mime } })
        else parts.push({ type: 'text', text: `（图片附件 ${att.name}——当前模型无视觉能力，图像内容不可读）` })
        continue
      }
      if (loaded.text !== undefined) {
        const full = loaded.text
        const est = estTokens(full)
        // v0.1.113 层二：超全文档位（est > budget/4）或预算已尽 → 头部预览 + 分块索引 +
        // exec 分段读取指引（预览头部恒注入不扣预算——封顶 PREVIEW_HEAD_CHARS×附件数，量级可忽略）
        if (budget <= 0 || est > budget / PREVIEW_INVOKE_FACTOR) {
          parts.push({ type: 'text', text: previewBlock(att.name, att.path, att.size, full, est) })
          continue
        }
        budget -= est
        parts.push({ type: 'text', text: `--- 附件 ${att.name} ---\n${full}` })
        continue
      }
      parts.push({
        type: 'text',
        text: `（附件 ${att.name}，${(att.size / 1024).toFixed(1)}KB，已存档：${att.path}——非文本类型未注入内容，可用工具读取）`,
      })
    }
    return parts
  }

  async #runTurn(run: ActiveRun, input: TurnInput): Promise<{ text: string }> {
    const { agentId } = run
    // 入站消息在受理时已落 transcript（durable acceptance）；组装历史时剔除，避免同消息双计。
    // 会话键：群 turn 读群流（群历史），私聊 turn 读 agent 流。
    // 「会话掌控」（sessionView）：元事件解释器——session-start/resume 窗口、revision 替换与
    // 截断、tombstone/revive；再叠 session 内窗口上限（最近 SESSION_WINDOW 条——会话再长
    // 也不无限累积，长对话 token 纪律）
    const sessionKey = input.session?.groupId ?? agentId
    let records = (await this.#deps.transcript.readAll(sessionKey)).filter(
      (record) => messageIdOf(record.payload) !== input.originMessageId,
    )
    if (input.session) {
      // 群上下文清空点（2026-10-15 /clear 群语义）：最后清空点之后的记录才进历史——成员
      // 忘记清空前的轮次（transcript append-only 留证；对齐私聊 sessionView 会话边界语义）
      let clearIdx = -1
      for (let i = records.length - 1; i >= 0; i -= 1) {
        if ((records[i]!.payload as { marker?: unknown }).marker === GROUP_CONTEXT_CLEAR_MARKER) {
          clearIdx = i
          break
        }
      }
      if (clearIdx >= 0) records = records.slice(clearIdx + 1)
    }
    const view = sessionView(records)
    const effective = view.records.slice(-SESSION_WINDOW_MESSAGES)
    const history = toChatMessages(
      await this.#injectSessionRefs(agentId, effective),
      agentId,
    )
    const messages: ChatMessage[] = []
    const system = typeof this.#deps.systemPrompt === 'function' ? this.#deps.systemPrompt(agentId) : this.#deps.systemPrompt
    if (system) messages.push({ role: 'system', content: system })
    messages.push(...history, input.userMessage)

    const maxRounds = this.#deps.maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS
    const emitStream = this.#deps.onStream
    const emit = (event: Omit<RunStreamEvent, 'agentId' | 'runId'>): void => {
      emitStream?.({ ...event, agentId, runId: run.runId })
    }
    let round = 0 // 工具轮计数（预算判据，语义不变）
    let roundsBudget = maxRounds // 可续期预算（2026-09-06：打穿先问用户，批准=续期原地继续）
    let budgetRenewals = 0
    let chatRound = 0 // chat 序号（llm 流事件标注，含终答轮）
    for (;;) {
      // 轮间中止检查点：工具已返回但 run 已被取消/抢占时立即终止——不再发起下一轮 llm
      // （exec 由后端 signal 杀进程；此检查点兜住审批等不感知 signal 的等待返回后的收尾）
      if (run.signal.aborted) {
        throw new KernelError(RunnerErrorCodes.RUN_ABORTED, `run 已中止（run ${run.runId}）`)
      }
      // llm 流：open（轮次序号）→ onText/onThinking 双通道增量 chunk → end/abort（聚合终态在返回值）
      chatRound += 1
      const roundStartedAt = this.#deps.now?.() ?? Date.now() // 轮开始时刻（v0.1.113 顺序修复）：thinking 记录落盘在轮末，
      // 其 envelope at 失真（晚于轮内 exec）——重启回放排序会把思考挤到工具后；startedAt 供投影还原真实序。
      // 须用与 transcript 同源时钟（deps.now——装配统一注入；真实 Date.now 会与 mock 测试时钟量纲错位）
      emit({ type: 'open', stream: 'llm', meta: { round: chatRound } })
      let response: Awaited<ReturnType<ChatProvider['chat']>>
      let thinkingText = '' // 本轮思考聚合（v0.1.48：真思考持久化——落 transcript thinking 记录）
      try {
        response = await this.#chat(
          agentId,
          messages,
          run.signal,
          emitStream
            ? (delta) => emit({ type: 'chunk', stream: 'llm', text: delta })
            : undefined,
          undefined,
          (delta) => {
            thinkingText += delta // 无 emitStream 也聚合（持久化不依赖实况开关）
            if (emitStream) emit({ type: 'chunk', stream: 'llm', text: delta, think: true })
          },
        )
        emit({ type: 'end', stream: 'llm' })
      } catch (err) {
        emit({ type: 'abort', stream: 'llm', reason: err instanceof Error ? err.message : String(err) })
        throw err
      }
      // 过程事实：本轮思考落 transcript（v0.1.48 修正：存**真思考聚合**——onThinking 通道；
      // 此前存终答文本是双通道前的旧语义，重启后"思考没了"的根因。终答文本的家在 agent 消息，
      // 不再重复进 thinking；无思考的轮次记空串留过程痕迹（恢复投影跳过）。
      // 落盘键 = sessionKey（群轮落群流——群轮的消息与过程同归群，成员私聊档案零群痕迹；
      // 私聊轮不变落 agentId）
      await this.#deps.transcript.append(sessionKey, 'thinking', {
        runId: run.runId,
        round: chatRound,
        startedAt: roundStartedAt,
        text: truncateForTranscript(thinkingText, MAX_THINKING_CHARS),
        final: response.toolCalls.length === 0,
      })
      if (response.toolCalls.length === 0) {
        const text = response.text ?? ''
        // 群轮转 [pass]：标准静默 token——不落群流不发事件（GroupService settle 判定缺席）
        if (input.session && text.trim() === GROUP_PASS_TOKEN) {
          return { text }
        }
        const messageId = this.#deps.nextMessageId()
        if (input.session) {
          // supersede（P5 Step 4 修复）：旧轮终答静默丢弃——不写群 transcript 不发事件
          // （turn 本身正常 finish；编排层 onSettled 同判兜底）
          if (input.session.stale?.()) return { text }
          // 群终答：写群流（kind=group-agent，成员身份在 from 字段）+ v1.group.message；
          // agent 私聊流零污染（群里说的话不出现在 1:1 会话）
          await this.#deps.transcript.append(input.session.groupId, 'group-agent', {
            messageId,
            from: agentId,
            text,
            replyTo: input.originMessageId,
            runId: run.runId,
          })
          input.session.emitFinal(messageId, text, run.runId)
        } else {
          await this.#deps.transcript.append(agentId, 'agent', {
            messageId,
            text,
            replyTo: input.originMessageId,
            runId: run.runId,
          })
          this.#deps.bus.emit('v1.message.agent', { messageId, agentId, text, runId: run.runId })
        }
        return { text }
      }
      round += 1
      if (round > roundsBudget) {
        // 预算打穿：**先问用户**（2026-09-06 用户质疑「为什么不问问用户而是自作主张」）——
        // 复用审批闸门发起「预算续期」授权（弹窗按装配方：desktop 手动/CLI 自动批准）。
        // 批准 = 预算续期原地继续（上下文零损失）；拒绝 = 走收尾轮交代后结束。
        // 无 gate（极简装配）退化为直接收尾轮。等待期间 run 信号中止 → 收尾轮 chat 自然抛中止
        if (this.#deps.gate !== undefined && !run.signal.aborted) {
          budgetRenewals += 1
          const approved = await this.#deps.gate.request({
            runId: run.runId,
            agentId,
            tool: 'tool_budget',
            reason:
              `工具轮次已达上限 ${maxRounds}${budgetRenewals > 1 ? `（本次是第 ${budgetRenewals} 次续期）` : ''}，` +
              `任务尚未完成。批准=继续执行（再给 ${maxRounds} 轮）；拒绝=结束并由 Agent 交代进展`,
            nonce: `${input.originMessageId}:${run.runId}:budget-${budgetRenewals}`,
          })
          if (approved) {
            roundsBudget += maxRounds // 续期：再给一轮额度（当前轮计入新窗口）
          } else {
            await this.#wrapupAndThrow(agentId, input, run, messages, chatRound, maxRounds, emit)
          }
        } else {
          await this.#wrapupAndThrow(agentId, input, run, messages, chatRound, maxRounds, emit)
        }
      }
      messages.push({ role: 'assistant', content: response.text ?? '', toolCalls: response.toolCalls })
      const boxId = this.#deps.boxOf(agentId)
      for (const call of response.toolCalls) {
        const ctx: ToolContext = {
          agentId,
          runId: run.runId,
          originMessageId: input.originMessageId,
          toolCallId: call.id,
          boxId,
          signal: run.signal,
          // 群轮过程落群流（exec 记录落盘键——见 ToolContext.sessionKey）
          ...(input.session ? { sessionKey: input.session.groupId } : {}),
        }
        const result = await this.#deps.tools.execute(ctx, call)
        // 含图回喂（plan-computer-use Step 3）+ 视觉分流（P8-4 后 UI 优化，用户裁定）：
        // GUI 工具注册只看环境（工具集探测）；模型无视觉时截图降级为文本说明——
        // 不喂 image part（部分端点对 image part 会 400），图像仍进 ToolRegistry.lastImageOf
        // （GUI 视图旁观帧源不受影响）。纯文本结果零变化（string 快路径）
        const image = typeof result === 'string' ? undefined : result.image
        const vision = this.#deps.supportsImagesOf?.(agentId) ?? true
        let toolText = typeof result === 'string' ? result : result.text
        if (image !== undefined && !vision) {
          toolText += '（截图已拍摄——当前模型无视觉能力，图像内容不可读；可在 GUI 视图查看画面。）'
        }
        const imagePart = image !== undefined && vision ? image : undefined
        messages.push({
          role: 'tool',
          content:
            imagePart === undefined
              ? toolText
              : [
                  { type: 'text' as const, text: toolText },
                  { type: 'image' as const, image: imagePart },
                ],
          toolCallId: call.id,
        })
      }
      if (round === maxRounds) {
        // 预算预警（软着陆）：这是最后可用轮的工具结果——附提示引导模型下一轮收尾总结，
        // 而不是被硬掐断。user 角色进 messages（system 中段插入 anthropic 不接受）；
        // 位置在 assistant/toolCalls 与 tool 结果之后——协议序不破坏
        messages.push({
          role: 'user',
          content: `（系统提示：工具预算已用到最后 1 轮。下一步请只做最必要的一个操作，或直接向用户总结进展与未尽事项。）`,
        })
      }
    }
  }

  /** 预算打穿的收尾轮：注入收尾指令、**禁用工具**（tools=[] 进 wire——物理上无法继续调）
   *  做最后一次 LLM 调用，模型向用户交代「做了什么/卡在哪/如何继续」，终答照常投递；
   *  然后按 RUN_TOOL_BUDGET_EXCEEDED 结算（诚实：任务未完成）。收尾轮自身失败（如网络断）
   *  按原预算错误语义抛出 */
  async #wrapupAndThrow(
    agentId: string,
    input: TurnInput,
    run: ActiveRun,
    messages: ChatMessage[],
    chatRound: number,
    maxRounds: number,
    emit: (event: Omit<RunStreamEvent, 'agentId' | 'runId'>) => void,
  ): Promise<never> {
    const nextChatRound = chatRound + 1
    messages.push({
      role: 'user',
      content:
        `（系统提示：工具调用预算 ${maxRounds} 轮已用完，用户选择结束任务，不能再执行任何工具。` +
        `请用一小段话向用户交代：已完成了什么、卡在哪里、建议用户如何继续。不要说抱歉套话，直接说事实。）`,
    })
    emit({ type: 'open', stream: 'llm', meta: { round: nextChatRound } })
    let wrapupText: string
    let wrapupThinking = '' // 收尾轮思考聚合（v0.1.48 同主轮；try 外声明供落盘）
    try {
      const wrapup = await this.#chat(
        agentId,
        messages,
        run.signal,
        (delta) => emit({ type: 'chunk', stream: 'llm', text: delta }),
        [],
        (delta) => {
          wrapupThinking += delta
          emit({ type: 'chunk', stream: 'llm', text: delta, think: true })
        },
      )
      wrapupText = wrapup.text ?? ''
      emit({ type: 'end', stream: 'llm' })
    } catch (err) {
      emit({ type: 'abort', stream: 'llm', reason: err instanceof Error ? err.message : String(err) })
      throw err
    }
    // 落盘键 = sessionKey（与主轮同语义：群轮过程落群流，私聊轮落 agentId）
    const sessionKey = input.session?.groupId ?? agentId
    await this.#deps.transcript.append(sessionKey, 'thinking', {
      runId: run.runId,
      round: nextChatRound,
      text: truncateForTranscript(wrapupThinking, MAX_THINKING_CHARS),
      final: false,
    })
    await this.#deliverFinal(agentId, input, run, wrapupText)
    throw new KernelError(
      RunnerErrorCodes.RUN_TOOL_BUDGET_EXCEEDED,
      `工具轮次超过预算 ${maxRounds}（run ${run.runId}）——已向用户交代进展`,
    )
  }

  /** 边界转换：LlmError → 同 code 的 KernelError；未知异常归类 LLM_FAILED。
   *  toolSpecs 可选覆盖（缺省全量注册工具；预算收尾轮传 [] ——禁用工具强制文本总结） */
  async #chat(
    agentId: string,
    messages: ChatMessage[],
    signal: AbortSignal,
    onText?: (delta: string) => void,
    toolSpecs?: ToolSpec[],
    onThinking?: (delta: string) => void,
  ) {
    try {
      return await this.#deps.llmOf(agentId).chat(
        {
          messages,
          tools: toolSpecs ?? this.#deps.tools.specs(),
          ...(onText ? { onText } : {}),
          ...(onThinking ? { onThinking } : {}),
        },
        signal,
      )
    } catch (err) {
      if (err instanceof KernelError) throw err
      if (err instanceof LlmError) throw new KernelError(err.code, err.message)
      throw new KernelError(RunnerErrorCodes.LLM_FAILED, err instanceof Error ? err.message : String(err))
    }
  }

  /** 终答投递（正常终轮与预算收尾轮共用）：transcript 落档 + 事件出（群/私聊分流同构） */
  async #deliverFinal(agentId: string, input: TurnInput, run: { runId: string }, text: string): Promise<void> {
    const messageId = this.#deps.nextMessageId()
    if (input.session) {
      // supersede：旧轮终答静默丢弃（收尾轮同判——旧轮不该在被打断后还往群流说话）
      if (input.session.stale?.()) return
      await this.#deps.transcript.append(input.session.groupId, 'group-agent', {
        messageId,
        from: agentId,
        text,
        replyTo: input.originMessageId,
        runId: run.runId,
      })
      input.session.emitFinal(messageId, text, run.runId)
    } else {
      await this.#deps.transcript.append(agentId, 'agent', {
        messageId,
        text,
        replyTo: input.originMessageId,
        runId: run.runId,
      })
      this.#deps.bus.emit('v1.message.agent', { messageId, agentId, text, runId: run.runId })
    }
  }
}

/** 取 transcript 记录携带的消息 id（无则 null） */
function messageIdOf(payload: unknown): string | null {
  if (typeof payload === 'object' && payload !== null) {
    const id = (payload as Record<string, unknown>)['messageId']
    if (typeof id === 'string') return id
  }
  return null
}

/** transcript 记录 → 会话历史（只映射领域消息；工具往返不入历史）。
 *  viewerId（P5 Step 3）：群流映射的视角成员——自己发言=assistant、他人发言=user 带前缀；私聊流不依赖 */
export function toChatMessages(records: { kind: string; payload: unknown }[], viewerId?: string): ChatMessage[] {  const messages: ChatMessage[] = []
  for (const record of records) {
    const payload = typeof record.payload === 'object' && record.payload !== null ? (record.payload as Record<string, unknown>) : {}
    const text = typeof payload['text'] === 'string' ? payload['text'] : ''
    if (record.kind === 'user') {
      // 附件历史回放（v0.1.102）：历史轮不重读图片本体（token 纪律 + 反复读盘）——文本注记在册
      const atts = payload['attachments']
      const attNote =
        Array.isArray(atts) && atts.length > 0
          ? `（附件：${atts.map((a) => (typeof (a as { name?: unknown })?.name === 'string' ? (a as { name: string }).name : '?')).join('、')}）`
          : ''
      messages.push({ role: 'user', content: attNote !== '' && text !== '' ? `${text}\n${attNote}` : text + attNote })
    } else if (record.kind === 'agent') {
      messages.push({ role: 'assistant', content: text })
    } else if (record.kind === 'a2a-in') {
      const from = typeof payload['from'] === 'string' ? payload['from'] : '?'
      messages.push({ role: 'user', content: `[A2A ${from}] ${text}` })
    } else if (record.kind === 'a2a-out') {
      const to = typeof payload['to'] === 'string' ? payload['to'] : '?'
      messages.push({ role: 'assistant', content: `[A2A → ${to}] ${text}` })
    } else if (record.kind === 'group-user') {
      messages.push({ role: 'user', content: text })
    } else if (record.kind === 'group-agent') {
      const from = typeof payload['from'] === 'string' ? payload['from'] : '?'
      if (viewerId !== undefined && from === viewerId) {
        messages.push({ role: 'assistant', content: text })
      } else {
        messages.push({ role: 'user', content: `[群 ${from}] ${text}` })
      }
    }
    // group-sys：系统注记不入 llm 历史
  }
  return messages
}
