/**
 * StreamHub 测试：run 实况事件 → WS 帧流。内存管道双层回环（与 transport 回环自测同思路）：
 * 发送侧 = hub 绑的 StreamSession；接收侧 = 对端 StreamSession（回调收集，帧序连续性由协议自校验）。
 */
import { describe, expect, it } from 'vitest'
import { StreamSession } from '@openbot/transport'
import type { StreamOpenMeta } from '@openbot/transport'
import { StreamHub } from '../src/stream-hub/index.js'
import type { RunStreamEvent } from '@openbot/runner'

/** 内存传输线对（双向字节直通；close 双侧通知） */
class MemoryWire {
  peer: MemoryWire | null = null
  closed = false
  #onMessage: (data: Uint8Array) => void = () => {}
  #onClose: () => void = () => {}
  send(data: Uint8Array): void {
    if (!this.closed) this.peer?.#receive(data)
  }
  onMessage(cb: (data: Uint8Array) => void): void {
    this.#onMessage = cb
  }
  onClose(cb: () => void): void {
    this.#onClose = cb
  }
  close(): void {
    if (this.closed) return
    this.closed = true
    this.#onClose()
  }
  #receive(data: Uint8Array): void {
    this.#onMessage(data)
  }
}

function wirePair(): [MemoryWire, MemoryWire] {
  const a = new MemoryWire()
  const b = new MemoryWire()
  a.peer = b
  b.peer = a
  return [a, b]
}

interface ReceivedChunk {
  text: string
  channel?: 'stdout' | 'stderr'
}

interface ReceivedStream {
  meta: StreamOpenMeta
  chunks: ReceivedChunk[]
  ended: false | 'end' | 'abort'
  abortReason?: string
}

/** 接收端回环（回调收集每个流的完整生命周期） */
function makeReceiver(): { wire: MemoryWire; streams: Map<number, ReceivedStream> } {
  const [senderWire, receiverWire] = wirePair()
  const streams = new Map<number, ReceivedStream>()
  new StreamSession(receiverWire, {
    onOpen: (id, meta) => streams.set(id, { meta, chunks: [], ended: false }),
    onChunk: (id, _seq, payload) => {
      const stream = streams.get(id)
      if (!stream) return
      const decoded = JSON.parse(new TextDecoder().decode(payload)) as { t: string; ch?: 'stdout' | 'stderr' }
      stream.chunks.push({ text: decoded.t, ...(decoded.ch !== undefined ? { channel: decoded.ch } : {}) })
    },
    onEnd: (id) => {
      const stream = streams.get(id)
      if (stream) stream.ended = 'end'
    },
    onAbort: (id, _seq, reason) => {
      const stream = streams.get(id)
      if (stream) {
        stream.ended = 'abort'
        if (reason !== undefined) stream.abortReason = reason
      }
    },
  })
  return { wire: senderWire, streams }
}

const ev = (e: Partial<RunStreamEvent> & Pick<RunStreamEvent, 'type' | 'stream'>): RunStreamEvent => ({
  agentId: 'a1',
  runId: 'a1-run-1',
  ...e,
})

describe('StreamHub', () => {
  it('open → chunk → end：接收端完整收到 meta/增量/收流（含 exec 通道标记）', () => {
    const hub = new StreamHub()
    const receiver = makeReceiver()
    hub.attach(new StreamSession(receiver.wire))

    hub.handle(ev({ type: 'open', stream: 'exec', meta: { command: ['ls', '/work'] } }))
    hub.handle(ev({ type: 'chunk', stream: 'exec', text: 'a.txt\n', channel: 'stdout' }))
    hub.handle(ev({ type: 'chunk', stream: 'exec', text: '未找到 b.txt', channel: 'stderr' }))
    hub.handle(ev({ type: 'end', stream: 'exec', exitCode: 0 }))

    expect(receiver.streams.size).toBe(1)
    const stream = [...receiver.streams.values()][0]!
    expect(stream.meta).toEqual({
      kind: 'frames',
      meta: { agentId: 'a1', runId: 'a1-run-1', stream: 'exec', seq: 1, command: ['ls', '/work'] },
    })
    expect(stream.chunks).toEqual([
      { text: 'a.txt\n', channel: 'stdout' },
      { text: '未找到 b.txt', channel: 'stderr' },
    ])
    expect(stream.ended).toBe('end')
  })

  it('llm 流多轮同 run：序号递增、各自独立收流', () => {
    const hub = new StreamHub()
    const receiver = makeReceiver()
    hub.attach(new StreamSession(receiver.wire))

    for (const round of [1, 2]) {
      hub.handle(ev({ type: 'open', stream: 'llm', meta: { round } }))
      hub.handle(ev({ type: 'chunk', stream: 'llm', text: `第${round}轮` }))
      hub.handle(ev({ type: 'end', stream: 'llm' }))
    }
    const streams = [...receiver.streams.values()]
    expect(streams.length).toBe(2)
    expect(streams[0]?.meta.meta).toMatchObject({ stream: 'llm', seq: 1, round: 1 })
    expect(streams[1]?.meta.meta).toMatchObject({ stream: 'llm', seq: 2, round: 2 })
    expect(streams.map((s) => s.chunks.map((c) => c.text).join(''))).toEqual(['第1轮', '第2轮'])
    expect(streams.every((s) => s.ended === 'end')).toBe(true)
  })

  it('abort：ABORT 帧带原因', () => {
    const hub = new StreamHub()
    const receiver = makeReceiver()
    hub.attach(new StreamSession(receiver.wire))
    hub.handle(ev({ type: 'open', stream: 'llm', meta: { round: 1 } }))
    hub.handle(ev({ type: 'abort', stream: 'llm', reason: 'LLM_TIMEOUT' }))
    const stream = [...receiver.streams.values()][0]!
    expect(stream.ended).toBe('abort')
    expect(stream.abortReason).toBe('LLM_TIMEOUT')
  })

  it('无订阅者：事件全部丢弃不炸；订阅后只见新流（实况断线不补）', () => {
    const hub = new StreamHub()
    hub.handle(ev({ type: 'open', stream: 'llm', meta: { round: 1 } }))
    hub.handle(ev({ type: 'chunk', stream: 'llm', text: '没人听' }))
    hub.handle(ev({ type: 'end', stream: 'llm' }))

    const receiver = makeReceiver()
    hub.attach(new StreamSession(receiver.wire))
    hub.handle(ev({ type: 'open', stream: 'llm', meta: { round: 2 } }))
    hub.handle(ev({ type: 'chunk', stream: 'llm', text: '有人听' }))
    hub.handle(ev({ type: 'end', stream: 'llm' }))

    const streams = [...receiver.streams.values()]
    expect(streams.length).toBe(1)
    expect(streams[0]?.meta.meta).toMatchObject({ seq: 2 }) // 序号继续递增（hub 内计数与订阅无关）
    expect(streams[0]?.chunks.map((c) => c.text)).toEqual(['有人听'])
  })

  it('会话中途断开：已开流对其静默跳过，turn 侧事件照常处理', () => {
    const hub = new StreamHub()
    const receiver = makeReceiver()
    const sender = new StreamSession(receiver.wire)
    hub.attach(sender)
    hub.handle(ev({ type: 'open', stream: 'exec', meta: { command: ['sleep', '99'] } }))
    receiver.wire.close() // 接收端断连
    expect(() => {
      hub.handle(ev({ type: 'chunk', stream: 'exec', text: '输出到无人区' }))
      hub.handle(ev({ type: 'end', stream: 'exec', exitCode: 0 }))
    }).not.toThrow()
    expect(hub.sessionCount).toBe(0)
  })

  it('detach 后同一会话不再收到任何流', () => {
    const hub = new StreamHub()
    const receiver = makeReceiver()
    const sender = new StreamSession(receiver.wire)
    hub.attach(sender)
    hub.detach(sender)
    hub.handle(ev({ type: 'open', stream: 'llm', meta: { round: 1 } }))
    hub.handle(ev({ type: 'chunk', stream: 'llm', text: 'x' }))
    hub.handle(ev({ type: 'end', stream: 'llm' }))
    expect(receiver.streams.size).toBe(0)
  })
})
