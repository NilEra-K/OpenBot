import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useKernelStore } from '../kernel'

// node 测试环境无 window：finished(failed)/escaped 事件推 toast 走 window.setTimeout——stub
beforeAll(() => {
  vi.stubGlobal('window', { setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms) })
})
afterAll(() => {
  vi.unstubAllGlobals()
})

/**
 * 流实况状态机（2026-11-02 流呈现根治）：
 * - 合帧缓冲：onStreamChunk 只入缓冲（渲染节奏与到达节奏解耦），断言前手动 flush
 * - run 语义终结（原则 1）：终答 / lifecycle.finished 事件 → finalizeRun 封存 +
 *   markRunFinalized 记档——此后该 run 一切流增量（正文/思考/exec）无处安放、一律丢弃；
 *   过程事实由 transcript 记录留痕（实况掐断不丢事实）。escaped 转后台非终态，不封。
 */
describe('流实况：合帧缓冲与 run 语义终结', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    useKernelStore().discardStreamBuffers() // 模块级缓冲跨用例隔离
  })

  it('合帧缓冲：增量先聚合后批量落块（chunk 到达不即时建块）', () => {
    const k = useKernelStore()
    k.onStreamChunk({ agentId: 'a1', runId: 'r0', stream: 'llm', seq: 1 }, { t: '思考' })
    k.onStreamChunk({ agentId: 'a1', runId: 'r0', stream: 'llm', seq: 1 }, { t: '增量', th: true })
    expect(k.streams).toHaveLength(0) // 未 flush：零渲染突变
    k.flushStreamBuffers()
    expect(k.streams).toHaveLength(2)
    expect(k.streams.find((s) => s.think !== true)?.stdout).toBe('思考')
    expect(k.streams.find((s) => s.think === true)?.stdout).toBe('增量')
  })

  it('llm 轮次登记：open 携带 round → 惰性建块带 round（回放判重前提——刷新而内核还活不双卡）', () => {
    const k = useKernelStore()
    k.onStreamOpen({ agentId: 'a1', runId: 'r0', stream: 'llm', seq: 1, round: 3 })
    k.onStreamChunk({ agentId: 'a1', runId: 'r0', stream: 'llm', seq: 1 }, { t: '想', th: true })
    k.flushStreamBuffers()
    const block = k.streams.find((s) => s.think === true)
    expect(block?.round).toBe(3)
    // 回放判重命中（loadHistory thinking 投影按 runId+round 匹配实况块）
    expect(k.streams.some((s) => s.runId === 'r0' && s.stream === 'llm' && (s.round ?? undefined) === 3)).toBe(true)
  })

  it('END 前缓冲强制落块：关块时已收内容完整（含未 flush 增量）+ think 时长回写', () => {
    const k = useKernelStore()
    k.onStreamOpen({ agentId: 'a1', runId: 'r0', stream: 'llm', seq: 1, round: 1 })
    k.onStreamChunk({ agentId: 'a1', runId: 'r0', stream: 'llm', seq: 1 }, { t: '前段', th: true })
    k.onStreamChunk({ agentId: 'a1', runId: 'r0', stream: 'llm', seq: 1 }, { t: '尾段', th: true })
    k.onStreamEnd({ agentId: 'a1', runId: 'r0', stream: 'llm', seq: 1 })
    const block = k.streams.find((s) => s.think === true)
    expect(block?.state).toBe('end')
    expect(block?.stdout).toBe('前段尾段') // 缓冲增量不因关块丢失
    expect(block?.durationMs).not.toBeUndefined()
  })

  it('断线封块：缓冲全量落块再封存——已收内容如实保留', () => {
    const k = useKernelStore()
    k.onStreamChunk({ agentId: 'a1', runId: 'r0', stream: 'llm', seq: 1 }, { t: '思考', th: true })
    k.onStreamsDisconnected()
    const block = k.streams.find((s) => s.think === true)
    expect(block?.state).toBe('end')
    expect(block?.stdout).toBe('思考')
    expect(k.streams.every((s) => s.state === 'end')).toBe(true)
  })

  it('封存后新轮 chunk 不再续写旧块（拼接根因断绝，v0.1.121 语义保持）', () => {
    const k = useKernelStore()
    k.streams.push({
      key: 'run-x:llm:text:1', agentId: 'a1', runId: 'run-x', stream: 'llm', seq: 1,
      stdout: '旧正文', stderr: '', state: 'live', at: Date.now(),
    })
    k.onStreamsDisconnected() // 断线封块（旧块 state=end，find 的 live 条件不再命中）
    k.onStreamChunk({ agentId: 'a1', runId: 'run-x', stream: 'llm', seq: 2 }, { t: '新轮正文' })
    k.flushStreamBuffers()
    const blocks = k.streams.filter((s) => s.runId === 'run-x')
    expect(blocks).toHaveLength(2) // 旧块封存 + 新块独立成体
    expect(blocks[0]?.stdout).toBe('旧正文')
    expect(blocks[1]?.stdout).toBe('新轮正文')
    expect(blocks[1]?.state).toBe('live')
  })

  it('错位流不续写旧块（seq 身份配对——封块漏网时的结构兜底）', () => {
    const k = useKernelStore()
    k.streams.push({
      key: 'run-x:llm:text:1', agentId: 'a1', runId: 'run-x', stream: 'llm', seq: 1,
      stdout: '旧正文', stderr: '', state: 'live', at: Date.now(),
    })
    k.onStreamChunk({ agentId: 'a1', runId: 'run-x', stream: 'llm', seq: 2 }, { t: '新轮正文' })
    k.flushStreamBuffers()
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
    k.flushStreamBuffers()
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

  it('终答事件：思考块就地封存 + 正文块移除 + 晚到正文丢弃、晚到思考归档补全（不冒充进行中）', () => {
    const k = useKernelStore()
    const at = Date.now() - 3_000
    k.streams.push(
      { key: 'b1', agentId: 'a1', runId: 'run-x', stream: 'llm', seq: 4, stdout: '正文预览', stderr: '', state: 'live', at, think: undefined },
      { key: 'b2', agentId: 'a1', runId: 'run-x', stream: 'llm', seq: 4, stdout: '已收思考', stderr: '', state: 'live', at, think: true },
    )
    k.onEvent({ type: 'v1.message.agent', seq: 1, at: 1000, payload: { messageId: 'm1', agentId: 'a1', text: '终答', runId: 'run-x' } as never })
    expect(k.finalizedRunIds).toContain('run-x')
    // 正文块移除（v0.1.113 收编语义）；思考块封存——「通知已到思考还在蹦字」根治
    expect(k.streams.some((s) => s.think !== true)).toBe(false)
    const think = k.streams.find((s) => s.think === true)
    expect(think?.state).toBe('end')
    expect(think?.stdout).toBe('已收思考') // 封存保留已收内容
    expect(think?.durationMs).not.toBeUndefined()
    // 晚到正文碎片丢弃（v0.1.122：内容已由终答承载）；晚到思考归档续写 end 块（内容补全）
    k.onStreamChunk({ agentId: 'a1', runId: 'run-x', stream: 'llm', seq: 4 }, { t: '图片？' })
    k.onStreamChunk({ agentId: 'a1', runId: 'run-x', stream: 'llm', seq: 4 }, { t: '事后思考', th: true })
    k.flushStreamBuffers()
    expect(k.streams.filter((s) => s.runId === 'run-x' && s.think !== true)).toHaveLength(0)
    expect(k.streams.find((s) => s.runId === 'run-x' && s.think === true)?.stdout).toBe('已收思考事后思考')
    expect(k.streams.find((s) => s.runId === 'run-x' && s.think === true)?.state).toBe('end') // 补全不复活 live
  })

  it('终答先于全部流增量到达（E2E 实证竞速）：晚到思考以 end 态落定——过程事实补全、实况期可见', () => {
    const k = useKernelStore()
    k.onEvent({ type: 'v1.message.agent', seq: 1, at: 1000, payload: { messageId: 'm1', agentId: 'a1', text: '终答', runId: 'run-z' } as never })
    k.onStreamOpen({ agentId: 'a1', runId: 'run-z', stream: 'llm', seq: 1, round: 1 })
    k.onStreamChunk({ agentId: 'a1', runId: 'run-z', stream: 'llm', seq: 1 }, { t: '整段思考都在终答后到达', th: true })
    k.flushStreamBuffers()
    const think = k.streams.find((s) => s.runId === 'run-z' && s.think === true)
    expect(think).toBeDefined() // 不丢弃——丢弃会让整轮思考在实况期不可见
    expect(think?.state).toBe('end') // 直接以完成态落定（不转盲文不显「思考中」）
    expect(think?.stdout).toBe('整段思考都在终答后到达')
    // 正文增量仍丢弃（碎片气泡防线）
    k.onStreamChunk({ agentId: 'a1', runId: 'run-z', stream: 'llm', seq: 1 }, { t: '正文余波' })
    k.flushStreamBuffers()
    expect(k.streams.some((s) => s.runId === 'run-z' && s.think !== true)).toBe(false)
  })

  it('终答时在途缓冲先落块：封存保留的「已收内容」含缓冲增量', () => {
    const k = useKernelStore()
    k.onStreamOpen({ agentId: 'a1', runId: 'run-x', stream: 'llm', seq: 4, round: 1 })
    k.onStreamChunk({ agentId: 'a1', runId: 'run-x', stream: 'llm', seq: 4 }, { t: '思考前半', th: true })
    // 终答事件先于定时 flush 到达：finalizeRun 强制 flush → 思考内容完整封存
    k.onEvent({ type: 'v1.message.agent', seq: 1, at: 1000, payload: { messageId: 'm1', agentId: 'a1', text: '终答', runId: 'run-x' } as never })
    const think = k.streams.find((s) => s.think === true)
    expect(think?.state).toBe('end')
    expect(think?.stdout).toBe('思考前半')
  })

  it('终答 runId 幂等不重复记档（回放与事件路径合流）', () => {
    const k = useKernelStore()
    k.onEvent({ type: 'v1.message.agent', seq: 1, at: 1000, payload: { messageId: 'm1', agentId: 'a1', text: '终答', runId: 'run-x' } as never })
    k.onEvent({ type: 'v1.message.agent', seq: 2, at: 1100, payload: { messageId: 'm2', agentId: 'a1', text: '终答2', runId: 'run-x' } as never })
    expect(k.finalizedRunIds.filter((r) => r === 'run-x')).toHaveLength(1)
  })

  it('群终答同构：成员群轮 run 封存 + 记档（块在私聊视图按 isGroupRun 过滤，封存是状态一致性）', () => {
    const k = useKernelStore()
    k.streams.push({
      key: 'b1', agentId: 'a1', runId: 'run-g', stream: 'llm', seq: 1, stdout: '群轮思考', stderr: '', state: 'live', at: Date.now(), think: true,
    })
    k.onEvent({ type: 'v1.group.message', seq: 1, at: 1000, payload: { kind: 'agent', messageId: 'gm1', from: 'a1', groupId: 'g1', text: '群终答', runId: 'run-g' } as never })
    expect(k.finalizedRunIds).toContain('run-g')
    expect(k.streams.find((s) => s.runId === 'run-g')?.state).toBe('end')
  })

  it('lifecycle.finished：llm+exec 全部 live 块封存 + 记档（无终答的失败轮是其呈现停摆的唯一入口）', () => {
    const k = useKernelStore()
    k.streams.push(
      { key: 'f1', agentId: 'a1', runId: 'run-f', stream: 'llm', seq: 1, stdout: '失败前的交代', stderr: '', state: 'live', at: Date.now() },
      { key: 'f2', agentId: 'a1', runId: 'run-f', stream: 'exec', seq: 1, command: ['ls'], boxId: 'b1', stdout: 'out', stderr: '', state: 'live', at: Date.now() },
    )
    k.onEvent({ type: 'v1.lifecycle.finished', seq: 2, at: 2000, payload: { runId: 'run-f', agentId: 'a1', state: 'failed', attempts: 1 } as never })
    expect(k.finalizedRunIds).toContain('run-f')
    expect(k.streams.filter((s) => s.runId === 'run-f').every((s) => s.state === 'end')).toBe(true)
    // 失败轮正文留存为「最后事实」（封存≠删除）；晚到 exec 增量归档续写 end 块（内容补全）
    k.onStreamChunk({ agentId: 'a1', runId: 'run-f', stream: 'llm', seq: 1 }, { t: '余波' })
    k.onStreamChunk({ agentId: 'a1', runId: 'run-f', stream: 'exec', seq: 1 }, { t: '慢放输出' })
    k.flushStreamBuffers()
    expect(k.streams.find((s) => s.runId === 'run-f' && s.think !== true)?.stdout).toBe('失败前的交代余波')
    expect(k.streams.find((s) => s.runId === 'run-f' && s.stream === 'exec')?.stdout).toBe('out慢放输出')
    expect(k.streams.filter((s) => s.runId === 'run-f').every((s) => s.state === 'end')).toBe(true) // 补全不复活 live
  })

  it('escaped 转后台非终态：不封不记档（run 仍在跑，如实保留实况）', () => {
    const k = useKernelStore()
    k.streams.push({
      key: 'e1', agentId: 'a1', runId: 'run-e', stream: 'llm', seq: 1, stdout: '转后台仍在想', stderr: '', state: 'live', at: Date.now(), think: true,
    })
    k.onEvent({ type: 'v1.lifecycle.escaped', seq: 1, at: 1000, payload: { runId: 'run-e', agentId: 'a1', graceMs: 300_000 } as never })
    expect(k.finalizedRunIds).not.toContain('run-e')
    expect(k.streams.find((s) => s.runId === 'run-e')?.state).toBe('live')
  })

  it('会话清空：streams 与合帧缓冲一并作废——残留增量不得在其后的 flush 重建块复活', () => {
    const k = useKernelStore()
    // live 思考块在场 + 缓冲里还有未 flush 增量——/clear 落边界
    k.onStreamOpen({ agentId: 'a1', runId: 'r0', stream: 'llm', seq: 1, round: 1 })
    k.onStreamChunk({ agentId: 'a1', runId: 'r0', stream: 'llm', seq: 1 }, { t: '已建块的', th: true })
    k.flushStreamBuffers()
    k.streams[0]!.at -= 1_000 // 块早于清空边界（同毫秒会让 >= 边界保留——真实时序必有间隔）
    k.onStreamChunk({ agentId: 'a1', runId: 'r0', stream: 'llm', seq: 1 }, { t: '还在缓冲里的', th: true })
    k.onEvent({ type: 'v1.session.cleared', seq: 1, at: Date.now(), payload: { agentId: 'a1', sessionId: 's1' } as never })
    expect(k.streams.filter((s) => s.agentId === 'a1')).toHaveLength(0) // live 块随边界移除
    k.flushStreamBuffers() // 边界后的定时 flush：缓冲残留不得复活
    expect(k.streams.filter((s) => s.agentId === 'a1')).toHaveLength(0)
    // 边界之后**继续到达**的旧 run 思考增量（竞速晚到）同样作废——不建归档块
    k.onStreamChunk({ agentId: 'a1', runId: 'r0', stream: 'llm', seq: 1 }, { t: '清空后才到的', th: true })
    k.flushStreamBuffers()
    expect(k.streams.filter((s) => s.agentId === 'a1')).toHaveLength(0)
  })

  it('无终答的进行中 run 正文照常保留（既有「最后事实」语义不回归）', () => {
    const k = useKernelStore()
    k.onStreamChunk({ agentId: 'a1', runId: 'run-y', stream: 'llm', seq: 1 }, { t: '进行中的正文' })
    k.flushStreamBuffers()
    expect(k.streams.filter((s) => s.runId === 'run-y' && s.think !== true)).toHaveLength(1)
  })
})
