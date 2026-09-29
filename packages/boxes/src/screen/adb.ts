/**
 * Android 屏幕适配器（plan-screen-firstclass P9-3b）：设备内建工具三件套——
 * `wm size` 几何 / `screencap` 截图 / `input` 注入 / `screenrecord` h264 实况。
 * 依赖方向不变：只认 ScreenControlHost 窄面（exec + openPipe——AdbBoxBackend 结构化满足）。
 *
 * 坐标语义：screencap 原生分辨率 1:1（无缩放——设备端无图像工具，PNG 直出），
 * 模型坐标即注入坐标（capture 与 act 同一坐标系，零换算）。
 *
 * 词表映射（裁定 A/C/D）：
 * - type：`input text` 仅 ASCII（Android 不支持 unicode 直注——中文如实报错，记档）；
 * - 组合键：`input keycombination`（Android 12+；仅单修饰键——多修饰如实报错）；
 * - 滚轮：单指 swipe 屏幕中心近似（设备无滚轮概念，记档）；
 * - move/down/up：触屏无 hover/半程概念——不渲染（返回空行集）。
 *
 * 实况（裁定 B）：`screenrecord --output-format=h264raw` 直出 Annex B 裸流 → 既有
 * WebCodecs 解码管线零改动；180s 录制上限以 while 循环重启（重启 ~0.5s 缺口记档）。
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

export interface AdbScreenControlOptions {
  /** 执行通道（AdbBoxBackend 结构化满足；测试注入替身） */
  host: ScreenControlHost
  /** exec 超时（缺省 15s——screencap 高分屏有体量） */
  execTimeoutMs?: number
}

/** X keysym 惯例名 → Android KEYCODE 符号名（`input keyevent` 接受符号名——数值随版本漂移） */
const KEYCODE_NAMES: Record<string, string> = {
  return: 'KEYCODE_ENTER',
  enter: 'KEYCODE_ENTER',
  backspace: 'KEYCODE_DEL',
  tab: 'KEYCODE_TAB',
  escape: 'KEYCODE_ESCAPE',
  esc: 'KEYCODE_ESCAPE',
  space: 'KEYCODE_SPACE',
  delete: 'KEYCODE_FORWARD_DEL',
  del: 'KEYCODE_FORWARD_DEL',
  insert: 'KEYCODE_INSERT',
  home: 'KEYCODE_MOVE_HOME',
  end: 'KEYCODE_MOVE_END',
  page_up: 'KEYCODE_PAGE_UP',
  page_down: 'KEYCODE_PAGE_DOWN',
  prior: 'KEYCODE_PAGE_UP',
  next: 'KEYCODE_PAGE_DOWN',
  up: 'KEYCODE_DPAD_UP',
  down: 'KEYCODE_DPAD_DOWN',
  left: 'KEYCODE_DPAD_LEFT',
  right: 'KEYCODE_DPAD_RIGHT',
  minus: 'KEYCODE_MINUS',
  equal: 'KEYCODE_EQUALS',
  period: 'KEYCODE_PERIOD',
  comma: 'KEYCODE_COMMA',
  slash: 'KEYCODE_SLASH',
  backslash: 'KEYCODE_BACKSLASH',
  semicolon: 'KEYCODE_SEMICOLON',
  apostrophe: 'KEYCODE_APOSTROPHE',
  grave: 'KEYCODE_GRAVE',
  bracketleft: 'KEYCODE_LEFT_BRACKET',
  bracketright: 'KEYCODE_RIGHT_BRACKET',
  at: 'KEYCODE_AT',
  plus: 'KEYCODE_PLUS',
  caps_lock: 'KEYCODE_CAPS_LOCK',
  num_lock: 'KEYCODE_NUM_LOCK',
  scroll_lock: 'KEYCODE_SCROLL_LOCK',
}

/** 修饰键 → KEYCODE 数值（keycombination 需数值型 keycode；ctrl=113/shift=59/alt=57/meta=117） */
const MODIFIER_KEYCODE: Record<string, number> = {
  ctrl: 113,
  control: 113,
  shift: 59,
  alt: 57,
  meta: 117,
  super: 117,
  win: 117,
}

/** 单键名 → KEYCODE 符号名（字母/数字/功能键按区间合成） */
export function adbKeycodeOf(name: string): string | null {
  const n = name.toLowerCase()
  if (KEYCODE_NAMES[n] !== undefined) return KEYCODE_NAMES[n]
  if (/^[a-z]$/.test(n)) return `KEYCODE_${n.toUpperCase()}`
  if (/^[0-9]$/.test(n)) return `KEYCODE_${n.toUpperCase()}`
  const fn = /^f([1-9]|1[0-2])$/.exec(n)
  if (fn !== null) return `KEYCODE_F${fn[1]}`
  return null
}

/** `wm size` 输出解析：Override size 优先（用户改过分辨率），缺省 Physical size */
export function parseWmSize(stdout: string): ScreenGeometry | null {
  const override = /Override size:\s*(\d+)x(\d+)/.exec(stdout)
  const physical = /Physical size:\s*(\d+)x(\d+)/.exec(stdout)
  const m = override ?? physical
  if (m === null) return null
  const width = Number(m[1])
  const height = Number(m[2])
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 16 || height < 16 || width > 16_384 || height > 16_384) {
    return null
  }
  return { width, height }
}

/**
 * 动作 → `input` 命令行集（`; ` 连接后单次 shell 往返执行——批动作零多次往返）。
 * mode=agent：坐标越界拒绝（模型报错可见）；mode=user：越界钳制。type 仅 ASCII（裁定 A）。
 */
export function serializeAdbActions(actions: ScreenAction[], geo: ScreenGeometry, mode: 'agent' | 'user'): string[] {
  const lines: string[] = []
  const coordOf = (raw: number, spanSize: number, axis: string): number => {
    if (mode === 'user') return Math.min(spanSize - 1, Math.max(0, Math.round(raw)))
    if (!Number.isFinite(raw) || raw < 0 || raw > spanSize - 1) {
      throw new KernelError(ScreenErrorCodes.SCREEN_ACT_FAILED, `坐标越界（屏幕 ${geo.width}×${geo.height}，${axis}=${raw}）`)
    }
    return Math.round(raw)
  }
  for (const action of actions) {
    switch (action.kind) {
      case 'move':
      case 'down':
      case 'up': {
        // 触屏无 hover/半程概念——不渲染（计算机工具族常规路径不产生这三类独立动作）
        break
      }
      case 'click': {
        if (action.button === 4 || action.button === 5) {
          // 滚轮近似（裁定 D）：单指 swipe 屏幕中心纵向滑——上滚=指向下拖（内容上移）
          const cx = Math.round(geo.width / 2)
          const cy = Math.round(geo.height / 2)
          const dy = 240
          const count = Math.max(1, Math.trunc(action.count ?? 1))
          for (let i = 0; i < count; i++) {
            lines.push(
              action.button === 4
                ? `input swipe ${cx} ${cy + dy} ${cx} ${cy} 150`
                : `input swipe ${cx} ${cy} ${cx} ${cy + dy} 150`,
            )
          }
          break
        }
        const x = coordOf(action.x ?? 0, geo.width, 'x')
        const y = coordOf(action.y ?? 0, geo.height, 'y')
        const count = Math.max(1, Math.trunc(action.count ?? 1))
        for (let i = 0; i < count; i++) lines.push(`input tap ${x} ${y}`)
        break
      }
      case 'key': {
        const parts = action.key
          .split('+')
          .map((s) => s.trim())
          .filter((s) => s !== '')
        if (parts.length === 0) {
          throw new KernelError(ScreenErrorCodes.SCREEN_ACT_FAILED, '空键名')
        }
        const mods = parts.slice(0, -1).map((p) => p.toLowerCase())
        const last = parts[parts.length - 1] ?? ''
        const lastCode = adbKeycodeOf(last)
        if (lastCode === null) {
          throw new KernelError(ScreenErrorCodes.SCREEN_ACT_FAILED, `未知键名：${last}（X keysym 常用集之外不猜测）`)
        }
        if (mods.length === 0) {
          lines.push(`input keyevent ${lastCode}`)
        } else {
          // keycombination 仅接受两个 keycode（Android 12+）——多修饰键如实拒绝
          if (mods.length > 1) {
            throw new KernelError(ScreenErrorCodes.SCREEN_ACT_FAILED, `多修饰键组合不受支持（Android input 限制）：${action.key}`)
          }
          const modVk = MODIFIER_KEYCODE[mods[0]!]
          if (modVk === undefined) {
            throw new KernelError(ScreenErrorCodes.SCREEN_ACT_FAILED, `未知修饰键：${parts[0]}`)
          }
          const lastNum = adbKeycodeNumber(lastCode)
          if (lastNum === null) {
            throw new KernelError(ScreenErrorCodes.SCREEN_ACT_FAILED, `组合键键名不支持：${last}（keycombination 需数值 keycode）`)
          }
          lines.push(`input keycombination ${modVk} ${lastNum}`)
        }
        break
      }
      case 'type': {
        if (/[^\x20-\x7E]/.test(action.text)) {
          throw new KernelError(
            ScreenErrorCodes.SCREEN_ACT_FAILED,
            'Android 键入仅支持 ASCII（input text 不支持 unicode——中文请经剪贴板方案，随后续轮次）',
          )
        }
        // input text 词法：空格 → %s；双引号包裹 + 转义设备端 sh 特殊字符
        const escaped = action.text
          .replaceAll(' ', '%s')
          .replaceAll('\\', '\\\\')
          .replaceAll('"', '\\"')
          .replaceAll('$', '\\$')
          .replaceAll('`', '\\`')
        lines.push(`input text "${escaped}"`)
        break
      }
    }
  }
  return lines
}

/** KEYCODE 符号名 → 数值（keycombination 契约；字母/数字/功能键按 Android 键位表区间） */
function adbKeycodeNumber(symbol: string): number | null {
  const m = /^KEYCODE_([A-Z0-9]|F[1-9]|F1[0-2])$/.exec(symbol)
  if (m === null || m[1] === undefined) return null
  const name = m[1]
  if (/^[A-Z]$/.test(name)) return 29 + (name.charCodeAt(0) - 65) // KEYCODE_A=29
  if (/^[0-9]$/.test(name)) return 7 + Number(name) // KEYCODE_0=7
  const fn = /^F([1-9]|1[0-2])$/.exec(name)
  if (fn !== null) return 131 + Number(fn[1]) - 1 // KEYCODE_F1=131
  return null
}

export class AdbScreenControl implements ScreenControl {
  readonly #host: ScreenControlHost
  readonly #execTimeoutMs: number
  /** 常驻注入通道（per boxId——adb shell stdin 行写，用户路径低延迟；无 ack——触屏注入无回执语义） */
  readonly #channels = new Map<string, { write(lines: string[]): void; close(): void }>()
  readonly #channelExits = new Map<string, () => void>()
  readonly #streams = new Set<{ close(): void }>()
  readonly #geoCache = new Map<string, ScreenGeometry>()

  constructor(options: AdbScreenControlOptions) {
    this.#host = options.host
    this.#execTimeoutMs = options.execTimeoutMs ?? 15_000
  }

  async geometry(boxId: string): Promise<ScreenGeometry | null> {
    const hit = this.#geoCache.get(boxId)
    if (hit !== undefined) return hit
    try {
      const r = await this.#host.exec(boxId, { command: ['wm', 'size'], timeoutMs: this.#execTimeoutMs })
      if (r.exitCode !== 0) return null
      const geo = parseWmSize(r.stdout)
      if (geo === null) return null
      this.#geoCache.set(boxId, geo)
      return geo
    } catch {
      return null
    }
  }

  async capture(boxId: string, _opts: ScreenCaptureOptions = {}): Promise<ScreenCapture> {
    const geo = await this.geometry(boxId).catch(() => null)
    // screencap → base64（设备端 toybox base64 换行包裹——消费方剥空白）
    const r = await this.#host.exec(boxId, {
      command: ['sh', '-c', 'screencap -p | base64'],
      timeoutMs: this.#execTimeoutMs,
    })
    if (r.exitCode !== 0) {
      throw new KernelError(ScreenErrorCodes.SCREEN_CAPTURE_FAILED, `截屏失败（exit ${r.exitCode}）：${r.stderr.trim()}`)
    }
    const b64 = r.stdout.replace(/\s+/g, '')
    if (b64 === '') {
      throw new KernelError(ScreenErrorCodes.SCREEN_CAPTURE_FAILED, '截屏输出为空（设备屏幕未点亮？）')
    }
    const bytes = new Uint8Array(Buffer.from(b64, 'base64'))
    if (bytes[0] !== 0x89 || bytes[1] !== 0x50) {
      throw new KernelError(ScreenErrorCodes.SCREEN_CAPTURE_FAILED, '截屏输出非 PNG（设备端管道翻损？）')
    }
    // 原生分辨率 1:1——width/height 缺省 = 未缩放（模型坐标即注入坐标）
    return geo === null ? { bytes, mime: 'image/png' } : { bytes, mime: 'image/png', screenWidth: geo.width, screenHeight: geo.height }
  }

  async act(boxId: string, action: ScreenAction): Promise<void> {
    const geo = await this.geometry(boxId)
    if (geo === null) {
      throw new KernelError(ScreenErrorCodes.SCREEN_ACT_FAILED, '设备屏幕几何不可得（wm size 失败——设备未在场？）')
    }
    const lines = serializeAdbActions([action], geo, 'agent')
    if (lines.length === 0) return // move 等触屏无语义动作——零操作（不算错误）
    const r = await this.#host.exec(boxId, {
      command: ['sh', '-c', lines.join('; ')],
      timeoutMs: this.#execTimeoutMs,
    })
    if (r.exitCode !== 0) {
      throw new KernelError(ScreenErrorCodes.SCREEN_ACT_FAILED, `注入失败（exit ${r.exitCode}）：${r.stderr.trim()}`)
    }
  }

  supportsStream(): boolean {
    return this.#host.openPipe !== undefined
  }

  async stream(boxId: string, opts: ScreenStreamOptions = {}): Promise<ScreenStreamSession> {
    if (!this.#host.openPipe) {
      throw new KernelError('BOX_UNSUPPORTED', '执行通道不支持常驻管道——实况采集不可用')
    }
    void opts // 帧率由 screenrecord 自适应（设备编码器决定——opts.fps 仅文档语义）
    const geo = (await this.geometry(boxId).catch(() => null)) ?? { width: 1080, height: 2400 }
    // 等比缩到宽 720（偶数——h264 契约）；竖屏高换算
    const w = 720
    const h = Math.max(2, Math.round(((geo.height * w) / geo.width) / 2) * 2)
    // exec-out 原始二进制通道（v0.1.40 吞吐根修）：无 pty（无 CRLF 翻损——b64 行帧层退役）、
    // 吞吐跑满码率（shell pty 实测掐到 ~1Mbps，exec-out 实测 4.2Mbps 满速 4M——真机对照
    // 数据入档 plan P9-3b）。--output-format=h264 = Annex B 裸流直通。
    // screenrecord 180s 上限：进程退出即 session 内自动 respawn（对消费者透明——缺口 ~0.5s
    // 记档；两次重启间 h264 无 IDR 间隙由解码器容错）
    const spawnRecord = async () =>
      this.#host.openPipe!(boxId, {
        command: ['screenrecord', '--size', `${w}x${h}`, '--bit-rate', '4M', '--output-format', 'h264', '-'],
        raw: true,
      })
    let pipe = await spawnRecord()
    let dataCb: ((chunk: Uint8Array) => void) | null = null
    let exitCb: ((code: number | null) => void) | null = null
    let closed = false
    let respawning = false
    const session: ScreenStreamSession = {
      codec: 'h264', // Annex B 裸流原始字节直通——WebCodecs 解码管线直用
      onData: (cb) => {
        dataCb = cb
      },
      onExit: (cb) => {
        exitCb = cb
      },
      stderrTail: () => pipe.stderrTail(),
      close: () => {
        if (closed) return
        closed = true
        pipe.close()
      },
    }
    pipe.onData((chunk) => dataCb?.(chunk))
    pipe.onExit(() => {
      if (closed) {
        exitCb?.(null)
        return
      }
      // 180s 录制上限到点——透明 respawn 续流（消费者零感知；失败重试一次后如实退）
      if (respawning) {
        exitCb?.(null)
        return
      }
      respawning = true
      void spawnRecord()
        .then((next) => {
          respawning = false
          if (closed) {
            next.close()
            return
          }
          pipe = next
          pipe.onData((chunk) => dataCb?.(chunk))
          pipe.onExit(() => exitCb?.(null))
        })
        .catch(() => exitCb?.(null))
    })
    this.#streams.add(session)
    return session
  }

  async inputChannel(boxId: string): Promise<{ write(actions: ScreenAction[]): void; close(): void } | null> {
    try {
      await this.#ensureChannel(boxId)
    } catch {
      return null
    }
    return {
      write: (actions: ScreenAction[]): void => {
        const channel = this.#channels.get(boxId)
        if (channel === undefined) return
        void this.geometry(boxId).then((geo) => {
          if (geo === null) return
          const lines = serializeAdbActions(actions, geo, 'user')
          if (lines.length > 0) channel.write(lines)
        })
      },
      close: (): void => {
        this.#channelExits.get(boxId)?.()
        this.#channels.delete(boxId)
        this.#channelExits.delete(boxId)
      },
    }
  }

  dispose(): void {
    for (const exit of this.#channelExits.values()) exit()
    this.#channels.clear()
    this.#channelExits.clear()
    for (const s of this.#streams) {
      try {
        s.close()
      } catch {
        // dispose 兜底不抛
      }
    }
    this.#streams.clear()
  }

  /** 常驻 `adb shell`（设备端 sh 逐行执行 stdin——低延迟注入通道，无 ack 触屏语义） */
  async #ensureChannel(boxId: string): Promise<void> {
    if (this.#channels.has(boxId)) return
    if (!this.#host.openPipe) {
      throw new KernelError(ScreenErrorCodes.SCREEN_ACT_FAILED, '执行通道不支持常驻管道——注入不可用')
    }
    const pipe = await this.#host.openPipe(boxId, { command: ['sh'] })
    this.#channels.set(boxId, {
      write: (lines: string[]) => {
        pipe.write(`${lines.join('; ')}\n`)
      },
      close: () => pipe.close(),
    })
    this.#channelExits.set(boxId, () => pipe.close())
    pipe.onExit(() => {
      this.#channels.delete(boxId) // 通道退出除名（下次输入重建）
      this.#channelExits.delete(boxId)
    })
  }
}
