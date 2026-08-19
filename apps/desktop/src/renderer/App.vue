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

const kernel = useKernelStore()
const ui = useUiStore()

// 模板全局白名单不含 window——窗口控制经方法转发（preload 桥可能缺失，全部可选链）
const minimize = (): void => window.openbot?.window.minimize()
const toggleMaximize = (): void => window.openbot?.window.toggleMaximize()
const hideToTray = (): void => window.openbot?.window.close()

const views: Array<{ id: ViewName; label: string; component: unknown }> = [
  { id: 'console', label: '控制台', component: ConsoleView },
  { id: 'boxes', label: 'Box', component: BoxesView },
  { id: 'tasks', label: '排程', component: TasksView },
  { id: 'graph', label: '图谱', component: GraphView },
  { id: 'settings', label: '设置', component: SettingsView },
]

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
          @click="ui.switchView(view.id)"
        >
          {{ view.label }}
          <span v-if="view.id === 'console' && kernel.pendingApprovals.length" class="badge">{{
            kernel.pendingApprovals.length
          }}</span>
        </button>
      </nav>
      <main class="main">
        <component :is="(views.find((v) => v.id === ui.currentView)?.component as never)" />
      </main>
    </div>
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
  --muted: rgba(234, 234, 234, 0.55);
  --accent: #eeb154;
  --accent-ink: #2a1e0c;
  --accent-weak: rgba(238, 177, 84, 0.11);
  --danger: #ea6a64;
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
  width: 168px;
  flex: none;
  padding: 10px 8px;
  background: var(--bg1);
  border-right: 1px solid var(--line);
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.nav-item {
  position: relative;
  padding: 8px 12px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--muted);
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}

.nav-item:hover {
  background: var(--bg2);
  color: var(--ink);
}

.nav-item.active {
  background: var(--accent-weak);
  color: var(--accent);
}

.badge {
  position: absolute;
  right: 8px;
  top: 50%;
  transform: translateY(-50%);
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: 8px;
  background: var(--danger);
  color: #fff;
  font-size: 11px;
  line-height: 16px;
  text-align: center;
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
