/**
 * Windows PS 协议共享核心（plan-screen-firstclass P9-3a）：宿主屏幕（本机 powershell spawn）
 * 与 Windows 机内（ssh → 远端 powershell）两载体的公共层——传输无关的部分收口在此：
 *
 * - 注入脚本（SendInput P/Invoke + stdin 行循环 + ok 确认 + wlist/rect 回包）——逐字节同一份，
 *   本机走 spawn argv、机内走 -EncodedCommand（UTF-16LE base64 单 token，对 cmd/powershell
 *   默认 shell 双透明，消灭 Windows 引号地狱）；
 * - 动作序列化（ScreenAction → PS 行协议）与键名映射（X keysym → VK）；
 * - 通道机制（ack 确认 / W 清单 / R 矩形回包解析）——只要求一根到 powershell 的 stdin/stdout
 *   管道（PipeProcess/PipeSession 同构面），spawn 归各载体后端。
 *
 * 坐标语义与安全语义见 host-screen.ts 头注（act 截图坐标换算 / inputChannel 真实坐标 /
 * 注入恒过审批闸由 runner actionGate 承担）。
 */
import { KernelError } from '@openbot/core'
import { ScreenErrorCodes } from './index.js'
import type { ScreenAction, ScreenGeometry } from './index.js'

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

/**
 * 人味轨迹帧序列 → PS 行序列（computer_move）：每帧前插 `s|dt`（PS 侧 Thread.Sleep——
 * 节奏免疫 ssh 网络抖动）+ `m|x|y`（user 模式钳制——侧偏中间帧可能贴边出屏，那是生成器
 * 的中间态不是模型坐标错误，钳制兜底；目标 to 本身的越界拒绝在调用侧先行验证）。
 */
export function serializeHostTrackAbs(frames: Array<{ x: number; y: number; dtMs: number }>, span: ScreenGeometry): string[] {
  const lines: string[] = []
  for (const f of frames) {
    lines.push(`s|${Math.max(0, Math.trunc(f.dtMs))}`)
    lines.push(...serializeHostActionAbs({ kind: 'move', x: f.x, y: f.y }, span, 'user'))
  }
  return lines
}

// ---------------------------------------------------------------------------
// PowerShell 注入脚本（常驻 stdin 行循环；Add-Type 首编译由常驻摊薄——传输无关：
// 本机 spawn argv 直传 / 机内 -EncodedCommand 单 token）
// ---------------------------------------------------------------------------

/** C# SendInput P/Invoke + 窗口枚举（P9-2 裁定 E：EnumWindows 全量顶层窗口）+ DPI 感知。
 *  单测锁形状：断言含 SendInput 签名、ready 握手、行协议各分支、EnumWindows。 */
export const HOST_INJECT_CS = [
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
  '    [StructLayout(LayoutKind.Sequential)] struct PT { public int X, Y; }',
  '    [DllImport("user32.dll")] static extern bool GetCursorPos(out PT p);',
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
  '    public static void CursorPos() { PT p; if (!GetCursorPos(out p)) throw new Exception("GetCursorPos failed"); Console.Out.WriteLine("P|" + p.X + "|" + p.Y); }',
  '  }',
  '}',
].join('\n')

/** 注入脚本（导出供单测锁形状）。协议行——请求：ping / m|nx|ny / c|btn|count|interval /
 *  w|delta|count|interval / kd|vk ku|vk kp|vk / kdb|btn kub|btn / t|b64|delayMs /
 *  wlist / rect|b64 / s|ms（帧间节奏——人味轨迹的 PS 侧 sleep，免疫 ssh 网络抖动）/
 *  pos（当前光标位置查询）。应答：ready / ok / err / P|x|y / W|hwnd|x|y|w|h|b64 … W|end /
 *  R|… 或 R|-。每条请求行处理完回一行 ok（err=异常，ack 照减放行、异常文本走 stderr）。 */
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
  "      's' { [System.Threading.Thread]::Sleep([int]$p[1]) }",
  "      'pos' { [W.Inj]::CursorPos() }",
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

/** -EncodedCommand 传输（P9-3a 裁定 B）：UTF-16LE base64 单 token——对 cmd/powershell
 *  默认 shell 双透明，零引号地狱（脚本 ~7KB 字符 → b64 ~19KB，32K 命令行上限内） */
export function psEncodeCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}

/** PS 单引号包裹（'' 转义——argv/路径共用；坑⑫同款：只经普通字符串构造） */
export function psQuote(s: string): string {
  return `'${s.replaceAll("'", "''")}'`
}

// ---------------------------------------------------------------------------
// 通道机制：只要求一根到 powershell 的 stdin/stdout 管道（传输无关——本机 PipeProcess 与
// ssh openPipe 的 PipeSession 同构面）；ack 确认 / W 清单 / R 矩形回包解析收口在此
// ---------------------------------------------------------------------------

/** 管道最小面（PipeProcess/PipeSession 结构化满足；测试注入替身） */
export interface WinPipeFace {
  write(text: string): void
  onData(cb: (chunk: Uint8Array) => void): void
  onExit(cb: (code: number | null) => void): void
  stderrTail(): string
}

/** 注入通道（ ack 确认 + 清单/矩形回包的机制面——spawn 归各载体） */
export interface WinChannel {
  /** 写入动作行，返回待确认条数（PS 每处理一行回 ok——act 据此等待真实完成） */
  write(lines: string[]): number
  /** 等待积压 ack 清零（SendInput 真实执行完；超时/通道退出抛错——act 错误可见） */
  waitForAcks(timeoutMs: number): Promise<void>
  /** 等待 wlist 清单回包（W|end 收齐或超时） */
  readWindowList(timeoutMs: number): Promise<HostWindowInfo[]>
  /** 等待 rect 回包（R|x|y|w|h / R|-；null = 窗口未在场） */
  readRect(timeoutMs: number): Promise<WindowRect | null>
  /** 等待光标位置回包（P|x|y——人味轨迹的 from 事实源；超时/通道退出抛错） */
  readPos(timeoutMs: number): Promise<{ x: number; y: number }>
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

/** 把一根 powershell 管道装配成注入通道（行解析/ack/回包收集全在此——两载体共用）。
 *  onReady：'ready' 行钩子（握手等待归载体层——ssh 单回调面上解析器必须内聚） */
export function attachWinChannel(pipe: WinPipeFace, hooks?: { onReady?: () => void }): WinChannel {
  let pendingAcks = 0
  let ackWake: (() => void) | null = null
  let windowItems: HostWindowInfo[] | null = null
  let windowWake: (() => void) | null = null
  let rectWake: ((r: WindowRect | null) => void) | null = null
  let posWake: ((p: { x: number; y: number }) => void) | null = null
  let buffer = ''
  pipe.onData((chunk) => {
    buffer += new TextDecoder('utf8').decode(chunk)
    let idx = buffer.indexOf('\n')
    while (idx >= 0) {
      const line = buffer.slice(0, idx).trim()
      buffer = buffer.slice(idx + 1)
      if (line === 'ready') {
        hooks?.onReady?.()
      } else if (line === 'pong') {
        // 活性探针回包——无动作
      } else if (line === 'ok') {
        pendingAcks = Math.max(0, pendingAcks - 1)
        if (pendingAcks <= 0) ackWake?.()
      } else if (line === 'err') {
        // 动作行被 PS 拒绝（SendInput 异常）——ack 照减放行 act，异常文本走 stderrTail 诊断面
        pendingAcks = Math.max(0, pendingAcks - 1)
        if (pendingAcks <= 0) ackWake?.()
      } else if (line.startsWith('W|')) {
        if (line === 'W|end') {
          windowWake?.()
        } else {
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
      } else if (line.startsWith('R|')) {
        const seg = line.split('|')
        if (seg[1] === '-') {
          rectWake?.(null)
        } else {
          const [x, y, w, h] = [Number(seg[1]), Number(seg[2]), Number(seg[3]), Number(seg[4])]
          rectWake?.([x, y, w, h].every((n) => Number.isFinite(n)) && w > 0 && h > 0 ? { x, y, width: w, height: h } : null)
        }
        rectWake = null
      } else if (line.startsWith('P|')) {
        const seg = line.split('|')
        const [x, y] = [Number(seg[1]), Number(seg[2])]
        if ([x, y].every((n) => Number.isFinite(n))) posWake?.({ x, y })
        posWake = null
      }
      idx = buffer.indexOf('\n')
    }
  })
  return {
    write: (lines: string[]) => {
      pendingAcks += lines.length
      pipe.write(`${lines.join('\n')}\n`)
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
              `注入未确认（${pendingAcks} 条积压，${timeoutMs}ms 超时）：${pipe.stderrTail().slice(-200)}`,
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
    readPos: (timeoutMs: number) =>
      new Promise<{ x: number; y: number }>((resolve, reject) => {
        const timer = setTimeout(() => {
          posWake = null
          reject(new KernelError(ScreenErrorCodes.SCREEN_ACT_FAILED, `光标位置查询超时（${timeoutMs}ms）`))
        }, timeoutMs)
        posWake = (p) => {
          clearTimeout(timer)
          resolve(p)
        }
      }),
  }
}
