<script setup lang="ts">
/**
 * ctx 面板（prototype.html 迁移，语义：Box 的显示器——VMware 操作区的本地替身）：
 * 一块屏幕——当前会话 agent 的专属 Box（roster 事实，注册即有——任意时刻可点开操作台；
 * 屏幕内容是 exec 流实况，无执行史时诚实显示 IDLE 空缺态；思考过程在对话流内呈现，
 * llm 是 agent 进程不在 Box 内，不冒充屏幕内容——诚实分层）。
 * 底部「cs-hint 提示条」：接管的去向提示（caps 分流文案——interactive 才承诺键盘接管）。
 * 图形界面画面（GUI 像素流）属后续版本（plan-p3 补记）。
 */
import { computed } from 'vue'
import { useKernelStore } from '../stores/kernel'
import { useUiStore } from '../stores/ui'
import BoxScreen from './BoxScreen.vue'

const kernel = useKernelStore()
const ui = useUiStore()

/** 当前会话 agent 的流块 */
const mine = computed(() => kernel.streams.filter((s) => s.agentId === ui.activeAgentId))

/** 屏幕：exec 块按时间序（取最近 6 条，屏幕缓冲有限） */
const screenBlocks = computed(() => mine.value.filter((s) => s.stream === 'exec').slice(-6))

const liveExec = computed(() => screenBlocks.value.some((b) => b.state === 'live'))

/**
 * 屏幕 bar 的 Box 标识：当前会话 agent 的专属 Box（roster 事实——注册即创建，与原型 AGENT_BOX
 * 静态映射同语义）。exec 史只决定屏幕显示内容，不决定可点性——任意时刻可接管。
 */
const screenBoxId = computed(
  () => kernel.roster.find((a) => a.agentId === ui.activeAgentId)?.boxId ?? null,
)

const openOps = (): void => {
  if (screenBoxId.value) ui.openBoxOps(screenBoxId.value)
}

/** cs-hint 图标（prototype ICONS.terminal 同源 SVG path） */
const TERMINAL_ICON =
  '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 9l3 3-3 3M13 15h4"/>'

const fmtTime = (at: number): string =>
  new Date(at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
const lastAt = computed(() => {
  const last = screenBlocks.value.at(-1)
  return last ? fmtTime(last.at) : ''
})
</script>

<template>
  <aside class="ctx" aria-label="Box 实况屏幕">
    <!-- 一块显示器：Box 终端实况（点击进入操作台大屏） -->
    <div
      class="ctx-screen"
      :class="{ 'is-static': !screenBoxId }"
      :role="screenBoxId ? 'button' : undefined"
      :tabindex="screenBoxId ? 0 : undefined"
      :aria-label="screenBoxId ? `进入 ${screenBoxId} 操作台` : undefined"
      @click="openOps"
      @keydown.enter.prevent="openOps"
    >
      <div class="cs-bar">
        <span class="cs-live" :class="{ asleep: !liveExec }">
          <span v-if="liveExec" class="stat-dot working"></span>
          {{ liveExec ? 'LIVE' : screenBlocks.length > 0 ? '空闲' : 'IDLE' }}
        </span>
        <span class="mono">{{ screenBoxId ?? 'no box' }}</span>
        <span class="mono">{{ lastAt }}</span>
      </div>
      <div class="cs-term">
        <BoxScreen v-if="screenBlocks.length > 0" :blocks="screenBlocks" />
        <div v-else class="ctx-idle">等待任务派发——agent 在 Box 内执行命令时，这里实时显示屏幕输出</div>
      </div>
      <!-- 屏幕底部提示条（原型 .cs-hint）：caps 分流文案——不放假承诺 -->
      <div v-if="screenBoxId" class="cs-hint">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" v-html="TERMINAL_ICON"></svg>
        <span>{{ kernel.caps?.interactive ? '点击进入 Box 操作台 · 键盘直接接管' : '点击进入 Box 操作台 · 查看实况' }}</span>
      </div>
    </div>
  </aside>
</template>

<style scoped src="../views/ctx.css"></style>
