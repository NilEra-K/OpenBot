<script setup lang="ts">
/**
 * GuiScreen（plan-computer-use Step 6 + 二期 30fps + 三期 60fps 双引擎）：Box 桌面旁观/接管视图。
 * 两处挂载分野（2026-09-04 用户裁定——接管入口收进 BoxOps 大屏）：
 * - interactive=false（ctx 小屏，缺省）：**纯旁观**——1.5s 轮询帧源；点击冒泡到 ctx-screen 开
 *   BoxOps 大屏；不绑指针/键盘、不注入、不开流（接管态真值照实呈现，由 store 单源供给）；
 * - interactive=true（BoxOps 大屏）：全指针面注入（移动 60Hz 合帧/点击/拖拽/右键/滚轮）+
 *   键入（50ms 合批）+ watch 接管开实况流、交还停流回落轮询。
 * 双引擎解码泵（三期，OPEN meta.codec 协商）：
 * - h264（缺省）：Annex B 流 → lib/h264 解析 AU → WebCodecs VideoDecoder **硬解** →
 *   VideoFrame 直绘 canvas（GPU 链路，零 JPEG 软解）——60fps/视觉无损/回显延迟最低；
 *   解码器出错自动 reset 重建（服务端 -g 30 保证 ≤0.5s 内 IDR 重新同步）；不可丢帧（无 PAUSE）。
 * - mjpeg（回退）：SOI/EOI 拆帧 → createImageBitmap → canvas；背压=解码队列深度 PAUSE。
 * 帧源唯一化：轮询 blob 走 mjpeg 泵，切流无黑屏。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useKernelStore } from '../stores/kernel'
import { createMjpegSplitter } from '../lib/mjpeg'
import { createH264Parser } from '../lib/h264'

const props = withDefaults(defineProps<{ boxId: string; interactive?: boolean }>(), { interactive: false })
const kernel = useKernelStore()

const canvasRef = ref<HTMLCanvasElement | null>(null)
const frameError = ref<string | null>(null)
/** 接管真值：store 单源（main 事件广播 + 首笔输入乐观置位）——小屏/大屏两实例同源呈现 */
const takeover = computed(() => kernel.guiTakeover)
const streamActive = ref(false)
/** 已画帧数（E2E 断言锚点：data-frames） */
const streamFrames = ref(0)
let timer: ReturnType<typeof setInterval> | null = null

// ---- 流订阅态（高频非序列化态，普通变量不入 ref） ----
let guiStreamId: number | null = null
let guiCodec: 'h264' | 'mjpeg' = 'mjpeg'
let splitter: ReturnType<typeof createMjpegSplitter> | null = null
let h264parser: ReturnType<typeof createH264Parser> | null = null
let unlisten: (() => void) | null = null

// ---- 解码泵共用态：rAF 对齐画帧；候补只留最新（mjpeg 实况语义） ----
let decodeBusy = false
let heldBlob: Blob | null = null
let unconfirmed = 0 // mjpeg：已收未画帧计数（> 上限 → PAUSE 服务端）
let paused = false
const PAUSE_AT = 12
/** h264：解码器时间戳基准（AU 计数 × 帧间隔）；decoder 句柄 */
let h264Decoder: VideoDecoder | null = null
let h264AuCount = 0
let h264Broken = false // 解码器错误后置位——本流不再喂数据（等 END/重启）

const maybePause = (): void => {
  if (guiCodec !== 'mjpeg') return // h264 不可丢帧，无 PAUSE
  if (!paused && unconfirmed > PAUSE_AT && guiStreamId !== null) {
    paused = true
    kernel.guiStreamPause(guiStreamId)
  }
}

/** mjpeg 帧入泵：解码忙时只留最新候补（实况不排队） */
const pumpMjpeg = (blob: Blob): void => {
  unconfirmed += 1
  if (decodeBusy) {
    heldBlob = blob
    maybePause()
    return
  }
  void decodeMjpeg(blob)
}

const decodeMjpeg = (blob: Blob): void => {
  decodeBusy = true
  createImageBitmap(blob)
    .then((bmp) => {
      requestAnimationFrame(() => {
        decodeBusy = false
        unconfirmed = 0
        drawSource(bmp.width, bmp.height, (ctx) => ctx.drawImage(bmp, 0, 0))
        bmp.close()
        const held = heldBlob
        heldBlob = null
        if (held !== null) {
          void decodeMjpeg(held)
          return
        }
        if (paused && guiStreamId !== null) {
          paused = false
          kernel.guiStreamResume(guiStreamId)
        }
      })
    })
    .catch(() => {
      // 解码失败按一帧确认处理（追下一帧/恢复发送——单帧坏不堵塞泵）
      decodeBusy = false
      unconfirmed = 0
      const held = heldBlob
      heldBlob = null
      if (held !== null) void decodeMjpeg(held)
      else if (paused && guiStreamId !== null) {
        paused = false
        kernel.guiStreamResume(guiStreamId)
      }
    })
}

/** 画帧（两引擎共用的 rAF 落地点；canvas 尺寸随源分辨率自适应） */
const drawSource = (width: number, height: number, paint: (ctx: CanvasRenderingContext2D) => void): void => {
  const canvas = canvasRef.value
  if (canvas === null) return
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width
    canvas.height = height
  }
  const ctx = canvas.getContext('2d')
  if (ctx !== null) {
    paint(ctx)
    streamFrames.value += 1
  }
}

// ---- h264 引擎（WebCodecs 硬解）：惰性建解码器，AU 喂 decode，output 回调 rAF 直绘 ----

const H264_CODEC_STRING = 'avc1.42E02A' // Constrained Baseline L4.2——zerolatency 无 B 帧 + 1080p60 的声明上限；流内 SPS 才是真值（Annex B 模式）

const ensureH264Decoder = (): boolean => {
  if (h264Broken) return false
  if (h264Decoder !== null && h264Decoder.state === 'configured') return true
  if (typeof VideoDecoder !== 'function') {
    // WebCodecs 缺席（理论不达——Electron/Chromium 全量支持）：如实降级记录，本流放弃
    if (!h264Broken) {
      h264Broken = true
      frameError.value = 'WebCodecs 不可用——h264 实况不可用（可用 OPENBOT_GUI_CODEC=mjpeg 回退）'
    }
    return false
  }
  h264Decoder = new VideoDecoder({
    output: (frame: VideoFrame) => {
      requestAnimationFrame(() => {
        drawSource(frame.displayWidth, frame.displayHeight, (ctx) => ctx.drawImage(frame as unknown as CanvasImageSource, 0, 0))
        frame.close()
      })
    },
    error: () => {
      // 解码器内部错误：弃用重建——下一个 IDR（≤0.5s）重新同步
      try {
        h264Decoder?.close()
      } catch {
        /* 已 closed */
      }
      h264Decoder = null
      h264AuCount = 0
    },
  })
  try {
    h264Decoder.configure({ codec: H264_CODEC_STRING, optimizeForLatency: true })
    return true
  } catch {
    h264Broken = true
    frameError.value = 'WebCodecs h264 配置不支持——可用 OPENBOT_GUI_CODEC=mjpeg 回退'
    return false
  }
}

const pumpH264 = (chunk: Uint8Array): void => {
  if (h264Broken || !ensureH264Decoder() || h264parser === null) return
  for (const au of h264parser.push(chunk)) {
    if (h264Decoder === null || h264Decoder.state !== 'configured') return
    try {
      h264AuCount += 1
      h264Decoder.decode(
        new EncodedVideoChunk({
          type: au.type,
          timestamp: Math.round((h264AuCount * 1_000_000) / 60), // 60fps 名义间隔（渲染按 output 到达节奏）
          data: au.data as unknown as BufferSource,
        }),
      )
    } catch {
      // chunk 构造/解码拒绝（错位/不支持）：丢当前 AU 等下个 IDR 自愈，不炸解码器
    }
  }
}

const teardownH264 = (): void => {
  try {
    h264Decoder?.close()
  } catch {
    /* 已 closed */
  }
  h264Decoder = null
  h264parser = null
  h264AuCount = 0
  h264Broken = false
}

// ---- 实况流生命周期（大屏 interactive 独占驱动） ----

const startStream = async (): Promise<void> => {
  if (streamActive.value) return
  try {
    const r = await kernel.call<{ ok: boolean; reason?: string }>('v1.box.gui.stream.start', { boxId: props.boxId })
    if (!r.ok) {
      frameError.value = r.reason ?? '实况流不可用'
      return
    }
    // 交还竞态：开流慢于「交还」（慢后端下命令往返间 release 已发生）——立即补停不孤儿
    if (!takeover.value) {
      void kernel.call('v1.box.gui.stream.stop', { boxId: props.boxId }).catch(() => {})
      return
    }
    streamActive.value = true // OPEN 事件到达后 guiStreamId 才有值（onGuiStreamEvent 里登记）
  } catch (err) {
    frameError.value = err instanceof Error ? err.message : String(err)
  }
}

const stopStream = (): void => {
  if (!streamActive.value) return
  void kernel.call('v1.box.gui.stream.stop', { boxId: props.boxId }).catch(() => {})
  streamActive.value = false
  resetStreamState()
}

const resetStreamState = (): void => {
  guiStreamId = null
  splitter = null
  teardownH264()
  decodeBusy = false
  heldBlob = null
  unconfirmed = 0
  paused = false
}

// ---- 用户输入注入（interactive 实例专属；经 main 常驻通道行式转发——事件延迟 ~数 ms） ----

/** POSIX 单引号转义（' → '\''——sh 行式语境） */
const escapeSh = (s: string): string => s.replaceAll("'", "'\\''")

const sendInput = (script: string): void => {
  void kernel.call('v1.box.gui.input', { boxId: props.boxId, script }).catch(() => {})
}

/** 键入批量合并：50ms 窗口内单键攒一串，一次 xdotool type 发出 */
const TYPE_WINDOW_MS = 50
let typeBuf = ''
let typeTimer: ReturnType<typeof setTimeout> | null = null

const flushTypeBuffer = (): void => {
  if (typeTimer !== null) {
    clearTimeout(typeTimer)
    typeTimer = null
  }
  if (typeBuf === '') return
  const text = typeBuf
  typeBuf = ''
  sendInput(`xdotool type --delay 0 -- '${escapeSh(text)}'`)
}

const queueType = (ch: string): void => {
  typeBuf += ch
  if (typeTimer === null) typeTimer = setTimeout(flushTypeBuffer, TYPE_WINDOW_MS)
}

// ---- 指针面：移动 60Hz 合帧转发 + 点击/拖拽/右键/滚轮（三期 33ms→16ms 跟手再进一步） ----

/** 显示坐标 → 帧内坐标（canvas 盒子=全视口，画面按 object-fit:contain 的子矩形呈现——
 *  换算须先求 contain 缩放与居中偏移；黑边区的点击钳回画面边缘。视口未布局返回 null） */
const toFrameCoords = (e: { clientX: number; clientY: number }): { x: number; y: number } | null => {
  const canvas = canvasRef.value
  if (canvas === null) return null
  const rect = canvas.getBoundingClientRect()
  if (rect.width < 1 || rect.height < 1) return null
  // contain 子矩形：scale = min(盒宽/帧宽, 盒高/帧高)，画面在盒内居中
  const scale = Math.min(rect.width / canvas.width, rect.height / canvas.height)
  const offX = (rect.width - canvas.width * scale) / 2
  const offY = (rect.height - canvas.height * scale) / 2
  const x = Math.round((e.clientX - rect.left - offX) / scale)
  const y = Math.round((e.clientY - rect.top - offY) / scale)
  return {
    x: Math.min(Math.max(x, 0), canvas.width - 1),
    y: Math.min(Math.max(y, 0), canvas.height - 1),
  }
}

/** xdotool 按钮号映射（PointerEvent.button → X 按钮） */
const X_BUTTON: Record<number, number> = { 0: 1, 1: 2, 2: 3 }

/** mousemove 合帧：pointermove 只记最新坐标，固定节拍转发（60Hz——连续移动跟手、通道不洪泛） */
const MOVE_TICK_MS = 16
let latestMove: { x: number; y: number } | null = null
let moveSentKey: string | null = null
let moveTimer: ReturnType<typeof setInterval> | null = null
let dragButton: number | null = null

const flushMove = (): void => {
  if (latestMove === null) return
  const key = `${latestMove.x},${latestMove.y}`
  if (key === moveSentKey) return // 位置没变不发包
  moveSentKey = key
  sendInput(`xdotool mousemove ${latestMove.x} ${latestMove.y}`)
}

const onPointerMove = (e: PointerEvent): void => {
  // 点击捕获语义（VMware 式）：未接管时悬停不注入也不接管（防路过挂起 agent）；
  // 接管中移动即转发（60Hz 合帧）——跟手
  if (!props.interactive || !takeover.value) return
  const p = toFrameCoords(e)
  if (p === null) return
  latestMove = p
  if (moveTimer === null) moveTimer = setInterval(flushMove, MOVE_TICK_MS)
}

const onPointerDown = (e: PointerEvent): void => {
  if (!props.interactive) return
  const p = toFrameCoords(e)
  if (p === null) return
  const btn = X_BUTTON[e.button] ?? 1
  flushTypeBuffer() // 时序：先落键后落点
  latestMove = p
  flushMove() // 点击位置先精确落点再按下
  dragButton = btn
  sendInput(`xdotool mousedown ${btn}`)
  kernel.setGuiTakeover(true) // 首笔点击即接管（挂起 agent 下一个动作）
  canvasRef.value?.setPointerCapture(e.pointerId) // 拖拽出画布也能收到 up
  e.preventDefault()
}

const onPointerUp = (e: PointerEvent): void => {
  if (!props.interactive || dragButton === null) return
  const p = toFrameCoords(e)
  if (p !== null) {
    latestMove = p
    flushMove()
  }
  sendInput(`xdotool mouseup ${dragButton}`)
  dragButton = null
}

const onPointerCancel = (): void => {
  if (dragButton === null) return
  sendInput(`xdotool mouseup ${dragButton}`)
  dragButton = null
}

const stopMoveTick = (): void => {
  if (moveTimer !== null) {
    clearInterval(moveTimer)
    moveTimer = null
  }
  latestMove = null
}

/** 滚轮：deltaY 量折算 click 次数（4=上 / 5=下；连击合一次 --repeat 省往返） */
const onWheel = (e: WheelEvent): void => {
  if (!props.interactive) return
  e.preventDefault()
  const button = e.deltaY < 0 ? 4 : 5
  const repeat = Math.min(3, Math.max(1, Math.round(Math.abs(e.deltaY) / 40)))
  sendInput(`xdotool click --repeat ${repeat} ${button}`)
  kernel.setGuiTakeover(true)
}

const onContextMenu = (e: MouseEvent): void => {
  if (!props.interactive) return
  e.preventDefault() // 右键注入给 Box，宿主菜单不出
}

const release = (): void => {
  flushTypeBuffer()
  void kernel.call('v1.box.gui.release').then(() => kernel.setGuiTakeover(false))
}

const onKey = (e: KeyboardEvent): void => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
  const map: Record<string, string> = {
    Enter: 'Return', Backspace: 'BackSpace', Tab: 'Tab', Escape: 'Escape',
    ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', ' ': 'space',
  }
  if (e.key.length === 1) {
    e.preventDefault()
    queueType(e.key)
  } else if (map[e.key] !== undefined) {
    e.preventDefault()
    flushTypeBuffer() // 特殊键保序：先落已攒字符再发键
    sendInput(`xdotool key ${map[e.key]}`)
  }
}

// ---- 旁观轮询（两态共用的兜底帧源；实况流在场时休眠——pull 门禁零动作） ----

const b64ToBlob = (b64: string, mime: string): Blob | null => {
  try {
    const bin = atob(b64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return new Blob([bytes], { type: mime })
  } catch {
    return null // 非法 base64：静默跳过（与旧 img onerror 语义对齐——mock 的 frame 命令回显不是真图）
  }
}

const pull = (): void => {
  if (streamActive.value) return
  void kernel
    .call<{ image: { base64: string; mime: string } | null; reason?: string }>('v1.box.gui.frame', { boxId: props.boxId })
    .then((r) => {
      if (r.image !== null) {
        const blob = b64ToBlob(r.image.base64, r.image.mime)
        if (blob !== null) pumpMjpeg(blob)
        frameError.value = null
      } else {
        frameError.value = r.reason ?? '截图不可用'
      }
    })
    .catch((err: unknown) => (frameError.value = err instanceof Error ? err.message : String(err)))
}

// 接管 ↔ 开流联动（裁定 B）：仅 interactive 实例驱动流（大屏开即实况、关/交还即停回落轮询）。
// immediate：大屏挂载时接管已在位（store 真值）——立即续流
watch(
  takeover,
  (held) => {
    if (!props.interactive) return
    if (held) void startStream()
    else stopStream()
  },
  { immediate: true },
)

onMounted(() => {
  pull()
  timer = setInterval(pull, 1_500)
  if (props.interactive) window.addEventListener('keydown', onKey)
  unlisten = kernel.onGuiStreamEvent((ev) => {
    if (ev.boxId !== props.boxId) return
    if (ev.type === 'open') {
      guiStreamId = ev.streamId ?? null
      guiCodec = ev.codec ?? 'mjpeg'
      if (guiCodec === 'mjpeg') {
        if (splitter === null) splitter = createMjpegSplitter()
      } else {
        h264parser = createH264Parser()
      }
    } else if (ev.type === 'data' && ev.streamId === guiStreamId && ev.chunk !== undefined) {
      if (guiCodec === 'mjpeg' && splitter !== null) {
        for (const frame of splitter.push(ev.chunk)) pumpMjpeg(new Blob([frame], { type: 'image/jpeg' }))
      } else if (guiCodec === 'h264') {
        pumpH264(ev.chunk)
      }
    } else if (ev.type === 'end' && (ev.streamId === undefined || ev.streamId === guiStreamId)) {
      // 流结束（停流/采集退出）：回落轮询——timer 常驻，下一拍自动接管画面
      const hadStream = streamActive.value
      streamActive.value = false
      resetStreamState()
      if (ev.reason !== undefined && hadStream) frameError.value = ev.reason
    }
  })
  // 重启/重载后接管态对账（main 只在转移时发事件，不重放——挂载时现拉一次）
  void kernel
    .call<{ enabled: boolean; takeover: boolean }>('v1.box.gui.state')
    .then((s) => kernel.setGuiTakeover(s.takeover))
    .catch(() => {})
})

onBeforeUnmount(() => {
  if (timer !== null) clearInterval(timer)
  stopMoveTick()
  if (props.interactive) {
    window.removeEventListener('keydown', onKey)
    flushTypeBuffer()
    stopStream() // 流随大屏开关（裁定 C）：小屏实例不开流也就不杀流
  }
  unlisten?.()
})
</script>

<template>
  <div class="gui-screen" :data-stream="streamActive ? '1' : '0'">
    <div
      class="gui-viewport"
      :class="{ 'is-bystander': !interactive }"
      @pointermove="onPointerMove"
      @pointerdown="onPointerDown"
      @pointerup="onPointerUp"
      @pointercancel="onPointerCancel"
      @pointerleave="stopMoveTick"
      @wheel="onWheel"
      @contextmenu="onContextMenu"
    >
      <!-- canvas 只做渲染面（两引擎共用落地点）；指针面挂视口 div——mock 流首帧到达前 canvas
           未定尺寸（默认 300x150），指针挂 canvas 会漏点击。
           旁观模式 pointerdown 不注入（冒泡到 ctx-screen 开大屏由 CtxPanel 的 openOps 接） -->
      <canvas
        v-if="frameError === null"
        ref="canvasRef"
        class="gui-canvas"
        :data-frames="String(streamFrames)"
      />
      <div v-if="frameError !== null" class="gui-idle">截图不可用：{{ frameError }}<br />（GUI 容器未起或 scrot 不在场）</div>
    </div>
    <div class="gui-bar">
      <span class="gui-state" :class="{ 'is-takeover': takeover }">
        <template v-if="interactive">
          {{ takeover ? (streamActive ? (guiCodec === 'h264' ? '你已接管——实况 60fps' : '你已接管——实况 30fps') : '你已接管——agent 动作挂起') : '旁观中（agent 视角）——点击画面接管（接管后移动/键入直送）' }}
        </template>
        <template v-else>
          {{ takeover ? '接管中——在操作台大屏操作' : '旁观中（agent 视角）——点击打开操作台大屏' }}
        </template>
      </span>
      <button v-if="interactive && takeover" class="btn btn-secondary btn-sm" @click="release">交还 agent</button>
      <span class="gui-tip">{{ interactive ? '移动/点击/键入即接管；登录等人工操作完成后点「交还 agent」继续' : '点击画面打开操作台大屏，接管在大屏进行' }}</span>
    </div>
  </div>
</template>

<style scoped>
.gui-screen {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.gui-viewport {
  flex: 1;
  min-height: 0;
  position: relative; /* canvas 绝对填充的定位上下文 */
  overflow: hidden;
  background: #080a0b;
}

/* 旁观小屏：点击语义是「打开大屏」不是注入——指针用 pointer 提示跳转 */
.gui-viewport.is-bystander {
  cursor: pointer;
}

/* canvas 盒子恒等于视口（绝对填充），画面内容由 object-fit:contain 完整呈现（宽高比保持，
   黑边补余）——「宽合适高溢出 / 高合适宽溢出」的二选一不存在了；盒子不随帧固有尺寸重排，
   首帧到达无「先小后铺满」跳变（2026-09-04 用户反馈三项） */
.gui-canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: contain;
  user-select: none;
  touch-action: none;
}

.gui-viewport:not(.is-bystander) {
  cursor: crosshair;
}

.gui-idle {
  color: #8a938e;
  font-size: 10.5px;
  line-height: 1.8;
  padding: 8px 12px;
  text-align: center;
  white-space: pre-line;
}

.gui-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 5px 9px;
  font-size: 10px;
  background: rgba(26, 24, 21, 0.85);
  border-top: 1px solid rgba(255, 255, 255, 0.05);
  color: var(--ink3);
  flex: none;
}

.gui-state {
  flex: none;
}

.gui-state.is-takeover {
  color: var(--accent);
}

.gui-tip {
  margin-left: auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ---- btn 家族副本（模板 .btn/.btn-secondary/.btn-sm 此前无定义——裸按钮）。
   gui-bar 恒深底（rgba(26,24,21,.85) 不随主题翻转）——配色定死深色方案（同 .gui-idle #8a938e 先例）；
   不取 --bg2/--ink/--accent：日间主题下会翻成浅色系与深 bar 割裂 ---- */
.btn {
  display: inline-flex;
  align-items: center;
  border: 1px solid rgba(255, 255, 255, 0.16);
  background: rgba(255, 255, 255, 0.06);
  color: #eaeaea;
  border-radius: 7px;
  cursor: pointer;
  font-size: 12.5px;
  transition: background 140ms var(--ease), border-color 140ms var(--ease);
}

.btn:hover {
  background: rgba(255, 255, 255, 0.12);
}

.btn:disabled {
  opacity: 0.5;
  cursor: default;
}

.btn-sm {
  height: 26px;
  padding: 0 12px;
}

.btn-secondary {
  border-color: rgba(238, 177, 84, 0.4);
  background: rgba(238, 177, 84, 0.08);
  color: #eeb154;
}

.btn-secondary:hover {
  background: rgba(238, 177, 84, 0.16);
  border-color: rgba(238, 177, 84, 0.6);
}
</style>
