<script setup lang="ts">
/**
 * Toast 宿主（P4 Step 2，原型 .toast 迁移）：右下角堆叠层——钉在状态栏上方；
 * aria-live 让读屏即时播报；点击即消（不必等自动消退）。
 */
import { useToastStore } from '../stores/toast'

const toast = useToastStore()
</script>

<template>
  <div class="toast-stack" aria-live="polite">
    <button
      v-for="t in toast.items"
      :key="t.id"
      class="toast"
      :class="t.kind"
      type="button"
      @click="toast.dismiss(t.id)"
    >
      {{ t.text }}
    </button>
  </div>
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
  animation: toast-in 180ms var(--ease);
  pointer-events: auto;
}

.toast.success {
  border-color: rgba(var(--success-rgb), 0.4);
}

.toast.danger {
  border-color: rgba(var(--danger-rgb), 0.45);
}

@keyframes toast-in {
  from {
    opacity: 0;
    transform: translateY(8px);
  }

  to {
    opacity: 1;
    transform: none;
  }
}
</style>
