/**
 * X11ScreenControl 适配器测试（plan-image-firstclass P8-2）：行为等价迁移的 argv 锁死——
 * 截图管道（唯一临时文件/缩放/质量/光标）、动作序列化（单引号转义/坐标换算/连击）、
 * 实况流（清场 pkill 拆半/pidfile 包装/双引擎 argv/close 补刀）、几何缓存、常驻注入通道
 * （结构化动作 → 行式 xdotool——renderer 侧翻译已随 P8-2 上收）。
 * 这些断言原散布在 runner/computer-tools 与 coordinator/gui-stream 测试——随命令上收适配器。
 */
import { describe, expect, it } from 'vitest'
import { ScreenErrorCodes, X11ScreenControl, probeX11Toolset, serializeHumanTrack, serializeScreenAction } from '../src/screen/index.js'
import type { ScreenAction, ScreenControlHost } from '../src/screen/index.js'
import type { ExecResult, ExecSpec, PipeSession, PipeSpec } from '../src/types.js'

const OK: ExecResult = { exitCode: 0, stdout: '', stderr: '' }

/** 窄替身 host：exec 可编排应答、openPipe 记录 spec 返回可控会话 */
function fakeHost(respond?: (spec: ExecSpec) => ExecResult): {
  host: ScreenControlHost
  execs: ExecSpec[]
  pipes: Array<{ spec: PipeSpec; pipe: FakePipe }>
} {
  const execs: ExecSpec[] = []
  const pipes: Array<{ spec: PipeSpec; pipe: FakePipe }> = []
  const host: ScreenControlHost = {
    exec: async (_boxId, spec) => {
      execs.push(spec)
      return respond ? respond(spec) : OK
    },
    openPipe: async (_boxId, spec) => {
      const pipe = new FakePipe()
      pipes.push({ spec, pipe })
      return pipe
    },
  }
  return { host, execs, pipes }
}

/** 可控管道替身（与 gui-stream 测试的 FakePipe 同构） */
class FakePipe implements PipeSession {
  closed = false
  tail = ''
  written: string[] = []
  #dataCb: ((chunk: Uint8Array) => void) | null = null
  #exitCb: ((code: number | null) => void) | null = null
  onData(cb: (chunk: Uint8Array) => void): void {
    this.#dataCb = cb
  }
  onExit(cb: ((code: number | null) => void)): void {
    this.#exitCb = cb
  }
  stderrTail(): string {
    return this.tail
  }
  write(text: string): void {
    this.written.push(text)
  }
  close(): void {
    if (this.closed) return
    this.closed = true
    this.#exitCb?.(null)
  }
  /** 测试方手动喂帧字节（模拟采集进程输出） */
  emit(chunk: Uint8Array): void {
    this.#dataCb?.(chunk)
  }
  /** 测试方手动触发进程退出 */
  exit(code: number | null): void {
    this.#exitCb?.(code)
  }
}

const geoResponder = (geo: string): ((spec: ExecSpec) => ExecResult) => (spec) =>
  spec.command.includes('getdisplaygeometry') ? { ...OK, stdout: geo } : OK

describe('X11ScreenControl 几何与坐标换算', () => {
  it('geometry：xdotool getdisplaygeometry + DISPLAY env；缓存 per boxId（二次调用零 exec）', async () => {
    const { host, execs } = fakeHost(geoResponder('1920 1080'))
    const screen = new X11ScreenControl({ host, display: ':0' })
    await expect(screen.geometry('box-1')).resolves.toEqual({ width: 1920, height: 1080 })
    expect(execs[0]?.env).toEqual({ DISPLAY: ':0' })
    await expect(screen.geometry('box-1')).resolves.toEqual({ width: 1920, height: 1080 })
    expect(execs).toHaveLength(1)
    await expect(screen.geometry('box-2')).resolves.toEqual({ width: 1920, height: 1080 })
    expect(execs).toHaveLength(2)
  })

  it('geometry：非几何输出/exit≠0/异常 → null（如实降级）', async () => {
    const { host } = fakeHost(() => ({ ...OK, stdout: 'mock: xdotool getdisplaygeometry' }))
    const screen = new X11ScreenControl({ host })
    await expect(screen.geometry('box-1')).resolves.toBeNull()
    const broken = new X11ScreenControl({ host: fakeHost(() => ({ ...OK, exitCode: 1 } as ExecResult)).host })
    await expect(broken.geometry('box-1')).resolves.toBeNull()
  })

  it('act(click)：1080p 屏幕按 1.5 倍换算注入（模型按 1280×720 截图报坐标——v0.1.17 语义）', async () => {
    const { host, execs } = fakeHost(geoResponder('1920 1080'))
    const screen = new X11ScreenControl({ host, display: ':0' })
    await screen.act('box-1', { kind: 'click', button: 1, x: 640, y: 360 })
    expect(execs[execs.length - 1]?.command).toEqual(['sh', '-c', 'xdotool mousemove 960 540 click 1'])
    expect(execs[execs.length - 1]?.env).toEqual({ DISPLAY: ':0' })
  })

  it('act：屏幕 ≤1280（比例 1）与几何查询失败均降级不换算（坐标原样注入）', async () => {
    const { host, execs } = fakeHost(geoResponder('1280 800'))
    const screen = new X11ScreenControl({ host })
    await screen.act('box-small', { kind: 'click', button: 1, x: 640, y: 360 })
    expect(execs[execs.length - 1]?.command).toEqual(['sh', '-c', 'xdotool mousemove 640 360 click 1'])

    // 几何查询失败但 act 本身成功——降级不换算照常注入
    const { host: brokenHost, execs: brokenExecs } = fakeHost((spec) =>
      spec.command.includes('getdisplaygeometry') ? { ...OK, exitCode: 1 } : OK,
    )
    const broken = new X11ScreenControl({ host: brokenHost })
    await broken.act('box-broken', { kind: 'click', button: 1, x: 640, y: 360 })
    expect(brokenExecs[brokenExecs.length - 1]?.command).toEqual(['sh', '-c', 'xdotool mousemove 640 360 click 1'])
  })

  it('act 失败（exit≠0）→ SCREEN_ACT_FAILED；与既有 COMPUTER_ACT_FAILED 语义同型', async () => {
    const { host } = fakeHost((spec) => (spec.command.includes('getdisplaygeometry') ? geoResponder('1280 800')(spec) : { ...OK, exitCode: 1, stderr: 'bad' }))
    const screen = new X11ScreenControl({ host })
    await expect(screen.act('box-1', { kind: 'key', key: 'Return' })).rejects.toMatchObject({
      code: ScreenErrorCodes.SCREEN_ACT_FAILED,
    })
  })
})

describe('humanMove（人味移动——X11 注入形态）', () => {
  it('getmouselocation 查 from（真实像素）→ 契约换算 → 单次 exec 逐帧 mousemove+sleep；途经点按序、末帧=末点×scale', async () => {
    const { host, execs } = fakeHost((spec) => {
      if (spec.command.includes('getdisplaygeometry')) return { ...OK, stdout: '1920 1080' }
      if (spec.command[0] === 'xdotool' && spec.command[1] === 'getmouselocation') {
        return { ...OK, stdout: 'x:100 y:80 screen:0 window:123' }
      }
      return OK
    })
    const screen = new X11ScreenControl({ host, display: ':0' })
    await screen.humanMove('box-1', [
      { x: 900, y: 180 },
      { x: 640, y: 360 },
    ], { seed: 42, durationMs: 900 })
    // exec 序：geometry → getmouselocation → 轨迹（单次——多段也是一条 shell 串）
    expect(execs[1]?.command).toEqual(['xdotool', 'getmouselocation'])
    expect(execs).toHaveLength(3)
    const script = String(execs[2]?.command[2])
    expect(execs[2]?.command.slice(0, 2)).toEqual(['sh', '-c'])
    expect(script.startsWith('xdotool mousemove ')).toBe(true)
    expect(script).toContain('; sleep 0.')
    // 样条连续穿过途经点（不驻留但路过 40px 邻域）：900×1.5=1350,180×1.5=270（1280 契约→1920）
    const coords = [...script.matchAll(/xdotool mousemove (\d+) (\d+)/g)].map((m) => ({
      x: Number(m[1]),
      y: Number(m[2]),
    }))
    expect(coords.some((c) => Math.hypot(c.x - 1350, c.y - 270) <= 40)).toBe(true)
    const segs = script.split('; ')
    const finalMove = segs[segs.length - 2] // 最后一个 sleep 前的 move（串以 sleep 结尾）
    expect(finalMove).toBe('xdotool mousemove 960 540')
  })

  it('from 查询失败（exit≠0）→ 降级首段直达（行为等价普通 move——不瞎猜起点）', async () => {
    const { host, execs } = fakeHost((spec) => {
      if (spec.command.includes('getdisplaygeometry')) return { ...OK, stdout: '1280 800' }
      if (spec.command[1] === 'getmouselocation') return { ...OK, exitCode: 1 }
      return OK
    })
    const screen = new X11ScreenControl({ host })
    await screen.humanMove('box-1', [{ x: 640, y: 360 }], { seed: 7 })
    const script = String(execs[execs.length - 1]?.command[2])
    expect(script).toBe('xdotool mousemove 640 360; sleep 0.016') // from=首点 → 首段退化单帧
  })

  it('轨迹 exec 失败（exit≠0）→ SCREEN_ACT_FAILED（错误可见）', async () => {
    const { host } = fakeHost((spec) => {
      if (spec.command.includes('getdisplaygeometry')) return { ...OK, stdout: '1280 800' }
      if (spec.command[1] === 'getmouselocation') return { ...OK, stdout: 'x:10 y:10 screen:0 window:1' }
      return { ...OK, exitCode: 1, stderr: 'no display' }
    })
    const screen = new X11ScreenControl({ host })
    await expect(screen.humanMove('box-1', [{ x: 600, y: 400 }], { seed: 7 })).rejects.toMatchObject({
      code: ScreenErrorCodes.SCREEN_ACT_FAILED,
      message: expect.stringContaining('人味移动失败'),
    })
  })

  it('serializeHumanTrack：帧 → 串接命令（mousemove 后跟 sleep，秒三位小数）；scale 供未换算帧', () => {
    expect(
      serializeHumanTrack(
        [
          { x: 10, y: 20, dtMs: 16 },
          { x: 30, y: 40, dtMs: 20 },
        ],
        null,
      ),
    ).toBe('xdotool mousemove 10 20; sleep 0.016; xdotool mousemove 30 40; sleep 0.020')
    expect(serializeHumanTrack([{ x: 100, y: 200, dtMs: 16 }], 1.5)).toContain('xdotool mousemove 150 300')
  })
})

describe('serializeScreenAction（动作 → 一条 xdotool 命令——与既有命令逐字节等价）', () => {
  const cases: Array<[ScreenAction, number | null, string]> = [
    [{ kind: 'click', button: 1, x: 100, y: 200 }, null, 'xdotool mousemove 100 200 click 1'],
    [{ kind: 'click', button: 1, x: 640, y: 360 }, 1.5, 'xdotool mousemove 960 540 click 1'],
    [{ kind: 'click', button: 1, x: 10, y: 20, count: 2, intervalMs: 150 }, null, 'xdotool mousemove 10 20 click --repeat 2 --delay 150 1'],
    [{ kind: 'click', button: 4, count: 2, intervalMs: 60 }, null, 'xdotool click --repeat 2 --delay 60 4'],
    [{ kind: 'move', x: 30, y: 40 }, null, 'xdotool mousemove 30 40'],
    [{ kind: 'down', button: 3 }, null, 'xdotool mousedown 3'],
    [{ kind: 'up', button: 3 }, null, 'xdotool mouseup 3'],
    [{ kind: 'key', key: 'ctrl+a' }, null, 'xdotool key ctrl+a'],
    [{ kind: 'type', text: "it's" }, null, `xdotool type --delay 0 -- 'it'\\''s'`],
    [{ kind: 'type', text: 'hello', delayMs: 30 }, null, `xdotool type --delay 30 -- 'hello'`],
  ]
  for (const [action, scale, expected] of cases) {
    it(`${JSON.stringify(action)} (scale=${scale})`, () => {
      expect(serializeScreenAction(action, scale)).toBe(expected)
    })
  }
})

describe('X11ScreenControl capture（截图管道——唯一临时文件/缩放/光标）', () => {
  it('agent 档：scrot --pointer + convert 1280x> q80 + base64；几何在场时附两端尺寸', async () => {
    // 几何返回 1920x1080；截图管道返回合法 base64（'aW1n'）
    const { host, execs } = fakeHost((spec) =>
      spec.command.includes('getdisplaygeometry')
        ? { ...OK, stdout: '1920 1080' }
        : { ...OK, stdout: 'aW1n' },
    )
    const screen = new X11ScreenControl({ host, display: ':0' })
    const capture = await screen.capture('box-1')
    const spec = execs[execs.length - 1]!
    const script = spec.command[2] ?? ''
    expect(script).toContain("f=/tmp/.openbot-shot-$$.png") // 唯一临时文件（IDAT CRC 修复）
    expect(script).toContain('scrot --pointer -o')
    expect(script).toContain("-resize '1280x>'")
    expect(script).toContain('png:-') // v0.1.117 PNG 输出（端点对 jpeg 400）
    expect(script).toContain('base64 -w0')
    expect(script).toContain('rm -f')
    expect(spec.env).toEqual({ DISPLAY: ':0' })
    expect(capture.mime).toBe('image/png')
    expect(capture.width).toBe(1280)
    expect(capture.height).toBe(720)
    expect(capture.screenWidth).toBe(1920)
    expect(capture.screenHeight).toBe(1080)
  })

  it('UI 档：maxWidth 1920/q85 不缩放时无尺寸元数据；空输出/exit≠0 → SCREEN_CAPTURE_FAILED', async () => {
    const { host, execs } = fakeHost((spec) =>
      spec.command.includes('getdisplaygeometry')
        ? { ...OK, stdout: '1280 800' }
        : { ...OK, stdout: 'aW1n' },
    )
    const screen = new X11ScreenControl({ host })
    const capture = await screen.capture('box-1', { maxWidth: 1920, quality: 85 })
    const script = execs[execs.length - 1]?.command[2] ?? ''
    expect(script).toContain("-resize '1920x>'")
    expect(script).toContain('png:-')
    expect(capture.width).toBeUndefined() // 1280 屏不触发缩放（比例 1）

    const empty = new X11ScreenControl({ host: fakeHost(() => ({ ...OK, stdout: '  ' })).host })
    await expect(empty.capture('box-1')).rejects.toMatchObject({ code: ScreenErrorCodes.SCREEN_CAPTURE_FAILED })
    const failed = new X11ScreenControl({ host: fakeHost(() => ({ ...OK, exitCode: 1, stderr: 'no display' })).host })
    await expect(failed.capture('box-1')).rejects.toMatchObject({ code: ScreenErrorCodes.SCREEN_CAPTURE_FAILED })
  })
})

describe('X11ScreenControl stream（实况采集——清场/pidfile/双引擎 argv）', () => {
  it('开流：先清场（pkill 拆半模式 + rm pidfile）→ openPipe pidfile 包装 + h264 argv + DISPLAY', async () => {
    const { host, execs, pipes } = fakeHost(geoResponder('1280 800'))
    const screen = new X11ScreenControl({ host, display: ':0' })
    const session = await screen.stream('box-1', { fps: 60, codec: 'h264' })
    expect(execs[0]?.command[2]).toContain('pkill -9 -f')
    expect(execs[0]?.command[2]).toContain('rm -f /tmp/.openbot-gui-stream.pid')
    const spec = pipes[0]?.spec
    expect(spec?.env).toEqual({ DISPLAY: ':0' })
    expect(spec?.command).toEqual([
      'sh', '-c', 'echo $$ > /tmp/.openbot-gui-stream.pid; exec "$@"', 'sh',
      'ffmpeg', '-nostdin',
      '-f', 'x11grab',
      '-draw_mouse', '1',
      '-framerate', '60',
      '-video_size', '1280x800',
      '-i', ':0',
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-tune', 'zerolatency',
      '-crf', '18',
      '-g', '30',
      '-pix_fmt', 'yuv420p',
      '-f', 'h264',
      'pipe:1',
    ])
    expect(session.codec).toBe('h264')
  })

  it('mjpeg 引擎 argv（一期回退路径）与几何查询失败落 1920x1080 兜底放行', async () => {
    const { host, pipes } = fakeHost(() => ({ ...OK, exitCode: 1 })) // 几何查询失败
    const screen = new X11ScreenControl({ host, display: '127.0.0.1:2' })
    await screen.stream('box-1', { fps: 30, codec: 'mjpeg' })
    const argv = pipes[0]?.spec.command.slice(4) ?? []
    expect(argv).toEqual([
      'ffmpeg', '-nostdin',
      '-f', 'x11grab',
      '-draw_mouse', '1',
      '-framerate', '30',
      '-video_size', '1920x1080', // 兜底几何
      '-i', '127.0.0.1:2',
      '-f', 'mjpeg',
      '-q:v', '3',
      'pipe:1',
    ])
  })

  it('close：pidfile 精确补刀 exec（坑⑯）+ 管道关闭；字节/退出/诊断尾经会话透传', async () => {
    const { host, execs, pipes } = fakeHost(geoResponder('1280 800'))
    const screen = new X11ScreenControl({ host })
    const session = await screen.stream('box-1')
    const pipe = pipes[0]!.pipe
    let received: Uint8Array | null = null
    let exitCode: number | null | undefined
    session.onData((c) => {
      received = c
    })
    session.onExit((c) => {
      exitCode = c
    })
    const chunk = Uint8Array.of(1, 2, 3)
    pipe.emit(chunk)
    pipe.tail = 'boom'
    expect(session.stderrTail()).toBe('boom')
    expect([...(received ?? [])]).toEqual([1, 2, 3])
    session.close()
    expect(pipe.closed).toBe(true)
    const killExec = execs[execs.length - 1]?.command[2] ?? ''
    expect(killExec).toContain('kill -9 "$(cat /tmp/.openbot-gui-stream.pid)"')
    expect(killExec).toContain('rm -f /tmp/.openbot-gui-stream.pid')
    pipe.exit(0)
    expect(exitCode).toBe(0)
  })

  it('supportsStream：host 无 openPipe → false（实况如实降级截图轮询）', () => {
    const bare = new X11ScreenControl({ host: { exec: async () => OK } })
    expect(bare.supportsStream()).toBe(false)
    const { host } = fakeHost()
    expect(new X11ScreenControl({ host }).supportsStream()).toBe(true)
  })
})

describe('X11ScreenControl inputChannel（常驻注入——结构化动作 → 行式 xdotool）', () => {
  it('惰性建立：清场 + sh -s 标签通道 + DISPLAY；write 序列化动作批次（用户坐标不换算）', async () => {
    const { host, execs, pipes } = fakeHost()
    const screen = new X11ScreenControl({ host, display: ':0' })
    const channel = await screen.inputChannel('box-1')
    expect(channel).not.toBeNull()
    expect(execs[0]?.command[2]).toContain("'openbot-gui-''input'") // 坑⑱b 模式拆半拼接
    expect(pipes[0]?.spec.command).toEqual(['sh', '-s', 'openbot-gui-input'])
    expect(pipes[0]?.spec.env).toEqual({ DISPLAY: ':0' })
    channel!.write([
      { kind: 'move', x: 100, y: 200 },
      { kind: 'down', button: 1 },
      { kind: 'type', text: "it's" },
      { kind: 'key', key: 'Return' },
    ])
    expect(pipes[0]!.pipe.written).toHaveLength(1)
    expect(pipes[0]!.pipe.written[0]).toBe(
      `xdotool mousemove 100 200\nxdotool mousedown 1\nxdotool type --delay 0 -- 'it'\\''s'\nxdotool key Return\n`,
    )
    // 同 box 复用（零重建）
    await screen.inputChannel('box-1')
    expect(pipes).toHaveLength(1)
  })

  it('进程退出自动除名（下次输入重建）；host 无 openPipe → null（回退逐动作 act）', async () => {
    const { host, pipes } = fakeHost()
    const screen = new X11ScreenControl({ host })
    await screen.inputChannel('box-1')
    pipes[0]!.pipe.close() // 触发 onExit
    await new Promise((r) => setTimeout(r, 0))
    await screen.inputChannel('box-1')
    expect(pipes).toHaveLength(2)

    const bare = new X11ScreenControl({ host: { exec: async () => OK } })
    await expect(bare.inputChannel('box-1')).resolves.toBeNull()
  })

  it('dispose：全部常驻通道关闭（孤儿纪律）', async () => {
    const { host, pipes } = fakeHost()
    const screen = new X11ScreenControl({ host })
    await screen.inputChannel('box-1')
    await screen.inputChannel('box-2')
    screen.dispose()
    expect(pipes[0]?.pipe.closed).toBe(true)
    expect(pipes[1]?.pipe.closed).toBe(true)
  })
})

describe('probeX11Toolset（B2——生产注册门事实源）', () => {
  it('xdotool+scrot 在场 → true；缺席（exit≠0）或探测异常 → false（如实）', async () => {
    const { host, execs } = fakeHost()
    await expect(probeX11Toolset(host, 'box-1')).resolves.toBe(true)
    expect(execs[0]?.command).toEqual(['sh', '-c', 'command -v xdotool >/dev/null 2>&1 && command -v scrot >/dev/null 2>&1'])
    const absent = fakeHost(() => ({ ...OK, exitCode: 1 }))
    await expect(probeX11Toolset(absent.host, 'box-1')).resolves.toBe(false)
    const throwing: ScreenControlHost = {
      exec: async () => {
        throw new Error('box gone')
      },
    }
    await expect(probeX11Toolset(throwing, 'box-1')).resolves.toBe(false)
  })
})
