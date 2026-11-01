/**
 * 拟人鼠标轨迹生成器 v2（computer_move）：纯函数，输入起终点序列输出帧序列
 * [{x, y, dtMs}]——注入节拍归各适配器（X11 = shell 循环 sleep；Windows PS = s| 行），
 * 生成器只负责「怎么走」。
 *
 * v2 两层模型（用户裁定）：
 * - **运动学层（所有模式）**：途经点 Catmull-Rom 样条插值 + 弧长参数化 + 整条速度剖面
 *   ——连续曲线、途经点速度不归零（转圈不再「一段一段走」）；这是运动正确性，不是装饰。
 * - **行为层（human 模式）**：起手花活库（spin 甩圈 / jitter 乱晃 / flick 探缩 / none，
 *   每次加权随机抽取）+ 连续侧向扰动 + 末段过冲回拉 + 到位 settle——「这个 agent 用鼠标
 *   像什么样的人」。direct 模式（缺省）= 利落直达：无花活无扰动，快速近直线。
 *
 * 纯度纪律：seed 注入则完全确定（单测）；缺省随机派生——生产语义就是「每次不一样」。
 * 坐标输出取整（注入侧只有整数像素）。
 */

/** 轨迹一帧：位置 + 相对前一帧的延时（首帧 dtMs = 起手前的迟疑） */
export interface TrackFrame {
  x: number
  y: number
  dtMs: number
}

/** 移动行为模式：direct=利落直达（缺省）；human=拟人移动（花活+弧线+变速，每次随机） */
export type MoveBehavior = 'direct' | 'human'

export interface HumanTrackOptions {
  /** 行为模式（缺省 direct——什么都不传就是直接移动过去） */
  behavior?: MoveBehavior
  /** 主轨迹时长毫秒（human 模式下花活时长另计；缺省按距离自适应） */
  durationMs?: number
  /** 随机种子（单测确定性；缺省随机派生） */
  seed?: number
}

/** mulberry32：32 位种子 → [0,1) 均匀流（体积小、可注入——够用，不引依赖） */
function rngOf(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 最小急度进度剖面（u∈[0,1]→弧长进度；端点速度零、中段平坦近巡航——整条统一，途经点不停顿） */
const minJerk = (u: number): number => 10 * u ** 3 - 15 * u ** 4 + 6 * u ** 5

interface Pt {
  x: number
  y: number
}

// ---------------------------------------------------------------------------
// Catmull-Rom（centripetal 参数化——途经点不均匀时不打结）+ 弧长重采样
// ---------------------------------------------------------------------------

/** 密集采样样条为折线（每段 ceil(len/6)+2 点——后续弧长重采样的基） */
function splinePolyline(pts: Pt[]): Pt[] {
  if (pts.length < 2) return [...pts]
  // 端点补虚拟控制点（复制端点——自然边界，曲线过首尾）
  const p = [pts[0]!, ...pts, pts[pts.length - 1]!]
  const out: Pt[] = []
  // centripetal 节点参数：t_i = t_{i-1} + |P_i - P_{i-1}|^0.5
  const ts = [0]
  for (let i = 1; i < p.length; i++) {
    ts.push(ts[i - 1]! + Math.sqrt(Math.hypot(p[i]!.x - p[i - 1]!.x, p[i]!.y - p[i - 1]!.y)) + 1e-9)
  }
  for (let i = 0; i + 3 < p.length; i++) {
    const [p0, p1, p2, p3] = [p[i]!, p[i + 1]!, p[i + 2]!, p[i + 3]!]
    const segLen = Math.hypot(p2.x - p1.x, p2.y - p1.y)
    const n = Math.max(2, Math.ceil(segLen / 6))
    for (let k = 0; k < n; k++) {
      const t = k / n
      // 标准Catmull-Rom（uniform 权重 + centripetal 间距已被采样密度吸收——段内均匀插值）
      const t2 = t * t
      const t3 = t2 * t
      out.push({
        x: 0.5 * (2 * p1.x + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
        y: 0.5 * (2 * p1.y + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
      })
    }
  }
  out.push({ ...pts[pts.length - 1]! })
  return out
}

/** 弧长均匀重采样 + 速度剖面：polyline 上按 minJerk(u)·总弧长取点（u=i/n，i=1..n——首帧即起步） */
function profiledFrames(poly: Pt[], n: number): Array<{ x: number; y: number }> {
  const cum = [0]
  for (let i = 1; i < poly.length; i++) {
    cum.push(cum[i - 1]! + Math.hypot(poly[i]!.x - poly[i - 1]!.x, poly[i]!.y - poly[i - 1]!.y))
  }
  const total = cum[cum.length - 1]!
  const atArc = (s: number): Pt => {
    // 二分找段 + 段内线性插值
    let lo = 0
    let hi = cum.length - 1
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1
      if (cum[mid]! <= s) lo = mid
      else hi = mid
    }
    const segLen = cum[lo + 1]! - cum[lo]!
    const t = segLen > 0 ? (s - cum[lo]!) / segLen : 0
    return {
      x: poly[lo]!.x + (poly[lo + 1]!.x - poly[lo]!.x) * t,
      y: poly[lo]!.y + (poly[lo + 1]!.y - poly[lo]!.y) * t,
    }
  }
  const out: Array<{ x: number; y: number }> = []
  for (let i = 1; i <= n; i++) out.push(atArc(total * minJerk(i / n)))
  return out
}

// ---------------------------------------------------------------------------
// 行为层（human 模式）：起手花活库 + settle
// ---------------------------------------------------------------------------

/** 花活帧（起手习惯）：none 35% / spin 20% / jitter 25% / flick 20%——返回空 = 直接走。
 *  坐标为绝对位置（origin = 当前光标位置） */
function flourish(rng: () => number, targetDir: Pt, origin: Pt): TrackFrame[] {
  const roll = rng()
  if (roll < 0.35) return []
  if (roll < 0.55) return spinFlourish(rng, origin)
  if (roll < 0.8) return jitterFlourish(rng, origin)
  return flickFlourish(rng, targetDir, origin)
}

/** spin：以起点为心快速甩一圈（半径螺旋进出——起收平滑不跳变）。
 *  幅度（2026-11-01 真机反馈调优）：半径 60~150px（原 25~70 显小）——屏上显眼的一圈；
 *  圈大时长随之放宽 350~650ms，帧数加稠保持圆滑 */
function spinFlourish(rng: () => number, c: Pt): TrackFrame[] {
  const r = 60 + rng() * 90
  const dir = rng() < 0.5 ? 1 : -1
  const sweep = (0.8 + rng() * 0.6) * 2 * Math.PI
  const theta0 = rng() * 2 * Math.PI
  const totalMs = 350 + rng() * 300
  const n = 14 + Math.floor(rng() * 8)
  const frames: TrackFrame[] = []
  for (let i = 1; i <= n; i++) {
    const u = i / n
    const radius = r * Math.sin(Math.min(u * 1.25, 1) * Math.PI * 0.5) * (u > 0.8 ? (1 - u) / 0.2 : 1)
    const theta = theta0 + dir * sweep * u
    frames.push({
      x: Math.round(c.x + radius * Math.cos(theta)),
      y: Math.round(c.y + radius * Math.sin(theta)),
      dtMs: Math.round(totalMs / n),
    })
  }
  return frames
}

/** jitter：3~6 次随机方向脉冲（相邻方向夹角 >60°——「甩手找手感」不是抖动）。
 *  幅度（2026-11-01 真机反馈调优）：脉冲 40~100px（原 15~50）——晃动感明显；节奏稍缓 */
function jitterFlourish(rng: () => number, origin: Pt): TrackFrame[] {
  const pulses = 3 + Math.floor(rng() * 4)
  let cur = { x: origin.x, y: origin.y }
  let prevAngle = rng() * 2 * Math.PI
  const frames: TrackFrame[] = []
  for (let i = 0; i < pulses; i++) {
    // 拒绝采样：新方向与上一方向夹角 >60°
    let angle = prevAngle
    for (let tries = 0; tries < 8 && Math.abs(((angle - prevAngle + Math.PI * 3) % (Math.PI * 2)) - Math.PI) < Math.PI / 3; tries++) {
      angle = rng() * 2 * Math.PI
    }
    prevAngle = angle
    const d = 40 + rng() * 60
    const steps = 2
    for (let s = 1; s <= steps; s++) {
      cur = { x: cur.x + (Math.cos(angle) * d) / steps, y: cur.y + (Math.sin(angle) * d) / steps }
      frames.push({ x: Math.round(cur.x), y: Math.round(cur.y), dtMs: 50 + Math.floor(rng() * 40) })
    }
  }
  return frames
}

/** flick：朝目标方向快速探一下又缩回（「伸手又收回」）。幅度（2026-11-01 调优）：70~140px */
function flickFlourish(rng: () => number, dir: Pt, origin: Pt): TrackFrame[] {
  const d = 70 + rng() * 70
  const back = { x: origin.x + (rng() * 2 - 1) * 10, y: origin.y + (rng() * 2 - 1) * 10 }
  return [
    { x: Math.round(origin.x + (dir.x * d) / 2), y: Math.round(origin.y + (dir.y * d) / 2), dtMs: 80 },
    { x: Math.round(origin.x + dir.x * d), y: Math.round(origin.y + dir.y * d), dtMs: 80 },
    { x: Math.round(origin.x + (dir.x * d) / 3), y: Math.round(origin.y + (dir.y * d) / 3), dtMs: 90 },
    { x: Math.round(back.x), y: Math.round(back.y), dtMs: 90 },
  ]
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

const DT_MIN = 8
const DT_MAX = 120

/**
 * 生成移动轨迹。points 为途经点序列（末点停留）；空数组 = 无动作。
 * 行为模式见 MoveBehavior——缺省 direct（利落直达，什么都不传就是直接移动过去）。
 */
export function humanTrackPath(from: Pt, points: Array<Pt>, opts: HumanTrackOptions = {}): TrackFrame[] {
  if (points.length === 0) return []
  const rng = rngOf(opts.seed ?? (Math.random() * 0xffffffff) >>> 0)
  const behavior = opts.behavior ?? 'direct'
  const dest = points[points.length - 1]!
  if (Math.hypot(dest.x - from.x, dest.y - from.y) < 1 && points.length === 1) {
    return [{ x: Math.round(dest.x), y: Math.round(dest.y), dtMs: 16 }]
  }

  // ---- 1. 起手花活（human）——末帧位置即主轨迹实际起点（连续不跳变） ----
  const firstDirRaw = { x: points[0]!.x - from.x, y: points[0]!.y - from.y }
  const firstDirLen = Math.hypot(firstDirRaw.x, firstDirRaw.y) || 1
  const firstDir = { x: firstDirRaw.x / firstDirLen, y: firstDirRaw.y / firstDirLen }
  const pre = behavior === 'human' ? flourish(rng, firstDir, from) : []
  const origin = pre.length > 0 ? pre[pre.length - 1]! : from
  const preMs = pre.reduce((a, f) => a + f.dtMs, 0)

  // ---- 2. 末段过冲（human + 末段远）：样条终点沿末段方向延伸，回拉帧收尾 ----
  const prevOfLast = points.length > 1 ? points[points.length - 2]! : origin
  const lastSeg = Math.hypot(dest.x - prevOfLast.x, dest.y - prevOfLast.y)
  const overshoot =
    behavior === 'human' && lastSeg > 260 && rng() < 0.35 ? lastSeg * (0.02 + rng() * 0.04) : 0
  const endDirRaw = { x: dest.x - prevOfLast.x, y: dest.y - prevOfLast.y }
  const endDirLen = Math.hypot(endDirRaw.x, endDirRaw.y) || 1
  const splinePts: Pt[] =
    overshoot > 0
      ? [origin, ...points, { x: dest.x + (endDirRaw.x / endDirLen) * overshoot, y: dest.y + (endDirRaw.y / endDirLen) * overshoot }]
      : [origin, ...points]

  // ---- 3. 样条主轨迹（弧长参数化 + minJerk 整条剖面——途经点不停顿） ----
  const poly = splinePolyline(splinePts)
  const totalLen = (() => {
    let s = 0
    for (let i = 1; i < poly.length; i++) s += Math.hypot(poly[i]!.x - poly[i - 1]!.x, poly[i]!.y - poly[i - 1]!.y)
    return s
  })()
  const mainMs =
    opts.durationMs !== undefined
      ? // 显式全程预算扣花活（主轨迹保底 60%——花活不喧宾夺主）
        behavior === 'human'
        ? Math.max(Math.round(opts.durationMs - preMs), Math.round(opts.durationMs * 0.6))
        : Math.trunc(opts.durationMs)
      : behavior === 'human'
        ? Math.min(Math.max(Math.round(140 + totalLen * 0.55), 180), 3000)
        : Math.min(Math.max(Math.round(80 + totalLen * 0.3), 100), 1500)
  const frameMs = behavior === 'direct' ? 12 : 16
  const n = Math.min(Math.max(Math.round(mainMs / frameMs), 6), 200)
  const dt = Math.min(Math.max(Math.round(mainMs / n), DT_MIN), DT_MAX)
  const main = profiledFrames(poly, n)

  // ---- 4. 侧向扰动（human）：低频正弦叠加（首末帧不加——端点精确） ----
  const dirRaw = { x: dest.x - origin.x, y: dest.y - origin.y }
  const dirLen = Math.hypot(dirRaw.x, dirRaw.y) || 1
  const perp = { x: -dirRaw.y / dirLen, y: dirRaw.x / dirLen }
  const amp = behavior === 'human' ? totalLen * (0.01 + rng() * 0.02) : 0
  const freq = 1 + Math.floor(rng() * 2)
  const phase = rng() * 2 * Math.PI
  const frames: TrackFrame[] = pre.map((f) => ({ ...f }))
  for (let i = 0; i < main.length; i++) {
    const p = main[i]!
    const isLast = i === main.length - 1
    let x = p.x
    let y = p.y
    if (amp > 0 && !isLast) {
      const wob = amp * Math.sin(2 * Math.PI * (freq * ((i + 1) / main.length) + phase))
      x += perp.x * wob
      y += perp.y * wob
    }
    frames.push({ x: Math.round(x), y: Math.round(y), dtMs: dt })
  }

  // ---- 5. 过冲回拉（human）：快速小步回到真终点 ----
  if (overshoot > 0) {
    const fixN = 2 + Math.floor(rng() * 2)
    const over = frames[frames.length - 1]!
    for (let i = 1; i <= fixN; i++) {
      const t = i / fixN
      frames.push({
        x: Math.round(over.x + (dest.x - over.x) * t + (rng() * 2 - 1)),
        y: Math.round(over.y + (dest.y - over.y) * t + (rng() * 2 - 1)),
        dtMs: 50,
      })
    }
  }

  // ---- 6. settle（human，40%）：到位微调 ±1~3px，末帧精确对齐 ----
  if (behavior === 'human' && rng() < 0.4) {
    frames.push({ x: Math.round(dest.x + (rng() * 6 - 3)), y: Math.round(dest.y + (rng() * 6 - 3)), dtMs: 40 })
  }
  const last = frames[frames.length - 1]!
  last.x = Math.round(dest.x)
  last.y = Math.round(dest.y)
  return frames
}
