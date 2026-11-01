/**
 * 宿主屏幕适配器测试（plan-screen-firstclass P9-1）：行协议序列化（argv 锁死纪律的
 * stdin 行对位——PS 协议行逐条断言）、键名映射、坐标域校验（agent 拒 / user 钳）、
 * L0/L1 流档位（ffmpeg 探测分岔 argv 锁死）、注入通道 ready 握手、桥注入面。
 * 全程替身 spawner/runner/bridge——零真实进程、零真实屏幕。
 */
import { describe, expect, it, vi } from 'vitest'
import { HOST_INJECT_SCRIPT, coalesceMoves, keyToVk, serializeHostAction } from '../src/screen/win-protocol.js'
import { HOST_SCREEN_BOX_ID, HostScreenControl } from '../src/screen/host-screen.js'
import { ScreenControlRouter } from '../src/screen/index.js'
import { HostScreenBoxBackend } from '../src/backend-hostscreen/index.js'
import type { PipeProcess } from '../src/procexec/index.js'
import type { ScreenAction, ScreenControl, ScreenGeometry } from '../src/screen/index.js'

const GEO: ScreenGeometry = { width: 1920, height: 1080 }

const bridgeOf = (geo: ScreenGeometry | null = GEO) => ({
  geometry: () => geo,
  captureFrame: async ({ maxWidth }: { maxWidth: number; quality: number }) => ({
    bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), // JPEG SOI/EOI 形状
    width: Math.min(maxWidth, geo?.width ?? maxWidth),
    height: 100,
  }),
})

interface RecProc extends PipeProcess {
  argv: string[]
  written: string[]
  killed: boolean
  emit(data: string): void
  exit(code: number | null): void
}

const spawnerOf = () => {
  const procs: RecProc[] = []
  const spawner = (argv: string[]): RecProc => {
    const outCbs = new Set<(c: Uint8Array) => void>()
    const exitCbs = new Set<(c: number | null) => void>()
    const proc: RecProc = {
      argv,
      written: [],
      killed: false,
      onOutput: (cb) => outCbs.add(cb),
      onExit: (cb) => exitCbs.add(cb),
      stderrTail: () => '',
      write: (t) => proc.written.push(t),
      kill: () => {
        proc.killed = true
      },
      emit: (s: string) => {
        for (const cb of outCbs) cb(new TextEncoder().encode(s))
      },
      exit: (c: number | null) => {
        for (const cb of exitCbs) cb(c)
      },
    }
    procs.push(proc)
    return proc
  }
  return { procs, spawner }
}

describe('serializeHostAction（PS 行协议——单测锁死）', () => {
  it('move：归一化 0-65535（x*65536/span）；越界（agent）拒绝 / user 钳制', () => {
    expect(serializeHostAction({ kind: 'move', x: 960, y: 540 }, GEO, 'agent')).toEqual([
      `m|${Math.round((960 * 65536) / 1920)}|${Math.round((540 * 65536) / 1080)}`,
    ])
    expect(serializeHostAction({ kind: 'move', x: -5, y: 200 }, GEO, 'user')).toEqual([
      `m|0|${Math.round((200 * 65536) / 1080)}`,
    ])
    expect(() => serializeHostAction({ kind: 'move', x: -5, y: 200 }, GEO, 'agent')).toThrowError(/坐标越界/)
  })

  it('click：坐标点击 = move + c 行；连击 count/interval 原样传递', () => {
    expect(serializeHostAction({ kind: 'click', button: 1, x: 100, y: 50 }, GEO, 'agent')).toEqual([
      `m|${Math.round((100 * 65536) / 1920)}|${Math.round((50 * 65536) / 1080)}`,
      'c|1|1|0',
    ])
    expect(serializeHostAction({ kind: 'click', button: 1, x: 0, y: 0, count: 2, intervalMs: 150 }, GEO, 'agent')).toEqual([
      'm|0|0',
      'c|1|2|150',
    ])
  })

  it('滚轮：button 4/5 → ±120/格（X 惯例——4 上 5 下）', () => {
    expect(serializeHostAction({ kind: 'click', button: 4, count: 3, intervalMs: 60 }, GEO, 'agent')).toEqual(['w|120|3|60'])
    expect(serializeHostAction({ kind: 'click', button: 5 }, GEO, 'agent')).toEqual(['w|-120|1|0'])
  })

  it('键组合：修饰键先按（kd）→ 末键敲击（kp）→ 修饰键倒序放（ku）', () => {
    expect(serializeHostAction({ kind: 'key', key: 'ctrl+a' }, GEO, 'agent')).toEqual(['kd|17', 'kp|65', 'ku|17'])
    expect(serializeHostAction({ kind: 'key', key: 'ctrl+shift+Escape' }, GEO, 'agent')).toEqual([
      'kd|17',
      'kd|16',
      'kp|27',
      'ku|16',
      'ku|17',
    ])
    expect(serializeHostAction({ kind: 'key', key: 'Return' }, GEO, 'agent')).toEqual(['kp|13'])
  })

  it('未知键名/修饰键：SCREEN_ACT_FAILED 稳定码（不猜测——风险 6）', () => {
    expect(() => serializeHostAction({ kind: 'key', key: 'f13' }, GEO, 'agent')).toThrowError(/未知键名/)
    expect(() => serializeHostAction({ kind: 'key', key: 'hyper+a' }, GEO, 'agent')).toThrowError(/未知修饰键/)
    expect(keyToVk('f12')).toBe(0x7b)
    expect(keyToVk('zzz')).toBeNull()
  })

  it('type：utf8 base64 免转义（中文/换行/竖线安全）+ delayMs', () => {
    const lines = serializeHostAction({ kind: 'type', text: '你好|世界\n', delayMs: 30 }, GEO, 'agent')
    expect(lines).toEqual([`t|${Buffer.from('你好|世界\n', 'utf8').toString('base64')}|30`])
  })

  it('独立按下/抬起（拖拽协议面）：kdb/kub 按钮行', () => {
    expect(serializeHostAction({ kind: 'down', button: 1 }, GEO, 'user')).toEqual(['kdb|1'])
    expect(serializeHostAction({ kind: 'up', button: 1 }, GEO, 'user')).toEqual(['kub|1'])
  })
})

describe('注入脚本形状（argv 锁死的脚本对位）', () => {
  it('含 SendInput P/Invoke、ready 握手、协议分支、-NoProfile 非交互', () => {
    expect(HOST_INJECT_SCRIPT).toContain('SendInput')
    expect(HOST_INJECT_SCRIPT).toContain("WriteLine('ready')")
    expect(HOST_INJECT_SCRIPT).toContain('FromBase64String')
    expect(HOST_INJECT_SCRIPT).toContain("'m' { [W.Inj]::Move")
    expect(HOST_INJECT_SCRIPT).toContain("'kdb' { [W.Inj]::ButtonDown")
  })
})

describe('HostScreenControl（替身进程 + 替身桥）', () => {
  it('act：截图坐标 → 1280 契约换算 → 归一化行写入；ok 确认后才完成（注入真实执行）', async () => {
    const { procs, spawner } = spawnerOf()
    const ctrl = new HostScreenControl({ bridge: bridgeOf(), spawner, readyTimeoutMs: 500 })
    const done = ctrl.act(HOST_SCREEN_BOX_ID, { kind: 'click', button: 1, x: 640, y: 270 })
    await new Promise((r) => setTimeout(r, 10))
    const proc = procs[0]
    expect(proc.argv.slice(0, 6)).toEqual(['powershell', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command'])
    expect(proc.argv[6]).toBe(HOST_INJECT_SCRIPT)
    proc.emit("ready\n") // 握手
    await new Promise((r) => setTimeout(r, 10))
    // 640×1.5=960 → 归一化；270×1.5=405；坐标点击 = move + c 两行一次写入
    expect(proc.written.filter((w) => w.includes('m|'))).toEqual([
      `m|${Math.round((960 * 65536) / 1920)}|${Math.round((405 * 65536) / 1080)}\nc|1|1|0\n`,
    ])
    proc.emit("ok\nok\n") // PS 确认两条动作行已执行（每行一个 ok）
    await expect(done).resolves.toBeUndefined() // ack 前不完成（act 等待真实执行）
  })

  it('act：ack 超时 → SCREEN_ACT_FAILED（通道僵死可见）', async () => {
    const { procs, spawner } = spawnerOf()
    const ctrl = new HostScreenControl({ bridge: bridgeOf(), spawner, readyTimeoutMs: 500, actAckTimeoutMs: 100 })
    const done = ctrl.act(HOST_SCREEN_BOX_ID, { kind: 'key', key: 'Return' })
    await new Promise((r) => setTimeout(r, 10))
    procs[0].emit("ready\n")
    await expect(done).rejects.toMatchObject({ code: 'SCREEN_ACT_FAILED', message: expect.stringContaining('注入未确认') })
  })

  it('几何不可用：act 抛 SCREEN_ACT_FAILED（如实——不落动作）', async () => {
    const { spawner } = spawnerOf()
    const ctrl = new HostScreenControl({ bridge: bridgeOf(null), spawner })
    await expect(ctrl.act(HOST_SCREEN_BOX_ID, { kind: 'key', key: 'Return' })).rejects.toMatchObject({
      code: 'SCREEN_ACT_FAILED',
    })
  })

  it('capture：桥出帧 + 物理几何元数据（缩放坐标系语义）', async () => {
    const ctrl = new HostScreenControl({ bridge: bridgeOf() })
    const cap = await ctrl.capture(HOST_SCREEN_BOX_ID, {})
    expect(cap.mime).toBe('image/png')
    expect(cap.width).toBe(1280)
    expect(cap.screenWidth).toBe(1920)
    expect(cap.screenHeight).toBe(1080)
  })

  it('stream：ffmpeg 在场 → gdigrab h264 argv（L1）；缺席 → mjpeg 轮询会话（L0）', async () => {
    const present = spawnerOf()
    const okRunner = async () => ({ exitCode: 0, stdout: '', stderr: '' }) as never
    const ctrl1 = new HostScreenControl({ bridge: bridgeOf(), spawner: present.spawner, runner: okRunner })
    const s1 = await ctrl1.stream(HOST_SCREEN_BOX_ID, { codec: 'h264' })
    expect(s1.codec).toBe('h264')
    const argv = present.procs[0].argv
    expect(argv).toContain('gdigrab')
    expect(argv).toContain('libx264')
    expect(argv).toContain('-i')
    expect(argv[argv.indexOf('-i') + 1]).toBe('desktop')
    s1.close()
    expect(present.procs[0].killed).toBe(true)

    const absent = spawnerOf()
    const failRunner = async () => ({ exitCode: 1, stdout: '', stderr: '' }) as never
    const ctrl2 = new HostScreenControl({ bridge: bridgeOf(), spawner: absent.spawner, runner: failRunner })
    const s2 = await ctrl2.stream(HOST_SCREEN_BOX_ID, { codec: 'h264' })
    expect(s2.codec).toBe('mjpeg') // L0 如实降级——session.codec 为真相源
    const frames: number[] = []
    s2.onData((b) => frames.push(b.length))
    await new Promise((r) => setTimeout(r, 200))
    expect(frames.length).toBeGreaterThanOrEqual(1) // 轮询帧在流
    s2.close()
  })

  it('inputChannel：ready 握手前返回阻塞等待；通道进程退出后除名（下次重建）', async () => {
    const { procs, spawner } = spawnerOf()
    const ctrl = new HostScreenControl({ bridge: bridgeOf(), spawner, readyTimeoutMs: 500 })
    const p = ctrl.inputChannel(HOST_SCREEN_BOX_ID)
    await new Promise((r) => setTimeout(r, 10))
    procs[0].emit("ready\n")
    const ch = await p
    expect(ch).not.toBeNull()
    ch!.write([{ kind: 'key', key: 'Return' }])
    expect(procs[0].written.some((w) => w === 'kp|13\n')).toBe(true)
    procs[0].exit(null)
    await new Promise((r) => setTimeout(r, 10))
    // 通道退出——再次 act 触发重建（新进程）
    void ctrl.act(HOST_SCREEN_BOX_ID, { kind: 'key', key: 'a' }).catch(() => {})
    await Promise.resolve()
    await new Promise((r) => setTimeout(r, 10))
    expect(procs.length).toBe(2)
    ctrl.dispose()
  })
})

describe('HostScreenBoxBackend（纯屏幕载体记账面）', () => {
  it('caps 如实：persistent ✓ / snapshot ✗ / headless ✗ / interactive ✗ / suspendable ✗ / isolation low', () => {
    const caps = new HostScreenBoxBackend().caps()
    expect(caps).toEqual({
      persistent: true,
      snapshot: false,
      headless: false,
      resourceLimits: false,
      isolation: 'low',
      interactive: false,
      suspendable: false,
    })
  })

  it('create=attach 每条目一 box（P9-2：hostscreen-<entryId>）；teardown 只清账；list/stats 如实', async () => {
    const b = new HostScreenBoxBackend({ now: () => 42 })
    expect(await b.list()).toEqual([])
    expect(await b.create({ image: 'img-1' })).toBe('hostscreen-img-1')
    expect(await b.create({ image: 'img-1' })).toBe('hostscreen-img-1') // 幂等——同条目重复 create
    expect(await b.create({ image: 'img-2' })).toBe('hostscreen-img-2') // 不同条目不同 box（窗口绑定=不同桌面面）
    expect(await b.list()).toHaveLength(2)
    expect(await b.stats('hostscreen-img-1')).toEqual({})
    await b.teardown('hostscreen-img-1')
    expect((await b.list()).map((x) => x.boxId)).toEqual(['hostscreen-img-2'])
  })

  it('exec/fs/snapshot 稳定码拒绝（BOX_UNSUPPORTED——纯屏幕载体零命令面）', async () => {
    const b = new HostScreenBoxBackend()
    await expect(b.exec(HOST_SCREEN_BOX_ID, { command: ['ls'], timeoutMs: 1000 })).rejects.toMatchObject({
      code: 'BOX_UNSUPPORTED',
    })
    await expect(b.fsRead(HOST_SCREEN_BOX_ID, '/a')).rejects.toMatchObject({ code: 'BOX_UNSUPPORTED' })
    await expect(b.fsWrite(HOST_SCREEN_BOX_ID, '/a', 'x')).rejects.toMatchObject({ code: 'BOX_UNSUPPORTED' })
    await expect(b.snapshot(HOST_SCREEN_BOX_ID)).rejects.toMatchObject({ code: 'BOX_UNSUPPORTED' })
  })
})

describe('ScreenControlRouter（按 boxId 分发——消费方零载体感知）', () => {
  const fakeAdapter = (tag: string): ScreenControl & { tag: string } => ({
    tag,
    geometry: async () => ({ width: 1, height: 1 }),
    capture: async () => ({ bytes: new Uint8Array(), mime: 'image/jpeg' }),
    act: async () => {},
    stream: async () => {
      throw new Error('unused')
    },
    supportsStream: () => true,
    dispose: () => {},
  })

  it('resolve 分发 + dispose 全关（孤儿纪律）', async () => {
    const x11 = fakeAdapter('x11')
    const host = fakeAdapter('host')
    const router = new ScreenControlRouter({
      resolve: (boxId) => (boxId === HOST_SCREEN_BOX_ID ? host : x11),
      adapters: [x11, host],
    })
    expect((await router.geometry(HOST_SCREEN_BOX_ID)).width).toBe(1)
    expect(router.supportsStream()).toBe(true)
    const spy = vi.spyOn(host, 'dispose' as never)
    router.dispose()
    expect(spy).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// P9-2：窗口绑定 / L2 零依赖帧泵 / 通道侧合帧
// ---------------------------------------------------------------------------


import type { HostScreenBridge } from '../src/screen/host-screen.js'

describe('coalesceMoves（通道侧合帧）', () => {
  it('批次内连续 move 只留最后一个；click/key 打断合帧', () => {
    const merged = coalesceMoves([
      { kind: 'move', x: 1, y: 1 },
      { kind: 'move', x: 2, y: 2 },
      { kind: 'move', x: 3, y: 3 },
      { kind: 'key', key: 'a' },
      { kind: 'move', x: 4, y: 4 },
    ])
    expect(merged).toEqual([
      { kind: 'move', x: 3, y: 3 },
      { kind: 'key', key: 'a' },
      { kind: 'move', x: 4, y: 4 },
    ])
    expect(coalesceMoves([])).toEqual([])
  })
})

describe('窗口绑定（P9-2 裁定 B）', () => {
  const pumpRect = (proc: RecProc, rect: string): void => {
    proc.emit(`R|${rect}\n`)
  }

  it('act：rect 现查 → 本地坐标+原点偏移 → 屏幕绝对归一化；ok 后返回', async () => {
    const { procs, spawner } = spawnerOf()
    const ctrl = new HostScreenControl({
      bridge: bridgeOf(),
      spawner,
      windowTitle: '记事本',
      readyTimeoutMs: 500,
      actAckTimeoutMs: 500,
    })
    const done = ctrl.act('hostscreen-img-1', { kind: 'click', button: 1, x: 10, y: 20 })
    await new Promise((r) => setTimeout(r, 10))
    procs[0].emit("ready\n")
    await new Promise((r) => setTimeout(r, 10))
    // rect 查询行（标题 base64）
    expect(procs[0].written.some((w) => w === `rect|${Buffer.from('记事本', 'utf8').toString('base64')}\n`)).toBe(true)
    pumpRect(procs[0], '100|200|640|480')
    procs[0].emit("ok\n") // rect 请求的 ack
    await new Promise((r) => setTimeout(r, 10))
    procs[0].emit("ok\nok\n") // move + c 两条动作行的 ack
    await expect(done).resolves.toBeUndefined()
    // 本地 (10,20) → 绝对 (110,220)，对全屏 1920×1080 归一化
    const moveLine = procs[0].written.find((w) => w.includes('m|'))
    expect(moveLine).toBe(`m|${Math.round((110 * 65536) / 1920)}|${Math.round((220 * 65536) / 1080)}\nc|1|1|0\n`)
  })

  it('窗口未在场（R|-）：act 抛「绑定窗口未在场」（如实拒绝——不静默回整屏）', async () => {
    const { procs, spawner } = spawnerOf()
    const ctrl = new HostScreenControl({
      bridge: bridgeOf(),
      spawner,
      windowTitle: '不存在的窗',
      readyTimeoutMs: 500,
      actAckTimeoutMs: 500,
    })
    const done = ctrl.act('hostscreen-img-1', { kind: 'key', key: 'Return' })
    await new Promise((r) => setTimeout(r, 10))
    procs[0].emit("ready\n")
    await new Promise((r) => setTimeout(r, 10))
    procs[0].emit("R|-\nok\n")
    await expect(done).rejects.toThrowError(/绑定窗口未在场/)
  })

  it('geometry：窗口绑定 → 窗口矩形尺寸；未在场 → null', async () => {
    const { procs, spawner } = spawnerOf()
    const ctrl = new HostScreenControl({ bridge: bridgeOf(), spawner, windowTitle: '记事本', readyTimeoutMs: 500 })
    const g = ctrl.geometry('hostscreen-img-1')
    await new Promise((r) => setTimeout(r, 10))
    procs[0].emit("ready\n")
    await new Promise((r) => setTimeout(r, 10))
    procs[0].emit("R|0|0|640|480\nok\n")
    await expect(g).resolves.toEqual({ width: 640, height: 480 })
    // TTL 内命中缓存（第二次查询不再写 rect 行）
    const writtenBefore = procs[0].written.filter((w) => w.startsWith('rect|')).length
    await ctrl.geometry('hostscreen-img-1')
    expect(procs[0].written.filter((w) => w.startsWith('rect|')).length).toBe(writtenBefore)
  })

  it('listWindows：wlist → W 行清单解码（W|end 收齐）', async () => {
    const { procs, spawner } = spawnerOf()
    const ctrl = new HostScreenControl({ bridge: bridgeOf(), spawner, readyTimeoutMs: 500 })
    const p = ctrl.listWindows()
    await new Promise((r) => setTimeout(r, 10))
    procs[0].emit("ready\n")
    await new Promise((r) => setTimeout(r, 10))
    procs[0].emit(
      `W|0x1|0|0|1920|1080|${Buffer.from('桌面', 'utf8').toString('base64')}\n` +
        `W|0x2|100|100|800|600|${Buffer.from('记事本', 'utf8').toString('base64')}\n` +
        'W|end\nok\n',
    )
    await expect(p).resolves.toEqual([
      { x: 0, y: 0, width: 1920, height: 1080, title: '桌面' },
      { x: 100, y: 100, width: 800, height: 600, title: '记事本' },
    ])
  })
})

describe('L2 零依赖帧泵（P9-2 裁定 A/D）', () => {
  const pumpBridge = (opts?: { failPump?: boolean }): { bridge: HostScreenBridge; frames: number[]; stopped: number[] } => {
    const frames: number[] = []
    const stopped: number[] = []
    const bridge: HostScreenBridge = {
      geometry: () => GEO,
      captureFrame: bridgeOf().captureFrame,
      startFrameStream: (onFrame) => {
        if (opts?.failPump) return Promise.reject(new Error('无可用屏幕采集源'))
        void Promise.resolve().then(() => {
          onFrame({ bytes: new Uint8Array([1]), width: 1600, height: 900 })
          onFrame({ bytes: new Uint8Array([2]), width: 1600, height: 900 })
        })
        return Promise.resolve({ stop: () => stopped.push(1) })
      },
    }
    return { bridge, frames, stopped }
  }
  const noFfmpeg = async () => ({ exitCode: 1, stdout: '', stderr: '' }) as never

  it('stream：无 ffmpeg + 泵在场 → L2 会话（mjpeg 编码、帧直通、close → stop）', async () => {
    const { bridge, stopped } = pumpBridge()
    const ctrl = new HostScreenControl({ bridge, spawner: spawnerOf().spawner, runner: noFfmpeg })
    const s = await ctrl.stream('hostscreen-img-1', { codec: 'h264' })
    expect(s.codec).toBe('mjpeg') // 帧序列走 mjpeg 管线（裁定 D——零新 wire codec）
    const got: number[] = []
    s.onData((b) => got.push(b[0]!))
    await new Promise((r) => setTimeout(r, 20))
    expect(got).toEqual([1, 2])
    s.close()
    expect(stopped).toHaveLength(1)
  })

  it('泵起不来 → 会话内自愈降级 L0 轮询（帧仍到）', async () => {
    const { bridge } = pumpBridge({ failPump: true })
    const ctrl = new HostScreenControl({ bridge, spawner: spawnerOf().spawner, runner: noFfmpeg })
    const s = await ctrl.stream('hostscreen-img-1', { codec: 'h264' })
    expect(s.codec).toBe('mjpeg')
    const got: number[] = []
    s.onData((b) => got.push(b[0]!))
    await new Promise((r) => setTimeout(r, 200))
    expect(got.length).toBeGreaterThanOrEqual(1) // L0 帧照流
    s.close()
  })

  it('streamTier：ffmpeg 在场 l1 > 泵在场 l2 > 兜底 l0（v1.images.test 三档报告的事实源）', async () => {
    const okRunner = async () => ({ exitCode: 0, stdout: '', stderr: '' }) as never
    const l1 = new HostScreenControl({ bridge: pumpBridge().bridge, runner: okRunner })
    await expect(l1.streamTier()).resolves.toBe('l1')
    const l2 = new HostScreenControl({ bridge: pumpBridge().bridge, runner: noFfmpeg })
    await expect(l2.streamTier()).resolves.toBe('l2')
    const plain = bridgeOf()
    const l0 = new HostScreenControl({ bridge: plain, runner: noFfmpeg })
    await expect(l0.streamTier()).resolves.toBe('l0')
  })
})
