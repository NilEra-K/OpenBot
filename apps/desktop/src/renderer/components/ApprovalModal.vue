<script setup lang="ts">
/**
 * 审批弹窗（plan-p2 Step 10）：v1.approval.requested → 模态弹窗 → v1.approval.resolve 回写。
 * nonce 幂等：store 层按 nonce 去重，事件重放/恢复重发不双弹窗。
 * 「稍后处理」只藏弹窗（渲染局部态；内核挂起不受影响，流内 gate 卡与侧栏角标仍可见）。
 * 决议成功本地立即移除 + SSE resolved 事件幂等双保险；队列多审批时逐条推进。
 */
import { computed, ref, watch } from 'vue'
import { useKernelStore } from '../stores/kernel'
import { useUiStore } from '../stores/ui'

const kernel = useKernelStore()
const ui = useUiStore()

/** 队首未「稍后」的审批（决议/消失后队列自然推进到下一条） */
const current = computed(
  () => kernel.pendingApprovals.find((a) => !ui.dismissedApprovals.includes(a.nonce)) ?? null,
)

const resolving = ref<'approved' | 'denied' | null>(null)
const error = ref<string | null>(null)

// 插件工具归属（2026-10-20 P2①）：弹窗呈现插件身份与权限声明
const plugin = computed(() => kernel.pluginOfTool(current.value?.tool ?? ''))

const resolve = async (decision: 'approved' | 'denied'): Promise<void> => {
  if (!current.value || resolving.value !== null) return
  resolving.value = decision
  error.value = null
  // 先捕获（resolveApproval 成功后条目移除、current 即空——await 后 plugin computed 也随之为 null）
  const { nonce, tool } = current.value
  const isPluginTool = plugin.value !== null
  try {
    await kernel.resolveApproval(nonce, decision)
    // 插件工具批准 → 会话内记忆（同插件同工具不再询问——P2①）
    if (decision === 'approved' && isPluginTool) kernel.rememberPluginTool(tool)
    // 成功/领域失败条目已收敛（弹窗关闭）；传输失败条目保留于此重试
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    resolving.value = null
  }
}

const dismiss = (): void => {
  if (current.value) ui.dismissApproval(current.value.nonce)
}

// 终结审批离开队列后回收「稍后」标记（防数组缓涨；清理归 UI 层，kernel store 保持纯投影）
watch(
  () => kernel.pendingApprovals.map((a) => a.nonce).join(','),
  () => {
    const stale = ui.dismissedApprovals.filter((n) => !kernel.pendingApprovals.some((a) => a.nonce === n))
    if (stale.length > 0) ui.forgetApprovals(stale)
  },
)
</script>

<template>
  <div v-if="current" class="approval-scrim" role="presentation">
    <div class="approval-modal" role="dialog" aria-modal="true" aria-label="出 Box 操作待批准">
      <div class="am-head">
        <span class="am-title">⚠ 出 Box 操作待批准</span>
        <span v-if="kernel.pendingApprovals.length > 1" class="am-count mono">
          队列中 {{ kernel.pendingApprovals.length }} 条
        </span>
      </div>
      <div class="am-body">
        <p class="am-line">
          agent <b class="mono">{{ current.agentId }}</b>（run <span class="mono">{{ current.runId }}</span>）请求执行
        </p>
        <p class="am-tool mono">{{ current.tool }}</p>
        <!-- 插件身份与权限声明（P2①）：用户须知道「是哪个插件、要什么权限」才谈得上信任 -->
        <p v-if="plugin" class="am-plugin">
          来自插件 <b>{{ plugin.name }}</b>
          <span v-if="plugin.permissions && plugin.permissions.length > 0" class="am-perms">
            <span v-for="pm in plugin.permissions" :key="pm" class="chip am-perm mono">{{ pm }}</span>
          </span>
          <span v-else class="am-perm-none">（未声明权限）</span>
        </p>
        <p v-if="current.reason" class="am-reason">{{ current.reason }}</p>
        <p class="am-note">
          批准后本次放行；拒绝则本次拒绝（执行按重试策略处理）。决定只对本次生效，不写入持久策略<template v-if="plugin">；插件工具批准后<b>本会话内</b>同工具不再询问</template>。
        </p>
      </div>
      <p v-if="error" class="am-error">{{ error }}</p>
      <div class="am-actions">
        <button class="btn btn-primary" :disabled="resolving !== null" @click="resolve('approved')">
          {{ resolving === 'approved' ? '批准中…' : '批准' }}
        </button>
        <button class="btn btn-danger-ghost" :disabled="resolving !== null" @click="resolve('denied')">
          {{ resolving === 'denied' ? '拒绝中…' : '拒绝' }}
        </button>
        <button class="btn btn-ghost" :disabled="resolving !== null" @click="dismiss">稍后处理</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.approval-scrim {
  position: fixed;
  inset: 0;
  /* 高于操作台（80）：操作台开着时出 Box 审批也必须可见——审批是注意力捕获层 */
  z-index: 90;
  /* 全屏 overlay 显式退出拖窗区：fixed 盖住 titlebar 不改变 drag 判定（Chromium 行为），
     不声明 no-drag 则顶部 38px 内的真实点击被当拖窗吃掉 */
  -webkit-app-region: no-drag;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  animation: am-fade 160ms var(--ease);
}

@keyframes am-fade {
  from {
    opacity: 0;
  }
}

.approval-modal {
  width: 440px;
  max-width: calc(100vw - 48px);
  background: var(--bg1);
  border: 1px solid rgba(var(--accent-rgb), 0.4);
  border-radius: 14px;
  padding: 18px 20px 16px;
  box-shadow: 0 18px 50px rgba(0, 0, 0, 0.5);
}

.am-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}

.am-title {
  font-size: 14.5px;
  font-weight: 700;
  color: var(--accent);
}

.am-count {
  font-size: 11px;
  color: var(--ink3);
}

.am-body {
  font-size: 13px;
  color: var(--ink2);
  line-height: 1.7;
}

.am-line {
  margin: 0;
}

.am-line b {
  color: var(--ink);
}

.am-plugin {
  margin: 2px 0 0;
  font-size: 12.5px;
  color: var(--ink2);
}
.am-perms {
  display: inline-flex;
  gap: 5px;
  margin-left: 4px;
  vertical-align: middle;
}
.am-perm {
  height: 17px;
  font-size: 10.5px;
  padding: 0 7px;
}
.am-perm-none {
  color: var(--ink3);
  font-size: 11.5px;
}
.am-tool {
  margin: 8px 0;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--bg2);
  border: 1px solid var(--line-strong);
  color: var(--ink);
  font-size: 12.5px;
  word-break: break-all;
}

.am-reason {
  margin: 0 0 6px;
  font-size: 12px;
  color: var(--ink3);
}

.am-note {
  margin: 0;
  font-size: 11.5px;
  color: var(--ink3);
}

.am-error {
  margin: 10px 0 0;
  padding: 7px 10px;
  border-radius: 7px;
  border: 1px solid rgba(var(--danger-rgb), 0.3);
  background: rgba(var(--danger-rgb), 0.1);
  color: var(--danger);
  font-size: 12px;
}

.am-actions {
  display: flex;
  gap: 8px;
  margin-top: 14px;
}

.mono {
  font-family: var(--mono);
}








</style>
