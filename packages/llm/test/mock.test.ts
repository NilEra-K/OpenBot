import { describe, expect, it } from 'vitest'
import { LlmError, MockChatProvider } from '../src/index.js'
import type { ChatRequest } from '../src/index.js'

const req = (text: string): ChatRequest => ({ messages: [{ role: 'user', content: text }] })

describe('MockChatProvider', () => {
  it('脚本顺序消费：text/toolCalls 按步返回，requests 记录请求', async () => {
    const provider = new MockChatProvider({
      steps: [
        { text: '我来跑一下', toolCalls: [{ id: 'c1', name: 'exec', args: { command: ['ls'] } }] },
        { toolCalls: [{ id: 'c2', name: 'send_message', args: { to: 'a2' } }] },
        { text: '完成了' },
      ],
    })
    const r1 = await provider.chat(req('跑个任务'))
    expect(r1.text).toBe('我来跑一下')
    expect(r1.toolCalls).toEqual([{ id: 'c1', name: 'exec', args: { command: ['ls'] } }])
    const r2 = await provider.chat(req('继续'))
    expect(r2.text).toBeNull()
    expect(r2.toolCalls[0]?.name).toBe('send_message')
    const r3 = await provider.chat(req('好了吗'))
    expect(r3.text).toBe('完成了')
    expect(r3.toolCalls).toEqual([])
    expect(provider.requests.map((r) => r.messages[0]?.content)).toEqual(['跑个任务', '继续', '好了吗'])
    expect(provider.consumed).toBe(3)
    expect(r1.meta?.model).toBe('mock-1')
  })

  it('脚本耗尽：显式 LLM_MOCK_SCRIPT_EXHAUSTED，绝不悄悄兜底', async () => {
    const provider = new MockChatProvider({ steps: [{ text: '只有一步' }] })
    await provider.chat(req('q1'))
    await expect(provider.chat(req('q2'))).rejects.toMatchObject({
      code: 'LLM_MOCK_SCRIPT_EXHAUSTED',
      name: 'LlmError',
    })
  })

  it('signal 已中止：LLM_ABORTED 且不消耗脚本', async () => {
    const provider = new MockChatProvider({ steps: [{ text: 'x' }] })
    const controller = new AbortController()
    controller.abort()
    await expect(provider.chat(req('q'), controller.signal)).rejects.toMatchObject({
      code: 'LLM_ABORTED',
    })
    expect(provider.consumed).toBe(0)
    expect(provider.requests.length).toBe(0)
  })

  it('确定性：同脚本两个实例，同请求序列产出同响应', async () => {
    const steps = [{ text: 'a' }, { toolCalls: [{ id: 't', name: 'exec', args: null }] }]
    const p1 = new MockChatProvider({ steps })
    const p2 = new MockChatProvider({ steps })
    const out1 = await Promise.all([p1.chat(req('q')), p1.chat(req('q'))])
    const out2 = await Promise.all([p2.chat(req('q')), p2.chat(req('q'))])
    expect(out1).toEqual(out2)
  })

  it('LlmError 是 Error 子类且携带稳定 code', () => {
    const err = new LlmError('LLM_X', '诊断')
    expect(err instanceof Error).toBe(true)
    expect(err.code).toBe('LLM_X')
    expect(err.message).toBe('诊断')
  })
})
