/**
 * WS /stream 数据面帧协议（v1）：二进制帧 + 多路复用 + 背压（ARCHITECTURE.md §5 三通道之数据面）。
 * P2 范围裁定：只定帧协议 + 回环自测；真实 Box 实况帧等 P3 有信号源再启用。
 *
 * 帧模型：一个 WS binary message = 一个完整协议帧（WS 自带消息边界，无 TCP 粘包问题）。
 * 帧头 14 字节（全部 big-endian）：
 *   u8 版本(=1) | u8 帧类型 | u32 流 ID | u32 帧序号 | u32 负载长度
 *
 * 帧类型与序号语义：
 *   OPEN/DATA/END/ABORT 是流内帧——seq 在流内从 0（OPEN）起连续递增，接收方校验连续性；
 *   ACK/PAUSE/RESUME 是对向带外信号——seq 字段另作他用（ACK 承载确认值）或填 0，不参与连续性校验。
 * 流 ID：连接内单调分配、不复用；0 保留给连接级控制（PAUSE/RESUME 可用 0 表示全流暂停）。
 */
import { KernelError } from '@openbot/core'

export const STREAM_PROTOCOL_VERSION = 1
export const STREAM_HEADER_BYTES = 14
/** 单个 DATA 帧的负载上限——大文件由发送方切分（回环与 P3 文件传输共用） */
export const MAX_STREAM_CHUNK_BYTES = 256 * 1024

export const FrameType = {
  /** 打开流；负载 JSON：{ kind: 'frames' | 'file', boxId?: string, meta?: unknown } */
  OPEN: 0x01,
  /** 数据块（≤ MAX_STREAM_CHUNK_BYTES） */
  DATA: 0x02,
  /** 流正常结束 */
  END: 0x03,
  /** 异常中止；负载 JSON：{ reason?: string } */
  ABORT: 0x04,
  /** 接收方→发送方：暂停指定流（streamId=0 表示全流） */
  PAUSE: 0x05,
  /** 接收方→发送方：恢复 */
  RESUME: 0x06,
  /** 接收方→发送方：确认；seq 字段 = 已连续收到的最高帧序号，无负载 */
  ACK: 0x07,
} as const
export type FrameType = (typeof FrameType)[keyof typeof FrameType]

export const StreamErrorCodes = {
  STREAM_BAD_FRAME: 'STREAM_BAD_FRAME',
  STREAM_PROTOCOL_VIOLATION: 'STREAM_PROTOCOL_VIOLATION',
} as const

/** OPEN 负载的 JSON 结构（kind:'pty' 是交互会话流——键入走命令面，输出走此流） */
export interface StreamOpenMeta {
  kind: 'frames' | 'file' | 'pty'
  boxId?: string
  meta?: unknown
}

export interface StreamFrame {
  type: FrameType
  streamId: number
  seq: number
  payload: Uint8Array
}

function assertFrameType(value: number): FrameType {
  const known = Object.values(FrameType) as readonly number[]
  if (!known.includes(value)) {
    throw new KernelError(StreamErrorCodes.STREAM_BAD_FRAME, `未知帧类型：0x${value.toString(16)}`)
  }
  return value as FrameType
}

export function encodeFrame(frame: StreamFrame): Uint8Array {
  const buf = new Uint8Array(STREAM_HEADER_BYTES + frame.payload.byteLength)
  const view = new DataView(buf.buffer)
  view.setUint8(0, STREAM_PROTOCOL_VERSION)
  view.setUint8(1, frame.type)
  view.setUint32(2, frame.streamId)
  view.setUint32(6, frame.seq)
  view.setUint32(10, frame.payload.byteLength)
  buf.set(frame.payload, STREAM_HEADER_BYTES)
  return buf
}

export function decodeFrame(data: Uint8Array): StreamFrame {
  if (data.byteLength < STREAM_HEADER_BYTES) {
    throw new KernelError(StreamErrorCodes.STREAM_BAD_FRAME, `帧短于帧头：${data.byteLength} < ${STREAM_HEADER_BYTES}`)
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const version = view.getUint8(0)
  if (version !== STREAM_PROTOCOL_VERSION) {
    throw new KernelError(StreamErrorCodes.STREAM_BAD_FRAME, `协议版本不符：${version}`)
  }
  const type = assertFrameType(view.getUint8(1))
  const streamId = view.getUint32(2)
  const seq = view.getUint32(6)
  const payloadLength = view.getUint32(10)
  if (data.byteLength - STREAM_HEADER_BYTES !== payloadLength) {
    throw new KernelError(
      StreamErrorCodes.STREAM_BAD_FRAME,
      `负载长度不符：声明 ${payloadLength}，实际 ${data.byteLength - STREAM_HEADER_BYTES}`,
    )
  }
  const payload = data.slice(STREAM_HEADER_BYTES)
  return { type, streamId, seq, payload }
}

// ---------------------------------------------------------------------------
// 连接会话：同一类在两端使用（发送方 API + 接收方回调 + 对向信号）。传输线注入式（ws/内存管道均可）。
// ---------------------------------------------------------------------------

/** 传输线抽象：发送字节、收字节、关闭、关闭通知 */
export interface StreamWire {
  send(data: Uint8Array): void
  onMessage(cb: (data: Uint8Array) => void): void
  onClose(cb: () => void): void
  close(): void
}

/** flush 队列元素：数据块或「排空后发 END」哨兵 */
type QueueItem = { readonly end: true } | { readonly end: false; readonly chunk: Uint8Array }
const END_OF_STREAM: QueueItem = { end: true }

/** 连接级流表条目（两端各自视角） */
interface StreamEntry {
  state: 'open' | 'ended'
  /** 期望的下一帧序号（发送方=下一个分配值；接收方=下一个校验值） */
  nextSeq: number
  /** 发送方：远端 PAUSE 后暂存的待发项（RESUME 后按序发出） */
  queued: QueueItem[]
  /** 发送方视角：被远端暂停 */
  paused: boolean
  meta?: StreamOpenMeta
}

export interface StreamSessionEvents {
  /** 接收方：新流打开 */
  onOpen?: (streamId: number, meta: StreamOpenMeta) => void
  /** 接收方：数据块（seq 已校验连续） */
  onChunk?: (streamId: number, seq: number, chunk: Uint8Array) => void
  /** 接收方：流正常结束（seq = END 帧序号，即该流最高连续序号） */
  onEnd?: (streamId: number, seq: number) => void
  /** 接收方：流中止（seq = ABORT 帧序号） */
  onAbort?: (streamId: number, seq: number, reason?: string) => void
  /** 发送方：收到 ACK（seq = 对端已连续收到的最高帧序号） */
  onAck?: (streamId: number, seq: number) => void
  /** 发送暂停状态翻转（远端 PAUSE/RESUME；streamId=0 表示连接级） */
  onPauseChanged?: (streamId: number | 0, paused: boolean) => void
  /** 任一协议违规（坏帧/序号跳跃/未知流）——后续处置（断连等）由调用方决定 */
  onViolation?: (code: string, message: string) => void
}

export class StreamSession {
  readonly #wire: StreamWire
  readonly #events: StreamSessionEvents
  readonly #streams = new Map<number, StreamEntry>()
  #nextStreamId = 0
  #closed = false
  /** 连接级（全流）暂停 */
  #allPaused = false

  constructor(wire: StreamWire, events: StreamSessionEvents = {}) {
    this.#wire = wire
    this.#events = events
    wire.onMessage((data) => this.#receive(data))
    wire.onClose(() => {
      this.#closed = true
    })
  }

  get closed(): boolean {
    return this.#closed
  }

  // ---- 发送方 ----

  /** 打开流（返回分配的流 ID；OPEN 的帧序号为 0，DATA 从 1 起连续） */
  openStream(meta: StreamOpenMeta): number {
    this.#assertOpen()
    // u32 正整数空间内单调分配、不复用；连接生命周期内到不了上限
    this.#nextStreamId += 1
    const streamId = this.#nextStreamId
    const entry: StreamEntry = { state: 'open', nextSeq: 0, queued: [], paused: false, meta }
    this.#streams.set(streamId, entry)
    this.#emit({ type: FrameType.OPEN, streamId, seq: entry.nextSeq++, payload: this.#encodeJson(meta) })
    return streamId
  }

  /** 发送数据块；远端 PAUSE 期间入队，RESUME 后按序发出（文件类不可丢，统一缓冲；实况帧丢弃策略归 P3 信号源） */
  sendChunk(streamId: number, chunk: Uint8Array): void {
    const entry = this.#sendable(streamId)
    if (chunk.byteLength > MAX_STREAM_CHUNK_BYTES) {
      throw new KernelError(
        StreamErrorCodes.STREAM_PROTOCOL_VIOLATION,
        `数据块超上限：${chunk.byteLength} > ${MAX_STREAM_CHUNK_BYTES}`,
      )
    }
    entry.queued.push({ end: false, chunk })
    this.#flush(streamId)
  }

  /** 流正常结束（缓冲排空后发出 END） */
  endStream(streamId: number): void {
    const entry = this.#sendable(streamId)
    entry.queued.push(END_OF_STREAM)
    this.#flush(streamId)
  }

  /** 流异常中止（立即发出，不等缓冲排空） */
  abortStream(streamId: number, reason?: string): void {
    const entry = this.#sendable(streamId)
    entry.queued.length = 0
    entry.state = 'ended'
    const payload = reason === undefined ? new Uint8Array(0) : this.#encodeJson({ reason })
    this.#emit({ type: FrameType.ABORT, streamId, seq: entry.nextSeq++, payload })
  }

  /** 发送方视角：指定流（0=全流）是否处于远端暂停 */
  isPaused(streamId: number | 0): boolean {
    if (streamId === 0) return this.#allPaused
    return this.#allPaused || (this.#streams.get(streamId)?.paused ?? false)
  }

  // ---- 接收方主动信号 ----

  /** 暂停对端发送（streamId=0 表示全流） */
  sendPause(streamId: number | 0): void {
    this.#assertOpen()
    this.#emit({ type: FrameType.PAUSE, streamId, seq: 0, payload: new Uint8Array(0) })
  }

  /** 恢复对端发送 */
  sendResume(streamId: number | 0): void {
    this.#assertOpen()
    this.#emit({ type: FrameType.RESUME, streamId, seq: 0, payload: new Uint8Array(0) })
  }

  /** 确认已连续收到的最高帧序号 */
  sendAck(streamId: number, highestSeq: number): void {
    this.#assertOpen()
    this.#emit({ type: FrameType.ACK, streamId, seq: highestSeq, payload: new Uint8Array(0) })
  }

  // ---- 内部 ----

  #flush(streamId: number): void {
    const entry = this.#streams.get(streamId)
    if (!entry) return
    while (entry.queued.length > 0 && !this.isPaused(streamId)) {
      const head = entry.queued.shift()!
      if (head.end) {
        entry.state = 'ended'
        this.#emit({ type: FrameType.END, streamId, seq: entry.nextSeq++, payload: new Uint8Array(0) })
        return
      }
      this.#emit({ type: FrameType.DATA, streamId, seq: entry.nextSeq++, payload: head.chunk })
    }
  }

  #receive(data: Uint8Array): void {
    let frame: StreamFrame
    try {
      frame = decodeFrame(data)
    } catch (err) {
      this.#violation(err)
      return
    }
    try {
      this.#handle(frame)
    } catch (err) {
      this.#violation(err)
    }
  }

  #handle(frame: StreamFrame): void {
    switch (frame.type) {
      case FrameType.OPEN: {
        if (this.#streams.has(frame.streamId)) {
          throw new KernelError(StreamErrorCodes.STREAM_PROTOCOL_VIOLATION, `流 ID 重复：${frame.streamId}`)
        }
        const meta = this.#decodeJson(frame.payload) as StreamOpenMeta
        this.#streams.set(frame.streamId, { state: 'open', nextSeq: 1, queued: [], paused: false, meta })
        this.#events.onOpen?.(frame.streamId, meta)
        return
      }
      case FrameType.DATA: {
        const entry = this.#liveStream(frame.streamId)
        this.#expectSeq(entry, frame.seq)
        this.#events.onChunk?.(frame.streamId, frame.seq, frame.payload)
        return
      }
      case FrameType.END: {
        const entry = this.#liveStream(frame.streamId)
        this.#expectSeq(entry, frame.seq)
        entry.state = 'ended'
        this.#events.onEnd?.(frame.streamId, frame.seq)
        return
      }
      case FrameType.ABORT: {
        const entry = this.#liveStream(frame.streamId)
        this.#expectSeq(entry, frame.seq)
        entry.state = 'ended'
        const body = frame.payload.byteLength > 0 ? (this.#decodeJson(frame.payload) as { reason?: string }) : {}
        this.#events.onAbort?.(frame.streamId, frame.seq, body.reason)
        return
      }
      case FrameType.PAUSE: {
        if (frame.streamId === 0) {
          this.#allPaused = true
        } else {
          const entry = this.#streams.get(frame.streamId)
          if (!entry) {
            throw new KernelError(StreamErrorCodes.STREAM_PROTOCOL_VIOLATION, `未知流：${frame.streamId}`)
          }
          entry.paused = true
        }
        this.#events.onPauseChanged?.(frame.streamId, true)
        return
      }
      case FrameType.RESUME: {
        if (frame.streamId === 0) {
          this.#allPaused = false
          for (const id of this.#streams.keys()) this.#flush(id)
        } else {
          const entry = this.#streams.get(frame.streamId)
          if (!entry) {
            throw new KernelError(StreamErrorCodes.STREAM_PROTOCOL_VIOLATION, `未知流：${frame.streamId}`)
          }
          entry.paused = false
          this.#flush(frame.streamId)
        }
        // RESUME 必须驱动补发：暂停期间入队的块此刻按序发出（否则缓冲滞留至下一个发送动作）
        this.#events.onPauseChanged?.(frame.streamId, false)
        return
      }
      case FrameType.ACK: {
        this.#events.onAck?.(frame.streamId, frame.seq)
        return
      }
    }
  }

  #emit(frame: StreamFrame): void {
    this.#wire.send(encodeFrame(frame))
  }

  #sendable(streamId: number): StreamEntry {
    this.#assertOpen()
    const entry = this.#streams.get(streamId)
    if (!entry) throw new KernelError(StreamErrorCodes.STREAM_PROTOCOL_VIOLATION, `未知流：${streamId}`)
    if (entry.state !== 'open') {
      throw new KernelError(StreamErrorCodes.STREAM_PROTOCOL_VIOLATION, `流已结束：${streamId}`)
    }
    return entry
  }

  #liveStream(streamId: number): StreamEntry {
    const entry = this.#streams.get(streamId)
    if (!entry) {
      throw new KernelError(StreamErrorCodes.STREAM_PROTOCOL_VIOLATION, `未 OPEN 的流：${streamId}`)
    }
    if (entry.state !== 'open') {
      throw new KernelError(StreamErrorCodes.STREAM_PROTOCOL_VIOLATION, `流已结束：${streamId}`)
    }
    return entry
  }

  #expectSeq(entry: StreamEntry, seq: number): void {
    if (seq !== entry.nextSeq) {
      throw new KernelError(
        StreamErrorCodes.STREAM_PROTOCOL_VIOLATION,
        `帧序号不连续：期望 ${entry.nextSeq}，收到 ${seq}`,
      )
    }
    entry.nextSeq = seq + 1
  }

  #encodeJson(value: unknown): Uint8Array {
    return new TextEncoder().encode(JSON.stringify(value))
  }

  #decodeJson(payload: Uint8Array): unknown {
    try {
      return JSON.parse(new TextDecoder().decode(payload))
    } catch {
      throw new KernelError(StreamErrorCodes.STREAM_BAD_FRAME, 'JSON 负载解析失败')
    }
  }

  #violation(err: unknown): void {
    const code =
      err instanceof Error && typeof (err as unknown as { code?: unknown }).code === 'string'
        ? (err as unknown as { code: string }).code
        : StreamErrorCodes.STREAM_PROTOCOL_VIOLATION
    const message = err instanceof Error ? err.message : String(err)
    this.#events.onViolation?.(code, message)
  }

  #assertOpen(): void {
    if (this.#closed) throw new KernelError(StreamErrorCodes.STREAM_PROTOCOL_VIOLATION, '会话已关闭')
  }
}
