<script setup lang="ts">
/**
 * 本机沙箱视图（prototype.html 迁移）：Box 卡列表 + caps 驱动按钮。
 * caps 纪律：快照按钮仅 caps.snapshot=true 渲染——永不出现「UI 有按钮但后端不支持」。
 * 诚实降级：P2 mock 后端无真实资源信号——不渲染 CPU/内存/磁盘仪表与终端接管（P3 真实后端接入）。
 */
import { computed, ref } from 'vue'
import { useKernelStore } from '../stores/kernel'
import { agentColor } from '../lib/agent-color'

const kernel = useKernelStore()

const stateChip = (state: 'active' | 'sleeping' | 'snapshot'): { cls: string; label: string } => {
  switch (state) {
    case 'active':
      return { cls: 'chip-accent', label: '运行中' }
    case 'sleeping':
      return { cls: '', label: '休眠' }
    case 'snapshot':
      return { cls: 'chip-success', label: '快照态' }
  }
}

const sum = computed(() => {
  const by = { active: 0, sleeping: 0, snapshot: 0 }
  for (const b of kernel.boxes) by[b.state] += 1
  return by
})

/** runId 的 agent 前缀（P1 约定 `${agentId}-run-N`；ConsoleView 同款推断） */
const agentOfRun = (runId?: string): string | null =>
  runId !== undefined && runId.includes('-run-') ? (runId.split('-run-')[0] ?? null) : null

/** 该 Box 最近完成的执行（倒序最多 3 条；进行中的以 started 兜底展示） */
const execsOf = (boxId: string) =>
  kernel.execs
    .filter((e) => e.boxId === boxId && (e.phase === 'finished' || e.exitCode === undefined))
    .slice(-3)
    .reverse()

// ---- 快照（caps 驱动的真实闭环：成功显示快照 id，失败就地提示） ----

const snapping = ref(new Set<string>())
const lastSnap = ref<Record<string, string>>({})
const snapError = ref<Record<string, string>>({})

const snapshot = async (boxId: string): Promise<void> => {
  if (snapping.value.has(boxId)) return
  snapping.value = new Set(snapping.value).add(boxId)
  delete snapError.value[boxId]
  try {
    lastSnap.value[boxId] = await kernel.snapshotBox(boxId)
  } catch (err) {
    snapError.value[boxId] = err instanceof Error ? err.message : String(err)
  } finally {
    const next = new Set(snapping.value)
    next.delete(boxId)
    snapping.value = next
  }
}
</script>

<template>
  <section class="view view-scroll">
    <div class="view-head">
      <div class="view-title">本机沙箱 · Box 群</div>
      <div class="view-sub">
        云电脑的本地替代：重活全部在本机 Box 内执行。按钮按后端能力声明（caps）渲染——后端不支持的操作永不出现。
      </div>
      <div v-if="kernel.caps" class="view-toolbar mono">
        <span>caps：</span>
        <span>快照 <b>{{ kernel.caps.snapshot ? '✓' : '✗' }}</b></span>
        <span>常驻 <b>{{ kernel.caps.persistent ? '✓' : '✗' }}</b></span>
        <span>无头 <b>{{ kernel.caps.headless ? '✓' : '✗' }}</b></span>
        <span>资源限额 <b>{{ kernel.caps.resourceLimits ? '✓' : '✗' }}</b></span>
        <span>隔离 <b>{{ kernel.caps.isolation }}</b></span>
      </div>
    </div>

    <div class="boxes">
      <div class="box-sum mono">
        <span>{{ kernel.boxes.length }} Box</span>
        <span>运行 {{ sum.active }}</span>
        <span>休眠 {{ sum.sleeping }}</span>
        <span>快照态 {{ sum.snapshot }}</span>
        <span class="box-sum-note">资源仪表与终端接管属 P3 真实后端（WSL2/Docker）接入项</span>
      </div>

      <div class="box-grid">
        <div v-for="box in kernel.boxes" :key="box.boxId" class="boxcard">
          <div class="box-head">
            <div class="box-ico" aria-hidden="true"></div>
            <div class="box-id">
              <div class="box-name mono">{{ box.boxId }}</div>
              <div class="box-sub">image={{ box.image }} · {{ box.state }}</div>
            </div>
            <span class="chip" :class="stateChip(box.state).cls">{{ stateChip(box.state).label }}</span>
            <div v-if="kernel.caps?.snapshot" class="box-actions">
              <button class="btn btn-secondary btn-sm" :disabled="snapping.has(box.boxId)" @click="snapshot(box.boxId)">
                {{ snapping.has(box.boxId) ? '快照中…' : '快照' }}
              </button>
            </div>
          </div>

          <div class="box-snaps mono">
            <span v-if="lastSnap[box.boxId]" class="chip chip-success">最近快照 {{ lastSnap[box.boxId] }}</span>
            <span v-if="snapError[box.boxId]" class="chip chip-danger">{{ snapError[box.boxId] }}</span>
          </div>

          <div v-if="execsOf(box.boxId).length" class="box-execs">
            <div class="box-execs-label">近期执行</div>
            <div v-for="e in execsOf(box.boxId)" :key="e.key" class="box-exec mono">
              <span class="stat-dot" :class="e.phase === 'finished' ? (e.exitCode === 0 ? 'ok' : 'err') : 'working'"></span>
              <span v-if="agentOfRun(e.runId)" class="box-exec-agent" :style="{ color: agentColor(agentOfRun(e.runId)!) }">
                {{ agentOfRun(e.runId) }}
              </span>
              <span class="box-exec-cmd">{{ e.command.join(' ') }}</span>
              <span v-if="e.phase === 'finished' && e.exitCode !== undefined" class="box-exec-exit">exit {{ e.exitCode }}</span>
            </div>
          </div>
        </div>
      </div>

      <p v-if="kernel.boxes.length === 0" class="placeholder">暂无 Box——注册 agent 时内核自动创建（mock 后端）</p>

      <div class="box-claim">
        Box 即本机云电脑。agent 在 Box 内自由执行；触碰宿主机文件或出网，经审批闸门逐条批准（对话流内 gate 卡）。
      </div>
    </div>
  </section>
</template>

<style scoped src="./boxes.css"></style>
