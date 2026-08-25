<script setup lang="ts">
/**
 * ctx 面板（prototype.html 迁移，语义：Box 的显示器——VMware 操作区的本地替身）：
 * 一块屏幕——当前会话 agent 的专属 Box（roster 事实，注册即有——任意时刻可点开操作台；
 * 屏幕内容是 exec 流实况，无执行史时诚实显示 IDLE 空缺态；思考过程在对话流内呈现，
 * llm 是 agent 进程不在 Box 内，不冒充屏幕内容——诚实分层）。
 * 底部「cs-hint 提示条」：接管的去向提示（caps 分流文案——interactive 才承诺键盘接管）。
 * 档案模式（P4 Step 7，原型 ctxMode='settings'）：该会话的 Settings——档案 kv / 协作对象（edges 事实，
 * 点击跳会话）/ 记忆与自动化如实空缺态（数据源属后续版本，不放假条目）。
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

/** 当前 Box 休眠中（P4 Step 8）：屏幕灰化 + 提示（v1.box.state 事件同源——与 Box 卡 chip 一致） */
const boxAsleep = computed(
  () => screenBoxId.value !== null && kernel.boxes.find((b) => b.boxId === screenBoxId.value)?.state === 'sleeping',
)

const openOps = (): void => {
  if (screenBoxId.value) ui.openBoxOps(screenBoxId.value)
}

// ---- 档案模式（P4 Step 7）：全部为既有 store 投影，零内核改动（approvalMode 除外——boot 快照） ----

const activeAgent = computed(() => kernel.roster.find((a) => a.agentId === ui.activeAgentId) ?? null)
const displayName = computed(() => activeAgent.value?.name ?? ui.activeAgentId)
const initialOf = computed(() => displayName.value.trim().charAt(0) || '?')

/** 协作对象：edges 里与该 agent 相连的 agent↔agent 边（user 端不属协作叙事），按 count 聚合 */
const collabs = computed(() => {
  const counts = new Map<string, number>()
  for (const e of kernel.edges) {
    const peer = e.from === ui.activeAgentId ? e.to : e.to === ui.activeAgentId ? e.from : null
    if (peer === null || peer === 'user' || peer === ui.activeAgentId) continue
    counts.set(peer, (counts.get(peer) ?? 0) + e.count)
  }
  return [...counts.entries()]
    .map(([peer, count]) => ({ peer, count }))
    .sort((a, b) => b.count - a.count)
})

const nameOf = (agentId: string): string => kernel.roster.find((a) => a.agentId === agentId)?.name ?? agentId

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
  <aside class="ctx" :aria-label="ui.ctxSettings ? '会话档案' : 'Box 实况屏幕'">
    <!-- 档案模式（P4 Step 7）：返回顶栏 + 档案 kv + 协作对象 + 如实空缺态 -->
    <template v-if="ui.ctxSettings">
      <div class="ctx-top">
        <button class="ctx-back" type="button" title="返回执行画面" aria-label="返回执行画面" @click="ui.ctxSettings = false">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.5 6L8.5 12l6 6"/></svg>
        </button>
        <span class="ctx-top-title">Settings</span>
        <span class="ctx-top-sub">{{ displayName }}</span>
      </div>

      <div class="ctx-head">
        <div class="avatar" :style="{ background: kernel.colorOf(ui.activeAgentId) }">{{ initialOf }}</div>
        <div class="ctx-head-text">
          <div class="ctx-name">{{ displayName }}</div>
          <div class="ctx-sub">{{ activeAgent?.role === 'steward' ? '管家 · 默认对话者' : 'worker' }}</div>
        </div>
      </div>

      <div class="ctx-sec">档案</div>
      <div class="kv"><span class="k">角色</span><span class="v">{{ activeAgent?.role === 'steward' ? '管家（steward）' : '工人（worker）' }}</span></div>
      <div class="kv"><span class="k">模型</span><span class="v">继承全局主力{{ kernel.defaultProvider ? `（${kernel.defaultProvider}）` : '' }}<span class="kv-note">per-agent 覆盖属后续版本</span></span></div>
      <div class="kv"><span class="k">Box 归属</span><span class="v mono">{{ screenBoxId ?? '—' }}</span></div>
      <div class="kv"><span class="k">权限现状</span><span class="v">{{ kernel.approvalMode === 'manual' ? 'Box 内自由 · 出 Box 需批准（Manual 闸门）' : '自动批准' }}</span></div>

      <div class="ctx-sec">协作对象</div>
      <button
        v-for="c in collabs"
        :key="c.peer"
        class="edge-row"
        type="button"
        :title="`跳到 ${nameOf(c.peer)} 的会话`"
        @click="ui.activeAgentId = c.peer"
      >
        <span class="stat-dot" :style="{ background: kernel.colorOf(c.peer) }"></span>
        <span class="er-name">{{ nameOf(c.peer) }}</span>
        <span class="cnt">×{{ c.count }}</span>
      </button>
      <div v-if="collabs.length === 0" class="mem-empty">暂无协作记录——A2A 往来后在此呈现</div>

      <div class="ctx-sec">记忆</div>
      <div class="mem-empty">记忆数据源属后续版本——内核尚无 memory 事实，不放占位条目</div>

      <div class="ctx-sec">自动化</div>
      <div class="mem-empty">自动化属后续版本（P5+ backlog）——无数据源，不放占位条目</div>
    </template>

    <!-- 屏幕模式：一块显示器（Box 终端实况，点击进入操作台大屏） -->
    <div
      v-else
      class="ctx-screen"
      :class="{ 'is-static': !screenBoxId, 'is-asleep': boxAsleep }"
      :role="screenBoxId ? 'button' : undefined"
      :tabindex="screenBoxId ? 0 : undefined"
      :aria-label="screenBoxId ? `进入 ${screenBoxId} 操作台` : undefined"
      @click="openOps"
      @keydown.enter.prevent="openOps"
    >
      <div class="cs-bar">
        <span class="cs-live" :class="{ asleep: !liveExec }">
          <span v-if="liveExec" class="stat-dot working"></span>
          {{ liveExec ? 'LIVE' : boxAsleep ? '休眠中' : screenBlocks.length > 0 ? '空闲' : 'IDLE' }}
        </span>
        <span class="mono">{{ screenBoxId ?? 'no box' }}</span>
        <span class="mono">{{ lastAt }}</span>
      </div>
      <div class="cs-term">
        <BoxScreen v-if="screenBlocks.length > 0" :blocks="screenBlocks" />
        <div v-else-if="boxAsleep" class="ctx-idle">Box 休眠中——rootfs 在磁盘，随时可唤醒（派活自动拉起）</div>
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
