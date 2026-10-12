<script setup lang="ts">
/**
 * BotBallAvatar（v0.1.65）：BotBall 引擎小球头像——roster-item 与 stream-head 的 agent
 * 头像位。lite 模式（列表多实例轻量）；表情映射收在 lib/bot-ball/emotions.openbot.ts
 * （本组件不含任何表情 id）。身份色染身体（agentColor 恒 hex 可直喂）。
 * 尺寸由使用处的容器类控制（SVG width/height 100% 自适应）。
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { BotBall } from '../lib/bot-ball'
import type { BotBallEngine } from '../lib/bot-ball'
import { emotionOf, WIZARD_TOUR } from '../lib/bot-ball/emotions.openbot'
import type { BallState } from '../lib/bot-ball/emotions.openbot'

const props = withDefaults(defineProps<{ color?: string; state?: BallState; tour?: boolean }>(), {
  color: undefined,
  state: 'idle',
  tour: false,
})

const host = ref<HTMLElement>()
let engine: BotBallEngine | null = null

/** 与引擎 shade 同式的明暗插值（渐变三档一致性：0% 亮 22% / 62% 主色 / 100% 暗 12%） */
const shade = (hex: string, amt: number): string => {
  let h = hex.replace('#', '')
  if (h.length === 3) h = h[0]! + h[0]! + h[1]! + h[1]! + h[2]! + h[2]!
  const n = Number.parseInt(h, 16)
  const mix = (v: number): number => Math.round(v + ((amt < 0 ? 0 : 255) - v) * Math.abs(amt))
  const r = mix((n >> 16) & 255)
  const g = mix((n >> 8) & 255)
  const b = mix(n & 255)
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`
}

/** 运行时改色（v0.1.66 抽搐修复）：直写渐变三档 stop——不重建引擎，表情/动画连续不重置。
 *  依赖引擎渐变结构（radialGradient 三 stop：0%/62%/100%）——引擎结构性永不改，结构可控 */
const recolor = (hex: string): void => {
  const stops = host.value?.querySelectorAll('radialGradient stop')
  if (!stops || stops.length < 3) return
  stops[0]!.setAttribute('stop-color', shade(hex, 0.22))
  stops[1]!.setAttribute('stop-color', hex)
  stops[2]!.setAttribute('stop-color', shade(hex, -0.12))
}

/** 挂载（引擎无运行时改色入口；色变化走 recolor 不重建——roster 事件 push 的新 agent
 *  档案色缺席、快照刷新后 colorOf 才给档案色的场景同样受益） */
const mount = (): void => {
  if (!host.value) return
  engine?.destroy()
  engine = BotBall.create(host.value, {
    emotion: emotionOf(props.state),
    ...(props.color !== undefined ? { color: props.color as `#${string}` } : {}),
    lite: true,
    autostart: true,
  })
  // 轮播模式（向导大球「自由变换表情」）：忽略 state，按清单周期切换
  if (props.tour) engine.startTour([...WIZARD_TOUR], 2600)
}

onMounted(mount)
watch(() => props.color, (c) => {
  if (c !== undefined) recolor(c)
})
watch(
  () => props.state,
  (s) => {
    if (!props.tour) engine?.setEmotion(emotionOf(s))
  },
)
onBeforeUnmount(() => {
  engine?.destroy()
  engine = null
})
</script>

<template>
  <span ref="host" class="ball-avatar" aria-hidden="true"></span>
</template>

<style scoped>
.ball-avatar {
  display: block;
  width: 100%;
  height: 100%;
}
</style>
