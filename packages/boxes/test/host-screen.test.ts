/**
 * 宿主屏幕适配器测试（plan-screen-firstclass P9-1）：行协议序列化（argv 锁死纪律的
 * stdin 行对位——PS 协议行逐条断言）、键名映射、坐标域校验（agent 拒 / user 钳）、
 * L0/L1 流档位（ffmpeg 探测分岔 argv 锁死）、注入通道 ready 握手、桥注入面。
 * 全程替身 spawner/runner/bridge——零真实进程、零真实屏幕。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  HOST_INJECT_SCRIPT,
  HOST_SCREEN_BOX_ID,
  HostScreenControl,
  keyToVk,
  serializeHostAction,
} from '../src/screen/host-screen.js'
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
    expect(cap.mime).toBe('image/jpeg')
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

  it('create=attach 幂等记账；teardown 只清账；list/stats 如实', async () => {
    const b = new HostScreenBoxBackend({ now: () => 42 })
    expect(await b.list()).toEqual([])
    expect(await b.create({ image: 'img-1' })).toBe(HOST_SCREEN_BOX_ID)
    expect(await b.create({ image: 'img-2' })).toBe(HOST_SCREEN_BOX_ID) // 幂等——多路由共享一台屏幕
    expect(await b.list()).toHaveLength(1)
    expect(await b.stats(HOST_SCREEN_BOX_ID)).toEqual({})
    await b.teardown(HOST_SCREEN_BOX_ID)
    expect(await b.list()).toEqual([])
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
