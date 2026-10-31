import { describe, expect, it } from 'vitest'
import { InMemoryFs, TranscriptStore } from '@openbot/state'
import { MockChatProvider } from '@openbot/llm'
import type { MockStep } from '@openbot/llm'
import { compactSession } from '../src/compact.js'

const makeTranscript = (): { transcript: TranscriptStore; fs: InMemoryFs } => {
  const fs = new InMemoryFs()
  const transcript = new TranscriptStore({ fs, root: 'data', now: () => 1000 })
  return { transcript, fs }
}

describe('会话压缩器（会话引擎 v2 · P2）', () => {
  it('会话不足保留轮数 → 诚实跳过（null，不落记录）', async () => {
    const { transcript } = makeTranscript()
    await transcript.append('a1', 'user', { messageId: 'm1', text: 'hi' })
    await transcript.append('a1', 'agent', { messageId: 'm2', text: '好' })
    const r = await compactSession(
      { transcript, llmOf: () => new MockChatProvider({ steps: [] }), nextRunId: () => 'r1' },
      'a1',
      'a1',
      { trigger: 'manual' },
    )
    expect(r).toBeNull()
    expect((await transcript.readAll('a1')).some((x) => x.kind === 'compact')).toBe(false)
  })

  it('正常压缩：早期轮摘要化落 compact 记录（coveredSeq/keptRounds/trigger 溯源）', async () => {
    const { transcript } = makeTranscript()
    // 8 轮对话（保留 6 → 压前 2 轮）
    for (let i = 1; i <= 8; i++) {
      await transcript.append('a1', 'user', { messageId: `u${i}`, text: `问题${i}` })
      await transcript.append('a1', 'agent', { messageId: `a${i}`, text: `回答${i}` })
    }
    const llm = new MockChatProvider({ steps: [{ text: '## 决定与约定\n- 采用了方案 A' }] as readonly MockStep[] })
    const r = await compactSession(
      { transcript, llmOf: () => llm, nextRunId: () => 'r9' },
      'a1',
      'a1',
      { trigger: 'manual', focus: '保留方案取舍' },
    )
    expect(r).not.toBeNull()
    expect(r!.summary).toContain('方案 A')
    const records = await transcript.readAll('a1')
    const compact = records.find((x) => x.kind === 'compact')
    expect(compact).toBeDefined()
    expect((compact!.payload as { coveredSeq: number }).coveredSeq).toBe(r!.coveredSeq)
    expect((compact!.payload as { trigger: string }).trigger).toBe('manual')
    expect((compact!.payload as { focus: string }).focus).toBe('保留方案取舍')
    // 摘要请求的输入含被压轮文本与焦点
    expect(llm.requests[0]!.messages[1]!.content).toContain('问题1')
    expect(llm.requests[0]!.messages[1]!.content).toContain('保留方案取舍')
  })
})
