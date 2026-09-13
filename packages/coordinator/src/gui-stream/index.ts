/**
 * GuiStreamService：Box 桌面实况的生命周期与流分发（plan-computer-use 二期 + 三期双引擎）。
 * 采集经 ScreenControl 适配器（plan-image-firstclass P8-2 接口化——ffmpeg/x11grab/清场/
 * pidfile 补刀全部内聚适配器，本服务只认协议中性的帧流会话）；分发走 WS /stream
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
 * 语义约定（与 StreamHub/ShellService 同哲学）：流是实况；单屏纪律（换 Box 开流先关旧会话）；
 * 孤儿进程纪律（pidfile 补刀在适配器 close 内——本服务只管调 close）。
 */
import { MAX_STREAM_CHUNK_BYTES } from '@openbot/transport'
import { StreamSession } from '@openbot/transport'
import type { ScreenControl } from '@openbot/boxes'
import { createMjpegSplitter } from './splitter.js'

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
  /** 桌面控制适配器（P8-2 接口化——采集会话的单一来源） */
  screen: ScreenControl
  /** 采集帧率（缺省 60——三期目标；钳制 1..60） */
  fps?: number
  /** 编码引擎（缺省 'h264'；'mjpeg' 为一期回退路径——装配期决策，运行中不切） */
  codec?: GuiCodec
}

interface Entry {
  boxId: string
  codec: GuiCodec
  session: import('@openbot/boxes').ScreenStreamSession
  /** open 时刻绑定的活跃 WS 会话（发送时惰性过滤已关闭者） */
  targets: Map<StreamSession, number>
  /** mjpeg 引擎专用：拆帧器 + latest 单帧槽位（h264 引擎不拆帧不缓存——不可丢帧） */
  splitter: ReturnType<typeof createMjpegSplitter> | null
  latest: Uint8Array | null
}

export class GuiStreamService {
  readonly #screen: ScreenControl
  readonly #fps: number
  readonly #codec: GuiCodec
  readonly #sessions = new Set<StreamSession>()
  readonly #streams = new Map<string, Entry>()

  constructor(deps: GuiStreamDeps) {
    this.#screen = deps.screen
    this.#fps = Math.min(Math.max(Math.trunc(deps.fps ?? 60), 1), 60)
    this.#codec = deps.codec ?? 'h264'
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
    if (!this.#screen.supportsStream()) {
      return { ok: false, reason: '当前沙箱后端不支持常驻管道——GUI 实况不可用，维持截图轮询' }
    }
    // 单屏纪律：换 Box 开流先关旧采集会话（ffmpeg 常驻不叠罗汉；close 含 pidfile 补刀）
    for (const [otherId, entry] of [...this.#streams]) {
      if (otherId !== boxId) this.#kill(entry, 'switch')
    }
    let session: import('@openbot/boxes').ScreenStreamSession
    try {
      session = await this.#screen.stream(boxId, { fps: this.#fps, codec: this.#codec })
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) }
    }
    const entry: Entry = {
      boxId,
      codec: this.#codec,
      session,
      targets: new Map(),
      splitter: this.#codec === 'mjpeg' ? createMjpegSplitter() : null,
      latest: null,
    }
    this.#streams.set(boxId, entry)
    for (const ws of this.#sessions) {
      if (ws.closed) continue
      entry.targets.set(ws, ws.openStream({ kind: 'gui', boxId, meta: { boxId, codec: entry.codec } satisfies GuiStreamMeta }))
    }
    session.onData((chunk) => this.#onBytes(entry, chunk))
    session.onExit((code) => this.#onExit(entry, code))
    console.log(`[openbot] gui 流开启（${boxId}@${this.#fps}fps ${this.#codec}）`)
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

  /** 应用退出兜底：关全部采集会话（不留后台 ffmpeg——孤儿纪律；补刀在适配器 close 内） */
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
    const tail = entry.session.stderrTail().trim()
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
    // 先杀后清：收流（END/ABORT + targets 清理）由 onExit 统一负责——此处先清 targets
    // 会把观看端的收流路径一并切断（实测单测抓到：END 永不到达）
    entry.session.close()
    console.log(`[openbot] gui 流停止（${entry.boxId}，${cause}）`)
  }

  /** 惰性清理已关闭连接（与 StreamHub 同款） */
  #prune(): void {
    for (const ws of this.#sessions) {
      if (ws.closed) this.detach(ws)
    }
  }
}
