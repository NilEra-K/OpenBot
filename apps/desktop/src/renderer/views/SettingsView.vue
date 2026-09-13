<script setup lang="ts">
/**
 * 设置视图（prototype.html 迁移，P2 范围 + P3 Step 5 沙箱选择）：
 * - LLM 推理：provider 档案 CRUD（真实命令面；key 密文经 safeStorage 落盘，跨边界无 key 材料——
 *   编辑时留空即保留原密文）；设为主力对管家与全部 agent 下轮生效。
 * - 沙箱后端：装配事实（当前后端/降级原因/CLI 探测）+ 偏好选择（写 settings，重启生效——
 *   后端选择是装配期决策不热切换）。docker/podman 未实现前只读呈现（不放假选项）。
 * - 权限策略：呈现 Manual 审批闸门现状——不放假开关（内核无对应存储）。
 */
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useKernelStore } from '../stores/kernel'
import type { ProviderView, SandboxPref } from '../stores/kernel'
import HelpTip from '../components/HelpTip.vue'
import { useUiStore } from '../stores/ui'
import type { ThemePref } from '../stores/ui'
import { useToastStore } from '../stores/toast'

const kernel = useKernelStore()
const ui = useUiStore()
const toast = useToastStore()

// ---- 定时自动化（backlog ②）：列表态挂 store；模态新建/编辑（cron 即时预览） ----
const automationModal = ref(false)
/** 编辑目标（null=新建） */
const editingAutomation = ref<string | null>(null)
const automationSaving = ref(false)
const automationError = ref<string | null>(null)
const cronPreview = ref<string | null>(null)
const aForm = reactive({ name: '', cron: '', agentId: '', prompt: '', enabled: true })

const agentNameOf = (agentId: string): string => kernel.roster.find((a) => a.agentId === agentId)?.name ?? agentId
const fmtNext = (at: number): string => {
  const d = new Date(at)
  const today = new Date()
  const sameDay = d.toDateString() === today.toDateString()
  const hm = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  return sameDay ? `今天 ${hm}` : `${d.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })} ${hm}`
}

const openAutomation = (row: { id: string; name: string; cron: string; agentId: string; prompt: string; enabled: boolean } | null): void => {
  automationModal.value = true
  automationError.value = null
  cronPreview.value = null
  editingAutomation.value = row?.id ?? null
  if (row !== null) {
    Object.assign(aForm, { name: row.name, cron: row.cron, agentId: row.agentId, prompt: row.prompt, enabled: row.enabled })
  } else {
    Object.assign(aForm, { name: '', cron: '', agentId: kernel.stewardId ?? '', prompt: '', enabled: true })
  }
}

/** cron 输入即时预览（防抖 400ms——解析在内核 v1.automations.preview） */
let cronPreviewTimer: ReturnType<typeof setTimeout> | null = null
watch(
  () => aForm.cron,
  (cron) => {
    cronPreview.value = null
    if (cronPreviewTimer !== null) clearTimeout(cronPreviewTimer)
    if (cron.trim() === '') return
    cronPreviewTimer = setTimeout(() => {
      void kernel.previewCron(cron.trim()).then((r) => (cronPreview.value = r.readable))
    }, 400)
  },
)

const automationValid = computed(() => aForm.name.trim() !== '' && aForm.cron.trim() !== '' && aForm.agentId !== '' && aForm.prompt.trim() !== '')

const saveAutomation = async (): Promise<void> => {
  automationSaving.value = true
  automationError.value = null
  try {
    const input = { name: aForm.name.trim(), cron: aForm.cron.trim(), agentId: aForm.agentId, prompt: aForm.prompt.trim(), enabled: aForm.enabled }
    if (editingAutomation.value === null) await kernel.addAutomation(input)
    else await kernel.updateAutomation(editingAutomation.value, input)
    toast.push(editingAutomation.value === null ? '自动化规则已创建' : '自动化规则已更新', 'success')
    automationModal.value = false
  } catch (err) {
    automationError.value = err instanceof Error ? err.message : String(err)
  } finally {
    automationSaving.value = false
  }
}

const toggleAutomation = (row: { id: string; enabled: boolean; name: string }): void => {
  void kernel.updateAutomation(row.id, { enabled: !row.enabled }).then(() => {
    toast.push(`${row.name} 已${row.enabled ? '停用' : '启用'}`, 'info')
  })
}

const removeAutomationRow = (row: { id: string; name: string }): void => {
  void kernel.removeAutomation(row.id).then(() => toast.push(`已删除：${row.name}`, 'info'))
}

onMounted(() => {
  void kernel.refreshAutomations()
  void kernel.refreshImages()
})

// ---- 镜像注册表（plan-image-firstclass P8-3）：条目清单 + 载体分表单模态 + 连接测试 ----
const imageFormOpen = ref(false)
const imageEditingId = ref<string | null>(null)
const imageForm = reactive<{
  name: string
  carrier: 'container' | 'ssh'
  image: string
  host: string
  port: number | null
  user: string
  keyPath: string
  controlProtocol: 'x11' | 'none'
  display: string
}>({ name: '', carrier: 'ssh', image: '', host: '', port: null, user: '', keyPath: '', controlProtocol: 'x11', display: '' })
const imageFormError = ref<string | null>(null)
const imageSaving = ref(false)
/** 删除二段确认（进行中的 id；语义同模型端点删除） */
const imageConfirmRemove = ref<string | null>(null)
/** 连接测试结果（per 条目 id——如实报告，title 带全文 chip 截断呈现） */
const imageTestResults = ref<Record<string, { ok: boolean; text: string }>>({})

const IMAGE_EMPTY_FORM = {
  name: '',
  carrier: 'ssh' as const,
  image: '',
  host: '',
  port: null as number | null,
  user: '',
  keyPath: '',
  controlProtocol: 'x11' as const,
  display: '',
}

const openImageCreate = (): void => {
  imageEditingId.value = null
  Object.assign(imageForm, IMAGE_EMPTY_FORM)
  imageFormError.value = null
  imageFormOpen.value = true
}

const openImageEdit = (img: { id: string; name: string; carrier: 'container' | 'ssh'; image?: string; host?: string; port?: number; user?: string; keyPath?: string; controlProtocol: 'x11' | 'none'; display?: string }): void => {
  imageEditingId.value = img.id
  Object.assign(imageForm, {
    name: img.name,
    carrier: img.carrier,
    image: img.image ?? '',
    host: img.host ?? '',
    port: img.port ?? null,
    user: img.user ?? '',
    keyPath: img.keyPath ?? '',
    controlProtocol: img.controlProtocol,
    display: img.display ?? '',
  })
  imageFormError.value = null
  imageFormOpen.value = true
}

const closeImageForm = (): void => {
  imageFormOpen.value = false
  imageConfirmRemove.value = null
}

const imageFormValid = computed(() => {
  if (imageForm.name.trim() === '') return false
  if (imageForm.carrier === 'container') return imageForm.image.trim() !== ''
  return imageForm.host.trim() !== ''
})

const saveImage = async (): Promise<void> => {
  if (!imageFormValid.value || imageSaving.value) return
  imageSaving.value = true
  imageFormError.value = null
  const payload = {
    name: imageForm.name.trim(),
    carrier: imageForm.carrier,
    controlProtocol: imageForm.controlProtocol,
    ...(imageForm.carrier === 'container'
      ? { image: imageForm.image.trim() }
      : {
          host: imageForm.host.trim(),
          ...(imageForm.port !== null && Number.isFinite(imageForm.port) ? { port: Number(imageForm.port) } : {}),
          ...(imageForm.user.trim() !== '' ? { user: imageForm.user.trim() } : {}),
          ...(imageForm.keyPath.trim() !== '' ? { keyPath: imageForm.keyPath.trim() } : {}),
        }),
    ...(imageForm.display.trim() !== '' ? { display: imageForm.display.trim() } : {}),
  }
  try {
    if (imageEditingId.value !== null) await kernel.updateImage(imageEditingId.value, payload)
    else await kernel.addImage(payload)
    toast.push(imageEditingId.value !== null ? '镜像条目已更新' : '镜像条目已添加', 'success')
    imageFormOpen.value = false
  } catch (err) {
    imageFormError.value = err instanceof Error ? err.message : String(err)
  } finally {
    imageSaving.value = false
  }
}

const removeImage = async (img: { id: string; name: string }): Promise<void> => {
  if (imageConfirmRemove.value !== img.id) {
    imageConfirmRemove.value = img.id
    return
  }
  try {
    await kernel.removeImage(img.id)
    toast.push('镜像条目已删除：' + img.name, 'success')
  } catch (err) {
    toast.push(err instanceof Error ? err.message : String(err), 'error')
  } finally {
    imageConfirmRemove.value = null
  }
}

const testImage = async (img: { id: string }): Promise<void> => {
  imageTestResults.value = { ...imageTestResults.value, [img.id]: { ok: true, text: '测试中…' } }
  try {
    const r = await kernel.testImage(img.id)
    imageTestResults.value = {
      ...imageTestResults.value,
      [img.id]: r.ok ? { ok: true, text: r.detail ?? '连接正常' } : { ok: false, text: r.reason ?? '不可用' },
    }
  } catch (err) {
    imageTestResults.value = {
      ...imageTestResults.value,
      [img.id]: { ok: false, text: err instanceof Error ? err.message : String(err) },
    }
  }
}

const carrierLabel = (c: 'container' | 'ssh'): string => (c === 'ssh' ? 'SSH' : '容器')
const imageSummary = (img: { carrier: 'container' | 'ssh'; image?: string; host?: string; port?: number; user?: string; keyPath?: string }): string => {
  if (img.carrier !== 'ssh') return img.image ?? ''
  let out = ''
  if (img.user) out += img.user + '@'
  out += img.host ?? ''
  if (img.port) out += ':' + String(img.port)
  if (img.keyPath) out += ' · key ' + img.keyPath
  return out
}

/** 应用版本（P4 Step 1）：main 经 preload 桥取 package.json version——不手写不过时 */
const appVersion = ref<string | null>(null)
// ---- 系统自启动（0.1.0 产品化）：注册表现状即真相——进页读、切换写（不另存偏好） ----
const autoLaunch = ref(false)
const toggleAutoLaunch = async (): Promise<void> => {
  const next = await window.openbot?.autoLaunch?.set(!autoLaunch.value)
  autoLaunch.value = next ?? autoLaunch.value
  toast.push(next ? '已开启开机自启动' : '已关闭开机自启动', 'success')
}

onMounted(() => {
  void window.openbot?.app
    ?.version()
    .then((v: string) => (appVersion.value = v))
    .catch(() => (appVersion.value = null)) // 桥缺失（浏览器 dev）——如实显示
  void window.openbot?.autoLaunch?.get().then((v: boolean | undefined) => {
    if (v !== undefined) autoLaunch.value = v
  })
})

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
  /** 协议族（P4 Step 11）：anthropic 走 messages API，缺省 openai-compat */
  protocol: 'openai-compat' | 'anthropic'
  /** 视觉（图像输入）声明（P8-2 生产门事实源）——勾选后主力为该端点时才可能注册 computer 工具族 */
  supportsImages: boolean
}

const EMPTY_FORM: ProviderForm = { name: '', baseUrl: '', model: '', apiKey: '', proxyUrl: '', protocol: 'openai-compat', supportsImages: false }

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
    protocol: p.protocol ?? 'openai-compat',
    supportsImages: p.supportsImages === true,
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
      protocol: form.protocol,
      supportsImages: form.supportsImages,
    })
    toast.push(`模型端点已保存：${form.name.trim()}`, 'success')
    formOpen.value = false
  } catch (err) {
    formError.value = err instanceof Error ? `${err.message}` : String(err)
  } finally {
    saving.value = false
  }
}

const setDefault = (name: string): void => {
  confirmingRemove.value = null
  void kernel.setDefaultProvider(name).then(() => {
    toast.push(`主力模型已切换：${name}——管家与全部 agent 下轮对话生效`, 'success')
  }).catch((err: unknown) => {
    formError.value = err instanceof Error ? err.message : String(err)
  })
}

const removeProvider = (name: string): void => {
  if (confirmingRemove.value !== name) {
    confirmingRemove.value = name // 第一次点：进入确认态
    return
  }
  confirmingRemove.value = null
  void kernel.removeProvider(name).then(() => {
    toast.push(`已删除模型端点：${name}`, 'info')
  }).catch((err: unknown) => {
    formError.value = err instanceof Error ? err.message : String(err)
  })
}

/** 设置/清除回退端点（P4 Step 11）：toggle——已是回退再点即清除；per-request 降级不粘滞 */
const setFallback = (name: string): void => {
  confirmingRemove.value = null
  const next = kernel.fallbackProvider === name ? null : name
  void kernel.setFallbackProvider(next).then(() => {
    toast.push(
      next === null ? '已清除回退端点' : `回退端点已设置：${next}——主力失败时本轮自动降级`,
      'success',
    )
  }).catch((err: unknown) => {
    formError.value = err instanceof Error ? err.message : String(err)
  })
}

/** 协议段的 baseUrl 占位提示（两种协议的前缀习惯不同） */
const urlPlaceholder = computed(() =>
  form.protocol === 'anthropic' ? 'https://api.anthropic.com/v1' : 'https://api.deepseek.com/v1',
)

// ---- 数据区块（P4 Step 11，裁定 E 一期只读：路径展示 + 打开文件夹） ----

const dataPaths = ref<{ userData: string; data: string; transcript: string } | null>(null)
onMounted(() => {
  void window.openbot?.app
    ?.paths()
    .then((p: { userData: string; data: string; transcript: string }) => (dataPaths.value = p))
    .catch(() => (dataPaths.value = null)) // 桥缺失（浏览器 dev）——如实降级
})

/** 打开数据文件夹（main 白名单限定 userData 内；返回错误消息，空串 = 成功） */
const openFolder = (path: string): void => {
  void window.openbot?.app?.openPath(path).then((err: string) => {
    if (err !== '' && err !== undefined) toast.push(`打开文件夹失败：${err}`, 'danger')
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
  { value: 'auto', label: '自动', note: '按平台择优可用（探测事实驱动）' },
  { value: 'wsl', label: 'WSL2', note: '每 Box 一个发行版（Windows 主力）' },
  { value: 'nspawn', label: 'systemd-nspawn', note: '机器即 Box（Linux；写操作需 root/polkit 授权）' },
  { value: 'utm', label: 'UTM', note: '虚拟机即 Box（macOS；从预建模板克隆，需 guest agent）' },
  { value: 'docker', label: 'Docker', note: '容器即 Box（需 Docker Desktop 运行）' },
  { value: 'podman', label: 'Podman', note: '容器即 Box（需 podman machine 运行）' },
  { value: 'ssh', label: 'SSH 主机', note: '机器即 Box（VMWare/云主机——env OPENBOT_SSH_HOST 等接入，显式偏好 opt-in）' },
  { value: 'mock', label: '模拟', note: '命令返回模拟输出（测试用）' },
]

const BACKEND_LABELS: Record<string, string> = {
  auto: '自动',
  mock: '模拟',
  wsl: 'WSL2',
  docker: 'Docker',
  podman: 'Podman',
  nspawn: 'systemd-nspawn',
  utm: 'UTM',
  ssh: 'SSH 主机',
}

/**
 * 偏好选项按探测在场过滤（P6 Step 5）：auto/mock 恒在，真实后端只有探测列表里有的才出选项——
 * 平台裁剪后的 probes 天然不含异平台后端（win 上不出现 nspawn/UTM），探测事实驱动零 if 平台特判
 */
const prefOptions = computed<PrefOption[]>(() => {
  if (!kernel.sandbox) return PREF_OPTIONS.filter((o) => o.value === 'auto' || o.value === 'mock')
  const probed = new Set(kernel.sandbox.probes.map((p) => p.id))
  return PREF_OPTIONS.filter((o) => o.value === 'auto' || o.value === 'mock' || probed.has(o.value as Exclude<SandboxPref, 'auto' | 'mock'>))
})

/** 该偏好项的探测事实（0.1.2 列表化：chip 并入行内；auto 无探测项返回 undefined，mock 恒可用） */
const probeOf = (value: SandboxPref) => kernel.sandbox?.probes.find((p) => p.id === value)

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
    toast.push('沙箱偏好已保存——重启应用后生效', 'success')
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
/** 一键配置降级引导（裁定 D）：WSL 探测不可用或镜像未就绪时给本地文档指引——不自动装系统级软件 */
const wslHelpNeeded = computed(() => {
  if (kernel.sandbox === null) return false
  const wsl = kernel.sandbox.probes.find((p) => p.id === 'wsl')
  return (wsl !== undefined && !wsl.available) || !kernel.sandbox.rootfsReady
})
</script>

<template>
  <section class="view view-scroll">
    <div class="settings">
      <!-- LLM 推理（真实命令面）——说明收进 ⓘ（0.1.2 设置页改版：正文只留活数据） -->
      <div class="set-sec-row">
        <div class="set-sec">LLM 推理</div>
        <HelpTip
          text="接入模型端点（OpenAI 兼容 / Anthropic 协议，DeepSeek / GLM / Moonshot / Claude 等），可同时配置多个；设为主力后对管家与全部 agent 下轮对话生效；可设一个回退端点——主力请求失败（网络/超时/过载）时本轮自动降级，主力恢复后下轮自然切回。API key 以系统加密（safeStorage）落盘，不出现在 transcript 与事件流里。"
        />
        <button class="btn btn-secondary btn-sm" style="margin-left: auto" @click="openCreate">＋ 添加模型</button>
      </div>
      <div class="kv">
        <span class="k">当前主力</span>
        <span class="v mono">{{ kernel.defaultProvider ?? '未配置（对话将失败）' }}</span>
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
          <button class="btn btn-ghost btn-sm" @click="setFallback(p.name)">
            {{ kernel.fallbackProvider === p.name ? '取消回退' : '设为回退' }}
          </button>
          <button class="btn btn-ghost btn-sm btn-danger" @click="removeProvider(p.name)">
            {{ confirmingRemove === p.name ? '确认删除？' : '删除' }}
          </button>
          <span v-if="p.name === kernel.defaultProvider" class="chip chip-accent">主力</span>
          <span v-if="p.name === kernel.fallbackProvider" class="chip">回退</span>
          <span v-if="p.protocol === 'anthropic'" class="chip">Anthropic</span>
          <span class="chip" :class="p.hasKey ? 'chip-success' : ''">{{ p.hasKey ? '已存 key' : '无 key' }}</span>
        </div>
      </div>
      <p v-if="kernel.providers.length === 0" class="settings-empty">还没有模型端点——添加一个开始对话</p>

      <!-- 添加/编辑表单（模态——AgentWizard/GroupWizard 容器同款；字段 id 全保留：E2E 定位与路径不变） -->
      <div v-if="formOpen" class="wiz-overlay" @mousedown.self="closeForm()">
        <div class="wiz-card" role="dialog" aria-label="模型端点配置" @keydown.escape="closeForm">
          <div class="wiz-head">
            <span class="wiz-title">{{ editingName !== null ? '编辑模型端点' : '添加模型端点' }}</span>
            <button class="wiz-close" type="button" aria-label="关闭" @click="closeForm()">✕</button>
          </div>
          <div class="wiz-body provider-form">
            <div class="field">
              <label class="field-label" for="pfName">显示名称</label>
              <input id="pfName" v-model="form.name" class="field-input" :disabled="editingName !== null" placeholder="例：DeepSeek" autocomplete="off" maxlength="16" />
            </div>
            <div class="field">
              <label class="field-label" for="pfUrl">Base URL</label>
              <input id="pfUrl" v-model="form.baseUrl" class="field-input mono" :placeholder="urlPlaceholder" autocomplete="off" spellcheck="false" />
            </div>
            <div class="field">
              <span class="field-label">协议</span>
              <div class="proto-seg" role="radiogroup" aria-label="协议族">
                <label class="proto-opt" :class="{ 'is-on': form.protocol === 'openai-compat' }">
                  <input type="radio" name="pf-proto" value="openai-compat" v-model="form.protocol" />
                  OpenAI 兼容
                </label>
                <label class="proto-opt" :class="{ 'is-on': form.protocol === 'anthropic' }">
                  <input type="radio" name="pf-proto" value="anthropic" v-model="form.protocol" />
                  Anthropic
                </label>
              </div>
            </div>
            <div class="field">
              <label class="field-label" for="pfModel">模型 ID</label>
              <input id="pfModel" v-model="form.model" class="field-input mono" placeholder="例：deepseek-chat" autocomplete="off" spellcheck="false" />
            </div>
            <div class="field">
              <label class="proto-opt" :class="{ 'is-on': form.supportsImages }" for="pfVision">
                <input id="pfVision" type="checkbox" v-model="form.supportsImages" />
                视觉（图像输入）
              </label>
              <p class="field-note">端点支持看图时勾选——GUI 沙箱工具集探测通过后，computer 工具族才会注册</p>
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
          </div>
          <div class="wiz-foot">
            <button class="btn btn-primary" :disabled="!formValid || saving" @click="save">{{ saving ? '保存中…' : '保存' }}</button>
            <button class="btn btn-ghost" @click="closeForm">取消</button>
          </div>
        </div>
      </div>

      <!-- 沙箱后端（装配事实 + 偏好选择；plan-p3 Step 5）——说明收进 ⓘ（0.1.2 改版：
           偏好改五行列表，环境探测并入行内 chip，不再独立分节） -->
      <div class="set-sec-row">
        <div class="set-sec">沙箱后端</div>
        <HelpTip
          text="重活进本机沙箱。装配时按「偏好 × 环境探测」选择后端——改动偏好重启后生效（装配期决策，不热切换）；偏好不可用时如实回退 mock（命令返回模拟输出）并注明原因。"
        />
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
        <!-- 一键配置降级引导（裁定 D）：不自动装系统级软件，指引到仓库文档 -->
        <p v-if="wslHelpNeeded" class="sandbox-warn">
          一键安装暂不提供（自动安装系统级软件风险高于收益）：WSL2 启用与 rootfs 制作步骤见仓库文档
          <span class="mono">docs/platforms.md</span>，完成后重启应用即可生效。
        </p>

        <!-- 偏好五行列表：名称 + 说明 + 该后端探测 chip（auto 无探测项/mock 恒可用） -->
        <div class="sandbox-list">
          <label
            v-for="opt in prefOptions"
            :key="opt.value"
            class="sandbox-row"
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
            <span class="sandbox-row-label">{{ opt.label }}</span>
            <span class="sandbox-row-note">{{ opt.note }}</span>
            <span
              v-if="probeOf(opt.value)"
              class="chip sandbox-row-probe"
              :class="probeOf(opt.value)!.available ? 'chip-success' : ''"
              :title="probeOf(opt.value)!.available ? 'CLI 探测可用' : probeOf(opt.value)!.reason"
            >
              {{ probeOf(opt.value)!.available ? '可用' : '不可用' }}
            </span>
          </label>
        </div>
        <p v-if="sandboxDirty" class="set-sec-note">偏好已修改——重启应用后生效（当前会话仍运行在 {{ backendLabel(kernel.sandbox.backendId) }}）。</p>
        <p v-if="sandboxError" class="form-error">{{ sandboxError }}</p>

        <!-- caps 事实（随所选后端变化） -->
        <div class="kv"><span class="k">能力声明（caps）</span><span class="v"></span></div>
        <div v-for="row in capsRows" :key="row.k" class="kv kv-sub">
          <span class="k">{{ row.k }}</span><span class="v mono">{{ row.v }}</span>
        </div>
      </template>
      <p v-else class="settings-empty">沙箱状态未加载（网关未连接）</p>

      <!-- 镜像注册表（plan-image-firstclass P8-3）：条目 = 载体 + 连接事实 + 控制协议——
           Agent 绑定镜像条目随 P8-4 开放；add/update 即时维护路由表（无需重启） -->
      <div class="set-sec-row">
        <div class="set-sec">镜像</div>
        <HelpTip
          text="注册可被 Agent 绑定的机器载体（容器镜像 / SSH 主机——VMWare、云主机）。条目 = 载体 + 连接事实 + 控制协议；「测试」做真实连通与工具集探测（如实报告，不假装可用）。SSH 载体以密钥免密为前提（key-only，无密码输入面）；GUI 面需远端已跑 tools/provision-gui.sh 预置桌面工具集。"
        />
        <button class="btn btn-secondary btn-sm" style="margin-left: auto" @click="openImageCreate">＋ 添加镜像</button>
      </div>
      <div v-for="img in kernel.images" :key="img.id" class="cfg-row" :data-image-id="img.id">
        <div class="cfg-main">
          <div class="cfg-name">{{ img.name }}</div>
          <div class="cfg-desc mono">{{ imageSummary(img) }}</div>
        </div>
        <div class="cfg-actions">
          <span class="chip">{{ carrierLabel(img.carrier) }}</span>
          <span v-if="img.controlProtocol === 'x11'" class="chip">GUI</span>
          <span
            v-if="imageTestResults[img.id]"
            class="chip"
            :class="imageTestResults[img.id].ok ? 'chip-success' : 'chip-danger'"
            :title="imageTestResults[img.id].text"
          >{{ imageTestResults[img.id].text.length > 24 ? imageTestResults[img.id].text.slice(0, 24) + '…' : imageTestResults[img.id].text }}</span>
          <button class="btn btn-ghost btn-sm" data-role="image-test" @click="testImage(img)">测试</button>
          <button class="btn btn-ghost btn-sm" data-role="image-edit" @click="openImageEdit(img)">编辑</button>
          <button class="btn btn-ghost btn-sm btn-danger" data-role="image-remove" @click="removeImage(img)">
            {{ imageConfirmRemove === img.id ? '确认删除？' : '删除' }}
          </button>
        </div>
      </div>
      <p v-if="kernel.images.length === 0" class="settings-empty">尚无镜像条目——SSH 主机（VMWare/云电脑）与容器镜像都可在此注册</p>

      <!-- 镜像条目表单（模态——provider 模态同款容器；字段 id 供 E2E 定位） -->
      <div v-if="imageFormOpen" class="wiz-overlay" @mousedown.self="closeImageForm()">
        <div class="wiz-card" role="dialog" aria-label="镜像条目配置" @keydown.escape="closeImageForm">
          <div class="wiz-head">
            <span class="wiz-title">{{ imageEditingId !== null ? '编辑镜像条目' : '添加镜像条目' }}</span>
            <button class="wiz-close" type="button" aria-label="关闭" @click="closeImageForm()">✕</button>
          </div>
          <div class="wiz-body provider-form">
            <div class="field">
              <label class="field-label" for="ifName">显示名称</label>
              <input id="ifName" v-model="imageForm.name" class="field-input" placeholder="例：VMWare Ubuntu" autocomplete="off" maxlength="64" />
            </div>
            <div class="field">
              <span class="field-label">载体</span>
              <div class="proto-seg" role="radiogroup" aria-label="载体类型">
                <label class="proto-opt" :class="{ 'is-on': imageForm.carrier === 'ssh' }">
                  <input type="radio" name="if-carrier" value="ssh" v-model="imageForm.carrier" />
                  SSH 主机
                </label>
                <label class="proto-opt" :class="{ 'is-on': imageForm.carrier === 'container' }">
                  <input type="radio" name="if-carrier" value="container" v-model="imageForm.carrier" />
                  容器镜像
                </label>
              </div>
            </div>
            <template v-if="imageForm.carrier === 'ssh'">
              <div class="field">
                <label class="field-label" for="ifHost">主机地址</label>
                <input id="ifHost" v-model="imageForm.host" class="field-input mono" placeholder="192.168.1.20 或 vm.local" autocomplete="off" spellcheck="false" />
              </div>
              <div class="field">
                <label class="field-label" for="ifPort">端口（可选，缺省 22）</label>
                <input id="ifPort" v-model.number="imageForm.port" class="field-input mono" type="number" min="1" max="65535" placeholder="22" />
              </div>
              <div class="field">
                <label class="field-label" for="ifUser">用户（可选）</label>
                <input id="ifUser" v-model="imageForm.user" class="field-input mono" placeholder="ops" autocomplete="off" />
              </div>
              <div class="field">
                <label class="field-label" for="ifKey">私钥路径（可选——密钥免密为前提）</label>
                <input id="ifKey" v-model="imageForm.keyPath" class="field-input mono" placeholder="C:/keys/vm.pem" autocomplete="off" spellcheck="false" />
              </div>
            </template>
            <div v-else class="field">
              <label class="field-label" for="ifImage">镜像名</label>
              <input id="ifImage" v-model="imageForm.image" class="field-input mono" placeholder="openbot-gui:24.04" autocomplete="off" spellcheck="false" />
            </div>
            <div class="field">
              <span class="field-label">控制协议</span>
              <div class="proto-seg" role="radiogroup" aria-label="控制协议">
                <label class="proto-opt" :class="{ 'is-on': imageForm.controlProtocol === 'x11' }">
                  <input type="radio" name="if-proto" value="x11" v-model="imageForm.controlProtocol" />
                  X11（Linux 桌面）
                </label>
                <label class="proto-opt" :class="{ 'is-on': imageForm.controlProtocol === 'none' }">
                  <input type="radio" name="if-proto" value="none" v-model="imageForm.controlProtocol" />
                  无（纯命令行）
                </label>
              </div>
            </div>
            <div v-if="imageForm.controlProtocol === 'x11'" class="field">
              <label class="field-label" for="ifDisplay">X 显示地址（可选，缺省 :0）</label>
              <input id="ifDisplay" v-model="imageForm.display" class="field-input mono" placeholder=":0" autocomplete="off" spellcheck="false" />
            </div>
            <p v-if="imageFormError" class="form-error">{{ imageFormError }}</p>
          </div>
          <div class="wiz-foot">
            <button class="btn btn-primary" :disabled="!imageFormValid || imageSaving" @click="saveImage">{{ imageSaving ? '保存中…' : '保存' }}</button>
            <button class="btn btn-ghost" @click="closeImageForm()">取消</button>
          </div>
        </div>
      </div>

      <!-- 定时自动化（backlog ②）：规则到点 → 以用户身份给 agent 发消息（走既有审批管线）——
           说明收进 ⓘ；列表 + 模态（cron 即时预览下次触发——防写错） -->
      <div class="set-sec-row">
        <div class="set-sec">自动化</div>
        <HelpTip
          text="定时规则到点后，以你的身份给指定 agent 发一条委托消息——排队、审批、执行与手动发消息完全一致（零旁路）。cron 为五段「分 时 日 月 周」（本机时区）；应用未运行期间错过的不补跑；规则上限 16 条。"
        />
        <button class="btn btn-secondary btn-sm" style="margin-left: auto" @click="openAutomation(null)">＋ 新建</button>
      </div>
      <div v-for="a in kernel.automations" :key="a.id" class="setrow">
        <div class="set-main">
          <div class="set-name">{{ a.name }} <span class="mono automation-cron">{{ a.cron }}</span></div>
          <div class="set-desc">
            → {{ agentNameOf(a.agentId) }} · 下次 {{ a.enabled ? (a.nextAt === null ? '永不触发' : fmtNext(a.nextAt)) : '已停用' }}
            <template v-if="a.lastRunAt !== undefined"> · 上次 {{ fmtNext(a.lastRunAt) }}</template>
          </div>
        </div>
        <button
          class="switch"
          :class="{ 'is-on': a.enabled }"
          role="switch"
          :aria-checked="a.enabled"
          :aria-label="`${a.name} 启停`"
          @click="toggleAutomation(a)"
        ></button>
        <button class="btn btn-ghost btn-sm" @click="openAutomation(a)">编辑</button>
        <button class="btn btn-ghost btn-sm btn-danger" @click="removeAutomationRow(a)">删除</button>
      </div>
      <p v-if="kernel.automations.length === 0" class="settings-empty">还没有自动化规则——到点让 agent 干活（如每天 9 点汇总）。</p>

      <!-- 权限策略（呈现现状，不放假开关）——说明收进 ⓘ（0.1.2 改版） -->
      <div class="set-sec-row">
        <div class="set-sec">权限策略</div>
        <HelpTip
          text="当前为手工审批闸门（Manual）：agent 在 Box 内自由执行；触碰宿主机文件或出网时在对话流内逐条请求批准，挂起期间 run 计入 deadline。进程崩溃重启后未决审批自动重发（账本持久真相）。策略分级开关属后续版本。"
        />
      </div>

      <!-- 数据（P4 Step 11，裁定 E 一期只读：路径展示 + 打开文件夹；导出/清空属后续版本） -->
      <div class="set-sec-row">
        <div class="set-sec">数据</div>
        <HelpTip
          text="对话与执行记录以 JSONL 追加落盘（append-only——只增不改，永不就地改写历史）；全部数据只在本机，不上传。导出全部 / 清空 transcript 属后续版本。"
        />
      </div>
      <template v-if="dataPaths">
        <div class="kv"><span class="k">数据目录</span><span class="v mono kv-path">{{ dataPaths.data }}</span></div>
        <div class="kv"><span class="k">transcript</span><span class="v mono kv-path">{{ dataPaths.transcript }}</span></div>
        <div class="form-actions">
          <button class="btn btn-secondary btn-sm" @click="openFolder(dataPaths.userData)">打开数据文件夹</button>
        </div>
      </template>
      <p v-else class="settings-empty">开发模式（无壳）——数据路径由桌面壳提供</p>

      <!-- 通用（0.1.0 产品化）：系统自启动——注册表现状即真相，开关即时生效 -->
      <div class="set-sec">通用</div>
      <div class="setrow">
        <div class="set-main">
          <div class="set-name">开机自启动</div>
          <div class="set-desc">系统登录时自动启动并驻留托盘（注册表 Run 键——在系统侧手动改动此处如实反映）</div>
        </div>
        <button
          class="switch"
          :class="{ 'is-on': autoLaunch }"
          role="switch"
          :aria-checked="autoLaunch"
          aria-label="开机自启动"
          @click="toggleAutoLaunch"
        ></button>
      </div>

      <!-- 外观（呈现层偏好，即时生效）——说明收进 ⓘ（0.1.2 改版）；主题选项同步列表化 -->
      <div class="set-sec-row">
        <div class="set-sec">外观</div>
        <HelpTip
          text="日间/夜间主题即时生效，「跟随系统」随 Windows 主题自动切换；标题栏的太阳/月亮按钮可随时快捷切换。此偏好只存本机（浏览器存储），不进内核设置。"
        />
      </div>
      <div class="sandbox-list">
        <label
          v-for="opt in THEME_OPTIONS"
          :key="opt.value"
          class="sandbox-row"
          :class="{ 'is-on': ui.theme === opt.value }"
        >
          <input type="radio" name="theme-pref" class="sandbox-pref-radio" :value="opt.value" v-model="themeChoice" />
          <span class="sandbox-row-label">{{ opt.label }}</span>
          <span class="sandbox-row-note">{{ opt.note }}</span>
        </label>
      </div>

      <!-- 自动化模态（新建/编辑共用；cron 即时预览下次触发） -->
      <div v-if="automationModal" class="wiz-overlay" @mousedown.self="automationModal = false">
        <div class="wiz-card" role="dialog" aria-label="自动化规则" @keydown.escape="automationModal = false">
          <div class="wiz-head">
            <span class="wiz-title">{{ editingAutomation === null ? '新建自动化' : '编辑自动化' }}</span>
            <button class="wiz-close" type="button" aria-label="关闭" @click="automationModal = false">✕</button>
          </div>
          <div class="wiz-body relay-form">
            <label class="relay-field">
              <span class="field-label">规则名</span>
              <input v-model="aForm.name" class="field-input" placeholder="例：每日早报" maxlength="32" />
            </label>
            <label class="relay-field">
              <span class="field-label">cron（分 时 日 月 周——例：0 9 * * * 每天 9 点；*/15 * * * 1-5 工作日每 15 分钟）</span>
              <input v-model="aForm.cron" class="field-input mono" placeholder="0 9 * * *" spellcheck="false" @keydown.enter.prevent />
            </label>
            <p v-if="cronPreview !== null" class="cron-preview mono">下次触发：{{ cronPreview }}</p>
            <label class="relay-field">
              <span class="field-label">目标 agent</span>
              <select v-model="aForm.agentId" class="field-input">
                <option v-for="a in kernel.roster" :key="a.agentId" :value="a.agentId">{{ a.name ?? a.agentId }}（{{ a.role }}）</option>
              </select>
            </label>
            <label class="relay-field">
              <span class="field-label">委托文本（到点后作为你的消息发给它）</span>
              <textarea v-model="aForm.prompt" class="field-input" rows="3" maxlength="2000" placeholder="例：汇总昨天的任务与产物，简要汇报"></textarea>
            </label>
            <label class="relay-toggle">
              <input type="checkbox" v-model="aForm.enabled" />
              <span>启用该规则</span>
            </label>
            <p v-if="automationError" class="form-error">{{ automationError }}</p>
          </div>
          <div class="wiz-foot">
            <button class="btn btn-primary" :disabled="!automationValid || automationSaving" @click="saveAutomation">
              {{ automationSaving ? '保存中…' : '保存' }}
            </button>
            <button class="btn btn-ghost" @click="automationModal = false">取消</button>
          </div>
        </div>
      </div>

      <!-- 关于 -->
      <div class="set-sec">关于</div>
      <div class="kv"><span class="k">版本</span><span class="v mono">{{ appVersion ? `v${appVersion}` : '开发模式（无壳）' }}</span></div>
      <div class="kv"><span class="k">许可</span><span class="v">Apache-2.0 · 净室自研</span></div>
    </div>
  </section>
</template>

<style scoped src="./settings.css"></style>
