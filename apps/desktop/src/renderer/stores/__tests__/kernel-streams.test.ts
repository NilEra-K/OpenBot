import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useKernelStore } from '../kernel'

/** 流断线封块（v0.1.121 拼接残留根治）：断线瞬间全量 live 块就地封存——
 *  hub 语义「流只发给 open 时刻已连接的会话」，重连后旧流 end 不补发，
 *  不封则 live 永久滞留且新轮 chunk 被反向 find 续写进旧块（「旧正文＋终答」拼接） */
describe('onStreamsDisconnected（断线封块）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('全量 live 块封存：state 置 end（exec 同封）、think 块补时长、已收内容不动', () => {
    const k = useKernelStore()
    const at = Date.now() - 5_000
    k.streams.push(
      { key: 'r1:llm:text:1', agentId: 'a1', runId: 'r1', stream: 'llm', seq: 0, stdout: '正文', stderr: '', state: 'live', at },
      { key: 'r1:llm:think:2', agentId: 'a1', runId: 'r1', stream: 'llm', seq: 0, stdout: '思考', stderr: '', state: 'live', at, think: true },
      { key: 'r2:exec:3', agentId: 'a1', runId: 'r2', stream: 'exec', seq: 1, stdout: 'out', stderr: '', state: 'live', at, command: ['ls'], boxId: 'b1' },
      { key: 'r3:llm:text:4', agentId: 'a1', runId: 'r3', stream: 'llm', seq: 0, stdout: '已收', stderr: '', state: 'end', at, durationMs: 100 },
    )
    k.onStreamsDisconnected()
    expect(k.streams.every((s) => s.state === 'end')).toBe(true)
    expect(k.streams.find((s) => s.key === 'r3:llm:text:4')?.durationMs).toBe(100) // 已结束块不重算
    const think = k.streams.find((s) => s.key === 'r1:llm:think:2')
    expect(think?.durationMs).toBeGreaterThanOrEqual(4_999)
    expect(think?.stdout).toBe('思考') // 封存不改内容
  })

  it('封存后新轮 chunk 不再续写旧块（拼接根因断绝）', () => {
    const k = useKernelStore()
    k.streams.push({
      key: 'run-x:llm:text:1', agentId: 'a1', runId: 'run-x', stream: 'llm', seq: 1,
      stdout: '旧正文', stderr: '', state: 'live', at: Date.now(),
    })
    k.onStreamsDisconnected() // 断线封块（旧块 state=end，find 的 live 条件不再命中）
    k.onStreamChunk({ agentId: 'a1', runId: 'run-x', stream: 'llm', seq: 2 }, { t: '新轮正文' })
    const blocks = k.streams.filter((s) => s.runId === 'run-x')
    expect(blocks).toHaveLength(2) // 旧块封存 + 新块独立成体
    expect(blocks[0]?.stdout).toBe('旧正文')
    expect(blocks[1]?.stdout).toBe('新轮正文')
    expect(blocks[1]?.state).toBe('live')
  })

  it('错位流不续写旧块（seq 身份配对——封块漏网时的结构兜底）', () => {
    const k = useKernelStore()
    // 模拟：旧块因故未被清扫仍 live（任何未来路径的漏网），新流（seq=2）chunk 到达
    k.streams.push({
      key: 'run-x:llm:text:1', agentId: 'a1', runId: 'run-x', stream: 'llm', seq: 1,
      stdout: '旧正文', stderr: '', state: 'live', at: Date.now(),
    })
    k.onStreamChunk({ agentId: 'a1', runId: 'run-x', stream: 'llm', seq: 2 }, { t: '新轮正文' })
    const blocks = k.streams.filter((s) => s.runId === 'run-x')
    expect(blocks).toHaveLength(2) // seq 不同 → 不命中旧块 → 新块独立成体
    expect(blocks[0]?.stdout).toBe('旧正文')
    expect(blocks[1]?.stdout).toBe('新轮正文')
  })

  it('同流 seq 正常续写（think/text 双通道各续各块）', () => {
    const k = useKernelStore()
    k.onStreamChunk({ agentId: 'a1', runId: 'run-x', stream: 'llm', seq: 1 }, { t: '正' })
    k.onStreamChunk({ agentId: 'a1', runId: 'run-x', stream: 'llm', seq: 1 }, { t: '文' })
    k.onStreamChunk({ agentId: 'a1', runId: 'run-x', stream: 'llm', seq: 1 }, { t: '思', th: true })
    k.onStreamChunk({ agentId: 'a1', runId: 'run-x', stream: 'llm', seq: 1 }, { t: '考', th: true })
    expect(k.streams.filter((s) => s.runId === 'run-x')).toHaveLength(2)
    expect(k.streams.find((s) => s.think !== true)?.stdout).toBe('正文')
    expect(k.streams.find((s) => s.think === true)?.stdout).toBe('思考')
  })

  it('END 按流 seq 精确关块（同 run 不同代际互不误关）', () => {
    const k = useKernelStore()
    k.streams.push(
      { key: 'a:1', agentId: 'a1', runId: 'run-x', stream: 'llm', seq: 1, stdout: '旧', stderr: '', state: 'live', at: Date.now() },
      { key: 'a:2', agentId: 'a1', runId: 'run-x', stream: 'llm', seq: 2, stdout: '新', stderr: '', state: 'live', at: Date.now(), think: true },
    )
    k.onStreamEnd({ agentId: 'a1', runId: 'run-x', stream: 'llm', seq: 2 })
    expect(k.streams.find((s) => s.seq === 1)?.state).toBe('live') // 旧代际不受牵连
    expect(k.streams.find((s) => s.seq === 2)?.state).toBe('end')
  })

  it('空流表/无 live 块时幂等（boot 早期断连不炸）', () => {
    const k = useKernelStore()
    expect(() => k.onStreamsDisconnected()).not.toThrow()
  })

  it('终答后晚到**正文**碎片不建块（v0.1.122 迟到残留根治：「图片？」报障场景）', () => {
    const k = useKernelStore()
    // 终答事件先到（WS 流与事件总线两通道独立竞速——碎片可晚终答数秒）
    k.onEvent({ type: 'v1.message.agent', seq: 1, at: 1000, payload: { messageId: 'm1', agentId: 'a1', text: 'Everything 已打开……图片？', runId: 'run-x' } as never })
    expect(k.finalizedRunIds).toContain('run-x')
    // 9.5 秒后尾部正文碎片 chunk 才到达——掐断不建块
    k.onStreamChunk({ agentId: 'a1', runId: 'run-x', stream: 'llm', seq: 4 }, { t: '图片？' })
    expect(k.streams.filter((s) => s.runId === 'run-x' && s.think !== true)).toHaveLength(0)
    // 思考通道不掐（v0.1.43「思考块保留」——终答后到达的思考卡是过程事实）
    k.onStreamChunk({ agentId: 'a1', runId: 'run-x', stream: 'llm', seq: 4 }, { t: '事后思考', th: true })
    expect(k.streams.filter((s) => s.runId === 'run-x' && s.think === true)).toHaveLength(1)
  })

  it('终答事件同时清除当时在场的正文块（既有语义保持）+ runId 幂等不重复记档', () => {
    const k = useKernelStore()
    k.streams.push(
      { key: 'b1', agentId: 'a1', runId: 'run-x', stream: 'llm', seq: 1, stdout: '正文预览', stderr: '', state: 'live', at: 900 },
      { key: 'b2', agentId: 'a1', runId: 'run-x', stream: 'llm', seq: 1, stdout: '思考', stderr: '', state: 'live', at: 900, think: true },
    )
    k.onEvent({ type: 'v1.message.agent', seq: 2, at: 1000, payload: { messageId: 'm1', agentId: 'a1', text: '终答', runId: 'run-x' } as never })
    expect(k.streams.some((s) => s.think !== true)).toBe(false) // 正文块被清
    expect(k.streams.some((s) => s.think === true)).toBe(true) // 思考块保留（v0.1.43 语义）
    k.onEvent({ type: 'v1.message.agent', seq: 3, at: 1100, payload: { messageId: 'm2', agentId: 'a1', text: '终答2', runId: 'run-x' } as never })
    expect(k.finalizedRunIds.filter((r) => r === 'run-x')).toHaveLength(1) // 幂等
  })

  it('无终答的 run（预算耗尽/中止）正文照常保留（既有「最后事实」语义不回归）', () => {
    const k = useKernelStore()
    k.onStreamChunk({ agentId: 'a1', runId: 'run-y', stream: 'llm', seq: 1 }, { t: '预算耗尽前的交代' })
    expect(k.streams.filter((s) => s.runId === 'run-y' && s.think !== true)).toHaveLength(1)
  })
})
