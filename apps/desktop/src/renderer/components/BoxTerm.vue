<script setup lang="ts">
/**
 * Box 交互终端（PTY 远程控制，plan-p3 Step 10）：xterm.js 渲染 + 键入经命令面直写 Box 内真 bash。
 * 生命周期与操作台同进出：挂载起会话、卸载杀会话（不留后台 shell）。
 * 竞态解法：pty 事件按 boxId 过滤（非 shellId）——WS 事件可能先于 shellOpen 的 HTTP 响应到达，
 * 先订阅后 open，开场提示符不丢；同 Box 同一时刻只有一个终端实例，boxId 即唯一归属。
 * 一期固定尺寸 100×30：管道方案无 TIOCSWINSZ，不跟窗口 resize（bo-hint 诚实标注）。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { useKernelStore } from '../stores/kernel'

const props = defineProps<{ boxId: string }>()

const kernel = useKernelStore()
const hostEl = ref<HTMLElement | null>(null)
const note = ref<string | null>(null)

let term: Terminal | null = null
let shellId: string | null = null
let offPty: (() => void) | null = null

onMounted(() => {
  term = new Terminal({
    cols: 100,
    rows: 30,
    fontFamily: "'Cascadia Code', Consolas, ui-monospace, monospace",
    fontSize: 13,
    cursorBlink: true,
    theme: {
      background: '#080a0b',
      foreground: '#c7cfcb',
      cursor: '#9fb3ac',
      selectionBackground: '#3a4048',
    },
  })
  term.open(hostEl.value!)
  // 输出：pty 流 → term.write（按 boxId 过滤——见文件头竞态说明）
  offPty = kernel.onPtyEvent((ev) => {
    if (ev.boxId !== props.boxId) return
    if (ev.type === 'data') {
      term?.write(ev.text ?? '')
    } else if (ev.type === 'end') {
      term?.write('\r\n\x1b[33m[会话已结束——关闭操作台再打开可开新会话]\x1b[0m\r\n')
      note.value = '会话已结束'
    }
  })
  // 键入：term.onData → 命令面（每键几字节，环回 HTTP 无感）
  term.onData((data) => {
    if (shellId !== null) {
      void kernel.shellWrite(shellId, data).catch(() => {
        term?.write('\r\n\x1b[31m[键入失败——会话可能已断开]\x1b[0m\r\n')
      })
    }
  })
  // 起会话（失败如实呈现——SHELL_UNSUPPORTED 等）
  kernel
    .shellOpen(props.boxId, { cols: 100, rows: 30 })
    .then((id) => {
      shellId = id
      term?.focus()
    })
    .catch((err: unknown) => {
      term?.write(`\x1b[31m无法打开终端：${err instanceof Error ? err.message : String(err)}\x1b[0m\r\n`)
      note.value = '打开失败'
    })
})

onBeforeUnmount(() => {
  offPty?.()
  if (shellId !== null) void kernel.shellClose(shellId) // 关操作台即杀会话
  term?.dispose()
  term = null
})
</script>

<template>
  <div class="bterm" :aria-label="`${boxId} 交互终端`">
    <div ref="hostEl" class="bterm-host"></div>
  </div>
</template>

<style scoped src="../views/boxterm.css"></style>
