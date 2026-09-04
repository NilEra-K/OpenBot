/**
 * GuiStreamService：Box 桌面实况（30fps mjpeg）的生命周期与流分发（plan-computer-use 二期）。
 * 采集在 Box 内（ffmpeg x11grab 管道，帧字节经 backend.openPipe 原始直出——PTY 文本链路
 * 会毁 jpeg，pipe 语义是二期「PTY 二进制安全」定夺点的落点）；分发走 WS /stream 的
 * kind:'gui' 流（二进制 DATA + PAUSE/RESUME 背压，与 run 实况/PTY 流同一数据面）。
 *
 * 语义约定（与 StreamHub/ShellService 同哲学）：
 * - 流是实况：无 WS 订阅者照样采集（最新帧槽位只留一帧——内存有界）；
 * - **背压即降帧**：远端 PAUSE 期间不入队不排旧帧（StreamSession 的缓冲语义对实况流
 *   会越积越陈），只更新 latest；RESUME 时补发最新帧——观看端永远追当下，不追历史；
 * - 晚接入者（渲染层重连）补开流 + 立即回放 latest（无黑屏间隙——帧源唯一化）；
 * - 单屏纪律：GUI 视图同一时刻只看一个桌面，换 Box 开流先杀旧 ffmpeg（孤儿进程纪律）。
 */
import { MAX_STREAM_CHUNK_BYTES } from '@openbot/transport'
import { StreamSession } from '@openbot/transport'
import type { BoxBackend, ExecSpec, PipeSession } from '@openbot/boxes'
import { createMjpegSplitter } from './splitter.js'

/** 屏幕几何（ffmpeg -video_size 与 renderer 坐标换算的事实） */
export interface ScreenSize {
  width: number
  height: number
}

/** gui 流 OPEN meta（meta.meta 的形状；renderer 侧 lib/stream.ts 对照） */
export interface GuiStreamMeta {
  boxId: string
}

export interface GuiStreamStartResult {
  ok: boolean
  reason?: string
}

export interface GuiStreamDeps {
  backend: BoxBackend
  /** 屏幕几何查询（ffmpeg -video_size 必填——x11grab 缺省会落 640x480 小窗）；
   *  缺省 exec xdotool getdisplaygeometry，失败如实 null（调用方落 1280x800 兜底并放行） */
  geometryOf?: (boxId: string) => Promise<ScreenSize | null>
  /** GUI 显示地址（x11grab -i 与 env DISPLAY 双注入）；缺省 env OPENBOT_GUI_DISPLAY
   *  ?? '127.0.0.1:2'——与 computer 工具族同源约定（WSLg TCP 环绕 / 容器 :0 由 env 覆盖） */
  display?: string
  /** 采集帧率（默认 30；钳制 1..30——规划裁定 A 的帧率上限） */
  fps?: number
  /** 采集 argv 构造注入（测试断言；缺省 ffmpeg x11grab mjpeg 管道） */
  argvOf?: (geo: ScreenSize, display: string, fps: number) => string[]
}

interface Entry {
  boxId: string
  pipe: PipeSession
  /** open 时刻绑定的活跃 WS 会话（发送时惰性过滤已关闭者） */
  targets: Map<StreamSession, number>
  splitter: ReturnType<typeof createMjpegSplitter>
  /** 最新完整帧（暂停期与无订阅者期的唯一保留——实况内存有界的根） */
  latest: Uint8Array | null
}

const DEFAULT_GEO: ScreenSize = { width: 1280, height: 800 }

/** 采集进程 pid 记档（kill 补刀依据；单屏纪律下每容器一个固定名足够） */
const PIPE_PIDFILE = '/tmp/.openbot-gui-stream.pid'
/** pidfile 包装：`echo $$` 记下 shell pid，exec "$@" 原位替换为采集进程（pid 不变）——
 *  argv 走 exec 参数零引号地狱（无 shell 解析注入面） */
const PIPE_WRAPPER = `echo $$ > ${PIPE_PIDFILE}; exec "$@"`

export class GuiStreamService {
  readonly #backend: BoxBackend
  readonly #geometryOf: (boxId: string) => Promise<ScreenSize | null>
  readonly #display: string | undefined
  readonly #fps: number
  readonly #argvOf: (geo: ScreenSize, display: string, fps: number) => string[]
  readonly #sessions = new Set<StreamSession>()
  readonly #streams = new Map<string, Entry>()

  constructor(deps: GuiStreamDeps) {
    this.#backend = deps.backend
    this.#geometryOf = deps.geometryOf ?? ((boxId) => queryGeometry(this.#backend, deps.display)(boxId))
    this.#display = deps.display
    this.#fps = Math.min(Math.max(Math.trunc(deps.fps ?? 30), 1), 30)
    this.#argvOf = deps.argvOf ?? ffmpegX11grabArgv
  }

  /** WS 连接建立时登记（gateway onStreamSession 回调接进来——与 streamHub/shellService 并联） */
  attach(session: StreamSession): void {
    this.#sessions.add(session)
    this.#prune()
    // 晚接入者（渲染层重连/晚开页）：活动流补开 + latest 立即回放（下一帧前画面不黑）
    for (const entry of this.#streams.values()) {
      if (session.closed) return
      const streamId = session.openStream({ kind: 'gui', boxId: entry.boxId, meta: { boxId: entry.boxId } satisfies GuiStreamMeta })
      entry.targets.set(session, streamId)
      if (entry.latest !== null) this.#sendFrame(entry, session, streamId, entry.latest)
    }
  }

  detach(session: StreamSession): void {
    this.#sessions.delete(session)
    for (const entry of this.#streams.values()) entry.targets.delete(session)
  }

  /** 活动流清点（观察面/测试断言） */
  activeBoxIds(): string[] {
    return [...this.#streams.keys()]
  }

  /** 开流（命令 v1.box.gui.stream.start；幂等——视图重挂载/接管重复触发零成本） */
  async start(boxId: string): Promise<GuiStreamStartResult> {
    this.#prune()
    if (this.#streams.has(boxId)) return { ok: true }
    if (!this.#backend.openPipe) {
      return { ok: false, reason: '当前沙箱后端不支持常驻管道——GUI 实况不可用，维持截图轮询' }
    }
    // 单屏纪律：换 Box 开流先杀旧采集（ffmpeg 常驻不叠罗汉）
    for (const [otherId, entry] of [...this.#streams]) {
      if (otherId !== boxId) this.#kill(entry, 'switch')
    }
    const display = this.#display ?? process.env.OPENBOT_GUI_DISPLAY ?? '127.0.0.1:2'
    const geo = (await this.#geometryOf(boxId).catch(() => null)) ?? DEFAULT_GEO
    const argv = this.#argvOf(geo, display, this.#fps)
    // 坑⑱清场（真机首证）：应用被硬杀（taskkill/崩溃）时 dispose/pidfile 补刀没跑——容器内
    // ffmpeg 孤儿继续编码（实测 3 只残留）。开流前按采集签名 pkill 清场（单屏纪律下安全，
    // 只命中我们自己的 x11grab 管道）。坑⑱b：模式串经 `sh -c` 传入时，执行它的 sh 自身
    // cmdline 含完整模式——pkill 连自己一起杀（exit 143 自杀，真机探针首证）；模式拆半拼接
    // 绕开（sh cmdline 只有两半，拼回的完整模式只匹配 ffmpeg）
    await this.#backend
      .exec(boxId, {
        // -9 必带（真机探针）：SIGTERM 下 ffmpeg 走优雅收尾迟迟不退，SIGKILL 立即清零
        command: ['sh', '-c', `pkill -9 -f 'x11grab.*pipe:'"1" 2>/dev/null; rm -f ${PIPE_PIDFILE}; true`],
        timeoutMs: 5_000,
      })
      .catch(() => {})
    let pipe: PipeSession
    try {
      // pidfile 包装（坑⑯，podman 真机首证）：直接杀宿主侧 podman/wsl CLI 客户端**不传导**
      // 容器/发行版内进程——ffmpeg 在 Box 内变孤儿继续编码；pidfile 精确补刀见 #kill
      pipe = await this.#backend.openPipe(boxId, { command: ['sh', '-c', PIPE_WRAPPER, 'sh', ...argv], env: { DISPLAY: display } })
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) }
    }
    const entry: Entry = { boxId, pipe, targets: new Map(), splitter: createMjpegSplitter(), latest: null }
    this.#streams.set(boxId, entry)
    for (const ws of this.#sessions) {
      if (ws.closed) continue
      entry.targets.set(ws, ws.openStream({ kind: 'gui', boxId, meta: { boxId } satisfies GuiStreamMeta }))
    }
    pipe.onData((chunk) => this.#onBytes(entry, chunk))
    pipe.onExit((code) => this.#onExit(entry, code))
    console.log(`[openbot] gui 流开启（${boxId}，${geo.width}x${geo.height}@${this.#fps}，display ${display}）`)
    return { ok: true }
  }

  /** 停流（命令 v1.box.gui.stream.stop；幂等——视图关闭/交还都调） */
  stop(boxId: string): void {
    const entry = this.#streams.get(boxId)
    if (entry) this.#kill(entry, 'stop')
  }

  /** 远端 PAUSE/RESUME（gateway onStreamPause 转发）：暂停期发送侧已跳过；恢复时补发 latest */
  onRemotePause(session: StreamSession, streamId: number | 0, paused: boolean): void {
    if (paused) return
    for (const entry of this.#streams.values()) {
      for (const [ws, sid] of [...entry.targets]) {
        if (ws !== session || ws.closed) continue
        if (streamId !== 0 && sid !== streamId) continue
        if (ws.isPaused(sid)) continue
        if (entry.latest !== null) this.#sendFrame(entry, ws, sid, entry.latest)
      }
    }
  }

  /** 应用退出兜底：杀全部采集进程（不留后台 ffmpeg——孤儿纪律） */
  dispose(): void {
    for (const entry of this.#streams.values()) this.#kill(entry, 'dispose')
    this.#sessions.clear()
  }

  #onBytes(entry: Entry, chunk: Uint8Array): void {
    for (const frame of entry.splitter.push(chunk)) {
      entry.latest = frame
      for (const [ws, streamId] of [...entry.targets]) {
        if (ws.closed) {
          entry.targets.delete(ws)
          continue
        }
        // 背压即降帧：PAUSE 期间跳过（不入 StreamSession 缓冲——实况排旧帧无意义），
        // RESUME 后由 onRemotePause 补发 latest
        if (ws.isPaused(streamId)) continue
        this.#sendFrame(entry, ws, streamId, frame)
      }
    }
  }

  #sendFrame(entry: Entry, ws: StreamSession, streamId: number, frame: Uint8Array): void {
    try {
      // >256KB 帧按协议上限切块（发送方切分契约；renderer 侧拆帧器按标记重组，跨块天然收敛）
      for (let off = 0; off < frame.length; off += MAX_STREAM_CHUNK_BYTES) {
        const end = Math.min(off + MAX_STREAM_CHUNK_BYTES, frame.length)
        ws.sendChunk(streamId, frame.subarray(off, end))
      }
    } catch (err) {
      // 会话关闭/流已结束的竞态：丢目标（prune 惰性清理兜底），不影响其余观看端
      entry.targets.delete(ws)
      console.warn(`[openbot] gui 流发送失败（已丢弃该观看端）：`, err instanceof Error ? err.message : err)
    }
  }

  #onExit(entry: Entry, code: number | null): void {
    const tail = entry.pipe.stderrTail().trim()
    for (const [ws, streamId] of [...entry.targets]) {
      if (ws.closed) continue
      try {
        if (code === null || code === 0) ws.endStream(streamId)
        else ws.abortStream(streamId, `采集进程退出（code ${code}）${tail !== '' ? `：${tail.slice(-200)}` : ''}`)
      } catch {
        /* 关闭竞态——观看端已走 */
      }
    }
    entry.targets.clear()
    if (this.#streams.get(entry.boxId) === entry) this.#streams.delete(entry.boxId)
    console.log(`[openbot] gui 流退出（${entry.boxId}，code ${code ?? 'null'}）${tail !== '' ? ` stderr: ${tail.slice(-200)}` : ''}`)
  }

  #kill(entry: Entry, cause: string): void {
    if (this.#streams.get(entry.boxId) === entry) this.#streams.delete(entry.boxId)
    // 坑⑯补刀（podman 真机首证）：杀宿主侧 CLI 客户端不传导 Box 内进程——按 pidfile 精确
    // kill 采集进程；-9 必带（SIGTERM 优雅收尾迟迟不退——真机探针）；ffmpeg 已自退时
    // kill 报错吞掉（rm 照做，不留陈旧 pidfile）
    void this.#backend
      .exec(entry.boxId, {
        command: ['sh', '-c', `kill -9 "$(cat ${PIPE_PIDFILE})" 2>/dev/null; rm -f ${PIPE_PIDFILE}`],
        timeoutMs: 5_000,
      })
      .catch(() => {})
    // 先杀后清：收流（END/ABORT + targets 清理）由 onExit 统一负责——此处先清 targets
    // 会把观看端的收流路径一并切断（实测单测抓到：END 永不到达）
    entry.pipe.close()
    console.log(`[openbot] gui 流停止（${entry.boxId}，${cause}）`)
  }

  /** 惰性清理已关闭连接（与 StreamHub 同款） */
  #prune(): void {
    for (const ws of this.#sessions) {
      if (ws.closed) this.detach(ws)
    }
  }
}

// ---- 缺省实现：ffmpeg x11grab mjpeg 管道（裁定 A） ----

/** 采集 argv：-video_size 必填（x11grab 缺省 640x480——libavdevice 的 vga 默认，不传就是
 *  小窗角标不是全屏）；-q:v 5 压单帧体量（1280x800 约 60-150KB——sendFrame 切块兜底越限）；
 *  Windows 侧零 ffmpeg 依赖（帧在 Box 内编码，宿主只搬运字节） */
export function ffmpegX11grabArgv(geo: ScreenSize, display: string, fps: number): string[] {
  return [
    'ffmpeg', '-nostdin',
    '-f', 'x11grab',
    '-framerate', String(fps),
    '-video_size', `${geo.width}x${geo.height}`,
    '-i', display,
    '-f', 'mjpeg',
    '-q:v', '5',
    'pipe:1',
  ]
}

/** xdotool getdisplaygeometry → {width,height}（输出 "W H"；任何失败如实 null——
 *  调用方落 1280x800 兜底放行，采集起不来由 abort reason 冒泡） */
export function queryGeometry(
  backend: Pick<BoxBackend, 'exec'>,
  display?: string,
): (boxId: string) => Promise<ScreenSize | null> {
  return async (boxId) => {
    try {
      const spec: ExecSpec = {
        command: ['xdotool', 'getdisplaygeometry'],
        timeoutMs: 5_000,
        env: display !== undefined ? { DISPLAY: display } : {},
      }
      const r = await backend.exec(boxId, spec)
      if (r.exitCode !== 0) return null
      const m = /^(\d+)\s+(\d+)$/.exec(r.stdout.trim())
      if (m === null) return null
      const width = Number(m[1])
      const height = Number(m[2])
      if (!Number.isFinite(width) || !Number.isFinite(height)) return null
      if (width < 16 || height < 16 || width > 16_384 || height > 16_384) return null
      return { width, height }
    } catch {
      return null
    }
  }
}
