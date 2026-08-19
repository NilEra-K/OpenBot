import { describe, expect, it } from 'vitest'
import { EventBus } from '../src/index.js'

describe('EventBus', () => {
  it('emit 分配全局单调 seq，at 取自注入时钟', () => {
    let t = 100
    const bus = new EventBus({ now: () => t })
    const e1 = bus.emit('v1.lifecycle.idle', { agentId: 'a1' })
    t += 5
    const e2 = bus.emit('v1.lifecycle.idle', { agentId: 'a1' })
    expect(e1.seq).toBe(1)
    expect(e1.at).toBe(100)
    expect(e2.seq).toBe(2)
    expect(e2.at).toBe(105)
    expect(bus.size).toBe(2)
  })

  it('on 精确类型与 * 通配各自命中，互不串扰', () => {
    const bus = new EventBus({ now: () => 0 })
    const exact: string[] = []
    const all: string[] = []
    bus.on('v1.box.state', (e) => exact.push(e.type))
    bus.on('*', (e) => all.push(e.type))
    bus.emit('v1.box.state', { boxId: 'b1', state: 'active' })
    bus.emit('v1.system.roster', { agentId: 'a1', role: 'worker', cause: 'registered' })
    expect(exact).toEqual(['v1.box.state'])
    expect(all).toEqual(['v1.box.state', 'v1.system.roster'])
  })

  it('退订函数生效；回调内退订不炸遍历', () => {
    const bus = new EventBus({ now: () => 0 })
    const seen: string[] = []
    const off = bus.on('v1.lifecycle.idle', (e) => {
      seen.push(e.type)
      off()
    })
    bus.emit('v1.lifecycle.idle', { agentId: 'a1' })
    bus.emit('v1.lifecycle.idle', { agentId: 'a1' })
    expect(seen).toEqual(['v1.lifecycle.idle'])
    expect(bus.size).toBe(2)
  })

  it('since(seq) 重放续传语义：since(0)=全量，只取 seq 之后', () => {
    const bus = new EventBus({ now: () => 0 })
    bus.emit('v1.lifecycle.idle', { agentId: 'a1' })
    bus.emit('v1.lifecycle.idle', { agentId: 'a1' })
    bus.emit('v1.lifecycle.idle', { agentId: 'a1' })
    expect(bus.since(0).map((e) => e.seq)).toEqual([1, 2, 3])
    expect(bus.since(2).map((e) => e.seq)).toEqual([3])
    expect(bus.since(3)).toEqual([])
  })
})
