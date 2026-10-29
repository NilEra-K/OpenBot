<script setup lang="ts">
/**
 * Toast 宿主（P4 Step 2；v0.1.98 方案 C+ 重设计——预览页与作者多轮定稿）：
 * 右下角堆叠层（钉状态栏上方）；aria-live 读屏即时播报；点击即消（不必等自动消退）。
 * 图标徽章四语义（16px SVG）：成功=绿圆勾（夜间反白块 / 日间中性白卡）、失败=红圆叉+红字、
 * 警告=黄三角叹号+黄字（warning 位 v0.1.98 新增）、信息=主题圆 i（accent——零彩色，
 * 与成功反白同语言）。徽章恒鲜活色（--icon-* 变量在 App.vue；勾/叹号字色随主题翻转）。
 * 动效三段：卡上滑+微缩放入场（280ms）→ 图标回弹弹出（140ms 延迟过冲 1.2×）→ 文案浮升；
 * 出场淡出+下滑（TransitionGroup：离场项绝对定位不挤占布局，余项平移让位）。
 * reduced-motion 由 App 全局媒体查询降级。
 */
import { useToastStore } from '../stores/toast'

const toast = useToastStore()
</script>

<template>
  <TransitionGroup name="toast" tag="div" class="toast-stack" aria-live="polite">
    <button
      v-for="t in toast.items"
      :key="t.id"
      class="toast"
      :class="t.kind"
      type="button"
      @click="toast.dismiss(t.id)"
    >
      <span class="ic" aria-hidden="true">
        <svg v-if="t.kind === 'success'" width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="8" fill="var(--icon-success)" /><path d="M4.6 8.3l2.2 2.2 4.6-4.8" stroke="var(--icon-check)" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round" /></svg>
        <svg v-else-if="t.kind === 'danger'" width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="8" fill="var(--icon-danger)" /><path d="M5.2 5.2l5.6 5.6M10.8 5.2l-5.6 5.6" stroke="#ffffff" stroke-width="1.8" stroke-linecap="round" /></svg>
        <svg v-else-if="t.kind === 'warning'" width="16" height="16" viewBox="0 0 16 16"><path d="M8 2.5L14.4 13.3H1.6Z" fill="var(--icon-warning)" stroke="var(--icon-warning)" stroke-width="2.4" stroke-linejoin="round" /><rect x="7.3" y="5.9" width="1.4" height="3.9" rx=".7" fill="var(--icon-bang)" /><circle cx="8" cy="11.9" r=".85" fill="var(--icon-bang)" /></svg>
        <svg v-else width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="8" fill="var(--accent)" /><rect x="7.25" y="6.8" width="1.5" height="4.2" rx=".75" fill="var(--accent-ink)" /><circle cx="8" cy="4.9" r=".95" fill="var(--accent-ink)" /></svg>
      </span>
      <span class="tx">{{ t.text }}</span>
    </button>
  </TransitionGroup>
</template>

<style scoped>
.toast-stack {
  position: fixed;
  right: 18px;
  bottom: 42px; /* 状态栏（28px）上方留隙 */
  z-index: 130;
  display: flex;
  flex-direction: column;
  gap: 8px;
  pointer-events: none;
}

.toast {
  max-width: 340px;
  padding: 10px 14px;
  border: 1px solid var(--line-strong);
  border-radius: 10px;
  background: var(--bg2);
  color: var(--ink);
  font-size: 12.5px;
  text-align: left;
  cursor: pointer;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.4);
  pointer-events: auto;
  display: flex;
  align-items: center;
  gap: 10px;
}

.toast .ic {
  flex: none;
  display: grid;
  place-items: center;
}

/* 语义面（方案 C+）：成功 = 反白强调块（仅夜间——日间反色观感差，见下方覆盖）；
   失败/警告 = 中性框 + 语义字色；信息 = 灰字（徽章已表义） */
.toast.success {
  background: var(--accent);
  color: var(--accent-ink);
  border-color: transparent;
  font-weight: 550;
}

.toast.danger {
  color: var(--danger-strong);
}

.toast.warning {
  color: var(--warning);
}

.toast.info {
  color: var(--ink2);
}

/* 日间（App data-theme=light）：阴影整体减淡（暗色调的 0.4/30px 在浅底发脏）；
   成功降为中性白卡 + 描边 + 加重字（反色在浅底观感差——作者裁定） */
:global(:root[data-theme='light']) .toast {
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.12);
}

:global(:root[data-theme='light']) .toast.success {
  background: var(--bg1);
  color: var(--ink);
  border-color: var(--line-strong);
}

/* 动效三段（方案 C+）：卡上滑+微缩放入场 → 图标回弹（140ms 延迟，过冲 1.2×——「叮」的
   确认感）→ 文案浮升（90ms 延迟）；出场走 TransitionGroup 过渡（下方 leave 类） */
@keyframes toast-in {
  from {
    opacity: 0;
    transform: translateY(12px) scale(0.96);
  }

  to {
    opacity: 1;
    transform: none;
  }
}

@keyframes toast-icon {
  0% {
    transform: scale(0);
  }

  70% {
    transform: scale(1.2);
  }

  100% {
    transform: scale(1);
  }
}

@keyframes toast-text {
  from {
    opacity: 0;
    transform: translateY(4px);
  }

  to {
    opacity: 1;
    transform: none;
  }
}

.toast {
  animation: toast-in 280ms var(--ease) both;
}

.toast .ic {
  animation: toast-icon 360ms cubic-bezier(0.34, 1.56, 0.64, 1) 140ms both;
}

.toast .tx {
  animation: toast-text 240ms var(--ease) 90ms both;
}

/* 出场（TransitionGroup）：离场项淡出+下滑+微缩（绝对定位不挤占余项——右缘锚定对齐
   堆叠右缘）；余项平移让位（move）；进入态由上面的 CSS 动画承担（enter 类无需过渡） */
.toast-leave-active {
  position: absolute;
  right: 0;
  transition: opacity 200ms var(--ease), transform 200ms var(--ease);
}

.toast-leave-to {
  opacity: 0;
  transform: translateY(8px) scale(0.97);
}

.toast-move {
  transition: transform 260ms var(--ease);
}
</style>
