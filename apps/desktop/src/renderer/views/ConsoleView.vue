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
import type { AttachmentMeta } from '../stores/kernel'
import { useUiStore } from '../stores/ui'
import { useToastStore } from '../stores/toast'
import { failureText } from '../lib/llm-failure'
import { isPreviewDup } from '../lib/preview-dup'
import { loadBucket, pushHistory } from '../lib/input-history'
import { renderMarkdown } from '../lib/markdown'
import { mentionify } from '../lib/mention'
import RosterPanel from '../components/RosterPanel.vue'
import BotBallAvatar from '../components/BotBallAvatar.vue'
import CtxPanel from '../components/CtxPanel.vue'
import FileBadge from '../components/FileBadge.vue'
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

/** 会话列表时间（2026-10-18 用户需求）：<24h 相对时间（刚刚/N 分钟以前/N 小时以前），
 *  更早带日期（同年 M月D日 HH:mm；跨年补年份）。快照语义——列表打开时定格，不逐秒跳动 */
const fmtSessionTime = (at: number): string => {
  const diff = Date.now() - at
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟以前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时以前`
  const d = new Date(at)
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  const md = `${d.getMonth() + 1}月${d.getDate()}日`
  return d.getFullYear() === new Date().getFullYear() ? `${md} ${hm}` : `${d.getFullYear()}年${md} ${hm}`
}

/** 会话 id 次行显示（UUID 截短前 8 位；旧 s-N 短格式原样） */
const shortSessionId = (id: string): string => (id.length > 13 ? `${id.slice(0, 8)}…` : id)

/** 会话列表项标签（2026-10-18 用户需求）：标题（内核首问后异步生成的工作总结）→
 *  首问截断（旧数据回退）→ 无标题占位 */
const sessionLabel = (s: { title?: string; firstText: string }): string => {
  if (s.title !== undefined && s.title !== '') return s.title
  const firstLine = (s.firstText.split('\n')[0] ?? '').replace(/[*`#>]/g, '').trim()
  if (firstLine === '') return '（无标题）'
  return firstLine.length > 30 ? `${firstLine.slice(0, 30)}…` : firstLine
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
  kind: 'divider' | 'msg-user' | 'msg-remote' | 'relay' | 'agent' | 'pending' | 'ended' | 'note'
  /** msg-user / msg-remote / relay / agent（最终消息；块组与进行中单元无） */
  msgIndex?: number
  parts: UnitPart[]
  /** note（compact 注记）：系统行文案 */
  noteText?: string
}

/** 组成部分的发生时间（flush/进行中单元的排序值） */
const partAt = (part: UnitPart): number =>
  part.kind === 'exec' ? kernel.execs[part.index]!.at : part.block.at

interface RawRow {
  key: string
  at: number
  kind: 'msg-user' | 'msg-agent' | 'msg-remote' | 'relay' | 'exec' | 'think' | 'live-msg' | 'note'
  msgIndex?: number
  execIndex?: number
  block?: LiveStreamBlock
}

const streamUnits = computed<StreamUnit[]>(() => {
  const active = ui.activeAgentId
  const raw: RawRow[] = []
  let liveBodySeen = false // 正文实况单元是否在场（空 pending 的 typing 抑制——v0.1.113 双 m-text 报障）
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
    // 正文预览幂等让位（v0.1.43）：同 agent 已有文本与预览一致的终答 → 不渲染（内容判据
    // 时序无关；中间轮正文不等任何消息文本 → 保留为过程事实）。
    // v0.1.113 放宽为双向前缀（trim 边界）：WS 流断线丢 chunk 时预览是终答的前缀（用户报障
    // 「一段输出被切割成两段」——精确全等判据下前缀不让位，双气泡并存）；重连重放超集同理。
    // 中间轮文本不是终答前缀（独立叙述）→ 不受影响，仍按设计保留
    if (kernel.messages.some((m) => m.kind === 'agent' && m.from === active && isPreviewDup(m.text, block.stdout))) continue
    raw.push({ key: `p-${block.key}`, at: block.at, kind: 'live-msg', block })
  }
  // compact 注记（会话引擎 v2 · P2）：会话流系统行（当前会话键过滤——私聊 agentId / 群 groupId）
  const noteKey = activeGroup?.groupId ?? active
  for (const note of kernel.sessionNotes) {
    if (note.sessionKey !== noteKey) continue
    raw.push({ key: `note-${note.at}`, at: note.at, kind: 'note' })
  }
  // 排序：at 主键；同刻平局按领域事实定序（v0.1.113 顺序修复）——思考恒先于工具
  // （同轮推理→调用的因果序；E2E mock 瞬时轮 startedAt 与 exec 事件同毫秒，key 字典序
  // 会把 t- 排到 e- 后致倒序）。其余回落 key 稳定序。
  const partOrder = (r: RawRow): number => (r.kind === 'think' ? 0 : r.kind === 'exec' ? 1 : 2)
  raw.sort((a, b) => a.at - b.at || partOrder(a) - partOrder(b) || a.key.localeCompare(b.key))

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
    } else if (row.kind === 'note') {
      // compact 注记：独立系统行（不进 pendingParts——不属任何轮）
      units.push({ key: row.key, at: row.at, kind: 'note', parts: [], noteText: kernel.sessionNotes.find((n) => `note-${n.at}` === row.key)?.text ?? '' })
    } else if (row.kind === 'live-msg') {
      // 正文 live 预览：独立单元以 agent 气泡形态流式呈现。v0.1.113 收编改版：不再 flush
      // 过程块（多轮工具场景每轮拆一个「署名+思考」空气泡——用户报障拆散观感）；终答行
      // 到达时统一收编移除（见 msg-agent 分支）；无终答的 run（预算/失败/中止）保留为最后事实
      units.push({ key: row.key, at: row.at, kind: 'live-msg', block: row.block!, parts: [] })
      liveBodySeen = true // 正文实况在场：空 pending 的 typing 让位（双 m-text 报障修复保持）
    } else if (row.kind === 'msg-agent') {
      // agent 终答：收编本轮全部正文实况（多轮中间叙述/断线前缀预览——过程由思考卡承载，
      // 一次回复一个气泡；v0.1.43 起原为内容判据逐块让位，中间轮残留+flush 拆散是双气泡根因）
      for (let k = units.length - 1; k >= 0; k--) if (units[k].kind === 'live-msg') units.splice(k, 1)
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
  } else if (agentBusy.value && !liveBodySeen) {
    // 无过程块且忙 → 三点占位；正文实况已在流（live-msg 单元在场）时不占——
    // 否则 typing 与流式正文双 m-text 并存（v0.1.113 用户报障「同时显示两个 m-text」）
    units.push({ key: 'pending', at: Date.now(), kind: 'pending', parts: [] })
  }
  return units
})

/** 已终结块组的状态行：该 agent 最新 run 的终态文案——v0.1.43 强化：所有非正常终态都醒目
 *  交代（此前仅 aborted/failed 两条且弱呈现——「只有 think 没有终答」时用户不知为何）。
 *  v0.1.113：失败因加人话与端点原文摘录（用户报障「只知道报错不知道原因」） */
/** 上下文水位（会话引擎 v2 · P1）：最近 usage 实测 / 生效模型窗口档位——composer 角落计量。
 *  数据源 usage.jsonl 尾行（v1.usage.latest）；档位取 llmStatus 生效模型（activeLane 随每轮
 *  更新——比 defaultModel 静态值准；agent 级覆写下版接 roster） */
const contextGauge = computed(() => {
  const u = kernel.contextUsage
  if (u === null || u.agentId !== ui.activeAgentId) return null
  const laneModel = kernel.llmStatus?.activeLane === 'fallback' ? kernel.llmStatus?.fallback : kernel.llmStatus?.primaryModel
  const model = kernel.providers
    .find((p) => p.name === (kernel.llmStatus?.activeLane === 'fallback' ? kernel.llmStatus?.fallback : kernel.llmStatus?.primary))
    ?.models.find((m) => m.id === laneModel)
  const windowTokens = model?.context1M === true ? 1_000_000 : 128_000
  const ratio = u.promptTokens / windowTokens
  // 显示口径（用户裁定）：不足 1% 按 1% 计（不显示 <1% 说法）；条宽与显示值一致
  const pctNum = Math.max(1, Math.min(100, Math.round(ratio * 100)))
  return {
    pct: String(pctNum),
    width: `${pctNum}%`,
    level: ratio >= 0.8 ? 'hot' : ratio >= 0.5 ? 'warm' : 'ok', // 色阶（用户裁定三档；档位判据仍按真实 ratio）
    used: u.promptTokens,
    windowTokens,
  }
})
const fmtTok = (n: number): string => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))
// 刷新时机（用户报障「必须发送一次才显现」）：连接就绪 + 会话切换 + 终答落地（usage 刚落盘）+ 30s 轮询兜底
watch(
  () => kernel.connected,
  (c) => {
    if (c && ui.activeAgentId !== null) void kernel.refreshContextUsage(ui.activeAgentId)
  },
)
watch(
  () => kernel.messages.length,
  () => {
    if (kernel.connected && ui.activeAgentId !== null) {
      // 终答事件先于 usage 尾行可见的极端竞态——延迟 2s 再取
      window.setTimeout(() => {
        if (ui.activeAgentId !== null) void kernel.refreshContextUsage(ui.activeAgentId)
      }, 2_000)
    }
  },
)
watch(() => ui.activeAgentId, (id) => { if (id !== null) void kernel.refreshContextUsage(id) }, { immediate: true })
let gaugeTimer: number | undefined
// 内容高度锚定（2026-11-01 收编塌缩报障根治）：高度是**过程**——思考卡折叠过渡
// （240ms grid-rows）、图片加载、markdown 迟滞渲染都让 scrollHeight 持续变化，任何
// 时刻式置底（scrollToBottom 的双 rAF）都会被后续变化甩掉（收编塌缩时视口悬在半空、
// 终答正文不在视野——真机实录实证）。声明式兜底：贴底意图（stickyBottom，2026-11-02
// 由瞬时 isNearBottom 判定升级——慢放抖动不再脱靶断链）下内容根一变尺寸即随动置底
// ——覆盖一切现在与未来的高度变化源，零时长猜测。上翻阅读（sticky=false）不受打扰；
// 置底不改内容尺寸，无回流环。
let streamResizeObserver: ResizeObserver | undefined
onMounted(() => {
  gaugeTimer = window.setInterval(() => {
    if (ui.activeAgentId !== null) void kernel.refreshContextUsage(ui.activeAgentId)
  }, 30_000)
  const inner = streamInnerEl.value
  if (inner === null) return
  streamResizeObserver = new ResizeObserver(() => {
    const el = streamEl.value
    if (el !== null && stickyBottom.value) el.scrollTop = el.scrollHeight
  })
  streamResizeObserver.observe(inner)
})
onBeforeUnmount(() => {
  if (gaugeTimer !== undefined) window.clearInterval(gaugeTimer)
  streamResizeObserver?.disconnect()
})

const endedOutcomeLabel = computed(() => {
  // 群轮 run 不在此交代（其终态归群流注记）——只看该 agent 的私聊/协作 run。
  // v0.1.115b 用户裁定：失败详情（人话+原文）不挤 m-meta（长文撑爆 meta 行）——meta 只留短状态
  const last = kernel.runs.filter((r) => r.agentId === ui.activeAgentId && r.kind !== 'group').at(-1)
  if (!last) return null
  if (last.state === 'aborted') return '本轮已中止——未产出终答（过程与思考见上方）'
  if (last.state === 'failed') return '执行失败——原因见下方'
  if (last.state === 'escaped') return '已转后台继续——完成后结果仍会送达会话'
  if (last.state === 'reaped') return '后台已结束——终答若已产出会在上方'
  return null
})

/** 失败详情条（stream 末端——v0.1.115b）：人话归因 + 端点原文摘录，可换行；不再进 m-meta */
const failureDetail = computed(() => {
  const last = kernel.runs.filter((r) => r.agentId === ui.activeAgentId && r.kind !== 'group').at(-1)
  if (!last || last.state !== 'failed') return null
  return failureText(last.code, last.abortReason)
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
    toast.push(err instanceof Error ? err.message : String(err), 'danger')
  }
}
const toggleTombstone = async (m: { messageId: string; from?: string; tombstoned?: boolean }): Promise<void> => {
  const agentId = m.from ?? ui.activeAgentId
  try {
    if (m.tombstoned === true) await kernel.sessionRevive(agentId, m.messageId)
    else await kernel.sessionTombstone(agentId, m.messageId)
  } catch (err) {
    toast.push(err instanceof Error ? err.message : String(err), 'danger')
  }
}
/** 发送前拦截：/clear /resume 不进消息流——直接走命令面（菜单关闭时的兜底路径）。
 *  群会话分流（2026-10-15 用户报障 /clear 群语义错位）：群上下文=群流记录，清空走群命令
 *  （清空点切窗口，成员忘记之前轮次）——此前误清 activeAgentId 的私聊会话，群上下文原封未动 */
/** /compact（会话引擎 v2 · P2）：早期轮次摘要化（保留近 6 轮原文）——群聊压群流/私聊压
 *  agent 流（同 /clear 分流语义）。剩余轮数不足诚实跳过；成功后刷新消息流（compact 注记入流） */
const doSlashCompact = async (): Promise<void> => {
  const groupId = ui.activeGroupId
  const r = await kernel.sessionCompact(
    groupId !== null ? { groupId, agentId: kernel.stewardId ?? ui.activeAgentId } : { agentId: ui.activeAgentId },
  )
  if (r.skipped === true) {
    toast.push(r.reason === 'in-progress' ? '压缩正在进行中——请稍候' : '会话还很短——无需压缩（保留近期轮即可）', 'info')
    return
  }
  toast.push(`已压缩：早期轮次摘要化，保留最近 ${r.keptRecords} 条原文（下一轮对话生效）`, 'success')
}

const doSlashClear = async (): Promise<void> => {
  if (ui.activeGroupId !== null) {
    await kernel.groupClear(ui.activeGroupId)
    toast.push('群上下文已清空——成员不再记得之前的群聊（transcript 留证）', 'success')
    return
  }
  const r = await kernel.sessionClear(ui.activeAgentId)
  // 空会话 no-op（2026-10-18 用户裁定「空会话不计入」）：内核未落边界——如实提示
  toast.push(
    r.skipped === true ? '当前会话为空——未开启新会话' : '已开启新会话（上下文与界面已清空，transcript 留证）',
    'success',
  )
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

/** 群发言模式徽标文案（2026-10-18 模式体系；2026-10-27 v0.1.93 增辩论——与内核
 *  GROUP_MODE_PREFIXES 注册表同源） */
const GROUP_MODE_LABELS: Record<'independent' | 'summary' | 'mention' | 'debate', string> = {
  independent: '独立作答',
  summary: '汇总',
  mention: '点名',
  debate: '辩论',
}

/** 命令清单（子串联想；/quote 进 agent 级；# 前缀为群发言模式——2026-10-18 可扩展注册面） */
const SLASH_COMMANDS: Array<{ name: string; sub: string }> = [
  { name: '/clear', sub: '开启新会话——上下文与界面清空（transcript 留证）' },
  { name: '/compact', sub: '压缩会话——早期轮次摘要化，保留近期原文（上下文吃紧时用）' },
  { name: '/resume', sub: '选择回到某个历史会话（默认最近一个）' },
  { name: '/quote', sub: '引用某个 Agent 的会话（随下条消息注入）' },
  { name: '#讨论', sub: '群聊独立作答——成员各抒己见、互不可见（前缀触发）' },
  { name: '#汇总', sub: '群聊独立作答后由汇总人交叉总结（管家优先）' },
  { name: '#点名', sub: '仅被 @ 的成员应答（需在消息中 @ 成员）' },
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
  // resume 级：当前 agent 的历史会话（排除当前会话——回到当前无意义；空会话内核已过滤）
  if (slash.value.mode === 'resume') {
    return refPickerSessions.value
      .filter((s) => !s.current)
      .slice()
      .reverse()
      .map((s) => ({
        key: s.sessionId,
        label: sessionLabel(s),
        sub: `${fmtSessionTime(s.lastAt)} · ${s.messageCount} 条`,
        note: shortSessionId(s.sessionId),
      }))
  }
  return refPickerSessions.value.slice().reverse().map((s) => ({
    key: s.sessionId,
    label: sessionLabel(s) + (s.current ? '（当前）' : ''),
    sub: `${fmtSessionTime(s.lastAt)} · ${s.messageCount} 条`,
    note: shortSessionId(s.sessionId),
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

/** 输入驱动（onComposerInput 内调用）：光标前缀 `/词` 或 `#词` → 命令/模式级联想；其余级随 draft 变化关闭 */
const feedSlash = (value: string, caret: number): void => {
  // agent/session 级：用户开始打字 = 放弃菜单（Backspace 回退不触发 input——键流分支保留）
  if (slash.value.open && slash.value.mode !== 'cmd') {
    closeSlash()
    return
  }
  const m = value.slice(0, caret).match(/(?:^|\s)(?:\/([a-z]*)|#([^\s#]{0,6}))$/)
  if (m === null) {
    if (slash.value.mode === 'cmd') closeSlash()
    return
  }
  const q = (m[1] ?? m[2] ?? '').toLowerCase()
  if (!SLASH_COMMANDS.some((c) => c.name.slice(1).startsWith(q))) {
    closeSlash()
    return
  }
  slash.value = { open: true, mode: 'cmd', start: caret - (m[1] ?? m[2])!.length - 1, sel: 0, agentId: null, q }
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
    // 模式前缀（2026-10-18）：插入 '#<模式> ' 到触发位（不同于 / 命令的移除语义——前缀随消息发送）
    if (it.key.startsWith('#')) {
      const el = draftEl.value
      const insert = `${it.key} `
      if (el !== null && s.start >= 0) {
        const caret = el.selectionStart ?? el.value.length
        ui.draft = `${ui.draft.slice(0, s.start)}${insert}${ui.draft.slice(Math.max(caret, s.start + 1))}`
        void nextTick(() => {
          el.focus()
          el.setSelectionRange(s.start + insert.length, s.start + insert.length)
        })
      } else {
        ui.draft = `${insert}${ui.draft}`
      }
      closeSlash()
      return
    }
    if (it.key === '/clear') {
      removeSlashToken()
      closeSlash()
      void doSlashClear().catch((err: unknown) => toast.push(String(err), 'danger'))
      return
    }
    if (it.key === '/compact') {
      removeSlashToken()
      closeSlash()
      void doSlashCompact().catch((err: unknown) => toast.push(String(err), 'danger'))
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
          toast.push(err instanceof Error ? err.message : String(err), 'danger')
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
        toast.push(err instanceof Error ? err.message : String(err), 'danger')
        closeSlash()
      })
      .finally(() => {
        slashLoading.value = false
      })
    return
  }
  // resume 级（v0.1.47 会话选择化）：回到选定的历史会话（toast 带标题/首问标签）
  if (s.mode === 'resume') {
    closeSlash()
    const target = it.key === 's-0' ? undefined : it.key // 初始段无 start——缺省语义即回退窗口
    void kernel
      .sessionResume(ui.activeAgentId, target)
      .then(() => toast.push(target !== undefined ? `已回到会话：${it.label}` : '已恢复上一会话上下文', 'success'))
      .catch((err: unknown) => toast.push(err instanceof Error ? err.message : String(err), 'danger'))
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

/** 引用会话数据源（slash session 级复用；保留 v0.1.45 状态名；title 为内核首问后生成的标题） */
const refPickerSessions = ref<Array<{ sessionId: string; messageCount: number; firstText: string; lastAt: number; current: boolean; title?: string }>>([])
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

/* ---- 思考头 B 版（v0.1.113 用户四轮裁定）：盲文同族图标位 + 时长 + 进行中实时摘要 ---- */

/** 盲文转帧（进行中思考块图标位）：JS 驱动（Chromium 不支持 keyframes content）；
 *  完成后停在满点 ⠿——同一个符号的两种生命状态（转动=在想，停满=想完），无跨族跳跃 */
const BRAILLE_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const
const brailleFrame = ref(0)
let brailleTimer: number | undefined
onMounted(() => {
  brailleTimer = window.setInterval(() => {
    brailleFrame.value = (brailleFrame.value + 1) % BRAILLE_FRAMES.length
  }, 90)
})
onBeforeUnmount(() => {
  if (brailleTimer !== undefined) window.clearInterval(brailleTimer)
})

/** 思考时长（头部「· 12s」）：<10s 一位小数、否则取整秒；历史回放块无 durationMs 不显示（诚实降级） */
const fmtThinkDur = (ms: number): string => (ms < 10_000 ? (ms / 1000).toFixed(1) : `${Math.round(ms / 1000)}`) + 's'

/** 进行中实时摘要：首行净文本截 24 字（完成态走 thinkSummary 60 字逻辑） */
const liveThinkSum = (block: LiveStreamBlock): string => {
  const firstLine = block.stdout.split('\n')[0] ?? ''
  const plain = firstLine.replaceAll('**', '').replaceAll('`', '').trim()
  return plain === '' ? '' : `${plain.slice(0, 24)}…`
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
/** 视口是否已在底部附近（跳底按钮显隐等**瞬时位置**判定的用途） */
const isNearBottom = (): boolean => {
  const el = streamEl.value
  if (!el) return true
  return el.scrollHeight - el.scrollTop - el.clientHeight < 80
}

/** 贴底跟随意图（sticky-bottom，2026-11-02）：用户在底部 = 跟随（内容增长强制置底）；
 *  上翻 = 停止跟随；回底 = 恢复。替代跟随链上的瞬时 isNearBottom 判定——内容增长把
 *  视口「物理推离」底部不触发 scroll 事件，意图不会误翻；流式慢放期间高度持续抖动，
 *  瞬时判定会被脱靶断链（跟随后终答落在视野外——「必须刷新才能看到结果」的根因之一） */
const stickyBottom = ref(true)
/** 跟随置底（内容增长的唯一跟随入口——只看意图，不看瞬时位置） */
const followIfSticky = (): void => {
  if (stickyBottom.value) scrollToBottom()
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
  // 意图翻转只在用户滚动时发生（内容增长不触发 scroll）：贴底即跟随、上翻即停
  stickyBottom.value = atBottom.value
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
      // 普通新消息：按跟随意图置底；上翻阅读不打扰但计数提示
      followIfSticky()
      if (!stickyBottom.value) newCount.value += delta
    }
    void nextTick(measureRail)
  },
)
watch(
  () => [ui.activeAgentId, ui.activeGroupId],
  () => {
    // 会话切换：清计数 + 恢复跟随意图 + 强制定底（历史异步填充期间由上面的批量分支接续保障）
    newCount.value = 0
    stickyBottom.value = true
    lastMsgCount = kernel.messages.length
    scrollToBottom()
  },
)
// 实况增长（思考增量 / 执行输出 / 流块新增与状态迁移）与进行中单元出现：贴底跟随
watch(
  () => kernel.streams.map((s) => `${s.key}:${s.stdout.length}:${s.stderr.length}:${s.state}`).join('|'),
  followIfSticky,
)
watch(() => kernel.runs.length, followIfSticky)
// 流块批量出现（历史加载的伪 exec/思考块投影）：与 messages 批量同判——强制定底
let lastStreamCount = kernel.streams.length
watch(
  () => kernel.streams.length,
  (len) => {
    const delta = len - lastStreamCount
    lastStreamCount = len
    if (delta >= 3) scrollToBottom()
    else followIfSticky()
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
  attScrollStop() // 按住连滚定时器不留孤儿
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

// ---- 附件（2026-10-30 v0.1.102 一期图片 + 同日二期文件类）：粘贴 / +菜单选择 / 拖拽三入口——
// 待发条 chip（图片缩略 / 文件名+大小）随消息同发；视觉门控仅约束图片部分 ----

interface PendingAtt {
  meta: AttachmentMeta
  /** 图片：缩略 dataURI；文件类：空（chip 呈现名与大小） */
  uri: string
}
const pendingAtts = ref<PendingAtt[]>([])
const attBusy = ref(false)
const attFileEl = ref<HTMLInputElement | null>(null)

/** 模型视觉判定（发送门控）：档案 modelProvider（'供应商::模型'）→ 默认模型对
 *  （llmStatus）→ 唯一供应商回退（首供即用场景：llmStatus 可能未刷新/未设默认）→ 视觉声明 */
const modelSupportsImages = computed(() => {
  const agentId = ui.activeAgentId
  const override = agentId !== null ? kernel.roster.find((a) => a.agentId === agentId)?.modelProvider : undefined
  let provName: string
  let modelId: string
  if (override !== undefined && override !== '') {
    ;[provName, modelId] = override.includes('::') ? (override.split('::') as [string, string]) : [override, '']
  } else {
    provName = kernel.llmStatus?.primary ?? kernel.providers[0]?.name ?? ''
    modelId = kernel.llmStatus?.primaryModel ?? ''
  }
  if (provName === '') return false
  const prov = kernel.providers.find((p) => p.name === provName)
  const model = modelId !== '' ? prov?.models.find((m) => m.id === modelId) : prov?.models[0]
  return model?.supportsImages === true
})

/** 人性化大小（文件 chip） */
const fmtSize = (n: number): string => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`)

/** 文件类型徽标（v0.1.104 用户裁定：att-chip 统一 44px 方块——文件以类型色徽标呈现：
 *  PDF 红 / 表格绿 / 文档蓝 / 压缩黄，其余主题中性色；徽标文字 = 扩展名（≤4 字符大写） */
/** 文件类型徽标（v0.1.104 三轮：FileBadge 组件——用户 SVG 参照折角纸张形，色板/扩展名逻辑内聚组件） */

/** 图片预览（v0.1.104 用户需求：气泡/待发条图片点击放大）——遮罩点击即关 */
const attPreview = ref<{ uri: string; name: string } | null>(null)

/** 气泡附件收纳（v0.1.110 用户裁定）：行内最多 2 个 + 「+N 个」泡（点开全览模态）——
 *  附件再多也不撑高消息卡；48px 统一方块不拉高（图片 object-fit cover 裁切预览、点击看原图） */
const BUBBLE_ATT_MAX = 2
const visibleAttsOf = (msgIndex: number): AttachmentMeta[] => {
  const atts = kernel.messages[msgIndex]?.attachments
  return atts === undefined ? [] : atts.slice(0, BUBBLE_ATT_MAX)
}
const hiddenAttCount = (msgIndex: number): number => {
  const atts = kernel.messages[msgIndex]?.attachments
  return atts === undefined ? 0 : Math.max(0, atts.length - BUBBLE_ATT_MAX)
}
/** 附件全览模态（v0.1.110）：+N 泡点开——消息全部附件一屏（图可预览/文件名+大小） */
const attListFor = ref<number | null>(null)
const attListAtts = computed(() => (attListFor.value !== null ? (kernel.messages[attListFor.value]?.attachments ?? []) : []))

/** 复制消息文本（v0.1.110 操作排）：markdown 源文（m-text 是渲染后 HTML——复制原文才是可用文本） */
const copyMessageText = async (text: string): Promise<void> => {
  await navigator.clipboard.writeText(text).catch(() => {})
  toast.push('已复制消息文本', 'success')
}

const addFiles = async (files: File[] | FileList): Promise<void> => {
  const list = [...files]
  if (list.length === 0) return
  // 门控逐文件（v0.1.104 修正：混批时只拒图片、放行文件——文本/存档附件不依赖视觉）
  const vision = modelSupportsImages.value
  const rejected: string[] = []
  const accepted = list.filter((f) => {
    if (f.type.startsWith('image/') && !vision) {
      rejected.push(f.name)
      return false
    }
    return true
  })
  if (rejected.length > 0) {
    toast.push(`当前模型不支持图像输入，已略过图片：${rejected.join('、')}`, 'warning')
  }
  if (accepted.length === 0) return
  attBusy.value = true
  try {
    for (const f of accepted) {
      // 逐文件容错（v0.1.104 修正：一个失败不中断同批其余——catch 在循环内）
      try {
        if (f.size > 8 * 1024 * 1024) {
          toast.push(`「${f.name}」超过 8MB 上限`, 'danger')
          continue
        }
        const dataBase64 = await new Promise<string>((resolve, reject) => {
          const fr = new FileReader()
          fr.onload = () => resolve(String(fr.result).split(',')[1] ?? '')
          fr.onerror = () => reject(fr.error)
          fr.readAsDataURL(f)
        })
        const meta = await kernel.uploadAttachment(f.name, f.type !== '' ? f.type : 'application/octet-stream', dataBase64)
        const uri = meta.mime.startsWith('image/') ? await kernel.attachmentUri(meta.id, meta.mime) : ''
        pendingAtts.value = [...pendingAtts.value, { meta, uri }]
      } catch (err) {
        toast.push(`「${f.name}」上传失败：${err instanceof Error ? err.message : String(err)}`, 'danger')
      }
    }
  } finally {
    attBusy.value = false
  }
}
const addImageFiles = addFiles

const removePendingAtt = (id: string): void => {
  pendingAtts.value = pendingAtts.value.filter((a) => a.meta.id !== id)
}

/** 附件条滚动态（v0.1.105 八轮：方位感知箭头——按滚动位置显隐 ‹/›） */
const attScrollEl = ref<HTMLElement | null>(null)
const attCanLeft = ref(false)
const attCanRight = ref(false)
const updateAttScrollState = (): void => {
  const el = attScrollEl.value
  if (el === null) {
    attCanLeft.value = false
    attCanRight.value = false
    return
  }
  const t = 8 // 容差：亚像素/平滑滚动尾差不闪箭头
  attCanLeft.value = el.scrollLeft > t
  attCanRight.value = el.scrollLeft + el.clientWidth < el.scrollWidth - t
}
watch(pendingAtts, () => void nextTick(() => updateAttScrollState()), { deep: true })

/** 箭头按住连滚（v0.1.105 八轮二改：按下持续移动、松开即停——步进/单次大跳被作者否）。
 *  16ms 帧步 9px ≈ 560px/s 匀速；scrollLeft 赋值天然触发 scroll 事件 → 箭头态实时跟随；
 *  松开三路兜底（钮上 pointerup/leave/cancel + 窗口级 pointerup——按住移出钮也不失控） */
let attScrollTimer: ReturnType<typeof setInterval> | null = null
const attScrollStop = (): void => {
  if (attScrollTimer !== null) {
    clearInterval(attScrollTimer)
    attScrollTimer = null
  }
  // 边缘吸附（v0.1.107 四改）：箭头在 ≤8px 就隐身，用户见隐即松手会停在 0–8px 带——
  // 留白比初始态大（用户报障）。松手时若在端点吸附带内（≤16px）平滑贴齐精确端点
  const el = attScrollEl.value
  if (el === null) return
  const SNAP = 16
  if (el.scrollLeft > 0 && el.scrollLeft <= SNAP) el.scrollTo({ left: 0, behavior: 'smooth' })
  else {
    const remain = el.scrollWidth - (el.scrollLeft + el.clientWidth)
    if (remain > 0 && remain <= SNAP) el.scrollTo({ left: el.scrollWidth, behavior: 'smooth' })
  }
}
/** 滚轮横滚（v0.1.108 用户需求）：悬停附件条时纵向滚轮增量转横向滚动（触控板 deltaX 原生已通）。
 *  preventDefault 阻断页面纵向滚动（滚轮悬停在条上时整页不该动）；deltaY×1.2 步进手感 */
const onAttWheel = (e: WheelEvent): void => {
  const el = attScrollEl.value
  if (el === null) return
  const delta = e.deltaX !== 0 ? e.deltaX : e.deltaY * 1.2
  if (delta === 0) return
  e.preventDefault()
  el.scrollLeft += delta
}

const onAttArrowDown = (dir: 1 | -1): void => {
  attScrollStop()
  const el = attScrollEl.value
  if (el === null) return
  attScrollTimer = setInterval(() => {
    el.scrollLeft += dir * 9
  }, 16)
  window.addEventListener('pointerup', attScrollStop, { once: true })
}

/** + 菜单「上传图片」→ 文件选择落定：读入上传 → 清空控件值（同文件可重选） */
const onAttFileChange = (): void => {
  const files = attFileEl.value?.files
  if (files !== null && files !== undefined) void addFiles(files)
  if (attFileEl.value !== null) attFileEl.value.value = ''
}

const onComposerPaste = (e: ClipboardEvent): void => {
  const files = e.clipboardData?.files
  if (files !== undefined && files.length > 0) {
    e.preventDefault()
    void addImageFiles(files)
  }
}

const onComposerDrop = (e: DragEvent): void => {
  const files = e.dataTransfer?.files
  if (files !== undefined && files.length > 0) void addImageFiles(files)
}

/** 气泡缩略 dataURI：store 三路径（发送/事件/历史装载）预取进 attCache——此处同步到本地响应式 */
const attUris = reactive({} as Record<string, string>)
watch(
  () => kernel.attCache,
  (c) => {
    for (const [k, v] of Object.entries(c)) if (attUris[k] === undefined) attUris[k] = v
  },
  { immediate: true },
)

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

/** 键盘流：菜单开时先行消费（↑↓/Enter/Tab/Esc），不冒泡到发送——原型同款。
 *  菜单关时 ↑/↓ = 终端式输入历史翻阅（2026-11-01 用户需求）：按对话对象分桶
 *  （agentId/groupId 各自独立 ≤100 条，localStorage 持久）；↑ 进入历史（暂存当前草稿），
 *  ↓ 翻回、越过最新一条退出并还原草稿；Esc 直接退出还原；Enter 照常发送。 */
/** 历史翻阅态（非响应式——仅 keydown 内部消费）：key = 进入时的对话对象（对象切换自然失效） */
let histState: { key: string; idx: number; draft: string } | null = null
/** 当前对话对象（历史桶键）：群在场归群，否则当前 agent */
const histKeyOf = (): string => ui.activeGroupId ?? ui.activeAgentId
/** 历史翻阅退出/重置的统一收口（发送后也走这里） */
const histReset = (): void => {
  histState = null
}
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
  // ---- 输入历史（↑/↓ 翻阅——菜单关闭时；单行 input 箭头无默认行为，接管零冲突） ----
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    e.preventDefault()
    const key = histKeyOf()
    const list = loadBucket(localStorage, key)
    if (list.length === 0) return
    if (histState === null || histState.key !== key) {
      if (e.key === 'ArrowDown') return // 不在历史模式，↓ 无语义
      histState = { key, idx: list.length, draft: ui.draft } // idx 从「最新之后」起——↑ 先到末条
    }
    if (e.key === 'ArrowUp') {
      if (histState.idx <= 0) return // 已在最旧
      histState.idx -= 1
    } else {
      if (histState.idx >= list.length) return
      histState.idx += 1
      if (histState.idx === list.length) {
        ui.draft = histState.draft // 越过最新 → 退出历史，还原草稿
        histState = null
        return
      }
    }
    ui.draft = list[histState.idx] ?? ''
    // 填入后光标置尾（默认跳开头不顺手）；v-model DOM 更新在 nextTick
    void nextTick(() => {
      const el = draftEl.value
      if (el) el.setSelectionRange(el.value.length, el.value.length)
    })
    return
  }
  if (e.key === 'Escape' && histState !== null) {
    ui.draft = histState.draft // 直接退出历史，还原草稿
    histState = null
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
  const atts = pendingAtts.value.length > 0 ? pendingAtts.value.map((a) => a.meta) : undefined
  if ((text === '' && atts === undefined) || sending.value) return
  // 输入历史入桶（敲字时所在的对话对象——广播/@跳转等跨对象发送也归此处，↑ 翻「我在这个
  // 对话框敲过的」；回车即记录，终端语义）。空文本不入（附件占位场景）
  if (text !== '') pushHistory(localStorage, histKeyOf(), text)
  histReset()
  // 视觉门控只约束图片附件（文本注入/存档不依赖视觉）
  if (atts !== undefined && atts.some((a) => a.mime.startsWith('image/')) && !modelSupportsImages.value) {
    toast.push('当前模型不支持图像输入——先在设置中为模型开启「视觉」，或移除图片', 'warning')
    return
  }
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
    await kernel.sendUserMessage(to, text !== '' ? text : '（附件）', undefined, pendingRef.value ?? undefined, atts)
    pendingAtts.value = []
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
            <!-- 群徽标「群聊 · N 成员 · 有界轮转」已移除（2026-10-18 用户裁定：无信息量）——
                 成员数/轮转语义仍在会话档案（ctx）与建群向导说明中 -->
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
                      <!-- 发言模式徽标（2026-10-18 模式体系）：#讨论/#汇总/#点名 触发 -->
                      <span v-if="kernel.messages[unit.msgIndex]!.groupMode !== undefined" class="chip chip-accent gm-mode">{{ GROUP_MODE_LABELS[kernel.messages[unit.msgIndex]!.groupMode!] }}</span>
                      <span class="m-time">{{ fmtTime(unit.at) }}</span>
                      <span v-if="kernel.messages[unit.msgIndex]!.pending" class="m-state">发送中…</span>
                      <button v-else-if="kernel.messages[unit.msgIndex]!.failed" class="m-retry" @click="retry(unit.msgIndex!)">发送失败 · 重试</button>
                    </div>
                    <!-- 附件行（v0.1.110 同步：meta 下、气泡上 + 收纳 + 48px） -->
                    <div v-if="kernel.messages[unit.msgIndex]!.attachments" class="m-atts">
                      <template v-for="att in visibleAttsOf(unit.msgIndex!)" :key="att.id">
                        <img v-if="att.mime.startsWith('image/')" class="m-att" :src="attUris[att.id]" :alt="att.name" :title="att.name" @click="attUris[att.id] !== undefined && (attPreview = { uri: attUris[att.id]!, name: att.name })" />
                        <span v-else class="m-att-file mono" :title="att.name"><span class="m-att-badge"><FileBadge :name="att.name" /></span>{{ att.name }}</span>
                      </template>
                      <button v-if="hiddenAttCount(unit.msgIndex!) > 0" type="button" class="m-att-more" @click="attListFor = unit.msgIndex!">+{{ hiddenAttCount(unit.msgIndex!) }} 个</button>
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

            <!-- compact 注记（会话引擎 v2 · P2）：系统行——压过哪些段一目了然 -->
            <div v-else-if="unit.kind === 'note'" class="compact-note">◎ {{ unit.noteText }}</div>

            <!-- user 消息（右对齐气泡；「会话掌控」hover 编辑 + 引用胶囊） -->
            <div v-else-if="unit.kind === 'msg-user'" class="m user" :data-mid="kernel.messages[unit.msgIndex]!.messageId">
              <div class="m-body">
                <!-- meta 纯净化（v0.1.110 用户裁定）：只留署名+时间——操作钮全部下移气泡下 -->
                <div class="m-meta">
                  <span class="m-name">你</span>
                  <span class="m-time">{{ fmtTime(unit.at) }}</span>
                  <span v-if="kernel.messages[unit.msgIndex!]!.pending" class="m-state">发送中…</span>
                  <button v-else-if="kernel.messages[unit.msgIndex!]!.failed" class="m-retry" @click="retry(unit.msgIndex!)">发送失败 · 重试</button>
                </div>
                <div v-if="kernel.messages[unit.msgIndex!]!.sessionRef" class="m-ref-chip">引用日期 {{ kernel.messages[unit.msgIndex!]!.sessionRef!.agentId }} · {{ kernel.messages[unit.msgIndex!]!.sessionRef!.sessionId ?? '初始会话' }}</div>
                <!-- 附件行上移（v0.1.110 用户裁定）：meta 下、气泡上；缩略统一 48px 方块（不再拉高）；
                     溢出收纳：最多 2 个 + 「+N 个」泡 → 点开附件全览模态 -->
                <div v-if="kernel.messages[unit.msgIndex!]!.attachments" class="m-atts">
                  <template v-for="att in visibleAttsOf(unit.msgIndex!)" :key="att.id">
                    <img v-if="att.mime.startsWith('image/')" class="m-att" :src="attUris[att.id]" :alt="att.name" :title="att.name" @click="attUris[att.id] !== undefined && (attPreview = { uri: attUris[att.id]!, name: att.name })" />
                    <span v-else class="m-att-file mono" :title="att.name"><span class="m-att-badge"><FileBadge :name="att.name" /></span>{{ att.name }}</span>
                  </template>
                  <button v-if="hiddenAttCount(unit.msgIndex!) > 0" type="button" class="m-att-more" @click="attListFor = unit.msgIndex!">+{{ hiddenAttCount(unit.msgIndex!) }} 个</button>
                </div>
                <div class="m-text" v-html="mentionify(kernel.messages[unit.msgIndex!]!.text, mentionNames)"></div>
                <!-- 操作排（v0.1.110 用户裁定）：编辑/复制移到气泡下——行内轻钮 -->
                <div v-if="!kernel.messages[unit.msgIndex!]!.pending && !kernel.messages[unit.msgIndex!]!.failed" class="m-acts">
                  <button type="button" class="m-act" @click="openEdit(kernel.messages[unit.msgIndex!]!)">编辑</button>
                  <button type="button" class="m-act" @click="copyMessageText(kernel.messages[unit.msgIndex!]!.text)">复制</button>
                </div>
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
                </div>

                <!-- 单元内按时间序交错：思考块与 task 卡不分层（think→task→think→…如实还原轮次） -->
                <template v-for="part in unit.parts" :key="part.kind === 'think' ? part.block.key : kernel.execs[part.index]!.key">
                  <!-- 思考块（B 版：live 盲文转帧/完成满点静止 + 已思考·Ns + 摘要；点击头展开） -->
                  <div v-if="part.kind === 'think'" class="think" :class="{ 'is-live': part.block.state === 'live' }">
                    <button class="think-head" type="button" @click="toggleThink(part.block.key)">
                      <span class="think-spin mono" aria-hidden="true">{{ part.block.state === 'live' ? BRAILLE_FRAMES[brailleFrame] : '⠿' }}</span>
                      <span class="think-tag">{{ part.block.state === 'live' ? '思考中' : '已思考' }}</span>
                      <span v-if="part.block.state !== 'live' && part.block.durationMs !== undefined" class="think-dur mono">· {{ fmtThinkDur(part.block.durationMs) }}</span>
                      <span v-if="part.block.state !== 'live'" class="think-sum mono">{{ thinkSummary(part.block) }}</span>
                      <span v-else-if="liveThinkSum(part.block) !== ''" class="think-sum mono">{{ liveThinkSum(part.block) }}</span>
                      <span class="think-chev" :class="{ open: isThinkOpen(part.block) }" aria-hidden="true">
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6.5 9.5L12 15l5.5-5.5"></path></svg>
                      </span>
                    </button>
                    <div class="think-body-wrap" :class="{ collapsed: !isThinkOpen(part.block) }">
                      <div class="think-body-clip">
                        <span class="think-body mono">{{ part.block.stdout }}</span>
                        <span v-if="part.block.state === 'live'" class="think-caret"></span>
                      </div>
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

                <!-- agent 附图（v0.1.118 截图直发）：终答之下缩略行（user 气泡 m-atts 同款语汇） -->
                <div v-if="unit.msgIndex !== undefined && kernel.messages[unit.msgIndex]!.attachments" class="m-atts">
                  <template v-for="att in kernel.messages[unit.msgIndex]!.attachments" :key="att.id">
                    <img
                      v-if="att.mime.startsWith('image/')"
                      class="m-att"
                      :src="attUris[att.id]"
                      :alt="att.name"
                      :title="att.name"
                      @click="attUris[att.id] !== undefined && (attPreview = { uri: attUris[att.id]!, name: att.name })"
                    />
                    <span v-else class="m-att-file mono" :title="att.name"><span class="m-att-badge"><FileBadge :name="att.name" /></span>{{ att.name }}</span>
                  </template>
                </div>
                <!-- 最终文本（markdown）；进行中且尚无任何输出块 → 三个点占位（首 token 到达即被实况取代） -->
                <div v-if="unit.msgIndex !== undefined" class="m-text md" :class="{ 'is-tombstoned': kernel.messages[unit.msgIndex]!.tombstoned }" v-html="renderMarkdown(kernel.messages[unit.msgIndex]!.text, mentionNames)"></div>
                <div v-if="unit.msgIndex !== undefined && kernel.messages[unit.msgIndex]!.tombstoned" class="m-tomb-note">已移出上下文（记录保留，后续对话不再携带）</div>
                <div v-else-if="unit.kind === 'pending' && unit.parts.length === 0" class="m-text typing" aria-label="正在生成回复">
                  <span class="dot"></span><span class="dot"></span><span class="dot"></span>
                </div>
                <!-- 操作排（v0.1.110 user 气泡同款语汇，agent 侧对齐）：复制 + 移出/恢复——meta 纯净化后归位气泡下 -->
                <div v-if="unit.msgIndex !== undefined && kernel.messages[unit.msgIndex]!.kind === 'agent' && unit.kind !== 'pending'" class="m-acts">
                  <button type="button" class="m-act" @click="copyMessageText(kernel.messages[unit.msgIndex!]!.text)">复制</button>
                  <button
                    type="button"
                    class="m-act"
                    :title="kernel.messages[unit.msgIndex!]!.tombstoned ? '恢复进上下文' : '移出上下文（保留记录）'"
                    @click="toggleTombstone(kernel.messages[unit.msgIndex!]!)"
                  >{{ kernel.messages[unit.msgIndex!]!.tombstoned ? '恢复' : '移出' }}</button>
                </div>
                <!-- 失败详情条（v0.1.115b 用户裁定）：stream 末端独立行——人话+端点原文可换行，不挤 m-meta -->
                <div v-if="unit.kind === 'ended' && failureDetail" class="m-fail">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"></path></svg>
                  <span>{{ failureDetail }}</span>
                </div>
              </div>
            </div>
          </template>

          <!-- 审批 gate 卡已退役（2026-11-01 用户裁定）：审批交互面就是全局 ApprovalModal
               （pendingApprovals 非空即弹），流内卡被模态覆盖永远点不到；且每次增删 ±143px
               抽走消息流高度，是流式滚动跳动的最大扰动源（25s 内 8 次增删实测）。等待中=
               模态弹出；被「稍后处理」暂收=侧栏 console 角标计数提示 -->

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
          <!-- 图片选择（v0.1.102）：+ 菜单触发；粘贴/拖拽走事件面——置 composer-box 外（既有选择器 .composer-box input 单命中不破） -->
          <input ref="attFileEl" type="file" multiple hidden @change="onAttFileChange" />
          <div class="composer-box" :class="{ disabled: !kernel.connected || remotePeer !== null }" @dragover.prevent @drop.prevent="onComposerDrop">
            <!-- 待发附件条（v0.1.102 图片一期）：缩略图 chip + 移除；上传中 spinner -->
            <div v-if="pendingAtts.length > 0 || attBusy" class="att-strip">
              <!-- 左箭头（八轮：仅当已离开首端——中间态/末态在场） -->
              <button v-if="attCanLeft" type="button" class="att-arrow is-left" aria-label="向左滚动附件" @pointerdown.prevent="onAttArrowDown(-1)" @pointerup="attScrollStop" @pointerleave="attScrollStop" @pointercancel="attScrollStop">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6" /></svg>
              </button>
              <div ref="attScrollEl" class="att-scroll" @scroll="updateAttScrollState" @wheel="onAttWheel">
                <div v-for="a in pendingAtts" :key="a.meta.id" class="att-chip" :class="{ 'is-file': a.uri === '' }" :title="`${a.meta.name} · ${fmtSize(a.meta.size)}`">
                  <img v-if="a.uri !== ''" class="att-thumb" :src="a.uri" :alt="a.meta.name" title="点击预览" @click="attPreview = { uri: a.uri, name: a.meta.name }" />
                  <template v-else>
                    <span class="att-mini"><FileBadge :name="a.meta.name" /></span>
                    <span class="att-name">{{ a.meta.name }}</span>
                  </template>
                  <button type="button" class="att-x" aria-label="移除附件" @click="removePendingAtt(a.meta.id)">✕</button>
                </div>
                <span v-if="attBusy" class="att-busy">上传中…</span>
              </div>
              <!-- 右箭头（八轮：仅当右侧还有未滚入内容——首态/中间态在场） -->
              <button v-if="attCanRight" type="button" class="att-arrow is-right" aria-label="向右滚动附件" @pointerdown.prevent="onAttArrowDown(1)" @pointerup="attScrollStop" @pointerleave="attScrollStop" @pointercancel="attScrollStop">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg>
              </button>
            </div>
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
              :placeholder="remotePeer !== null ? `远端镜像会话（${remotePeer.displayName}）· 只读——对话经中继转发到达` : '对 OpenBot 说出需求，使用 / 选择命令或能力'"
              :disabled="!kernel.connected || remotePeer !== null"
              autocomplete="off"
              @input="onComposerInput"
              @blur="onComposerBlur"
              @keydown="onComposerKeydown"
              @paste="onComposerPaste"
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
                    <!-- 上传文件（v0.1.102 一期图片 + 二期文件类）：选择/粘贴/拖拽三入口——多选；
                         图片走视觉注入、文本 ≤200KB 注入全文、其余存档给路径；视觉门控只约束图片；
                         副注清理（v0.1.104 用户裁定：+菜单只留条目名） -->
                    <button class="cb-menu-item" @click="attFileEl?.click(); plusMenuOpen = false">
                      <svg class="mi" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>
                      <span class="mt"><span class="ti">上传图片 / 文件</span></span>
                    </button>
                    <button class="cb-menu-item" @click="openQuoteFromMenu()">
                      <svg class="mi" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /></svg>
                      <span class="mt"><span class="ti">引用某个 Agent 的会话</span></span>
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
                <!-- 上下文水位（会话引擎 v2 · P1）：色阶进度条（用户裁定：<50% 绿 / 50-80% 黄 / ≥80% 红
                     ——功能色取 chip-success/warning/danger 同源主题变量）+ 百分比 -->
                <span
                  v-if="contextGauge"
                  class="ctx-gauge"
                  :class="`lv-${contextGauge.level}`"
                  :title="`上下文占用 ${contextGauge.pct}%（${fmtTok(contextGauge.used)} / ${fmtTok(contextGauge.windowTokens)} token）——由最近一次响应 usage 实测`"
                ><i class="ctx-bar"><i class="ctx-fill" :style="{ width: contextGauge.width }"></i></i>{{ contextGauge.pct }}%</span>
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

    <!-- 图片预览遮罩（v0.1.104）：气泡/待发条图片点击放大——点遮罩即关（高于 toast 130） -->
    <div v-if="attPreview" class="att-view" role="dialog" aria-label="图片预览" @mousedown="attPreview = null">
      <img :src="attPreview.uri" :alt="attPreview.name" @mousedown.stop />
      <span class="att-view-name">{{ attPreview.name }}</span>
    </div>

    <!-- 附件全览模态（v0.1.110）：气泡 +N 泡点开——该消息全部附件一屏（图可点预览；Esc/外点关） -->
    <div v-if="attListFor !== null" class="att-list-scrim" role="presentation" @mousedown.self="attListFor = null">
      <div class="att-list-modal" role="dialog" aria-label="附件全览" @keydown.escape="attListFor = null">
        <div class="am-head"><span class="am-title">附件（{{ attListAtts.length }} 个）</span></div>
        <div class="att-list-body">
          <div v-for="att in attListAtts" :key="att.id" class="att-list-row">
            <span class="att-list-badge"><FileBadge :name="att.name" /></span>
            <img
              v-if="att.mime.startsWith('image/')"
              class="att-list-thumb"
              :src="attUris[att.id]"
              :alt="att.name"
              title="点击预览"
              @click="attUris[att.id] !== undefined && (attPreview = { uri: attUris[att.id]!, name: att.name })"
            />
            <span class="att-list-name mono">{{ att.name }}</span>
            <span class="att-list-size">{{ fmtSize(att.size) }}</span>
          </div>
        </div>
        <div class="am-actions"><button type="button" class="btn btn-ghost" @click="attListFor = null">关闭</button></div>
      </div>
    </div>
  </section>
</template>

<style scoped src="./console.css"></style>
