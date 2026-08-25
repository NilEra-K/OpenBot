<script setup lang="ts">
/**
 * 设置视图（prototype.html 迁移，P2 范围 + P3 Step 5 沙箱选择）：
 * - LLM 推理：provider 档案 CRUD（真实命令面；key 密文经 safeStorage 落盘，跨边界无 key 材料——
 *   编辑时留空即保留原密文）；设为主力对管家与全部 agent 下轮生效。
 * - 沙箱后端：装配事实（当前后端/降级原因/CLI 探测）+ 偏好选择（写 settings，重启生效——
 *   后端选择是装配期决策不热切换）。docker/podman 未实现前只读呈现（不放假选项）。
 * - 权限策略：呈现 Manual 审批闸门现状——不放假开关（内核无对应存储）。
 */
import { computed, reactive, ref, watch } from 'vue'
import { useKernelStore } from '../stores/kernel'
import type { ProviderView, SandboxPref } from '../stores/kernel'
import { useUiStore } from '../stores/ui'
import type { ThemePref } from '../stores/ui'

const kernel = useKernelStore()
const ui = useUiStore()

// ---- 外观（呈现层偏好：localStorage 持久化，不进内核 settings——协议纯度） ----

interface ThemeOption {
  value: ThemePref
  label: string
  note: string
}

const THEME_OPTIONS: ThemeOption[] = [
  { value: 'auto', label: '跟随系统', note: '随 Windows 主题自动切换' },
  { value: 'dark', label: '夜间', note: '默认深色界面' },
  { value: 'light', label: '日间', note: '亮色界面（终端屏幕保持深色）' },
]

/** 单选直写 store（即时生效；setTheme 内含持久化与 <html data-theme> 同步） */
const themeChoice = computed({
  get: () => ui.theme,
  set: (v: ThemePref) => ui.setTheme(v),
})

// ---- provider 表单（添加/编辑共用；编辑时 name 锁定——name 是档案键，改名=新建） ----

interface ProviderForm {
  name: string
  baseUrl: string
  model: string
  apiKey: string
  proxyUrl: string
}

const EMPTY_FORM: ProviderForm = { name: '', baseUrl: '', model: '', apiKey: '', proxyUrl: '' }

const formOpen = ref(false)
const editingName = ref<string | null>(null)
const form = reactive<ProviderForm>({ ...EMPTY_FORM })
const saving = ref(false)
const formError = ref<string | null>(null)
/** 删除二段确认（进行中的名字；再点确认，点其他名字/取消则复位） */
const confirmingRemove = ref<string | null>(null)

const formValid = computed(() => {
  if (form.name.trim() === '' || form.model.trim() === '') return false
  try {
    new URL(form.baseUrl.trim())
    return true
  } catch {
    return false
  }
})

const openCreate = (): void => {
  editingName.value = null
  Object.assign(form, EMPTY_FORM)
  formError.value = null
  formOpen.value = true
}

const openEdit = (p: ProviderView): void => {
  editingName.value = p.name
  Object.assign(form, {
    name: p.name,
    baseUrl: p.baseUrl,
    model: p.model,
    apiKey: '', // 留空 = 保留原密文（服务端约定）
    proxyUrl: p.proxyUrl ?? '',
  })
  formError.value = null
  formOpen.value = true
}

const closeForm = (): void => {
  formOpen.value = false
  confirmingRemove.value = null
}

const save = async (): Promise<void> => {
  if (!formValid.value || saving.value) return
  saving.value = true
  formError.value = null
  try {
    await kernel.upsertProvider({
      name: form.name.trim(),
      baseUrl: form.baseUrl.trim(),
      model: form.model.trim(),
      ...(form.apiKey.trim() !== '' ? { apiKey: form.apiKey.trim() } : {}),
      ...(form.proxyUrl.trim() !== '' ? { proxyUrl: form.proxyUrl.trim() } : {}),
    })
    formOpen.value = false
  } catch (err) {
    formError.value = err instanceof Error ? `${err.message}` : String(err)
  } finally {
    saving.value = false
  }
}

const setDefault = (name: string): void => {
  confirmingRemove.value = null
  void kernel.setDefaultProvider(name).catch((err: unknown) => {
    formError.value = err instanceof Error ? err.message : String(err)
  })
}

const removeProvider = (name: string): void => {
  if (confirmingRemove.value !== name) {
    confirmingRemove.value = name // 第一次点：进入确认态
    return
  }
  confirmingRemove.value = null
  void kernel.removeProvider(name).catch((err: unknown) => {
    formError.value = err instanceof Error ? err.message : String(err)
  })
}

/** 档案名缩写徽标（大写两字符内） */
const markOf = (name: string): string => name.trim().slice(0, 2).toUpperCase() || '?'

const capsRows = computed(() => {
  const caps = kernel.caps
  if (!caps) return []
  return [
    { k: '快照', v: caps.snapshot ? '支持' : '不支持' },
    { k: '常驻', v: caps.persistent ? '支持' : '不支持' },
    { k: '无头执行', v: caps.headless ? '支持' : '不支持' },
    { k: '资源限额', v: caps.resourceLimits ? '支持' : '不支持' },
    { k: '隔离强度', v: caps.isolation },
  ]
})

// ---- 沙箱后端偏好（写 settings 重启生效；表单值与 stored 分离——未保存改动有提示） ----

interface PrefOption {
  value: SandboxPref
  label: string
  note: string
  disabled?: boolean
}

const PREF_OPTIONS: PrefOption[] = [
  { value: 'auto', label: '自动', note: '择优可用：WSL2 → Docker → Podman → mock' },
  { value: 'wsl', label: 'WSL2', note: '每 Box 一个发行版（Windows 主力）' },
  { value: 'mock', label: '模拟', note: '命令返回模拟输出（测试用）' },
  { value: 'docker', label: 'Docker', note: '待实现（P3 Step 4）', disabled: true },
  { value: 'podman', label: 'Podman', note: '待实现（P3 Step 4）', disabled: true },
]

const BACKEND_LABELS: Record<string, string> = {
  auto: '自动',
  mock: '模拟',
  wsl: 'WSL2',
  docker: 'Docker',
  podman: 'Podman',
}

const sandboxChoice = ref<SandboxPref>('auto')
const sandboxError = ref<string | null>(null)
/** stored 变化（boot 加载/set 成功）时同步表单值 */
watch(
  () => kernel.sandbox,
  (s) => {
    if (s) sandboxChoice.value = s.stored
  },
  { immediate: true },
)

const sandboxDirty = computed(() => kernel.sandbox !== null && sandboxChoice.value !== kernel.sandbox.stored)

const applySandbox = async (): Promise<void> => {
  if (!kernel.sandbox) return
  const prev = kernel.sandbox.stored
  try {
    await kernel.setSandbox(sandboxChoice.value)
    sandboxError.value = null
  } catch (err) {
    sandboxChoice.value = prev // 写入失败回滚（呈现与 settings 真相一致）
    sandboxError.value = err instanceof Error ? err.message : String(err)
  }
}

/** 后端显示名 */
const backendLabel = (id: string): string => BACKEND_LABELS[id] ?? id
/** 偏好涉及 WSL 且镜像未就绪时引导放置 */
const wslRelevant = computed(
  () =>
    kernel.sandbox !== null &&
    (kernel.sandbox.preference === 'wsl' || kernel.sandbox.preference === 'auto') &&
    !kernel.sandbox.rootfsReady,
)
</script>

<template>
  <section class="view view-scroll">
    <div class="settings">
      <!-- LLM 推理（真实命令面） -->
      <div class="set-sec-row">
        <div class="set-sec">LLM 推理</div>
        <button class="btn btn-secondary btn-sm" @click="openCreate">＋ 添加模型</button>
      </div>
      <div class="set-sec-note">
        接入 OpenAI 兼容端点（DeepSeek / GLM / Moonshot / 豆包 / Ollama / vLLM 等），可同时配置多个；
        设为主力后对管家与全部 agent 下轮对话生效。API key 以系统加密（safeStorage）落盘，不出现在
        transcript 与事件流里。当前主力：<b class="mono">{{ kernel.defaultProvider ?? '未配置（对话将失败）' }}</b>
      </div>

      <div v-for="p in kernel.providers" :key="p.name" class="cfg-row" :class="{ 'is-primary': p.name === kernel.defaultProvider }">
        <div class="cfg-mark">{{ markOf(p.name) }}</div>
        <div class="cfg-main">
          <div class="cfg-name">
            {{ p.name }}<span class="cfg-model mono">{{ p.model }}</span>
          </div>
          <div class="cfg-desc mono">{{ p.baseUrl }}<template v-if="p.proxyUrl"> · 代理 {{ p.proxyUrl }}</template></div>
        </div>
        <div class="cfg-actions">
          <button class="btn btn-ghost btn-sm" @click="openEdit(p)">编辑</button>
          <button v-if="p.name !== kernel.defaultProvider" class="btn btn-secondary btn-sm" @click="setDefault(p.name)">设为主力</button>
          <button class="btn btn-ghost btn-sm btn-danger" @click="removeProvider(p.name)">
            {{ confirmingRemove === p.name ? '确认删除？' : '删除' }}
          </button>
          <span v-if="p.name === kernel.defaultProvider" class="chip chip-accent">主力</span>
          <span class="chip" :class="p.hasKey ? 'chip-success' : ''">{{ p.hasKey ? '已存 key' : '无 key' }}</span>
        </div>
      </div>
      <p v-if="kernel.providers.length === 0" class="settings-empty">还没有模型端点——添加一个开始对话</p>

      <!-- 添加/编辑表单 -->
      <div v-if="formOpen" class="provider-form">
        <div class="field">
          <label class="field-label" for="pfName">显示名称</label>
          <input id="pfName" v-model="form.name" class="field-input" :disabled="editingName !== null" placeholder="例：DeepSeek" autocomplete="off" maxlength="16" />
        </div>
        <div class="field">
          <label class="field-label" for="pfUrl">Base URL</label>
          <input id="pfUrl" v-model="form.baseUrl" class="field-input mono" placeholder="https://api.deepseek.com/v1" autocomplete="off" spellcheck="false" />
        </div>
        <div class="field">
          <label class="field-label" for="pfModel">模型 ID</label>
          <input id="pfModel" v-model="form.model" class="field-input mono" placeholder="例：deepseek-chat" autocomplete="off" spellcheck="false" />
        </div>
        <div class="field">
          <label class="field-label" for="pfKey">API Key</label>
          <input id="pfKey" v-model="form.apiKey" class="field-input mono" type="password" :placeholder="editingName !== null ? '留空保留原密文' : '端点无需 key 时留空'" autocomplete="off" />
        </div>
        <div class="field">
          <label class="field-label" for="pfProxy">代理（可选）</label>
          <input id="pfProxy" v-model="form.proxyUrl" class="field-input mono" placeholder="http://127.0.0.1:7890" autocomplete="off" spellcheck="false" />
        </div>
        <p v-if="formError" class="form-error">{{ formError }}</p>
        <div class="form-actions">
          <button class="btn btn-primary" :disabled="!formValid || saving" @click="save">{{ saving ? '保存中…' : '保存' }}</button>
          <button class="btn btn-ghost" @click="closeForm">取消</button>
        </div>
      </div>

      <!-- 沙箱后端（装配事实 + 偏好选择；plan-p3 Step 5） -->
      <div class="set-sec">沙箱后端</div>
      <div class="set-sec-note">
        重活进本机沙箱。装配时按「偏好 × 环境探测」选择后端——改动偏好<b>重启后生效</b>（装配期决策，不热切换）；
        偏好不可用时如实回退 mock（命令返回模拟输出）并注明原因。
      </div>
      <template v-if="kernel.sandbox">
        <div class="kv">
          <span class="k">当前后端</span>
          <span class="v mono">
            {{ backendLabel(kernel.sandbox.backendId) }}<template v-if="kernel.sandbox.reason">（降级）</template>
          </span>
        </div>
        <p v-if="kernel.sandbox.reason" class="sandbox-warn">⚠ {{ kernel.sandbox.reason }}</p>
        <p v-if="wslRelevant" class="sandbox-warn">
          WSL 基础镜像未就绪：请把 Ubuntu rootfs 压缩包（tar.gz）放到
          <span class="mono">{{ kernel.sandbox.rootfsPath }}</span>，或设环境变量 OPENBOT_WSL_ROOTFS 指向已有文件后重启。
        </p>

        <div class="sandbox-prefs">
          <label
            v-for="opt in PREF_OPTIONS"
            :key="opt.value"
            class="sandbox-pref"
            :class="{ 'is-on': sandboxChoice === opt.value, 'is-disabled': opt.disabled }"
          >
            <input
              type="radio"
              name="sandbox-pref"
              class="sandbox-pref-radio"
              :value="opt.value"
              v-model="sandboxChoice"
              :disabled="opt.disabled"
              @change="applySandbox"
            />
            <span class="sandbox-pref-label">{{ opt.label }}</span>
            <span class="sandbox-pref-note">{{ opt.note }}</span>
          </label>
        </div>
        <p v-if="sandboxDirty" class="set-sec-note">偏好已修改——重启应用后生效（当前会话仍运行在 {{ backendLabel(kernel.sandbox.backendId) }}）。</p>
        <p v-if="sandboxError" class="form-error">{{ sandboxError }}</p>

        <div class="kv"><span class="k">环境探测</span><span class="v"></span></div>
        <div v-for="p in kernel.sandbox.probes" :key="p.id" class="sandbox-probe">
          <span class="chip" :class="p.available ? 'chip-success' : ''">{{ backendLabel(p.id) }} · {{ p.available ? '可用' : '不可用' }}</span>
          <span v-if="!p.available && p.reason" class="sandbox-probe-reason mono">{{ p.reason }}</span>
        </div>

        <!-- caps 事实（随所选后端变化） -->
        <div class="kv"><span class="k">能力声明（caps）</span><span class="v"></span></div>
        <div v-for="row in capsRows" :key="row.k" class="kv kv-sub">
          <span class="k">{{ row.k }}</span><span class="v mono">{{ row.v }}</span>
        </div>
      </template>
      <p v-else class="settings-empty">沙箱状态未加载（网关未连接）</p>

      <!-- 权限策略（呈现现状，不放假开关） -->
      <div class="set-sec">权限策略</div>
      <div class="set-sec-note">
        当前为手工审批闸门（Manual）：agent 在 Box 内自由执行；触碰宿主机文件或出网时在对话流内逐条请求批准，
        挂起期间 run 计入 deadline。进程崩溃重启后未决审批自动重发（账本持久真相）。策略分级开关属后续版本。
      </div>

      <!-- 外观（呈现层偏好，即时生效；复用沙箱偏好卡的交互与样式） -->
      <div class="set-sec">外观</div>
      <div class="set-sec-note">
        日间/夜间主题即时生效，「跟随系统」随 Windows 主题自动切换；标题栏的太阳/月亮按钮可随时快捷切换。
        此偏好只存本机（浏览器存储），不进内核设置。
      </div>
      <div class="sandbox-prefs">
        <label
          v-for="opt in THEME_OPTIONS"
          :key="opt.value"
          class="sandbox-pref"
          :class="{ 'is-on': ui.theme === opt.value }"
        >
          <input type="radio" name="theme-pref" class="sandbox-pref-radio" :value="opt.value" v-model="themeChoice" />
          <span class="sandbox-pref-label">{{ opt.label }}</span>
          <span class="sandbox-pref-note">{{ opt.note }}</span>
        </label>
      </div>

      <!-- 关于 -->
      <div class="set-sec">关于</div>
      <div class="kv"><span class="k">版本</span><span class="v mono">P3 开发版（v0.0.6+）</span></div>
      <div class="kv"><span class="k">许可</span><span class="v">Apache-2.0 · 净室自研</span></div>
    </div>
  </section>
</template>

<style scoped src="./settings.css"></style>
