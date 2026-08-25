/**
 * Anthropic provider（messages API）：fetch 零 SDK 薄客户端（ARCHITECTURE.md §3.3；P4 Step 11）。
 * 与 openai-compat 同一 ChatProvider 接口、同一 fetch 注入位——测试喂脚本化 fetch，确定性断言请求体与错误映射。
 * wire 要点：x-api-key + anthropic-version 头；max_tokens 必填；system 是顶层字段（不进 messages）；
 * 工具调用走 content blocks（assistant 的 tool_use / user 的 tool_result）；
 * 流式 SSE 事件 content_block_delta（text_delta / input_json_delta），message_stop 终态。
 * 自定义 base_url + 代理是国内刚需（与 openai-compat 同理）。
 */
import { LlmError, LlmErrorCodes } from '../provider/index.js'
import type { ChatProvider, ChatRequest, ChatResponse, ToolCall, ToolSpec } from '../provider/index.js'
import { proxyDispatcher } from '../openai-compat/index.js'
import type { FetchLike } from '../openai-compat/index.js'

export interface AnthropicConfig {
  /** 服务前缀；带 /v1（如 https://api.anthropic.com/v1）→ /messages，不带（官方默认）→ 补 /v1/messages */
  baseUrl: string
  model: string
  apiKey?: string
  /** 额外请求头（中转站自定义鉴权等） */
  headers?: Record<string, string>
  /** 请求超时 ms，默认 120_000 */
  timeoutMs?: number
  temperature?: number
  /** HTTP(S) 代理地址——国内走中转的常态 */
  proxyUrl?: string
  /** messages API 必填 max_tokens；缺省 8192（ChatRequest 无此概念，取宽松默认） */
  maxTokens?: number
}

export interface AnthropicProviderOptions {
  config: AnthropicConfig
  /** 注入式 fetch（测试）；缺省用全局 fetch */
  fetchImpl?: FetchLike
}

// ---- wire 类型（messages API，只声明用到的字段） ----

interface WireBlock {
  type: 'text' | 'tool_use' | 'tool_result'
  [key: string]: unknown
}

interface WireMessage {
  role: 'user' | 'assistant'
  content: string | WireBlock[]
}

const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_MAX_TOKENS = 8192
const ANTHROPIC_VERSION = '2023-06-01'

export class AnthropicProvider implements ChatProvider {
  readonly #config: AnthropicConfig
  readonly #fetchImpl: FetchLike

  constructor(options: AnthropicProviderOptions) {
    this.#config = options.config
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
    const system = systemOf(request)
    const body: Record<string, unknown> = {
      model: config.model,
      max_tokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
      messages,
      stream: streaming,
    }
    if (system !== null) body['system'] = system
    if (request.tools && request.tools.length > 0) body['tools'] = toWireTools(request.tools)
    if (config.temperature !== undefined) body['temperature'] = config.temperature

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'anthropic-version': ANTHROPIC_VERSION,
      ...(config.apiKey ? { 'x-api-key': config.apiKey } : {}),
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
      // HTTP_<status> 为动态稳定 code：429/5xx 等由上层按 code 分策略（回退端点据此判定）
      throw new LlmError(`LLM_HTTP_${response.status}`, `HTTP ${response.status}: ${text.slice(0, 500)}`)
    }

    if (!streaming) {
      let payload: unknown
      try {
        payload = await response.json()
      } catch (err) {
        throw new LlmError(LlmErrorCodes.LLM_RESPONSE_INVALID, `响应不是 JSON：${String(err)}`)
      }
      return parseMessage(payload, config.model)
    }

    // 流式路径：SSE 事件流（onText 逐块回调），聚合终态语义与非流式一致
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

/** 端点拼接：baseUrl 填到 /v1 为止（中转站习惯）→ +/messages；不带 /v1（官方 SDK 默认形态）→ 补 /v1/messages */
function endpointOf(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '')
  return trimmed.endsWith('/v1') ? `${trimmed}/messages` : `${trimmed}/v1/messages`
}

/** 顶层 system：request.system 与 messages 里混入的 system 段并置（messages API 的 system 不进消息序列） */
function systemOf(request: ChatRequest): string | null {
  const parts: string[] = []
  if (request.system && request.system !== '') parts.push(request.system)
  for (const message of request.messages) {
    if (message.role === 'system' && message.content !== '') parts.push(message.content)
  }
  return parts.length > 0 ? parts.join('\n\n') : null
}

/** ChatRequest → wire messages：assistant 工具调用 = content blocks（text + tool_use）；
 *  tool 回喂 = user 消息里的 tool_result 块（messages API 无独立 tool 角色） */
function toWireMessages(request: ChatRequest): WireMessage[] {
  const out: WireMessage[] = []
  for (const message of request.messages) {
    if (message.role === 'system') continue // 已并入顶层 system
    if (message.role === 'assistant' && message.toolCalls && message.toolCalls.length > 0) {
      const blocks: WireBlock[] = []
      if (message.content !== '') blocks.push({ type: 'text', text: message.content })
      for (const call of message.toolCalls) {
        blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.args ?? {} })
      }
      out.push({ role: 'assistant', content: blocks })
    } else if (message.role === 'tool') {
      out.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: message.toolCallId ?? '', content: message.content }],
      })
    } else {
      out.push({ role: message.role === 'assistant' ? 'assistant' : 'user', content: message.content })
    }
  }
  return out
}

function toWireTools(tools: ToolSpec[]): unknown[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    // input_schema 必填：无约束工具给空 object 形状（与 openai-compat 省略 parameters 的语义对齐）
    input_schema: tool.argsSchema ?? { type: 'object' as const },
  }))
}

/** 非流式响应解析：content 块数组 → text（text 块拼接）/ toolCalls（tool_use 块） */
function parseMessage(payload: unknown, model: string): ChatResponse {
  const record = recordOf(payload)
  const content = record?.['content']
  if (!Array.isArray(content)) {
    throw new LlmError(LlmErrorCodes.LLM_RESPONSE_INVALID, '响应缺少 content 块')
  }
  let text = ''
  const toolCalls: ToolCall[] = []
  for (const block of content) {
    const b = recordOf(block)
    if (!b) continue
    if (b['type'] === 'text' && typeof b['text'] === 'string') {
      text += b['text']
    } else if (b['type'] === 'tool_use' && typeof b['id'] === 'string' && typeof b['name'] === 'string') {
      toolCalls.push({ id: b['id'], name: b['name'], args: b['input'] ?? {} })
    }
  }
  return { text: text === '' ? null : text, toolCalls, meta: { model } }
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
// SSE 事件流解析（messages API stream:true 面）：
// content_block_start（tool_use 起块）/ content_block_delta（text_delta、input_json_delta）→ message_stop 终态
// ---------------------------------------------------------------------------

/** tool_use 增量累积槽（按 content_block 的 index 归位；id/name 起块给出，input 逐块 partial_json 拼接） */
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
    // SSE 行协议：事件以 \n 分行（\r\n 容错）；只认 data: 行（event: 行信息量已在 data.type 里）
    let nl = buffer.indexOf('\n')
    while (nl >= 0) {
      const line = buffer.slice(0, nl).replace(/\r$/, '')
      buffer = buffer.slice(nl + 1)
      nl = buffer.indexOf('\n')
      if (!line.startsWith('data:')) continue
      const data = line.slice('data:'.length).trimStart()
      let parsed: unknown
      try {
        parsed = JSON.parse(data)
      } catch (err) {
        throw new LlmError(LlmErrorCodes.LLM_RESPONSE_INVALID, `SSE 数据块不是 JSON：${String(err)}`)
      }
      const record = recordOf(parsed)
      const type = record?.['type']
      if (type === 'message_stop') {
        const toolCalls = [...toolAcc.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([, acc]) => ({ id: acc.id, name: acc.name, args: parseArgsLoose(acc.args) }))
        return { text: text === '' ? null : text, toolCalls, meta: { model } }
      }
      if (type === 'error') {
        const message = recordOf(record?.['error'])?.['message']
        throw new LlmError(LlmErrorCodes.LLM_RESPONSE_INVALID, `流中错误事件：${String(message ?? '未知')}`)
      }
      if (type === 'content_block_start') {
        const block = recordOf(record?.['content_block'])
        if (block?.['type'] === 'tool_use' && typeof record?.['index'] === 'number') {
          toolAcc.set(record['index'] as number, {
            id: typeof block['id'] === 'string' ? block['id'] : '',
            name: typeof block['name'] === 'string' ? block['name'] : '',
            args: '',
          })
        }
      } else if (type === 'content_block_delta') {
        const index = record?.['index']
        const delta = recordOf(record?.['delta'])
        if (delta?.['type'] === 'text_delta' && typeof delta['text'] === 'string' && delta['text'] !== '') {
          text += delta['text']
          onText(delta['text'])
        } else if (
          delta?.['type'] === 'input_json_delta' &&
          typeof delta['partial_json'] === 'string' &&
          typeof index === 'number'
        ) {
          const acc = toolAcc.get(index)
          if (acc) acc.args += delta['partial_json']
        }
      }
      // message_start / content_block_stop / message_delta / ping：与聚合无关，跳过
    }
  }
  throw new LlmError(LlmErrorCodes.LLM_RESPONSE_INVALID, 'SSE 流意外结束（未收到 message_stop）')
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

/** 模型输出的 input 是逐块 partial_json 拼成的 JSON 字符串；坏 JSON 不炸请求，原样交给工具层回喂纠错 */
function parseArgsLoose(rawArgs: string): unknown {
  if (rawArgs === '') return {}
  try {
    return JSON.parse(rawArgs) as unknown
  } catch {
    return { __raw: rawArgs }
  }
}
