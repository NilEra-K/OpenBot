<script setup lang="ts">
/**
 * ctx 面板（prototype.html 迁移，语义：Box 的显示器——VMware 操作区的本地替身）：
 * - 主体「一块屏幕」：当前会话 agent 的 Box 终端实况（exec 流拼成屏幕行；点击进入 Box 操作台大屏）
 * - 顶部「思考条」：agent 的 llm 增量——llm 是 agent 进程不在 Box 内，不冒充屏幕内容（诚实分层）
 * - 无活动：IDLE 状态屏（诚实空缺态，不放假画面）
 * 键鼠接管（PTY）与图形界面画面属后续版本（plan-p3 补记）。
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

/** 思考条：最新 llm 块的文本尾部 */
const thought = computed(() => {
  const llm = [...mine.value].reverse().find((s) => s.stream === 'llm' && s.stdout !== '')
  if (!llm) return null
  const text = llm.stdout
  return { text: text.length > 160 ? `…${text.slice(-160)}` : text, live: llm.state === 'live' }
})

const liveExec = computed(() => screenBlocks.value.some((b) => b.state === 'live'))

/** 屏幕 bar 的 Box 标识（最近 exec 所属 Box；无执行史时未知） */
const screenBoxId = computed(() => [...screenBlocks.value].reverse().find((b) => b.boxId)?.boxId ?? null)

const openOps = (): void => {
  // 一期：有 Box 归属才可开操作台（无 exec 史时无 Box 可指）
  if (screenBoxId.value) ui.openBoxOps(screenBoxId.value)
}

const fmtTime = (at: number): string =>
  new Date(at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
const lastAt = computed(() => {
  const last = screenBlocks.value.at(-1)
  return last ? fmtTime(last.at) : ''
})
</script>

<template>
  <aside class="ctx" aria-label="Box 实况屏幕">
    <!-- 思考条：agent 的 llm 增量（不在 Box 内，独立于屏幕呈现） -->
    <div v-if="thought" class="think" :class="{ 'is-live': thought.live }" :title="thought.text">
      <span class="think-label">{{ thought.live ? '思考中' : '最后想法' }}</span>
      <span class="think-text mono">{{ thought.text }}</span>
    </div>

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
      <div class="cs-screen-body">
        <BoxScreen v-if="screenBlocks.length > 0" :blocks="screenBlocks" />
        <div v-else class="ctx-idle">等待任务派发——agent 在 Box 内执行命令时，这里实时显示屏幕输出</div>
      </div>
    </div>
  </aside>
</template>

<style scoped src="../views/ctx.css"></style>
