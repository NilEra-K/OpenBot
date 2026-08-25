<script setup lang="ts">
/**
 * Box 操作台（prototype.html boxops 迁移）：VMware 控制台式大屏——同一块显示器的放大视图。
 * bo-bar：返回 / 标题 / 实况 chip / 快照（caps 驱动）；bo-screen：caps.interactive 时是
 * PTY 交互终端（键鼠直送 Box 内 bash），否则退回实况行视图（诚实降级，永不放假终端）。
 * 打开即起会话、关闭即杀（不留后台 shell）。
 */
import { computed, ref } from 'vue'
import { useKernelStore } from '../stores/kernel'
import { useUiStore } from '../stores/ui'
import BoxScreen from './BoxScreen.vue'
import BoxTerm from './BoxTerm.vue'

const kernel = useKernelStore()
const ui = useUiStore()

const boxId = computed(() => ui.boxOps)

/** 该 Box 的屏幕内容（按 Box 过滤——操作台的归属单位是 Box 而非 agent；交互终端模式的对照降级视图） */
const screenBlocks = computed(() =>
  boxId.value === null ? [] : kernel.streams.filter((s) => s.boxId === boxId.value).slice(-30),
)

const live = computed(() => screenBlocks.value.some((b) => b.state === 'live'))
/** 交互终端（PTY）：caps 驱动——按钮/入口永不背离后端能力 */
const canInteract = computed(() => kernel.caps?.interactive === true)
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
      <!-- 返回=裸图标按钮（bo-back 自带 hover 底色；不挂 btn-ghost——其边框声明在后会压掉 border:none） -->
      <button class="bo-back" title="返回" aria-label="返回" @click="ui.closeBoxOps()">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.5 5.5L8 12l6.5 6.5"/></svg>
      </button>
      <span class="bo-title mono">{{ boxId }}</span>
      <span v-if="canInteract" class="chip"><span class="stat-dot working"></span>交互终端</span>
      <span v-else class="chip"><span class="stat-dot" :class="{ working: live }"></span>{{ live ? '屏幕实况中' : '屏幕空闲' }}</span>
      <span class="bo-meta mono">{{ canInteract ? '终端远程控制 · PTY' : '终端画面 · 显示部分' }}</span>
      <div class="bo-actions">
        <span v-if="snapshotNote" class="bo-meta">{{ snapshotNote }}</span>
        <button v-if="canSnapshot" class="btn-ghost" :disabled="snapshotting" @click="snapshot">
          {{ snapshotting ? '快照中…' : '创建快照' }}
        </button>
      </div>
    </div>
    <div class="bo-screen">
      <BoxTerm v-if="canInteract && boxId !== null" :key="boxId" :box-id="boxId" />
      <BoxScreen v-else :blocks="screenBlocks" />
    </div>
    <div class="bo-hint">
      <span class="stat-dot working"></span>
      <template v-if="canInteract">
        终端远程控制——键盘直送 Box 内 bash（vim/top 可用，Ctrl+C 同真终端）；终端尺寸固定 100×30（不随窗口变，需改尺寸可 shell 内 stty）
      </template>
      <template v-else>
        实况显示——Box 内命令与输出直接呈现，不出本机；键盘接管（PTY 终端）与图形界面画面属后续版本
      </template>
    </div>
  </div>
</template>

<style scoped src="../views/boxops-overlay.css"></style>
