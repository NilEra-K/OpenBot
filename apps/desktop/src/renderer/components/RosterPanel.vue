<script setup lang="ts">
/**
 * 名册面板（prototype.html 迁移）：「成员」头 + 本地 agents 分节 + 管家徽标 + 状态机 +
 * 群组分节（P5 Step 4，原型 sec('群组')——群档案事实来自 v1.group.list，条目点击进群聊流）。
 * P2 真实数据：roster 事实来自事件流快照；「工作中/空闲」由 runs 投影（休眠/远端是 P4/P5 语义，数据到了再显示）。
 */
import { useKernelStore } from '../stores/kernel'
import { useUiStore } from '../stores/ui'
import type { GroupEntry, RosterEntry } from '../stores/kernel'
import BotBallAvatar from './BotBallAvatar.vue'

const kernel = useKernelStore()
const ui = useUiStore()

const initialOf = (id: string, name?: string): string => (name ?? id).trim().charAt(0) || '?'

/** 群成员显示名列表（档案 name 缺席回退 id——与 agent 同规则） */
const memberNames = (g: GroupEntry): string =>
  g.members.map((id) => kernel.roster.find((a) => a.agentId === id)?.name ?? id).join(' + ')

/** agent 是否有进行中 run（lane 排他保证同一 agent 至多一个活跃 turn）；
 *  queued + running 与 ConsoleView activeRun 同口径（v0.1.66——排队期 roster/stream-head 两球表情分叉修复） */
const isWorking = (agentId: string): boolean =>
  kernel.runs.some((r) => r.agentId === agentId && (r.state === 'running' || r.state === 'queued'))

/** 群内任一成员轮转中（群条目 sub——过程归成员，群本身无 run） */
const groupWorking = (g: GroupEntry): boolean =>
  g.members.some((id) => isWorking(id))

const subOf = (agent: RosterEntry): string => {
  const base = agent.role === 'steward' ? '管家 · 默认对话者' : 'worker'
  return isWorking(agent.agentId) ? `工作中 · ${base}` : base
}

/** 群图标（prototype ICONS.chat 同源 path；视图 0 0 24 24） */
const CHAT_ICON = '<path d="M4 5h16a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H10l-5 4v-4H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z"/>'
/** 远端成员图标（P7）：地球两笔弧线——跨公网房间的语义（stroke 风格与图标体系一致） */
const REMOTE_ICON = '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.8 2.6 2.8 15.4 0 18M12 3c-2.8 2.6-2.8 15.4 0 18"/>'

/** 房间显示名：备注名（接入状态表）缺省回退房间码 */
const roomLabelOf = (roomId: string): string =>
  kernel.relays.find((r) => r.roomId === roomId)?.roomName?.trim() || roomId
</script>

<template>
  <aside class="roster" aria-label="成员名册">
    <div class="roster-head">成员</div>
    <div class="roster-sec">本地 AGENTS</div>
    <button
      v-for="agent in kernel.roster"
      :key="agent.agentId"
      class="roster-item"
      :class="{ active: ui.activeGroupId === null && ui.activeAgentId === agent.agentId }"
      @click="ui.openAgent(agent.agentId)"
    >
      <!-- v0.1.65：首字母色块 → BotBall 小球（身份色染身；表情映射见 lib/bot-ball/emotions.openbot.ts；
           stat-dot 状态角标保留） -->
      <span class="avatar">
        <BotBallAvatar :color="kernel.colorOf(agent.agentId)" :state="isWorking(agent.agentId) ? 'working' : 'idle'" />
        <span class="stat-dot" :class="isWorking(agent.agentId) ? 'working' : 'idle'"></span>
      </span>
      <span class="ri-text">
        <span class="ri-name">{{ agent.name ?? agent.agentId }}</span>
        <span class="ri-sub">{{ subOf(agent) }}</span>
      </span>
      <!-- 未读徽标（P4 Step 6）：非当前会话的 agent 回复计数；进入会话清零（呈现层语义） -->
      <span v-if="(ui.unread[agent.agentId] ?? 0) > 0" class="ri-badge" :aria-label="`${ui.unread[agent.agentId]} 条未读`">
        {{ ui.unread[agent.agentId] }}
      </span>
      <span v-if="agent.role === 'steward'" class="chip chip-accent">管家</span>
    </button>
    <!-- 新建 agent 入口（P4 Step 5；原型 .roster-new 同款）——向导经命令面注册 -->
    <button class="roster-new" type="button" @click="ui.openWizard()">＋ 新建 agent</button>
    <div v-if="kernel.roster.length === 0" class="roster-empty">名册为空——等待 agent 注册</div>

    <!-- 群组分节（P5 Step 4，原型 sec('群组')）：群档案事实驱动——无群时只有建群入口 -->
    <div class="roster-sec">群组</div>
    <button
      v-for="g in kernel.groups"
      :key="g.groupId"
      class="roster-item"
      :class="{ active: ui.activeGroupId === g.groupId }"
      @click="ui.openGroup(g.groupId)"
    >
      <span class="avatar avatar-group">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" v-html="CHAT_ICON"></svg>
        <span class="stat-dot" :class="groupWorking(g) ? 'working' : 'idle'"></span>
      </span>
      <span class="ri-text">
        <span class="ri-name">{{ g.name }}</span>
        <span class="ri-sub">{{ memberNames(g) }}</span>
      </span>
      <!-- 未读徽标：群成员发言/群 sysnote 按群计数（进入群会话清零） -->
      <span v-if="(ui.unread[g.groupId] ?? 0) > 0" class="ri-badge" :aria-label="`${ui.unread[g.groupId]} 条未读`">
        {{ ui.unread[g.groupId] }}
      </span>
    </button>
    <button class="roster-new" type="button" @click="ui.openGroupWizard()">＋ 建群</button>

    <!-- 房间成员分节（P7 多房间轮）：按房间分组（房名 sub + 成员行）——远端 mirror 成员是
         易态投影，点击进该成员的 mirror 会话（只读） -->
    <template v-if="kernel.remoteRooms.length > 0">
      <div class="roster-sec">房间成员</div>
      <template v-for="room in kernel.remoteRooms" :key="room.roomId">
        <div class="roster-group-sub">{{ roomLabelOf(room.roomId) }}</div>
        <button
          v-for="m in room.members"
          :key="`${room.roomId}:${m.memberId}`"
          class="roster-item"
          :class="{ active: ui.activeAgentId === `remote:${room.roomId}:${m.memberId}` }"
          :aria-label="`远端成员 ${m.displayName} 的 mirror 会话`"
          @click="ui.openAgent(`remote:${room.roomId}:${m.memberId}`)"
        >
          <span class="avatar avatar-group">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" v-html="REMOTE_ICON"></svg>
            <span class="stat-dot" :class="m.connected ? 'idle' : ''"></span>
          </span>
          <span class="ri-text">
            <span class="ri-name">{{ m.displayName }}</span>
            <span class="ri-sub">远端 mirror</span>
          </span>
        </button>
      </template>
    </template>
  </aside>
</template>

<style scoped>
.roster {
  border-right: 1px solid var(--line);
  background: var(--bg1);
  min-height: 0;
  overflow-y: auto;
  padding: 12px 10px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.roster-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 2px 8px 8px;
  font-size: 12px;
  font-weight: 600;
}

.roster-sec {
  font-size: 11px;
  color: var(--ink3);
  letter-spacing: 0.06em;
  padding: 14px 8px 5px;
}

/* 房间分组小节行（P7 多房间轮）：房名（备注名缺省房码）弱化呈现 */
.roster-group-sub {
  font-size: 10.5px;
  color: var(--ink3);
  padding: 2px 8px 3px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.roster-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  height: 38px;
  padding: 0 8px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  color: var(--ink);
  cursor: pointer;
  text-align: left;
  transition: background 140ms var(--ease), border-color 140ms var(--ease);
}

.roster-item:hover {
  background: var(--bg2);
}

.roster-item.active {
  background: var(--bg3);
  border-color: var(--line-strong);
}

.avatar {
  position: relative;
  width: 26px;
  height: 26px;
  border-radius: 7px;
  display: grid;
  place-items: center;
  font-size: 11.5px;
  font-weight: 600;
  color: #141414;
  flex: none;
}

/* 群头像（P5 Step 4，原型 .avatar-group 同款）：中性底 + chat 图标——群是聚合对象不取身份色 */
.avatar-group {
  background: var(--bg3);
  color: var(--ink2);
  border: 1px solid var(--line-strong);
}

/* 头像右下角状态点（原型 .avatar .stat-dot；数据来自 runs 投影，非装饰） */
.avatar .stat-dot {
  position: absolute;
  right: -2px;
  bottom: -2px;
  border: 2px solid var(--bg1);
}

.stat-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex: none;
}

.stat-dot.working {
  background: var(--accent);
  animation: roster-pulse 1.6s var(--ease) infinite;
}

.stat-dot.idle {
  background: var(--ink3);
  opacity: 0.55;
}

@keyframes roster-pulse {
  0%,
  100% {
    opacity: 1;
  }

  50% {
    opacity: 0.35;
  }
}

.ri-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.ri-name {
  font-size: 13px;
  font-weight: 550;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ri-sub {
  font-size: 11px;
  color: var(--ink3);
  margin-top: -2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chip {
  display: inline-flex;
  align-items: center;
  height: 18px;
  padding: 0 7px;
  border-radius: 9px;
  border: 1px solid var(--line-strong);
  font-size: 11px;
  color: var(--ink2);
  flex: none;
}

.chip-accent {
  border-color: rgba(var(--accent-rgb), 0.35);
  color: var(--accent);
  background: var(--accent-weak);
}

.roster-empty {
  color: var(--ink3);
  font-size: 12px;
  padding: 12px 8px;
}

/* 未读徽标（P4 Step 6，原型 .rrow .badge 同语义）：accent 数字节 */
.ri-badge {
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  display: grid;
  place-items: center;
  border-radius: 9px;
  background: var(--accent-weak);
  border: 1px solid rgba(var(--accent-rgb), 0.35);
  color: var(--accent);
  font-size: 10.5px;
  font-weight: 650;
  flex: none;
}

/* 新建入口（P4 Step 5 agent / P5 Step 4 群）：虚线边框弱化按钮——非事实行，视觉与名册条目区分 */
.roster-new {
  height: 34px;
  margin-top: 6px;
  border: 1px dashed var(--line-strong);
  border-radius: 8px;
  background: none;
  color: var(--ink3);
  font: inherit;
  font-size: 12.5px;
  cursor: pointer;
  transition: color 140ms var(--ease), border-color 140ms var(--ease), background 140ms var(--ease);
}

.roster-new:hover {
  color: var(--accent);
  border-color: var(--accent);
  background: var(--accent-weak);
}
</style>
