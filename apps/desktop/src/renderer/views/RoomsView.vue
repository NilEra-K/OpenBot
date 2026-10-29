<script setup lang="ts">
/**
 * 跨用户房间视图（P7 多房间轮 · prototype.html 视图 5 多卡形态）：每房一张卡（各自连接态/
 * 成员链/事实 kv）+ 接入配置模态（列表：添加/编辑/删除——settings 全量写入，重启生效）。
 * 演示值纪律：预算余量 host 只下发发起端（本端 mirror 执行端不可见），kv 与 meter 不画编造值；
 * 呈现的全部是装配与事件事实。「我托管 / 我是访客」双视角为一期后域（无建房 UI 与被托管语义）。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { useKernelStore } from '../stores/kernel'
import type { RelayRoomStatus } from '../stores/kernel'
import { useUiStore } from '../stores/ui'
import { useToastStore } from '../stores/toast'

const kernel = useKernelStore()
const ui = useUiStore()
const toast = useToastStore()

/** 地球图标（prototype ICONS.rooms 同源——rail/名册/图谱共用语言） */
const ROOMS_ICON = '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>'

/** 房间显示名：备注名缺省回退房间码 */
const roomLabel = (r: RelayRoomStatus): string => r.roomName?.trim() || r.roomId

/** 连接态 chip（事实优先——env 通道接入时 settings.enabled 可能为 false） */
const stateChip = (r: RelayRoomStatus): { text: string; kind: 'accent' | 'info' | 'plain' } => {
  if (r.connected) return { text: '已连接', kind: 'accent' }
  if (r.enabled) return { text: '连接中 · 退避重试', kind: 'info' }
  return { text: '未启用', kind: 'plain' }
}

/** 该房的远端成员表（事件投影——房间成员快照按 roomId 分组） */
const membersOf = (roomId: string): Array<{ memberId: string; displayName: string; connected: boolean }> =>
  kernel.remoteRooms.find((r) => r.roomId === roomId)?.members ?? []

// ---- 接入配置模态：列表（增删改入口）⇄ 表单（单份编辑/新增）----
const modalOpen = ref(false)
/** 表单态：null=列表态；number=编辑第 i 份；'new'=新增 */
const editing = ref<null | number | 'new'>(null)
const formError = ref<string | null>(null)
const saving = ref(false)
const form = reactive({ enabled: true, url: '', roomId: '', inviteCode: '', displayName: '', roomName: '' })
/** 打开表单（编辑预填 / 新增清空） */
const openForm = (index: number | 'new'): void => {
  editing.value = index
  formError.value = null
  if (index === 'new') {
    form.enabled = true
    form.url = ''
    form.roomId = ''
    form.inviteCode = ''
    form.displayName = ''
    form.roomName = ''
  } else {
    const r = kernel.relays[index]
    if (r !== undefined) {
      form.enabled = r.enabled
      form.url = r.url
      form.roomId = r.roomId
      form.inviteCode = r.inviteCode
      form.displayName = r.displayName
      form.roomName = r.roomName ?? ''
    }
  }
}

const formValid = computed(
  () => form.url.trim() !== '' && form.roomId.trim() !== '' && form.inviteCode.trim() !== '',
)

/** 保存：编辑替换 / 新增追加 → settings 全量写入（重启生效——装配期决策） */
const save = async (): Promise<void> => {
  if (!formValid.value) {
    formError.value = '中继地址、房间码、邀请码为必填'
    return
  }
  saving.value = true
  formError.value = null
  try {
    const entry = {
      enabled: form.enabled,
      url: form.url.trim(),
      roomId: form.roomId.trim(),
      inviteCode: form.inviteCode.trim(),
      displayName: form.displayName.trim(),
      ...(form.roomName.trim() !== '' ? { roomName: form.roomName.trim() } : {}),
    }
    const next = kernel.relays.map((r) => ({ ...r }))
    if (editing.value === 'new') {
      if (next.some((r) => r.roomId === entry.roomId)) {
        formError.value = `房间 ${entry.roomId} 已配置——不重复接入`
        return
      }
      next.push(entry)
    } else if (typeof editing.value === 'number') {
      next[editing.value] = entry
    }
    await kernel.setRelays(next.map(({ connected: _c, ...rest }) => rest))
    toast.push('房间配置已保存——重启应用后生效', 'success')
    editing.value = null
  } catch (err) {
    formError.value = err instanceof Error ? err.message : String(err)
  } finally {
    saving.value = false
  }
}

/** 删除一份接入配置（直接删+toast——settings 全量写入） */
const remove = async (index: number): Promise<void> => {
  const next = kernel.relays.filter((_, i) => i !== index)
  await kernel.setRelays(next.map(({ connected: _c, ...rest }) => rest))
  toast.push('已移除该房间配置——重启应用后断开', 'success')
}

/** 复制邀请信息（房间码 + invite 码——凭据经用户手分享，不经内核外发） */
const copyInvite = async (r: RelayRoomStatus): Promise<void> => {
  const text = `OpenBot 房间邀请\n房间码：${r.roomId}\n邀请码：${r.inviteCode}\n中继地址：${r.url}`
  try {
    await navigator.clipboard.writeText(text)
    toast.push('邀请信息已复制——发给好友在其 OpenBot「跨用户房间」配置接入', 'success')
  } catch {
    toast.push('复制失败（剪贴板不可用）——邀请信息见「房间设置」', 'danger')
  }
}

/** 打开房间对话：该房首个远端成员会话（无人则管家会话） */
const openRoomChat = (r: RelayRoomStatus): void => {
  const peer = membersOf(r.roomId)[0]
  ui.openAgent(peer !== undefined ? `remote:${r.roomId}:${peer.memberId}` : (kernel.stewardId ?? ''))
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
      <div class="view-sub">好友跨公网进房间协作——本端对话镜像给房间，远端对话请求经审批闸门受控进入。</div>
    </div>

    <div class="rooms">
      <!-- 未接入：居中空态（icon → 标题 → 一句话 → 主按钮 → 三步引导）——不造假数据 -->
      <div v-if="kernel.relays.length === 0" class="rooms-empty">
        <div class="empty-icon" aria-hidden="true">
          <svg width="52" height="52" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" v-html="ROOMS_ICON"></svg>
        </div>
        <div class="empty-title">未接入房间</div>
        <p class="empty-desc">接入后：本端对话镜像给房间成员，远端的对话请求经审批后在本端执行。</p>
        <button class="btn btn-primary empty-cta" @click="modalOpen = true; openForm('new')">添加房间</button>
        <div class="empty-steps">
          <div class="step"><span class="step-no">1</span>好友运行中继服务并创建房间</div>
          <div class="step"><span class="step-no">2</span>把房间码与邀请码分享给你</div>
          <div class="step"><span class="step-no">3</span>在「添加房间」填入并重启应用</div>
        </div>
      </div>

      <!-- 房间卡：每房一张（原型多卡形态）——全部真值投影 -->
      <div v-for="(r, i) in kernel.relays" :key="r.roomId" class="roomcard">
        <div class="room-head">
          <span class="room-ico" aria-hidden="true">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" v-html="ROOMS_ICON"></svg>
          </span>
          <span class="room-name">{{ roomLabel(r) }}</span>
          <span class="chip" :class="stateChip(r).kind === 'accent' ? 'chip-accent' : stateChip(r).kind === 'info' ? 'chip-info' : ''">
            {{ stateChip(r).text }}
          </span>
        </div>
        <div class="room-sub">
          本端「{{ r.displayName || 'OpenBot 用户' }}」 · {{ membersOf(r.roomId).length }} 名远端成员 ·
          远端成员以镜像身份参与
        </div>

        <!-- 成员链（原型 member-row/mchip）：本端主人 + 远端成员（在场/离场如实） -->
        <div class="member-row">
          <span class="mchip"><span class="mdot mdot-self"></span>你<span class="mrole">主人</span></span>
          <span v-for="m in membersOf(r.roomId)" :key="m.memberId" class="mchip" :class="{ 'is-off': !m.connected }">
            <span class="mdot mdot-remote"></span>{{ m.displayName }}<span class="mrole">{{ m.connected ? '远端 · 镜像' : '离场' }}</span>
          </span>
        </div>
        <p v-if="membersOf(r.roomId).length === 0" class="member-empty">尚无远端成员——点「复制邀请信息」分享给好友</p>

        <!-- relay 事实 kv（演示值纪律：预算余量是发起端视角本端不可见，如实不画 kv 与 meter） -->
        <div class="relay-grid">
          <div class="relay-kv"><span class="k">中继状态</span><span class="v" :class="r.connected ? 'v-ok' : ''">{{ stateChip(r).text }}</span></div>
          <div class="relay-kv"><span class="k">远端成员</span><span class="v">{{ membersOf(r.roomId).length }} 名</span></div>
          <div class="relay-kv"><span class="k">本端呈现名</span><span class="v">{{ r.displayName || '—' }}</span></div>
          <div class="relay-kv"><span class="k">协议预算</span><span class="v">10 分钟窗口 · 30 回合</span></div>
        </div>

        <div class="room-actions">
          <button class="btn btn-secondary" @click="copyInvite(r)">复制邀请信息</button>
          <button class="btn btn-ghost" @click="openRoomChat(r)">打开房间对话</button>
          <button class="btn btn-ghost" style="margin-left: auto" @click="modalOpen = true; openForm(i)">房间设置</button>
        </div>
      </div>

      <!-- 已有卡时的追加入口 -->
      <button v-if="kernel.relays.length > 0" class="rooms-add" type="button" @click="modalOpen = true; openForm('new')">＋ 添加房间</button>

      <!-- 自托管叙事注脚（恒在——本地优先纪律的呈现面） -->
      <p class="rooms-note">中继服务为自托管软件，官方不运营服务——优先跑在 Tailscale / 自组网内；公网暴露请自配 TLS 反代。</p>
    </div>

    <!-- 配置模态：列表（增删改）⇄ 表单（单份） -->
    <div v-if="modalOpen" class="wiz-overlay" @mousedown.self="modalOpen = false; editing = null">
      <div class="wiz-card" role="dialog" aria-label="房间接入配置" @keydown.escape="editing === null ? (modalOpen = false) : (editing = null)">
        <div class="wiz-head">
          <span class="wiz-title">{{ editing === null ? '房间接入' : editing === 'new' ? '添加房间' : '编辑房间' }}</span>
          <button class="wiz-close" type="button" aria-label="关闭" @click="modalOpen = false; editing = null">✕</button>
        </div>

        <!-- 列表态：已配置房间 + 添加入口 -->
        <div v-if="editing === null" class="wiz-body">
          <p v-if="kernel.relays.length === 0" class="rooms-list-empty">尚无接入配置——点下方添加。</p>
          <div v-for="(r, i) in kernel.relays" :key="r.roomId" class="rooms-row">
            <span class="rooms-row-dot" :class="r.connected ? 'ok' : ''"></span>
            <span class="rooms-row-name">{{ roomLabel(r) }}</span>
            <span class="rooms-row-sub mono">{{ r.roomId }}</span>
            <button class="btn btn-ghost btn-sm" @click="openForm(i)">编辑</button>
            <button class="btn btn-ghost btn-sm btn-danger" @click="remove(i)">删除</button>
          </div>
          <div class="wiz-foot-flat">
            <button class="btn btn-primary" @click="openForm('new')">＋ 添加房间</button>
          </div>
        </div>

        <!-- 表单态：单份配置（新增/编辑共用） -->
        <div v-else class="wiz-body relay-form">
          <label class="relay-field">
            <span class="field-label">中继地址（ws://…）</span>
            <input v-model="form.url" class="field-input mono" placeholder="ws://100.x.y.z:8080" autocomplete="off" spellcheck="false" />
          </label>
          <label class="relay-field">
            <span class="field-label">房间码</span>
            <input v-model="form.roomId" class="field-input mono" autocomplete="off" spellcheck="false" />
          </label>
          <label class="relay-field">
            <span class="field-label">邀请码（凭据——不外传）</span>
            <input v-model="form.inviteCode" class="field-input mono" type="password" autocomplete="off" spellcheck="false" />
          </label>
          <label class="relay-field">
            <span class="field-label">本端呈现名（可按房不同）</span>
            <input v-model="form.displayName" class="field-input" placeholder="例：BoneSue" autocomplete="off" maxlength="32" />
          </label>
          <label class="relay-field">
            <span class="field-label">房间备注名（可选——显示在房间卡）</span>
            <input v-model="form.roomName" class="field-input" placeholder="例：OpenBot 互助会" autocomplete="off" maxlength="32" />
          </label>
          <label class="relay-toggle">
            <input type="checkbox" v-model="form.enabled" />
            <span>启用该房间连接（保存并重启后生效——连接是装配期决策）</span>
          </label>
          <p v-if="formError" class="form-error">{{ formError }}</p>
        </div>

        <div class="wiz-foot">
          <template v-if="editing !== null">
            <button class="btn btn-primary" :disabled="!formValid || saving" @click="save">{{ saving ? '保存中…' : '保存（重启生效）' }}</button>
            <button class="btn btn-ghost" @click="editing = null">返回列表</button>
          </template>
          <template v-else>
            <button class="btn btn-ghost" style="margin-left: auto" @click="modalOpen = false">关闭</button>
          </template>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped src="./rooms.css"></style>
