/**
 * mjpeg 边界拆帧器（gui 实况流消费侧）：ffmpeg `-f mjpeg` 管道帧界扫描（SOI=FF D8 / EOI=FF D9）。
 * 本文件是 packages/coordinator/src/gui-stream/splitter.ts 的**手抄对照副本**——渲染层零内核
 * import 的同一纪律（lib/stream.ts 对照 transport stream-protocol 的先例），改那边必须同步这里。
 * 坑记档：FF D9 不可能出现在熵编码段内（JPEG 规范对 0xFF 做 FF 00 填充），标记扫描安全。
 */

const SOI = 0xff
const SOI2 = 0xd8
const EOI2 = 0xd9

export interface MjpegSplitter {
  /** 喂入原始字节；返回本次凑齐的完整 JPEG 帧（按序，SOI..EOI 含两端） */
  push(chunk: Uint8Array): Uint8Array[]
  /** 当前缓冲字节数（不完整帧的暂存；诊断面） */
  readonly buffered: number
  /** 丢弃暂存（流错位自愈） */
  reset(): void
}

export interface MjpegSplitterOptions {
  /** 单帧上限（默认 4MB——超限视为流错位，丢缓冲自愈） */
  maxFrameBytes?: number
}

export function createMjpegSplitter(options: MjpegSplitterOptions = {}): MjpegSplitter {
  const maxFrameBytes = options.maxFrameBytes ?? 4 * 1024 * 1024
  let pending: Uint8Array = new Uint8Array(0)
  /** 是否已在帧内（pending 即 SOI 起的不完整帧；帧外时 pending 只可能是 SOI 前缀 ≤1 字节） */
  let inFrame = false

  const indexOfSeq = (data: Uint8Array, from: number, second: number): number => {
    for (let i = Math.max(from, 0); i + 1 < data.length; i++) {
      if (data[i] === SOI && data[i + 1] === second) return i
    }
    return -1
  }

  return {
    get buffered(): number {
      return pending.length
    },
    reset(): void {
      pending = new Uint8Array(0)
      inFrame = false
    },
    push(chunk: Uint8Array): Uint8Array[] {
      const frames: Uint8Array[] = []
      // pending + chunk 合一后统一扫描（跨块帧在此收敛）；空闲态 pending 只留跨块 SOI 前缀
      let data: Uint8Array
      if (pending.length === 0) {
        data = chunk
      } else {
        data = new Uint8Array(pending.length + chunk.length)
        data.set(pending, 0)
        data.set(chunk, pending.length)
      }
      let i = 0
      if (!inFrame) {
        const soi = indexOfSeq(data, 0, SOI2)
        if (soi < 0) {
          const tail = data[data.length - 1]
          pending = tail === SOI ? Uint8Array.of(tail) : new Uint8Array(0)
          return frames
        }
        i = soi
        inFrame = true
      }
      for (;;) {
        // 帧内找 EOI（从 i+2 起——SOI 自身不可能充当 EOI）
        const eoi = indexOfSeq(data, i + 2, EOI2)
        if (eoi < 0) {
          if (data.length - i > maxFrameBytes) {
            // 超长帧：流错位（如解码端拉走半个帧后重连），丢缓冲自愈不越积越多
            pending = new Uint8Array(0)
            inFrame = false
            return frames
          }
          pending = data.slice(i)
          return frames
        }
        frames.push(data.slice(i, eoi + 2))
        inFrame = false
        // 同一块里还有后续帧：找下一个 SOI 继续
        const soi = indexOfSeq(data, eoi + 2, SOI2)
        if (soi < 0) {
          const tail = data[data.length - 1]
          pending = tail === SOI ? Uint8Array.of(tail) : new Uint8Array(0)
          return frames
        }
        i = soi
        inFrame = true
      }
    },
  }
}
