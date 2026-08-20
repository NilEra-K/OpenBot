<script setup lang="ts">
/**
 * console 视图（prototype.html 迁移，P2 Step 8 + P3 Step 7 三栏）：
 * 三栏布局（roster + streamcol + ctx 实况屏幕）。
 * 流内条目：日期分隔 / 消息气泡（user 右对齐、agent markdown）/ A2A 中继行 / 思考块（llm 增量，
 * 全部轮次留痕）/ Box 执行卡（内嵌命令与输出的实况终端）/ 审批 gate 卡——「模型说的+模型做的」
 * 按时间序聚合在对话流，右栏 ctx 纯化为一块显示器。
 * 空缺态：管家缺失 / provider 未配置，均给出去向提示（协议纯度：只呈现事实与引导，不发 UI 指令）。
 */
import { computed, nextTick, ref, watch } from 'vue'
import { useKernelStore } from '../stores/kernel'
import { useUiStore } from '../stores/ui'
import { renderMarkdown } from '../lib/markdown'
import { agentColor } from '../lib/agent-color'
import RosterPanel from '../components/RosterPanel.vue'
import CtxPanel from '../components/CtxPanel.vue'
import BoxScreen from '../components/BoxScreen.vue'
import type { LiveStreamBlock } from '../stores/kernel'

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

/** 该 agent 有排程中的 run（进行中单元与三个点占位的触发条件） */
const agentBusy = computed(() =>
  kernel.runs.some((r) => r.agentId === ui.activeAgentId && (r.state === 'queued' || r.state === 'running')),
)

/** 该 run 的 exec 实况块（task 卡内嵌输出区：命令行+输出一体的终端语义；无实况数据的历史卡退化现状） */
const execStreamsOf = (runId?: string): LiveStreamBlock[] =>
  runId !== undefined ? kernel.streams.filter((s) => s.runId === runId && s.stream === 'exec') : []

/**
 * 流内渲染单元：「模型说的+模型做的」聚合进消息结构——agent 消息吸收它之前的思考块与
 * exec 卡（m-name 之下、m-text 之前），一轮回复是一个完整单元；user 消息前先把残余块
 * flush 成无文本的块组（事实不丢）；末尾残余 = 进行中单元（run 进行中，最终消息未到）。
 */
interface StreamUnit {
  key: string
  at: number
  kind: 'divider' | 'msg-user' | 'relay' | 'agent' | 'pending'
  /** msg-user / relay / agent（最终消息；块组与进行中单元无） */
  msgIndex?: number
  /** 聚合进来的思考块（实况）与 exec 卡（事实，按 execs 索引） */
  thinks: LiveStreamBlock[]
  execs: number[]
}

interface RawRow {
  key: string
  at: number
  kind: 'msg-user' | 'msg-agent' | 'relay' | 'exec' | 'think'
  msgIndex?: number
  execIndex?: number
  block?: LiveStreamBlock
}

const streamUnits = computed<StreamUnit[]>(() => {
  const active = ui.activeAgentId
  const raw: RawRow[] = []
  kernel.messages.forEach((m, i) => {
    const related =
      m.kind === 'user'
        ? m.to === active
        : m.kind === 'agent'
          ? m.from === active
          : m.from === active || m.to === active
    if (!related) return
    raw.push({
      key: `m${i}`,
      at: m.at,
      kind: m.kind === 'user' ? 'msg-user' : m.kind === 'agent' ? 'msg-agent' : 'relay',
      msgIndex: i,
    })
  })
  kernel.execs.forEach((e, i) => {
    if (agentOfRun(e.runId) === active) raw.push({ key: `e${i}`, at: e.at, kind: 'exec', execIndex: i })
  })
  // 思考实况：该 agent 的 llm 增量块——全部轮次按时间留痕（多轮工具循环时与 exec 卡自然交错）。
  // agentId 直配（比 runId 前缀推断更准）；实况断线不补，重启后历史只有事实事件（诚实分层）
  for (const block of kernel.streams) {
    if (block.agentId === active && block.stream === 'llm' && block.stdout !== '') {
      raw.push({ key: `t-${block.key}`, at: block.at, kind: 'think', block })
    }
  }
  raw.sort((a, b) => a.at - b.at || a.key.localeCompare(b.key))

  const units: StreamUnit[] = []
  let pendingThinks: LiveStreamBlock[] = []
  let pendingExecs: number[] = []
  let lastDay = ''
  for (const row of raw) {
    const day = new Date(row.at).toDateString()
    if (day !== lastDay) {
      units.push({ key: `d${day}`, at: row.at, kind: 'divider', thinks: [], execs: [] })
      lastDay = day
    }
    if (row.kind === 'exec') {
      pendingExecs.push(row.execIndex!)
    } else if (row.kind === 'think') {
      pendingThinks.push(row.block!)
    } else if (row.kind === 'msg-agent') {
      // agent 消息：吸收前置块——聚合单元
      units.push({ key: row.key, at: row.at, kind: 'agent', msgIndex: row.msgIndex, thinks: pendingThinks, execs: pendingExecs })
      pendingThinks = []
      pendingExecs = []
    } else if (row.kind === 'msg-user') {
      // user 消息前 flush 残余块（上一轮无最终消息也不能丢事实），新一轮重新累积
      if (pendingThinks.length > 0 || pendingExecs.length > 0) {
        const at = pendingThinks.at(-1)?.at ?? (pendingExecs.length > 0 ? kernel.execs[pendingExecs.at(-1)!]!.at : row.at)
        units.push({ key: `f-${row.key}`, at, kind: 'agent', thinks: pendingThinks, execs: pendingExecs })
        pendingThinks = []
        pendingExecs = []
      }
      units.push({ key: row.key, at: row.at, kind: 'msg-user', msgIndex: row.msgIndex, thinks: [], execs: [] })
    } else {
      // relay：流内标记，不清空累积（块仍归属后续 agent 消息）
      units.push({ key: row.key, at: row.at, kind: 'relay', msgIndex: row.msgIndex, thinks: [], execs: [] })
    }
  }
  // 末尾残余：进行中单元——run 进行中（或防御性保留的纯块组），无块且 busy 时三个点占位
  if (pendingThinks.length > 0 || pendingExecs.length > 0 || agentBusy.value) {
    const lastAt = pendingThinks.at(-1)?.at ?? (pendingExecs.length > 0 ? kernel.execs[pendingExecs.at(-1)!]!.at : Date.now())
    units.push({ key: 'pending', at: lastAt, kind: 'pending', thinks: pendingThinks, execs: pendingExecs })
  }
  return units
})

// ---- 思考块折叠（渲染局部态——抽屉开合归 renderer，解耦纪律 #1） ----

const expandedThink = ref(new Set<string>())

/** live 强制展开（正在思考要看实时增量）；完成后按用户选择，默认收起 */
const isThinkOpen = (block: LiveStreamBlock): boolean =>
  block.state === 'live' || expandedThink.value.has(block.key)

const toggleThink = (key: string): void => {
  const next = new Set(expandedThink.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  expandedThink.value = next
}

/** 收起态摘要：首行截断 */
const thinkSummary = (block: LiveStreamBlock): string => {
  const firstLine = block.stdout.split('\n')[0] ?? ''
  return firstLine.length > 60 ? `${firstLine.slice(0, 60)}…` : firstLine
}

/** 流滚动到底（新消息/切换会话时——硬事件直接贴底） */
const scrollToBottom = (): void => {
  void nextTick(() => {
    if (streamEl.value) streamEl.value.scrollTop = streamEl.value.scrollHeight
  })
}
/** 视口是否已在底部附近（贴底跟随的前置判定：用户上翻查看历史时不打扰） */
const isNearBottom = (): boolean => {
  const el = streamEl.value
  if (!el) return true
  return el.scrollHeight - el.scrollTop - el.clientHeight < 80
}
const followIfNearBottom = (): void => {
  if (isNearBottom()) scrollToBottom()
}
watch(() => kernel.messages.length, scrollToBottom)
watch(() => ui.activeAgentId, scrollToBottom)
// 实况增长（思考增量 / 执行输出 / 流块新增与状态迁移）与进行中单元出现：贴底跟随
watch(
  () => kernel.streams.map((s) => `${s.key}:${s.stdout.length}:${s.stderr.length}:${s.state}`).join('|'),
  followIfNearBottom,
)
watch(() => kernel.runs.length, followIfNearBottom)

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
  <section class="console">
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
          <p v-else-if="streamUnits.length === 0" class="placeholder">
            {{ kernel.stewardId ? '开始对话——你的消息永远最先（user lane）' : '管家空缺：等待首个 agent 被任命' }}
          </p>

          <template v-for="unit in streamUnits" :key="unit.key">
            <div v-if="unit.kind === 'divider'" class="day-divider">{{ fmtDay(unit.at) }}</div>

            <!-- user 消息（右对齐气泡） -->
            <div v-else-if="unit.kind === 'msg-user'" class="m user">
              <div class="avatar neutral">你</div>
              <div class="m-body">
                <div class="m-meta">
                  <span class="m-name">你</span>
                  <span class="m-time">{{ fmtTime(unit.at) }}</span>
                  <span v-if="kernel.messages[unit.msgIndex!]!.pending" class="m-state">发送中…</span>
                  <button v-else-if="kernel.messages[unit.msgIndex!]!.failed" class="m-retry" @click="retry(unit.msgIndex!)">发送失败 · 重试</button>
                </div>
                <div class="m-text">{{ kernel.messages[unit.msgIndex!]!.text }}</div>
              </div>
            </div>

            <button v-else-if="unit.kind === 'relay'" class="relay" :title="`跳到 ${kernel.messages[unit.msgIndex!]!.to} 的会话`" @click="ui.activeAgentId = kernel.messages[unit.msgIndex!]!.to">
              <span class="relay-arrow">→</span>
              <span class="relay-text">
                <b :style="{ color: agentColor(kernel.messages[unit.msgIndex!]!.from) }">{{ kernel.messages[unit.msgIndex!]!.from }}</b>
                →
                <b :style="{ color: agentColor(kernel.messages[unit.msgIndex!]!.to) }">{{ kernel.messages[unit.msgIndex!]!.to }}</b>
                · {{ kernel.messages[unit.msgIndex!]!.text }}
              </span>
              <span class="m-time">{{ fmtTime(unit.at) }}</span>
            </button>

            <!-- agent 聚合单元（含进行中/纯块组）：m-name 之下——思考块（可折叠）与 task 卡，最终文本（或三个点占位）收尾 -->
            <div v-else class="m">
              <div class="avatar" :style="{ background: agentColor(ui.activeAgentId) }">{{ initialOf(ui.activeAgentId) }}</div>
              <div class="m-body">
                <div class="m-meta">
                  <span class="m-name" :style="{ color: agentColor(ui.activeAgentId) }">
                    {{ activeAgent?.name ?? ui.activeAgentId }}
                  </span>
                  <span v-if="unit.kind === 'pending'" class="m-state">工作中…</span>
                  <span v-else-if="unit.msgIndex !== undefined" class="m-time">{{ fmtTime(unit.at) }}</span>
                </div>

                <!-- 思考块：live 展开实时增量，完成后收起（摘要 + 展开箭头） -->
                <div v-for="block in unit.thinks" :key="block.key" class="think" :class="{ 'is-live': block.state === 'live' }">
                  <button class="think-head" type="button" @click="toggleThink(block.key)">
                    <span class="think-tag">{{ block.state === 'live' ? '思考中' : '思考' }}</span>
                    <span v-if="block.state !== 'live'" class="think-sum mono">{{ thinkSummary(block) }}</span>
                    <span class="think-chev" :class="{ open: isThinkOpen(block) }" aria-hidden="true">
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6.5 9.5L12 15l5.5-5.5"></path></svg>
                    </span>
                  </button>
                  <div v-if="isThinkOpen(block)" class="think-body-wrap">
                    <span class="think-body mono">{{ block.stdout }}</span>
                    <span v-if="block.state === 'live'" class="think-caret"></span>
                  </div>
                </div>

                <!-- task 卡：box 执行（有实况时输出区内嵌） -->
                <div v-for="ei in unit.execs" :key="kernel.execs[ei]!.key" class="task">
                  <div class="task-head">
                    <span class="chip">box · {{ kernel.execs[ei]!.boxId }}</span>
                    <span class="chip" :class="kernel.execs[ei]!.phase === 'started' ? 'chip-accent' : kernel.execs[ei]!.exitCode === 0 ? 'chip-success' : 'chip-danger'">
                      {{ kernel.execs[ei]!.phase === 'started' ? '运行中' : kernel.execs[ei]!.exitCode === 0 ? '完成' : `退出 ${kernel.execs[ei]!.exitCode}` }}
                    </span>
                    <!-- 命令行：有实况输出区时由输出区呈现（$ 命令 + 输出一体），无实况的历史卡在此兜底 -->
                    <span v-if="execStreamsOf(kernel.execs[ei]!.runId).length === 0" class="task-title mono">
                      {{ kernel.execs[ei]!.command.join(' ') }}
                    </span>
                  </div>
                  <BoxScreen
                    v-if="execStreamsOf(kernel.execs[ei]!.runId).length"
                    class="task-out"
                    :blocks="execStreamsOf(kernel.execs[ei]!.runId)"
                  />
                </div>

                <!-- 最终文本（markdown）；进行中且尚无任何输出块 → 三个点占位（首 token 到达即被实况取代） -->
                <div v-if="unit.msgIndex !== undefined" class="m-text md" v-html="renderMarkdown(kernel.messages[unit.msgIndex]!.text)"></div>
                <div v-else-if="unit.kind === 'pending' && unit.thinks.length === 0 && unit.execs.length === 0" class="m-text typing" aria-label="正在生成回复">
                  <span class="dot"></span><span class="dot"></span><span class="dot"></span>
                </div>
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

    <!-- 右栏：ctx 实况面板（llm 打字机 + Box 命令输出；原型 #11 标注位） -->
    <CtxPanel />
  </section>
</template>

<style scoped src="./console.css"></style>
