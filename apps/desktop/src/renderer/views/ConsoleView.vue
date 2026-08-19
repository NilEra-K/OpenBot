<script setup lang="ts">
/**
 * console 视图（plan-p2 Step 8，prototype.html 迁移）：
 * 两栏布局（roster + streamcol；ctx 面板待 P3 WS 实况信号源——原型 #11 标注位）。
 * 流内条目：日期分隔 / 消息气泡（user 右对齐、agent markdown）/ A2A 中继行 / Box 执行卡 / 审批 gate 卡。
 * 空缺态：管家缺失 / provider 未配置，均给出去向提示（协议纯度：只呈现事实与引导，不发 UI 指令）。
 */
import { computed, nextTick, ref, watch } from 'vue'
import { useKernelStore } from '../stores/kernel'
import { useUiStore } from '../stores/ui'
import { renderMarkdown } from '../lib/markdown'
import { agentColor } from '../lib/agent-color'
import RosterPanel from '../components/RosterPanel.vue'

const kernel = useKernelStore()
const ui = useUiStore()

const streamEl = ref<HTMLElement | null>(null)
const draftEl = ref<HTMLInputElement | null>(null)

const activeAgent = computed(
  () => kernel.roster.find((a) => a.agentId === ui.activeAgentId) ?? null,
)

/** agent 首字母（头像用） */
const initialOf = (id: string): string => (kernel.roster.find((a) => a.agentId === id)?.name ?? id).trim().charAt(0) || '?'

const fmtTime = (at: number): string =>
  new Date(at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })

const fmtDay = (at: number): string => {
  const d = new Date(at)
  const today = new Date()
  if (d.toDateString() === today.toDateString()) return '今天'
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`
}

/** runId 的 agent 前缀（P1 约定 `${agentId}-run-N`） */
const agentOfRun = (runId?: string): string | null =>
  runId !== undefined && runId.includes('-run-') ? (runId.split('-run-')[0] ?? null) : null

/** 当前会话的流条目：消息 + 相关执行卡，按 at 稳定排序；日期分隔按天插入 */
interface StreamRow {
  key: string
  at: number
  kind: 'divider' | 'msg' | 'relay' | 'exec'
  msgIndex?: number
  execIndex?: number
}

const streamRows = computed<StreamRow[]>(() => {
  const active = ui.activeAgentId
  const rows: StreamRow[] = []
  kernel.messages.forEach((m, i) => {
    const related =
      m.kind === 'user'
        ? m.to === active
        : m.kind === 'agent'
          ? m.from === active
          : m.from === active || m.to === active
    if (related) rows.push({ key: `m${i}`, at: m.at, kind: m.kind === 'a2a' ? 'relay' : 'msg', msgIndex: i })
  })
  kernel.execs.forEach((e, i) => {
    if (agentOfRun(e.runId) === active) rows.push({ key: `e${i}`, at: e.at, kind: 'exec', execIndex: i })
  })
  rows.sort((a, b) => a.at - b.at || a.key.localeCompare(b.key))
  // 按天插分隔
  const withDividers: StreamRow[] = []
  let lastDay = ''
  for (const row of rows) {
    const day = new Date(row.at).toDateString()
    if (day !== lastDay) {
      withDividers.push({ key: `d${day}`, at: row.at, kind: 'divider' })
      lastDay = day
    }
    withDividers.push(row)
  }
  return withDividers
})

/** 流滚动到底（新消息/切换会话时） */
const scrollToBottom = (): void => {
  void nextTick(() => {
    if (streamEl.value) streamEl.value.scrollTop = streamEl.value.scrollHeight
  })
}
watch(() => kernel.messages.length, scrollToBottom)
watch(() => ui.activeAgentId, scrollToBottom)

// 会话历史懒加载：切换会话或连接就绪时拉一次 transcript（内核重启后的持久真相；已覆盖时幂等跳过）
watch(
  () => [ui.activeAgentId, kernel.connected] as const,
  ([agentId, connected]) => {
    if (connected) void kernel.loadHistory(agentId).catch(() => {})
  },
  { immediate: true },
)

/** 发送（乐观更新在 store；失败态由流内重试按钮处理） */
const sending = ref(false)
const send = async (): Promise<void> => {
  const text = ui.draft.trim()
  if (text === '' || sending.value) return
  ui.draft = ''
  sending.value = true
  try {
    await kernel.sendUserMessage(ui.activeAgentId, text)
  } catch {
    // 失败已标记在消息条目上（流内显示重试）——不弹全局错误
  } finally {
    sending.value = false
    draftEl.value?.focus()
  }
}

/** 失败条目重试：同 nonce 重发（账本幂等，零双发） */
const retry = (index: number): void => {
  const m = kernel.messages[index]
  if (!m || m.messageId[0] !== '~') return
  const nonce = m.messageId.slice(1)
  void kernel.sendUserMessage(m.to, m.text, nonce).catch(() => {})
}

const resolveGate = (nonce: string, decision: 'approved' | 'denied'): void => {
  void kernel.resolveApproval(nonce, decision).catch(() => {})
}
</script>

<template>
  <section class="console no-ctx">
    <RosterPanel />

    <div class="streamcol">
      <div class="stream-head">
        <div class="avatar" :style="{ background: agentColor(ui.activeAgentId) }">{{ initialOf(ui.activeAgentId) }}</div>
        <div class="sh-text">
          <div class="sh-name">{{ activeAgent?.name ?? ui.activeAgentId }}</div>
          <div class="sh-status">
            <span v-if="activeAgent?.role === 'steward'" class="chip chip-accent">管家</span>
            <span v-if="!kernel.providerConfigured" class="sh-warn">provider 未配置——回复将失败，去「设置」配置</span>
            <span v-else-if="kernel.connected">已连接 · seq {{ kernel.lastSeq }}</span>
          </div>
        </div>
      </div>

      <div ref="streamEl" class="stream">
        <div class="stream-inner">
          <p v-if="kernel.bootError" class="placeholder">内核未连接：{{ kernel.bootError }}</p>
          <p v-else-if="streamRows.length === 0" class="placeholder">
            {{ kernel.stewardId ? '开始对话——你的消息永远最先（user lane）' : '管家空缺：等待首个 agent 被任命' }}
          </p>

          <template v-for="row in streamRows" :key="row.key">
            <div v-if="row.kind === 'divider'" class="day-divider">{{ fmtDay(row.at) }}</div>

            <div v-else-if="row.kind === 'msg'" class="m" :class="{ user: kernel.messages[row.msgIndex!]!.kind === 'user' }">
              <div class="avatar" :class="{ neutral: kernel.messages[row.msgIndex!]!.kind === 'user' }" :style="kernel.messages[row.msgIndex!]!.kind === 'user' ? {} : { background: agentColor(kernel.messages[row.msgIndex!]!.from) }">
                {{ kernel.messages[row.msgIndex!]!.kind === 'user' ? '你' : initialOf(kernel.messages[row.msgIndex!]!.from) }}
              </div>
              <div class="m-body">
                <div class="m-meta">
                  <span class="m-name" :style="kernel.messages[row.msgIndex!]!.kind === 'user' ? {} : { color: agentColor(kernel.messages[row.msgIndex!]!.from) }">
                    {{ kernel.messages[row.msgIndex!]!.kind === 'user' ? '你' : kernel.messages[row.msgIndex!]!.from }}
                  </span>
                  <span class="m-time">{{ fmtTime(row.at) }}</span>
                  <span v-if="kernel.messages[row.msgIndex!]!.pending" class="m-state">发送中…</span>
                  <button v-else-if="kernel.messages[row.msgIndex!]!.failed" class="m-retry" @click="retry(row.msgIndex!)">发送失败 · 重试</button>
                </div>
                <!-- agent 消息 markdown 渲染；user 消息纯文本 -->
                <div v-if="kernel.messages[row.msgIndex!]!.kind === 'agent'" class="m-text md" v-html="renderMarkdown(kernel.messages[row.msgIndex!]!.text)"></div>
                <div v-else class="m-text">{{ kernel.messages[row.msgIndex!]!.text }}</div>
              </div>
            </div>

            <button v-else-if="row.kind === 'relay'" class="relay" :title="`跳到 ${kernel.messages[row.msgIndex!]!.to} 的会话`" @click="ui.activeAgentId = kernel.messages[row.msgIndex!]!.to">
              <span class="relay-arrow">→</span>
              <span class="relay-text">
                <b :style="{ color: agentColor(kernel.messages[row.msgIndex!]!.from) }">{{ kernel.messages[row.msgIndex!]!.from }}</b>
                →
                <b :style="{ color: agentColor(kernel.messages[row.msgIndex!]!.to) }">{{ kernel.messages[row.msgIndex!]!.to }}</b>
                · {{ kernel.messages[row.msgIndex!]!.text }}
              </span>
              <span class="m-time">{{ fmtTime(row.at) }}</span>
            </button>

            <div v-else class="task">
              <div class="task-head">
                <span class="chip">box · {{ kernel.execs[row.execIndex!]!.boxId }}</span>
                <span class="chip" :class="kernel.execs[row.execIndex!]!.phase === 'started' ? 'chip-accent' : kernel.execs[row.execIndex!]!.exitCode === 0 ? 'chip-success' : 'chip-danger'">
                  {{ kernel.execs[row.execIndex!]!.phase === 'started' ? '运行中' : kernel.execs[row.execIndex!]!.exitCode === 0 ? '完成' : `退出 ${kernel.execs[row.execIndex!]!.exitCode}` }}
                </span>
                <span class="task-title mono">{{ kernel.execs[row.execIndex!]!.command.join(' ') }}</span>
              </div>
            </div>
          </template>

          <!-- 审批 gate 卡：全局挂起（不按会话过滤——出 Box 操作影响整个系统） -->
          <div v-for="approval in kernel.pendingApprovals" :key="approval.nonce" class="gate">
            <div class="gate-head">⚠ 出 Box 操作待批准：{{ approval.tool }}</div>
            <div class="gate-body">
              agent <b>{{ approval.agentId }}</b>（run {{ approval.runId }}）请求执行
              <b class="mono">{{ approval.tool }}</b>
              <span v-if="approval.reason">——{{ approval.reason }}</span>
            </div>
            <div class="gate-actions">
              <button class="btn btn-primary btn-sm" @click="resolveGate(approval.nonce, 'approved')">批准</button>
              <button class="btn btn-danger-ghost btn-sm" @click="resolveGate(approval.nonce, 'denied')">拒绝</button>
            </div>
          </div>
        </div>
      </div>

      <div class="composer">
        <div class="composer-inner">
          <div class="composer-box" :class="{ disabled: !kernel.connected }">
            <input
              ref="draftEl"
              v-model="ui.draft"
              :placeholder="`对 ${activeAgent?.name ?? ui.activeAgentId} 说…（Enter 发送）`"
              :disabled="!kernel.connected"
              autocomplete="off"
              @keydown.enter.prevent="send"
            />
            <button class="cb-send" :disabled="!kernel.connected || ui.draft.trim() === '' || sending" title="发送（Enter）" @click="send">发送</button>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped src="./console.css"></style>
