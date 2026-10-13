<script setup lang="ts">
/**
 * 社交图谱视图（prototype.html 迁移）：谁在和谁说话。
 * 节点 = user + roster（身份色圆盘 + 工作状态点——runs 投影，P4 Step 12）+ 群（菱形 + chat 图标，
 * P5 Step 4——群成员边聚合，ggroup 语义）；弧线宽度 ∝ 消息量；user↔agent 消息边（灰）与
 * agent↔agent 委派边（accent）视觉区分（群边=灰，群内发言非委派）；
 * hover/键盘聚焦预览退隐（无关元素淡出），点击进侧栏详情（退隐钉住），点空白/Esc 退出。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useKernelStore } from '../stores/kernel'
import { useUiStore } from '../stores/ui'

const kernel = useKernelStore()
const ui = useUiStore()

const CX = 450
const CY = 262
const ORBIT = 192

/** 群图标（prototype ICONS.chat 同源 path） */
const CHAT_ICON = '<path d="M4 5h16a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H10l-5 4v-4H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z"/>'

interface NodeGeom {
  id: string
  label: string
  initial: string
  x: number
  y: number
  r: number
  isUser: boolean
  /** 群节点（P5 Step 4）：菱形渲染——无状态点/首字母，chat 图标居中 */
  isGroup: boolean
  /** 远端成员（P7 原型对齐）：info 色圆节点——mirror 身份（无 run 概念，状态点为在场/离场） */
  isRemote: boolean
}

interface EdgeGeom {
  key: string
  from: string
  to: string
  count: number
  d: string
  width: number
  kind: 'user' | 'a2a' | 'group' | 'remote'
}

const isGroupId = (id: string): boolean => kernel.groups.some((g) => g.groupId === id)
const isRemoteId = (id: string): boolean => id.startsWith('remote:')

/** user 居中、agents + 群 + 远端成员环形均布（原型为手工摆位，Vue 版按真实数据计算——同轨混布；
 *  远端成员按房间摊平——键空间 remote:<roomId>:<memberId>） */
const nodes = computed<NodeGeom[]>(() => {
  const list: NodeGeom[] = [{ id: 'user', label: '你', initial: '你', x: CX, y: CY, r: 26, isUser: true, isGroup: false, isRemote: false }]
  const ring: Array<{ id: string; label: string }> = [
    ...kernel.roster.map((a) => ({ id: a.agentId, label: a.name ?? a.agentId })),
    ...kernel.groups.map((g) => ({ id: g.groupId, label: g.name })),
    ...kernel.remoteRooms.flatMap((room) =>
      room.members.map((m) => ({ id: `remote:${room.roomId}:${m.memberId}`, label: m.displayName })),
    ),
  ]
  ring.forEach((it, i) => {
    // 椭圆轨道（审计 P2-10）：横向椭圆（rx > ry）——少节点时不再竖线扎堆（2 节点正上下是
    // 最差情形），多节点时构图更贴画布宽高比；首节点从正上改为 -60° 起步避开纯正上/正下
    const angle = -Math.PI / 3 + (2 * Math.PI * i) / Math.max(ring.length, 1)
    list.push({
      id: it.id,
      label: it.label,
      initial: it.label.trim().charAt(0) || '?',
      x: CX + ORBIT * 1.12 * Math.cos(angle),
      y: CY + ORBIT * 0.8 * Math.sin(angle),
      r: 24,
      isUser: false,
      isGroup: isGroupId(it.id),
      isRemote: isRemoteId(it.id),
    })
  })
  return list
})

/** 无向聚合：双向计数合并为一段关系（原型「谁在和谁说话」语义；store 投影保持有向事实） */
const undirectedEdges = computed(() => {
  const map = new Map<string, { a: string; b: string; count: number }>()
  for (const e of kernel.edges) {
    const [a, b] = e.from < e.to ? [e.from, e.to] : [e.to, e.from]
    const key = `${a}|${b}`
    const cur = map.get(key)
    if (cur) cur.count += e.count
    else map.set(key, { a, b, count: e.count })
  }
  return [...map.values()]
})

/** 贝塞尔弧（同原型算法：交替拱向两侧避免重叠）；端点已移出名册的历史边不画 */
const edgeGeoms = computed<EdgeGeom[]>(() => {
  const pos = new Map(nodes.value.map((n) => [n.id, n]))
  const out: EdgeGeom[] = []
  undirectedEdges.value.forEach((e, i) => {
    const a = pos.get(e.a)
    const b = pos.get(e.b)
    if (!a || !b) return
    const mx = (a.x + b.x) / 2
    const my = (a.y + b.y) / 2
    const dx = b.x - a.x
    const dy = b.y - a.y
    const len = Math.hypot(dx, dy) || 1
    const off = Math.min(len * 0.1, 30) * (i % 2 ? 1 : -1)
    out.push({
      key: `${e.a}->${e.b}`,
      from: e.a,
      to: e.b,
      count: e.count,
      d: `M${a.x} ${a.y} Q${(mx - (dy / len) * off).toFixed(1)} ${(my + (dx / len) * off).toFixed(1)} ${b.x} ${b.y}`,
      width: Math.min(1.5 + Math.sqrt(e.count) * 0.9, 6.5),
      // 端点含 user=消息边；含群=群聊边（群内发言非委派——灰与消息边同族）；
      // 含远端成员=remote 边（info 虚线——跨公网 relay 语义）；否则 A2A 委派
      kind:
        isRemoteId(e.a) || isRemoteId(e.b)
          ? 'remote'
          : e.a === 'user' || e.b === 'user'
            ? 'user'
            : isGroupId(e.a) || isGroupId(e.b)
              ? 'group'
              : 'a2a',
    })
  })
  return out
})

/** 节点消息量合计（排行与节点徽标） */
const nodeMsg = computed<Record<string, number>>(() => {
  const m: Record<string, number> = {}
  for (const e of kernel.edges) {
    m[e.from] = (m[e.from] ?? 0) + e.count
    m[e.to] = (m[e.to] ?? 0) + e.count
  }
  return m
})

const ranking = computed(() => [...edgeGeoms.value].sort((a, b) => b.count - a.count).slice(0, 5))

const labelOf = (id: string): string => nodes.value.find((n) => n.id === id)?.label ?? id
const isSteward = (id: string): boolean => kernel.stewardId === id

/** 远端成员在场判定（状态点事实源：remoteRooms 投影——离场仍留节点（会话历史可看）；
 *  键空间 remote:<roomId>:<memberId>） */
const remoteOnline = (id: string): boolean => {
  const [, roomId, memberId] = id.split(':')
  if (roomId === undefined || memberId === undefined) return false
  return kernel.remoteRooms.some(
    (r) => r.roomId === roomId && r.members.some((m) => m.memberId === memberId && m.connected),
  )
}

/** 节点取色（排行/详情 dot）：user 中性深灰、群中性 ink3（菱形不取身份色）、
 *  远端成员 info 蓝（mirror 身份——原型 delta 同款）、agent 身份色 */
const nodeColor = (id: string): string =>
  id === 'user' ? 'var(--ink2)' : isGroupId(id) ? 'var(--ink3)' : isRemoteId(id) ? 'var(--info)' : kernel.colorOf(id)

/** 聚焦群的档案（P5 Step 4）：成员显示名列表 */
const groupMembersOf = (id: string): string[] => {
  const g = kernel.groups.find((x) => x.groupId === id)
  return g ? g.members.map((m) => kernel.roster.find((a) => a.agentId === m)?.name ?? m) : []
}

/** agent 工作中集合（P4 Step 12 状态点：runs 投影——该 agent 有 running run 即工作中；
 *  与 BoxesView 归属 chip 同源事实）。user 节点无 run 概念，不取状态点。 */
const workingAgentIds = computed(() => {
  const s = new Set<string>()
  for (const r of kernel.runs) if (r.state === 'running') s.add(r.agentId)
  return s
})

/** 节点详情状态行（原型 statusText 语义）：run summary 在场则附注一句 */
const statusTextOf = (agentId: string): string => {
  const run = kernel.runs.find((r) => r.agentId === agentId && r.state === 'running')
  return run ? `工作中${run.summary ? ` · ${run.summary}` : ''}` : '空闲'
}

/** 节点详情模型行：per-agent 覆盖后置（裁定 F）——默认模型（自动），如实呈现 */
const modelLabel = computed(() => {
  const p = kernel.providers.find((x) => x.name === kernel.defaultProvider)
  if (!p) return '未配置'
  const model = kernel.defaultModel ?? p.models[0]?.id
  return `默认模型（${p.name}${model ? ' · ' + model : ''}）`
})

// ---- 聚焦与退隐（点击节点/连线进侧栏详情 + 无关元素退隐；点空白/Esc 退出；
//      hover/键盘 focus 先行预览退隐——离开自然回落聚焦态，原型 graphApplyDim 同语义） ----

type Focus = { type: 'node'; key: string } | { type: 'edge'; key: string } | null
const focus = ref<Focus>(null)
const hover = ref<Focus>(null)

/** 退隐保持集的活动源：hover 优先（在场时按 hover 算），离开回落 focus */
const active = computed<Focus>(() => hover.value ?? focus.value)

const keepSet = computed<Set<string> | null>(() => {
  const f = active.value
  if (!f) return null
  if (f.type === 'node') {
    const keep = new Set([f.key])
    for (const e of edgeGeoms.value) {
      if (e.from === f.key) keep.add(e.to)
      else if (e.to === f.key) keep.add(e.from)
    }
    return keep
  }
  const e = edgeGeoms.value.find((x) => x.key === f.key)
  return e ? new Set([e.from, e.to]) : null
})

const dimNode = (id: string): boolean => keepSet.value !== null && !keepSet.value.has(id)
const dimEdge = (e: EdgeGeom): boolean =>
  keepSet.value !== null && (!keepSet.value.has(e.from) || !keepSet.value.has(e.to))

const focusedEdge = computed(() =>
  focus.value?.type === 'edge' ? (edgeGeoms.value.find((x) => x.key === focus.value?.key) ?? null) : null,
)

const clearFocus = (): void => {
  focus.value = null
}

const onKey = (e: KeyboardEvent): void => {
  if (e.key === 'Escape') clearFocus()
}
onMounted(() => document.addEventListener('keydown', onKey))
onUnmounted(() => document.removeEventListener('keydown', onKey))

/** 进入会话（user 节点无会话可进；群走 openGroup——与 agent 会话互斥） */
const goTo = (id: string): void => {
  if (isGroupId(id)) ui.openGroup(id)
  else ui.openAgent(id)
  ui.switchView('console')
}
</script>

<template>
  <section class="graph-wrap">
    <div class="graph-canvas" @click="clearFocus">
      <svg viewBox="0 0 900 524" role="img" aria-label="社交图谱">
        <defs>
          <filter id="gshadow" x="-50%" y="-50%" width="200%" height="200%">
            <feDropShadow dx="0" dy="1.5" stdDeviation="2.5" flood-opacity="0.28" />
          </filter>
        </defs>

        <g
          v-for="e in edgeGeoms"
          :key="e.key"
          class="gedge-g"
          :class="{ 'is-dim': dimEdge(e), 'is-hi': focusedEdge?.key === e.key }"
          role="button"
          :aria-label="`${labelOf(e.from)} 与 ${labelOf(e.to)} · ${e.count} 条消息 · 点击查看详情`"
          tabindex="0"
          @click.stop="focus = { type: 'edge', key: e.key }"
          @keydown.enter.prevent="focus = { type: 'edge', key: e.key }"
          @mouseenter="hover = { type: 'edge', key: e.key }"
          @mouseleave="hover = null"
          @focus="hover = { type: 'edge', key: e.key }"
          @blur="hover = null"
        >
          <path class="gedge" :class="e.kind" :d="e.d" :stroke-width="e.width.toFixed(1)"></path>
          <path class="gedge-hit" :d="e.d"></path>
        </g>

        <g
          v-for="n in nodes"
          :key="n.id"
          class="gnode"
          :class="{ 'is-dim': dimNode(n.id), 'is-focus': focus?.type === 'node' && focus.key === n.id }"
          role="button"
          :aria-label="`${n.label} · ${nodeMsg[n.id] ?? 0} 条消息 · 点击查看详情`"
          tabindex="0"
          @click.stop="focus = focus?.type === 'node' && focus.key === n.id ? null : { type: 'node', key: n.id }"
          @keydown.enter.prevent="focus = { type: 'node', key: n.id }"
          @mouseenter="hover = { type: 'node', key: n.id }"
          @mouseleave="hover = null"
          @focus="hover = { type: 'node', key: n.id }"
          @blur="hover = null"
        >
          <!-- 群节点（P5 Step 4，原型 ggroup）：菱形（rotate 45 方块）+ chat 图标居中——
               无状态点（群无 run 概念，过程归成员）与首字母（聚合对象非身份） -->
          <template v-if="n.isGroup">
            <g :transform="`rotate(45 ${n.x} ${n.y})`">
              <rect
                class="gdisc ggroup"
                :x="n.x - n.r * 0.86"
                :y="n.y - n.r * 0.86"
                :width="n.r * 1.72"
                :height="n.r * 1.72"
                rx="7"
                filter="url(#gshadow)"
              ></rect>
            </g>
            <g class="gicon" :transform="`translate(${n.x - 7} ${n.y - 7}) scale(0.583)`">
              <path :d="CHAT_ICON"></path>
            </g>
          </template>
          <template v-else>
            <circle
              class="gdisc"
              :class="{ 'gdisc-remote': n.isRemote }"
              :cx="n.x"
              :cy="n.y"
              :r="n.r"
              :style="{ fill: n.isUser ? 'var(--ink2)' : n.isRemote ? 'var(--info)' : kernel.colorOf(n.id) }"
              filter="url(#gshadow)"
            ></circle>
            <text class="ginit" :x="n.x" :y="n.y + 4.5">{{ n.initial }}</text>
            <!-- 状态点（P4 Step 12：runs 投影 working/idle——steward 徽标点退役，
                 管家区分保留在详情「角色」kv 与名册；user 节点无 run 概念不取点；
                 远端成员无 run 概念——在场/离场事实点（info 空心，原型 stat-dot.remote 同族） -->
            <circle
              v-if="!n.isUser"
              class="gstatus"
              :class="n.isRemote ? (remoteOnline(n.id) ? 'remote' : 'idle') : workingAgentIds.has(n.id) ? 'working' : 'idle'"
              :cx="n.x + n.r * 0.74"
              :cy="n.y + n.r * 0.74"
              r="4.5"
            ></circle>
          </template>
          <text class="glabel" :x="n.x" :y="n.y + n.r + 17">{{ n.label }}</text>
          <text v-if="(nodeMsg[n.id] ?? 0) > 0" class="gcount" :x="n.x" :y="n.y + n.r + 30">×{{ nodeMsg[n.id] ?? 0 }}</text>
        </g>
      </svg>

      <p v-if="edgeGeoms.length === 0" class="graph-empty">还没有消息往来——在控制台发一条消息试试</p>
    </div>

    <aside class="graph-side">
      <!-- 图例（默认态） -->
      <template v-if="!focus">
        <div class="graph-title">社交图谱</div>
        <p class="graph-sub">
          谁在和谁说话：节点是会话对象（身份色圆盘 + 工作状态点，群是菱形），弧线宽度是消息量。
          点击节点或连线聚焦详情，点空白处或 Esc 退出；进入会话用详情里的按钮。
        </p>
        <div class="side-sec">图例</div>
        <div class="graph-sum mono">{{ edgeGeoms.length }} 对关系 · {{ kernel.edges.reduce((s, e) => s + e.count, 0) }} 条消息</div>
        <div class="legend-row"><span class="lg-line user"></span>你 ↔ Agent · 消息边</div>
        <div class="legend-row"><span class="lg-line a2a"></span>Agent ↔ Agent · 委派边（Agent 间协作）</div>
        <div class="legend-row"><span class="lg-line remote"></span>你 ↔ 远端成员 · 虚线蓝 relay</div>
        <div class="legend-row"><span class="lg-diamond"></span>菱形 = 群聊 · 群内发言计入灰边</div>
        <div class="legend-row"><span class="lg-dot" style="background: var(--accent)"></span>状态点 = 工作中（脉冲）</div>
        <div class="legend-row"><span class="lg-dot" style="background: var(--ink3)"></span>状态点 = 空闲</div>

        <div v-if="ranking.length" class="side-sec">对话量排行</div>
        <div v-for="e in ranking" :key="e.key" class="rank-row">
          <span class="rank-dots">
            <span class="lg-dot" :style="{ background: nodeColor(e.from) }"></span>
            <span class="lg-dot" :style="{ background: nodeColor(e.to) }"></span>
          </span>
          <span class="rank-label">{{ labelOf(e.from) }} ↔ {{ labelOf(e.to) }}</span>
          <span class="rcnt mono">×{{ e.count }}</span>
        </div>
      </template>

      <!-- 边详情 -->
      <template v-else-if="focusedEdge">
        <div class="graph-head">
          <button class="back-btn" title="返回图例" aria-label="返回图例" @click="clearFocus"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.5 6L8.5 12l6 6"/></svg></button>
          <span class="graph-title">关系详情</span>
        </div>
        <div class="detail-title">
          <span :style="{ color: nodeColor(focusedEdge.from) }">{{ labelOf(focusedEdge.from) }}</span>
          ↔
          <span :style="{ color: nodeColor(focusedEdge.to) }">{{ labelOf(focusedEdge.to) }}</span>
        </div>
        <div class="kv"><span class="k">累计消息</span><span class="v mono">×{{ focusedEdge.count }}</span></div>
        <div class="kv">
          <span class="k">边类型</span>
          <span class="v">{{ focusedEdge.kind === 'user' ? '消息边（你 ↔ Agent）' : focusedEdge.kind === 'group' ? '群聊边（↔ 群）' : '委派边（Agent 间协作）' }}</span>
        </div>
        <p class="ctx-note">
          {{ focusedEdge.kind === 'user'
            ? '本地边：你对 Agent 的指挥与回复共同计入。'
            : focusedEdge.kind === 'group'
              ? '本地边：群内发言共同计入（发起者的用户消息与成员回复，sysnote 不计）。'
              : '本地边：Agent 间的协作派发与回执共同计入（双侧会话记录镜像）。' }}
        </p>
      </template>

      <!-- 节点详情 -->
      <template v-else>
        <div class="graph-head">
          <button class="back-btn" title="返回图例" aria-label="返回图例" @click="clearFocus"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.5 6L8.5 12l6 6"/></svg></button>
          <span class="graph-title">节点详情</span>
        </div>
        <div class="detail-title">
          <span class="lg-dot" :style="{ background: nodeColor(focus.key) }"></span>
          {{ labelOf(focus.key) }}
        </div>
        <div v-if="focus.key === 'user'" class="kv"><span class="k">身份</span><span class="v">本机主人 · 所有对话的起点</span></div>
        <!-- 群节点详情（P5 Step 4）：类型/成员/消息量——群无角色与状态点（leaderless，过程归成员） -->
        <template v-else-if="isGroupId(focus.key)">
          <div class="kv"><span class="k">类型</span><span class="v">群聊 · 有界轮转 · leaderless</span></div>
          <div class="kv"><span class="k">成员</span><span class="v">{{ groupMembersOf(focus.key).join('、') }}</span></div>
          <div class="kv"><span class="k">消息量</span><span class="v mono">×{{ nodeMsg[focus.key] ?? 0 }}</span></div>
        </template>
        <template v-else-if="isRemoteId(focus.key)">
          <div class="kv"><span class="k">类型</span><span class="v">远端成员 · mirror（跨用户房间）</span></div>
          <div class="kv"><span class="k">状态</span><span class="v">{{ remoteOnline(focus.key) ? '在场' : '离场（会话历史可看）' }}</span></div>
          <div class="kv"><span class="k">消息量</span><span class="v mono">×{{ nodeMsg[focus.key] ?? 0 }}</span></div>
        </template>
        <template v-else>
          <div class="kv"><span class="k">角色</span><span class="v">{{ isSteward(focus.key) ? '管家（默认路由）' : 'worker' }}</span></div>
          <div class="kv"><span class="k">状态</span><span class="v">{{ statusTextOf(focus.key) }}</span></div>
          <div class="kv"><span class="k">模型</span><span class="v">{{ modelLabel }}</span></div>
          <div class="kv"><span class="k">消息量</span><span class="v mono">×{{ nodeMsg[focus.key] ?? 0 }}</span></div>
        </template>
        <div class="side-sec">主要关系</div>
        <div
          v-for="e in edgeGeoms.filter((x) => x.from === focus.key || x.to === focus.key).sort((a, b) => b.count - a.count)"
          :key="e.key"
          class="rank-row clickable"
          @click="focus = { type: 'edge', key: e.key }"
        >
          <span class="lg-dot" :style="{ background: nodeColor(e.from === focus.key ? e.to : e.from) }"></span>
          <span class="rank-label">{{ labelOf(e.from === focus.key ? e.to : e.from) }}</span>
          <span class="rcnt mono">×{{ e.count }}</span>
        </div>
        <p v-if="focus.key !== 'user' && edgeGeoms.every((x) => x.from !== focus.key && x.to !== focus.key)" class="ctx-note">
          还没有消息往来。
        </p>
        <div v-if="focus.key !== 'user'" class="side-actions">
          <button class="btn btn-secondary btn-sm" @click="goTo(focus.key)">进入会话</button>
        </div>
      </template>
    </aside>
  </section>
</template>

<style scoped src="./graph.css"></style>
