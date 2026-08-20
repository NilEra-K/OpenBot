<script setup lang="ts">
/**
 * Box 终端屏幕（ctx 预览与 Box 操作台共用的「一块显示器」）：
 * exec 流块按时间序拼成屏幕行——`$ 命令` + 输出（stderr 黄色），live 块尾部光标。
 * 纯显示部分：如实呈现 Box 内正在发生的内容；键鼠接管（PTY）与图形界面属后续版本。
 */
import { computed, nextTick, ref, watch } from 'vue'
import type { LiveStreamBlock } from '../stores/kernel'

const props = defineProps<{ blocks: LiveStreamBlock[] }>()

const termEl = ref<HTMLElement | null>(null)

/** 屏幕行（v-for 渲染单元：命令行 / 输出） */
interface ScreenLine {
  key: string
  kind: 'cmd' | 'out' | 'err'
  text: string
  live: boolean
}

const screenLines = computed<ScreenLine[]>(() => {
  const out: ScreenLine[] = []
  for (const block of props.blocks) {
    if (block.command) {
      out.push({ key: `${block.key}-c`, kind: 'cmd', text: `$ ${block.command.join(' ')}`, live: false })
    }
    if (block.stdout !== '') {
      out.push({ key: `${block.key}-o`, kind: 'out', text: block.stdout, live: block.state === 'live' })
    }
    if (block.stderr !== '') {
      out.push({ key: `${block.key}-e`, kind: 'err', text: block.stderr, live: block.state === 'live' })
    }
    if (block.state === 'abort') {
      out.push({ key: `${block.key}-a`, kind: 'err', text: `✗ 已中止：${block.abortReason ?? ''}`, live: false })
    }
  }
  return out
})

/** 增量到达：贴底跟随（看实况的眼睛在最新一行） */
watch(
  () => props.blocks.map((b) => `${b.key}:${b.stdout.length}:${b.stderr.length}:${b.state}`).join('|'),
  () => {
    void nextTick(() => {
      if (termEl.value) termEl.value.scrollTop = termEl.value.scrollHeight
    })
  },
)
</script>

<template>
  <div ref="termEl" class="box-term">
    <template v-if="screenLines.length > 0">
      <div v-for="line in screenLines" :key="line.key" class="bt-line" :class="`bt-${line.kind}`">
        <span v-if="line.kind === 'cmd'" class="t-acc">{{ line.text }}</span>
        <span v-else-if="line.kind === 'err'" class="t-bar">{{ line.text }}</span>
        <template v-else>{{ line.text }}</template>
        <span v-if="line.live" class="caret"></span>
      </div>
    </template>
    <div v-else class="bt-line bt-dim">屏幕空闲——无正在进行的命令</div>
  </div>
</template>

<style scoped src="../views/boxops.css"></style>
