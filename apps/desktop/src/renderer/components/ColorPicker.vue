<script setup lang="ts">
/**
 * ColorPicker（v0.1.66）：自建取色器——色相圆盘 + 明度竖条，滑块跟随，输出 #rrggbb。
 * 净室自研零依赖：色相盘 = conic 六色轮 + radial 白心（饱和度渐变）双层合成；
 * 几何取值——色相按角度、饱和度按离心率、明度按竖向位置；HSV → RGB 换算内联。
 * 拖动支持指针捕获（setPointerCapture——拖出控件边界继续生效，手感与系统色盘一致）。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'

const props = withDefaults(defineProps<{ modelValue?: string; size?: number }>(), {
  modelValue: '#3987e5',
  size: 160,
})
const emit = defineEmits<{ (e: 'update:modelValue', v: string): void }>()

/** HSV 内部态（色相 0-360 / 饱和 0-1 / 明度 0-1）——初始化从外部 hex 反解一次 */
const hsv = ref(parseHex(props.modelValue))
watch(
  () => props.modelValue,
  (hex) => {
    const next = parseHex(hex)
    // 拖动中外部回写同值不重置（色盘拖动 emit → 父回写 → 这里幂等跳过，滑块不跳）
    if (Math.abs(next.h - hsv.value.h) > 0.5 || Math.abs(next.s - hsv.value.s) > 0.01 || Math.abs(next.v - hsv.value.v) > 0.01) hsv.value = next
  },
)

/** hex → HSV（#rrggbb 或 #rgb） */
function parseHex(hex: string): { h: number; s: number; v: number } {
  let h = hex.replace('#', '')
  if (h.length === 3) h = h[0]! + h[0]! + h[1]! + h[1]! + h[2]! + h[2]!
  const n = Number.parseInt(h || '3987e5', 16)
  const r = ((n >> 16) & 255) / 255
  const g = ((n >> 8) & 255) / 255
  const b = (n & 255) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const d = max - min
  let hue = 0
  if (d > 0) {
    if (max === r) hue = ((g - b) / d) % 6
    else if (max === g) hue = (b - r) / d + 2
    else hue = (r - g) / d + 4
    hue *= 60
    if (hue < 0) hue += 360
  }
  return { h: hue, s: max === 0 ? 0 : d / max, v: max }
}

/** HSV → hex（输出恒 #rrggbb） */
function toHex(h: number, s: number, v: number): string {
  const c = v * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = v - c
  let r = 0, g = 0, b = 0
  if (h < 60) [r, g, b] = [c, x, 0]
  else if (h < 120) [r, g, b] = [x, c, 0]
  else if (h < 180) [r, g, b] = [0, c, x]
  else if (h < 240) [r, g, b] = [0, x, c]
  else if (h < 300) [r, g, b] = [x, 0, c]
  else [r, g, b] = [c, 0, x]
  const f = (t: number): string => Math.round((t + m) * 255).toString(16).padStart(2, '0')
  return `#${f(r)}${f(g)}${f(b)}`
}

const value = computed(() => toHex(hsv.value.h, hsv.value.s, hsv.value.v))
watch(value, (v) => {
  if (v.toLowerCase() !== props.modelValue.toLowerCase()) emit('update:modelValue', v)
})

/** 色相盘交互：按指针相对圆心的角度/距离换算 hue/sat */
const discEl = ref<HTMLElement>()
let discDragging = false

const applyDisc = (e: PointerEvent): void => {
  const el = discEl.value
  if (!el) return
  const r = el.getBoundingClientRect()
  const dx = e.clientX - (r.left + r.width / 2)
  const dy = e.clientY - (r.top + r.height / 2)
  const rad = Math.atan2(dy, dx)
  hsv.value = {
    h: ((rad * 180) / Math.PI + 360 + 90) % 360, // 0° 在正上（conic from -90deg 对齐）
    s: Math.min(1, Math.hypot(dx, dy) / (r.width / 2)),
    v: hsv.value.v,
  }
}
const onDiscDown = (e: PointerEvent): void => {
  discDragging = true
  ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  applyDisc(e)
}
const onDiscMove = (e: PointerEvent): void => {
  if (discDragging) applyDisc(e)
}
const onDiscUp = (): void => {
  discDragging = false
}

/** 明度条交互：竖向位置 → v（顶 = 亮，底 = 暗） */
const barEl = ref<HTMLElement>()
let barDragging = false
const applyBar = (e: PointerEvent): void => {
  const el = barEl.value
  if (!el) return
  const r = el.getBoundingClientRect()
  hsv.value = { h: hsv.value.h, s: hsv.value.s, v: 1 - Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) }
}
const onBarDown = (e: PointerEvent): void => {
  barDragging = true
  ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  applyBar(e)
}
const onBarMove = (e: PointerEvent): void => {
  if (barDragging) applyBar(e)
}
const onBarUp = (): void => {
  barDragging = false
}
onBeforeUnmount(() => {
  discDragging = false
  barDragging = false
})

/** 滑块屏幕位置（百分比） */
const discX = computed(() => 50 + Math.cos(((hsv.value.h - 90) * Math.PI) / 180) * hsv.value.s * 50)
const discY = computed(() => 50 + Math.sin(((hsv.value.h - 90) * Math.PI) / 180) * hsv.value.s * 50)
const barY = computed(() => (1 - hsv.value.v) * 100)
</script>

<template>
  <div class="cpick" :style="{ '--cpick-size': `${size}px` }">
    <div
      ref="discEl"
      class="cpick-disc"
      @pointerdown="onDiscDown"
      @pointermove="onDiscMove"
      @pointerup="onDiscUp"
      @pointercancel="onDiscUp"
    >
      <span class="cpick-knob" :style="{ left: `${discX}%`, top: `${discY}%` }"></span>
    </div>
    <div
      ref="barEl"
      class="cpick-bar"
      @pointerdown="onBarDown"
      @pointermove="onBarMove"
      @pointerup="onBarUp"
      @pointercancel="onBarUp"
    >
      <span class="cpick-knob" :style="{ top: `${barY}%` }"></span>
    </div>
  </div>
</template>

<style scoped>
.cpick {
  display: flex;
  gap: 10px;
  align-items: stretch;
}

/* 色相盘：conic 六色轮（正上为红）+ 白心 radial（中心白=饱和 0，边缘纯色=饱和 1） */
.cpick-disc {
  position: relative;
  width: var(--cpick-size);
  height: var(--cpick-size);
  border-radius: 50%;
  background:
    radial-gradient(circle, #fff 0%, rgba(255, 255, 255, 0) 78%),
    conic-gradient(from -90deg, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00);
  box-shadow: inset 0 0 0 1px var(--line);
  cursor: crosshair;
  touch-action: none;
}

/* 明度条：竖向白→黑（经由当前色相的纯色——用 hue-rotate 近似：底层黑上叠当前色再叠白顶） */
.cpick-bar {
  position: relative;
  width: 16px;
  border-radius: 9px;
  background: linear-gradient(to bottom, #fff, var(--_bar-color, #888) 55%, #000);
  box-shadow: inset 0 0 0 1px var(--line);
  cursor: ns-resize;
  touch-action: none;
}
.cpick-bar {
  --_bar-color: v-bind('value');
}

/* 滑块：白圈 + 深描边（图例样式），绝对定位居中 */
.cpick-knob {
  position: absolute;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  border: 2px solid #fff;
  box-shadow: 0 0 0 1.5px rgba(0, 0, 0, 0.65), 0 1px 3px rgba(0, 0, 0, 0.4);
  transform: translate(-50%, -50%);
  pointer-events: none;
}
.cpick-bar .cpick-knob {
  left: 50%;
}
</style>
