/**
 * GuiStreamService：Box 桌面实况的生命周期与流分发（plan-computer-use 二期 + 三期双引擎）。
 * 采集在 Box 内（ffmpeg x11grab 管道，字节经 backend.openPipe 原始直出）；分发走 WS /stream
 * 的 kind:'gui' 流（二进制 DATA，与 run 实况/PTY 流同一数据面）。
 *
 * 双引擎（三期，2026-09-04 用户需求 60fps+不降画质+更跟手）：
 * - codec:'h264'（缺省）：x264 ultrafast/zerolatency/crf18（视觉无损）——帧间压缩，编码 CPU
 *   反低于 mjpeg、码率低一个量级、WebCodecs 硬解。**帧语义反转**：H.264 帧间依赖不可丢帧
 *   ——无 latest 槽位、无跳帧（PAUSE 期间 StreamSession 原生缓冲兜底）；晚接入/重连等下一个
 *   IDR 关键帧（-g 30 @60fps 最长 0.5s）。服务端纯字节搬运（>256KB 切块），Annex B 解析在
 *   renderer（零服务端解析）。
 * - codec:'mjpeg'（env OPENBOT_GUI_CODEC=mjpeg 回退/对照）：SOI/EOI 拆帧 + latest 单帧槽位 +
 *   背压即降帧（PAUSE 期不入队，RESUME 补发最新一帧）——一期语义原样保留。
 * 语义约定（与 StreamHub/ShellService 同哲学）：流是实况；单屏纪律（换 Box 开流先杀旧采集）；
 * 孤儿进程纪律（pidfile 补刀 + 开流前签名清场）。
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

/** 流编码引擎（OPEN meta 协商——renderer 按它选解码管线；renderer lib/stream.ts 对照） */
export type GuiCodec = 'h264' | 'mjpeg'

/** gui 流 OPEN meta（meta.meta 的形状；renderer 侧 lib/stream.ts 对照） */
export interface GuiStreamMeta {
  boxId: string
  codec: GuiCodec
}

export interface GuiStreamStartResult {
  ok: boolean
  reason?: string
}

export interface GuiStreamDeps {
  backend: BoxBackend
  /** 屏幕几何查询（ffmpeg -video_size 必填——x11grab 缺省会落 640x480 小窗）；
   *  缺省 exec xdotool getdisplaygeometry，失败如实 null（调用方落 1920x1080 兜底并放行） */
  geometryOf?: (boxId: string) => Promise<ScreenSize | null>
  /** GUI 显示地址（x11grab -i 与 env DISPLAY 双注入）；缺省 env OPENBOT_GUI_DISPLAY
   *  ?? '127.0.0.1:2'——与 computer 工具族同源约定（WSLg TCP 环绕 / 容器 :0 由 env 覆盖） */
  display?: string
  /** 采集帧率（缺省 60——三期目标；钳制 1..60） */
  fps?: number
  /** 编码引擎（缺省 'h264'；'mjpeg' 为一期回退路径——装配期决策，运行中不切） */
  codec?: GuiCodec
  /** 采集 argv 构造注入（测试断言；缺省按 codec 选 ffmpeg x11grab 管道） */
  argvOf?: (geo: ScreenSize, display: string, fps: number) => string[]
}

interface Entry {
  boxId: string
  codec: GuiCodec
  pipe: PipeSession
  /** open 时刻绑定的活跃 WS 会话（发送时惰性过滤已关闭者） */
  targets: Map<StreamSession, number>
  /** mjpeg 引擎专用：拆帧器 + latest 单帧槽位（h264 引擎不拆帧不缓存——不可丢帧） */
  splitter: ReturnType<typeof createMjpegSplitter> | null
  latest: Uint8Array | null
}

const DEFAULT_GEO: ScreenSize = { width: 1920, height: 1080 }

/** 采集进程 pid 记档（kill 补刀依据；单屏纪律下每容器一个固定名足够） */
const PIPE_PIDFILE = '/tmp/.openbot-gui-stream.pid'
/** pidfile 包装：`echo $$` 记下 shell pid，exec "$@" 原位替换为采集进程（pid 不变）——
 *  argv 走 exec 参数零引号地狱（无 shell 解析注入面） */
const PIPE_WRAPPER = `echo $$ > ${PIPE_PIDFILE}; exec "$@"`
/** 坑⑱b：pkill 模式拆半拼接（sh 自身 cmdline 含引号字符不被命中——防自杀） */
const KILL_PATTERN = `'x11grab.*pipe:'"1"`

export class GuiStreamService {
  readonly #backend: BoxBackend
  readonly #geometryOf: (boxId: string) => Promise<ScreenSize | null>
  readonly #display: string | undefined
  readonly #fps: number
  readonly #codec: GuiCodec
  readonly #argvOf: (geo: ScreenSize, display: string, fps: number) => string[]
  readonly #sessions = new Set<StreamSession>()
  readonly #streams = new Map<string, Entry>()

  constructor(deps: GuiStreamDeps) {
    this.#backend = deps.backend
    this.#geometryOf = deps.geometryOf ?? ((boxId) => queryGeometry(this.#backend, deps.display)(boxId))
    this.#display = deps.display
    this.#fps = Math.min(Math.max(Math.trunc(deps.fps ?? 60), 1), 60)
    this.#codec = deps.codec ?? 'h264'
    this.#argvOf = deps.argvOf ?? (this.#codec === 'h264' ? h264X11grabArgv : ffmpegX11grabArgv)
  }

  /** WS 连接建立时登记（gateway onStreamSession 回调接进来——与 streamHub/shellService 并联） */
  attach(session: StreamSession): void {
    this.#sessions.add(session)
    this.#prune()
    // 晚接入者：活动流补开流。h264：无回放（不可丢帧）——观看端等下一个 IDR（-g 30 最长 0.5s）；
    // mjpeg：立即回放 latest（无黑屏间隙——帧源唯一化）
    for (const entry of this.#streams.values()) {
      if (session.closed) return
      const streamId = session.openStream({ kind: 'gui', boxId: entry.boxId, meta: { boxId: entry.boxId, codec: entry.codec } satisfies GuiStreamMeta })
      entry.targets.set(session, streamId)
      if (entry.codec === 'mjpeg' && entry.latest !== null) this.#sendFrame(entry, session, streamId, entry.latest)
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
    // 只命中我们自己的 x11grab 管道）。坑⑱b：模式拆半拼接防 pkill 命中执行自身的 sh；
    // 坑⑱c：SIGTERM 下 ffmpeg 优雅收尾迟迟不退——一律 -9
    await this.#backend
      .exec(boxId, {
        command: ['sh', '-c', `pkill -9 -f ${KILL_PATTERN} 2>/dev/null; rm -f ${PIPE_PIDFILE}; true`],
        timeoutMs: 5_000,
      })
      .catch(() => {})
    let pipe: PipeSession
    try {
      // pidfile 包装（坑⑯，podman 真机首证）：直接杀宿主侧 podman/wsl CLI 客户端**不传导**
      // 容器/发行版内进程——pidfile 精确补刀见 #kill
      pipe = await this.#backend.openPipe(boxId, { command: ['sh', '-c', PIPE_WRAPPER, 'sh', ...argv], env: { DISPLAY: display } })
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) }
    }
    const entry: Entry = {
      boxId,
      codec: this.#codec,
      pipe,
      targets: new Map(),
      splitter: this.#codec === 'mjpeg' ? createMjpegSplitter() : null,
      latest: null,
    }
    this.#streams.set(boxId, entry)
    for (const ws of this.#sessions) {
      if (ws.closed) continue
      entry.targets.set(ws, ws.openStream({ kind: 'gui', boxId, meta: { boxId, codec: entry.codec } satisfies GuiStreamMeta }))
    }
    pipe.onData((chunk) => this.#onBytes(entry, chunk))
    pipe.onExit((code) => this.#onExit(entry, code))
    console.log(`[openbot] gui 流开启（${boxId}，${geo.width}x${geo.height}@${this.#fps} ${this.#codec}，display ${display}）`)
    return { ok: true }
  }

  /** 停流（命令 v1.box.gui.stream.stop；幂等——视图关闭/交还都调） */
  stop(boxId: string): void {
    const entry = this.#streams.get(boxId)
    if (entry) this.#kill(entry, 'stop')
  }

  /** 远端 PAUSE/RESUME（gateway onStreamPause 转发）。mjpeg：恢复时补发 latest（背压即降帧）；
   *  h264：跳过——不可丢帧，暂停期 StreamSession 原生缓冲（buffer-and-resume）兜底 */
  onRemotePause(session: StreamSession, streamId: number | 0, paused: boolean): void {
    if (paused) return
    for (const entry of this.#streams.values()) {
      if (entry.codec !== 'mjpeg') continue
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
    if (entry.codec === 'h264') {
      // 纯字节搬运：不拆帧（renderer 按 Annex B 解析 AU）、不丢帧（PAUSE 期 StreamSession
      // 原生缓冲——file 流同语义）、不缓存（无 latest 语义，晚接入等 IDR）
      for (const [ws, streamId] of [...entry.targets]) {
        if (ws.closed) {
          entry.targets.delete(ws)
          continue
        }
        this.#sendFrame(entry, ws, streamId, chunk)
      }
      return
    }
    // mjpeg：拆帧 + latest 槽位 + 背压即降帧（一期语义）
    for (const frame of entry.splitter!.push(chunk)) {
      entry.latest = frame
      for (const [ws, streamId] of [...entry.targets]) {
        if (ws.closed) {
          entry.targets.delete(ws)
          continue
        }
        if (ws.isPaused(streamId)) continue
        this.#sendFrame(entry, ws, streamId, frame)
      }
    }
  }

  #sendFrame(entry: Entry, ws: StreamSession, streamId: number, frame: Uint8Array): void {
    try {
      // >256KB 帧按协议上限切块（发送方切分契约；接收方按流序重组）
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

// ---- 缺省实现：ffmpeg x11grab 管道 ----

/** mjpeg 引擎 argv（一期路径，回退/对照保留）：-q:v 3 近优档（桌面文本边缘更锐利） */
export function ffmpegX11grabArgv(geo: ScreenSize, display: string, fps: number): string[] {
  return [
    'ffmpeg', '-nostdin',
    '-f', 'x11grab',
    '-framerate', String(fps),
    '-video_size', `${geo.width}x${geo.height}`,
    '-i', display,
    '-f', 'mjpeg',
    '-q:v', '3',
    'pipe:1',
  ]
}

/** h264 引擎 argv（三期主路径）：x264 ultrafast + zerolatency（无 B 帧无 lookahead——编码
 *  延迟最低）+ crf 18（视觉无损，不降画质）+ -g 30（IDR 间隔 0.5s@60fps——晚接入/错位恢复
 *  的最长等待）；-pix_fmt yuv420p 必带（x11grab 默认 bgra 直编会落 4:4:4 profile——主流
 *  GPU 硬解不支持，420 是通用兼容格式）；Annex B 裸流（-f h264 pipe:1，WebCodecs 无
 *  description 时按 Annex B 解析） */
export function h264X11grabArgv(geo: ScreenSize, display: string, fps: number): string[] {
  return [
    'ffmpeg', '-nostdin',
    '-f', 'x11grab',
    '-framerate', String(fps),
    '-video_size', `${geo.width}x${geo.height}`,
    '-i', display,
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-tune', 'zerolatency',
    '-crf', '18',
    '-g', '30',
    '-pix_fmt', 'yuv420p',
    '-f', 'h264',
    'pipe:1',
  ]
}

/** xdotool getdisplaygeometry → {width,height}（输出 "W H"；任何失败如实 null——
 *  调用方落几何兜底放行，采集起不来由 abort reason 冒泡） */
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
