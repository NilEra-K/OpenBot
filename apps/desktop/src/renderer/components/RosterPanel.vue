<script setup lang="ts">
/**
 * 名册面板（prototype.html 迁移）：「成员」头 + 本地 agents 分节 + 管家徽标 + 状态机。
 * P2 真实数据：roster 事实来自事件流快照；「工作中/空闲」由 runs 投影（休眠/远端是 P4/P5 语义，数据到了再显示）。
 */
import { useKernelStore } from '../stores/kernel'
import { useUiStore } from '../stores/ui'
import type { RosterEntry } from '../stores/kernel'
import { agentColor } from '../lib/agent-color'

const kernel = useKernelStore()
const ui = useUiStore()

const initialOf = (id: string, name?: string): string => (name ?? id).trim().charAt(0) || '?'

/** agent 是否有 running run（lane 排他保证同一 agent 至多一个活跃 turn） */
const isWorking = (agentId: string): boolean =>
  kernel.runs.some((r) => r.agentId === agentId && r.state === 'running')

const subOf = (agent: RosterEntry): string => {
  const base = agent.role === 'steward' ? '管家 · 默认对话者' : 'worker'
  return isWorking(agent.agentId) ? `工作中 · ${base}` : base
}
</script>

<template>
  <aside class="roster" aria-label="成员名册">
    <div class="roster-head">成员</div>
    <div class="roster-sec">本地 AGENTS</div>
    <button
      v-for="agent in kernel.roster"
      :key="agent.agentId"
      class="roster-item"
      :class="{ active: ui.activeAgentId === agent.agentId }"
      @click="ui.activeAgentId = agent.agentId"
    >
      <span class="avatar" :style="{ background: agentColor(agent.agentId) }">
        {{ initialOf(agent.agentId, agent.name) }}
        <span class="stat-dot" :class="isWorking(agent.agentId) ? 'working' : 'idle'"></span>
      </span>
      <span class="ri-text">
        <span class="ri-name">{{ agent.name ?? agent.agentId }}</span>
        <span class="ri-sub">{{ subOf(agent) }}</span>
      </span>
      <span v-if="agent.role === 'steward'" class="chip chip-accent">管家</span>
    </button>
    <div v-if="kernel.roster.length === 0" class="roster-empty">名册为空——等待 agent 注册</div>
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
  border-color: rgba(238, 177, 84, 0.35);
  color: var(--accent);
  background: var(--accent-weak);
}

.roster-empty {
  color: var(--ink3);
  font-size: 12px;
  padding: 12px 8px;
}
</style>
