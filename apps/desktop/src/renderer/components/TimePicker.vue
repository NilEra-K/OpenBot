<script setup lang="ts">
/**
 * 时间选择器（v0.1.111 撤原生 time picker 弹层）：输入框本体保留 type=time
 * （原生 segmented 手输 + HH:MM 格式保真），藏原生指示图标，右缘内嵌时钟钮
 * 点开「双列滚轮」弹层（时 0-23 / 分 0-59 全量——无粒度妥协）。
 * 滚轮 = 原生 scroll-snap：滚轮/惯性/点选全为浏览器原生行为；上下 mask 渐隐。
 * 视觉定稿＝方案对比稿方案二「编辑器反色行」（用户四轮打磨裁定）：
 * 中心行 ink 实底反色（夜白底黑字/日黑底白字）+ --mono 等宽 + 直角气质（圆角 4/8）
 * ——VSCode 灰度语系；hover 为 bg3 悬停层、选中反色行恒为最高态；无槽无块无指示线。
 * 滚动经 rAF 合并实时高亮、250ms 防抖落定后 commit；点分格落定后自动关。
 * 弹层 Teleport 到 body（cron-fields 有常驻 overflow:hidden 会剪裁组件内弹层），
 * fixed 定位 + z-index 100（盖过模态 60 / 审批 90）；关闭：外点 / Esc / 点分自动关。
 */
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'

const props = defineProps<{ modelValue: string }>() // 'HH:mm'
const emit = defineEmits<{ 'update:modelValue': [string] }>()

const ITEM_H = 32 // 滚轮单项高 = snap 步进单位（列高 160 = 5 行、首尾 padding 64，见样式注）
const HOURS = Array.from({ length: 24 }, (_, i) => i)
const MINUTES = Array.from({ length: 60 }, (_, i) => i)
const pad2 = (n: number): string => String(n).padStart(2, '0')
const clampIdx = (i: number, max: number): number => Math.min(max, Math.max(0, i))
const parse = (v: string): { h: number; m: number } => {
  const mt = /^(\d{1,2}):(\d{2})$/.exec(v)
  return mt ? { h: clampIdx(Number(mt[1]), 23), m: clampIdx(Number(mt[2]), 59) } : { h: 9, m: 0 }
}

const wrapEl = ref<HTMLElement>()
const popEl = ref<HTMLElement>()
const hourCol = ref<HTMLElement>()
const minCol = ref<HTMLElement>()
const open = ref(false)
const pos = ref({ x: 0, y: 0 })
/* 滚轮中心项：本地态——滚动中间实时高亮，落定（防抖）才 commit 上行 */
const centerH = ref(9)
const centerM = ref(0)

/* ── 滚动侦测：rAF 合并 + 250ms 防抖 commit（平滑滚动与滚轮惯性统一走此路径） ── */
let raf = 0
let commitTimer: number | undefined
let autoCloseTimer: number | undefined

function onColScroll(which: 'h' | 'm'): void {
  if (raf) return
  raf = requestAnimationFrame(() => {
    raf = 0
    const el = which === 'h' ? hourCol.value : minCol.value
    if (!el) return
    const idx = clampIdx(Math.round(el.scrollTop / ITEM_H), which === 'h' ? 23 : 59)
    if (which === 'h') centerH.value = idx
    else centerM.value = idx
    scheduleCommit()
  })
}

function scheduleCommit(): void {
  if (commitTimer !== undefined) window.clearTimeout(commitTimer)
  commitTimer = window.setTimeout(commit, 250)
}

function commit(): void {
  if (commitTimer !== undefined) {
    window.clearTimeout(commitTimer)
    commitTimer = undefined
  }
  const v = `${pad2(centerH.value)}:${pad2(centerM.value)}`
  if (v !== props.modelValue) emit('update:modelValue', v)
}

/* ── 开合 ── */
async function toggle(): Promise<void> {
  if (open.value) close()
  else await openPop()
}

async function openPop(): Promise<void> {
  const { h, m } = parse(props.modelValue)
  centerH.value = h
  centerM.value = m
  const r = wrapEl.value?.getBoundingClientRect()
  pos.value = { x: r?.left ?? 0, y: (r?.bottom ?? 0) + 6 }
  open.value = true
  await nextTick()
  if (hourCol.value) hourCol.value.scrollTop = h * ITEM_H
  if (minCol.value) minCol.value.scrollTop = m * ITEM_H
}

function close(): void {
  if (autoCloseTimer !== undefined) {
    window.clearTimeout(autoCloseTimer)
    autoCloseTimer = undefined
  }
  if (!open.value) return
  commit()
  open.value = false
}

/* ── 点选：平滑滚至目标（值即时取目标——不依赖滚动途中位置）；
   点分格 = 选值完成，落定后自动关；点时格不关（继续调分） ── */
function pick(which: 'h' | 'm', idx: number): void {
  if (which === 'h') centerH.value = idx
  else centerM.value = idx
  scheduleCommit()
  const el = which === 'h' ? hourCol.value : minCol.value
  el?.scrollTo({ top: idx * ITEM_H, behavior: 'smooth' })
  if (which === 'm') autoCloseTimer = window.setTimeout(close, 400)
}

/* ── 外点 / Esc（capture 阶段；Esc 止泡——只关弹层不连带关设置模态） ── */
const onDocDown = (e: PointerEvent): void => {
  const t = e.target as Node
  if (open.value && !wrapEl.value?.contains(t) && !popEl.value?.contains(t)) close()
}
const onKey = (e: KeyboardEvent): void => {
  if (open.value && e.key === 'Escape') {
    e.stopPropagation()
    close()
  }
}

/* ── 手输：合法值上行（原生 time 非空必为合法 HH:MM）；开着弹层则同步滚轮 ── */
function onInput(e: Event): void {
  const v = (e.target as HTMLInputElement).value
  if (!/^\d{2}:\d{2}$/.test(v)) return
  emit('update:modelValue', v)
  if (open.value) {
    const { h, m } = parse(v)
    centerH.value = h
    centerM.value = m
    if (hourCol.value) hourCol.value.scrollTop = h * ITEM_H
    if (minCol.value) minCol.value.scrollTop = m * ITEM_H
  }
}

watch(open, (v) => {
  if (v) {
    document.addEventListener('pointerdown', onDocDown, true)
    document.addEventListener('keydown', onKey, true)
  } else {
    document.removeEventListener('pointerdown', onDocDown, true)
    document.removeEventListener('keydown', onKey, true)
  }
})
onBeforeUnmount(() => {
  close()
  if (raf) cancelAnimationFrame(raf)
  document.removeEventListener('pointerdown', onDocDown, true)
  document.removeEventListener('keydown', onKey, true)
})
</script>

<template>
  <div ref="wrapEl" class="tp-wrap">
    <input
      class="tp-input"
      type="time"
      :value="modelValue"
      aria-label="时间"
      @input="onInput"
    />
    <button
      type="button"
      class="tp-btn"
      :aria-expanded="open"
      aria-label="选择时间"
      @click="toggle"
    >
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true">
        <circle cx="12" cy="12" r="8.5"></circle>
        <path d="M12 7.5V12l3 2"></path>
      </svg>
    </button>
    <Teleport to="body">
      <div v-if="open" ref="popEl" class="tp-pop" :style="{ left: pos.x + 'px', top: pos.y + 'px' }">
        <div class="tp-col" ref="hourCol" @scroll.passive="onColScroll('h')">
          <button
            v-for="h in HOURS"
            :key="h"
            type="button"
            class="tp-item"
            :class="{ 'is-on': centerH === h }"
            :aria-selected="centerH === h"
            role="option"
            :aria-label="`${h} 点`"
            @mousedown.prevent
            @click="pick('h', h)"
          >{{ pad2(h) }}</button>
        </div>
        <span class="tp-colon" aria-hidden="true">:</span>
        <div class="tp-col" ref="minCol" @scroll.passive="onColScroll('m')">
          <button
            v-for="m in MINUTES"
            :key="m"
            type="button"
            class="tp-item"
            :class="{ 'is-on': centerM === m }"
            :aria-selected="centerM === m"
            role="option"
            :aria-label="`${m} 分`"
            @mousedown.prevent
            @click="pick('m', m)"
          >{{ pad2(m) }}</button>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.tp-wrap {
  position: relative;
  display: inline-flex;
  flex: none;
}

/* 输入框：field-input 同族观感（30px 高 / 圆角 7 / line-strong / bg0）+ 右侧给时钟钮让位 */
.tp-input {
  width: 104px;
  height: 30px;
  flex: none;
  box-sizing: border-box;
  padding: 0 30px 0 10px;
  border: 1px solid var(--line-strong);
  border-radius: 7px;
  background: var(--bg0);
  color: var(--ink);
  font-family: inherit;
  font-size: 12.5px;
  text-align: center;
  outline: none;
  transition: border-color 150ms var(--ease);
}

.tp-input:focus {
  border-color: rgba(var(--accent-rgb), 0.5);
}

/* 藏原生丑指示图标（calendar-picker-indicator） */
.tp-input::-webkit-calendar-picker-indicator {
  display: none;
}

.tp-btn {
  position: absolute;
  right: 4px;
  top: 50%;
  transform: translateY(-50%);
  width: 22px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--ink3);
  cursor: pointer;
  transition: background-color 130ms var(--ease), color 130ms var(--ease);
}

.tp-btn:hover {
  background: var(--bg3);
  color: var(--ink);
}

/* ── 弹层（Teleport 到 body——cron-fields overflow:hidden 剪不到；z100 盖过模态60/审批90）。
   方案二语汇：bg1 底 + 圆角 8（编辑器直角气质） ── */
.tp-pop {
  position: fixed;
  z-index: 100;
  display: flex;
  align-items: stretch;
  gap: 2px;
  padding: 8px;
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  background: var(--bg1);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08), 0 12px 28px rgba(0, 0, 0, 0.14);
  /* 淡入：从 -4px 上浮（换档形变同款过渡语言） */
  animation: tp-in 140ms var(--ease);
}

@keyframes tp-in {
  from {
    opacity: 0;
    transform: translateY(-4px);
  }
}

:root[data-theme='dark'] .tp-pop {
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35), 0 12px 28px rgba(0, 0, 0, 0.5);
}

/* 滚轮列：原生 snap 吸附 + 隐藏滚动条 + 上下渐隐 mask。
   高 160 = ROWS(5)×ITEM_H(32)；padding 64 = (160-32)/2 让首尾项可居中——
   与 script 顶 ITEM_H 常量同步维护 */
.tp-col {
  position: relative;
  z-index: 1;
  width: 76px;
  height: 160px;
  overflow-y: auto;
  scroll-snap-type: y mandatory;
  padding: 64px 0;
  scrollbar-width: none;
  -webkit-mask-image: linear-gradient(180deg, transparent 0, #000 26%, #000 74%, transparent 100%);
  mask-image: linear-gradient(180deg, transparent 0, #000 26%, #000 74%, transparent 100%);
}

.tp-col::-webkit-scrollbar {
  display: none;
}

/* 条目：等宽 + tabular-nums（编辑器气质）；满宽直角（圆角 4） */
.tp-item {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 32px; /* = ITEM_H（snap 步进单位），与 script 常量同步 */
  border: none;
  border-radius: 4px;
  background: none;
  color: var(--ink3);
  font-family: var(--mono);
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  cursor: pointer;
  scroll-snap-align: center;
  scroll-snap-stop: always;
  transition: color 100ms var(--ease), background-color 100ms var(--ease);
}

/* 悬停层：bg3 底提亮（选中反色行恒为最高态——规则在后覆盖 hover） */
.tp-item:hover {
  background: var(--bg3);
  color: var(--ink);
}

/* 选中行（方案二核心）：ink 实底反色——夜间白底黑字 / 日间黑底白字（VSCode 选区语系） */
.tp-item.is-on {
  background: var(--ink);
  color: var(--bg0);
  font-weight: 600;
}

.tp-colon {
  position: relative;
  z-index: 1;
  align-self: center;
  color: var(--ink2);
  font-family: var(--mono);
  font-size: 13px;
  font-weight: 600;
}
</style>
