<script setup lang="ts">
/**
 * 新建 agent 向导（P4 Step 5，原型 wiz-* 迁移）：三步——身份（名字/角色分段/身份色）→
 * 模型与沙箱（裁定 B/F 如实说明「继承全局」，不放假选项）→ 复核创建。
 * 开合归 ui store（名册入口与命令面板共用）；创建走 kernel.registerAgent 命令面
 * （服务端建名册+调度器+专属 Box；领域失败就地显示，不上全局 toast——表单上下文优先）。
 */
import { computed, nextTick, reactive, ref, watch } from 'vue'
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
/** 角色分段：叙事四选一映射内核二值（管家=steward 走任命事务——在职时如实报错；其余=worker）。
 *  persona（2026-10-18 身份修复）：角色默认人设——用户留空即按此生成（注入系统提示词，群聊不冒充管家） */
const ROLES = [
  { label: '管家', role: 'steward', persona: '团队的管家——用户的第一对话者，统筹协调' },
  { label: '研究员', role: 'worker', persona: '团队的研究员，负责查证事实与分析问题' },
  { label: '工程师', role: 'worker', persona: '团队的工程师，负责动手实现与验证' },
  { label: '观察员', role: 'worker', persona: '团队的观察员，冷静旁观，补充被忽略的角度' },
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
/** 人设输入（2026-10-18 身份修复）：留空按选中角色默认生成 */
const persona = ref('')
/** 选中角色档位（2026-10-18 自定义角色）：按名字键选（内置四角色 + 用户模板统一命名空间）；
 *  默认研究员（管家在职时选管家会被拒绝——默认避开高频失败路径） */
const roleKey = ref('研究员')
/** 自定义角色表单（＋ 自定义展开）：保存即入模板库并选中 */
const roleForm = reactive({ open: false, name: '', persona: '', busy: false })
const roleFormNameEl = ref<HTMLInputElement | null>(null)
const color = ref<string>(COLORS[3])
/** 模型覆盖（backlog ③）：空串=默认模型（自动） */
const modelOverride = ref('')
/** 镜像绑定（plan-image-firstclass P8-4）：空串=默认沙箱（装配选定的本机后端） */
const imageBinding = ref('')
/** Box 数据目录单盒覆盖（2026-10-20 v0.2.0）：空串=全局默认——目录型后端（WSL）落盘位置可选 */
const boxDataDir = ref('')
const error = ref('')
const creating = ref(false)
const nameEl = ref<HTMLInputElement | null>(null)

/** 内置四角色（管家置顶——任命语义特殊）；自定义模板走「自定义 ▾」下拉清单（2026-10-18
 *  用户裁定：档位多了 chips 拥挤——内置常驻 + 自定义弹层，宽度恒定） */
const builtinRoles = ROLES
/** 当前选中的自定义档位（未选自定义 = undefined——按钮回落「自定义」文案） */
const selectedCustom = computed(() => kernel.roleTemplates.find((t) => t.name === roleKey.value))
const isSteward = computed(() => selectedCustom.value === undefined && roleKey.value === '管家')
const roleLabel = computed(() => roleKey.value)
/** 选中档位的默认人设（人设框留空时按此提交；占位提示同源——内置与自定义统一取值） */
const rolePersona = computed(
  () => builtinRoles.find((r) => r.label === roleKey.value)?.persona ?? selectedCustom.value?.persona ?? '',
)
/** 自定义档位选择器（2026-10-18）：**二级模态**——在向导之上居中弹出，向导高度纹丝不动。
 *  三轮迭代定稿：absolute 被 wiz-foot 挡 / Teleport 游离出框 / 流内展开顶高卡片且脚部
 *  不可达（用户三轮报障）——挤在向导卡内做弹层是错位，独立小模态是正解 */
const roleMenu = reactive({ open: false })
const toggleRoleMenu = (): void => {
  roleMenu.open = !roleMenu.open
  roleForm.open = false
  roleForm.name = ''
  roleForm.persona = ''
  if (roleMenu.open) void nextTick(() => roleFormNameEl.value?.focus())
}
const closeRoleMenu = (): void => {
  roleMenu.open = false
  roleForm.open = false
}
const selectRole = (role: string): void => {
  roleKey.value = role
  persona.value = rolePersona.value // 所见即所得（2026-10-18 优化）：选中即填默认人设，可改可清
  closeRoleMenu()
}
/** 同名覆盖知情（2026-10-18 优化）：upsert 是静默覆盖——重名时表单内如实提示 */
const roleFormOverwrite = computed(
  () => roleForm.name.trim() !== '' && kernel.roleTemplates.some((t) => t.name === roleForm.name.trim()),
)
const saveRoleForm = async (): Promise<void> => {
  if (roleForm.busy || roleForm.name.trim() === '' || roleForm.persona.trim() === '') return
  roleForm.busy = true
  try {
    await kernel.upsertRoleTemplate(roleForm.name.trim(), roleForm.persona.trim())
    roleKey.value = roleForm.name.trim()
    persona.value = roleForm.persona.trim()
    closeRoleMenu()
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    roleForm.busy = false
  }
}
const removeRole = async (role: string): Promise<void> => {
  await kernel.removeRoleTemplate(role).catch(() => {})
  if (roleKey.value === role) roleKey.value = '研究员'
}
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
    persona.value = ''
    roleKey.value = '研究员'
    roleForm.open = false
    roleMenu.open = false
    color.value = COLORS[3]
    imageBinding.value = ''
    boxDataDir.value = ''
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
      ...(boxDataDir.value.trim() !== '' ? { dataDir: boxDataDir.value.trim() } : {}),
      persona: persona.value.trim() !== '' ? persona.value.trim() : rolePersona.value,
      roleName: roleKey.value,
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
        <div class="wiz-field wiz-role-field">
          <span class="wiz-label">角色定位 · 内置四档 + 自定义（小红书运维/微商运营等按需建档）</span>
          <div class="wiz-seg" role="radiogroup" aria-label="角色定位">
            <button
              v-for="r in builtinRoles"
              :key="r.label"
              type="button"
              :class="{ 'is-sel': r.label === roleKey }"
              role="radio"
              :aria-checked="r.label === roleKey"
              @click="selectRole(r.label)"
            >{{ r.label }}</button>
            <!-- 自定义 ▾：选中自定义档位时呈现该档位名；点击弹清单 -->
            <button
              type="button"
              class="wiz-role-menu-btn"
              :class="{ 'is-sel': selectedCustom !== undefined }"
              :aria-expanded="roleMenu.open"
              @click="toggleRoleMenu()"
            >{{ selectedCustom?.name ?? '自定义' }}<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg></button>
          </div>
        </div>
        <div class="wiz-field">
          <label class="wiz-label" for="wizPersona">人设 · 留空按选中角色生成</label>
          <input
            id="wizPersona"
            v-model="persona"
            class="wiz-input"
            :placeholder="`例：${rolePersona}`"
            autocomplete="off"
            maxlength="500"
          />
          <div v-if="persona.length > 300" class="wiz-count">{{ persona.length }}/500</div>
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
        <div class="wiz-field">
          <label class="wiz-label" for="wizBoxDir">Box 数据目录 · 可选（留空用全局默认）</label>
          <input
            id="wizBoxDir"
            v-model="boxDataDir"
            class="wiz-input mono"
            placeholder="例：D:/OpenBotData/boxes（WSL 发行版落盘位置——仅目录型后端生效）"
            autocomplete="off"
            maxlength="300"
          />
          <p class="wiz-note">v0.2.0 位置参数化：目录型后端（WSL2）的发行版（VHDX）落盘位置——留空跟随设置页「沙箱数据目录」；其余载体如实忽略。</p>
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

    <!-- 自定义角色二级模态（2026-10-18 三轮定稿）：居中弹于向导之上——向导高度不动、
         脚部恒可达；列表选中即关，新建表单常驻（无二次顶高）；×/Esc/点遮罩三路关闭 -->
    <div v-if="roleMenu.open" class="wiz-romodal-mask" @mousedown.self="closeRoleMenu()">
      <div class="wiz-romodal" role="dialog" aria-label="自定义角色" @keydown.esc.stop="closeRoleMenu()">
        <div class="wiz-romodal-head">
          <span>自定义角色</span>
          <button type="button" class="wiz-romodal-x" aria-label="关闭" @click="closeRoleMenu()">×</button>
        </div>
        <div class="wiz-romodal-list">
          <template v-if="kernel.roleTemplates.length > 0">
            <button
              v-for="t in kernel.roleTemplates"
              :key="t.name"
              type="button"
              class="wiz-role-item"
              :class="{ 'is-sel': t.name === roleKey }"
              role="option"
              :aria-selected="t.name === roleKey"
              @click="selectRole(t.name)"
            >
              <svg v-if="t.name === roleKey" class="wiz-role-check" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5L20 7" /></svg>
              <span class="wiz-role-item-name">{{ t.name }}</span>
              <span class="wiz-role-item-desc">{{ t.persona }}</span>
              <span class="wiz-role-x" role="button" tabindex="-1" aria-label="删除自定义角色" title="删除该自定义角色" @click.stop="removeRole(t.name)">×</span>
            </button>
          </template>
          <div v-else class="wiz-role-empty">尚无自定义角色——用下方表单按需建档（小红书运维、微商运营…）</div>
        </div>
        <div class="wiz-role-form">
          <input ref="roleFormNameEl" v-model="roleForm.name" class="wiz-input" placeholder="角色名（≤12 字，例：小红书运维）" maxlength="12" />
          <input v-model="roleForm.persona" class="wiz-input" placeholder="人设描述（≤500 字）——该角色 Agent 的默认身份" maxlength="500" @keydown.enter.prevent="saveRoleForm" />
          <div v-if="roleFormOverwrite" class="wiz-role-hint">已存在同名档位——保存将覆盖其人设</div>
          <div class="wiz-role-form-actions">
            <button type="button" class="wiz-rb" :disabled="roleForm.busy" @click="saveRoleForm">保存并选用</button>
            <span v-if="roleForm.persona.length > 300" class="wiz-count">{{ roleForm.persona.length }}/500</span>
          </div>
        </div>
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


/* 自定义角色（2026-10-18 三轮定稿）：「自定义 ▾」触发二级模态——居中弹于向导之上，
 * 向导卡片高度零变化（前两轮：absolute 被脚挡 / 流内顶高且脚部不可达） */
.wiz-role-menu-btn {
  display: inline-flex;
  align-items: center;
  /* 2026-10-18 修复：inline-flex 内容默认 flex-start 靠左（其余档位按钮是 UA 文本居中）——
     补 justify 居中；左内边距 20px = 箭头半宽 7×2 + UA 右内边距 6（对称抵消），令**文字**
     光学居中与其余档位一致（实测：-7 → -3 → 0） */
  justify-content: center;
  padding-left: 20px;
  gap: 4px;
  color: var(--ink3);
}
.wiz-role-menu-btn.is-sel {
  color: var(--ink);
}
.wiz-romodal-mask {
  position: fixed;
  inset: 0;
  z-index: 70; /* 压过 wiz-overlay(60)——二级模态 */
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.28);
}
.wiz-romodal {
  display: flex;
  flex-direction: column;
  width: 400px;
  max-width: calc(100vw - 48px);
  max-height: min(480px, calc(100vh - 96px));
  padding: 14px 16px 16px;
  border: 1px solid var(--line-strong);
  border-radius: 14px;
  background: var(--bg2);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12), 0 18px 48px rgba(0, 0, 0, 0.22);
}
.wiz-romodal-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 13.5px;
  font-weight: 600;
  color: var(--ink);
  margin-bottom: 8px;
}
.wiz-romodal-x {
  border: none;
  background: none;
  color: var(--ink3);
  font-size: 18px;
  line-height: 1;
  padding: 2px 6px;
  border-radius: 6px;
  cursor: pointer;
}
.wiz-romodal-x:hover {
  color: var(--ink);
  background: var(--bg3);
}
.wiz-romodal-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
  min-height: 56px;
  max-height: 40vh;
  overflow-y: auto;
  padding: 4px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--bg1);
}
.wiz-role-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  border: none;
  border-radius: 7px;
  background: none;
  color: var(--ink);
  font: inherit;
  text-align: left;
  padding: 6px 10px;
  cursor: pointer;
}
.wiz-role-item:hover {
  background: var(--bg3);
}
.wiz-role-item.is-sel {
  background: var(--bg3);
  font-weight: 600;
}
.wiz-role-item-name {
  flex: none;
  font-size: 12.5px;
}
.wiz-role-item-desc {
  flex: 1;
  min-width: 0;
  font-size: 11px;
  color: var(--ink3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.wiz-role-x {
  position: absolute;
  top: 50%;
  right: 8px;
  transform: translateY(-50%);
  display: none;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--danger);
  color: #fff;
  font-size: 11px;
  line-height: 1;
  cursor: pointer;
}
.wiz-role-item:hover .wiz-role-x {
  display: inline-flex;
}
.wiz-role-item:hover .wiz-role-item-desc {
  padding-right: 22px;
}
.wiz-role-empty {
  padding: 10px;
  font-size: 12px;
  color: var(--ink3);
  text-align: center;
}
.wiz-role-new {
  padding: 7px 10px;
  border-top: 1px solid var(--line);
  margin-top: 2px;
  font-size: 12px;
  color: var(--ink3);
  cursor: pointer;
}
.wiz-role-new:hover {
  color: var(--ink);
}
.wiz-role-check {
  flex: none;
  color: var(--ink);
}
.wiz-role-hint {
  font-size: 11px;
  color: var(--warning, #e3ce5c);
}
.wiz-count {
  align-self: flex-end;
  font-size: 10.5px;
  color: var(--ink3);
}
.wiz-role-form {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 4px 2px;
  margin-top: 10px;
}
.wiz-role-form-actions {
  display: flex;
  gap: 8px;
}
.wiz-rb {
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  background: var(--bg2);
  color: var(--ink);
  font-size: 12px;
  padding: 6px 14px;
  cursor: pointer;
}
.wiz-rb-ghost {
  background: none;
  color: var(--ink3);
}
.wiz-rb:disabled {
  opacity: 0.5;
  cursor: default;
}
</style>
