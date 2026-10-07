/**
 * sessionView 测试矩阵（「会话掌控」）：clear/resume 栈窗口、revision 替换与
 * regenerate 截断窗、tombstone/revive、组合边界（嵌套/多 clear/revive 后再 tombstone）。
 */
import { describe, expect, it } from 'vitest'
import { sessionView } from '../src/turn/session-view.js'

const msg = (kind: string, messageId: string, text: string) => ({ kind, payload: { messageId, text }, at: 1 })

describe('sessionView', () => {
  it('无元事件：领域消息透传；元事件与 thinking/exec 被剔除', () => {
    const v = sessionView([
      msg('user', 'm1', '你好'),
      { kind: 'thinking', payload: { text: '思考' } },
      msg('agent', 'm2', '在的'),
      { kind: 'exec', payload: { command: ['ls'] } },
      { kind: 'group-sys', payload: { text: '注记' } },
    ])
    expect(v.records).toEqual([msg('user', 'm1', '你好'), msg('agent', 'm2', '在的')])
    expect(v.currentSessionId).toBeNull()
  })

  it('session-start：组装窗口从其后开始（clear 语义）；currentSessionId 就位', () => {
    const v = sessionView([
      msg('user', 'm1', '扫雷上下文'),
      msg('agent', 'm2', '好的'),
      { kind: 'session-start', payload: { sessionId: 's-2' } },
      msg('user', 'm3', '你好'),
      msg('agent', 'm4', '新会话'),
    ])
    expect(v.records.map((r) => (r.payload as { text: string }).text)).toEqual(['你好', '新会话'])
    expect(v.currentSessionId).toBe('s-2')
  })

  it('resume 抵消最近一次 clear：组装回上一会话（栈语义）', () => {
    const v = sessionView([
      msg('user', 'm1', '旧话题'),
      { kind: 'session-start', payload: { sessionId: 's-2' } },
      msg('user', 'm2', '新话题'),
      { kind: 'session-resume', payload: {} },
      msg('user', 'm3', '继续旧话题'),
    ])
    // resume 弹栈 → 窗口回到 s-2 之前（全量）：m1 在场（旧话题延续）；s-2 段内消息在场（事实保留）
    expect(v.records.map((r) => (r.payload as { text: string }).text)).toEqual(['旧话题', '新话题', '继续旧话题'])
    expect(v.currentSessionId).toBeNull()
  })

  it('两次 clear 后 resume：只抵消最近一次', () => {
    const v = sessionView([
      msg('user', 'm1', 'a'),
      { kind: 'session-start', payload: { sessionId: 's-2' } },
      msg('user', 'm2', 'b'),
      { kind: 'session-start', payload: { sessionId: 's-3' } },
      msg('user', 'm3', 'c'),
      { kind: 'session-resume', payload: {} },
      msg('user', 'm4', 'd'),
    ])
    // 弹掉 s-3 → 窗口 = s-2 之后：b/c/d（a 在 s-2 窗口外）
    expect(v.records.map((r) => (r.payload as { text: string }).text)).toEqual(['b', 'c', 'd'])
    expect(v.currentSessionId).toBe('s-2')
  })

  it('revision 仅替换文本（regenerate=false）：旧 agent 回答保留', () => {
    const v = sessionView([
      msg('user', 'm1', '装环境'),
      msg('agent', 'm2', '装好了'),
      { kind: 'revision', payload: { messageId: 'm1', text: '装环境（修正版）', regenerate: false } },
    ])
    expect(v.records.map((r) => (r.payload as { text: string }).text)).toEqual(['装环境（修正版）', '装好了'])
  })

  it('revision regenerate=true：目标之后到 revision 之间的旧时间线剔除；目标消息以新文本保留', () => {
    const v = sessionView([
      msg('user', 'm1', '帮我扫雷'),
      msg('agent', 'm2', '开始扫雷…'),
      msg('user', 'm3', '继续'),
      msg('agent', 'm4', '完成'),
      { kind: 'revision', payload: { messageId: 'm1', text: '帮我写周报', regenerate: true } },
      msg('agent', 'm5', '周报写好了'),
    ])
    expect(v.records.map((r) => (r.payload as { text: string }).text)).toEqual(['帮我写周报', '周报写好了'])
  })

  it('tombstone：agent 消息移出上下文；revive 恢复', () => {
    const base = [
      msg('user', 'm1', '问'),
      msg('agent', 'm2', '坏答案'),
      msg('agent', 'm3', '好答案'),
    ]
    const t = sessionView([...base, { kind: 'tombstone', payload: { messageId: 'm2' } }])
    expect(t.records.map((r) => (r.payload as { text: string }).text)).toEqual(['问', '好答案'])
    const r = sessionView([...base, { kind: 'tombstone', payload: { messageId: 'm2' } }, { kind: 'revive', payload: { messageId: 'm2' } }])
    expect(r.records.map((x) => (x.payload as { text: string }).text)).toEqual(['问', '坏答案', '好答案'])
  })

  it('组合：clear 后编辑重驱 + tombstone 并存（新会话内独立运作）', () => {
    const v = sessionView([
      msg('user', 'm0', '远古'),
      { kind: 'session-start', payload: { sessionId: 's-2' } },
      msg('user', 'm1', '第一问'),
      msg('agent', 'm2', '第一答'),
      { kind: 'revision', payload: { messageId: 'm1', text: '第一问（改）', regenerate: true } },
      msg('agent', 'm3', '新第一答'),
      { kind: 'tombstone', payload: { messageId: 'm3' } },
      msg('agent', 'm4', '再答'),
    ])
    expect(v.records.map((r) => (r.payload as { text: string }).text)).toEqual(['第一问（改）', '再答'])
    expect(v.currentSessionId).toBe('s-2')
  })

  it('session-start 缺 sessionId：缺省 s-N 兜底（自增序）', () => {
    const v = sessionView([{ kind: 'session-start', payload: {} }, msg('user', 'm1', 'hi')])
    expect(v.currentSessionId).toBe('s-1')
  })
})

describe('resume 会话选择化（v0.1.47）', () => {
  it('resume 带 sessionId：窗口移回该会话起点（其后时间线失效）', () => {
    const v = sessionView([
      msg('user', 'm1', 's0-话题'),
      { kind: 'session-start', payload: { sessionId: 's-1' } },
      msg('user', 'm2', 's1-话题'),
      { kind: 'session-start', payload: { sessionId: 's-2' } },
      msg('user', 'm3', 's2-话题'),
      { kind: 'session-resume', payload: { sessionId: 's-1' } },
      msg('user', 'm4', '继续 s1'),
    ])
    expect(v.records.map((r) => (r.payload as { text: string }).text)).toEqual(['s1-话题', '继续 s1'])
    expect(v.currentSessionId).toBe('s-1')
  })

  it('resume 缺省：回上一个（原快捷语义不变）', () => {
    const v = sessionView([
      { kind: 'session-start', payload: { sessionId: 's-1' } },
      msg('user', 'm1', 'a'),
      { kind: 'session-start', payload: { sessionId: 's-2' } },
      msg('user', 'm2', 'b'),
      { kind: 'session-resume', payload: {} },
      msg('user', 'm3', 'c'),
    ])
    expect(v.records.map((r) => (r.payload as { text: string }).text)).toEqual(['a', 'b', 'c'])
    expect(v.currentSessionId).toBe('s-1')
  })

  it('resume 到早期会话后再 clear：正常开新会话（栈截断后自洽）', () => {
    const v = sessionView([
      { kind: 'session-start', payload: { sessionId: 's-1' } },
      msg('user', 'm1', '一'),
      { kind: 'session-start', payload: { sessionId: 's-2' } },
      msg('user', 'm2', '二'),
      { kind: 'session-resume', payload: { sessionId: 's-1' } },
      msg('user', 'm3', '续一'),
      { kind: 'session-start', payload: { sessionId: 's-3' } },
      msg('user', 'm4', '三'),
    ])
    expect(v.records.map((r) => (r.payload as { text: string }).text)).toEqual(['三'])
    expect(v.currentSessionId).toBe('s-3')
  })

  it('resume 目标不存在：无操作（如实忽略——不炸组装）', () => {
    const v = sessionView([
      { kind: 'session-start', payload: { sessionId: 's-1' } },
      msg('user', 'm1', 'a'),
      { kind: 'session-resume', payload: { sessionId: 's-9' } },
    ])
    expect(v.records.map((r) => (r.payload as { text: string }).text)).toEqual(['a']) // 目标不存在——窗口保持原样（s-1 后）
  })
})
