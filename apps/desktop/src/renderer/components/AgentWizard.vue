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
import BotBallAvatar from './BotBallAvatar.vue'
import ColorPicker from './ColorPicker.vue'
import HelpTip from './HelpTip.vue'

const kernel = useKernelStore()
const ui = useUiStore()
const toast = useToastStore()

/** 身份色 swatches（原型 WIZ_COLORS 同款六色） */
const COLORS = ['#d95926', '#aab137', '#199e70', '#3987e5', '#8F6FD3', '#4FA8A0'] as const
/** 自选色位迷你色相盘（v0.1.66 修正八，用户裁定图例效果）：平滑彩虹盘（白心）——
 *  72 段细楔形（5°/段，26px 下肉眼无缝）+ 楔形同色描边盖抗锯齿缝 + 白心径向渐变叠层；
 *  纯 SVG 零 CSS 裁剪依赖，与 ColorPicker 大盘同视觉语言 */
const DISC_SEGS = 72
const DISC_R = 13
const hueWedge = (i: number): { d: string; fill: string } => {
  const a0 = ((i / DISC_SEGS) * 360 - 90) * (Math.PI / 180)
  const a1 = (((i + 1.4) / DISC_SEGS) * 360 - 90) * (Math.PI / 180) // +1.4° 重叠盖缝
  const x1 = 13 + DISC_R * Math.cos(a0)
  const y1 = 13 + DISC_R * Math.sin(a0)
  const x2 = 13 + DISC_R * Math.cos(a1)
  const y2 = 13 + DISC_R * Math.sin(a1)
  return {
    d: `M13 13 L${x1.toFixed(2)} ${y1.toFixed(2)} A${DISC_R} ${DISC_R} 0 0 1 ${x2.toFixed(2)} ${y2.toFixed(2)} Z`,
    fill: `hsl(${(i / DISC_SEGS) * 360} 100% 50%)`,
  }
}
const DISC_WEDGES = Array.from({ length: DISC_SEGS }, (_, i) => hueWedge(i))
/** 自建取色器开合（v0.1.66，用户裁定替代原生色盘）：渐变环按钮切换 */
const pickerOpen = ref(false)
/** 角色分段：叙事四选一映射内核二值（管家=steward 走任命事务——在职时如实报错；其余=worker） */
const ROLES = [
  { label: '管家', role: 'steward' },
  { label: '研究员', role: 'worker' },
  { label: '工程师', role: 'worker' },
  { label: '观察员', role: 'worker' },
] as const
const STEPS = ['身份', '模型与沙箱', '复核']

const step = ref(0)
/** 滑动过渡方向（2026-10-13）：前进 slide-left（新面板自右入）/ 后退 slide-right——
 *  大球在过渡容器之外恒静止（用户约束：ball-avatar 不参与水平过渡） */
const slideName = ref<'slide-left' | 'slide-right'>('slide-left')
/** 高度平滑过渡（2026-10-13 用户裁定「内容贴近 foot」两全）：恒定 310 基准退役——
 *  leave 前锁定当前像素高（防离场塌陷）→ enter 时过渡到新面板高 → 完成释放回自然高；
 *  高度变化与滑入并行（160ms 同拍），无空白无跳变；取色器展开等非切换撑高不受钩子介入 */
const stageEl = ref<HTMLElement | null>(null)
const onStageBeforeLeave = (): void => {
  if (stageEl.value) stageEl.value.style.height = `${stageEl.value.offsetHeight}px`
}
const onStageEnter = (el: Element): void => {
  if (stageEl.value) stageEl.value.style.height = `${(el as HTMLElement).offsetHeight}px`
}
const onStageAfterEnter = (): void => {
  if (stageEl.value) stageEl.value.style.height = ''
}
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
/** 模型行 ⓘ 浮层（用户需求 2026-10-13：长说明收进 icon——label 精简，主力真值如实进浮层） */
const modelTip = computed(() =>
  primaryModel.value === '未配置'
    ? '主力模型未配置——或为该 Agent 指定模型：钉住所选端点后，默认模型切换不影响它（改动重启生效）。'
    : `当前主力：${primaryModel.value}——或为该 Agent 指定模型：钉住所选端点后，默认模型切换不影响它（改动重启生效）。`,
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
    slideName.value = 'slide-left'
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
    slideName.value = 'slide-right' // 后退右滑（与前进左滑互逆）
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
    slideName.value = 'slide-left' // 前进左滑
    step.value = 1
    return
  }
  if (step.value === 1) {
    slideName.value = 'slide-left' // 前进左滑
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
    toast.push(`Agent「${name.value.trim()}」已创建`, 'success')
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
    <div class="wiz-card" role="dialog" aria-label="新建 Agent" @keydown="onKeydown">
      <div class="wiz-head">
        <span class="wiz-title">新建 Agent</span>
        <span class="wiz-dots" aria-hidden="true">
          <span v-for="(s, i) in STEPS" :key="s" :class="{ on: i <= step }"></span>
        </span>
        <button class="wiz-close" type="button" aria-label="关闭" @click="close()">✕</button>
      </div>

      <!-- 大球三步常驻（v0.1.66 步 1 引入，用户需求扩展为全程可见）：置于步骤分支之外——
           切步不重建实例，轮播引擎不重启无闪烁；选色即时染身跨步持续呈现 -->
      <div class="wiz-ball" aria-hidden="true">
        <BotBallAvatar :color="color" :tour="true" />
      </div>

      <!-- 步骤舞台（2026-10-13 滑动过渡）：面板在其中水平滑动（前进左滑/后退右滑）——
           大球在 stage 之外恒静止（用户约束：ball-avatar 不参与水平过渡） -->
      <div ref="stageEl" class="wiz-stage">
        <Transition :name="slideName" mode="out-in" @before-leave="onStageBeforeLeave" @enter="onStageEnter" @after-enter="onStageAfterEnter">
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
            <!-- 自选色位（v0.1.66）：迷你色相盘按钮（与展开的 ColorPicker 同款视觉）——
                 开合自建取色器；基础色选中时为彩虹盘、自选色后为该色纯色圆 -->
            <button
              type="button"
              class="wiz-swatch wiz-swatch-custom"
              :class="{ 'is-sel': !COLORS.includes(color) || pickerOpen }"
              aria-label="自定义身份色（取色器）"
              title="自定义颜色"
              @click="pickerOpen = !pickerOpen"
            >
              <!-- 22×22（=26 盒 − 2×2px 边框的内容区）：SVG 与按钮同心——26px 会溢出 4px 呈叠圆
                   （v0.1.66 修正九，3 倍特写探针实锤） -->
              <svg v-if="COLORS.includes(color)" width="22" height="22" viewBox="0 0 26 26" aria-hidden="true">
                <defs>
                  <radialGradient id="wiz-disc-white">
                    <stop offset="0%" stop-color="#fff" />
                    <stop offset="68%" stop-color="rgba(255, 255, 255, 0)" />
                  </radialGradient>
                </defs>
                <path v-for="(w, i) in DISC_WEDGES" :key="i" :d="w.d" :fill="w.fill" />
                <circle cx="13" cy="13" :r="DISC_R" fill="url(#wiz-disc-white)" />
              </svg>
              <svg v-else width="22" height="22" viewBox="0 0 26 26" aria-hidden="true">
                <circle cx="13" cy="13" r="13" :fill="color" />
              </svg>
            </button>
          </div>
          <!-- 自建取色器（v0.1.66）：色相盘 + 明度条，实时回写 color——球平滑变色 -->
          <ColorPicker v-if="pickerOpen" v-model="color" :size="150" />
        </div>
        <p class="wiz-note">身份色同时用于消息署名与图谱节点（创建后可在档案中修改）。</p>
      </div>

      <!-- 步 2：模型与沙箱（backlog ③：模型可选覆盖档案；未选默认模型（自动）） -->
      <div v-else-if="step === 1" class="wiz-body">
        <div class="wiz-kv wiz-kv-col">
          <span class="k">模型</span>
          <label class="wiz-field">
            <span class="wiz-field-label">
              默认模型（自动）
              <HelpTip :text="modelTip" up />
            </span>
            <select v-model="modelOverride" class="wiz-select">
              <option value="">默认模型（自动）</option>
              <option v-for="opt in modelOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
            </select>
          </label>
          <p v-if="modelOverride !== ''" class="wiz-note">覆盖后该 Agent 钉住所选端点——默认模型切换不影响它（改动重启生效）。</p>
        </div>
        <div class="wiz-kv wiz-kv-col">
          <span class="k">沙箱镜像</span>
          <label class="wiz-field">
            <span class="wiz-field-label">
              默认沙箱
              <HelpTip text="缺省用默认沙箱（装配选定的本机后端，重活不进云）——或绑定已注册的镜像：注册即真实连接（机器不可达会如实失败）。" up />
            </span>
            <select v-model="imageBinding" class="wiz-select">
              <option value="">默认沙箱</option>
              <option v-for="img in kernel.images" :key="img.id" :value="img.id">{{ img.name }}（{{ img.carrier === 'ssh' ? 'SSH ' + img.host : img.carrier === 'host-screen' ? '宿主屏幕' : img.carrier === 'windows' ? 'Windows ' + img.host : img.carrier === 'android' ? 'Android ' + img.host : img.image }}）</option>
            </select>
          </label>
          <p v-if="imageBinding !== ''" class="wiz-note">绑定后该 Agent 的专属 Box 落在所选镜像上——注册即真实连接（机器不可达会如实失败）；改绑重启生效。</p>
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
        </Transition>
      </div>

      <div v-if="error" class="wiz-error" role="alert">{{ error }}</div>

      <div class="wiz-foot">
        <button class="wiz-btn ghost" type="button" @click="close()">取消</button>
        <span class="wiz-spacer"></span>
        <button v-if="step > 0" class="wiz-btn ghost" type="button" @click="prev()">上一步</button>
        <button class="wiz-btn primary" type="button" :disabled="creating" @click="next()">
          {{ step === 2 ? (creating ? '创建中…' : '创建 Agent') : '下一步' }}
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

/* 步骤舞台（2026-10-13 滑动过渡）：高度随内容自适应 + 切换时平滑过渡（钩子见 script——
   恒定 310 基准经用户目验裁定退役：底部空白让位「内容贴近 foot」）；overflow 裁剪滑动
   面板不越卡片；大球在 stage 外恒静止（用户约束：ball-avatar 不参与水平过渡） */
.wiz-stage {
  position: relative;
  overflow: hidden;
  transition: height 160ms var(--ease);
}

/* 滑动过渡（方向感：前进左滑 / 后退右滑）：out-in 串行（旧滑出毕、新再滑入）——
   任意时刻至多一个面板（E2E toContainText 的 strict 单匹配不被过渡窗口打破）；
   160ms/段（总 320ms）+ 淡入淡出；stage 恒高兜底空档。类名对应
   <Transition name="slide-left|slide-right" mode="out-in"> */
.slide-left-enter-active,
.slide-left-leave-active,
.slide-right-enter-active,
.slide-right-leave-active {
  transition: transform 160ms var(--ease), opacity 160ms var(--ease);
}

.slide-left-enter-from {
  transform: translateX(28px);
  opacity: 0;
}

.slide-left-leave-to {
  transform: translateX(-28px);
  opacity: 0;
}

.slide-right-enter-from {
  transform: translateX(-28px);
  opacity: 0;
}

.slide-right-leave-to {
  transform: translateX(28px);
  opacity: 0;
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

/* 大球三步常驻（v0.1.66 步 1 引入后提出分支外）：间距自给——上 16px 对齐原 wiz-body
   padding-top，下 2px + 步骤区 padding-top 16px ≈ 原 4px + gap 14px，视觉零跳变 */
.wiz-ball {
  width: 88px;
  height: 88px;
  margin: 16px auto 2px;
}

/* 自选色位（v0.1.66 修正六）：原生色盘退役（用户裁定改自建取色器 ColorPicker）——
   label/input 裁剪方案两轮目验在用户环境失效呈方形，btn + SVG 环纯按钮零裁剪依赖 */
.wiz-swatch-custom {
  position: relative;
  border-radius: 50%;
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

/* 尾线去除（用户报障 2026-10-13）：最后一条 kv 之后已无 kv 需分割——
   步 2「沙箱镜像」行与步 3 复核末行（其后仅说明段落）的分线多余 */
.wiz-kv:last-of-type {
  border-bottom: none;
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
