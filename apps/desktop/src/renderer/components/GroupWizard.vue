<script setup lang="ts">
/**
 * 建群向导（P5 Step 4，AgentWizard 容器同款一步式）：群名 + 成员多选 → v1.group.create
 * （内核全量校验成员在位）→ 建群 sysnote 落群流 → toast + 跳群会话。
 * 成员命中面 = 名册全量（worker 与管家同为普通成员——群 leaderless，§3.5）；
 * 领域失败就地显示，不上全局 toast（表单上下文优先——与 AgentWizard 同约定）。
 */
import { computed, nextTick, ref, watch } from 'vue'
import { useKernelStore } from '../stores/kernel'
import { useUiStore } from '../stores/ui'
import { useToastStore } from '../stores/toast'

const kernel = useKernelStore()
const ui = useUiStore()
const toast = useToastStore()

const name = ref('')
/** 选中成员集合（agentId；顺序按名册序——内核按传入顺序轮转） */
const selected = ref(new Set<string>())
const error = ref('')
const creating = ref(false)
const nameEl = ref<HTMLInputElement | null>(null)

/** 每次打开都是干净会话（AgentWizard 同语义） */
watch(
  () => ui.groupWizardOpen,
  (open) => {
    if (!open) return
    name.value = ''
    selected.value = new Set()
    error.value = ''
    void nextTick(() => nameEl.value?.focus())
  },
)

const close = (): void => {
  ui.closeGroupWizard()
}

const toggle = (agentId: string): void => {
  const next = new Set(selected.value)
  if (next.has(agentId)) next.delete(agentId)
  else next.add(agentId)
  selected.value = next
}

/** 复核摘要：成员显示名列表 */
const memberSummary = computed(() =>
  kernel.roster
    .filter((a) => selected.value.has(a.agentId))
    .map((a) => a.name ?? a.agentId)
    .join('、'),
)

const create = async (): Promise<void> => {
  if (creating.value) return
  if (name.value.trim() === '') {
    error.value = '群名不能为空'
    void nextTick(() => nameEl.value?.focus())
    return
  }
  if (selected.value.size === 0) {
    error.value = '至少选择一名成员（内核按 GROUP_NOT_MEMBER 拒绝空成员列表）'
    return
  }
  creating.value = true
  error.value = ''
  try {
    const groupId = await kernel.createGroup(name.value.trim(), [...selected.value])
    toast.push(`群「${name.value.trim()}」已建立（${selected.value.size} 名成员）`, 'success')
    ui.closeGroupWizard()
    ui.openGroup(groupId)
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    creating.value = false
  }
}

/** Esc 关闭（stopPropagation 不惊动其他 Esc 语义；与 AgentWizard 同款边界） */
const onKeydown = (e: KeyboardEvent): void => {
  if (e.key === 'Escape') {
    e.stopPropagation()
    close()
  } else if (e.key === 'Enter' && e.target === nameEl.value) {
    e.preventDefault()
    void create()
  }
}
</script>

<template>
  <div v-if="ui.groupWizardOpen" class="wiz-overlay" @mousedown.self="close()">
    <div class="wiz-card" role="dialog" aria-label="新建群聊" @keydown="onKeydown">
      <div class="wiz-head">
        <span class="wiz-title">新建群聊</span>
        <button class="wiz-close" type="button" aria-label="关闭" @click="close()">✕</button>
      </div>

      <div class="wiz-body">
        <div class="wiz-field">
          <label class="wiz-label" for="gwName">群名</label>
          <input
            id="gwName"
            ref="nameEl"
            v-model="name"
            class="wiz-input"
            placeholder="例：产品评审组"
            autocomplete="off"
            maxlength="24"
          />
        </div>

        <div class="wiz-field">
          <span class="wiz-label">成员（{{ selected.size }} 名）——群内 leaderless：管家也是普通成员</span>
          <div class="gw-members" role="group" aria-label="群成员多选">
            <button
              v-for="a in kernel.roster"
              :key="a.agentId"
              type="button"
              class="gw-member"
              :class="{ 'is-sel': selected.has(a.agentId) }"
              :aria-pressed="selected.has(a.agentId)"
              @click="toggle(a.agentId)"
            >
              <span class="gw-dot" :style="{ background: kernel.colorOf(a.agentId) }"></span>
              <span class="gw-name">{{ a.name ?? a.agentId }}</span>
              <span class="gw-role">{{ a.role === 'steward' ? '管家' : 'worker' }}</span>
            </button>
            <div v-if="kernel.roster.length === 0" class="wiz-note">名册为空——先新建 agent 再建群</div>
          </div>
        </div>

        <p class="wiz-note">
          群聊是有界轮转：发消息后成员依序响应，无话可说回复 [pass]，全员 pass 即收敛；
          你的新消息随时打断当前轮次（supersede）。
        </p>
      </div>

      <div v-if="error" class="wiz-error" role="alert">{{ error }}</div>

      <div class="wiz-foot">
        <button class="wiz-btn ghost" type="button" @click="close()">取消</button>
        <span class="wiz-spacer"></span>
        <button class="wiz-btn primary" type="button" :disabled="creating" @click="create()">
          {{ creating ? '创建中…' : `建群${selected.size > 0 ? `（${memberSummary}）` : ''}` }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 容器与 AgentWizard 同款（wiz-overlay/wiz-card 族——弹层形态一致）；群特有 .gw-* */
.wiz-overlay {
  position: fixed;
  inset: 0;
  z-index: 60;
  background: rgba(0, 0, 0, 0.45);
  display: grid;
  place-items: center;
  animation: wiz-in 140ms var(--ease);
}

.wiz-card {
  width: 520px;
  max-width: calc(100vw - 48px);
  background: var(--bg2);
  border: 1px solid var(--line-strong);
  border-radius: 14px;
  box-shadow: 0 18px 50px rgba(0, 0, 0, 0.5);
  overflow: hidden;
}

.wiz-head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 18px;
  border-bottom: 1px solid var(--line);
}

.wiz-title {
  font-size: 13.5px;
  font-weight: 650;
}

.wiz-close {
  margin-left: auto;
  width: 26px;
  height: 26px;
  border: none;
  border-radius: 7px;
  background: none;
  color: var(--ink3);
  cursor: pointer;
  font-size: 12px;
}

.wiz-close:hover {
  background: var(--bg3);
  color: var(--ink);
}

.wiz-body {
  padding: 16px 18px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.wiz-field {
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.wiz-label {
  font-size: 11px;
  color: var(--ink3);
  letter-spacing: 0.05em;
}

.wiz-input {
  height: 34px;
  padding: 0 11px;
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  background: var(--bg1);
  color: var(--ink);
  font: inherit;
  font-size: 13px;
  outline: none;
}

.wiz-input:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-weak);
}

.wiz-note {
  font-size: 11.5px;
  color: var(--ink3);
  line-height: 1.6;
}

.wiz-error {
  margin: 0 18px;
  padding: 8px 12px;
  border: 1px solid rgba(214, 69, 69, 0.45);
  border-radius: 8px;
  background: rgba(214, 69, 69, 0.09);
  color: var(--danger, #d64545);
  font-size: 12px;
}

.wiz-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 13px 18px;
  border-top: 1px solid var(--line);
}

.wiz-spacer {
  flex: 1;
}

.wiz-btn {
  height: 30px;
  padding: 0 15px;
  border-radius: 15px;
  border: none;
  font: inherit;
  font-size: 12.5px;
  cursor: pointer;
}

.wiz-btn.ghost {
  background: none;
  border: 1px solid var(--line-strong);
  color: var(--ink2);
}

.wiz-btn.ghost:hover {
  background: var(--bg3);
  color: var(--ink);
}

.wiz-btn.primary {
  background: var(--accent);
  color: var(--accent-ink);
  font-weight: 600;
}

.wiz-btn.primary:disabled {
  opacity: 0.55;
  cursor: default;
}

/* 成员多选区（可滚动上限——名册大时不撑爆卡片） */
.gw-members {
  max-height: 240px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 3px;
  border: 1px solid var(--line);
  border-radius: 9px;
  background: var(--bg1);
}

.gw-member {
  display: flex;
  align-items: center;
  gap: 9px;
  height: 32px;
  padding: 0 10px;
  border: 1px solid transparent;
  border-radius: 7px;
  background: none;
  color: var(--ink);
  font: inherit;
  font-size: 12.5px;
  cursor: pointer;
  text-align: left;
}

.gw-member:hover {
  background: var(--bg3);
}

.gw-member.is-sel {
  background: var(--accent-weak);
  border-color: rgba(var(--accent-rgb), 0.35);
}

.gw-dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  flex: none;
}

.gw-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.gw-role {
  font-size: 11px;
  color: var(--ink3);
  flex: none;
}

@keyframes wiz-in {
  from {
    opacity: 0;
  }

  to {
    opacity: 1;
  }
}
</style>
