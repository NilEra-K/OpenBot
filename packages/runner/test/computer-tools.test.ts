/**
 * computer 工具族测试（plan-computer-use Step 7）：替身锁/截图/动作——断言接管锁在每个
 * 动作前等待、动作后附截图（裁定 D）、参数校验稳定码、screenshot 独立工具不等待锁。
 * GUI 真机行为（xdotool/scrot 实际效果）未验收——替身锁 argv 与语义（plan 纪律）。
 */
import { describe, expect, it } from 'vitest'
import { computerTools, ToolRegistry } from '../src/tools/index.js'
import type { GuiTakeoverLock, ToolContext } from '../src/tools/index.js'

const ctx = (boxId = 'box-1'): ToolContext => ({
  agentId: 'a1',
  runId: 'r1',
  originMessageId: 'm1',
  toolCallId: 'c1',
  boxId,
  signal: new AbortController().signal,
})

const IMG = { base64: 'aW1n', mime: 'image/jpeg' }

describe('computerTools（替身）', () => {
  it('全族 6 件：screenshot/click/double_click/type/key/scroll', () => {
    const tools = computerTools({ backend: null as never, bus: null as never })
    expect(tools.map((t) => t.spec.name)).toEqual([
      'computer_screenshot', 'computer_click', 'computer_double_click', 'computer_type', 'computer_key', 'computer_scroll',
    ])
  })

  it('screenshot：不等待接管锁（看屏不占动作面）；回喂含图', async () => {
    let lockWaits = 0
    const lock: Pick<GuiTakeoverLock, 'waitTurn'> = { waitTurn: async () => { lockWaits += 1 } }
    const tools = computerTools({
      backend: null as never,
      bus: null as never,
      lock,
      capture: async () => IMG,
      settleMs: 0,
    })
    const shot = tools.find((t) => t.spec.name === 'computer_screenshot')!
    const r = await shot.execute(ctx(), {})
    expect(r).toEqual({ text: '已截图（见图像）', image: IMG })
    expect(lockWaits).toBe(0)
  })

  it('动作工具：等待接管锁 → act → 附动作后截图（裁定 D）；xdotool argv 语义', async () => {
    let lockWaits = 0
    const acts: string[] = []
    const tools = computerTools({
      backend: null as never,
      bus: null as never,
      lock: { waitTurn: async () => { lockWaits += 1 } },
      capture: async () => IMG,
      act: async (_box, argv) => { acts.push(argv.join(' ')) },
      settleMs: 0,
    })
    const reg = new ToolRegistry()
    for (const t of tools) reg.register(t)

    const click = await reg.execute(ctx(), { id: 'c1', name: 'computer_click', args: { x: 100, y: 200 } })
    expect(lockWaits).toBe(1)
    expect(acts).toEqual(['xdotool mousemove 100 200 click 1'])
    expect(click).toMatchObject({ image: IMG })

    await reg.execute(ctx(), { id: 'c2', name: 'computer_double_click', args: { x: 10, y: 20 } })
    await reg.execute(ctx(), { id: 'c3', name: 'computer_type', args: { text: "it's" } })
    await reg.execute(ctx(), { id: 'c4', name: 'computer_key', args: { key: 'ctrl+a' } })
    await reg.execute(ctx(), { id: 'c5', name: 'computer_scroll', args: { dy: -240 } })
    expect(acts.slice(1)).toEqual([
      'xdotool mousemove 10 20 click --repeat 2 --delay 150 1',
      // 单引号转义（sh 安全注入）
      `xdotool type --delay 30 -- 'it'\\''s'`,
      'xdotool key ctrl+a',
      'xdotool click --repeat 2 --delay 60 4', // 向上滚动 = 按钮 4
    ])
    expect(lockWaits).toBe(5) // 每个动作前都等待
  })

  it('参数校验稳定码：坐标非数字/key 非法组合拒绝；无 Box 报 TOOL_NO_BOX', async () => {
    const tools = computerTools({ backend: null as never, bus: null as never, capture: async () => IMG, act: async () => {}, settleMs: 0 })
    const reg = new ToolRegistry()
    for (const t of tools) reg.register(t)
    const badClick = await reg.execute(ctx(), { id: 'c1', name: 'computer_click', args: { x: 'abc', y: 1 } })
    expect(badClick).toContain('TOOL_ARGS_INVALID')
    const badKey = await reg.execute(ctx(), { id: 'c2', name: 'computer_key', args: { key: 'rm -rf' } })
    expect(badKey).toContain('TOOL_ARGS_INVALID')
    const noBox = await reg.execute(ctx(null), { id: 'c3', name: 'computer_screenshot', args: {} })
    expect(noBox).toContain('TOOL_NO_BOX')
  })

  it('ToolRegistry.lastImageOf：最近含图结果（GUI 旁观视图帧源）', async () => {
    const tools = computerTools({ backend: null as never, bus: null as never, capture: async () => IMG, act: async () => {}, settleMs: 0 })
    const reg = new ToolRegistry()
    for (const t of tools) reg.register(t)
    expect(reg.lastImageOf('computer_click')).toBeUndefined()
    await reg.execute(ctx(), { id: 'c1', name: 'computer_click', args: { x: 1, y: 2 } })
    expect(reg.lastImageOf('computer_click')).toEqual(IMG)
    expect(reg.lastImageOf('computer_type')).toBeUndefined()
  })
})
