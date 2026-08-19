/**
 * E2E 用的 openai-compat mock 端点：随机端口本地 HTTP server，零内核改动——
 * renderer 经 settings 表单配置为 provider，真实覆盖 openai-compat 客户端的 fetch 路径。
 * 分派按请求 messages 特征（而非全局序号）：A2A 后 steward 与 worker 并行请求，
 * 「最后一条消息的 role/内容 + 最近工具名」是身份的稳定判据，天然无竞态。
 */
import { createServer } from 'node:http'

/** 剧本步：匹配条件 + 返回的 assistant 消息 */
interface ScriptStep {
  /** 消息历史判据：last=最后一条消息；lastToolName=最近一次 assistant 工具调用的名字（无则 null） */
  match: (last: { role: string; content: string }, lastToolName: string | null) => boolean
  toolCalls?: Array<{ id: string; name: string; args: Record<string, unknown> }>
  text?: string
}

export interface MockOpenAi {
  port: number
  /** 收到的请求体留痕（断言「内核让 LLM 说了什么」） */
  requests: Array<{ model: string; messages: unknown[] }>
  close(): Promise<void>
}

interface WireMessage {
  role: string
  content: string
  tool_calls?: Array<{ function: { name: string } }>
}

export async function startMockOpenAi(steps: ScriptStep[]): Promise<MockOpenAi> {
  const requests: Array<{ model: string; messages: unknown[] }> = []
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
      const body = JSON.parse(raw || '{}') as { model?: string; messages?: WireMessage[] }
      const messages = body.messages ?? []
      requests.push({ model: body.model ?? '', messages })

      const last = messages[messages.length - 1] ?? { role: '', content: '' }
      const lastAssistantWithCalls = [...messages].reverse().find((m) => m.tool_calls?.length)
      const lastToolName = lastAssistantWithCalls?.tool_calls?.[0]?.function.name ?? null
      const step = steps.find((s) => s.match(last, lastToolName))
      if (!step) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: `mock 剧本无匹配步：last.role=${last.role} lastTool=${lastToolName}` }))
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
      responseSeq += 1
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          id: `mock-${responseSeq}`,
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
