/**
 * stream-protocol 测试：编解码纯函数 + 内存管道会话状态机 + 真实 WS 网关回环自测。
 * P2 范围：只定协议 + 回环自测（不接真实 Box 信号源——P3 再接）。
 */
import { afterAll, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { EventBus, KernelError } from '@openbot/core'
import {
  decodeFrame,
  encodeFrame,
  FrameType,
  InProcessTransport,
  MAX_STREAM_CHUNK_BYTES,
  startGateway,
  StreamErrorCodes,
  StreamSession,
  type StreamWire,
} from '../src/index.js'

const TOKEN = 'test-token-fixed'

/** 内存双工管道：两端各持一条传输线，写入经微任务直达对端（确定性，无需真实网络） */
function memoryPipe(): [StreamWire, StreamWire] {
  const boxes: Array<{ onMessage?: (data: Uint8Array) => void; onClose?: () => void }> = [{}, {}]
  const side = (self: 0 | 1): StreamWire => ({
    send: (data) => queueMicrotask(() => boxes[1 - self]!.onMessage?.(data)),
    onMessage: (cb) => (boxes[self]!.onMessage = cb),
    onClose: (cb) => (boxes[self]!.onClose = cb),
    close: () => boxes[self]!.onClose?.(),
  })
  return [side(0), side(1)]
}

describe('帧编解码（纯函数）', () => {
  it('往返：头字段与负载逐字段一致', () => {
    const payload = new TextEncoder().encode('{"kind":"file"}')
    const bytes = encodeFrame({ type: FrameType.OPEN, streamId: 7, seq: 3, payload })
    expect(bytes.byteLength).toBe(14 + payload.byteLength)
    const frame = decodeFrame(bytes)
    expect(frame.type).toBe(FrameType.OPEN)
    expect(frame.streamId).toBe(7)
    expect(frame.seq).toBe(3)
    expect(Array.from(frame.payload)).toEqual(Array.from(payload))
  })

  it('头字节布局：版本/类型/流 ID/序号/负载长度按 big-endian 落位', () => {
    const bytes = encodeFrame({ type: FrameType.DATA, streamId: 0x0102_0304, seq: 5, payload: new Uint8Array([1, 2]) })
    expect([...bytes.slice(0, 4)]).toEqual([1, FrameType.DATA, 0x01, 0x02])
    const view = new DataView(bytes.buffer)
    expect(view.getUint32(2)).toBe(0x0102_0304)
    expect(view.getUint32(6)).toBe(5)
    expect(view.getUint32(10)).toBe(2)
  })

  it('坏帧拒绝：短帧 / 错版本 / 未知类型 / 负载长度不符 → STREAM_BAD_FRAME', () => {
    const good = encodeFrame({ type: FrameType.END, streamId: 1, seq: 0, payload: new Uint8Array(0) })
    expect(() => decodeFrame(good.slice(0, 13))).toThrow(KernelError)
    const badVersion = new Uint8Array(good)
    badVersion[0] = 2
    try {
      decodeFrame(badVersion)
      expect.unreachable()
    } catch (err) {
      expect((err as KernelError).code).toBe(StreamErrorCodes.STREAM_BAD_FRAME)
    }
    const badType = new Uint8Array(good)
    badType[1] = 0xff
    expect(() => decodeFrame(badType)).toThrow(/未知帧类型/)
    // 版本/类型合法但多出 6 个字节 → 声明负载长度与实际不符
    expect(() => decodeFrame(new Uint8Array([...good, 0, 0, 0, 0, 0, 0]))).toThrow(/负载长度不符/)
  })
})

describe('会话状态机（内存管道回环）', () => {
  it('完整流：OPEN→DATA×N→END 序号连续；END 回 ACK 最高序号', async () => {
    const [wireA, wireB] = memoryPipe()
    const acks: Array<{ streamId: number; seq: number }> = []
    const chunks: string[] = []
    const ended: number[] = []
    const receiver = new StreamSession(wireB, {
      onOpen: (_id, meta) => expect(meta.kind).toBe('file'),
      onChunk: (_id, _seq, chunk) => chunks.push(new TextDecoder().decode(chunk)),
      onEnd: (id, seq) => {
        ended.push(id)
        receiver.sendAck(id, seq)
      },
    })
    // ACK 是「接收方→发送方」信号：onAck 挂在 sender 的回调上
    const sender = new StreamSession(wireA, { onAck: (id, seq) => acks.push({ streamId: id, seq }) })
    const streamId = sender.openStream({ kind: 'file', boxId: 'box-1' })
    sender.sendChunk(streamId, new TextEncoder().encode('第一块'))
    sender.sendChunk(streamId, new TextEncoder().encode('第二块'))
    sender.sendChunk(streamId, new TextEncoder().encode('第三块'))
    sender.endStream(streamId)
    await settle()
    expect(chunks).toEqual(['第一块', '第二块', '第三块'])
    expect(ended).toEqual([streamId])
    // OPEN=0，DATA 1..3，END=4 → ACK 最高连续序号 = 4
    expect(acks).toEqual([{ streamId, seq: 4 }])
  })

  it('背压：接收方 PAUSE 后发送方入队不发，RESUME 后按序补发', async () => {
    const [wireA, wireB] = memoryPipe()
    const received: string[] = []
    const receiver = new StreamSession(wireB, {
      onChunk: (_id, _seq, chunk) => received.push(new TextDecoder().decode(chunk)),
    })
    const sender = new StreamSession(wireA)
    const streamId = sender.openStream({ kind: 'frames' })
    sender.sendChunk(streamId, new TextEncoder().encode('流内-1'))
    await settle()
    expect(received).toEqual(['流内-1'])

    // 接收方压回（全流）→ 发送方进入暂停态
    receiver.sendPause(0)
    await until(() => sender.isPaused(0))
    sender.sendChunk(streamId, new TextEncoder().encode('暂停-2'))
    sender.sendChunk(streamId, new TextEncoder().encode('暂停-3'))
    await settle()
    expect(received).toEqual(['流内-1']) // 暂停期间不出块
    expect(sender.isPaused(streamId)).toBe(true)

    // 恢复 → 缓冲按序发出
    receiver.sendResume(0)
    await until(() => received.length === 3)
    expect(received).toEqual(['流内-1', '暂停-2', '暂停-3'])
  })

  it('协议违规：序号跳跃 → onViolation 收 STREAM_PROTOCOL_VIOLATION', async () => {
    const [wireA, wireB] = memoryPipe()
    const violations: Array<{ code: string; message: string }> = []
    new StreamSession(wireB, { onViolation: (code, message) => violations.push({ code, message }) })
    const sender = new StreamSession(wireA)
    const streamId = sender.openStream({ kind: 'frames' })
    await settle()
    // 伪造 seq 跳跃的 DATA 帧直接上链（绕过 sender 的连续分配）
    wireA.send(encodeFrame({ type: FrameType.DATA, streamId, seq: 99, payload: new Uint8Array([1]) }))
    await settle()
    expect(violations.length).toBe(1)
    expect(violations[0]!.code).toBe(StreamErrorCodes.STREAM_PROTOCOL_VIOLATION)
    expect(violations[0]!.message).toContain('不连续')
  })

  it('ABORT 带原因立即中止；超大块拒绝；多路复用两条流互不干扰', async () => {
    const [wireA, wireB] = memoryPipe()
    const aborted: Array<{ id: number; reason?: string }> = []
    const perStream = new Map<number, string[]>()
    new StreamSession(wireB, {
      onChunk: (id, _seq, chunk) => {
        const list = perStream.get(id) ?? []
        list.push(new TextDecoder().decode(chunk))
        perStream.set(id, list)
      },
      onAbort: (id, _seq, reason) => aborted.push({ id, reason }),
    })
    const sender = new StreamSession(wireA)
    const streamId1 = sender.openStream({ kind: 'file' })
    const streamId2 = sender.openStream({ kind: 'frames' })
    expect(streamId2).toBe(streamId1 + 1) // 流 ID 单调分配
    sender.sendChunk(streamId1, new TextEncoder().encode('甲流'))
    sender.sendChunk(streamId2, new TextEncoder().encode('乙流'))
    sender.abortStream(streamId1, '用户取消')
    await settle()
    expect(aborted).toEqual([{ id: streamId1, reason: '用户取消' }])
    expect(perStream.get(streamId1)).toEqual(['甲流'])
    expect(perStream.get(streamId2)).toEqual(['乙流'])
    // 超限块本地拒绝（不产生任何外发）
    expect(() => sender.sendChunk(streamId2, new Uint8Array(MAX_STREAM_CHUNK_BYTES + 1))).toThrow(/超上限/)
    // 已中止的流不能再发
    expect(() => sender.sendChunk(streamId1, new TextEncoder().encode('x'))).toThrow(/已结束/)
  })
})

describe('网关 WS /stream 回环（真实 ws 客户端）', () => {
  const closers: Array<() => void> = []
  afterAll(async () => {
    for (const close of closers) close()
  })

  it('回环：open→data×N→end，网关回 ACK 最终序号；错 token 连接被拒', async () => {
    const bus = new EventBus({ now: () => 0 })
    const transport = new InProcessTransport({ bus })
    const gateway = await startGateway({ transport, bus, token: TOKEN })
    closers.push(() => void gateway.close())

    // 错 token：升级被拒（连接错误）
    await expect(
      new Promise((_resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${gateway.port}/stream?token=wrong`)
        ws.on('open', () => reject(new Error('不应连上')))
        ws.on('error', (err: Error) => reject(err))
      }),
    ).rejects.toThrow()

    // 正确 token：完整流回环
    const ws = new WebSocket(`ws://127.0.0.1:${gateway.port}/stream?token=${TOKEN}`)
    closers.push(() => ws.close())
    await new Promise<void>((resolve) => ws.on('open', () => resolve()))
    const acks: Array<{ streamId: number; seq: number }> = []
    const sender = new StreamSession(wsToWire(ws), { onAck: (id, seq) => acks.push({ streamId: id, seq }) })
    const streamId = sender.openStream({ kind: 'frames', boxId: 'box-1' })
    for (let i = 0; i < 8; i++) sender.sendChunk(streamId, new TextEncoder().encode(`帧-${i}`))
    sender.endStream(streamId)
    await until(() => acks.length > 0)
    // OPEN=0 + DATA 1..8 + END=9 → 网关 ACK = 9（端到端无丢帧）
    expect(acks.at(-1)).toEqual({ streamId, seq: 9 })
  })

  it('背压回环：网关 PAUSE 后发送方停发并缓冲，RESUME 后补发、END 后 ACK 收齐', async () => {
    const bus = new EventBus({ now: () => 0 })
    const transport = new InProcessTransport({ bus })
    let gatewaySession: StreamSession | null = null
    const gateway = await startGateway({
      transport,
      bus,
      token: TOKEN,
      onStreamSession: (session) => (gatewaySession = session),
    })
    closers.push(() => void gateway.close())

    const ws = new WebSocket(`ws://127.0.0.1:${gateway.port}/stream?token=${TOKEN}`)
    closers.push(() => ws.close())
    await new Promise<void>((resolve) => ws.on('open', () => resolve()))
    const acks: number[] = []
    const sender = new StreamSession(wsToWire(ws), { onAck: (_id, seq) => acks.push(seq) })
    const streamId = sender.openStream({ kind: 'frames' })
    for (let i = 0; i < 3; i++) sender.sendChunk(streamId, new TextEncoder().encode(`前-${i}`))
    await until(() => gatewaySession !== null)
    await settle()

    // 网关压回全流 → 发送方再入队 3 块（不出）→ 恢复后补发
    gatewaySession!.sendPause(0)
    await until(() => sender.isPaused(0))
    for (let i = 0; i < 3; i++) sender.sendChunk(streamId, new TextEncoder().encode(`后-${i}`))
    expect(sender.isPaused(streamId)).toBe(true)
    gatewaySession!.sendResume(0)
    await until(() => !sender.isPaused(streamId))
    sender.endStream(streamId)
    // OPEN=0 + DATA 1..6 + END=7 → ACK = 7（暂停未丢任何块）
    await until(() => acks.length > 0)
    expect(acks.at(-1)).toBe(7)
  })
})

// ---- 测试工具 ----

function wsToWire(ws: WebSocket): StreamWire {
  return {
    send: (data) => ws.send(data),
    onMessage: (cb) => ws.on('message', (data, isBinary) => isBinary && cb(data as Buffer)),
    onClose: (cb) => ws.on('close', () => cb()),
    close: () => ws.close(),
  }
}

/** 等微任务队列排空（memoryPipe 用 queueMicrotask 投递） */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/** 轮询直到条件满足（真实 WS 网络异步） */
async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('until 超时')
    await settle()
  }
}
