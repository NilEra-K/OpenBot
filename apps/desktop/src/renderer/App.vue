<script setup lang="ts">
/**
 * App 壳骨架（Step 7）：titlebar（frameless 三键）+ 侧栏五视图 + 主区容器。
 * 视觉基调对齐 prototype.html 设计变量（Step 8–9 逐视图迁移完整样式）。
 */
import { onMounted, onUnmounted } from 'vue'
import { useKernelStore } from './stores/kernel'
import { useUiStore } from './stores/ui'
import type { ViewName } from './stores/ui'
import ConsoleView from './views/ConsoleView.vue'
import BoxesView from './views/BoxesView.vue'
import TasksView from './views/TasksView.vue'
import GraphView from './views/GraphView.vue'
import SettingsView from './views/SettingsView.vue'
import ApprovalModal from './components/ApprovalModal.vue'

const kernel = useKernelStore()
const ui = useUiStore()

// 模板全局白名单不含 window——窗口控制经方法转发（preload 桥可能缺失，全部可选链）
const minimize = (): void => window.openbot?.window.minimize()
const toggleMaximize = (): void => window.openbot?.window.toggleMaximize()
const hideToTray = (): void => window.openbot?.window.close()

const views: Array<{ id: ViewName; label: string; icon: string; component: unknown }> = [
  { id: 'console', label: '控制台', icon: 'chat', component: ConsoleView },
  { id: 'tasks', label: '排程', icon: 'lanes', component: TasksView },
  { id: 'boxes', label: 'Box', icon: 'box', component: BoxesView },
  { id: 'graph', label: '图谱', icon: 'graph', component: GraphView },
  { id: 'settings', label: '设置', icon: 'sliders', component: SettingsView },
]

/** 图标 path(prototype.html ICONS 同源;viewBox 0 0 24 24 线性图标) */
const ICONS: Record<string, string> = {
  chat: '<path d="M4 5h16a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H10l-5 4v-4H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z"/>',
  lanes:
    '<path d="M8 6h12M8 12h12M8 18h12"/><circle cx="4" cy="6" r="1.3" fill="currentColor" stroke="none"/><circle cx="4" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="4" cy="18" r="1.3" fill="currentColor" stroke="none"/>',
  box: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z"/><path d="M12 12l8-4.5M12 12L4 7.5M12 12v9"/>',
  graph:
    '<circle cx="6" cy="7" r="2.4"/><circle cx="18" cy="6" r="2.4"/><circle cx="17" cy="17" r="2.4"/><circle cx="7" cy="18" r="2.4"/><path d="M8.3 7.8l7.3-1.2M8.2 9.1l7.2 6.3M8.9 17.2l-.5-7M16.7 15.1l-.7-6.7"/>',
  sliders:
    '<path d="M4 8h9M17 8h3M4 16h3M11 16h9"/><circle cx="15" cy="8" r="2.2"/><circle cx="9" cy="16" r="2.2"/>',
}

onMounted(() => void kernel.boot())
onUnmounted(() => kernel.shutdown())
</script>

<template>
  <div class="app" :data-connected="kernel.connected">
    <!-- 自绘标题栏（frameless；窗口控制经 preload 桥） -->
    <header class="titlebar">
      <div class="brand">OpenBot</div>
      <div v-if="kernel.bootError" class="boot-error" :title="kernel.bootError">内核未连接</div>
      <div class="win-controls">
        <button class="win-btn" title="最小化" @click="minimize">─</button>
        <button class="win-btn" title="最大化/还原" @click="toggleMaximize">□</button>
        <button class="win-btn close" title="驻留托盘" @click="hideToTray">✕</button>
      </div>
    </header>

    <div class="body">
      <nav class="sidebar">
        <button
          v-for="view in views"
          :key="view.id"
          class="nav-item"
          :class="{ active: ui.currentView === view.id }"
          :title="view.label"
          :aria-label="view.label"
          @click="ui.switchView(view.id)"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" v-html="ICONS[view.icon]"></svg>
          <span v-if="view.id === 'console' && kernel.pendingApprovals.length" class="badge">{{
            kernel.pendingApprovals.length
          }}</span>
        </button>
      </nav>
      <main class="main">
        <component :is="(views.find((v) => v.id === ui.currentView)?.component as never)" />
      </main>
    </div>

    <!-- 审批弹窗（全局层：挂起审批的注意力捕获；流内 gate 卡保留对话流上下文） -->
    <ApprovalModal />
  </div>
</template>

<style>
/* 设计变量（对齐 prototype.html；Step 8–9 迁移时保持同一套） */
:root {
  --bg0: #0c0c0c;
  --bg1: #131313;
  --bg2: #1a1a1a;
  --bg3: #222222;
  --line: rgba(255, 255, 255, 0.08);
  --line-strong: rgba(255, 255, 255, 0.15);
  --ink: #eaeaea;
  --ink2: #a6a6a6;
  --ink3: #747474;
  --muted: rgba(234, 234, 234, 0.55);
  --accent: #eeb154;
  --accent-ink: #2a1e0c;
  --accent-rgb: 238, 177, 84;
  --accent-weak: rgba(var(--accent-rgb), 0.11);
  --warning: #e3ce5c;
  --warning-rgb: 227, 206, 92;
  --warning-weak: rgba(227, 206, 92, 0.1);
  --danger: #ea6a64;
  --danger-rgb: 234, 106, 100;
  --danger-weak: rgba(var(--danger-rgb), 0.1);
  --success: #73ce95;
  --mono: 'Cascadia Code', Consolas, ui-monospace, monospace;
  --ease: cubic-bezier(0.25, 1, 0.5, 1);
  --radius: 10px;
}

* {
  box-sizing: border-box;
  margin: 0;
}

html,
body {
  height: 100%;
  min-width: 1080px; /* 与窗口最小宽对齐（docs/platforms.md 地雷） */
  background: var(--bg0);
  color: var(--ink);
  font-family: 'Segoe UI', 'Microsoft YaHei', system-ui, sans-serif;
  font-size: 14px;
}

#app {
  height: 100%;
}

.app {
  display: flex;
  flex-direction: column;
  height: 100vh;
}

.titlebar {
  display: flex;
  align-items: center;
  height: 38px;
  padding-left: 14px;
  background: var(--bg1);
  border-bottom: 1px solid var(--line);
  -webkit-app-region: drag;
  user-select: none;
  flex: none;
}

.brand {
  font-weight: 600;
  letter-spacing: 0.4px;
  color: var(--accent);
}

.boot-error {
  margin-left: 12px;
  padding: 1px 8px;
  border-radius: 4px;
  background: rgba(234, 106, 100, 0.15);
  color: var(--danger);
  font-size: 12px;
}

.win-controls {
  margin-left: auto;
  display: flex;
  height: 100%;
  -webkit-app-region: no-drag;
}

.win-btn {
  width: 44px;
  height: 100%;
  border: none;
  background: transparent;
  color: var(--muted);
  font-size: 12px;
  cursor: pointer;
}

.win-btn:hover {
  background: var(--bg3);
  color: var(--ink);
}

.win-btn.close:hover {
  background: var(--danger);
  color: #fff;
}

.body {
  display: flex;
  flex: 1;
  min-height: 0;
}

.sidebar {
  width: 56px;
  flex: none;
  padding: 10px 0;
  background: var(--bg0);
  border-right: 1px solid var(--line);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
}

.nav-item {
  position: relative;
  width: 40px;
  height: 40px;
  border: none;
  border-radius: 9px;
  display: grid;
  place-items: center;
  background: transparent;
  color: var(--ink3);
  cursor: pointer;
}

.nav-item:hover {
  background: var(--bg2);
  color: var(--ink2);
}

.nav-item.active {
  background: var(--accent-weak);
  color: var(--accent);
}

.badge {
  position: absolute;
  top: 7px;
  right: 7px;
  min-width: 14px;
  height: 14px;
  padding: 0 3px;
  border-radius: 7px;
  background: var(--accent);
  color: var(--accent-ink);
  font-size: 9px;
  font-weight: 700;
  display: grid;
  place-items: center;
  line-height: 1;
}

.main {
  flex: 1;
  min-width: 0;
  overflow: auto;
  background: var(--bg0);
}

.view {
  padding: 18px;
}

.view-title {
  font-size: 15px;
  font-weight: 600;
  margin-bottom: 14px;
}

.placeholder {
  color: var(--muted);
  padding: 40px;
  text-align: center;
}
</style>
