<script setup lang="ts">
/**
 * 排程视图（prototype.html 迁移）：三 lane 队列——user（永远最先）/ agent / background。
 * 数据源：v1.lifecycle.* 事件累积（RunCard）；状态永远诚实（含 escaped/reaped）。
 */
import { computed, ref, watch } from 'vue'
import { useKernelStore } from '../stores/kernel'
import type { RunCard } from '../stores/kernel'
import { agentColor } from '../lib/agent-color'

const kernel = useKernelStore()

const LANES: Array<{ lane: RunCard['lane']; label: string; note: string }> = [
  { lane: 'user', label: '用户 lane', note: '你的消息，永远插到最前' },
  { lane: 'agent', label: 'agent lane', note: 'agent 间 A2A 与轮转' },
  { lane: 'background', label: '后台 lane', note: '定时任务 · 派生 subagent' },
]

const byLane = (lane: RunCard['lane']): RunCard[] =>
  kernel.runs.filter((r) => r.lane === lane).sort((a, b) => b.updatedAt - a.updatedAt)

const stateChip = (run: RunCard): { cls: string; label: string } => {
  switch (run.state) {
    case 'queued':
      return { cls: '', label: '排队中' }
    case 'running':
      return { cls: 'chip-accent', label: '运行中' }
    case 'succeeded':
      return { cls: 'chip-success', label: '完成' }
    case 'escaped':
      return { cls: 'chip-danger', label: '已逃逸 · zombie' }
    case 'reaped':
      return { cls: 'chip-danger', label: '已回收' }
    default:
      return { cls: 'chip-danger', label: run.state === 'failed' ? `失败${run.code ? ' · ' + run.code : ''}` : '已中止' }
  }
}

const fmtDur = (ms: number): string => {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`
  return `${Math.floor(ms / 3_600_000)}h+`
}

const fmtTime = (at: number): string =>
  new Date(at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })

/** 正在中止的 runId 集合（点击即置的本地反馈态；run 离开 queued/running 自动清——事实归事件流） */
const cancelling = ref(new Set<string>())

/** 中止 run（原型 task-foot 的 abort 位）：排队中直接结算，活跃中经 AbortSignal 传播 */
const cancelRun = (run: RunCard): void => {
  if (cancelling.value.has(run.runId)) return
  cancelling.value = new Set(cancelling.value).add(run.runId)
  void kernel.cancelRun(run.agentId, run.runId).catch(() => {})
}
watch(
  () => kernel.runs.map((r) => `${r.runId}:${r.state}`).join('|'),
  () => {
    const live = new Set(
      kernel.runs.filter((r) => r.state === 'queued' || r.state === 'running').map((r) => r.runId),
    )
    cancelling.value = new Set([...cancelling.value].filter((id) => live.has(id)))
  },
)

/** 今日 run（本地 0 点起；无数据的指标藏起来——诚实降级，不造 mock 数字） */
const todayRuns = computed(() => {
  const dayStart = new Date()
  dayStart.setHours(0, 0, 0, 0)
  return kernel.runs.filter((r) => r.at >= dayStart.getTime())
})

/** 已终结 run（succeeded/failed）才有时长可平均 */
const avgMs = computed(() => {
  const done = todayRuns.value.filter((r) => r.state === 'succeeded' || r.state === 'failed')
  if (done.length === 0) return null
  return done.reduce((s, r) => s + (r.updatedAt - r.at), 0) / done.length
})

const successRate = computed(() => {
  const done = todayRuns.value.filter((r) => r.state === 'succeeded' || r.state === 'failed')
  if (done.length === 0) return null
  return Math.round((done.filter((r) => r.state === 'succeeded').length / done.length) * 100)
})
</script>

<template>
  <section class="view view-scroll">
    <div class="view-head">
      <div class="view-title">排程监控</div>
      <div class="view-sub">每个 agent 一个排他队列：同一时刻只有一个活跃 turn；用户消息永远最先。watchdog 将卡死的 run 逃逸为 zombie，发送永不悬挂。</div>
      <div class="view-toolbar mono">
        <span>今日 <b>{{ todayRuns.length }}</b> runs</span>
        <span aria-hidden="true">·</span>
        <span v-if="avgMs !== null">平均 <b>{{ fmtDur(avgMs) }}</b></span>
        <span v-if="avgMs !== null" aria-hidden="true">·</span>
        <span v-if="successRate !== null">成功率 <b>{{ successRate }}%</b></span>
        <span v-if="successRate !== null" aria-hidden="true">·</span>
        <span>队列中 <b>{{ kernel.runs.filter((r) => r.state === 'queued').length }}</b></span>
      </div>
    </div>
    <div class="lanes">
      <div v-for="l in LANES" :key="l.lane">
        <div class="lane-head">
          <span class="stat-dot" :class="l.lane === 'user' ? 'accent' : l.lane === 'agent' ? 'working' : 'idle'"></span>
          {{ l.label }}<span class="lane-count">{{ byLane(l.lane).length }}</span>
        </div>
        <div class="lane-note">{{ l.note }}</div>
        <div v-for="run in byLane(l.lane)" :key="run.runId" class="run" :class="{ 'is-active': run.state === 'running', 'is-done': run.state === 'succeeded', 'is-zombie': run.state === 'escaped' || run.state === 'reaped' }">
          <div class="run-top">
            <span class="stat-dot" :style="{ background: agentColor(run.agentId) }"></span>
            <span class="run-agent">{{ run.agentId }}</span>
            <span class="chip" :class="stateChip(run).cls">{{ stateChip(run).label }}</span>
            <button
              v-if="run.state === 'queued' || run.state === 'running'"
              class="run-stop"
              :disabled="cancelling.has(run.runId)"
              :title="`中止 run ${run.runId}`"
              @click="cancelRun(run)"
            >
              {{ cancelling.has(run.runId) ? '正在中止…' : '中止' }}
            </button>
          </div>
          <div class="run-what mono">{{ run.summary ?? run.runId }}</div>
          <div class="run-meta mono">
            <span v-if="run.summary">{{ run.runId }}</span>
            <span>lane={{ run.lane }}</span>
            <span>{{ run.kind }}</span>
            <span v-if="run.attempts > 1">重试 {{ run.attempts }} 次</span>
            <span>{{ fmtTime(run.updatedAt) }} · {{ fmtDur(run.updatedAt - run.at) }}</span>
          </div>
          <div v-if="run.state === 'running'" class="run-progress"><i></i></div>
        </div>
      </div>
    </div>
    <p v-if="kernel.runs.length === 0" class="placeholder">暂无 run——在控制台发一条消息试试</p>
  </section>
</template>

<style scoped src="./tasks.css"></style>
