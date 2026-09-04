/**
 * GuiStreamService 真机套件（plan-computer-use 二期）：podman GUI 容器内真 ffmpeg x11grab
 * → mjpeg 管道 → openPipe 原始字节 → 拆帧 → WS 会话分发的全链实证。
 * 门控：OPENBOT_TEST_GUI_STREAM=1 且镜像在位（默认 CI 零沙箱依赖——backend-wsl 真实套件同哲学）。
 * 隔离纪律：Box 用独立 id（gui-stream-real）不碰既有容器；afterAll teardown 兜底清理。
 */
import { execFileSync } from 'node:child_process'
import { afterAll, describe, expect, it } from 'vitest'
import { PodmanBoxBackend } from '@openbot/boxes'
import type { BoxBackend } from '@openbot/boxes'
import { StreamSession } from '@openbot/transport'
import { GuiStreamService } from '../src/gui-stream/index.js'
import { createMjpegSplitter } from '../src/gui-stream/splitter.js'

const REAL = process.env.OPENBOT_TEST_GUI_STREAM === '1'
const IMAGE = process.env.OPENBOT_TEST_GUI_IMAGE ?? 'localhost/openbot-gui:24.04'
const REAL_BOX = 'gui-stream-real' // 独立 id——绝不触碰桌面实例的 openbot-box-box-*

const imagePresent = (): boolean => {
  try {
    execFileSync('podman', ['image', 'exists', IMAGE], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/** 内存传输线对（双向字节直通）——shell-service.test.ts 同款替身 */
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

interface RealRecv {
  meta: unknown
  bytes: Uint8Array
  ended: false | 'end' | 'abort'
  reason?: string
}

describe.skipIf(!REAL || !imagePresent())('GuiStreamService（真机 podman + ffmpeg）', () => {
  let backend: BoxBackend
  let service: GuiStreamService
  let boxId: string
  const recv: RealRecv = { meta: null, bytes: new Uint8Array(), ended: false }

  afterAll(async () => {
    service?.dispose()
    // GUI 容器全栈进程树（xfce/dbus）的 rm -f 慢于 vitest 默认 hook 超时——显式放宽
    if (backend !== undefined && boxId !== undefined) await backend.teardown(boxId).catch(() => {})
  }, 60_000)

  it('开流：容器内真 ffmpeg 起采集，几何现查，帧字节持续到达', { timeout: 180_000 }, async () => {
    backend = new PodmanBoxBackend({ image: IMAGE, now: Date.now, nextBoxId: () => REAL_BOX })
    boxId = await backend.create({ image: IMAGE })
    // GUI 入口起 Xvfb 需要几秒——几何可查即显示就绪
    const deadline = Date.now() + 60_000
    for (;;) {
      const r = await backend.exec(boxId, { command: ['xdotool', 'getdisplaygeometry'], timeoutMs: 5_000, env: { DISPLAY: ':0' } }).catch(() => null)
      if (r !== null && r.exitCode === 0) break
      if (Date.now() > deadline) throw new Error('显示 60s 未就绪（Xvfb 未起？）')
      await new Promise((resolve) => setTimeout(resolve, 2_000))
    }
    // 内存线对：发送侧（service attach 的会话，onPauseChanged 接回 service = gateway 转发等价）
    const wireA = new MemoryWire()
    const wireB = new MemoryWire()
    wireA.peer = wireB
    wireB.peer = wireA
    service = new GuiStreamService({ backend, display: ':0' })
    const sender = new StreamSession(wireA, {
      onPauseChanged: (sid, paused) => service.onRemotePause(sender, sid, paused),
    })
    service.attach(sender)
    const recv: RealRecv = { meta: null, bytes: new Uint8Array(), ended: false }
    new StreamSession(wireB, {
      onOpen: (_id, meta) => (recv.meta = meta),
      onChunk: (_id, _seq, payload) => {
        const merged = new Uint8Array(recv.bytes.length + payload.length)
        merged.set(recv.bytes, 0)
        merged.set(payload, recv.bytes.length)
        recv.bytes = merged
      },
      onEnd: () => (recv.ended = 'end'),
      onAbort: (_id, _seq, reason) => {
        recv.ended = 'abort'
        recv.reason = reason
      },
    })
    const r = await service.start(boxId)
    expect(r.ok, r.reason).toBe(true)
    // 4s 采集窗：30fps × 1920x1080 应到达兆级字节（2-6MB 视画面复杂度）
    const baseline = recv.bytes.length
    await new Promise((resolve) => setTimeout(resolve, 4_000))
    const received = recv.bytes.length - baseline
    expect(recv.meta).toMatchObject({ kind: 'gui', meta: { boxId } })
    expect(received).toBeGreaterThan(1_000_000)
    // 拆帧器消费整段：帧数 30fps 量级（>60 帧）、帧界完整（SOI/EOI、非空帧）
    const splitter = createMjpegSplitter()
    const frames = splitter.push(recv.bytes)
    // 实测数字进记档（plan-computer-use 二期实施记档引用）
    console.log(`[openbot] gui 流真机实测：4s 窗口 ${frames.length} 帧（≈${(frames.length / 4).toFixed(0)}fps）/ ${(received / 1048576).toFixed(1)}MB / 单帧中位 ≈${(received / frames.length / 1024).toFixed(0)}KB`)
    expect(frames.length).toBeGreaterThan(60)
    for (const f of [frames[0]!, frames[frames.length - 1]!]) {
      expect(f[0]).toBe(0xff)
      expect(f[1]).toBe(0xd8)
      expect(f[f.length - 2]).toBe(0xff)
      expect(f[f.length - 1]).toBe(0xd9)
      expect(f.length).toBeGreaterThan(10_000) // 1920x1080 桌面帧不是空帧
    }
    // 停流：ffmpeg 进程随 close 终止（孤儿纪律——容器内 pgrep 清零）+ 收流 END
    service.stop(boxId)
    await new Promise((resolve) => setTimeout(resolve, 2_000))
    const pg = await backend.exec(boxId, { command: ['sh', '-c', 'pgrep -c ffmpeg || true'], timeoutMs: 10_000 })
    // pgrep -c 无匹配输出 "0"（exit 1 被 || true 吞）——0 即容器内 ffmpeg 清零
    expect(pg.stdout.trim()).toBe('0')
    expect(recv.ended).toBe('end')
  }, 180_000)
})
