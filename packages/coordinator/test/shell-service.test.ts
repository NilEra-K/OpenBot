/**
 * ShellService 测试：PTY 会话生命周期与 WS 流分发。内存管道双层回环（与 stream-hub 同思路）：
 * 发送侧 = service 绑的 StreamSession；接收侧 = 对端 StreamSession（回调收集）。
 * backend 用 MockBoxBackend（回显假终端——CI 零沙箱依赖）。
 */
import { describe, expect, it } from 'vitest'
import { StreamSession } from '@openbot/transport'
import type { StreamOpenMeta } from '@openbot/transport'
import { MockBoxBackend } from '@openbot/boxes'
import type { BoxBackend } from '@openbot/boxes'
import { ShellService } from '../src/shell-service/index.js'

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

interface ReceivedStream {
  meta: StreamOpenMeta
  text: string
  ended: false | 'end'
}

/** 接收端回环（收集 pty 流的完整生命周期） */
function makeReceiver(): { wire: MemoryWire; streams: Map<number, ReceivedStream> } {
  const a = new MemoryWire()
  const b = new MemoryWire()
  a.peer = b
  b.peer = a
  const streams = new Map<number, ReceivedStream>()
  new StreamSession(b, {
    onOpen: (id, meta) => streams.set(id, { meta, text: '', ended: false }),
    onChunk: (id, _seq, payload) => {
      const stream = streams.get(id)
      if (!stream) return
      stream.text += (JSON.parse(new TextDecoder().decode(payload)) as { t: string }).t
    },
    onEnd: (id) => {
      const stream = streams.get(id)
      if (stream) stream.ended = 'end'
    },
  })
  return { wire: a, streams }
}

describe('ShellService', () => {
  it('open → 流分发（kind:pty meta）→ write 路由 → exit 收流除名', async () => {
    const backend = new MockBoxBackend()
    const box = await backend.create({ image: 'default' })
    const service = new ShellService({ backend })
    const { wire, streams } = makeReceiver()
    service.attach(new StreamSession(wire, {}))

    const { shellId } = await service.open(box)
    expect(shellId).toBe('shell-1')
    // 已开流：meta 形状（renderer lib/stream.ts 对照）
    const opened = [...streams.values()][0]!
    expect(opened.meta.kind).toBe('pty')
    expect(opened.meta.meta).toEqual({ shellId: 'shell-1', boxId: box })

    // 键入路由：mock 回显假终端同步回输出 → 流上收到
    service.write(shellId, 'ls /work\r')
    expect(opened.text).toContain('ls /work')
    expect(opened.text).toContain('mock: ls /work')
    expect(opened.ended).toBe(false)

    // bash exit（mock 的 exit 命令）：收流 END + 会话除名
    service.write(shellId, 'exit\r')
    expect(opened.ended).toBe('end')
    expect(service.openCount).toBe(0)
    expect(() => service.write(shellId, 'x')).toThrowError(expect.objectContaining({ code: 'SHELL_NOT_FOUND' }))
  })

  it('close：杀会话收流；幂等（已退出的会话静默成功）', async () => {
    const backend = new MockBoxBackend()
    const box = await backend.create({ image: 'default' })
    const service = new ShellService({ backend })
    const { wire, streams } = makeReceiver()
    service.attach(new StreamSession(wire, {}))
    const { shellId } = await service.open(box)
    const opened = [...streams.values()][0]!
    service.close(shellId)
    expect(opened.ended).toBe('end')
    expect(service.openCount).toBe(0)
    expect(() => service.close(shellId)).not.toThrow()
  })

  it('caps.interactive=false 的后端：open 抛 SHELL_UNSUPPORTED（诚实降级，UI 按 caps 不渲染入口）', async () => {
    // 最小 stub：open 的 caps 分支先抛——其余成员走不到（BoxBackend 只声明用到的两面）
    const capped = {
      caps: () => ({
        persistent: true, snapshot: true, headless: true, resourceLimits: false, isolation: 'low' as const, interactive: false, suspendable: false,
      }),
      openShell: async () => {
        throw new Error('不应到达（caps 已声明不支持）')
      },
    } as unknown as BoxBackend
    const service = new ShellService({ backend: capped })
    await expect(service.open('box-1')).rejects.toMatchObject({ code: 'SHELL_UNSUPPORTED' })
  })

  it('无 WS 订阅者：会话照样跑（生命周期不受渲染层在线影响——与 StreamHub 同哲学）', async () => {
    const backend = new MockBoxBackend()
    const box = await backend.create({ image: 'default' })
    const service = new ShellService({ backend }) // 不 attach 任何会话
    const { shellId } = await service.open(box)
    service.write(shellId, 'echo hi\r')
    expect(service.openCount).toBe(1)
    service.dispose()
    expect(service.openCount).toBe(0)
  })
})
