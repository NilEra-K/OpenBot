/**
 * 拟人轨迹生成器 v2 测试：两层模型各自的硬不变量——
 * 运动学层（所有模式）：样条连续（途经点不停顿）、终点精确、8 点圆近圆、dt 域、
 *   途经点按序被经过（近似——采样不驻留途经点但路径穿过其邻域）；
 * 行为层（human）：花活存在性与触发率（大样本存在性——概率特征不锁单样本）；
 * direct：无花活（首帧即在主轨迹方向）、单点近直线（无侧偏）、快速、绝不过冲。
 */
import { describe, expect, it } from 'vitest'
import { humanTrackPath } from '../src/screen/human-track.js'

const sum = (frames: { dtMs: number }[]): number => frames.reduce((a, f) => a + f.dtMs, 0)

const dist = (a: { x: number; y: number }, b: { x: number; y: number }): number => Math.hypot(a.x - b.x, a.y - b.y)

/** 点到直线（过 a/b 的无限直线）的垂直距离 */
function perpDist(p: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len = Math.hypot(dx, dy)
  if (len === 0) return Math.hypot(p.x - a.x, p.y - a.y)
  return Math.abs(dy * p.x - dx * p.y + b.x * a.y - b.y * a.x) / len
}

describe('通用不变量（direct 与 human 共有）', () => {
  const FROM = { x: 100, y: 100 }
  const PATH = [
    { x: 500, y: 120 },
    { x: 700, y: 400 },
    { x: 300, y: 500 },
  ]

  it('空数组 = 无动作；终点精确对齐', () => {
    expect(humanTrackPath(FROM, [], { seed: 1 })).toEqual([])
    for (const behavior of ['direct', 'human'] as const) {
      for (const seed of [1, 42, 999]) {
        const frames = humanTrackPath(FROM, PATH, { seed, behavior })
        expect(frames[frames.length - 1]).toEqual({ x: 300, y: 500, dtMs: expect.any(Number) })
      }
    }
  })

  it('from≈to 且单点：退化为单帧直达', () => {
    for (const behavior of ['direct', 'human'] as const) {
      expect(humanTrackPath({ x: 100, y: 100 }, [{ x: 100, y: 100 }], { seed: 7, behavior })).toEqual([
        { x: 100, y: 100, dtMs: 16 },
      ])
    }
  })

  it('seed 确定性：同 seed 两次全等；坐标全整（注入侧契约）', () => {
    for (const behavior of ['direct', 'human'] as const) {
      const a = humanTrackPath(FROM, PATH, { seed: 42, behavior })
      expect(a).toEqual(humanTrackPath(FROM, PATH, { seed: 42, behavior }))
      for (const f of a) {
        expect(Number.isInteger(f.x)).toBe(true)
        expect(Number.isInteger(f.y)).toBe(true)
      }
    }
  })

  it('延时域：每帧 dtMs ∈ [8, 120]；帧数 ≥6（不瞬移）且 ≤260（不打爆注入通道）', () => {
    for (const behavior of ['direct', 'human'] as const) {
      for (const seed of [1, 42, 999]) {
        const frames = humanTrackPath(FROM, [{ x: 1900, y: 1000 }], { seed, behavior })
        for (const f of frames) {
          expect(f.dtMs).toBeGreaterThanOrEqual(8)
          expect(f.dtMs).toBeLessThanOrEqual(120)
        }
        expect(frames.length).toBeGreaterThanOrEqual(6)
        expect(frames.length).toBeLessThanOrEqual(260)
      }
    }
  })

  it('途经点按序被经过：路径穿过每个途经点 40px 邻域（采样不驻留——但不停顿地路过）', () => {
    for (const behavior of ['direct', 'human'] as const) {
      const frames = humanTrackPath(FROM, PATH, { seed: 42, behavior })
      const reachIdx = PATH.map((p) => frames.findIndex((f) => dist(f, p) <= 40))
      for (const idx of reachIdx) expect(idx).toBeGreaterThanOrEqual(0)
      for (let i = 1; i < reachIdx.length; i++) expect(reachIdx[i]!).toBeGreaterThan(reachIdx[i - 1]!)
    }
  })

  it('时长近似：sum(dt) ∈ [0.4, 2.5]×显式时长', () => {
    for (const behavior of ['direct', 'human'] as const) {
      for (const durationMs of [300, 1200, 3000]) {
        const frames = humanTrackPath(FROM, [{ x: 700, y: 500 }], { durationMs, seed: 7, behavior })
        expect(sum(frames)).toBeGreaterThanOrEqual(durationMs * 0.4)
        expect(sum(frames)).toBeLessThanOrEqual(durationMs * 2.5)
      }
    }
  })
})

describe('运动学层：样条连续（v2 核心——途经点不停顿）', () => {
  it('中间途经点处速度不归零：帧位移沿程不出现「停顿帧」（相邻帧位移 ≥2px，终点前不含 ≤1px 步）', () => {
    const from = { x: 0, y: 0 }
    const path = [
      { x: 400, y: 0 },
      { x: 800, y: 300 },
      { x: 300, y: 600 },
    ]
    for (const behavior of ['direct', 'human'] as const) {
      const frames = humanTrackPath(from, path, { seed: 42, behavior, durationMs: 1500 })
      // 主轨迹帧（排除首部花活与尾部 settle/回拉小步）：取中段 80% 段落
      const core = frames.slice(Math.floor(frames.length * 0.1), Math.floor(frames.length * 0.9))
      for (let i = 1; i < core.length; i++) {
        expect(dist(core[i]!, core[i - 1]!)).toBeGreaterThanOrEqual(2)
      }
    }
  })

  it('8 点圆路径近圆：帧到圆心距离的离散度小（Catmull-Rom 平滑穿过圆周点）', () => {
    const cx = 640
    const cy = 400
    const r = 200
    const circle = Array.from({ length: 8 }, (_, i) => ({
      x: cx + r * Math.cos((i / 8) * 2 * Math.PI),
      y: cy + r * Math.sin((i / 8) * 2 * Math.PI),
    }))
    const frames = humanTrackPath({ x: cx, y: cy }, circle, { seed: 42, behavior: 'direct', durationMs: 2400 })
    // 排除前 15%（圆心→圆周的进场段）后统计：平滑圆的半径离散应显著小
    const rs = frames.slice(Math.floor(frames.length * 0.15)).map((f) => dist(f, { x: cx, y: cy }))
    const mean = rs.reduce((a, b) => a + b, 0) / rs.length
    const varr = rs.reduce((a, b) => a + (b - mean) ** 2, 0) / rs.length
    expect(Math.sqrt(varr)).toBeLessThanOrEqual(mean * 0.2 + 15)
  })
})

describe('direct 模式（缺省——利落直达）', () => {
  it('单点近直线：帧离起终点直线 ≤2px（无侧向扰动）；快速（80+0.3/px 量级）', () => {
    const from = { x: 100, y: 100 }
    const to = { x: 900, y: 500 }
    for (const seed of [1, 2, 3]) {
      const frames = humanTrackPath(from, [to], { seed })
      for (const f of frames) expect(perpDist(f, from, to)).toBeLessThanOrEqual(2)
      // 800px 距离 → ~320ms 自适应（钳 [100,1500]）
      expect(sum(frames)).toBeLessThanOrEqual(700)
      expect(sum(frames)).toBeGreaterThanOrEqual(80)
    }
  })

  it('无花活：首帧即在主轨迹方向上（距起点 >0 且偏向目标——不是原地打转）', () => {
    const from = { x: 0, y: 0 }
    const to = { x: 600, y: 0 }
    for (let seed = 0; seed < 10; seed++) {
      const frames = humanTrackPath(from, [to], { seed })
      const first = frames[0]!
      expect(first.x).toBeGreaterThan(0) // 朝目标起步
      expect(Math.abs(first.y)).toBeLessThanOrEqual(2) // 无侧偏
    }
  })

  it('绝不过冲：全部帧不超过终点（沿直线投影 ≤ 距离+1px 容差）', () => {
    const from = { x: 0, y: 0 }
    const to = { x: 800, y: 0 }
    for (let seed = 0; seed < 20; seed++) {
      const frames = humanTrackPath(from, [to], { seed })
      for (const f of frames) expect(f.x).toBeLessThanOrEqual(to.x + 1)
    }
  })
})

describe('human 模式（行为层——每次随机抽取）', () => {
  const FROM = { x: 300, y: 300 }
  const TO = { x: 1000, y: 600 }

  it('花活存在性与触发率：100 个 seed 中 25%~85% 的轨迹带起手花活（权重 65%）', () => {
    let flourished = 0
    for (let seed = 0; seed < 100; seed++) {
      const frames = humanTrackPath(FROM, [TO], { seed, behavior: 'human' })
      // 花活特征：存在「远离起点→终点连线 >25px」的前置帧（主轨迹侧偏 ≤3%≈20px）
      const has = frames.some((f, i) => i < frames.length / 3 && perpDist(f, FROM, TO) > 25)
      if (has) flourished += 1
    }
    expect(flourished).toBeGreaterThanOrEqual(25)
    expect(flourished).toBeLessThanOrEqual(85)
  })

  it('花活幅度（2026-11-01 调优后）：样本中存在明显起手位移（maxPre >50px）且幅度有离散（非恒定）', () => {
    const maxes: number[] = []
    for (let seed = 0; seed < 60; seed++) {
      const frames = humanTrackPath(FROM, [TO], { seed, behavior: 'human' })
      const pre = frames.slice(0, Math.max(3, Math.floor(frames.length / 4)))
      maxes.push(Math.max(...pre.map((f) => dist(f, FROM))))
    }
    expect(maxes.some((m) => m > 50)).toBe(true) // 幅度调优后起手花活肉眼可见
    const uniq = new Set(maxes.map((m) => Math.round(m / 10))) // 10px 分桶
    expect(uniq.size).toBeGreaterThanOrEqual(3) // 幅度分布离散（随机性仍在）
  })

  it('路径有界：帧离起终点直线 ≤ 8%·d + 170px（花活最大半径 150 + 侧偏 + 过冲的总上界——出屏由注入侧钳制兜底）', () => {
    const d = dist(FROM, TO)
    for (const seed of [1, 2, 3, 4, 5]) {
      for (const f of humanTrackPath(FROM, [TO], { seed, behavior: 'human' })) {
        expect(perpDist(f, FROM, TO)).toBeLessThanOrEqual(d * 0.08 + 170)
      }
    }
  })

  it('过冲仅在远距出现且终点回拉精确：末帧=终点（对齐兜底）', () => {
    for (let seed = 0; seed < 30; seed++) {
      const frames = humanTrackPath(FROM, [TO], { seed, behavior: 'human' })
      const last = frames[frames.length - 1]!
      expect(last.x).toBe(TO.x)
      expect(last.y).toBe(TO.y)
    }
  })
})
