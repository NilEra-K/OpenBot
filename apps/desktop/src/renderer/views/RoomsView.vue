<script setup lang="ts">
/**
 * 跨用户房间视图（P7 原型对齐轮 · prototype.html 视图 5 迁移）：
 * 房间卡（成员链 / relay 事实 kv / 动作行）+ 接入配置模态（自 SettingsView 迁入——原型 settings
 * 无 relay 段）。演示值纪律：原型「12/30 预算、04:12 倒计时、142ms 延迟」是编造数值——本端是
 * mirror 执行端视角，预算按发起方向计（host 下发给发起端），**余量与 meter 本端不可见即不画**
 * （磁盘无上限只报数值的同款纪律）；呈现的全部是装配与事件事实（连接态/成员表/配置真值）。
 * 「我托管 / 我是访客」双卡为一期后域（本端无建房 UI、无被托管语义——plan-p7 记档）。
 */
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useKernelStore } from '../stores/kernel'
import type { RelayStatus } from '../stores/kernel'
import { useUiStore } from '../stores/ui'
import { useToastStore } from '../stores/toast'

const kernel = useKernelStore()
const ui = useUiStore()
const toast = useToastStore()

/** 房间显示名：备注名缺省回退房间码（房间码是 host 事实，备注名是本端记名） */
const roomLabel = computed(() => kernel.relay?.roomName?.trim() || kernel.relay?.roomId || '')

/** 连接态 chip（事实优先——env 通道接入时 settings.enabled 可能为 false） */
const stateChip = computed<{ text: string; kind: 'accent' | 'info' | 'plain' }>(() => {
  if (kernel.relay?.connected) return { text: '已连接', kind: 'accent' }
  if (kernel.relay?.enabled) return { text: '连接中 · 退避重试', kind: 'info' }
  return { text: '未启用', kind: 'plain' }
})

// ---- 接入配置模态（AgentWizard 容器同款：Esc / 遮罩 / ✕） ----
const configOpen = ref(false)
const formError = ref<string | null>(null)
const saving = ref(false)
const form = reactive({ enabled: false, url: '', roomId: '', inviteCode: '', displayName: '', roomName: '' })

watch(
  () => kernel.relay,
  (r) => {
    if (r) {
      form.enabled = r.enabled
      form.url = r.url
      form.roomId = r.roomId
      form.inviteCode = r.inviteCode
      form.displayName = r.displayName
      form.roomName = r.roomName ?? ''
    }
  },
  { immediate: true },
)

const formDirty = computed(() => {
  const r = kernel.relay
  return (
    r !== null &&
    (r.enabled !== form.enabled ||
      r.url !== form.url ||
      r.roomId !== form.roomId ||
      r.inviteCode !== form.inviteCode ||
      r.displayName !== form.displayName ||
      (r.roomName ?? '') !== form.roomName)
  )
})

const save = async (): Promise<void> => {
  saving.value = true
  formError.value = null
  try {
    await kernel.setRelay({
      enabled: form.enabled,
      url: form.url,
      roomId: form.roomId,
      inviteCode: form.inviteCode,
      displayName: form.displayName,
      ...(form.roomName.trim() !== '' ? { roomName: form.roomName.trim() } : {}),
    })
    toast.push('房间配置已保存——重启应用后生效', 'success')
    configOpen.value = false
  } catch (err) {
    formError.value = err instanceof Error ? err.message : String(err)
  } finally {
    saving.value = false
  }
}

/** 复制邀请信息（房间码 + invite 码——凭据经用户手分享，不经内核外发） */
const copyInvite = async (): Promise<void> => {
  const r = kernel.relay
  if (r === null) return
  const text = `OpenBot 房间邀请\n房间码：${r.roomId}\nInvite 码：${r.inviteCode}\nHost：${r.url}`
  try {
    await navigator.clipboard.writeText(text)
    toast.push('邀请信息已复制——发给好友在其 OpenBot「跨用户房间」配置接入', 'success')
  } catch {
    toast.push('复制失败（剪贴板不可用）——邀请信息见「房间设置」', 'error')
  }
}

/** 打开房间对话：首个远端成员会话（无人则在管家会话看镜像流） */
const openRoomChat = (): void => {
  const peer = kernel.remoteMembers[0]
  ui.openAgent(peer !== undefined ? `remote:${peer.memberId}` : (kernel.stewardId ?? ''))
  ui.switchView('console')
}

onMounted(() => {
  void kernel.refreshRelay() // 连接态易变——进视图现拉
})
</script>

<template>
  <section class="view view-scroll">
    <div class="view-head rooms-head">
      <div class="view-title">跨用户房间</div>
      <div class="view-sub">
        好友跨公网进房间协作（mirror 一期）：本端对话镜像给房间，远端 turn 请求经审批闸门受控进入。
        公网 relay 中转 · 10 分钟窗口 30 turn 预算（按发起方向计） · nonce 幂等（重试零双发） ·
        断连指数退避重连。relay 是自托管软件——Tailscale/自组网内自建优先（官方不运营服务）。
      </div>
    </div>

    <div class="rooms">
      <!-- 未接入：空态卡（如实——不是假房间） -->
      <div v-if="!kernel.relay?.enabled && !kernel.relay?.connected" class="roomcard room-empty">
        <div class="room-head"><span class="room-name">未接入房间</span></div>
        <div class="room-sub">在「房间设置」填入 host 地址与邀请凭据（好友分享的房间码 + invite 码），保存并重启即接入。</div>
        <div class="room-actions">
          <button class="btn btn-secondary" @click="configOpen = true">房间设置</button>
        </div>
      </div>

      <!-- 房间卡：全部真值投影 -->
      <div v-else class="roomcard">
        <div class="room-head">
          <span class="room-name">{{ roomLabel || '房间' }}</span>
          <span class="chip" :class="stateChip.kind === 'accent' ? 'chip-accent' : stateChip.kind === 'info' ? 'chip-info' : ''">
            {{ stateChip.text }}
          </span>
        </div>
        <div class="room-sub">
          本端「{{ kernel.relay?.displayName || 'OpenBot 用户' }}」 · {{ kernel.remoteMembers.length }} 名远端成员 ·
          本端 agent 在本机执行，远端成员以 mirror 身份参与
        </div>

        <!-- 成员链（原型 member-row/mchip）：本端主人 + 远端成员（在场/离场如实） -->
        <div class="member-row">
          <span class="mchip"><span class="mdot mdot-self"></span>你<span class="mrole">主人</span></span>
          <span v-for="m in kernel.remoteMembers" :key="m.memberId" class="mchip" :class="{ 'is-off': !m.connected }">
            <span class="mdot mdot-remote"></span>{{ m.displayName }}<span class="mrole">{{ m.connected ? '远端 · mirror' : '离场' }}</span>
          </span>
          <span v-if="kernel.remoteMembers.length === 0" class="room-sub">尚无远端成员——把邀请信息发给好友</span>
        </div>

        <!-- relay 事实 kv（演示值纪律：预算余量是发起端视角本端不可见，如实不画 kv 与 meter） -->
        <div class="relay-grid">
          <div class="relay-kv"><span class="k">relay 状态</span><span class="v" :class="kernel.relay?.connected ? 'v-ok' : ''">{{ stateChip.text }}</span></div>
          <div class="relay-kv"><span class="k">远端成员</span><span class="v">{{ kernel.remoteMembers.length }} 名</span></div>
          <div class="relay-kv"><span class="k">本端呈现名</span><span class="v">{{ kernel.relay?.displayName || '—' }}</span></div>
          <div class="relay-kv"><span class="k">协议预算</span><span class="v">10 分钟窗口 30 turn · 按发起方向计</span></div>
        </div>

        <div class="room-actions">
          <button class="btn btn-secondary" @click="copyInvite">复制邀请信息</button>
          <button class="btn btn-ghost" @click="openRoomChat">打开房间对话</button>
          <button class="btn btn-ghost" style="margin-left: auto" @click="configOpen = true">房间设置</button>
        </div>
      </div>
    </div>

    <!-- 配置模态（SettingsView 模型表单容器同款） -->
    <div v-if="configOpen" class="wiz-overlay" @mousedown.self="configOpen = false">
      <div class="wiz-card" role="dialog" aria-label="房间接入配置" @keydown.escape="configOpen = false">
        <div class="wiz-head">
          <span class="wiz-title">房间接入配置</span>
          <button class="wiz-close" type="button" aria-label="关闭" @click="configOpen = false">✕</button>
        </div>
        <div class="wiz-body relay-form">
          <label class="relay-field">
            <span class="field-label">Host 地址（ws://…）</span>
            <input v-model="form.url" class="field-input mono" placeholder="ws://100.x.y.z:8080" autocomplete="off" spellcheck="false" />
          </label>
          <label class="relay-field">
            <span class="field-label">房间码</span>
            <input v-model="form.roomId" class="field-input mono" autocomplete="off" spellcheck="false" />
          </label>
          <label class="relay-field">
            <span class="field-label">Invite 码（凭据——不外传）</span>
            <input v-model="form.inviteCode" class="field-input mono" type="password" autocomplete="off" spellcheck="false" />
          </label>
          <label class="relay-field">
            <span class="field-label">本端呈现名</span>
            <input v-model="form.displayName" class="field-input" placeholder="例：BoneSue" autocomplete="off" maxlength="32" />
          </label>
          <label class="relay-field">
            <span class="field-label">房间备注名（可选——显示在房间卡）</span>
            <input v-model="form.roomName" class="field-input" placeholder="例：OpenBot 互助会" autocomplete="off" maxlength="32" />
          </label>
          <label class="relay-toggle">
            <input type="checkbox" v-model="form.enabled" />
            <span>启用房间连接（保存并重启后生效——连接是装配期决策）</span>
          </label>
          <p v-if="formError" class="form-error">{{ formError }}</p>
        </div>
        <div class="wiz-foot">
          <button class="btn btn-primary" :disabled="!formDirty || saving" @click="save">{{ saving ? '保存中…' : '保存（重启生效）' }}</button>
          <button class="btn btn-ghost" @click="configOpen = false">取消</button>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped src="./rooms.css"></style>
