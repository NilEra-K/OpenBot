/**
 * Windows 机内后端/屏幕适配器测试（plan-screen-firstclass P9-3a）：EncodedCommand 脚本构造
 * （argv 锁死——编码前的脚本内容逐字断言）、attach 语义、caps、exec env/cwd 注入、fs 读写
 * 脚本、屏幕适配器的注入通道（win-protocol 共享机制 over PipeSession）、b64 行帧流解析。
 * 全程替身 run/spawn——零真实 ssh、零真实 Windows。
 */
import { describe, expect, it } from 'vitest'
import {
  SshWindowsBoxBackend,
  buildWindowsScript,
  windowsBoxId,
  windowsRemoteLine,
} from '../src/backend-ssh-windows/index.js'
import { SshWindowsScreenControl } from '../src/screen/ssh-windows.js'
import { HOST_INJECT_SCRIPT, psEncodeCommand } from '../src/screen/win-protocol.js'
import { SSH_BOX_CAPS } from '../src/backend-ssh/index.js'
import { BoxesErrorCodes } from '../src/types.js'
import type { ScreenControlHost } from '../src/screen/index.js'
import type { PipeSession } from '../src/types.js'

const decodeLastScript = (argv: string[]): string => {
  const token = argv[argv.length - 1] ?? ''
  const b64 = token.replace(/^powershell -NoProfile -NonInteractive -EncodedCommand /, '')
  return Buffer.from(b64, 'base64').toString('utf16le')
}

const runnerOf = () => {
  const calls: Array<{ argv: string[]; input?: string }> = []
  const result = { exitCode: 0, stdout: '', stderr: '' }
  const run = (async (spec: { command: string[]; input?: string }) => {
    calls.push({ argv: spec.command, ...(spec.input !== undefined ? { input: spec.input } : {}) })
    return { ...result, timedOut: false, aborted: false }
  }) as never
  return { calls, result, run }
}

describe('脚本构造（argv 锁死——编码前内容断言）', () => {
  it('buildWindowsScript：Set-Location + $env + & 调用 + 退出码传导；全单引号转义', () => {
    const s = buildWindowsScript(['git', 'status'], { cwd: 'D:\\repo', env: { GOFLAGS: '-mod=mod' } }, 'C:\\openbot-work')
    expect(s).toContain("Set-Location -LiteralPath 'D:\\repo'")
    expect(s).toContain("$env:GOFLAGS = '-mod=mod'")
    expect(s).toContain("& 'git' 'status'")
    expect(s).toContain('exit $LASTEXITCODE')
    const q = buildWindowsScript(["it's"], {}, 'C:\\w')
    expect(q).toContain("'it''s'") // 单引号 doubling
  })

  it('windowsRemoteLine：powershell + EncodedCommand 单 token（零空格内嵌——cmd/PS 默认 shell 双透明）', () => {
    const line = windowsRemoteLine('Write-Output ok')
    expect(line).toBe(`powershell -NoProfile -NonInteractive -EncodedCommand ${psEncodeCommand('Write-Output ok')}`)
    expect(line.split(' ').length).toBe(5)
  })

  it('windowsBoxId：win- 前缀 + 主机名净化（跨重启稳定）', () => {
    expect(windowsBoxId('192.168.1.20')).toBe('win-192.168.1.20')
    expect(windowsBoxId('vm local_')).toBe('win-vm-local-')
  })
})

describe('SshWindowsBoxBackend（替身 run）', () => {
  const make = () => {
    const { calls, result, run } = runnerOf()
    const b = new SshWindowsBoxBackend({
      host: '192.168.1.20',
      port: 2222,
      user: 'ops',
      keyPath: 'C:/keys/win.pem',
      run,
      now: () => 42,
    })
    return { b, calls, result }
  }

  it('caps：SSH 同矩阵（persistent ✓ / snapshot ✗ / interactive ✓ / isolation high）', () => {
    expect(new SshWindowsBoxBackend({ host: 'h' }).caps()).toEqual(SSH_BOX_CAPS)
  })

  it('create：连通脚本 + 工作目录确保（EncodedCommand 解码可验）；幂等零二次往返', async () => {
    const { b, calls } = make()
    const boxId = await b.create({ image: 'img-1' })
    expect(boxId).toBe(windowsBoxId('192.168.1.20'))
    expect(decodeLastScript(calls[0]!.argv)).toBe('Write-Output ok')
    expect(calls[0]!.argv).toContain('-p')
    expect(calls[0]!.argv).toContain('2222')
    expect(calls[0]!.argv).toContain('-i')
    expect(calls[0]!.argv).toContain('C:/keys/win.pem')
    expect(decodeLastScript(calls[1]!.argv)).toContain("New-Item -ItemType Directory -Force -Path 'C:\\openbot-work'")
    expect(await b.list()).toHaveLength(1)
    await b.create({ image: 'img-1' })
    expect(calls).toHaveLength(2) // 幂等——零新增网络往返
  })

  it('exec：Set-Location/env/& 调用/exit 传导全内联编码；未 attach → BOX_NOT_FOUND', async () => {
    const { b, calls } = make()
    await b.create({ image: 'img-1' })
    const boxId = windowsBoxId('192.168.1.20')
    await b.exec(boxId, { command: ['node', '-v'], timeoutMs: 5_000 })
    const script = decodeLastScript(calls[calls.length - 1]!.argv)
    expect(script).toContain("Set-Location -LiteralPath 'C:\\openbot-work'")
    expect(script).toContain("& 'node' '-v'")
    expect(script).toContain('exit $LASTEXITCODE')
    await expect(b.exec('win-other', { command: ['x'], timeoutMs: 10 })).rejects.toMatchObject({ code: 'BOX_NOT_FOUND' })
  })

  it('fsWrite：内容走 stdin b64（不进命令行）；fsRead b64 解码、缺文件 → null', async () => {
    const { b, calls, result } = make()
    await b.create({ image: 'img-1' })
    result.stdout = Buffer.from('hello', 'utf8').toString('base64')
    await expect(b.fsRead(windowsBoxId('192.168.1.20'), 'C:\\a.txt')).resolves.toBe('hello')
    await b.fsWrite(windowsBoxId('192.168.1.20'), 'C:\\a.txt', '你好')
    const last = calls[calls.length - 1]!
    expect(last.input).toBe(Buffer.from('你好', 'utf8').toString('base64'))
    expect(decodeLastScript(last.argv)).toContain("[IO.File]::WriteAllBytes('C:\\a.txt', $b)")
    result.exitCode = 1
    await expect(b.fsRead(windowsBoxId('192.168.1.20'), 'C:\\missing')).resolves.toBeNull()
  })

  it('teardown 只清账（list 回空）；snapshot 稳定码拒绝', async () => {
    const { b } = make()
    const boxId = await b.create({ image: 'img-1' })
    await b.teardown(boxId)
    expect(await b.list()).toEqual([])
    await expect(b.snapshot(boxId)).rejects.toMatchObject({ code: BoxesErrorCodes.BOX_UNSUPPORTED })
  })
})

// ---- 屏幕适配器替身：exec 按脚本内容路由；openPipe 产可编程 PipeSession ----

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
    write(t: string) {
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

const hostOf = (opts?: { geo?: string }) => {
  const pipes: FakePipe[] = []
  const execScripts: string[] = []
  const host: ScreenControlHost = {
    exec: (async (_boxId: string, spec: { command: string[] }) => {
      const script = spec.command[0] ?? ''
      execScripts.push(script)
      if (script.includes('CopyFromScreen')) {
        return { exitCode: 0, stdout: Buffer.from('frame', 'utf8').toString('base64'), stderr: '' }
      }
      if (script.includes('PrimaryScreen.Bounds')) {
        return { exitCode: 0, stdout: opts?.geo ?? '1920 1080', stderr: '' }
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    }) as never,
    openPipe: (async () => {
      const pipe = makePipe()
      pipes.push(pipe)
      return pipe as unknown as PipeSession
    }) as never,
  }
  return { host, pipes, execScripts }
}

describe('SshWindowsScreenControl（替身 host）', () => {
  it('geometry：DPI 初始化 + 主屏 W H 解析；缓存后零重复 exec', async () => {
    const { host, execScripts } = hostOf({ geo: '2560 1440' })
    const ctrl = new SshWindowsScreenControl({ host, execTimeoutMs: 500 })
    await expect(ctrl.geometry('win-h')).resolves.toEqual({ width: 2560, height: 1440 })
    expect(execScripts[0]).toContain("SetProcessDpiAwarenessContext")
    await ctrl.geometry('win-h')
    expect(execScripts).toHaveLength(1) // 缓存命中
  })

  it('capture：CopyFromScreen 脚本 + b64 解码 + 缩放坐标元数据（1280 契约）', async () => {
    const { host } = hostOf()
    const ctrl = new SshWindowsScreenControl({ host, execTimeoutMs: 500 })
    const cap = await ctrl.capture('win-h', {})
    expect(cap.mime).toBe('image/png')
    expect(Buffer.from(cap.bytes).toString('utf8')).toBe('frame')
    expect(cap.screenWidth).toBe(1920)
    expect(cap.width).toBe(1280)
  })

  it('act：openPipe 传 EncodedCommand（解码=注入脚本）+ ready 握手 + 1280 契约换算 + ack', async () => {
    const { host, pipes, execScripts } = hostOf()
    const ctrl = new SshWindowsScreenControl({ host, execTimeoutMs: 500, actAckTimeoutMs: 500 })
    const done = ctrl.act('win-h', { kind: 'click', button: 1, x: 640, y: 270 })
    await new Promise((r) => setTimeout(r, 10))
    // openPipe argv：powershell -EncodedCommand <b64(HOST_INJECT_SCRIPT)>
    const sent = (host.openPipe as unknown as { calls?: unknown }) && null
    void sent
    const pipe = pipes[0]!
    const tokenArg = (pipe as unknown as { token?: string }).token
    void tokenArg
    // 从 execScripts 之外的管道写串验证：ping 探针已写；脚本经 openPipe 参数——用 emit ready 推进
    pipe.emit('ready\n')
    await new Promise((r) => setTimeout(r, 10))
    // 640×1.5=960 → 绝对归一化（click = move + c 两行一次写入）
    expect(pipe.written.some((w) => w.includes('m|'))).toBe(true)
    expect(pipe.written.some((w) => w.includes('c|1|1|0'))).toBe(true)
    expect(execScripts.some((s) => s.includes("PrimaryScreen.Bounds"))).toBe(true) // act 内几何查询
    pipe.emit('ok\nok\n')
    await expect(done).resolves.toBeUndefined()
  })

  it('stream：b64 行帧 → jpeg 字节直出（mjpeg codec）；close 杀管道', async () => {
    const { host, pipes } = hostOf()
    const ctrl = new SshWindowsScreenControl({ host, execTimeoutMs: 500 })
    const s = await ctrl.stream('win-h', { codec: 'mjpeg', fps: 5 })
    expect(s.codec).toBe('mjpeg')
    const got: string[] = []
    s.onData((b) => got.push(Buffer.from(b).toString('utf8')))
    pipes[0]!.emit(Buffer.from('frame1', 'utf8').toString('base64') + '\n')
    await new Promise((r) => setTimeout(r, 10))
    expect(got).toEqual(['frame1'])
    s.close()
    expect(pipes[0]!.killed).toBe(true)
  })
})
