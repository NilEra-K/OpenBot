/**
 * 桌面控制适配器接口（plan-image-firstclass P8-2 阶段二）：「截图/点击/键入/实况采集」
 * 从具体命令（xdotool/scrot/ffmpeg x11grab）提升为 ScreenControl 接口——runner 的 computer
 * 工具族、coordinator 的 GuiStreamService、desktop 的 gui 命令面只认接口，按镜像/载体类型
 * 提供适配器（X11 适配器 = 既有命令原样迁入；RDP/厂商 API 适配器随真机接入再定形——
 * 准备原则 3：不过早抽象）。这是「Agent 控制镜像」的本质落点（backlog ⑥ 真耦合点 1）。
 *
 * 坐标语义（接口契约）：
 * - act() 的坐标是**截图坐标**（模型按缩放后截图报坐标）——适配器内部换算到真实屏幕；
 * - inputChannel 的坐标是**真实屏幕坐标**（用户看的是原生分辨率实况流）——原样注入。
 *   两条路径的不对称与既有行为一致（agent 走 coordScaleOf / 用户走 renderer contain 换算）。
 *
 * 键名沿用 X keysym 惯例（Return/BackSpace/Up/space…），按钮沿用 X 编号
 * （1=左 2=中 3=右 4=滚轮上 5=滚轮下）——RDP 适配器届时做映射，记档。
 */
import { KernelError } from '@openbot/core'
import type { ExecResult, ExecSpec, PipeSession, PipeSpec } from '../types.js'

export const ScreenErrorCodes = {
  SCREEN_CAPTURE_FAILED: 'SCREEN_CAPTURE_FAILED',
  SCREEN_ACT_FAILED: 'SCREEN_ACT_FAILED',
} as const

/** 桌面几何（坐标换算与采集 -video_size 的事实源） */
export interface ScreenGeometry {
  width: number
  height: number
}

/**
 * 屏幕输入动作（协议中性词表——X11 适配器翻译为 xdotool，未来 RDP/厂商 API 各自翻译）。
 * button 沿用 X 编号：1=左 2=中 3=右 4=滚轮上 5=滚轮下；key 沿用 X keysym 名。
 * click 的 count/intervalMs 表达连击（双击 = count 2 + intervalMs 150），滚动 = 滚轮连击。
 */
export type ScreenAction =
  | { kind: 'move'; x: number; y: number }
  | { kind: 'down'; button: number }
  | { kind: 'up'; button: number }
  | { kind: 'click'; button: number; x?: number; y?: number; count?: number; intervalMs?: number }
  | { kind: 'key'; key: string }
  | { kind: 'type'; text: string; delayMs?: number }

/** 截图结果：字节 + 编码 + 坐标系元数据（token 纪律与缩放语义内聚适配器） */
export interface ScreenCapture {
  /** 图像字节（已按缩放策略编码；base64 编码归消费方） */
  bytes: Uint8Array
  mime: string
  /** 截图坐标空间（缩放后尺寸）——缺席=未缩放（比例 1） */
  width?: number
  height?: number
  /** 真实屏幕尺寸——坐标换算的目标空间 */
  screenWidth?: number
  screenHeight?: number
}

/** 实况采集编码引擎（OPEN meta 协商——renderer 按它选解码管线） */
export type ScreenStreamCodec = 'h264' | 'mjpeg'

/** 实况采集常驻会话（已编码帧流字节直出；无界语义——边界是调用方 close，
 *  孤儿清场（pidfile 补刀）内聚适配器） */
export interface ScreenStreamSession {
  codec: ScreenStreamCodec
  /** 输出增量（h264 Annex B / mjpeg SOI-EOI 帧流——拆帧归消费方） */
  onData(cb: (chunk: Uint8Array) => void): void
  onExit(cb: (code: number | null) => void): void
  /** 最近 stderr 文本（滚动尾部——采集进程异常退出时的诊断面） */
  stderrTail(): string
  /** 停止采集（幂等；孤儿进程补刀内聚适配器） */
  close(): void
}

/** 实况流启动参数 */
export interface ScreenStreamOptions {
  fps?: number
  codec?: ScreenStreamCodec
}

/** 截图参数（缺省=agent 回喂档：1280 宽 / q80 / 含光标——token 纪律） */
export interface ScreenCaptureOptions {
  maxWidth?: number
  quality?: number
  pointer?: boolean
}

/**
 * 桌面控制适配器接口——按镜像/载体类型提供实现；消费方（工具族/实况服务/gui 命令面）零
 * 具体命令依赖。host 是执行通道的最小面（BoxBackend 结构化满足——测试注入窄替身）。
 */
export interface ScreenControl {
  /** 桌面几何（缓存 per boxId）；查询失败 null（如实——降级不换算/落兜底几何） */
  geometry(boxId: string): Promise<ScreenGeometry | null>
  /** 截图（agent 回喂与 UI 轮询共用——token 档与 UI 档经 opts 区分） */
  capture(boxId: string, opts?: ScreenCaptureOptions): Promise<ScreenCapture>
  /**
   * 输入动作（agent 路径——坐标按**截图坐标**语义，适配器内部换算到真实屏幕）
   */
  act(boxId: string, action: ScreenAction): Promise<void>
  /**
   * 实况采集常驻会话（单屏清场与孤儿补刀内聚适配器；几何查询失败落 1920x1080 兜底放行）
   */
  stream(boxId: string, opts?: ScreenStreamOptions): Promise<ScreenStreamSession>
  /** 常驻管道可用性（后端无 openPipe 时实况流如实降级截图轮询的判定面） */
  supportsStream(): boolean
  /**
   * 常驻低延迟注入通道（用户接管路径——坐标按**真实屏幕坐标**语义，原样注入）。
   * 惰性建立、随 box 失效自动重建（进程退出除名）；不可用返回 null（调用方回退逐动作 act）。
   */
  inputChannel?(boxId: string): Promise<{ write(actions: ScreenAction[]): void; close(): void } | null>
  /** 释放全部常驻通道（应用退出兜底——孤儿纪律） */
  dispose?(): void
}

/** 适配器的执行通道最小面（BoxBackend 结构化满足；测试注入窄替身） */
export interface ScreenControlHost {
  exec(boxId: string, spec: ExecSpec): Promise<ExecResult>
  openPipe?(boxId: string, spec: PipeSpec): Promise<PipeSession>
}

// ---------------------------------------------------------------------------
// X11 适配器：xdotool/scrot/ffmpeg x11grab 命令原样迁入（plan-computer-use 一二三期的
// 全部行为契约——唯一临时文件/pidfile 补刀/pkill 拆半模式/坐标换算——行为等价重构）
// ---------------------------------------------------------------------------

/** 默认显示地址（WSLg TCP 环回——与既有 guiDisplay() 缺省一致；装配侧 env 覆盖传参） */
const DEFAULT_DISPLAY = '127.0.0.1:2'

/** 实况流几何兜底（查询失败放行——采集起不来由 abort reason 冒泡，与既有语义一致） */
const DEFAULT_GEO: ScreenGeometry = { width: 1920, height: 1080 }

/** 屏幕几何查询缓存阈界（防 0×0 与荒谬值——与既有实现一致） */
function parseGeometry(stdout: string): ScreenGeometry | null {
  const m = /^(\d+)\s+(\d+)$/.exec(stdout.trim())
  if (m === null) return null
  const width = Number(m[1])
  const height = Number(m[2])
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null
  if (width < 16 || height < 16 || width > 16_384 || height > 16_384) return null
  return { width, height }
}

/** POSIX 单引号转义（type 文本路径——' 变 '\''；坑⑫：转义序列只经普通字符串构造） */
function shQuote(s: string): string {
  const esc = "'\\''"
  return `'${s.replaceAll("'", esc)}'`
}

/**
 * 动作 → 一条 xdotool 命令串（agent 与用户通道共用的单一翻译点——与既有命令逐字节等价）。
 * scale 只作用于坐标（agent 截图坐标语义）；count/intervalMs 表达连击与滚轮步进。
 */
export function serializeScreenAction(action: ScreenAction, scale: number | null): string {
  const s = scale ?? 1
  switch (action.kind) {
    case 'move':
      return `xdotool mousemove ${Math.round(action.x)} ${Math.round(action.y)}`
    case 'down':
      return `xdotool mousedown ${action.button}`
    case 'up':
      return `xdotool mouseup ${action.button}`
    case 'click': {
      // 坐标点击 = 单条 xdotool 链式命令（mousemove X Y click B——与既有 click/doubleClick 同形）；
      // 连击标志跟在 click 词后（xdotool 语法：click --repeat N --delay M B）
      const at =
        action.x !== undefined && action.y !== undefined
          ? `mousemove ${Math.round(action.x * s)} ${Math.round(action.y * s)} `
          : ''
      const repeat =
        action.count !== undefined && action.count > 1
          ? ` --repeat ${Math.trunc(action.count)}${action.intervalMs !== undefined ? ` --delay ${Math.trunc(action.intervalMs)}` : ''}`
          : ''
      return `xdotool ${at}click${repeat} ${action.button}`
    }
    case 'key':
      return `xdotool key ${action.key}`
    case 'type':
      return `xdotool type --delay ${action.delayMs ?? 0} -- ${shQuote(action.text)}`
  }
}

/** 采集进程 pid 记档（kill 补刀依据；单屏纪律下每容器一个固定名足够） */
const STREAM_PIDFILE = '/tmp/.openbot-gui-stream.pid'
/** pidfile 包装：`echo $$` 记下 shell pid，exec "$@" 原位替换为采集进程（pid 不变） */
const STREAM_WRAPPER = `echo $$ > ${STREAM_PIDFILE}; exec "$@"`
/** 坑⑱b：pkill 模式拆半拼接（sh 自身 cmdline 含引号字符不被命中——防自杀） */
const STREAM_KILL_PATTERN = `'x11grab.*pipe:'"1`

/** 注入常驻通道的 argv $0 标签（进 /proc cmdline 供 pkill 定位；坑⑱ 同款清场）。
 *  拆半常量即坑⑱b 的防自杀机制：pkill 模式串写作 'TAG_A''TAG_B'（shell 拼接后仍是完整标签，
 *  但执行清场的 sh 自身 cmdline 含引号字符不被模式命中） */
const INPUT_TAG_A = 'openbot-gui-'
const INPUT_TAG_B = 'input'
const INPUT_CHANNEL_TAG = INPUT_TAG_A + INPUT_TAG_B

export interface X11ScreenControlOptions {
  /** 执行通道（BoxBackend 结构化满足；测试注入窄替身） */
  host: ScreenControlHost
  /** X 显示地址（装配参数化——env OPENBOT_GUI_DISPLAY 由装配方读取传入；缺省 WSLg 环回） */
  display?: string
}

export class X11ScreenControl implements ScreenControl {
  readonly #host: ScreenControlHost
  readonly #display: string
  /** 桌面几何缓存（per boxId——桌面尺寸会话内不变；v0.1.17 坐标换算引入） */
  readonly #geoCache = new Map<string, ScreenGeometry>()
  /** 常驻注入通道缓存（per boxId——惰性建立、进程退出自动除名、dispose 全关） */
  readonly #channels = new Map<string, { write(actions: ScreenAction[]): void; close(): void }>()

  constructor(options: X11ScreenControlOptions) {
    this.#host = options.host
    this.#display = options.display ?? DEFAULT_DISPLAY
  }

  async geometry(boxId: string): Promise<ScreenGeometry | null> {
    const hit = this.#geoCache.get(boxId)
    if (hit) return hit
    try {
      const r = await this.#host.exec(boxId, {
        command: ['xdotool', 'getdisplaygeometry'],
        timeoutMs: 5_000,
        env: { DISPLAY: this.#display },
      })
      if (r.exitCode !== 0) return null
      const geo = parseGeometry(r.stdout)
      if (geo === null) return null
      this.#geoCache.set(boxId, geo)
      return geo
    } catch {
      return null
    }
  }

  /** 坐标换算比（v0.1.17 根治「视觉模型点不准」）：截图 1280 宽而屏幕更宽时模型工作在
   *  缩放坐标系——注入必须乘 屏幕/截图 比例；屏幕 ≤1280（比例 1）与几何查不到均降级不换算 */
  async #scaleOf(boxId: string): Promise<number | null> {
    const geo = await this.geometry(boxId)
    if (geo === null || geo.width <= 1280) return null
    return geo.width / 1280
  }

  async capture(boxId: string, opts: ScreenCaptureOptions = {}): Promise<ScreenCapture> {
    const maxWidth = opts.maxWidth ?? 1280
    const quality = opts.quality ?? 80
    const pointer = opts.pointer !== false
    const geo = await this.geometry(boxId).catch(() => null)
    // 唯一临时文件（2026-09-06 用户报障 convert IDAT CRC error——固定文件名下并发 scrot 覆盖
    // 正在读的文件；$$ = sh 进程 pid 每次 exec 天然隔离，用后清理）
    const pointerFlag = pointer ? ' --pointer' : ''
    const r = await this.#host.exec(boxId, {
      command: [
        'sh', '-c',
        // v0.1.117 输出 PNG（弃 jpeg）：用户端点（DeepSeek 中转）对 jpeg 截图报 unsupported
        // image 400（PNG 上传路径实证可过）；PNG 无损无质量参数
        `f=/tmp/.openbot-shot-$$.png; scrot${pointerFlag} -o "$f" && convert "$f" -resize '${maxWidth}x>' png:- | base64 -w0; rm -f "$f"`,
      ],
      timeoutMs: 15_000,
      env: { DISPLAY: this.#display },
    })
    if (r.exitCode !== 0) {
      throw new KernelError(ScreenErrorCodes.SCREEN_CAPTURE_FAILED, `截图失败（exit ${r.exitCode}）：${r.stderr.trim()}`)
    }
    const b64 = r.stdout.trim()
    if (b64 === '') {
      throw new KernelError(ScreenErrorCodes.SCREEN_CAPTURE_FAILED, '截图输出为空（DISPLAY 未就绪或 scrot 不在场）')
    }
    const bytes = new Uint8Array(Buffer.from(b64, 'base64'))
    if (geo === null || geo.width <= maxWidth) return { bytes, mime: 'image/png' }
    // 'Wx>' 缩放规则：仅宽 >maxWidth 时缩，纵横比保持——缩后尺寸纯计算（零额外 exec）
    return {
      bytes,
      mime: 'image/png',
      width: maxWidth,
      height: Math.round((geo.height * maxWidth) / geo.width),
      screenWidth: geo.width,
      screenHeight: geo.height,
    }
  }

  async act(boxId: string, action: ScreenAction): Promise<void> {
    const scale = await this.#scaleOf(boxId)
    const line = serializeScreenAction(action, scale)
    const r = await this.#host.exec(boxId, {
      command: ['sh', '-c', line],
      timeoutMs: 10_000,
      env: { DISPLAY: this.#display },
    })
    if (r.exitCode !== 0) {
      throw new KernelError(ScreenErrorCodes.SCREEN_ACT_FAILED, `xdotool 失败（exit ${r.exitCode}）：${r.stderr.trim()}`)
    }
  }

  supportsStream(): boolean {
    return this.#host.openPipe !== undefined
  }

  async stream(boxId: string, opts: ScreenStreamOptions = {}): Promise<ScreenStreamSession> {
    if (!this.#host.openPipe) {
      throw new KernelError('BOX_UNSUPPORTED', '执行通道不支持常驻管道——实况采集不可用')
    }
    const fps = Math.min(Math.max(Math.trunc(opts.fps ?? 60), 1), 60)
    const codec = opts.codec ?? 'h264'
    // 坑⑱清场（真机首证）：应用被硬杀时 dispose/pidfile 补刀没跑——容器内 ffmpeg 孤儿继续
    // 编码。开流前按采集签名 pkill 清场；坑⑱b 模式拆半防自杀；坑⑱c 一律 -9（SIGTERM 不退）
    await this.#host
      .exec(boxId, {
        command: ['sh', '-c', `pkill -9 -f ${STREAM_KILL_PATTERN} 2>/dev/null; rm -f ${STREAM_PIDFILE}; true`],
        timeoutMs: 5_000,
      })
      .catch(() => {})
    const geo = (await this.geometry(boxId).catch(() => null)) ?? DEFAULT_GEO
    // 采集 argv（三期双引擎原样迁入）：h264 缺省（x264 ultrafast/zerolatency/crf18 + -g 30 +
    // yuv420p 通用硬解兼容）；mjpeg 回退（-q:v 3 + -draw_mouse 1 光标入画）
    const argv =
      codec === 'h264'
        ? [
            'ffmpeg', '-nostdin',
            '-f', 'x11grab',
            '-draw_mouse', '1',
            '-framerate', String(fps),
            '-video_size', `${geo.width}x${geo.height}`,
            '-i', this.#display,
            '-c:v', 'libx264',
            '-preset', 'ultrafast',
            '-tune', 'zerolatency',
            '-crf', '18',
            '-g', '30',
            '-pix_fmt', 'yuv420p',
            '-f', 'h264',
            'pipe:1',
          ]
        : [
            'ffmpeg', '-nostdin',
            '-f', 'x11grab',
            '-draw_mouse', '1',
            '-framerate', String(fps),
            '-video_size', `${geo.width}x${geo.height}`,
            '-i', this.#display,
            '-f', 'mjpeg',
            '-q:v', '3',
            'pipe:1',
          ]
    // 坑⑯（podman 真机首证）：杀宿主侧 CLI 客户端不传导 Box 内进程——pidfile 精确补刀见 close
    const pipe = await this.#host.openPipe(boxId, {
      command: ['sh', '-c', STREAM_WRAPPER, 'sh', ...argv],
      env: { DISPLAY: this.#display },
    })
    return {
      codec,
      onData: (cb) => pipe.onData(cb),
      onExit: (cb) => pipe.onExit(cb),
      stderrTail: () => pipe.stderrTail(),
      close: () => {
        // pidfile 精确补刀（kill -9——SIGTERM 优雅收尾迟迟不退，真机探针实证）；
        // ffmpeg 已自退时 kill 报错吞掉（rm 照做，不留陈旧 pidfile）
        void this.#host
          .exec(boxId, {
            command: ['sh', '-c', `kill -9 "$(cat ${STREAM_PIDFILE})" 2>/dev/null; rm -f ${STREAM_PIDFILE}`],
            timeoutMs: 5_000,
          })
          .catch(() => {})
        pipe.close()
      },
    }
  }

  async inputChannel(boxId: string): Promise<{ write(actions: ScreenAction[]): void; close(): void } | null> {
    const hit = this.#channels.get(boxId)
    if (hit) return hit
    if (!this.#host.openPipe) return null
    try {
      // 坑⑱同款清场：硬杀后残留的旧注入 sh（argv $0 标签定位）；坑⑱b 模式拆半防自杀
      await this.#host
        .exec(boxId, {
          command: ['sh', '-c', `pkill -9 -f '${INPUT_TAG_A}''${INPUT_TAG_B}' 2>/dev/null; true`],
          timeoutMs: 5_000,
        })
        .catch(() => {})
      // 坑⑰（OCI 首证）：无 -i 时 exec 不接 stdin——常驻 `sh -s` 立即 EOF 退出、通道死路
      //（openPipe 的 -i 在后端实现内；这里只管通道语义）
      const pipe = await this.#host.openPipe(boxId, {
        command: ['sh', '-s', INPUT_CHANNEL_TAG],
        env: { DISPLAY: this.#display },
      })
      const channel = {
        write: (actions: ScreenAction[]): void => {
          // 动作序列化为一行一条（用户路径不换算——真实屏幕坐标语义）
          const lines = actions.map((a) => serializeScreenAction(a, null))
          pipe.write(`${lines.join('\n')}\n`)
        },
        close: (): void => pipe.close(),
      }
      pipe.onExit(() => {
        this.#channels.delete(boxId) // 进程退出自动除名（下次输入重建）
      })
      this.#channels.set(boxId, channel)
      return channel
    } catch {
      return null // 通道建立失败：调用方回退逐动作 act（与既有回退语义一致）
    }
  }

  dispose(): void {
    for (const channel of this.#channels.values()) channel.close()
    this.#channels.clear()
  }
}

/**
 * GUI 工具集探测（B2——生产注册门的事实源之一）：远端 xdotool/scrot 在场才可注册 computer
 * 工具族（ffmpeg 只影响实况流，缺席由 stream 路径如实降级，不进探测）。探测失败=false（如实）。
 */
export async function probeX11Toolset(host: ScreenControlHost, boxId: string): Promise<boolean> {
  try {
    const r = await host.exec(boxId, {
      command: ['sh', '-c', 'command -v xdotool >/dev/null 2>&1 && command -v scrot >/dev/null 2>&1'],
      timeoutMs: 20_000,
    })
    return r.exitCode === 0
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// 桌面控制路由器（plan-screen-firstclass P9-1）：kernel.screen 单实例消费面不变，
// 按 boxId 分发到对应适配器（宿主屏幕条目 → HostScreenControl；其余 → X11）——
// RoutingBoxBackend 的对位件：载体差异收敛在装配层，消费方（工具族/实况服务/gui 命令面）
// 依旧零载体感知。
// ---------------------------------------------------------------------------

export interface ScreenControlRouterOptions {
  /** boxId → 适配器（路由键与 RoutingBoxBackend 同源：BoxSpec.image / 宿主屏幕 boxId） */
  resolve: (boxId: string) => ScreenControl
  /** 全量适配器清单（dispose 兜底遍历——孤儿纪律）；函数形态 = 运行时可变清单（P9-2
   *  per-entry 宿主屏幕适配器按条目增删——数组快照会漏 dispose） */
  adapters: ScreenControl[] | (() => ScreenControl[])
}

export class ScreenControlRouter implements ScreenControl {
  readonly #resolve: (boxId: string) => ScreenControl
  readonly #adapters: ScreenControl[] | (() => ScreenControl[])

  constructor(options: ScreenControlRouterOptions) {
    this.#resolve = options.resolve
    this.#adapters = options.adapters
  }

  geometry(boxId: string): Promise<ScreenGeometry | null> {
    return this.#resolve(boxId).geometry(boxId)
  }

  capture(boxId: string, opts?: ScreenCaptureOptions): Promise<ScreenCapture> {
    return this.#resolve(boxId).capture(boxId, opts)
  }

  act(boxId: string, action: ScreenAction): Promise<void> {
    return this.#resolve(boxId).act(boxId, action)
  }

  stream(boxId: string, opts?: ScreenStreamOptions): Promise<ScreenStreamSession> {
    return this.#resolve(boxId).stream(boxId, opts)
  }

  /** 路由面恒 true（各适配器 stream 内部自兜底——L0 轮询/mjpeg 缺席如实降级） */
  supportsStream(): boolean {
    return true
  }

  async inputChannel(boxId: string): Promise<{ write(actions: ScreenAction[]): void; close(): void } | null> {
    const adapter = this.#resolve(boxId)
    return adapter.inputChannel !== undefined ? adapter.inputChannel(boxId) : null
  }

  dispose(): void {
    const all = typeof this.#adapters === 'function' ? this.#adapters() : this.#adapters
    for (const adapter of all) adapter.dispose?.()
  }
}

