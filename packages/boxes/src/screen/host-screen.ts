/**
 * 宿主屏幕适配器（plan-screen-firstclass P9-1）：把「宿主屏幕本身」作为可看可控的载体——
 * 人类经远程控制窗口看到的一切（云电脑/scrcpy/noVNC…）最终都落在宿主屏幕接收键鼠。
 *
 * 依赖方向（boxes 零 electron 依赖）：截屏与几何由装配方（desktop 主进程）经 HostScreenBridge
 * 注入（desktopCapturer + screen.getPrimaryDisplay 是 Electron API）；本文件只拥有：
 * 注入常驻通道（PowerShell SendInput 行协议——X11 常驻 `sh -s` 同构）、动作序列化（协议中性
 * ScreenAction → PS 行）、键名映射（X keysym → VK）、坐标域校验与归一化、L0/L1 双档实况流
 * （ffmpeg gdigrab 探测升级 / mjpeg 轮询兜底）。
 *
 * 坐标语义（ScreenControl 接口契约不变）：act() 收截图坐标（内部换算）；inputChannel 收真实
 * 屏幕坐标（原样注入）。坐标单位 = 物理像素（DPI 缩放经 scaleFactor 折算，bridge 出口即物理值）。
 * SendInput 用 0-65535 归一化绝对坐标——DPI/主屏语义天然正确。
 *
 * 安全语义（P9-1 裁定 F）：宿主屏幕载体的输入注入**恒过审批闸**——闸门接线在 runner 工具族
 * （actionGate），本适配器不负责审批；坐标域校验（越界拒绝/钳制）是第二道几何兜底。
 */
import { KernelError } from '@openbot/core'
import { spawnPipeProcess, runProcess } from '../procexec/index.js'
import type { PipeProcess, PipeSpawner, ProcRunner } from '../procexec/index.js'
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

/** 宿主屏幕载体的稳定 boxId（一期恒主屏 = 一台屏幕设备；路由与记账的固定键） */
export const HOST_SCREEN_BOX_ID = 'hostscreen-main'

/** 装配方注入桥（Electron 面收口在此——boxes 保持纯 node 可测） */
export interface HostScreenBridge {
  /** 主屏物理像素几何（size × scaleFactor；null = 桌面会话不可用——如实） */
  geometry(): ScreenGeometry | null
  /** 截一帧并缩放编码（desktopCapturer thumbnailSize 直出目标宽——无需二次缩放） */
  captureFrame(opts: { maxWidth: number; quality: number }): Promise<{ bytes: Uint8Array; width: number; height: number }>
}

// ---------------------------------------------------------------------------
// 键名映射：X keysym 惯例名 → Windows VK（常用集；缺名如实报错不猜——风险 6）
// ---------------------------------------------------------------------------

/** 组合键修饰符（先按后放）；键名沿用 runner 校验的 [a-zA-Z0-9_+-]+ 词表 */
const MODIFIER_VK: Record<string, number> = {
  shift: 0x10,
  ctrl: 0x11,
  control: 0x11,
  alt: 0x12,
  meta: 0x5b,
  super: 0x5b,
  win: 0x5b,
}

/** 单键名 → VK（null = 不认识——调用方报错） */
export function keyToVk(name: string): number | null {
  const n = name.toLowerCase()
  if (/^[a-z]$/.test(n)) return 0x41 + (n.charCodeAt(0) - 97)
  if (/^[0-9]$/.test(n)) return 0x30 + (n.charCodeAt(0) - 48)
  const table: Record<string, number> = {
    return: 0x0d,
    enter: 0x0d,
    backspace: 0x08,
    tab: 0x09,
    escape: 0x1b,
    esc: 0x1b,
    space: 0x20,
    delete: 0x2e,
    del: 0x2e,
    insert: 0x2d,
    home: 0x24,
    end: 0x23,
    page_up: 0x21,
    page_down: 0x22,
    prior: 0x21,
    next: 0x22,
    up: 0x26,
    down: 0x28,
    left: 0x25,
    right: 0x27,
    minus: 0xbd,
    equal: 0xbb,
    period: 0xbe,
    comma: 0xbc,
    slash: 0xbf,
    backslash: 0xdc,
    semicolon: 0xba,
    apostrophe: 0xde,
    grave: 0xc0,
    bracketleft: 0xdb,
    bracketright: 0xdd,
    caps_lock: 0x14,
    printscreen: 0x2c,
    scroll_lock: 0x91,
    pause: 0x13,
    menu: 0x5d,
    apps: 0x5d,
    num_lock: 0x90,
  }
  if (table[n] !== undefined) return table[n]
  const fn = /^f([1-9]|1[0-2])$/.exec(n)
  if (fn !== null) return 0x70 + Number(fn[1]) - 1
  return null
}

// ---------------------------------------------------------------------------
// 动作序列化：ScreenAction → PS 行协议（`kind|参数…`——纯函数，单测锁死）
// ---------------------------------------------------------------------------

/** 归一化：像素 → 0-65535（Windows 绝对坐标契约：x*65536/span，钳到界内） */
function normalize(px: number, span: number): number {
  return Math.min(65535, Math.max(0, Math.round((px * 65536) / span)))
}

/**
 * 动作 → PS 行序列。mode=agent：截图坐标（按 1280 截图契约换算）+ 越界拒绝（模型报错要可见）；
 * mode=user：真实屏幕坐标 + 越界钳制（渲染端 contain 换算天然在界内，钳制只兜浮点边角）。
 * click button 4/5 = 滚轮（X 惯例 ±120/格）；type 文本 base64（免转义地狱——坑⑫哲学）。
 * 换算说明：截图坐标×(几何宽/1280) 后再归一化——与 X11 适配器 #scaleOf 同一契约，本函数由
 * 调用方先换算到真实像素再传入（见 act/inputChannel——scale 换算留在 Control 层与 X11 对齐）。
 */
export function serializeHostAction(action: ScreenAction, geo: ScreenGeometry, mode: 'agent' | 'user'): string[] {
  const coordOf = (raw: number, span: number): number => {
    if (mode === 'user') return Math.min(span - 1, Math.max(0, raw))
    if (!Number.isFinite(raw) || raw < 0 || raw > span - 1) {
      throw new KernelError(ScreenErrorCodes.SCREEN_ACT_FAILED, `坐标越界（屏幕 ${geo.width}×${geo.height}，收到 ${raw}）`)
    }
    return raw
  }
  switch (action.kind) {
    case 'move': {
      const x = coordOf(action.x, geo.width)
      const y = coordOf(action.y, geo.height)
      return [`m|${normalize(x, geo.width)}|${normalize(y, geo.height)}`]
    }
    case 'down':
    case 'up': {
      // 独立按下/抬起（拖拽的协议完备面；GUI 常规路径用 click）
      return [`${action.kind === 'down' ? 'kdb' : 'kub'}|${action.button}`]
    }
    case 'click': {
      if (action.button === 4 || action.button === 5) {
        const count = Math.max(1, Math.trunc(action.count ?? 1))
        const interval = Math.max(0, Math.trunc(action.intervalMs ?? 0))
        return [`w|${action.button === 4 ? 120 : -120}|${count}|${interval}`]
      }
      const lines: string[] = []
      if (action.x !== undefined && action.y !== undefined) {
        const x = coordOf(action.x, geo.width)
        const y = coordOf(action.y, geo.height)
        lines.push(`m|${normalize(x, geo.width)}|${normalize(y, geo.height)}`)
      }
      const count = Math.max(1, Math.trunc(action.count ?? 1))
      const interval = Math.max(0, Math.trunc(action.intervalMs ?? 0))
      lines.push(`c|${action.button}|${count}|${interval}`)
      return lines
    }
    case 'key': {
      const parts = action.key
        .split('+')
        .map((s) => s.trim())
        .filter((s) => s !== '')
      if (parts.length === 0) {
        throw new KernelError(ScreenErrorCodes.SCREEN_ACT_FAILED, '空键名')
      }
      const mods: number[] = []
      for (const p of parts.slice(0, -1)) {
        const vk = MODIFIER_VK[p.toLowerCase()]
        if (vk === undefined) throw new KernelError(ScreenErrorCodes.SCREEN_ACT_FAILED, `未知修饰键：${p}`)
        mods.push(vk)
      }
      const last = parts[parts.length - 1] ?? ''
      const lastVk = MODIFIER_VK[last.toLowerCase()] ?? keyToVk(last)
      if (lastVk === null) {
        throw new KernelError(ScreenErrorCodes.SCREEN_ACT_FAILED, `未知键名：${last}（X keysym 常用集之外不猜测）`)
      }
      const lines = mods.map((vk) => `kd|${vk}`)
      lines.push(`kp|${lastVk}`)
      for (const vk of [...mods].reverse()) lines.push(`ku|${vk}`)
      return lines
    }
    case 'type': {
      const delay = Math.max(0, Math.trunc(action.delayMs ?? 0))
      return [`t|${Buffer.from(action.text, 'utf8').toString('base64')}|${delay}`]
    }
  }
}

// ---------------------------------------------------------------------------
// PowerShell 注入脚本（常驻 stdin 行循环；Add-Type 首编译 ~1s 由常驻摊薄）
// ---------------------------------------------------------------------------

/** C# SendInput P/Invoke（INPUT 联合体 + 鼠标/键盘/Unicode 键入助手）。单测锁形状：
 *  断言含 SendInput 签名、ready 握手、行协议各分支 */
const HOST_INJECT_CS = [
  'using System;',
  'using System.Runtime.InteropServices;',
  'using System.Threading;',
  'namespace W {',
  '  public static class Inj {',
  '    [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }',
  '    [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }',
  '    [StructLayout(LayoutKind.Explicit)] struct Union { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }',
  '    [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public Union U; }',
  '    [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);',
  '    const uint F_MOVE = 0x0001, F_ABS = 0x8000, F_WHEEL = 0x0800;',
  '    const uint LD = 0x0002, LU = 0x0004, RD = 0x0008, RU = 0x0010, MD = 0x0020, MU = 0x0040;',
  '    const uint KUP = 0x0002, UNI = 0x0004;',
  '    static uint Btn(uint b, bool down) { return b == 2u ? (down ? (uint)MD : (uint)MU) : b == 3u ? (down ? (uint)RD : (uint)RU) : (down ? (uint)LD : (uint)LU); }',
  '    static void Send(INPUT[] a) { if (SendInput((uint)a.Length, a, Marshal.SizeOf(typeof(INPUT))) == 0u) throw new Exception("SendInput returned 0"); }',
  '    public static void Move(int nx, int ny) { var i = new INPUT[1]; i[0].type = 0; i[0].U.mi.dx = nx; i[0].U.mi.dy = ny; i[0].U.mi.dwFlags = F_MOVE | F_ABS; Send(i); }',
  '    public static void ClickAt(uint b, int count, int interval) { for (int c = 0; c < count; c++) { if (c > 0) Thread.Sleep(interval); var d = new INPUT[1]; d[0].type = 0; d[0].U.mi.dwFlags = Btn(b, true); Send(d); var u = new INPUT[1]; u[0].type = 0; u[0].U.mi.dwFlags = Btn(b, false); Send(u); } }',
  '    public static void ButtonDown(uint b) { var d = new INPUT[1]; d[0].type = 0; d[0].U.mi.dwFlags = Btn(b, true); Send(d); }',
  '    public static void ButtonUp(uint b) { var u = new INPUT[1]; u[0].type = 0; u[0].U.mi.dwFlags = Btn(b, false); Send(u); }',
  '    public static void Wheel(int delta, int count, int interval) { for (int c = 0; c < count; c++) { if (c > 0) Thread.Sleep(interval); var i = new INPUT[1]; i[0].type = 0; i[0].U.mi.mouseData = unchecked((uint)delta); i[0].U.mi.dwFlags = F_WHEEL; Send(i); } }',
  '    public static void KeyDown(ushort vk) { var i = new INPUT[1]; i[0].type = 1; i[0].U.ki.wVk = vk; Send(i); }',
  '    public static void KeyUp(ushort vk) { var i = new INPUT[1]; i[0].type = 1; i[0].U.ki.wVk = vk; i[0].U.ki.dwFlags = KUP; Send(i); }',
  '    public static void Tap(ushort vk) { KeyDown(vk); Thread.Sleep(15); KeyUp(vk); }',
  '    public static void TypeText(string text, int delay) { foreach (char ch in text) { var i = new INPUT[2]; i[0].type = 1; i[0].U.ki.wScan = ch; i[0].U.ki.dwFlags = UNI; i[1].type = 1; i[1].U.ki.wScan = ch; i[1].U.ki.dwFlags = UNI | KUP; Send(i); if (delay > 0) Thread.Sleep(delay); } }',
  '  }',
  '}',
].join('\n')

/** 注入脚本（导出供单测锁形状）。协议行：ping / m|nx|ny / c|btn|count|interval /
 *  w|delta|count|interval / kd|vk ku|vk kp|vk / kdb|btn kub|btn / t|b64|delayMs。
 *  stdout 只回 ready/pong（握手与活性探针）；错误走 stderr（stderrTail 诊断面）。 */
export const HOST_INJECT_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "Add-Type -TypeDefinition @'\n" + HOST_INJECT_CS + "\n'@",
  "[Console]::Out.WriteLine('ready')",
  'while ($true) {',
  '  $line = [Console]::In.ReadLine()',
  '  if ($null -eq $line) { break }',
  "  if ($line -eq '') { continue }",
  '  try {',
  "    $p = $line.Split('|')",
  '    switch ($p[0]) {',
  "      'ping' { [Console]::Out.WriteLine('pong') }",
  "      'm' { [W.Inj]::Move([int]$p[1], [int]$p[2]) }",
  "      'c' { [W.Inj]::ClickAt([uint32]$p[1], [int]$p[2], [int]$p[3]) }",
  "      'w' { [W.Inj]::Wheel([int]$p[1], [int]$p[2], [int]$p[3]) }",
  "      'kp' { [W.Inj]::Tap([uint16]$p[1]) }",
  "      'kd' { [W.Inj]::KeyDown([uint16]$p[1]) }",
  "      'ku' { [W.Inj]::KeyUp([uint16]$p[1]) }",
  "      'kdb' { [W.Inj]::ButtonDown([uint32]$p[1]) }",
  "      'kub' { [W.Inj]::ButtonUp([uint32]$p[1]) }",
  "      't' { [W.Inj]::TypeText([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($p[1])), [int]$p[2]) }",
  '    }',
  "    [Console]::Out.WriteLine('ok')",
  '  } catch { try { [Console]::Error.WriteLine($_.Exception.Message); [Console]::Out.WriteLine(\'err\') } catch {} }',
  '  [Console]::Out.Flush()',
  '}',
].join('\n')

const PWSH_ARGV = [
  'powershell',
  '-NoProfile',
  '-NonInteractive',
  '-ExecutionPolicy',
  'Bypass',
  '-Command',
  HOST_INJECT_SCRIPT,
]

/** L0 轮询档的截帧参数（比 agent 回喂档宽——观感优先；截帧耗时自然节流 ~3-6fps） */
const L0_WIDTH = 1600
const L0_QUALITY = 70
const L0_TICK_MS = 120

/** act 等 PS ok 确认的缺省超时（单动作 SendInput 毫秒级——5s 只在注入通道僵死时触发） */
const ACT_ACK_TIMEOUT_MS = 5_000

/** 截图契约宽（runner 工具族 capture 缺省档——act 换算的分母，与 X11 #scaleOf 同一契约） */
const CAPTURE_CONTRACT_WIDTH = 1280

// ---------------------------------------------------------------------------
// HostScreenControl
// ---------------------------------------------------------------------------

export interface HostScreenControlOptions {
  bridge: HostScreenBridge
  /** 管道进程启动器（缺省 spawnPipeProcess；测试注入替身断言 argv/写串） */
  spawner?: PipeSpawner
  /** 一次性进程（ffmpeg 探测；缺省 runProcess；测试注入替身） */
  runner?: ProcRunner
  /** 注入通道 ready 握手超时（缺省 10s——Add-Type 首编译余量） */
  readyTimeoutMs?: number
  /** act 等 ok 确认超时（缺省 5s；测试注入短超时） */
  actAckTimeoutMs?: number
}

interface HostChannel {
  /** 写入动作行，返回待确认条数（PS 每处理一行回 ok——act 据此等待真实完成） */
  write(lines: string[]): number
  /** 等待积压 ack 清零（SendInput 真实执行完；超时/通道退出抛错——act 错误可见） */
  waitForAcks(timeoutMs: number): Promise<void>
}

export class HostScreenControl implements ScreenControl {
  readonly #bridge: HostScreenBridge
  readonly #spawner: PipeSpawner
  readonly #runner: ProcRunner
  readonly #readyTimeoutMs: number
  readonly #actAckTimeoutMs: number
  /** 常驻注入通道（单进程——一期恒主屏，一台屏幕设备一条通道） */
  #channel: HostChannel | null = null
  #channelProc: PipeProcess | null = null
  #channelReady: Promise<void> | null = null
  #resolveReady: (() => void) | null = null
  #rejectReady: ((err: unknown) => void) | null = null
  /** 实况会话登记（dispose 兜底杀——孤儿纪律） */
  readonly #streams = new Set<{ close(): void }>()
  /** ffmpeg 在场性（懒探测一次，缓存 Promise 防并发重复探测） */
  #ffmpegProbe: Promise<boolean> | null = null

  constructor(options: HostScreenControlOptions) {
    this.#bridge = options.bridge
    this.#spawner = options.spawner ?? spawnPipeProcess
    this.#runner = options.runner ?? runProcess
    this.#readyTimeoutMs = options.readyTimeoutMs ?? 10_000
    this.#actAckTimeoutMs = options.actAckTimeoutMs ?? ACT_ACK_TIMEOUT_MS
  }

  async geometry(_boxId: string): Promise<ScreenGeometry | null> {
    return this.#bridge.geometry()
  }

  async capture(_boxId: string, opts: ScreenCaptureOptions = {}): Promise<ScreenCapture> {
    const maxWidth = opts.maxWidth ?? 1280
    const quality = opts.quality ?? 80
    const geo = this.#bridge.geometry()
    const frame = await this.#bridge.captureFrame({ maxWidth, quality })
    if (geo === null || frame.width >= geo.width) {
      return { bytes: frame.bytes, mime: 'image/jpeg', width: frame.width, height: frame.height }
    }
    return {
      bytes: frame.bytes,
      mime: 'image/jpeg',
      width: frame.width,
      height: frame.height,
      screenWidth: geo.width,
      screenHeight: geo.height,
    }
  }

  async act(_boxId: string, action: ScreenAction): Promise<void> {
    const geo = this.#bridge.geometry()
    if (geo === null) {
      throw new KernelError(ScreenErrorCodes.SCREEN_ACT_FAILED, '宿主屏幕几何不可用（桌面会话未就绪）')
    }
    // 截图坐标 → 真实像素（1280 契约换算——X11 #scaleOf 同构；≤1280 比例 1）
    const scale = geo.width > CAPTURE_CONTRACT_WIDTH ? geo.width / CAPTURE_CONTRACT_WIDTH : 1
    const scaled: ScreenAction =
      scale === 1
        ? action
        : action.kind === 'move'
          ? { kind: 'move', x: action.x * scale, y: action.y * scale }
          : action.kind === 'click' && action.x !== undefined && action.y !== undefined
            ? { ...action, x: action.x * scale, y: action.y * scale }
            : action
    const lines = serializeHostAction(scaled, geo, 'agent')
    const channel = await this.#ensureChannel()
    channel.write(lines)
    await channel.waitForAcks(this.#actAckTimeoutMs) // SendInput 真实完成才返回（错误可见 + 往返可测）
  }

  supportsStream(): boolean {
    return true // L0 轮询兜底恒在场——L1 由 ffmpeg 探测决定
  }

  async stream(_boxId: string, opts: ScreenStreamOptions = {}): Promise<ScreenStreamSession> {
    const fps = Math.min(Math.max(Math.trunc(opts.fps ?? 60), 1), 60)
    const wanted = opts.codec ?? 'h264'
    if (wanted === 'h264' && (await this.#hasFfmpeg())) {
      return this.#ffmpegStream(fps)
    }
    return this.#pollStream()
  }

  async inputChannel(_boxId: string): Promise<{ write(actions: ScreenAction[]): void; close(): void } | null> {
    try {
      await this.#ensureChannel()
    } catch {
      return null // 通道建立失败：调用方回退逐动作 act（与既有回退语义一致）
    }
    return {
      write: (actions: ScreenAction[]): void => {
        const geo = this.#bridge.geometry() // 每次现读（分辨率/缩放可变——不缓存）
        if (geo === null || this.#channel === null) return
        const lines = actions.flatMap((a) => serializeHostAction(a, geo, 'user'))
        this.#channel.write(lines)
      },
      close: (): void => {
        this.#closeChannel()
      },
    }
  }

  dispose(): void {
    this.#closeChannel()
    for (const s of this.#streams) {
      try {
        s.close()
      } catch {
        // dispose 兜底不抛
      }
    }
    this.#streams.clear()
  }

  // ---- 内部：注入通道（单例 + ready 握手 + 退出除名） ----

  /** 建通道并等 ready（Add-Type 编译完成）；失败/超时抛错（act 可见、inputChannel 回退 null） */
  #ensureChannel(): Promise<HostChannel> {
    if (this.#channel === null || this.#channelReady === null) {
      this.#startChannel()
    }
    return (this.#channelReady ?? Promise.reject(new KernelError(ScreenErrorCodes.SCREEN_ACT_FAILED, '注入通道不可用'))).then(
      () => {
        if (this.#channel === null) {
          throw new KernelError(ScreenErrorCodes.SCREEN_ACT_FAILED, '注入通道已退出')
        }
        return this.#channel
      },
    )
  }

  /** 建 PowerShell 常驻进程 + ready 握手（#ensureChannel 的建道半程——首次调用后字段齐备） */
  #startChannel(): void {
    const proc = this.#spawner(PWSH_ARGV)
    this.#channelProc = proc
    let buffer = ''
    let pendingAcks = 0
    let ackWake: (() => void) | null = null
    const channel: HostChannel = {
      write: (lines: string[]) => {
        pendingAcks += lines.length
        proc.write(`${lines.join('\n')}\n`)
        return lines.length
      },
      waitForAcks: (timeoutMs: number) =>
        new Promise<void>((resolve, reject) => {
          if (pendingAcks <= 0) {
            resolve()
            return
          }
          const timer = setTimeout(() => {
            ackWake = null
            reject(
              new KernelError(
                ScreenErrorCodes.SCREEN_ACT_FAILED,
                `注入未确认（${pendingAcks} 条积压，${timeoutMs}ms 超时）：${proc.stderrTail().slice(-200)}`,
              ),
            )
          }, timeoutMs)
          ackWake = () => {
            clearTimeout(timer)
            resolve()
          }
        }),
    }
    proc.onOutput((chunk) => {
      buffer += new TextDecoder('utf8').decode(chunk)
      let idx = buffer.indexOf('\n')
      while (idx >= 0) {
        const line = buffer.slice(0, idx).trim()
        buffer = buffer.slice(idx + 1)
        if (line === 'ready') this.#resolveReady?.()
        else if (line === 'ok') {
          pendingAcks = Math.max(0, pendingAcks - 1)
          if (pendingAcks <= 0) ackWake?.()
        } else if (line === 'err') {
          // 动作行被 PS 拒绝（SendInput 异常）——ack 照减放行 act，异常文本走 stderrTail 诊断面
          pendingAcks = Math.max(0, pendingAcks - 1)
          if (pendingAcks <= 0) ackWake?.()
        }
        idx = buffer.indexOf('\n')
      }
    })
    proc.onExit(() => {
      const wasReady = this.#channelReady !== null && this.#resolveReady === null
      this.#channel = null
      this.#channelProc = null
      this.#channelReady = null
      if (!wasReady) {
        this.#rejectReady?.(
          new KernelError(ScreenErrorCodes.SCREEN_ACT_FAILED, `注入通道退出：${proc.stderrTail().slice(-200) || '无诊断输出'}`),
        )
      }
    })
    this.#channel = channel
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new KernelError(
            ScreenErrorCodes.SCREEN_ACT_FAILED,
            `注入通道握手超时（${this.#readyTimeoutMs}ms）：${proc.stderrTail().slice(-200)}`,
          ),
        )
      }, this.#readyTimeoutMs)
      this.#resolveReady = () => {
        clearTimeout(timer)
        resolve()
      }
      this.#rejectReady = (err: unknown) => {
        clearTimeout(timer)
        reject(err)
      }
    })
    this.#channelReady = ready
    proc.write('ping\n') // 活性探针（ready 由脚本启动即回——ping 验证 stdin 循环活着）
  }

  #closeChannel(): void {
    this.#channelProc?.kill()
    this.#channelProc = null
    this.#channel = null
    this.#channelReady = null
    this.#resolveReady = null
    this.#rejectReady = null
  }

  // ---- 内部：L1 ffmpeg gdigrab 实况（argv 与 X11 h264 引擎同构，采集源换 gdigrab） ----

  #hasFfmpeg(): Promise<boolean> {
    this.#ffmpegProbe ??= this.#runner({ command: ['ffmpeg', '-version'], timeoutMs: 5_000 })
      .then((r) => r.exitCode === 0)
      .catch(() => false)
    return this.#ffmpegProbe
  }

  #ffmpegStream(fps: number): ScreenStreamSession {
    const geo = this.#bridge.geometry() ?? { width: 1920, height: 1080 }
    const argv = [
      'ffmpeg', '-nostdin',
      '-f', 'gdigrab',
      '-draw_mouse', '1',
      '-framerate', String(fps),
      '-offset_x', '0',
      '-offset_y', '0',
      '-video_size', `${geo.width}x${geo.height}`,
      '-i', 'desktop',
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-tune', 'zerolatency',
      '-crf', '18',
      '-g', '30',
      '-pix_fmt', 'yuv420p',
      '-f', 'h264',
      'pipe:1',
    ]
    const proc = this.#spawner(argv)
    const session: ScreenStreamSession = {
      codec: 'h264',
      onData: (cb) => proc.onOutput(cb),
      onExit: (cb) => proc.onExit(cb),
      stderrTail: () => proc.stderrTail(),
      close: () => proc.kill(),
    }
    this.#streams.add(session)
    return session
  }

  // ---- 内部：L0 mjpeg 轮询兜底（desktopCapturer 快照帧序列——拆帧归消费方） ----

  #pollStream(): ScreenStreamSession {
    let dataCb: ((chunk: Uint8Array) => void) | null = null
    let exitCb: ((code: number | null) => void) | null = null
    let tail = ''
    let closed = false
    const tick = async (): Promise<void> => {
      while (!closed) {
        try {
          const frame = await this.#bridge.captureFrame({ maxWidth: L0_WIDTH, quality: L0_QUALITY })
          dataCb?.(frame.bytes)
          tail = ''
        } catch (err) {
          tail = err instanceof Error ? err.message : String(err)
        }
        await new Promise((r) => setTimeout(r, L0_TICK_MS))
      }
    }
    void tick()
    const session: ScreenStreamSession = {
      codec: 'mjpeg',
      onData: (cb) => {
        dataCb = cb
      },
      onExit: (cb) => {
        exitCb = cb
      },
      stderrTail: () => tail,
      close: () => {
        if (closed) return
        closed = true
        exitCb?.(null)
      },
    }
    this.#streams.add(session)
    return session
  }
}
