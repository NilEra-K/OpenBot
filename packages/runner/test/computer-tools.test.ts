/**
 * computer 工具族测试（plan-computer-use Step 7 + plan-image-firstclass P8-2 接口化）：
 * 替身 ScreenControl 锁动作语义——接管锁在每个动作前等待、动作后附截图（裁定 D）、参数
 * 校验稳定码、screenshot 独立工具不等待锁、协议中性 ScreenAction 词表。
 * X11 命令翻译与坐标换算在 boxes/test/screen-x11.test.ts（适配器层）锁定——两层各司其职。
 */
import { describe, expect, it } from 'vitest'
import { computerTools, ToolRegistry } from '../src/tools/index.js'
import type { GuiTakeoverLock, ToolContext } from '../src/tools/index.js'
import type { ScreenAction, ScreenControl } from '@openbot/boxes'

const ctx = (boxId = 'box-1'): ToolContext => ({
  agentId: 'a1',
  runId: 'r1',
  originMessageId: 'm1',
  toolCallId: 'c1',
  boxId,
  signal: new AbortController().signal,
})

const IMG = { base64: 'aW1n', mime: 'image/jpeg' }

/** 替身 ScreenControl：记录动作、回固定截图（bytes=IMG 的 base64 原文）；
 *  humanMove=true 时提供人味移动面（记录调用——降级路径测试用缺席形态） */
function fakeScreen(opts?: {
  geo?: { width: number; height: number } | null
  meta?: { width?: number; height?: number; screenWidth?: number; screenHeight?: number }
  humanMove?: boolean
}): {
  screen: ScreenControl
  acts: ScreenAction[]
  moves: Array<{ to: Array<{ x: number; y: number }>; behavior?: 'direct' | 'human'; durationMs?: number }>
} {
  const acts: ScreenAction[] = []
  const moves: Array<{ to: Array<{ x: number; y: number }>; behavior?: 'direct' | 'human'; durationMs?: number }> = []
  const screen: ScreenControl = {
    geometry: async () => opts?.geo ?? null,
    capture: async () => ({
      bytes: Uint8Array.from(Buffer.from('aW1n', 'base64')),
      mime: 'image/jpeg',
      ...opts?.meta,
    }),
    act: async (_boxId, action) => {
      acts.push(action)
    },
    ...(opts?.humanMove === true
      ? {
          humanMove: async (
            _boxId: string,
            to: Array<{ x: number; y: number }>,
            o?: { behavior?: 'direct' | 'human'; durationMs?: number },
          ) => {
            moves.push({
              to,
              ...(o?.behavior !== undefined ? { behavior: o.behavior } : {}),
              ...(o?.durationMs !== undefined ? { durationMs: o.durationMs } : {}),
            })
          },
        }
      : {}),
    supportsStream: () => false,
    stream: async () => {
      throw new Error('stream 未在工具层使用')
    },
  }
  return { screen, acts, moves }
}

const depsOf = (screen: ScreenControl, lock?: Pick<GuiTakeoverLock, 'waitTurn'>) => ({
  backend: null as never,
  bus: null as never,
  screen,
  ...(lock !== undefined ? { lock } : {}),
  settleMs: 0,
})

describe('computerTools（替身）', () => {
  it('全族 7 件：screenshot/move/click/double_click/type/key/scroll', () => {
    const { screen } = fakeScreen()
    const tools = computerTools(depsOf(screen))
    expect(tools.map((t) => t.spec.name)).toEqual([
      'computer_screenshot', 'computer_move', 'computer_click', 'computer_double_click', 'computer_type', 'computer_key', 'computer_scroll',
    ])
  })

  it('screenshot：不等待接管锁（看屏不占动作面）；回喂含图', async () => {
    let lockWaits = 0
    const lock: Pick<GuiTakeoverLock, 'waitTurn'> = { waitTurn: async () => { lockWaits += 1 } }
    const { screen } = fakeScreen()
    const tools = computerTools(depsOf(screen, lock))
    const shot = tools.find((t) => t.spec.name === 'computer_screenshot')!
    const r = await shot.execute(ctx(), {})
    expect(r.text).toContain(`已截图。截图 1:1`)
    expect(r.image).toEqual(IMG)
    expect(lockWaits).toBe(0)
  })

  it('动作工具：等待接管锁 → act（协议中性 ScreenAction）→ 附动作后截图（裁定 D）', async () => {
    let lockWaits = 0
    const { screen, acts } = fakeScreen()
    const tools = computerTools(depsOf(screen, { waitTurn: async () => { lockWaits += 1 } }))
    const reg = new ToolRegistry()
    for (const t of tools) reg.register(t)

    const click = await reg.execute(ctx(), { id: 'c1', name: 'computer_click', args: { x: 100, y: 200 } })
    expect(lockWaits).toBe(1)
    expect(acts).toEqual([{ kind: 'click', button: 1, x: 100, y: 200 }])
    expect(click).toMatchObject({ image: IMG })

    await reg.execute(ctx(), { id: 'c2', name: 'computer_double_click', args: { x: 10, y: 20 } })
    await reg.execute(ctx(), { id: 'c3', name: 'computer_type', args: { text: "it's" } })
    await reg.execute(ctx(), { id: 'c4', name: 'computer_key', args: { key: 'ctrl+a' } })
    await reg.execute(ctx(), { id: 'c5', name: 'computer_scroll', args: { dy: -240 } })
    expect(acts.slice(1)).toEqual([
      { kind: 'click', button: 1, x: 10, y: 20, count: 2, intervalMs: 150 },
      { kind: 'type', text: "it's", delayMs: 30 },
      { kind: 'key', key: 'ctrl+a' },
      { kind: 'click', button: 4, count: 2, intervalMs: 60 }, // 向上滚动 = 滚轮按钮 4
    ])
    expect(lockWaits).toBe(5) // 每个动作前都等待
  })

  it('参数校验稳定码：坐标非数字/key 非法组合拒绝；无 Box 报 TOOL_NO_BOX', async () => {
    const { screen } = fakeScreen()
    const tools = computerTools(depsOf(screen))
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
    const { screen } = fakeScreen()
    const tools = computerTools(depsOf(screen))
    const reg = new ToolRegistry()
    for (const t of tools) reg.register(t)
    expect(reg.lastImageOf('computer_click')).toBeUndefined()
    await reg.execute(ctx(), { id: 'c1', name: 'computer_click', args: { x: 1, y: 2 } })
    expect(reg.lastImageOf('computer_click')).toEqual(IMG)
    expect(reg.lastImageOf('computer_type')).toBeUndefined()
  })

  it('截屏回喂标注两端尺寸：模型知道自己工作在缩放坐标系（元数据由适配器 capture 提供）', async () => {
    const { screen } = fakeScreen({
      meta: { width: 1280, height: 720, screenWidth: 1920, screenHeight: 1080 },
    })
    const tools = computerTools(depsOf(screen))
    const shot = tools.find((t) => t.spec.name === 'computer_screenshot')!
    const r = (await shot.execute(ctx(), {})) as { text: string }
    expect(r.text).toContain('1280×720')
    expect(r.text).toContain('1920×1080')
    expect(r.text).toContain('自动换算')
  })
})

describe('computer_move（人味移动）', () => {
  it('humanMove 在场：等待接管锁 → 适配器 humanMove（点列+behavior+时长透传）→ 附移动后截图', async () => {
    let lockWaits = 0
    const { screen, acts, moves } = fakeScreen({ humanMove: true })
    const tools = computerTools(depsOf(screen, { waitTurn: async () => { lockWaits += 1 } }))
    const move = tools.find((t) => t.spec.name === 'computer_move')!
    const r = (await move.execute(ctx(), {
      points: [
        { x: 300, y: 100 },
        { x: 300, y: 240 },
      ],
      behavior: 'human',
      durationMs: 500,
    })) as { text: string; image: unknown }
    expect(lockWaits).toBe(1)
    expect(moves).toEqual([
      { to: [{ x: 300, y: 100 }, { x: 300, y: 240 }], behavior: 'human', durationMs: 500 },
    ])
    expect(acts).toHaveLength(0) // 不走 act——humanMove 是独立注入面
    expect(r.text).toContain('拟人轨迹')
    expect(r.text).toContain('2 个点')
    expect(r.text).toContain('(300, 240)')
    expect(r.image).toEqual(IMG)
    // 缺省 direct：什么都不传 = 直接移动过去（无 behavior 字段透传）
    await move.execute(ctx(), { points: [{ x: 9, y: 9 }] })
    expect(moves[1]).toEqual({ to: [{ x: 9, y: 9 }] })
  })

  it('durationMs 钳制 [0, 10000]（防打穿 exec/ack 超时预算）；缺省不传（自适应）', async () => {
    const { screen, moves } = fakeScreen({ humanMove: true })
    const tools = computerTools(depsOf(screen))
    const move = tools.find((t) => t.spec.name === 'computer_move')!
    await move.execute(ctx(), { points: [{ x: 1, y: 1 }], durationMs: 99_999 })
    await move.execute(ctx(), { points: [{ x: 2, y: 2 }] })
    expect(moves).toEqual([
      { to: [{ x: 1, y: 1 }], durationMs: 10_000 },
      { to: [{ x: 2, y: 2 }] },
    ])
  })

  it('points 自纠化校验：非数组/空/超 8/坏点 → TOOL_ARGS_INVALID（回显+示例）；适配器零调用', async () => {
    const { screen, moves } = fakeScreen({ humanMove: true })
    const tools = computerTools(depsOf(screen))
    const reg = new ToolRegistry()
    for (const t of tools) reg.register(t)
    for (const bad of [null, [], 'x', [{ x: 1 }], [{ x: 'a', y: 2 }], Array.from({ length: 9 }, () => ({ x: 1, y: 1 }))]) {
      const r = await reg.execute(ctx(), { id: `c-${String(JSON.stringify(bad)).length}`, name: 'computer_move', args: { points: bad } })
      expect(String(r)).toContain('TOOL_ARGS_INVALID')
      expect(String(r)).toContain('points')
    }
    expect(moves).toHaveLength(0)
  })

  it('适配器缺席 humanMove：降级普通 move（直达末点，act kind=move）且回喂如实注明', async () => {
    const { screen, acts, moves } = fakeScreen() // 无 humanMove 面
    const tools = computerTools(depsOf(screen))
    const move = tools.find((t) => t.spec.name === 'computer_move')!
    const r = (await move.execute(ctx(), {
      points: [
        { x: 88, y: 66 },
        { x: 90, y: 70 },
      ],
    })) as { text: string }
    expect(moves).toHaveLength(0)
    expect(acts).toEqual([{ kind: 'move', x: 90, y: 70 }]) // 多途经点无瞬移表达——直达末点
    expect(r.text).toContain('不支持人味轨迹')
  })

  it('宿主屏门拒绝：APPROVAL_DENIED 回喂、humanMove 零调用（移动也是输入注入主权面）', async () => {
    const { screen, moves } = fakeScreen({ humanMove: true })
    const gate = { request: async () => false }
    const tools = computerTools({ ...depsOf(screen), actionGate: { gate, appliesTo: () => true } })
    const move = tools.find((t) => t.spec.name === 'computer_move')!
    const r = await move.execute(ctx('hostscreen-x'), { points: [{ x: 1, y: 2 }] })
    expect(String(r)).toContain('APPROVAL_DENIED')
    expect(moves).toHaveLength(0)
  })
})

describe('computerTools actionGate（P9-1 裁定 F：宿主屏幕动作恒过闸）', () => {
  const gateOf = (approved: boolean, log: { tools: string[]; nonces: string[] }) => ({
    request: async (r: { tool: string; nonce: string }) => {
      log.tools.push(r.tool)
      log.nonces.push(r.nonce)
      return approved
    },
  })
  const depsGated = (screen: ScreenControl, gate: ReturnType<typeof gateOf>, appliesTo: (boxId: string) => boolean) => ({
    ...depsOf(screen),
    actionGate: { gate, appliesTo, reason: () => '宿主屏幕输入注入' },
  })

  it('appliesTo 命中：动作先过闸（拒绝 → APPROVAL_DENIED 回喂，act 零调用）；闸不拦截图', async () => {
    const { screen, acts } = fakeScreen()
    const log = { tools: [] as string[], nonces: [] as string[] }
    const tools = computerTools(depsGated(screen, gateOf(false, log), () => true))
    const reg = new ToolRegistry()
    for (const t of tools) reg.register(t)
    const r = await reg.execute(ctx('hostscreen-main'), { id: 'c1', name: 'computer_click', args: { x: 1, y: 2 } })
    expect(String(r)).toContain('APPROVAL_DENIED')
    expect(acts).toHaveLength(0) // 拒绝即不执行
    // nonce = originMessageId:toolCallId（幂等键与 gated() 同构——redrive 不双弹窗）
    expect(log.nonces).toEqual(['m1:c1'])
    expect(log.tools).toEqual(['computer_click'])
    // 截图不进闸（注册条目即「可看」授权——注入才是主权面）
    const shotLog = { tools: [] as string[], nonces: [] as string[] }
    const shotTools = computerTools(depsGated(screen, gateOf(false, shotLog), () => true))
    const shot = shotTools.find((t) => t.spec.name === 'computer_screenshot')!
    const sr = await shot.execute(ctx('hostscreen-main'), {})
    expect(String((sr as { text: string }).text)).toContain('已截图')
    expect(shotLog.tools).toHaveLength(0)
  })

  it('appliesTo 未命中（普通容器 box）：闸零调用——「Box 内自由」语义不变', async () => {
    const { screen, acts } = fakeScreen()
    const log = { tools: [] as string[], nonces: [] as string[] }
    const tools = computerTools(depsGated(screen, gateOf(false, log), (boxId) => boxId === 'hostscreen-main'))
    const reg = new ToolRegistry()
    for (const t of tools) reg.register(t)
    await reg.execute(ctx('box-1'), { id: 'c1', name: 'computer_click', args: { x: 1, y: 2 } })
    expect(acts).toHaveLength(1)
    expect(log.tools).toHaveLength(0)
  })

  it('批准放行：过闸后动作照常执行（manual/auto 语义归闸门内件）', async () => {
    const { screen, acts } = fakeScreen()
    const log = { tools: [] as string[], nonces: [] as string[] }
    const tools = computerTools(depsGated(screen, gateOf(true, log), () => true))
    const reg = new ToolRegistry()
    for (const t of tools) reg.register(t)
    await reg.execute(ctx('hostscreen-main'), { id: 'c1', name: 'computer_click', args: { x: 1, y: 2 } })
    expect(acts).toHaveLength(1)
    expect(log.tools).toEqual(['computer_click'])
  })
})
