/**
 * GuiStreamService 测试（plan-computer-use 二期）：GUI 实况流生命周期与 WS 流分发。
 * 内存管道双层回环（与 shell-service/stream-hub 同思路）：发送侧 = service 绑的
 * StreamSession（onPauseChanged 接回 service——gateway onStreamPause 的等价接线）；
 * 接收侧 = 对端 StreamSession 收集 OPEN/二进制字节/收流。backend 用 openPipe 替身
 * （帧字节测试方手动喂——真实后端的 argv 语义在 boxes test/backend-pipe.test.ts 锁定）。
 */
import { describe, expect, it } from 'vitest'
import { StreamSession } from '@openbot/transport'
import type { StreamOpenMeta } from '@openbot/transport'
import { GuiStreamService } from '../src/gui-stream/index.js'
import type { PipeSession, PipeSpec } from '@openbot/boxes'
import type { BoxBackend } from '@openbot/boxes'

/** 内存传输线对（双向字节直通；close 双侧通知）——shell-service.test.ts 同款 */
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

/** 接收端回环：收集 gui 流的 OPEN meta、重组后的原始字节、收流形态 */
interface GuiRecv {
  meta: StreamOpenMeta
  bytes: Uint8Array
  ended: false | 'end' | 'abort'
  reason?: string
}

function makeReceiver(): { wire: MemoryWire; session: StreamSession; streams: Map<number, GuiRecv> } {
  const a = new MemoryWire()
  const b = new MemoryWire()
  a.peer = b
  b.peer = a
  const streams = new Map<number, GuiRecv>()
  const session = new StreamSession(b, {
    onOpen: (id, meta) => streams.set(id, { meta, bytes: new Uint8Array(), ended: false }),
    onChunk: (id, _seq, payload) => {
      const s = streams.get(id)
      if (!s) return
      const merged = new Uint8Array(s.bytes.length + payload.length)
      merged.set(s.bytes, 0)
      merged.set(payload, s.bytes.length)
      s.bytes = merged
    },
    onEnd: (id) => {
      const s = streams.get(id)
      if (s) s.ended = 'end'
    },
    onAbort: (id, _seq, reason) => {
      const s = streams.get(id)
      if (s) {
        s.ended = 'abort'
        s.reason = reason
      }
    },
  })
  return { wire: a, session, streams }
}

/** 可控管道替身：测试方手动 emit 帧字节 / 触发 exit */
class FakePipe implements PipeSession {
  closed = false
  tail = ''
  written: string[] = []
  #dataCb: ((chunk: Uint8Array) => void) | null = null
  #exitCb: ((code: number | null) => void) | null = null
  onData(cb: (chunk: Uint8Array) => void): void {
    this.#dataCb = cb
  }
  onExit(cb: (code: number | null) => void): void {
    this.#exitCb = cb
  }
  stderrTail(): string {
    return this.tail
  }
  write(text: string): void {
    this.written.push(text)
  }
  close(): void {
    if (this.closed) return
    this.closed = true
    this.#exitCb?.(null)
  }
  emit(chunk: Uint8Array): void {
    this.#dataCb?.(chunk)
  }
  exit(code: number | null): void {
    this.#exitCb?.(code)
  }
}

/** openPipe/exec 替身后端：记录 spec、返回可控会话（exec 供 stop 补刀断言） */
function fakeBackend(): {
  backend: BoxBackend
  calls: Array<{ boxId: string; spec: PipeSpec }>
  execs: Array<{ boxId: string; spec: { command: string[] } }>
  lastPipe: () => FakePipe
} {
  const calls: Array<{ boxId: string; spec: PipeSpec }> = []
  const execs: Array<{ boxId: string; spec: { command: string[] } }> = []
  const pipes: FakePipe[] = []
  const backend = {
    openPipe: async (boxId: string, spec: PipeSpec) => {
      calls.push({ boxId, spec })
      const pipe = new FakePipe()
      pipes.push(pipe)
      return pipe
    },
    exec: async (boxId: string, spec: { command: string[] }) => {
      execs.push({ boxId, spec })
      return { exitCode: 0, stdout: '', stderr: '' }
    },
  } as unknown as BoxBackend
  return { backend, calls, execs, lastPipe: () => pipes[pipes.length - 1]! }
}

const GEO = { width: 1280, height: 800 }
const deps = (backend: BoxBackend, argv = ['ffmpeg-mock', 'pipe:1']) => ({
  backend,
  geometryOf: async () => GEO,
  display: '127.0.0.1:2',
  argvOf: () => argv,
})

const frameOf = (byte: number, size: number): Uint8Array => {
  // 大帧禁用展开构造（30 万元素展开超 V8 参数上限——Maximum call stack）
  const out = new Uint8Array(size + 4)
  out[0] = 0xff
  out[1] = 0xd8
  out.fill(byte, 2, size + 2)
  out[size + 2] = 0xff
  out[size + 3] = 0xd9
  return out
}

const eq = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((v, i) => v === b[i])

describe('GuiStreamService', () => {
  it('start：openPipe 收到采集 argv + DISPLAY env；WS 会话收到 OPEN（kind:gui + boxId + codec）', async () => {
    const { backend, calls } = fakeBackend()
    const service = new GuiStreamService(deps(backend))
    const { wire, streams } = makeReceiver()
    service.attach(new StreamSession(wire, {}))
    const box = 'box-1'
    const r = await service.start(box)
    expect(r.ok).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.boxId).toBe(box)
    expect(calls[0]!.spec.env).toEqual({ DISPLAY: '127.0.0.1:2' })
    const opened = [...streams.values()][0]!
    expect(opened.meta.kind).toBe('gui')
    expect(opened.meta.meta).toEqual({ boxId: box, codec: 'h264' }) // 缺省引擎（三期）
  })

  it('start 幂等：同 Box 二次开流不重复起管道', async () => {
    const { backend, calls } = fakeBackend()
    const service = new GuiStreamService(deps(backend))
    await service.start('box-1')
    await service.start('box-1')
    expect(calls).toHaveLength(1)
    expect(service.activeBoxIds()).toEqual(['box-1'])
  })

  it('帧分发：跨 DATA 块重组（>256KB 切块）按序到达接收端', async () => {
    const { backend, lastPipe } = fakeBackend()
    const service = new GuiStreamService(deps(backend))
    const { wire, streams } = makeReceiver()
    service.attach(new StreamSession(wire, {}))
    await service.start('box-1')
    const streamId = [...streams.keys()][0]!
    const big = frameOf(0x33, 300_000) // > MAX_STREAM_CHUNK_BYTES（256KB）
    lastPipe().emit(big.subarray(0, 100))
    lastPipe().emit(big.subarray(100))
    expect(eq(streams.get(streamId)!.bytes, big)).toBe(true)
  })

  it('晚接入回放（mjpeg）：无订阅者时采集照跑（latest 有界）；attach 即补开流 + 立即回放最新帧', async () => {
    const { backend, lastPipe } = fakeBackend()
    const service = new GuiStreamService({ ...deps(backend), codec: 'mjpeg', argvOf: () => ['ffmpeg-mock', 'pipe:1'] })
    await service.start('box-1') // 不 attach 任何会话
    const f1 = frameOf(0x01, 10)
    const f2 = frameOf(0x02, 10)
    lastPipe().emit(f1)
    lastPipe().emit(f2) // latest 被 f2 顶掉（f1 已无意义——实况语义）
    const { wire, streams } = makeReceiver()
    service.attach(new StreamSession(wire, {}))
    const opened = [...streams.values()][0]!
    expect(opened.meta.kind).toBe('gui')
    expect(eq(opened.bytes, f2)).toBe(true) // 回放的是最新帧，不是历史帧列
  })

  it('背压即降帧（mjpeg）：PAUSE 期间不堆积不排旧帧；RESUME 补发最新一帧', async () => {
    const { backend, lastPipe } = fakeBackend()
    const service = new GuiStreamService({ ...deps(backend), codec: 'mjpeg', argvOf: () => ['ffmpeg-mock', 'pipe:1'] })
    const { wire, session: receiver, streams } = makeReceiver()
    // 发送侧会话（wire a）自建；onPauseChanged 接回 service = gateway onStreamPause 的等价接线
    const sender = new StreamSession(wire, {
      onPauseChanged: (sid, paused) => service.onRemotePause(sender, sid, paused),
    })
    service.attach(sender)
    await service.start('box-1')
    const streamId = [...streams.keys()][0]!

    receiver.sendPause(streamId)
    const f1 = frameOf(0x01, 10)
    const f2 = frameOf(0x02, 10)
    lastPipe().emit(f1)
    lastPipe().emit(f2)
    expect(streams.get(streamId)!.bytes.length).toBe(0) // 暂停期零帧入线（不入 StreamSession 缓冲）

    receiver.sendResume(streamId)
    expect(eq(streams.get(streamId)!.bytes, f2)).toBe(true) // 补发的是最新帧（跳过 f1）

    // 恢复后实况照常逐帧到达
    const f3 = frameOf(0x03, 10)
    lastPipe().emit(f3)
    expect(streams.get(streamId)!.bytes.length).toBe(f2.length + f3.length)
  })

  it('stop：杀管道 + pidfile 补刀 exec + 收流 END；幂等；dispose 兜底全杀（孤儿纪律）', async () => {
    const { backend, lastPipe, execs } = fakeBackend()
    const service = new GuiStreamService(deps(backend))
    const { wire, streams } = makeReceiver()
    service.attach(new StreamSession(wire, {}))
    await service.start('box-1')
    const streamId = [...streams.keys()][0]!
    const pipe = lastPipe()
    service.stop('box-1')
    expect(pipe.closed).toBe(true)
    // 坑⑯：宿主侧杀 CLI 客户端不传导 Box 内进程——stop 必须按 pidfile 补刀
    expect(execs.some((e) => e.boxId === 'box-1' && e.spec.command.join(' ').includes('kill'))).toBe(true)
    expect(streams.get(streamId)!.ended).toBe('end')
    expect(service.activeBoxIds()).toEqual([])
    expect(() => service.stop('box-1')).not.toThrow() // 幂等
    // dispose：无活动流时静默
    expect(() => service.dispose()).not.toThrow()
  })

  it('采集异常退出（code≠0）：收流 ABORT 且 stderr 尾巴进 reason', async () => {
    const { backend, lastPipe } = fakeBackend()
    const service = new GuiStreamService(deps(backend))
    const { wire, streams } = makeReceiver()
    service.attach(new StreamSession(wire, {}))
    await service.start('box-1')
    const streamId = [...streams.keys()][0]!
    const pipe = lastPipe()
    pipe.tail = 'x11grab: could not open display'
    pipe.exit(1)
    const s = streams.get(streamId)!
    expect(s.ended).toBe('abort')
    expect(s.reason).toContain('code 1')
    expect(s.reason).toContain('could not open display')
    expect(service.activeBoxIds()).toEqual([])
  })

  it('单屏纪律：换 Box 开流先杀旧采集（旧流 END、新流存活）', async () => {
    const { backend, calls, lastPipe } = fakeBackend()
    const service = new GuiStreamService(deps(backend))
    const { wire, streams } = makeReceiver()
    service.attach(new StreamSession(wire, {}))
    await service.start('box-1')
    const firstId = [...streams.keys()][0]!
    const firstPipe = lastPipe()
    await service.start('box-2')
    expect(firstPipe.closed).toBe(true)
    expect(streams.get(firstId)!.ended).toBe('end')
    expect(calls).toHaveLength(2)
    expect(service.activeBoxIds()).toEqual(['box-2'])
  })

  it('backend 未实现 openPipe：ok:false 如实降级（UI 维持截图轮询）', async () => {
    const backend = {} as unknown as BoxBackend
    const service = new GuiStreamService(deps(backend))
    const r = await service.start('box-1')
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('常驻管道')
  })

  it('h264 引擎：纯字节搬运不拆帧不丢帧（PAUSE 期 StreamSession 缓冲；无 latest 回放）', async () => {
    const { backend, lastPipe } = fakeBackend()
    const service = new GuiStreamService(deps(backend)) // 缺省 h264
    const { wire, session: receiver, streams } = makeReceiver()
    const sender = new StreamSession(wire, {
      onPauseChanged: (sid, paused) => service.onRemotePause(sender, sid, paused),
    })
    service.attach(sender)
    await service.start('box-1')
    const streamId = [...streams.keys()][0]!

    // 字节原样到达（不按帧边界重组——Annex B 解析在 renderer）
    const c1 = Uint8Array.of(0x00, 0x00, 0x00, 0x01, 0x67)
    const c2 = Uint8Array.of(0x00, 0x00, 0x01, 0x41)
    lastPipe().emit(c1)
    lastPipe().emit(c2)
    expect(streams.get(streamId)!.bytes.length).toBe(c1.length + c2.length)

    // PAUSE 期不丢帧（StreamSession 缓冲），RESUME 后补发（对照 mjpeg 的丢旧帧语义）
    receiver.sendPause(streamId)
    const c3 = Uint8Array.of(0x00, 0x00, 0x01, 0x41)
    lastPipe().emit(c3)
    expect(streams.get(streamId)!.bytes.length).toBe(c1.length + c2.length) // 未入线（缓冲中）
    receiver.sendResume(streamId)
    expect(streams.get(streamId)!.bytes.length).toBe(c1.length + c2.length + c3.length) // 按序补齐

    // 晚接入：不回放（不可丢帧——观看端等下一个 IDR）
    const late = makeReceiver()
    service.attach(new StreamSession(late.wire, {}))
    expect([...late.streams.values()][0]!.bytes.length).toBe(0)
    expect([...late.streams.values()][0]!.meta.meta).toEqual({ boxId: 'box-1', codec: 'h264' })
  })

  it('mjpeg 引擎（env 回退路径）：OPEN meta codec=mjpeg + 拆帧 + latest 回放语义保留', async () => {
    const { backend, calls, lastPipe } = fakeBackend()
    const service = new GuiStreamService({ ...deps(backend), codec: 'mjpeg', argvOf: () => ['ffmpeg-mock', 'pipe:1'] })
    const { wire, streams } = makeReceiver()
    service.attach(new StreamSession(wire, {}))
    await service.start('box-1')
    expect(calls[0]!.spec.command).toEqual(['sh', '-c', 'echo $$ > /tmp/.openbot-gui-stream.pid; exec "$@"', 'sh', 'ffmpeg-mock', 'pipe:1'])
    expect([...streams.values()][0]!.meta.meta).toEqual({ boxId: 'box-1', codec: 'mjpeg' })
    const f1 = frameOf(0x01, 10)
    lastPipe().emit(f1)
    const streamId = [...streams.keys()][0]!
    expect(streams.get(streamId)!.bytes.length).toBe(f1.length) // mjpeg 拆帧按 SOI/EOI 整帧
    // 晚接入回放 latest（帧源唯一化——帧内编码可回放）
    const late = makeReceiver()
    service.attach(new StreamSession(late.wire, {}))
    expect([...late.streams.values()][0]!.bytes.length).toBe(f1.length)
  })

  it('缺省 argv（h264 引擎）：x264 zerolatency/crf18 视觉无损 + yuv420p 硬解兼容 + pidfile 包装', async () => {
    const { backend, calls } = fakeBackend()
    const service = new GuiStreamService({ backend, geometryOf: async () => GEO, display: ':0' })
    await service.start('box-1')
    expect(calls[0]!.spec.command).toEqual([
      'sh', '-c', 'echo $$ > /tmp/.openbot-gui-stream.pid; exec "$@"', 'sh',
      'ffmpeg', '-nostdin',
      '-f', 'x11grab',
      '-framerate', '60',
      '-video_size', '1280x800',
      '-i', ':0',
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-tune', 'zerolatency',
      '-crf', '18',
      '-g', '30',
      '-pix_fmt', 'yuv420p',
      '-f', 'h264',
      'pipe:1',
    ])
  })

  it('缺省 argv（mjpeg 引擎）：q:v 3 近优档 + pidfile 包装（一期回退路径）', async () => {
    const { backend, calls } = fakeBackend()
    const service = new GuiStreamService({ backend, geometryOf: async () => GEO, display: ':0', codec: 'mjpeg' })
    await service.start('box-1')
    expect(calls[0]!.spec.command).toEqual([
      'sh', '-c', 'echo $$ > /tmp/.openbot-gui-stream.pid; exec "$@"', 'sh',
      'ffmpeg', '-nostdin',
      '-f', 'x11grab',
      '-framerate', '60',
      '-video_size', '1280x800',
      '-i', ':0',
      '-f', 'mjpeg',
      '-q:v', '3',
      'pipe:1',
    ])
  })
})
