/**
 * Android adb 后端/屏幕适配器测试（plan-screen-firstclass P9-3b）：argv/脚本锁死（复用
 * buildRemoteScript 的 POSIX 包装——编码前内容逐字断言）、attach 语义、caps、注入词表
 * 映射（tap/swipe/keyevent/keycombination/text-ASCII）、wm size 解析（Override 优先）、
 * b64 截图 PNG 魔数校验、screenrecord h264 流。全程替身——零真实 adb、零真实设备。
 */
import { describe, expect, it } from 'vitest'
import { AdbBoxBackend, adbBoxId, adbBaseArgv } from '../src/backend-adb/index.js'
import { AdbScreenControl, adbKeycodeOf, parseWmSize, serializeAdbActions } from '../src/screen/adb.js'
import { SSH_BOX_CAPS } from '../src/backend-ssh/index.js'
import { BoxesErrorCodes } from '../src/types.js'
import type { ScreenControlHost } from '../src/screen/index.js'
import type { ScreenAction, ScreenGeometry } from '../src/screen/index.js'

const GEO: ScreenGeometry = { width: 1080, height: 2400 }

const runnerOf = () => {
  const calls: Array<{ argv: string[]; input?: string }> = []
  const result = { exitCode: 0, stdout: 'ok', stderr: '' }
  const run = (async (spec: { command: string[]; input?: string }) => {
    calls.push({ argv: spec.command, ...(spec.input !== undefined ? { input: spec.input } : {}) })
    return { ...result, timedOut: false, aborted: false }
  }) as never
  return { calls, result, run }
}

describe('AdbBoxBackend（替身 run）', () => {
  const make = () => {
    const { calls, result, run } = runnerOf()
    const b = new AdbBoxBackend({ host: 'R58NXXXXXX', run, now: () => 42 })
    return { b, calls, result }
  }

  it('caps：SSH 同矩阵（persistent ✓ / snapshot ✗ / interactive ✓ / isolation high）', () => {
    expect(new AdbBoxBackend({ host: 'h' }).caps()).toEqual(SSH_BOX_CAPS)
  })

  it('create：连通（echo ok 应答校验）+ 工作目录确保；幂等零二次往返', async () => {
    const { b, calls } = make()
    const boxId = await b.create({ image: 'img-1' })
    expect(boxId).toBe(adbBoxId('R58NXXXXXX'))
    expect(adbBoxId('R58N XXXX')).toBe('adb-R58N-XXXX') // 序列号净化
    expect(calls[0]!.argv.slice(0, 4)).toEqual(['adb', '-s', 'R58NXXXXXX', 'shell'])
    expect(calls[0]!.argv[calls[0]!.argv.length - 1]).toBe('echo ok')
    expect(calls[1]!.argv[calls[1]!.argv.length - 1]).toBe("mkdir -p '/data/local/tmp/openbot'")
    expect(await b.list()).toHaveLength(1)
    await b.create({ image: 'img-1' })
    expect(calls).toHaveLength(2) // 幂等
  })

  it('create：设备未在场（stdout 无 ok）→ BOX_CREATE_FAILED 如实', async () => {
    const { b, result } = make()
    result.stdout = 'error: device not found'
    result.stderr = ''
    await expect(b.create({ image: 'x' })).rejects.toMatchObject({ code: 'BOX_CREATE_FAILED', message: expect.stringContaining('adb devices') })
  })

  it('exec：POSIX 远端包装（cd + 引号转义——与 SSH 同构）；未 attach → BOX_NOT_FOUND', async () => {
    const { b, calls } = make()
    await b.create({ image: 'img-1' })
    const boxId = adbBoxId('R58NXXXXXX')
    await b.exec(boxId, { command: ['echo', 'hi'], timeoutMs: 5_000 })
    const line = calls[calls.length - 1]!.argv[calls[calls.length - 1]!.argv.length - 1]!
    expect(line).toContain("cd '/data/local/tmp/openbot'")
    expect(line).toContain("'echo' 'hi'")
    await expect(b.exec('adb-other', { command: ['x'], timeoutMs: 10 })).rejects.toMatchObject({ code: 'BOX_NOT_FOUND' })
  })

  it('fsWrite：stdin b64（不进命令行）；fsRead 缺文件 → null；snapshot 稳定码拒绝', async () => {
    const { b, calls, result } = make()
    await b.create({ image: 'img-1' })
    await b.fsWrite(adbBoxId('R58NXXXXXX'), '/data/local/tmp/a.txt', '你好')
    expect(calls[calls.length - 1]!.input).toBe(Buffer.from('你好', 'utf8').toString('base64'))
    result.exitCode = 1
    await expect(b.fsRead(adbBoxId('R58NXXXXXX'), '/missing')).resolves.toBeNull()
    await expect(b.snapshot(adbBoxId('R58NXXXXXX'))).rejects.toMatchObject({ code: BoxesErrorCodes.BOX_UNSUPPORTED })
  })
})

describe('parseWmSize（Override 优先）', () => {
  it('Physical / Override / 缺失三态', () => {
    expect(parseWmSize('Physical size: 1080x2400')).toEqual({ width: 1080, height: 2400 })
    expect(parseWmSize('Physical size: 1080x2400\nOverride size: 720x1600')).toEqual({ width: 720, height: 1600 })
    expect(parseWmSize('error: no device')).toBeNull()
  })
})

describe('serializeAdbActions（注入词表映射）', () => {
  it('click：input tap；连击展开多条；越界（agent）拒绝', () => {
    expect(serializeAdbActions([{ kind: 'click', button: 1, x: 100, y: 200 }], GEO, 'agent')).toEqual(['input tap 100 200'])
    expect(serializeAdbActions([{ kind: 'click', button: 1, x: 10, y: 20, count: 2 }], GEO, 'agent')).toEqual([
      'input tap 10 20',
      'input tap 10 20',
    ])
    expect(() => serializeAdbActions([{ kind: 'click', button: 1, x: 9999, y: 0 }], GEO, 'agent')).toThrowError(/坐标越界/)
  })

  it('滚轮近似（裁定 D）：单指 swipe 屏幕中心——上滚指向下拖', () => {
    const lines = serializeAdbActions([{ kind: 'click', button: 4 }], GEO, 'agent')
    expect(lines).toEqual([`input swipe 540 1440 540 1200 150`])
    expect(serializeAdbActions([{ kind: 'click', button: 5 }], GEO, 'agent')).toEqual(['input swipe 540 1200 540 1440 150'])
  })

  it('键：keyevent 符号名；组合键 keycombination 数值（仅单修饰）；未知键名拒绝', () => {
    expect(serializeAdbActions([{ kind: 'key', key: 'Return' }], GEO, 'agent')).toEqual(['input keyevent KEYCODE_ENTER'])
    expect(serializeAdbActions([{ kind: 'key', key: 'a' }], GEO, 'agent')).toEqual(['input keyevent KEYCODE_A'])
    expect(serializeAdbActions([{ kind: 'key', key: 'ctrl+a' }], GEO, 'agent')).toEqual(['input keycombination 113 29'])
    expect(() => serializeAdbActions([{ kind: 'key', key: 'ctrl+shift+esc' }], GEO, 'agent')).toThrowError(/多修饰键/)
    expect(() => serializeAdbActions([{ kind: 'key', key: 'f13' }], GEO, 'agent')).toThrowError(/未知键名/)
    expect(adbKeycodeOf('f12')).toBe('KEYCODE_F12')
  })

  it('type：仅 ASCII（裁定 A）——空格 %s、双引号转义；中文如实拒绝', () => {
    expect(serializeAdbActions([{ kind: 'type', text: 'ls -la "x"' }], GEO, 'agent')).toEqual(['input text "ls%s-la%s\\"x\\""'])
    expect(() => serializeAdbActions([{ kind: 'type', text: '中文' }], GEO, 'agent')).toThrowError(/ASCII/)
  })

  it('move/down/up：触屏无 hover/半程——不渲染（空行集）', () => {
    expect(serializeAdbActions([{ kind: 'move', x: 1, y: 1 }, { kind: 'down', button: 1 }], GEO, 'agent')).toEqual([])
  })
})

describe('AdbScreenControl（替身 host）', () => {
  interface FakePipe {
    written: string[]
    killed: boolean
    write(t: string): void
    onData(cb: (c: Uint8Array) => void): void
    onExit(cb: (c: number | null) => void): void
    stderrTail(): string
    close(): void
    emit(s: string): void
    exit(c: number | null): void
  }
  const makePipe = (): FakePipe => {
    const outCbs = new Set<(c: Uint8Array) => void>()
    const exitCbs = new Set<(c: number | null) => void>()
    const pipe: FakePipe = {
      written: [],
      killed: false,
      write(t) {
        pipe.written.push(t)
      },
      onData(cb) {
        outCbs.add(cb)
      },
      onExit(cb) {
        exitCbs.add(cb)
      },
      stderrTail: () => '',
      close() {
        pipe.killed = true
      },
      emit(s) {
        for (const cb of outCbs) cb(new TextEncoder().encode(s))
      },
      exit(c) {
        for (const cb of exitCbs) cb(c)
      },
    }
    return pipe
  }
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) // PNG 魔数
  const hostOf = () => {
    const pipes: FakePipe[] = []
    const execScripts: string[] = []
    const host: ScreenControlHost = {
      exec: (async (_boxId: string, spec: { command: string[] }) => {
        const script = spec.command.join(' ')
        execScripts.push(script)
        if (script.includes('wm size')) return { exitCode: 0, stdout: 'Physical size: 1080x2400', stderr: '' }
        if (script.includes('screencap')) {
          return { exitCode: 0, stdout: PNG.toString('base64'), stderr: '' }
        }
        return { exitCode: 0, stdout: '', stderr: '' }
      }) as never,
      openPipe: (async () => {
        const pipe = makePipe()
        pipes.push(pipe)
        return pipe as unknown as import('../src/types.js').PipeSession
      }) as never,
    }
    return { host, pipes, execScripts }
  }

  it('geometry：wm size 解析 + 缓存零重复 exec', async () => {
    const { host, execScripts } = hostOf()
    const ctrl = new AdbScreenControl({ host, execTimeoutMs: 500 })
    await expect(ctrl.geometry('adb-h')).resolves.toEqual({ width: 1080, height: 2400 })
    await ctrl.geometry('adb-h')
    expect(execScripts).toHaveLength(1)
  })

  it('capture：screencap|base64 → PNG 魔数校验 + 1:1 坐标元数据', async () => {
    const { host } = hostOf()
    const ctrl = new AdbScreenControl({ host, execTimeoutMs: 500 })
    const cap = await ctrl.capture('adb-h', {})
    expect(cap.mime).toBe('image/png')
    expect(Array.from(cap.bytes.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47])
    expect(cap.screenWidth).toBe(1080)
    expect(cap.width).toBeUndefined() // 原生分辨率 1:1——无缩放元数据
  })

  it('act：input 命令单行 shell 往返；非 PNG 输出如实报错', async () => {
    const { host, execScripts } = hostOf()
    const ctrl = new AdbScreenControl({ host, execTimeoutMs: 500 })
    await ctrl.act('adb-h', { kind: 'click', button: 1, x: 100, y: 200 })
    expect(execScripts.some((s) => s.includes('input tap 100 200'))).toBe(true)
    // 非法输出（非 PNG 魔数）→ SCREEN_CAPTURE_FAILED
    const bad = hostOf()
    bad.host.exec = (async (_b: string, spec: { command: string[] }) => {
      if (spec.command.join(' ').includes('wm size')) return { exitCode: 0, stdout: 'Physical size: 1080x2400', stderr: '' }
      return { exitCode: 0, stdout: Buffer.from('not png').toString('base64'), stderr: '' }
    }) as never
    await expect(new AdbScreenControl({ host: bad.host, execTimeoutMs: 500 }).capture('adb-h')).rejects.toMatchObject({
      code: 'SCREEN_CAPTURE_FAILED',
    })
  })

  it('stream：screenrecord 循环脚本 + h264 codec（Annex B 直用）', async () => {
    const { host, pipes } = hostOf()
    const ctrl = new AdbScreenControl({ host, execTimeoutMs: 500 })
    const s = await ctrl.stream('adb-h', { codec: 'h264' })
    expect(s.codec).toBe('h264')
    const got: string[] = []
    s.onData((b) => got.push(Buffer.from(b).toString('utf8')))
    pipes[0]!.emit('raw-h264-chunk')
    await new Promise((r) => setTimeout(r, 10))
    expect(got).toEqual(['raw-h264-chunk']) // 原始字节直通（零拆帧——h264raw 语义）
    s.close()
    expect(pipes[0]!.killed).toBe(true)
  })
})

// argv 面静态引用（保持 adbBaseArgv 导出被消费）
void adbBaseArgv
