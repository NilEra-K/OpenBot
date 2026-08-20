import { describe, expect, it } from 'vitest'
import { LlmError, OpenAiCompatProvider } from '../src/index.js'
import type { FetchLike, OpenAiCompatConfig } from '../src/index.js'
import type { ChatRequest } from '../src/index.js'

/** 脚本化 fetch：捕获请求，返回预设响应或抛错 */
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

const config: OpenAiCompatConfig = {
  baseUrl: 'https://api.deepseek.com/v1',
  model: 'deepseek-chat',
  apiKey: 'sk-test',
  temperature: 0.3,
}

const req = (messages: ChatRequest['messages'], tools?: ChatRequest['tools']): ChatRequest => ({ messages, tools })

describe('OpenAiCompatProvider 请求映射', () => {
  it('system 前置、消息顺序、鉴权头、model/stream/temperature、tools 含 parameters', async () => {
    const { fetchImpl, calls } = makeFetch(() =>
      jsonRes({ choices: [{ message: { content: '好的' } }] }),
    )
    const provider = new OpenAiCompatProvider({ config, fetchImpl })
    const response = await provider.chat(
      req([
        { role: 'user', content: '你好' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'exec', args: { command: ['ls'] } }] },
        { role: 'tool', content: 'exit=0', toolCallId: 'c1' },
      ], [
        { name: 'exec', description: '沙箱执行', argsSchema: { type: 'object' } },
      ]),
    )
    expect(response.text).toBe('好的')
    expect(response.toolCalls).toEqual([])
    expect(response.meta?.model).toBe('deepseek-chat')

    expect(calls.length).toBe(1)
    const { url, init } = calls[0]!
    expect(url).toBe('https://api.deepseek.com/v1/chat/completions')
    expect(init.headers?.['Authorization']).toBe('Bearer sk-test')
    const body = JSON.parse(init.body ?? '{}') as Record<string, unknown>
    expect(body['model']).toBe('deepseek-chat')
    expect(body['stream']).toBe(false)
    expect(body['temperature']).toBe(0.3)
    const messages = body['messages'] as Array<Record<string, unknown>>
    expect(messages.map((m) => m['role'])).toEqual(['user', 'assistant', 'tool'])
    const assistant = messages[1]!
    expect(assistant['tool_calls']).toEqual([
      { id: 'c1', type: 'function', function: { name: 'exec', arguments: '{"command":["ls"]}' } },
    ])
    expect(messages[2]!['tool_call_id']).toBe('c1')
    expect(body['tools']).toEqual([
      { type: 'function', function: { name: 'exec', description: '沙箱执行', parameters: { type: 'object' } } },
    ])
  })

  it('request.system 前置为 system 消息；baseUrl 尾斜杠容忍', async () => {
    const { fetchImpl, calls } = makeFetch(() => jsonRes({ choices: [{ message: { content: 'x' } }] }))
    const provider = new OpenAiCompatProvider({
      config: { ...config, baseUrl: 'https://api.openai.com/v1/' },
      fetchImpl,
    })
    await provider.chat({ ...req([{ role: 'user', content: 'hi' }]), system: '你是管家' })
    const body = JSON.parse(calls[0]!.init.body ?? '{}') as { messages: Array<{ role: string; content: string }> }
    expect(body.messages[0]).toEqual({ role: 'system', content: '你是管家' })
  })

  it('apiKey 为空时不发 Authorization（本地 Ollama/vLLM 场景）', async () => {
    const { fetchImpl, calls } = makeFetch(() => jsonRes({ choices: [{ message: { content: 'x' } }] }))
    const provider = new OpenAiCompatProvider({ config: { ...config, apiKey: undefined }, fetchImpl })
    await provider.chat(req([{ role: 'user', content: 'hi' }]))
    expect(calls[0]!.init.headers?.['Authorization']).toBeUndefined()
  })
})

describe('OpenAiCompatProvider 响应解析', () => {
  it('tool_calls 的 arguments JSON 串解析为对象', async () => {
    const { fetchImpl } = makeFetch(() =>
      jsonRes({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                { id: 'call_1', type: 'function', function: { name: 'send_message', arguments: '{"toAgentId":"a2","text":"收到"}' } },
              ],
            },
          },
        ],
      }),
    )
    const provider = new OpenAiCompatProvider({ config, fetchImpl })
    const response = await provider.chat(req([{ role: 'user', content: '转告 a2' }]))
    expect(response.text).toBeNull()
    expect(response.toolCalls).toEqual([
      { id: 'call_1', name: 'send_message', args: { toAgentId: 'a2', text: '收到' } },
    ])
  })

  it('坏 JSON 的 arguments 不炸请求：保留原文交工具层回喂纠错', async () => {
    const { fetchImpl } = makeFetch(() =>
      jsonRes({
        choices: [{ message: { content: null, tool_calls: [{ id: 'c', type: 'function', function: { name: 'exec', arguments: '{oops' } }] } }],
      }),
    )
    const provider = new OpenAiCompatProvider({ config, fetchImpl })
    const response = await provider.chat(req([{ role: 'user', content: 'x' }]))
    expect(response.toolCalls[0]?.args).toEqual({ __raw: '{oops' })
  })

  it('缺 choices / 响应非 JSON：LLM_RESPONSE_INVALID', async () => {
    const p1 = new OpenAiCompatProvider({
      config,
      fetchImpl: (() => jsonRes({ error: 'nope' })) as FetchLike,
    })
    await expect(p1.chat(req([{ role: 'user', content: 'x' }]))).rejects.toMatchObject({
      code: 'LLM_RESPONSE_INVALID',
    })
    const p2 = new OpenAiCompatProvider({
      config,
      fetchImpl: (() => ({ ok: true, status: 200, json: async () => { throw new Error('not json') }, text: async () => 'oops' })) as unknown as FetchLike,
    })
    await expect(p2.chat(req([{ role: 'user', content: 'x' }]))).rejects.toMatchObject({
      code: 'LLM_RESPONSE_INVALID',
    })
  })
})

describe('OpenAiCompatProvider 错误映射', () => {
  it('HTTP 非 2xx：code 为 LLM_HTTP_<status>，message 截断携带响应体', async () => {
    const { fetchImpl } = makeFetch(() => jsonRes({ error: { message: 'rate limited' } }, 429))
    const provider = new OpenAiCompatProvider({ config, fetchImpl })
    await expect(provider.chat(req([{ role: 'user', content: 'x' }]))).rejects.toMatchObject({
      code: 'LLM_HTTP_429',
      name: 'LlmError',
    })
  })

  it('网络层异常：LLM_REQUEST_FAILED', async () => {
    const { fetchImpl } = makeFetch(() => new Error('fetch failed'))
    const provider = new OpenAiCompatProvider({ config, fetchImpl })
    await expect(provider.chat(req([{ role: 'user', content: 'x' }]))).rejects.toMatchObject({
      code: 'LLM_REQUEST_FAILED',
    })
  })

  it('超时（TimeoutError）：LLM_TIMEOUT', async () => {
    const { fetchImpl } = makeFetch(() => new DOMException('signal timed out', 'TimeoutError'))
    const provider = new OpenAiCompatProvider({ config, fetchImpl })
    const err = await provider.chat(req([{ role: 'user', content: 'x' }])).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LlmError)
    expect((err as LlmError).code).toBe('LLM_TIMEOUT')
  })

  it('signal 预先中止：LLM_ABORTED 且不发请求', async () => {
    const { fetchImpl, calls } = makeFetch(() => jsonRes({ choices: [{ message: { content: 'x' } }] }))
    const provider = new OpenAiCompatProvider({ config, fetchImpl })
    const controller = new AbortController()
    controller.abort()
    await expect(provider.chat(req([{ role: 'user', content: 'x' }]), controller.signal)).rejects.toMatchObject({
      code: 'LLM_ABORTED',
    })
    expect(calls.length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 流式（onText → stream:true SSE）——与 backend-mock/procexec 同一「流是实况、聚合是事实」契约
// ---------------------------------------------------------------------------

/** SSE 响应：chunks 逐块产出（跨块边界由测试自行切，验证行缓冲）；注入式异步迭代器 body */
function sseRes(chunks: string[]): Awaited<ReturnType<FetchLike>> {
  return {
    ok: true,
    status: 200,
    json: async () => {
      throw new Error('流式路径不应走 json()')
    },
    text: async () => chunks.join(''),
    body: (async function* () {
      const encoder = new TextEncoder()
      for (const c of chunks) yield encoder.encode(c)
    })(),
  }
}

/** SSE data 行事件 */
const ev = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
const delta = (d: Record<string, unknown>): unknown => ({ choices: [{ delta: d }] })

describe('OpenAiCompatProvider 流式（onText）', () => {
  it('stream:true + 文本增量逐块回调 + 聚合终态；data 行跨 chunk 边界收敛', async () => {
    // 故意把第二条 data 行切开跨三个 chunk（多字节中文 + 换行分离）
    const { fetchImpl, calls } = makeFetch(() =>
      sseRes([
        ev(delta({ role: 'assistant' })),
        'data: {"choices":[{"del',
        'ta":{"content":"你好"}}]}',
        '\n\n',
        ev(delta({ content: '!' })),
        'data: [DONE]\n\n',
      ]),
    )
    const provider = new OpenAiCompatProvider({ config, fetchImpl })
    const deltas: string[] = []
    const response = await provider.chat(
      { messages: [{ role: 'user', content: 'hi' }], onText: (t) => deltas.push(t) },
    )
    expect(deltas).toEqual(['你好', '!'])
    expect(response.text).toBe('你好!')
    expect(response.toolCalls).toEqual([])
    // 流式开关：请求体 stream 必须为 true
    const body = JSON.parse(calls[0]!.init.body ?? '{}') as Record<string, unknown>
    expect(body['stream']).toBe(true)
  })

  it('tool_calls 增量拼装（index 归位、arguments 逐块拼接、[DONE] 后聚合）', async () => {
    const { fetchImpl } = makeFetch(() =>
      sseRes([
        ev(delta({ tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'exec', arguments: '{"command":' } }] })),
        ev(delta({ tool_calls: [{ index: 0, function: { arguments: '["ls"]}' } }] })),
        'data: [DONE]\n\n',
      ]),
    )
    const provider = new OpenAiCompatProvider({ config, fetchImpl })
    const deltas: string[] = []
    const response = await provider.chat(
      { messages: [{ role: 'user', content: '列目录' }], onText: (t) => deltas.push(t) },
    )
    expect(deltas).toEqual([]) // 纯工具调用回合零文本增量
    expect(response.text).toBeNull()
    expect(response.toolCalls).toEqual([{ id: 'c1', name: 'exec', args: { command: ['ls'] } }])
  })

  it('流意外结束（无 [DONE]）：LLM_RESPONSE_INVALID', async () => {
    const { fetchImpl } = makeFetch(() => sseRes([ev(delta({ content: '半' }))]))
    const provider = new OpenAiCompatProvider({ config, fetchImpl })
    await expect(
      provider.chat({ messages: [{ role: 'user', content: 'x' }], onText: () => {} }),
    ).rejects.toMatchObject({ code: 'LLM_RESPONSE_INVALID' })
  })

  it('流式响应缺 body：LLM_RESPONSE_INVALID', async () => {
    const { fetchImpl } = makeFetch(() => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' }))
    const provider = new OpenAiCompatProvider({ config, fetchImpl })
    await expect(
      provider.chat({ messages: [{ role: 'user', content: 'x' }], onText: () => {} }),
    ).rejects.toMatchObject({ code: 'LLM_RESPONSE_INVALID' })
  })

  it('无 onText 仍走非流式 json 路径（stream:false 不变）', async () => {
    const { fetchImpl, calls } = makeFetch(() =>
      jsonRes({ choices: [{ message: { content: '聚合' } }] }),
    )
    const provider = new OpenAiCompatProvider({ config, fetchImpl })
    const response = await provider.chat(req([{ role: 'user', content: 'x' }]))
    expect(response.text).toBe('聚合')
    const body = JSON.parse(calls[0]!.init.body ?? '{}') as Record<string, unknown>
    expect(body['stream']).toBe(false)
  })
})
