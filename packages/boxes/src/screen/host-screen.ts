/**
 * 宿主屏幕适配器（plan-screen-firstclass P9-1/P9-2）：把「宿主屏幕本身」作为可看可控的载体——
 * 人类经远程控制窗口看到的一切（云电脑/scrcpy/noVNC…）最终都落在宿主屏幕接收键鼠。
 *
 * 依赖方向（boxes 零 electron 依赖）：截屏与几何由装配方（desktop 主进程）经 HostScreenBridge
 * 注入（desktopCapturer + screen.getPrimaryDisplay 是 Electron API）；本文件只拥有：
 * 注入常驻通道（PowerShell SendInput 行协议——X11 常驻 `sh -s` 同构）、动作序列化（协议中性
 * ScreenAction → PS 行）、键名映射（X keysym → VK）、坐标域校验与归一化、窗口绑定（P9-2
 * EnumWindows/GetWindowRect）、L0/L1/L2 三档实况流（ffmpeg gdigrab / getUserMedia 帧泵 /
 * mjpeg 轮询兜底）。
 *
 * 坐标语义（ScreenControl 接口契约不变）：act() 收截图坐标（内部换算）；inputChannel 收真实
 * 屏幕坐标（原样注入）。坐标单位 = 物理像素（PS 进程经 SetProcessDpiAwarenessContext V2
 * 感知真物理像素，与 desktopCapturer 同一坐标系）。SendInput 用 0-65535 归一化绝对坐标。
 *
 * 窗口绑定（P9-2 裁定 B/E）：条目可绑定目标窗口标题（子串匹配）——几何/截屏/注入域全部
 * 收敛到窗口矩形；窗口未在场**如实拒绝**（不静默回整屏）；窗口重开同名即恢复（rect 每动作
 * 现查 + TTL 缓存）。键盘焦点维持「不自动置前」（裁定 C——目标窗口须手动前台，如实记档）。
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

/** 宿主屏幕载体 boxId 前缀（P9-2 起每条目一 box：`hostscreen-<entryId>`——窗口绑定条目是
 *  不同的桌面面，记账与路由按条目区分；整屏条目同样用此前缀，语义一致） */
export const HOST_SCREEN_BOX_PREFIX = 'hostscreen-'

/** P9-1 时代的整屏 boxId（多条目共享一台屏幕设备）——P9-2 语义修正为每条目一 box，
 *  此常量退役不再生成，仅为外部引用迁移期保留（勿用于新代码） */
export const HOST_SCREEN_BOX_ID = 'hostscreen-main'

export const hostScreenBoxId = (entryId: string): string => `${HOST_SCREEN_BOX_PREFIX}${entryId}`
export const isHostScreenBoxId = (boxId: string): boolean => boxId.startsWith(HOST_SCREEN_BOX_PREFIX)
export const entryIdOfBoxId = (boxId: string): string | null =>
  isHostScreenBoxId(boxId) ? boxId.slice(HOST_SCREEN_BOX_PREFIX.length) : null

/** 装配方注入桥（Electron 面收口在此——boxes 保持纯 node 可测） */
export interface HostScreenFrame {
  bytes: Uint8Array
  width: number
  height: number
}

/** 窗口矩形（物理像素，屏幕绝对坐标） */
export interface WindowRect {
  x: number
  y: number
  width: number
  height: number
}

/** 顶层窗口清单行（wlist 回包；title 为 UTF-8 解码后的窗口标题） */
export interface HostWindowInfo extends WindowRect {
  title: string
}

export interface HostScreenBridge {
  /** 主屏物理像素几何（size × scaleFactor；null = 桌面会话不可用——如实） */
  geometry(): ScreenGeometry | null
  /** 截一帧并缩放编码（desktopCapturer thumbnailSize 直出目标宽；crop = 窗口绑定裁剪，P9-2） */
  captureFrame(opts: { maxWidth: number; quality: number; crop?: WindowRect }): Promise<HostScreenFrame>
  /**
   * L2 零依赖帧泵（P9-2）：隐藏窗口 getUserMedia（Chromium WGC 底层）真 ~30fps 帧到达——
   * 缺席 = 该宿主无 L2 能力（L0 轮询兜底）。stop 后不再回调。
   */
  startFrameStream?(onFrame: (f: HostScreenFrame) => void): Promise<{ stop(): void }>
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
// 动作序列化：ScreenAction → PS 行协议（`kind|参数…`——纯函数，单测锁死）。
// P9-2 窗口模式：坐标先由 Control 层换算到**屏幕绝对像素**（窗口原点偏移 + 缩放），本函数
// 收到的 x/y 已是屏幕绝对值——与整屏模式同一序列化路径（归一化对全屏 span）。
// ---------------------------------------------------------------------------

/** 归一化：像素 → 0-65535（Windows 绝对坐标契约：x*65536/span，钳到界内） */
function normalize(px: number, span: number): number {
  return Math.min(65535, Math.max(0, Math.round((px * 65536) / span)))
}

/**
 * 动作 → PS 行序列（**屏幕绝对坐标**核心版）：坐标校验与归一化都针对同一 span。
 * mode=agent：越界拒绝（模型报错要可见）；mode=user：越界钳制（渲染端 contain 换算天然
 * 在界内，钳制只兜浮点边角）。click button 4/5 = 滚轮（X 惯例 ±120/格）；type 文本 base64
 * （免转义地狱——坑⑫哲学）。整屏与窗口模式（窗口原点偏移后）共用本核心。
 */
export function serializeHostActionAbs(action: ScreenAction, span: ScreenGeometry, mode: 'agent' | 'user'): string[] {
  const coordOf = (raw: number, spanSize: number): number => {
    if (mode === 'user') return Math.min(spanSize - 1, Math.max(0, raw))
    if (!Number.isFinite(raw) || raw < 0 || raw > spanSize - 1) {
      throw new KernelError(ScreenErrorCodes.SCREEN_ACT_FAILED, `坐标越界（区域 ${span.width}×${span.height}，收到 ${raw}）`)
    }
    return raw
  }
  switch (action.kind) {
    case 'move': {
      const x = coordOf(action.x, span.width)
      const y = coordOf(action.y, span.height)
      return [`m|${normalize(x, span.width)}|${normalize(y, span.height)}`]
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
        const x = coordOf(action.x, span.width)
        const y = coordOf(action.y, span.height)
        lines.push(`m|${normalize(x, span.width)}|${normalize(y, span.height)}`)
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

/** 本地坐标版（整屏模式契约 + 既有单测锁定）：域与归一化 span 同一几何 */
export function serializeHostAction(action: ScreenAction, geo: ScreenGeometry, mode: 'agent' | 'user'): string[] {
  return serializeHostActionAbs(action, geo, mode)
}

/** 通道侧 move 合帧（P9-2——renderer 60Hz 合帧的第二级）：批次内连续 move 只留最后一个 */
export function coalesceMoves(actions: ScreenAction[]): ScreenAction[] {
  const out: ScreenAction[] = []
  for (const a of actions) {
    if (a.kind === 'move' && out.length > 0 && out[out.length - 1]!.kind === 'move') {
      out[out.length - 1] = a // 覆盖前一个 move（中间位置无人观测）
    } else {
      out.push(a)
    }
  }
  return out
}

/** 窗口本地坐标域校验（P9-2）：agent 拒 / user 钳（act 截图坐标与 inputChannel 用户坐标共用） */
function localOf(
  x: number,
  y: number,
  rect: WindowRect,
  mode: 'agent' | 'user',
): { x: number; y: number } {
  if (mode === 'agent' && (!Number.isFinite(x) || x < 0 || x > rect.width - 1 || !Number.isFinite(y) || y < 0 || y > rect.height - 1)) {
    throw new KernelError(
      ScreenErrorCodes.SCREEN_ACT_FAILED,
      `坐标越界（窗口 ${rect.width}×${rect.height}，收到 ${x},${y}）`,
    )
  }
  return {
    x: Math.min(rect.width - 1, Math.max(0, x)),
    y: Math.min(rect.height - 1, Math.max(0, y)),
  }
}

// ---------------------------------------------------------------------------
// PowerShell 注入脚本（常驻 stdin 行循环；Add-Type 首编译 ~1s 由常驻摊薄）
// ---------------------------------------------------------------------------

/** C# SendInput P/Invoke + 窗口枚举（P9-2 裁定 E：EnumWindows 全量顶层窗口）+ DPI 感知。
 *  单测锁形状：断言含 SendInput 签名、ready 握手、行协议各分支、EnumWindows。 */
const HOST_INJECT_CS = [
  'using System;',
  'using System.Runtime.InteropServices;',
  'using System.Text;',
  'using System.Threading;',
  'namespace W {',
  '  public static class Inj {',
  '    static Inj() { try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch {} }',
  '    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);',
  '    [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }',
  '    [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }',
  '    [StructLayout(LayoutKind.Explicit)] struct Union { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }',
  '    [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public Union U; }',
  '    [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);',
  '    const uint F_MOVE = 0x0001, F_ABS = 0x8000, F_WHEEL = 0x0800;',
  '    const uint LD = 0x0002, LU = 0x0004, RD = 0x0008, RU = 0x0010, MD = 0x0020, MU = 0x0040;',
  '    const uint KUP = 0x0002, UNI = 0x0004;',
  '    [StructLayout(LayoutKind.Sequential)] struct RECT { public int L, T, R, B; }',
  '    delegate bool EnumProc(IntPtr h, IntPtr l);',
  '    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);',
  '    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);',
  '    [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);',
  '    [DllImport("user32.dll")] static extern int GetWindowText(IntPtr h, StringBuilder sb, int n);',
  '    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);',
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
  '    static string Enc(string s) { return Convert.ToBase64String(Encoding.UTF8.GetBytes(s)); }',
  '    public static void ListWindows() { EnumWindows((h, l) => { if (!IsWindowVisible(h)) return true; int n = GetWindowTextLength(h); if (n <= 0) return true; var sb = new StringBuilder(n + 1); GetWindowText(h, sb, sb.Capacity); RECT r; if (!GetWindowRect(h, out r)) return true; Console.Out.WriteLine("W|" + h.ToString() + "|" + r.L + "|" + r.T + "|" + (r.R - r.L) + "|" + (r.B - r.T) + "|" + Enc(sb.ToString())); return true; }, IntPtr.Zero); Console.Out.WriteLine("W|end"); }',
  '    public static string FindWindowRect(string title) { IntPtr fh = IntPtr.Zero; EnumWindows((h, l) => { if (!IsWindowVisible(h)) return true; int n = GetWindowTextLength(h); if (n <= 0) return true; var sb = new StringBuilder(n + 1); GetWindowText(h, sb, sb.Capacity); if (sb.ToString().IndexOf(title, StringComparison.OrdinalIgnoreCase) >= 0) { fh = h; return false; } return true; }, IntPtr.Zero); if (fh == IntPtr.Zero) return null; RECT r; if (!GetWindowRect(fh, out r)) return null; return r.L + "|" + r.T + "|" + (r.R - r.L) + "|" + (r.B - r.T); }',
  '  }',
  '}',
].join('\n')

/** 注入脚本（导出供单测锁形状）。协议行——请求：ping / m|nx|ny / c|btn|count|interval /
 *  w|delta|count|interval / kd|vk ku|vk kp|vk / kdb|btn kub|btn / t|b64|delayMs /
 *  wlist（P9-2 窗口清单）/ rect|b64（P9-2 窗口矩形）。应答：ready / ok / err /
 *  W|hwnd|x|y|w|h|b64 … W|end / R|x|y|w|h 或 R|-。每条请求行处理完回一行 ok（err=异常，
 *  ack 照减放行、异常文本走 stderr）。stdout 只承载握手/确认/清单回包。 */
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
  "      'wlist' { [W.Inj]::ListWindows() }",
  "      'rect' { $r = [W.Inj]::FindWindowRect([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($p[1]))); if ($null -eq $r) { [Console]::Out.WriteLine('R|-') } else { [Console]::Out.WriteLine('R|' + $r) } }",
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

/** L0 轮询档的截帧参数（比 agent 回喂档宽——观感优先；截帧耗时自然节流） */
const L0_WIDTH = 1600
const L0_QUALITY = 70
const L0_TICK_MS = 120

/** 截图契约宽（runner 工具族 capture 缺省档——act 换算的分母，与 X11 #scaleOf 同一契约） */
const CAPTURE_CONTRACT_WIDTH = 1280

/** 窗口矩形缓存 TTL（窗口拖动中的竞态窗口期——越界钳制兜底） */
const RECT_TTL_MS = 250

interface HostChannel {
  /** 写入动作行，返回待确认条数（PS 每处理一行回 ok——act 据此等待真实完成） */
  write(lines: string[]): number
  /** 等待积压 ack 清零（SendInput 真实执行完；超时/通道退出抛错——act 错误可见） */
  waitForAcks(timeoutMs: number): Promise<void>
  /** 等待 wlist 清单回包（W|end 收齐或超时） */
  readWindowList(timeoutMs: number): Promise<HostWindowInfo[]>
  /** 等待 rect 回包（R|x|y|w|h / R|-；null = 窗口未在场） */
  readRect(timeoutMs: number): Promise<WindowRect | null>
}

export interface HostScreenControlOptions {
  bridge: HostScreenBridge
  /** 窗口绑定（P9-2）：条目窗口标题子串匹配——设置后几何/截屏/注入域全部收敛到窗口矩形 */
  windowTitle?: string
  /** 管道进程启动器（缺省 spawnPipeProcess；测试注入替身断言 argv/写串） */
  spawner?: PipeSpawner
  /** 一次性进程（ffmpeg 探测；缺省 runProcess；测试注入替身） */
  runner?: ProcRunner
  /** 注入通道 ready 握手超时（缺省 10s——Add-Type 首编译余量） */
  readyTimeoutMs?: number
  /** act 等 ok 确认超时（缺省 5s；测试注入短超时） */
  actAckTimeoutMs?: number
}

export class HostScreenControl implements ScreenControl {
  readonly #bridge: HostScreenBridge
  readonly #windowTitle: string | null
  readonly #spawner: PipeSpawner
  readonly #runner: ProcRunner
  readonly #readyTimeoutMs: number
  readonly #actAckTimeoutMs: number
  /** 常驻注入通道（单进程——一实例一桌面面：整屏或绑定窗口） */
  #channel: HostChannel | null = null
  #channelProc: PipeProcess | null = null
  #channelReady: Promise<void> | null = null
  #resolveReady: (() => void) | null = null
  #rejectReady: ((err: unknown) => void) | null = null
  /** 实况会话登记（dispose 兜底杀——孤儿纪律） */
  readonly #streams = new Set<{ close(): void }>()
  /** ffmpeg 在场性（懒探测一次，缓存 Promise 防并发重复探测） */
  #ffmpegProbe: Promise<boolean> | null = null
  /** 窗口矩形缓存（TTL——拖动竞态窗口期；null 缓存同样 TTL——窗口关闭后不查风暴） */
  #rectCache: { rect: WindowRect | null; at: number } | null = null
  readonly #now: () => number

  constructor(options: HostScreenControlOptions) {
    this.#bridge = options.bridge
    this.#windowTitle = options.windowTitle?.trim() ? options.windowTitle.trim() : null
    this.#spawner = options.spawner ?? spawnPipeProcess
    this.#runner = options.runner ?? runProcess
    this.#readyTimeoutMs = options.readyTimeoutMs ?? 10_000
    this.#actAckTimeoutMs = options.actAckTimeoutMs ?? 5_000
    this.#now = () => Date.now()
  }

  // ---- 窗口模式支撑（P9-2） ----

  /** 绑定窗口矩形（窗口模式）；整屏模式恒 null。TTL 缓存 + 窗口未在场缓存 null（防查风暴） */
  async #windowRect(): Promise<WindowRect | null> {
    if (this.#windowTitle === null) return null
    const hit = this.#rectCache
    if (hit !== null && this.#now() - hit.at < RECT_TTL_MS) return hit.rect
    const channel = await this.#ensureChannel()
    channel.write([this.#rectQueryLine()])
    const rect = await channel.readRect(this.#actAckTimeoutMs)
    this.#rectCache = { rect, at: this.#now() }
    return rect
  }

  /** rect 请求行（标题 base64——免转义） */
  #rectQueryLine(): string {
    return `rect|${Buffer.from(this.#windowTitle ?? '', 'utf8').toString('base64')}`
  }

  /** 窗口未在场（绑定模式下）——如实拒绝的统一话术 */
  #windowGone(): never {
    throw new KernelError(
      ScreenErrorCodes.SCREEN_ACT_FAILED,
      `绑定窗口未在场（标题含「${this.#windowTitle}」）——重开窗口后自动恢复，或到设置页改绑/清空`,
    )
  }

  /** 顶层窗口清单（设置页枚举下拉——与条目绑定无关，枚举全屏范围） */
  async listWindows(): Promise<HostWindowInfo[]> {
    const channel = await this.#ensureChannel()
    channel.write(['wlist'])
    return channel.readWindowList(this.#actAckTimeoutMs)
  }

  /** 实况档位（v1.images.test 三档如实报告——不真开流） */
  async streamTier(): Promise<'l1' | 'l2' | 'l0'> {
    if (await this.#hasFfmpeg()) return 'l1'
    return this.#bridge.startFrameStream ? 'l2' : 'l0'
  }

  async geometry(_boxId: string): Promise<ScreenGeometry | null> {
    if (this.#windowTitle !== null) {
      const rect = await this.#windowRect()
      if (rect === null) return null // 窗口未在场——geometry 如实 null（capture/act 各自给出可见错误）
      return { width: rect.width, height: rect.height }
    }
    return this.#bridge.geometry()
  }

  async capture(_boxId: string, opts: ScreenCaptureOptions = {}): Promise<ScreenCapture> {
    const maxWidth = opts.maxWidth ?? 1280
    const quality = opts.quality ?? 80
    if (this.#windowTitle !== null) {
      const rect = await this.#windowRect()
      if (rect === null) {
        throw new KernelError(ScreenErrorCodes.SCREEN_CAPTURE_FAILED, `绑定窗口未在场（标题含「${this.#windowTitle}」）`)
      }
      const frame = await this.#bridge.captureFrame({ maxWidth, quality, crop: rect })
      return {
        bytes: frame.bytes,
        mime: 'image/jpeg',
        width: frame.width,
        height: frame.height,
        screenWidth: rect.width,
        screenHeight: rect.height,
      }
    }
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
    // 整屏模式先查几何（不可用即拒绝——不白起 PS 进程）；窗口模式需通道查 rect
    if (this.#windowTitle === null && this.#bridge.geometry() === null) {
      throw new KernelError(ScreenErrorCodes.SCREEN_ACT_FAILED, '宿主屏幕几何不可用（桌面会话未就绪）')
    }
    const channel = await this.#ensureChannel()
    if (this.#windowTitle !== null) {
      channel.write([this.#rectQueryLine()]) // 每动作现查（不用 TTL 缓存——注入不容陈旧）
      const rect = await channel.readRect(this.#actAckTimeoutMs)
      this.#rectCache = { rect, at: this.#now() }
      if (rect === null) this.#windowGone()
      const screen = this.#bridge.geometry()
      if (screen === null) {
        throw new KernelError(ScreenErrorCodes.SCREEN_ACT_FAILED, '宿主屏幕几何不可用（桌面会话未就绪）')
      }
      // 截图坐标（1280 契约、窗口本地）→ 本地域校验（agent 拒/user 钳）→ 窗口本地真实像素
      // → 屏幕绝对像素（窗口原点偏移）
      const scale = rect.width > CAPTURE_CONTRACT_WIDTH ? rect.width / CAPTURE_CONTRACT_WIDTH : 1
      const toAbsolute = (a: ScreenAction): ScreenAction => {
        if (a.kind === 'move') {
          const { x, y } = localOf(a.x, a.y, rect, 'agent')
          return { kind: 'move', x: rect.x + x * scale, y: rect.y + y * scale }
        }
        if (a.kind === 'click' && a.x !== undefined && a.y !== undefined) {
          const { x, y } = localOf(a.x, a.y, rect, 'agent')
          return { ...a, x: rect.x + x * scale, y: rect.y + y * scale }
        }
        return a
      }
      channel.write(serializeHostActionAbs(toAbsolute(action), screen, 'agent'))
      await channel.waitForAcks(this.#actAckTimeoutMs) // SendInput 真实完成才返回（错误可见 + 往返可测）
      return
    }
    const geo = this.#bridge.geometry()
    if (geo === null) {
      throw new KernelError(ScreenErrorCodes.SCREEN_ACT_FAILED, '宿主屏幕几何不可用（桌面会话未就绪）')
    }
    // 整屏模式：截图坐标 → 真实像素（1280 契约换算；≤1280 比例 1）
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
    return true // L0 轮询兜底恒在场——L1/L2 由 ffmpeg 探测与帧泵能力决定
  }

  async stream(_boxId: string, opts: ScreenStreamOptions = {}): Promise<ScreenStreamSession> {
    const fps = Math.min(Math.max(Math.trunc(opts.fps ?? 60), 1), 60)
    const wanted = opts.codec ?? 'h264'
    if (wanted === 'h264' && (await this.#hasFfmpeg())) {
      return this.#ffmpegStream(fps)
    }
    if (this.#bridge.startFrameStream) {
      return this.#pumpStream()
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
        const channel = this.#channel
        if (channel === null) return
        // 通道侧 move 合帧（P9-2——renderer 60Hz 合帧的第二级）：积压批次只留最新位置
        const merged = coalesceMoves(actions)
        if (merged.length === 0) return
        if (this.#windowTitle !== null) {
          // 用户路径：窗口本地真实像素（渲染端按窗口流尺寸 contain 换算）→ 本地钳制 → 屏幕绝对
          void this.#windowRect().then((rect) => {
            if (rect === null || this.#channel === null) return
            const screen = this.#bridge.geometry()
            if (screen === null) return
            const lines: string[] = []
            for (const a of merged) {
              if (a.kind === 'move') {
                const { x, y } = localOf(a.x, a.y, rect, 'user')
                lines.push(...serializeHostActionAbs({ kind: 'move', x: rect.x + x, y: rect.y + y }, screen, 'user'))
              } else if (a.kind === 'click' && a.x !== undefined && a.y !== undefined) {
                const { x, y } = localOf(a.x, a.y, rect, 'user')
                lines.push(...serializeHostActionAbs({ ...a, x: rect.x + x, y: rect.y + y }, screen, 'user'))
              } else {
                lines.push(...serializeHostActionAbs(a, screen, 'user'))
              }
            }
            channel.write(lines)
          })
          return
        }
        const geo = this.#bridge.geometry() // 每次现读（分辨率/缩放可变——不缓存）
        if (geo === null) return
        channel.write(merged.flatMap((a) => serializeHostActionAbs(a, geo, 'user')))
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

  // ---- 内部：序列化（整屏/窗口两模式统一——userRect=null 整屏） ----

  // ---- 内部：注入通道（单例 + ready 握手 + 回包解析 + 退出除名） ----

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
    let windowItems: HostWindowInfo[] | null = null
    let windowWake: (() => void) | null = null
    let rectWake: ((r: WindowRect | null) => void) | null = null
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
      readWindowList: (timeoutMs: number) =>
        new Promise<HostWindowInfo[]>((resolve, reject) => {
          windowItems = []
          const timer = setTimeout(() => {
            windowWake = null
            const got = windowItems
            windowItems = null
            reject(new KernelError(ScreenErrorCodes.SCREEN_ACT_FAILED, `窗口枚举超时（${timeoutMs}ms，已收 ${got?.length ?? 0} 行）`))
          }, timeoutMs)
          windowWake = () => {
            clearTimeout(timer)
            const got = windowItems ?? []
            windowItems = null
            resolve(got)
          }
        }),
      readRect: (timeoutMs: number) =>
        new Promise<WindowRect | null>((resolve, reject) => {
          const timer = setTimeout(() => {
            rectWake = null
            reject(new KernelError(ScreenErrorCodes.SCREEN_ACT_FAILED, `窗口矩形查询超时（${timeoutMs}ms）`))
          }, timeoutMs)
          rectWake = (r) => {
            clearTimeout(timer)
            resolve(r)
          }
        }),
    }
    const pushWindowLine = (line: string): void => {
      if (line === 'W|end') {
        windowWake?.()
        return
      }
      const seg = line.split('|')
      // W|hwnd|x|y|w|h|b64
      if (seg.length >= 7 && windowItems !== null) {
        const [x, y, w, h] = [Number(seg[2]), Number(seg[3]), Number(seg[4]), Number(seg[5])]
        if ([x, y, w, h].every((n) => Number.isFinite(n)) && w > 0 && h > 0) {
          try {
            windowItems.push({
              x,
              y,
              width: w,
              height: h,
              title: Buffer.from(seg[6] ?? '', 'base64').toString('utf8'),
            })
          } catch {
            // 坏行跳过不拖累清单（parseOciStats 同哲学）
          }
        }
      }
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
        } else if (line.startsWith('W|')) {
          pushWindowLine(line)
        } else if (line.startsWith('R|')) {
          const seg = line.split('|')
          if (seg[1] === '-') {
            rectWake?.(null)
          } else {
            const [x, y, w, h] = [Number(seg[1]), Number(seg[2]), Number(seg[3]), Number(seg[4])]
            rectWake?.([x, y, w, h].every((n) => Number.isFinite(n)) && w > 0 && h > 0 ? { x, y, width: w, height: h } : null)
          }
          rectWake = null
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

  // ---- 内部：L2 零依赖帧泵（P9-2——隐藏窗口 getUserMedia，桥实现收口 Electron 面） ----

  #pumpStream(): ScreenStreamSession {
    let dataCb: ((chunk: Uint8Array) => void) | null = null
    let exitCb: ((code: number | null) => void) | null = null
    let tail = ''
    let handle: { stop(): void } | null = null
    let closed = false
    const pending: Uint8Array[] = [] // 首帧早于 onData 挂接的缓冲（30fps 泵不等人）
    const session: ScreenStreamSession = {
      codec: 'mjpeg', // 帧序列走 mjpeg 拆帧/解码管线（裁定 D——零新 wire codec）
      onData: (cb) => {
        dataCb = cb
        while (pending.length > 0) dataCb(pending.shift()!)
      },
      onExit: (cb) => {
        exitCb = cb
      },
      stderrTail: () => tail,
      close: () => {
        if (closed) return
        closed = true
        handle?.stop()
        exitCb?.(null)
      },
    }
    void this.#bridge
      .startFrameStream!((f) => {
        if (closed) return
        if (dataCb !== null) dataCb(f.bytes)
        else pending.push(f.bytes)
      })
      .then((h) => {
        if (closed) {
          h.stop()
          return
        }
        handle = h
      })
      .catch((err: unknown) => {
        // 帧泵起不来（无桌面源/权限拒绝）——如实降级 L0 轮询（同会话内自愈）
        tail = err instanceof Error ? err.message : String(err)
        if (!closed) {
          const fallback = this.#pollStream()
          fallback.onData((b) => dataCb?.(b))
          this.#streams.delete(fallback)
        }
      })
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
