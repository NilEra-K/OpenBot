<script setup lang="ts">
/**
 * console 视图（prototype.html 迁移，P2 Step 8 + P3 Step 7 三栏）：
 * 三栏布局（roster + streamcol + ctx 实况屏幕）。
 * 流内条目：日期分隔 / 消息气泡（user 右对齐、agent markdown）/ A2A 中继行 / 思考块（llm 增量，
 * 全部轮次留痕）/ Box 执行卡（内嵌命令与输出的实况终端）/ 审批 gate 卡——「模型说的+模型做的」
 * 按时间序聚合在对话流，右栏 ctx 纯化为一块显示器。
 * 空缺态：管家缺失 / provider 未配置，均给出去向提示（协议纯度：只呈现事实与引导，不发 UI 指令）。
 */
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useKernelStore } from '../stores/kernel'
import { useUiStore } from '../stores/ui'
import { renderMarkdown } from '../lib/markdown'
import { mentionify } from '../lib/mention'
import { agentColor } from '../lib/agent-color'
import RosterPanel from '../components/RosterPanel.vue'
import CtxPanel from '../components/CtxPanel.vue'
import BoxScreen from '../components/BoxScreen.vue'
import MentionMenu from '../components/MentionMenu.vue'
import type { MentionItem } from '../components/MentionMenu.vue'
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

/** 进行中 run（中止入口的目标） */
const activeRun = computed(
  () =>
    kernel.runs.find(
      (r) => r.agentId === ui.activeAgentId && (r.state === 'queued' || r.state === 'running'),
    ) ?? null,
)

/** 正在中止的 runId（点击即置；SCHED_RUN_NOT_CANCELLABLE 等错误静默——已在中止中） */
const cancellingRunId = ref<string | null>(null)

/** 打断（用户主权）：中止后 lifecycle finished(aborted) 事件自然收敛进行中单元 */
const cancelActive = (): void => {
  const run = activeRun.value
  if (!run || cancellingRunId.value === run.runId) return
  // 本地「正在中止…」反馈即置（渲染局部态，解耦纪律 #1）；run 离开 queued/running 自动复位
  cancellingRunId.value = run.runId
  void kernel.cancelRun(run.agentId, run.runId).catch(() => {})
}
watch(activeRun, (run) => {
  if (!run || run.runId !== cancellingRunId.value) cancellingRunId.value = null
})

/** 该 run 的 exec 实况块（task 卡内嵌输出区：命令行+输出一体的终端语义；无实况数据的历史卡退化现状） */
const execStreamsOf = (runId?: string): LiveStreamBlock[] =>
  runId !== undefined ? kernel.streams.filter((s) => s.runId === runId && s.stream === 'exec') : []

/**
 * 流内渲染单元：「模型说的+模型做的」聚合进消息结构——agent 消息吸收它之前的思考块与
 * exec 卡（m-name 之下、m-text 之前，**单元内按时间交错**），一轮回复是一个完整单元；
 * user 消息前先把残余块 flush 成无文本的块组（事实不丢）；末尾残余 = 进行中单元
 * （run 进行中，最终消息未到）。
 */
/** 聚合单元的组成部分（保持插入序=时间序——think 与 exec 交错，不分层） */
type UnitPart = { kind: 'think'; block: LiveStreamBlock } | { kind: 'exec'; index: number }

interface StreamUnit {
  key: string
  at: number
  kind: 'divider' | 'msg-user' | 'relay' | 'agent' | 'pending' | 'ended'
  /** msg-user / relay / agent（最终消息；块组与进行中单元无） */
  msgIndex?: number
  parts: UnitPart[]
}

/** 组成部分的发生时间（flush/进行中单元的排序值） */
const partAt = (part: UnitPart): number =>
  part.kind === 'think' ? part.block.at : kernel.execs[part.index]!.at

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
  let pendingParts: UnitPart[] = []
  let lastDay = ''
  for (const row of raw) {
    const day = new Date(row.at).toDateString()
    if (day !== lastDay) {
      units.push({ key: `d${day}`, at: row.at, kind: 'divider', parts: [] })
      lastDay = day
    }
    if (row.kind === 'exec') {
      pendingParts.push({ kind: 'exec', index: row.execIndex! })
    } else if (row.kind === 'think') {
      pendingParts.push({ kind: 'think', block: row.block! })
    } else if (row.kind === 'msg-agent') {
      // agent 消息：吸收前置块——聚合单元
      units.push({ key: row.key, at: row.at, kind: 'agent', msgIndex: row.msgIndex, parts: pendingParts })
      pendingParts = []
    } else if (row.kind === 'msg-user') {
      // user 消息前 flush 残余块（上一轮无最终消息也不能丢事实），新一轮重新累积
      if (pendingParts.length > 0) {
        units.push({ key: `f-${row.key}`, at: partAt(pendingParts.at(-1)!), kind: 'agent', parts: pendingParts })
        pendingParts = []
      }
      units.push({ key: row.key, at: row.at, kind: 'msg-user', msgIndex: row.msgIndex, parts: [] })
    } else {
      // relay：流内标记，不清空累积（块仍归属后续 agent 消息）
      units.push({ key: row.key, at: row.at, kind: 'relay', msgIndex: row.msgIndex, parts: [] })
    }
  }
  // 末尾残余：进行中单元（run queued/running——三个点占位与中止入口）或已终结的无终答块组
  // （run aborted/failed 无终答——事实留痕但如实标记终态，不再冒充进行中）
  if (pendingParts.length > 0) {
    units.push({
      key: 'pending',
      at: partAt(pendingParts.at(-1)!),
      kind: agentBusy.value ? 'pending' : 'ended',
      parts: pendingParts,
    })
  } else if (agentBusy.value) {
    units.push({ key: 'pending', at: Date.now(), kind: 'pending', parts: [] })
  }
  return units
})

/** 已终结块组的状态行：该 agent 最新 run 的终态文案（aborted/failed 事实；无则不显示） */
const endedOutcomeLabel = computed(() => {
  const last = kernel.runs.filter((r) => r.agentId === ui.activeAgentId).at(-1)
  if (!last) return null
  if (last.state === 'aborted') return '已中止'
  if (last.state === 'failed') return last.code ? `失败 · ${last.code}` : '失败'
  return null
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

// 快速派单落点：命令面板请求聚焦输入框——标志位由本组件消费（watcher 处理在场切换；
// 从其他视图派单回 console 时本组件重挂载、watcher 错过事件，onMounted 兜底检查）
const consumeComposerFocus = (): void => {
  ui.composerFocus = false
  void nextTick(() => draftEl.value?.focus())
}
watch(
  () => ui.composerFocus,
  (want) => {
    if (want) consumeComposerFocus()
  },
)
onMounted(() => {
  if (ui.composerFocus) consumeComposerFocus()
})

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

// ---- @提及（P4 Step 4）：补全菜单 + 单提及路由 + 名册命中高亮 ----

/** 名册命中面（名字与 agentId 都可命中——新 agent name 缺席时 id 即名字） */
const mentionNames = computed(
  () => new Set(kernel.roster.flatMap((a) => (a.name ? [a.name, a.agentId] : [a.agentId]))),
)

const mention = ref<{ open: boolean; start: number; items: MentionItem[]; sel: number }>({
  open: false,
  start: -1,
  items: [],
  sel: 0,
})

const closeMention = (): void => {
  mention.value = { open: false, start: -1, items: [], sel: 0 }
}

/** 输入驱动：光标前缀匹配 `@名字前缀` 即弹菜单（读 DOM 值——v-model 与显式监听的更新时序不保证） */
const onComposerInput = (): void => {
  const el = draftEl.value
  if (!el) return
  const caret = el.selectionStart ?? el.value.length
  const m = el.value.slice(0, caret).match(/(?:^|[^一-龥A-Za-z0-9])@([一-龥A-Za-z0-9]*)$/)
  if (!m) {
    closeMention()
    return
  }
  const q = m[1]!.toLowerCase()
  const items = kernel.roster
    .map((a) => ({ agentId: a.agentId, name: a.name ?? a.agentId, sub: a.role === 'steward' ? '管家' : 'worker' }))
    .filter((it) => it.name.toLowerCase().startsWith(q) || it.agentId.toLowerCase().startsWith(q))
  if (items.length === 0) {
    closeMention()
    return
  }
  mention.value = { open: true, start: caret - m[1]!.length, items, sel: 0 }
}

/** 键盘流：菜单开时先行消费（↑↓/Enter/Tab/Esc），不冒泡到发送——原型同款 */
const onComposerKeydown = (e: KeyboardEvent): void => {
  if (mention.value.open) {
    const n = mention.value.items.length
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      mention.value.sel = (mention.value.sel + (e.key === 'ArrowDown' ? 1 : -1) + n) % n
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault()
      pickMention(mention.value.sel)
    } else if (e.key === 'Escape') {
      e.stopPropagation()
      closeMention()
    }
    return
  }
  if (e.key === 'Enter') {
    e.preventDefault()
    void send()
  }
}

/** 失焦收起（延迟一拍——给菜单 mousedown 的点击留出路径） */
const onComposerBlur = (): void => {
  window.setTimeout(closeMention, 120)
}

const pickMention = (i: number): void => {
  const mn = mention.value
  const it = mn.items[i]
  const el = draftEl.value
  if (!it || !el) return
  const caret = el.selectionStart ?? el.value.length
  // slice(0, mn.start) 已含 @ 字符（start 指向名字前缀首字符），不再补 @——
  // 原型 mmPick 此处重复拼 @ 是演示脚本的 bug，不照搬
  ui.draft = `${ui.draft.slice(0, mn.start)}${it.name} ${ui.draft.slice(caret)}`
  closeMention()
  const pos = mn.start + it.name.length + 1
  void nextTick(() => {
    el.focus()
    el.setSelectionRange(pos, pos)
  })
}

/** 文本中提及的名册 agent（去重；名字与 id 双命中面；前置非名字字符——与高亮同一判定防邮箱误路由） */
const mentionedAgents = (text: string): string[] => {
  const found = new Set<string>()
  for (const m of text.matchAll(/(?:^|[^一-龥A-Za-z0-9])@([一-龥A-Za-z0-9]+)/g)) {
    const hit = kernel.roster.find((a) => (a.name ?? a.agentId) === m[1] || a.agentId === m[1])
    if (hit) found.add(hit.agentId)
  }
  return [...found]
}

const send = async (): Promise<void> => {
  const text = ui.draft.trim()
  if (text === '' || sending.value) return
  // 单提及路由（裁定 C 的 P4 侧）：唯一提及且非当前会话对象 → 消息发给该 agent 并
  // 跟随跳转（消息落进目标会话流，不发完失联）；多提及=广播语义，随 P5 广播协议
  let to = ui.activeAgentId
  const targets = mentionedAgents(text)
  if (targets.length === 1 && targets[0] !== ui.activeAgentId) {
    to = targets[0]
    ui.activeAgentId = to
  }
  ui.draft = ''
  sending.value = true
  try {
    await kernel.sendUserMessage(to, text)
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
                <div class="m-text" v-html="mentionify(kernel.messages[unit.msgIndex!]!.text, mentionNames)"></div>
              </div>
            </div>

            <button v-else-if="unit.kind === 'relay'" class="relay" :title="`跳到 ${kernel.messages[unit.msgIndex!]!.to} 的会话`" @click="ui.activeAgentId = kernel.messages[unit.msgIndex!]!.to">
              <span class="relay-arrow">→</span>
              <span class="relay-text">
                <b :style="{ color: agentColor(kernel.messages[unit.msgIndex!]!.from) }">{{ kernel.messages[unit.msgIndex!]!.from }}</b>
                →
                <b :style="{ color: agentColor(kernel.messages[unit.msgIndex!]!.to) }">{{ kernel.messages[unit.msgIndex!]!.to }}</b>
                · <span v-html="mentionify(kernel.messages[unit.msgIndex!]!.text, mentionNames)"></span>
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
                  <button
                    v-if="unit.kind === 'pending' && activeRun"
                    class="m-stop"
                    :disabled="cancellingRunId === activeRun.runId"
                    title="中止当前 run"
                    @click="cancelActive"
                  >
                    {{ cancellingRunId === activeRun.runId ? '正在中止…' : '中止' }}
                  </button>
                  <!-- 已终结的无终答块组（run aborted/failed）：终态事实行，不再冒充进行中 -->
                  <span v-else-if="unit.kind === 'ended' && endedOutcomeLabel" class="m-state">{{ endedOutcomeLabel }}</span>
                  <span v-else-if="unit.msgIndex !== undefined" class="m-time">{{ fmtTime(unit.at) }}</span>
                </div>

                <!-- 单元内按时间序交错：思考块与 task 卡不分层（think→task→think→…如实还原轮次） -->
                <template v-for="part in unit.parts" :key="part.kind === 'think' ? part.block.key : kernel.execs[part.index]!.key">
                  <!-- 思考块：live 展开实时增量，完成后收起（摘要 + 展开箭头） -->
                  <div v-if="part.kind === 'think'" class="think" :class="{ 'is-live': part.block.state === 'live' }">
                    <button class="think-head" type="button" @click="toggleThink(part.block.key)">
                      <span class="think-tag">{{ part.block.state === 'live' ? '思考中' : '思考' }}</span>
                      <span v-if="part.block.state !== 'live'" class="think-sum mono">{{ thinkSummary(part.block) }}</span>
                      <span class="think-chev" :class="{ open: isThinkOpen(part.block) }" aria-hidden="true">
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6.5 9.5L12 15l5.5-5.5"></path></svg>
                      </span>
                    </button>
                    <div v-if="isThinkOpen(part.block)" class="think-body-wrap">
                      <span class="think-body mono">{{ part.block.stdout }}</span>
                      <span v-if="part.block.state === 'live'" class="think-caret"></span>
                    </div>
                  </div>

                  <!-- task 卡：box 执行（有实况时输出区内嵌） -->
                  <div v-else class="task">
                    <div class="task-head">
                      <span class="chip">box · {{ kernel.execs[part.index]!.boxId }}</span>
                      <span class="chip" :class="kernel.execs[part.index]!.phase === 'started' ? 'chip-accent' : kernel.execs[part.index]!.exitCode === 0 ? 'chip-success' : 'chip-danger'">
                        {{ kernel.execs[part.index]!.phase === 'started' ? '运行中' : kernel.execs[part.index]!.exitCode === 0 ? '完成' : `退出 ${kernel.execs[part.index]!.exitCode}` }}
                      </span>
                      <!-- 命令行：有实况输出区时由输出区呈现（$ 命令 + 输出一体），无实况的历史卡在此兜底 -->
                      <span v-if="execStreamsOf(kernel.execs[part.index]!.runId).length === 0" class="task-title mono">
                        {{ kernel.execs[part.index]!.command.join(' ') }}
                      </span>
                    </div>
                    <BoxScreen
                      v-if="execStreamsOf(kernel.execs[part.index]!.runId).length"
                      class="task-out"
                      :blocks="execStreamsOf(kernel.execs[part.index]!.runId)"
                    />
                  </div>
                </template>

                <!-- 最终文本（markdown）；进行中且尚无任何输出块 → 三个点占位（首 token 到达即被实况取代） -->
                <div v-if="unit.msgIndex !== undefined" class="m-text md" v-html="renderMarkdown(kernel.messages[unit.msgIndex]!.text, mentionNames)"></div>
                <div v-else-if="unit.kind === 'pending' && unit.parts.length === 0" class="m-text typing" aria-label="正在生成回复">
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
        <!-- @提及菜单（原型挂 .composer 下，向上弹出——left/right 18px 对齐 composer 内容区） -->
        <MentionMenu
          v-if="mention.open"
          :items="mention.items"
          :sel="mention.sel"
          @pick="pickMention"
        />
        <div class="composer-inner">
          <div class="composer-box" :class="{ disabled: !kernel.connected }">
            <input
              ref="draftEl"
              v-model="ui.draft"
              :placeholder="`对 ${activeAgent?.name ?? ui.activeAgentId} 说…（Enter 发送）`"
              :disabled="!kernel.connected"
              autocomplete="off"
              @input="onComposerInput"
              @blur="onComposerBlur"
              @keydown="onComposerKeydown"
            />
            <!-- 双态：run 进行中且未打字 → 中止（固定位置不受对话流滚动影响；打字中保留发送=steer 能力） -->
            <button
              v-if="!activeRun || ui.draft.trim() !== ''"
              class="cb-send"
              :disabled="!kernel.connected || ui.draft.trim() === '' || sending"
              title="发送（Enter）"
              @click="send"
            >发送</button>
            <button
              v-else
              class="cb-send cb-stop"
              :disabled="cancellingRunId === activeRun.runId"
              :title="cancellingRunId === activeRun.runId ? '正在中止…' : '中止当前 run'"
              @click="cancelActive"
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2.5"/></svg>
              {{ cancellingRunId === activeRun.runId ? '正在中止…' : '中止' }}
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- 右栏：ctx 实况面板（llm 打字机 + Box 命令输出；原型 #11 标注位） -->
    <CtxPanel />
  </section>
</template>

<style scoped src="./console.css"></style>
