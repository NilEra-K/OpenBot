<script setup lang="ts">
/**
 * 命令面板（P4 Step 3，原型 pal-* 迁移）：Ctrl K / 标题栏 omnibox 唤起的统一入口——
 * 快速派单（跳会话+聚焦输入）/ 跳转 agent / 接管 Box / 视图导航 / 动作（主题切换；
 * 「新建 agent」随 Step 5 向导落地接入——不放假项）。
 * 纯 renderer 消费既有 store，零内核改动；过滤 = 空白分词全部命中（label/kw/sub）。
 * 抢键边界（plan-p4 设计要点）：操作台 PTY 聚焦时 Ctrl K 直送 Box 不弹面板——
 * 判定在 App 全局监听（activeElement 在 .boxops 内即跳过），本组件不感知。
 */
import { computed, nextTick, ref, watch } from 'vue'
import { useKernelStore } from '../stores/kernel'
import { useUiStore } from '../stores/ui'
import type { ViewName } from '../stores/ui'

const kernel = useKernelStore()
const ui = useUiStore()

interface PalCommand {
  group: string
  icon: keyof typeof ICONS
  label: string
  sub?: string
  /** 检索关键词（label 之外的命中面） */
  kw: string
  run: () => void
}

/** 图标 path（prototype ICONS 与 App 侧栏同源；viewBox 0 0 24 24 线性） */
const ICONS = {
  send: '<path d="M21 3L10 14M21 3l-7 18-3.2-7.8L3 10z"/>',
  chat: '<path d="M4 5h16a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H10l-5 4v-4H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z"/>',
  box: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z"/><path d="M12 12l8-4.5M12 12L4 7.5M12 12v9"/>',
  lanes:
    '<path d="M8 6h12M8 12h12M8 18h12"/><circle cx="4" cy="6" r="1.3" fill="currentColor" stroke="none"/><circle cx="4" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="4" cy="18" r="1.3" fill="currentColor" stroke="none"/>',
  graph:
    '<circle cx="6" cy="7" r="2.4"/><circle cx="18" cy="6" r="2.4"/><circle cx="17" cy="17" r="2.4"/><circle cx="7" cy="18" r="2.4"/><path d="M8.3 7.8l7.3-1.2M8.2 9.1l7.2 6.3M8.9 17.2l-.5-7M16.7 15.1l-.7-6.7"/>',
  sliders:
    '<path d="M4 8h9M17 8h3M4 16h3M11 16h9"/><circle cx="15" cy="8" r="2.2"/><circle cx="9" cy="16" r="2.2"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M5.2 5.2l1.8 1.8M17 17l1.8 1.8M18.8 5.2L17 7M7 17l-1.8 1.8"/>',
  moon: '<path d="M20 13.6A8 8 0 1 1 10.4 4a6.4 6.4 0 0 0 9.6 9.6z"/>',
} as const

const NAVS: Array<{ view: ViewName; label: string; icon: keyof typeof ICONS }> = [
  { view: 'console', label: '控制台', icon: 'chat' },
  { view: 'tasks', label: '排程', icon: 'lanes' },
  { view: 'boxes', label: 'Box', icon: 'box' },
  { view: 'graph', label: '图谱', icon: 'graph' },
  { view: 'settings', label: '设置', icon: 'sliders' },
]

/** 命令目录（事实驱动：roster/boxes 空时对应组自然消失） */
const commands = computed<PalCommand[]>(() => {
  const cmds: PalCommand[] = []
  for (const a of kernel.roster) {
    const name = a.name ?? a.agentId
    const sub = a.role === 'steward' ? '管家 · 默认对话者' : 'worker'
    cmds.push({
      group: '快速派单',
      icon: 'send',
      label: `派单给 ${name}`,
      sub,
      kw: `派单 dispatch ${a.agentId}`,
      run: () => {
        ui.activeAgentId = a.agentId
        ui.switchView('console')
        ui.focusComposer()
      },
    })
  }
  for (const a of kernel.roster) {
    const name = a.name ?? a.agentId
    cmds.push({
      group: '跳转 agent',
      icon: 'chat',
      label: `打开会话：${name}`,
      sub: a.role === 'steward' ? '管家' : 'worker',
      kw: `跳转 jump 会话 ${a.agentId}`,
      run: () => {
        ui.activeAgentId = a.agentId
        ui.switchView('console')
      },
    })
  }
  for (const b of kernel.boxes) {
    cmds.push({
      group: '接管 Box',
      icon: 'box',
      label: `接管 ${b.boxId}`,
      sub: `image=${b.image}`,
      kw: 'box 接管 sandbox 终端',
      run: () => ui.openBoxOps(b.boxId),
    })
  }
  for (const n of NAVS) {
    cmds.push({
      group: '导航',
      icon: n.icon,
      label: `前往 ${n.label}`,
      kw: `前往 goto 视图 ${n.label}`,
      run: () => ui.switchView(n.view),
    })
  }
  cmds.push({
    group: '动作',
    icon: ui.effectiveTheme === 'dark' ? 'sun' : 'moon',
    label: '切换日间 / 夜间',
    kw: '主题 theme 日间 夜间 外观',
    run: () => ui.toggleTheme(),
  })
  return cmds
})

// ---- 过滤与选择 ----

const query = ref('')
const sel = ref(0)
const inputEl = ref<HTMLInputElement | null>(null)
const listEl = ref<HTMLElement | null>(null)

const filtered = computed<PalCommand[]>(() => {
  const toks = query.value.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const all = commands.value
  if (toks.length === 0) return all
  return all.filter((c) => {
    const hay = `${c.label} ${c.kw} ${c.sub ?? ''}`.toLowerCase()
    return toks.every((t) => hay.includes(t))
  })
})

/** 分组头只在该组首条渲染（列表按 group 连续排列） */
const isGroupHead = (i: number): boolean => filtered.value[i - 1]?.group !== filtered.value[i]?.group

/** 打开时重置并聚焦输入（每次唤起都是干净会话） */
watch(
  () => ui.paletteOpen,
  (open) => {
    if (open) {
      query.value = ''
      sel.value = 0
      void nextTick(() => inputEl.value?.focus())
    }
  },
)
watch(filtered, () => {
  sel.value = 0
})

const run = (i: number): void => {
  const cmd = filtered.value[i]
  if (!cmd) return
  ui.closePalette()
  cmd.run()
}

const hi = (): void => {
  listEl.value?.querySelector<HTMLElement>('.pal-item.is-sel')?.scrollIntoView({ block: 'nearest' })
}

const onKeydown = (e: KeyboardEvent): void => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault()
    if (filtered.value.length === 0) return
    sel.value = (sel.value + (e.key === 'ArrowDown' ? 1 : -1) + filtered.value.length) % filtered.value.length
    void nextTick(hi)
  } else if (e.key === 'Enter') {
    e.preventDefault()
    run(sel.value)
  } else if (e.key === 'Escape') {
    e.stopPropagation() // 不惊动其他 Esc 语义（图谱聚焦退出等）
    ui.closePalette()
  }
}
</script>

<template>
  <div v-if="ui.paletteOpen" class="pal-overlay" @mousedown.self="ui.closePalette()">
    <div class="pal-card" role="dialog" aria-label="命令面板">
      <div class="pal-row">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="6" /><path d="M20 20l-4.2-4.2" /></svg>
        <input
          ref="inputEl"
          v-model="query"
          class="pal-input"
          placeholder="派单、跳转 agent、接管 Box、执行动作…"
          autocomplete="off"
          @keydown="onKeydown"
        />
        <span class="kbd-chip">Esc</span>
      </div>
      <div ref="listEl" class="pal-list">
        <template v-for="(c, i) in filtered" :key="`${c.group}:${c.label}`">
          <div v-if="isGroupHead(i)" class="pal-group">{{ c.group }}</div>
          <button class="pal-item" :class="{ 'is-sel': i === sel }" type="button" @mousemove="sel = i" @click="run(i)">
            <span class="pi-ic" v-html="ICONS[c.icon]"></span>
            <span class="pi-label">{{ c.label }}</span>
            <span v-if="c.sub" class="pi-sub">{{ c.sub }}</span>
          </button>
        </template>
        <div v-if="filtered.length === 0" class="pal-empty">没有匹配的命令</div>
      </div>
      <div class="pal-foot">
        <span>↑↓ 选择</span><span>Enter 执行</span><span>Esc 关闭</span>
        <span class="right">Ctrl K 随时唤起</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 模态层：与审批 scrim 同界（不越标题栏与状态栏；z 高于操作台） */
.pal-overlay {
  position: fixed;
  top: 38px;
  bottom: 28px;
  left: 0;
  right: 0;
  z-index: 100;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 11vh 16px 16px;
  background: var(--scrim, rgba(8, 8, 8, 0.55));
}

.pal-card {
  width: 600px;
  max-width: 100%;
  max-height: 100%;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--line-strong);
  border-radius: 12px;
  background: var(--bg2);
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.4);
  overflow: hidden;
}

.pal-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--line);
  color: var(--ink3);
}

.pal-input {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: none;
  color: var(--ink);
  font-size: 13.5px;
}

.kbd-chip {
  font-family: var(--mono);
  font-size: 10px;
  border: 1px solid var(--line-strong);
  border-radius: 4px;
  padding: 1px 5px;
  color: var(--ink3);
  white-space: nowrap;
}

.pal-list {
  max-height: 336px;
  overflow-y: auto;
  padding: 5px;
}

.pal-group {
  font-size: 10.5px;
  color: var(--ink3);
  letter-spacing: 0.06em;
  padding: 9px 10px 4px;
}

.pal-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 6px 10px;
  border: none;
  border-radius: 8px;
  background: none;
  color: var(--ink);
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.pal-item.is-sel {
  background: var(--bg3);
}

.pi-ic {
  width: 20px;
  display: grid;
  place-items: center;
  flex: none;
  color: var(--ink3);
}

.pal-item.is-sel .pi-ic {
  color: var(--accent);
}

.pi-label {
  font-size: 12.5px;
}

.pi-sub {
  margin-left: auto;
  font-size: 11px;
  color: var(--ink3);
  max-width: 40%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pal-empty {
  padding: 24px 0;
  text-align: center;
  font-size: 12px;
  color: var(--ink3);
}

.pal-foot {
  display: flex;
  gap: 14px;
  padding: 9px 14px;
  border-top: 1px solid var(--line);
  font-size: 11px;
  color: var(--ink3);
}

.pal-foot .right {
  margin-left: auto;
}
</style>
