/**
 * H.264 Annex B 流解析器（gui 实况流 h264 引擎消费侧）：把 ffmpeg `-f h264` 的裸字节流
 * 按访问单元（AU = 一帧）切块，喂 WebCodecs VideoDecoder。
 *
 * 术语与策略（zerolatency 特化）：x264 zerolatency 无 B 帧——解码序 = 显示序。AU 边界按
 * VCL slice header 的 **first_mb_in_slice** 判定（0 = 新帧首 slice，≠0 = 同帧后续 slice——
 * ultrafast 默认 sliced-threads 会把一帧切成多 slice NALU，真机首证 510 AU vs 预期 180 帧）；
 * 解析 ue(v)（exp-Golomb）定位该值，失败保守按新 AU。VCL type=5 → 'key'，type=1 → 'delta'。
 * **AU 完成时机 = 新帧首 slice 的 start code 可见**（流式固有的一帧延迟），或 flush()
 * （流收尾——尾 NALU 按完整论收口，最后一帧不丢）。
 * 非 VCL（SPS=7/PPS=8/SEI=6/AUD=9…）拼进所在 AU。
 * 纯函数状态机零依赖；服务端不解析 h264（纯字节搬运），本文件只在 renderer 存在。
 */

export interface H264Au {
  /** 'key' = IDR 帧（解码器需要/恢复点），'delta' = 非 IDR 帧 */
  type: 'key' | 'delta'
  /** AU 全部字节（含前缀 SPS/PPS/SEI 与 VCL；Annex B start code 原样保留） */
  data: Uint8Array
}

export interface H264Parser {
  /** 喂入原始字节；返回本次凑齐的完整 AU（按序；尾 AU 等下一块佐证或 flush()） */
  push(chunk: Uint8Array): H264Au[]
  /** 流收尾：暂存中已见 VCL 的 AU 按完整论强制吐出（END 前调一次——最后一帧不丢） */
  flush(): H264Au[]
  /** 当前缓冲字节数（不完整 AU 的暂存；诊断面） */
  readonly buffered: number
  /** 丢弃暂存（流错位自愈——下次 IDR 重新同步由服务端 -g 保证 ≤0.5s） */
  reset(): void
}

const VCL_MIN = 1
const VCL_MAX = 5
const IDR_NAL_TYPE = 5

export function createH264Parser(): H264Parser {
  let pending: Uint8Array = new Uint8Array(0)

  /**
   * 扫描一段流：吐出能确定的 AU。流式边界原则：AU 的完成由「下一个 VCL 的 start code」
   * 佐证——rest 恒从最后一个已完成 AU 的终点起（前缀/未定尾 NALU 全量带回，下一轮重扫）。
   * final=true（flush）：尾 NALU 按完整论收口（无后继佐证也吐出）。
   */
  const consume = (data: Uint8Array, final: boolean): { rest: Uint8Array; aus: H264Au[] } => {
    const aus: H264Au[] = []
    let i = findStartCode(data, 0)
    if (i < 0) return { rest: data, aus }
    // 首个 start code 之前的垃圾字节丢弃（流错位容忍——Annex B 任意前缀非法）
    const parts: Uint8Array[] = []
    let auBytes = 0
    let auType: 'key' | 'delta' | null = null
    let sawVcl = false
    let lastAuEnd = 0 // 最后一个已完成 AU 的终点（rest 起点）

    const closeAu = (): void => {
      if (!sawVcl) return // 纯前缀不成 AU（并入下一个 AU）
      const out = new Uint8Array(auBytes)
      let off = 0
      for (const p of parts) {
        out.set(p, off)
        off += p.length
      }
      aus.push({ type: auType!, data: out })
      parts.length = 0
      auBytes = 0
      auType = null
      sawVcl = false
    }

    for (;;) {
      const nalStart = i + startCodeLen(data, i)
      if (nalStart >= data.length) break // NALU 头跨块
      const nalType = data[nalStart]! & 0x1f
      const next = findStartCode(data, nalStart)
      const tailNal = next < 0
      const nalu = tailNal ? data.subarray(i) : data.subarray(i, next)
      const isVcl = nalType >= VCL_MIN && nalType <= VCL_MAX
      if (isVcl && sawVcl && firstMbInSlice(nalu) === 0) {
        // 新帧首 slice（first_mb=0）：上一 AU 完成，终点 = 当前 NALU 的 start code。
        // ≠0 是同帧后续 slice（sliced-threads）——并入当前 AU 不切分。
        // first_mb 解析失败（null）保守按新 AU（解码端丢弃残帧好过同帧粘死）
        closeAu()
        lastAuEnd = i
      }
      parts.push(nalu)
      auBytes += nalu.length
      if (isVcl) {
        auType = nalType === IDR_NAL_TYPE ? 'key' : 'delta'
        sawVcl = true
      }
      if (tailNal) {
        if (final) {
          closeAu() // 收尾：尾 NALU（可能不完整）按完整论归属当前 AU
          lastAuEnd = data.length
        }
        break
      }
      i = next
    }
    return { rest: data.slice(lastAuEnd), aus }
  }

  return {
    get buffered(): number {
      return pending.length
    },
    reset(): void {
      pending = new Uint8Array(0)
    },
    push(chunk: Uint8Array): H264Au[] {
      // pending + chunk 合一统一扫描（跨块 start code/NALU 在此收敛）
      let data: Uint8Array
      if (pending.length === 0) {
        data = chunk
      } else {
        data = new Uint8Array(pending.length + chunk.length)
        data.set(pending, 0)
        data.set(chunk, pending.length)
      }
      const { rest, aus } = consume(data, false)
      pending = rest
      return aus
    },
    flush(): H264Au[] {
      const { rest, aus } = consume(pending, true)
      void rest
      pending = new Uint8Array(0)
      return aus
    },
  }
}

/** 找下一个 Annex B start code（00 00 01；前面多一个 00 属于 start code——返回首个 00 的位置） */
function findStartCode(data: Uint8Array, from: number): number {
  for (let i = Math.max(from, 0); i + 2 < data.length; i++) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
      // 回退前置 0（00 00 00 01 的第 4 个 0 属于 start code）
      let start = i
      while (start > from && data[start - 1] === 0) start--
      return start
    }
  }
  return -1
}

/** i 处 start code 的实际长度（前导 0 数量 + 1 字节 01；扫描保证 01 在场） */
function startCodeLen(data: Uint8Array, i: number): number {
  let j = i
  while (j < data.length && data[j] === 0) j++
  return j - i + 1
}

/**
 * VCL NALU 的 first_mb_in_slice（slice header 首个 ue(v) 语法元素；H.264 spec §7.3.2.1）：
 * 0 = 新帧首 slice，≠0 = 同帧后续 slice（sliced-threads 切片）。解析失败（截断/位异常）
 * 返回 null——调用方保守按新 AU。
 * 实现：定位 NALU 头后 payload → 去 emulation prevention（00 00 03 → 00 00）→ 位读 ue(v)。
 * first_mb 值小（1080p ≤ 8160，ue ≤ 25 位）——取 payload 前 8 字节足够。
 */
function firstMbInSlice(nalu: Uint8Array): number | null {
  // 定位 start code 的 01 字节，其后一字节是 NALU 头，再后是 slice payload
  let scEnd = -1
  for (let k = 0; k + 1 < nalu.length; k++) {
    if (nalu[k] === 0 && nalu[k + 1] === 1) {
      scEnd = k + 1
      break
    }
  }
  if (scEnd < 0 || scEnd + 2 >= nalu.length) return null
  // 取 payload 前 8 字节（去 EP3）——scEnd 是 start code '01' 的下标，其后依次是
  // NALU 头（1 字节）与 slice payload 位流
  const bytes: number[] = []
  let p = scEnd + 2
  while (p < nalu.length && bytes.length < 8) {
    if (p + 2 < nalu.length && nalu[p] === 0 && nalu[p + 1] === 0 && nalu[p + 2] === 3) {
      bytes.push(0, 0)
      p += 3
    } else {
      bytes.push(nalu[p]!)
      p += 1
    }
  }
  if (bytes.length === 0) return null
  // 位读 ue(v)：前导零 n + 终止 1 + n 位数值位——ue 值 = 读数(n+1 位) - 1
  const bit = (pos: number): number => ((bytes[pos >> 3] ?? 0) >> (7 - (pos & 7))) & 1
  const totalBits = bytes.length * 8
  let pos = 0
  let zeros = 0
  while (pos < totalBits && bit(pos) === 0) {
    zeros++
    pos++
    if (zeros > 24) return null // first_mb 上界内的 ue 前导零远小于此——异常流
  }
  if (pos + zeros > totalBits) return null
  let value = 1 // 终止 1 就是数值最高位（ue(0) = '1' → 值 0）
  pos++
  for (let k = 0; k < zeros; k++) {
    value = (value << 1) | bit(pos)
    pos++
  }
  return value - 1
}
