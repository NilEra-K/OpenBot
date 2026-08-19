<script setup lang="ts">
/**
 * console 视图（Step 7 最小骨架）：连接状态 + 事实流概览。
 * Step 8 迁移原型三栏布局：对话流 + 执行卡 + steward 默认路由/markdown/乐观更新。
 */
import { useKernelStore } from '../stores/kernel'

const kernel = useKernelStore()
</script>

<template>
  <section class="view">
    <h2 class="view-title">控制台</h2>
    <p v-if="kernel.bootError" class="placeholder">内核未连接：{{ kernel.bootError }}</p>
    <p v-else-if="!kernel.steward" class="placeholder">管家空缺——首个注册 agent 将被任命为管家</p>
    <template v-else>
      <p class="placeholder">对话视图（Step 8 迁移 prototype.html 三栏布局）</p>
      <p class="meta">管家：{{ kernel.steward.name ?? kernel.steward.agentId }}（{{ kernel.steward.agentId }}）</p>
    </template>
  </section>
</template>

<style scoped>
.meta {
  color: var(--muted);
  text-align: center;
}
</style>
