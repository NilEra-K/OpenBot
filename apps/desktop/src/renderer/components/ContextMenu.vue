<script setup lang="ts">
/**
 * 全局右键菜单（2026-10-16 用户裁定微信式紧凑）：main context-menu → preload 订阅 →
 * 自绘 DOM 菜单（原生 Menu 上下留白无 API 可调）；动作经 preload 回传 main 执行——
 * 编辑动作（剪切/粘贴等）必须由 webContents 施于焦点元素，renderer 无特权面。
 * 防失焦是成败关键：菜单容器 mousedown.prevent——点击菜单不把焦点从目标输入框移走。
 * 关闭四路：点击外部 / Esc / 窗口失焦 / 滚动（位置随内容失效）。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import type { ContextMenuPayload, MenuAction } from '../stores/kernel'

interface MenuItem {
  key: MenuAction
  label: string
  /** 快捷键标注（右侧弱化显示——仅标注，实际执行在 main webContents/既有键绑定） */
  accel?: string
}
interface MenuSep {
  key: string
  sep: true
}
type MenuEntry = MenuItem | MenuSep

const payload = ref<ContextMenuPayload | null>(null)
const pos = ref({ x: 0, y: 0 })
const menuEl = ref<HTMLElement | null>(null)

/** 上下文项组装（同第一层语义：编辑五项按 flags 显隐不放假项 / 选中复制 / 链接两项 / 调试组沉底） */
const entries = computed<MenuEntry[]>(() => {
  const p = payload.value
  if (p === null) return []
  const list: MenuEntry[] = []
  if (p.isEditable) {
    if (p.canUndo) list.push({ key: 'undo', label: '撤销', accel: 'Ctrl+Z' })
    if (p.canCut) list.push({ key: 'cut', label: '剪切', accel: 'Ctrl+X' })
    if (p.canCopy) list.push({ key: 'copy', label: '复制', accel: 'Ctrl+C' })
    if (p.canPaste) list.push({ key: 'paste', label: '粘贴', accel: 'Ctrl+V' })
    if (p.canSelectAll) list.push({ key: 'selectAll', label: '全选', accel: 'Ctrl+A' })
  } else if (p.selectionText.trim() !== '') {
    list.push({ key: 'copy', label: '复制', accel: 'Ctrl+C' })
  }
  if (p.linkURL !== '') {
    if (list.length > 0) list.push({ key: 's-link', sep: true })
    list.push({ key: 'copyLink', label: '复制链接地址' })
    list.push({ key: 'openLink', label: '在浏览器打开' })
  }
  if (list.length > 0) list.push({ key: 's-debug', sep: true })
  list.push({ key: 'inspect', label: '检查元素' })
  list.push({ key: 's-tail', sep: true })
  list.push({ key: 'reload', label: '重新加载', accel: 'Ctrl+R' })
  list.push({ key: 'devtools', label: '开发者工具', accel: 'F12' })
  return list
})

const onPayload = (p: ContextMenuPayload): void => {
  payload.value = p
  // +2px 右下偏移让开光标本体（微信式——鼠标不压首项）；右键点即菜单展开锚
  pos.value = { x: p.x + 2, y: p.y + 2 }
  // 防溢出：渲染后测量——右溢出贴右缘收进，下溢出以右键点为底向上翻
  void nextTick(() => {
    const el = menuEl.value
    if (el === null) return
    const rect = el.getBoundingClientRect()
    let { x, y } = pos.value
    if (x + rect.width > window.innerWidth) x = Math.max(0, window.innerWidth - rect.width)
    if (y + rect.height > window.innerHeight) y = Math.max(0, p.y - rect.height)
    pos.value = { x, y }
  })
}

const close = (): void => {
  payload.value = null
}

const run = (item: MenuItem): void => {
  const p = payload.value
  close()
  window.openbot.menu.action(item.key, { url: p?.linkURL || undefined, x: p?.x, y: p?.y })
}

/** 点击菜单外关闭（capture 先于目标；菜单内点击由容器 mousedown.prevent 拦） */
const onDocMouseDown = (e: MouseEvent): void => {
  if (payload.value === null) return
  if (menuEl.value !== null && e.composedPath().includes(menuEl.value)) return
  close()
}
const onKey = (e: KeyboardEvent): void => {
  if (e.key === 'Escape') close()
}
const onScrollOrBlur = (): void => close()

let unsubscribe: (() => void) | null = null

onMounted(() => {
  window.addEventListener('mousedown', onDocMouseDown, true)
  window.addEventListener('keydown', onKey, true)
  window.addEventListener('scroll', onScrollOrBlur, true)
  window.addEventListener('blur', onScrollOrBlur)
  unsubscribe = window.openbot.menu.onContextMenu(onPayload)
})

onBeforeUnmount(() => {
  window.removeEventListener('mousedown', onDocMouseDown, true)
  window.removeEventListener('keydown', onKey, true)
  window.removeEventListener('scroll', onScrollOrBlur, true)
  window.removeEventListener('blur', onScrollOrBlur)
  unsubscribe?.()
})
</script>

<template>
  <!-- mousedown.prevent：防失焦（编辑动作的目标焦点元素不被菜单抢走） -->
  <div
    v-if="payload !== null && entries.length > 0"
    ref="menuEl"
    class="ctxmenu"
    :style="{ left: pos.x + 'px', top: pos.y + 'px' }"
    role="menu"
    @mousedown.prevent
  >
    <template v-for="entry in entries" :key="entry.key">
      <div v-if="entry.sep" class="cm-sep"></div>
      <button v-else class="cm-item" type="button" role="menuitem" @click="run(entry)">
        <span class="cm-label">{{ entry.label }}</span>
        <span v-if="entry.accel !== undefined" class="cm-accel">{{ entry.accel }}</span>
      </button>
    </template>
  </div>
</template>

<style scoped>
/* 微信式紧凑（2026-10-16 用户样例裁定）：上下内边距 4px、项高 28px、圆角、柔和阴影、
   hover 圆角高亮条、通栏细分隔线——跟随主题变量 */
.ctxmenu {
  position: fixed;
  z-index: 1000;
  min-width: 172px;
  padding: 4px 0; /* 紧凑上下留白（原生菜单约 3 倍于此且无 API 可调——自绘动机） */
  background: var(--bg1);
  border: 1px solid var(--line);
  border-radius: 6px;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.16);
  display: flex;
  flex-direction: column;
}

.cm-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  height: 28px;
  margin: 0 4px;
  padding: 0 10px;
  border: none;
  border-radius: 4px;
  background: none;
  color: var(--ink);
  font: inherit;
  font-size: 12.5px;
  cursor: pointer;
  text-align: left;
}

.cm-item:hover {
  background: var(--bg3);
}

.cm-item:focus-visible {
  outline: none;
  background: var(--bg3);
}

.cm-accel {
  color: var(--ink3);
  font-size: 10.5px;
  flex: none;
}

.cm-sep {
  height: 1px;
  margin: 4px 8px;
  background: var(--line);
  flex: none;
}
</style>
