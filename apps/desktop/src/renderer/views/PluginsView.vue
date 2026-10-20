<script setup lang="ts">
/**
 * 插件视图（2026-10-19 一期：UI 壳 + 安装态管理）：
 * - 顶部双 Tab（分段控件）：插件市场 / 我的插件；
 * - 应用商店式卡片网格（自适应铺满）：**icon 左置同行头部**（2026-10-19 优化 A）+ 身份色
 *   （优化 B：id 哈希派生稳定色——agentColor 同款惯例，市场一眼可辨）+ 描述两行；
 * - 市场卡「安装」（已装置灰「已安装」）；我的插件卡：状态 chip + 禁用/启用 + 卸载（行内二次确认）；
 * - 空态统一语言（优化 C：拼图 icon + 文案；我的插件空态带「去市场安装」直切）。
 * 运行时（插件真正执行能力）后续接入——本期只管理安装态（如实：示例条目明确标注「示例」）。
 */
import { ref } from 'vue'
import { useKernelStore } from '../stores/kernel'
import { useToastStore } from '../stores/toast'
import { agentColor } from '../lib/agent-color'

const kernel = useKernelStore()
const toast = useToastStore()

const tab = ref<'market' | 'mine'>('market')

/** 布局偏好（2026-10-19 用户需求：宫格/列表切换）：呈现层偏好走 localStorage（不进内核——
 *  与外观主题同款先例）；坏值回落宫格 */
const LAYOUT_KEY = 'openbot.plugins.layout'
type PluginLayout = 'grid' | 'list'
const layout = ref<PluginLayout>(
  localStorage.getItem(LAYOUT_KEY) === 'list' ? 'list' : 'grid',
)
const setLayout = (next: PluginLayout): void => {
  layout.value = next
  localStorage.setItem(LAYOUT_KEY, next)
}

/** 卸载行内二次确认（可重装属低破坏——不上重弹窗）：待确认的插件 id */
const confirmingId = ref<string | null>(null)

/** 插件身份色（优化 B）：id 哈希派生稳定色——与 agent 身份色同源惯例 */
const colorOf = (id: string): string => agentColor(id)

const install = async (plugin: { id: string; name: string; description: string; version: string }): Promise<void> => {
  try {
    await kernel.installPlugin(plugin)
    toast.push(`「${plugin.name}」已安装`, 'success')
  } catch (err) {
    toast.push(err instanceof Error ? err.message : String(err), 'error')
  }
}

const toggle = async (plugin: { id: string; name: string; enabled: boolean }): Promise<void> => {
  try {
    await kernel.setPluginEnabled(plugin.id, !plugin.enabled)
  } catch (err) {
    toast.push(err instanceof Error ? err.message : String(err), 'error')
  }
}

const uninstall = async (plugin: { id: string; name: string }): Promise<void> => {
  if (confirmingId.value !== plugin.id) {
    confirmingId.value = plugin.id
    return
  }
  confirmingId.value = null
  try {
    await kernel.uninstallPlugin(plugin.id)
    toast.push(`「${plugin.name}」已卸载`, 'success')
  } catch (err) {
    toast.push(err instanceof Error ? err.message : String(err), 'error')
  }
}

/** 卡片图标块的首字（名称截首） */
const initialOf = (name: string): string => name.replace('示例 · ', '').trim().charAt(0) || '插'
</script>

<template>
  <section class="view view-scroll plugins-view">
    <div class="view-head plugins-head">
      <div>
        <div class="view-title">插件</div>
        <div class="view-sub">为 OpenBot 扩展能力——市场安装，我的插件管理启停</div>
      </div>
      <div class="plugins-ctl">
        <!-- 布局切换（2026-10-19）：宫格/列表——Tab 左侧；偏好 localStorage 记忆 -->
        <div class="plugins-layout" role="radiogroup" aria-label="布局">
          <button type="button" role="radio" :aria-checked="layout === 'grid'" :class="{ 'is-sel': layout === 'grid' }" title="宫格布局" @click="setLayout('grid')">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/></svg>
          </button>
          <button type="button" role="radio" :aria-checked="layout === 'list'" :class="{ 'is-sel': layout === 'list' }" title="列表布局" @click="setLayout('list')">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16"/></svg>
          </button>
        </div>
        <div class="plugins-tabs" role="tablist" aria-label="插件视图">
          <button type="button" role="tab" :aria-selected="tab === 'market'" :class="{ 'is-sel': tab === 'market' }" @click="tab = 'market'">插件市场</button>
          <button type="button" role="tab" :aria-selected="tab === 'mine'" :class="{ 'is-sel': tab === 'mine' }" @click="tab = 'mine'">我的插件</button>
        </div>
      </div>
    </div>

    <div class="plugins-grid" :class="layout === 'list' ? 'is-list' : 'is-grid'" role="list">
      <!-- 市场：全部可装卡（已装置灰）；空态如实 -->
      <template v-if="tab === 'market'">
        <div v-if="kernel.pluginMarket.length === 0" class="plugins-empty">
          <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 3.5a1.8 1.8 0 1 1 3.6 0V5h2.9a1.5 1.5 0 0 1 1.5 1.5v3h1.5a1.8 1.8 0 1 1 0 3.6h-1.5v3a1.5 1.5 0 0 1-1.5 1.5h-2.9v1.6a1.8 1.8 0 1 1-3.6 0v-1.6h-3A1.5 1.5 0 0 1 4.2 16v-3H2.8a1.8 1.8 0 1 1 0-3.6h1.4v-3A1.5 1.5 0 0 1 5.7 5h3V3.5z"/></svg>
          <div>暂无可用插件</div>
        </div>
        <div v-for="p in kernel.pluginMarket" :key="p.id" class="plugin-card" role="listitem" :data-layout="layout">
          <div class="pc-top">
            <div class="pc-icon" :style="{ background: colorOf(p.id) }" aria-hidden="true">{{ initialOf(p.name) }}</div>
            <div class="pc-main">
              <div class="pc-name">{{ p.name }}</div>
              <div class="pc-desc">{{ p.description }}</div>
            </div>
          </div>
          <div class="pc-foot">
            <span class="pc-version mono">v{{ p.version }}</span>
            <button
              v-if="kernel.installedPlugins.some((i) => i.id === p.id)"
              type="button"
              class="pc-btn"
              disabled
            >已安装</button>
            <button v-else type="button" class="pc-btn pc-btn-primary" @click="install(p)">安装</button>
          </div>
        </div>
      </template>

      <!-- 我的插件：已装卡（启停 + 卸载）；空态带引导直切市场 -->
      <template v-else>
        <div v-if="kernel.installedPlugins.length === 0" class="plugins-empty">
          <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 3.5a1.8 1.8 0 1 1 3.6 0V5h2.9a1.5 1.5 0 0 1 1.5 1.5v3h1.5a1.8 1.8 0 1 1 0 3.6h-1.5v3a1.5 1.5 0 0 1-1.5 1.5h-2.9v1.6a1.8 1.8 0 1 1-3.6 0v-1.6h-3A1.5 1.5 0 0 1 4.2 16v-3H2.8a1.8 1.8 0 1 1 0-3.6h1.4v-3A1.5 1.5 0 0 1 5.7 5h3V3.5z"/></svg>
          <div>暂无可用插件</div>
          <button type="button" class="pe-link" @click="tab = 'market'">去插件市场安装 →</button>
        </div>
        <div v-for="p in kernel.installedPlugins" :key="p.id" class="plugin-card" role="listitem" :class="{ 'is-off': !p.enabled }" :data-layout="layout">
          <div class="pc-top">
            <div class="pc-icon" :style="{ background: colorOf(p.id) }" aria-hidden="true">{{ initialOf(p.name) }}</div>
            <div class="pc-main">
              <div class="pc-name">{{ p.name }}</div>
              <div class="pc-desc">{{ p.description }}</div>
            </div>
          </div>
          <div class="pc-foot">
            <span class="chip pc-state" :class="p.enabled ? 'pc-on' : 'pc-off'">{{ p.enabled ? '已启用' : '已禁用' }}</span>
            <!-- 运行态（2026-10-20 P1）：事件源常驻运行中；崩溃超限如实标故障（禁用后可重试） -->
            <span v-if="p.runtime?.state === 'running'" class="pc-rt">运行中</span>
            <span v-else-if="p.runtime?.state === 'faulted'" class="pc-rt pc-rt-fault" :title="p.runtime.faultReason ?? ''">故障</span>
            <span class="pc-version mono">v{{ p.version }}</span>
            <button type="button" class="pc-btn" @click="toggle(p)">{{ p.enabled ? '禁用' : '启用' }}</button>
            <button type="button" class="pc-btn pc-btn-danger" @click="uninstall(p)">
              {{ confirmingId === p.id ? '确认卸载？' : '卸载' }}
            </button>
          </div>
        </div>
      </template>
    </div>
  </section>
</template>

<style scoped src="./plugins.css"></style>
