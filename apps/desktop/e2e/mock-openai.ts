/**
 * E2E 用的 openai-compat mock 端点：随机端口本地 HTTP server，零内核改动——
 * renderer 经 settings 表单配置为 provider，真实覆盖 openai-compat 客户端的 fetch 路径。
 * 分派按请求 messages 特征（而非全局序号）：A2A 后 steward 与 worker 并行请求，
 * 「最后一条消息的 role/内容 + 最近工具名」是身份的稳定判据，天然无竞态。
 * 流式对称：请求体 stream:true 时按 SSE 返回（P3 Step 7 起 runner 恒带 onText → 恒 stream:true），
 * tool_calls 的 arguments 分两块下发（覆盖增量拼装路径），text 按 3 字符拆块。
 */
import { createServer } from 'node:http'

/** 剧本步：匹配条件 + 返回的 assistant 消息 */
interface ScriptStep {
  /** 消息历史判据：last=最后一条消息；lastToolName=最近一次 assistant 工具调用的名字（无则 null） */
  match: (last: { role: string; content: string }, lastToolName: string | null) => boolean
  toolCalls?: Array<{ id: string; name: string; args: Record<string, unknown> }>
  text?: string
  /** 思考增量（v0.1.43 双通道 E2E）：SSE 走 reasoning_content（先思考后正文——渲染层断言思考卡与正文预览各自落位） */
  reasoning?: string
  /** 响应延迟毫秒（P5 Step 4：制造慢响应——群 supersede 等时序场景；流式与 JSON 同效） */
  delayMs?: number
}

export interface MockOpenAi {
  port: number
  /** 收到的请求体留痕（断言「内核让 LLM 说了什么」；title=true 为会话标题请求——
   *  计数/取末条断言须按需过滤） */
  requests: Array<{ model: string; stream?: boolean; messages: unknown[]; title?: boolean }>
  close(): Promise<void>
}

interface WireMessage {
  role: string
  content: string
  tool_calls?: Array<{ function: { name: string } }>
}

function normalizeContent(c: unknown): string {
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return c.map((p) => (typeof p === 'object' && p !== null && (p as { text?: unknown }).text !== undefined ? String((p as { text?: string }).text) : '')).join('')
  return ''
}

export async function startMockOpenAi(steps: ScriptStep[]): Promise<MockOpenAi> {
  const requests: MockOpenAi['requests'] = []
  let responseSeq = 0

  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', () => {
      if (req.method !== 'POST' || !req.url?.includes('/chat/completions')) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'mock 只实现 POST /chat/completions' }))
        return
      }
      const body = JSON.parse(raw || '{}') as {
        model?: string
        stream?: boolean
        messages?: WireMessage[]
      }
      const messages = body.messages ?? []

      // 会话标题请求（2026-10-18 内核 sessionTitles）：哨兵 system 识别——内置应答**不消费剧本步**
      // （标题请求的 last 也是 user 消息，宽松剧本规则会被误吃；非流式——标题调用不带 onText）
      if (messages.some((m) => m.role === 'system' && m.content.startsWith('你是会话标题生成器'))) {
        requests.push({ model: body.model ?? '', stream: body.stream, messages, title: true })
        responseSeq += 1
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            id: `mock-title-${responseSeq}`,
            choices: [{ index: 0, message: { role: 'assistant', content: 'E2E会话标题' }, finish_reason: 'stop' }],
            usage: {},
          }),
        )
        return
      }
      requests.push({ model: body.model ?? '', stream: body.stream, messages })

      const last = messages[messages.length - 1] ?? { role: '', content: '' }
      const lastAssistantWithCalls = [...messages].reverse().find((m) => m.tool_calls?.length)
      const lastToolName = lastAssistantWithCalls?.tool_calls?.[0]?.function.name ?? null
      // match 收到的 content 归一（v0.1.102 图片附件）：ContentPart 数组 → 拼 text 段——
      // 既有剧本匹配零感知（requests 留痕仍存原始形态，image_url 断言用原体）
      const step = steps.find((s) => s.match({ role: last.role, content: normalizeContent(last.content) }, lastToolName))
      if (!step) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: `mock 剧本无匹配步：last.role=${last.role} lastTool=${lastToolName}` }))
        return
      }

      responseSeq += 1
      ;(res as unknown as { __mockStream?: boolean }).__mockStream = body.stream === true
      // 慢响应（delayMs）：延迟到达后照常应答——请求留痕不延迟（时序断言仍可对账）
      if (step.delayMs !== undefined && step.delayMs > 0) {
        setTimeout(() => respond(res, step, responseSeq), step.delayMs)
        return
      }
      respond(res, step, responseSeq)
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  return {
    port,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

/** 响应分发：按请求体 stream 与否走 SSE / JSON（delayMs 场景经 setTimeout 延迟调用） */
function respond(res: import('node:http').ServerResponse, step: ScriptStep, seq: number): void {
  // socket 已断（客户端放弃等待）时写出会抛——静默吞掉，测试按事件面断言
  res.on('error', () => {})
  if (isStreamRequest(res)) {
    respondSse(res, step, seq)
    return
  }
  const message: Record<string, unknown> = { role: 'assistant' }
  if (step.toolCalls?.length) {
    message['tool_calls'] = step.toolCalls.map((c) => ({
      id: c.id,
      type: 'function',
      function: { name: c.name, arguments: JSON.stringify(c.args) },
    }))
  } else {
    message['content'] = step.text ?? ''
  }
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(
    JSON.stringify({
      id: `mock-${seq}`,
      choices: [
        {
          index: 0,
          message,
          finish_reason: step.toolCalls?.length ? 'tool_calls' : 'stop',
        },
      ],
      usage: {},
    }),
  )
}

/** stream 判据经 query 传递（handler 匹配处把 body.stream 挂到 res 上——闭包参数最小化） */
function isStreamRequest(res: import('node:http').ServerResponse): boolean {
  return (res as unknown as { __mockStream?: boolean }).__mockStream === true
}

/** SSE 流式响应（chat completions stream 面；与 openai-compat consumeSse 双向对照） */
function respondSse(res: import('node:http').ServerResponse, step: ScriptStep, seq: number): void {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
  const sse = (obj: unknown): void => {
    res.write(`data: ${JSON.stringify(obj)}\n\n`)
  }
  sse({ id: `mock-${seq}`, choices: [{ index: 0, delta: { role: 'assistant' } }] })
  if (step.toolCalls?.length) {
    // arguments 分两块：覆盖客户端的增量拼装路径
    for (const call of step.toolCalls) {
      const args = JSON.stringify(call.args)
      const half = Math.ceil(args.length / 2)
      sse({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, id: call.id, type: 'function', function: { name: call.name, arguments: args.slice(0, half) } }],
            },
          },
        ],
      })
      sse({
        choices: [
          { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(half) } }] } },
        ],
      })
    }
  } else {
    if (step.reasoning !== undefined) {
      for (let i = 0; i < step.reasoning.length; i += 4) {
        sse({ choices: [{ index: 0, delta: { reasoning_content: step.reasoning.slice(i, i + 4) } }] })
      }
    }
    if (step.text !== undefined) {
      for (let i = 0; i < step.text.length; i += 3) {
        sse({ choices: [{ index: 0, delta: { content: step.text.slice(i, i + 3) } }] })
      }
    }
  }
  res.write('data: [DONE]\n\n')
  res.end()
}
