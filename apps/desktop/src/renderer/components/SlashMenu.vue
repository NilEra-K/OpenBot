<script setup lang="ts">
/**
 * Slash 命令菜单（v0.1.46「会话掌控」交互对齐 @ 提及）：输入 `/` 弹出命令联想
 * （/clear /resume /quote…），/quote 进入 agent → session 两级选择——形态与 MentionMenu
 * 同族（absolute 于 composer 上方、↑↓/Enter/Tab/Esc 键盘流、点击直达）。
 * 呈现层组件——状态机与数据源在 ConsoleView（解耦纪律 #1）。
 */
export interface SlashItem {
  /** 列表键（命令名 / agentId / sessionId） */
  key: string
  /** 主标签（命令名 / agent 名 / 会话标题——2026-10-18 改版） */
  label: string
  /** 右侧辅助（命令说明 / agentId / 时间·条数） */
  sub: string
  /** 身份色圆点（agent 级用；缺席不渲染） */
  color?: string
  /** 次行（session 级：sessionId 截短——UUID 前 8 位 / 旧 s-N 原样） */
  note?: string
}

defineProps<{ title: string; items: SlashItem[]; sel: number; loading?: boolean }>()
const emit = defineEmits<{ pick: [index: number] }>()
</script>

<template>
  <div class="slash-menu" role="listbox" :aria-label="title">
    <div class="sm-title">{{ title }}</div>
    <div v-if="loading" class="sm-empty">加载中…</div>
    <div v-else-if="items.length === 0" class="sm-empty">没有可选项</div>
    <button
      v-for="(it, i) in items"
      v-else
      :key="it.key"
      class="sm-item"
      :class="{ 'is-sel': i === sel }"
      type="button"
      role="option"
      :aria-selected="i === sel"
      @mousedown.prevent
      @click="emit('pick', i)"
    >
      <span v-if="it.color" class="stat-dot" :style="{ background: it.color }"></span>
      <span class="sm-main">
        <span class="sm-label">{{ it.label }}</span>
        <!-- 2026-10-18：session 级主标签改为标题（中文）不再 mono；id 截短进 note（mono） -->
        <span v-if="it.note !== undefined" class="sm-note mono">{{ it.note }}</span>
      </span>
      <span class="sm-sub">{{ it.sub }}</span>
    </button>
  </div>
</template>

<style scoped>
.slash-menu {
  position: absolute;
  /* v0.1.47：与 composer-box 同宽（挂 composer-box 内，left/right 0 对齐输入框两缘）；
   * 圆角同步 12px（输入框收小后一致）；阴影双段柔和（浅色不脏、深色可辨） */
  left: 0;
  right: 0;
  bottom: calc(100% + 6px);
  z-index: 40;
  padding: 4px;
  border: 1px solid var(--line-strong);
  border-radius: 12px;
  background: var(--bg2);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08), 0 12px 28px rgba(0, 0, 0, 0.14);
  overflow: hidden;
}

:root[data-theme='dark'] .slash-menu {
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35), 0 12px 28px rgba(0, 0, 0, 0.5);
}

.sm-title {
  font-size: 10.5px;
  color: var(--ink3);
  padding: 4px 10px 5px;
  border-bottom: 1px solid var(--line);
  margin-bottom: 3px;
}

.sm-empty {
  font-size: 12px;
  color: var(--ink3);
  padding: 12px 10px;
  text-align: center;
}

.sm-item {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  min-height: 32px;
  padding: 4px 10px;
  border: none;
  border-radius: 7px;
  background: none;
  color: var(--ink);
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.sm-item:hover,
.sm-item.is-sel {
  background: var(--bg3);
}

.stat-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex: none;
}

.sm-main {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.sm-label {
  font-size: 12.5px;
}

.sm-note {
  font-size: 11px;
  color: var(--ink3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 320px;
}

.sm-sub {
  margin-left: auto;
  font-size: 11px;
  color: var(--ink3);
  flex: none;
}
</style>
