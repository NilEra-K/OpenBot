<script setup lang="ts">
/**
 * Box 操作台（prototype.html boxops 迁移）：VMware 控制台式大屏——同一块显示器的放大视图。
 * bo-bar：返回 / 标题 / 实况 chip / 快照（caps 驱动）；bo-screen：Box 终端实况大屏。
 * 一期为合格的显示部分：如实呈现 Box 内内容；键鼠接管（PTY）与图形界面画面属后续版本（诚实标注）。
 */
import { computed, ref } from 'vue'
import { useKernelStore } from '../stores/kernel'
import { useUiStore } from '../stores/ui'
import BoxScreen from './BoxScreen.vue'

const kernel = useKernelStore()
const ui = useUiStore()

const boxId = computed(() => ui.boxOps)

/** 该 Box 的屏幕内容（按 Box 过滤——操作台的归属单位是 Box 而非 agent） */
const screenBlocks = computed(() =>
  boxId.value === null ? [] : kernel.streams.filter((s) => s.boxId === boxId.value).slice(-30),
)

const live = computed(() => screenBlocks.value.some((b) => b.state === 'live'))
const canSnapshot = computed(() => kernel.caps?.snapshot === true)
const snapshotNote = ref<string | null>(null)
const snapshotting = ref(false)

const snapshot = async (): Promise<void> => {
  if (boxId.value === null || snapshotting.value) return
  snapshotting.value = true
  snapshotNote.value = null
  try {
    const snapshotId = await kernel.snapshotBox(boxId.value)
    snapshotNote.value = `已创建快照 ${snapshotId}`
  } catch (err) {
    snapshotNote.value = `快照失败：${err instanceof Error ? err.message : String(err)}`
  } finally {
    snapshotting.value = false
  }
}
</script>

<template>
  <div v-if="boxId !== null" class="boxops" role="dialog" aria-label="Box 操作台">
    <div class="bo-bar">
      <button class="btn-ghost bo-back" title="返回" aria-label="返回" @click="ui.closeBoxOps()">←</button>
      <span class="bo-title mono">{{ boxId }}</span>
      <span class="chip"><span class="stat-dot" :class="{ working: live }"></span>{{ live ? '屏幕实况中' : '屏幕空闲' }}</span>
      <span class="bo-meta mono">终端画面 · 显示部分</span>
      <div class="bo-actions">
        <span v-if="snapshotNote" class="bo-meta">{{ snapshotNote }}</span>
        <button v-if="canSnapshot" class="btn-ghost" :disabled="snapshotting" @click="snapshot">
          {{ snapshotting ? '快照中…' : '创建快照' }}
        </button>
      </div>
    </div>
    <div class="bo-screen">
      <BoxScreen :blocks="screenBlocks" />
    </div>
    <div class="bo-hint">
      实况显示——Box 内命令与输出直接呈现，不出本机；键盘接管（PTY 终端）与图形界面画面属后续版本
    </div>
  </div>
</template>

<style scoped src="../views/boxops-overlay.css"></style>
