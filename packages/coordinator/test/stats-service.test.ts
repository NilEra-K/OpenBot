/**
 * StatsService 测试（plan-p3 Step 6）：轮询遥测、压力状态机（转移才发）、探针失败静默。
 * 与 shell-service 同测试哲学：backend/探针全注入替身，零真实文件系统与时钟。
 */
import { describe, expect, it, vi } from 'vitest'
import { EventBus } from '@openbot/core'
import { MockBoxBackend } from '@openbot/boxes'
import { StatsService } from '../src/stats-service/index.js'
import type { DiskFact } from '../src/stats-service/index.js'

const setup = (diskProbe?: () => Promise<DiskFact | null>) => {
  const bus = new EventBus({ now: () => 0 })
  const events: Array<{ type: string; payload: unknown }> = []
  bus.on('*', (e) => events.push({ type: e.type, payload: e.payload }))
  const backend = new MockBoxBackend({ now: () => 0 })
  return { bus, events, backend, diskProbe }
}

describe('StatsService', () => {
  it('poll 逐盒发 v1.box.stats（字段原样透传——缺席语义在字段层）', async () => {
    const { bus, events, backend } = setup()
    await backend.create({ image: 'default' })
    await backend.create({ image: 'default' })
    const svc = new StatsService({ backend, boxIds: () => ['box-1', 'box-2'], bus })
    await svc.poll()
    const statsEvents = events.filter((e) => e.type === 'v1.box.stats')
    expect(statsEvents).toHaveLength(2)
    expect(statsEvents[0]?.payload).toEqual({ boxId: 'box-1', cpuPercent: 12, memoryMb: 256, diskMb: 1200 })
    expect(statsEvents[1]?.payload).toEqual({ boxId: 'box-2', cpuPercent: 12, memoryMb: 256, diskMb: 1200 })
  })

  it('单盒 stats 抛错不拖累他盒（如实跳过该盒，不造空事件）', async () => {
    const { bus, events } = setup()
    const backend = {
      stats: (id: string) => (id === 'box-坏' ? Promise.reject(new Error('gone')) : Promise.resolve({ diskMb: 7 })),
    }
    const svc = new StatsService({ backend: backend as never, boxIds: () => ['box-坏', 'box-好'], bus })
    await svc.poll()
    const statsEvents = events.filter((e) => e.type === 'v1.box.stats')
    expect(statsEvents).toHaveLength(1)
    expect(statsEvents[0]?.payload).toEqual({ boxId: 'box-好', diskMb: 7 })
  })

  it('压力状态机：只在转移时发（ok→warn→critical→critical 不重发→ok 恢复）', async () => {
    let free = 100 * 1024 ** 3
    const { bus, events, diskProbe } = setup(async () => ({ freeBytes: free, totalBytes: 200 * 1024 ** 3 }))
    const svc = new StatsService({ backend: { stats: () => Promise.resolve({}) } as never, boxIds: () => [], bus, diskProbe, warnBytes: 20 * 1024 ** 3, criticalBytes: 5 * 1024 ** 3 })
    await svc.poll() // 首拍：null→ok 也是转移，发初始档（renderer 得到「无压力」事实）
    expect(events.filter((e) => e.type === 'v1.system.pressure')).toHaveLength(1)
    free = 10 * 1024 ** 3 // → warn
    await svc.poll()
    free = 1 * 1024 ** 3 // → critical
    await svc.poll()
    await svc.poll() // critical 停留——不重发
    free = 50 * 1024 ** 3 // → ok 恢复
    await svc.poll()
    const levels = events.filter((e) => e.type === 'v1.system.pressure').map((e) => (e.payload as { level: string }).level)
    expect(levels).toEqual(['ok', 'warn', 'critical', 'ok'])
    expect(svc.pressureLevel).toBe('ok')
  })

  it('探针失败/返回 null：不发事件、保持上一档（无数据不判定）', async () => {
    let free = 1 * 1024 ** 3
    let mode: 'ok' | 'throw' | 'null' = 'ok'
    const { bus, events, diskProbe } = setup(() => {
      if (mode === 'throw') return Promise.reject(new Error('statfs boom'))
      if (mode === 'null') return Promise.resolve(null)
      return Promise.resolve({ freeBytes: free, totalBytes: 2 * 1024 ** 3 })
    })
    const svc = new StatsService({ backend: { stats: () => Promise.resolve({}) } as never, boxIds: () => [], bus, diskProbe, warnBytes: 20 * 1024 ** 3, criticalBytes: 5 * 1024 ** 3 })
    await svc.poll() // 首拍：null→critical 一次转移（free=1GiB 直落 critical 档）
    mode = 'throw'
    await svc.poll() // 静默
    mode = 'null'
    await svc.poll() // 静默
    expect(events.filter((e) => e.type === 'v1.system.pressure')).toHaveLength(1)
    expect(svc.pressureLevel).toBe('critical')
  })

  it('未注入探针：压力面整体不启动（只做 Box 遥测）', async () => {
    const { bus, events } = setup()
    const svc = new StatsService({ backend: { stats: () => Promise.resolve({}) } as never, boxIds: () => [], bus })
    await svc.poll()
    expect(events).toHaveLength(0)
    expect(svc.pressureLevel).toBeNull()
  })

  it('start 先立即拍一轮再进间隔（开机即有数据）；stop 幂等', async () => {
    const { bus, events, backend } = setup()
    await backend.create({ image: 'default' })
    const svc = new StatsService({ backend, boxIds: () => ['box-1'], bus })
    const pollSpy = vi.spyOn(svc, 'poll')
    svc.start(60_000)
    expect(pollSpy).toHaveBeenCalledTimes(1) // 立即拍——不等首个间隔
    svc.stop()
    svc.stop() // 幂等
    await new Promise((r) => setTimeout(r, 0)) // 等立即拍的异步链落地
    expect(events.filter((e) => e.type === 'v1.box.stats')).toHaveLength(1)
  })
})
