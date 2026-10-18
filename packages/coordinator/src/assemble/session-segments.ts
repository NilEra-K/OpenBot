/**
 * 会话段扫描（2026-10-18 /resume 列表改进）：transcript 原始流 → 会话段视图。
 * 栈语义与 runner sessionView 同构（session-start 压栈 / session-resume 弹栈或回溯）——
 * 消息归属「接收段」= 当前栈顶（栈空 = 初始段）：resume 回旧会话后的新消息归旧会话
 * （组装侧本就如此——此处让清单口径与组装一致）。
 * 消费方：v1.session.list（清单）、v1.session.clear（空段 no-op 判定）、会话标题触发
 * （首问判定）——三处共用同一事实源。
 */

/** 初始段 synthetic id（首个 session-start 之前/栈被弹空后的消息归属段；沿用 v0.1.47 呈现惯例） */
export const INITIAL_SESSION_ID = 's-0'

/** 会话段视图（v1.session.list 条目形状；title 来自 session-title 记录——旧数据缺席回退首问） */
export interface SessionSegment {
  sessionId: string
  /** 段内领域消息数（user/agent——与既有 list 计数口径一致） */
  messageCount: number
  /** 段内首条消息文本（标题缺席时的呈现回退） */
  firstText: string
  /** 段内最后活动时间（空段 = 边界时间） */
  lastAt: number
  /** 会话标题（段内最新一条 session-title 记录；无则缺席） */
  title?: string
  /** 是否当前段（扫描结束时的接收段） */
  current: boolean
}

/** transcript 记录最小形状（读写端解耦——只取需要的字段） */
export interface SegmentRecord {
  kind: string
  payload: unknown
  at: number
}

function payloadOf(record: SegmentRecord): Record<string, unknown> {
  return typeof record.payload === 'object' && record.payload !== null ? (record.payload as Record<string, unknown>) : {}
}

/** 按 sessionId 切分会话段（显示序 = lastAt 升序；同段被 resume 回溯续写时跨区间合并计数） */
export function sessionSegments(records: SegmentRecord[]): SessionSegment[] {
  const segments = new Map<string, SessionSegment>()
  const segOf = (sessionId: string, at: number): SessionSegment => {
    let seg = segments.get(sessionId)
    if (seg === undefined) {
      seg = { sessionId, messageCount: 0, firstText: '', lastAt: at, current: false }
      segments.set(sessionId, seg)
    }
    return seg
  }

  const stack: string[] = []
  let receiving = INITIAL_SESSION_ID // 栈空时消息落初始段
  let ordinal = 0 // synthetic 回退序号（旧记录 payload 缺 sessionId 的防御路径）
  for (const record of records) {
    const p = payloadOf(record)
    if (record.kind === 'session-start') {
      ordinal += 1
      const id = typeof p['sessionId'] === 'string' && p['sessionId'] !== '' ? p['sessionId'] : `s-${ordinal}`
      stack.push(id)
      receiving = id
      segOf(id, record.at) // 段存在性由边界确立（空段也登记——去留由消费方决定）
      continue
    }
    if (record.kind === 'session-resume') {
      // 与 sessionView 同构：缺省弹栈；带目标回溯到目标边界（目标悬空则不动）
      const target = typeof p['sessionId'] === 'string' ? p['sessionId'] : null
      if (target === null) {
        stack.pop()
      } else {
        const idx = stack.indexOf(target)
        if (idx >= 0) stack.length = idx + 1
      }
      receiving = stack.length > 0 ? stack[stack.length - 1]! : INITIAL_SESSION_ID
      continue
    }
    if (record.kind === 'session-title') {
      const sid = typeof p['sessionId'] === 'string' ? p['sessionId'] : null
      if (sid !== null && typeof p['title'] === 'string' && p['title'] !== '') {
        const seg = segments.get(sid)
        if (seg !== undefined) seg.title = p['title']
      }
      continue
    }
    if (record.kind !== 'user' && record.kind !== 'agent') continue
    const seg = segOf(receiving, record.at)
    const text = typeof p['text'] === 'string' ? p['text'] : ''
    if (seg.messageCount === 0) seg.firstText = text
    seg.messageCount += 1
    seg.lastAt = record.at
  }

  segOf(receiving, records.at(-1)?.at ?? 0).current = true
  return [...segments.values()].sort((a, b) => a.lastAt - b.lastAt)
}
