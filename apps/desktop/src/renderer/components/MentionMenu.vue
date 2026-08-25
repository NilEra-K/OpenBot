<script setup lang="ts">
/**
 * @提及补全菜单（P4 Step 4，原型 .mention-menu 迁移）：呈现层组件——
 * 开合/过滤/选中态归 ConsoleView（键盘事件必须在 composer input 里先行消费，
 * 这里只渲染与点击上报）。@全员/群组/远端不出现（裁定 C：广播随 P5 广播协议）。
 */
import { agentColor } from '../lib/agent-color'

export interface MentionItem {
  agentId: string
  name: string
  sub: string
}

defineProps<{ items: MentionItem[]; sel: number }>()
const emit = defineEmits<{ pick: [index: number] }>()
</script>

<template>
  <div class="mention-menu" role="listbox" aria-label="提及成员">
    <button
      v-for="(it, i) in items"
      :key="it.agentId"
      class="m-item"
      :class="{ 'is-sel': i === sel }"
      type="button"
      role="option"
      :aria-selected="i === sel"
      @mousedown.prevent
      @click="emit('pick', i)"
    >
      <span class="stat-dot" :style="{ background: agentColor(it.agentId) }"></span>
      <span class="mm-name">@{{ it.name }}</span>
      <span class="mm-sub">{{ it.sub }}</span>
    </button>
  </div>
</template>

<style scoped>
.mention-menu {
  position: absolute;
  left: 18px;
  right: 18px;
  bottom: calc(100% + 6px);
  z-index: 40;
  padding: 4px;
  border: 1px solid var(--line-strong);
  border-radius: 10px;
  background: var(--bg2);
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.4);
  overflow: hidden;
}

.m-item {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  height: 32px;
  padding: 0 10px;
  border: none;
  border-radius: 7px;
  background: none;
  color: var(--ink);
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.m-item:hover,
.m-item.is-sel {
  background: var(--bg3);
}

.stat-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex: none;
}

.mm-name {
  font-size: 12.5px;
}

.mm-sub {
  margin-left: auto;
  font-size: 11px;
  color: var(--ink3);
}
</style>
