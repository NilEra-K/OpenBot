/**
 * 会话视图纯函数（「会话掌控」轮地基）：transcript 原始流 → 有效组装流。
 * 一切会话操作都是 append-only 事件（铁律零妥协）——本函数是元事件的唯一解释器：
 *
 * - session-start（/clear 追加）：组装窗口从最后一个未被抵消的 session-start 开始
 *   （栈语义：start 压栈、resume 弹栈——/resume 抵消最近一次 clear 回上一会话继续）；
 * - revision（编辑用户消息）：替换目标消息文本；regenerate=true 时目标消息与 revision
 *   记录之间的领域消息跳过（被替换的旧时间线——物理保留、组装剔除）；
 * - tombstone / revive（agent 回复移出/恢复上下文）：移出的消息组装跳过（物理保留）。
 *
 * 元事件自身不产出消息；本函数只做过滤与文本替换，输出仍是被 toChatMessages 消费的
 * record 形状（kind/payload 透传，revision 替换写回 payload.text）。
 */
export interface SessionRecord {
  kind: string
  payload: unknown
  at?: number
  /** 源记录序号透传（会话引擎 v2 · compact 溯源用；视图原样透传 TranscriptRecord 时在场） */
  seq?: number
}

export interface SessionView {
  /** 有效组装流（已剔除窗口外/截断/tombstone，revision 已替换文本） */
  records: SessionRecord[]
  /** 当前会话 id（最近未被抵消的 session-start；无 start = 初始会话 null） */
  currentSessionId: string | null
}

/** payload 安全取形 */
function payloadOf(record: SessionRecord): Record<string, unknown> {
  return typeof record.payload === 'object' && record.payload !== null ? (record.payload as Record<string, unknown>) : {}
}

/** 领域消息（进 llm 历史的 kind——与 toChatMessages 映射集一致） */
function isDomainMessage(kind: string): boolean {
  return kind === 'user' || kind === 'agent' || kind === 'a2a-in' || kind === 'a2a-out' || kind === 'group-user' || kind === 'group-agent'
}

export function sessionView(records: SessionRecord[]): SessionView {
  // ---- pass 1：元事件扫描 ----
  const tombstoned = new Set<string>() // revive 移除
  const revisions = new Map<string, string>() // messageId → 最新文本
  /** regenerate 截断区间（开区间端点对）：[目标位置+1, revision 位置)——空间窗而非按 id 查 */
  const truncateRanges: Array<[number, number]> = []
  /** 目标消息自身位置（截断窗不含目标——目标以新文本保留） */
  const targetIndex = new Map<string, number>()
  /** clear 栈（session-start 压栈 / resume 弹栈）——栈底之上的全部在窗口外 */
  let startStack: Array<{ index: number; sessionId: string }> = []
  /** resume 目标与 resume 之间的失效区间（未走分支） */
  const deadRanges: Array<[number, number]> = []
  records.forEach((record, index) => {
    const p = payloadOf(record)
    const id = typeof p['messageId'] === 'string' ? p['messageId'] : null
    switch (record.kind) {
      case 'session-start':
        startStack.push({ index, sessionId: typeof p['sessionId'] === 'string' ? p['sessionId'] : `s-${startStack.length + 1}` })
        break
      case 'session-resume': {
        // 恢复会话（v0.1.47 选择化）：带 sessionId = 窗口移回该会话起点；目标与 resume 之间的
        // 后续会话时间线失效（回到 s-1 则 s-2 的内容到本 resume 之前的区间跳过）；
        // 缺省 = 弹栈回上一个（快捷语义，等效区间跳过由窗口回退自然达成）
        const target = typeof p['sessionId'] === 'string' ? p['sessionId'] : null
        if (target === null) {
          startStack.pop()
        } else {
          const idx = startStack.findIndex((s) => s.sessionId === target)
          if (idx >= 0) {
            // 目标之后、resume 之前的最近 start 起一段失效（未走分支）
            const laterStart = startStack.slice(idx + 1).filter((s) => s.index < index)[0]
            if (laterStart !== undefined) deadRanges.push([laterStart.index, index])
            startStack = startStack.slice(0, idx + 1)
          }
        }
        break
      }
      case 'tombstone':
        if (id !== null) tombstoned.add(id)
        break
      case 'revive':
        if (id !== null) tombstoned.delete(id)
        break
      case 'revision':
        if (id !== null) {
          if (typeof p['text'] === 'string') revisions.set(id, p['text'])
          const selfIdx = targetIndex.get(id)
          if (p['regenerate'] === true && selfIdx !== undefined) {
            truncateRanges.push([selfIdx + 1, index]) // 目标之后 → revision 之前（空间窗）
          }
        }
        break
      default:
        if (isDomainMessage(record.kind) && id !== null && !targetIndex.has(id)) {
          targetIndex.set(id, index) // 领域消息首现位置（截断窗排除目标自身）
        }
        break
    }
  })

  // ---- pass 2：组装变换 ----
  const windowStart = startStack.length > 0 ? startStack[startStack.length - 1]!.index + 1 : 0
  const out: SessionRecord[] = []
  records.forEach((record, index) => {
    if (index < windowStart) return // clear 窗口外（旧会话）
    if (deadRanges.some(([from, to]) => index >= from && index < to)) return // resume 未走分支
    const p = payloadOf(record)
    const id = typeof p['messageId'] === 'string' ? p['messageId'] : null
    if (!isDomainMessage(record.kind)) {
      // 元事件/thinking/exec/group-sys 等不透传给消息组装（toChatMessages 本也忽略——
      // 这里统一剔除保持输出即有效流）
      return
    }
    if (id !== null) {
      if (tombstoned.has(id)) return // 移出上下文
      if (truncateRanges.some(([from, to]) => index >= from && index < to)) {
        return // 被替换的旧时间线（空间窗内）
      }
      const revised = revisions.get(id)
      if (revised !== undefined) {
        out.push({ ...record, payload: { ...p, text: revised } })
        return
      }
    }
    out.push(record)
  })

  return {
    records: out,
    currentSessionId: startStack.length > 0 ? startStack[startStack.length - 1]!.sessionId : null,
  }
}

/**
 * 按 sessionId 提取会话段（引用注入与 v1.session.list 共用）：**栈语义**（2026-10-18 对齐
 * sessionView/sessionSegments——resume 回溯续写归旧会话；此前朴素切段在定向回退多级时
 * 计数与注入内容错位）。返回归属该会话的全部记录（resume 后续写的消息含在内）；边界记录
 * 本身不进输出（提取片对 sessionView 无边界=全窗，tombstone/revision 照常解释）。
 * sessionId=null 提取初始段（栈空时接收的全部记录）。
 */
export function extractSession(records: SessionRecord[], sessionId: string | null): SessionRecord[] {
  const out: SessionRecord[] = []
  const stack: string[] = []
  let ordinal = 0
  for (const record of records) {
    const p = payloadOf(record)
    if (record.kind === 'session-start') {
      ordinal += 1
      const id = typeof p['sessionId'] === 'string' && p['sessionId'] !== '' ? p['sessionId'] : `s-${ordinal}`
      stack.push(id)
      continue
    }
    if (record.kind === 'session-resume') {
      const target = typeof p['sessionId'] === 'string' ? p['sessionId'] : null
      if (target === null) stack.pop()
      else {
        const idx = stack.indexOf(target)
        if (idx >= 0) stack.length = idx + 1
      }
      continue
    }
    const receiving = stack.length > 0 ? stack[stack.length - 1]! : null
    if (receiving === sessionId) out.push(record)
  }
  return out
}
