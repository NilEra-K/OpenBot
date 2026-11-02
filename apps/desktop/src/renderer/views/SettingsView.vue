<script setup lang="ts">
/**
 * 设置视图（prototype.html 迁移，P2 范围 + P3 Step 5 沙箱选择）：
 * - LLM 推理：provider 档案 CRUD（真实命令面；key 密文经 safeStorage 落盘，跨边界无 key 材料——
 *   编辑时留空即保留原密文）；设为主力对管家与全部 agent 下轮生效。
 * - 沙箱后端：装配事实（当前后端/降级原因/CLI 探测）+ 偏好选择（写 settings，重启生效——
 *   后端选择是装配期决策不热切换）。docker/podman 未实现前只读呈现（不放假选项）。
 * - 权限策略：呈现 Manual 审批闸门现状——不放假开关（内核无对应存储）。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import jsQR from 'jsqr'
import { useKernelStore } from '../stores/kernel'
import type { ProviderView, SandboxPref } from '../stores/kernel'
import HelpTip from '../components/HelpTip.vue'
import NumStepper from '../components/NumStepper.vue'
import TimePicker from '../components/TimePicker.vue'
import { cronOfForm, formOfCron, DEFAULT_CRON_FORM, CRON_PRESETS } from '../lib/cron-form'
import type { CronFormState, CronFreq } from '../lib/cron-form'
import { useUiStore } from '../stores/ui'
import type { ThemePref } from '../stores/ui'
import { useToastStore } from '../stores/toast'

const kernel = useKernelStore()
const ui = useUiStore()
const toast = useToastStore()

// ---- 定时自动化（backlog ②）：列表态挂 store；模态新建/编辑（表单生成 cron + 即时预览） ----
const automationModal = ref(false)
/** 编辑目标（null=新建） */
const editingAutomation = ref<string | null>(null)
const automationSaving = ref(false)
const automationError = ref<string | null>(null)
const cronPreview = ref<{ readable: string; upcomingAt: number[] } | null>(null)
/* 预览加载态（v0.1.111 报障修复）：值变更期间骨架 shimmer 占行——容器恒高，
 * 模态 place-items:center 布局不再因预览行消失/出现而整体跳动（原 null 置空 = 抽搐根因） */
const cronPreviewLoading = ref(false)
const aForm = reactive({ name: '', cron: '', agentId: '', prompt: '', enabled: true })

// 触发时间表单生成器（2026-10-28 v0.1.96 用户报障「cron 对用户太困难」）：表单态单向生成
// cron 写入 aForm.cron——落盘/解析零变化（内核仍是权威）；编辑既有规则经 formOfCron 回填，
// 反解析不了的复杂表达式落在「高级」档原文展示（诚实降级——lib/cron-form.ts 纯函数可测）
const cronForm = reactive<CronFormState>({ ...DEFAULT_CRON_FORM })
/** 频率分段控件（v0.1.96 二轮打磨：下拉+行文式内联 → 分段+分行字段——层次清晰不折行） */
const FREQ_SEGMENTS: Array<{ v: CronFreq; label: string }> = [
  { v: 'daily', label: '每天' },
  { v: 'weekly', label: '每周' },
  { v: 'monthly', label: '每月' },
  { v: 'minutes', label: '按分钟' },
  { v: 'hours', label: '按小时' },
  { v: 'custom', label: '高级' },
]
/** 预设选中反馈：当前表单态与某预设产物一致时高亮（改字段即取消——如实反映） */
const activePreset = computed(
  () =>
    CRON_PRESETS.find((p) => cronForm.freq === p.form.freq && cronOfForm({ ...DEFAULT_CRON_FORM, ...p.form }) === aForm.cron)?.label ?? null,
)
const WEEKDAYS: Array<{ v: number; label: string }> = [
  { v: 1, label: '一' }, { v: 2, label: '二' }, { v: 3, label: '三' }, { v: 4, label: '四' },
  { v: 5, label: '五' }, { v: 6, label: '六' }, { v: 0, label: '日' },
]
/** 时刻输入（time input 'HH:MM' ↔ atHour/atMinute 拆装——daily/weekly/monthly 档共用） */
const dailyTime = computed({
  get: () => `${String(cronForm.atHour).padStart(2, '0')}:${String(cronForm.atMinute).padStart(2, '0')}`,
  set: (v: string) => {
    const [h, m] = v.split(':')
    if (h !== undefined) cronForm.atHour = Number.parseInt(h, 10) || 0
    if (m !== undefined) cronForm.atMinute = Number.parseInt(m, 10) || 0
  },
})
const toggleWeekday = (v: number): void => {
  cronForm.weekdays = cronForm.weekdays.includes(v)
    ? cronForm.weekdays.filter((d) => d !== v)
    : [...cronForm.weekdays, v].sort((a, b) => a - b)
}

/** 频率换档柔和过渡（v0.1.96 四轮：用户反馈「变化生硬」）——容器高度从旧值动画到新值
 *  （height:auto 无法 transition：钉旧高 → 量新高 → 过渡 → 计时回 auto），内容同步淡入；
 *  pre-flush 观察器在 DOM 更新前量得旧高，nextTick 后换档内容已就位 */
const cronFieldsEl = ref<HTMLElement | null>(null)
let cronHResetTimer: ReturnType<typeof setTimeout> | null = null
watch(
  () => cronForm.freq,
  () => {
    const el = cronFieldsEl.value
    if (el === null) return
    const h0 = el.offsetHeight
    el.style.opacity = '0.55'
    void nextTick(() => {
      el.style.height = `${h0}px`
      void el.offsetHeight // 强制回流——起始高先生效再过渡
      el.style.height = `${el.scrollHeight}px`
      el.style.opacity = '1'
      if (cronHResetTimer !== null) clearTimeout(cronHResetTimer)
      cronHResetTimer = setTimeout(() => {
        el.style.height = 'auto' // 回自适应（后续布局变化不受钉死影响）
      }, 240)
    })
  },
)
/** 预设点击填**表单态**（重置默认再覆盖——后续仍可改字段微调） */
const applyPreset = (p: { label: string; form: Partial<CronFormState> }): void => {
  Object.assign(cronForm, DEFAULT_CRON_FORM, p.form)
}
watch(
  cronForm,
  (f) => {
    if (f.freq !== 'custom') aForm.cron = cronOfForm(f)
  },
  { deep: true },
)

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
  cronPreviewLoading.value = false
  editingAutomation.value = row?.id ?? null
  if (row !== null) {
    Object.assign(aForm, { name: row.name, cron: row.cron, agentId: row.agentId, prompt: row.prompt, enabled: row.enabled })
    Object.assign(cronForm, formOfCron(row.cron))
  } else {
    Object.assign(aForm, { name: '', cron: cronOfForm(DEFAULT_CRON_FORM), agentId: kernel.stewardId ?? '', prompt: '', enabled: true })
    Object.assign(cronForm, DEFAULT_CRON_FORM)
  }
}

/** cron 即时预览（防抖 400ms——解析在内核 v1.automations.preview；含随后 3 次时刻）。
 *  变更即刻入 loading（骨架占行保高度），落定回填后退场；失败兜底出骨架防永闪 */
let cronPreviewTimer: ReturnType<typeof setTimeout> | null = null
watch(
  () => aForm.cron,
  (cron) => {
    if (cronPreviewTimer !== null) clearTimeout(cronPreviewTimer)
    if (cron.trim() === '') {
      cronPreview.value = null
      cronPreviewLoading.value = false
      return
    }
    cronPreviewLoading.value = true
    cronPreviewTimer = setTimeout(() => {
      void kernel
        .previewCron(cron.trim())
        .then((r) => {
          cronPreview.value = { readable: r.readable, upcomingAt: r.upcomingAt }
          cronPreviewLoading.value = false
        })
        .catch(() => {
          cronPreview.value = null
          cronPreviewLoading.value = false
        })
    }, 400)
  },
)

const automationValid = computed(
  () =>
    aForm.name.trim() !== '' &&
    aForm.cron.trim() !== '' &&
    aForm.agentId !== '' &&
    aForm.prompt.trim() !== '' &&
    (cronForm.freq !== 'weekly' || cronForm.weekdays.length > 0), // 周档须选至少一天（生成器空选集会落成每天）
)

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

// ---- 设置分类导航（切换式，2026-09-13 UI 优化，对照用户图例）：左侧组标+图标条目，右侧仅渲染当前分节（v-show 保表单态） ----
type SettingsSectionId = 'llm' | 'runtime' | 'automation' | 'policy' | 'data' | 'general' | 'appearance' | 'debug' | 'about'
const activeSection = ref<SettingsSectionId>('llm')
const ICON = (paths: string): string =>
  // width/height 内联属性（v0.1.55b 用户裁定 14px）——scoped CSS 对 v-html 插入内容不生效（无 data-v），尺寸须内联
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' + paths + '</svg>'
const SETTINGS_GROUPS: Array<{ label: string; items: Array<{ id: SettingsSectionId; label: string; icon: string }> }> = [
  {
    label: '智能与应用',
    items: [
      { id: 'llm', label: '模型设置', icon: ICON('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>') },
      { id: 'automation', label: '自动化', icon: ICON('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/>') },
    ],
  },
  {
    label: '执行环境',
    items: [
      { id: 'runtime', label: '容器与镜像', icon: ICON('<path d="M12 2l10 5-10 5L2 7z"/><path d="M2 12l10 5 10-5"/><path d="M2 17l10 5 10-5"/>') },
    ],
  },
  {
    label: '权限与数据',
    items: [
      { id: 'policy', label: '权限策略', icon: ICON('<path d="M12 2l8 4v6c0 5-3.5 8.5-8 10-4.5-1.5-8-5-8-10V6z"/>') },
      { id: 'data', label: '数据', icon: ICON('<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.7 4 3 9 3s9-1.3 9-3V5"/><path d="M3 12c0 1.7 4 3 9 3s9-1.3 9-3"/>') },
    ],
  },
  {
    label: '通用',
    items: [
      { id: 'general', label: '通用', icon: ICON('<path d="M4 21v-7"/><path d="M4 10V3"/><path d="M12 21v-9"/><path d="M12 8V3"/><path d="M20 21v-5"/><path d="M20 12V3"/><path d="M1 14h6"/><path d="M9 8h6"/><path d="M17 16h7"/>') },
      { id: 'appearance', label: '外观', icon: ICON('<path d="M12 2a10 10 0 0 0 0 20c1.1 0 2-.9 2-2v-1c0-1.7 1.3-3 3-3h2a4 4 0 0 0 4-4c0-5.5-4.9-10-11-10z"/><circle cx="7.5" cy="10.5" r="1"/><circle cx="12" cy="7.5" r="1"/><circle cx="16.5" cy="10.5" r="1"/>') },
      { id: 'debug', label: '调试信息', icon: ICON('<path d="M4 17l6-6-6-6"/><path d="M12 19h8"/>') },
      { id: 'about', label: '关于', icon: ICON('<circle cx="12" cy="12" r="9"/><path d="M12 8h.01"/><path d="M12 12v4"/>') },
    ],
  },
]

// ---- 镜像注册表（plan-image-firstclass P8-3）：条目清单 + 载体分表单模态 + 连接测试 ----
const imageFormOpen = ref(false)
const imageEditingId = ref<string | null>(null)
type ImageFormCarrier = 'container' | 'ssh' | 'host-screen' | 'windows' | 'android'
type ImageFormProtocol = 'x11' | 'none' | 'host' | 'win' | 'android'
const imageForm = reactive<{
  name: string
  carrier: ImageFormCarrier
  image: string
  host: string
  port: number | null
  user: string
  keyPath: string
  controlProtocol: ImageFormProtocol
  display: string
  windowTitle: string
  runtime: 'docker' | 'podman' | ''
}>({ name: '', carrier: 'ssh', image: '', host: '', port: null, user: '', keyPath: '', controlProtocol: 'x11', display: '', windowTitle: '', runtime: '' })
/** 窗口绑定（P9-2）：顶层窗口清单（⟳ 枚举按钮按需拉取）+ 枚举中态 */
const hostWindows = ref<Array<{ title: string; width: number; height: number }>>([])
const hostWindowsLoading = ref(false)
/** Android 设备发现与配对（P9-3c）：智能恢复优先——扫描在场设备（点选零输入）/ 配对向导（扫码主 + 手动兜底） */
const adbDevices = ref<Array<{ serial: string; state: string; product: string; model: string }>>([])
const adbScanning = ref(false)
const scanAdbDevices = async (): Promise<void> => {
  adbScanning.value = true
  try {
    adbDevices.value = await kernel.scanAdbDevices()
  } catch (err) {
    toast.push(err instanceof Error ? err.message : String(err), 'danger')
  } finally {
    adbScanning.value = false
  }
}
/** 配对模态：扫码（摄像头 + jsQR 帧解码）主模式 / 手动（ip:配对端口 + 码）兜底 */
const adbPairOpen = ref(false)
const adbPairTab = ref<'scan' | 'manual'>('scan')
const adbPairTarget = ref('')
const adbPairCode = ref('')
const adbPairBusy = ref(false)
const adbPairError = ref<string | null>(null)
/** 扫码状态：'idle' 无流 / 'scanning' 解码中 / 'denied' 摄像头不可用（如实 + 引导手动） */
const adbScanCam = ref<'idle' | 'scanning' | 'denied'>('idle')
const adbVideoEl = ref<HTMLVideoElement | null>(null)
let adbScanTimer: ReturnType<typeof setInterval> | null = null
let adbStream: MediaStream | null = null

const openAdbPair = (): void => {
  adbPairOpen.value = true
  adbPairTab.value = 'scan'
  adbPairTarget.value = ''
  adbPairCode.value = ''
  adbPairError.value = null
}

const stopAdbScanCam = (): void => {
  if (adbScanTimer !== null) {
    clearInterval(adbScanTimer)
    adbScanTimer = null
  }
  adbStream?.getTracks().forEach((t) => t.stop())
  adbStream = null
  adbScanCam.value = 'idle'
}

const startAdbScanCam = async (): Promise<void> => {
  try {
    adbStream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 } })
  } catch {
    adbScanCam.value = 'denied'
    return
  }
  // 挂流到 video（模态内 ref）+ 定时帧解码（jsQR——WIFI:S:服务名;P:码;; 命中即回填）
  const video = adbVideoEl.value
  if (video !== null) {
    video.srcObject = adbStream
    await video.play().catch(() => {})
  }
  adbScanCam.value = 'scanning'
  adbScanTimer = setInterval(() => {
    const video = adbVideoEl.value
    if (video === null || video.videoWidth === 0) return
    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (ctx === null) return
    ctx.drawImage(video, 0, 0)
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height)
    const hit = jsQR(img.data, img.width, img.height)
    if (hit !== null && /^WIFI:S:[^;]+;P:[^;]+;;$/.test(hit.data.trim())) {
      adbPairTarget.value = /^WIFI:S:([^;]+);P:([^;]+);;$/.exec(hit.data.trim())?.[1] ?? ''
      adbPairCode.value = /^WIFI:S:([^;]+);P:([^;]+);;$/.exec(hit.data.trim())?.[2] ?? ''
      toast.push('已识别配对码——确认配对', 'success')
      stopAdbScanCam()
    }
  }, 300)
}

const submitAdbPair = async (): Promise<void> => {
  if (adbPairBusy.value || adbPairTarget.value.trim() === '' || adbPairCode.value.trim() === '') return
  adbPairBusy.value = true
  adbPairError.value = null
  try {
    await kernel.adbPair(adbPairTarget.value.trim(), adbPairCode.value.trim())
    toast.push('配对成功——等待设备出现在扫描列表（约 2 秒）', 'success')
    adbPairOpen.value = false
    stopAdbScanCam()
    // mDNS 广播需要一点时间：延迟重扫，自动回填 host（零输入闭环）
    setTimeout(() => {
      void scanAdbDevices()
    }, 2_000)
  } catch (err) {
    adbPairError.value = err instanceof Error ? err.message : String(err)
  } finally {
    adbPairBusy.value = false
  }
}

const closeAdbPair = (): void => {
  adbPairOpen.value = false
  stopAdbScanCam()
}

onBeforeUnmount(stopAdbScanCam)

const enumHostWindows = async (): Promise<void> => {
  hostWindowsLoading.value = true
  try {
    hostWindows.value = await kernel.listHostWindows()
  } catch (err) {
    toast.push(err instanceof Error ? err.message : String(err), 'danger')
  } finally {
    hostWindowsLoading.value = false
  }
}
/** 载体切换联动（P9-1/P9-3a）：host-screen 协议恒 host；windows 缺省 win；切回他载体回落 x11。
 *  watch 源必须是 getter（reactive 属性直传是值——P9-3a E2E 首训实锤：联动静默失效） */
watch(
  () => imageForm.carrier,
  (c) => {
    if (c === 'host-screen') imageForm.controlProtocol = 'host'
    else if (c === 'windows' && imageForm.controlProtocol !== 'none') imageForm.controlProtocol = 'win'
  else if (c === 'android' && imageForm.controlProtocol !== 'none') imageForm.controlProtocol = 'android'
    else if (
    imageForm.controlProtocol === 'host' ||
    imageForm.controlProtocol === 'win' ||
    imageForm.controlProtocol === 'android'
  )
    imageForm.controlProtocol = 'x11'
  },
)
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
  windowTitle: '',
  runtime: '' as const,
}

const openImageCreate = (): void => {
  imageEditingId.value = null
  Object.assign(imageForm, IMAGE_EMPTY_FORM)
  // 容器运行时预选（v0.1.53 显式声明）：探测到的第一个可用项（docker 优先）——用户可改
  const probe = kernel.sandbox?.probes ?? []
  imageForm.runtime = probe.find((x) => x.id === 'docker')?.available
    ? 'docker'
    : probe.find((x) => x.id === 'podman')?.available
      ? 'podman'
      : ''
  imageFormError.value = null
  imageFormOpen.value = true
}

const openImageEdit = (img: { id: string; name: string; carrier: ImageFormCarrier; image?: string; host?: string; port?: number; user?: string; keyPath?: string; controlProtocol: ImageFormProtocol; display?: string; windowTitle?: string }): void => {
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
    windowTitle: img.windowTitle ?? '',
    runtime: img.runtime ?? '',
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
  if (imageForm.carrier === 'host-screen') return true // 零连接事实（本机主屏）
  if (imageForm.carrier === 'container') return imageForm.image.trim() !== ''
  return imageForm.host.trim() !== '' // ssh / windows 同形连接事实
})

const saveImage = async (): Promise<void> => {
  if (!imageFormValid.value || imageSaving.value) return
  imageSaving.value = true
  imageFormError.value = null
  const payload = {
    name: imageForm.name.trim(),
    carrier: imageForm.carrier,
    controlProtocol:
      imageForm.carrier === 'host-screen'
        ? ('host' as const)
        : imageForm.carrier === 'windows' && imageForm.controlProtocol !== 'none'
          ? ('win' as const)
          : imageForm.carrier === 'android' && imageForm.controlProtocol !== 'none'
            ? ('android' as const)
            : imageForm.controlProtocol,
    ...(imageForm.carrier === 'host-screen' && imageForm.windowTitle.trim() !== '' ? { windowTitle: imageForm.windowTitle.trim() } : {}),
    ...(imageForm.carrier === 'host-screen'
      ? {}
      : imageForm.carrier === 'container'
        ? { image: imageForm.image.trim(), ...(imageForm.runtime !== '' ? { runtime: imageForm.runtime } : {}) }
        : {
            host: imageForm.host.trim(),
            ...(imageForm.port !== null && Number.isFinite(imageForm.port) ? { port: Number(imageForm.port) } : {}),
            ...(imageForm.user.trim() !== '' ? { user: imageForm.user.trim() } : {}),
            ...(imageForm.keyPath.trim() !== '' ? { keyPath: imageForm.keyPath.trim() } : {}),
          }),
    ...(imageForm.carrier === 'ssh' && imageForm.display.trim() !== '' ? { display: imageForm.display.trim() } : {}),
  }
  // 编辑前的连接事实（v0.1.40 UX：变更后已绑定 agent 的 Box 不热迁移——保存时提示重启）
  const before = imageEditingId.value !== null ? kernel.images.find((e) => e.id === imageEditingId.value) ?? null : null
  try {
    if (imageEditingId.value !== null) await kernel.updateImage(imageEditingId.value, payload)
    else await kernel.addImage(payload)
    toast.push(imageEditingId.value !== null ? '镜像条目已更新' : '镜像条目已添加', 'success')
    if (
      before !== null &&
      (before.host ?? '') !== (payload.host ?? '') &&
      (before.carrier === 'android' || before.carrier === 'windows' || before.carrier === 'ssh')
    ) {
      toast.push('连接地址已变更——已绑定该镜像的 Agent 须重启应用后生效（新建 Agent 即时用新地址）', 'info')
    }
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
    toast.push(err instanceof Error ? err.message : String(err), 'danger')
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

const carrierLabel = (c: 'container' | 'ssh' | 'host-screen' | 'windows' | 'android'): string =>
  c === 'ssh'
    ? 'SSH'
    : c === 'host-screen'
      ? '宿主屏幕'
      : c === 'windows'
        ? 'Windows'
        : c === 'android'
          ? 'Android'
          : '容器'
const imageSummary = (img: { carrier: 'container' | 'ssh' | 'host-screen' | 'windows' | 'android'; image?: string; host?: string; port?: number; user?: string; keyPath?: string; windowTitle?: string }): string => {
  if (img.carrier === 'host-screen') {
    return img.windowTitle !== undefined ? `窗口「${img.windowTitle}」（内置注入）` : '本机主屏（内置注入）'
  }
  if (img.carrier === 'container') return img.image ?? ''
  let out = ''
  if (img.user) out += img.user + '@'
  out += img.host ?? ''
  if (img.port) out += ':' + String(img.port)
  if (img.keyPath) out += ' · key ' + img.keyPath
  return out
}

// ---- 可用镜像探测（2026-09-14）：环境在场镜像清单 + 一键带入注册表（预填模态，用户把关后入库） ----
/** 来源显示名（wsl-docker = WSL 默认发行版内独立安装的 docker，与 Docker Desktop 不同 daemon） */
const SOURCE_LABELS: Record<string, string> = {
  docker: 'Docker',
  podman: 'Podman',
  'wsl-docker': 'WSL 发行版内 Docker',
}
const scanAvailableImages = async (): Promise<void> => {
  try {
    await kernel.scanImages()
  } catch (err) {
    toast.push(err instanceof Error ? err.message : String(err), 'danger')
  }
}
/** 该镜像引用是否已在注册表（已注册的扫描行不再给注册按钮——不重复入库） */
const isImageRegistered = (ref: string): boolean => kernel.images.some((e) => e.carrier === 'container' && e.image === ref)
/** 扫描结果的镜像行扁平化（来源随行呈现；不可用来源无行——原因在来源行） */
const scannedImageRows = computed(() => {
  const out: Array<{ source: string; ref: string; size?: string; created?: string }> = []
  for (const src of kernel.imageScan ?? []) {
    if (!src.ok) continue
    for (const im of src.images ?? []) {
      out.push({ source: src.source, ref: im.ref, ...(im.size !== undefined ? { size: im.size } : {}), ...(im.created !== undefined ? { created: im.created } : {}) })
    }
  }
  return out
})
/** 扫描行「注册」：打开既有添加模态并预填（载体=容器；GUI 命名暗示预选 X11——最终以用户保存为准） */
const registerScanned = (ref: string): void => {
  imageEditingId.value = null
  Object.assign(imageForm, IMAGE_EMPTY_FORM, {
    carrier: 'container' as const,
    name: ref,
    image: ref,
    controlProtocol: /gui/i.test(ref) ? ('x11' as const) : ('none' as const),
  })
  imageFormError.value = null
  imageFormOpen.value = true
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

// ---- 执行预算（2026-11-02 三段值域定稿）：-1 = 无限制 / 0 = 禁用工具（仅轮数）/ 1~上限。
//      草稿 + 显式保存；NumStepper 三段交互已在组件内归一（顶格＋/越界手输 → -1），此处
//      再 clamp 兜底（组件手输清空不回写——NaN 回旧值同 cron 范式）
const maxRoundsDraft = ref(kernel.maxToolRounds)
watch(() => kernel.maxToolRounds, (v) => (maxRoundsDraft.value = v))
const normalizeRounds = (raw: number): number => {
  const n = Math.round(raw)
  if (!Number.isFinite(n)) return kernel.maxToolRounds // 清空/乱——保持已存值
  if (n < 0) return 0
  return n > 1024 ? -1 : n
}
const saveMaxRounds = async (): Promise<void> => {
  const rounds = normalizeRounds(maxRoundsDraft.value)
  try {
    await kernel.setMaxToolRounds(rounds)
    maxRoundsDraft.value = rounds
    const label = rounds === -1 ? '无限制' : rounds === 0 ? '禁用工具' : `${rounds} 轮`
    toast.push(`工具轮预算已设为 ${label}——新任务立即生效（进行中的任务保持原预算）`, 'success')
  } catch (err) {
    toast.push(err instanceof Error ? err.message : String(err), 'danger')
  }
}
const toggleSystemNotify = async (): Promise<void> => {
  try {
    await kernel.setSystemNotify(!kernel.systemNotify)
    toast.push(kernel.systemNotify ? '系统通知已开启——任务终态会提醒' : '系统通知已关闭', 'success')
  } catch (err) {
    toast.push(err instanceof Error ? err.message : String(err), 'danger')
  }
}
const deadlineDraft = ref(kernel.runDeadlineMin)
watch(() => kernel.runDeadlineMin, (v) => (deadlineDraft.value = v))
const normalizeDeadline = (raw: number): number => {
  const n = Math.round(raw)
  if (!Number.isFinite(n)) return kernel.runDeadlineMin
  return n < 1 || n > 1440 ? -1 : n // 0 与 1440+ 都是无限制（用户裁定）——归一哨兵
}
const saveDeadline = async (): Promise<void> => {
  const minutes = normalizeDeadline(deadlineDraft.value)
  try {
    await kernel.setRunDeadline(minutes)
    deadlineDraft.value = minutes
    toast.push(minutes === -1 ? '总时长上限已设为无限制——新任务立即生效' : `总时长上限已更新为 ${minutes} 分钟——新任务立即生效（进行中的任务保持原时长）`, 'success')
  } catch (err) {
    toast.push(err instanceof Error ? err.message : String(err), 'danger')
  }
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

// ---- provider 表单（右栏内联——v2 供应商 1:N 模型；v0.1.62 起编辑态可改名：renameFrom 语义，密文随档迁移） ----

interface ProviderFormModel {
  id: string
  /** 视觉（图像输入）声明——模型级（0.1.28 截图回喂格式语义随模型走） */
  supportsImages: boolean
}

/** 右栏模式：detail=供应商详情 / add=添加（内联表单）/ edit=编辑（内联表单） */
const pane = ref<'detail' | 'add' | 'edit'>('detail')
const form = reactive<{ name: string; baseUrl: string; apiKey: string; proxyUrl: string; protocol: 'openai-compat' | 'anthropic'; models: ProviderFormModel[] }>({
  name: '',
  baseUrl: '',
  apiKey: '',
  proxyUrl: '',
  protocol: 'openai-compat',
  models: [],
})
const saving = ref(false)
const formError = ref<string | null>(null)
/** 编辑态的原档案名（v0.1.62 改名）：保存时若 name 已变则以 renameFrom 告知内核迁移密文并级联引用 */
const editingName = ref<string | null>(null)
/** 删除二段确认（进行中的名字；再点确认，点其他名字/取消则复位） */
const confirmingRemove = ref<string | null>(null)

const formValid = computed(() => {
  if (form.name.trim() === '' || form.models.length === 0) return false
  try {
    new URL(form.baseUrl.trim())
    return true
  } catch {
    return false
  }
})

const resetForm = (): void => {
  Object.assign(form, { name: '', baseUrl: '', apiKey: '', proxyUrl: '', protocol: 'openai-compat', models: [] })
  formError.value = null
  modelTestResults.value = {}
  editingName.value = null
}

const openCreate = (): void => {
  resetForm()
  pane.value = 'add'
}

const openEdit = (p: ProviderView): void => {
  Object.assign(form, {
    name: p.name,
    baseUrl: p.baseUrl,
    apiKey: '', // 留空 = 保留原密文（服务端约定）
    proxyUrl: p.proxyUrl ?? '',
    protocol: p.protocol ?? 'openai-compat',
    models: p.models.map((m) => ({ id: m.id, supportsImages: m.supportsImages === true, context1M: m.context1M === true })),
  })
  formError.value = null
  modelTestResults.value = {}
  editingName.value = p.name
  pane.value = 'edit'
}

const closeForm = (): void => {
  pane.value = 'detail'
  confirmingRemove.value = null
}

// ---- 模型弹窗（添加/编辑模型行——图例交互）：模型 ID + 视觉声明，Enter/保存双确认 ----
const modelModal = reactive<{ open: boolean; editingId: string | null; provider: string | null; id: string; supportsImages: boolean; context1M: boolean }>({
  open: false,
  editingId: null,
  provider: null,
  id: '',
  supportsImages: false,
  context1M: false,
})
const modelModalValid = computed(() => {
  const id = modelModal.id.trim()
  if (id === '') return false
  const list = modelModal.provider !== null
    ? (kernel.providers.find((p) => p.name === modelModal.provider)?.models ?? [])
    : form.models
  return !list.some((m) => m.id === id && m.id !== modelModal.editingId)
})
const openModelModal = (editingId: string | null, provider: string | null): void => {
  if (provider !== null) {
    const m = kernel.providers.find((p) => p.name === provider)?.models.find((x) => x.id === editingId)
    if (m === undefined) return
    Object.assign(modelModal, { open: true, editingId, provider, id: m.id, supportsImages: m.supportsImages === true, context1M: m.context1M === true })
  } else if (editingId !== null) {
    const m = form.models.find((x) => x.id === editingId)
    if (m === undefined) return
    Object.assign(modelModal, { open: true, editingId, provider: null, id: m.id, supportsImages: m.supportsImages, context1M: m.context1M === true })
  } else {
    Object.assign(modelModal, { open: true, editingId: null, provider: null, id: '', supportsImages: false, context1M: false })
  }
}
const confirmModelModal = (): void => {
  const id = modelModal.id.trim()
  if (id === '' || !modelModalValid.value) return
  const supportsImages = modelModal.supportsImages
  const context1M = modelModal.context1M
  if (modelModal.provider !== null) {
    // 已存档供应商：改模型 = 档案全量重写（key 省略保留）
    const profile = kernel.providers.find((p) => p.name === modelModal.provider)
    if (profile === undefined) return
    const models = profile.models.map((m) => (m.id === modelModal.editingId ? { id, supportsImages, context1M } : { id: m.id, supportsImages: m.supportsImages === true, context1M: m.context1M === true }))
    if (modelModal.editingId === null && !models.some((m) => m.id === id)) models.push({ id, supportsImages, context1M })
    void kernel.upsertProvider({ name: profile.name, baseUrl: profile.baseUrl, models, protocol: profile.protocol }).then(() => {
      toast.push(`模型已保存：${profile.name} · ${id}`, 'success')
    }).catch((err: unknown) => {
      toast.push(err instanceof Error ? err.message : String(err), 'danger')
    })
  } else if (modelModal.editingId !== null) {
    const idx = form.models.findIndex((m) => m.id === modelModal.editingId)
    if (idx !== -1) form.models.splice(idx, 1, { id, supportsImages, context1M })
  } else {
    form.models.push({ id, supportsImages, context1M })
  }
  modelModal.open = false
}

const removeFormModel = (id: string): void => {
  form.models = form.models.filter((m) => m.id !== id)
}

/** 已存档供应商删除模型：档案全量重写；最后一个模型由内核拒绝（SETTINGS_PROVIDER_NO_MODEL 如实冒泡） */
const removeSavedModel = (p: ProviderView, id: string): void => {
  void kernel.upsertProvider({
    name: p.name,
    baseUrl: p.baseUrl,
    models: p.models.filter((m) => m.id !== id).map((m) => ({ id: m.id, supportsImages: m.supportsImages === true, context1M: m.context1M === true })),
    protocol: p.protocol,
  }).then(() => {
    toast.push(`模型已删除：${p.name} · ${id}`, 'info')
  }).catch((err: unknown) => {
    toast.push(err instanceof Error ? err.message : String(err), 'danger')
  })
}

// ---- 模型行「测试」图标：真实最小请求（存档走解密 key；表单草稿直传端点事实）——chip 如实呈现 ----
const modelTestResults = ref<Record<string, { ok: boolean; text: string }>>({})
const testModelRow = (key: string, input: { name?: string; model: string; baseUrl?: string; apiKey?: string; protocol?: 'openai-compat' | 'anthropic' }): void => {
  modelTestResults.value = { ...modelTestResults.value, [key]: { ok: true, text: '测试中…' } }
  void kernel.testModel(input).then((r) => {
    modelTestResults.value = {
      ...modelTestResults.value,
      [key]: r.ok ? { ok: true, text: r.detail ?? '可调用' } : { ok: false, text: r.reason ?? '不可用' },
    }
  })
}

const save = async (): Promise<void> => {
  if (!formValid.value || saving.value) return
  saving.value = true
  formError.value = null
  try {
    await kernel.upsertProvider({
      name: form.name.trim(),
      // 改名（v0.1.62）：编辑态名字变了 → 以原名寻旧档，密文随档迁移 + 默认/回退引用级联
      ...(editingName.value !== null && form.name.trim() !== editingName.value ? { renameFrom: editingName.value } : {}),
      baseUrl: form.baseUrl.trim(),
      models: form.models.map((m) => ({ id: m.id, ...(m.supportsImages ? { supportsImages: true } : {}) })),
      ...(form.apiKey.trim() !== '' ? { apiKey: form.apiKey.trim() } : {}),
      ...(form.proxyUrl.trim() !== '' ? { proxyUrl: form.proxyUrl.trim() } : {}),
      protocol: form.protocol,
    })
    selectedProvider.value = form.name.trim() // 新增/编辑后右栏落在该供应商（主从布局的落点语义）
    toast.push(`模型端点已保存：${form.name.trim()}`, 'success')
    pane.value = 'detail'
  } catch (err) {
    formError.value = err instanceof Error ? `${err.message}` : String(err)
  } finally {
    saving.value = false
  }
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

/** 协议段的 baseUrl 占位提示（两种协议的前缀习惯不同） */
const urlPlaceholder = computed(() =>
  form.protocol === 'anthropic' ? 'https://api.anthropic.com/v1' : 'https://api.deepseek.com/v1',
)

// ---- 供应商主从布局（UI 优化 2026-09-15，对照用户图例）：左列表选中项驱动右栏详情/内联表单 ----
/** 左栏选中项（供应商名——档案键）；被删/未匹配时由 selected 兜底回落，不另设 watcher */
const selectedProvider = ref<string | null>(null)
/** 右栏详情对象：显式选中 > 全场默认 > 首个；列表空 = null（空态引导） */
const selected = computed<ProviderView | null>(() => {
  const list = kernel.providers
  if (list.length === 0) return null
  return (
    list.find((p) => p.name === selectedProvider.value) ??
    list.find((p) => p.name === kernel.defaultProvider) ??
    list[0] ??
    null
  )
})
/** 选中供应商是否全场默认（默认模型按 defaultModel 粒度呈现） */
const isSelectedDefault = computed(() => selected.value !== null && selected.value.name === kernel.defaultProvider)
/** 某模型是否为当前全场默认（供应商 + 模型双匹配） */
const isDefaultPair = (providerName: string, modelId: string): boolean =>
  kernel.defaultProvider === providerName && (kernel.defaultModel === null || kernel.defaultModel === modelId)
/** 设某模型为全场默认（v2 粒度 = 供应商 + 模型） */
const makeDefault = (providerName: string, modelId: string): void => {
  void kernel.setDefaultProvider(providerName, modelId).then(() => {
    toast.push(`已设为默认模型：${providerName} · ${modelId}`, 'success')
  }).catch((err: unknown) => {
    toast.push(err instanceof Error ? err.message : String(err), 'danger')
  })
}
/** 详情态「当前默认」kv 呈现：供应商 · 模型（无模型 id 时只呈现供应商名） */
const defaultDisplay = computed(() =>
  kernel.defaultProvider === null
    ? '未设置（对话将失败）'
    : `${kernel.defaultProvider}${kernel.defaultModel ? ' · ' + kernel.defaultModel : ''}`,
)

/** 拖拽排序（左栏供应商列表）：dropOn 把被拖项插入目标位置（全量重排落库） */
const dragName = ref<string | null>(null)
const dropOn = (target: string): void => {
  const from = dragName.value
  dragName.value = null
  if (from === null || from === target) return
  const names = kernel.providers.map((p) => p.name)
  const fromIdx = names.indexOf(from)
  const toIdx = names.indexOf(target)
  if (fromIdx === -1 || toIdx === -1) return
  names.splice(toIdx, 0, names.splice(fromIdx, 1)[0] ?? names[toIdx]!)
  void kernel.reorderProviders(names).catch((err: unknown) => {
    toast.push(err instanceof Error ? err.message : String(err), 'danger')
  })
}

// ---- 数据区块（P4 Step 11，裁定 E 一期只读：路径展示 + 打开文件夹） ----

const dataPaths = ref<{ userData: string; data: string; transcript: string; transcriptRoot: string | null } | null>(null)
onMounted(() => {
  void window.openbot?.app
    ?.paths()
    .then((p: { userData: string; data: string; transcript: string; transcriptRoot: string | null }) => (dataPaths.value = p))
    .catch(() => (dataPaths.value = null)) // 桥缺失（浏览器 dev）——如实降级
})

// ---- 数据目录设置（UI 优化 0.1.26，用户需求）：标记文件重启生效，旧数据不自动迁移 ----
const dataRootOpen = ref(false)
const dataRootDraft = ref('')
const dataRootError = ref<string | null>(null)
const dataRootSaving = ref(false)

const openDataRoot = (): void => {
  dataRootDraft.value = dataPaths.value?.data ?? ''
  dataRootError.value = null
  dataRootOpen.value = true
}

const saveDataRoot = async (path: string | null = dataRootDraft.value.trim()): Promise<void> => {
  if (dataRootSaving.value) return
  dataRootSaving.value = true
  dataRootError.value = null
  try {
    const r = await kernel.setDataRoot(path)
    const movedNote = r.moved > 0 ? `已自动迁移 ${r.moved} 个文件，` : ''
    toast.push(`${movedNote}${path === null ? '数据目录已恢复默认' : '数据目录已更新'}——重启应用后生效`, 'success')
    dataRootOpen.value = false
  } catch (err) {
    dataRootError.value = err instanceof Error ? err.message : String(err)
  } finally {
    dataRootSaving.value = false
  }
}

const saveDataRootDefault = (): void => {
  void saveDataRoot(null)
}

// ---- 会话记录目录独立设置（v0.1.63，用户需求）：transcript-root.txt 标记重启生效，旧记录不自动迁移 ----
const transcriptRootOpen = ref(false)
const transcriptRootDraft = ref('')
const transcriptRootError = ref<string | null>(null)
const transcriptRootSaving = ref(false)

const openTranscriptRoot = (): void => {
  // 预填标记原值（transcriptRoot 为 null = 未自定义、随数据目录——预填空让 placeholder 引导）
  transcriptRootDraft.value = dataPaths.value?.transcriptRoot ?? ''
  transcriptRootError.value = null
  transcriptRootOpen.value = true
}

const saveTranscriptRoot = async (path: string | null = transcriptRootDraft.value.trim()): Promise<void> => {
  if (transcriptRootSaving.value) return
  transcriptRootSaving.value = true
  transcriptRootError.value = null
  try {
    const r = await kernel.setTranscriptRoot(path)
    const movedNote = r.moved > 0 ? `已自动迁移 ${r.moved} 个 Agent 的会话记录，` : ''
    toast.push(`${movedNote}${path === null ? '会话记录已回到数据目录内' : '会话记录目录已更新'}——重启应用后生效`, 'success')
    transcriptRootOpen.value = false
  } catch (err) {
    transcriptRootError.value = err instanceof Error ? err.message : String(err)
  } finally {
    transcriptRootSaving.value = false
  }
}

const saveTranscriptRootDefault = (): void => {
  void saveTranscriptRoot(null)
}

/** 系统对话框选目录（v0.1.63，用户需求）：回填到对应草稿（取消/无壳不动） */
const browseDirectory = async (draft: 'data' | 'transcript'): Promise<void> => {
  const picked = await window.openbot?.app?.pickDirectory(draft === 'data' ? '选择数据目录' : '选择会话记录目录')
  if (picked === null || picked === undefined) return
  if (draft === 'data') dataRootDraft.value = picked
  else transcriptRootDraft.value = picked
}

/** 打开数据文件夹（main 白名单限定 userData 内；返回错误消息，空串 = 成功） */
const openFolder = (path: string): void => {
  void window.openbot?.app?.openPath(path).then((err: string) => {
    if (err !== '' && err !== undefined) toast.push(`打开文件夹失败：${err}`, 'danger')
  })
}

/** 档案名缩写徽标（大写两字符内） */
const markOf = (name: string): string => name.trim().slice(0, 2).toUpperCase() || '?'

// ---- 沙箱后端偏好（写 settings 重启生效；表单值与 stored 分离——未保存改动有提示） ----

const BACKEND_META: Record<string, { label: string; note: string }> = {
  wsl: { label: 'WSL2', note: '每 Box 一个发行版（Windows 主力）' },
  nspawn: { label: 'systemd-nspawn', note: '机器即 Box（Linux；写操作需 root/polkit 授权）' },
  utm: { label: 'UTM', note: '虚拟机即 Box（macOS；从预建模板克隆，需 guest agent）' },
  docker: { label: 'Docker', note: '容器即 Box（需 Docker Desktop 运行）' },
  podman: { label: 'Podman', note: '容器即 Box（需 podman machine 运行）' },
  ssh: { label: 'SSH 主机', note: '机器即 Box（VMWare/云主机——env OPENBOT_SSH_HOST 等接入，显式偏好 opt-in）' },
  mock: { label: '模拟', note: '命令返回模拟输出（测试用）' },
}
/** 展示顺序（探测顺序随平台变化——呈现用固定序） */
const BACKEND_ORDER = ['wsl', 'nspawn', 'utm', 'docker', 'podman', 'ssh', 'mock']
const ISO_LABEL: Record<string, string> = { low: '弱', medium: '中', high: '强' }

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
 * 后端行（P8-4 后 UI 优化）：可用性（探测事实）× 每后端 caps（常量声明经 v1.sandbox.status 下发）——
 * 全局「偏好选择」已随镜像绑定退役：Agent 经镜像条目选载体，后端只看可用性；默认沙箱是状态行非选择器
 */
const backendRows = computed(() => {
  const sandbox = kernel.sandbox
  if (!sandbox) return []
  const probed = new Map(sandbox.probes.map((p) => [p.id as string, p]))
  return BACKEND_ORDER.filter((id) => probed.has(id) && !MATRIX_PROBE_IDS.has(id)).map((id) => {
    const probe = probed.get(id)!
    const caps = sandbox.backendCaps?.[id]
    const capChips = caps
      ? [
          { label: '快照', on: caps.snapshot },
          { label: '休眠', on: caps.suspendable },
          { label: '限额', on: caps.resourceLimits },
          { label: '终端', on: caps.interactive },
          { label: '隔离 ' + (ISO_LABEL[caps.isolation] ?? caps.isolation), on: true },
        ]
      : []
    return {
      id,
      label: BACKEND_META[id]?.label ?? id,
      note: BACKEND_META[id]?.note ?? '',
      available: probe.available,
      reason: probe.reason ?? '',
      capChips,
    }
  })
})

/** 后端显示名 */
const backendLabel = (id: string): string => BACKEND_LABELS[id] ?? id
// ---- 行级数据目录（2026-10-20 用户裁定：⚙ 图标 → 模态；目录型可设，其余 toast）----
const dirModal = reactive<{ open: boolean; runtimeId: 'wsl2' | 'nspawn'; name: string; current: string; value: string; busy: boolean }>({
  open: false, runtimeId: 'wsl2', name: '', current: '', value: '', busy: false,
})
const openDirModal = async (runtimeId: 'wsl2' | 'nspawn', name: string): Promise<void> => {
  try {
    const dirs = await kernel.getRuntimeDirs()
    dirModal.open = true
    dirModal.runtimeId = runtimeId
    dirModal.name = name
    dirModal.current = dirs[runtimeId] ?? ''
    dirModal.value = dirs[runtimeId] ?? ''
    dirModal.busy = false
  } catch (err) {
    toast.push(err instanceof Error ? err.message : String(err), 'danger')
  }
}
const saveDirModal = async (): Promise<void> => {
  if (dirModal.busy) return
  dirModal.busy = true
  try {
    await kernel.setRuntimeDataDir(dirModal.runtimeId, dirModal.value.trim() === '' ? null : dirModal.value.trim())
    dirModal.open = false
    toast.push(dirModal.value.trim() === '' ? '已恢复默认——重启生效' : `「${dirModal.name}」数据目录已保存——重启生效`, 'success')
  } catch (err) {
    toast.push(err instanceof Error ? err.message : String(err), 'danger')
  } finally {
    dirModal.busy = false
  }
}

/** 恢复默认（2026-10-21 模态改版：显式动作替代「留空保存」暗语义）：清 per-runtime 覆盖；
 *  已是默认时如实告知、不动设置 */
const resetDirModal = async (): Promise<void> => {
  if (dirModal.busy) return
  if (dirModal.current === '') {
    dirModal.value = ''
    toast.push('当前已是默认目录——无需恢复', 'info')
    return
  }
  dirModal.busy = true
  try {
    await kernel.setRuntimeDataDir(dirModal.runtimeId, null)
    dirModal.open = false
    toast.push('已恢复默认——重启生效', 'success')
  } catch (err) {
    toast.push(err instanceof Error ? err.message : String(err), 'danger')
  } finally {
    dirModal.busy = false
  }
}

/** ⚙ 点击分流：目录型本系统运行时（wsl2 / nspawn 静态行）开模态；其余如实 toast。
 *  判据用策略 id（row.key 是显示名——首版误判 'WSL2'≠'wsl2' 落空，目验实锤后修正） */
const onDirIcon = (row: MatrixRow): void => {
  if (row.local?.id === 'wsl2') {
    void openDirModal('wsl2', row.runtime)
    return
  }
  if (row.staticState === 'builtin' && row.platforms.includes('linux')) {
    void openDirModal('nspawn', row.runtime)
    return
  }
  toast.push('该运行时无应用侧 Box 数据目录（容器型/非本系统）——不可在此设置', 'info')
}

// ---- 运行时一键安装（2026-10-20 v0.2.0，docs/plan-v020-runtime-install.md）----

/** 安装弹窗状态机（2026-10-20 用户裁定：说明内容收进模态）：confirm（提权告知）→
 *  installing（phase/进度条/detail/兜底命令——事件驱动）→ done/failed（关闭收敛）。
 *  installDir/dataDir（2026-10-21 位置旗标链）：确认阶段可填，留空 = 官方默认 */
const installModal = reactive<{
  open: boolean
  installer: typeof kernel.runtimeInstallers[number] | null
  /** launchConfirm（v0.1.90）：polkit 提权启动的确认段（提权透明红线——免提权运行时不经此段） */
  stage: 'confirm' | 'launchConfirm' | 'installing' | 'done' | 'failed' | 'canceled'
  installDir: string
  dataDir: string
}>({ open: false, installer: null, stage: 'confirm', installDir: '', dataDir: '' })

/** 安装实况（由 store 的 runtimeProgress 投影——模态内呈现；行上仅小签） */
const installProgress = computed(() => {
  const id = installModal.installer?.id
  return id !== undefined ? kernel.runtimeProgress[id] : undefined
})

// 安装中事件到终态 → 弹窗转 done/failed（保留在屏——用户点关闭）
watch(
  () => (installModal.installer !== null ? kernel.runtimeProgress[installModal.installer.id]?.phase : undefined),
  (phase) => {
    if (installModal.stage !== 'installing') return
    if (phase === 'done') installModal.stage = 'done'
    else if (phase === 'failed') installModal.stage = 'failed'
    else if (phase === 'canceled') installModal.stage = 'canceled'
  },
)

/** 平台显示名（矩阵徽章/不支持文案）——hostPlatform 由 UA 判定（主进程 platform 不下发渲染层） */
const PLATFORM_LABEL: Record<string, string> = { win32: 'Windows', linux: 'Linux', darwin: 'macOS' }
const hostPlatform = navigator.platform.includes('Win') ? 'win32' : navigator.platform.includes('Mac') ? 'darwin' : 'linux'
const thisPlatformLabel = computed(() => PLATFORM_LABEL[hostPlatform] ?? '本系统')

/** 运行时矩阵行（2026-10-20 用户裁定：全量容器展示 × 按本系统针对性）：
 *  按 runtime 分组（docker-desktop 双平台 / podman 三平台合一行）；platforms = 各平台策略在场即支持；
 *  静态行：nspawn（Linux 自带）、UTM（macOS 载体——安装器后置）——探测事实从 probes 取 */
interface MatrixRow {
  key: string
  runtime: string
  platforms: string[]
  /** 本平台策略（缺席=null：不支持本系统） */
  local: typeof kernel.runtimeInstallers[number] | null
  /** 静态行状态覆盖（nspawn=自带/UTM=后置） */
  staticState?: 'builtin' | 'deferred'
}

const runtimeMatrix = computed<MatrixRow[]>(() => {
  const groups = new Map<string, typeof kernel.runtimeInstallers>()
  for (const inst of kernel.runtimeInstallers) {
    const arr = groups.get(inst.runtime) ?? []
    arr.push(inst)
    groups.set(inst.runtime, arr)
  }
  const rows: MatrixRow[] = []
  for (const [runtime, insts] of groups) {
    const local = insts.find((i) => i.supported) ?? null
    rows.push({ key: runtime, runtime, platforms: insts.map((i) => i.platform), local })
  }
  // nspawn：Linux 探测在场才显示（自带语义）；UTM：macOS 探测在场才显示（后置注记）
  const probes = new Map((kernel.sandbox?.probes ?? []).map((p) => [p.id as string, p]))
  if (probes.has('nspawn')) rows.push({ key: 'nspawn', runtime: 'nspawn', platforms: ['linux'], local: null, staticState: 'builtin' })
  if (probes.has('utm')) rows.push({ key: 'utm', runtime: 'UTM', platforms: ['darwin'], local: null, staticState: 'deferred' })
  // 本系统相关行在前（可装/已装），纯他平台行殿后
  return rows.sort((a, b) => Number(b.local !== null || b.staticState !== undefined) - Number(a.local !== null || a.staticState !== undefined))
})

/** 探测卡过滤（其他载体）：已进矩阵的运行时行不再双列（wsl/docker/podman/nspawn/utm） */
const MATRIX_PROBE_IDS = new Set(['wsl', 'docker', 'podman', 'nspawn', 'utm'])

/** 进度条文案（launch/ready 为 2026-10-27 启动链相位——与安装链同通道） */
const phaseLabel: Record<string, string> = {
  download: '下载中',
  verify: '校验',
  install: '安装中',
  probe: '验证',
  done: '完成',
  failed: '失败',
  fallback: '需手动执行',
  canceled: '已取消',
  launch: '启动中',
  ready: '已就绪',
}

/** 相位终态集（行内在途判定与模态转段共用，2026-10-27 增 ready——启动链终态） */
const TERMINAL_PHASES = new Set(['done', 'failed', 'fallback', 'canceled', 'ready'])
const isTerminalPhase = (p: string | undefined): boolean => p !== undefined && TERMINAL_PHASES.has(p)

/** ⓘ 收纳内容（2026-10-26 用户裁定）：per-runtime 如实标注 + 通用体积行——正文只留位置与提权告知 */
const installTipLines = computed<string[]>(() => {
  const inst = installModal.installer
  return inst === null ? [] : [...inst.notes, '下载体积可能较大（数百 MB）——可随时「取消」或转「后台下载」']
})

const openInstallConfirm = (installer: typeof kernel.runtimeInstallers[number]): void => {
  installModal.open = true
  installModal.installer = installer
  installModal.installDir = ''
  installModal.dataDir = ''
  // 该运行时已在途（行上「安装中…/启动中…」点开）→ 直接进进度态（不重复确认/不重复启动）
  const phase = kernel.runtimeProgress[installer.id]?.phase
  installModal.stage = phase !== undefined && !isTerminalPhase(phase) ? 'installing' : 'confirm'
}

/** 取消安装（2026-10-20 用户报障：下载无法取消——流量敏感客户）：
 *  abort 在途任务（下载清临时文件、子进程即杀）→ canceled 终态（模态如实呈现）。
 *  2026-10-27 同一模态可回看启动实况——在途相位为 launch 时取消的是启动等待 */
const doCancelInstall = async (): Promise<void> => {
  try {
    if (installProgress?.phase === 'launch' && installModal.installer !== null) {
      await kernel.cancelRuntimeLaunch(installModal.installer.id)
      return
    }
    await kernel.cancelRuntimeInstall()
  } catch (err) {
    toast.push(err instanceof Error ? err.message : String(err), 'danger')
  }
}

/** 启动已装未跑的运行时（2026-10-27 v0.1.89）：受理即返——行转「启动中…」行内态
 *  （launch/ready 相位驱动；DD 默认位解析让装完即启免重启应用）。
 *  polkit 提权启动（v0.1.90 linux docker）先过确认模态——提权透明红线（安装确认同款告知） */
const doLaunchRuntime = async (inst: typeof kernel.runtimeInstallers[number]): Promise<void> => {
  if (inst.launchElevation === 'polkit') {
    installModal.open = true
    installModal.installer = inst
    installModal.stage = 'launchConfirm'
    return
  }
  try {
    await kernel.launchRuntime(inst.id)
  } catch (err) {
    toast.push(err instanceof Error ? err.message : String(err), 'danger')
  }
}

/** done 模态「立即启动」（2026-10-27 启动引导）：免提权关模态转行内启动态；
 *  polkit 提权（v0.1.90）模态原位转启动确认段（提权告知先行） */
const doLaunchFromDone = async (): Promise<void> => {
  const target = installModal.installer
  if (target === null) return
  if (target.launchElevation === 'polkit') {
    installModal.stage = 'launchConfirm'
    return
  }
  installModal.open = false
  await doLaunchRuntime(target)
}

/** launchConfirm 模态「开始启动」（v0.1.90 linux docker——polkit 确认后执行） */
const doLaunchConfirmed = async (): Promise<void> => {
  const target = installModal.installer
  if (target === null) return
  installModal.open = false
  try {
    await kernel.launchRuntime(target.id)
  } catch (err) {
    toast.push(err instanceof Error ? err.message : String(err), 'danger')
  }
}

/** 取消启动等待（2026-10-27 裁定：停轮询——已拉起的程序不受影响） */
const doCancelLaunch = async (id: string): Promise<void> => {
  try {
    await kernel.cancelRuntimeLaunch(id)
  } catch (err) {
    toast.push(err instanceof Error ? err.message : String(err), 'danger')
  }
}

/** 启动钮旁 ⓘ 首启条款（2026-10-27 裁定：文案如实——首启需在上游应用内完成初始化；
 *  polkit 型如实说明授权与耗时形态） */
const launchTipLines = (inst: typeof kernel.runtimeInstallers[number]): string[] => [
  inst.launchElevation === 'polkit'
    ? '启动经系统授权（polkit）执行 systemctl start docker——通常数秒完成'
    : inst.id === 'docker-desktop'
      ? '首次启动需在 Docker Desktop 内完成初始化，可能需数分钟'
      : '首次启动需初始化虚拟机，可能需数分钟',
  '应用等待就绪最长 5 分钟，可随时「取消等待」——不影响已启动的程序',
]

/** 已装未跑一行提示（2026-10-27 裁定：一行一职）：DD 引导去官方设置勾开机自启（应用不代改）；
 *  podman 无 machine 给 init 指引；未声明启动（linux/mac backlog）如实说明 */
const stoppedDesc = (inst: typeof kernel.runtimeInstallers[number]): string => {
  if (inst.note === 'feature-off') return 'WSL 组件未启用——一键安装将启用系统组件（可能需重启完成）'
  if (inst.note === 'machine-missing') return '已安装，尚无 podman machine——需先在终端执行 podman machine init 初始化'
  if (inst.id === 'docker-desktop' && inst.platform === 'win32') {
    return '引擎未运行——启动后即可用；开机自启可在 Docker Desktop 设置（General）中勾选，应用不代改'
  }
  if (inst.id === 'podman' && inst.platform === 'win32') return '已安装，machine 未运行——启动后即可用'
  if (inst.launchSupported) return '已安装，引擎未运行——启动后即可用'
  return '已安装，引擎未运行——启动器暂缓（后续批次提供），请先在应用外启动'
}

// 分节进入刷新（v0.1.90 起；v0.1.91 起 status 也活探测——其他载体行同享鲜度）：运行时矩阵与
// 探测事实切进本节拉新（外部启停引擎后旧态不残留；探测幂等秒级）
watch(activeSection, (s) => {
  if (s === 'runtime') {
    void kernel.refreshSandbox().catch(() => {})
    void kernel.refreshRuntimeInstallers().catch(() => {})
  }
})

/** 手动重探（v0.1.97：容器与镜像头「⟳ 刷新状态」——分节进入双刷的同款逻辑提成按钮，
 *  停留在设置页期间外部启停引擎也能立刻拿新事实；与注册表「⟳ 扫描可用镜像」同款交互语言） */
const runtimeRefreshing = ref(false)
const refreshRuntimeStatus = async (): Promise<void> => {
  if (runtimeRefreshing.value) return
  runtimeRefreshing.value = true
  try {
    await Promise.all([kernel.refreshSandbox(), kernel.refreshRuntimeInstallers()])
  } catch (err) {
    toast.push(err instanceof Error ? err.message : String(err), 'danger')
  } finally {
    runtimeRefreshing.value = false
  }
}

const doInstall = async (): Promise<void> => {
  const target = installModal.installer
  if (target === null) return
  try {
    // 位置参数只在策略声明可选时传（2026-10-21 位置旗标链——留空 = 官方默认不传）
    await kernel.installRuntime(target.id, {
      ...(target.installDirSelectable ? { installDir: installModal.installDir } : {}),
      ...(target.dataDirSelectable ? { dataDir: installModal.dataDir } : {}),
    })
    installModal.stage = 'installing' // 弹窗原位转进度模态（说明内容不再漏到行下）
  } catch (err) {
    toast.push(err instanceof Error ? err.message : String(err), 'danger')
  }
}

/** 系统目录选择对话框 → 回填（安装位置/容器数据位置/Box 数据目录共用；取消/空选如实不动） */
const pickInto = async (setter: (path: string) => void): Promise<void> => {
  const picked = await window.openbot?.app?.pickDirectory('选择目录')
  if (picked !== null && picked !== undefined && picked.trim() !== '') setter(picked.trim())
}

/** 复制兜底命令到剪贴板（navigator.clipboard 在渲染层可用） */
const copyFallback = async (text: string): Promise<void> => {
  await navigator.clipboard.writeText(text).catch(() => {})
  toast.push('命令已复制——请粘贴到终端执行', 'success')
}

/** 偏好涉及 WSL 且镜像未就绪时引导放置 */
const wslRelevant = computed(
  () =>
    kernel.sandbox !== null &&
    (kernel.sandbox.preference === 'wsl' || kernel.sandbox.preference === 'auto') &&
    !kernel.sandbox.rootfsReady,
)
/** 旧「一键安装暂不提供」引导（裁定 D 遗产）——2026-10-20 作者推翻旧裁定，一键安装已提供
 *  （docs/plan-v020-runtime-install.md）；WSL 探测不可用现由安装器区接管（不可用即给安装入口） */
</script>

<template>
  <section class="view view-scroll">
    <div class="settings-layout">
      <nav class="settings-nav" aria-label="设置分类">
        <div v-for="g in SETTINGS_GROUPS" :key="g.label" class="settings-nav-group">
          <div class="settings-nav-group-label">{{ g.label }}</div>
          <button
            v-for="item in g.items"
            :key="item.id"
            type="button"
            class="settings-nav-item"
            :class="{ 'is-active': activeSection === item.id }"
            @click="activeSection = item.id"
          >
            <span class="settings-nav-icon" v-html="item.icon"></span>{{ item.label }}
          </button>
        </div>
      </nav>
      <div class="settings">
      <div v-show="activeSection === 'llm'" class="settings-section">
      <!-- LLM 推理（真实命令面）——说明收进 ⓘ（0.1.2 设置页改版：正文只留活数据） -->
      <div class="set-sec-row">
        <div class="set-sec">模型设置</div>
        <HelpTip
          text="接入模型端点（OpenAI 兼容 / Anthropic 协议，DeepSeek / GLM / Moonshot / Claude 等），可同时配置多个。全场唯一一个「默认」模型：未指定模型的 Agent 直接使用它；其他模型上游失败（额度不足、订阅过期等）时自动回退到它。API key 以系统加密（`safeStorage`）落盘，不出现在 transcript 与事件流里。"
        />
      </div>
      <!-- 模型设置主从卡（2026-09-15，对照用户图例 v2）：左供应商列表 + 右详情/内联表单——
           供应商 = 端点事实（URL/协议/key/代理），其下挂模型列表（视觉声明在模型级） -->
      <div class="settings-card llm-card">
        <aside class="llm-nav" aria-label="供应商列表">
          <div class="llm-nav-group-label">供应商列表</div>
          <button
            v-for="p in kernel.providers"
            :key="p.name"
            type="button"
            class="llm-nav-item"
            :class="{ 'is-active': pane !== 'add' && selected?.name === p.name }"
            :data-provider="p.name"
            draggable="true"
            @dragstart="dragName = p.name"
            @dragend="dragName = null"
            @dragover.prevent
            @drop.prevent="dropOn(p.name)"
            @click="selectedProvider = p.name; pane = 'detail'"
          >
            <span class="llm-nav-mark">{{ markOf(p.name) }}</span>
            <span class="llm-nav-name">{{ p.name }}</span>
            <span
              class="llm-nav-dot"
              :class="{ on: p.name === kernel.defaultProvider }"
              :title="p.name === kernel.defaultProvider ? '当前默认' : ''"
            />
          </button>
          <button class="llm-nav-add" type="button" :class="{ 'is-active': pane === 'add' }" @click="openCreate">＋ 添加供应商</button>
        </aside>
        <div class="llm-detail" data-role="llm-detail">
          <!-- 详情态：标题头 + 带标签信息行 + 圆角模型行（图例质感） -->
          <template v-if="pane === 'detail'">
            <template v-if="selected">
              <div class="llm-detail-head">
                <span class="llm-detail-title">{{ selected.name }}</span>
                <span v-if="isSelectedDefault" class="chip chip-accent">默认</span>
                <span v-if="selected.protocol === 'anthropic'" class="chip">Anthropic</span>
                <span class="chip" :class="selected.hasKey ? 'chip-success' : ''">{{ selected.hasKey ? '已存 key' : '无 key' }}</span>
                <div class="cfg-actions">
                  <button class="btn btn-ghost btn-sm" @click="openEdit(selected)">编辑</button>
                  <button class="btn btn-ghost btn-sm btn-danger" @click="removeProvider(selected.name)">
                    {{ confirmingRemove === selected.name ? '确认删除？' : '删除' }}
                  </button>
                </div>
              </div>
              <div class="kv"><span class="k">Base URL</span><span class="v mono">{{ selected.baseUrl }}<template v-if="selected.proxyUrl"> · 代理 {{ selected.proxyUrl }}</template></span></div>
              <div class="kv"><span class="k">API 格式</span><span class="v">{{ selected.protocol === 'anthropic' ? 'Anthropic Messages（/v1/messages）' : 'OpenAI 兼容（/v1/chat/completions）' }}</span></div>
              <div class="kv"><span class="k">当前默认</span><span class="v mono">{{ defaultDisplay }}</span></div>
              <div class="field-label llm-sec-label">模型列表</div>
              <div class="llm-model-list">
              <div v-for="m in selected.models" :key="m.id" class="llm-model-row" :data-model="m.id">
                <div class="llm-model-box">
                  <span class="llm-model-id mono">{{ m.id }}</span>
                  <span v-if="m.supportsImages" class="chip">视觉</span>
                  <span v-if="m.context1M" class="chip">1M</span>
                  <span v-if="isSelectedDefault && isDefaultPair(selected.name, m.id)" class="chip chip-accent">默认</span>
                  <span
                    v-if="modelTestResults[`saved:${selected.name}:${m.id}`]"
                    class="chip"
                    :class="modelTestResults[`saved:${selected.name}:${m.id}`].ok ? 'chip-success' : 'chip-danger'"
                    :title="modelTestResults[`saved:${selected.name}:${m.id}`].text"
                  >{{ modelTestResults[`saved:${selected.name}:${m.id}`].text.length > 18 ? modelTestResults[`saved:${selected.name}:${m.id}`].text.slice(0, 18) + '…' : modelTestResults[`saved:${selected.name}:${m.id}`].text }}</span>
                  <div class="llm-model-actions">
                  <button
                    v-if="!(isSelectedDefault && isDefaultPair(selected.name, m.id))"
                    class="llm-icon-btn"
                    title="设为默认"
                    @click="makeDefault(selected.name, m.id)"
                    v-html="ICON('<path d=\'M12 2l3 6 6 1-5 5 1 7-5-3-5 3 1-7-5-5 6-1z\'/>')"
                  />
                  <button class="llm-icon-btn" title="测试模型可调用" @click="testModelRow(`saved:${selected.name}:${m.id}`, { name: selected.name, model: m.id })" v-html="ICON('<path d=\'M13 2 3 14 12 14 11 22 21 10 12 10 13 2\'/>')" />
                  <button class="llm-icon-btn" title="编辑模型" @click="openModelModal(m.id, selected.name)" v-html="ICON('<path d=\'M17 3l4 4L7 21H3v-4L17 3z\'/>')" />
                  <button class="llm-icon-btn llm-icon-danger" title="删除模型" @click="removeSavedModel(selected, m.id)" v-html="ICON('<path d=\'M3 6h18\'/><path d=\'M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2\'/><path d=\'M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6\'/>')" />
                  </div>
                </div>
              </div>
              </div>
            </template>
            <p v-if="kernel.providers.length === 0" class="settings-empty">还没有模型端点——左侧「添加供应商」开始对话</p>
          </template>
          <!-- 表单态（添加/编辑内联——图例添加页语义）：标题 + 端点事实 + 模型列表行内增删；
               字段区包 llm-form-body 内部滚动——表单再高也不撑大卡片/分节（尺寸恒定） -->
          <template v-else>
            <div class="llm-detail-head">
              <span class="llm-detail-title">{{ pane === 'add' ? '添加模型供应商' : '编辑供应商' }}</span>
            </div>
            <p class="kv-note">{{ pane === 'add' ? '配置一个完全自定义的 API 端点和模型列表。' : '同名替换；API Key 留空保留原密文。改名会同步更新默认/回退引用，密文随档迁移。' }}</p>
            <div class="llm-form-body">
            <div class="field">
              <label class="field-label" for="pfName">名称</label>
              <input id="pfName" v-model="form.name" class="field-input" :placeholder="pane === 'edit' ? '改名将迁移档案（密文与引用随之走）' : '例：智谱中转（供应商记名，不是模型名）'" autocomplete="off" maxlength="16" />
            </div>
            <div class="field">
              <label class="field-label" for="pfUrl">Base URL</label>
              <input id="pfUrl" v-model="form.baseUrl" class="field-input mono" :placeholder="urlPlaceholder" autocomplete="off" spellcheck="false" />
            </div>
            <div class="field">
              <span class="field-label">API 格式</span>
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
              <label class="field-label" for="pfKey">API Key</label>
              <input id="pfKey" v-model="form.apiKey" class="field-input mono" type="password" :placeholder="pane === 'edit' ? '留空保留原密文' : '端点无需 key 时留空'" autocomplete="off" />
            </div>
            <div class="field">
              <label class="field-label" for="pfProxy">代理（可选）</label>
              <input id="pfProxy" v-model="form.proxyUrl" class="field-input mono" placeholder="http://127.0.0.1:7890" autocomplete="off" spellcheck="false" />
            </div>
            <div class="field">
              <span class="field-label">模型列表</span>
              <div v-if="form.models.length === 0" class="model-empty-box">ⓘ 当前没有配置模型，添加模型后可在聊天中使用。</div>
              <div v-if="form.models.length > 0" class="llm-model-list">
              <div v-for="m in form.models" :key="m.id" class="llm-model-row" :data-form-model="m.id">
                <div class="llm-model-box">
                  <span class="llm-model-id mono">{{ m.id }}</span>
                  <button
                    type="button"
                    class="chip chip-click"
                    :class="{ 'chip-success': m.supportsImages }"
                    title="视觉（图像输入）——点击切换"
                    @click="m.supportsImages = !m.supportsImages"
                  >视觉</button>
                  <button
                    type="button"
                    class="chip chip-click"
                    :class="{ 'chip-success': m.context1M }"
                    title="1M 上下文档位（附件注入预算）——点击切换"
                    @click="m.context1M = !m.context1M"
                  >1M</button>
                  <span
                    v-if="modelTestResults[`form:${m.id}`]"
                    class="chip"
                    :class="modelTestResults[`form:${m.id}`].ok ? 'chip-success' : 'chip-danger'"
                    :title="modelTestResults[`form:${m.id}`].text"
                  >{{ modelTestResults[`form:${m.id}`].text.length > 18 ? modelTestResults[`form:${m.id}`].text.slice(0, 18) + '…' : modelTestResults[`form:${m.id}`].text }}</span>
                  <div class="llm-model-actions">
                  <button class="llm-icon-btn" title="测试模型可调用（需先填 Base URL）" @click="testModelRow(`form:${m.id}`, { model: m.id, baseUrl: form.baseUrl.trim() || undefined, apiKey: form.apiKey.trim() || undefined, protocol: form.protocol })" v-html="ICON('<path d=\'M13 2 3 14 12 14 11 22 21 10 12 10 13 2\'/>')" />
                  <button class="llm-icon-btn" title="编辑模型" @click="openModelModal(m.id, null)" v-html="ICON('<path d=\'M17 3l4 4L7 21H3v-4L17 3z\'/>')" />
                  <button class="llm-icon-btn llm-icon-danger" title="删除模型" @click="removeFormModel(m.id)" v-html="ICON('<path d=\'M3 6h18\'/><path d=\'M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2\'/><path d=\'M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6\'/>')" />
                  </div>
                </div>
              </div>
              </div>
              <button class="btn btn-secondary btn-sm" type="button" @click="openModelModal(null, null)">＋ 添加模型</button>
              <p class="field-note">支持看图的模型勾选「视觉」——GUI 操作的截图将以图像回喂给该模型；不勾则降级为文本说明。</p>
            </div>
            </div>
            <p v-if="formError" class="form-error">{{ formError }}</p>
            <div class="llm-form-foot">
              <span class="kv-note">{{ pane === 'add' ? '添加供应商前，请至少添加一个模型。' : '同名替换；API Key 留空保留原密文。' }}</span>
              <button class="btn btn-primary" :disabled="!formValid || saving" @click="save">{{ saving ? '保存中…' : '保存' }}</button>
              <button class="btn btn-ghost" @click="closeForm">取消</button>
            </div>
          </template>
        </div>
      </div>

      <!-- 模型弹窗（添加/编辑模型行——图例交互）：模型 ID + 视觉声明；Enter 与保存等效（E2E 同路径） -->
      <div v-if="modelModal.open" class="wiz-overlay" @mousedown.self="modelModal.open = false">
        <div class="wiz-card" role="dialog" aria-label="模型配置" @keydown.escape="modelModal.open = false">
          <div class="wiz-head">
            <span class="wiz-title">{{ modelModal.editingId !== null ? '编辑模型' : '添加模型' }}</span>
            <button class="wiz-close" type="button" aria-label="关闭" @click="modelModal.open = false">✕</button>
          </div>
          <div class="wiz-body">
            <div class="field">
              <label class="field-label" for="pfModel">模型 ID</label>
              <input id="pfModel" v-model="modelModal.id" class="field-input mono" placeholder="例：glm-5.3-flash" autocomplete="off" spellcheck="false" @keydown.enter.prevent="confirmModelModal" />
            </div>
            <div class="field">
              <label class="proto-opt" :class="{ 'is-on': modelModal.supportsImages }" for="pfVision">
                <input id="pfVision" type="checkbox" v-model="modelModal.supportsImages" />
                视觉（图像输入）
              </label>
              <p class="field-note">勾选后该模型的对话可回喂 GUI 截图（图像 part）；不勾则截图降级为文本说明。</p>
            </div>
            <!-- 1M 上下文档位（v0.1.111 用户裁定：视觉旁新增）：附件注入预算随窗口档——勾=1M 档（~1.4M 字符），缺省 128k 档（~180k） -->
            <div class="field">
              <label class="proto-opt" :class="{ 'is-on': modelModal.context1M }" for="pfCtx1M">
                <input id="pfCtx1M" type="checkbox" v-model="modelModal.context1M" />
                1M 上下文
              </label>
              <p class="field-note">长上下文档位声明——决定附件注入预算（1M 档约 140 万字符，缺省 128k 档约 18 万）；仅影响附件注入量，不改请求参数。</p>
            </div>
          </div>
          <div class="wiz-foot">
            <button class="btn btn-primary" :disabled="!modelModalValid" @click="confirmModelModal">保存</button>
            <button class="btn btn-ghost" @click="modelModal.open = false">取消</button>
          </div>
        </div>
      </div>


      </div>
      <div v-show="activeSection === 'runtime'" class="settings-section">
      <!-- 容器与镜像（v0.1.53 语义）：Agent 经镜像条目选载体（屏幕一等公民）；默认沙箱卡退役。
           「⟳ 刷新状态」（v0.1.97）：手动重探矩阵+探测卡——停在页面也能拿外部启停后的新事实 -->
      <div class="set-sec-row">
        <div class="set-sec">容器与镜像</div>
        <HelpTip
          text="各执行载体的可用性与能力一览（探测事实驱动）。Agent 通过绑定镜像条目选择载体（向导/ctx 均可）——容器条目按声明的运行时（Docker/Podman）自持路由；装配期底座不可用时降级模拟保启动并在此告警。"
        />
        <button class="btn btn-secondary btn-sm" style="margin-left: auto" data-role="runtime-refresh" :disabled="runtimeRefreshing" @click="refreshRuntimeStatus">{{ runtimeRefreshing ? '刷新中…' : '⟳ 刷新状态' }}</button>
      </div>
      <template v-if="kernel.sandbox">
        <!-- 装配降级如实告警（v0.1.51 防线的呈现面——默认沙箱卡退役后独立保留） -->
        <p v-if="kernel.sandbox.reason" class="sandbox-warn">⚠ {{ kernel.sandbox.reason }}</p>
        <p v-if="wslRelevant" class="sandbox-warn">
          WSL 基础镜像未就绪：请把 Ubuntu rootfs 压缩包（tar.gz）放到
          <span class="mono">{{ kernel.sandbox.rootfsPath }}</span>，或设环境变量 OPENBOT_WSL_ROOTFS 指向已有文件后重启。
        </p>
        <!-- 旧裁定文案退役（2026-10-20 作者推翻：一键安装改为提供——提权全程透明） -->

        <!-- 运行时矩阵（2026-10-20 用户裁定改版）：全量容器一行一个——平台徽章 + 本系统针对性；
             一个运行时只出现一次（旧安装器区/可用折叠/探测行三块平行列表的重复即难看根源） -->
        <div class="settings-card rt-matrix">
          <div v-for="row in runtimeMatrix" :key="row.key" class="rt-row" :class="{ 'is-remote': row.local === null && row.staticState === undefined }">
            <div class="appearance-main">
              <div class="rt-name-line">
                <span class="appearance-name">{{ row.runtime }}</span>
                <span v-for="pf in row.platforms" :key="pf" class="rt-pf" :class="{ 'is-here': pf === hostPlatform }">{{ PLATFORM_LABEL[pf] }}</span>
              </div>
              <!-- 本平台行不再铺位置事实/如实标注（2026-10-26 用户裁定：与安装确认模态重复——
                   位置说明/输入/ⓘ 收纳归模态一处；行上只留名称+徽章+状态） -->
              <div v-if="row.staticState === 'builtin'" class="appearance-desc">systemd 原生轻量容器——系统自带，零安装</div>
              <div v-else-if="row.staticState === 'deferred'" class="appearance-desc">macOS 虚拟机载体（GUI 沙箱路线）——安装器记档后置</div>
              <div v-else-if="row.local === null" class="appearance-desc">适用于 {{ row.platforms.map((pf) => PLATFORM_LABEL[pf]).join(' / ') }}——在{{ thisPlatformLabel }}上不支持</div>
              <!-- 已装未跑一行提示（2026-10-27 裁定）：DD 自启引导（不代改）/ podman init 指引 / backlog 如实 -->
              <div v-else-if="row.local.installState === 'installed' && row.local.engineState !== 'running'" class="appearance-desc">{{ stoppedDesc(row.local) }}</div>
            </div>
            <!-- 状态区（2026-10-27 三态化）：运行中绿签 / 启动中行内态 / 安装中迷你进度 /
                 需初始化 / 已装·未跑→启动（声明制）/ 一键安装；自带/后置/不支持；⚙ 行级数据目录 -->
            <div class="rt-status">
              <template v-if="row.staticState === 'builtin'">
                <span class="chip chip-success">系统自带</span>
              </template>
              <template v-else-if="row.staticState === 'deferred'">
                <span class="chip">暂缓</span>
              </template>
              <template v-else-if="row.local === null">
                <span class="chip rt-unsupported">不支持</span>
              </template>
              <!-- 三态之三：运行中（engineState——旧 available===true 同位迁移） -->
              <template v-else-if="row.local.installState === 'installed' && row.local.engineState === 'running'">
                <span class="chip chip-success">已可用</span>
              </template>
              <!-- 启动中行内态（2026-10-27）：mini 可点回看（模态呈等待实况）；取消等待 =
                   停轮询（DD 已拉起程序不杀——裁定） -->
              <template v-else-if="kernel.runtimeProgress[row.local.id]?.phase === 'launch'">
                <button type="button" class="rt-mini" :title="kernel.runtimeProgress[row.local.id]!.detail ?? '查看启动进度'" @click="openInstallConfirm(row.local)">
                  <span class="rt-mini-label">启动中…</span>
                </button>
                <button type="button" class="btn btn-ghost btn-sm" @click="doCancelLaunch(row.local!.id)">取消等待</button>
              </template>
              <template v-else-if="kernel.runtimeProgress[row.local.id] !== undefined && !isTerminalPhase(kernel.runtimeProgress[row.local.id]!.phase)">
                <!-- 行内迷你进度条（2026-10-20 用户裁定：后台下载后进度仍可见）：下载阶段
                     百分比填充；其余阶段 phase 文案（含「等待系统授权（UAC）…」等待期反馈） -->
                <button type="button" class="rt-mini" title="查看安装进度" @click="openInstallConfirm(row.local)">
                  <span class="rt-mini-bar"><span class="rt-mini-fill" :style="{ width: `${kernel.runtimeProgress[row.local.id]!.percent ?? 0}%` }"></span></span>
                  <span class="rt-mini-label">
                    {{ kernel.runtimeProgress[row.local.id]!.phase === 'download'
                      ? `${kernel.runtimeProgress[row.local.id]!.percent ?? 0}%`
                      : (phaseLabel[kernel.runtimeProgress[row.local.id]!.phase] ?? '安装中') }}
                  </span>
                </button>
              </template>
              <!-- 需初始化（podman 无 machine：start 必败不给启动钮——init 指引在行说明） -->
              <template v-else-if="row.local.note === 'machine-missing'">
                <span class="chip">需初始化</span>
              </template>
              <!-- 组件未启用（v0.1.91 wsl2 细分）：wsl.exe 在场但 WSL 未启用——一键安装即修复路径
                   （wsl --install；desc 说明），不与「未装」混淆也不给无动作的「已安装」签 -->
              <template v-else-if="row.local.note === 'feature-off'">
                <button type="button" class="btn btn-primary" @click="openInstallConfirm(row.local)">一键安装</button>
              </template>
              <!-- 三态之二：已装·未跑——声明启动策略才有启动钮（旁 ⓘ 首启条款；polkit 型点击先过确认模态） -->
              <template v-else-if="row.local.installState === 'installed' && row.local.launchSupported">
                <button type="button" class="btn btn-primary" @click="doLaunchRuntime(row.local)">启动</button>
                <HelpTip :lines="launchTipLines(row.local!)" />
              </template>
              <!-- 已装未跑但未声明启动（backlog 行）：如实标注 -->
              <template v-else-if="row.local.installState === 'installed'">
                <span class="chip">已安装·未运行</span>
              </template>
              <!-- 三态之一：未安装 → 一键安装 -->
              <template v-else>
                <button
                  type="button"
                  class="btn btn-primary"
                  @click="openInstallConfirm(row.local)"
                >一键安装</button>
              </template>
              <!-- ⚙ 行级 Box 数据目录（目录型本系统行可设——模态；其余 toast 如实） -->
              <button type="button" class="rt-gear" title="设置 Box 数据目录" aria-label="设置 Box 数据目录" @click="onDirIcon(row)">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
              </button>
            </div>
          </div>
        </div>

                <!-- 安装模态（2026-10-20 用户裁定：说明内容收进模态）：confirm（提权告知）→
             installing（进度/兜底命令）→ done/failed（结果 + 关闭） -->
        <div v-if="installModal.open && installModal.installer" class="approval-scrim" role="presentation">
          <div class="approval-modal" role="dialog" aria-modal="true" aria-label="运行时安装">
            <div class="am-head">
              <div class="am-head-left">
                <span class="am-title">
                  {{
                    installModal.stage === 'confirm'
                      ? `安装 ${installModal.installer.runtime}`
                      : installModal.stage === 'launchConfirm'
                        ? `启动 ${installModal.installer.runtime}`
                        : installModal.installer.runtime
                  }}
                </span>
                <!-- 如实事注收纳（2026-10-26 用户裁定）：notes + 体积行收进标题右侧 ⓘ——
                     正文只留位置与提权告知（UAC/polkit 是安全透明，不收纳） -->
                <HelpTip :lines="installTipLines" />
              </div>
            </div>
            <!-- 阶段一：确认（提权透明 + 位置事实 + 位置自选输入 + 许可注意） -->
            <div v-if="installModal.stage === 'confirm'" class="am-body">
              <p class="am-line">{{ installModal.installer.locationNote }}</p>
              <!-- 位置自选输入（2026-10-21 用户需求：安装位置/容器数据位置区分可选）：
                   策略声明旗标才呈现（不放假输入）；留空 = 官方默认 -->
              <div v-if="installModal.installer.installDirSelectable" class="am-field">
                <label class="field-label" for="rtInstallDir">安装位置（程序本体，可选）</label>
                <div class="field-pick">
                  <input id="rtInstallDir" v-model="installModal.installDir" class="wiz-input mono" placeholder="官方默认" maxlength="300" autocomplete="off" spellcheck="false" />
                  <button type="button" class="btn btn-ghost" @click="pickInto((p) => (installModal.installDir = p))">浏览…</button>
                </div>
              </div>
              <div v-if="installModal.installer.dataDirSelectable" class="am-field">
                <label class="field-label" for="rtDataDir">容器数据位置（镜像/卷，可选）</label>
                <div class="field-pick">
                  <input id="rtDataDir" v-model="installModal.dataDir" class="wiz-input mono" placeholder="官方默认" maxlength="300" autocomplete="off" spellcheck="false" />
                  <button type="button" class="btn btn-ghost" @click="pickInto((p) => (installModal.dataDir = p))">浏览…</button>
                </div>
              </div>
              <p v-if="installModal.installer.elevation === 'uac'" class="am-line">⚠ 将弹出系统授权框（UAC）——由你确认后才安装。</p>
              <p v-else-if="installModal.installer.elevation === 'polkit'" class="am-line">⚠ 将弹出系统授权框（polkit 密码框）——由你确认后才安装。</p>
            </div>
            <!-- 阶段：启动确认（v0.1.90 linux docker——polkit 提权透明；免提权运行时不经此段一键直启） -->
            <div v-else-if="installModal.stage === 'launchConfirm'" class="am-body">
              <p class="am-line">{{ installModal.installer.runtime }} 已安装但引擎未运行——启动后即可用。</p>
              <p class="am-line">⚠ 将弹出系统授权框（polkit 密码框）——由你确认后才启动（sudo systemctl start docker）。</p>
            </div>
            <!-- 阶段二：安装进行中（phase/进度条/detail/兜底命令——原行内联内容收拢于此） -->
            <div v-else-if="installModal.stage === 'installing'" class="am-body">
              <div class="ri-progress is-modal">
                <span class="ri-phase">{{ phaseLabel[installProgress?.phase ?? 'install'] ?? '…' }}</span>
                <span v-if="installProgress?.detail" class="ri-detail">{{ installProgress.detail }}</span>
                <div v-if="installProgress?.phase === 'download' && installProgress.percent !== undefined" class="ri-bar">
                  <div class="ri-bar-fill" :style="{ width: `${installProgress.percent}%` }"></div>
                </div>
                <pre v-if="installProgress?.command" class="ri-cmd mono">{{ installProgress.command }}</pre>
                <button v-if="installProgress?.command" type="button" class="btn btn-ghost" @click="copyFallback(installProgress.command!)">复制命令</button>
              </div>
            </div>
            <!-- 阶段三：结果（完成/失败/取消——取消是用户主权不误报失败） -->
            <div v-else class="am-body">
              <p v-if="installModal.stage === 'done'" class="am-line am-ok">
                {{ installModal.installer.launchSupported ? '✓ 安装完成——点「立即启动」即可就绪。' : '✓ 安装完成——状态已即时更新；用作沙箱后端需重启应用生效。' }}
              </p>
              <p v-else-if="installModal.stage === 'canceled'" class="am-line">已取消——未做任何更改（临时文件已清理）。</p>
              <p v-else class="am-line">✗ 安装失败：{{ installProgress?.detail ?? '未知原因' }}</p>
            </div>
            <div class="am-actions">
              <button v-if="installModal.stage === 'confirm'" type="button" class="btn btn-primary" @click="doInstall">开始安装</button>
              <!-- launchConfirm 主钮（v0.1.90 linux docker——polkit 确认后执行，行转「启动中…」） -->
              <button v-if="installModal.stage === 'launchConfirm'" type="button" class="btn btn-primary" @click="doLaunchConfirmed">开始启动</button>
              <!-- done + 声明启动策略（2026-10-27 启动引导）：立即启动主钮——装完即启，
                   DD 默认位解析免重启应用（行转「启动中…」行内态） -->
              <button v-if="installModal.stage === 'done' && installModal.installer.launchSupported" type="button" class="btn btn-primary" @click="doLaunchFromDone">立即启动</button>
              <!-- installing 双钮（2026-10-20 用户报障）：后台下载（关模态任务继续——行上
                   「安装中…」可点重开）+ 取消（流量敏感客户随时中止）。
                   2026-10-27 同一模态可回看启动实况——launch 相位下措辞如实切换 -->
              <template v-if="installModal.stage === 'installing'">
                <button type="button" class="btn btn-ghost" @click="installModal.open = false">{{ installProgress?.phase === 'launch' ? '后台等待' : '后台下载' }}</button>
                <button type="button" class="btn btn-danger-ghost" @click="doCancelInstall">{{ installProgress?.phase === 'launch' ? '取消等待' : '取消' }}</button>
              </template>
              <button v-if="installModal.stage !== 'installing'" type="button" class="btn btn-ghost" @click="installModal.open = false">{{ ['confirm', 'launchConfirm'].includes(installModal.stage) ? '取消' : '关闭' }}</button>
            </div>
          </div>
        </div>

        <!-- 行级 Box 数据目录模态（2026-10-20 ⚙ → 模态；2026-10-21 改版：同页目录模态同规格——
             标签/浏览/恢复默认/Esc/外点关；术语改「Box 数据目录」与安装位置明确区分） -->
        <div v-if="dirModal.open" class="approval-scrim" role="presentation" @mousedown.self="dirModal.open = false">
          <div class="approval-modal" role="dialog" aria-modal="true" aria-label="设置 Box 数据目录" @keydown.escape="dirModal.open = false">
            <div class="am-head"><span class="am-title">「{{ dirModal.name }}」Box 数据目录</span></div>
            <div class="am-body">
              <p class="am-line">Box 发行版（VHDX / 快照）的落盘位置——与运行时程序本体的<b>安装位置</b>是两回事。</p>
              <div class="am-field">
                <label class="field-label" for="rtBoxDir">Box 数据目录（绝对路径）</label>
                <div class="field-pick">
                  <input id="rtBoxDir" v-model="dirModal.value" class="wiz-input mono" placeholder="应用默认" maxlength="300" autocomplete="off" spellcheck="false" @keydown.enter.prevent="saveDirModal" />
                  <button type="button" class="btn btn-ghost" @click="pickInto((p) => (dirModal.value = p))">浏览…</button>
                </div>
              </div>
              <p v-if="dirModal.current !== ''" class="am-line am-note">当前：{{ dirModal.current }}</p>
              <p class="am-line am-note">留空用应用默认（userData/boxes）；单盒可在建 Agent 时另行指定；保存后重启生效。</p>
            </div>
            <div class="am-actions">
              <button type="button" class="btn btn-primary" :disabled="dirModal.busy" @click="saveDirModal">保存</button>
              <button type="button" class="btn btn-ghost" :disabled="dirModal.busy" @click="dirModal.open = false">取消</button>
              <span class="am-spacer"></span>
              <button type="button" class="btn btn-ghost" :disabled="dirModal.busy" @click="resetDirModal">恢复默认</button>
            </div>
          </div>
        </div>

        <!-- 其他载体（SSH 主机/模拟——运行时已进上方矩阵，不再双列） -->
        <div class="settings-card">
          <div v-for="row in backendRows" :key="row.id" class="backend-row">
            <div class="appearance-main">
              <div class="appearance-name">{{ row.label }}</div>
              <div class="appearance-desc">{{ row.note }}</div>
              <div v-if="row.available && row.capChips.length" class="backend-caps">
                <span
                  v-for="c in row.capChips"
                  :key="c.label"
                  class="cap-chip"
                  :class="{ 'is-on': c.on }"
                >{{ c.label }} {{ c.on ? '✓' : '✗' }}</span>
              </div>
            </div>
            <span
              class="chip"
              :class="row.available ? 'chip-success' : ''"
              :title="row.reason"
            >{{ row.available ? '可用' : '不可用' }}</span>
          </div>
        </div>
      </template>
      <p v-else class="settings-empty">沙箱状态未加载（网关未连接）</p>


      <!-- 镜像注册表（plan-image-firstclass P8-3）：条目 = 载体 + 连接事实 + 控制协议——
           Agent 绑定镜像条目随 P8-4 开放；add/update 即时维护路由表（无需重启） -->
      <div class="set-sec-row">
        <div class="set-sec">镜像注册表</div>
        <HelpTip
          text="注册可被 Agent 绑定的机器载体（容器镜像 / SSH 主机——VMWare、云主机 / 宿主屏幕）。条目 = 载体 + 连接事实 + 控制协议；「测试」做真实连通与工具集探测（如实报告，不假装可用）。「扫描可用镜像」按需列出本机 Docker / Podman（含 WSL 发行版内独立安装的 docker——Docker Desktop 的镜像走宿主 CLI）实际在场的镜像，只报告事实；行上「注册」预填表单，保存后才入注册表。SSH 载体以密钥免密为前提（key-only，无密码输入面）；GUI 面需远端已跑 `tools/provision-gui.sh` 预置桌面工具集；宿主屏幕载体注入恒经审批确认。"
        />
        <button class="btn btn-secondary btn-sm" style="margin-left: auto" data-role="image-scan" :disabled="kernel.imageScanning" @click="scanAvailableImages">{{ kernel.imageScanning ? '扫描中…' : '⟳ 扫描可用镜像' }}</button>
        <button class="btn btn-secondary btn-sm" style="margin-left: 8px" @click="openImageCreate">＋ 添加镜像</button>
      </div>
      <!-- 可用镜像探测结果（按需扫描后呈现）：来源行（可用性 + 如实原因）+ 镜像行（注册预填）——
           只报告事实不自动入库；已注册引用不再给注册按钮 -->
      <div v-if="kernel.imageScan !== null" class="settings-card" data-role="image-scan-result">
        <div v-for="src in kernel.imageScan" :key="src.source" class="cfg-row" data-role="image-source">
          <div class="cfg-main">
            <div class="cfg-name">{{ SOURCE_LABELS[src.source] ?? src.source }}</div>
            <div v-if="!src.ok" class="cfg-desc">{{ src.reason }}</div>
            <div v-else-if="(src.images ?? []).length === 0" class="cfg-desc">引擎可用，尚未拉取/构建任何镜像</div>
            <div v-else class="cfg-desc">在场 {{ (src.images ?? []).length }} 个镜像</div>
          </div>
          <div class="cfg-actions">
            <span class="chip" :class="src.ok ? 'chip-success' : 'chip-danger'" :title="src.ok ? '' : src.reason">{{ src.ok ? '可用' : '不可用' }}</span>
          </div>
        </div>
        <div v-for="im in scannedImageRows" :key="im.source + im.ref" class="cfg-row" data-role="image-scan-row">
          <div class="cfg-main">
            <div class="cfg-name mono">{{ im.ref }}</div>
            <div class="cfg-desc">{{ SOURCE_LABELS[im.source] ?? im.source }}<template v-if="im.size"> · {{ im.size }}</template><template v-if="im.created"> · {{ im.created }}</template></div>
          </div>
          <div class="cfg-actions">
            <span v-if="isImageRegistered(im.ref)" class="chip chip-success">已注册</span>
            <button v-else class="btn btn-ghost btn-sm" data-role="image-register" @click="registerScanned(im.ref)">注册</button>
          </div>
        </div>
      </div>
      <div class="settings-card">
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
      <p v-if="kernel.images.length === 0" class="settings-empty">尚无镜像条目——可先「扫描可用镜像」带入本机容器镜像，或手动注册 SSH 主机（VMWare/云电脑）与容器镜像</p>

      </div>
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
                <label class="proto-opt" :class="{ 'is-on': imageForm.carrier === 'windows' }">
                  <input type="radio" name="if-carrier" value="windows" v-model="imageForm.carrier" />
                  Windows 主机
                </label>
                <label class="proto-opt" :class="{ 'is-on': imageForm.carrier === 'android' }">
                  <input type="radio" name="if-carrier" value="android" v-model="imageForm.carrier" />
                  Android 设备
                </label>
                <label class="proto-opt" :class="{ 'is-on': imageForm.carrier === 'host-screen' }">
                  <input type="radio" name="if-carrier" value="host-screen" v-model="imageForm.carrier" />
                  宿主屏幕
                </label>
              </div>
            </div>
            <div v-if="imageForm.carrier === 'host-screen'" class="field">
              <p class="field-note">
                把本机屏幕（主屏）注册为可操控载体：Agent 可截图查看与注入鼠标键盘（远程控制窗口里的一切都落在宿主屏幕上）。
                屏幕上的一切输入注入都会先经审批确认（默认「变更前确认」模式逐次弹窗）；本载体无命令执行面。
              </p>
            </div>
            <div v-if="imageForm.carrier === 'host-screen'" class="field">
              <label class="field-label" for="ifWindow">绑定窗口（可选——空缺 = 整屏）</label>
              <div class="cfg-inline">
                <select id="ifWindow" v-model="imageForm.windowTitle" class="field-input">
                  <option value="">整屏（主屏全部）</option>
                  <option v-for="w in hostWindows" :key="w.title" :value="w.title">{{ w.title }}（{{ w.width }}×{{ w.height }}）</option>
                </select>
                <button class="btn btn-secondary btn-sm" type="button" data-role="enum-windows" :disabled="hostWindowsLoading" @click="enumHostWindows">{{ hostWindowsLoading ? '枚举中…' : '⟳ 枚举窗口' }}</button>
              </div>
              <p class="field-note">绑定后几何/截图/注入域收敛到该窗口（标题子串匹配——窗口重开同名即恢复）；窗口未在场时操作如实拒绝。键入仍需目标窗口在前台（不自动抢焦点）。</p>
            </div>
            <template v-else-if="imageForm.carrier === 'ssh' || imageForm.carrier === 'windows'">
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
              <div v-if="imageForm.carrier === 'windows'" class="field">
                <p class="field-note">
                  目标机须安装 OpenSSH Server（设置 → 应用 → 可选功能）并放行 22 端口；GUI 面经 PowerShell
                  截屏与 SendInput 注入——目标机桌面须保持登录态。远端整机是独立机器，注入不经本机审批闸（绑定后按 caps 呈现）。
                </p>
              </div>
            </template>
            <template v-else-if="imageForm.carrier === 'android'">
              <div class="field">
                <label class="field-label" for="ifHost">设备序列号或 wifi 地址</label>
                <div class="cfg-inline">
                  <input id="ifHost" v-model="imageForm.host" class="field-input mono" placeholder="点下方扫描选择，或手填" autocomplete="off" spellcheck="false" />
                  <button class="btn btn-secondary btn-sm" type="button" data-role="adb-scan" :disabled="adbScanning" @click="scanAdbDevices">{{ adbScanning ? '扫描中…' : '⟳ 扫描设备' }}</button>
                </div>
                <!-- 在场设备（智能恢复：USB/已连 wifi/mDNS——点选零输入） -->
                <div v-if="adbDevices.length > 0" class="adb-device-list">
                  <button
                    v-for="d in adbDevices"
                    :key="d.serial"
                    type="button"
                    class="adb-device-row"
                    data-role="adb-device"
                    :title="'状态 ' + d.state"
                    @click="imageForm.host = d.serial"
                  >
                    <span class="mono">{{ d.serial }}</span>
                    <span class="adb-device-meta">{{ d.model || d.product || '' }} · {{ d.state }}</span>
                  </button>
                </div>
                <button class="btn btn-ghost btn-sm" type="button" data-role="adb-pair-open" @click="openAdbPair">⧉ 无线配对新设备</button>
              </div>
              <div class="field">
                <p class="field-note">
                  目标设备须开启 USB 调试（或 <span class="mono">adb tcpip 5555</span> 后用 wifi 地址）；序列号用
                  <span class="mono">adb devices</span> 查看。GUI 面经设备内建 screencap/input/screenrecord——设备端零预装；
                  中文键入不受支持（input text 仅 ASCII，如实报错）；远端设备是独立机器，注入不经本机审批闸。
                </p>
              </div>
            </template>
            <div v-else class="field">
              <label class="field-label" for="ifImage">镜像名</label>
              <input id="ifImage" v-model="imageForm.image" class="field-input mono" placeholder="openbot-gui:24.04" autocomplete="off" spellcheck="false" />
              <!-- 运行时显式声明（v0.1.53 用户裁定「不自动找路」）：缺省预选探测到的可用项，可改；
                   容器条目路由按此声明构造后端，声明与实际缺席时 create 如实报错 -->
              <div class="cfg-inline" style="margin-top: 6px">
                <span class="field-label" style="margin: 0">运行时</span>
                <select id="ifRuntime" v-model="imageForm.runtime" class="field-input" style="width: auto" aria-label="OCI 运行时">
                  <option value="docker">Docker</option>
                  <option value="podman">Podman</option>
                </select>
              </div>
            </div>
            <div v-if="imageForm.carrier === 'windows'" class="field">
              <span class="field-label">控制协议</span>
              <div class="proto-seg" role="radiogroup" aria-label="控制协议">
                <label class="proto-opt" :class="{ 'is-on': imageForm.controlProtocol === 'win' }">
                  <input type="radio" name="if-proto" value="win" v-model="imageForm.controlProtocol" />
                  Win 注入（SendInput）
                </label>
                <label class="proto-opt" :class="{ 'is-on': imageForm.controlProtocol === 'none' }">
                  <input type="radio" name="if-proto" value="none" v-model="imageForm.controlProtocol" />
                  无（纯命令行）
                </label>
              </div>
            </div>
            <div v-else-if="imageForm.carrier === 'android'" class="field">
              <span class="field-label">控制协议</span>
              <div class="proto-seg" role="radiogroup" aria-label="控制协议">
                <label class="proto-opt" :class="{ 'is-on': imageForm.controlProtocol === 'android' }">
                  <input type="radio" name="if-proto" value="android" v-model="imageForm.controlProtocol" />
                  Android 注入（input）
                </label>
                <label class="proto-opt" :class="{ 'is-on': imageForm.controlProtocol === 'none' }">
                  <input type="radio" name="if-proto" value="none" v-model="imageForm.controlProtocol" />
                  无（纯命令行）
                </label>
              </div>
            </div>
            <div v-else-if="imageForm.carrier !== 'host-screen'" class="field">
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
            <div v-else class="field">
              <span class="field-label">控制协议</span>
              <span class="chip">宿主内置注入（SendInput）</span>
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

      </div>
      <!-- Android 无线配对模态（P9-3c）：扫码主模式（摄像头 + jsQR）/ 手动兜底（ip:配对端口 + 码） -->
      <div v-if="adbPairOpen" class="wiz-overlay" @mousedown.self="closeAdbPair()">
        <div class="wiz-card adb-pair-card" role="dialog" aria-label="Android 无线配对" @keydown.escape="closeAdbPair()">
          <div class="wiz-head">
            <span class="wiz-title">无线配对</span>
            <button class="wiz-close" type="button" aria-label="关闭" @click="closeAdbPair()">✕</button>
          </div>
          <div class="wiz-body">
            <div class="field">
              <div class="proto-seg" role="radiogroup" aria-label="配对方式">
                <label class="proto-opt" :class="{ 'is-on': adbPairTab === 'scan' }">
                  <input type="radio" name="adb-pair-tab" value="scan" v-model="adbPairTab" @change="adbPairTab === 'scan' ? undefined : stopAdbScanCam()" />
                  扫码（推荐）
                </label>
                <label class="proto-opt" :class="{ 'is-on': adbPairTab === 'manual' }">
                  <input type="radio" name="adb-pair-tab" value="manual" v-model="adbPairTab" @change="adbPairTab === 'manual' ? stopAdbScanCam() : undefined" />
                  手动输入
                </label>
              </div>
            </div>
            <template v-if="adbPairTab === 'scan'">
              <p class="field-note">手机：开发者选项 → 无线调试 → 「使用配对码配对设备」→ 把屏幕上的二维码对准摄像头。</p>
              <div class="adb-scan-viewport" data-role="adb-scan-viewport">
                <video
                  ref="adbVideoEl"
                  class="adb-scan-video"
                  autoplay
                  muted
                  playsinline
                ></video>
                <div v-if="adbScanCam === 'idle'" class="adb-scan-hint">
                  <button class="btn btn-secondary btn-sm" type="button" data-role="adb-scan-start" @click="startAdbScanCam">开启摄像头</button>
                </div>
                <div v-else-if="adbScanCam === 'denied'" class="adb-scan-hint">摄像头不可用（无设备或被拒绝）——切「手动输入」照手机屏幕填写</div>
                <div v-else-if="adbPairTarget === ''" class="adb-scan-hint">对准手机上的二维码…</div>
              </div>
            </template>
            <template v-else>
              <p class="field-note">照手机「使用配对码配对设备」面板填写：IP 地址和端口 + 配对码。</p>
              <div class="field">
                <label class="field-label" for="adbPairTarget">配对地址（IP:端口）</label>
                <input id="adbPairTarget" v-model="adbPairTarget" class="field-input mono" placeholder="192.168.31.141:37547" autocomplete="off" spellcheck="false" />
              </div>
            </template>
            <div class="field">
              <label class="field-label" for="adbPairCode">配对码（6 位）</label>
              <input id="adbPairCode" v-model="adbPairCode" class="field-input mono" placeholder="455194" maxlength="8" autocomplete="off" />
            </div>
            <p v-if="adbPairError" class="form-error">{{ adbPairError }}</p>
          </div>
          <div class="wiz-foot">
            <button class="btn btn-primary" :disabled="adbPairBusy || adbPairTarget.trim() === '' || adbPairCode.trim() === ''" data-role="adb-pair-submit" @click="submitAdbPair">{{ adbPairBusy ? '配对中…' : '配对' }}</button>
            <button class="btn btn-ghost" @click="closeAdbPair()">取消</button>
          </div>
        </div>
      </div>


      <div v-show="activeSection === 'automation'" class="settings-section">
      <!-- 定时自动化（backlog ②）：规则到点 → 以用户身份给 agent 发消息（走既有审批管线）——
           说明收进 ⓘ；列表 + 模态（cron 即时预览下次触发——防写错） -->
      <div class="set-sec-row">
        <div class="set-sec">自动化</div>
        <HelpTip
          text="定时规则到点后，以你的身份给指定 Agent 发一条委托消息——排队、审批、执行与手动发消息完全一致（零旁路）。时间表达式为五段「分 时 日 月 周」（本机时区）；应用未运行期间错过的不补跑；规则上限 16 条。"
        />
        <button class="btn btn-secondary btn-sm" style="margin-left: auto" @click="openAutomation(null)">＋ 新建</button>
      </div>
      <div class="settings-card">

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
      <p v-if="kernel.automations.length === 0" class="settings-empty">还没有自动化规则——到点让 Agent 干活（如每天 9 点汇总）。</p>
      </div>


      </div>
      <div v-show="activeSection === 'policy'" class="settings-section">
      <!-- 权限策略（呈现现状，不放假开关）——说明收进 ⓘ（0.1.2 改版） -->
      <div class="set-sec-row">
        <div class="set-sec">权限策略</div>
        <HelpTip
          text="当前为手工审批闸门：Agent 在 Box 内自由执行；触碰宿主机文件或出网时在对话流内逐条请求批准，挂起期间计入执行时限。进程崩溃重启后未决审批自动重发（账本持久真相）。策略分级开关属后续版本。"
        />
      </div>
      <div class="settings-card">
        <div class="appearance-row">
          <div class="appearance-main">
            <div class="appearance-name">审批闸门</div>
            <div class="appearance-desc">Agent 在 Box 内自由执行；触碰宿主机文件或出网时逐条请求批准，挂起期间计入执行时限；应用重启后未决审批自动重发（账本持久真相）。策略分级开关属后续版本。</div>
          </div>
          <span class="chip" :class="kernel.approvalMode === 'manual' ? 'chip-accent' : ''">{{ kernel.approvalMode === 'manual' ? '手工审批' : '自动批准' }}</span>
        </div>
      </div>

      <!-- 系统通知（2026-11-02 用户需求）：run 终态经系统通知提醒——保存即热生效 -->
      <div class="settings-card">
        <div class="appearance-row">
          <div class="appearance-main">
            <div class="appearance-name">系统通知</div>
            <div class="appearance-desc">Agent 的任务到达终态（完成 / 失败 / 中止 / 转后台）时发送系统通知，正文带终答摘要——挂后台等结果不用盯窗口。Windows / macOS / Linux 通用；Linux 需桌面环境自带通知服务。开启立即生效。</div>
          </div>
          <button
            class="switch"
            :class="{ 'is-on': kernel.systemNotify }"
            role="switch"
            :aria-checked="kernel.systemNotify"
            aria-label="允许系统通知"
            @click="toggleSystemNotify"
          ></button>
        </div>
      </div>

      <!-- 执行预算（2026-11-02 三段值域定稿）：-1 无限制 / 0 禁用工具（仅轮数）/ 1~上限；保存热生效 -->
      <div class="set-sec-row">
        <div class="set-sec">执行预算</div>
        <HelpTip text="单次任务（run）的执行护栏，三段取值：工具轮预算 0 = 禁用工具（模型不带任何工具，纯对话）、1~1024 = 轮数上限（顶格再 ＋ 即无限制）、无限制 = 不再因轮数终止；到达非零上限时 Agent 不会无声失败——先经审批闸门弹窗问您（批准=再给一轮额度原地继续，拒绝=结束并交代进展）。总时长上限 1~1440 分钟，0 与超过 1440 均为无限制（缺省）；无进展超过 5 分钟仍会自动转后台并告知（卡死检测，不是时长限制）。保存后新任务立即生效；进行中的任务保持开始时的预算。" />
      </div>
      <div class="settings-card">
        <div class="appearance-row">
          <div class="appearance-main">
            <div class="appearance-name">工具轮预算</div>
            <div class="appearance-desc">每次任务的工具循环轮数上限：0 = 禁用工具（纯对话）、1~1024 = 轮数、无限制 = 不再因轮数终止。保存后新任务立即生效。</div>
          </div>
          <div class="budget-edit">
            <NumStepper v-model="maxRoundsDraft" :min="0" :max="1024" :unlimited-value="-1" muted-zero num-class="budget-num" aria-label="工具轮预算" />
            <button class="btn btn-primary btn-sm" :disabled="maxRoundsDraft === kernel.maxToolRounds" @click="saveMaxRounds">保存</button>
          </div>
        </div>
        <div class="appearance-row">
          <div class="appearance-main">
            <div class="appearance-name">总时长上限</div>
            <div class="appearance-desc">单次任务的总运行时长上限（分钟）：1~1440 分钟、无限制 = 不限时（缺省）；无进展超过 5 分钟的卡死检测不受此影响。保存后新任务立即生效。</div>
          </div>
          <div class="budget-edit">
            <NumStepper v-model="deadlineDraft" :min="1" :max="1440" :unlimited-value="-1" unlimited-at="both" num-class="budget-num" aria-label="总时长上限（分钟）" />
            <button class="btn btn-primary btn-sm" :disabled="deadlineDraft === kernel.runDeadlineMin" @click="saveDeadline">保存</button>
          </div>
        </div>
      </div>

      </div>
      <div v-show="activeSection === 'data'" class="settings-section">
      <!-- 数据（P4 Step 11，裁定 E 一期只读：路径展示 + 打开文件夹；导出/清空属后续版本） -->
      <div class="set-sec-row">
        <div class="set-sec">数据</div>
        <HelpTip
          text="对话与执行记录（会话记录/transcript）以 JSONL 追加落盘（append-only——只增不改，永不就地改写历史）；全部数据只在本机，不上传。导出全部 / 清空会话记录属后续版本。"
        />
      </div>
      <div class="settings-card">

      <template v-if="dataPaths">
        <div class="kv">
          <span class="k">数据目录</span>
          <span class="v mono kv-path">{{ dataPaths.data }}</span>
          <span class="kv-actions">
            <button class="btn btn-ghost btn-sm kv-icon" aria-label="打开数据文件夹" title="打开数据文件夹" @click="openFolder(dataPaths.data)"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg></button>
            <button class="btn btn-ghost btn-sm kv-icon" aria-label="设置数据目录" title="设置数据目录（重启生效）" @click="openDataRoot"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.08a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.08a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></button>
          </span>
        </div>
        <!-- 会话记录（transcript 中文化 v0.1.63）：默认落数据目录 agents/（路径由数据目录派生）；
             v0.1.63 起可独立设置目录（transcript-root.txt 标记）——「打开」直达 agents/（白名单同数据目录行） -->
        <div class="kv">
          <span class="k">会话记录</span>
          <span class="v mono kv-path">{{ dataPaths.transcript }}</span>
          <span class="kv-actions">
            <button class="btn btn-ghost btn-sm kv-icon" aria-label="打开会话记录文件夹" title="打开会话记录文件夹" @click="openFolder(dataPaths.transcript)"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg></button>
            <button class="btn btn-ghost btn-sm kv-icon" aria-label="设置会话记录目录" title="设置会话记录目录（重启生效）" @click="openTranscriptRoot"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.08a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.08a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></button>
          </span>
        </div>
      </template>
      <p v-else class="settings-empty">开发模式（无壳）——数据路径由桌面壳提供</p>

      <!-- 数据目录设置（模态——provider 模态同款容器；重启生效，旧数据不自动迁移） -->
      <div v-if="dataRootOpen" class="wiz-overlay" @mousedown.self="dataRootOpen = false">
        <div class="wiz-card" role="dialog" aria-label="数据目录设置" @keydown.escape="dataRootOpen = false">
          <div class="wiz-head">
            <span class="wiz-title">设置数据目录</span>
            <button class="wiz-close" type="button" aria-label="关闭" @click="dataRootOpen = false">✕</button>
          </div>
          <div class="wiz-body provider-form">
            <div class="field">
              <label class="field-label" for="drPath">数据目录（绝对路径）</label>
              <div class="field-pick">
                <input id="drPath" v-model="dataRootDraft" class="field-input mono" placeholder="D:\\OpenBotData" autocomplete="off" spellcheck="false" />
                <button class="btn btn-ghost" type="button" @click="browseDirectory('data')">浏览…</button>
              </div>
              <p class="wiz-note">重启应用后生效。保存时自动把全部数据（设置、Agent 档案、记忆、会话记录等）迁移到新目录——已独立的会话记录目录不受影响；「恢复默认」同样自动迁回。迁移失败时不会切换，原目录数据无损。</p>
            </div>
            <p v-if="dataRootError" class="form-error">{{ dataRootError }}</p>
          </div>
          <div class="wiz-foot">
            <button class="btn btn-primary" :disabled="dataRootSaving || dataRootDraft.trim() === ''" @click="saveDataRoot()">{{ dataRootSaving ? '保存中…' : '保存' }}</button>
            <button class="btn btn-ghost" @click="dataRootOpen = false">取消</button>
            <span class="wiz-spacer"></span>
            <button class="btn btn-ghost" :disabled="dataRootSaving" @click="saveDataRootDefault()">恢复默认</button>
          </div>
        </div>
      </div>

      <!-- 会话记录目录设置（v0.1.63，模态同数据目录款；重启生效，旧记录不自动迁移） -->
      <div v-if="transcriptRootOpen" class="wiz-overlay" @mousedown.self="transcriptRootOpen = false">
        <div class="wiz-card" role="dialog" aria-label="会话记录目录设置" @keydown.escape="transcriptRootOpen = false">
          <div class="wiz-head">
            <span class="wiz-title">设置会话记录目录</span>
            <button class="wiz-close" type="button" aria-label="关闭" @click="transcriptRootOpen = false">✕</button>
          </div>
          <div class="wiz-body provider-form">
            <div class="field">
              <label class="field-label" for="trPath">会话记录目录（绝对路径）</label>
              <div class="field-pick">
                <input id="trPath" v-model="transcriptRootDraft" class="field-input mono" placeholder="D:\\OpenBotTranscript" autocomplete="off" spellcheck="false" />
                <button class="btn btn-ghost" type="button" @click="browseDirectory('transcript')">浏览…</button>
              </div>
              <p class="wiz-note">重启应用后生效。保存时自动把现有会话记录（各 Agent 的 transcript.jsonl）迁移到新目录；Agent 档案与记忆仍留在数据目录，不受影响。「恢复默认」同样自动迁回数据目录内。</p>
            </div>
            <p v-if="transcriptRootError" class="form-error">{{ transcriptRootError }}</p>
          </div>
          <div class="wiz-foot">
            <button class="btn btn-primary" :disabled="transcriptRootSaving || transcriptRootDraft.trim() === ''" @click="saveTranscriptRoot()">{{ transcriptRootSaving ? '保存中…' : '保存' }}</button>
            <button class="btn btn-ghost" @click="transcriptRootOpen = false">取消</button>
            <span class="wiz-spacer"></span>
            <button class="btn btn-ghost" :disabled="transcriptRootSaving" @click="saveTranscriptRootDefault()">恢复默认</button>
          </div>
        </div>
      </div>
      </div>


      </div>
      <div v-show="activeSection === 'general'" class="settings-section">
      <!-- 通用（0.1.0 产品化）：系统自启动——注册表现状即真相，开关即时生效 -->
      <div class="set-sec">通用</div>
      <div class="settings-card">
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
      </div>


      </div>
      <div v-show="activeSection === 'appearance'" class="settings-section">
      <!-- 外观（呈现层偏好，即时生效）——说明收进 ⓘ（0.1.2 改版）；主题选项同步列表化 -->
      <div class="set-sec-row">
        <div class="set-sec">外观</div>
        <HelpTip
          text="日间/夜间主题即时生效，「跟随系统」随 Windows 主题自动切换；标题栏的太阳/月亮按钮可随时快捷切换。此偏好只存本机（浏览器存储），不进内核设置。"
        />
      </div>
      <div class="appearance-card">
        <div class="appearance-row">
          <div class="appearance-main">
            <div class="appearance-name">界面主题</div>
            <div class="appearance-desc">选择浅色、深色或跟随系统主题。标题栏的太阳/月亮按钮可随时快捷切换。</div>
          </div>
          <select v-model="themeChoice" class="appearance-select" aria-label="界面主题">
            <option v-for="opt in THEME_OPTIONS" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
          </select>
        </div>
        <div class="appearance-row">
          <div class="appearance-main">
            <div class="appearance-name">界面语言</div>
            <div class="appearance-desc">界面文案的显示语言。English 完整翻译筹备中。</div>
          </div>
          <select class="appearance-select" aria-label="界面语言" disabled>
            <option selected>简体中文</option>
            <option disabled>English（翻译筹备中）</option>
          </select>
        </div>
      </div>

      </div>
      <!-- 自动化模态（新建/编辑共用；表单生成 cron + 即时预览；v0.1.96 三轮：cron-modal 加宽 600px） -->
      <div v-if="automationModal" class="wiz-overlay" @mousedown.self="automationModal = false">
        <div class="wiz-card cron-modal" role="dialog" aria-label="自动化规则" @keydown.escape="automationModal = false">
          <div class="wiz-head">
            <span class="wiz-title">{{ editingAutomation === null ? '新建自动化' : '编辑自动化' }}</span>
            <button class="wiz-close" type="button" aria-label="关闭" @click="automationModal = false">✕</button>
          </div>
          <div class="wiz-body relay-form">
            <label class="relay-field">
              <span class="field-label">规则名</span>
              <input v-model="aForm.name" class="field-input" placeholder="例：每日早报" maxlength="32" />
            </label>
            <!-- 触发时间（2026-10-28 v0.1.96 用户报障「cron 对用户太困难」；同日二轮打磨：
                 下拉+行文式内联 → 分段控件 + 分行字段——层次清晰、字段不折行错位）。
                 表单态单向生成 cron（落盘仍是 cron 串，内核仍是解析权威） -->
            <div class="relay-field">
              <span class="field-label">触发时间</span>
              <!-- 快捷预设：点击填表单态（选中态高亮——改字段即取消，如实反映） -->
              <div class="cron-presets">
                <button
                  v-for="p in CRON_PRESETS"
                  :key="p.label"
                  type="button"
                  class="cron-preset"
                  :class="{ 'is-on': activePreset === p.label }"
                  @click="applyPreset(p)"
                >{{ p.label }}</button>
              </div>
              <!-- 频率分段控件（六档等宽；选中 accent） -->
              <div class="cron-seg" role="tablist" aria-label="频率类型">
                <button
                  v-for="s in FREQ_SEGMENTS"
                  :key="s.v"
                  type="button"
                  role="tab"
                  :aria-selected="cronForm.freq === s.v"
                  class="cron-seg-btn"
                  :class="{ 'is-on': cronForm.freq === s.v }"
                  @click="cronForm.freq = s.v"
                >{{ s.label }}</button>
              </div>
              <!-- 条件字段（每行一职：label 定宽 + 控件——不再行文式内联；容器带高度形变过渡） -->
              <div ref="cronFieldsEl" class="cron-fields">
                <div v-if="cronForm.freq === 'minutes'" class="cron-field">
                  <span class="cron-field-label">间隔</span>
                  <NumStepper v-model="cronForm.every" :min="1" :max="59" aria-label="间隔分钟数" />
                  <span class="cron-note">分钟</span>
                </div>
                <template v-else-if="cronForm.freq === 'hours'">
                  <div class="cron-field">
                    <span class="cron-field-label">间隔</span>
                    <NumStepper v-model="cronForm.every" :min="1" :max="23" aria-label="间隔小时数" />
                    <span class="cron-note">小时</span>
                  </div>
                  <div class="cron-field">
                    <span class="cron-field-label">分钟位</span>
                    <NumStepper v-model="cronForm.hourMinute" :min="0" :max="59" aria-label="每小时的第几分" />
                    <span class="cron-note">分（每小时第几分触发）</span>
                  </div>
                </template>
                <template v-else-if="cronForm.freq === 'weekly'">
                  <div class="cron-field">
                    <span class="cron-field-label">周几</span>
                    <div class="cron-weekdays">
                      <button
                        v-for="w in WEEKDAYS"
                        :key="w.v"
                        type="button"
                        class="cron-wd"
                        :class="{ 'is-on': cronForm.weekdays.includes(w.v) }"
                        :aria-pressed="cronForm.weekdays.includes(w.v)"
                        @click="toggleWeekday(w.v)"
                      >{{ w.label }}</button>
                    </div>
                  </div>
                  <div class="cron-field">
                    <span class="cron-field-label">时间</span>
                    <TimePicker v-model="dailyTime" />
                  </div>
                </template>
                <template v-else-if="cronForm.freq === 'monthly'">
                  <div class="cron-field">
                    <span class="cron-field-label">几号</span>
                    <NumStepper v-model="cronForm.dayOfMonth" :min="1" :max="31" aria-label="几号" />
                    <span class="cron-note">号（月无此日则该月跳过）</span>
                  </div>
                  <div class="cron-field">
                    <span class="cron-field-label">时间</span>
                    <TimePicker v-model="dailyTime" />
                  </div>
                </template>
                <div v-else-if="cronForm.freq === 'custom'" class="cron-field">
                  <span class="cron-field-label">表达式</span>
                  <input v-model="aForm.cron" class="field-input mono cron-custom" placeholder="0 9 * * *" spellcheck="false" @keydown.enter.prevent />
                </div>
                <div v-else class="cron-field">
                  <span class="cron-field-label">时间</span>
                  <TimePicker v-model="dailyTime" />
                </div>
              </div>
              <p v-if="cronForm.freq !== 'custom'" class="cron-gen mono">表达式：{{ aForm.cron }}</p>
            </div>
            <p v-if="aForm.cron.trim() !== ''" class="cron-preview mono">
              <template v-if="cronPreviewLoading"><i class="cron-skel"></i><i class="cron-skel skel-b"></i></template>
              <template v-else-if="cronPreview !== null">下次触发：{{ cronPreview.readable }}<template v-if="cronPreview.upcomingAt.length > 0"> · 随后 {{ cronPreview.upcomingAt.map(fmtNext).join(' / ') }}</template></template>
            </p>
            <label class="relay-field">
              <span class="field-label">目标 Agent</span>
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

      <!-- 调试信息（2026-10-13 用户需求）：诊断事实的收纳节——seq 自状态栏退役后迁此；
           语义说明随值呈现，普通人可懂、排障者够用 -->
      <div v-show="activeSection === 'debug'" class="settings-section">
      <div class="set-sec">调试信息</div>
      <div class="settings-card">
      <div class="kv">
        <span class="k">事件流序号<HelpTip text="内核推送事件的最后编号（`seq`）：断线重连后从下一序号续传，事件不丢失、不重复。仅作诊断用途。" /></span>
        <span class="v mono">{{ kernel.lastSeq }}</span>
      </div>
      <div class="kv"><span class="k">连接状态</span><span class="v">{{ kernel.connected ? '内核已连接' : '内核未连接' }}</span></div>
      </div>

      </div>
      <div v-show="activeSection === 'about'" class="settings-section">
      <!-- 关于 -->
      <div class="set-sec">关于</div>
      <div class="settings-card">

      <div class="kv"><span class="k">版本</span><span class="v mono">{{ appVersion ? `v${appVersion}` : '开发模式（无壳）' }}</span></div>
      <div class="kv"><span class="k">许可</span><span class="v">Apache-2.0 · 净室自研</span></div>
      <!-- 检查更新（v0.1.62 用户需求）：开发版无更新通道——诚实占位，不假装检查、不造假版本源 -->
      <div class="kv">
        <span class="k">更新</span>
        <span class="v"><button class="btn btn-ghost btn-sm" type="button" @click="toast.push('开发版：更新通道暂未开放（后续版本提供）', 'info')">检查更新</button></span>
      </div>
      <!-- 隐私（真话直陈）：本地优先是架构事实，不设云端政策页占位——key 系统加密、数据不出本机 -->
      <div class="kv"><span class="k">隐私</span><span class="v">本地优先 · 数据不出本机（API key 系统加密落盘）</span></div>
      </div>

      </div>
    </div>
    </div>
  </section>
</template>

<style scoped src="./settings.css"></style>
