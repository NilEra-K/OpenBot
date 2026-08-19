<script setup lang="ts">
/**
 * 名册面板（prototype.html 迁移）：本地 agents 分节 + 管家徽标 + 状态行。
 * P2 真实数据：roster 事实全部来自事件流快照；群组/远端分节是 P4/P5 语义，数据到了再显示。
 */
import { useKernelStore } from '../stores/kernel'
import { useUiStore } from '../stores/ui'
import { agentColor } from '../lib/agent-color'

const kernel = useKernelStore()
const ui = useUiStore()

const initialOf = (id: string, name?: string): string => (name ?? id).trim().charAt(0) || '?'

const statusOf = (role: 'steward' | 'worker'): string => (role === 'steward' ? '管家 · 默认对话者' : 'worker')
</script>

<template>
  <aside class="roster" aria-label="成员名册">
    <div class="roster-head">本地 AGENTS</div>
    <button
      v-for="agent in kernel.roster"
      :key="agent.agentId"
      class="roster-item"
      :class="{ active: ui.activeAgentId === agent.agentId }"
      @click="ui.activeAgentId = agent.agentId"
    >
      <span class="avatar" :style="{ background: agentColor(agent.agentId) }">{{ initialOf(agent.agentId, agent.name) }}</span>
      <span class="ri-text">
        <span class="ri-name">{{ agent.name ?? agent.agentId }}</span>
        <span class="ri-sub">{{ statusOf(agent.role) }}</span>
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
  font-size: 11px;
  color: var(--ink3);
  letter-spacing: 0.5px;
  padding: 4px 8px 8px;
}

.roster-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 7px 8px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--ink);
  cursor: pointer;
  text-align: left;
  transition: background 140ms var(--ease);
}

.roster-item:hover {
  background: var(--bg2);
}

.roster-item.active {
  background: var(--bg3);
}

.avatar {
  width: 28px;
  height: 28px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 650;
  color: #141414;
  flex: none;
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
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ri-sub {
  font-size: 11px;
  color: var(--ink3);
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
