// 示例插件 · 最小可抄模板（docs/plan-plugins.md §3）——单文件 MCP server（stdio）。
// 两个工具：
//   hello  { name?: string }          → 回问候语（纯拉模型）
//   notify { text: string }           → 发一条上行事件（openbot/event）再返回确认（推模型演示）
// 照抄改：复制本目录 → 改 manifest 的 id/name/entry → 改这里的工具与事件 → 放进市场或本地目录。
// MCP 握手只实现最小面（initialize/tools/list/tools/call）——零依赖纯 Node。
import { createInterface } from 'node:readline'

const TOOLS = [
  {
    name: 'hello',
    description: '回一声问候（示例插件的演示工具）',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: '要问候的名字（可选）' } },
      additionalProperties: false,
    },
  },
  {
    name: 'notify',
    description: '发送一条上行事件（推模型演示：事件经内核路由为用户通知/唤醒绑定 Agent）',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: '事件文本' } },
      required: ['text'],
      additionalProperties: false,
    },
  },
]

const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`)

const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const t = line.trim()
  if (t === '') return
  let msg
  try {
    msg = JSON.parse(t)
  } catch {
    return
  }
  const { id, method, params } = msg
  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'hello-events', version: '0.1.0' },
      },
    })
    return
  }
  if (method === 'notifications/initialized') return
  // P2② hooks 下行演示：内核把白名单事件（本插件声明订阅 v1.message.agent）转发到这——
  // 插件响应式反应（此处回声一条上行事件；实际插件可做归档/外部联动等）
  if (method === 'openbot/hook') {
    if (params?.event === 'v1.message.agent') {
      send({ jsonrpc: '2.0', method: 'openbot/event', params: { type: 'hello.saw-reply', payload: { text: '插件看到 Agent 回复了' } } })
    }
    return
  }
  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } })
    return
  }
  if (method === 'tools/call') {
    const name = params?.name
    const args = params?.arguments ?? {}
    if (name === 'hello') {
      send({
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: `你好，${args.name ?? 'OpenBot'}！——来自示例插件 hello-events` }] },
      })
      return
    }
    if (name === 'notify') {
      // 推模型：上行事件（notification openbot/event）→ 内核 v1.plugin.event → 路由
      send({ jsonrpc: '2.0', method: 'openbot/event', params: { type: 'hello.fired', payload: { text: String(args.text ?? '') } } })
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `事件已发送：${String(args.text ?? '')}` }] } })
      return
    }
    send({ jsonrpc: '2.0', id, error: { code: -32602, message: `未知工具：${name}` } })
  }
})
