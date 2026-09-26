/**
 * Windows 机内屏幕适配器（plan-screen-firstclass P9-3a）：P9-1 注入协议 over SSH——
 * 同一份 HOST_INJECT_SCRIPT（-EncodedCommand 单 token 传输）经 openPipe 常驻通道注入，
 * 截屏/几何走 exec PS 脚本（System.Drawing CopyFromScreen）。依赖方向不变：本文件只认
 * ScreenControlHost 窄面（exec + openPipe——SshWindowsBoxBackend 结构化满足），零 ssh 细节。
 *
 * 与宿主屏幕（HostScreenControl）的分工：本机 = 本地 spawn + desktopCapturer 桥；
 * 机内 = ssh 通道 + PS 截屏。协议/序列化/键名/通道机制逐字节同一套（win-protocol.ts）。
 *
 * DPI（如实记档）：截屏/几何脚本内联 SetProcessDpiAwarenessContext(-4)——远端 PS 进程
 * 感知真物理像素，与注入归一化坐标系一致；真机缩放显示器的实测归门控套件回填。
 *
 * 实况流（裁定 D）：远端 PS 捕获循环 → 每帧一行 base64（免二进制过 ssh 文本管线的翻损）
 * → 解码直出 mjpeg 会话；LAN 预估 3-10fps，实测归门控套件。
 */
import { KernelError } from '@openbot/core'
import { ScreenErrorCodes } from './index.js'
import type {
  ScreenAction,
  ScreenCapture,
  ScreenCaptureOptions,
  ScreenControl,
  ScreenGeometry,
  ScreenStreamOptions,
  ScreenStreamSession,
} from './index.js'
import type { ScreenControlHost } from './index.js'
import { HOST_INJECT_SCRIPT, attachWinChannel, coalesceMoves, psEncodeCommand, serializeHostActionAbs } from './win-protocol.js'
import type { WinChannel } from './win-protocol.js'

/** 截图契约宽（runner 工具族 capture 缺省档——act 换算的分母，与 X11/宿主屏幕同一契约） */
const CAPTURE_CONTRACT_WIDTH = 1280

/** DPI 感知片段（截屏/几何脚本共用——物理像素与注入归一化同坐标系） */
const PS_DPI_INIT =
  "Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public struct DpiFix { [DllImport(\"user32.dll\")] public static extern bool SetProcessDpiAwarenessContext(System.IntPtr v); }'; [DpiFix]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null; "

/** 几何脚本：主屏物理像素 "W H"（与 parseGeometry 同形状） */
const PS_GEOMETRY_SCRIPT =
  PS_DPI_INIT +
  'Add-Type -AssemblyName System.Windows.Forms; $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds; Write-Output ($b.Width.ToString() + \' \' + $b.Height.ToString())'

/** 单帧截屏脚本：CopyFromScreen → JPEG（ImageFormat 缺省质量）→ base64 单行到 stdout。
 *  maxWidth 缩放：宽超契约时 Graphics.DrawImage 等比缩小（agent 回喂 token 纪律） */
function psCaptureScript(maxWidth: number): string {
  return (
    PS_DPI_INIT +
    'Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; ' +
    '$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds; ' +
    "$bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height); " +
    '$g = [System.Drawing.Graphics]::FromImage($bmp); ' +
    '$g.CopyFromScreen(0, 0, 0, 0, $bmp.Size); ' +
    `if ($b.Width -gt ${maxWidth}) { ` +
    `  $k = ${maxWidth} / $b.Width; ` +
    `  $small = New-Object System.Drawing.Bitmap([int]($b.Width * $k), [int]($b.Height * $k)); ` +
    '  $g2 = [System.Drawing.Graphics]::FromImage($small); ' +
    '  $g2.DrawImage($bmp, 0, 0, $small.Width, $small.Height); ' +
    '  $ms = New-Object System.IO.MemoryStream; ' +
    '  $small.Save($ms, [System.Drawing.Imaging.ImageFormat]::Jpeg); ' +
    '} else { ' +
    '  $ms = New-Object System.IO.MemoryStream; ' +
    '  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Jpeg); ' +
    '} ' +
    '[Console]::Out.WriteLine([Convert]::ToBase64String($ms.ToArray()))'
  )
}

/** 实况捕获循环脚本：每帧一行 base64（newline 定界——ssh 文本管线安全，带宽 +33% 记档） */
function psStreamLoopScript(fps: number): string {
  const tickMs = Math.max(30, Math.round(1000 / Math.min(Math.max(fps, 1), 30)))
  return (
    PS_DPI_INIT +
    'Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; ' +
    '$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds; ' +
    "$bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height); " +
    '$g = [System.Drawing.Graphics]::FromImage($bmp); ' +
    '$out = [Console]::OpenStandardOutput(); ' +
    'while ($true) { ' +
    '  $g.CopyFromScreen(0, 0, 0, 0, $bmp.Size); ' +
    '  $ms = New-Object System.IO.MemoryStream; ' +
    '  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Jpeg); ' +
    "  [Console]::Out.WriteLine([Convert]::ToBase64String($ms.ToArray())); " +
    '  $out.Flush(); ' +
    `  Start-Sleep -Milliseconds ${tickMs}; ` +
    '}'
  )
}

/** 宽松几何解析（"W H" 行——与 X11 parseGeometry 同形状同阈界） */
function parseGeometryLine(stdout: string): ScreenGeometry | null {
  const m = /^(\d+)\s+(\d+)\s*$/.exec(stdout.trim())
  if (m === null) return null
  const width = Number(m[1])
  const height = Number(m[2])
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null
  if (width < 16 || height < 16 || width > 16_384 || height > 16_384) return null
  return { width, height }
}

export interface SshWindowsScreenControlOptions {
  /** 执行通道（SshWindowsBoxBackend 结构化满足——exec/openPipe 窄面；测试注入替身） */
  host: ScreenControlHost
  /** 几何/截屏/ack 超时（缺省 15s——Add-Type 首编译余量） */
  execTimeoutMs?: number
  /** act 等 ok 确认超时（缺省 5s） */
  actAckTimeoutMs?: number
}

export class SshWindowsScreenControl implements ScreenControl {
  readonly #host: ScreenControlHost
  readonly #execTimeoutMs: number
  readonly #actAckTimeoutMs: number
  /** 常驻注入通道（per boxId——随 Box 失效除名重建，孤儿纪律同 X11/宿主屏幕） */
  readonly #channels = new Map<string, WinChannel>()
  readonly #channelExits = new Map<string, () => void>()
  /** 实况会话登记（dispose 兜底停——孤儿纪律） */
  readonly #streams = new Set<{ close(): void }>()
  /** 几何缓存（per boxId——会话内不变；失败不缓存下次重查） */
  readonly #geoCache = new Map<string, ScreenGeometry>()

  constructor(options: SshWindowsScreenControlOptions) {
    this.#host = options.host
    this.#execTimeoutMs = options.execTimeoutMs ?? 15_000
    this.#actAckTimeoutMs = options.actAckTimeoutMs ?? 5_000
  }

  async geometry(boxId: string): Promise<ScreenGeometry | null> {
    const hit = this.#geoCache.get(boxId)
    if (hit !== undefined) return hit
    try {
      const r = await this.#host.exec(boxId, { command: [PS_GEOMETRY_SCRIPT], timeoutMs: this.#execTimeoutMs })
      if (r.exitCode !== 0) return null
      const geo = parseGeometryLine(r.stdout)
      if (geo === null) return null
      this.#geoCache.set(boxId, geo)
      return geo
    } catch {
      return null
    }
  }

  async capture(boxId: string, opts: ScreenCaptureOptions = {}): Promise<ScreenCapture> {
    const maxWidth = opts.maxWidth ?? 1280
    const quality = opts.quality ?? 80
    const geo = await this.geometry(boxId).catch(() => null)
    const r = await this.#host.exec(boxId, {
      command: [psCaptureScript(maxWidth)],
      timeoutMs: this.#execTimeoutMs,
    })
    if (r.exitCode !== 0) {
      throw new KernelError(ScreenErrorCodes.SCREEN_CAPTURE_FAILED, `截屏失败（exit ${r.exitCode}）：${r.stderr.trim()}`)
    }
    const b64 = r.stdout.trim()
    if (b64 === '') {
      throw new KernelError(ScreenErrorCodes.SCREEN_CAPTURE_FAILED, '截屏输出为空（目标桌面会话未登录？）')
    }
    const bytes = new Uint8Array(Buffer.from(b64, 'base64'))
    if (geo === null || geo.width <= maxWidth) {
      return { bytes, mime: 'image/jpeg' }
    }
    return {
      bytes,
      mime: 'image/jpeg',
      width: maxWidth,
      height: Math.round((geo.height * maxWidth) / geo.width),
      screenWidth: geo.width,
      screenHeight: geo.height,
    }
  }

  async act(boxId: string, action: ScreenAction): Promise<void> {
    const channel = await this.#ensureChannel(boxId)
    const geo = await this.geometry(boxId)
    if (geo === null) {
      throw new KernelError(ScreenErrorCodes.SCREEN_ACT_FAILED, '目标屏幕几何不可用（桌面会话未登录？）')
    }
    // 截图坐标 → 真实像素（1280 契约换算；≤1280 比例 1）——与 X11/宿主屏幕同一契约
    const scale = geo.width > CAPTURE_CONTRACT_WIDTH ? geo.width / CAPTURE_CONTRACT_WIDTH : 1
    const scaled: ScreenAction =
      scale === 1
        ? action
        : action.kind === 'move'
          ? { kind: 'move', x: action.x * scale, y: action.y * scale }
          : action.kind === 'click' && action.x !== undefined && action.y !== undefined
            ? { ...action, x: action.x * scale, y: action.y * scale }
            : action
    channel.write(serializeHostActionAbs(scaled, geo, 'agent'))
    await channel.waitForAcks(this.#actAckTimeoutMs) // SendInput 真实完成才返回（错误可见 + 往返可测）
  }

  supportsStream(): boolean {
    return this.#host.openPipe !== undefined
  }

  async stream(boxId: string, opts: ScreenStreamOptions = {}): Promise<ScreenStreamSession> {
    if (!this.#host.openPipe) {
      throw new KernelError('BOX_UNSUPPORTED', '执行通道不支持常驻管道——实况采集不可用')
    }
    const fps = Math.min(Math.max(Math.trunc(opts.fps ?? 10), 1), 30)
    const pipe = await this.#host.openPipe(boxId, {
      command: ['powershell', '-NoProfile', '-NonInteractive', '-EncodedCommand', psEncodeCommand(psStreamLoopScript(fps))],
    })
    let dataCb: ((chunk: Uint8Array) => void) | null = null
    let exitCb: ((code: number | null) => void) | null = null
    let lineBuf = ''
    pipe.onData((chunk) => {
      lineBuf += new TextDecoder('utf8').decode(chunk)
      let idx = lineBuf.indexOf('\n')
      while (idx >= 0) {
        const line = lineBuf.slice(0, idx).trim()
        lineBuf = lineBuf.slice(idx + 1)
        if (line !== '') {
          try {
            dataCb?.(new Uint8Array(Buffer.from(line, 'base64')))
          } catch {
            // 坏帧跳过不拖累流（并行帧解码同哲学）
          }
        }
        idx = lineBuf.indexOf('\n')
      }
    })
    const session: ScreenStreamSession = {
      codec: 'mjpeg', // b64 行帧序列——mjpeg 拆帧/解码管线直用（裁定 D）
      onData: (cb) => {
        dataCb = cb
      },
      onExit: (cb) => {
        exitCb = cb
      },
      stderrTail: () => pipe.stderrTail(),
      close: () => {
        // 杀本地 ssh（连接断开 → 远端循环 stdout 断 → 异常自退）；无 pidfile——与注入通道同记档
        pipe.close()
      },
    }
    pipe.onExit((code) => exitCb?.(code))
    this.#streams.add(session)
    return session
  }

  async inputChannel(boxId: string): Promise<{ write(actions: ScreenAction[]): void; close(): void } | null> {
    try {
      await this.#ensureChannel(boxId)
    } catch {
      return null // 通道建立失败：调用方回退逐动作 act（与既有回退语义一致）
    }
    return {
      write: (actions: ScreenAction[]): void => {
        const channel = this.#channels.get(boxId)
        if (channel === undefined) return
        const merged = coalesceMoves(actions) // 通道侧合帧（P9-2 两级节流的第二级）
        if (merged.length === 0) return
        void this.geometry(boxId).then((geo) => {
          if (geo === null) return
          // 用户路径：真实屏幕坐标原样注入（渲染端 contain 换算）——user 钳制对屏幕 span
          channel.write(merged.flatMap((a) => serializeHostActionAbs(a, geo, 'user')))
        })
      },
      close: (): void => {
        this.#channelExits.get(boxId)?.()
        this.#closeChannel(boxId)
      },
    }
  }

  dispose(): void {
    for (const exit of this.#channelExits.values()) exit()
    for (const boxId of [...this.#channels.keys()]) this.#closeChannel(boxId)
    for (const s of this.#streams) {
      try {
        s.close()
      } catch {
        // dispose 兜底不抛
      }
    }
    this.#streams.clear()
  }

  // ---- 内部：注入通道（openPipe 常驻 PS + attachWinChannel 共享机制） ----

  /** 建通道并等 ready（Add-Type 编译完成）；失败/超时抛错（act 可见、inputChannel 回退 null） */
  async #ensureChannel(boxId: string): Promise<WinChannel> {
    const hit = this.#channels.get(boxId)
    if (hit !== undefined) return hit
    if (!this.#host.openPipe) {
      throw new KernelError(ScreenErrorCodes.SCREEN_ACT_FAILED, '执行通道不支持常驻管道——注入不可用')
    }
    const pipe = await this.#host.openPipe(boxId, {
      command: ['powershell', '-NoProfile', '-NonInteractive', '-EncodedCommand', psEncodeCommand(HOST_INJECT_SCRIPT)],
    })
    const channel = attachWinChannel(
      {
        write: (t) => pipe.write(t),
        onData: (cb) => pipe.onData(cb),
        onExit: (cb) => pipe.onExit(cb),
        stderrTail: () => pipe.stderrTail(),
      },
      { onReady: () => this.#readyResolvers.get(boxId)?.() },
    )
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#closeChannel(boxId)
        reject(
          new KernelError(
            ScreenErrorCodes.SCREEN_ACT_FAILED,
            `注入通道握手超时（${this.#execTimeoutMs}ms）：${pipe.stderrTail().slice(-200)}`,
          ),
        )
      }, this.#execTimeoutMs)
      this.#readyResolvers.set(boxId, () => {
        clearTimeout(timer)
        resolve()
      })
      this.#readyRejecters.set(boxId, (err: unknown) => {
        clearTimeout(timer)
        reject(err)
      })
    })
    pipe.onExit(() => {
      const had = this.#channels.delete(boxId)
      this.#channelExits.delete(boxId)
      if (had) {
        // 通道意外退出——下次 act/inputChannel 重建（X11 除名同哲学）；挂起 ready 显式拒绝
        this.#readyRejecters.get(boxId)?.(
          new KernelError(ScreenErrorCodes.SCREEN_ACT_FAILED, `注入通道退出：${pipe.stderrTail().slice(-200) || '无诊断输出'}`),
        )
        this.#readyResolvers.delete(boxId)
        this.#readyRejecters.delete(boxId)
      }
    })
    this.#channels.set(boxId, channel)
    this.#channelExits.set(boxId, () => pipe.close())
    pipe.write('ping\n') // 活性探针（ready 由脚本启动即回——ping 验证 stdin 循环活着）
    await ready
    return this.#channels.get(boxId)!
  }

  readonly #readyResolvers = new Map<string, () => void>()
  readonly #readyRejecters = new Map<string, (err: unknown) => void>()

  #closeChannel(boxId: string): void {
    this.#channelExits.get(boxId)?.()
    this.#channelExits.delete(boxId)
    this.#channels.delete(boxId)
    this.#readyResolvers.delete(boxId)
    this.#readyRejecters.delete(boxId)
  }
}
