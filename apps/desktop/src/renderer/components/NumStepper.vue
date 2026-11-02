<script setup lang="ts">
/**
 * 数字步进器（v0.1.111 撤 cron 条件字段原生 spinner——用户报障样式丑）：连体三段
 * [−] input [＋]，与 field-input 同族观感（30px 高 / 圆角 7px / line-strong 描边 / bg0 底）。
 * 交互：点击步进 1 并 clamp 到 [min,max]；按住 300ms 后进入 40ms/步连发（附件条箭头
 * v0.1.106 范式：窗口级 pointerup 兜底 + 卸载清理）；到边界对应钮禁用态。
 * 手输清空不回写（Vue 仅在绑定值变化时 patch DOM——视觉保留空，内存留旧值，
 * 保存端 cronOfForm clamp 双保险兜底，与原生 v-model.number 清空行为等价）。
 * 内部 input 保留 cron-num 类——E2E .cron-num fill 选择器兼容（样式职责已迁容器）。
 *
 * 三段值域（2026-11-02 执行预算定稿）：unlimitedValue 在场时值域为
 * [min..max] ∪ {unlimitedValue}——max 顶格再 ＋ / 手输超 max → 无限制（覆盖层文字，
 * input 禁输，－ 回 max）；unlimitedAt='both' 时 min 端再 － / 手输低于 min 亦入无限制
 * （总时长：0 与 1440+ 都是无限制）。mutedZero：值为 0 数字弱色（工具轮 0=禁用示意）。
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
  /** 无限制哨兵值（如 -1）：在场启用三段值域；input[type=number] 显不了文字——哨兵态
   *  清空 input、叠「无限制」覆盖层 */
  unlimitedValue?: number
  /** 无限制入口（缺省 'max' 仅顶格 ＋）：'both' 时 min 端 － / 手输低于 min 亦入无限制 */
  unlimitedAt?: 'max' | 'both'
  /** 值为 0 时数字弱色（工具轮预算 0=禁用工具的特殊态示意） */
  mutedZero?: boolean
}>()
const emit = defineEmits<{ 'update:modelValue': [number] }>()

const isUnlimited = computed(() => props.unlimitedValue !== undefined && props.modelValue === props.unlimitedValue)

/** － 钮禁用：无限态可 −（回 max）；'both' 的 min 端可 −（入无限）；'max' 的 min 端到底 */
const atMin = computed(() => {
  if (isUnlimited.value) return false
  if (props.min === undefined) return false
  return props.modelValue <= props.min && props.unlimitedAt !== 'both'
})
/** ＋ 钮禁用：无限态是顶（无更上方）；max 端可 ＋（入无限）——disabled 不再表达 atMax */
const atMax = computed(() => isUnlimited.value)

function step(dir: 1 | -1): void {
  if (isUnlimited.value) {
    if (dir === -1 && props.max !== undefined) emit('update:modelValue', props.max) // ∞ 的 − 回 max
    return
  }
  let next = props.modelValue + dir
  if (dir === 1 && props.max !== undefined && next > props.max) {
    next = props.unlimitedValue ?? props.max // 顶格再 ＋ → 无限制
  }
  if (dir === -1 && props.min !== undefined && next < props.min) {
    next = props.unlimitedAt === 'both' ? (props.unlimitedValue ?? props.min) : props.min
  }
  emit('update:modelValue', next)
}

/* 按住连发：按下即步 1，300ms 停顿后 40ms/步（轻点不误连发、长按匀速）；到边界/入无限自动停 */
let holdDelay: number | undefined
let holdTick: number | undefined

const holdAtEdge = computed(
  () =>
    isUnlimited.value ||
    (props.max !== undefined && props.modelValue >= props.max) ||
    (props.min !== undefined && props.modelValue <= props.min && props.unlimitedAt !== 'both'),
)

function holdStart(dir: 1 | -1): void {
  holdStop()
  step(dir)
  holdDelay = window.setTimeout(() => {
    holdTick = window.setInterval(() => {
      step(dir)
      if (holdAtEdge.value) holdStop()
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

/* 手输：仅合法数值上行（type=number 下非空值必为数字串）；三段值域下按入口归一 */
function onInput(e: Event): void {
  const v = (e.target as HTMLInputElement).value
  const n = Number(v)
  if (v === '' || !Number.isFinite(n)) return
  if (props.unlimitedValue !== undefined) {
    if (props.max !== undefined && n > props.max) emit('update:modelValue', props.unlimitedValue) // 超 max → 无限
    else if (props.min !== undefined && n < props.min) {
      // 低于 min：'both'（如总时长 0）→ 无限；'max'（如工具轮负数）→ 钳 min
      emit('update:modelValue', props.unlimitedAt === 'both' ? props.unlimitedValue : props.min)
    } else emit('update:modelValue', n)
    return
  }
  emit('update:modelValue', n)
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
      :class="[numClass ?? 'cron-num', { 'is-zero': mutedZero === true && modelValue === 0 && !isUnlimited }]"
      type="number"
      :min="min"
      :max="max"
      :value="isUnlimited ? '' : modelValue"
      :disabled="isUnlimited"
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
    <span v-if="isUnlimited" class="ns-unlimited" aria-hidden="true">无限制</span>
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
  position: relative; /* 无限制覆盖层的定位基准 */
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

/* 0 = 禁用工具的特殊态（工具轮预算行）：数字弱色示意（mutedZero） */
.ns-input.is-zero {
  color: var(--ink3);
}

/* 无限制覆盖层（三段值域）：哨兵态 input 清空禁输，中段叠文字（两侧按钮照常可 − 回 max） */
.ns-unlimited {
  position: absolute;
  left: 27px; /* − 钮右缘（26 + 1 边框） */
  right: 27px;
  top: 0;
  bottom: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11.5px;
  color: var(--ink3);
  letter-spacing: 1px;
  pointer-events: none;
}
</style>
