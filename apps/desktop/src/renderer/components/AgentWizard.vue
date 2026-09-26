<script setup lang="ts">
/**
 * 新建 agent 向导（P4 Step 5，原型 wiz-* 迁移）：三步——身份（名字/角色分段/身份色）→
 * 模型与沙箱（裁定 B/F 如实说明「继承全局」，不放假选项）→ 复核创建。
 * 开合归 ui store（名册入口与命令面板共用）；创建走 kernel.registerAgent 命令面
 * （服务端建名册+调度器+专属 Box；领域失败就地显示，不上全局 toast——表单上下文优先）。
 */
import { computed, nextTick, ref, watch } from 'vue'
import { useKernelStore } from '../stores/kernel'
import { useUiStore } from '../stores/ui'
import { useToastStore } from '../stores/toast'
import { GatewayCommandError } from '../lib/gateway'

const kernel = useKernelStore()
const ui = useUiStore()
const toast = useToastStore()

/** 身份色 swatches（原型 WIZ_COLORS 同款六色） */
const COLORS = ['#d95926', '#aab137', '#199e70', '#3987e5', '#8F6FD3', '#4FA8A0'] as const
/** 角色分段：叙事四选一映射内核二值（管家=steward 走任命事务——在职时如实报错；其余=worker） */
const ROLES = [
  { label: '管家', role: 'steward' },
  { label: '研究员', role: 'worker' },
  { label: '工程师', role: 'worker' },
  { label: '观察员', role: 'worker' },
] as const
const STEPS = ['身份', '模型与沙箱', '复核']

const step = ref(0)
const name = ref('')
const roleIdx = ref(1) // 默认研究员（管家在职时选管家会被拒绝——默认避开高频失败路径）
const color = ref<string>(COLORS[3])
/** 模型覆盖（backlog ③）：空串=默认模型（自动） */
const modelOverride = ref('')
/** 镜像绑定（plan-image-firstclass P8-4）：空串=默认沙箱（装配选定的本机后端） */
const imageBinding = ref('')
const error = ref('')
const creating = ref(false)
const nameEl = ref<HTMLInputElement | null>(null)

const roleLabel = computed(() => ROLES[roleIdx.value]!.label)
const isSteward = computed(() => ROLES[roleIdx.value]!.role === 'steward')
/** 当前主力（复核如实显示继承对象；未配置时如实标注）——v2 呈现「供应商 · 模型」 */
const primaryModel = computed(() =>
  kernel.defaultProvider === null
    ? '未配置'
    : `${kernel.defaultProvider}${kernel.defaultModel ? ' · ' + kernel.defaultModel : ''}`,
)

/** 模型覆盖选项（v2 供应商 1:N 模型）：拉平为「供应商::模型」复合值——agent 覆盖粒度到模型级 */
const modelOptions = computed(() =>
  kernel.providers.flatMap((p) =>
    p.models.map((m) => ({ value: `${p.name}::${m.id}`, label: `${p.name} · ${m.id}` })),
  ),
)
/** 复合键呈现：'供应商::模型' → '供应商 · 模型'（复核步展示用） */
const formatModelRef = (ref: string): string => ref.replace('::', ' · ')

/** 每次打开都是干净会话（原型 openAgentWizard 同语义） */
watch(
  () => ui.wizardOpen,
  (open) => {
    if (!open) return
    step.value = 0
    name.value = ''
    roleIdx.value = 1
    color.value = COLORS[3]
    imageBinding.value = ''
    error.value = ''
    void kernel.refreshImages() // 镜像清单现拉（设置页改动后向导不背旧账）
    void nextTick(() => nameEl.value?.focus())
  },
)

const close = (): void => {
  ui.closeWizard()
}

const prev = (): void => {
  if (step.value > 0) {
    step.value -= 1
    error.value = ''
  }
}

const next = async (): Promise<void> => {
  if (creating.value) return
  if (step.value === 0) {
    if (name.value.trim() === '') {
      void nextTick(() => nameEl.value?.focus())
      return
    }
    step.value = 1
    return
  }
  if (step.value === 1) {
    step.value = 2
    return
  }
  // 复核 → 创建（命令面：服务端生成 agentId、注册即建专属 Box）
  creating.value = true
  error.value = ''
  try {
    const agentId = await kernel.registerAgent({
      name: name.value.trim(),
      color: color.value,
      role: isSteward.value ? 'steward' : 'worker',
      ...(modelOverride.value !== '' ? { modelProvider: modelOverride.value } : {}),
      ...(imageBinding.value !== '' ? { imageId: imageBinding.value } : {}),
    })
    toast.push(`agent「${name.value.trim()}」已创建`, 'success')
    ui.closeWizard()
    ui.activeAgentId = agentId
    ui.switchView('console')
  } catch (err) {
    error.value =
      err instanceof GatewayCommandError && err.code === 'STATE_STEWARD_EXISTS'
        ? '管家已在位——先罢免或转移现任管家，再创建新管家'
        : err instanceof Error
          ? err.message
          : String(err)
  } finally {
    creating.value = false
  }
}

/** Esc 关闭（stopPropagation 不惊动其他 Esc 语义；与命令面板同款边界） */
const onKeydown = (e: KeyboardEvent): void => {
  if (e.key === 'Escape') {
    e.stopPropagation()
    close()
  } else if (e.key === 'Enter' && e.target === nameEl.value) {
    e.preventDefault()
    void next()
  }
}
</script>

<template>
  <div v-if="ui.wizardOpen" class="wiz-overlay" @mousedown.self="close()">
    <div class="wiz-card" role="dialog" aria-label="新建 agent" @keydown="onKeydown">
      <div class="wiz-head">
        <span class="wiz-title">新建 agent</span>
        <span class="wiz-dots" aria-hidden="true">
          <span v-for="(s, i) in STEPS" :key="s" :class="{ on: i <= step }"></span>
        </span>
        <button class="wiz-close" type="button" aria-label="关闭" @click="close()">✕</button>
      </div>

      <!-- 步 1：身份（名字 / 角色分段 / 身份色） -->
      <div v-if="step === 0" class="wiz-body">
        <div class="wiz-field">
          <label class="wiz-label" for="wizName">名字</label>
          <input
            id="wizName"
            ref="nameEl"
            v-model="name"
            class="wiz-input"
            placeholder="例：欧米伽"
            autocomplete="off"
            maxlength="24"
          />
        </div>
        <div class="wiz-field">
          <span class="wiz-label">角色定位</span>
          <div class="wiz-seg" role="radiogroup" aria-label="角色定位">
            <button
              v-for="(r, i) in ROLES"
              :key="r.label"
              type="button"
              :class="{ 'is-sel': i === roleIdx }"
              role="radio"
              :aria-checked="i === roleIdx"
              @click="roleIdx = i"
            >{{ r.label }}</button>
          </div>
        </div>
        <div class="wiz-field">
          <span class="wiz-label">身份色 · 社交图谱与会话头像</span>
          <div class="wiz-swatches">
            <button
              v-for="c in COLORS"
              :key="c"
              type="button"
              class="wiz-swatch"
              :class="{ 'is-sel': c === color }"
              :style="{ background: c }"
              :aria-label="`身份色 ${c}`"
              @click="color = c"
            ></button>
          </div>
        </div>
        <p class="wiz-note">身份色同时用于消息署名与图谱节点（创建后可在档案中修改）。</p>
      </div>

      <!-- 步 2：模型与沙箱（backlog ③：模型可选覆盖档案；未选默认模型（自动）） -->
      <div v-else-if="step === 1" class="wiz-body">
        <div class="wiz-kv wiz-kv-col">
          <span class="k">模型</span>
          <label class="wiz-field">
            <span class="wiz-field-label">默认模型（自动）{{ primaryModel !== '未配置' ? `（${primaryModel}）` : '' }}——或为该 agent 指定模型：</span>
            <select v-model="modelOverride" class="wiz-select">
              <option value="">默认模型（自动）</option>
              <option v-for="opt in modelOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
            </select>
          </label>
          <p v-if="modelOverride !== ''" class="wiz-note">覆盖后该 agent 钉住所选端点——默认模型切换不影响它（改动重启生效）。</p>
        </div>
        <div class="wiz-kv wiz-kv-col">
          <span class="k">沙箱镜像</span>
          <label class="wiz-field">
            <span class="wiz-field-label">缺省用默认沙箱（装配选定的本机后端，重活不进云）——或绑定已注册的镜像：</span>
            <select v-model="imageBinding" class="wiz-select">
              <option value="">默认沙箱</option>
              <option v-for="img in kernel.images" :key="img.id" :value="img.id">{{ img.name }}（{{ img.carrier === 'ssh' ? 'SSH ' + img.host : img.image }}）</option>
            </select>
          </label>
          <p v-if="imageBinding !== ''" class="wiz-note">绑定后该 agent 的专属 Box 落在所选镜像上——注册即真实连接（机器不可达会如实失败）；改绑重启生效。</p>
        </div>
      </div>

      <!-- 步 3：复核 -->
      <div v-else class="wiz-body">
        <div class="wiz-kv"><span class="k">名字</span><span class="v">{{ name.trim() || '（未命名）' }}</span></div>
        <div class="wiz-kv"><span class="k">角色</span><span class="v">{{ roleLabel }}</span></div>
        <div class="wiz-kv">
          <span class="k">身份色</span>
          <span class="v"><span class="wiz-dot" :style="{ background: color }"></span>{{ color }}</span>
        </div>
        <div class="wiz-kv"><span class="k">模型</span><span class="v">{{ modelOverride !== '' ? `覆盖：${formatModelRef(modelOverride)}` : `默认模型（自动）（${primaryModel}）` }}</span></div>
        <div class="wiz-kv"><span class="k">沙箱镜像</span><span class="v">{{ imageBinding === '' ? '默认沙箱（注册即建专属 Box）' : '镜像：' + (kernel.images.find((i) => i.id === imageBinding)?.name ?? imageBinding) }}</span></div>
        <p class="wiz-note">创建后立即出现在成员名册、@提及与派单目标里；社交图谱会在下一条消息后连边。</p>
      </div>

      <div v-if="error" class="wiz-error" role="alert">{{ error }}</div>

      <div class="wiz-foot">
        <button class="wiz-btn ghost" type="button" @click="close()">取消</button>
        <span class="wiz-spacer"></span>
        <button v-if="step > 0" class="wiz-btn ghost" type="button" @click="prev()">上一步</button>
        <button class="wiz-btn primary" type="button" :disabled="creating" @click="next()">
          {{ step === 2 ? (creating ? '创建中…' : '创建 agent') : '下一步' }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
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

.wiz-dots {
  display: flex;
  gap: 5px;
}

.wiz-dots span {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--line-strong);
}

.wiz-dots span.on {
  background: var(--accent);
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

.wiz-seg {
  display: flex;
  gap: 4px;
  padding: 3px;
  border: 1px solid var(--line-strong);
  border-radius: 9px;
  background: var(--bg1);
}

.wiz-seg button {
  flex: 1;
  height: 28px;
  border: none;
  border-radius: 7px;
  background: none;
  color: var(--ink2);
  font: inherit;
  font-size: 12.5px;
  cursor: pointer;
}

.wiz-seg button.is-sel {
  background: var(--bg3);
  color: var(--ink);
  font-weight: 600;
}

.wiz-swatches {
  display: flex;
  gap: 9px;
}

.wiz-swatch {
  width: 26px;
  height: 26px;
  border-radius: 50%;
  border: 2px solid transparent;
  cursor: pointer;
  padding: 0;
}

.wiz-swatch.is-sel {
  border-color: var(--ink);
  box-shadow: 0 0 0 2px var(--bg2);
}

.wiz-note {
  font-size: 11.5px;
  color: var(--ink3);
  line-height: 1.6;
}

.wiz-kv {
  display: flex;
  gap: 14px;
  padding: 9px 2px;
  border-bottom: 1px solid var(--line);
  font-size: 12.5px;
}

.wiz-kv .k {
  width: 64px;
  flex: none;
  color: var(--ink3);
}

.wiz-kv .v {
  display: flex;
  flex-direction: column;
  gap: 2px;
  color: var(--ink);
}

.wiz-sub {
  font-size: 11px;
  color: var(--ink3);
}

.wiz-dot {
  display: inline-block;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  margin-right: 7px;
  vertical-align: baseline;
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

@keyframes wiz-in {
  from {
    opacity: 0;
  }

  to {
    opacity: 1;
  }
}

/* 模型覆盖下拉（backlog ③） */
.wiz-kv-col {
  flex-direction: column;
  align-items: stretch;
  gap: 8px;
}

.wiz-field-label {
  font-size: 11.5px;
  color: var(--ink3);
}

.wiz-select {
  height: 30px;
  padding: 0 8px;
  border-radius: 7px;
  border: 1px solid var(--line-strong);
  background: var(--bg0);
  color: var(--ink);
  font-size: 12.5px;
  outline: none;
}

.wiz-select:focus {
  border-color: rgba(var(--accent-rgb), 0.5);
}
</style>
