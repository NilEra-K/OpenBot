<script setup lang="ts">
/**
 * console 视图（prototype.html 迁移，P2 Step 8 + P3 Step 7 三栏）：
 * 三栏布局（roster + streamcol + ctx 实况屏幕）。
 * 流内条目：日期分隔 / 消息气泡（user 右对齐、agent markdown）/ A2A 中继行 / 思考块（llm 增量，
 * 全部轮次留痕）/ Box 执行卡（内嵌命令与输出的实况终端）/ 审批 gate 卡——「模型说的+模型做的」
 * 按时间序聚合在对话流，右栏 ctx 纯化为一块显示器。
 * 空缺态：管家缺失 / provider 未配置，均给出去向提示（协议纯度：只呈现事实与引导，不发 UI 指令）。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useKernelStore } from '../stores/kernel'
import type { GroupEntry } from '../stores/kernel'
import { useUiStore } from '../stores/ui'
import { useToastStore } from '../stores/toast'
import { renderMarkdown } from '../lib/markdown'
import { mentionify } from '../lib/mention'
import RosterPanel from '../components/RosterPanel.vue'
import BotBallAvatar from '../components/BotBallAvatar.vue'
import CtxPanel from '../components/CtxPanel.vue'
import BoxScreen from '../components/BoxScreen.vue'
import MentionMenu from '../components/MentionMenu.vue'
import SlashMenu from '../components/SlashMenu.vue'
import type { MentionItem } from '../components/MentionMenu.vue'
import type { LiveStreamBlock } from '../stores/kernel'

const kernel = useKernelStore()
const toast = useToastStore()
const ui = useUiStore()

const streamEl = ref<HTMLElement | null>(null)
const streamInnerEl = ref<HTMLElement | null>(null)
/** ---- ctx 显隐动画（2026-10-13 自适应双分支，替代 2026-09-06「冻结 + 320ms 定时解锁」）----
 *  旧策略是「生硬感」根：面板 200ms 滑完 → ~120ms 死区 → 320ms 处内容一帧铺满（三段式跳变）。
 *  - 平滑分支（内容总高 ≤ 阈值）：不锁宽——inner 随 grid 列宽逐帧自然 rewrap，与面板滑动
 *    同拍（拖拽窗口缩放同款手感；短内容每帧布局成本可忽略）；
 *  - 冻结分支（> 阈值；长流每帧 rewrap 是 2026-09-06 实锤的卡顿根）：锁宽零 rewrap，
 *    grid 过渡结束（transitionend）同帧解锁——跳变与动画收尾重合，死区消除。
 *  两分支收尾统一补 measureRail()：宽度已变轮锚必须重测（此前只在挂载/消息变化/窗口 resize
 *  重测，收起/展开后 rail 点击跳转会偏）。 */
const CTX_ANIM_MAX_CONTENT = 8000 // 冻结阈值（内容总高 px，约十来屏）——目验后可调
const consoleEl = ref<HTMLElement | null>(null)
let ctxAnimTimer = 0
let ctxAnimCleanup: (() => void) | null = null

/** 清当前动画残留（兜底定时器 + 冻结锁）；幂等——快速连点入场先调，再从屏上当前宽续接 */
const ctxAnimReset = (): void => {
  if (ctxAnimTimer !== 0) {
    window.clearTimeout(ctxAnimTimer)
    ctxAnimTimer = 0
  }
  ctxAnimCleanup?.()
  ctxAnimCleanup = null
}

/** 动画收尾（grid transitionend 与兜底定时器共用）：清残留 + 轮锚重测 */
const ctxAnimSettle = (): void => {
  ctxAnimReset()
  measureRail()
}

/** grid 列宽过渡结束（挂 .console）：只认本体 grid-template-columns——子孙元素的
 *  transitionend 会冒泡上来（按钮背景等），target 过滤防误触 */
const onCtxGridEnd = (e: TransitionEvent): void => {
  if (e.target !== e.currentTarget || e.propertyName !== 'grid-template-columns') return
  ctxAnimSettle()
}

/** 开关/档案直达共用的动画准备：清残留 → 按内容体量分流（冻结分支锁宽；平滑分支零干预） */
const ctxAnimBegin = (): void => {
  const inner = streamInnerEl.value
  const wNow = inner?.clientWidth ?? 0 // 先取快照再清残留：冻结中途连点 = 屏上实际宽，续接不跳变
  ctxAnimReset()
  if (inner !== null && inner.offsetHeight > CTX_ANIM_MAX_CONTENT) {
    inner.style.width = `${wNow}px`
    inner.style.overflow = 'hidden'
    ctxAnimCleanup = () => {
      inner.style.width = ''
      inner.style.overflow = ''
    }
  }
}

const toggleCtxSmooth = (): void => {
  ctxAnimBegin()
  ui.toggleCtx()
  // 兜底：transitionend 偶发不触发（列宽无实际变化时不过渡）——260ms 保底收尾
  ctxAnimTimer = window.setTimeout(ctxAnimSettle, 260)
}

/** 档案直达同款动画（收起态点击 = 展开动画 + 进档案；展开态无 grid 动画不干预） */
const openCtxSettings = (): void => {
  if (ui.ctxCollapsed) {
    ctxAnimBegin()
    ctxAnimTimer = window.setTimeout(ctxAnimSettle, 260)
  }
  ui.toggleCtxSettings()
}
const draftEl = ref<HTMLInputElement | null>(null)

const activeAgent = computed(
  () => kernel.roster.find((a) => a.agentId === ui.activeAgentId) ?? null,
)

/** 群会话对象（P5 Step 4）：activeGroupId 在场时群聊流；与 agent 会话互斥 */
const activeGroup = computed(() =>
  ui.activeGroupId !== null ? (kernel.groups.find((g) => g.groupId === ui.activeGroupId) ?? null) : null,
)

/** 远端 mirror 会话（P7 多房间轮）：只读——键空间 remote:<roomId>:<memberId>（跨房隔离）；
 *  协议无「本端向远端自由发消息」语义（turn 是远端触达本端的通道，本端发起无 UI 入口记档后续） */
const remotePeer = computed(() => {
  if (!ui.activeAgentId.startsWith('remote:')) return null
  const [, roomId, memberId] = ui.activeAgentId.split(':')
  if (roomId === undefined || memberId === undefined) return null
  return kernel.remoteRooms.find((r) => r.roomId === roomId)?.members.find((m) => m.memberId === memberId) ?? null
})

/** 会话标题（stream-head）：群名 / agent 名 / 远端成员名 */
const sessionTitle = computed(
  () => activeGroup.value?.name ?? remotePeer.value?.displayName ?? activeAgent.value?.name ?? ui.activeAgentId,
)

/** 群内任一成员有进行中 run（群聊流「轮转中」提示与三个点占位） */
const groupBusy = computed(() => {
  const g = activeGroup.value
  if (!g) return false
  return kernel.runs.some(
    (r) => g.members.includes(r.agentId) && (r.state === 'queued' || r.state === 'running'),
  )
})

/** 群流渲染单元（P5 Step 4）：群消息没有 think/exec 卡（过程归成员各自会话）——
 *  日期分隔 + 用户气泡（group-user）+ 成员发言（group-agent，身份色署名）+ sysnote 系统注记 */
interface GroupUnit {
  key: string
  at: number
  kind: 'divider' | 'user' | 'agent' | 'sys'
  msgIndex: number
}

const groupUnits = computed<GroupUnit[]>(() => {
  const gid = ui.activeGroupId
  if (gid === null) return []
  const units: GroupUnit[] = []
  let lastDay = ''
  kernel.messages.forEach((m, i) => {
    if (m.groupId !== gid) return
    const day = new Date(m.at).toDateString()
    if (day !== lastDay) {
      lastDay = day
      units.push({ key: `d${i}`, at: m.at, kind: 'divider', msgIndex: i })
    }
    units.push({
      key: `m${i}`,
      at: m.at,
      kind: m.kind === 'group-user' ? 'user' : m.kind === 'group-agent' ? 'agent' : 'sys',
      msgIndex: i,
    })
  })
  return units
})

/** 群流空态判定（2026-10-15 用户需求）：无实质对话（user/agent 单元）——divider/sys 不算；
 * 建群/清空注记留在底账，开聊后随流呈现留痕（空态与 Agent 同款：icon + 问候语） */
const groupUnitsEmpty = computed(
  () => !groupUnits.value.some((u) => u.kind === 'user' || u.kind === 'agent'),
)
const initialOf = (id: string): string => (kernel.roster.find((a) => a.agentId === id)?.name ?? id).trim().charAt(0) || '?'

/** agent 显示名（群成员署名等——name 缺席回退 id） */
const nameOf = (id: string): string => kernel.roster.find((a) => a.agentId === id)?.name ?? id

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

/** 该 agent 有排程中的 run（进行中单元与三个点占位的触发条件）；群轮 run（kind='group'）
 *  不点亮私聊「进行中」——群轮反馈归群视图（轮转中提示），打断走 supersede 连发语义，
 *  私聊侧的中止入口不再误杀群轮成员 run */
const agentBusy = computed(() =>
  kernel.runs.some(
    (r) => r.agentId === ui.activeAgentId && r.kind !== 'group' && (r.state === 'queued' || r.state === 'running'),
  ),
)

/** 进行中 run（中止入口的目标） */
const activeRun = computed(
  () =>
    kernel.runs.find(
      (r) => r.agentId === ui.activeAgentId && r.kind !== 'group' && (r.state === 'queued' || r.state === 'running'),
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
type UnitPart = { kind: 'think'; block: LiveStreamBlock } | { kind: 'exec'; index: number } | { kind: 'live-msg'; block: LiveStreamBlock }

interface StreamUnit {
  key: string
  at: number
  kind: 'divider' | 'msg-user' | 'msg-remote' | 'relay' | 'agent' | 'pending' | 'ended'
  /** msg-user / msg-remote / relay / agent（最终消息；块组与进行中单元无） */
  msgIndex?: number
  parts: UnitPart[]
}

/** 组成部分的发生时间（flush/进行中单元的排序值） */
const partAt = (part: UnitPart): number =>
  part.kind === 'exec' ? kernel.execs[part.index]!.at : part.block.at

interface RawRow {
  key: string
  at: number
  kind: 'msg-user' | 'msg-agent' | 'msg-remote' | 'relay' | 'exec' | 'think' | 'live-msg'
  msgIndex?: number
  execIndex?: number
  block?: LiveStreamBlock
}

const streamUnits = computed<StreamUnit[]>(() => {
  const active = ui.activeAgentId
  const raw: RawRow[] = []
  kernel.messages.forEach((m, i) => {
    // 群维度消息（group-*）只归群视图（groupUnits 按 groupId 过滤）——私聊流零群痕迹：
    // 此前 group-agent 落 from===active 分支被当 relay 行渲染（群里说的话漏进 1:1 会话，
    // 且点击 relay 会把 groupId 塞进 activeAgentId 进入伪会话）
    if (m.groupId !== undefined) return
    // 远端 mirror 消息（P7）：归属该远端成员自己的会话（from 即 `remote:<memberId>`——
    // 原型语义：远端成员是名册一员，mirror 消息进其会话流，不再塞管家会话）
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
      kind: m.kind === 'user' ? 'msg-user' : m.kind === 'agent' ? 'msg-agent' : m.kind === 'remote' ? 'msg-remote' : 'relay',
      msgIndex: i,
    })
  })
  kernel.execs.forEach((e, i) => {
    // 群轮 exec 卡不进私聊流（isGroupRun：实况 run kind ∥ 遗留清扫集合）——操作过程归群
    if (e.runId !== undefined && kernel.isGroupRun(e.runId)) return
    if (agentOfRun(e.runId) === active) raw.push({ key: `e${i}`, at: e.at, kind: 'exec', execIndex: i })
  })
  // llm 实况双通道（v0.1.43）：think 块进思考卡；正文块按时间序作 live 消息行（终答到达由
  // store 去重让位）。agentId 直配；实况断线不补，重启后历史只有事实事件（诚实分层）
  for (const block of kernel.streams) {
    if (block.agentId !== active || block.stream !== 'llm' || block.stdout === '') continue
    // 群轮思考/正文不进私聊流（think 卡与预览气泡同判据——群轮的呈现归群视图）
    if (kernel.isGroupRun(block.runId)) continue
    if (block.think === true) {
      raw.push({ key: `t-${block.key}`, at: block.at, kind: 'think', block })
      continue
    }
    // 正文预览幂等让位（v0.1.43）：同 agent 已有文本与预览全文一致的终答 → 不渲染（内容判据
    // 精确且时序无关；中间轮正文不等任何消息文本 → 保留为过程事实）
    if (kernel.messages.some((m) => m.kind === 'agent' && m.from === active && m.text === block.stdout)) continue
    raw.push({ key: `p-${block.key}`, at: block.at, kind: 'live-msg', block })
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
    } else if (row.kind === 'live-msg') {
      // 正文 live 预览：独立单元以 agent 气泡形态呈现（store 在真消息到达时去重让位——
      // 无终答的 run（预算/失败/中止）它就是本轮正文的最后事实，保留）
      if (pendingParts.length > 0) {
        units.push({ key: `f-${row.key}`, at: partAt(pendingParts.at(-1)!), kind: 'agent', parts: pendingParts })
        pendingParts = []
      }
      units.push({ key: row.key, at: row.at, kind: 'live-msg', block: row.block!, parts: [] })
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
    } else if (row.kind === 'msg-remote') {
      // 远端 mirror（P7）：独立消息卡（不吸收思考/exec 块——那些归属本端 agent 单元）
      units.push({ key: row.key, at: row.at, kind: 'msg-remote', msgIndex: row.msgIndex, parts: [] })
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

/** 已终结块组的状态行：该 agent 最新 run 的终态文案——v0.1.43 强化：所有非正常终态都醒目
 *  交代（此前仅 aborted/failed 两条且弱呈现——「只有 think 没有终答」时用户不知为何） */
const endedOutcomeLabel = computed(() => {
  // 群轮 run 不在此交代（其终态归群流注记）——只看该 agent 的私聊/协作 run
  const last = kernel.runs.filter((r) => r.agentId === ui.activeAgentId && r.kind !== 'group').at(-1)
  if (!last) return null
  if (last.state === 'aborted') return '本轮已中止——未产出终答（过程与思考见上方）'
  if (last.state === 'failed') return (last.code ? `失败 · ${last.code}` : '失败') + '——未产出终答（过程与思考见上方）'
  if (last.state === 'escaped') return '已转后台继续——完成后结果仍会送达会话'
  if (last.state === 'reaped') return '后台已结束——终答若已产出会在上方'
  return null
})

// ---- 思考块折叠（渲染局部态——抽屉开合归 renderer，解耦纪律 #1） ----

// ---- 「会话掌控」（编辑/移出/恢复 + /clear /resume 拦截 + 引用会话选择器） ----
const editModal = reactive<{ open: boolean; messageId: string; text: string }>({ open: false, messageId: '', text: '' })
const editAreaEl = ref<HTMLTextAreaElement | null>(null)
const openEdit = (m: { messageId: string; text: string }): void => {
  editModal.open = true
  editModal.messageId = m.messageId
  editModal.text = m.text
  // autofocus 属性对动态挂载元素不生效——挂载后手动聚焦 + 全选（编辑场景惯例）
  void nextTick(() => {
    editAreaEl.value?.focus()
    editAreaEl.value?.select()
  })
}
const submitEdit = async (regenerate: boolean): Promise<void> => {
  if (editModal.text.trim() === '') return
  try {
    await kernel.sessionEdit(ui.activeAgentId, editModal.messageId, editModal.text, regenerate)
    toast.push(regenerate ? '已修订并重新生成' : '已修订（后续对话生效）', 'success')
    editModal.open = false
  } catch (err) {
    toast.push(err instanceof Error ? err.message : String(err), 'error')
  }
}
const toggleTombstone = async (m: { messageId: string; from?: string; tombstoned?: boolean }): Promise<void> => {
  const agentId = m.from ?? ui.activeAgentId
  try {
    if (m.tombstoned === true) await kernel.sessionRevive(agentId, m.messageId)
    else await kernel.sessionTombstone(agentId, m.messageId)
  } catch (err) {
    toast.push(err instanceof Error ? err.message : String(err), 'error')
  }
}
/** 发送前拦截：/clear /resume 不进消息流——直接走命令面（菜单关闭时的兜底路径）。
 *  群会话分流（2026-10-15 用户报障 /clear 群语义错位）：群上下文=群流记录，清空走群命令
 *  （清空点切窗口，成员忘记之前轮次）——此前误清 activeAgentId 的私聊会话，群上下文原封未动 */
const doSlashClear = async (): Promise<void> => {
  if (ui.activeGroupId !== null) {
    await kernel.groupClear(ui.activeGroupId)
    toast.push('群上下文已清空——成员不再记得之前的群聊（transcript 留证）', 'success')
    return
  }
  const sid = await kernel.sessionClear(ui.activeAgentId)
  toast.push(`已开启新会话 ${sid}（上下文与界面已清空，transcript 留证）`, 'success')
}
const doSlashResume = async (): Promise<void> => {
  await kernel.sessionResume(ui.activeAgentId)
  toast.push('已恢复上一会话上下文', 'success')
}

// ---- Slash 命令菜单（v0.1.46 对齐 @ 提及形态）：输入 / 联想命令；/quote 两级选会话 ----
type SlashMode = 'cmd' | 'agent' | 'session' | 'resume'
const slash = ref<{ open: boolean; mode: SlashMode; start: number; sel: number; agentId: string | null; q: string }>({
  open: false, mode: 'cmd', start: -1, sel: 0, agentId: null, q: '',
})
const slashLoading = ref(false)

/** 命令清单（子串联想；/quote 进 agent 级） */
const SLASH_COMMANDS: Array<{ name: string; sub: string }> = [
  { name: '/clear', sub: '开启新会话——上下文与界面清空（transcript 留证）' },
  { name: '/resume', sub: '选择回到某个历史会话（默认最近一个）' },
  { name: '/quote', sub: '引用某个 Agent 的会话（随下条消息注入）' },
]

const slashItems = computed<Array<{ key: string; label: string; sub: string; color?: string; note?: string }>>(() => {
  if (slash.value.mode === 'cmd') {
    return SLASH_COMMANDS.filter((c) => c.name.slice(1).startsWith(slash.value.q)).map((c) => ({ key: c.name, label: c.name, sub: c.sub }))
  }
  if (slash.value.mode === 'agent') {
    return kernel.roster.map((a) => ({
      key: a.agentId,
      label: a.name ?? a.agentId,
      sub: a.agentId,
      color: kernel.colorOf(a.agentId),
    }))
  }
  // resume 级：当前 agent 的历史会话（排除当前会话——回到当前无意义）
  if (slash.value.mode === 'resume') {
    return refPickerSessions.value
      .filter((s) => !s.current)
      .slice()
      .reverse()
      .map((s) => ({
        key: s.sessionId,
        label: s.sessionId,
        sub: `${fmtTime(s.lastAt)} · ${s.messageCount} 条`,
        note: s.firstText !== '' ? s.firstText : '（空会话）',
      }))
  }
  return refPickerSessions.value.slice().reverse().map((s) => ({
    key: s.sessionId,
    label: s.sessionId + (s.current ? '（当前）' : ''),
    sub: `${fmtTime(s.lastAt)} · ${s.messageCount} 条`,
    note: s.firstText !== '' ? s.firstText : '（空会话）',
  }))
})

const slashTitle = computed(() => {
  if (slash.value.mode === 'cmd') return '命令'
  if (slash.value.mode === 'agent') return '引用会话 · 选择 Agent'
  if (slash.value.mode === 'resume') return '恢复会话 · 选择要回到的会话'
  return `引用会话 · ${nameOf(slash.value.agentId ?? '')}`
})

const closeSlash = (): void => {
  slash.value = { open: false, mode: 'cmd', start: -1, sel: 0, agentId: null, q: '' }
}

/** 输入驱动（onComposerInput 内调用）：光标前缀 `/词` → 命令级联想；其余级随 draft 变化关闭 */
const feedSlash = (value: string, caret: number): void => {
  // agent/session 级：用户开始打字 = 放弃菜单（Backspace 回退不触发 input——键流分支保留）
  if (slash.value.open && slash.value.mode !== 'cmd') {
    closeSlash()
    return
  }
  const m = value.slice(0, caret).match(/(?:^|\s)\/([a-z]*)$/)
  if (m === null) {
    if (slash.value.mode === 'cmd') closeSlash()
    return
  }
  const q = m[1]!.toLowerCase()
  if (!SLASH_COMMANDS.some((c) => c.name.slice(1).startsWith(q))) {
    closeSlash()
    return
  }
  slash.value = { open: true, mode: 'cmd', start: caret - m[1]!.length - 1, sel: 0, agentId: null, q }
}

/** 移除 draft 中 slash 触发词（含 /；cmd 级选中或 quote 展开时） */
const removeSlashToken = (): void => {
  const el = draftEl.value
  const s = slash.value
  if (el === null || s.start < 0) return
  const caret = el.selectionStart ?? el.value.length
  ui.draft = `${ui.draft.slice(0, s.start)}${ui.draft.slice(Math.max(caret, s.start + 1))}`
  void nextTick(() => el.setSelectionRange(s.start, s.start))
}

const pickSlash = (i: number): void => {
  const s = slash.value
  const it = slashItems.value[i]
  if (it === undefined) return
  if (s.mode === 'cmd') {
    if (it.key === '/clear') {
      removeSlashToken()
      closeSlash()
      void doSlashClear().catch((err: unknown) => toast.push(String(err), 'error'))
      return
    }
    if (it.key === '/resume') {
      // v0.1.47 会话选择化：转入当前 agent 的历史会话级（默认选第一项=最近——Enter 即回上一个）
      removeSlashToken()
      slash.value = { open: true, mode: 'resume', start: -1, sel: 0, agentId: ui.activeAgentId, q: '' }
      slashLoading.value = true
      void kernel
        .listSessions(ui.activeAgentId)
        .then((list) => {
          refPickerSessions.value = list
        })
        .catch((err: unknown) => {
          toast.push(err instanceof Error ? err.message : String(err), 'error')
          closeSlash()
        })
        .finally(() => {
          slashLoading.value = false
        })
      return
    }
    // /quote：清触发词 → agent 级
    removeSlashToken()
    slash.value = { open: true, mode: 'agent', start: -1, sel: 0, agentId: null, q: '' }
    return
  }
  if (s.mode === 'agent') {
    slash.value = { open: true, mode: 'session', start: -1, sel: 0, agentId: it.key, q: '' }
    slashLoading.value = true
    void kernel
      .listSessions(it.key)
      .then((list) => {
        refPickerSessions.value = list
      })
      .catch((err: unknown) => {
        toast.push(err instanceof Error ? err.message : String(err), 'error')
        closeSlash()
      })
      .finally(() => {
        slashLoading.value = false
      })
    return
  }
  // resume 级（v0.1.47 会话选择化）：回到选定的历史会话
  if (s.mode === 'resume') {
    closeSlash()
    const target = it.key === 's-0' ? undefined : it.key // 初始段无 start——缺省语义即回退窗口
    void kernel
      .sessionResume(ui.activeAgentId, target)
      .then(() => toast.push(target !== undefined ? `已回到会话 ${target}` : '已恢复上一会话上下文', 'success'))
      .catch((err: unknown) => toast.push(err instanceof Error ? err.message : String(err), 'error'))
    return
  }
  // session 级（quote）：设置待发引用（胶囊呈现——所见即所发）
  if (s.agentId !== null) pendingRef.value = { agentId: s.agentId, sessionId: it.key === 's-0' ? null : it.key }
  closeSlash()
}

/** ＋ 菜单「引用」入口：与 /quote 同一管线（直接进 agent 级） */
const openQuoteFromMenu = (): void => {
  plusMenuOpen.value = false
  slash.value = { open: true, mode: 'agent', start: -1, sel: 0, agentId: null, q: '' }
}

/** 引用会话数据源（slash session 级复用；保留 v0.1.45 状态名） */
const refPickerSessions = ref<Array<{ sessionId: string; messageCount: number; firstText: string; lastAt: number; current: boolean }>>([])
const pendingRef = ref<{ agentId: string; sessionId: string | null } | null>(null)
const clearPendingRef = (): void => {
  pendingRef.value = null
}

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

/** 收起态摘要：首行截断。剥离 markdown 记号（审计 P2-9——折叠行预览裸奔 **加粗** 与 `code` 星号反引号） */
const thinkSummary = (block: LiveStreamBlock): string => {
  const firstLine = block.stdout.split('\n')[0] ?? ''
  const plain = firstLine
    .replaceAll('**', '')
    .replaceAll('`', '')
    .replace(/^#+\s*/, '')
    .trim()
  return plain.length > 60 ? `${plain.slice(0, 60)}…` : plain
}

/** 流滚动到底（会话切换/历史加载——双 rAF 保险：等图片/流卡撑高 DOM 后再定一次，否则
 *  滚底时高度未稳定会停在中间——「开会在顶部」的主因之一） */
const scrollToBottom = (): void => {
  void nextTick(() => {
    const el = streamEl.value
    if (el === null) return
    el.scrollTop = el.scrollHeight
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight
      }),
    )
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

// ---- 滚动定位交互（2026-09-06 用户报障「开会在顶部」）：会话切换/历史批量填充强制定底；
// 新消息贴底跟随、上翻不打扰但计数浮钮提示；非底部常驻「回到底部」、离顶显示「回顶部」 ----
const atBottom = ref(true)
const atTop = ref(true)
const newCount = ref(0)
const onStreamScroll = (): void => {
  const el = streamEl.value
  if (el === null) return
  atBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  atTop.value = el.scrollTop < 40
  if (atBottom.value) newCount.value = 0
  // 轮锚是内容坐标（不随滚动变）——滚动时只用缓存锚值算当前轮，**零 DOM 读**
  // （初版此处每 scroll 全量 querySelectorAll+强制 layout，滚动性能损耗，2026-09-06 审查修正）
  // 当前阅读位置联动高亮（2026-09-06 用户需求两轮修正后的语义）：
  // - 贴底 → 最后一轮（「读到了最新」，即使最后轮只有发送未回复）
  // - 非贴底 → 视口顶部往下**第一个可见的轮锚**（滚到最顶 = 第一个；滚到某轮顶部 = 该轮）
  const turns = railTurns.value
  if (turns.length > 0) {
    if (atBottom.value) {
      currentTurnIdx.value = turns.length - 1
    } else {
      const viewTop = el.scrollTop
      let idx = -1
      turns.forEach((t, i) => {
        if (idx >= 0) return
        const y = turnAnchors.value.get(t.key)
        if (y !== undefined && y >= viewTop) idx = i
      })
      currentTurnIdx.value = idx
    }
  }
}
const scrollToTop = (): void => {
  const el = streamEl.value
  if (el !== null) el.scrollTop = 0
}

// ---- 滚动位置映射条 v2（2026-09-06 用户对照 Claude Code 图例重做）：**按轮次等距排布**
// （用户问+Agent 答为一轮），hover 显示该轮问答摘要（两/三行省略），鼠标邻域标记波浪放大；
// 点击跳到该轮位置。视口高亮段按轮域映射（与等距标记对齐）。修复：轨道盒子动态测量
// （初版硬编码高度遮住 stream-head） ----
interface RailTurn {
  key: string // 轮首消息 id（跳转锚 data-mid）
  question: string
  answer: string
}
const railEl = ref<HTMLElement | null>(null)
const railHoverPx = ref<number | null>(null) // 鼠标在轨道内的 y（px；null=离开）
/** 轮分组（当前会话可见消息：user 开轮，后续首个 agent 回复为该轮回答） */
const railTurns = computed<RailTurn[]>(() => {
  const gid = ui.activeGroupId
  const agentId = ui.activeAgentId
  const turns: RailTurn[] = []
  kernel.messages.forEach((m) => {
    const isTurnStart = gid !== null ? m.kind === 'group-user' : m.kind === 'user' && m.to === agentId
    const isReply = gid !== null ? m.kind === 'group-agent' : m.kind === 'agent' && m.from === agentId
    if (isTurnStart) {
      turns.push({ key: m.messageId, question: m.text, answer: '' })
    } else if (isReply && turns.length > 0 && turns[turns.length - 1]!.answer === '') {
      turns[turns.length - 1]!.answer = m.text
    }
  })
  return turns
})
/** 每轮在内容流中的像素锚（data-mid 元素 offsetTop——视口段按轮域映射用） */
const turnAnchors = ref<Map<string, number>>(new Map())
const railBox = ref({ top: 52, bottom: 92 })
const trackHeight = computed(() => Math.max(60, streamEl.value?.clientHeight ?? 300))

const measureRail = (): void => {
  const el = streamEl.value
  const col = el?.parentElement ?? null
  if (el === null || col === null) return
  railBox.value = { top: el.offsetTop, bottom: Math.max(0, col.clientHeight - el.offsetTop - el.offsetHeight) }
  // 轮锚像素位（相对 .stream-inner 顶）
  const inner = el.querySelector('.stream-inner')
  const map = new Map<string, number>()
  if (inner !== null) {
    const innerTop = inner.getBoundingClientRect().top
    for (const node of Array.from(inner.querySelectorAll('[data-mid]'))) {
      const mid = (node as HTMLElement).dataset.mid
      if (mid !== undefined && !map.has(mid)) {
        map.set(mid, (node as HTMLElement).getBoundingClientRect().top - innerTop)
      }
    }
  }
  turnAnchors.value = map
}

/** 标记等距中心 y（px，轨道内）：间距收敛（上限 10px——2026-09-06 用户反馈「间隔还是大」），
 *  整体在轨道内垂直居中 */
const markSpacing = computed(() => Math.min(10, Math.max(5, trackHeight.value / Math.max(railTurns.value.length, 1))))
const markOffset = computed(() => (trackHeight.value - markSpacing.value * Math.max(railTurns.value.length - 1, 0)) / 2)
const markCenterY = (i: number): number => markOffset.value + i * markSpacing.value
/** 波浪缩放（高斯邻域）：只作用于**长度**（width × scale），粗细恒定 3px（2026-09-06 用户反馈）；
 *  峰值系数 1.0（2026-10-13 用户反馈：2.2 倍时右端 ~36px 距 stream 内容左缘 38px 仅 1.8px
 *  视觉粘连——2.0 倍右端 ~33px 恒留 ~5px 间隙，波浪形态保留） */
const markScale = (i: number): number => {
  if (railTurns.value.length === 0 || railHoverPx.value === null) return 1
  const d = railHoverPx.value - markCenterY(i)
  const sigma = Math.max(16, markSpacing.value / 1.2)
  return 1 + 1.0 * Math.exp(-(d * d) / (2 * sigma * sigma))
}

/** hover 命中的轮（最近标记）+ tooltip 位置 */
const hoveredTurn = computed<RailTurn | null>(() => {
  const n = railTurns.value.length
  if (n === 0 || railHoverPx.value === null) return null
  const idx = Math.min(n - 1, Math.max(0, Math.floor((railHoverPx.value / trackHeight.value) * n)))
  return railTurns.value[idx] ?? null
})
const railTipTop = computed(() => {
  const n = railTurns.value.length
  if (n === 0 || railHoverPx.value === null) return 0
  return Math.min(Math.max(railHoverPx.value - 40, 0), Math.max(0, trackHeight.value - 110))
})

/** 波浪 mousemove 节流（rAF 对齐——每帧至多一次响应式更新，高频 move 不重排） */
let railHoverRaf = 0
const railHoverSet = (e: MouseEvent): void => {
  const rail = railEl.value
  if (rail === null) return
  const y = e.clientY - rail.getBoundingClientRect().top
  if (railHoverRaf) cancelAnimationFrame(railHoverRaf)
  railHoverRaf = requestAnimationFrame(() => {
    railHoverRaf = 0
    railHoverPx.value = y
  })
}
const railHoverClear = (): void => {
  if (railHoverRaf) cancelAnimationFrame(railHoverRaf)
  railHoverRaf = 0
  railHoverPx.value = null
}
/** 当前阅读位置的轮（视口顶部联动——滚动时对应标记高亮，2026-09-06 用户需求） */
const currentTurnIdx = ref(-1)

/** 点击轮标记：滚到该轮位置（锚居中偏上） */
const railJumpToTurn = (turn: RailTurn): void => {
  const el = streamEl.value
  if (el === null) return
  const anchor = el.querySelector(`[data-mid="${turn.key}"]`) as HTMLElement | null
  if (anchor === null) return
  el.scrollTo({ top: Math.max(0, anchor.offsetTop - el.clientHeight / 3), behavior: 'smooth' })
}

let lastMsgCount = 0
watch(
  () => kernel.messages.length,
  (len) => {
    const delta = len - lastMsgCount
    lastMsgCount = len
    if (delta >= 3) {
      // 历史批量填充（懒加载一次性灌入）：强制定底——「开会在顶部」的主因
      scrollToBottom()
      newCount.value = 0
    } else if (delta > 0) {
      // 普通新消息：贴底跟随；上翻阅读不打扰但计数提示
      followIfNearBottom()
      if (!isNearBottom()) newCount.value += delta
    }
    void nextTick(measureRail)
  },
)
watch(
  () => [ui.activeAgentId, ui.activeGroupId],
  () => {
    // 会话切换：清计数 + 强制定底（历史异步填充期间由上面的批量分支接续保障）
    newCount.value = 0
    lastMsgCount = kernel.messages.length
    scrollToBottom()
  },
)
// 实况增长（思考增量 / 执行输出 / 流块新增与状态迁移）与进行中单元出现：贴底跟随
watch(
  () => kernel.streams.map((s) => `${s.key}:${s.stdout.length}:${s.stderr.length}:${s.state}`).join('|'),
  followIfNearBottom,
)
watch(() => kernel.runs.length, followIfNearBottom)
// 流块批量出现（历史加载的伪 exec/思考块投影）：与 messages 批量同判——强制定底
let lastStreamCount = kernel.streams.length
watch(
  () => kernel.streams.length,
  (len) => {
    const delta = len - lastStreamCount
    lastStreamCount = len
    if (delta >= 3) scrollToBottom()
    else followIfNearBottom()
    void nextTick(measureRail)
  },
)

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
/** 下拉点击外部关闭（审批模式/模型档案两菜单）——命名函数保证卸载时可解绑 */
const closeMenus = (): void => {
  modeMenuOpen.value = false
  modelMenuOpen.value = false
  plusMenuOpen.value = false
}

onMounted(() => {
  if (ui.composerFocus) consumeComposerFocus()
  document.addEventListener('click', closeMenus)
  // 映射条首算（历史/boot 场景由 messages/streams watch 接续；窗口 resize 重测轨道盒子）
  void nextTick(measureRail)
  window.addEventListener('resize', measureRail)
  // ctx 显隐动画收尾监听（grid 过渡结束同帧解锁冻结锁 + 轮锚重测；见 toggleCtxSmooth 处注释）
  consoleEl.value?.addEventListener('transitionend', onCtxGridEnd)
})
onBeforeUnmount(() => {
  window.removeEventListener('resize', measureRail)
  document.removeEventListener('click', closeMenus)
  consoleEl.value?.removeEventListener('transitionend', onCtxGridEnd)
  ctxAnimReset()
})

// 会话历史懒加载：切换会话或连接就绪时拉一次 transcript（内核重启后的持久真相；已覆盖时幂等跳过）。
// 群会话（P5 Step 4）：groupId 即 transcript 键——同一命令零新面；agent 会话空串（群在场）跳过
watch(
  () => [ui.activeAgentId, ui.activeGroupId, kernel.connected] as const,
  ([agentId, groupId, connected]) => {
    if (!connected) return
    const key = groupId ?? agentId
    if (key === '') return
    void kernel.loadHistory(key).catch(() => {})
  },
  { immediate: true },
)

/** 发送（乐观更新在 store；失败态由流内重试按钮处理） */
const sending = ref(false)

// ---- @提及（P4 Step 4 + P5 Step 2 广播）：补全菜单 + 单提及路由 + @全员/多提及扇出 + 名册命中高亮 ----

/** @全员补全 token（P5 Step 2）：保留字——全员判定优先于名册同名命中（语义明确不歧义） */
const ALL_MENTION = '全员'

/** 名册命中面（名字与 agentId 都可命中——新 agent name 缺席时 id 即名字） */
const mentionNames = computed(
  () =>
    new Set([
      ...kernel.roster.flatMap((a) => (a.name ? [a.name, a.agentId] : [a.agentId])),
      ...kernel.groups.map((g) => g.name), // 群对象（P5 Step 4）：@群名 高亮同面
    ]),
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
  feedSlash(el.value, caret) // slash 命令联想（v0.1.46——与 @ 同输入驱动）
  const m = el.value.slice(0, caret).match(/(?:^|[^一-龥A-Za-z0-9])@([一-龥A-Za-z0-9]*)$/)
  if (!m) {
    closeMention()
    return
  }
  closeSlash() // @ 打开时 slash 收起（互斥）
  const q = m[1]!.toLowerCase()
  // @全员项（P5 Step 2）：前缀命中「全员」即置顶——扇出权事实驱动（用户恒可发）
  const items: MentionItem[] = []
  if (ALL_MENTION.toLowerCase().startsWith(q)) {
    items.push({ agentId: '__all__', name: ALL_MENTION, sub: '广播', color: 'var(--accent)' })
  }
  items.push(
    ...kernel.roster
      .map((a) => ({
        agentId: a.agentId,
        name: a.name ?? a.agentId,
        sub: a.role === 'steward' ? '管家' : 'worker',
        color: a.color,
      }))
      .filter((it) => it.name.toLowerCase().startsWith(q) || it.agentId.toLowerCase().startsWith(q)),
  )
  // 群对象（P5 Step 4，原型「产品评审组 · 群聊 · 有界轮转」同位）：@群名 → 消息发群并跟随跳转
  items.push(
    ...kernel.groups
      .filter((g) => g.name.toLowerCase().startsWith(q))
      .map((g) => ({ agentId: g.groupId, name: g.name, sub: '群聊 · 有界轮转', color: 'var(--ink3)' })),
  )
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
  if (slash.value.open) {
    const n = slashItems.value.length
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      slash.value.sel = (slash.value.sel + (e.key === 'ArrowDown' ? 1 : -1) + n) % n
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault()
      pickSlash(slash.value.sel)
    } else if (e.key === 'Escape') {
      e.stopPropagation()
      closeSlash()
    } else if (e.key === 'Backspace' && slash.value.mode !== 'cmd') {
      // agent/session 级回退一级（cmd 级回退交给文本编辑自然关闭）
      e.preventDefault()
      if (slash.value.mode === 'session') slash.value = { open: true, mode: 'agent', start: -1, sel: 0, agentId: null, q: '' }
      else closeSlash() // resume 级无上级——直接关
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
  window.setTimeout(closeSlash, 120)
}

// ---- composer 工具行下拉（2026-09-06 图 1/3）：审批模式 + 模型档案 ----
const modeMenuOpen = ref(false)
const modelMenuOpen = ref(false)
const plusMenuOpen = ref(false)
const modelLabel = computed(() => kernel.llmStatus?.primary ?? kernel.defaultProvider ?? '未配置模型')

const setApprovalMode = (mode: 'manual' | 'auto'): void => {
  kernel.setApprovalMode(mode).catch((err: unknown) => {
    useToastStore().push(`审批模式切换失败：${err instanceof Error ? err.message : String(err)}`, 'danger')
  })
  modeMenuOpen.value = false
}

/** 模型菜单项（v2 供应商 1:N 模型）：拉平「供应商 · 模型」——默认粒度到模型级 */
const modelMenuItems = computed(() =>
  kernel.providers.flatMap((p) => p.models.map((m) => ({ provider: p.name, model: m.id }))),
)

const pickModel = (provider: string, model?: string): void => {
  void kernel.setDefaultProvider(provider, model).then(() => {
    void kernel.refreshLlmStatus()
  })
  modelMenuOpen.value = false
}

const goModelSettings = (): void => {
  modelMenuOpen.value = false
  ui.switchView('settings')
}

/** 工具行 @ 按钮：在光标处插入 @ 触发符并打开提及菜单（与手输 @ 同一管线） */
const insertMentionTrigger = (): void => {
  const el = draftEl.value
  // 断连/远端只读会话：composer 不可用——注入也无意义（防脏 draft）
  if (!el || !kernel.connected || remotePeer !== null) return
  el.focus()
  const caret = el.selectionStart ?? el.value.length
  ui.draft = `${ui.draft.slice(0, caret)}@${ui.draft.slice(caret)}`
  void nextTick(() => {
    const pos = caret + 1
    el.setSelectionRange(pos, pos)
    onComposerInput() // 与手输 @ 同一触发管线（mention 状态机由此驱动）
  })
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

/** 文本中提及的群（P5 Step 4）：命中面=群名——@群名 → 消息发群（内核有界轮转）并跟随跳转 */
const mentionedGroups = (text: string): GroupEntry[] => {
  const found = new Set<string>()
  for (const m of text.matchAll(/(?:^|[^一-龥A-Za-z0-9])@([一-龥A-Za-z0-9]+)/g)) {
    const hit = kernel.groups.find((g) => g.name === m[1])
    if (hit) found.add(hit.groupId)
  }
  return [...found].map((id) => kernel.groups.find((g) => g.groupId === id)!)
}

/** 文本含 @全员 token（P5 Step 2）：前置非名字字符 + 后置非名字字符（防「@全员们」误命中）；
 *  全员 token 保留字——判定先于名册同名命中 */
const mentionsAll = (text: string): boolean =>
  new RegExp(`(?:^|[^一-龥A-Za-z0-9])@${ALL_MENTION}(?![一-龥A-Za-z0-9])`).test(text)

const send = async (): Promise<void> => {
  const text = ui.draft.trim()
  if (text === '' || sending.value) return
  // 群会话（P5 Step 4）：直达群命令（内核有界轮转——supersede/上限/幂等在编排层）；
  // 群内 @提及是轮转优先信号（内核识别），不做单发路由
  if (ui.activeGroupId !== null) {
    const groupId = ui.activeGroupId
    ui.draft = ''
    sending.value = true
    try {
      await kernel.sendGroupMessage(groupId, text)
    } catch {
      // 失败已标记在消息条目上（流内显示重试——同用户消息路径）
    } finally {
      sending.value = false
      draftEl.value?.focus()
    }
    return
  }
  // 扇出/群路由分流（P5 Step 2 裁定 C + P5 Step 4 群对象）：@全员（名册全量）、@多提及（提及者列表）
  // → 内核 fanout 一次命令原子受理；@群名 → 消息发群（轮转）并跟随跳转；纯群提及不发给当前会话
  // agent（意图是进群——与 P4 单提及路由同语义）；单提及路由（P4 语义）保持——唯一提及且非当前
  // 会话对象则跳转跟随
  const all = mentionsAll(text)
  const targets = mentionedAgents(text)
  const groupTargets = mentionedGroups(text)
  if (all || targets.length > 1 || groupTargets.length > 0) {
    ui.draft = ''
    sending.value = true
    try {
      for (const g of groupTargets) await kernel.sendGroupMessage(g.groupId, text)
      if (all || targets.length > 1) {
        const recipients = all ? kernel.roster.map((a) => a.agentId) : targets
        const acc = await kernel.fanoutMessage(recipients, text)
        const names = acc.recipients
          .map((r) => kernel.roster.find((a) => a.agentId === r.agentId)?.name ?? r.agentId)
          .join('、')
        toast.push(`已广播给 ${acc.recipients.length} 人：${names}`, 'success')
      } else if (targets.length === 1) {
        // 单 agent 提及 + 群提及混合：agent 部分照常单发（跟随跳转交给群）
        await kernel.sendUserMessage(targets[0]!, text)
      }
      if (groupTargets.length > 0) ui.openGroup(groupTargets[groupTargets.length - 1]!.groupId)
    } catch (err) {
      toast.push(`${all || targets.length > 1 ? '广播' : '发送'}失败：${err instanceof Error ? err.message : String(err)}`, 'danger')
    } finally {
      sending.value = false
      draftEl.value?.focus()
    }
    return
  }
  let to = ui.activeAgentId
  if (targets.length === 1 && targets[0] !== ui.activeAgentId) {
    to = targets[0]
    ui.openAgent(to)
  }
  ui.draft = ''
  sending.value = true
  try {
    await kernel.sendUserMessage(to, text, undefined, pendingRef.value ?? undefined)
    pendingRef.value = null // 引用一次性消费（随这条消息走）
  } catch {
    // 失败已标记在消息条目上（流内显示重试）——不弹全局错误
  } finally {
    sending.value = false
    draftEl.value?.focus()
  }
}

/** 失败条目重试：同 nonce 重发（账本幂等，零双发）——群消息走群命令（P5 Step 4 分流） */
const retry = (index: number): void => {
  const m = kernel.messages[index]
  if (!m || m.messageId[0] !== '~') return
  const nonce = m.messageId.slice(1)
  if (m.kind === 'group-user' && m.groupId) {
    void kernel.sendGroupMessage(m.groupId, m.text, nonce).catch(() => {})
    return
  }
  void kernel.sendUserMessage(m.to, m.text, nonce).catch(() => {})
}

const resolveGate = (nonce: string, decision: 'approved' | 'denied'): void => {
  void kernel.resolveApproval(nonce, decision).catch(() => {})
}

/** ctx 收起开关图标（原型 ICONS.panelcol/panelexp 同款 path） */
const PANELCOL = '<rect x="3.5" y="5" width="17" height="14" rx="2"/><path d="M14.5 5v14"/><path d="M11 10.5L8.5 12l2.5 1.5"/>'
const PANELEXP = '<rect x="3.5" y="5" width="17" height="14" rx="2"/><path d="M14.5 5v14"/><path d="M8 10.5L10.5 12 8 13.5"/>'
/** 档案入口图标（CommandPalette ICONS.sliders 同源） */
const SLIDERS = '<path d="M4 8h9M17 8h3M4 16h3M11 16h9"/><circle cx="15" cy="8" r="2.2"/><circle cx="9" cy="16" r="2.2"/>'
/** 群头像图标（2026-10-15：与 RosterPanel/CtxPanel GROUP_ICON 同源 path；视图 0 0 24 24） */
const GROUP_ICON =
  '<path d="M9.3 4.6a3 3 0 1 0 0 6 3 3 0 0 0 0-6M3.2 19.5c0-3.3 2.7-5.4 6.1-5.4 1.7 0 3.2.6 4.3 1.6M16.9 6a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5M16.4 14.3c2.7.3 4.5 2.1 4.5 4.9"/>'
</script>

<template>
  <section ref="consoleEl" class="console" :class="{ 'no-ctx': ui.ctxCollapsed }">
    <RosterPanel />

    <div class="streamcol">
      <div class="stream-head">
        <div v-if="activeGroup" class="avatar avatar-group">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" v-html="GROUP_ICON"></svg>
        </div>
        <!-- v0.1.65：agent 头像 → BotBall 小球（身份色染身）；2026-10-15：群头像「群」字 → 双人图标（名册/档案同款中性底） -->
        <div v-else class="avatar">
          <BotBallAvatar :color="kernel.colorOf(ui.activeAgentId)" :state="activeRun !== null ? 'working' : 'idle'" />
        </div>
        <div class="sh-text">
          <div class="sh-name">{{ sessionTitle }}</div>
          <div class="sh-status">
            <span v-if="activeGroup" class="chip chip-accent">群聊 · {{ activeGroup.members.length }} 成员 · 有界轮转</span>
            <span v-if="activeGroup && groupBusy" class="sh-warn">轮转中…</span>
            <span v-if="!activeGroup && activeAgent?.role === 'steward'" class="chip chip-accent">管家</span>
            <span v-if="!kernel.providerConfigured" class="sh-warn">模型端点未配置——回复将失败，去「设置」配置</span>
            <span v-else-if="kernel.connected">已连接</span>
          </div>
        </div>
        <!-- 操作区（P4 Step 6/7）：ctx 开关 + 该会话的档案（Settings）；通知/会话信息无动作源——裁剪不放假 -->
        <div class="sh-actions">
          <button
            class="sh-icon"
            type="button"
            :class="{ 'is-on': ui.ctxSettings }"
            :aria-pressed="ui.ctxSettings"
            :title="ui.ctxSettings ? '返回执行画面' : '会话档案'"
            @click="openCtxSettings"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true" v-html="SLIDERS"></svg>
          </button>
          <button
            class="sh-icon"
            type="button"
            :aria-pressed="!ui.ctxCollapsed"
            :title="ui.ctxCollapsed ? '展开上下文面板' : '收起上下文面板'"
            @click="toggleCtxSmooth"
          >
            <!-- 图标=状态指示（2026-10-13 用户目验裁定互换）：收起态显收拢形、展开态显展开形 -->
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" v-html="ui.ctxCollapsed ? PANELCOL : PANELEXP"></svg>
          </button>
        </div>
      </div>

      <!-- 滚动位置映射条 v2（2026-09-06 按 Claude Code 图例）：轮次等距排布 + hover 问答摘要
           （两/三行省略）+ 鼠标邻域波浪放大 + 点击跳转该轮；视口段按轮域映射 -->
      <div
        ref="railEl"
        class="stream-rail"
        :style="{ top: `${railBox.top}px`, bottom: `${railBox.bottom}px` }"
        @mousemove="railHoverSet"
        @mouseleave="railHoverClear"
      >
        <button
          v-for="(t, i) in railTurns"
          :key="t.key"
          class="rail-mark"
          :class="{ 'is-current': i === currentTurnIdx }"
          :style="{
            top: `${markCenterY(i) - 1.5}px`,
            width: `${Math.round(16 * (markScale(i) > 1 ? markScale(i) : i === currentTurnIdx ? 1.35 : 1))}px`,
            opacity: i === currentTurnIdx || markScale(i) > 1 ? 1 : 0.65,
          }"
          @click.stop="railJumpToTurn(t)"
        />
        <div
          v-if="hoveredTurn !== null"
          class="rail-tip"
          :style="{ top: `${railTipTop}px` }"
        >
          <p v-if="hoveredTurn.question !== ''" class="rail-tip-q">{{ hoveredTurn.question }}</p>
          <p v-else class="rail-tip-q dim">（无用户提问）</p>
          <p v-if="hoveredTurn.answer !== ''" class="rail-tip-a">{{ hoveredTurn.answer }}</p>
          <p v-else class="rail-tip-a dim">（尚未回复）</p>
        </div>
      </div>

      <!-- stream-empty（2026-10-15 用户需求）：流区无内容时整层 flex 居中（含 bootError/群空态同款）；
           stream-inner 结构与样式不动（轮锚测量依赖、消息流 margin 折叠不受 flex 化影响）；
           群聊判定看实质对话（groupUnitsEmpty）——群消息不走 streamUnits 过滤链 -->
      <div
        ref="streamEl"
        class="stream"
        :class="{ 'stream-empty': activeGroup ? groupUnitsEmpty : streamUnits.length === 0 }"
        @scroll.passive="onStreamScroll"
      >
        <div ref="streamInnerEl" class="stream-inner">
          <p v-if="kernel.bootError" class="placeholder">内核未连接：{{ kernel.bootError }}</p>

          <!-- 群聊流（P5 Step 4）：群消息没有 think/exec 卡（过程归成员各自会话）——
               用户气泡 + 成员发言（身份色署名）+ sysnote 系统注记（建群/缺席/收敛） -->
          <template v-else-if="activeGroup">
            <!-- 空态（2026-10-15 用户需求）：与 Agent 空态同款（icon + 问候语，图标同源内联）——
                 无实质对话（user/agent）时 sysnote/divider 不呈现（建群/清空注记留底账，开聊后随流留痕）；
                 取代旧纯文本空态（其 length===0 判定因建群必落建群 sysnote 恒不可达） -->
            <div v-if="groupUnitsEmpty" class="placeholder">
              <div class="placeholder-icon" aria-hidden="true">
                <svg width="52" height="52" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path><circle cx="8.5" cy="10" r="1.2" fill="currentColor" stroke="none"></circle><circle cx="12" cy="10" r="1.2" fill="currentColor" stroke="none"></circle><circle cx="15.5" cy="10" r="1.2" fill="currentColor" stroke="none"></circle></svg>
              </div>
              <div>我们能帮您做些什么？</div>
            </div>
            <template v-else>
              <template v-for="unit in groupUnits" :key="unit.key">
                <div v-if="unit.kind === 'divider'" class="day-divider">{{ fmtDay(unit.at) }}</div>
                <div v-else-if="unit.kind === 'sys'" class="sysnote">{{ kernel.messages[unit.msgIndex]!.text }}</div>
                <div v-else-if="unit.kind === 'user'" class="m user" :data-mid="kernel.messages[unit.msgIndex]!.messageId">
                  <div class="m-body">
                    <div class="m-meta">
                      <span class="m-name">你</span>
                      <span class="m-time">{{ fmtTime(unit.at) }}</span>
                      <span v-if="kernel.messages[unit.msgIndex]!.pending" class="m-state">发送中…</span>
                      <button v-else-if="kernel.messages[unit.msgIndex]!.failed" class="m-retry" @click="retry(unit.msgIndex!)">发送失败 · 重试</button>
                    </div>
                    <div class="m-text" v-html="mentionify(kernel.messages[unit.msgIndex]!.text, mentionNames)"></div>
                  </div>
                </div>
                <div v-else class="m">
                  <!-- v0.1.66：消息流头像移除（用户裁定）——归属靠署名色（m-name 保留） -->
                  <div class="m-body">
                    <div class="m-meta">
                      <span class="m-name" :style="{ color: kernel.colorOf(kernel.messages[unit.msgIndex]!.from) }">
                        {{ nameOf(kernel.messages[unit.msgIndex]!.from) }}
                      </span>
                      <span class="m-time">{{ fmtTime(unit.at) }}</span>
                    </div>
                    <div class="m-text md" v-html="renderMarkdown(kernel.messages[unit.msgIndex]!.text, mentionNames)"></div>
                  </div>
                </div>
              </template>
              <!-- 轮转占位（与私聊同款结构——.m-text.typing .dot 三点动画） -->
              <div v-if="groupBusy" class="m-text typing" aria-label="成员轮转中">
                <span class="dot"></span><span class="dot"></span><span class="dot"></span>
              </div>
            </template>
          </template>

          <!-- 空态：icon + 文案（2026-10-13 用户需求，视觉语言参考跨用户房间空态）——
               管家在场是 Agent 的一句问候；空缺分支如实报缺（图标两分支同显——空会话语义一致） -->
          <div v-else-if="streamUnits.length === 0" class="placeholder">
            <div class="placeholder-icon" aria-hidden="true">
              <svg width="52" height="52" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path><circle cx="8.5" cy="10" r="1.2" fill="currentColor" stroke="none"></circle><circle cx="12" cy="10" r="1.2" fill="currentColor" stroke="none"></circle><circle cx="15.5" cy="10" r="1.2" fill="currentColor" stroke="none"></circle></svg>
            </div>
            <div>{{ kernel.stewardId ? '我能帮您做些什么？' : '管家空缺：等待首个 Agent 被任命' }}</div>
          </div>

          <template v-for="unit in streamUnits" :key="unit.key">
            <div v-if="unit.kind === 'divider'" class="day-divider">{{ fmtDay(unit.at) }}</div>

            <!-- user 消息（右对齐气泡；「会话掌控」hover 编辑 + 引用胶囊） -->
            <div v-else-if="unit.kind === 'msg-user'" class="m user" :data-mid="kernel.messages[unit.msgIndex]!.messageId">
              <div class="m-body">
                <div class="m-meta">
                  <span class="m-name">你</span>
                  <span class="m-time">{{ fmtTime(unit.at) }}</span>
                  <span v-if="kernel.messages[unit.msgIndex!]!.pending" class="m-state">发送中…</span>
                  <button v-else-if="kernel.messages[unit.msgIndex!]!.failed" class="m-retry" @click="retry(unit.msgIndex!)">发送失败 · 重试</button>
                  <button
                    v-if="!kernel.messages[unit.msgIndex!]!.pending && !kernel.messages[unit.msgIndex!]!.failed"
                    class="m-act"
                    title="编辑这条消息"
                    @click="openEdit(kernel.messages[unit.msgIndex!]!)"
                  >编辑</button>
                </div>
                <div v-if="kernel.messages[unit.msgIndex!]!.sessionRef" class="m-ref-chip">引用日期 {{ kernel.messages[unit.msgIndex!]!.sessionRef!.agentId }} · {{ kernel.messages[unit.msgIndex!]!.sessionRef!.sessionId ?? '初始会话' }}</div>
                <div class="m-text" v-html="mentionify(kernel.messages[unit.msgIndex!]!.text, mentionNames)"></div>
              </div>
            </div>

            <!-- 远端 mirror 消息（P7）：房间成员发言——署名远端名 + 远端标识；
                 渲染走同一 renderMarkdown（DOMPurify 链——远端内容必净化的协议约束） -->
            <div v-else-if="unit.kind === 'msg-remote'" class="m">
              <div class="m-body">
                <div class="m-meta">
                  <span class="m-name">{{ kernel.messages[unit.msgIndex!]!.speakerName ?? '远端成员' }}</span>
                  <span class="m-state">房间 · 远端</span>
                  <span class="m-time">{{ fmtTime(unit.at) }}</span>
                </div>
                <div class="m-text md" v-html="renderMarkdown(kernel.messages[unit.msgIndex!]!.text, mentionNames)"></div>
              </div>
            </div>

            <button v-else-if="unit.kind === 'relay'" class="relay" :title="`跳到 ${kernel.messages[unit.msgIndex!]!.to} 的会话`" @click="ui.activeAgentId = kernel.messages[unit.msgIndex!]!.to">
              <!-- v0.1.48：行首装饰箭头移除（与 from → to 箭头重复致语义不清——「→ steward → worker1」两个箭头各司其职但视觉混淆） -->
              <span class="relay-text">
                <b :style="{ color: kernel.colorOf(kernel.messages[unit.msgIndex!]!.from) }">{{ kernel.messages[unit.msgIndex!]!.from }}</b>
                <svg class="relay-chev" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-label="转发给" role="img"><path d="M9 6l6 6-6 6" /></svg>
                <b :style="{ color: kernel.colorOf(kernel.messages[unit.msgIndex!]!.to) }">{{ kernel.messages[unit.msgIndex!]!.to }}</b>
                · <span v-html="mentionify(kernel.messages[unit.msgIndex!]!.text, mentionNames)"></span>
              </span>
              <span class="m-time">{{ fmtTime(unit.at) }}</span>
            </button>

            <!-- 正文 live 预览（v0.1.43 双通道）：正在生成的正文以 agent 气泡形态流式呈现——
                 终答消息到达由 store 去重让位；无终答的 run 它就是本轮正文的最后事实 -->
            <div v-else-if="unit.kind === 'live-msg'" class="m" :data-livemsg="unit.block.key">
              <div class="m-body">
                <div class="m-meta">
                  <span class="m-name" :style="{ color: kernel.colorOf(ui.activeAgentId) }">{{ nameOf(ui.activeAgentId) }}</span>
                  <span v-if="unit.block.state === 'live'" class="m-state">生成中…</span>
                  <span class="m-time">{{ fmtTime(unit.at) }}</span>
                </div>
                <div class="m-text md" v-html="renderMarkdown(unit.block.stdout, mentionNames)"></div>
                <span v-if="unit.block.state === 'live'" class="think-caret"></span>
              </div>
            </div>

            <!-- agent 聚合单元（含进行中/纯块组）：m-name 之下——思考块（可折叠）与 task 卡，最终文本（或三个点占位）收尾 -->
            <div v-else class="m">
              <div class="m-body">
                <div class="m-meta">
                  <span class="m-name" :style="{ color: kernel.colorOf(ui.activeAgentId) }">
                    {{ activeAgent?.name ?? ui.activeAgentId }}
                  </span>
                  <span v-if="unit.kind === 'pending'" class="m-state">工作中…</span>
                  <button
                    v-if="unit.kind === 'pending' && activeRun"
                    class="m-stop"
                    :disabled="cancellingRunId === activeRun.runId"
                    title="中止当前执行"
                    @click="cancelActive"
                  >
                    {{ cancellingRunId === activeRun.runId ? '正在中止…' : '中止' }}
                  </button>
                  <!-- 已终结的无终答块组（run aborted/failed）：终态事实行，不再冒充进行中 -->
                  <span v-else-if="unit.kind === 'ended' && endedOutcomeLabel" class="m-state">{{ endedOutcomeLabel }}</span>
                  <span v-else-if="unit.msgIndex !== undefined" class="m-time">{{ fmtTime(unit.at) }}</span>
                  <button
                    v-if="unit.msgIndex !== undefined && kernel.messages[unit.msgIndex]!.kind === 'agent' && unit.kind !== 'pending'"
                    class="m-act"
                    :title="kernel.messages[unit.msgIndex!]!.tombstoned ? '恢复进上下文' : '移出上下文（保留记录）'"
                    @click="toggleTombstone(kernel.messages[unit.msgIndex!]!)"
                  >{{ kernel.messages[unit.msgIndex!]!.tombstoned ? '恢复' : '移出' }}</button>
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
                <div v-if="unit.msgIndex !== undefined" class="m-text md" :class="{ 'is-tombstoned': kernel.messages[unit.msgIndex]!.tombstoned }" v-html="renderMarkdown(kernel.messages[unit.msgIndex]!.text, mentionNames)"></div>
                <div v-if="unit.msgIndex !== undefined && kernel.messages[unit.msgIndex]!.tombstoned" class="m-tomb-note">已移出上下文（记录保留，后续对话不再携带）</div>
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
              Agent <b>{{ approval.agentId }}</b> 请求执行
              <b class="mono">{{ approval.tool }}</b>
              <span v-if="approval.reason">——{{ approval.reason }}</span>
            </div>
            <div class="gate-actions">
              <button class="btn btn-primary btn-sm" @click="resolveGate(approval.nonce, 'approved')">批准</button>
              <button class="btn btn-danger-ghost btn-sm" @click="resolveGate(approval.nonce, 'denied')">拒绝</button>
            </div>
          </div>

          <!-- 编辑消息模态（「会话掌控」· v0.1.47 重设计）：轻量专用卡——不再复向导骨架；
               舒适 textarea（正文非代码不 mono）+ 分行动作说明 + 三键明确层次 -->
          <div v-if="editModal.open" class="wiz-overlay" @mousedown.self="editModal.open = false">
            <div class="edit-card" role="dialog" aria-label="编辑消息" @keydown.escape="editModal.open = false">
              <div class="edit-head">
                <span class="edit-title">编辑消息</span>
                <span class="edit-sub">修改后，这条消息之后的对话可以保留或重写</span>
                <button class="wiz-close" type="button" aria-label="关闭" @click="editModal.open = false">✕</button>
              </div>
              <textarea
                ref="editAreaEl"
                v-model="editModal.text"
                class="edit-textarea"
                aria-label="修订文本"
                data-role="edit-textarea"
              ></textarea>
              <div class="edit-actions">
                <button class="btn btn-ghost btn-sm" @click="editModal.open = false">取消</button>
                <div class="edit-actions-group">
                  <button class="btn btn-secondary btn-sm" :disabled="editModal.text.trim() === ''" title="后续对话使用新文本，本轮已生成的回复保留" @click="submitEdit(false)">
                    仅修订<span class="edit-act-hint">保留已回复</span>
                  </button>
                  <button class="btn btn-primary btn-sm" :disabled="editModal.text.trim() === ''" title="从这条消息截断重新生成——旧时间线折叠保留" @click="submitEdit(true)">
                    修订并重新生成<span class="edit-act-hint">重写回复</span>
                  </button>
                </div>
              </div>
            </div>
          </div>

        </div>
      </div>

      <!-- 滚动定位浮钮（2026-09-06 用户报障「开会在顶部」）：非底部显示回到底部/
           新消息计数；离顶显示回顶部。轻量跳转交互（图中滚动条映射重，记档不做） -->
      <div class="stream-jumps">
        <button v-if="!atTop" class="jump-btn" title="回到顶部" @click="scrollToTop">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 15l-6-6-6 6" /></svg>
        </button>
        <button v-if="!atBottom" class="jump-btn primary" title="回到底部" @click="scrollToBottom">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
          <span v-if="newCount > 0">{{ newCount }} 条新消息</span>
        </button>
      </div>

      <div class="composer">
        <!-- @提及菜单（原型挂 .composer 下，向上弹出——left/right 18px 对齐 composer 内容区） -->
        <div class="composer-inner">
          <!-- 待发引用胶囊（「会话掌控」· v0.1.45）：选中后常驻输入框上方——所见即所发 -->
          <div v-if="pendingRef !== null" class="ref-pending" data-role="ref-pending">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /></svg>
            <span>将引用 <b>{{ nameOf(pendingRef.agentId) }}</b> 的会话 <b class="mono">{{ pendingRef.sessionId ?? '初始' }}</b></span>
            <button type="button" aria-label="移除引用" @click="clearPendingRef">✕</button>
          </div>
          <div class="composer-box" :class="{ disabled: !kernel.connected || remotePeer !== null }">
        <MentionMenu
          v-if="mention.open"
          :items="mention.items"
          :sel="mention.sel"
          @pick="pickMention"
        />
        <SlashMenu
          v-if="slash.open"
          :title="slashTitle"
          :items="slashItems"
          :sel="slash.sel"
          :loading="slashLoading"
          @pick="pickSlash"
        />
            <input
              ref="draftEl"
              v-model="ui.draft"
              :placeholder="remotePeer !== null ? `远端镜像会话（${remotePeer.displayName}）· 只读——对话经中继转发到达` : `对 ${activeAgent?.name ?? ui.activeAgentId} 说…（Enter 发送）`"
              :disabled="!kernel.connected || remotePeer !== null"
              autocomplete="off"
              @input="onComposerInput"
              @blur="onComposerBlur"
              @keydown="onComposerKeydown"
            />
            <!-- 工具行（2026-09-06 按 Claude/智谱图例重构）：上输入区 / 下工具行——
                 左：@提及（真实功能）+ 审批模式真值；右：主力模型真值 + 圆形上箭头发送 -->
            <div class="cb-tools">
              <div class="cb-tools-left">
                <!-- + 弹出菜单（2026-09-06 图例）：添加上下文（@提及——真实管线）。
                     附件/能力(/)/技能($) 无底层支撑不做（不造假纪律，记档 backlog） -->
                <div class="cb-dd cb-dd-left">
                  <button class="cb-tool" title="添加" @click.stop="plusMenuOpen = !plusMenuOpen; modelMenuOpen = false; modeMenuOpen = false">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
                  </button>
                  <div v-if="plusMenuOpen" class="cb-menu" @click.stop>
                    <button class="cb-menu-item" @click="insertMentionTrigger(); plusMenuOpen = false">
                      <svg class="mi" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4" /><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8" /></svg>
                      <span class="mt"><span class="ti">使用 @ 添加上下文</span></span>
                    </button>
                    <button class="cb-menu-item" @click="openQuoteFromMenu()">
                      <svg class="mi" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /></svg>
                      <span class="mt"><span class="ti">引用某个 Agent 的会话</span><span class="ts">随下条消息注入被引会话内容</span></span>
                    </button>
                  </div>
                </div>
                <!-- 审批模式下拉（2026-09-06 图 1）：manual=变更前确认 / auto=完全访问（热切换） -->
                <div class="cb-dd">
                  <button class="cb-chip" :class="{ open: modeMenuOpen }" @click.stop="modeMenuOpen = !modeMenuOpen; modelMenuOpen = false; plusMenuOpen = false">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></svg>
                    {{ kernel.approvalMode === 'auto' ? '完全访问' : '变更前确认' }}
                    <svg class="chev" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
                  </button>
                  <div v-if="modeMenuOpen" class="cb-menu" @click.stop>
                    <button class="cb-menu-item" :class="{ on: kernel.approvalMode === 'manual' }" @click="setApprovalMode('manual')">
                      <svg class="mi" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /><path d="M9 12l2 2 4-4" /></svg>
                      <span class="mt">
                        <span class="ti">变更前确认</span>
                        <span class="ts">出 Box 操作先问你。</span>
                      </span>
                      <svg v-if="kernel.approvalMode === 'manual'" class="mk" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6L9 17l-5-5" /></svg>
                    </button>
                    <button class="cb-menu-item" :class="{ on: kernel.approvalMode === 'auto' }" @click="setApprovalMode('auto')">
                      <svg class="mi" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" /></svg>
                      <span class="mt">
                        <span class="ti">完全访问</span>
                        <span class="ts">自动批准，减少确认次数。</span>
                      </span>
                      <svg v-if="kernel.approvalMode === 'auto'" class="mk" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6L9 17l-5-5" /></svg>
                    </button>
                  </div>
                </div>
              </div>
              <div class="cb-tools-right">
                <!-- 模型下拉（2026-09-06 图 3）：档案清单 + 当前勾选 + 管理模型入口 -->
                <div class="cb-dd">
                  <button class="cb-chip" :class="{ open: modelMenuOpen }" @click.stop="modelMenuOpen = !modelMenuOpen; modeMenuOpen = false; plusMenuOpen = false">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18M3 12h18" /></svg>
                    {{ modelLabel }}
                    <svg class="chev" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
                  </button>
                  <div v-if="modelMenuOpen" class="cb-menu" @click.stop>
                    <div class="cb-menu-head">模型档案</div>
                    <button
                      v-for="it in modelMenuItems"
                      :key="it.provider + '::' + it.model"
                      class="cb-menu-item"
                      :class="{ on: kernel.defaultProvider === it.provider && (kernel.defaultModel === it.model || kernel.defaultModel === null) }"
                      @click="pickModel(it.provider, it.model)"
                    >
                      <span class="mt">
                        <span class="ti">{{ it.provider }}</span>
                        <span class="ts">{{ it.model }}</span>
                      </span>
                      <svg v-if="kernel.defaultProvider === it.provider && (kernel.defaultModel === it.model || kernel.defaultModel === null)" class="mk" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6L9 17l-5-5" /></svg>
                    </button>
                    <div class="cb-menu-sep" />
                    <button class="cb-menu-item" @click="goModelSettings">
                      <span class="mt"><span class="ti">管理模型</span></span>
                    </button>
                  </div>
                </div>
                <!-- 双态：run 进行中且未打字 → 中止（打字中保留发送=steer 能力） -->
                <button
                  v-if="!activeRun || ui.draft.trim() !== ''"
                  class="cb-send"
                  :disabled="!kernel.connected || ui.draft.trim() === '' || sending"
                  title="发送（Enter）"
                  @click="send"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7" /></svg>
                </button>
                <button
                  v-else
                  class="cb-send cb-stop"
                  :disabled="cancellingRunId === activeRun.runId"
                  :title="cancellingRunId === activeRun.runId ? '正在中止…' : '中止当前执行'"
                  @click="cancelActive"
                >
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2.5"/></svg>
                  {{ cancellingRunId === activeRun.runId ? '正在中止…' : '中止' }}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 右栏：ctx 实况面板（llm 打字机 + Box 命令输出；原型 #11 标注位） -->
    <CtxPanel />
  </section>
</template>

<style scoped src="./console.css"></style>
