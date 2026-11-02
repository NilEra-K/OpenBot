<script setup lang="ts">
/**
 * 数字步进器（v0.1.111 撤 cron 条件字段原生 spinner——用户报障样式丑）：连体三段
 * [−] input [＋]，与 field-input 同族观感（30px 高 / 圆角 7px / line-strong 描边 / bg0 底）。
 * 交互：点击步进 1 并 clamp 到 [min,max]；按住 300ms 后进入 40ms/步连发（附件条箭头
 * v0.1.106 范式：窗口级 pointerup 兜底 + 卸载清理）；到边界对应钮禁用态。
 * 手输清空不回写（Vue 仅在绑定值变化时 patch DOM——视觉保留空，内存留旧值，
 * 保存端 cronOfForm clamp 双保险兜底，与原生 v-model.number 清空行为等价）。
 * 内部 input 保留 cron-num 类——E2E .cron-num fill 选择器兼容（样式职责已迁容器）。
 */
import { computed, onBeforeUnmount, onMounted } from 'vue'

const props = defineProps<{
  modelValue: number
  min?: number
  max?: number
  ariaLabel?: string
  /** input 语义类（2026-11-01）：缺省 cron-num（E2E fill 契约）——非 cron 场景传入专用类，
   *  避免同页多枚步进器时 .cron-num 全局选择器 strict violation（policy 区预算步进实证） */
  numClass?: string
}>()
const emit = defineEmits<{ 'update:modelValue': [number] }>()

const atMin = computed(() => props.min !== undefined && props.modelValue <= props.min)
const atMax = computed(() => props.max !== undefined && props.modelValue >= props.max)

function step(dir: 1 | -1): void {
  let next = props.modelValue + dir
  if (props.min !== undefined) next = Math.max(props.min, next)
  if (props.max !== undefined) next = Math.min(props.max, next)
  emit('update:modelValue', next)
}

/* 按住连发：按下即步 1，300ms 停顿后 40ms/步（轻点不误连发、长按匀速）；到边界自动停 */
let holdDelay: number | undefined
let holdTick: number | undefined

function holdStart(dir: 1 | -1): void {
  holdStop()
  step(dir)
  holdDelay = window.setTimeout(() => {
    holdTick = window.setInterval(() => {
      step(dir)
      if ((dir === 1 && atMax.value) || (dir === -1 && atMin.value)) holdStop()
    }, 40)
  }, 300)
}

function holdStop(): void {
  if (holdDelay !== undefined) {
    window.clearTimeout(holdDelay)
    holdDelay = undefined
  }
  if (holdTick !== undefined) {
    window.clearInterval(holdTick)
    holdTick = undefined
  }
}

/* 松手落在窗外 / 连发中钮被禁用致事件断流——窗口级常驻兜底（幂等） */
const onWinUp = (): void => holdStop()
onMounted(() => window.addEventListener('pointerup', onWinUp))
onBeforeUnmount(() => {
  window.removeEventListener('pointerup', onWinUp)
  holdStop()
})

/* 手输：仅合法数值上行（type=number 下非空值必为数字串） */
function onInput(e: Event): void {
  const v = (e.target as HTMLInputElement).value
  const n = Number(v)
  if (v !== '' && Number.isFinite(n)) emit('update:modelValue', n)
}

/* 键盘可达性兜底：Enter/Space 与 Element.click() 只派发 click（无 pointer 序列，
   detail=0）——真实指针点击 detail≥1 已由 pointerdown 处理，跳过防双步进 */
function onKeyClick(dir: 1 | -1, e: MouseEvent): void {
  if (e.detail === 0) step(dir)
}
</script>

<template>
  <div class="num-stepper">
    <button
      type="button"
      class="ns-btn is-minus"
      :disabled="atMin"
      aria-label="减少"
      @pointerdown="holdStart(-1)"
      @pointerup="holdStop"
      @pointerleave="holdStop"
      @pointercancel="holdStop"
      @click="onKeyClick(-1, $event)"
    ><i class="ns-i" aria-hidden="true"></i></button>
    <input
      class="ns-input"
      :class="numClass ?? 'cron-num'"
      type="number"
      :min="min"
      :max="max"
      :value="modelValue"
      :aria-label="ariaLabel"
      @input="onInput"
    />
    <button
      type="button"
      class="ns-btn is-plus"
      :disabled="atMax"
      aria-label="增加"
      @pointerdown="holdStart(1)"
      @pointerup="holdStop"
      @pointerleave="holdStop"
      @pointercancel="holdStop"
      @click="onKeyClick(1, $event)"
    ><i class="ns-i" aria-hidden="true"></i></button>
  </div>
</template>

<style scoped>
.num-stepper {
  display: inline-flex;
  align-items: stretch;
  width: 94px; /* 26 钮 + 40 输入 + 26 钮 + 2 边框（border-box） */
  height: 30px;
  flex: none; /* flex 子项默认收缩是挤压根因（多附件 chip 教训）——定宽不缩 */
  box-sizing: border-box;
  border: 1px solid var(--line-strong);
  border-radius: 7px;
  background: var(--bg0);
  overflow: hidden;
  transition: border-color 150ms var(--ease);
}

/* 聚焦外圈与 .field-input:focus 同款（accent 半透描边） */
.num-stepper:focus-within {
  border-color: rgba(var(--accent-rgb), 0.5);
}

.ns-btn {
  width: 26px;
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: var(--ink3);
  cursor: pointer;
  user-select: none; /* 按住连发防拖选 */
  transition: background-color 130ms var(--ease), color 130ms var(--ease);
}

.ns-btn:hover:not(:disabled) {
  background: var(--bg3);
  color: var(--ink);
}

.ns-btn:active:not(:disabled) {
  background: var(--line);
}

.ns-btn:disabled {
  opacity: 0.35;
  cursor: default;
}

/* 步进图标：CSS 画线（minus 一横；plus 一横一竖）——不依赖字体度量，粗细长度像素可控 */
.ns-i {
  position: relative;
  width: 10px;
  height: 1.5px;
  border-radius: 1px;
  background: currentColor;
}

.is-plus .ns-i::after {
  content: '';
  position: absolute;
  left: 50%;
  top: 50%;
  width: 1.5px;
  height: 10px;
  transform: translate(-50%, -50%);
  border-radius: 1px;
  background: currentColor;
}

/* 中段输入：透明无边框居中；藏 Chromium 原生 spinner（丑的根源） */
.ns-input {
  flex: 1;
  min-width: 0;
  border: none;
  padding: 0;
  background: transparent;
  color: var(--ink);
  font-family: inherit;
  font-size: 12.5px;
  text-align: center;
  outline: none;
  -moz-appearance: textfield;
}

.ns-input::-webkit-outer-spin-button,
.ns-input::-webkit-inner-spin-button {
  -webkit-appearance: none;
  margin: 0;
}
</style>
