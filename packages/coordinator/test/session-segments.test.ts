import { describe, expect, it } from 'vitest'
import { INITIAL_SESSION_ID, sessionSegments } from '../src/assemble/session-segments.js'

const rec = (kind: string, payload: Record<string, unknown> = {}, at = 0): { kind: string; payload: unknown; at: number } => ({
  kind,
  payload,
  at,
})

describe('sessionSegments（栈语义段扫描——v1.session.list/clear/标题触发共用）', () => {
  it('空 transcript：仅初始段（current、零消息）', () => {
    expect(sessionSegments([])).toEqual([
      { sessionId: INITIAL_SESSION_ID, messageCount: 0, firstText: '', firstAgentText: '', lastAt: 0, current: true },
    ])
  })

  it('基本切分：初始段在前；边界确立段（空段也登记——去留归消费方）；current 标记接收段', () => {
    const segs = sessionSegments([
      rec('user', { messageId: 'm1', text: '一问' }, 1),
      rec('session-start', { sessionId: 'u-A' }, 2),
      rec('user', { messageId: 'm2', text: '二问' }, 3),
      rec('agent', { messageId: 'm3', text: '二答' }, 4),
      rec('session-start', { sessionId: 'u-B' }, 5),
    ])
    expect(segs.map((s) => [s.sessionId, s.messageCount, s.current])).toEqual([
      [INITIAL_SESSION_ID, 1, false],
      ['u-A', 2, false],
      ['u-B', 0, true],
    ])
    expect(segs[0]?.firstText).toBe('一问')
    expect(segs[1]?.lastAt).toBe(4)
  })

  it('resume 缺省弹栈：弹栈后的消息归回上一会话（跨区间合并计数）', () => {
    const segs = sessionSegments([
      rec('session-start', { sessionId: 'u-A' }, 1),
      rec('user', { messageId: 'm1', text: 'A 首问' }, 2),
      rec('session-start', { sessionId: 'u-B' }, 3),
      rec('user', { messageId: 'm2', text: 'B 问' }, 4),
      rec('session-resume', {}, 5),
      rec('user', { messageId: 'm3', text: 'A 续问' }, 6),
    ])
    // 显示序 = lastAt 升序（renderer 侧再 reverse 成最新在前）：u-B(4) 先于 u-A(6)
    expect(segs.map((s) => [s.sessionId, s.messageCount])).toEqual([
      ['u-B', 1],
      ['u-A', 2], // m1 + resume 后的 m3（组装侧同款归属）
    ])
    expect(segs.find((s) => s.sessionId === 'u-A')?.current).toBe(true) // 弹栈后接收段回到 u-A
  })

  it('resume 带目标回溯：栈截到目标；目标悬空不动', () => {
    const base = [
      rec('session-start', { sessionId: 'u-A' }, 1),
      rec('session-start', { sessionId: 'u-B' }, 2),
      rec('session-resume', { sessionId: 'u-A' }, 3),
      rec('user', { messageId: 'm1', text: '回 A 后' }, 4),
    ]
    expect(sessionSegments(base).map((s) => [s.sessionId, s.messageCount, s.current])).toContainEqual(['u-A', 1, true])
    // 悬空目标：栈不变（仍接收在 u-B）
    const dangling = sessionSegments([
      rec('session-start', { sessionId: 'u-A' }, 1),
      rec('session-start', { sessionId: 'u-B' }, 2),
      rec('session-resume', { sessionId: '不存在的' }, 3),
      rec('user', { messageId: 'm1', text: '悬空后续' }, 4),
    ])
    expect(dangling.find((s) => s.sessionId === 'u-B')).toMatchObject({ messageCount: 1, current: true })
  })

  it('session-title 记录挂段（最新一条生效；悬空 sessionId 忽略）', () => {
    const segs = sessionSegments([
      rec('session-start', { sessionId: 'u-A' }, 1),
      rec('session-title', { sessionId: 'u-A', title: '第一版' }, 2),
      rec('user', { messageId: 'm1', text: '问' }, 3),
      rec('session-title', { sessionId: 'u-A', title: '第二版' }, 4),
      rec('session-title', { sessionId: 'u-悬空', title: '无效' }, 5),
    ])
    expect(segs.find((s) => s.sessionId === 'u-A')?.title).toBe('第二版')
  })

  it('旧记录防御：session-start 缺 sessionId 时合成回退 id', () => {
    const segs = sessionSegments([rec('session-start', {}, 1)])
    expect(segs.map((s) => s.sessionId)).toEqual(['s-1'])
  })
})
