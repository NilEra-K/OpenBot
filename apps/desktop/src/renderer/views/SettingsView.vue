<script setup lang="ts">
/**
 * 设置视图（prototype.html 迁移，P2 范围）：
 * - LLM 推理：provider 档案 CRUD（真实命令面；key 密文经 safeStorage 落盘，跨边界无 key 材料——
 *   编辑时留空即保留原密文）；设为主力对管家与全部 agent 下轮生效。
 * - 沙箱后端：呈现 caps 事实声明。权限策略：呈现 Manual 审批闸门现状——不放假开关（内核无对应存储）。
 */
import { computed, reactive, ref } from 'vue'
import { useKernelStore } from '../stores/kernel'
import type { ProviderView } from '../stores/kernel'

const kernel = useKernelStore()

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

      <!-- 沙箱后端（caps 事实） -->
      <div class="set-sec">沙箱后端</div>
      <div class="set-sec-note">当前后端的能力声明（caps）——UI 按钮与工具可用性的共同依据。真实后端（WSL2/Docker）接入属 P3。</div>
      <div v-for="row in capsRows" :key="row.k" class="kv"><span class="k">{{ row.k }}</span><span class="v mono">{{ row.v }}</span></div>
      <p v-if="!kernel.caps" class="settings-empty">caps 未加载（网关未连接）</p>

      <!-- 权限策略（呈现现状，不放假开关） -->
      <div class="set-sec">权限策略</div>
      <div class="set-sec-note">
        当前为手工审批闸门（Manual）：agent 在 Box 内自由执行；触碰宿主机文件或出网时在对话流内逐条请求批准，
        挂起期间 run 计入 deadline。进程崩溃重启后未决审批自动重发（账本持久真相）。策略分级开关属后续版本。
      </div>

      <!-- 关于 -->
      <div class="set-sec">关于</div>
      <div class="kv"><span class="k">版本</span><span class="v mono">P2 开发版（v0.0.3+）</span></div>
      <div class="kv"><span class="k">许可</span><span class="v">Apache-2.0 · 净室自研</span></div>
    </div>
  </section>
</template>

<style scoped src="./settings.css"></style>
