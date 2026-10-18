/**
 * 群聊编排（P5 Step 3，§3.5 有界轮转）：leaderless——steward 群内普通成员，无特权路径。
 * 用户消息触发轮转：成员依序响应（等前一个 settle 再入下一个——顺序保证上下文传递），
 * @提及成员优先发言；LLM 无话可说回复 [pass]（全员 pass 记 sysnote 收敛）；
 * 用户消息 supersede：新消息 bump 代际（gen）——旧轮成员 settle 后按代际静默丢弃，不写不继续；
 * 消息上限防失控（transcript 长度判据——天然持久）。
 * 群档案持久化 groups.json（重启恢复清单；轮转态内存——重启后空闲，如实）。
 * 群 transcript = groupId 键空间（group-user / group-agent / group-sys 新 kind，读取端兼容）。
 * 成员 turn 执行在 runner（run.kind 'group' 分支——§3.6 GroupMemberRunner 语义），
 * 终答经 RunOutcome.result 携带 { text } 回到本编排做 pass 判定。
 * 参考：ARCHITECTURE.md §3.5 —— P5 实现（plan-p5 Step 3）。
 */
import { KernelError } from '@openbot/core'
import type { AgentScheduler, RunOutcome } from '@openbot/core'
import { digestOf } from '@openbot/state'
import type { FsAdapter, IdempotencyLedger, TranscriptStore } from '@openbot/state'
import { summarizeRun } from '../a2a/index.js'

export const GroupErrorCodes = {
  /** 群不存在 */
  GROUP_NOT_FOUND: 'GROUP_NOT_FOUND',
  /** 成员不在群内（建群校验） */
  GROUP_NOT_MEMBER: 'GROUP_NOT_MEMBER',
  /** 群消息上限（防失控） */
  GROUP_LIMIT: 'GROUP_LIMIT',
} as const

/** 群消息上限（含 sysnote——transcript 记录数判据，天然持久） */
export const MAX_GROUP_RECORDS = 200

/** [pass] 约定：群成员轮转中无话可说的标准回复（turn prompt 告知） */
export const GROUP_PASS_TOKEN = '[pass]'

/** 群上下文清空点（2026-10-15 /clear 群语义）：group-sys payload.marker——runner 历史注入与
 *  renderer 呈现恢复按最后清空点切窗口（transcript append-only 留证，上下文真清空）。
 *  renderer 侧有同源字面量（stores/kernel.ts——不直依赖内核包，改此处须同步） */
export const GROUP_CONTEXT_CLEAR_MARKER = 'context-clear'

/** 群成员 turn 负载（runner 解释执行；群上下文随轮转推进动态构造） */
export interface GroupTurnPayload {
  messageId: string
  groupId: string
  /** 轮次代际（supersede 判定——settle 时不匹配即丢弃） */
  gen: number
  round: number
  /** 触发本轮的用户消息 */
  text: string
  /** 本轮已发言（`名字：内容` 顺序列表——上下文传递；独立作答模式恒空） */
  context: string[]
  /** 本轮被 @ 的成员（prompt 可见——优先发言已由编排保证） */
  mentioned: string[]
  /** 发言模式（2026-10-18）：independent=独立作答（全员并发、互不可见）；缺省 rotation 轮转 */
  mode?: 'independent'
  /** 全体成员 id（身份注入用——runner 经 agentMetaOf 解析为名字） */
  memberIds?: string[]
}

/** 独立作答模式触发前缀（2026-10-18 用户裁定：语法触发、可扩展的模式注册面） */
export const GROUP_INDEPENDENT_PREFIX = /^#(讨论|独立)\s+/

export interface GroupRecord {
  groupId: string
  name: string
  members: string[]
  createdAt: number
}

/** 轮转态（内存——重启后空闲；代际是 supersede 的唯一判据） */
interface GroupRuntime {
  gen: number
  round: number
  /** 本轮已发言成员（结构化——id 判定与上下文构造分离，防 agentId 前缀互撞） */
  spoken: Array<{ id: string; text: string }>
  passed: string[]
  running: boolean
  turnText: string
  turnMessageId: string
  mentioned: string[]
  /** 发言模式（2026-10-18）：本轮 independent（独立作答）或缺省 rotation（轮转） */
  independent?: boolean
}

export interface GroupDeps {
  bus: import('@openbot/core').EventBus
  now: () => number
  nextMessageId: () => string
  transcript: TranscriptStore
  ledger: IdempotencyLedger
  fs: FsAdapter
  root: string
  schedulerOf: (agentId: string) => AgentScheduler
}

export class GroupService {
  readonly #deps: GroupDeps
  readonly #groups = new Map<string, GroupRecord>()
  readonly #runtime = new Map<string, GroupRuntime>()
  #counter = 0

  constructor(deps: GroupDeps) {
    this.#deps = deps
  }

  /** 启动恢复：读 groups.json（缺席=空清单；轮转态不恢复——重启后空闲） */
  async load(): Promise<void> {
    const raw = await this.#deps.fs.read(`${this.#deps.root}/groups.json`)
    if (!raw) return
    try {
      const list = JSON.parse(raw) as GroupRecord[]
      for (const g of list) this.#groups.set(g.groupId, g)
      const maxNum = Math.max(
        0,
        ...[...this.#groups.keys()].map((id) => Number.parseInt(id.split('-').pop() ?? '0', 10) || 0),
      )
      this.#counter = maxNum
    } catch {
      // 损坏档案如实空载（transcript 仍在——消息历史不丢，群清单需重建）
    }
  }

  #persist(): Promise<void> {
    const list = [...this.#groups.values()]
    return this.#deps.fs.write(`${this.#deps.root}/groups.json`, JSON.stringify(list, null, 2))
  }

  async list(): Promise<GroupRecord[]> {
    return [...this.#groups.values()].map((g) => ({ ...g, members: [...g.members] }))
  }

  /** 建群：成员全量校验（在位性）+ sysnote 落群流；发 v1.group.state（renderer 拉清单信号） */
  async createGroup(input: { name: string; memberAgentIds: string[] }): Promise<GroupRecord> {
    if (input.memberAgentIds.length === 0) {
      throw new KernelError(GroupErrorCodes.GROUP_NOT_MEMBER, '群成员列表为空')
    }
    for (const id of new Set(input.memberAgentIds)) {
      this.#deps.schedulerOf(id) // 未注册 agent 抛 STATE_AGENT_NOT_FOUND
    }
    const groupId = `group-${++this.#counter}`
    const record: GroupRecord = {
      groupId,
      name: input.name,
      members: [...new Set(input.memberAgentIds)],
      createdAt: this.#deps.now(),
    }
    this.#groups.set(groupId, record)
    await this.#persist()
    await this.#sys(groupId, `群「${record.name}」建立，成员：${record.members.join('、')}`)
    this.#deps.bus.emit('v1.group.state', { groupId, name: record.name, cause: 'created' })
    return { ...record, members: [...record.members] }
  }

  /** 用户群消息：幂等受理 → supersede 开新轮 → 成员依序轮转 */
  async sendUserMessage(input: { groupId: string; text: string; nonce: string }): Promise<{ messageId: string; runIds: string[] }> {
    const group = this.#groups.get(input.groupId)
    if (!group) throw new KernelError(GroupErrorCodes.GROUP_NOT_FOUND, `群不存在：${input.groupId}`)
    const digest = digestOf({ groupId: input.groupId, text: input.text })
    const begin = await this.#deps.ledger.begin(`group:${input.nonce}`, digest)
    if (!begin.first) {
      const stored = begin.entry.outcome as { messageId: string } | undefined
      return stored ? { messageId: stored.messageId, runIds: [] } : { messageId: '', runIds: [] }
    }
    const records = await this.#deps.transcript.readAll(input.groupId)
    if (records.length >= MAX_GROUP_RECORDS) {
      throw new KernelError(GroupErrorCodes.GROUP_LIMIT, `群消息超过上限 ${MAX_GROUP_RECORDS}（${input.groupId}）`)
    }
    // 发言模式（2026-10-18 用户裁定：讨论性话题各抒己见）：`#讨论 `/`#独立 ` 前缀触发独立
    // 作答——前缀剥离，group-user 记录与事件留 mode 痕（渲染层徽标）
    const prefixMatch = input.text.match(GROUP_INDEPENDENT_PREFIX)
    const independent = prefixMatch !== null
    const text = independent ? input.text.slice(prefixMatch[0].length) : input.text
    const messageId = this.#deps.nextMessageId()
    await this.#deps.transcript.append(input.groupId, 'group-user', {
      messageId,
      from: 'user',
      text,
      ...(independent ? { mode: 'independent' as const } : {}),
      at: this.#deps.now(),
    })
    this.#deps.bus.emit('v1.group.message', {
      groupId: input.groupId,
      messageId,
      kind: 'user',
      from: 'user',
      text,
      ...(independent ? { mode: 'independent' as const } : {}),
    })
    await this.#deps.ledger.commit(`group:${input.nonce}`, { messageId })
    // supersede：代际 bump——旧轮成员 settle 后静默丢弃；新轮从提及成员开始依序轮转
    const rt = this.#runtimeOf(input.groupId)
    if (rt.running) await this.#sys(input.groupId, '用户插话，本轮重新开始（supersede）')
    rt.gen += 1
    rt.round += 1
    rt.spoken = []
    rt.passed = []
    rt.turnText = text
    rt.turnMessageId = messageId
    rt.mentioned = this.#mentionedOf(text, group)
    rt.independent = independent
    rt.running = group.members.length > 0
    const runIds = this.#advance(group, rt)
    return { messageId, runIds }
  }

  /** 群上下文清空（2026-10-15 用户报障 /clear 群语义错位）：群流追加清空点 sys（append-only
   *  留证不动历史）+ 在途轮作废（同 supersede 语义）；成员历史注入按最后清空点过滤（runner 侧） */
  async clearContext(input: { groupId: string }): Promise<{ messageId: string }> {
    const group = this.#groups.get(input.groupId)
    if (!group) throw new KernelError(GroupErrorCodes.GROUP_NOT_FOUND, `群不存在：${input.groupId}`)
    const messageId = this.#deps.nextMessageId()
    await this.#deps.transcript.append(input.groupId, 'group-sys', {
      messageId,
      from: 'system',
      text: '上下文已清空（/clear）——成员不再记得之前的群聊',
      marker: GROUP_CONTEXT_CLEAR_MARKER,
      at: this.#deps.now(),
    })
    this.#deps.bus.emit('v1.group.message', {
      groupId: input.groupId,
      messageId,
      kind: 'sys',
      from: 'system',
      text: '上下文已清空（/clear）——成员不再记得之前的群聊',
    })
    this.#deps.bus.emit('v1.group.cleared', { groupId: input.groupId })
    const rt = this.#runtimeOf(input.groupId)
    rt.gen += 1 // 在途轮作废（旧轮终答按代际静默丢弃——同 sendUserMessage 的 supersede 语义）
    rt.spoken = []
    rt.passed = []
    rt.running = false
    return { messageId }
  }

  /** 文本中被 @ 的群成员（一期命中面 = @agentId——显示名匹配需名册事实注入，记档后续） */
  #mentionedOf(text: string, group: GroupRecord): string[] {
    return group.members.filter((m) => text.includes(`@${m}`))
  }

  /**
   * 轮转代际是否已过期（supersede 判定）：runner 终答写入前调用（装配注入
   * isGroupTurnStale）——旧轮 turn 的发言静默丢弃，不落群流不发事件。
   * 与 #onSettled 的代际判定双层防线（写入点 + 编排推进点）。
   */
  isStale(payload: { groupId: string; gen: number }): boolean {
    return this.#runtimeOf(payload.groupId).gen !== payload.gen
  }

  /** 轮转推进：未发言且未 pass 的下一成员（@提及者优先）；全员结算即收敛。
   *  gen 在入队时快照捕获（闭包 rt 与新轮共享同一对象——代际比较必须用快照）。
   *  独立作答（2026-10-18）：全员一次性并发入队（context 恒空——互不可见无锚定），
   *  settle 不再推进下一员（见 #onSettled 的独立收敛判定） */
  #advance(group: GroupRecord, rt: GroupRuntime): string[] {
    const spokenIds = rt.spoken.map((s) => s.id)
    const order = [
      ...rt.mentioned.filter((m) => !spokenIds.includes(m) && !rt.passed.includes(m)),
      ...group.members.filter((m) => !rt.mentioned.includes(m) && !spokenIds.includes(m) && !rt.passed.includes(m)),
    ]
    const genAtEnqueue = rt.gen
    if (rt.independent === true) {
      const runIds: string[] = []
      for (const memberId of order) {
        const ticket = this.#deps.schedulerOf(memberId).enqueue({
          lane: 'agent',
          kind: 'group',
          payload: {
            messageId: rt.turnMessageId,
            groupId: group.groupId,
            gen: rt.gen,
            round: rt.round,
            text: rt.turnText,
            context: [],
            mentioned: [...rt.mentioned],
            mode: 'independent',
            memberIds: [...group.members],
          } satisfies GroupTurnPayload,
          summary: summarizeRun(`群 ${group.groupId} 第${rt.round}轮独立作答 ${memberId}：${rt.turnText}`),
        })
        void ticket.settled.then((outcome) => this.#onSettled(group.groupId, genAtEnqueue, memberId, outcome))
        runIds.push(ticket.runId)
      }
      return runIds
    }
    const next = order[0]
    if (!next) {
      void this.#converge(group.groupId, rt)
      return []
    }
    const ticket = this.#deps.schedulerOf(next).enqueue({
      lane: 'agent',
      kind: 'group',
      payload: {
        messageId: rt.turnMessageId,
        groupId: group.groupId,
        gen: rt.gen,
        round: rt.round,
        text: rt.turnText,
        context: rt.spoken.map((s) => `${s.id}：${s.text}`),
        mentioned: [...rt.mentioned],
        memberIds: [...group.members],
      } satisfies GroupTurnPayload,
      summary: summarizeRun(`群 ${group.groupId} 第${rt.round}轮 ${next}：${rt.turnText}`),
    })
    void ticket.settled.then((outcome) => this.#onSettled(group.groupId, genAtEnqueue, next, outcome))
    return [ticket.runId]
  }

  /** 成员结算：代际不匹配（superseded）静默丢弃；[pass]/失败视作缺席；文本记群流进下一员。
   *  独立作答（2026-10-18）：全员已入队——不推进下一员，只在全员结算完毕时收敛 */
  async #onSettled(groupId: string, genAtEnqueue: number, memberId: string, outcome: RunOutcome): Promise<void> {
    if (genAtEnqueue !== this.#runtimeOf(groupId).gen) return // superseded：旧轮静默丢弃
    const group = this.#groups.get(groupId)
    const rt = this.#runtimeOf(groupId)
    if (!group) return
    const text =
      outcome.state === 'succeeded'
        ? String(((outcome.result as { text?: string } | undefined)?.text ?? '')).trim()
        : ''
    if (outcome.state === 'succeeded' && text !== '' && text !== GROUP_PASS_TOKEN) {
      rt.spoken.push({ id: memberId, text })
      await this.#settleAdvance(group, rt)
      return
    }
    if (outcome.state !== 'succeeded') {
      await this.#sys(groupId, `${memberId} 未响应（${outcome.code ?? outcome.state}）`)
    }
    // pass 可见化（2026-10-15 用户报障「有些 Agent 像是没工作」）：单成员 pass 记轻量注记——
    // 此前仅全员 pass 收敛才留痕，个别成员轮过但 pass 在 UI 上不可见
    if (outcome.state === 'succeeded') await this.#sys(groupId, `${memberId} 本轮 pass`)
    rt.passed.push(memberId)
    await this.#settleAdvance(group, rt)
  }

  /** 结算后推进：轮转模式 → 下一员；独立作答 → 不推进（全员已入队），全员结算完毕即收敛 */
  async #settleAdvance(group: GroupRecord, rt: GroupRuntime): Promise<void> {
    if (rt.independent !== true) {
      this.#advance(group, rt)
      return
    }
    const allDone = group.members.every(
      (m) => rt.spoken.some((s) => s.id === m) || rt.passed.includes(m),
    )
    if (allDone) await this.#converge(group.groupId, rt)
  }

  /** 收敛：全员 pass 记 sysnote；轮转结束（running=false） */
  async #converge(groupId: string, rt: GroupRuntime): Promise<void> {
    rt.running = false
    if (rt.passed.length > 0 && rt.spoken.length === 0) {
      await this.#sys(groupId, `全员 pass，本轮收敛（第${rt.round}轮）`)
    }
  }

  /** sysnote：落群 transcript + 事件（renderer 群流系统注记） */
  async #sys(groupId: string, note: string): Promise<void> {
    const messageId = this.#deps.nextMessageId()
    await this.#deps.transcript.append(groupId, 'group-sys', { messageId, from: 'system', text: note, at: this.#deps.now() })
    this.#deps.bus.emit('v1.group.message', { groupId, messageId, kind: 'sys', from: 'system', text: note })
  }

  #runtimeOf(groupId: string): GroupRuntime {
    let rt = this.#runtime.get(groupId)
    if (!rt) {
      rt = { gen: 0, round: 0, spoken: [], passed: [], running: false, turnText: '', turnMessageId: '', mentioned: [] }
      this.#runtime.set(groupId, rt)
    }
    return rt
  }
}
