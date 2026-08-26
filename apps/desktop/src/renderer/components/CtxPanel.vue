<script setup lang="ts">
/**
 * ctx 面板（prototype.html 迁移，语义：Box 的显示器——VMware 操作区的本地替身）：
 * 一块屏幕——当前会话 agent 的专属 Box（roster 事实，注册即有——任意时刻可点开操作台；
 * 屏幕内容是 exec 流实况，无执行史时诚实显示 IDLE 空缺态；思考过程在对话流内呈现，
 * llm 是 agent 进程不在 Box 内，不冒充屏幕内容——诚实分层）。
 * 底部「cs-hint 提示条」：接管的去向提示（caps 分流文案——interactive 才承诺键盘接管）。
 * 档案模式（P4 Step 7，原型 ctxMode='settings'）：该会话的 Settings——档案 kv / 协作对象（edges 事实，
 * 点击跳会话）/ 记忆与自动化如实空缺态（数据源属后续版本，不放假条目）。
 * 群会话（P5 Step 4）：屏幕=群状态屏（轮转态 + 最近 sysnote——群无 Box 如实呈现）；
 * 档案=群档案（成员行跳会话 + 轮转边界如实 kv——原型的「3 轮/10 条/每员 2 条」是编造数值不照搬）。
 * 图形界面画面（GUI 像素流）属后续版本（plan-p3 补记）。
 */
import { computed } from 'vue'
import { useKernelStore } from '../stores/kernel'
import { useUiStore } from '../stores/ui'
import BoxScreen from './BoxScreen.vue'

const kernel = useKernelStore()
const ui = useUiStore()

/** 当前会话 agent 的流块 */
const mine = computed(() => kernel.streams.filter((s) => s.agentId === ui.activeAgentId))

/** 屏幕：exec 块按时间序（取最近 6 条，屏幕缓冲有限） */
const screenBlocks = computed(() => mine.value.filter((s) => s.stream === 'exec').slice(-6))

const liveExec = computed(() => screenBlocks.value.some((b) => b.state === 'live'))

/**
 * 屏幕 bar 的 Box 标识：当前会话 agent 的专属 Box（roster 事实——注册即创建，与原型 AGENT_BOX
 * 静态映射同语义）。exec 史只决定屏幕显示内容，不决定可点性——任意时刻可接管。
 */
const screenBoxId = computed(
  () => kernel.roster.find((a) => a.agentId === ui.activeAgentId)?.boxId ?? null,
)

/** 当前 Box 休眠中（P4 Step 8）：屏幕灰化 + 提示（v1.box.state 事件同源——与 Box 卡 chip 一致） */
const boxAsleep = computed(
  () => screenBoxId.value !== null && kernel.boxes.find((b) => b.boxId === screenBoxId.value)?.state === 'sleeping',
)

const openOps = (): void => {
  if (screenBoxId.value) ui.openBoxOps(screenBoxId.value)
}

// ---- 群会话（P5 Step 4）：全部为既有 store 投影，零内核改动 ----

/** 当前群会话对象 */
const activeGroup = computed(() =>
  ui.activeGroupId !== null ? (kernel.groups.find((g) => g.groupId === ui.activeGroupId) ?? null) : null,
)

/** 群成员条目（档案成员行）：name/role 投影 */
const groupMembers = computed(() => {
  const g = activeGroup.value
  if (!g) return []
  return g.members.map((id) => {
    const a = kernel.roster.find((x) => x.agentId === id)
    return { agentId: id, name: a?.name ?? id, role: a?.role === 'steward' ? '管家' : 'worker' }
  })
})

/** 群轮转中（runs 投影——成员任一 running；群本身无 run，过程归成员） */
const groupBusy = computed(() => {
  const g = activeGroup.value
  if (!g) return false
  return kernel.runs.some((r) => g.members.includes(r.agentId) && (r.state === 'queued' || r.state === 'running'))
})

/** 最近一条群 sysnote（状态屏注记行——建群/插话/收敛；无则空） */
const lastSysnote = computed(() => {
  const gid = ui.activeGroupId
  if (gid === null) return ''
  for (let i = kernel.messages.length - 1; i >= 0; i--) {
    const m = kernel.messages[i]
    if (m && m.groupId === gid && m.kind === 'group-sys') return m.text
  }
  return ''
})

/** 群记录上限（packages/messaging/src/group MAX_GROUP_RECORDS 的呈现面镜像——同源事实） */
const GROUP_MAX_RECORDS = 200

// ---- 档案模式（P4 Step 7）：全部为既有 store 投影，零内核改动（approvalMode 除外——boot 快照） ----

const activeAgent = computed(() => kernel.roster.find((a) => a.agentId === ui.activeAgentId) ?? null)
/** 档案标题（群会话时群名——ctx-top-sub） */
const displayName = computed(() => activeGroup.value?.name ?? activeAgent.value?.name ?? ui.activeAgentId)
const initialOf = computed(() => displayName.value.trim().charAt(0) || '?')

/** 协作对象：edges 里与该 agent 相连的 agent↔agent 边（user 端不属协作叙事），按 count 聚合 */
const collabs = computed(() => {
  const counts = new Map<string, number>()
  for (const e of kernel.edges) {
    const peer = e.from === ui.activeAgentId ? e.to : e.to === ui.activeAgentId ? e.from : null
    if (peer === null || peer === 'user' || peer === ui.activeAgentId) continue
    counts.set(peer, (counts.get(peer) ?? 0) + e.count)
  }
  return [...counts.entries()]
    .map(([peer, count]) => ({ peer, count }))
    .sort((a, b) => b.count - a.count)
})

const nameOf = (agentId: string): string => kernel.roster.find((a) => a.agentId === agentId)?.name ?? agentId

/** cs-hint 图标（prototype ICONS.terminal 同源 SVG path） */
const TERMINAL_ICON =
  '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 9l3 3-3 3M13 15h4"/>'

/** 群头像图标（prototype ICONS.chat 同源 SVG path） */
const CHAT_ICON =
  '<path d="M4 5h16a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H10l-5 4v-4H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z"/>'

const fmtTime = (at: number): string =>
  new Date(at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
const lastAt = computed(() => {
  const last = screenBlocks.value.at(-1)
  return last ? fmtTime(last.at) : ''
})
</script>

<template>
  <aside class="ctx" :aria-label="ui.ctxSettings ? '会话档案' : activeGroup ? '群状态屏' : 'Box 实况屏幕'">
    <!-- 档案模式（P4 Step 7）：返回顶栏 + 群/agent 档案分流（P5 Step 4） -->
    <template v-if="ui.ctxSettings">
      <div class="ctx-top">
        <button class="ctx-back" type="button" title="返回执行画面" aria-label="返回执行画面" @click="ui.ctxSettings = false">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.5 6L8.5 12l6 6"/></svg>
        </button>
        <span class="ctx-top-title">Settings</span>
        <span class="ctx-top-sub">{{ displayName }}</span>
      </div>

      <!-- 群档案（P5 Step 4）：成员行 + 轮转边界如实 kv——原型编造数值（3 轮/10 条/每员 2 条）不照搬 -->
      <template v-if="activeGroup">
        <div class="ctx-head">
          <div class="avatar avatar-group">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" v-html="CHAT_ICON"></svg>
          </div>
          <div class="ctx-head-text">
            <div class="ctx-name">{{ activeGroup.name }}</div>
            <div class="ctx-sub">{{ activeGroup.members.length }} 成员 · 有界轮转 · leaderless</div>
          </div>
        </div>

        <div class="ctx-sec">成员</div>
        <button
          v-for="m in groupMembers"
          :key="m.agentId"
          class="edge-row"
          type="button"
          :title="`跳到 ${m.name} 的会话`"
          @click="ui.openAgent(m.agentId)"
        >
          <span class="stat-dot" :style="{ background: kernel.colorOf(m.agentId) }"></span>
          <span class="er-name">{{ m.name }}</span>
          <span class="cnt">{{ m.role }}</span>
        </button>

        <div class="ctx-sec">轮转边界（防爆音）</div>
        <div class="kv"><span class="k">轮次</span><span class="v">每条用户消息开新轮——无固定上限</span></div>
        <div class="kv"><span class="k">消息</span><span class="v">群记录上限 {{ GROUP_MAX_RECORDS }} 条（达限拒绝新消息）</span></div>
        <div class="kv"><span class="k">每员每轮</span><span class="v">至多 1 次发言（无话可说回 [pass]）</span></div>
        <p class="ctx-note">全员 pass 即收敛；你的新消息随时打断当前轮次（supersede）。</p>
      </template>

      <!-- agent 档案（P4 Step 7 既有） -->
      <template v-else>
        <div class="ctx-head">
          <div class="avatar" :style="{ background: kernel.colorOf(ui.activeAgentId) }">{{ initialOf }}</div>
          <div class="ctx-head-text">
            <div class="ctx-name">{{ displayName }}</div>
            <div class="ctx-sub">{{ activeAgent?.role === 'steward' ? '管家 · 默认对话者' : 'worker' }}</div>
          </div>
        </div>

        <div class="ctx-sec">档案</div>
        <div class="kv"><span class="k">角色</span><span class="v">{{ activeAgent?.role === 'steward' ? '管家（steward）' : '工人（worker）' }}</span></div>
        <div class="kv"><span class="k">模型</span><span class="v">继承全局主力{{ kernel.defaultProvider ? `（${kernel.defaultProvider}）` : '' }}<span class="kv-note">per-agent 覆盖属后续版本</span></span></div>
        <div class="kv"><span class="k">Box 归属</span><span class="v mono">{{ screenBoxId ?? '—' }}</span></div>
        <div class="kv"><span class="k">权限现状</span><span class="v">{{ kernel.approvalMode === 'manual' ? 'Box 内自由 · 出 Box 需批准（Manual 闸门）' : '自动批准' }}</span></div>

        <div class="ctx-sec">协作对象</div>
        <button
          v-for="c in collabs"
          :key="c.peer"
          class="edge-row"
          type="button"
          :title="`跳到 ${nameOf(c.peer)} 的会话`"
          @click="ui.openAgent(c.peer)"
        >
          <span class="stat-dot" :style="{ background: kernel.colorOf(c.peer) }"></span>
          <span class="er-name">{{ nameOf(c.peer) }}</span>
          <span class="cnt">×{{ c.count }}</span>
        </button>
        <div v-if="collabs.length === 0" class="mem-empty">暂无协作记录——A2A 往来后在此呈现</div>

        <div class="ctx-sec">记忆</div>
        <div class="mem-empty">记忆数据源属后续版本——内核尚无 memory 事实，不放占位条目</div>

        <div class="ctx-sec">自动化</div>
        <div class="mem-empty">自动化属后续版本（P5+ backlog）——无数据源，不放占位条目</div>
      </template>
    </template>

    <!-- 群状态屏（P5 Step 4）：群无 Box 如实呈现——轮转态（runs 投影）+ 最近注记，静态不可点 -->
    <div
      v-else-if="activeGroup"
      class="ctx-screen is-static"
      role="img"
      :aria-label="`群 ${activeGroup.name} 状态屏（${groupBusy ? '轮转中' : '空闲'}）`"
    >
      <div class="cs-bar">
        <span class="cs-live" :class="{ asleep: !groupBusy }">
          <span v-if="groupBusy" class="stat-dot working"></span>
          {{ groupBusy ? '轮转中' : '空闲' }}
        </span>
        <span class="mono">{{ activeGroup.name }}</span>
        <span class="mono">{{ activeGroup.members.length }} 成员</span>
      </div>
      <div class="cs-term">
        <div class="ctx-idle">群聊无 Box——成员在各自 Box 执行，过程与产出见成员会话
{{ lastSysnote ? `最近注记：${lastSysnote}` : '注记（建群 / 收敛 / 插话）随群流出现' }}</div>
      </div>
    </div>

    <!-- 屏幕模式：一块显示器（Box 终端实况，点击进入操作台大屏） -->
    <div
      v-else
      class="ctx-screen"
      :class="{ 'is-static': !screenBoxId, 'is-asleep': boxAsleep }"
      :role="screenBoxId ? 'button' : undefined"
      :tabindex="screenBoxId ? 0 : undefined"
      :aria-label="screenBoxId ? `进入 ${screenBoxId} 操作台` : undefined"
      @click="openOps"
      @keydown.enter.prevent="openOps"
    >
      <div class="cs-bar">
        <span class="cs-live" :class="{ asleep: !liveExec }">
          <span v-if="liveExec" class="stat-dot working"></span>
          {{ liveExec ? 'LIVE' : boxAsleep ? '休眠中' : screenBlocks.length > 0 ? '空闲' : 'IDLE' }}
        </span>
        <span class="mono">{{ screenBoxId ?? 'no box' }}</span>
        <span class="mono">{{ lastAt }}</span>
      </div>
      <div class="cs-term">
        <BoxScreen v-if="screenBlocks.length > 0" :blocks="screenBlocks" />
        <div v-else-if="boxAsleep" class="ctx-idle">Box 休眠中——rootfs 在磁盘，随时可唤醒（派活自动拉起）</div>
        <div v-else class="ctx-idle">等待任务派发——agent 在 Box 内执行命令时，这里实时显示屏幕输出</div>
      </div>
      <!-- 屏幕底部提示条（原型 .cs-hint）：caps 分流文案——不放假承诺 -->
      <div v-if="screenBoxId" class="cs-hint">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" v-html="TERMINAL_ICON"></svg>
        <span>{{ kernel.caps?.interactive ? '点击进入 Box 操作台 · 键盘直接接管' : '点击进入 Box 操作台 · 查看实况' }}</span>
      </div>
    </div>
  </aside>
</template>

<style scoped src="../views/ctx.css"></style>
