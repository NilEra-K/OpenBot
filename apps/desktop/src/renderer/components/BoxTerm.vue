<script setup lang="ts">
/**
 * Box 交互终端（PTY 远程控制，plan-p3 Step 10）：xterm.js 渲染 + 键入经命令面直写 Box 内真 bash。
 * 生命周期与操作台同进出：挂载起会话、卸载杀会话（不留后台 shell）。
 * 竞态解法：pty 事件按 boxId 过滤（非 shellId）——WS 事件可能先于 shellOpen 的 HTTP 响应到达，
 * 先订阅后 open，开场提示符不丢；同 Box 同一时刻只有一个终端实例，boxId 即唯一归属。
 * 尺寸：开场按 host 实测定 cols/rows（会话中不变——管道方案无 TIOCSWINSZ，不跟窗口 resize；
 * 需改尺寸可 shell 内 stty 或重开操作台，bo-hint 诚实标注）。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { useKernelStore } from '../stores/kernel'

const props = defineProps<{ boxId: string }>()

const kernel = useKernelStore()
const hostEl = ref<HTMLElement | null>(null)
const note = ref<string | null>(null)

/**
 * 开场回放：该 Box 近期 agent 执行（与 ctx 屏幕同源的实况块）渲染成终端文本——
 * 「接手显示器」的连续性：进去先看到 agent 刚干的活，分隔行之下才是新会话提示符。
 * 本地 write 先落屏（pty 输出经 WS 异步后到，天然在回放之下）；实况断线不补——
 * 重启后无回放直接新会话（诚实降级）。
 */
const recentExecText = (): string => {
  const blocks = kernel.streams.filter((s) => s.boxId === props.boxId && s.stream === 'exec').slice(-10)
  if (blocks.length === 0) return ''
  const parts: string[] = []
  for (const block of blocks) {
    if (block.command) parts.push(`\x1b[33m$ ${block.command.join(' ')}\x1b[0m\r\n`)
    const out = block.stdout.replace(/\s+$/, '')
    if (out !== '') parts.push(`${out}\r\n`)
    const err = block.stderr.replace(/\s+$/, '')
    if (err !== '') parts.push(`\x1b[31m${err}\x1b[0m\r\n`)
    if (block.state === 'abort') parts.push(`\x1b[31m✗ 已中止：${block.abortReason ?? ''}\x1b[0m\r\n`)
  }
  parts.push('\x1b[90m── 以上为该 Box 近期执行（agent）· 下方为新终端会话 ──\x1b[0m\r\n\r\n')
  return parts.join('')
}

let term: Terminal | null = null
let shellId: string | null = null
let offPty: (() => void) | null = null
/** 开场定下的会话尺寸（stty 注入与 xterm 一致） */
let sized: { cols: number; rows: number } = { cols: 100, rows: 30 }

/**
 * 开场定尺寸（会话中不变）：先以基准 80×24 开屏量测单元格尺寸（.xterm-screen 是
 * cols×rows 的精确像素盒），再按 host 可容空间算终值——resize 后才起会话，stty 注入的
 * 即终值。钳制对齐 backend-wsl（cols 10~500 / rows 4~200），量测失败回退 100×30。
 */
const sizeToHost = (): { cols: number; rows: number } => {
  const host = hostEl.value
  const screen = host?.querySelector('.xterm-screen') as HTMLElement | null
  if (!term || !host || !screen || term.cols === 0 || term.rows === 0) return { cols: 100, rows: 30 }
  const cellW = screen.clientWidth / term.cols
  const cellH = screen.clientHeight / term.rows
  if (!(cellW > 0) || !(cellH > 0)) return { cols: 100, rows: 30 }
  const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))
  return {
    cols: clamp(Math.floor(host.clientWidth / cellW), 24, 500),
    rows: clamp(Math.floor(host.clientHeight / cellH), 6, 200),
  }
}

onMounted(() => {
  term = new Terminal({
    cols: 80,
    rows: 24,
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
  sized = sizeToHost()
  term.resize(sized.cols, sized.rows)
  // 开场回放先落屏（本地 write 即时；pty 输出经 WS 异步到达，天然接在回放之下）
  term.write(recentExecText())
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
  // 起会话（失败如实呈现——SHELL_UNSUPPORTED 等）；尺寸=开场定值（stty 注入与 xterm 屏一致）
  kernel
    .shellOpen(props.boxId, sized)
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
