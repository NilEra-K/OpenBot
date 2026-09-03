<script setup lang="ts">
/**
 * GuiScreen（plan-computer-use Step 6）：Box 桌面的旁观/接管视图。
 * 帧源 = 低频轮询兜底（v1.box.gui.frame，agent 空闲时画面也能动；agent 动作时的帧由
 * 工具回喂截图天然刷新——旁观即 agent 视角）。用户点击/键入 = 首笔即接管（内核挂起 agent
 * 下一个 computer 动作）；「交还 agent」放行。注入与 agent 走同一条 xdotool 通路。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useKernelStore } from '../stores/kernel'

const props = defineProps<{ boxId: string }>()
const kernel = useKernelStore()

const frameSrc = ref<string | null>(null)
const frameError = ref<string | null>(null)
const takeover = ref(false)
let timer: ReturnType<typeof setInterval> | null = null

const guiClick = (e: MouseEvent): void => {
  const target = e.currentTarget as HTMLElement
  const img = target.querySelector('img')
  if (img === null) return
  // 帧内坐标换算（显示尺寸 → 实际截图分辨率——注入按截图坐标系）
  const scale = img.naturalWidth / img.clientWidth
  const x = Math.round((e.offsetX ?? 0) * scale)
  const y = Math.round((e.offsetY ?? 0) * scale)
  void kernel.call('v1.box.gui.input', { boxId: props.boxId, script: `xdotool mousemove ${x} ${y} click 1` })
    .then(() => { takeover.value = true }) // 首笔即接管（内核侧同判定——本地态即时呈现）
    .catch(() => {})
}

const release = (): void => {
  void kernel.call('v1.box.gui.release').then(() => (takeover.value = false))
}

const onKey = (e: KeyboardEvent): void => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
  const map: Record<string, string> = {
    Enter: 'Return', Backspace: 'BackSpace', Tab: 'Tab', Escape: 'Escape',
    ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', ' ': 'space',
  }
  if (e.key.length === 1) {
    const ch = e.key === "'" ? "'\\''" : e.key
    void kernel.call('v1.box.gui.input', { boxId: props.boxId, script: `xdotool type -- '${ch}'` }).catch(() => {})
    takeover.value = true
    e.preventDefault()
  } else if (map[e.key] !== undefined) {
    void kernel.call('v1.box.gui.input', { boxId: props.boxId, script: `xdotool key ${map[e.key]}` }).catch(() => {})
    takeover.value = true
    e.preventDefault()
  }
}

const pull = (): void => {
  void kernel
    .call<{ image: { base64: string; mime: string } | null; reason?: string }>('v1.box.gui.frame', { boxId: props.boxId })
    .then((r) => {
      if (r.image !== null) {
        frameSrc.value = `data:${r.image.mime};base64,${r.image.base64}`
        frameError.value = null
      } else {
        frameError.value = r.reason ?? '截图不可用'
      }
    })
    .catch((err: unknown) => (frameError.value = err instanceof Error ? err.message : String(err)))
}

onMounted(() => {
  pull()
  timer = setInterval(pull, 1_500)
  window.addEventListener('keydown', onKey)
})
onBeforeUnmount(() => {
  if (timer !== null) clearInterval(timer)
  window.removeEventListener('keydown', onKey)
})
</script>

<template>
  <div class="gui-screen">
    <div class="gui-viewport" @click.stop="guiClick">
      <!-- .stop：视口点击即接管，不得冒泡到 ctx-screen 的 openOps（打开操作台会遮住本视图） -->
      <img v-if="frameSrc !== null" :src="frameSrc" alt="Box 桌面实况" draggable="false" />
      <div v-else-if="frameError !== null" class="gui-idle">截图不可用：{{ frameError }}<br />（GUI 容器未起或 scrot 不在场）</div>
      <div v-else class="gui-idle">拉取桌面画面…</div>
    </div>
    <div class="gui-bar">
      <span class="gui-state" :class="{ 'is-takeover': takeover }">
        {{ takeover ? '你已接管——agent 动作挂起' : '旁观中（agent 视角）' }}
      </span>
      <button v-if="takeover" class="btn btn-secondary btn-sm" @click="release">交还 agent</button>
      <span class="gui-tip">点击/键入即接管；登录等人工操作完成后点「交还 agent」继续</span>
    </div>
  </div>
</template>

<style scoped>
.gui-screen {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.gui-viewport {
  flex: 1;
  min-height: 0;
  display: grid;
  place-items: center;
  overflow: hidden;
  background: #080a0b;
  cursor: crosshair;
}

.gui-viewport img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  user-select: none;
}

.gui-idle {
  color: #8a938e;
  font-size: 10.5px;
  line-height: 1.8;
  padding: 8px 12px;
  text-align: center;
  white-space: pre-line;
}

.gui-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 5px 9px;
  font-size: 10px;
  background: rgba(26, 24, 21, 0.85);
  border-top: 1px solid rgba(255, 255, 255, 0.05);
  color: var(--ink3);
  flex: none;
}

.gui-state {
  flex: none;
}

.gui-state.is-takeover {
  color: var(--accent);
}

.gui-tip {
  margin-left: auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ---- btn 家族副本（模板 .btn/.btn-secondary/.btn-sm 此前无定义——裸按钮）。
   gui-bar 恒深底（rgba(26,24,21,.85) 不随主题翻转）——配色定死深色方案（同 .gui-idle #8a938e 先例）；
   不取 --bg2/--ink/--accent：日间主题下会翻成浅色系与深 bar 割裂 ---- */
.btn {
  display: inline-flex;
  align-items: center;
  border: 1px solid rgba(255, 255, 255, 0.16);
  background: rgba(255, 255, 255, 0.06);
  color: #eaeaea;
  border-radius: 7px;
  cursor: pointer;
  font-size: 12.5px;
  transition: background 140ms var(--ease), border-color 140ms var(--ease);
}

.btn:hover {
  background: rgba(255, 255, 255, 0.12);
}

.btn:disabled {
  opacity: 0.5;
  cursor: default;
}

.btn-sm {
  height: 26px;
  padding: 0 12px;
}

.btn-secondary {
  border-color: rgba(238, 177, 84, 0.4);
  background: rgba(238, 177, 84, 0.08);
  color: #eeb154;
}

.btn-secondary:hover {
  background: rgba(238, 177, 84, 0.16);
  border-color: rgba(238, 177, 84, 0.6);
}
</style>
