<script setup lang="ts">
/**
 * App 壳骨架（Step 7）：titlebar（frameless 三键）+ 侧栏五视图 + 主区容器。
 * 视觉基调对齐 prototype.html 设计变量（Step 8–9 逐视图迁移完整样式）。
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useKernelStore } from './stores/kernel'
import { useUiStore } from './stores/ui'
import { initThemeWatch } from './stores/ui'
import type { ViewName } from './stores/ui'
import ConsoleView from './views/ConsoleView.vue'
import BoxesView from './views/BoxesView.vue'
import TasksView from './views/TasksView.vue'
import GraphView from './views/GraphView.vue'
import SettingsView from './views/SettingsView.vue'
import ApprovalModal from './components/ApprovalModal.vue'
import BoxOps from './components/BoxOps.vue'
import ToastHost from './components/ToastHost.vue'
import CommandPalette from './components/CommandPalette.vue'
import AgentWizard from './components/AgentWizard.vue'

const kernel = useKernelStore()
const ui = useUiStore()

// 主题：setup 阶段先于首帧应用（无暗→亮闪烁）；系统跟随监听挂载时注册一次
ui.applyTheme()
onMounted(initThemeWatch)

// 模板全局白名单不含 window——窗口控制经方法转发（preload 桥可能缺失，全部可选链）
const minimize = (): void => window.openbot?.window.minimize()
const toggleMaximize = (): void => window.openbot?.window.toggleMaximize()
const hideToTray = (): void => window.openbot?.window.close()

// 最大化状态（三键图标随状态切换：最大化=方框 / 还原=叠放双框）
const maximized = ref(false)
let unsubscribeMaximize: (() => void) | null = null
onMounted(() => {
  void window.openbot?.window.isMaximized().then((v) => (maximized.value = v))
  unsubscribeMaximize = window.openbot?.window.onMaximizeChange((v) => (maximized.value = v)) ?? null
})
onUnmounted(() => unsubscribeMaximize?.())

// ---- 滚动条闲时隐藏（全局行为）：滚动中的容器加 .sb-active（CSS 门控显形），停滚 700ms 自动隐回 ----
// 捕获阶段监听 document——任意层级滚动容器一次覆盖（stream/ctx/box-term/操作台/各视图列表），无需逐容器接线
const sbHideTimers = new WeakMap<Element, number>()
const onAnyScroll = (e: Event): void => {
  const el = e.target
  if (!(el instanceof Element)) return // document 级滚动目标（本应用不出现，防御）
  el.classList.add('sb-active')
  const prev = sbHideTimers.get(el)
  if (prev !== undefined) window.clearTimeout(prev)
  sbHideTimers.set(el, window.setTimeout(() => el.classList.remove('sb-active'), 700))
}
onMounted(() => document.addEventListener('scroll', onAnyScroll, { capture: true, passive: true }))
onUnmounted(() => document.removeEventListener('scroll', onAnyScroll, { capture: true }))

const views: Array<{ id: ViewName; label: string; icon: string; component: unknown }> = [
  { id: 'console', label: '控制台', icon: 'chat', component: ConsoleView },
  { id: 'tasks', label: '排程', icon: 'lanes', component: TasksView },
  { id: 'boxes', label: 'Box', icon: 'box', component: BoxesView },
  { id: 'graph', label: '图谱', icon: 'graph', component: GraphView },
  { id: 'settings', label: '设置', icon: 'sliders', component: SettingsView },
]

// ---- P4 Step 1 壳层收尾：面包屑 / 双击最大化 / 状态栏（全部既有 store 投影，零内核改动） ----

/** 面包屑：当前视图名（原型 tb-crumb 语义） */
const currentViewLabel = computed(() => views.find((v) => v.id === ui.currentView)?.label ?? '')

// ---- 名册未读徽标（P4 Step 6）：呈现关注点——App 层 watch 消息流驱动 ui.unread，不进内核 ----
// messages 只增不减（append-only 呈现面）：按长度差取新增段，agent 回复且非当前会话 +1
watch(
  () => kernel.messages.length,
  (len, prev) => {
    for (let i = prev ?? 0; i < len; i++) {
      const m = kernel.messages[i]
      if (m && m.kind === 'agent' && m.from !== ui.activeAgentId) ui.bumpUnread(m.from)
    }
  },
)
// 进入会话即清零（跨视图派单/relay 点击/名册点击统一走 activeAgentId）；档案模式是会话局部态，切会话回屏幕
watch(
  () => ui.activeAgentId,
  (id) => {
    ui.clearUnread(id)
    ui.ctxSettings = false
  },
)

/** 双击标题栏最大化（Windows 惯例；交互子元素不触发——原型同款排除表） */
const onTitlebarDblclick = (e: MouseEvent): void => {
  if ((e.target as HTMLElement).closest('.theme-toggle, .win-controls, .boot-error, .omnibox')) return
  toggleMaximize()
}

/** Ctrl K 唤起命令面板（P4 Step 3）：操作台 PTY 聚焦时按键直送 Box 不抢键——
 *  activeElement 在 .boxops 内即跳过（原型「接管模式下按键全部送入 Box」同款边界） */
const onGlobalKeydown = (e: KeyboardEvent): void => {
  if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
    if (document.activeElement?.closest('.boxops') !== null) return
    e.preventDefault()
    ui.togglePalette()
  }
}
onMounted(() => document.addEventListener('keydown', onGlobalKeydown))
onUnmounted(() => document.removeEventListener('keydown', onGlobalKeydown))

const BACKEND_LABELS: Record<string, string> = {
  auto: '自动',
  mock: '模拟',
  wsl: 'WSL2',
  docker: 'Docker',
  podman: 'Podman',
}

/** 状态栏事实（真数据：连接/LLM/沙箱——缺席项如实隐藏或标注，不放假数字） */
const llmLabel = computed(() => {
  const p = kernel.providers.find((x) => x.name === kernel.defaultProvider)
  return p ? `${p.name} · ${p.model}` : '未配置'
})
const sandboxLabel = computed(() =>
  kernel.sandbox ? (BACKEND_LABELS[kernel.sandbox.backendId] ?? kernel.sandbox.backendId) : null,
)

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
    <header class="titlebar" @dblclick="onTitlebarDblclick">
      <div class="brand">OpenBot</div>
      <span class="tb-crumb">{{ currentViewLabel }}</span>
      <div v-if="kernel.bootError" class="boot-error" :title="kernel.bootError">内核未连接</div>
      <!-- omnibox：命令面板入口（Ctrl K 同快捷键） -->
      <button class="omnibox" type="button" title="命令面板（Ctrl K）" @click="ui.openPalette()">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="6" /><path d="M20 20l-4.2-4.2" /></svg>
        <span class="omnibox-text">搜索 agent、任务、Box、命令</span>
        <kbd>Ctrl K</kbd>
      </button>
      <div class="titlebar-right">
        <!-- 主题快捷切换：实效夜间显示太阳（点击转日间），日间显示月亮（auto 下点击即转显式偏好） -->
        <button
          class="theme-toggle"
          :title="`切换主题（当前：${ui.theme === 'auto' ? `跟随系统 · ${ui.effectiveTheme === 'dark' ? '夜间' : '日间'}` : ui.effectiveTheme === 'dark' ? '夜间' : '日间'}）`"
          :aria-label="`切换到${ui.effectiveTheme === 'dark' ? '日间' : '夜间'}模式`"
          @click="ui.toggleTheme()"
        >
          <svg v-if="ui.effectiveTheme === 'dark'" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M5.2 5.2l1.8 1.8M17 17l1.8 1.8M18.8 5.2L17 7M7 17l-1.8 1.8"/></svg>
          <svg v-else width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" aria-hidden="true"><path d="M20 13.6A8 8 0 1 1 10.4 4a6.4 6.4 0 0 0 9.6 9.6z"/></svg>
        </button>
        <div class="win-controls">
        <!-- 三键图标与侧栏 ICONS 同语言（线性 stroke）；最小化线略下沉是 Windows 惯例 -->
        <button class="win-btn" title="最小化" aria-label="最小化" @click="minimize">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M6 16.5h12"/></svg>
        </button>
        <button class="win-btn" :title="maximized ? '还原' : '最大化'" :aria-label="maximized ? '还原' : '最大化'" @click="toggleMaximize">
          <!-- 最大化=单方框；还原=错位叠放双框（Windows 惯例形） -->
          <svg v-if="!maximized" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true"><rect x="5.5" y="5.5" width="13" height="13" rx="1.5"/></svg>
          <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true">
            <!-- 还原：右上完整框（前景）+ 左下背景框只画可见 L 形轮廓——止于前景框边缘，不交叉穿框 -->
            <rect x="8.5" y="4.5" width="11" height="11" rx="1.5"/>
            <path d="M8.5 8.5H6Q4.5 8.5 4.5 10V18Q4.5 19.5 6 19.5H14Q15.5 19.5 15.5 18V15.5"/>
          </svg>
        </button>
        <button class="win-btn close" title="驻留托盘" aria-label="驻留托盘" @click="hideToTray">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></svg>
        </button>
        </div>
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
          <!-- 宿主磁盘压力角标（Step 6）：warn/critical 档常驻提醒；critical 加脉冲 -->
          <span
            v-if="view.id === 'boxes' && kernel.pressure"
            class="badge badge-danger"
            :class="{ pulse: kernel.pressure.level === 'critical' }"
            :title="kernel.pressure.level === 'critical' ? '磁盘空间严重不足' : '磁盘空间偏低'"
          >!</span>
        </button>
        <!-- 你（本机主人）：所有对话的起点（原型 rail-user） -->
        <div class="rail-user" title="你（本机主人）">你</div>
      </nav>
      <main class="main">
        <component :is="(views.find((v) => v.id === ui.currentView)?.component as never)" />
      </main>
    </div>

    <!-- 状态栏（P4 Step 1）：全部真数据投影——连接/seq、当前 LLM、沙箱后端与 Box 数；
         「本地执行 · 0 云依赖」是定位叙事行（云依赖只剩 LLM API 是架构原文） -->
    <footer class="statusbar">
      <span class="sb-item">
        <span class="sb-dot" :class="kernel.connected ? 'ok' : 'danger'"></span>
        {{ kernel.connected ? `内核已连接 · seq ${kernel.lastSeq}` : '内核未连接' }}
      </span>
      <span class="sb-item">LLM {{ llmLabel }}</span>
      <span v-if="sandboxLabel" class="sb-item">沙箱 {{ sandboxLabel }} · {{ kernel.boxes.length }} Box</span>
      <span class="sb-sep"></span>
      <span class="sb-claim">本地执行 · 0 云依赖</span>
      <span class="sb-item">托盘常驻</span>
    </footer>

    <!-- 审批弹窗（全局层：挂起审批的注意力捕获；流内 gate 卡保留对话流上下文） -->
    <ApprovalModal />

    <!-- Box 操作台（VMware 控制台式大屏覆盖层；ctx 屏幕与 Box 卡片均可打开） -->
    <BoxOps />

    <!-- Toast 轻提示（P4 Step 2）：右下角全局动作反馈层 -->
    <ToastHost />

    <!-- 命令面板（P4 Step 3）：Ctrl K / omnibox 唤起 -->
    <CommandPalette />

    <!-- 新建 agent 向导（P4 Step 5）：名册入口与命令面板动作共用 -->
    <AgentWizard />
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
  --accent-strong: #f5c071; /* hover 提亮 */
  --accent-ink: #2a1e0c;
  --accent-rgb: 238, 177, 84;
  --accent-weak: rgba(var(--accent-rgb), 0.11);
  --warning: #e3ce5c;
  --warning-rgb: 227, 206, 92;
  --warning-weak: rgba(227, 206, 92, 0.1);
  --danger: #ea6a64;
  --danger-strong: #ef8b86; /* hover 提亮 */
  --danger-rgb: 234, 106, 100;
  --danger-weak: rgba(var(--danger-rgb), 0.1);
  --success: #73ce95;
  --success-rgb: 115, 206, 149;
  --mono: 'Cascadia Code', Consolas, ui-monospace, monospace;
  --ease: cubic-bezier(0.25, 1, 0.5, 1);
  --radius: 10px;
}

/* 日间主题（夜间为默认态；data-theme 由 ui store 依偏好/系统解析挂到 <html>）。
   同色相、白底对比度加深（正文 ≥4.5:1 目标）；weak 族由 rgb 变量派生自动适配 */
:root[data-theme='light'] {
  --bg0: #f4f2ed;
  --bg1: #fbfaf7;
  --bg2: #efece5;
  --bg3: #e4e0d6;
  --line: rgba(28, 25, 18, 0.1);
  --line-strong: rgba(28, 25, 18, 0.18);
  --ink: #26231c;
  --ink2: #5d584c;
  --ink3: #8f897a;
  --muted: rgba(38, 35, 28, 0.55);
  --accent: #9a6d1a;
  --accent-strong: #7e5a16;
  --accent-ink: #fff8ec;
  --accent-rgb: 154, 109, 26;
  --warning: #8a7a1c;
  --warning-rgb: 138, 122, 28;
  --danger: #c2453f;
  --danger-strong: #a93a34;
  --danger-rgb: 194, 69, 63;
  --success: #2f7d4f;
  --success-rgb: 47, 125, 79;
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

/* 全局滚动条（prototype 92-94 行同源）：深色界面统一——原生白底灰条在深色 UI 中割裂。
   闲时隐藏（thumb 全透明）：滚动中（.sb-active——App 全局 scroll 监听加类）或鼠标悬停滚动区时显形；
   10px 占位保留不 overlay——显隐切换不引起内容宽度抖动 */
::-webkit-scrollbar {
  width: 10px;
  height: 10px;
}

::-webkit-scrollbar-thumb {
  background: transparent;
  border-radius: 5px;
  border: 2px solid transparent;
}

/* 显形（滚动中 / 悬停）：滑块配色沿用深色方案 */
.sb-active::-webkit-scrollbar-thumb,
*:hover::-webkit-scrollbar-thumb {
  background: var(--bg3);
  border-color: var(--bg1); /* 与容器底同色的边框=滑块四周留隙的悬浮感 */
}

::-webkit-scrollbar-track {
  background: transparent;
}

::-webkit-scrollbar-corner {
  background: transparent; /* 横纵交汇角（bo-screen 横向滚动场景） */
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
  background: rgba(var(--danger-rgb), 0.15);
  color: var(--danger);
  font-size: 12px;
}

/* 面包屑（原型 tb-crumb：/ 视图名） */
.tb-crumb {
  margin-left: 4px;
  font-size: 12px;
  color: var(--ink3);
}

.tb-crumb::before {
  content: '/';
  margin-right: 10px;
  color: var(--line-strong);
}

/* omnibox（原型同款：标题栏搜索入口 → 命令面板） */
.omnibox {
  flex: 0 1 400px;
  min-width: 0;
  height: 26px;
  margin-left: auto;
  margin-right: auto;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 10px;
  border: 1px solid var(--line);
  border-radius: 7px;
  background: var(--bg3);
  color: var(--ink3);
  font-size: 12px;
  cursor: text;
  -webkit-app-region: no-drag;
  transition: border-color 160ms var(--ease);
}

.omnibox:hover {
  border-color: var(--line-strong);
}

.omnibox-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: left;
}

.omnibox kbd {
  font-family: var(--mono);
  font-size: 10px;
  border: 1px solid var(--line-strong);
  border-radius: 4px;
  padding: 0 5px;
  color: var(--ink3);
}

.titlebar-right {
  display: flex;
  align-items: center;
  height: 100%;
  -webkit-app-region: no-drag;
}

.theme-toggle {
  width: 34px;
  height: 28px;
  margin-right: 8px;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: var(--ink3);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}

.theme-toggle:hover {
  background: var(--bg3);
  color: var(--ink);
}

.win-controls {
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
  display: flex;
  align-items: center;
  justify-content: center;
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

/* 磁盘压力角标（danger 族；critical 脉冲提醒） */
.badge.badge-danger {
  background: var(--danger);
  color: #fff;
}

.badge.badge-danger.pulse {
  animation: badge-pulse 1.2s ease-in-out infinite;
}

@keyframes badge-pulse {
  50% {
    opacity: 0.4;
  }
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

/* 你（本机主人）头像：钉在侧栏底部 */
.rail-user {
  width: 30px;
  height: 30px;
  margin-top: auto;
  border-radius: 50%;
  background: var(--bg3);
  border: 1px solid var(--line-strong);
  display: grid;
  place-items: center;
  font-size: 11px;
  color: var(--ink2);
}

/* ---- 状态栏（原型 statusbar 语义、真数据投影） ---- */
.statusbar {
  flex: none;
  height: 28px;
  display: flex;
  align-items: center;
  gap: 18px;
  padding: 0 14px;
  background: var(--bg0);
  border-top: 1px solid var(--line);
  font-size: 11px;
  color: var(--ink3);
  user-select: none;
}

.statusbar .sb-item {
  display: flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
}

.statusbar .sb-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--ink3);
}

.statusbar .sb-dot.ok {
  background: var(--success);
}

.statusbar .sb-dot.danger {
  background: var(--danger);
}

.statusbar .sb-sep {
  flex: 1;
}

.statusbar .sb-claim {
  color: var(--accent);
}

/* 无障碍：系统偏好减动效时全局降级（动画与过渡全关——打字机光标/脉冲/渐入等） */
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation: none !important;
    transition: none !important;
  }
}
</style>
