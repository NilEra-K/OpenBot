/**
 * WS /stream 流客户端（renderer 内存版）：手写 14 字节帧头解码（一期只收——
 * OPEN/DATA/END/ABORT；PAUSE/RESUME/ACK 背压信号随后续需要）。
 * 与 lib/gateway.ts 同一哲学：零内核 import（transport 包带 node 依赖进不了 renderer），
 * 帧格式与 packages/transport stream-protocol 双向对照（编译期无法锁，改协议须两侧同步）。
 *
 * 实况语义：断线自动重连，但**不补历史**（hub 只把新流发给已连接会话）——
 * 聚合事实走 SSE 事件流，这里丢的只是实况。
 */

/** 帧类型（与 transport FrameType 对应；这里只声明会收到的四种） */
const FRAME_OPEN = 0x01
const FRAME_DATA = 0x02
const FRAME_END = 0x03
const FRAME_ABORT = 0x04

const HEADER_BYTES = 14

/** OPEN 负载 JSON（hub 侧约定：kind:'frames' 的 run 实况流；kind:'pty' 的交互会话流） */
export interface RunStreamOpenMeta {
  kind: 'frames' | 'pty'
  meta?: {
    agentId: string
    runId: string
    stream: 'llm' | 'exec'
    seq: number
    /** exec 流：命令与所属 Box（操作台按 Box 过滤的依据） */
    command?: string[]
    boxId?: string
    /** llm 流：轮次序号 */
    round?: number
    /** pty 流：会话标识（kind:'pty' 时存在；键入走命令面 shellWrite） */
    shellId?: string
  }
}

/** DATA 负载 JSON（hub 侧 StreamChunkPayload） */
export interface RunStreamChunk {
  t: string
  ch?: 'stdout' | 'stderr'
}

export interface StreamClientHandlers {
  onOpen: (meta: RunStreamOpenMeta['meta']) => void
  onChunk: (meta: { agentId: string; runId: string; stream: 'llm' | 'exec' }, chunk: RunStreamChunk) => void
  onEnd: (meta: { agentId: string; runId: string; stream: 'llm' | 'exec' }, reason?: string) => void
  /** pty 流（可选）：会话开流（pty 流的 meta 只有 shellId/boxId，无 agentId/runId） */
  onPtyOpen?: (meta: { shellId: string; boxId: string }) => void
  onPtyData?: (meta: { shellId: string; boxId: string }, text: string) => void
  onPtyEnd?: (meta: { shellId: string; boxId: string }) => void
}

export interface StreamClient {
  close(): void
  readonly connected: boolean
}

interface StreamRecord {
  agentId: string
  runId: string
  stream: 'llm' | 'exec'
}

/** pty 流归属（OPEN 登记，END 除名） */
interface PtyRecord {
  shellId: string
  boxId: string
}

/** 连接 WS /stream：断线自动重连（3s 退避）；返回关闭句柄 */
export function connectRunStreams(
  endpoint: { port: number; token: string },
  handlers: StreamClientHandlers,
): StreamClient {
  let closed = false
  let socket: WebSocket | null = null
  /** streamId → 归属（OPEN 登记，END/ABORT 除名）；run 流与 pty 流分表 */
  const streams = new Map<number, StreamRecord>()
  const ptys = new Map<number, PtyRecord>()

  const connect = (): void => {
    if (closed) return
    socket = new WebSocket(`ws://127.0.0.1:${endpoint.port}/stream?token=${endpoint.token}`)
    socket.binaryType = 'arraybuffer'
    socket.onmessage = (message) => {
      const data = new Uint8Array(message.data as ArrayBuffer)
      const record = decodeFrame(data)
      if (!record) {
        socket?.close() // 坏帧/版本不符：断开走重连自愈
        return
      }
      handle(record)
    }
    socket.onclose = () => {
      streams.clear()
      ptys.clear()
      if (!closed) setTimeout(connect, 3_000)
    }
  }

  const handle = (frame: { type: number; streamId: number; payload: Uint8Array }): void => {
    if (frame.type === FRAME_OPEN) {
      const meta = parseJson(frame.payload) as RunStreamOpenMeta
      const m = meta?.meta
      if (meta?.kind === 'pty' && m && typeof m.shellId === 'string' && typeof m.boxId === 'string') {
        ptys.set(frame.streamId, { shellId: m.shellId, boxId: m.boxId })
        handlers.onPtyOpen?.({ shellId: m.shellId, boxId: m.boxId })
        return
      }
      if (m && typeof m.agentId === 'string' && typeof m.runId === 'string' && (m.stream === 'llm' || m.stream === 'exec')) {
        streams.set(frame.streamId, { agentId: m.agentId, runId: m.runId, stream: m.stream })
        handlers.onOpen(m)
      }
      return
    }
    const pty = ptys.get(frame.streamId)
    if (pty) {
      if (frame.type === FRAME_DATA) {
        const chunk = parseJson(frame.payload) as RunStreamChunk | null
        if (chunk && typeof chunk.t === 'string') handlers.onPtyData?.(pty, chunk.t)
        return
      }
      if (frame.type === FRAME_END || frame.type === FRAME_ABORT) {
        ptys.delete(frame.streamId)
        handlers.onPtyEnd?.(pty)
      }
      return
    }
    const record = streams.get(frame.streamId)
    if (!record) return
    if (frame.type === FRAME_DATA) {
      const chunk = parseJson(frame.payload) as RunStreamChunk | null
      if (chunk && typeof chunk.t === 'string') handlers.onChunk(record, chunk)
      return
    }
    if (frame.type === FRAME_END) {
      streams.delete(frame.streamId)
      handlers.onEnd(record)
      return
    }
    if (frame.type === FRAME_ABORT) {
      streams.delete(frame.streamId)
      const body = frame.payload.byteLength > 0 ? (parseJson(frame.payload) as { reason?: string } | null) : null
      handlers.onEnd(record, body?.reason)
    }
  }

  connect()

  return {
    close() {
      closed = true
      socket?.close()
    },
    get connected() {
      return socket?.readyState === WebSocket.OPEN
    },
  }
}

/** 14 字节帧头解码（big-endian）；不合法返回 null */
function decodeFrame(data: Uint8Array): { type: number; streamId: number; payload: Uint8Array } | null {
  if (data.byteLength < HEADER_BYTES) return null
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  if (view.getUint8(0) !== 1) return null // 协议版本
  const type = view.getUint8(1)
  const streamId = view.getUint32(2)
  view.getUint32(6) // seq：接收端不校验（内核侧 hub 已保证发送连续；renderer 信任环回）
  const length = view.getUint32(10)
  if (data.byteLength - HEADER_BYTES !== length) return null
  return { type, streamId, payload: data.slice(HEADER_BYTES) }
}

function parseJson(payload: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(payload))
  } catch {
    return null
  }
}
