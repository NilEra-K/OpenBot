import { describe, expect, it } from 'vitest'
import { AnthropicProvider, LlmError } from '../src/index.js'
import type { AnthropicConfig, FetchLike } from '../src/index.js'
import type { ChatRequest } from '../src/index.js'

/** 脚本化 fetch（与 openai-compat 测试同构）：捕获请求，返回预设响应或抛错 */
function makeFetch(handler: (url: string, init: Parameters<FetchLike>[1]) => Promise<unknown> | unknown): {
  fetchImpl: FetchLike
  calls: { url: string; init: NonNullable<Parameters<FetchLike>[1]> }[]
} {
  const calls: { url: string; init: NonNullable<Parameters<FetchLike>[1]> }[] = []
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init: init ?? {} })
    const outcome = await handler(url, init)
    if (outcome instanceof Error || outcome instanceof DOMException) throw outcome
    return outcome as Awaited<ReturnType<FetchLike>>
  }
  return { fetchImpl, calls }
}

function jsonRes(payload: unknown, status = 200): Awaited<ReturnType<FetchLike>> {
  return { ok: status >= 200 && status < 300, status, json: async () => payload, text: async () => JSON.stringify(payload) }
}

/** SSE 响应体：事件序列编码为 data: 行流（AsyncIterable 分块推送） */
function sseRes(events: unknown[]): Awaited<ReturnType<FetchLike>> {
  const encoder = new TextEncoder()
  const chunks = events.map((e) => encoder.encode(`event: ${String((e as { type?: string }).type ?? 'x')}\ndata: ${JSON.stringify(e)}\n\n`))
  const body = (async function* (): AsyncGenerator<Uint8Array> {
    for (const c of chunks) yield c
  })()
  return { ok: true, status: 200, json: async () => { throw new Error('流式无 json') }, text: async () => '', body }
}

const config: AnthropicConfig = {
  baseUrl: 'https://api.anthropic.com/v1',
  model: 'claude-sonnet-5',
  apiKey: 'sk-ant-test',
  temperature: 0.3,
}

const req = (messages: ChatRequest['messages'], tools?: ChatRequest['tools']): ChatRequest => ({ messages, tools })

describe('AnthropicProvider 请求映射', () => {
  it('system 顶层、tool_use/tool_result 块、鉴权头、max_tokens、tools 含 input_schema', async () => {
    const { fetchImpl, calls } = makeFetch(() =>
      jsonRes({ content: [{ type: 'text', text: '好的' }] }),
    )
    const provider = new AnthropicProvider({ config, fetchImpl })
    const response = await provider.chat({
      ...req([
        { role: 'user', content: '你好' },
        { role: 'assistant', content: '我先看一下', toolCalls: [{ id: 'c1', name: 'exec', args: { command: ['ls'] } }] },
        { role: 'tool', content: 'exit=0', toolCallId: 'c1' },
      ], [
        { name: 'exec', description: '沙箱执行', argsSchema: { type: 'object' } },
      ]),
      system: '你是管家',
    })
    expect(response.text).toBe('好的')
    expect(response.toolCalls).toEqual([])
    expect(response.meta?.model).toBe('claude-sonnet-5')

    expect(calls.length).toBe(1)
    const { url, init } = calls[0]!
    expect(url).toBe('https://api.anthropic.com/v1/messages')
    expect(init.headers?.['x-api-key']).toBe('sk-ant-test')
    expect(init.headers?.['anthropic-version']).toBe('2023-06-01')
    const body = JSON.parse(init.body ?? '{}') as Record<string, unknown>
    expect(body['model']).toBe('claude-sonnet-5')
    expect(body['max_tokens']).toBe(8192)
    expect(body['stream']).toBe(false)
    expect(body['temperature']).toBe(0.3)
    expect(body['system']).toBe('你是管家') // 顶层字段，不进 messages
    const messages = body['messages'] as Array<{ role: string; content: unknown }>
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']) // tool 回喂映射为 user
    const blocks = messages[1]!.content as Array<Record<string, unknown>>
    expect(blocks).toEqual([
      { type: 'text', text: '我先看一下' },
      { type: 'tool_use', id: 'c1', name: 'exec', input: { command: ['ls'] } },
    ])
    expect(messages[2]!.content).toEqual([{ type: 'tool_result', tool_use_id: 'c1', content: 'exit=0' }])
    expect(body['tools']).toEqual([
      { name: 'exec', description: '沙箱执行', input_schema: { type: 'object' } },
    ])
  })

  it('端点容错：不带 /v1 的官方默认形态补 /v1/messages；尾斜杠容忍', async () => {
    const { fetchImpl, calls } = makeFetch(() => jsonRes({ content: [{ type: 'text', text: 'x' }] }))
    const provider = new AnthropicProvider({ config: { ...config, baseUrl: 'https://api.anthropic.com/' }, fetchImpl })
    await provider.chat(req([{ role: 'user', content: 'hi' }]))
    expect(calls[0]!.url).toBe('https://api.anthropic.com/v1/messages')
  })

  it('maxTokens 可配置；apiKey 为空时不发 x-api-key', async () => {
    const { fetchImpl, calls } = makeFetch(() => jsonRes({ content: [{ type: 'text', text: 'x' }] }))
    const provider = new AnthropicProvider({
      config: { ...config, apiKey: undefined, maxTokens: 1024 },
      fetchImpl,
    })
    await provider.chat(req([{ role: 'user', content: 'hi' }]))
    expect(calls[0]!.init.headers?.['x-api-key']).toBeUndefined()
    expect((JSON.parse(calls[0]!.init.body ?? '{}') as { max_tokens: number }).max_tokens).toBe(1024)
  })
})

describe('AnthropicProvider 响应解析', () => {
  it('content 块：多 text 块拼接 + tool_use 提取（input 已是对象）', async () => {
    const { fetchImpl } = makeFetch(() =>
      jsonRes({
        content: [
          { type: 'text', text: '先说' },
          { type: 'text', text: '两句' },
          { type: 'tool_use', id: 't1', name: 'host_fetch', input: { url: 'https://x/' } },
        ],
      }),
    )
    const provider = new AnthropicProvider({ config, fetchImpl })
    const response = await provider.chat(req([{ role: 'user', content: '抓网页' }]))
    expect(response.text).toBe('先说两句')
    expect(response.toolCalls).toEqual([{ id: 't1', name: 'host_fetch', args: { url: 'https://x/' } }])
  })

  it('HTTP 状态映射 LLM_HTTP_<n>（回退端点判定的事实源）', async () => {
    const { fetchImpl } = makeFetch(() => jsonRes({ error: { message: 'overloaded' } }, 529))
    const provider = new AnthropicProvider({ config, fetchImpl })
    await expect(provider.chat(req([{ role: 'user', content: 'hi' }]))).rejects.toMatchObject({
      code: 'LLM_HTTP_529',
    })
  })
})

describe('AnthropicProvider 流式（messages API SSE）', () => {
  it('text_delta → onText 增量；input_json_delta 拼接 tool_use；message_stop 终态聚合', async () => {
    const { fetchImpl } = makeFetch(() =>
      sseRes([
        { type: 'message_start', message: { role: 'assistant' } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '我来' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '执行' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 't9', name: 'exec' } },
        { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"command":["l' } },
        { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: 's"]}' } },
        { type: 'content_block_stop', index: 1 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
        { type: 'message_stop' },
      ]),
    )
    const provider = new AnthropicProvider({ config, fetchImpl })
    const deltas: string[] = []
    const response = await provider.chat({
      ...req([{ role: 'user', content: '列目录' }]),
      onText: (d) => deltas.push(d),
    })
    expect(deltas).toEqual(['我来', '执行'])
    expect(response.text).toBe('我来执行')
    expect(response.toolCalls).toEqual([{ id: 't9', name: 'exec', args: { command: ['ls'] } }])
  })

  it('流意外结束（无 message_stop）→ LLM_RESPONSE_INVALID', async () => {
    const encoder = new TextEncoder()
    const body = (async function* (): AsyncGenerator<Uint8Array> {
      yield encoder.encode(`data: ${JSON.stringify({ type: 'message_start' })}\n\n`)
    })()
    const { fetchImpl } = makeFetch(() => ({
      ok: true, status: 200, json: async () => { throw new Error('x') }, text: async () => '', body,
    }))
    const provider = new AnthropicProvider({ config, fetchImpl })
    await expect(
      provider.chat({ ...req([{ role: 'user', content: 'hi' }]), onText: () => {} }),
    ).rejects.toMatchObject({ code: 'LLM_RESPONSE_INVALID' })
  })

  it('坏 partial_json 不炸请求：__raw 原样交工具层回喂纠错', async () => {
    const { fetchImpl } = makeFetch(() =>
      sseRes([
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'exec' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{oops' } },
        { type: 'message_stop' },
      ]),
    )
    const provider = new AnthropicProvider({ config, fetchImpl })
    const response = await provider.chat({ ...req([{ role: 'user', content: 'hi' }]), onText: () => {} })
    expect(response.toolCalls[0]!.args).toEqual({ __raw: '{oops' })
  })
})

describe('AnthropicProvider 中止', () => {
  it('请求前已中止 → LLM_ABORTED（不发起 fetch）', async () => {
    const { fetchImpl, calls } = makeFetch(() => jsonRes({ content: [] }))
    const provider = new AnthropicProvider({ config, fetchImpl })
    const controller = new AbortController()
    controller.abort()
    await expect(provider.chat(req([{ role: 'user', content: 'hi' }]), controller.signal)).rejects.toMatchObject({
      code: 'LLM_ABORTED',
    })
    expect(calls.length).toBe(0)
  })
})

// LlmError 仅引用防 tree-shake 误删断言（风格对齐 openai-compat 测试）
void LlmError
