/**
 * openai-compatible provider：fetch 零 SDK 薄客户端（ARCHITECTURE.md §3.3）。
 * 覆盖 OpenAI / DeepSeek / 豆包 / Moonshot / GLM / Grok / Ollama / vLLM 的 chat completions 兼容面。
 * P2 先行非流式（stream:false）；SSE 流式随后续增强，编解码分层已预留。
 * 自定义 base_url 是国内刚需；代理走 undici ProxyAgent（仅 proxyUrl 配置时启用）。
 * fetch 注入式：测试喂脚本化 fetch，确定性断言请求体与错误映射。
 */
import { LlmError, LlmErrorCodes } from '../provider/index.js'
import type { ChatMessage, ChatProvider, ChatRequest, ChatResponse, ToolCall, ToolSpec } from '../provider/index.js'

export interface OpenAiCompatConfig {
  /** 服务前缀（如 https://api.deepseek.com/v1）；端点 = <baseUrl>/chat/completions */
  baseUrl: string
  model: string
  /** 本地推理（Ollama/vLLM）可空 */
  apiKey?: string
  /** 额外请求头（中转站自定义鉴权等） */
  headers?: Record<string, string>
  /** 请求超时 ms，默认 120_000 */
  timeoutMs?: number
  /** 可选透传参数 */
  temperature?: number
  /** HTTP(S) 代理地址（如 http://127.0.0.1:7890）——国内走中转的常态 */
  proxyUrl?: string
}

export type FetchLike = (input: string, init?: {
  method?: string
  headers?: Record<string, string>
  body?: string
  signal?: AbortSignal
  dispatcher?: unknown
}) => Promise<{
  ok: boolean
  status: number
  json: () => Promise<unknown>
  text: () => Promise<string>
  /** 流式响应体（stream:true 时使用）；测试注入异步迭代器（真实 fetch 是 web ReadableStream） */
  body?: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>
}>

export interface OpenAiCompatProviderOptions {
  config: OpenAiCompatConfig
  /** 注入式 fetch（测试）；缺省用全局 fetch */
  fetchImpl?: FetchLike
  /** 能力声明（P8-4 后 UI 优化） */
  capabilities?: ProviderCapabilities
}

import type { ProviderCapabilities } from '../provider/index.js'

// ---- wire 类型（chat completions 兼容面，只声明用到的字段） ----

interface WireToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

interface WireMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>
  tool_calls?: WireToolCall[]
  tool_call_id?: string
}

/** content 规范形 → wire（plan-computer-use Step 2）：纯文本直传零开销；分段数组按
 *  openai-compat 视觉惯例编 image_url data URI（GLM-4V / Qwen-VL / Ollama 视觉模型同构） */
function toWireContent(content: ChatMessage['content']): WireMessage['content'] {
  if (typeof content === 'string') return content
  return content.map((part) =>
    part.type === 'text'
      ? { type: 'text' as const, text: part.text ?? '' }
      : {
          type: 'image_url' as const,
          image_url: { url: `data:${part.image?.mime ?? 'image/png'};base64,${part.image?.base64 ?? ''}` },
        },
  )
}

const DEFAULT_TIMEOUT_MS = 120_000

export class OpenAiCompatProvider implements ChatProvider {
  readonly capabilities: ProviderCapabilities
  readonly #config: OpenAiCompatConfig
  readonly #fetchImpl: FetchLike

  constructor(options: OpenAiCompatProviderOptions) {
    this.#config = options.config
    this.capabilities = options.capabilities ?? {}
    this.#fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike)
  }

  async chat(request: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
    if (signal?.aborted) {
      throw new LlmError(LlmErrorCodes.LLM_ABORTED, '请求前已被中止')
    }
    const config = this.#config
    const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
    // 合并调用方 signal 与超时：任一触发即断流（Node ≥20.3 支持 AbortSignal.any）
    const timeoutSignal = AbortSignal.timeout(timeoutMs)
    const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal

    const streaming = request.onText !== undefined
    const messages = toWireMessages(request)
    const body: Record<string, unknown> = {
      model: config.model,
      messages,
      stream: streaming,
    }
    if (request.tools && request.tools.length > 0) body['tools'] = toWireTools(request.tools)
    if (config.temperature !== undefined) body['temperature'] = config.temperature

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
      ...config.headers,
    }

    let response: Awaited<ReturnType<FetchLike>>
    try {
      response = await this.#fetchImpl(endpointOf(config.baseUrl), {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: combined,
        ...(config.proxyUrl ? { dispatcher: await proxyDispatcher(config.proxyUrl) } : {}),
      })
    } catch (err) {
      if (signal?.aborted) {
        throw new LlmError(LlmErrorCodes.LLM_ABORTED, '请求已被调用方中止')
      }
      if (isTimeoutError(err)) {
        throw new LlmError(LlmErrorCodes.LLM_TIMEOUT, `请求超时（${timeoutMs}ms）`)
      }
      throw new LlmError(
        LlmErrorCodes.LLM_REQUEST_FAILED,
        err instanceof Error ? err.message : String(err),
      )
    }

    if (!response.ok) {
      const text = await safeText(response)
      // HTTP_<status> 为动态稳定 code：429/5xx 等由上层按 code 分策略
      throw new LlmError(`LLM_HTTP_${response.status}`, `HTTP ${response.status}: ${text.slice(0, 500)}`)
    }

    if (!streaming) {
      let payload: unknown
      try {
        payload = await response.json()
      } catch (err) {
        throw new LlmError(LlmErrorCodes.LLM_RESPONSE_INVALID, `响应不是 JSON：${String(err)}`)
      }
      return parseCompletion(payload, config.model)
    }

    // 流式路径：SSE 增量解析（onText 逐块回调），聚合终态语义与非流式一致
    if (!response.body) {
      throw new LlmError(LlmErrorCodes.LLM_RESPONSE_INVALID, '流式响应缺少 body')
    }
    try {
      return await consumeSse(response.body, request.onText!, config.model, combined)
    } catch (err) {
      if (err instanceof LlmError) throw err
      if (signal?.aborted) {
        throw new LlmError(LlmErrorCodes.LLM_ABORTED, '流式请求已被调用方中止')
      }
      if (isTimeoutError(err)) {
        throw new LlmError(LlmErrorCodes.LLM_TIMEOUT, `请求超时（${timeoutMs}ms）`)
      }
      throw new LlmError(
        LlmErrorCodes.LLM_REQUEST_FAILED,
        err instanceof Error ? err.message : String(err),
      )
    }
  }
}

/** 端点拼接：容忍 baseUrl 尾部斜杠 */
function endpointOf(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/chat/completions`
}

/** ChatRequest → wire messages（system 字段前置；assistant 工具调用与 tool 回喂逐条映射） */
function toWireMessages(request: ChatRequest): WireMessage[] {
  const out: WireMessage[] = []
  if (request.system) out.push({ role: 'system', content: request.system })
  for (const message of request.messages) {
    if (message.role === 'assistant' && message.toolCalls && message.toolCalls.length > 0) {
      out.push({
        role: 'assistant',
        content: toWireContent(message.content),
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: 'function' as const,
          function: { name: call.name, arguments: JSON.stringify(call.args ?? null) },
        })),
      })
    } else if (message.role === 'tool') {
      out.push({ role: 'tool', content: toWireContent(message.content), tool_call_id: message.toolCallId ?? '' })
    } else {
      out.push({ role: message.role, content: toWireContent(message.content) })
    }
  }
  return out
}

function toWireTools(tools: ToolSpec[]): unknown[] {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      ...(tool.argsSchema !== undefined ? { parameters: tool.argsSchema } : {}),
    },
  }))
}

/** 响应解析：choices[0].message → ChatResponse；arguments JSON 串解析失败保留原文（回喂自纠错） */
function parseCompletion(payload: unknown, model: string): ChatResponse {  const choices = recordOf(payload)?.['choices']
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new LlmError(LlmErrorCodes.LLM_RESPONSE_INVALID, '响应缺少 choices')
  }
  const message = recordOf(choices[0])?.['message']
  const messageRecord = recordOf(message)
  if (!messageRecord) {
    throw new LlmError(LlmErrorCodes.LLM_RESPONSE_INVALID, '响应缺少 message')
  }
  const content = messageRecord['content']
  const text = typeof content === 'string' ? content : null
  const rawCalls = messageRecord['tool_calls']
  const toolCalls: ToolCall[] = []
  if (Array.isArray(rawCalls)) {
    for (const raw of rawCalls) {
      const call = recordOf(raw)
      const function_ = recordOf(call?.['function'])
      const name = function_?.['name']
      const rawArgs = function_?.['arguments']
      if (typeof call?.['id'] !== 'string' || typeof name !== 'string') {
        throw new LlmError(LlmErrorCodes.LLM_RESPONSE_INVALID, 'tool_calls 结构非法')
      }
      toolCalls.push({ id: call['id'], name, args: parseArgsLoose(rawArgs) })
    }
  }
  return { text, toolCalls, meta: { model } }
}

/** 模型输出的 arguments 是 JSON 字符串；坏 JSON 不炸请求，原样交给工具层回喂纠错 */
function parseArgsLoose(rawArgs: unknown): unknown {
  if (typeof rawArgs !== 'string') return rawArgs ?? null
  try {
    return JSON.parse(rawArgs) as unknown
  } catch {
    return { __raw: rawArgs }
  }
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

async function safeText(response: { text: () => Promise<string> }): Promise<string> {
  try {
    return await response.text()
  } catch {
    return ''
  }
}

function isTimeoutError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { name?: string }).name === 'TimeoutError'
  )
}

// ---------------------------------------------------------------------------
// SSE 流式解析（chat completions stream:true 面）：文本增量走 onText，聚合终态语义与非流式一致
// ---------------------------------------------------------------------------

/** tool_calls 增量累积槽（按 delta.tool_calls[].index 归位；id/name 首块给出，arguments 字符串逐块拼接） */
interface ToolCallAcc {
  id: string
  name: string
  args: string
}

async function consumeSse(
  body: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>,
  onText: (delta: string) => void,
  model: string,
  signal: AbortSignal,
): Promise<ChatResponse> {
  const decoder = new TextDecoder()
  let buffer = ''
  let text = ''
  const toolAcc = new Map<number, ToolCallAcc>()

  for await (const chunk of iterateBody(body)) {
    if (signal.aborted) {
      throw new LlmError(LlmErrorCodes.LLM_ABORTED, '流式请求已被中止')
    }
    buffer += decoder.decode(chunk, { stream: true })
    // SSE 行协议：事件以 \n 分行（\r\n 容错）；只认 data: 行
    let nl = buffer.indexOf('\n')
    while (nl >= 0) {
      const line = buffer.slice(0, nl).replace(/\r$/, '')
      buffer = buffer.slice(nl + 1)
      nl = buffer.indexOf('\n')
      if (!line.startsWith('data:')) continue
      const data = line.slice('data:'.length).trimStart()
      if (data === '[DONE]') {
        const toolCalls = [...toolAcc.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([, acc]) => ({ id: acc.id, name: acc.name, args: parseArgsLoose(acc.args) }))
        return { text: text === '' ? null : text, toolCalls, meta: { model } }
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(data)
      } catch (err) {
        throw new LlmError(LlmErrorCodes.LLM_RESPONSE_INVALID, `SSE 数据块不是 JSON：${String(err)}`)
      }
      const choices = recordOf(parsed)?.['choices']
      const delta = Array.isArray(choices) && choices.length > 0
        ? recordOf(recordOf(choices[0])?.['delta'])
        : null
      if (!delta) continue // usage/role 等无 delta 的块直接跳过
      const content = delta['content']
      if (typeof content === 'string' && content !== '') {
        text += content
        onText(content)
      }
      const rawCalls = delta['tool_calls']
      if (Array.isArray(rawCalls)) {
        for (const raw of rawCalls) {
          const call = recordOf(raw)
          const fn = recordOf(call?.['function'])
          if (!call) continue
          const index = typeof call['index'] === 'number' ? call['index'] : 0
          const acc = toolAcc.get(index) ?? { id: '', name: '', args: '' }
          if (typeof call['id'] === 'string' && call['id'] !== '') acc.id = call['id']
          if (typeof fn?.['name'] === 'string' && fn['name'] !== '') acc.name = fn['name']
          if (typeof fn?.['arguments'] === 'string') acc.args += fn['arguments']
          toolAcc.set(index, acc)
        }
      }
    }
  }
  throw new LlmError(LlmErrorCodes.LLM_RESPONSE_INVALID, 'SSE 流意外结束（未收到 [DONE]）')
}

/** 响应体归一迭代：web ReadableStream 或注入的 AsyncIterable（测试） */
async function* iterateBody(
  body: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  if (Symbol.asyncIterator in body) {
    yield* body
    return
  }
  const reader = (body as ReadableStream<Uint8Array>).getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return
    if (value) yield value
  }
}

/** 代理 dispatcher：仅 proxyUrl 配置时按需加载（undici 为 llm 唯一运行时依赖，纯 JS 无编译）；
 *  导出供 anthropic provider 共用（同一注入位与缓存——同代理不重复建连） */
const dispatcherCache = new Map<string, unknown>()
export async function proxyDispatcher(proxyUrl: string): Promise<unknown> {
  const cached = dispatcherCache.get(proxyUrl)
  if (cached !== undefined) return cached
  const { ProxyAgent } = await import('undici')
  const dispatcher = new ProxyAgent(proxyUrl)
  dispatcherCache.set(proxyUrl, dispatcher)
  return dispatcher
}
