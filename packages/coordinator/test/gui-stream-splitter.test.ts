/**
 * mjpeg 拆帧器纯函数测试：ffmpeg `-f mjpeg` 管道的帧界扫描（SOI=FFD8 / EOI=FFD9）。
 * 核心性质：帧按任意字节边界切块（真实管道的 read 粒度不可控）都能凑齐同样的帧序列；
 * 跨块 SOI 前缀、帧内 FF 00 填充、超长帧自愈、SOI 前垃圾字节全在此锁定。
 */
import { describe, expect, it } from 'vitest'
import { createMjpegSplitter } from '../src/gui-stream/splitter.js'

/** 构造一帧伪 JPEG：SOI + 载荷（可带 FF 00 填充）+ EOI——拆帧器只认标记，载荷内容无关紧要 */
function frame(payload: number[] = []): Uint8Array {
  return Uint8Array.of(0xff, 0xd8, ...payload, 0xff, 0xd9)
}

/** 按 n 字节一块喂入（真实管道 read 粒度的替身） */
function feedChunked(splitter: ReturnType<typeof createMjpegSplitter>, data: Uint8Array, n: number): Uint8Array[] {
  const out: Uint8Array[] = []
  for (let off = 0; off < data.length; off += n) {
    out.push(...splitter.push(data.subarray(off, Math.min(off + n, data.length))))
  }
  return out
}

const eq = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((v, i) => v === b[i])

describe('mjpeg 拆帧器', () => {
  it('单帧整块到达：原样吐出', () => {
    const s = createMjpegSplitter()
    const f = frame([1, 2, 3])
    expect(s.push(f)).toHaveLength(1)
    expect(s.buffered).toBe(0)
  })

  it('帧按任意字节边界切块：凑齐同样的帧（逐偏移遍历的强性质）', () => {
    const f1 = frame([0x01, 0x02])
    const f2 = frame([0x03, 0xff, 0x00, 0x04]) // 帧内 FF 00 填充（熵编码转义）
    const whole = Uint8Array.of(...f1, ...f2)
    for (let n = 1; n <= whole.length + 1; n++) {
      const s = createMjpegSplitter()
      const frames = feedChunked(s, whole, n)
      expect(frames, `块大小 ${n}`).toHaveLength(2)
      expect(eq(frames[0]!, f1), `块大小 ${n}`).toBe(true)
      expect(eq(frames[1]!, f2), `块大小 ${n}`).toBe(true)
      expect(s.buffered, `块大小 ${n}`).toBe(0)
    }
  })

  it('SOI/EOI 自身跨块：FF D8 与 FF D9 各自被切块也能收敛', () => {
    const f = frame([0xaa])
    for (let n = 1; n <= 4; n++) {
      const s = createMjpegSplitter()
      const frames = feedChunked(s, f, n)
      expect(frames, `块大小 ${n}`).toHaveLength(1)
      expect(eq(frames[0]!, f), `块大小 ${n}`).toBe(true)
    }
  })

  it('SOI 前垃圾字节：忽略且不积累（缓冲 ≤1 字节，跨块 FF D8 前缀收敛）', () => {
    const s = createMjpegSplitter()
    const garbage = Uint8Array.of(0x00, 0x11, 0xff, 0x00, 0x22, 0xff)
    expect(s.push(garbage)).toEqual([])
    expect(s.buffered).toBe(1) // 尾随 0xff 是潜在跨块 SOI 前缀——缓存 1 字节等下一块
    const frames = s.push(Uint8Array.of(0xd8, 0x09, 0xff, 0xd9)) // 前缀 + D8 跨块拼回 SOI
    expect(frames).toHaveLength(1)
    expect(s.buffered).toBe(0)
  })

  it('EOI 迟到：帧尾跨块到达后补齐吐出', () => {
    const s = createMjpegSplitter()
    const f = frame([0x01, 0x02, 0x03])
    expect(s.push(f.subarray(0, 4))).toEqual([]) // SOI + 2 载荷
    expect(s.buffered).toBe(4)
    const frames = s.push(f.subarray(4)) // EOI 后半
    expect(frames).toHaveLength(1)
    expect(eq(frames[0]!, f)).toBe(true)
  })

  it('超长帧自愈：超过上限丢弃缓冲不越积越多（流错位保护）', () => {
    const s = createMjpegSplitter({ maxFrameBytes: 16 })
    expect(s.push(Uint8Array.of(0xff, 0xd8, ...Array.from({ length: 32 }, () => 0x11)))).toEqual([])
    expect(s.buffered).toBe(0) // 自愈后干净
    // 自愈后新帧照常拆
    const f = frame([7])
    const frames = s.push(f)
    expect(frames).toHaveLength(1)
  })

  it('reset：调用方显式丢弃暂存（重连/错位手动自愈面）', () => {
    const s = createMjpegSplitter()
    s.push(Uint8Array.of(0xff, 0xd8, 0x01))
    expect(s.buffered).toBe(3)
    s.reset()
    expect(s.buffered).toBe(0)
  })

  it('同块多帧 + EOI/SOI 相邻：全吐出且不串帧', () => {
    const s = createMjpegSplitter()
    const f1 = frame([1])
    const f2 = frame([2, 3])
    const f3 = frame([])
    const frames = s.push(Uint8Array.of(...f1, ...f2, ...f3))
    expect(frames).toHaveLength(3)
    expect(eq(frames[0]!, f1)).toBe(true)
    expect(eq(frames[1]!, f2)).toBe(true)
    expect(eq(frames[2]!, f3)).toBe(true)
  })

  it('FFD9 出现在载荷内（非规范编码的假想场景）：标记扫描按 EOI 切——规范编码不会出现（FF 填充保证），如实记录语义', () => {
    const s = createMjpegSplitter()
    // 载荷里塞 FFD9：拆帧器视作帧界（文档化行为——ffmpeg image2pipe 是规范编码，实际不触发）
    const frames = s.push(Uint8Array.of(0xff, 0xd8, 0xff, 0xd9, 0x01, 0x02, 0xff, 0xd9))
    expect(frames).toHaveLength(1)
    expect(frames[0]!.length).toBe(4) // SOI+EOI 紧邻成空帧，01 02 归为帧外垃圾
  })
})
