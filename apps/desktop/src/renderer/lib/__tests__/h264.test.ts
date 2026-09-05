/**
 * H.264 Annex B 解析器测试：合成 NALU 字节流验证 AU 边界状态机——
 * start code 3/4 字节两态、SPS/PPS/SEI 前缀归属、IDR→key / 非 IDR→delta、
 * 跨块 NALU 收敛、前缀先行（无 VCL 不成 AU 并入下一帧）、reset 自愈。
 * NALU 头首字节低 5 位 = nal_type（合成流只保证这 5 位语义，其余位随意）。
 */
import { describe, expect, it } from 'vitest'
import { createH264Parser } from '../h264'

const SC4 = [0x00, 0x00, 0x00, 0x01]
const SC3 = [0x00, 0x00, 0x01]

/** 合成一个 NALU（start code + 头字节 + 载荷）——NALU 头：ref_idc(2bit)<<5 | type(5bit)。
 *  VCL 载荷首字节默认 0x80（ue 首位 1 = first_mb_in_slice 0——新帧首 slice，真实 x264 形状） */
const nal = (type: number, payload: number[] = [], sc: number[] = SC4): Uint8Array =>
  Uint8Array.of(...sc, 0x60 | (type & 0x1f), ...payload)

/** 同帧后续 slice（first_mb≠0：ue(1) = '010' → 载荷首字节 0x40） */
const nalContSlice = (type: number, payload: number[] = [], sc: number[] = SC4): Uint8Array =>
  Uint8Array.of(...sc, 0x60 | (type & 0x1f), 0x40, ...payload)

/** SPS(7) + PPS(8) + IDR(5) 的典型关键帧 AU（x264 zerolatency 首帧形状） */
const idrAu = (): Uint8Array => {
  const parts = [nal(7, [0x67, 0x42]), nal(8, [0x68, 0xce]), nal(5, [0x80, 0x11, 0x22])]
  const len = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(len)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

/** 非 IDR VCL（type 1）AU */
const deltaAu = (): Uint8Array => nal(1, [0x80, 0x9a])

describe('h264 Annex B 解析器', () => {
  it('典型首帧（SPS+PPS+IDR 4 字节 start code）→ 单个 key AU（流式：下一块佐证或 flush 收尾）', () => {
    const p = createH264Parser()
    expect(p.push(idrAu())).toEqual([]) // 尾 NALU 边界未定——流式延迟一帧
    expect(p.push(deltaAu())).toHaveLength(1) // 下一 AU 首字节佐证 → 前一 AU 吐出
    p.reset()
    const aus = [...p.push(idrAu()), ...p.flush()]
    expect(aus).toHaveLength(1)
    expect(aus[0]!.type).toBe('key')
    expect([...aus[0]!.data]).toEqual([...idrAu()])
    expect(p.buffered).toBe(0)
  })

  it('delta 帧（type 1）→ delta AU；IDR/SLICE 交替 type 正确', () => {
    const p = createH264Parser()
    const aus = [...p.push(Uint8Array.of(...idrAu(), ...deltaAu(), ...deltaAu())), ...p.flush()]
    expect(aus).toHaveLength(3)
    expect(aus.map((a) => a.type)).toEqual(['key', 'delta', 'delta'])
  })

  it('3 字节 start code 与 4 字节混用：均正确切分', () => {
    const p = createH264Parser()
    const mixed = Uint8Array.of(...nal(7, [0x67]), ...nal(8, [0x68], SC3), ...nal(5, [0x11], SC3))
    const aus = [...p.push(mixed), ...p.flush()]
    expect(aus).toHaveLength(1)
    expect(aus[0]!.type).toBe('key')
    expect(aus[0]!.data.length).toBe(mixed.length)
  })

  it('流按任意字节边界切块：AU 序列收敛（逐偏移遍历强性质，flush 收尾）', () => {
    const whole = Uint8Array.of(...idrAu(), ...deltaAu(), ...deltaAu())
    for (let n = 1; n <= whole.length + 1; n++) {
      const p = createH264Parser()
      const aus: ReturnType<typeof p.push> = []
      for (let off = 0; off < whole.length; off += n) {
        aus.push(...p.push(whole.subarray(off, Math.min(off + n, whole.length))))
      }
      aus.push(...p.flush())
      expect(aus, `块大小 ${n}`).toHaveLength(3)
      expect(aus.map((a) => a.type), `块大小 ${n}`).toEqual(['key', 'delta', 'delta'])
      expect([...aus[0]!.data], `块大小 ${n}`).toEqual([...idrAu()])
      expect([...aus[2]!.data], `块大小 ${n}`).toEqual([...deltaAu()])
    }
  })

  it('前缀先行（SPS/PPS 无 VCL）：不成 AU，并入下一个 VCL 帧', () => {
    const p = createH264Parser()
    const prefix = Uint8Array.of(...nal(7, [0x67]), ...nal(8, [0x68]))
    expect(p.push(prefix)).toEqual([]) // 只有前缀——无 AU
    expect(p.buffered).toBe(prefix.length)
    const aus = [...p.push(deltaAu()), ...p.flush()]
    expect(aus).toHaveLength(1)
    expect(aus[0]!.type).toBe('delta')
    expect(aus[0]!.data.length).toBe(prefix.length + deltaAu().length) // 前缀并入
  })

  it('尾部不完整 NALU：滞留等待下一块续齐', () => {
    const p = createH264Parser()
    const au = idrAu()
    const cut = au.length - 2 // IDR NALU 尾部 2 字节跨块
    expect(p.push(au.subarray(0, cut))).toEqual([])
    const aus = p.push(au.subarray(cut))
    expect(aus).toEqual([]) // 整 AU 现在完整但尾 NALU 边界仍未定（流式）
    expect([...p.flush()[0]!.data]).toEqual([...au])
  })

  it('start code 自身跨块（00 00 / 00 01）：收敛', () => {
    const p = createH264Parser()
    const au = Uint8Array.of(...SC4, 0x65, 0xaa) // IDR 短 NALU
    const cut = 2 // SC4 的第 3 字节落下一块
    expect(p.push(au.subarray(0, cut))).toEqual([]) // [0,0]——半个 start code
    expect(p.push(au.subarray(cut))).toEqual([]) // [0,1,0x65,0xaa]——SC 拼回 + VCL（流式：尾无佐证不吐）
    const tail = p.flush() // flush 收尾吐出
    expect(tail).toHaveLength(1)
    expect(tail[0]!.type).toBe('key')
    expect(p.buffered).toBe(0)
  })

  it('同帧多 slice（sliced-threads，first_mb≠0）：并入同 AU 不切分', () => {
    const p = createH264Parser()
    // 一帧 = 首 slice(first_mb=0) + 两个后续 slice(first_mb≠0)，全 type 1
    const frame = Uint8Array.of(
      ...nal(1, [0x80, 0xaa]),
      ...nalContSlice(1, [0x00, 0x15]),
      ...nalContSlice(1, [0x00, 0x0a]),
    )
    const aus = [...p.push(frame), ...p.flush()]
    expect(aus).toHaveLength(1) // 三 slice 同帧——单 AU
    expect(aus[0]!.type).toBe('delta')
    expect(aus[0]!.data.length).toBe(frame.length)
  })

  it('reset：显式丢弃暂存（错位自愈面）', () => {
    const p = createH264Parser()
    p.push(nal(7, [0x67]))
    expect(p.buffered).toBeGreaterThan(0)
    p.reset()
    expect(p.buffered).toBe(0)
  })
})
